// @ts-check
// Issue 266 package 1 (A277): the duration table of proofline's own tests. It runs a set of test files with Node's test runner and a machine-readable reporter
// (tests/ci/test-durations-reporter.mjs) and prints sorted tables: the slowest tests, the total per file (suite), the grand total and, with --twice, the tests whose
// outcome or duration differs between two runs of the same commit. Usage:
//   node tests/ci/test-durations.mjs [--twice] [--top N] [--json] [--ratio R] [--floor MS] [--out FILE] [--load] -- <node --test arguments: files or globs, --test-name-pattern ...>
// Exit 0: every test passed (and, with --twice, none is unstable); 1: a test failed or a test is unstable; 2: usage. The runner is injected (`io.run`), so the maths and the
// output are tested on recorded reporter output; the tool reads no clock (the milliseconds are Node's) and the order of every table is fixed.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS, withinTolerance } from '../../control-plane/agents/scripts/core/testmeasure.mjs';

const reporter = path.join(import.meta.dirname, 'test-durations-reporter.mjs');
const USAGE = 'usage: test-durations.mjs [--twice] [--top N] [--json] [--ratio R] [--floor MS] [--out FILE] [--load] -- <node --test arguments>';

/** @typedef {{ file: string, name: string, nesting: number, ms: number, outcome: string, suite: boolean }} Event */
/** @typedef {{ file: string, name: string, ms: number, outcome: string }} Entry */
/** @typedef {{ status: number, stdout: string, stderr?: string }} RunOut */
/** @typedef {{ run?: (args: string[]) => RunOut, write?: (s: string) => void, load?: () => number[] }} IO */

/** The events of one run from the reporter's output; any line that is not a JSON event is ignored. @param {string} text @returns {Event[]} */
export function parseEvents(text) {
  /** @type {Event[]} */ const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && typeof o.file === 'string' && typeof o.name === 'string' && typeof o.ms === 'number' && typeof o.outcome === 'string') {
      out.push({ file: o.file, name: o.name, nesting: Number(o.nesting ?? 0), ms: o.ms, outcome: o.outcome, suite: o.suite === true });
    }
  }
  return out;
}

/**
 * Full names and totals of one run. A child is reported before its parent, so the parent of an event is the next later event of its file one level up: a test inside
 * `describe('S')` is named `S > test`. The tests are the events that are not suites; the total of a file is the sum of its top level events (they contain the rest).
 * Names that repeat inside a file get ` #2`, ` #3`. @param {Event[]} events
 * @returns {{ tests: Entry[], files: Array<{ file: string, ms: number, tests: number }>, total_ms: number }}
 */
export function summarize(events) {
  /** @type {Map<string, number[]>} */ const byFile = new Map();
  events.forEach((e, i) => { const l = byFile.get(e.file) ?? []; l.push(i); byFile.set(e.file, l); });
  /** @type {string[]} */ const full = new Array(events.length);
  for (const idx of byFile.values()) {
    idx.forEach((i, pos) => {
      const e = events[i];
      /** @type {string[]} */ const names = [e.name];
      let want = e.nesting - 1;
      for (let p = pos + 1; p < idx.length && want >= 0; p++) if (events[idx[p]].nesting === want) { names.unshift(events[idx[p]].name); want--; }
      full[i] = names.join(' > ');
    });
  }
  /** @type {Map<string, number>} */ const seen = new Map();
  /** @type {Entry[]} */ const tests = [];
  /** @type {Map<string, { ms: number, tests: number }>} */ const files = new Map();
  events.forEach((e, i) => {
    const f = files.get(e.file) ?? { ms: 0, tests: 0 };
    if (e.nesting === 0) f.ms += e.ms;
    if (!e.suite) f.tests++;
    files.set(e.file, f);
    if (e.suite) return;
    const key = `${e.file}\0${full[i]}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    tests.push({ file: e.file, name: n === 1 ? full[i] : `${full[i]} #${n}`, ms: e.ms, outcome: e.outcome });
  });
  const fl = [...files].map(([file, v]) => ({ file, ms: v.ms, tests: v.tests })).sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  tests.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tests, files: fl, total_ms: fl.reduce((s, f) => s + f.ms, 0) };
}

