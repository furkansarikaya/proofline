// @ts-check
// A Windows host only: Node 22.13 aborts the whole process on a path that holds U+10000 and the runtime reads any exit code other than 2 as a non-blocking error, so the hook screens its input before it
// touches the file system (adapters/claude/hooks/lib/winabort.mjs). The screen is a pure function and is tested on every host with the Windows switch on; the real hook process is asked on this host:
// on Windows it must DENY (and not abort), elsewhere the screen is off and the call is judged as any other.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { abortingInput, screenEvent } from '../../adapters/claude/hooks/lib/winabort.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTemplate, copyProject, runHook, rmSync, repo } from './harness.mjs';

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

// ---- the wiring turns an abort into a block (the premise of the screen being a message and not the control) ----

const WIRINGS = ['adapters/claude/hooks/hooks.json', 'adapters/codex/hooks.json'];
/** @param {string} rel */
const pretool = (rel) => /** @type {string} */ (JSON.parse(readFileSync(join(repo, rel), 'utf8')).hooks.PreToolUse[0].hooks[0].command);

test('winabort: both hooks.json files run the PreToolUse hook behind a wrapper that exits 2 when node does not end normally (an abort is a block)', () => {
  for (const rel of WIRINGS) {
    const c = pretool(rel);
    // the plugin form is `node HOOK || { ...; exit 2; }`; the Codex form (A302) keeps the status of node itself (tests/enforcement/pretool-exit-status.test.mjs runs it with every status)
    if (rel.includes('codex')) assert.match(c, /pretool codex; rc=\$\?; test \$rc -eq 0 && exit 0; test \$rc -eq 2 \|\| echo "[^"]*"[^;]*; exit 2; fi; /, rel);
    else assert.match(c, /^node "[^"]*proofline-hook\.mjs" pretool claude \|\| /, rel);
    assert.match(c, /exit 2; \}$/, `${rel}: the wrapper ends in exit 2`);
    assert.match(c, /failing closed/, rel);
  }
});

test('winabort: the exact wrapper of hooks.json, run through sh, exits 2 (not 0) when a name with U+10000 sits in a folder the hook lists; elsewhere the name is ordinary and the wrapper exits 0', () => {
  const sh = (/** @type {string} */ script) => spawnSync('sh', ['-c', `n=$(printf '\\360\\220\\200\\200'); ${script}`, 'sh', dir], { encoding: 'utf8' });
  const command = pretool('adapters/claude/hooks/hooks.json');
  const run = () => spawnSync('sh', ['-c', command], { cwd: dir, input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git status --short' }, agent_type: 'proofline-implementer', agent_id: 'f1' }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: repo, AGENT_ROLE: 'implementer' } });
  assert.equal(run().status, 0, 'without the entry the wrapper exits 0');
  const made = sh('mkdir -p "$1/.git/worktrees/ev$n" && echo "$1/ev$n/.git" > "$1/.git/worktrees/ev$n/gitdir" && echo made');
  assert.equal(made.stdout.trim(), 'made', made.stderr);
  try {
    const r = run();
    if (WIN) {
      assert.equal(r.status, 2, `the wrapper must turn the abort into a block (status ${r.status}): ${r.stderr}`);
      assert.match(r.stderr, /failing closed/);
    } else assert.equal(r.status, 0, r.stderr);
  } finally { sh('rm -rf "$1/.git/worktrees/ev$n"'); }
});

test('winabort: an exception inside the scan fails closed on Windows (deny) and the screen stays off elsewhere', () => {
  const boom = () => { throw new Error('boom'); };
  const raw = ev({ tool_input: { file_path: 'a.txt' } });
  const out = screenEvent('pretool', raw, true, boom);
  assert.equal(out?.includes('"deny"'), true);
  assert.equal(out?.includes('could not screen the tool input for U+10000 or U+10FFFF; denied'), true);
  assert.equal(screenEvent('posttool', raw, true, boom), '', 'a PostToolUse is left unhandled');
  assert.equal(screenEvent('pretool', raw, false, boom), null, 'off Windows the scanner is never called');
});
