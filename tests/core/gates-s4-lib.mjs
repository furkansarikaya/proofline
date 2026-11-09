// @ts-check
// Helpers of the gates-test.sh slice S4 ports (tests/core/gates-s4.test.mjs): the pieces of the shell self-test library that the harness does not export.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { A, gpass, must, pipe, project, rec, scaffold, wclose, wev, wopen } from '../lib/harness.mjs';

/** @typedef {import('../lib/harness.mjs').ScaffoldOptions} ScaffoldOptions */

/** `unfrozen [CLASS]` of the shell scenarios: standalone, manual, the PLAN can still be edited before `freeze`. @param {string} [cls] @param {ScaffoldOptions} [o] */
export const unfrozen = (cls = 'STANDARD', o = {}) => scaffold({ ...o, topology: 'standalone', layout: 'no', cls, autonomy: 'manual' });

/** The gates the pipeline requires, as a list. @param {string} dir */
export const gatesOf = (dir) => pipe(dir, 'gates').split(/\s+/).filter(Boolean);

/** `implemented orchestrated`: RED/GREEN done and the handoff IMPLEMENTED. @param {string} dir */
export function implemented(dir) {
  worker2(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  worker2(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(dir, ['handoff', 'LC', 'IMPLEMENTED']);
}

/** worker of the shell library with the RED expected failure overridable (WEV_EF). @param {string} dir @param {string} phase @param {string} res @param {string} file @param {string} line @param {string} [ef] */
export function worker2(dir, phase, res, file, line, ef) {
  const w = wopen(dir); appendFileSync(path.join(dir, file), `${line}\n`); wev(dir, phase, res, ef ? { ef } : {}); wclose(dir, w);
}

/** Add `    kind: KIND` under the scope entry of PATH in a plan (kind_claim of the shell scenario). @param {string} plan @param {string} p @param {string} kind */
export function kindClaim(plan, p, kind) {
  writeFileSync(plan, readFileSync(plan, 'utf8').split('\n').flatMap((l) => (l === `  - path: ${p}` ? [l, `    kind: ${kind}`] : [l])).join('\n'));
}

/** Pass every required gate (as passAll of the harness) with the same extra report text in every result (RF_EXTRA). @param {string} dir @param {string} extra */
export function passAllExtra(dir, extra) {
  for (const g of gatesOf(dir)) {
    if (g === 'VERIFY') continue;
    if (g === 'SECRETS') must(dir, ['secret-scan', 'LC']); else rec(dir, g, 'PASS', [], { extra });
  }
  for (const m of A(dir, ['pipeline', 'LC']).out.matchAll(/^focus\.([A-Z_]*)\.([a-z]*)=.*$/gm)) rec(dir, m[1], 'PASS', [], { focus: m[2], extra });
  rec(dir, 'VERIFY', 'PASS', [], { extra });
}

export { gpass, project };
