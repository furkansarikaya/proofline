// @ts-check
// The bridge to the shell code prints the same $0 as the shell: agent.sh hands its own $0 to the core (--pl-argv0), the core uses it only when it
// names the core's own sibling agent.sh, and never executes anything it chose.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { splitArgv0 } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { scriptsDir } from './helpers.mjs';

const core = path.join(scriptsDir, 'proofline-core.mjs');
// a non-number status block limit is a documented fallback of `timeouts`: the shell's arithmetic error text names $0
const CONFIG = 'canonical_branch: main\ngit:\n  branch_prefix: t/\ntasks:\n  status_block_seconds: abc\n';

function project() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pl-argv0-')));
  const s = path.join(root, '.agents', 'scripts');
  mkdirSync(s, { recursive: true });
  cpSync(path.join(scriptsDir, 'agent.sh'), path.join(s, 'agent.sh'));
  cpSync(core, path.join(s, 'proofline-core.mjs'));
  cpSync(path.join(scriptsDir, 'core'), path.join(s, 'core'), { recursive: true });
  writeFileSync(path.join(root, '.agents', 'config.yaml'), CONFIG);
  return root;
}
/** @param {string} cwd @param {string} script @param {string[]} args @param {Record<string,string>} [env] */
const sh = (cwd, script, args, env = {}) => spawnSync('sh', [script, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

describe('the bridged shell prints the same $0 as the shell', () => {
  for (const [label, script] of [['relative', '.agents/scripts/agent.sh'], ['./-prefixed', './.agents/scripts/agent.sh'], ['with ..', '']]) {
    test(`${label} invocation: stdout, stderr and status equal the shell's`, () => {
      const root = project();
      try {
        const cwd = label === 'with ..' ? path.join(root, '.agents') : root;
        const typed = label === 'with ..' ? `../.agents/scripts/agent.sh` : script;
        const viaNode = sh(cwd, typed, ['timeouts']);
        const viaShell = sh(cwd, typed, ['timeouts'], { PROOFLINE_ENGINE: 'sh' });
        assert.ok(viaShell.stderr.includes(typed), `the shell's error text names $0: ${viaShell.stderr}`);
        // a typed path with a `..` segment is replaced by the verified real path of the same script: only $0 differs
        const real = path.join(realpathSync(root), '.agents', 'scripts', 'agent.sh');
        const err = label === 'with ..' ? viaShell.stderr.split(typed).join(real) : viaShell.stderr;
        assert.deepEqual({ out: viaNode.stdout, err: viaNode.stderr, code: viaNode.status }, { out: viaShell.stdout, err, code: viaShell.status });
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
  test('absolute invocation', () => {
    const root = project();
    try {
      const abs = path.join(root, '.agents', 'scripts', 'agent.sh');
      const a = sh(root, abs, ['timeouts']); const b = sh(root, abs, ['timeouts'], { PROOFLINE_ENGINE: 'sh' });
      assert.ok(b.stderr.includes(abs));
      assert.deepEqual([a.stdout, a.stderr, a.status], [b.stdout, b.stderr, b.status]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

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
      assert.deepEqual(splitArgv0(['--pl-argv0', typed, 'role'], script, root), { argv: ['role'] });
      const r = spawnSync(process.execPath, [script, '--pl-argv0', typed, 'timeouts'], { cwd: root, encoding: 'utf8' });
      assert.equal(existsSync(mark), false, 'the other script was executed');
      assert.ok(r.stderr.includes(path.join(root, '.agents', 'scripts', 'agent.sh')), r.stderr);
      // a link whose `..` really leads back to the project: accepted, but the real path is used instead of the typed one
      symlinkSync(path.join(root, '.agents'), path.join(root, 'back'));
      mkdirSync(path.join(root, 'plain'), { recursive: true });
      symlinkSync(path.join(root, 'plain'), path.join(root, 'ok'));
      const sibling = realpathSync(path.join(root, '.agents/scripts/agent.sh'));
      assert.deepEqual(splitArgv0(['--pl-argv0', 'ok/../.agents/scripts/agent.sh', 'role'], script, root), { argv: ['role'], argv0: sibling });
      assert.deepEqual(splitArgv0(['--pl-argv0', 'back/scripts/agent.sh', 'role'], script, root), { argv: ['role'], argv0: 'back/scripts/agent.sh' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('a forged --pl-argv0 is ignored: nothing it names is executed, and the bridge still answers with the absolute path', () => {
    const root = project();
    try {
      const mark = path.join(root, 'EVIL-RAN');
      writeFileSync(path.join(root, 'evil.sh'), `touch '${mark}'\n`);
      const coreCopy = path.join(root, '.agents', 'scripts', 'proofline-core.mjs');
      for (const forged of [path.join(root, 'evil.sh'), '../x', 'evil.sh', '/bin/evil']) {
        const r = spawnSync(process.execPath, [coreCopy, '--pl-argv0', forged, 'timeouts'], { cwd: root, encoding: 'utf8' });
        assert.equal(existsSync(mark), false, `${forged} was executed`);
        assert.ok(r.stderr.includes(path.join(root, '.agents', 'scripts', 'agent.sh')), `${forged}: ${r.stderr}`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test('the entry still refuses unmoved commands, with or without the argument', () => {
    for (const role of ['explorer', 'implementer']) {
      for (const args of [['terminate', 'T-1'], ['--pl-argv0', 'x', 'terminate', 'T-1'], ['--pl-argv0', 'x', 'approve', 'T-1', 'plan'], ['--pl-argv0', '.agents/scripts/agent.sh', 'waive', 'T-1']]) {
        const r = spawnSync(process.execPath, [core, ...args], { env: { ...process.env, AGENT_ROLE: role }, encoding: 'utf8' });
        assert.notEqual(r.status, 0, `${role} ${args.join(' ')}`);
        assert.match(r.stderr, /command denied for/);
      }
    }
    const lead = spawnSync(process.execPath, [core, '--pl-argv0', 'x', 'terminate', 'T-1'], { encoding: 'utf8' });
    assert.equal(lead.status, 2); assert.match(lead.stderr, /not a command of the Node core/);
  });
});
