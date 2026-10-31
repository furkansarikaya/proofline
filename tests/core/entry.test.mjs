// @ts-check
// The core's entry is not a second front door to agent.sh, and agent.sh fails closed in an installed project that lost the core.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { run } from '../../control-plane/agents/scripts/proofline-core.mjs';
import * as proc from '../../control-plane/agents/scripts/core/proc.mjs';
import { memoryIo, repo, scriptsDir } from './helpers.mjs';

const core = path.join(scriptsDir, 'proofline-core.mjs');
const LEAD_ONLY = ['terminate', 'approve', 'waive', 'handoff', 'classify', 'raise-budget', 'ledger-note', 'freeze', 'reopen', 'cleanup'];

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
  test('the lead, and a read-only command of any role, are refused too: not a command of the Node core', () => {
    for (const [role, cmd] of [['lead', 'terminate'], ['lead', 'approve'], ['lead', 'next'], ['explorer', 'next'], ['implementer', 'handoff'], ['lead', 'nonsense'], ['lead', '']]) {
      proc.resetSpawnCounts();
      const m = memoryIo('/nonexistent-root', { AGENT_ROLE: role });
      assert.equal(run([cmd, 'T-1'], m.io), 2, `${role} ${cmd}`);
      assert.match(m.stderr(), /not a command of the Node core; run it with agent\.sh/);
      assert.equal(m.stdout(), '');
      assert.equal(proc.spawnCounts().total, 0);
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
  const root = mkdtempSync(path.join(tmpdir(), 'pl-entry-'));
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
  test('a folder that is not an installed project (no manifest) runs the shell code', () => {
    const root = project({});
    try { const r = agent(root, ['role']); assert.equal(r.status, 0); assert.equal(r.stdout, 'role=lead\n'); } finally { rmSync(root, { recursive: true, force: true }); }
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
  test('an installed project with both the core and core/ runs in Node; the engine switch to sh still works without them', () => {
    const full = project({ manifest: true, core: true, coreDir: true });
    const bare = project({ manifest: true });
    try {
      assert.equal(agent(full, ['role']).stdout, 'role=lead\n');
      const r = agent(bare, ['role'], { PROOFLINE_ENGINE: 'sh' });
      assert.equal(r.status, 0); assert.equal(r.stdout, 'role=lead\n');
    } finally { rmSync(full, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
  });
});

describe('doctor and a missing core', () => {
  test('FAIL when proofline-core.mjs or core/ is missing, and it does not claim the moved commands run in Node', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pl-doc-'));
    try {
      spawnSync('git', ['init', '-q', root]);
      spawnSync('git', ['-C', root, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i']);
      const pl = (/** @type {string[]} */ a) => spawnSync('sh', [path.join(repo, 'bin', 'proofline'), ...a], { cwd: root, encoding: 'utf8' });
      assert.equal(pl(['init', '--yes', '--runtimes', 'claude']).status, 0);
      const ok = pl(['doctor']).stdout;
      assert.match(ok, /^PASS engine: the moved commands run in Node/m);
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
