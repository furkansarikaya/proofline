// @ts-check
// Stage 3 wiring (ADR 0001 sections 5.3, 5.4, 9; issue #168): the REAL command strings of the three wiring files run through `sh -c`, as the runtimes
// run them. Node absent (C2): PreToolUse blocks with exit 2 in all three forms. The Node hook yields to an old shell wiring of the same event in the
// same settings file, so each event is handled once. The engine switch in .agents/local/engine is read through the installed wiring. The shipped git
// hook launchers: a commit is blocked when node is absent, the allowed path is unchanged, the push guard holds.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { baseEnv, copyTree, installedFixture, pathWithoutNode, repoRoot, run } from '../equivalence/fixture.mjs';
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
  for (const f of ['proofline-hook.mjs', 'proofline-hook.sh', 'command-scan.mjs']) cpSync(join(HOOKS, f), join(dir, '.agents/hooks', f));
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

// The strings of 0.0.40-0.0.42, which a rollback `upgrade` adds beside the new ones.
const OLD_PROJECT = `sh -c 'r=$CLAUDE_PROJECT_DIR; h=$r/.agents/hooks/proofline-hook.sh; [ -f "$h" ] || { [ -f "$r/.agents/config.yaml" ] || exit 0; echo "proofline: $h is missing; failing closed" >&2; exit 2; }; exec sh "$h" pretool claude'`;
const OLD_PLUGIN = `sh -c 'grep -Eqs "proofline-hook[.]sh.* pretool claude" "$CLAUDE_PROJECT_DIR/.claude/settings.json" && exit 0; exec sh "\${CLAUDE_PLUGIN_ROOT}/adapters/claude/hooks/proofline-hook.sh" pretool claude'`;
const OLD_CODEX = `sh -c 'r=$(git rev-parse --show-toplevel 2>/dev/null) || r=$PWD; h=$r/.agents/hooks/proofline-hook.sh; [ -f "$h" ] || { [ -f "$r/.agents/config.yaml" ] || exit 0; echo "proofline: $h is missing; failing closed" >&2; exit 2; }; exec sh "$h" pretool codex'`;

/** @param {string} dir @param {string} file @param {string[]} commands */
function settings(dir, file, commands) {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ hooks: { PreToolUse: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] } }, null, 2));
}

test('the Node hook yields when the same settings file also wires the old shell string for the event (each event is handled once)', () => {
  const bad = 'this is not json';   // an installed project with a run denies this; a hook that yielded prints nothing and exits 0
  for (const [name, rel, file, oldCmd, ext] of /** @type {const} */ ([
    ['project', 'adapters/claude/settings.fragment.json', '.claude/settings.json', OLD_PROJECT, ''],
    ['codex', 'adapters/codex/hooks.json', '.codex/hooks.json', OLD_CODEX, ''],
    ['plugin', 'adapters/claude/hooks/hooks.json', '.claude/settings.json', OLD_PROJECT, ''],
    ['plugin vs the project Node string', 'adapters/claude/hooks/hooks.json', '.claude/settings.json', pretoolOf('adapters/claude/settings.fragment.json'), ''],
  ])) {
    const command = pretoolOf(rel);
    const alone = project({ run: true });
    settings(alone, file, name === 'plugin' || name.startsWith('plugin ') ? [] : [command]);
    assert.ok(denied(wired(command, alone, { input: bad })), `${name}: handles the event when it is the only wiring`);
    const both = project({ run: true });
    settings(both, file, [oldCmd, command]);
    const r = wired(command, both, { input: bad });
    assert.equal(r.code, 0, `${name}: yields (${r.stdout}${r.stderr})`);
    assert.equal(r.stdout + r.stderr, '', `${name}: nothing printed`);
    void ext;
  }
  // the old plugin string in a settings file yields the same way, and another event's old string does not make the hook yield
  const other = project({ run: true });
  settings(other, '.claude/settings.json', [OLD_PROJECT.replace('pretool claude', 'posttool claude')]);
  assert.ok(denied(wired(pretoolOf('adapters/claude/settings.fragment.json'), other, { input: bad })), 'an old string of another event is no reason to yield');
  const oldPlugin = project({ run: true });
  settings(oldPlugin, '.claude/settings.json', [OLD_PLUGIN]);
  assert.ok(denied(wired(pretoolOf('adapters/claude/settings.fragment.json'), oldPlugin, { input: bad })), 'the old plugin string in a settings file greps itself and handles nothing: no yield');
});

