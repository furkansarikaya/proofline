// @ts-check
// A250 (issue 165, the hook-windows leg): a pattern from config.yaml or from user text never travels as an ARGUMENT of grep, awk or git grep. The MSYS tools of Windows re-parse
// their command line and drop backslashes (`(a|b)\(` fails with "Unmatched ( or \("); a pattern read from a file, stdin or the environment arrives byte for byte. These tests run on
// POSIX, where the answers must stay those of `grep -E -e PATTERN`: the Node translation (ere.mjs) against the real grep on a corpus (the shipped config patterns and tricky ones),
// the file-based fallback against the real grep, and a source guard that fails on a pattern argument.
import assert from 'node:assert/strict';
import { refGrep } from '../lib/winpath.mjs';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { ereToRegExp } from '../../control-plane/agents/scripts/core/ere.mjs';
import { grepLineCi, grepText, patternBytes } from '../../control-plane/agents/scripts/core/grepfile.mjs';
import { hgit } from '../../control-plane/agents/scripts/core/hgit.mjs';
import { grepEq } from '../../control-plane/agents/scripts/core/signals.mjs';
import { repo } from './helpers.mjs';
import { git, makeFixture } from './fixture.mjs';

const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
const ENV = { PATH: process.env.PATH ?? '', LC_ALL: 'C' };

/** The platform grep over a list of lines: the set of matching line indexes (-e, the pattern as an argument: fine on POSIX, it is the reference); null when grep rejects the pattern. @param {string} re @param {string[]} lines @param {boolean} ci */
function realLines(re, lines, ci) {
  const r = refGrep([ci ? '-Ein' : '-En'], re, `${lines.join('\n')}\n`, { env: ENV, encoding: 'utf8' });
  if (r.status === 2) return null;
  return new Set(r.stdout.split('\n').filter((x) => x !== '').map((x) => Number.parseInt(x, 10) - 1));
}

const SHIPPED_KEYS = ['validation.entry_words', 'validation.entry_candidates', 'validation.entry_input', 'validation.entry_new', 'validation.entry_output', 'validation.entry_skip', 'validation.code_patterns', 'risk.log_sensitive.content'];
const cfg = fx.ctx().config();
const SHIPPED = SHIPPED_KEYS.map((k) => ({ k, v: cfg.get(k, '') })).filter((x) => x.v !== '');
const TRICKY = ['(a|b)\\(', 'a\\(b', '\\(', '\\\\', 'a\\.b', '[(]x', '[\\]x', '[]a]+', '[^]a]', '^(openapi|asyncapi):', 'x$|^y', '(^|[^A-Za-z0-9])log\\(', 'a{2,3}', '\\{x\\}', '\\|', 'a\\*b', '[[:space:]]+x', '(a+)+$', '\\w+', '(a)\\1', 'a|', '(', 'a)'];
const LINES = ['', 'a(b', 'a\\(b', 'b(', 'a.b', 'axb', '(x', '\\x', ']x', 'log(x)', 'x log(y)', '{x}', 'aa', 'aaaa', '|', 'a*b', 'aab', ' x', 'openapi: 3', 'sy openapi: 3', 'y', 'x', 'GET /users', 'endpoint', 'app.get(', '@GetMapping', 'a)', 'AB', 'ab', '"$schema": "https://json-schema.org/x'];

test('A250 the shipped config patterns and the tricky ones: ereToRegExp answers like grep -E, or declines (null)', () => {
  assert.ok(SHIPPED.length >= 6, 'the shipped patterns were not found');
  let translated = 0;
  for (const re of [...SHIPPED.map((x) => x.v), ...TRICKY]) {
    for (const ci of [false, true]) {
      const js = ereToRegExp(re, ci);
      if (js === null) continue;
      translated++;
      const want = realLines(re, LINES, ci);
      if (want === null) assert.fail(`the translator accepted a pattern grep rejects: ${JSON.stringify(re)}`);
      LINES.forEach((l, i) => assert.equal(js.test(l), want.has(i), `${JSON.stringify(re)} on ${JSON.stringify(l)} ci=${ci}`));
    }
  }
  assert.ok(translated > 20, `only ${translated} translations were compared`);
});

