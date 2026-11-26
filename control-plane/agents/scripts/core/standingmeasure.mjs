// @ts-check
// Standing approvals of measured visual items (A380, issue 338 C3, the part A361.1 deferred): a failing measured item of the QA visual report
// (`touch_target`, `design_empty_hero`, ...) that the user waived with `standing` is carried to later tasks, batches and runs, but only for what was
// approved: the same check, the same threshold, a value NO WORSE than the approved one, and the same page, or a page of the same KIND whose path
// matches the glob the request showed the user (one row per kind, not one per file).
//
// Invariant 3 and 6: the row is written only from the user's message (gatecmd.mjs `carryWaivers`, after `approveOne` recorded it), it is verified
// at every use against that message (standing.mjs), and every doubt asks again: a page whose path the approved glob does not match (a page that
// declares a kind it is not), a page the current report does not declare of that kind, a worse value, another threshold, a report item that does not
// say exactly what the finding says, or an unreadable report. `design_raw_markup` is never carried (A368: always blocking). SECRETS and SECURITY
// findings never reach here (only a QA visual record has a measured item).
// The measured values come from the QA agent's visual report: they have the trust of every agent-reported visual fact (A368 LIMITS); the control
// plane checks that the finding and the report item agree, it does not measure again.
import { lstatSync, readFileSync } from 'node:fs';
import { canon } from './kirules.mjs';
import { sha256 } from './hash.mjs';
import { readStanding } from './standing.mjs';

/** @typedef {import('./context.mjs').Context} Context */
/** @typedef {{ rule: string, surface: string, threshold: string, value: string, path: string, kind: string, glob: string, fp: string }} MeasureKey */

/** Measured checks that are never carried (A368: raw markup is always blocking; the lint id is listed for the safe side). */
export const MEASURE_NEVER = ['design_raw_markup', 'raw-markup-in-text', 'raw_markup_in_text'];

// ---- page kinds: the same rules as visual-proof's design-audit.mjs (the skill is installed apart, so they are written here too) ---------------

export const PAGE_KIND_ID = /^[a-z][a-z0-9-]{0,39}$/;
const PAGE_GLOB = /^[A-Za-z0-9_.*?-][A-Za-z0-9_.*?/-]*$/;
const PAGE_PATH = /^[A-Za-z0-9_.@+-][A-Za-z0-9_.@+/-]*$/;

/** A relative glob of letters, digits, `_ . - / * ?` without an empty, `.` or `..` segment. @param {unknown} g @returns {g is string} */
export const pageGlobOk = (g) => typeof g === 'string' && g.length <= 200 && PAGE_GLOB.test(g) && !g.split('/').some((s) => s === '' || s === '.' || s === '..');

/** `*` inside a segment, `**` across segments, `?` one character; nothing else is special. @param {string} g */
export function pageGlobRe(g) {
  let s = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { s += '.*'; i++; } else s += '[^/]*'; } else if (c === '?') s += '[^/]'; else s += c.replace(/[.\\+^$()|{}[\]-]/g, '\\$&');
  }
  return new RegExp(`${s}$`);
}

/** The page path a glob is matched against (leading `/` and `./` dropped); null for a path with a query, a fragment, odd characters or a `..` segment. @param {unknown} p */
export function pageKindPath(p) {
  const t = String(p ?? '').replace(/^(?:\.?\/)+/, '');
  return PAGE_PATH.test(t) && t.length <= 400 && !t.split('/').some((s) => s === '' || s === '.' || s === '..') ? t : null;
}

/** The one kind whose glob matches the path, or null (no kind, or two kinds: the safe side). @param {unknown} kinds @param {string} p @returns {{ kind: string, glob: string } | null} */
export function pageKindOf(kinds, p) {
  if (!Array.isArray(kinds)) return null;
  /** @type {{ kind: string, glob: string }[]} */ const hits = [];
  for (const k of kinds) {
    if (k === null || typeof k !== 'object' || typeof k.kind !== 'string' || !PAGE_KIND_ID.test(k.kind) || !Array.isArray(k.paths)) continue;
    const g = k.paths.find((/** @type {unknown} */ x) => pageGlobOk(x) && pageGlobRe(x).test(p));
    if (g !== undefined) hits.push({ kind: k.kind, glob: g });
  }
  return hits.length === 1 ? hits[0] : null;
}

