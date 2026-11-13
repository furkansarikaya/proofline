// @ts-check
// A271 (Windows port W12): the PreToolUse guards read a drive (`C:/x`, `C:\x`), UNC (`\\srv\share\x`) and Git Bash (`/c/x`) path as the absolute path it is.
// Before, a leading `/` alone made a path absolute: every other spelling was a relative path and the guards approved what they must deny.
// The Windows rules run on any host through the platform seam (`host.platform` of lib/text.mjs). A directory named `C:` is built under the temp
// folder and the process works from there, so `C:/proj/file` is a real, existing path of the host file system: the premise of every guard test is asserted
// on the value the guard checks. The tests that need that directory do not run on a Windows host (NTFS cannot hold a folder named `C:`).
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { scanCommand } from '../../adapters/claude/hooks/command-scan.mjs';
import { host, isAbsPath, pathKey, winSpell } from '../../adapters/claude/hooks/lib/text.mjs';
import { physicalPath } from '../../adapters/claude/hooks/lib/context.mjs';
import { Deny, dn, stateOf } from '../../adapters/claude/hooks/guards/kit.mjs';
import { scratchGuard } from '../../adapters/claude/hooks/guards/scratch.mjs';
import { dbCheckToken, dbGuardCmd, dbTokens, scratchPath } from '../../adapters/claude/hooks/guards/db.mjs';
import { writeRule } from '../../adapters/claude/hooks/guards/bash.mjs';
import { mergeGuard } from '../../adapters/claude/hooks/guards/merge.mjs';
import { killGuard } from '../../adapters/claude/hooks/guards/kill.mjs';
import { alwaysProtected, pathOk, relpath, roOperand } from '../../adapters/claude/hooks/guards/paths.mjs';
import { normalizeInputPath } from '../../control-plane/agents/scripts/core/paths.mjs';

const realPlatform = host.platform;
const onWindows = process.platform === 'win32';
const NO_DRIVE_DIR = onWindows ? 'builds a directory named C: under the temp folder, which NTFS cannot hold; the Windows rules of the same guards run in the pure tests of this file and in the hook-windows job' : false;
/** @param {string} name */
const win = (name = 'win32') => { host.platform = () => name; };
afterEach(() => { host.platform = realPlatform; });

/** @type {string} */ let base = ''; /** @type {string} */ let oldCwd = process.cwd();
/** @type {string} */ let physProj = '';

