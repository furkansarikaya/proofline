// @ts-check
// core/codexprofile.mjs (A263, Windows port W4): the grants of the Codex permission profile of a run in a linked worktree. Off Windows the honest layout is compared with the code
// it replaced (kept below as `old`), over a table of file-system shapes and over REAL git layouts; the Windows rules run on any host through a fake file system. The grants are the
// same three everywhere: the main tree's locks folder, the worktree's own git folder and the common objects folder. Security rounds 1 to 3: nothing a worker can write (the `.git` file
// of its worktree, `commondir`, the `gitdir` file of its entry) steers a grant. The git folder is the one the CORE recorded when it made the worktree (`wt-entries/<id>.entry`), the
// `.git` file must be a regular file naming exactly that folder; a layout that is not the honest one stops the profile (`ProfileRefused`), a worktree outside the proofline folder gets none.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProfileRefused, entryRecordPath, worktreeGrants } from '../../control-plane/agents/scripts/core/codexprofile.mjs';
import { tempDir } from '../lib/tempdir.mjs';

/**
 * A fake file system. DIRS exist; FILES are regular files; LINKS are files reached through a link (`isFile` yes, `isPlainFile` no); TEXTS holds file contents; GIT answers by the
 * first arguments; REAL maps a path to its real path.
 * @typedef {{ dirs?: string[], files?: string[], links?: string[], texts?: Record<string, string>, git?: Record<string, string>, real?: Record<string, string>, ci?: boolean }} Fake
 * @param {Fake} o
 */
