import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
const child = `
const fs = require('node:fs'); const { join } = require('node:path'); const os = require('node:os');
const dir = fs.mkdtempSync(join(os.tmpdir(), 'pr-'));
const [mode, lo, hi] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])];
for (let cp = lo; cp <= hi; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  const p = mode === 'mid' ? join(dir, 'a' + c + 'b') : join(dir, c);
  try { fs.lstatSync(p); fs.statSync(p); } catch {}
  try { fs.realpathSync.native(p); } catch {}
  try { fs.existsSync(p); } catch {}
}
console.log('OK');
`;
const run = (mode, lo, hi) => spawnSync(process.execPath, ['-e', child, mode, String(lo), String(hi)], { encoding: 'utf8' });
test('probe astral aborts', () => {
  const out = [];
  for (let plane = 0; plane <= 16; plane++) for (const off of [0, 1, 0xfffe, 0xffff]) { const cp = plane * 0x10000 + off; if (cp < 0x80) continue; const r = run('first', cp, cp); if (r.status !== 0) out.push(`U+${cp.toString(16)} aborts`); }
  for (let lo = 0x10f000; lo < 0x110000; lo += 0x100) { const r = run('first', lo, lo + 0xff); if (r.status !== 0) { out.push(`chunk ${lo.toString(16)} aborts`); for (let cp = lo; cp < lo + 0x100; cp++) { const q = run('first', cp, cp); if (q.status !== 0) out.push(`  U+${cp.toString(16)}`); } } }
  for (let plane = 2; plane <= 14; plane++) for (let lo = plane * 0x10000 + 0x1000; lo < (plane + 1) * 0x10000; lo += 0x1000) { const r = run('first', lo, lo + 0xfff); if (r.status !== 0) out.push(`plane chunk ${lo.toString(16)} aborts`); }
  console.log('PROBE\n' + out.join('\n') + '\nDONE');
});
