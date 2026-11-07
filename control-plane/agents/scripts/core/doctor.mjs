// @ts-check
// `proofline doctor` in Node (D8, A232; the former bin/lib/doctor.sh): verifies the install and that each enforced rule is really enforced, with live probes in a throwaway
// repository (the project's own installed hooks and scripts are copied there). Prints PASS / WARN / FAIL lines and exits non-zero on any FAIL. It runs from the plugin's core
// for the project named by PROOFLINE_ROOT (see cliRootScript in proofline-core.mjs): a project whose own engine is broken or missing is still diagnosed. PL_HOME names the
// plugin checkout and PROOFLINE_VERSION its version. Text here is JavaScript text; the byte strings of the core (config values, command outputs) are decoded with `u`.
import { accessSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadavg, availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';
import { agentCall } from './batch.mjs';
import { ciCheckResult, ciTaskCommandText } from './commands/checks.mjs';
import { Config } from './config.mjs';
import { cfgSet } from './configset.mjs';
import { contextRows, reportText } from './contextsize.mjs';
import { applyCommands, emptyKinds, proposeCommands } from './commandsprop.mjs';
import { discoverCommands, runWithTimeout } from './discover.mjs';
import { ProoflineError } from './errors.mjs';
import { emailOf, forbidden } from './githooks.mjs';
import { sha256File } from './hash.mjs';
import { leftoverWorktrees } from './leftover.mjs';
import { isDir, isFile } from './paths.mjs';
import { detectPlatform, droppedNetVars, warnText } from './platform.mjs';
import * as proc from './proc.mjs';
import { binOf, commandV } from './runtimedetect.mjs';
import { applyScale, proposeScale } from './scale.mjs';

/** @typedef {import('./context.mjs').Context} Context */

export const MANIFEST_REL = '.agents/.proofline-manifest';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop'];
const HOOK_NAME = /proofline-hook[.]mjs/;

/** A byte string of the core (one char per byte) as the JavaScript text it holds. @param {string} s */
const u = (s) => Buffer.from(s, 'latin1').toString('utf8');
/** `head -n N` of a text and `tr '\n' ' '`: the first N lines joined by spaces; a space stays after the last one when more lines follow. @param {string} text @param {number} n */
export function headJoined(text, n) {
  const lines = text.replace(/\n+$/, '').split('\n');
  return lines.slice(0, n).join(' ') + (lines.length > n ? ' ' : '');
}

/**
 * `hook_has FILE EVENT`: does the JSON hook file wire a proofline-hook command to EVENT?
 * @param {string} file @param {string} event
 */
export function hookHas(file, event) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const g = (j && typeof j === 'object' ? j.hooks : null)?.[event];
    if (!Array.isArray(g)) return false;
    return g.some((/** @type {any} */ x) => Array.isArray(x?.hooks) && x.hooks.some((/** @type {any} */ h) => typeof h?.command === 'string' && HOOK_NAME.test(h.command)));
  } catch { return false; }
}

/**
 * The foreign context hooks of one settings file (`doctor_foreign`): `[event, command text]` for every SessionStart and UserPromptSubmit command that is not proofline's. A command
 * that is not text makes the whole file count for nothing (the former jq program failed on it).
 * @param {string} file @returns {Array<[string, string]>}
 */
export function foreignHooks(file) {
  /** @type {Array<[string, string]>} */ const out = [];
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return out; }
  const hooks = j && typeof j === 'object' && j.hooks && typeof j.hooks === 'object' ? j.hooks : {};
  if (Array.isArray(hooks)) return out;
  for (const e of Object.keys(hooks)) {
    if (e !== 'SessionStart' && e !== 'UserPromptSubmit') continue;
    const groups = hooks[e];
    if (!Array.isArray(groups)) continue;
    for (const grp of groups) {
      const hs = grp && typeof grp === 'object' && Array.isArray(grp.hooks) ? grp.hooks : [];
      for (const h of hs) {
        const c = h && typeof h === 'object' ? h.command : undefined;
        if (c !== undefined && c !== null && c !== false && typeof c !== 'string') return [];
        const cmd = typeof c === 'string' ? c : '';
        if (!HOOK_NAME.test(cmd)) out.push([e, Array.from(cmd).slice(0, 80).join('')]);
      }
    }
  }
  return out;
}

