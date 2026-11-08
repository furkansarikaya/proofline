// Proves the planted facts of the task-planning fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fail, repoRoot, run } from '../../tests/lib/fixture.mjs';

const dir = path.resolve(process.argv[2] ?? fail('usage: node selfcheck.mjs <built-dir>'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const v = path.join(repoRoot, 'skills/task-author/scripts/validate-task.mjs');
for (const t of ['T-1', 'T-2']) {
  const file = `.agents/tasks/${t}.md`;
  if (run('node', [v, file, '--tasks-dir', '.agents/tasks'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }).status !== 0) fail(`${t} must validate`);
  const text = readFileSync(path.join(dir, file), 'utf8');
  if (!/^# Task: /.test(text.split('\n')[0])) fail(`${t} line 1 must be the H1`);
  if (text.split('\n')[0].replace(/^# Task: ([^ ]*) .*/, '$1') !== t) fail(`${t} id not read from line 1`);
  if (!text.includes('docs/adr/0001-use-postgres.md')) fail(`${t} must link the ADR`);
}
if (!existsSync(path.join(dir, 'docs/adr/0001-use-postgres.md'))) fail('linked ADR missing');
if (!existsSync(path.join(dir, '.agents/local/team.yaml'))) fail('team.yaml missing');
const git = (/** @type {string[]} */ ...a) => run('git', a, { cwd: dir, env });
if (git('check-ignore', '-q', '.agents/local/team.yaml').status !== 0) fail('team.yaml must be git-ignored');
const status = git('status', '--porcelain').out;
if (status.includes('team.yaml')) fail('team.yaml shows in git status');
if (/\.agents\/local/.test(status)) fail('.agents/local shows in git status');
console.log('selfcheck: ok');
