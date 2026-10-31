// @ts-check
// A fixture project for the library tests: a git repository with the shipped control plane installed (so agent.sh runs against it) and a
// Context over it. Every call makes its own tree (tests run in parallel; no shared mutable fixture).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { repo } from './helpers.mjs';

const GIT_ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fx', GIT_AUTHOR_EMAIL: 'fx@example.invalid', GIT_COMMITTER_NAME: 'fx', GIT_COMMITTER_EMAIL: 'fx@example.invalid',
};

/** @param {string} root @param {string[]} args */
export function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { env: GIT_ENV, encoding: 'latin1' });
  return r.stdout;
}

/** A committed repository with the control plane in .agents. @returns {{ root: string, agent: string, ctx: () => Context, sh: (args: string[], env?: Record<string,string>) => { out: string, err: string, code: number | null } }} */
export function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pl-lib-'));
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  cpSync(path.join(repo, 'control-plane', 'agents'), path.join(root, '.agents'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', root], { env: GIT_ENV });
  git(root, ['config', 'gc.auto', '0']);
  writeFileSync(path.join(root, 'README.md'), 'hello\n');
  writeFileSync(path.join(root, '.gitignore'), '.agents/local/\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  const agent = path.join(root, '.agents', 'scripts', 'agent.sh');
  const env = () => ({ ...GIT_ENV, PROOFLINE_ENGINE: 'sh' });
  return {
    root, agent,
    ctx: () => {
      const io = { env: { ...GIT_ENV }, cwd: root, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: agent };
      return new Context(io, agent);
    },
    sh: (args, extra = {}) => {
      const r = spawnSync('sh', [agent, ...args], { cwd: root, env: { ...env(), ...extra }, encoding: 'latin1' });
      return { out: r.stdout, err: r.stderr, code: r.status };
    },
  };
}
