// @ts-check
// Repository self-test runner (D27 layer 1): runs the shell suites that are not ported yet, the control-plane suites
// control-plane/agents/scripts/*-test.sh and the repository suites tests/*/*-test.sh (enforcement, generator, cli, ...). Each suite builds its own
// throwaway repositories under $TMPDIR. (The Node tests run by `node --test`, in the node-tests job; this runner is for the shell units that remain.)
// A suite that lists its scenarios (`run_sc NAME` lines, or a `scenarios='...'` line) is split into one unit per scenario; every unit is an
// independent child process with its own log, in its own process group (a unit that outlives SELFTEST_UNIT_TIMEOUT seconds is killed with its whole
// group and fails). Units run in parallel on all cores (SELFTEST_JOBS overrides the count), so the wall time is the total work divided by the cores (A76).
// Run locally (CI unset) it uses half the cores (min 1) and runs every unit under `nice -n 10` (when nice exists), so the machine stays usable; with
// CI set (GitHub Actions) the count is all cores and nothing is niced.
//   SELFTEST_ONLY=<name>   runs the suite with that name (e.g. lifecycle-test); a value matching no name exactly selects every suite whose name contains it.
//   SELFTEST_SHARD=I/N     runs only shard I of N (CI splits the work over N jobs); units are spread by the weights in tests/selftest-weights.txt (A109).
//   SELFTEST_LIST=1        prints the shard's units (suite path relative to the repository, `|`, scenario) and exits (no test runs); =weights prefixes the
//                          weight each unit was given. A unit missing from the weights file weighs the median of the listed.
//   SELFTEST_WEIGHTS=FILE  weights file to use instead of tests/selftest-weights.txt.
//   SELFTEST_TIMES_FILE=F  appends one line "<seconds> <suite> [scenario]" per unit this run executed; tests/selftest-weights.mjs merges such files
//                          into tests/selftest-weights.txt.
//   SELFTEST_TEMPLATE_DIR  cache of installed template repositories shared by the units of one run (default: inside the run's own log directory,
//                          removed at the end); each scenario copies a template, never shares one.
//   SELFTEST_SLOWEST=K     prints the K slowest units (default 5); K=999 lists every unit to refresh the weights.
//   SELFTEST_UNIT_TIMEOUT=S  seconds a unit may run (default 1800); expiry kills the unit's process group and is a failure.
//   LC_ONLY=<substring>    runs only the scenarios whose line contains it.
// Prints one PASS/FAIL line per suite, the failing unit's log tail, the slowest units and a pass/total summary.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = import.meta.dirname;
export const root = path.resolve(here, '..');

/** @typedef {{ suite: string, scen: string }} Unit  suite: path relative to the repository (forward slashes); scen: '' for an unsplit suite */

/** Byte-order comparison (the C locale glob order). @param {string} a @param {string} b */
const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The shell suites in run order: control-plane/agents/scripts/*-test.sh, then tests/<dir>/*-test.sh. @param {string} [rootDir] @returns {string[]} */
export function allSuites(rootDir = root) {
  /** @type {string[]} */ const out = [];
  const take = (/** @type {string} */ rel) => {
    const dir = path.join(rootDir, rel);
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir).filter((x) => x.endsWith('-test.sh')).sort(byBytes)) out.push(`${rel}/${n}`);
  };
  take('control-plane/agents/scripts');
  const t = path.join(rootDir, 'tests');
  for (const d of readdirSync(t, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(byBytes)) take(`tests/${d}`);
  return out;
}

/** The name of a suite: its file name without .sh. @param {string} suite */
export const suiteName = (suite) => path.basename(suite, '.sh');

/** One scenario per line, exactly as run_sc receives it ("name" or "name arg"): `run_sc NAME` lines, then a `scenarios='...'` line. @param {string} text */
export function scenariosOf(text) {
  /** @type {string[]} */ const out = [];
  const lines = text.split('\n');
  for (const l of lines) { const m = /^run_sc ([A-Za-z_].*)$/.exec(l); if (m) out.push(m[1]); }
  for (const l of lines) { const m = /^scenarios='(.*)'$/.exec(l); if (m) out.push(...m[1].split(' ').filter((x) => x !== '')); }
  return out;
}

