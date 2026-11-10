// @ts-check
// batch-cover (A157, A200, A225): the batch approval stands in for the plan, delivery and mutation-budget approvals of the tasks it lists, and for nothing else.
// The scenarios of the former batch-test.sh that prove the limits (kinds, role, task outside the batch, CRITICAL after the start), the cap of the mutation budget
// and the delivery cover (one approval per pending step, the same delivery hash, accepted by deliver-step). Criteria: invariants 3 and 6 (approvals come from the
// user's message; in doubt the safe side wins).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { A, AB, appendFileSync, batchApprove, coverProject, fakes, gOk, read, readIf, sh, verbs, path, repo, has } from './batch-lib.mjs';
import { installGithooks } from '../lib/harness.mjs';

/** @param {{ status: number|null, text: string }} r @param {string} what @param {string} [msg] */
function refused(r, what, msg) {
  assert.notEqual(r.status, 0, `${what}: the command succeeded\n${r.text}`);
  if (msg !== undefined) assert.ok(r.text.includes(msg), `${what}: rejected for another reason: ${r.text.trim().split('\n').pop()}`);
}
const count = (/** @type {string} */ d) => { try { return readdirSync(d).length; } catch { return 0; } };
/** A scaffolded run LC, a planned and approved batch of LC. @param {string} [flags] @param {string} [topo] */
function coverSetup(flags = '', topo = undefined) {
  const F = fakes();
  const dir = topo === undefined ? coverProject(flags) : coverProject(flags, topo);
  const p = AB(F, dir, ['batch-plan', 'all']);
  assert.equal(p.status, 0, `batch-plan failed: ${p.text}`);
  batchApprove(dir);
  return { F, dir };
}
const mbPlan = (/** @type {string} */ dir, /** @type {number} */ n) => {
  let t = '\n## Tests\n\n'; for (let i = 1; i <= n; i++) t += `- AC-${i}: criterion\n`;
  appendFileSync(`${dir}/.agents/runs/LC/PLAN.md`, t);
};

test('batch-cover covers only plan, delivery and mutation_budget; it is lead-only, bound to the batch, and the covered plan approval lets freeze pass (sc_cover_limits)', () => {
  const { F, dir } = coverSetup();
  const ad = `${dir}/.agents/runs/LC/approvals`;
  A(dir, ['request-approval', 'LC', 'plan']);
  const n0 = count(ad);
  for (const k of ['waive:F-1', 'scope', 'reopen:LC', 'budget', 'rule:L-1', 'destructive', 'single_step', 'report', 'commit', 'push', 'merge', 'cleanup', 'batch']) {
    refused(AB(F, dir, ['batch-cover', 'LC', k]), `batch-cover ${k}`, 'not covered by the batch approval');
  }
  assert.equal(count(ad), n0, 'a refused batch-cover wrote an approval file');
  refused(AB(F, dir, ['batch-cover', 'NOPE', 'plan']), 'batch-cover for a task outside the batch');
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan'], { role: 'reviewer' }), 'batch-cover without a lead');
  refused(AB(F, dir, ['batch-plan', 'all'], { role: 'reviewer' }), 'reviewer batch-plan', 'command denied');
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan'], { role: 'implementer' }), 'implementer batch-cover', 'command denied');
  refused(AB(F, dir, ['batch-cover', 'LC'], {}), 'batch-cover without a kind', 'usage: agent.sh batch-cover');
  // waiver and scope still need their own approval: the request exists, the batch does not answer it
  A(dir, ['request-approval', 'LC', 'scope']);
  refused(AB(F, dir, ['batch-cover', 'LC', 'scope']), 'batch-cover scope');
  assert.equal(readdirSync(ad).filter((x) => /^[0-9]{3}-scope\.yaml$/.test(x)).length, 0, 'scope got an approval from the batch');
  // plan: recorded as the user's approval; freeze accepts it
  refused(verbs(dir, 'A freeze LC'), 'freeze before any approval');
  const c = AB(F, dir, ['batch-cover', 'LC', 'plan']);
  assert.equal(c.status, 0, `batch-cover plan refused: ${c.text}`);
  assert.match(c.out, /batch approval recorded: LC plan/);
  const pf = readdirSync(ad).filter((x) => /^[0-9]{3}-plan\.yaml$/.test(x)).sort().pop() ?? '';
  const body = read(`${ad}/${pf}`);
  assert.ok(/^via_batch:/m.test(body) && /^source:\s*"?batch"?/m.test(body) && /^consumed:\s*"?false"?/m.test(body) && /^answered_by:\s*"?user"?/m.test(body), `covered plan approval: ${body}`);
  assert.equal(verbs(dir, 'A freeze LC >/dev/null').status, 0, 'freeze did not accept the covered plan approval');
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'second cover of a consumed plan request');
});

