// @ts-check
// bin/proofline without Node on the PATH (A233; before it was a shell program with its own message): the launcher is a Node program, so no command can run, and the shell
// that starts it says so with the status 127 and a message that names `node`. Also: doctor ignores extra arguments after a flag (the shell read only the first).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PL, sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const SYSTEM = '/usr/bin:/bin';
const hasNode = spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: SYSTEM } }).status === 0;
// Windows (W10): bin/proofline has no shebang launch there (it is started as `node <script>`, A261), so "node missing" is the answer of cmd or of the caller's shell, not a status 127 of
// `env` that our launcher line causes: nothing of ours runs without node, and nothing of ours can be asserted. The POSIX test keeps the contract.
const opts = { skip: process.platform === 'win32' ? 'the 127 comes from the POSIX shebang line (env node); Windows starts the launcher as `node <script>`' : hasNode ? 'node is in /usr/bin or /bin here' : false };

test('without node every command stops with the status 127 and a message that names node, and prints nothing on standard output', opts, () => {
  const d = sb.copy('nn1');
  for (const args of [['task', 'x'], ['run', 'T-1'], ['status'], ['queue'], ['insights'], ['merge', '7'], ['upgrade'], ['doctor'], ['help'], ['version'], ['init', '--yes']]) {
    const r = spawnSync(PL, args, { cwd: d, env: { ...sb.env, PATH: SYSTEM }, encoding: 'utf8' });
    assert.equal(r.status, 127, args.join(' '));
    assert.match(r.stderr, /node/, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('doctor ignores extra arguments after a flag (the shell read only the first)', () => {
  const bare = sb.mkrepo('nn3');
  const r = sb.pl(bare, ['doctor', '--scale', 'extra']);
  assert.equal(r.status, 1);
  assert.match(r.err, /proofline: proofline is not installed in /);
  assert.ok(!r.text.includes('unknown argument'));
});
