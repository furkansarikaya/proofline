// @ts-check
// A250: what grep says about a pattern it cannot use is never silently "no match" for a DENY pattern; every config key that holds a grep pattern is
// checked by config-check; `^$` and a pattern with a line end answer like grep -E (no phantom empty line, a line end is several patterns).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ereToRegExp } from '../../control-plane/agents/scripts/core/ere.mjs';
import { caseMatch, cfg2, forbidden } from '../../control-plane/agents/scripts/core/githooks.mjs';
import { ereTypo, forbiddenTokens, grepLineCi } from '../../control-plane/agents/scripts/core/grepfile.mjs';
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
  assert.equal(run(orig.replace(/^(\s*forbidden_identities:).*$/m, '$1 *@example-corp.com *+bot@x.example *[a-z]@x.com *@(a|b).com *.{dev} ^ops@x\\.example$')).status, 0);
  assert.notEqual(run(orig.replace(/^(\s*forbidden_identities:).*$/m, '$1 a(b')).status, 0);
  const risk = (/** @type {string} */ body) => run(orig.replace(/^risk:\n/m, `risk:\n  mine_extra:\n    check: config\n    paths: "*.cfg"\n${body}`));
  const noWords = risk('    content: "(unclosed"\n');
  assert.notEqual(noWords.status, 0);
  assert.match(noWords.text, /invalid regular expression for risk\.mine_extra\.content/);
  assert.equal(risk('    content: "(closed)"\n').status, 0);
});

test('forbidden: every glob entry that worked before keeps working (same answer as the code before the change, no notice); only an entry that is neither a glob nor an ERE fails closed', () => {
  const env = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };
  /** the code before the change: the glob, then the ERE; grep exit 2 meant no match */
  const legacy = (/** @type {string} */ p, /** @type {string} */ email) => {
    if (caseMatch(p.toLowerCase(), email.toLowerCase())) return true;
    const re = ereToRegExp(p, true);
    return re !== null ? re.test(email) : grepLineCi(env, p, `${email}\n`);
  };
  const entries = ['*@example-corp.com', '*+bot@x.example', '*[a-z]@x.com', '*@(a|b).com', '*.{dev}', '?x@x.com', '*@x.com', '^ops@legacy\\.example$', 'bot[0-9]@x\\.com'];
  const emails = ['dev@example.test', 'Dev@Example-Corp.com', '123+bot@x.example', 'q@x.com', 'q@a.com', 'q@b.com', 'a.dev', 'ax@x.com', 'ops@legacy.example', 'bot1@x.com'];
  for (const e of entries) for (const m of emails) {
    const ctx = fx.ctx();
    assert.equal(forbidden(ctx, cfgWith(e), m), legacy(e, m), `${e} on ${m}`);
    assert.equal(errOf(ctx), '', `a notice for the valid entry ${e}`);
  }
  assert.equal(forbidden(fx.ctx(), cfgWith('*+bot@x.example'), '123+bot@x.example'), true);
  assert.equal(forbidden(fx.ctx(), cfgWith('*[a-z]@x.com'), 'q@x.com'), true);
  for (const bad of ['a(b', '^(unclosed', 'x[']) {
    const ctx = fx.ctx();
    assert.equal(forbidden(ctx, cfgWith(bad), 'dev@example.test'), true, bad);
    assert.match(errOf(ctx), /not a valid extended regular expression/);
  }
});

test('the hooks read git.forbidden_identities like every other command: inline, block list, double or single quoted, comment after the value, empty', () => {
  const forms = {
    inline: 'git:\n  forbidden_identities: *@corp.com\n',
    inlineTwo: 'git:\n  forbidden_identities: x@y.example *@corp.com\n',
    block: 'git:\n  forbidden_identities:\n    - "*@corp.com"\n    - \'z@z.example\'\n',
    double: 'git:\n  forbidden_identities: "*@corp.com"\n',
    single: "git:\n  forbidden_identities: '*@corp.com'\n",
    comment: 'git:\n  forbidden_identities: *@corp.com   # the corp mail\n',
  };
  for (const [name, cfg] of Object.entries(forms)) {
    assert.equal(forbidden(fx.ctx(), cfg, 'dev@corp.com'), true, `${name}: matching identity`);
    assert.equal(forbidden(fx.ctx(), cfg, 'dev@example.test'), false, `${name}: other identity`);
  }
  assert.equal(forbidden(fx.ctx(), forms.block, 'z@z.example'), true);
  assert.equal(cfg2('git:\n  forbidden_identities:\n', 'git', 'forbidden_identities'), '');
  assert.equal(forbidden(fx.ctx(), 'git:\n  forbidden_identities:\n', 'dev@corp.com'), false);
  assert.equal(forbidden(fx.ctx(), 'git:\n  forbidden_identities: # none\n', 'dev@corp.com'), false);
});

