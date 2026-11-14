// @ts-check
// The scan for real waits and direct clock reads in test code (issue 265 package C, A276; AC-6). It reports CANDIDATES, never verdicts: a `sleep` inside a string or a comment
// is a false positive, so the reviewer traces each one (shared rule 1) and a candidate that cannot be traced stays a finding (safe side).
// Shared rule 3: no ecosystem name is read here. Everything an ecosystem contributes is data of ecosystems.json `fast_tests` (`files` globs, `sleep` names, `clock_reads`
// names); adding an ecosystem adds data only. A name becomes a word-bounded pattern; a file is scanned with the lists of the ecosystems whose `files` globs match it.
// The functions take their input as parameters (rows, text, a read function): the unit tests run no file system and no clock. Output is deterministic: candidates are sorted by
// file, line, kind, pattern, and the JSON has a fixed key order.
//
// Allowlist (for a scan over a whole directory, issue 266): a UTF-8 text file, one entry per line, `#` starts a comment line, blank lines are ignored:
//     <path glob><TAB><pattern><TAB><reason>
// path glob: `*` matches any characters including `/`, `?` one character, `**` is the same as `*`; the path is relative to the scan root. pattern: a name from the ecosystem
// data (for example the sleep call) or `*` for any pattern in the matched files. reason: free text of at least 10 characters after trimming; an entry without a written reason
// is an error (status 2), never silently accepted. A listed candidate is NOT hidden: it moves to `allowed` with its reason, and an entry that matched nothing is reported as
// `unused` (a stale entry), so the list cannot rot. The line number is not part of an entry (lines move); the path and the pattern are.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { clean } from './codetrust.mjs';

export const KINDS = ['wait', 'clock_read'];
const MIN_REASON = 10;
const MAX_FILE_BYTES = 1048576;

/**
 * @typedef {{ id: string, files: string[], wait: string[], clock_read: string[], markers: string[] }} Rule
 * @typedef {{ file: string, line: number, kind: string, pattern: string, source: string, text: string }} Candidate
 * @typedef {{ glob: string, pattern: string, reason: string, line: number }} AllowEntry
 */

/**
 * The scan rules of the flat rows `[id, path, value]` of the ecosystem definition: one rule per ecosystem that carries `fast_tests`. Sorted by id.
 * @param {string[][] | null} rows @returns {Rule[]}
 */
export function scanRules(rows) {
  /** @type {Map<string, Rule>} */ const by = new Map();
  for (const [id, p, v] of rows ?? []) {
    if (id === '*') continue;
    const k = p === 'fast_tests.files' ? 'files' : p === 'fast_tests.sleep' ? 'wait' : p === 'fast_tests.clock_reads' ? 'clock_read' : p === 'fast_tests.test_markers' ? 'markers' : '';
    if (k === '') continue;
    const r = by.get(id) ?? { id, files: [], wait: [], clock_read: [], markers: [] };
    if (!r[k].includes(v)) r[k].push(v);   // the rows may hold several copies of the definition (the shipped one and the project's): a union, so a project can add and never remove
    by.set(id, r);
  }
  return [...by.values()].filter((r) => r.files.length > 0).sort((a, b) => cmp(a.id, b.id));
}

/** The path globs that mark a test file (`test_paths` of the global part of the definition). @param {string[][] | null} rows */
export function testPathGlobs(rows) { return [...new Set((rows ?? []).filter((r) => r[0] === '*' && r[1] === 'test_paths').map((r) => r[2]))]; }

/**
 * Is this file a test? By its path (a test folder or name from the data) or by a test marker of the ecosystems that claim it found in its text: a file is judged by what it
 * holds as well as by its name, so a name such as `lock.test.js` or `sleep.config.test.js` cannot hide a wait (fail safe). A marker that is not a regular expression is skipped.
 * @param {string} file @param {string} text @param {Rule[]} rules @param {string[]} testGlobs
 */
export function isTestFile(file, text, rules, testGlobs) {
  if (testGlobs.some((g) => globRe(g).test(file))) return true;
  for (const r of claimedBy(file, rules)) for (const m of r.markers) { let re; try { re = new RegExp(m, 'm'); } catch { continue; } if (re.test(text)) return true; }
  return false;
}

/** @param {string} a @param {string} b */
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The word-bounded pattern of a name: a space in the name matches any run of blanks; a boundary is added on a side that starts or ends with a word character. @param {string} name */
export function patternFor(name) {
  const body = escapeRe(name).replace(/ +/g, '\\s+');
  return new RegExp(`${/^\w/.test(name) ? '\\b' : ''}${body}${/\w$/.test(name) ? '\\b' : ''}`);
}

/** A glob as a regular expression: `*` (and `**`) any characters, `?` one character. @param {string} glob */
export function globRe(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[^]*').replace(/\?/g, '[^]')}$`);
}

