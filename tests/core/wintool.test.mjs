// A252: Windows tool resolution (a .cmd/.bat shim is refused, only an .exe/.com in a safe folder runs) and the taskkill command of the process-tree kill (A226).
// Both run on any host with a fake file system and an injected spawn: no Windows machine, no waits, no clock. On Windows itself: not tried (denenmedi).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWindowsTool, candidates, plainToolName, isDriveAbsolute, shimMessage, makeRefusedDir } from '../../control-plane/agents/scripts/core/wintool.mjs';
import { resolveToolWindows } from '../../control-plane/agents/scripts/core/platform.mjs';
import { refusedLeader, startLeader, taskkillArgs, killWindowsTree, systemTaskkill, resolveProgram } from '../../control-plane/agents/scripts/core/proc.mjs';

/** A fake Windows file system: FILES is the set of existing files (lower-case, backslashes); REFUSED the writable folders. */
function fake(files, refused = [], links = {}) {
  const key = (/** @type {string} */ p) => p.replace(/\//g, '\\').toLowerCase();
  const set = new Set(files.map(key));
  return {
    isFile: (/** @type {string} */ p) => set.has(key(p)),
    real: (/** @type {string} */ p) => links[key(p)] ?? p,
    refusedDir: (/** @type {string} */ d) => refused.some((r) => key(d) === key(r) || key(d).startsWith(`${key(r)}\\`)),
  };
}
const ENV = (/** @type {string} */ p, /** @type {string | undefined} */ ext = '.COM;.EXE;.BAT;.CMD') => ({ PATH: p, PATHEXT: ext });

describe('A252 resolver', () => {
  test('a real gh.exe in a trusted folder runs, as an absolute path found through PATHEXT', () => {
    const r = resolveWindowsTool(ENV('C:\\Windows;C:\\Program Files\\GitHub CLI'), 'gh', fake(['C:\\Program Files\\GitHub CLI\\gh.exe']));
    assert.deepEqual(r, { path: 'C:\\Program Files\\GitHub CLI\\gh.exe' });
  });
  test('a .cmd or .bat shim is never returned as a path: it is reported as a shim (refused)', () => {
    for (const ext of ['cmd', 'bat']) {
      const r = resolveWindowsTool(ENV('C:\\az'), 'az', fake([`C:\\az\\AZ.${ext.toUpperCase()}`]));
      assert.deepEqual(r, { shim: `C:\\az\\az.${ext}` }, ext);
    }
    assert.deepEqual(resolveWindowsTool(ENV('C:\\az'), 'az.cmd', fake(['C:\\az\\az.cmd'])), { shim: 'C:\\az\\az.cmd' }, 'a name that already is a shim');
  });
  test('the first folder that holds the tool decides: a shim there hides an .exe further on (as Windows resolves it)', () => {
    const r = resolveWindowsTool(ENV('C:\\a;C:\\b'), 'gh', fake(['C:\\a\\gh.cmd', 'C:\\b\\gh.exe']));
    assert.ok('shim' in r);
  });
  test('.exe beats .cmd in the same folder; PATHEXT without .EXE finds nothing runnable', () => {
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a'), 'gh', fake(['C:\\a\\gh.cmd', 'C:\\a\\gh.exe'])), { path: 'C:\\a\\gh.exe' });
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a', '.CMD'), 'gh', fake(['C:\\a\\gh.exe'])), { unreadable: 'unreadable' });
    assert.deepEqual(candidates('gh', undefined).map((c) => c.file), ['gh.com', 'gh.exe', 'gh.bat', 'gh.cmd']);
    assert.deepEqual(candidates('gh', '.EXE;.COM;.CMD;.BAT').map((c) => c.file), ['gh.exe', 'gh.com', 'gh.cmd', 'gh.bat'], 'PATHEXT order, shims last');
    assert.deepEqual(candidates('gh', '.CMD;.COM;.EXE').map((c) => c.file), ['gh.com', 'gh.exe', 'gh.cmd']);
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a', '.EXE;.COM'), 'gh', fake(['C:\\a\\gh.com', 'C:\\a\\gh.exe'])), { path: 'C:\\a\\gh.exe' }, 'the first of PATHEXT wins');
    assert.deepEqual(candidates('gh', '.EXE;.junk;;.PS1').map((c) => c.file), ['gh.exe']);
  });
  test('relative, empty, UNC and rooted PATH entries are never searched', () => {
    const files = ['gh.exe', '.\\gh.exe', 'bin\\gh.exe', '\\bin\\gh.exe', 'C:bin\\gh.exe', 'C:\\proj\\gh.exe', '\\\\srv\\share\\gh.exe', 'C:\\proj\\bin\\gh.exe'];
    for (const p of ['', '.', 'bin', '\\\\srv\\share', '\\bin', 'C:bin', ';;']) assert.deepEqual(resolveWindowsTool(ENV(p), 'gh', fake(files)), { unreadable: 'unreadable' }, p);
  });
  test('a tool in a folder a model can write (project, working directory, temporary folder) is shadowed, also through a link', () => {
    const fs = fake(['C:\\proj\\bin\\gh.exe', 'C:\\ok\\gh.exe'], ['C:\\proj', 'C:\\Users\\x\\AppData\\Local\\Temp'], { 'c:\\ok\\gh.exe': 'C:\\Users\\x\\AppData\\Local\\Temp\\evil\\gh.exe' });
    assert.deepEqual(resolveWindowsTool(ENV('C:\\proj\\bin'), 'gh', fs), { shadowed: 'C:\\proj\\bin\\gh.exe' });
    const linked = resolveWindowsTool(ENV('C:\\ok'), 'gh', fs);
    assert.deepEqual(linked, { shadowed: 'C:\\Users\\x\\AppData\\Local\\Temp\\evil\\gh.exe' });
  });
  test('unsure is refused: a real path that is not drive-absolute or not an .exe, a throwing file system', () => {
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a'), 'gh', { ...fake(['C:\\a\\gh.exe']), real: () => '\\\\srv\\x\\gh.exe' }), { unreadable: 'unreadable' });
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a'), 'gh', { ...fake(['C:\\a\\gh.exe']), real: () => 'C:\\a\\gh.cmd' }), { unreadable: 'unreadable' });
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a'), 'gh', { ...fake(['C:\\a\\gh.exe']), real: () => { throw new Error('x'); } }), { unreadable: 'unreadable' });
    assert.deepEqual(resolveWindowsTool(ENV('C:\\a'), 'gh', { ...fake([]), isFile: () => { throw new Error('x'); } }), { unreadable: 'unreadable' });
    assert.deepEqual(resolveWindowsTool({}, 'gh', fake([])), { unreadable: 'unreadable' });
  });
  test('hostile tool names (& | ^ % " < > space, separators, drive colon, dot dot) never reach the file system', () => {
    let touched = 0;
    const fs = { isFile: () => { touched++; return true; }, real: (/** @type {string} */ p) => p, refusedDir: () => false };
    for (const n of ['gh & calc', 'gh|x', 'gh^x', '%COMSPEC%', 'gh"', 'gh<x', 'gh>x', 'g h', '..\\gh', 'C:\\gh', 'a/b', 'gh\n', '', '.gh', 'gh..x', '-gh']) {
      assert.deepEqual(resolveWindowsTool(ENV('C:\\a'), n, fs), { unreadable: 'unreadable' }, JSON.stringify(n));
      assert.equal(plainToolName(n), false, JSON.stringify(n));
    }
    assert.equal(touched, 0);
    for (const n of ['gh', 'glab', 'az', 'git', 'gh.exe', 'my-tool_1.2']) assert.equal(plainToolName(n), true, n);
  });
  test('a quoted PATH entry is unquoted; a drive-less or non-string path is not absolute', () => {
    assert.deepEqual(resolveWindowsTool(ENV('"C:\\Program Files\\GitHub CLI"'), 'gh', fake(['C:\\Program Files\\GitHub CLI\\gh.exe'])), { path: 'C:\\Program Files\\GitHub CLI\\gh.exe' });
    assert.equal(isDriveAbsolute('C:\\x'), true);
    assert.equal(isDriveAbsolute('C:/x'), true);
    for (const p of ['C:x', '\\x', '\\\\s\\x', 'x\\y', '']) assert.equal(isDriveAbsolute(p), false, p);
  });
  test('the refusal text names the shim and says what to do (gh: install gh.exe; az: merge in Azure DevOps)', () => {
    assert.match(shimMessage('gh', 'C:\\n\\gh.cmd'), /gh is only a \.cmd\/\.bat shim at C:\\n\\gh\.cmd.*cmd\.exe.*gh\.exe.*PATH/);
    assert.match(shimMessage('az', 'C:\\n\\az.cmd'), /az\.cmd.*Azure DevOps.*manual/);
    assert.ok(shimMessage('gh', 'x').startsWith('unreadable ('), 'the callers print it where they print "unreadable"');
  });
});

describe('A252 taskkill (A226)', () => {
  test('the argument list ends the whole tree: /T, and /F only when forced; one array, no shell string', () => {
    assert.deepEqual(taskkillArgs(4242, false), ['/pid', '4242', '/T']);
    assert.deepEqual(taskkillArgs(4242, true), ['/pid', '4242', '/T', '/F']);
  });
  test('a pid that is not a positive safe integer is refused before anything starts (no `/pid 0`, no text)', () => {
    for (const p of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, /** @type {any} */ ('12 & calc')]) assert.throws(() => taskkillArgs(p, true), RangeError, String(p));
  });
  test('the kill runs taskkill through the injected spawn with windowsHide and no stdio, once per call', () => {
    /** @type {Array<[string, string[], object]>} */ const calls = [];
    const spawn = /** @type {any} */ ((/** @type {string} */ c, /** @type {string[]} */ a, /** @type {object} */ o) => { calls.push([c, a, o]); return { status: 0 }; });
    killWindowsTree(77, false, spawn, { SystemRoot: 'C:\\Windows' });
    killWindowsTree(77, true, spawn, {});
    assert.deepEqual(calls, [
      ['C:\\Windows\\System32\\taskkill.exe', ['/pid', '77', '/T'], { stdio: 'ignore', windowsHide: true }],
      ['C:\\Windows\\System32\\taskkill.exe', ['/pid', '77', '/T', '/F'], { stdio: 'ignore', windowsHide: true }],
    ]);
  });
});