test('A250 the file-based fallback answers like grep -e on POSIX, a pattern with backslashes included; an invalid pattern matches nothing, as grep exits 2', () => {
  const ctx = fx.ctx();
  for (const re of [...SHIPPED.map((x) => x.v), ...TRICKY]) {
    for (const ci of [false, true]) {
      const lines = LINES.slice(0, 14);
      const want = (realLines(re, lines, ci)?.size ?? 0) > 0;
      assert.equal(grepText(ENV, re, `${lines.join('\n')}\n`, ci), want, `${JSON.stringify(re)} ci=${ci}`);
      assert.equal(grepEq(ctx, re, `${lines.join('\n')}\n`, ci), want, `grepEq ${JSON.stringify(re)} ci=${ci}`);
    }
    assert.equal(grepLineCi(ENV, re, 'a\\(b\n'), (realLines(re, ['a\\(b'], true)?.size ?? 0) > 0, `line ${JSON.stringify(re)}`);
  }
  // the cases the translator declines go through the file: a back-reference, a word escape, an unbalanced group
  assert.equal(grepText(ENV, '(a)\\1', 'aa\n'), true);
  assert.equal(grepText(ENV, '(a)\\1', 'ab\n'), false);
  assert.equal(grepText(ENV, '(a|b)\\(', 'x b( y\n'), true);
  assert.equal(grepText(ENV, '(a|b)\\(', 'x b y\n'), false);
  assert.equal(grepText(ENV, '(', 'x(\n'), false);
  // an empty branch is undefined in POSIX: the translator declines it and the platform answers
  for (const p of ['a|', '|a', '(|a)', '(a|)', '()']) assert.equal(ereToRegExp(p), null, p);
  assert.ok(ereToRegExp('a\\|b') !== null && ereToRegExp('[|]x') !== null && ereToRegExp('(\\()') !== null);
});

test('A250 a pattern with a line end is several patterns, as with -e; an empty pattern matches every line', () => {
  assert.equal(grepText(ENV, 'zzz\nb', 'abc\n'), true);
  assert.equal(grepText(ENV, 'zzz\nyyy', 'abc\n'), false);
  assert.equal(grepText(ENV, '', 'abc\n'), true);
  assert.equal(patternBytes('é').toString('latin1'), 'é\n');
});

test('A250 git grep -f - (the language check and debt): a pattern with backslashes on stdin finds the line; bytes above 0x7f survive', () => {
  const d = fx.root;
  writeFileSync(path.join(d, 'pat-a.txt'), 'call a\\(b here\n');
  writeFileSync(path.join(d, 'pat-b.txt'), 'café au lait\n');
  git(d, ['add', 'pat-a.txt', 'pat-b.txt']);
  const ask = (/** @type {string} */ p) => hgit(fx.ctx(), d, ['grep', '-q', '-I', '-E', '-f', '-', '--cached', '--', 'pat-a.txt', 'pat-b.txt'], { input: patternBytes(p), stdio: ['pipe', 'ignore', 'ignore'] }).status;
  assert.equal(ask('(a|b)\\\\\\('), 0);
  assert.equal(ask('a\\\\\\(b'), 0);
  assert.equal(ask('zz\\\\\\(b'), 1);
  assert.equal(ask(Buffer.from('café', 'utf8').toString('latin1')), 0);
});

test('A250 source guard: no core module passes a regular expression to grep as an argument (-e PATTERN or a bare pattern); patterns go by -f, stdin or the environment', () => {
  const dir = path.join(repo, 'control-plane', 'agents', 'scripts', 'core');
  /** @type {string[]} */ const bad = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // a spawn of grep: proc.run('grep', [...]) or hgit(..., ['grep', ...]); -F (a fixed string, no pattern language) is allowed
        if (!/(proc\.run\('grep'|\['grep',)/.test(line)) return;
        if (/'-[A-Za-z]*F[A-Za-z]*'/.test(line) || /'-f'/.test(line) || /'-RFl'/.test(line)) return;
        if (e.name === 'debt.mjs' && line.includes('GREP_RE')) return; // a constant without a backslash, checked below
        bad.push(`${path.relative(repo, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  };
  walk(dir);
  assert.deepEqual(bad, []);
  const debtRe = /^const GREP_RE = '(.*)';$/m.exec(readFileSync(path.join(dir, 'debt.mjs'), 'utf8'));
  assert.ok(debtRe, 'GREP_RE of debt.mjs not found');
  assert.ok(!debtRe[1].includes('\\'), `debt's git grep pattern holds a backslash: ${debtRe[1]}`);
});
