// @ts-check
// The two helpers of tests/lib/winpath.mjs (A261): off Windows they change nothing, on win32 `launch` starts a Node script through node and `posix` gives the form the core stores.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch, nullDevice, posix, skipOnWin32 } from './winpath.mjs';

test('launch: the program and arguments as given off Windows; node and the script as the first argument on win32', () => {
  for (const p of ['linux', 'darwin']) assert.deepEqual(launch('/r/bin/proofline', ['version', '-x'], p), { program: '/r/bin/proofline', args: ['version', '-x'] });
  assert.deepEqual(launch('D:\\r\\bin\\proofline', ['version'], 'win32'), { program: process.execPath, args: ['D:\\r\\bin\\proofline', 'version'] });
});

test('posix: identity off Windows (a backslash is a file name character there); forward slashes and an upper-case drive on win32', () => {
  for (const p of ['/a/b', 'a\\b', 'c:\\x', '']) assert.equal(posix(p, 'linux'), p);
  assert.equal(posix('c:\\Users\\x/y', 'win32'), 'C:/Users/x/y');
});

test('nullDevice: os.devNull unchanged off Windows; NUL on win32, where os.devNull (`\\\\.\\nul`) is refused by git', () => {
  for (const p of ['linux', 'darwin']) assert.equal(nullDevice(p, '/dev/null'), '/dev/null');
  assert.equal(nullDevice('win32', '\\\\.\\nul'), 'NUL');
});

test('skipOnWin32: the function itself off Windows; on win32 every call gets skip with the reason, with or without options', () => {
  const f = () => {};
  assert.equal(skipOnWin32(f, 'why', 'linux'), f);
  assert.equal(skipOnWin32(f, 'why', 'darwin'), f);
  /** @type {any[]} */ const seen = [];
  const rec = /** @type {any} */ ((/** @type {any[]} */ ...a) => { seen.push(a); });
  const w = /** @type {any} */ (skipOnWin32(rec, 'why', 'win32'));
  const body = () => {};
  w('a', body); w('b', { timeout: 5 }, body);
  assert.deepEqual(seen, [['a', { skip: 'why' }, body], ['b', { timeout: 5, skip: 'why' }, body]]);
});
