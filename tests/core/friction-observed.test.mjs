// @ts-check
// C8e of issue 338 (A363): the workarounds the control plane sees itself (a stray discarded, a mutation budget raised, a worktree removed with --force) count as proofline_bug in the
// friction report and in the Facts line, so a run that needed them cannot report `proofline_bug 0`. Hand edits and SendMessage patches are not observable and are not counted.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { ledgerAppend } from '../../control-plane/agents/scripts/core/lock.mjs';
import { frictionCount, observedWorkarounds } from '../../control-plane/agents/scripts/core/next.mjs';
import { A } from './legacy-lib.mjs';
import { newProject } from './helper-lib.mjs';
import { makeProject, memoryIo, repo } from './helpers.mjs';

const FIX = path.join(repo, 'tests/fixtures/friction');

test('the report counts the observed workarounds in proofline_bug and lists them; a run with none says what it said before', () => {
  const d = newProject();
  mkdirSync(`${d}/.agents/runs/RUN-001`, { recursive: true });
  mkdirSync(`${d}/.agents/local/metrics`, { recursive: true });
  cpSync(`${FIX}/LEDGER.log`, `${d}/.agents/runs/RUN-001/LEDGER.log`);
  cpSync(`${FIX}/records.jsonl`, `${d}/.agents/local/metrics/records.jsonl`);
  const none = A(d, ['friction', 'report', 'RUN-001']);
  assert.equal(none.status, 0, none.text);
  const before = readFileSync(`${d}/.agents/local/friction/latest.md`, 'utf8');
  assert.match(before, /worked around \(proofline_bug\): 0$/m);
  assert.ok(!before.includes('saw itself'));
  appendFileSync(`${d}/.agents/runs/RUN-001/LEDGER.log`, [
    'seq=200 event=discard-untracked role=lead from=PLANNED to=PLANNED detail=path=r7 files=1 sha256=abc',
    'seq=201 event=raise-budget role=lead from=- to=- detail=test_trust.mutation_budget 30 for this run, approval x',
    'seq=202 event=forced-removal role=lead from=- to=- detail=worktree-remove T-1 --force',
    'seq=203 event=forced-removal role=lead from=- to=- detail=worktree-remove T-2 --force', '',
  ].join('\n'));
  assert.equal(A(d, ['friction', 'report', 'RUN-001']).status, 0);
  const after = readFileSync(`${d}/.agents/local/friction/latest.md`, 'utf8');
  assert.match(after, /worked around \(proofline_bug\): 4$/m);
  assert.match(after, /workarounds the control plane saw itself \(counted in proofline_bug\): 4$/m);
  assert.match(after, /untracked files discarded \(discard-untracked\): 1$/m);
  assert.match(after, /mutation budgets raised \(raise-budget\): 1$/m);
  assert.match(after, /worktrees removed with --force: 2$/m);
});

test('the Facts count of proofline_bug adds the observed rows to the notes the lead wrote', () => {
  const root = makeProject();
  const { io } = memoryIo(root);
  const ctx = new Context(io, io.scriptPath ?? '');
  const dir = `${root}/.agents/runs/RUN-1`;
  mkdirSync(dir, { recursive: true });
  ledgerAppend(dir, 'lead', 'friction-note', '-', '-', 'proofline_bug');
  ledgerAppend(dir, 'lead', 'friction-note', '-', '-', 'user-command');
  assert.equal(frictionCount(ctx, dir, 'proofline_bug'), '1');
  ledgerAppend(dir, 'lead', 'discard-untracked', 'PLANNED', 'PLANNED', 'path=r7 files=1 sha256=abc');
  ledgerAppend(dir, 'lead', 'forced-removal', '-', '-', 'worktree-remove T-1 --force');
  ledgerAppend(dir, 'lead', 'answer', '-', '-', '001.md answered_by=lead');
  ctx.forget('file:');   // the ledger text is read once per context
  assert.deepEqual(observedWorkarounds(ctx, dir), { discards: 1, budgetRaises: 0, forcedRemovals: 1, total: 2 });
  assert.equal(frictionCount(ctx, dir, 'proofline_bug'), '3');
  assert.equal(frictionCount(ctx, dir, 'user-command'), '1', 'only proofline_bug takes the observed rows');
});
