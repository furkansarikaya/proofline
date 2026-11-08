// Proves the planted facts of the verify-proof fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enter, fail, git, gitOut, has, nodeOk, read, repoRootOf } from '../selfcheck-lib.mjs';

enter();
const tmp = mkdtempSync(path.join(tmpdir(), 'verify-proof-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

if (!read('.agents/runs/FX-VP/RUN.yaml').split('\n').includes(`base_sha: ${gitOut(['rev-parse', 'base'])}`)) fail('RUN.yaml base_sha');
if (gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'proofline/FX-VP-username-rules') fail('not on the task branch');

// The planted PLAN.md is a valid plan-contract plan (no `task:` key, every required section).
if (!nodeOk([path.join(repoRootOf(import.meta.url), 'skills/plan-contract/scripts/validate-plan.mjs'), '.agents/runs/FX-VP/PLAN.md', '.agents/runs/FX-VP/TASK.md', '--class', 'STANDARD', '--repo', '.'])) fail('PLAN.md does not pass validate-plan.mjs');

// Changed files: exactly the three scoped paths plus src/config.js (out of scope).
const changed = `${gitOut(['diff', '--name-only', 'base', 'HEAD']).split('\n').join(' ')} `;
if (changed !== 'src/config.js src/username.js test/username-case.test.js test/username.test.js ') fail(`unexpected diff: ${changed}`);

// The username tests pass and the implementation meets AC-2.
const tests = ['--test', 'test/username.test.js', 'test/username-case.test.js'];
if (!nodeOk(tests)) fail('username tests must pass');
if (!nodeOk(['-e', "import('./src/username.js').then(m => process.exit(m.validUsername('Alice') === false && m.validUsername('alice') === true ? 0 : 1))"])) fail('implementation must satisfy AC-2');

// AC-2 is untested: a mutant that accepts uppercase still passes every username test.
const original = path.join(tmp, 'username.js');
copyFileSync('src/username.js', original);
const restore = () => copyFileSync(original, 'src/username.js');
writeFileSync('src/username.js', readFileSync(original, 'utf8').split('\n').filter((l) => !l.includes('[A-Z]')).join('\n').replace('/^[a-z0-9_]+$/', '/^[a-z0-9_]+$/i'));
if (!nodeOk(['-e', "import('./src/username.js').then(m => process.exit(m.validUsername('Alice') === true ? 0 : 1))"])) { restore(); fail('mutant does not accept uppercase'); }
if (!nodeOk(tests)) { restore(); fail('AC-2 mutant was caught: AC-2 is tested'); }
restore();

// Pre-existing failure: test/date.test.js fails at HEAD and at base.
if (nodeOk(['--test', 'test/date.test.js'])) fail('date test must fail at HEAD');
git(['worktree', 'add', '-q', '--detach', path.join(tmp, 'base'), 'base']);
const baseFails = !nodeOk(['--test', 'test/date.test.js'], { cwd: path.join(tmp, 'base') });
git(['worktree', 'remove', '--force', path.join(tmp, 'base')]);
if (!baseFails) fail('date test must fail at base');

// The full verification command fails only because of the pre-existing test.
if (nodeOk(['--test'])) fail('node --test must fail');

if (gitOut(['status', '--porcelain']) !== '') fail('selfcheck left the tree dirty');
console.log('selfcheck: verify-proof ok');
