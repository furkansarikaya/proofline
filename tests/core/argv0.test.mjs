// @ts-check
// agent.sh hands its own $0 to the core (--pl-argv0); the core uses it only when it names the core's own sibling agent.sh (or a run worktree's), and never
// executes anything it chose.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { splitArgv0 } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { scriptsDir } from './helpers.mjs';
import { posix } from '../lib/winpath.mjs';

const core = path.join(scriptsDir, 'proofline-core.mjs');
const CONFIG = 'canonical_branch: main\ngit:\n  branch_prefix: t/\ntasks:\n  status_block_seconds: abc\n';

function project() {
  const root = realpathSync(tempDir('pl-argv0-'));
  const s = path.join(root, '.agents', 'scripts');
  mkdirSync(s, { recursive: true });
  cpSync(path.join(scriptsDir, 'agent.sh'), path.join(s, 'agent.sh'));
  cpSync(core, path.join(s, 'proofline-core.mjs'));
  cpSync(path.join(scriptsDir, 'core'), path.join(s, 'core'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'config.yaml'), CONFIG);
  return root;
}

describe('--pl-argv0 is checked, never trusted', () => {
  test('splitArgv0 keeps a typed $0 only when it names the sibling agent.sh', () => {
    const root = project();
    try {
      const script = path.join(root, '.agents', 'scripts', 'proofline-core.mjs');
      assert.deepEqual(splitArgv0(['--pl-argv0', './.agents/scripts/agent.sh', 'role'], script, root), { argv: ['role'], argv0: './.agents/scripts/agent.sh' });
      assert.deepEqual(splitArgv0(['--pl-argv0', path.join(root, '.agents/scripts/agent.sh'), 'role'], script, root), { argv: ['role'], argv0: path.join(root, '.agents/scripts/agent.sh') });
      for (const bad of ['/bin/evil', '../x', '', '-c', '/bin/sh', '.agents/config.yaml', 'nonexistent.sh']) assert.deepEqual(splitArgv0(['--pl-argv0', bad, 'role'], script, root), { argv: ['role'] }, bad);
      assert.deepEqual(splitArgv0(['role'], script, root), { argv: ['role'] });
      assert.deepEqual(splitArgv0(['--pl-argv0'], script, root), { argv: ['--pl-argv0'] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a `..` behind a symbolic link is resolved physically, as sh does: the textual fold cannot pass the check', () => {
    const root = project();
    try {
      const script = path.join(root, '.agents', 'scripts', 'proofline-core.mjs');
      // foo -> other/sub, so foo/.. is other (physical), while a textual fold of foo/.. is the project root
      const other = path.join(root, 'other');
      mkdirSync(path.join(other, 'sub'), { recursive: true });
      mkdirSync(path.join(other, '.agents', 'scripts'), { recursive: true });
      const mark = path.join(root, 'EVIL-RAN');
      writeFileSync(path.join(other, '.agents', 'scripts', 'agent.sh'), `touch '${mark}'\n`);
      symlinkSync(path.join(other, 'sub'), path.join(root, 'foo'));
      const typed = 'foo/../.agents/scripts/agent.sh';
      assert.equal(realpathSync(path.resolve(root, typed)), realpathSync(path.join(root, '.agents/scripts/agent.sh')), 'the textual fold would name the sibling');
      // Windows folds `..` in the text before it touches the file system (no physical `..`): the typed name IS the project's own script there, so it is accepted, as its real path
      const own = posix(realpathSync.native(path.join(root, '.agents/scripts/agent.sh')));
      assert.deepEqual(splitArgv0(['--pl-argv0', typed, 'role'], script, root), process.platform === 'win32' ? { argv: ['role'], argv0: own } : { argv: ['role'] });
      const r = spawnSync(process.execPath, [script, '--pl-argv0', typed, 'timeouts'], { cwd: root, encoding: 'utf8' });
      assert.equal(existsSync(mark), false, 'the other script was executed');
      assert.equal(typeof r.status, 'number');
      // a link whose `..` really leads back to the project: accepted, but the real path is used instead of the typed one
      symlinkSync(path.join(root, '.agents'), path.join(root, 'back'));
      mkdirSync(path.join(root, 'plain'), { recursive: true });
      symlinkSync(path.join(root, 'plain'), path.join(root, 'ok'));
      const sibling = realpathSync(path.join(root, '.agents/scripts/agent.sh'));
      assert.deepEqual(splitArgv0(['--pl-argv0', 'ok/../.agents/scripts/agent.sh', 'role'], script, root), { argv: ['role'], argv0: posix(sibling) });
      assert.deepEqual(splitArgv0(['--pl-argv0', 'back/scripts/agent.sh', 'role'], script, root), { argv: ['role'], argv0: 'back/scripts/agent.sh' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a forged --pl-argv0 is ignored: nothing it names is executed, and the command still runs', () => {
    const root = project();
    try {
      const mark = path.join(root, 'EVIL-RAN');
      writeFileSync(path.join(root, 'evil.sh'), `touch '${mark}'\n`);
      const coreCopy = path.join(root, '.agents', 'scripts', 'proofline-core.mjs');
      for (const forged of [path.join(root, 'evil.sh'), '../x', 'evil.sh', '/bin/evil']) {
        const r = spawnSync(process.execPath, [coreCopy, '--pl-argv0', forged, 'timeouts'], { cwd: root, encoding: 'utf8' });
        assert.equal(existsSync(mark), false, `${forged} was executed`);
        assert.equal(typeof r.status, 'number');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('the entry still refuses a role that may not run the command, with or without the argument', () => {
    for (const role of ['explorer', 'implementer']) {
      for (const args of [['wait-line', 'T-1', 'a wait'], ['--pl-argv0', 'x', 'wait-line', 'T-1', 'a wait'], ['--pl-argv0', 'x', 'approve', 'T-1', 'plan'], ['--pl-argv0', '.agents/scripts/agent.sh', 'friction', 'T-1']]) {
        const r = spawnSync(process.execPath, [core, ...args], { env: { ...process.env, AGENT_ROLE: role }, encoding: 'utf8' });
        assert.notEqual(r.status, 0, `${role} ${args.join(' ')}`);
        assert.match(r.stderr, /command denied for/);
      }
    }
  });
});
