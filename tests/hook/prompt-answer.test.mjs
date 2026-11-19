// @ts-check
// UserPromptSubmit and a user-only question (A347): a Turkish answer to a Turkish options line is recorded as the user's; a short message that matches no
// accepted form gets ONE line naming the forms; chat (long, multi-line, a question) and a matching answer get none.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildTemplate, runHook, copyProject, rmSync, join, spawnSync, cleanEnv } from './harness.mjs';

let template = '';
let base = '';
before(() => { template = buildTemplate(); base = tempDir('hook-pa-'); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const QUESTION = '1. Görev bölünsün mü?\n   USER_ONLY: scope D-1\n   seçenekler: "böl" | "devam et"\n   recommended: böl\n';

/** A project with the question open, asked long enough ago for any message to be newer. */
function asked() {
  const d = copyProject(template, base);
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'ask', 'LC'], { cwd: d, env: cleanEnv({ CLAUDE_CODE_SESSION_ID: 's1' }), input: QUESTION, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const q = join(d, '.agents/runs/LC/questions/001.md');
  writeFileSync(q, readFileSync(q, 'utf8').replace(/^asked_at: \d+$/m, 'asked_at: 1000'));
  return d;
}
/** @param {string} d @param {string} prompt */
const say = (d, prompt) => runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt });
const answered = (/** @type {string} */ d) => existsSync(join(d, '.agents/runs/LC/questions/001.answer.md'));

test('a Turkish answer to a Turkish options line is recorded as the user\'s, with no line to the user', async () => {
  const d = asked();
  const r = await say(d, 'BÖL.');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(answered(d), 'recorded');
  assert.match(readFileSync(join(d, '.agents/runs/LC/questions/001.answer.md'), 'utf8'), /^answered_by: user$/m);
  assert.doesNotMatch(r.stdout, /accepted answers/);
});

test('a short message that is no accepted form: nothing recorded and ONE line names the forms', async () => {
  const d = asked();
  const r = await say(d, 'bölüm');
  assert.ok(!answered(d));
  const out = JSON.parse(r.stdout);
  assert.equal(out.systemMessage, out.hookSpecificOutput.additionalContext);
  assert.match(out.systemMessage, /question 1 waits for your answer.*nothing was recorded.*"böl" \| "devam et"/);
  assert.equal(out.systemMessage.split('\n').length, 1);
});

test('the line is in Turkish when the run language is Turkish', async () => {
  const d = asked();
  const task = join(d, '.agents/runs/LC/TASK.md');
  writeFileSync(task, `${readFileSync(task, 'utf8')}\nLanguage: tr\n`);
  const r = await say(d, 'bölüm');
  assert.match(JSON.parse(r.stdout).systemMessage, /1\. soru yanıtınızı bekliyor.*hiçbir şey kaydedilmedi.*"böl" \| "devam et"/);
  assert.ok(!answered(d));
});

test('chat is not answered with a line: a long message, several lines, a question, a negated answer is the only short miss', async () => {
  const d = asked();
  for (const chat of ['x'.repeat(120), 'bir\niki', 'ne olacak şimdi?']) {
    const r = await say(d, chat);
    assert.doesNotMatch(r.stdout, /accepted answers/, chat.slice(0, 10));
  }
  assert.ok(!answered(d));
  const neg = await say(d, 'böl ama değil');
  assert.match(neg.stdout, /accepted answers/);
  assert.ok(!answered(d));
});
