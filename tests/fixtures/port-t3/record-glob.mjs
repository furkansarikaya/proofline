// @ts-check
// ONE-TIME recorder of tests/fixtures/port-t3/glob.json.gz (temporary; reads the awk `g2re` program inside agent.sh as it is): for every pair of the corpus
// below, whether the shell's glob dialect matches the path (1) or not (0), under LC_ALL=C. tests/core/port-t3-glob.test.mjs checks globToRegExp against it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const agent = readFileSync(new URL('../../../control-plane/agents/scripts/agent.sh', import.meta.url), 'utf8');
const awkSource = /^g2re_awk='([\s\S]*?)'$/m.exec(agent)?.[1];
assert.ok(awkSource, 'g2re_awk not found in agent.sh');

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
const bits = awkResults(pairs).join('');
writeFileSync(new URL('./glob.json.gz', import.meta.url), gzipSync(JSON.stringify({ patterns: PATTERNS, paths: PATHS, bits })));
console.log(`${PATTERNS.length} patterns x ${PATHS.length} paths = ${bits.length} pairs recorded`);
