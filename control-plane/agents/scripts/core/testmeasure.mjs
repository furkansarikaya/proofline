// @ts-check
// Test speed and determinism, the measurement (issue 265 package B, A275): the duration per test from the GREEN evidence (AC-3), the budgets by test kind
// (AC-4) and the double run of the new and changed tests (AC-5). Everything here is a function of its inputs: the durations are the numbers the GREEN
// recorder stored (read from the runner's own output, never an estimate), the budgets come from config.yaml and the plan, and the double run takes its
// runner as a parameter (it returns the exit status and the milliseconds), so the tolerance maths is tested with no real test and no real clock.
// Shared rule 3: no ecosystem name is read here. The only ecosystem facts are the `test_retry` rules of ecosystems.json (file glob, line pattern, text).
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monoMs } from './clock.mjs';
import { ecosystemRows } from './ecodata.mjs';
import { git, headSha } from './git.mjs';
import { listNames } from './ledger.mjs';
import * as proc from './proc.mjs';
import { fieldOf, fileLines, fileText, ledgerLines, textLines } from './records.mjs';
import { planVerificationCommands, reproduceAllowed } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { asciiLower, pathMatches } from './shellglob.mjs';
import { tmScaleMilli, verifyCommandTimeout } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {import('./config.mjs').Config} Config */

export const KINDS = ['unit', 'integration', 'e2e'];

/**
 * The defaults of `test_budgets.<kind>.test_ms|suite_ms` and `test_stability.ratio|floor_ms`, taken from a measurement of this repository's own suites
 * (A275 holds the table). config.yaml carries the same numbers; a test pins the two together. Milliseconds, before timeouts.scale.
 */
export const DEFAULTS = {
  unit: { test_ms: 2000, suite_ms: 30000 },
  integration: { test_ms: 10000, suite_ms: 120000 },
  e2e: { test_ms: 60000, suite_ms: 600000 },
  stability: { ratio: 4, floor_ms: 2000 },
  default_kind: 'unit',
};

// ---- the recorded durations -------------------------------------------------------------------------------------------------------

/** `name=ms; name=ms` (the value of the recorder's `test_durations:` line). @param {string} line @returns {Array<{ name: string, ms: number }>} */
export function parseDurations(line) {
  /** @type {Array<{ name: string, ms: number }>} */ const out = [];
  for (const part of line.split(';')) {
    const e = part.trim();
    const i = e.lastIndexOf('=');
    if (i <= 0) continue;
    const ms = Number(e.slice(i + 1));
    if (Number.isFinite(ms) && ms >= 0) out.push({ name: e.slice(0, i).trim(), ms });
  }
  return out;
}

/**
 * The GREEN records of a run: their command and their durations. Every GREEN record counts (a later one for the same test replaces the earlier one by name).
 * @param {Context} ctx @param {string} id @returns {Array<{ file: string, command: string, durations: Array<{ name: string, ms: number }> }>}
 */
