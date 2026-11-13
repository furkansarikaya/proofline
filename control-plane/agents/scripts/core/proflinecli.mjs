// @ts-check
// The `proofline` command (D8, D23, A233; the former bin/proofline): installs and checks the control plane (init, upgrade, doctor), shows state (status, resume, queue) and
// tells you the exact instruction for your agent session for the commands that need one (task, design, run, review, audit, debug, deliver). It never commits, pushes or
// approves; its one merge path is `merge`, which merges a pull request only when every check is green (A136), on GitHub, GitLab and Azure DevOps through gh, glab or az
// (A180); on any other platform the user merges. bin/proofline is only the launcher of this module (ADR 0001 section 9).
//
// Text is a byte string like the rest of the core (one char per byte); the arguments are turned into byte strings at the start and written back as bytes, so a UTF-8 task
// text or path is printed as it was typed. The project's own `agent.sh` is started for the run state (the plugin and the project may be of different versions, A194).
import './node-check.mjs';
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { isatty } from 'node:tty';
import { fileURLToPath } from 'node:url';
import { Config, bytes } from './config.mjs';
import { Context } from './context.mjs';
import { CliDie, fdWriter, readLine } from './cliio.mjs';
import { ProoflineError } from './errors.mjs';
import { doctorCommand } from './doctor.mjs';
import { cleanBytes, cleanOut } from './codetrust.mjs';
import { hgit } from './hgit.mjs';
import { insightsFront } from './insightsfront.mjs';
import { cmdInit, cmdUpgrade, u } from './install.mjs';
import { mergeCommand } from './merge.mjs';
import { nextUser } from './nextuser.mjs';
import * as proc from './proc.mjs';
import { queue } from './queue.mjs';
import { run as coreRun } from '../proofline-core.mjs';
import { USAGE_LINES } from './cliusage.mjs';

export const PROOFLINE_VERSION = '0.0.104';

/** @typedef {{ write(chunk: Buffer): unknown }} Sink */
/** @typedef {{ stdout?: Sink, stderr?: Sink, env?: NodeJS.ProcessEnv, cwd?: string, plHome?: string, interactive?: boolean }} Over */

/** A byte string as the characters the operating system gets. @param {string} s */
const raw = (s) => Buffer.from(s, 'latin1').toString('utf8');
/** @param {string} text @returns {string[]} */
const linesOf = (text) => { const r = text.split('\n'); if (r[r.length - 1] === '') r.pop(); return r; };
/** `$(...)`: the output without its trailing newlines. @param {string} t */
const chomp = (t) => t.replace(/\n+$/, '');

