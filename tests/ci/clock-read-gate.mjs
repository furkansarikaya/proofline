// @ts-check
// The clock-read gate (issue 266 package 3c): proofline's own tests must not read the clock directly (the wall clock, the monotonic clock, hrtime); time is injected or faked.
// The finder is `proofline-core cli test-scan --kind clock_read` (the fast_tests data of ecosystems.json). This gate adds two rules on top of its output:
//   1. NEW OR CHANGED code is blocking: a clock read on a line that the change adds (a new file is all added lines) fails, naming file:line and the injected-clock alternative.
//      The change is `git diff` against the merge base of --base (default $BASE_SHA, else origin/main when it exists); with no base the check is skipped and says so.
//   2. THE BASELINE tests/ci/clock-read-baseline.tsv (`<file><TAB><count>`, sorted, unique) lists the reads that exist today, per file. It is a RATCHET: a count above its
//      baseline fails, a file that is not listed and has a read fails, and a count below its baseline fails with "lower the baseline", so the list only shrinks.
//   node tests/ci/clock-read-gate.mjs [--base REF] [--update]    (--update rewrites the baseline from the scan: only after a read was removed)
// Spellings: the finder matches the plain names (the data of ecosystems.json); this gate adds, for JavaScript and TypeScript files, the bigint form of the high-resolution
// timer, the argument-less date constructor in any spacing, bracket access on the date or performance object, and a destructured or aliased clock (see EXTRA below).
// KNOWN GAPS (a reviewer must still look): an alias built at run time (a name assembled from pieces, globalThis lookups), Reflect.apply or call/bind on a clock function,
// dynamic property access, a clock read inside a helper that lives outside tests/, and every language but JavaScript and TypeScript for the extra spellings.
// The names of the clock reads are assembled in this file, not written out, so that the gate is not a candidate of the scan it applies. All decisions are pure functions of
// their input (the scan output, the baseline text, a diff text); main() takes the scan and the git call as parameters, so the tests run no scan and no git.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASELINE_FILE = 'tests/ci/clock-read-baseline.tsv';
const HEADER = [
  '# Baseline of the clock-read gate (issue 266 package 3c): the direct clock reads that proofline\'s own tests still hold, one line per file: <file><TAB><count>.',
  '# A RATCHET, enforced by tests/ci/clock-read-gate.test.mjs and the CI step "clock-read gate": a count above its line, a file that is not listed and has a read, and a',
  '# count below its line (lower the baseline) all fail, so the list only shrinks. Regenerate after removing reads: node tests/ci/clock-read-gate.mjs --update',
  '# Sorted by file (byte order), unique. A new test must inject its clock (see tests/core/fake-time.mjs and tests/core/held-clock.mjs); this list is never extended by hand.',
];

/** @typedef {{ file: string, line: number, pattern: string }} Read */

/** The help every message ends with. */
export const ALTERNATIVE = 'inject the clock instead: pass a now() function or a fake clock (tests/core/fake-time.mjs, tests/core/held-clock.mjs, mock.timers) and assert on its value, never on the real elapsed time';

/** @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {string} text
 * @returns {{ counts: Map<string, number>, errors: string[] }}
 */
export function parseBaseline(text) {
  /** @type {Map<string, number>} */ const counts = new Map(); /** @type {string[]} */ const errors = [];
  /** @type {string | null} */ let last = null;
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/\r$/, '');
    if (l === '' || l.startsWith('#')) return;
    const f = l.split('\t');
    if (f.length !== 2 || f[0] === '' || !/^[1-9][0-9]*$/.test(f[1])) { errors.push(`${BASELINE_FILE} line ${i + 1}: expected "<file><TAB><positive count>"`); return; }
    if (counts.has(f[0])) errors.push(`${BASELINE_FILE} line ${i + 1}: ${f[0]} is listed twice`);
    if (last !== null && cmp(last, f[0]) >= 0 && !counts.has(f[0])) errors.push(`${BASELINE_FILE} line ${i + 1}: ${f[0]} is out of order (sorted by file, byte order)`);
    last = f[0];
    counts.set(f[0], Number(f[1]));
  });
  return { counts, errors };
}

/** The deterministic text of a baseline. @param {Map<string, number>} counts */
export function formatBaseline(counts) {
  return `${HEADER.join('\n')}\n${[...counts].filter(([, n]) => n > 0).sort((a, b) => cmp(a[0], b[0])).map(([f, n]) => `${f}\t${n}\n`).join('')}`;
}

/** @param {Read[]} reads @returns {Map<string, number>} */
export function countByFile(reads) {
  /** @type {Map<string, number>} */ const m = new Map();
  for (const r of reads) m.set(r.file, (m.get(r.file) ?? 0) + 1);
  return m;
}

/**
 * The added lines of a `git diff --unified=0` text, per file.
 * @param {string} diff @returns {Map<string, Set<number>>}
 */
