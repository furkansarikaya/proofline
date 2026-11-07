// @ts-check
// Shared helpers of the tests of the helper commands (A229: build-record, friction, calibrate, lessons, rules, wait-line, task-rename, test): the scaffold
// project of the legacy library, git in it, and edits of its config.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanEnv } from '../hook/harness.mjs';
import { project } from './legacy-lib.mjs';

export const RECIPE = 'scaffold standalone no STANDARD manual';

/** A throwaway project with run LC. */
export const newProject = () => project(RECIPE);

/** git in the project, as the fixture identity. @param {string} dir @param {string[]} args */
export function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, env: cleanEnv({}), encoding: 'utf8' });
  return r.stdout.replace(/\n+$/, '');
}
/** Commit everything. @param {string} dir @param {string} msg */
export function commitAll(dir, msg) { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); }

/** Set a commands.* scalar of .agents/config.yaml (`  build:`, `  test:`, `  install:`). @param {string} dir @param {string} key @param {string} value */
export function setCmd(dir, key, value) {
  const f = `${dir}/.agents/config.yaml`;
  const text = readFileSync(f, 'utf8').split('\n').map((l) => (l.startsWith(`  ${key}:`) ? `  ${key}: ${value}` : l)).join('\n');
  writeFileSync(f, text);
}
/** Rewrite the build and test keys as block lists (items separated by |). @param {string} dir @param {string} build @param {string} test */
export function setLists(dir, build, test) {
  const f = `${dir}/.agents/config.yaml`;
  /** @type {string[]} */ const out = [];
  let skip = false;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    const m = /^ {2}(build|test):/.exec(l);
    if (m) { skip = true; out.push(`  ${m[1]}:`); for (const it of (m[1] === 'build' ? build : test).split('|')) out.push(`    - ${it}`); continue; }
    if (skip && /^ {4}- /.test(l)) continue;
    skip = false; out.push(l);
  }
  writeFileSync(f, out.join('\n'));
}
/** Set the line `  env_files:` of verification. @param {string} dir @param {string} value */
export function setEnvFiles(dir, value) {
  const f = `${dir}/.agents/config.yaml`;
  writeFileSync(f, readFileSync(f, 'utf8').split('\n').map((l) => (l.startsWith('  env_files:') ? `  env_files: ${value}` : l)).join('\n'));
}
export { appendFileSync };
