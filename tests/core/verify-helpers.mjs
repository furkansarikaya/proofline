// @ts-check
// Shared by verify.test.mjs and verify-slow.test.mjs: build a fixture run with the self-test helpers and run agent.sh through either engine.
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { scriptsDir } from './helpers.mjs';

const ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};
/** @type {string[]} */ const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** @param {string} snippet */
export function build(snippet) {
  const out = mkdtempSync(path.join(tmpdir(), 'pl-vfeq-'));
  made.push(out);
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${snippet}\ncp -R "$PWD/." "$EQ_OUT/"`, path.join(scriptsDir, 'x.sh')],
    { env: { ...ENV, EQ_LIB: path.join(scriptsDir, 'test-lib.sh'), EQ_OUT: out }, encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) throw new Error(`fixture failed: ${snippet}\n${r.stderr}${r.stdout}`);
  cpSync(path.join(scriptsDir, 'proofline-core.mjs'), path.join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scriptsDir, 'core'), path.join(out, '.agents/scripts/core'), { recursive: true });
  spawnSync('git', ['-C', out, 'config', 'gc.auto', '0']);
  appendFileSync(path.join(out, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n');
  return out;
}

/** @param {string} fx @param {string[]} args @param {'node' | 'sh'} engine @param {Record<string, string>} [env] */
export function exec(fx, args, engine, env = {}) {
  const r = spawnSync('sh', [path.join(fx, '.agents/scripts/agent.sh'), ...args], { cwd: fx, env: { ...ENV, ...(engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), ...env }, encoding: 'latin1', input: '' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

