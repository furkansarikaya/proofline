import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const child = `
const { lstatSync, writeFileSync, mkdtempSync } = require('node:fs'); const { join } = require('node:path'); const { tmpdir } = require('node:os');
const [lo, hi] = [Number(process.argv[1]), Number(process.argv[2])];
const dir = mkdtempSync(join(tmpdir(), 'bis-'));
for (const n of 'abcdefghijklmnopqrstuvwxyz0123456789') writeFileSync(join(dir, n), '');
const hits = [];
for (let cp = lo; cp <= hi; cp++) { if (cp >= 0xd800 && cp <= 0xdfff) continue; const c = String.fromCodePoint(cp); try { lstatSync(join(dir, c)); hits.push(cp.toString(16)); } catch {} }
console.log('HITS ' + hits.join(','));
`;
test('bisect the lstat crash', () => {
  const out = [];
  const ranges = []; for (let lo = 0x10000; lo <= 0x1ffff; lo += 0x1000) ranges.push([lo, lo + 0xfff]);
  for (const [lo, hi] of ranges) {
    const r = spawnSync(process.execPath, ['-e', child, String(lo), String(hi)], { encoding: 'utf8' });
    out.push(`${lo.toString(16)}-${hi.toString(16)} status=${r.status} ${(r.stdout || '').trim()} ${(r.stderr || '').slice(0, 200)}`);
  }
  console.log('BISECT\n' + out.join('\n'));
});
