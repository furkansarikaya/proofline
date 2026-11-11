// @ts-check
// A249 (independent security review of 173-C2, round 1 of the pull request): which project files are CODE that proofline's git hooks, scripts and runtime hooks run, and whether each of them
// is the shipped one. A cloned repository controls every file of its working tree, its index, its HEAD and its manifest; none of them is trusted as "proofline's own".
// The only reference is the shipped copy in the plugin (`plHome`), compared by sha256 of the working file and by git blob id of the index entry and of HEAD, so a clean-looking
// working copy over a hostile committed blob (a `git restore .` brings it back) is found as well.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { hgit } from './hgit.mjs';
import { sha256File } from './hash.mjs';

/** The two git hooks proofline ships (control-plane/agents/githooks/). */
export const SHIPPED_GITHOOKS = ['pre-commit', 'pre-push'];

/** The folders of the project whose files are loaded by a git hook or a runtime hook. */
export const CODE_DIRS = ['.agents/scripts', '.agents/githooks', '.agents/hooks', '.agents/ecosystems.mjs', '.agents/skills'];

/** The folders in which a file that proofline does not ship is itself a problem (a skill folder may hold the user's own skills). */
const EXTRA_DIRS = ['.agents/scripts/', '.agents/githooks/', '.agents/hooks/'];

/** Repository-controlled names reach a terminal: no control character (ESC, CR, BEL ...) passes. @param {string} t */
export function clean(t) { return t.replace(/[\x00-\x1f\x7f-\x9f]/g, '?'); }

/** @param {string} dir @param {boolean} [all] also links and other non-folders @returns {string[]} the files below DIR, as relative paths */
function listFiles(dir, all = false) {
  /** @type {string[]} */ const out = [];
  /** @param {string} d @param {string} pre */
  const rec = (d, pre) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === '.DS_Store') continue;
      if (e.isDirectory()) rec(`${d}/${e.name}`, `${pre}${e.name}/`);
      else if (all ? true : e.isFile()) out.push(`${pre}${e.name}`);
    }
  };
  rec(dir, '');
  return out.sort();
}

/**
 * Every code file proofline ships, as the path it has in a project -> the shipped file in the plugin.
 * @param {string} plHome @returns {Map<string, string>}
 */
export function shippedCode(plHome) {
  /** @type {Map<string, string>} */ const m = new Map();
  /** @param {string} base @param {string} abs @param {(rel: string) => boolean} [keep] */
  const add = (base, abs, keep = () => true) => { for (const f of listFiles(abs)) if (keep(f)) m.set(`${base}/${f}`, `${abs}/${f}`); };
  add('.agents/scripts', `${plHome}/control-plane/agents/scripts`);
  add('.agents/githooks', `${plHome}/control-plane/agents/githooks`);
  // the Node hook tree: the same selection as the installer's (hooks.json is the wiring source and is not installed)
  add('.agents/hooks', `${plHome}/adapters/claude/hooks`, (f) => f !== 'hooks.json');
  // the scripts of the skills that the core starts (submit, freeze, knowledge-done, record, delivery-check -> design-sync ...): `skills/<name>/scripts/**`
  try {
    for (const e of readdirSync(`${plHome}/skills`, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      for (const f of listFiles(`${plHome}/skills/${e.name}/scripts`)) m.set(`.agents/skills/${e.name}/scripts/${f}`, `${plHome}/skills/${e.name}/scripts/${f}`);
    }
  } catch { /* no skills folder: the check below reports an unreadable tree */ }
  // doctor starts it (`ecosystems.mjs check`)
  m.set('.agents/ecosystems.mjs', `${plHome}/control-plane/agents/ecosystems.mjs`);
  return m;
}

/** The git blob id of BYTES. @param {Buffer} b */
function blobId(b) { return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); }

/**
 * What sits in the project's `.agents/githooks`, read with lstat, so a link is seen as a link.
 * @param {string} root @returns {{ unsafe: string, entries: Array<{ name: string, kind: 'file' | 'symlink' | 'other' }> }} `unsafe` names the part of the path that is a link or not a folder ('' when none); a folder that does not exist has no entries
 */
