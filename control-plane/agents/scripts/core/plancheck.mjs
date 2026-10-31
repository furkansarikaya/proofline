// @ts-check
// Plan and task checks that `next` makes before the freeze (agent.sh 970-1110, 1985-2020): the migration shape of a destructive plan, the
// assumption register (A79) and the pre-existing defects of a task (A105). Read-only; the awk programs are ported line for line.
import { sha256 } from './hash.mjs';
import { listNames } from './ledger.mjs';
import { fileLines, fileText, gateField, planDestructive, textLines, WS } from './records.mjs';
import { pipelineClass, pipelineNeeds } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** awk `t()`/`trim`: blanks and tabs only. @param {string} s */
const trimBT = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');
/** POSIX [[:space:]] trim. @param {string} s */
const trimWs = (s) => s.replace(new RegExp(`^${WS}+|${WS}+$`, 'g'), '');
/** awk tolower in the C locale. @param {string} s */
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// ---- plan_migration_shape --------------------------------------------------------------------------------------------------------

/**
 * `plan_migration_shape PLAN` -> expand_contract | single_step | missing | none.
 * @param {Context} ctx @param {string} dir the run folder (TASK.md is read from it)
 */
export function planMigrationShape(ctx, dir) {
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (planDestructive(plan) !== 'yes') return 'none';
  let inside = false; let single = false; let late = false; let early = false; let pre = false;
  const single_re = new RegExp(`^${WS}*(-|\\*)?${WS}*single_step:${WS}*yes${WS}*$`);
  for (const line of textLines(plan ?? '')) {
    if (line.startsWith('## ')) { inside = new RegExp(`^## Data${WS}*$`).test(line); continue; }
    if (!inside) continue;
    if (single_re.test(line)) { single = true; continue; }
    if (line.startsWith('|')) {
      const f = line.split('|');
      if (f.length < 7) continue;
      const ph = lower(trimWs(f[2])); const dest = lower(trimWs(f[5]));
      if (!/^(expand|backfill|switch|contract|deferred)$/.test(ph)) continue;
      if (dest === 'yes') { if (ph === 'deferred' || ph === 'contract') late = true; else early = true; }
      else if (/^(expand|backfill|switch)$/.test(ph)) pre = true;
    }
  }
  let pms = single ? 'single_step' : pre && late && !early ? 'expand_contract' : 'missing';
  // A52: `single_step: yes` is only offered when the task states that the user wants one step
  if (pms === 'single_step') {
    const task = fileText(ctx, `${dir}/TASK.md`);
    if (task === null || !/single[- ]step|one[- ]step|one migration|tek ad[\u00c4\u00b1i]m/i.test(task)) pms = 'missing';
  }
  return pms;
}

// ---- the assumption register ------------------------------------------------------------------------------------------------------

/**
 * `assumption_scan FILE` -> lines "NOSECTION", "ERR<TAB>message", "ROW<TAB>id risk status text source method decisions".
 * @param {string} text @returns {string[]}
 */
