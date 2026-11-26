// @ts-check
// Stage 4, package 4C: `publish-completion-report` and `verify-completion-report` with everything only they used in agent.sh 0.0.47 (the structure
// checks, the claims-against-records check, the summary block, the Execution table, the Facts block). The task adapter's `publish` and `verify`
// operations stay shell code (stage 7) and run as clean children. Messages, the order of the checks and the bytes of the report are those of the shell.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { fail, ProoflineError } from './errors.mjs';
import { requireLead } from './approve.mjs';
import { verifySeal } from './ledger.mjs';
import { gateReportIds } from './next.mjs';
import { led, must, quietly } from './lifeutil.mjs';
import { localTaskSource, localTaskSourceRun, setRunValue } from './lifecycle.mjs';
import { isFile } from './paths.mjs';
import { adapterExists, runTaskAdapter } from './adapters/index.mjs';
import * as proc from './proc.mjs';
import { assumptionStates } from './questions.mjs';
import { fileLines, fileText, gateField, gatesEnforced, ledgerRows, sectionValue } from './records.mjs';
import { evidenceRunCounts, fixRoundsDone, reportExecution, reportFacts } from './reports.mjs';
import { requireRun, runDir } from './runs.mjs';
import { languageFailText, languageScanFiles } from './language.mjs';
import { asciiLower } from './shellglob.mjs';
import { fixRoundsLedger, fixRoundsUsed, gateLatestFile, maxFixRounds, requiredGates, riskNotRerun, riskUnsupported } from './gates.mjs';
import { sha256, sha256File } from './hash.mjs';
import { humanChecks, records, sectionLines } from './taskfile.mjs';
import { freshness } from './commands/verify.mjs';
import { listNames } from './ledger.mjs';
import { latin1Buf } from './wirebytes.mjs';
import { auditClaims, checkClaimsBlock, claimsBlock, CLAIMS_BEGIN, CLAIMS_END, duplicateBlocks, verifyClaimsBlock } from './verifyclaims.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const SUMMARY_BEGIN = '<!-- proofline:summary:begin -->';
const SUMMARY_END = '<!-- proofline:summary:end -->';
const FACTS_BEGIN = '<!-- proofline:facts:begin -->';
const FACTS_END = '<!-- proofline:facts:end -->';
const WS = '[ \\t\\n\\v\\f\\r]';

/** @param {string} s */
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Byte order, like `sort` in the C locale. @param {string} a @param {string} b */
const byBytes = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** `grep '[^[:space:]]'` over a text. @param {string} s */
const hasText = (s) => new RegExp(`[^ \\t\\n\\v\\f\\r]`).test(s);

/** Run a writer and return what it printed to stdout; its stderr stays. @param {Context} ctx @param {() => void} fn */
function capture(ctx, fn) {
  const mark = ctx.chunks.length;
  fn();
  const taken = ctx.chunks.splice(mark);
  let text = '';
  for (const c of taken) { if (c[0] === 'out') text += c[1].toString('latin1'); else ctx.chunks.push(c); }
  return text;
}

/** The lines of the section opened by `## HEADING` (to the next `## `), as awk `/^## H[ \t]*$/ { i = 1; next } /^## / { i = 0 } i`. @param {string[]} lines @param {string} heading */
function sectionBody(lines, heading) {
  const open = new RegExp(`^## ${reEsc(heading)}[ \\t]*$`);
  /** @type {string[]} */ const out = [];
  let i = false;
  for (const l of lines) {
    if (open.test(l)) { i = true; continue; }
    if (l.startsWith('## ')) i = false;
    if (i) out.push(l);
  }
  return out;
}

/** `adapter_script ADAPTER`: the adapter must exist (a project script or a built-in one). The name is one file name (a slash or a control character never leaves the folder). @param {Context} ctx @param {string} adapter */
function adapterScript(ctx, adapter) {
  if (!adapterExists(ctx.root, adapter)) fail(`unknown task-integration adapter: ${adapter}`);
  return adapter;
}

// ---- the structure of the report -------------------------------------------------------------------------------------------------

/** `report_blank_summary`: the summary block's lines blanked, line numbers kept. @param {string} text */
function blankSummary(text) {
  /** @type {string[]} */ const out = [];
  let skip = false; let done = false;
  for (const l of records(text)) {
    if (l === SUMMARY_BEGIN && !done) { skip = true; out.push(''); continue; }
    if (skip) { if (l === SUMMARY_END) { skip = false; done = true; } out.push(''); continue; }
    out.push(l);
  }
  return out.map((l) => `${l}\n`).join('');
}

