// @ts-check
// Tests for tests/ci/sync-design-library.mjs (A170): --check passes against a local mirror built from the repository's own library copies (no network),
// and fails when one mirrored file or the mirrored licence differs; sync and --update rewrite the copies and the notices from the mirror. Source ids,
// paths and file names are read from the notices file, never written here.
import assert from 'node:assert/strict';
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { MAX_BYTES, getLimited, main } from './sync-design-library.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const T = mkdtempSync(path.join(tmpdir(), 'sync-test-'));
after(() => rmSync(T, { recursive: true, force: true }));
const rel = 'skills/ui-design/library';
const notices = readFileSync(path.join(repo, rel, 'THIRD_PARTY_NOTICES.md'), 'utf8').split('\n');

/** The sections of the notices file: id, path in the source, licence file, files, licence text. */
const sources = notices.flatMap((l) => { const m = /^- (source-[0-9]+) \| /.exec(l); return m ? [m[1]] : []; }).map((id) => {
  const sec = []; let on = false;
  for (const l of notices) { if (l.startsWith('## ')) on = l.split(/\s+/)[1] === id; if (on) sec.push(l); }
  const field = (/** @type {string} */ k) => sec.find((l) => l.startsWith(`- ${k}: `))?.slice(k.length + 4) ?? '';
  const lic = []; let fence = false;
  for (const l of sec) { if (!fence) { if (l === '```text') fence = true; continue; } if (l === '```') break; lic.push(l); }
  return { id, srcPath: field('Path'), licenceFile: field('Licence file'), files: sec.flatMap((l) => { const m = /^ {2}- `([^`]+)` sha256 /.exec(l); return m ? [m[1]] : []; }), licence: lic.map((l) => `${l}\n`).join('') };
});

/** A mirror built from the repository's own copies. */
function mirror() {
  const dir = mkdtempSync(path.join(T, 'mirror-'));
  for (const s of sources) {
    mkdirSync(path.join(dir, s.id, s.srcPath), { recursive: true });
    writeFileSync(path.join(dir, s.id, s.licenceFile), s.licence);
    for (const f of s.files) cpSync(path.join(repo, rel, f), path.join(dir, s.id, s.srcPath, f));
  }
  return dir;
}
/** A throwaway root with the library. */
function copyRoot() {
  const dir = mkdtempSync(path.join(T, 'root-'));
  cpSync(path.join(repo, rel), path.join(dir, rel), { recursive: true });
  return dir;
}
/** @param {string[]} argv @param {string} mirrorDir @param {string} [root] */
async function run(argv, mirrorDir, root = repo) {
  let out = ''; const err = console.error; let msg = '';
  console.error = (/** @type {string} */ m) => { msg += `${m}\n`; };
  try { const status = await main(argv, { root, env: { DESIGN_LIBRARY_MIRROR: mirrorDir }, write: (s) => { out += s; } }); return { status, out, msg }; } finally { console.error = err; }
}

describe('--check', () => {
  test('there are sources to read', () => assert.ok(sources.length >= 1 && sources.every((s) => s.files.length > 0)));
  test('passes against an identical mirror and says how many files', async () => {
    const r = await run(['--check'], mirror());
    assert.equal(r.status, 0, r.out + r.msg);
    assert.match(r.out, /^design library: \d+ files byte-identical to their pins$/m);
  });
  test('fails when a copy differs from its pin, and names the file', async () => {
    const m = mirror(); const s = sources[0]; const f = s.files[0];
    appendFileSync(path.join(m, s.id, s.srcPath, f), ' ');
    const r = await run(['--check'], m);
    assert.equal(r.status, 1);
    assert.match(r.out, new RegExp(`^FAIL ${s.id}: ${f.replace(/\./g, '\\.')} differs from the pinned source$`, 'm'));
    assert.match(r.out, /^design library: 1 problem\(s\)$/m);
  });
  test('fails when the mirrored licence differs from the licence text in the notices', async () => {
    const m = mirror(); const s = sources[0];
    appendFileSync(path.join(m, s.id, s.licenceFile), 'extra\n');
    const r = await run(['--check'], m);
    assert.equal(r.status, 1);
    assert.match(r.out, new RegExp(`${s.id}: licence text in the notices differs`));
  });
  test('fails when a source file cannot be fetched, or the recorded hash is stale, or the copy is missing', async () => {
    const m = mirror(); const s = sources[0];
    rmSync(path.join(m, s.id, s.srcPath, s.files[0]));
    assert.match((await run(['--check'], m)).out, /cannot fetch/);
    const root = copyRoot();
    appendFileSync(path.join(root, rel, s.files[0]), ' ');
    const m2 = mirror(); appendFileSync(path.join(m2, s.id, s.srcPath, s.files[0]), ' ');
    assert.match((await run(['--check'], m2, root)).out, /hash in the notices is stale/);
    rmSync(path.join(root, rel, s.files[0]));
    assert.match((await run(['--check'], mirror(), root)).out, /is missing from the library/);
  });
});

describe('sync and --update', () => {
  test('sync rewrites the copies from the mirror and the hashes in the notices; a following --check passes', async () => {
    const m = mirror(); const s = sources[0]; const f = s.files[0];
    appendFileSync(path.join(m, s.id, s.srcPath, f), '\n');
    const root = copyRoot();
    const r = await run([], m, root);
    assert.equal(r.status, 0, r.out + r.msg);
    assert.match(r.out, /^design library: synced \d+ files$/m);
    assert.equal(readFileSync(path.join(root, rel, f), 'utf8'), readFileSync(path.join(m, s.id, s.srcPath, f), 'utf8'));
    assert.equal((await run(['--check'], m, root)).status, 0);
    // the notices keep their header and every section
    const after = readFileSync(path.join(root, rel, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const x of sources) assert.ok(after.includes(`## ${x.id}\n`), x.id);
  });
  test('--update moves one pin and re-fetches only that source', async () => {
    const m = mirror(); const root = copyRoot(); const s = sources[0];
    const sha = 'a'.repeat(40);
    const before = readdirSync(path.join(root, rel)).length;
    const r = await run(['--update', s.id, sha], m, root);
    assert.equal(r.status, 0, r.msg);
    const text = readFileSync(path.join(root, rel, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const sec = text.split(`## ${s.id}\n`)[1].split('\n## ')[0];
    assert.match(sec, new RegExp(`^- Commit: ${sha}$`, 'm'));
    assert.equal(readdirSync(path.join(root, rel)).length, before);
    if (sources.length > 1) assert.ok(!text.split(`## ${sources[1].id}\n`)[1].split('\n## ')[0].includes(sha), 'the other pin is unchanged');
  });
  test('a source that cannot be fetched touches nothing', async () => {
    const m = mirror(); const root = copyRoot(); const s = sources.at(-1) ?? sources[0];
    rmSync(path.join(m, s.id, s.srcPath, s.files.at(-1) ?? ''));
    const keep = readFileSync(path.join(root, rel, 'THIRD_PARTY_NOTICES.md'));
    const r = await run([], m, root);
    assert.equal(r.status, 1);
    assert.ok(readFileSync(path.join(root, rel, 'THIRD_PARTY_NOTICES.md')).equals(keep));
  });
});

describe('usage', () => {
  test('bad arguments exit 2 with a message', async () => {
    const m = mirror(); const sha = 'b'.repeat(40);
    for (const a of [['--bogus'], ['--update', 'x'], ['--check', 'x'], ['--update', sources[0].id, 'abc'], ['--update', 'source-999', sha]]) assert.equal((await run(a, m)).status, 2, a.join(' '));
  });
});

describe('hardening (A236 fix round 1)', () => {
  /** A root whose notices file is edited. @param {(t: string) => string} edit */
  function editedRoot(edit) {
    const root = copyRoot(); const f = path.join(root, rel, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(f, edit(readFileSync(f, 'utf8')));
    return root;
  }
  test('a Repository outside https://github.com/ and a Commit that is not 40 hex characters are refused before any request', async () => {
    const m = mirror();
    for (const edit of [(/** @type {string} */ t) => t.replace(/^- Repository: https:\/\/github\.com\//m, '- Repository: https://evil.example/'), (/** @type {string} */ t) => t.replace(/^- Commit: .*$/m, '- Commit: main')]) {
      for (const argv of [['--check'], []]) {
        const r = await run(argv, m, editedRoot(edit));
        assert.equal(r.status, 1, argv.join(' ')); assert.match(r.msg, /must start with https:\/\/github\.com\/|40 hex/);
      }
    }
  });
  test('a file name that resolves outside the library is refused and nothing is written', async () => {
    const m = mirror(); const s = sources[0];
    const root = editedRoot((t) => t.replace(`  - \`${s.files[0]}\``, '  - `../../../escape.txt`'));
    const r = await run([], m, root);
    assert.equal(r.status, 1); assert.match(r.msg, /unsafe path|outside/);
    assert.ok(!existsSync(path.join(root, 'skills/escape.txt')) && !existsSync(path.join(root, 'escape.txt')));
  });
  test('a mirrored file over the byte cap counts as not fetched', async () => {
    const m = mirror(); const s = sources[0];
    writeFileSync(path.join(m, s.id, s.srcPath, s.files[0]), Buffer.alloc(MAX_BYTES + 1));
    const r = await run(['--check'], m);
    assert.equal(r.status, 1); assert.match(r.out, /cannot fetch/);
  });
  const resp = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers, /** @type {string | Buffer} */ body) => new Response(status === 200 ? body : null, { status, headers });
  test('getLimited follows one hop to raw.githubusercontent.com only, never to another host, a second hop or plain http', async () => {
    const at = (/** @type {string} */ loc) => async (/** @type {any} */ u) => (String(u).startsWith('https://github.test') ? resp(302, { location: loc }, '') : resp(200, {}, 'ok'));
    assert.equal((await getLimited('https://github.test/x', /** @type {any} */ (at('https://raw.githubusercontent.com/a/b'))))?.toString(), 'ok');
    assert.equal(await getLimited('https://github.test/x', /** @type {any} */ (at('https://evil.example/a'))), null);
    assert.equal(await getLimited('https://github.test/x', /** @type {any} */ (at('http://raw.githubusercontent.com/a'))), null);
    const modes = []; 
    await getLimited('https://github.test/x', /** @type {any} */ (async (/** @type {any} */ u, /** @type {any} */ o) => { modes.push(o.redirect); return String(u).startsWith('https://github.test') ? resp(302, { location: 'https://raw.githubusercontent.com/a' }, '') : resp(200, {}, 'ok'); }));
    assert.deepEqual(modes, ['manual', 'error'], 'the second request may not redirect again');
  });
  test('getLimited refuses a body over the cap, declared or streamed', async () => {
    assert.equal(await getLimited('https://x.test/a', /** @type {any} */ (async () => resp(200, { 'content-length': String(MAX_BYTES + 1) }, 'x'))), null);
    assert.equal(await getLimited('https://x.test/a', /** @type {any} */ (async () => resp(200, {}, Buffer.alloc(MAX_BYTES + 1)))), null);
    assert.equal((await getLimited('https://x.test/a', /** @type {any} */ (async () => resp(200, {}, Buffer.alloc(1000)))))?.length, 1000);
    assert.equal(await getLimited('https://x.test/a', /** @type {any} */ (async () => resp(404, {}, ''))), null);
  });
});
