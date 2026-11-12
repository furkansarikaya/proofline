// @ts-check
// Shared by verify.test.mjs and verify-slow.test.mjs: build a fixture run with the self-test helpers and run agent.sh through either engine.
import { tempDir } from '../lib/tempdir.mjs';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { scriptsDir } from './helpers.mjs';
import { buildRecipe } from '../lib/recipe.mjs';
import { posix } from '../lib/winpath.mjs';

const ENV = {
  PATH: process.env.PATH ?? '', HOME: tmpdir(), LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', PROOFLINE_NO_TTY: '1',
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
};
/** @type {string[]} */ const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** @param {string} snippet */
export function build(snippet) {
  const out = tempDir('pl-vfeq-');
  made.push(out);
  buildRecipe(snippet, out, { errexit: false });   // the Node core is installed beside agent.sh by the harness
  spawnSync('git', ['-C', out, 'config', 'gc.auto', '0']);
  appendFileSync(path.join(out, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n');
  return out;
}

/** @param {string} fx @param {string[]} args @param {'node' | 'sh'} engine @param {Record<string, string>} [env] */
export function exec(fx, args, engine, env = {}) {
  const r = spawnSync('sh', [posix(path.join(fx, '.agents/scripts/agent.sh')), ...args], { cwd: fx, env: { ...ENV, ...env }, encoding: 'latin1', input: '' });
  return { out: r.stdout, err: r.stderr, code: r.status };
}

