// @ts-check
// The hook context: everything the shell hook worked out before its `case "$ev"` (lines 17-375 of proofline-hook.sh), once per process.
//
//   ctx.ev, ctx.rt           the event name (pretool|posttool|subagent-start|subagent-stop|prompt|stop|session) and the runtime (claude|codex)
//   ctx.input, ctx.parsed    the event JSON (parsed=false: stdin was not JSON); ctx.get('a.b', 'c') is the shell hook's `jget a.b c`
//   ctx.cwd, ctx.root        the working directory the runtime named, the project root (physical)
//   ctx.mainRoot, ctx.sharedLocal   the main working tree and its .agents/local (state that belongs to no run, A185)
//   ctx.sroot, ctx.localDir, ctx.agentPath   the worktree that owns the run (else the root), its .agents/local, its agent.sh
//   ctx.installed            .agents/config.yaml and .agents/scripts/agent.sh exist
//   ctx.act                  the active run: '' (none), 'INVALID' (malformed ACTIVE_RUN, fail closed) or the id
//   ctx.role, ctx.prole, ctx.aid, ctx.aidf, ctx.sub, ctx.ro   the caller (lead / subagent role / headless specialist)
//   ctx.agent(argv, opt)     one agent.sh command (see agent.mjs); ctx.line/step: the hook-times spool; ctx.once(): the duplicate guard
import { realpathSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Agents } from './agent.mjs';
import { append, isDir, isFile, mkdirp, put, readText, rmf } from './fsx.mjs';
import { canon, cmdSubst, jget, safe, sha256, validRole } from './text.mjs';

export const EVENTS = ['pretool', 'posttool', 'subagent-start', 'subagent-stop', 'prompt', 'stop', 'session'];

/** The roles that work in the project tree without writing to it (A143). */
const READ_ROLES = ['qa', 'reviewer', 'security_reviewer', 'verifier'];

export class HookContext {
  /** @param {string} ev @param {string} rt @param {Buffer} raw @param {NodeJS.ProcessEnv} env */
  constructor(ev, rt, raw, env) {
    this.ev = ev;
    this.rt = rt;
    this.raw = raw;
    this.env = env;
    this.pid = process.pid;
    // a millisecond clock only for the events a person waits on, else whole seconds times 1000 (hk_fine)
    this.fine = ['prompt', 'session', 'stop', 'subagent-start', 'subagent-stop'].includes(ev);
    this.v = 0; this.s = 0;
    this.tick();
    this.t0 = this.v;
    /** @type {unknown} */ this.input = null;
    this.parsed = false;
    this.cwd = '';
    this.root = '';
    this.mainRoot = '';
    this.sharedLocal = '';
    this.sroot = '';
    this.localDir = '';
    this.agentPath = '';
    this.installed = false;
    this.act = '';
    this.role = 'lead'; this.prole = ''; this.aid = ''; this.atype = ''; this.aidf = ''; this.sub = false; this.ro = false;
    this.lockWait = 8; this.approveBudget = 20; this.nextBudget = 10;
    /** @type {string} */ this.mark = '';
    /** @type {string} */ this.intake = '';
    /** @type {Agents | null} */ this.agents = null;
    /** @type {Array<() => void>} */ this.exitHooks = [];
  }

  /** `hk_tick`: the clock (epoch milliseconds in v, epoch seconds in s). */
  tick() {
    const now = Date.now();
    this.v = this.fine ? now : Math.floor(now / 1000) * 1000;
    this.s = Math.floor(now / 1000);
    return this.v;
  }

  /** `jget PATH...` @param {...string} paths */
  get(...paths) { return this.parsed ? jget(this.input, ...paths) : ''; }

  /** One agent.sh command. @param {string[]} argv @param {import('./agent.mjs').AgentOptions} [opt] */
  agent(argv, opt) { return /** @type {Agents} */ (this.agents).run(argv, opt); }

  /** `hk_line NAME MS RESULT [NOTE]`: a line of the hook-times spool, stamped with the clock of the last tick. @param {string} name @param {number} ms @param {string} result @param {string} [note] */
  line(name, ms, result, note = '') {
    if (!this.installed) return;
    try { append(`${this.localDir}/hook-times`, `${this.s}|${name}|${ms}|${result}|${note}\n`); } catch { /* the spool is a convenience */ }
  }

  /** `hk_step NAME T0`: the time of one step of this hook. @param {string} name @param {number} t0 */
  step(name, t0) { this.tick(); this.line(`${this.ev}.${name}`, this.v - t0, 'ok'); }

