// @ts-check
// controls-test.sh (176-D3) as Node tests: the layer tests of the control plane, one layer at a time (runs without `lifecycle_gates`): the base state
// machine (freeze, freshness, scope, handoff, delivery), the implementer role boundary, worker evidence and TDD under both topologies, the fail-closed
// evidence write, the knowledge-transaction scope at DONE / delivery-check / validate, and task branch isolation. Every assertion, attack input and
// message of the shell scenarios is kept. The control plane under test is the real one on the live Node path (A242); one test per shell scenario.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, accepted, expectFail, expectMsg, git, must, newRepo, commitAll } from '../lib/harness.mjs';

const POLICY_KEYS = ['worker_evidence:', '  required: true', 'tdd:', '  required: true', 'completion_report:', '  required: true', '  adapter: PENDING', '  published: false', '  receipt: PENDING'];

/**
 * layer_run of the shell suite: a run directory with a RUN.yaml of the base layer (no lifecycle_gates), the scope paths mapped to AC-1.
 * @param {string} d @param {string} id @param {string[]} scope
 * @param {{ source?: string[], sourceRev?: string[], extra?: string[], planExtra?: string, repoExtra?: string[], topology?: string }} [o]
 */
function layerRun(d, id, scope, o = {}) {
  const run = path.join(d, '.agents/runs', id); mkdirSync(run, { recursive: true });
  mkdirSync(path.join(d, '.agents/local'), { recursive: true }); writeFileSync(path.join(d, '.agents/local/ACTIVE_RUN'), `${id}\n`);
  writeFileSync(path.join(run, 'TASK.md'), `# Task: ${id}\n\n## Acceptance criteria\n\n- AC-1: behaviour\n`);
  writeFileSync(path.join(run, 'EVIDENCE.md'), '# Evidence\n\n## Assumptions\nnone\n\n## Claims\n');
  const plan = ['---', 'scope:', ...scope.flatMap((p) => [`  - path: ${p}`, '    criteria: [AC-1]']), ...(o.planExtra ? [o.planExtra] : []), '---', '# Plan', '## Assumptions', 'none', '## Behavior', 'unchanged'];
  writeFileSync(path.join(run, 'PLAN.md'), `${plan.join('\n')}\n`);
  const yaml = ['task:', `  id: ${id}`, 'repository:', '  base_sha: PENDING', ...(o.repoExtra ?? []), 'task_source:', ...(o.source ?? ['  type: none']), ...(o.sourceRev ?? ['  revision: not_applicable']),
    'execution:', '  mode: deterministic', '  state: PLANNING', '  knowledge_state: not_started', '  knowledge_reason: ""', `  topology: ${o.topology ?? 'orchestrated'}`,
    'freeze:', '  task_sha256: PENDING', '  evidence_sha256: PENDING', '  plan_sha256: PENDING', '  policy_sha256: PENDING',
    'baseline:', '  status: pending', 'handoff:', '  state: PLANNED', '  implemented_patch_sha256: PENDING', '  code_done_patch_sha256: PENDING', ...(o.extra ?? [])];
  writeFileSync(path.join(run, 'RUN.yaml'), `${yaml.join('\n')}\n`);
}
const SRC = (/** @type {string} */ p) => ({ source: ['  type: local_markdown', `  path: ${p}`], sourceRev: ['  revision: PENDING'] });
const w = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };
const ap = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => appendFileSync(path.join(d, f), t);
const rd = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(path.join(d, f), 'utf8');
/** The completion report of the run, as the shell suite wrote it. @param {string} d @param {string} id */
function report(d, id) {
  w(d, `.agents/runs/${id}/COMPLETION_REPORT.md`, `${['# Completion Report: ' + id, '', '## Implementation Summary', 'impl.txt gained Find(); config.txt is a constant, TDD-exempt.', '', '## TDD Evidence', 'RED failed for the expected reason; GREEN passed.', '',
    '## Verification', 'go test ./... passed.', '', '## Assumptions', 'none', '', '## Known Limitations / Follow-up', 'None.'].join('\n')}\n`);
}
/** ev ROLE ID PHASE RESULT TARGET: worker evidence as the role (RED carries the expected failure). @param {string} d @param {string} role @param {string} id @param {string} phase @param {string} res @param {string} target */
function ev(d, role, id, phase, res, target) {
  const ef = phase === 'RED' ? 'expected_failure: TestImpl fails: Find() does not exist yet, specifically' : '';
  return A(d, ['worker-evidence', id, phase, res], { role, input: `command: go test ./...\ntarget: ${target}\n${ef}\n` });
}
const commit = (/** @type {string} */ d, /** @type {string} */ m) => commitAll(d, m);
/** `sed '$d'`: the text without its last line. @param {string} t */
const dropLast = (t) => { const l = t.split('\n'); if (l.at(-1) === '') l.pop(); l.pop(); return l.map((x) => `${x}\n`).join(''); };

