// @ts-check
// The fixture helpers (tests/lib/fixture.mjs, tests/lib/tree.mjs): a builder writes only inside its target, the CLI contract of a builder
// (usage 2, non-empty target 1), and the tree digest sees content, mode and git state but not the directory it was built in.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { Fx } from './fixture.mjs';
import { digest, manifest } from './tree.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'fixture-lib-'));

test('Fx refuses a path that leaves the target', () => {
  const t = tmp();
  try {
    const f = new Fx(path.join(t, 'x'));
    assert.throws(() => f.w('../escape.txt', 'x'), /leaves the target/);
    assert.throws(() => f.w('a/../../escape.txt', 'x'), /leaves the target/);
    assert.throws(() => f.mkdir('/etc/proofline-x'), /leaves the target/);
    f.w('a/b.txt', 'ok'); assert.equal(f.read('a/b.txt'), 'ok');
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('a builder CLI exits 2 on a wrong call and 1 on a non-empty target', () => {
  const t = tmp();
  try {
    const setup = path.resolve(import.meta.dirname, '../../fixtures/llm-wiki/setup.mjs');
    assert.equal(spawnSync(process.execPath, [setup], { encoding: 'utf8' }).status, 2);
    mkdirSync(path.join(t, 'full')); writeFileSync(path.join(t, 'full', 'f'), 'x');
    const r = spawnSync(process.execPath, [setup, path.join(t, 'full')], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /target directory is not empty/);
    assert.equal(spawnSync(process.execPath, [setup, path.join(t, 'new')], { encoding: 'utf8' }).status, 0);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('the tree digest follows content and mode, not the build directory; the directory name inside a file is normalised', () => {
  const t = tmp();
  try {
    const build = (/** @type {string} */ d, /** @type {string} */ body, /** @type {number} */ mode) => { const f = new Fx(d); f.w('a.txt', body, mode); f.w('b/c.txt', `root=${d}\n`); };
    build(path.join(t, 'one'), 'same', 0o644); build(path.join(t, 'two'), 'same', 0o644);
    assert.equal(digest(path.join(t, 'one')), digest(path.join(t, 'two')));
    build(path.join(t, 'three'), 'other', 0o644); assert.notEqual(digest(path.join(t, 'one')), digest(path.join(t, 'three')));
    if (process.platform !== 'win32') { build(path.join(t, 'four'), 'same', 0o755); assert.notEqual(digest(path.join(t, 'one')), digest(path.join(t, 'four'))); }
    symlinkSync('a.txt', path.join(t, 'one', 'ln')); assert.ok(manifest(path.join(t, 'one')).some((l) => l.startsWith('ln\tlink\t')));
    chmodSync(path.join(t, 'one'), 0o755);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('a git history is part of the digest: another message gives another tree', () => {
  const t = tmp();
  try {
    const build = (/** @type {string} */ d, /** @type {string} */ msg) => { const f = new Fx(d); f.init(); f.w('x', '1'); f.commit(msg, '2026-01-01T10:00:00Z'); };
    build(path.join(t, 'a'), 'first'); build(path.join(t, 'b'), 'first'); build(path.join(t, 'c'), 'second');
    assert.equal(digest(path.join(t, 'a')), digest(path.join(t, 'b')));
    assert.notEqual(digest(path.join(t, 'a')), digest(path.join(t, 'c')));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('a selfcheck whose file is missing fails like the others: message on stderr, exit 1, no stack', () => {
  const t = tmp();
  try {
    const root = path.resolve(import.meta.dirname, '../..');
    const dir = path.join(t, 'fx');
    assert.equal(spawnSync(process.execPath, [path.join(root, 'fixtures/visual-proof/setup.mjs'), dir]).status, 0);
    rmSync(path.join(dir, 'app/app.js'));
    const r = spawnSync(process.execPath, [path.join(root, 'fixtures/visual-proof/selfcheck.mjs'), dir], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.equal(r.stderr, 'selfcheck: app/app.js missing\n');
  } finally { rmSync(t, { recursive: true, force: true }); }
});
