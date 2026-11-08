// @ts-check
// Tests of tests/selftest.mjs (the Node self-test runner, issue #176 package A) and the rules it keeps from the shell runner it replaced: the unit split, the weights
// (the median rule for unlisted units), SELFTEST_SHARD, SELFTEST_ONLY, LC_ONLY, the job count (half the cores and nice locally, all cores in CI), the
// times file, failure rules (a failing unit, a scenario unit that ran no case) and the process-group timeout.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { allSuites, jobCount, main, parseWeights, root, scenariosOf, selectSuites, shardOf, suiteName, unitKey, unitsOf } from '../selftest.mjs';

const work = mkdtempSync(path.join(tmpdir(), 'selftest-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;

/** A fake repository: suites by relative path, optional weights file. @param {Record<string, string>} suites @param {string} [weights] */
function fake(suites, weights) {
  const dir = path.join(work, `r${++n}`);
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  for (const [f, text] of Object.entries(suites)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), text); }
  if (weights !== undefined) writeFileSync(path.join(dir, 'tests/selftest-weights.txt'), weights);
  return dir;
}
/** Run the runner on a root; returns the exit status and the output. @param {string} rootDir @param {Record<string, string>} [env] */
async function run(rootDir, env = {}) {
  let out = '';
  const status = await main({ PATH: process.env.PATH, TMPDIR: work, CI: '1', SELFTEST_WEIGHTS: '/dev/null', ...env }, { rootDir, write: (s) => { out += s; } });
  return { status, out };
}

describe('the unit split', () => {
  test('scenariosOf reads run_sc lines and the scenarios=... line, as run_sc receives them', () => {
    assert.deepEqual(scenariosOf("x\nrun_sc one\nrun_sc two arg\nrun_sc 9bad\nscenarios='a b  c'\n  run_sc indented\n"), ['one', 'two arg', 'a', 'b', 'c']);
    assert.deepEqual(scenariosOf('echo ok\n'), []);
  });
  test('unsplit suites come first, then the scenario units in suite order; LC_ONLY filters scenarios only', () => {
    const r = fake({ 'tests/a/a-test.sh': 'run_sc s1\nrun_sc s2\n', 'tests/b/b-test.sh': 'echo hi\n', 'tests/c/c-test.sh': 'run_sc t1\n' });
    const suites = allSuites(r);
    assert.deepEqual(suites, ['tests/a/a-test.sh', 'tests/b/b-test.sh', 'tests/c/c-test.sh']);
    assert.deepEqual(unitsOf(suites, '', r).map(unitKey), ['b-test', 'a-test s1', 'a-test s2', 'c-test t1']);
    assert.deepEqual(unitsOf(suites, 's2', r).map(unitKey), ['b-test', 'a-test s2']);
  });
  test('control-plane suites come before the tests/<dir> suites; both in byte order', () => {
    const r = fake({ 'control-plane/agents/scripts/z-test.sh': '', 'tests/b/b-test.sh': '', 'tests/a/a-test.sh': '', 'tests/a/notatest.sh': '' });
    assert.deepEqual(allSuites(r), ['control-plane/agents/scripts/z-test.sh', 'tests/a/a-test.sh', 'tests/b/b-test.sh']);
  });
  test('SELFTEST_ONLY: an exact suite name wins over names that contain it, else every suite containing it', () => {
    const all = ['tests/x/gates-test.sh', 'tests/x/gates-test-extra-test.sh', 'tests/y/risk-test.sh'];
    assert.deepEqual(selectSuites(all, 'gates-test').map(suiteName), ['gates-test']);
    assert.deepEqual(selectSuites(all, 'gates').map(suiteName), ['gates-test', 'gates-test-extra-test']);
    assert.deepEqual(selectSuites(all, 'nothing'), []);
  });
});

