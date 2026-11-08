// Proves the known answers (EXPECTED.md) of the insights fixture built in <dir>, and that the command is read-only.
// usage: node selfcheck.mjs <built-dir>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { enter, fail, repoRootOf, run } from '../selfcheck-lib.mjs';

const PL = path.join(repoRootOf(import.meta.url), 'bin/proofline');
const dir = enter();
/** every file (outside .git) with its sha256, sorted: the read-only proof */
function sig() {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const n of readdirSync(d)) {
      if (n === '.git') continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out.push(`./${path.relative(dir, p).split(path.sep).join('/')} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}
const before = sig();
const r = run(process.execPath, [PL, 'insights']);
if (r.status !== 0) fail('insights failed');
const out = r.out;
const has = (/** @type {string} */ re) => { if (!new RegExp(re, 'm').test(out)) { process.stderr.write(`${out}\n`); fail(`missing: ${re}`); } };
const no = (/** @type {string} */ re) => { if (new RegExp(re, 'm').test(out)) { process.stderr.write(`${out}\n`); fail(`unexpected: ${re}`); } };
has('^  RUN-A +done +900s +3 +6000 \\(2/3\\) +1000 \\(2/3\\) +7000 \\(2/3\\) +1 +4 +1$');
has('^  RUN-B +failed +500s +3 +2000 \\(1/3\\) +300 \\(1/3\\) +6300 \\(2/3\\) +0 +2 +0$');
has('^  RUN-C +open +n/a +1 +n/a +n/a +n/a +0 +n/a +n/a$');
has('^  reviewer +sonnet +3 +300s +3000 \\(2/3\\) +500 \\(2/3\\) +3500 \\(2/3\\) +1$');
has('^  implementer +gpt-5 +2 +350s +5000 \\(1/2\\) +800 \\(1/2\\) +9800 +0$');
has('total over 7 dispatch\\(es\\): duration 750s, tokens in 8000 \\(3/7\\), tokens out 1300 \\(3/7\\), tokens total 13300 \\(4/7\\), retries 1');
has('total over 2 finished run\\(s\\): duration 1400s, delegations 6, fix rounds 1');
has('1 non-JSON line\\(s\\) ignored');
has('1 duplicate run record\\(s\\) ignored');
has('1 with an unknown schema skipped');
no('777777');
no('999999');
has('repeated-finding x3: REVIEW_RULES src/a\\.go: Error from Close is ignored');
has('runs: RUN-A,RUN-B$');
no('Error from Open is ignored');
no('Consider a doc comment');
has('gate-fail x3: REVIEW_RULES');
no('gate-fail x[0-9]+: SECURITY');
has('scope x2: ');
has('unsupported x2: .*no benchmark tool in the project');
no('unsupported x[0-9]+: .*headless browser');
has('approval x2: plan');
no('approval x[0-9]+: destructive');
if (before !== sig()) fail('insights changed a file');
console.log('selfcheck: insights ok');
