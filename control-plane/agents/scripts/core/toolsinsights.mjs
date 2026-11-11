// @ts-check
// A255 (#181): the reader of `.agents/local/metrics/tools.jsonl` for `proofline insights`. The records were written by the control plane (core/toolstats.mjs) and hold identifiers
// and numbers only, but the file is still parsed as untrusted text: it is read in 64 KiB chunks (memory is the longest line, at most 64 KiB, plus the totals), at most
// MAX_LINES lines are read, a line that is too long or not JSON is counted as corrupt and skipped, every identifier is reduced again, and tool names are map keys of a `Map`
// (a tool named `__proto__` is an ordinary name). Nothing is written.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export const MAX_LINES = 200000;
const MAX_LINE = 64 * 1024;
const MAX_TOOLS_PER_GROUP = 100;     // more distinct names than this in one group are summed under "other"
const MAX_TOOLS_PER_RECORD = 50;
const SCHEMA = 'proofline.tools/1';

/** @typedef {{ jobs: number, read: number, unreadable: number, malformed: number, calls: number, bytes: number, denied: number, tools: Map<string, { calls: number, bytes: number }> }} Group */
/** @typedef {{ present: boolean, records: number, skipped: number, corrupt: number, capped: boolean, unreadableFile: boolean, all: Group, roles: Map<string, Group>, runs: Map<string, Group> }} ToolsSummary */

const group = () => /** @type {Group} */ ({ jobs: 0, read: 0, unreadable: 0, malformed: 0, calls: 0, bytes: 0, denied: 0, tools: new Map() });
/** @param {unknown} v */
const count = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
/** @param {unknown} v @param {string} dflt */
const ident = (v, dflt) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9._+:-]/g, '').slice(0, 64) || dflt : dflt);

/** @param {Group} g @param {Record<string, unknown>} d */
function addTo(g, d, calls, bytes, denied, tools) {
  g.jobs++;
  if (d.log === 'ok' && calls !== null && bytes !== null) {
    g.read++; g.calls += calls; g.bytes += bytes; g.denied += denied ?? 0;
    for (const [name, e] of tools) {
      const k = g.tools.has(name) || g.tools.size < MAX_TOOLS_PER_GROUP ? name : 'other';
      const cur = g.tools.get(k) ?? { calls: 0, bytes: 0 };
      cur.calls += e.calls; cur.bytes += e.bytes; g.tools.set(k, cur);
    }
  } else if (d.log === 'malformed') g.malformed++;
  else g.unreadable++;     // unreadable, no-log, or anything else that has no counts: shown as unknown, never as zero
}

/**
 * Read tools.jsonl and add up its records.
 * @param {string} file @param {string} only a task id, or '' for all
 * @returns {ToolsSummary}
 */
export function toolsSummary(file, only) {
  /** @type {ToolsSummary} */
  const s = { present: false, records: 0, skipped: 0, corrupt: 0, capped: false, unreadableFile: false, all: group(), roles: new Map(), runs: new Map() };
  let fd = -1;
  try { fd = openSync(file, 'r'); if (!fstatSync(fd).isFile()) return s; } catch { if (fd >= 0) closeSync(fd); return s; }
  s.present = true;
  let lines = 0;
  /** @param {string} line */
  const take = (line) => {
    if (line === '') return;
    let d;
    try { d = JSON.parse(line); } catch { s.corrupt++; return; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) { s.corrupt++; return; }
    if (d.schema !== SCHEMA) { s.skipped++; return; }
    const task = ident(d.task, 'n/a');
    if (only !== '' && task !== only) return;
    s.records++;
    const role = ident(d.role, 'n/a');
    /** @type {Array<[string, { calls: number, bytes: number }]>} */ const tools = [];
    if (d.by_tool && typeof d.by_tool === 'object' && !Array.isArray(d.by_tool)) {
      for (const [k, e] of Object.entries(d.by_tool)) {
        if (tools.length >= MAX_TOOLS_PER_RECORD) break;
        const c = count(e?.calls); const b = count(e?.bytes);
        if (c !== null && b !== null) tools.push([ident(k, '?'), { calls: c, bytes: b }]);
      }
    }
    const args = /** @type {const} */ ([d, count(d.calls), count(d.result_bytes), count(d.denied), tools]);
    addTo(s.all, ...args);
    for (const [m, key] of /** @type {const} */ ([[s.roles, role], [s.runs, task]])) {
      let g = m.get(key);
      if (!g) { g = group(); m.set(key, g); }
      addTo(g, ...args);
    }
  };
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    /** @type {Buffer[]} */ let part = []; let partLen = 0; let skipping = false;
    outer: for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let from = 0;
      for (let i = 0; i <= n; i++) {
        const nl = i < n && buf[i] === 10;
        if (!nl && i < n) continue;
        // the piece buf[from, i) belongs to the current line; a newline (not the end of the chunk) ends it
        if (!skipping) {
          if (partLen + (i - from) > MAX_LINE) { skipping = true; part = []; partLen = 0; } else { part.push(Buffer.from(buf.subarray(from, i))); partLen += i - from; }
        }
        from = i + 1;
        if (nl) {
          if (++lines > MAX_LINES) { s.capped = true; break outer; }
          if (skipping) s.corrupt++; else take(Buffer.concat(part).toString('utf8'));
          part = []; partLen = 0; skipping = false;
        }
      }
    }
    // text after the last newline is the line being written: complete JSON counts, anything else is not corrupt (it is unfinished)
    if (!s.capped && !skipping && partLen > 0) {
      const t = Buffer.concat(part).toString('utf8');
      let ok = true;
      try { JSON.parse(t); } catch { ok = false; }
      if (ok && ++lines <= MAX_LINES) take(t);
    }
  } catch { s.unreadableFile = true; } finally { try { closeSync(fd); } catch { /* ignore */ } }
  return s;
}

/** The tools of a group, most calls first, ties in byte order. @param {Group} g @param {number} n @returns {Array<{ tool: string, calls: number, bytes: number }>} */
export function topTools(g, n) {
  return [...g.tools].map(([tool, e]) => ({ tool, calls: e.calls, bytes: e.bytes }))
    .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0)).slice(0, n);
}

/** A group as a row of the report: counts are null when no job of the group had a readable log. @param {string} name @param {Group} g */
export function toolsRow(name, g) {
  const k = g.read;
  return {
    name, jobs: g.jobs, jobs_read: k, unreadable: g.unreadable, malformed: g.malformed,
    calls: k === 0 ? null : g.calls, calls_per_job: k === 0 ? null : Math.round((g.calls / k) * 10) / 10,
    result_bytes: k === 0 ? null : g.bytes, bytes_per_job: k === 0 ? null : Math.round(g.bytes / k),
    denied: k === 0 ? null : g.denied, top: topTools(g, 3),
  };
}
