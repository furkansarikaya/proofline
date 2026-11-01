// @ts-check
// signals.mjs and ere.mjs against the shell: risk_words_match (the golden cases of risk-test.sh, 830 and 867, and more), the ERE translator
// against grep -E, entry_tier against agent.sh entry-tier, and the risk freeze hashes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test, after } from 'node:test';
import { rmSync } from 'node:fs';
import { ereToRegExp } from '../../control-plane/agents/scripts/core/ere.mjs';
import { entryTier, riskWordsMatch, tierMax, tierRank } from '../../control-plane/agents/scripts/core/signals.mjs';
import { extractFunctions, repo } from './helpers.mjs';
import { makeFixture } from './fixture.mjs';

const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
const config = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'latin1');
const logRe = (/^ {4}content: ((?:\(\^\|\[\^A-Za-z0-9\]\)).*)$/m.exec(config) ?? [])[1] ?? '';

/** @param {string} re @param {string} words @param {string[]} lines */
function shellWords(re, words, lines) {
  const fns = extractFunctions(['risk_words_match']);
  const r = spawnSync('sh', ['-c', `${fns}\nrisk_words_match "$1" "$2"`, 'x', re, words], { input: `${lines.join('\n')}\n`, encoding: 'latin1', env: { ...process.env, LC_ALL: 'C' } });
  return r.status === 0;
}

describe('risk_words_match equals the shell', () => {
  const match = ['log(userPassword)', 'log(user_password)', 'log(passwords)', 'log(PASSWORD)', 'log(card)', 'log(ssn)', 'log(user.Email)'];
  const noMatch = ['log(discard)', 'log(classname)', 'log(scardy)', 'log(started)', 'print(password)'];
  test('boundaries', () => {
    const ctx = fx.ctx();
    for (const l of [...match, ...noMatch]) {
      for (const re of ['log', '^log']) {
        assert.equal(riskWordsMatch(ctx, re, 'password card ssn email', [l]), shellWords(re, 'password card ssn email', [l]), `${re} ${l}`);
      }
    }
    for (const l of match) assert.equal(riskWordsMatch(ctx, 'log', 'password card ssn email', [l]), true, l);
    for (const l of noMatch) assert.equal(riskWordsMatch(ctx, '^log', 'password card ssn email', [l]), false, l);
    assert.equal(riskWordsMatch(ctx, '^log', 'token', ['x', 'log(token)']), true);
  });
  test('the widened log pattern of config.yaml', () => {
    assert.ok(logRe.length > 20);
    const ctx = fx.ctx();
    const lines = ['Console.WriteLine(password)', 'Debug.WriteLine(token)', 'Trace.WriteLine(secret)', 'fmt.Fprintf(w, "%s", password)', 'fmt.Fprint(os.Stderr, token)', 'fmt.Fprintln(w, secret)', 'FMT.FPRINTF(w, password)', 'print "password"', 'puts "token"', 'var_dump($password)', 'dump($password)',
      'logger.info("started")', 'x = discard', 'classname = 1', 'cardinality = 2', 'phoneme = 3', 'scorecard = 4', 'cardholder = 5', 'wildcard = 6', 'tokenizer = 7', 'secretary = 8', 'logger.warn(token)', 'slog.Info("x", "card", c)', 'a.print password', 'eprintln!(secret)'];
    for (const l of lines) {
      assert.equal(riskWordsMatch(ctx, logRe, 'password token secret card phone', [l]), shellWords(logRe, 'password token secret card phone', [l]), l);
    }
  });
  test('a pattern the translator does not cover goes to the platform awk', () => {
    const ctx = fx.ctx();
    assert.equal(ereToRegExp('(a)\\1'), null);
    assert.equal(riskWordsMatch(ctx, '(l)\\1', 'x', ['llx']), shellWords('(l)\\1', 'x', ['llx']));
  });
});

