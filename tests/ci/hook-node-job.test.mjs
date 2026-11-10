// The Node hook (stage 3) is a pull request gate: the `hook-node` job of .github/workflows/ci.yml exists, is in the `checks` needs and is never skipped by
// the documentation classifier (A246 ended the fast mode).
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
  test('it runs the hook tests, the guard tests with GUARDS_HOOK, and the wiring tests with HOOK_UNDER_TEST on the .mjs hook', () => {
    assert.match(j, /HOOK_UNDER_TEST: \$\{\{ github\.workspace \}\}\/adapters\/claude\/hooks\/proofline-hook\.mjs/);
    assert.match(j, /GUARDS_HOOK: \$\{\{ github\.workspace \}\}\/adapters\/claude\/hooks\/proofline-hook\.mjs/);
    assert.match(j, /run: node --test "tests\/hook\/\*\.test\.mjs"/);
    assert.match(j, /run: node --test tests\/enforcement\/guards\.test\.mjs/);
    assert.match(j, /run: node --test tests\/enforcement\/wiring\.test\.mjs/);
    assert.ok(!/SELFTEST_ONLY|selftest/.test(j), 'no shell suite runs here any more (A239)');
  });
  test('the Node tests run on Node 22.13.0 and the active LTS', () => {
    assert.match(j, /- suite: node-tests\n\s+node: '22\.13\.0'/);
    assert.match(j, /- suite: node-tests\n\s+node: 'lts\/\*'/);
    assert.ok(!/\{suite:/.test(j), 'block style only: the repository YAML check rejects inline flow mappings with ": "');
  });
  test('the enforcement suites that ran here as shell suites are node-tests legs and honour HOOK_UNDER_TEST', () => {
    const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
    for (const f of ['enforcement-a1', 'enforcement-a2', 'enforcement-b', 'platform', 'merge-guard', 'timeouts', 'approval-load']) assert.ok(ci.includes(`tests/enforcement/${f}.test.mjs`), f);
    assert.match(readFileSync(join(repo, 'tests/enforcement/lib.mjs'), 'utf8'), /process\.env\.HOOK_UNDER_TEST/);
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
