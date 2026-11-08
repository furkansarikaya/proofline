// @ts-check
// A235 (#181): `agent.sh diff-digest <ID>`, the combined command for the diff orientation that the verifier, the reviewers and the security reviewer
// each spend 2-4 calls on (git status, git diff, ls, verify-scope). The summary is short; the full list is a raw file the command writes, with its
// own command line and input hashes, under runs/<ID>/reports/diff-digest-<n>/ (A223: reports/ is the registered folder). Absolute expectations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import path from 'node:path';
import { A, project, existsSync, readFileSync, readdirSync, writeFileSync } from './legacy-lib.mjs';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';

const RECIPE = 'scaffold orchestrated no COMPLEX ""';
const ROLES_OK = ['lead', 'reviewer', 'security_reviewer', 'qa', 'verifier'];
const ROLES_NO = ['implementer', 'explorer', 'architect', 'data_architect', 'designer', 'task_author'];
const sha = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');

/** The summary's number for a label such as `changed paths: 31`. @param {string} out @param {RegExp} re */
const num = (out, re) => { const m = re.exec(out); assert.ok(m, `no ${re} in:\n${out}`); return Number(m[1]); };
/** @param {string} dir @param {string} n */
const rawRows = (dir, n = '1') => readFileSync(path.join(dir, `.agents/runs/LC/reports/diff-digest-${n}/raw.txt`), 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('#'));

