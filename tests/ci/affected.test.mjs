// @ts-check
// Tests tests/affected.mjs selection (A164): unmapped changes never skip, mapped changes select only their suites.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { allUnits, globToRegExp, main, select } from '../affected.mjs';

const root = path.resolve(import.meta.dirname, '../..');
/** @param {string[]} args @param {Record<string, string>} [env] */
function list(args, env = {}) { let out = ''; const status = main(['--list', ...args], { root, env: { ...process.env, ...env }, write: (s) => { out += s; } }); return { status, lines: out.split('\n').filter(Boolean) }; }
const total = list(['--all']).lines.length;

test('a mapped script selects only its units', () => {
  assert.deepEqual(list(['tests/ci/classify.mjs']).lines, ['tests/ci/affected.test.mjs', 'tests/ci/change-reason.test.mjs', 'tests/ci/classify.test.mjs']);
});
test('a change not in the mapping selects every unit', () => {
  const got = list(['some/unmapped/file.txt']).lines.length;
  assert.ok(got === total && total > 1, `selected ${got} of ${total}`);
});
test('a shared file selects every unit', () => assert.equal(list(['tests/selftest.mjs']).lines.length, total));
test('--all selects everything even with a mapped file', () => assert.equal(list(['--all', 'tests/ci/classify.mjs']).lines.length, total));
test('--all includes the node test files outside tests/skills, and the shell suites', () => {
  const all = list(['--all']).lines;
  assert.ok(all.includes('tests/benchmark/benchmark.test.mjs'));
  assert.ok(all.some((u) => u.endsWith('-test.sh')));
  assert.deepEqual(all, allUnits(root), 'sorted in byte order, once each');
});
test('a mapped unit that does not exist selects every unit (fail safe)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'affected-map-')); after(() => rmSync(dir, { recursive: true, force: true }));
  const map = path.join(dir, 'map.txt'); writeFileSync(map, 'some/path.txt no-such-suite\n');
  assert.equal(list(['some/path.txt'], { AFFECTED_MAP: map }).lines.length, total);
});
test('documentation only selects just the front matter test', () => assert.deepEqual(list(['README.md']).lines, ['tests/skills/frontmatter.test.mjs']));
test('a changed test file selects itself; a deleted one selects nothing; an existing non-unit test file selects everything', () => {
  assert.deepEqual(list(['tests/ci/classify.test.mjs']).lines, ['tests/ci/classify.test.mjs']);
  assert.deepEqual(list(['tests/ci/no-such-thing-test.sh']).lines, []);
  assert.equal(list(['tests/ci/no-such-thing-test.sh']).status, 0);
  const units = ['tests/a/x-test.sh'];
  assert.deepEqual(select({ files: ['tests/a/new-test.sh'], units, mapText: '', exists: () => true }), units);
});
test('map globs follow the shell case rules: * crosses a slash, ? is one character, [..] a set', () => {
  assert.ok(globToRegExp('skills/ui-design/library/*').test('skills/ui-design/library/a/b.json'));
  assert.ok(globToRegExp('a/?.txt').test('a/x.txt')); assert.ok(!globToRegExp('a/?.txt').test('a/xy.txt'));
  assert.ok(globToRegExp('a/[xy].txt').test('a/y.txt')); assert.ok(!globToRegExp('a/[!xy].txt').test('a/y.txt'));
  assert.ok(!globToRegExp('a.b').test('aXb'), 'the dot is literal');
});
test('the lines of the map select by unit name; comments and blank lines are skipped; several files union', () => {
  const units = ['tests/a/one-test.sh', 'tests/b/two.test.mjs', 'tests/c/three-test.sh'];
  const mapText = '# comment\n\nsrc/a/* one-test\nsrc/b/* two.test.mjs three-test\n';
  assert.deepEqual(select({ files: ['src/a/x'], units, mapText }), ['tests/a/one-test.sh']);
  assert.deepEqual(select({ files: ['src/a/x', 'src/b/y'], units, mapText }), ['tests/a/one-test.sh', 'tests/b/two.test.mjs', 'tests/c/three-test.sh']);
  assert.deepEqual(select({ files: ['src/a/x', 'elsewhere'], units, mapText }), units);
});
test('an unknown option is refused (exit 2); stdin paths with "-"', () => {
  assert.equal(main(['--bogus'], { root, write: () => {} }), 2);
  let out = '';
  main(['--list', '-'], { root, stdin: () => 'tests/ci/classify.mjs\n', write: (s) => { out += s; } });
  assert.equal(out, 'tests/ci/affected.test.mjs\ntests/ci/change-reason.test.mjs\ntests/ci/classify.test.mjs\n');
});
