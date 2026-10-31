// @ts-check
// Read-only views of a run built from its records: `summary` (and the `--status` form), `digest`, `plan-section`, `report-tokens`,
// `report-execution` and `report-facts` (agent.sh 7363-7420, 8880-8940). Counts and statuses come from the records, never from text.
import { statSync } from 'node:fs';
import { BridgeToShell, fail, ProoflineError } from './errors.mjs';
import { gateFingerprint } from './fingerprint.mjs';
import { fixRoundsUsed, gateFocusStatus, gateStatus, gateUnsupportedFocuses, maxFixRounds, requiredGates, taskOwnedPaths } from './gates.mjs';
import { listNames } from './ledger.mjs';
import { frictionCount, gateReportIds, nextStep, nextWithoutRun } from './next.mjs';
import { isFile } from './paths.mjs';
import { PathKinds, scopeKindRows } from './pathkind.mjs';
import { fileLines, fileText, gatesEnforced, sectionValue, textLines, WS } from './records.mjs';
import { activeRun, requireRun, runDir } from './runs.mjs';
import { pipelineClass, pipelineClassValid, pipelineDeclared, riskGateFocuses, tierEffective } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `ua`: the value, or the word `unavailable`. @param {string} s */
const ua = (s) => (s !== '' ? s : 'unavailable');
/** @param {string} f */
function exists(f) { try { statSync(f); return true; } catch { return false; } }

/** `resolve_topology` as `summary` calls it (stderr dropped, failure = nothing). @param {Context} ctx @param {string} d */
function topology(ctx, d) {
  const t = sectionValue(ctx, d, 'execution', 'topology');
  if (t === 'standalone' || t === 'orchestrated') return t;
  const c = ctx.config().get('default_topology', '');
  return c === 'standalone' || c === 'orchestrated' ? c : '';
}

/** `ki_gate_facts`: a non-empty known-issues list is the shell's until its writers move. @param {Context} ctx */
function knownIssuesFacts(ctx) {
  try { if (statSync(`${ctx.sharedMain()}/.agents/local/known-issues/LIST.tsv`).size > 0) throw new BridgeToShell('known issues list present'); } catch (e) { if (e instanceof BridgeToShell) throw e; }
}

/** `gate_label ID GATE MODE NOW` @param {Context} ctx @param {string} d @param {string} id @param {string} g @param {string} now */
function gateLabel(ctx, d, id, g, now) {
  knownIssuesFacts(ctx);
  const s = gateStatus(ctx, d, id, g, 'reuse', now);
  const u = gateUnsupportedFocuses(ctx, d, id, g, 'reuse', now);
  return u !== '' ? `${s} (unsupported: ${u})` : s;
}

/** `fix_rounds_done ID` @param {Context} ctx @param {string} d */
function fixRoundsDone(ctx, d) { const u = fixRoundsUsed(ctx, d); const m = maxFixRounds(ctx); return u > m ? m : u; }

/** `summary_run [ID] [--status]` @param {Context} ctx @param {string} given @param {string} flag */
export function summaryRun(ctx, given, flag) {
  let id = given;
  if (id === '') id = activeRun(ctx);
  if (id === '') fail('no active task: pass a TASK-ID');
  requireRun(ctx, id);
  const d = runDir(ctx, id);
  ctx.out(`STATUS: ${ua(sectionValue(ctx, d, 'execution', 'state'))} (handoff ${ua(sectionValue(ctx, d, 'handoff', 'state'))}, knowledge ${ua(sectionValue(ctx, d, 'execution', 'knowledge_state'))})\n`);
  if (flag === '--status') return;
  const t = fileLines(ctx, `${d}/TASK.md`)[0];
  const title = t !== undefined && t.startsWith('#') ? t.replace(new RegExp(`^#${WS}*`), '').replace(/[\0-\x1f\x7f]/g, '') : '';
  ctx.out(`TASK: ${id} ${title}\n`);
  const cls = pipelineClass(ctx, d);
  ctx.out(`CLASS/TOPOLOGY: ${ua(cls.includes('PENDING') ? '' : cls)} / ${ua(topology(ctx, d))}\n`);
  if (pipelineDeclared(ctx, d) && pipelineClassValid(cls)) {
    const fp = gateFingerprint(ctx);
    ctx.out(`TIER: ${tierEffective(ctx, d)}\n`);
    for (const g of requiredGates(ctx, d)) ctx.out(`${g}: ${gateLabel(ctx, d, id, g, fp)}\n`);
    ctx.out(`FIX ROUNDS: ${fixRoundsDone(ctx, d)} of ${maxFixRounds(ctx)}\n`);
  }
  ctx.out(`DELIVERY: completion report published ${ua(sectionValue(ctx, d, 'completion_report', 'published'))}\n`);
}

