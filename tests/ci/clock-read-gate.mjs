// @ts-check
// The clock-read gate (issue 266 package 3c): proofline's own tests must not read the clock directly (the wall clock, the monotonic clock, hrtime); time is injected or faked.
// The finder is `proofline-core cli test-scan --kind clock_read` (the fast_tests data of ecosystems.json). This gate adds two rules on top of its output:
//   1. NEW OR CHANGED code is blocking: a clock read on a line that the change adds (a new file is all added lines) fails, naming file:line and the injected-clock alternative.
//      The change is `git diff` against the merge base of --base (default $BASE_SHA, else origin/main when it exists); with no base the check is skipped and says so.
//   2. THE BASELINE tests/ci/clock-read-baseline.tsv (`<file><TAB><count>`, sorted, unique) lists the reads that exist today, per file. It is a RATCHET: a count above its
//      baseline fails, a file that is not listed and has a read fails, and a count below its baseline fails with "lower the baseline", so the list only shrinks.
//   node tests/ci/clock-read-gate.mjs [--base REF] [--update]    (--update rewrites the baseline from the scan: only after a read was removed)
// The names of the clock reads are assembled in this file, not written out, so that the gate is not a candidate of the scan it applies. All decisions are pure functions of
// their input (the scan output, the baseline text, a diff text); main() takes the scan and the git call as parameters, so the tests run no scan and no git.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
  return j.candidates.map((/** @type {{ file: string, line: number, pattern: string }} */ c) => ({ file: c.file, line: c.line, pattern: c.pattern }));
}

/**
 * The changed lines of tests/ against the merge base of `base`, or null when there is no base. The working tree counts (uncommitted changes), so the gate also runs before a commit.
 * @param {string} root @param {string | null} base @param {(args: string[]) => string} [git] @returns {Map<string, Set<number>> | null}
 */
export function changedLines(root, base, git = (a) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', root, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 })) {
  if (!base) return null;
  let from = base;
  try { from = git(['merge-base', base, 'HEAD']).trim() || base; } catch { /* a base that has no merge base is used as it is */ }
  return addedLines(git(['diff', '--unified=0', '--no-color', '--no-renames', from, '--', 'tests']));
}

/**
 * @param {string[]} argv @param {{ root?: string, env?: NodeJS.ProcessEnv, scan?: (root: string) => Read[], diff?: (root: string, base: string | null) => Map<string, Set<number>> | null, read?: (f: string) => string, write?: (f: string, t: string) => void, out?: (s: string) => void, err?: (s: string) => void, hasRef?: (ref: string) => boolean }} [io]
 * @returns {number} 0 passes, 1 problems, 2 usage
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
    else if (argv[i] === '--base') { base = argv[++i] ?? ''; if (base === '') { err('clock-read gate: --base needs a ref\n'); return 2; } } else { err(`clock-read gate: unknown argument ${argv[i]} (usage: [--base REF] [--update])\n`); return 2; }
  }
  const reads = (io.scan ?? scanRepo)(root);
  if (update) {
    write(BASELINE_FILE, formatBaseline(countByFile(reads)));
    out(`clock-read gate: wrote ${BASELINE_FILE} (${reads.length} read(s) in ${countByFile(reads).size} file(s))\n`);
    return 0;
  }
  const parsed = parseBaseline(read(BASELINE_FILE));
  if (parsed.errors.length > 0) { err(`${parsed.errors.join('\n')}\n`); return 1; }
  if (!base && hasRef('origin/main')) base = 'origin/main';
  const added = (io.diff ?? changedLines)(root, base);
  const problems = judge(reads, parsed.counts, added);
  if (problems.length > 0) { err(`clock-read gate: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}\n`); return 1; }
  out(`clock-read gate: ${reads.length} baselined read(s) in ${countByFile(reads).size} file(s), none above its baseline, none below it; ${added === null ? 'no base ref, changed-line rule skipped' : 'no read on a changed line'}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