/** `task_section_lines TASK.md 'Completion response'` has text. @param {Context} ctx @param {string} dir */
function completionResponseAsked(ctx, dir) {
  const t = fileText(ctx, `${dir}/TASK.md`);
  if (t === null) return false;
  return sectionLines(t, 'Completion response', false).some(hasText);
}

/** `required_report_headings DIR` @param {Context} ctx @param {string} dir @returns {string[]} */
function requiredHeadings(ctx, dir) {
  const h = ['Implementation Summary', 'Verification', 'Assumptions', 'Known Limitations / Follow-up'];
  const gl = requiredGates(ctx, dir);
  if (gl.some((g) => g.startsWith('REVIEW_') || g.startsWith('SECURITY'))) h.push('Review Result');
  if (gl.includes('QA')) h.push('QA Result');
  if (existsSync(`${dir}/worker-evidence`)) h.push('TDD Evidence');
  if (listNames(`${dir}/reports`, /^[0-9]{3}-debug\.md$/).length > 0) h.push('Root cause');
  let amend = [];
  try { amend = readdirSync(`${dir}/amendments`); } catch { /* none */ }
  if (amend.length > 0) h.push('Amendments');
  if (listNames(`${dir}/gates`, /-REOPEN\.yaml$/).length > 0) h.push('Reopen History');
  if (listNames(`${dir}/waivers`, /\.yaml$/).length > 0) h.push('Waivers');
  if (listNames(`${dir}/decisions`, /^[0-9]{3}-.*\.decision$/).length > 0) h.push('Execution');
  if (riskUnsupported(ctx, dir).length > 0) h.push('Unsupported Checks');
  if (completionResponseAsked(ctx, dir)) h.push('Requested Response');
  return h;
}

/**
 * `report_key_lines REPORT KEY`: the lines that name KEY exactly (the next character is not part of a longer focus), case-insensitive.
 * @param {string[]} lines @param {string} key
 */
function keyLines(lines, key) {
  const k = asciiLower(key);
  /** @type {string[]} */ const out = [];
  for (const line of lines) {
    let l = asciiLower(line);
    for (let i = l.indexOf(k); i >= 0; i = l.indexOf(k)) {
      const c = l.charAt(i + k.length);
      if (c === '' || !/[a-z0-9_+-]/.test(c)) { out.push(line); break; }
      l = l.slice(i + k.length);
    }
  }
  return out;
}

/** `report_names_id REPORT GATE ID`: a line names the gate exactly and carries the finding id (by key). @param {string[]} lines @param {string} gate @param {string} id */
function namesId(lines, gate, id) {
  const g = asciiLower(gate); let base = asciiLower(id);
  let n = base.replace(/^.*-/, '');
  base = base.replace(/-[0-9]+$/, '');
  n = n.replace(/^0+/, '');
  if (n === '') n = '0';
  const idre = new RegExp(`(^|[^a-z0-9_-])${reEsc(base)}-0*${reEsc(n)}([^0-9]|$)`);
  const gre = new RegExp(`${reEsc(g)}-[0-9]+`, 'g');
  const gname = new RegExp(`(^|[^a-z0-9_-])${reEsc(g)}([^a-z0-9_-]|$)`);
  for (const line of lines) {
    let l = asciiLower(line);
    if (!idre.test(l)) continue;
    l = l.replace(gre, '');
    if (gname.test(l)) return true;
  }
  return false;
}

