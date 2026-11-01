// The `equivalence` job is a matrix of parallel legs (user order 2026-11-02: three-hour tests are not realistic). These tests read .github/workflows/ci.yml:
// every tests/equivalence/*.test.mjs file is in exactly one leg, the job stays in `checks` and is never skipped by fast mode, the full macOS replay and the
// shell-engine invariants have their own legs, and the node-tests globs that name the legs' directories stay valid. They live here, not in fast-mode.test.mjs:
// a pull request that changes tests/ci/fast-mode.* runs the full legacy suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
const job = (/^  equivalence:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n)/m.exec(ci) ?? [])[1] ?? '';
/** @type {{ name: string, files: string }[]} */
const legs = [...job.matchAll(/^ {10}- name: (\S+)\n {12}files: (.+)$/gm)].map((m) => ({ name: m[1], files: m[2].trim() }));

test('the job is a matrix of named legs in block style, with a stable aggregate name', () => {
  assert.ok(legs.length >= 10, `${legs.length} legs`);
  assert.equal(new Set(legs.map((l) => l.name)).size, legs.length, 'leg names are unique');
  assert.ok(!/\{name:|\{suite:/.test(job), 'no inline flow mappings (the repository YAML check rejects them)');
  assert.match(job, /name: equivalence \(\$\{\{ matrix\.os \}\}, \$\{\{ matrix\.leg\.name \}\}\)/);
  assert.match(ci.slice(ci.indexOf('\n  checks:')), /needs: \[[^\]]*\bequivalence\b/, 'checks keeps needing the matrix job');
});
test('every tests/equivalence/*.test.mjs file is in exactly one leg', () => {
  const files = readdirSync(join(repo, 'tests/equivalence')).filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/equivalence/${f}`);
  const count = new Map(files.map((f) => [f, 0]));
  for (const l of legs) for (const f of l.files.split(/\s+/)) if (f.endsWith('.test.mjs')) {
    assert.ok(count.has(f), `${l.name}: ${f} does not exist`);
    count.set(f, (count.get(f) ?? 0) + 1);
  }
  for (const [f, n] of count) assert.equal(n, 1, `${f} is in ${n} legs`);
});
test('the state files are paired by number and the long single tests have a leg of their own', () => {
  for (let i = 1; i <= 8; i++) assert.ok(legs.some((l) => l.name === `states-${i}` && l.files.includes(`stage2-cases-${i}.test.mjs`) && l.files.includes(`stage2-trace-${i}.test.mjs`)), `states-${i}`);
  for (const [n, f] of [['lifecycle', 'lifecycle.test.mjs'], ['downgrade', 'downgrade.test.mjs']]) assert.deepEqual(legs.find((l) => l.name === n)?.files, `tests/equivalence/${f}`);
});
test('never skipped by fast mode: no job-level skip, no fast output, no classifier needed beyond the code gate', () => {
  assert.ok(!/outputs\.fast/.test(job));
  assert.match(job, /\n    if: needs\.changes\.outputs\.code == 'true'\n/);
});
test('full history, the whole macOS set on one runner, and the invariants on the shell engine in their own leg', () => {
  assert.match(job, /actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
  assert.ok(legs.some((l) => l.name === 'full-macos' && l.files === 'all'));
  assert.match(job, /if: matrix\.os == 'macos-latest' && matrix\.leg\.files == 'all'\n\s+run: node --test "tests\/equivalence\/\*\.test\.mjs"/);
  assert.equal(legs.filter((l) => /^invariants-sh-\d$/.test(l.name) && l.files === 'none').length, 8, 'one invariants-sh leg per scenario');
  assert.match(job, /if: matrix\.os == 'ubuntu-latest' && matrix\.leg\.files == 'none'\n\s+env:\n\s+LC_EXACT: \$\{\{ matrix\.leg\.scenario \}\}\n\s+PROOFLINE_ENGINE: sh\n\s+run: sh tests\/invariants\/invariants-test\.sh/);
  const scen = [...readFileSync(join(repo, 'tests/invariants/invariants-test.sh'), 'utf8').matchAll(/^run_sc (sc_\S+)$/gm)].map((m) => m[1]);
  const inJob = [...job.matchAll(/ scenario: (sc_\S+)/g)].map((m) => m[1]);
  assert.deepEqual(inJob.sort(), scen.sort(), 'the invariants-sh legs are exactly the scenarios of the suite');
  assert.match(job, /EQUIVALENCE_FULL: \$\{\{ \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && '1' \|\| '' \}\}/);
});
test('the leg steps run files explicitly, never a bare directory', () => {
  assert.match(job, /run: node --test \$\{\{ matrix\.leg\.files \}\}/);
  assert.ok(!/node --test tests\/[a-z]+\/(\s|$)/m.test(job));
});
