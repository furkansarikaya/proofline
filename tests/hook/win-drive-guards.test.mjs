// @ts-check
// A271 (Windows port W12): the PreToolUse guards read a drive (`C:/x`, `C:\x`), UNC (`\\srv\share\x`) and Git Bash (`/c/x`) path as the absolute path it is.
// Before, a leading `/` alone made a path absolute: every other spelling was a relative path and the guards approved what they must deny.
// The Windows rules run on any host through the platform seam (`host.platform` of lib/text.mjs). The tests that touch the file system run in two worlds with
// the same assertions: on a POSIX host a folder named `C:` is built under the temp folder and the process works from there, so `C:/proj/file` is a real path
// of the host; on a Windows host the real temp folder is used (a drive path, no folder named `C:`). The premise of every guard test is asserted on the value
// the guard checks.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { scanCommand } from '../../adapters/claude/hooks/command-scan.mjs';
import { host, isAbsPath, pathKey, posix, winSpell } from '../../adapters/claude/hooks/lib/text.mjs';
import { buildContext, physicalPath } from '../../adapters/claude/hooks/lib/context.mjs';
import { Deny, dn, stateOf } from '../../adapters/claude/hooks/guards/kit.mjs';
import { landing, scratchGuard } from '../../adapters/claude/hooks/guards/scratch.mjs';
import { writeRule } from '../../adapters/claude/hooks/guards/bash.mjs';
import { dbCheckToken, dbGuardCmd, dbTokens, scratchPath } from '../../adapters/claude/hooks/guards/db.mjs';
import { mergeGuard } from '../../adapters/claude/hooks/guards/merge.mjs';
import { killGuard } from '../../adapters/claude/hooks/guards/kill.mjs';
import { alwaysProtected, canonCase, outsideOk, pathOk, relpath, roOperand, targetOk } from '../../adapters/claude/hooks/guards/paths.mjs';
import { normalizeInputPath } from '../../control-plane/agents/scripts/core/paths.mjs';

const realPlatform = host.platform;
const realDrive = host.drive;
const onWindows = process.platform === 'win32';
/** @param {string} name */
const win = (name = 'win32') => { host.platform = () => name; };
afterEach(() => { host.platform = realPlatform; host.drive = realDrive; });

/** @type {string} */ let base = ''; /** @type {string} */ let oldCwd = process.cwd();
/** The drive spelling of a path under the fixture: `C:/proj` (the folder `C:` of the POSIX world) or the real temp path. @param {string} rel */
const R = (rel) => (onWindows ? `${posix(base)}/${rel}` : `C:/${rel}`);
/** Where that path really is. @param {string} rel */
const F = (rel) => (onWindows ? join(base, rel) : join(base, 'C:', rel));
/** @param {string} s */
const back = (s) => s.replaceAll('/', '\\');
/** `C:/x` as Git Bash writes it, `/c/x`. @param {string} s */
const msys = (s) => s.replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
/** Make a folder of the fixture. @param {string} rel */
const mk = (rel) => mkdirSync(F(rel), { recursive: true });