/** `digest_run ID` @param {Context} ctx @param {string} id */
export function digestRun(ctx, id) {
  requireRun(ctx, id);
  const d = runDir(ctx, id);
  let q = 0;
  for (const n of listNames(`${d}/questions`, /^[0-9]{3}\.md$/)) if (!exists(`${d}/questions/${n.slice(0, -3)}.answer.md`)) q++;
  summaryRun(ctx, id, '');
  ctx.out(`OPEN QUESTIONS: ${q}\n`);
  // A202: the scope by derived kind, computed here and not written in any document
  const plan = fileText(ctx, `${d}/PLAN.md`);
  if (plan !== null) {
    const rows = scopeKindRows(new PathKinds(ctx), plan);
    if (rows.replace(/\n+$/, '') !== '') {
      /** @type {Record<string, number>} */ const n = { code: 0, test: 0, content: 0 };
      let bad = '';
      for (const l of textLines(rows)) {
        const f = l.split('\t');
        n[f[3]] = (n[f[3]] ?? 0) + 1;
        if (f[1] !== '-' && f[1] !== f[2] && !(f[1] === 'doc' && f[2] === 'content')) bad += ` ${f[0]}`;
      }
      ctx.out(`SCOPE: code=${n.code} test=${n.test} content=${n.content}${bad !== '' ? ` (kind claimed wrongly, counted as code:${bad})` : ''}\n`);
    }
  }
  // next_step runs in a pipe there: its lines are filtered, and a failure inside it ends only that part
  let text = '';
  try { nextStep(ctx, id, (t) => { text += t; }); } catch (e) {
    if (!(e instanceof ProoflineError)) throw e;
    ctx.err(`${e.message}\n`);
  }
  for (const l of textLines(text)) {
    if (l.startsWith('next=')) ctx.out(`NEXT: ${l.slice(5)}\n`);
    else if (l.startsWith('reason=')) ctx.out(`WHY: ${l.slice(7)}\n`);
  }
}

/** `next [ID]` @param {Context} ctx @param {string} id */
export function nextCommand(ctx, id) {
  const emit = (/** @type {string} */ t) => ctx.out(t);
  if (id !== '') nextStep(ctx, id, emit); else nextWithoutRun(ctx, emit);
}

/** `plan_section ID SECTION` @param {Context} ctx @param {string} id @param {string} name */
export function planSection(ctx, id, name) {
  requireRun(ctx, id);
  const f = `${runDir(ctx, id)}/PLAN.md`;
  if (!isFile(f)) fail(`PLAN.md not found: ${id}`);
  const lines = fileLines(ctx, f);
  if (name === 'scope') {
    let i = false;
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k];
      if (k === 0 && new RegExp(`^---${WS}*$`).test(l)) { i = true; continue; }
      if (i && new RegExp(`^---${WS}*$`).test(l)) break;
      if (i) ctx.out(`${l}\n`);
    }
    return;
  }
  // the section name is a pattern in grep and awk: any character with a meaning of its own is the shell's to read
  if (/[\\.*[\]^$+?(){}|]/.test(name)) throw new BridgeToShell('section name with pattern characters');
  const head = new RegExp(`^## ${name}${WS}*$`);
  if (!lines.some((l) => head.test(l))) {
    const names = lines.map((l) => /^## (.*[^ \t\n\v\f\r])[ \t\n\v\f\r]*$/.exec(l)).filter((m) => m !== null).map((m) => `${m?.[1]} `).join('');
    fail(`no PLAN.md section '${name}' in ${id} (sections: scope ${names})`);
  }
  let i = false;
  for (const l of lines) {
    if (head.test(l)) { i = true; ctx.out(`${l}\n`); continue; }
    if (i && l.startsWith('## ')) break;
    if (i) ctx.out(`${l}\n`);
  }
}

