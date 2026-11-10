// @ts-check
// Ports of gates-test.sh sc_start, sc_mutation_budget, sc_report_focus_lines, sc_control_plane_edit, sc_report_execution, sc_legacy_fingerprint_new_rule
// and sc_build_record_auto as absolute Node tests (tests/legacy-port-map.tsv). Every assertion, attack input and message of the shell scenarios stays.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, cleanEnv, commitAll, expectFail, expectMsg, must, newRepo, passAll, read, rv, say, scaffold, solo, toCodeDone, tsha, worker } from '../lib/harness.mjs';

/** @param {string} s */
const lines = (s) => s.split('\n');
/** The text of the task body the shell scenario feeds `start`. */
const START_BODY = `## Goal

Record one task.

## Context

Fixture.

## Acceptance criteria

- AC-1: The task starts.

## Out of scope

- Other changes.

## Constraints

- POSIX sh.

## Risks

- Incorrect task state.

## Suggested class

TRIVIAL — documentation only.

## Verification commands

- \`sh -n script.sh\`
`;

test('sc_start: stdin, adapter task, ledger, classify/branch/baseline/freeze, duplicate/open/missing refusals', () => {
  const d = newRepo();
  rmSync(path.join(d, '.agents/task-integrations/markdown.sh'), { force: true });   // A216: the built-in markdown adapter, not the fixture stub
  commitAll(d, 'base');
  assert.ok(A(d, ['next']).out.includes('next=agent.sh start <ID>'), 'next did not guide intake');
  expectMsg('invalid task ID accepted', 'invalid task id', A(d, ['start', '../bad', '--title', 'bad']));
  must(d, ['start', 'ST-1', '--title', 'Record task'], { input: START_BODY });
  assert.equal(rv(d, 'task_source', 'type', 'ST-1'), 'local_markdown', 'start did not set task source and adapter');
  assert.equal(rv(d, 'completion_report', 'adapter', 'ST-1'), 'markdown', 'start did not set task source and adapter');
  assert.ok(read(d, '.agents/tasks/in-progress/ST-1-record-task.md').includes('**Status:** in-progress'), 'start task status missing');
  assert.ok(read(d, '.agents/runs/ST-1/LEDGER.log').includes('event=start '), 'start ledger missing');
  expectMsg('duplicate start accepted', 'run already exists', A(d, ['start', 'ST-1', '--task-file', '.agents/tasks/in-progress/ST-1-record-task.md']));
  expectMsg('second open run accepted', 'another open run', A(d, ['start', 'ST-2', '--title', 'second']));
  must(d, ['classify', 'ST-1', 'TRIVIAL']); must(d, ['branch', 'ST-1']); must(d, ['baseline', 'ST-1']);
  writeFileSync(path.join(d, '.agents/runs/ST-1/PLAN.md'), `---
scope:
  - path: example.txt
    new: true
    criteria: [AC-1]
---
# Plan

## Assumptions

none

## Behavior

Record task.

## Tests

Check the task.

## Verification commands

- \`sh -n script.sh\`
`);
  const fr = A(d, ['freeze', 'ST-1'], { bind: true });
  assert.equal(fr.status, 0, `start to freeze failed: ${fr.text}`);
  assert.notEqual(rv(d, 'task_source', 'revision', 'ST-1'), 'PENDING', 'freeze left task source revision pending');

  const e = newRepo();
  rmSync(path.join(e, '.agents/task-integrations/markdown.sh'), { force: true });   // A216: the built-in markdown adapter
  commitAll(e, 'base');
  const incomplete = `${START_BODY.slice(0, START_BODY.indexOf('## Risks')).replace(/\n+$/, '')}\n`;   // sed '/## Risks/,$d'
  let r = A(e, ['start', 'ST-3', '--title', 'incomplete'], { input: incomplete });
  assert.ok(r.status === 3 && r.text.includes('MISSING risks'), `missing canonical field did not exit 3 and print field: ${r.status} ${r.text}`);
  assert.ok(!existsSync(path.join(e, '.agents/runs/ST-3')), 'incomplete start created a run');
  r = A(e, ['start', 'ST-3'], { input: START_BODY });
  assert.ok(r.status === 3 && r.text.includes('MISSING title'), `missing task title did not exit 3 and print field: ${r.status} ${r.text}`);
  mkdirSync(path.join(e, '.agents/tasks/backlog'), { recursive: true });
  writeFileSync(path.join(e, '.agents/tasks/backlog/ST-3-incomplete.md'), `# Task: ST-3 — Incomplete\n\n**Status:** backlog\n\n${incomplete}`);
  r = A(e, ['start', 'ST-3', '--task-file', '.agents/tasks/backlog/ST-3-incomplete.md']);
  assert.ok(r.status === 3 && r.text.includes('MISSING risks') && !existsSync(path.join(e, '.agents/runs/ST-3')), `incomplete task file did not exit 3 without a run: ${r.status} ${r.text}`);
  writeFileSync(path.join(e, '.agents/tasks/backlog/ST-4-imported-task.md'), `# Task: ST-4 — Imported task\n\n**Status:** backlog\n\n${START_BODY}`);
  must(e, ['start', 'ST-4', '--task-file', '.agents/tasks/backlog/ST-4-imported-task.md']);
  assert.ok(existsSync(path.join(e, '.agents/tasks/in-progress/ST-4-imported-task.md')) && read(e, '.agents/local/ACTIVE_RUN').trim() === 'ST-4', 'existing task file was not moved and activated');
  assert.equal(rv(e, 'task_source', 'path', 'ST-4'), '.agents/tasks/in-progress/ST-4-imported-task.md', 'existing task path was not recorded');
  expectMsg('non-lead started a run', 'command denied for reviewer', AS(e, 'reviewer', ['start', 'ST-5', '--title', 'denied']));
});

