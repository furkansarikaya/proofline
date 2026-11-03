// @ts-check
// The child process of the Jira and Linear adapters (they use `fetch`, which is asynchronous): `node netmain.mjs <root> <jira|linear> <operation> <args...>`.
// It is started by core/adapters/index.mjs only. The credential comes from the environment of the control plane (JIRA_*, LINEAR_*) and goes into a
// request header; it is never printed.
import { Config } from '../config.mjs';
import { AdapterExit } from './lib.mjs';
import { runJira, runLinear } from './net.mjs';

const [root, name, ...args] = process.argv.slice(2);
const cfg = Config.load(`${root}/.agents/config.yaml`);
/** @type {string[]} */ const out = []; /** @type {string[]} */ const err = [];
const a = { root, cwd: process.cwd(), env: process.env, name: `${name} adapter`, tasksDir: cfg.get('tasks.dir', '.agents/tasks'), out: (/** @type {string} */ s) => out.push(s), err: (/** @type {string} */ s) => err.push(s) };
let code = 0;
try {
  if (name === 'jira') await runJira(a, args); else if (name === 'linear') await runLinear(a, args); else { err.push(`unknown adapter: ${name}\n`); code = 1; }
} catch (e) {
  if (e instanceof AdapterExit) code = e.code; else { code = 1; err.push(`${a.name}: ${e instanceof Error ? e.message : 'failed'}\n`); }
}
process.stdout.write(Buffer.from(out.join(''), 'latin1'));
process.stderr.write(Buffer.from(err.join(''), 'latin1'));
process.exitCode = code;
