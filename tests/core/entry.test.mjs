// @ts-check
// The core's entry is not a second front door to agent.sh, and agent.sh fails closed in an installed project that lost the core.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { HANDLERS } from '../../control-plane/agents/scripts/core/commands/moved.mjs';
import { COMMAND_NAMES, READ_ONLY_COMMANDS } from '../../control-plane/agents/scripts/core/commands/names.mjs';
import * as proc from '../../control-plane/agents/scripts/core/proc.mjs';
import { memoryIo, repo, scriptsDir } from './helpers.mjs';
import { launch } from '../lib/winpath.mjs';

const core = path.join(scriptsDir, 'proofline-core.mjs');
const LEAD_ONLY = ['terminate', 'approve', 'waive', 'handoff', 'classify', 'raise-budget', 'ledger-note', 'freeze', 'reopen', 'cleanup'];

test('every command of the table has a Node handler: nothing is left for the shell code to run (issue #173 package A moved the last nine)', () => {
  assert.deepEqual(COMMAND_NAMES.filter((c) => !Object.hasOwn(HANDLERS, c)), []);
  assert.ok(READ_ONLY_COMMANDS.every((c) => Object.hasOwn(HANDLERS, c)));
});

describe('the core entry accepts only the commands it owns', () => {
  test('a non-lead role is refused by the role gate, before anything else, and nothing is started', () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'qa']) {
      for (const cmd of LEAD_ONLY.filter((c) => !(role === 'implementer' && c === 'handoff'))) {
        proc.resetSpawnCounts();
        const m = memoryIo('/nonexistent-root', { AGENT_ROLE: role });
        assert.equal(run([cmd, 'T-1', 'x'], m.io), 1, `${role} ${cmd}`);
        assert.equal(m.stderr(), `command denied for ${role}: ${cmd}\n`);
        assert.equal(proc.spawnCounts().total, 0, `${role} ${cmd} reached the bridge`);
      }
    }
  });
  test('a name that is no command, and no command at all, are answered with the usage text (exit 2) and the lock folder, nothing started', () => {
    for (const cmd of ['nonsense', '']) {
      const dir = tempDir('pl-usage-');
      try {
        proc.resetSpawnCounts();
        const m = memoryIo(dir, {});
        assert.equal(run([cmd], m.io), 2, cmd);
        assert.match(m.stderr(), /^usage: agent\.sh <command> \[args\]/);
        assert.equal(m.stdout(), '');
        assert.equal(proc.spawnCounts().total, 0);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
  test('as a process: node proofline-core.mjs <unmoved command> exits non-zero and changes nothing', () => {
    for (const [role, cmd] of [['explorer', 'terminate'], ['implementer', 'approve'], ['explorer', 'waive'], ['implementer', 'handoff'], ['lead', 'terminate']]) {
      const r = spawnSync(process.execPath, [core, cmd, 'T-1', 'FAILED'], { env: { ...process.env, AGENT_ROLE: role }, cwd: repo, encoding: 'utf8' });
      assert.notEqual(r.status, 0, `${role} ${cmd}`);
      assert.equal(r.stdout, '');
    }
  });
  test('a moved command still runs, and the gate still allows what the shell allowed', () => {
    const r = spawnSync(process.execPath, [core, 'role'], { env: { ...process.env, AGENT_ROLE: 'explorer' }, encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(r.stdout, 'role=explorer\n');
  });
});

/** An "installed" folder holding agent.sh and, on request, the core. @param {{ manifest?: boolean, core?: boolean, coreDir?: boolean }} o */
function project(o) {
  const root = tempDir('pl-entry-');
  const s = path.join(root, '.agents', 'scripts');
  mkdirSync(s, { recursive: true });
  cpSync(path.join(scriptsDir, 'agent.sh'), path.join(s, 'agent.sh'));
  writeFileSync(path.join(root, '.agents', 'config.yaml'), 'canonical_branch: main\ngit:\n  branch_prefix: t/\n');
  if (o.manifest) writeFileSync(path.join(root, '.agents', '.proofline-manifest'), '# proofline manifest\n');
  if (o.core) cpSync(core, path.join(s, 'proofline-core.mjs'));
  if (o.coreDir) cpSync(path.join(scriptsDir, 'core'), path.join(s, 'core'), { recursive: true });
  return root;
}
/** @param {string} root @param {string[]} args @param {Record<string,string>} [env] */
const agent = (root, args, env = {}) => spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });

describe('agent.sh without the core', () => {
  // A245: agent.sh is a launcher; there is no shell arm, so a folder with neither core nor manifest gets a message and a non-zero status, not a second engine.
  test('a folder with neither core nor manifest prints that it is not an installed project and exits 127, with nothing on standard output', () => {
    const root = project({});
    try {
      for (const args of [['status'], ['role'], []]) {
        const r = agent(root, args);
        assert.equal(r.status, 127, args.join(' ')); assert.equal(r.stdout, '');
        assert.match(r.stderr, /^proofline: no control-plane core beside .*agent\.sh and no \.agents\/\.proofline-manifest: this is not an installed project \(run: proofline init\)\n$/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a run worktree starts the PROJECT\'s core, never the copy in the worktree (A207, security round 3)', () => {
    const root = project({ manifest: true, core: true, coreDir: true });
    try {
      const g = (/** @type {string[]} */ a) => spawnSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
      g(['init', '-q', '-b', 'main']);
      writeFileSync(path.join(root, '.gitignore'), '.agents/local/\n.agents/runs/\n');
      g(['add', '-A']); g(['commit', '-q', '-m', 'i']);
      const wt = path.join(root, '.agents', 'local', 'worktrees', 'T-1');
      assert.equal(g(['worktree', 'add', '-q', '-b', 'task/T-1', wt]).status, 0);
      const mark = path.join(root, 'ran-from-worktree');
      writeFileSync(path.join(wt, '.agents', 'scripts', 'proofline-core.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(mark)}, 'x');\n`);
      const r = spawnSync('sh', ['./.agents/scripts/agent.sh', 'role'], { cwd: wt, env: process.env, encoding: 'utf8' });
      assert.equal(r.stdout, 'role=lead\n', r.stderr); assert.equal(existsSync(mark), false, 'the worktree\'s own core ran');
      // the project's core is missing: the worktree does not fall back to its own copy, it fails closed
      rmSync(path.join(root, '.agents', 'scripts', 'core'), { recursive: true });
      const c = spawnSync('sh', ['./.agents/scripts/agent.sh', 'role'], { cwd: wt, env: process.env, encoding: 'utf8' });
      assert.equal(c.status, 127); assert.equal(existsSync(mark), false);
      assert.match(c.stderr, /run: proofline upgrade/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('an installed project called with no argument names "this command", not an empty command', () => {
    const root = project({ manifest: true });
    try { const r = agent(root, []); assert.equal(r.status, 127); assert.match(r.stderr, /is missing: this command runs in Node 22\.13/); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('an installed project fails closed with exit 127 and a message naming Node 22.13 and the missing file', () => {
    for (const o of [{ manifest: true }, { manifest: true, core: true }, { manifest: true, coreDir: true }]) {
      const root = project(o);
      try {
        const r = agent(root, ['hook-config']);
        assert.equal(r.status, 127, JSON.stringify(o)); assert.equal(r.stdout, '');
        assert.match(r.stderr, /proofline-core\.mjs or .*\/core\/ is missing: the command hook-config runs in Node 22\.13 or newer/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test('an installed project with both the core and core/ runs in Node; one without them fails closed with 127', () => {
    const full = project({ manifest: true, core: true, coreDir: true });
    const bare = project({ manifest: true });
    try {
      assert.equal(agent(full, ['role']).stdout, 'role=lead\n');
      const r = agent(bare, ['role']);
      assert.equal(r.status, 127);
    } finally { rmSync(full, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });
});

describe('doctor and a missing core', () => {
  test('FAIL when proofline-core.mjs or core/ is missing, and it does not claim the moved commands run in Node', () => {
    const root = tempDir('pl-doc-');
    try {
      spawnSync('git', ['init', '-q', root]);
      spawnSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i']);
      const pl = (/** @type {string[]} */ a) => { const l = launch(path.join(repo, 'bin', 'proofline'), a); return spawnSync(l.program, l.args, { cwd: root, encoding: 'utf8' }); };
      assert.equal(pl(['init', '--yes', '--runtimes', 'claude']).status, 0);
      const ok = pl(['doctor']).stdout;
      assert.match(ok, /^PASS engine: the commands run in Node/m);
      rmSync(path.join(root, '.agents', 'scripts', 'core'), { recursive: true });
      const noDir = pl(['doctor']);
      assert.match(noDir.stdout, /^FAIL engine: .*core\/ is missing/m); assert.doesNotMatch(noDir.stdout, /moved commands run in Node \(/);
      assert.notEqual(noDir.status, 0);
      cpSync(path.join(scriptsDir, 'core'), path.join(root, '.agents', 'scripts', 'core'), { recursive: true });
      rmSync(path.join(root, '.agents', 'scripts', 'proofline-core.mjs'));
      const noCore = pl(['doctor']);
      assert.match(noCore.stdout, /^FAIL engine: .*proofline-core\.mjs/m); assert.notEqual(noCore.status, 0);
      assert.equal(existsSync(path.join(root, '.agents', 'scripts', 'proofline-core.mjs')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
