// @ts-check
// signals.mjs and ere.mjs against the shell's answers: risk_words_match (the golden cases of risk-test.sh, 830 and 867, and more; recorded in tests/core/golden/risk-words-match.json, the lines
// of the widened log pattern and the back-reference case look their answer up in tests/golden/shell-equivalence.json, A244), the ERE translator against grep -E, entry_tier against
// agent.sh entry-tier, and the risk freeze hashes.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { refGrep } from '../lib/winpath.mjs';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test, after } from 'node:test';
import { rmSync } from 'node:fs';
import { ereToRegExp } from '../../control-plane/agents/scripts/core/ere.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { entryTier, knowledgeDocFile, riskWordsMatch, tierMax, tierRank } from '../../control-plane/agents/scripts/core/signals.mjs';
import { repo } from './helpers.mjs';
import { makeFixture } from './fixture.mjs';

const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
const config = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'latin1');
const logRe = (/^ {4}content: ((?:\(\^\|\[\^A-Za-z0-9\]\)).*)$/m.exec(config) ?? [])[1] ?? '';

const GOLD = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'shell-equivalence.json'), 'utf8'));
/** The answer the shell function gave on this case (recorded in tests/golden/shell-equivalence.json, A244). @param {string} re @param {string} words @param {string[]} lines */
function shellWords(re, words, lines) {
  const hit = GOLD.riskWords.find((/** @type {{ re: string, words: string, lines: string[] }} */ c) => c.re === re && c.words === words && JSON.stringify(c.lines) === JSON.stringify(lines));
  assert.ok(hit, `no recorded answer for ${JSON.stringify({ re: re.slice(0, 30), words, lines })}`);
  return hit.match;
}

describe('risk_words_match gives what the shell gave (recorded)', () => {
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
    assert.equal(riskWordsMatch(ctx, '(l)\\1', 'x', ['llx']), GOLD.riskWordsBackref);
  });
});

describe('ERE translation equals grep -E', () => {
  const pats = ['^(openapi|asyncapi|swagger):', '"\\$schema"[[:space:]]*:[[:space:]]*"https?://json-schema\\.org/', '^syntax = "proto', 'a{2,3}b', '[^[:alpha:]]x', '[]a]b', '[a-c]+', 'x|y|z', '(^|[^A-Za-z0-9_.-])(GET|POST) +/[^ ]*', 'a\\.b', '\\(x\\)', '[.]', '[\\]x', 'a$'];
  const texts = ['openapi: 3', 'x openapi:', '"$schema" : "https://json-schema.org/draft"', 'syntax = "proto3"', 'aab', 'aaaab', '1x', 'Ax', ']b', 'abc', 'y', 'POST /x', 'a.b', 'axb', '(x)', '.', '\\', 'a', 'ba'];
  test('same verdict on a corpus', () => {
    for (const p of pats) {
      const re = ereToRegExp(p);
      for (const t of texts) {
        const sh = refGrep(['-Eq'], p, `${t}\n`, { encoding: 'latin1' }).status === 0;
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
      const g = refGrep(['-Eq'], p, `${t}\n`, { encoding: 'latin1' }).status === 0;
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

describe('the ecosystem definition as flat rows (A245: no tsv, no sh reader)', () => {
  const json = path.join(repo, 'control-plane/agents/ecosystems.json');
  test('the core\'s flattening equals flatten() of ecosystems.mjs on the shipped definition, and the sets are the union the tsv held', async () => {
    const { flatten } = await import('../../control-plane/agents/ecosystems.mjs');
    const { flattenDefinition, rowsOf } = await import('../../control-plane/agents/scripts/core/ecodata.mjs');
    const data = JSON.parse(readFileSync(json, 'utf8'));
    assert.deepEqual(flattenDefinition(data), flatten(data));
    assert.deepEqual(rowsOf(json), flatten(data));
    const ids = flatten(data).filter((r) => r[0] !== '*' && r[1] === 'id').map((r) => r[2]);
    assert.ok(ids.length >= 10, `${ids.length} ecosystem ids`);
  });
  test('a project\'s own definition wins; a missing, empty or invalid one falls back to the control plane\'s, and without either nothing is loaded', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { ecosystemRowsAt } = await import('../../control-plane/agents/scripts/core/ecodata.mjs');
    const ship = path.join(repo, 'control-plane/agents');
    const d = tempDir('pl-eco-');
    try {
      const agents = path.join(d, '.agents'); mkdirSync(agents);
      assert.ok((ecosystemRowsAt(agents, ship) ?? []).length > 100, 'no fallback to the shipped definition');
      writeFileSync(path.join(agents, 'ecosystems.json'), '');
      assert.ok((ecosystemRowsAt(agents, ship) ?? []).length > 100, 'an empty file is no definition');
      writeFileSync(path.join(agents, 'ecosystems.json'), '{not json');
      assert.ok((ecosystemRowsAt(agents, ship) ?? []).length > 100, 'an invalid file is no definition');
      writeFileSync(path.join(agents, 'ecosystems.json'), JSON.stringify({ global: { risky_paths: ['x/**'] }, ecosystems: [{ id: 'zz', manifests: ['zz.lock'] }] }));
      assert.deepEqual(ecosystemRowsAt(agents, ship), [['*', 'risky_paths', 'x/**'], ['zz', 'id', 'zz'], ['zz', 'manifests', 'zz.lock']]);
      writeFileSync(path.join(agents, 'ecosystems.json'), '');
      assert.equal(ecosystemRowsAt(agents, agents), null, 'neither the project nor a different shipped folder: nothing loaded');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// A266: `knowledge_doc_file` on Windows. NTFS has no execute bit and `accessSync(X_OK)` answers yes for every file there, so every wiki page counted as an executable doc and moved the
// tier to full. The platform argument is the seam: win32 asks git's index (mode 100755) instead, and compares the folders in the core's one path form.
describe('knowledgeDocFile: the executable-doc rule per platform (A266)', () => {
  const d = tempDir('kdoc-');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(d, 'none'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', d, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...a], { env, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(d, '.agents/scripts'), { recursive: true });
  mkdirSync(path.join(d, 'docs/wiki'), { recursive: true });
  for (const n of ['plain', 'tracked-x', 'bitx']) writeFileSync(path.join(d, `docs/wiki/${n}.md`), '# page\n');
  writeFileSync(path.join(d, 'docs/wiki/data.json'), '{}\n');
  git('add', 'docs/wiki/tracked-x.md'); git('update-index', '--chmod=+x', 'docs/wiki/tracked-x.md');
  /** @type {Context} */
  const ctx = new Context({ env, cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(d, '.agents/scripts/proofline-core.mjs'));

  test('win32: a page with no execute bit in the index is a plain doc, whatever the host file system says about X_OK', () => {
    assert.equal(git('ls-files', '-s', '--', 'docs/wiki/tracked-x.md').stdout.startsWith('100755 '), true, 'premise: the index holds the execute bit');
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/plain.md', 'win32'), true);
  });
  test('win32: a page the index holds as 100755 still counts; a data file never leaves the tier', () => {
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/tracked-x.md', 'win32'), false);
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/data.json', 'win32'), false);
  });
  test('POSIX rule unchanged: the execute bit of the file decides, not the index', { skip: process.platform === 'win32' ? 'NTFS has no execute bit' : false }, () => {
    chmodSync(path.join(d, 'docs/wiki/bitx.md'), 0o755);
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/bitx.md', 'linux'), false);
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/plain.md', 'linux'), true);
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/bitx.md', 'win32'), true, 'premise: on the win32 rule the same file is not looked at by its mode');
  });
});
