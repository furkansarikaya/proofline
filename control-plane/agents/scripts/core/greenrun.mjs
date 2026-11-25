// @ts-check
// The control plane records GREEN itself (A358, issue 338 item B9). Until now the implementer ran the tests, copied each duration into a `worker-evidence GREEN` form, and the IMPLEMENTED
// handoff refused the form for a missing duration, a duration that did not fit the wall time, a budget or a command the plan did not list (retro: 6 refusals in 3 of 8 tasks, about 15 to 25
// minutes per batch). Now `handoff IMPLEMENTED` runs the plan-listed Verification commands ONCE itself, reads the per-test durations from their output, and records them as GREEN evidence keyed
// by the plan's quoted test names. The control plane's own run is the evidence (Core invariant 4); an agent's claim is not. The only refusals here are a plan-listed command that FAILS or times
// out (a listed test fails). A command that exits 0 but ran no test (its output has no per-test line) is not GREEN: nothing is recorded for it and the older checks apply unchanged.
import { fail, ProoflineError } from './errors.mjs';
import { approvedMeasureTargets, matchPlanDurations, runnerEntries, runPlanCommand } from './evidencerepair.mjs';
import { recordControlGreen } from './gatecmd.mjs';
import { taskPatchFingerprint } from './gates.mjs';
import { ledgerIf } from './lifecycle.mjs';
import { fieldOf, fileLines, fileText, gatesEnforced } from './records.mjs';
import { planVerificationCommands } from './resultutil.mjs';
import { runDir } from './runs.mjs';
import { controlGreenFor, controlGreenToken, greenRecords, measureRequired, planKinds } from './testmeasure.mjs';
import { verifyCommandTimeout } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/**
 * Run the plan-listed commands once and record the durations of the plan-named tests. Returns true when the control plane's own GREEN covers this content (recorded now or before).
 * Returns false (nothing changed) when the run does not take part: no measurement stamp, no plan-named test, no plan-listed command, no earlier GREEN record to take the target from, or an
 * output without a per-test duration for any plan-named test.
 * @param {Context} ctx @param {string} id @param {string} patch the task patch fingerprint of the content being handed off
 */
export function controlPlaneGreen(ctx, id, patch) {
  const dir = runDir(ctx, id);
  if (!measureRequired(ctx, id) || !gatesEnforced(ctx, dir)) return false;
  const names = [...new Set(planKinds(fileText(ctx, `${dir}/PLAN.md`) ?? '').names.map((n) => n.name))];
  const commands = planVerificationCommands(ctx, id);
  if (names.length === 0 || commands.length === 0) return false;
  if (controlGreenFor(ctx, id, patch)) return true;
  const excused = approvedMeasureTargets(ctx, id);
  const want = names.filter((n) => !excused.includes(n) && !n.includes('=') && !n.includes(';'));
  if (want.length === 0) return false;
  const greens = greenRecords(ctx, id);
  const last = greens[greens.length - 1];
  const target = last === undefined ? '' : fieldOf(fileLines(ctx, `${dir}/worker-evidence/${last.file}`), 'target');
  if (target === '') return false;
  const limit = verifyCommandTimeout(ctx.config());
  /** @type {Array<{ command: string, entries: Array<{ name: string, ms: number }> }>} */ const outputs = [];
  for (const command of commands) {
    const r = runPlanCommand(ctx, command, limit);
    if (r.timedOut) fail(`IMPLEMENTED blocked: the control plane ran the plan-listed command \`${command}\` itself and it hit the time limit (${limit} s); nothing was recorded`);
    if (r.status !== 0) fail(`IMPLEMENTED blocked: the control plane ran the plan-listed command \`${command}\` itself and it exited ${r.status}: a listed test fails. Fix it (a failing test is a normal fix), then record IMPLEMENTED again`);
    outputs.push({ command, entries: runnerEntries(r.text) });
  }
  // the memoised patch, change lists and reads are dropped, so a path a command dirtied or created is seen
  for (const k of ['patch:', 'changed:', 'fp:', 'file:', 'hash:', 'git:']) ctx.forget(k);
  if (taskPatchFingerprint(ctx, dir) !== patch) fail('IMPLEMENTED blocked: a plan-listed command changed the application/test tree while the control plane ran it; nothing was recorded (a command of the plan must not write to the tree)');
  /** @type {Array<{ command: string, durations: string }>} */ const records = [];
  const taken = new Set();
  for (const o of outputs) {
    const part = matchPlanDurations(want.filter((n) => !taken.has(n)), o.entries).found;
    for (const n of part.keys()) taken.add(n);
    // keyed by the plan's own quoted name: the later steps (budgets, the double run, REVIEW_TESTS) match by that name
    if (part.size > 0) records.push({ command: o.command, durations: [...part].map(([n, e]) => `${n}=${e.ms}`).join('; ') });
  }
  if (records.length === 0) {
    ctx.err(`note: the control plane ran the plan-listed command(s) once, but their output shows no per-test duration for a plan-named test (a command that runs no test is not GREEN); the recorded GREEN evidence is checked as before\n`);
    return false;
  }
  try {
    for (const r of records) recordControlGreen(ctx, id, r.command, target, r.durations);
  } catch (e) {
    if (!(e instanceof ProoflineError)) throw e;
    ctx.err(`note: the control plane's own GREEN record was refused (${e.message.split('\n')[0]}); the recorded GREEN evidence is checked as before\n`);
    return false;
  }
  ctx.forget('file:');
  ledgerIf(ctx, id, 'green-control', '-', '-', `token=${controlGreenToken(ctx, id, patch)} commands=${records.length} tests=${taken.size}/${want.length}`);
  ctx.err(`GREEN recorded by the control plane: ${taken.size} of ${want.length} plan-named test(s) from its own run of ${records.length} plan-listed command(s) (durations keyed by the plan's test names)\n`);
  return true;
}
