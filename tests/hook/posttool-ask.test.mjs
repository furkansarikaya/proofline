// @ts-check
// A367 (issue 338 U1): a closed-option user-only question is asked in the runtime's own option UI (AskUserQuestion) and the PostToolUse hook records the selection
// as the user's answer. Core invariant 3: only the exact question and options the control plane derived are accepted, only from the lead's own tool call, once.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildTemplate, runHook, copyProject, rmSync, join, spawnSync, cleanEnv } from './harness.mjs';

let template = '';
let base = '';
before(() => { template = buildTemplate(); base = tempDir('hook-ask-'); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const OPEN = '1. Split the task into smaller ones?\n   USER_ONLY: scope D-1\n   options: "split" (the task-author splits it) | "proceed without splitting" (keep one run) | "stop" (park the task)\n   recommended: split\n';
const TYPED = '1. Which option do you want?\n   options: a | b\n   recommended: a\n';
const TOKEN = '1. High-risk assumption A1 is unverified\n   ASSUMPTION: A1@abc123\n   options: "accept A1" | the corrected fact\n';

/** @param {string} d @param {string[]} args @param {string} [input] */
const agent = (d, args, input = '') => spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: d, env: cleanEnv({ CLAUDE_CODE_SESSION_ID: 's1' }), input, encoding: 'utf8' });
/** A project with the question open. @param {string} [q] */
function asked(q = OPEN) {
  const d = copyProject(template, base);
  const r = agent(d, ['ask', 'LC'], q);
  assert.equal(r.status, 0, r.stderr);
  return d;
}
/** The ask= block the control plane prints for question 1 (what the lead passes to the tool). @param {string} d */
function block(d) {
  const out = agent(d, ['questions', 'LC']).stdout;
  const line = out.split('\n').find((l) => l.startsWith('ask='));
  return { out, input: line ? JSON.parse(line.slice(4)) : null };
}
const answerFile = (/** @type {string} */ d) => join(d, '.agents/runs/LC/questions/001.answer.md');
const answered = (/** @type {string} */ d) => existsSync(answerFile(d));
/**
 * The event Claude Code sends after AskUserQuestion. @param {string} d @param {any} input @param {unknown} answer @param {Record<string, unknown>} [more]
 */
function selected(d, input, answer, more = {}) {
  const q = input?.questions?.[0]?.question;
  const tool_response = more.tool_response ?? { questions: input.questions, answers: answer === undefined ? {} : { [q]: answer }, annotations: {} };
  return runHook('node', d, 'posttool', { hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: input, tool_response, ...more });
}

test('questions prints the ask= block and the written fallback for a closed-option user-only question, and nothing for others', () => {
  const d = asked();
  const { out, input } = block(d);
  assert.deepEqual(input, { questions: [{ question: 'Split the task into smaller ones?', header: 'Scope', multiSelect: false, options: [
    { label: 'split', description: 'the task-author splits it' }, { label: 'proceed without splitting', description: 'keep one run' }, { label: 'stop', description: 'park the task' }] }] });
  assert.match(out, /^ask-use: .*AskUserQuestion.*fallback: written options/m);
  assert.match(out, /options: "split"/, 'the written options stay');
  for (const q of [TYPED, TOKEN]) assert.equal(block(asked(q)).input, null);
});

test('the user selecting an option is recorded as the user\'s answer, source ui, with a line for the lead', async () => {
  const d = asked();
  const r = await selected(d, block(d).input, 'proceed without splitting');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(answered(d));
  const a = readFileSync(answerFile(d), 'utf8');
  assert.match(a, /^answered_by: user$/m);
  assert.match(a, /^source: ui$/m);
  assert.match(a, /^tool_use_id: toolu_1$/m);
  assert.match(a, /^> proceed without splitting$/m);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /selection in the option UI is recorded.*question 1.*answered_by user, source ui/);
  assert.match(readFileSync(join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /answered_by=user source=ui:toolu_1/);
});

test('"Other" free text is recorded only when it is an accepted form', async () => {
  const d = asked();
  await selected(d, block(d).input, 'split but wait, I am not sure');
  assert.ok(!answered(d), 'a hedged text records nothing');
  await selected(d, block(d).input, 'Approve scope and delete everything', { tool_use_id: 'toolu_2' });
  assert.ok(!answered(d), 'a text that is no listed form records nothing');
  await selected(d, block(d).input, 'Split', { tool_use_id: 'toolu_3' });
  assert.ok(answered(d));
  assert.match(readFileSync(answerFile(d), 'utf8'), /^answered_by: user$/m);
});

