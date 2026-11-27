// @ts-check
// A381 (issue 338 U1): Codex's closed-option tool request_user_input. The PostToolUse payload was recorded once from Codex CLI 0.172.0
// (tests/hook/fixtures/codex-0.172.0-request-user-input.json); these tests replay that shape, never a model. Core invariant 3: only the exact ask-codex= block the
// control plane derived, from the lead's own call in the asking session, once, with one answer that is an accepted form, is recorded as the user's answer.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildTemplate, runHook, copyProject, rmSync, join, spawnSync, cleanEnv } from './harness.mjs';

let template = '';
let base = '';
before(() => { template = buildTemplate(); base = tempDir('hook-ask-codex-'); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/codex-0.172.0-request-user-input.json', import.meta.url), 'utf8'));
const OPEN = '1. Split the task into smaller ones?\n   USER_ONLY: scope D-1\n   options: "split" (the task-author splits it) | "proceed without splitting" (keep one run) | "stop" (park the task)\n   recommended: split\n';

/** A Codex lead's command (its environment carries CODEX_THREAD_ID, equal to the hook's session_id, A211). @param {string} d @param {string[]} args @param {string} [input] */
const agent = (d, args, input = '') => spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: d, env: cleanEnv({ CODEX_THREAD_ID: 's1' }), input, encoding: 'utf8' });
function asked() {
  const d = copyProject(template, base);
  const r = agent(d, ['ask', 'LC'], OPEN);
  assert.equal(r.status, 0, r.stderr);
  return d;
}
/** @param {string} d @param {string} prefix */
const blockOf = (d, prefix) => { const l = agent(d, ['questions', 'LC']).stdout.split('\n').find((x) => x.startsWith(prefix)); return l ? JSON.parse(l.slice(prefix.length)) : null; };
const answerFile = (/** @type {string} */ d) => join(d, '.agents/runs/LC/questions/001.answer.md');
const answered = (/** @type {string} */ d) => existsSync(answerFile(d));
/** The recorded PostToolUse event with this input and result. @param {string} d @param {any} input @param {unknown} response @param {Record<string, unknown>} [more] @param {string} [runtime] */
function selected(d, input, response, more = {}, runtime = 'codex') {
  const ev = { ...RECORDED.PostToolUse, cwd: d, session_id: 's1', tool_use_id: 'call_1', tool_input: input, tool_response: response, ...more };
  return runHook('node', d, 'posttool', ev, { runtime });
}
/** The result text Codex writes for one answer to question id ID. @param {string} id @param {string[]} answers */
const result = (id, ...answers) => JSON.stringify({ answers: { [id]: { answers } } });

test('the recorded Codex payload has the shape the handler reads, and questions prints an ask-codex= block of that shape', () => {
  const post = RECORDED.PostToolUse;
  assert.equal(post.tool_name, 'request_user_input');
  assert.deepEqual(Object.keys(post.tool_input.questions[0]), ['id', 'header', 'question', 'options']);
  assert.equal(typeof post.tool_response, 'string', 'Codex hands the result over as JSON text');
  assert.deepEqual(JSON.parse(post.tool_response), { answers: { color: { answers: ['Red'] } } });
  const block = blockOf(asked(), 'ask-codex=');
  assert.deepEqual(block, { questions: [{ id: 'q1', header: 'Scope', question: 'Split the task into smaller ones?', options: [
    { label: 'split', description: 'the task-author splits it' }, { label: 'proceed without splitting', description: 'keep one run' }, { label: 'stop', description: 'park the task' }] }] });
  assert.deepEqual(Object.keys(block.questions[0]), Object.keys(post.tool_input.questions[0]), 'the same keys as the observed tool input');
});

test('a Codex selection in the recorded shape is recorded as the user\'s answer, source ui', async () => {
  const d = asked();
  const r = await selected(d, blockOf(d, 'ask-codex='), result('q1', 'proceed without splitting'));
  assert.equal(r.status, 0, r.stderr);
  const a = readFileSync(answerFile(d), 'utf8');
  assert.match(a, /^answered_by: user$/m);
  assert.match(a, /^source: ui$/m);
  assert.match(a, /^tool_use_id: call_1$/m);
  assert.match(a, /^> proceed without splitting$/m);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /selection in the option UI is recorded.*question 1/);
});