test('a decoy in the settings file never makes the hook yield (S3-4); unparsable settings keep it active', () => {
  const bad = 'this is not json';
  const projCmd = pretoolOf('adapters/claude/settings.fragment.json');
  const plugCmd = pretoolOf('adapters/claude/hooks/hooks.json');
  const decoyText = 'echo proofline-hook.sh pretool claude';
  const nodeDecoy = 'true # .agents/hooks/proofline-hook.mjs pretool claude';
  /** @type {[string, (dir: string) => void][]} */
  const cases = [
    ['a command key under env', (d) => put(d, '.claude/settings.json', { env: { command: decoyText }, hooks: {} })],
    ['a Notification hook', (d) => put(d, '.claude/settings.json', { hooks: { Notification: [{ hooks: [{ type: 'command', command: `${decoyText}` }] }] } })],
    ['a PreToolUse entry that only contains the name (shell)', (d) => put(d, '.claude/settings.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: decoyText }] }] } })],
    ['a PreToolUse entry that only contains the name (node)', (d) => put(d, '.claude/settings.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: nodeDecoy }] }] } })],
    ['the exact old string under another event', (d) => put(d, '.claude/settings.json', { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: OLD_PROJECT }] }] } })],
    ['the old string plus a suffix', (d) => put(d, '.claude/settings.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `${OLD_PROJECT} # x` }] }] } })],
    ['a non-array hooks value', (d) => put(d, '.claude/settings.json', { hooks: { PreToolUse: { hooks: [{ command: OLD_PROJECT }] } } })],
    ['hooks as an array', (d) => put(d, '.claude/settings.json', { hooks: [{ command: OLD_PROJECT }] })],
    ['a malformed settings file', (d) => { mkdirSync(join(d, '.claude'), { recursive: true }); writeFileSync(join(d, '.claude/settings.json'), `{ "hooks": ${OLD_PROJECT} `); }],
    ['the old string only in settings.local.json', (d) => put(d, '.claude/settings.local.json', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: OLD_PROJECT }] }] } })],
  ];
  for (const [name, make] of cases) {
    for (const [form, command] of [['project', projCmd], ['plugin', plugCmd]]) {
      const dir = project({ run: true });
      make(dir);
      assert.ok(denied(wired(command, dir, { input: bad })), `${form}: ${name}: the hook stays active`);
    }
  }
  // the positive case for contrast: the exact old string, in the right event, with its hook file present
  const real = project({ run: true });
  settings(real, '.claude/settings.json', [OLD_PROJECT]);
  assert.equal(wired(projCmd, real, { input: bad }).stdout, '', 'the exact old string makes the project hook yield');
  // the exact old string but without the shell hook it would start: nothing handles the event, so no yield
  const gone = project({ run: true });
  settings(gone, '.claude/settings.json', [OLD_PROJECT]);
  rmSync(join(gone, '.agents/hooks/proofline-hook.sh'));
  assert.ok(denied(wired(projCmd, gone, { input: bad })), 'no shell hook file: no yield');
});

/** @param {string} dir @param {string} rel @param {unknown} json */
function put(dir, rel, json) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), JSON.stringify(json));
}

