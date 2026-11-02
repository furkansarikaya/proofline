// @ts-check
// Behaviour of next-user-test.sh (A159, A180, A200) as absolute Node tests (tests/legacy-port-map.tsv): the table behind the "Next step:" line that ends
// every /proofline command: one user-facing line in every run state, the expected next command per state, the command that fixes an error, the delivery
// records, the batch rows. The expected lines are the shell suite's, recorded once.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, accepted, project, refused, say, scripts } from './legacy-lib.mjs';

const SHAPE = /^Next step: (\/proofline |proofline |run proofline |reply |commit |commit or stash |fix what )/;
const NU = (/** @type {string} */ d, /** @type {string[]} */ ...args) => A(d, ['next-user', ...args]);
const line = (/** @type {string} */ d, /** @type {string[]} */ ...args) => NU(d, ...args).out.replace(/\n$/, '');
const RECIPES = {
  none: 'new_repo',
  active: 'scaffold orchestrated',
  question: 'scaffold orchestrated',
  codedone: 'scaffold orchestrated; to_code_done orchestrated',
  finished: 'scaffold orchestrated; to_code_done orchestrated; A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null; write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null',
  failed: "scaffold orchestrated; printf 'reason: the environment lacks the database the lookup needs to be proven\\nevidence: the staging database is unreachable from this environment\\n' | A terminate LC BLOCKED >/dev/null",
};
/** A project in the named run state. @param {keyof typeof RECIPES} state */
function stateRun(state) {
  const d = project(RECIPES[state]);
  if (state === 'question') {
    const y = `${d}/.agents/runs/LC/RUN.yaml`;
    writeFileSync(y, readFileSync(y, 'utf8').replace(/^ {2}awaiting_input: false/m, '  awaiting_input: true'));
    mkdirSync(`${d}/.agents/runs/LC/questions`, { recursive: true });
    writeFileSync(`${d}/.agents/runs/LC/questions/001.md`, 'from: lead\nasked_at: 1\n---\n1. Which cache do we use?\n   options: a | b\n');
  }
  return d;
}

for (const state of /** @type {Array<keyof typeof RECIPES>} */ (Object.keys(RECIPES))) {
  test(`every command in the ${state} run state ends in a user command and never names agent.sh`, () => {
    const d = stateRun(state);
    const commands = accepted(NU(d, '--commands'), '--commands').out.split('\n').filter(Boolean);
    assert.ok(commands.length > 0, 'next-user --commands is empty');
    for (const c of commands) {
      const out = accepted(NU(d, c), `${state}: next-user ${c}`).out;
      assert.equal(out.trim().split('\n').length, 1, `${state}: next-user ${c} printed more than one line: ${out}`);
      assert.match(out, SHAPE, `${state}: next-user ${c} is not a user command`);
      assert.ok(!out.includes('agent.sh'), `${state}: next-user ${c} names an internal command: ${out}`);
      if (state !== 'none') assert.doesNotMatch(out, /<TASK-ID>|\{[A-Z]+\}|<ID>/, `${state}: next-user ${c} left a placeholder: ${out}`);
    }
  });
}

