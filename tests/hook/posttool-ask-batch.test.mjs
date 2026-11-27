// @ts-check
// A381 (issue 338 U1, the deferred part of A367): the batch pre-flight questions are offered in the runtime's option UI too (ask= for Claude Code's AskUserQuestion,
// ask-codex= for Codex's request_user_input) and the PostToolUse hook records the selection through `batch-answer --ui` with the same checks as a run question:
// the exact derived block, the session that planned the batch, a fresh tool call id, an unanswered question, one answer. The written options stay the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AB, bnew, binstall, fakes, lines, put, readIf, summaryOf } from '../core/batch-lib.mjs';
import { runHook } from './harness.mjs';

const wide = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `src/m${i + 1}.js`);
/** A task file with a scope list. @param {string} dir @param {string} id @param {string[]} scope @param {string} cls */
function task(dir, id, scope, cls) {
  put(`${dir}/.agents/tasks/${id}.md`, `# Task: ${id} — title of ${id}\n\n## Goal\n\nIt works.\n\n## Context\n\nFixture.\n\n## Expected scope\n\n${scope.map((s) => `- \`${s}\`\n`).join('')}\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\n${cls}\n`);
}
const bd = (/** @type {string} */ dir) => `${dir}/.agents/local/batch`;

/** W-1 (18 code paths: a split question) and W-2 (COMPLEX, one path: a class question with three options), planned by session s1 (or none). @param {Record<string, string>} [env] */
function planned(env = { CLAUDE_CODE_SESSION_ID: 's1' }) {
  const F = fakes(); const dir = bnew();
  task(dir, 'W-1', wide(18), 'STANDARD');
  task(dir, 'W-2', ['src/p.js'], 'COMPLEX');
  binstall(dir, { remote: false });
  const r = AB(F, dir, ['batch-plan', 'W-1', 'W-2'], { env });
  assert.equal(r.status, 0, r.text);
  /** @param {string} prefix */
  const blocks = (prefix) => r.out.split('\n').filter((l) => l.startsWith(prefix)).map((l) => JSON.parse(l.slice(prefix.length)));
  return { F, dir, out: r.out, claude: blocks('ask='), codex: blocks('ask-codex=') };
}
/** The PostToolUse event of the runtime's option tool. @param {string} dir @param {any} input @param {unknown} response @param {Record<string, unknown>} [more] @param {string} [runtime] */
function selected(dir, input, response, more = {}, runtime = 'claude') {
  return runHook('node', dir, 'posttool', { hook_event_name: 'PostToolUse', tool_name: runtime === 'codex' ? 'request_user_input' : 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: input, tool_response: response, ...more }, { runtime });
}
/** A Claude Code result with this answer. @param {any} input @param {string} answer */
const claudeResult = (input, answer) => ({ questions: input.questions, answers: { [input.questions[0].question]: answer }, annotations: {} });
const rowsOf = (/** @type {string} */ dir) => lines(`${bd(dir)}/answers.tsv`).map((l) => l.split('\t'));

test('batch-plan prints an ask= and an ask-codex= block per pre-flight question after the summary, never inside it, and records the planning session', () => {
  const { dir, out, claude, codex } = planned();
  assert.equal(claude.length, 2); assert.equal(codex.length, 2);
  const split = claude[0].questions[0];
  assert.match(split.question, /^Q1 \(W-1, split\): The task names 18 code paths/);
  assert.equal(split.header, 'Batch Q1');
  assert.equal(split.multiSelect, false);
  assert.deepEqual(split.options.map((/** @type {any} */ o) => o.label), ['a (recommended)', 'b']);
  assert.match(split.options[1].description, /^proceed without splitting, up to 27 code paths/);
  assert.deepEqual(claude[1].questions[0].options.map((/** @type {any} */ o) => o.label), ['a (recommended)', 'b', 'c']);
  assert.equal(codex[0].questions[0].id, 'batch_q1');
  assert.deepEqual(Object.keys(codex[0].questions[0]), ['id', 'header', 'question', 'options']);
  assert.match(out, /^ask-use: .*AskUserQuestion.*request_user_input.*fallback: written options/m);
  assert.ok(out.indexOf('ask=') > out.indexOf('batch id: '), 'the blocks come after the summary');
  assert.doesNotMatch(summaryOf(dir), /ask=|ask-codex=/, 'the summary the approval is bound to is unchanged');
  assert.match(summaryOf(dir), /^    b\) proceed without splitting/m, 'the written options stay');
  assert.equal(readIf(`${bd(dir)}/ask-session`), 's1\n');
});

test('a click on an option (Claude Code) is recorded as the user\'s pre-flight answer, source ui, with a line for the lead', async () => {
  const { F, dir, claude } = planned();
  const r = await selected(dir, claude[0], claudeResult(claude[0], 'b'));
  assert.equal(r.status, 0, r.stderr);
  const row = rowsOf(dir).find((f) => f[2] === 'Q1');
  assert.ok(row, 'no answer row');
  assert.deepEqual(row.slice(1), ['W-1', 'Q1', 'split', 'b', '27', 'ui:toolu_1', 'source=ui', 'answered_by=user']);
  assert.match(AB(F, dir, ['batch-answers', 'W-1']).out, /^Q1 W-1 split: option b \(up to 27\)$/m);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /pre-flight question Q1 of W-1 \(option b, answered_by user, source ui\)/);
  assert.match(readFileSync(`${dir}/.agents/local/prompts/consumed`, 'utf8'), /^ui:toolu_1$/m);
});

test('Codex: a selection in the recorded request_user_input shape is recorded; typed "Other" text counts only when the batch parser reads one option', async () => {
  const { dir, claude, codex } = planned();
  await selected(dir, codex[1], JSON.stringify({ answers: { batch_q2: { answers: ['c'] } } }), { tool_use_id: 'call_1' }, 'codex');
  assert.deepEqual(rowsOf(dir).find((f) => f[2] === 'Q2')?.slice(3, 5), ['class', 'c']);
  await selected(dir, claude[0], claudeResult(claude[0], 'maybe later, I am not sure'), { tool_use_id: 'toolu_o1' });
  assert.equal(rowsOf(dir).filter((f) => f[2] === 'Q1').length, 0, 'a text the parser does not read records nothing');
  await selected(dir, claude[0], claudeResult(claude[0], 'do not split'), { tool_use_id: 'toolu_o2' });
  assert.deepEqual(rowsOf(dir).find((f) => f[2] === 'Q1')?.slice(4, 6), ['b', '27']);
});

test('fail closed: an altered block, another session, a replay, an answered question, a cancel, a subagent or a run question\'s block record nothing', async () => {
  const { dir, claude } = planned();
  const good = claude[0];
  /** @param {(i: any) => void} f */
  const mut = (f) => { const i = structuredClone(good); f(i); return i; };
  /** @type {Array<[string, any, unknown, Record<string, unknown>?]>} */
  const cases = [
    ['question text', mut((i) => { i.questions[0].question = 'Approve batch?'; }), null],
    ['header', mut((i) => { i.questions[0].header = 'Approval'; }), null],
    ['label', mut((i) => { i.questions[0].options[0].label = 'approve batch'; }), null],
    ['description', mut((i) => { i.questions[0].options[1].description = 'proceed without splitting, up to 999 code paths'; }), null],
    ['option order', mut((i) => { i.questions[0].options.reverse(); }), null],
    ['extra option', mut((i) => { i.questions[0].options.push({ label: 'c', description: 'x' }); }), null],
    ['multiSelect', mut((i) => { i.questions[0].multiSelect = true; }), null],
    ['second question', mut((i) => { i.questions.push(structuredClone(claude[1].questions[0])); }), null],
    ['a run question\'s block', { questions: [{ question: 'Split the task into smaller ones?', header: 'Scope', multiSelect: false, options: [{ label: 'split', description: 'x' }, { label: 'stop', description: 'y' }] }] }, null],
    ['cancelled', good, { questions: good.questions, answers: {} }],
    ['an error text', good, 'Error: the user declined to answer'],
    ['another session', good, null, { session_id: 's2' }],
    ['a subagent', good, null, { agent_id: 'sub-1', agent_type: 'proofline-implementer' }],
  ];
  let k = 0;
  for (const [name, input, response, more] of cases) {
    await selected(dir, input, response ?? claudeResult(input, input.questions[0].options[0].label), { tool_use_id: `toolu_a${++k}`, ...(more ?? {}) });
    assert.equal(rowsOf(dir).length, 0, name);
  }
  await selected(dir, good, claudeResult(good, 'a (recommended)'), { tool_use_id: 'toolu_ok' });
  assert.equal(rowsOf(dir).length, 1, 'the exact block is recorded');
  await selected(dir, good, claudeResult(good, 'b'), { tool_use_id: 'toolu_ok' });
  await selected(dir, good, claudeResult(good, 'b'), { tool_use_id: 'toolu_again' });
  assert.deepEqual(rowsOf(dir).map((f) => f[4]), ['a'], 'a replay and a second answer to an answered question change nothing');
});

test('no planning session on record: nothing is recorded from the UI; the lead typing batch-answer --ui is refused', async () => {
  const { F, dir, claude } = planned({});
  assert.equal(readIf(`${bd(dir)}/ask-session`), '');
  await selected(dir, claude[0], claudeResult(claude[0], 'b'));
  assert.equal(rowsOf(dir).length, 0);
  const typed = AB(F, dir, ['batch-answer', '--ui']);
  assert.notEqual(typed.status, 0);
  assert.match(typed.text, /recorded only by the runtime hook/);
  assert.equal(rowsOf(dir).length, 0);
});
