// @ts-check
// A278 (issue #264, AC-5 and AC-6): the file-system case probe of adapters/claude/hooks/lib/fscase.mjs. One real-file-system test (the probe on a temp folder agrees with what the
// folder really does, whatever host this runs on) and tests on injected probes (a fake volume that folds case, one that does not, a mixed tree, a probe that throws).
// No test depends on the host being macOS or Linux; nothing waits; every folder is made by tempDir.
import { tempDir } from '../lib/tempdir.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

// ---- A278 round 1: full case folding against the real file system, and a probe that an agent-chosen file name cannot steer ----

test('A278 fold: the sharp s, the long s, the Kelvin sign and the ligatures fold to the ASCII letters APFS gives them', () => {
  const pairs = /** @type {Array<[string, string]>} */ ([['ſ', 's'], ['K', 'k'], ['ß', 'ss'], ['ẞ', 'ss'], ['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'], ['ﬆ', 'st']]);
  for (const [c, ascii] of pairs) assert.equal(fold(c), ascii, `U+${c.codePointAt(0)?.toString(16)}`);
  assert.equal(fold('.agents/ſcripts/agent.ſh'), '.agents/scripts/agent.sh');
  assert.equal(fold('ſ', false), 'ſ', 'a volume that keeps case apart leaves the letter alone');
});

test('A278 ground truth: every code point the real file system resolves to one of the ASCII names has an ASCII fold (the fold covers what the volume folds; on a case-keeping host nothing resolves)', () => {
  const dir = tempDir('fscase-truth-');
  const names = ['s', 'k', 'i', 'f', 'l', 't', 'ss', 'fi', 'fl', 'ff', 'ffi', 'ffl', 'st'];
  /** @type {Map<string, string>} */ const byIno = new Map();
  for (const n of names) { writeFileSync(join(dir, n), ''); byIno.set(String(lstatSync(join(dir, n)).ino), n); }
  let resolved = 0; let covered = 0;
  /** @type {string[]} */ const missed = [];
  for (let cp = 0x80; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    let ino;
    try { ino = String(lstatSync(join(dir, c)).ino); } catch { continue; }
    const hit = byIno.get(ino);
    if (hit === undefined) continue;
    resolved++;
    if (fold(c) === hit) covered++; else missed.push(`U+${cp.toString(16)}->${hit} (fold gives ${fold(c)})`);
  }
  assert.deepEqual(missed, [], 'a name the volume resolves to an ASCII name that the fold does not');
  assert.equal(covered, resolved);
});

/** A fake volume for the probe: entries by full path, a folding or case-keeping name lookup, hard-link counts. @param {boolean} folds @param {Record<string, number>} files full path -> link count */
function fakeVolume(folds, files) {
  /** @type {Map<string, { ino: number, nlink: number }>} */ const m = new Map();
  let ino = 100;
  for (const [p, nlink] of Object.entries(files)) m.set(folds ? p.normalize('NFC').toUpperCase().toLowerCase() : p, { ino: ino++, nlink });
  const key = (/** @type {string} */ p) => (folds ? p.normalize('NFC').toUpperCase().toLowerCase() : p);
  return {
    io: {
      names: (/** @type {string} */ d) => Object.keys(files).filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/')).map((p) => p.slice(d.length + 1)),
      lstat: (/** @type {string} */ p) => { const e = m.get(key(p)); if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { dev: 1, ino: e.ino, nlink: e.nlink }; },
    },
  };
}
const POISON = ['ıa0', '!ß', 'ſ', 'K', 'İ', '😀', 'ıa1', '!xß'];

test('A278 probe: names an agent can choose never steer the answer toward case-keeping (the dotless i, the sharp s, the long s, Kelvin, a capital dotted I, an emoji, listed first)', () => {
  const dir = '/v/run';
  const poison = Object.fromEntries(POISON.map((n) => [`${dir}/${n}`, 1]));
  const folding = fakeVolume(true, { ...poison, [`${dir}/RUN.yaml`]: 1 });
  assert.equal(realProbe(dir, folding.io), true, 'a folding volume with poison first');
  const keeping = fakeVolume(false, { ...poison, [`${dir}/RUN.yaml`]: 1 });
  assert.equal(realProbe(dir, keeping.io), false, 'a case-keeping volume with poison first');
  const onlyPoison = fakeVolume(true, poison);
  assert.equal(realProbe(dir, onlyPoison.io), undefined, 'only poison: no evidence either way (undecided fails closed, it is never case-keeping)');
});

test('A278 probe: a hard-link pair a/A on a case-keeping volume is not a folding volume; a single linked file is ignored, two different files a and A prove case-keeping', () => {
  const dir = '/v/d';
  const keepingPair = fakeVolume(false, { [`${dir}/a`]: 1, [`${dir}/A`]: 1 });
  assert.equal(realProbe(dir, keepingPair.io), false);
  const hard = { names: () => ['a', 'A'], lstat: (/** @type {string} */ p) => { if (p.endsWith('/D')) throw Object.assign(new Error('x'), { code: 'ENOENT' }); return { dev: 1, ino: 7, nlink: 2 }; } };
  assert.equal(realProbe(dir, hard), false, 'the hard-linked pair is ignored; the parent says case-keeping');
});

test('A278 probe: files with hostile names made in a real folder do not change what the probe says about it', () => {
  const dir = tempDir('fscase-poison-');
  writeFileSync(join(dir, 'Real.txt'), 'x');
  const folds = existsSync(join(dir, 'rEAL.TXT'));
  for (const n of POISON) { try { writeFileSync(join(dir, n), ''); } catch { /* a name this host refuses */ } }
  assert.equal(realProbe(dir), folds);
});