// ---- thresholds and values ---------------------------------------------------------------------------------------------------------------

const NUM = /^-?[0-9]+(?:\.[0-9]+)?$/;
/** @param {string} t */
function parseThreshold(t) {
  const m = /^(==|>=|<=|>|<) (-?[0-9]+(?:\.[0-9]+)?)$/.exec(t);
  if (m !== null) return { op: m[1], a: Number(m[2]), b: Number(m[2]) };
  const r = /^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/.exec(t);
  return r === null ? null : { op: 'range', a: Number(r[1]), b: Number(r[2]) };
}

/** How far a value is from holding the threshold (0 when it holds; a larger number is worse), or null for a threshold of no known form. @param {string} t @param {number} v */
export function shortfall(t, v) {
  const p = parseThreshold(t);
  if (p === null || !Number.isFinite(v)) return null;
  switch (p.op) {
    case '>=': case '>': return Math.max(0, p.a - v);
    case '<=': case '<': return Math.max(0, v - p.a);
    case '==': return Math.abs(v - p.a);
    default: return v < p.a ? p.a - v : v > p.b ? v - p.b : 0;
  }
}

/** The fingerprint of a measure row: check, surface, threshold and the approved value. @param {string} rule @param {string} surface @param {string} threshold @param {string} value */
export const measureFp = (rule, surface, threshold, value) => sha256(`measure\n${rule}\n${surface}\n${threshold}\n${value}\n`);

// ---- the key of a finding ----------------------------------------------------------------------------------------------------------------

/** The run's visual report, or null (not a plain single-link file, over 32 MiB, or not JSON). @param {Context} ctx @param {string} id @returns {any} */
function visualReport(ctx, id) {
  return ctx.once(`standing:report:${id}`, () => {
    const f = `${ctx.root}/.agents/runs/${id}/reviews/visual-proof/report.json`;
    try {
      const st = lstatSync(f);
      if (!st.isFile() || st.nlink !== 1 || st.size > 32 * 1024 * 1024) return null;
      const j = JSON.parse(readFileSync(f, 'utf8'));
      return j !== null && typeof j === 'object' && !Array.isArray(j) ? j : null;
    } catch { return null; }
  });
}

/**
 * The standing key of a blocking finding of a QA visual record that is a failed MEASURED item, or null. The finding text must be the validator's
 * row of exactly one report item (`<id> <check>: <value> fails <threshold> at <screen>/...`), and that item must say the same (status fail, numeric
 * value, threshold). The page is the item's screen path; its kind is the report's `page_kinds` entry whose glob matches it (exactly one).
 * @param {Context} ctx @param {string} id @param {string} rec @param {string} fid @returns {MeasureKey | null}
 */
