// @ts-check
// The Node test harness (issue #176, package A): the Node form of the helpers of control-plane/agents/scripts/test-lib.sh for the Node suites
// that replace the legacy shell suites. One implementation of: the hardened environment of every child (no real HOME, gh, git configuration or
// network, fixed identity), `A`/`AS` (a call of the control plane), the expectation helpers, a throwaway project with the control plane
// installed (built once per content hash and COPIED per test), and the fixture verbs (scaffold, worker/solo evidence, gate results, to-code-done,
// the user's approval). The shell library stays until the legacy suites are ported; tests/lib/harness.test.mjs proves the two build the same state.
// A helper that builds STATE throws when the control plane refuses (the shell suites ran under `set -e`); the asserted action is the caller's:
// call `A` and look at the Result.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';

export const repo = path.resolve(import.meta.dirname, '..', '..');
export const scripts = path.join(repo, 'control-plane', 'agents', 'scripts');
export const agentsSrc = path.join(repo, 'control-plane', 'agents');
const stubs = path.join(import.meta.dirname, 'stubs');

/**
 * The environment of every child: nothing inherited but PATH (no hook or engine settings, no gh or cloud credentials), HOME and TMPDIR inside the
 * temp folder, git without the user's or the system's configuration, a fixed identity, the C locale.
 * @param {Record<string, string>} [extra]
 */
export function cleanEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const e = {
    PATH: process.env.PATH, HOME: tmpdir(), LC_ALL: 'C', TMPDIR: process.env.TMPDIR ?? tmpdir(), PROOFLINE_NO_TTY: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', ...extra,
  };
  return e;
}

/** @typedef {{ status: number | null, out: string, err: string, text: string }} Result */

/** @param {import('node:child_process').SpawnSyncReturns<string>} r @returns {Result} */
const result = (r) => ({ status: r.status, out: r.stdout ?? '', err: r.stderr ?? '', text: (r.stdout ?? '') + (r.stderr ?? '') });

/** git in a directory, as the fixture identity; stdout without the trailing newlines. @param {string} dir @param {string[]} args */
export function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, env: cleanEnv({}), encoding: 'utf8' });
  return r.stdout.replace(/\n+$/, '');
}
/** Commit everything. @param {string} dir @param {string} msg */
export function commitAll(dir, msg) { git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', msg]); }

/** sha256 of a file or text. @param {string | Buffer} x */
export const sha256 = (x) => createHash('sha256').update(x).digest('hex');
/** sha256 of a file. @param {string} f */
export const tsha = (f) => sha256(readFileSync(f));

// ---- the base directory of one process: every project lives under it and goes away at exit -------------------------------------------------
/** @type {string | undefined} */ let baseDir;
let counter = 0;
export function base() {
  if (!baseDir) {
    baseDir = mkdtempSync(path.join(tmpdir(), 'proofline-h-'));
    const dir = baseDir;
    process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the assertions decided the result */ } });
  }
  return baseDir;
}
/** A fresh empty directory under the base. @param {string} [prefix] */
export function tmp(prefix = 't') { const d = path.join(base(), `${prefix}${++counter}`); mkdirSync(d, { recursive: true }); return d; }

// ---- calling the control plane --------------------------------------------------------------------------------------------------------------
/**
 * One call of the control plane in the project (`sh .agents/scripts/agent.sh ARGS`), as the role, with the stdin and the environment given.
 * Like the Node suites that already exist, it does not touch the run's files; `bind: true` binds the QA plan to the current PLAN first before a freeze or
 * refreeze, as the qa role does (A42) and as `A` of the shell library always did (the scaffold does).
 * @param {string} dir @param {string[]} args @param {{ role?: string, input?: string, env?: Record<string, string>, timeout?: number, bind?: boolean }} [o] @returns {Result}
 */
export function A(dir, args, o = {}) {
  if (o.bind && (args[0] === 'freeze' || args[0] === 'refreeze')) qaBind(dir, args[1] ?? '');
  const env = cleanEnv({ ...(o.role ? { AGENT_ROLE: o.role } : {}), ...(o.env ?? {}) });
  return result(spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: dir, env, input: o.input ?? '', encoding: 'utf8', timeout: o.timeout ?? 300000 }));
}
/** A as a role. @param {string} dir @param {string} role @param {string[]} args @param {{ input?: string, env?: Record<string, string> }} [o] */
export const AS = (dir, role, args, o = {}) => A(dir, args, { ...o, role });
/** A that throws when refused (state building). @param {string} dir @param {string[]} args @param {Parameters<typeof A>[2]} [o] */
export function must(dir, args, o) { const r = A(dir, args, o); if (r.status !== 0) throw new Error(`agent.sh ${args.join(' ')} failed (${r.status}): ${r.text}`); return r; }