describe('A252 security round 1', () => {
  test('SEC-1: taskkill is the system one by absolute path (SystemRoot, then windir, then C:\\Windows); odd values are skipped', () => {
    const dflt = 'C:\\Windows\\System32\\taskkill.exe';
    assert.equal(systemTaskkill({}), dflt);
    assert.equal(systemTaskkill({ SystemRoot: 'D:\\WINNT' }), 'D:\\WINNT\\System32\\taskkill.exe');
    assert.equal(systemTaskkill({ SystemRoot: 'D:\\WINNT\\' }), 'D:\\WINNT\\System32\\taskkill.exe');
    assert.equal(systemTaskkill({ SystemRoot: 'relative\\x', windir: 'E:\\Win' }), 'E:\\Win\\System32\\taskkill.exe');
    for (const bad of ['\\\\srv\\share', 'x', '.', 'C:', 'C:\\a\\..\\b', 'C:\\a&b', 'C:\\a"b', '%windir%', 'C:\\a\nb', '', 'C:/Windows']) assert.equal(systemTaskkill({ SystemRoot: bad, windir: bad }), dflt, JSON.stringify(bad));
    for (const p of [systemTaskkill({}), systemTaskkill({ SystemRoot: 'D:\\W' })]) assert.equal(isDriveAbsolute(p), true);
  });
  test('SEC-1: the kill never starts a bare name: the spawn gets the absolute taskkill.exe and the exact argv', () => {
    const seen = [];
    killWindowsTree(9, true, /** @type {any} */ ((c, a) => { seen.push([c, a]); return {}; }), { SystemRoot: '\\\\evil\\share' });
    assert.deepEqual(seen, [['C:\\Windows\\System32\\taskkill.exe', ['/pid', '9', '/T', '/F']]]);
  });
  test('SEC-1 class: on win32 a bare program name is resolved to an absolute path outside the working folder; POSIX and explicit paths are untouched', () => {
    const fs = (cwd) => ({ ...fake(['C:\\proj\\git.exe', 'C:\\Git\\cmd\\git.exe', 'C:\\Git\\cmd\\gh.cmd']), refusedDir: makeRefusedDir([cwd], (p) => p) });
    const env = { PATH: 'C:\\proj;C:\\Git\\cmd' };
    assert.deepEqual(resolveProgram('git', env, 'C:\\proj', 'win32', fs('C:\\proj')), { refused: 'proofline: git was not found on PATH outside the working folder; not started\n' }, 'the planted git.exe in the project is shadowed, and the PATH entry C:\\proj is refused (not skipped) as a whole');
    assert.deepEqual(resolveProgram('git', { PATH: 'C:\\Git\\cmd' }, 'C:\\proj', 'win32', fs('C:\\proj')), { program: 'C:\\Git\\cmd\\git.exe' });
    assert.ok('refused' in resolveProgram('gh', { PATH: 'C:\\Git\\cmd' }, 'C:\\proj', 'win32', fs('C:\\proj')), 'a shim is refused');
    assert.match(/** @type {any} */ (resolveProgram('gh', { PATH: 'C:\\Git\\cmd' }, 'C:\\proj', 'win32', fs('C:\\proj'))).refused, /\.cmd\/\.bat shim/);
    assert.ok('refused' in resolveProgram('nothing', { PATH: 'C:\\Git\\cmd' }, 'C:\\proj', 'win32', fs('C:\\proj')), 'not found is refused, not started by bare name');
    assert.ok('refused' in resolveProgram('git', {}, 'C:\\proj', 'win32', fs('C:\\proj')), 'no PATH');
    for (const explicit of ['C:\\x\\git.exe', 'sub/git', '.\\git.exe', 'a:b']) assert.deepEqual(resolveProgram(explicit, {}, 'C:\\proj', 'win32', fs('C:\\proj')), { program: explicit }, explicit);
    for (const plat of ['linux', 'darwin']) assert.deepEqual(resolveProgram('git', { PATH: '/usr/bin' }, '/proj', plat), { program: 'git' }, plat);
    assert.deepEqual(resolveProgram('git', undefined, undefined), { program: 'git' }, 'this host is POSIX in the test run, or resolves; never throws');
  });
  test('SEC-2: a refused folder given as an 8.3 short name still meets a long-form PATH entry; case and slash spelling do not matter', () => {
    const expand = (p) => p.replace(/RUNNER~1/i, 'runneradmin');
    const refused = makeRefusedDir(['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp', '', 'D:\\proj'], expand);
    assert.equal(refused('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bin'), true);
    assert.equal(refused('c:/users/runneradmin/appdata/local/temp'), true);
    assert.equal(refused('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x'), true);
    assert.equal(refused('d:\\PROJ\\bin\\'), true);
    assert.equal(refused('C:\\Users\\runneradmin\\AppData\\Local\\Temporary'), false, 'a sibling that shares a prefix is not inside');
    assert.equal(makeRefusedDir(['C:\\Users\\runneradmin\\Temp'], expand)('C:\\Users\\RUNNER~1\\Temp\\x'), true, 'the PATH entry short, the refused folder long');
    assert.equal(refused('C:\\Program Files\\GitHub CLI'), false);
    assert.equal(makeRefusedDir(['C:\\a'], () => { throw new Error('x'); })('C:\\a\\b'), true, 'a throwing expand falls back to the spelling given');
  });
});

