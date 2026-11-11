// @ts-check
// A249 (independent security review of 173-C2, round 1 of the pull request): which project files are CODE that proofline's git hooks, scripts and runtime hooks run, and whether each of them
// is the shipped one. A cloned repository controls every file of its working tree, its index, its HEAD and its manifest; none of them is trusted as "proofline's own".
// The only reference is the shipped copy in the plugin (`plHome`), compared by sha256 of the working file and by git blob id of the index entry and of HEAD, so a clean-looking
// working copy over a hostile committed blob (a `git restore .` brings it back) is found as well.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { hgit } from './hgit.mjs';
import { sha256, sha256File } from './hash.mjs';

/** The two git hooks proofline ships (control-plane/agents/githooks/). */
export const SHIPPED_GITHOOKS = ['pre-commit', 'pre-push'];

/** The folders of the project whose files are loaded by a git hook or a runtime hook. */
export const CODE_DIRS = ['.agents/scripts', '.agents/githooks', '.agents/hooks', '.agents/ecosystems.mjs', '.agents/skills'];

/** The folders in which a file that proofline does not ship is itself a problem (a skill folder may hold the user's own skills). */
const EXTRA_DIRS = ['.agents/scripts/', '.agents/githooks/', '.agents/hooks/'];

/** Repository-controlled names reach a terminal: no control character (ESC, CR, BEL ...) passes. @param {string} t */
export function clean(t) { return t.replace(/[\x00-\x1f\x7f-\x9f]/g, '?'); }

/** A whole output line (or several, joined by the writer's newline) with every control character replaced by `?`, the newline excepted: the one place a writer sanitises (A249 SEC-3 round 3). @param {string} t */
export function cleanLines(t) { return t.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '?'); }

/** The same for a byte string (one char per byte, UTF-8 text): C0 and DEL, and the two-byte UTF-8 form of C1 (0xC2 0x80-0x9F); a lone byte of a multi-byte letter is left alone. @param {string} t */
export function cleanBytes(t) { return t.replace(/[\x00-\x09\x0b-\x1f\x7f]|\xc2[\x80-\x9f]/g, '?'); }