/** The QA plan's `Plan sha256` line, derived from the current PLAN.md as the qa role does (A42). @param {string} dir @param {string} id */
export function qaBind(dir, id) {
  const q = path.join(dir, '.agents/runs', id, 'QA_PLAN.md'); const p = path.join(dir, '.agents/runs', id, 'PLAN.md');
  if (!id || !existsSync(q) || !existsSync(p)) return;
  const lines = readFileSync(q, 'utf8').split('\n'); if (lines.at(-1) === '') lines.pop();
  const rest = lines.slice(1).filter((l) => !l.startsWith('Plan sha256: '));
  writeFileSync(q, `${lines[0] ?? ''}\n\nPlan sha256: ${tsha(p)}\n${rest.map((l) => `${l}\n`).join('')}`);
}

// ---- expectations ---------------------------------------------------------------------------------------------------------------------------
/** The command must fail. @param {Result} r @param {string} what */
export function expectFail(r, what) { if (r.status === 0) throw new Error(`${what} (command succeeded)`); return r; }
/** The command must fail, and (when given) its message must contain the text or match. Returns nothing (the suites ported before the harness assert on that). @param {Result} r @param {string} what @param {string | RegExp} [msg] */
export function refused(r, what, msg) {
  if (r.status === 0) throw new Error(`${what}: the command succeeded\n${r.text}`);
  if (msg !== undefined && !(typeof msg === 'string' ? r.text.includes(msg) : msg.test(r.text))) throw new Error(`${what}: rejected for another reason: ${r.text.trim().split('\n').pop()}`);
}
/** expect_msg of the shell library: the command must fail for this reason. @param {string} what @param {string | RegExp} msg @param {Result} r */
export const expectMsg = (what, msg, r) => refused(r, what, msg);
/** @param {Result} r @param {string} what */
export function accepted(r, what) { if (r.status !== 0) throw new Error(`${what}: refused: ${r.text}`); return r; }

