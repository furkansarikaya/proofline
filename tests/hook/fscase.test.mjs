// @ts-check
// A278 (issue #264, AC-5 and AC-6): the file-system case probe of adapters/claude/hooks/lib/fscase.mjs. One real-file-system test (the probe on a temp folder agrees with what the
// folder really does, whatever host this runs on) and tests on injected probes (a fake volume that folds case, one that does not, a mixed tree, a probe that throws).
// No test depends on the host being macOS or Linux; nothing waits; every folder is made by tempDir.
import { tempDir } from '../lib/tempdir.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFsCase, fold, insensitiveAt, provenInsensitiveAt, realProbe, same, under, useFsCase } from '../../adapters/claude/hooks/lib/fscase.mjs';

/** @param {ReturnType<typeof createFsCase>} inst @param {() => void} fn */
function withVolume(inst, fn) { const prev = useFsCase(inst); try { fn(); } finally { useFsCase(prev); } }

test('A278 real probe: it reports what the temp folder really does (a file made and looked up under its flipped name), and writes nothing', () => {
  const dir = tempDir('fscase-real-');
  writeFileSync(join(dir, 'Probe.txt'), 'x');
  const before = readdirSync(dir).join('|');
  const folds = existsSync(join(dir, 'pROBE.TXT')); // the host's real answer, found without the code under test
  assert.equal(realProbe(dir), folds);
  const inst = createFsCase();
  assert.equal(inst.decide(join(dir, 'not', 'there', 'yet')), folds, 'the nearest existing folder decides');
  assert.equal(readdirSync(dir).join('|'), before, 'the probe created or removed nothing');
});

test('A278 real probe: an empty folder is asked through its own name in its parent', () => {
  const dir = tempDir('fscase-empty-');
  const sub = join(dir, 'Sub');
  mkdirSync(sub);
  const folds = existsSync(join(dir, 'sUB'));
  assert.equal(realProbe(sub), folds, 'the empty folder is judged through its name in the parent');
});

test('A278 fold: NFC and NFD spellings are one name, and the Kelvin sign is the letter k (a protected name cannot be written around a normalization form)', () => {
  assert.equal(fold('Café'), fold('Café'));
  assert.equal(fold('.agents/hooKs'), '.agents/hooks', 'KELVIN SIGN normalizes to K, and the volume folds case');
  assert.equal(fold('.agents/hooKs', false), '.agents/hooKs', 'where case is kept apart the exotic spelling is still not the protected name');
  assert.ok(same('.AGENTS/Local', '.agents/local', true));
  assert.ok(!same('.AGENTS/Local', '.agents/local', false));
  assert.ok(same('déjà', 'déjà', false), 'the normalization form never matters');
});

test('A278 under: root itself and below it, never a sibling that shares the prefix', () => {
  assert.ok(under('/p/Proj', '/p/proj', true) && under('/p/Proj', '/p/proj/src/a', true));
  assert.ok(!under('/p/Proj', '/p/proj', false));
  assert.ok(!under('/p/proj', '/p/project/a', true), 'a path that merely shares a prefix is outside');
  assert.ok(under('/', '/anything', true));
});

test('A278 injected probes: a folding volume and a case-keeping volume give opposite answers for the same path text', () => {
  const dir = tempDir('fscase-inj-');
  withVolume(createFsCase({ probe: () => true }), () => { assert.equal(insensitiveAt(join(dir, 'a')), true); assert.equal(provenInsensitiveAt(join(dir, 'a')), true); });
  withVolume(createFsCase({ probe: () => false }), () => { assert.equal(insensitiveAt(join(dir, 'a')), false); assert.equal(provenInsensitiveAt(join(dir, 'a')), false); });
});

test('A278 mixed volume: the cache key is the folder identity (st_dev:st_ino), so a case-keeping folder inside a folding tree is probed on its own and each answer is kept', () => {
  const root = tempDir('fscase-mixed-');
  const mount = join(root, 'mount'); const other = join(root, 'other');
  mkdirSync(mount); mkdirSync(other);
  /** @type {string[]} */ const asked = [];
  const inst = createFsCase({ probe: (d) => { asked.push(d); return d !== mount; } }); // `mount` stands for a case-sensitive volume (or a per-folder flag) inside a folding tree
  assert.equal(inst.decide(join(root, 'x', 'y')), true, 'the project side folds case');
  assert.equal(inst.decide(join(mount, 'deep', 'er')), false, 'the nearest existing folder is the mount: it keeps case');
  assert.equal(inst.decide(join(other, 'z')), true, 'a sibling folder of the same volume is a folder of its own and is probed again');
  assert.deepEqual(asked, [root, mount, other], 'three folders, three probes');
  assert.equal(inst.decide(join(root, 'q')), true);
  assert.equal(inst.decide(join(mount, 'q')), false);
  assert.equal(inst.decide(join(other, 'q')), true);
  assert.equal(inst.probes, 3, 'a second question about a known folder reuses the answer');
});

test('A278 fail closed: a probe that throws or cannot decide counts as case-insensitive for a protected name and never as proof for an allow rule; an undecided answer is not cached', () => {
  const dir = tempDir('fscase-closed-');
  const thrower = createFsCase({ probe: () => { throw new Error('unreadable volume'); } });
  assert.equal(thrower.decide(dir), undefined);
  const unknown = createFsCase({ probe: () => undefined });
  withVolume(thrower, () => { assert.equal(insensitiveAt(dir), true); assert.equal(provenInsensitiveAt(dir), false); });
  withVolume(unknown, () => { assert.equal(insensitiveAt(join(dir, 'n')), true); assert.equal(provenInsensitiveAt(join(dir, 'n')), false); });
  assert.equal(unknown.probes, 2, 'asked again each time: nothing undecided is kept');
});