export function greenRecords(ctx, id) {
  const evdir = `${runDir(ctx, id)}/worker-evidence`;
  // numeric order of the recorder's sequence (GREEN-2 before GREEN-10): "the latest record wins" must not follow the text order
  const seq = (/** @type {string} */ n) => Number(/^GREEN-0*([0-9]+)/.exec(n)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return listNames(evdir, /^GREEN-.*\.yaml$/).sort((a, b) => seq(a) - seq(b) || (a < b ? -1 : a > b ? 1 : 0)).map((n) => {
    const lines = fileLines(ctx, `${evdir}/${n}`);
    return { file: n, command: fieldOf(lines, 'command'), durations: parseDurations(fieldOf(lines, 'test_durations')) };
  });
}

// ---- the plan: test kinds and budgets -------------------------------------------------------------------------------------------------

/**
 * `## Tests` bullets with their `test_kind` and the quoted test names, and `## Test budgets` (`default` or numbers) of a PLAN.md.
 * @param {string} plan @returns {{ names: Array<{ name: string, kind: string }>, budgets: Map<string, { test: number, suite: number } | 'default'> }}
 */
export function planKinds(plan) {
  /** @type {Array<{ name: string, kind: string }>} */ const names = [];
  /** @type {Map<string, { test: number, suite: number } | 'default'>} */ const budgets = new Map();
  let sec = '';
  for (const l of textLines(plan)) {
    if (l.startsWith('## ')) { sec = l.slice(3).trim(); continue; }
    if (sec === 'Tests') {
      const k = /\btest_kind:\s*([A-Za-z0-9_-]+)/.exec(l);
      if (!k || !KINDS.includes(k[1]) || !/^\s*[-*]\s+AC-\d+:/i.test(l)) continue;
      for (const m of l.matchAll(/"([^"]+)"/g)) names.push({ name: asciiLower(m[1].trim()), kind: k[1] });
    } else if (sec === 'Test budgets') {
      const m = /^\s*-\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(l);
      if (!m || !KINDS.includes(m[1])) continue;
      const v = m[2].trim();
      const b = /^test (\d+) ms; suite (\d+) ms$/.exec(v);
      if (b) budgets.set(m[1], { test: Number(b[1]), suite: Number(b[2]) });
      else if (v === 'default') budgets.set(m[1], 'default');
    }
  }
  return { names, budgets };
}

/** The kind of a recorded test: the plan bullet that quotes its name (equal, or one contains the other), else the configured default kind. @param {string} name @param {Array<{ name: string, kind: string }>} names @param {string} fallback */
export function kindOf(name, names, fallback) {
  const n = asciiLower(name.trim());
  const exact = names.find((x) => x.name === n);
  if (exact) return exact.kind;
  const part = names.find((x) => x.name !== '' && (n.includes(x.name) || x.name.includes(n)));
  return part ? part.kind : fallback;
}

// ---- budgets (AC-4) -----------------------------------------------------------------------------------------------------------------

/** @param {string} v @param {number} def */
function wholeMs(v, def) { return /^[0-9]+$/.test(v) && Number(v) >= 1 ? Number(v) : def; }
/** @param {number} ms @param {Config} cfg timeouts.scale applied, rounded up */
function scaled(ms, cfg) { return Math.ceil((ms * tmScaleMilli(cfg)) / 1000); }

/**
 * The budget of each kind in milliseconds, after timeouts.scale. Precedence: the plan's `## Test budgets` line with numbers, then config.yaml
 * (`test_budgets.<kind>.test_ms|suite_ms`), then the built-in default. A plan line `default` means the configured budget.
 * @param {Config} cfg @param {Map<string, { test: number, suite: number } | 'default'>} planBudgets
 * @returns {Record<string, { test: number, suite: number, source: 'plan' | 'config' }>}
 */
export function budgetTable(cfg, planBudgets) {
  /** @type {Record<string, { test: number, suite: number, source: 'plan' | 'config' }>} */ const out = {};
  for (const k of KINDS) {
    const d = /** @type {{ test_ms: number, suite_ms: number }} */ (/** @type {any} */ (DEFAULTS)[k]);
    const p = planBudgets.get(k);
    if (p && p !== 'default') out[k] = { test: scaled(p.test, cfg), suite: scaled(p.suite, cfg), source: 'plan' };
    else out[k] = { test: scaled(wholeMs(cfg.get(`test_budgets.${k}.test_ms`, ''), d.test_ms), cfg), suite: scaled(wholeMs(cfg.get(`test_budgets.${k}.suite_ms`, ''), d.suite_ms), cfg), source: 'config' };
  }
  return out;
}

/** The kind a test without a plan bullet gets. @param {Config} cfg */
export function defaultKind(cfg) { const v = cfg.get('test_budgets.default_kind', DEFAULTS.default_kind); return KINDS.includes(v) ? v : DEFAULTS.default_kind; }

/** The duration as text: 0.42 ms, 12 ms. @param {number} ms */
export const fmtMs = (ms) => `${Number(ms.toFixed(2))} ms`;

/**
 * The tests with their kind and the budget findings. A test over its test budget is a finding that names the test and its measured duration; the sum of the
 * durations of one kind over its suite budget is a finding of the suite.
 * @param {Array<{ name: string, ms: number }>} durations @param {Array<{ name: string, kind: string }>} names @param {Config} cfg
 * @param {Map<string, { test: number, suite: number } | 'default'>} planBudgets
 * @returns {{ tests: Array<{ name: string, kind: string, ms: number }>, findings: string[], table: ReturnType<typeof budgetTable> }}
 */
export function budgetCheck(durations, names, cfg, planBudgets) {
  const table = budgetTable(cfg, planBudgets);
  const fb = defaultKind(cfg);
  /** @type {Map<string, { name: string, kind: string, ms: number }>} */ const byName = new Map();
  for (const d of durations) byName.set(d.name, { name: d.name, kind: kindOf(d.name, names, fb), ms: d.ms });
  const tests = [...byName.values()];
  /** @type {string[]} */ const findings = [];
  /** @type {Record<string, { sum: number, n: number }>} */ const suites = {};
  for (const t of tests) {
    const b = table[t.kind];
    (suites[t.kind] ??= { sum: 0, n: 0 }).sum += t.ms;
    suites[t.kind].n++;
    if (t.ms > b.test) findings.push(`BUDGET test "${t.name}" (${t.kind}) took ${fmtMs(t.ms)}, over its ${b.test} ms test budget (${b.source})`);
  }
  for (const k of KINDS) {
    const s = suites[k];
    if (s && s.sum > table[k].suite) findings.push(`BUDGET suite ${k} took ${fmtMs(s.sum)} for ${s.n} test(s), over its ${table[k].suite} ms suite budget (${table[k].source})`);
  }
  return { tests, findings, table };
}

// ---- stability: the double run (AC-5) -----------------------------------------------------------------------------------------------

/** @param {Config} cfg @returns {{ ratio: number, floorMs: number }} */
export function toleranceOf(cfg) {
  const r = cfg.get('test_stability.ratio', '');
  const f = cfg.get('test_stability.floor_ms', '');
  return {
    ratio: /^[0-9]+(\.[0-9]+)?$/.test(r) && Number(r) >= 1 ? Number(r) : DEFAULTS.stability.ratio,
    floorMs: scaled(wholeMs(f, DEFAULTS.stability.floor_ms), cfg),
  };
}

/** Two durations agree when they differ by no more than the absolute floor OR by no more than the ratio. @param {number} a @param {number} b @param {{ ratio: number, floorMs: number }} tol */
export function withinTolerance(a, b, tol) {
  const lo = Math.min(a, b); const hi = Math.max(a, b);
  return hi - lo <= tol.floorMs || hi <= lo * tol.ratio;
}

/**
 * The recorded per-test durations rest on the agent's word, so they are checked against the one thing the control plane measured: the command's wall time. Their sum
 * cannot be larger than the time the whole command took by more than the tolerance (the floor AND the ratio, so a parallel runner's small overlap does not trip it).
 * Too small a sum is not checked: a command's start-up alone makes its wall time larger than its tests, so there is no sound bound (A275, accepted limit).
 * @param {number} sumMs @param {number} wallMs @param {{ ratio: number, floorMs: number }} tol
 */
export function durationsExceedWall(sumMs, wallMs, tol) { return sumMs - wallMs > tol.floorMs && sumMs > wallMs * tol.ratio; }

/** @typedef {{ status: number, ms: number, timedOut?: boolean }} RunResult */

/**
 * Each command runs twice, one after the other, on the same tree. A different exit status, a run that does not pass (GREEN recorded a pass), a run that hit the
 * time limit, or two durations outside the tolerance is a STABILITY finding; the first command with a finding stops the loop (the run stops). Nothing is retried.
 * @param {string[]} commands @param {(command: string) => RunResult} runner @param {{ ratio: number, floorMs: number }} tol
 * @returns {{ findings: string[], runs: Array<{ command: string, results: RunResult[] }> }}
 */
export function doubleRun(commands, runner, tol) {
  /** @type {string[]} */ const findings = [];
  /** @type {Array<{ command: string, results: RunResult[] }>} */ const runs = [];
  for (const command of commands) {
    const a = runner(command);
    if (a.timedOut === true) { runs.push({ command, results: [a] }); findings.push(`STABILITY \`${command}\` hit the time limit on run 1; the double run must fit the same timeouts (verification.command_timeout_seconds times timeouts.scale)`); break; }
    const b = runner(command);
    runs.push({ command, results: [a, b] });
    if (b.timedOut === true) findings.push(`STABILITY \`${command}\` hit the time limit on run 2 after ${fmtMs(a.ms)} on run 1; the double run must fit the same timeouts`);
    else if (a.status !== b.status) findings.push(`STABILITY \`${command}\` exited ${a.status} on run 1 and ${b.status} on run 2 of the same commit`);
    else if (a.status !== 0) findings.push(`STABILITY \`${command}\` exited ${a.status} on both runs, but its GREEN evidence records a pass`);
    else if (!withinTolerance(a.ms, b.ms, tol)) findings.push(`STABILITY \`${command}\` took ${fmtMs(a.ms)} on run 1 and ${fmtMs(b.ms)} on run 2 of the same commit, outside the tolerance (ratio ${tol.ratio}, floor ${tol.floorMs} ms)`);
    if (findings.length > 0) break;
  }
  return { findings, runs };
}

/** The real runner: the project's command in the project root, output discarded, stopped at `limitSeconds` with SIGKILL and its whole process group killed (a command that ignores TERM cannot outlive the limit or leave children; a timed-out run is exit 124, never a pass). @param {Context} ctx @param {number} limitSeconds @returns {(command: string) => RunResult} */
export function realRunner(ctx, limitSeconds) {
  return (command) => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'proofline-stability-'));
    const fd = openSync(`${dir}/out`, 'w');
    try {
      const t0 = monoMs();
      const r = proc.runUserCommand(command, { cwd: ctx.root, env: ctx.childEnv(), input: '', stdio: ['pipe', fd, fd], timeoutMs: limitSeconds * 1000, group: true, killSignal: 'SIGKILL' });
      const ms = monoMs() - t0;
      return r.timedOut === true ? { status: 124, ms, timedOut: true } : { status: r.status, ms };
    } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
  };
}