/** `report_tokens ID` @param {Context} ctx @param {string} id */
export function reportTokens(ctx, id) {
  requireRun(ctx, id);
  const d = runDir(ctx, id);
  const st = sectionValue(ctx, d, 'execution', 'state');
  if (!['CODE_DONE', 'DONE', 'FAILED', 'BLOCKED'].includes(st)) return;
  if (!(gatesEnforced(ctx, d) && pipelineClassValid(pipelineClass(ctx, d)))) return;
  ctx.out(`${st}\n${pipelineClass(ctx, d)}\n`);
  for (const g of requiredGates(ctx, d)) ctx.out(`${g}\n`);
  if (st === 'CODE_DONE' || st === 'DONE') ctx.out('commit\npush\n');
  if (listNames(`${d}/worker-evidence`, /^RED-.*\.yaml$/).length && listNames(`${d}/worker-evidence`, /^GREEN-.*\.yaml$/).length) ctx.out('RED\nGREEN\n');
}

/** `decision_files ID` @param {Context} ctx @param {string} d */
function decisionFiles(d) { return listNames(`${d}/decisions`, /^[0-9]{3}-.*\.decision$/); }

/** `report_execution ID` @param {Context} ctx @param {string} id */
export function reportExecution(ctx, id) {
  requireRun(ctx, id);
  const d = runDir(ctx, id);
  const files = decisionFiles(d);
  if (!files.length) return;
  ctx.out(`## Execution\n\nGenerated from the decision records by \`agent.sh report-execution ${id}\` when the report is published; never edited by hand.\n\n| role | focus | runtime | model | effort | signals | note |\n|---|---|---|---|---|---|---|\n`);
  let stream = '';
  for (const f of files) stream += `${fileText(ctx, `${d}/decisions/${f}`) ?? ''}@@END@@\n`;
  const c = (/** @type {string} */ s) => s.replace(/\|/g, '/');
  let role = ''; let focus = ''; let rt = ''; let model = ''; let effort = ''; let sig = ''; let rr = ''; let esc = ''; let xr = ''; let via = '';
  const flush = () => {
    if (role === '') return;
    let n = '';
    if (/AUTOMATIC_FAILOVER/.test(rr)) n += `failover (automatic) to ${rt}; `;
    else if (/OPERATOR_OVERRIDE/.test(rr)) n += 'runtime set by the operator; ';
    if (esc === 'yes') n += `escalated (${xr}); `;
    if (via === 'agent-path') n += 'agent path; ';
    n = n.replace(/; $/, '');
    ctx.out(`| ${c(role)} | ${focus === '' ? '-' : c(focus)} | ${c(rt)} | ${c(model)} | ${c(effort)} | ${sig === '' ? 'none' : c(sig)} | ${n === '' ? '-' : c(n)} |\n`);
    role = focus = rt = model = effort = sig = rr = esc = xr = via = '';
  };
  for (const line of textLines(stream)) {
    if (line === '@@END@@') { flush(); continue; }
    const k = line.split('=')[0];
    const v = line.slice(k.length + 1);
    if (k === 'role') role = v;
    if (k === 'focus') focus = v;
    if (k === 'runtime') rt = v;
    if (k === 'model') model = v;
    if (k === 'effort') effort = v;
    if (k === 'signals') sig = v;
    if (k === 'runtime_reason') rr = v;
    if (k === 'escalated') esc = v;
    if (k === 'escalation_reason') xr = v;
    if (k === 'via') via = v;
  }
}

