// @ts-check
// core/pathin.mjs (A260, Windows port W1): real paths in the stored POSIX form and the strict "inside this folder" test behind the ARTIFACT / cited-evidence / UNSUPPORTED_EVIDENCE checks.
// The Windows rules run on any host through the platform and realpath parameters; the POSIX rules are compared with the expression the code used before (`real.startsWith(`${base}/`)`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inside, isAbsoluteInput, localRemote, posixForm, realpathPosix, samePath, scratchRoot } from '../../control-plane/agents/scripts/core/pathin.mjs';
import { tempDir } from '../lib/tempdir.mjs';
import { posix } from '../lib/winpath.mjs';

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
  for (const p of [run, path.join(run, 'reports', 'a.md'), path.join(t, 'alias', 'a.md'), path.join(run, 'reports', 'link', 'b.md')]) assert.equal(realpathPosix(p), process.platform === 'win32' ? posix(realpathSync.native(p)) : realpathSync(p));   // off Windows: realpathSync itself
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

test('posixForm and samePath (A261): off Windows they are the identity and ===, a backslash stays a file name character; on win32 the drive, the slashes, the trailing slash and ASCII case are normalised', () => {
  for (const p of ['/a/b', 'a\\b', 'C:\\x', '/a/b/', '', 'c:/x']) assert.equal(posixForm(p, 'linux'), p, p);
  for (const [a, b] of [['/a/b', '/a/b'], ['/a/b', '/a/b/'], ['/a/B', '/a/b'], ['a\\b', 'a/b'], ['C:/x', 'c:/x']]) assert.equal(samePath(a, b, 'linux'), a === b, `${a} ${b}`);
  assert.equal(posixForm('c:\\Users\\x\\y', 'win32'), 'C:/Users/x/y');
  assert.equal(posixForm('\\\\?\\c:\\x', 'win32'), 'C:/x');
  assert.equal(samePath('C:\\Users\\X\\githooks\\', 'c:/users/x/githooks', 'win32'), true);
  assert.equal(samePath('C:/a/b', 'C:/a/bc', 'win32'), false);
  assert.equal(samePath('C:/a/b', 'D:/a/b', 'win32'), false);
  assert.equal(samePath('C:/a/\u212A', 'C:/a/k', 'win32'), false, 'the Kelvin sign is not a k');
});

test('POSIX: the absolute-path tests A261 swapped in (leadlog, toolstats, metricsStep, platform) answer exactly what the old expressions answered over a table', () => {
  const table = ['', '/', '/a', '/a/b.jsonl', 'a/b.jsonl', './a.jsonl', '../a', 'C:\\x\\a.jsonl', 'C:/x/a.jsonl', '\\\\srv\\share\\a.jsonl', '/a\r.jsonl', '/a\n.jsonl', '/a.jsonl\n', '/x.jsonl', 'file:///x', '-/a', ' /a', '~/a'];
  for (const p of table) {
    assert.equal(isAbsoluteInput(p, 'linux'), p.startsWith('/'), JSON.stringify(p));                                              // leadlog, toolstats: startsWith('/')
    assert.equal(isAbsoluteInput(p, 'linux') && /^.*\.jsonl$/.test(p), /^\/.*\.jsonl$/.test(p), JSON.stringify(p));              // metricsStep: /^\/.*\.jsonl$/
    assert.equal(/^(\/|\.\/|\.\.\/)/.test(p) || isAbsoluteInput(p, 'linux'), /^(\/|\.\/|\.\.\/)/.test(p), JSON.stringify(p));    // platform: the local-origin test
  }
});

test('localRemote (A261): the address itself off Windows and for anything but a drive path; on win32 the `..` is folded and the real path used when it exists', () => {
  for (const u of ['', '/a/b/../c.git', '../x.git', 'C:\\x\\..\\y', 'https://h/o/r', 'git@h:o/r']) assert.equal(localRemote(u, 'linux', () => { throw new Error('not called'); }), u, u);
  for (const u of ['', '/a/b', '../x.git', 'https://h/o/r', 'git@h:o/r', 'file:///C:/x']) assert.equal(localRemote(u, 'win32', () => { throw new Error('not called'); }), u, u);
  assert.equal(localRemote('C:\\p\\wt\\LC/../p-lo.git', 'win32', (a) => `real:${a}`), 'real:C:\\p\\wt\\p-lo.git');
  assert.equal(localRemote('c:/p/wt/LC/../p-lo.git', 'win32', () => { throw new Error('ENOENT'); }), 'C:/p/wt/LC/p-lo.git'.replace('wt/LC', 'wt'));
});

test('scratchRoot (A262): off Windows exactly the old `$TMPDIR || /tmp` over a table (unset, empty, set, trailing slash, symlinked macOS-style root); on win32 the host temporary folder, TMPDIR ignored', () => {
  const old = (/** @type {string | undefined} */ t) => t || '/tmp';
  const table = [undefined, '', '/tmp', '/tmp/', '/var/folders/zz/T', '/private/var/folders/zz/T/', 'relative/tmp', '/a b/c'];
  for (const t of table) for (const pl of ['linux', 'darwin', 'freebsd']) assert.equal(scratchRoot(t, pl, '/ignored'), old(t), `${pl} ${JSON.stringify(t)}`);
  for (const t of table) assert.equal(scratchRoot(t, 'win32', 'C:\\Users\\R\\AppData\\Local\\Temp'), 'C:\\Users\\R\\AppData\\Local\\Temp', `win32 ${JSON.stringify(t)}`);
});

test('scratchRoot: the win32 folder is os.tmpdir() and the folder it names exists here (a real directory for the scratch folder)', () => {
  assert.equal(scratchRoot(undefined, 'win32'), tmpdir());
  assert.ok(statSync(scratchRoot(process.env.TMPDIR)).isDirectory());
});