export function standingMeasureKey(ctx, id, rec, fid) {
  const c = canon(ctx, rec, fid);
  if (c === null || c.gate !== 'QA:visual') return null;
  const head = /^([MD]-[0-9]+) ([a-z][a-z0-9_]*): /.exec(c.text);
  if (head === null || MEASURE_NEVER.includes(head[2])) return null;
  const rep = visualReport(ctx, id);
  if (rep === null) return null;
  const core = head[1].startsWith('M-');
  const list = core ? rep.measured : rep.design?.items;
  const it = Array.isArray(list) ? list.find((/** @type {any} */ x) => x !== null && typeof x === 'object' && x.id === head[1]) : undefined;
  if (it === undefined || it.check !== head[2] || it.status !== 'fail' || typeof it.value !== 'number' || !Number.isFinite(it.value) || typeof it.threshold !== 'string' || typeof it.screen !== 'string') return null;
  const value = String(it.value);
  const threshold = it.threshold.trim();
  if (!NUM.test(value) || shortfall(threshold, it.value) === null) return null;
  if (!c.text.startsWith(`${it.id} ${it.check}: ${value} fails ${threshold} at ${it.screen}/`)) return null;
  const pages = core ? rep.screens : rep.design?.pages;
  const pg = Array.isArray(pages) ? pages.find((/** @type {any} */ x) => x !== null && typeof x === 'object' && (core ? x.id : x.screen) === it.screen) : undefined;
  const p = pageKindPath(pg?.path);
  if (p === null) return null;
  const pk = pageKindOf(rep.page_kinds, p);
  const surface = pk === null ? `page:${p}` : `kind:${pk.kind}:${pk.glob}`;
  return { rule: it.check, surface, threshold, value, path: p, kind: pk?.kind ?? '', glob: pk?.glob ?? '', fp: measureFp(it.check, surface, threshold, value) };
}

/**
 * Does a verified measure row cover this key? The same check; the row's own fingerprint recomputed with the key's threshold (another threshold, or a
 * row edited by hand, does not match); a value no worse than the approved one; and the same page, or a page the report declares of the row's kind
 * AND whose path matches the row's glob (the glob the user approved, never the report's current one).
 * @param {import('./standing.mjs').StandingRow} r @param {MeasureKey} k
 */
export function measureCovers(r, k) {
  if (r.scope !== 'measure' || r.rule !== k.rule || r.value === undefined || !NUM.test(r.value)) return false;
  if (measureFp(r.rule, r.surface, k.threshold, r.value) !== r.fp) return false;
  const now = shortfall(k.threshold, Number(k.value));
  const ok = shortfall(k.threshold, Number(r.value));
  if (now === null || ok === null || now > ok) return false;
  if (r.surface.startsWith('page:')) return r.surface.slice(5) === k.path;
  const m = /^kind:([a-z][a-z0-9-]{0,39}):(.+)$/.exec(r.surface);
  return m !== null && k.kind === m[1] && pageGlobOk(m[2]) && pageGlobRe(m[2]).test(k.path);
}

/** The finding is a measured item the user waived with `standing` for this check, threshold and page (or kind) at a value no worse. @param {Context} ctx @param {string} id @param {string} rec @param {string} fid */
export function findingStandingMeasured(ctx, id, rec, fid) {
  const rows = readStanding(ctx).filter((r) => r.scope === 'measure');
  if (rows.length === 0) return false;   // nothing stands (the usual case): no report read
  const k = standingMeasureKey(ctx, id, rec, fid);
  return k !== null && rows.some((r) => measureCovers(r, k));
}

/** What a measure surface means, for the request and the standing list. @param {string} surface */
export function measureWhere(surface) {
  if (surface.startsWith('page:')) return `the page ${surface.slice(5)}`;
  const m = /^kind:([^:]+):(.*)$/.exec(surface);
  return m === null ? surface : `pages of kind ${m[1]} (paths ${m[2]})`;
}

/**
 * The rows one standing waiver writes for measured findings: one per (check, surface, threshold), carrying the WORST value of the group (the user
 * approved every finding of it), so later pages of that kind are not asked again while they are no worse.
 * @param {Context} ctx @param {string} id @param {string} rec @param {string[]} list @returns {MeasureKey[]}
 */
export function measureRows(ctx, id, rec, list) {
  /** @type {Map<string, MeasureKey>} */ const by = new Map();
  for (const f of list) {
    const k = standingMeasureKey(ctx, id, rec, f);
    if (k === null) continue;
    const key = `${k.rule}\t${k.surface}\t${k.threshold}`;
    const had = by.get(key);
    if (had === undefined || (shortfall(k.threshold, Number(k.value)) ?? 0) > (shortfall(had.threshold, Number(had.value)) ?? 0)) by.set(key, k);
  }
  return [...by.values()];
}
