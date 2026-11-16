import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
const child = `
const fs = require('node:fs'); const { join } = require('node:path'); const os = require('node:os');
const dir = fs.mkdtempSync(join(os.tmpdir(), 'pr-'));
const [lo, hi] = [Number(process.argv[1]), Number(process.argv[2])];
for (let cp = lo; cp <= hi; cp++) {
  const c = String.fromCodePoint(cp);
  const p = join(dir, 'a' + c + 'b');
  try { fs.lstatSync(p); } catch {}
  try { fs.realpathSync.native(p); } catch {}
}
console.log('OK');
`;
const run = (lo, hi) => spawnSync(process.execPath, ['-e', child, String(lo), String(hi)], { encoding: 'utf8' });
test('probe planes 3-13', () => {
  const out = [];
  for (let plane = 3; plane <= 13; plane++) for (let lo = plane * 0x10000; lo < (plane + 1) * 0x10000; lo += 0x1000) {
    const r = run(lo, lo + 0xfff);
    if (r.status !== 0) { out.push(`chunk ${lo.toString(16)} aborts`); for (let cp = lo; cp < lo + 0x1000; cp += 0x100) { const q = run(cp, cp + 0xff); if (q.status !== 0) out.push(`  sub ${cp.toString(16)}`); } }
  }
  for (const cp of [0xd800, 0xdbff, 0xdc00, 0xdfff]) { const r = run(cp, cp); if (r.status !== 0) out.push(`lone surrogate ${cp.toString(16)} aborts`); }
  console.log('PROBE\n' + out.join('\n') + '\nDONE');
});
