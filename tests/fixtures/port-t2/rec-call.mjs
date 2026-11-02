// @ts-check
// ONE-TIME recorder of a single agent.sh call (temporary): `node rec-call.mjs ROOT ROLE ARGS...` snapshots the project, runs the call on the SHELL
// (PROOFLINE_ENGINE=sh), prints its output as the caller expects and appends {state, args, role, out, err, code} to the trace file of the scenario.
// Environment: T2_STORE (the trace folder), T2_NAME (file name of the scenario).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { snapshot } from './snap.mjs';

const [root, role, ...args] = process.argv.slice(2);
const file = path.join(/** @type {string} */ (process.env.T2_STORE), `${process.env.T2_NAME}.json.gz`);
/** @type {{ blobs: Record<string, any>, states: Record<string, any>, calls: any[] }} */
const data = existsSync(file) ? JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) : { blobs: {}, states: {}, calls: [] };
const { key, state } = snapshot(root, data.blobs);
if (!(key in data.states)) data.states[key] = state;
const env = { ...process.env, PROOFLINE_ENGINE: 'sh' };
if (role) env.AGENT_ROLE = role; else delete env.AGENT_ROLE;
const r = spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: root, env, encoding: 'latin1', input: '', maxBuffer: 1 << 28 });
const norm = (/** @type {string} */ s) => s.split(root).join('<ROOT>');
data.calls.push({ state: key, args, role, out: norm(r.stdout), err: norm(r.stderr), code: r.status });
writeFileSync(file, gzipSync(JSON.stringify(data)));
process.stdout.write(r.stdout, 'latin1');
process.stderr.write(r.stderr, 'latin1');
process.exit(r.status ?? 1);
