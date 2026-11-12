// @ts-check
// tests/ci/windows-probe.mjs (A260, Windows port W1): the `tests` input of the manual Windows probe is checked as data (a pure function), selects the files of each leg, and the leg
// reports its counts. Injected exec and write: no process is started, no clock is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULTS, legArgs, main, parseSummary, resultLine, selectTests, spawnOptions } from './windows-probe.mjs';

const repo = resolve(import.meta.dirname, '../..');

test('an empty or blank input selects nothing: every leg runs its default', () => {
  for (const v of [undefined, '', '   ']) assert.deepEqual(selectTests(v), { ok: true, files: [] });
});

test('files, globs and folders under tests/ are accepted; a folder means its test files; duplicates are dropped', () => {
  assert.deepEqual(selectTests('tests/core/gates-s1.test.mjs tests/core/run6-*.test.mjs'), { ok: true, files: ['tests/core/gates-s1.test.mjs', 'tests/core/run6-*.test.mjs'] });
  assert.deepEqual(selectTests('tests/invariants-node'), { ok: true, files: ['tests/invariants-node/*.test.mjs'] });
  assert.deepEqual(selectTests('tests/invariants-node/'), { ok: true, files: ['tests/invariants-node/*.test.mjs'] });
  assert.deepEqual(selectTests('tests/core/a.test.mjs  tests/core/a.test.mjs'), { ok: true, files: ['tests/core/a.test.mjs'] });
  assert.deepEqual(selectTests('tests/core/**/x.test.mjs'), { ok: true, files: ['tests/core/**/x.test.mjs'] });
});

const MALICIOUS = [
  'tests/core/a.test.mjs; rm -rf /', 'tests/core/a.test.mjs && curl evil', 'tests/core/a.test.mjs | sh', 'tests/core/a.test.mjs & calc',
  'tests/core/$(id).test.mjs', 'tests/core/${IP}.test.mjs', 'tests/core/`id`.test.mjs', 'tests/core/a.test.mjs\nrm -rf /', 'tests/core/a.test.mjs\tx',
  "tests/core/'a'.test.mjs", 'tests/core/"a".test.mjs', 'tests/core/a.test.mjs > out', 'tests/core/a.test.mjs < in', 'tests/core\\a.test.mjs', 'tests/core/a.test.mjs\r',
  'tests/core/%TEMP%.test.mjs', 'tests/core/a b!.test.mjs', 'tests/core/{a,b}.test.mjs', 'tests/core/[a].test.mjs', 'tests/core/a?.test.mjs', 'tests/core/\u0000.test.mjs',
  'tests/core/\u00e9.test.mjs', 'tests/core/a.test.mjs #x', '$GITHUB_ENV', '${{ secrets.X }}',
  // paths that leave tests/ or look like options
  '../tests/core/a.test.mjs', 'tests/../etc/passwd.mjs', 'tests/core/../../x.mjs', '/etc/passwd', 'C:/x/a.test.mjs', 'core/a.test.mjs', 'tests', 'tests/..', 'tests/./a.test.mjs',
  '--import=./evil.mjs', '-r', 'tests/core/--eval.mjs', 'tests//core/a.test.mjs', 'https://x/tests/a.mjs', 'tests/core/a.test.js', 'tests/core/a.txt', 'tests/core/...',
];
test('malicious or malformed entries are refused as a whole, with a reason, and never partly accepted', () => {
  for (const bad of MALICIOUS) {
    const r = selectTests(`tests/core/ok.test.mjs ${bad}`);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(!r.ok && r.error.length > 0);
    assert.equal(selectTests(bad).ok, false, JSON.stringify(bad));
  }
});

test('size limits: 64 entries and 200 characters per entry', () => {
  const many = Array.from({ length: 64 }, (_, i) => `tests/core/a${i}.test.mjs`).join(' ');
  assert.equal(selectTests(many).ok, true);
  assert.equal(selectTests(`${many} tests/core/z.test.mjs`).ok, false);
  assert.equal(selectTests(`tests/core/${'a'.repeat(190)}.test.mjs`).ok, false);
  assert.equal(selectTests(`tests/core/${'a'.repeat(150)}.test.mjs`).ok, true);
});

test('legArgs: no selection gives the defaults of the matrix; a selection is sharded over the four core legs (tests) and goes to invariants (tests/invariants-node)', () => {
  assert.deepEqual(legArgs('core 3/4', []), ['--test-shard=3/4', 'tests/core/*.test.mjs']);
  assert.deepEqual(legArgs('invariants', []), ['tests/invariants-node/*.test.mjs']);
  const files = ['tests/core/a.test.mjs', 'tests/invariants-node/*.test.mjs', 'tests/hook/b.test.mjs'];
  assert.deepEqual(legArgs('core 1/4', files), ['--test-shard=1/4', 'tests/core/a.test.mjs', 'tests/hook/b.test.mjs']);
  assert.deepEqual(legArgs('core 4/4', files), ['--test-shard=4/4', 'tests/core/a.test.mjs', 'tests/hook/b.test.mjs']);
  assert.deepEqual(legArgs('invariants', files), ['tests/invariants-node/*.test.mjs']);
  assert.equal(legArgs('invariants', ['tests/core/a.test.mjs']), null);
  assert.equal(legArgs('core 1/4', ['tests/invariants-node/*.test.mjs']), null);
  assert.throws(() => legArgs('nope', []), /unknown leg/);
});

test('the legs of the workflow matrix and the defaults of the script are the same set, and ci.yml passes the input only through the environment', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const matrix = /suite: \[(.*)\]/.exec(ci)?.[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepEqual(matrix, Object.keys(DEFAULTS));
  const uses = [...ci.matchAll(/\$\{\{\s*inputs\.[^}]*\}\}/g)];
  assert.equal(uses.length, 1);
  assert.match(ci, /^ {10}PROBE_TESTS: \$\{\{ inputs\.tests \}\}$/m);
  assert.match(ci, /^ {8}run: node tests\/ci\/windows-probe\.mjs$/m);
});