test('the engine switch .agents/local/engine, read through the installed wiring, hands the event to the shell hook', () => {
  const dir = project({ run: true });
  const command = pretoolOf('adapters/claude/settings.fragment.json');
  assert.ok(denied(wired(command, dir, { input: 'this is not json' })), 'Node hook');
  writeFileSync(join(dir, '.agents/hooks/proofline-hook.sh'), '#!/bin/sh\necho "SHELL HOOK $*"\nexit 0\n');
  chmodSync(join(dir, '.agents/hooks/proofline-hook.sh'), 0o755);
  writeFileSync(join(dir, '.agents/local/engine'), 'sh\n');
  const r = wired(command, dir, { input: '{}' });
  assert.match(r.stdout, /SHELL HOOK pretool claude/);
  assert.equal(r.code, 0);
});

test('C6 rollback: with `sh` in .agents/local/engine, or PROOFLINE_ENGINE=sh, every wiring form runs the OLD shell hook (its own bytes, not a stub)', () => {
  for (const [form, rel, rt] of FORMS) {
    const command = pretoolOf(rel);
    const dir = project({ run: true });
    // the project's shell hook leaves a marker file when it starts (its first lines are the real file's): the Node hook never does
    const shPath = join(dir, '.agents/hooks/proofline-hook.sh');
    const shText = readFileSync(shPath, 'utf8');
    writeFileSync(shPath, shText.replace('\n', `\n: > "${dir}/.shell-ran"\n`));
    // the plugin form runs the plugin's own hook tree (not the project's copy), so only the other two forms can show the marker
    const ran = () => existsSync(join(dir, '.shell-ran'));
    const direct = run('sh', [join(dir, '.agents/hooks/proofline-hook.sh'), 'pretool', rt], { cwd: dir, env: baseEnv(base, { CLAUDE_PROJECT_DIR: dir }), input: 'this is not json' });
    assert.ok(denied(direct), `${form}: the shell hook denies unparsable input during a run`);
    rmSync(join(dir, '.shell-ran'), { force: true });
    assert.ok(denied(wired(command, dir, { input: 'this is not json' })), `${form}: Node hook denies`);
    assert.ok(!ran(), `${form}: the Node hook does not start the shell hook by default`);
    writeFileSync(join(dir, '.agents/local/engine'), 'sh\n');
    const byFile = wired(command, dir, { input: 'this is not json' });
    assert.ok(form === 'plugin' || ran(), `${form}: engine file: the shell hook ran`); rmSync(join(dir, '.shell-ran'), { force: true });
    rmSync(join(dir, '.agents/local/engine'));
    const byEnv = wired(command, dir, { input: 'this is not json', env: { PROOFLINE_ENGINE: 'sh' } });
    assert.ok(form === 'plugin' || ran(), `${form}: PROOFLINE_ENGINE=sh: the shell hook ran`);
    for (const [how, r] of [['engine file', byFile], ['PROOFLINE_ENGINE=sh', byEnv]]) {
      assert.equal(r.stdout, direct.stdout, `${form}, ${how}: the shell hook's bytes`);
      assert.equal(r.code, direct.code, `${form}, ${how}: exit status`);
    }
  }
});

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

test('yield.mjs knows exactly the strings the installers wrote (no drift from the wiring files or the 0.0.40 strings)', async () => {
  const { knownStrings } = await import('../../adapters/claude/hooks/lib/yield.mjs');
  const keys = { session: 'SessionStart', prompt: 'UserPromptSubmit', pretool: 'PreToolUse', posttool: 'PostToolUse', 'subagent-start': 'SubagentStart', 'subagent-stop': 'SubagentStop', stop: 'Stop' };
  const frag = wiring('adapters/claude/settings.fragment.json');
  for (const [ev, key] of Object.entries(keys)) {
    assert.deepEqual(knownStrings(ev, 'claude').newProject, [frag.find((w) => w.event === key)?.command], ev);
  }
  assert.deepEqual(knownStrings('pretool', 'claude').old, [OLD_PROJECT]);
  assert.deepEqual(knownStrings('pretool', 'codex').old, [OLD_CODEX]);
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
