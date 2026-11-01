// @ts-check
// Stage 3: the logic of githooks/pre-commit and githooks/pre-push (D19, D34) and githooks/human.sh as core subcommands (`cli pre-commit`,
// `cli pre-push`); the launchers that call them are written by the wiring package. Same checks, same order, same refusal texts, same
// exit codes (0 pass, 1 blocked, all text on stderr). The run commands the hooks ask (`open-runs`, `fingerprint`, `approval-consume`) run in
// process; `delivery-check` is not a Node command yet and is reached through the shell (the bridge) until stage 4.

import { ereToRegExp } from './ere.mjs';

import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { readBytes, textLines } from './records.mjs';
import { HANDLERS } from './commands/moved.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `case STRING in $PATTERN)` for a pattern taken from a variable: `\c` a literal c, `*` any string, `?` one character, `[...]` a class (`!` or `^` negates). @param {string} pat @param {string} s */
export function caseMatch(pat, s) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && i + 1 < pat.length) { re += pat[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue; }
    if (c === '*') { re += '[^]*'; continue; }
    if (c === '?') { re += '[^]'; continue; }
    if (c === '[') {
      let j = i + 1;
      if (pat[j] === '!' || pat[j] === '^') j++;
      if (pat[j] === ']') j++;
      while (j < pat.length && pat[j] !== ']') j++;
      if (j < pat.length) {
        let body = pat.slice(i + 1, j);
        let neg = '';
        if (body[0] === '!' || body[0] === '^') { neg = '^'; body = body.slice(1); }
        re += `[${neg}${body.replace(/\\/g, '\\\\').replace(/\[(?!:)/g, '\\[')}]`;
        i = j;
        continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`).test(s); } catch { return false; }
}

/** `human` (human.sh): no marker of an agent session. PROOFLINE_NO_TTY=1 forces "agent". @param {NodeJS.ProcessEnv} env */
export function human(env) {
  if ((env.PROOFLINE_NO_TTY ?? '0') === '1') return false;
  return ['AGENT_ROLE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'].every((k) => (env[k] ?? '') === '');
}

/** `cfg SECTION KEY` of the hooks: a two-level key, first match. @param {string} config the file text @param {string} section @param {string} key */
export function cfg2(config, section, key) {
  let inside = false;
  for (const line of textLines(config)) {
    if (line.startsWith(`${section}:`)) { inside = true; continue; }
    if (/^[^ #]/.test(line)) inside = false;
    if (inside && line.startsWith(`  ${key}:`)) {
      return line.replace(/^[^:]*:[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r]+#.*$/, '').replace(/"/g, '');
    }
  }
  return '';
}

class Blocked extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'Blocked'; }
}

/** @param {string} hook @param {string} message @returns {never} */
function block(hook, message) { throw new Blocked(`proofline ${hook}: BLOCKED: ${message}`); }

/** @param {Context} ctx @param {string[]} args */
function git(ctx, args) {
  const r = proc.run('git', args, { cwd: ctx.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
  return { status: r.status, out: r.stdout.toString('latin1') };
}

/**
 * One command of agent.sh as the hook asked it: in process when the core owns it, else through the shell. stdout and stderr in one list.
 * @param {Context} ctx @param {string[]} argv @returns {{ code: number, out: string, err: string }}
 */
function agent(ctx, argv) {
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  if (Object.hasOwn(HANDLERS, argv[0]) && ctx.runner !== null) {
    const io = { env: ctx.env, cwd: ctx.cwd, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, scriptPath: ctx.scriptPath, isProcess: false };
    const code = ctx.runner(argv, io);
    return { code, out: Buffer.concat(out).toString('latin1'), err: Buffer.concat(err).toString('latin1') };
  }
  const r = proc.run('sh', [`${ctx.scripts}/agent.sh`, ...argv], { cwd: ctx.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: r.stdout.toString('latin1'), err: r.stderr.toString('latin1') };
}

/** `email_of IDENT` @param {Context} ctx @param {string} which */
function emailOf(ctx, which) {
  const m = /.*<([^>]*)>/.exec(git(ctx, ['var', which]).out.split('\n')[0] ?? '');
  return m ? m[1] : '';
}

/** `forbidden EMAIL` @param {Context} ctx @param {string} config @param {string} email */
function forbidden(ctx, config, email) {
  const low = email.replace(/[A-Z]/g, (c) => c.toLowerCase());
  for (const p of cfg2(config, 'git', 'forbidden_identities').split(/[ \t\n]+/).filter((x) => x !== '')) {
    if (caseMatch(p.replace(/[A-Z]/g, (c) => c.toLowerCase()), low)) return true;
    const re = ereToRegExp(p, true);
    if (re !== null) { if (re.test(email)) return true; continue; }
    if (proc.run('grep', ['-Eiq', '-e', p], { input: `${email}\n`, env: ctx.env, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0) return true;
  }
  return false;
}

/** @param {Context} ctx @param {string} config @param {string} section */
function protectedBranches(config) { return cfg2(config, 'git', 'protected_branches').split(/[ \t\n]+/).filter((x) => x !== ''); }

/** The runs `open-runs` lists: [id, branch]. @param {Context} ctx @param {string} hook @returns {Array<[string, string]>} */
function openRuns(ctx, hook) {
  if (!isFile(`${ctx.scripts}/agent.sh`)) return [];
  const r = agent(ctx, ['open-runs']);
  if (r.code !== 0) block(hook, 'agent.sh open-runs failed; cannot tell whether a run is open');
  return textLines(r.out).map((l) => { const f = l.split(/[ \t]+/).filter((x) => x !== ''); return /** @type {[string, string]} */ ([f[0] ?? '', f[1] ?? '']); });
}

/** Run a hook body: a refusal is its stderr text and status 1. @param {Context} ctx @param {() => void} body */
function guarded(ctx, body) {
  try { body(); return 0; } catch (e) {
    if (e instanceof Blocked) { ctx.err(`${e.message}\n`); return 1; }
    throw e;
  }
}

/** githooks/pre-commit. @param {Context} ctx */
export function preCommit(ctx) {
  const H = 'pre-commit';
  return guarded(ctx, () => {
    const root = ctx.root;
    const config = readBytes(`${root}/.agents/config.yaml`) ?? '';
    if (forbidden(ctx, config, emailOf(ctx, 'GIT_AUTHOR_IDENT'))) block(H, 'the author email matches git.forbidden_identities in .agents/config.yaml; set a repository-local identity (git config user.email ...)');
    if (forbidden(ctx, config, emailOf(ctx, 'GIT_COMMITTER_IDENT'))) block(H, 'the committer email matches git.forbidden_identities in .agents/config.yaml; set a repository-local identity');
    const branch = git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD']).out.replace(/\n+$/, '');
    for (const pb of protectedBranches(config)) {
      if (caseMatch(pb, branch) && !human(ctx.env)) block(H, `branch '${branch}' is listed in git.protected_branches; agents never commit there`);
    }
    // 2b (A185) local files proofline copied into this run worktree never enter a commit, not even with `git add -f`; this holds for humans too
    const copied = readBytes(`${root}/.agents/local/worktree-copied`);
    if (copied !== null && copied.length > 0) {
      const set = new Set(copied.split('\n').filter((x, i, a) => !(i === a.length - 1 && x === '')));
      const hit = git(ctx, ['diff', '--cached', '--name-only']).out.split('\n').find((l) => l !== '' && set.has(l));
      if (hit !== undefined) block(H, `${hit} is a local file copied into this worktree (worktree.copy_files); it must stay out of commits: git restore --staged -- ${hit}`);
    }
    if (!isFile(`${ctx.scripts}/agent.sh`)) return;
    const runs = openRuns(ctx, H);
    if (runs.length === 0) return;
    const id = branch !== '' ? runs.find(([, b]) => b === branch)?.[0] : undefined;
    if (id === undefined) {
      block(H, `open run(s) ${runs.map(([i, b]) => `${i} (task branch ${b === '-' ? 'not established' : b})`).join(', ')}: commits only on a run's task branch (current: '${branch === '' ? 'detached' : branch}'); finish or terminate and clean up the run first`);
    }
    const dirty = git(ctx, ['-C', root, 'status', '--porcelain', '--untracked-files=all']).out.split('\n').filter((l) => l !== '' && !/^.. \.agents\/runs\//.test(l) && !/^.. \.agents\/local\//.test(l) && !/^[MADRC] /.test(l));
    if (dirty.length > 0) block(H, `run ${id}: the commit must contain exactly the gated content; stage every change (unstaged or untracked paths exist)`);
    const dc = agent(ctx, ['delivery-check', id]);
    ctx.err(dc.out + dc.err);
    if (dc.code !== 0) block(H, `run ${id} is not delivery-ready (required gates must pass for the current content)`);
    if (human(ctx.env)) return;
    const fp = agent(ctx, ['fingerprint', id, 'full']);
    if (fp.code !== 0) block(H, `run ${id}: could not compute the content fingerprint`);
    const fpv = fp.out.replace(/\n+$/, '');
    const ac = agent(ctx, ['approval-consume', id, 'commit', fpv]);
    ctx.err(ac.out + ac.err);
    if (ac.code !== 0) block(H, `run ${id}: no user commit approval for this content`);
  });
}

