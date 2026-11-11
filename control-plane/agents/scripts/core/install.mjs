// @ts-check
// `proofline init` and `proofline upgrade` in Node (D8, A233; the former bin/lib/install.sh): install the control plane into a project, merge (never overwrite) what the
// project already has, and remember what was installed (.agents/.proofline-manifest: sha256 + path of every installed file) so that upgrade can tell unmodified files
// from user edits. Text is a byte string (one char per byte) like the config reader's; `u()` turns a path or other JS string into one for a message.
//
// What it writes is the whole control plane of a project and the hook wiring of the runtimes, so every write goes through `writeSafe`: a destination that is, or sits
// under, a symbolic link is never written (a cloned repository could point `.agents/scripts/agent.sh` or `.claude/settings.json` anywhere), and a path the old manifest
// names is acted on only when it is a plain relative path inside the project (a hostile manifest cannot delete a file elsewhere). The installer is a front end of
// bin/proofline: nothing here is a command of agent.sh or of the `cli` family.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Config, bytes } from './config.mjs';
import { cfgMergeNew } from './cfgcli.mjs';
import { cfgCmds, cfgSet } from './configset.mjs';
import { CliDie } from './cliio.mjs';
import { KINDS, ambigNotes, discoverCommands, joinCommands, verifyCommands } from './discover.mjs';
import { codeAudit, problemText, shaTolerant } from './codetrust.mjs';
import { MANIFEST_REL, globalHookspathMessage, hooksPathState, matcherCovers } from './doctor.mjs';
import { sha256, sha256File } from './hash.mjs';
import * as proc from './proc.mjs';
import { commandV } from './runtimedetect.mjs';
import { applyHookTimeouts } from './scale.mjs';

/** A JS string (a path, a version) as a byte string. @param {string} s */
export const u = (s) => bytes(s);

const BEGIN = '<!-- proofline:begin -->';
const END = '<!-- proofline:end -->';
/** @param {string} a @param {string} b */
const byteCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @typedef {object} Ui
 * @property {(line: string) => void} say a line on standard output
 * @property {(line: string) => void} warn `proofline: LINE` on standard error
 * @property {boolean} interactive ask the questions on the terminal
 * @property {(prompt: string, def: string) => string} ask
 */

/** Every regular file under DIR as [relative path with '/', absolute path]; symbolic links and .DS_Store are not files here. @param {string} dir @returns {Array<[string, string]>} */
function walk(dir) {
  /** @type {Array<[string, string]>} */ const out = [];
  /** @param {string} d @param {string} pre */
  const rec = (d, pre) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.DS_Store') continue;
      if (e.isDirectory()) rec(`${d}/${e.name}`, `${pre}${e.name}/`);
      else if (e.isFile()) out.push([`${pre}${e.name}`, `${d}/${e.name}`]);
    }
  };
  rec(dir, '');
  return out;
}

/** May REL be written under ROOT? No component of it, the last one included, is a symbolic link; a component that does not exist yet is fine. @param {string} root @param {string} rel */
export function pathSafe(root, rel) {
  let cur = root;
  for (const part of rel.split('/')) {
    cur = `${cur}/${part}`;
    let st;
    try { st = lstatSync(cur); } catch { return true; }
    if (st.isSymbolicLink()) return false;
  }
  return true;
}

/** A path a manifest may name: relative, no empty, `.` or `..` segment. @param {string} rel */
export function relOk(rel) {
  return rel !== '' && !rel.startsWith('/') && !rel.includes('\\') && !rel.includes('\0') && rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

/** The tail of a version compare: is A older than B (dotted numbers)? @param {string} a @param {string} b */
function olderThan(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d < 0; }
  return false;
}

