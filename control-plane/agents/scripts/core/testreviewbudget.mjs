// @ts-check
// The plan's `## Test review budget` (A359, issue 338 C1): how far the REVIEW_TESTS loop may go, stated in the PLAN (the user approves the plan) so nobody types a cap at hour 6.
//   - rounds: N     the most REVIEW_TESTS rounds (REVIEW_TESTS records) before the gate stops with `test review cap reached` and asks the user
//   - minutes: N    the most minutes of the test-review loop; the reviewer stops starting mutants after it (the control plane never reads a wall clock for it)
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

/** The mutation budget a plan needs: the largest of the criteria floor and what its Test review budget states or derives. @param {string} plan @param {number} acs the number of `## Tests` criteria */
export function mutantNeed(plan, acs) {
  const b = parseReviewBudget(plan);
  return Math.max(acs, b.mutants ?? 0, (b.units ?? 0) * MUTANTS_PER_UNIT, Math.ceil((b.lines ?? 0) / MUTANT_LINES));
}
