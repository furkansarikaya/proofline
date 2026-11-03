// @ts-check
// The task adapters of the core (stage 6B, A216). `runTaskAdapter` is the one door: a user-written `.agents/task-integrations/<name>.sh` of the project
// (and the stub a test fixture writes) runs as a child through proc.mjs, exactly as before; otherwise the built-in adapters markdown and github run in
// this process and jira and linear (which use `fetch`) run in one Node child. An unknown name is null. The adapter name is one file name: a slash,
// a backslash, a control character or a leading dot never leaves the folder.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Config } from '../config.mjs';
import { cleanToolEnv, resolveTool } from '../platform.mjs';
import * as proc from '../proc.mjs';
import { AdapterExit, isFile } from './lib.mjs';
import { runGithub } from './github.mjs';
import { runMarkdown } from './markdown.mjs';

/** @typedef {import('../context.mjs').Context} Context */
/** @typedef {{ status: number, stdout: Buffer, stderr: Buffer }} AdapterResult */

export const BUILTIN = ['markdown', 'github', 'jira', 'linear'];

/** Is this a name the adapter folder can hold? @param {string} name */
export function adapterNameOk(name) { return name !== '' && !/[/\\\x00-\x1f\x7f]/.test(name) && !name.startsWith('.'); }

/** The project's own script for the adapter, or ''. @param {string} root @param {string} name */
export function userScript(root, name) {
  const p = `${root}/.agents/task-integrations/${name}.sh`;
  return adapterNameOk(name) && isFile(p) ? p : '';
}

/** Is there an adapter of this name (a user script or a built-in)? @param {string} root @param {string} name */
export function adapterExists(root, name) { return adapterNameOk(name) && (userScript(root, name) !== '' || BUILTIN.includes(name)); }

const netMain = path.join(path.dirname(fileURLToPath(import.meta.url)), 'netmain.mjs');

/**
 * Run one operation of the adapter NAME for the project at `root` (default the context's). Returns null for an unknown adapter.
 * @param {Context} ctx @param {string} name @param {string[]} args the operation and its arguments
 * @param {{ root?: string, cwd?: string, timeoutMs?: number }} [opt]
 * @returns {AdapterResult | null}
 */
export function runTaskAdapter(ctx, name, args, opt = {}) {
  const root = opt.root ?? ctx.root;
  const cwd = opt.cwd ?? ctx.cwd;
  if (!adapterNameOk(name)) return null;
  const script = userScript(root, name);
  if (script !== '') {
    const r = proc.run('sh', [script, ...args], { cwd, env: ctx.childEnv(), input: '', stdio: ['pipe', 'pipe', 'pipe'], timeoutMs: opt.timeoutMs });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  if (!BUILTIN.includes(name)) return null;
  if (name === 'jira' || name === 'linear') {
    const r = proc.run(process.execPath, [netMain, root, name, ...args], { cwd, env: ctx.childEnv(), input: '', stdio: ['pipe', 'pipe', 'pipe'], timeoutMs: opt.timeoutMs });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const cfg = Config.load(`${root}/.agents/config.yaml`);
  const a = {
    root, cwd, env: ctx.childEnv(), name: `${name} adapter`, tasksDir: cfg.get('tasks.dir', '.agents/tasks'),
    out: (/** @type {string} */ s) => { out.push(Buffer.from(s, 'latin1')); }, err: (/** @type {string} */ s) => { err.push(Buffer.from(s, 'latin1')); },
    gh: (/** @type {string[]} */ ghArgs) => {
      const t = resolveTool(ctx, 'gh');
      if ('unreadable' in t) return null;
      const r = proc.run(t.path, ghArgs, { cwd, env: cleanToolEnv(ctx), input: '', stdio: ['pipe', 'pipe', 'pipe'], timeoutMs: 120000 });
      return r.started ? { status: r.status, out: r.stdout.toString('utf8'), err: r.stderr.toString('utf8') } : null;
    },
  };
  let status = 0;
  try {
    if (name === 'markdown') runMarkdown(a, args); else runGithub(a, args);
  } catch (e) {
    if (e instanceof AdapterExit) status = e.code;
    else { status = 1; err.push(Buffer.from(`${a.name}: ${e instanceof Error ? e.message : String(e)}\n`)); }
  }
  return { status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
}
