// @ts-check
// A248 (Part of #165): the hermetic git helper, on tiny throwaway repositories (milliseconds each, no delivery chain). A planted driver counts its runs into a file; a planted
// hook, difftool, submodule configuration, url rewrite and ssh command touch a marker. Nothing waits, nothing reads the clock; every repository is unique and removed.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import * as proc from '../../control-plane/agents/scripts/core/proc.mjs';
import { hermeticFetch, importProvenTip, sbMainPark } from '../../control-plane/agents/scripts/core/deliver.mjs';
import { blankNames, hermeticEnv, hgit, indexHasGitlinks, parseDrivers, populatedGitlinks, repoDrivers } from '../../control-plane/agents/scripts/core/hgit.mjs';
import { addedLines, diffNames, git, numstat, trackedPaths, untrackedPaths } from '../../control-plane/agents/scripts/core/git.mjs';

const FIXED = new Date(Date.UTC(2031, 0, 2, 3, 4, 5));
const nul = (/** @type {string[]} */ ...f) => `${f.join('\0')}\0`;
const ENV = (/** @type {string} */ home) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2031-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2031-01-02T03:04:05Z' });

/** A unique scratch folder with a runner for plain git. @returns {{ dir: string, env: Record<string, string>, git: (cwd: string, ...a: string[]) => string, done: () => void }} */
function scratch() {
  const dir = tempDir('hgit-');
  const env = ENV(dir);
  return { dir, env, git: (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('latin1'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A repository with one committed file f.txt; returns the tree. @param {ReturnType<typeof scratch>} s @param {string} name */
function repo(s, name = 'r') {
  const t = path.join(s.dir, name);
  mkdirSync(t);
  s.git(t, 'init', '-q', '-b', 'main');
  writeFileSync(`${t}/f.txt`, 'one\n');
  s.git(t, 'add', 'f.txt');
  s.git(t, 'commit', '-qm', 'one');
  return t;
}
const ctxOf = (/** @type {ReturnType<typeof scratch>} */ s, /** @type {string} */ root, /** @type {string[]} */ blank = []) => /** @type {any} */ ({ cwd: root, root, env: s.env, gitBlank: blank, ctpBase: '', childEnv: () => s.env, once: (/** @type {string} */ _k, /** @type {() => unknown} */ f) => f(), sharedMain: () => root });
/** Make git re-read f.txt (a changed stat is what makes status run the clean filter). @param {string} t @param {string} f */
const touch = (t, f = 'f.txt') => utimesSync(`${t}/${f}`, FIXED, FIXED);

test('parseDrivers: names come from keys only; `=`, dots, case and a crafted value; only the repository\'s own scopes count; includeIf is reported', () => {
  const raw = nul('local', 'filter.a=b.clean', 'local', 'filter.x.y.process', 'local', 'filter.MiXed.smudge', 'global', 'filter.glob.clean', 'system', 'filter.sys.clean',
    'worktree', 'filter..clean', 'command', 'filter.cmd.clean');
  const d = parseDrivers(raw);
  assert.deepEqual(d.names.sort(), ['MiXed', 'a=b', 'cmd', 'x.y']);
  assert.equal(d.includes, false);
  assert.equal(parseDrivers(nul('local', 'includeif.onbranch:main.path')).includes, true);
  assert.equal(parseDrivers(nul('global', 'includeif.onbranch:main.path')).includes, false);
  assert.deepEqual(parseDrivers('').names, []);
});

test('repoDrivers: a crafted VALUE ("# .clean x") cannot change the name; a name with `=` and a dotted sub-section are found', () => {
  const s = scratch();
  try {
    const t = repo(s);
    s.git(t, 'config', 'filter.ck.clean', 'echo c; cat # .clean x');
    s.git(t, 'config', 'filter.a=b.clean', 'cat');
    s.git(t, 'config', 'filter.x.y.smudge', 'cat');
    const d = repoDrivers('git', [t], () => ({ cwd: t, env: s.env }));
    assert.deepEqual(d.names.sort(), ['a=b', 'ck', 'x.y']);
  } finally { s.done(); }
});

test('repoDrivers: an includeIf onbranch include is judged in each tree given: the worktree sees a driver the main tree does not', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const wt = path.join(s.dir, 'wt');
    s.git(t, 'worktree', 'add', '-q', '-b', 'task/x', wt);
    writeFileSync(`${s.dir}/inc.cfg`, '[filter "inc"]\n\tclean = cat\n');
    s.git(t, 'config', 'includeIf.onbranch:task/**.path', `${s.dir}/inc.cfg`);
    const where = () => ({ cwd: s.dir, env: s.env });
    assert.deepEqual(repoDrivers('git', [t], where).names, [], 'invisible from the main tree');
    assert.deepEqual(repoDrivers('git', [t, wt], where), { names: ['inc'], includes: true, submodules: [], capped: false });
  } finally { s.done(); }
});

test('hermeticEnv: blanks each name as a key (so `=` is fine), keeps a count the environment already has, drops GIT_CONFIG_PARAMETERS, turns hooks and the monitor off', () => {
  const e = hermeticEnv({ PATH: '/x', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/evil'" }, ['a=b']);
  assert.equal(e['GIT_CONFIG_PARAMETERS'], undefined);
  assert.equal(e['GIT_CONFIG_KEY_0'], 'a.b');
  assert.equal(e['GIT_CONFIG_KEY_1'], 'c.d');
  /** @type {Record<string, string>} */ const kv = {};
  for (let k = 0; k < Number(e['GIT_CONFIG_COUNT']); k++) kv[/** @type {string} */ (e[`GIT_CONFIG_KEY_${k}`])] = /** @type {string} */ (e[`GIT_CONFIG_VALUE_${k}`]);
  assert.equal(e['GIT_CONFIG_COUNT'], '23');
  assert.deepEqual(kv, { 'a.b': '1', 'c.d': '2', 'core.fsmonitor': 'false', 'diff.submodule': 'short', 'submodule.recurse': 'false',
    'merge.verifySignatures': 'false', 'log.showSignature': 'false', 'commit.gpgSign': 'false', 'tag.gpgSign': 'false', 'gpg.program': '', 'gpg.openpgp.program': '', 'gpg.ssh.program': '', 'gpg.x509.program': '',
    'gpg.ssh.defaultKeyCommand': '', 'core.hooksPath': '/dev/null', 'gc.auto': '0', 'maintenance.auto': 'false', 'receive.autogc': 'false', 'gc.recentObjectsHook': '',
    'filter.a=b.clean': '', 'filter.a=b.smudge': '', 'filter.a=b.process': '', 'filter.a=b.required': 'false' });
  // R3-1: no ignore setting is relied on (a per-submodule ignore=none overrides every one of them), so none is set
  assert.ok(!Object.keys(kv).some((k) => /ignoreSubmodules/i.test(k)), 'the environment must not rely on an ignore setting');
  assert.equal(e['GIT_CONFIG_KEY_0'], 'a.b', 'the existing entries keep their places');
  assert.equal(e['GIT_CONFIG_KEY_2'], 'core.fsmonitor', 'ours start after the existing count');
  for (const bad of ['1e1', '-1', '', ' 2', '0x2', 'abc']) assert.equal(hermeticEnv({ GIT_CONFIG_COUNT: bad }, [])['GIT_CONFIG_KEY_0'], 'core.fsmonitor', `count ${JSON.stringify(bad)} is not a count`);
});

test('hgit: a planted driver is blanked whatever its name (`a=b`, a dotted sub-section, a crafted value); the same status without the blanking runs it', () => {
  for (const [key, attr] of [['filter.a=b.clean', 'a=b'], ['filter.x.y.clean', 'x.y'], ['filter.ck.clean', 'ck']]) {
    const s = scratch();
    try {
      const t = repo(s);
      const cnt = `${s.dir}/COUNT`;
      s.git(t, 'config', key, key === 'filter.ck.clean' ? `echo c >> ${cnt}; cat # .clean x` : `echo c >> ${cnt}; cat`);
      writeFileSync(`${t}/.git/info/attributes`, `* filter=${attr}\n`);
      touch(t);
      s.git(t, 'status', '--porcelain');
      assert.ok(existsSync(cnt), `${key}: the planted driver must run without the blanking (test premise)`);
      rmSync(cnt);
      touch(t);
      const names = repoDrivers('git', [t], () => ({ cwd: t, env: s.env })).names;
      assert.deepEqual(names, [attr]);
      hgit(ctxOf(s, t, names), t, ['status', '--porcelain']);
      assert.ok(!existsSync(cnt), `${key}: the driver ran through hgit`);
    } finally { s.done(); }
  }
});

test('hgit: a core.fsmonitor program of the repository and one in the caller\'s GIT_CONFIG_PARAMETERS never run', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const mark = `${s.dir}/FS`;
    writeFileSync(`${s.dir}/fsm.sh`, `#!/bin/sh\ntouch ${mark}\n`);
    chmodSync(`${s.dir}/fsm.sh`, 0o755);
    s.git(t, 'config', 'core.fsmonitor', `${s.dir}/fsm.sh`);
    touch(t);
    hgit(ctxOf(s, t), t, ['status', '--porcelain']);
    assert.ok(!existsSync(mark), 'the repository\'s monitor ran');
    const c = ctxOf(s, t);
    c.childEnv = () => ({ ...s.env, GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${s.dir}/fsm.sh'` });
    hgit(c, t, ['status', '--porcelain']);
    assert.ok(!existsSync(mark), 'the caller\'s monitor ran');
  } finally { s.done(); }
});

test('S1: a hook of the repository (post-checkout) never runs through hgit', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const mark = `${s.dir}/HOOK`;
    writeFileSync(`${t}/.git/hooks/post-checkout`, `#!/bin/sh\ntouch ${mark}\n`);
    chmodSync(`${t}/.git/hooks/post-checkout`, 0o755);
    writeFileSync(`${t}/f.txt`, 'two\n');
    s.git(t, 'checkout', '-q', '--', 'f.txt');
    assert.ok(existsSync(mark), 'test premise: the hook runs for plain git');
    rmSync(mark);
    writeFileSync(`${t}/f.txt`, 'two\n');
    assert.equal(hgit(ctxOf(s, t), t, ['checkout', '-q', '--', 'f.txt']).status, 0);
    assert.ok(!existsSync(mark), 'the hook ran through hgit');
    assert.equal(readFileSync(`${t}/f.txt`, 'utf8'), 'one\n');
  } finally { s.done(); }
});

test('S1/R3: sbMainPark parks a block-only task file with hooks off, drivers blanked; the body is kept and the file reset', () => {
  const s = scratch();
  try {
    const t = path.join(s.dir, 'r');
    mkdirSync(`${t}/tasks`, { recursive: true });
    s.git(t, 'init', '-q', '-b', 'main');
    const block = (/** @type {string} */ stage) => `# Task\n\nbody\n\n## Proofline Status\n\n<!-- PROOFLINE-STATUS:BEGIN:T1 -->\n- stage: ${stage}\n<!-- PROOFLINE-STATUS:END:T1 -->\n`;
    writeFileSync(`${t}/tasks/T1.md`, block('PLANNED'));
    s.git(t, 'add', '-A');
    s.git(t, 'commit', '-qm', 'task');
    const mark = `${s.dir}/HOOK`; const cnt = `${s.dir}/COUNT`;
    writeFileSync(`${t}/.git/hooks/post-checkout`, `#!/bin/sh\ntouch ${mark}\n`);
    chmodSync(`${t}/.git/hooks/post-checkout`, 0o755);
    s.git(t, 'config', 'filter.ck.clean', `echo c >> ${cnt}; cat`);
    writeFileSync(`${t}/.git/info/attributes`, '* filter=ck\n');
    writeFileSync(`${t}/tasks/T1.md`, block('MERGED'));
    const parked = sbMainPark(ctxOf(s, t, ['ck']), t);
    assert.deepEqual(parked, [{ id: 'T1', body: '- stage: MERGED\n' }]);
    assert.equal(readFileSync(`${t}/tasks/T1.md`, 'utf8'), block('PLANNED'), 'the file is reset');
    assert.ok(!existsSync(mark), 'the post-checkout hook ran');
    assert.ok(!existsSync(cnt), 'a driver ran');
  } finally { s.done(); }
});

test('S2: a checked out submodule\'s own filter driver is not run by a status with submodules ignored, and the gitlink is found', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const sub = `${t}/sub`;
    mkdirSync(sub);
    s.git(sub, 'init', '-q', '-b', 'main');
    writeFileSync(`${sub}/x`, 'x\n');
    s.git(sub, 'add', 'x');
    s.git(sub, 'commit', '-qm', 'x');
    s.git(t, 'add', 'sub');
    s.git(t, 'commit', '-qm', 'sub');
    const cnt = `${s.dir}/COUNT`;
    s.git(sub, 'config', 'filter.ev.clean', `echo c >> ${cnt}; cat`);
    writeFileSync(`${sub}/.gitattributes`, 'x filter=ev\n');
    touch(sub, 'x');
    s.git(t, 'status', '--porcelain');
    assert.ok(existsSync(cnt), 'test premise: a plain status runs the submodule\'s driver');
    rmSync(cnt);
    touch(sub, 'x');
    const c = ctxOf(s, t);
    hgit(c, t, ['status', '--porcelain']);
    assert.ok(!existsSync(cnt), 'the submodule\'s driver ran');
    assert.deepEqual(populatedGitlinks(c, t), ['sub']);
    assert.deepEqual(populatedGitlinks(c, repo(s, 'plain')), []);
  } finally { s.done(); }
});