// The base state machine: baseline, scope, freeze, freshness, handoff, delivery-check, artifacts, status.
test('sc_base: the base state machine (baseline, scope, freeze, freshness, handoff, delivery-check, artifacts, status)', () => {
  const d = newRepo(); mkdirSync(path.join(d, 'tasks'));
  layerRun(d, 'FIX', ['authorized.txt'], SRC('tasks/FIX.md'));
  w(d, 'authorized.txt', ''); w(d, 'user-dirty.txt', ''); w(d, 'tasks/FIX.md', '# canonical task\n'); commit(d, 'baseline');
  w(d, 'user-dirty.txt', 'user work\n'); w(d, 'user-untracked.txt', '');
  must(d, ['baseline', 'FIX']); ap(d, '.agents/runs/FIX/EVIDENCE.md', 'discovered\n'); ap(d, '.agents/runs/FIX/PLAN.md', 'planned\n');
  must(d, ['verify-scope', 'FIX']); must(d, ['freeze', 'FIX']); must(d, ['verify-freeze', 'FIX']); must(d, ['freshness', 'FIX']);
  expectFail(A(d, ['handoff', 'FIX', 'IMPLEMENTED']), 'IMPLEMENTED straight from PLANNED');
  const srcOrig = rd(d, 'tasks/FIX.md'); ap(d, 'tasks/FIX.md', 'changed source\n');
  expectFail(A(d, ['freshness', 'FIX']), 'freshness with a changed task source');
  w(d, 'tasks/FIX.md', srcOrig);
  const runOrig = rd(d, '.agents/runs/FIX/RUN.yaml'); w(d, '.agents/runs/FIX/RUN.yaml', runOrig.replace('path: tasks/FIX.md', 'path: ../outside.md'));
  expectFail(A(d, ['freshness', 'FIX']), 'a task source outside the repository');
  w(d, '.agents/runs/FIX/RUN.yaml', runOrig);
  ap(d, '.agents/runs/FIX/TASK.md', 'changed contract\n'); expectFail(A(d, ['verify-freeze', 'FIX']), 'verify-freeze with an edited TASK.md');
  w(d, '.agents/runs/FIX/TASK.md', dropLast(rd(d, '.agents/runs/FIX/TASK.md')));
  ap(d, '.agents/modes/deterministic.yaml', '\n# changed\n'); expectFail(A(d, ['verify-freeze', 'FIX']), 'verify-freeze with an edited mode policy');
  w(d, '.agents/modes/deterministic.yaml', dropLast(dropLast(rd(d, '.agents/modes/deterministic.yaml')))); must(d, ['verify-freeze', 'FIX']);
  must(d, ['handoff', 'FIX', 'IMPLEMENTING']);
  expectFail(A(d, ['handoff', 'FIX', 'CODE_DONE']), 'CODE_DONE from IMPLEMENTING');
  ap(d, 'user-dirty.txt', 'agent touched dirty path\n'); expectFail(A(d, ['verify-scope', 'FIX']), 'a change to a user-dirty file');
  w(d, 'user-dirty.txt', 'user work\n');
  ap(d, 'user-untracked.txt', 'x\n'); expectFail(A(d, ['verify-scope', 'FIX']), 'a change to a user-untracked file');
  w(d, 'user-untracked.txt', '');
  w(d, 'authorized.txt', 'change\n'); must(d, ['verify-scope', 'FIX']);
  w(d, 'unexpected.txt', 'unexpected\n'); expectFail(A(d, ['verify-scope', 'FIX']), 'an unmapped path'); rmSync(path.join(d, 'unexpected.txt'));
  w(d, '.agents/runs/FIX/random.txt', 'random\n'); expectFail(A(d, ['validate', 'FIX']), 'an unknown run file'); rmSync(path.join(d, '.agents/runs/FIX/random.txt'));
  must(d, ['handoff', 'FIX', 'IMPLEMENTED']); must(d, ['verify-handoff', 'FIX']);
  ap(d, 'authorized.txt', 'again\n');
  expectFail(A(d, ['handoff', 'FIX', 'CODE_DONE']), 'CODE_DONE on content changed after IMPLEMENTED');
  expectFail(A(d, ['verify-handoff', 'FIX']), 'verify-handoff on stale content');
  must(d, ['handoff', 'FIX', 'IMPLEMENTED']); must(d, ['handoff', 'FIX', 'CODE_DONE']);
  expectFail(A(d, ['delivery-check', 'FIX']), 'delivery-check before the knowledge step');
  must(d, ['knowledge-done', 'FIX', 'not_applicable', 'nothing durable changed in this synthetic test run']); must(d, ['delivery-check', 'FIX']);
  ap(d, 'authorized.txt', 'post-review\n'); expectFail(A(d, ['delivery-check', 'FIX']), 'delivery-check after a post-review edit');
  w(d, '.agents/local/ACTIVE_RUN', 'MISSING\n'); expectFail(A(d, ['status']), 'status with a dangling selector');
  w(d, '.agents/local/ACTIVE_RUN', ''); assert.ok(accepted(A(d, ['status']), 'status with an empty selector').out.split('\n').includes('active_task=none'), 'status of an empty selector');
  rmSync(path.join(d, '.agents/local/ACTIVE_RUN')); assert.ok(accepted(A(d, ['status']), 'status without a selector').out.split('\n').includes('active_task=none'), 'status without a selector');
});

