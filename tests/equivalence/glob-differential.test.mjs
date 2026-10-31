// @ts-check
// Differential test of the two implementations of the path-glob dialect (issue #166): the awk `g2re` program inside agent.sh (0.0.40, extracted
// from the file as it is, so the test follows the shell while it exists) against `globToRegExp` of ecosystems.mjs, over a path x pattern corpus.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { globToRegExp } from '../../control-plane/agents/ecosystems.mjs';
import { scriptsSrc } from './fixture.mjs';

const agent = readFileSync(join(scriptsSrc, 'agent.sh'), 'utf8');
const awkSource = /^g2re_awk='([\s\S]*?)'$/m.exec(agent)?.[1];

const PATTERNS = [...new Set([
  '*', '**', '**/', '*/', '/', '*.js', '*.test.mjs', 'src/*.js', 'src/**', 'src/**/', 'src/**/*.js', '**/*.js', '**/src', 'src/**/x', 'a/**/b/**/c', '**/**', '**/**/x', 'a**b', 'a**', '**a',
  'a/*/b', 'a/*', '*/a', '?', '??', 'a?c', '?.js', 'src/?', '*?', '?*', 'a*b*c', 'a***b', '***', '*/**', '**/*', '**/*/**', 'package.json', 'src/index.js', '.env', '.env.*', '.*', '*.', 'a.b', 'a.b.c',
  'a+b', 'a(b)', 'a|b', 'a^b', 'a$b', 'a[b]', 'a[0-9]', '[ab]', 'a{b,c}', '{a,b}', 'a\\b', '\\*', 'a\\', '.', '..', '*.d.ts', 'docs/*.md', 'docs/**/*.md', 'node_modules/**', '**/node_modules/**',
  '*.[jt]s', '!a', '#a', 'a#b', '~', 'a~', 'dir/', 'dir/**', 'dir/*/', '/abs', '/abs/*', 'café', '*é', '?é', '??', '日*', '*.日本', 'a b', 'a%b', 'a&b', 'a,b', 'a;b', 'a=b', 'a@b',
])];
const PATHS = [
  '', 'a', 'ab', 'abc', 'a/b', 'a/b/c', 'a/b/c/d', 'a/x/b', 'a/x/y/b/z/c', 'a.b', 'a.b.c', 'a+b', 'a(b)', 'a|b', 'a^b', 'a$b', 'a[b]', 'a[0-9]', 'a0', 'a{b,c}', 'ab,c', 'b', 'a\\b', 'a\\', '*', '?',
  'x.js', 'src/x.js', 'src/a/x.js', 'src/a/b/x.js', 'src/x.test.mjs', 'x.test.mjs', 'src', 'src/', 'src/x', 'src/x/', 'src/a/x', 'a/src', 'a/src/x', 'lib/src/x/y', 'src/index.js', 'index.js', 'package.json',
  'a/package.json', 'a/b/package.json', '.env', '.env.local', 'a/.env', '.hidden', 'a/.hidden/x', '.', '..', 'a.', 'a..b', 'x.d.ts', 'a/x.d.ts', 'docs/readme.md', 'docs/a/readme.md', 'docs/a/b/readme.md', 'node_modules/x/y.js',
  'a/node_modules/x/y.js', 'node_modules', 'dir', 'dir/', 'dir/x', 'dir/x/', 'dir/x/y', '/abs', '/abs/x', '/abs/x/y', 'a/', '/', '//', 'a//b', 'x.ts', 'x.jt', 'x.s', 'café', 'café/x', 'é', 'xxé', '日', '日本',
  'x.日本', 'a b', 'a b/c', 'a%b', 'a&b', 'a,b', 'a;b', 'a=b', 'a@b', '!a', '#a', 'a#b', '~', 'a~', 'a-b', 'a_b', 'A', 'AB', 'abc/abc/abc', 'a/a/a/a/a/a/a/a', 'src/a.js/b', 'a.js.map', 'x.test.mjs.snap',
];

test('the corpus is large and the awk program was found', () => {
  assert.ok(awkSource, 'g2re_awk not found in agent.sh'); assert.ok(PATTERNS.length * PATHS.length > 8000, String(PATTERNS.length * PATHS.length));
});

/** awk under LC_ALL=C: one result per pair. */
function awkResults(/** @type {string[][]} */ pairs) {
  const dir = mkdtempSync(join(tmpdir(), 'eq-glob.'));
  const prog = join(dir, 'g.awk'); const input = join(dir, 'pairs.tsv');
  writeFileSync(prog, `${awkSource}\nBEGIN { FS = "\\t" } { print ($2 ~ g2re($1)) ? 1 : 0 }\n`);
  writeFileSync(input, pairs.map(([p, x]) => `${p}\t${x}`).join('\n') + '\n');
  const r = spawnSync('awk', ['-f', prog, input], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1 << 26 });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const got = r.stdout.split('\n').filter(Boolean); assert.equal(got.length, pairs.length);
  return got;
}
const pairs = PATTERNS.flatMap((p) => PATHS.map((x) => [p, x]));
const bytes = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('latin1');

test('awk g2re and globToRegExp agree on every pair of the corpus (the shell works on bytes: both sides see the UTF-8 bytes)', () => {
  const got = awkResults(pairs);
  const bad = pairs.flatMap(([p, x], i) => (globToRegExp(bytes(p)).test(bytes(x)) ? '1' : '0') === got[i] ? [] : [`pattern ${JSON.stringify(p)} path ${JSON.stringify(x)}: awk ${got[i]}, js ${globToRegExp(bytes(p)).test(bytes(x)) ? 1 : 0}`]);
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} of ${pairs.length} pairs differ`);
});

test('the corpus has every pair on ASCII text agreeing with globToRegExp on plain strings', () => {
  const ascii = pairs.filter(([p, x]) => /^[\x00-\x7f]*$/.test(p + x));
  const got = awkResults(ascii);
  const bad = ascii.flatMap(([p, x], i) => (globToRegExp(p).test(x) ? '1' : '0') === got[i] ? [] : [`${JSON.stringify(p)} ${JSON.stringify(x)}`]);
  assert.deepEqual(bad, []);
});

test('finding (reported, not asserted away): globToRegExp on a JavaScript string counts characters where g2re counts bytes', (t) => {
  const got = awkResults(pairs);
  const bad = pairs.flatMap(([p, x], i) => (globToRegExp(p).test(x) ? '1' : '0') === got[i] ? [] : [`${JSON.stringify(p)} ${JSON.stringify(x)}`]);
  t.diagnostic(`${bad.length} pairs differ when the strings are not read as bytes: ${bad.join('; ')}`);
  // every difference involves a non-ASCII path and a ? in the pattern (a ? is one byte in awk and one UTF-16 unit in JavaScript)
  for (const b of bad) { const [p, x] = JSON.parse(`[${b.replace(' "', ', "')}]`); assert.ok(/\?/.test(p) && /[^\x00-\x7f]/.test(x), b); }
});