test('S4: a diff.external program and a textconv of the repository never run, and the real diff is what the risk scan reads', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const mark = `${s.dir}/EXT`;
    writeFileSync(`${s.dir}/ext.sh`, `#!/bin/sh\ntouch ${mark}\necho FORGED\n`);
    chmodSync(`${s.dir}/ext.sh`, 0o755);
    writeFileSync(`${s.dir}/tc.sh`, `#!/bin/sh\ntouch ${mark}\necho FORGED\n`);
    chmodSync(`${s.dir}/tc.sh`, 0o755);
    s.git(t, 'config', 'diff.external', `${s.dir}/ext.sh`);
    s.git(t, 'config', 'diff.tc.textconv', `${s.dir}/tc.sh`);
    writeFileSync(`${t}/.git/info/attributes`, '*.txt diff=tc\n');
    writeFileSync(`${t}/f.txt`, 'one\nadded line\n');
    const added = addedLines(ctxOf(s, t), 'HEAD', ['f.txt']);
    assert.ok(!existsSync(mark), 'a repository program ran');
    assert.deepEqual(added.get('f.txt'), ['added line']);
  } finally { s.done(); }
});

/** A bare origin with one commit on main and the proof repository hermeticFetch makes of it; the project (root) has hostile url, ssh and transport configuration. @param {ReturnType<typeof scratch>} s */
function proofSetup(s) {
  const origin = repo(s, 'origin');
  const root = repo(s, 'proj');
  writeFileSync(`${origin}/g.txt`, 'two\n');
  s.git(origin, 'add', 'g.txt');
  s.git(origin, 'commit', '-qm', 'two');
  const ctx = ctxOf(s, root);
  const hf = hermeticFetch(ctx, 'git', origin, 'main', s.dir); // the proof repository lives in this test's own folder (`<dir>/.cache/proofline-proof`), never in the real home

  assert.ok(hf !== null, 'the proof repository could not be made');
  return { origin, root, ctx, hf };
}