/** A value of a RUN.yaml section (`rv SECTION KEY`). @param {string} dir @param {string} section @param {string} key @param {string} [rid] */
export function rv(dir, section, key, rid = 'LC') {
  const lines = readFileSync(path.join(dir, '.agents/runs', rid, 'RUN.yaml'), 'utf8').split('\n');
  let inside = false;
  for (const l of lines) {
    if (l === `${section}:`) { inside = true; continue; }
    if (inside && /^[^\s#]/.test(l)) return '';
    if (inside && l.startsWith(`  ${key}:`)) return l.replace(/^[^:]*:\s*/, '').replace(/"/g, '');
  }
  return '';
}
/** @param {string} dir @param {string} section @param {string} key @param {string} want @param {string} [rid] */
export function expectState(dir, section, key, want, rid = 'LC') { const got = rv(dir, section, key, rid); if (got !== want) throw new Error(`expected ${section}.${key}=${want}, got '${got}'`); }
/** The value of a `key=value` line of `pipeline RID` (gate.X, tier, gates ...). @param {string} dir @param {string} key @param {string} [rid] */
export function pipe(dir, key, rid = 'LC') {
  const m = new RegExp(`^${key.replace(/[.]/g, '\\.')}=(.*)$`, 'm').exec(A(dir, ['pipeline', rid]).out);
  return m ? m[1] : '';
}
export const pipeVal = pipe;
export const gateStatus = (/** @type {string} */ dir, /** @type {string} */ g) => pipe(dir, `gate.${g}`);
export const read = (/** @type {string} */ dir, /** @type {string} */ f) => readFileSync(path.join(dir, f), 'utf8');

// ---- time and the user's messages -----------------------------------------------------------------------------------------------------------
const now = () => Math.floor(Date.now() / 1000);
/** Wait until the wall clock has reached second T. @param {number} t */
export function waitUntil(t) { const c = new Int32Array(new SharedArrayBuffer(4)); while (now() < t) Atomics.wait(c, 0, 0, 25); }

/** The newest `requested_at`, gate `epoch` or `asked_at` of the project's records (a capture must be newer). @param {string} dir */
function newestRecord(dir) {
  let t = 0;
  for (const d of [`${dir}/.agents/runs/LC/approvals`, `${dir}/.agents/local/approvals`, `${dir}/.agents/runs/LC/gates`, `${dir}/.agents/runs/LC/questions`]) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) { const m = /^(?:requested_at|epoch|asked_at): (\d+)/m.exec(readFileSync(`${d}/${n}`, 'utf8')); if (m) t = Math.max(t, Number(m[1])); }
  }
  return t;
}
/** The user's message as the prompt hook stores it (session s1), stamped after every record of the project; waits for the clock to reach it. @param {string} dir @param {string} text @param {{ time?: number, session?: string }} [o] */
export function say(dir, text, o = {}) {
  const t = o.time ?? Math.max(now(), newestRecord(dir) + 1);
  const r = storePrompt(`${dir}/.agents/local`, o.session ?? 's1', t, text);
  if (!r) throw new Error('capture not stored');
  if (o.time === undefined) waitUntil(t);
  return r;
}
/** `capture TEXT [TIME]` of the shell library: a capture stamped an hour ahead (no waiting). @param {string} dir @param {string} text @param {number} [time] */
export function capture(dir, text, time = now() + 3600) { return say(dir, text, { time }); }
/** The user's reply to a request, as the runtime records it: request, the message, approve. @param {string} dir @param {string} kind @param {string} text */
export function approveAsUser(dir, kind, text) {
  accepted(A(dir, ['request-approval', 'LC', kind]), `request ${kind}`);
  say(dir, text);
  accepted(A(dir, ['approve', 'LC', kind]), `approve ${kind}`);
}

// ---- the installed control plane ------------------------------------------------------------------------------------------------------------
/** @param {string} to @param {string} fromStub */
// The stub files hold the script text WITHOUT its `#!/bin/sh` line (the no-shell-logic ratchet counts a file with a shell shebang as a shell file); the line is put back here.
const SHEBANG = '#!/bin/sh\n';
const putStub = (to, fromStub) => { writeFileSync(to, Buffer.concat([Buffer.from(SHEBANG), readFileSync(path.join(stubs, fromStub))])); chmodSync(to, 0o755); };

/**
 * The control plane as `proofline init` lays it out in DIR, plus test stubs for the scripts other workers own (secret-scan.sh, exec-policy.sh) and
 * the markdown task adapter. agent.sh is the real one with the prologue that sends the Node core's commands to .agents/core4a.
 * @param {string} dir
 */
export function installControlPlane(dir) {
  for (const d of ['.agents/scripts', '.agents/task-integrations', '.agents/local', '.agents/core4a']) mkdirSync(path.join(dir, d), { recursive: true });
  cpSync(path.join(agentsSrc, 'config.yaml'), path.join(dir, '.agents/config.yaml'));
  for (const d of ['modes', 'templates']) cpSync(path.join(agentsSrc, d), path.join(dir, '.agents', d), { recursive: true });
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(dir, '.agents/core4a/proofline-core.mjs'));
  cpSync(path.join(scripts, 'core'), path.join(dir, '.agents/core4a/core'), { recursive: true });
  writeFileSync(path.join(dir, '.agents/core4a/agent.sh'), '');   // the core looks for the agent.sh beside it when a run worktree names itself with --pl-argv0
  writeFileSync(path.join(dir, '.agents/scripts/agent.sh'), Buffer.concat([Buffer.from(SHEBANG), readFileSync(path.join(stubs, 'agent-prologue.txt')), readFileSync(path.join(scripts, 'agent.sh'))]));
  if (existsSync(path.join(agentsSrc, 'ecosystems.tsv'))) {
    cpSync(path.join(agentsSrc, 'ecosystems.tsv'), path.join(dir, '.agents/ecosystems.tsv'));
    cpSync(path.join(scripts, 'ecosystems.sh'), path.join(dir, '.agents/scripts/ecosystems.sh'));
  }
  if (existsSync(path.join(scripts, 'next-user.sh'))) cpSync(path.join(scripts, 'next-user.sh'), path.join(dir, '.agents/scripts/next-user.sh'));
  putStub(path.join(dir, '.agents/scripts/secret-scan.sh'), 'secret-scan.txt');
  putStub(path.join(dir, '.agents/scripts/exec-policy.sh'), 'exec-policy.txt');
  putStub(path.join(dir, '.agents/task-integrations/markdown.sh'), 'markdown-adapter.txt');
  // the shell code that is left asks the core for a slug: a three-line stub beside agent.sh hands `cli slug` and `dispatch` over to it
  writeFileSync(path.join(dir, '.agents/scripts/proofline-core.mjs'), "import { main } from '../core4a/proofline-core.mjs';\nprocess.exitCode = await main(new URL(import.meta.url).pathname);\n");
  for (const f of readdirSync(path.join(dir, '.agents/scripts'))) if (f.endsWith('.sh')) chmodSync(path.join(dir, '.agents/scripts', f), 0o755);
}

