// @ts-check
// A248 (Part of #165): the hermetic git helper, on tiny throwaway repositories (milliseconds each, no delivery chain). A planted driver counts its runs into a file; a planted
// hook, difftool, submodule configuration, url rewrite and ssh command touch a marker. Nothing waits, nothing reads the clock; every repository is unique and removed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hermeticFetch, importProvenTip, sbMainPark } from '../../control-plane/agents/scripts/core/deliver.mjs';
import { hermeticEnv, hgit, parseDrivers, populatedGitlinks, repoDrivers } from '../../control-plane/agents/scripts/core/hgit.mjs';
import { addedLines, diffNames, ensureBlank, git, numstat, trackedPaths } from '../../control-plane/agents/scripts/core/git.mjs';

const FIXED = new Date(Date.UTC(2031, 0, 2, 3, 4, 5));
const nul = (/** @type {string[]} */ ...f) => `${f.join('\0')}\0`;
const ENV = (/** @type {string} */ home) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2031-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2031-01-02T03:04:05Z' });

/** A unique scratch folder with a runner for plain git. @returns {{ dir: string, env: Record<string, string>, git: (cwd: string, ...a: string[]) => string, done: () => void }} */
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hgit-'));
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
    assert.deepEqual(repoDrivers('git', [t, wt], where), { names: ['inc'], includes: true, submodules: [] });
  } finally { s.done(); }
});

test('hermeticEnv: blanks each name as a key (so `=` is fine), keeps a count the environment already has, drops GIT_CONFIG_PARAMETERS, turns hooks and the monitor off', () => {
  const e = hermeticEnv({ PATH: '/x', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/evil'" }, ['a=b']);
  assert.equal(e['GIT_CONFIG_PARAMETERS'], undefined);
  assert.equal(e['GIT_CONFIG_KEY_0'], 'a.b');
  assert.equal(e['GIT_CONFIG_KEY_1'], 'c.d');
  /** @type {Record<string, string>} */ const kv = {};
  for (let k = 0; k < Number(e['GIT_CONFIG_COUNT']); k++) kv[/** @type {string} */ (e[`GIT_CONFIG_KEY_${k}`])] = /** @type {string} */ (e[`GIT_CONFIG_VALUE_${k}`]);
  assert.equal(e['GIT_CONFIG_COUNT'], '18');
  assert.deepEqual(kv, { 'a.b': '1', 'c.d': '2', 'core.fsmonitor': 'false', 'diff.submodule': 'short', 'submodule.recurse': 'false',
    'merge.verifySignatures': 'false', 'log.showSignature': 'false', 'commit.gpgSign': 'false', 'tag.gpgSign': 'false', 'gpg.program': '', 'gpg.openpgp.program': '', 'gpg.ssh.program': '', 'gpg.x509.program': '',
    'gpg.ssh.defaultKeyCommand': '', 'core.hooksPath': '/dev/null', 'filter.a=b.clean': '', 'filter.a=b.smudge': '', 'filter.a=b.process': '' });
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
      trackedPaths(ctxOf(s, t));
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

test('R3-1: git add -A (the content fingerprint) enters a populated submodule even when every ignore key is set; the blanking stops its driver', () => {
  const s = scratch();
  try {
    const { t, sub, cnt } = withSubmodule(s);
    s.git(t, 'config', 'diff.ignoreSubmodules', 'dirty'); s.git(t, 'config', 'status.ignoreSubmodules', 'dirty');
    touch(sub, 'x');
    git(ctxOf(s, t), ['add', '-A']);
    assert.ok(existsSync(cnt), 'test premise: git add -A starts the submodule\'s driver whatever the ignore keys say');
    rmSync(cnt);
    touch(sub, 'x');
    const c = ctxOf(s, t);
    ensureBlank(c);
    git(c, ['add', '-A']);
    assert.ok(!existsSync(cnt), 'git add -A after ensureBlank ran the driver');
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
    trackedPaths(ctxOf(s, t));
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
  writeFileSync(`${s.dir}/p.sh`, `#!/bin/sh\necho "$0 $*" >> ${mark}\nexit 1\n`);
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
