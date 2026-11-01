// @ts-check
// Shared pieces of the PreToolUse guards (bash.mjs, read.mjs, write.mjs and what they import).
//
//   deny(reason)            throws Deny: the guard stops there, as the shell hook's `deny` (print, exit 0). A guard FUNCTION never returns a
//                           deny from deep inside; the guard entry (bashGuard ...) catches it and returns { decision: 'deny', reason }.
//   stateOf(ctx)            per-event memo of the guards (tasks.dir, hook-config answers, the failed-moved-command flag)
//   mcFlag / mcFail         ADR 0001 5.3: a moved command (core) that fails while a guard needs it makes the guard fail closed
//   hcfgLoad(ctx)           `agent.sh hook-config` once per event (tasks_dir, canonical_branch, product_dir, database settings)
//   git(ctx, args)          one git call through the project's proc.mjs (the only module that starts children)
//   grepq / globMatch       `grep -Eq` over a multi-line text (per line), shell `case` pattern matching
//   stashPath               a directory named in command text, resolved the way the shell hook's stash_path did
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { cmdSubst } from '../lib/text.mjs';

/** The refusal of a guard (the text without the "proofline: " prefix). */
export class Deny extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.reason = reason; }
}

/** @param {string} reason @returns {never} */
export function deny(reason) { throw new Deny(reason); }

/**
 * @typedef {object} GuardState
 * @property {string} tasksDir tasks.dir ('' until asked)
 * @property {'' | 'ok' | 'no'} hcState
 * @property {{ tasks: string, branch: string, product: string, paths: string, clients: string, migrate: string }} hc
 * @property {{ command: string, status: number } | null} mcfail the first moved command that failed under a guard
 * @property {boolean} dbLoaded
 * @property {string} dbPaths @property {string} dbClients @property {string[]} dbMigrate
 * @property {string[] | null} wts registered git worktrees (git worktree list --porcelain)
 */

/** @type {WeakMap<object, GuardState>} */
const states = new WeakMap();

/** @param {import('../lib/context.mjs').HookContext} ctx @returns {GuardState} */
export function stateOf(ctx) {
  let s = states.get(ctx);
  if (!s) {
    s = { tasksDir: '', hcState: '', hc: { tasks: '', branch: '', product: '', paths: '', clients: '', migrate: '' }, mcfail: null, dbLoaded: false, dbPaths: '', dbClients: '', dbMigrate: [], wts: null };
    states.set(ctx, s);
  }
  return s;
}

/**
 * `mc_flag COMMAND STATUS`: a call site that cannot deny itself records the failure; the router turns it into the PreToolUse deny when the
 * event ends without an answer. Only while a run exists, like the database guard.
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} command @param {number} status
 */
export function mcFlag(ctx, command, status) {
  if (ctx.ev !== 'pretool' || ctx.act === '') return;
  stateOf(ctx).mcfail = { command, status };
}

/** `mc_text`: the sentence about the failed moved command. @param {{ command: string, status: number }} f */
export function mcText(f) {
  return `agent.sh ${f.command} exited ${f.status}, so a guard cannot read the run state and fails closed: this command runs in Node and the user must check that Node 22.13 or newer is on PATH (tell the user; a model command cannot fix or diagnose it), or write sh into .agents/local/engine to run the old shell code`;
}

/**
 * `mc_fail COMMAND WHEN STATUS GUARD`: fail closed when a guard's moved command exits non-zero. WHEN run: only while a run exists; any: always.
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} command @param {'run' | 'any'} when @param {number} status @param {string} guard
 */
export function mcFail(ctx, command, when, status, guard) {
  if (ctx.ev !== 'pretool') return;
  if (when === 'run' && ctx.act === '') return;
  deny(`agent.sh ${command} exited ${status}, so the ${guard} cannot read its settings and fails closed: this command runs in Node and the user must check that Node 22.13 or newer is on PATH (tell the user; a model command cannot fix or diagnose it), or write sh into .agents/local/engine to run the old shell code`);
}

/**
 * `hcfg_load`: ask hook-config ONCE per event (the callers fall back to a command per value when it fails). @param {import('../lib/context.mjs').HookContext} ctx
 * @returns {Promise<boolean>}
 */
