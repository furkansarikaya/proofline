// @ts-check
// Issue 266 package 3c: the clock-read gate. The decisions are pure functions of fixture strings (a scan result, a baseline text, a diff text); the only process is one git in a
// private temp repository for the changed-line computation, and one scan of this repository for the ratchet. No clock is read: the names of the clock reads are assembled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tempDir } from '../lib/tempdir.mjs';
import { addedLines, ALTERNATIVE, BASELINE_FILE, changedLines, countByFile, extraReads, formatBaseline, judge, main, parseBaseline, resolveBase, scanRepo, validBase } from './clock-read-gate.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const NOW = ['Date', 'now'].join('.');
const ci = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
/** @param {string} file @param {number} line @returns {{ file: string, line: number, pattern: string }} */
const rd = (file, line) => ({ file, line, pattern: NOW });
const base = (/** @type {string} */ t) => parseBaseline(t).counts;

test('a NEW test file with a direct read is flagged with file:line and the injected-clock alternative', () => {
  const p = judge([rd('tests/core/fresh.test.mjs', 7)], base('tests/core/old.test.mjs\t1\n'), new Map());
  assert.ok(p.some((x) => x.startsWith(`tests/core/fresh.test.mjs:7: direct clock read (${NOW})`) && x.includes(ALTERNATIVE)), p.join('\n'));
  assert.equal(judge([], base('tests/core/old.test.mjs\t1\n'), new Map()).length, 1, 'only the baseline line that has no read any more (ratchet)');
});

test('a CHANGED file: a read on an added line is flagged even when its count equals the baseline; a read on an untouched line is not', () => {
  const b = base('tests/core/old.test.mjs\t2\n');
  const reads = [rd('tests/core/old.test.mjs', 10), rd('tests/core/old.test.mjs', 20)];
  assert.deepEqual(judge(reads, b, new Map([['tests/core/old.test.mjs', new Set([5, 6])]])), [], 'the change added lines 5 and 6 only');
  const p = judge(reads, b, new Map([['tests/core/old.test.mjs', new Set([20])]]));
  assert.equal(p.length, 1);
  assert.match(p[0], /^tests\/core\/old\.test\.mjs:20: direct clock read .* on a line this change adds or changes/);
  assert.deepEqual(judge(reads, b, null), [], 'no base ref: the changed-line rule is not applied, the ratchet is');
});

test('ratchet: equal passes, above fails, a file not in the baseline fails, below fails with "lower the baseline"', () => {
  const b = base('tests/a.test.mjs\t2\ntests/b.test.mjs\t1\n');
  const a2 = [rd('tests/a.test.mjs', 1), rd('tests/a.test.mjs', 2)]; const b1 = [rd('tests/b.test.mjs', 3)];
  assert.deepEqual(judge([...a2, ...b1], b, new Map()), []);
  const above = judge([...a2, rd('tests/a.test.mjs', 9), ...b1], b, new Map());
  assert.ok(above.some((x) => /^tests\/a\.test\.mjs: 3 direct clock reads, baseline 2/.test(x)), above.join('\n'));
  const fresh = judge([...a2, ...b1, rd('tests/c.test.mjs', 4)], b, new Map());
  assert.ok(fresh.some((x) => x.startsWith('tests/c.test.mjs:4:') && x.includes('not in the baseline')), fresh.join('\n'));
  const below = judge([...a2], b, new Map());
  assert.equal(below.length, 1);
  assert.match(below[0], /^tests\/b\.test\.mjs: 0 direct clock reads, baseline 1: lower the baseline/);
  assert.match(judge([rd('tests/a.test.mjs', 1), ...b1], b, new Map())[0], /^tests\/a\.test\.mjs: 1 direct clock reads, baseline 2: lower the baseline/);
});

test('the baseline text: parsed, written sorted and deterministic, a malformed or unsorted or duplicate line is an error', () => {
  const counts = countByFile([rd('tests/z.mjs', 1), rd('tests/a.mjs', 1), rd('tests/a.mjs', 2)]);
  const text = formatBaseline(counts);
  assert.ok(text.endsWith('tests/a.mjs\t2\ntests/z.mjs\t1\n'));
  assert.equal(formatBaseline(parseBaseline(text).counts), text, 'round trip');
  assert.equal(parseBaseline(text).errors.length, 0);
  assert.equal(parseBaseline('tests/z.mjs\t1\ntests/a.mjs\t1\n').errors.length, 1);
  assert.equal(parseBaseline('tests/a.mjs\t1\ntests/a.mjs\t1\n').errors.length, 1);
  assert.equal(parseBaseline('tests/a.mjs\t0\n').errors.length, 1);
  assert.equal(parseBaseline('tests/a.mjs 3\n').errors.length, 1);
});

