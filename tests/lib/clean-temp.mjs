#!/usr/bin/env node
// @ts-check
// `node tests/lib/clean-temp.mjs [--dry-run] [--hours N] [--tmpdir DIR]` (A253, a finding on issue #165): removes the temporary folders the Node tests leave behind when a run is killed,
// and prunes the template cache of tests/lib/harness.mjs by the rules of tests/lib/prune.mjs. It prints every folder it removes (with --dry-run: would remove) with its size, and a total.
// It touches only DIRECT children of the temp folder (and of the cache folders) that are real directories of this user (lstat; links are never followed or removed), whose name is one the
// harness creates (PREFIXES: an explicit list, nothing else), that are older than the threshold (default 2 hours), and, for a harness base, whose recorded process is not alive.
import * as nodeFs from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { POLICY, pruneCache, removeTree, sizeOf } from './prune.mjs';

/**
 * The names a test run creates under the temp folder. `proofline-*` is the one prefix family of the helpers (proofline-h-, proofline-recipe-, proofline-bt-fake-, proofline-guards-,
 * and the product's own proofline-fp./-doctor./-submit./...), minus the template cache (pruned by its own rules) and the folders a person keeps on purpose (end-to-end and smoke runs).
 * The legacy names are what older tests used (the leftovers of runs before A253): a fixed prefix and the six random characters mkdtemp appends, nothing looser.
 */
/** The prefixes older tests gave their folders (a fixed prefix, then the six characters mkdtemp adds). */
const LEGACY = 'a180-tmp a94b accounts-test-db adp affected-map ans ans-fx api attr-home batch-procs bench benchmark bo bump-test census cfg-test cfgcli check-shared concurrency-selfcheck config-consistency-selfcheck contract-selfcheck cp-test cpfx cr-inflight dbg dbprobe dd-test debug-proof-selfcheck decisions-guard dep-test dependency-audit-selfcheck dispatch-procs dispatch-record docs-writer ds dw-cfg dw-conf dw-fp dw-pl e2e-cap e2e-loop eco-branch eco-det eco-man emfx enf-b enf-rec ep-test exec-procs exploit-proof-selfcheck fixture-lib fm fms fr-gh gen-test gh-state gitstate helper-procs hgit hook-cap hook-fx hook-gf hook-hd hook-head hook-pr hook-pre hook-procs hook-wf hook-wf-decoy ig igfx impfx kg-node kit-sp kit-wt lc lcn llm-wiki-selfcheck mdp merge-guard mf-proj mf-state mg-gl mg-gl-state mg-proj mg-shadow mg-state msg-hooks mv-a102 mv-fix mv-test mv94 no-codex nsl origin pc-docs pcfx perf-proof performance-proof-selfcheck pf-corp pf-corp-hook pf-corp-host pf-corp-proj pf-empty pf-envproj pf-netdrop pf-proj pf-shadow pf-stubs pl-argv0 pl-budget pl-cap pl-cli pl-core pl-ctx pl-disc pl-doc pl-doc-net pl-eco pl-entry pl-fc pl-front pl-gh pl-hash pl-lib pl-libeq pl-proc pl-root pl-shared pl-sub pl-t2-shim pl-t2s pl-t2t pl-t3 pl-tools-glob pl-tree pl-tty pl-unsup pl-usage pl-vfeq pl-vfix plfx pr-fp product-assess product-discovery product-spec qa qa-empty qaep qatune qopen reason-test rep rt-bin rv-bin rv-link rv-plant rv-proj rv-sec scratch-wt sd shadow-gh skills-doc smoke-test ss4c static-test sync-test ta tdd tdd-proof-selfcheck tddc tp tt tt-gate tt-link tt-mut tt-mutrun tt-q tt-run ui ui-code ui-craft ui-scope up verify-proof-selfcheck visual-proof-abort visual-proof-browser visual-proof-network visual-proof-selfcheck vp vp-design vp-native vp-seo vp-seo-br vp-test wiki wt-leader probe-bin run4c hf hf5 hf5b br-out br-timeout bt-fake bt-origin plr recipe'.split(' ');
export const PREFIXES = [
  /^proofline-t-[\w.-]+$/,                                              // tests/lib/tempdir.mjs `tempDir()`: the one family of the test helpers since A253
  /^proofline-h-[A-Za-z0-9]{6}$/,                                        // the base folder of the harness `tmp()`
  /^proofline-(?:recipe|bt-fake|bt-origin|guards|fixtures|trees|rerun|dm|pl|install|grep|rt|ver)-[A-Za-z0-9]{6}$/,   // helpers of the tests and the product's own scratch folders, mkdtemp-shaped
  /^proofline-(?:fp|approve|doctor|submit|lint)\.[A-Za-z0-9]{6}$/,
  /^pl-t2c?-[\w.-]+-[A-Za-z0-9]{6}$/,                                    // pl-t2-<name>-XXXXXX, pl-t2c-<name>-XXXXXX
  /^eq-(?:installed|nonode|scaffold|s2-[\w-]+)\.[A-Za-z0-9]{6}$/, /^(?:wiring|hook-imports|impact-selfcheck)\.[A-Za-z0-9]{6}$/,
  new RegExp(`^(?:${LEGACY.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})-[A-Za-z0-9]{6}$`),   // what tests named their folders before A253
];
/** A folder that holds a `.git` is somebody's repository unless it is one of ours by construction (`proofline-t-`, `proofline-h-`). */
const OURS_WITH_GIT = /^proofline-[th]-/;
export const isTestTemp = (/** @type {string} */ name) => PREFIXES.some((re) => re.test(name));

/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; } };

