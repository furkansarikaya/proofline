// @ts-check
// githooks-test.sh (176-D3) as a Node test: the git hooks in throwaway repositories with a stub agent.sh, driven by real `git commit` and `git push`. The shell
// test ran the PRE-STAGE-3 shell hooks (tests/legacy-githooks, the specification the core replaced); the product's hooks are launchers of the core
// (`cli pre-commit|pre-push`), so this test runs the CORE logic (core/githooks.mjs: A207, ADR 0001 section 5.4) and keeps every scenario, message and
// assertion of the shell test. The run commands the hooks ask (open-runs, delivery-check, fingerprint, approval-consume) are answered by the same stub
// agent.sh as before: the hook here is a tiny Node program that builds the core's Context with a runner that calls the stub (the real runner would answer
// in process with the project's real run records, which the stub stands in for). A last test runs the SHIPPED launchers against the real core.
// Never touches global or system git config (GIT_CONFIG_GLOBAL/NOSYSTEM, per-command -c only). Git 2.39 and dash are fine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { repo, scripts, tmp } from '../lib/harness.mjs';

const STUB = `#!/bin/sh
st=$(dirname "$0")/../local/stub
echo "$*" >> "$st/calls.log"
case "$1" in
  open-runs) if [ -f "$st/active" ]; then echo "$(cat "$st/active") proofline/T-1-x"; fi ;;
  delivery-check) [ -f "$st/gates_ok" ] ;;
  fingerprint) if [ "\${3:-}" = full ]; then echo fp-full-456; else echo fp-123; fi ;;
  approval-consume) [ -f "$st/approve_$3" ] && rm "$st/approve_$3" ;;
esac
`;
const core = (/** @type {string} */ f) => pathToFileURL(path.join(scripts, 'core', f)).href;
/** The hook: the core's pre-commit / pre-push logic with a runner that asks the stub agent.sh. */
const HOOK = (/** @type {string} */ hook, /** @type {string} */ root) => `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Context } from '${core('context.mjs')}';
import { ${hook === 'pre-push' ? 'prePush' : 'preCommit'} } from '${core('githooks.mjs')}';
const scriptPath = ${JSON.stringify(path.join(root, '.agents/scripts/agent.sh'))};
const io = { env: process.env, cwd: process.cwd(), stdout: { write: (b) => process.stdout.write(b) }, stderr: { write: (b) => process.stderr.write(b) }, scriptPath, isProcess: true };
const ctx = new Context(io, scriptPath);
ctx.runner = (argv, rio) => { const r = spawnSync('sh', [scriptPath, ...argv], { cwd: ctx.cwd, env: ctx.env }); rio.stdout.write(r.stdout); rio.stderr.write(r.stderr); return r.status ?? 1; };
const code = ${hook === 'pre-push' ? "prePush(ctx, readFileSync(0, 'latin1'))" : 'preCommit(ctx)'};
ctx.flush();
process.exitCode = code;
`;

const BASE_ENV = { PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', TMPDIR: process.env.TMPDIR ?? tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PROOFLINE_NO_TTY: '1' };
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args, /** @type {Record<string, string>} */ env = BASE_ENV) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });

test('git hooks: identity guard, protected branches, push approval, open runs, human detection, copied files (A169, A185, A207)', () => {
  const root = tmp('gh'); const r = path.join(root, 'repo'); const remote = path.join(root, 'remote.git'); const st = path.join(r, '.agents/local/stub');
  let email = 'alice@example.org';
  /** @param {string[]} args @param {Record<string, string>} [env] */
  const g = (args, env = BASE_ENV) => git(r, ['-c', 'core.hooksPath=.agents/githooks', '-c', 'user.name=Test', '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', ...args], env);
  let rc = 0; let out = '';
  /** try: run git, keep status and the text of both streams (the hook speaks on stderr). @param {string[]} args @param {Record<string, string>} [env] */
  const attempt = (args, env = BASE_ENV) => { const x = g(args, env); rc = x.status ?? 1; out = (x.stdout ?? '') + (x.stderr ?? ''); };
  const commit = (/** @type {string} */ m) => { appendFileSync(path.join(r, 'file.txt'), `${m}\n`); g(['add', 'file.txt']); attempt(['commit', '-q', '-m', m]); };
  const said = (/** @type {string} */ pat) => new RegExp(pat).test(out);
  const calls = () => readFileSync(path.join(st, 'calls.log'), 'utf8');
  const touch = (/** @type {string} */ f) => writeFileSync(path.join(st, f), '');
  const rmf = (/** @type {string} */ f) => rmSync(path.join(st, f), { force: true });

  mkdirSync(r, { recursive: true }); git(r, ['init', '-q', '-b', 'work']);
  if (git(root, ['clone', '-q', '--bare', r, remote]).status !== 0) git(root, ['init', '-q', '--bare', remote]);
  mkdirSync(path.join(r, '.agents/scripts'), { recursive: true }); mkdirSync(path.join(r, '.agents/runs/T-1'), { recursive: true }); mkdirSync(st, { recursive: true }); mkdirSync(path.join(r, '.agents/githooks'), { recursive: true });
  for (const h of ['pre-commit', 'pre-push']) { writeFileSync(path.join(r, '.agents/githooks', h), HOOK(h, r)); chmodSync(path.join(r, '.agents/githooks', h), 0o755); }
  const cfgPath = path.join(r, '.agents/config.yaml');
  writeFileSync(cfgPath, 'git:\n  protected_branches: main release/*\n  push_requires_approval: true\n  forbidden_identities: *@example-corp.com ^ops@legacy-corp\\.example$\n');
  writeFileSync(path.join(r, '.agents/scripts/agent.sh'), STUB); chmodSync(path.join(r, '.agents/scripts/agent.sh'), 0o755);
  writeFileSync(path.join(r, '.agents/runs/T-1/RUN.yaml'), 'repository:\n  task_branch: proofline/T-1-x\n');
  writeFileSync(path.join(r, '.gitignore'), '.agents/local/\n.agents/runs/\n');
  g(['add', '-A']); g(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init']);
  g(['remote', 'add', 'origin', remote]);

  email = 'dev@example-corp.com'; commit('a'); email = 'alice@example.org';
  assert.ok(rc !== 0 && said('git.forbidden_identities'), 'forbidden author identity blocked');
  assert.ok(!said('example-corp'), 'block message never prints the patterns');
  email = 'OPS@Legacy-Corp.example'; commit('a2'); email = 'alice@example.org';
  assert.notEqual(rc, 0, 'forbidden identity by case-insensitive ERE blocked');
  appendFileSync(path.join(r, 'file.txt'), 'b\n'); g(['add', 'file.txt']);
  attempt(['commit', '-q', '-m', 'b'], { ...BASE_ENV, GIT_COMMITTER_EMAIL: 'dev@example-corp.com' });
  assert.ok(rc !== 0 && said('committer'), 'forbidden committer identity blocked');
  // added (the shell test set author and committer to the same address, so the author check alone was never isolated): only the author is forbidden
  appendFileSync(path.join(r, 'file.txt'), 'b2\n'); g(['add', 'file.txt']);
  attempt(['commit', '-q', '-m', 'b2'], { ...BASE_ENV, GIT_AUTHOR_EMAIL: 'dev@example-corp.com' });
  assert.ok(rc !== 0 && said('author email'), `forbidden author identity alone blocked (${out})`);
  commit('c');
  assert.equal(rc, 0, `allowed identity commits (${out})`);

  g(['checkout', '-q', '-b', 'release/1']); commit('d');
  assert.ok(rc !== 0 && said('protected_branches'), 'protected branch commit blocked');
  g(['checkout', '-q', 'work']);

  g(['branch', 'side']); attempt(['push', '-q', 'origin', 'side']);
  assert.ok(rc !== 0 && said('push_requires_approval'), 'push without approval blocked');
  assert.match(calls(), /^approval-consume - push /m, "outside a run the push approval is asked with '-'");
  touch('approve_push'); attempt(['push', '-q', 'origin', 'work']);
  assert.ok(rc === 0 && !existsSync(path.join(st, 'approve_push')), `push with approval passes and consumes it (${out})`);
  assert.match(calls(), /^approval-consume - push {2}refs\/heads\/work$/m, 'the push approval is asked with the remote ref (A169)');
  touch('approve_push'); attempt(['push', '-q', 'origin', 'work:main']);
  assert.ok(rc !== 0 && said('protected_branches'), 'push to a protected branch blocked even with approval');
  writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace('push_requires_approval: true', 'push_requires_approval: false'));
  g(['add', '.agents/config.yaml']); g(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'cfg']);
  rmf('approve_push'); commit('e'); attempt(['push', '-q', 'origin', 'work']);
  assert.equal(rc, 0, 'push_requires_approval false needs no approval');

  writeFileSync(path.join(st, 'active'), 'T-1\n');
  commit('f');
  assert.ok(rc !== 0 && said('task branch'), 'active run: commit off the task branch blocked');
  g(['checkout', '-q', '-b', 'proofline/T-1-x']);
  commit('g');
  assert.ok(rc !== 0 && said('delivery-ready'), 'active run: commit without passing gates blocked');
  touch('gates_ok'); commit('h');
  assert.ok(rc !== 0 && said('commit approval'), 'active run: commit without approval blocked');
  touch('approve_commit'); writeFileSync(path.join(r, 'other.txt'), 'partial\n'); commit('i');
  assert.ok(rc !== 0 && said('exactly the gated content'), 'active run: untracked content outside the commit blocked');
  rmSync(path.join(r, 'other.txt'), { force: true }); commit('j');
  assert.ok(rc === 0 && !existsSync(path.join(st, 'approve_commit')) && /^approval-consume T-1 commit fp-full-456/m.test(calls()),
    `active run: the commit approval is bound to the full content fingerprint, as approve delivery records it (${out})`);
  email = 'dev@example-corp.com'; touch('approve_commit'); commit('k'); email = 'alice@example.org';
  assert.ok(rc !== 0 && said('forbidden_identities'), 'identity guard applies inside a run too');

  // open runs come from `agent.sh open-runs` (never ACTIVE_RUN): only the run's task branch is pushed
  g(['branch', 'side']); attempt(['push', '-q', 'origin', 'side']);
  assert.ok(rc !== 0 && said('only its task branch'), `open run: push of another branch blocked (${out})`);
  attempt(['push', '-q', 'origin', 'proofline/T-1-x']);
  assert.equal(rc, 0, `open run: push of its task branch passes (${out})`);
  assert.ok(!/^status/m.test(calls()), 'hooks never consult ACTIVE_RUN (agent.sh status)');

  // human detection: agent session markers decide, never a terminal (these runs have no TTY)
  rmf('active'); g(['reset', '-q', '--hard']); g(['checkout', '-q', 'work']);
  writeFileSync(cfgPath, readFileSync(cfgPath, 'utf8').replace('push_requires_approval: false', 'push_requires_approval: true'));
  g(['add', '.agents/config.yaml']); g(['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'cfg2']);
  const CLEAN = ['PROOFLINE_NO_TTY', 'AGENT_ROLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];
  /** @param {string} ref @param {string} [marker] KEY=VALUE */
  const hpush = (ref, marker) => {
    /** @type {Record<string, string>} */ const env = { ...BASE_ENV }; for (const k of CLEAN) delete env[k];
    if (marker) { const [k, ...v] = marker.split('='); env[k] = v.join('='); }
    const x = git(r, ['-c', 'core.hooksPath=.agents/githooks', 'push', '-q', 'origin', ref], env); rc = x.status ?? 1; out = (x.stdout ?? '') + (x.stderr ?? '');
  };
  writeFileSync(path.join(st, 'calls.log'), '');
  hpush('work:human-a');
  assert.ok(rc === 0 && !/approval-consume/.test(calls()), `no TTY and no markers: push passes as a human, no approval asked (${out})`);
  hpush('work:release/h');
  assert.equal(rc, 0, `no TTY and no markers: a human may push a protected branch (${out})`);
  for (const m of ['AGENT_ROLE=lead', 'CLAUDECODE=1', 'CLAUDE_CODE_ENTRYPOINT=cli', 'CLAUDE_CODE_SESSION_ID=x', 'CODEX_CI=1', 'CODEX_SANDBOX=seatbelt', 'CODEX_THREAD_ID=x', 'CODEX_SESSION_ID=x', 'PROOFLINE_NO_TTY=1']) {
    rmf('approve_push'); hpush('work:agent-a', m);
    assert.ok(rc !== 0 && said('no user push approval'), `marker ${m}: push blocked without approval`);
    touch('approve_push'); hpush(`work:release/${m.split('=')[0]}`, m);
    assert.ok(rc !== 0 && said('protected_branches'), `marker ${m}: protected branch push blocked`);
  }
  rmf('approve_push'); touch('approve_push'); hpush('work:agent-b', 'CLAUDECODE=1');
  assert.equal(rc, 0, `marker present: push with approval passes (${out})`);

  // A185: a local file proofline copied into a run worktree (listed in .agents/local/worktree-copied) never enters a commit, even with add -f
  writeFileSync(path.join(r, '.env.copied'), 'K=1\n'); writeFileSync(path.join(r, '.agents/local/worktree-copied'), '.env.copied\n');
  g(['add', '-f', '.env.copied']); attempt(['commit', '-q', '-m', 'envfile']);
  assert.ok(rc !== 0 && said('worktree.copy_files'), `copied local file: commit refused (add -f included) (${out})`);
  rmSync(path.join(r, '.agents/local/worktree-copied'), { force: true }); attempt(['commit', '-q', '-m', 'envfile2']);
  assert.equal(rc, 0, `a file not in the copied list commits as before (${out})`);
});

// The shipped launchers (control-plane/agents/githooks) in front of the real core: the identity guard blocks, an allowed identity commits.
test('git hooks: the shipped launchers run the core (a forbidden identity is blocked, another one commits)', () => {
  const r = tmp('gl');
  git(r, ['init', '-q', '-b', 'work']);
  mkdirSync(path.join(r, '.agents/scripts'), { recursive: true });
  cpSync(path.join(repo, 'control-plane/agents/githooks'), path.join(r, '.agents/githooks'), { recursive: true });
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(r, '.agents/scripts/proofline-core.mjs')); cpSync(path.join(scripts, 'core'), path.join(r, '.agents/scripts/core'), { recursive: true });
  writeFileSync(path.join(r, '.agents/config.yaml'), 'git:\n  forbidden_identities: *@example-corp.com\n');
  writeFileSync(path.join(r, 'f.txt'), 'x\n'); git(r, ['add', 'f.txt']);
  const c = (/** @type {string} */ mail) => git(r, ['-c', 'core.hooksPath=.agents/githooks', '-c', 'user.name=T', '-c', `user.email=${mail}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x']);
  const bad = c('dev@example-corp.com');
  assert.notEqual(bad.status, 0, 'the shipped pre-commit let a forbidden identity commit'); assert.ok(bad.stderr.includes('git.forbidden_identities'), bad.stderr);
  const good = c('alice@example.org');
  assert.equal(good.status, 0, `the shipped pre-commit blocked an allowed identity: ${good.stderr}`);
});