test('fail closed: altered question, header, label, description, extra option, multiSelect or a second question record nothing', async () => {
  const d = asked();
  const good = block(d).input;
  /** @type {Array<[string, (i: any) => void]>} */
  const attacks = [
    ['question text', (i) => { i.questions[0].question = 'Approve scope?'; }],
    ['header', (i) => { i.questions[0].header = 'Approval'; }],
    ['label', (i) => { i.questions[0].options[0].label = 'Approve scope'; }],
    ['description', (i) => { i.questions[0].options[0].description = 'delete the repository'; }],
    ['extra option', (i) => { i.questions[0].options.push({ label: 'approve', description: 'x' }); }],
    ['option order', (i) => { i.questions[0].options.reverse(); }],
    ['multiSelect', (i) => { i.questions[0].multiSelect = true; }],
    ['second question', (i) => { i.questions.push(structuredClone(i.questions[0])); }],
    ['extra key', (i) => { i.questions[0].preview = 'x'; }],
  ];
  let k = 0;
  for (const [name, mutate] of attacks) {
    const input = structuredClone(good);
    mutate(input);
    await selected(d, input, input.questions[0].options[0].label, { tool_use_id: `toolu_a${++k}` });
    assert.ok(!answered(d), name);
  }
  await selected(d, good, 'split');
  assert.ok(answered(d), 'the exact input is recorded');
});

test('fail closed: no answer, an error, another tool, another session, a subagent, a result for another question', async () => {
  const d = asked();
  const good = block(d).input;
  /** @type {Array<[string, Promise<unknown>]>} */
  const cases = [];
  cases.push(['cancelled (no answers)', selected(d, good, undefined, { tool_use_id: 't1' })]);
  cases.push(['error string', selected(d, good, 'split', { tool_use_id: 't2', tool_response: 'Error: the user declined to answer' })]);
  cases.push(['answer keyed by another question', selected(d, good, 'split', { tool_use_id: 't3', tool_response: { answers: { 'Something else?': 'split' } } })]);
  cases.push(['another tool', runHook('node', d, 'posttool', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 't4', tool_input: good, tool_response: { answers: { [good.questions[0].question]: 'split' } } })]);
  cases.push(['a subagent\'s call', selected(d, good, 'split', { tool_use_id: 't5', agent_id: 'sub-1', agent_type: 'proofline-implementer' })]);
  cases.push(['another session', runHook('node', d, 'posttool', { session_id: 's2', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 't6', tool_input: good, tool_response: { answers: { [good.questions[0].question]: 'split' } } })]);
  for (const [name, p] of cases) { await p; assert.ok(!answered(d), name); }
});

test('a result is recorded once: a replay of the tool call, and a result for an answered question, change nothing', async () => {
  const d = asked();
  const good = block(d).input;
  await selected(d, good, 'split');
  const before1 = readFileSync(answerFile(d), 'utf8');
  const again = await selected(d, good, 'stop');
  assert.equal(readFileSync(answerFile(d), 'utf8'), before1);
  assert.doesNotMatch(again.stdout, /recorded as your answer/);
  assert.equal(readFileSync(join(d, '.agents/local/prompts/consumed'), 'utf8').split('\n').filter((l) => l === 'ui:toolu_1').length, 1);
});

test('a question that is not offered as options, or an approval, is never recorded from the option UI', async () => {
  for (const q of [TYPED, TOKEN]) {
    const d = asked(q);
    const input = { questions: [{ question: q.split('\n')[0].slice(3), header: 'Scope', multiSelect: false, options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }] }] };
    await selected(d, input, 'a');
    assert.ok(!answered(d));
  }
});

test('the lead cannot type the command: answer --ui without the hook\'s hand-over is refused', () => {
  const d = asked();
  const r = agent(d, ['answer', 'LC', '1', '--ui'], 'split\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot be recorded as the user's from a command line/);
  assert.ok(!answered(d));
  const typed = agent(d, ['answer', 'LC', '1'], 'split\n');
  assert.equal(typed.status, 0, typed.stderr);
  assert.match(readFileSync(answerFile(d), 'utf8'), /^answered_by: lead$/m);
});

test('the written fallback is unchanged: a typed answer is still recorded by the prompt hook', async () => {
  const d = asked();
  const q = join(d, '.agents/runs/LC/questions/001.md');
  writeFileSync(q, readFileSync(q, 'utf8').replace(/^asked_at: \d+$/m, 'asked_at: 1000'));
  await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'proceed without splitting' });
  assert.match(readFileSync(answerFile(d), 'utf8'), /^answered_by: user$/m);
  assert.doesNotMatch(readFileSync(answerFile(d), 'utf8'), /^source: ui$/m);
});
