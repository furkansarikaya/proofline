// The translation staleness check: stale warns (exit 0), fresh is silent, a bad header or a missing English file is an error (exit 1), nothing in a file is executed, and the real
// repository's translations are fresh. Hermetic: fixtures are strings and temp directories; the only process started is the check itself, for its exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { blobId, check, parseHeader, rootFs, safeName, HEADER_RE } from './translation-stale.mjs';
import { tempDir } from '../lib/tempdir.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const script = path.join(import.meta.dirname, 'translation-stale.mjs');
const EN = 'docs/guides/a.md';
/** @param {string} en @param {string} blob */
const tr = (en, blob) => `# Baslik\n\n<!-- translated-from: ${en}; blob: ${blob} -->\n\nmetin\n`;

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
  for (const body of ['# T\n\nno header\n', `# T\n<!-- translated-from: ${EN}; blob: XYZ -->\n`, `# T\n<!-- translated-from: ${EN}; blob: ${blobId(en)}; commit: abc1234 -->\n`]) {
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
  const good = `<!-- translated-from: ${EN}; blob: ${'a'.repeat(40)} -->`;
  assert.ok(HEADER_RE.test(good));
  assert.equal(parseHeader(`x ${good}`).ok, false);
  assert.equal(parseHeader(`${good} x`).ok, false);
  assert.equal(parseHeader(good.replace('docs/guides/a.md', '../etc/passwd')).ok, false);
  assert.equal(parseHeader(good.replace('docs/guides/a.md', 'docs/../../etc/x.md')).ok, false);
  assert.equal(parseHeader(`${good}\n${good}`).ok, false);
  assert.equal(parseHeader(`# T\n\n${good}\n`).ok, true);
});

test('the header must be outside a code fence and within 6 lines after the title', () => {
  const h = `<!-- translated-from: ${EN}; blob: ${'a'.repeat(40)} -->`;
  assert.equal(parseHeader(`# T\n\n\`\`\`\n${h}\n\`\`\`\n`).ok, false, 'fenced');
  assert.equal(parseHeader(`# T\n\n~~~\n${h}\n~~~\n`).ok, false, 'tilde fence');
  assert.equal(parseHeader(`# T\n${'x\n'.repeat(5)}${h}\n`).ok, true, '6th line after the title');
  assert.equal(parseHeader(`# T\n${'x\n'.repeat(6)}${h}\n`).ok, false, '7th line');
  assert.equal(parseHeader(`${h}\n# T\n`).ok, false, 'before the title');
  assert.equal(parseHeader(`no title\n${h}\n`).ok, false);
});

test('a hostile translation file name never injects a workflow command and is an error', () => {
  const en = 'English\n';
  const names = ['x.md\n::error::pwned.md', 'a,b::c%0A.md', 'a:b.md', 'p%0Aq.md', `${'n'.repeat(200)}!.md`, 'sp ace.md', 'cr\r::error::z.md'];
  for (const name of names) {
    const root = fixture({ [EN]: en, [`docs/guides/tr/${name}`]: tr(EN, blobId(en)) });
    const r = run(root);
    assert.equal(r.status, 1, JSON.stringify(name));
    const cmds = r.stdout.split('\n').filter((l) => l.startsWith('::'));
    assert.equal(cmds.length, 1, `${JSON.stringify(name)}: ${r.stdout}`);
    assert.match(cmds[0], /^::error file=docs\/guides\/tr\/[A-Za-z0-9._?-]+::/);
    assert.ok(!r.stdout.includes('pwned') || !/^::error::pwned/m.test(r.stdout));
    assert.ok(r.stdout.split('\n').every((l) => l === '' || l.startsWith('::error file=') || l.startsWith('ERROR ')));
  }
  assert.equal(safeName('a,b::c\n.md'), 'a?b??c?.md');
  assert.equal(safeName('x'.repeat(300)).length, 100);
});

test('a valid but long name works and the stale warning is the only :: line', () => {
  const name = `${'n'.repeat(120)}.md`;
  const root = fixture({ [EN]: 'new\n', [`docs/guides/tr/${name}`]: tr(EN, blobId('old\n')) });
  const r = run(root);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('::')).length, 1);
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
