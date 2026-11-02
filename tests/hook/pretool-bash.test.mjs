// @ts-check
// PreToolUse for a shell command: the fail-closed cases of the Node router. (The corpus of commands per caller is in tests/enforcement/recorded.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate, copyProject, haveJq, runHook, snapshot, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join } from './harness.mjs';

const skip = false;
let withRun = '';
let noRun = '';
let base = '';
before(() => { withRun = buildTemplate(); noRun = buildTemplate({ run: false }); base = mkdtempSync(join(tmpdir(), 'hook-pre-')); });
after(() => { rmSync(withRun, { recursive: true, force: true }); rmSync(noRun, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {'node'} kind @param {string} dir @param {string} command @param {object} who @param {Record<string, string>} env */
function pre(kind, dir, command, who, env) {
  return runHook(kind, dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }, { env });
}

test('fail closed: unparsable input during a run denies, without a run it passes', { skip }, async () => {
  const d = copyProject(withRun, base);
  const r = await runHook('node', d, 'pretool', 'not json');
  assert.match(r.stdout, /"permissionDecision":"deny"/);
  assert.match(r.stdout, /hook input could not be parsed/);
  const e = copyProject(noRun, base);
  const q = await runHook('node', e, 'pretool', 'not json');
  assert.equal(q.stdout, '');
  assert.equal(q.status, 0);
});

test('fail closed: a malformed ACTIVE_RUN denies', { skip }, async () => {
  const d = copyProject(withRun, base);
  writeFileSync(join(d, '.agents/local/ACTIVE_RUN'), 'bad id!\n');
  const r = await pre('node', d, 'ls', {}, {});
  assert.match(r.stdout, /ACTIVE_RUN is malformed/);
});

test('fail closed: a broken core during a run denies a Bash call and says why', { skip }, async () => {
  const d = copyProject(withRun, base);
  writeFileSync(join(d, '.agents/scripts/proofline-core.mjs'), 'throw new Error("boom");\n');
  const r = await pre('node', d, 'git push origin main', {}, {});
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});

test('a project without proofline: only the merge and kill guards speak', { skip }, async () => {
  const d = mkdtempSync(join(base, 'plain-'));
  mkdirSync(join(d, '.git'));
  const r = await pre('node', d, 'ls', {}, {});
  assert.equal(r.stdout, '');
  const k = await pre('node', d, 'pkill node', {}, {});
  assert.match(k.stdout, /"permissionDecision":"deny"/);
});
