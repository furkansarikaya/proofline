// @ts-check
// core/pathin.mjs (A260, Windows port W1): real paths in the stored POSIX form and the strict "inside this folder" test behind the ARTIFACT / cited-evidence / UNSUPPORTED_EVIDENCE checks.
// The Windows rules run on any host through the platform and realpath parameters; the POSIX rules are compared with the expression the code used before (`real.startsWith(`${base}/`)`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inside, isAbsoluteInput, realpathPosix } from '../../control-plane/agents/scripts/core/pathin.mjs';
import { tempDir } from '../lib/tempdir.mjs';

/** The expression every call site had before A260. @param {string} base @param {string} child */
const before = (base, child) => (child.startsWith(`${base}/`) ? child.slice(base.length + 1) : null);

test('POSIX: inside gives what startsWith(base + "/") gave, case-sensitive, for every spelling in the table', () => {
  const bases = ['/r/run', '/r/run/', '/', '/r/Run', '/a b/run'];
  const children = ['/r/run/x', '/r/run/x/y.md', '/r/run', '/r/run/', '/r/run2/x', '/r/RUN/x', '/r/ru', '/r', '/', '/x/run/x', '/r/run/../x', '/r/run//x', '', 'r/run/x', 'C:\\r\\run\\x', '/r/Run/x', '/a b/run/z'];
  for (const b of bases) for (const c of children) {
    const old = before(b, c);
    const now = inside(b, c, 'linux');
    // the one difference: an empty remainder (`<base>/` itself) was "inside" before and is not now; a real path never ends in a slash
    if (old === '') assert.equal(now, null, `${b} ${c}`); else assert.equal(now, old, `${b} ${c}`);
    assert.equal(inside(b, c, 'darwin'), now);
  }
});

test('every previously refused path is still refused on POSIX and on Windows: sibling prefix, the base itself, another case, a parent, a different drive, a UNC share', () => {
  for (const platform of ['linux', 'win32']) {
    assert.equal(inside('/r/run', '/r/run2/x', platform), null);
    assert.equal(inside('/r/run', '/r/run', platform), null);
    assert.equal(inside('/r/run', '/r', platform), null);
    assert.equal(inside('/r/run', '/', platform), null);
    assert.equal(inside('/r/run', '', platform), null);
    assert.equal(inside('C:/r/run', 'D:/r/run/x', platform), null);
    assert.equal(inside('C:/r/run', 'C:/r/runner/x', platform), null);
    assert.equal(inside('C:/r/run', 'C:/r/ru/n/x', platform), null);
    assert.equal(inside('//srv/share/run', '//srv/share2/run/x', platform), null);
    assert.equal(inside('C:/r/run', 'C:/r/run.evil/x', platform), null);
  }
  assert.equal(inside('/r/run', '/r/RUN/x', 'linux'), null, 'case matters off Windows');
  assert.equal(inside('C:/r/run', 'c:/r/run/x', 'linux'), null);
});

test('win32: case is ignored (drive and names), the remainder keeps the child spelling, containment stays a whole component', () => {
  assert.equal(inside('C:/Users/runneradmin/run', 'c:/users/RunnerAdmin/run/reports/a.md', 'win32'), 'reports/a.md');
  assert.equal(inside('C:/Users/x/run', 'C:/Users/x/run/VERIFY.md', 'win32'), 'VERIFY.md');
  assert.equal(inside('C:/Users/x/run', 'C:/Users/x/RUN2/VERIFY.md', 'win32'), null);
  assert.equal(inside('C:/', 'C:/x', 'win32'), 'x');
});