const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The report of one or two runs. A test is unstable when its outcome differs between the runs, when it exists in one run only, or when its durations are outside the
 * tolerance (the same rule as the control plane's double run, A275: they differ by more than the floor AND by more than the ratio).
 * @param {Array<{ status: number, events: Event[], load?: number[][] }>} runs @param {{ top: number, ratio: number, floorMs: number }} opt
 */
export function analyse(runs, opt) {
  const sums = runs.map((r) => summarize(r.events));
  /** @type {Map<string, { file: string, name: string, ms: number[], outcome: string[] }>} */ const all = new Map();
  sums.forEach((s, i) => {
    for (const t of s.tests) {
      const k = `${t.file}\0${t.name}`;
      const e = all.get(k) ?? { file: t.file, name: t.name, ms: [], outcome: [] };
      e.ms[i] = t.ms; e.outcome[i] = t.outcome;
      all.set(k, e);
    }
  });
  const rows = [...all.values()].map((e) => {
    const present = e.ms.filter((m) => m !== undefined);
    return { file: e.file, name: e.name, min_ms: r2(Math.min(...present)), max_ms: r2(Math.max(...present)), ms: e.ms.map((m) => (m === undefined ? null : r2(m))), outcome: Array.from({ length: runs.length }, (_, i) => e.outcome[i] ?? 'missing') };
  });
  const slowest = [...rows].sort((a, b) => b.max_ms - a.max_ms || cmp(a.file, b.file) || cmp(a.name, b.name)).slice(0, opt.top);
  /** @type {Array<{ file: string, name: string, reason: string, outcome: string[], ms: Array<number | null> }>} */ const unstable = [];
  if (runs.length > 1) {
    for (const r of rows) {
      const o = r.outcome;
      const reason = o.includes('missing') ? 'missing' : o.some((x) => x !== o[0]) ? 'outcome' : !withinTolerance(r.ms[0] ?? 0, r.ms[1] ?? 0, { ratio: opt.ratio, floorMs: opt.floorMs }) ? 'duration' : '';
      if (reason) unstable.push({ file: r.file, name: r.name, reason, outcome: o, ms: r.ms });
    }
    unstable.sort((a, b) => cmp(a.file, b.file) || cmp(a.name, b.name));
  }
  /** @type {Map<string, { file: string, ms: number[], tests: number }>} */ const fm = new Map();
  sums.forEach((s, i) => { for (const f of s.files) { const e = fm.get(f.file) ?? { file: f.file, ms: [], tests: f.tests }; e.ms[i] = f.ms; fm.set(f.file, e); } });
  const files = [...fm.values()].map((f) => { const p = f.ms.filter((m) => m !== undefined); return { file: f.file, tests: f.tests, min_ms: r2(Math.min(...p)), max_ms: r2(Math.max(...p)) }; })
    .sort((a, b) => b.max_ms - a.max_ms || cmp(a.file, b.file));
  const totals = sums.map((s) => r2(s.total_ms));
  const failed = rows.filter((r) => r.outcome.includes('fail')).map((r) => ({ file: r.file, name: r.name })).sort((a, b) => cmp(a.file, b.file) || cmp(a.name, b.name));
  return {
    runs: runs.length, statuses: runs.map((r) => r.status), load: runs.map((r) => r.load ?? null), tests: rows.length, files,
    total_min_ms: Math.min(...totals), total_max_ms: Math.max(...totals), slowest, failed, unstable,
    tolerance: { ratio: opt.ratio, floor_ms: opt.floorMs },
  };
}

/** A name or file as one printable line: control characters (newlines, escape sequences) become spaces. @param {string} s */
const clean = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** @param {ReturnType<typeof analyse>} a */
export function renderText(a) {
  const L = [];
  const ms = (/** @type {number} */ n) => n.toFixed(1).padStart(10);
  L.push(`runs ${a.runs}; ${a.tests} tests in ${a.files.length} files; total ${a.total_min_ms} ms (min) / ${a.total_max_ms} ms (max); exit statuses ${a.statuses.join(',')}`);
  L.push('', `slowest ${a.slowest.length} tests (max over the runs)`, `${'min ms'.padStart(10)} ${'max ms'.padStart(10)}  file :: test`);
  for (const t of a.slowest) L.push(`${ms(t.min_ms)} ${ms(t.max_ms)}  ${clean(t.file)} :: ${clean(t.name)}`);
  L.push('', 'per file (suite) total', `${'min ms'.padStart(10)} ${'max ms'.padStart(10)} ${'tests'.padStart(6)}  file`);
  for (const f of a.files) L.push(`${ms(f.min_ms)} ${ms(f.max_ms)} ${String(f.tests).padStart(6)}  ${clean(f.file)}`);
  L.push('', `grand total ${a.total_min_ms} ms (min) / ${a.total_max_ms} ms (max)`);
  if (a.failed.length > 0) { L.push('', `failed (${a.failed.length})`); for (const f of a.failed) L.push(`  ${clean(f.file)} :: ${clean(f.name)}`); }
  if (a.runs > 1) {
    L.push('', `unstable (${a.unstable.length}; outcome differs, missing in a run, or durations differ by more than ${a.tolerance.floor_ms} ms and a ratio of ${a.tolerance.ratio})`);
    for (const u of a.unstable) L.push(`  ${u.reason}: ${clean(u.file)} :: ${clean(u.name)} [${u.outcome.join(' / ')}] [${u.ms.map((m) => (m === null ? '-' : m)).join(' / ')} ms]`);
  }
  return `${L.join('\n')}\n`;
}

/** @param {string[]} argv @param {IO} [io] @returns {number} */
export function main(argv, io = {}) {
  const write = io.write ?? ((/** @type {string} */ s) => process.stdout.write(s));
  const run = io.run ?? realRun;
  const load = io.load ?? (() => loadavg());
  let twice = false, json = false, withLoad = false, top = 20, ratio = DEFAULTS.stability.ratio, floorMs = DEFAULTS.stability.floor_ms, out = '';
  const sep = argv.indexOf('--');
  const opts = sep < 0 ? argv : argv.slice(0, sep);
  const testArgs = sep < 0 ? [] : argv.slice(sep + 1);
  const num = (/** @type {string | undefined} */ v) => (v !== undefined && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : NaN);
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === '--twice') twice = true;
    else if (a === '--json') json = true;
    else if (a === '--load') withLoad = true;
    else if (a === '--top') top = num(opts[++i]);
    else if (a === '--ratio') ratio = num(opts[++i]);
    else if (a === '--floor') floorMs = num(opts[++i]);
    else if (a === '--out') out = opts[++i] ?? '';
    else { write(`test-durations: unknown option ${a}\n${USAGE}\n`); return 2; }
  }
  if (!Number.isInteger(top) || top < 1 || !(ratio >= 1) || !(floorMs >= 0) || testArgs.length === 0) { write(`${USAGE}\n`); return 2; }
  /** @type {Array<{ status: number, events: Event[], load?: number[][] }>} */ const runs = [];
  for (let i = 0; i < (twice ? 2 : 1); i++) {
    const before = withLoad ? load().map(r2) : [];
    const r = run(testArgs);
    const after = withLoad ? load().map(r2) : [];
    runs.push({ status: r.status, events: parseEvents(r.stdout), ...(withLoad ? { load: [before, after] } : {}) });
  }
  const a = analyse(runs, { top, ratio, floorMs });
  if (out) writeFileSync(out, `${JSON.stringify(a, null, 2)}\n`);
  write(json ? `${JSON.stringify(a, null, 2)}\n` : renderText(a));
  return a.failed.length > 0 || a.unstable.length > 0 || runs.some((r) => r.status !== 0) ? 1 : 0;
}

/** The real runner: `node --test` with the reporter, in the current folder, stderr passed on. @param {string[]} args @returns {RunOut} */
function realRun(args) {
  // NODE_TEST_CONTEXT is removed: inside a test run Node would refuse to start the files of a nested `node --test`
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, '--test-reporter-destination=stdout', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'], env });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