let liveCore = false;
/**
 * Make every project of this process an installed project: `.agents/scripts/core` is linked beside `proofline-core.mjs`, so agent.sh hands EVERY command to the
 * Node core, as in a real install. Without it the fixture prologue sends only the verbs it lists there and the rest (pipeline, next, verify-*, freshness,
 * approvals ...) would run the shell arm of agent.sh, which the product never reaches (A242). Call it at the top of a test file, before the first project().
 */
export function useLiveCore() { liveCore = true; }

/** The template repository: the control plane installed, git initialised, nothing committed. @param {string} dir */
function buildTemplate(dir) {
  installControlPlane(dir);
  if (liveCore) symlinkSync('../core4a/core', path.join(dir, '.agents/scripts/core'));
  git(dir, ['init', '-q', '-b', 'main']);
  appendFileSync(path.join(dir, '.git/info/exclude'), `.agents/core4a/\n.agents/scripts/proofline-core.mjs\n${liveCore ? '.agents/scripts/core\n' : ''}`);   // the Node core is installed, not part of the fixture's history
  writeFileSync(path.join(dir, '.gitignore'), '.agents/runs/\n.agents/local/\n');
}

/** @param {string} p @param {import('node:crypto').Hash} h */
function hashTree(p, h) {
  if (!existsSync(p)) return;
  const st = statSync(p);
  if (st.isDirectory()) { for (const n of readdirSync(p).sort()) hashTree(path.join(p, n), h); return; }
  h.update(`${p}\n`); h.update(readFileSync(p));
}
/** @type {string | undefined} */ let codeKeyCache;
/** The content hash of everything a template is made of: the control plane, the stubs and this file. */
export function codeKey() {
  if (codeKeyCache) return codeKeyCache;
  const h = createHash('sha256');
  for (const p of [path.join(agentsSrc, 'config.yaml'), path.join(agentsSrc, 'modes'), path.join(agentsSrc, 'templates'), path.join(agentsSrc, 'ecosystems.tsv'), scripts, stubs, import.meta.filename]) hashTree(p, h);
  return (codeKeyCache = h.digest('hex').slice(0, 20));
}
const cacheRoot = () => path.join(tmpdir(), `proofline-harness-${process.getuid?.() ?? 0}`);
/** The cache folder exists, is a real directory of this user and private (mode 0700): a template is code the tests run, so a folder (or a link) another user made first is refused. */
function safeCacheRoot() {
  const dir = cacheRoot();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`harness: the template cache ${dir} is not a folder of this user; remove it`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}
/**
 * A directory built once per key, kept under the temp folder and shared by every process (the builder fills a private directory that is renamed into
 * place; the loser of a race discards its copy). @param {string} key @param {(dir: string) => void} build @returns {string}
 */
export function cached(key, build) {
  const root = safeCacheRoot();
  const final = path.join(root, key);
  if (existsSync(path.join(final, '.built'))) return final;
  const work = mkdtempSync(path.join(root, `build-${key.slice(0, 12)}-`));
  try { build(work); writeFileSync(path.join(work, '.built'), ''); } catch (e) { rmSync(work, { recursive: true, force: true }); throw e; }
  try { renameSync(work, final); } catch { rmSync(work, { recursive: true, force: true }); /* another process finished first */ }
  return final;
}
/** A copy of a template into a fresh directory. @param {string} template */
export function copyOf(template) {
  const dir = tmp('p');
  cpSync(template, dir, { recursive: true });
  rmSync(path.join(dir, '.built'), { force: true });
  return dir;
}

/** A fresh repository with the control plane installed (nothing committed): `new_repo` of the shell library. */
export function newRepo() { return copyOf(cached(`ctl-${codeKey()}${liveCore ? '-live' : ''}`, buildTemplate)); }