test('forbidden: each token loses its own surrounding quotes (double, single, mixed, inline list, block list); every form that worked on main still answers the same', () => {
  const emails = ['x@a.com', 'x@b.com', 'x@c.com', 'a', 'b'];
  const cases = /** @type {Array<[string, string[]]>} */ ([
    ['"x@a.com" "x@b.com"', ['x@a.com', 'x@b.com']],
    ["'x@a.com' 'x@b.com'", ['x@a.com', 'x@b.com']],
    ['"x@a.com" \'x@b.com\'', ['x@a.com', 'x@b.com']],
    ['["x@a.com","x@b.com"]', ['x@a.com', 'x@b.com']],
    ['[x@a.com, "x@b.com"]', ['x@a.com', 'x@b.com']],
    ['["*@a.com" "*@b.com"]', ['x@a.com', 'x@b.com']],
    ['"x@a.com"', ['x@a.com']],
    ['x@a.com x@b.com', ['x@a.com', 'x@b.com']],
  ]);
  for (const [v, hit] of cases) for (const m of emails) assert.equal(forbidden(fx.ctx(), cfgWith(v), m), hit.includes(m), `${v} on ${m}`);
  const block = 'git:\n  forbidden_identities:\n    - "x@a.com"\n    - \'x@b.com\'\n';
  assert.equal(forbidden(fx.ctx(), block, 'x@b.com'), true);
  assert.equal(forbidden(fx.ctx(), block, 'x@c.com'), false);
  assert.deepEqual(forbiddenTokens('[a-z]@x.com'), ['[a-z]@x.com']); // a bracket class is not an inline list
  assert.deepEqual(forbiddenTokens(null), []);
});

test('config-check validates the quoted tokens like the hooks read them', () => {
  const dir = newRepo();
  const cfg = path.join(dir, '.agents/config.yaml');
  const orig = readFileSync(cfg, 'utf8');
  const run = (/** @type {string} */ v) => { writeFileSync(cfg, orig.replace(/^(\s*forbidden_identities:).*$/m, `$1 ${v}`)); return A(dir, ['config-check']); };
  assert.equal(run('"x@a.com" "x@b.com"').status, 0);
  assert.notEqual(run('["a(b", "x@b.com"]').status, 0);
  assert.notEqual(run('"a(b" "x@b.com"').status, 0);
  assert.equal(run('+x@y.com {dev}@x.com').status, 0);
});

test('forbidden: a literal that grep refuses as an ERE blocks that identity only; an unbalanced ERE still fails closed', () => {
  for (const lit of ['+x@y.com', '{dev}@x.com', '*+bot@y.com']) {
    for (const [m, want] of /** @type {Array<[string, boolean]>} */ ([['+x@y.com', lit === '+x@y.com'], ['{dev}@x.com', lit === '{dev}@x.com'], ['q@x.com', false], ['dev@x.com', false], ['1+bot@y.com', lit === '*+bot@y.com']])) {
      const ctx = fx.ctx();
      assert.equal(forbidden(ctx, cfgWith(lit), m), want, `${lit} on ${m}`);
      assert.equal(errOf(ctx), '', `${lit} on ${m}: no notice`);
    }
  }
  for (const bad of ['a(b', 'x[', 'a(b|c']) {
    const ctx = fx.ctx();
    assert.equal(forbidden(ctx, cfgWith(bad), 'q@x.com'), true, bad);
    assert.match(errOf(ctx), /not a valid extended regular expression/);
  }
  assert.equal(ereTypo('+x@y.com'), false);
  assert.equal(ereTypo('{dev}@x.com'), false);
  assert.equal(ereTypo('a\\(b'), false);
});
