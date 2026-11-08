// @ts-check
// Tests tests/ci/classify.mjs: which pull requests may skip the heavy CI jobs (A76).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { classify } from './classify.mjs';

const CASES = /** @type {Array<[boolean, string[]]>} */ ([
  [false, ['README.md']],
  [false, ['CHANGELOG.md', 'CONTRIBUTING.md', 'docs/decisions.md', 'docs/concepts/enforcement-layers.md']],
  [false, ['docs/concepts/diagram.svg', 'docs/img/flow.png']],
  [true, ['docs/tools/run.py']],
  [true, ['docs/data.json']],
  [true, ['docs/concepts/notes.txt']],
  [true, ['docs/Makefile']],
  [true, ['skills/proof-review/SKILL.md']],
  [true, ['roles/lead.md']],
  [true, ['control-plane/agents/GATES.md']],
  [true, ['adapters/claude/README.md']],
  [true, ['docs/reference/skills.md']],
  [true, ['docs/reference/generate-skills.mjs']],
  [true, ['docs/decisions.md', 'tests/selftest.mjs']],
  [true, ['.github/workflows/ci.yml']],
  [true, ['README.md', 'fixtures/api-design/setup.sh']],
  [true, ['tests/e2e/README.md']],
  [false, ['SECURITY.md', 'LICENSE']],
  [true, ['docs/a.mjs', 'README.md']],
  [true, ['README.md', 'src/x.cjs']],
  [true, ['README.md', 'x/y.yaml']],
  [false, ['docs/sub/dir/deep.md']],
]);
for (const [want, paths] of CASES) test(`${paths.join(' ')} -> code=${want}`, () => assert.equal(classify(paths), `code=${want}`));

test('an empty list, or only blank lines, is code=true', () => {
  assert.equal(classify([]), 'code=true');
  assert.equal(classify(['', '']), 'code=true');
});
test('blank lines between documentation paths are ignored', () => assert.equal(classify(['README.md', '', 'CHANGELOG.md']), 'code=false'));
test('the command reads paths from stdin and prints the classification', () => {
  const run = (/** @type {string} */ input) => spawnSync(process.execPath, [path.join(import.meta.dirname, 'classify.mjs')], { input, encoding: 'utf8' });
  assert.equal(run('README.md\ndocs/a.md\n').stdout, 'code=false\n');
  assert.equal(run('README.md\nsrc/a.mjs\n').stdout, 'code=true\n');
  assert.equal(run('').stdout, 'code=true\n');
});
