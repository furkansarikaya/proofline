// @ts-check
// Real-session smoke test (A195, Node form A240): a real Claude Code session with a cheap model drives proofline in a throwaway fixture repository:
//   /proofline run (a TRIVIAL task, the implementer writes a file), /proofline deliver (local bare origin) and /proofline batch (two tasks).
// It prints a step-by-step PASS/FAIL table and exits non-zero on any FAIL. It calls a model, so it is never part of CI; the rule in
// CONTRIBUTING.md is: a pull request that changes hooks, skills, roles or the control plane runs this script and pastes its table.
//
//   node tests/real-session/smoke.mjs
//   SMOKE_MODEL=haiku         the model of the lead (default haiku; the economy profile makes the workers cheap too)
//   SMOKE_STEP_TIMEOUT=900    seconds one claude call may take (default 900)
//   SMOKE_MAX_REPLIES=6       replies per step after the first prompt (default 6)
//   SMOKE_RTK=auto|no         auto (default): when rtk is installed, run a second pass with the user's settings (so the rtk hook) loaded
//   SMOKE_ONLY=codex          only the Codex step (A199): setup, the sandbox probe and a two-task batch with a Codex implementer in worktrees
//   SMOKE_ONLY=a200           only the A200 scenarios (not in the default run): a question of the batch pre-flight answered with the approval, empty commands.* proposed and
//                             filled, a test-only fix round without SECURITY, the lead continuing after CODE_DONE; every assertion reads agent.sh state and the gate records
//   SMOKE_ONLY=a202           only the batch step with the A202 checks (no model call beyond the batch itself): the task status block is one section updated in place and
//                             ends MERGED without a local path, and the branch of each batch task is proofline/<ID>-<slug> with a slug taken from the title (the same two rows also run in the default pass)
//   SMOKE_ONLY=a196           only the session-bound user answer (A210, A211, #187, #196; not in the default run): the lead asks an INTENT scope question (USER_ONLY) through agent.sh ask, the script
//                             plays the user and answers in the SAME session (the prompt hook must record answered_by: user), then a question asked under another session id is
//                             answered from this session (nothing may be recorded as the user's); every assertion reads the answer files, never the model's text
//   SMOKE_KEEP=1              keep the fixture and transcripts (their path is printed)
// Exit status: 0 all steps PASS (SKIP rows do not count), 1 any FAIL, 127 claude not installed. The row names and criteria are those of the former
// shell script (tests/real-session/smoke.sh, deleted in A240); tests/real-session/smoke.test.mjs checks the table format and the pure helpers.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '../..');

// ---- pure helpers (tested in smoke.test.mjs) ---------------------------------------------------------------------------------------------------

