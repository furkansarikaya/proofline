// @ts-check
// The engine switch, the fail-closed cases and the hand-over to the shell hook for an event the Node hook does not own yet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { buildTemplate, haveJq, copyProject, runHook, norm, mkdirSync, rmSync, mkdtempSync, tmpdir, join, cleanEnv } from './harness.mjs';

const skip = haveJq ? false : 'jq is required for the shell hook';
let template = '';
let base = '';
before(() => { template = buildTemplate(); base = mkdtempSync(join(tmpdir(), 'hook-en-')); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** A PATH directory whose `sh` logs every call that names the shell hook or agent.sh, then runs the real one. @returns {{ dir: string, log: string }} */
function shShim() {
  const dir = mkdtempSync(join(base, 'shim-'));
  const log = join(dir, 'calls.log');
  const real = ['/bin/sh', '/usr/bin/sh'].find((p) => { try { readFileSync(p); return true; } catch { return false; } }) ?? '/bin/sh';
  writeFileSync(join(dir, 'sh'), `#!/bin/sh\ncase "$*" in *proofline-hook.sh*|*agent.sh*) printf '%s\\n' "$*" >> "${log}" ;; esac\nexec ${real} "$@"\n`);
  chmodSync(join(dir, 'sh'), 0o755);
  return { dir, log };
}
const calls = (/** @type {string} */ log) => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
const envWith = (/** @type {string} */ dir) => ({ PATH: `${dir}:${process.env.PATH}` });

test('sh in .agents/local/engine hands every event to the shell hook; without it the Node hook answers itself', { skip }, async () => {
  const shim = shShim();
  const d = copyProject(template, base);
  const input = { hook_event_name: 'PostToolUse', tool_name: 'Agent' };
  await runHook('node', d, 'posttool', input, { env: envWith(shim.dir) });
  assert.doesNotMatch(calls(shim.log), /proofline-hook\.sh/, 'the Node hook answers a posttool event itself');
  writeFileSync(join(d, '.agents/local/engine'), 'sh\n');
  await runHook('node', d, 'posttool', input, { env: envWith(shim.dir) });
  assert.match(calls(shim.log), /proofline-hook\.sh posttool claude/, 'the shell hook was started');
  // the file is the switch of the user; so is PROOFLINE_ENGINE=sh in the environment (CI, tests)
  rmSync(join(shim.log), { force: true });
  rmSync(join(d, '.agents/local/engine'));
  await runHook('node', d, 'posttool', input, { env: { ...envWith(shim.dir), PROOFLINE_ENGINE: 'sh' } });
  assert.match(calls(shim.log), /proofline-hook\.sh posttool claude/, 'PROOFLINE_ENGINE=sh');
});

test('sh:<command> sends that one command to agent.sh (shell code), the others stay in this process', { skip }, async () => {
  const shim = shShim();
  const d = copyProject(template, base);
  const input = { hook_event_name: 'Stop', last_assistant_message: 'done' };
  mkdirSync(join(d, '.agents/local/report-turn'), { recursive: true });
  writeFileSync(join(d, '.agents/local/report-turn/s1'), '');
  await runHook('node', d, 'stop', input, { env: envWith(shim.dir) });
  assert.doesNotMatch(calls(shim.log), /report-tokens/, 'report-tokens runs in the hook process');
  writeFileSync(join(d, '.agents/local/report-turn/s1'), '');
  writeFileSync(join(d, '.agents/local/engine'), 'sh:report-tokens,summary\n');
  await runHook('node', d, 'stop', input, { env: envWith(shim.dir) });
  assert.match(calls(shim.log), /agent\.sh report-tokens LC/, 'report-tokens runs through agent.sh');
});

test('pretool is handed to the shell hook until its Node module exists, and keeps the fail-closed cases', { skip }, async () => {
  const d = copyProject(template, base);
  const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
  for (const [what, payload] of /** @type {Array<[string, string | object]>} */ ([['unparsable JSON during a run', '{not json'], ['a Write without a target path', { ...bash, tool_name: 'Write', tool_input: {} }]])) {
    const sh = await runHook('sh', d, 'pretool', payload);
    const node = await runHook('node', d, 'pretool', payload);
    assert.equal(norm(node.stdout, d), norm(sh.stdout, d), what);
    assert.equal(node.status, sh.status, what);
    assert.match(node.stdout, /"permissionDecision":"deny"/, `${what}: denied`);
  }
  writeFileSync(join(d, '.agents/local/ACTIVE_RUN'), 'not a valid id!\n');
  const sh = await runHook('sh', d, 'pretool', bash);
  const node = await runHook('node', d, 'pretool', bash);
  assert.equal(norm(node.stdout, d), norm(sh.stdout, d));
  assert.match(node.stdout, /ACTIVE_RUN is malformed/);
});

test('the other events pass on unparsable JSON and without an installed project, and print nothing', { skip }, async () => {
  const d = copyProject(template, base);
  for (const ev of ['posttool', 'prompt', 'stop', 'subagent-start', 'subagent-stop']) { // (a session start does not need the JSON)
    const r = await runHook('node', d, ev, 'garbage {');
    assert.equal(r.status, 0, ev);
    assert.equal(r.stdout, '', ev);
  }
  const plain = mkdtempSync(join(base, 'plain-'));
  for (const ev of ['posttool', 'prompt', 'stop', 'session', 'subagent-start', 'subagent-stop']) {
    const r = await runHook('node', plain, ev, { hook_event_name: 'x', prompt: 'hi' });
    assert.equal(r.status, 0, ev);
    assert.equal(r.stdout, '', ev);
  }
  void cleanEnv;
});
