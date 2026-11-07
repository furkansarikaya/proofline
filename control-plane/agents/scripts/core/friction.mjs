// @ts-check
// Friction report and calibration suggestions (A149; A229: the former scripts/friction.sh). Run through `agent.sh friction ...` / `agent.sh calibrate`.
//   friction report <ID>   build .agents/local/friction/latest.md (and <ID>.md) from the run's LEDGER.log, HOOKS.log and the metrics records (called when a run
//                          ends); counts only, anonymous, validated before it is written
//   friction show [ID]     print the report
//   friction issue-cmd     print the `gh issue create` command a send would run; runs nothing
//   friction send          lead only: consume the user's `report` approval (bound to the report's sha256), then run that command. Without the approval nothing is
//                          sent and gh is never started.
//   calibrate              print config suggestions from metrics and plans. Read-only: it never edits a file.
// The report holds counts and controlled identifiers only (roles, gates, runtimes, models). It never holds the run id, a path, a name or free text, and a scrub
// check refuses to write it if a line has a character outside a small set or mentions the project directory, the git user, the git email or $USER.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { approvalConsume, planTestAcs, requireLead } from './approve.mjs';
import { ProoflineError } from './errors.mjs';
import { withCommandLocks } from './lessons.mjs';
import { isFile } from './paths.mjs';
import { asciiLower } from './shellglob.mjs';
import * as proc from './proc.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const REPO = 'furkansarikaya/proofline';

/** @param {string} p */
function readText(p) { try { return readFileSync(p, 'latin1'); } catch { return ''; } }
/** `w()` of the report: only letters, digits and _.+:- stay. @param {string} s */
const w = (s) => s.replace(/[^A-Za-z0-9_.+:-]/g, '');
/** @param {Context} ctx */
const outDir = (ctx) => `${ctx.sharedMain()}/.agents/local/friction`;
/** @param {Context} ctx */
const recordsFile = (ctx) => `${ctx.sharedMain()}/.agents/local/metrics/records.jsonl`;

/** The value of KEY in a JSON line without parsing it: from `"KEY":` to the first `,` or `}`. @param {string} s @param {string} k @param {boolean} unquote */
function jv(s, k, unquote) {
  const p = `"${k}":`;
  const i = s.indexOf(p);
  if (i < 0) return '';
  let r = s.slice(i + p.length);
  const c = r.search(/[,}]/);
  if (c >= 0) r = r.slice(0, c);
  return unquote ? r.replace(/"/g, '') : r;
}
/** @param {string} text @returns {string[]} */
const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
/** awk's numeric value of a string: its leading number, else 0. @param {string} s */
const num = (s) => { const n = parseFloat(s); return Number.isNaN(n) ? 0 : n; };

