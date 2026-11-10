// @ts-check
// A248 (Part of #165): the hermetic git helper, on tiny throwaway repositories (milliseconds each, no delivery chain). A planted driver counts its runs into a file; a planted
// hook, difftool, submodule configuration, url rewrite and ssh command touch a marker. Nothing waits, nothing reads the clock; every repository is unique and removed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { hermeticFetch, importProvenTip, sbMainPark } from '../../control-plane/agents/scripts/core/deliver.mjs';
import { hermeticEnv, hgit, parseDrivers, populatedGitlinks, repoDrivers } from '../../control-plane/agents/scripts/core/hgit.mjs';
import { addedLines } from '../../control-plane/agents/scripts/core/git.mjs';

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
const ctxOf = (/** @type {ReturnType<typeof scratch>} */ s, /** @type {string} */ root, /** @type {string[]} */ blank = []) => /** @type {any} */ ({ cwd: root, root, env: s.env, gitBlank: blank, childEnv: () => s.env, once: (/** @type {string} */ _k, /** @type {() => unknown} */ f) => f(), sharedMain: () => root });
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
    assert.deepEqual(repoDrivers('git', [t, wt], where), { names: ['inc'], includes: true });
  } finally { s.done(); }
});

test('hermeticEnv: blanks each name as a key (so `=` is fine), keeps a count the environment already has, drops GIT_CONFIG_PARAMETERS, turns hooks and the monitor off', () => {
  const e = hermeticEnv({ PATH: '/x', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/evil'" }, ['a=b']);
  assert.equal(e['GIT_CONFIG_PARAMETERS'], undefined);
  assert.equal(e['GIT_CONFIG_KEY_0'], 'a.b');
  assert.equal(e['GIT_CONFIG_KEY_1'], 'c.d');
  assert.equal(e['GIT_CONFIG_KEY_2'], 'core.fsmonitor');
  assert.equal(e['GIT_CONFIG_VALUE_2'], 'false');
  assert.equal(e['GIT_CONFIG_KEY_3'], 'core.hooksPath');
  assert.deepEqual(['clean', 'smudge', 'process'].map((v, i) => [e[`GIT_CONFIG_KEY_${4 + i}`], e[`GIT_CONFIG_VALUE_${4 + i}`]]), [['filter.a=b.clean', ''], ['filter.a=b.smudge', ''], ['filter.a=b.process', '']]);
  assert.equal(e['GIT_CONFIG_COUNT'], '7');
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
  ctx.env = { ...s.env, HOME: homedir() }; // the proof repository lives in the account's cache, like in production
  const hf = hermeticFetch(ctx, 'git', origin, 'main');
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