/** The version order of `sort -t. -k1,1n -k2,2n -k3,3n`: negative when A sorts first. @param {string} a @param {string} b */
function versionCompare(a, b) {
  const pa = a.split('.'); const pb = b.split('.');
  for (let i = 0; i < 3; i++) {
    const x = Number.parseInt(pa[i] ?? '', 10) || 0; const y = Number.parseInt(pb[i] ?? '', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `node_status`: `ok:vX.Y.Z`, `old:vX.Y.Z` or `missing` for the `node` on the PATH. @param {NodeJS.ProcessEnv} env @param {string} cwd */
function nodeStatus(env, cwd) {
  const r = proc.run('node', ['--version'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const v = r.started && r.status === 0 ? r.stdout.toString('utf8').replace(/\n+$/, '') : '';
  const n = v.startsWith('v') ? v.slice(1) : v;
  const maj = n.split('.')[0] ?? ''; const rest = n.includes('.') ? n.slice(n.indexOf('.') + 1) : n; const min = rest.split('.')[0] ?? '';
  if (!/^[0-9]+$/.test(`${maj}${min}`)) return 'missing';
  const M = Number(maj); const m = Number(min);
  return M > 22 || (M === 22 && m >= 13) ? `ok:${v}` : `old:${v}`;
}

/**
 * `doctor_load` (item 30): machine load above the core count, as one WARN text; '' when the load is fine or cannot be read. PROOFLINE_DOCTOR_LOAD and PROOFLINE_DOCTOR_CORES
 * override the readings (tests). The executable with the most processes is named (never its arguments).
 * @param {NodeJS.ProcessEnv} env @param {() => string} [topProcess] the name of the executable with the most processes
 */
export function loadWarning(env, topProcess = psTop) {
  let l = env.PROOFLINE_DOCTOR_LOAD ?? '';
  if (l === '') { const x = loadavg()[0]; l = Number.isFinite(x) && x >= 0 ? x.toFixed(2) : ''; }
  const c = env.PROOFLINE_DOCTOR_CORES ?? String(availableParallelism());
  if (!/^[0-9]+$/.test(c) || Number(c) === 0) return '';
  l = l.replace(/,/g, '.');
  if (l === '' || /[^0-9.]/.test(l)) return '';
  if (!(Number(l) > Number(c))) return '';
  const t = topProcess();
  return `load: machine load ${l} is above its ${c} cores${t !== '' ? `; the executable with the most processes: ${t}` : ''}. Hooks and tests slow down until it settles`;
}

/** The name of the executable that started the most processes (`ps -A -o comm=`). */
function psTop() {
  const r = proc.run('ps', ['-A', '-o', 'comm='], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (!r.started || r.status !== 0) return '';
  /** @type {Map<string, number>} */ const count = new Map();
  for (const line of r.stdout.toString('utf8').split('\n')) {
    if (line === '') continue;
    const n = line.split('/').pop() ?? '';
    count.set(n, (count.get(n) ?? 0) + 1);
  }
  const rows = [...count].map(([n, c]) => `${c} ${n}`).sort((a, b) => (Number.parseInt(b, 10) - Number.parseInt(a, 10)) || (a < b ? 1 : a > b ? -1 : 0));
  return rows.length > 0 ? rows[0].slice(rows[0].indexOf(' ') + 1) : '';
}

/** The message shared by `init` and `doctor` for a core.hooksPath in the global or system git config. @param {string} value */
export function globalHookspathMessage(value) {
  return `a global/system git core.hooksPath ('${value}') exists; the repository-local core.hooksPath wins here and is left set, but the global one is not touched and applies to your other repositories`;
}

/** @param {string} p */
function isExecutable(p) { try { accessSync(p, constants.X_OK); return true; } catch { return false; } }
/** @param {string} p */
function nonEmpty(p) { try { return statSync(p).size > 0; } catch { return false; } }

/** Run a program with its standard output and error in one string (the shell's `2>&1`); the status is the program's. @param {string} program @param {string[]} args @param {import('./proc.mjs').ProcOptions} opt */
function runMerged(program, args, opt) {
  const dir = mkdtempSync(path.join(tmpdir(), 'proofline-dm-'));
  const f = path.join(dir, 'out');
  const fd = openSync(f, 'w');
  try {
    const r = proc.run(program, args, { ...opt, stdio: ['ignore', fd, fd] });
    closeSync(fd);
    return { status: r.status, text: readFileSync(f, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** The environment of a probe command: no git location, no identity override, no terminal. @param {NodeJS.ProcessEnv} env */
function probeEnv(env) {
  const e = { ...env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL', 'AGENT_ROLE']) delete e[k];
  e.PROOFLINE_NO_TTY = '1';
  return e;
}

class Doctor {
  /** @param {Context} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.root = ctx.root;
    this.cfgFile = `${ctx.root}/.agents/config.yaml`;
    this.agent = `${ctx.root}/.agents/scripts/agent.sh`;
    this.plHome = ctx.env.PL_HOME ?? '';
    this.version = ctx.env.PROOFLINE_VERSION ?? '';
    this.home = ctx.env.HOME ?? '';
    this.fails = 0; this.warns = 0;
    this.runtimes = '';
    /** @type {Config} */ this.cfg = ctx.config();
  }

  /** @param {string} line */
  write(line) { this.ctx.io.stdout.write(Buffer.from(`${line}\n`, 'utf8')); }
  /** @param {string} m */ pass(m) { this.write(`PASS ${m}`); }
  /** @param {string} m */ warn(m) { this.write(`WARN ${m}`); this.warns++; }
  /** @param {string} m */ fail(m) { this.write(`FAIL ${m}`); this.fails++; }

  /** `cfg_val`: the value of a key, or the default when absent or empty. @param {string} key @param {string} [def] */
  val(key, def = '') { return u(this.cfg.get(key, Buffer.from(def, 'utf8').toString('latin1'))); }
  /** @param {string[]} args */
  git(args) { return proc.run('git', ['-C', this.root, ...args], { cwd: this.ctx.cwd, env: this.ctx.env, stdio: ['ignore', 'pipe', 'ignore'] }); }
  /** @param {string[]} args */
  gitOut(args) { const r = this.git(args); return r.status === 0 ? r.stdout.toString('utf8').replace(/\n+$/, '') : ''; }
  /** @param {string} rt */
  hasRuntime(rt) { return ` ${this.runtimes} `.includes(` ${rt} `); }

  /** `manifest_meta KEY` @param {string} key */
  manifestMeta(key) {
    let text;
    try { text = readFileSync(`${this.root}/${MANIFEST_REL}`, 'utf8'); } catch { return ''; }
    for (const l of text.split('\n')) { const m = new RegExp(`^# ${key}: *(.*)$`).exec(l); if (m) return m[1]; }
    return '';
  }

  doctorPlatform() {
    const info = detectPlatform(this.ctx);
    const text = warnText(info);
    const p = info.platform; const c = info.cli; const w = u(info.web);
    const src = info.source === 'config' ? 'config: git.platform' : info.source === 'env' ? 'env: PROOFLINE_PLATFORM' : 'auto: origin URL';
    if (info.url === '') {
      this.warn('platform: the project has no origin remote yet, so the platform is unknown; with one, proofline detects GitHub, GitLab, Azure DevOps and Bitbucket from its address');
      return;
    }
    const lw = u(text).replace(/\n+$/, '');
    if (lw !== '') this.warn(`platform: ${lw.replace(/^warning: /, '')}`);
    const tool = p === 'gitlab' ? 'glab' : p === 'azure' ? 'az' : 'gh';
    if (p === 'github' && c === 'gh') this.pass(`platform: github (source ${src}), tool gh installed; merge rule: proofline opens and merges the pull request, every check must be green, and a pull request without checks is merged only after build and test pass in a clean copy (verified locally, no CI)`);
    else if (p === 'gitlab' && c === 'glab') this.pass(`platform: gitlab (source ${src}), tool glab installed; merge rule: proofline opens and merges the merge request, the pipeline must be green, and a merge request without a pipeline is merged only after build and test pass in a clean copy (verified locally, no CI)`);
    else if (p === 'azure' && c === 'az') this.pass(`platform: azure devops (source ${src}), tool az installed; merge rule: proofline opens and merges the pull request, every build policy must be approved, and a pull request without one is merged only after build and test pass in a clean copy (verified locally, no CI)`);
    else if (p === 'github' || p === 'gitlab' || p === 'azure') this.warn(`platform: ${p} (source ${src}), but its tool (${tool}) is not installed; merge rule: manual. proofline pushes the branch and prints the pull request address (${w}); YOU open and merge it`);
    else if (p === 'bitbucket') this.warn(`platform: bitbucket (source ${src}); merge rule: manual. proofline has no adapter: it pushes the branch and prints the pull request address (${w}); YOU open and merge it`);
    else this.warn(`platform: not recognized (${w !== '' ? w : 'the origin address'}; source ${src}; a private host is named with git.platform and git.platform_host in .agents/config.yaml); merge rule: manual. proofline pushes the branch and prints the manual steps; YOU open and merge the pull request`);
  }

  doctorContext() {
    let text = '';
    try { text = reportText(contextRows('project', this.root, this.ctx.env.PL_HOME || this.root)); } catch { text = ''; }
    text = text.replace(/\n+$/, '');
    if (text === '') { this.warn('context: the size of the text loaded into every session could not be measured'); return; }
    this.pass(text.split('\n').map((l, i) => (i === 0 ? l.replace(/^ */, '') : `    ${l}`)).join('\n'));
  }

  doctorRules() {
    if (!isFile(this.agent)) return;
    const r = agentCall(this.ctx, ['rules', 'report']);
    if (r.status !== 0) return;
    const out = u(r.out).replace(/\n+$/, '');
    if (out === 'project rules: none') return;
    if (/\(OVER\)|^ {2}(merge|ask the user|remove):/m.test(out)) this.warn(out.split('\n').map((l, i) => (i === 0 ? l.replace(/^ */, '') : `    ${l}`)).join('\n'));
    else this.pass(out.split('\n')[0] ?? '');
  }

  doctorIdentity() {
    const ae = emailOf(this.ctx, 'GIT_AUTHOR_IDENT'); const ce = emailOf(this.ctx, 'GIT_COMMITTER_IDENT');
    if (ae === '' || ce === '') { this.warn('identity: git has no commit identity here; set a repository-local one (git config --local user.email ...)'); return; }
    const src = this.gitOut(['config', '--local', '--get', 'user.email']) !== '' ? 'repository-local config'
      : (this.ctx.env.GIT_AUTHOR_EMAIL ?? '') !== '' ? 'GIT_AUTHOR_EMAIL environment' : 'global or system config (consider a repository-local identity)';
    const config = readFileSync(this.cfgFile, 'latin1');
    let bad = '';
    if (forbidden(this.ctx, config, ae)) bad = 'author';
    if (forbidden(this.ctx, config, ce)) bad = `${bad !== '' ? `${bad} and ` : ''}committer`;
    if (bad !== '') this.fail(`identity: the ${bad} identity (${src}) matches git.forbidden_identities; the pre-commit hook will block commits. Set another identity: git config --local user.email ...`);
    else this.pass(`identity: commits use ${this.gitOut(['var', 'GIT_AUTHOR_IDENT']).split('\n')[0].replace(/ [0-9]* [-+][0-9]*$/, '')} from ${src}; no git.forbidden_identities match`);
  }

  /** Live probes in a throwaway repository: the project's own hooks and scripts are copied there. */
  doctorProbes() {
    const env = this.ctx.env;
    let PD;
    try { PD = mkdtempSync(path.join(tmpdir(), 'proofline-doctor.')); } catch { this.warn('probes: cannot create a temp directory'); return; }
    const cleanup = () => { try { rmSync(PD, { recursive: true, force: true }); } catch { /* gone */ } };
    process.once('exit', cleanup);
    try { this.probes(PD, env); } finally { cleanup(); process.removeListener('exit', cleanup); }
  }

  /** @param {string} PD @param {NodeJS.ProcessEnv} env */
  probes(PD, env) {
    const repo = `${PD}/repo`; const remote = `${PD}/remote.git`;
    mkdirSync(repo, { recursive: true }); mkdirSync(remote, { recursive: true });
    const clean = { ...env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete clean[k];
    const init = (/** @type {string[]} */ a) => proc.run('git', a, { env: clean, stdio: 'ignore' }).status === 0;
    if (!(init(['init', '-q', '--bare', remote]) && init(['init', '-q', repo]))) { this.warn('probes: git init failed'); return; }
    const skip = new Set(['runs', 'local', 'skills'].map((n) => `${this.root}/.agents/${n}`));
    try { cpSync(`${this.root}/.agents`, `${repo}/.agents`, { recursive: true, verbatimSymlinks: true, filter: (src) => !skip.has(src) }); } catch { /* the probes below report what is missing */ }
    const pc = `${repo}/.agents/config.yaml`;
    const pe = probeEnv(env);
    /** @param {string[]} a @param {NodeJS.ProcessEnv} [e] */
    const pg = (a, e = pe) => proc.run('git', a, { cwd: repo, env: e, stdio: ['ignore', 'ignore', 'pipe'] });
    /** @param {Buffer} b */
    const firstLine = (b) => b.toString('utf8').split('\n')[0] ?? '';
    pg(['config', 'user.name', 'probe']); pg(['config', 'user.email', 'probe@ok.invalid']); pg(['config', 'commit.gpgsign', 'false']);
    if (pg(['commit', '-q', '--allow-empty', '-m', 'init']).status !== 0) { this.warn('probes: could not create the probe commit'); return; }
    pg(['config', 'core.hooksPath', '.agents/githooks']);
    cfgSet(pc, 'git.protected_branches', ''); cfgSet(pc, 'git.forbidden_identities', '*@blocked.invalid');

    pg(['config', 'user.email', 'x@blocked.invalid']);
    let r = pg(['commit', '-q', '--allow-empty', '-m', 'probe']);
    if (r.status === 0) this.fail('probe: the pre-commit identity guard let a forbidden identity commit');
    else if (r.stderr.toString('utf8').includes('git.forbidden_identities')) this.pass('probe: pre-commit blocks a forbidden identity (names git.forbidden_identities)');
    else this.fail(`probe: pre-commit blocked the commit for another reason: ${firstLine(r.stderr)}`);
    pg(['config', 'user.email', 'probe@ok.invalid']);
    r = pg(['commit', '-q', '--allow-empty', '-m', 'probe2']);
    if (r.status === 0) this.pass('probe: pre-commit lets other identities commit');
    else this.fail(`probe: pre-commit blocks a legitimate commit: ${firstLine(r.stderr)}`);

    cfgSet(pc, 'git.push_requires_approval', 'false'); cfgSet(pc, 'git.protected_branches', 'probe-protected');
    const push = (/** @type {string} */ branch, /** @type {NodeJS.ProcessEnv} */ e = pe) => pg(['push', '-q', remote, `HEAD:refs/heads/${branch}`], e).status === 0;
    if (push('probe-protected')) this.fail('probe: pre-push let an agent push to a protected branch');
    else if (push('probe-open')) this.pass('probe: pre-push blocks a protected branch and allows others');
    else this.fail('probe: pre-push blocks an unprotected branch although push approval is off');
    cfgSet(pc, 'git.push_requires_approval', 'true'); cfgSet(pc, 'git.protected_branches', '');
    if (push('probe-other')) this.fail('probe: pre-push let an agent push without approval');
    else this.pass('probe: pre-push blocks a push without approval');
    // human detection: agent session markers decide, not a terminal (no TTY here; the markers are cleared or set)
    const human = { ...env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'AGENT_ROLE', 'PROOFLINE_NO_TTY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID']) delete human[k];
    const agent = { ...env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'AGENT_ROLE', 'PROOFLINE_NO_TTY']) delete agent[k];
    agent.CLAUDECODE = '1';
    if (push('probe-human', human) && !push('probe-agent', agent)) this.pass('probe: a push without a terminal or agent markers passes as a human; one with agent markers is blocked');
    else this.fail('probe: human detection is wrong (a push without agent markers must pass, one with CLAUDECODE set must be blocked)');

    if (commandV('node', env) === null) { this.warn('probe: runtime hooks not probed (the hook needs node)'); return; }
    const hook = `${repo}/.agents/hooks/proofline-hook.mjs`;
    mkdirSync(`${repo}/.agents/local`, { recursive: true }); mkdirSync(`${repo}/src`, { recursive: true });
    const he = { ...env }; delete he.AGENT_ROLE; he.CLAUDE_PROJECT_DIR = repo; he.PROOFLINE_NO_TTY = '1';
    /** @param {string} rt @param {string} json */
    const hookDenies = (rt, json) => {
      const o = proc.run('node', [hook, 'pretool', rt], { cwd: this.ctx.cwd, env: he, input: json, stdio: ['pipe', 'pipe', 'ignore'] });
      return o.stdout.toString('utf8').includes('"permissionDecision":"deny"');
    };
    const tool = (/** @type {string} */ name, /** @type {object} */ input) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: repo, tool_name: name, tool_input: input });
    const editJson = tool('Edit', { file_path: `${repo}/src/probe.js` });
    writeFileSync(`${repo}/.agents/local/ACTIVE_RUN`, 'DOCTOR-1\n');
    if (this.hasRuntime('claude')) {
      if (hookDenies('claude', editJson)) this.pass('probe: the Claude PreToolUse hook denies a lead edit of product code during a run');
      else this.fail('probe: the Claude PreToolUse hook did not deny a lead edit during an active run');
    }
    if (this.hasRuntime('codex')) {
      if (hookDenies('codex', tool('Bash', { command: 'printf x > src/probe.js' }))) this.pass('probe: the Codex PreToolUse hook denies a lead shell write during a run');
      else this.fail('probe: the Codex PreToolUse hook did not deny a lead shell write during an active run');
    }
    writeFileSync(`${repo}/.agents/local/ACTIVE_RUN`, '');
    // A169: the lead's ban on product files holds without a run too; a task file stays writable
    const taskJson = tool('Write', { file_path: `${repo}/.agents/tasks/probe.md` });
    if (!hookDenies('claude', editJson)) this.fail('probe: the PreToolUse hook did not deny a lead edit of product code although no run is active (A169)');
    else if (hookDenies('claude', taskJson)) this.fail('probe: the PreToolUse hook denies a task file without an active run');
    else this.pass('probe: without an active run the PreToolUse hook denies a lead product edit and lets a task file through');
  }

  /** Foreign context sources (WARN only, never FAIL): hooks that add context to the prompt and skills whose name overlaps a proofline method skill. */
  doctorForeign() {
    const home = this.home;
    /** @param {string} dir @returns {string[]} */
    const subdirs = (dir) => { try { return readdirSync(dir).filter((n) => !n.startsWith('.')).sort().map((n) => `${dir}/${n}`); } catch { return []; } };
    const cacheDirs = (/** @type {string} */ tail) => subdirs(`${home}/.claude/plugins/cache`).flatMap((a) => subdirs(a)).flatMap((b) => subdirs(b)).map((c) => `${c}/${tail}`);
    const files = [`${this.root}/.claude/settings.json`, `${this.root}/.claude/settings.local.json`, `${home}/.claude/settings.json`, ...cacheDirs('hooks/hooks.json')];
    for (const f of files) {
      if (!isFile(f)) continue;
      if (f.includes('/plugins/cache/proofline/')) continue;
      const label = f.startsWith(`${home}/`) ? f.slice(home.length + 1) : f;
      const rows = foreignHooks(f).map(([e, c]) => `WARN foreign hook: ${e} in ${label} may add context to the prompt: ${c}`);
      if (rows.length === 0) continue;
      const text = rows.join('\n').replace(/\n+$/, '');
      this.write(text);
      this.warns += text.split('\n').length;
    }
    const skillDirs = [...subdirs(`${home}/.claude/skills`), ...subdirs(`${this.root}/.claude/skills`), ...cacheDirs('skills').flatMap((d) => subdirs(d))];
    for (const d of skillDirs) {
      if (!isDir(d)) continue;
      if (d.includes('/plugins/cache/proofline/')) continue;
      const n = d.slice(d.lastIndexOf('/') + 1);
      if (n.startsWith('proofline')) continue;
      if (isDir(`${this.root}/.agents/skills/${n}`)) continue;
      if (!/(^|-)(tdd|debug|debugging|review|plan|planning|plans|ui-audit)(-|$)|test-driven/.test(n)) continue;
      this.warn(`overlapping skill: ${n} (${d.split('/').slice(0, -2).join('/')}) overlaps a proofline method skill; during a run proofline's own skill is used`);
    }
  }

  /** 0.0.26: the language runtimes the project's CI specifies against the ones installed here (WARN only). */
  doctorToolchain() {
    const script = `${this.plHome}/skills/verify-proof/scripts/runtime-versions.sh`;
    if (this.plHome === '' || !isFile(script)) return;
    const r = proc.run('sh', [script], { cwd: this.root, env: this.ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0) return;
    /** @type {any} */ let defn = null;
    try { defn = JSON.parse(readFileSync(`${this.plHome}/control-plane/agents/ecosystems.json`, 'utf8')); } catch { defn = null; }
    for (const line of r.stdout.toString('utf8').split('\n')) {
      const f = line.split(/[ \t]+/).filter((x) => x !== '');
      if (f[0] !== 'runtime:') continue;
      const n = f[1] ?? '';
      if (n === 'none') continue;
      const strip = (/** @type {string|undefined} */ v, /** @type {string} */ p) => { const s = v ?? ''; return s.startsWith(p) ? s.slice(p.length) : s; };
      const l = strip(f[2], 'local='); const c = strip(f[3], 'ci='); const src = strip(f[4], 'source='); const st = strip(f[5], 'status=');
      let unit = 'major';
      if (defn) {
        const eco = (defn.ecosystems ?? []).find((/** @type {any} */ e) => e?.runtime?.name === n);
        if (eco) unit = String(eco.runtime.compare ?? '') === '1' ? 'major' : 'major.minor';
      }
      if (l === 'missing') this.warn(`toolchain ${n}: not installed here${c === 'none' ? '' : `, CI specifies ${c} (${src})`}`);
      else if (st === 'mismatch') this.warn(`toolchain ${n}: local ${l}, CI specifies ${c} (${src}); the ${unit} version differs, so a green local run may not hold in CI`);
      else if (c === 'none') this.pass(`toolchain ${n}: local ${l} (no CI-specified version found)`);
      else if (st === 'match') this.pass(`toolchain ${n}: local ${l} matches CI ${c} (${src})`);
      else this.pass(`toolchain ${n}: local ${l}, CI specifies ${c} (${src}), not comparable`);
    }
  }

  /** A174: the review risk paths and the dependency signal read .agents/ecosystems.tsv; a missing, empty or stale tsv would silently shrink them, so doctor FAILs. */
  doctorEcosystems() {
    const j = `${this.root}/.agents/ecosystems.json`; const t = `${this.root}/.agents/ecosystems.tsv`; const m = `${this.root}/.agents/ecosystems.mjs`;
    if (!nonEmpty(t)) { this.fail('ecosystems: .agents/ecosystems.tsv is missing or empty, so the risky-path and dependency sets are empty (run: proofline upgrade)'); return; }
    if (!nonEmpty(j)) { this.fail('ecosystems: .agents/ecosystems.json is missing (run: proofline upgrade)'); return; }
    if (!isFile(`${this.root}/.agents/scripts/ecosystems.sh`)) { this.fail('ecosystems: .agents/scripts/ecosystems.sh is missing, so agent.sh cannot read the definition (run: proofline upgrade)'); return; }
    const same = (/** @type {string} */ a, /** @type {string} */ b) => { try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
    if (commandV('node', this.ctx.env) !== null && isFile(m)) {
      const o = runMerged('node', [m, 'check'], { cwd: this.ctx.cwd, env: this.ctx.env });
      if (o.status === 0) this.pass('ecosystems: .agents/ecosystems.tsv is what .agents/ecosystems.json generates');
      else this.fail(`ecosystems: ${headJoined(o.text, 2)} (fix: node .agents/ecosystems.mjs write, or proofline upgrade)`);
    } else if (same(j, `${this.plHome}/control-plane/agents/ecosystems.json`)) {
      if (same(t, `${this.plHome}/control-plane/agents/ecosystems.tsv`)) this.pass('ecosystems: .agents/ecosystems.tsv equals the shipped one');
      else this.fail('ecosystems: .agents/ecosystems.tsv differs from the shipped one although ecosystems.json is the shipped file (run: proofline upgrade)');
    } else this.warn('ecosystems: node is not available and .agents/ecosystems.json is not the shipped file, so the tsv could not be checked');
  }

  doctorVersion() {
    const inst = this.val('proofline_version', '');
    if (inst === '') return;
    if (inst === this.version) { this.pass(`version: plugin and project install are both ${inst}`); return; }
    if (versionCompare(inst, this.version) < 0) this.warn(`version: plugin ${this.version}, project install ${inst}; the project is older. Next step: /proofline upgrade`);
    else this.warn(`version: plugin ${this.version}, project install ${inst}; the project is newer than the plugin. Next step: update the plugin`);
  }

  doctorTools() {
    const env = this.ctx.env;
    const ag = commandV('ast-grep', env); const rtk = commandV('rtk', env);
    const a = ag !== null ? `ast-grep installed (${ag})` : 'ast-grep not installed (rg/grep are used)';
    const r = rtk !== null ? `rtk installed (${rtk}); evidence commands run with RTK_DISABLED=1 (rtk configuration docs)` : 'rtk not installed';
    this.pass(`tools: ${a}; ${r}`);
  }

  doctorNode() {
    const s = nodeStatus(this.ctx.env, this.ctx.cwd);
    if (s.startsWith('ok:')) this.pass(`node: ${s.slice(3)} (Node 22.13 or newer is a runtime requirement)`);
    else if (s.startsWith('old:')) this.warn(`node: ${s.slice(4)} is older than 22.13; the commands that run in Node exit non-zero and the guards that need them deny (install Node 22.13 or newer)`);
    else this.fail('node: not found on PATH; proofline needs Node 22.13 or newer (the commands that run in Node exit 127 and the guards that need them deny; install it)');
  }

  doctorEngine() {
    if (!isFile(`${this.root}/.agents/scripts/proofline-core.mjs`) || !isDir(`${this.root}/.agents/scripts/core`)) {
      this.fail('engine: .agents/scripts/proofline-core.mjs or .agents/scripts/core/ is missing, so the moved commands cannot run in Node 22.13 or newer and exit 127 (run: proofline upgrade)');
      return;
    }
    this.pass('engine: the commands run in Node');
  }

  doctorManifest() {
    const mf = `${this.root}/${MANIFEST_REL}`;
    if (!isFile(mf)) { this.warn(`manifest: ${MANIFEST_REL} missing; upgrade cannot tell your edits from proofline's files`); return; }
    const critical = (/** @type {string} */ p) => ['.agents/scripts/agent.sh', '.agents/scripts/dispatch.sh', '.agents/scripts/proofline-core.mjs', '.agents/owns.conf', '.agents/roles/owns.conf', '.agents/tools.conf', '.agents/roles.conf'].includes(p)
      || ['.agents/scripts/core/', '.agents/githooks/', '.agents/hooks/', '.agents/skills/proofline-lead/'].some((d) => p.startsWith(d));
    let bad = 0; let gone = 0; /** @type {string[]} */ const crit = [];
    for (const line of readFileSync(mf, 'utf8').split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const m = /^[ \t]*([^ \t]*)[ \t]*(.*?)[ \t]*$/.exec(line);
      const sum = m?.[1] ?? ''; const rel = m?.[2] ?? '';
      if (!existsSync(`${this.root}/${rel}`)) {
        if (critical(rel)) crit.push(rel); else gone++;
      } else if (sha256File(`${this.root}/${rel}`) !== sum) bad++;
    }
    for (const c of crit) this.fail(`manifest: required control-plane file missing: ${c} (run: proofline upgrade)`);
    if (gone > 0) this.warn(`manifest: ${gone} installed file(s) are missing (proofline upgrade restores them)`);
    if (bad > 0) this.warn(`manifest: ${bad} installed file(s) differ from the installed version (modified by you; upgrade keeps them)`);
    if (gone === 0 && bad === 0 && crit.length === 0) this.pass('manifest: every installed file matches');
  }

  doctorGitHooks() {
    const hp = this.gitOut(['config', '--get', 'core.hooksPath']);
    if (hp === '.agents/githooks' || hp === `${this.root}/.agents/githooks`) {
      let ok = true;
      for (const h of ['pre-commit', 'pre-push']) {
        if (!isExecutable(`${this.root}/.agents/githooks/${h}`)) { this.fail(`git hooks: .agents/githooks/${h} is missing or not executable`); ok = false; }
      }
      if (ok) this.pass('git hooks: core.hooksPath = .agents/githooks, pre-commit and pre-push executable');
    } else if (hp === '') this.fail('git hooks: core.hooksPath is not set; the commit and push locks are inactive. Fix: git config --local core.hooksPath .agents/githooks');
    else this.fail(`git hooks: core.hooksPath is '${hp}', not .agents/githooks; the proofline locks are inactive`);
    const glob = this.gitOut(['config', '--global', '--get', 'core.hooksPath']) || this.gitOut(['config', '--system', '--get', 'core.hooksPath']);
    if (glob !== '') this.warn(`git hooks: ${globalHookspathMessage(glob)}`);
  }

  doctorConfigAndApproval() {
    const c = runMerged('sh', [this.agent, 'config-check'], { cwd: this.root, env: this.ctx.env });
    if (c.status === 0) this.pass(`config: ${c.text.replace(/\n+$/, '').split('\n')[0]}`);
    else this.fail(`config: agent.sh config-check failed: ${headJoined(c.text, 2)}`);
    // A202 item 28: how long the approval path takes on THIS machine against the hook's approval budget
    let b = this.val('hook.approve_budget_seconds', '20');
    b = /^[0-9]+$/.test(b) ? b : '20';
    let budget = Number(b); if (budget < 5) budget = 5; if (budget > 25) budget = 25;
    const t0 = Date.now();
    for (const a of [['fingerprint'], ['approve-pending', '-']]) proc.run('sh', [this.agent, ...a], { cwd: this.root, env: this.ctx.env, stdio: 'ignore' });
    const ms = Date.now() - t0;
    if (ms >= budget * 500) this.warn(`approval path: ${ms} ms on this machine, ${budget * 1000} ms hook budget (hook.approve_budget_seconds); close to or over half of it. A slow machine can raise hook.approve_budget_seconds in .agents/config.yaml (5 to 25); the cause is usually a large unignored folder or a loaded machine`);
    else this.pass(`approval path: ${ms} ms (hook budget ${budget * 1000} ms)`);
  }

  doctorTimeouts() {
    const sc = this.val('timeouts.scale', '1.0');
    const info = u(agentCall(this.ctx, ['timeouts']).out);
    const mx = /^dispatch\.CRITICAL=(.*)$/m.exec(info)?.[1] ?? '';
    this.pass(`time limits: timeouts.scale ${sc}, a dispatched step may take up to ${mx !== '' ? mx : '?'} s (CRITICAL); the approval budget is never scaled. This machine's speed: proofline doctor --scale`);
  }

  doctorLeadModel() {
    const core = `${this.root}/.agents/scripts/proofline-core.mjs`;
    if (this.val('runtime.lead', 'claude') !== 'codex' || !isFile(core)) return;
    if (!/^ {2}lead_base_model:/m.test(readFileSync(this.cfgFile, 'latin1'))) this.warn('lead model: .agents/config.yaml has no execution_policy.lead_base_model (the built-in base is used; run: proofline upgrade)');
    const run = (/** @type {string[]} */ a) => { const r = agentCall(this.ctx, ['cli', 'exec-policy', ...a]); return r; };
    const res = run(['resolve', '--role', 'lead', '--class', 'STANDARD', '--tier', 'full']);
    const lm = res.status === 0 ? (/^model=(.*)$/m.exec(res.out)?.[1] ?? '') : '';
    if (lm !== '') {
      const chk = run(['check-lead', '--runtime', 'codex', '--model', lm]);
      if (chk.status === 0) this.pass(`lead model: codex lead resolves to ${lm} (base model or stronger)`);
      else this.fail(`lead model: ${u(chk.out + chk.err).split('\n')[0]}`);
    } else this.warn('lead model: could not resolve the codex lead model (the execution-policy resolve failed)');
  }

  doctorRuntimes() {
    const used = ` ${this.val('runtime.lead', 'claude')} ${this.val('runtime.worker', '')} ${this.val('runtime.reviewers', '')} `;
    for (const rt of ['claude', 'codex']) {
      const bin = binOf(this.ctx, rt) ?? rt;
      const found = commandV(bin, this.ctx.env);
      if (found !== null) {
        const v = proc.run(bin, ['--version'], { cwd: this.ctx.cwd, env: this.ctx.env, stdio: ['ignore', 'pipe', 'ignore'] });
        this.pass(`runtime ${rt}: ${v.stdout.toString('utf8').split('\n')[0] ?? ''} (${found})`);
      } else if (used.includes(` ${rt} `)) this.warn(`runtime ${rt}: not installed, but config.yaml uses it (failover/dispatch to ${rt} will be BLOCKED)`);
      else this.pass(`runtime ${rt}: not installed (not used by config.yaml)`);
    }
  }

  doctorHooks() {
    const h = `${this.root}/.agents/hooks`;
    if (!isFile(`${h}/proofline-hook.mjs`)) this.fail('hooks: .agents/hooks/proofline-hook.mjs missing (run: proofline upgrade)');
    else if (!isDir(`${h}/events`) || !isDir(`${h}/guards`) || !isDir(`${h}/lib`) || !isFile(`${h}/command-scan.mjs`)) this.fail('hooks: .agents/hooks/ lacks events/, guards/, lib/ or command-scan.mjs of the Node hook (run: proofline upgrade)');
    else this.pass('hooks: .agents/hooks/proofline-hook.mjs present');
    if (this.hasRuntime('claude')) {
      const miss = EVENTS.filter((e) => !hookHas(`${this.root}/.claude/settings.json`, e)).map((e) => ` ${e}`).join('');
      if (miss === '') this.pass('claude hooks: .claude/settings.json wires all 7 proofline events');
      else if (this.pluginListsProofline()) this.pass('claude hooks: provided by the proofline plugin (project settings do not need them)');
      else this.fail(`claude hooks: .claude/settings.json lacks proofline hooks for:${miss} (run: proofline init)`);
    }
    if (this.hasRuntime('codex')) {
      const miss = EVENTS.filter((e) => !hookHas(`${this.root}/.codex/hooks.json`, e)).map((e) => ` ${e}`).join('');
      if (miss === '') this.pass('codex hooks: .codex/hooks.json wires all 7 proofline events');
      else this.fail(`codex hooks: .codex/hooks.json lacks proofline hooks for:${miss} (run: proofline init)`);
      this.warn('codex trust: Codex loads project hooks only once the project is trusted and the hooks are reviewed; open codex here and approve them with /hooks (doctor cannot check this)');
    }
  }

  /** `claude plugin list` (20 s, its own process group): is proofline among the plugins? */
  pluginListsProofline() {
    const dir = mkdtempSync(path.join(tmpdir(), 'proofline-pl-'));
    try {
      const r = runWithTimeout(20, [this.ctx.env.PROOFLINE_CLAUDE_BIN || 'claude', 'plugin', 'list'], { cwd: this.ctx.cwd, env: this.ctx.env, outFile: `${dir}/out` });
      void r;
      return /proofline/i.test(readFileSync(`${dir}/out`, 'utf8'));
    } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  doctorCommands() {
    const empty = emptyKinds(this.ctx);
    if (empty.length > 0) this.warn(`commands: empty in .agents/config.yaml: ${empty.join(' ')} (the verify gate has nothing to run for them and no build record can be made). Fix: proofline doctor --commands finds the commands, proves each by one run and asks you once (A200)`);
  }

  doctorNetenv() {
    const rows = droppedNetVars(this.ctx).filter((d) => /^[A-Za-z0-9_]{1,64}$/.test(d.name) && /^[A-Za-z0-9 ,.()_/:-]{1,200}$/.test(d.reason));
    if (rows.length === 0) return;
    const list = rows.map((d) => `${d.name} (${d.reason})`).join('; ');
    this.warn(`network: these proxy or certificate variables are set here but NOT passed to gh, glab, az and the merge-proof git (values are never shown): ${list}. Allowed, with a value that passes the check: HTTPS_PROXY, HTTP_PROXY, NO_PROXY, SSL_CERT_FILE, NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, GIT_SSL_CAINFO`);
  }

  /** A163, A180: no pull_request check is a warning (the commit is then verified locally before the merge), with the fix line. */
  doctorCi() {
    const ci = ciCheckResult(this.ctx);
    const text = u(ci.text).replace(/\n+$/, '');
    const first = text.split('\n')[0] ?? '';
    if (first === 'ci: absent') {
      let build = ''; let test = '';
      try { const f = discoverCommands(this.root); build = f.build.join('\n'); test = f.test.join('\n'); } catch { /* nothing discovered */ }
      const saved = this.ctx.env;
      this.ctx.env = { ...saved, PROOFLINE_CI_BUILD: Buffer.from(build, 'utf8').toString('latin1'), PROOFLINE_CI_TEST: Buffer.from(test, 'utf8').toString('latin1') };
      const fix = u(ciTaskCommandText(this.ctx));
      this.ctx.env = saved;
      this.warn(`ci: ${text.split('\n')[1] ?? ''} Fix: ${fix}`);
    } else if (first.startsWith('ci: present')) this.pass(text);
  }

  doctorWorktrees() {
    for (const l of leftoverWorktrees(this.ctx)) {
      this.warn(`worktrees: the worktree of ${l.id} is a leftover: its run is DONE and ${u(l.reason)}, but .agents/local/worktrees/${l.id} is still present. To remove it (the run records are archived first), run: ${l.command}`);
    }
  }

  doctorLoad() {
    const w = loadWarning(this.ctx.env);
    if (w !== '') this.warn(w);
  }

  /** The whole report; the status is 1 on any FAIL. */
  report() {
    if (!isFile(this.cfgFile) || !isFile(this.agent)) {
      this.fail(`installed: .agents/config.yaml or .agents/scripts/agent.sh missing in ${this.root} (run: proofline init)`);
      this.write(`doctor: ${this.fails} FAIL, ${this.warns} WARN`);
      return 1;
    }
    this.runtimes = this.manifestMeta('runtimes');
    if (this.runtimes === '') {
      const words = `${this.val('runtime.lead', 'claude')} ${this.val('runtime.worker', '')} ${this.val('runtime.reviewers', '')}`.split(' ').filter((x) => x !== '');
      this.runtimes = [...new Set(words)].sort().join(' ');
    }
    this.pass(`installed: proofline ${this.val('proofline_version', '?')} in ${this.root} (runtimes: ${this.runtimes}, profile ${this.val('profile', 'balanced')})`);
    this.doctorNode();
    this.doctorEngine();
    this.doctorManifest();
    this.doctorGitHooks();
    this.doctorConfigAndApproval();
    this.doctorTimeouts();
    this.doctorEcosystems();
    this.doctorLeadModel();
    this.doctorRuntimes();
    this.doctorHooks();
    this.doctorCommands();
    this.doctorPlatform();
    this.doctorNetenv();
    this.doctorCi();
    this.doctorWorktrees();
    this.doctorContext();
    this.doctorRules();
    this.doctorVersion();
    this.doctorLoad();
    this.doctorTools();
    this.doctorToolchain();
    this.doctorForeign();
    this.doctorIdentity();
    this.doctorProbes();
    this.write(`doctor: ${this.fails} FAIL, ${this.warns} WARN`);
    return this.fails === 0 ? 0 : 1;
  }
}

/** `proofline: MSG`, status 1 (the front end appends the user's next step). @param {string} msg */
const die = (msg) => new ProoflineError(`proofline: ${msg}`, 1);

/** `require_installed` @param {Context} ctx */
export function requireInstalled(ctx) {
  if (!isFile(ctx.configFile) || !isFile(`${ctx.scripts}/agent.sh`)) throw die(`proofline is not installed in ${ctx.root} (.agents/config.yaml missing); run: proofline init`);
}

/**
 * `cli doctor [--commands|--apply-commands|--scale|--apply-scale]`. The root is the project named by PROOFLINE_ROOT.
 * @param {Context} ctx @param {string[]} args
 */
export function doctorCommand(ctx, args) {
  const a = args[0] ?? '';
  if (a === '--commands') { requireInstalled(ctx); return proposeCommands(ctx); }
  if (a === '--apply-commands') { requireInstalled(ctx); return applyCommands(ctx); }
  if (a === '--scale') { requireInstalled(ctx); return proposeScale(ctx); }
  if (a === '--apply-scale') { requireInstalled(ctx); return applyScale(ctx); }
  if (a !== '') throw die(`doctor: unknown argument: ${a}`);
  return new Doctor(ctx).report();
}
