// @ts-check
// Helpers of tests/core/lifecycle-s2.test.mjs (lifecycle-test.sh scenario_terminal .. scenario_reopen_blocked_and_state). Only what harness.mjs does not have.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, accepted, cached, cleanEnv, codeKey, copyOf, gateOwner, qaBind, say, scaffold, tmp, tsha } from '../lib/harness.mjs';

/** @typedef {import('../lib/harness.mjs').Result} Result */

export { A };
/** A as a role. @param {string} dir @param {string} role @param {string[]} args @param {{ input?: string, env?: Record<string, string> }} [o] */
export const AS = (dir, role, args, o = {}) => A(dir, args, { ...o, role });
/** A that throws when refused. @param {string} dir @param {string[]} args @param {Parameters<typeof A>[2]} [o] */
export function must(dir, args, o) { const r = A(dir, args, o); if (r.status !== 0) throw new Error(`agent.sh ${args.join(' ')} failed (${r.status}): ${r.text}`); return r; }
/** The value of a `key=value` line of `pipeline LC`. @param {string} dir @param {string} key */
export function pipe(dir, key) {
  const m = new RegExp(`^${key.replace(/[.]/g, '\\.')}=(.*)$`, 'm').exec(A(dir, ['pipeline', 'LC']).out);
  return m ? m[1] : '';
}

