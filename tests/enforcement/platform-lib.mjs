// @ts-check
// Helpers shared by tests/enforcement/{platform,merge-guard}.test.mjs (176-C): fake platform tools that live in the checkout (never under a temporary
// folder: a tool that resolves there is refused, A180), `proofline merge` runs, and the real hook run asynchronously so a table of commands is fast.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { cleanEnv, repo } from '../lib/harness.mjs';
import { hookFile } from './lib.mjs';

export const proofline = path.join(repo, 'bin/proofline');
export const core = path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs');
const toolRoot = path.join(repo, 'tests/core/.fake-tools');
let counter = 0;

/** A scratch folder (removed when the test file ends). @param {string} [prefix] */
export function scratch(prefix = 'enf-') {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  after(() => { rmSync(d, { recursive: true, force: true }); });
  return d;
}

/** A folder for fake tools inside the checkout (git-ignored). @param {string} label @returns {string} */
export function stubDir(label) {
  const root = path.join(toolRoot, `${label}-${process.pid}-${++counter}`);
  const d = path.join(root, 'stub');
  mkdirSync(d, { recursive: true });
  after(() => { rmSync(root, { recursive: true, force: true }); });
  return d;
}
/** Write an executable. The state folder is baked into the text by the caller (a tool gets no caller variables, A215). @param {string} file @param {string} text */
export function writeTool(file, text) { writeFileSync(file, text); chmodSync(file, 0o755); }

/** @param {string} cwd @param {string[]} args */
export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: cleanEnv({}), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, '');
}
/** A git repository on main with one empty commit. @param {string} dir */
export function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
}

/**
 * Run a program with the fixture environment plus PATH. @param {string} cwd @param {string} cmd @param {string[]} args @param {Record<string, string>} [env]
 * @returns {{ status: number | null, text: string }}
 */
export function run(cwd, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd, env: cleanEnv(env), encoding: 'utf8' });
  return { status: r.status, text: String(r.stdout) + String(r.stderr) };
}
/** `node bin/proofline merge ARGS` in the project with the PATH given. @param {string} proj @param {string[]} args @param {string} pathEnv @param {string} [node] */
export const merge = (proj, args, pathEnv, node = process.execPath) => run(proj, node, [proofline, 'merge', ...args], { PATH: pathEnv });
/** `node core cli platform-info ARGS` with an optional PATH/env. @param {string[]} args @param {Record<string, string>} [env] @param {string} [cwd] */
export const pfc = (args, env = {}, cwd = repo) => run(cwd, process.execPath, [core, 'cli', 'platform-info', ...args], env).text.replace(/\n+$/, '');
/** @param {string} f */
export const slurp = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

/** A folder of links to the named tools only (the programs the wrapper needs, nothing else). @param {string} dir @param {string[]} tools */
export function toolsOnly(dir, tools) {
  mkdirSync(dir, { recursive: true });
  for (const t of tools) {
    const r = spawnSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' });
    const p = r.stdout.trim();
    if (p) { try { rmSync(path.join(dir, t), { force: true }); spawnSync('ln', ['-s', p, path.join(dir, t)]); } catch { /* not linkable */ } }
  }
}

/**
 * The real hook for one PreToolUse Bash call, asynchronous. @param {string} dir @param {string} command
 * @returns {Promise<string>} the hook's stdout
 */
export function preBashAsync(dir, command) {
  const json = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command } });
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [hookFile, 'pretool', 'claude'], { cwd: dir, env: cleanEnv({ PROOFLINE_HOOK_APPROVE_BUDGET: '300', PROOFLINE_HOOK_LOCK_WAIT: '120' }) });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', () => {});
    const t = setTimeout(() => c.kill('SIGKILL'), 120000);
    c.on('close', () => { clearTimeout(t); resolve(out); });
    c.stdin.on('error', () => {});
    c.stdin.end(json);
  });
}
/** Run fn over items, at most n at a time. @template T @param {T[]} items @param {number} n @param {(x: T) => Promise<void>} fn */
export async function pooled(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = /** @type {T} */ (items[i++]); await fn(x); } }));
}
