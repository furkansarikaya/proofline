// @ts-check
// `cli pre-commit` and `cli pre-push` (the shipped hooks of control-plane/agents/githooks are launchers of these): the refusal text, the status and the stdout of each scenario.
// Until A244 every scenario also ran the pre-stage-3 shell hooks (tests/legacy-githooks) in a second copy and compared the two; the legacy hooks are retired and the text they
// shared with the core is asserted here as it is.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { baseEnv, installedFixture } from './lib/fixture.mjs';
import { human } from '../../control-plane/agents/scripts/core/githooks.mjs';

/** @param {string} dir @param {string[]} args @param {Record<string,string>} env @param {string} [input] */
function sh(dir, args, env, input = '') {
  const r = spawnSync(args[0], args.slice(1), { cwd: dir, env: baseEnv(dir, env), input, encoding: 'latin1' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The core's hook subcommand in a copy of the fixture, after the setup. @param {string} hook @param {(dir: string) => void} setup @param {Record<string,string>} env @param {string} [input] */
function both(hook, setup, env, input = '') {
  const dir = tempDir('pl-gh-');
  try {
    cpSync(installedFixture().dir, dir, { recursive: true });
    sh(dir, ['git', 'config', 'user.email', 'dev@example.org'], {});
    setup(dir);
    const r = sh(dir, ['node', `${dir}/.agents/scripts/proofline-core.mjs`, 'cli', hook], { PROOFLINE_NO_TTY: '1', ...env }, input);
    return r;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const cfg = (/** @type {string} */ dir, /** @type {string} */ text) => writeFileSync(`${dir}/.agents/config.yaml`, text);

test('human(): any agent marker makes it an agent; PROOFLINE_NO_TTY=1 forces agent', () => {
  assert.equal(human({}), true);
  assert.equal(human({ PROOFLINE_NO_TTY: '1' }), false);
  for (const k of ['AGENT_ROLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) assert.equal(human({ [k]: 'x' }), false, k);
  assert.equal(human({ CLAUDECODE: '' }), true);
});

test('pre-commit: identity guard, protected branch, copied files, no open run', () => {
  const forbid = (/** @type {string} */ d) => cfg(d, 'git:\n  forbidden_identities: *@corp.example ^ops@legacy\\.example$\n  protected_branches: main release/*\n');
  const author = both('pre-commit', forbid, { GIT_AUTHOR_EMAIL: 'x@corp.example' });
  assert.deepEqual([author.code, author.out, author.err], [1, '', 'proofline pre-commit: BLOCKED: the author email matches git.forbidden_identities in .agents/config.yaml; set a repository-local identity (git config user.email ...)\n']);
  const committer = both('pre-commit', forbid, { GIT_COMMITTER_EMAIL: 'OPS@Legacy.example' });
  assert.deepEqual([committer.code, committer.out, committer.err], [1, '', 'proofline pre-commit: BLOCKED: the committer email matches git.forbidden_identities in .agents/config.yaml; set a repository-local identity\n']);
  const onMain = both('pre-commit', forbid, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org' }, ''); // main is protected for an agent
  assert.deepEqual([onMain.code, onMain.out, onMain.err], [1, '', "proofline pre-commit: BLOCKED: branch 'main' is listed in git.protected_branches; agents never commit there\n"]);
  const onWork = both('pre-commit', (d) => { forbid(d); sh(d, ['git', 'checkout', '-q', '-b', 'work'], {}); }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org' });
  assert.deepEqual([onWork.code, onWork.out, onWork.err], [0, '', '']);
  const r = both('pre-commit', (d) => { forbid(d); sh(d, ['git', 'checkout', '-q', '-b', 'release/1'], {}); }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org', AGENT_ROLE: 'lead' });
  assert.match(r.err, /protected_branches/);
  const human_ = both('pre-commit', (d) => { forbid(d); sh(d, ['git', 'checkout', '-q', '-b', 'release/1'], {}); }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org', PROOFLINE_NO_TTY: '0' });
  assert.deepEqual([human_.code, human_.out, human_.err], [0, '', ''], 'a human commits on a protected branch');
  const copied = both('pre-commit', (d) => {
    sh(d, ['git', 'checkout', '-q', '-b', 'work'], {}); mkdirSync(`${d}/.agents/local`, { recursive: true });
    writeFileSync(`${d}/.env`, 'X=1\n'); writeFileSync(`${d}/.agents/local/worktree-copied`, '.env\n'); sh(d, ['git', 'add', '-f', '.env'], {});
  }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org' });
  assert.match(copied.err, /local file copied into this worktree/);
});

test('pre-push: protected refs, no run, approval switch', () => {
  const refs = 'refs/heads/work abc refs/heads/main def\n';
  const on = (/** @type {string} */ d) => cfg(d, 'git:\n  protected_branches: main\n  push_requires_approval: true\n');
  assert.match(both('pre-push', on, {}, refs).err, /protected_branches/);
  assert.equal(both('pre-push', on, { PROOFLINE_NO_TTY: '0' }, refs).code, 0); // a human may push to a protected branch
  const noApproval = both('pre-push', on, {}, 'refs/heads/work abc refs/heads/work def\n');
  assert.equal(noApproval.code, 1);
  assert.match(noApproval.err, /^no unconsumed push approval bound to [0-9a-f]{40} for -\nproofline pre-push: BLOCKED: git\.push_requires_approval: no user push approval\n$/);
  assert.deepEqual(['code', 'out', 'err'].map((k) => /** @type {any} */ (both('pre-push', (d) => cfg(d, 'git:\n  push_requires_approval: false\n'), {}, 'refs/heads/work abc refs/heads/work def\n'))[k]), [0, '', '']);
  assert.equal(both('pre-push', on, {}, '').code, 0);
});