/** githooks/pre-push. @param {Context} ctx @param {string} stdin the lines git feeds the hook */
export function prePush(ctx, stdin) {
  const H = 'pre-push';
  return guarded(ctx, () => {
    const config = readBytes(`${ctx.root}/.agents/config.yaml`) ?? '';
    const protectedList = protectedBranches(config);
    const runs = openRuns(ctx, H);
    let refs = 0; let id = '-'; let rrefs = '';
    const rrefList = [];
    for (const line of textLines(stdin)) {
      const f = line.replace(/^[ \t]+/, '').split(/[ \t]+/);
      const lref = f[0] ?? ''; const rref = f[2] ?? '';
      refs++;
      const b = rref.replace(/^refs\/heads\//, '');
      rrefs += ` ${rref}`; rrefList.push(rref);
      if (runs.length > 0) {
        let lb = lref.replace(/^refs\/heads\//, '');
        if (lref === 'HEAD') lb = git(ctx, ['symbolic-ref', '--short', '-q', 'HEAD']).out.replace(/\n+$/, '');
        const rid = runs.find(([, br]) => br === lb)?.[0] ?? '';
        if (rid === '') block(H, `a run is open (${runs.map(([i]) => i).join(', ')}): only its task branch is pushed (pushing '${lref}')`);
        if (id !== '-' && id !== rid) block(H, 'one push delivers one run');
        id = rid;
      }
      for (const pb of protectedList) if (caseMatch(pb, b) && !human(ctx.env)) block(H, `branch '${b}' is listed in git.protected_branches; agents never push there`);
    }
    if (refs === 0) return;
    if (cfg2(config, 'git', 'push_requires_approval') === 'false') return;
    if (human(ctx.env)) return;
    if (!isFile(`${ctx.scripts}/agent.sh`)) block(H, 'git.push_requires_approval is on and .agents/scripts/agent.sh is missing');
    const r = agent(ctx, ['approval-consume', id, 'push', '', ...rrefList.filter((x) => x !== '')]);
    ctx.err(r.out + r.err);
    if (r.code !== 0) block(H, 'git.push_requires_approval: no user push approval');
  });
}