before(() => {
  base = realpathSync.native(tempDir('win-drive.'));
  if (onWindows) return; // the folders named C: below cannot exist on NTFS; the tests that need them are skipped there
  for (const d of ['C:/proj/var/data', 'C:/proj/sub', 'C:/proj/.agents', 'C:/tmp', 'C:/x', 'work/C:x', 'D:/other']) mkdirSync(join(base, d), { recursive: true });
  writeFileSync(join(base, 'C:/proj/file.txt'), 'x\n');
  writeFileSync(join(base, 'C:/proj/var/data/dev.sqlite'), 'x\n');
  writeFileSync(join(base, 'C:/x/kill.sh'), `#!/bin/sh\n${['pk', 'ill'].join('')} node\n`);
  writeFileSync(join(base, 'C:/x/ok.sh'), '#!/bin/sh\necho hi\n');
  symlinkSync(join(base, 'C:/proj'), join(base, 'C:/tmp/j'));
  physProj = join(base, 'C:/proj');
  oldCwd = process.cwd();
  process.chdir(base);
});
after(() => { process.chdir(oldCwd); rmSync(base, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------------------------- the one normalising rule

/** @type {Array<[string, string, boolean, boolean?]>} input, normalised, unplaceable, bare NUL */
const SPELLINGS = [
  ['C:/x', 'C:/x', false], ['C:\\x', 'C:/x', false], ['c:\\x', 'C:/x', false], ['C:\\a/b\\c', 'C:/a/b/c', false], ['C:/', 'C:/', false],
  ['C:x', 'C:/x', true], ['C:', 'C:/', true],
  ['\\x', '/x', false], ['\\\\srv\\share\\x', '//srv/share/x', false], ['//srv/share', '//srv/share', false], ['\\\\srv', '/srv', true], ['\\\\srv\\share', '//srv/share', false],
  ['\\\\?\\C:\\x', 'C:/x', false], ['\\\\.\\C:\\x', 'C:/x', false], ['\\\\.\\NUL', '//./NUL', true], ['\\\\?\\UNC\\srv\\share\\x', '//?/UNC/srv/share/x', true],
  ['/c/x', 'C:/x', false], ['/cygdrive/d/x/y', 'D:/x/y', false], ['/c', 'C:/', false],
  ['..\\..\\x', '../../x', false], ['a\\.\\b', 'a/b', false], ['C:/a/../../x', 'C:/x', false], ['sub/../x', 'x', false],
  ['NUL', 'NUL', true, true], ['nul', 'nul', true, true], ['NUL.', 'NUL', true, true], ['CON', 'CON', true], ['aux.txt', 'aux.txt', true], ['COM1', 'COM1', true], ['lpt9.log', 'lpt9.log', true], ['sub\\NUL', 'sub/NUL', true],
  ['console', 'console', false], ['nullable', 'nullable', false],
  ['x.', 'x', false], ['x ', 'x', false], ['C:/proj./x', 'C:/proj/x', false], ['C:/proj /x', 'C:/proj/x', false], ['.agents/githooks./f', '.agents/githooks/f', false], ['C:/a/.../b', 'C:/a/b', true], ['C:/a/.. /b', 'C:/a/b', true],
  ['PROGRA~1\\x', 'PROGRA~1/x', false], ['a/b', 'a/b', false], ['', '.', false],
];

test('winSpell: the table of Windows spellings, normalised in one spelling, unplaceable ones marked', () => {
  /** @type {string[]} */ const wrong = [];
  for (const [input, want, bad, nul] of SPELLINGS) {
    const g = winSpell(input, 'win32');
    if (g.p !== want || g.bad !== bad || g.nul !== (nul === true)) wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(g)} (want ${want} bad=${bad} nul=${nul === true})`);
  }
  assert.deepEqual(wrong, []);
});

test('winSpell on any other platform returns the text untouched (a backslash is a name character, C:/x a name under the working directory)', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    for (const [input] of SPELLINGS) assert.deepEqual(winSpell(input, platform), { p: input, bad: false, nul: false }, `${platform} ${input}`);
  }
  host.platform = () => 'linux';
  assert.equal(isAbsPath('C:/x'), false); assert.equal(isAbsPath('C:\\x'), false); assert.equal(isAbsPath('\\x'), false); assert.equal(isAbsPath('/x'), true);
  assert.equal(pathKey('C:\\X'), 'C:\\X');
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

/** @param {string[]} wts @returns {any} */
function ctxFor(wts = []) {
  const ctx = /** @type {any} */ ({ root: 'C:/proj', mainRoot: 'C:/proj', cwd: 'C:/proj', sroot: 'C:/proj', env: { TMPDIR: 'C:\\Users\\me\\AppData\\Local\\Temp', HOME: 'C:\\Users\\me' }, act: '', ev: 'pretool', role: 'lead', ro: false, installed: false, agents: null });
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
];
const INSIDE = [
  'C:/proj/out.txt', 'c:\\PROJ\\sub\\x', '\\\\?\\C:\\proj\\x', '/c/proj/x', 'C:/proj./x', 'C:\\proj\\sub\\..\\x', '..\\..\\x', 'out.txt', '.\\x', 'sub\\y', 'NUL', 'nul', '/dev/null',
  'D:\\WT\\one\\f', 'd:/wt/one/deep/f',
];

test('scratchGuard on a Windows host: a drive, UNC, long-path or Git Bash write outside the project is refused like /etc/x', async () => {
  win();
  const ctx = ctxFor(['C:/proj', 'D:/wt/one']);
  /** @type {string[]} */ const wrong = [];
  for (const t of OUTSIDE) { const r = await scratchVerdict(ctx, t); if (r === null) wrong.push(`allowed: ${t}`); else if (!t.startsWith('$') && !t.startsWith('~') && !r.includes(`'${t}'`)) wrong.push(`reason names another path: ${t} -> ${r}`); }
  for (const t of INSIDE) { const r = await scratchVerdict(ctx, t); if (r !== null) wrong.push(`denied: ${t} -> ${r}`); }
  for (const t of ['D:/wt/two/f', 'D:/wt/one-evil/f', 'D:/wt']) if ((await scratchVerdict(ctx, t)) === null) wrong.push(`allowed: ${t}`);
  assert.deepEqual(wrong, []);
});

test('scratchGuard: the premise is the value the scanner hands the guard (the written target, backslashes kept)', () => {
  const rec = scanCommand("echo x > 'C:\\Users\\me\\x'").records.find((r) => r.kind === 'W');
  assert.equal(rec?.value, 'C:\\Users\\me\\x');
  assert.equal(scanCommand('echo x > C:/Users/me/AppData/Startup/x.bat').records.find((r) => r.kind === 'W')?.value, 'C:/Users/me/AppData/Startup/x.bat');
  assert.equal(scanCommand("echo x | tee '\\\\srv\\share\\x'").records.find((r) => r.kind === 'W')?.value, '\\\\srv\\share\\x');
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

test('scratchGuard elsewhere is unchanged: a drive spelling is a relative name (allowed), a leading slash outside the project is refused', async () => {
  host.platform = () => 'linux';
  const ctx = ctxFor();
  ctx.root = '/work/proj'; ctx.env = { TMPDIR: '/tmp', HOME: '/home/me' };
  for (const [t, deniedWant] of /** @type {Array<[string, boolean]>} */ ([['C:/Users/me/x', false], ['C:\\Users\\me\\x', false], ['\\\\srv\\share\\x', false], ['D:/other/x', false], ['C:x', false], ['..\\..\\x', false], ['NUL', false], ['CON', false],
    ['/etc/x', true], ['//srv/s', true], ['/c/x', true], ['/work/proj/x', false], ['/work/proj/../x', false], ['/work/projx/y', true], ['~/x', true], ['/dev/null', false], ['$TMPDIR/x', true]])) {
    assert.equal((await scratchVerdict(ctx, t)) !== null, deniedWant, t);
  }
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

// ---------------------------------------------------------------------------------------------------------------- 3: the database guard

/** @returns {any} */
function dbCtx() {
  const ctx = /** @type {any} */ ({ root: 'C:/proj', env: { TMPDIR: 'C:/tmp' }, act: 'LC', ev: 'pretool' });
  const st = stateOf(ctx); st.dbLoaded = true; st.dbPaths = 'var/data/dev.sqlite prod.data *.db *.sqlite'; st.dbClients = 'sqlite3';
  return ctx;
}
/** @param {any} ctx @param {string} tok @returns {string | null} */
function dbVerdict(ctx, tok) { try { dbCheckToken(ctx, tok, 'Read'); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; } }

test('dbCheckToken on a Windows host: a database path entry matches in every spelling, any case', () => {
  win();
  const ctx = dbCtx();
  for (const t of ['C:\\proj\\var\\data\\dev.sqlite', 'var\\data\\dev.sqlite', 'C:\\proj\\prod.data', 'C:/proj/var/data/dev.sqlite', '/c/proj/prod.data', '\\\\srv\\share\\A.SQLITE', 'dev.sqlite.', 'C:/proj/DB.DB', 'C:\\PROJ\\VAR\\DATA\\DEV.SQLITE', 'prod.data ']) {
    assert.notEqual(dbVerdict(ctx, t), null, `not refused: ${t}`);
  }
  for (const t of ['C:\\proj\\src\\a.txt', 'C:\\proj\\var\\data\\other.txt', 'prod.data.bak', 'C:\\proj\\notes.md']) assert.equal(dbVerdict(ctx, t), null, `refused: ${t}`);
  stateOf(ctx).dbPaths = 'var\\data\\w.sqlite';  // a pattern a Windows user wrote with backslashes
  assert.notEqual(dbVerdict(ctx, 'C:/proj/var/data/w.sqlite'), null);
  assert.notEqual(dbVerdict(ctx, 'var\\data\\W.SQLITE'), null);
  stateOf(ctx).dbPaths = 'var/data/dev.sqlite prod.data *.db *.sqlite';
  host.platform = () => 'linux'; // elsewhere only the forward-slash form, and only the exact case
  stateOf(ctx).dbPaths = 'var/data/dev.sqlite prod.data *.db';
  for (const t of ['C:\\proj\\var\\data\\dev.sqlite', 'var\\data\\dev.sqlite', 'C:\\proj\\prod.data', 'DB.DB', 'dev.sqlite.', 'A.SQLITE']) assert.equal(dbVerdict(ctx, t), null, `linux: refused ${t}`);
  for (const t of ['C:/proj/var/data/dev.sqlite', '/proj/prod.data', 'a.db', 'var/data/dev.sqlite', 'x/DEV.db']) assert.notEqual(dbVerdict(ctx, t), null, `linux: not refused ${t}`);
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

test('scratchPath: a scratch file under $TMPDIR is scratch in any drive spelling, `..` and a junction into the project are not', { skip: NO_DRIVE_DIR }, () => {
  win();
  const ctx = dbCtx();
  ctx.root = physProj;                                       // the physical form of the project, as the guards hold it
  ctx.env.TMPDIR = 'C:/tmp';
  assert.ok(scratchPath(ctx, 'C:/tmp/t.db') && scratchPath(ctx, 'C:\\tmp\\t.db') && scratchPath(ctx, 'c:/TMP/t.db') && scratchPath(ctx, '$TMPDIR/t.db'));
  assert.ok(!scratchPath(ctx, 'C:/tmp/../proj/x.db') && !scratchPath(ctx, 'C:\\tmp\\..\\proj\\x.db') && !scratchPath(ctx, 'C:x.db') && !scratchPath(ctx, 'C:/tmp/CON.db') && !scratchPath(ctx, 'C:/tmp/a/.../x.db') && !scratchPath(ctx, 'D:/x.db') && !scratchPath(ctx, `${physProj}/x.db`));
  // the junction: textually under $TMPDIR, physically the project (the physical re-check was skipped for a C:/ path)
  assert.ok(isAbsPath('C:/tmp/j/x.db'), 'premise: the path is absolute');
  assert.ok(existsSync('C:/tmp/j') && realpathSync('C:/tmp/j') === physProj, 'premise: the junction leads into the project');
  assert.equal(scratchPath(ctx, 'C:/tmp/j/x.db'), false);
  assert.equal(scratchPath(ctx, 'C:\\tmp\\j\\x.db'), false);
});

// ---------------------------------------------------------------------------------------------------------------- 4: the read roles' in-place edits

test('roOperand: sed -i on an existing project file through a drive spelling is refused for a read-only role', { skip: NO_DRIVE_DIR }, async () => {
  win();
  const ctx = /** @type {any} */ ({ root: 'C:/proj', mainRoot: 'C:/proj', cwd: 'C:/proj/sub', sroot: join(base, 'nowhere'), env: {}, act: 'LC', ev: 'pretool', role: 'qa', ro: true, installed: false, localDir: join(base, 'nowhere/.agents/local') });
  stateOf(ctx).tasksDir = '.agents/tasks';
  assert.ok(existsSync('C:/proj/file.txt') && !existsSync(`${ctx.cwd}/C:/proj/file.txt`), 'premise: the file exists only as a drive path');
  /** @type {string[]} */ const wrong = [];
  for (const w of ['C:/proj/file.txt', 'C:\\proj\\file.txt', '/c/proj/file.txt', '\\\\?\\C:\\proj\\file.txt', 'C:/proj/sub/../file.txt', 'C:\\proj\\file.txt.', '../file.txt']) {
    const r = await roOperand(ctx, 'P', w);
    if (r === null) wrong.push(`allowed: ${w}`);
  }
  for (const w of ['C:x', 'NUL', 'CON']) if ((await roOperand(ctx, 'P', w)) === null) wrong.push(`allowed: ${w}`);
  assert.deepEqual(wrong, []);
  // outside the project (the scratch guard decides) and absent files stay as they were
  assert.equal(await roOperand(ctx, 'P', 'D:/other/x'), null);
  assert.equal(await roOperand(ctx, 'Q', 'D:/other/x'), null);
  assert.equal(await roOperand(ctx, 'P', 'C:/proj/missing.txt'), null);
});

test('relpath on a Windows host: a drive path inside the project is project-relative, a trailing dot does not hide a protected name', { skip: NO_DRIVE_DIR }, async () => {
  win();
  const ctx = /** @type {any} */ ({ root: 'C:/proj', mainRoot: 'C:/proj', cwd: 'C:/proj/sub', sroot: 'C:/proj', env: {}, act: 'LC', ev: 'pretool', role: 'implementer', installed: false });
  assert.equal(await relpath(ctx, 'C:/proj/sub/f.txt'), 'sub/f.txt');
  assert.equal(await relpath(ctx, 'C:\\proj\\file.txt'), 'file.txt');
  assert.equal(await relpath(ctx, '/c/proj/file.txt'), 'file.txt');
  assert.equal(await relpath(ctx, 'f.txt'), 'sub/f.txt');
  assert.equal(await relpath(ctx, '..\\file.txt'), 'file.txt');
  assert.equal(await relpath(ctx, 'C:/proj/.agents/githooks./pre-commit'), '.agents/githooks/pre-commit');
  assert.ok(alwaysProtected(await relpath(ctx, 'C:/proj/.agents/githooks /pre-commit')));
  assert.equal(await relpath(ctx, 'C:x'), '@unknown');
  assert.equal(await relpath(ctx, 'C:/proj/CON'), '@unknown');
  assert.equal(await relpath(ctx, '\\\\.\\NUL'), '@unknown');
  assert.equal(await relpath(ctx, 'D:/other/x'), '@outside');
  assert.equal(await relpath(ctx, '\\\\?\\D:\\other\\x'), '@outside');
  assert.equal(await relpath(ctx, 'Z:/nope/x'), '@unknown'); // the drive is not there to resolve: the policy then refuses ("cannot resolve the target path")
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
  const ctx = /** @type {any} */ ({ cwd: join(base, 'work'), root: base, env: { TMPDIR: base }, t0: Date.now(), act: '', ev: 'pretool' });
  try { await killGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

test('killGuard: a script run through a drive path is read and scanned for a kill-by-name verb on a Windows host', { skip: NO_DRIVE_DIR }, async () => {
  win();
  assert.ok(existsSync('C:/x/kill.sh') && !existsSync(`${join(base, 'work')}/C:/x/kill.sh`), 'premise: the script exists only as the drive path');
  for (const c of ['bash C:/x/kill.sh', "sh 'C:\\x\\kill.sh'", 'source C:/x/kill.sh', 'cat C:/x/kill.sh | sh', "bash '/c/x/kill.sh'", 'bash --norc C:/x/kill.sh', 'cd work && bash C:/x/kill.sh']) assert.notEqual(await killVerdict(c), null, `not refused: ${c}`);
  for (const c of ['bash C:/x/ok.sh', "sh 'C:\\x\\ok.sh'", 'bash C:/x/missing.sh', 'bash C:x']) assert.equal(await killVerdict(c), null, `refused: ${c}`);
  host.platform = () => 'linux'; // elsewhere C:/x/kill.sh is a name under the working directory, which has no such folder
  assert.equal(await killVerdict('bash C:/x/kill.sh'), null);
});

// ---------------------------------------------------------------------------------------------------------------- 7: the worktree attribution of an event path

test('physicalPath on a Windows host: a drive path is the path it names, not a name under the working directory', { skip: NO_DRIVE_DIR }, () => {
  win();
  const cwd = join(base, 'work');
  assert.equal(physicalPath('C:/proj/sub', cwd), join(base, 'C:/proj/sub'));
  assert.equal(physicalPath('C:\\proj\\sub\\f', cwd), join(base, 'C:/proj/sub/f'));
  assert.equal(physicalPath('/c/proj/sub', cwd), join(base, 'C:/proj/sub'));
  assert.equal(physicalPath('C:x', cwd), '');
  assert.equal(physicalPath('CON', cwd), '');
  assert.equal(physicalPath('Z:/nowhere/x', cwd), '');
  host.platform = () => 'linux';
  assert.equal(physicalPath('C:/proj/sub', cwd), join(realpathSync(cwd), 'C:/proj/sub'), 'elsewhere it is a name under the working directory, as before');
});

void resolve;