/** The counts of the ledger (and HOOKS.log) lines. @param {string[]} ledger @returns {string} */
function ledgerPart(ledger) {
  let cls = ''; let ask = 0; let au = 0; let al = 0; let ar = 0; let hruns = 0; let htot = 0; let hmax = 0; let hto = 0; let fnb = 0; let fnt = 0;
  let term = ''; let done = false; let fo = 0; let fot = 0; let gft = 0; let blt = 0;
  /** @type {Map<string, number>} */ const fnk = new Map(); /** @type {Map<string, number>} */ const gf = new Map(); /** @type {Map<string, number>} */ const bl = new Map();
  const bump = (/** @type {Map<string, number>} */ m, /** @type {string} */ k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const l of ledger) {
    if (l.includes(' event=classify ')) cls = w(l.replace(/^.* detail=/, '').replace(/ .*$/, ''));
    if (l.includes(' event=ask ')) ask++;
    if (l.includes(' event=answer ')) { if (l.includes('answered_by=user')) au++; else al++; }
    if (l.includes(' event=approval-request ')) ar++;
    if (l.includes(' event=hook ')) {
      const hn = l.replace(/^.* detail=name=[^ ]* runs=/, '');
      const hr = hn.replace(/ .*$/, '');
      const ht = hn.replace(/^.*total_ms=/, '').replace(/ .*$/, '');
      const hm = hn.replace(/^.*max_ms=/, '').replace(/ .*$/, '');
      if (/^[0-9]+$/.test(hr)) { hruns += Number(hr); htot += num(ht); if (num(hm) > hmax) hmax = num(hm); }
    }
    if (l.includes(' event=hook-timeout ')) hto++;
    if (l.includes(' event=friction-note ')) {
      const fnd = w(l.replace(/^.* detail=/, '').replace(/ .*$/, ''));
      bump(fnk, fnd);
      if (fnd === 'proofline_bug') fnb++; else fnt++;
    }
    if (l.includes(' event=terminate ')) term = w(l.replace(/^.* to=/, '').replace(/ .*$/, ''));
    if (l.includes(' event=handoff:DONE ')) done = true;
    if (/ event=note .*failover/.test(l)) { fo++; if (l.includes('reason=timeout')) fot++; }
    const g = / event=gate:([A-Z_]+):fail /.exec(l);
    if (g) { bump(gf, w(/** @type {string} */ (g[1]))); gft++; }
    const b = / event=record:([a-z_]+):BLOCKED /.exec(l);
    if (b) { bump(bl, w(/** @type {string} */ (b[1]))); blt++; }
  }
  const sorted = (/** @type {Map<string, number>} */ m) => [...m.keys()].sort();
  let o = `outcome: ${done ? 'done' : term !== '' ? asciiLower(term) : 'open'}\nclassification: ${cls !== '' ? cls : 'unknown'}\n\n`;
  o += `## User interruptions\n\n- questions asked: ${ask} (answered by the user: ${au}, by an assumption: ${al})\n- approval requests: ${ar}\n- total times the user was asked: ${ask + ar}\n`;
  o += `- times the user was asked to run a command (a proofline bug): ${fnt}\n`;
  o += `- proofline failures the lead worked around (proofline_bug): ${fnb}\n`;
  for (const k of sorted(fnk)) o += `  - ${k}: ${fnk.get(k)} times\n`;
  o += '\n';
  o += `## Blocked and failed gates\n\n- gate failures: ${gft}\n`;
  for (const k of sorted(gf)) o += `  - gate ${k} failed ${gf.get(k)} times\n`;
  o += `- steps that returned blocked: ${blt}\n`;
  for (const k of sorted(bl)) o += `  - role ${k} blocked ${bl.get(k)} times\n`;
  o += `\n## Timeouts\n\n- runtime failovers: ${fo} (of them by timeout: ${fot})\n`;
  o += `- hook timeouts: ${hto} (of ${hruns} recorded hook runs; total hook time ${Math.trunc(htot)} ms, slowest ${Math.trunc(hmax)} ms)\n`;
  return o;
}

/** The metrics part: dispatches, rounds, cost and tokens of the run. @param {string[]} rec @param {string} id */
function recordsPart(rec, id) {
  const key = `"task":"${id}"`;
  let nd = 0; let dt = 0; let seen = false; let fr = ''; let de = ''; let du = '';
  for (const l of rec) {
    if (!l.includes(key)) continue;
    const k = jv(l, 'kind', true); const r = jv(l, 'result', true);
    if (k === 'dispatch') { nd++; if (r === 'timeout') dt++; }
    if (k === 'run' && !seen) { seen = true; fr = jv(l, 'fix_rounds', true); de = jv(l, 'delegations', true); du = jv(l, 'duration_s', true); }
  }
  const d = (/** @type {string} */ x) => (/^[0-9]+$/.test(x) ? x : 'unknown');
  let o = `- dispatch timeouts: ${dt} (of ${nd} dispatches)\n\n## Repeated rounds\n\n- fix rounds used: ${d(fr)}\n- delegated steps: ${d(de)}\n\n## Cost\n\n- run duration seconds: ${d(du)}\n`;
  // tokens: the sum of the non-null integers over the records of the run that are not the run record, with how many records reported
  const keys = ['tokens_in', 'tokens_out', 'tokens_total'];
  const sum = [0, 0, 0]; const cnt = [0, 0, 0]; let n = 0;
  for (const l of rec) {
    if (!l.includes(key) || jv(l, 'kind', false) === '"run"') continue;
    n++;
    keys.forEach((k, j) => { const v = jv(l, k, false); if (/^[0-9]+$/.test(v)) { sum[j] = /** @type {number} */ (sum[j]) + Number(v); cnt[j] = /** @type {number} */ (cnt[j]) + 1; } });
  }
  const t = (/** @type {number} */ j) => (/** @type {number} */ (cnt[j]) > 0 ? `${sum[j]} (${cnt[j]} of ${n} records)` : 'unknown');
  o += `- tokens in: ${t(0)}\n- tokens out: ${t(1)}\n- tokens total: ${t(2)}\n`;
  return o;
}

