// @ts-check
// core/pathin.mjs (A260, Windows port W1): real paths in the stored POSIX form and the strict "inside this folder" test behind the ARTIFACT / cited-evidence / UNSUPPORTED_EVIDENCE checks.
// The Windows rules run on any host through the platform and realpath parameters; the POSIX rules are compared with the expression the code used before (`real.startsWith(`${base}/`)`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inRunWorktrees, inside, isScratchWorktreeWin, relUnder, winLinkAction, linkReachesRoot, isAbsoluteInput, localRemote, notRunRelative, nullDevice, onDisk, posixForm, reportNamesAgent, realpathPosix, samePath, scratchRoot } from '../../control-plane/agents/scripts/core/pathin.mjs';
import { readFileSync as readSource } from 'node:fs';
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

test('inRunWorktrees (A263): off Windows exactly `real(dir).startsWith(main + "/.agents/local/worktrees/")` for a table (a failing real leaves the dir as given)', () => {
  const mains = ['/p', '/p/', '/a b/p', '', '/var/folders/zz/T/p'];
  const dirs = ['/p/.agents/local/worktrees/LC', '/p/.agents/local/worktrees/', '/p/.agents/local/worktrees', '/p/.agents/local/WORKTREES/LC', '/p2/.agents/local/worktrees/LC', '/a b/p/.agents/local/worktrees/x/y', '/p', 'C:\\p\\.agents\\local\\worktrees\\LC', '/var/folders/zz/T/p/.agents/local/worktrees/LC', ''];
  const reals = [(/** @type {string} */ x) => x, (/** @type {string} */ x) => x.replace('/link', ''), () => { throw new Error('gone'); }];
  for (const pl of ['linux', 'darwin', 'freebsd']) for (const m of mains) for (const d of dirs) for (const real of reals) {
    let r; try { r = real(d); } catch { r = d; }
    const old = m !== '' && r.startsWith(`${m}/.agents/local/worktrees/`);
    assert.equal(inRunWorktrees(m, d, pl, real), old, `${pl} main=${m} dir=${d}`);
  }
});

test('inRunWorktrees: win32 meets git\'s `C:/Users/runneradmin/...` with the real path `C:\\Users\\RUNNER~1\\...` (long name, backslashes, ASCII case) and refuses lookalikes, other drives and UNC', () => {
  const real = (/** @type {string} */ x) => posixForm(x.replace('RUNNER~1', 'runneradmin'), 'win32');
  const main = 'C:/Users/runneradmin/AppData/Local/Temp/proj';
  const yes = ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj\\.agents\\local\\worktrees\\LC', 'c:/users/runneradmin/appdata/local/temp/proj/.agents/local/worktrees/LC/sub', 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\proj/.agents/local/worktrees/x'];
  const no = ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj\\.agents\\local\\worktrees', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj2\\.agents\\local\\worktrees\\LC', 'D:\\Users\\runneradmin\\AppData\\Local\\Temp\\proj\\.agents\\local\\worktrees\\LC', '\\\\srv\\share\\Users\\runneradmin\\AppData\\Local\\Temp\\proj\\.agents\\local\\worktrees\\LC'];
  for (const d of yes) assert.equal(inRunWorktrees(main, d, 'win32', real), true, d);
  for (const d of no) assert.equal(inRunWorktrees(main, d, 'win32', real), false, d);
  assert.equal(inRunWorktrees('', 'C:/x/.agents/local/worktrees/LC', 'win32', real), false);
});

test('A264: nullDevice is /dev/null off Windows (the literal the code wrote before) and NUL on win32; no argument means the running platform', () => {
  for (const pl of ['linux', 'darwin', 'freebsd', 'aix']) assert.equal(nullDevice(pl), '/dev/null', pl);
  assert.equal(nullDevice('win32'), 'NUL');
  assert.equal(nullDevice(), nullDevice(process.platform));
});