describe('every unit of the repository runs exactly once', () => {
  test('the 16 CI shards together list every unit of every legacy suite once, none twice (a hidden unit is a test that never runs)', () => {
    const suites = allSuites(root);
    assert.ok(suites.length > 10, `${suites.length} suites`);
    const units = unitsOf(suites, '');
    const weights = existsSync(path.join(root, 'tests/selftest-weights.txt')) ? readFileSync(path.join(root, 'tests/selftest-weights.txt'), 'utf8') : '';
    /** @type {Map<number, number>} */ const seen = new Map();
    for (let i = 1; i <= 16; i++) for (const u of shardOf(units, weights, i, 16).mine) seen.set(u, (seen.get(u) ?? 0) + 1);
    assert.equal(seen.size, units.length, 'every unit is in a shard');
    assert.ok([...seen.values()].every((c) => c === 1), 'no unit is in two shards');
    // every *-test.sh file of the two roots is a unit's suite
    const covered = new Set(units.map((u) => u.suite));
    for (const s of suites) assert.ok(covered.has(s), `${s} has no unit`);
    // and a unit key is unique (the weights file is keyed by it)
    assert.equal(new Set(units.map(unitKey)).size, units.length, 'unit keys are unique');
  });
  test('the shard split does not depend on how many shards there are: any N covers all units once', () => {
    const units = unitsOf(allSuites(root), '');
    for (const nShards of [1, 2, 5, 16, 40]) {
      const total = Array.from({ length: nShards }, (_, i) => shardOf(units, '', i + 1, nShards).mine.length).reduce((a, b) => a + b, 0);
      assert.equal(total, units.length, `N=${nShards}`);
    }
  });
  test('SELFTEST_LIST prints this shard\'s units as suite|scenario; =weights prefixes the weight', async () => {
    const r = fake({ 'tests/a/a-test.sh': 'run_sc one\nrun_sc two\n', 'tests/b/b-test.sh': 'echo\n' }, '30 a-test one\n');
    const plain = await run(r, { SELFTEST_LIST: '1' });
    assert.equal(plain.status, 0);
    assert.deepEqual(plain.out.trim().split('\n').sort(), ['tests/a/a-test.sh|one', 'tests/a/a-test.sh|two', 'tests/b/b-test.sh|']);
    const w = await run(r, { SELFTEST_LIST: 'weights', SELFTEST_WEIGHTS: path.join(r, 'tests/selftest-weights.txt') });
    assert.ok(w.out.trim().split('\n').includes('30 tests/a/a-test.sh|one'));
    assert.ok(w.out.trim().split('\n').includes('30 tests/a/a-test.sh|two'), 'an unlisted unit weighs the median of the listed');
  });
});