test('S3: the import of the proven tip runs no transport: url.<x>.insteadOf plus core.sshCommand, and plus an ext:: transport, run nothing', () => {
  for (const variant of ['ssh', 'ext']) {
    const s = scratch();
    let hf = null;
    try {
      const p = proofSetup(s);
      hf = p.hf;
      assert.ok(hf.tmp.startsWith(`${s.dir}/`), 'the proof repository must live in the test\'s own folder');
      const mark = `${s.dir}/PWNED`;
      const prefix = `${path.dirname(hf.tmp)}/`;
      if (variant === 'ssh') {
        writeFileSync(`${s.dir}/ssh.sh`, `#!/bin/sh\ntouch ${mark}\nexit 1\n`);
        chmodSync(`${s.dir}/ssh.sh`, 0o755);
        s.git(p.root, 'config', `url.ssh://evil/.insteadOf`, prefix);
        s.git(p.root, 'config', 'core.sshCommand', `${s.dir}/ssh.sh`);
      } else {
        s.git(p.root, 'config', `url.ext::touch ${mark} .insteadOf`, prefix);
        s.git(p.root, 'config', 'protocol.ext.allow', 'always');
      }
      assert.equal(importProvenTip(p.ctx, 'git', p.hf, 'main'), true);
      assert.ok(!existsSync(mark), `${variant}: a program of the project's configuration ran`);
      assert.equal(s.git(p.root, 'rev-parse', 'refs/remotes/origin/main').trim(), p.hf.tip, 'the ref is the proven tip');
      assert.equal(s.git(p.root, 'cat-file', '-t', p.hf.tip).trim(), 'commit');
    } finally { hf?.done(); s.done(); }
  }
});

/** A repository whose committed gitlink `name` is a checked out repository with a planted clean driver (counts into CNT) and a planted diff program (touches EXT). @param {ReturnType<typeof scratch>} s @param {string} name */
function withSubmodule(s, name = 'sub') {
  const t = repo(s);
  const sub = path.join(t, name);
  mkdirSync(sub);
  s.git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(`${sub}/x`, 'x\n');
  s.git(sub, 'add', 'x');
  s.git(sub, 'commit', '-qm', 'x');
  s.git(t, 'add', name);
  s.git(t, 'commit', '-qm', 'sub');
  const cnt = `${s.dir}/COUNT`; const ext = `${s.dir}/EXT`;
  s.git(sub, 'config', 'filter.ev.clean', `echo c >> ${cnt}; cat`);
  writeFileSync(`${s.dir}/ext.sh`, `#!/bin/sh\ntouch ${ext}\n`);
  chmodSync(`${s.dir}/ext.sh`, 0o755);
  s.git(sub, 'config', 'diff.external', `${s.dir}/ext.sh`);
  writeFileSync(`${sub}/.gitattributes`, 'x filter=ev\n');
  return { t, sub, cnt, ext };
}

/** The context of a tree with the drivers of its submodules found, the way deliver-merged does it. @param {ReturnType<typeof scratch>} s @param {string} t @param {string} base */
function blankedCtx(s, t, base = '') {
  const c = ctxOf(s, t, repoDrivers('git', [t], () => ({ cwd: t, env: s.env })).names);
  c.ctpBase = base;
  return c;
}

/** How a per-submodule `ignore=none` is set: in the config, and in an UNTRACKED `.gitmodules` (the key is read from there too). */
const IGNORE_NONE = /** @type {const} */ ([
  ['config', (/** @type {ReturnType<typeof scratch>} */ s, /** @type {string} */ t) => s.git(t, 'config', 'submodule.sub.ignore', 'none')],
  ['.gitmodules', (/** @type {ReturnType<typeof scratch>} */ _s, /** @type {string} */ t) => writeFileSync(`${t}/.gitmodules`, '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n')],
]);

for (const [how, setIgnore] of IGNORE_NONE) {
  test(`R3-1: with submodule.sub.ignore=none (${how}) no git() or hgit call runs the submodule's clean driver: trackedPaths (no base and a base), addedLines, numstat, diffNames, status, add -A`, () => {
    const s = scratch();
    try {
      const { t, sub, cnt } = withSubmodule(s);
      setIgnore(s, t);
      // the premise, git() itself (R3-3: the status path of trackedPaths with an empty base) with no driver found: the driver of the submodule runs, so every call below is a real test
      touch(sub, 'x');
      s.git(t, 'status', '--porcelain');
      assert.ok(existsSync(cnt), 'test premise: trackedPaths without the blanking starts the submodule\'s driver (ignore=none beats any ignore setting)');
      for (const base of ['', 'HEAD']) {
        rmSync(cnt, { force: true });
        touch(sub, 'x');
        trackedPaths(blankedCtx(s, t, base));
        assert.ok(!existsSync(cnt), `trackedPaths(base=${JSON.stringify(base)}) ran the driver`);
      }
      const c = blankedCtx(s, t);
      assert.ok(c.gitBlank.includes('ev'), 'the submodule\'s driver name is found');
      for (const [label, call] of /** @type {Array<[string, () => unknown]>} */ ([
        ['addedLines', () => addedLines(c, 'HEAD', ['sub'])], ['numstat', () => numstat(c, 'HEAD', ['sub'])], ['diffNames', () => diffNames(c, 'HEAD')],
        ['status', () => hgit(c, t, ['--no-optional-locks', '-c', 'status.renames=false', 'status', '--porcelain=v1'])],
        ['git() status', () => git(c, ['status', '--porcelain', '--untracked-files=all'])],
        ['hgit diff HEAD', () => hgit(c, t, ['diff', '--name-only', 'HEAD'])],
        ['git() add -A', () => git(c, ['add', '-A', '--', '.', ':(exclude).agents'])],
      ])) {
        rmSync(cnt, { force: true });
        touch(sub, 'x');
        call();
        assert.ok(!existsSync(cnt), `${label} ran the submodule's driver`);
      }
    } finally { s.done(); }
  });
}