  /** The in-flight markers of hooks that are gone without finishing (the runtime killed them at its time limit): a timeout line each. */
  sweep() {
    const dir = `${this.localDir}/hooks-inflight`;
    let list;
    try { list = readdirSync(dir).sort(); } catch { return; }
    for (const n of list) {
      const f = `${dir}/${n}`;
      if (f === this.mark || !isFile(f)) continue;
      const txt = readText(f).split('\n')[0] ?? '';
      const m = /^([0-9]+) ([0-9]+)$/.exec(txt);
      if (!m) { rmf(f); continue; }
      if (alive(Number(m[1]))) continue;
      const name = n.includes('.') ? n.slice(0, n.lastIndexOf('.')) : n;
      this.tick();
      this.line(name, this.v - Number(m[2]), 'timeout', 'killed-before-finish');
      rmf(f);
    }
  }

  /** `hk_flush`: move the spool into the ledger of the active run; never waits long for the locks. */
  async flush() {
    let size = 0;
    try { size = statSync(`${this.localDir}/hook-times`).size; } catch { /* none */ }
    if (size === 0 || this.act === '' || this.act === 'INVALID') return;
    await this.agent(['hook-time', this.act], { lockWait: 3 });
  }

  /**
   * `once`: the same hook registered from several places (plugin, project, user; Codex runs it up to three times) runs once per identical event;
   * a copy that starts less than two seconds after the first returns false. Only for events with side effects (prompt, session).
   */
  once() {
    const dir = `${this.localDir}/hooklock`;
    if (!isDir(dir) && !mkdirp(dir)) return true;
    pruneOld(dir, 5 * 60000);
    const key = `${dir}/${this.ev}.${sha256(this.raw).slice(0, 16)}`;
    const n = this.s;
    try { put(key, `${n}\n`, { exclusive: true }); return true; } catch { /* a first copy exists */ }
    let p = Number(readText(key).trim());
    if (readText(key).trim() === '') return false; // the first copy is still writing its stamp
    if (!Number.isFinite(p)) p = 0;
    if (n - p <= 1) return false;
    // an old stamp: one copy takes it over (mkdir is atomic), then checks that no other copy did
    try { mkdirSync(`${key}.t`); } catch { return false; }
    const t = readText(key).trim();
    p = /^[0-9]+$/.test(t) ? Number(t) : 0;
    if (n - p <= 1) { try { rmSync(`${key}.t`, { recursive: true }); } catch { /* gone */ } return false; }
    try { put(key, `${n}\n`); } catch { /* ignore */ }
    try { rmSync(`${key}.t`, { recursive: true }); } catch { /* gone */ }
    return true;
  }
}

/** `kill -0` @param {number} pid */
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

/** `find DIR -type f -mmin +N -exec rm -f`, N in milliseconds @param {string} dir @param {number} ms */
function pruneOld(dir, ms) {
  let list;
  try { list = readdirSync(dir); } catch { return; }
  const limit = Date.now() - ms;
  for (const n of list) {
    try { const st = statSync(`${dir}/${n}`); if (st.isFile() && st.mtimeMs < limit) rmSync(`${dir}/${n}`, { force: true }); } catch { /* gone */ }
  }
}