/**
 * The suites an ONLY value selects: the one called exactly so, else every suite whose name contains it.
 * @param {string[]} all @param {string} only
 */
export function selectSuites(all, only) {
  const exact = all.some((s) => suiteName(s) === only);
  return all.filter((s) => (exact ? suiteName(s) === only : suiteName(s).includes(only)));
}

/** Every unit: unsplit suites first (their length is unknown), then the scenario units in suite order. @param {string[]} suites @param {string} lcOnly @param {string} [rootDir] @returns {Unit[]} */
export function unitsOf(suites, lcOnly, rootDir = root) {
  const scen = new Map(suites.map((s) => [s, scenariosOf(readFileSync(path.join(rootDir, s), 'utf8'))]));
  /** @type {Unit[]} */ const units = [];
  for (const s of suites) if ((scen.get(s) ?? []).length === 0) units.push({ suite: s, scen: '' });
  for (const s of suites) for (const sc of scen.get(s) ?? []) if (!lcOnly || sc.includes(lcOnly)) units.push({ suite: s, scen: sc });
  return units;
}

/** The weights-file key of a unit: the suite name, then the scenario. @param {Unit} u */
export const unitKey = (u) => (u.scen === '' ? suiteName(u.suite) : `${suiteName(u.suite)} ${u.scen}`);

/** The weights of a weights file text: key to seconds, and the median of the listed (15 when none). @param {string} text */
export function parseWeights(text) {
  /** @type {Map<string, number>} */ const wt = new Map(); /** @type {number[]} */ const vals = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+) +(.*?) *$/.exec(line);
    if (!m) continue;
    wt.set(m[2], Number(m[1])); vals.push(Number(m[1]));
  }
  let med = 15;
  if (vals.length > 0) {
    vals.sort((a, b) => a - b);
    const n = vals.length;
    med = n % 2 ? vals[(n + 1) / 2 - 1] : Math.trunc((vals[n / 2 - 1] + vals[n / 2]) / 2);
  }
  return { wt, med };
}

/**
 * Spread the units over N shards by weight (A109): longest first onto the lightest shard (the lowest number on a tie); every unit lands in exactly one
 * shard. Returns the unit indexes of shard ME (1-based), heaviest first (the best start order for the parallel workers), and each unit's weight.
 * @param {Unit[]} units @param {string} weightsText @param {number} me @param {number} n
 */
export function shardOf(units, weightsText, me, n) {
  const { wt, med } = parseWeights(weightsText);
  const weighed = units.map((u, i) => ({ w: wt.get(unitKey(u)) ?? med, i }));
  weighed.sort((a, b) => b.w - a.w || a.i - b.i);
  const load = new Array(n + 1).fill(0);
  /** @type {number[]} */ const mine = [];
  for (const { w, i } of weighed) {
    let b = 1;
    for (let j = 2; j <= n; j++) if (load[j] < load[b]) b = j;
    load[b] += w;
    if (b === me) mine.push(i);
  }
  return { mine, weight: (/** @type {number} */ i) => weighed.find((x) => x.i === i)?.w ?? med };
}

/** The job count: half the cores (min 1) locally, all in CI; SELFTEST_JOBS overrides (non-numeric or 0 gives 4). @param {NodeJS.ProcessEnv} env @param {number} [cores] */
export function jobCount(env, cores = os.availableParallelism?.() ?? os.cpus().length) {
  let c = Number.isInteger(cores) && cores > 0 ? cores : 4;
  const local = !env.CI;
  if (local) c = Math.max(1, Math.floor((c + 1) / 2));
  if (env.SELFTEST_JOBS === undefined) return { jobs: c, local };
  const j = /^[0-9]+$/.test(env.SELFTEST_JOBS) ? Number(env.SELFTEST_JOBS) : 0;
  return { jobs: j > 0 ? j : 4, local };
}

