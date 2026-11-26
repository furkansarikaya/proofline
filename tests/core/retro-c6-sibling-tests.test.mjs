// @ts-check
// C6 (issue 338, A362): `## Sibling tests` of PLAN.md lists existing tests that assert the opposite of the planned output (or pin the old output).
// Their paths are put in the scope list at freeze by the control plane, and they do not count toward the code-path limit (max_scope_paths).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { scopeMappings, siblingTestPaths } from '../../control-plane/agents/scripts/core/records.mjs';
import { A, accepted, commitAll, rv, warmDefaultTemplate } from '../lib/harness.mjs';
import { Z, rebase, rrun, wr } from './risk-s1-lib.mjs';

before(() => { warmDefaultTemplate(); });

const PLAN = (/** @type {string} */ sib) => ['---', 'scope:', '  - path: src/a.js', '    criteria: [AC-1]', '---', '# Plan', '', '## Behavior', '', '- AC-1: x', '', sib].join('\n');

test('c6_parse: the section lists backticked paths; none, prose and a path already in scope add nothing; the plan scope gets the rest', () => {
  const t = PLAN('## Sibling tests\n\n- `tests/old_a.test.js`: asserts the old output\n- `tests/old_b.test.js`\n- `src/a.js`\n- see the grep in EVIDENCE.md\n\n## Risk\n\n- `tests/not_here.test.js`\n');
  assert.deepEqual(siblingTestPaths(t), ['tests/old_a.test.js', 'tests/old_b.test.js', 'src/a.js']);
  const sc = scopeMappings(t);
  assert.equal(sc.ok, true);
  assert.deepEqual(sc.rows.map(([p]) => p), ['src/a.js', 'tests/old_a.test.js', 'tests/old_b.test.js']);
  assert.deepEqual(siblingTestPaths(PLAN('## Sibling tests\n\nnone\n')), []);
  assert.deepEqual(scopeMappings(PLAN('')).rows.map(([p]) => p), ['src/a.js']);
});

test('c6_freeze: sibling tests are in the frozen scope and are not counted by max_scope_paths', () => {
  const d = rrun('STANDARD', '', '\n## Sibling tests\n\n- `old_a.test.txt`: asserts the old output\n- `old_b.test.txt`: pins the old output\n');
  wr(d, 'old_a.test.txt', 'a\n'); wr(d, 'old_b.test.txt', 'b\n');
  const cfg = path.join(d, '.agents/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^( {4}max_scope_paths:) 15$/m, '$1 2'));
  commitAll(d, 'siblings'); rebase(d);
  accepted(A(d, ['classify', 'LC', 'STANDARD', 'review']), 'classify');
  accepted(Z(d, ['freeze', 'LC']), 'freeze with two code paths and two sibling tests under a limit of two');
  const frozen = rv(d, 'freeze', 'scope_paths');
  for (const p of ['impl.txt', 'impl_test.txt', 'old_a.test.txt', 'old_b.test.txt']) assert.ok(frozen.split(',').includes(p), `${p} is not in the frozen scope: ${frozen}`);
});