/** The nearest folder at or above DIR that holds a .git (what `git rev-parse --show-toplevel` answers), else null. @param {string} dir */
export function gitToplevel(dir) {
  let d = dir;
  for (;;) {
    try { statSync(`${d}/.git`); return d; } catch { /* keep walking */ }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The logical working directory of the process, as the shell's $PWD. */
function shellPwd(env) {
  const cwd = process.cwd();
  const pwd = env.PWD;
  if (pwd && path.isAbsolute(pwd)) { try { if (realpathSync(pwd) === realpathSync(cwd)) return pwd; } catch { /* fall through */ } }
  return cwd;
}

/** A path from the runtime in POSIX form (Windows drive and backslash spellings are converted before anything resolves them). @param {string} p */
function inputPath(p) {
  if (!/^[A-Za-z]:[\\/]/.test(p) && !p.includes('\\')) return p;
  return p.replace(/\\/g, '/');
}

/**
 * `hk_cfgnum KEY DEFAULT MIN MAX`: a number of the `hook:` section of .agents/config.yaml, moved to the nearest bound, else the default.
 * @param {string} cfgText @param {string} key @param {number} def @param {number} min @param {number} max
 */
export function cfgNum(cfgText, key, def, min, max) {
  let cv = String(def);
  let inHook = false;
  for (const l of cfgText.split('\n')) {
    if (l.startsWith('hook:')) { inHook = true; continue; }
    if (l !== '' && !l.startsWith(' ') && !l.startsWith('#')) inHook = false;
    if (!inHook || !l.startsWith(`  ${key}:`)) continue;
    cv = l.slice(l.indexOf(':') + 1);
    const hash = cv.indexOf('#');
    if (hash >= 0) cv = cv.slice(0, hash);
    cv = cv.replace(/[ \t"]/g, '');
    while (/^0./.test(cv)) cv = cv.slice(1);
    if (cv === '' || /[^0-9]/.test(cv)) cv = String(def);
    else if (cv.length >= 6) cv = String(max);
    else cv = String(Math.min(max, Math.max(min, Number(cv))));
  }
  return Number(cv);
}

/** The environment override of a time knob: a short number without leading zeros, else the config value. @param {string | undefined} envVal @param {number} cfgVal */
function knob(envVal, cfgVal) {
  let v = envVal ?? '';
  if (v === '') return cfgVal;
  while (/^0./.test(v)) v = v.slice(1);
  return v === '' || /[^0-9]/.test(v) || v.length >= 6 ? cfgVal : Number(v);
}

/**
 * Build the context. Returns null when the shell hook would have exited silently (a root that cannot be entered).
 * @param {string} ev @param {string} rt @param {Buffer} raw @param {NodeJS.ProcessEnv} env
 * @returns {Promise<HookContext | null>}
 */
export async function buildContext(ev, rt, raw, env) {
  const c = new HookContext(ev, rt, raw, env);
  // A202 item 28: the user's prompt is on disk FIRST, before any parse or lookup (the project named by the runtime, when it names one)
  if (env.CLAUDE_PROJECT_DIR) intakeWrite(c, inputPath(env.CLAUDE_PROJECT_DIR));
  try {
    // the existing test seam of the shell hook: PROOFLINE_JSON=none means "no JSON parser" (the input then counts as unparsable)
    if (env.PROOFLINE_JSON === 'none') throw new Error('no JSON parser');
    const text = raw.toString('utf8');
    c.input = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    c.parsed = true;
  } catch { c.parsed = false; }
  let cwd = c.get('cwd');
  if (cwd !== '') cwd = inputPath(cwd);
  if (cwd === '' || !isDir(cwd)) cwd = shellPwd(env);
  c.cwd = cwd;
  let rootIn = env.CLAUDE_PROJECT_DIR ? inputPath(env.CLAUDE_PROJECT_DIR) : '';
  if (rootIn === '') rootIn = gitToplevel(realOr(cwd)) ?? cwd;
  try { c.root = realpathSync(rootIn); } catch { return null; }
  intakeWrite(c, c.root);
  c.agentPath = `${c.root}/.agents/scripts/agent.sh`;
  c.installed = isFile(`${c.root}/.agents/config.yaml`) && isFile(c.agentPath);
  c.mainRoot = c.root;
  c.agents = new Agents({ root: c.root, mainRoot: c.mainRoot, agentPath: c.agentPath, env, lockWait: c.lockWait, cwd: process.cwd() });
  if (isFile(`${c.root}/.git`)) { // root itself is a linked worktree: its main tree holds the shared state
    const proc = await c.agents.proc();
    if (proc) {
      const r = proc.run('git', ['-C', c.root, 'worktree', 'list', '--porcelain'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      const first = r.stdout.toString('utf8').split('\n')[0] ?? '';
      const m = first.startsWith('worktree ') ? first.slice(9) : '';
      if (m !== '' && c.root.startsWith(`${m}/.agents/local/worktrees/`)) c.mainRoot = m;
    }
  }
  c.sharedLocal = `${c.mainRoot}/.agents/local`;
  c.sroot = c.root;
  c.agents.s.mainRoot = c.mainRoot;
  if (c.installed && c.mainRoot === c.root) await findRunWorktree(c);
  c.localDir = `${c.sroot}/.agents/local`;
  c.agents.s.agentPath = c.agentPath;
  // the time knobs (config values; the environment variables of A200 remain an override)
  const cfg = readText(`${c.root}/.agents/config.yaml`);
  c.lockWait = knob(env.PROOFLINE_HOOK_LOCK_WAIT, cfgNum(cfg, 'lock_wait_seconds', 8, 1, 20));
  c.approveBudget = knob(env.PROOFLINE_HOOK_APPROVE_BUDGET, cfgNum(cfg, 'approve_budget_seconds', 20, 5, 25));
  c.nextBudget = knob(env.PROOFLINE_HOOK_NEXT_BUDGET, cfgNum(cfg, 'next_budget_seconds', 10, 2, 20));
  c.agents.s.lockWait = c.lockWait;
  // the active run: the selector's single id; anything malformed counts as active (fail closed)
  c.act = readActiveRun(c.localDir);
  if (c.installed) markInflight(c);
  // the caller
  c.aid = c.get('agent_id'); c.atype = c.get('agent_type');
  const envrole = canon(env.AGENT_ROLE ?? '');
  const t = c.atype.includes(':') ? c.atype.slice(c.atype.lastIndexOf(':') + 1) : c.atype;
  if (t.startsWith('proofline-')) {
    const r = canon(t.slice('proofline-'.length).replace(/-/g, '_'));
    if (validRole(r) && r !== 'lead') c.prole = r;
  }
  c.sub = c.aid !== '' || c.atype !== '';
  if (c.sub) { if (c.prole !== '') c.role = c.prole; } else if (envrole !== '' && envrole !== 'lead' && validRole(envrole)) c.role = envrole;
  c.aidf = safe(c.aid === '' ? 'unknown' : c.aid);
  c.ro = READ_ROLES.includes(c.role);
  return c;
}

/** @param {string} p */
function realOr(p) { try { return realpathSync(p); } catch { return p; } }

/** The raw event, written by one call before anything else (only for a prompt, only once). @param {HookContext} c @param {string} dir */
function intakeWrite(c, dir) {
  if (c.ev !== 'prompt' || c.intake !== '' || !isDir(`${dir}/.agents/local`)) return;
  const d = `${dir}/.agents/local/prompts/intake`;
  if (!isDir(d) && !mkdirp(d)) return;
  const f = `${d}/${c.v}-${c.pid}.json`;
  try { put(f, c.raw); c.intake = f; } catch { /* the capture below is the record that counts */ }
}

/** The selector: the lines that hold more than white space, spaces and tabs removed, joined by newlines; malformed is INVALID. @param {string} localDir */
function readActiveRun(localDir) {
  const f = `${localDir}/ACTIVE_RUN`;
  if (!isFile(f)) return '';
  const lines = [];
  for (const l of readText(f).split('\n')) {
    if (!/[^ \t\r\n\v\f]/.test(l)) continue;
    lines.push(l.replace(/[ \t]/g, ''));
  }
  const act = lines.join('\n');
  return act === '' || /^[A-Za-z0-9_-]*$/.test(act) ? act : 'INVALID';
}

/** A185: per-run state lives in the worktree that owns the run; agent.sh worktree-root decides which worktree a path belongs to. @param {HookContext} c */
async function findRunWorktree(c) {
  let evp = '';
  if (c.parsed && (c.ev === 'pretool' || c.ev === 'posttool')) evp = inputPath(c.get('tool_input.file_path', 'tool_input.notebook_path', 'tool_input.path'));
  for (const cand of [evp, c.cwd]) {
    if (cand === '') continue;
    const phys = physicalPath(cand, c.cwd);
    if (phys === '') continue;
    if (phys.startsWith(`${c.root}/.agents/local/worktrees/`)) {
      const r = await c.agent(['worktree-root', phys], { keepRole: true });
      const w = cmdSubst(r.stdout);
      if (r.status === 0 && w !== '' && isFile(`${w}/.agents/config.yaml`) && isFile(`${w}/.agents/scripts/agent.sh`)) { c.sroot = w; c.agentPath = `${w}/.agents/scripts/agent.sh`; }
      break;
    }
    if (phys === c.root || phys.startsWith(`${c.root}/`)) break; // inside the project but outside every run worktree: the main tree decides
  }
}

/** `ev_phys`: the physical absolute path with existing parents resolved; '' when it cannot be resolved. @param {string} p @param {string} cwd */
export function physicalPath(p, cwd) {
  let q = p.startsWith('/') ? p : `${cwd}/${p}`;
  q = q.replace(/\/+$/, '') || '/';
  let d = path.posix.dirname(q);
  let tail = path.posix.basename(q);
  while (!isDir(d)) {
    const up = path.posix.dirname(d);
    if (up === d) return '';
    tail = `${path.posix.basename(d)}/${tail}`;
    d = up;
  }
  try { return `${realpathSync(d)}/${tail}`; } catch { return ''; }
}

/** The in-flight marker of this hook (a hook the runtime kills leaves it; the next prompt or session hook turns it into a timeout line). @param {HookContext} c */
function markInflight(c) {
  const dir = `${c.localDir}/hooks-inflight`;
  if (!isDir(dir) && !mkdirp(dir)) return;
  const f = `${dir}/${c.ev}.${c.pid}`;
  try { put(f, `${c.pid} ${c.t0}\n`); c.mark = f; } catch { c.mark = ''; }
}

/** What runs when the hook ends, whatever way: the finish line and the removal of the marker (the shell's EXIT trap). @param {HookContext} c */
export function finish(c) {
  for (const h of c.exitHooks) { try { h(); } catch { /* an exit hook never fails the hook */ } }
  if (c.mark !== '') {
    c.tick();
    c.line(c.ev, c.v - c.t0, 'ok');
    rmf(c.mark);
  }
}

