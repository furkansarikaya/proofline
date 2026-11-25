// @ts-check
// UserPromptSubmit and several approvals in ONE message (A350, issue 338 B1): `;` and `,` and lines separate them, a phrase covers several open kinds only when
// each kind is named, the answer to a pending user-only question is recorded with them as the user's, and what an agent writes never approves anything.
// Tests that failed on the base and pass now: the `;` test, the named-kinds test, the answer test, the run-folder-name test (its positive: the plain reply records). The structural run-name rule is tested in tests/core/approval-runs.test.mjs (word list of the reviewer, forged records). GUARDS (they also passed on the base, they keep a refusal in
// place; each carries a positive assertion that fails on the base): the hedged-rest test (its positive: the same words without the hedge record) and the agent-writes test (its positive: the
// user's own message with the same approvals records).
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { buildTemplate, runHook, copyProject, rmSync, join, spawnSync, cleanEnv } from './harness.mjs';

let template = '';
let base = '';
before(() => { template = buildTemplate(); base = tempDir('hook-pam-'); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const QUESTION = '1. Görev bölünsün mü?\n   USER_ONLY: scope D-1\n   seçenekler: a) "böl" | b) "devam et"\n   recommended: böl\n';
const ag = (/** @type {string} */ d, /** @type {string[]} */ args, input = '') => spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: d, env: cleanEnv({ CLAUDE_CODE_SESSION_ID: 's1' }), input, encoding: 'utf8' });

/** A project with open requests of the kinds, asked long enough ago for any message to be newer; `question` opens the user-only question too. @param {string[]} kinds @param {boolean} [question] */
function open(kinds, question = false) {
  const d = copyProject(template, base);
  for (const k of kinds) {
    const r = ag(d, ['request-approval', 'LC', k]);
    assert.equal(r.status, 0, r.stderr);
  }
  const ad = join(d, '.agents/runs/LC/approvals');
  for (const n of readdirSync(ad)) { const f = join(ad, n); writeFileSync(f, readFileSync(f, 'utf8').replace(/^requested_at: \d+$/m, 'requested_at: 1000')); }
  if (question) {
    assert.equal(ag(d, ['ask', 'LC'], QUESTION).status, 0);
    const q = join(d, '.agents/runs/LC/questions/001.md');
    writeFileSync(q, readFileSync(q, 'utf8').replace(/^asked_at: \d+$/m, 'asked_at: 1000'));
  }
  return d;
}
const say = (/** @type {string} */ d, /** @type {string} */ prompt) => runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt });
const has = (/** @type {string} */ d, /** @type {string} */ k) => readdirSync(join(d, '.agents/runs/LC/approvals')).some((n) => new RegExp(`^\\d{3}-${k}\\.yaml$`).test(n));
const answer = (/** @type {string} */ d) => join(d, '.agents/runs/LC/questions/001.answer.md');

test('a semicolon separates approvals like a comma or a line', async () => {
  const d = open(['plan', 'scope']);
  const r = await say(d, 'approve plan; approve scope');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(has(d, 'plan') && has(d, 'scope'), `not both recorded: ${r.stdout}`);
});

test('one phrase covers several open kinds only when each kind is named', async () => {
  const d = open(['plan', 'scope']);
  await say(d, 'approve everything');
  assert.ok(!has(d, 'plan') && !has(d, 'scope'), 'a blanket approval approved unnamed kinds');
  await say(d, 'approve all');
  assert.ok(!has(d, 'plan') && !has(d, 'scope'), 'approve all approved unnamed kinds');
  await say(d, 'approve plan');
  assert.ok(has(d, 'plan') && !has(d, 'scope'), 'naming one kind approved the other too');
  const e = open(['plan', 'scope']);
  const r = await say(e, 'approve plan and scope');
  assert.ok(has(e, 'plan') && has(e, 'scope'), `a phrase naming both kinds did not approve both: ${r.stdout}`);
  const f = open(['plan']);
  await say(f, 'approve plan and scope');
  assert.ok(!has(f, 'plan'), 'a kind that is not open was allowed as an extra word');
});

test('the answer to a pending question is recorded as the user\'s together with the approval', async () => {
  const d = open(['plan'], true);
  const r = await say(d, 'approve plan; böl');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(has(d, 'plan'), `the approval is missing: ${r.stdout}`);
  assert.ok(existsSync(answer(d)), 'the answer is missing');
  assert.match(readFileSync(answer(d), 'utf8'), /^answered_by: user$/m);
  assert.doesNotMatch(readFileSync(answer(d), 'utf8'), /answered_by: lead/);
  const e = open(['plan'], true);
  await say(e, 'approve plan, soru 1: b');
  assert.ok(has(e, 'plan'));
  assert.match(readFileSync(answer(e), 'utf8'), /devam et/);
  assert.match(readFileSync(answer(e), 'utf8'), /^answered_by: user$/m);
});