// ---- the fixture verbs of the harness, driven through the Node core (see A above) ---------------------------------------------------------------
const gateFocus = (/** @type {string} */ g) => ({ REVIEW_SMALL: 'rules+tests', REVIEW_PLAN: 'plan', REVIEW_RULES: 'rules', REVIEW_TESTS: 'tests', REVIEW_DATA: 'data' })[g] ?? '';
const reportPath = (/** @type {string} */ g) => ({
  REVIEW_PLAN: 'reviews/proof-review/plan/REPORT.md', REVIEW_RULES: 'reviews/proof-review/rules/REPORT.md', REVIEW_SMALL: 'reviews/proof-review/small/REPORT.md',
  REVIEW_TESTS: 'reviews/test-trust/tests/REPORT.md', REVIEW_DATA: 'reviews/data-design/REVIEW.md', SECURITY: 'security/REPORT.md', QA: 'QA_REPORT.md', VERIFY: 'VERIFY.md',
})[g] ?? '';
/** A result file for a gate (rows "id|severity|path:line|finding|evidence"), as harness `resultFor`. @param {string} dir @param {string} gate @param {string} res @param {string[]} [rows] @param {{ confidence?: string }} [opt] */
export function resultFor(dir, gate, res, rows = [], opt = {}) {
  const art = reportPath(gate); const fc = gateFocus(gate);
  const run = path.join(dir, '.agents/runs/LC');
  mkdirSync(path.dirname(path.join(run, art)), { recursive: true });
  writeFileSync(path.join(run, art), `# ${gate} report\n\nVerdict: ${res}\n\nJudged the whole current tree.\n`);
  const fingerprint = must(dir, ['fingerprint', 'LC']).out.replace(/\n+$/, '');
  const f = path.join(tmp('r'), 'result.md');
  const head = [`ROLE: ${gateOwner(gate)}`, 'TASK: LC', ...(fc ? [`FOCUS: ${fc}`] : []), `RESULT: ${res}`, `CONFIDENCE: ${opt.confidence ?? 'high'}`, `FINGERPRINT: ${fingerprint}`, `ARTIFACT: ${art} ${tsha(path.join(run, art))}`, ''];
  const table = ['| id | severity | path:line | finding | evidence |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.replace(/\|/g, ' | ')} |`)];
  writeFileSync(f, `${head.join('\n')}\n${table.join('\n')}\n`);
  return f;
}
/** `rec` that does not throw: the result file for the gate recorded as its owner, the answer of `record` returned. @param {string} dir @param {string} gate @param {string} res @param {string[]} [rows] @param {{ confidence?: string }} [opt] */
export function recTry(dir, gate, res, rows = [], opt = {}) {
  return AS(dir, gateOwner(gate), ['record', 'LC', '--file', resultFor(dir, gate, res, rows, opt)]);
}
/** @param {string} dir @param {string} gate */
export const gpass = (dir, gate) => accepted(recTry(dir, gate, 'PASS'), `record ${gate} PASS`);
/** One blocking finding on a path (the rules gates also record how they scanned, A171). @param {string} dir @param {string} gate @param {string} fixPath */
export function gfail(dir, gate, fixPath) {
  const ev = gate === 'REVIEW_RULES' || gate === 'REVIEW_SMALL' ? `traced: empty key -> nil; scan: grep -n lookup ${fixPath}; instances: single` : 'traced: empty key -> nil';
  return accepted(recTry(dir, gate, 'FAIL', [`${gate}-1|blocking|${fixPath}:1|lookup returns the wrong value for an empty key|${ev}`]), `record ${gate} FAIL`);
}
/** Pass every gate the pipeline requires, then every risk focus (none in these fixtures), then VERIFY. @param {string} dir */
export function passAll(dir) {
  for (const g of pipe(dir, 'gates').split(/\s+/).filter(Boolean)) {
    if (g === 'VERIFY') continue;   // A171: VERIFY runs after the gates it depends on
    if (g === 'SECRETS') must(dir, ['secret-scan', 'LC']); else gpass(dir, g);
  }
  if (/^focus\./m.test(A(dir, ['pipeline', 'LC']).out)) throw new Error('a risk focus is open: this port has no focus fixture');
  gpass(dir, 'VERIFY');
}
/** Orchestrated: a window, the line appended to the file, the worker's evidence, close. @param {string} dir @param {string} phase @param {string} res @param {string} file @param {string} line */
export function worker(dir, phase, res, file, line) {
  const w = must(dir, ['window-open', 'LC']).out.replace(/\n+$/, '');
  appendFileSync(path.join(dir, file), `${line}\n`); wev(dir, phase, res, 'implementer'); must(dir, ['window-close', 'LC', w, '0']);
}
/** Standalone: the lead implements and records its own evidence. @param {string} dir @param {string} phase @param {string} res @param {string} file @param {string} line @param {string} [target] */
export function solo(dir, phase, res, file, line, target) {
  appendFileSync(path.join(dir, file), `${line}\n`); wev(dir, phase, res, undefined, target);
}
/** @param {string} dir @param {string} phase @param {string} res @param {string} [role] @param {string} [target] */
function wev(dir, phase, res, role, target) {
  const ef = phase === 'RED' ? 'expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet' : '';
  return must(dir, ['worker-evidence', 'LC', phase, res], { input: `command: go test ./...\ntarget: ${target ?? 'impl.txt,impl_test.txt'}\n${ef}\n`, ...(role ? { role } : {}) });
}
/** Drive a scaffolded run (frozen, IMPLEMENTING) to CODE_DONE. @param {string} dir @param {string} topology */
export function toCodeDone(dir, topology) {
  const step = topology === 'orchestrated' ? worker : solo;
  step(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  step(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(dir, ['handoff', 'LC', 'IMPLEMENTED']); passAll(dir); must(dir, ['handoff', 'LC', 'CODE_DONE']);
}
/** The completion report of the fixtures. @param {string} dir @param {string[]} extra */
export function writeReport(dir, ...extra) {
  const ls = ['# Completion Report: LC', '', '## Implementation Summary', 'impl.txt and impl_test.txt changed under the lifecycle gates.', '', '## TDD Evidence', 'RED then GREEN recorded by the expected implementation owner.', '',
    '## Verification', 'All gates passed on the final tree.', '', '## Assumptions', 'none', '', '## Review Result', 'Approved on the final tree.', '', '## QA Result', 'Every frozen QA scenario passed on the final tree.', '',
    '## Execution', 'Not applicable in fixtures.', '', '## Known Limitations / Follow-up', 'None.', ...extra];
  writeFileSync(path.join(dir, '.agents/runs/LC/COMPLETION_REPORT.md'), `${ls.join('\n')}\n`);
}
/** knowledge done, the completion report, published and handed off DONE. @param {string} dir @param {string[]} extra */
export function finishDone(dir, ...extra) {
  must(dir, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  writeReport(dir, ...extra);
  must(dir, ['publish-completion-report', 'LC', 'markdown']);
  must(dir, ['handoff', 'LC', 'DONE']);
}

/** File text of a project path. @param {string} d @param {string} f */
export const rd = (d, f) => readFileSync(path.join(d, f), 'utf8');
/** Write a project file (parents made). @param {string} d @param {string} f @param {string} t */
export function wr(d, f, t) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); }
/** Names in a project folder (empty when it is missing). @param {string} d @param {string} rel */
export function lsDir(d, rel) { const p = path.join(d, rel); return existsSync(p) ? readdirSync(p).sort() : []; }
/** The lines of a text. @param {string} t */
export const lines = (t) => t.split('\n');
/** `$(cat FILE)`: the text without trailing newlines. @param {string} t */
export const subst = (t) => t.replace(/\n+$/, '');

/** The newest `requested_at`, gate `epoch` or `asked_at` of the project's records. @param {string} dir */
function newestRecord(dir) {
  let t = 0;
  for (const d of [`${dir}/.agents/runs/LC/approvals`, `${dir}/.agents/local/approvals`, `${dir}/.agents/runs/LC/gates`, `${dir}/.agents/runs/LC/questions`]) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) { const m = /^(?:requested_at|epoch|asked_at): (\d+)/m.exec(readFileSync(`${d}/${n}`, 'utf8')); if (m) t = Math.max(t, Number(m[1])); }
  }
  return t;
}
/**
 * The user's message as the prompt hook stores it, stamped ONE second after the newest record of the project: newer than every request, never more than a
 * second past the clock (the control plane ignores a capture more than 5 s in the future), and nothing waits for the clock.
 * @param {string} dir @param {string} text
 */
