// @ts-check
// The path policy of the PreToolUse guards (the "path policy" and "database guard" blocks of proofline-hook.sh): where a project-relative path
// stands (relpath), whether the caller may write it now (target_ok, path_ok, nr_path_ok, outside_ok, erasable), the database-file guard for file
// tools, and the baseline of untracked files. Shared by guards/read.mjs, write.mjs, other.mjs (and usable by guards/bash.mjs).
//
// Differences from the shell, all on the strict side (the shell is the specification; these close holes it has):
//   - a directory is resolved PHYSICALLY with realpath: `link/../x` is the parent of the link target, not the textual parent (the shell's
//     `cd` folds `..` before pwd -P, so it judged /project/x for a write that lands next to the link target);
//   - the case of existing components is the one on disk (macOS is case-insensitive: `RUN.yaml` and `run.yaml` are one file);
//   - a scratch token of the database guard (/tmp/..., $TMPDIR/...) with a `..` component, or one that resolves out of scratch, is no scratch;
//   - a path with a newline is also judged as one whole path, not only line by line.
import { lstatSync, realpathSync, readFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { put, mkdirp, isDir, isFile, readText } from '../lib/fsx.mjs';
import { cmdSubst, canon } from '../lib/text.mjs';

/** @typedef {import('../lib/context.mjs').HookContext} Ctx */

/** A denial in the middle of a helper (the shell's `deny`, which exits at once). The guard wrapper turns it into {decision:'deny'}. */
export class Deny extends Error {}

/** @type {WeakMap<object, any>} */
const STATE = new WeakMap();
/** @param {Ctx} ctx */
function st(ctx) {
  let s = STATE.get(ctx);
  if (!s) { s = { rel: new Map(), tasksDir: null, hcfg: undefined, db: null, phys: new Map(), mcfail: null }; STATE.set(ctx, s); }
  return s;
}

/** `mc_flag COMMAND STATUS`: a moved command failed in a place that cannot deny itself; the guard denies when it ends without an answer. @param {Ctx} ctx @param {string} command @param {number} status */
export function mcFlag(ctx, command, status) {
  if (ctx.ev !== 'pretool' || ctx.act === '') return;
  st(ctx).mcfail = { command, status };
}
/** @param {Ctx} ctx */
export function mcText(ctx) {
  const f = st(ctx).mcfail;
  return `agent.sh ${f.command} exited ${f.status}, so a guard cannot read the run state and fails closed: this command runs in Node and the user must check that Node 22.13 or newer is on PATH (tell the user; a model command cannot fix or diagnose it), or write sh into .agents/local/engine to run the old shell code`;
}
/** `deny MESSAGE` @param {Ctx} ctx @param {string} msg @returns {never} */
export function deny(ctx, msg) {
  throw new Deny(st(ctx).mcfail ? `${mcText(ctx)} | ${msg}` : msg);
}
/** `hk_mcexit`: the answer when a guard ends allowing but a moved command failed on the way. @param {Ctx} ctx @returns {{ decision: 'deny', reason: string } | null} */
export function mcExit(ctx) {
  return st(ctx).mcfail ? { decision: 'deny', reason: mcText(ctx) } : null;
}

/**
 * Run a guard body and give its answer in the contract's shape. A thrown Deny is the shell's `deny`; any other exception propagates (the router
 * fails closed on it).
 * @param {Ctx} ctx @param {() => Promise<void>} body @returns {Promise<{ decision: 'deny' | 'ask', reason: string } | null>}
 */
export async function guarded(ctx, body) {
  try { await body(); } catch (e) {
    if (e instanceof Deny) return { decision: 'deny', reason: e.message };
    throw e;
  }
  return mcExit(ctx);
}

// ---- small shell equivalents ----------------------------------------------------------------------------------------------------

/** `dn_` @param {string} p */
function dn(p) {
  let r = p;
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  if (r.includes('/')) {
    r = r.slice(0, r.lastIndexOf('/'));
    while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
    return r === '' ? '/' : r;
  }
  return '.';
}
/** `bn_` @param {string} p */
function bn(p) {
  let r = p;
  while (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r === '/' ? r : r.slice(r.lastIndexOf('/') + 1);
}

/** A shell glob (`case` pattern: * ? [..] and \x; * also matches a slash) as a regular expression. @param {string} g */
export function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '\\' && i + 1 < g.length) re += g[++i].replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
    else if (c === '[') {
      const m = /^\[([!^]?)(\]?[^\]]*)\]/.exec(g.slice(i));
      if (!m) { re += '\\['; continue; }
      re += `[${m[1] ? '^' : ''}${m[2].replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      i += m[0].length - 1;
    } else re += c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}
/** `case STR in PATTERN)` @param {string} s @param {string} g */
export function globMatch(s, g) { return globRe(g).test(s); }

/** @type {Promise<(p: string) => string> | null} */
let normFn = null;
/**
 * A path from the runtime in POSIX form: Windows drive, UNC and backslash spellings are converted before anything resolves them
 * (core/paths.mjs normalizeInputPath of the project, else of this repository, else backslashes only).
 * @param {Ctx} ctx @param {string} p
 */
async function inputPath(ctx, p) {
  if (!p.includes('\\') && !/^[A-Za-z]:/.test(p) && !p.startsWith('/c/') && !p.startsWith('/cygdrive/')) return p;
  normFn ??= (async () => {
    for (const d of [`${ctx.root}/.agents/scripts/core`, path.resolve(import.meta.dirname, '../../../../control-plane/agents/scripts/core')]) {
      if (!isFile(`${d}/paths.mjs`)) continue;
      try { const m = await import(pathToFileURL(`${d}/paths.mjs`).href); return (/** @type {string} */ x) => m.normalizeInputPath(x); } catch { /* next */ }
    }
    return (/** @type {string} */ x) => x.replace(/\\/g, '/');
  })();
  return (await normFn)(p);
}

/** The physical path of an existing directory with the on-disk case ('' when it cannot be resolved). @param {string} d */
function physDir(d) {
  try { return realpathSync.native(d).split(path.sep).join('/'); } catch { return ''; }
}
/** @param {Ctx} ctx @param {string} p */
function physCached(ctx, p) {
  const m = st(ctx).phys;
  let v = m.get(p);
  if (v === undefined) { v = physDir(p); m.set(p, v); }
  return v;
}

// ---- hook-config ----------------------------------------------------------------------------------------------------------------

/** `hcfg_load`: the settings the hook needs, from one `agent.sh hook-config`; false when the command fails (the callers then ask the old way). @param {Ctx} ctx */
export async function hcfgLoad(ctx) {
  const s = st(ctx);
  if (s.hcfg !== undefined) return s.hcfg !== null;
  s.hcfg = null;
  if (!ctx.installed) return false;
  const r = await ctx.agent(['hook-config']);
  if (r.status !== 0) return false;
  const h = { tasks: '', branch: '', product: '', paths: '', clients: '', migrate: '' };
  for (const l of r.stdout.split('\n')) {
    const i = l.indexOf('=');
    if (i < 0) continue;
    const k = l.slice(0, i); const v = l.slice(i + 1);
    if (k === 'tasks_dir') h.tasks = v; else if (k === 'canonical_branch') h.branch = v; else if (k === 'product_dir') h.product = v;
    else if (k === 'paths') h.paths = v; else if (k === 'clients') h.clients = v; else if (k === 'migrate_commands') h.migrate = v;
  }
  s.hcfg = h;
  return true;
}

/** @param {Ctx} ctx */
async function tasksDir(ctx) {
  const s = st(ctx);
  if (s.tasksDir !== null) return s.tasksDir;
  let t = '';
  if (await hcfgLoad(ctx)) t = s.hcfg.tasks;
  else {
    const r = await ctx.agent(['config-get', 'tasks.dir']);
    if (r.status !== 0) { mcFlag(ctx, 'config-get', r.status); t = ''; } else t = cmdSubst(r.stdout);
  }
  if (t.endsWith('/')) t = t.slice(0, -1);
  if (t === '') t = '.agents/tasks';
  s.tasksDir = t;
  return t;
}

// ---- relpath --------------------------------------------------------------------------------------------------------------------

/**
 * `relpath P`: the project-relative path of P (against the working directory; every existing directory on the way resolved physically);
 * "@outside" outside the project, "@unknown" when it cannot be resolved (a dangling link among the parents, a `..` or `.` among the missing
 * components). The last component is not followed (target_ok refuses links there). `abs` is the resolved path when it is outside.
 * @param {Ctx} ctx @param {string} p0 @returns {Promise<{ rel: string, abs: string }>}
 */
export async function relpath(ctx, p0) {
  const s = st(ctx);
  const hit = s.rel.get(p0);
  if (hit) return hit;
  const r = await relpathUncached(ctx, p0);
  s.rel.set(p0, r);
  return r;
}

/** @param {Ctx} ctx @param {string} p0 */
async function relpathUncached(ctx, p0) {
  const p = await inputPath(ctx, p0);
  let rp = isAbs(p) ? p : `${ctx.cwd}/${p}`;
  let dir = dn(rp); let tail = bn(rp);
  const unknown = { rel: '@unknown', abs: '' };
  while (!isDir(dir)) {
    if (isLinkPath(dir)) return unknown;
    tail = `${bn(dir)}/${tail}`;
    const up = dn(dir);
    if (up === dir) return unknown;
    dir = up;
  }
  if (`/${tail}/`.includes('/../') || `/${tail}/`.includes('/./')) return unknown;
  const pd = physCached(ctx, dir);
  if (pd === '') return unknown;
  // an existing last component keeps the case it has on disk (never a link: the link itself is judged by target_ok)
  if (!tail.includes('/')) {
    try {
      if (!lstatSync(`${pd}/${tail}`).isSymbolicLink()) tail = path.basename(realpathSync.native(`${pd}/${tail}`));
    } catch { /* does not exist yet */ }
  }
  rp = pd === '/' ? `/${tail}` : `${pd}/${tail}`;
  const root = physCached(ctx, ctx.root) || ctx.root; const main = physCached(ctx, ctx.mainRoot) || ctx.mainRoot;
  // A184: a session whose project root is a run worktree still protects the MAIN tree
  let base = '';
  if (rp === root || rp.startsWith(`${root}/`)) base = root; else if (rp === main || rp.startsWith(`${main}/`)) base = main;
  if (base === '') return { rel: '@outside', abs: rp };
  if (rp === base) return { rel: '.', abs: '' };
  let rel = rp.slice(base.length + 1);
  // A184: a path inside a run's own git worktree is judged relative to THAT worktree's root (agent.sh worktree-root decides, never the string)
  if (/^\.agents\/local\/worktrees\/.*\/.*$/s.test(rel) && ctx.installed) {
    const r = await ctx.agent(['worktree-root', rp], { keepRole: true });
    const w = cmdSubst(r.stdout);
    if (r.status === 0 && w !== '' && rp.startsWith(`${w}/`)) rel = rp.slice(w.length + 1);
  }
  return { rel, abs: '' };
}

/** An absolute path; a drive spelling only counts on a Windows host (elsewhere `C:/x` is a name under the working directory, as in the shell). @param {string} p */
function isAbs(p) { return p.startsWith('/') || (process.platform === 'win32' && /^[A-Za-z]:\//.test(p)); }

/** @param {string} p */
function isLinkPath(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** `outside_ok P`: may a file tool write P, which relpath put outside the project? Returns the reason on refusal, else ''. @param {Ctx} ctx @param {string} p0 */
export async function outsideOk(ctx, p0) {
  const { abs } = await relpath(ctx, p0);
  const strip = (/** @type {string} */ x) => (x.startsWith('/private') ? x.slice(8) : x);
  const oo = strip(abs);
  const home = strip((ctx.env.HOME || '/nonexistent-home').replace(/\/\/+/g, '/'));
  for (const g of [`${home}/.claude/projects/*/memory/*`, `${home}/.claude/projects/*/tool-results/*`, `${home}/.claude/plans/*`]) if (globMatch(oo, g)) return '';
  const proc = await ctx.agents?.proc();
  if (proc) {
    const r = proc.run('git', ['-C', ctx.root, 'worktree', 'list', '--porcelain'], { env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const l of r.stdout.toString('utf8').split('\n')) {
      if (!l.startsWith('worktree ')) continue;
      const w = l.slice(9);
      if (strip(w) === strip(ctx.root)) continue;
      if (oo.startsWith(`${strip(w)}/`)) return '';
    }
  }
  return `${p0} is outside the project. A run writes nothing outside the copy (registered worktrees and the runtime's own storage excepted); a path that merely shares a prefix with the project root is outside too`;
}

/** @param {string} rel the git hooks and the git config that wires them; never written by an agent */
export function alwaysProtected(rel) {
  return rel === '.agents/githooks' || rel.startsWith('.agents/githooks/') || rel === '.git/config' || rel.startsWith('.git/config.');
}