export function assumptionScan(text) {
  /** @type {string[]} */ const out = [];
  const err = (/** @type {string} */ m) => out.push(`ERR\t${m}`);
  const nomethod = (/** @type {string} */ s) => { const v = lower(trimBT(s)); return v === '' || /^(none|n\/a|-|tbd|todo|unknown)$/.test(v); };
  let inside = false; let found = 0; let none = false; let rows = 0; let hdr = false;
  /** @type {Set<string>} */ const seen = new Set();
  for (const line of textLines(text)) {
    if (line.startsWith('## ')) { inside = /^## Assumptions[ \t]*$/.test(line); if (inside) found++; continue; }
    if (!inside || found > 1) continue;
    if (/^[ \t]*$/.test(line)) continue;
    if (lower(trimBT(line)) === 'none') { none = true; continue; }
    if (/^[ \t]*\|.*\|[ \t]*$/.test(line)) {
      const f = ['', ...line.split('|')]; // awk fields are 1-based
      const NF = f.length - 1;
      const t = (/** @type {number} */ i) => trimBT(f[i] ?? '');
      if (!hdr) {
        hdr = true;
        if (NF !== 9 || lower(`${t(2)}|${t(3)}|${t(4)}|${t(5)}|${t(6)}|${t(7)}|${t(8)}`) !== 'id|assumption|source|risk|verification|status|decisions') err('Assumptions: header must be | id | assumption | source | risk | verification | status | decisions |');
        continue;
      }
      if (/^:?-+:?$/.test(t(2))) continue;
      rows++;
      const id = t(2); const risk = t(5); const st = t(7);
      if (NF !== 9) { err(`Assumptions ${id}: expected 7 columns`); continue; }
      if (!/^AS-[0-9]+$/.test(id)) err(`Assumptions ${id}: id must match AS-<n>`);
      if (seen.has(id.toUpperCase())) err(`Assumptions ${id}: duplicate id`);
      seen.add(id.toUpperCase());
      if (t(3) === '') err(`Assumptions ${id}: assumption text is empty`);
      if (t(4) === '') err(`Assumptions ${id}: source is empty`);
      if (risk !== 'low' && risk !== 'medium' && risk !== 'high') err(`Assumptions ${id}: risk must be low|medium|high`);
      if (st !== 'verified' && st !== 'unverified') err(`Assumptions ${id}: status must be verified|unverified (accepted-by-user is recorded by the run, not written here)`);
      if (st === 'verified' && nomethod(t(6))) err(`Assumptions ${id}: verified without a verification method`);
      if (risk === 'high' && nomethod(t(6))) err(`Assumptions ${id}: a high-risk assumption needs a verification method`);
      if (t(8) === '') err(`Assumptions ${id}: decisions is empty`);
      out.push(`ROW\t${id}\t${risk}\t${st}\t${t(3)}\t${t(4)}\t${t(6)}\t${t(8)}`);
      continue;
    }
    err(`Assumptions: "${trimBT(line)}" is not a table row (write none or the table)`);
  }
  if (found === 0) { out.push('NOSECTION'); return out; }
  if (found > 1) err('section "## Assumptions" appears more than once');
  else if (none && rows) err('Assumptions: "none" together with rows');
  else if (!none && !rows) err('section "## Assumptions" has no rows: write none or the table');
  return out;
}

/** `assumption_shape_errors ID` -> one problem per line. @param {Context} ctx @param {string} dir @returns {string[]} */
export function assumptionShapeErrors(ctx, dir) {
  /** @type {string[]} */ const out = [];
  for (const f of ['PLAN.md', 'EVIDENCE.md']) {
    const text = fileText(ctx, `${dir}/${f}`);
    if (f === 'EVIDENCE.md' && (text === null || pipelineNeeds(ctx, dir, 'evidence') !== 'yes')) continue;
    if (text === null) continue;
    for (const row of assumptionScan(text)) {
      if (row === 'NOSECTION') out.push(`${f}: the mandatory '## Assumptions' section is missing (write 'none' or the register table)`);
      else if (row.startsWith('ERR\t')) out.push(`${f}: ${row.slice(4).replace(/^[ \t]+|[ \t]+$/g, '')}`);
    }
  }
  return out;
}

/** `assumption_register ID` rows: [id, risk, status, text, source, method, decisions]. @param {Context} ctx @param {string} dir @returns {string[][]} */
function assumptionRegister(ctx, dir) {
  const rows = [];
  for (const f of ['PLAN.md', 'EVIDENCE.md']) {
    const text = fileText(ctx, `${dir}/${f}`);
    if (text === null) continue;
    for (const r of assumptionScan(text)) if (r.startsWith('ROW\t')) rows.push(r.split('\t').slice(1));
  }
  /** @type {Map<string, {risk: string, rank: number, st: string, rest: string[]}>} */ const m = new Map();
  for (const [id, risk, st, ...rest] of rows) {
    const rank = risk === 'high' ? 3 : risk === 'medium' ? 2 : 1;
    const cur = m.get(id);
    if (!cur) { m.set(id, { risk, rank, st, rest }); continue; }
    if (rank > cur.rank) { cur.rank = rank; cur.risk = risk; }
    if (st === 'unverified') cur.st = 'unverified';
  }
  return [...m.entries()].map(([id, v]) => [id, v.risk, v.st, ...v.rest]);
}

/** `assumption_state ID TOKEN` -> "accepted REF" | "pending REF" | "declined REF" | "none". @param {Context} ctx @param {string} dir @param {string} token */
function assumptionState(ctx, dir, token) {
  const id = token.slice(0, token.lastIndexOf('@'));
  const line = new RegExp(`^${WS}*ASSUMPTION: ${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${WS}*$`);
  let pend = ''; let decl = '';
  for (const q of listNames(`${dir}/questions`, /^[0-9]{3}\.md$/)) {
    if (!fileLines(ctx, `${dir}/questions/${q}`).some((l) => line.test(l))) continue;
    const a = `${q.slice(0, -3)}.answer.md`;
    const answer = `${dir}/questions/${a}`;
    const at = fileText(ctx, answer);
    if (at === null) { pend = `questions/${q}`; continue; }
    if (gateField(ctx, answer, 'answered_by') === 'user') {
      const ls = textLines(at);
      const end = ls.findIndex((l, i) => i > 0 && l === '---'); // sed '1,/^---$/d'
      const body = end < 0 ? '' : ls.slice(end + 1).join('\n');
      const one = body.replace(new RegExp(`${WS}+`, 'g'), ' ').replace(/^ /, '');
      if (new RegExp(`^accept(ed)?${WS}+${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`, 'i').test(one)) return `accepted questions/${a}`;
    }
    decl = `questions/${a}`;
  }
  if (pend !== '') return `pending ${pend}`;
  return decl !== '' ? `declined ${decl}` : 'none';
}

/** `assumption_blocked ID`: the blocked high-risk assumptions (empty = none). @param {Context} ctx @param {string} dir */
export function assumptionBlocked(ctx, dir) {
  /** @type {string[]} */ const out = [];
  for (const [a, r, s, t] of assumptionRegister(ctx, dir)) {
    if (s === 'verified') continue;
    const tok = `${a}@${sha256(t).slice(0, 12)}`;
    if (assumptionState(ctx, dir, tok).startsWith('accepted')) continue;
    if (r === 'high') out.push(a);
  }
  return out;
}

// ---- the task's pre-existing defects ----------------------------------------------------------------------------------------------

/** `task_defect_fixes TASK.md`: the lines that say `decision: fix` under `## Pre-existing defects`. @param {string | null} text */
export function taskDefectFixes(text) {
  /** @type {string[]} */ const out = [];
  let i = false;
  for (const l of textLines(text ?? '')) {
    if (new RegExp(`^###?${WS}+[Pp]re-existing defects${WS}*$`).test(l)) { i = true; continue; }
    if (l.startsWith('#')) i = false;
    if (i && new RegExp(`decision:${WS}*fix`).test(lower(l))) out.push(l);
  }
  return out;
}

const DEFECT_SEC_RE = 'defects?|bugs?|regression|fix|fixes|fixing';
const DEFECT_SEC_TR = /kusur|d\u00c3\u00bczelt/;

/** `task_defect_errors ID` (A105): the first error line, or ''. @param {Context} ctx @param {string} dir */
export function taskDefectError(ctx, dir) {
  const text = fileText(ctx, `${dir}/TASK.md`);
  if (text === null) return '';
  const cls = pipelineClass(ctx, dir);
  const big = cls === 'COMPLEX' || cls === 'CRITICAL';
  const w = (/** @type {string} */ s, /** @type {string} */ re) => new RegExp(`[^a-z](${re})[^a-z]`).test(` ${s} `);
  let c = false; let req = ''; let sec = ''; let d = false; let n = 0; let m = '';
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    if (line.includes('<!--')) c = true;
    if (c) { if (line.includes('-->')) c = false; continue; }
    if (k === 0 && line.startsWith('# Task:')) { req += ` ${lower(line)}`; continue; }
    if (new RegExp(`^###?${WS}`).test(line)) {
      const h = line.replace(/^#+[ \t\n\v\f\r]+/, '').replace(new RegExp(`${WS}+$`), '');
      d = lower(h) === 'pre-existing defects';
      if (line.startsWith('## ')) sec = h;
      continue;
    }
    if (d && new RegExp(`^${WS}*[-*]${WS}+[^ \\t\\n\\v\\f\\r]`).test(line)) {
      n++;
      if (!new RegExp(`decision:${WS}*(report|fix)([^a-z]|$)`).test(lower(line))) {
        const e = line.replace(new RegExp(`^${WS}*[-*]${WS}+`), '');
        // awk prints and `head -1` keeps the first printed line: this is the first error of the file
        return `entry without decision: report|fix: ${e}`;
      }
      continue;
    }
    if (d) continue;
    if (new RegExp(`^${WS}*>`).test(line) || sec === 'Goal' || sec === 'Suggested class') { req += ` ${lower(line)}`; continue; }
    if ((sec === 'Context' || sec === 'Acceptance criteria' || sec === 'Constraints' || sec === 'Risks') && m === '') {
      const l = lower(line);
      if (w(l, DEFECT_SEC_RE) || DEFECT_SEC_TR.test(l)) m = line.replace(new RegExp(`^${WS}*[-*]${WS}+`), '');
    }
  }
  if (!big || m === '' || n > 0) return '';
  if (w(req, 'bugs?|defects?|regression|broken|fix|fixes|fixed|wrong|incorrect|crash(es)?|disappears?|disappeared|unreachable') || /hata|bozuk|kaybol|yanl\u00c4\u00b1\u00c5\u009f|d\u00c3\u00bczelt/.test(req)) return '';
  return `mentions a defect or a fix the request does not ask for: ${m.replace(/[.]$/, '').slice(0, 120)}`;
}