// ---- a retry in the project's own CI (reported, never used) ---------------------------------------------------------------------------

/**
 * The test_retry rules of ecosystems.json (`global.test_retry`: file glob, line pattern, what it is), as data.
 * @param {Context} ctx @returns {Array<{ file: string, pattern: string, what: string }>}
 */
export function retryRules(ctx) {
  const rows = ecosystemRows(ctx) ?? [];
  /** @type {Map<string, Record<string, string>>} */ const by = new Map();
  for (const [id, p, v] of rows) {
    const m = /^test_retry\.(\d+)\.(file|pattern|what)$/.exec(p);
    if (id !== '*' || !m) continue;
    const o = by.get(m[1]) ?? {}; o[m[2]] = v; by.set(m[1], o);
  }
  return [...by.values()].filter((o) => o.file && o.pattern && o.what).map((o) => ({ file: o.file, pattern: o.pattern, what: o.what }));
}

/**
 * Where the project's own CI or test-runner configuration retries a test: `<file>:<line> <what>`. Reported only. A rule whose pattern is not a regular expression is skipped.
 * @param {Context} ctx @returns {string[]}
 */
export function retriesInProject(ctx) {
  const rules = retryRules(ctx);
  if (rules.length === 0) return [];
  const ls = git(ctx, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (ls.status !== 0) return [];
  const files = ls.out.split('\0').filter((f) => f !== '');
  /** @type {string[]} */ const out = [];
  for (const r of rules) {
    let re;
    try { re = new RegExp(r.pattern); } catch { continue; }
    for (const f of files) {
      if (!pathMatches(f, r.file)) continue;
      let text;
      try { text = readFileSync(`${ctx.root}/${f}`, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && out.length < 20; i++) if (lines[i].length < 2000 && re.test(lines[i])) { out.push(`${f}:${i + 1} ${r.what}`); break; }
    }
  }
  return out;
}

// ---- the run: one report ----------------------------------------------------------------------------------------------------------------

/** Does this run carry the measurement stamp (`measure=1` on the start row of its sealed ledger)? A run started before the stamp existed does not. @param {Context} ctx @param {string} id */
export function measureRequired(ctx, id) {
  const first = ledgerLines(ctx, runDir(ctx, id)).find((l) => l.includes(' event=start '));
  return first !== undefined && / detail=.*\bmeasure=1(\s|$)/.test(first);
}

/**
 * The measurement of a run: the durations and budget findings (needs no process), and the double run when `stability` is given.
 * @param {Context} ctx @param {string} id
 * @param {{ runner?: (command: string) => RunResult }} [opt] runner: when given, the allowed GREEN commands run twice through it
 */
export function measureRun(ctx, id, opt = {}) {
  const dir = runDir(ctx, id);
  const cfg = ctx.config();
  const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  const pk = planKinds(plan);
  const greens = greenRecords(ctx, id);
  const durations = greens.flatMap((g) => g.durations);
  const bc = budgetCheck(durations, pk.names, cfg, pk.budgets);
  /** @type {string[]} */ const stability = [];
  /** @type {string[]} */ const durationBlocks = [];
  /** @type {string[]} */ const notRun = [];
  /** @type {string[]} */ let ran = [];
  /** @type {string[]} */ const blockers = [];
  if (opt.runner) {
    const stamped = measureRequired(ctx, id);
    // a measured run is measured on the plan-listed Verification commands OR the project's own configured test command (it runs the real suite, so it runs the new tests); a configured build, lint or other command never runs the new tests, so being configured is not enough for those
    const configuredTests = ctx.config().cmds('commands.test').filter((c) => c !== '');
    const allowed = new Set(stamped ? [...planVerificationCommands(ctx, id), ...configuredTests] : reproduceAllowed(ctx, id));
    const cmds = [...new Set(greens.map((g) => g.command).filter((c) => c !== ''))];
    const todo = cmds.filter((c) => allowed.has(c));
    for (const c of cmds) {
      if (allowed.has(c)) continue;
      // a run that carries the measurement stamp is measured on a plan-listed command or the configured test command: the implementer's own string never decides
      if (stamped) {
        const doThis = configuredTests.length > 0
          ? `re-record GREEN with the project test command (${configuredTests.map((t) => `\`${t}\``).join(' or ')}) or a command the plan lists under ## Verification commands; no plan amendment is needed for that`
          : "no test command is configured (commands.test) and the plan lists none for this command, so a plan amendment and a refreeze must list the narrow command that runs the new or changed tests in ## Verification commands";
        blockers.push(`the GREEN command \`${c}\` is neither an entry of the plan's ## Verification commands nor the configured test command (a configured build or lint command does not count: it does not run the new tests), so it cannot be run twice: ${doThis}`);
      } else notRun.push(c);
    }
    if (todo.length > 0) {
      const before = headSha(ctx);
      const tol = toleranceOf(cfg);
      const dr = doubleRun(todo, opt.runner, tol);
      stability.push(...dr.findings);
      ran = dr.runs.map((r) => r.command);
      for (const r of dr.runs) {
        if (r.results.length < 2 || stability.length > 0) continue;
        // a test recorded again replaces its earlier number (the latest GREEN record of the command wins), so a re-recorded honest duration clears an earlier made-up one
        /** @type {Map<string, number>} */ const latest = new Map();
        for (const g of greens) if (g.command === r.command) for (const d of g.durations) latest.set(d.name, d.ms);
        const sum = [...latest.values()].reduce((a, ms) => a + ms, 0);
        const wall = Math.max(r.results[0].ms, r.results[1].ms);
        if (durationsExceedWall(sum, wall, tol)) durationBlocks.push(`DURATIONS the recorded test durations of \`${r.command}\` add up to ${fmtMs(sum)}, but the whole command took at most ${fmtMs(wall)} when the control plane ran it: the recorded numbers are not from a real run`);
      }
      const after = headSha(ctx);
      if (before !== after) stability.push('STABILITY the commit changed during the double run; both runs must see the same commit');
    }
    if (stamped && greens.length > 0 && ran.length === 0 && blockers.length === 0) blockers.push('no GREEN command of this run could be run twice: record GREEN with the project test command or a command the plan lists under ## Verification commands');
  }
  return { tests: bc.tests, budgetFindings: bc.findings, stability, durationBlocks, blockers, notRun, ran, retries: opt.runner ? retriesInProject(ctx) : [], table: bc.table, limit: verifyCommandTimeout(cfg) };
}