/** `evidence_run_counts ID`: the worker-evidence records and those that ended pass. @param {Context} ctx @param {string} d */
function evidenceRunCounts(ctx, d) {
  let n = 0; let p = 0;
  for (const kind of ['RED', 'GREEN', 'REFACTOR', 'FIX']) {
    for (const f of listNames(`${d}/worker-evidence`, new RegExp(`^${kind}-.*\\.yaml$`))) {
      if (!isFile(`${d}/worker-evidence/${f}`)) continue;
      n++;
      if (fileLines(ctx, `${d}/worker-evidence/${f}`).some((l) => l.startsWith('result: "pass"'))) p++;
    }
  }
  return [n, p];
}

const FACTS_BEGIN = '<!-- proofline:facts:begin -->';
const FACTS_END = '<!-- proofline:facts:end -->';

/** `report_facts ID` @param {Context} ctx @param {string} id */
export function reportFacts(ctx, id) {
  requireRun(ctx, id);
  const d = runDir(ctx, id);
  const fp = gateFingerprint(ctx);
  const gl = requiredGates(ctx, d);
  const [wt, wp] = evidenceRunCounts(ctx, d);
  ctx.out(`${FACTS_BEGIN}\n## Facts\n\nGenerated from the run records by \`agent.sh report-facts ${id}\` when the report is published; never edited by hand. Numbers in the text above must match it.\n\n`);
  ctx.out(`- Class: ${pipelineClass(ctx, d)}\n- Required gates: ${gl.length}\n`);
  for (const g of gl) {
    const ids = (/** @type {string} */ f) => { const x = gateReportIds(ctx, d, g, f).join(' '); return x === '' ? 'none' : x; };
    ctx.out(`- Gate ${g}: ${gateLabel(ctx, d, id, g, fp)}; findings: ${ids('-')}\n`);
    // each risk sub-focus on a line of its own: its status and findings are never folded into the gate's
    for (const fc of riskGateFocuses(ctx, d, g)) ctx.out(`  - Focus ${g}:${fc}: ${gateFocusStatus(ctx, d, id, g, fc, 'reuse', fp)}; findings: ${ids(fc)}\n`);
  }
  if (gl.length) knownIssuesFacts(ctx);
  const ks = sectionValue(ctx, d, 'execution', 'knowledge_state'); const kr = sectionValue(ctx, d, 'execution', 'knowledge_reason');
  ctx.out(`- Friction notes recorded (A200): proofline_bug ${frictionCount(ctx, d, 'proofline_bug')}, user-command ${frictionCount(ctx, d, 'user-command')}, user-shell ${frictionCount(ctx, d, 'user-shell')}\n`);
  ctx.out(`- Knowledge step: ${ks === '' ? 'not_started' : ks}${kr !== '' ? `; not_applicable reason: ${kr}` : ''}\n`);
  const refreezes = exists(`${d}/LEDGER.log`) ? String(fileLines(ctx, `${d}/LEDGER.log`).filter((l) => l.includes('event=refreeze ')).length) : '';
  // `task_owned_paths ... 2>/dev/null`: its stderr is dropped
  const mark = ctx.chunks.length;
  const owned = taskOwnedPaths(ctx, d).length;
  ctx.chunks = ctx.chunks.filter((c, i) => i < mark || c[0] === 'out');
  ctx.out(`- Fix rounds: ${fixRoundsDone(ctx, d)} of ${maxFixRounds(ctx)}\n- Refreezes: ${refreezes}\n- Files changed (task-owned paths): ${owned}\n`);
  ctx.out(`- Worker-evidence run records: total ${wt}, ended pass ${wp}, ended fail ${wt - wp} (a RED record ends fail on purpose; this is not a count of failing tests)\n`);
  ctx.out(`- Test cases: no record carries the number of individual tests, so no such number is stated here.\n${FACTS_END}\n`);
}
