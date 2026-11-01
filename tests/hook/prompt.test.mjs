// @ts-check
// UserPromptSubmit: the capture contract (Invariant 3) of the Node hook against the shell hook on a corpus of prompts: the intake copy, the capture
// file, the history copy, and the approval step. The committed golden bytes of the capture live in tests/golden/capture (package CMDS).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { buildTemplate, haveJq, pair, runHook, copyProject, snapshot, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, spawnSync, cleanEnv } from './harness.mjs';

const skip = haveJq ? false : 'jq is required for the shell hook';
let template = '';
let base = '';
before(() => { template = buildTemplate(); base = mkdtempSync(join(tmpdir(), 'hook-pr-')); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {{ node: any, sh: any }} r @param {string} what */
function same(r, what) {
  assert.equal(r.node.stdout, r.sh.stdout, `${what}: stdout`);
  assert.equal(r.node.status, r.sh.status, `${what}: status`);
  assert.deepEqual(r.node.files, r.sh.files, `${what}: files`);
}

const CORPUS = [
  'looks fine, thanks',
  'plan approved, go ahead',
  'say "hi" and use a \\backslash\\ and C:\\dir\\file',
  'line one\nline two\n\nline four\n',
  'tab\there\tand\rcarriage return\r\nwindows line',
  'control \u0001 one \u0002 two \u0007 bell \u001b[31m escape \u007f del',
  'Türkçe: ığüşöçİĞÜŞÖÇ — onaylıyorum, devam et',
  'emoji \u{1F600} and CJK \u4e2d\u6587 and astral \u{1D11E}',
  '  leading and trailing spaces  ',
  '',
  '\n\n',
  'x'.repeat(20000),
  '/proofline next LC',
  '{"json":"in a prompt","n":[1,2,3]}',
  '$(touch /tmp/x) `id` ; rm -rf * && echo $HOME',
];

test('the capture, intake and history bytes of every prompt of the corpus equal the shell hook\'s', { skip }, async () => {
  await Promise.all(CORPUS.map(async (prompt, i) => {
    const r = await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit', prompt }));
    same(r, `prompt ${i}`);
    const keys = Object.keys(r.node.files);
    assert.ok(keys.some((k) => k.endsWith('/prompts/s1.json')), `prompt ${i}: capture written`);
    assert.ok(keys.some((k) => k.includes('/prompts/history/')), `prompt ${i}: history written`);
    assert.ok(keys.some((k) => k.includes('/prompts/intake/')), `prompt ${i}: intake written`);
  }));
});

test('a prompt that is not a string, a missing prompt, odd session ids', { skip }, async () => {
  same(await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit', prompt: 42 })), 'number');
  same(await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit', prompt: ['a', 'b'] })), 'array');
  same(await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit' })), 'missing');
  same(await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 'a/b c\u00e9..' })), 'odd session id');
  same(await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: '' })), 'empty session id');
});

test('a task notification, a subagent and a worker role leave no capture', { skip }, async () => {
  for (const [what, payload, env] of /** @type {Array<[string, object, Record<string, string>]>} */ ([
    ['notification', { prompt: '<task-notification>done</task-notification>' }, {}],
    ['subagent', { prompt: 'hi', agent_id: 'a1', agent_type: 'proofline-explorer' }, {}],
    ['headless specialist', { prompt: 'hi' }, { AGENT_ROLE: 'reviewer' }],
  ])) {
    const r = await pair(template, base, 'prompt', () => ({ hook_event_name: 'UserPromptSubmit', ...payload }), { env });
    same(r, what);
    assert.ok(!Object.keys(r.node.files).some((k) => k.includes('/prompts/s1.json') || k.includes('/prompts/history/')), `${what}: nothing captured`);
  }
});

test('unparsable input, no project: nothing is captured and nothing fails', { skip }, async () => {
  const r = await pair(template, base, 'prompt', () => 'not json at all');
  same(r, 'garbage');
  const dir = mkdtempSync(join(base, 'plain-'));
  const out = await runHook('node', dir, 'prompt', { prompt: 'hi' });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

test('the same hook registered twice runs once', { skip }, async () => {
  const d = copyProject(template, base);
  const first = await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'plan approved' });
  const second = await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'plan approved' });
  assert.equal(first.status, 0);
  assert.equal(second.stdout, '');
  const hist = readdirSync(join(d, '.agents/local/prompts/history'));
  assert.equal(hist.length, 1, 'the second copy wrote no second history file');
});

/** The template with a request for approval of the plan, recorded a second before the user's reply (a reply must be newer than its request). */
let requested = '';
before(() => {
  requested = copyProject(template, base);
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'request-approval', 'LC', 'plan'], { cwd: requested, env: cleanEnv({ PROOFLINE_ENGINE: 'sh' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  spawnSync('sleep', ['1.1']);
});

test('an approval step: recorded from the user\'s reply, refused for a vague one', { skip }, async () => {
  const say = (/** @type {string} */ prompt) => () => ({ hook_event_name: 'UserPromptSubmit', prompt });
  const [a, b, c] = await Promise.all([
    pair(requested, base, 'prompt', say('plan approved, go ahead')),
    pair(requested, base, 'prompt', say('hmm, what does the plan say?')),
    pair(requested, base, 'prompt', say('scope approved and plan approved')),
  ]);
  same(a, 'approval'); same(b, 'no approval phrase'); same(c, 'two kinds in one message');
  assert.match(a.node.stdout, /approval recorded/);
});

test('the approval step is stopped by its budget; the message says it was not recorded and is kept', { skip }, async () => {
  const d = copyProject(requested, base);
  const holder = spawn('sleep', ['30']);
  try {
    mkdirSync(join(d, '.agents/local/.lock'));
    writeFileSync(join(d, '.agents/local/.lock/pid'), `${holder.pid}\n`);
    const t0 = Date.now();
    const r = await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'plan approved, go ahead' }, { env: { PROOFLINE_HOOK_LOCK_WAIT: '30', PROOFLINE_HOOK_APPROVE_BUDGET: '1' } });
    assert.ok(Date.now() - t0 < 15000, 'the hook answered within its budget');
    assert.match(r.stdout, /your approval could not be recorded, send it again/);
    assert.equal(snapshot(d)['.agents/local/prompts/s1.json'].includes('plan approved, go ahead'), true, 'the message is kept');
    assert.ok(!Object.keys(snapshot(d)).some((k) => k.includes('.approving-')), 'the marker is gone');
  } finally { holder.kill(); }
});
