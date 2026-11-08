// Proves the planted facts of the tdd-proof fixture built in <dir>. usage: node selfcheck.mjs <built-dir>
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enter, fail, gitOut, nodeOk, run } from '../selfcheck-lib.mjs';

enter();
const tmp = mkdtempSync(path.join(tmpdir(), 'tdd-proof-selfcheck-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// Existing suite passes, including the colleague's AC-3 test, before any change.
if (!nodeOk(['--test', 'test/format.test.js', 'test/format-zero.test.js'])) fail('baseline suite must pass');

// Trap: the obvious first test for AC-1 fails to load (missing export), not on an assertion.
writeFileSync('test/zz-naive.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.js';
test('parses', () => { assert.equal(parseDuration('1h30m'), 5400); });
`);
let r = run(process.execPath, ['--test', 'test/zz-naive.test.js']);
if (r.status === 0) fail('naive test must fail');
if (!r.text.includes("does not provide an export named 'parseDuration'")) fail('naive failure is not a missing-export SyntaxError');
if (r.text.includes('AssertionError')) fail('naive failure must not be an assertion failure');

// With a stub, the same test fails on an assertion (a valid RED).
const orig = path.join(tmp, 'duration.js.orig');
copyFileSync('src/duration.js', orig);
appendFileSync('src/duration.js', '\nexport function parseDuration(text) {\n  return 0;\n}\n');
r = run(process.execPath, ['--test', 'test/zz-naive.test.js']);
if (r.status === 0) fail('stubbed test must fail');
if (!r.text.includes('AssertionError')) fail('stubbed failure must be an assertion failure');
copyFileSync(orig, 'src/duration.js');
unlinkSync('test/zz-naive.test.js');

// Hollow: the colleague's AC-3 test passes without the change (above) and with a correct change.
const fixed = readFileSync('src/duration.js', 'utf8').split('\n').map((l) => (l === '  return out;' ? "  return out || '0s';" : l)).join('\n');
if (!fixed.includes("out || '0s'")) fail('could not build the fixed variant');
writeFileSync('src/duration.js', fixed);
if (!nodeOk(['-e', "import('./src/duration.js').then(m => process.exit(m.formatDuration(0) === '0s' ? 0 : 1))"])) fail('fixed variant wrong');
if (!nodeOk(['--test', 'test/format-zero.test.js'])) fail('colleague test must pass after the change too');
copyFileSync(orig, 'src/duration.js');
if (!nodeOk(['-e', "import('./src/duration.js').then(m => process.exit(m.formatDuration(0) === '' ? 0 : 1))"])) fail('baseline formatDuration(0) must be empty');

if (gitOut(['status', '--porcelain']) !== '') fail('selfcheck left the tree dirty');
console.log('selfcheck: tdd-proof ok');
