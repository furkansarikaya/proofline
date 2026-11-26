// @ts-check
// Issue 266 package 3a (A277): the CI side of the duration report. One CI step runs the tests of a leg through this file instead of calling `node --test` itself:
//   node tests/ci/test-durations-ci.mjs <leg> -- <the arguments of node --test: files, globs, --test-name-pattern ...>
// It starts `node --test` with TWO reporters: the usual `spec` text on the step's own stderr (so the log is what it was) and the JSON-lines reporter of
// tests/ci/test-durations-reporter.mjs on the child's stdout, which is a PIPE read by this process in memory: no file that a test could delete, replace or
// forge carries the verdict (fix round 1: a test that replaced the scratch events file made the verdict green). A test cannot reach this process's memory and the
// pipe is not inherited by the test processes (their stdio are pipes of the runner); a test that finds the runner's stdout through /proc can only ADD lines, and the
// budget check takes the worst duration per test and file, so an added line can never hide one. DEFENCE IN DEPTH: with enforce on, an empty stream, or a requested
// test file (explicit or glob, when no name pattern is given) that has no event in the stream, fails closed with exit 1. After the run it writes `test-durations-<leg>.json` (every test and every file with the milliseconds
// Node measured, the slowest tests, the budgets that were exceeded, with TEST_DURATIONS_TWICE=true the unstable tests) into $TEST_DURATIONS_DIR (else
// $RUNNER_TEMP/test-durations, else ./test-durations) and appends a short table to the job summary ($GITHUB_STEP_SUMMARY).
// THE VERDICT: a non-zero status of `node --test` is the exit status (a failing test fails the step; the report never changes it). When the tests passed and
// tests/ci/test-budgets.json says `"enforce": true` (package P3b, A277: it does) a test over its per-test budget or a file over its per-suite budget makes the exit
// status 1 and the `OVER BUDGET:` lines name them. The budget file is read BEFORE anything runs and FAILS CLOSED: a missing, unreadable or malformed file (or a budget that
// is not a positive whole number) exits 2 with a message, never a silent green; in enforce mode a leg whose events cannot be read or whose budgets cannot be applied also
// exits 1. There is no retry: the wrapper starts `node --test` once (twice only with TEST_DURATIONS_TWICE=true, a manual measuring run whose unstable report is only
// informational: a failed second run keeps its own status). RUNNER-SPEED CALIBRATION (fix round 2): a degraded runner (one leg ran 4.9 times slower than its twin) must not
// fail an unrelated pull request, so BEFORE node starts and again AFTER node exits (A354: a stall during the run is seen; the slower of the two counts), in this process, the wrapper times a small fixed reference workload (15 `node -e 0` spawns, 40 sha256 rounds over a
// fixed 1 MiB buffer, 300 file create/stat/unlink in a fresh private folder) and `speed_factor = clamp(max(before, after) / calibration.nominal_ms, 1, 5)` multiplies every budget (on top of
// timeouts_scale); the nominal is the median over CI runs (derive-budgets.mjs). A factor never makes a budget stricter than the table. A raw ratio above 5 (a broken runner) fails
// ONLY when a budget is violated, with the message 'runner too slow to judge budgets'. The tests under test run after the first calibration and cannot reach its folder or its clock reads; the second calibration runs in this same process once node and its children have exited, so a process a test of the leg leaves running (a detached busy loop) can raise the factor (bounded by x5; the gate is a regression guard, not a sandbox).
// The tool reads the clock for this and for nothing else; the test milliseconds are Node's.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync as stat0, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
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
 * @typedef {{ enforce?: boolean, calibration?: { nominal_ms?: number }, timeouts_scale?: number | string, default_kind?: string, kinds?: Record<string, { test_ms?: number, suite_ms?: number }>,
 *   dirs?: Record<string, DirBudget>, files?: Record<string, { test_ms?: number, suite_ms?: number }>, legs?: Record<string, { suite_ms?: number }> }} Budgets
 * @typedef {{ file: string, name: string, ms: number, limit: number }} OverTest
 * @typedef {{ file: string, ms: number, limit: number }} OverFile
 */

