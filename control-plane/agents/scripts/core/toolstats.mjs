// @ts-check
// A235 (#181): the per-step tool record. From the runtime's own session log (the transcript whose path is line 1 of `.agents/local/submissions/<token>.started`)
// the control plane counts, per step, the tool calls by tool and the bytes of the tool results that entered the context, and appends ONE line to
// `.agents/local/metrics/tools.jsonl` (schema `proofline.tools/1`, documented in docs/concepts/metrics.md). `records.jsonl` is not touched (ADR D3).
// Nothing a model wrote is copied: a record holds identifiers reduced to [A-Za-z0-9._+:-] and numbers. A log the reader cannot use gives `null` counts and a
// `log` field that says why (as `metrics_step` leaves its tokens null), never zero.
import { appendFileSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { now } from './clock.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ log: 'ok' | 'unreadable' | 'malformed', calls: number | null, resultBytes: number | null, denied: number | null, byTool: Record<string, { calls: number, bytes: number }> | null, reason?: string | null }} ToolStats */

const MAX_TOOLS = 40;
const MAX_STRING = 64;                  // every string of a record is cut to this many characters after the reduction: one line stays under about 5 KB
const MAX_LOG_BYTES = 128 * 1024 * 1024;   // a larger log is not read
const DENIED = /^PreToolUse:[A-Za-z0-9_]+ hook error/;

/** @param {string} v */
const reduce = (v) => v.replace(/[^A-Za-z0-9._+:-]/g, '').slice(0, MAX_STRING);

/** @param {unknown} content a tool_result's content: a string or a list of blocks; only text counts */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/**
 * Count the tool calls and the result bytes of one Claude Code session log. A call is a `tool_use` of an `assistant` entry (a repeated id counts once: the
 * log also holds a request copy of it); its result is the `tool_result` of a `user` entry with the same id (the first one). Result bytes are the UTF-8
 * length of the text blocks. A result that starts `PreToolUse:<Tool> hook error` is a call the hook refused (counted in `denied` too). A last line that is
 * not complete JSON is the line the running session is writing and is ignored; any other line that is not JSON makes the whole log `malformed`.
 * @param {string} file @returns {ToolStats}
 */
export function readToolStats(file) {
  const bad = (/** @type {'unreadable' | 'malformed'} */ log, /** @type {string} */ reason) => ({ log, calls: null, resultBytes: null, denied: null, byTool: null, reason });
  let text;
  try { if (statSync(file).size > MAX_LOG_BYTES) return bad('unreadable', 'too-large'); text = readFileSync(file, 'utf8'); } catch { return bad('unreadable', 'read-error'); }
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  /** @type {Map<string, string>} */ const tool = new Map();
  /** @type {Set<string>} */ const answered = new Set();
  /** @type {Map<string, number>} */ const bytesOf = new Map();
  let denied = 0;
  for (let i = 0; i < lines.length; i++) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { if (i === lines.length - 1) break; return bad('malformed', 'bad-line'); }
    const content = d?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && d.type === 'assistant' && typeof b.id === 'string' && !tool.has(b.id)) tool.set(b.id, (typeof b.name === 'string' ? reduce(b.name) : '') || '?');
      else if (b.type === 'tool_result' && d.type === 'user' && typeof b.tool_use_id === 'string' && !answered.has(b.tool_use_id)) {
        answered.add(b.tool_use_id);
        const t = textOf(b.content);
        bytesOf.set(b.tool_use_id, Buffer.byteLength(t));
        if (DENIED.test(t)) denied++;
      }
    }
  }
  return summarize(tool, bytesOf, denied);
}


/**
 * The totals and the per-tool table of the calls seen: the 40 tools with the most calls keep their names, the rest is summed under "other".
 * @param {Map<string, string>} tool call id to reduced tool name @param {Map<string, number>} bytesOf call id to result bytes @param {number} denied @returns {ToolStats}
 */
function summarize(tool, bytesOf, denied) {
  /** @type {Map<string, { calls: number, bytes: number }>} */ const per = new Map();
  let total = 0;
  for (const [id, name] of tool) {
    const e = per.get(name) ?? { calls: 0, bytes: 0 };
    e.calls++; e.bytes += bytesOf.get(id) ?? 0; total += bytesOf.get(id) ?? 0;
    per.set(name, e);
  }
  // the 40 tools with the most calls keep their names, the rest is summed under "other"; keys are written in byte order
  const ranked = [...per].sort((a, b) => b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : 1));
  /** @type {Record<string, { calls: number, bytes: number }>} */ const byTool = {};
  // defineProperty: a tool named `__proto__` is an ordinary own key, never the prototype setter
  const put = (/** @type {string} */ k, /** @type {{ calls: number, bytes: number }} */ e) => Object.defineProperty(byTool, k, { value: e, enumerable: true, writable: true, configurable: true });
  const keep = ranked.slice(0, MAX_TOOLS).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [n, e] of keep) put(n, e);
  const rest = ranked.slice(MAX_TOOLS);
  if (rest.length > 0) put('other', rest.reduce((a, [, e]) => ({ calls: a.calls + e.calls, bytes: a.bytes + e.bytes }), { calls: 0, bytes: 0 }));
  return { log: 'ok', calls: tool.size, resultBytes: total, denied, byTool, reason: null };
}