test('addedLines reads the new-side ranges of a unified=0 diff; a deleted file adds nothing', () => {
  const diff = ['diff --git a/tests/x.mjs b/tests/x.mjs', '--- a/tests/x.mjs', '+++ b/tests/x.mjs', '@@ -3 +3,2 @@', '+a', '+b', '@@ -9,2 +11,0 @@', '-c', '-d', '@@ -20 +22 @@', '+e',
    'diff --git a/tests/gone.mjs b/tests/gone.mjs', '--- a/tests/gone.mjs', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-q', ''].join('\n');
  const m = addedLines(diff);
  assert.deepEqual([...(m.get('tests/x.mjs') ?? [])], [3, 4, 22]);
  assert.equal(m.has('tests/gone.mjs'), false);
});

test('the changed lines come from git diff against the merge base of an injectable base (a private repository, no network)', () => {
  const d = tempDir('clock-gate-');
  const g = (/** @type {string[]} */ a) => { const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-C', d, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  mkdirSync(path.join(d, 'tests'));
  writeFileSync(path.join(d, 'tests/old.test.mjs'), 'one\ntwo\nthree\n');
  g(['init', '-q', '-b', 'main']); g(['add', '.']); g(['commit', '-q', '-m', 'base']);
  g(['checkout', '-q', '-b', 'topic']);
  writeFileSync(path.join(d, 'tests/old.test.mjs'), 'one\nTWO\nthree\nfour\n');
  writeFileSync(path.join(d, 'tests/new.test.mjs'), 'x\ny\n');
  g(['add', '.']); g(['commit', '-q', '-m', 'topic']);
  const m = changedLines(d, 'main');
  assert.deepEqual([...(m?.get('tests/old.test.mjs') ?? [])], [2, 4]);
  assert.deepEqual([...(m?.get('tests/new.test.mjs') ?? [])], [1, 2]);
  assert.equal(changedLines(d, null), null, 'no base');
  /** @type {string[][]} */ const calls = [];
  changedLines(d, 'BASEREF', (a) => { calls.push(a); return a[0] === 'rev-parse' ? 'abc123\n' : a[0] === 'merge-base' ? 'def456\n' : ''; });
  assert.deepEqual(calls.map((c) => c[0]), ['rev-parse', 'merge-base', 'diff']);
  assert.ok(calls[2].includes('def456') && calls[2].includes('--end-of-options'), 'the diff is taken from the merge base, after --end-of-options');
});

test('main: exit 1 and a message on problems, exit 0 when clean, --update writes the sorted baseline, usage is 2', () => {
  const files = new Map([[BASELINE_FILE, 'tests/a.mjs\t1\n']]);
  /** @param {string[]} argv @param {import('./clock-read-gate.mjs').Read[]} reads @param {Map<string, Set<number>> | null} [added] */
  const run = (argv, reads, added = new Map()) => {
    let out = ''; let err = '';
    const status = main(argv, { root: '/nowhere', env: {}, scan: () => reads, diff: () => added, read: (f) => files.get(f) ?? '', write: (f, t) => { files.set(f, t); }, out: (s) => { out += s; }, err: (s) => { err += s; }, hasRef: () => false });
    return { status, out, err };
  };
  assert.equal(run([], [rd('tests/a.mjs', 1)]).status, 0);
  assert.match(run([], [rd('tests/a.mjs', 1)]).out, /1 baselined read\(s\) in 1 file\(s\)/);
  const bad = run(['--base', 'x'], [rd('tests/a.mjs', 1), rd('tests/n.mjs', 5)]);
  assert.equal(bad.status, 1);
  assert.match(bad.err, /tests\/n\.mjs:5: direct clock read/);
  assert.equal(run(['--update'], [rd('tests/q.mjs', 1), rd('tests/b.mjs', 1)]).status, 0);
  assert.equal(files.get(BASELINE_FILE)?.endsWith('tests/b.mjs\t1\ntests/q.mjs\t1\n'), true);
  assert.equal(run(['--bogus'], []).status, 2);
  assert.equal(run(['--base'], []).status, 2);
});

test('this repository is at or under its baseline: no read above, none missing from it, none below (the list only shrinks)', () => {
  const { counts, errors } = parseBaseline(readFileSync(path.join(repo, BASELINE_FILE), 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(counts.size > 0);
  const p = judge(scanRepo(repo), counts, null);
  assert.deepEqual(p, []);
});

test('the static job runs the gate against the pull request base; the baseline file exists in the repository', () => {
  const m = /      - name: clock-read gate[^\n]*\n((?:        [^\n]*\n)+)/.exec(ci);
  assert.ok(m, 'no clock-read gate step');
  assert.match(m[1], /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(m[1], /run: node tests\/ci\/clock-read-gate\.mjs\n/);
});

test('the base is validated before any git call: option-like, dotted, braced and blank spellings are refused; a valid sha and a ref name resolve; an unknown sha is a clear error', () => {
  for (const bad of ['--output=/abs/x', '-x', 'a..b', 'a@{1}', 'a b', '', 'x\ny', '--end-of-options']) assert.equal(validBase(bad), false, JSON.stringify(bad));
  for (const ok of ['abcdef1', 'origin/main', 'release-1.2', 'A'.repeat(1) + 'b0c1d2e']) assert.equal(validBase(ok), true, ok);
  /** @type {string[][]} */ const calls = [];
  assert.throws(() => resolveBase('--output=/abs/x', (a) => { calls.push(a); return ''; }), /is refused/);
  assert.equal(calls.length, 0, 'no git call for a refused base');
  assert.throws(() => resolveBase('abcdef1', () => { throw new Error('bad'); }), /is not a commit in this checkout/);
  const seen = /** @type {string[][]} */ ([]);
  assert.equal(resolveBase('origin/main', (a) => { seen.push(a); return a[0] === 'rev-parse' ? 'c0ffee\n' : 'beef\n'; }), 'beef');
  assert.deepEqual(seen[0], ['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}']);
  assert.deepEqual(seen[1], ['merge-base', '--end-of-options', 'c0ffee', 'HEAD']);
});

test('main: --base=--output=FILE is refused (exit 2) and writes no file; an unknown sha and a pull request without a base are errors, not skips', () => {
  const d = tempDir('clock-gate-base-');
  const g = (/** @type {string[]} */ a) => { const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-C', d, ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  mkdirSync(path.join(d, 'tests')); writeFileSync(path.join(d, 'tests/a.mjs'), 'x\n'); g(['init', '-q', '-b', 'main']); g(['add', '.']); g(['commit', '-q', '-m', 'one']);
  const out = path.join(d, 'poc-output');
  /** @param {string[]} argv @param {NodeJS.ProcessEnv} [env] */
  const run = (argv, env = {}) => { let err = ''; const status = main(argv, { root: d, env, scan: () => [], read: () => '', out: () => {}, err: (s) => { err += s; }, hasRef: () => false }); return { status, err }; };
  const a = run([`--base=--output=${out}`]);
  assert.equal(a.status, 2); assert.match(a.err, /is refused/); assert.equal(existsSync(out), false);
  const b = run(['--base', '-x']); assert.equal(b.status, 2);
  const c = run(['--base', 'deadbeefdeadbeef']); assert.equal(c.status, 2); assert.match(c.err, /is not a commit/);
  assert.equal(run(['--base', 'main']).status, 0, 'a valid ref works');
  const sha = spawnSync('git', ['-C', d, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(run(['--base', sha]).status, 0, 'a valid sha works');
  const pr = run([], { GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal(pr.status, 2); assert.match(pr.err, /pull request run has no base/);
  assert.equal(run([]).status, 0, 'a push run (no base, no pull request) is ratchet-only');
});

test('extra spellings are caught: the bigint timer, the argument-less date constructor in any spacing, bracket access, destructured and aliased clocks; a dated constructor with an argument is not', () => {
  const D = ['Da', 'te'].join(''); const P = ['perfor', 'mance'].join(''); const H = ['hr', 'time'].join('');
  const lines = [`const t = ${H}.bigint();`, `const d = new ${D};`, `const d = new ${D}( );`, `const x = ${D}['n' + 'ow']();`, `const { now } = ${D};`, `const clock = ${P};`, `const { ${H} } = process;`];
  const hits = extraReads('tests/x.mjs', lines.join('\n'), new Set());
  assert.deepEqual(hits.map((h) => h.line), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(extraReads('tests/x.mjs', `const d = new ${D}(0);\nconst e = new ${D}(x, y);\nconst f = new ${D} (2020, 1);`, new Set()), []);
  assert.deepEqual(extraReads('tests/x.mjs', lines[0], new Set(['tests/x.mjs:1'])), [], 'a line the finder reported is not counted twice');
});