// Evidence run: 33 criteria in PLAN ## Tests, test_trust.mutation_budget 20, REVIEW_TESTS BLOCKED twice. Now the freeze asks the user once, and a
// user-approved per-run raise (config untouched) resolves it.
test('sc_mutation_budget: freeze asks once, per-run raise needs the user\'s approval, config untouched', () => {
  const planExtra = `\n## Tests\n\n${Array.from({ length: 33 }, (_, i) => `- AC-${i + 1}: \`impl_test.txt\` "case ${i + 1}"`).join('\n')}`;
  const d = scaffold({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual', planExtra });
  const cfgBefore = tsha(path.join(d, '.agents/config.yaml'));
  expectMsg('a freeze with 33 criteria over budget 20', 'raise-budget LC 33', A(d, ['freeze', 'LC'], { bind: true }));
  A(d, ['freeze', 'LC'], { bind: true });
  const asked = readdirSync(path.join(d, '.agents/runs/LC/approvals')).filter((n) => n.endsWith('-request-mutation_budget.yaml'));
  assert.equal(asked.length, 1, 'the user was not asked exactly once');
  expectMsg("raise-budget without the user's approval", "needs the user's approval", A(d, ['raise-budget', 'LC', '33']));
  say(d, 'approve the mutation budget'); must(d, ['approve', 'LC', 'mutation_budget']);
  expectFail(A(d, ['raise-budget', 'LC', '30']), 'a raise below the criteria count');
  must(d, ['raise-budget', 'LC', '33']);
  assert.equal(read(d, '.agents/runs/LC/mutation_budget').trim(), '33', 'the run override was not recorded');
  assert.equal(tsha(path.join(d, '.agents/config.yaml')), cfgBefore, 'raise-budget edited .agents/config.yaml');
  const fr = A(d, ['freeze', 'LC'], { bind: true });
  assert.equal(fr.status, 0, `the freeze still fails after the approved raise: ${fr.text}`);
});

// Evidence run: REVIEW_RULES and REVIEW_RULES:config were mixed in one report line. Each sub-focus has its own line.
test('sc_report_focus_lines: a risk sub-focus is shown on its own line', () => {
  const d = scaffold({ topology: 'standalone' });
  writeFileSync(path.join(d, '.env.example'), 'KEY=\n');
  const out = must(d, ['report-facts', 'LC']).out;
  assert.ok(lines(out).some((l) => /^- Gate REVIEW_[A-Z]*: .*findings: none$/.test(l)) && lines(out).some((l) => /^ {2}- Focus REVIEW_[A-Z]*:config: [a-z_]*; findings: /.test(l)),
    `the config sub-focus has no line of its own: ${out}`);
});

// A user edit of a control-plane file under .agents/ is no task change: verify-scope lists it apart, the tier ignores it.
test('sc_control_plane_edit: control-plane edits under .agents/ are listed apart, not counted as task changes', () => {
  const d = scaffold({ topology: 'standalone' });
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  const tierBefore = must(d, ['tier', 'LC']).out.replace(/\n+$/, '');
  appendFileSync(path.join(d, '.agents/config.yaml'), '# user note\n'); writeFileSync(path.join(d, '.agents/extra.yaml'), 'x\n');
  const vs = A(d, ['verify-scope', 'LC']);
  assert.equal(vs.status, 0, `a user edit under .agents/ failed the scope check: ${vs.text}`);
  assert.ok(vs.out.includes('control-plane files changed under .agents/') && /\.agents\/config\.yaml/.test(vs.out), 'the control-plane edits are not listed apart');
  assert.equal(must(d, ['tier', 'LC']).out.replace(/\n+$/, ''), tierBefore, `a control-plane edit raised the tier from ${tierBefore}`);
  writeFileSync(path.join(d, 'stray.go'), 'x\n');
  expectFail(A(d, ['verify-scope', 'LC']), 'a task-introduced path outside the scope passed');
});

// A203: the `## Execution` table of the completion report is generated by the script from the decision records; what the lead wrote there is replaced.
test('sc_report_execution: the Execution table is generated from the decision records and replaces the lead\'s text', () => {
  const d = scaffold({ topology: 'orchestrated' }); toCodeDone(d, 'orchestrated');
  mkdirSync(path.join(d, '.agents/runs/LC/decisions'), { recursive: true });
  writeFileSync(path.join(d, '.agents/runs/LC/decisions/001-implementer.decision'), 'role=implementer\nfocus=\nruntime=claude\nruntime_reason=CONFIG_RUNTIME_GROUP\nmodel=sonnet\neffort=medium\nescalated=no\nsignals=\n');
  writeFileSync(path.join(d, '.agents/runs/LC/decisions/002-reviewer-rules-tests.decision'),
    'role=reviewer\nfocus=rules+tests\nruntime=codex\nruntime_reason=AUTOMATIC_FAILOVER\nmodel=gpt-6-sol\neffort=high\nescalated=yes\nescalation_reason=ESCALATED_MODEL\nsignals=low_confidence_pass\n');
  const ex = A(d, ['report-execution', 'LC']);
  assert.equal(ex.status, 0, 'report-execution failed');
  assert.ok(ex.out.includes('| implementer | - | claude | sonnet | medium | none | - |'), `implementer row missing: ${ex.out}`);
  assert.ok(ex.out.includes('| reviewer | rules+tests | codex | gpt-6-sol | high | low_confidence_pass | failover (automatic) to codex; escalated (ESCALATED_MODEL) |'), `failover row missing or wrong: ${ex.out}`);
  assert.ok(!ex.out.includes('OPERATOR_OVERRIDE'), 'an automatic failover is shown as an operator override');
  // the lead's own '## Execution' text says 'Not applicable in fixtures.'
  writeFileSync(path.join(d, '.agents/runs/LC/COMPLETION_REPORT.md'), `${['# Completion Report: LC', '', '## Implementation Summary', 'impl.txt and impl_test.txt changed under the lifecycle gates.', '', '## TDD Evidence',
    'RED then GREEN recorded by the expected implementation owner.', '', '## Verification', 'All gates passed on the final tree.', '', '## Assumptions', 'none', '', '## Review Result', 'Approved on the final tree.', '',
    '## QA Result', 'Every frozen QA scenario passed on the final tree.', '', '## Execution', 'Not applicable in fixtures.', '', '## Known Limitations / Follow-up', 'None.'].join('\n')}\n`);
  const pub = A(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.equal(pub.status, 0, `publish failed: ${pub.text}`);
  const rep = read(d, '.agents/runs/LC/COMPLETION_REPORT.md');
  assert.ok(rep.includes('| reviewer | rules+tests | codex | gpt-6-sol | high |'), 'the published report has no generated Execution row');
  assert.ok(!rep.includes('Not applicable in fixtures'), "the lead's hand-written Execution text survived publish");
  assert.equal(lines(rep).filter((l) => l.startsWith('## Execution')).length, 1, 'the Execution heading is not unique');
});

// A161 (#133): gates recorded by 0.0.12/0.0.13 stay valid once; gates recorded on the current rule never need the legacy path.
test('sc_legacy_fingerprint_new_rule: gates recorded on the current rule are stale after a product edit; the legacy path never revives them', () => {
  const d = scaffold({ topology: 'orchestrated' });
  writeFileSync(path.join(d, 'AGENTS.md'), '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n'); commitAll(d, 'chore: block-only AGENTS.md');
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d);
  const gl = () => lines(must(d, ['pipeline', 'LC']).out).filter((l) => l.startsWith('gate.'));
  assert.deepEqual(gl().filter((l) => !l.includes('=pass')), [], 'gates on the current rule are not fresh');
  appendFileSync(path.join(d, 'impl.txt'), 'one more line\n');
  assert.ok(gl().some((l) => /^gate\..*=stale/.test(l)), 'a product edit did not stale the current-rule gates');
  assert.ok(!gl().some((l) => l.includes('=pass')), 'a current-rule gate survived a product edit via the legacy path');
});