/** @param {string} dir @param {typeof nodeFs} fsx */
function hasGit(dir, fsx) { try { fsx.lstatSync(path.join(dir, '.git')); return true; } catch { return false; } }

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
    if (!OURS_WITH_GIT.test(name) && hasGit(p, fsx)) continue;   // a repository that happens to carry a matching name
    const pid = ownerPid(p, fsx);
    if (pid !== undefined && isAlive(pid)) continue;   // the process that owns this base is still running (a long run does not touch the folder itself for hours)
    const row = { path: p, bytes: sizeOf(p, fsx), reason: `unused for ${Math.floor((o.now - st.mtimeMs) / 3600e3)}h` };
    if (!o.dryRun) { try { removeTree(p, fsx); } catch { continue; } }
    out.push(row);
  }
  return out;
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
/**
 * The stale folders under the fake-tool root of the checkout: `<pid>` and `batch-<pid>` whose process is gone, and the `ln-`/`cx-` folders of the platform tests, older than the threshold.
 * @param {string} dir @param {{ now: number, dryRun?: boolean, hours?: number, fsx?: typeof nodeFs, isAlive?: (pid: number) => boolean }} o
 */
export function cleanFakeTools(dir, o) {
  const fsx = o.fsx ?? nodeFs; const isAlive = o.isAlive ?? alive; const uid = process.getuid?.();
  const maxAge = (o.hours ?? POLICY.tempMs / 3600e3) * 3600e3;
  /** @type {Array<{ path: string, bytes: number, reason: string }>} */ const out = [];
  let names; try { names = fsx.readdirSync(dir).map(String); } catch { return out; }
  for (const name of names) {
    const m = /^(?:batch-)?(\d+)$/.exec(name);
    if (!m && !/^(?:ln|cx)-[A-Za-z0-9]{6}$/.test(name)) continue;
    const p = path.join(dir, name);
    let st; try { st = fsx.lstatSync(p); } catch { continue; }
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || o.now - st.mtimeMs <= maxAge) continue;
    if (m && isAlive(Number(m[1]))) continue;
    const row = { path: p, bytes: sizeOf(p, fsx), reason: `fake tools unused for ${Math.floor((o.now - st.mtimeMs) / 3600e3)}h` };
    if (!o.dryRun) { try { removeTree(p, fsx); } catch { continue; } }
    out.push(row);
  }
  return out;
}

const mb = (/** @type {number} */ n) => `${(n / 1048576).toFixed(1)} MB`;

/** @param {string[]} argv @param {{ now: number, out?: (s: string) => void, dirs?: string[], fakeTools?: string }} env `dirs`/`fakeTools`: the folders to look in (tests) @returns {number} exit status */
export function main(argv, env) {
  const say = env.out ?? ((s) => process.stdout.write(`${s}\n`));
  let dryRun = false; let hours; /** @type {string | undefined} */ let given;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--hours' && /^\d+(\.\d+)?$/.test(argv[i + 1] ?? '') && Number(argv[i + 1]) >= 1) hours = Number(argv[++i]);   // at least one hour: a younger folder may belong to a run that is starting
    else if (a === '--tmpdir' && argv[i + 1]) given = path.resolve(argv[++i]);
    else { process.stderr.write('usage: node tests/lib/clean-temp.mjs [--dry-run] [--hours N (at least 1)] [--tmpdir DIR]\n'); return 2; }
  }
  if (given !== undefined) {   // a folder that is not a temp folder is refused: the name list is the only thing between this command and somebody's files
    const real = (/** @type {string} */ d) => { try { return nodeFs.realpathSync(d); } catch { return path.resolve(d); } };
    const refused = ['/', os.homedir(), os.homedir() && path.dirname(os.homedir()), repoRoot, path.dirname(repoRoot)].filter(Boolean).map(real);
    if (given === '' || refused.includes(real(given))) { process.stderr.write(`clean-temp: refusing --tmpdir ${given}: it is the root, the home folder, or the checkout (or the folder above one); name a temp folder\n`); return 2; }
  }
  const verb = dryRun ? 'would remove' : 'removed';
  const uid = process.getuid?.() ?? 0;
  const dirs = [...new Set((given ? [given] : (env.dirs ?? [tmpdir(), '/tmp'])).flatMap((d) => { try { return [nodeFs.realpathSync(d)]; } catch { return []; } }))];   // /tmp too: a run without TMPDIR uses it
  let total = 0; let count = 0;
  for (const dir of dirs) {
    for (const r of cleanTemp(dir, { now: env.now, dryRun, hours })) { say(`${verb} ${r.path} (${mb(r.bytes)}, ${r.reason})`); total += r.bytes; count++; }
    const root = path.join(dir, `proofline-harness-${uid}`);
    let st; try { st = nodeFs.lstatSync(root); } catch { continue; }
    if (!st.isDirectory() || st.uid !== uid) continue;   // a link or another user's folder is never entered
    for (const x of pruneCache(root, { now: env.now, dryRun }).removed) { say(`${verb} ${x.path} (${mb(x.bytes)}, cache: ${x.reason})`); total += x.bytes; count++; }
  }
  if (given === undefined && (env.dirs === undefined || env.fakeTools !== undefined)) {   // the platform and batch tests keep their fake tools in the checkout (A180): a killed run leaves `<pid>` folders there
    for (const r of cleanFakeTools(env.fakeTools ?? path.join(repoRoot, 'tests/core/.fake-tools'), { now: env.now, dryRun, hours })) { say(`${verb} ${r.path} (${mb(r.bytes)}, ${r.reason})`); total += r.bytes; count++; }
  }
  say(`${verb} ${count} folders, ${mb(total)}${dryRun ? ' (dry run: nothing was removed)' : ''}`);
  return 0;
}

if (import.meta.filename === process.argv[1]) process.exitCode = main(process.argv.slice(2), { now: Date.now() });
