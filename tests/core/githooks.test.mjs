// @ts-check
// `cli pre-commit` and `cli pre-push` against the shell hooks they replace (control-plane/agents/githooks): the same scenario in two copies
// of one fixture, the shell hook in one and the core subcommand in the other; the refusal text, the status and the stdout must be equal.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { baseEnv, installedFixture } from '../equivalence/fixture.mjs';
import { human } from '../../control-plane/agents/scripts/core/githooks.mjs';

/** @param {string} dir @param {string[]} args @param {Record<string,string>} env @param {string} [input] */
function sh(dir, args, env, input = '') {
  const r = spawnSync(args[0], args.slice(1), { cwd: dir, env: baseEnv(dir, env), input, encoding: 'latin1' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Run the same scenario with the shell hook and with the core. @param {string} hook @param {(dir: string) => void} setup @param {Record<string,string>} env @param {string} [input] */
function both(hook, setup, env, input = '') {
  const res = [];
  for (const engine of ['shell', 'core']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-gh-'));
    try {
      cpSync(installedFixture().dir, dir, { recursive: true });
      sh(dir, ['git', 'config', 'user.email', 'dev@example.org'], {});
      setup(dir);
      const a = engine === 'shell' ? [`${dir}/.agents/githooks/${hook}`] : ['node', `${dir}/.agents/scripts/proofline-core.mjs`, 'cli', hook];
      res.push(sh(dir, a, { PROOFLINE_NO_TTY: '1', ...env }, input));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  assert.deepEqual(res[1], res[0], `${hook}: core and shell hook differ`);
  return res[0];
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
  assert.equal(both('pre-commit', forbid, { GIT_AUTHOR_EMAIL: 'x@corp.example' }).code, 1);
  assert.equal(both('pre-commit', forbid, { GIT_COMMITTER_EMAIL: 'OPS@Legacy.example' }).code, 1);
  assert.equal(both('pre-commit', forbid, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org' }, '').code, 1); // main is protected for an agent
  assert.equal(both('pre-commit', (d) => { forbid(d); sh(d, ['git', 'checkout', '-q', '-b', 'work'], {}); }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org' }).code, 0);
  const r = both('pre-commit', (d) => { forbid(d); sh(d, ['git', 'checkout', '-q', '-b', 'release/1'], {}); }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org', AGENT_ROLE: 'lead' });
  assert.match(r.err, /protected_branches/);
  both('pre-commit', (d) => { forbid(d); sh(d, ['git', 'checkout', '-q', '-b', 'release/1'], {}); }, { GIT_AUTHOR_EMAIL: 'ok@example.org', GIT_COMMITTER_EMAIL: 'ok@example.org', PROOFLINE_NO_TTY: '0' });
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
  assert.match(both('pre-push', on, {}, 'refs/heads/work abc refs/heads/work def\n').err, /no user push approval/);
  assert.equal(both('pre-push', (d) => cfg(d, 'git:\n  push_requires_approval: false\n'), {}, 'refs/heads/work abc refs/heads/work def\n').code, 0);
  assert.equal(both('pre-push', on, {}, '').code, 0);
});