test('win32: realpathPosix turns the real path into forward slashes with an upper-case drive, and the long name comes from the native realpath', () => {
  /** @param {string} out */
  const fake = (out) => (/** @type {string} */ _p) => out;
  assert.equal(realpathPosix('x', { platform: 'win32', real: fake('c:\\Users\\runneradmin\\AppData\\Local\\Temp\\run') }), 'C:/Users/runneradmin/AppData/Local/Temp/run');
  assert.equal(realpathPosix('x', { platform: 'win32', real: fake('\\\\?\\D:\\a\\proofline') }), 'D:/a/proofline');
  assert.equal(realpathPosix('x', { platform: 'win32', real: fake('\\\\srv\\share\\x') }), '//srv/share/x');
  // the run folder and the cited file both come through it, so an 8.3 spelling and the long spelling of one folder agree
  const run = realpathPosix('a', { platform: 'win32', real: fake('C:\\Users\\runneradmin\\t\\run') });
  const file = realpathPosix('b', { platform: 'win32', real: fake('C:\\Users\\runneradmin\\t\\run\\reports\\r.md') });
  assert.equal(inside(run, file, 'win32'), 'reports/r.md');
  // a file that resolves outside the run (a link to another folder) is still refused
  const out = realpathPosix('c', { platform: 'win32', real: fake('C:\\Users\\runneradmin\\t\\other\\r.md') });
  assert.equal(inside(run, out, 'win32'), null);
  assert.throws(() => realpathPosix('x', { platform: 'win32', real: () => { throw new Error('ENOENT'); } }), /ENOENT/);
});

test('POSIX: realpathPosix is realpathSync, byte for byte, through a symbolic link; a link out of the run is refused by inside', () => {
  const t = tempDir('pathin');
  const run = path.join(t, 'run'); const other = path.join(t, 'other');
  mkdirSync(path.join(run, 'reports'), { recursive: true }); mkdirSync(other);
  writeFileSync(path.join(run, 'reports', 'a.md'), 'x'); writeFileSync(path.join(other, 'b.md'), 'y');
  symlinkSync(other, path.join(run, 'reports', 'link'));
  symlinkSync(path.join(run, 'reports'), path.join(t, 'alias'));
  for (const p of [run, path.join(run, 'reports', 'a.md'), path.join(t, 'alias', 'a.md'), path.join(run, 'reports', 'link', 'b.md')]) assert.equal(realpathPosix(p), realpathSync(p));
  const runReal = realpathPosix(run);
  assert.equal(inside(runReal, realpathPosix(path.join(t, 'alias', 'a.md'))), 'reports/a.md');
  assert.equal(inside(runReal, realpathPosix(path.join(run, 'reports', 'link', 'b.md'))), null);
  assert.throws(() => realpathPosix(path.join(run, 'nope')), /ENOENT/);
});

test('isAbsoluteInput: a leading slash everywhere; drive and UNC forms only on win32 (off Windows they stay relative text, as before)', () => {
  for (const p of ['/etc/hosts', '/']) for (const pl of ['linux', 'win32']) assert.equal(isAbsoluteInput(p, pl), true);
  for (const p of ['C:\\x\\y', 'c:/x', '\\\\srv\\share\\x']) { assert.equal(isAbsoluteInput(p, 'win32'), true, p); assert.equal(isAbsoluteInput(p, 'linux'), false, p); }
  for (const p of ['', 'reports/a.md', 'C:x', 'x/C:/y', '.agents/runs/r/x', '..\\x']) for (const pl of ['linux', 'win32']) assert.equal(isAbsoluteInput(p, pl), false, p);
});

test('win32: only ASCII letters fold; Kelvin sign, dotless i and long s never match k, i, s (NTFS folds with its own table)', () => {
  assert.equal(inside('C:/r/k', 'C:/r/\u212A/x', 'win32'), null);
  assert.equal(inside('C:/r/i', 'C:/r/\u0131/x', 'win32'), null);
  assert.equal(inside('C:/r/s', 'C:/r/\u017F/x', 'win32'), null);
  assert.equal(inside('C:/r/\u212A', 'C:/r/k/x', 'win32'), null);
  assert.equal(inside('C:/r/K', 'C:/r/k/x', 'win32'), 'x', 'ASCII case still folds');
  assert.equal(inside('C:/r/\u212A', 'C:/r/\u212A/x', 'win32'), 'x', 'the same spelling matches');
  assert.equal(inside('C:/r/\u00C9', 'C:/r/\u00E9/x', 'win32'), null, 'no non-ASCII folding at all');
});
