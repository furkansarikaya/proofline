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
  for (const cp of [0x10000, 0x10001, 0x1000f, 0x1d400, 0x1f600, 0x10ffff, 0xffff, 0xfffe, 0xe0001]) for (const mode of ['first', 'mid']) { const r = run(mode, cp, cp); out.push(`U+${cp.toString(16)} ${mode} status=${r.status}`); }
  for (let plane = 1; plane <= 16; plane++) {
    for (let lo = plane * 0x10000; lo < (plane + 1) * 0x10000; lo += 0x1000) {
      const hi = Math.min(lo + 0xfff, 0x10ffff);
      if (lo === 0x10000 || (plane >= 3 && plane <= 13)) { if (lo !== plane * 0x10000 && !(lo === 0x10000)) continue; }
      const r = run('first', lo, hi);
      if (r.status !== 0) out.push(`chunk ${lo.toString(16)}-${hi.toString(16)} crashes status=${r.status}`);
    }
  }
  const r2 = run('mid', 0x10000, 0x10fff); out.push(`mid 10000-10fff status=${r2.status}`);
  console.log('PROBE\n' + out.join('\n'));
});