describe('the weights', () => {
  const keysOf = (/** @type {string} */ out) => out.trim().split('\n');
  test('an unlisted unit weighs the median of the listed ones (10 30 100 gives 30), not 15', async () => {
    const r = fake({ 'tests/a/risk-test.sh': 'run_sc s1\nrun_sc s2\nrun_sc s3\nrun_sc s4\nrun_sc s5\nrun_sc s6\n' });
    const f = path.join(r, 'w3.txt'); writeFileSync(f, '10 risk-test s1\n30 risk-test s2\n100 risk-test s3\n');
    const got = keysOf((await run(r, { SELFTEST_LIST: 'weights', SELFTEST_WEIGHTS: f })).out);
    assert.equal(got.filter((l) => l.startsWith('30 ')).length, 1 + 3, 'the listed 30 and the three unlisted');
    assert.equal(got.filter((l) => l.startsWith('15 ')).length, 0);
  });
  test('an even count takes the middle pair (10 20 30 100 gives 25); no weights at all weigh 15', async () => {
    const r = fake({ 'tests/a/risk-test.sh': 'run_sc s1\nrun_sc s2\nrun_sc s3\nrun_sc s4\nrun_sc s5\nrun_sc s6\n' });
    const f = path.join(r, 'w4.txt'); writeFileSync(f, '10 risk-test s1\n20 risk-test s2\n30 risk-test s3\n100 risk-test s4\n');
    assert.equal(keysOf((await run(r, { SELFTEST_LIST: 'weights', SELFTEST_WEIGHTS: f })).out).filter((l) => l.startsWith('25 ')).length, 2);
    assert.ok(keysOf((await run(r, { SELFTEST_LIST: 'weights', SELFTEST_WEIGHTS: '/dev/null' })).out).every((l) => l.startsWith('15 ')));
    assert.deepEqual(parseWeights('# c\n\nnot a weight\n7 a b\n9   c  \n'), { wt: new Map([['a b', 7], ['c', 9]]), med: 8 });
  });
  test('units go longest first onto the lightest shard, ties by order', () => {
    const units = ['a', 'b', 'c', 'd'].map((x) => ({ suite: `tests/x/${x}-test.sh`, scen: '' }));
    const w = '50 a-test\n20 b-test\n20 c-test\n10 d-test\n';
    assert.deepEqual(shardOf(units, w, 1, 2).mine, [0]);          // 50 alone: the other shard gets 20+20+10
    assert.deepEqual(shardOf(units, w, 2, 2).mine, [1, 2, 3]);
  });
  test('SELFTEST_TIMES_FILE gets one line per unit that ran, in the weights file format', async () => {
    const r = fake({ 'tests/a/fake-test.sh': "run_sc() { [ \"${LC_EXACT:-}\" = \"$*\" ] || return 0; echo \"ok 1 $*\"; }\nrun_sc one\nrun_sc two x\n", 'tests/a/whole-test.sh': 'echo "ok 1 whole"\n' });
    const times = path.join(work, `times${n}.txt`);
    const { status, out } = await run(r, { SELFTEST_TIMES_FILE: times });
    assert.equal(status, 0, out);
    const lines = readFileSync(times, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => /^[0-9]+ (fake-test (one|two x)|whole-test)$/.test(l)), lines.join('|'));
  });
});

describe('the job count', () => {
  const cores = cpus().length || 4;
  test('CI uses every core; a local run half of them (at least 1); SELFTEST_JOBS overrides both; junk gives 4', () => {
    assert.equal(jobCount({ CI: 'true' }, 16).jobs, 16);
    assert.equal(jobCount({}, 16).jobs, 8);
    assert.equal(jobCount({}, 7).jobs, 4);
    assert.equal(jobCount({}, 1).jobs, 1);
    assert.equal(jobCount({ CI: '1', SELFTEST_JOBS: '3' }, 16).jobs, 3);
    assert.equal(jobCount({ SELFTEST_JOBS: '3' }, 16).jobs, 3);
    for (const junk of ['0', 'x', '', '-2']) assert.equal(jobCount({ SELFTEST_JOBS: junk }, 16).jobs, 4, junk);
    assert.equal(jobCount({}, 16).local, true); assert.equal(jobCount({ CI: '1' }, 16).local, false);
    assert.ok(jobCount({ CI: '1' }).jobs >= 1 && cores >= 1);
  });
  test('the summary names the jobs, and only a local run says its units were niced', async () => {
    const r = fake({ 'tests/a/a-test.sh': 'run_sc one\n' });
    const ci = await run(r, { LC_ONLY: 'zznomatch', CI: 'true' });
    assert.match(ci.out, new RegExp(`${jobCount({ CI: 'true' }).jobs} jobs`));
    assert.ok(!/niced/.test(ci.out));
    const local = await run(r, { LC_ONLY: 'zznomatch', CI: '' });
    assert.match(local.out, new RegExp(`${jobCount({}).jobs} jobs`));
    if (process.platform !== 'win32') assert.match(local.out, /niced/);
    assert.match((await run(r, { LC_ONLY: 'zznomatch', SELFTEST_JOBS: '3' })).out, /3 jobs/);
  });
});

