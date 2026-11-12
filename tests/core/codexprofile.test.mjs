// @ts-check
// core/codexprofile.mjs (A263, Windows port W4): the grants of the Codex permission profile of a run in a linked worktree. Off Windows the function is compared with the code it replaced
// (kept below as `old`) over a table of file-system shapes; the Windows rules run on any host through a fake file system. The grants are the same three everywhere: the main tree's locks
// folder, the worktree's own git folder and the common objects folder; a path that is not drive-absolute (UNC, rooted, device) gets no grant.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worktreeGrants } from '../../control-plane/agents/scripts/core/codexprofile.mjs';

/**
 * A fake file system. DIRS and FILES are the paths that exist; GIT answers by the first arguments; REAL maps a path to its real path.
 * @param {{ dirs?: string[], files?: string[], git?: Record<string, string>, real?: Record<string, string> }} o
 */
function fakeIo(o) {
  const made = /** @type {string[]} */ ([]);
  return {
    made,
    io: {
      git: (/** @type {string[]} */ a) => o.git?.[a.join(' ')] ?? '',
      real: (/** @type {string} */ p) => o.real?.[p] ?? p,
      isDir: (/** @type {string} */ p) => (o.dirs ?? []).includes(p),
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
const POSIX_CASES = /** @type {Array<[string, string, Parameters<typeof fakeIo>[0]]>} */ ([
  ['a worktree, absolute git folders', WT, { files: [`${WT}/.git`], dirs: [GD, `${MAIN}/.git/objects`], git: { 'worktree list --porcelain': `worktree ${MAIN}\nHEAD x`, 'rev-parse --git-dir': GD, 'rev-parse --git-common-dir': `${MAIN}/.git` } }],
  ['a worktree, relative git folders', WT, { files: [`${WT}/.git`], dirs: [`${WT}/rel/worktrees/LC`, `${WT}/../c/objects`], git: { 'worktree list --porcelain': `worktree ${MAIN}`, 'rev-parse --git-dir': 'rel/worktrees/LC', 'rev-parse --git-common-dir': '../c' } }],
  ['the main tree (.git is a folder)', MAIN, { dirs: [`${MAIN}/.git`], git: { 'worktree list --porcelain': `worktree ${MAIN}`, 'rev-parse --git-dir': '.git' } }],
  ['a worktree outside the proofline folder', '/p/other/wt', { files: ['/p/other/wt/.git'], dirs: ['/p/other/g/worktrees/x', '/p/main/.git/objects'], git: { 'worktree list --porcelain': `worktree ${MAIN}`, 'rev-parse --git-dir': '/p/other/g/worktrees/x', 'rev-parse --git-common-dir': `${MAIN}/.git` } }],
  ['a git folder that is no worktrees folder', WT, { files: [`${WT}/.git`], dirs: [`${MAIN}/.git`], git: { 'worktree list --porcelain': `worktree ${MAIN}`, 'rev-parse --git-dir': `${MAIN}/.git`, 'rev-parse --git-common-dir': `${MAIN}/.git` } }],
  ['git answers nothing', WT, { files: [`${WT}/.git`] }],
  ['a symlinked root: real differs from the spelling', '/link/LC', { files: ['/link/LC/.git'], real: { '/link/LC': WT, [GD]: GD }, dirs: [GD, `${MAIN}/.git/objects`], git: { 'worktree list --porcelain': `worktree ${MAIN}`, 'rev-parse --git-dir': GD, 'rev-parse --git-common-dir': `${MAIN}/.git` } }],
  ['no objects folder', WT, { files: [`${WT}/.git`], dirs: [GD], git: { 'worktree list --porcelain': `worktree ${MAIN}`, 'rev-parse --git-dir': GD, 'rev-parse --git-common-dir': `${MAIN}/.git` } }],
  ['a main tree with a space', '/a b/m/.agents/local/worktrees/LC', { files: ['/a b/m/.agents/local/worktrees/LC/.git'], dirs: ['/a b/m/.git/worktrees/LC', '/a b/m/.git/objects'], git: { 'worktree list --porcelain': 'worktree /a b/m', 'rev-parse --git-dir': '/a b/m/.git/worktrees/LC', 'rev-parse --git-common-dir': '/a b/m/.git' } }],
]);

test('POSIX: the grants are exactly what codexProfileArgs computed before, for every file-system shape of the table', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) for (const [name, root, o] of POSIX_CASES) {
    const a = fakeIo(o); const b = fakeIo(o);
    assert.equal(worktreeGrants(root, a.io, platform), old(root, b.io), `${platform}: ${name}`);
    assert.deepEqual(a.made, b.made, `${platform}: ${name}: the locks folder made`);
  }
});

/** A Windows host: git answers in forward slashes, realpath answers backslashes (both with the long names). */
const WIN_MAIN = 'C:/Users/runneradmin/AppData/Local/Temp/proj';
const WIN_WT = `${WIN_MAIN}/.agents/local/worktrees/LC`;
const WIN_GD = `${WIN_MAIN}/.git/worktrees/LC`;
/** What `realpathSync.native` answers: backslashes, the long names (it expands 8.3 short names itself). */
const short = (/** @type {string} */ p) => p.replace(/\//g, '\\');
/** @param {Partial<Parameters<typeof fakeIo>[0]> & { root?: string }} [over] */
function winCase(over = {}) {
  const real = { [WIN_WT]: short(WIN_WT), ['c:\\Users\\runneradmin\\AppData\\Local\\Temp\\proj\\.agents\\local\\worktrees\\LC']: short(WIN_WT), [WIN_GD]: WIN_GD, [`${WIN_MAIN}/.git/objects`]: `${WIN_MAIN}/.git/objects`.replace(/\//g, '\\') };
  return fakeIo({
    files: [`${WIN_WT}/.git`], dirs: [WIN_GD, `${WIN_MAIN}/.git/objects`],
    git: { 'worktree list --porcelain': `worktree ${WIN_MAIN}\nHEAD x`, 'rev-parse --git-dir': WIN_GD, 'rev-parse --git-common-dir': `${WIN_MAIN}/.git` },
    real, ...over,
  });
}
const WANT = `,"${WIN_MAIN}/.agents/local/locks"="write","${WIN_GD}"="write","${WIN_MAIN}/.git/objects"="write"`;

test('win32: the three grants of a worktree are found though real() answers backslashes and git answers forward slashes; the grants are written with forward slashes', () => {
  const f = winCase();
  assert.equal(worktreeGrants(WIN_WT, f.io, 'win32'), WANT);
  assert.deepEqual(f.made, [`${WIN_MAIN}/.agents/local/locks`]);
  assert.ok(!worktreeGrants(WIN_WT, winCase().io, 'win32').includes('\\'), 'no backslash in the grants');
  // the same worktree reached through a lower-case drive letter and backslashes
  const g = winCase();
  assert.equal(worktreeGrants('c:\\Users\\runneradmin\\AppData\\Local\\Temp\\proj\\.agents\\local\\worktrees\\LC', { ...g.io, isFile: () => true }, 'win32'), WANT);
});

test('win32: the profile stays restrictive, never wider: a lookalike main tree, another drive, a UNC main tree or UNC git folders grant nothing', () => {
  const grants = (/** @type {Partial<Parameters<typeof fakeIo>[0]>} */ over) => worktreeGrants(WIN_WT, winCase(over).io, 'win32');
  // the worktree is not under the main tree git names (a sibling folder with the same prefix)
  assert.equal(grants({ git: { 'worktree list --porcelain': `worktree ${WIN_MAIN}2`, 'rev-parse --git-dir': '', 'rev-parse --git-common-dir': '' } }), '');
  // git names a main tree on another drive
  assert.equal(grants({ git: { 'worktree list --porcelain': 'worktree D:/proj', 'rev-parse --git-dir': '', 'rev-parse --git-common-dir': '' } }), '');
  // a UNC main tree (git prints //srv/share/proj): no locks grant
  assert.equal(grants({ git: { 'worktree list --porcelain': 'worktree //srv/share/proj', 'rev-parse --git-dir': '', 'rev-parse --git-common-dir': '' } }), '');
  // the git folder is on a share: no git or objects grant, the locks grant stays
  const unc = grants({ git: { 'worktree list --porcelain': `worktree ${WIN_MAIN}`, 'rev-parse --git-dir': '//srv/share/p/.git/worktrees/LC', 'rev-parse --git-common-dir': '//srv/share/p/.git' }, dirs: ['//srv/share/p/.git/worktrees/LC', '//srv/share/p/.git/objects'] });
  assert.equal(unc, `,"${WIN_MAIN}/.agents/local/locks"="write"`);
  // a junction in the git folder that resolves to a share: refused after the real path is taken
  const jn = grants({ real: { [WIN_GD]: '\\\\srv\\share\\x\\worktrees\\LC' } });
  assert.equal(jn, `,"${WIN_MAIN}/.agents/local/locks"="write"`);
  // a rooted path (no drive) is no grant either
  assert.equal(grants({ git: { 'worktree list --porcelain': `worktree ${WIN_MAIN}`, 'rev-parse --git-dir': '/Users/x/.git/worktrees/LC', 'rev-parse --git-common-dir': '/Users/x/.git' }, dirs: ['/Users/x/.git/worktrees/LC', '/Users/x/.git/objects'] }), `,"${WIN_MAIN}/.agents/local/locks"="write"`);
  // not a worktree at all
  assert.equal(worktreeGrants(WIN_MAIN, fakeIo({ dirs: [`${WIN_MAIN}/.git`] }).io, 'win32'), '');
});