// The implementer (alias implementation_worker) cannot drive the lifecycle.
test('sc_roles: the implementer role boundary (alias implementation_worker)', () => {
  const d = newRepo(); layerRun(d, 'ROLE', ['authorized.txt']); w(d, 'authorized.txt', ''); commit(d, 'baseline');
  assert.ok(accepted(A(d, ['role']), 'role').out.split('\n').includes('role=lead'));
  assert.ok(accepted(A(d, ['role'], { role: 'full_lifecycle' }), 'role full_lifecycle').out.split('\n').includes('role=lead'));
  assert.ok(accepted(A(d, ['role'], { role: 'implementation_worker' }), 'role implementation_worker').out.split('\n').includes('role=implementer'));
  expectFail(A(d, ['role'], { role: 'wizard' }), 'an unknown role');
  must(d, ['baseline', 'ROLE']); must(d, ['freeze', 'ROLE']); ap(d, 'authorized.txt', 'implementation\n');
  must(d, ['verify-scope', 'ROLE'], { role: 'implementer' }); must(d, ['handoff', 'ROLE', 'IMPLEMENTING'], { role: 'implementation_worker' });
  for (const c of ['handoff ROLE IMPLEMENTED', 'handoff ROLE CODE_DONE', 'freeze ROLE', 'refreeze ROLE 001.md', 'delivery-check ROLE', 'baseline ROLE', 'branch ROLE', 'decide ROLE implementer', 'secret-scan ROLE']) {
    expectFail(AS(d, 'implementer', c.split(' ')), `implementer ran: ${c}`);
  }
  must(d, ['handoff', 'ROLE', 'IMPLEMENTED']);
  w(d, 'unplanned.txt', 'unplanned\n'); expectFail(AS(d, 'implementer', ['verify-scope', 'ROLE']), 'unplanned path');
});

