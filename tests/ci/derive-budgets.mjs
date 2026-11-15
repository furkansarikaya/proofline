// @ts-check
// Issue 266 package 3b (A277): derive the per-file budgets of tests/ci/test-budgets.json from the duration reports of CI. Regenerate after a deliberate change of the suite:
//   gh run download <run id of a green main run> -D samples/<n> -p 'test-durations-*'      (one folder per run; any number of runs, every Node version and leg)
//   node tests/ci/derive-budgets.mjs samples/1 samples/2 > tests/ci/test-budgets.json
// For every test file it takes the MAXIMUM measured over all samples (the slowest test, and the total of the file) and writes `files[<file>] = { test_ms, suite_ms }`
// = maximum x margin (default 2 for a test, 1.7 for a suite), rounded UP to a clean number, never below the kind default (A275) of the directory the file is in. A file whose
// derived numbers do not exceed its kind default gets no row (the kind decides). Everything else of the base budgets file (kinds, dirs, header, enforce) is kept.
// Pure and deterministic: the same samples give the same bytes; it reads no clock and no network (the samples are files).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { budgetOf } from './test-durations-ci.mjs';

const USAGE = 'usage: derive-budgets.mjs [--base FILE] [--test-margin N] [--suite-margin N] SAMPLE_DIR...';

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

/**
 * The budgets file with the derived `files` rows. @param {any} base @param {Array<any>} reports @param {{ testMargin: number, suiteMargin: number }} opt
 * @returns {{ budgets: any, rows: Array<{ file: string, test_max: number, test_ms: number, suite_max: number, suite_ms: number, testName: string }> }}
 */
export function derive(base, reports, opt) {
  const { files: _drop, ...rest } = base;
  const kindOnly = { ...rest, timeouts_scale: 1 };
  /** @type {Record<string, { test_ms: number, suite_ms: number }>} */ const files = {};
  /** @type {Array<{ file: string, test_max: number, test_ms: number, suite_max: number, suite_ms: number, testName: string }>} */ const rows = [];
  for (const [file, e] of [...maxima(reports)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const floor = budgetOf(kindOnly, file);
    const test_ms = Math.max(floor.test, cleanUp(e.test * opt.testMargin));
    const suite_ms = Math.max(floor.suite, cleanUp(e.suite * opt.suiteMargin));
    rows.push({ file, test_max: e.test, test_ms, suite_max: e.suite, suite_ms, testName: e.testName });
    if (test_ms > floor.test || suite_ms > floor.suite) files[file] = { test_ms, suite_ms };
  }
  return { budgets: { ...rest, files }, rows };
}

/** @param {string[]} argv @param {{ write?: (s: string) => void, read?: (p: string) => string, list?: (d: string) => string[] }} [io] @returns {number} */
export function main(argv, io = {}) {
  const write = io.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const read = io.read ?? ((/** @type {string} */ p) => readFileSync(p, 'utf8'));
  const list = io.list ?? jsonFiles;
  let base = path.join(import.meta.dirname, 'test-budgets.json');
  let testMargin = 2, suiteMargin = 1.7;
  /** @type {string[]} */ const dirs = [];
  const num = (/** @type {string | undefined} */ v) => (v !== undefined && /^[0-9]+(\.[0-9]+)?$/.test(v) && Number(v) >= 1 ? Number(v) : NaN);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') base = argv[++i] ?? '';
    else if (a === '--test-margin') testMargin = num(argv[++i]);
    else if (a === '--suite-margin') suiteMargin = num(argv[++i]);
    else if (a.startsWith('-')) { write(`${USAGE}\n`); return 2; } else dirs.push(a);
  }
  if (dirs.length === 0 || !base || Number.isNaN(testMargin) || Number.isNaN(suiteMargin)) { write(`${USAGE}\n`); return 2; }
  /** @type {any[]} */ const reports = [];
  for (const d of dirs) for (const p of list(d)) { try { reports.push(JSON.parse(read(p))); } catch { write(`derive-budgets: ${p} is not a JSON report\n`); return 2; } }
  if (reports.length === 0) { write('derive-budgets: no report found\n'); return 2; }
  write(`${JSON.stringify(derive(JSON.parse(read(base)), reports, { testMargin, suiteMargin }).budgets, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