// ---- Codex (A255, #181) -------------------------------------------------------------------------------------------------------------------------
// A Codex session writes `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<local time>-<session id>.jsonl`. Nothing in the dispatcher records that path (the `.started` file is a
// Claude hook's), but a command the model runs (`agent.sh submit`) has `CODEX_THREAD_ID` (= the session id, checked live in A211), so the file is found by that id.
const MAX_LINE = 32 * 1024 * 1024;       // a longer line is not buffered: the log is unreadable
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_CALLS = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call']);
const CODEX_RESULTS = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/** The day directories (`YYYY/MM/DD`, local time and UTC, today and the 3 days before) a session that is submitting now can live in. @param {number} epoch seconds, from the injected clock @returns {string[]} */
export function codexDayDirs(epoch) {
  /** @type {string[]} */ const out = [];
  for (let k = 0; k <= 3; k++) {
    const d = new Date((epoch - k * 86400) * 1000);
    for (const c of [`${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`, `${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}`]) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * The rollout file of the Codex session this process runs in. The id must be a UUID (so it cannot carry a path), the file name is matched exactly in a listing of a day
 * directory (nothing recorded in a file is ever used as a path), and a symbolic link is not followed.
 * @param {Record<string, string | undefined>} env @param {number} epoch @returns {{ file: string, reason: string | null }}
 */
export function findCodexRollout(env, epoch) {
  const sid = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || '';
  if (!UUID.test(sid)) return { file: '', reason: 'no-session-id' };
  const home = env.CODEX_HOME || (env.HOME ? `${env.HOME}/.codex` : '');
  if (!home.startsWith('/')) return { file: '', reason: 'no-codex-home' };
  const want = new RegExp(`^rollout-[0-9T-]{19}-${sid}\\.jsonl$`, 'i');   // the id passed the UUID test: hex and dashes only
  for (const day of codexDayDirs(epoch)) {
    const dir = `${home}/sessions/${day}`;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) {
      if (!want.test(n)) continue;
      try { if (lstatSync(`${dir}/${n}`).isFile()) return { file: `${dir}/${n}`, reason: null }; } catch { /* next */ }
    }
  }
  return { file: '', reason: 'no-rollout' };
}

/** The text of a Codex tool output: a string, or a list of blocks with a `text`. @param {unknown} o */
function codexText(o) {
  if (typeof o === 'string') return o;
  if (!Array.isArray(o)) return '';
  return o.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).join('');
}

/**
 * Count the tool calls and result bytes of one Codex rollout log, read line by line (a line over 32 MiB or a log over 128 MiB is `unreadable`). A call is a
 * `response_item` of type function_call, custom_tool_call, local_shell_call or tool_search_call with a `call_id` (once per id); its result is the first `*_output` item with that
 * id, counted as the UTF-8 length of its text. A result whose first 300 characters hold `blocked by PreToolUse hook` is a refused call (also counted in `denied`). The tool is the
 * call's `name` (Codex runs nearly every command as `exec`, so the table is coarse). A last line that is not complete JSON is the line being written and is ignored; any other line
 * that is not JSON, or a log in which no line is an object with a string `type`, is `malformed`. A call without a result yet (the `submit` itself) counts with 0 bytes.
 * @param {string} file @returns {ToolStats}
 */
