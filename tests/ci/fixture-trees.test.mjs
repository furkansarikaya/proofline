// @ts-check
// Every fixture builder, with every argument variant its callers use, builds the tree recorded in fixtures/TREES.sha256 (the digests were first
// taken from the shell builders: package B of issue #176 proved the Node builders byte-identical). Regenerate on purpose: node tests/fixtures/trees.mjs --update
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, recorded, verify } from '../fixtures/trees.mjs';

// File modes are POSIX permission bits; a Windows checkout reports other bits for the same file, so the guard runs where the digests were made.
test('the fixture builders build the recorded trees', { skip: process.platform === 'win32' && 'POSIX permission bits', timeout: 600000 }, async () => {
  assert.ok(existsSync(recorded), 'fixtures/TREES.sha256 is missing');
  assert.ok(parse(readFileSync(recorded, 'utf8')).size >= 40);
  assert.deepEqual(await verify(), []);
});
