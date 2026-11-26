// @ts-check
// The plan's `## Test review budget` (A359, issue 338 C1): how far the REVIEW_TESTS loop may go, stated in the PLAN (the user approves the plan) so nobody types a cap at hour 6.
//   - rounds: N     the most REVIEW_TESTS rounds (REVIEW_TESTS records) before the gate stops with `test review cap reached` and asks the user
//   - minutes: N    the most minutes of the test-review loop, counted by the control plane's clock from the loop's first recorded test review dispatch (A379, `reviewLoopClock`);
//                   at the cap a failing REVIEW_TESTS stops the loop as the round cap does
//   - mutants: N    the mutation budget the reviewer needs, stated outright
//   - units: N      the number of changed production units; the budget is MUTANTS_PER_UNIT mutants for each
//   - lines: N      the number of changed production lines; the budget is one mutant per MUTANT_LINES lines
// The mutation budget the plan needs is the largest of: one claim mutant per `## Tests` criterion (the validator floor), `mutants`, units x 4 and lines / 25. A plan field only
// REQUESTS a budget above test_trust.mutation_budget: raising it is still the user's `mutation_budget` approval (Core invariant 3). A leaf module: no I/O.
import { textLines } from './records.mjs';

export const MUTANTS_PER_UNIT = 4;
export const MUTANT_LINES = 25;
export const MAX_FIELD = 100000;

/**
 * @param {string} plan a PLAN.md byte string
 * @returns {{ present: boolean, rounds: number | null, minutes: number | null, mutants: number | null, units: number | null, lines: number | null, errors: string[] }}
 */
export function parseReviewBudget(plan) {
  /** @type {Record<string, number | null>} */ const v = { rounds: null, minutes: null, mutants: null, units: null, lines: null };
  /** @type {string[]} */ const errors = [];
  let inside = false; let present = false;
  for (const line of textLines(plan)) {
    if (line.startsWith('## ')) { inside = /^## Test review budget[ \t]*$/.test(line); if (inside) present = true; continue; }
    if (!inside) continue;
    const m = /^[ \t]*[-*][ \t]*(rounds|minutes|mutants|units|lines):[ \t]*([0-9]+)[ \t]*$/.exec(line);
    if (m) {
      const n = Number(m[2]);
      if (!(n >= 1 && n <= MAX_FIELD)) errors.push(`${m[1]}: ${m[2]} is outside 1..${MAX_FIELD}`); else if (v[m[1]] !== null) errors.push(`${m[1]} is given twice`); else v[m[1]] = n;
    } else if (/^[ \t]*[-*]/.test(line)) errors.push(`unknown line: ${line.trim().slice(0, 60)}`);
  }
  return { present, rounds: v.rounds, minutes: v.minutes, mutants: v.mutants, units: v.units, lines: v.lines, errors };
}

/** A ledger row as `parseLedgerLine` returns it (the fields the clock reads). @typedef {{ seq: number, event: string, role: string, epoch: string, detail: string }} ClockRow */

/** The decision file of a dispatch of the tests reviewer, as the `decide` row names it first in its detail (`<NNN>-reviewer-tests.decision runtime=...`). */
const TESTS_DISPATCH = /^[0-9]{3}-reviewer-tests\.decision( |$)/;

/**
 * The clock of the test review loop (A379, issue 338 C1, the deferred part of A359): the loop starts at the EARLIEST sealed ledger row, after the last `REOPEN` row or the last
 * REVIEW_TESTS pass (`gate:REVIEW_TESTS:pass`, whichever is later: a passed review ends its loop, and a later failure on a changed tree opens a new one), that shows the tests reviewer at work: the `decide` row of a reviewer dispatch with focus tests (the recorded dispatch start, written by the control plane for dispatch.sh and for the Agent path)
 * or a `mutant-result` row the reviewer wrote. Only the control plane's own `epoch=` of those rows is read, never a time an agent supplies, and a later row can never move the start
 * later (the earliest one counts). No such row: the start is not recorded (`start` null): the minutes are not counted and the round cap alone bounds the loop; the caller says
 * `not recorded`. A start after NOW (a clock that went back) counts as 0 seconds. A leaf function: NOW is the caller's argument, so a test passes its own clock.
 * @param {ClockRow[]} rows the run's ledger rows in file order @param {number} nowEpoch the current time in seconds
 * @returns {{ start: number | null, seq: number | null, seconds: number }}
 */
export function reviewLoopClock(rows, nowEpoch) {
  let from = 0;
  rows.forEach((r, i) => { if (r.event === 'REOPEN' || r.event === 'gate:REVIEW_TESTS:pass') from = i + 1; });
  /** @type {number | null} */ let start = null; /** @type {number | null} */ let seq = null;
  for (const r of rows.slice(from)) {
    const marks = (r.event === 'decide' && TESTS_DISPATCH.test(r.detail)) || (r.event === 'mutant-result' && r.role === 'reviewer');
    if (!marks || !/^[0-9]{1,12}$/.test(r.epoch)) continue;
    const e = Number(r.epoch);
    if (start === null || e < start) { start = e; seq = r.seq; }
  }
  return { start, seq, seconds: start === null ? 0 : Math.max(0, nowEpoch - start) };
}

/**
 * True when the loop has used its minutes: the start is recorded and at least MINUTES x 60 seconds have passed since it. @param {{ start: number | null, seconds: number }} clock
 * @param {number} minutes the cap (the plan's, else the config's; a missing or invalid value is the default, never no cap)
 */
export function reviewMinutesUsed(clock, minutes) {
  return clock.start !== null && clock.seconds >= minutes * 60;
}

/** The mutation budget a plan needs: the largest of the criteria floor and what its Test review budget states or derives. @param {string} plan @param {number} acs the number of `## Tests` criteria */
export function mutantNeed(plan, acs) {
  const b = parseReviewBudget(plan);
  return Math.max(acs, b.mutants ?? 0, (b.units ?? 0) * MUTANTS_PER_UNIT, Math.ceil((b.lines ?? 0) / MUTANT_LINES));
}
