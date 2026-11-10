// @ts-check
// posix(): the one place where a native path becomes the forward-slash spelling the hook compares in (A246, nightly hook-windows). On Windows the
// physical path of a directory is `C:\Users\runneradmin\...`; every guard compares `${root}/...` strings, so a backslash root made the kill guard
// refuse to read a script, stashPath refuse a temp dir and the worktree list disagree with git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from '../../adapters/claude/hooks/lib/text.mjs';

test('a Windows path takes forward slashes, the drive stays', () => {
  assert.equal(posix('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x', '\\'), 'C:/Users/runneradmin/AppData/Local/Temp/x');
  assert.equal(posix('C:/already/posix', '\\'), 'C:/already/posix');
});
test('elsewhere a backslash is a file name character and nothing changes', () => {
  assert.equal(posix('/tmp/a\\b', '/'), '/tmp/a\\b');
  assert.equal(posix('/tmp/x', '/'), '/tmp/x');
});
test('the default separator is the platform one', () => {
  assert.equal(posix('/a/b'), '/a/b');
});