/** `scrub FILE-TEXT`: a message when the report is not safe to share, else ''. @param {Context} ctx @param {string} text */
function scrub(ctx, text) {
  const ls = text.split('\n');
  for (let i = 0; i < ls.length; i++) {
    const l = /** @type {string} */ (ls[i]);
    if (i === ls.length - 1 && l === '') break;
    if (!/^[A-Za-z0-9 _.:,;=()%+<>#*|-]*$/.test(l)) return `friction: line ${i + 1}:${l} has a character outside the allowed set`;
  }
  const git = (/** @type {string} */ k) => proc.run('git', ['-C', ctx.root, 'config', k], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString('latin1').replace(/\n+$/, '');
  const hay = asciiLower(text.replace(/proofline/g, ''));   // the word "proofline" is the report's own header, not the project name
  for (const word of [path.basename(ctx.root), git('user.name'), git('user.email'), ctx.env.USER ?? '']) {
    if (word.length < 4) continue;
    if (hay.includes(asciiLower(word))) return 'friction: the report mentions the project directory, the git identity or the user name; not written';
  }
  return '';
}

/** `friction report ID`. @param {Context} ctx @param {string} id */
export function frictionReport(ctx, id) {
  if (id === '' || /[^A-Za-z0-9_-]/.test(id)) { ctx.err('usage: agent.sh friction report <ID>\n'); return 2; }
  const led = `${ctx.root}/.agents/runs/${id}/LEDGER.log`;
  const hk = `${ctx.root}/.agents/runs/${id}/HOOKS.log`;
  if (!isFile(led)) { ctx.err('friction: no ledger for the run\n'); return 1; }
  const metricsOn = (ctx.config().getRaw('metrics') ?? 'on') !== 'off';
  const rec = metricsOn ? lines(readText(recordsFile(ctx))) : [];
  // A203: the hook timings live in HOOKS.log (not in the ledger); an older run's hook lines are still in the ledger
  const ledger = [...lines(readText(led)), ...(isFile(hk) ? lines(readText(hk)) : [])];
  const text = `# proofline friction report\n\nschema: proofline.friction.v1\n\n${ledgerPart(ledger)}${recordsPart(rec, id)}`;
  const bad = scrub(ctx, text);
  if (bad !== '') { ctx.err(`${bad}\n`); return 1; }
  // A203: one file per run (a later run no longer replaces an earlier run's report); latest.md stays the one `show`, `send` and the approval use
  if (id === 'latest') { ctx.err('friction: a run cannot be called latest\n'); return 1; }
  const out = outDir(ctx);
  try {
    mkdirSync(out, { recursive: true });
    const tmp = `${out}/.latest.${process.pid}`;
    writeFileSync(tmp, Buffer.from(text, 'latin1'));
    copyFileSync(tmp, `${out}/${id}.md`);
    renameSync(tmp, `${out}/latest.md`);
  } catch { return 1; }
  ctx.out(`friction report: .agents/local/friction/latest.md and .agents/local/friction/${id}.md (review it; sending needs your approval)\n`);
  return 0;
}

/** The report text for `show` (and the night-mode status): the file's bytes, or null when there is none. @param {Context} ctx @param {string} [id] */
export function frictionShowText(ctx, id = '') {
  const f = `${outDir(ctx)}/${id === '' ? 'latest' : id}.md`;
  return isFile(f) ? readText(f) : null;
}

/** The `gh issue create` command a send would run (without the program name for the child). */
const ISSUE_ARGS = ['issue', 'create', '--repo', REPO, '--title', 'proofline friction report', '--body-file', '.agents/local/friction/latest.md'];

/** @param {Context} ctx */
function send(ctx) {
  if (ctx.role !== 'lead') { ctx.err('friction: only the lead sends\n'); return 2; }
  const latest = `${outDir(ctx)}/latest.md`;
  if (!isFile(latest)) { ctx.err('friction: no report yet\n'); return 1; }
  const bad = scrub(ctx, readText(latest));
  if (bad !== '') { ctx.err(`${bad}\n`); return 1; }
  const mark = ctx.chunks.length;
  try { withCommandLocks(ctx, 'approval-consume', ['-', 'report'], () => approvalConsume(ctx, ['-', 'report'])); } catch (e) {
    if (!(e instanceof ProoflineError)) throw e;
    ctx.err(`${e.message}\n`);
    ctx.err('friction: nothing sent. Ask the user: agent.sh request-approval - report (relay it verbatim)\n');
    return 1;
  }
  ctx.chunks.length = mark;
  // the command issue-cmd prints, run from the project root of the main tree
  const r = proc.run('gh', ISSUE_ARGS, { cwd: ctx.sharedMain(), env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  if (!r.started) { ctx.err('friction: gh is not installed or not on PATH; nothing was sent\n'); return 127; }
  ctx.out(r.stdout.toString('latin1')); ctx.err(r.stderr.toString('latin1'));
  return r.status;
}

/** `friction <report ID|show [ID]|issue-cmd|send>`. @param {Context} ctx @param {string[]} args */
export function frictionCommand(ctx, args) {
  const op = args[0] ?? '';
  switch (op) {
    case 'report': requireLead(ctx); return frictionReport(ctx, args[1] ?? '');
    case 'show': {
      const id = args[1] ?? '';
      if (/[^A-Za-z0-9_-]/.test(id)) { ctx.err('usage: agent.sh friction show [ID]\n'); return 2; }
      const t = frictionShowText(ctx, id === 'latest' ? '' : id);
      if (t === null) { ctx.err('friction: no report yet\n'); return 1; }
      ctx.out(t);
      return 0;
    }
    case 'issue-cmd':
      if (!isFile(`${outDir(ctx)}/latest.md`)) { ctx.err('friction: no report yet\n'); return 1; }
      ctx.out(`gh issue create --repo ${REPO} --title "proofline friction report" --body-file .agents/local/friction/latest.md\n`);
      return 0;
    case 'send': requireLead(ctx); return send(ctx);
    default:
      ctx.err('usage: agent.sh friction <report ID|show [ID]|issue-cmd|send>\n');
      return 2;
  }
}

/** `calibrate`: config suggestions from metrics and plans; it never edits a file. @param {Context} ctx */
export function calibrate(ctx) {
  const cfgv = (/** @type {string} */ k, /** @type {number} */ def) => { const v = ctx.config().getRaw(k); return v !== null && /^[0-9]+$/.test(v) ? Number(v) : def; };
  const bud = cfgv('test_trust.mutation_budget', 20); const to = cfgv('dispatch.timeout_seconds', 5400); const mfr = cfgv('review.max_fix_rounds', 2);
  let runs = 0; let maxn = 0;
  /** @type {string[]} */ let names = [];
  try { names = readdirSync(`${ctx.root}/.agents/runs`).sort(); } catch { names = []; }
  for (const r of names) {
    const p = `${ctx.root}/.agents/runs/${r}/PLAN.md`;
    if (!isFile(p)) continue;
    const n = planTestAcs(readText(p));
    runs++; if (n > maxn) maxn = n;
  }
  const rec = recordsFile(ctx);
  let s = false;
  ctx.out('calibration suggestions (read-only; nothing was changed, edit .agents/config.yaml yourself if you agree)\n');
  ctx.out(`seen: ${runs} plans, most criteria in one plan: ${maxn}; test_trust.mutation_budget: ${bud}\n`);
  if (maxn > bud) { s = true; ctx.out(`suggest: test_trust.mutation_budget ${maxn} (a plan names ${maxn} criteria, one mutant each is the minimum; today that costs an approval per run)\n`); }
  else if (maxn > 0 && bud > maxn * 2) { s = true; ctx.out(`suggest: test_trust.mutation_budget ${maxn + Math.floor(maxn / 2)} (the budget is more than twice the largest plan; a lower budget shortens the mutation step)\n`); }
  if (isFile(rec)) {
    const ls = lines(readText(rec));
    let m = 0; let t = 0; let ex = 0;
    for (const l of ls) {
      if (l.includes('"kind":"dispatch"')) { const d = num(jv(l, 'duration_s', false)); if (d > m) m = d; if (jv(l, 'result', false) === '"timeout"') t++; }
      if (l.includes('"kind":"run"') && num(jv(l, 'fix_rounds', false)) >= mfr) ex++;
    }
    m = Math.trunc(m);
    if (m >= Math.floor((to * 8) / 10) || t > 0) { s = true; ctx.out(`suggest: dispatch.timeout_seconds ${to * 2} (slowest dispatch ${m}s of ${to}s, timeouts ${t}); or one multiplier for every limit: proofline doctor --scale\n`); }
    if (ex >= 2) { s = true; ctx.out(`suggest: review.max_fix_rounds is reached by ${ex} runs; read their repeated findings (proofline insights) before raising ${mfr}\n`); }
  } else ctx.out('no metrics recorded: timeout and fix-round checks skipped\n');
  if (!s) ctx.out('no change suggested\n');
  return 0;
}