export async function hcfgLoad(ctx) {
  const st = stateOf(ctx);
  if (st.hcState === 'ok') return true;
  if (st.hcState === 'no') return false;
  st.hcState = 'no';
  if (!ctx.installed) return false;
  const r = await ctx.agent(['hook-config']);
  if (r.status !== 0) return false;
  const hc = { tasks: '', branch: '', product: '', paths: '', clients: '', migrate: '' };
  const lines = r.stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const l of lines) {
    if (l.startsWith('tasks_dir=')) hc.tasks = l.slice(10);
    else if (l.startsWith('canonical_branch=')) hc.branch = l.slice(17);
    else if (l.startsWith('product_dir=')) hc.product = l.slice(12);
    else if (l.startsWith('paths=')) hc.paths = l.slice(6);
    else if (l.startsWith('clients=')) hc.clients = l.slice(8);
    else if (l.startsWith('migrate_commands=')) hc.migrate = l.slice(17);
  }
  st.hc = hc;
  st.hcState = 'ok';
  return true;
}

/**
 * One git call (through the project's proc.mjs). Returns null when proc.mjs is missing. @param {import('../lib/context.mjs').HookContext} ctx
 * @param {string[]} args @param {{ cwd?: string }} [opt] @returns {Promise<{ status: number, stdout: string } | null>}
 */
export async function git(ctx, args, opt = {}) {
  const proc = await ctx.agents?.proc();
  if (!proc) return null;
  const r = proc.run('git', args, { cwd: opt.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status, stdout: r.stdout.toString('utf8') };
}

/** The git dir of a working directory: walks up to the nearest `.git` (a folder, or a `gitdir:` file). null when none. @param {string} start */
function findGitDir(start) {
  let d = start;
  for (;;) {
    const g = `${d}/.git`;
    try {
      const st = statSync(g);
      if (st.isDirectory()) return g;
      if (st.isFile()) {
        const m = /^gitdir: (.*)$/m.exec(readFileSync(g, 'utf8'));
        return m ? resolve(d, /** @type {string} */ (m[1])) : null;
      }
    } catch { /* keep walking */ }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The registered worktrees of the project: `git -C root worktree list --porcelain | sed -n 's/^worktree //p'`. Read from the common git dir (the main
 * working tree and the `gitdir` file of every linked one) without a process; any unusual layout asks git.
 * @param {import('../lib/context.mjs').HookContext} ctx @returns {Promise<string[]>}
 */
export async function worktrees(ctx) {
  const st = stateOf(ctx);
  if (st.wts) return st.wts;
  const gd = ctx.env.GIT_DIR || ctx.env.GIT_COMMON_DIR || ctx.env.GIT_WORK_TREE ? null : findGitDir(ctx.root);
  if (gd) {
    try {
      let common = gd;
      try { common = resolve(gd, readFileSync(`${gd}/commondir`, 'utf8').replace(/\n+$/, '')); } catch { /* the main git dir itself */ }
      if (basename(common) === '.git') {
        /** @type {string[]} */ const out = [dirname(common)];
        let names = [];
        try { names = readdirSync(`${common}/worktrees`).sort(); } catch { /* none */ }
        for (const n of names) {
          let t = '';
          try { t = readFileSync(`${common}/worktrees/${n}/gitdir`, 'utf8').replace(/\n+$/, ''); } catch { continue; }
          if (!t.endsWith('/.git')) throw new Error('unusual worktree entry');
          out.push(t.slice(0, -5));
        }
        st.wts = out;
        return out;
      }
    } catch { /* ask git */ }
  }
  const r = await git(ctx, ['-C', ctx.root, 'worktree', 'list', '--porcelain']);
  st.wts = r ? r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)) : [];
  return st.wts;
}

/** `grep -Eq RE` over a text: does any line match? (the regular expression must not use ^ or $ across lines) @param {RegExp} re @param {string} text */
export function grepq(re, text) {
  for (const l of text.split('\n')) if (re.test(l)) return true;
  return false;
}

/** `[[:space:]]` of the C locale. */
export const SP = '[ \\t\\n\\v\\f\\r]';
/** `[:alnum:]` of the C locale, for a bracket expression. */
export const AL = 'A-Za-z0-9';

/** A shell `case` pattern (`*`, `?`, `[...]`, `\x`) as a whole-string test. @param {string} pat @param {string} str */
export function globMatch(pat, str) {
  let re = '^';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '\\' && i + 1 < pat.length) { i++; re += escapeRe(/** @type {string} */ (pat[i])); }
    else if (c === '[') {
      let j = i + 1;
      if (pat[j] === '!' || pat[j] === '^') j++;
      if (pat[j] === ']') j++;
      while (j < pat.length && pat[j] !== ']') j++;
      if (j >= pat.length) { re += '\\['; continue; }
      let body = pat.slice(i + 1, j);
      let neg = '';
      if (body[0] === '!' || body[0] === '^') { neg = '^'; body = body.slice(1); }
      re += `[${neg}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      i = j;
    } else re += escapeRe(c);
  }
  return new RegExp(`${re}$`).test(str);
}

/** @param {string} c */
function escapeRe(c) { return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

/** `dn_`: the dirname of a path as the hook's parameter expansion gave it. @param {string} p */
export function dn(p) {
  let r = p;
  while (r.length >= 2 && r.endsWith('/')) r = r.slice(0, -1);
  if (r.includes('/')) {
    r = r.slice(0, r.lastIndexOf('/'));
    while (r.length >= 2 && r.endsWith('/')) r = r.slice(0, -1);
    if (r === '') r = '/';
  } else r = '.';
  return r;
}

/** `bn_`: the basename. @param {string} p */
export function bn(p) {
  let r = p;
  while (r.length >= 2 && r.endsWith('/')) r = r.slice(0, -1);
  if (r !== '/') r = r.slice(r.lastIndexOf('/') + 1);
  return r;
}

/** The physical path (`cd -P && pwd -P`), or '' when it is not a directory. @param {string} p */
export function physDir(p) {
  try { if (!statSync(p).isDirectory()) return ''; return realpathSync.native(p); } catch { return ''; }
}

/**
 * `stash_path P BASE`: P resolved against BASE (physical when it exists; leading $TMPDIR and $HOME expanded). '' when the path cannot be
 * resolved from the text (another variable, command substitution, `-`, an unknown base, a directory that does not exist now).
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} p @param {string} [base]
 */
export function stashPath(ctx, p, base) {
  let q = p;
  const rest = () => q.slice(q.indexOf('/') + 1);
  if (q.startsWith('$TMPDIR/') || q.startsWith('${TMPDIR}/')) q = `${ctx.env.TMPDIR || '/tmp'}/${rest()}`;
  else if (q.startsWith('~/') || q.startsWith('$HOME/') || q.startsWith('${HOME}/')) q = `${ctx.env.HOME || '/nonexistent'}/${rest()}`;
  if (q === '' || q === '-' || q.startsWith('~') || /[$`*?]/.test(q)) return '';
  if (!q.startsWith('/')) { if (!base) return ''; q = `${base}/${q}`; }
  return cmdSubst(physDir(q));
}