export function sayNow(dir, text) {
  const newest = newestRecord(dir);
  let time = newest > 0 ? newest + 1 : Math.floor(Date.now() / 1000);
  while (said.has(`${dir}|${time}|${text}`)) time++;   // the same words at the same second would be the same capture event (single-use, A106)
  said.add(`${dir}|${time}|${text}`);
  return say(dir, text, { time });
}
/** @type {Set<string>} */ const said = new Set();
/** The user's reply to a request: request, the message, approve. @param {string} dir @param {string} kind @param {string} text */
export function approve(dir, kind, text) {
  accepted(A(dir, ['request-approval', 'LC', kind]), `request ${kind}`);
  sayNow(dir, text);
  accepted(A(dir, ['approve', 'LC', kind]), `approve ${kind}`);
}

/** A live process that is not a child of this one (started by a shell that exits at once), so a killed process is reaped by init, not left a zombie. @returns {number} */
export function startSleeper() {
  const r = spawnSync('sh', ['-c', 'sleep 120 >/dev/null 2>&1 </dev/null & echo $!'], { encoding: 'utf8', env: cleanEnv({}) });
  const pid = Number(r.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`no sleeper: ${r.stdout}${r.stderr}`);
  return pid;
}
/** Kill it and wait (on the process, not on a clock) until the pid is gone. @param {number} pid */
export function stopSleeper(pid) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ }
  const c = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 4000; i++) {
    try { process.kill(pid, 0); } catch { return; }
    Atomics.wait(c, 0, 0, 5);
  }
  throw new Error(`process ${pid} did not exit`);
}

/** git in the project with its status (the harness `git` only returns stdout). @param {string} dir @param {string[]} args @returns {Result} */
export function gitRun(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, env: cleanEnv({}), encoding: 'utf8' });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', text: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** A FAILED orchestrated run (A152): QA and REVIEW_SMALL pass on the final content, VERIFY fails on it; built once and copied. */
export function failedRun() {
  return copyOf(cached(`l2b-failed-${codeKey()}`, (work) => {
    const d = scaffold({ topology: 'orchestrated', testCrit: 'AC-2', taskExtra: '- AC-2: second behavior' });
    worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
    must(d, ['handoff', 'LC', 'IMPLEMENTED']); gfail(d, 'REVIEW_SMALL', 'impl_test.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    worker(d, 'FIX', 'pass', 'impl_test.txt', 'test: default for an empty key'); must(d, ['handoff', 'LC', 'IMPLEMENTED']); gfail(d, 'QA', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt'); must(d, ['handoff', 'LC', 'IMPLEMENTED']); gpass(d, 'REVIEW_SMALL'); gpass(d, 'QA'); gfail(d, 'VERIFY', 'impl.txt');
    must(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gates/*-VERIFY.yaml fail on the third content\n' });
    cpSync(d, work, { recursive: true }); rmSync(d, { recursive: true, force: true });
  }));
}