/** One table line. @param {string[]} r */
export const tableLine = (r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`;

/** The session id of a stream-json transcript: the first line that holds one (the last occurrence on that line, as sed's greedy match did). @param {string} text */
export function sessionIdOf(text) {
  for (const l of text.split('\n')) { const m = /.*"session_id":"([^"]*)"/.exec(l); if (m) return m[1]; }
  return '';
}

/** Expand a path pattern whose segments may hold `*` (sorted per directory, like a shell glob; a pattern with no match gives nothing). @param {string} pattern @returns {string[]} */
export function expand(pattern) {
  const segs = pattern.split('/');
  /** @type {string[]} */ let cur = [segs[0] === '' ? '/' : segs[0] ?? ''];
  for (const s of segs.slice(1)) {
    if (s === '') continue;
    /** @type {string[]} */ const next = [];
    for (const base of cur) {
      if (!s.includes('*')) { const p = path.join(base, s); if (existsSync(p)) next.push(p); continue; }
      let names;
      try { names = readdirSync(base).sort(); } catch { continue; }
      const re = new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const n of names) if (re.test(n) && !(n.startsWith('.') && !s.startsWith('.'))) next.push(path.join(base, n));
    }
    cur = next;
  }
  return cur;
}

/** The status block of a task file between its BEGIN and END markers. @param {string} text @param {string} id */
export function statusBlock(text, id) {
  let on = false; /** @type {string[]} */ const out = [];
  for (const l of text.split('\n')) {
    if (l === `<!-- PROOFLINE-STATUS:BEGIN:${id} -->`) { on = true; continue; }
    if (l === `<!-- PROOFLINE-STATUS:END:${id} -->`) on = false;
    if (on) out.push(l);
  }
  return out.join('\n');
}

/** Lines of a text matching a regex (grep -c). @param {string} text @param {RegExp} re */
const countLines = (text, re) => text.split('\n').filter((l) => re.test(l)).length;

const env = process.env;
const model = env.SMOKE_MODEL || 'haiku';
let stepTimeout = Number(env.SMOKE_STEP_TIMEOUT || 900);
// one call of the A200 scenarios may carry a whole task (explorer, QA, implementer, five gates, delivery) because the lead is told not to stop at CODE_DONE
if (env.SMOKE_ONLY === 'a200') stepTimeout = Number(env.SMOKE_STEP_TIMEOUT || 2400);
const maxReplies = Number(env.SMOKE_MAX_REPLIES || 6);
const only = env.SMOKE_ONLY ?? '';

/** @param {string} cmd */
const have = (cmd) => (env.PATH ?? '').split(path.delimiter).some((d) => { try { return d !== '' && statSync(path.join(d, cmd)).isFile(); } catch { return false; } });

// ---- state --------------------------------------------------------------------------------------------------------------------------------------
/** @type {string} */ let work = '';
/** @type {string} */ let P = '';
/** @type {string} */ let ORIGIN = '';
/** @type {Set<import('node:child_process').ChildProcess>} */ const pids = new Set();
/** @type {string[][]} */ const rows = [];
let fails = 0;
let smokeUserSettings = 'no';

/** @param {string} name @param {string} result @param {number|string} seconds @param {string} note */
function row(name, result, seconds, note) {
  rows.push([name, result, String(seconds), String(note).replace(/[\t\n]/g, ' ')]);
  if (result !== 'PASS' && result !== 'SKIP') fails++;
}
/** @param {number} t0 */
const secs = (t0) => Math.floor(Date.now() / 1000) - t0;
const now = () => Math.floor(Date.now() / 1000);
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} f */
const readOr = (f, d = '') => { try { return readFileSync(f, 'utf8'); } catch { return d; } };
/** @param {string} s */
const firstLine = (s) => s.split('\n')[0] ?? '';

/** A command in a directory; stdout/stderr text. @param {string} cmd @param {string[]} args @param {{ cwd?: string, input?: string, env?: Record<string, string | undefined> }} [o] */
function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: 'utf8', input: o.input ?? '', env: o.env ? { ...env, ...o.env } : env, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '', text: (r.stdout ?? '') + (r.stderr ?? '') };
}
/** git in a directory (or on a git dir). @param {string[]} args @param {string} [cwd] */
const git = (args, cwd) => run('git', args, { cwd });
/** @param {string} gitDir @param {string[]} args */
const gitd = (gitDir, args) => run('git', [`--git-dir=${gitDir}`, ...args]);

/** agent.sh of the fixture project; stdout (stderr too with both). @param {string[]} args @param {{ both?: boolean, input?: string, env?: Record<string, string> }} [o] */
function A(args, o = {}) {
  const r = run('sh', ['.agents/scripts/agent.sh', ...args], { cwd: P, input: o.input, env: o.env });
  return o.both ? r.text : r.out;
}
const activeId = () => (A(['status']).split('\n').map((l) => /^active_task=(.*)$/.exec(l)).find(Boolean)?.[1] ?? '');
const originRefs = () => gitd(ORIGIN, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).out.split('\n').filter(Boolean);
/** @param {string} file */
const originHas = (file) => gitd(ORIGIN, ['show', `main:${file}`]).status === 0;

// ---- one headless Claude Code call --------------------------------------------------------------------------------------------------------------
/**
 * One headless Claude Code call, stopped after stepTimeout; resolves with the session id.
 * @param {string} proj @param {string} out @param {string} prompt @param {string} [sess]
 */
async function claudeCall(proj, out, prompt, sess = '') {
  const src = smokeUserSettings === 'no' ? 'project,local' : 'user,project,local';
  const args = ['-p', prompt, ...(sess ? ['--resume', sess] : []), '--setting-sources', src, '--permission-mode', 'bypassPermissions', '--model', model, '--output-format', 'stream-json', '--verbose', '--max-turns', '150'];
  const fd = openSync(out, 'a');
  const child = spawn('claude', args, { cwd: proj, env: { ...env, PATH: `${path.join(work, 'bin')}${path.delimiter}${env.PATH ?? ''}`, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' }, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  pids.add(child);
  const exited = new Promise((resolve) => { child.on('close', resolve); child.on('error', resolve); });
  const timer = setTimeout(() => { appendFileSync(`${out}.note`, `timeout after ${stepTimeout}s\n`); child.kill('SIGTERM'); }, stepTimeout * 1000);
  await exited;
  clearTimeout(timer); pids.delete(child);
  return sess || sessionIdOf(readOr(out));
}

// the user's merge of a delivered branch on the local origin (platform other: proofline pushes, the user merges)
function userMerges() {
  for (const b of originRefs().filter((x) => x.startsWith('proofline/'))) {
    if (gitd(ORIGIN, ['merge-base', '--is-ancestor', b, 'main']).status === 0) continue;
    const t = mkdtempSync(path.join(work, 'merge.'));
    const c = path.join(t, 'c');
    const steps = [['clone', '-q', ORIGIN, c], ['config', 'user.email', 'smoke@example.invalid'], ['config', 'user.name', 'Smoke'], ['merge', '-q', '--no-edit', `origin/${b}`], ['push', '-q', 'origin', 'HEAD:main']];
    for (const [i, s] of steps.entries()) if (git(s, i === 0 ? undefined : c).status !== 0) break;
  }
  git(['fetch', '-q', 'origin'], P);
}

// codex_config_commit: with Codex installed, the implementer runs on Codex from now on (the batch then runs Codex implementers in run worktrees, A196).
// The config goes onto the ORIGIN's main from a clone of its own, whatever the project is in: the lead may leave the task branch checked out with a dirty
// working tree (the status blocks of the task files), where a checkout of main is refused (A226). The project then learns main without a checkout.
// Idempotent; false when the origin's main does not hold the config afterwards.
const originHasCodexConfig = () => /^ {4}implementer: codex/m.test(gitd(ORIGIN, ['show', 'main:.agents/config.yaml']).out);
function codexConfigCommit() {
  if (!have('codex')) return true;
  if (!originHasCodexConfig()) {
    const t = mkdtempSync(path.join(work, 'cfg.')); const c = path.join(t, 'c');
    if (git(['clone', '-q', ORIGIN, c]).status !== 0) return false;
    git(['config', 'user.email', 'smoke@example.invalid'], c); git(['config', 'user.name', 'Smoke'], c);
    const f = path.join(c, '.agents/config.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').split('\n').map((l) => (/^ {2}roles:\s*$/.test(l) ? `${l}\n    implementer: codex` : l)).join('\n'));
    if (git(['add', '.agents/config.yaml'], c).status !== 0 || git(['commit', '-q', '-m', 'chore: implementer runs on codex'], c).status !== 0 || git(['push', '-q', 'origin', 'HEAD:main'], c).status !== 0) return false;
  }
  if (!originHasCodexConfig()) return false;
  if (git(['fetch', '-q', 'origin'], P).status !== 0) return false;
  if (git(['symbolic-ref', '-q', '--short', 'HEAD'], P).out.trim() === 'main') return git(['merge', '-q', '--ff-only', 'origin/main'], P).status === 0;
  return git(['fetch', '-q', 'origin', 'main:main'], P).status === 0;
}

// p_closed_t1: the project is back on main (the lead's cleanup of T-1 returned to it), or there is no Codex to configure
const pClosedT1 = () => !have('codex') || git(['symbolic-ref', '-q', '--short', 'HEAD'], P).out.trim() === 'main';

// codex_dispatch_seen TRANSCRIPT: did a Codex implementer really run in the batch? A dispatch line of the transcript says `implementer runtime=codex`, or the shared metrics
// record the implementer with runtime codex, or a run folder holds a dispatch file named for it. (A text match on `implementer.*codex` over .agents/local also matches
// roles.conf and the *-test.sh files a worktree carries, so it passed on a batch whose implementers ran on Claude: A226.)
function codexDispatchSeen(transcript) {
  if (/dispatch: T-[0-9]* implementer runtime=codex/.test(readOr(transcript))) return true;
  if (/"role":"implementer".*"runtime":"codex"/.test(readOr(path.join(P, '.agents/local/metrics/records.jsonl')))) return true;
  return [...expand(`${P}/.agents/local/worktrees/*/.agents/runs/*/dispatch/*-implementer-codex.*`), ...expand(`${P}/.agents/runs/*/dispatch/*-implementer-codex.*`)].length > 0;
}

// codex_sandbox_row: the profile dispatch.sh gives a Codex worker, applied with `codex sandbox` (no model) to the installed scripts of this project:
// the worker's own record paths are writable, .agents/local/windows, approvals and prompts are not (A199)
function codexSandboxRow() {
  const name = 'codex sandbox: windows/approvals/prompts denied, own paths writable';
  if (!have('codex')) { row('codex sandbox: windows/approvals/prompts denied', 'SKIP', 0, 'codex is not installed'); return; }
  const t = now(); const home = path.join(work, 'chome');
  for (const d of [home, '.agents/runs/SMOKE-P', '.agents/local/windows', '.agents/local/approvals', '.agents/local/prompts', '.agents/local/locks', '.agents/local/submissions']) mkdirSync(path.isAbsolute(d) ? d : path.join(P, d), { recursive: true });
  const probe = path.join(work, 'cs-probe.sh');
  writeFileSync(probe, ['try() { ( : > "$1" ) 2>/dev/null && echo "WROTE $1" || echo "DENIED $1"; }', 'try .agents/runs/SMOKE-P/own.txt', 'try .agents/local/locks/own.probe', 'try .agents/local/windows/forged', 'try .agents/local/approvals/forged', 'try .agents/local/prompts/forged', ''].join('\n'));
  const prof = run('sh', ['.agents/scripts/dispatch.sh', 'codex-profile', 'SMOKE-P'], { cwd: P }).out.split('\n');
  if (prof.at(-1) === '') prof.pop();
  const r = run('codex', ['sandbox', '-C', P, '-P', 'proofline-worker', ...prof, '--', 'sh', probe], { env: { CODEX_HOME: home } });
  writeFileSync(path.join(work, 'cs-probe.out'), r.text);
  rmSync(path.join(P, '.agents/runs/SMOKE-P'), { recursive: true, force: true });
  const lines = r.text.split('\n');
  const has = (/** @type {string} */ l) => lines.includes(l);
  if (has('WROTE .agents/runs/SMOKE-P/own.txt') && has('WROTE .agents/local/locks/own.probe') && has('DENIED .agents/local/windows/forged') && has('DENIED .agents/local/approvals/forged') && has('DENIED .agents/local/prompts/forged')) {
    row(name, 'PASS', secs(t), 'the installed dispatch.sh profile, applied by codex sandbox');
  } else row(name, 'FAIL', secs(t), r.text.replace(/\n/g, ' ').slice(0, 200));
}

