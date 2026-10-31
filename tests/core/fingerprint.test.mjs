// @ts-check
// fingerprint.mjs against the shell: the content fingerprint (gate, full, legacy), path fingerprints and the cache key, on fixture trees.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { describe, test, after } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { cacheKey, contentFingerprint, gateFingerprint, hashFile, pathFingerprint, baselineMap, baselineFingerprint } from '../../control-plane/agents/scripts/core/fingerprint.mjs';
import { extractFunctions } from './helpers.mjs';
import { git, makeFixture } from './fixture.mjs';

const fx = makeFixture();
after(() => rmSync(fx.root, { recursive: true, force: true }));
/** @param {string} rel @param {string} text */
const put = (rel, text) => { mkdirSync(path.dirname(path.join(fx.root, rel)), { recursive: true }); writeFileSync(path.join(fx.root, rel), text); };

/** @param {string} label */
function same(label) {
  const ctx = fx.ctx();
  const shGate = fx.sh(['fingerprint']).out.trim();
  const shFull = fx.sh(['fingerprint', '', 'full']).out.trim();
  assert.equal(gateFingerprint(ctx), shGate, `gate: ${label}`);
  assert.equal(contentFingerprint(fx.ctx()), shFull, `full: ${label}`);
}

describe('content fingerprint equals the shell', () => {
  test('clean tree, changes, untracked', () => {
    same('clean');
    put('src/a.txt', 'a\n'); same('untracked');
    put('README.md', 'changed\n'); same('modified');
    git(fx.root, ['add', 'src/a.txt']); same('staged');
  });
  test('control plane files are not content: .agents, installed files, proofline block', () => {
    put('.agents/local/x', 'x'); put('.claude/agents/proofline-qa.md', 'q'); same('installed pattern');
    put('AGENTS.md', 'project rules\n<!-- proofline:begin -->\nblock\n<!-- proofline:end -->\n'); same('block plus text');
    put('AGENTS.md', '<!-- proofline:begin -->\nblock\n<!-- proofline:end -->\n'); same('block only');
    put('CLAUDE.md', 'x\n<!-- proofline:begin -->\nb\n<!-- proofline:end -->\nafter'); same('block, last line without newline');
    put('.agents/.proofline-manifest', '# c\nabc docs/installed.md\nabc .agents/inner.md\n'); put('docs/installed.md', 'i'); same('manifest-listed');
  });
  test('knowledge documents leave the gate fingerprint only', () => {
    put('docs/wiki/page.md', 'w\n'); put('docs/wiki/tool.sh', 'sh\n'); same('wiki');
    assert.notEqual(gateFingerprint(fx.ctx()), contentFingerprint(fx.ctx()));
  });
  test('a plan scope keeps a control plane path in the tree', () => {
    put('.agents/keepme.txt', 'k\n');
    put('.agents/runs/R1/PLAN.md', 'x\nscope:\n  - path: .agents/keepme.txt\n    criteria: [AC-1]\n---\n');
    put('.agents/runs/R1/RUN.yaml', 'execution:\n  state: "PLANNED"\n');
    same('scope names .agents path');
  });
  test('a symlink to a directory and an executable bit', () => {
    symlinkSync('src', path.join(fx.root, 'lnk')); chmodSync(path.join(fx.root, 'src/a.txt'), 0o755); same('symlink and mode');
  });
});

