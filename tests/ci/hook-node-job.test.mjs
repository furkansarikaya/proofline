// The Node hook (stage 3) is a pull request gate: the `hook-node` job of .github/workflows/ci.yml exists, is in the `checks` needs and is never skipped by
// fast mode. These assertions live here, not in fast-mode.test.mjs: a pull request that changes tests/ci/fast-mode.* runs the full suite (the fast-mode
// rule reads the base), so the fast-mode files stay exactly as on main.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');

describe('the Node hook is a pull request gate (hook-node)', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const j = (/^  hook-node:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n)/m.exec(ci) ?? [])[1] ?? '';
  test('the job exists, runs on Linux, is never skipped (no if: on the job, no fast output) and is in the checks needs', () => {
    assert.ok(j, 'job hook-node exists');
    assert.match(j, /runs-on: ubuntu-latest/);
    assert.ok(!/^    if:/m.test(j), 'the job has no job-level if');
    assert.ok(!/outputs\.fast|needs\.changes/.test(j), 'fast mode and the classifier are not read');
    assert.match(/^  checks:\n([\s\S]*)/m.exec(ci)?.[1] ?? '', /needs: \[[^\]]*\bhook-node\b/);
  });
  test('it runs the hook tests, the guard tests with GUARDS_HOOK, the wiring tests and the six shell suites with HOOK_UNDER_TEST on the .mjs hook', () => {
    assert.match(j, /HOOK_UNDER_TEST: \$\{\{ github\.workspace \}\}\/adapters\/claude\/hooks\/proofline-hook\.mjs/);
    assert.match(j, /GUARDS_HOOK: \$\{\{ github\.workspace \}\}\/adapters\/claude\/hooks\/proofline-hook\.mjs/);
    assert.match(j, /run: node --test "tests\/hook\/\*\.test\.mjs"/);
    assert.match(j, /run: node --test tests\/enforcement\/guards\.test\.mjs/);
    assert.match(j, /run: node --test tests\/enforcement\/wiring\.test\.mjs/);
    for (const s of ['enforcement-test', 'timeouts-test', 'kill-guard-test', 'merge-guard-test', 'platform-test', 'approval-load-test']) assert.match(j, new RegExp(`- suite: ${s}\\n\\s+node: '22\\.13\\.0'`), s);
    assert.match(j, /SELFTEST_ONLY: \$\{\{ matrix\.suite \}\}\n\s+run: sh tests\/selftest\.sh/);
  });
  test('the Node tests run on Node 22.13.0 and the active LTS', () => {
    assert.match(j, /- suite: node-tests\n\s+node: '22\.13\.0'/);
    assert.match(j, /- suite: node-tests\n\s+node: 'lts\/\*'/);
    assert.ok(!/\{suite:/.test(j), 'block style only: the repository YAML check rejects inline flow mappings with ": "');
  });
  test('every suite named in the matrix exists and honours HOOK_UNDER_TEST', () => {
    for (const s of ['enforcement-test', 'timeouts-test', 'kill-guard-test', 'merge-guard-test', 'platform-test', 'approval-load-test'])
      assert.match(readFileSync(join(repo, 'tests/enforcement', `${s}.sh`), 'utf8'), /HOOK_UNDER_TEST:-/, s);
  });
});

describe('the other gate jobs stay unskippable with hook-node beside them', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  /** @param {string} name */
  const job = (name) => (new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|(?![\\s\\S]))`, 'm').exec(ci) ?? [])[1] ?? '';
  test('hook-node never reads the fast output and has no bare directory argument for node --test', () => {
    assert.ok(!/outputs\.fast/.test(job('hook-node')));
    assert.ok(!/node --test tests\/[a-z]+\/(\s|$)/m.test(job('hook-node')));
  });
});
