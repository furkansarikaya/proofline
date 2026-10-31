// @ts-check
// The "Node absent" case (ADR 0001 section 6, input 4; C2): with `node` removed from PATH and a run open, a moved command exits non-zero (it must not
// silently succeed with empty settings) and a commit is blocked. The expected result is not equality but the safe side. Hook assertions (database
// guard, merge guard) belong to package GUARDS. Skipped only while proofline-core.mjs is absent: the 0.0.40 shell needs no Node, which is the very
// fall-back this test exists to forbid.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentsSrc, baseEnv, copyTree, coreAbsent, pathWithoutNode, run, scaffoldFixture, SKIP_NO_CORE } from './fixture.mjs';

const MOVED_READERS = [['role'], ['config-get', 'profile'], ['config-check'], ['timeouts'], ['hook-timeouts'], ['verify-timeout'], ['tm-scaled', '10'], ['db-config'], ['hook-config'], ['help']];

test('the PATH helper really hides node', () => {
  const np = pathWithoutNode();
  assert.notEqual(run('sh', ['-c', 'command -v node'], { env: { PATH: np.path } }).code, 0);
  assert.equal(run('sh', ['-c', 'command -v sh'], { env: { PATH: np.path } }).code, 0);
  np.cleanup();
});

test('node absent, run open: every moved command exits non-zero, unmoved commands still run, a commit is blocked', { skip: coreAbsent() ? SKIP_NO_CORE : false, timeout: 300000 }, () => {
  const base = mkdtempSync(join(tmpdir(), 'eq-absent.')); const fx = join(base, 'fx'); copyTree(scaffoldFixture().dir, fx);
  const np = pathWithoutNode();
  const env = baseEnv(base, { PATH: np.path }); const withNode = baseEnv(base);
  const A = (/** @type {Record<string,string>} */ e, /** @type {string[]} */ args) => run('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: fx, env: e });
  assert.equal(A(withNode, ['open-runs']).code, 0); assert.match(A(withNode, ['open-runs']).stdout, /^LC /m, 'a run is open');
  for (const args of MOVED_READERS) {
    assert.equal(A(withNode, args).code === 0 || args[0] === 'help' || args[0] === 'config-get', true, `${args} works with node`);
    const r = A(env, args);
    assert.notEqual(r.code, 0, `agent.sh ${args.join(' ')} must not succeed without node (got ${r.code}: ${r.stdout}${r.stderr})`);
  }
  assert.equal(A(env, ['open-runs']).code, 0, 'an unmoved command does not need node');
  // a commit while the run is open: the git hook blocks (also when the hook itself cannot read the settings)
  cpSync(join(agentsSrc, 'githooks'), join(fx, '.agents/githooks'), { recursive: true });
  run('git', ['config', 'core.hooksPath', '.agents/githooks'], { cwd: fx, env }); run('git', ['config', 'commit.gpgsign', 'false'], { cwd: fx, env });
  writeFileSync(join(fx, 'new.txt'), 'x\n'); run('git', ['add', 'new.txt'], { cwd: fx, env });
  const c = run('git', ['commit', '-qm', 'blocked while node is absent'], { cwd: fx, env });
  assert.notEqual(c.code, 0, `the commit went through: ${c.stdout}${c.stderr}`); assert.match(c.stderr, /proofline pre-commit: BLOCKED/);
  np.cleanup(); rmSync(base, { recursive: true, force: true });
});
