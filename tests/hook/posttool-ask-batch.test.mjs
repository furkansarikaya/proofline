// @ts-check
// A381 (issue 338 U1, the deferred part of A367): the batch pre-flight questions are offered in the runtime's option UI too (ask= for Claude Code's AskUserQuestion,
// ask-codex= for Codex's request_user_input) and the PostToolUse hook records the selection through `batch-answer --ui` with the same checks as a run question:
// the exact derived block, the session that planned the batch, a fresh tool call id, an unanswered question, one answer. The written options stay the fallback.
// Approvals are never a click: the acceptance of the expected findings (kind accept) and a known-issue question (kind known) get no block and are refused, and so
// is a question whose option asks for the user's own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { batchAskSpec } from '../../control-plane/agents/scripts/core/batch.mjs';
import { AB, bnew, binstall, fakes, lines, put, readIf, summaryOf } from '../core/batch-lib.mjs';
import { runHook } from './harness.mjs';

const wide = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `src/m${i + 1}.js`);
/** A task file with a scope list. @param {string} dir @param {string} id @param {string[]} scope @param {string} cls @param {string} [context] */
function task(dir, id, scope, cls, context = 'Fixture.') {
  put(`${dir}/.agents/tasks/${id}.md`, `# Task: ${id} — title of ${id}\n\n## Goal\n\nIt works.\n\n## Context\n\n${context}\n\n## Expected scope\n\n${scope.map((s) => `- \`${s}\`\n`).join('')}\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\n${cls}\n`);
}
const bd = (/** @type {string} */ dir) => `${dir}/.agents/local/batch`;
/** @param {string} out @param {string} prefix */
const blocksIn = (out, prefix) => out.split('\n').filter((l) => l.startsWith(prefix)).map((l) => JSON.parse(l.slice(prefix.length)));
/** The block of the question of this kind. @param {any[]} blocks @param {string} kind */
const ofKind = (blocks, kind) => blocks.find((b) => new RegExp(`^Q[0-9]+ \\([^,]+, ${kind}\\):`).test(b.questions[0].question));

/**
 * W-1 (18 code paths: a split question), W-2 (a document path: an exempt question) and W-3 (COMPLEX, one path: a class question whose option c needs the user's
 * words), planned by session s1 (or none). @param {Record<string, string>} [env]
 */
function planned(env = { CLAUDE_CODE_SESSION_ID: 's1' }) {
  const F = fakes(); const dir = bnew();
  task(dir, 'W-1', wide(18), 'STANDARD');
  task(dir, 'W-2', ['src/p.js', 'docs/notes.md'], 'STANDARD');
  task(dir, 'W-3', ['src/r.js'], 'COMPLEX');
  binstall(dir, { remote: false });
  const r = AB(F, dir, ['batch-plan', 'W-1', 'W-2', 'W-3'], { env });
  assert.equal(r.status, 0, r.text);
  const claude = blocksIn(r.out, 'ask='); const codex = blocksIn(r.out, 'ask-codex=');
  return { F, dir, out: r.out, claude, codex, split: ofKind(claude, 'split'), exempt: ofKind(claude, 'exempt'), exemptCodex: ofKind(codex, 'exempt') };
}
/** The PostToolUse event of the runtime's option tool. @param {string} dir @param {any} input @param {unknown} response @param {Record<string, unknown>} [more] @param {string} [runtime] */
function selected(dir, input, response, more = {}, runtime = 'claude') {
  return runHook('node', dir, 'posttool', { hook_event_name: 'PostToolUse', tool_name: runtime === 'codex' ? 'request_user_input' : 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: input, tool_response: response, ...more }, { runtime });
}
/** A Claude Code result with this answer. @param {any} input @param {string} answer */
const claudeResult = (input, answer) => ({ questions: input.questions, answers: { [input.questions[0].question]: answer }, annotations: {} });
const rowsOf = (/** @type {string} */ dir) => lines(`${bd(dir)}/answers.tsv`).map((l) => l.split('\t'));

test('batch-plan prints an ask= and an ask-codex= block per offered question after the summary, never inside it, and records the planning session', () => {
  const { dir, out, claude, codex, split } = planned();
  assert.equal(claude.length, 2, 'split and exempt are offered; the class question (option c needs words) is not'); assert.equal(codex.length, 2);
  assert.equal(ofKind(claude, 'class'), undefined);
  assert.match(summaryOf(dir), /\[W-3, class\][^\n]*\n(?:    [^\n]*\n)*    c\) another class: say which in your answer/, 'the class question stays a written question');
  const q = split.questions[0];
  assert.match(q.question, /^Q1 \(W-1, split\): The task names 18 code paths/);
  assert.equal(q.header, 'Batch Q1');
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map((/** @type {any} */ o) => o.label), ['a (recommended)', 'b']);
  assert.match(q.options[1].description, /^proceed without splitting, up to 27 code paths/);
  assert.equal(ofKind(codex, 'split').questions[0].id, 'batch_q1');
  assert.deepEqual(Object.keys(codex[0].questions[0]), ['id', 'header', 'question', 'options']);
  assert.match(out, /^ask-use: .*AskUserQuestion.*request_user_input.*fallback: written options/m);
  assert.ok(out.indexOf('ask=') > out.indexOf('batch id: '), 'the blocks come after the summary');
  assert.doesNotMatch(summaryOf(dir), /ask=|ask-codex=/, 'the summary the approval is bound to is unchanged');
  assert.match(summaryOf(dir), /^    b\) proceed without splitting/m, 'the written options stay');
  assert.equal(readIf(`${bd(dir)}/ask-session`), 's1\n');
});

test('approvals and questions that need words are never offered: kinds accept and known, an option asking for the user\'s own words', () => {
  const opt2 = 'a) no [recommended]|b) yes';
  assert.equal(batchAskSpec(['Q1', 'batch', 'accept', 'Accept the list?', opt2, 'a', '-']), null);
  assert.equal(batchAskSpec(['Q1', 'R-1', 'known', 'Known issue?', opt2, 'a', '-']), null);
  assert.equal(batchAskSpec(['Q1', 'R-1', 'known', 'Known issue?', 'a) leave it blocking [recommended]|b) list it as a known issue: name its follow-up task (an existing open task) in your answer', 'a', '-']), null);
  assert.equal(batchAskSpec(['Q1', 'W-3', 'class', 'Keep it?', 'a) keep COMPLEX [recommended]|b) STANDARD|c) another class: say which in your answer', 'a', '-']), null);
  assert.notEqual(batchAskSpec(['Q1', 'W-1', 'dep', 'Dependency?', opt2, 'a', '-']), null, 'a plain two-option question is offered');
});

test('a click on an option (Claude Code) is recorded as the user\'s pre-flight answer, source ui, with a line for the lead', async () => {
  const { F, dir, split } = planned();
  const r = await selected(dir, split, claudeResult(split, 'b'));
  assert.equal(r.status, 0, r.stderr);
  const row = rowsOf(dir).find((f) => f[2] === 'Q1');
  assert.ok(row, 'no answer row');
  assert.deepEqual(row.slice(1), ['W-1', 'Q1', 'split', 'b', '27', 'ui:toolu_1', 'source=ui', 'answered_by=user']);
  assert.match(AB(F, dir, ['batch-answers', 'W-1']).out, /^Q1 W-1 split: option b \(up to 27\)$/m);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /pre-flight question Q1 of W-1 \(option b, answered_by user, source ui\)/);
  assert.match(readFileSync(`${dir}/.agents/local/prompts/consumed`, 'utf8'), /^ui:toolu_1$/m);
});

test('Codex: a selection in the recorded request_user_input shape is recorded; typed "Other" text counts only when the batch parser reads one option', async () => {
  const { dir, split, exemptCodex } = planned();
  const id = exemptCodex.questions[0].id;
  await selected(dir, exemptCodex, JSON.stringify({ answers: { [id]: { answers: ['b'] } } }), { tool_use_id: 'call_1' }, 'codex');
  assert.deepEqual(rowsOf(dir).find((f) => f[3] === 'exempt')?.slice(3, 5), ['exempt', 'b']);
  await selected(dir, split, claudeResult(split, 'maybe later, I am not sure'), { tool_use_id: 'toolu_o1' });
  assert.equal(rowsOf(dir).filter((f) => f[2] === 'Q1').length, 0, 'a text the parser does not read records nothing');
  await selected(dir, split, claudeResult(split, 'do not split'), { tool_use_id: 'toolu_o2' });
  assert.deepEqual(rowsOf(dir).find((f) => f[2] === 'Q1')?.slice(4, 6), ['b', '27']);
});

test('fail closed: an altered block, another session, a replay, an answered question, a cancel, a subagent or a run question\'s block record nothing', async () => {
  const { dir, split: good, exempt } = planned();
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
    ['second question', mut((i) => { i.questions.push(structuredClone(exempt.questions[0])); }), null],
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

test('a click on an acceptance or known-issue question (a block the lead built itself) records nothing and tells the lead nothing', async () => {
  const { dir } = planned();
  const lint = `${bd(dir)}/lint.tsv`;
  const n = lines(lint).length;
  appendFileSync(lint, `Q${n + 1}\tbatch\taccept\tAccept for THIS batch only the 1 expected finding(s)?\ta) no: each stays blocking [recommended]|b) yes: accept the whole list for this batch\ta\t-\n`);
  appendFileSync(lint, `Q${n + 2}\tR-1\tknown\tRun R-1 recorded the blocking finding F-1?\ta) leave it blocking [recommended]|b) list it as a known issue\ta\t-\n`);
  for (const [qn, id, kind, text, b] of [[`Q${n + 1}`, 'batch', 'accept', 'Accept for THIS batch only the 1 expected finding(s)?', 'yes: accept the whole list for this batch'], [`Q${n + 2}`, 'R-1', 'known', 'Run R-1 recorded the blocking finding F-1?', 'list it as a known issue']]) {
    const input = { questions: [{ question: `${qn} (${id}, ${kind}): ${text}`, header: `Batch ${qn}`, multiSelect: false, options: [{ label: 'a (recommended)', description: kind === 'accept' ? 'no: each stays blocking' : 'leave it blocking' }, { label: 'b', description: b }] }] };
    const r = await selected(dir, input, claudeResult(input, 'b'), { tool_use_id: `toolu_${kind}` });
    assert.equal(rowsOf(dir).length, 0, kind);
    assert.doesNotMatch(r.stdout, /recorded as your answer/, kind);
  }
});

test('re-plan: an answer given in the UI is not carried (asked again, with its block); a carried typed answer gets no block', async () => {
  const { F, dir, split } = planned();
  await selected(dir, split, claudeResult(split, 'b'));
  task(dir, 'W-2', ['src/p.js', 'docs/notes.md', 'src/q.js'], 'STANDARD', 'Second text.');
  const r1 = AB(F, dir, ['batch-plan', '--replace', 'W-1', 'W-2', 'W-3'], { env: { CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.equal(r1.status, 0, r1.text);
  assert.doesNotMatch(summaryOf(dir), /answered by you earlier/, 'a UI answer is not carried');
  assert.ok(ofKind(blocksIn(r1.out, 'ask='), 'split'), 'the split question is asked again with its block');
  // the user now types the answer; it is carried to the next plan and that plan offers no block for it
  const at = Math.floor(statSync(`${bd(dir)}/SUMMARY.md`).mtimeMs / 1000) + 10;
  put(`${dir}/.agents/local/prompts/history/${at}-typed001.txt`, 'Q1: do not split\n');
  assert.equal(AB(F, dir, ['batch-answer']).status, 0);
  task(dir, 'W-2', ['src/p.js', 'docs/notes.md', 'src/s.js'], 'STANDARD', 'Third text.');
  const r2 = AB(F, dir, ['batch-plan', '--replace', 'W-1', 'W-2', 'W-3'], { env: { CLAUDE_CODE_SESSION_ID: 's1' } });
  assert.equal(r2.status, 0, r2.text);
  assert.match(summaryOf(dir), /\[W-1, split\][^\n]*\n(?:    [^\n]*\n)*    answered by you earlier \(option b/, 'the typed answer is carried');
  assert.equal(ofKind(blocksIn(r2.out, 'ask='), 'split'), undefined, 'a carried question gets no block');
  assert.ok(ofKind(blocksIn(r2.out, 'ask='), 'exempt'), 'the other question is still offered');
});

test('no planning session on record: nothing is recorded from the UI; the lead typing batch-answer --ui is refused', async () => {
  const { F, dir, split } = planned({});
  assert.equal(readIf(`${bd(dir)}/ask-session`), '');
  await selected(dir, split, claudeResult(split, 'b'));
  assert.equal(rowsOf(dir).length, 0);
  const typed = AB(F, dir, ['batch-answer', '--ui']);
  assert.notEqual(typed.status, 0);
  assert.match(typed.text, /recorded only by the runtime hook/);
  assert.equal(rowsOf(dir).length, 0);
});