describe('ERE translation equals grep -E', () => {
  const pats = ['^(openapi|asyncapi|swagger):', '"\\$schema"[[:space:]]*:[[:space:]]*"https?://json-schema\\.org/', '^syntax = "proto', 'a{2,3}b', '[^[:alpha:]]x', '[]a]b', '[a-c]+', 'x|y|z', '(^|[^A-Za-z0-9_.-])(GET|POST) +/[^ ]*', 'a\\.b', '\\(x\\)', '[.]', '[\\]x', 'a$'];
  const texts = ['openapi: 3', 'x openapi:', '"$schema" : "https://json-schema.org/draft"', 'syntax = "proto3"', 'aab', 'aaaab', '1x', 'Ax', ']b', 'abc', 'y', 'POST /x', 'a.b', 'axb', '(x)', '.', '\\', 'a', 'ba'];
  test('same verdict on a corpus', () => {
    for (const p of pats) {
      const re = ereToRegExp(p);
      for (const t of texts) {
        const sh = spawnSync('grep', ['-Eq', '--', p], { input: `${t}\n`, encoding: 'latin1' }).status === 0;
        if (re === null) continue;
        assert.equal(re.test(t), sh, `/${p}/ on ${t}`);
      }
    }
  });
  test('unsupported constructs return null', () => {
    for (const p of ['\\bx', '\\w+', 'a\\<', '[[.a.]]', '[[:nope:]]', 'a{', '(a', '[a']) assert.equal(ereToRegExp(p), null, p);
  });
});

describe('entry_tier equals agent.sh entry-tier', () => {
  test('bullets', () => {
    const ctx = fx.ctx();
    const bullets = ['`POST /orders` accepts a JSON body', 'GET /health returns ok', 'adds the --verbose flag', 'removes `DELETE /x`', 'the POST /x endpoint is now removed', 'a webhook endpoint, unchanged', 'new endpoint response shape', 'plain prose', 'cli commands: `foo` takes an argument', 'queue consumer for jobs, documented', 'graphql mutation `a` adds a field'];
    for (const b of bullets) {
      const sh = fx.sh(['entry-tier', b]).out.trim();
      assert.equal(entryTier(ctx, b) || 'none', sh, b);
    }
  });
});

describe('tiers', () => {
  test('rank and max', () => {
    assert.deepEqual(['docs', 'small', 'full', 'x'].map(tierRank), [0, 1, 2, -1]);
    assert.equal(tierMax('docs', 'small'), 'small'); assert.equal(tierMax('full', 'small'), 'full'); assert.equal(tierMax('small', 'small'), 'small');
  });
});

describe('ERE safety (S2-4)', () => {
  test('nested quantifiers and quantified alternations go to the platform tools, in no time', () => {
    for (const p of ['(a+)+$', '(a|a)*b', '(a*)*', '(x+x+)+y', '(a|b)+c']) {
      const t0 = Date.now();
      assert.equal(ereToRegExp(p), null, p);
      assert.ok(Date.now() - t0 < 100);
    }
    assert.ok(ereToRegExp('(a)?b') !== null);
    assert.ok(ereToRegExp('(^|[^A-Za-z0-9])(log|Log)(\\.|\\()') !== null);
  });
  test('the pattern of the report is answered by grep, not by a backtracking engine', () => {
    const ctx = fx.ctx();
    const t0 = Date.now();
    assert.equal(riskWordsMatch(ctx, '(a+)+$', 'x', ['a'.repeat(32) + 'b']), false);
    assert.ok(Date.now() - t0 < 5000);
  });
  test('a dot matches a carriage return, like grep and awk', () => {
    for (const [p, t] of [['a.b', 'a\rb'], ['^x.*$', 'xy\r'], ['x.$', 'x\r'], ['a.b', 'a\tb']]) {
      const re = ereToRegExp(p);
      assert.ok(re);
      const g = spawnSync('grep', ['-Eq', '--', p], { input: `${t}\n`, encoding: 'latin1' }).status === 0;
      assert.equal(re.test(t), g, `${p} on ${JSON.stringify(t)}`);
    }
  });
});

describe('ERE polynomial patterns (S2-4)', () => {
  test('more than two unbounded quantifiers in one branch go to grep, in well under a second', () => {
    const t0 = Date.now();
    assert.equal(ereToRegExp('.*.*.*.*.*.*.*x'), null);
    assert.equal(ereToRegExp('a*b*c*d'), null);
    assert.equal(ereToRegExp('a{2,}b+c*'), null);
    assert.ok(ereToRegExp('a*b*c') !== null);
    assert.ok(ereToRegExp('a*|b*|c*|d*') !== null, 'branches do not add up');
    assert.ok(Date.now() - t0 < 1000);
  });
});
