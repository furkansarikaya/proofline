// @ts-check
// A261, security round 1: what Windows may search for a platform tool. TEMP/TMP folders and UNC paths are refused in `proofline merge` (resolver and PATH check), in the folders a model can
// write (refusedDirs, refusedLocation) and in the PATH handed to gh/git/glab/az; the Windows rules run here with the platform and the resolver passed in; off Windows each helper answers
// exactly what the code it replaced answered (old-versus-new tables).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isLocalAbsolute } from '../../control-plane/agents/scripts/core/pathin.mjs';
import { caFileProblem, cleanToolEnv, pathOf, refusedDirs, refusedLocation, resolveMergeTool, resolveToolIn, shadowingEntry, toolPath, winEntryRefused } from '../../control-plane/agents/scripts/core/platform.mjs';

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

test('shadowingEntry on win32: UNC, relative and rooted entries are refused; drive entries (also quoted) pass', () => {
  assert.equal(shadowingEntry('C:\\Windows;"C:\\Program Files\\GitHub CLI"', 'win32'), null);
  for (const bad of ['\\\\srv\\share', '//srv/share', 'bin', '.', '/c/tools']) assert.equal(shadowingEntry(`C:\\Windows;${bad}`, 'win32'), bad, JSON.stringify(bad));
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

// ---- security round 2: the PATH ENTRY is made canonical before it is compared (a fake file system stands in for the Windows one) -------------------------------------------------
const LONG = 'C:\\Users\\furkansarikaya\\AppData\\Local\\Temp';
const DIRS = ['C:\\Users', 'C:\\Users\\furkansarikaya', 'C:\\Users\\furkansarikaya\\AppData', 'C:\\Users\\furkansarikaya\\AppData\\Local', LONG, `${LONG}\\f`, `${LONG}\\Temp2`, 'C:\\Users\\furkansarikaya\\AppData\\Local\\Temp2',
  'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\Program Files\\GitHub CLI', 'C:\\proj', 'C:\\proj\\bin', 'C:\\Tools'];
/** The native real path: 8.3 name expanded, `.`/`..`/doubled separators folded, trailing dots of a component dropped, case repaired; throws when the folder does not exist. @param {string} p */
function fakeReal(p) {
  const comps = path.win32.normalize(p).split('\\').map((c) => (/^\.+$/.test(c) ? c : c.replace(/\.+$/, ''))).map((c) => (/^furkan~1$/i.test(c) ? 'furkansarikaya' : c));
  const hit = DIRS.find((d) => d.toLowerCase() === comps.join('\\').toLowerCase().replace(/\\$/, ''));
  if (hit === undefined) throw new Error(`ENOENT ${p}`);
  return hit;
}
const isDirFake = (/** @type {string} */ p) => DIRS.some((d) => d.toLowerCase() === p.replace(/\//g, '\\').toLowerCase());
const SHORT_TEMP = 'C:\\Users\\FURKAN~1\\AppData\\Local\\Temp';
const winCtx = (/** @type {Record<string, string>} */ extra = {}) => /** @type {any} */ ({ root: 'C:\\proj', cwd: 'C:\\proj', env: { TEMP: SHORT_TEMP, TMP: SHORT_TEMP, ...extra } });

test('winEntryRefused: every spelling of a temp or project folder is refused once the ENTRY is canonical (short, long, other case, `..`, trailing dot, doubled separator, slashes); a missing folder is refused; system folders pass', () => {
  const refused = winEntryRefused(winCtx(), fakeReal, isDirFake);
  for (const e of [`${SHORT_TEMP}\\f`, `${LONG}\\f`, 'c:/users/furkansarikaya/appdata/local/temp/f', `C:\\Users\\furkansarikaya\\AppData\\Local\\Temp2\\..\\Temp\\f`,
    `${LONG}.\\f`, 'C:\\Users\\\\furkansarikaya\\AppData\\Local\\Temp\\f', SHORT_TEMP, 'C:\\proj\\bin', 'C:\\Nope', 'C:\\Windows\\System32\\missing']) assert.equal(refused(e), true, e);
  for (const e of ['C:\\Windows\\System32', 'C:\\Program Files\\GitHub CLI', 'C:\\Tools', 'c:/windows/system32']) assert.equal(refused(e), false, e);
  // a sibling that only shares the prefix is not inside TEMP
  assert.equal(refused('C:\\Users\\furkansarikaya\\AppData\\Local\\Temp2'), false);
});

test('cleanToolEnv on win32 (the Windows PATH rules are wired): the PATH given to gh/git keeps only canonical, existing, drive folders outside the project and the temp folders; `Path` is read too', () => {
  const entries = [`${SHORT_TEMP}\\f`, 'C:\\Windows\\System32', `${LONG}\\f`, '\\\\evil\\share', 'bin', '', 'C:\\Nope', 'C:\\proj\\bin', 'C:\\Program Files\\GitHub CLI', `C:\\Users\\furkansarikaya\\AppData\\Local\\Temp2\\..\\Temp\\f`];
  for (const key of ['PATH', 'Path']) {
    const ctx = winCtx({ [key]: entries.join(';') });
    const out = cleanToolEnv(ctx, { platform: 'win32', real: fakeReal, isDir: isDirFake });
    assert.equal(out['PATH'], 'C:\\Windows\\System32;C:\\Program Files\\GitHub CLI', key);
    assert.equal(out['Path'], undefined);
  }
  assert.equal(cleanToolEnv(winCtx({}), { platform: 'win32', real: fakeReal, isDir: isDirFake })['PATH'], undefined);
});

test('POSIX: cleanToolEnv keeps the former PATH rule (":" separator, absolute entries outside the refused folders)', () => {
  const here = process.cwd();   // an existing folder: the project
  const ctx = /** @type {any} */ ({ root: here, cwd: here, env: { PATH: `/usr/bin:${here}/bin:bin::/bin`, TMPDIR: '/nonexistent-x' } });
  assert.equal(cleanToolEnv(ctx)['PATH'], '/usr/bin:/bin');
  assert.equal(pathOf({ PATH: 'a', Path: 'b' }, 'win32'), 'a');
  assert.equal(pathOf({ Path: 'b' }, 'win32'), 'b');
  assert.equal(pathOf({ Path: 'b' }, 'linux'), undefined);
});

test('shadowingEntry on win32 skips an empty entry (a trailing ";"), as the resolver does; POSIX still refuses it', () => {
  assert.equal(shadowingEntry('C:\\Windows;', 'win32'), null);
  assert.equal(shadowingEntry('/usr/bin:', 'linux', () => false), '');
});

test('the platform argument decides what is absolute where a file is read: resolveToolIn, caFileProblem and (in toolstats.test.mjs) metricsStep', () => {
  assert.deepEqual(resolveToolIn({ PATH: '/usr/bin:/bin' }, 'sh', [], 'win32'), { unreadable: 'unreadable' });
  assert.ok('path' in resolveToolIn({ PATH: '/usr/bin:/bin' }, 'sh', [], 'linux'));
  const ctx = /** @type {any} */ ({ root: '/p', cwd: '/p', env: {} });
  for (const v of ['/etc/hosts', '\\\\srv\\share\\ca.pem', '//srv/share/ca.pem', 'ca.pem']) assert.equal(caFileProblem(ctx, v, 'win32'), 'not an absolute path', v);
  assert.equal(caFileProblem(ctx, 'ca.pem', 'linux'), 'not an absolute path');
  assert.notEqual(caFileProblem(ctx, '/etc/hosts', 'linux'), 'not an absolute path');
});

test('merge.mjs is wired to the Windows rules: it asks resolveMergeTool and shadowingEntry (with pathOf) and never calls resolveToolIn or splits PATH itself', () => {
  const src = readFileSync(new URL('../../control-plane/agents/scripts/core/merge.mjs', import.meta.url), 'utf8');
  assert.match(src, /resolveMergeTool\(ctx, cli, top\)/);
  assert.match(src, /shadowingEntry\(pathOf\(ctx\.env\) \?\? ''\)/);
  assert.doesNotMatch(src, /resolveToolIn\(|split\(':'\)/);
});