/** `timeouts.scale` of the budgets file read the way the control plane reads it (between 0.5 and 10, else 1), in thousandths. @param {Budgets} b */
export function scaleMilli(b) {
  return tmScaleMilli(/** @type {any} */ ({ get: (/** @type {string} */ k, /** @type {string} */ d = '') => (k === 'timeouts.scale' && b.timeouts_scale !== undefined ? String(b.timeouts_scale) : d) }));
}

/** The largest budget accepted (one hour): a typo or a hostile 1e9 would switch a budget off. */
export const MAX_MS = 3_600_000;
const whole = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : undefined);

/**
 * The budget of a test file in milliseconds, after the scale: the most specific `dirs` entry (longest path prefix) decides the kind and may override the numbers;
 * else the default kind; a `files` row for exactly this file overrides the numbers last (tests/ci/derive-budgets.mjs writes them from CI); a number not given is the
 * built-in default of A275. @param {Budgets} b @param {string} file @param {number} [speed] the runner speed factor (1 to 5)
 * @returns {{ kind: string, test: number, suite: number }}
 */
export function budgetOf(b, file, speed = 1) {
  const dirs = Object.keys(b.dirs ?? {}).filter((d) => file === d || file.startsWith(`${d}/`)).sort((x, y) => y.length - x.length);
  const d = dirs.length > 0 ? /** @type {DirBudget} */ (b.dirs?.[dirs[0]]) : {};
  const kind = KINDS.includes(d.kind ?? '') ? /** @type {string} */ (d.kind) : KINDS.includes(b.default_kind ?? '') ? /** @type {string} */ (b.default_kind) : DEFAULTS.default_kind;
  const def = /** @type {{ test_ms: number, suite_ms: number }} */ (/** @type {any} */ (DEFAULTS)[kind]);
  const k = b.kinds?.[kind] ?? {};
  const milli = scaleMilli(b);
  const sc = (/** @type {number} */ ms) => Math.ceil(((ms * milli) / 1000) * speed);
  const f = b.files?.[file] ?? {};
  return { kind, test: sc(whole(f.test_ms) ?? whole(d.test_ms) ?? whole(k.test_ms) ?? def.test_ms), suite: sc(whole(f.suite_ms) ?? whole(d.suite_ms) ?? whole(k.suite_ms) ?? def.suite_ms) };
}

/**
 * The tests and files over their budget (the worst duration over the runs counts). @param {Budgets} b @param {number} [speed] the runner speed factor
 * @param {Array<{ events: import('./test-durations.mjs').Event[] }>} runs
 * @returns {{ tests: OverTest[], files: OverFile[] }}
 */
export function overBudget(b, runs, speed = 1) {
  /** @type {Map<string, OverTest>} */ const t = new Map();
  /** @type {Map<string, { file: string, ms: number }>} */ const f = new Map();
  for (const r of runs) {
    const s = summarize(r.events);
    for (const x of s.tests) {
      const limit = budgetOf(b, x.file, speed).test;
      const k = `${x.file}\0${x.name}`;
      if (x.ms > limit && (t.get(k)?.ms ?? -1) < x.ms) t.set(k, { file: x.file, name: x.name, ms: x.ms, limit });
    }
    for (const x of s.files) if ((f.get(x.file)?.ms ?? -1) < x.ms) f.set(x.file, { file: x.file, ms: x.ms });
  }
  const files = [...f.values()].map((x) => ({ ...x, limit: budgetOf(b, x.file, speed).suite })).filter((x) => x.ms > x.limit);
  const cmp = (/** @type {string} */ a, /** @type {string} */ c) => (a < c ? -1 : a > c ? 1 : 0);
  return { tests: [...t.values()].sort((x, y) => cmp(x.file, y.file) || cmp(x.name, y.name)), files: files.sort((x, y) => cmp(x.file, y.file)) };
}

/** The `OVER BUDGET:` lines of a result, the same text as in the summary. @param {ReturnType<typeof overBudget>} over */
export function overLines(over) {
  return [...over.tests.map((x) => `OVER BUDGET: ${clean(x.file)} :: ${clean(x.name)} took ${r1(x.ms)} ms over ${x.limit}`), ...over.files.map((x) => `OVER BUDGET: ${clean(x.file)} (suite) took ${r1(x.ms)} ms over ${x.limit}`)];
}

