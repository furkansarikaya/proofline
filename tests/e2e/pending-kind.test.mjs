// @ts-check
// Self-test of tests/e2e/lib.mjs (the former pending-kind-test.sh): the harness answers a plan approval and nothing else.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pendingKind, questionOpen, replyDecision } from './lib.mjs';

const t = mkdtempSync(path.join(tmpdir(), 'qopen-'));
after(() => rmSync(t, { recursive: true, force: true }));

test('pending-kind: a plan approval and every other kind is read from `next`', () => {
  const check = (/** @type {string} */ label, /** @type {string} */ state, /** @type {string} */ want) => assert.equal(pendingKind(state), want, label);
  check('a requested plan approval', 'next=agent.sh request-approval LC plan (relay verbatim)\nreason=plan approval required before freeze', 'plan');
  check("a plan approval waiting for the user's reply", "next=wait for the user's answer (the runtime records it from their reply; the lead never runs approve), then: agent.sh next LC\nreason=plan approval required before freeze", 'plan');
  check('a destructive approval', 'next=agent.sh request-approval LC destructive (relay verbatim)\nreason=destructive approval required before IMPLEMENT', 'destructive');
  check('a single-step approval', 'reason=single_step approval required before IMPLEMENT', 'single_step');
  check('a scope approval', 'next=agent.sh request-approval LC scope (relay verbatim)', 'scope');
  check('the delivery commit approval', "next=agent.sh request-approval LC commit (delivery needs the user's approval)\nreason=run DONE", 'commit');
  check('a waiver approval', 'next=agent.sh request-approval LC waive:REVIEW_RULES-1 (relay verbatim)', 'waive:REVIEW_RULES-1');
  check('no approval pending', 'next=agent.sh freeze LC\nreason=artifacts ready', '');
});

test('question-open: the scripted question reply is sent only while a question is open', () => {
  const last = path.join(t, 'last');
  const qo = (/** @type {string} */ label, /** @type {string} */ state, /** @type {boolean} */ want, /** @type {string} */ id = '') => assert.equal(id ? questionOpen(state, last, id) : questionOpen(state, last), want, label);
  writeFileSync(last, 'Which option do you prefer?\n');
  qo('the lead asks a question', 'next=agent.sh handoff LC IMPLEMENTING', true);
  writeFileSync(last, 'Please run rm .agents/x and tell me when it is gone.\n');
  qo('the lead waits for a user action, no question', 'next=agent.sh handoff LC IMPLEMENTING', false);
  qo('a pending question named by next', 'next=agent.sh questions LC\nreason=a question is pending (a specialist NEEDS_INPUT)', true);
  // A131: a question mark in an explanation is no open question while the run names a step of its own.
  writeFileSync(last, 'Why is AS-2 unsettled? A blanket reply cannot settle it. Reply accept AS-2.\n');
  qo('a question mark with a named run step is no open question', 'next=agent.sh verify-assumptions T-1', false, 'T-1');
  qo('a question mark before any task is a question', '', true, 'none');
  qo('a question mark with no agent.sh step is a question', 'reason=waiting', true, 'T-1');
  qo('a pending question wins over a named step', 'next=agent.sh questions T-1\nreason=a question is pending (a specialist NEEDS_INPUT)', true, 'T-1');
});

test('approvals-dir: a refreeze asks a second plan approval while `next` prints the fix-round step (run B1-COMPLEX, A128)', () => {
  const dir = path.join(t, 'approvals');
  mkdirSync(dir);
  const fix = 'next=agent.sh handoff T-1 IMPLEMENTING (fix round 2)\nreason=failing gates: REVIEW_RULES REVIEW_TESTS';
  const touch = (/** @type {string} */ ...names) => { for (const n of names) writeFileSync(path.join(dir, n), ''); };
  touch('001-request-plan.yaml', '002-plan.yaml');
  assert.equal(pendingKind(fix, dir), '', 'an answered plan approval is not pending');
  touch('003-request-plan.yaml');
  assert.equal(pendingKind(fix, dir), 'plan', 'the second plan approval after an amendment');
  touch('004-plan.yaml', '005-request-commit.yaml');
  assert.equal(pendingKind(fix, dir), 'commit', 'a commit request is never mistaken for a plan');
  assert.equal(pendingKind('next=agent.sh request-approval T-1 scope (relay verbatim)', dir), 'scope', 'next naming an approval wins');
  // Every kind agent.sh can request, as the file slug it writes (kind_slug: ':' becomes '-'), maps back to its kind.
  for (const [slug, kind] of [['destructive', 'destructive'], ['single_step', 'single_step'], ['scope', 'scope'], ['budget', 'budget'], ['commit', 'commit'], ['push', 'push'], ['waive-F-1', 'waive:F-1']]) {
    for (const f of readdirSync(dir)) rmSync(path.join(dir, f));
    touch('001-request-plan.yaml', '002-plan.yaml', `003-request-${slug}.yaml`);
    assert.equal(pendingKind(fix, dir), kind, `a pending ${slug} file is read as ${kind}`);
  }
});

test('reply-decision: only exactly `plan` is answered as an approval', () => {
  const dec = (/** @type {string} */ label, /** @type {string} */ kind, /** @type {string} */ text, /** @type {string} */ want) => assert.equal(replyDecision(kind, text), want, label);
  dec('plan is answered', 'plan', '', 'plan');
  for (const k of ['destructive', 'single_step', 'scope', 'budget', 'commit', 'push', 'waive:F-1', 'waive-F-1', 'unknown']) dec(`${k} is never answered`, k, '', 'stop');
  dec('a question gets the scripted reply', '', 'Which option do you prefer?', 'question');
  const acc = '   accepted answers: approve, yes, commit it, push it (with the kind word)';
  const trAcc = '   kabul edilen onay sözcükleri: approve, evet, commit it, push it (tür sözcüğüyle birlikte)';
  dec('the English accepted-answers line is no commit request', '', acc, 'question');
  dec('the Turkish accepted-answers line is no commit request', '', trAcc, 'question');
  dec('a real sentence next to the list still counts', '', `${acc}\nPlease commit it now.`, 'stop');
});
