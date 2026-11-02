// The equivalence rig runs as parallel legs: `equivalence` (Linux, pull requests and the nightly) and `equivalence-macos` (nightly and manual runs only; before
// the split a serial macOS leg took 2 h 7 min). These tests read .github/workflows/ci.yml: every tests/equivalence/*.test.mjs file is in exactly one leg of each
// job, both jobs feed `checks`, neither is skipped by fast mode, no pull request run starts a macOS runner.
// They live here, not in fast-mode.test.mjs: a pull request that changes tests/ci/fast-mode.* runs the full legacy suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
/** @param {string} name */
const jobText = (name) => (new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, 'm').exec(ci) ?? [])[1] ?? '';
/** @param {string} j @returns {{ name: string, files: string, scenario: string }[]} */
const legsOf = (j) => [...j.matchAll(/^ {10}- name: (\S+)\n {12}files: (.+)\n(?: {12}scenario: (\S+)\n)?/gm)].map((m) => ({ name: m[1], files: m[2].trim(), scenario: m[3] ?? '' }));
const lin = jobText('equivalence');
const mac = jobText('equivalence-macos');
const linLegs = legsOf(lin);
const macLegs = legsOf(mac);
const testFiles = readdirSync(join(repo, 'tests/equivalence')).filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/equivalence/${f}`);

for (const [label, j, legs] of /** @type {[string, string, typeof linLegs][]} */ ([['equivalence (Linux)', lin, linLegs], ['equivalence-macos', mac, macLegs]])) {
  test(`${label}: a matrix of uniquely named legs in block style`, () => {
    assert.ok(legs.length >= 10, `${legs.length} legs`);
    assert.equal(new Set(legs.map((l) => l.name)).size, legs.length, 'leg names are unique');
    assert.ok(!/\{name:|\{suite:/.test(j), 'no inline flow mappings (the repository YAML check rejects them)');
    assert.match(j, /name: equivalence(-macos)? \(\$\{\{ matrix\.leg\.name \}\}\)/);
    assert.ok(!/outputs\.fast/.test(j), 'never skipped by fast mode');
    assert.match(j, /actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/, 'full history (downgrade needs bc072f3)');
  });
  test(`${label}: every tests/equivalence/*.test.mjs file is in exactly one leg`, () => {
    const count = new Map(testFiles.map((f) => [f, 0]));
    for (const l of legs) for (const f of l.files.split(/\s+/)) if (f.endsWith('.test.mjs')) {
      assert.ok(count.has(f), `${l.name}: ${f} does not exist`);
      count.set(f, (count.get(f) ?? 0) + 1);
    }
    for (const [f, n] of count) assert.equal(n, 1, `${f} is in ${n} legs`);
  });
}

test('checks waits for both jobs by their stable names', () => {
  const needs = /needs: \[([^\]]*)\]/.exec(ci.slice(ci.indexOf('\n  checks:')))?.[1] ?? '';
  for (const n of ['equivalence', 'equivalence-macos']) assert.match(needs, new RegExp(`\\b${n}\\b`), n);
});
test('the Linux job keeps the code gate and is the one pull requests run; the long files and tests have legs of their own', () => {
  assert.match(lin, /\n    if: needs\.changes\.outputs\.code == 'true'\n/);
  assert.match(lin, /runs-on: ubuntu-latest/);
  for (let i = 1; i <= 8; i++) assert.ok(linLegs.some((l) => l.name === `states-${i}` && l.files.includes(`stage2-cases-${i}.test.mjs`) && l.files.includes(`stage2-trace-${i}.test.mjs`)), `states-${i}`);
  for (const [n, f] of [['lifecycle', 'lifecycle.test.mjs'], ['downgrade', 'downgrade.test.mjs']]) assert.equal(linLegs.find((l) => l.name === n)?.files, `tests/equivalence/${f}`);
});
test('the whole-set serial run is an opt-in repository variable, never the default', () => {
  assert.ok(linLegs.some((l) => l.name === 'full-serial' && l.files === 'all'));
  assert.match(lin, /if: vars\.EQUIVALENCE_SERIAL == '1' && matrix\.leg\.files == 'all'\n\s+run: node --test "tests\/equivalence\/\*\.test\.mjs"/);
  assert.match(lin, /EQUIVALENCE_FULL: \$\{\{ \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && '1' \|\| '' \}\}/);
});
test('equivalence-macos: nightly and manual only, EQUIVALENCE_FULL=1, one file per leg for the long case and trace files', () => {
  assert.match(mac, /\n    if: needs\.changes\.outputs\.code == 'true' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)\n/);
  assert.match(mac, /runs-on: macos-latest/);
  assert.match(mac, /EQUIVALENCE_FULL: '1'/);
  for (let i = 1; i <= 8; i++) {
    assert.equal(macLegs.find((l) => l.name === `cases-${i}`)?.files, `tests/equivalence/stage2-cases-${i}.test.mjs`);
    assert.equal(macLegs.find((l) => l.name === `trace-${i}`)?.files, `tests/equivalence/stage2-trace-${i}.test.mjs`);
  }
});
test('no pull request run starts a macOS runner: every job that names macos-latest is gated to the schedule and manual runs', () => {
  const jobs = [...ci.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|^  #|(?![\s\S]))/gm)];
  let seen = 0;
  for (const [, name, text] of jobs) {
    if (!/macos-latest/.test(text)) continue;
    seen++;
    const gated = /\n    if: [^\n]*(schedule|workflow_dispatch)/.test(text) || /os: \$\{\{ fromJSON\(\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && '\[[^']*macos-latest[^']*\]' \|\| '\["ubuntu-latest"\]'\) \}\}/.test(text);
    assert.ok(gated, `${name} names macos-latest without a schedule/workflow_dispatch gate`);
  }
  assert.ok(seen >= 2, `${seen} jobs name macOS`);
});