describe('A252 review round 1', () => {
  const real = (m = {}) => (p) => m[p.toLowerCase()] ?? p;
  const ctxOf = (env) => /** @type {any} */ ({ root: 'C:\\proj', cwd: 'C:\\proj\\sub', env });
  const fsOf = (files, m) => ({ isFile: (p) => files.map((f) => f.toLowerCase()).includes(p.toLowerCase()), real: real(m) });
  test('I3: resolveToolWindows (the glue of platform.mjs): a good .exe, case-insensitive project refusal, short TEMP against a long PATH entry, the shim message', () => {
    const env = { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' };
    assert.deepEqual(resolveToolWindows(ctxOf(env), 'gh', fsOf(['C:\\Tools\\gh.exe'])), { path: 'C:\\Tools\\gh.exe' });
    const inProject = resolveToolWindows(ctxOf({ PATH: 'c:\\PROJ\\bin', PATHEXT: '.EXE' }), 'gh', fsOf(['c:\\PROJ\\bin\\gh.exe']));
    assert.match(/** @type {any} */ (inProject).unreadable, /^unreadable \(gh at .*may be shadowed\)$/);
    const longTemp = resolveToolWindows(ctxOf({ PATH: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\b', TEMP: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp', PATHEXT: '.EXE' }), 'gh',
      fsOf(['C:\\Users\\runneradmin\\AppData\\Local\\Temp\\b\\gh.exe'], { 'c:\\users\\runner~1\\appdata\\local\\temp': 'C:\\Users\\runneradmin\\AppData\\Local\\Temp' }));
    assert.ok('unreadable' in longTemp, 'a tool in TEMP given short is shadowed through the long PATH entry');
    const shim = resolveToolWindows(ctxOf({ PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }), 'az', fsOf(['C:\\Tools\\az.cmd']));
    assert.match(/** @type {any} */ (shim).unreadable, /^unreadable \(az is only a \.cmd\/\.bat shim at C:\\Tools\\az\.cmd;.*Azure DevOps/);
    assert.deepEqual(resolveToolWindows(ctxOf({ PATH: 'C:\\Tools' }), 'gh', fsOf([])), { unreadable: 'unreadable' });
  });
  test('I5: a failed taskkill is told (a warn line, no throw); a normal end (0) and an already gone process (128) are silent', () => {
    const warned = [];
    const mk = (r) => /** @type {any} */ (() => r);
    for (const r of [{ status: 0 }, { status: 128 }]) killWindowsTree(5, true, mk(r), {}, (t) => warned.push(t));
    assert.deepEqual(warned, []);
    killWindowsTree(5, true, mk({ status: 1 }), {}, (t) => warned.push(t));
    killWindowsTree(6, false, mk({ status: null, error: new Error('spawn ENOENT') }), {}, (t) => warned.push(t));
    assert.equal(warned.length, 2);
    assert.match(warned[0], /^proofline: taskkill \/pid 5 did not end the process tree \(status 1\); it may still be running\n$/);
    assert.match(warned[1], /\/pid 6 .*spawn ENOENT/);
    assert.deepEqual(killWindowsTree(5, true, mk({ status: 0 }), {}, () => {}), { status: 0 });
  });
});

describe('A252 review round 2', () => {
  test('R1: a refused leader never starts, exits 127 and tells the reason once (the dispatcher no longer returns 127 without a word)', async () => {
    const told = [];
    const l = refusedLeader('unreadable (gh is only a .cmd/.bat shim at C:\\t\\gh.cmd; ...)\n', (t) => told.push(t));
    assert.deepEqual(told, ['unreadable (gh is only a .cmd/.bat shim at C:\\t\\gh.cmd; ...)\n']);
    assert.equal(l.pid, undefined);
    assert.deepEqual(await l.exited, { status: 127, signal: null });
    l.stop();
    assert.equal(told.length, 1, 'stop says nothing more');
  });
  test('R2: startLeader returns the refused leader on a simulated win32 refusal, and the reason reaches the worker log as well as the warning', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wt-leader-'));
    const fd = openSync(path.join(dir, 'worker.log'), 'w');
    try {
      const told = [];
      // a drive-absolute PATH entry that holds nothing: the resolver refuses ("not found"), no program is started on any host
      const l = startLeader('proofline-no-such-tool', [], { cwd: dir, env: { PATH: 'C:\\none', PATHEXT: '.EXE' }, stdio: ['ignore', fd, fd], platform: 'win32', warn: (t) => told.push(t) });
      assert.equal(l.pid, undefined, 'a refused program has no pid');
      assert.deepEqual(await l.exited, { status: 127, signal: null });
      l.stop();
      assert.equal(told.length, 1, 'the reason is told once');
      assert.match(told[0], /^proofline: proofline-no-such-tool was not found on PATH outside the working folder; not started\n$/);
      closeSync(fd);
      assert.equal(readFileSync(path.join(dir, 'worker.log'), 'utf8'), told[0], 'the worker log holds the reason (once, although stdout and stderr are the same file)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
