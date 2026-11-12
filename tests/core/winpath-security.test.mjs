// @ts-check
// A261, security round 1: what Windows may search for a platform tool. TEMP/TMP folders and UNC paths are refused in `proofline merge` (resolver and PATH check), in the folders a model can
// write (refusedDirs, refusedLocation) and in the PATH handed to gh/git/glab/az; the Windows rules run here with the platform and the resolver passed in; off Windows each helper answers
// exactly what the code it replaced answered (old-versus-new tables).
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { isLocalAbsolute } from '../../control-plane/agents/scripts/core/pathin.mjs';
import { refusedDirs, refusedLocation, resolveMergeTool, resolveToolIn, shadowingEntry, toolPath } from '../../control-plane/agents/scripts/core/platform.mjs';

/** @param {Record<string, string>} env @returns {import('../../control-plane/agents/scripts/core/context.mjs').Context} */
const ctxOf = (env) => /** @type {any} */ ({ root: 'C:\\proj', cwd: 'C:\\proj\\sub', env });
const WIN = { TEMP: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp', TMP: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp' };

test('isLocalAbsolute: off Windows exactly startsWith("/"); on win32 only a drive path (a UNC path, a rooted path and a relative path are refused)', () => {
  for (const p of ['', '/', '/a', 'a', './a', 'C:\\x', 'C:/x', '\\\\srv\\share\\x', '//srv/share/x']) assert.equal(isLocalAbsolute(p, 'linux'), p.startsWith('/'), p);
  for (const p of ['C:\\x', 'c:/x', 'D:\\a\\b']) assert.equal(isLocalAbsolute(p, 'win32'), true, p);
  for (const p of ['', '\\\\srv\\share\\x', '//srv/share/x', '\\\\?\\C:\\x', '/c/Users', '/x', 'C:x', 'x\\y', '..\\x']) assert.equal(isLocalAbsolute(p, 'win32'), false, p);
});

test('refusedDirs: the POSIX list is unchanged; win32 names the project, the working folder and TEMP, TMP, TMPDIR', () => {
  const posixCtx = /** @type {any} */ ({ root: '/p', cwd: '/p/s', env: { TMPDIR: '/t' } });
  assert.deepEqual(refusedDirs(posixCtx, 'linux'), ['/p', '/p/s', '/t', '/tmp', '/private/tmp', '/var/folders', '/dev/shm']);
  assert.deepEqual(refusedDirs(/** @type {any} */ ({ root: '/p', cwd: '/p', env: {} }), 'darwin'), ['/p', '/p', '/nonexistent', '/tmp', '/private/tmp', '/var/folders', '/dev/shm']);
  const w = refusedDirs(ctxOf(WIN), 'win32');
  for (const d of ['C:\\proj', 'C:\\proj\\sub', WIN.TEMP]) assert.ok(w.includes(d), d);
  assert.ok(w.includes(tmpdir()), "the account's temporary folder");   // whatever this host calls it
  assert.ok(!w.includes('/dev/shm') && !w.includes('/private/tmp'));
});

test('refusedLocation on win32: a file under TEMP/TMP (any case, 8.3 or long, either slash) or the project is refused; Program Files and a UNC share are not under them', () => {
  const c = ctxOf(WIN);
  for (const f of ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\f\\git.exe', 'c:/users/runner~1/appdata/local/temp/f/gh.exe', 'C:\\proj\\sub\\gh.exe', 'C:\\proj\\x']) assert.equal(refusedLocation(c, f, 'win32'), true, f);
  for (const f of ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Users\\RUNNER~1\\AppData\\Local\\TempX\\git.exe']) assert.equal(refusedLocation(c, f, 'win32'), false, f);
});

test('toolPath on win32: TEMP/TMP, UNC, rooted, relative and empty entries are dropped, drive entries kept, ";" is the separator', () => {
  const refused = (/** @type {string} */ d) => refusedLocation(ctxOf(WIN), `${d}/x`, 'win32');
  const p = ['C:\\Windows\\System32', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\f', '\\\\evil\\share', '//evil/share', '/c/tools', 'bin', '', '"C:\\Program Files\\GitHub CLI"', 'C:\\proj\\sub\\bin'].join(';');
  assert.equal(toolPath(p, refused, 'win32'), 'C:\\Windows\\System32;C:\\Program Files\\GitHub CLI');
});

test('POSIX: toolPath and shadowingEntry answer what the expressions they replaced answered, over a table', () => {
  const refusedOld = (/** @type {string} */ d) => d.startsWith('/tmp') || d.startsWith('/proj');
  const isDir = (/** @type {string} */ d) => d === 'bin' || d === 'sub';
  for (const p of ['', '/usr/bin:/bin', '/usr/bin::/bin', '/tmp/f:/usr/bin', 'bin:/usr/bin', '.:/usr/bin', '..', 'C:\\x:/usr/bin', '/proj/b:/opt/x', 'nodir:/usr/bin', 'sub', '/a b:/c']) {
    assert.equal(toolPath(p, refusedOld, 'linux'), p.split(':').filter((e) => e.startsWith('/') && !refusedOld(e)).join(':'), p);
    /** @type {string | null} */ let old = null;
    for (const d of p.split(':')) { if (d.startsWith('/')) continue; if (d === '' || d === '.' || d === '..' || isDir(d)) { old = d; break; } }
    assert.equal(shadowingEntry(p, 'linux', isDir), old, p);
  }
});

test('shadowingEntry on win32: UNC, relative, rooted and empty entries are refused; drive entries (also quoted) pass', () => {
  assert.equal(shadowingEntry('C:\\Windows;"C:\\Program Files\\GitHub CLI"', 'win32'), null);
  for (const bad of ['\\\\srv\\share', '//srv/share', 'bin', '.', '', '/c/tools']) assert.equal(shadowingEntry(`C:\\Windows;${bad}`, 'win32'), bad, JSON.stringify(bad));
});

test('resolveMergeTool: on win32 merge goes through the Windows resolver (never resolveToolIn); elsewhere through resolveToolIn with the same answer', () => {
  /** @type {string[]} */ const calls = [];
  const win = (/** @type {any} */ _c, /** @type {string} */ n) => { calls.push(n); return { unreadable: 'unreadable (gh is only a .cmd/.bat shim)' }; };
  const c = ctxOf({ ...WIN, PATH: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\f;C:\\Windows' });
  assert.deepEqual(resolveMergeTool(c, 'gh', 'C:\\proj', 'win32', win), { unreadable: 'unreadable (gh is only a .cmd/.bat shim)' });
  assert.deepEqual(calls, ['gh']);
  const env = { PATH: '/usr/bin:/bin' };
  const pc = /** @type {any} */ ({ root: '/p', cwd: '/p', env });
  const never = () => { throw new Error('the Windows resolver must not run off Windows'); };
  assert.deepEqual(resolveMergeTool(pc, 'sh', '/p', 'linux', never), resolveToolIn(env, 'sh', ['/p', '/p', '/nonexistent', '/tmp', '/private/tmp', '/var/folders', '/dev/shm']));
});
