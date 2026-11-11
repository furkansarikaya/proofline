// @ts-check
// A250: what grep says about a pattern it cannot use is never silently "no match" for a DENY pattern; every config key that holds a grep pattern is
// checked by config-check; `^$` and a pattern with a line end answer like grep -E (no phantom empty line, a line end is several patterns).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ereToRegExp } from '../../control-plane/agents/scripts/core/ere.mjs';
import { forbidden } from '../../control-plane/agents/scripts/core/githooks.mjs';
import { grepEq } from '../../control-plane/agents/scripts/core/signals.mjs';
import { A, newRepo } from '../lib/harness.mjs';
import { makeFixture } from './fixture.mjs';

const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
const errOf = (/** @type {import('../../control-plane/agents/scripts/core/context.mjs').Context} */ ctx) => ctx.chunks.filter(([s]) => s === 'err').map(([, b]) => b.toString('latin1')).join('');
const realGrep = (/** @type {string} */ re, /** @type {string} */ text) => spawnSync('grep', ['-Eq', '-e', re], { input: text, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } }).status === 0;
const cfgWith = (/** @type {string} */ v) => `git:\n  forbidden_identities: ${v}\n`;

test('forbidden: an invalid or untranslatable regular expression FAILS CLOSED with a notice; a glob entry and a plain mismatch do not', () => {
  const ctx = fx.ctx();
  assert.equal(forbidden(ctx, cfgWith('^(unclosed'), 'dev@example.test'), true);
  assert.match(errOf(ctx), /git\.forbidden_identities pattern is not a valid extended regular expression/);
  const ok = fx.ctx();
  assert.equal(forbidden(ok, cfgWith('^ops@legacy\\.example$'), 'dev@example.test'), false);
  assert.equal(forbidden(ok, cfgWith('*@example-corp.com'), 'dev@example.test'), false); // a glob: BSD grep rejects the leading star, which must not block everyone
  assert.equal(forbidden(ok, cfgWith('*@example-corp.com'), 'dev@example-corp.com'), true);
  assert.equal(errOf(ok), '');
});

test('grepEq: an unusable pattern matches nothing and says so on stderr; a usable one is silent', () => {
  const ctx = fx.ctx();
  assert.equal(grepEq(ctx, '(unclosed', 'x\n'), false);
  assert.match(errOf(ctx), /not a valid extended regular expression/);
  const ok = fx.ctx();
  assert.equal(grepEq(ok, '(a)\\1', 'aa\n'), true);
  assert.equal(errOf(ok), '');
});

test('^$, $^ and a pattern with a line end answer like grep -E', () => {
  const texts = ['', '\n', 'a', 'a\n', 'a\n\n', 'a\n\nb\n', '\na'];
  for (const re of ['^$', '$^', '^', '$', 'a$', '^a|^$']) for (const t of texts) assert.equal(grepEq(fx.ctx(), re, t), realGrep(re, t), `${JSON.stringify(re)} on ${JSON.stringify(t)}`);
  for (const t of texts) assert.equal(grepEq(fx.ctx(), 'zzz\nb', `${t}b\n`), realGrep('zzz\nb', `${t}b\n`));
  assert.equal(ereToRegExp('a\nb'), null);
});

test('config-check rejects an invalid pattern in git.forbidden_identities and in every risk.<name>.content (with or without words), not only the validation keys', () => {
  const dir = newRepo();
  const cfg = path.join(dir, '.agents/config.yaml');
  const orig = readFileSync(cfg, 'utf8');
  const run = (/** @type {string} */ edit) => { writeFileSync(cfg, edit); return A(dir, ['config-check']); };
  assert.equal(run(orig).status, 0);
  const fi = run(orig.replace(/^(\s*forbidden_identities:).*$/m, '$1 ^(unclosed'));
  assert.notEqual(fi.status, 0);
  assert.match(fi.text, /invalid regular expression for git\.forbidden_identities/);
  assert.equal(run(orig.replace(/^(\s*forbidden_identities:).*$/m, '$1 *@example-corp.com ^ops@x\\.example$')).status, 0);
  const risk = (/** @type {string} */ body) => run(orig.replace(/^risk:\n/m, `risk:\n  mine_extra:\n    check: config\n    paths: "*.cfg"\n${body}`));
  const noWords = risk('    content: "(unclosed"\n');
  assert.notEqual(noWords.status, 0);
  assert.match(noWords.text, /invalid regular expression for risk\.mine_extra\.content/);
  assert.equal(risk('    content: "(closed)"\n').status, 0);
});