/** `ro_tail` @param {Ctx} ctx */
export function roTail(ctx) {
  if (!ctx.ro) return '';
  return ` (role ${ctx.role} is read-only in the project working tree, A143: mutation, trials and fix attempts run only in an evidence worktree, a git worktree outside the project that you create under $TMPDIR: git worktree add --detach "$TMPDIR/<name>" HEAD, in its own call, then use literal paths inside it; git worktree list shows it. Allowed in the project: your run result files and .agents/runs/<ID>/scratch/)`;
}

/** `target_ok P`: may the caller write P now? A link or a multiply hard-linked file never is during a run. Returns the reason on refusal, else ''. @param {Ctx} ctx @param {string} p0 */
export async function targetOk(ctx, p0) {
  const p = await inputPath(ctx, p0);
  const abs = isAbs(p) ? p : `${ctx.cwd}/${p}`;
  let l;
  try { l = lstatSync(abs); } catch { l = null; }
  if (l?.isSymbolicLink()) return 'the target is a symbolic link; writes through links are never allowed during a run';
  if (l?.isFile() && l.nlink > 1) return 'the target has several hard links; writes through links are never allowed during a run';
  return pathOk(ctx, (await relpath(ctx, p0)).rel);
}

/** `own_match REL TOKEN BASE` @param {string} rel @param {string} token @param {string} base */
function ownMatch(rel, token, base) {
  const t = base + token;
  if (t.endsWith('/')) return rel.startsWith(t);
  return globMatch(rel, t.replace(/NNN/g, '[0-9][0-9][0-9]'));
}

