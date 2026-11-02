// @ts-check
// The status block (A202): the one live status of a task, updated in place. The content is written from RECORDED state only (RUN.yaml, the
// ledger, the questions, the delivery records, the metrics records, the batch state); the three recorded reasons (a question, a park, a failure)
// go through `scrub`, an allowlist. The adapter op `statusblock` (a task adapter script, run as a child) places it. The update is best effort:
// bounded in time, it never fails a run or a gate, an unreachable tracker is a logged note.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bytes } from './config.mjs';
import { now } from './clock.mjs';
import { ProoflineError } from './errors.mjs';
import { git } from './git.mjs';
import { humanChecks } from './taskfile.mjs';
import { isFile } from './paths.mjs';
import { asciiLower } from './shellglob.mjs';
import * as proc from './proc.mjs';
import { fileLines, fileText, sectionValue, textLines, validTaskId } from './records.mjs';
import { runDir } from './runs.mjs';
import { knownIssueFacts, knownIssuesListed } from './knownissues.mjs';
import { tmScaled } from './timeouts.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The word after a credential word is redacted. */
const CRED = /^(password|passwd|secret|token|apikey|api_key|bearer|authorization|credential|credentials)s?:?$/;

/**
 * `sb_scrub`: any text to one safe line. IPv4 and IPv6 addresses are replaced first; a word with a slash, a backslash, a leading ~, a drive letter,
 * an at sign, an `=`, a known key prefix, a word over 40 characters or 24+ letters-and-digits is replaced; a word naming a credential redacts the word after
 * it; only letters, digits and `. _ % + - ! ? & #` remain; 160 characters at most.
 * @param {string} text a byte string
 */