for (const [how, setIgnore] of IGNORE_NONE) {
  for (const withOnce of [true, false]) {
    if (!withOnce && how !== 'config') continue; // the stand-in context without once is one variant, not two
    test(`R4: NO prior discovery (gitBlank empty${withOnce ? '' : ', a context without once'}), ignore=none (${how}): git() status and add -A, hgit status, trackedPaths with a base and addedLines run no submodule driver`, () => {
      const s = scratch();
      try {
        const { t, sub, cnt } = withSubmodule(s);
        setIgnore(s, t);
        const fresh = () => {
          const c = ctxOf(s, t);
          if (!withOnce) delete c.once;
          touch(sub, 'x');
          rmSync(cnt, { force: true });
          return c;
        };
        touch(sub, 'x'); s.git(t, 'status', '--porcelain');
        assert.ok(existsSync(cnt), 'test premise: a plain status runs the submodule\'s driver (ignore=none)');
        for (const [label, call] of /** @type {Array<[string, (c: any) => unknown]>} */ ([
          ['git() status', (c) => git(c, ['status', '--porcelain', '--untracked-files=all'])],
          ['git() add -A', (c) => git(c, ['add', '-A'])],
          ['hgit status', (c) => hgit(c, t, ['status', '--porcelain=v1'])],
          // the module functions all reach git through the same door: one with a base (the diff path) and one that reads lines
          ['trackedPaths(base)', (c) => { c.ctpBase = 'HEAD'; return trackedPaths(c); }], ['addedLines', (c) => addedLines(c, 'HEAD', ['sub'])],
        ]).filter(([l]) => withOnce || /^(git|hgit)/.test(l))) {
          call(fresh());
          assert.ok(!existsSync(cnt), `${label} ran the submodule's driver before any discovery`);
        }
      } finally { s.done(); }
    });
  }
}

test('F2: gitlinks that are symlinks to "." are visited once (by real path), not B^8 times; a bound on the folders fails closed (includes, capped)', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const head = s.git(t, 'rev-parse', 'HEAD').trim();
    for (let i = 0; i < 3; i++) { s.git(t, 'update-index', '--add', '--cacheinfo', `160000,${head},s${i}`); symlinkSync('.', `${t}/s${i}`); }
    const r = repoDrivers('git', [t], () => ({ cwd: t, env: s.env }));
    assert.equal(r.submodules.length, 3, 'each gitlink named once, the tree itself not searched again');
    assert.equal(r.capped, false);
    // the bound: a real nested submodule with room for one folder only
    const s2 = scratch();
    try {
    const { t: t2 } = withSubmodule(s2);
    const c = repoDrivers('git', [t2], () => ({ cwd: t2, env: s2.env }), 1);
    assert.equal(c.capped, true);
    assert.equal(c.includes, true, 'a search that hit its bound fails closed');
    assert.equal(repoDrivers('git', [t2], () => ({ cwd: t2, env: s2.env })).capped, false);
    } finally { s2.done(); }
  } finally { s.done(); }
});

test('R4: indexHasGitlinks reads the index itself: entries of every padding length before the gitlink, a worktree\'s .git file, a repository without one, garbage', () => {
  const s = scratch();
  try {
    const t = repo(s);
    assert.equal(indexHasGitlinks(t), false);
    for (let i = 1; i <= 9; i++) writeFileSync(`${t}/${'n'.repeat(i)}.txt`, `${i}\n`); // names of nine lengths: every padding of the entry
    s.git(t, 'add', '.');
    s.git(t, 'commit', '-qm', 'names');
    assert.equal(indexHasGitlinks(t), false, 'no gitlink among plain files');
    const head = s.git(t, 'rev-parse', 'HEAD').trim();
    s.git(t, 'update-index', '--add', '--cacheinfo', `160000,${head},zz-gitlink`);
    assert.equal(indexHasGitlinks(t), true, 'the gitlink after nine entries of different padding');
    s.git(t, 'worktree', 'add', '-q', '-b', 'w', `${s.dir}/wt`);
    assert.equal(indexHasGitlinks(`${s.dir}/wt`), false, 'a worktree (.git is a file)');
    writeFileSync(`${t}/.git/index`, 'garbage');
    assert.equal(indexHasGitlinks(t), null, 'not understood: git is asked');
    assert.equal(indexHasGitlinks(`${s.dir}/nowhere`), null);
  } finally { s.done(); }
});

test('R4/R5: the lazy discovery is made once per context, tree and state (cached), a changed config is seen without a forget, and ctx.forget drops it', () => {
  const s = scratch();
  try {
    const { t } = withSubmodule(s);
    const memo = new Map();
    let made = 0;
    const c = ctxOf(s, t);
    c.once = (/** @type {string} */ k, /** @type {() => unknown} */ f) => { if (!memo.has(k)) { made += 1; memo.set(k, f()); } return memo.get(k); };
    assert.deepEqual(blankNames(c, t, 'git', s.env), ['ev']);
    assert.deepEqual(blankNames(c, t, 'git', s.env), ['ev']);
    assert.equal(made, 1, 'unchanged state: searched once');
    s.git(t, 'config', 'filter.late.clean', 'cat');
    assert.deepEqual(blankNames(c, t, 'git', s.env).sort(), ['ev', 'late'], 'the config changed: the signature differs, searched again (R5-1)');
    assert.equal(made, 2);
    memo.clear();
    assert.deepEqual(blankNames(c, t, 'git', s.env).sort(), ['ev', 'late'], 'forgotten: searched again');
    assert.equal(made, 3);
    assert.deepEqual(blankNames({ ...c, gitBlank: ['mine'] }, t, 'git', s.env).sort(), ['ev', 'late', 'mine'], 'the names deliver-merged found are kept');
  } finally { s.done(); }
});

