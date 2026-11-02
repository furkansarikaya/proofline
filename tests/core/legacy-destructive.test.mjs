// @ts-check
// Behaviour of gates-test.sh sc_supervised_destructive (the destructive-plan half) and sc_question_language as absolute Node tests
// (tests/legacy-port-map.tsv): a destructive plan is CRITICAL, its freeze needs the plan approval and expand/contract steps, the destructive
// approval stops the run before IMPLEMENT and is bound to the frozen hash, a single-step plan needs its own approval; the approval question is printed
// in the run's language (A99, A103).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, approveAsUser, project, read, refused, verbs } from './legacy-lib.mjs';

const qa = (/** @type {string} */ d, /** @type {string[]} */ ...args) => verbs(d, `A ${args.join(' ')}`);
const append = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => writeFileSync(`${d}/.agents/runs/LC/${f}`, t, { flag: 'a' });
const state = (/** @type {string} */ d) => /^handoff:\n(?: {2}.*\n)*? {2}state: "?(\w+)"?$/m.exec(read(d, '.agents/runs/LC/RUN.yaml'))?.[1];
const STEPS_HEAD = '\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n';
const UNFROZEN_STANDARD = 'scaffold standalone no STANDARD manual';

test('destructive plan: forced CRITICAL, freeze on the plan approval, expand/contract steps, destructive approval before IMPLEMENT', () => {
  const d = project(UNFROZEN_STANDARD);
  append(d, 'PLAN.md', '\n## Data\n\ndestructive: maybe\n');
  refused(qa(d, 'freeze', 'LC'), 'an invalid ## Data first line', 'destructive: yes');
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md').replace('destructive: maybe', 'destructive: yes'));
  refused(qa(d, 'freeze', 'LC'), 'a destructive plan froze without the plan approval');
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /^ {2}classification: "?CRITICAL"?$/m);
  refused(A(d, ['classify', 'LC', 'STANDARD']), 'a destructive plan reclassified below CRITICAL', 'CRITICAL');
  approveAsUser(d, 'plan', 'approve the plan');
  refused(qa(d, 'freeze', 'LC'), 'a destructive plan with no expand/contract steps froze', 'without expand/contract steps');
  assert.ok(A(d, ['next', 'LC']).out.includes('destructive plan without expand/contract steps'), 'next does not name the missing expand/contract steps');
  // a one-release plan: the destructive step shares the expand phase
  append(d, 'PLAN.md', `${STEPS_HEAD}| S1 | expand | drop_column | books.legacy_notes | yes | no | restore from backup | table rewrite |\n`);
  approveAsUser(d, 'plan', 'approve this plan');
  refused(qa(d, 'freeze', 'LC'), 'a one-release destructive plan froze', 'without expand/contract steps');
  // expand then contract: accepted with the plan approval alone
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md').split('\n').filter((l) => !l.startsWith('| S1 | expand | drop_column')).join('\n'));
  append(d, 'PLAN.md', '| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh request-approval LC plan/m, 'next does not ask for the plan approval of the final plan');
  assert.ok(!A(d, ['next', 'LC']).out.includes('destructive approval required before'), 'next asks for the destructive approval before the freeze');
  approveAsUser(d, 'plan', 'please approve the plan');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh freeze LC/m, 'next does not offer the freeze with only the plan approval');
  accepted(qa(d, 'freeze', 'LC'), 'a destructive plan with the plan approval was not frozen');
  assert.equal(A(d, ['pipeline', 'LC']).out.match(/^tier=(.*)$/m)?.[1], 'full');
  assert.equal(state(d), 'PLANNED');
  // after the freeze: next asks for the destructive approval, bound to the frozen hash, before IMPLEMENT
  const next = A(d, ['next', 'LC']).out;
  assert.match(next, /^next=agent\.sh request-approval LC destructive/m); assert.match(next, /^reason=destructive approval required before IMPLEMENT/m);
  assert.ok(!next.includes('agent.sh handoff LC IMPLEMENTING'), 'next offers the handoff before the destructive approval');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING without the destructive approval', 'agent.sh request-approval LC destructive');
  assert.equal(state(d), 'PLANNED');
  approveAsUser(d, 'destructive', 'approve the destructive migration');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh handoff LC IMPLEMENTING/m, 'next does not offer the handoff after the destructive approval');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING with a valid destructive approval');
  assert.equal(state(d), 'IMPLEMENTING');
});

