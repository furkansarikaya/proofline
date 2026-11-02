// @ts-check
// T3 port of tests/equivalence/glob-differential.test.mjs: the path-glob dialect of globToRegExp (ecosystems.mjs) against the answers the shell's awk program
// `g2re` gave for every pair of a corpus (patterns x paths), recorded ONCE (tests/fixtures/port-t3/glob.json.gz). Nothing runs awk at test time.
// The shell works on bytes, so both sides see the UTF-8 bytes of the strings.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { globToRegExp } from '../../control-plane/agents/ecosystems.mjs';

/** @type {{ patterns: string[], paths: string[], bits: string }} */
const g = JSON.parse(gunzipSync(readFileSync(new URL('../fixtures/port-t3/glob.json.gz', import.meta.url))).toString('utf8'));
const bytes = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');

test('the recorded corpus is large', () => { assert.ok(g.patterns.length * g.paths.length > 8000); assert.equal(g.bits.length, g.patterns.length * g.paths.length); });

test('globToRegExp gives the recorded shell answer on every pair of the corpus', () => {
  const bad = [];
  let i = 0;
  for (const p of g.patterns) for (const x of g.paths) { const got = globToRegExp(bytes(p)).test(bytes(x)) ? '1' : '0'; if (got !== g.bits[i]) bad.push(`pattern ${JSON.stringify(p)} path ${JSON.stringify(x)}: shell ${g.bits[i]}, js ${got}`); i++; }
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} of ${g.bits.length} pairs differ`);
});

test('on plain ASCII pairs the strings need no byte reading', () => {
  const bad = [];
  let i = 0;
  for (const p of g.patterns) for (const x of g.paths) { if (/^[\x00-\x7f]*$/.test(p + x) && (globToRegExp(p).test(x) ? '1' : '0') !== g.bits[i]) bad.push(`${JSON.stringify(p)} ${JSON.stringify(x)}`); i++; }
  assert.deepEqual(bad, []);
});