test('R3-1: git add -A (the content fingerprint) enters a populated submodule even when every ignore key is set; the blanking stops its driver', () => {
  const s = scratch();
  try {
    const { t, sub, cnt } = withSubmodule(s);
    s.git(t, 'config', 'diff.ignoreSubmodules', 'dirty'); s.git(t, 'config', 'status.ignoreSubmodules', 'dirty');
    touch(sub, 'x');
    s.git(t, 'add', '-A');
    assert.ok(existsSync(cnt), 'test premise: git add -A starts the submodule\'s driver whatever the ignore keys say');
    rmSync(cnt);
    touch(sub, 'x');
    git(ctxOf(s, t), ['add', '-A']); // no prior discovery: git() finds the submodule's drivers itself
    assert.ok(!existsSync(cnt), 'git add -A ran the driver');
  } finally { s.done(); }
});

test('R3-1: a submodule of a submodule is searched too (recursively): its driver, and the folders found', () => {
  const s = scratch();
  try {
    const { t, sub, cnt } = withSubmodule(s);
    const inner = `${sub}/inner`;
    mkdirSync(inner);
    s.git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(`${inner}/y`, 'y\n');
    s.git(inner, 'add', 'y');
    s.git(inner, 'commit', '-qm', 'y');
    const cnt2 = `${s.dir}/COUNT2`;
    s.git(inner, 'config', 'filter.deep.clean', `echo c >> ${cnt2}; cat`);
    writeFileSync(`${inner}/.gitattributes`, 'y filter=deep\n');
    rmSync(`${sub}/.gitattributes`);
    s.git(sub, 'add', 'inner');
    s.git(sub, 'commit', '-qm', 'inner');
    s.git(t, 'add', 'sub');
    s.git(t, 'commit', '-qm', 'sub with inner');
    s.git(t, 'config', 'submodule.sub.ignore', 'none'); s.git(sub, 'config', 'submodule.inner.ignore', 'none');
    touch(inner, 'y');
    s.git(t, 'status', '--porcelain');
    assert.ok(existsSync(cnt2), 'test premise: the nested submodule\'s driver runs without the blanking');
    rmSync(cnt2);
    touch(inner, 'y');
    const found = repoDrivers('git', [t], () => ({ cwd: t, env: s.env }));
    assert.deepEqual(found.names.sort(), ['deep', 'ev']);
    assert.deepEqual(found.submodules, [`${t}/sub`, `${t}/sub/inner`]);
    trackedPaths(blankedCtx(s, t));
    assert.ok(!existsSync(cnt2), 'the nested submodule\'s driver ran');
    assert.ok(!existsSync(cnt));
    // the same tree given twice (main tree and worktree are one) is searched once
    assert.equal(repoDrivers('git', [t, t], () => ({ cwd: t, env: s.env })).submodules.length, 2);
  } finally { s.done(); }
});

test('R3-1: the submodule\'s own core.fsmonitor program never runs (the blanking in the environment reaches the child git)', () => {
  const s = scratch();
  try {
    const { t, sub } = withSubmodule(s);
    const mark = `${s.dir}/FSM`;
    writeFileSync(`${s.dir}/fsm.sh`, `#!/bin/sh\ntouch ${mark}\n`);
    chmodSync(`${s.dir}/fsm.sh`, 0o755);
    s.git(sub, 'config', 'core.fsmonitor', `${s.dir}/fsm.sh`);
    s.git(t, 'config', 'submodule.sub.ignore', 'none');
    s.git(t, 'status', '--porcelain');
    assert.ok(existsSync(mark), 'test premise: a plain status starts the submodule\'s file system monitor');
    rmSync(mark);
    trackedPaths(blankedCtx(s, t));
    git(blankedCtx(s, t), ['add', '-A']);
    assert.ok(!existsSync(mark), 'the submodule\'s monitor ran');
  } finally { s.done(); }
});

/** A signed tip as a hosting service makes it (a commit with a `gpgsig` header written by hand), one ahead of HEAD, with the signature programs of the repository planted. @param {ReturnType<typeof scratch>} s @param {string} fmt */
function withSignedTip(s, fmt) {
  const t = repo(s);
  const tree = s.git(t, 'rev-parse', 'HEAD^{tree}').trim();
  const parent = s.git(t, 'rev-parse', 'HEAD').trim();
  const sig = fmt === 'ssh' ? '-----BEGIN SSH SIGNATURE-----\n U1NIU0lH\n -----END SSH SIGNATURE-----' : fmt === 'x509' ? '-----BEGIN SIGNED MESSAGE-----\n AAAA\n -----END SIGNED MESSAGE-----' : '-----BEGIN PGP SIGNATURE-----\n \n iQEz\n -----END PGP SIGNATURE-----';
  const obj = `tree ${tree}\nparent ${parent}\nauthor t <t@t> 1 +0000\ncommitter GitHub <noreply@github.com> 1 +0000\ngpgsig ${sig}\n\nMerge pull request #1\n`;
  const tip = execFileSync('git', ['-C', t, 'hash-object', '-t', 'commit', '-w', '--stdin'], { env: s.env, input: obj }).toString().trim();
  s.git(t, 'update-ref', 'refs/remotes/origin/main', tip);
  const mark = `${s.dir}/MARK`;
  // The program drains its stdin first: git writes the signed payload to it, and a program that exits unread kills `git log` with SIGPIPE under load (dispatch run 42980221236, gpg.format=ssh).
  writeFileSync(`${s.dir}/p.sh`, `#!/bin/sh\ncat >/dev/null\necho "$0 $*" >> ${mark}\nexit 1\n`);
  chmodSync(`${s.dir}/p.sh`, 0o755);
  s.git(t, 'config', 'merge.verifySignatures', 'true'); s.git(t, 'config', 'log.showSignature', 'true'); s.git(t, 'config', 'gpg.format', fmt);
  for (const k of ['gpg.program', 'gpg.openpgp.program', 'gpg.ssh.program', 'gpg.x509.program']) s.git(t, 'config', k, `${s.dir}/p.sh`);
  writeFileSync(`${s.dir}/allowed`, 't@t ssh-ed25519 AAAA\n');
  s.git(t, 'config', 'gpg.ssh.allowedSignersFile', `${s.dir}/allowed`);
  return { t, tip, mark, parent };
}

