// @ts-check
// A Windows host only: Node 22.13 aborts the whole process on a path that holds U+10000 and the runtime reads any exit code other than 2 as a non-blocking error, so the hook screens its input before it
// touches the file system (adapters/claude/hooks/lib/winabort.mjs). The screen is a pure function and is tested on every host with the Windows switch on; the real hook process is asked on this host:
// on Windows it must DENY (and not abort), elsewhere the screen is off and the call is judged as any other.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abortingInput, screenEvent } from '../../adapters/claude/hooks/lib/winabort.mjs';
import { buildTemplate, copyProject, runHook, rmSync } from './harness.mjs';

const WIN = process.platform === 'win32';
const LB = '\u{10000}';
const ev = (/** @type {object} */ o) => Buffer.from(JSON.stringify({ cwd: '/p', session_id: 's1', ...o }));

test('winabort: a path-bearing field with U+10000 aborts the screen, in any field, nested, as a literal or as a JSON escape; content and prose do not', () => {
  assert.equal(abortingInput({ tool_input: { file_path: `src/a${LB}.txt` } }), true);
  assert.equal(abortingInput({ tool_input: { command: `cat a${LB}` } }), true);
  assert.equal(abortingInput({ tool_input: { paths: [{ p: `x${LB}` }] } }), true);
  assert.equal(abortingInput({ cwd: `C:/w${LB}` }), true);
  assert.equal(abortingInput({ tool_input: { file_path: 'a\u{10FFFF}' } }), true, 'the last code point aborts Node on Windows as well');
  assert.equal(abortingInput({ tool_input: { file_path: 'a\u{10FFFE}\u{10FFF0}\u{FFFF}' } }), false, 'its neighbours do not');
  assert.equal(screenEvent('pretool', Buffer.from('{"tool_input":{"file_path":"a\\ud800\\udc00b"}}'), true)?.includes('"deny"'), true, 'the JSON escape of U+10000 is the same character');
  assert.equal(abortingInput({ tool_input: { file_path: 'a.txt', content: `text ${LB}` } }), false, 'file content is not a path');
  assert.equal(abortingInput({ tool_input: { file_path: 'a.txt', new_string: LB, old_string: LB } }), false);
  assert.equal(abortingInput({ tool_input: { command: 'echo \u{10001} \u{1F600}' } }), false, 'only the measured code points');
  assert.equal(abortingInput(null), false);
  assert.equal(abortingInput('x'), false);
});

test('winabort: any depth is scanned (no depth limit), a patch is judged by its file headers only, a text over the bound is refused', () => {
  /** @type {any} */ let deep = { file_path: `a${LB}` };
  for (let i = 0; i < 40; i++) deep = { x: [deep] };
  assert.equal(abortingInput({ tool_input: deep }), true, 'forty levels down');
  /** @type {any} */ const cyc = { a: 1 }; cyc.self = cyc;
  assert.equal(abortingInput({ tool_input: cyc }), false, 'a cycle ends');
  const patch = (/** @type {string} */ head, /** @type {string} */ body) => `*** Begin Patch\n*** Add File: ${head}\n+${body}\n*** End Patch`;
  assert.equal(abortingInput({ tool_input: patch('src/a.txt', `text ${LB}`) }), false, 'the body of a patched file is not a path');
  assert.equal(abortingInput({ tool_input: patch(`src/a${LB}.txt`, 'x') }), true, 'a file header is');
  assert.equal(abortingInput({ tool_input: { input: patch(`src/a.txt`, LB) } }), false, 'a patch held in a field is read the same way');
  assert.equal(abortingInput({ tool_input: { command: 'x'.repeat(9 * 1024 * 1024) } }), true, 'a path-bearing text over the bound fails closed');
});

test('winabort: the screen is Windows only; PreToolUse is denied, PostToolUse is not handled, other events and non-JSON go on', () => {
  const bad = ev({ tool_name: 'Write', tool_input: { file_path: `a${LB}` } });
  assert.equal(screenEvent('pretool', bad, false), null, 'off on another host');
  const deny = JSON.parse(String(screenEvent('pretool', bad, true)));
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /U\+10000/);
  assert.equal(screenEvent('posttool', bad, true), '');
  assert.equal(screenEvent('prompt', ev({ prompt: LB }), true), null);
  assert.equal(screenEvent('pretool', ev({ tool_input: { file_path: 'a.txt' } }), true), null);
  assert.equal(screenEvent('pretool', Buffer.from('not json'), true), null);
});

let template = ''; let base = ''; let dir = '';
before(() => { template = buildTemplate(); base = tempDir('hook-winabort-'); dir = copyProject(template, base); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

test('winabort: the real hook process answers a Write and a shell command that name U+10000 with a DENY and exit code 0 on Windows (it must not abort), and judges them as any other call elsewhere', async () => {
  const who = { agent_type: 'proofline-implementer', agent_id: 'f1' };
  for (const input of [{ tool_name: 'Write', tool_input: { file_path: `${dir}/impl${LB}.txt`, content: 'x' } }, { tool_name: 'Bash', tool_input: { command: `echo x > impl${LB}.txt` } }, { tool_name: 'Read', tool_input: { file_path: `${dir}/a${LB}` } }]) {
    const r = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', ...who, ...input }, { env: { AGENT_ROLE: 'implementer' } });
    if (WIN) {
      assert.equal(r.status, 0, `${input.tool_name}: the hook ended with ${r.status} (an abort is 3221226505): ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', input.tool_name);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /U\+10000/);
    } else {
      assert.ok(r.status === 0 || r.status === 2, `${input.tool_name}: status ${r.status}`);
      assert.doesNotMatch(r.stdout, /U\+10000/, 'the Windows screen is off on this host');
    }
  }
  // an ordinary call is not touched by the screen
  const ok = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${dir}/impl.txt` }, ...who }, { env: { AGENT_ROLE: 'implementer' } });
  assert.doesNotMatch(ok.stdout, /U\+10000/);
});