const hasNice = () => process.platform !== 'win32' && spawnSync('nice', ['true'], { stdio: 'ignore' }).status === 0;

/** @type {Set<import('node:child_process').ChildProcess>} */ const live = new Set();
/** Kill a unit's whole process group. @param {import('node:child_process').ChildProcess} c */
function killGroup(c) {
  if (!c.pid) return;
  try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } }
}

/**
 * Run one unit: `sh SUITE` (with LC_EXACT=<scenario> for a scenario unit) in its own process group, output to the log; resolves with the exit code
 * (null when killed by the timeout) and the whole seconds it took.
 * @param {Unit} u @param {string} log @param {{ nice: boolean, timeoutMs: number, rootDir?: string, env?: NodeJS.ProcessEnv }} o
 * @returns {Promise<{ rc: number, secs: number, timedOut: boolean }>}
 */
function runUnit(u, log, o) {
  return new Promise((resolve) => {
    const st = Math.floor(Date.now() / 1000);
    const env = { ...(o.env ?? process.env) };
    if (u.scen) env.LC_EXACT = u.scen; else delete env.LC_EXACT;
    const suite = path.join(o.rootDir ?? root, u.suite);
    const [cmd, args] = o.nice ? ['nice', ['-n', '10', 'sh', suite]] : ['sh', [suite]];
    writeFileSync(log, '');
    const c = spawn(cmd, args, { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    live.add(c);
    c.stdout.on('data', (d) => appendFileSync(log, d));
    c.stderr.on('data', (d) => appendFileSync(log, d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(c); }, o.timeoutMs);
    const done = (/** @type {number} */ rc) => { clearTimeout(timer); live.delete(c); resolve({ rc, secs: Math.floor(Date.now() / 1000) - st, timedOut }); };
    c.on('error', (e) => { appendFileSync(log, `selftest: cannot start the unit: ${e.message}\n`); done(127); });
    c.on('close', (code, sig) => {
      if (timedOut) appendFileSync(log, `\nselftest: the unit ran past ${o.timeoutMs / 1000}s and was killed with its process group\n`);
      done(timedOut ? 124 : code ?? (sig ? 128 : 1));
    });
  });
}

/** Run the indexes with at most `jobs` at a time, in order. @template T @param {number[]} order @param {number} jobs @param {(i: number) => Promise<T>} fn */
async function pool(order, jobs, fn) {
  let next = 0;
  const worker = async () => { while (next < order.length) { const i = order[next++]; await fn(i); } };
  await Promise.all(Array.from({ length: Math.min(jobs, order.length) }, worker));
}

/** @param {string} msg @returns {number} */
const fail = (msg) => { console.error(msg); return 2; };

/**
 * The runner. @param {NodeJS.ProcessEnv} env @param {{ rootDir?: string, write?: (s: string) => void }} [o] @returns {Promise<number>} the exit status
 */
export async function main(env, o = {}) {
  const rootDir = o.rootDir ?? root;
  const write = o.write ?? ((s) => process.stdout.write(s));
  const only = env.SELFTEST_ONLY ?? ''; const lcOnly = env.LC_ONLY ?? '';
  const shard = env.SELFTEST_SHARD ?? '1/1';
  const m = /^([0-9]+)\/([0-9]+)$/.exec(shard);
  if (!m) return fail('selftest: SELFTEST_SHARD must be I/N');
  const shardI = Number(m[1]); const shardN = Number(m[2]);
  if (!(shardI >= 1 && shardI <= shardN)) return fail('selftest: SELFTEST_SHARD must be I/N with 1 <= I <= N');

  const suites = selectSuites(allSuites(rootDir), only);
  if (suites.length === 0) return fail(`selftest: no suite matches '${only}'`);
  const units = unitsOf(suites, lcOnly, rootDir);
  let wfile = env.SELFTEST_WEIGHTS ?? path.join(rootDir, 'tests/selftest-weights.txt');
  if (!existsSync(wfile) || wfile === '/dev/null') wfile = '';
  const { mine, weight } = shardOf(units, wfile ? readFileSync(wfile, 'utf8') : '', shardI, shardN);

  if (env.SELFTEST_LIST) {   // this shard's units (suite|scenario); =weights prefixes the weight
    for (const i of mine) write(`${env.SELFTEST_LIST === 'weights' ? `${weight(i)} ` : ''}${units[i].suite}|${units[i].scen}\n`);
    return 0;
  }

  let logs;
  try { logs = mkdtempSync(path.join(env.TMPDIR || '/tmp', 'proofline-selftest-')); } catch { return fail(`selftest: TMPDIR must be an existing directory: ${env.TMPDIR || '/tmp'}`); }
  const cleanup = () => { try { rmSync(logs, { recursive: true, force: true }); } catch { /* best effort */ } };
  const onSignal = (/** @type {NodeJS.Signals} */ sig) => { for (const c of live) killGroup(c); cleanup(); process.exit(128 + (sig === 'SIGINT' ? 2 : 15)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const childEnv = { ...env };
    if (!childEnv.SELFTEST_TEMPLATE_DIR) childEnv.SELFTEST_TEMPLATE_DIR = path.join(logs, 'templates');   // one installed-template cache for every unit of this run
    const { jobs, local } = jobCount(env);
    const nice = local && hasNice();
    const timeoutS = Number(env.SELFTEST_UNIT_TIMEOUT);
    const timeoutMs = (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 1800) * 1000;

    /** @type {Map<number, { rc: number, secs: number }>} */ const res = new Map();
    const wallStart = Date.now();
    await pool(mine, jobs, async (i) => { res.set(i, await runUnit(units[i], path.join(logs, `${i}.log`), { nice, timeoutMs, rootDir, env: childEnv })); });
    const wall = Math.floor((Date.now() - wallStart) / 1000);

    let pass = 0; let total = 0;
    for (const s of suites) {
      let ok = true; let seen = false; let cases = 0;
      for (const i of mine) {
        if (units[i].suite !== s) continue;
        seen = true;
        const { rc } = res.get(i) ?? { rc: 1 };
        const log = existsSync(path.join(logs, `${i}.log`)) ? readFileSync(path.join(logs, `${i}.log`), 'utf8') : '';
        const c = log.split('\n').filter((l) => /^(ok|PASS|skip) /.test(l)).length;
        cases += c;
        // a scenario unit that ran no case selected nothing: that is a failure, not a pass
        if (rc !== 0 || (units[i].scen !== '' && c === 0)) {
          ok = false;
          write(`FAIL ${suiteName(s)}${units[i].scen ? ` [${units[i].scen}]` : ''} (exit ${rc})\n`);
          const lines = log.split('\n'); if (lines.at(-1) === '') lines.pop();
          write(lines.slice(-15).map((l) => `    ${l}\n`).join(''));
        }
      }
      if (!seen) continue;
      total++;
      if (ok) { pass++; write(`PASS ${suiteName(s)} (${cases} cases)\n`); }
    }
    const times = mine.map((i) => ({ t: res.get(i)?.secs ?? 0, name: suiteName(units[i].suite), scen: units[i].scen }));
    const slowest = [...times].sort((a, b) => b.t - a.t || byBytes(`${b.name} ${b.scen}`, `${a.name} ${a.scen}`)).slice(0, Number(env.SELFTEST_SLOWEST) || 5);
    for (const x of slowest) write(`slowest: ${x.t} ${x.name} ${x.scen}\n`);
    if (env.SELFTEST_TIMES_FILE) appendFileSync(env.SELFTEST_TIMES_FILE, times.map((x) => `${x.t} ${x.name}${x.scen ? ` ${x.scen}` : ''}\n`).join(''));   // the weights file's format
    write(`selftest: ${pass}/${total} suites passed (${mine.length} units, ${jobs} jobs, shard ${shard}, ${wall}s)\n`);
    if (nice) write('selftest: local run, units niced (SELFTEST_JOBS overrides the job count; CI=1 disables the limits)\n');
    return pass === total ? 0 : 1;
  } finally { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); cleanup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.env);