/** What is wrong with a budgets document, as short sentences (empty when it is usable): a budget that is not a positive whole number would silently fall back to a default. @param {unknown} b @returns {string[]} */
export function budgetProblems(b) {
  /** @type {string[]} */ const out = [];
  const isObj = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(b)) return ['the document is not an object'];
  const o = /** @type {Record<string, any>} */ (b);
  if (typeof o.enforce !== 'boolean') out.push('enforce is missing or not true or false');
  if (o.default_kind !== undefined && !KINDS.includes(o.default_kind)) out.push('default_kind is not unit, integration or e2e');
  if (o.timeouts_scale !== undefined && !(typeof o.timeouts_scale === 'number' && o.timeouts_scale >= 0.5 && o.timeouts_scale <= 10)) out.push('timeouts_scale is not a number from 0.5 to 10');
  if (o.calibration !== undefined) {
    const n = isObj(o.calibration) ? /** @type {any} */ (o.calibration).nominal_ms : undefined;
    if (whole(n) === undefined || n > MAX_MS) out.push(`calibration.nominal_ms is not a whole number from 1 to ${MAX_MS}`);
  }
  const nums = (/** @type {string} */ where, /** @type {any} */ v) => {
    if (!isObj(v)) { out.push(`${where} is not an object`); return; }
    for (const k of ['test_ms', 'suite_ms']) if (v[k] !== undefined && (whole(v[k]) === undefined || v[k] > MAX_MS)) out.push(`${where}.${k} is not a whole number from 1 to ${MAX_MS}`);
  };
  for (const [sect, rows] of /** @type {Array<[string, any]>} */ ([['kinds', o.kinds], ['dirs', o.dirs], ['files', o.files]])) {
    if (rows === undefined) continue;
    if (!isObj(rows)) { out.push(`${sect} is not an object`); continue; }
    for (const [k, v] of Object.entries(rows)) {
      nums(`${sect}[${k}]`, v);
      if (sect === 'kinds' && !KINDS.includes(k)) out.push(`kinds[${k}] is not a known kind`);
      if (sect === 'dirs' && isObj(v) && /** @type {any} */ (v).kind !== undefined && !KINDS.includes(/** @type {any} */ (v).kind)) out.push(`dirs[${k}].kind is not a known kind`);
    }
  }
  return out;
}

