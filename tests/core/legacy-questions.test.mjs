// @ts-check
// Behaviour of gates-test.sh sc_questions and sc_ask as absolute Node tests (tests/legacy-port-map.tsv): a specialist's NEEDS_INPUT stores the questions
// verbatim and parks the run, `next` points at them, one NEEDS_INPUT round per role; the lead's `ask` is pending, verbatim and ledgered; the user's answer
// is recorded by `answer --captured` (typed text is the lead's answer since #187: the shell's "contained in the capture" rule is gone on purpose).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, project, read, refused, say, template } from './legacy-lib.mjs';

const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const rv = (/** @type {string} */ d, /** @type {string} */ section, /** @type {string} */ key) => {
  let inside = false;
  for (const l of read(d, '.agents/runs/LC/RUN.yaml').split('\n')) {
    if (l === `${section}:`) { inside = true; continue; }
    if (inside && /^[^ #]/.test(l)) inside = false;
    const m = inside ? new RegExp(`^  ${key}:[ \\t]*(.*)$`).exec(l) : null;
    if (m) return m[1].replace(/"/g, '');
  }
  return '';
};
void template;

test('NEEDS_INPUT: stored verbatim, one round per role, awaiting_input until every question is answered, answers from the user\'s captured message', () => {
  const d = project('scaffold orchestrated');
  const art = 'reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md';
  mkdirSync(`${d}/.agents/runs/LC/reports/snapshots`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/${art}`, '# explorer notes\n');
  /** @param {string} role @param {string} questions */
  const q = (role, questions) => {
    const f = `${d}/.agents/local/q-${role}.md`;
    writeFileSync(f, `ROLE: ${role}\nTASK: LC\nRESULT: NEEDS_INPUT\nCONFIDENCE: medium\nFINGERPRINT: ${A(d, ['fingerprint', 'LC']).out.trim()}\nARTIFACT: ${art} ${sha(`${d}/.agents/runs/LC/${art}`)}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n\n${questions}`);
    return A(d, ['record', 'LC', '--file', f], { role });
  };
  refused(q('explorer', ''), 'NEEDS_INPUT without questions', 'QUESTIONS');
  accepted(q('explorer', 'QUESTIONS:\n1. Which default should an empty key return?\n   options: nil | empty string\n   recommended: nil\n   why: AC-1 depends on it\n'), 'first NEEDS_INPUT');
  const second = 'QUESTIONS:\n1. Keep the old lookup name?\n   options: yes | no\n   recommended: yes\n   why: callers depend on it\n';
  refused(q('explorer', second), 'a second NEEDS_INPUT from the same role', 'already asked its questions in this run');
  assert.throws(() => read(d, '.agents/runs/LC/questions/002.md'), 'a rejected second NEEDS_INPUT was stored');
  accepted(q('architect', second), 'another role may ask');
  assert.equal(rv(d, 'execution', 'awaiting_input'), 'true');
  assert.ok(A(d, ['questions', 'LC']).out.includes('1. Which default should an empty key return?'), 'questions are not relayed verbatim');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh questions LC/m);
  // typed text is the lead's, even when it matches what the user said
  say(d, 'the answer is: empty string');
  accepted(A(d, ['answer', 'LC', '1'], { input: 'empty string\n' }), 'typed answer');
  assert.match(read(d, '.agents/runs/LC/questions/001.answer.md'), /^answered_by: lead$/m);
  assert.equal(rv(d, 'execution', 'awaiting_input'), 'true');
  // the user's own message, captured: answered_by user, verbatim, naming its source
  say(d, 'yes, keep it');
  const r = accepted(A(d, ['answer', 'LC', '2', '--captured']), 'captured answer');
  assert.match(read(d, '.agents/runs/LC/questions/002.answer.md'), /^answered_by: user$/m);
  assert.match(r.out, /answer source: the user's message \d+-[0-9a-f]{8}\.txt/);
  assert.equal(rv(d, 'execution', 'awaiting_input'), 'false', 'awaiting_input stays true with no question pending');
});

test('ask: the lead\'s question is pending, verbatim, ledgered, answered like a specialist\'s', () => {
  const d = project('scaffold orchestrated');
  writeFileSync(`${d}/.agents/local/ask.md`, 'QUESTIONS:\n1. Split the cache into its own module?\n   options: yes | no\n   recommended: no\n   why: AC-1 is met either way\n');
  refused(A(d, ['ask', 'LC', '--file', `${d}/.agents/local/ask.md`], { role: 'reviewer' }), 'a specialist asked as the lead');
  refused(A(d, ['ask', 'LC'], { input: 'no question here\n' }), 'ask without a numbered question');
  accepted(A(d, ['ask', 'LC', '--file', `${d}/.agents/local/ask.md`]), 'ask');
  assert.equal(rv(d, 'execution', 'awaiting_input'), 'true');
  assert.match(read(d, '.agents/runs/LC/questions/001.md'), /^asked_at: \d/m, 'ask stored no asked_at');
  const shown = A(d, ['questions', 'LC']).out;
  assert.ok(shown.includes('1. Split the cache into its own module?'), 'questions does not show the asked question');
  assert.ok(!/^QUESTIONS:/m.test(shown), 'the QUESTIONS: line was stored');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh questions LC/m);
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /event=ask .*questions\/001\.md@/, 'ask was not ledgered');
  say(d, 'no, keep it in one module');
  accepted(A(d, ['answer', 'LC', '1', '--captured']), 'answer');
  assert.match(read(d, '.agents/runs/LC/questions/001.answer.md'), /^answered_by: user$/m);
  assert.equal(rv(d, 'execution', 'awaiting_input'), 'false');
  accepted(A(d, ['verify-seal', 'LC']), 'the ledger seal');
});