/** `validate_completion_report_structure ID` @param {Context} ctx @param {string} id */
function validateStructure(ctx, id) {
  const dir = runDir(ctx, id);
  let report = `${dir}/COMPLETION_REPORT.md`;
  const raw = fileText(ctx, report);
  if (raw === null) fail(`completion report missing: ${report}`);
  if (raw.length < 200) fail('completion report is too short to be meaningful');
  // A202: the evidence checks below read the report without its summary block (the summary is a note to the user, not evidence)
  mkdirSync(`${dir}/scratch`, { recursive: true });
  const evidence = blankSummary(raw);
  report = `${dir}/scratch/COMPLETION_REPORT.evidence.md`;
  writeFileSync(report, latin1Buf(evidence));
  const lines = records(evidence);
  for (const h of requiredHeadings(ctx, dir)) if (!evidence.includes(`## ${h}`)) fail(`completion report missing required section: ## ${h}`);
  if (completionResponseAsked(ctx, dir) && !sectionBody(lines, 'Requested Response').some(hasText)) {
    fail("completion report: the '## Requested Response' section is empty (the task's Completion response asks for a final summary in its own format: write it there, and end your last message with the same text)");
  }
  // A79: every assumption that is not verified is listed in `## Assumptions`
  const sec = sectionBody(lines, 'Assumptions');
  if (!sec.some(hasText)) fail("completion report: the '## Assumptions' section is empty (list every unverified and accepted-by-user assumption, or write none)");
  /** @type {string[]} */ const missed = [];
  for (const row of assumptionStates(ctx, dir)) {
    const [a = '', , s = '', ref = ''] = row;
    if (s === 'verified') continue;
    const named = sec.filter((l) => new RegExp(`(^|[^A-Za-z0-9-])${reEsc(a)}([^0-9]|$)`).test(l));
    if (named.length === 0) { missed.push(a); continue; }
    // the line naming the id states its status (unverified | accepted-by-user): "AS-1 verified" does not pass
    if (!named.some((l) => new RegExp(`(^|[^A-Za-z-])${reEsc(s)}([^A-Za-z-]|$)`).test(l))) { missed.push(`${a}(${s})`); continue; }
    if (s === 'accepted-by-user' && !sec.join('\n').includes(ref.slice(ref.lastIndexOf('/') + 1))) missed.push(`${a}(answer ${ref})`);
  }
  if (missed.length > 0) fail(`completion report: '## Assumptions' does not list: ${missed.map((m) => `${m} `).join('')}(every unverified assumption by id with its status word, unverified or accepted-by-user; an accepted one with its answer file)`);
  // A78/A98: every UNSUPPORTED check is named in the report on a line that says what it leaves unproven
  const usec = sectionBody(lines, 'Unsupported Checks');
  // A130: a gate that re-ran nothing has its own report line saying 'not reproduced (NOT_RERUN)'; every finding row of a gate is named by id
  let gaps = '';
  for (const n of [...new Set(riskNotRerun(ctx, dir).map((x) => x.split(' ')[0]))].sort(byBytes)) {
    const nl = keyLines(lines, n);
    if (!nl.join('\n').includes('not reproduced (NOT_RERUN)')) gaps += `\n- gate ${n} re-ran nothing: add the line '- ${n}: not reproduced (NOT_RERUN)'`;
    const bad = nl.find((l) => /reproduced/i.test(l.replace(/not reproduced/gi, '')));
    if (bad !== undefined) gaps += `\n- the line naming ${n} calls it reproduced: "${bad}" (it is 'not reproduced (NOT_RERUN)')`;
  }
  for (const g of requiredGates(ctx, dir)) {
    let miss = '';
    for (const i of gateReportIds(ctx, dir, g)) if (!namesId(lines, g, i)) miss += ` ${i}`;
    if (miss !== '') gaps += `\n- gate ${g}: name the finding id(s)${miss}, each on a line that also names ${g} (for example '- ${g}: ${miss.slice(1)} <severity> <what>'); an id is a finding row of the gate record, info rows included, and 'none' is true only for a gate with no finding row`;
  }
  if (gaps !== '') fail(`completion report is incomplete (A130):${gaps}`);
  for (const u of [...new Set(riskUnsupported(ctx, dir).map((x) => x[0]))].sort(byBytes)) {
    if (!usec.some((l) => l.includes(u))) fail(`completion report must name the UNSUPPORTED check ${u} under '## Unsupported Checks'`);
    // 'not proven:' says what, in at least three words ('n/a' is not an answer)
    const ok = usec.filter((l) => l.includes(u)).some((l) => {
      const m = new RegExp(`^[^]*not proven:${WS}*`).exec(l);
      if (m === null) return false;
      return l.slice(m[0].length).split(new RegExp(`${WS}+`)).filter((w) => /[A-Za-z][A-Za-z]/.test(w)).length >= 3;
    });
    if (!ok) fail(`completion report: the line naming the UNSUPPORTED check ${u} under '## Unsupported Checks' must say 'not proven: <what>' in at least three words (an unproven claim is never reported as verified)`);
  }
}

// ---- claims against the records ---------------------------------------------------------------------------------------------------

/** awk `numwords`: the words one to twenty become digits. @param {string} str */
function numWords(str) {
  const w = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
  let s = str;
  for (let i = 1; i <= 20; i++) {
    const re = new RegExp(`(^|[^a-z0-9_-])${w[i - 1]}( |$)`);
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      const lead = m[0].startsWith(w[i - 1]) ? '' : m[0].charAt(0);
      const trail = m[0].endsWith(' ') ? ' ' : '';
      s = s.slice(0, m.index) + lead + String(i) + trail + s.slice(m.index + m[0].length);
    }
  }
  return s;
}

