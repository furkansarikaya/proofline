// @ts-check
// One build and test run per commit (A148; A229: the former scripts/build-record.sh). Runs the configured commands.install, commands.build, commands.test once for
// a given source state, in a separate export directory (never the working tree), and records each command, its real exit status and its FULL output under
// .agents/local/builds/<KEY>/. Reviewers and the verifier read that record (`agent.sh build-record <ID> show`) instead of building again. A key may hold several
// commands (a block list, A173): all of them run, each with its own record labelled `build[2/3]`; one failing does not hide the others. The output is evidence:
// it is written to the .out file byte for byte and never compressed or cut (`show` prints the last 15 lines and names the file).
// KEY = <commit hash, or tree-<tree hash> of the working tree without .agents/runs and .agents/local>-<8 hex of the hash of the configured
// commands.install|build|test strings (and verification.env_files, when set)>, so a changed command never reuses a record. The record has a `steps` file (one
// `<file id><TAB><label>` line per command that ran, in run order). A key with one command keeps the file ids install, build and test.
// Exit status of `run`/`show`: 0 every command passed, 1 a command failed (the record says which), 2 usage, nothing configured or not allowed, 3 no record.
// Dependencies (the export holds tracked and untracked files, not ignored ones): `commands.install`, when configured, runs first in the export; otherwise the
// ignored dependency folders that worktree_deps names in ecosystems.json (A185) are COPIED into the export, never linked. Env files (verification.env_files,
// default none): secret-free test env files (for example .env.test) that MAY enter the export; every other .env* stays out. Each listed file is scanned first
// (the secret scanner, the project's commands.secret_scan included); one visible secret rejects the run with exit 2, naming the file and line (never the value).
// shortcut: the copy is taken at run time and is not part of the key; the key covers sources and command strings, not node version or installed packages.
// A stale lock is reclaimed when its process is dead or after BUILD_RECORD_WAIT seconds (default 1800 times timeouts.scale). Every command stops after
// verification.command_timeout_seconds (times the scale); a stopped command leaves no sealed record (A202); two waiters reclaiming at the very same moment is
// not guarded.
import { appendFileSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sleepSync } from './clock.mjs';
import { gitBlobSha } from './hash.mjs';
import { isFile } from './paths.mjs';
import * as proc from './proc.mjs';
import { commandV } from './runtimedetect.mjs';
import { requireRun } from './runs.mjs';
import { builtinScan } from './secretscan.mjs';
import { tmScaled, verifyCommandTimeout } from './timeouts.mjs';
import { prepareWorktree } from './worktree.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ status: number, out: string, err: string }} Result */

/** The end of the command with a status (output already collected). */
class Stop extends Error {
  /** @param {number} code */
  constructor(code) { super(''); this.name = 'Stop'; this.code = code; }
}

/** @param {string} p */
function readText(p) { try { return readFileSync(p, 'latin1'); } catch { return ''; } }
/** `$(cat FILE)`: the text without trailing newlines. @param {string} p */
function catSub(p) { return readText(p).replace(/\n+$/, ''); }
/** @param {string} p */
function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** @param {number} pid */
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'; } }

/**
 * The state a record is looked up by: the key and the folder of its record.
 * @param {Context} ctx @param {string} rev '' for the current tree @returns {{ key: string, dir: string, ic: string, bc: string, tc: string, envs: string[], tree: string }}
 */
