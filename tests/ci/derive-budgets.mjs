// @ts-check
// Issue 266 package 3b (A277): derive the per-file budgets of tests/ci/test-budgets.json from the duration reports of CI. Regenerate after a deliberate change of the suite:
//   gh run download <run id of a green main run> -D samples/<n> -p 'test-durations-*'      (one folder per run; any number of runs, every Node version and leg)
//   node tests/ci/derive-budgets.mjs samples/1 samples/2 > tests/ci/test-budgets.json
// For every test file that appears in the samples it takes the MAXIMUM measured over all samples (the slowest test, and the total of the file) and writes
// `files[<file>] = { test_ms, suite_ms }` = maximum x margin, rounded UP to a clean number: x3 for a test, x2.5 for a suite measured at 20 s or more and x3 for a smaller
// suite (jitter of 3.4x was seen on browser and process tests), never below an ABSOLUTE floor of 2000 ms per test and 10000 ms per suite (not the kind default: a
// 6 s file must not get 120 s). Use every sample you have: the CI run of a pull request, the manual `twice` run (both runs of it count), the latest runs of main.
// `calibration.nominal_ms` = the MEDIAN of the `calibration_ms` of the reports that have one (the runner-speed reference workload of the wrapper, one number per leg), rounded up.
// Everything else of the base budgets file (kinds, dirs, header, enforce) is kept; files without a sample fall back to the kind of their directory.
// Pure and deterministic: the same samples give the same bytes; it reads no clock and no network (the samples are files).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: derive-budgets.mjs [--base FILE] [--test-margin N] [--suite-margin N] [--small-suite-margin N] SAMPLE_DIR...';
/** The absolute floors (ms) and the size of a "small" suite (ms). */
export const FLOOR = { test_ms: 2000, suite_ms: 10000, small_suite_ms: 20000 };

/** A clean ceiling: a multiple of 500 below 10 s, of 5 s below 100 s, of 10 s above. @param {number} ms */
export function cleanUp(ms) {
  const step = ms < 10000 ? 500 : ms < 100000 ? 5000 : 10000;
  return Math.max(step, Math.ceil(ms / step) * step);
}

/** Every `*.json` below a folder, in path order. @param {string} dir @returns {string[]} */
export function jsonFiles(dir) {
  /** @type {string[]} */ const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p)); else if (n.endsWith('.json')) out.push(p);
  }
  return out;
}

/**
 * The maxima per file over the reports. @param {Array<any>} reports parsed test-durations-<leg>.json documents
 * @returns {Map<string, { test: number, suite: number, testName: string }>}
 */
export function maxima(reports) {
  /** @type {Map<string, { test: number, suite: number, testName: string }>} */ const m = new Map();
  const slot = (/** @type {string} */ f) => { const e = m.get(f) ?? { test: 0, suite: 0, testName: '' }; m.set(f, e); return e; };
  const note = (/** @type {string} */ f, /** @type {string} */ name, /** @type {number} */ ms) => { const e = slot(f); if (ms > e.test) { e.test = ms; e.testName = name; } };
  for (const r of reports) {
    for (const t of r.tests_detail ?? []) if (typeof t.file === 'string' && typeof t.ms === 'number') note(t.file, String(t.name), t.ms);
    for (const t of r.slowest ?? []) if (typeof t.file === 'string' && typeof t.max_ms === 'number') note(t.file, String(t.name), t.max_ms);   // the worst of the runs of a twice report
    for (const f of r.files ?? []) if (typeof f.file === 'string' && typeof f.max_ms === 'number') { const e = slot(f.file); if (f.max_ms > e.suite) e.suite = f.max_ms; }
  }
  return m;
}

/** The median of the numbers, rounded up; null for none. @param {number[]} xs */
export function median(xs) {
  if (xs.length === 0) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return Math.ceil(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

/**
 * The budgets file with the derived `files` rows. @param {any} base @param {Array<any>} reports @param {{ testMargin: number, suiteMargin: number, smallSuiteMargin?: number }} opt
 * @returns {{ budgets: any, rows: Array<{ file: string, test_max: number, test_ms: number, suite_max: number, suite_ms: number, testName: string }> }}
 */
export function derive(base, reports, opt) {
  const { files: _drop, ...rest } = base;
  /** @type {Record<string, { test_ms: number, suite_ms: number }>} */ const files = {};
  /** @type {Array<{ file: string, test_max: number, test_ms: number, suite_max: number, suite_ms: number, testName: string }>} */ const rows = [];
  for (const [file, e] of [...maxima(reports)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const test_ms = Math.max(FLOOR.test_ms, cleanUp(e.test * opt.testMargin));
    const sm = e.suite < FLOOR.small_suite_ms ? opt.smallSuiteMargin ?? opt.testMargin : opt.suiteMargin;
    const suite_ms = Math.max(FLOOR.suite_ms, cleanUp(e.suite * sm));
    rows.push({ file, test_max: e.test, test_ms, suite_max: e.suite, suite_ms, testName: e.testName });
    files[file] = { test_ms, suite_ms };
  }
  const cals = reports.map((r) => r.calibration_ms).filter((x) => typeof x === 'number' && x > 0);
  const nominal = median(cals);
  return { budgets: { ...rest, ...(nominal === null ? {} : { calibration: { nominal_ms: nominal } }), files }, rows };
}

/** @param {string[]} argv @param {{ write?: (s: string) => void, read?: (p: string) => string, list?: (d: string) => string[] }} [io] @returns {number} */
export function main(argv, io = {}) {
  const write = io.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const read = io.read ?? ((/** @type {string} */ p) => readFileSync(p, 'utf8'));
  const list = io.list ?? jsonFiles;
  let base = path.join(import.meta.dirname, 'test-budgets.json');
  let testMargin = 3, suiteMargin = 2.5, smallSuiteMargin = 3;
  /** @type {string[]} */ const dirs = [];
  const num = (/** @type {string | undefined} */ v) => (v !== undefined && /^[0-9]+(\.[0-9]+)?$/.test(v) && Number(v) >= 1 ? Number(v) : NaN);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') base = argv[++i] ?? '';
    else if (a === '--test-margin') testMargin = num(argv[++i]);
    else if (a === '--suite-margin') suiteMargin = num(argv[++i]);
    else if (a === '--small-suite-margin') smallSuiteMargin = num(argv[++i]);
    else if (a.startsWith('-')) { write(`${USAGE}\n`); return 2; } else dirs.push(a);
  }
  if (dirs.length === 0 || !base || Number.isNaN(testMargin) || Number.isNaN(suiteMargin) || Number.isNaN(smallSuiteMargin)) { write(`${USAGE}\n`); return 2; }
  /** @type {any[]} */ const reports = [];
  for (const d of dirs) for (const p of list(d)) { try { reports.push(JSON.parse(read(p))); } catch { write(`derive-budgets: ${p} is not a JSON report\n`); return 2; } }
  if (reports.length === 0) { write('derive-budgets: no report found\n'); return 2; }
  write(`${JSON.stringify(derive(JSON.parse(read(base)), reports, { testMargin, suiteMargin, smallSuiteMargin }).budgets, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
