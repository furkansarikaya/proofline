// @ts-check
// Stage 4, package 4C: `record`, the only way a verdict enters a run (D12). The validation (`record_validate`), the visual PASS check and the apply step
// (`record_apply`) of agent.sh 0.0.47, in this process: the text of the result is held in memory, not in a temporary folder, and `submit` calls this
// function directly. Every refusal is the shell's text ("record rejected: ..."), in the shell's order, so that no check is easier to pass.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DESIGN_MD_CANDIDATES, findApproval, rationaleIds, rationaleLineIn } from './approvals.mjs';
import { nextNum } from './approve.mjs';
import { canonRole, validRole } from './context.mjs';
import { fail } from './errors.mjs';
import { gateFingerprint, hashFile } from './fingerprint.mjs';
import { gateFocusStatus, gateSatisfied, gateDeps } from './gates.mjs';
import { gatePreconditions, writeGate } from './gatewrite.mjs';
import { sha256 } from './hash.mjs';
import { setRunValue } from './lifecycle.mjs';
import { led } from './lifeutil.mjs';
import * as proc from './proc.mjs';
import { gatesEnforced, sectionKeyPresent, sectionValue, textLines } from './records.mjs';
import {
  artifactAllowed, artifactPaths, classificationFlip, evidenceCiteCheck, findingPrefix, gateOf, idKey, isGateRole, lineValue, metricsStep,
  parseFindings, parseHeader, plainFile, realOf, resultKind, unsupportedBlocks, unsupportedEvidenceCheck, unsupportedReasonOk,
} from './resultutil.mjs';
import { knownControlArtifact, requireRun, runDir } from './runs.mjs';
import { riskFocusRole, riskGateFocuses, riskMissingFlags } from './signals.mjs';
import { now } from './clock.mjs';
import { ProoflineError } from './errors.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WSC = '[ \\t\\n\\v\\f\\r]';

/** `record_reject MSG`: the refusal, exit 1. @param {string} msg @returns {never} */
function reject(msg) { throw new ProoflineError(`record rejected: ${msg}`, 1); }

/** The sha256 of the justification line text (`printf '%s' | sha256`). @param {string} s */
const shaOf = (s) => sha256(s);

/** `rationale_line ID FILE`: the line in the named file, '' when the file is not there. @param {Context} ctx @param {string} id @param {string} file */
function rationaleLineOf(ctx, id, file) {
  if (!existsSync(file)) return '';
  try { return rationaleLineIn(id, readFileSync(file, 'latin1')); } catch { return ''; }
}

/** `design_rationales ID --json`: the approved rationales as the lint takes them. @param {Context} ctx @param {string} id */
function approvedRationalesJson(ctx, id) {
  let file = '';
  for (const c of DESIGN_MD_CANDIDATES) if (existsSync(`${ctx.root}/${c}`)) { file = `${ctx.root}/${c}`; break; }
  let text = '';
  if (file !== '') { try { text = readFileSync(file, 'latin1'); } catch { return '{"approved": {}}\n'; } }
  let out = ''; let sep = '';
  for (const rid of file === '' ? [] : rationaleIds(text)) {
    const t = rationaleLineIn(rid, text);
    if (t === '') continue;
    const b = shaOf(t);
    if (findApproval(ctx, id, `rationale:${rid}`, b) !== null) { out += `${sep}"${rid}": "${b}"`; sep = ', '; }
  }
  return `{"approved": {${out}}}\n`;
}

/**
 * `record_visual_check ID RESULT` (A200 item 6): the QA visual focus never records PASS against its own evidence. report.json must say PASS, the lint is
 * rerun by this record, and a pattern the report calls justified needs the user's approval of the DESIGN.md line (bound to its sha256).
 * @param {Context} ctx @param {string} id @param {string} result
 */