test('A267: onDisk keeps an absolute path and takes a relative one from the working directory; off Windows it is the old leading-slash rule', () => {
  for (const pl of ['linux', 'darwin']) {
    for (const p of ['/a/b', 'a/b', './a', 'C:\\x\\t.md', 'C:/x/t.md', '\\\\srv\\share\\t.md', '']) assert.equal(onDisk('/w', p, pl), p.startsWith('/') ? p : `/w/${p}`, `${pl} ${p}`);
  }
  assert.equal(onDisk('/w', 'C:\\x\\t.md', 'linux'), '/w/C:\\x\\t.md', 'premise: off Windows a drive path is an ordinary relative name');
  for (const p of ['C:\\x\\t.md', 'C:/x/t.md', '\\\\srv\\share\\t.md', '/a/b']) assert.equal(onDisk('D:/w', p, 'win32'), p, `win32 ${p}`);
  assert.equal(onDisk('D:/w', 'a\\b', 'win32'), 'D:/w/a\\b');
});

test('A267: reportNamesAgent reads both slashes on win32 only; the POSIX answers are the old expression', () => {
  const old = (/** @type {string} */ r, /** @type {string} */ a, /** @type {string} */ t) => r.includes(`/${a}-`) || r.startsWith(`${a}-`) || r.startsWith(`${t}/`);
  const reports = ['/t/s1/ag1-rep', 'ag1-rep', '/t/s1/ag2-rep', '/tmp/x/report', '/t/s1/xag1-rep', 'C:\\t\\s1\\ag1-rep', 'C:\\t\\s1\\ag2-rep', 'C:\\tmp\\a\\b'];
  for (const pl of ['linux', 'darwin']) for (const r of reports) assert.equal(reportNamesAgent(r, 'ag1', '/tmp/x', pl), old(r, 'ag1', '/tmp/x'), `${pl} ${r}`);
  assert.equal(reportNamesAgent('C:\\t\\s1\\ag1-rep', 'ag1', '/tmp/x', 'linux'), false, 'premise: off Windows the backslash is not a separator');
  assert.equal(reportNamesAgent('C:\\t\\s1\\ag1-rep', 'ag1', 'C:\\tmp', 'win32'), true);
  assert.equal(reportNamesAgent('C:\\t\\s1\\ag2-rep', 'ag1', 'C:\\tmp', 'win32'), false, 'another agent\'s token still refuses');
  assert.equal(reportNamesAgent('C:\\t\\s1\\xag1-rep', 'ag1', 'C:\\tmp', 'win32'), false, 'the token is a whole file-name start');
  assert.equal(reportNamesAgent('C:\\tmp\\a\\b', 'ag1', 'C:\\tmp', 'win32'), true, 'a report in the submit\'s own temporary folder');
});

test('A267: reportNamesAgent pins what it does not do (accepted limits): no normalisation of `..`, the token may sit in any directory component, a trailing dot or a stream name passes', () => {
  // the same answers as the old expression on POSIX and, with the separator fold, on win32; none of these is a new door, they are what the rule always accepted
  assert.equal(reportNamesAgent('/tmp/x/../etc/passwd', 'ag1', '/tmp/x', 'linux'), true, '`..` after the temporary folder is not folded');
  assert.equal(reportNamesAgent('C:\\tmp\\x\\..\\etc\\passwd', 'ag1', 'C:\\tmp\\x', 'win32'), true, 'same on win32');
  assert.equal(reportNamesAgent('/etc/ag1-dir/passwd', 'ag1', '/tmp/x', 'linux'), true, 'the token in a directory component counts');
  assert.equal(reportNamesAgent('C:\\ag1-dir\\passwd', 'ag1', 'C:\\tmp', 'win32'), true);
  assert.equal(reportNamesAgent('C:\\s\\ag1-rep.', 'ag1', 'C:\\tmp', 'win32'), true, 'a trailing dot');
  assert.equal(reportNamesAgent('C:\\s\\ag1-rep::$DATA', 'ag1', 'C:\\tmp', 'win32'), true, 'a stream name');
  assert.equal(reportNamesAgent('/etc/passwd', 'ag1', '/tmp/x', 'linux'), false, 'premise: a path with none of the three is refused');
  assert.equal(reportNamesAgent('/tmp/xy/a', 'ag1', '/tmp/x', 'linux'), false, 'the temporary folder is a whole component');
});