for (const fmt of ['openpgp', 'ssh', 'x509']) {
  test(`R3-2: a signed tip (gpg.format=${fmt}) with merge.verifySignatures=true and a signature program in the repository: the ff-only merge succeeds and the program never runs; so do log and an explicit --show-signature`, () => {
    const s = scratch();
    try {
      const { t, tip, mark, parent } = withSignedTip(s, fmt);
      assert.throws(() => s.git(t, 'merge', '--ff-only', '-q', 'refs/remotes/origin/main'));
      assert.ok(existsSync(mark), 'test premise: a plain ff-only merge verifies the signature with the program of the repository');
      rmSync(mark);
      assert.equal(s.git(t, 'rev-parse', 'HEAD').trim(), parent, 'the control did not move HEAD');
      s.git(t, 'log', '-1', 'refs/remotes/origin/main');
      assert.ok(existsSync(mark), 'test premise: a plain log of a signed commit runs the program (log.showSignature)');
      rmSync(mark);
      const c = ctxOf(s, t);
      assert.equal(hgit(c, t, ['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '-q', '--no-overwrite-ignore', 'refs/remotes/origin/main']).status, 0, 'the signed tip is fast-forwarded');
      assert.equal(s.git(t, 'rev-parse', 'HEAD').trim(), tip);
      assert.ok(!existsSync(mark), 'the signature program ran in the merge');
      git(c, ['log', '-1', 'refs/remotes/origin/main']); // the default format is the one log.showSignature changes
      assert.ok(!existsSync(mark), 'the signature program ran in log (log.showSignature)');
      hgit(c, t, ['log', '-1', '--show-signature', 'refs/remotes/origin/main']);
      hgit(c, t, ['verify-commit', 'refs/remotes/origin/main']);
      assert.ok(!existsSync(mark), 'the signature program ran when a signature was asked for explicitly');
    } finally { s.done(); }
  });
}

test('B1: diff.submodule=diff in the repository (a child diff in the submodule) runs no program of the submodule', () => {
  const s = scratch();
  try {
    const { t, sub, ext } = withSubmodule(s);
    s.git(t, 'config', 'diff.submodule', 'diff');
    writeFileSync(`${sub}/x`, 'changed\n');
    s.git(t, 'diff', '-U0', 'HEAD', '--', 'sub');
    assert.ok(existsSync(ext), 'test premise: diff.submodule=diff starts a child diff that runs the submodule\'s program');
    rmSync(ext);
    const c = ctxOf(s, t);
    addedLines(c, 'HEAD', ['sub']);
    hgit(c, t, ['diff', '-U0', 'HEAD', '--', 'sub']);
    assert.ok(!existsSync(ext), 'the child diff ran');
  } finally { s.done(); }
});

test('B1: a moved submodule commit is still reported (the work tree of the submodule is what is not read)', () => {
  const s = scratch();
  try {
    const { t, sub } = withSubmodule(s);
    writeFileSync(`${sub}/y`, 'y\n');
    s.git(sub, 'add', 'y');
    s.git(sub, 'commit', '-qm', 'y');
    const c = ctxOf(s, t);
    c.ctpBase = 'HEAD';
    assert.deepEqual(trackedPaths(c), ['sub']);
  } finally { s.done(); }
});

test('B2: populatedGitlinks finds a non-ASCII submodule path (bytes, not a re-encoded name)', () => {
  const s = scratch();
  try {
    const { t } = withSubmodule(s, 'süb');
    assert.deepEqual(populatedGitlinks(ctxOf(s, t), t), ['süb']);
  } finally { s.done(); }
});

test('B2: submodule.recurse=true in the repository makes a plain switch write the submodule through its smudge driver; through hgit it does not', () => {
  const s = scratch();
  try {
    const { t, sub } = withSubmodule(s);
    writeFileSync(`${t}/.gitmodules`, '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n');
    s.git(t, 'add', '.gitmodules');
    s.git(t, 'commit', '-qm', 'gitmodules');
    const smu = `${s.dir}/SMUDGE`;
    s.git(sub, 'config', 'filter.ev.smudge', `echo s >> ${smu}; cat`);
    writeFileSync(`${sub}/x`, 'v2\n');
    s.git(sub, 'commit', '-qam', 'v2');
    s.git(t, 'switch', '-q', '-c', 'other');
    s.git(t, 'add', 'sub');
    s.git(t, 'commit', '-qm', 'sub v2');
    s.git(t, 'config', 'submodule.recurse', 'true');
    s.git(t, 'config', 'submodule.active', '.');
    rmSync(smu, { force: true });
    s.git(t, 'switch', '-q', 'main');
    assert.ok(existsSync(smu), 'test premise: a recursive switch runs the submodule\'s smudge driver');
    rmSync(smu);
    assert.equal(hgit(ctxOf(s, t), t, ['switch', '-q', '--no-overwrite-ignore', 'other']).status, 0);
    assert.ok(!existsSync(smu), 'the switch through hgit ran the submodule\'s smudge driver');
  } finally { s.done(); }
});

// ---- A248 round 5 ------------------------------------------------------------------------------------------------------------------------------
/** A repository (no gitlink anywhere) whose OWN config has a clean filter that matches every file; returns the tree and the marker. @param {ReturnType<typeof scratch>} s */
function ownFilterRepo(s) {
  const t = repo(s);
  const cnt = `${s.dir}/COUNT`;
  s.git(t, 'config', 'filter.ck.clean', `echo c >> ${cnt}; cat`);
  writeFileSync(`${t}/.git/info/attributes`, '* filter=ck\n');
  touch(t);
  return { t, cnt };
}

test('S1: a tree with NO gitlink and its own clean filter, no prior discovery (gitBlank empty): git(), hgit(), trackedPaths and add -A run that filter nowhere', () => {
  const s = scratch();
  try {
    const { t, cnt } = ownFilterRepo(s);
    s.git(t, 'status', '--porcelain');
    assert.ok(existsSync(cnt), 'test premise: a plain status runs the tree\'s own clean filter');
    assert.equal(indexHasGitlinks(t), false, 'test premise: the tree has no gitlink');
    assert.deepEqual(blankNames(ctxOf(s, t), t, 'git', s.env), ['ck'], 'the tree\'s own driver is found although no gitlink exists');
    for (const [label, call] of /** @type {Array<[string, (c: any) => unknown]>} */ ([
      ['git() status', (c) => git(c, ['status', '--porcelain', '--untracked-files=all'])], ['git() add -A', (c) => git(c, ['add', '-A', '--', '.', ':(exclude).agents'])],
      ['hgit status', (c) => hgit(c, t, ['status', '--porcelain=v1'])], ['trackedPaths', (c) => trackedPaths(c)], ['trackedPaths(base)', (c) => { c.ctpBase = 'HEAD'; return trackedPaths(c); }],
    ])) {
      rmSync(cnt, { force: true });
      touch(t);
      call(ctxOf(s, t));
      assert.ok(!existsSync(cnt), `${label} ran the tree's own clean filter`);
    }
  } finally { s.done(); }
});

test('S1: a linked worktree sees a driver of an includeIf onbranch include that the main tree does not; blankNames asks both trees', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const cnt = `${s.dir}/COUNT`;
    writeFileSync(`${s.dir}/inc.cfg`, `[filter "wk"]\n\tclean = echo c >> ${cnt}; cat\n`);
    s.git(t, 'config', 'includeIf.onbranch:topic.path', `${s.dir}/inc.cfg`);
    writeFileSync(`${s.dir}/inc2.cfg`, '[filter "mn"]\n\tclean = cat\n'); // active in the MAIN tree only (branch main)
    s.git(t, 'config', 'includeIf.onbranch:main.path', `${s.dir}/inc2.cfg`);
    const wt = `${s.dir}/wt`;
    s.git(t, 'worktree', 'add', '-q', '-b', 'topic', wt);
    writeFileSync(`${t}/.git/info/attributes`, '* filter=wk\n');
    const c = ctxOf(s, wt);
    c.sharedMain = () => t;
    assert.equal(indexHasGitlinks(wt), false);
    assert.deepEqual(blankNames(c, wt, 'git', s.env).sort(), ['mn', 'wk'], 'the include of the worktree\'s branch and the one of the main tree (the union of both trees)');
    touch(wt);
    s.git(wt, 'status', '--porcelain');
    assert.ok(existsSync(cnt), 'test premise: a plain status in the worktree runs the include\'s driver');
    rmSync(cnt);
    touch(wt);
    git(c, ['status', '--porcelain']);
    assert.ok(!existsSync(cnt), 'git() ran the include\'s driver in the worktree');
  } finally { s.done(); }
});

test('S1 budget: a tree without drivers, includes and gitlinks starts NO process to find its blanking; a `[filter` or `[include` section, a config.worktree or config in the environment makes it ask git', () => {
  const s = scratch();
  try {
    const t = repo(s);
    proc.resetSpawnCounts();
    assert.deepEqual(blankNames(ctxOf(s, t), t, 'git', s.env), []);
    assert.equal(proc.spawnLog().length, 0, 'a plain repository: the two config files and the index are read, nothing is spawned');
    s.git(t, 'config', 'user.name', 'someone');
    assert.deepEqual(blankNames(ctxOf(s, t), t, 'git', s.env), []);
    assert.equal(proc.spawnLog().length, 0, 'other configuration does not matter');
    for (const [label, key, drop] of [['a filter section', 'filter.q.clean', 'filter.q'], ['an include section', 'include.path', 'include']]) {
      s.git(t, 'config', key, 'cat');
      proc.resetSpawnCounts();
      blankNames(ctxOf(s, t), t, 'git', s.env);
      assert.ok(proc.spawnLog().length > 0, `${label}: git is asked`);
      s.git(t, 'config', '--remove-section', drop);
    }
    proc.resetSpawnCounts();
    blankNames(ctxOf(s, t), t, 'git', { ...s.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.e.clean', GIT_CONFIG_VALUE_0: 'cat' });
    assert.ok(proc.spawnLog().length > 0, 'configuration in the environment (command scope): git is asked');
    writeFileSync(`${t}/.git/config.worktree`, '');
    proc.resetSpawnCounts();
    blankNames(ctxOf(s, t), t, 'git', s.env);
    assert.ok(proc.spawnLog().length > 0, 'a config.worktree: git is asked');
  } finally { s.done(); }
});

test('R5-1: a gitlink that arrives through a switch (cache filled while there was none) is seen by the next call: hgit add -A runs the nested driver nowhere', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const v = `${t}/vendor`;
    mkdirSync(v);
    s.git(v, 'init', '-q', '-b', 'main');
    writeFileSync(`${v}/x`, 'x\n');
    s.git(v, 'add', 'x');
    s.git(v, 'commit', '-qm', 'x');
    const cnt = `${s.dir}/COUNT`;
    s.git(v, 'config', 'filter.ev.clean', `echo c >> ${cnt}; cat`);
    writeFileSync(`${v}/.git/info/attributes`, 'x filter=ev\n');
    // branch o carries the gitlink and a .gitmodules with ignore=none; main has an untracked nested repository there
    s.git(t, 'checkout', '-q', '-b', 'o');
    writeFileSync(`${t}/.gitmodules`, '[submodule "vendor"]\n\tpath = vendor\n\turl = ./vendor\n\tignore = none\n');
    s.git(t, 'add', 'vendor', '.gitmodules');
    s.git(t, 'commit', '-qm', 'vendor');
    s.git(t, 'checkout', '-q', 'main');
    assert.equal(indexHasGitlinks(t), false, 'test premise: no gitlink on main');
    const c = ctxOf(s, t);
    const memo = new Map();
    c.once = (/** @type {string} */ k, /** @type {() => unknown} */ f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); }; // one context for the whole sequence: no forget anywhere
    hgit(c, t, ['status', '--porcelain']);
    assert.deepEqual(blankNames(c, t, 'git', s.env), [], 'cached while there is no gitlink');
    assert.equal(hgit(c, t, ['switch', '-q', 'o']).status, 0);
    assert.equal(indexHasGitlinks(t), true);
    touch(v, 'x');
    rmSync(cnt, { force: true });
    hgit(c, t, ['add', '-A']);
    assert.ok(!existsSync(cnt), 'the nested repository\'s driver ran after the switch brought the gitlink');
    touch(v, 'x');
    s.git(t, 'add', '-A');
    assert.ok(existsSync(cnt), 'test premise: the same add -A, unblanked, runs the nested driver');
  } finally { s.done(); }
});