describe('what a run reports', () => {
  test('a passing suite prints PASS with its case count; the summary has units, jobs, shard and seconds', async () => {
    const r = fake({ 'tests/a/ok-test.sh': 'echo "ok 1 a"\necho "PASS b"\necho "skip c"\necho "noise"\n' });
    const { status, out } = await run(r);
    assert.equal(status, 0);
    assert.match(out, /^PASS ok-test \(3 cases\)$/m);
    assert.match(out, /^selftest: 1\/1 suites passed \(1 units, \d+ jobs, shard 1\/1, \d+s\)$/m);
  });
  test('a failing unit prints FAIL with its exit code and the log tail, and the run exits 1', async () => {
    const r = fake({ 'tests/a/bad-test.sh': 'echo "line one"\necho "boom" >&2\nexit 3\n' });
    const { status, out } = await run(r);
    assert.equal(status, 1);
    assert.match(out, /^FAIL bad-test \(exit 3\)$/m);
    assert.match(out, /^ {4}boom$/m);
    assert.match(out, /0\/1 suites passed/);
  });
  test('a scenario unit that ran no case selected nothing: that is a failure, not a pass', async () => {
    const r = fake({ 'tests/a/ghost-test.sh': 'run_sc() { [ "${LC_EXACT:-}" = "$*" ] || return 0; echo "ok 1"; }\nrun_sc real\nscenarios=\'real typo\'\n' });
    const { status, out } = await run(r);
    assert.equal(status, 1);
    assert.match(out, /FAIL ghost-test \[typo\] \(exit 0\)/);
  });
  test('slowest lists the longest units (SELFTEST_SLOWEST=K)', async () => {
    const r = fake({ 'tests/a/a-test.sh': 'echo "ok 1"\n', 'tests/a/b-test.sh': 'echo "ok 1"\n' });
    assert.equal((await run(r, { SELFTEST_SLOWEST: '999' })).out.split('\n').filter((l) => l.startsWith('slowest: ')).length, 2);
    assert.equal((await run(r, { SELFTEST_SLOWEST: '1' })).out.split('\n').filter((l) => l.startsWith('slowest: ')).length, 1);
  });
  test('bad shard values and an unmatched name exit 2 with a message', async () => {
    const r = fake({ 'tests/a/a-test.sh': 'echo "ok 1"\n' });
    for (const s of ['x', '1', '0/4', '5/4', '1/x']) assert.equal((await run(r, { SELFTEST_SHARD: s })).status, 2, s);
    assert.equal((await run(r, { SELFTEST_ONLY: 'nope' })).status, 2);
    assert.equal((await run(r, { TMPDIR: path.join(work, 'no-such-dir') })).status, 2);
  });
  test('the runner removes its log directory and the template cache it made', async () => {
    const tmpHere = mkdtempSync(path.join(work, 'tmpdir-'));
    const r = fake({ 'tests/a/a-test.sh': 'echo "ok 1 $SELFTEST_TEMPLATE_DIR"\n' });
    const res = await run(r, { TMPDIR: tmpHere });
    assert.equal(res.status, 0);
    assert.deepEqual((await import('node:fs')).readdirSync(tmpHere), []);
  });
});

describe('a unit that hangs (security: the runner spawns the repository suites)', () => {
  test('expiry kills the unit with its whole process group and is a failure; a grandchild never writes after it', { timeout: 60000 }, async () => {
    const marker = path.join(work, `marker${++n}`);
    const r = fake({ 'tests/a/hang-test.sh': `( sleep 4; echo late > "${marker}" ) &\nsleep 60\n` });
    const t0 = Date.now();
    const { status, out } = await run(r, { SELFTEST_UNIT_TIMEOUT: '1' });
    assert.equal(status, 1);
    assert.match(out, /FAIL hang-test \(exit 124\)/);
    assert.match(out, /killed with its process group/);
    assert.ok(Date.now() - t0 < 20000, 'the run did not wait for the hanging unit');
    await new Promise((res) => setTimeout(res, 5000));
    assert.ok(!existsSync(marker), 'the grandchild was killed with the group');
  });
});
