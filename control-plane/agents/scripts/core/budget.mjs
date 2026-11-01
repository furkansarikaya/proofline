// @ts-check
// Process budgets of the hook: a time budget for one async step, enforced with a timer and an AbortSignal (the shell hook's `hk_budget`
// and the prompt hook's approve loop polled with `sleep` and walked the process tree with `ps`). When the budget ends the step is
// aborted and the result says so the way the shell hook does: status 124 (the `timeout(1)` status `hk_budget` returned), and the texts of
// the shell hook for a stopped step (the log line, the message to the user, the note for `next`). Plain functions, no environment input.
import { runAsync } from './proc.mjs';

/** The status `hk_budget` returns when the budget ended the step. */
export const BUDGET_STATUS = 124;
/** After the abort, how long the step is given to settle before the result is reported anyway. */
export const SETTLE_GRACE_MS = 1000;

/**
 * @template T
 * @typedef {{ timedOut: false, value: T } | { timedOut: true, status: 124 }} BudgetResult
 */

/**
 * Run `step` and stop waiting for it after `seconds`. The step receives an AbortSignal and must stop its work when it aborts (a child
 * process started with that signal is stopped by proc.mjs). Reported on expiry as soon as the step has settled, or after
 * SETTLE_GRACE_MS. A step that throws before the budget ends throws here; one that fails after the abort is the timeout.
 * @template T
 * @param {number} seconds the budget (fractions allowed); a budget of 0 or less ends at once
 * @param {(signal: AbortSignal) => Promise<T>} step
 * @returns {Promise<BudgetResult<T>>}
 */
export async function withBudget(seconds, step) {
  const ac = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve(true); }, Math.max(0, seconds) * 1000); });
  const running = Promise.resolve().then(() => step(ac.signal));
  try {
    const first = await Promise.race([running.then((value) => ({ value })), expired.then(() => null)]);
    if (first) return { timedOut: false, value: first.value };
    // the budget ended first: let the step settle (it was told to stop), but never wait for it longer than the grace
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let g;
    await Promise.race([running.then(() => {}, () => {}), new Promise((r) => { g = setTimeout(r, SETTLE_GRACE_MS); })]);
    clearTimeout(g);
    return { timedOut: true, status: BUDGET_STATUS };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a program under a budget (`hk_budget SECS OUTFILE CMD...`): the child leads its own process group, so on expiry it and everything
 * it started are stopped by the kernel's group signal, not by walking `ps`. `status` is 124 on expiry, else the program's own status.
 * The program and arguments come from the caller's code, never from model-controlled text.
 * @param {number} seconds @param {string} program @param {string[]} args @param {import('./proc.mjs').ProcOptions} [options]
 * @returns {Promise<{ timedOut: boolean, status: number, stdout: Buffer, stderr: Buffer }>}
 */
export async function runWithBudget(seconds, program, args, options = {}) {
  const r = await withBudget(seconds, (signal) => runAsync(program, args, { ...options, signal, group: true }));
  if (r.timedOut) return { timedOut: true, status: BUDGET_STATUS, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const done = /** @type {{ timedOut: false, value: import('./proc.mjs').ProcResult }} */ (r);
  return { timedOut: false, status: done.value.status, stdout: done.value.stdout, stderr: done.value.stderr };
}

// ---- the texts of the shell hook for a stopped step (adapters/claude/hooks/proofline-hook.sh) -------------------------------------

/** `hk_timeout_msg`: what to tell the user when the approval step was stopped; `recorded` = an approval record from this very message exists. @param {boolean} recorded */
export function approvalTimeoutMessage(recorded) {
  return recorded
    ? "proofline: your approval was recorded (the approval step ran past the hook's time budget but finished writing it)."
    : 'proofline: your approval could not be recorded, send it again (the approval step ran out of time).';
}

/** The line appended to approve.log when the approval step is stopped. @param {string} isoUtc `YYYY-MM-DDTHH:MM:SSZ` @param {number} seconds @param {string} [worktreeRun] the run id for the worktree form */
export function approvalStopLogLine(isoUtc, seconds, worktreeRun) {
  return worktreeRun === undefined
    ? `${isoUtc} approval step stopped after ${seconds}s (prompt hook budget)`
    : `${isoUtc} approval step of worktree run ${worktreeRun} stopped after ${seconds}s (prompt hook budget)`;
}

/** The session hook's note when `next` did not finish in its budget (status 124). @param {string} act the active run id */
export function nextTimeoutNote(act) {
  return `run sh .agents/scripts/agent.sh next ${act} (the session check did not finish within the hook's time budget)`;
}

/** `hk_line`: one line of .agents/local/hook-times, `epoch|name|ms|result|note`. @param {number|string} epoch @param {string} name @param {number} ms @param {string} result @param {string} [note] */
export function hookTimeLine(epoch, name, ms, result, note = '') { return `${epoch}|${name}|${ms}|${result}|${note}`; }

/** The result and note of a hook-times line for a step the budget stopped. */
export const BUDGET_STOP_RESULT = Object.freeze({ result: 'timeout', note: 'stopped-by-hook-budget' });

/**
 * `hk_cfgnum KEY DEFAULT MIN MAX`: a hook knob read straight from the text of .agents/config.yaml (section `hook:`, two-space keys): the
 * last matching line wins, a comment and blanks/quotes are dropped, leading zeros are not octal, a value that is not a number is the
 * default, six digits or more is the maximum, else the number is moved into [min, max]. No setting can switch a budget off.
 * @param {string|null} configText the file's text, or null when the file does not exist @param {string} key @param {number} def @param {number} min @param {number} max
 */
export function hkCfgNum(configText, key, def, min, max) {
  let v = String(def); let inHook = false;
  if (configText === null) return def;
  for (const line of configText.split('\n')) {
    if (line.startsWith('hook:')) { inHook = true; continue; }
    if (line !== '' && line[0] !== ' ' && line[0] !== '#') inHook = false;
    if (!inHook || !line.startsWith(`  ${key}:`)) continue;
    v = line.slice(line.indexOf(':') + 1);
    const hash = v.indexOf('#'); if (hash >= 0) v = v.slice(0, hash);
    v = v.replace(/[ \t"]/g, '');
    while (/^0./s.test(v)) v = v.slice(1);
    if (v === '' || /[^0-9]/.test(v)) { v = String(def); continue; }
    if (v.length >= 6) { v = String(max); continue; }
    v = String(Math.min(max, Math.max(min, Number(v))));
  }
  return Number(v);
}
