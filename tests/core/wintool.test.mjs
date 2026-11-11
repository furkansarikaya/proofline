// A252: Windows tool resolution (a .cmd/.bat shim is refused, only an .exe/.com in a safe folder runs) and the taskkill command of the process-tree kill (A226).
// Both run on any host with a fake file system and an injected spawn: no Windows machine, no waits, no clock. On Windows itself: not tried (denenmedi).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowsTool, candidates, plainToolName, isDriveAbsolute, shimMessage } from '../../control-plane/agents/scripts/core/wintool.mjs';
import { taskkillArgs, killWindowsTree } from '../../control-plane/agents/scripts/core/proc.mjs';

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
    assert.deepEqual(candidates('gh', undefined).map((c) => c.file), ['gh.exe', 'gh.com', 'gh.cmd', 'gh.bat']);
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
    killWindowsTree(77, false, spawn);
    killWindowsTree(77, true, spawn);
    assert.deepEqual(calls, [
      ['taskkill', ['/pid', '77', '/T'], { stdio: 'ignore', windowsHide: true }],
      ['taskkill', ['/pid', '77', '/T', '/F'], { stdio: 'ignore', windowsHide: true }],
    ]);
  });
});
