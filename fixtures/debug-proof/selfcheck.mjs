// Proves the planted facts of the debug-proof fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const gitr = (/** @type {string[]} */ args, /** @type {string} */ cwd = dir) => run('git', args, { cwd, env });
const git = (/** @type {string[]} */ ...a) => gitr(a).out.trim();

if (Number(git('rev-list', '--count', 'HEAD')) !== 8) fail('expected 8 commits');
const revs = git('rev-list', '--reverse', 'HEAD').split('\n');
const [c3, c4, c5] = [revs[2], revs[3], revs[4]];
if (git('rev-parse', 'v1.0') !== revs[1]) fail('v1.0 is not commit 2');
if (git('log', '-1', '--format=%s', c5) !== 'style: tidy formatCents') fail('commit 5 subject');

const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'debug-proof-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
/** The module src/money.js at a revision, imported (each call is a distinct file). @param {string} rev */
async function moneyAt(rev) {
  const f = path.join(tmp, `money-${seq++}.mjs`);
  writeFileSync(f, gitr(['show', `${rev}:src/money.js`]).out);
  return import(pathToFileURL(f).href);
}
const fmtAt = async (/** @type {string} */ rev, /** @type {number} */ cents) => (await moneyAt(rev)).formatCents(cents);

if (await fmtAt('v1.0', 1205) !== '12.05') fail('v1.0 must format 1205 as 12.05');
if (await fmtAt(c4, 1205) !== '12.05') fail('commit 4 must still be good');
if (await fmtAt(c5, 1205) !== '12.50') fail('commit 5 must be the first bad commit');
if (await fmtAt('HEAD', 1205) !== '12.50') fail('HEAD must show the bug');

// Decoy: commit 3 formats every integer exactly like v1.0.
{
  const a = await moneyAt('v1.0'); const b = await moneyAt(c3);
  for (let c = -100000; c <= 100000; c++) if (a.formatCents(c) !== b.formatCents(c)) { console.error('differs at', c); fail('commit 3 is not harmless'); }
}

// The suite at HEAD passes: the bug is not covered by any test.
if (run('node', ['--test', ...readdirSync(path.join(dir, 'test')).filter((n) => n.endsWith('.test.js')).sort().map((n) => `test/${n}`)], { cwd: dir }).status !== 0) fail('HEAD test suite must pass');

// Bisect between v1.0 and HEAD names commit 5.
const wt = path.join(tmp, 'wt');
gitr(['worktree', 'add', '-q', '--detach', wt, 'HEAD']);
gitr(['bisect', 'start', 'HEAD', 'v1.0'], wt);
const b = gitr(['bisect', 'run', 'node', '-e', "import('./src/money.js').then(m => process.exit(m.formatCents(1205) === '12.05' ? 0 : 1))"], wt);
if (b.status !== 0) { process.stderr.write(b.text); process.exit(1); }
const firstBad = gitr(['rev-parse', 'refs/bisect/bad'], wt).out.trim();
gitr(['bisect', 'reset'], wt);
if (firstBad !== c5) fail('bisect did not name commit 5');
gitr(['worktree', 'remove', '--force', wt]);
console.log('selfcheck: debug-proof ok');
