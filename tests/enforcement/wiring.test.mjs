// @ts-check
// Stage 3 wiring (ADR 0001 sections 5.3, 5.4, 9; issue #168): the REAL command strings of the three wiring files run through `sh -c`, as the runtimes
// run them. Node absent (C2): PreToolUse blocks with exit 2 in all three forms. The shipped git hook launchers: a commit is blocked when node is absent, the allowed path is unchanged, the push guard holds.
import assert from 'node:assert/strict';
import { appendFileSync, symlinkSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { baseEnv, copyTree, installedFixture, pathWithoutNode, repoRoot, run } from '../core/lib/fixture.mjs';
import { hookStrictProblem, hookTemplates } from '../ci/no-shell-logic.mjs';

const EVENTS = ['session', 'prompt', 'pretool', 'posttool', 'subagent-start', 'subagent-stop', 'stop'];
const HOOKS = join(repoRoot, 'adapters/claude/hooks');
const base = mkdtempSync(join(tmpdir(), 'wiring.'));
const noNode = pathWithoutNode();
after(() => { rmSync(base, { recursive: true, force: true }); noNode.cleanup(); });

/** The commands of a wiring file by event name: [{event, command}]. @param {string} rel */
function wiring(rel) {
  const j = JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
  /** @type {{ event: string, command: string }[]} */ const out = [];
  for (const [event, groups] of Object.entries(j.hooks)) for (const g of groups) for (const h of g.hooks) out.push({ event, command: h.command });
  return out;
}
const FORMS = /** @type {const} */ ([
  ['plugin', 'adapters/claude/hooks/hooks.json', 'claude'],
  ['project', 'adapters/claude/settings.fragment.json', 'claude'],
  ['codex', 'adapters/codex/hooks.json', 'codex'],
]);
const pretoolOf = (/** @type {string} */ rel) => (wiring(rel).find((w) => w.event === 'PreToolUse') ?? { command: '' }).command;

/** the hook's deny: JSON on stdout (exit 0) @param {{ stdout: string }} r */
const denied = (r) => /"permissionDecision":"deny"/.test(r.stdout);

let projects = 0;
/** An installed project (the control plane as `init` lays it out, the Node hook tree in .agents/hooks) in its own copy. @param {{ config?: boolean, run?: boolean }} [o] */
function project(o = {}) {
  const dir = join(base, `p${++projects}`);
  copyTree(installedFixture().dir, dir);
  mkdirSync(join(dir, '.agents/hooks'), { recursive: true });
  for (const f of ['proofline-hook.mjs', 'command-scan.mjs']) cpSync(join(HOOKS, f), join(dir, '.agents/hooks', f));
  for (const d of ['events', 'guards', 'lib']) cpSync(join(HOOKS, d), join(dir, '.agents/hooks', d), { recursive: true });
  if (o.config === false) rmSync(join(dir, '.agents/config.yaml'));
  if (o.run) writeFileSync(join(dir, '.agents/local/ACTIVE_RUN'), 'LC\n');
  return dir;
}

/** Run a wiring string through sh -c in the way the runtime does. @param {string} command @param {string} dir @param {{ nonode?: boolean, input?: string, env?: Record<string,string> }} [o] */
function wired(command, dir, o = {}) {
  const env = baseEnv(base, { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: repoRoot, ...(o.nonode ? { PATH: noNode.path } : {}), ...o.env });
  return run('sh', ['-c', command], { cwd: dir, env, input: o.input ?? '{}' });
}

test('every wiring string equals a pinned template, wires all 7 events, and each PreToolUse string carries the fail-closed guard', () => {
  const templates = hookTemplates(repoRoot);
  for (const [form, rel] of FORMS) {
    const w = wiring(rel);
    assert.deepEqual(w.map((x) => x.event).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'], form);
    for (const { event, command } of w) {
      assert.equal(hookStrictProblem(command, templates), '', `${form} ${event}`);
      assert.match(command, /^node "/, `${form} ${event} starts node`);
      assert.equal(/exit 2/.test(command), event === 'PreToolUse', `${form} ${event}: only PreToolUse carries the guard`);
    }
  }
});

test('node absent: PreToolUse blocks with exit 2 in the plugin form, and in the project and Codex forms whenever .agents/config.yaml exists', () => {
  const plugin = pretoolOf('adapters/claude/hooks/hooks.json');
  const proj = pretoolOf('adapters/claude/settings.fragment.json');
  const codex = pretoolOf('adapters/codex/hooks.json');
  for (const [name, command] of [['plugin', plugin], ['project', proj], ['codex', codex]]) {
    const withRun = project({ run: true });
    const r = wired(command, withRun, { nonode: true });
    assert.equal(r.code, 2, `${name} form, run open: ${r.stderr}`);
    assert.match(r.stderr, /failing closed/, `${name}: says why`);
    assert.equal(wired(command, project(), { nonode: true }).code, 2, `${name} form, config present, no run`);
    // the same project without proofline: the plugin form is stricter on purpose (ADR section 9); project and Codex stay out of the way
    const bare = wired(command, project({ config: false }), { nonode: true });
    assert.equal(bare.code, name === 'plugin' ? 2 : 0, `${name} form, no config: ${bare.stderr}`);
  }
  // the other events are not blocking when node is absent (a start failure of a non-PreToolUse event is the runtime's non-blocking error)
  for (const [, rel] of FORMS) for (const { event, command } of wiring(rel)) if (event !== 'PreToolUse') assert.notEqual(wired(command, project(), { nonode: true }).code, 2, event);
});

test('node present: the three PreToolUse strings run the hook; an unparsable input during a run is denied by the hook itself', () => {
  for (const rel of ['adapters/claude/hooks/hooks.json', 'adapters/claude/settings.fragment.json', 'adapters/codex/hooks.json']) {
    const command = pretoolOf(rel);
    const dir = project({ run: true });
    run('git', ['config', 'user.email', 'x@example.invalid'], { cwd: dir });
    const r = wired(command, dir, { input: 'this is not json' });
    assert.ok(denied(r), `${rel}: ${r.stdout}${r.stderr}`);
    const quiet = wired(command, project({ config: false }), { input: '{}' });
    assert.equal(quiet.code, 0, `${rel} without proofline: ${quiet.stderr}`);
  }
});

// The strings of 0.0.40 to 0.0.42 (identical in the three releases), which a rollback `upgrade` adds beside the new ones.

/** @param {string} dir @param {string} file @param {string[]} commands */


// ---- the git hook launchers ---------------------------------------------------------------------------------------------------------------
function repoWithHooks(/** @type {string} */ config = '') {
  const dir = project();
  const g = (/** @type {string[]} */ ...a) => run('git', a, { cwd: dir, env: baseEnv(base) });
  if (config) writeFileSync(join(dir, '.agents/config.yaml'), config);
  g('config', 'core.hooksPath', '.agents/githooks'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, '.git/info/exclude'), '.agents/hooks/\n');
  return { dir, g };
}

test('git hook launchers: pre-commit and pre-push are one exec node line each', () => {
  for (const [name, sub] of [['pre-commit', 'cli pre-commit'], ['pre-push', 'cli pre-push']]) {
    const text = readFileSync(join(repoRoot, 'control-plane/agents/githooks', name), 'utf8');
    assert.equal(text, `#!/bin/sh\nexec node "$(dirname "$0")/../scripts/proofline-core.mjs" ${sub}\n`);
  }
});

test('pre-commit launcher: a commit is blocked when node is absent, and goes through unchanged with node', () => {
  const { dir } = repoWithHooks();
  const commit = (/** @type {Record<string,string>} */ env, /** @type {string} */ msg) => {
    writeFileSync(join(dir, 'f.txt'), `${msg}\n`); run('git', ['add', 'f.txt'], { cwd: dir, env: baseEnv(base) });
    return run('git', ['commit', '-qm', msg], { cwd: dir, env: baseEnv(base, env) });
  };
  const blocked = commit({ PATH: noNode.path }, 'no node');
  assert.notEqual(blocked.code, 0, `the commit went through without node: ${blocked.stdout}${blocked.stderr}`);
  assert.match(run('git', ['log', '--oneline'], { cwd: dir }).stdout, /^[0-9a-f]+ baseline\n$/, 'no commit was made');
  const ok = commit({}, 'with node');
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(run('git', ['log', '--oneline', '-1'], { cwd: dir }).stdout, /with node/);
});

test('pre-commit launcher: the refusal texts are the core\'s (identity guard)', () => {
  const { dir } = repoWithHooks('git:\n  forbidden_identities: nobody@example.invalid\n');
  writeFileSync(join(dir, 'f.txt'), 'x\n'); run('git', ['add', 'f.txt'], { cwd: dir });
  const r = run('git', ['commit', '-qm', 'x'], { cwd: dir, env: baseEnv(base, { GIT_AUTHOR_EMAIL: 'nobody@example.invalid' }) });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /proofline pre-commit: BLOCKED: the author email matches git.forbidden_identities/);
});

test('pre-push launcher: the push guard holds (protected branch, approval switch), a human push passes, node absent blocks', () => {
  const { dir, g } = repoWithHooks('git:\n  protected_branches: main\n  push_requires_approval: true\n');
  const remote = join(base, 'remote.git');
  run('git', ['init', '-q', '--bare', remote]);
  g('remote', 'add', 'origin', remote); g('checkout', '-q', '-b', 'topic');
  const push = (/** @type {string} */ ref, /** @type {Record<string,string>} */ env = {}) => run('git', ['push', '-q', 'origin', ref], { cwd: dir, env: baseEnv(base, env) });
  const prot = push('topic:main');
  assert.notEqual(prot.code, 0); assert.match(prot.stderr, /proofline pre-push: BLOCKED: branch 'main' is listed in git.protected_branches/);
  const noApproval = push('topic:topic');
  assert.notEqual(noApproval.code, 0); assert.match(noApproval.stderr, /git.push_requires_approval: no user push approval/);
  const nonode = push('topic:topic', { PATH: noNode.path });
  assert.notEqual(nonode.code, 0, 'blocked when node is absent');
  // a human (no agent marker, PROOFLINE_NO_TTY unset) passes the approval switch but never a protected branch... a human may push there
  const human = run('git', ['push', '-q', 'origin', 'topic:topic'], { cwd: dir, env: (() => { const e = baseEnv(base); delete e.PROOFLINE_NO_TTY; return e; })() });
  assert.equal(human.code, 0, human.stderr);
});

test('S3-6: a huge command is answered within the budget, and denied while a run exists', () => {
  const command = pretoolOf('adapters/claude/settings.fragment.json');
  const dir = project({ run: true });
  for (const size of [300 * 1024, 4 * 1024 * 1024]) {
    const cmd = 'xargs a b c '.repeat(Math.ceil(size / 12));
    const t0 = Date.now();
    const r = wired(command, dir, { input: JSON.stringify({ cwd: dir, session_id: 's1', tool_name: 'Bash', tool_input: { command: cmd } }) });
    assert.ok(Date.now() - t0 < 20000, `${size} bytes answered in ${Date.now() - t0} ms`);
    assert.ok(denied(r), `${size} bytes: ${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}`);
    assert.match(r.stdout, /ran out of time/);
  }
});

