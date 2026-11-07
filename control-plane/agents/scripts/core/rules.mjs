// @ts-check
// Project rules budget (A202; A229: the former scripts/rules.sh). The user's rules and the promoted lessons live in the "## Project rules" section of AGENTS.md.
// This module MEASURES them and PROPOSES; it has no operation that edits or deletes a rule. A change to a rule is made only after the user's own message approves
// that exact change (the lead then edits AGENTS.md); nothing here records or implies an approval. Run through `agent.sh rules <op>`; `proofline doctor` and
// `proofline insights` print the report.
//   list      every rule: id, bytes, text. A promoted lesson keeps its lc-<hash> id, any other rule is r-<hash of its text>.
//   report    the budget (rules.budget_bytes, default 4000; env RULES_BUDGET_BYTES) and the proposals:
//             merge    two rules that mostly repeat each other (word overlap)
//             ask      two rules on one topic where one forbids what the other asks for: a question for the user, never a decision
//             remove   a rule that none of the last reviewed runs cited (rules.unused_after_reviews, default 10; env RULES_UNUSED_AFTER)
//   tally     lead only: append, for each run with a review gate record not yet counted, the rules its review records cite to .agents/local/rule-use.tsv (a
//             git-ignored counter that outlives the run documents). It never touches AGENTS.md.
// A review cites a rule when a record of the run (gates/, results/, reports/) holds the rule's text or its lesson id.
// shortcut: word overlap and negation words are the whole similarity test (no model); it proposes, the user decides.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cksum } from './hash.mjs';
import { requireLead } from './approve.mjs';
import { isDir, isFile } from './paths.mjs';
import { asciiLower } from './shellglob.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** @param {string} p */
function readText(p) { try { return readFileSync(p, 'latin1'); } catch { return ''; } }
const lower = asciiLower;   // `tr '[:upper:]' '[:lower:]'` in the C locale

/** `cfgnum KEY DEFAULT ENV`: the environment value, else the config value, else the default; only digits count. @param {Context} ctx @param {string} key @param {number} def @param {string} envName */
function cfgnum(ctx, key, def, envName) {
  let v = ctx.env[envName] ?? '';
  if (v === '') v = ctx.config().get(key, '');
  return /^[0-9]+$/.test(v) ? Number(v) : def;
}