test('S2: a SHA-256 repository: the gitlink is found whatever the entry count before it (it used to answer false), the nested driver is blanked, no gitlink answers false', () => {
  const s = scratch();
  try {
    const t = path.join(s.dir, 'r256');
    mkdirSync(t);
    s.git(t, 'init', '-q', '--object-format=sha256', '-b', 'main');
    writeFileSync(`${t}/f.txt`, 'one\n');
    s.git(t, 'add', 'f.txt');
    s.git(t, 'commit', '-qm', 'one');
    assert.equal(indexHasGitlinks(t), false, 'one plain file');
    const blob = s.git(t, 'hash-object', '-w', 'f.txt').trim();
    assert.equal(blob.length, 64, 'test premise: the repository is SHA-256');
    const fake = 'a'.repeat(64);
    const load = (/** @type {string} */ info) => {
      s.git(t, 'read-tree', '--empty');
      execFileSync('git', ['-C', t, 'update-index', '--add', '--index-info'], { env: s.env, input: info });
    };
    for (const k of [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 21, 40]) {
      let info = '';
      for (let i = 0; i < k; i++) info += `100644 ${blob} 0\tf${'x'.repeat(i % 9)}${i}\n`;
      load(`${info}160000 ${fake} 0\tzz-gitlink\n`);
      assert.equal(indexHasGitlinks(t), true, `${k} entries before the gitlink`);
      load(info);
      assert.equal(indexHasGitlinks(t), false, `${k} entries, no gitlink`);
    }
    // a nested repository with a clean filter: blanked
    s.git(t, 'read-tree', 'HEAD');
    const v = `${t}/vendor`;
    mkdirSync(v);
    s.git(v, 'init', '-q', '--object-format=sha256', '-b', 'main');
    writeFileSync(`${v}/x`, 'x\n');
    s.git(v, 'add', 'x');
    s.git(v, 'commit', '-qm', 'x');
    s.git(t, 'add', 'vendor');
    const cnt = `${s.dir}/COUNT`;
    s.git(v, 'config', 'filter.ev.clean', `echo c >> ${cnt}; cat`);
    writeFileSync(`${v}/.git/info/attributes`, 'x filter=ev\n');
    s.git(t, 'config', 'submodule.vendor.ignore', 'none');
    assert.equal(indexHasGitlinks(t), true);
    touch(v, 'x');
    s.git(t, 'status', '--porcelain');
    assert.ok(existsSync(cnt), 'test premise: a plain status runs the nested driver');
    rmSync(cnt);
    touch(v, 'x');
    git(ctxOf(s, t), ['status', '--porcelain']);
    assert.ok(!existsSync(cnt), 'git() ran the nested driver of a SHA-256 repository');
  } finally { s.done(); }
});