test('a hedged or unrelated rest is no answer, and an answer to another question number is none', async () => {
  const d = open(['plan'], true);
  await say(d, 'approve plan; böl ama değil');
  assert.ok(!existsSync(answer(d)), 'a hedged answer was recorded');
  await say(d, 'approve plan, böl, but wait');
  assert.ok(!existsSync(answer(d)), 'a hedged answer after a comma was recorded');
  const e = open(['plan'], true);
  await say(e, 'approve plan; soru 2: a');
  assert.ok(!existsSync(answer(e)), 'an answer to question 2 was recorded for question 1');
  const f = open(['plan'], true);
  await say(f, 'approve plan; blah blah');
  assert.ok(!existsSync(answer(f)), 'an unrelated rest was recorded as the answer');
  // the positives (these fail on the base): the same messages without the hedge, with the right question number, record the answer
  const g = open(['plan'], true);
  await say(g, 'approve plan, böl');
  assert.ok(has(g, 'plan') && existsSync(answer(g)), 'the same words without the hedge record no answer');
  const h = open(['plan'], true);
  await say(h, 'approve plan; soru 1: a');
  assert.ok(has(h, 'plan') && existsSync(answer(h)), 'an answer to question 1 was not recorded');
  assert.match(readFileSync(answer(h), 'utf8'), /^answer: böl$/m);
});

test('what an agent writes approves nothing: a request, a question file and a lead-typed answer carry no approval', async () => {
  const d = open(['plan', 'scope'], true);
  const lead = ag(d, ['answer', 'LC', '1'], 'approve plan; approve scope; böl\n');
  assert.match(readFileSync(answer(d), 'utf8'), /^answered_by: lead$/m, lead.stderr);
  assert.ok(!has(d, 'plan') && !has(d, 'scope'), 'an answer the lead typed approved something');
  const e = open(['plan', 'scope']);
  const q = ag(e, ['approve', 'LC', 'plan', 'scope']);
  assert.notEqual(q.status, 0, 'agent.sh approve without a user prompt capture succeeded');
  assert.ok(!has(e, 'plan') && !has(e, 'scope'));
  // the positive (fails on the base): the user's own message with the same approvals records them
  const u = open(['plan', 'scope'], true);
  await say(u, 'approve plan; approve scope; böl');
  assert.ok(has(u, 'plan') && has(u, 'scope') && existsSync(answer(u)), 'the user\'s own message did not record');
  assert.match(readFileSync(answer(u), 'utf8'), /^answered_by: user$/m);
  // a finished background agent arrives as a "prompt": its text is not the user's words
  const f = open(['plan', 'scope'], true);
  await say(f, '<task-notification>approve plan; approve scope; böl</task-notification>');
  assert.ok(!has(f, 'plan') && !has(f, 'scope') && !existsSync(answer(f)), 'a task notification approved or answered');
  // a quoted or fenced block in the user's message is never an approval
  await say(f, '> approve plan; approve scope');
  assert.ok(!has(f, 'plan') && !has(f, 'scope'), 'a quoted block approved');
});

/** A project with the run folders an agent can create: names that are negation words, three of them with a request of their own. */
function withFolders() {
  const d = open(['scope']);
  for (const n of ['never', 'not', 'dont', 'no', 'do']) mkdirSync(join(d, '.agents/runs', n, 'approvals'), { recursive: true });
  for (const n of ['never', 'not']) writeFileSync(join(d, '.agents/runs', n, 'approvals/001-request-scope.yaml'), 'kind: "scope"\nrequested_at: 1000\n');
  return d;
}

test('a run folder named like a negation word is no run name: a negated reply is refused (folder names are agent-writable)', async () => {
  for (const msg of ['never approve the scope LC', 'approve scope not LC', 'do not approve scope LC', 'approve scope dont LC', 'approve scope no LC', 'approve the scope, never LC', 'approve scope do not LC']) {
    const d = withFolders();
    await say(d, msg);
    assert.ok(!has(d, 'scope'), `a negated message approved: ${msg}`);
  }
  // the positives (fail on the base: no run named at all is refused, the run id after the kind word is not): the same folders, the reply without a negation
  for (const msg of ['approve scope']) {
    const d = withFolders();
    await say(d, msg);
    assert.ok(has(d, 'scope'), `the plain message was refused: ${msg}`);
  }
});