/** The reference workload: fixed work, no randomness. Takes about a second on a normal runner. @param {{ spawns?: number, rounds?: number, files?: number }} [n] */
export function referenceWorkload(n = {}) {
  for (let i = 0; i < (n.spawns ?? 15); i++) spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const buf = Buffer.alloc(1 << 20, 7);
  let digest = '';
  for (let i = 0; i < (n.rounds ?? 40); i++) digest = createHash('sha256').update(buf).update(digest).digest('hex');
  const dir = tempDir('cal-');
  try {
    for (let i = 0; i < (n.files ?? 300); i++) { const f = path.join(dir, `f${i}`); writeFileSync(f, digest); stat0(f); rmSync(f); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return digest;
}

/** The speed factor of a measurement: clamp(measured / nominal, 1, 5); `raw` is the unclamped ratio. @param {number} measuredMs @param {number} nominalMs */
export function speedFactor(measuredMs, nominalMs) {
  const raw = Number.isFinite(measuredMs) && measuredMs > 0 && nominalMs > 0 ? measuredMs / nominalMs : 1;
  return { raw, factor: Math.min(5, Math.max(1, raw)) };
}

/** @param {number} n */
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

/** One printable summary cell: control characters, the table bar, backticks (a code fence) and `<` and `[` (html and links) become spaces. @param {string} s */
const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f|`<[]/g, ' ');
const r1 = (/** @type {number} */ n) => (Math.round(n * 10) / 10).toFixed(1);

/**
 * The job-summary text: the 10 slowest tests, the per-file totals (the 15 largest; the JSON has them all), the grand total, the budget lines, the unstable tests.
 * @param {string} leg @param {ReturnType<typeof analyse>} a @param {ReturnType<typeof overBudget>} over @param {boolean} enforce @param {boolean} twice
 * @param {{ ms: number, after?: number, nominal: number, raw: number, factor: number, rows: Array<{ file: string, test: number, suite: number }> } | null} [cal]
 */
export function renderSummary(leg, a, over, enforce, twice, cal) {
  const L = [`### Test durations: ${clean(leg)}`, '', `${a.tests} tests in ${a.files.length} files; grand total ${a.total_max_ms} ms; budgets ${enforce ? 'ENFORCED' : 'report-only'}${twice ? '; run twice' : ''}`, ''];
  if (cal) {
    L.push(`runner speed: calibration ${r1(cal.ms)} ms before and ${cal.after === undefined ? 'n/a' : `${r1(cal.after)} ms after`} the run (the slower counts) against ${cal.nominal} ms nominal; factor ${f2(cal.factor)}${cal.raw !== cal.factor ? ` (raw ${f2(cal.raw)})` : ''}; every budget below is multiplied by it`, '');
    L.push('| effective budgets (slowest files) | test ms | suite ms |', '| --- | ---: | ---: |');
    for (const r of cal.rows) L.push(`| ${clean(r.file)} | ${r.test} | ${r.suite} |`);
    L.push('');
  }
  L.push('| slowest tests | ms | file |', '| --- | ---: | --- |');
  for (const t of a.slowest.slice(0, 10)) L.push(`| ${clean(t.name)} | ${r1(t.max_ms)} | ${clean(t.file)} |`);
  L.push('', '| file (suite total) | tests | ms |', '| --- | ---: | ---: |');
  for (const f of a.files.slice(0, 15)) L.push(`| ${clean(f.file)} | ${f.tests} | ${r1(f.max_ms)} |`);
  if (a.files.length > 15) L.push(`| (${a.files.length - 15} more files in the JSON) | | |`);
  L.push('', `grand total ${a.total_max_ms} ms`);
  const lines = overLines(over);
  if (lines.length > 0) L.push('', '```', ...lines, '```');
  if (a.failed.length > 0) L.push('', `failed tests: ${a.failed.length}`);
  if (twice) {
    L.push('', `UNSTABLE TESTS: ${a.unstable.length}`);
    if (a.unstable.length > 0) L.push('', '```', ...a.unstable.map((u) => `${u.reason}: ${clean(u.file)} :: ${clean(u.name)} [${u.outcome.join(' / ')}] [${u.ms.map((m) => (m === null ? '-' : m)).join(' / ')} ms]`), '```');
  }
  return `${L.join('\n')}\n`;
}

/** @typedef {{ run?: (args: string[]) => { status: number, events: string | null }, writeFile?: (p: string, s: string) => void, append?: (p: string, s: string) => void,
 *   calibrate?: () => number, write?: (s: string) => void, env?: Record<string, string | undefined>, budgets?: Budgets, budgetsFile?: string, stderr?: 'inherit' | 'ignore', cwd?: string }} IO */

/** @param {string[]} argv @param {IO} [io] @returns {number} */
export function main(argv, io = {}) {
  const write = io.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const env = io.env ?? process.env;
  const sep = argv.indexOf('--');
  const leg = (sep < 0 ? argv : argv.slice(0, sep))[0] ?? '';
  const testArgs = sep < 0 ? [] : argv.slice(sep + 1);
  if (sep !== 1 || !/^[A-Za-z0-9._ \/*-]+$/.test(leg) || testArgs.length === 0) { write(`${USAGE}\n`); return 2; }
  const writeOut = io.writeFile ?? ((/** @type {string} */ p, /** @type {string} */ s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); });
  /** @type {Budgets} */ let budgets = {};
  try {
    const raw = io.budgets ?? parseStrict(readFileSync(io.budgetsFile ?? budgetsFile, 'utf8'));
    const bad = budgetProblems(raw);
    if (bad.length > 0) { write(`test-durations-ci: the budgets file is invalid, nothing was run (fails closed): ${bad.join('; ')}\n`); return 2; }
    budgets = raw;
  } catch (e) { write(`test-durations-ci: the budgets file is missing, unreadable or not JSON, nothing was run (fails closed): ${/** @type {Error} */ (e).message}\n`); return 2; }
  const enforce = budgets.enforce === true;
  const twice = env.TEST_DURATIONS_TWICE === 'true';
  const dir = env.TEST_DURATIONS_DIR || (env.RUNNER_TEMP ? path.join(env.RUNNER_TEMP, 'test-durations') : 'test-durations');
  // the calibration comes first, in this process, before any test code exists
  const nominal = budgets.calibration?.nominal_ms;
  /** @type {{ ms: number, after?: number, nominal: number, raw: number, factor: number, rows: Array<{ file: string, test: number, suite: number }> } | null} */ let cal = null;
  if (typeof nominal === 'number') {
    const ms = io.calibrate ? io.calibrate() : timedWorkload();
    cal = { ms, nominal, ...speedFactor(ms, nominal), rows: [] };
  }
  const run = io.run ?? ((/** @type {string[]} */ a) => realRun(a, io.stderr ?? 'inherit'));
  const cwd = io.cwd ?? process.cwd();
  /** @type {Array<{ status: number, events: import('./test-durations.mjs').Event[] }>} */ const runs = [];
  let unreadable = false;
  for (let i = 0; i < (twice ? 2 : 1); i++) {
    const r = run(testArgs);
    if (r.events === null) unreadable = true;   // the stream could not be read: the status still counts, the verdict cannot be made
    runs.push({ status: r.status, events: parseEvents(r.events ?? '') });
  }
  // A354: a runner can stall DURING the run (a calibration before node starts cannot see it), so the reference workload is timed again after node exits; the slower of the two decides
  if (cal) {
    const after = io.calibrate ? io.calibrate() : timedWorkload();
    cal = { ...cal, after, ...speedFactor(Math.max(cal.ms, after), cal.nominal) };
  }
  const speed = cal?.factor ?? 1;
  const nodeStatus = runs.map((r) => r.status).find((s) => s !== 0) ?? 0;
  /** @type {ReturnType<typeof overBudget> | null} */ let over = null;
  try { over = overBudget(budgets, runs, speed); } catch (e) { write(`test-durations-ci: the budgets could not be applied (${/** @type {Error} */ (e).message})\n`); }
  // C11 (A360): above the cap the budget verdict is INCONCLUSIVE on pull requests and pushes (only budget overruns are excused); BUDGET_STRICT=1 (nightly, manual) judges as before.
  // Every other failure stays: a failing test, an unreadable or empty stream, a file without events, an unreadable calibration (it reads as 1, never above the cap).
  const strict = env.BUDGET_STRICT === '1';
  const closed = over === null || unreadable || runs.some((r) => r.events.length === 0 || uncovered(testArgs, r.events, cwd).length > 0);
  const nOver = over ? over.tests.length + over.files.length : 0;
  const inconclusive = enforce && nodeStatus === 0 && !strict && !closed && nOver > 0 && cal !== null && cal.raw > 5;
  const verdictLine = cal ? `BUDGET INCONCLUSIVE: runner too slow to judge (calibration ${f2(cal.raw)} x nominal, cap 5): ${nOver} over-budget test(s) not judged; the nightly run judges again` : '';
  try {
    const a = analyse(runs, { top: 20, ratio: 4, floorMs: 2000 });
    const o = over ?? { tests: [], files: [] };
    if (cal) cal.rows = a.files.slice(0, 5).map((f) => ({ file: f.file, ...(({ test, suite }) => ({ test, suite }))(budgetOf(budgets, f.file, speed)) }));
    const safe = leg.replace(/[^A-Za-z0-9._-]+/g, '-');
    const { load: _load, ...rest } = a;   // no load average: the report is the same on any machine
    const json = { leg, node: env.TEST_DURATIONS_NODE ?? process.version, enforce, timeouts_scale: scaleMilli(budgets) / 1000, calibration_ms: cal ? Math.round(cal.ms * 100) / 100 : null, calibration_after_ms: cal?.after === undefined ? null : Math.round(cal.after * 100) / 100, calibration_nominal_ms: nominal ?? null, budget_verdict: !enforce ? 'not-enforced' : inconclusive ? 'inconclusive' : 'judged', ...(inconclusive ? { unjudged_over_budget: o } : {}), speed_factor: cal ? Math.round(cal.factor * 1000) / 1000 : 1, twice, node_status: nodeStatus, ...rest,
      tests_detail: summarize(runs[0].events).tests, over_budget: o };
    writeOut(path.join(dir, `test-durations-${safe}.json`), `${JSON.stringify(json, null, 2)}\n`);
    const text = renderSummary(leg, a, o, enforce, twice, cal) + (inconclusive ? `\n${verdictLine}\n` : '');
    const sum = env.GITHUB_STEP_SUMMARY;
    if (sum) (io.append ?? appendFileSync)(sum, `${text}\n`);
  } catch (e) {   // the report must never change the verdict: a report that cannot be written is a notice, the status stays node's
    write(`test-durations-ci: the report could not be written (${/** @type {Error} */ (e).message}); the exit status is node's\n`);
  }
  if (over) for (const l of overLines(over)) write(`${l}\n`);
  if (twice) { try { const u = analyse(runs, { top: 1, ratio: 4, floorMs: 2000 }).unstable.length; write(`UNSTABLE TESTS: ${u}\n`); } catch { /* informational only */ } }
  if (nodeStatus !== 0) return nodeStatus;
  if (!enforce) return 0;
  if (inconclusive) { write(`${verdictLine}\n::warning title=BUDGET INCONCLUSIVE::${verdictLine}\n`); return 0; }
  if (over === null || unreadable) { write('test-durations-ci: budgets are enforced but the measured durations are not available; failing closed\n'); return 1; }
  for (const r of runs) {
    if (r.events.length === 0) { write('test-durations-ci: the event stream is empty (no test was reported); failing closed\n'); return 1; }
    const miss = uncovered(testArgs, r.events, cwd);
    if (miss.length > 0) { write(`test-durations-ci: ${miss.length} requested test file(s) have no event in the stream, so their budgets cannot be checked; failing closed: ${miss.slice(0, 5).join(', ')}${miss.length > 5 ? ', ...' : ''}\n`); return 1; }
  }
  if ((over.tests.length > 0 || over.files.length > 0) && cal && cal.raw > 5) { write(`test-durations-ci: runner too slow to judge budgets (the calibration took ${f2(cal.raw)} times the nominal, the factor is capped at 5) and ${over.tests.length} test(s) and ${over.files.length} file(s) are over even the scaled budgets\n`); return 1; }
  if (over.tests.length > 0 || over.files.length > 0) { write(`test-durations-ci: ${over.tests.length} test(s) and ${over.files.length} file(s) are over budget. Fix the slow test; relaxing a budget needs a reason (CONTRIBUTING, tests/ci/test-budgets.json)\n`); return 1; }
  return 0;
}