test('the mutation budget: a need above the cap is refused at cover, raise-budget above the cap is refused for a batch approval, within the cap it works (sc_mutation_cap)', () => {
  let { F, dir } = coverSetup();
  let ad = `${dir}/.agents/runs/LC/approvals`;
  mbPlan(dir, 45); A(dir, ['request-approval', 'LC', 'mutation_budget']);
  refused(AB(F, dir, ['batch-cover', 'LC', 'mutation_budget']), 'batch-cover mutation_budget over the cap (45 > 40)', 'above the batch cap 40');
  assert.equal(readdirSync(ad).filter((x) => /-mutation_budget\.yaml$/.test(x) && !/request/.test(x)).length, 0, 'an over-cap mutation budget was covered');
  refused(A(dir, ['raise-budget', 'LC', '45']), 'raise-budget without an approval');
  // under the cap: covered, the approval stores the cap, and raise-budget stops at the cap
  ({ F, dir } = coverSetup());
  ad = `${dir}/.agents/runs/LC/approvals`;
  mbPlan(dir, 35); A(dir, ['request-approval', 'LC', 'mutation_budget']);
  const c = AB(F, dir, ['batch-cover', 'LC', 'mutation_budget']);
  assert.equal(c.status, 0, `a mutation budget of 35 criteria (cap 40) was refused: ${c.text}`);
  const mf = readdirSync(ad).filter((x) => /^[0-9]{3}-mutation_budget\.yaml$/.test(x)).sort().pop() ?? '';
  const body = read(`${ad}/${mf}`);
  assert.ok(/^via_batch:/m.test(body) && /^cap:\s*"?40"?/m.test(body), `covered budget approval lacks via_batch or cap 40: ${body}`);
  refused(A(dir, ['raise-budget', 'LC', '41']), 'raise-budget above the cap with a batch approval (41 > 40)');
  assert.equal(readIf(`${dir}/.agents/runs/LC/mutation_budget`), '', 'the mutation budget was raised above the cap');
  assert.equal(A(dir, ['raise-budget', 'LC', '35']).status, 0, 'raise-budget to 35 (<= cap) with the covered approval was refused');
  assert.equal(read(`${dir}/.agents/runs/LC/mutation_budget`).trim(), '35');
});

test('a task classified CRITICAL after the batch started is not covered (sc_late_critical)', () => {
  const { F, dir } = coverSetup();
  A(dir, ['request-approval', 'LC', 'plan']);
  const run = `${dir}/.agents/runs/LC/RUN.yaml`;
  appendFileSync(run, ''); // keep the file; the class is rewritten in place
  sh(dir, 'sed', ['-i.bak', 's/^  classification: .*/  classification: CRITICAL/', run]);
  const n0 = count(`${dir}/.agents/runs/LC/approvals`);
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'batch-cover for a run classified CRITICAL after the batch started', 'CRITICAL');
  assert.equal(count(`${dir}/.agents/runs/LC/approvals`), n0, 'an approval was written for a CRITICAL run');
});

test('batch-cover delivery: one approval per pending delivery step, the same delivery hash, accepted by deliver-step (sc_cover_delivery)', () => {
  const { F, dir } = coverSetup('SC_BRANCH=1', 'orchestrated');
  const r = verbs(dir, 'to_code_done orchestrated');
  assert.equal(r.status, 0, r.text);
  gOk(dir, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const hd = installGithooks(dir);
  gOk(dir, ['config', 'core.hooksPath', hd]);
  assert.equal(verbs(dir, 'finish_done').status, 0);
  const dp = A(dir, ['deliver-plan', 'LC']);
  assert.equal(dp.status, 0, `deliver-plan refused: ${dp.text}`);
  refused(A(dir, ['deliver-step', 'LC', 'commit']), 'a step before any approval', 'no unconsumed commit approval');
  const c = AB(F, dir, ['batch-cover', 'LC', 'delivery']);
  assert.equal(c.status, 0, `batch-cover delivery refused: ${c.text}`);
  for (const k of ['commit', 'push', 'pr', 'merge', 'cleanup']) {
    const f = readdirSync(`${dir}/.agents/runs/LC/approvals`).filter((x) => new RegExp(`^[0-9]{3}-${k}\\.yaml$`).test(x)).sort().pop();
    assert.ok(f, `no ${k} approval from the delivery cover`);
    const b = read(`${dir}/.agents/runs/LC/approvals/${f}`);
    assert.ok(/^delivery:/m.test(b) && /^via_batch:/m.test(b), `${k} approval lacks delivery: or via_batch: ${b}`);
  }
  assert.equal(A(dir, ['deliver-step', 'LC', 'commit']).status, 0, 'the covered commit approval was not accepted by deliver-step');
  void has;
});
