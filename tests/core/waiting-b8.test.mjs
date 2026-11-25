// @ts-check
// A358 (issue 338 item B8; retro items R2-12, R2-20, R3-4): a user question that is open, or a parked task of the batch with a recorded question and nothing
// runnable left, is "waiting for the user". `agent.sh next` and `batch-next` print it on one line, `next-user --waiting` answers it for the Stop hook, and the
// hook adds that one line (never a long text, never a block) while the lead waits. A runnable task keeps the lead going: no waiting line then.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A as AE, stopPlain } from '../enforcement/enforcement-a-lib.mjs';
import { fixture } from '../enforcement/lib.mjs';
import { AB, batchApprove, behave, bnew, binstall, drive, fakes, mktask } from './batch-lib.mjs';

const BP = (/** @type {ReturnType<typeof fakes>} */ F, /** @type {string} */ dir, /** @type {string[]} */ args) => AB(F, dir, ['batch-plan', ...args]);

test('B8 batch: a parked task with a question is a wait only when nothing runnable is left; `batch-next` and `next-user --waiting` name it on one line', () => {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX'); binstall(dir);
  BP(F, dir, ['all']); batchApprove(dir);
  behave(F, 'T-1', 'question');
  // T-1 is runnable at first: the lead must go on, so nothing is a wait
  assert.equal(AB(F, dir, ['next-user', '--waiting']).out, '', 'a runnable task is not a wait');
  drive(F, dir);
  const w = AB(F, dir, ['next-user', '--waiting']);
  assert.equal(w.status, 0, w.text);
  assert.match(w.out, /^waiting for the user: T-1: 1\. Which cache do we use for T-1\?\n$/, `the waiting line: ${w.out}`);
  const bn = AB(F, dir, ['batch-next']).out;
  assert.match(bn, /^waiting for the user: T-1: /m, `batch-next lacks the waiting line: ${bn}`);
  assert.match(bn, /^NEXT: finished/m);
});

test('B8 run: `agent.sh next` of a run with an open ask prints the waiting line, and the Stop hook adds only that line', () => {
  const d = fixture();
  assert.equal(stopPlain(d, 'All is quiet.'), '', 'no question: the hook says nothing');
  const q = AE(d, ['ask', 'LC'], { input: '1. Which cache do we use?\n   - a\n   - b\n   recommended: a\n   why: because\n' });
  assert.equal(q.status, 0, q.text);
  const n = AE(d, ['next', 'LC']);
  assert.match(n.out, /^waiting for the user: LC: 001: 1\. Which cache do we use\?$/m, n.text);
  const out = stopPlain(d, 'Which cache do we use? Reply a or b.').replace(/\n+$/, '');
  assert.equal(out, '{"systemMessage":"proofline: waiting for the user: LC: 1. Which cache do we use?"}', `the hook output: ${out}`);
});