/** `rules_raw`: the text of each top-level bullet of the section, continuation lines joined, whitespace squeezed. @param {Context} ctx @returns {string[]} */
export function rulesRaw(ctx) {
  const text = readText(`${ctx.root}/AGENTS.md`);
  if (text === '') return [];
  /** @type {string[]} */ const out = [];
  let t = ''; let s = false; let inb = false;
  const flush = () => { if (t !== '') out.push(t.replace(/[ \t]+/g, ' ').replace(/^ /, '').replace(/ $/, '')); t = ''; };
  for (const l of text.replace(/\n$/, '').split('\n')) {
    if (l === '<!-- proofline:begin -->') { flush(); s = false; inb = true; continue; }
    if (l === '<!-- proofline:end -->') { inb = false; continue; }
    if (inb) continue;
    if (/^## Project rules[ \t]*$/.test(l)) { s = true; continue; }
    if (s && (l.startsWith('## ') || l.startsWith('<!-- proofline:'))) { flush(); s = false; }
    if (s && l.startsWith('- ')) { flush(); t = l.slice(2); continue; }
    if (s && /^[ \t]+[^ \t]/.test(l) && t !== '') { t = `${t} ${l}`; continue; }
    if (s && /^[ \t]*$/.test(l)) flush();
  }
  flush();
  return out;
}

/** @typedef {{ id: string, bytes: number, text: string }} Rule */

/** `rules_list`: id, size in bytes and text of every rule. @param {Context} ctx @returns {Rule[]} */
export function rulesList(ctx) {
  return rulesRaw(ctx).map((text) => {
    const m = /^.*\(lesson (lc-[0-9a-f]{8})\)/.exec(text);
    const id = m ? /** @type {string} */ (m[1]) : `r-${Number(cksum(Buffer.from(lower(text), 'latin1'))).toString(16).padStart(8, '0')}`;
    return { id, bytes: text.length, text };
  });
}

/** `live_uses`: "<run>\t<rule id|->" for the reviewed runs (a REVIEW gate record exists) and the rules their records cite. @param {Context} ctx @returns {string[]} */
function liveUses(ctx) {
  const rules = rulesList(ctx);
  /** @type {string[]} */ const out = [];
  /** @type {string[]} */ let runs = [];
  try { runs = readdirSync(`${ctx.root}/.agents/runs`).sort(); } catch { runs = []; }
  /** @param {string} dir @param {RegExp} re */
  const files = (dir, re) => { try { return readdirSync(dir).filter((n) => re.test(n)).sort().filter((n) => isFile(`${dir}/${n}`)).map((n) => `${dir}/${n}`); } catch { return []; } };
  for (const r of runs) {
    const d = `${ctx.root}/.agents/runs/${r}`;
    if (!isDir(d)) continue;
    if (files(`${d}/gates`, /^[0-9]{3}-REVIEW.*\.yaml$/).length === 0) continue;
    out.push(`${r}\t-`);
    const txt = lower([...files(`${d}/gates`, /\.yaml$/), ...files(`${d}/results`, /\.md$/), ...files(`${d}/reports`, /\.md$/)].map(readText).join(''))
      .replace(/\n/g, ' ').replace(/[ \t]+/g, ' ');
    for (const rule of rules) {
      const core = lower(rule.text.replace(/ *\(lesson lc-[0-9a-f]*\)/, ''));
      if (txt !== '' && (txt.includes(core) || (rule.id.startsWith('lc-') && txt.includes(rule.id)))) out.push(`${r}\t${rule.id}`);
    }
  }
  return out;
}

/** `uses`: the counter file and the live scan, one line per run and rule. @param {Context} ctx @returns {string[]} */
function uses(ctx) {
  const tally = readText(`${ctx.root}/.agents/local/rule-use.tsv`).split('\n').filter((l) => l !== '');
  const seen = new Set(); /** @type {string[]} */ const out = [];
  for (const l of [...tally, ...liveUses(ctx)]) {
    if (l.split('\t').length !== 2 || seen.has(l)) continue;
    seen.add(l); out.push(l);
  }
  return out;
}

const STOP = new Set('the and for use are not any all can may this that with from when then than they them have will your into only each also does done must should never always avoid make sure their about which where while those these'.split(' '));
/** @param {string} s */
const neg = (s) => / (never|not|dont|don.t|avoid|forbidden|forbid|without|no) /.test(` ${lower(s)} `);
/** @param {string} s */
const pos = (s) => / (always|must|should|use|prefer|require|required) /.test(` ${lower(s)} `);
/** @param {string} s */
const q = (s) => (s.length > 90 ? `${s.slice(0, 87)}...` : s);

/** The words of a rule: lower case, the lesson id out, letters and digits, at least three characters, no stop word, each once. @param {string} text @returns {string[]} */
function words(text) {
  const s = lower(text).replace(/\(lesson lc-[0-9a-f]+\)/, '').replace(/[^a-z0-9]+/g, ' ');
  /** @type {string[]} */ const out = [];
  for (const w of s.split(' ')) if (w.length >= 3 && !STOP.has(w) && !out.includes(w)) out.push(w);
  return out;
}

/** The proposals of the report. @param {Rule[]} rules @param {string[]} usage @param {number} after @returns {string[]} */
function proposals(rules, usage, after) {
  const reviewed = usage.filter((l) => l.split('\t')[1] === '-').length;
  const cited = new Set(usage.map((l) => l.split('\t')[1]).filter((x) => x !== '-'));
  const w = rules.map((r) => words(r.text));
  /** @type {string[]} */ const out = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const wi = /** @type {string[]} */ (w[i]); const wj = /** @type {string[]} */ (w[j]);
      const ri = /** @type {Rule} */ (rules[i]); const rj = /** @type {Rule} */ (rules[j]);
      const inter = wi.filter((x) => wj.includes(x)).length;
      const un = wi.length + wj.length - inter;
      const mn = Math.min(wi.length, wj.length);
      const jac = un > 0 ? inter / un : 0;
      const cont = mn > 0 ? inter / mn : 0;
      const opp = (neg(ri.text) && !neg(rj.text) && pos(rj.text)) || (neg(rj.text) && !neg(ri.text) && pos(ri.text));
      if (opp && inter >= 3 && jac >= 0.3) out.push(`  ask the user: ${ri.id} says "${q(ri.text)}" but ${rj.id} says "${q(rj.text)}"; which one holds?`);
      else if (jac >= 0.6 || (mn >= 4 && cont >= 0.85)) out.push(`  merge: ${ri.id} and ${rj.id} repeat each other (${Math.trunc(jac * 100)}% of their words are shared): "${q(ri.text)}" / "${q(rj.text)}"`);
    }
  }
  if (reviewed >= after) { for (const r of rules) if (!cited.has(r.id)) out.push(`  remove: ${r.id} was cited by none of the ${reviewed} reviewed runs counted: "${q(r.text)}"`); }
  const np = out.length;
  if (reviewed < after) out.push(`  usage: ${reviewed} reviewed run(s) counted, a rule is proposed for removal only after ${after}`);
  if (np === 0) out.push('  no proposal');
  return out;
}

