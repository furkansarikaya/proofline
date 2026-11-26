// @ts-check
// `proofline retro [<batch-id|run-id>] [--since YYYY-MM-DD] [--json] [--full]` (A370; issue 338 U8 = R1-18, R2-19, R3-14, R4-12): a read-only report of finished runs, read from their records. Four analysts read
// the same files by hand with 10 to 45 tool calls each; this reads them once. Sources: the ledger of each run (the live `.agents/runs/<ID>/LEDGER.log`, else the newest run archive, read IN PROCESS by core/tarlite.mjs:
// no `tar` program, no extraction, nothing written), `.agents/local/metrics/records.jsonl` and `tools.jsonl`, and the `batch/*.tsv` files (also under `batch/history/<batch id>/`).
// Rules: informational counts only (no verdict, no score, no estimate); every number comes from a record, and a number that cannot be derived is printed as `not recorded`; a source that could not be read is listed
// under `not read`, never guessed; no excerpt of a record is printed (ids, kinds and numbers only, every identifier reduced to `[A-Za-z0-9._+:-]`), so no secret in a record can reach the report.
// Time (all from ledger `epoch=` values; no clock is read): task time = first to last ledger event of the run; first pass = start to the first rework row (`handoff:IMPLEMENTING fix_round=N` or `REOPEN`); rework = that row
// to the last gate or `handoff:IMPLEMENTED` row after it (the last event when none follows); after the last gate = the rest (knowledge, report, delivery). User waits sit inside those windows and are listed apart.
// Tokens: the `step` and `lead` records (a resumed agent was counted once by the log delta, A363); a `dispatch` record only for a role that has no step tokens, so the same step is never summed twice.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { requireInstalled } from './doctor.mjs';
import { ProoflineError } from './errors.mjs';
import { parseLedgerLine } from './records.mjs';
import { asciiLower } from './shellglob.mjs';
import { TAR_LIMITS, readTarGz } from './tarlite.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const USAGE = 'usage: proofline retro [<batch-id|run-id>] [--since YYYY-MM-DD] [--json] [--full]';
const MAX_TEXT = 64 * 1024 * 1024;
const MAX_LIST = 20;
const DEFAULT_CAP = 6000;
const MIN_CAP = 200;
/** @param {string} msg */
const die = (msg) => new ProoflineError(`proofline: ${msg}`, 1);
/** @param {string} s */
const id = (s) => s.replace(/[^A-Za-z0-9._+:-]/g, '_').slice(0, 64);
/** The words a record may carry, as the control plane writes them. Any other word prints as `other`, so a token-like text in a ledger detail or a record can never reach the report. */
const GATES = new Set(['SECRETS', 'REVIEW_SMALL', 'REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'REVIEW_DATA', 'SECURITY', 'QA', 'VERIFY', 'REOPEN']);
const FRICTION = new Set(['user-command', 'user-shell', 'proofline_bug']);
const APPROVALS = new Set(['plan', 'destructive', 'single_step', 'scope', 'budget', 'mutation_budget', 'tree', 'commit', 'push', 'pr', 'merge', 'cleanup', 'report', 'batch', 'commands', 'rename', 'known-issue', 'scale', 'waive', 'rule', 'reopen', 'rationale']);
const CLASSES = new Set(['TRIVIAL', 'SMALL', 'STANDARD', 'COMPLEX', 'CRITICAL']);
const ROLES = new Set(['lead', 'architect', 'data_architect', 'designer', 'explorer', 'implementer', 'qa', 'reviewer', 'security_reviewer', 'task_author', 'verifier', 'n/a']);
const OUTCOMES = new Set(['done', 'failed', 'blocked', 'open', 'terminated']);
/** @param {Set<string>} set @param {string} v */
const only = (set, v) => (set.has(v) ? v : 'other');
/** A denial class is fixed lower-case prose (A363): plain words, an optional number, or `no-reason`. */
const denialClass = (/** @type {string} */ k) => (/^([a-z]+( [a-z]+){0,7}( [0-9]+)?|no-reason|other)$/.test(k) && k.length <= 64 ? k : 'other');
/** The file name of an archive as `cleanup` writes it (`<ID>-<stamp>.tar.gz`); another name is not repeated. @param {string} a */
const archiveName = (a) => (/^[A-Za-z0-9_-]+-[0-9]{8}T[0-9]{6}Z\.tar\.gz$/.test(a) ? a : 'with an unexpected name');
const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
const mins = (/** @type {number} */ s) => (s / 60).toFixed(1);
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isId = (/** @type {string} */ s) => /^[A-Za-z0-9_-]+$/.test(s) && s.length <= 128;

/** A plain file read as bytes (latin1), bounded; never a link, never a fifo. @param {string} file @returns {{ text: string | null, why: string }} */
function readBounded(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return { text: null, why: 'not-a-file' };
    if (st.size > MAX_TEXT) return { text: null, why: 'too-large' };
    return { text: readFileSync(file, 'latin1'), why: '' };
  } catch (e) { return { text: null, why: /** @type {{ code?: string }} */ (e).code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}
/** @param {string} dir @returns {string[]} */
function names(dir) { try { return readdirSync(dir).sort(cmp); } catch { return []; } }
/** @param {string} text @returns {string[][]} */
const tsv = (text) => text.split('\n').filter((l) => l !== '').map((l) => l.split('\t'));

/**
 * @typedef {object} Rec one metrics record, reduced
 * @property {string} kind @property {string} task @property {string} role @property {number | null} dur @property {number | null} tok @property {string} result @property {string} cls @property {string} time
 */

/** @param {unknown} v @returns {number | null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * @param {string | null} text @param {string} schema
 * @returns {{ rows: any[], read: number, notJson: number, foreign: number }}
 */
function jsonl(text, schema) {
  const out = { rows: /** @type {any[]} */ ([]), read: 0, notJson: 0, foreign: 0 };
  if (text === null) return out;
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    let o;
    try { o = JSON.parse(l); } catch { out.notJson++; continue; }
    if (o === null || typeof o !== 'object' || o.schema !== schema || typeof o.task !== 'string' || !isId(o.task)) { out.foreign++; continue; }
    out.read++; out.rows.push(o);
  }
  return out;
}

/**
 * @typedef {object} Ledger
 * @property {string} from `live` or `archive`
 * @property {Array<{ ev: string, detail: string, epoch: number, to: string }>} rows
 * @property {number} bad lines that are not in the ledger grammar
 */

/**
 * The ledger of a run: the live file, else the newest archive that holds one.
 * @param {string} root @param {string} runId @param {string[]} livePaths @param {string[]} notRead
 * @returns {Ledger | null}
 */
function findLedger(root, runId, livePaths, notRead) {
  /** @type {{ text: string, from: string } | null} */ let got = null;
  for (const p of livePaths) {
    const r = readBounded(p);
    if (r.text !== null) { got = { text: r.text, from: 'live' }; break; }
    if (r.why !== 'missing') notRead.push(`${runId}: ledger ${r.why}`);
  }
  if (got === null) {
    const dir = `${root}/.agents/local/archive/${runId}`;
    const arcs = names(dir).filter((n) => /^[A-Za-z0-9_.-]+\.tar\.gz$/.test(n)).reverse();
    for (const a of arcs) {
      const t = readTarGz(`${dir}/${a}`, (n) => (/^[A-Za-z0-9_-]+\/LEDGER\.log$/.test(n) ? n : null));
      if (t.refused > 0) notRead.push(`${runId}: ${plural(t.refused, 'archive entry', 'archive entries')} refused (unsafe name or not a plain file), nothing written`);
      if (!t.ok) { notRead.push(`${runId}: archive ${archiveName(a)} unreadable: ${t.why}`); continue; }
      for (const _k of t.tooLarge) notRead.push(`${runId}: LEDGER.log over the entry limit (${TAR_LIMITS.entryBytes} bytes), not read`);
      const first = [...t.files.values()][0];
      if (first === undefined) { if (t.tooLarge.length === 0) notRead.push(`${runId}: archive ${archiveName(a)} holds no LEDGER.log`); continue; }
      got = { text: first, from: 'archive' };
      break;
    }
  }
  if (got === null) return null;
  /** @type {Ledger} */ const led = { from: got.from, rows: [], bad: 0 };
  for (const l of got.text.split('\n')) {
    if (l === '') continue;
    const r = parseLedgerLine(l);
    const e = r === null ? NaN : Number(r.epoch);
    if (r === null || !Number.isFinite(e)) { led.bad++; continue; }
    led.rows.push({ ev: r.event, detail: r.detail, epoch: e, to: r.to });
  }
  if (led.bad > 0) notRead.push(`${runId}: ${plural(led.bad, 'ledger line')} not in the ledger grammar, not counted`);
  return led;
}

/** @param {string} detail the first word of an approval row that names its kind */
function approvalKind(detail) {
  const w = detail.split(/[ \t]+/).filter((x) => x !== '');
  const k = (w[0] ?? '').startsWith('approvals/') ? (w[1] ?? '') : (w[0] ?? '');
  return only(APPROVALS, k.split(':')[0]);
}

/**
 * What the ledger says about one run.
 * @param {Ledger} led
 */
function fromLedger(led) {
  const rows = led.rows;
  const epochs = rows.map((r) => r.epoch);
  let first = Infinity; let last = -Infinity;
  for (const e of epochs) { if (e < first) first = e; if (e > last) last = e; }
  const taskS = rows.length === 0 ? null : last - first;
  const isStart = (/** @type {{ ev: string, detail: string }} */ r) => (r.ev === 'handoff:IMPLEMENTING' && r.detail.startsWith('fix_round=')) || r.ev === 'REOPEN';
  const starts = rows.map((r, i) => (isStart(r) ? i : -1)).filter((i) => i >= 0);
  const fixRounds = rows.filter((r) => r.ev === 'handoff:IMPLEMENTING' && r.detail.startsWith('fix_round=')).length;
  const reopens = rows.filter((r) => r.ev === 'REOPEN').length;
  let firstPass = taskS; let rework = 0; let after = 0;
  if (taskS !== null && starts.length > 0) {
    const s = rows[starts[0]].epoch;
    let end = last;
    for (let i = rows.length - 1; i > starts[0]; i--) if (rows[i].ev.startsWith('gate:') || rows[i].ev === 'handoff:IMPLEMENTED') { end = rows[i].epoch; break; }
    end = Math.max(end, s);
    firstPass = Math.max(0, s - first); rework = end - s; after = Math.max(0, last - end);
  }
  /** @type {Map<string, { runs: number, fails: number }>} */ const gates = new Map();
  for (const r of rows) {
    const p = r.ev.split(':');
    if (p[0] !== 'gate' || p.length < 3) continue;
    const gn = only(GATES, p[1]);
    const g = gates.get(gn) ?? { runs: 0, fails: 0 };
    g.runs++; if (p[2] === 'fail') g.fails++;
    gates.set(gn, g);
  }
  const reruns = starts.map((si, k) => {
    const upto = k + 1 < starts.length ? starts[k + 1] : rows.length;
    const set = new Set(rows.slice(si + 1, upto).filter((r) => r.ev.startsWith('gate:')).map((r) => only(GATES, r.ev.split(':')[1] ?? '')));
    const r0 = rows[si];
    return { after: r0.ev === 'REOPEN' ? 'REOPEN' : (/^fix_round=[0-9]{1,4}$/.test(r0.detail.split(/\s/)[0]) ? r0.detail.split(/\s/)[0] : 'other'), gates: [...set].sort(cmp) };
  });
  // user waits: a question to its answer, an approval request to its approval of the same kind
  const waits = { count: 0, total_s: 0, longest_s: 0, unanswered: 0 };
  const asks = []; /** @type {Map<string, number[]>} */ const reqs = new Map();
  let questions = 0; let byUser = 0; let byAssumption = 0;
  /** @type {Map<string, { requested: number, granted: number }>} */ const approvals = new Map();
  const wait = (/** @type {number} */ from, /** @type {number} */ to) => { const d = Math.max(0, to - from); waits.count++; waits.total_s += d; if (d > waits.longest_s) waits.longest_s = d; };
  for (const r of rows) {
    if (r.ev === 'ask') { questions++; asks.push(r.epoch); } else if (r.ev === 'answer' || r.ev === 'answer-amend') {
      if (r.ev === 'answer') { if (r.detail.includes('answered_by=user')) byUser++; else byAssumption++; }
      const a = asks.shift(); if (a !== undefined) wait(a, r.epoch);
    } else if (r.ev === 'approval-request') {
      const k = approvalKind(r.detail); reqs.set(k, [...(reqs.get(k) ?? []), r.epoch]);
      const c = approvals.get(k) ?? { requested: 0, granted: 0 }; c.requested++; approvals.set(k, c);
    } else if (r.ev === 'approval') {
      const k = approvalKind(r.detail);
      const c = approvals.get(k) ?? { requested: 0, granted: 0 }; c.granted++; approvals.set(k, c);
      const q = reqs.get(k); const a = q?.shift(); if (a !== undefined) wait(a, r.epoch);
    }
  }
  waits.unanswered = asks.length + [...reqs.values()].reduce((s, q) => s + q.length, 0);
  /** @type {Map<string, number>} */ const friction = new Map();
  for (const r of rows) if (r.ev === 'friction-note') { const k = only(FRICTION, r.detail.split(/\s/)[0]); friction.set(k, (friction.get(k) ?? 0) + 1); }
  const count = (/** @type {string} */ e) => rows.filter((r) => r.ev === e).length;
  const done = rows.some((r) => r.ev === 'handoff:DONE');
  const term = rows.filter((r) => r.ev === 'terminate').pop();
  const cls = rows.find((r) => r.ev === 'classify');
  return {
    from: led.from, first, last, taskS, firstPass, rework, after, fixRounds, reopens, gates, reruns, waits, questions, byUser, byAssumption, approvals, friction,
    workarounds: count('discard-untracked') + count('raise-budget') + count('forced-removal'), blocked: rows.filter((r) => /^record:[a-z_]+:BLOCKED$/.test(r.ev)).length,
    state: done ? 'done' : term !== undefined ? only(OUTCOMES, asciiLower(term.to)) : 'open', cls: cls === undefined ? '' : only(CLASSES, cls.detail.split(/\s/)[0]), events: rows.length,
  };
}

/** @param {string} d `YYYY-MM-DD` @returns {number | null} epoch seconds at 00:00 UTC */
function dayEpoch(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (m === null) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === d ? t / 1000 : null;
}

/**
 * @param {Context} ctx @param {{ target: string, since: string }} sel
 */
export function gather(ctx, sel) {
  const root = ctx.root;
  /** @type {string[]} */ const notRead = [];
  const recFile = readBounded(`${root}/.agents/local/metrics/records.jsonl`);
  const toolFile = readBounded(`${root}/.agents/local/metrics/tools.jsonl`);
  if (recFile.text === null) notRead.push(`records.jsonl: ${recFile.why}`);
  if (toolFile.text === null) notRead.push(`tools.jsonl: ${toolFile.why}`);
  const records = jsonl(recFile.text, 'proofline.metrics/1');
  const tools = jsonl(toolFile.text, 'proofline.tools/1');
  /** @param {string} f @param {{ notJson: number, foreign: number }} j */
  const lineNote = (f, j) => { const p = []; if (j.notJson > 0) p.push(`${plural(j.notJson, 'line')} not JSON`); if (j.foreign > 0) p.push(`${plural(j.foreign, 'line')} of another schema`); if (p.length > 0) notRead.push(`${f}: ${p.join(', ')}`); };
  lineNote('records.jsonl', records); lineNote('tools.jsonl', tools);

  // batches: the one in force and the finished ones
  const bdir = `${root}/.agents/local/batch`;
  /** @type {Array<{ id: string, dir: string }>} */ const batches = [];
  const sum = readBounded(`${bdir}/SUMMARY.md`);
  if (sum.text !== null) batches.push({ id: createHash('sha256').update(Buffer.from(sum.text, 'latin1')).digest('hex').slice(0, 12), dir: bdir });
  for (const n of names(`${bdir}/history`)) if (isId(n)) batches.push({ id: n, dir: `${bdir}/history/${n}` });
  const batchTsv = (/** @type {string} */ dir, /** @type {string} */ f) => tsv(readBounded(`${dir}/${f}`).text ?? '');
  /** @type {Map<string, string[]>} */ const batchTasks = new Map();
  /** @type {Map<string, { pr: string, epoch: number | null }>} */ const merged = new Map();
  /** @type {Set<string>} */ const ci = new Set(); /** @type {Set<string>} */ const parked = new Set();
  for (const b of batches) {
    batchTasks.set(b.id, batchTsv(b.dir, 'order.tsv').map((f) => f[0]).filter(isId));
    for (const f of batchTsv(b.dir, 'merged.tsv')) if (isId(f[0] ?? '')) merged.set(f[0], { pr: /^[0-9]+$/.test(f[1] ?? '') ? f[1] : 'other', epoch: /^[0-9]+$/.test(f[2] ?? '') ? Number(f[2]) : null });
    for (const f of batchTsv(b.dir, 'ci.tsv')) if (isId(f[0] ?? '')) ci.add(f[0]);
    for (const f of batchTsv(b.dir, 'state.tsv')) if (isId(f[0] ?? '') && f[1] === 'parked') parked.add(f[0]);
  }

  // every run id with a ledger or a record
  /** @type {Set<string>} */ const known = new Set();
  /** @type {Map<string, string[]>} */ const live = new Map();
  const addLive = (/** @type {string} */ runsDir) => { for (const n of names(runsDir)) if (isId(n)) { known.add(n); live.set(n, [...(live.get(n) ?? []), `${runsDir}/${n}/LEDGER.log`]); } };
  addLive(`${root}/.agents/runs`);
  for (const w of names(`${root}/.agents/local/worktrees`)) if (isId(w)) addLive(`${root}/.agents/local/worktrees/${w}/.agents/runs`);
  for (const n of names(`${root}/.agents/local/archive`)) if (isId(n)) known.add(n);
  for (const r of [...records.rows, ...tools.rows]) known.add(r.task);

  /** @type {string[]} */ let ids = [...known];
  /** @type {string} */ let scope = 'all runs';
  if (sel.target !== '') {
    const b = batchTasks.get(sel.target);
    if (b !== undefined) { ids = b; scope = `batch ${sel.target}`; } else if (known.has(sel.target)) { ids = [sel.target]; scope = `run ${sel.target}`; } else throw die(`no such batch or run: ${sel.target}`);
  }
  const sinceEpoch = sel.since === '' ? null : dayEpoch(sel.since);
  if (sinceEpoch !== null) scope = scope === 'all runs' ? `runs since ${sel.since}` : `${scope}, since ${sel.since}`;

  const tasks = ids.map((t) => {
    /** @type {string[]} */ const nr = [];
    const led = findLedger(root, t, live.get(t) ?? [], nr);
    const L = led === null ? null : fromLedger(led);
    const mine = records.rows.filter((r) => r.task === t);
    /** @param {any} r @returns {number | null} */
    const tok = (r) => num(r.tokens_total) ?? (num(r.tokens_in) !== null && num(r.tokens_out) !== null ? /** @type {number} */ (num(r.tokens_in)) + /** @type {number} */ (num(r.tokens_out)) : null);
    /** @type {Map<string, { min: number, minRows: number, tok: number, tokN: number, rows: number }>} */ const roles = new Map();
    const roleOf = (/** @type {any} */ r) => only(ROLES, String(r.role ?? 'n/a'));
    const roleSet = new Set(mine.map(roleOf));
    for (const role of roleSet) {
      const of = (/** @type {string} */ k) => mine.filter((r) => r.kind === k && roleOf(r) === role);
      const steps = [...of('step'), ...of('lead')]; const resumed = of('dispatch').filter((r) => r.result === 'resumed'); const disp = of('dispatch').filter((r) => r.result !== 'resumed');
      const acc = { min: 0, minRows: 0, tok: 0, tokN: 0, rows: 0 };
      const useDur = steps.some((r) => num(r.duration_s) !== null) ? steps : [...steps, ...disp];
      for (const r of [...useDur, ...resumed]) { const d = num(r.duration_s); if (d !== null) { acc.min += d; acc.minRows++; } }
      const useTok = steps.some((r) => tok(r) !== null) ? steps : [...steps, ...disp];
      for (const r of [...useTok, ...resumed]) { acc.rows++; const v = tok(r); if (v !== null) { acc.tok += v; acc.tokN++; } }
      roles.set(role, acc);
    }
    const resumedRows = mine.filter((r) => r.kind === 'dispatch' && r.result === 'resumed');
    /** @type {Map<string, { n: number, s: number }>} */ const resumedBy = new Map();
    for (const r of resumedRows) { const k = roleOf(r); const c = resumedBy.get(k) ?? { n: 0, s: 0 }; c.n++; c.s += num(r.duration_s) ?? 0; resumedBy.set(k, c); }
    const run = mine.find((r) => r.kind === 'run');
    const tm = tools.rows.filter((r) => r.task === t);
    /** @type {Map<string, number>} */ const den = new Map(); let denied = 0;
    for (const r of tm) {
      denied += num(r.denied) ?? 0;
      if (r.denials !== null && typeof r.denials === 'object') for (const [k, v] of Object.entries(r.denials)) { const n = num(v); if (n !== null) den.set(denialClass(k), (den.get(denialClass(k)) ?? 0) + n); }
    }
    const firstRec = mine.map((r) => Date.parse(String(r.time))).filter(Number.isFinite).sort((a, b) => a - b)[0];
    if (led === null) nr.push(`${t}: no ledger (no live run, no archive)`);
    const m = merged.get(t);
    return {
      task: t, L, nr, roles, resumedBy, toolRows: tm.length, denials: den, denied, start: L !== null ? L.first : firstRec === undefined ? null : Math.floor(firstRec / 1000),
      recState: run === undefined || typeof run.result !== 'string' ? '' : only(OUTCOMES, run.result), recClass: run === undefined || typeof run.class !== 'string' ? '' : only(CLASSES, run.class),
      merge: m ?? null, ci: ci.has(t), parked: parked.has(t),
    };
  }).filter((x) => sinceEpoch === null || (x.start !== null && x.start >= sinceEpoch))
    .sort((a, b) => ((a.start ?? Infinity) - (b.start ?? Infinity)) || cmp(a.task, b.task));
  return { scope, tasks, notRead: [...notRead, ...tasks.flatMap((x) => x.nr)], records, tools, ledgers: { live: tasks.filter((x) => x.L?.from === 'live').length, archive: tasks.filter((x) => x.L?.from === 'archive').length } };
}

/** @typedef {ReturnType<typeof gather>} Model */
/** @typedef {Model['tasks'][number]} Task */

/** @param {Task} t */
function tokenParts(t) {
  const roles = [...t.roles.keys()].sort(cmp);
  const parts = roles.map((r) => ({ role: r, ...(/** @type {any} */ (t.roles.get(r))) }));
  const any = parts.filter((p) => p.tokN > 0);
  return { parts, total: any.length === 0 ? null : any.reduce((s, p) => s + p.tok, 0) };
}

/** @param {Task} t */
function taskJson(t) {
  const L = t.L; const tp = tokenParts(t);
  return {
    task: t.task, state: L !== null ? L.state : t.recState !== '' ? t.recState : 'not recorded', class: L !== null && L.cls !== '' ? L.cls : t.recClass !== '' ? t.recClass : null,
    ledger: L === null ? 'not recorded' : L.from, events: L === null ? null : L.events,
    task_s: L?.taskS ?? null, first_pass_s: L === null ? null : L.firstPass, rework_s: L === null ? null : L.rework, after_s: L === null ? null : L.after,
    fix_rounds: L === null ? null : L.fixRounds, reopens: L === null ? null : L.reopens,
    agent_s: Object.fromEntries([...t.roles.keys()].sort(cmp).filter((r) => /** @type {any} */ (t.roles.get(r)).minRows > 0).map((r) => [r, /** @type {any} */ (t.roles.get(r)).min])),
    tokens: Object.fromEntries(tp.parts.map((p) => [p.role, p.tokN > 0 ? p.tok : null])), tokens_total: tp.total,
    gates: L === null ? null : Object.fromEntries([...L.gates.keys()].sort(cmp).map((g) => [g, L.gates.get(g)])), gate_reruns: L === null ? null : L.reruns,
    user_waits: L === null ? null : L.waits, questions: L === null ? null : { asked: L.questions, by_user: L.byUser, by_assumption: L.byAssumption },
    approvals: L === null ? null : Object.fromEntries([...L.approvals.keys()].sort(cmp).map((k) => [k, L.approvals.get(k)])),
    hook_denials: t.toolRows === 0 ? null : { denied: t.denied, classes: Object.fromEntries([...t.denials.keys()].sort(cmp).map((k) => [k, t.denials.get(k)])) },
    friction: L === null ? null : Object.fromEntries([...L.friction.keys()].sort(cmp).map((k) => [k, L.friction.get(k)])), workarounds: L === null ? null : L.workarounds, blocked_records: L === null ? null : L.blocked,
    resumed: Object.fromEntries([...t.resumedBy.keys()].sort(cmp).map((k) => [k, t.resumedBy.get(k)])), merge: t.merge, ci_checked: t.ci, parked: t.parked,
  };
}

/** @param {Model} m */
function totals(m) {
  const withL = m.tasks.filter((t) => t.L !== null && t.L.taskS !== null);
  const sum = (/** @type {(t: Task) => number} */ f) => withL.reduce((s, t) => s + f(t), 0);
  let lo = Infinity; let hi = -Infinity;
  for (const t of withL) { const l = /** @type {any} */ (t.L); if (l.first < lo) lo = l.first; if (l.last > hi) hi = l.last; }
  for (const t of m.tasks) { const e = t.merge?.epoch; if (typeof e === 'number' && e > hi) hi = e; }
  return {
    tasks: m.tasks.length, with_ledger: withL.length,
    task_s: withL.length === 0 ? null : sum((t) => /** @type {any} */ (t.L).taskS),
    first_pass_s: withL.length === 0 ? null : sum((t) => /** @type {any} */ (t.L).firstPass),
    rework_s: withL.length === 0 ? null : sum((t) => /** @type {any} */ (t.L).rework), after_s: withL.length === 0 ? null : sum((t) => /** @type {any} */ (t.L).after),
    wall_s: withL.length === 0 ? null : hi - lo,
    fix_rounds: withL.length === 0 ? null : sum((t) => /** @type {any} */ (t.L).fixRounds), reopens: withL.length === 0 ? null : sum((t) => /** @type {any} */ (t.L).reopens),
  };
}

/** @param {Model} m */
export function retroJson(m) {
  return `${JSON.stringify({ schema: 'proofline.retro/1', scope: m.scope, sources: { records_read: m.records.read, tools_read: m.tools.read, ledgers_live: m.ledgers.live, ledgers_archive: m.ledgers.archive }, totals: totals(m), tasks: m.tasks.map(taskJson), not_read: m.notRead }, null, 2)}\n`;
}

/** @param {Model} m @param {boolean} full @returns {string[]} lines */
export function retroLines(m, full) {
  /** @type {string[]} */ const o = [];
  o.push('proofline retro (read-only: nothing was changed)');
  if (m.tasks.length === 0) { o.push(`scope: ${m.scope}`, 'no runs found'); return o; }
  const t = totals(m);
  const withoutLedger = m.tasks.length - t.with_ledger;
  o.push(`scope: ${m.scope} (${plural(m.tasks.length, 'run')}: ${t.with_ledger} with a ledger, ${withoutLedger} without)`);
  o.push(`sources: ${m.ledgers.live} live and ${m.ledgers.archive} archived ledgers, ${plural(m.records.read, 'metrics record')}, ${plural(m.tools.read, 'tool record')}; not read: ${m.notRead.length}`);
  if (t.task_s === null) o.push('time: not recorded');
  else {
    const p = (/** @type {number | null} */ v) => `${mins(/** @type {number} */ v)} min (${t.task_s === 0 ? 0 : Math.round((100 * /** @type {number} */ (v)) / t.task_s)}%)`;
    o.push(`time: wall ${mins(/** @type {number} */ t.wall_s)} min, task time ${mins(t.task_s)} min (first to last ledger event of each run); first pass ${p(t.first_pass_s)}, rework ${p(t.rework_s)}, after the last gate ${p(t.after_s)}`);
    o.push(`fix rounds ${t.fix_rounds}, reopens ${t.reopens} (ledger); informational counts, not a measure of quality`);
  }
  // resumed runs
  o.push('resumed runs:');
  let any = false;
  for (const x of m.tasks) {
    const n = [...x.resumedBy.values()].reduce((s, c) => s + c.n, 0);
    const re = x.L === null ? 0 : x.L.reopens;
    if (n === 0 && re === 0) continue;
    any = true;
    const parts = [];
    if (n > 0) parts.push(`${n} ${n === 1 ? 'agent' : 'agents'} resumed without a new submit (${[...x.resumedBy.keys()].sort(cmp).map((k) => `${k} ${mins(/** @type {any} */ (x.resumedBy.get(k)).s)} min`).join(', ')}, no tokens recorded)`);
    parts.push(`reopened ${re} ${re === 1 ? 'time' : 'times'}${re > 0 ? ' (ledger REOPEN)' : ''}`);
    o.push(`  ${x.task}: ${parts.join('; ')}`);
  }
  if (!any) o.push('  none recorded');
  // not read
  o.push('not read (listed, never guessed):');
  if (m.notRead.length === 0) o.push('  nothing: every source was read');
  for (const l of full ? m.notRead : m.notRead.slice(0, MAX_LIST)) o.push(`  ${l}`);
  if (!full && m.notRead.length > MAX_LIST) o.push(`  ... ${m.notRead.length - MAX_LIST} more (--full)`);
  // table
  o.push('', 'task        state    class     task_min  first_pass  rework  after  fix  reopen  tokens');
  for (const x of m.tasks) {
    const j = taskJson(x);
    const f = (/** @type {number | null} */ v) => (v === null ? 'n/r' : mins(v));
    o.push(`${x.task.padEnd(11)} ${String(j.state).padEnd(8)} ${String(j.class ?? '-').padEnd(9)} ${f(j.task_s).padEnd(9)} ${f(j.first_pass_s).padEnd(11)} ${f(j.rework_s).padEnd(7)} ${f(j.after_s).padEnd(6)} ${String(j.fix_rounds ?? 'n/r').padEnd(4)} ${String(j.reopens ?? 'n/r').padEnd(7)} ${j.tokens_total ?? 'n/r'}`);
  }
  o.push('(n/r = not recorded)');
  // details
  for (const x of m.tasks) o.push('', ...detail(x));
  return o;
}

/** @param {Task} x @returns {string[]} */
function detail(x) {
  const j = taskJson(x); const L = x.L;
  /** @type {string[]} */ const o = [];
  o.push(`${x.task} (${j.state}${j.class !== null ? `, ${j.class}` : ''})`);
  if (L === null || L.taskS === null) o.push('  ledger: not recorded');
  else {
    const pct = (/** @type {number} */ v) => (L.taskS === 0 ? 0 : Math.round((100 * v) / /** @type {number} */ (L.taskS)));
    o.push(`  time: task ${mins(L.taskS)} min; first pass ${mins(/** @type {number} */ L.firstPass)} min (${pct(/** @type {number} */ L.firstPass)}%), rework ${mins(L.rework)} min (${pct(L.rework)}%), after the last gate ${mins(L.after)} min (${pct(L.after)}%)`);
  }
  const am = [...x.roles.keys()].sort(cmp).filter((r) => /** @type {any} */ (x.roles.get(r)).minRows > 0 && r !== 'lead');
  o.push(`  agent minutes: ${am.length === 0 ? 'not recorded' : am.map((r) => `${r} ${mins(/** @type {any} */ (x.roles.get(r)).min)}`).join(', ')}`);
  const tp = tokenParts(x);
  o.push(`  tokens: ${tp.parts.length === 0 ? 'not recorded' : `${tp.parts.map((p) => `${p.role} ${p.tokN > 0 ? p.tok : 'not recorded'} (${p.tokN}/${p.rows} records)`).join(', ')}; total ${tp.total ?? 'not recorded'}`}`);
  if (L !== null) {
    o.push(`  fix rounds: ${L.fixRounds} (ledger); reopens: ${L.reopens}`);
    const gl = [...L.gates.keys()].sort(cmp).map((g) => { const v = /** @type {any} */ (L.gates.get(g)); return `${g} ${plural(v.runs, 'run')} (${v.fails} fail)`; });
    o.push(`  gates: ${gl.length === 0 ? 'none in the ledger' : gl.join(', ')}`);
    o.push(`  gate re-runs: ${L.reruns.length === 0 ? 'no fix round or reopen' : L.reruns.map((r) => `after ${r.after}: ${r.gates.length === 0 ? 'none' : r.gates.join(', ')}`).join('; ')}; read-set comparison: not recorded`);
    o.push(`  user waits: ${L.waits.count} (total ${mins(L.waits.total_s)} min, longest ${mins(L.waits.longest_s)} min), unanswered ${L.waits.unanswered}`);
    const ap = [...L.approvals.keys()].sort(cmp).map((k) => `${k} requested ${/** @type {any} */ (L.approvals.get(k)).requested}, granted ${/** @type {any} */ (L.approvals.get(k)).granted}`);
    o.push(`  questions: ${L.questions} (answered by the user ${L.byUser}, by an assumption ${L.byAssumption}); approvals: ${ap.length === 0 ? 'none' : ap.join('; ')}`);
  } else o.push('  fix rounds, gates, waits and approvals: not recorded (no ledger)');
  if (x.toolRows === 0) o.push('  hook denials: not recorded');
  else { const k = [...x.denials.keys()].sort(cmp); o.push(`  hook denials: ${x.denied}${k.length > 0 ? ` (${k.map((c) => `${c} ${x.denials.get(c)}`).join(', ')})` : ''}`); }
  if (L !== null) {
    const fr = [...L.friction.keys()].sort(cmp).map((k) => `${k} ${L.friction.get(k)}`);
    o.push(`  friction: ${fr.length === 0 ? 'none' : fr.join(', ')}; workarounds seen by the control plane ${L.workarounds}`);
    o.push(`  blocked records: ${L.blocked}`);
  }
  if (x.merge !== null) {
    const after = x.merge.epoch !== null && L !== null ? `, ${mins(Math.max(0, x.merge.epoch - L.last))} min after the last ledger event` : '';
    o.push(`  merge: PR ${x.merge.pr}${after}; CI: ${x.ci ? 'checked (batch/ci.tsv)' : 'not recorded'}`);
  } else o.push('  merge: not recorded');
  if (x.parked) o.push('  batch: parked in the batch');
  return o;
}

/** The cap of `output_cap_bytes`. @param {Context} ctx */
function capOf(ctx) {
  const v = ctx.config().get('output_cap_bytes', String(DEFAULT_CAP));
  if (!/^[0-9]+$/.test(v)) return DEFAULT_CAP;
  const n = Number(v);
  return n === 0 ? 0 : Math.max(MIN_CAP, n);
}

/** @param {string} text @param {number} cap @param {string} again */
function shape(text, cap, again) {
  if (cap === 0 || text.length <= cap) return text;
  const at = text.lastIndexOf('\n', cap - 1);
  const cut = at < 0 ? text.slice(0, cap) : text.slice(0, at + 1);
  return `${cut}...${text.length - cut.length} more bytes: ${again}\n`;
}

/** @param {Context} ctx @param {string[]} args */
export function retroCommand(ctx, args) {
  requireInstalled(ctx);
  let json = false; let full = false; let since = ''; let target = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--full') full = true;
    else if (a === '--since') {
      if (i + 1 >= args.length) { ctx.err(`${USAGE}\n`); throw die('--since needs a date as YYYY-MM-DD'); }
      since = args[++i];
    } else if (a.startsWith('--since=')) since = a.slice('--since='.length);
    else if (a === '-h' || a === '--help') { ctx.out(`${USAGE}\n`); return 0; } else if (a.startsWith('-')) { ctx.err(`${USAGE}\n`); throw die(`unknown argument: ${a}`); } else if (target === '') target = a;
    else { ctx.err(`${USAGE}\n`); throw die(`unknown argument: ${a}`); }
  }
  if (target !== '' && !isId(target)) throw die(`invalid batch or run id: ${target}`);
  if (since !== '' && dayEpoch(since) === null) throw die('--since needs a date as YYYY-MM-DD');
  const m = gather(ctx, { target, since });
  if (json) { ctx.out(retroJson(m)); return 0; }
  const text = `${retroLines(m, full).join('\n')}\n`;
  const again = `proofline retro${target !== '' ? ` ${target}` : ''}${since !== '' ? ` --since ${since}` : ''} --full`;
  ctx.out(full ? text : shape(text, capOf(ctx), again));
  return 0;
}