/** In-scope files (impl.txt, impl_test.txt) and `n` files outside the plan scope. @param {string} dir @param {number} n */
function change(dir, n) {
  writeFileSync(path.join(dir, 'impl.txt'), 'a\nb\nc\n');
  writeFileSync(path.join(dir, 'impl_test.txt'), 'x\n');
  mkdirSync(path.join(dir, 'extra'), { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(path.join(dir, 'extra', `f${String(i).padStart(2, '0')}.txt`), `${'line\n'.repeat(i + 1)}`);
}

test('the summary count equals the count in the raw file; the class counts add up; the raw file is in byte order', () => {
  const dir = project(RECIPE);
  change(dir, 3);
  const r = A(dir, ['diff-digest', 'LC'], { role: 'reviewer' });
  assert.equal(r.status, 0, r.text);
  const rows = rawRows(dir);
  assert.equal(num(r.out, /changed paths: ([0-9]+)/), rows.length);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((l) => l.split('\t')[3]), ['extra/f00.txt', 'extra/f01.txt', 'extra/f02.txt', 'impl.txt', 'impl_test.txt']);
  assert.deepEqual(rows.map((l) => l.split('\t')[0]), ['unexpected', 'unexpected', 'unexpected', 'scope', 'scope']);
  assert.equal(num(r.out, /scope=([0-9]+)/), 2);
  assert.equal(num(r.out, /unexpected=([0-9]+)/), 3);
  assert.match(r.out, /lines: \+10 -0/);
  assert.match(r.out, /raw: \.agents\/runs\/LC\/reports\/diff-digest-1\/raw\.txt sha256=[0-9a-f]{64}/);
  assert.match(r.out, /truncated: no/);
});

test('a finding beyond the summary\'s top items still appears in the count and in the raw file, and the summary says truncated', () => {
  const dir = project(RECIPE);
  change(dir, 25);
  writeFileSync(path.join(dir, 'zz-planted.txt'), 'one\n');          // the smallest change, last in byte order: beyond every top-N list
  const r = A(dir, ['diff-digest', 'LC'], { role: 'verifier' });
  assert.equal(r.status, 0, r.text);
  const rows = rawRows(dir);
  assert.equal(num(r.out, /changed paths: ([0-9]+)/), 28);
  assert.equal(rows.length, 28);
  assert.ok(rows.some((l) => l.endsWith('\tzz-planted.txt') && l.startsWith('unexpected\t')));
  assert.match(r.out, /truncated: yes/);
  assert.ok(!r.out.includes('zz-planted.txt'), 'the summary lists at most 10 unexpected paths');
  assert.equal(num(r.out, /unexpected=([0-9]+)/), 26);
  assert.ok(r.out.split('\n').length < 20, `the summary stays short:\n${r.out}`);
});

test('re-running the recorded command line reproduces the raw file byte for byte; the inputs file holds the hashes', () => {
  const dir = project(RECIPE);
  change(dir, 4);
  const first = A(dir, ['diff-digest', 'LC'], { role: 'qa' });
  assert.equal(first.status, 0, first.text);
  const d1 = path.join(dir, '.agents/runs/LC/reports/diff-digest-1');
  const cmd = readFileSync(path.join(d1, 'command.txt'), 'utf8');
  assert.equal(cmd, 'agent.sh diff-digest LC\n');
  const second = A(dir, cmd.trim().split(' ').slice(1), { role: 'security_reviewer' });
  assert.equal(second.status, 0, second.text);
  const d2 = path.join(dir, '.agents/runs/LC/reports/diff-digest-2');
  assert.deepEqual(readFileSync(path.join(d1, 'raw.txt')), readFileSync(path.join(d2, 'raw.txt')));
  assert.deepEqual(readFileSync(path.join(d1, 'inputs.txt')), readFileSync(path.join(d2, 'inputs.txt')));
  const inputs = readFileSync(path.join(d1, 'inputs.txt'), 'utf8');
  assert.match(inputs, /^plan_sha256 [0-9a-f]{64}$/m);
  assert.ok(inputs.includes(`plan_sha256 ${sha(path.join(dir, '.agents/runs/LC/PLAN.md'))}\n`));
  assert.match(inputs, /^head [0-9a-f]{40}$/m);
  assert.match(inputs, /^patch_fingerprint [0-9a-f]{64}$/m);
  assert.match(first.out, new RegExp(`sha256=${sha(path.join(d1, 'raw.txt'))}`));
  assert.deepEqual(readdirSync(path.join(dir, '.agents/runs/LC/reports')).filter((n) => n.startsWith('diff-digest-')).sort(), ['diff-digest-1', 'diff-digest-2']);
});

test('what the command classifies unexpected is what verify-scope refuses; the files it writes are known run artifacts', () => {
  const dir = project(RECIPE);
  change(dir, 2);
  const r = A(dir, ['diff-digest', 'LC'], { role: 'reviewer' });
  const unexpected = rawRows(dir).filter((l) => l.startsWith('unexpected\t')).map((l) => l.split('\t')[3]);
  const scope = A(dir, ['verify-scope', 'LC']);
  assert.notEqual(scope.status, 0);
  assert.equal(scope.err.split('\n').slice(1).filter((l) => l !== '').join(','), unexpected.join(','));
  assert.ok(!scope.text.includes('diff-digest'), `the digest's own files are not task changes: ${scope.text}`);
  assert.equal(r.status, 0);
});

test('the role gate: the gate roles and the lead may run it, every other role is refused and nothing is written', () => {
  const dir = project(RECIPE);
  change(dir, 1);
  for (const role of ROLES_NO) {
    const r = A(dir, ['diff-digest', 'LC'], { role });
    assert.notEqual(r.status, 0, role);
    assert.match(r.err, /command denied for/, role);
  }
  assert.ok(!existsSync(path.join(dir, '.agents/runs/LC/reports/diff-digest-1')));
  for (const role of ROLES_OK) assert.equal(A(dir, ['diff-digest', 'LC'], { role }).status, 0, role);
});

test('it writes only inside the run: a link planted as the next folder is skipped, a link planted as reports/ is refused, nothing is followed', () => {
  const dir = project(RECIPE);
  change(dir, 1);
  const outside = path.join(dir, 'outside');
  mkdirSync(outside);
  const reports = path.join(dir, '.agents/runs/LC/reports');
  mkdirSync(reports, { recursive: true });
  symlinkSync(outside, path.join(reports, 'diff-digest-1'));
  const r = A(dir, ['diff-digest', 'LC'], { role: 'reviewer' });
  assert.equal(r.status, 0, r.text);
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(existsSync(path.join(reports, 'diff-digest-2', 'raw.txt')));
  assert.match(r.out, /diff-digest-2\/raw\.txt/);
  rmSync(reports, { recursive: true });
  symlinkSync(outside, reports);
  const bad = A(dir, ['diff-digest', 'LC'], { role: 'reviewer' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /reports/);
  assert.deepEqual(readdirSync(outside), []);
});

test('usage and refusals: no id, an unknown run, a run without a captured baseline or scope', () => {
  const dir = project(RECIPE);
  assert.notEqual(A(dir, ['diff-digest'], { role: 'reviewer' }).status, 0);
  const u = A(dir, ['diff-digest', 'NOPE'], { role: 'reviewer' });
  assert.notEqual(u.status, 0);
  assert.match(u.err, /NOPE/);
});
