// @ts-check
// UserPromptSubmit: the capture contract (Invariant 3) of the Node hook against the shell hook on a corpus of prompts: the intake copy, the capture
// file, the history copy, and the approval step. The committed golden bytes of the capture live in tests/golden/capture (package CMDS).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { buildTemplate, haveJq, runHook, copyProject, snapshot, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join, spawnSync, cleanEnv } from './harness.mjs';

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
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'request-approval', 'LC', 'plan'], { cwd: requested, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  spawnSync('sleep', ['1.1']);
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