// Orchestrated worker evidence and TDD; DONE needs a published completion report and a knowledge state.
test('sc_policy: orchestrated worker evidence, TDD exemption, completion report', () => {
  const d = newRepo(); mkdirSync(path.join(d, 'tasks'));
  layerRun(d, 'POLICY', ['impl.txt', 'config.txt'], { ...SRC('tasks/POLICY.md'), extra: POLICY_KEYS, planExtra: '    tdd_exemption: "control-plane configuration constant with no executable behavior to test"' });
  w(d, 'tasks/POLICY.md', '# POLICY task\n'); w(d, 'impl.txt', ''); w(d, 'config.txt', ''); commit(d, 'baseline');
  must(d, ['baseline', 'POLICY']); ap(d, '.agents/runs/POLICY/PLAN.md', 'planned\n'); must(d, ['freeze', 'POLICY']); must(d, ['handoff', 'POLICY', 'IMPLEMENTING']);
  w(d, 'impl.txt', 'implemented directly by the lead\n');
  expectFail(A(d, ['handoff', 'POLICY', 'IMPLEMENTED']), 'the lead bypassed the worker');
  git(d, ['checkout', '-q', '--', 'impl.txt']);
  expectFail(ev(d, 'lead', 'POLICY', 'GREEN', 'pass', 'impl.txt'), 'the lead recorded worker evidence under orchestrated');
  expectFail(ev(d, 'implementer', 'POLICY', 'GREEN', 'pass', 'out-of-scope.txt'), 'out-of-scope worker evidence');
  expectFail(ev(d, 'implementer', 'POLICY', 'GREEN', 'fail', 'impl.txt'), 'GREEN with result fail');
  expectFail(A(d, ['worker-evidence', 'POLICY', 'RED', 'fail'], { role: 'implementer', input: 'command: x\ntarget: impl.txt\nexpected_failure: configuration change\n' }), 'RED with a stock expected_failure');
  expectFail(ev(d, 'implementer', 'POLICY', 'GREEN', 'pass', 'impl.txt'), 'GREEN recorded before any RED (A97)');
  expectFail(A(d, ['handoff', 'POLICY', 'IMPLEMENTED']), 'IMPLEMENTED with no evidence at all');
  accepted(ev(d, 'implementation_worker', 'POLICY', 'RED', 'fail', 'impl.txt'), 'RED by the implementation_worker');
  expectFail(ev(d, 'implementer', 'POLICY', 'GREEN', 'pass', 'impl.txt'), 'GREEN with no implementation change since RED (A97)');
  ap(d, 'impl.txt', 'implemented\n'); accepted(ev(d, 'implementer', 'POLICY', 'GREEN', 'pass', 'impl.txt'), 'GREEN after the change');
  must(d, ['handoff', 'POLICY', 'IMPLEMENTED']);
  const g = '.agents/runs/POLICY/worker-evidence/GREEN-1.yaml'; const green = rd(d, g);
  w(d, g, green.replace(/^plan_sha256: .*/m, 'plan_sha256: "00"'));
  expectFail(A(d, ['verify-worker-evidence', 'POLICY']), 'stale worker evidence counted');
  w(d, g, green);
  must(d, ['handoff', 'POLICY', 'CODE_DONE']);
  expectFail(A(d, ['handoff', 'POLICY', 'DONE']), 'DONE before the completion report');
  expectFail(A(d, ['publish-completion-report', 'POLICY', 'markdown']), 'publish without a report');
  report(d, 'POLICY'); must(d, ['publish-completion-report', 'POLICY', 'markdown']);
  expectFail(A(d, ['handoff', 'POLICY', 'DONE']), 'DONE before knowledge-done');
  must(d, ['knowledge-done', 'POLICY', 'not_applicable', 'nothing durable changed in this synthetic test run']); must(d, ['handoff', 'POLICY', 'DONE']);
  w(d, 'tasks/POLICY.md', rd(d, 'tasks/POLICY.md').replace(/impl\.txt gained.*/, 'tampered'));
  expectFail(A(d, ['verify-completion-report', 'POLICY']), 'a tampered published report verified');
});

// Standalone: the lead implements and records its own evidence; the implementer role is the wrong owner.
test('sc_standalone: standalone topology (the lead records its own evidence)', () => {
  const d = newRepo(); layerRun(d, 'SOLO', ['impl.txt'], { topology: 'standalone', extra: POLICY_KEYS }); w(d, 'impl.txt', ''); commit(d, 'baseline');
  must(d, ['baseline', 'SOLO']); must(d, ['freeze', 'SOLO']); must(d, ['handoff', 'SOLO', 'IMPLEMENTING']);
  expectFail(ev(d, 'implementer', 'SOLO', 'RED', 'fail', 'impl.txt'), 'implementer evidence under standalone');
  w(d, 'impl.txt', 'implemented by the lead\n');
  expectFail(A(d, ['handoff', 'SOLO', 'IMPLEMENTED']), 'standalone IMPLEMENTED without evidence');
  accepted(ev(d, 'lead', 'SOLO', 'RED', 'fail', 'impl.txt'), 'RED by the lead');
  expectFail(A(d, ['handoff', 'SOLO', 'IMPLEMENTED']), 'standalone IMPLEMENTED with RED only');
  ap(d, 'impl.txt', 'implemented\n'); accepted(ev(d, 'lead', 'SOLO', 'GREEN', 'pass', 'impl.txt'), 'GREEN by the lead');
  assert.ok(rd(d, '.agents/runs/SOLO/worker-evidence/RED-1.yaml').includes('role: "lead"'), 'the evidence names the lead');
  must(d, ['handoff', 'SOLO', 'IMPLEMENTED']); must(d, ['handoff', 'SOLO', 'CODE_DONE']);
});