/** Does any ecosystem's `files` glob match this path? @param {string} file @param {Rule[]} rules */
export function claimedBy(file, rules) { return rules.filter((r) => r.files.some((g) => globRe(g).test(file))); }

/**
 * The candidates of one file's text. The lists used are those of every rule whose `files` globs match the path. One entry per (line, kind, pattern).
 * @param {string} file relative path @param {string} text @param {Rule[]} rules @param {string[]} [kinds] @returns {Candidate[]}
 */
export function scanText(file, text, rules, kinds = KINDS) {
  const claim = claimedBy(file, rules);
  if (claim.length === 0) return [];
  /** @type {Array<{ kind: string, pattern: string, source: string, re: RegExp }>} */ const pats = [];
  for (const r of claim) for (const kind of KINDS) if (kinds.includes(kind)) for (const name of r[/** @type {'wait' | 'clock_read'} */ (kind)]) pats.push({ kind, pattern: name, source: r.id, re: patternFor(name) });
  /** @type {Map<string, Candidate>} */ const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');   // a line of any length is scanned in full: every pattern is a literal with blanks, so matching is linear
    for (const p of pats) {
      const m = p.re.exec(l);
      if (!m) continue;
      const key = `${i + 1}\0${p.kind}\0${p.pattern}`;
      if (!out.has(key)) out.set(key, { file, line: i + 1, kind: p.kind, pattern: p.pattern, source: p.source, text: l.slice(Math.max(0, m.index - 60), m.index + 100).trim() });
    }
  }
  return sortCandidates([...out.values()]);
}

/** @param {Candidate[]} list */
export function sortCandidates(list) {
  return list.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.kind, b.kind) || cmp(a.pattern, b.pattern));
}

// ---- the allowlist ----------------------------------------------------------------------------------------------------------------

/** @param {string} text @returns {{ entries: AllowEntry[], errors: string[] }} */
export function parseAllowlist(text) {
  /** @type {AllowEntry[]} */ const entries = []; /** @type {string[]} */ const errors = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/\r$/, '');
    if (l.trim() === '' || l.trimStart().startsWith('#')) return;
    const f = l.split('\t');
    if (f.length !== 3) { errors.push(`allowlist line ${i + 1}: expected "<path glob><TAB><pattern><TAB><reason>", got ${f.length} field(s)`); return; }
    const [glob, pattern, reason] = f.map((x) => x.trim());
    if (glob === '' || pattern === '') { errors.push(`allowlist line ${i + 1}: the path glob and the pattern may not be empty`); return; }
    if (reason.length < MIN_REASON) { errors.push(`allowlist line ${i + 1}: ${glob} ${pattern} has no written reason (at least ${MIN_REASON} characters)`); return; }
    entries.push({ glob, pattern, reason, line: i + 1 });
  });
  return { entries, errors };
}

/**
 * Candidates covered by an entry move to `allowed` (with the reason); the others stay `open`. An entry that covered nothing is `unused`, judged only for the kinds that were
 * scanned: an entry whose pattern is a name of the other kind is not stale just because that kind was not looked for (`*` entries always count).
 * @param {Candidate[]} cands @param {AllowEntry[]} entries @param {{ kinds?: string[], rules?: Rule[] }} [o]
 * @returns {{ open: Candidate[], allowed: Array<Candidate & { reason: string }>, unused: AllowEntry[] }}
 */
export function applyAllowlist(cands, entries, o = {}) {
  const res = entries.map((e) => ({ e, re: globRe(e.glob), hits: 0 }));
  /** @type {Candidate[]} */ const open = []; /** @type {Array<Candidate & { reason: string }>} */ const allowed = [];
  for (const c of cands) {
    const hit = res.find((r) => r.re.test(c.file) && (r.e.pattern === '*' || r.e.pattern === c.pattern));
    if (hit) { hit.hits++; allowed.push({ ...c, reason: hit.e.reason }); } else open.push(c);
  }
  const kinds = o.kinds ?? KINDS;
  /** @param {string} pattern */
  const inScope = (pattern) => pattern === '*' || !o.rules || o.rules.some((r) => KINDS.some((k) => kinds.includes(k) && r[/** @type {'wait' | 'clock_read'} */ (k)].includes(pattern)));
  return { open, allowed, unused: res.filter((r) => r.hits === 0 && inScope(r.e.pattern)).map((r) => r.e) };
}

// ---- the file system edge -----------------------------------------------------------------------------------------------------------

/**
 * The files under the given paths (a file is itself, a directory is walked, sorted), relative to `root`, with the pruned folder names left out and symbolic links
 * skipped. A path outside the root is an error.
 * @param {string} root @param {string[]} targets @param {Set<string>} prune @returns {{ files: string[], errors: string[] }}
 */