test('the table gives the expected next command for none, active, question, CODE_DONE and FAILED, and for the product commands', () => {
  let d = stateRun('none');
  assert.equal(line(d, 'status'), 'Next step: /proofline task --grill');
  d = stateRun('active');
  assert.equal(line(d, 'status'), 'Next step: /proofline resume'); assert.equal(line(d, 'deliver'), 'Next step: /proofline resume');
  d = stateRun('question');
  assert.ok(line(d, 'status').includes('reply in this session to the open question'));
  d = stateRun('codedone');
  assert.equal(line(d, 'status'), 'Next step: /proofline deliver LC'); assert.equal(line(d, 'knowledge', 'LC'), 'Next step: /proofline deliver LC');
  assert.ok(line(d, 'deliver', 'LC').includes('approve delivery'));
  d = stateRun('failed');
  assert.equal(line(d, 'status'), 'Next step: /proofline reopen LC'); assert.equal(line(d, 'knowledge', 'LC'), 'Next step: /proofline reopen LC');
  assert.equal(line(d, 'init'), 'Next step: /proofline doctor');
  assert.equal(line(d, 'product', 'prd', 'pay'), 'Next step: /proofline product review pay'); assert.equal(line(d, 'product', 'review', 'pay'), 'Next step: /proofline product split pay');
  mkdirSync(`${d}/docs/product/pay`, { recursive: true }); writeFileSync(`${d}/docs/product/pay/REVIEW.md`, 'verdict: do-not-ship\n');
  assert.ok(line(d, 'product', 'review', 'pay').includes('revise the PRD'));
  writeFileSync(`${d}/docs/product/pay/REVIEW.md`, 'round: 2\n', { flag: 'a' });
  assert.ok(line(d, 'product', 'review', 'pay').includes('both review rounds are used'));
  assert.ok(line(d, 'product', 'split', 'pay').includes('/proofline'));
  assert.equal(line(d, 'product', 'discover', 'frame', 'pay'), 'Next step: /proofline product discover research pay');
  assert.equal(line(d, 'product', 'discover', 'opportunities', 'pay'), 'Next step: /proofline product assess assumptions pay');
  assert.equal(line(d, 'product', 'assess', 'redteam', 'pay'), 'Next step: /proofline product assess decision pay');
  assert.equal(line(d, 'product', 'assess', 'decision', 'pay'), 'Next step: /proofline product prd pay');
  writeFileSync(`${d}/docs/product/pay/DECISION.md`, 'decision: clarify\n');
  assert.ok(line(d, 'product', 'assess', 'decision', 'pay').includes('discover research pay'));
  writeFileSync(`${d}/docs/product/pay/DECISION.md`, 'decision: stop\n', { flag: 'a' });
  assert.ok(line(d, 'product', 'assess', 'decision', 'pay').includes('so no PRD is split'));
  assert.equal(line(d, 'product', 'outcome', 'pay'), 'Next step: /proofline status'); assert.equal(line(d, 'trace', 'FR-1'), 'Next step: /proofline status');
});

test('an error suggestion is the command that fixes the error; an unknown command is refused', () => {
  let d = stateRun('codedone');
  assert.equal(line(d, 'deliver', 'LC', '--error'), 'Next step: /proofline knowledge LC'); assert.equal(line(d, 'deliver', 'LC', '--error=knowledge'), 'Next step: /proofline knowledge LC');
  assert.equal(line(d, 'merge', 'LC', '--error=dirty-tree'), 'Next step: commit or stash your changes yourself, then run /proofline merge LC again');
  assert.equal(line(d, 'run', '--error=usage'), 'Next step: proofline help');
  assert.ok(line(d, 'doctor', '--error=doctor').includes('run /proofline doctor again'));
  d = stateRun('failed');
  assert.equal(line(d, 'run', 'LC', '--error'), 'Next step: /proofline reopen LC');
  for (const k of ['not-installed', 'dirty-tree', 'knowledge', 'failed-run', 'doctor', 'usage', 'nonsense']) assert.ok(!NU(d, 'status', 'LC', `--error=${k}`).out.includes('agent.sh'), `--error=${k} names an internal command`);
  refused(NU(d, 'frobnicate'), 'an unknown command was accepted');
  // outside an installed project (no config) the fix is to install it
  const bare = project('new_repo');
  rmSync(`${bare}/.agents/config.yaml`);
  assert.equal(line(bare, 'doctor', '--error'), 'Next step: proofline init');
});

test('without a pull_request workflow the delivery step is the same (no CI is a warning, A180)', () => {
  for (const state of /** @type {const} */ (['codedone', 'finished'])) {
    const d = stateRun(state);
    accepted(A(d, ['next-user', 'status']), 'status');
    assert.ok(line(d, 'deliver', 'LC').includes('approve delivery'), `deliver on ${state} without CI`);
    if (state === 'codedone') assert.equal(line(d, 'status'), 'Next step: /proofline deliver LC');
  }
});

