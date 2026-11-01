// @ts-check
// Upgrade and rollback wiring (issue #168, ADR 0001 sections 5.4 and 9), one file, two projects, no run scaffold:
//   1. `proofline init` of this checkout over a project of 0.0.40 (commit bc072f3, the `sh -c` strings) leaves exactly one proofline hook per event
//      in .claude/settings.json and .codex/hooks.json, the Node string; a hook of the user's stays.
//   2. `proofline upgrade` of 0.0.40 over a project of this checkout (a rollback) adds the old string beside the new one for each event, keeps the Node
//      hook files (the old installer removes only what its manifest lists), and each event is then handled once: the Node hook yields, the shell hook runs.
// EQ_PREVIOUS_REF (read by this test only) names another commit or tag; the history must contain it (CI: fetch-depth 0).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { baseEnv, repoRoot, run } from './fixture.mjs';

const REF = process.env.EQ_PREVIOUS_REF || 'bc072f3';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const ARG = { SessionStart: 'session', UserPromptSubmit: 'prompt', PreToolUse: 'pretool', PostToolUse: 'posttool', SubagentStart: 'subagent-start', SubagentStop: 'subagent-stop', Stop: 'stop' };
const base = mkdtempSync(join(tmpdir(), 'eq-wire.'));
after(() => rmSync(base, { recursive: true, force: true }));

/** The previous release, unpacked once. */
/** @type {string} */ let unpacked = '';
function previous() {
  if (unpacked) return unpacked;
  const dir = join(base, 'previous'); mkdirSync(dir);
  const have = run('git', ['cat-file', '-e', `${REF}^{commit}`], { cwd: repoRoot });
  assert.equal(have.code, 0, `the previous release (${REF}) is not in this clone's history: fetch it (git fetch --unshallow), or set EQ_PREVIOUS_REF`);
  const tar = spawnSync('sh', ['-c', `git -C "${repoRoot}" archive "${REF}" | tar -x -C "${dir}"`], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return (unpacked = dir);
}

/** A new git project with its own HOME. @param {string} name */
function newProject(name) {
  const dir = join(base, name); mkdirSync(dir);
  const env = baseEnv(base, { HOME: join(base, `${name}-home`) });
  mkdirSync(env.HOME);
  run('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  return { dir, env };
}
/** @param {string} tree @param {string} dir @param {Record<string,string>} env @param {string} verb */
function proofline(tree, dir, env, verb) {
  const r = run('sh', [join(tree, 'bin/proofline'), verb, ...(verb === 'init' ? ['--yes', '--runtimes', 'claude,codex'] : [])], { cwd: dir, env, timeout: 600000 });
  assert.equal(r.code, 0, `${tree} ${verb}: ${r.stdout}${r.stderr}`);
}
/** @param {string} file */
function commandsByEvent(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(EVENTS.map((e) => [e, /** @type {string[]} */ ((j.hooks?.[e] ?? []).flatMap((/** @type {any} */ g) => (g.hooks ?? []).map((/** @type {any} */ h) => h.command)))]));
}
const mine = (/** @type {string[]} */ cmds) => cmds.filter((c) => /proofline-hook/.test(c));

test(`init over a project of ${REF} leaves exactly one proofline hook per event, the Node string`, { timeout: 900000 }, () => {
  const old = previous();
  const { dir, env } = newProject('init-over-old');
  proofline(old, dir, env, 'init');
  const settings = join(dir, '.claude/settings.json'); const codex = join(dir, '.codex/hooks.json');
  for (const f of [settings, codex]) for (const e of EVENTS) assert.match(mine(commandsByEvent(f)[e])[0] ?? '', /^sh -c '/, `${f} ${e}: the project holds the old string`);
  // a hook of the user's, to stay
  const j = JSON.parse(readFileSync(settings, 'utf8'));
  j.hooks.Stop[0].hooks.push({ type: 'command', command: 'echo mine' });
  writeFileSync(settings, JSON.stringify(j, null, 2));

  proofline(repoRoot, dir, env, 'init');
  for (const [f, rt] of [[settings, 'claude'], [codex, 'codex']]) {
    const now = commandsByEvent(f);
    for (const e of EVENTS) {
      const ours = mine(now[e]);
      assert.equal(ours.length, 1, `${f} ${e}: exactly one proofline hook (${ours.join(' | ')})`);
      assert.match(ours[0], new RegExp(`^node ".*proofline-hook\\.mjs" ${ARG[e]} ${rt}( \\|\\|.*)?$`), `${f} ${e}: the Node string`);
    }
  }
  assert.deepEqual(commandsByEvent(settings).Stop.filter((c) => c === 'echo mine'), ['echo mine'], 'the user\'s hook stays');
  assert.ok(existsSync(join(dir, '.agents/hooks/proofline-hook.mjs')) && existsSync(join(dir, '.agents/hooks/events/pretool.mjs')), 'the Node hook tree is installed');
  assert.ok(existsSync(join(dir, '.agents/hooks/proofline-hook.sh')), 'the shell hook stays beside it');
  // a second init changes nothing
  const before = readFileSync(settings, 'utf8');
  proofline(repoRoot, dir, env, 'upgrade');
  assert.equal(readFileSync(settings, 'utf8'), before, 'idempotent');
});

test(`a ${REF} upgrade over a project of this checkout: the old string sits beside the new one and each event is handled once`, { timeout: 900000 }, () => {
  const old = previous();
  const { dir, env } = newProject('rollback');
  proofline(repoRoot, dir, env, 'init');
  proofline(old, dir, env, 'upgrade');
  const settings = join(dir, '.claude/settings.json');
  const now = commandsByEvent(settings);
  for (const e of EVENTS) {
    const ours = mine(now[e]);
    assert.equal(ours.length, 2, `${e}: the Node string and the old string (${ours.join(' | ')})`);
    assert.ok(ours.some((c) => c.startsWith('node ')) && ours.some((c) => c.startsWith("sh -c '")), e);
  }
  assert.ok(existsSync(join(dir, '.agents/hooks/proofline-hook.mjs')), 'the Node hook files survive the old installer (it removes only what its manifest lists)');
  assert.ok(existsSync(join(dir, '.agents/hooks/proofline-hook.sh')));
  // the runtime runs every string of an event: the Node hook yields everywhere, the shell hook is the one that runs (a run is active and the input unparsable: only a handler denies)
  mkdirSync(join(dir, '.agents/local'), { recursive: true }); writeFileSync(join(dir, '.agents/local/ACTIVE_RUN'), 'LC\n');
  const runEnv = { ...env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: repoRoot };
  for (const e of EVENTS) {
    const [node, shell] = [now[e].find((c) => c.startsWith('node ')) ?? '', now[e].find((c) => c.startsWith("sh -c '")) ?? ''];
    const n = run('sh', ['-c', node], { cwd: dir, env: runEnv, input: 'this is not json' });
    assert.equal(n.code, 0, `${e}: the Node hook yields: ${n.stderr}`);
    assert.equal(n.stdout + n.stderr, '', `${e}: the Node hook prints nothing`);
    if (e === 'PreToolUse') {
      const s = run('sh', ['-c', shell], { cwd: dir, env: runEnv, input: 'this is not json' });
      assert.match(s.stdout, /"permissionDecision":"deny"/, 'the shell hook handles PreToolUse once');
    }
  }
});
