// @ts-check
// core/codexprofile.mjs (A263, Windows port W4): the grants of the Codex permission profile of a run in a linked worktree. Off Windows the honest layout is compared with the code
// it replaced (kept below as `old`), over a table of file-system shapes and over REAL git layouts; the Windows rules run on any host through a fake file system. The grants are the
// same three everywhere: the main tree's locks folder, the worktree's own git folder and the common objects folder. Security round 1: nothing a worker can write (the `commondir` file
// and the `.git` file of its worktree) steers a grant; a layout that is not the honest one stops the profile (`ProfileRefused`), a worktree outside the proofline folder gets none.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ProfileRefused, worktreeGrants } from '../../control-plane/agents/scripts/core/codexprofile.mjs';
import { tempDir } from '../lib/tempdir.mjs';

/**
 * A fake file system. DIRS and FILES are the paths that exist; GIT answers by the first arguments; REAL maps a path to its real path.
 * @param {{ dirs?: string[], files?: string[], git?: Record<string, string>, real?: Record<string, string>, ci?: boolean }} o
 */
function fakeIo(o) {
  const made = /** @type {string[]} */ ([]);
  return {
    made,
    io: {
      git: (/** @type {string[]} */ a) => o.git?.[a.join(' ')] ?? '',
      real: (/** @type {string} */ p) => o.real?.[p] ?? p,
      isDir: (/** @type {string} */ p) => (o.dirs ?? []).some((d) => (o.ci ? d.toLowerCase() === p.toLowerCase() : d === p)),
      isFile: (/** @type {string} */ p) => (o.files ?? []).includes(p),
      mkdirp: (/** @type {string} */ p) => { made.push(p); },
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

const MAIN = '/p/main';
const WT = `${MAIN}/.agents/local/worktrees/LC`;
const GD = `${MAIN}/.git/worktrees/LC`;
const LIST = (/** @type {string} */ m) => ({ 'worktree list --porcelain': `worktree ${m}\nHEAD x` });
const HONEST = { files: [`${WT}/.git`], dirs: [GD, `${MAIN}/.git`, `${MAIN}/.git/objects`], git: { ...LIST(MAIN), 'rev-parse --git-dir': GD, 'rev-parse --git-common-dir': `${MAIN}/.git` } };
const POSIX_CASES = /** @type {Array<[string, string, Parameters<typeof fakeIo>[0]]>} */ ([
  ['a worktree, absolute git folders', WT, HONEST],
  ['a worktree, relative git folders', WT, { ...HONEST, dirs: [`${WT}/rel/worktrees/LC`, `${MAIN}/.git`, `${WT}/../c/objects`], real: { [`${WT}/rel/worktrees/LC`]: GD, [`${WT}/../c/objects`]: `${MAIN}/.git/objects` }, git: { ...LIST(MAIN), 'rev-parse --git-dir': 'rel/worktrees/LC', 'rev-parse --git-common-dir': '../c' } }],
  ['git answers nothing about the git folder', WT, { files: [`${WT}/.git`], git: LIST(MAIN) }],
  ['a symlinked root: real differs from the spelling', '/link/LC', { ...HONEST, files: ['/link/LC/.git'], real: { '/link/LC': WT } }],
  ['no objects folder', WT, { ...HONEST, dirs: [GD, `${MAIN}/.git`] }],
  ['a main tree with a space', '/a b/m/.agents/local/worktrees/LC', { files: ['/a b/m/.agents/local/worktrees/LC/.git'], dirs: ['/a b/m/.git/worktrees/LC', '/a b/m/.git', '/a b/m/.git/objects'], git: { ...LIST('/a b/m'), 'rev-parse --git-dir': '/a b/m/.git/worktrees/LC', 'rev-parse --git-common-dir': '/a b/m/.git' } }],
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

/** Security round 1, honest-case twin and the refusals, over io where git itself is consistent but ONE answer is wrong. */
test('SECURITY-1: an objects folder that is not <main>/.git/objects is refused (a commondir the worker rewrote), whatever the common folder is called', () => {
  const grants = (/** @type {Parameters<typeof fakeIo>[0]} */ o) => worktreeGrants(WT, fakeIo({ ...HONEST, ...o }).io, 'linux');
  assert.equal(grants({}), `,"${MAIN}/.agents/local/locks"="write","${GD}"="write","${MAIN}/.git/objects"="write"`);
  // commondir -> `fake`, and fake/objects is a symlink to an outside folder
  assert.throws(() => grants({ dirs: [GD, `${MAIN}/.git`, `${GD}/fake/objects`], git: { ...HONEST.git, 'rev-parse --git-common-dir': `${GD}/fake` }, real: { [`${GD}/fake/objects`]: '/outside/objects' } }), ProfileRefused);
  // commondir -> the .git of an unrelated repository
  assert.throws(() => grants({ dirs: [GD, `${MAIN}/.git`, '/other/.git/objects'], git: { ...HONEST.git, 'rev-parse --git-common-dir': '/other/.git' } }), ProfileRefused);
  // <main>/.git is a file (a nested worktree or a submodule): nothing to compare with, so no grant and no profile
  assert.throws(() => grants({ dirs: [GD, `${MAIN}/.git/objects`] }), ProfileRefused);
});

test('SECURITY-1: the worktree git folder must be under <main>/.git/worktrees, and git must name the path-derived main tree (a rewritten .git file or commondir)', () => {
  const grants = (/** @type {Parameters<typeof fakeIo>[0]} */ o) => worktreeGrants(WT, fakeIo({ ...HONEST, ...o }).io, 'linux');
  assert.throws(() => grants({ dirs: ['/outside/worktrees/x', `${MAIN}/.git/objects`, `${MAIN}/.git`], git: { ...HONEST.git, 'rev-parse --git-dir': '/outside/worktrees/x' } }), ProfileRefused);
  assert.throws(() => grants({ dirs: [`${MAIN}/.git/worktrees2/LC`, `${MAIN}/.git`], git: { ...HONEST.git, 'rev-parse --git-dir': `${MAIN}/.git/worktrees2/LC` } }), ProfileRefused);
  assert.throws(() => grants({ git: { ...HONEST.git, ...LIST('/other/repo') } }), ProfileRefused, 'git names another main tree');
  assert.throws(() => grants({ git: { ...HONEST.git, 'worktree list --porcelain': '' } }), ProfileRefused, 'git names none');
});

// ---- real git on this host ---------------------------------------------------------------------------------------------------------------------
const GITENV = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const sgit = (/** @type {string} */ cwd, /** @type {string[]} */ args) => spawnSync('git', args, { cwd, env: GITENV, encoding: 'utf8' });
/** A repository with a proofline-shaped worktree; the io is the real one. */
function realLayout() {
  const main = realpathSync(tempDir('cp-main-'));
  sgit(main, ['init', '-q', '-b', 'main']);
  sgit(main, ['commit', '-q', '--allow-empty', '-m', 'x']);
  const wt = path.join(main, '.agents/local/worktrees/LC');
  mkdirSync(path.dirname(wt), { recursive: true });
  assert.equal(sgit(main, ['worktree', 'add', '-q', '--detach', wt, 'HEAD']).status, 0);
  const io = {
    git: (/** @type {string[]} */ a) => { const r = sgit(wt, a); return r.status === 0 ? r.stdout.replace(/\n$/, '') : ''; },
    real: (/** @type {string} */ p) => { try { return realpathSync(p); } catch { return p; } },
    isDir: (/** @type {string} */ p) => { try { return realpathSync(p) !== '' && spawnSync('test', ['-d', p]).status === 0; } catch { return false; } },
    isFile: (/** @type {string} */ p) => spawnSync('test', ['-f', p]).status === 0,
    mkdirp: (/** @type {string} */ p) => { mkdirSync(p, { recursive: true }); },
  };
  return { main, wt, io, gd: path.join(main, '.git/worktrees/LC') };
}
test('real git: the honest layout gives the old text byte for byte; a rewritten commondir (symlinked fake objects, or another repository) and a rewritten .git file are refused', { skip: process.platform === 'win32' ? 'POSIX symlinks and `test`; the Windows rules run through the injected tests (A263)' : false }, () => {
  const a = realLayout();
  const want = `,"${a.main}/.agents/local/locks"="write","${a.gd}"="write","${a.main}/.git/objects"="write"`;
  assert.equal(worktreeGrants(a.wt, a.io, 'linux'), want);
  assert.equal(old(a.wt, a.io), want, 'the old code gives the same text');
  // 1. commondir -> fake, fake/objects -> an outside folder
  const b = realLayout();
  const outside = realpathSync(tempDir('cp-out-'));
  mkdirSync(path.join(outside, 'objects'));
  const fake = path.join(b.gd, 'fake');
  mkdirSync(fake);
  for (const f of ['HEAD']) writeFileSync(path.join(fake, f), 'ref: refs/heads/main\n');
  mkdirSync(path.join(fake, 'refs'));
  symlinkSync(path.join(outside, 'objects'), path.join(fake, 'objects'));
  writeFileSync(path.join(b.gd, 'commondir'), 'fake\n');
  assert.ok(old(b.wt, b.io).includes(`"${outside}/objects"="write"`), 'the premise: the old code granted the outside folder');
  assert.throws(() => worktreeGrants(b.wt, b.io, 'linux'), ProfileRefused);
  // 2. commondir -> another repository's .git
  const c = realLayout(); const d = realLayout();
  writeFileSync(path.join(c.gd, 'commondir'), `${d.main}/.git\n`);
  assert.throws(() => worktreeGrants(c.wt, c.io, 'linux'), ProfileRefused);
  // 3. the .git file of the worktree names a git folder elsewhere
  const e = realLayout(); const f = realLayout();
  writeFileSync(path.join(e.wt, '.git'), `gitdir: ${f.gd}\n`);
  assert.throws(() => worktreeGrants(e.wt, e.io, 'linux'), ProfileRefused);
});

// ---- Windows rules through a fake file system --------------------------------------------------------------------------------------------------
/** A Windows host: git answers in forward slashes, realpath answers backslashes (both with the long names). */
const WIN_MAIN = 'C:/Users/runneradmin/AppData/Local/Temp/proj';
const WIN_WT = `${WIN_MAIN}/.agents/local/worktrees/LC`;
const WIN_GD = `${WIN_MAIN}/.git/worktrees/LC`;
/** What `realpathSync.native` answers: backslashes, the long names (it expands 8.3 short names itself). */
const short = (/** @type {string} */ p) => p.replace(/\//g, '\\');
/** @param {Partial<Parameters<typeof fakeIo>[0]>} [over] */
function winCase(over = {}) {
  const real = { [WIN_WT]: short(WIN_WT), [WIN_GD]: short(WIN_GD), [`${WIN_MAIN}`]: short(WIN_MAIN), [`${WIN_MAIN}/.git/objects`]: short(`${WIN_MAIN}/.git/objects`), ...(over.real ?? {}) };
  return fakeIo({
    files: [`${WIN_WT}/.git`], dirs: [WIN_GD, `${WIN_MAIN}/.git`, `${WIN_MAIN}/.git/objects`],
    git: { ...LIST(WIN_MAIN), 'rev-parse --git-dir': WIN_GD, 'rev-parse --git-common-dir': `${WIN_MAIN}/.git` },
    ci: true, ...over, real,
  });
}
const WANT = `,"${WIN_MAIN}/.agents/local/locks"="write","${WIN_GD}"="write","${WIN_MAIN}/.git/objects"="write"`;
const wgrants = (/** @type {Partial<Parameters<typeof fakeIo>[0]>} */ over) => worktreeGrants(WIN_WT, winCase(over).io, 'win32');
const LOCKS = `,"${WIN_MAIN}/.agents/local/locks"="write"`;

test('win32: the three grants are found though real() answers backslashes and git answers forward slashes; the grants are written with forward slashes', () => {
  const f = winCase();
  assert.equal(worktreeGrants(WIN_WT, f.io, 'win32'), WANT);
  assert.deepEqual(f.made, [`${WIN_MAIN}/.agents/local/locks`]);
  assert.ok(!WANT.includes('\\'));
});

test('win32: a real path that differs only in case (drive letter, folder names) is the same place; a case-folding compare is what finds it', () => {
  const lower = (/** @type {string} */ p) => short(p).toLowerCase();
  const o = winCase({ real: { [WIN_WT]: lower(WIN_WT), [WIN_GD]: lower(WIN_GD), [WIN_MAIN]: short(WIN_MAIN), [`${WIN_MAIN}/.git/objects`]: lower(`${WIN_MAIN}/.git/objects`) } });
  const got = worktreeGrants(WIN_WT, o.io, 'win32');
  assert.equal(got.toLowerCase(), WANT.toLowerCase(), 'the same three grants, in the spelling the real path gave');
  assert.ok(got.includes('C:/users/runneradmin/appdata/local/temp/proj/.agents/local/locks'), 'the main tree comes from the real path of the worktree');
});

test('win32: the profile stays restrictive, never wider: another drive, a UNC main tree, UNC or rooted git folders, and a junction to a share or another drive grant nothing', () => {
  assert.throws(() => wgrants({ git: { ...LIST('D:/proj'), 'rev-parse --git-dir': WIN_GD, 'rev-parse --git-common-dir': `${WIN_MAIN}/.git` } }), ProfileRefused, 'git names a main tree on another drive');
  assert.throws(() => wgrants({ git: { ...LIST('//srv/share/proj'), 'rev-parse --git-dir': WIN_GD, 'rev-parse --git-common-dir': `${WIN_MAIN}/.git` } }), ProfileRefused, 'a UNC main tree');
  assert.throws(() => wgrants({ git: { ...LIST(`${WIN_MAIN}2`), 'rev-parse --git-dir': WIN_GD, 'rev-parse --git-common-dir': `${WIN_MAIN}/.git` } }), ProfileRefused, 'a lookalike main tree');
  assert.throws(() => wgrants({ dirs: ['//srv/share/p/.git/worktrees/LC', `${WIN_MAIN}/.git`], git: { ...LIST(WIN_MAIN), 'rev-parse --git-dir': '//srv/share/p/.git/worktrees/LC', 'rev-parse --git-common-dir': '//srv/share/p/.git' } }), ProfileRefused, 'UNC git folders');
  assert.throws(() => wgrants({ dirs: ['/Users/x/.git/worktrees/LC', `${WIN_MAIN}/.git`], git: { ...LIST(WIN_MAIN), 'rev-parse --git-dir': '/Users/x/.git/worktrees/LC', 'rev-parse --git-common-dir': '/Users/x/.git' } }), ProfileRefused, 'a rooted path has no drive');
  // a junction in the git folder that resolves to a share
  assert.throws(() => wgrants({ real: { [WIN_GD]: '\\\\srv\\share\\x\\worktrees\\LC' } }), ProfileRefused);
  // the objects folder is a junction to another drive (commondir rewritten)
  assert.throws(() => wgrants({ dirs: [WIN_GD, `${WIN_MAIN}/.git`, `${WIN_GD}/fake/objects`], git: { ...LIST(WIN_MAIN), 'rev-parse --git-dir': WIN_GD, 'rev-parse --git-common-dir': `${WIN_GD}/fake` }, real: { [`${WIN_GD}/fake/objects`]: 'D:\\out\\objects' } }), ProfileRefused);
  // not a proofline worktree: none of the grants
  assert.equal(worktreeGrants('C:/Users/r/other', fakeIo({ files: ['C:/Users/r/other/.git'] }).io, 'win32'), '');
  assert.equal(worktreeGrants(WIN_MAIN, fakeIo({ dirs: [`${WIN_MAIN}/.git`] }).io, 'win32'), '');
  assert.equal(LOCKS.length > 0, true);
});
