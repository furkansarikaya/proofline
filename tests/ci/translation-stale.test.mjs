// The translation staleness check: stale warns (exit 0), fresh is silent, a bad header or a missing English file is an error (exit 1), nothing in a file is executed, and the real
// repository's translations are fresh. Hermetic: fixtures are strings and temp directories; the only process started is the check itself, for its exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { blobId, check, parseHeader, rootFs, HEADER_RE } from './translation-stale.mjs';
import { tempDir } from '../lib/tempdir.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const script = path.join(import.meta.dirname, 'translation-stale.mjs');
const EN = 'docs/guides/a.md';
/** @param {string} en @param {string} blob */
const tr = (en, blob) => `# Baslik\n\n<!-- translated-from: ${en}; blob: ${blob}; commit: abc1234 -->\n\nmetin\n`;

/** A temp repo with the English file and translations: files = { relative path: text }. @param {Record<string, string>} files */
function fixture(files) {
  const root = tempDir('tr-');
  for (const [rel, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); }
  return root;
}
/** @param {string} root */
const run = (root) => spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });

test('blobId equals the git object id (known vectors, CRLF read as LF)', () => {
  assert.equal(blobId('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(blobId('hello\r\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(blobId(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('fresh: silent, exit 0', () => {
  const en = 'English\n';
  const root = fixture({ [EN]: en, 'docs/guides/tr/a.md': tr(EN, blobId(en)) });
  const r = run(root);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('stale: a warning annotation and a plain line, exit 0', () => {
  const root = fixture({ [EN]: 'English changed\n', 'docs/guides/tr/a.md': tr(EN, blobId('English\n')) });
  const r = run(root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^::warning file=docs\/guides\/tr\/a\.md::/m);
  assert.match(r.stdout, /^WARNING docs\/guides\/tr\/a\.md: /m);
  assert.ok(!/::error/.test(r.stdout));
});

test('malformed or missing header: an error, exit 1', () => {
  const en = 'English\n';
  for (const body of ['# T\n\nno header\n', `# T\n<!-- translated-from: ${EN}; blob: XYZ; commit: abc1234 -->\n`, `# T\n<!-- translated-from: ${EN}; blob: ${blobId(en)} -->\n`]) {
    const root = fixture({ [EN]: en, 'docs/guides/tr/a.md': body });
    const r = run(root);
    assert.equal(r.status, 1, body);
    assert.match(r.stdout, /^::error file=docs\/guides\/tr\/a\.md::/m);
  }
});

test('a header naming a missing English file: an error, exit 1', () => {
  const root = fixture({ 'docs/guides/tr/a.md': tr('docs/guides/gone.md', blobId('x')) });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not exist/);
});

test('the header regex is anchored: text before or after it on the line, a path leaving docs/, or a second header does not count', () => {
  const good = `<!-- translated-from: ${EN}; blob: ${'a'.repeat(40)}; commit: abc1234 -->`;
  assert.ok(HEADER_RE.test(good));
  assert.equal(parseHeader(`x ${good}`).ok, false);
  assert.equal(parseHeader(`${good} x`).ok, false);
  assert.equal(parseHeader(good.replace('docs/guides/a.md', '../etc/passwd')).ok, false);
  assert.equal(parseHeader(good.replace('docs/guides/a.md', 'docs/../../etc/x.md')).ok, false);
  assert.equal(parseHeader(`${good}\n${good}`).ok, false);
  assert.equal(parseHeader(`# T\n\n${good}\n`).ok, true);
});

test('the check only reads: shell syntax and script-looking text in a file is never run, and nothing is created', () => {
  const evil = '$(touch PWNED) `touch PWNED2` ; touch PWNED3\n';
  const root = fixture({ [EN]: evil, 'docs/guides/tr/a.md': `${tr(EN, blobId(evil))}\n${evil}` });
  const r = run(root);
  assert.equal(r.status, 0);
  const seen = rootFs(root).read('PWNED');
  assert.equal(seen, null);
  assert.equal(rootFs(root).read('PWNED2'), null);
  assert.equal(rootFs(root).read('PWNED3'), null);
});

test('the real repository: both Turkish guides are fresh (their blob ids match the English files)', () => {
  const r = check(rootFs(repo));
  assert.deepEqual(r.lines, []);
  assert.equal(r.code, 0);
  const listed = rootFs(repo).list();
  assert.deepEqual(listed, ['docs/guides/tr/gunluk-kullanim.md', 'docs/guides/tr/prompt-katalogu.md']);
  // cross-check one of them against git itself
  const en = 'docs/guides/daily-use.md';
  const git = execFileSync('git', ['hash-object', '--no-filters', en], { cwd: repo, encoding: 'utf8' }).trim();
  assert.equal(blobId(readFileSync(path.join(repo, en))), git);
});