/** The calibration with the real clock and the real workload. @returns {number} */
function timedWorkload() {
  const t0 = performance.now();
  referenceWorkload();
  return performance.now() - t0;
}

/**
 * The real run: `node --test` with the spec reporter on stderr (the step log) and the JSON-lines reporter on stdout, which is a pipe read here in memory. The
 * child's stdio is [inherit, pipe, stderr]: no other descriptor is passed on.
 * @param {string[]} args @param {'inherit' | 'ignore'} stderr @returns {{ status: number, events: string | null }}
 */
function realRun(args, stderr) {
  // NODE_TEST_CONTEXT is removed so that a `node --test` started from inside a test run (the pin tests run this very file) is not refused
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stderr', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', ...args],
    { stdio: ['inherit', 'pipe', stderr], env, encoding: 'utf8', maxBuffer: 1 << 29 });
  return { status: r.status ?? 1, events: r.error ? null : r.stdout ?? '' };
}

/** The real path when there is one (a symlinked temp folder), else the path itself. @param {string} p */
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** The test files an argument list asks for: explicit files and glob patterns (`*`, `**`) of arguments that are not options; a directory argument and any run with a name pattern are not listed (node decides there). @param {string[]} args @param {string} cwd @returns {string[]} */
export function requestedFiles(args, cwd) {
  if (args.some((a) => /^--test-(name|skip)-pattern\b|^--test-only\b/.test(a))) return [];
  /** @type {string[]} */ const out = [];
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const norm = (path.isAbsolute(a) ? path.relative(real(cwd), real(a)) : a).split('\\').join('/').replace(/^\.\//, '');   // the reporter names files relative to the folder
    if (!/[*?]/.test(norm)) {
      let isDir = false;
      try { isDir = statSync(path.join(cwd, norm)).isDirectory(); } catch { isDir = false; }
      if (!isDir) out.push(norm);
      continue;
    }
    out.push(...globFiles(norm.split('/'), '', cwd));
  }
  return [...new Set(out)].sort();
}