// A denied evidence write fails closed and leaves nothing behind. A process running as root is not denied by a mode: the check needs another user.
test('sc_write_failure: a denied worker-evidence write fails closed and leaves nothing behind', { skip: process.getuid?.() === 0 ? 'root is not denied by a directory mode' : false }, () => {
  const d = newRepo(); layerRun(d, 'WF', ['impl.txt'], { extra: POLICY_KEYS }); w(d, 'impl.txt', ''); commit(d, 'baseline');
  must(d, ['baseline', 'WF']); must(d, ['freeze', 'WF']); must(d, ['handoff', 'WF', 'IMPLEMENTING']);
  const evd = path.join(d, '.agents/runs/WF/worker-evidence'); mkdirSync(evd, { recursive: true }); chmodSync(evd, 0o555);
  const r = ev(d, 'implementer', 'WF', 'RED', 'fail', 'impl.txt');
  chmodSync(evd, 0o755);
  assert.notEqual(r.status, 0, 'a denied evidence write succeeded');
  assert.ok(/worker evidence/i.test(r.text), `failure message: ${r.text}`);
  assert.deepEqual(readdirSync(evd), [], 'a partial evidence file was left');
  accepted(ev(d, 'implementer', 'WF', 'RED', 'fail', 'impl.txt'), 'RED after the folder is writable again');
  assert.ok(readFileSync(path.join(evd, 'RED-1.yaml')).length > 0, 'RED-1.yaml is empty');
});