before(() => {
  base = realpathSync.native(tempDir('win-drive.'));
  for (const d of ['proj/var/data', 'proj/sub', 'proj/.agents', 'tmp', 'x', 'other', 'work', 'home/.claude/plans', 'wt/one', 'tmp/real']) mk(d);
  if (!onWindows) { mk('w/repo'); mk('D:/other'); }
  writeFileSync(F('proj/file.txt'), 'x\n');
  writeFileSync(F('proj/var/data/dev.sqlite'), 'x\n');
  writeFileSync(F('x/kill.sh'), `#!/bin/sh\n${['pk', 'ill'].join('')} node\n`);
  writeFileSync(F('x/ok.sh'), '#!/bin/sh\necho hi\n');
  if (!onWindows) writeFileSync(F('w/repo/file.txt'), 'x\n');
  symlinkSync(F('proj'), F('tmp/j'), 'junction');
  symlinkSync(F('tmp/real'), F('tmplink'), 'junction');
  if (!onWindows) process.chdir(base);
});
after(() => { process.chdir(oldCwd); rmSync(base, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------------------- the one normalising rule

/** @type {Array<[string, string, boolean, boolean?]>} input, normalised, unplaceable, bare NUL (no working drive known: host.drive gives '') */
const SPELLINGS = [
  ['C:/x', 'C:/x', false], ['C:\\x', 'C:/x', false], ['c:\\x', 'C:/x', false], ['C:\\a/b\\c', 'C:/a/b/c', false], ['C:/', 'C:/', false],
  ['C:x', 'C:/x', true], ['C:', 'C:/', true],
  ['\\x', '/x', true], ['\\xx\\y', '/xx/y', false], ['\\w\\repo\\x', '/w/repo/x', true], ['\\\\srv\\share\\x', '//srv/share/x', false], ['//srv/share', '//srv/share', false], ['\\\\srv', '/srv', true], ['\\\\srv\\share', '//srv/share', false],
  ['\\\\?\\C:\\x', 'C:/x', false], ['\\\\.\\C:\\x', 'C:/x', false], ['\\\\.\\NUL', '//./NUL', true], ['\\\\?\\UNC\\srv\\share\\x', '//?/UNC/srv/share/x', true],
  ['/c/x', 'C:/x', false], ['/cygdrive/d/x/y', 'D:/x/y', false], ['/c', 'C:/', false],
  ['..\\..\\x', '../../x', false], ['a\\.\\b', 'a/b', false], ['C:/a/../../x', 'C:/x', false], ['sub/../x', 'x', false],
  ['NUL', 'NUL', true, true], ['nul', 'nul', true, true], ['NUL.', 'NUL', true, true], ['CON', 'CON', true], ['aux.txt', 'aux.txt', true], ['COM1', 'COM1', true], ['lpt9.log', 'lpt9.log', true], ['sub\\NUL', 'sub/NUL', true],
  ['console', 'console', false], ['nullable', 'nullable', false],
  ['x.', 'x', false], ['x ', 'x', false], ['C:/proj./x', 'C:/proj/x', false], ['C:/proj /x', 'C:/proj/x', false], ['.agents/githooks./f', '.agents/githooks/f', false], ['C:/a/.../b', 'C:/a/b', true], ['C:/a/.. /b', 'C:/a/b', true],
  ['PROGRA~1\\x', 'PROGRA~1/x', false], ['a/b', 'a/b', false], ['', '.', false],
  // NTFS streams name their file or folder: the colon of a drive stays, every other colon ends the name
  ['C:/p/dev.sqlite::$DATA', 'C:/p/dev.sqlite', false], ['C:/p/dev.sqlite:stream', 'C:/p/dev.sqlite', false], ['C:/p/d:$INDEX_ALLOCATION/x', 'C:/p/d/x', false], ['C:/p/x:s/y:t', 'C:/p/x/y', false],
  ['var\\data\\dev.sqlite::$DATA', 'var/data/dev.sqlite', false], ['sub\\x:s', 'sub/x', false], ['C:/p/:x', 'C:/p', true], ['\\\\srv\\share\\f::$DATA', '//srv/share/f', false],
];

test('winSpell: the table of Windows spellings, normalised in one spelling, unplaceable ones marked', () => {
  host.drive = () => '';
  /** @type {string[]} */ const wrong = [];
  for (const [input, want, bad, nul] of SPELLINGS) {
    const g = winSpell(input, 'win32');
    if (g.p !== want || g.bad !== bad || g.nul !== (nul === true)) wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(g)} (want ${want} bad=${bad} nul=${nul === true})`);
  }
  assert.deepEqual(wrong, []);
});

test('winSpell: the root of the current drive takes the drive of the working directory, so the answer is never read again as Git Bash (idempotent, N1)', () => {
  host.drive = () => 'c:';
  assert.equal(winSpell('\\w\\repo\\.git\\hooks\\x', 'win32').p, 'C:/w/repo/.git/hooks/x');
  assert.equal(winSpell('\\x', 'win32').p, 'C:/x');
  /** @type {string[]} */ const wrong = [];
  for (const [input] of SPELLINGS) { const a = winSpell(input, 'win32'); const b = winSpell(a.p, 'win32'); if (b.p !== a.p) wrong.push(`${JSON.stringify(input)} -> ${a.p} -> ${b.p}`); }
  host.drive = () => '';
  for (const [input] of SPELLINGS) { const a = winSpell(input, 'win32'); const b = winSpell(a.p, 'win32'); if (b.p !== a.p && !a.bad) wrong.push(`no drive: ${JSON.stringify(input)} -> ${a.p} -> ${b.p}`); }
  assert.deepEqual(wrong, []);
  assert.equal(winSpell('\\w\\repo\\x', 'win32').bad, true, 'no drive known and a one-letter first name: unplaceable (it could be Git Bash /w)');
});

test('winSpell on any other platform returns the text untouched (a backslash is a name character, C:/x a name under the working directory)', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    for (const [input] of SPELLINGS) assert.deepEqual(winSpell(input, platform), { p: input, bad: false, nul: false }, `${platform} ${input}`);
  }
  host.platform = () => 'linux';
  assert.equal(isAbsPath('C:/x'), false); assert.equal(isAbsPath('C:\\x'), false); assert.equal(isAbsPath('\\x'), false); assert.equal(isAbsPath('/x'), true);
  assert.equal(pathKey('C:\\X'), 'C:\\X');
  assert.equal(alwaysProtected('.Agents/GitHooks/x'), false, 'elsewhere names are case-sensitive');
});

test('winSpell agrees with the core normalizeInputPath wherever the core gives an answer (no second rule that drifts)', () => {
  for (const p of ['C:/x', 'C:\\x', 'c:\\x\\y', 'C:\\a/b\\c', '\\\\?\\C:\\x', '\\\\.\\C:\\x', '\\\\srv\\share\\x', '/c/x/y', '/cygdrive/d/x', 'C:/a/../b', 'C:\\a\\.\\b', '..\\..\\x', 'a\\b']) {
    assert.equal(winSpell(p, 'win32').p, normalizeInputPath(p, 'win32'), p);
  }
});

test('the platform seam: isAbsPath, pathKey and dn follow it', () => {
  win();
  assert.ok(isAbsPath('C:/x') && isAbsPath('C:\\x') && isAbsPath('\\\\srv\\s') && isAbsPath('\\x') && isAbsPath('/c/x'));
  assert.ok(!isAbsPath('C:x') && !isAbsPath('x\\y'));
  assert.equal(pathKey('C:\\Proj\\SUB\\'), 'c:/proj/sub');
  assert.equal(dn('C:/x'), 'C:/'); assert.equal(dn('C:/'), 'C:/'); assert.equal(dn('//srv/share'), '//srv/share'); assert.equal(dn('C:/a/b'), 'C:/a');
  host.platform = () => 'linux';
  assert.equal(dn('C:/x'), 'C:'); assert.equal(dn('/x'), '/');
});

// ---------------------------------------------------------------------------------------------------------------- 1, 2: the scratch guard (shell writes outside the project)

/** @param {string[]} wts @param {string} [cwd] @returns {any} */
function ctxFor(wts = [], cwd = 'C:/proj/sub') {
  const ctx = /** @type {any} */ ({ root: 'C:/proj', mainRoot: 'C:/proj', cwd, sroot: 'C:/proj', env: { TMPDIR: 'C:\\Users\\me\\AppData\\Local\\Temp', HOME: 'C:\\Users\\me', USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, act: '', ev: 'pretool', role: 'lead', ro: false, installed: false, agents: null });
  stateOf(ctx).wts = wts;
  return ctx;
}
/** @param {any} ctx @param {string} target @returns {Promise<string | null>} */
async function scratchVerdict(ctx, target) {
  const scan = /** @type {any} */ ({ records: [{ kind: 'W', raw: target, value: target }] });
  try { await scratchGuard(ctx, scan); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

const OUTSIDE = [
  'C:/Users/me/.ssh/authorized_keys', 'C:\\Users\\me\\x', '\\\\srv\\share\\x', 'D:/other/x', 'C:x', 'C:/proj/../x', '\\\\?\\C:\\Users\\x', 'c:/PROJ/../etc/x', 'CON', 'aux.txt', '\\\\.\\NUL',
  '/c/Users/x', '/etc/x', '//srv/s', 'C:/PROJ~1/x', 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat', 'C:/Users/me/x.', 'D:\\', '\\x', 'C:/proj/NUL',
  '$TMPDIR/x', '~/x.txt', '$HOME/.ssh/x', 'C:/projx/y', 'C:/pro/y',
  // relative targets that land outside (the working directory is C:/proj/sub), and absolute ones that climb out of the project
  '..\\..\\x', '.\\..\\..\\x', '../../x', '..\\..\\..\\..\\Users\\me\\f', 'a\\..\\..\\..\\x', 'C:/proj/../../x', 'C:\\proj\\sub\\..\\..\\..\\x', 'C:/proj/sub/../../../etc/PWN', '/c/proj/../x',
  // the Windows analogues of $HOME
  '%USERPROFILE%\\x', '$USERPROFILE/x', '$env:USERPROFILE/x', '${APPDATA}/x', '$APPDATA/x', '%APPDATA%\\x', '%LOCALAPPDATA%\\x', '%TEMP%\\x', '$env:TEMP\\x', '%PROGRAMDATA%\\x',
];
const INSIDE = [
  'C:/proj/out.txt', 'c:\\PROJ\\sub\\x', '\\\\?\\C:\\proj\\x', '/c/proj/x', 'C:/proj./x', 'C:\\proj\\sub\\..\\x', '..\\y', 'out.txt', '.\\x', 'sub\\y', 'a\\..\\b', 'NUL', 'nul', '/dev/null',
  'C:/proj/sub/../../proj/ok', 'D:\\WT\\one\\f', 'd:/wt/one/deep/f', '%FOO%\\x', '..\\..\\proj\\z',
];

test('scratchGuard on a Windows host: a drive, UNC, long-path, Git Bash, relative or climbing write outside the project is refused like /etc/x', async () => {
  win(); host.drive = () => 'C:';
  const ctx = ctxFor(['C:/proj', 'D:/wt/one']);
  /** @type {string[]} */ const wrong = [];
  for (const t of OUTSIDE) { const r = await scratchVerdict(ctx, t); if (r === null) wrong.push(`allowed: ${t}`); else if (!/^[$~%]/.test(t) && !r.includes(`'${t}'`)) wrong.push(`reason names another path: ${t} -> ${r}`); }
  for (const t of INSIDE) { const r = await scratchVerdict(ctx, t); if (r !== null) wrong.push(`denied: ${t} -> ${r}`); }
  for (const t of ['D:/wt/two/f', 'D:/wt/one-evil/f', 'D:/wt', '%USERPROFILE%\\x']) if ((await scratchVerdict(ctx, t)) === null) wrong.push(`allowed: ${t}`);
  // a variable that names a folder inside the project is inside; one that is not set is outside (fail closed)
  const inside = ctxFor(); inside.env.USERPROFILE = 'C:\\proj\\home';
  assert.equal(await scratchVerdict(inside, '%USERPROFILE%\\x'), null);
  const unset = ctxFor(); delete unset.env.APPDATA;
  assert.notEqual(await scratchVerdict(unset, '%APPDATA%\\x'), null);
  assert.deepEqual(wrong, []);
});

test('scratchGuard: the premise is the value the scanner hands the guard (the written target, backslashes kept, a cd folded in)', () => {
  const rec = scanCommand("echo x > 'C:\\Users\\me\\x'").records.find((r) => r.kind === 'W');
  assert.equal(rec?.value, 'C:\\Users\\me\\x');
  assert.equal(scanCommand('echo x > C:/Users/me/AppData/Startup/x.bat').records.find((r) => r.kind === 'W')?.value, 'C:/Users/me/AppData/Startup/x.bat');
  assert.equal(scanCommand("echo x | tee '\\\\srv\\share\\x'").records.find((r) => r.kind === 'W')?.value, '\\\\srv\\share\\x');
  assert.equal(scanCommand('cd sub && echo x > ../../x').records.find((r) => r.kind === 'W')?.value, 'sub/../../x');
  assert.equal(scanCommand('cd /tmp && echo x > y').records.find((r) => r.kind === 'W')?.value, '/tmp/y');
  assert.equal(scanCommand('cp a ../../b').records.find((r) => r.kind === 'W')?.value, '../../b');
});

test('scratchGuard: pathOk lets an outside path through for every role, so this guard is the only shell guard for it (the premise of the reproduction)', async () => {
  const ctx = ctxFor();
  stateOf(ctx).tasksDir = '.agents/tasks';
  assert.equal(await pathOk(ctx, '@outside'), null);
  ctx.role = 'qa'; ctx.ro = true;
  assert.equal(await pathOk(ctx, '@outside'), null);
  win();
  assert.notEqual(await scratchVerdict(ctx, 'C:/Users/me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.bat'), null);
});

/** POSIX relative and climbing targets: [command, denied] with the working directory and the root named in the table. */
const POSIX_CMDS = /** @type {Array<[string, boolean]>} */ ([
  ['echo x > ../../outside.txt', true], ['echo x > ../outside.txt', true], ['tee ../../../out2.txt', true], ['echo x >> ../x', true], ['cd sub && echo x > ../../x', true], ['cd /tmp && echo > x', true],
  ['cp a ../../b', true], ['mv a ../b', true], ['ln -s /etc/passwd ../x', true], ['cd .. ; echo x > y', true], ['echo x > /work/proj/../x', true], ['echo x > /work/proj/../../../../etc/PWN', true],
  ['echo x > /dev/../etc/x', true], ['echo x > a/../../x', true], ['echo x > ./../x', true], ['echo x > /work/proj/sub/../../x', true], ['echo x > /work/proj/../../etc/x', true],
  ['echo x > out.txt', false], ['echo x > src/a.js', false], ['echo x > ./a', false], ['echo x > a/../b', false], ['cd sub && echo > ../ok', false], ['echo x > /work/proj/a/../b', false],
  ['echo x > /dev/null', false], ['echo x > /dev/stderr', false], ['cp a b', false], ['tee ../proj/q', false], ['echo > /work/proj/sub/../q', false], ['echo > sub/../../proj/z', false],
]);

test('scratchGuard on POSIX: a relative target is judged from the working directory and a climbing one where it lands (the cd of the command included)', async () => {
  host.platform = () => 'linux';
  const ctx = ctxFor([], '/work/proj');
  ctx.root = '/work/proj'; ctx.mainRoot = '/work/proj'; ctx.sroot = '/work/proj'; ctx.env = { TMPDIR: '/tmp', HOME: '/home/me' };
  /** @type {string[]} */ const wrong = [];
  for (const [c, denied] of POSIX_CMDS) {
    try { await scratchGuard(ctx, scanCommand(c)); if (denied) wrong.push(`allowed: ${c}`); } catch (e) { if (!(e instanceof Deny)) throw e; if (!denied) wrong.push(`denied: ${c} -> ${e.reason}`); }
  }
  assert.deepEqual(wrong, []);
  // from a deeper folder `../../x` stays inside, three levels up does not
  ctx.cwd = '/work/proj/src/deep';
  assert.equal(await scratchVerdict(ctx, '../../ok.txt'), null);
  assert.notEqual(await scratchVerdict(ctx, '../../../x'), null);
  // a name followed by .. that is a link: the OS goes to the parent of the link target, so the result cannot be placed
  assert.equal(landing('/work/proj', 'a/../b'), '/work/proj/b');
  assert.equal(landing('/work/proj', '../x'), '/work/x');
  assert.equal(landing('/work/proj', '/a/b/../c'), '/a/c');
  symlinkSync(F('x'), F('proj/link'), 'junction');
  if (!onWindows) {
    assert.equal(landing(posix(F('proj')), 'link/../y'), null, 'the link is followed by ..');
    const phys = posix(realpathSync(F('proj')));
    const lk = /** @type {any} */ ({ ...ctx, root: phys, mainRoot: phys, sroot: phys, cwd: phys });
    stateOf(lk).wts = [phys];
    assert.notEqual(await scratchVerdict(lk, 'link/../y'), null, 'the guard refuses what landing cannot place');
    assert.equal(await scratchVerdict(lk, 'sub/../y'), null);
    // the kernel resolves .. from the PHYSICAL working directory: cwd is a link to proj/sub, so ../y is proj/y (inside) and ../../x is outside
    const via = /** @type {any} */ ({ ...lk, cwd: posix(F('tmp/j/sub')) });
    assert.equal(await scratchVerdict(via, '../y'), null, 'inside, though the logical parent is under tmp');
    assert.notEqual(await scratchVerdict(via, '../../x'), null);
  }
});

test('scratchGuard on a Windows host: a relative target from a working directory spelled another way (a junction, 8.3, capitals) is judged on its physical form too', async () => {
  win(); host.drive = () => 'C:';
  const phys = posix(realpathSync(F('proj')));
  const ctx = ctxFor([], R('tmp/j/sub'));
  ctx.root = phys; ctx.mainRoot = phys; ctx.sroot = phys;
  stateOf(ctx).wts = [phys];
  assert.ok(realpathSync(F('tmp/j/sub')) === realpathSync(F('proj/sub')), 'premise: the working directory is the project folder reached through a junction');
  assert.equal(await scratchVerdict(ctx, 'out.txt'), null);
  assert.equal(await scratchVerdict(ctx, '..\\y'), null);
  assert.notEqual(await scratchVerdict(ctx, '..\\..\\x'), null);
});

test('scratchGuard elsewhere is unchanged for what stays inside: a drive spelling is a relative name (allowed), a leading slash outside the project is refused', async () => {
  host.platform = () => 'linux';
  const ctx = ctxFor([], '/work/proj');
  ctx.root = '/work/proj'; ctx.env = { TMPDIR: '/tmp', HOME: '/home/me' };
  for (const [t, deniedWant] of /** @type {Array<[string, boolean]>} */ ([['C:/Users/me/x', false], ['C:\\Users\\me\\x', false], ['\\\\srv\\share\\x', false], ['D:/other/x', false], ['C:x', false], ['..\\..\\x', false], ['NUL', false], ['CON', false],
    ['/etc/x', true], ['//srv/s', true], ['/c/x', true], ['/work/proj/x', false], ['/work/proj/../x', true], ['/work/projx/y', true], ['~/x', true], ['/dev/null', false], ['$TMPDIR/x', true], ['../x', true], ['%USERPROFILE%\\x', false]])) {
    assert.equal((await scratchVerdict(ctx, t)) !== null, deniedWant, t);
  }
});

// ---------------------------------------------------------------------------------------------------------------- the real hook, three roles (the pre-existing POSIX hole of the W12 review)

test('the shipped hook, a run open: a relative or climbing shell write that leaves the project is refused for the lead, the implementer and a read-only role', async () => {
  const { buildTemplate, copyProject, runHook } = await import('./harness.mjs');
  const tpl = buildTemplate();
  const bd = tempDir('rel-writes.');
  try {
    const d = copyProject(tpl, bd);
    mkdirSync(join(d, 'src/deep'), { recursive: true }); mkdirSync(join(d, 'sub'), { recursive: true });
    const roles = /** @type {Array<[string, object]>} */ ([['lead', {}], ['implementer', { agent_type: 'proofline-implementer', agent_id: 'a1' }], ['qa', { agent_type: 'proofline-qa', agent_id: 'a2' }]]);
    /** @type {string[]} */ const wrong = [];
    const run = async (/** @type {string} */ cwd, /** @type {string} */ command, /** @type {object} */ who) => (await runHook('node', d, 'pretool', { cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who })).stdout;
    for (const [name, who] of roles) {
      for (const [cwd, c] of /** @type {Array<[string, string]>} */ ([[d, 'echo x > ../../outside.txt'], [d, 'echo x > ../outside.txt'], [join(d, 'src/deep'), 'tee ../../../out2.txt'], [d, 'echo x >> ../x'], [d, 'cd sub && echo x > ../../x'], [d, 'cd /tmp && echo x > y'],
        [d, 'cp a ../../b'], [d, `echo x > ${d}/../x`], [d, 'cd .. ; echo x > y']])) {
        const out = await run(cwd, c, who);
        if (!/"permissionDecision":"deny"/.test(out)) wrong.push(`${name}: allowed ${c} (cwd ${cwd.slice(d.length) || '.'}) -> ${out.slice(0, 80)}`);
      }
      const ok = await run(d, 'echo x > .agents/runs/LC/scratch/o.txt', who);
      if (/outside the project/.test(ok)) wrong.push(`${name}: refused the run's scratch folder: ${ok.slice(0, 160)}`);
    }
    assert.deepEqual(wrong, []);
  } finally { rmSync(tpl, { recursive: true, force: true }); rmSync(bd, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------- 3: the database guard

/** @returns {any} */
function dbCtx() {
  const ctx = /** @type {any} */ ({ root: R('proj'), env: { TMPDIR: R('tmp') }, act: 'LC', ev: 'pretool', cwd: R('proj') });
  const st = stateOf(ctx); st.dbLoaded = true; st.dbPaths = 'var/data/dev.sqlite prod.data *.db *.sqlite'; st.dbClients = 'sqlite3';
  return ctx;
}
/** @param {any} ctx @param {string} tok @returns {string | null} */
function dbVerdict(ctx, tok) { try { dbCheckToken(ctx, tok, 'Read'); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; } }

test('dbCheckToken on a Windows host: a database path entry matches in every spelling, any case', () => {
  win(); host.drive = () => 'C:';
  const ctx = dbCtx();
  for (const t of ['C:\\proj\\var\\data\\dev.sqlite', 'var\\data\\dev.sqlite', 'C:\\proj\\prod.data', 'C:/proj/var/data/dev.sqlite', '/c/proj/prod.data', '\\\\srv\\share\\A.SQLITE', 'dev.sqlite.', 'C:/proj/DB.DB', 'C:\\PROJ\\VAR\\DATA\\DEV.SQLITE', 'prod.data ']) {
    assert.notEqual(dbVerdict(ctx, t), null, `not refused: ${t}`);
  }
  for (const t of ['C:\\proj\\src\\a.txt', 'C:\\proj\\var\\data\\other.txt', 'prod.data.bak', 'C:\\proj\\notes.md']) assert.equal(dbVerdict(ctx, t), null, `refused: ${t}`);
  stateOf(ctx).dbPaths = 'var\\data\\w.sqlite';  // a pattern a Windows user wrote with backslashes
  assert.notEqual(dbVerdict(ctx, 'C:/proj/var/data/w.sqlite'), null);
  assert.notEqual(dbVerdict(ctx, 'var\\data\\W.SQLITE'), null);
  stateOf(ctx).dbPaths = 'Var\\Data\\Mixed.SQLite Prod.DATA';  // and one with capitals: the entry is folded too
  assert.notEqual(dbVerdict(ctx, 'var/data/mixed.sqlite'), null);
  assert.notEqual(dbVerdict(ctx, 'C:/proj/prod.data'), null);
  stateOf(ctx).dbPaths = 'var/data/dev.sqlite prod.data *.db *.sqlite';
  host.platform = () => 'linux'; // elsewhere only the forward-slash form, and only the exact case
  stateOf(ctx).dbPaths = 'var/data/dev.sqlite prod.data *.db';
  for (const t of ['C:\\proj\\var\\data\\dev.sqlite', 'var\\data\\dev.sqlite', 'C:\\proj\\prod.data', 'DB.DB', 'dev.sqlite.', 'A.SQLITE', 'var/data/dev.sqlite::$DATA', 'DEV~1.SQL']) assert.equal(dbVerdict(ctx, t), null, `linux: refused ${t}`);
  for (const t of ['C:/proj/var/data/dev.sqlite', '/proj/prod.data', 'a.db', 'var/data/dev.sqlite', 'x/dev.db']) assert.notEqual(dbVerdict(ctx, t), null, `linux: not refused ${t}`);
});

test('dbCheckToken: an NTFS stream or an 8.3 alias of a database file is the database file (tool paths and shell words alike)', () => {
  win(); host.drive = () => 'C:';
  const ctx = dbCtx();
  stateOf(ctx).dbPaths = 'var/data/dev.sqlite prod.data *.db';
  for (const t of ['var\\data\\dev.sqlite::$DATA', 'var/data/dev.sqlite:stream', 'prod.data::$DATA', 'C:\\proj\\var\\data\\dev.sqlite::$DATA', 'C:/proj/prod.data:s', 'var/data/dev.sqlite:$INDEX_ALLOCATION',
    'DEV~1.SQL', 'PROD~1.DAT', 'C:\\proj\\var\\data\\DEV~1.SQL', 'X~1.DB']) {
    assert.notEqual(dbVerdict(ctx, t), null, `not refused: ${t}`);
  }
  for (const t of ['README~1.TXT', 'C:\\proj\\notes.md::$DATA', 'a~b.txt', 'DEV~1.EXE']) assert.equal(dbVerdict(ctx, t), null, `refused: ${t}`);
});

test('dbTokens keeps the colon of a drive in its word on a Windows host and splits as before elsewhere', () => {
  win();
  assert.deepEqual(dbTokens('sqlite3\x03--db=C:\\proj\\x.db'), ['sqlite3', '--db', 'C:\\proj\\x.db']);
  assert.deepEqual(dbTokens('a:b C:/p/q.db:x'), ['a', 'b', 'C:/p/q.db', 'x']);
  host.platform = () => 'linux';
  assert.deepEqual(dbTokens('sqlite3\x03--db=C:\\proj\\x.db'), ['sqlite3', '--db', 'C', '\\proj\\x.db']);
});

test('dbGuardCmd on a Windows host: a database file named with a drive path in a command is refused', async () => {
  win();
  const ctx = dbCtx();
  for (const cmd of ["cat 'C:\\proj\\var\\data\\dev.sqlite'", 'cp C:/proj/prod.data /tmp/x', "node app.js --db='C:\\proj\\prod.data'"]) {
    await assert.rejects(dbGuardCmd(ctx, scanCommand(cmd)), (e) => e instanceof Deny, cmd);
  }
  await dbGuardCmd(ctx, scanCommand('cat C:/proj/notes.md'));
});

test('scratchPath: a scratch file under $TMPDIR is scratch in any drive spelling; `..`, a junction into the project and the physical form of $TMPDIR', () => {
  win();
  const ctx = dbCtx();
  ctx.root = posix(F('proj')); // the physical form of the project, as the guards hold it
  assert.ok(scratchPath(ctx, R('tmp/t.db')) && scratchPath(ctx, back(R('tmp/t.db'))) && scratchPath(ctx, R('tmp/t.db').toUpperCase()) === scratchPath(ctx, R('tmp/t.db')) && scratchPath(ctx, '$TMPDIR/t.db'));
  assert.ok(!scratchPath(ctx, R('tmp/../proj/x.db')) && !scratchPath(ctx, back(R('tmp/../proj/x.db'))) && !scratchPath(ctx, 'C:x.db') && !scratchPath(ctx, `${R('tmp')}/CON.db`) && !scratchPath(ctx, `${R('tmp')}/a/.../x.db`) && !scratchPath(ctx, R('proj/x.db')));
  // the junction: textually under $TMPDIR, physically the project (the physical re-check was skipped for a C:/ path)
  assert.ok(isAbsPath(R('tmp/j/x.db')), 'premise: the path is absolute');
  assert.ok(existsSync(F('tmp/j')) && realpathSync(F('tmp/j')) === realpathSync(F('proj')), 'premise: the junction leads into the project');
  assert.equal(scratchPath(ctx, R('tmp/j/x.db')), false);
  assert.equal(scratchPath(ctx, back(R('tmp/j/x.db'))), false);
  // $TMPDIR named through a link (a runner's 8.3 short path): a file under its physical form is scratch
  ctx.env.TMPDIR = R('tmplink');
  assert.ok(realpathSync(F('tmplink')) === realpathSync(F('tmp/real')), 'premise: TMPDIR is a link to tmp/real');
  // (a fixture under /var/folders or /tmp is scratch by name anyway: the assertion is then not about the link)
  if (!/^\/(private\/)?(var\/folders|tmp)\//.test(posix(realpathSync(F('tmp/real'))))) assert.equal(scratchPath(ctx, `${posix(realpathSync(F('tmp/real')))}/t.db`), true);
});

// ---------------------------------------------------------------------------------------------------------------- 4: the read roles' in-place edits, relpath, outsideOk

test('roOperand: sed -i on an existing project file through a drive spelling is refused for a read-only role', async () => {
  win(); host.drive = () => 'C:';
  const ctx = /** @type {any} */ ({ root: R('proj'), mainRoot: R('proj'), cwd: R('proj/sub'), sroot: join(base, 'nowhere'), env: {}, act: 'LC', ev: 'pretool', role: 'qa', ro: true, installed: false, localDir: join(base, 'nowhere/.agents/local') });
  stateOf(ctx).tasksDir = '.agents/tasks';
  assert.ok(existsSync(R('proj/file.txt')) && !existsSync(`${ctx.cwd}/${R('proj/file.txt')}`), 'premise: the file exists as the drive path, not under the working directory');
  /** @type {string[]} */ const wrong = [];
  for (const w of [R('proj/file.txt'), back(R('proj/file.txt')), msys(R('proj/file.txt')), `\\\\?\\${back(R('proj/file.txt'))}`, R('proj/sub/../file.txt'), `${back(R('proj/file.txt'))}.`, '../file.txt']) {
    const r = await roOperand(ctx, 'P', w);
    if (r === null) wrong.push(`allowed: ${w}`);
  }
  for (const w of ['C:x', 'NUL', 'CON']) if ((await roOperand(ctx, 'P', w)) === null) wrong.push(`allowed: ${w}`);
  assert.deepEqual(wrong, []);
  // outside the project (the scratch guard decides) and absent files stay as they were; a UNC path is never looked up
  assert.equal(await roOperand(ctx, 'P', R('other/x')), null);
  assert.equal(await roOperand(ctx, 'Q', R('other/x')), null);
  assert.equal(await roOperand(ctx, 'P', R('proj/missing.txt')), null);
  assert.equal(await roOperand(ctx, 'Q', '\\\\srv\\share\\x'), null);
});

test('roOperand: the root of the current drive keeps its drive, so a project under a one-letter folder is not read as another drive (N1)', { skip: onWindows ? 'needs the project under \\w on the current drive, which a runner temp folder is not; the idempotence is asserted in the pure winSpell test' : false }, async () => {
  win(); host.drive = () => 'C:';
  const ctx = /** @type {any} */ ({ root: 'C:/w/repo', mainRoot: 'C:/w/repo', cwd: 'C:/w/repo', sroot: join(base, 'nowhere'), env: {}, act: 'LC', ev: 'pretool', role: 'qa', ro: true, installed: false, localDir: join(base, 'nowhere/.agents/local') });
  stateOf(ctx).tasksDir = '.agents/tasks';
  assert.ok(existsSync('C:/w/repo/file.txt'), 'premise: the file is there');
  assert.notEqual(await roOperand(ctx, 'P', '\\w\\repo\\file.txt'), null);
  assert.equal(await relpath(ctx, '\\w\\repo\\file.txt'), 'file.txt');
  assert.equal(physicalPath('\\w\\repo\\file.txt', 'C:/w/repo'), `${posix(realpathSync('C:/w/repo'))}/file.txt`);
});

test('relpath on a Windows host: a drive path inside the project is project-relative, a trailing dot, a stream or the case of a name does not hide a protected one, UNC is never looked up', async () => {
  win(); host.drive = () => 'C:';
  const ctx = /** @type {any} */ ({ root: R('proj'), mainRoot: R('proj'), cwd: R('proj/sub'), sroot: R('proj'), env: {}, act: 'LC', ev: 'pretool', role: 'implementer', installed: false });
  assert.equal(await relpath(ctx, R('proj/sub/f.txt')), 'sub/f.txt');
  assert.equal(await relpath(ctx, back(R('proj/file.txt'))), 'file.txt');
  assert.equal(await relpath(ctx, msys(R('proj/file.txt'))), 'file.txt');
  stateOf(ctx).tasksDir = '.agents/tasks';
  assert.equal(await relpath(ctx, 'f.txt'), 'sub/f.txt');
  assert.equal(await relpath(ctx, '..\\file.txt'), 'file.txt');
  assert.equal(await relpath(ctx, `${R('proj')}/.agents/githooks./pre-commit`), '.agents/githooks/pre-commit');
  assert.ok(alwaysProtected(await relpath(ctx, `${R('proj')}/.agents/githooks /pre-commit`)));
  assert.ok(alwaysProtected(await relpath(ctx, `${R('proj')}/.agents/githooks/pre-commit::$DATA`)));
  assert.equal(await relpath(ctx, `${R('proj')}/.CLAUDE/Settings.Local.JSON`), '.claude/settings.local.json');
  assert.equal(await relpath(ctx, `${R('proj')}/.Git/CONFIG`), '.git/config');
  assert.equal(await relpath(ctx, `${R('proj')}/.AGENTS/Runs/LC/run.yaml`), '.agents/runs/LC/RUN.yaml');
  assert.ok(alwaysProtected('.AGENTS/GitHooks/x') && alwaysProtected('.GIT/Config.bak'));
  assert.equal(canonCase(ctx, 'src/Settings.Local.json'), 'src/Settings.Local.json', 'only the names the deny-lists know change case');
  assert.equal(await relpath(ctx, 'C:x'), '@unknown');
  assert.equal(await relpath(ctx, `${R('proj')}/CON`), '@unknown');
  assert.equal(await relpath(ctx, '\\\\.\\NUL'), '@unknown');
  assert.equal(await relpath(ctx, R('other/x')), '@outside');
  assert.equal(await relpath(ctx, `\\\\?\\${back(R('other/x'))}`), '@outside');
  assert.equal(await relpath(ctx, 'Z:/nope/x'), '@unknown'); // the drive is not there to resolve: the policy then refuses ("cannot resolve the target path")
  assert.equal(await relpath(ctx, '\\\\srv\\share\\x'), '@outside', 'a UNC path is outside without a file system call (it would open a connection to the server)');
  assert.equal(await targetOk(ctx, '\\\\srv\\share\\x'), null);
});

test('outsideOk on a Windows host: the registered worktrees, HOME and the project root are compared without case', async () => {
  win(); host.drive = () => 'C:';
  const ctx = /** @type {any} */ ({ root: posix(F('proj')), mainRoot: posix(F('proj')), cwd: R('proj'), sroot: R('proj'), env: { HOME: posix(F('HOME')) }, act: 'LC', ev: 'pretool', role: 'implementer', installed: false });
  stateOf(ctx).wts = [posix(F('proj')), posix(F('WT/One'))];
  assert.equal(await outsideOk(ctx, R('wt/one/f')), null, 'a registered worktree, spelled with other capitals');
  assert.equal(await outsideOk(ctx, R('home/.claude/plans/x')), null, 'the runtime plans folder under HOME, spelled with other capitals');
  assert.notEqual(await outsideOk(ctx, R('other/x')), null);
  stateOf(ctx).wts = [posix(F('PROJ'))];
  assert.notEqual(await outsideOk(ctx, R('proj/x')), null, 'the project root itself is no registered worktree, whatever its capitals');
  host.platform = () => 'linux';
  assert.notEqual(await outsideOk(ctx, R('wt/one/f')), null, 'elsewhere names are case-sensitive');
});

test('writeRule: a read-only role writes through no `..` component in any separator; the null device is no write target', async () => {
  win();
  const ro = /** @type {any} */ ({ root: 'C:/proj', mainRoot: 'C:/proj', cwd: 'C:/proj', sroot: 'C:/proj', env: {}, act: 'LC', role: 'qa', ro: true, installed: false });
  stateOf(ro).tasksDir = '.agents/tasks';
  for (const v of ['..\\..\\x', 'C:\\proj\\..\\x', 'a\\..\\..\\x', '../../x']) await assert.rejects(writeRule(ro, v, [`W\t${v}`]), (e) => e instanceof Deny && e.reason.includes('.. component'), v);
  for (const v of ['NUL', 'nul', '/dev/null']) await writeRule(ro, v, []);
  host.platform = () => 'linux'; // elsewhere a backslash is a name character: no `..` component
  await assert.rejects(writeRule(ro, '../../x', []), (e) => e instanceof Deny && e.reason.includes('.. component'));
  if (!onWindows) await assert.rejects(writeRule(ro, 'NUL', []), (e) => e instanceof Deny && !e.reason.includes('.. component'), 'NUL is an ordinary name on a POSIX host');
});

// ---------------------------------------------------------------------------------------------------------------- 5: the merge guard

/** @param {string} dir @param {string} branch */
function repo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['-c', 'gc.auto=0', 'init', '-q', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(dir, '.git/HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}
/** @param {string} dir @param {string} cmd */
async function mergeVerdict(dir, cmd) {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const ctx = /** @type {any} */ ({ ev: 'pretool', cwd: dir, root: dir, env, act: '', installed: false, agent: async () => ({ status: 0, stdout: '', stderr: '' }), agents: { proc: async () => null } });
  try { await mergeGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

test('mergeGuard: git pull from a drive, UNC or backslash local path onto a protected branch is refused on a Windows host', async () => {
  const onMain = repo(join(base, 'm-main'), 'main'); const onFeat = repo(join(base, 'm-feat'), 'feat/x');
  const PULLS = ["git pull 'C:\\other\\repo' task", 'git pull C:/other/repo task', "git pull 'c:\\other' task", "git pull '\\\\srv\\share\\repo' task", "git pull '..\\other' task", 'git pull D:other task', 'git pull /c/other/repo task'];
  const REMOTES = ['git pull origin main', 'git pull https://example.com/r.git main', 'git pull --ff-only origin main'];
  win();
  for (const c of PULLS) { const r = await mergeVerdict(onMain, c); assert.ok(r !== null && r.includes('proofline merge'), `not refused: ${c}`); assert.equal(await mergeVerdict(onFeat, c), null, `refused on a task branch: ${c}`); }
  for (const c of REMOTES) assert.equal(await mergeVerdict(onMain, c), null, c);
  // elsewhere a drive spelling is a name, not a path: exactly the verdicts of before
  host.platform = () => 'linux';
  for (const c of PULLS.slice(0, 6)) assert.equal(await mergeVerdict(onMain, c), null, `linux: ${c}`);
  assert.notEqual(await mergeVerdict(onMain, PULLS[6] ?? ''), null);
});

// ---------------------------------------------------------------------------------------------------------------- 6: the kill guard

/** @param {string} cmd @returns {Promise<string | null>} */
async function killVerdict(cmd) {
  const ctx = /** @type {any} */ ({ cwd: posix(F('work')), root: posix(base), env: { TMPDIR: posix(base) }, t0: Date.now(), act: '', ev: 'pretool' });
  try { await killGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

test('killGuard: a script run through a drive path is read and scanned for a kill-by-name verb on a Windows host', async () => {
  win();
  const k = R('x/kill.sh');
  assert.ok(existsSync(k) && !existsSync(`${posix(F('work'))}/${k}`), 'premise: the script exists as the drive path, not under the working directory');
  for (const c of [`bash ${k}`, `sh '${back(k)}'`, `source ${k}`, `cat ${k} | sh`, `bash '${msys(k)}'`, `bash --norc ${k}`, `cd work && bash ${k}`]) assert.notEqual(await killVerdict(c), null, `not refused: ${c}`);
  for (const c of [`bash ${R('x/ok.sh')}`, `sh '${back(R('x/ok.sh'))}'`, `bash ${R('x/missing.sh')}`, 'bash C:x', `bash '\\\\srv\\share\\kill.sh'`, `bash ${k.replace(/^([A-Za-z]):\//, '$1:')}`]) assert.equal(await killVerdict(c), null, `refused: ${c}`);
  host.platform = () => 'linux'; // elsewhere C:/x/kill.sh is a name under the working directory, which has no such folder
  assert.equal(await killVerdict(`bash ${k}`), null);
});

// ---------------------------------------------------------------------------------------------------------------- 7: the worktree attribution of an event path, and the context

test('physicalPath on a Windows host: a drive path is the path it names, not a name under the working directory; a root is its own parent; UNC is never looked up', () => {
  win();
  const cwd = posix(F('work'));
  const proj = posix(realpathSync(F('proj')));
  assert.equal(physicalPath(R('proj/sub'), cwd), `${proj}/sub`);
  assert.equal(physicalPath(back(R('proj/sub/f')), cwd), `${proj}/sub/f`);
  assert.equal(physicalPath(msys(R('proj/sub')), cwd), `${proj}/sub`);
  assert.equal(physicalPath('C:x', cwd), '');
  assert.equal(physicalPath('CON', cwd), '');
  assert.equal(physicalPath('Z:/nowhere/x', cwd), '');
  assert.equal(physicalPath('\\\\srv\\share\\x', cwd), '');
  assert.equal(physicalPath('//srv/share', cwd), '');
  const root = /^[A-Za-z]:/.exec(R('proj'))?.[0] ?? 'C:';
  assert.equal(physicalPath(`${root}/`, cwd), `${root}/`, 'a drive root is its own parent');
  host.platform = () => 'linux';
  assert.equal(physicalPath(R('proj/sub'), cwd).includes(R('proj/sub')) || onWindows, true, 'elsewhere it is a name under the working directory, as before');
});

test('the context reads a Windows-form cwd, CLAUDE_PROJECT_DIR and event path through the one rule', async () => {
  win(); host.drive = () => 'C:';
  const sub = R('proj/sub');
  const c = await buildContext('pretool', 'claude', Buffer.from(JSON.stringify({ cwd: `\\\\?\\${back(sub)}`, tool_name: 'Write', tool_input: { file_path: msys(R('proj/file.txt')) } })), { CLAUDE_PROJECT_DIR: msys(R('proj')), HOME: posix(base), PATH: process.env.PATH ?? '' });
  assert.ok(c);
  assert.equal(c?.cwd, sub, 'a \\\\?\\ cwd is the drive path (it was a path nobody could enter)');
  assert.equal(c?.root, posix(realpathSync(F('proj'))), 'the project named as /c/... is the project');
});

// ---------------------------------------------------------------------------------------------------------------- the cost of a hostile target

/** @param {() => unknown} f @returns {number} the best of three runs, milliseconds */
function best(f) {
  let m = Infinity;
  for (let i = 0; i < 3; i++) { const t = process.hrtime.bigint(); f(); m = Math.min(m, Number(process.hrtime.bigint() - t) / 1e6); }
  return m;
}

test('a target of a few hundred thousand spaces, dots, backslashes, slashes or tildes costs time in proportion to its length (no quadratic pattern)', async () => {
  win(); host.drive = () => 'C:';
  const ctx = ctxFor(['C:/proj']);
  const mkInputs = (/** @type {number} */ n) => [`C:/proj/${' '.repeat(n)}`, `C:/proj/${'.'.repeat(n)}x`, `x${' '.repeat(n)}.`, `C:${'\\'.repeat(n)}x`, `C:/${'/'.repeat(n)}x`, `${'~1'.repeat(n / 2)}`, `${'. '.repeat(n / 2)}x`, `C:/p/${'a:'.repeat(n / 2)}`, `${'../'.repeat(n / 3)}x`];
  /** @type {Map<number, number>} */ const t = new Map();
  for (const n of [25000, 200000]) {
    const inputs = mkInputs(n);
    const ms = best(() => { for (const s of inputs) { winSpell(s); pathKey(s); } });
    const sc = await (async () => { const t0 = process.hrtime.bigint(); for (const s of inputs) await scratchVerdict(ctx, s); return Number(process.hrtime.bigint() - t0) / 1e6; })();
    const dbc = dbCtx(); const db = best(() => { for (const s of inputs) dbVerdict(dbc, s); });
    t.set(n, ms + sc + db);
  }
  const small = t.get(25000) ?? 0; const big = t.get(200000) ?? 0;
  assert.ok(big < 1500, `200k-character targets took ${big.toFixed(0)} ms`);
  assert.ok(big < 40 * Math.max(small, 5), `8 times the input took ${(big / Math.max(small, 1)).toFixed(0)} times the time (a linear pattern is about 8, a quadratic one about 64)`);
});
