// @ts-check
// A249 (independent security review of 173-C2, round 1 of the pull request): which project files are CODE that proofline's git hooks, scripts and runtime hooks run, and whether each of them
// is the shipped one. A cloned repository controls every file of its working tree, its index, its HEAD and its manifest; none of them is trusted as "proofline's own".
// The only reference is the shipped copy in the plugin (`plHome`), compared by sha256 of the working file and by git blob id of the index entry and of HEAD, so a clean-looking
// working copy over a hostile committed blob (a `git restore .` brings it back) is found as well.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { hgit } from './hgit.mjs';
import { sha256, sha256File } from './hash.mjs';
import { asciiLower } from './shellglob.mjs';

/** The two git hooks proofline ships (control-plane/agents/githooks/). */
export const SHIPPED_GITHOOKS = ['pre-commit', 'pre-push'];

/** The folders of the project whose files are loaded by a git hook or a runtime hook. */
export const CODE_DIRS = ['.agents/scripts', '.agents/githooks', '.agents/hooks', '.agents/ecosystems.mjs', '.agents/ecosystems.json', '.agents/skills'];

/** The folders in which a file that proofline does not ship is itself a problem (a skill folder may hold the user's own skills). */
const EXTRA_DIRS = ['.agents/scripts/', '.agents/githooks/', '.agents/hooks/'];

/**
 * Control and format characters that must never reach a terminal from repository text: C0, DEL, C1, and the invisible or direction-changing ones (zero width and direction marks
 * U+200B-200F, line and paragraph separators U+2028/2029, bidi embeddings and isolates U+202A-202E and U+2066-2069, word joiner and invisible operators U+2060-2064, U+061C, U+FEFF).
 */
const UNSAFE = '\\x00-\\x1f\\x7f-\\x9f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff';
const UNSAFE_RE = new RegExp(`[${UNSAFE}]`, 'g');
/** Repository-controlled names reach a terminal: no control, format or direction character (ESC, CR, LF, BEL, bidi ...) passes. @param {string} t */
export function clean(t) { return t.replace(UNSAFE_RE, '?'); }

/**
 * One output LINE with every control and format character replaced by `?`, the line feed included: a row can never carry a line break of its own (repository text such as a hook
 * command or a folder name must not forge a second line); the writer adds the only newline. @param {string} t
 */
export function cleanLines(t) { return clean(t); }

/**
 * The same for a byte string (one char per byte, UTF-8 text), applied to the bytes that are written: C0 and DEL, the two-byte UTF-8 form of C1 (0xC2 0x80-0x9F) and the three-byte forms
 * of the format and direction characters above; a lone byte of a multi-byte letter is left alone. A string that holds a character above 0xFF is not a byte string (it is text: it would
 * lose its high byte in a latin1 write) and is converted to its UTF-8 bytes first. @param {string} t
 */
export function cleanBytes(t) {
  // the bytes are read as UTF-8 text (a byte that is no valid UTF-8, such as a lone C1 byte, becomes `?`), cleaned as text, and encoded back: what is cleaned is what is written
  const text = /[^\x00-\xff]/.test(t) ? t : Buffer.from(t, 'latin1').toString('utf8');
  return Buffer.from(clean(text).replace(/�/g, '?'), 'utf8').toString('latin1');
}

/**
 * Terminal output (a byte string, possibly many lines): every line and every tab-separated part is cleaned as `cleanBytes` does, the line feed and the tab stay (an error message, a usage
 * text and a relayed report keep their layout; no byte of repository or configuration text can start an escape sequence). @param {string} t
 */
export function cleanOut(t) { return t.split('\n').map((l) => l.split('\t').map(cleanBytes).join('\t')).join('\n'); }

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
  // the definition the scan for real waits (and every other reader) trusts: a project copy that was emptied or rewritten would blind it (A276)
  m.set('.agents/ecosystems.json', `${plHome}/control-plane/agents/ecosystems.json`);
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

