// @ts-check
// Issue 266 package 3a (A277): the CI side of the duration report. One CI step runs the tests of a leg through this file instead of calling `node --test` itself:
//   node tests/ci/test-durations-ci.mjs <leg> -- <the arguments of node --test: files, globs, --test-name-pattern ...>
// It starts `node --test` with TWO reporters: the usual `spec` text on the step's own stdout (so the log is what it was) and the JSON-lines reporter of
// tests/ci/test-durations-reporter.mjs into a scratch file. After the run it writes `test-durations-<leg>.json` (every test and every file with the milliseconds
// Node measured, the slowest tests, the budgets that were exceeded, with TEST_DURATIONS_TWICE=true the unstable tests) into $TEST_DURATIONS_DIR (else
// $RUNNER_TEMP/test-durations, else ./test-durations) and appends a short table to the job summary ($GITHUB_STEP_SUMMARY).
// THE VERDICT: the exit status is exactly the status `node --test` gave (a failing test fails the step; the report never changes it). Only when
// tests/ci/test-budgets.json says `"enforce": true` AND the tests passed does an exceeded budget make the exit status 1 (package P3b flips that switch; until then
// the budgets are REPORTED as `OVER BUDGET:` lines). With TEST_DURATIONS_TWICE=true the leg runs a second time and the unstable tests are reported; a failed second
// run keeps its own status, an unstable test never changes the status. The tool reads no clock; the milliseconds are Node's.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, KINDS } from '../../control-plane/agents/scripts/core/testmeasure.mjs';
import { tmScaleMilli } from '../../control-plane/agents/scripts/core/timeouts.mjs';
import { tempDir } from '../lib/tempdir.mjs';
import { analyse, parseEvents, summarize } from './test-durations.mjs';

const here = import.meta.dirname;
const reporter = path.join(here, 'test-durations-reporter.mjs');
const budgetsFile = path.join(here, 'test-budgets.json');
const USAGE = 'usage: test-durations-ci.mjs <leg> -- <node --test arguments>';

/**
 * @typedef {{ kind?: string, test_ms?: number, suite_ms?: number }} DirBudget
 * @typedef {{ enforce?: boolean, timeouts_scale?: number | string, default_kind?: string, kinds?: Record<string, { test_ms?: number, suite_ms?: number }>,
 *   dirs?: Record<string, DirBudget>, legs?: Record<string, { suite_ms?: number }> }} Budgets
 * @typedef {{ file: string, name: string, ms: number, limit: number }} OverTest
 * @typedef {{ file: string, ms: number, limit: number }} OverFile
 */

/** `timeouts.scale` of the budgets file read the way the control plane reads it (between 0.5 and 10, else 1), in thousandths. @param {Budgets} b */
export function scaleMilli(b) {
  return tmScaleMilli(/** @type {any} */ ({ get: (/** @type {string} */ k, /** @type {string} */ d = '') => (k === 'timeouts.scale' && b.timeouts_scale !== undefined ? String(b.timeouts_scale) : d) }));
}

const whole = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);

/**
 * The budget of a test file in milliseconds, after the scale: the most specific `dirs` entry (longest path prefix) decides the kind and may override the numbers;
 * else the default kind; a number the file does not give is the built-in default of A275. @param {Budgets} b @param {string} file
 * @returns {{ kind: string, test: number, suite: number }}
 */
export function budgetOf(b, file) {
  const dirs = Object.keys(b.dirs ?? {}).filter((d) => file === d || file.startsWith(`${d}/`)).sort((x, y) => y.length - x.length);
  const d = dirs.length > 0 ? /** @type {DirBudget} */ (b.dirs?.[dirs[0]]) : {};
  const kind = KINDS.includes(d.kind ?? '') ? /** @type {string} */ (d.kind) : KINDS.includes(b.default_kind ?? '') ? /** @type {string} */ (b.default_kind) : DEFAULTS.default_kind;
  const def = /** @type {{ test_ms: number, suite_ms: number }} */ (/** @type {any} */ (DEFAULTS)[kind]);
  const k = b.kinds?.[kind] ?? {};
  const milli = scaleMilli(b);
  const sc = (/** @type {number} */ ms) => Math.ceil((ms * milli) / 1000);
  return { kind, test: sc(whole(d.test_ms) ?? whole(k.test_ms) ?? def.test_ms), suite: sc(whole(d.suite_ms) ?? whole(k.suite_ms) ?? def.suite_ms) };
}