function fakeIo(o) {
  const made = /** @type {string[]} */ ([]);
  const eq = (/** @type {string} */ a, /** @type {string} */ b) => (o.ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  return {
    made,
    io: {
      git: (/** @type {string[]} */ a) => o.git?.[a.join(' ')] ?? '',
      real: (/** @type {string} */ p) => o.real?.[p] ?? p,
      isDir: (/** @type {string} */ p) => (o.dirs ?? []).some((d) => eq(d, p)),
      isFile: (/** @type {string} */ p) => (o.files ?? []).some((x) => eq(x, p)) || (o.links ?? []).some((x) => eq(x, p)),
      isPlainFile: (/** @type {string} */ p) => (o.files ?? []).some((x) => eq(x, p)),
      mkdirp: (/** @type {string} */ p) => { made.push(p); },
      readText: (/** @type {string} */ p) => Object.entries(o.texts ?? {}).find(([k]) => eq(k, p))?.[1] ?? '',   // NTFS is case insensitive: so is the fake
    },
  };
}

/** The code of codexProfileArgs before A263, verbatim in its logic, over the same io. @param {string} root @param {ReturnType<typeof fakeIo>['io']} io */
function old(root, io) {
  let abs = '';
  const git = io.git; const real = io.real; const isFile = io.isFile; const isDir = io.isDir;
  if (isFile(`${root}/.git`)) {
    const first = git(['worktree', 'list', '--porcelain']).split('\n')[0] ?? '';
    const main = first.startsWith('worktree ') ? first.slice('worktree '.length) : '';
    if (main !== '' && real(root).startsWith(`${main}/.agents/local/worktrees/`)) {
      io.mkdirp(`${main}/.agents/local/locks`);
      abs += `,"${main}/.agents/local/locks"="write"`;
    }
    let g = git(['rev-parse', '--git-dir']);
    if (g !== '' && !g.startsWith('/')) g = `${root}/${g}`;
    if (g !== '' && isDir(g)) {
      g = real(g);
      if (/\/worktrees\//.test(g)) {
        abs += `,"${g}"="write"`;
        let o = git(['rev-parse', '--git-common-dir']);
        if (!o.startsWith('/')) o = `${root}/${o}`;
        if (isDir(`${o}/objects`)) abs += `,"${real(`${o}/objects`)}"="write"`;
      }
    }
  }
  return abs;
}

const LIST = (/** @type {string} */ m) => ({ 'worktree list --porcelain': `worktree ${m}\nHEAD x` });
/** The honest layout of run ID in the main tree MAIN: what git and the core leave on disk. @param {string} main @param {string} [id] */
function layout(main, id = 'LC') {
  const wt = `${main}/.agents/local/worktrees/${id}`; const gd = `${main}/.git/worktrees/${id}`; const rec = entryRecordPath(main, id);
  /** @type {Fake} */
  const o = { files: [`${wt}/.git`, rec], dirs: [gd, `${main}/.git`, `${main}/.git/objects`], texts: { [`${wt}/.git`]: `gitdir: ${gd}\n`, [rec]: `${gd}\n` },
    git: { ...LIST(main), 'rev-parse --git-dir': gd, 'rev-parse --git-common-dir': `${main}/.git` } };
  return { wt, gd, rec, o };
}
const MAIN = '/p/main';
const { wt: WT, gd: GD, rec: REC, o: HONEST } = layout(MAIN);
const want = (/** @type {string} */ m, /** @type {string} */ g) => `,"${m}/.agents/local/locks"="write","${g}"="write","${m}/.git/objects"="write"`;
const SP = layout('/a b/m');
const POSIX_CASES = /** @type {Array<[string, string, Fake]>} */ ([
  ['a worktree, absolute git folders', WT, HONEST],
  ['a worktree, relative git folders', WT, { ...HONEST, dirs: [...(HONEST.dirs ?? []), `${WT}/rel/worktrees/LC`, `${WT}/../c/objects`], texts: { ...HONEST.texts, [`${WT}/.git`]: 'gitdir: rel/worktrees/LC\n' }, real: { [`${WT}/rel/worktrees/LC`]: GD, [`${WT}/../c/objects`]: `${MAIN}/.git/objects` }, git: { ...HONEST.git, 'rev-parse --git-dir': 'rel/worktrees/LC', 'rev-parse --git-common-dir': '../c' } }],
  ['a symlinked root: real differs from the spelling', '/link/LC', { ...HONEST, files: [...(HONEST.files ?? []), '/link/LC/.git'], texts: { ...HONEST.texts, '/link/LC/.git': `gitdir: ${GD}\n` }, real: { '/link/LC': WT, '/link/LC/.git': `${WT}/.git` } }],
  ['no objects folder', WT, { ...HONEST, dirs: [GD, `${MAIN}/.git`] }],
  ['a main tree with a space', SP.wt, SP.o],
  ['not a worktree (.git is a folder)', MAIN, { dirs: [`${MAIN}/.git`], git: { ...LIST(MAIN), 'rev-parse --git-dir': '.git' } }],
]);

test('POSIX: the grants of the honest layout are exactly what codexProfileArgs computed before, for every file-system shape of the table', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) for (const [name, root, o] of POSIX_CASES) {
    const a = fakeIo(o); const b = fakeIo(o);
    assert.equal(worktreeGrants(root, a.io, platform), old(root, b.io), `${platform}: ${name}`);
    assert.deepEqual(a.made, b.made, `${platform}: ${name}: the locks folder made`);
  }
});

test('a worktree outside <main>/.agents/local/worktrees gets none of the three grants (the restrictive side; the old code trusted what git answered)', () => {
  const o = { files: ['/p/other/wt/.git'], dirs: ['/p/other/g/worktrees/x', '/p/main/.git/objects', '/p/main/.git'], git: { ...LIST(MAIN), 'rev-parse --git-dir': '/p/other/g/worktrees/x', 'rev-parse --git-common-dir': `${MAIN}/.git` } };
  const f = fakeIo(o);
  assert.equal(worktreeGrants('/p/other/wt', f.io, 'linux'), '');
  assert.deepEqual(f.made, []);
});

/** @param {Fake} [over] @param {string} [root] */
const grants = (over = {}, root = WT) => worktreeGrants(root, fakeIo({ ...HONEST, ...over }).io, 'linux');
const T2 = layout(MAIN, 'T2');

