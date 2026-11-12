// @ts-check
// The two helpers of tests/lib/winpath.mjs (A261): off Windows they change nothing, on win32 `launch` starts a Node script through node and `posix` gives the form the core stores.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch, posix } from './winpath.mjs';

test('launch: the program and arguments as given off Windows; node and the script as the first argument on win32', () => {
  for (const p of ['linux', 'darwin']) assert.deepEqual(launch('/r/bin/proofline', ['version', '-x'], p), { program: '/r/bin/proofline', args: ['version', '-x'] });
  assert.deepEqual(launch('D:\\r\\bin\\proofline', ['version'], 'win32'), { program: process.execPath, args: ['D:\\r\\bin\\proofline', 'version'] });
});

test('posix: identity off Windows (a backslash is a file name character there); forward slashes and an upper-case drive on win32', () => {
  for (const p of ['/a/b', 'a\\b', 'c:\\x', '']) assert.equal(posix(p, 'linux'), p);
  assert.equal(posix('c:\\Users\\x/y', 'win32'), 'C:/Users/x/y');
});
