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
import { cmdSubst, isAbsPath, isWin, posix } from '../lib/text.mjs';
import { fold, insensitiveAt } from '../lib/fscase.mjs';
import { scanCommand, scanRegions } from '../command-scan.mjs';

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
  return `agent.sh ${f.command} exited ${f.status}, so a guard cannot read the run state and fails closed: this command runs in Node and the user must check that Node 22.13 or newer is on PATH (tell the user; a model command cannot fix or diagnose it)`;
}

/**
 * `mc_fail COMMAND WHEN STATUS GUARD`: fail closed when a guard's moved command exits non-zero. WHEN run: only while a run exists; any: always.
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} command @param {'run' | 'any'} when @param {number} status @param {string} guard
 */
export function mcFail(ctx, command, when, status, guard) {
  if (ctx.ev !== 'pretool') return;
  if (when === 'run' && ctx.act === '') return;
  deny(`agent.sh ${command} exited ${status}, so the ${guard} cannot read its settings and fails closed: this command runs in Node and the user must check that Node 22.13 or newer is on PATH (tell the user; a model command cannot fix or diagnose it)`);
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
        return m ? posix(resolve(d, /** @type {string} */ (m[1]))) : null;
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
      try { common = posix(resolve(gd, readFileSync(`${gd}/commondir`, 'utf8').replace(/\n+$/, ''))); } catch { /* the main git dir itself */ }
      if (basename(common) === '.git') {
        /** @type {string[]} */ const out = [posix(dirname(common))];
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

const ENV_WORDS = ['env', 'sudo', 'doas'];
/**
 * Does the text hold `(env|sudo|doas)[[:space:]]+([^;&|]*[[:space:]])?(-[A-Za-z]*[CD]|--chdir)`, one line of it? The same verdict as that regular expression in time linear in the text (the expression
 * backtracks to the end of the text once per `env`: 36000 repeats took 20 s). `boundary`: the keyword must follow a character outside `[A-Za-z0-9_.-]`
 * or the start (the stash guard).
 * A keyword followed by white space starts a run that reaches to the next `;`, `&` or `|`; inside it any option that follows a white space character after the keyword's own white space counts.
 * @param {string} text @param {boolean} boundary @param {{ steps: number }} [probe] counts the characters visited (for the test of the linear bound)
 */
export function envChdirOpt(text, boundary, probe) {
  const n = text.length;
  /** @param {string | undefined} c */
  const ws = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
  let p = 0;
  while (p < n) {
    let e = p;
    while (e < n && text[e] !== ';' && text[e] !== '&' && text[e] !== '|') e++;
    if (probe) probe.steps += e - p + 1;
    // the end of the earliest keyword of this run that is followed by white space
    let kend = -1;
    for (let i = p; i < e; i++) {
      if (probe) probe.steps++;
      if (boundary && i > 0 && /[A-Za-z0-9_.-]/.test(/** @type {string} */ (text[i - 1]))) continue;
      for (const k of ENV_WORDS) {
        if (text.startsWith(k, i) && ws(text[i + k.length]) && (kend < 0 || i + k.length < kend)) kend = i + k.length;
      }
    }
    if (kend >= 0) {
      for (let q = kend + 1; q < e; q++) {
        if (probe) probe.steps++;
        if (text[q] !== '-' || !ws(text[q - 1])) continue;
        if (text.startsWith('--chdir', q)) return true;
        for (let j = q + 1; j < e && /[A-Za-z]/.test(/** @type {string} */ (text[j])); j++) {
          if (probe) probe.steps++;
          if (text[j] === 'C' || text[j] === 'D') return true;
        }
      }
    }
    p = e + 1;
  }
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
  // a Windows root (`C:/`, `//srv/share`) is its own parent
  if (isWin() && /^([A-Za-z]:|\/\/[^/]+\/[^/]+)\/*$/.test(p)) return /^[A-Za-z]:/.test(p) ? `${p.slice(0, 2)}/` : p.replace(/\/+$/, '');
  let r = p;
  while (r.length >= 2 && r.endsWith('/')) r = r.slice(0, -1);
  if (r.includes('/')) {
    r = r.slice(0, r.lastIndexOf('/'));
    while (r.length >= 2 && r.endsWith('/')) r = r.slice(0, -1);
    if (r === '') r = '/';
    else if (isWin() && /^[A-Za-z]:$/.test(r)) r = `${r}/`;
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
  try { if (!statSync(p).isDirectory()) return ''; return posix(realpathSync.native(p)); } catch { return ''; }
}

/** An absolute path in the hook's spelling: `/x`, and on a Windows host `C:/x` too (elsewhere `C:/x` is a name under the working directory). @param {string} p */
export function isAbsolute(p) { return isAbsPath(p); }

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
  if (!isAbsolute(q)) { if (!base) return ''; q = `${base}/${q}`; }
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

/** The command words of TEXT are read without regard to case (A278): on a volume that folds case `Agent.SH` runs agent.sh and `Kill` runs kill. The files a command word names live where the shell
 * looks: the working directory for a path, the PATH folders for a bare word; any of them folding case (or not decidable, which fails closed) is enough. Text without a capital letter needs no fold and no probe.
 * @param {import('../lib/context.mjs').HookContext} ctx @param {string} text */
export function foldCommands(ctx, text) {
  if (!NEEDS_FOLD.test(text)) return false;
  const dirs = [ctx.cwd || '.', ...(ctx.env.PATH ?? '').split(isWin() ? ';' : ':').filter((d) => d.startsWith('/'))];
  return dirs.some((d) => insensitiveAt(d)) || insensitiveAt(ctx.root); // the project folder holds the protected names
}

/** A capital letter, or any non-ASCII character (the long s and the Kelvin sign fold to ASCII letters): the only texts a case fold can change. */
const NEEDS_FOLD = /[A-Z\u0080-￿]/;

/** The program names the guards know, in the one spelling their lower-case tests expect (A278). */
export const KNOWN_WORDS = new Set(`git gh find xargs kill pkill killall killall5 skill slay fuser pgrep pidof lsof ps nohup env sudo doas command builtin exec time nice ionice stdbuf timeout setsid caffeinate unbuffer watch flock taskset chrt nsenter strace ltrace runuser su script
  sh bash dash zsh ksh ash mksh posh yash eval source cd pushd popd npm pnpm yarn bun npx pnpx node nodejs deno python python3 pytest go cargo dotnet mvn gradle jest vitest make rtk
  rm mv cp tee truncate ed ex vi vim view nvim patch gpatch install dd chmod chown chgrp ln shred unlink rmdir touch mkdir sed gsed perl ruby php awk gawk mawk curl wget tar unzip rsync mktemp
  az bsdtar busybox fd fish glab gtar lua mkfifo mknod nawk osascript proofline pypy pypy3 systemd-run
  cat head tail echo printf sqlite3 sqlite duckdb litecli psql mysql claude codex agent.sh dispatch.sh proofline-core.mjs proofline-core`.split(/\s+/));

/** One token of a command line in its folded spelling (see foldWords). @param {string} tok @param {number} off @param {string} line @param {string} root */
function foldToken(tok, off, line, root) {
  const segs = tok.split('/');
  // a word that names the .agents folder or the control plane is folded with the path below it, never the path above it (an absolute project prefix keeps its case)
  let changed = false;
  for (let i = 0; i < segs.length; i++) {
    const s = /** @type {string} */ (segs[i]);
    const f = fold(s);
    if (f === '.agents') { for (let j = i; j < segs.length; j++) { const g = fold(/** @type {string} */ (segs[j])); if (g !== segs[j]) { segs[j] = g; changed = true; } } break; }
    if (f.startsWith('proofline-core') && f !== s) { segs[i] = f; changed = true; }
  }
  if (changed) return segs.join('/');
  if (/[<>][ \t]*$/.test(line.slice(Math.max(0, off - 8), off))) return tok; // a file name after a redirection operator
  const last = /** @type {string} */ (segs[segs.length - 1]);
  const f = fold(last);
  if (f === last || !KNOWN_WORDS.has(f)) return tok;
  if (segs.length > 1 && !(tok.startsWith('/') && (root === '' || !tok.startsWith(`${root}/`)))) return tok; // a name inside a relative or project path is a file, not a program
  segs[segs.length - 1] = f;
  return segs.join('/');
}

/** TEXT with every program name the guards know, in any case or Unicode form, in its lower-case spelling (A278): `Git`, `XARGS`, `Pkill`, `Agent.SH`, `ſh`; a word below `.agents` (and the control plane's name) is folded with the path after it,
 * never the path before it (the project's own absolute path keeps its case), and a program name inside a project or relative path is a file name. A file name after a redirection operator stays as typed.
 * The text keeps its line structure: the here-document delimiters, bodies and terminators the SCANNER finds (command-scan scanRegions: the reading every guard trusts, inside `"$(...)"`, backticks and `sh -c` strings too) are copied as typed, so a case variant sees the same here-documents as its lower-case twin (a body fed to a shell is scanned on its own by the scanner). It is applied only where the volume folds case, at every position
 * of the text at once (top level, after a wrapper, in find -exec, xargs, sh -c, substitutions), and the guards run on it in addition to the text as typed. @param {string} text @param {string} [root] the project root
 */
export function foldWords(text, root = '') {
  const { regions } = scanRegions(text, { fold: true });
  let out = ''; let at = 0;
  /** @param {number} a @param {number} b */
  const words = (a, b) => { const seg = text.slice(a, b); out += seg.replace(/[^\s;&|(){}<>`'"=$]+/g, (tok, off) => foldToken(tok, off, seg, root)); };
  for (const [x, y] of regions) { words(at, x); out += text.slice(x, y); at = y; }
  words(at, text.length);
  return out;
}

/** `scanCommand` with the case rule of the volume (A278). @param {import('../lib/context.mjs').HookContext} ctx @param {string} text */
export function scanFor(ctx, text) { return scanCommand(text, { fold: foldCommands(ctx, text) }); }