/**
 * The tests and files over their budget (the worst duration over the runs counts). @param {Budgets} b
 * @param {Array<{ events: import('./test-durations.mjs').Event[] }>} runs
 * @returns {{ tests: OverTest[], files: OverFile[] }}
 */
export function overBudget(b, runs) {
  /** @type {Map<string, OverTest>} */ const t = new Map();
  /** @type {Map<string, { file: string, ms: number }>} */ const f = new Map();
  for (const r of runs) {
    const s = summarize(r.events);
    for (const x of s.tests) {
      const limit = budgetOf(b, x.file).test;
      const k = `${x.file}\0${x.name}`;
      if (x.ms > limit && (t.get(k)?.ms ?? -1) < x.ms) t.set(k, { file: x.file, name: x.name, ms: x.ms, limit });
    }
    for (const x of s.files) if ((f.get(x.file)?.ms ?? -1) < x.ms) f.set(x.file, { file: x.file, ms: x.ms });
  }
  const files = [...f.values()].map((x) => ({ ...x, limit: budgetOf(b, x.file).suite })).filter((x) => x.ms > x.limit);
  const cmp = (/** @type {string} */ a, /** @type {string} */ c) => (a < c ? -1 : a > c ? 1 : 0);
  return { tests: [...t.values()].sort((x, y) => cmp(x.file, y.file) || cmp(x.name, y.name)), files: files.sort((x, y) => cmp(x.file, y.file)) };
}

const clean = (/** @type {string} */ s) => s.replace(/[\u0000-\u001f\u007f-\u009f|]/g, ' ');
const r1 = (/** @type {number} */ n) => (Math.round(n * 10) / 10).toFixed(1);

/**
 * The job-summary text: the 10 slowest tests, the per-file totals (the 15 largest; the JSON has them all), the grand total, the budget lines, the unstable tests.
 * @param {string} leg @param {ReturnType<typeof analyse>} a @param {ReturnType<typeof overBudget>} over @param {boolean} enforce @param {boolean} twice
 */
export function renderSummary(leg, a, over, enforce, twice) {
  const L = [`### Test durations: ${clean(leg)}`, '', `${a.tests} tests in ${a.files.length} files; grand total ${a.total_max_ms} ms; budgets ${enforce ? 'ENFORCED' : 'report-only'}${twice ? '; run twice' : ''}`, ''];
  L.push('| slowest tests | ms | file |', '| --- | ---: | --- |');
  for (const t of a.slowest.slice(0, 10)) L.push(`| ${clean(t.name)} | ${r1(t.max_ms)} | ${clean(t.file)} |`);
  L.push('', '| file (suite total) | tests | ms |', '| --- | ---: | ---: |');
  for (const f of a.files.slice(0, 15)) L.push(`| ${clean(f.file)} | ${f.tests} | ${r1(f.max_ms)} |`);
  if (a.files.length > 15) L.push(`| (${a.files.length - 15} more files in the JSON) | | |`);
  L.push('', `grand total ${a.total_max_ms} ms`);
  const lines = [...over.tests.map((x) => `OVER BUDGET: ${clean(x.file)} :: ${clean(x.name)} took ${r1(x.ms)} ms over ${x.limit}`), ...over.files.map((x) => `OVER BUDGET: ${clean(x.file)} (suite) took ${r1(x.ms)} ms over ${x.limit}`)];
  if (lines.length > 0) L.push('', '```', ...lines, '```');
  if (a.failed.length > 0) L.push('', `failed tests: ${a.failed.length}`);
  if (twice) {
    L.push('', `UNSTABLE TESTS: ${a.unstable.length}`);
    if (a.unstable.length > 0) L.push('', '```', ...a.unstable.map((u) => `${u.reason}: ${clean(u.file)} :: ${clean(u.name)} [${u.outcome.join(' / ')}] [${u.ms.map((m) => (m === null ? '-' : m)).join(' / ')} ms]`), '```');
  }
  return `${L.join('\n')}\n`;
}

