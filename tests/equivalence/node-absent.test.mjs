// @ts-check
// The "Node absent" case (ADR 0001 section 6, input 4; C2): with `node` removed from PATH and a run open, a moved command exits non-zero (it must not
// silently succeed with empty settings) and a commit is blocked. The expected result is not equality but the safe side. Hook assertions (database
// guard, merge guard) belong to package GUARDS. Skipped only while proofline-core.mjs is absent: the 0.0.40 shell needs no Node, which is the very
// fall-back this test exists to forbid.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { scriptsSrc, agentsSrc, baseEnv, copyTree, coreAbsent, pathWithoutNode, run, scaffoldFixture, SKIP_NO_CORE } from './fixture.mjs';

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
  // Derived from the preamble of agent.sh (the case list that delegates to Node) and from the read-only list, so it cannot rot as commands move:
  // every moved command that succeeds with node must fail without it, and an unmoved read-only command that succeeds with node must still succeed.
  const agentText = readFileSync(join(scriptsSrc, 'agent.sh'), 'utf8');
  const pre = /case "\$\{1:-\}" in\n([\s\S]*?)\)\n\s+pl_sh=no/.exec(agentText)?.[1] ?? '';
  const movedAll = pre.replace(/\\\n/g, '').split('|').map((x) => x.trim()).filter(Boolean);
  assert.ok(movedAll.length >= 10 && movedAll.includes('role') && movedAll.includes('next'), `the preamble list was not found (${movedAll.length})`);
  const readOnly = (/^read_only_commands='([^']*)'/m.exec(agentText)?.[1] ?? '').split(' ').filter(Boolean);
  // The preamble leaves a moved command whose mandatory argument is missing to the shell, which prints its own usage text (pl_need2 / pl_need3, the
  // dispatch's `${N:?usage}`); the status of that text depends on the platform's sh (macOS bash in POSIX mode: 0, dash: 2), so the shape says nothing about
  // node. Two checks: (1) a call WITH its mandatory arguments reaches the Node path, so without node it must not succeed; (2) the argument-less shape is
  // handled by the shell alone, identically with and without node.
  const need = (/** @type {string} */ name) => new Set((new RegExp(`${name}='([^']*)'`).exec(agentText)?.[1] ?? '').split(' ').filter(Boolean));
  const need2 = need('pl_need2'); const need3 = need('pl_need3');
  assert.ok(need2.size > 10 && need3.has('request-approval'), 'the mandatory-argument tables were not found');
  const FILLERS = /** @type {Record<string,string[]>} */ ({ 'config-get': ['profile'], 'tm-scaled': ['10'], 'design-surface': ['src/a.txt'], 'in-knowledge-scope': ['docs/a.md'], 'worktree-root': ['/nonexistent'], 'entry-tier': ['a contract bullet'],
    'plan-section': ['LC', 'Architecture'], 'request-approval': ['LC', 'push'], answer: ['LC', '1'] });
  const valid = (/** @type {string} */ c) => [c, ...(FILLERS[c] ?? (need2.has(c) || need3.has(c) ? ['LC'] : []))];
  let movedChecked = 0;
  for (const c of movedAll) {
    const args = valid(c); const withN = A(withNode, args);
    const r = A(env, args);
    assert.notEqual(r.code, 0, `moved command ${args.join(' ')} succeeded without node (${r.stdout}${r.stderr})`);
    if (withN.code === 0) movedChecked++;
    if (need2.has(c) || need3.has(c)) {
      const bare = A(withNode, [c]); const bareNoNode = A(env, [c]);
      assert.equal(bareNoNode.code, bare.code, `${c} without its argument is the shell's usage text, with or without node`);
      assert.equal(bareNoNode.stderr, bare.stderr, `${c} without its argument: the same usage text`);
    }
  }
  assert.ok(movedChecked >= 5, `only ${movedChecked} moved commands succeeded with their arguments`);
  const unmoved = readOnly.filter((c) => !movedAll.includes(c));
  const works = unmoved.filter((c) => A(withNode, [c]).code === 0);
  assert.ok(works.length > 0, `no unmoved read-only command succeeds with node (unmoved: ${unmoved.join(' ')})`);
  for (const c of works) assert.equal(A(env, [c]).code, 0, `the unmoved command ${c} does not need node`);
  // a commit while the run is open: the git hook blocks (also when the hook itself cannot read the settings)
  cpSync(join(agentsSrc, 'githooks'), join(fx, '.agents/githooks'), { recursive: true });
  run('git', ['config', 'core.hooksPath', '.agents/githooks'], { cwd: fx, env }); run('git', ['config', 'commit.gpgsign', 'false'], { cwd: fx, env });
  writeFileSync(join(fx, 'new.txt'), 'x\n'); run('git', ['add', 'new.txt'], { cwd: fx, env });
  const c = run('git', ['commit', '-qm', 'blocked while node is absent'], { cwd: fx, env });
  assert.notEqual(c.code, 0, `the commit went through: ${c.stdout}${c.stderr}`); assert.match(c.stderr, /not found|BLOCKED/, 'the launcher cannot start node: git blocks the commit');
  np.cleanup(); rmSync(base, { recursive: true, force: true });
});