/** Files whose meaning does not change when a checkout turned LF into CRLF (Node reads CR LF as one line end; JSON and Markdown likewise). Shell scripts and git hooks are NOT here: sh breaks on the CR. */
const EOL_TOLERANT = /\.(mjs|js|cjs|json|md)$/;
/** @param {string} rel */
export function eolTolerant(rel) { return EOL_TOLERANT.test(rel); }
/** CRLF -> LF. @param {Buffer} b */
export function lf(b) { return b.includes(13) ? Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : b; }
/** LF -> CRLF (what an autocrlf checkout or commit-as-is holds). @param {Buffer} b */
export function crlf(b) { return Buffer.from(b.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1'); }
/**
 * sha256 of the file as proofline compares it: exact bytes, except that a file of an EOL-tolerant kind is read with CRLF as LF (a Windows autocrlf checkout).
 * @param {string} file @param {string} rel the project path (decides the kind)
 */
export function shaTolerant(file, rel) {
  const s = sha256File(file);
  if (s === '' || !eolTolerant(rel)) return s;
  try { return createHash('sha256').update(lf(readFileSync(file))).digest('hex'); } catch { return s; }
}

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

/** @param {Buffer} b */ const sha256Buf = (b) => sha256(b);

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

/** @typedef {{ rel: string, kind: 'link' | 'missing' | 'differs' | 'extra' | 'index' | 'head', eol?: boolean }} CodeProblem  `eol`: a `differs` file that is proofline's copy except for its line endings (CRLF) */

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
    if (sha256File(`${root}/${rel}`) === sha256File(abs)) continue;
    // a Windows checkout with core.autocrlf=true turns LF into CRLF: for the kinds Node and JSON read the same either way that is not a difference; for a shell script or a git hook it is (sh breaks on the CR) and the message says so
    if (shaTolerant(`${root}/${rel}`, rel) === shaTolerant(abs, rel) && eolTolerant(rel)) continue;
    const onlyEol = !eolTolerant(rel) && sha256Buf(lf(readFileSync(`${root}/${rel}`))) === sha256File(abs);
    problems.push(onlyEol ? { rel, kind: 'differs', eol: true } : { rel, kind: 'differs' });
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
  // a case-insensitive checkout (macOS, Windows: core.ignorecase=true) lets `.agents/Scripts/x` stand in for a shipped `.agents/scripts/x` and git's pathspecs are case-sensitive: fold the case
  const fold = git(['config', '--type=bool', '--get', 'core.ignorecase']).stdout.toString('utf8').trim() === 'true';
  const prefixes = CODE_DIRS.map((d) => (fold ? d.toLowerCase() : d));
  /** @param {string} rel */
  const inCode = (rel) => { const r = fold ? rel.toLowerCase() : rel; return prefixes.some((d) => r === d || r.startsWith(`${d}/`)); };
  /** @type {Map<string, string>} lower-case shipped path -> shipped path */
  const folded = new Map(); if (fold) for (const k of shipped.keys()) folded.set(k.toLowerCase(), k);
  const ls = git(fold ? ['--icase-pathspecs', 'ls-files', '-s', '-z', '--', ...CODE_DIRS] : ['ls-files', '-s', '-z', '--', ...CODE_DIRS]);
  if (ls.status === 0) for (const rec of ls.stdout.toString('latin1').split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t([\s\S]*)$/.exec(rec); if (m) tracked.push(['index', m[1], `${m[2]}\t${m[3]}`]);
  }
  // ls-tree takes no case-folded pathspec: with a folding checkout the whole tree is listed and filtered here
  const lt = git(fold ? ['ls-tree', '-r', '-z', 'HEAD'] : ['ls-tree', '-r', '-z', 'HEAD', '--', ...CODE_DIRS]);
  if (lt.status === 0) for (const rec of lt.stdout.toString('latin1').split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(rec); if (m) tracked.push(['head', m[1], `${m[2]}\t${m[3]}`]);
  }
  for (const [where, mode, rest] of tracked) {
    const tab = rest.indexOf('\t'); const blob = rest.slice(0, tab); const rel = Buffer.from(rest.slice(tab + 1), 'latin1').toString('utf8');
    if (fold && !inCode(rel)) continue;
    const shippedRel = shipped.has(rel) ? rel : fold ? folded.get(rel.toLowerCase()) : undefined;
    const src = shippedRel === undefined ? undefined : shipped.get(shippedRel);
    // the same name in another case (`.agents/Scripts/agent.sh`): on a folding file system it lands on proofline's file, and it is not a file proofline ships under that name
    if (src !== undefined && shippedRel !== rel) { if (!problems.some((p) => p.rel === rel && p.kind === 'extra')) problems.push({ rel, kind: 'extra' }); continue; }
    if (src === undefined) {
      // a TRACKED file that proofline does not ship is as untrusted as one on disk: deleting it from the working tree does not remove it from the index or HEAD (`git restore` brings it back)
      if (EXTRA_DIRS.some((d) => (fold ? rel.toLowerCase().startsWith(d) : rel.startsWith(d))) && !problems.some((p) => p.rel === rel && p.kind === 'extra')) problems.push({ rel, kind: 'extra' });
      continue;
    }
    let want = bytes.get(src); if (want === undefined) { want = readFileSync(src); bytes.set(src, want); }
    // an LF-or-CRLF blob of an EOL-tolerant file is proofline's copy; a tracked name that differs from the shipped one in case is not (a checkout on a folding file system writes where the other spelling sits)
    const okBlob = blob === blobId(want) || (eolTolerant(shippedRel ?? rel) && blob === blobId(crlf(want)));
    if (mode === '120000' || !okBlob) {
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
    case 'differs': return p.eol === true ? `${r} is proofline's copy except for its line endings (CRLF, usually core.autocrlf=true on Windows); a shell script or git hook with CR line ends does not run` : act === 'keep' || act === 'mine' ? `${r} differs from proofline's copy and was kept as your own file`
      : act === 'conflict' ? `${r} differs from proofline's copy (an edited file; proofline's copy was written beside it as ${r}.proofline-new)`
        : `${r} differs from proofline's copy`;
    case 'extra': return `${r} is not a file proofline ships (git may run it)`;
    case 'index': return `${r} is staged with content that is not proofline's copy`;
    default: return `${r} is committed (HEAD) with content that is not proofline's copy, so a checkout, restore or reset would bring it back`;
  }
}
