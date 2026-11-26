// @ts-check
// U8 (issue 338 R1-18, R2-19, R3-14, R4-12): the tar.gz reader of `proofline retro` (core/tarlite.mjs). It reads in process, from a bounded buffer, and writes nothing: a `../` name, an absolute name,
// a link and a device are counted as refused and never used, a gzip bomb and an archive with too many entries stop at a limit, and a damaged archive says why instead of giving a guess.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { tempDir } from '../lib/tempdir.mjs';
import { tarBuffer, tgzBuffer } from '../lib/tarmake.mjs';
import { readTarGz } from '../../control-plane/agents/scripts/core/tarlite.mjs';

const want = (/** @type {string} */ n) => (/^[A-Za-z0-9_-]+\/(LEDGER\.log|RUN\.yaml)$/.test(n) ? n : null);
const T = tempDir('retro-tar-');
const put = (/** @type {string} */ name, /** @type {Buffer} */ b) => { const f = path.join(T, name); writeFileSync(f, b); return f; };
const listing = () => readdirSync(T).sort().join(',');

test('the wanted files of a run folder are read as byte strings; the others are skipped', () => {
  const f = put('ok.tar.gz', tgzBuffer([{ name: 'R-1/', type: '5' }, { name: 'R-1/LEDGER.log', data: 'seq=1 line\n' }, { name: 'R-1/other.txt', data: 'x' }, { name: 'R-1/RUN.yaml', data: 'a: b\n' }]));
  const r = readTarGz(f, want);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.files.keys()].sort(), ['R-1/LEDGER.log', 'R-1/RUN.yaml']);
  assert.equal(r.files.get('R-1/LEDGER.log'), 'seq=1 line\n');
  assert.equal(r.refused, 0);
});

test('a ../ name, an absolute name, a symbolic link, a hard link and a device are refused and counted; nothing is created anywhere', () => {
  const f = put('evil.tar.gz', tgzBuffer([
    { name: '../evil', data: 'x' }, { name: '/etc/evil', data: 'x' }, { name: 'R-2/../../up', data: 'x' },
    { name: 'R-2/LEDGER.log', type: '2', linkname: '/etc/passwd' }, { name: 'R-2/RUN.yaml', type: '1', linkname: 'R-2/LEDGER.log' }, { name: 'R-2/dev', type: '3' },
    { name: 'R-2/LEDGER.log', data: 'real\n' },
  ]));
  const before = listing();
  const r = readTarGz(f, want);
  assert.equal(r.ok, true);
  assert.equal(r.files.get('R-2/LEDGER.log'), 'real\n');
  assert.equal(r.files.size, 1);
  assert.equal(r.refused, 6);
  assert.equal(listing(), before);
  assert.ok(!readdirSync(path.dirname(T)).includes('evil'));
});

test('a gzip bomb stops at the inflated limit and says too-large; an archive over the compressed limit is not read at all', () => {
  const bomb = put('bomb.tar.gz', gzipSync(Buffer.alloc(8 * 1024 * 1024)));
  const r = readTarGz(bomb, want, { inflatedBytes: 1024 * 1024 });
  assert.equal(r.ok, false); assert.equal(r.why, 'too-large'); assert.equal(r.files.size, 0);
  const small = readTarGz(put('big.tar.gz', tgzBuffer([{ name: 'R-3/LEDGER.log', data: 'x\n'.repeat(5000) }])), want, { archiveBytes: 64 });
  assert.equal(small.ok, false); assert.equal(small.why, 'archive-too-large');
});

test('too many entries and an entry over the size limit are limits, not guesses', () => {
  const many = tgzBuffer(Array.from({ length: 50 }, (_, i) => ({ name: `R-4/f${i}`, data: 'x' })));
  const r = readTarGz(put('many.tar.gz', many), want, { entries: 10 });
  assert.equal(r.ok, false); assert.equal(r.why, 'too-many-entries');
  const big = readTarGz(put('bigentry.tar.gz', tgzBuffer([{ name: 'R-5/LEDGER.log', data: 'x'.repeat(5000) }])), want, { entryBytes: 1000 });
  assert.equal(big.ok, true); assert.equal(big.files.size, 0); assert.deepEqual(big.tooLarge, ['R-5/LEDGER.log']);
});

test('damage is named: not gzip, a truncated tar, a bad header checksum, a missing file and a symbolic link or folder as the archive itself', () => {
  assert.equal(readTarGz(put('junk.tar.gz', Buffer.from('this is not gzip')), want).why, 'not-gzip');
  const good = tarBuffer([{ name: 'R-6/LEDGER.log', data: 'y'.repeat(2000) }]);
  assert.equal(readTarGz(put('cut.tar.gz', gzipSync(good.subarray(0, 700))), want).why, 'truncated');
  const bad = Buffer.from(good); bad[0] ^= 0x55;
  assert.equal(readTarGz(put('sum.tar.gz', gzipSync(bad)), want).why, 'bad-header');
  assert.equal(readTarGz(path.join(T, 'absent.tar.gz'), want).why, 'unreadable');
  const real = put('real.tar.gz', tgzBuffer([{ name: 'R-6/LEDGER.log', data: 'z\n' }]));
  symlinkSync(real, path.join(T, 'link.tar.gz'));
  assert.equal(readTarGz(path.join(T, 'link.tar.gz'), want).why, 'not-a-file');
  mkdirSync(path.join(T, 'dir.tar.gz'));
  assert.equal(readTarGz(path.join(T, 'dir.tar.gz'), want).why, 'not-a-file');
});

test('a pax header and a GNU long name give the real name of the next entry', () => {
  const rec = (/** @type {string} */ k, /** @type {string} */ v) => { const body = ` ${k}=${v}\n`; let len = body.length + 1; while (String(len).length + body.length !== len) len = String(len).length + body.length; return `${len}${body}`; };
  const f = put('pax.tar.gz', tgzBuffer([{ name: 'PaxHeader', type: 'x', data: rec('path', 'R-7/LEDGER.log') }, { name: 'short', data: 'from pax\n' }]));
  const r = readTarGz(f, want);
  assert.equal(r.ok, true);
  assert.equal(r.files.get('R-7/LEDGER.log'), 'from pax\n');
  const longName = `R-8/${'d'.repeat(120)}/LEDGER.log`;
  const g = readTarGz(put('gnu.tar.gz', tgzBuffer([{ name: '././@LongLink', type: 'L', data: `${longName}\0` }, { name: 'cut', data: 'gnu\n' }, { name: 'R-8/LEDGER.log', data: 'plain\n' }])), (n) => (n.endsWith('/LEDGER.log') ? n : null));
  assert.equal(g.files.get(longName), 'gnu\n');
  assert.equal(g.files.get('R-8/LEDGER.log'), 'plain\n');
});