test('deliver: a merge that stopped gives proofline merge <PR>, a delivered run gives the next task, never approve delivery', () => {
  const d = stateRun('finished');
  rmSync(`${d}/.agents/tasks`, { recursive: true, force: true }); mkdirSync(`${d}/.agents/tasks/todo`, { recursive: true });
  assert.ok(line(d, 'deliver', 'LC').includes('approve delivery'), 'deliver before any step');
  mkdirSync(`${d}/.agents/local/deliver/LC`, { recursive: true }); writeFileSync(`${d}/.agents/local/deliver/LC/PR`, '7\n');
  assert.equal(line(d, 'deliver', 'LC'), 'Next step: proofline merge 7'); assert.equal(line(d, 'deliver'), 'Next step: proofline merge 7');
  writeFileSync(`${d}/.agents/local/deliver/LC/PR`, 'x; rm -rf /\n');
  assert.ok(line(d, 'deliver', 'LC').includes('approve delivery'), 'a PR file that is not a number is ignored');
  writeFileSync(`${d}/.agents/local/deliver/LC/PR`, '7\n');
  mkdirSync(`${d}/.agents/runs/LC/approvals`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/approvals/009-cleanup.yaml`, 'kind: "cleanup"\nconsumed: "true"\nconsumed_at: 1\n');
  assert.equal(line(d, 'deliver', 'LC'), 'Next step: /proofline task --grill');
  writeFileSync(`${d}/.agents/tasks/todo/NEXT-8.md`, '# Task: NEXT-8 — queued\n');
  assert.equal(line(d, 'deliver', 'LC'), 'Next step: /proofline run NEXT-8');
});

test('after delivery, merge or clean the next step is the next queued task, else a new task', () => {
  const d = stateRun('none');
  rmSync(`${d}/.agents/tasks`, { recursive: true, force: true }); mkdirSync(`${d}/.agents/tasks/todo`, { recursive: true });
  assert.equal(line(d, 'deliver', 'LC'), 'Next step: /proofline task --grill'); assert.equal(line(d, 'clean'), 'Next step: /proofline task --grill');
  writeFileSync(`${d}/.agents/tasks/todo/NEXT-7.md`, '# Task: NEXT-7 — queued\n');
  for (const c of ['deliver', 'clean', 'merge']) assert.equal(line(d, c, ...(c === 'deliver' ? ['LC'] : [])), 'Next step: /proofline run NEXT-7');
});

/** The batch scripts into the project and a planned batch of one task. @param {string} d @param {string} [id] */
function batchPlan(d, id = 'T-1') {
  for (const n of readdirSync(scripts)) if (n.endsWith('.sh') && !n.endsWith('-test.sh') && !['test-lib.sh', 'agent.sh', 'exec-policy.sh', 'secret-scan.sh'].includes(n)) cpSync(path.join(scripts, n), `${d}/.agents/scripts/${n}`);
  mkdirSync(`${d}/.agents/tasks`, { recursive: true });
  writeFileSync(`${d}/.agents/tasks/${id}.md`, `# Task: ${id} — one\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nCOMPLEX\n`);
  accepted(A(d, ['batch-plan', id]), 'batch-plan');
}
const batchApprove = (/** @type {string} */ d) => { say(d, 'approve batch'); A(d, ['approve-pending']); };

test('batch: unapproved, approved (continue with /proofline batch), parked, merged, finished clean', () => {
  const d = stateRun('none');
  rmSync(`${d}/.agents/tasks`, { recursive: true, force: true });
  assert.equal(line(d, 'batch'), 'Next step: /proofline task --grill');
  batchPlan(d);
  const bdir = `${d}/.agents/local/batch`;
  assert.equal(line(d, 'batch', 'T-1'), 'Next step: reply "approve batch" in this session to start the batch');
  batchApprove(d);
  const cont = 'Next step: run /proofline batch to continue the batch; merged tasks are not run again';
  assert.equal(line(d, 'batch'), cont); assert.equal(line(d, 'batch', 'status'), cont);
  assert.equal(line(d, 'batch', 'stop'), line(d, 'batch')); assert.equal(line(d, 'batch', 'run'), line(d, 'batch'));
  writeFileSync(`${bdir}/state.tsv`, 'T-1\tparked\tno worktree\t\n');
  assert.equal(line(d, 'batch'), 'Next step: /proofline batch status');
  rmSync(`${bdir}/state.tsv`);
  writeFileSync(`${bdir}/merged.tsv`, 'T-1\t101\t1\n'); rmSync(`${d}/.agents/tasks/T-1.md`);
  assert.equal(line(d, 'batch', 'status'), cont);
  writeFileSync(`${bdir}/ci.tsv`, 'T-1\tsha\t1\n');
  assert.equal(line(d, 'batch', 'status'), 'Next step: /proofline task --grill'); assert.equal(line(d, 'batch'), 'Next step: /proofline batch status');
  writeFileSync(`${d}/.agents/tasks/NEXT-7.md`, '# Task: NEXT-7 — queued\n');
  assert.equal(line(d, 'batch', 'status'), 'Next step: /proofline run NEXT-7');
});

test('batch status with a parked task names its full id and the question, or the fixing command', () => {
  const park = (/** @type {string} */ d, /** @type {string} */ text) => writeFileSync(`${d}/.agents/local/batch/state.tsv`, text);
  let d = stateRun('question'); batchPlan(d, 'LC'); batchApprove(d);
  const q = line(d, 'resume', 'LC').replace('Next step: reply in this session to the open question: ', '');
  assert.ok(q.length > 0, 'no question text');
  assert.equal(line(d, 'batch', 'status'), `Next step: /proofline resume LC, then reply in this session to the open question: ${q}`);
  d = stateRun('failed'); batchPlan(d, 'LC'); batchApprove(d);
  assert.equal(line(d, 'batch', 'status'), 'Next step: /proofline reopen LC');
  d = stateRun('codedone'); batchPlan(d, 'LC'); batchApprove(d); park(d, 'LC\tparked\ttimeout\t\n');
  assert.equal(line(d, 'batch', 'status'), 'Next step: /proofline deliver LC');
  d = stateRun('active'); batchPlan(d, 'LC'); batchApprove(d); park(d, 'LC\tparked\tstopped\t\n');
  assert.equal(line(d, 'batch', 'status'), 'Next step: /proofline resume LC');
  d = stateRun('none'); rmSync(`${d}/.agents/tasks`, { recursive: true, force: true }); batchPlan(d); batchApprove(d); park(d, 'T-1\tparked\tno worktree\t\n');
  assert.equal(line(d, 'batch', 'status'), 'Next step: /proofline run T-1');
});

test('A200: a CODE_DONE task of an approved batch ends in "continue the batch", not a delivery command for the user', () => {
  const d = stateRun('codedone');
  assert.equal(line(d, 'resume', 'LC'), 'Next step: /proofline deliver LC');
  assert.doesNotMatch(A(d, ['next', 'LC']).out, /^note=BATCH/m, 'a run outside a batch got the batch note');
  batchPlan(d, 'LC'); batchApprove(d);
  assert.equal(line(d, 'resume', 'LC'), 'Next step: run /proofline batch to continue the batch (it delivers LC and goes on)');
  assert.equal(line(d, 'deliver', 'LC'), 'Next step: reply "approve delivery" in this session to deliver LC');
  assert.match(A(d, ['next', 'LC']).out, /^note=BATCH \(A200\): LC belongs to the approved batch\. Do NOT stop/m);
});

test('the batch commands end in a user command with a planned batch and a parked task', () => {
  const d = stateRun('none'); rmSync(`${d}/.agents/tasks`, { recursive: true, force: true });
  batchPlan(d); batchApprove(d);
  writeFileSync(`${d}/.agents/local/batch/state.tsv`, 'T-1\tparked\tno worktree\tWhich database?\n');
  for (const c of [['batch'], ['batch', 'status'], ['batch', 'stop'], ['batch', 'run']]) {
    const out = accepted(NU(d, ...c), `next-user ${c.join(' ')}`).out;
    assert.match(out, SHAPE); assert.doesNotMatch(out, /agent\.sh|<TASK-ID>|\{[A-Z]+\}|<ID>/, `next-user ${c.join(' ')} names an internal command or leaves a placeholder: ${out}`);
  }
});