/** @param {string} text a byte string @returns {string[]} its lines (a final newline ends the last line, it does not start one) */
function linesOf(text) {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/** The text of the old manifest: [hash, path] rows and the `# key: value` header. @param {string} file */
function readManifest(file) {
  /** @type {Array<[string, string]>} */ const rows = [];
  /** @type {Map<string, string>} */ const meta = new Map();
  let text = '';
  try { text = readFileSync(file, 'latin1'); } catch { return { exists: false, rows, meta }; }
  for (const l of linesOf(text)) {
    if (l.startsWith('#')) {
      const m = /^# ([^:]*): *(.*)$/.exec(l);
      if (m && !meta.has(m[1])) meta.set(m[1], m[2]);
      continue;
    }
    const m = /^(\S+)[ \t]+(.*)$/.exec(l);
    if (m) rows.push([m[1], m[2]]);
  }
  return { exists: true, rows, meta };
}

/** @param {string} dir */
function detectBranchIn(dir) {
  /** @param {string[]} a */
  const g = (a) => proc.run('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
  let r = g(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  let db = r.stdout.toString('latin1').replace(/\n+$/, '');
  if (r.status === 0 && db !== '') return db.replace(/^origin\//, '');
  for (const b of ['main', 'master', 'trunk', 'develop']) if (g(['show-ref', '--verify', '--quiet', `refs/heads/${b}`]).status === 0) return b;
  r = g(['symbolic-ref', '--short', '-q', 'HEAD']);
  db = r.stdout.toString('latin1').replace(/\n+$/, '');
  if (r.status === 0 && db !== '') return db;
  return 'main';
}

/** @typedef {{ root: string, plHome: string, version: string, env: NodeJS.ProcessEnv, mode: 'init' | 'upgrade', dry: boolean, profile: string, runtimes: string,
 *   opt: Record<string, string>, haveProtected: boolean, canon: string, protectedBranches: string, forbidden: string, lead: string, worker: string, reviewers: string,
 *   adapter: string, push: string, roles: string[], dBuild: string, dTest: string, dLint: string, ui: Ui }} Params */

const GITHOOKS_FIX = 'delete the file(s) that differ and run proofline init again (or run proofline upgrade) and commit the result';
/** R3: the file on disk is proofline's and only the index or HEAD holds older content (the state right after an upgrade): committing is the remedy, deleting the file is not. */
const GITHOOKS_COMMIT = "commit proofline's copy of the file(s) (git add .agents, then git commit)";
/** R2: CRLF line ends (core.autocrlf=true) are the cause; deleting does not help, the checkout has to stop converting. */
const GITHOOKS_EOL = 'the line endings are CRLF (usually core.autocrlf=true on Windows, which breaks shell scripts and hooks): run `git config core.autocrlf false` and check the file(s) out again (git checkout -- <file>), or `git add --renormalize .`';

class Install {
  /** @param {Params} p */
  constructor(p) {
    /** @type {Map<string, string>} the outcome of each code file placed (.agents/scripts, .agents/githooks, and '.agents/hooks' as a whole) (A249) */ this.codeActs = new Map();
    this.p = p;
    /** @type {string} the remedy for the problems githooksUntrusted found last */ this.fixText = GITHOOKS_FIX;
    this.root = p.root;
    /** @type {Array<[string, string]>} */ this.plan = [];
    /** @type {Array<[string, string]>} */ this.blocks = [];
    /** @type {Array<[string, string]>} */ this.manifestNew = [];
    this.manifestFile = `${p.root}/${MANIFEST_REL}`;
    this.old = readManifest(this.manifestFile);
    this.stage = '';
    this.rts = p.runtimes.split(' ').filter((x) => x !== '');
  }

  /** @param {string} act @param {string} text */
  plog(act, text) { this.plan.push([act, text]); }
  /** @param {string} rt */
  has(rt) { return this.rts.includes(rt); }
  /** @param {string} rel the path under the project, for the plan */
  unsafe(rel) { this.plog('warn', `${rel} is a symbolic link or sits under one; not written`); }

  /** Write BYTES to REL (a file or a buffer), creating its folder; false (and a warning) when the destination is, or sits under, a symbolic link. @param {string} rel @param {string | Buffer} data @param {number} [mode] */
  writeSafe(rel, data, mode) {
    if (!pathSafe(this.root, rel)) { this.unsafe(rel); return false; }
    const dst = `${this.root}/${rel}`;
    try {
      mkdirSync(path.dirname(dst), { recursive: true });
      writeFileSync(dst, typeof data === 'string' ? Buffer.from(data, 'latin1') : data, mode === undefined ? undefined : { mode });
    } catch (e) { this.plog('warn', `${rel} not written (${/** @type {Error} */ (e).message})`); return false; }
    return true;
  }

  /** @param {string} rel @param {string} src */
  copySafe(rel, src) {
    if (!pathSafe(this.root, rel)) { this.unsafe(rel); return false; }
    const dst = `${this.root}/${rel}`;
    try { mkdirSync(path.dirname(dst), { recursive: true }); copyFileSync(src, dst); } catch (e) { this.plog('warn', `${rel} not written (${/** @type {Error} */ (e).message})`); return false; }
    return true;
  }

  // --- staging: the exact tree this version wants installed -----------------------------------------------------------------
  /** @returns {Map<string, string>} the installed path -> the source file */
  stageBuild() {
    const { plHome } = this.p;
    /** @type {Map<string, string>} */ const files = new Map();
    for (const [rel, abs] of walk(`${plHome}/control-plane/agents`)) {
      if (rel === 'config.yaml' || rel === 'roles.conf' || rel.startsWith('roles/')) continue;
      files.set(`.agents/${rel}`, abs);
    }
    for (const e of readdirSync(`${plHome}/skills`, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(`${plHome}/skills/${e.name}/SKILL.md`)) continue;
      for (const [rel, abs] of walk(`${plHome}/skills/${e.name}`)) files.set(`.agents/skills/${e.name}/${rel}`, abs);
    }
    const gen = `${this.stage}/gen`;
    // the role generator (adapters/generate.mjs) renders the agent files of the chosen profile into the staging folder: one Node process
    const g = proc.run(process.execPath, [`${plHome}/adapters/generate.mjs`, '--profile', this.p.profile, '--out', gen, '--root', plHome], { env: this.p.env, stdio: ['ignore', 'ignore', 'ignore'] });
    if (g.status !== 0) throw new CliDie('role generation failed');
    for (const [rel, abs] of walk(`${gen}/.agents`)) files.set(`.agents/${rel}`, abs);
    if (this.has('claude')) {
      for (const [rel, abs] of walk(`${gen}/.claude/agents`)) files.set(`.claude/agents/${rel}`, abs);
      for (const [rel, abs] of walk(`${plHome}/skills/proofline`)) files.set(`.claude/skills/proofline/${rel}`, abs);
    }
    if (this.has('codex')) for (const [rel, abs] of walk(`${gen}/.codex/agents`)) files.set(`.codex/agents/${rel}`, abs);
    return files;
  }

  /**
   * Install one staged file. Three-way rule against the manifest: absent -> new; identical -> same; installed == manifest (unmodified) -> update; anything else is the
   * user's -> kept (init) or conflict with a .proofline-new copy (upgrade).
   * @param {string} rel @param {string} src
   */
  place(rel, src) {
    const dst = `${this.root}/${rel}`;
    const n = sha256File(src);
    let act; let keep = '';
    // a Windows checkout with core.autocrlf=true holds JS, JSON and Markdown with CRLF: that is the same file (Node and JSON read it alike); shell scripts and hooks are compared exactly
    const m = this.old.rows.find((r) => r[1] === rel)?.[0] ?? '';
    if (!existsSync(dst)) act = 'new';
    else {
      const d = shaTolerant(dst, rel);
      if (d === n) act = 'same';
      else if (m !== '' && d === m) act = 'update';
      else if (m !== '' && m === n) { act = 'mine'; keep = m; } // you edited it, upstream did not change
      else if (this.p.mode === 'upgrade') { act = 'conflict'; keep = m; } else { act = 'keep'; keep = m; }
    }
    let wrote = true;
    if (act === 'new' || act === 'update') {
      if (!this.p.dry) {
        wrote = this.copySafe(rel, src);
        if (wrote) {
          let exec = (statSync(src).mode & 0o111) !== 0;
          if (/^\.agents\/(scripts\/[^/]*\.sh|githooks\/.*|hooks\/[^/]*\.sh|task-integrations\/[^/]*\.sh)$/.test(rel)) exec = true;
          if (exec) { const um = process.umask(); chmodSync(dst, (statSync(dst).mode & 0o7777) | (0o111 & ~um)); }
        }
      } else if (!pathSafe(this.root, rel)) { this.unsafe(rel); wrote = false; }
    } else if (act === 'conflict') {
      if (!this.p.dry) this.copySafe(`${rel}.proofline-new`, src);
    }
    if (rel.startsWith('.agents/githooks/') || rel.startsWith('.agents/scripts/')) this.codeActs.set(rel, wrote ? act : 'unsafe');
    if (!wrote) return; // already reported: not in the plan as new, not in the manifest
    if (act === 'new' || act === 'update' || act === 'same') this.manifestNew.push([n, rel]);
    else if (keep !== '') this.manifestNew.push([keep, rel]);
    this.plog(act, rel);
  }

  /** @param {Map<string, string>} files */
  placeAll(files) {
    const list = [...files.keys()].sort(byteCmp);
    for (const rel of list) this.place(rel, /** @type {string} */ (files.get(rel)));
    // files an older version installed that this version no longer ships
    if (this.p.mode === 'upgrade' && this.old.exists) {
      const staged = new Set(list);
      for (const [hash, rel] of this.old.rows) {
        if (staged.has(rel)) continue;
        if (!relOk(rel) || !pathSafe(this.root, rel)) { this.plog('warn', `${u(rel)} (named by the manifest) is not a plain path inside the project; not touched`); continue; }
        const f = `${this.root}/${rel}`;
        if (!existsSync(f)) continue;
        if (sha256File(f) === hash) {
          if (!this.p.dry) rmSync(f, { force: true });
          this.plog('removed', rel);
        } else { this.plog('orphan', `${rel} (modified, no longer shipped; kept)`); this.manifestNew.push([hash, rel]); }
      }
    }
  }

  /**
   * The Node hook tree (.agents/hooks/proofline-hook.mjs, command-scan.mjs, events/, guards/, lib/). It is the code the wiring strings start, so it is written as a whole, not file
   * by file against the manifest: a file the user edited is replaced (hook code is not configuration), a file an older release no longer ships is dropped, and the files are NOT
   * listed in the manifest. That last point is the rollback: the previous release's `upgrade` removes the files its manifest lists and this version no longer ships; the Node
   * hook must survive it, because it is the process that yields to the old shell wiring the old installer adds beside the new string (ADR 0001 sections 5.4 and 9).
   */
  nodeHookInstall() {
    const src = `${this.p.plHome}/adapters/claude/hooks`;
    /** @type {Array<[string, string]>} */ const tree = [];
    for (const f of ['proofline-hook.mjs', 'command-scan.mjs']) tree.push([f, `${src}/${f}`]);
    for (const d of ['events', 'guards', 'lib']) for (const [rel, abs] of walk(`${src}/${d}`)) tree.push([`${d}/${rel}`, abs]);
    const dir = '.agents/hooks';
    let act = 'new';
    if (existsSync(`${this.root}/${dir}/proofline-hook.mjs`)) {
      act = 'same';
      for (const [rel, abs] of tree) {
        let have = null;
        try { have = readFileSync(`${this.root}/${dir}/${rel}`); } catch { have = null; }
        if (have === null || !have.equals(readFileSync(abs))) act = 'update';
      }
    }
    this.codeActs.set(dir, act);
    if (!this.p.dry && act !== 'same') {
      if (!pathSafe(this.root, dir)) { this.codeActs.set(dir, 'unsafe'); this.unsafe(dir); return; }
      mkdirSync(`${this.root}/${dir}`, { recursive: true });
      for (const d of ['events', 'guards', 'lib']) rmSync(`${this.root}/${dir}/${d}`, { recursive: true, force: true });
      for (const [rel, abs] of tree) if (!this.copySafe(`${dir}/${rel}`, abs)) return;
    }
    this.plog(act, `${dir}/proofline-hook.mjs`);
  }

  // --- merges ---------------------------------------------------------------------------------------------------------
  /**
   * The fragment's hook groups missing from the current settings (a group is present when one of its commands is). 'same' unchanged, 'changed' (text), 'error'.
   * @param {string} curFile @param {string} fragFile @returns {{ state: 'same' | 'changed' | 'error', text: string, narrowed: string[] }}
   */
  hooksMerge(curFile, fragFile) {
    /** @type {any} */ let c; /** @type {any} */ let f;
    try { c = JSON.parse(readFileSync(curFile, 'utf8')); f = JSON.parse(readFileSync(fragFile, 'utf8')); } catch { return { state: 'error', text: '', narrowed: [] }; }
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return { state: 'error', text: '', narrowed: [] };
    const before = JSON.stringify(c);
    const hooks = c.hooks && typeof c.hooks === 'object' ? c.hooks : {};
    /** @type {string[]} */ const narrowed = [];
    for (const [ev, groups] of Object.entries(f.hooks || {})) {
      const have = Array.isArray(hooks[ev]) ? hooks[ev] : [];
      for (const g of /** @type {any[]} */ (groups)) {
        const cmds = (g.hooks || []).map((/** @type {any} */ h) => h.command);
        // A238: a group that names the command counts as the shipped one only when its matcher is not narrower; otherwise the shipped group is added beside it
        const named = have.filter((/** @type {any} */ x) => Array.isArray(x?.hooks) && x.hooks.some((/** @type {any} */ h) => cmds.includes(h?.command)));
        if (named.some((/** @type {any} */ x) => matcherCovers(x.matcher, g.matcher, ev))) continue;
        if (named.length > 0) narrowed.push(ev);
        have.push(g);
      }
      hooks[ev] = have;
    }
    c.hooks = hooks;
    if (JSON.stringify(c) === before) return { state: 'same', text: '', narrowed: [] };
    return { state: 'changed', text: `${JSON.stringify(c, null, 2)}\n`, narrowed };
  }

  /** @param {string} rel @param {string} src */
  jsonMerge(rel, src) {
    const dst = `${this.root}/${rel}`;
    if (!existsSync(dst)) {
      if (this.p.dry) { if (!pathSafe(this.root, rel)) return this.unsafe(rel); } else if (!this.copySafe(rel, src)) return;
      this.plog('merged', `${rel} (created)`);
      return;
    }
    const r = this.hooksMerge(dst, src);
    if (r.state === 'same') this.plog('same', rel);
    else if (r.state === 'changed') {
      if (!this.p.dry && !this.writeSafe(rel, Buffer.from(r.text, 'utf8'))) return;
      if (this.p.dry && !pathSafe(this.root, rel)) return this.unsafe(rel);
      this.plog('merged', `${rel} (proofline hooks added, existing keys kept${r.narrowed.length > 0 ? `; the group for ${[...new Set(r.narrowed)].join(' ')} has a narrower matcher than proofline's, so proofline's group was added beside it` : ''})`);
    } else this.plog('warn', `${rel} not merged (invalid JSON); add the hooks from ${src.slice(this.p.plHome.length + 1)} by hand`);
  }

  /** Set the `timeout` of every proofline hook in REL from the project's config (A202 item 29; the work is core/scale.mjs). @param {string} rel */
  hookTimeoutsApply(rel) {
    if (!existsSync(`${this.root}/${rel}`)) return;
    if (this.p.dry) { this.plog('same', `${rel} (hook timeouts are set from the config when it is written)`); return; }
    if (!existsSync(`${this.root}/.agents/scripts/agent.sh`)) return;
    if (!pathSafe(this.root, rel)) return this.unsafe(rel);
    let r;
    try { r = applyHookTimeouts(this.root, rel); } catch { this.plog('warn', `${rel}: hook timeouts not set (the settings file could not be updated)`); return; }
    if (r.state !== 'absent') this.plog(r.state, r.text);
  }

  /**
   * A marked block inside a user-owned markdown file. The sha256 of the block as installed is kept in the manifest header (`# block-REL:`); a block whose current hash differs
   * from it was edited by the user: it is kept, the merged result is written beside it as REL.proofline-new, and a conflict is reported.
   * @param {string} rel @param {string} srcFile
   */
  mergeBlock(rel, srcFile) {
    const dst = `${this.root}/${rel}`;
    const blk = `${BEGIN}\n${readFileSync(srcFile, 'latin1')}${END}\n`;
    const hash = sha256(blk);
    let rec = hash; let conf = false;
    const oldHash = this.old.meta.get(`block-${rel}`) ?? '';
    const cur = existsSync(dst) ? readFileSync(dst, 'latin1') : null;
    let neu; let act;
    if (cur === null) { neu = blk; act = 'created'; } else if (linesOf(cur).includes(BEGIN)) {
      if (!linesOf(cur).includes(END)) {
        this.plog('warn', `${rel} has a proofline:begin marker without an end marker; not touched`);
        if (oldHash !== '') this.blocks.push([`block-${rel}`, oldHash]);
        return;
      }
      let inside = false; let skip = false; let have = ''; neu = '';
      const blkLines = linesOf(blk);
      for (const l of linesOf(cur)) {
        if (l === BEGIN) inside = true;
        if (inside) have += `${l}\n`;
        if (l === END) inside = false;
        if (l === BEGIN) { for (const b of blkLines) neu += `${b}\n`; skip = true; continue; }
        if (l === END) { skip = false; continue; }
        if (!skip) neu += `${l}\n`;
      }
      act = 'block updated';
      const h = sha256(have);
      if (h !== hash && h !== oldHash) { conf = true; rec = oldHash; }
    } else { neu = `${cur}\n${blk}`; act = 'block appended, your content kept'; }
    if (rec !== '') this.blocks.push([`block-${rel}`, rec]);
    if (conf) {
      this.plog('conflict', rel);
      if (!this.p.dry) this.writeSafe(`${rel}.proofline-new`, neu);
      return;
    }
    if (cur !== null && cur === neu) { this.plog('same', rel); return; }
    if (this.p.dry) { if (!pathSafe(this.root, rel)) return this.unsafe(rel); } else if (!this.writeSafe(rel, neu)) return;
    this.plog('merged', `${rel} (${act})`);
  }

  /** @param {string} rel @param {string} line */
  ensureLine(rel, line) {
    const f = `${this.root}/${rel}`;
    let cur = '';
    try { cur = readFileSync(f, 'latin1'); } catch { cur = ''; }
    if (linesOf(cur).includes(line)) return;
    if (this.p.dry) { if (!pathSafe(this.root, rel)) return this.unsafe(rel); } else {
      const sep = cur !== '' && !cur.endsWith('\n') ? '\n' : '';
      if (!this.writeSafe(rel, `${cur}${sep}${line}\n`)) return;
    }
    this.plog('merged', `${rel} (+ ${line})`);
  }

  /** @param {string} file @param {string} key @param {string} value set only when the current value differs */
  cfgSetIf(file, key, value) {
    if (Config.load(file).get(key, '') === value) return;
    let ok = false;
    try { ok = cfgSet(file, key, value); } catch { ok = false; }
    if (!ok) this.p.ui.warn(`config key not set: ${key}`);
  }

  doConfig() {
    const { p } = this;
    const cur = `${this.root}/.agents/config.yaml`;
    const def = `${p.plHome}/control-plane/agents/config.yaml`;
    const w = `${this.stage}/config.yaml`;
    const exists = existsSync(cur);
    const curText = exists ? readFileSync(cur, 'latin1') : '';
    writeFileSync(w, exists ? curText : readFileSync(def, 'latin1'), 'latin1');
    if (p.mode === 'upgrade') {
      writeFileSync(w, cfgMergeNew(curText, readFileSync(def, 'latin1')), 'latin1');
      // A202 item 29: the shipped time limits grew (measured durations plus a wide margin, docs/concepts/timeouts.md). From a project older than 0.0.39 a
      // limit that still holds the earlier shipped value moves to the new one; a value you changed is never touched, and so is none of the other keys.
      const oldV = Config.load(cur).get('proofline_version', '0.0.0');
      if (oldV !== '0.0.39' && olderThan(oldV, '0.0.39')) {
        for (const m of ['dispatch.timeout_seconds:1800:5400', 'pipelines.TRIVIAL.dispatch_timeout_seconds:900:1800', 'pipelines.STANDARD.dispatch_timeout_seconds:1800:5400', 'pipelines.COMPLEX.dispatch_timeout_seconds:3600:7200', 'pipelines.CRITICAL.dispatch_timeout_seconds:3600:7200']) {
          const [k, from, to] = m.split(':');
          if (Config.load(w).get(k, '') === from) { try { cfgSet(w, k, to); } catch { /* the key stays */ } }
        }
      }
    }
    this.cfgSetIf(w, 'proofline_version', u(p.version));
    if (p.mode === 'init') {
      // a new config takes every resolved value; an existing one only what was passed explicitly
      const all = !exists;
      const o = p.opt;
      if (!all) this.cfgSetIf(w, 'canonical_branch', u(p.canon));
      if (all || o.profile) this.cfgSetIf(w, 'profile', p.profile);
      if (all || o.lead) this.cfgSetIf(w, 'runtime.lead', p.lead);
      if (all || o.worker) this.cfgSetIf(w, 'runtime.worker', p.worker);
      if (all || o.reviewers) this.cfgSetIf(w, 'runtime.reviewers', p.reviewers);
      if (all || o.adapter) this.cfgSetIf(w, 'tasks.adapter', p.adapter);
      if (all || p.haveProtected) this.cfgSetIf(w, 'git.protected_branches', p.protectedBranches);
      if (all || o.push) this.cfgSetIf(w, 'git.push_requires_approval', p.push);
      if (all || o.forbidden) this.cfgSetIf(w, 'git.forbidden_identities', p.forbidden);
      for (const r of p.roles) { // a role override is always explicit; the parent key is added when an older config lacks it
        const line = Config.load(w).lines.find((l) => l.startsWith('runtime.roles='));
        if (line !== undefined) {
          const parent = line.slice('runtime.roles='.length);
          if (parent === '{}') cfgSet(w, 'runtime.roles', '');  // a hand-edited empty map becomes a parent line
          else if (parent !== '') throw new CliDie(`runtime.roles in .agents/config.yaml has an inline value (${parent}); write the roles as indented lines and run init again`);
        } else cfgSet(w, 'runtime.roles', '');
        this.cfgSetIf(w, `runtime.roles.${r.slice(0, r.indexOf('='))}`, r.slice(r.indexOf('=') + 1));
      }
      for (const [k, v] of /** @type {const} */ ([['build', p.dBuild], ['test', p.dTest], ['lint', p.dLint]])) {
        // one command per line; several lines are written as a block list (A173). A configured command (a value or a list) is never replaced.
        if (v !== '' && cfgCmds(w, `commands.${k}`).length === 0) {
          let ok = false;
          try { ok = cfgSet(w, `commands.${k}`, v); } catch { ok = false; }
          if (!ok) p.ui.warn(`config key not set: commands.${k}`);
        }
      }
    }
    const neu = readFileSync(w, 'latin1');
    if (!exists) this.plog('merged', '.agents/config.yaml (created from the discovered project settings)');
    else if (neu === curText) this.plog('same', '.agents/config.yaml');
    else this.plog('merged', '.agents/config.yaml (keys updated, your other values kept)');
    if (!p.dry && !(exists && neu === curText)) this.writeSafe('.agents/config.yaml', neu);
    else if (p.dry && !pathSafe(this.root, '.agents/config.yaml')) this.unsafe('.agents/config.yaml');
  }

  /** Codex leads spawn Codex workers, so their workspace-write sandbox needs outbound runtime access. Every project TOML key is kept; the resulting file is tracked in the manifest. */
  codexNetworkConfig() {
    const rel = '.codex/config.toml';
    const dst = `${this.root}/${rel}`;
    let out = '';
    if (existsSync(dst)) {
      let inside = false; let seen = false; let found = false;
      for (const l of linesOf(readFileSync(dst, 'latin1'))) {
        if (/^\[sandbox_workspace_write\][ \t\n\v\f\r]*$/.test(l)) { if (inside && !seen) out += 'network_access = true\n'; inside = true; found = true; out += `${l}\n`; continue; }
        if (l.startsWith('[')) { if (inside && !seen) out += 'network_access = true\n'; inside = false; }
        if (inside && /^[ \t\n\v\f\r]*network_access[ \t\n\v\f\r]*=/.test(l)) { if (!seen) out += 'network_access = true\n'; seen = true; continue; }
        out += `${l}\n`;
      }
      if (inside && !seen) out += 'network_access = true\n';
      if (!found) out += '\n[sandbox_workspace_write]\nnetwork_access = true\n';
    } else out = '[sandbox_workspace_write]\nnetwork_access = true\n';
    this.blocks.push([`toml-${rel}`, sha256(out)]);
    if (existsSync(dst) && readFileSync(dst, 'latin1') === out) { this.plog('same', rel); return; }
    if (this.p.dry) { if (!pathSafe(this.root, rel)) return this.unsafe(rel); } else if (!this.writeSafe(rel, out)) return;
    this.plog('merged', `${rel} (workspace-write network access; other keys kept)`);
  }

  /** @param {string[]} a */
  git(a) { return proc.run('git', ['-C', this.root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] }); }

  /**
   * A249: why the code git will run cannot be trusted, or '' when every script, git hook and Node hook file of `.agents` is the SHIPPED file (sha256, not the manifest, which a
   * cloned repository writes), none is a link, nothing else sits in those folders, and every tracked one is also staged and committed as the shipped bytes (a clean working copy over
   * a hostile blob comes back with `git restore .`). In a dry run the files are not written yet: a missing or different working file that this run would write is fine.
   * @returns {string}
   */
  githooksUntrusted() {
    const audit = codeAudit(this.root, this.p.plHome, this.p.env);
    if (audit.unreadable) return 'the shipped hooks and scripts could not be read from the proofline plugin, so nothing could be compared';
    const actOf = (/** @type {string} */ rel) => this.codeActs.get(rel) ?? (rel.startsWith('.agents/hooks/') ? this.codeActs.get('.agents/hooks') : undefined) ?? '';
    const rank = ['link', 'differs', 'extra', 'missing', 'head', 'index'];
    const all = [...audit.problems].sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind)).filter((p) => !(this.p.dry && (p.kind === 'missing' || p.kind === 'differs') && ['new', 'update'].includes(actOf(p.rel))));
    // one entry per file (the first problem found), the committed-differently case kept when it is the only one
    const bad = all.filter((p, i) => all.findIndex((q) => q.rel === p.rel) === i);
    // which remedy fits: the kinds of problem that were found
    const lagOnly = (/** @type {import('./codetrust.mjs').CodeProblem} */ p) => (p.kind === 'index' || p.kind === 'head') && !audit.problems.some((q) => q.rel === p.rel && q.kind !== 'index' && q.kind !== 'head');
    this.fixText = [...(bad.some((p) => p.eol) ? [GITHOOKS_EOL] : []), ...(bad.some((p) => !p.eol && !lagOnly(p)) ? [GITHOOKS_FIX] : []), ...(bad.some(lagOnly) ? [GITHOOKS_COMMIT] : [])].join('; or ');
    if (bad.length === 0) return '';
    return `${bad.slice(0, 3).map((p) => problemText(p, actOf(p.rel))).join('; ')}${bad.length > 3 ? `; and ${bad.length - 3} more` : ''}`;
  }

  /**
   * A238 (user decision of 2026-11-08, A233): a `core.hooksPath` the user already set (local, global or system: whatever git resolves here) to another folder is never
   * overwritten; the message says which path, from where, and what to do. Unset: set locally. The same folder: nothing, no message.
   */
  doGithooksPath() {
    const st = hooksPathState((a) => this.git(a), this.root);
    const why = st.state === 'other' ? '' : this.githooksUntrusted();
    if (st.state === 'same') {
      this.plog('same', 'git config core.hooksPath');
      // already active (a local value the user or an earlier run set): never unset here (a normal upgrade has the new files uncommitted), but say so when the code is not the shipped one
      if (why !== '') this.plog('warn', `core.hooksPath already points at .agents/githooks, but the code it runs is not proofline's shipped copy: ${why}. Review it before you commit; if you did not edit these files, ${this.fixText}. A tracked file that is committed with other content comes back with git restore or git checkout, so commit proofline's copy`);
    } else if (st.state === 'unset') {
      // A249: git runs every executable file of the folder it is pointed to, and those hooks start the project's own scripts: the path is set only when all of that code is proofline's
      if (why !== '') this.plog('warn', `core.hooksPath was NOT set to .agents/githooks (proofline's commit and push locks are NOT active): ${why}. Review the file(s); to use proofline's hooks, ${this.fixText}, or after reviewing run: git config --local core.hooksPath .agents/githooks${/\.agents\/(scripts|hooks|skills)\//.test(why) ? '. Note: the proofline hook of Claude Code loads .agents/scripts/proofline-core.mjs and the skill scripts too, so a script kept as yours runs there even without core.hooksPath' : ''}`);
      else {
        this.plog('merged', 'git config --local core.hooksPath .agents/githooks');
        if (!this.p.dry) this.git(['config', '--local', 'core.hooksPath', '.agents/githooks']);
      }
    } else this.plog('warn', globalHookspathMessage(st.value, st.scope, st.origin));
  }

  writeManifest() {
    const { p } = this;
    const rows = [...this.manifestNew].sort((a, b) => byteCmp(a[1], b[1]) || byteCmp(a[0], b[0]));
    const head = ['# proofline manifest: sha256 and path of every installed file (used by `proofline upgrade`)', `# version: ${u(p.version)}`, `# profile: ${p.profile}`, `# runtimes: ${p.runtimes}`,
      ...this.blocks.map(([k, h]) => `# ${k}: ${h}`)];
    const text = `${[...head, ...rows.map(([h, f]) => `${h}  ${f}`)].join('\n')}\n`;
    let cur = null;
    try { cur = readFileSync(this.manifestFile, 'latin1'); } catch { cur = null; }
    if (cur === text) return;
    if (p.dry) { if (!pathSafe(this.root, MANIFEST_REL)) this.unsafe(MANIFEST_REL); else this.plog('merged', MANIFEST_REL); return; }
    if (this.writeSafe(MANIFEST_REL, text)) this.plog('merged', MANIFEST_REL);
  }

  /** The change summary lines and the number of changes. @returns {{ lines: string[], changes: number }} */
  report() {
    const changes = this.plan.filter(([a]) => a === 'new' || a === 'update' || a === 'merged' || a === 'removed').length;
    /** @type {string[]} */ const lines = [this.p.dry ? `proofline ${this.p.mode} (dry run, nothing written):` : `proofline ${this.p.mode}:`];
    /** @type {Map<string, number>} */ const grp = new Map();
    /** @type {string[]} */ const order = [];
    /** @type {string[]} */ const keeps = [];
    for (const [a, t] of this.plan) {
      if (a === 'new') {
        const c = t.split('/');
        const k = (c[0] === '.agents' || c[0] === '.claude' || c[0] === '.codex') && (c[2] ?? '') !== '' ? `${c[0]}/${c[1]}/` : t;
        if (k !== t) grp.set(k, (grp.get(k) ?? 0) + 1);
        order.push(k);
      } else if (a === 'update') lines.push(`  ~ updated   ${t}`);
      else if (a === 'removed') lines.push(`  - removed   ${t}`);
      else if (a === 'merged') lines.push(`  + merged    ${t}`);
      else if (a === 'keep') keeps.push(t);
      else if (a === 'conflict') lines.push(`  ! CONFLICT  ${t} (modified by you; new version beside it as ${t}.proofline-new)`);
      else if (a === 'orphan') lines.push(`  ? ${t}`);
      else if (a === 'warn') lines.push(`  ! WARN      ${t}`);
    }
    // a few kept files are named one by one; hundreds (a checkout that changed every file's line ends) collapse into one line
    if (keeps.length <= 5) for (const t of keeps) lines.push(`  = kept      ${t} (differs from proofline's version; yours is untouched)`);
    else lines.push(`  = kept      ${keeps.length} files differ from proofline's version and are untouched (first 5: ${keeps.slice(0, 5).join(', ')})`);
    const seen = new Set();
    for (const k of order) {
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(grp.has(k) ? `  + new       ${k} (${grp.get(k)})` : `  + new       ${k}`);
    }
    if (changes === 0) lines.push('  no changes');
    return { lines, changes };
  }

  /** The whole install; the plan is kept for the caller (conflicts). */
  run() {
    this.stage = mkdtempSync(path.join(tmpdir(), 'proofline-install-'));
    try {
      const files = this.stageBuild();
      this.placeAll(files);
      this.nodeHookInstall();
      this.doConfig();
      const f = this.p.plHome;
      if (this.has('claude')) { this.jsonMerge('.claude/settings.json', `${f}/adapters/claude/settings.fragment.json`); this.hookTimeoutsApply('.claude/settings.json'); }
      if (this.has('codex')) { this.jsonMerge('.codex/hooks.json', `${f}/adapters/codex/hooks.json`); this.hookTimeoutsApply('.codex/hooks.json'); this.codexNetworkConfig(); }
      this.mergeBlock('AGENTS.md', `${f}/control-plane/AGENTS.md`);
      if (this.has('claude')) this.mergeBlock('CLAUDE.md', `${f}/control-plane/CLAUDE.md`);
      this.ensureLine('.gitignore', '.agents/local/');
      this.ensureLine('.gitignore', '.agents/runs/');
      this.doGithooksPath();
      this.writeManifest();
      const r = this.report();
      for (const l of r.lines) this.p.ui.say(l);
    } finally { rmSync(this.stage, { recursive: true, force: true }); }
    return this.plan;
  }
}

/**
 * `proofline init [flags]`.
 * @param {{ root: string, plHome: string, version: string, env: NodeJS.ProcessEnv, ui: Ui }} c @param {string[]} args byte strings
 */
export function cmdInit(c, args) {
  const { env, ui, root, plHome } = c;
  const opt = { runtimes: bytes(env.PROOFLINE_RUNTIMES ?? ''), lead: bytes(env.PROOFLINE_LEAD ?? ''), worker: bytes(env.PROOFLINE_WORKER ?? ''), reviewers: bytes(env.PROOFLINE_REVIEWERS ?? ''),
    profile: bytes(env.PROOFLINE_PROFILE ?? ''), adapter: bytes(env.PROOFLINE_TASK_ADAPTER ?? ''), push: bytes(env.PROOFLINE_PUSH_APPROVAL ?? ''), forbidden: '', protected: '' };
  let haveProtected = false; /** @type {string[]} */ const roles = [];
  if (env.PROOFLINE_PROTECTED_BRANCHES !== undefined) { haveProtected = true; opt.protected = bytes(env.PROOFLINE_PROTECTED_BRANCHES); }
  let dry = false; let yes = false; let verify = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    /** @param {string} msg */
    const need = (msg) => { if (i + 1 >= args.length) throw new CliDie(msg); return args[++i]; };
    switch (a) {
      case '--yes': case '-y': yes = true; break;
      case '--dry-run': dry = true; break;
      case '--verify-commands': verify = true; break;
      case '--runtimes': opt.runtimes = need('--runtimes needs a value'); break;
      case '--lead': opt.lead = need('--lead needs a value'); break;
      case '--worker': opt.worker = need('--worker needs a value'); break;
      case '--reviewers': opt.reviewers = need('--reviewers needs a value'); break;
      case '--profile': opt.profile = need('--profile needs a value'); break;
      case '--task-adapter': opt.adapter = need('--task-adapter needs a value'); break;
      case '--protected-branches': haveProtected = true; opt.protected = need('--protected-branches needs a value'); break;
      case '--push-approval': opt.push = need('--push-approval needs true or false'); break;
      case '--forbidden-identity': { const v = need('--forbidden-identity needs a pattern'); opt.forbidden = opt.forbidden !== '' ? `${opt.forbidden} ${v}` : v; break; }
      case '--role': { if (args[i + 1] === undefined || args[i + 1] === '') throw new CliDie('--role needs ROLE=RUNTIME'); roles.push(args[++i]); break; }
      default: throw new CliDie(`init: unknown argument: ${a} (see: proofline help)`);
    }
  }
  if (!existsSync(`${plHome}/control-plane/agents`)) throw new CliDie(`no control-plane/ in ${u(plHome)}`);
  if (proc.run('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }).status !== 0) throw new CliDie(`${u(root)} is not a git repository; run git init first`);
  const ex = `${root}/.agents/config.yaml`;
  const old = readManifest(`${root}/${MANIFEST_REL}`);
  const interactive = !yes && ui.interactive;
  const ask = (/** @type {string} */ prompt, /** @type {string} */ def) => (interactive ? ui.ask(prompt, def) : def);

  // resolve: flag/env > existing install > detected default (asked when interactive)
  let runtimes;
  if (opt.runtimes === '') {
    let d = old.meta.get('runtimes') ?? '';
    if (d === '') d = [['claude', env.PROOFLINE_CLAUDE_BIN], ['codex', env.PROOFLINE_CODEX_BIN]].filter(([rt, bin]) => commandV(bin || rt, env) !== null).map(([rt]) => rt).join(' ');
    if (d === '') d = 'claude';
    runtimes = ask('Runtimes to set up (claude, codex)', d);
  } else runtimes = opt.runtimes;
  runtimes = runtimes.replace(/,/g, ' ').replace(/ +/g, ' ').replace(/^ /, '').replace(/ $/, '');
  if (runtimes === '') throw new CliDie('no runtime selected');
  const rts = runtimes.split(' ');
  for (const r of rts) if (r !== 'claude' && r !== 'codex') throw new CliDie(`unknown runtime: ${r} (claude or codex)`);
  const first = rts[0];
  const cfg = Config.load(ex);
  /** @param {string} given @param {string} prompt @param {string} key @param {string} def @param {string} allowed */
  const pick = (given, prompt, key, def, allowed) => {
    const v = given !== '' ? given : ask(prompt, cfg.get(key, def));
    if (!`|${allowed}|`.includes(`|${v}|`)) throw new CliDie(`invalid value for ${prompt}: ${v} (want ${allowed})`);
    return v;
  };
  const lead = pick(opt.lead, 'Lead runtime', 'runtime.lead', first, 'claude|codex');
  const worker = pick(opt.worker, 'Worker runtime', 'runtime.worker', lead, 'claude|codex');
  const reviewers = pick(opt.reviewers, 'Reviewer runtime', 'runtime.reviewers', lead, 'claude|codex');
  for (const r of [lead, worker, reviewers]) if (!rts.includes(r)) throw new CliDie(`runtime ${r} is used by the config but not in --runtimes (${runtimes})`);
  for (const r of roles) { // --role ROLE=RUNTIME: the role must have a roles/<ROLE>.md, the runtime must be one of --runtimes
    if (!/^.+=.+$/.test(r)) throw new CliDie(`invalid --role value: ${r} (want ROLE=RUNTIME, for example implementer=codex)`);
    const name = r.slice(0, r.indexOf('=')); const rt = r.slice(r.indexOf('=') + 1);
    if (!/^[a-z_]+$/.test(name) || !existsSync(`${plHome}/roles/${name}.md`)) throw new CliDie(`unknown role in --role: ${name} (want a name from roles/*.md, for example implementer)`);
    if (rt !== 'claude' && rt !== 'codex') throw new CliDie(`unknown runtime in --role: ${rt} (claude or codex)`);
    if (!rts.includes(rt)) throw new CliDie(`runtime ${rt} is used by --role ${r} but not in --runtimes (${runtimes})`);
  }
  const profile = pick(opt.profile, 'Model profile (max, balanced, economy)', 'profile', 'balanced', 'max|balanced|economy');
  const adapter = pick(opt.adapter, 'Task adapter (markdown, github, jira, linear)', 'tasks.adapter', 'markdown', 'markdown|github|jira|linear');
  const push = pick(opt.push, 'Pushes need your approval (true, false)', 'git.push_requires_approval', 'true', 'true|false');
  const protectedBranches = haveProtected ? opt.protected : ask('Protected branches, space separated (empty: none)', cfg.get('git.protected_branches', ''));
  const forbidden = opt.forbidden !== '' ? opt.forbidden : ask('Forbidden commit identities, space separated patterns (empty: none)', cfg.get('git.forbidden_identities', ''));
  const canon = detectBranchIn(root);
  let dBuild = ''; let dTest = ''; let dLint = '';
  if (!existsSync(ex) || (cfgCmds(ex, 'commands.test').join('') + cfgCmds(ex, 'commands.build').join('')) === '') {
    // discover (and with --verify-commands prove by a trial run) the commands; say what init says
    try {
      const found = discoverCommands(root);
      ui.say(`discovered commands: build='${joinCommands(found.build)}' test='${joinCommands(found.test)}' lint='${joinCommands(found.lint)}'`);
      for (const n of ambigNotes(found.ambig)) ui.say(`  ${n}`);
      let cmds = { build: found.build, test: found.test, lint: found.lint };
      if (verify) { ui.say('verifying commands (trial runs)...'); cmds = verifyCommands(root, cmds, (/** @type {string} */ l) => ui.say(l), { env }); }
      [dBuild, dTest, dLint] = KINDS.map((k) => cmds[/** @type {'build'|'test'|'lint'} */ (k)].join('\n'));
    } catch { ui.warn('command discovery failed; commands.* stay empty'); }
  }
  const inst = new Install({ root, plHome, version: c.version, env, mode: 'init', dry, profile, runtimes, opt: { profile: opt.profile, lead: opt.lead, worker: opt.worker, reviewers: opt.reviewers, adapter: opt.adapter, push: opt.push, forbidden: opt.forbidden },
    haveProtected, canon, protectedBranches, forbidden, lead, worker, reviewers, adapter, push, roles, dBuild, dTest, dLint, ui });
  inst.run();
  const empty = dry || !existsSync(ex) ? [] : KINDS.filter((k) => cfgCmds(ex, `commands.${k}`).length === 0);
  if (empty.length > 0) {
    ui.say('');
    ui.say(`commands.${empty.join(', commands.')} still empty: no build record can be made and the verify gate has nothing to run for them. proofline doctor --commands finds the commands, proves each by one run and asks you once (A200)`);
  }
  if (!dry) {
    ui.say('');
    ui.say('next: proofline doctor    (verifies hooks, runtimes and every enforced rule)');
    ui.say('      commit the installed files (.agents/, AGENTS.md, CLAUDE.md, runtime adapter files) when you are happy');
  }
}

/**
 * `proofline upgrade [--dry-run]`.
 * @param {{ root: string, plHome: string, version: string, env: NodeJS.ProcessEnv, ui: Ui }} c @param {string[]} args
 */
export function cmdUpgrade(c, args) {
  const { ui, root } = c;
  let dry = false;
  for (const a of args) {
    if (a === '--dry-run') dry = true;
    else if (a === '--yes' || a === '-y') continue;
    else throw new CliDie(`upgrade: unknown argument: ${a}`);
  }
  const cf = `${root}/.agents/config.yaml`;
  if (!existsSync(cf)) throw new CliDie(`proofline is not installed in ${u(root)}; run: proofline init`);
  const old = readManifest(`${root}/${MANIFEST_REL}`);
  if (!old.exists) ui.warn(`no ${MANIFEST_REL}: every differing file counts as modified by you`);
  const cfg = Config.load(cf);
  const profile = cfg.get('profile', 'balanced');
  let runtimes = old.meta.get('runtimes') ?? '';
  if (runtimes === '') runtimes = [...new Set([cfg.get('runtime.lead', 'claude'), cfg.get('runtime.worker', ''), cfg.get('runtime.reviewers', '')].filter((x) => x !== ''))].sort(byteCmp).join(' ');
  const from = old.meta.get('version') ?? '';
  ui.say(`proofline upgrade ${from !== '' ? `from ${from} ` : ''}to ${u(c.version)} (profile ${profile}, runtimes: ${runtimes})`);
  const inst = new Install({ root, plHome: c.plHome, version: c.version, env: c.env, mode: 'upgrade', dry, profile, runtimes, opt: {}, haveProtected: false, canon: '', protectedBranches: '', forbidden: '', lead: '', worker: '', reviewers: '',
    adapter: '', push: '', roles: [], dBuild: '', dTest: '', dLint: '', ui });
  const plan = inst.run();
  if (plan.some(([a]) => a === 'conflict')) {
    ui.say(''); ui.say('conflicts: files you modified were kept. Compare each with its .proofline-new copy, merge by hand, then delete the copy.');
  }
  // The default design document moved out of the root (0.0.3); offer the move, never do it, never touch the config.
  const dd = cfg.get('design_docs.design', 'docs/design/DESIGN.md');
  if (existsSync(`${root}/DESIGN.md`) && !cfg.lines.some((l) => l.startsWith('design_docs.design.surfaces.')) && (dd === 'DESIGN.md' || dd === 'docs/design/DESIGN.md')) {
    ui.say(''); ui.say('offer: DESIGN.md sits at the project root; the default location is now docs/design/DESIGN.md. Nothing was moved or rewritten. To move it:');
    ui.say('  1. git mv DESIGN.md docs/design/DESIGN.md');
    ui.say('  2. set design_docs.design: docs/design/DESIGN.md in .agents/config.yaml (needed when it says DESIGN.md)');
  }
}