export function listFiles(root, targets, prune) {
  /** @type {Set<string>} */ const files = new Set(); /** @type {string[]} */ const errors = [];
  let rr; try { rr = realpathSync(root); } catch { return { files: [], errors: [`no such directory: ${root}`] }; }
  /** @param {string} abs */
  const walk = (abs) => {
    let st; try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) { files.add(path.relative(rr, abs).split(path.sep).join('/')); return; }
    if (!st.isDirectory()) return;
    /** @type {string[]} */ let names = [];
    try { names = readdirSync(abs).sort(cmp); } catch { return; }
    for (const n of names) if (!prune.has(n)) walk(path.join(abs, n));
  };
  for (const t of targets) {
    const abs = path.resolve(rr, t);
    let real; try { real = realpathSync(abs); } catch { errors.push(`no such file or directory: ${t}`); continue; }
    if (real !== rr && !real.startsWith(rr + path.sep)) { errors.push(`outside the scan root: ${t}`); continue; }
    walk(abs);
  }
  return { files: [...files].sort(cmp), errors };
}

/** The pruned folder names of the definition rows (`prune` of the global part and of every ecosystem). @param {string[][] | null} rows */
export function pruneNames(rows) { return new Set((rows ?? []).filter((r) => r[1] === 'prune').map((r) => r[2])); }

/**
 * Scan files of a root. `kindsOf(file)` says which kinds to look for in each file (default all); a file that no ecosystem claims, is too large or unreadable is
 * skipped and counted. @param {string} root @param {string[]} files @param {Rule[]} rules @param {(file: string, text: string) => string[]} [kindsOf]
 * @returns {{ scanned: string[], skipped: string[], candidates: Candidate[] }}
 */
export function scanFiles(root, files, rules, kindsOf = () => KINDS) {
  /** @type {string[]} */ const scanned = []; /** @type {string[]} */ const skipped = []; /** @type {Candidate[]} */ const candidates = [];
  for (const f of files) {
    if (claimedBy(f, rules).length === 0) continue;
    let text;
    try { const abs = path.join(root, f); const st = lstatSync(abs); if (!st.isFile() || st.size > MAX_FILE_BYTES) { skipped.push(f); continue; } text = readFileSync(abs, 'utf8'); } catch { skipped.push(f); continue; }
    scanned.push(f);
    candidates.push(...scanText(f, text, rules, kindsOf(f, text)));
  }
  return { scanned, skipped, candidates: sortCandidates(candidates) };
}

// ---- the report ----------------------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ scanned: string[], skipped: string[], candidates: Candidate[], allowed: Array<Candidate & { reason: string }>, unused: AllowEntry[] }} Report
 */

/** Fixed key order, so equal reports are equal bytes. Every string that came from the repository (a path, a line, a reason) is cleaned of control and direction characters, so a file name or a line cannot forge a line of the report. @param {Report} r */
export function reportJson(r) {
  const c = (/** @type {Candidate} */ x) => ({ file: clean(x.file), line: x.line, kind: x.kind, pattern: clean(x.pattern), source: x.source, text: clean(x.text) });
  return `${JSON.stringify({
    version: 1,
    summary: { files: r.scanned.length, candidates: r.candidates.length, allowed: r.allowed.length, unused_allowlist_entries: r.unused.length, skipped: r.skipped.length },
    candidates: r.candidates.map(c),
    allowed: r.allowed.map((x) => ({ ...c(x), reason: clean(x.reason) })),
    unused_allowlist_entries: r.unused.map((e) => ({ line: e.line, path: clean(e.glob), pattern: clean(e.pattern), reason: clean(e.reason) })),
    skipped: r.skipped.map(clean),
  }, null, 2)}\n`;
}

/** @param {Report} r */
export function reportText(r) {
  let t = `test-scan: ${r.candidates.length} candidate(s) in ${r.scanned.length} scanned file(s)${r.allowed.length > 0 ? `, ${r.allowed.length} allowed` : ''}${r.skipped.length > 0 ? `, ${r.skipped.length} NOT SCANNED` : ''}\n`;
  t += 'a candidate is a text match, not a verdict: a name inside a string or a comment is a false positive; trace the path before you call it a finding\n';
  for (const c of r.candidates) t += `candidate: ${clean(c.file)}:${c.line} ${c.kind} ${clean(c.pattern)} | ${clean(c.text)}\n`;
  for (const c of r.allowed) t += `allowed: ${clean(c.file)}:${c.line} ${c.kind} ${clean(c.pattern)} (${clean(c.reason)})\n`;
  for (const e of r.unused) t += `unused-allowlist-entry: line ${e.line}: ${clean(e.glob)} ${clean(e.pattern)} matched nothing\n`;
  for (const f of r.skipped) t += `NOT SCANNED: ${clean(f)} (unreadable, not a regular file or over ${MAX_FILE_BYTES} bytes); a file nobody scanned is not a clean file\n`;
  return t;
}