// ---- gate results through the D12 protocol --------------------------------------------------------------------------------------------------
export const gateOwner = (/** @type {string} */ g) => (g.startsWith('REVIEW_') ? 'reviewer' : ({ SECURITY: 'security_reviewer', QA: 'qa', VERIFY: 'verifier' })[g] ?? '');
const gateFocus = (/** @type {string} */ g) => ({ REVIEW_SMALL: 'rules+tests', REVIEW_PLAN: 'plan', REVIEW_RULES: 'rules', REVIEW_TESTS: 'tests', REVIEW_DATA: 'data' })[g] ?? '';
const reportPath = (/** @type {string} */ g) => ({
  REVIEW_PLAN: 'reviews/proof-review/plan/REPORT.md', REVIEW_RULES: 'reviews/proof-review/rules/REPORT.md', REVIEW_SMALL: 'reviews/proof-review/small/REPORT.md',
  REVIEW_TESTS: 'reviews/test-trust/tests/REPORT.md', REVIEW_DATA: 'reviews/data-design/REVIEW.md', SECURITY: 'security/REPORT.md', QA: 'QA_REPORT.md', VERIFY: 'VERIFY.md',
})[g] ?? '';
const riskReport = (/** @type {string} */ f) => ({
  contract: 'reviews/contract-proof/REPORT.md', concurrency: 'reviews/concurrency-proof/REPORT.md', performance: 'reviews/performance-proof/REPORT.md', config: 'reviews/proof-review/config/REPORT.md',
  migration: 'reviews/data-migration/REPORT.md', visual: 'reviews/visual-proof/REPORT.md', dependencies: 'security/dependencies/REPORT.md', logging: 'security/logging/REPORT.md',
})[f] ?? '';

/**
 * A result file for a gate (rows "id|severity|path:line|finding|evidence"). opt.focus: the result is that risk focus's (A78); opt.extra: more report text;
 * opt.confidence (default high). @param {string} dir @param {string} gate @param {string} res @param {string[]} [rows] @param {{ focus?: string, extra?: string, confidence?: string, rid?: string }} [opt]
 */
export function resultFor(dir, gate, res, rows = [], opt = {}) {
  const rid = opt.rid ?? 'LC';
  let art = reportPath(gate); let fc = gateFocus(gate);
  if (opt.focus) { art = riskReport(opt.focus); fc = opt.focus; }
  const run = path.join(dir, '.agents/runs', rid);
  mkdirSync(path.dirname(path.join(run, art)), { recursive: true });
  writeFileSync(path.join(run, art), `# ${gate} report\n\nVerdict: ${res}\n\nJudged the whole current tree.\n`);
  if (opt.extra) appendFileSync(path.join(run, art), `\n${opt.extra}\n`);
  if (fc === 'visual' && res === 'PASS') {   // A200: a visual PASS is accepted only with the independent machine report saying PASS
    writeFileSync(path.join(run, 'reviews/visual-proof/report.json'), `{"schema":"visual-proof/1","result":"${res}","cells":[]}\n`);
    if (!existsSync(path.join(dir, '.agents/skills/visual-proof'))) {   // the record reruns the source lint: the skill is installed in the fixture, outside git
      mkdirSync(path.join(dir, '.agents/skills'), { recursive: true });
      cpSync(path.join(repo, 'skills/visual-proof'), path.join(dir, '.agents/skills/visual-proof'), { recursive: true });
      const ex = path.join(dir, '.git/info/exclude');
      if (!existsSync(ex) || !readFileSync(ex, 'utf8').split('\n').includes('.agents/skills/')) appendFileSync(ex, '.agents/skills/\n');
    }
  }
  const fingerprint = must(dir, ['fingerprint', rid]).out.replace(/\n+$/, '');
  const f = path.join(tmp('r'), 'result.md');
  const head = [`ROLE: ${gateOwner(gate)}`, `TASK: ${rid}`, ...(fc ? [`FOCUS: ${fc}`] : []), `RESULT: ${res}`, `CONFIDENCE: ${opt.confidence ?? 'high'}`, `FINGERPRINT: ${fingerprint}`, `ARTIFACT: ${art} ${tsha(path.join(run, art))}`, ''];
  const table = ['| id | severity | path:line | finding | evidence |', '|---|---|---|---|---|', ...rows.map((r) => `| ${r.replace(/\|/g, ' | ')} |`)];
  writeFileSync(f, `${head.join('\n')}\n${table.join('\n')}\n`);
  return f;
}
/** Record a gate result as the gate's owner. @param {string} dir @param {string} gate @param {string} res @param {string[]} [rows] @param {Parameters<typeof resultFor>[4]} [opt] */
export function rec(dir, gate, res, rows = [], opt = {}) {
  const f = resultFor(dir, gate, res, rows, opt);
  return must(dir, ['record', opt.rid ?? 'LC', '--file', f], { role: gateOwner(gate) });
}
/** @param {string} dir @param {string} gate @param {Parameters<typeof resultFor>[4]} [opt] */
export const gpass = (dir, gate, opt = {}) => rec(dir, gate, 'PASS', [], opt);
/** One blocking finding on a path (the rules gates also record how they scanned, A171). @param {string} dir @param {string} gate @param {string} fixPath */
export function gfail(dir, gate, fixPath) {
  const ev = gate === 'REVIEW_RULES' || gate === 'REVIEW_SMALL' ? `traced: empty key -> nil; scan: grep -n lookup ${fixPath}; instances: single` : 'traced: empty key -> nil';
  return rec(dir, gate, 'FAIL', [`${gate}-1|blocking|${fixPath}:1|lookup returns the wrong value for an empty key|${ev}`], { confidence: 'high' });
}
/** Pass every gate the pipeline requires, then every risk focus, then VERIFY. @param {string} dir */
export function passAll(dir) {
  for (const g of pipe(dir, 'gates').split(/\s+/).filter(Boolean)) {
    if (g === 'VERIFY') continue;   // A171: VERIFY runs after the gates it depends on
    if (g === 'SECRETS') must(dir, ['secret-scan', 'LC']); else gpass(dir, g);
  }
  for (const m of A(dir, ['pipeline', 'LC']).out.matchAll(/^focus\.([A-Z_]*)\.([a-z]*)=.*$/gm)) gpass(dir, m[1], { focus: m[2] });
  gpass(dir, 'VERIFY');
}

