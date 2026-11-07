// @ts-check
// A232 fix round: bin/proofline without Node on the PATH. Every command that needs the Node core stops with one message and a non-zero status (it used to print
// empty config values and exit 0); help, version and init do not need it here; doctor prints its FAIL line and summary and exits 1. Also: doctor ignores extra
// arguments after a flag like the shell did.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PL, sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const SYSTEM = '/usr/bin:/bin';
const hasNode = spawnSync('sh', ['-c', 'command -v node'], { env: { PATH: SYSTEM } }).status === 0;
const opts = { skip: hasNode ? 'node is in /usr/bin or /bin here' : false };
const noNode = (/** @type {string} */ dir, /** @type {string[]} */ args) => {
  const r = spawnSync('/bin/sh', [PL, ...args], { cwd: dir, env: { ...sb.env, PATH: SYSTEM }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

test('without node every command except help, version, init and doctor stops with one message and a non-zero status', opts, () => {
  const d = sb.copy('nn1');
  for (const args of [['task', 'x'], ['run', 'T-1'], ['design', 'system'], ['deliver', 'T-1'], ['status'], ['queue'], ['insights'], ['merge', '7'], ['upgrade'], ['doctor', '--scale']]) {
    const r = noNode(d, args);
    assert.notEqual(r.status, 0, args.join(' '));
    assert.equal(r.err, 'proofline: node is not on PATH; proofline needs Node 22.13 or newer\n', args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  }
});

test('without node help and version work, and doctor reports the missing node as a FAIL with the summary and status 1', opts, () => {
  const d = sb.copy('nn2');
  assert.equal(noNode(d, ['help']).status, 0);
  assert.match(noNode(d, ['version']).out, /^proofline [0-9.]+\n$/);
  const r = noNode(d, ['doctor']);
  assert.equal(r.status, 1);
  assert.equal(r.out, 'FAIL node: not found on PATH; proofline needs Node 22.13 or newer (the commands that run in Node exit 127 and the guards that need them deny; install it)\ndoctor: 1 FAIL, 0 WARN\n');
  assert.equal(r.err, '');
});

test('doctor ignores extra arguments after a flag (the shell read only the first)', () => {
  const bare = sb.mkrepo('nn3');
  const r = sb.pl(bare, ['doctor', '--scale', 'extra']);
  assert.equal(r.status, 1);
  assert.match(r.err, /proofline: proofline is not installed in /);
  assert.ok(!r.text.includes('unknown argument'));
});