/** @param {string[]} segs @param {string} base @param {string} cwd @returns {string[]} */
function globFiles(segs, base, cwd) {
  if (segs.length === 0) return [];
  const [head, ...rest] = segs;
  const dir = path.join(cwd, base);
  if (!/[*?]/.test(head)) {
    const next = base ? `${base}/${head}` : head;
    if (rest.length === 0) return existsSync(path.join(cwd, next)) && !statSync(path.join(cwd, next)).isDirectory() ? [next] : [];
    return globFiles(rest, next, cwd);
  }
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  /** @type {string[]} */ const out = [];
  if (head === '**') {
    out.push(...globFiles(rest, base, cwd));
    for (const n of names) { const rel = base ? `${base}/${n}` : n; let d = false; try { d = statSync(path.join(cwd, rel)).isDirectory(); } catch { d = false; } if (d && n !== 'node_modules' && !n.startsWith('.')) out.push(...globFiles(segs, rel, cwd)); }
    return out;
  }
  const re = new RegExp(`^${head.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  for (const n of names) {
    if (!re.test(n)) continue;
    const rel = base ? `${base}/${n}` : n;
    if (rest.length === 0) { let d = false; try { d = statSync(path.join(cwd, rel)).isDirectory(); } catch { d = false; } if (!d) out.push(rel); } else out.push(...globFiles(rest, rel, cwd));
  }
  return out;
}

/**
 * The requested files that have no event in a run. A file whose tests are registered by a helper module (tests/core/port-t3-rig.mjs: the stage files only call it) has its
 * events under the helper's name; such a file is covered when the stream holds events of a module that is not a requested file and not itself a `.test.` file.
 * @param {string[]} args @param {import('./test-durations.mjs').Event[]} events @param {string} cwd
 */
export function uncovered(args, events, cwd) {
  const want = requestedFiles(args, cwd);
  const have = new Set(events.map((e) => e.file));
  const helper = [...have].some((f) => f !== '' && !want.includes(f) && !/\.test\.[cm]?[jt]s$/.test(f));
  return want.filter((f) => !have.has(f) && !helper);
}

/**
 * JSON.parse that refuses a duplicate key in any object (a second `enforce` would silently win). @param {string} text
 * @returns {any}
 */
export function parseStrict(text) {
  const v = JSON.parse(text);   // syntax first
  /** @param {string} t */
  const dupes = (t) => {
    let i = 0;
    /** @type {string[]} */ const found = [];
    const ws = () => { while (i < t.length && ' \t\n\r'.includes(t[i])) i++; };
    const str = () => { const st = i; i++; while (t[i] !== '"') { if (t[i] === '\\') i++; i++; } i++; return JSON.parse(t.slice(st, i)); };
    const val = () => {
      ws();
      if (t[i] === '{') {
        i++; const keys = new Set(); ws();
        if (t[i] === '}') { i++; return; }
        for (;;) { ws(); const k = str(); if (keys.has(k)) found.push(k); keys.add(k); ws(); i++; val(); ws(); if (t[i] === ',') { i++; continue; } i++; return; }
      } else if (t[i] === '[') {
        i++; ws();
        if (t[i] === ']') { i++; return; }
        for (;;) { val(); ws(); if (t[i] === ',') { i++; continue; } i++; return; }
      } else if (t[i] === '"') str();
      else while (i < t.length && !',}] \t\n\r'.includes(t[i])) i++;
    };
    val();
    return found;
  };
  const d = dupes(text);
  if (d.length > 0) throw new Error(`duplicate key ${d.map((k) => JSON.stringify(k)).join(', ')}`);
  return v;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