const B = '(^|[^0-9a-z._-])';
const RE = {
  tb: new RegExp(`${B}[0-9]+ +((new|unit|integration|e2e|regression|failing|passing|passed|added|existing|total) +)*tests?([^a-z_]|$)`),
  ta: new RegExp(`${B}tests?( (run|passed|failed|passing|failing|total|count))* *[:=] *[0-9]+`),
  gb: new RegExp(`${B}[0-9]+ +((required|review|blocking|lifecycle|passing|failing|passed|failed|total) +)*gates?([^a-z_]|$)`),
  ga: new RegExp(`${B}gates?( (required|passed|failed|passing|total|count))* *[:=] *[0-9]+`),
  rb: new RegExp(`${B}[0-9]+ +((more|extra|total) +)?fix +rounds?([^a-z_]|$)`),
  ra: new RegExp(`${B}fix +rounds?( +(used|taken|needed|count|total))* *[:=]? *[0-9]+`),
  fb: new RegExp(`${B}[0-9]+ +refreezes?([^a-z_]|$)`),
  fa: new RegExp(`${B}refreezes?( +(count|total))* *[:=]? *[0-9]+`),
};
const NOT_COUNT = /^(the|a|an|this|that|these|those|its|their|each|every|how|whether|it|cases?|files?|suites?|scenarios?|commands?|fixtures?|names?|helpers?)([^a-z_]|$)/;
const NOT_FAIL = /^(failed|failing|fail|skipped|failures?)([^a-z_]|$)/;

