// @ts-check
// Runs the e2e harness for the tests: E2E_RUNNER (a command line, e.g. `node tests/e2e/run.mjs`) replaces the default runner, `node tests/e2e/run.mjs`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const here = import.meta.dirname;
export const repo = path.resolve(here, '../..');

/**
 * @param {string[]} args @param {Record<string, string | undefined>} env extra environment (undefined removes a variable)
 * @returns {{ status: number | null, out: string }} stdout and stderr together
 */
export function runE2e(args, env = {}) {
  const custom = process.env.E2E_RUNNER ? process.env.E2E_RUNNER.split(' ') : null;
  const [cmd, ...pre] = custom ?? [process.execPath, path.join(here, 'run.mjs')];
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(/** @type {string} */ (cmd), [...pre.map((x) => (x.startsWith('tests/') ? path.join(repo, x) : x)), ...args], { cwd: repo, env: /** @type {NodeJS.ProcessEnv} */ (e), encoding: 'utf8', timeout: 300000 });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