/** @param {Context} ctx @param {string[]} args the arguments after `rules` */
export function rulesCommand(ctx, args) {
  const op = args[0] ?? '';
  switch (op) {
    case 'list':
      for (const r of rulesList(ctx)) ctx.out(`${r.id}\t${r.bytes}\t${r.text}\n`);
      return 0;
    case 'tally': {
      requireLead(ctx);
      const tally = `${ctx.root}/.agents/local/rule-use.tsv`;
      try { mkdirSync(`${ctx.root}/.agents/local`, { recursive: true }); appendFileSync(tally, ''); } catch { return 1; }
      const done = new Set(readText(tally).split('\n').map((l) => l.split('\t')).filter((p) => p[1] === '-').map((p) => p[0]));
      const add = liveUses(ctx).filter((l) => l.split('\t').length === 2 && !done.has(/** @type {string} */ (l.split('\t')[0])));
      if (add.length > 0) writeFileSync(tally, Buffer.from(readText(tally) + add.map((l) => `${l}\n`).join(''), 'latin1'));
      ctx.out(`rule-use counter: ${readText(tally).split('\n').filter((l) => l.split('\t')[1] === '-' && l.split('\t').length === 2).length} reviewed run(s) counted\n`);
      return 0;
    }
    case 'report': {
      const budget = cfgnum(ctx, 'rules.budget_bytes', 4000, 'RULES_BUDGET_BYTES');
      const after = cfgnum(ctx, 'rules.unused_after_reviews', 10, 'RULES_UNUSED_AFTER');
      const rules = rulesList(ctx);
      const usage = uses(ctx);
      if (rules.length === 0) { ctx.out('project rules: none\n'); return 0; }
      const bytes = rules.reduce((a, r) => a + r.bytes, 0);
      const over = bytes > budget;
      ctx.out(`project rules: ${rules.length} rule(s), ${bytes} bytes, budget ${budget} bytes (${over ? 'OVER' : 'within'})\n`);
      if (over) ctx.out('  the rules are over their budget: merge the repeats, settle the contradictions, drop what no review used\n');
      for (const l of proposals(rules, usage, after)) ctx.out(`${l}\n`);
      ctx.out('  nothing is changed: a rule is merged, answered or removed only after your own message approves that exact change\n');
      return 0;
    }
    default:
      ctx.err('usage: agent.sh rules <list|report|tally>   (there is no operation that changes a rule)\n');
      return 2;
  }
}
