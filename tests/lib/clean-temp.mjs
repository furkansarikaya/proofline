#!/usr/bin/env node
// @ts-check
// `node tests/lib/clean-temp.mjs [--dry-run] [--hours N] [--tmpdir DIR]` (A253, a finding on issue #165): removes the temporary folders the Node tests leave behind when a run is killed,
// and prunes the template cache of tests/lib/harness.mjs by the rules of tests/lib/prune.mjs. It prints every folder it removes (with --dry-run: would remove) with its size, and a total.
// It touches only DIRECT children of the temp folder (and of the cache folders) that are real directories of this user (lstat; links are never followed or removed), whose name is one the
// harness creates (PREFIXES: an explicit list, nothing else), that are older than the threshold (default 2 hours), and, for a harness base, whose recorded process is not alive.
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { POLICY, pruneCache, removeTree, sizeOf } from './prune.mjs';

/**
 * The names a test run creates under the temp folder. `proofline-*` is the one prefix family of the helpers (proofline-h-, proofline-recipe-, proofline-bt-fake-, proofline-guards-,
 * and the product's own proofline-fp./-doctor./-submit./...), minus the template cache (pruned by its own rules) and the folders a person keeps on purpose (end-to-end and smoke runs).
 * The legacy names are what older tests used (the leftovers of runs before A253): a fixed prefix and the six random characters mkdtemp appends, nothing looser.
 */
export const PREFIXES = [
  /^proofline-(?!harness-|e2e$|smoke\.)[\w.-]+$/,
  /^(?:hf5|hf5b|br-out|br-timeout|bt-fake|bt-origin|plr|recipe)-[A-Za-z0-9]{6}$/,
];
export const isTestTemp = (/** @type {string} */ name) => PREFIXES.some((re) => re.test(name));

/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; } };

/** The pid a harness base records in `.pid`, or undefined. @param {string} dir @param {typeof nodeFs} fsx */
function ownerPid(dir, fsx) {
  try { const n = Number(String(fsx.readFileSync(path.join(dir, '.pid'))).trim()); return Number.isInteger(n) && n > 0 ? n : undefined; } catch { return undefined; }
}

/**
 * The temp folders to remove, and removes them unless dryRun.
 * @param {string} dir the temp folder @param {{ now: number, dryRun?: boolean, hours?: number, fsx?: typeof nodeFs, uid?: number, isAlive?: (pid: number) => boolean }} o
 * @returns {Array<{ path: string, bytes: number, reason: string }>}
 */
export function cleanTemp(dir, o) {
  const fsx = o.fsx ?? nodeFs; const uid = o.uid ?? process.getuid?.(); const isAlive = o.isAlive ?? alive;
  const maxAge = (o.hours ?? POLICY.tempMs / 3600e3) * 3600e3;
  /** @type {Array<{ path: string, bytes: number, reason: string }>} */ const out = [];
  let names; try { names = fsx.readdirSync(dir).map(String); } catch { return out; }
  for (const name of names) {
    if (!isTestTemp(name)) continue;
    const p = path.join(dir, name);
    let st; try { st = fsx.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || o.now - st.mtimeMs <= maxAge) continue;   // a link, a file, another user's folder, a young one: not ours to remove
    const pid = ownerPid(p, fsx);
    if (pid !== undefined && isAlive(pid)) continue;   // the process that owns this base is still running (a long run does not touch the folder itself for hours)
    const row = { path: p, bytes: sizeOf(p, fsx), reason: `unused for ${Math.floor((o.now - st.mtimeMs) / 3600e3)}h` };
    if (!o.dryRun) { try { removeTree(p, fsx); } catch { continue; } }
    out.push(row);
  }
  return out;
}

const mb = (/** @type {number} */ n) => `${(n / 1048576).toFixed(1)} MB`;

/** @param {string[]} argv @param {{ now: number, out?: (s: string) => void }} env @returns {number} exit status */
export function main(argv, env) {
  const say = env.out ?? ((s) => process.stdout.write(`${s}\n`));
  let dryRun = false; let hours; /** @type {string | undefined} */ let given;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--hours' && /^\d+(\.\d+)?$/.test(argv[i + 1] ?? '')) hours = Number(argv[++i]);
    else if (a === '--tmpdir' && argv[i + 1]) given = path.resolve(argv[++i]);
    else { process.stderr.write('usage: node tests/lib/clean-temp.mjs [--dry-run] [--hours N] [--tmpdir DIR]\n'); return 2; }
  }
  const verb = dryRun ? 'would remove' : 'removed';
  const uid = process.getuid?.() ?? 0;
  const dirs = [...new Set((given ? [given] : [tmpdir(), '/tmp']).flatMap((d) => { try { return [nodeFs.realpathSync(d)]; } catch { return []; } }))];   // /tmp too: a run without TMPDIR uses it
  let total = 0; let count = 0;
  for (const dir of dirs) {
    for (const r of cleanTemp(dir, { now: env.now, dryRun, hours })) { say(`${verb} ${r.path} (${mb(r.bytes)}, ${r.reason})`); total += r.bytes; count++; }
    const root = path.join(dir, `proofline-harness-${uid}`);
    let st; try { st = nodeFs.lstatSync(root); } catch { continue; }
    if (!st.isDirectory() || st.uid !== uid) continue;   // a link or another user's folder is never entered
    for (const x of pruneCache(root, { now: env.now, dryRun }).removed) { say(`${verb} ${x.path} (${mb(x.bytes)}, cache: ${x.reason})`); total += x.bytes; count++; }
  }
  say(`${verb} ${count} folders, ${mb(total)}${dryRun ? ' (dry run: nothing was removed)' : ''}`);
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exitCode = main(process.argv.slice(2), { now: Date.now() });