export function githooksFolder(root) {
  for (const rel of ['.agents', '.agents/githooks']) {
    let st; try { st = lstatSync(`${root}/${rel}`); } catch { return { unsafe: '', entries: [] }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { unsafe: rel, entries: [] };
  }
  /** @type {Array<{ name: string, kind: 'file' | 'symlink' | 'other' }>} */ const entries = [];
  for (const name of readdirSync(`${root}/.agents/githooks`).sort()) {
    const st = lstatSync(`${root}/.agents/githooks/${name}`);
    entries.push({ name, kind: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other' });
  }
  return { unsafe: '', entries };
}

/** @typedef {{ rel: string, kind: 'link' | 'missing' | 'differs' | 'extra' | 'index' | 'head' }} CodeProblem */

/**
 * Compare the project's code files with the shipped ones. `link`: the file or a folder above it is a symbolic link (or not a regular file); `missing`; `differs`: the working
 * file's sha256 is not the shipped one; `extra`: a file in `.agents/githooks` that proofline does not ship (git may run any hook-named file) in the working tree, the index or HEAD;
 * `index` / `head`: the staged or committed blob of a tracked code file is not the shipped one (or is a link).
 * @param {string} root @param {string} plHome @param {NodeJS.ProcessEnv} env
 * @returns {{ problems: CodeProblem[], unreadable: boolean }} `unreadable`: the shipped files could not be listed, nothing was compared
 */
export function codeAudit(root, plHome, env) {
  const shipped = plHome === '' ? new Map() : shippedCode(plHome);
  if (!shipped.has('.agents/githooks/pre-commit') || !shipped.has('.agents/scripts/proofline-core.mjs')) return { problems: [], unreadable: true };
  /** @type {CodeProblem[]} */ const problems = [];
  /** @type {Map<string, boolean>} */ const dirs = new Map();
  /** @param {string} d the folder, relative; true when it is a real folder along its whole path */
  const realDir = (d) => {
    const c = dirs.get(d); if (c !== undefined) return c;
    let ok = true;
    const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    if (parent !== '' && !realDir(parent)) ok = false;
    else { try { const st = lstatSync(`${root}/${d}`); ok = st.isDirectory() && !st.isSymbolicLink(); } catch { ok = false; } }
    dirs.set(d, ok); return ok;
  };
  /** @type {Map<string, Buffer>} */ const bytes = new Map();
  for (const [rel, abs] of shipped) {
    const dir = rel.slice(0, rel.lastIndexOf('/'));
    let st;
    try { st = lstatSync(`${root}/${rel}`); } catch { problems.push({ rel, kind: 'missing' }); continue; }
    if (!realDir(dir) || !st.isFile()) { problems.push({ rel, kind: 'link' }); continue; }
    if (sha256File(`${root}/${rel}`) !== sha256File(abs)) problems.push({ rel, kind: 'differs' });
  }
  const folder = githooksFolder(root);
  if (folder.unsafe !== '') problems.push({ rel: folder.unsafe, kind: 'link' });
  for (const e of folder.entries) if (!shipped.has(`.agents/githooks/${e.name}`)) problems.push({ rel: `.agents/githooks/${e.name}`, kind: 'extra' });
  // a file in the code folders that proofline does not ship (a Node hook event or a script module a loader could pick up)
  for (const d of ['.agents/scripts', '.agents/hooks']) {
    if (!realDir(d)) continue;
    for (const f of listFiles(`${root}/${d}`, true)) if (!shipped.has(`${d}/${f}`)) problems.push({ rel: `${d}/${f}`, kind: 'extra' });
  }
  // tracked content: the index and HEAD (one call each)
  const gitEnv = { ...env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete gitEnv[k];
  // the hermetic helper (A248: a repository's fsmonitor, filter drivers and hooks never run for a call that reads its index); a stand-in context, this module has no other
  const hctx = /** @type {any} */ ({ root, cwd: root, childEnv: () => gitEnv });
  /** @param {string[]} a */
  const git = (a) => hgit(hctx, root, a);
  /** @type {Array<[string, string, string]>} [where, mode, blob + path] */
  const tracked = [];
  const ls = git(['ls-files', '-s', '-z', '--', ...CODE_DIRS]);
  if (ls.status === 0) for (const rec of ls.stdout.toString('latin1').split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t([\s\S]*)$/.exec(rec); if (m) tracked.push(['index', m[1], `${m[2]}\t${m[3]}`]);
  }
  const lt = git(['ls-tree', '-r', '-z', 'HEAD', '--', ...CODE_DIRS]);
  if (lt.status === 0) for (const rec of lt.stdout.toString('latin1').split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(rec); if (m) tracked.push(['head', m[1], `${m[2]}\t${m[3]}`]);
  }
  for (const [where, mode, rest] of tracked) {
    const tab = rest.indexOf('\t'); const blob = rest.slice(0, tab); const rel = Buffer.from(rest.slice(tab + 1), 'latin1').toString('utf8');
    const src = shipped.get(rel);
    if (src === undefined) {
      // a TRACKED file that proofline does not ship is as untrusted as one on disk: deleting it from the working tree does not remove it from the index or HEAD (`git restore` brings it back)
      if (EXTRA_DIRS.some((d) => rel.startsWith(d)) && !problems.some((p) => p.rel === rel && p.kind === 'extra')) problems.push({ rel, kind: 'extra' });
      continue;
    }
    let want = bytes.get(src); if (want === undefined) { want = readFileSync(src); bytes.set(src, want); }
    if (mode === '120000' || blob !== blobId(want)) {
      if (!problems.some((p) => p.rel === rel && p.kind === where)) problems.push({ rel, kind: /** @type {'index' | 'head'} */ (where) });
    }
  }
  return { problems, unreadable: false };
}

/**
 * One line per problem, for a human (the installer's WARN and doctor's FAIL share it). `act` is what the installer did with the file this run, when it is known.
 * @param {CodeProblem} p @param {string} [act]
 */
export function problemText(p, act = '') {
  const r = clean(p.rel);
  switch (p.kind) {
    case 'link': return `${r} is a symbolic link, sits under one, or is not a regular file`;
    case 'missing': return `${r} is missing`;
    case 'differs': return act === 'keep' || act === 'mine' ? `${r} differs from proofline's copy and was kept as your own file`
      : act === 'conflict' ? `${r} differs from proofline's copy (an edited file; proofline's copy was written beside it as ${r}.proofline-new)`
        : `${r} differs from proofline's copy`;
    case 'extra': return `${r} is not a file proofline ships (git may run it)`;
    case 'index': return `${r} is staged with content that is not proofline's copy`;
    default: return `${r} is committed (HEAD) with content that is not proofline's copy, so a checkout, restore or reset would bring it back`;
  }
}
