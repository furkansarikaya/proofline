// @ts-check
// Tests of tests/selftest-weights.mjs: valid times files merge and sort, invalid input is refused and writes nothing.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { main } from '../selftest-weights.mjs';

const T = mkdtempSync(path.join(tmpdir(), 'weights-test-'));
after(() => rmSync(T, { recursive: true, force: true }));
mkdirSync(path.join(T, 'art'));
writeFileSync(path.join(T, 'art/times-1.txt'), '# shard 1\n40 alpha-test sc_a\n10 beta-test\n\n6 alpha-test sc_b x\n');
writeFileSync(path.join(T, 'art/times-2.txt'), '60 alpha-test sc_a\n2 gamma-test\n');
/** @param {string[]} args */
function run(args) {
  const err = console.error; let msg = '';
  console.error = (/** @type {string} */ m) => { msg += `${m}\n`; };
  try { return { status: main(args), msg }; } finally { console.error = err; }
}

test('a directory of times files is merged (same unit averaged), longest first', () => {
  assert.equal(run(['-o', path.join(T, 'out1.txt'), '--note', 'split units were estimated', path.join(T, 'art')]).status, 0);
  const body = readFileSync(path.join(T, 'out1.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(body, ['50 alpha-test sc_a', '10 beta-test', '6 alpha-test sc_b x', '2 gamma-test']);
});
test('the header states its source and carries the note', () => {
  const head = readFileSync(path.join(T, 'out1.txt'), 'utf8');
  assert.match(head, /^# split units were estimated$/m);
  assert.match(head, /MEDIAN/);
  assert.match(head, /from 2 times file/);
  assert.match(head, /tests\/selftest\.mjs/);
});
test('one times file works as well', () => {
  assert.equal(run(['-o', path.join(T, 'out2.txt'), path.join(T, 'art/times-1.txt')]).status, 0);
  assert.equal(readFileSync(path.join(T, 'out2.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).length, 3);
});
test('a malformed line is refused with file and line, and nothing is written', () => {
  writeFileSync(path.join(T, 'bad.txt'), '40 alpha-test sc_a\nseven beta-test\n');
  const r = run(['-o', path.join(T, 'out3.txt'), path.join(T, 'art/times-1.txt'), path.join(T, 'bad.txt')]);
  assert.equal(r.status, 2);
  assert.match(r.msg, /bad\.txt:2:/);
  assert.ok(!existsSync(path.join(T, 'out3.txt')));
  writeFileSync(path.join(T, 'bad2.txt'), '5 a b c d\n'); assert.equal(run(['-o', path.join(T, 'out3.txt'), path.join(T, 'bad2.txt')]).status, 2, 'too many fields');
  writeFileSync(path.join(T, 'bad3.txt'), '5 a/b\n'); assert.equal(run(['-o', path.join(T, 'out3.txt'), path.join(T, 'bad3.txt')]).status, 2, 'a suite name with a slash');
});
test('a missing input path, an unknown option, a missing argument and no input are refused', () => {
  assert.equal(run(['-o', path.join(T, 'out4.txt'), path.join(T, 'nonexistent')]).status, 2);
  assert.ok(!existsSync(path.join(T, 'out4.txt')));
  assert.equal(run(['--bogus', 'x']).status, 2);
  assert.equal(run(['-o']).status, 2);
  assert.equal(run(['--note']).status, 2);
  assert.equal(run([]).status, 2);
  writeFileSync(path.join(T, 'empty.txt'), '# nothing\n\n');
  assert.equal(run(['-o', path.join(T, 'out5.txt'), path.join(T, 'empty.txt')]).status, 2, 'a file with no unit');
});
test('seconds round half up and a unit weighs at least 1', () => {
  writeFileSync(path.join(T, 'r.txt'), '0 zero-test\n1 half-test\n');
  writeFileSync(path.join(T, 'r2.txt'), '0 half-test\n');
  run(['-o', path.join(T, 'out6.txt'), path.join(T, 'r.txt'), path.join(T, 'r2.txt')]);
  const body = readFileSync(path.join(T, 'out6.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(body, ['1 half-test', '1 zero-test']);
});