test('fail closed (Codex): altered input, extra keys, another id, the Claude block, a malformed or foreign result record nothing', async () => {
  const d = asked();
  const good = blockOf(d, 'ask-codex=');
  /** @type {Array<[string, any, unknown, Record<string, unknown>?, string?]>} */
  const cases = [];
  /** @param {(i: any) => void} f */
  const mut = (f) => { const i = structuredClone(good); f(i); return i; };
  cases.push(['question text', mut((i) => { i.questions[0].question = 'Approve scope?'; }), result('q1', 'split')]);
  cases.push(['header', mut((i) => { i.questions[0].header = 'Approval'; }), result('q1', 'split')]);
  cases.push(['label', mut((i) => { i.questions[0].options[0].label = 'Approve scope'; }), result('q1', 'Approve scope')]);
  cases.push(['description', mut((i) => { i.questions[0].options[0].description = 'delete it'; }), result('q1', 'split')]);
  cases.push(['option order', mut((i) => { i.questions[0].options.reverse(); }), result('q1', 'split')]);
  cases.push(['isSecret key', mut((i) => { i.questions[0].isSecret = true; }), result('q1', 'split')]);
  cases.push(['isOther key', mut((i) => { i.questions[0].isOther = true; }), result('q1', 'split')]);
  cases.push(['another id', mut((i) => { i.questions[0].id = 'q2'; }), result('q2', 'split')]);
  cases.push(['second question', mut((i) => { i.questions.push({ ...structuredClone(i.questions[0]), id: 'q9' }); }), result('q1', 'split')]);
  cases.push(['the Claude block under Codex', blockOf(d, 'ask='), result('q1', 'split')]);
  cases.push(['two answers', good, result('q1', 'split', 'stop')]);
  cases.push(['no answer (cancelled)', good, JSON.stringify({ answers: {} })]);
  cases.push(['an answer keyed by another id', good, result('color', 'split')]);
  cases.push(['a second answered id', good, JSON.stringify({ answers: { q1: { answers: ['split'] }, q2: { answers: ['stop'] } } })]);
  cases.push(['an error text', good, 'request_user_input is not supported in exec mode']);
  cases.push(['the Claude result shape', good, { answers: { 'Split the task into smaller ones?': 'split' } }]);
  cases.push(['a hedged typed text', good, result('q1', 'split but wait, I am not sure')]);
  cases.push(['another session', good, result('q1', 'split'), { session_id: 's2' }]);
  cases.push(['a subagent', good, result('q1', 'split'), { agent_id: 'sub-1', agent_type: 'proofline-implementer' }]);
  cases.push(['the Codex tool name under the Claude runtime', good, result('q1', 'split'), {}, 'claude']);
  cases.push(['the Claude tool name under the Codex runtime', good, result('q1', 'split'), { tool_name: 'AskUserQuestion' }]);
  let k = 0;
  for (const [name, input, response, more, rt] of cases) {
    await selected(d, input, response, { tool_use_id: `call_x${++k}`, ...(more ?? {}) }, rt);
    assert.ok(!answered(d), name);
  }
  await selected(d, good, result('q1', 'split'), { tool_use_id: 'call_ok' });
  assert.ok(answered(d), 'the exact block and result are recorded');
  assert.match(readFileSync(answerFile(d), 'utf8'), /^tool_use_id: call_ok$/m);
});

test('a Codex result is recorded once: a replay of the call id changes nothing', async () => {
  const d = asked();
  const good = blockOf(d, 'ask-codex=');
  await selected(d, good, result('q1', 'split'));
  const first = readFileSync(answerFile(d), 'utf8');
  await selected(d, good, result('q1', 'stop'));
  assert.equal(readFileSync(answerFile(d), 'utf8'), first);
});