// Knowledge transaction scope at DONE, delivery-check and validate.
test('sc_knowledge: the knowledge transaction scope at DONE, delivery-check and validate', () => {
  const d = newRepo(); mkdirSync(path.join(d, 'tasks')); mkdirSync(path.join(d, 'docs/design'), { recursive: true });
  layerRun(d, 'K', ['impl.txt'], { ...SRC('tasks/K.md'), extra: POLICY_KEYS });
  w(d, 'tasks/K.md', '# K task\n'); w(d, 'impl.txt', ''); w(d, 'docs/design/ARCHITECTURE.md', '# Architecture\n'); commit(d, 'baseline');
  must(d, ['baseline', 'K']); must(d, ['freeze', 'K']); must(d, ['handoff', 'K', 'IMPLEMENTING']);
  accepted(ev(d, 'implementer', 'K', 'RED', 'fail', 'impl.txt'), 'RED'); w(d, 'impl.txt', 'implemented\n'); accepted(ev(d, 'implementer', 'K', 'GREEN', 'pass', 'impl.txt'), 'GREEN');
  must(d, ['handoff', 'K', 'IMPLEMENTED']); must(d, ['handoff', 'K', 'CODE_DONE']);
  report(d, 'K'); must(d, ['publish-completion-report', 'K', 'markdown']); must(d, ['validate', 'K']); expectFail(A(d, ['delivery-check', 'K']), 'delivery-check before knowledge-done');
  // added (A200; the shell scenario never asked for it): KNOWLEDGE_DONE is refused while no knowledge page was written
  expectMsg('KNOWLEDGE_DONE with no knowledge page written', 'no knowledge page was written', A(d, ['knowledge-done', 'K', 'KNOWLEDGE_DONE']));
  w(d, 'rogue.txt', 'rogue\n');
  expectFail(A(d, ['handoff', 'K', 'DONE']), 'DONE with an unmapped application path');
  expectFail(A(d, ['validate', 'K']), 'validate with an unmapped application path');
  rmSync(path.join(d, 'rogue.txt'));
  ap(d, 'docs/design/ARCHITECTURE.md', 'new component\n');
  expectFail(A(d, ['handoff', 'K', 'DONE']), 'DONE with a knowledge write and no transaction');
  expectFail(A(d, ['delivery-check', 'K']), 'delivery-check with a knowledge write and no transaction');
  must(d, ['knowledge-done', 'K', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  expectFail(A(d, ['handoff', 'K', 'DONE']), 'DONE with not_applicable and a real knowledge write');
  expectFail(A(d, ['validate', 'K']), 'validate with not_applicable and a real knowledge write');
  must(d, ['knowledge-done', 'K', 'KNOWLEDGE_DONE']); must(d, ['verify-knowledge-scope', 'K']);
  must(d, ['validate', 'K']); must(d, ['handoff', 'K', 'DONE']); must(d, ['delivery-check', 'K']); must(d, ['validate', 'K']);
  git(d, ['checkout', '-q', '--', 'docs/design/ARCHITECTURE.md']);
  expectFail(A(d, ['handoff', 'K', 'DONE']), 'KNOWLEDGE_DONE with zero knowledge writes');
  expectFail(A(d, ['delivery-check', 'K']), 'delivery-check with KNOWLEDGE_DONE and zero writes');
});

// Task branch isolation: <git.branch_prefix><ID>-<slug> from the canonical tip; every phase on that branch.
test('sc_branch: task branch isolation from the canonical tip, every phase on that branch', () => {
  const d = newRepo(); mkdirSync(path.join(d, 'tasks'));
  layerRun(d, 'BR', ['authorized.txt'], { ...SRC('tasks/BR-sample-feature.md'), repoExtra: ['  canonical_branch: PENDING', '  task_branch: PENDING'] });
  w(d, 'authorized.txt', ''); w(d, 'tasks/BR-sample-feature.md', '# sample feature\n'); commit(d, 'baseline');
  const tip = git(d, ['rev-parse', 'HEAD']);
  expectFail(A(d, ['baseline', 'BR']), 'baseline before branch');
  expectFail(AS(d, 'implementer', ['branch', 'BR']), 'implementer created the branch');
  must(d, ['branch', 'BR']);
  assert.equal(git(d, ['branch', '--show-current']), 'proofline/BR-sample-feature');
  assert.equal(git(d, ['rev-parse', 'proofline/BR-sample-feature']), tip);
  must(d, ['branch', 'BR']); assert.equal(git(d, ['branch', '--list', 'proofline/BR-*']).split('\n').filter(Boolean).length, 1, 'the branch was duplicated');
  must(d, ['baseline', 'BR']); must(d, ['freeze', 'BR']); must(d, ['handoff', 'BR', 'IMPLEMENTING']);
  git(d, ['checkout', '-q', 'main']); expectFail(A(d, ['handoff', 'BR', 'IMPLEMENTED']), 'handoff on the canonical branch');
  git(d, ['checkout', '-q', '--detach', tip]); expectFail(A(d, ['handoff', 'BR', 'IMPLEMENTED']), 'handoff on a detached HEAD');
  git(d, ['checkout', '-q', '-b', 'random-feature']); expectFail(A(d, ['handoff', 'BR', 'IMPLEMENTED']), 'handoff on another branch');
  git(d, ['checkout', '-q', 'proofline/BR-sample-feature']); git(d, ['branch', '-D', 'random-feature']);
  must(d, ['handoff', 'BR', 'IMPLEMENTED']); must(d, ['handoff', 'BR', 'CODE_DONE']);
  must(d, ['knowledge-done', 'BR', 'not_applicable', 'nothing durable changed in this synthetic test run']); must(d, ['delivery-check', 'BR']);
  // an existing same-named branch at another tip is never reused or overwritten
  const e = newRepo(); layerRun(e, 'CF', ['tracked.txt'], { repoExtra: ['  canonical_branch: PENDING', '  task_branch: PENDING'] });
  w(e, 'tracked.txt', 'v1\n'); commit(e, 'base'); const b = git(e, ['rev-parse', 'HEAD']);
  git(e, ['branch', 'proofline/CF-run', b]); w(e, 'tracked.txt', 'v2\n'); git(e, ['add', 'tracked.txt']); git(e, ['commit', '-q', '-m', 'advance']);
  expectFail(A(e, ['branch', 'CF']), 'a conflicting branch was reused');
  assert.equal(git(e, ['rev-parse', 'proofline/CF-run']), b, 'the existing branch moved');
  assert.equal(git(e, ['branch', '--show-current']), 'main', 'the checkout moved');
});