export function readCodexToolStats(file) {
  const bad = (/** @type {'unreadable' | 'malformed'} */ log, /** @type {string} */ reason) => ({ log, calls: null, resultBytes: null, denied: null, byTool: null, reason });
  /** @type {Map<string, string>} */ const tool = new Map();
  /** @type {Set<string>} */ const answered = new Set();
  /** @type {Map<string, number>} */ const bytesOf = new Map();
  let denied = 0; let typed = false; let total = 0;
  let fd = -1;
  try {
    fd = openSync(file, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) return bad('unreadable', 'not-a-file');
    if (st.size > MAX_LOG_BYTES) return bad('unreadable', 'too-large');
    const buf = Buffer.allocUnsafe(64 * 1024);
    /** @type {Buffer[]} */ let part = []; let partLen = 0;
    /** @type {string | null} */ let pending = null;     // the last complete line is held back: only the final line may be unfinished
    /** @param {string} line @returns {boolean} false: a malformed line */
    const take = (line) => {
      if (line === '') return true;
      let d;
      try { d = JSON.parse(line); } catch { return false; }
      if (!d || typeof d !== 'object') return true;
      if (typeof d.type === 'string') typed = true;
      const p = d.payload;
      if (d.type !== 'response_item' || !p || typeof p !== 'object' || typeof p.call_id !== 'string') return true;
      const id = p.call_id;
      if (CODEX_CALLS.has(p.type)) { if (!tool.has(id)) tool.set(id, (typeof p.name === 'string' ? reduce(p.name) : '') || (p.type === 'local_shell_call' ? 'local_shell' : p.type === 'tool_search_call' ? 'tool_search' : '?')); }
      else if (CODEX_RESULTS.has(p.type) && !answered.has(id)) {
        answered.add(id);
        const t = codexText(p.output);
        bytesOf.set(id, Buffer.byteLength(t));
        if (t.slice(0, 300).includes('blocked by PreToolUse hook')) denied++;
      }
      return true;
    };
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_LOG_BYTES) return bad('unreadable', 'too-large');
      let from = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== 10) continue;
        part.push(Buffer.from(buf.subarray(from, i))); partLen += i - from; from = i + 1;
        if (partLen > MAX_LINE) return bad('unreadable', 'line-too-long');
        const line = Buffer.concat(part).toString('utf8'); part = []; partLen = 0;
        if (pending !== null && !take(pending)) return bad('malformed', 'bad-line');
        pending = line;
      }
      if (from < n) { part.push(Buffer.from(buf.subarray(from, n))); partLen += n - from; if (partLen > MAX_LINE) return bad('unreadable', 'line-too-long'); }
    }
    if (partLen > 0) {      // text after the last newline: complete JSON counts, a cut-off line is the one being written
      if (pending !== null && !take(pending)) return bad('malformed', 'bad-line');
      pending = null;
      const last = Buffer.concat(part).toString('utf8');
      try { JSON.parse(last); take(last); } catch { /* unfinished */ }
    } else if (pending !== null) {
      try { JSON.parse(pending); take(pending); } catch { /* the last line is unfinished or broken: ignored, as in the Claude reader */ }
    }
  } catch { return bad('unreadable', 'read-error'); } finally { if (fd >= 0) try { closeSync(fd); } catch { /* ignore */ } }
  if (!typed) return bad('malformed', 'no-events');
  return summarize(tool, bytesOf, denied);
}

/**
 * Append the record of one recorded step. `log` is the session log path ('' when none was found). For `codex` an empty `log` is `unreadable` with the `reason` of the search
 * (`no-session-id`, `no-codex-home`, `no-rollout`); for any other runtime it is `no-log`. Best effort; `metrics: off` writes nothing.
 * A181-D (A258): `kind: 'lead'` is the snapshot of the lead's own session (role `lead`); it has a last key `session` (the session id, reduced) so that `insights` counts one
 * session once; a lead whose log was not found is `unreadable` with the reason, for every runtime.
 * @param {Context} ctx @param {{ task: string, role: string, focus: string, gate: string, runtime: string, log: string, reason?: string | null, kind?: 'step' | 'lead', session?: string }} f
 */
export function toolsRecord(ctx, f) {
  if (ctx.config().get('metrics', 'on') === 'off') return;
  const s = (/** @type {string} */ v) => { const t = reduce(v); return t === '' || t === '-' ? 'null' : `"${t}"`; };
  const n = (/** @type {number | null} */ v) => (v === null ? 'null' : String(v));
  const none = (/** @type {'unreadable' | 'no-log'} */ log, /** @type {string | null} */ reason) => ({ log, calls: null, resultBytes: null, denied: null, byTool: null, reason });
  const codex = f.runtime === 'codex';
  const lead = f.kind === 'lead';
  /** @type {ToolStats | ReturnType<typeof none>} */
  const st = f.log === '' ? (codex || lead ? none('unreadable', f.reason ?? (codex ? 'no-rollout' : 'no-transcript')) : none('no-log', null))
    : (() => { try { return codex ? readCodexToolStats(f.log) : readToolStats(f.log); } catch { return none('unreadable', 'read-error'); } })();
  const by = st.byTool === null ? 'null' : `{${Object.entries(st.byTool).map(([k, e]) => `"${k}":{"calls":${e.calls},"bytes":${e.bytes}}`).join(',')}}`;
  const line = `{"schema":"proofline.tools/1","kind":"${lead ? 'lead' : 'step'}","time":"${now().iso}","task":${s(f.task)},"role":${s(f.role)},"focus":${s(f.focus)},"gate":${s(f.gate)},"runtime":${s(f.runtime)},"log":"${st.log}","calls":${n(st.calls)},"result_bytes":${n(st.resultBytes)},"denied":${n(st.denied)},"by_tool":${by},"reason":${st.reason ? `"${reduce(st.reason)}"` : 'null'}${lead ? `,"session":${s(f.session ?? '')}` : ''}}\n`;
  const file = `${ctx.sharedMain()}/.agents/local/metrics/tools.jsonl`;
  try { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, line, { encoding: 'utf8' }); } catch { /* best effort */ }
}
