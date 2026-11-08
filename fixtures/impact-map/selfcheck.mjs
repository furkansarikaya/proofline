// Proves the impact report on the impact-map fixture built in <dir> equals EXPECTED.json. usage: node selfcheck.mjs <built-dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const here = import.meta.dirname;
const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const sk = path.join(repoRoot, 'skills/evidence-map/scripts');
const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'impact-selfcheck.'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const report = path.join(tmp, 'report.json');
/** Run a step; its output goes through (as the shell's did) and a failure is the selfcheck's. @param {string} what @param {string[]} args */
const step = (what, args) => { const r = run('node', args); process.stdout.write(r.out); process.stderr.write(r.err); if (r.status !== 0) fail(what); };
step('impact.mjs failed', [path.join(sk, 'impact.mjs'), '--repo', dir, '--base', 'HEAD~1', '--out', report]);
step('report does not validate', [path.join(sk, 'validate-impact.mjs'), report, '--repo', dir]);
step('report differs from EXPECTED.json', [path.join(here, 'compare.mjs'), report, path.join(here, 'EXPECTED.json')]);
console.log('selfcheck: impact-map ok');