test('SECURITY-3, injected: the record is the anchor: no record, a record that is a link, or one that names no folder under <main>/.git/worktrees is refused', () => {
  assert.equal(grants(), want(MAIN, GD));
  assert.throws(() => grants({ files: [`${WT}/.git`] }), /no record/, 'a worktree made by hand or before A263');
  assert.throws(() => grants({ files: [`${WT}/.git`], links: [REC] }), /no record/, 'the record is a link');
  for (const bad of ['', '/outside/worktrees/x', `${MAIN}/.git/worktrees2/LC`, `${MAIN}/.git/worktrees`, `${GD}/sub`, 'relative/LC', `${MAIN}/.git`]) {
    assert.throws(() => grants({ texts: { ...HONEST.texts, [REC]: `${bad}\n` } }), ProfileRefused, `record ${bad}`);
  }
  assert.throws(() => grants({ dirs: [`${MAIN}/.git`, `${MAIN}/.git/objects`] }), /gone or a link/, 'the recorded folder does not exist');
  assert.throws(() => grants({ real: { [GD]: T2.gd } }), /gone or a link/, 'the recorded folder is a link to another run\'s folder');
});

test('SECURITY-3, injected: even when the .git file names the recorded folder, that folder must be ONE folder directly under <main>/.git/worktrees (own check, not left to the name compare)', () => {
  for (const bad of ['/outside/worktrees/x', `${MAIN}/.git/worktrees2/LC`, `${GD}/sub`, `${MAIN}/.git/worktrees`, `${MAIN}/.git`]) {
    const o = { dirs: [...(HONEST.dirs ?? []), bad], texts: { ...HONEST.texts, [REC]: `${bad}\n`, [`${WT}/.git`]: `gitdir: ${bad}\n` } };
    assert.throws(() => grants(o), /is not a folder under/, `record and .git both ${bad}`);
  }
});

test('SECURITY-3, injected: the .git file is a regular file naming exactly the recorded folder (variants: another run\'s folder, a link to another run\'s .git file, a lookalike)', () => {
  // round 2: T1's .git file names T2's git folder
  assert.throws(() => grants({ texts: { ...HONEST.texts, [`${WT}/.git`]: `gitdir: ${T2.gd}\n` } }), /does not name its recorded/);
  // round 3: T1's .git is a link to T2's .git file (so it reads `gitdir: <T2 entry>`), and T1's own entry was rewritten to match nothing: the lstat refuses first
  assert.throws(() => grants({ files: [REC], links: [`${WT}/.git`], texts: { ...HONEST.texts, [`${WT}/.git`]: `gitdir: ${T2.gd}\n` } }), /is a link/);
  assert.throws(() => grants({ files: [REC], links: [`${WT}/.git`] }), /is a link/, 'a link even when it reads right');
  for (const bad of ['', 'gitdir:', 'gitdir: ', `gitdir: ${GD}2`, `gitdir: ${GD}/sub`, `GITDIR: ${GD}`, `${GD}`]) {
    assert.throws(() => grants({ texts: { ...HONEST.texts, [`${WT}/.git`]: `${bad}\n` } }), ProfileRefused, `.git file ${JSON.stringify(bad)}`);
  }
  // a CRLF line end and a symlinked spelling of the same folder are the same place
  assert.equal(grants({ texts: { ...HONEST.texts, [`${WT}/.git`]: `gitdir: ${GD}\r\n` } }), want(MAIN, GD));
  assert.equal(grants({ texts: { ...HONEST.texts, [`${WT}/.git`]: 'gitdir: /alias/LC\n' }, real: { '/alias/LC': GD } }), want(MAIN, GD));
});

test('SECURITY-1/3, injected: the common folder is never read (a rewritten commondir has no effect), git must name the path-derived main tree, <main>/.git must be a folder', () => {
  const z = { 'rev-parse --git-common-dir': '/outside/fake', 'rev-parse --git-dir': '/outside/g' };
  assert.equal(grants({ git: { ...HONEST.git, ...z }, dirs: [...(HONEST.dirs ?? []), '/outside/fake/objects'] }), want(MAIN, GD), 'whatever rev-parse answers, the objects folder is <main>/.git/objects');
  assert.throws(() => grants({ git: { ...HONEST.git, ...LIST('/other/repo') } }), ProfileRefused, 'git names another main tree');
  assert.throws(() => grants({ git: { ...HONEST.git, 'worktree list --porcelain': '' } }), ProfileRefused, 'git names none');
  assert.throws(() => grants({ dirs: [GD, `${MAIN}/.git/objects`] }), /not a folder/, '<main>/.git is a file (a nested worktree or a submodule)');
  assert.equal(grants({ real: { [`${MAIN}/.git/objects`]: '/data/objects' } }), want(MAIN, GD).replace(`${MAIN}/.git/objects`, '/data/objects'), 'the main tree\'s own objects folder is granted as the old code did');
});