const SPEC_TAIL = '\u2714 a (1ms)\n\u2139 tests 12\n\u2139 suites 3\n\u2139 pass 9\n\u2139 fail 2\n\u2139 cancelled 1\n\u2139 skipped 0\n\u2139 todo 0\n\u2139 duration_ms 63210.5\n';
test('parseSummary reads the closing lines of the test runner; the last of each wins', () => {
  assert.deepEqual(parseSummary(SPEC_TAIL), { tests: 12, pass: 9, fail: 2, cancelled: 1, skipped: 0, todo: 0, duration_ms: 63210.5 });
  assert.deepEqual(parseSummary(`\u2139 pass 1\n${SPEC_TAIL}`).pass, 9);
  assert.deepEqual(parseSummary('nothing here\n  pass 4 of them\n'), {});
  assert.equal(resultLine('core 2/4', parseSummary(SPEC_TAIL)), 'PROBE-RESULT leg=core 2/4 pass=9 fail=2 cancelled=1 skipped=0 duration_s=63.2');
  assert.equal(resultLine('core 2/4', {}, 'exit 1'), 'PROBE-RESULT leg=core 2/4 pass=n/a fail=n/a cancelled=n/a skipped=n/a duration_s=n/a exit 1');
});

/** @param {NodeJS.ProcessEnv} env @param {{ status?: number, lines?: string[] }} [r] */
async function run(env, r = {}) {
  /** @type {string[][]} */ const calls = [];
  /** @type {string[]} */ const out = []; /** @type {string[]} */ const sum = [];
  const status = await main(env, {
    exec: async (args, onLine) => { calls.push(args); for (const l of r.lines ?? SPEC_TAIL.trimEnd().split('\n')) onLine(l); return r.status ?? 0; },
    write: (s) => out.push(s), summary: (s) => sum.push(s),
  });
  return { status, calls, out: out.join(''), sum: sum.join('') };
}

test('main: an empty selection runs the leg default and reports its counts in the log and the job summary', async () => {
  const r = await run({ PROBE_SUITE: 'core 2/4', PROBE_TESTS: '' }, { status: 1 });
  assert.deepEqual(r.calls, [['--test', '--test-reporter=spec', '--test-shard=2/4', 'tests/core/*.test.mjs']]);
  assert.equal(r.status, 1);
  assert.match(r.out, /PROBE-RESULT leg=core 2\/4 pass=9 fail=2 cancelled=1 skipped=0 duration_s=63\.2 exit 1\n$/);
  assert.match(r.sum, /^\| leg \| pass \| fail .*\n\|---.*\n\| core 2\/4 \| 9 \| 2 \| 1 \| 0 \| 63\.2 \| exit 1 \|\n$/);
});

test('main: a selection runs only its files in the one leg that owns them; a leg without a file for it prints SKIPPED and starts no node', async () => {
  const env = { PROBE_TESTS: 'tests/core/a.test.mjs tests/invariants-node' };
  const core = await run({ ...env, PROBE_SUITE: 'core 1/4' });
  assert.deepEqual(core.calls, [['--test', '--test-reporter=spec', '--test-shard=1/4', 'tests/core/a.test.mjs']]);
  const inv = await run({ ...env, PROBE_SUITE: 'invariants' });
  assert.deepEqual(inv.calls, [['--test', '--test-reporter=spec', 'tests/invariants-node/*.test.mjs']]);
  const shard = await run({ ...env, PROBE_SUITE: 'core 4/4' }, { lines: ['\u2139 tests 0', '\u2139 pass 0', '\u2139 fail 0'] });
  assert.deepEqual(shard.calls, [['--test', '--test-reporter=spec', '--test-shard=4/4', 'tests/core/a.test.mjs']]);
  assert.equal(shard.status, 0, 'a shard without a file is not an error');
  const only = await run({ PROBE_TESTS: 'tests/core/a.test.mjs', PROBE_SUITE: 'invariants' });
  assert.deepEqual(only.calls, []);
  assert.equal(only.status, 0);
  assert.match(only.out, /^SKIPPED: no selected test file belongs to the invariants leg\n$/);
});

test('main: a bad input or an unknown leg starts nothing and fails with status 2; a selection that matched no test fails', async () => {
  for (const [suite, tests] of [['core 1/4', 'tests/core/a.test.mjs; id'], ['invariants', '../x.mjs'], ['nope', ''], ['', '']]) {
    const r = await run({ PROBE_SUITE: suite, PROBE_TESTS: tests });
    assert.equal(r.status, 2, `${suite} ${tests}`);
    assert.deepEqual(r.calls, []);
  }
  const none = await run({ PROBE_SUITE: 'core 1/4', PROBE_TESTS: 'tests/core/missing.test.mjs' }, { lines: ['\u2139 tests 0', '\u2139 pass 0', '\u2139 fail 0'] });
  assert.equal(none.status, 1);
  assert.match(none.out, /the selection matched nothing/);
});

test('the one process the script starts runs without a shell, and a missing file (0 tests) fails the leg that must find it', async () => {
  assert.equal(spawnOptions().shell, false);
  assert.deepEqual(spawnOptions().stdio, ['ignore', 'pipe', 'inherit']);
  const r = await run({ PROBE_SUITE: 'invariants', PROBE_TESTS: 'tests/invariants-node/missing.test.mjs' }, { lines: ['\u2139 tests 0'] });
  assert.equal(r.status, 1);
  assert.match(r.out, /file not found/);
});
