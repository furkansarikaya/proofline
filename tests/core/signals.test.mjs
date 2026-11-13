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
/** @typedef {import('../../control-plane/agents/scripts/core/context.mjs').Context} Context */
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { samePath } from '../../control-plane/agents/scripts/core/pathin.mjs';
import { entryTier, indexHoldsExecutable, knowledgeDocFile, riskWordsMatch, tierMax, tierRank } from '../../control-plane/agents/scripts/core/signals.mjs';
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

// A266 security round 1: the Windows rule reads the index with LITERAL pathspecs, every entry, every stage, and fails closed. Names with `[`, `*`, `?`, `\\` and a leading `:` are pathspec
// magic; `[` is legal in NTFS names, so a worker could commit `x[1].md` as 100755 next to a decoy `x1.md` (100644) that sorts first. The index is written with `update-index --index-info`
// (no work tree file needed, so the names NTFS refuses are tested too); every test asserts its premise.
describe('indexHoldsExecutable: literal paths, all entries, fail closed (A266)', () => {
  const d = tempDir('kidx-');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(d, 'none'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = (/** @type {string[]} */ a, /** @type {string} */ input = '') => spawnSync('git', ['-C', d, ...a], { env, encoding: 'utf8', input });
  git(['init', '-q']);
  mkdirSync(path.join(d, '.agents/scripts'), { recursive: true });
  const blob = git(['hash-object', '-w', '--stdin'], '#!/bin/sh\n').stdout.trim();
  /** @param {string} rows */ const index = (rows) => { git(['rm', '-q', '--cached', '-r', '--ignore-unmatch', '.']); assert.equal(git(['update-index', '--index-info'], rows).status, 0); };
  const names = () => git(['--literal-pathspecs', 'ls-files', '-s', '-z']).stdout.split('\0').filter((x) => x !== '');
  /** @type {Context} */
  const ctx = new Context({ env, cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(d, '.agents/scripts/proofline-core.mjs'));

  test('a `[` name committed as 100755 is executable although a decoy that sorts first is 100644', () => {
    index(`100644 ${blob}\tdocs/x1.md\n100755 ${blob}\tdocs/x[1].md\n`);
    assert.ok(names()[0].endsWith('docs/x1.md'), 'premise: the decoy is listed first');
    assert.ok(names().some((e) => e.startsWith('100755 ') && e.endsWith('docs/x[1].md')), 'premise: the index holds the bit');
    assert.equal(git(['ls-files', '-s', '--', 'docs/x[1].md']).stdout.startsWith('100644 '), true, 'premise: a pathspec read gives the decoy');
    assert.equal(indexHoldsExecutable(ctx, 'docs/x[1].md'), true);
    assert.equal(indexHoldsExecutable(ctx, 'docs/x1.md'), false, 'the decoy itself is a plain doc');
  });
  test('`*`, `?`, a backslash and a leading colon are literal', (t) => {
    index(`100644 ${blob}\tdocs/ab.md\n100755 ${blob}\tdocs/a*.md\n100755 ${blob}\tdocs/a?.md\n100755 ${blob}\tdocs/a\\b.md\n100755 ${blob}\t:(top)x.md\n100644 ${blob}\tdocs/plain.md\n`);
    // Git for Windows refuses or rewrites some of these names itself (`*`, `?`, a backslash is a separator there): only the names the index really holds with the bit are tested there
    const held = ['docs/a*.md', 'docs/a?.md', 'docs/a\\b.md', ':(top)x.md'].filter((n) => names().some((e) => e.startsWith('100755 ') && e.endsWith(`\t${n}`)));
    if (process.platform !== 'win32') assert.equal(held.length, 4, 'premise: the index holds all four names');
    else if (held.length === 0) { t.skip('Git for Windows holds none of these names in its index (NTFS-illegal); the `[` test covers the legal pathspec magic there'); return; }
    for (const n of held) assert.equal(indexHoldsExecutable(ctx, n), true, n);
    assert.equal(indexHoldsExecutable(ctx, 'docs/plain.md'), false);
    assert.equal(indexHoldsExecutable(ctx, 'docs/*.md'), false, 'a glob matches nothing literally: not a tracked name');
  });
  test('an unmerged file counts at any stage', () => {
    index(`100644 ${blob} 1\tdocs/u.md\n100644 ${blob} 2\tdocs/u.md\n100755 ${blob} 3\tdocs/u.md\n`);
    assert.ok(names().length === 3 && names()[0].startsWith('100644 ') && names()[0].includes(' 1\t'), 'premise: three stages, the plain one listed first');
    assert.equal(indexHoldsExecutable(ctx, 'docs/u.md'), true);
  });
  test('a git that fails is "executable" (the stricter tier), and so is output that is not index entries', () => {
    const nogit = tempDir('kidx-none-');
    mkdirSync(path.join(nogit, '.agents/scripts'), { recursive: true });
    const bad = new Context({ env: { ...env, GIT_DIR: path.join(nogit, 'not-a-repo') }, cwd: nogit, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(nogit, '.agents/scripts/proofline-core.mjs'));
    assert.notEqual(spawnSync('git', ['-C', nogit, 'ls-files'], { env: { ...env, GIT_DIR: path.join(nogit, 'not-a-repo') }, encoding: 'utf8' }).status, 0, 'premise: git fails there');
    assert.equal(indexHoldsExecutable(bad, 'docs/x.md'), true);
    assert.equal(knowledgeDocFile(bad, 'docs/x.md', 'win32'), false, 'a failed read keeps the page in the tier');
  });
  test('knowledgeDocFile on the win32 rule: the `[` file really on disk stays in the tier', () => {
    index(`100644 ${blob}\tdocs/wiki/y1.md\n100755 ${blob}\tdocs/wiki/y[1].md\n`);
    mkdirSync(path.join(d, 'docs/wiki'), { recursive: true });
    writeFileSync(path.join(d, 'docs/wiki/y1.md'), '# a\n'); writeFileSync(path.join(d, 'docs/wiki/y[1].md'), '# b\n');
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/y1.md', 'win32'), true, 'premise: the decoy is a plain doc');
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/y[1].md', 'win32'), false);
  });
});

// A266 (review addendum): the folder comparison of knowledgeDocFile is `samePath` on the Windows rule (case-insensitive, either slash, a trailing slash does not matter); the real-path function
// is a seam, so a Windows-style answer is fed on POSIX. Replacing samePath by === makes the first test red.
describe('knowledgeDocFile folder comparison and glob names through the seams (A266)', () => {
  const d = tempDir('kcase-');
  mkdirSync(path.join(d, '.agents/scripts'), { recursive: true });
  mkdirSync(path.join(d, 'docs/wiki'), { recursive: true });
  writeFileSync(path.join(d, 'docs/wiki/p.md'), '# p\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(d, 'none'), GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['-C', d, 'init', '-q'], { env });
  const ctx = new Context({ env, cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, path.join(d, '.agents/scripts/proofline-core.mjs'));
  /** What a Windows realpath answers for the root and for the folder: other case, backslashes. @param {string} x */
  const winReal = (x) => (x === ctx.root ? 'C:\\PROJ' : 'c:\\proj\\DOCS\\wiki');
  test('win32: case and slash spelling of the real folders do not matter; the same answers are a different folder on POSIX rules', () => {
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/p.md', 'win32', winReal), true);
    assert.equal(knowledgeDocFile(ctx, 'docs/wiki/p.md', 'win32', (x) => (x === ctx.root ? 'C:\\PROJ' : 'c:\\proj\\other')), false, 'a different folder (a link on the way) is still refused');
    assert.equal(samePath('C:\\A\\b', 'c:/a/B', 'win32'), true);
    assert.equal(samePath('C:\\A\\b', 'c:/a/B', 'linux'), false);
    assert.equal(samePath('C:\\a\\\u00e9', 'C:/a/\u00c9', 'win32'), false, 'a non-ASCII case difference is a different path');
  });
  test('a glob name asks for itself: a tracked x1.md does not answer for x?.md', () => {
    const blob = spawnSync('git', ['-C', d, 'hash-object', '-w', '--stdin'], { env, encoding: 'utf8', input: 'x\n' }).stdout.trim();
    spawnSync('git', ['-C', d, 'update-index', '--index-info'], { env, input: `100755 ${blob}\tdocs/wiki/x1.md\n` });
    assert.match(spawnSync('git', ['-C', d, 'ls-files', '-s'], { env, encoding: 'utf8' }).stdout, /^100755 .*x1\.md/m, 'premise: x1.md holds the bit');
    assert.equal(indexHoldsExecutable(ctx, 'docs/wiki/x1.md'), true);
    assert.equal(indexHoldsExecutable(ctx, 'docs/wiki/x?.md'), false);
    assert.equal(indexHoldsExecutable(ctx, 'docs/wiki/*'), false);
  });
});