/** @typedef {{ rel: string, kind: 'link' | 'missing' | 'differs' | 'extra' | 'index' | 'head', eol?: boolean, alias?: boolean, symlink?: boolean }} CodeProblem  `eol`: a `differs` file that is proofline's copy except for its line endings (CRLF); `alias`: an `extra` tracked name that a case-insensitive or Unicode-folding file system can resolve to a code path proofline ships; `symlink`: an index or HEAD entry of mode 120000 */

/** The names under `.agents` whose files are code (the first two components of every shipped path). */
const CODE_NAMES = ['scripts', 'githooks', 'hooks', 'ecosystems.mjs', 'ecosystems.json', 'skills'];

/** Characters a file system ignores when it compares names (HFS+: zero width and direction marks, soft hyphen, word joiner, BOM): they may be dropped. */
const IGNORABLE_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;

/**
 * A name as a folding file system compares it, reduced to ASCII lower case where that is possible: ignorable characters dropped, compatibility forms unfolded (U+017F long s -> s, U+212A
 * Kelvin -> k, the ligatures ﬃ ﬁ ﬂ ﬆ, full width letters), sharp s -> ss, the Turkish dotted and dotless i -> i; any other non-ASCII character stays (it matches no ASCII name).
 * Real evidence only: a non-ASCII character is never a wildcard. @param {string} n
 */
export function foldName(n) {
  const t = n.replace(IGNORABLE_RE, '').replace(/[ßẞ]/g, 'ss').replace(/[İı]/g, 'i').normalize('NFKD').replace(IGNORABLE_RE, '');
  return asciiLower(t);
}

/** Could the tracked name component CAND resolve to the ASCII name REF on a file system that folds names (and is it not REF itself)? @param {string} cand @param {string} ref */
export function couldAlias(cand, ref) { return foldName(cand) === asciiLower(ref); }