/** `knowledge_stage` (A159): is the active run in the knowledge step, or FAILED/BLOCKED? Any doubt: no. @param {Ctx} ctx */
async function knowledgeStage(ctx) {
  const r = await ctx.agent(['summary', ctx.act]);
  if (r.status !== 0 && r.stdout === '') mcFlag(ctx, 'summary', r.status);
  const lines = [];
  for (const l of r.stdout.split('\n')) {
    const m = /^STATUS: ([A-Z_]*) \(handoff ([A-Za-z_]*),.*/.exec(l);
    if (m) lines.push(`${m[1]} ${m[2]}`);
  }
  const s = lines.join('\n');
  if (s === 'CODE_DONE DONE') return false;
  return s.startsWith('CODE_DONE ') || s.startsWith('FAILED ') || s.startsWith('BLOCKED ');
}

/** `path_ok REL`: may the caller write REL now? Returns the reason on refusal, else ''. @param {Ctx} ctx @param {string} po */
export async function pathOk(ctx, po) {
  const run = `.agents/runs/${ctx.act}`;
  const tasks = await tasksDir(ctx);
  if (po === '@outside') return '';
  if (po === '@unknown') return 'cannot resolve the target path';
  if (alwaysProtected(po)) return `${po} wires the git hooks; it is never changed by an agent`;
  // The lead writes dispatch assignments (DISPATCH.md); nothing else under .agents/local/.
  if (ctx.role === 'lead' && po.startsWith('.agents/local/assignments/')) return '';
  // Scratch files live in the run folder (D10, A56): writable by every role, never gate input.
  if (po.startsWith(`${run}/scratch/`)) return '';
  if (['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.codex/config.toml', '.agents/hooks'].includes(po) || po.startsWith('.agents/hooks/')) return `${po} holds the runtime hooks; it is never edited during a run`;
  const prot = [`${run}/RUN.yaml`, `${run}/LEDGER.log`, `${run}/HOOKS.log`, `${run}/mutation_budget`, `${run}/gates/*`, `${run}/approvals/*`, `${run}/waivers/*`, `${run}/questions/*`, `${run}/decisions/*`, `${run}/dispatch/*`, `${run}/worker-evidence/*`, `${run}/ci-fix/*`, `${run}/results/*.result.md`, `${run}/results/dispatch-*`, '.agents/local', '.agents/local/*'];
  if (prot.some((g) => globMatch(po, g))) return `${po} is written only by agent.sh and the runtime hooks`;
  if (ctx.role === 'lead') {
    if ([`${run}/TASK.md`, `${run}/PLAN.md`, `${run}/EVIDENCE.md`, `${run}/COMPLETION_REPORT.md`].includes(po) || po.startsWith(`${run}/amendments/`) || po.startsWith(`${tasks}/`)) return '';
    // A159: the knowledge step needs the wiki and the design documents: knowledge scope and design_docs paths only. Fail closed.
    if (await knowledgeStage(ctx) && (await ctx.agent(['in-knowledge-scope', po])).status === 0) return '';
    return `the lead writes only run artifacts (TASK.md PLAN.md EVIDENCE.md COMPLETION_REPORT.md amendments/), task files and .agents/local/assignments/ while run ${ctx.act} is active, plus knowledge scope and design_docs paths (docs/design/ docs/adr/ docs/wiki/ docs/product/) in the knowledge step after CODE_DONE (A159); product changes go through the implementer (D2)`;
  }
  // Specialists: the role's owned paths from .agents/owns.conf (generated; `<role> <token>...`).
  let own = [];
  const ownsText = readText(`${ctx.sroot}/.agents/owns.conf`);
  for (const l of ownsText.split('\n')) {
    const f = l.split(/[ \t]+/).filter((x) => x !== '');
    if (f[0] === ctx.role) { own = f.slice(1); break; }
  }
  if (own.length === 0) own = ctx.role === 'implementer' ? ['PRODUCT_SCOPE'] : ctx.role === 'task_author' ? ['@run', `/${tasks}/`] : ['@run'];
  let hit = false;
  for (const t of own) {
    if (t === '@run') { if (po.startsWith(`${run}/`)) hit = true; }
    else if (t === 'PRODUCT_SCOPE') {
      if (po.startsWith(`${run}/`)) hit = true;
      for (const sp of planScope(ctx, run)) {
        if (sp.endsWith('/')) { if (po.startsWith(sp)) hit = true; } else if (po === sp) hit = true;
      }
    } else if (t.startsWith('/')) { if (ownMatch(po, t.slice(1), '')) hit = true; } else if (ownMatch(po, t, `${run}/`)) hit = true;
    if (hit) break;
  }
  if (!hit) return `${po} is outside the paths role ${ctx.role} owns (${own.join(' ')}; .agents/owns.conf, PLAN.md scope)`;
  if ((ctx.role === 'implementer' || ctx.role === 'designer') && ctx.sub && !po.startsWith(`${run}/`)) {
    // A headless specialist (dispatch.sh) has AGENT_ROLE in the hook's environment: dispatch.sh opened its window before starting it.
    if (!isFile(`${ctx.localDir}/windows/${ctx.aidf}`) && canon(ctx.env.AGENT_ROLE ?? '') !== ctx.role) return `no ${ctx.role} window is open for this subagent (SubagentStart window-open failed or was skipped); the change would be unattributed`;
  }
  return '';
}

/** The scope paths of the frozen PLAN.md (the awk of path_ok). @param {Ctx} ctx @param {string} run */
function planScope(ctx, run) {
  /** @type {string[]} */ const out = [];
  let inScope = false;
  for (const l of readText(`${ctx.sroot}/${run}/PLAN.md`).split('\n')) {
    if (l === 'scope:') { inScope = true; continue; }
    if (inScope && l === '---') break;
    if (inScope && l.startsWith('  - path: ')) out.push(...l.slice(10).replace(/["']/g, '').split(/[ \t]+/).filter((x) => x !== ''));
  }
  return out;
}

/** `nr_path_ok REL` (A169): may the lead (main session) write REL while NO run is active? Returns the reason on refusal, else ''. @param {Ctx} ctx @param {string} np */
export async function nrPathOk(ctx, np) {
  const tasks = await tasksDir(ctx);
  if (np === '@outside') return '';
  if (np === '@unknown') return 'cannot resolve the target path';
  // State only agent.sh and the runtime hooks write, the runtime hooks, and .agents/local/ except the lead's own working folders
  const wr = ['.agents/runs/*/RUN.yaml', '.agents/runs/*/LEDGER.log', '.agents/runs/*/HOOKS.log', '.agents/runs/*/mutation_budget', '.agents/runs/*/gates/*', '.agents/runs/*/approvals/*', '.agents/runs/*/waivers/*', '.agents/runs/*/questions/*', '.agents/runs/*/decisions/*', '.agents/runs/*/dispatch/*', '.agents/runs/*/worker-evidence/*', '.agents/runs/*/ci-fix/*', '.agents/runs/*/results/*.result.md', '.agents/runs/*/results/dispatch-*', '.agents/hooks', '.agents/hooks/*'];
  if (wr.some((g) => globMatch(np, g))) return `${np} is written only by agent.sh and the runtime hooks`;
  const cp = ['.claude/settings*', '.codex/*', '.agents/scripts/*', '.agents/config.yaml', '.agents/ecosystems.json', '.agents/ecosystems.tsv', '.agents/ecosystems.mjs'];
  if (cp.some((g) => globMatch(np, g))) return `${np} holds the runtime hooks, the control-plane scripts, the configuration or the ecosystem definition (the risky-path and dependency sets, A174); the lead never edits it itself (A169)`;
  if (['.agents/local/scratch/*', '.agents/local/explain/*', '.agents/local/assignments/*', '.agents/local/product-spec/*', '.agents/local/product-discovery/*', '.agents/local/intent-grill/*', '.agents/local/task-author/*'].some((g) => globMatch(np, g))) return '';
  if (np === '.agents/local' || np.startsWith('.agents/local/')) return `${np} is runtime state (approvals, prompts, windows, records); the lead writes under .agents/local/ only in scratch/, explain/, assignments/ and the standalone skill folders (product-spec, product-discovery, intent-grill, task-author)`;
  if (np.startsWith(`${tasks}/`) || np.startsWith('.agents/')) return '';
  const proc = await ctx.agents?.proc();
  if (proc && proc.run('git', ['-C', ctx.sroot, 'check-ignore', '-q', '--', np], { env: ctx.env, stdio: 'ignore' }).status === 0) return '';
  if ((await ctx.agent(['in-knowledge-scope', np])).status === 0) return '';
  // product.dir (product-spec output) may be set to another folder than docs/product
  let pd = '';
  if (await hcfgLoad(ctx)) pd = st(ctx).hcfg.product;
  else {
    const r = await ctx.agent(['config-get', 'product.dir']);
    if (r.status !== 0) { mcFlag(ctx, 'config-get', r.status); pd = ''; } else pd = cmdSubst(r.stdout);
  }
  if (pd.endsWith('/')) pd = pd.slice(0, -1);
  if (pd !== '' && pd !== '.' && !pd.startsWith('/') && !pd.includes('..') && np.startsWith(`${pd}/`)) return '';
  return `no run is active, and the lead never edits product files itself (D2, A169). Propose a light run (TRIVIAL or STANDARD) with '/proofline run <text>' and let the implementer make the change; the push approval then binds to that run. Without a run the lead writes only task files (${tasks}/), .agents/, the knowledge scope (docs/design/ docs/adr/ docs/wiki/ docs/product/) and git-ignored files`;
}

/** `baseline`: once per run, the untracked, unignored files that exist before the run changes anything (erasable reads it). @param {Ctx} ctx */
export async function baseline(ctx) {
  if (!ctx.installed || ctx.act === '' || ctx.act === 'INVALID') return;
  const dir = `${ctx.localDir}/baseline`;
  const file = `${dir}/${ctx.act}`;
  if (isFile(file)) return;
  if (!mkdirp(dir)) return;
  const proc = await ctx.agents?.proc();
  if (!proc) return;
  const r = proc.run('git', ['-C', ctx.sroot, 'ls-files', '-z', '--others', '--exclude-standard'], { env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return; // a failed git writes no baseline, so erasable() refuses
  const tmp = `${dir}/.${ctx.act}.${randomBytes(6).toString('hex')}.tmp`;
  try { put(tmp, r.stdout.toString('utf8').split('\0').join('\n'), { exclusive: true }); renameSync(tmp, file); } catch { try { rmSync(tmp, { force: true }); } catch { /* gone */ } }
}

/** `erasable P`: may a deletion of P pass although the path policy refuses it? Only a file the run itself created. @param {Ctx} ctx @param {string} p0 */
export async function erasable(ctx, p0) {
  const rel = (await relpath(ctx, p0)).rel;
  if (rel.startsWith('@') || rel === '.' || rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.claude/') || rel.startsWith('.codex/')) return false;
  const scratch = rel.startsWith(`.agents/runs/${ctx.act}/scratch/`);
  if (!scratch && rel.startsWith('.agents/')) return false;
  const p = await inputPath(ctx, p0);
  const abs = isAbs(p) ? p : `${ctx.cwd}/${p}`;
  let l;
  try { l = lstatSync(abs); } catch { return false; }
  if (!l.isFile() && !l.isSymbolicLink()) return false;
  if (scratch) return true;
  if (ctx.ro) return false; // A143: a read role leaves the project tree unchanged
  if (alwaysProtected(rel)) return false;
  const proc = await ctx.agents?.proc();
  if (!proc) return false;
  const ls = proc.run('git', ['-C', ctx.sroot, 'ls-files', '--', rel], { env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (ls.stdout.toString('utf8') !== '') return false;
  if (proc.run('git', ['-C', ctx.sroot, 'check-ignore', '-q', '--', rel], { env: ctx.env, stdio: 'ignore' }).status === 0) return false;
  const bf = `${ctx.localDir}/baseline/${ctx.act}`;
  if (!isFile(bf)) return false;
  return !readFileSync(bf, 'utf8').split('\n').includes(rel);
}

// ---- the database guard (file tools) ---------------------------------------------------------------------------------------------

/** `db_load`: the database file patterns of the project (config database.paths). @param {Ctx} ctx @returns {Promise<string[]>} */
async function dbPaths(ctx) {
  const s = st(ctx);
  if (s.db) return s.db;
  let paths = '';
  if (await hcfgLoad(ctx)) paths = s.hcfg.paths;
  else {
    const r = await ctx.agent(['db-config', 'all']);
    if (r.status !== 0) {
      // mc_fail db-config run: a failed moved command denies while a run is open
      if (ctx.ev === 'pretool' && ctx.act !== '') deny(ctx, `agent.sh db-config exited ${r.status}, so the database guard cannot read its settings and fails closed: this command runs in Node and the user must check that Node 22.13 or newer is on PATH (tell the user; a model command cannot fix or diagnose it), or write sh into .agents/local/engine to run the old shell code`);
    } else {
      for (const l of r.stdout.split('\n')) if (l.startsWith('paths=')) { paths = l.slice(6); break; }
    }
  }
  const list = paths.split(/[ \t\n]+/).filter((x) => x !== '');
  s.db = list.length ? list : ['*.db', '*.sqlite', '*.sqlite3', '*.db3'];
  return s.db;
}

/** `scratch_path P`: a throwaway location (the runtime's $TMPDIR or /tmp) outside the project root; stricter than the shell about `..` and links. @param {Ctx} ctx @param {string} p */
function scratchPath(ctx, p) {
  const textual = (/** @type {string} */ q) => {
    const sp = q.startsWith('/private') ? q.slice(8) : q;
    const sr = ctx.root.startsWith('/private') ? ctx.root.slice(8) : ctx.root;
    if (sp === sr || sp.startsWith(`${sr}/`)) return false;
    if (sp.startsWith('/tmp/') || sp.startsWith('/var/folders/') || sp.startsWith('$TMPDIR/') || sp.startsWith('${TMPDIR}/')) return true;
    const t = ctx.env.TMPDIR;
    if (t) { let x = t.replace(/\/$/, ''); if (x.startsWith('/private')) x = x.slice(8); if (sp.startsWith(`${x}/`)) return true; }
    return false;
  };
  if (!textual(p)) return false;
  if (`/${p}/`.includes('/../')) return false;
  if (p.startsWith('/')) {
    // a link from scratch into the project is no scratch
    let d = p;
    for (let i = 0; i < 64 && d !== '/' && !isDir(d); i++) d = dn(d);
    const real = physDir(d);
    if (real !== '' && !textual(real + p.slice(d.length))) return false;
  }
  return true;
}

/** `db_is_path TOKEN` @param {string[]} globs @param {string} tok */
function dbIsPath(globs, tok) {
  for (const g of globs) {
    if (g.includes('/')) { if (globMatch(tok, g) || globMatch(tok, `*/${g}`)) return true; } else if (globMatch(tok.slice(tok.lastIndexOf('/') + 1), g)) return true;
  }
  return false;
}

/** `db_check_token TOKEN WHAT`: deny unless TOKEN is no database file or a scratch one. @param {Ctx} ctx @param {string} tok @param {string} what */
export async function dbCheckToken(ctx, tok, what) {
  const globs = await dbPaths(ctx);
  if (!dbIsPath(globs, tok)) return;
  if (scratchPath(ctx, tok)) return;
  deny(ctx, `${what} names the database file '${tok}'. No agent reads, copies, queries or writes a database file while a run is open (a test suite's own throwaway database under \$TMPDIR is the only exception). Existing rows are evidence only through the project's seed files and the test suite; record what you could not check as an open point in EVIDENCE.md`);
}

/** The database guard of a file tool: the targets, then the path, pattern fields of the input (`db_load` + the dbt loop). @param {Ctx} ctx @param {string} tool @param {string[]} targets */
export async function dbGuardFiles(ctx, tool, targets) {
  /** @type {string[]} */ const toks = [...targets];
  for (const k of ['tool_input.file_path', 'tool_input.notebook_path', 'tool_input.path', 'tool_input.pattern']) {
    toks.push(...ctx.get(k).split('\n'), ''); // jget prints the value and a newline: a value of several lines is several tokens
  }
  await dbPaths(ctx);
  for (const t of toks) if (t !== '') await dbCheckToken(ctx, t, tool);
}