test('A267: the call sites use the platform rules (a revert goes red here, the Windows probe is the only other check)', () => {
  const core = new URL('../../control-plane/agents/scripts/core/', import.meta.url);
  const tools = readSource(new URL('commands/tools.mjs', core), 'utf8');
  const submit = readSource(new URL('submit.mjs', core), 'utf8');
  assert.match(tools, /import \{ onDisk \} from '\.\.\/pathin\.mjs'/);
  assert.match(tools, /return onDisk\(ctx\.cwd, back\)/);
  assert.doesNotMatch(tools, /back\.startsWith\('\/'\)/, 'the leading-slash expression is gone');
  assert.match(submit, /import \{ reportNamesAgent \} from '\.\/pathin\.mjs'/);
  assert.match(submit, /const ok = reportNamesAgent\(report, agent, tmp\)/);
  assert.doesNotMatch(submit, /report\.includes\(`\/\$\{agent\}-`\)/, 'the slash-only expression is gone');
});

test('A268: the call sites use notRunRelative (a revert goes red here, the Windows probe is the only other check)', () => {
  const core = new URL('../../control-plane/agents/scripts/core/', import.meta.url);
  const gatecmd = readSource(new URL('gatecmd.mjs', core), 'utf8');
  const resultutil = readSource(new URL('resultutil.mjs', core), 'utf8');
  assert.match(gatecmd, /import \{ notRunRelative \} from '\.\/pathin\.mjs'/);
  assert.match(gatecmd, /if \(notRunRelative\(art\)\) fail\(`artifact path must be run-relative/);
  assert.doesNotMatch(gatecmd, /art\.startsWith\('\/'\)/, 'the leading-slash expression is gone');
  assert.match(resultutil, /import \{[^}]*\bnotRunRelative\b[^}]*\} from '\.\/pathin\.mjs'/);
  assert.equal((resultutil.match(/p === '' \|\| notRunRelative\(p\)/g) ?? []).length, 4, 'the four evidence path checks');
  assert.doesNotMatch(resultutil, /p\.startsWith\('\/'\) \|\| p\.includes\('\.\.'\)/, 'the inline check is gone');
});

test('notRunRelative (A268):an absolute path (drive and UNC forms on win32 only) or a `..` is not a run-relative artifact path; a plain relative path is', () => {
  for (const p of ['/etc/passwd', 'a/../b', '..', 'reports/..x']) for (const pl of ['linux', 'win32']) assert.equal(notRunRelative(p, pl), true, `${p} ${pl}`);
  for (const p of ['C:/Program Files/Git/etc/passwd', 'C:\\x', '\\\\srv\\share\\x']) { assert.equal(notRunRelative(p, 'win32'), true, p); assert.equal(notRunRelative(p, 'linux'), false, p); }
  for (const p of ['VERIFY.md', 'reviews/a.md', 'design/SYNC.md', 'C:x']) for (const pl of ['linux', 'win32']) assert.equal(notRunRelative(p, pl), false, `${p} ${pl}`);
});

test('W10: a registered worktree under a Windows temporary folder is scratch; the project, the main tree and a run worktree are not; POSIX never answers true here', () => {
  const io = { platform: 'win32', host: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp', real: (/** @type {string} */ x) => x.replace('RUNNER~1', 'runneradmin') };
  const main = 'C:/Users/runneradmin/AppData/Local/Temp/proofline-h-x/p1';
  const temps = ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp', undefined, ''];
  const scratch = 'C:/Users/RUNNER~1/AppData/Local/Temp/scratch-wt-ab12';
  assert.equal(isScratchWorktreeWin(scratch, main, main, temps, io), true, 'a short-name spelling of the same temporary folder');
  assert.equal(isScratchWorktreeWin('c:/users/runneradmin/appdata/local/temp/other', main, main, temps, io), true, 'another letter case');
  assert.equal(isScratchWorktreeWin(main, main, main, temps, io), false, 'the project itself');
  assert.equal(isScratchWorktreeWin(`${main}/.agents/local/worktrees/RW-1`, main, main, temps, io), false, 'a run worktree');
  assert.equal(isScratchWorktreeWin('C:/Users/RUNNER~1/AppData/Local/Temp/proofline-h-x/p1', main, main, temps, io), false, 'the main tree spelled with the short name');
  assert.equal(isScratchWorktreeWin('D:/work/elsewhere', main, main, temps, io), false, 'a folder outside every temporary folder');
  assert.equal(isScratchWorktreeWin('C:/Users/runneradmin/AppData/Local/Temp2/x', main, main, temps, io), false, 'a sibling that only shares the prefix');
  for (const platform of ['linux', 'darwin']) assert.equal(isScratchWorktreeWin('/tmp/x', '/r', '/r', ['/tmp'], { ...io, platform }), false, `the POSIX rule stays in the caller (${platform})`);
});

test('W10: a link of a copied dependency folder on Windows is re-pointed when it leads into the main tree (any spelling), kept inside the worktree or elsewhere, removed when it cannot be placed', () => {
  const main = 'C:/Users/runneradmin/AppData/Local/Temp/p1';
  const wt = `${main}/.agents/local/worktrees/W-1`;
  const dir = `${wt}/node_modules/.bin`;
  const io = { platform: 'win32', real: (/** @type {string} */ x) => x.replace('RUNNER~1', 'runneradmin') };
  const act = (/** @type {string} */ t) => winLinkAction(t, dir, main, wt, io);
  // relative, leaves the folder: six levels up from node_modules/.bin of the worktree is the main tree (the backslashes are what readlink answers on Windows)
  assert.deepEqual(act('..\\..\\..\\..\\..\\..\\shared\\tool.js'), { action: 'repoint', target: `${wt}/shared/tool.js` });
  assert.deepEqual(act('../../../../../../shared/tool.js'), { action: 'repoint', target: `${wt}/shared/tool.js` });
  assert.deepEqual(act('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\p1\\shared\\tool.js'), { action: 'repoint', target: `${wt}/shared/tool.js` }, 'absolute, backslashes');
  assert.deepEqual(act('\\\\?\\C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p1\\shared\\tool.js'), { action: 'repoint', target: `${wt}/shared/tool.js` }, 'verbatim prefix and a short name');
  assert.deepEqual(act('c:/users/runneradmin/appdata/local/temp/P1/shared/../shared/tool.js'), { action: 'repoint', target: `${wt}/shared/tool.js` }, 'another case, a ..');
  assert.deepEqual(act('pkg\\index.js'), { action: 'keep' }, 'an inner link stays');
  assert.deepEqual(act(`${wt}/node_modules/pkg/index.js`), { action: 'keep' }, 'a link that already points into the worktree stays');
  assert.deepEqual(act('D:\\tools\\x.exe'), { action: 'keep' }, 'another drive is not the main tree');
  assert.deepEqual(act('\\\\localhost\\C$\\Users\\runneradmin\\AppData\\Local\\Temp\\p1\\shared\\tool.js'), { action: 'remove' }, 'the admin share names the main tree: fail closed');
  assert.deepEqual(act('\\\\srv\\share\\x'), { action: 'remove' }, 'a UNC target cannot be placed');
  assert.deepEqual(act('C:shared\\tool.js'), { action: 'remove' }, 'a drive-relative target cannot be placed');
  assert.deepEqual(act('C:\\Users\\runneradmin\\AppData\\Local\\Temp\\p1-other\\x'), { action: 'keep' }, 'a sibling that only shares the prefix');
});

test('W10: relUnder keeps the POSIX batch-line rule exactly and finds a worktree under the project on Windows whatever the spelling', () => {
  const old = (/** @type {string} */ root, /** @type {string} */ rr) => (rr.startsWith(root) ? rr.slice(root.length).replace(/^\/+/, '') : null);
  for (const root of ['/r/p', '/r/p/']) for (const rr of ['/r/p', '/r/p/.agents/local/worktrees/T-1', '/r/p2/x', '/q', '/r/p//x']) for (const pl of ['linux', 'darwin']) assert.equal(relUnder(root, rr, pl), old(root, rr), `${root} ${rr} ${pl}`);
  assert.equal(relUnder('C:/Users/runneradmin/p', 'C:/Users/runneradmin/p/.agents/local/worktrees/T-1', 'win32'), '.agents/local/worktrees/T-1');
  assert.equal(relUnder('c:\\Users\\RunnerAdmin\\p', 'C:/Users/runneradmin/p/.agents/local/worktrees/T-1', 'win32'), '.agents/local/worktrees/T-1', 'typed with backslashes and another case');
  assert.equal(relUnder('C:/Users/runneradmin/p', 'C:/Users/runneradmin/p', 'win32'), '', 'the project itself');
  assert.equal(relUnder('C:/Users/runneradmin/p', 'C:/Users/runneradmin/p2/x', 'win32'), null, 'a sibling');
});

test('W10: the call sites use the platform rules (a revert goes red here, the Windows probe is the only other check)', () => {
  const core = new URL('../../control-plane/agents/scripts/core/', import.meta.url);
  const src = (/** @type {string} */ f) => readSource(new URL(f, core), 'utf8');
  assert.match(src('handoff.mjs'), /\|\| isScratchWorktreeWin\(p, list\[0\] \?\? '', ctx\.root, \[ctx\.env\.TEMP, ctx\.env\.TMP, ctx\.env\.TMPDIR\]\)\) extra \+=/);
  assert.match(src('worktree.mjs'), /process\.platform === 'win32'\) \{[^]*?winLinkAction\(t, physical\(path\.dirname\(l\)\) \?\? '', main, wt\)/);
  const hook = src('commands/hookcmds.mjs');
  assert.match(hook, /const p = posixForm\(args\[0\] \?\? ''\);/);
  assert.match(hook, /if \(!isLocalAbsolute\(p\)\) return 1;/);
  assert.match(hook, /const rest = inside\(base, p\);/);
  assert.match(hook, /inside\(wd, p\) === null && p !== `\$\{wd\}\/`\) return 1;/, 'a worktree path with a trailing slash is approved as before');
  assert.match(src('worktree.mjs'), /if \(linkReachesRoot\(a, main\)\) \{ try \{ unlinkSync\(l\)/);
  assert.doesNotMatch(hook, /if \(!p\.startsWith\('\/'\)\) return 1;/, 'the leading-slash test of worktree-root is gone');
  assert.match(src('commands/runcmds.mjs'), /if \(notRunRelative\(nw\) \|\| nw\.includes\('\/\/'\)/);
  assert.match(src('lifecycle.mjs'), /p === '' \|\| notRunRelative\(p\) \|\| p\.includes\('\/\/'\)\) fail\('invalid local Markdown task source path'\)/);
  assert.match(src('batch.mjs'), /const where = relUnder\(process\.platform === 'win32' \? physical\(ctx\.root\) : ctx\.root, rr\) \?\? rr;/);
});

/** A small Windows file system for the `real` seam: EXISTING folders and files by their real spelling (short names and case folded), JUNCTIONS (a path that really is another one). Throws for a path that does not exist, like realpathSync.native. */
function fakeWinReal(/** @type {string[]} */ existing, /** @type {Record<string, string>} */ junctions = {}) {
  const key = (/** @type {string} */ x) => x.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace('runner~1', 'runneradmin');
  const table = new Map(existing.map((e) => [key(e), e.replace(/\/+$/, '')]));
  const real = (/** @type {string} */ x) => {
    let k = key(x);
    for (const [j, to] of Object.entries(junctions)) if (k === key(j) || k.startsWith(`${key(j)}/`)) k = key(to) + k.slice(key(j).length);
    const hit = table.get(k);
    if (hit === undefined) throw Object.assign(new Error(`ENOENT ${x}`), { code: 'ENOENT' });
    return hit.length === 2 ? `${hit}\\` : hit.replace(/\//g, '\\');
  };
  return real;
}

test('W10 review: a rooted target without a drive, a dangling target in any spelling, a target through a junction, the project root and a folder above it, and the NT forms are judged on the real place (win32 seam)', () => {
  const T = 'C:/Users/runneradmin/AppData/Local/Temp';
  const main = `${T}/p1`; const wt = `${main}/.agents/local/worktrees/W-1`; const dir = `${wt}/node_modules/.bin`;
  const existing = ['C:/', 'C:/Users', 'C:/Users/runneradmin', 'C:/Users/runneradmin/AppData', 'C:/Users/runneradmin/AppData/Local', T, main, `${main}/shared`, `${main}/shared/tool.js`, `${main}/.agents`, `${main}/.agents/local`, `${main}/.agents/local/worktrees`, wt, `${wt}/node_modules`, dir, 'C:/elsewhere', 'C:/elsewhere/deep', 'D:/'];
  const fs = fakeWinReal(existing, { [`${main}/jn`]: 'C:/elsewhere/deep' });
  const io = { platform: 'win32', real: fs };
  const act = (/** @type {string} */ t) => winLinkAction(t, dir, main, wt, io);
  // premises: the fake answers what the product asks (exact strings), existing and dangling alike
  assert.equal(fs(`${main}/shared/tool.js`), 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\p1\\shared\\tool.js');
  assert.throws(() => fs(`${main}/shared/new`), /ENOENT/, 'the dangling target does not exist');
  assert.throws(() => fs(`${main}.`), /ENOENT/);
  // BLOCKER: rooted, no drive letter: Windows resolves it on the link's own drive
  assert.deepEqual(act('\\Users\\runneradmin\\AppData\\Local\\Temp\\p1\\shared\\tool.js'), { action: 'repoint', target: `${wt}/shared/tool.js` }, 'rooted, existing');
  assert.deepEqual(act('/Users/runneradmin/AppData/Local/Temp/p1/shared/new'), { action: 'repoint', target: `${wt}/shared/new` }, 'rooted, dangling');
  assert.deepEqual(winLinkAction('\\Users\\x', '', main, '', io), { action: 'remove' }, 'no drive can be determined: fail closed');
  // MEDIUM 1: dangling in other spellings is resolved from the deepest existing folder
  assert.deepEqual(act('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\p1\\shared\\new'), { action: 'repoint', target: `${wt}/shared/new` }, '8.3, dangling');
  assert.deepEqual(act('c:\\users\\runneradmin\\appdata\\local\\temp\\P1\\shared\\new'), { action: 'repoint', target: `${wt}/shared/new` }, 'letter case, dangling');
  assert.deepEqual(act(`${main.replace(/\//g, '\\')}.\\shared\\new`), { action: 'remove' }, 'trailing dot (Windows trims it, so it names p1)');
  assert.deepEqual(act(`${main.replace(/\//g, '\\')} \\shared\\new`), { action: 'remove' }, 'trailing space');
  assert.deepEqual(act(`${main}/shared/new:stream`), { action: 'remove' }, 'a stream name');
  // a `..` after a junction is the junction's parent, not the text's: jn -> C:/elsewhere/deep, so jn/../x is C:/elsewhere/x (outside), while the text would say p1/x (inside the main tree)
  assert.deepEqual(act(`${main}/jn/../x`), { action: 'keep' }, 'through a junction');
  // MEDIUM 2: the root itself and every folder above it
  assert.deepEqual(act(main), { action: 'remove' }, 'the project root');
  assert.deepEqual(act(`${main}\\`), { action: 'remove' }, 'the project root with a slash');
  assert.deepEqual(act('..\\..\\..\\..\\..\\..'), { action: 'remove' }, 'a relative target that lands on the root');
  assert.deepEqual(act('C:\\Users\\runneradmin'), { action: 'remove' }, 'a folder above the root');
  assert.deepEqual(act('C:\\'), { action: 'remove' }, 'the drive root');
  assert.deepEqual(act(wt), { action: 'keep' }, 'the worktree itself');
  assert.deepEqual(act('D:\\'), { action: 'keep' }, 'another drive');
  // NT forms
  assert.deepEqual(act('\\??\\C:\\Users\\runneradmin\\AppData\\Local\\Temp\\p1\\shared\\tool.js'), { action: 'remove' }, '\\??\\ prefix');
  assert.deepEqual(act('\\DosDevices\\C:\\x'), { action: 'remove' }, 'DosDevices');
  assert.deepEqual(act('\\\\.\\pipe\\x'), { action: 'remove' }, 'device path');
  assert.deepEqual(act('\\\\?\\UNC\\localhost\\C$\\x'), { action: 'remove' }, 'verbatim UNC');
});

test('W10 review: on POSIX a link to the project root or a folder above it is removed, one below it is not (table)', () => {
  const main = '/r/proj';
  /** @type {[string, boolean][]} */
  const table = [['/r/proj', true], ['/r', true], ['/', true], ['/r/proj/shared', false], ['/r/proj2', false], ['/r/other', false], ['/usr/bin', false], ['/r/pro', false]];
  for (const [a, want] of table) assert.equal(linkReachesRoot(a, main), want, a);
});