/** An NTFS 8.3 short name (`AGENTS~1`, `SCRIPT~1`, `GITHOO~1`, `ECOSYS~1.MJS`): `<=6 characters ~ digits`, optional three-character extension. */
const SHORT_NAME_RE = /^[^.~\s]{1,6}~\d+(\.[^.\s]{0,3})?$/;
/** Does the component look like the 8.3 short name of an entry whose long name starts with one of PREFIXES (dots removed, lower case)? @param {string} c @param {string[]} [prefixes] omitted: any short name */
export function shortNameOf(c, prefixes) {
  if (!SHORT_NAME_RE.test(c)) return false;
  if (prefixes === undefined) return true;
  const base = foldName(c.slice(0, c.indexOf('~')));
  return prefixes.some((p) => p.startsWith(base));
}

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
  // a case-insensitive checkout (macOS, Windows: core.ignorecase=true) lets `.agents/Scripts/x` stand in for a shipped `.agents/scripts/x`, and APFS also folds Unicode (`.agents/ſcripts/x`
  // opens as `.agents/scripts/x`); git's pathspecs know neither. So with folding on nothing is selected by pathspec: the whole index and the whole HEAD tree are listed, and every tracked
  // name that COULD resolve to a code path without being that exact path is a problem (couldAlias: all shipped paths are ASCII, no table of folds is needed).
  const fold = git(['config', '--type=bool', '--get', 'core.ignorecase']).stdout.toString('utf8').trim() === 'true';
  const shippedKeys = [...shipped.keys()];
  // NTFS gives folders 8.3 short names (`.agents` -> `AGENTS~1`) that a checkout resolves; true on Windows and on any checkout that folds names
  const foldShort = fold || process.platform === 'win32';
  const codeNames = CODE_NAMES.map((n) => n.replace(/\./g, ''));
  /** @param {string} rel the tracked path */
  const aliased = (rel) => {
    const parts = rel.split('/');
    const first = /** @type {string} */ (parts[0]);
    // evidence is a name that equals `.agents` after folding (case, compatibility forms, ignorable characters) or an 8.3 short name that starts like it; a name with unrelated non-ASCII letters is no alias
    if (first !== '.agents') {
      // an alias of the folder itself: whatever sits below it is written inside the real `.agents`
      return couldAlias(first, '.agents') || (foldShort && shortNameOf(first, ['agents']));
    }
    if (parts.length === 1) return false;
    const second = /** @type {string} */ (parts[1]);
    if (!CODE_NAMES.includes(second)) return CODE_NAMES.some((n) => couldAlias(second, n)) || (foldShort && shortNameOf(second, codeNames));
    // below a code folder: a short-name component at any depth (an 8.3 name of a folder lands in it), or the whole path equal to a shipped one after folding
    if (foldShort && parts.slice(2).some((c) => shortNameOf(c))) return true;
    if (shipped.has(rel)) return false;
    return shippedKeys.some((k) => { const kp = k.split('/'); return kp.length === parts.length && kp.every((c, i) => couldAlias(/** @type {string} */ (parts[i]), c)); });
  };
  /** @param {string} rel */
  const inCode = (rel) => CODE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
  const ls = git(fold ? ['ls-files', '-s', '-z'] : ['ls-files', '-s', '-z', '--', ...CODE_DIRS]);
  if (ls.status === 0) for (const rec of ls.stdout.toString('latin1').split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t([\s\S]*)$/.exec(rec); if (m) tracked.push(['index', m[1], `${m[2]}\t${m[3]}`]);
  }
  // ls-tree takes no case-folded pathspec: with a folding checkout the whole tree is listed and judged here
  const lt = git(fold ? ['ls-tree', '-r', '-z', 'HEAD'] : ['ls-tree', '-r', '-z', 'HEAD', '--', ...CODE_DIRS]);
  if (lt.status === 0) for (const rec of lt.stdout.toString('latin1').split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/.exec(rec); if (m) tracked.push(['head', m[1], `${m[2]}\t${m[3]}`]);
  }
  for (const [where, mode, rest] of tracked) {
    const tab = rest.indexOf('\t'); const blob = rest.slice(0, tab); const rel = Buffer.from(rest.slice(tab + 1), 'latin1').toString('utf8');
    if (fold && !shipped.has(rel)) {
      if (aliased(rel)) { if (!problems.some((p) => p.rel === rel && p.kind === 'extra')) problems.push({ rel, kind: 'extra', alias: true }); continue; }
      if (!inCode(rel)) continue;
    }
    const src = shipped.get(rel);
    if (src === undefined) {
      // a TRACKED file that proofline does not ship is as untrusted as one on disk: deleting it from the working tree does not remove it from the index or HEAD (`git restore` brings it back)
      if (EXTRA_DIRS.some((d) => rel.startsWith(d)) && !problems.some((p) => p.rel === rel && p.kind === 'extra')) problems.push({ rel, kind: 'extra' });
      continue;
    }
    let want = bytes.get(src); if (want === undefined) { want = readFileSync(src); bytes.set(src, want); }
    // an LF-or-CRLF blob of an EOL-tolerant file is proofline's copy
    const okBlob = blob === blobId(want) || (eolTolerant(rel) && blob === blobId(crlf(want)));
    if (mode === '120000' || !okBlob) {
      if (!problems.some((p) => p.rel === rel && p.kind === where)) problems.push(mode === '120000' ? { rel, kind: /** @type {'index' | 'head'} */ (where), symlink: true } : { rel, kind: /** @type {'index' | 'head'} */ (where) });
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
    case 'extra': if (p.alias === true && p.rel.split('/').some((c) => shortNameOf(c))) return `${r} looks like an NTFS 8.3 short name; rename it (for example notes-1.md) and run proofline init`;
      return p.alias === true ? `${r} is a tracked name that a case-insensitive or Unicode-folding file system can resolve to a file proofline ships, so a checkout, restore or reset could write it there` : `${r} is not a file proofline ships (git may run it)`;
    case 'index': return `${r} is staged with content that is not proofline's copy`;
    default: return `${r} is committed (HEAD) with content that is not proofline's copy, so a checkout, restore or reset would bring it back`;
  }
}
