// @ts-check
// Stage 4, package 4C security review: the built-in scan fails closed. Only the head of a file decides "binary" (as grep -I did), an unreadable file is an
// error that names it (never a silent skip), and the delivery check's shell scan reaches the core scanner when the project has no scanner script.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinScan } from '../../control-plane/agents/scripts/core/secretscan.mjs';

const ctx = /** @type {any} */ ({ childEnv: () => ({ ...process.env, LC_ALL: 'C' }) });
const key = `AKIA${'ABCDEFGHIJKLMNOP'}`;

test('a secret before a late NUL byte is reported; a NUL in the head makes a file binary', () => {
  const d = tempDir('ss4c-');
  try {
    writeFileSync(join(d, 'late.txt'), `k = "${key}"\n${'x'.repeat(200 * 1024)}\n\0tail\n`);
    writeFileSync(join(d, 'head.bin'), `\0 ${key}\n`);
    const r = builtinScan(ctx, d, ['late.txt']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'late.txt:1:aws_access_key_id\n');
    assert.equal(builtinScan(ctx, d, ['head.bin']).status, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('an unreadable file fails the scan closed and names the path', { skip: process.getuid?.() === 0 ? 'root reads a mode 0 file' : process.platform === 'win32' ? 'NTFS ignores chmod 0: no file is unreadable there without an ACL, which the test does not set up (the POSIX run keeps the check)' : false }, () => {
  const d = tempDir('ss4c-');
  try {
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src/locked.txt'), `x = "${key}"\n`);
    chmodSync(join(d, 'src/locked.txt'), 0);
    for (const target of ['src/locked.txt', 'src', '.']) {
      const r = builtinScan(ctx, d, [target]);
      assert.equal(r.status, 2, target);
      assert.match(r.stderr, /src\/locked\.txt/, target);
    }
  } finally { chmodSync(join(d, 'src/locked.txt'), 0o600); rmSync(d, { recursive: true, force: true }); }
});
