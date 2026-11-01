// @ts-check
// The path policy of the PreToolUse guards (proofline-hook.sh lines 374-640): which path a caller may write now.
//
// Every "ok?" function answers null (allowed) or the reason (a string, the text of the shell hook's `echo` before `return 1`).
//   relpath(ctx, p)        project-relative path of P ("@outside", "@unknown", "." for the root); relpathAbs also gives the absolute path
//   targetOk(ctx, p)       may the caller write P now (links refused, then pathOk on the resolved path)
//   pathOk(ctx, rel)       the run's rules by role (A143, A159, owns.conf, windows)
//   nrPathOk(ctx, rel)     the lead's rules while NO run is active (A169)
//   erasable(ctx, p)       a deletion of P may pass although the policy refuses it (a file the run created)
//   outsideOk(ctx, p)      a path outside the project that a Write/Edit may still touch (registered worktrees, the runtime's own storage)
//   roOperand(ctx, kind, w)  the read role's in-place editing operands (A143)
//   roTail(ctx)            the sentence a read role's denial ends with
//   baseline(ctx)          once per run: the untracked files that exist before the run changes anything
//   alwaysProtected(rel)   the git hooks and the git config that wires them
import { lstatSync, realpathSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { putAtomic, mkdirp, isFile, isDir, readText, rmf } from '../lib/fsx.mjs';
import { canon, cmdSubst } from '../lib/text.mjs';
import { bn, dn, git, globMatch, hcfgLoad, mcFlag, stateOf, worktrees } from './kit.mjs';

/** The roles that work in the project tree without writing to it (A143): the sentence their denials end with. @param {import('../lib/context.mjs').HookContext} ctx */
export function roTail(ctx) {
  if (!ctx.ro) return '';
  return ` (role ${ctx.role} is read-only in the project working tree, A143: mutation, trials and fix attempts run only in an evidence worktree, a git worktree outside the project that you create under $TMPDIR: git worktree add --detach "$TMPDIR/<name>" HEAD, in its own call, then use literal paths inside it; git worktree list shows it. Allowed in the project: your run result files and .agents/runs/<ID>/scratch/)`;
}

/** @param {string} rel */
export function alwaysProtected(rel) {
  return rel === '.agents/githooks' || rel.startsWith('.agents/githooks/') || rel === '.git/config' || rel.startsWith('.git/config.');
}

/** @param {string} p */
function physical(p) { try { return realpathSync.native(p).split(path.sep).join('/'); } catch { return ''; } }

/** @type {Promise<(p: string) => string> | null} */
let normFn = null;
/**
 * A path from the runtime in POSIX form: Windows drive, UNC and backslash spellings are converted before anything resolves them
 * (core/paths.mjs normalizeInputPath of the project, else of this repository, else backslashes only). Plain POSIX paths pass untouched.
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} p
 */
export async function inputPath(ctx, p) {
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

/** An absolute path; a drive spelling counts only on a Windows host (elsewhere `C:/x` is a name under the working directory, as in the shell). @param {string} p */
function isAbs(p) { return p.startsWith('/') || (process.platform === 'win32' && /^[A-Za-z]:\//.test(p)); }

/** Per-event memo of relpath answers. @type {WeakMap<object, Map<string, { rel: string, abs: string }>>} */
const RELS = new WeakMap();

/**
 * `relpath P [abs]`: the project-relative path of P (resolved against cwd; every existing parent directory resolved PHYSICALLY, so `link/..` is
 * the parent of the link target, not the textual parent the shell's `cd` produced). Stricter than the shell on purpose: Windows spellings are
 * converted first, and an existing last component takes the case it has on disk (macOS: `run.yaml` is `RUN.yaml`).
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} p0 @returns {Promise<{ rel: string, abs: string }>}
 */
export async function relpathAbs(ctx, p0) {
  let memo = RELS.get(ctx);
  if (!memo) { memo = new Map(); RELS.set(ctx, memo); }
  const hit = memo.get(p0);
  if (hit) return hit;
  const r = await relpathCompute(ctx, p0);
  memo.set(p0, r);
  return r;
}

/** @param {import('../lib/context.mjs').HookContext} ctx @param {string} p0 */
async function relpathCompute(ctx, p0) {
  const p = await inputPath(ctx, p0);
  let rp = isAbs(p) ? p : `${ctx.cwd}/${p}`;
  let dir = dn(rp);
  let tail = bn(rp);
  while (!isDir(dir)) {
    try { if (lstatSync(dir).isSymbolicLink()) return { rel: '@unknown', abs: '' }; } catch { /* not there */ }
    tail = `${bn(dir)}/${tail}`;
    const up = dn(dir);
    if (up === dir) return { rel: '@unknown', abs: '' };
    dir = up;
  }
  if (`/${tail}/`.includes('/../') || `/${tail}/`.includes('/./')) return { rel: '@unknown', abs: '' };
  const phys = physical(dir);
  if (phys === '') return { rel: '@unknown', abs: '' };
  // an existing last component keeps the case it has on disk (never a link: the link itself is judged by target_ok)
  if (!tail.includes('/')) {
    try {
      if (!lstatSync(`${phys}/${tail}`).isSymbolicLink()) tail = path.basename(realpathSync.native(`${phys}/${tail}`));
    } catch { /* not there yet */ }
  }
  rp = phys === '/' ? `/${tail}` : `${phys}/${tail}`;
  // A184: a session whose project root is a run worktree still protects the MAIN tree
  const root = physical(ctx.root) || ctx.root; const main = physical(ctx.mainRoot) || ctx.mainRoot;
  let base = '';
  if (rp === root || rp.startsWith(`${root}/`)) base = root;
  else if (rp === main || rp.startsWith(`${main}/`)) base = main;
  if (base === '') return { rel: '@outside', abs: rp };
  if (rp === base) return { rel: '.', abs: rp };
  let rel = rp.slice(base.length + 1);
  // A184: a path inside a run's own git worktree is judged relative to THAT worktree's root (agent.sh worktree-root decides)
  if (/^\.agents\/local\/worktrees\/.*\/.*$/s.test(rel) && ctx.installed) {
    const r = await ctx.agent(['worktree-root', rp], { keepRole: true });
    const w = cmdSubst(r.stdout);
    if (r.status === 0 && w !== '' && rp.startsWith(`${w}/`)) rel = rp.slice(w.length + 1);
  }
  return { rel, abs: rp };
}

/** @param {import('../lib/context.mjs').HookContext} ctx @param {string} p */
export async function relpath(ctx, p) { return (await relpathAbs(ctx, p)).rel; }

/** `outside_ok P`. @param {import('../lib/context.mjs').HookContext} ctx @param {string} p @returns {Promise<string | null>} */
export async function outsideOk(ctx, p) {
  let oo = (await relpathAbs(ctx, p)).abs;
  if (oo.startsWith('/private')) oo = oo.slice(8);
  let h = (ctx.env.HOME ?? '') || '/nonexistent-home';
  h = h.replace(/\/+/g, '/');
  if (h.startsWith('/private')) h = h.slice(8);
  if (oo.startsWith(`${h}/.claude/projects/`)) {
    const tail = oo.slice(h.length + '/.claude/projects/'.length);
    if (globMatch('*/memory/*', tail) || globMatch('*/tool-results/*', tail)) return null;
  }
  if (oo.startsWith(`${h}/.claude/plans/`)) return null;
  const rootN = ctx.root.replace(/^\/private/, '');
  for (const w0 of await worktrees(ctx)) {
    const w = w0.replace(/^\/private/, '');
    if (w === rootN) continue;
    if (oo.startsWith(`${w}/`)) return null;
  }
  return `${p} is outside the project. A run writes nothing outside the copy (registered worktrees and the runtime's own storage excepted); a path that merely shares a prefix with the project root is outside too`;
}

/** `target_ok P`. @param {import('../lib/context.mjs').HookContext} ctx @param {string} p0 @returns {Promise<string | null>} */
export async function targetOk(ctx, p0) {
  const p = await inputPath(ctx, p0);
  const abs = isAbs(p) ? p : `${ctx.cwd}/${p}`;
  try { if (lstatSync(abs).isSymbolicLink()) return 'the target is a symbolic link; writes through links are never allowed during a run'; } catch { /* absent */ }
  try { const st = statSync(abs); if (st.isFile() && st.nlink > 1) return 'the target has several hard links; writes through links are never allowed during a run'; } catch { /* absent */ }
  return pathOk(ctx, await relpath(ctx, p0));
}

/** `erasable P`. @param {import('../lib/context.mjs').HookContext} ctx @param {string} p0 @returns {Promise<boolean>} */
export async function erasable(ctx, p0) {
  const rel = await relpath(ctx, p0);
  if (rel.startsWith('@') || rel === '.' || rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.claude/') || rel.startsWith('.codex/')) return false;
  const scratch = rel.startsWith(`.agents/runs/${ctx.act}/scratch/`);
  if (!scratch && rel.startsWith('.agents/')) return false;
  const p = await inputPath(ctx, p0);
  const abs = isAbs(p) ? p : `${ctx.cwd}/${p}`;
  let exists = false;
  try { const st = lstatSync(abs); exists = st.isFile() || st.isSymbolicLink(); } catch { /* none */ }
  if (!exists) return false;
  if (scratch) return true;
  if (ctx.ro) return false; // A143: a read role leaves the project tree unchanged
  if (alwaysProtected(rel)) return false;
  const ls = await git(ctx, ['-C', ctx.sroot, 'ls-files', '--', rel]);
  if (ls && ls.stdout.trim() !== '') return false;
  const ig = await git(ctx, ['-C', ctx.sroot, 'check-ignore', '-q', '--', rel]);
  if (ig && ig.status === 0) return false;
  const bf = `${ctx.localDir}/baseline/${ctx.act}`;
  if (!isFile(bf)) return false;
  const lines = readText(bf).split('\n');
  return !lines.includes(rel);
}

/** `baseline`: once per run, the untracked, unignored files that exist before the run changes anything. @param {import('../lib/context.mjs').HookContext} ctx */
export async function baseline(ctx) {
  if (!ctx.installed || ctx.act === '' || ctx.act === 'INVALID') return;
  const file = `${ctx.localDir}/baseline/${ctx.act}`;
  if (isFile(file)) return;
  if (!mkdirp(`${ctx.localDir}/baseline`)) return;
  const proc = await ctx.agents?.proc();
  if (!proc) return;
  const r = proc.run('git', ['-C', ctx.sroot, 'ls-files', '-z', '--others', '--exclude-standard'], { env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return;
  const tmp = `${ctx.localDir}/baseline/.${ctx.act}.tmp`;
  try { putAtomic(file, tmp, r.stdout.toString('utf8').replace(/\0/g, '\n')); } catch { rmf(tmp); }
}

/** `own_match REL TOKEN BASE`. @param {string} rel @param {string} token @param {string} base */
function ownMatch(rel, token, base) {
  const t = base + token;
  if (t.endsWith('/')) return rel.startsWith(t);
  return globMatch(t.replace(/NNN/g, '[0-9][0-9][0-9]'), rel);
}

/** `knowledge_stage` (A159): is the active run in the knowledge step, CODE_DONE not yet DONE, or FAILED/BLOCKED? Any doubt: no. @param {import('../lib/context.mjs').HookContext} ctx */
async function knowledgeStage(ctx) {
  const r = await ctx.agent(['summary', ctx.act], { keepRole: true });
  const out = r.stdout;
  if (r.status !== 0 && out === '') mcFlag(ctx, 'summary', r.status);
  const found = [];
  for (const l of out.split('\n')) {
    const m = /^STATUS: ([A-Z_]*) \(handoff ([A-Za-z_]*),/.exec(l);
    if (m) found.push(`${m[1]} ${m[2]}`);
  }
  const s = found.join('\n');
  if (s === 'CODE_DONE DONE') return false;
  return s.startsWith('CODE_DONE ') || s.startsWith('FAILED ') || s.startsWith('BLOCKED ');
}

/** tasks.dir, once: hook-config, else config-get (a failing config-get is flagged). @param {import('../lib/context.mjs').HookContext} ctx */
export async function tasksDir(ctx) {
  const st = stateOf(ctx);
  if (st.tasksDir !== '') return st.tasksDir;
  let td = '';
  if (await hcfgLoad(ctx)) td = st.hc.tasks;
  else {
    const r = await ctx.agent(['config-get', 'tasks.dir'], { keepRole: true });
    if (r.status !== 0) { mcFlag(ctx, 'config-get', r.status); td = ''; } else td = cmdSubst(r.stdout);
  }
  if (td.endsWith('/')) td = td.slice(0, -1);
  if (td === '') td = '.agents/tasks';
  st.tasksDir = td;
  return td;
}

/** The owned-path tokens of a role: the line of .agents/owns.conf (`<role> <token>...`), else ''. @param {string} file @param {string} role */
function ownsLine(file, role) {
  if (!isFile(file)) return '';
  for (const l of readText(file).split('\n')) {
    const f = l.split(/[ \t]+/).filter((x) => x !== '');
    if (f[0] === role) return f.length > 1 ? ` ${f.slice(1).join(' ')}` : '';
  }
  return '';
}

/** `path_ok REL`: may the caller write REL now? @param {import('../lib/context.mjs').HookContext} ctx @param {string} po @returns {Promise<string | null>} */
export async function pathOk(ctx, po) {
  const run = `.agents/runs/${ctx.act}`;
  const role = ctx.role;
  const td = await tasksDir(ctx);
  if (po === '@outside') return null;
  if (po === '@unknown') return 'cannot resolve the target path';
  if (alwaysProtected(po)) return `${po} wires the git hooks; it is never changed by an agent`;
  // The lead writes dispatch assignments (DISPATCH.md); nothing else under .agents/local/.
  if (role === 'lead' && po.startsWith('.agents/local/assignments/')) return null;
  // Scratch files live in the run folder (D10, A56): writable by every role, never gate input.
  if (po.startsWith(`${run}/scratch/`)) return null;
  if (['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.codex/config.toml', '.agents/hooks'].includes(po) || po.startsWith('.agents/hooks/')) return `${po} holds the runtime hooks; it is never edited during a run`;
  if ([`${run}/RUN.yaml`, `${run}/LEDGER.log`, `${run}/HOOKS.log`, `${run}/mutation_budget`].includes(po)
    || ['gates/', 'approvals/', 'waivers/', 'questions/', 'decisions/', 'dispatch/', 'worker-evidence/', 'ci-fix/'].some((d) => po.startsWith(`${run}/${d}`))
    || (po.startsWith(`${run}/results/`) && (po.endsWith('.result.md') || po.slice(run.length + 9).startsWith('dispatch-')))
    || po === '.agents/local' || po.startsWith('.agents/local/')) {
    return `${po} is written only by agent.sh and the runtime hooks`;
  }
  if (role === 'lead') {
    if ([`${run}/TASK.md`, `${run}/PLAN.md`, `${run}/EVIDENCE.md`, `${run}/COMPLETION_REPORT.md`].includes(po) || po.startsWith(`${run}/amendments/`) || po.startsWith(`${td}/`)) return null;
    // A159: the knowledge step needs the wiki and the design documents: knowledge scope and design_docs paths only
    if (await knowledgeStage(ctx)) {
      const r = await ctx.agent(['in-knowledge-scope', po], { keepRole: true });
      if (r.status === 0) return null;
    }
    return `the lead writes only run artifacts (TASK.md PLAN.md EVIDENCE.md COMPLETION_REPORT.md amendments/), task files and .agents/local/assignments/ while run ${ctx.act} is active, plus knowledge scope and design_docs paths (docs/design/ docs/adr/ docs/wiki/ docs/product/) in the knowledge step after CODE_DONE (A159); product changes go through the implementer (D2)`;
  }
  // Specialists: the role's owned paths from .agents/owns.conf
  let own = ownsLine(`${ctx.sroot}/.agents/owns.conf`, role);
  if (own === '') {
    own = role === 'implementer' ? 'PRODUCT_SCOPE' : role === 'task_author' ? `@run /${td}/` : '@run';
  }
  let hit = false;
  for (const t of own.split(/[ \t\n]+/).filter((x) => x !== '')) {
    if (t === '@run') { if (po.startsWith(`${run}/`)) hit = true; }
    else if (t === 'PRODUCT_SCOPE') {
      if (po.startsWith(`${run}/`)) hit = true;
      for (const s of planScope(`${ctx.sroot}/${run}/PLAN.md`)) {
        if (s.endsWith('/')) { if (po.startsWith(s)) hit = true; } else if (po === s) hit = true;
      }
    } else if (t.startsWith('/')) { if (ownMatch(po, t.slice(1), '')) hit = true; } else if (ownMatch(po, t, `${run}/`)) hit = true;
    if (hit) break;
  }
  if (!hit) return `${po} is outside the paths role ${role} owns (${own}; .agents/owns.conf, PLAN.md scope)`;
  const inRun = po.startsWith(`${run}/`);
  if ((role === 'implementer' || role === 'designer') && ctx.sub && !inRun) {
    // A headless specialist (dispatch.sh, also the failover codex -> claude) has AGENT_ROLE in the hook's environment
    const envrole = canon(ctx.env.AGENT_ROLE ?? '');
    if (!isFile(`${ctx.localDir}/windows/${ctx.aidf}`) && envrole !== role) return `no ${role} window is open for this subagent (SubagentStart window-open failed or was skipped); the change would be unattributed`;
  }
  return null;
}

/** The scope paths of PLAN.md (the awk of path_ok): the lines `  - path: X` between `scope:` and `---`. @param {string} plan @returns {string[]} */
function planScope(plan) {
  const out = [];
  let i = false;
  for (const l of readText(plan).split('\n')) {
    if (l === 'scope:') { i = true; continue; }
    if (i && l === '---') break;
    if (i && l.startsWith('  - path: ')) out.push(...l.slice(10).replace(/["']/g, '').split(/[ \t\n]+/).filter((x) => x !== ''));
  }
  return out;
}

const NR_STATE = ['.agents/runs/*/RUN.yaml', '.agents/runs/*/LEDGER.log', '.agents/runs/*/HOOKS.log', '.agents/runs/*/mutation_budget', '.agents/runs/*/gates/*', '.agents/runs/*/approvals/*', '.agents/runs/*/waivers/*', '.agents/runs/*/questions/*', '.agents/runs/*/decisions/*', '.agents/runs/*/dispatch/*', '.agents/runs/*/worker-evidence/*', '.agents/runs/*/ci-fix/*', '.agents/runs/*/results/*.result.md', '.agents/runs/*/results/dispatch-*', '.agents/hooks', '.agents/hooks/*'];

/** `nr_path_ok REL` (A169): may the lead (main session) write REL while NO run is active? @param {import('../lib/context.mjs').HookContext} ctx @param {string} np @returns {Promise<string | null>} */
export async function nrPathOk(ctx, np) {
  const td = await tasksDir(ctx);
  if (np === '@outside') return null;
  if (np === '@unknown') return 'cannot resolve the target path';
  if (NR_STATE.some((g) => globMatch(g, np))) {
    return `${np} is written only by agent.sh and the runtime hooks`;
  }
  if (np.startsWith('.claude/settings') || np.startsWith('.codex/') || np.startsWith('.agents/scripts/') || ['.agents/config.yaml', '.agents/ecosystems.json', '.agents/ecosystems.tsv', '.agents/ecosystems.mjs'].includes(np)) {
    return `${np} holds the runtime hooks, the control-plane scripts, the configuration or the ecosystem definition (the risky-path and dependency sets, A174); the lead never edits it itself (A169)`;
  }
  if (['scratch/', 'explain/', 'assignments/', 'product-spec/', 'product-discovery/', 'intent-grill/', 'task-author/'].some((d) => np.startsWith(`.agents/local/${d}`))) return null;
  if (np === '.agents/local' || np.startsWith('.agents/local/')) return `${np} is runtime state (approvals, prompts, windows, records); the lead writes under .agents/local/ only in scratch/, explain/, assignments/ and the standalone skill folders (product-spec, product-discovery, intent-grill, task-author)`;
  if (np.startsWith(`${td}/`) || np.startsWith('.agents/')) return null;
  const ig = await git(ctx, ['-C', ctx.sroot, 'check-ignore', '-q', '--', np]);
  if (ig && ig.status === 0) return null;
  const ks = await ctx.agent(['in-knowledge-scope', np], { keepRole: true });
  if (ks.status === 0) return null;
  // product.dir (product-spec output) may be set to another folder than docs/product
  let pd;
  if (await hcfgLoad(ctx)) pd = stateOf(ctx).hc.product;
  else {
    const r = await ctx.agent(['config-get', 'product.dir'], { keepRole: true });
    if (r.status !== 0) { mcFlag(ctx, 'config-get', r.status); pd = ''; } else pd = cmdSubst(r.stdout);
  }
  if (pd.endsWith('/')) pd = pd.slice(0, -1);
  if (!(pd === '' || pd === '.' || pd.startsWith('/') || pd.includes('..')) && np.startsWith(`${pd}/`)) return null;
  return `no run is active, and the lead never edits product files itself (D2, A169). Propose a light run (TRIVIAL or STANDARD) with '/proofline run <text>' and let the implementer make the change; the push approval then binds to that run. Without a run the lead writes only task files (${td}/), .agents/, the knowledge scope (docs/design/ docs/adr/ docs/wiki/ docs/product/) and git-ignored files`;
}

/**
 * `ro_operand KIND WORD` (A143): may a read role pass WORD, an operand of an in-place editing command (KIND P: only an existing file counts) or
 * of a script editor (KIND Q: any path counts)? @param {import('../lib/context.mjs').HookContext} ctx @param {string} kind @param {string} word @returns {Promise<string | null>}
 */
export async function roOperand(ctx, kind, word) {
  let v = word;
  if (v === '.') v = ctx.cwd; else if (v.endsWith('/.')) v = v.slice(0, -2);
  const rest = () => v.slice(v.indexOf('/') + 1);
  if (v.startsWith('$TMPDIR/') || v.startsWith('${TMPDIR}/')) v = `${ctx.env.TMPDIR || '/tmp'}/${rest()}`;
  else if (v.startsWith('~/') || v.startsWith('$HOME/') || v.startsWith('${HOME}/')) v = `${ctx.env.HOME || '/nonexistent-home'}/${rest()}`;
  if (v.includes('$') || v.includes('`') || v.startsWith('~')) {
    if (/[ \t\n\v\f\r;{(=]/.test(v)) return null;
    return `the path '${word}' of an in-place edit cannot be resolved from the command text`;
  }
  const abs = v.startsWith('/') ? v : `${ctx.cwd}/${v}`;
  if (kind !== 'Q' && !existsSync(abs)) return null;
  if ((await relpath(ctx, v)) === '@outside') return null;
  return targetOk(ctx, v);
}