/** One command invocation. */
class Cli {
  /** @param {Over} over */
  constructor(over) {
    this.out = over.stdout ?? fdWriter(1);
    this.errw = over.stderr ?? fdWriter(2);
    this.cwd = over.cwd ?? process.cwd();
    this.plHome = over.plHome ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    this.interactive = over.interactive ?? isatty(0);
    /** @type {NodeJS.ProcessEnv} */ this.env = { ...(over.env ?? process.env), PL_HOME: this.plHome, PROOFLINE_VERSION };
    const top = proc.run('git', ['rev-parse', '--show-toplevel'], { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const t = chomp(top.stdout.toString('utf8'));
    this.root = top.status === 0 && t !== '' ? t : this.cwd;
    this.cfgFile = `${this.root}/.agents/config.yaml`;
    this.agentSh = `${this.root}/.agents/scripts/agent.sh`;
    this.cmd = ''; this.id = '';
  }

  /** @param {string} s a byte string */
  say(s) { this.out.write(Buffer.from(`${s}\n`, 'latin1')); }
  /** `proofline: MSG` on standard error. @param {string} s */
  warn(s) { this.errw.write(Buffer.from(cleanOut(`proofline: ${s}\n`), 'latin1')); }
  /** @param {string} s */
  errLine(s) { this.errw.write(Buffer.from(cleanOut(`${s}\n`), 'latin1')); }
  /** @param {string} s a byte string, no newline added */
  errRaw(s) { this.errw.write(Buffer.from(cleanOut(s), 'latin1')); }

  /** A context of the project, for the modules of the core that print through one. @param {boolean} [toErr] its standard output goes to standard error @returns {Context} */
  ctx(toErr = false) {
    const io = { env: this.env, cwd: this.cwd, stdout: toErr ? this.errw : this.out, stderr: this.errw, stdin: null, isProcess: true };
    const c = new Context(io, `${this.root}/.agents/scripts/proofline-core.mjs`);
    c.runner = coreRun;
    c.root = this.root; c.agents = `${this.root}/.agents`; c.configFile = this.cfgFile; c.scripts = `${this.root}/.agents/scripts`;
    return c;
  }

  /** The user's next step (A159) from the one table in core/nextuser.mjs, for the command being run: `--error[=KIND]` goes to standard error. @param {string} [flag] */
  nuLine(flag = '') {
    try {
      const c = this.ctx(flag !== '');
      nextUser(c, [this.cmd || 'help', ...(this.id !== '' ? [this.id] : []), ...(flag !== '' ? [flag] : [])]);
      c.flush();
    } catch { /* the line is optional */ }
  }

  /** @param {string} msg @param {string} [kind] */
  die(msg, kind = '') { return new CliDie(msg, kind); }

  cfg() { return Config.load(this.cfgFile); }
  /** @param {string} key @param {string} def */
  cfgVal(key, def) { return this.cfg().get(key, def); }

  installed() { return existsSync(this.cfgFile) && existsSync(this.agentSh) && statSync(this.cfgFile).isFile() && statSync(this.agentSh).isFile(); }
  requireInstalled() {
    if (!this.installed()) throw this.die(`proofline is not installed in ${u(this.root)} (.agents/config.yaml missing); run: proofline init`);
  }

  /**
   * The project's `agent.sh ARGS` in its root. stdout is captured; stderr is the user's unless QUIET; `all` merges stderr into the output (`2>&1`); `inherit` hands over all three.
   * @param {string[]} args @param {{ quiet?: boolean, all?: boolean, inherit?: boolean }} [o] @returns {{ status: number, out: string }}
   */
  agent(args, o = {}) {
    const a = args.map(raw);
    if (o.inherit === true) { const r = proc.runScript([this.agentSh, ...a], { cwd: this.root, env: this.env, stdio: 'inherit' }); return { status: r.status, out: '' }; }
    if (o.all === true) {
      const r = proc.runMerged(proc.SCRIPT_SHELL, [this.agentSh, ...a], { cwd: this.root, env: this.env, stdin: 'inherit' });
      return { status: r.status, out: r.text };
    }
    const r = proc.runScript([this.agentSh, ...a], { cwd: this.root, env: this.env, stdio: ['inherit', 'pipe', o.quiet === true ? 'ignore' : 'inherit'] });
    return { status: r.status, out: r.stdout.toString('latin1') };
  }

  /** @param {string} text the output of `agent status` */
  static activeOf(text) {
    const l = linesOf(text).find((x) => x.startsWith('active_task='));
    return l === undefined ? '' : l.slice('active_task='.length);
  }

  /** The instruction for the lead's session, for the configured lead runtime. @param {string[]} args */
  hint(args) {
    const rt = this.cfgVal('runtime.lead', 'claude');
    const text = args.join(' ');
    this.say('');
    if (rt === 'codex') {
      this.say('This step needs an agent session (lead runtime: codex). In your Codex session say:');
      this.say(`  $proofline ${text}`);
      this.say('or start one:');
      this.say(`  codex '$proofline ${text}'`);
    } else {
      this.say(`This step needs an agent session (lead runtime: ${rt}). In your Claude Code session say:`);
      this.say(`  /proofline ${text}`);
    }
    this.say(`Any other agent that reads AGENTS.md: ask it to follow .agents/skills/proofline-lead/SKILL.md for: ${text}`);
  }

  /** `agent next ID | grep -v '^next='`: prints the lines, returns grep's status. @param {string} id @returns {number} */
  printNext(id) {
    const l = linesOf(this.agent(['next', id]).out).filter((x) => !x.startsWith('next='));
    for (const x of l) this.say(x);
    return l.length > 0 ? 0 : 1;
  }

  cmdStatus() {
    this.requireInstalled();
    const st = this.agent(['status']).out;
    for (const l of linesOf(st).slice(0, 4)) this.say(l);
    const id = Cli.activeOf(st);
    if (id === '' || id === 'none') { this.say('no active run. Queue: proofline queue; start: proofline run <TASK>'); return 0; }
    this.say('');
    return this.printNext(id);
  }

  cmdResume() {
    this.requireInstalled();
    const id = Cli.activeOf(this.agent(['status'], { quiet: true }).out);
    if (id === '' || id === 'none') { this.say('no active run to resume. Queue: proofline queue'); this.hint(['run', '<TASK>']); return 0; }
    this.say(`run ${id}`);
    if (this.printNext(id) !== 0) throw this.die(`cannot read the state of run ${id} (is .agents/runs/${id} intact?)`);
    const led = `${this.root}/.agents/runs/${id}/LEDGER.log`;
    if (existsSync(led) && statSync(led).isFile()) {
      this.say(''); this.say('ledger (last 5 rows):');
      for (const l of linesOf(readFileSync(led, 'latin1')).slice(-5)) this.say(`  ${l}`);
    }
    this.say('');
    for (const chk of ['freshness', 'verify-handoff']) {
      const r = this.agent([chk, id], { all: true });
      if (r.status === 0) this.say(`${chk}: ok`);
      else { const t = chomp(r.out).split('\n'); this.say(`${chk}: FAILED (${t[t.length - 1]}); the lead re-checks this before trusting persisted work`); }
    }
    this.say('An interrupted step restarts from its beginning; persisted work is trusted only after both checks pass.');
    this.hint(['resume']);
    return 0;
  }

  cmdQueue() {
    this.requireInstalled();
    if (!existsSync(`${this.root}/.agents/scripts/proofline-core.mjs`) || !existsSync(`${this.root}/.agents/scripts/core`)) throw this.die(`${u(this.root)}/.agents/scripts/proofline-core.mjs or core/ is missing (run: proofline upgrade)`);
    const c = this.ctx();
    const code = queue(c);
    c.flush();
    return code;
  }

  cmdDebt() {
    this.requireInstalled();
    return this.agent(['debt'], { inherit: true }).status;
  }

  /** @param {string[]} args */
  cmdDeliver(args) {
    this.requireInstalled();
    const id = args[0] ?? '';
    if (id === '') throw this.die('usage: proofline deliver <TASK>');
    // A152: a FAILED or BLOCKED run is not delivered (no draft pull request); reopening it is the user's call.
    const st = (linesOf(this.agent(['next', id], { quiet: true }).out).find((l) => l.startsWith('state=')) ?? '').slice('state='.length);
    if (st === 'FAILED' || st === 'BLOCKED') { this.errLine(`delivery refused: ${id} is ${st}; to reopen: /proofline reopen ${id}`); return 1; }
    const chk = this.agent(['delivery-check', id], { all: true });
    const out = chomp(chk.out);
    if (chk.status !== 0) {
      if (out.includes('knowledge step')) {
        // A152: an unfinished knowledge step is part of the delivery, not a stop: the one summary lists what it changed.
        this.say(`knowledge step not done yet: the lead runs it as part of this delivery (/proofline knowledge ${id}), then asks once.`);
        this.hint(['deliver', id]); return 0;
      }
      this.errLine(out);
      this.say('not deliverable yet; nothing was committed. The lead continues the run until every required gate passes.');
      this.hint(['deliver', id]); return 1;
    }
    this.say(out);
    /** @param {string[]} a */
    const git = (a) => (a[0] === 'status' ? hgit(this.ctx(), this.root, ['status', '--ignore-submodules=dirty', ...a.slice(1)], { env: this.env }) : proc.run('git', ['-C', this.root, ...a], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] })).stdout.toString('latin1');
    const br = chomp(git(['branch', '--show-current']));
    const n = linesOf(git(['status', '--porcelain', '--untracked-files=all'])).filter((l) => !/ \.agents\/(runs|local)\//.test(l)).length;
    const ident = chomp(git(['var', 'GIT_AUTHOR_IDENT'])).replace(/ [0-9]* [-+][0-9]*$/, '');
    const remotes = linesOf(git(['remote'])).map((l) => `${l} `).join('');
    this.say('');
    this.say('what delivery would do (proofline never commits by itself):');
    this.say(`  commit : ${n} changed path(s) on branch ${br}, message format ${this.cfgVal('git.commit_format', 'conventional')}, identity ${ident}`);
    this.say(`  push   : remote(s): ${remotes}`);
    this.say('  pr     : a pull request with the completion report as its body (Bitbucket or another host, or no gh/glab/az: the branch is pushed, the link is printed and you merge)');
    this.say("  merge  : only when every check is green, through 'proofline merge'; a red check stops before cleanup; without any check the build and test run in a clean copy first");
    this.say('  cleanup: after the merge');
    this.say('  one approval: the lead shows one summary; your reply "approve delivery" approves each step of it, bound to this content');
    this.say(`  never  : tag, force-push, touch a protected branch (configured: ${this.cfgVal('git.protected_branches', 'none')})`);
    this.hint(['deliver', id]);
    return 0;
  }

  /** @param {string} prompt 0 when the user types y/yes on a terminal */
  confirm(prompt) {
    if (!this.interactive) return false;
    this.errRaw(`${prompt} [y/N]: `);
    const c = readLine();
    return c === 'y' || c === 'Y' || c === 'yes' || c === 'YES';
  }

  /** @param {string[]} args */
  cmdClean(args) {
    this.requireInstalled();
    const yes = args[0] === '--yes';
    const act = Cli.activeOf(this.agent(['status'], { quiet: true }).out);
    let fin = '';
    const runsDir = `${this.root}/.agents/runs`;
    let names = [];
    try { names = readdirSync(runsDir).filter((n) => !n.startsWith('.')).sort(); } catch { names = []; }
    for (const rid of names) {
      try { if (!statSync(`${runsDir}/${rid}`).isDirectory()) continue; } catch { continue; }
      const nx = this.agent(['next', rid], { quiet: true });
      if (nx.status !== 0) continue;
      const field = (/** @type {string} */ k) => (linesOf(nx.out).find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
      const state = field('state');
      if (state === 'FAILED' || state === 'BLOCKED') { fin += ` ${rid}`; continue; }
      if (field('handoff') === 'DONE') fin += ` ${rid}`;
    }
    const local = `${this.root}/.agents/local`;
    // S1 (fix round 1): `find -P` counts and deletes (argument array, no shell). It never follows a link and decides per entry as it goes, so a folder swapped for a
    // link while clean runs is removed as a link; a walk in Node lists a folder by path after deciding it is one, and could be led into the link's target.
    const localOk = existsSync(local) && lstatSync(local).isDirectory();
    const keep = ['!', '-name', 'ACTIVE_RUN', '!', '-path', `${local}/worktrees`, '!', '-path', `${local}/worktrees/*`];
    /** @param {string[]} extra @returns {string} */
    const findLocal = (extra) => proc.run('find', ['-P', local, '-mindepth', '1', ...keep, ...extra], { cwd: this.root, env: this.env, stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString('latin1');
    /** win32 has no find(1) of this kind: the walk stays there (no link is followed by readdir/unlink of a Dirent, but it is not race-free) */
    const walkLocal = (/** @type {string} */ dir, /** @type {boolean} */ top, /** @type {(f: string) => void} */ onFile, /** @type {(d: string) => void} */ onDir) => {
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name === 'ACTIVE_RUN') continue;
        if (top && e.name === 'worktrees') continue;
        const f = `${dir}/${e.name}`;
        if (e.isDirectory()) { walkLocal(f, false, onFile, onDir); onDir(f); } else onFile(f);
      }
    };
    const win = process.platform === 'win32';
    let lf = 0;
    if (localOk) {
      if (win) walkLocal(local, true, (f) => { if (lstatSync(f).isFile()) lf++; }, () => {});
      else lf = linesOf(findLocal(['-type', 'f', '-print'])).length;
    }
    this.say('clean would remove:');
    this.say(`  .agents/local state: ${lf} file(s) (the ACTIVE_RUN selector is kept unless its run is cleaned)`);
    this.say(`  finished runs:${fin === '' ? ' none' : fin}`);
    if (lf === 0 && fin === '') { this.say('nothing to clean'); return 0; }
    if (!yes && !this.confirm('remove these?')) throw this.die('refusing to remove anything without --yes (or a yes at the prompt)');
    // A169: run worktrees hold parked runs' evidence: agent.sh worktree-remove, never clean
    if (localOk) {
      if (win) walkLocal(local, true, (f) => { try { unlinkSync(f); } catch { /* silent */ } }, (d) => { try { rmdirSync(d); } catch { /* not empty */ } });
      else findLocal(['-delete']);
    }
    for (const rid of fin.split(' ').filter((x) => x !== '')) if (this.agent(['cleanup', rid], { inherit: true }).status !== 0) this.warn(`run ${rid} was not cleaned (agent.sh refused)`);
    if (act !== '' && act !== 'none') this.say(`active run ${act} kept unless it was finished`);
    return 0;
  }

  /** @param {string[]} args */
  cmdTask(args) {
    this.requireInstalled();
    let grill = ''; let rest = args;
    if (args[0] === '--grill') { grill = '--grill '; rest = args.slice(1); }
    if (rest.length === 0) throw this.die('usage: proofline task [--grill] <text>');
    this.say(`task file goes to ${this.cfgVal('tasks.dir', '.agents/tasks')}/ through the ${this.cfgVal('tasks.adapter', 'markdown')} adapter; no run starts.`);
    this.hint(['task', `${grill}${rest.join(' ')}`]);
    return 0;
  }

  /** @param {string[]} args */
  cmdDesign(args) {
    this.requireInstalled();
    const first = args[0] ?? '';
    if (!['system', 'data', 'api', 'ui'].includes(first)) throw this.die('usage: proofline design system|data|api|ui [--check] | design ui <mode> <target>');
    if (first === 'ui' && args.length > 1 && args[1] !== '--check') {
      const modes = ['bolder', 'quieter', 'polish', 'animate', 'typeset', 'colorize', 'layout', 'delight', 'harden', 'adapt'];
      if (!modes.includes(args[1])) throw this.die(`unknown design ui mode: ${args[1]} (want ${modes.join('|')})`);
      if (args.length < 3) throw this.die(`usage: proofline design ui ${args[1]} <target>  (the page, section or component to change)`);
      this.say(`focused UI change: mode ${args[1]}, only the target; it is a normal run (TRIVIAL or STANDARD) and the target is checked afterwards.`);
      this.hint(['design', ...args]);
      return 0;
    }
    const cfg = this.cfg();
    const surfaces = [];
    for (const l of cfg.lines) { const m = /^design_docs\.design\.surfaces\.([^.=]*)\.doc=(.*)$/.exec(l); if (m) surfaces.push(`${m[1]}=${m[2]}`); }
    const main = surfaces.length > 0 ? `surfaces: ${surfaces.join(' ')}; shared: ${cfg.get('design_docs.design.shared', 'none')}` : cfg.get('design_docs.design', 'docs/design/DESIGN.md');
    this.say(`durable design documents: ${main}, ${cfg.get('design_docs.architecture', '')}, ${cfg.get('design_docs.data_model', '')}, ${cfg.get('design_docs.api', '')}`);
    this.hint(['design', ...args]);
    return 0;
  }

  /** @param {string[]} args */
  cmdRun(args) {
    this.requireInstalled();
    if ((args[0] ?? '') === '') throw this.die('usage: proofline run <TASK>');
    const act = Cli.activeOf(this.agent(['status'], { quiet: true }).out);
    if (act !== '' && act !== 'none') {
      if (act === args[0]) this.say(`run ${args[0]} is already active; resuming it is: proofline resume`);
      else this.warn(`run ${act} is active; one active run per worktree: finish or clean it first`);
    }
    this.hint(['run', ...args]);
    return 0;
  }

  /** A157: night mode. The plan and the tasks run in the agent session; status needs none. @param {string[]} args */
  cmdBatch(args) {
    this.requireInstalled();
    const a = args[0] ?? '';
    if (a === 'status') return this.agent(['batch-status'], { inherit: true }).status;
    if (a === 'run' || a === 'stop') throw this.die(`proofline batch ${a} is gone (removed in 0.0.32): night mode runs in your agent session, not in a background driver. Plan it with /proofline batch <ID...|all>, reply "approve batch", and continue an interrupted batch with /proofline batch in the session; proofline batch status shows the table`);
    if (a === '') { this.hint(['batch']); return 0; }
    this.say('night mode runs in the lead\'s session: one summary, one "approve batch", then the lead runs and delivers the tasks one after the other; keep the computer awake and the session open');
    this.hint(['batch', ...args]);
    return 0;
  }

  /** review | audit | debug | docs | explain | wiki | product | trace. @param {string} c @param {string[]} args */
  cmdSession(c, args) {
    const a1 = args[0] ?? ''; const a2 = args[1] ?? ''; const a3 = args[2] ?? '';
    switch (c) {
      case 'docs': if (!['create', 'update', 'audit'].includes(a1)) throw this.die('usage: proofline docs create|update|audit'); break;
      case 'explain': if (a1 === '') throw this.die('usage: proofline explain <topic|TASK-ID>'); break;
      case 'wiki': if (!['ingest', 'query', 'lint'].includes(a1)) throw this.die('usage: proofline wiki ingest|query|lint'); break;
      case 'product': {
        const disc = 'frame|research|interviews|competitors|opportunities'; const ass = 'assumptions|probes|premortem|redteam|decision';
        if (['prd', 'review', 'split', 'outcome'].includes(a1)) { if (a2 === '') throw this.die('usage: proofline product prd|review|split|outcome <slug>'); } else if (a1 === 'discover') {
          if (!disc.split('|').includes(a2)) throw this.die(`usage: proofline product discover ${disc} <slug>`);
          if (a3 === '') throw this.die(`usage: proofline product discover ${disc} <slug>`);
        } else if (a1 === 'assess') {
          if (!ass.split('|').includes(a2)) throw this.die(`usage: proofline product assess ${ass} <slug>`);
          if (a3 === '') throw this.die(`usage: proofline product assess ${ass} <slug>`);
        } else throw this.die('usage: proofline product prd|review|split|outcome|discover|assess ... <slug>');
        break;
      }
      case 'trace': if (a1 === '') throw this.die('usage: proofline trace <FR-n|TASK-ID>'); break;
      case 'knowledge': case 'reopen': if (a1 === '') throw this.die(`usage: proofline ${c} <TASK>`); break;
      default: break;
    }
    this.requireInstalled();
    this.hint([c, ...args]);
    return 0;
  }

  /** Run a command of the core with this project's context. @param {(c: Context, a: string[]) => number} fn @param {string[]} args @param {boolean} [inRoot] */
  core(fn, args, inRoot = false) {
    if (inRoot) process.chdir(this.root);
    const c = this.ctx();
    if (inRoot) c.cwd = this.root;
    try { return fn(c, args); } finally { c.flush(); }
  }

  /** @param {string} cmd @param {string[]} args */
  dispatch(cmd, args) {
    switch (cmd) {
      case 'init': return this.initCmd(args);
      case 'upgrade': return this.upgradeCmd(args);
      case 'doctor': return this.core(doctorCommand, args, true);
      case 'status': return this.cmdStatus();
      case 'resume': return this.cmdResume();
      case 'queue': return this.cmdQueue();
      case 'deliver': return this.cmdDeliver(args);
      case 'debt': return this.cmdDebt();
      case 'clean': return this.cmdClean(args);
      case 'merge': return this.core(mergeCommand, args);
      case 'insights': return this.core(insightsFront, args, true);
      case 'task': return this.cmdTask(args);
      case 'design': return this.cmdDesign(args);
      case 'run': return this.cmdRun(args);
      case 'batch': return this.cmdBatch(args);
      case 'review': case 'audit': case 'debug': case 'docs': case 'explain': case 'wiki': case 'product': case 'trace': case 'knowledge': case 'reopen': return this.cmdSession(cmd, args);
      case 'version': case '--version': case '-v': this.say(`proofline ${PROOFLINE_VERSION}`); return 0;
      case 'help': case '--help': case '-h': for (const l of USAGE_LINES) this.say(l); return 0;
      default:
        for (const l of USAGE_LINES) this.errLine(l);
        this.cmd = '';
        throw this.die(`unknown command: ${cmd}`, 'usage');
    }
  }

  /** @returns {{ root: string, plHome: string, version: string, env: NodeJS.ProcessEnv, ui: import('./install.mjs').Ui }} */
  installCtx() {
    const ui = {
      // init and upgrade print names that come from the repository (a file name, a path): no control character reaches the terminal (A249 SEC-3)
      say: (/** @type {string} */ l) => this.say(cleanBytes(l)), warn: (/** @type {string} */ l) => this.warn(cleanBytes(l)), interactive: this.interactive || this.env.PROOFLINE_PROMPT === '1',
      ask: (/** @type {string} */ prompt, /** @type {string} */ def) => { this.errRaw(`${prompt} [${def}]: `); const a = readLine(); return a === null || a === '' ? def : a; },
    };
    return { root: this.root, plHome: this.plHome, version: PROOFLINE_VERSION, env: this.env, ui };
  }

  /** @param {string[]} args */
  initCmd(args) { cmdInit(this.installCtx(), args); return 0; }
  /** @param {string[]} args */
  upgradeCmd(args) { cmdUpgrade(this.installCtx(), args); return 0; }
}

/** What follows a successful command: the user's next step (A159). */
const NEXT_AFTER = new Set(['init', 'upgrade', 'doctor', 'status', 'resume', 'queue', 'debt', 'clean', 'merge', 'insights']);

/**
 * The `proofline` command line. Returns the exit status; everything is written through the sinks (the descriptors of the process by default).
 * @param {string[]} argv the arguments after `proofline` @param {Over} [over] @returns {number}
 */
export function main(argv, over = {}) {
  const args = argv.map(bytes);
  const cli = new Cli(over);
  const cmd = args[0] === undefined || args[0] === '' ? 'status' : args[0];
  const rest = args.slice(1);
  cli.cmd = cmd;
  if (cmd === '--version' || cmd === '-v') cli.cmd = 'version';
  else if (cmd === '--help' || cmd === '-h') cli.cmd = 'help';
  else if (['deliver', 'run', 'knowledge', 'reopen'].includes(cmd)) cli.id = rest[0] ?? '';
  const json = rest.includes('--json');
  let rc = 0;
  try {
    rc = cli.dispatch(cmd, rest);
  } catch (e) {
    if (e instanceof CliDie) { cli.errLine(e.message); cli.nuLine(`--error${e.kind !== '' ? `=${e.kind}` : ''}`); return 1; }
    if (e instanceof ProoflineError) { if (e.message !== '') cli.errLine(e.message); rc = e.exitCode; } else {
      cli.errLine(`proofline: internal error in ${cmd}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return 70;
    }
  }
  if (rc !== 0) cli.nuLine('--error');
  else if (!json && NEXT_AFTER.has(cli.cmd)) cli.nuLine();
  return rc;
}