/** `report_claims_check ID FILE`: a number next to the words tests, gates, fix rounds or refreezes must be a recorded value (digits and the words one to twenty). @param {Context} ctx @param {string} id @param {string} file */
function claimsCheck(ctx, id, file) {
  const dir = runDir(ctx, id);
  const [wt, wp] = evidenceRunCounts(ctx, dir);
  const gn = requiredGates(ctx, dir).length;
  const fr = fixRoundsUsed(ctx, dir); const fm = maxFixRounds(ctx); const done = fixRoundsDone(ctx, dir); const led = fixRoundsLedger(ctx, dir);
  const rz = String(ledgerRows(ctx, dir, 'refreeze').length);
  const tests = [wt, wp, wt - wp]; const gates = [gn, 0]; const rounds = [fr, fm, done, led]; const refz = [Number(rz)];
  const tlab = `worker-evidence run records: total ${wt}, ended pass ${wp}, ended fail ${wt - wp}; no record counts individual tests`;
  const glab = `required gates ${gn}`; const rlab = `used ${led}, maximum ${fm}`; const zlab = `refreezes ${rz}`;
  /** @type {string[]} */ const bad = [];
  let fence = false; let nr = 0;
  for (const raw of records(fileText(ctx, file) ?? '')) {
    nr++;
    if (raw.startsWith('```')) { fence = !fence; continue; }
    if (fence) continue;
    let line = asciiLower(raw).replace(/[*`]/g, ' ');
    for (let m = /[0-9],[0-9][0-9][0-9]/.exec(line); m !== null; m = /[0-9],[0-9][0-9][0-9]/.exec(line)) line = line.slice(0, m.index + 1) + line.slice(m.index + 2);
    line = numWords(line);
    /** @param {string} kind @param {RegExp} re @param {number[]} set @param {string} lab */
    const scan = (kind, re, set, lab) => {
      let s = line;
      for (let m = re.exec(s); m !== null; m = re.exec(s)) {
        const n = m[0].replace(/^[^0-9]*/, '').replace(/[^0-9][^]*$/, '');
        s = s.slice(m.index + m[0].length);
        if (NOT_COUNT.test(s)) continue;
        if (Number(n) === 0 && (/(failed|failing|skipped)/.test(m[0]) || NOT_FAIL.test(s))) continue;
        if (!set.includes(Number(n))) bad.push(`line ${nr}: "${n} ${kind}" (recorded: ${lab})`);
      }
    };
    scan('tests', RE.tb, tests, tlab); scan('tests', RE.ta, tests, tlab); scan('gates', RE.gb, gates, glab); scan('gates', RE.ga, gates, glab);
    scan('fix rounds', RE.rb, rounds, rlab); scan('fix rounds', RE.ra, rounds, rlab); scan('refreezes', RE.fb, refz, zlab); scan('refreezes', RE.fa, refz, zlab);
  }
  if (bad.length > 0) fail(`completion report numbers contradict the run records (A143, C-22):\n${bad.join('\n')}\nRemove the number or use the recorded one: see 'agent.sh report-facts ${id}'. The Facts block is added at publish. Digits and the words one to twenty beside tests, gates, fix rounds and refreezes are read; other phrasings and table cells are not.`);
}

// ---- the parts publish writes ------------------------------------------------------------------------------------------------------

/** `report_strip_facts FILE`: remove an earlier Facts block. @param {Context} ctx @param {string} file */
function stripFacts(ctx, file) {
  const t = fileText(ctx, file);
  if (t === null) return;
  /** @type {string[]} */ const out = [];
  let skip = false;
  for (const l of records(t)) {
    if (l === FACTS_BEGIN) { skip = true; continue; }
    if (skip && l === FACTS_END) { skip = false; continue; }
    if (!skip) out.push(l);
  }
  writeFileSync(file, latin1Buf(out.map((l) => `${l}\n`).join('')));
  ctx.forget('file:');
}

/** A341: a Verification claims block of an earlier publish is checked against its own hash (a hand edit is refused), then removed; publish writes a fresh one. @param {Context} ctx @param {string} file */
function stripClaims(ctx, file) {
  const t = fileText(ctx, file);
  if (t === null) return;
  const all = records(t);
  const bad = checkClaimsBlock(all);
  if (bad !== '') fail(bad);
  /** @type {string[]} */ const out = [];
  let skip = false;
  for (const l of all) {
    if (l === CLAIMS_BEGIN) { skip = true; continue; }
    if (skip && l === CLAIMS_END) { skip = false; continue; }
    if (!skip) out.push(l);
  }
  writeFileSync(file, latin1Buf(out.map((l) => `${l}\n`).join('')));
  ctx.forget('file:');
}

/** A341: the generated Execution section as lines, or null when the run has no decision record. @param {Context} ctx @param {string} id @returns {string[]} */
function executionLines(ctx, id) { return records(capture(ctx, () => reportExecution(ctx, id))); }

/**
 * A341: the line the script writes for an unsupported visual check under '## Unsupported Checks'. The reason is the one recorded by the gate; what is not proven is a fixed
 * sentence. The lead's own line for that check is replaced by it, so the vocabulary audit can exempt this exact line and nothing else that names the check.
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
function unsupportedLines(ctx, dir) {
  return riskUnsupported(ctx, dir).filter((x) => x[0] === 'QA:visual').map((x) => `- QA:visual: ${String(x[2] ?? '').replace(/^UNSUPPORTED /, '').replace(/[\s]+/g, ' ').trim()}; not proven: whether the changed interface behaves as the acceptance criteria describe when a user operates it`);
}

/**
 * A341: after the structure checks (the lead had to name the check and say 'not proven: <what>' in at least three words), the script's line replaces the lead's `- QA:visual:` line of
 * '## Unsupported Checks'; the lead's reason and wording never reach the vocabulary audit. A line the lead did not write is not added.
 * @param {Context} ctx @param {string} id
 */
function unsupportedApply(ctx, id) {
  const dir = runDir(ctx, id);
  const gen = unsupportedLines(ctx, dir);
  if (gen.length === 0) return;
  const file = `${dir}/COMPLETION_REPORT.md`;
  const text = fileText(ctx, file);
  if (text === null) return;
  /** @type {string[]} */ const out = [];
  let inside = false; let done = false;
  for (const l of records(text)) {
    if (/^## /.test(l)) inside = /^## Unsupported Checks[ \t]*$/.test(l);
    if (inside && l.startsWith('- QA:visual:')) { if (!done) out.push(...gen); done = true; continue; }
    out.push(l);
  }
  writeFileSync(file, latin1Buf(out.map((l) => `${l}\n`).join('')));
  ctx.forget('file:');
}

/**
 * The Human checks the QA gate record vouches for: the items of QA_REPORT.md, but only when that file still has the hash the QA gate record took. A changed file vouches for nothing.
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
function vouchedHumanChecks(ctx, dir) {
  const rec = gateLatestFile(ctx, dir, 'QA', '-');
  if (rec === '') return [];
  const art = gateField(ctx, rec, 'artifact');
  if (art !== 'QA_REPORT.md' || gateField(ctx, rec, 'artifact_sha256') !== sha256File(`${dir}/${art}`)) return [];
  const qa = fileText(ctx, `${dir}/${art}`);
  return qa === null ? [] : humanChecks(qa).filter((x) => x !== '');
}

/**
 * The one line A130 demands for a visual check that re-ran nothing: the lead writes exactly this line, and only this exact line is left out of the vocabulary audit.
 * @param {Context} ctx @param {string} dir @returns {string[]}
 */
function notRerunLines(ctx, dir) {
  return [...new Set(riskNotRerun(ctx, dir).map((x) => x.split(' ')[0]).filter((n) => n === 'QA:visual'))].map((n) => `- ${n}: not reproduced (NOT_RERUN)`);
}

/** What the script generated in a report, for the vocabulary audit to leave out. @param {Context} ctx @param {string} id @param {string} dir @param {{ claims?: string[] | null, factsHash?: string | null }} [blocks] */
function generatedParts(ctx, id, dir, blocks = {}) {
  const hasDecisions = listNames(`${dir}/decisions`, /^[0-9]{3}-.*\.decision$/).length > 0;
  return { lookAt: vouchedHumanChecks(ctx, dir), execution: hasDecisions ? executionLines(ctx, id) : null, generatedLines: [...unsupportedLines(ctx, dir), ...notRerunLines(ctx, dir)], claims: blocks.claims ?? null, factsHash: blocks.factsHash ?? null };
}

/**
 * A341: the refusal message when the lead's own text in these report lines holds a word of the visual-check vocabulary without the ledger holding that check for the final tree; '' otherwise.
 * Used by publish, by verify-completion-report (a text edited after publish) and by the delivery step.
 * @param {Context} ctx @param {string} id @param {string[]} lines
 */
export function completionAudit(ctx, id, lines) {
  const dir = runDir(ctx, id);
  const dup = duplicateBlocks(lines);
  if (dup !== '') return dup;
  const claims = claimsBlock(ctx, dir, id);
  const rows = ledgerRows(ctx, dir, 'completion-claims');
  const factsHash = rows.length > 0 ? (rows[rows.length - 1].detail.split(' ')[1] ?? null) : null;
  return auditClaims(lines, claims, generatedParts(ctx, id, dir, { claims: claims.block.replace(/\n$/, '').split('\n'), factsHash }));
}

/** `report_execution_apply ID`: the generated section replaces the lead's `## Execution` section (or goes before `## Known Limitations`, or last). @param {Context} ctx @param {string} id */
function executionApply(ctx, id) {
  const dir = runDir(ctx, id);
  const file = `${dir}/COMPLETION_REPORT.md`;
  if (listNames(`${dir}/decisions`, /^[0-9]{3}-.*\.decision$/).length === 0) return;
  const text = fileText(ctx, file);
  if (text === null) return;
  const gen = executionLines(ctx, id);
  /** @type {string[]} */ const out = [];
  let skip = false; let done = false;
  const emit = () => { out.push(...gen, ''); done = true; };
  for (const l of records(text)) {
    if (/^## Execution[ \t]*$/.test(l) && !done) { skip = true; emit(); continue; }
    if (skip && l.startsWith('## ')) skip = false;
    if (skip) continue;
    if (l.startsWith('## Known Limitations') && !done) emit();
    out.push(l);
  }
  if (!done) { out.push(''); emit(); }
  writeFileSync(file, latin1Buf(out.map((l) => `${l}\n`).join('')));
  ctx.forget('file:');
}

/** `report_summary_apply ID`: validates the summary block and rewrites it with the script-copied `Look at:` lines. @param {Context} ctx @param {string} id */
function summaryApply(ctx, id) {
  const dir = runDir(ctx, id);
  const file = `${dir}/COMPLETION_REPORT.md`;
  const all = records(fileText(ctx, file) ?? '');
  const b = all.indexOf(SUMMARY_BEGIN) + 1;
  if (b === 0) { ctx.err('note: COMPLETION_REPORT.md has no summary block at the top; the user reads it first (what changed, what to look at, one command to verify): see the template\n'); return; }
  if (b > 4) fail('completion report: the summary block must open within the first lines of the report, right after the title');
  let e = 0;
  for (let n = b + 1; n <= all.length; n++) if (all[n - 1] === SUMMARY_END) { e = n; break; }
  if (e === 0) fail(`completion report: the summary block has no closing marker ${SUMMARY_END}`);
  const body = all.slice(b, e - 1).filter((l) => !l.startsWith('Look at:') && hasText(l));
  const qa = fileText(ctx, `${dir}/QA_REPORT.md`);
  const items = qa === null ? [] : humanChecks(qa);
  const verify = body.filter((l) => l.startsWith('Verify:'));
  if (!(verify.length === 1 && /`[^`][^`]*`/.test(verify[0]))) fail("completion report: the summary block needs exactly one line 'Verify: `<one command the user runs on their own machine>`'");
  const main = body.filter((l) => !l.startsWith('Verify:'));
  const mainLow = main.map(asciiLower);
  for (const it of items) {
    if (it === '') continue;
    if (mainLow.some((l) => l.includes(asciiLower(it)))) fail(`completion report: the summary block repeats a QA_REPORT.md 'Human checks' item ('${it}'); the script copies that list as 'Look at:' lines, remove your copy`);
  }
  const n = body.length + items.filter((x) => x !== '').length;
  if (n > 5) fail(`completion report: the summary block is ${n} lines with the 'Look at:' lines the script adds; at most five (what changed, what to look at, one command to verify)`);
  const out = [...all.slice(0, b), ...main, ...items.filter((x) => x !== '').map((x) => `Look at: ${x}`), ...verify, ...all.slice(e - 1)];
  writeFileSync(file, latin1Buf(out.map((l) => `${l}\n`).join('')));
  ctx.forget('file:');
}

// ---- publish and verify -----------------------------------------------------------------------------------------------------------

/** The receipt and the adapter name go into RUN.yaml: one plain line. @param {string} s */
function plain(s) { return !/[\x00-\x1f\x7f"\\]/.test(s); }

/** The checks and the generated parts of a publish, before the task adapter runs; they edit the report in place, the caller restores it when one refuses. @param {Context} ctx @param {string} id @param {string} dir @param {string} report */
function prepare(ctx, id, dir, report) {
  stripClaims(ctx, report); // A341: before the Facts strip, so a hand edit of the claims block is seen
  stripFacts(ctx, report);
  executionApply(ctx, id); // A203: the Execution table is generated from the decision records, whatever the lead wrote there
  summaryApply(ctx, id);
  // the report is a file, so English whatever the user's language: the summary block is not exempt from the language check (the chat message is the user-language text)
  const langHits = languageScanFiles(ctx, [report]);
  if (langHits.length > 0) fail(`${languageFailText(langHits.join(' '))}. The summary block's Changed: line must be English; only the chat message follows the user's language`);
  // A341: the verification claims come from the gate records; a visual, browser or screenshot claim in the lead's own text needs a record for the final tree
  const claims = claimsBlock(ctx, dir, id);
  validateStructure(ctx, id); // the structure messages come first; the vocabulary audit reads the text that passed them
  unsupportedApply(ctx, id); // A341: the lead named the check and said what is not proven; the script's line replaces the lead's wording
  const audit = auditClaims(records(fileText(ctx, report) ?? ''), claims, generatedParts(ctx, id, dir));
  if (audit !== '') fail(audit);
  claimsCheck(ctx, id, report);
  const facts = capture(ctx, () => reportFacts(ctx, id));
  // the trailing blank lines of the lead's text are normalised, so a second publish writes the same bytes
  writeFileSync(report, latin1Buf(`${(fileText(ctx, report) ?? '').replace(/\n+$/, '')}\n\n${claims.block}\n${facts}`));
  return { ...claims, factsHash: sha256(facts) };
}

/** `publish_completion_report ID [ADAPTER]` @param {Context} ctx @param {string} id @param {string} given */
export function publishCompletionReport(ctx, id, given) {
  const adapter = given !== '' ? given : ctx.config().get('tasks.adapter', 'markdown');
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  if (sectionValue(ctx, dir, 'execution', 'state') !== 'CODE_DONE') fail('completion report may only be published after CODE_DONE');
  verifySeal(ctx, id, dir);
  const report = `${dir}/COMPLETION_REPORT.md`;
  // A143: the Facts block of an earlier publish is removed first so it never satisfies a check, the text is checked against the records,
  // and a fresh block generated from them is appended verbatim.
  // A341: a refused publish leaves the report as it was (the checks below edit it in place)
  const original = existsSync(report) ? readFileSync(report) : null;
  /** @type {ReturnType<typeof claimsBlock> & { factsHash: string }} */ let claims;
  try {
    claims = prepare(ctx, id, dir, report);
  } catch (e) {
    if (original !== null) writeFileSync(report, original);
    ctx.forget('file:');
    throw e;
  }
  ctx.forget('file:');
  const restoreReport = () => { if (original !== null) writeFileSync(report, original); ctx.forget('file:'); };
  /** @type {string} */ let script;
  /** @type {{ file: string, data: Buffer, mode: number, atime: Date, mtime: Date } | null} */ let backup = null;
  try {
    script = adapterScript(ctx, adapter);
    if (localTaskSourceRun(ctx, id)) {
      quietly(ctx, () => must(freshness(ctx, id)));
      const file = localTaskSource(ctx, dir);
      const st = statSync(file);
      backup = { file, data: readFileSync(file), mode: st.mode & 0o7777, atime: st.atime, mtime: st.mtime };
    }
  } catch (e) { restoreReport(); throw e; } // A341: every refusal before the adapter runs leaves the report as it was
  const restore = () => {
    if (original !== null) writeFileSync(report, original); // A341: a publish the adapter refuses leaves the report as it was before the checks
    if (backup === null) { ctx.forget('file:'); return; }
    writeFileSync(backup.file, backup.data);
    try { chmodSync(backup.file, backup.mode); utimesSync(backup.file, backup.atime, backup.mtime); } catch { /* best effort, like cp -p */ }
    ctx.forget('');
  };
  ctx.flush();
  const r = /** @type {NonNullable<ReturnType<typeof runTaskAdapter>>} */ (runTaskAdapter(ctx, script, ['publish', id, report]));
  if (r.stderr.length > 0) ctx.err(r.stderr.toString('latin1'));
  ctx.forget('');
  if (r.status !== 0) { restore(); fail(`completion report publish failed via adapter: ${adapter}`); }
  const receipt = r.stdout.toString('latin1').replace(/\n+$/, '');
  if (receipt === '') { restore(); fail(`adapter ${adapter} returned an empty receipt`); }
  // the receipt and the adapter name become lines of RUN.yaml, which the ledger then seals: a line break or a quote would write extra lines
  if (!plain(receipt) || !plain(adapter)) { restore(); fail(`adapter ${adapter} returned a receipt with a control character, a quote or a backslash; the task source was restored and nothing was recorded`); }
  if (backup !== null) {
    // the second freshness is a check of its own (`>/dev/null 2>&1`): what it printed is not shown
    let ok = true;
    const mark = ctx.chunks.length;
    try { must(freshness(ctx, id)); } catch (e) { if (!(e instanceof ProoflineError)) throw e; ok = false; }
    ctx.chunks.length = mark;
    if (!ok) { restore(); fail(`adapter ${adapter} changed the frozen task contract outside the completion-report block; the task source was restored and nothing was recorded`); }
  }
  setRunValue(ctx, id, 'completion_report', 'adapter', adapter);
  setRunValue(ctx, id, 'completion_report', 'published', 'true');
  setRunValue(ctx, id, 'completion_report', 'receipt', receipt);
  if (gatesEnforced(ctx, dir)) {
    led(ctx, id, 'completion-claims', 'CODE_DONE', 'CODE_DONE', `${claims.hash} ${claims.factsHash}`); // A341: verify-completion-report compares the block with this hash
    led(ctx, id, 'publish-completion-report', 'CODE_DONE', 'CODE_DONE', `${adapter} ${receipt}`);
  }
  ctx.out(`completion report published: ${id} via ${adapter} -> ${receipt}\n`);
  ctx.out(`final message: paste this line unchanged (A341), and state no visual, browser, screenshot or UI check of your own:\n${claims.line}\n`);
  return 0;
}

/** `verify_completion_report ID` @param {Context} ctx @param {string} id */
export function verifyCompletionReport(ctx, id) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (sectionValue(ctx, dir, 'completion_report', 'published') !== 'true') fail(`completion report not published: ${id}`);
  const adapter = sectionValue(ctx, dir, 'completion_report', 'adapter');
  const receipt = sectionValue(ctx, dir, 'completion_report', 'receipt');
  if (adapter === '' || receipt === '') fail(`completion report adapter/receipt missing: ${id}`);
  const script = adapterScript(ctx, adapter);
  ctx.flush();
  const r = /** @type {NonNullable<ReturnType<typeof runTaskAdapter>>} */ (runTaskAdapter(ctx, script, ['verify', id, receipt]));
  if (r.stdout.length > 0) ctx.out(r.stdout.toString('latin1'));
  if (r.stderr.length > 0) ctx.err(r.stderr.toString('latin1'));
  if (r.status !== 0) fail(`completion report publication could not be verified: ${id}`);
  // A341: the Verification claims block is made again from the records and compared with the published block and the hash the ledger holds
  const rows = ledgerRows(ctx, dir, 'completion-claims');
  const bad = verifyClaimsBlock(ctx, dir, id, rows.length > 0 ? rows[rows.length - 1].detail : '');
  if (bad !== '') fail(bad);
  if (rows.length > 0) {
    // the lead's own text may have been edited after publish: the run's report and the copy in the task file are read again for the vocabulary
    const own = completionAudit(ctx, id, fileLines(ctx, `${dir}/COMPLETION_REPORT.md`));
    if (own !== '') fail(own);
    if (localTaskSourceRun(ctx, id)) {
      const t = fileText(ctx, localTaskSource(ctx, dir));
      const b = `<!-- COMPLETION-REPORT:BEGIN:${id} -->`; const e = `<!-- COMPLETION-REPORT:END:${id} -->`;
      if (t !== null && t.includes(b) && t.includes(e)) {
        const copy = completionAudit(ctx, id, records(t.slice(t.indexOf(b) + b.length, t.indexOf(e))));
        if (copy !== '') fail(copy);
      }
    }
  }
  ctx.out(`completion report publication verified: ${id}\n`);
  return 0;
}