function recordVisualCheck(ctx, id, result) {
  const d = `${runDir(ctx, id)}/reviews/visual-proof`;
  if (result !== 'PASS') return;
  if (!existsSync(`${d}/report.json`)) reject("visual PASS needs reviews/visual-proof/report.json: an agent's statement is not evidence, and the verifier reads that report. Produce it with the visual-proof skill (its RESULT must be PASS), or submit UNSUPPORTED/BLOCKED with the reason");
  /** @param {string} f @returns {any} */
  const json = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
  const rep = json(`${d}/report.json`);
  const res = rep !== undefined && rep !== null ? String(rep.result || '') : '';
  if (res !== 'PASS') reject(`visual PASS contradicts reviews/visual-proof/report.json (RESULT: ${res === '' ? 'unreadable' : res}): a report that is FAIL or INCONCLUSIVE is never a gate PASS (submit FAIL with its blocking rows, or UNSUPPORTED for INCONCLUSIVE)`);
  const script = `${ctx.root}/.agents/skills/visual-proof/scripts/lint-source.mjs`;
  if (!existsSync(script)) reject('visual PASS cannot be checked: .agents/skills/visual-proof/scripts/lint-source.mjs is missing, so the source lint cannot be rerun (install the visual-proof skill, or submit UNSUPPORTED with the reason)');
  const tmp = mkdtempSync(path.join(tmpdir(), 'proofline-lint.'));
  try {
    const ap = `${tmp}/approved.json`;
    writeFileSync(ap, approvedRationalesJson(ctx, id), 'latin1');
    const r = proc.run(process.execPath, [script, '--root', ctx.root, '--approved-rationales', ap, '--out', tmp], { cwd: ctx.root, env: ctx.childEnv(), input: '', stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.status !== 0 || !existsSync(`${tmp}/lint.json`)) {
      const log = Buffer.concat([r.stdout, r.stderr]).subarray(0, 300).toString('latin1').replace(/\n/g, ' ');
      reject(`visual PASS: lint-source.mjs could not run on the project, so the PASS cannot be checked (${log}); fix the cause, or submit UNSUPPORTED/BLOCKED with the reason`);
    }
    const lint = json(`${tmp}/lint.json`);
    const nb = lint === undefined || lint === null ? -1 : (Array.isArray(lint.findings) ? lint.findings : []).filter((/** @type {any} */ f) => f.severity === 'blocking').length;
    if (nb < 0) reject('visual PASS: the source lint result is unreadable');
    if (nb > 0) reject(`visual PASS refused: the source lint (lint-source.mjs, rerun by this record) has ${nb} blocking finding(s); fix them or leave the gate FAIL (a justified pattern needs the user's rationale approval)`);
    try { copyFileSync(`${tmp}/lint.json`, `${d}/lint.json`); } catch { /* best effort, as cp 2>/dev/null */ }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const lint2 = json(`${d}/lint.json`);
  if (lint2 === undefined || lint2 === null) reject('visual PASS: reviews/visual-proof/lint.json is unreadable');
  /** @type {Array<[string, string, string]>} */ const just = [];
  const seen = new Set();
  for (const f of Array.isArray(lint2.findings) ? lint2.findings : []) {
    if (f.justified === true && !seen.has(f.id)) { seen.add(f.id); just.push([String(f.id), String(f.reason || ''), String(lint2.design_md || '')]); }
  }
  for (const [i, x, m] of just) {
    if (i === '') continue;
    const b = shaOf(`${i}: ${x}`);
    if (findApproval(ctx, id, `rationale:${i}`, b) === null) reject(`visual PASS relies on the DESIGN.md rationale for pattern ${i}, which the user has not approved: a rationale an agent wrote does not pass a finding. Ask: agent.sh request-approval ${id} rationale:${i} (relay it; the user's reply records the approval), or leave the finding blocking (FAIL)`);
    let cur = '';
    if (m !== '') cur = rationaleLineOf(ctx, i, m.startsWith('/') ? m : `${ctx.root}/${m}`);
    if (shaOf(cur) !== b) reject(`visual PASS: the DESIGN.md line for pattern ${i} is not the text the user approved (changed or removed since): ask for the approval again`);
  }
}

/** The lines of RAW that start with KEY: (header names are upper case). @param {string} raw @param {RegExp} re */
const anyLine = (raw, re) => raw.split('\n').some((l) => re.test(l));

/**
 * `record_validate`: every check of a result, in the shell's order. Returns what `record_apply` needs.
 * @param {Context} ctx @param {string} id @param {string} raw
 */
function recordValidate(ctx, id, raw) {
  const dir = runDir(ctx, id);
  const hdr = parseHeader(raw);
  if (hdr === null) reject('malformed header (expected ROLE/TASK/[FOCUS]/RESULT/CONFIDENCE/FINGERPRINT/ARTIFACT lines first)');
  const h = (/** @type {string} */ k) => hdr.get(k) ?? '';
  for (const k of ['ROLE', 'TASK', 'RESULT', 'CONFIDENCE', 'FINGERPRINT', 'ARTIFACT']) if (h(k) === '') reject(`malformed header: missing ${k}`);
  const role = canonRole(h('ROLE'));
  let res = h('RESULT');
  let focus = h('FOCUS');
  const conf = h('CONFIDENCE');
  if (!validRole(role)) reject(`unknown ROLE: ${role}`);
  if (role !== ctx.role) reject(`ROLE ${role} does not match AGENT_ROLE ${ctx.role}`);
  if (h('TASK') !== id) reject(`TASK ${h('TASK')} does not match ${id}`);
  if (!['high', 'medium', 'low'].includes(conf)) reject(`invalid CONFIDENCE: ${conf}`);
  let kind = '';
  if (focus !== '' && role !== 'reviewer' && riskFocusRole(focus) !== role) reject(`FOCUS ${focus} is not a focus of role ${role}`);
  switch (res) {
    case 'UNSUPPORTED':
      if (isGateRole(role) && riskFocusRole(focus) !== '') kind = 'gate';
      else reject('UNSUPPORTED is a result of a risk focus only (contract, concurrency, performance, config, migration, visual)');
      if (focus === 'dependencies') reject('the dependencies focus always has a tool-free check (the manifest diff against PLAN ## Dependencies); UNSUPPORTED is not available');
      if (focus === 'logging') reject('the logging focus always has a tool-free check (read the changed log calls and trace what reaches them); UNSUPPORTED is not available (A162)');
      if (focus === 'concurrency' || focus === 'config') reject(`the ${focus} focus always has a tool-free check (concurrency: a traced interleaving; config: the static consistency scan); UNSUPPORTED is not available: submit PASS or FAIL, or BLOCKED with the reason (A102)`);
      if (!anyLine(raw, new RegExp(`^UNSUPPORTED_EVIDENCE:${WSC}*[^ \\t\\n\\v\\f\\r]`))) reject("UNSUPPORTED needs --evidence (an UNSUPPORTED_EVIDENCE line): the saved output of the skill's validator that prints 'RESULT: UNSUPPORTED' (submit --evidence <run-relative path>, A102); a reason alone is not evidence");
      if (!anyLine(raw, new RegExp(`^UNSUPPORTED_REASON:${WSC}*[^ \\t\\n\\v\\f\\r]`))) reject('UNSUPPORTED needs an UNSUPPORTED_REASON line (the tool or skill that is missing)');
      if (!unsupportedReasonOk(lineValue(raw, 'UNSUPPORTED_REASON'))) reject("UNSUPPORTED_REASON is too vague: name the concrete missing tool, parser, capability or file (at least 12 characters, e.g. 'no machine-readable contract file; API.md is prose, no parser' or 'no headless browser installed'); a check you could run is PASS or FAIL (A98)");
      break;
    case 'PASS': case 'FAIL': case 'BLOCKED': case 'DONE': case 'NEEDS_INPUT': kind = resultKind(role, res); break;
    default: break;
  }
  if (kind === 'task') focus = '';
  if (role === 'lead' && kind !== 'task') reject(`the lead can never record a ${res} verdict`);
  if (kind === '') reject(`RESULT ${res} is not valid for role ${role}`);
  let gate = '';
  if (kind === 'gate') {
    if (role === 'reviewer' && !['plan', 'rules', 'tests', 'data', 'rules+tests', 'contract', 'concurrency', 'performance', 'config', 'migration'].includes(focus)) {
      reject('reviewer results need FOCUS plan|rules|tests|data|rules+tests|contract|concurrency|performance|config|migration');
    }
    gate = gateOf(ctx, role, focus, id);
    if (gate === '') fail('');
    if (riskFocusRole(focus) !== '' && !riskGateFocuses(ctx, dir, gate).includes(focus)) reject(`focus ${focus} is not required on ${gate} of ${id}: no risk signal triggers it (see 'agent.sh pipeline ${id}')`);
  }
  const fpNow = gateFingerprint(ctx);
  if (kind === 'gate' && gate !== '' && gateDeps(ctx, dir, gate).length > 0) {
    const unmet = gateDeps(ctx, dir, gate).filter((dep) => !gateSatisfied(gateFocusStatus(ctx, dir, id, dep.slice(0, dep.indexOf(':')), dep.slice(dep.indexOf(':') + 1), 'reuse', fpNow)));
    if (unmet.length > 0) reject(`${gate} needs ${unmet.join(' ')} first (GATES.md, Gate dependencies): it reads that gate's output; run it before ${gate}`);
  }
  const fp = h('FINGERPRINT');
  if (fp !== fpNow) reject(`stale: FINGERPRINT ${fp} is not the current content fingerprint ${fpNow}`);
  const art = h('ARTIFACT');
  const sp = art.lastIndexOf(' ');
  let ap = sp < 0 ? art : art.slice(0, sp);
  const asha = art.slice(sp + 1);
  if (sp < 0) reject("ARTIFACT needs '<run-relative path> <sha256>'");
  let candidate;
  if (ap.startsWith('/')) candidate = ap;
  else if (ap.startsWith(`.agents/runs/${id}/`)) candidate = `${ctx.root}/${ap}`;
  else if (ap === '' || ap.includes('..')) reject(`ARTIFACT path must be run-relative: ${ap}`);
  else candidate = `${dir}/${ap}`;
  const real = realOf(candidate);
  if (real === null) reject(`ARTIFACT not found in the run: ${ap}`);
  const runReal = /** @type {string} */ (realOf(dir));
  if (real.startsWith(`${runReal}/`)) ap = real.slice(runReal.length + 1);
  else reject(`ARTIFACT path must be inside the run: ${ap}`);
  if (!plainFile(`${dir}/${ap}`)) reject(`ARTIFACT not found in the run: ${ap}`);
  if (role === 'explorer' && ap.startsWith('reports/') && !ap.startsWith('reports/snapshots/')) reject(`an explorer result cites a snapshot made by submit, not a live report path (${ap}): hand the report over with submit --report <file>`);
  if (!knownControlArtifact(ctx, id, `.agents/runs/${id}/${ap}`)) reject(`ARTIFACT is not a registered run artifact: ${ap}`);
  if (!artifactAllowed(role, kind, focus, ap)) reject(`ARTIFACT ${ap} is outside the paths ${role}${focus !== '' ? ` (FOCUS ${focus})` : ''} reports in: ${artifactPaths(role, kind, focus)}`);
  if (hashFile(`${dir}/${ap}`) !== asha) reject(`ARTIFACT sha256 mismatch for ${ap}`);
  // A107: every cited evidence file still exists in the run with the cited hash
  for (const line of raw.split('\n')) {
    if (!/^EVIDENCE:/.test(line)) continue;
    for (const el of line.replace(new RegExp(`^EVIDENCE:${WSC}*`), '').replace(/ /g, '@').split(/[ \t\n]+/).filter((x) => x !== '')) {
      const at = el.lastIndexOf('@');
      const p = at < 0 ? el : el.slice(0, at);
      const sha = el.slice(el.indexOf('@') + 1);
      const c = evidenceCiteCheck(ctx, id, role, focus, p, sha);
      if ('err' in c) reject(c.err);
    }
  }
  let ue = '';
  if (res === 'UNSUPPORTED') {
    const c = unsupportedEvidenceCheck(ctx, id, role, focus, raw);
    if ('err' in c) reject(c.err);
    ue = c.ok;
  }
  // one round (C-14) per role and focus, deliberately not per instance; the intent-grill interview is exempt (A75)
  let grill = 'no';
  if (role === 'task_author' && (ap === 'design/INTENT.md' || /^reports\/snapshots\/.*-task_author-design_INTENT\.md$/.test(ap))) {
    let s = false; let first = '';
    for (const l of textLines(readFileSync(`${dir}/${ap}`, 'latin1'))) {
      if (new RegExp(`^## Status${WSC}*$`).test(l)) { s = true; continue; }
      if (s && /[^ \t\n\v\f\r]/.test(l)) { first = l.replace(/[ \t\n\v\f\r]/g, ''); break; }
    }
    if (first === 'in-progress') grill = 'yes';
  }
  if (res === 'NEEDS_INPUT' && grill !== 'yes') {
    let names = [];
    try { names = readdirSync(`${dir}/questions`).filter((n) => /^[0-9]{3}\.md$/.test(n)).sort(); } catch { names = []; }
    for (const n of names) {
      const qf = `${dir}/questions/${n}`;
      const gf = (/** @type {string} */ k) => fieldOfFile(ctx, qf, k);
      if (!(gf('from') === role && gf('focus') === focus)) continue;
      if (gf('grill') === 'yes') continue;
      reject(`the ${role} role already asked its questions in this run (questions/${n}); a later instance of the role decides with its recommended option and says so, or returns BLOCKED with the reason`);
    }
  }
  const findings = parseFindings(raw);
  if (findings.includes('MALFORMED')) reject('malformed findings row (want | id | severity | path:line | finding | evidence |)');
  if (findings.includes('NO_FINDINGS_PLACEHOLDER')) reject('no findings: omit rows, keep only the table header');
  const prefix = findingPrefix(role, kind, gate);
  const prefixRe = new RegExp(`^${prefix.toUpperCase()}-[0-9]+$`);
  for (const r of findings) {
    const c = r.split('|');
    if (!prefixRe.test(c[0].toUpperCase())) reject(`invalid finding id ${c[0]} (want ${prefix}-<n>)`);
    if (!/^(blocking|info)$/.test(c[1] ?? '')) reject(`invalid finding severity ${c[1]}`);
  }
  const keys = findings.map((r) => idKey(r.split('|')[0]));
  if (new Set(keys).size !== keys.length) reject('duplicate finding ids');
  if (kind === 'gate' && role === 'reviewer' && res === 'FAIL' && (focus === 'rules' || focus === 'rules+tests')) {
    for (const r of findings) {
      const c = r.split('|');
      if (c[1] === 'info' || /^agent\.sh /.test(c[4] ?? '')) continue;
      let scan = ''; let inst = '';
      for (const seg0 of (c[4] ?? '').split(';')) {
        const x = seg0.replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '');
        if (/^scan:/.test(x)) scan = x.replace(new RegExp(`^scan:${WSC}*`), '');
        else if (/^instances:/.test(x)) inst = x.replace(new RegExp(`^instances:${WSC}*`), '');
      }
      const loc = (c[2] ?? '').replace(/[ \t\n\v\f\r]/g, '');
      let bad = '';
      if (scan.length < 10 || scan.split(/[ \t\n\v\f\r]+/).filter((x) => x !== '').length < 2) bad = `${c[0]}: evidence lacks scan: <the grep or script that found every instance>`;
      else if (inst === '') bad = `${c[0]}: evidence lacks instances: single, or instances: <path:line>, <path:line>, ...`;
      else if (inst !== 'single' && !inst.includes(loc) && loc !== '' && loc !== '-') bad = `${c[0]}: instances do not include the row location ${loc}`;
      if (bad !== '') reject(`finding ${bad} (A171: a rules review scans for the whole class and lists every instance, so one fix round clears them all)`);
    }
  }
  if (kind === 'gate' && gate !== '' && res !== 'BLOCKED' && findings.length > 0) {
    const flip = classificationFlip(ctx, id, gate, focus, fp, findings);
    if (flip !== '') reject(`classification changed for the same observation: ${flip}. Blocking or info follows the written rule (GATES.md), not the round: keep the earlier classification (a blocking finding the user accepts is waived, not downgraded)`);
  }
  const blocking = findings.filter((r) => r.split('|')[1] !== 'info').length;
  if (res === 'FAIL' && blocking === 0) reject('FAIL needs at least one blocking finding');
  if (res === 'PASS' && blocking !== 0) reject('PASS cannot carry blocking findings');
  if (res === 'UNSUPPORTED' && blocking !== 0) reject('UNSUPPORTED cannot carry blocking findings (a check that found a defect is FAIL; its UNSUPPORTED rows still block and are listed)');
  // A78/A98: the script's own findings
  let added = 0;
  if (kind === 'gate' && res !== 'BLOCKED' && riskFocusRole(focus) !== '') {
    let next = 0;
    for (const r of findings) { const n = Number(r.split('|')[0].replace(/^[^]*-/, '')); if (n > next) next = n; }
    next += 1;
    if (res === 'UNSUPPORTED') {
      const reason = lineValue(raw, 'UNSUPPORTED_REASON').replace(/\|/g, '/');
      let sev = 'info';
      if (unsupportedBlocks(ctx, reason)) { sev = 'blocking'; added++; }
      findings.push(`${gate}-${next}|${sev}|-|UNSUPPORTED ${focus}: ${reason}|${ap}`);
      next++;
    }
    for (const [name, source, p, flag] of riskMissingFlags(ctx, dir, focus)) {
      if (source !== 'diff') continue;
      findings.push(`${gate}-${next}|blocking|${p}|risk signal ${name} without PLAN.md flag ${flag}: the change touches it but the plan does not declare it (A78)|agent.sh pipeline ${id}: ${p} matches risk.${name} and PLAN.md has no ${flag} yes`);
      next++; added++;
    }
    if (added > 0) res = 'FAIL';
  }
  if (res === 'BLOCKED' && !anyLine(raw, new RegExp(`^BLOCKED_REASON:${WSC}*[^ \\t\\n\\v\\f\\r]`))) reject('BLOCKED needs a BLOCKED_REASON line');
  let questions = '';
  if (res === 'NEEDS_INPUT') {
    let q = false;
    for (const l of raw.split('\n')) {
      if (!q) { if (new RegExp(`^QUESTIONS:${WSC}*$`).test(l)) q = true; continue; }
      if (/^BLOCKED_REASON:/.test(l)) break;
      questions += `${l}\n`;
    }
    if (!/[^ \t\n\v\f\r]/.test(questions)) reject('NEEDS_INPUT needs a QUESTIONS: block');
  }
  if (kind === 'gate' && role === 'qa' && focus === 'visual') recordVisualCheck(ctx, id, res);
  if (kind === 'gate' && res !== 'BLOCKED') gatePreconditions(ctx, id, gate);
  return { role, res, kind, gate, focus, conf, ap, fp, grill, added, ue, findings, questions };
}

/** `gate_field FILE KEY` of a question file. @param {Context} ctx @param {string} f @param {string} k */
function fieldOfFile(ctx, f, k) {
  for (const l of textLines(readFileSync(f, 'latin1'))) if (l.startsWith(`${k}:`)) return l.slice(k.length + 1).replace(/^ +/, '').replace(/"/g, '');
  return '';
}

/**
 * `record_apply`: the raw result is kept verbatim under results/, a gate result becomes a gate record, a question is stored, the ledger and the metrics
 * are written.
 * @param {Context} ctx @param {string} id @param {string} raw @param {ReturnType<typeof recordValidate>} v @param {string} stepAgent
 */
function recordApply(ctx, id, raw, v, stepAgent) {
  const dir = runDir(ctx, id);
  const rd = `${dir}/results`;
  mkdirSync(rd, { recursive: true });
  const n = nextNum(rd);
  const rawName = `results/${n}-${v.role}.result.md`;
  writeFileSync(`${dir}/${rawName}`, raw, 'latin1');
  const sha = hashFile(`${dir}/${rawName}`);
  if (v.kind === 'gate' && v.res !== 'BLOCKED') {
    let gres = 'fail';
    if (v.res === 'PASS') gres = v.conf === 'low' ? 'pass_low' : 'pass';
    if (v.res === 'UNSUPPORTED') gres = 'unsupported';
    const nr = lineValue(readFileSync(`${dir}/${rawName}`, 'latin1'), 'NOT_RERUN').replace(/["\\]/g, '').replace(/[^ -~]/g, '').slice(0, 300);
    writeGate(ctx, { id, gate: v.gate, result: gres, role: v.role, confidence: v.conf, focus: v.focus, artifact: v.ap, findings: v.findings, resultFile: rawName, fingerprint: v.fp, unsupportedEvidence: v.ue, notRerun: nr });
  }
  if (v.res === 'NEEDS_INPUT') {
    mkdirSync(`${dir}/questions`, { recursive: true });
    const q = nextNum(`${dir}/questions`);
    writeFileSync(`${dir}/questions/${q}.md`, `from: ${v.role}\nfocus: ${v.focus}\ngrill: ${v.grill}\nresult: ${rawName}\nasked_at: ${now().epoch}\n---\n${v.questions}`, 'latin1');
    if (sectionKeyPresent(ctx, dir, 'execution', 'awaiting_input')) setRunValue(ctx, id, 'execution', 'awaiting_input', 'true');
  }
  if (gatesEnforced(ctx, dir)) led(ctx, id, `record:${v.role}:${v.res}`, '-', '-', `${rawName} sha256=${sha}${v.gate !== '' ? ` gate=${v.gate}` : ''}`);
  metricsStep(ctx, id, v.role, v.focus, v.res.toLowerCase(), stepAgent);
  /** @type {string[]} */ const risk = [];
  if (v.added !== 0) risk.push(`risk: ${v.added} script finding(s) added to ${v.gate} focus ${v.focus} (a blocking UNSUPPORTED or a risk signal without its PLAN.md flag, A78/A98); the result is FAIL`);
  if (v.res === 'UNSUPPORTED') risk.push(`risk: ${v.gate} focus ${v.focus} is UNSUPPORTED (unproven, reported, A98): never a PASS; the completion report lists it under '## Unsupported Checks' with a 'not proven:' line`);
  return { raw: rawName, res: v.res, risk, line: `result recorded: ${id} ${rawName} (${v.role} ${v.res})` };
}

/**
 * `record_result ID [FILE]` in process: validate, then apply. `raw` is the text of the result (a byte string). Returns the raw file name, the recorded
 * result and the script's `risk:` lines; every output line is also the second field of `line`.
 * @param {Context} ctx @param {string} id @param {string} raw @param {string} stepAgent the dispatch token (PROOFLINE_STEP_AGENT)
 */
export function recordText(ctx, id, raw, stepAgent) {
  requireRun(ctx, id);
  const v = recordValidate(ctx, id, raw);
  return recordApply(ctx, id, raw, v, stepAgent);
}

/** `record ID [--file F]`: the result from the file, else from stdin. @param {Context} ctx @param {string} id @param {string} file @param {string} stdin */
export function recordResult(ctx, id, file, stdin) {
  requireRun(ctx, id);
  let raw = stdin;
  if (file !== '') {
    const f = path.resolve(ctx.cwd, Buffer.from(file, 'latin1').toString('utf8'));
    if (!plainFileFollow(f)) fail(`result file not found: ${file}`);
    raw = readFileSync(f, 'latin1');
  }
  return recordText(ctx, id, raw, ctx.env.PROOFLINE_STEP_AGENT ?? '');
}

/** `[ -f F ]` @param {string} f */
function plainFileFollow(f) { try { return statSync(f).isFile(); } catch { return false; } }