function recordKey(ctx, rev) {
  /** @param {string[]} args @param {Record<string, string>} [env] */
  const g = (args, env = {}) => proc.run('git', ['-C', ctx.root, ...args], { cwd: ctx.cwd, env: { ...ctx.childEnv(), ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
  const out = (/** @type {proc.ProcResult} */ r) => r.stdout.toString('latin1').replace(/\n+$/, '');
  let tree; let key;
  if (rev !== '') {
    const t = g(['rev-parse', '--verify', '-q', `${rev}^{tree}`]);
    if (t.status !== 0) throw stopWith(`build-record: unknown revision ${rev}\n`, 2);
    tree = out(t);
    key = out(g(['rev-parse', `${rev}^{commit}`]));
  } else {
    const tmp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'build-record-idx.'));
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
      tree = '';
      if (g(['add', '-A'], env).status === 0 && g(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.agents/runs', '.agents/local'], env).status === 0) tree = out(g(['write-tree'], env));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    if (tree === '') throw stopWith('build-record: cannot snapshot the working tree\n', 2);
    const head = g(['rev-parse', 'HEAD^{tree}', 'HEAD']).stdout.toString('latin1').split('\n');
    key = tree === head[0] && (head[1] ?? '') !== '' ? /** @type {string} */ (head[1]) : `tree-${tree}`;
  }
  // one command per line (a list: every item, A173)
  const cmds = (/** @type {string} */ k) => ctx.config().cmds(`commands.${k}`).join('\n').replace(/\n+$/, '');
  const ic = cmds('install'); const bc = cmds('build'); const tc = cmds('test');
  // The commands are part of the key. Scalar config (one command or none per kind) keeps the original form, so a record made before the lists existed stays
  // valid. A list prefixes every line with its kind, so `build:[a,b] test:[c]` and `build:[a] test:[b,c]` differ.
  const all = `${ic}\n${bc}\n${tc}\n`;
  let ckey;
  if (all.split('\n').length - 1 <= 3) ckey = gitBlobSha(all).slice(0, 8);
  else {
    const pre = (/** @type {string} */ k, /** @type {string} */ v) => v.split('\n').map((l) => `${k}:${l}\n`).join('');
    ckey = gitBlobSha(pre('install', ic) + pre('build', bc) + pre('test', tc)).slice(0, 8);
  }
  const envs = (ctx.config().getRaw('verification.env_files') ?? '').split(/[ \t]+/).filter((x) => x !== '');
  if (envs.length > 0) ckey = gitBlobSha(`${ckey}\nenv_files:${envs.join('\n')}\n`).slice(0, 8);
  key = `${key}-${ckey}`;
  return { key, dir: `${ctx.root}/.agents/local/builds/${key}`, ic, bc, tc, envs, tree };
}

/** @param {string} msg @param {number} code */
function stopWith(msg, code) { const s = new Stop(code); s.message = msg; return s; }

/**
 * The record of a key: per command its text, exit status and the last output lines; the full output stays in the .out file.
 * @param {string} key @param {string} dir @returns {{ text: string, status: number }}
 */
function showRecord(key, dir) {
  const steps = existsSync(`${dir}/steps`) ? readText(`${dir}/steps`) : 'install\tinstall\nbuild\tbuild\ntest\ttest\n';
  let text = ''; let multi = false; let failed = '';
  for (const row of steps.split('\n')) {
    const tab = row.indexOf('\t');
    const sid = tab < 0 ? row : row.slice(0, tab);
    const slabel = tab < 0 ? '' : row.slice(tab + 1);
    if (sid === '' || !isFile(`${dir}/${sid}.exit`)) continue;
    const se = catSub(`${dir}/${sid}.exit`);
    text += `key: ${key}\n${slabel}: ${catSub(`${dir}/${sid}.cmd`)}\nexit: ${se}\noutput-file: .agents/local/builds/${key}/${sid}.out\noutput-tail:\n`;
    const body = readText(`${dir}/${sid}.out`);
    if (body !== '') {
      const lines = body.replace(/\n$/, '').split('\n');
      text += lines.slice(-15).map((l) => `  ${l}\n`).join('');
    }
    if (slabel.includes('[')) multi = true;
    if (se !== '0') failed += `${slabel} (exit ${se})\n`;
  }
  if (multi) text += failed !== '' ? failed.replace(/\n$/, '').split('\n').map((l) => `failed: ${l}\n`).join('') : 'all commands passed\n';
  // a failed record: the export is clean (tracked and untracked files only), so a test that needs a git-ignored file (.env, a local database, generated files) fails there
  if (catSub(`${dir}/done`) !== '0') {
    text += "note: the build export holds no git-ignored files (such as .env; secrets are never copied into it, a secret-free test env file may be named in verification.env_files): a test that needs one must be self-contained, or commands.install must prepare it\n";
    return { text, status: 1 };
  }
  return { text, status: 0 };
}

/**
 * The scan and the checks of verification.env_files before anything is built: a listed file must lie inside the project (its parent directory, symbolic
 * links followed, may not leave it or be under .git) and hold no visible secret. @param {Context} ctx @param {string[]} envs @param {(s: string) => void} err
 */
function checkEnvFiles(ctx, envs, err) {
  const root = ctx.root;
  let rr;
  try { rr = realpathSync(root); } catch { throw new Stop(2); }
  for (const f of envs) {
    const abs = `${root}/${f}`;
    if (!existsSync(abs) && !isLink(abs)) { err(`build-record: note: verification.env_files lists ${f}, which does not exist; skipped\n`); continue; }
    let pd = '';
    try { pd = realpathSync(path.dirname(abs)); } catch { pd = ''; }
    if (`${pd}/`.startsWith(`${rr}/.git/`)) pd = '';
    else if (!`${pd}/`.startsWith(`${rr}/`)) pd = '';
    if (`/${f}/`.includes('/.git/')) pd = '';
    if (pd === '' || isLink(abs)) {
      err(`build-record: rejected: verification.env_files ${f} is a symbolic link, or its directory resolves outside the project or into .git; nothing was built\n`);
      throw new Stop(2);
    }
  }
  const rel = `.agents/local/env-scan.${process.pid}`;
  const sd = `${root}/${rel}`;
  rmSync(sd, { recursive: true, force: true });
  try { mkdirSync(sd, { recursive: true }); } catch { throw new Stop(2); }
  try {
    let i = 0; /** @type {string[]} */ const names = []; /** @type {string[]} */ const paths = [];
    for (const f of envs) {
      if (!isFile(`${root}/${f}`)) continue;
      i++;
      // an unquoted KEY=value line is shown to the scanner as KEY="value", so its assignment rule sees env files as it sees code
      const text = readText(`${root}/${f}`).split('\n').map((l) => l.replace(/^[ \t\v\f\r]*(export[ \t\v\f\r]+)?([A-Za-z_][A-Za-z0-9_]*)=([^"' \t\v\f\r#][^ \t\v\f\r#]*)/, '$2="$3"')).join('\n');
      writeFileSync(`${sd}/e${i}.txt`, Buffer.from(text, 'latin1'));
      names[i] = f; paths.push(`${rel}/e${i}.txt`);
    }
    if (paths.length === 0) return;
    const r = builtinScan(ctx, root, paths);
    if (r.status === 0) return;
    if (r.status === 1) {
      for (const line of r.stdout.split('\n')) {
        if (line === '') continue;
        const p1 = line.indexOf(':'); const p2 = line.indexOf(':', p1 + 1);
        const fp = line.slice(0, p1); const ln = line.slice(p1 + 1, p2 < 0 ? undefined : p2); const rl = p2 < 0 ? '' : line.slice(p2 + 1);
        if (fp === '') continue;
        const fi = fp.slice(fp.lastIndexOf('/e') + 2).replace(/\.txt$/, '');
        err(`build-record: rejected: verification.env_files ${names[Number(fi)] ?? ''}:${ln} holds a secret (${rl}); the value is not shown. Remove it, or take the file out of verification.env_files\n`);
      }
    } else err(`build-record: the secret scan of verification.env_files failed (exit ${r.status})\n`);
    throw new Stop(2);
  } finally { rmSync(sd, { recursive: true, force: true }); }
}

/** Run one configured command in the export, its whole output into FILE; the exit status (124 when the time limit stopped it). @param {Context} ctx @param {string} cwd @param {string} command @param {string} file @param {number} limit */
export function runCommand(ctx, cwd, command, file, limit) {
  const fd = openSync(file, 'w');
  try {
    const stdio = /** @type {Array<'ignore' | number>} */ (['ignore', fd, fd]);
    const timeoutBin = commandV('timeout', ctx.env);
    if (timeoutBin) return proc.run('timeout', [String(limit), '/bin/sh', '-c', command], { cwd, env: ctx.childEnv(), stdio }).status;
    // no `timeout` on this machine (macOS): the limit still holds, with Node's own timer. The command leads a process group that is killed whole when it ends or
    // is stopped (no grandchild writes on after the record is sealed), and an expired limit is 124 whatever status the command then reports (a command that traps
    // TERM and exits 0 is no pass, A202).
    const r = proc.runUserCommand(command, { cwd, env: ctx.childEnv(), stdio, timeoutMs: limit * 1000, group: true });
    return r.timedOut === true ? 124 : r.status;
  } finally { closeSync(fd); }
}

/**
 * `agent.sh build-record <ID> run|show` as a function (REV: the record of that revision, for `proofline merge`): the record of the current tree (or of REV), made once, read by everyone.
 * @param {Context} ctx @param {'run' | 'show'} op @param {string} [rev] @returns {Result}
 */
export function buildRecord(ctx, op, rev = '') {
  let out = ''; let err = '';
  const emit = (/** @type {string} */ s) => { err += s; };
  try {
    if (ctx.role !== 'lead' && op !== 'show') throw stopWith('build-record: only the lead runs the build (agent.sh build-record <ID> run); use show\n', 2);
    const k = recordKey(ctx, rev);
    const { key, dir } = k;
    if (op === 'show') {
      if (!isFile(`${dir}/done`)) throw stopWith(`build-record: no finished record for ${key} (the lead runs: agent.sh build-record <ID> run)\n`, 3);
      const s = showRecord(key, dir);
      return { status: s.status, out: s.text, err };
    }
    if (!isFile(`${dir}/done`)) {
      if (k.bc === '' && k.tc === '') throw stopWith('build-record: commands.build and commands.test are not configured\n', 2);
      try { mkdirSync(`${ctx.root}/.agents/local/builds`, { recursive: true }); } catch { throw new Stop(2); }
      if (k.envs.length > 0) checkEnvFiles(ctx, k.envs, emit);
      const cfg = ctx.config();
      let waitMax = 1800;
      const wEnv = ctx.env.BUILD_RECORD_WAIT ?? '';
      waitMax = wEnv !== '' && /^[0-9]+$/.test(wEnv) ? Number(wEnv) : tmScaled(cfg, 1800, 60, 28800);
      let n = 0; let mine = false;
      while (!isFile(`${dir}/done`)) {
        try { mkdirSync(`${dir}.lock`); writeFileSync(`${dir}.lock/pid`, `${process.pid}\n`); mine = true; break; } catch { /* held by another process */ }
        const p = catSub(`${dir}.lock/pid`);
        if ((p !== '' && /^[0-9]+$/.test(p) && !alive(Number(p))) || n >= waitMax) {
          try { renameSync(`${dir}.lock`, `${dir}.lock.stale.${process.pid}`); rmSync(`${dir}.lock.stale.${process.pid}`, { recursive: true, force: true }); } catch { /* the other waiter was first */ }
          n = 0; continue;
        }
        sleepSync(1000); n++;
      }
      if (mine) {
        let wt = '';
        try {
          if (!isFile(`${dir}/done`)) {
            rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
            try { wt = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'build-record.')); } catch { throw new Stop(2); }
            const env = { GIT_INDEX_FILE: `${wt}/index` };
            const g = (/** @type {string[]} */ args) => proc.run('git', ['-C', ctx.root, ...args], { cwd: ctx.cwd, env: { ...ctx.childEnv(), ...env }, stdio: ['ignore', 'ignore', 'ignore'] }).status;
            if (g(['read-tree', k.tree]) !== 0 || g(['checkout-index', '-a', '-f', `--prefix=${wt}/src/`]) !== 0) throw stopWith(`build-record: cannot export ${key}\n`, 2);
            mkdirSync(`${wt}/src`, { recursive: true });
            if (k.ic === '') {
              // A185: the dependency folders named by worktree_deps in ecosystems.json are COPIED into the export, never linked, so a build or install step cannot
              // write through into the project
              const mark = ctx.chunks.length;
              prepareWorktree(ctx, ctx.root, `${wt}/src`, '', true);
              ctx.chunks.length = mark;
            }
            for (const f of k.envs) {   // listed and scanned above; copied only when the export lacks it (a tracked file is already there)
              if (!isFile(`${ctx.root}/${f}`) || isLink(`${ctx.root}/${f}`) || existsSync(`${wt}/src/${f}`)) continue;
              mkdirSync(path.dirname(`${wt}/src/${f}`), { recursive: true });
              copyFileSync(`${ctx.root}/${f}`, `${wt}/src/${f}`);
            }
            let limit = verifyCommandTimeout(cfg);
            if (!(limit > 0)) limit = 1800;
            let fail1 = 0; let timedout = '';
            writeFileSync(`${dir}/steps`, '');
            for (const s of ['install', 'build', 'test']) {
              const list = s === 'install' ? k.ic : s === 'build' ? k.bc : k.tc;
              if (list === '') continue;
              const items = list.split('\n').filter((x) => x !== '');
              const total = items.length;
              let i = 0; let kfail = 0;
              for (const c of items) {
                i++;
                const id = total > 1 ? `${s}.${i}` : s;
                const label = total > 1 ? `${s}[${i}/${total}]` : s;
                writeFileSync(`${dir}/${id}.cmd`, Buffer.from(`${c}\n`, 'latin1'));
                const e = runCommand(ctx, `${wt}/src`, Buffer.from(c, 'latin1').toString('utf8'), `${dir}/${id}.out`, limit);
                writeFileSync(`${dir}/${id}.exit`, `${e}\n`);
                appendFileSync(`${dir}/steps`, `${id}\t${label}\n`);
                if (e === 124) timedout += `${label} `;
                if (e !== 0) kfail = 1;   // the rest of the same list still runs: every command reports on its own
              }
              if (kfail !== 0) { fail1 = 1; break; }   // nothing after a failed key (a failed build is not tested)
            }
            // A202 item 29: a command stopped by the time limit (exit 124) is a failure, never a pass, and it is not a result about the code: the record is not
            // sealed (no `done`), so the next run starts again instead of reusing a verdict that only says the machine was slow. The outputs stay for reading.
            if (timedout !== '') {
              emit(`build-record: ${timedout.trim()} stopped after ${limit}s (verification.command_timeout_seconds times timeouts.scale); this is a failure, not a pass, and no record is kept: run it again, or raise the limit (proofline doctor --scale)\n`);
              writeFileSync(`${dir}/timed-out`, `${timedout}\n`);
              throw new Stop(1);
            }
            writeFileSync(`${dir}/done`, `${fail1}\n`);
          }
        } finally {
          rmSync(`${dir}.lock`, { recursive: true, force: true });
          if (wt !== '') rmSync(wt, { recursive: true, force: true });
        }
      }
    }
    const s = showRecord(key, dir);
    return { status: s.status, out: s.text, err };
  } catch (e) {
    if (e instanceof Stop) return { status: e.code, out, err: err + e.message };
    throw e;
  }
}

const USAGE = 'usage: agent.sh build-record <ID> [run|show]';

/** `agent.sh build-record <ID> [run|show]`. @param {Context} ctx @param {string[]} args */
export function buildRecordCommand(ctx, args) {
  const id = args[0] ?? '';
  if (id === '') { ctx.err(`${USAGE}\n`); return 2; }
  requireRun(ctx, id);
  const op = args[1] === undefined || args[1] === '' ? 'show' : args[1];
  if (op !== 'run' && op !== 'show') { ctx.err(`${USAGE}\n`); return 2; }
  const r = buildRecord(ctx, op);
  ctx.out(r.out); ctx.err(r.err);
  return r.status;
}