describe('path fingerprints and cache key', () => {
  test('hash, missing, errors', () => {
    put('f.txt', 'data\n');
    const ctx = fx.ctx();
    const sh = spawnSync('sh', ['-c', 'printf "data\\n" | (shasum -a 256 2>/dev/null || sha256sum) | cut -d" " -f1'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(pathFingerprint(ctx, 'f.txt'), sh);
    assert.equal(hashFile(`${fx.root}/f.txt`), sh);
    assert.equal(pathFingerprint(ctx, 'nope.txt'), 'missing');
    assert.throws(() => pathFingerprint(ctx, 'lnk'), /cannot baseline symlink: lnk/);
    assert.throws(() => pathFingerprint(ctx, 'src'), /cannot baseline non-regular file: src/);
  });
  test('the cache key is the shell fp_cache_key', () => {
    put('big.bin', 'x'.repeat(300000));
    const fns = extractFunctions(['fp_cache_key']);
    const r = spawnSync('sh', ['-c', `cfg() { printf '%s\\n' "\${2:-}"; }\n${fns}\nfp_cache_key "$1" big.bin`, 'x', `${fx.root}/big.bin`], { encoding: 'latin1' });
    assert.equal(cacheKey(fx.ctx(), `${fx.root}/big.bin`, 'big.bin'), r.stdout.trim());
    assert.equal(cacheKey(fx.ctx(), `${fx.root}/f.txt`, 'f.txt'), null);
  });
  test('cache modes: yes reads, refresh stores, no hashes', () => {
    const ctx = fx.ctx();
    ctx.fpMode = 'refresh';
    const h = pathFingerprint(ctx, 'big.bin');
    const k = cacheKey(ctx, `${fx.root}/big.bin`, 'big.bin');
    const ctx2 = fx.ctx(); ctx2.fpMode = 'yes';
    assert.equal(pathFingerprint(ctx2, 'big.bin'), h);
    assert.ok(spawnSync('grep', ['-c', `^${k?.replace(/[.|]/g, '\\$&')}\t`, `${fx.root}/.agents/local/fp-cache`], { encoding: 'utf8' }).stdout.trim() >= '1');
  });
});

describe('baseline map', () => {
  test('first entry per type and path, stops at a malformed one', () => {
    put('.agents/runs/B1/RUN.yaml', 'baseline:\n  status: captured\n  tracked:\n    - path: a\n      sha256: "h1"\n    - path: a\n      sha256: "h2"\n  untracked:\n    - path: b\n      sha256: "h3"\n    - path: c\n    - path: d\n      sha256: "h4"\nnext:\n  k: v\n');
    const ctx = fx.ctx(); const dir = `${fx.root}/.agents/runs/B1`;
    assert.equal(baselineFingerprint(ctx, 'tracked', 'a', dir), 'h1');
    assert.equal(baselineFingerprint(ctx, 'untracked', 'b', dir), 'h3');
    assert.equal(baselineFingerprint(ctx, 'untracked', 'd', dir), '');
    assert.equal(baselineMap(ctx, dir).size, 2);
  });
});

describe('the cache is never written through a link or with a control character (S2-3)', () => {
  const big = 'big;echo PWNED>&2;#.txt';
  test('node: a link at fp-cache or at .agents/local is no cache; the victim stays untouched', () => {
    const f = makeFixture();
    try {
      put2(f.root, big, 'x'.repeat(300000));
      const victim = path.join(f.root, 'victim');
      writeFileSync(victim, 'keep\n');
      mkdirSync(path.join(f.root, '.agents/local'), { recursive: true });
      symlinkSync(victim, path.join(f.root, '.agents/local/fp-cache'));
      const ctx = f.ctx(); ctx.fpMode = 'refresh';
      assert.match(pathFingerprint(ctx, big), /^[0-9a-f]{64}$/);
      assert.equal(readFileSync(victim, 'utf8'), 'keep\n');
      rmSync(path.join(f.root, '.agents/local/fp-cache'));
      const other = path.join(f.root, 'elsewhere'); mkdirSync(other);
      rmSync(path.join(f.root, '.agents/local'), { recursive: true }); symlinkSync(other, path.join(f.root, '.agents/local'));
      const ctx2 = f.ctx(); ctx2.fpMode = 'refresh'; pathFingerprint(ctx2, big);
      assert.deepEqual(readdirSync(other), []);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  test('node: a regular cache works; a key with a control character is not written', () => {
    const f = makeFixture();
    try {
      put2(f.root, big, 'x'.repeat(300000)); put2(f.root, 'tab\there.txt', 'y'.repeat(300000));
      const ctx = f.ctx(); ctx.fpMode = 'refresh';
      pathFingerprint(ctx, big); pathFingerprint(ctx, 'tab\there.txt');
      const text = readFileSync(path.join(f.root, '.agents/local/fp-cache'), 'latin1');
      assert.equal(text.split('\n').filter(Boolean).length, 1);
      assert.ok(text.startsWith(`${big}|300000|`));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  test('shell: the same two cases', () => {
    const f = makeFixture();
    try {
      put2(f.root, big, 'x'.repeat(300000));
      const victim = path.join(f.root, 'victim'); writeFileSync(victim, 'keep\n');
      mkdirSync(path.join(f.root, '.agents/local'), { recursive: true });
      symlinkSync(victim, path.join(f.root, '.agents/local/fp-cache'));
      const fns = extractFunctions(['fp_cache_file', 'fp_cache_usable', 'fp_cache_put']);
      const run = () => spawnSync('sh', ['-c', `sr_main="${f.root}"\n${fns}\nfp_cache_put "$1" "$2"`, 'x', `${big}|1|2|3|4`, 'a'.repeat(64)], { encoding: 'utf8' });
      run();
      assert.equal(readFileSync(victim, 'utf8'), 'keep\n');
      rmSync(path.join(f.root, '.agents/local/fp-cache'));
      run();
      assert.ok(readFileSync(path.join(f.root, '.agents/local/fp-cache'), 'latin1').startsWith(`${big}|1|2|3|4\t`));
      spawnSync('sh', ['-c', `sr_main="${f.root}"\n${fns}\nfp_cache_put "$1" "$2"`, 'x', 'bad\tkey', 'b'.repeat(64)]);
      assert.ok(!readFileSync(path.join(f.root, '.agents/local/fp-cache'), 'latin1').includes('bad'));
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

/** @param {string} root @param {string} rel @param {string} text */
function put2(root, rel, text) { writeFileSync(path.join(root, rel), text); }