/** @typedef {{ run?: (args: string[], eventsFile: string) => number, readFile?: (p: string) => string, writeFile?: (p: string, s: string) => void, append?: (p: string, s: string) => void,
 *   write?: (s: string) => void, env?: Record<string, string | undefined>, budgets?: Budgets, scratch?: () => string }} IO */

/** @param {string[]} argv @param {IO} [io] @returns {number} */
export function main(argv, io = {}) {
  const write = io.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const env = io.env ?? process.env;
  const sep = argv.indexOf('--');
  const leg = (sep < 0 ? argv : argv.slice(0, sep))[0] ?? '';
  const testArgs = sep < 0 ? [] : argv.slice(sep + 1);
  if (sep !== 1 || !/^[A-Za-z0-9._ \/*-]+$/.test(leg) || testArgs.length === 0) { write(`${USAGE}\n`); return 2; }
  const readFile = io.readFile ?? ((/** @type {string} */ p) => readFileSync(p, 'utf8'));
  const writeOut = io.writeFile ?? ((/** @type {string} */ p, /** @type {string} */ s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); });
  /** @type {Budgets} */ let budgets = {};
  try { budgets = io.budgets ?? JSON.parse(readFileSync(budgetsFile, 'utf8')); } catch (e) { write(`test-durations-ci: budgets file unreadable (${/** @type {Error} */ (e).message}); built-in defaults, report-only\n`); }
  const enforce = budgets.enforce === true;
  const twice = env.TEST_DURATIONS_TWICE === 'true';
  const dir = env.TEST_DURATIONS_DIR || (env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, 'test-durations') : 'test-durations');
  const scratch = io.scratch ? io.scratch() : tempDir('durations-ci-');
  const run = io.run ?? realRun;
  /** @type {Array<{ status: number, events: import('./test-durations.mjs').Event[] }>} */ const runs = [];
  {
    for (let i = 0; i < (twice ? 2 : 1); i++) {
      const ev = path.join(scratch, `events-${i}.jsonl`);
      const status = run(testArgs, ev);
      let text = '';
      try { text = readFile(ev); } catch { text = ''; }   // a run that died before the reporter wrote anything has no events; the status still counts
      runs.push({ status, events: parseEvents(text) });
    }
    const nodeStatus = runs.map((r) => r.status).find((s) => s !== 0) ?? 0;
    /** @type {ReturnType<typeof overBudget>} */ let over = { tests: [], files: [] };
    try {
      const a = analyse(runs, { top: 20, ratio: 4, floorMs: 2000 });
      over = overBudget(budgets, runs);
      const safe = leg.replace(/[^A-Za-z0-9._-]+/g, '-');
      const { load: _load, ...rest } = a;   // no load average: the report is the same on any machine
      const json = { leg, node: env.TEST_DURATIONS_NODE ?? process.version, enforce, timeouts_scale: scaleMilli(budgets) / 1000, twice, node_status: nodeStatus, ...rest,
        tests_detail: summarize(runs[0].events).tests, over_budget: over };
      writeOut(path.join(dir, `test-durations-${safe}.json`), `${JSON.stringify(json, null, 2)}\n`);
      const text = renderSummary(leg, a, over, enforce, twice);
      const sum = env.GITHUB_STEP_SUMMARY;
      if (sum) (io.append ?? appendFileSync)(sum, `${text}\n`);
      for (const l of text.split('\n').filter((x) => x.startsWith('OVER BUDGET:') || x.startsWith('UNSTABLE TESTS:'))) write(`${l}\n`);
    } catch (e) {   // the report must never change the verdict: a report that cannot be written is a notice, the status stays node's
      write(`test-durations-ci: the report could not be written (${/** @type {Error} */ (e).message}); the exit status is node's\n`);
    }
    return nodeStatus !== 0 ? nodeStatus : enforce && (over.tests.length > 0 || over.files.length > 0) ? 1 : 0;
  }
}

/** The real run: `node --test` with the spec reporter on this process's stdout and the JSON-lines reporter into the scratch file; stdin, stdout and stderr pass through. @param {string[]} args @param {string} eventsFile */
function realRun(args, eventsFile) {
  // NODE_TEST_CONTEXT is removed so that a `node --test` started from inside a test run (the pin tests run this very file) is not refused
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, `--test-reporter-destination=${eventsFile}`, ...args], { stdio: 'inherit', env });
  return r.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