test('a refreeze drops the destructive approval; single_step: yes needs the user\'s single-step approval', () => {
  const d = project(UNFROZEN_STANDARD);
  append(d, 'PLAN.md', '\n## Data\n\ndestructive: yes\n\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | contract | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n');
  approveAsUser(d, 'plan', 'approve plan');
  accepted(qa(d, 'freeze', 'LC'), 'freeze');
  approveAsUser(d, 'destructive', 'approve destructive migration');
  mkdirSync(`${d}/.agents/runs/LC/amendments`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/amendments/001.md`, '# amendment 001: clarify the migration\n');
  append(d, 'PLAN.md', 'amended: migration note\n');
  approveAsUser(d, 'plan', 'approve a plan');
  assert.ok(qa(d, 'refreeze', 'LC', '001.md').text.includes('destructive / single_step approval was bound to the old one'), 'refreeze does not say the destructive approval was dropped');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING with an approval bound to the old PLAN.md', 'agent.sh request-approval LC destructive');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh request-approval LC destructive/m);
  approveAsUser(d, 'destructive', 'approve the destructive migration please');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING after the destructive approval of the new hash');
  // an explicit single-step approval is the only way to a one-step destructive change
  const e = project(UNFROZEN_STANDARD);
  append(e, 'PLAN.md', '\n## Data\n\ndestructive: yes\nsingle_step: yes\n\ndrop books.legacy_notes in one migration\n');
  append(e, 'TASK.md', '\nThe user wants this migration as a single step.\n');
  approveAsUser(e, 'plan', 'yes approve the plan');
  accepted(qa(e, 'freeze', 'LC'), 'a single_step plan was not frozen on the plan approval');
  approveAsUser(e, 'destructive', 'please approve destructive migration');
  refused(A(e, ['handoff', 'LC', 'IMPLEMENTING']), 'a single_step plan reached IMPLEMENTING without the single-step approval', 'single-step approval');
  assert.match(A(e, ['next', 'LC']).out, /^next=agent\.sh request-approval LC single_step/m);
  approveAsUser(e, 'single_step', 'approve single step');
  accepted(A(e, ['handoff', 'LC', 'IMPLEMENTING']), 'an approved single-step plan');
});

test('approval questions: a Turkish run prints Turkish with approve/reject and the kind word; an English run is unchanged (A99, A103)', () => {
  const d = project('scaffold standalone no COMPLEX manual');
  const hist = `${d}/.agents/local/prompts/history`;
  mkdirSync(hist, { recursive: true });
  const kinds = ['plan', 'destructive', 'single_step', 'scope', 'budget', 'commit', 'push'];
  for (const k of kinds) {
    const q = accepted(A(d, ['request-approval', 'LC', k]), `request ${k}`).out;
    assert.ok(q.includes(`1. Approve ${k} for LC?`) && q.includes('   options: approve | reject'), `English run: ${k} question changed`);
  }
  // a Turkish prompt of six or more words makes the run Turkish
  writeFileSync(`${hist}/1000000001-aaaaaaaa.txt`, 'Lütfen bu görevi yap ve sonra bana bir özet ver\n');
  for (const k of kinds) {
    const q = accepted(A(d, ['request-approval', 'LC', k]), `request ${k} (tr)`).out;
    assert.ok(/^QUESTIONS:$/m.test(q) && q.includes(`1. LC için ${k} onaylansın mı?`), `Turkish run: ${k} question is not Turkish`);
    assert.ok(q.includes('   seçenekler: approve | reject (onay için "approve ') && q.includes('   önerilen: yok') && q.includes('   neden: '), `Turkish run: ${k} options lost the approval words`);
    assert.doesNotMatch(q, /Approve|options:|recommended:|why:/, `Turkish run: ${k} question still holds English labels`);
  }
  // the user's own words decide: English replies and system-looking prompts never flip a Turkish run
  writeFileSync(`${hist}/1000000002-bbbbbbbb.txt`, 'approve commit\n');
  writeFileSync(`${hist}/1000000003-cccccccc.txt`, 'You are the reviewer subagent. Please read the diff and report findings now\n');
  assert.ok(A(d, ['request-approval', 'LC', 'plan']).out.includes('LC için plan onaylansın mı?'), 'newer English prompts flipped a Turkish run');
  void readFileSync;
});
