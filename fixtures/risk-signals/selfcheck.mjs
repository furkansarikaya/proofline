// Compares `agent.sh pipeline RS-1` of the fixture built in <dir> with the known answer in EXPECTED.md (A78).
// usage: node selfcheck.mjs <built-dir>
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { enter, fail, run } from '../selfcheck-lib.mjs';

const here = import.meta.dirname;
enter();
/** The fenced block after `## Known answer`, sorted (the awk of the shell selfcheck: the first ``` block after that heading). */
function knownAnswer() {
  const out = []; let k = false; let inBlock = false;
  for (const l of readFileSync(path.join(here, 'EXPECTED.md'), 'utf8').split('\n')) {
    if (!k) { if (l.startsWith('## Known answer')) k = true; continue; }
    if (l.startsWith('```')) { if (inBlock) break; inBlock = true; continue; }
    if (inBlock) out.push(l);
  }
  return out.sort().join('\n');
}
const want = knownAnswer();
const r = run('sh', ['./.agents/scripts/agent.sh', 'pipeline', 'RS-1'], { env: { ...process.env, LC_ALL: 'C' } });
const got = r.out.split('\n').filter((l) => /^(gates|focus\.|signals|signal\.|missing_flag\.|design_role\.)/.test(l)).sort().join('\n');
if (want === '') { console.error('selfcheck: EXPECTED.md has no known answer'); process.exit(1); }
if (want !== got) {
  console.error('selfcheck: pipeline output differs from the known answer (- expected, + actual):');
  writeFileSync('known.txt', `${want}\n`); writeFileSync('actual.txt', `${got}\n`);
  const w = new Set(want.split('\n')); const g = new Set(got.split('\n'));
  for (const l of want.split('\n')) if (!g.has(l)) console.error(`-${l}`);
  for (const l of got.split('\n')) if (!w.has(l)) console.error(`+${l}`);
  process.exit(1);
}
console.log('selfcheck: risk-signals ok');