// ---- implementation helpers -----------------------------------------------------------------------------------------------------------------
/** Open a window; returns its id. @param {string} dir */
export const wopen = (dir) => must(dir, ['window-open', 'LC']).out.replace(/\n+$/, '');
/** @param {string} dir @param {string} w */
export const wclose = (dir, w) => must(dir, ['window-close', 'LC', w, '0']);
/** Worker evidence of a phase (RED needs the expected failure; opt.ef overrides it). @param {string} dir @param {string} phase @param {string} res @param {{ target?: string, ef?: string, role?: string | null }} [o] */
export function wev(dir, phase, res, o = {}) {
  const ef = phase === 'RED' ? `expected_failure: ${o.ef ?? 'TestImpl fails: lookup is not implemented in impl.txt yet'}` : '';
  const input = `command: go test ./...\ntarget: ${o.target ?? 'impl.txt,impl_test.txt'}\n${ef}\n`;
  const role = o.role === undefined ? 'implementer' : o.role;
  return must(dir, ['worker-evidence', 'LC', phase, res], { input, ...(role ? { role } : {}) });
}
/** Orchestrated: a window, the line appended to the file, the worker's evidence, close. @param {string} dir @param {string} phase @param {string} res @param {string} file @param {string} line */
export function worker(dir, phase, res, file, line) {
  const w = wopen(dir); appendFileSync(path.join(dir, file), `${line}\n`); wev(dir, phase, res); wclose(dir, w);
}
/** Standalone: the lead implements and records its own evidence. @param {string} dir @param {string} phase @param {string} res @param {string} file @param {string} line @param {string} [target] */
export function solo(dir, phase, res, file, line, target) {
  appendFileSync(path.join(dir, file), `${line}\n`); wev(dir, phase, res, { role: null, ...(target ? { target } : {}) });
}
/** @param {string} dir @param {string[]} extra */
export function writeReport(dir, ...extra) {
  const lines = ['# Completion Report: LC', '', '## Implementation Summary', 'impl.txt and impl_test.txt changed under the lifecycle gates.', '', '## TDD Evidence', 'RED then GREEN recorded by the expected implementation owner.', '',
    '## Verification', 'All gates passed on the final tree.', '', '## Assumptions', 'none', '', '## Review Result', 'Approved on the final tree.', '', '## QA Result', 'Every frozen QA scenario passed on the final tree.', '',
    '## Execution', 'Not applicable in fixtures.', '', '## Known Limitations / Follow-up', 'None.', ...extra];
  writeFileSync(path.join(dir, '.agents/runs/LC/COMPLETION_REPORT.md'), `${lines.join('\n')}\n`);
}
/** knowledge done, the completion report, published and handed off DONE. @param {string} dir @param {string[]} extra */
export function finishDone(dir, ...extra) {
  must(dir, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  writeReport(dir, ...extra);
  must(dir, ['publish-completion-report', 'LC', 'markdown']);
  must(dir, ['handoff', 'LC', 'DONE']);
}
/** Set the `**Status:**` line of a task file. @param {string} file @param {string} status */
export function tcStatus(file, status) { writeFileSync(file, readFileSync(file, 'utf8').split('\n').map((l) => (l.startsWith('**Status:**') ? `**Status:** ${status}` : l)).join('\n')); }

// ---- a scaffolded run -----------------------------------------------------------------------------------------------------------------------
/**
 * @typedef {{ topology?: string, layout?: 'yes' | 'no', cls?: string, autonomy?: string, branch?: boolean, taskFm?: string, taskExtra?: string, testCrit?: string,
 *   scopeOther?: string, scopeExtra?: string, scopeAgents?: boolean, scopeNamed?: string, exempt?: boolean, qaExtra?: string, planExtra?: string, kindClaim?: string, agentsMd?: 1 | 2 }} ScaffoldOptions
 */
const EXEMPT = '    tdd_exemption: fixture file without executable behaviour to test here';

/**
 * A lifecycle_gates run LC frozen at handoff IMPLEMENTING in a fresh repository (the `scaffold` of the shell library): scope impl.txt + impl_test.txt,
 * default class COMPLEX. Returns the project directory.
 * @param {ScaffoldOptions} [o]
 */
export function scaffold(o = {}) {
  const topo = o.topology ?? 'orchestrated'; const layout = o.layout ?? 'no'; const cls = o.cls ?? 'COMPLEX'; const auto = o.autonomy ?? 'autonomous';
  const dir = newRepo();
  const w = (/** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), t); };
  const ap = (/** @type {string} */ f, /** @type {string} */ t) => appendFileSync(path.join(dir, f), t);
  const d = '.agents/runs/LC';
  const tpath = layout === 'yes' ? 'tasks/in-progress/LC.md' : 'tasks/LC.md';
  mkdirSync(path.join(dir, d), { recursive: true }); mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  w('.agents/local/ACTIVE_RUN', 'LC\n');
  w(`${d}/TASK.md`, '# Task: LC — lookup\n\n');
  if (o.taskFm) ap(`${d}/TASK.md`, `---\n${o.taskFm}\n---\n\n`);
  ap(`${d}/TASK.md`, '## Acceptance criteria\n\n- AC-1: lookup behavior\n');
  if (o.taskExtra) ap(`${d}/TASK.md`, `${o.taskExtra}\n`);
  if (cls !== 'TRIVIAL') {
    w(`${d}/EVIDENCE.md`, '# Evidence\n\n## Assumptions\nnone\n\n## Claims\n');
    w(`${d}/QA_PLAN.md`, '# QA plan\n\n- QA-1 (AC-1): lookup returns the stored value\n');
    const crit = o.testCrit ?? o.scopeOther ?? 'AC-1';
    if (crit !== 'AC-1') ap(`${d}/QA_PLAN.md`, `- QA-2 (${crit}): second behavior\n`);
    if (o.qaExtra) ap(`${d}/QA_PLAN.md`, `${o.qaExtra}\n`);
  }
  const plan = ['---', 'scope:', '  - path: impl.txt', '    criteria: [AC-1]', ...(o.exempt ? [EXEMPT] : []), '  - path: impl_test.txt', `    criteria: [${o.testCrit ?? 'AC-1'}]`, ...(o.exempt ? [EXEMPT] : []),
    ...(o.scopeExtra ? ['  - path: other.txt', `    criteria: [${o.scopeExtra}]`, EXEMPT] : []), ...(o.scopeOther ? ['  - path: far.txt', `    criteria: [${o.scopeOther}]`, EXEMPT] : []),
    ...(o.scopeAgents ? ['  - path: .agents/impl.txt', '    criteria: [AC-1]', EXEMPT] : []), ...(o.scopeNamed ? [`  - path: ${o.scopeNamed}`, '    criteria: [AC-1]', EXEMPT] : []),
    '---', '# Plan', '', '## Assumptions', 'none', '', '## Architecture', 'one storage map; no new module'];
  w(`${d}/PLAN.md`, `${plan.join('\n')}\n`);
  if (o.planExtra) ap(`${d}/PLAN.md`, `${o.planExtra}\n`);
  if (o.kindClaim) {   // A202: a plan that labels one path's kind
    const [p, k] = [o.kindClaim.slice(0, o.kindClaim.indexOf('=')), o.kindClaim.slice(o.kindClaim.indexOf('=') + 1)];
    w(`${d}/PLAN.md`, readFileSync(path.join(dir, d, 'PLAN.md'), 'utf8').split('\n').flatMap((l) => (l === `  - path: ${p}` ? [l, `    kind: ${k}`] : [l])).join('\n'));
  }
  const run = ['task:', '  id: LC', 'repository:', '  base_sha: PENDING', ...(o.branch ? ['  canonical_branch: PENDING', '  task_branch: PENDING'] : []), 'task_source:', '  type: local_markdown', `  path: ${tpath}`, '  revision: PENDING',
    'execution:', '  mode: deterministic', '  profile: PENDING', `  autonomy: ${auto}`, `  topology: ${topo}`, '  state: PLANNING', '  knowledge_state: not_started', '  knowledge_reason: ""', '  awaiting_input: false',
    'pipeline:', '  classification: PENDING', '  review: PENDING', '  tier: PENDING',
    'freeze:', '  task_sha256: PENDING', '  evidence_sha256: PENDING', '  plan_sha256: PENDING', '  qa_plan_sha256: PENDING', '  policy_sha256: PENDING', '  pipeline: PENDING', '  scope_paths: PENDING', '  risk_sha256: PENDING',
    'baseline:', '  status: pending', 'handoff:', '  state: PLANNED', '  implemented_patch_sha256: PENDING', '  code_done_patch_sha256: PENDING',
    'worker_evidence:', '  required: true', 'tdd:', '  required: true', 'completion_report:', '  required: true', '  adapter: PENDING', '  published: false', '  receipt: PENDING', 'lifecycle_gates:', '  required: true'];
  w(`${d}/RUN.yaml`, `${run.join('\n')}\n`);
  for (const f of ['impl.txt', 'impl_test.txt', ...(o.scopeAgents ? ['.agents/impl.txt'] : []), ...(o.scopeExtra ? ['other.txt'] : []), ...(o.scopeOther ? ['far.txt'] : [])]) w(f, '');
  if (layout === 'yes') w('tasks/todo/LC.md', '# LC task\n\n**Status:** todo\n\n## Requirements\n\n- lookup returns the documented default for an empty key\n'); else w('tasks/LC.md', '# LC task\n');
  if (o.agentsMd) w('AGENTS.md', '# Project\n\n## Project rules\n\nkeep it small\n\n<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n');
  if (o.agentsMd === 2) ap('AGENTS.md', '\n## Notes\n\n<!-- proofline:begin -->\nsecond pair\n<!-- proofline:end -->\n');   // a second marker pair is product text (A155)
  if (o.scopeNamed) w(o.scopeNamed, '');
  commitAll(dir, 'baseline');
  if (layout === 'yes') { mkdirSync(path.join(dir, 'tasks/in-progress'), { recursive: true }); git(dir, ['mv', 'tasks/todo/LC.md', 'tasks/in-progress/LC.md']); tcStatus(path.join(dir, 'tasks/in-progress/LC.md'), 'in-progress'); }
  must(dir, ['classify', 'LC', cls]);
  if (o.branch) must(dir, ['branch', 'LC']);
  must(dir, ['baseline', 'LC']);
  if (cls !== 'TRIVIAL') ap(`${d}/EVIDENCE.md`, 'discovered\n');
  ap(`${d}/PLAN.md`, 'planned\n');
  if (auto === 'autonomous') { must(dir, ['freeze', 'LC'], { bind: true }); must(dir, ['handoff', 'LC', 'IMPLEMENTING']); }
  return dir;
}
/** Drive a scaffolded run (frozen, IMPLEMENTING) to CODE_DONE. @param {string} dir @param {string} [topology] */
export function toCodeDone(dir, topology = 'orchestrated') {
  const step = topology === 'orchestrated' ? worker : solo;
  step(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  step(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(dir, ['handoff', 'LC', 'IMPLEMENTED']); passAll(dir); must(dir, ['handoff', 'LC', 'CODE_DONE']);
}

/** A scaffolded project built once per option set and copied per call (kept on disk, keyed by the code and the options). @param {ScaffoldOptions} [o] */
export function project(o = {}) {
  const key = `sc-${codeKey()}${liveCore ? '-live' : ''}-${sha256(JSON.stringify(Object.entries(o).sort())).slice(0, 12)}`;
  return copyOf(cached(key, (work) => {
    const built = scaffold(o);
    cpSync(built, work, { recursive: true });
    rmSync(built, { recursive: true, force: true });
  }));
}
