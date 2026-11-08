// @ts-check
// A235 (#181): the per-step tool record. From the runtime's own session log (the transcript whose path is line 1 of `.agents/local/submissions/<token>.started`)
// the control plane counts, per step, the tool calls by tool and the bytes of the tool results that entered the context, and appends ONE line to
// `.agents/local/metrics/tools.jsonl` (schema `proofline.tools/1`, documented in docs/concepts/metrics.md). `records.jsonl` is not touched (ADR D3).
// Nothing a model wrote is copied: a record holds identifiers reduced to [A-Za-z0-9._+:-] and numbers. A log the reader cannot use gives `null` counts and a
// `log` field that says why (as `metrics_step` leaves its tokens null), never zero.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { now } from './clock.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ log: 'ok' | 'unreadable' | 'malformed', calls: number | null, resultBytes: number | null, denied: number | null, byTool: Record<string, { calls: number, bytes: number }> | null }} ToolStats */

const MAX_TOOLS = 40;
const DENIED = /^PreToolUse:[A-Za-z0-9_]+ hook error/;

/** @param {string} v */
const reduce = (v) => v.replace(/[^A-Za-z0-9._+:-]/g, '');

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
  const bad = (/** @type {'unreadable' | 'malformed'} */ log) => ({ log, calls: null, resultBytes: null, denied: null, byTool: null });
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return bad('unreadable'); }
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  /** @type {Map<string, string>} */ const tool = new Map();
  /** @type {Set<string>} */ const answered = new Set();
  /** @type {Map<string, number>} */ const bytesOf = new Map();
  let denied = 0;
  for (let i = 0; i < lines.length; i++) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { if (i === lines.length - 1) break; return bad('malformed'); }
    const content = d?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && d.type === 'assistant' && typeof b.id === 'string' && !tool.has(b.id)) tool.set(b.id, reduce(String(b.name ?? '')) || '?');
      else if (b.type === 'tool_result' && d.type === 'user' && typeof b.tool_use_id === 'string' && !answered.has(b.tool_use_id)) {
        answered.add(b.tool_use_id);
        const t = textOf(b.content);
        bytesOf.set(b.tool_use_id, Buffer.byteLength(t));
        if (DENIED.test(t)) denied++;
      }
    }
  }
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
  const keep = ranked.slice(0, MAX_TOOLS).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [n, e] of keep) byTool[n] = e;
  const rest = ranked.slice(MAX_TOOLS);
  if (rest.length > 0) byTool.other = rest.reduce((a, [, e]) => ({ calls: a.calls + e.calls, bytes: a.bytes + e.bytes }), { calls: 0, bytes: 0 });
  return { log: 'ok', calls: tool.size, resultBytes: total, denied, byTool };
}

/**
 * Append the record of one recorded step. `log` is the transcript path ('' when the runtime keeps none the control plane can read: `no-log`). Best effort; `metrics: off` writes nothing.
 * @param {Context} ctx @param {{ task: string, role: string, focus: string, gate: string, runtime: string, log: string }} f
 */
export function toolsRecord(ctx, f) {
  if (ctx.config().get('metrics', 'on') === 'off') return;
  const s = (/** @type {string} */ v) => { const t = reduce(v); return t === '' || t === '-' ? 'null' : `"${t}"`; };
  const n = (/** @type {number | null} */ v) => (v === null ? 'null' : String(v));
  /** @type {ToolStats | { log: 'no-log', calls: null, resultBytes: null, denied: null, byTool: null }} */
  const st = f.log === '' ? { log: 'no-log', calls: null, resultBytes: null, denied: null, byTool: null } : readToolStats(f.log);
  const by = st.byTool === null ? 'null' : `{${Object.entries(st.byTool).map(([k, e]) => `"${k}":{"calls":${e.calls},"bytes":${e.bytes}}`).join(',')}}`;
  const line = `{"schema":"proofline.tools/1","kind":"step","time":"${now().iso}","task":${s(f.task)},"role":${s(f.role)},"focus":${s(f.focus)},"gate":${s(f.gate)},"runtime":${s(f.runtime)},"log":"${st.log}","calls":${n(st.calls)},"result_bytes":${n(st.resultBytes)},"denied":${n(st.denied)},"by_tool":${by}}\n`;
  const file = `${ctx.sharedMain()}/.agents/local/metrics/tools.jsonl`;
  try { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, line, { encoding: 'utf8' }); } catch { /* best effort */ }
}
