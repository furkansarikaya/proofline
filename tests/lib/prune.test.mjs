// @ts-check
// The pruning of the harness' template cache (tests/lib/prune.mjs, A253): the rules on a fake file system and a fixed clock (nothing reads the real time), the use-between-listing-
// and-removal case at its exact instant (a seam between the rename and the second look), links and other users' folders left alone, and several real processes pruning and copying
// the same cache at once, meeting at a barrier made of an event (a line on stdin), never of a duration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { cached, cleanEnv, copyOf, tmp } from './harness.mjs';
import { POLICY, copyTree, pruneCache, pruneThrottled, removeTree, touchUse } from './prune.mjs';

const NOW = 1_000_000_000_000;   // a fixed instant (2001), in milliseconds: before every real mtime, so what a live process creates now is never old
const MIN = 60e3; const HOUR = 3600e3;
const ME = 501;

/** A file system in memory: just the calls prune.mjs makes. Nodes are dirs, files or links; paths are absolute strings. */
class FakeFs {
  /** @type {Map<string, { type: 'dir' | 'file' | 'link', mtimeMs: number, uid: number, size: number, mode: number }>} */ nodes = new Map();
  /** @type {string[]} */ log = [];
  /** @param {string} p @param {'dir' | 'file' | 'link'} type @param {number} [mtimeMs] @param {number} [uid] @param {number} [size] */
  add(p, type, mtimeMs = NOW, uid = ME, size = 0) { this.nodes.set(p, { type, mtimeMs, uid, size, mode: 0o755 }); return this; }
  /** A cache entry: a folder with a marker used at `usedMs`, and `size` bytes of content. @param {string} root @param {string} name @param {number} usedMs @param {number} [size] */
  entry(root, name, usedMs, size = 10) { return this.add(`${root}/${name}`, 'dir', usedMs).add(`${root}/${name}/.built`, 'file', usedMs).add(`${root}/${name}/data`, 'file', usedMs, ME, size); }
  /** @param {string} p */ #get(p) { const n = this.nodes.get(p); if (!n) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); return n; }
  lstatSync = (/** @type {string} */ p) => { const n = this.#get(p); return { isDirectory: () => n.type === 'dir', isFile: () => n.type === 'file', isSymbolicLink: () => n.type === 'link', mtimeMs: n.mtimeMs, uid: n.uid, size: n.size, blocks: undefined }; };
  readdirSync = (/** @type {string} */ p) => { this.#get(p); return [...this.nodes.keys()].filter((k) => path.dirname(k) === p).map((k) => path.basename(k)); };
  renameSync = (/** @type {string} */ a, /** @type {string} */ b) => {
    const n = this.#get(a);
    if (this.nodes.has(b) && n.type === 'dir' && this.readdirSync(b).length) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
    const par = this.nodes.get(path.dirname(a)); if (par) par.mtimeMs = NOW;   // a rename changes the folder it happens in
    for (const k of [...this.nodes.keys()]) if (k === a || k.startsWith(`${a}/`)) { this.nodes.set(b + k.slice(a.length), /** @type {any} */ (this.nodes.get(k))); this.nodes.delete(k); }
    this.log.push(`rename ${a} ${b}`);
  };
  rmdirSync = (/** @type {string} */ p) => { this.#get(p); if (this.readdirSync(p).length) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' }); this.nodes.delete(p); this.log.push(`rmdir ${p}`); };
  unlinkSync = (/** @type {string} */ p) => { this.#get(p); this.nodes.delete(p); this.log.push(`unlink ${p}`); };
  chmodSync = (/** @type {string} */ p) => { this.#get(p); };
  utimesSync = (/** @type {string} */ p, /** @type {number} */ _a, /** @type {number} */ m) => { this.#get(p).mtimeMs = m * 1000; };
  writeFileSync = (/** @type {string} */ p) => { this.add(p, 'file', NOW); };
  has(/** @type {string} */ p) { return this.nodes.has(p); }
  /** @param {string} root */ names(root) { return this.readdirSync(root).sort(); }
}
const fx = (/** @type {FakeFs} */ f) => /** @type {any} */ (f);
const R = '/cache';
const fresh = () => new FakeFs().add(R, 'dir');

describe('the rules, on a fake file system and a fixed clock', () => {
  test('an entry idle for more than the maximum age goes; a younger one, and the key asked for, stay (with their reasons)', () => {
    const f = fresh().entry(R, 'old', NOW - 7 * HOUR).entry(R, 'mid', NOW - 3 * HOUR).entry(R, 'asked', NOW - 9 * HOUR).entry(R, 'hot', NOW - 1 * MIN);
    const r = pruneCache(R, { now: NOW, keep: ['asked'], fsx: fx(f), uid: ME });
    assert.deepEqual(r.removed.map((x) => [x.name, x.reason]), [['old', 'idle']]);
    assert.deepEqual(f.names(R), ['asked', 'hot', 'mid']);
    assert.equal(r.kept, 3); assert.equal(r.bytes, 10);
  });

  test('over the size cap the least recently used unprotected entries go first, oldest first, and only as many as needed; an entry used lately is never a victim', () => {
    const f = fresh().entry(R, 'a', NOW - 5 * HOUR, 100).entry(R, 'b', NOW - 4 * HOUR, 100).entry(R, 'c', NOW - 2 * HOUR, 100).entry(R, 'recent', NOW - 10 * MIN, 100).entry(R, 'asked', NOW - 3 * HOUR, 100);
    // `data` is the only content (the fake has no block counts): 5 x 100 = 500 bytes against a cap of 350
    const r = pruneCache(R, { now: NOW, keep: ['asked'], policy: { maxBytes: 350 }, fsx: fx(f), uid: ME });
    assert.deepEqual(r.removed.map((x) => [x.name, x.reason]), [['a', 'size'], ['b', 'size']]);
    assert.deepEqual(f.names(R), ['asked', 'c', 'recent']);
  });

  test('protected entries are kept even when the cap cannot be met (the cap is soft: a live run is worth more than the bytes)', () => {
    const f = fresh().entry(R, 'x', NOW - 1 * MIN, 1000).entry(R, 'y', NOW - 2 * MIN, 1000);
    const r = pruneCache(R, { now: NOW, policy: { maxBytes: 1 }, fsx: fx(f), uid: ME });
    assert.deepEqual(r.removed, []); assert.deepEqual(f.names(R), ['x', 'y']);
  });

  test('a private build-* folder, an old tombstone and a folder without a marker go once older than the leftover age; a young one is a live builder or a deletion in progress and stays', () => {
    const f = fresh().add(`${R}/build-k-1`, 'dir', NOW - 2 * HOUR).add(`${R}/build-k-2`, 'dir', NOW - 5 * MIN).add(`${R}/evict-${NOW - 3 * HOUR}-9-1-k`, 'dir', NOW - 9 * HOUR).add(`${R}/evict-${NOW - 5 * MIN}-9-2-j`, 'dir', NOW - 9 * HOUR).add(`${R}/nomark`, 'dir', NOW - 2 * HOUR).add(`${R}/nomark-young`, 'dir', NOW - 1 * MIN);
    f.add(`${R}/build-k-1/deep`, 'file', NOW - 2 * HOUR, ME, 5);
    const r = pruneCache(R, { now: NOW, fsx: fx(f), uid: ME });
    assert.deepEqual(r.removed.map((x) => x.name).sort(), ['build-k-1', `evict-${NOW - 3 * HOUR}-9-1-k`, 'nomark']);
    assert.deepEqual(f.names(R), ['build-k-2', `evict-${NOW - 5 * MIN}-9-2-j`, 'nomark-young'], 'a tombstone made minutes ago is a deletion in progress, whatever the mtime of what it holds');
  });

  test('only real folders of this user are judged: a link, a file and another user\'s folder are left alone however old and however they are named', () => {
    const f = fresh().entry(R, 'mine', NOW - 9 * HOUR).add('/elsewhere', 'dir').add('/elsewhere/precious', 'file', NOW - 9 * HOUR, ME, 7);
    f.add(`${R}/link`, 'link', NOW - 9 * HOUR).add(`${R}/build-link`, 'link', NOW - 9 * HOUR).add(`${R}/file`, 'file', NOW - 9 * HOUR).entry(R, 'theirs', NOW - 9 * HOUR);
    f.nodes.get(`${R}/theirs`).uid = 0;
    pruneCache(R, { now: NOW, fsx: fx(f), uid: ME });
    assert.deepEqual(f.names(R), ['build-link', 'file', 'link', 'theirs']);
    assert.ok(f.has('/elsewhere/precious'));
    assert.deepEqual(f.log.filter((l) => /elsewhere|\/link|build-link/.test(l)), [], 'nothing was done to a link or to what it points at');
  });

  test('removeTree never follows a link inside the tree: the link goes, its target stays', () => {
    const f = fresh().add(`${R}/d`, 'dir').add(`${R}/d/l`, 'link').add('/target', 'dir').add('/target/keep', 'file', NOW, ME, 3);
    removeTree(`${R}/d`, fx(f));
    assert.ok(!f.has(`${R}/d`) && !f.has(`${R}/d/l`)); assert.ok(f.has('/target/keep'));
    removeTree(`${R}/d`, fx(f));   // already gone: done
  });

  test('--dry-run: the same list, nothing touched', () => {
    const mk = () => fresh().entry(R, 'old', NOW - 7 * HOUR).add(`${R}/build-k`, 'dir', NOW - 2 * HOUR).entry(R, 'hot', NOW);
    const real = pruneCache(R, { now: NOW, fsx: fx(mk()), uid: ME });
    const f = mk(); const dry = pruneCache(R, { now: NOW, dryRun: true, fsx: fx(f), uid: ME });
    assert.deepEqual(dry.removed, real.removed); assert.deepEqual(f.log, []); assert.deepEqual(f.names(R), ['build-k', 'hot', 'old']);
  });

  test('a prune is throttled by a stamp in the folder: a second call within the interval does nothing, one after it runs again', () => {
    const f = fresh().entry(R, 'old', NOW - 7 * HOUR);
    const first = pruneThrottled(R, { now: NOW, fsx: fx(f), uid: ME });
    assert.deepEqual(first?.removed.map((x) => x.name), ['old']);
    f.entry(R, 'old2', NOW - 8 * HOUR);
    assert.equal(pruneThrottled(R, { now: NOW + POLICY.stampMs - 1, fsx: fx(f), uid: ME }), undefined);
    assert.ok(f.has(`${R}/old2`));
    assert.deepEqual(pruneThrottled(R, { now: NOW + POLICY.stampMs + 1, fsx: fx(f), uid: ME })?.removed.map((x) => x.name), ['old2']);
  });
});

describe('a use between the listing and the removal', () => {
  const setup = () => fresh().entry(R, 'k', NOW - 7 * HOUR);
  /** @param {FakeFs} f */ const tomb = (f) => [...f.nodes.keys()].find((k) => /^\/cache\/evict-[^/]*$/.test(k)) ?? '';

  test('an entry touched after the listing is renamed back and survives (the second look at the marker)', () => {
    const f = setup();
    const r = pruneCache(R, { now: NOW, fsx: fx(f), uid: ME, afterRename: () => touchUse(tomb(f), NOW, fx(f)) });
    assert.deepEqual(r.removed, []); assert.deepEqual(f.names(R), ['k']); assert.equal(f.nodes.get(`${R}/k/.built`)?.mtimeMs, NOW);
  });

  test('an entry nobody touched is deleted through its tombstone, and no evict-* is left', () => {
    const f = setup();
    const r = pruneCache(R, { now: NOW, fsx: fx(f), uid: ME });
    assert.deepEqual(r.removed.map((x) => x.name), ['k']); assert.deepEqual(f.names(R), []);
    assert.ok(f.log.some((l) => l.startsWith(`rename ${R}/k ${R}/evict-${NOW}-`)), 'renamed before it was deleted');
  });

  test('the key was built again while the pruner looked: the touched entry cannot go back (the place is taken), the tombstone is deleted and the new one stays', () => {
    const f = setup();
    pruneCache(R, { now: NOW, fsx: fx(f), uid: ME, afterRename: () => { touchUse(tomb(f), NOW, fx(f)); f.entry(R, 'k', NOW); } });
    assert.deepEqual(f.names(R), ['k'], 'only the new k is there'); assert.equal(f.nodes.get(`${R}/k/.built`)?.mtimeMs, NOW);
  });
});

describe('the cache of the harness', () => {
  test('cached() records every use in the marker with the injected clock, and prunes by that clock: idle entries and old leftovers go, the key asked for and a used entry stay', () => {
    const root = tmp('cache');
    const old = (/** @type {string} */ name, /** @type {number} */ at) => { mkdirSync(path.join(root, name)); writeFileSync(path.join(root, name, '.built'), ''); utimesSync(path.join(root, name, '.built'), at / 1000, at / 1000); utimesSync(path.join(root, name), at / 1000, at / 1000); };
    old('stale', NOW - 8 * HOUR); old('lately', NOW - 5 * MIN); old('asked', NOW - 9 * HOUR);
    mkdirSync(path.join(root, 'build-dead-1')); utimesSync(path.join(root, 'build-dead-1'), (NOW - 3 * HOUR) / 1000, (NOW - 3 * HOUR) / 1000);
    const t = cached('asked', () => { throw new Error('built over a present template'); }, root, { clock: () => NOW, prune: true });
    assert.equal(t, path.join(root, 'asked'));
    assert.deepEqual(readdirSync(root).sort(), ['.pruned', 'asked', 'lately']);
    assert.equal(lstatSync(path.join(root, 'asked/.built')).mtimeMs, NOW, 'the use is recorded with the injected clock');
    copyOf(t, { clock: () => NOW + 1000 });
    assert.equal(lstatSync(path.join(root, 'asked/.built')).mtimeMs, NOW + 1000, 'a copy is a use too');
  });

  test('a folder other than the default one is not pruned unless asked to (the tests of the cache keep seeing exactly what they built)', () => {
    const root = tmp('cache');
    mkdirSync(path.join(root, 'build-x-1')); utimesSync(path.join(root, 'build-x-1'), 1, 1);
    cached('k', (d) => writeFileSync(path.join(d, 'a'), 'x'), root);
    assert.deepEqual(readdirSync(root).sort(), ['build-x-1', 'k']);
  });

  test('copyOf verifies its copy: a copy that fails or finds the template gone is removed and made again, up to three tries, and no partial folder is left', () => {
    const root = tmp('cache'); const t = cached('k', (d) => writeFileSync(path.join(d, 'a'), 'x'), root);
    let calls = 0; let dirs = /** @type {string[]} */ ([]);
    const flaky = (/** @type {string} */ src, /** @type {string} */ dst) => { calls++; dirs.push(dst); writeFileSync(path.join(dst, 'partial'), '1'); if (calls < 3) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return copyTree(src, dst); };
    const d = copyOf(t, { cp: flaky });
    assert.equal(calls, 3); assert.deepEqual(readdirSync(d).sort(), ['a', 'partial']);
    assert.ok(dirs.slice(0, 2).every((x) => !existsSync(x)), 'the failed copies are gone');
    calls = -10;   // never succeeds
    assert.throws(() => copyOf(t, { cp: flaky }), /ENOENT/);
    assert.equal(calls, -7, 'three tries and then the error');
    // the template was evicted for good before the copy and this process knows its builder: it is built again under the same key and the copy is made
    rmSync(t, { recursive: true, force: true });
    assert.equal(readFileSync(path.join(copyOf(t), 'a'), 'utf8'), 'x');
    assert.ok(existsSync(path.join(t, '.built')), 'the rebuilt template is in place');
    // a template found by its marker whose builder this process does not know cannot be rebuilt: the copy fails and says why
    const foreign = path.join(root, 'foreign'); mkdirSync(foreign); writeFileSync(path.join(foreign, 'a'), 'x'); writeFileSync(path.join(foreign, '.built'), '');
    assert.throws(() => copyOf(foreign, { cp: (/** @type {string} */ src, /** @type {string} */ dst) => { rmSync(src, { recursive: true, force: true }); throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } }), /ENOENT/);
    assert.ok(!existsSync(foreign));
  });
});


test('removeTree on the real file system: a link inside is removed as a link and its target survives', () => {
  const outside = tmp('outside'); writeFileSync(path.join(outside, 'keep'), 'mine');
  const d = tmp('victim'); mkdirSync(path.join(d, 'sub')); writeFileSync(path.join(d, 'sub/f'), 'x'); symlinkSync(outside, path.join(d, 'sub/ln'));
  removeTree(d);
  assert.ok(!existsSync(d)); assert.equal(readFileSync(path.join(outside, 'keep'), 'utf8'), 'mine');
});

test('the default cache (no root given) is pruned by cached(): a stale entry of the user\'s private cache folder goes', async () => {
  const home = tmp('tmpdir'); const root = path.join(home, `proofline-harness-${process.getuid?.() ?? 0}`);
  mkdirSync(path.join(root, 'stale'), { recursive: true, mode: 0o700 }); writeFileSync(path.join(root, 'stale', '.built'), ''); utimesSync(path.join(root, 'stale', '.built'), 1e9, 1e9);
  const code = `import { cached } from ${JSON.stringify(new URL('./harness.mjs', import.meta.url).href)}; import { writeFileSync } from 'node:fs'; import path from 'node:path';
    process.stdout.write(cached('fresh', (d) => writeFileSync(path.join(d, 'a'), 'x')));`;
  const r = await new Promise((res) => { const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env: cleanEnv({ TMPDIR: home }) }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (status) => res({ status, out })); });
  assert.equal(/** @type {any} */ (r).status, 0);
  assert.deepEqual(readdirSync(root).filter((n) => !n.startsWith('.')).sort(), ['fresh']);
});

describe('the copy of a template', () => {
  test('a plain folder (no marker, no builder) is copied as it is and nothing is verified (A253 round 1)', () => {
    const src = tmp('plain'); mkdirSync(path.join(src, 'd')); writeFileSync(path.join(src, 'd/f'), 'f'); writeFileSync(path.join(src, 'x'), 'x');
    const c = copyOf(src);
    assert.deepEqual(readdirSync(c).sort(), ['d', 'x']); assert.equal(readFileSync(path.join(c, 'd/f'), 'utf8'), 'f');
    assert.ok(!existsSync(path.join(src, '.built')), 'nothing was added to the source');
  });

  test('copyTree copies files with their modes, keeps links as links (the target text is not resolved), leaves the named names out, and does not follow a link', () => {
    const src = tmp('src'); const outside = tmp('outside'); writeFileSync(path.join(outside, 'secret'), 's');
    mkdirSync(path.join(src, 'd/e'), { recursive: true }); writeFileSync(path.join(src, 'd/e/f'), 'f'); writeFileSync(path.join(src, 'x.sh'), '#!/bin/sh\n'); chmodSync(path.join(src, 'x.sh'), 0o755);
    writeFileSync(path.join(src, '.built'), ''); symlinkSync('d/e/f', path.join(src, 'rel')); symlinkSync(outside, path.join(src, 'out'));
    const dst = tmp('dst'); copyTree(src, dst, ['.built']);
    assert.deepEqual(readdirSync(dst).sort(), ['d', 'out', 'rel', 'x.sh']);
    assert.equal(lstatSync(path.join(dst, 'x.sh')).mode & 0o777, 0o755);
    assert.equal(readlinkSync(path.join(dst, 'rel')), 'd/e/f'); assert.ok(lstatSync(path.join(dst, 'out')).isSymbolicLink());
    assert.equal(readFileSync(path.join(dst, 'd/e/f'), 'utf8'), 'f');
  });

  test('a source that is gone is an error the caller can catch (the native cpSync aborts the process instead)', () => {
    const src = tmp('src'); mkdirSync(path.join(src, 'a')); writeFileSync(path.join(src, 'a/f'), '1');
    assert.throws(() => copyTree(path.join(src, 'gone'), tmp('dst')), /ENOENT/);
  });
});

describe('several processes at once', () => {
  const harnessUrl = new URL('./harness.mjs', import.meta.url).href; const pruneUrl = new URL('./prune.mjs', import.meta.url).href;
  const POL = { maxBytes: 1 };   // every entry that is not protected is a victim of the size rule

  /**
   * Start a child that runs CODE, which waits at its `//GO` line until it reads a line on stdin (the barrier: every child is up before any of them works) and resolve with its exit status and output.
   * @param {string} code @param {string[]} args
   */
  function child(code, args) {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code.replace('//GO', "await new Promise((r) => process.stdin.once('data', r));"), ...args], { env: cleanEnv({}), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    const up = new Promise((res) => { c.stdin.write('', res); });
    const done = new Promise((res) => c.on('close', (status) => res({ status, out, err })));
    return { up, go: () => c.stdin.write('go\n'), done: /** @type {Promise<{ status: number | null, out: string, err: string }>} */ (done) };
  }

  test('pruners and copiers of one cache at the same instant: every copy is complete, nobody fails, the idle entries are gone, nothing private is left behind', { timeout: 120000 }, async () => {
    const root = tmp('cache');
    const at = (/** @type {number} */ ms) => ms / 1000;
    for (const [name, idle] of [['idle1', 10 * HOUR], ['idle2', 11 * HOUR], ['idle3', 12 * HOUR], ['tpl', 40 * MIN], ['lately', 2 * MIN]]) {
      const d = path.join(root, /** @type {string} */ (name)); mkdirSync(d);
      for (let i = 0; i < 20; i++) writeFileSync(path.join(d, `f${i}`), 'x'.repeat(100));
      writeFileSync(path.join(d, '.built'), '');
      utimesSync(path.join(d, '.built'), at(NOW - /** @type {number} */ (idle)), at(NOW - /** @type {number} */ (idle)));
    }
    mkdirSync(path.join(root, 'build-dead-1')); utimesSync(path.join(root, 'build-dead-1'), at(NOW - 3 * HOUR), at(NOW - 3 * HOUR));
    const pruner = `import { pruneCache } from ${JSON.stringify(pruneUrl)}; const [root, now, pol] = process.argv.slice(1); //GO
      for (let i = 0; i < 5; i++) pruneCache(root, { now: Number(now), policy: JSON.parse(pol), keep: ['lately'] }); process.stdout.write('pruned'); process.exit(0);`;
    const copier = `import { cached, copyOf } from ${JSON.stringify(harnessUrl)}; import { readdirSync, writeFileSync } from 'node:fs'; import path from 'node:path';
      const [root, now, pol] = process.argv.slice(1); const clock = () => Number(now); const seen = []; //GO
      for (let i = 0; i < 6; i++) {
        const t = cached('tpl', (d) => { for (let j = 0; j < 20; j++) writeFileSync(path.join(d, 'f' + j), 'x'.repeat(100)); }, root, { clock, prune: true, policy: JSON.parse(pol) });
        seen.push(readdirSync(copyOf(t, { clock })).length);
      }
      process.stdout.write(JSON.stringify(seen)); process.exit(0);`;
    const kids = [...Array.from({ length: 4 }, () => child(pruner, [root, String(NOW), JSON.stringify(POL)])), ...Array.from({ length: 4 }, () => child(copier, [root, String(NOW), JSON.stringify(POL)]))];
    await Promise.all(kids.map((k) => k.up));
    for (const k of kids) k.go();
    const results = await Promise.all(kids.map((k) => k.done));
    for (const [i, r] of results.entries()) assert.equal(r.status, 0, `child ${i}: ${r.err}`);
    for (const r of results.slice(4)) assert.deepEqual(JSON.parse(r.out), [20, 20, 20, 20, 20, 20], 'every copy is complete (20 files; the marker is not copied)');
    const left = readdirSync(root).sort();
    assert.ok(!left.some((n) => /^(idle|build-|evict-)/.test(n)), `idle entries and private folders are gone: ${left}`);
    assert.ok(left.includes('lately') && left.includes('tpl'), `the entries in use are there: ${left}`);
  });
});

test('the default knobs are the ones the docs name (2 GB, 30 minutes of protection, 2 hours for temp folders)', () => {
  assert.equal(POLICY.maxBytes, 2 * 1024 ** 3); assert.equal(POLICY.protectMs, 30 * MIN); assert.equal(POLICY.tempMs, 2 * HOUR);
});

// A link inside a real cache folder is not followed by the real file system calls either.
test('a link in a real cache folder, old and named like an entry, survives a prune together with its target', () => {
  const root = tmp('cache'); const outside = tmp('outside'); writeFileSync(path.join(outside, 'keep'), 'mine');
  symlinkSync(outside, path.join(root, 'link')); symlinkSync(outside, path.join(root, 'build-link'));
  pruneCache(root, { now: NOW + 100 * HOUR });
  assert.deepEqual(readdirSync(root).sort(), ['build-link', 'link']); assert.ok(existsSync(path.join(outside, 'keep')));
});