test('a root that is a SUBFOLDER of a run worktree is not the worktree; a root spelled in another case than on disk is refused off Windows (fails closed)', () => {
  const sub = `${WT}/sub`;
  const f = fakeIo({ ...HONEST, files: [...(HONEST.files ?? []), `${sub}/.git`] });
  assert.equal(worktreeGrants(sub, f.io, 'linux'), '', 'the $ anchor: a folder inside a worktree has no grants of its own');
  assert.deepEqual(f.made, []);
  const other = '/p/Main/.agents/local/worktrees/LC';
  assert.throws(() => worktreeGrants(other, fakeIo({ ...HONEST, files: [...(HONEST.files ?? []), `${other}/.git`] }).io, 'linux'), ProfileRefused);
});

// ---- real git on this host ---------------------------------------------------------------------------------------------------------------------
const GITENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const sgit = (/** @type {string} */ cwd, /** @type {string[]} */ args) => spawnSync('git', args, { cwd, env: GITENV, encoding: 'utf8' });
const kind = (/** @type {string} */ p, /** @type {boolean} */ link) => { try { const s = link ? lstatSync(p) : statSync(p); return s; } catch { return null; } };
/** The io over the real file system, git run in WT. @param {string} wt */
const realIo = (wt) => ({
  git: (/** @type {string[]} */ a) => { const r = sgit(wt, a); return r.status === 0 ? r.stdout.replace(/\n$/, '') : ''; },
  real: (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return p; } },
  isDir: (/** @type {string} */ p) => kind(p, false)?.isDirectory() === true,
  isFile: (/** @type {string} */ p) => kind(p, false)?.isFile() === true,
  isPlainFile: (/** @type {string} */ p) => kind(p, true)?.isFile() === true,
  mkdirp: (/** @type {string} */ p) => { mkdirSync(p, { recursive: true }); },
  readText: (/** @type {string} */ p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } },
});
/** Write the record the way `worktree-add` does: the real path of `git rev-parse --git-dir` of the new worktree, a temporary file renamed into place. @param {string} main @param {string} wt */
function writeRecord(main, wt) {
  const gd = realpathSync(path.resolve(wt, sgit(wt, ['rev-parse', '--git-dir']).stdout.trim()));
  const rec = entryRecordPath(main, path.basename(wt));
  mkdirSync(path.dirname(rec), { recursive: true });
  writeFileSync(`${rec}.tmp`, `${gd}\n`);
  renameSync(`${rec}.tmp`, rec);
  return gd;
}
/** A repository with proofline-shaped run worktrees (ids), records written as the core does. @param {string[]} [ids] */
function realLayout(ids = ['LC']) {
  const main = realpathSync(tempDir('cp-main-'));
  sgit(main, ['init', '-q', '-b', 'main']);
  sgit(main, ['commit', '-q', '--allow-empty', '-m', 'x']);
  /** @type {Record<string, { wt: string, gd: string }>} */ const runs = {};
  for (const id of ids) {
    const wt = path.join(main, '.agents/local/worktrees', id);
    mkdirSync(path.dirname(wt), { recursive: true });
    assert.equal(sgit(main, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']).status, 0);
    runs[id] = { wt, gd: writeRecord(main, wt) };
  }
  const first = runs[ids[0]];
  return { main, runs, wt: first.wt, gd: first.gd, io: realIo(first.wt) };
}
const POSIX_ONLY = process.platform === 'win32' ? 'POSIX symlinks and permissions; the Windows rules run through the injected tests (A263)' : false;

test('real git: the honest layout (one run, and two runs) gives the old text byte for byte', { skip: POSIX_ONLY }, () => {
  const a = realLayout(['LC', 'T2']);
  const w = want(a.main, a.gd);
  assert.equal(worktreeGrants(a.wt, a.io, 'linux'), w);
  assert.equal(old(a.wt, a.io), w, 'the old code gives the same text');
  const t2 = a.runs.T2;
  assert.equal(worktreeGrants(t2.wt, realIo(t2.wt), 'linux'), want(a.main, t2.gd));
  assert.equal(old(t2.wt, realIo(t2.wt)), want(a.main, t2.gd));
});

test('SECURITY-1, real git: a commondir rewritten to a fake folder (symlinked objects) or another repository has no effect: the profile is refused or names only <main>/.git/objects', { skip: POSIX_ONLY }, () => {
  const b = realLayout();
  const outside = realpathSync(tempDir('cp-out-'));
  mkdirSync(path.join(outside, 'objects'));
  const fake = path.join(b.gd, 'fake');
  mkdirSync(fake);
  writeFileSync(path.join(fake, 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(path.join(fake, 'refs'));
  symlinkSync(path.join(outside, 'objects'), path.join(fake, 'objects'));
  writeFileSync(path.join(b.gd, 'commondir'), 'fake\n');
  assert.ok(old(b.wt, b.io).includes(`"${outside}/objects"="write"`), 'the premise: the old code granted the outside folder');
  const got = (() => { try { return worktreeGrants(b.wt, b.io, 'linux'); } catch (e) { assert.ok(e instanceof ProfileRefused); return 'refused'; } })();
  assert.ok(!got.includes(outside), `the outside folder is granted: ${got}`);
  assert.ok(got === 'refused' || got === want(b.main, b.gd), got);
  const c = realLayout(); const d = realLayout();
  writeFileSync(path.join(c.gd, 'commondir'), `${d.main}/.git\n`);
  const got2 = (() => { try { return worktreeGrants(c.wt, c.io, 'linux'); } catch (e) { assert.ok(e instanceof ProfileRefused); return 'refused'; } })();
  assert.ok(!got2.includes(d.main), `the other repository is granted: ${got2}`);
});

test('SECURITY-2, real git: T1\'s .git file names T2\'s git folder: the old code granted it, the record refuses', { skip: POSIX_ONLY }, () => {
  const a = realLayout(['LC', 'T2']);
  const t2 = a.runs.T2;
  const orig = readFileSync(path.join(a.wt, '.git'), 'utf8');
  writeFileSync(path.join(a.wt, '.git'), `gitdir: ${t2.gd}\n`);
  assert.ok(old(a.wt, a.io).includes(`"${t2.gd}"="write"`), 'the premise: the old code granted the other run\'s git folder');
  assert.throws(() => worktreeGrants(a.wt, a.io, 'linux'), /does not name its recorded/);
  writeFileSync(path.join(a.wt, '.git'), orig);
  assert.equal(worktreeGrants(a.wt, a.io, 'linux'), want(a.main, a.gd), 'restored: granted again');
});

test('SECURITY-3, real git: T1\'s .git replaced by a SYMLINK to T2\'s .git file and T1\'s own entry gitdir rewritten: git itself now says T2, the lstat and the record refuse', { skip: POSIX_ONLY }, () => {
  const a = realLayout(['LC', 'T2']);
  const t2 = a.runs.T2;
  rmSync(path.join(a.wt, '.git'));
  symlinkSync(path.join(t2.wt, '.git'), path.join(a.wt, '.git'));
  writeFileSync(path.join(a.gd, 'gitdir'), '/nowhere/.git\n');   // its own entry names nothing: the round 2 scan found exactly one entry (T2\'s)
  assert.equal(realpathSync(path.resolve(a.wt, sgit(a.wt, ['rev-parse', '--git-dir']).stdout.trim())), t2.gd, 'the premise: git reports T2\'s folder for T1');
  assert.ok(old(a.wt, a.io).includes(`"${t2.gd}"="write"`), 'the premise: the old code granted T2\'s folder');
  assert.throws(() => worktreeGrants(a.wt, a.io, 'linux'), /is a link/);
  // the same with a regular copy of T2's .git file: it names T2's folder, the record says T1's
  rmSync(path.join(a.wt, '.git'));
  writeFileSync(path.join(a.wt, '.git'), readFileSync(path.join(t2.wt, '.git')));
  assert.throws(() => worktreeGrants(a.wt, a.io, 'linux'), /does not name its recorded/);
});

test('SECURITY-3, real git: a missing record, a record that is a symlink, the recorded folder swapped for a link, and a stale record of a removed worktree are refused', { skip: POSIX_ONLY }, () => {
  const a = realLayout(['LC', 'T2']);
  const rec = entryRecordPath(a.main, 'LC');
  const text = readFileSync(rec, 'utf8');
  rmSync(rec);
  assert.throws(() => worktreeGrants(a.wt, a.io, 'linux'), /no record/);
  const decoy = path.join(a.main, 'decoy.entry');
  writeFileSync(decoy, text);
  symlinkSync(decoy, rec);
  assert.throws(() => worktreeGrants(a.wt, a.io, 'linux'), /no record/, 'a symlink is not a record');
  rmSync(rec);
  writeFileSync(rec, text);
  assert.equal(worktreeGrants(a.wt, a.io, 'linux'), want(a.main, a.gd));
  // inside the granted folder the worker may plant links; swapping the recorded folder itself needs write on its parent, which it has not. The check still holds if it happened:
  const moved = `${a.gd}.moved`;
  renameSync(a.gd, moved);
  symlinkSync(a.runs.T2.gd, a.gd);
  assert.throws(() => worktreeGrants(a.wt, a.io, 'linux'), /gone or a link/);
});

// ---- Windows rules through a fake file system --------------------------------------------------------------------------------------------------
/** A Windows host: git answers in forward slashes, realpath answers backslashes (both with the long names). */
const WIN_MAIN = 'C:/Users/runneradmin/AppData/Local/Temp/proj';
const W = layout(WIN_MAIN);
const WIN_WT = W.wt; const WIN_GD = W.gd;
/** What `realpathSync.native` answers: backslashes, the long names (it expands 8.3 short names itself). */
const short = (/** @type {string} */ p) => p.replace(/\//g, '\\');
/** @param {Fake} [over] */
function winCase(over = {}) {
  const real = { [WIN_WT]: short(WIN_WT), [`${WIN_WT}/.git`]: short(`${WIN_WT}/.git`), [WIN_GD]: short(WIN_GD), [WIN_MAIN]: short(WIN_MAIN), [`${WIN_MAIN}/.git/objects`]: short(`${WIN_MAIN}/.git/objects`), ...(over.real ?? {}) };
  return fakeIo({ ...W.o, ci: true, ...over, real });
}
const WANT = want(WIN_MAIN, WIN_GD);
const wgrants = (/** @type {Fake} */ over) => worktreeGrants(WIN_WT, winCase(over).io, 'win32');

test('win32: the three grants are found though real() answers backslashes and git writes forward slashes; the grants are written with forward slashes', () => {
  const f = winCase();
  assert.equal(worktreeGrants(WIN_WT, f.io, 'win32'), WANT);
  assert.deepEqual(f.made, [`${WIN_MAIN}/.agents/local/locks`]);
  assert.ok(!WANT.includes('\\'));
  // a record or a .git file written with backslashes (a hand-made one) names the same place
  assert.equal(wgrants({ texts: { ...W.o.texts, [W.rec]: `${short(WIN_GD)}\n` } }), WANT);
  assert.equal(wgrants({ texts: { ...W.o.texts, [`${WIN_WT}/.git`]: `gitdir: ${short(WIN_GD)}\r\n` } }), WANT);
});

test('win32: a real path that differs only in case (drive letter, folder names) is the same place; a case-folding compare is what finds it', () => {
  const lower = (/** @type {string} */ p) => short(p).toLowerCase();
  const o = winCase({ real: { [WIN_WT]: lower(WIN_WT), [`${WIN_WT}/.git`]: lower(`${WIN_WT}/.git`), [WIN_GD]: lower(WIN_GD), [WIN_MAIN]: short(WIN_MAIN), [`${WIN_MAIN}/.git/objects`]: lower(`${WIN_MAIN}/.git/objects`) } });
  const got = worktreeGrants(WIN_WT, o.io, 'win32');
  assert.equal(got.toLowerCase(), WANT.toLowerCase(), 'the same three grants, in the spelling the real path gave');
  assert.ok(got.includes('/users/runneradmin/appdata/local/temp/proj/.git/worktrees/lc"'), 'the git folder is written in the spelling of its real path');
  const up = (/** @type {string} */ p) => short(p).toUpperCase();
  const u = winCase({ real: { [WIN_WT]: up(WIN_WT), [`${WIN_WT}/.git`]: up(`${WIN_WT}/.git`), [WIN_GD]: short(WIN_GD), [WIN_MAIN]: short(WIN_MAIN) } });
  assert.equal(worktreeGrants(WIN_WT, u.io, 'win32').toLowerCase(), WANT.toLowerCase());
});

test('win32: the profile stays restrictive, never wider: another drive, a UNC main tree, a UNC or rooted record, a junction to a share, a .git link and a rooted gitdir grant nothing', () => {
  assert.throws(() => wgrants({ git: { ...W.o.git, ...LIST('D:/proj') } }), ProfileRefused, 'git names a main tree on another drive');
  assert.throws(() => wgrants({ git: { ...W.o.git, ...LIST('//srv/share/proj') } }), ProfileRefused, 'a UNC main tree');
  assert.throws(() => wgrants({ git: { ...W.o.git, ...LIST(`${WIN_MAIN}2`) } }), ProfileRefused, 'a lookalike main tree');
  for (const rec of ['//srv/share/p/.git/worktrees/LC', '/Users/x/.git/worktrees/LC', 'D:/other/.git/worktrees/LC', `${WIN_MAIN}/.git/worktrees/LC/sub`]) {
    assert.throws(() => wgrants({ texts: { ...W.o.texts, [W.rec]: `${rec}\n` } }), ProfileRefused, `record ${rec}`);
  }
  // the recorded folder became a junction to a share or to another drive
  assert.throws(() => wgrants({ real: { [WIN_GD]: '\\\\srv\\share\\x\\worktrees\\LC' } }), ProfileRefused);
  assert.throws(() => wgrants({ real: { [WIN_GD]: 'D:\\out\\worktrees\\LC' } }), ProfileRefused);
  // the .git file: a link (a junction cannot be a file; a symbolic link can), another drive, a UNC path, a rooted path without a drive
  assert.throws(() => wgrants({ files: [W.rec], links: [`${WIN_WT}/.git`] }), /is a link/);
  for (const named of ['D:/proj/.git/worktrees/LC', '//srv/share/proj/.git/worktrees/LC', '/Users/x/.git/worktrees/LC']) {
    assert.throws(() => wgrants({ texts: { ...W.o.texts, [`${WIN_WT}/.git`]: `gitdir: ${named}\n` } }), ProfileRefused, `gitdir ${named}`);
  }
  // the main tree's objects folder on a share: not granted
  assert.throws(() => wgrants({ real: { [`${WIN_MAIN}/.git/objects`]: '\\\\srv\\share\\objects' } }), ProfileRefused);
  // not a proofline worktree: none of the grants
  assert.equal(worktreeGrants('C:/Users/r/other', fakeIo({ files: ['C:/Users/r/other/.git'] }).io, 'win32'), '');
  assert.equal(worktreeGrants(WIN_MAIN, fakeIo({ dirs: [`${WIN_MAIN}/.git`] }).io, 'win32'), '');
});

test('win32 variants of the three attacks: T1\'s .git naming T2\'s folder, a link to T2\'s .git file, and a record of another run are refused', () => {
  const T = layout(WIN_MAIN, 'T2');
  assert.throws(() => wgrants({ texts: { ...W.o.texts, [`${WIN_WT}/.git`]: `gitdir: ${T.gd}\n` } }), /does not name its recorded/);
  assert.throws(() => wgrants({ files: [W.rec], links: [`${WIN_WT}/.git`], texts: { ...W.o.texts, [`${WIN_WT}/.git`]: `gitdir: ${T.gd}\n` } }), /is a link/);
  assert.throws(() => wgrants({ files: [`${WIN_WT}/.git`] }), /no record/);
});