export function addedLines(diff) {
  /** @type {Map<string, Set<number>>} */ const out = new Map();
  /** @type {string | null} */ let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.replace(/^\+\+\+ (b\/)?/, '').replace(/\t.*$/, ''); continue; }
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file !== null) {
      const start = Number(m[1]); const n = m[2] === undefined ? 1 : Number(m[2]);
      const set = out.get(file) ?? new Set();
      for (let i = 0; i < n; i++) set.add(start + i);
      out.set(file, set);
    }
  }
  return out;
}

/**
 * The verdict. `added` is null when no change could be computed (the changed-line rule is then not applied).
 * @param {Read[]} reads @param {Map<string, number>} baseline @param {Map<string, Set<number>> | null} added
 * @returns {string[]} the problems, sorted; empty when the gate passes
 */
export function judge(reads, baseline, added) {
  /** @type {string[]} */ const problems = [];
  const counts = countByFile(reads);
  const sorted = [...reads].sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.pattern, b.pattern));
  const flagged = new Set();
  const flag = (/** @type {Read} */ r, /** @type {string} */ why) => {
    const key = `${r.file}:${r.line}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    problems.push(`${key}: direct clock read (${r.pattern}) ${why}; ${ALTERNATIVE}`);
  };
  for (const r of sorted) {
    if (!baseline.has(r.file)) flag(r, 'in a test file that is not in the baseline (a new file must read no clock)');
    else if (added?.get(r.file)?.has(r.line)) flag(r, 'on a line this change adds or changes');
  }
  for (const [file, n] of [...counts].sort((a, b) => cmp(a[0], b[0]))) {
    const base = baseline.get(file);
    if (base !== undefined && n > base) {
      problems.push(`${file}: ${n} direct clock reads, baseline ${base} (${BASELINE_FILE}); remove the ${n - base} new one(s): ${ALTERNATIVE}`);
      for (const r of sorted) if (r.file === file) flag(r, `(one of ${n}, the baseline allows ${base})`);
    }
  }
  for (const [file, base] of [...baseline].sort((a, b) => cmp(a[0], b[0]))) {
    const n = counts.get(file) ?? 0;
    if (n < base) problems.push(`${file}: ${n} direct clock reads, baseline ${base}: lower the baseline (node tests/ci/clock-read-gate.mjs --update) so that it can never grow back`);
  }
  return problems.sort();
}

/** Extra spellings (see the header). Each is a regular expression over one line; the label is what the message shows. */
const EXTRA = /** @type {Array<[string, RegExp]>} */ ([
  ['bigint hrtime', /\bhrtime\s*\.\s*bigint\b/],
  ['argument-less date constructor', /\bnew\s+Date\b(?!\s*\(\s*[^\s)])/],
  ['bracket access', /\b(?:Date|performance)\s*\[/],
  ['destructured clock', /\{[^}]*\b(?:now|hrtime)\b[^}]*\}\s*=\s*(?:Date|performance|process)\b/],
  ['aliased clock', /=\s*(?:Date|performance)\s*(?:[;,)]|$)/],
]);

/**
 * The extra spellings in the lines of one text; a line the finder already reported is skipped.
 * @param {string} file @param {string} text @param {Set<string>} seen file:line keys of the finder @returns {Read[]}
 */
export function extraReads(file, text, seen) {
  /** @type {Read[]} */ const out = [];
  text.split('\n').forEach((l, i) => {
    if (seen.has(`${file}:${i + 1}`)) return;
    const hit = EXTRA.find(([, re]) => re.test(l));
    if (hit) out.push({ file, line: i + 1, pattern: hit[0] });
  });
  return out;
}

/** @param {string} root @param {string} dir @param {string[]} out */
function walkScripts(root, dir, out) {
  let names; try { names = readdirSync(path.join(root, dir)).sort(cmp); } catch { return; }
  for (const n of names) {
    if (n === 'node_modules') continue;
    const rel = `${dir}/${n}`; let st; try { st = lstatSync(path.join(root, rel)); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkScripts(root, rel, out); else if (/\.(?:[mc]?[jt]s|[jt]sx)$/.test(n)) out.push(rel);
  }
}

/**
 * The scan of the repository: the candidates of `test-scan --kind clock_read tests`.
 * @param {string} root @returns {Read[]}
 */
export function scanRepo(root) {
  const core = path.join(root, 'control-plane/agents/scripts/proofline-core.mjs');
  let out;
  try { out = execFileSync(process.execPath, [core, 'cli', 'test-scan', '--kind', 'clock_read', '--json', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch (e) {
    const err = /** @type {{ status?: number, stdout?: string }} */ (e);
    if (err.status !== 1 || !err.stdout) throw e;   // exit 1 is "candidates found"
    out = err.stdout;
  }
  const j = JSON.parse(out);
  if (j.summary.skipped > 0) throw new Error(`clock-read gate: ${j.summary.skipped} file(s) could not be scanned; a file nobody scanned is not a clean file`);
  /** @type {Read[]} */ const reads = j.candidates.map((/** @type {{ file: string, line: number, pattern: string }} */ c) => ({ file: c.file, line: c.line, pattern: c.pattern }));
  const seen = new Set(reads.map((r) => `${r.file}:${r.line}`));
  /** @type {string[]} */ const files = []; walkScripts(root, 'tests', files);
  for (const f of files) { let t; try { t = readFileSync(path.join(root, f), 'utf8'); } catch { continue; } reads.push(...extraReads(f, t, seen)); }
  return reads;
}

/** The accepted spellings of a base: a commit id, or a ref name (no leading dash, no `..`, no `@{`, no blank). @param {string} base */
export function validBase(base) {
  return /^[0-9a-fA-F]{7,64}$/.test(base) || (/^(?!-)[A-Za-z0-9._/-]+$/.test(base) && !base.includes('..'));
}

/** @param {string} root @returns {(args: string[]) => string} */
const gitIn = (root) => (a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The merge base commit of `base` and HEAD. A base that is not a valid spelling, or does not name a commit, is an ERROR (never used as it is, never skipped).
 * @param {string} base @param {(args: string[]) => string} git @returns {string}
 */
export function resolveBase(base, git) {
  if (!validBase(base)) throw new Error(`clock-read gate: the base ${JSON.stringify(base)} is refused (a commit id of 7 to 64 hex digits, or a ref name without a leading dash, "..", "@{" or blanks)`);
  let sha;
  try { sha = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim(); } catch { throw new Error(`clock-read gate: the base ${base} is not a commit in this checkout (a shallow clone? fetch the base first)`); }
  try { return git(['merge-base', '--end-of-options', sha, 'HEAD']).trim() || sha; } catch { throw new Error(`clock-read gate: no merge base between ${base} and HEAD (a shallow clone? fetch the history)`); }
}

/**
 * The changed lines of tests/ against the merge base of `base`, or null when there is no base. The working tree counts (uncommitted changes), so the gate also runs before a commit.
 * @param {string} root @param {string | null} base @param {(args: string[]) => string} [git] @returns {Map<string, Set<number>> | null}
 */
export function changedLines(root, base, git = gitIn(root)) {
  if (!base) return null;
  const from = resolveBase(base, git);
  return addedLines(git(['diff', '--unified=0', '--no-color', '--no-renames', '--end-of-options', from, '--', 'tests']));
}

/**
 * @param {string[]} argv @param {{ root?: string, env?: NodeJS.ProcessEnv, scan?: (root: string) => Read[], diff?: (root: string, base: string | null) => Map<string, Set<number>> | null, read?: (f: string) => string, write?: (f: string, t: string) => void, out?: (s: string) => void, err?: (s: string) => void, hasRef?: (ref: string) => boolean }} [io]
 * @returns {number} 0 passes, 1 problems, 2 usage or an unusable base
 */
export function main(argv, io = {}) {
  const root = io.root ?? path.resolve(import.meta.dirname, '../..');
  const env = io.env ?? process.env;
  const out = io.out ?? ((s) => process.stdout.write(s)); const err = io.err ?? ((s) => process.stderr.write(s));
  const read = io.read ?? ((f) => readFileSync(path.join(root, f), 'utf8'));
  const write = io.write ?? ((f, t) => writeFileSync(path.join(root, f), t));
  const hasRef = io.hasRef ?? ((ref) => { try { execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', ref], { stdio: 'ignore' }); return true; } catch { return false; } });
  let base = env.BASE_SHA || null; let update = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--update') update = true;
    else if (argv[i] === '--base' || argv[i].startsWith('--base=')) { base = argv[i] === '--base' ? (argv[++i] ?? '') : argv[i].slice(7); if (base === '') { err('clock-read gate: --base needs a ref\n'); return 2; } } else { err(`clock-read gate: unknown argument ${argv[i]} (usage: [--base REF] [--update])\n`); return 2; }
  }
  const reads = (io.scan ?? scanRepo)(root);
  if (update) {
    write(BASELINE_FILE, formatBaseline(countByFile(reads)));
    out(`clock-read gate: wrote ${BASELINE_FILE} (${reads.length} read(s) in ${countByFile(reads).size} file(s))\n`);
    return 0;
  }
  const parsed = parseBaseline(read(BASELINE_FILE));
  if (parsed.errors.length > 0) { err(`${parsed.errors.join('\n')}\n`); return 1; }
  if (!base && env.GITHUB_EVENT_NAME === 'pull_request') { err('clock-read gate: a pull request run has no base (BASE_SHA is empty); the changed-line rule must not be skipped\n'); return 2; }
  if (!base && hasRef('origin/main')) base = 'origin/main';
  /** @type {Map<string, Set<number>> | null} */ let added;
  try { added = (io.diff ?? changedLines)(root, base); } catch (e) { err(`${/** @type {Error} */ (e).message}\n`); return 2; }
  const problems = judge(reads, parsed.counts, added);
  if (problems.length > 0) { err(`clock-read gate: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}\n`); return 1; }
  out(`clock-read gate: ${reads.length} baselined read(s) in ${countByFile(reads).size} file(s), none above its baseline, none below it; ${added === null ? 'no base ref, changed-line rule skipped' : 'no read on a changed line'}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