// drive STEP PROMPT DONE REPLY: the first prompt, then up to maxReplies replies of the user until DONE succeeds
/** @param {string} step @param {string} prompt @param {() => boolean} done @param {string} reply */
async function drive(step, prompt, done, reply) {
  const out = path.join(work, `${step}.jsonl`); writeFileSync(out, '');
  let n = 0;
  const sess = await claudeCall(P, out, prompt);
  if (!sess) { console.error(`no session id in ${out}`); return false; }
  while (!done() && n < maxReplies) {
    userMerges();
    if (done()) break;
    n++;
    await claudeCall(P, out, reply, sess);
  }
  return done();
}

function skillDetourRow() { // Claude Code rejects a Skill call for a proofline skill before any hook runs; what counts is that the lead then read the file and went on
  let calls = 0;
  for (const f of readdirSync(work).filter((n) => n.endsWith('.jsonl'))) calls += (readOr(path.join(work, f)).match(/"name":"Skill"/g) ?? []).length;
  if (calls <= 0) row('skill tool not used', 'PASS', 0, 'no Skill-tool call in any transcript');
  else if (calls <= 3 && fails === 0) row('skill tool: the lead recovered', 'PASS', 0, `${calls} rejected call(s); every step above still passed, so the lead read the file and went on`);
  else row('skill tool: the lead recovered', 'FAIL', 0, `${calls} Skill-tool call(s) and a failed step above`);
}

// fixture_commands: the project has build, test and lint commands, so the batch pre-flight (A200) finds nothing empty; a model that meets empty ones stops at
// the first NEXT line of the batch and waits for the user (A202 smoke run 3), which is the right behaviour but not what the scenarios here measure
function fixtureCommands() {
  const f = path.join(P, '.agents/config.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/^ {2}build:.*$/, '  build: npm run build').replace(/^ {2}test:.*$/, '  test: npm test').replace(/^ {2}lint:.*$/, '  lint: npm run lint')).join('\n'));
  chmodSync(f, 0o644);
}
// fixture_rules: the project rules of the fixture (the user's own section of AGENTS.md, outside the proofline block). The batch runs two tasks at the same time and
// merges both, so what the tasks write must not collide: every knowledge note carries the task id, and the shared documents (the design document, the wiki index,
// log and lint report) are not touched by a task. Nobody is there to approve an amend, so the commits are exactly the ones proofline writes. The rules are not in the
// task files: a path named there becomes part of the plan scope and the knowledge step refuses it, and a file named by two tasks looks like an overlap to the batch.
function fixtureRules() {
  appendFileSync(path.join(P, 'AGENTS.md'), '\n## Project rules\n\n- Knowledge notes: write one short note per task at docs/design/<TASK-ID>-note.md (for example docs/design/T-2-note.md). Never create or edit docs/design/DESIGN.md, docs/wiki/index.md, docs/wiki/log.md or docs/wiki/lint-report.md: tasks of one batch are merged together and a shared file conflicts.\n- Commits: use the commit message proofline writes. Add no Co-Authored-By or other trailer; an amend of a delivered commit is refused by the git hook.\n');
}
/** NAME_PREFIX: the fixture repository, a local bare origin and proofline installed; sets P and ORIGIN; false when setup failed. @param {string} pre */
function mkFixture(pre) {
  P = path.join(work, pre, 'project'); ORIGIN = path.join(work, pre, 'origin.git');
  for (const d of ['src', 'tests', '.agents/tasks']) mkdirSync(path.join(P, d), { recursive: true });
  const t0 = now();
  git(['init', '-q', '--bare', '-b', 'main', ORIGIN]);
  writeFileSync(path.join(P, 'package.json'), '{ "name": "smoke-app", "version": "1.0.0", "private": true, "type": "module", "scripts": { "test": "node --test", "build": "node --check src/greet.js", "lint": "node --check tests/greet.test.js" } }\n');
  writeFileSync(path.join(P, 'src/greet.js'), 'export function greet(name) {\n  return `Hello, ${name}`;\n}\n');
  writeFileSync(path.join(P, 'tests/greet.test.js'), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "../src/greet.js";\ntest("greet", () => assert.equal(greet("a"), "Hello, a"));\n');
  writeFileSync(path.join(P, 'README.md'), '# smoke-app\n\nA tiny fixture for the proofline real-session smoke test.\n');
  // generated, shared by every task that touches the wiki, and listed in every delivery summary: not part of any task's change (a shared generated file is a merge conflict)
  writeFileSync(path.join(P, '.gitignore'), 'docs/wiki/lint-report.md\n');
  git(['init', '-q', '-b', 'main'], P);
  git(['config', 'user.name', 'Smoke'], P); git(['config', 'user.email', 'smoke@example.invalid'], P); git(['config', 'commit.gpgsign', 'false'], P);
  git(['add', '-A'], P); git(['commit', '-q', '-m', 'chore: fixture'], P);
  git(['remote', 'add', 'origin', ORIGIN], P); git(['push', '-q', 'origin', 'main'], P);
  const rts = have('codex') ? 'claude,codex' : 'claude';
  const init = run(path.join(repo, 'bin/proofline'), ['init', '--yes', '--runtimes', rts, '--lead', 'claude', '--worker', 'claude', '--reviewers', 'claude', '--profile', 'economy', '--task-adapter', 'markdown'], { cwd: P });
  writeFileSync(path.join(work, `${pre}-init.txt`), init.text);
  let ok = init.status === 0;
  if (ok) { fixtureCommands(); fixtureRules(); ok = git(['add', '-A'], P).status === 0 && git(['commit', '-q', '-m', 'chore: install proofline'], P).status === 0 && git(['push', '-q', 'origin', 'main'], P).status === 0; }
  if (ok) { row(`${pre} setup: init, local bare origin`, 'PASS', secs(t0), `installed proofline ${run(path.join(repo, 'bin/proofline'), ['version'], { cwd: P }).out.trim()}`); return true; }
  row(`${pre} setup: init, local bare origin`, 'FAIL', secs(t0), `see ${work}/${pre}-init.txt`);
  return false;
}

// a202_task_files ID: every copy of the task file the control plane may have written the status block to (main tree and run worktree, any lifecycle folder)
/** @param {string} id */
const a202TaskFiles = (id) => [`${P}/.agents/tasks/${id}.md`, `${P}/.agents/tasks/*/${id}.md`, `${P}/.agents/tasks/${id}-*.md`, `${P}/.agents/tasks/*/${id}-*.md`,
  `${P}/.agents/local/worktrees/${id}/.agents/tasks/${id}.md`, `${P}/.agents/local/worktrees/${id}/.agents/tasks/*/${id}.md`].flatMap((p) => expand(p)).filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });
// a202_both_merged: the control plane's own block of both tasks says MERGED (in any copy of the task file)
const a202BothMerged = () => ['T-2', 'T-3'].every((t) => a202TaskFiles(t).some((f) => countLines(readOr(f), /^- stage: MERGED$/) > 0));
/** ID: state<TAB>detail, from the batch records. @param {string} id */
const batchRow = (id) => A(['batch-next', '--tsv']).split('\n').map((l) => l.split('\t')).filter((c) => c[0] === id).map((c) => `${c[1] ?? ''}\t${c[2] ?? ''}`).join('\n');
// a202_status_row PREFIX ID: the status block, read from the task file the control plane wrote (never from the model's text)
/** @param {string} pre @param {string} id */
function a202StatusRow(pre, id) {
  const n = `${pre} batch status block (${id}): one section, updated in place, MERGED, no local path`; const t = now(); let best = ''; let why = '';
  for (const f of a202TaskFiles(id)) {
    const text = readOr(f);
    const c = countLines(text, /^## Proofline Status\s*$/); const b = countLines(text, new RegExp(`^<!-- PROOFLINE-STATUS:BEGIN:${id} -->$`));
    if (c > 1 || b > 1) { why = `${f} has ${c} status sections and ${b} blocks`; break; }
    if (c === 1 && b === 1) best = f;
  }
  if (why) { row(n, 'FAIL', secs(t), why); return; }
  if (!best) { row(n, 'FAIL', secs(t), `no task file of ${id} holds a status block`); return; }
  const blk = statusBlock(readOr(best), id);
  const stage = (blk.split('\n').map((l) => /^- stage: (.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
  const lp = ['/Users/', '/home/', '/private/', '/var/folders', '/tmp/', '.agents/local', work, P].map((x) => blk.split('\n').find((l) => l.includes(x)) ?? '').find((x) => x !== '') ?? '';
  if (!blk || !blk.split('\n').includes(`- run: ${id}`)) row(n, 'FAIL', secs(t), `the block of ${id} is empty or names another run`);
  else if (stage !== 'MERGED') row(n, 'FAIL', secs(t), `stage is '${stage}', not MERGED (agent.sh state: ${batchRow(id).replace(/\t/g, ' ')})`);
  else if (lp) row(n, 'FAIL', secs(t), `the block holds a local path: ${lp.slice(0, 120)}`);
  else row(n, 'PASS', secs(t), `stage ${stage} in ${path.basename(best)}, ${blk.split('\n').filter((l) => l !== '').length} lines`);
}
// a202_branch_row PREFIX ID WORD: the task branch is proofline/<ID>-<slug>, the slug comes from the title (WORD is a word of it), never <id lowercase>
/** @param {string} pre @param {string} id @param {string} word */
function a202BranchRow(pre, id, word) {
  const n = `${pre} batch branch name (${id}): proofline/<ID>-<slug>, slug from the title`; const t = now(); let src = 'origin';
  let b = originRefs().find((x) => x.startsWith(`proofline/${id}-`)) ?? '';
  if (!b) { // merged and deleted on the origin: the name the control plane recorded
    src = 'recorded';
    b = (readOr(path.join(P, `.agents/local/deliver/${id}/SUMMARY.md`)).split('\n').map((l) => /^branch: (.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
    if (!b) b = ((readOr(path.join(P, `.agents/runs/${id}/RUN.yaml`)) + readOr(path.join(P, `.agents/local/worktrees/${id}/.agents/runs/${id}/RUN.yaml`))).split('\n').map((l) => /^\s*task_branch:\s*(.*)$/.exec(l)).find(Boolean) ?? [])[1]?.replace(/"/g, '') ?? '';
  }
  const low = id.toLowerCase(); const prefix = `proofline/${id}-`; const slug = b.startsWith(prefix) ? b.slice(prefix.length) : b;
  if (!b) row(n, 'FAIL', secs(t), `no proofline/${id}-* branch on the origin and none recorded`);
  else if (slug === b || slug === '' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) row(n, 'FAIL', secs(t), `branch '${b}' is not proofline/${id}-<slug>`);
  else if (slug === low) row(n, 'FAIL', secs(t), `branch '${b}' repeats the id as its slug`);
  else if (!slug.includes(word)) row(n, 'FAIL', secs(t), `slug '${slug}' does not come from the task title (no '${word}')`);
  else row(n, 'PASS', secs(t), `${b} (${src})`);
}
/** @param {string} pre */
const a202Rows = (pre) => { a202StatusRow(pre, 'T-2'); a202StatusRow(pre, 'T-3'); a202BranchRow(pre, 'T-2', 'whisper'); a202BranchRow(pre, 'T-3', 'repeat'); };

/** The three fixture tasks. @param {string} tk */
function fixtureTask(tk) {
  const [f, fn, ac] = tk === 'T-1' ? ['shout', 'shout', 'the text in upper case followed by "!"'] : tk === 'T-2' ? ['whisper', 'whisper', 'the text in lower case followed by "..."'] : ['repeat', 'repeatTwice', 'the text twice, separated by one space'];
  return `# Task: ${tk} — add ${fn}

## Goal

Add src/${f}.js exporting a function ${fn}(text) with a test in tests/${f}.test.js.

## Context

Fixture task of the proofline real-session smoke test.

## Acceptance criteria

- AC-1: src/${f}.js exports ${fn}(text), which returns ${ac}.
- AC-2: tests/${f}.test.js tests it with node:test and \`npm test\` passes.

## Out of scope

- Any change to src/greet.js.

## Constraints

- No dependencies.

## Risks

- None.

## Pre-existing defects

none

## Suggested class

TRIVIAL — one new file and its test.

## Verification commands

- \`npm test\`
`;
}

/** one full pass (setup, run, deliver, batch); NAME_PREFIX @param {string} pre */
async function pass(pre) {
  if (!mkFixture(pre)) return;
  let t0 = now();
  const doc = run(path.join(repo, 'bin/proofline'), ['doctor'], { cwd: P });
  writeFileSync(path.join(work, `${pre}-doctor.txt`), doc.text);
  if (doc.status === 0) row(`${pre} doctor`, 'PASS', secs(t0), doc.text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).at(-1) ?? '');
  else row(`${pre} doctor`, 'FAIL', secs(t0), doc.text.split('\n').find((l) => l.startsWith('FAIL')) ?? '');

  for (const tk of ['T-1', 'T-2', 'T-3']) writeFileSync(path.join(P, `.agents/tasks/${tk}.md`), fixtureTask(tk));
  git(['add', '-A'], P); git(['commit', '-q', '-m', 'chore: tasks'], P); git(['push', '-q', 'origin', 'main'], P);

  if (only !== 'codex' && only !== 'a202') {
    // 1. run: the implementer writes the file
    t0 = now();
    const runName = `${pre} /proofline run (implementer wrote src/shout.js)`;
    if (await drive(`${pre}-run`, '/proofline run T-1', () => A(['digest', 'T-1']).includes('CODE_DONE'), 'approve plan')) {
      const tb = git(['branch', '--list', 'proofline/*'], P).out.split('\n')[0]?.replace(/[ *]/g, '') ?? '';
      if ((tb && git(['ls-tree', '-r', '--name-only', tb], P).out.split('\n').includes('src/shout.js')) || existsSync(path.join(P, 'src/shout.js'))) row(runName, 'PASS', secs(t0), `state: ${firstLine(A(['next', 'T-1']))}`);
      else row(runName, 'FAIL', secs(t0), 'no src/shout.js on the task branch');
    } else row(runName, 'FAIL', secs(t0), `run did not reach CODE_DONE: ${firstLine(A(['next', 'T-1']))}`);

    // 2. deliver: commit, push to the local bare origin
    t0 = now();
    const delName = `${pre} /proofline deliver (branch on the local origin)`;
    if (await drive(`${pre}-deliver`, '/proofline deliver T-1', () => gitd(ORIGIN, ['for-each-ref', 'refs/heads/']).out.includes('proofline/'), 'approve delivery')) {
      row(delName, 'PASS', secs(t0), `origin: ${originRefs().find((x) => x.includes('proofline/')) ?? ''}`);
    } else row(delName, 'FAIL', secs(t0), 'no proofline/* branch on the origin');
    // the user merged the delivered branch on the origin; the lead closes the run (deliver-merged, cleanup) from that
    userMerges();
    git(['checkout', '-q', 'main'], P); git(['pull', '-q', '--ff-only', 'origin', 'main'], P);
    await drive(`${pre}-merged`, 'I merged the branch of T-1 on the origin. Finish T-1.', pClosedT1, 'I merged it on the origin; please finish T-1 (deliver-merged and cleanup).').catch(() => false);
  }
  // in every mode, once more and before the batch is planned: the drive above may have ended (replies spent) with the lead still finishing T-1; the config on
  // the origin's main is what the batch worktrees branch from, and a batch without it runs Claude implementers (A226)
  if (have('codex')) {
    const n = `${pre} setup: implementer runs on codex (config on the origin's main)`;
    if (codexConfigCommit()) row(n, 'PASS', 0, 'implementer: codex on origin main'); else row(n, 'FAIL', 0, "the Codex config did not reach the origin's main");
  }

  if (only !== 'a202') codexSandboxRow();

  // 3. batch of two tasks; with Codex installed the implementer is Codex, so every batch task runs a Codex implementer in a run worktree (A196)
  t0 = now();
  const batchName = `${pre} /proofline batch T-2 T-3 (both reach origin main)`;
  if (await drive(`${pre}-batch`, '/proofline batch T-2 T-3', () => originHas('src/whisper.js') && originHas('src/repeat.js'), 'approve batch')) row(batchName, 'PASS', secs(t0), firstLine(A(['batch-status'])));
  else row(batchName, 'FAIL', secs(t0), A(['batch-next']).split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).at(-1) ?? '');
  // the drive above ends the moment the user's merge lands on the origin; the control plane records a merge only when the lead is told (deliver-merged), so the
  // block can honestly say PR OPEN until then. The user says so once more, as in the real flow, and the rows are read after the lead recorded both merges.
  userMerges();
  // said only when both really are on the origin's main (a false "I merged it" makes the lead check and refuse, A200 smoke run 2)
  if (originHas('src/whisper.js') && originHas('src/repeat.js') && !abPending()) {
    await drive(`${pre}-batch-merged`, 'I merged T-2 and T-3 on the origin. Record the merges and finish the batch.', a202BothMerged, 'I merged them on the origin; record the merges (deliver-merged) and clean up.').catch(() => false);
  }
  a202Rows(pre);   // A202: the status block and the slug in the branch name, read from files and agent.sh state
  if (only === 'a202') return;
  const cn = `${pre} batch: a Codex implementer in a worktree, submit included`;
  if (have('codex')) {
    const logs = expand(`${P}/.agents/local/worktrees/*/.agents/runs/*/dispatch/*codex*.log`);
    const lock = [path.join(work, `${pre}-batch.jsonl`), ...logs].some((f) => readOr(f).includes('cannot take the lock'));
    if (codexDispatchSeen(path.join(work, `${pre}-batch.jsonl`)) && !lock) row(cn, 'PASS', 0, 'no lock failure in the transcript or dispatch logs');
    else row(cn, 'FAIL', 0, 'no Codex dispatch seen, or a lock failure');
  } else row(`${pre} batch: Codex implementer in a worktree`, 'SKIP', 0, 'codex is not installed');
}

// --- A200 scenarios (SMOKE_ONLY=a200 only): what a night batch and a fix round must do, read from the control plane, never from the model's text ---

// a200_task FILE ID CLASS TITLE GOAL AC1 AC2: a task file in the shape the other fixture tasks have; the paths are named in backticks (plan-lint reads them)
/** @param {string} file @param {string} id @param {string} klass @param {string} title @param {string} goal @param {string} ac1 @param {string} ac2 */
function a200Task(file, id, klass, title, goal, ac1, ac2) {
  writeFileSync(file, `# Task: ${id} — ${title}

## Goal

${goal}

## Context

Fixture task of the proofline real-session smoke test (A200 scenarios).

## Acceptance criteria

- AC-1: ${ac1}
- AC-2: ${ac2}

## Out of scope

- Any change to src/greet.js.

## Constraints

- No dependencies.

## Risks

- None.

## Pre-existing defects

none

## Suggested class

${klass}

## Verification commands

- \`npm test\`
`);
}
/** @param {string} k */
const cfgGet = (k) => A(['config-get', k]).replace(/\n+$/, '');
/** ID GATE: the gate records of a run. @param {string} id @param {string} gate */
const gcount = (id, gate) => { try { return readdirSync(path.join(P, '.agents/runs', id, 'gates')).filter((n) => n.endsWith(`-${gate}.yaml`)).length; } catch { return 0; } };
/** @type {string} */ let abOut = ''; /** @type {string} */ let abSess = ''; let abMsgs = 0;
/** @param {string} t */
const abSay = async (t) => { await claudeCall(P, abOut, t, abSess); abMsgs++; };
const abPending = () => originRefs().filter((x) => x.startsWith('proofline/')).some((b) => gitd(ORIGIN, ['merge-base', '--is-ancestor', b, 'main']).status !== 0);
const abDone = () => originHas('src/join.js') && originHas('src/pad.js');

// scenarios (a), (b), (d): one batch of two tasks. B-1 names four code paths under a TRIVIAL class (plan-lint asks the split question before the approval);
// commands.build|test|lint are empty and the project has scripts for all three (the summary proposes them)
async function a200Batch() {
  const n = 'a200 batch'; abOut = path.join(work, 'a200-batch.jsonl'); writeFileSync(abOut, ''); abMsgs = 0; const abMax = Number(env.SMOKE_A200_REPLIES || 14);
  if (!mkFixture('a200b')) return;
  writeFileSync(path.join(P, 'package.json'), '{ "name": "smoke-app", "version": "1.0.0", "private": true, "type": "module", "scripts": { "test": "node --test", "build": "node --check src/greet.js", "lint": "node --check tests/greet.test.js" } }\n');
  const cf = path.join(P, '.agents/config.yaml');
  writeFileSync(cf, readFileSync(cf, 'utf8').split('\n').map((l) => l.replace(/^ {2}(build|test|lint):\s*[^\s#].*$/, '  $1:')).join('\n'));
  a200Task(path.join(P, '.agents/tasks/B-1.md'), 'B-1', 'TRIVIAL — one function in three small modules.', 'join two words',
    'Add `src/join.js`, `src/join-parts.js` and `src/join-sep.js` and a test `tests/join.test.js`: joinWords(a, b) (exported from src/join.js) uses the helpers.',
    'joinWords(a, b) returns a and b separated by one space.', 'tests/join.test.js tests it with node:test and `npm test` passes.');
  a200Task(path.join(P, '.agents/tasks/B-2.md'), 'B-2', 'TRIVIAL — one new file and its test.', 'pad a word',
    'Add `src/pad.js` exporting padWord(text) with a test in `tests/pad.test.js`.',
    'padWord(text) returns the text with one space on each side.', 'tests/pad.test.js tests it with node:test and `npm test` passes.');
  git(['add', '-A'], P); git(['commit', '-q', '-m', 'chore: a200 tasks'], P); git(['push', '-q', 'origin', 'main'], P);
  const t0 = now();
  abSess = await claudeCall(P, abOut, '/proofline batch B-1 B-2');
  if (!abSess) {
    for (const r of ['(a) pre-flight answer: the batch does not park at freeze', '(b) empty commands proposed in the summary, filled after approval', '(d) the lead continues after CODE_DONE and to the next task']) row(`${n} ${r}`, 'FAIL', secs(t0), `no session id in ${abOut}`);
    return;
  }
  const sum = path.join(P, '.agents/local/batch/SUMMARY.md');
  if (!existsSync(sum)) await abSay('Plan the batch of B-1 and B-2 now and show me the summary with its questions.');
  const sumText = readOr(sum); writeFileSync(path.join(work, 'a200-SUMMARY.md'), sumText);
  const abQ = readOr(path.join(P, '.agents/local/batch/lint.tsv')).split('\n').map((l) => l.split('\t')).find((c) => c[1] === 'B-1' && c[2] === 'split')?.[0] ?? '';
  const abSec = countLines(sumText, /^## Verification commands/);
  const abProp = (sumText.split('\n').map((l) => /^commands proposal: (.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
  // the user answers the question in their own words, then approves the batch (two messages: an answer is never an approval)
  if (abQ) await abSay(`${abQ}: do not split it, proceed without splitting`);
  const abAns = A(['batch-answers', 'B-1']).replace(/\n+$/, '');
  for (let i = 0; i < 3 && A(['batch-next', '--tsv']).split('\n')[0] !== 'state\tapproved'; i++) await abSay('approve batch');
  const abAt = abMsgs;
  // checkpoint: after the approval message alone, nothing else said
  const abRow = batchRow('B-1');
  const abPushed = originRefs().filter((x) => x.startsWith('proofline/')).length;
  // after the checkpoint the user only merges what was delivered, and says so only when there was something to merge; otherwise a neutral
  // "Continue." (a headless call ends when the lead waits for a background agent, so a night of work needs more calls than a human would send).
  // A false "I merged it" made the lead check origin, find nothing and spend the whole reply budget refusing to record a merge (A200 smoke run 2).
  for (let i = 0; !abDone() && i < abMax; i++) { if (abPending()) { userMerges(); await abSay('I merged it on the origin.'); } else await abSay('Continue.'); }
  userMerges();
  const abNote = (readOr(abOut).match(/note=BATCH \(A200\)/g) ?? []).length;
  const abSecs = secs(t0);

  // (a) the question asked by the pre-flight and answered with the approval: recorded as the user's, and B-1 was not parked at freeze
  const [abState, abDet] = abRow.split('\t'); const na = `${n} (a) pre-flight answer: the batch does not park at freeze`;
  if (!abQ) row(na, 'FAIL', abSecs, 'the summary asked no split question for B-1 (lint.tsv)');
  else if (!abAns.split('\n').some((l) => l.includes('split: option b'))) row(na, 'FAIL', abSecs, `agent.sh batch-answers B-1 recorded no 'split: option b': ${abAns}`);
  else if (abState === 'parked' && abDet !== 'awaiting merge') row(na, 'FAIL', abSecs, `B-1 is parked after the approval: ${abDet}`);
  else if (!originHas('src/join.js')) row(na, 'FAIL', abSecs, `B-1 never reached origin main (batch-next: ${abState} ${abDet})`);
  else row(na, 'PASS', abSecs, `answer recorded (${abQ}: ${abAns.replace(/\n/g, ' ')}); B-1 state after the approval: ${abState}/${abDet}`);

  // (b) the summary proposes the empty commands; after the approval exactly the proven ones are in the configuration
  let bad = '';
  for (const k of ['build', 'test', 'lint']) {
    const v = cfgGet(`commands.${k}`);
    if (!v) { bad += ` commands.${k} is still empty;`; continue; }
    if (!sumText.includes(`commands.${k}: ${v}`)) bad += ` commands.${k}=${v} was not in the summary's proposal;`;
  }
  const nb = `${n} (b) empty commands proposed in the summary, filled after approval`;
  if (abSec <= 0 || !abProp) row(nb, 'FAIL', abSecs, "the summary has no 'Verification commands' proposal (a proven proposal needs proofline doctor --commands before batch-plan)");
  else if (bad) row(nb, 'FAIL', abSecs, bad);
  else row(nb, 'PASS', abSecs, `proposal ${abProp}; build=${cfgGet('commands.build')} test=${cfgGet('commands.test')} lint=${cfgGet('commands.lint')}`);

  // (d) after the approval message alone the lead carried B-1 past CODE_DONE to a pushed branch, and went on to B-2 without being told
  const nd = `${n} (d) the lead continues after CODE_DONE and to the next task`;
  if (abPushed <= 0) row(nd, 'FAIL', abSecs, `no proofline/* branch on the origin after the approval message (${abAt} user messages): the lead stopped before delivery (B-1 ${abState}/${abDet})`);
  else if (!abDone()) row(nd, 'FAIL', abSecs, 'B-1 was delivered by the lead, but B-2 never reached origin main');
  else if (abNote <= 0) row(nd, 'FAIL', abSecs, 'no note=BATCH (A200) line in any agent.sh next output of the transcript');
  else row(nd, 'PASS', abSecs, `delivered with ${abAt} user messages (none after the approval); note=BATCH seen ${abNote} time(s); ${abMsgs - abAt} 'I merged it' message(s) later, none naming B-2`);
}

// scenario (c): a fix round that changes only a test file does not run SECURITY again. F-1 touches three files (tier full: SECURITY is required);
// after CODE_DONE the user asks for one more test case. The evidence is the gate records of the run and the hashes of the files.
const fxHash = () => ['src/total.js', 'src/total-format.js', 'tests/total.test.js'].map((p) => `${git(['hash-object', path.join(P, p)]).out.trim() || 'missing'} `).join('');
const fxCodedone = () => A(['digest', 'F-1']).includes('CODE_DONE');
const fxFixed = () => gcount('F-1', 'VERIFY') >= 2 && fxCodedone();
async function a200Fix() {
  const n = 'a200 fix round'; const nc = `${n} (c) test-only fix: SECURITY not re-run`;
  if (!mkFixture('a200f')) return;
  a200Task(path.join(P, '.agents/tasks/F-1.md'), 'F-1', 'STANDARD — three files, so the full review tier.', 'format a total',
    'Add `src/total.js` exporting sumList(list), `src/total-format.js` exporting formatTotal(list) (it uses sumList and returns the sum with two decimals) and a test `tests/total.test.js`.',
    'formatTotal([1, 2]) returns "3.00".', 'tests/total.test.js tests it with node:test and `npm test` passes.');
  git(['add', '-A'], P); git(['commit', '-q', '-m', 'chore: a200 task'], P); git(['push', '-q', 'origin', 'main'], P);
  const t0 = now();
  if (!(await drive('a200-fix-run', '/proofline run F-1', fxCodedone, 'approve plan'))) { row(nc, 'FAIL', secs(t0), `F-1 did not reach CODE_DONE: ${firstLine(A(['next', 'F-1']))}`); return; }
  const tier = (A(['pipeline', 'F-1']).split('\n').map((l) => /^tier=(.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
  const sec1 = gcount('F-1', 'SECURITY'); const ver1 = gcount('F-1', 'VERIFY'); const h1 = fxHash();
  if (tier !== 'full' || sec1 < 1) { row(nc, 'FAIL', secs(t0), `scenario invalid: tier=${tier}, ${sec1} SECURITY record(s) before the fix round`); return; }
  // a test-only change that adds no behaviour (a tidy of the existing case): no new RED exists to record and none is owed (tdd-proof rule 6: REFACTOR/FIX evidence with the
  // plan unchanged). A NEW case for behaviour the code already has cannot show a RED without touching product code, and a plan amendment voids every path's evidence
  // (run 3 of the A200 smoke: the lead stopped on exactly that), so the scenario asks for the kind of test-only fix that has no such gap.
  await drive('a200-fix-round', 'Fix round for F-1: tidy tests/total.test.js only. Rename the existing test to "formatTotal formats the sum with two decimals" and compare with assert.strictEqual. No new case, no behaviour change, no product code, and no plan change. Reopen F-1 (amend), have the implementer make the change with its REFACTOR evidence, and run the gates again.', fxFixed, 'Go on: only that test file changes, the plan stays frozen. Run the gates again.').catch(() => false);
  const sec2 = gcount('F-1', 'SECURITY'); const ver2 = gcount('F-1', 'VERIFY'); const h2 = fxHash();
  const gate = (A(['pipeline', 'F-1']).split('\n').map((l) => /^gate\.SECURITY=(.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
  const head2 = (/** @type {string} */ h) => h.trim().split(' ').slice(0, 2).join(' '); const last = (/** @type {string} */ h) => h.trim().split(' ')[2];
  if (ver2 <= ver1) row(nc, 'FAIL', secs(t0), `the fix round never ran the gates again (VERIFY records ${ver1} -> ${ver2})`);
  else if (head2(h1) !== head2(h2) || last(h1) === last(h2)) row(nc, 'FAIL', secs(t0), `scenario invalid: the fix did not change exactly the test file (hashes ${h1} -> ${h2})`);
  else if (sec2 !== sec1) row(nc, 'FAIL', secs(t0), `SECURITY ran again after a test-only fix (${sec1} -> ${sec2} records)`);
  else if (gate !== 'pass') row(nc, 'FAIL', secs(t0), `gate.SECURITY is '${gate}' after the fix round, not the carried pass`);
  else row(nc, 'PASS', secs(t0), `SECURITY records ${sec1} -> ${sec2} (gate.SECURITY=${gate}), VERIFY ${ver1} -> ${ver2}, only the test file changed`);
}

// --- A196 (SMOKE_ONLY=a196): a user-only answer is recorded by the prompt hook only from the session that asked the question (A210, #187) ---
/** N: the answer file of question N of the run. @param {string} n */
const a196Ans = (n) => path.join(P, `.agents/runs/T-1/questions/${n}.answer.md`);
// a196_handled TEXT: the prompt hook captured a message with exactly this text (prompts/history/<time>-<sha>.txt); prints that file's name
/** @param {string} text */
function a196Handled(text) {
  const d = path.join(P, '.agents/local/prompts/history');
  let names = []; try { names = readdirSync(d).filter((n) => n.endsWith('.txt')).sort(); } catch { /* none */ }
  return names.find((n) => readOr(path.join(d, n)).replace(/\n+$/, '') === text) ?? '';
}
/** @param {string} n */
const a196UserAnswer = (n) => /^answered_by: user$/m.test(readOr(a196Ans(n)));
async function a196Run() {
  const n = 'a196 user answer bound to the asking session';
  if (!mkFixture('a196')) return;
  a200Task(path.join(P, '.agents/tasks/T-1.md'), 'T-1', 'TRIVIAL — one function in one module.', 'shout', 'Add `src/shout.js` exporting shout(text).', 'shout("a") returns "A!".', '`npm test` passes.');
  git(['add', '-A'], P); git(['commit', '-q', '-m', 'chore: a196 task'], P); git(['push', '-q', 'origin', 'main'], P);
  const t0 = now();
  // the run is opened by the script (a human start); the lead of the real session asks the question from its own Bash, so asked_session is the session's own id
  const st = run('sh', ['.agents/scripts/agent.sh', 'start', 'T-1', '--task-file', '.agents/tasks/T-1.md'], { cwd: P });
  writeFileSync(path.join(work, 'a196-start.txt'), st.text);
  if (st.status !== 0) { row(`${n} (positive)`, 'FAIL', secs(t0), `start T-1 failed: ${firstLine(st.text)}`); return; }
  const out = path.join(work, 'a196.jsonl'); writeFileSync(out, '');
  const sess = await claudeCall(P, out, "Run this command exactly as it is, with the Bash tool, once: printf '%s\\n' '1. Fix the old defect in this change?' '   USER_ONLY: scope D-1' '   options: \"report it, out of scope\" | \"fix it in this change\"' '   recommended: report it, out of scope' | sh .agents/scripts/agent.sh ask T-1    Then stop and wait for my reply; run nothing else.");
  if (!sess) { row(`${n} (positive)`, 'FAIL', secs(t0), `no session id in ${out}`); return; }
  const q1 = path.join(P, '.agents/runs/T-1/questions/001.md');
  if (!existsSync(q1)) { row(`${n} (positive)`, 'FAIL', secs(t0), 'the lead did not ask the question (no questions/001.md)'); return; }
  const asked = (readOr(q1).split('\n').map((l) => /^asked_session: (.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
  if (asked !== sess) { row(`${n} (positive)`, 'FAIL', secs(t0), `asked_session '${asked || 'none'}' is not the session id of the transcript (${sess})`); return; }
  await sleep(2000);   // a message of the second the question was asked in is not its answer
  await claudeCall(P, out, 'report it, out of scope', sess);
  const h1 = a196Handled('report it, out of scope');
  if (!h1) { row(`${n} (positive)`, 'FAIL', secs(t0), 'scenario invalid: the hook did not handle the message'); return; }
  const src = (readOr(a196Ans('001')).split('\n').map((l) => /^source_message: (.*)$/.exec(l)).find(Boolean) ?? [])[1] ?? '';
  if (a196UserAnswer('001') && src === h1) row(`${n} (positive)`, 'PASS', secs(t0), `asked_session = the hook's session id; questions/001.answer.md: answered_by: user, source_message ${src}`);
  else row(`${n} (positive)`, 'FAIL', secs(t0), `no answered_by: user record: ${readOr(a196Ans('001')).split('\n').slice(0, 3).join(' ')}`);
  // negative: a question that another session asked is not answered by a message of this one
  const t1 = now();
  const ask2 = A(['ask', 'T-1'], { both: true, input: '1. Fix the other old defect in this change?\n   USER_ONLY: scope D-2\n   options: "report it, out of scope" | "fix it in this change"\n', env: { CLAUDE_CODE_SESSION_ID: 'smoke-other-session' } });
  writeFileSync(path.join(work, 'a196-ask2.txt'), ask2);
  const q2 = path.join(P, '.agents/runs/T-1/questions/002.md');
  if (!existsSync(q2) || !/^asked_session: smoke-other-session$/m.test(readOr(q2))) { row(`${n} (negative, other session)`, 'FAIL', secs(t1), 'scenario invalid: question 002 was not asked under the other session id'); return; }
  await sleep(2000);
  await claudeCall(P, out, 'fix it in this change', sess);
  const h2 = a196Handled('fix it in this change');
  if (!h2) { row(`${n} (negative, other session)`, 'FAIL', secs(t1), 'scenario invalid: the hook did not handle the message'); return; }
  if (readOr(path.join(P, '.agents/local/prompts/consumed')).split('\n').includes(h2)) row(`${n} (negative, other session)`, 'FAIL', secs(t1), 'the message of the other session was consumed as an answer');
  else if (a196UserAnswer('002')) row(`${n} (negative, other session)`, 'FAIL', secs(t1), "an answer from another session was recorded as the user's");
  else row(`${n} (negative, other session)`, 'PASS', secs(t1), `questions/002.answer.md: ${(readOr(a196Ans('002')).split('\n').map((l) => /^answered_by: (.*)$/.exec(l)).find(Boolean) ?? [])[1] ? `answered_by ${(readOr(a196Ans('002')).split('\n').map((l) => /^answered_by: (.*)$/.exec(l)).find(Boolean) ?? [])[1]}` : 'none'}`);
}

/** The printed table. @param {string} mdl @param {string} version @param {string[][]} rs */
export function renderTable(mdl, version, rs) {
  return `\nproofline real-session smoke (model ${mdl}, proofline ${version})\n| step | result | seconds | note |\n|---|---|---|---|\n${rs.map((r) => `${tableLine(r)}\n`).join('')}`;
}

async function main() {
  if (!have('claude')) { console.error('smoke: claude is not installed'); return 127; }
  // the script plays the human user (commit, push, merge): the markers of a surrounding agent session would make the git hooks treat it as an agent
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CODEX_CI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'AGENT_ROLE', 'PROOFLINE_NO_TTY']) delete env[k];
  work = mkdtempSync(path.join(env.TMPDIR || '/tmp', 'proofline-smoke.'));
  const cleanup = () => { for (const p of pids) { try { p.kill('SIGTERM'); } catch { /* gone */ } } if (env.SMOKE_KEEP !== '1') { try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } } };
  process.on('exit', cleanup);
  for (const s of /** @type {const} */ (['SIGHUP', 'SIGINT', 'SIGTERM'])) process.on(s, () => process.exit(130));
  // the `proofline` command of every session is THIS checkout's CLI: the plugin cache on the machine may hold an older release whose doctor knows no --commands,
  // and a session that ran it would see no proposal (a stale CLI is not what the A200 rows test)
  mkdirSync(path.join(work, 'bin'), { recursive: true });
  writeFileSync(path.join(work, 'bin/proofline'), `#!/bin/sh\nexec "${repo}/bin/proofline" "$@"\n`); chmodSync(path.join(work, 'bin/proofline'), 0o755);

  smokeUserSettings = 'no';
  if (only === 'a196') await a196Run();
  else if (only === 'a200') { await a200Batch(); await a200Fix(); }   // not in the default run: three more real-model flows (a batch of two tasks and a run with a fix round) double its time
  else {
    await pass('hermetic');
    if (only === 'a202') { /* only the hermetic batch step */ } else if ((env.SMOKE_RTK || 'auto') !== 'no' && have('rtk')) { smokeUserSettings = 'yes'; await pass('rtk'); } else row('rtk pass', 'SKIP', 0, "rtk is not installed here; the pass with the user's settings is skipped");
  }
  skillDetourRow();

  const version = (/"version": "([^"]*)"/.exec(readOr(path.join(repo, '.claude-plugin/plugin.json'))) ?? [])[1] ?? '';
  process.stdout.write(renderTable(model, version, rows));
  if (env.SMOKE_KEEP === '1') console.log(`kept: ${work}`);
  if (fails > 0) { console.log(`smoke: ${fails} step(s) FAILED`); return 1; }
  console.log('smoke: all steps PASS');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

/** For tests only: point the row helpers at a synthetic project, origin and work folder, and read the rows they wrote. @param {string} p @param {string} o @param {string} w */
export function testState(p, o, w) { P = p; ORIGIN = o; work = w; rows.length = 0; fails = 0; return rows; }
export { a202StatusRow, a202BranchRow, codexConfigCommit, codexDispatchSeen, fixtureCommands };