const POSIX_CLASSES = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\v\\f\\r', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: ' -~', graph: '!-~',
};

/**
 * A POSIX extended regular expression (a project's `database.migrate_commands` entry) as a JavaScript RegExp: bracket classes `[:space:]` are
 * expanded. Returns null when the pattern is not valid (grep exits 2 for it and the guard then ignores that entry).
 * @param {string} ere @param {string} [flags]
 */
export function ereToJs(ere, flags = '') {
  const src = ere.replace(/\[:([a-z]+):\]/g, (m, n) => /** @type {Record<string, string>} */ (POSIX_CLASSES)[n] ?? m);
  try { return new RegExp(src, flags); } catch { return null; }
}

/** `$(...)`'s text of newline-separated words: the lines of a text without the final empty one. @param {string} t */
export function lines(t) {
  const l = t.split('\n');
  if (l.length > 0 && l[l.length - 1] === '') l.pop();
  return l;
}

/**
 * The parts of a `C` record (every simple command) the way the hook's `${rec#*TAB}` expansions saw them: the command word and its arguments with the
 * \003 separators turned into newlines (\002 line marks stay), `$(...)`-trimmed.
 * @param {import('../command-scan.mjs').Rec} rec @returns {{ cw: string, rest: string, args: string }}
 */
export function cParts(rec) {
  const raw = Buffer.from(rec.raw, 'latin1').toString('utf8');
  const t = raw.indexOf('\t');
  const cw = t < 0 ? raw : raw.slice(0, t);
  const rest = t < 0 ? '' : raw.slice(t + 1);
  return { cw, rest, args: cmdSubst(rest.replace(/\x03/g, '\n')) };
}