test('S2/R5-5: an index that is cut, damaged, with an extension that does not fit, a split index or version 4 answers null (ask git), never false', () => {
  const s = scratch();
  try {
    const t = repo(s);
    for (let i = 0; i < 12; i++) writeFileSync(`${t}/p${i}.txt`, `${i}\n`);
    s.git(t, 'add', '.');
    const idx = `${t}/.git/index`;
    const good = readFileSync(idx);
    assert.equal(indexHasGitlinks(t), false);
    // cut at any point, one byte changed in the entries
    for (const n of [good.length - 1, good.length - 20, good.length - 21, Math.floor(good.length / 2), 40]) {
      writeFileSync(idx, good.subarray(0, n));
      assert.equal(indexHasGitlinks(t), null, `cut to ${n} bytes`);
    }
    const bent = Buffer.from(good); bent[70] ^= 0xff;
    writeFileSync(idx, bent);
    assert.equal(indexHasGitlinks(t), null, 'a damaged entry: the checksum does not verify');
    // an extension whose size runs past the file, with a CORRECT checksum
    const seal = (/** @type {Buffer} */ body) => Buffer.concat([body, createHash('sha1').update(body).digest()]);
    const body = good.subarray(0, good.length - 20);
    const ext = Buffer.alloc(8); ext.write('TEST', 0, 'latin1'); ext.writeUInt32BE(0x7fffff00, 4);
    writeFileSync(idx, seal(Buffer.concat([body, ext])));
    assert.equal(indexHasGitlinks(t), null, 'an extension size past the end of the file');
    const ok = Buffer.alloc(8); ok.write('TEST', 0, 'latin1');
    writeFileSync(idx, seal(Buffer.concat([body, ok])));
    assert.equal(indexHasGitlinks(t), false, 'a well formed unknown extension is skipped (control: the verdict is not always null)');
    // a version this reader does not know
    const v5 = Buffer.from(body); v5.writeUInt32BE(5, 4);
    writeFileSync(idx, seal(v5));
    assert.equal(indexHasGitlinks(t), null, 'unknown version');
    writeFileSync(idx, good);
    // a split index keeps its entries in another file
    s.git(t, 'update-index', '--split-index');
    assert.equal(indexHasGitlinks(t), null, 'split index (link extension)');
    s.git(t, 'update-index', '--no-split-index');
    assert.equal(indexHasGitlinks(t), false);
    // a sparse index folds whole directories into one entry: a gitlink may be inside one
    mkdirSync(`${t}/d1`); writeFileSync(`${t}/d1/a.txt`, 'a\n'); s.git(t, 'add', 'd1'); s.git(t, 'commit', '-qm', 'd1');
    s.git(t, 'sparse-checkout', 'init', '--cone', '--sparse-index');
    s.git(t, 'sparse-checkout', 'set', 'nothing');
    assert.ok(readFileSync(idx).includes('sdir'), 'test premise: the index is sparse');
    assert.equal(indexHasGitlinks(t), null, 'sparse index (sdir extension)');
    s.git(t, 'sparse-checkout', 'disable');
    s.git(t, 'update-index', '--no-split-index');
    // version 4 compresses the names
    s.git(t, 'update-index', '--index-version', '4');
    assert.equal(indexHasGitlinks(t), null, 'index version 4');
  } finally { s.done(); }
});

test('R6-1: a `required` driver (git-lfs sets it) does not fail a blanked call: add -A, a worktree checkout and checkout-index succeed and run no program; plain git fails', () => {
  const s = scratch();
  try {
    const t = repo(s);
    const mark = `${s.dir}/MARK`; const prog = `${s.dir}/lfs.sh`;
    writeFileSync(prog, `#!/bin/sh\ntouch ${mark}\ncat\n`);
    chmodSync(prog, 0o755);
    for (const k of ['clean', 'smudge', 'process']) s.git(t, 'config', `filter.lfs.${k}`, prog);
    s.git(t, 'config', 'filter.lfs.required', 'true');
    writeFileSync(`${t}/.git/info/attributes`, '* filter=lfs\n');
    touch(t);
    assert.throws(() => s.git(t, 'add', '-A'), /clean filter|filter/i, 'test premise: plain git fails on a required driver that cannot run');
    touch(t);
    rmSync(mark, { force: true });
    const c = ctxOf(s, t);
    assert.equal(hgit(c, t, ['add', '-A']).status, 0, 'add -A');
    assert.equal(hgit(c, t, ['worktree', 'add', '-q', '--detach', `${s.dir}/wt`, 'HEAD']).status, 0, 'worktree add (checkout)');
    assert.equal(hgit(c, t, ['checkout-index', '-a', '-f', `--prefix=${s.dir}/out/`]).status, 0, 'checkout-index');
    assert.ok(existsSync(`${s.dir}/wt/f.txt`) && existsSync(`${s.dir}/out/f.txt`), 'the files are written');
    assert.ok(!existsSync(mark), 'a program of the driver ran');
  } finally { s.done(); }
});

test('R6-S2: what git sees through hgit has auto-maintenance off and no gc.recentObjectsHook, whatever the repository sets', () => {
  const s = scratch();
  try {
    const t = repo(s);
    // the hook cannot be made to fire in a tiny repository (it needs a cruft pack past its expiry), so the effective configuration git reads is what is pinned
    for (const [k, v] of [['gc.recentObjectsHook', '/bin/echo'], ['gc.auto', '6700'], ['maintenance.auto', 'true'], ['receive.autogc', 'true']]) s.git(t, 'config', k, v);
    const c = ctxOf(s, t);
    const seen = (/** @type {string} */ k) => hgit(c, t, ['config', '--get', k]).stdout.toString().trim();
    assert.equal(s.git(t, 'config', '--get', 'gc.recentObjectsHook').trim(), '/bin/echo', 'test premise: plain git sees the repository\'s hook');
    assert.equal(seen('gc.recentObjectsHook'), '');
    assert.equal(seen('gc.auto'), '0');
    assert.equal(seen('maintenance.auto'), 'false');
    assert.equal(seen('receive.autogc'), 'false');
  } finally { s.done(); }
});