// A171: the build record is made before the review gate wave (at handoff IMPLEMENTED) and, when it is missing, `next` names it as a missing step.
test('sc_build_record_auto: made at handoff IMPLEMENTED; next shows a missing record as the first missing step and drops it once made', () => {
  /** `next` of the Node core, as the shell scenario ran it. @param {string} dir */
  const nxt = (dir) => A(dir, ['next', 'LC']).out;
  const d = scaffold({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual' });
  const cfg = path.join(d, '.agents/config.yaml');
  writeFileSync(cfg, lines(readFileSync(cfg, 'utf8')).map((l) => (l.startsWith('  build:') ? '  build: echo built-line' : l.startsWith('  test:') ? '  test: echo tested-line' : l)).join('\n'));
  must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  const shown = A(d, ['build-record', 'LC', 'show']);
  assert.equal(shown.status, 0, `handoff IMPLEMENTED did not make the build record (show exit ${shown.status})`);
  assert.ok(must(d, ['build-record', 'LC', 'show']).out.includes('tested-line'), 'the automatic record lacks the test output');
  // a tree without a record (here: removed after the handoff) shows the step first in next
  rmSync(path.join(d, '.agents/local/builds'), { recursive: true, force: true });
  const nx = nxt(d);
  assert.ok(nx.includes('next=agent.sh build-record LC run'), `next does not show the missing build record: ${nx}`);
  const first = lines(nx).find((l) => l.includes('next='));
  assert.ok(first !== undefined && first.includes('build-record'), `the build record is not the first step: ${nx}`);
  must(d, ['build-record', 'LC', 'run']);
  assert.ok(!nxt(d).includes('build-record'), 'next still names the build record after it was made');
});