export function scrub(text) {
  let s = text.replace(/[^\x20-\x7e]/g, ' ')
    .replace(/[0-9]{1,3}(\.[0-9]{1,3}){3}/g, 'REDACTEDX')
    .replace(/([0-9A-Fa-f]{0,4}:){3,}[0-9A-Fa-f]{0,4}/g, 'REDACTEDX')
    .replace(/[Ff][Ee]80::[0-9A-Fa-f:]*/g, 'REDACTEDX');
  s = s.replace(/[<>`|()[\]{}"',;:]/g, ' ');
  let out = '';
  let nx = false;
  for (let t of s.split(/[ \t\n\v\f\r]+/).filter((w) => w !== '')) {
    if (nx) { nx = false; t = '[redacted]'; }
    else if (t.includes('REDACTEDX') || t.length > 40) t = '[redacted]';
    else if (/[/\\]/.test(t) || t.startsWith('~') || /^[A-Za-z]:/.test(t)) t = '[path]';
    else if (t.includes('@') || t.includes('=')) t = '[redacted]';
    else if (/^(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|sk-|sk_|pk_|rk_|AKIA|xox|AIza|eyJ)/.test(t) || t.includes('BEGIN') || /_(live|test)_/.test(t)) t = '[redacted]';
    else if (t.length >= 24 && /[0-9]/.test(t) && /[A-Za-z]/.test(t)) t = '[redacted]';
    else if (CRED.test(asciiLower(t))) { t = t.replace(/:$/, ''); nx = true; }
    if (t !== '[redacted]' && t !== '[path]') t = t.replace(/[^A-Za-z0-9._%+!?&#-]/g, '');
    if (t === '') continue;
    out += (out === '' ? '' : ' ') + t;
  }
  return out.slice(0, 160);
}

/** `sb_pr_link N`: the pull request address, only for a github.com origin. @param {Context} ctx @param {string} n */
function prLink(ctx, n) {
  const r = git(ctx, ['remote', 'get-url', 'origin']);
  if (r.status !== 0) return '';
  const u = r.out.replace(/\n+$/, '');
  let p;
  if (u.startsWith('https://github.com/') && u.slice(19).includes('/')) p = u.slice(19);
  else if (u.startsWith('git@github.com:') && u.slice(15).includes('/')) p = u.slice(15);
  else if (u.startsWith('ssh://git@github.com/') && u.slice(21).includes('/')) p = u.slice(21);
  else return '';
  p = p.replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p)) return '';
  return `https://github.com/${p}/pull/${n}`;
}

/** `tr -cd KEEP | cut -c1-N` @param {string} s @param {RegExp} drop @param {number} n */
const keep = (s, drop, n) => s.replace(drop, '').slice(0, n);

/** The task type of a TASK.md for the block (front matter `type:` or `**Type:**`). @param {string} text */
function blockType(text) {
  let fm = false; let seen = false;
  const lines = textLines(text);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (i === 0 && l !== '---' && /^# /.test(l)) continue;
    if (/^---[ \t\n\v\f\r]*$/.test(l)) { fm = !fm; if (!fm && seen) return ''; seen = true; continue; }
    if (fm && l.startsWith('type:')) return asciiLower(l.replace(/^type:[ \t]*/, '').replace(/["']/g, '')).replace(/[ \r]/g, '');
    if (l.startsWith('**Type:**')) return asciiLower(l.replace(/^\*\*Type:\*\*[ \t]*/, '')).replace(/[ \r]/g, '');
  }
  return '';
}

/** `task_size_of ID`: front matter `size:` of the frozen TASK.md. @param {string} text */
function sizeOf(text) {
  let fm = false; let seen = false;
  for (const l of textLines(text)) {
    if (/^---[ \t\n\v\f\r]*$/.test(l)) { fm = !fm; if (!fm && seen) return ''; seen = true; continue; }
    if (fm && l.startsWith('size:')) return keep(l.replace(/^size:[ \t]*/, ''), /[^A-Za-z0-9 ._-]/g, 16);
  }
  return '';
}

/**
 * `status_block_body ID EVENT [PR]`: the block lines (`- key: value`).
 * @param {Context} ctx @param {string} id @param {string} event0 @param {string} prArg @returns {string}
 */
export function statusBlockBody(ctx, id, event0, prArg) {
  const dir = runDir(ctx, id);
  const has = isFile(`${dir}/RUN.yaml`);
  const ev = ['run-start', 'ask', 'answer', 'parked', 'unparked', 'code-done', 'pr-opened', 'merged', 'failed'].includes(event0) ? event0 : 'update';
  let out = '';
  const kv = (/** @type {string} */ k, /** @type {string} */ v) => { out += `- ${k}: ${v}\n`; };
  const sv = (/** @type {string} */ s, /** @type {string} */ k) => sectionValue(ctx, dir, s, k);
  kv('run', id);
  if (has) {
    const type = blockType(fileText(ctx, `${dir}/TASK.md`) ?? '');
    if (['feature', 'bug', 'refactor', 'content', 'docs', 'chore'].includes(type)) kv('type', type);
    const c = sv('pipeline', 'classification');
    if (['TRIVIAL', 'STANDARD', 'COMPLEX', 'CRITICAL'].includes(c)) kv('class', c);
  }
  let park = '';
  for (const l of fileLines(ctx, `${ctx.sharedMain()}/.agents/local/batch/state.tsv`)) {
    const f = l.split('\t');
    if (f[0] === id && f[1] === 'parked') { park = f[2] ?? ''; break; }
  }
  let state = 'PLANNING'; let hs = 'PLANNED'; let wait = false;
  if (has) { state = sv('execution', 'state'); hs = sv('handoff', 'state'); wait = sv('execution', 'awaiting_input') === 'true'; }
  let stage;
  if (ev === 'failed' || state === 'FAILED' || state === 'BLOCKED') stage = `PARKED (${state})`;
  else if (ev === 'pr-opened') stage = 'PR OPEN (waiting for the merge)';
  else if (ev === 'merged') stage = 'MERGED';
  else if (wait) stage = 'PARKED (waiting for your answer)';
  else if (park !== '') stage = 'PARKED (by the lead)';
  else if (!has) stage = 'NOT STARTED';
  else if (hs === 'CODE_DONE' || hs === 'DONE') stage = 'CODE_DONE (delivery next)';
  else stage = `RUNNING (${state}, handoff ${hs})`;
  kv('stage', stage); kv('event', ev); kv('updated', now().iso);
  if (has) {
    const b = keep(sv('repository', 'task_branch'), /[^A-Za-z0-9._/-]/g, 120);
    if (b !== '' && b !== 'PENDING') kv('branch', b);
    const sha = keep(sv('repository', 'base_sha'), /[^0-9a-f]/g, 12);
    if (sha.length >= 7) kv('start_commit', sha);
    kv('runtime', keep(ctx.config().get('runtime.lead', 'claude'), /[^A-Za-z0-9._-]/g, 32));
    const e = ctx.env;
    const sess = keep(e.CLAUDE_CODE_SESSION_ID || e.CODEX_SESSION_ID || e.CODEX_THREAD_ID || '', /[^A-Za-z0-9_-]/g, 64);
    if (sess !== '') kv('session', sess);
  }
  if (wait) {
    let q = ''; let qn = '';
    let names = [];
    try { names = readdirSync(`${dir}/questions`).filter((n) => /^[0-9]{3}\.md$/.test(n)).sort(); } catch { /* none */ }
    for (const n of names) {
      if (isFile(`${dir}/questions/${n.slice(0, -3)}.answer.md`)) continue;
      qn = n.slice(0, -3);
      const first = fileLines(ctx, `${dir}/questions/${n}`).find((l) => /^[0-9]+\. [^ \t\n\v\f\r]/.test(l));
      q = first === undefined ? '' : scrub(first);
    }
    kv('question', `${qn !== '' ? `#${qn} ` : ''}${q !== '' ? q : 'pending'}`);
    kv('answer', 'answer in your next message in the session; the prompt hook records it when it matches an accepted form');
  }
  if (has && knownIssuesListed(ctx)) {
    const ki = knownIssueFacts(ctx, id).map((x) => { const [a, b, c] = x.split(':'); return `${a} (${b}, follow-up ${c})`; }).join(', ').replace(/[^A-Za-z0-9 ._(),-]/g, '');
    if (ki !== '') kv('known_issues', ki);
  }
  if (park !== '') kv('park', scrub(park));
  if (state === 'FAILED' || state === 'BLOCKED') {
    let fr = '';
    const terms = fileLines(ctx, `${dir}/LEDGER.log`).filter((l) => l.includes(' event=terminate '));
    const m = terms.length > 0 ? /^.* detail=reason: (.*); evidence: .*$/.exec(terms[terms.length - 1]) : null;
    if (m) fr = scrub(m[1]);
    kv('failure', `${state}${fr !== '' ? `: ${fr}` : ''}`);
  }
  const dd = `${ctx.root}/.agents/local/deliver/${id}`;
  let pr = prArg;
  if (pr === '') pr = (fileText(ctx, `${dd}/PR`) ?? '').split('\n')[0];
  if (!/^[0-9]+$/.test(pr)) pr = '';
  if (ev === 'pr-opened' || ev === 'merged') {
    if (pr !== '') { const lk = prLink(ctx, pr); kv('pr', `#${pr}${lk !== '' ? ` ${lk}` : ''}`); }
    const ci = fileLines(ctx, `${dd}/SUMMARY.md`).find((l) => l.startsWith('ci: '));
    const cis = ci === undefined ? '' : scrub(ci.slice(4));
    if (cis !== '') kv('ci', cis);
  }
  if (ev === 'merged') {
    const r = git(ctx, ['rev-parse', '-q', '--verify', 'HEAD']);
    const mc = r.status === 0 ? keep(r.out, /[^0-9a-f]/g, 12) : '';
    if (mc.length >= 7) kv('delivered_commit', mc);
  }
  if (has) {
    const sz = sizeOf(fileText(ctx, `${dir}/TASK.md`) ?? '');
    if (sz !== '') kv('estimate', `size ${sz}`);
    const first = fileLines(ctx, `${dir}/LEDGER.log`)[0];
    const t0 = first === undefined ? null : /.* epoch=([0-9]*) .*/.exec(first);
    if (t0 && t0[1] !== '') { const s = now().epoch - Number(t0[1]); if (s >= 0) kv('duration', `${Math.floor(s / 60)} min`); }
    let s = 0; let d = 0;
    const want = `"task":"${id}"`;
    for (const l of textLines(readJsonl(`${ctx.sharedMain()}/.agents/local/metrics/records.jsonl`))) {
      if (!l.includes(want)) continue;
      const m = /"tokens_total":([0-9]+)/.exec(l);
      if (!m) continue;
      if (l.includes('"kind":"step"')) s += Number(m[1]); else if (l.includes('"kind":"dispatch"')) d += Number(m[1]);
    }
    const tk = s > 0 ? s : d > 0 ? d : 0;
    if (tk > 0) kv('tokens', String(tk));
    const qa = fileText(ctx, `${dir}/QA_REPORT.md`);
    if (qa !== null) for (const h of humanChecks(qa)) { if (h !== '') kv('look_at', scrub(h)); }
  }
  return out;
}

/** @param {string} f */
function readJsonl(f) { try { return readFileSync(f, 'latin1'); } catch { return ''; } }

/**
 * `status_block_run ID EVENT [PR]`: build the block and hand it to the configured adapter. Returns null on success, else the failure text.
 * @param {Context} ctx @param {string} id @param {string} event @param {string} pr @param {number} seconds
 * @returns {string | null}
 */
function run(ctx, id, event, pr, seconds) {
  if (!validTaskId(id)) return 'invalid task id';
  const adapter = ctx.config().get('tasks.adapter', 'markdown');
  const script = `${ctx.agents}/task-integrations/${adapter}.sh`;
  if (!isFile(script)) return `unknown task-integration adapter: ${adapter}`;
  const tmp = mkdtempSync(`${tmpdir()}/agent-status-block.`);
  try {
    const file = `${tmp}/block`;
    writeFileSync(file, Buffer.from(statusBlockBody(ctx, id, event, pr), 'latin1'));
    const r = proc.run('sh', [script, 'statusblock', id, file], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'pipe'], timeoutMs: seconds * 1000 });
    if (r.status === 0) return null;
    // a child stopped by the time bound ends with a signal (128 + n)
    return r.status > 128 && r.stderr.length === 0 ? `timed out after ${seconds}s` : r.stderr.toString('latin1');
  } catch (e) {
    return e instanceof ProoflineError ? e.message : `${e}`;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * `status_block_update ID EVENT [PR]`: the lifecycle hook. Best effort in every way (it never throws for the adapter or the records), bounded in
 * time (tasks.status_block_seconds, default 20, scaled), a note in .agents/local/status-block.log. `tasks.status_block: off` switches it off.
 * @param {Context} ctx @param {string} id @param {string} event @param {string} [pr]
 */
export function statusBlockUpdate(ctx, id, event, pr = '') {
  const cfg = ctx.config();
  if (cfg.get('tasks.status_block', 'on') === 'off') return;
  let max = cfg.get('tasks.status_block_seconds', '20');
  if (!/^[0-9]+$/.test(max)) max = '20';
  let n = Number(max.replace(/^0+(?=[^])/, ''));
  if (n < 1) n = 1;
  if (n > 300) n = 300;
  n = tmScaled(cfg, n, 1, 900);
  const failure = run(ctx, id, event, pr, n);
  if (failure === null) return;
  const msg = scrub(failure.split('\n').slice(0, 3).join(' '));
  ctx.err(`note: the status block of ${id} was not updated (${event}): ${msg !== '' ? msg : 'the adapter failed'}; the run goes on\n`);
  try {
    const log = `${ctx.sharedMain()}/.agents/local/status-block.log`;
    mkdirSync(`${ctx.sharedMain()}/.agents/local`, { recursive: true });
    appendFileSync(log, `${now().iso} ${id} ${event} ${msg !== '' ? msg : 'failed'}\n`);
  } catch { /* best effort */ }
}

/** `status-block ID [EVENT [PR]]` (lead). @param {Context} ctx @param {string[]} args */
export function statusBlockCommand(ctx, args) {
  if (ctx.role !== 'lead') throw new ProoflineError(`command denied for ${ctx.role} (lead only)`, 1);
  const id = bytes(args[0] ?? '');
  if (!validTaskId(id)) throw new ProoflineError('usage: agent.sh status-block <ID> [EVENT]', 1);
  statusBlockUpdate(ctx, id, args[1] === undefined || args[1] === '' ? 'update' : bytes(args[1]), bytes(args[2] ?? ''));
  return 0;
}
