// @ts-check
// A358 (issue 338 item B9): the matcher that decides which plan test names the control plane may record as GREEN (core/greenrun.mjs `testTitles`, `runFiles`). Crafted fixture texts, no
// process, no clock: a name counts only when it is the quoted first argument of a real `test(`/`it(`/`t.test(` call of a file that imports `node:test`.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runFiles, testTitles } from '../../control-plane/agents/scripts/core/greenrun.mjs';
import { tmp } from '../lib/harness.mjs';

const IMP = "import { test, it } from 'node:test';\n";
/** The titles (name to count) a fixture declares, or null. @param {string} body @param {string} [head] */
const titles = (body, head = IMP) => { const m = testTitles(head + body); return m === null ? null : Object.fromEntries(m); };

test('real declarations: test, it, .only, t.test, any quote, a plain template; the title is lower-cased', () => {
  assert.deepEqual(titles("test('A', () => {});\nit(\"b\", () => {});\ntest.only(`c`, () => {});\ntest('d', (t) => { t.test('e', () => {}); });\n"), { a: 1, b: 1, c: 1, d: 1, e: 1 });
  assert.deepEqual(titles("test('x', () => {});\nit('x', () => {});\n"), { x: 2 });
  assert.deepEqual(titles("const { test } = require('node:test');\ntest('x', () => {});\n", ''), { x: 1 });
  assert.deepEqual(titles("const r = /'\"`/;\nconst d = 4 / 2;\ntest('x', () => {});\n"), { x: 1 });
});

test('hole 1: a call after a dot, a shadowing helper, a foreign import or no import of the runner is no declaration', () => {
  assert.deepEqual(titles("foo.test('x', () => {});\nobj.it('y', () => {});\nthis.test('z', 1);\n"), {});
  assert.equal(titles("function test(n, f) {}\ntest('x', () => {});\n"), null);
  assert.equal(titles("const it = (n, f) => {};\nit('x', () => {});\n"), null);
  assert.equal(titles("let a = 1, test = (n) => n;\ntest('x', 1);\n"), null);
  assert.equal(titles("test('x', () => {});\n", "import { strictEqual as test } from 'node:assert';\n"), null);
  assert.equal(titles("test('x', () => {});\n", ''), null);
  assert.deepEqual(titles("const o = { test('x', y) { return 1; } };\n"), {}, 'an object method named test');
});

test('hole 2: strings, templates (nested), comments and regex literals hide a fake declaration across lines', () => {
  assert.deepEqual(titles("const s = `\ntest('x', 1)\n`;\n"), {});
  assert.deepEqual(titles("const s = `a ${ `b\ntest('x', 1)\n` } c\ntest('y', 1)\n`;\n"), {});
  assert.deepEqual(titles("/*\ntest('x', 1)\n*/\n// test('y', 1)\nconst s = 'test(\\'z\\', 1)';\n"), {});
  assert.deepEqual(titles("const r = /[/]\\//;\ntest('x', () => {});\n"), { x: 1 });
  assert.deepEqual(titles("test(`x${1}`, () => {});\n"), {}, 'a template title with a substitution is no literal name');
});

test('hole 2: any scanning doubt gives nothing for the file', () => {
  for (const body of ["const s = 'open\n", 'const s = `open\n', '/* open\n', "const q = {} / 2;\n", 'const \\u0061 = 1;\n', 'const r = /open\n', 'const n = a++ / 2;\n']) assert.equal(titles(`test('x', () => {});\n${body}`), null, body);
});

test('hole 3: `.skip`, `.todo`, `describe` and `suite` are no plan test', () => {
  assert.deepEqual(titles("test.skip('a', () => {});\nit.todo('b');\ndescribe('c', () => {});\nsuite('d', () => {});\n", "import { test, it, describe, suite } from 'node:test';\n"), {});
});

test('hole 4: a directory or glob resolves to the real test files under the project; a path outside, a brace glob, a symlink and a command with no file give nothing', () => {
  const root = tmp();
  mkdirSync(path.join(root, 'tests/deep'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  mkdirSync(path.join(root, 'outside'), { recursive: true });
  for (const f of ['tests/a.test.mjs', 'tests/deep/b.test.mjs', 'tests/helper.txt', 'node_modules/x/c.test.mjs', 'run.mjs']) writeFileSync(path.join(root, f), '');
  symlinkSync(path.join(root, 'outside'), path.join(root, 'tests/link'));
  writeFileSync(path.join(root, 'outside/d.test.mjs'), '');
  assert.deepEqual(runFiles(root, ['node --test tests']).sort(), ['tests/a.test.mjs', 'tests/deep/b.test.mjs']);
  assert.deepEqual(runFiles(root, ["node --test 'tests/**/*.test.mjs'"]).sort(), ['tests/a.test.mjs', 'tests/deep/b.test.mjs']);
  assert.deepEqual(runFiles(root, ['node --test tests/*.test.mjs']), ['tests/a.test.mjs']);
  assert.deepEqual(runFiles(root, ['node run.mjs', 'node --test ./tests/a.test.mjs']).sort(), ['run.mjs', 'tests/a.test.mjs']);
  assert.deepEqual(runFiles(root, ['node --test tests ../x']), []);
  assert.deepEqual(runFiles(root, ['node --test /etc']), []);
  assert.deepEqual(runFiles(root, ['node --test tests/link']), []);
  assert.deepEqual(runFiles(root, ["node --test 'tests/{a,deep/b}.test.mjs'"]), []);
  assert.deepEqual(runFiles(root, ['node -e 1']), []);
});
