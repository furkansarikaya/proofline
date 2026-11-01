// @ts-check
// `next`: the deterministic next step of a run (agent.sh 6878-7062). The state machine reads the records once (RUN.yaml, the gate records,
// the ledger, the plan), asks the shared library for the gate states and prints the `task=`, `state=`, `handoff=`, `next=`, `reason=`,
// `note=`, `missing_step=`, `finding=` and `fix_path=` lines the lead and the hooks parse. It removes stale dispatch markers like the shell.
// Four branches stay with the shell until the stages that move their writers (BridgeToShell before any output): a pending approval that
// has to read the user's newest prompt (approval_wait_o), a delivery whose pull request is open (ci_progress), a task of an approved batch
// (batch_member), a listed known issue (ki_gate_facts) and the design-sync drift of the knowledge step (knowledge_drift).
import { asciiLower } from './shellglob.mjs';
import { lstatSync, statSync } from 'node:fs';
import { BridgeToShell } from './errors.mjs';
import { gateFingerprint, hashFile } from './fingerprint.mjs';
import {
  findingWaived, fixRoundsUsed, gateBlockingRows, gateDeps, gateFocus, gateFocusStatus, gateLatestFile, gateNames, gateOwner, gateSatisfied, gateStatus, gatesDirOf, maxFixRounds,
  requiredGates, riskNotRerun, riskUnsupported, taskPatchFingerprint, unsupportedLabel, gateBoundToContract,
} from './gates.mjs';
import { budgetNote, inflightDispatch, inflightParts, removeMarkers, staleMarkers } from './dispatch.mjs';
import { boundNames, listNames } from './ledger.mjs';
import { isFile } from './paths.mjs';
import { assumptionBlocked, assumptionShapeErrors, planMigrationShape, taskDefectError, taskDefectFixes } from './plancheck.mjs';
import * as proc from './proc.mjs';
import { fileLines, fileText, gateField, gatesEnforced, planDestructive, planScope, planSectionPresent, sectionKeyPresent, sectionValue, WS } from './records.mjs';
import { activeRun, knownControlArtifact, requireRun, runDir } from './runs.mjs';
import { pipelineClass, pipelineClassValid, pipelineNeeds, pipelineValue, riskGateFocuses, riskMissingFlags, runAutonomy, tierEffective } from './signals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `[ -e F ]` @param {string} f */
function exists(f) { try { statSync(f); return true; } catch { return false; } }
/** @param {string} s */
function reEsc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** `$(...)`: trailing newlines removed. @param {string} s */
function sub(s) { return s.replace(/\n+$/, ''); }

// ---- approvals (the part `next` needs; the writers stay with the shell) ---------------------------------------------------------

/** `kind_slug` @param {string} k */
const kindSlug = (k) => k.replace(/:/g, '-');

/** `safe_state_file FILE` for a file inside the run: a regular single-link file on a symlink-free path. @param {Context} ctx @param {string} f */
function safeStateFile(ctx, f) {
  try { const l = lstatSync(f); if (l.isSymbolicLink() || !l.isFile() || l.nlink !== 1) return false; } catch { return false; }
  let d = f.slice(0, f.lastIndexOf('/'));
  if (d !== ctx.root && !d.startsWith(`${ctx.root}/`)) throw new BridgeToShell('approval outside the root');
  while (d !== ctx.root) {
    if (!d.startsWith(`${ctx.root}/`)) return false;
    try { if (lstatSync(d).isSymbolicLink()) return false; } catch { return false; }
    d = d.slice(0, d.lastIndexOf('/'));
  }
  return true;
}

/** `find_approval ID KIND BOUND`: the newest unconsumed approval with that binding, or ''. @param {Context} ctx @param {string} id @param {string} kind @param {string} bound */
function findApproval(ctx, id, kind, bound) {
  const dir = runDir(ctx, id);
  const ad = `${dir}/approvals`;
  let all = listNames(ad, new RegExp(`^[0-9]{3}-${reEsc(kindSlug(kind))}\\.yaml$`)).sort().reverse();
  if (all.length && gatesEnforced(ctx, dir)) all = boundNames(ctx, dir, 'approvals', 'approval$', all.slice().reverse()).sort().reverse();
  for (const n of all) {
    const f = `${ad}/${n}`;
    if (!safeStateFile(ctx, f)) continue;
    if (gateField(ctx, f, 'consumed') === 'false' && gateField(ctx, f, 'bound') === bound) return f;
  }
  return '';
}

/** `latest_request ID KIND`: the newest request file, or ''. @param {Context} ctx @param {string} id @param {string} kind */
function latestRequest(ctx, id, kind) {
  const ad = `${runDir(ctx, id)}/approvals`;
  const all = listNames(ad, new RegExp(`^[0-9]{3}-request-${reEsc(kindSlug(kind))}\\.yaml$`)).sort();
  return all.length ? `${ad}/${all[all.length - 1]}` : '';
}

// ---- the findings of a failing gate ------------------------------------------------------------------------------------------------

/** `fix_path_control ID PATH` (A127): only the run's own files. @param {Context} ctx @param {string} id @param {string} p */
function fixPathControl(ctx, id, p) {
  if (p.startsWith(`.agents/runs/${id}/`)) return knownControlArtifact(ctx, id, p);
  if (['PLAN.md', 'VERIFY.md', 'TASK.md', 'RUN.yaml', 'LEDGER.log', 'QA_PLAN.md', 'QA_REPORT.md', 'EVIDENCE.md', 'COMPLETION_REPORT.md'].includes(p)) return knownControlArtifact(ctx, id, `.agents/runs/${id}/${p}`);
  return false;
}

/** The blocking rows of a record split like `IFS='|' read -r _ _ path text _`. @param {Context} ctx @param {string} rec @returns {Array<[string, string]>} */
function blockingRows(ctx, rec) {
  /** @type {Array<[string, string]>} */ const out = [];
  for (const l of fileLines(ctx, rec)) {
    if (!/^finding: [^|]*\|blocking\|/.test(l)) continue;
    const f = l.split('|');
    out.push([f[2] ?? '', f[3] ?? '']);
  }
  return out;
}

/** `visual_row_text` @param {string} t */
const visualRowText = (t) => asciiLower(t).includes('reviews/visual-proof/');

/** `finding_plan_rows ID GATE_FILE` @param {Context} ctx @param {string} id @param {string} rec */
function findingPlanRows(ctx, id, rec) {
  let n = 0;
  for (const [path, text] of blockingRows(ctx, rec)) {
    if (text.startsWith('UNSUPPORTED ') || text.startsWith('risk signal ')) continue;
    if (visualRowText(text)) continue;
    if (fixPathControl(ctx, id, path.replace(/:[^]*$/, ''))) n++;
  }
  return n;
}

/** `finding_visual_rows GATE_FILE` @param {Context} ctx @param {string} rec */
function findingVisualRows(ctx, rec) {
  let n = 0;
  for (const [, text] of blockingRows(ctx, rec)) {
    if (text.startsWith('UNSUPPORTED ') || text.startsWith('risk signal ')) continue;
    if (visualRowText(text)) n++;
  }
  return n;
}

/** `grep -Ec RE` over a record's lines. @param {Context} ctx @param {string} rec @param {RegExp} re */
function countRows(ctx, rec, re) { return fileLines(ctx, rec).filter((l) => re.test(l)).length; }

/** `latest_finding_file ID` @param {Context} ctx @param {string} dir */
function latestFindingFile(ctx, dir) {
  let hit = '';
  for (const n of gateNames(ctx, dir)) {
    const f = `${gatesDirOf(dir)}/${n}`;
    if (!gateBoundToContract(ctx, dir, f)) continue;
    const r = gateField(ctx, f, 'result');
    if (r === 'reopen' || r === 'fail') hit = f;
  }
  return hit;
}

/** `scope_entry_paths LIST`: the paths of a comma list. @param {string} list @returns {string[]} */
function scopeEntryPaths(list) {
  return list.split(',').map((x) => x.replace(new RegExp(`^${WS}*`), '').replace(new RegExp(`${WS}*$`), '').replace(/:[^]*$/, '')).filter((x) => x !== '');
}

/** `fix_scope_union ID FILE` @param {Context} ctx @param {string} dir @param {string} ff */
function fixScopeUnion(ctx, dir, ff) {
  let scope = gateField(ctx, ff, 'fix_scope');
  if (gateField(ctx, ff, 'result') === 'fail') {
    const fp = gateField(ctx, ff, 'fingerprint');
    for (const n of gateNames(ctx, dir)) {
      const o = `${gatesDirOf(dir)}/${n}`;
      if (gateField(ctx, o, 'result') === 'fail' && gateField(ctx, o, 'fingerprint') === fp) scope = `${scope},${gateField(ctx, o, 'fix_scope')}`;
    }
  }
  return scope;
}

/** `fix_scope_siblings ID SCOPE`: the plan-scope paths sharing a criterion with a path of the list. @param {Context} ctx @param {string} dir @param {string} scope */
function fixScopeSiblings(ctx, dir, scope) {
  const ip = new Set(scopeEntryPaths(scope));
  const rows = planScope(ctx, dir).rows.map(([p, c]) => [p.includes('|') ? p.slice(0, p.indexOf('|')) : p, p.includes('|') ? p.slice(p.indexOf('|') + 1).split('|')[0] : c.split('|')[0]]);
  const crit = (/** @type {string} */ s) => s.split(',').map((c) => c.replace(new RegExp(`${WS}`, 'g'), ''));
  /** @type {Set<string>} */ const want = new Set();
  for (const [p, c] of rows) if (ip.has(p)) for (const x of crit(c)) want.add(x);
  return rows.filter(([, c]) => crit(c).some((x) => want.has(x))).map(([p]) => p);
}

/** `fix_allowed_paths ID` (A123) @param {Context} ctx @param {string} id @param {string} dir @returns {string[]} */
function fixAllowedPaths(ctx, id, dir) {
  const ff = latestFindingFile(ctx, dir);
  if (ff === '') return [];
  const sc = fixScopeUnion(ctx, dir, ff);
  if (scopeEntryPaths(sc).join('') === '*') return ['*'];
  const all = [...new Set([...scopeEntryPaths(sc), ...fixScopeSiblings(ctx, dir, sc)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return all.filter((p) => !fixPathControl(ctx, id, p));
}

/** `fix_paths_lines ID` @param {Context} ctx @param {string} id @param {string} dir @returns {string} */
function fixPathsLines(ctx, id, dir) {
  const ff = latestFindingFile(ctx, dir);
  if (ff === '' || gateField(ctx, ff, 'result') !== 'fail') return '';
  return fixAllowedPaths(ctx, id, dir).map((p) => `fix_path=${p}\n`).join('');
}

// ---- lines about the gates ------------------------------------------------------------------------------------------------------

/** `gate_report_ids ID GATE [FOCUS]`: the finding ids of a gate's current records (UNSUPPORTED rows excluded), sorted unique. @param {Context} ctx @param {string} dir @param {string} g @param {string} [focus] */
export function gateReportIds(ctx, dir, g, focus) {
  const fl = focus !== undefined && focus !== '' ? [focus] : ['-', ...riskGateFocuses(ctx, dir, g)];
  /** @type {string[]} */ const ids = [];
  for (const fc of fl) {
    const f = gateLatestFile(ctx, dir, g, fc);
    if (f === '') continue;
    for (const l of fileLines(ctx, f)) {
      const m = /^finding: ([^|]*)\|[a-z]*\|[^|]*\|([^|]*)\|/.exec(l);
      if (m && !`${m[1]}|${m[2]}`.includes('|UNSUPPORTED ')) ids.push(m[1]);
    }
  }
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `friction_count ID KIND`: the friction notes of one kind in the ledger ('' when there is no ledger, like `grep -c` on a missing file). @param {Context} ctx @param {string} dir @param {string} kind */
export function frictionCount(ctx, dir, kind) {
  if (!exists(`${dir}/LEDGER.log`)) return '';
  const re = new RegExp(`event=friction-note .*detail=${reEsc(kind)}$`);
  return String(fileLines(ctx, `${dir}/LEDGER.log`).filter((l) => re.test(l)).length);
}

/** `friction_reminder ID` @param {Context} ctx @param {string} id @param {string} dir */
function frictionReminder(ctx, id, dir) {
  return `note=FRICTION (A200): if you got past a proofline limit in this run with a workaround (a script error, a refusal that was wrong for a legitimate step, a gate or hook you had to route around, a hand edit), record it now: agent.sh friction-note ${id} proofline_bug (proofline_bug notes so far: ${frictionCount(ctx, dir, 'proofline_bug')}). The completion report lists the count; a workaround without a note is lost to the friction report.\n`;
}

/** `unsupported_next ID` @param {Context} ctx @param {string} id @param {string} dir */
function unsupportedNext(ctx, id, dir) {
  const all = riskUnsupported(ctx, dir);
  if (!all.length) return '';
  let out = '';
  for (const [k, v, t, e] of all) {
    out += `next=${unsupportedLabel(v)} ${k}: ${t.replace(/^UNSUPPORTED /, '')}${e !== '' ? ` (evidence: ${e})` : ''} -> list it in COMPLETION_REPORT.md '## Unsupported Checks' as '- ${k}: <reason>; not proven: <what>'\n`;
  }
  return `${out}next=surface these unsupported checks to the user in your reply: they were not proven, never passed\n`;
}

/** `not_rerun_next ID` @param {Context} ctx @param {string} id @param {string} dir */
function notRerunNext(ctx, id, dir) {
  let out = '';
  for (const l of riskNotRerun(ctx, dir)) {
    const w = l.replace(/ [^]*$/, '');
    out += `next=NOT_RERUN ${w}: not reproduced proof -> list it in COMPLETION_REPORT.md on its own line: '- ${w}: not reproduced (NOT_RERUN)'\n`;
  }
  for (const g of requiredGates(ctx, dir)) {
    const ids = gateReportIds(ctx, dir, g).join(' ');
    if (ids !== '') out += `next=gate ${g} findings to name in COMPLETION_REPORT.md (on a line that also names ${g}, e.g. '- ${g}: <id> <severity> <what>'): ${ids}\n`;
  }
  return out;
}

/** `batch_continue_note` after `batch_member`. @param {Context} ctx @param {string} id */
function batchContinueNote(ctx, id) {
  // batch_member: an approved batch needs the shared batch summary; without one the task is no member
  if (isFile(`${ctx.sharedMain()}/.agents/local/batch/SUMMARY.md`)) throw new BridgeToShell('batch summary present');
  void id;
  return '';
}

/** `build_record_unmakeable`: the reason, or '' when a build record can be made. @param {Context} ctx */
function buildRecordUnmakeable(ctx) {
  return configEmptyCmds(ctx) ? 'commands.build and commands.test are empty, so no build record can be made for this tree and the reviewers and the verifier have none to read' : '';
}

/** `[ -z "$(cfg_cmds commands.build)$(cfg_cmds commands.test)" ]` @param {Context} ctx */
function configEmptyCmds(ctx) {
  const cfg = ctx.config();
  return sub(cfg.cmds('commands.build').join('\n')) + sub(cfg.cmds('commands.test').join('\n')) === '';
}

/** `build_record_missing`: the build record script says exit 3 (no finished record for this tree). @param {Context} ctx */
function buildRecordMissing(ctx) {
  if (configEmptyCmds(ctx)) return false;
  const script = `${ctx.scripts}/build-record.sh`;
  if (!isFile(script)) return false;
  const r = proc.run('sh', [script, 'show'], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 3;
}

const BUILD_STEP = (/** @type {string} */ id) => `proofline doctor --commands   (finds the commands, proves each by one run and asks the user ONE question; the user's yes writes only the proven ones; then agent.sh build-record ${id} run). If the user declines, say in the completion report that no build or test was recorded`;

/** `knowledge_drift ID` and its one use: the shell runs the design-sync script; only the case without it is answered here. @param {Context} ctx @param {string} dir */
function knowledgeDriftNote(ctx, dir) {
  if (isFile(`${dir}/design/SYNC.md`) && isFile(`${ctx.root}/.agents/skills/design-sync/scripts/design-sync.mjs`)) throw new BridgeToShell('design-sync drift');
  return '';
}

// ---- the state machine ------------------------------------------------------------------------------------------------------------

/**
 * `next_step ID`: appends the lines of `next` to `emit`.
 * @param {Context} ctx @param {string} id @param {(text: string) => void} emit
 */
export function nextStep(ctx, id, emit) {
  requireRun(ctx, id);
  const d = runDir(ctx, id);
  const st = sectionValue(ctx, d, 'execution', 'state');
  const hs = sectionValue(ctx, d, 'handoff', 'state');
  emit(`task=${id}\nstate=${st}\nhandoff=${hs}\n`);
  const o = (/** @type {string} */ m) => emit(`next=${m}\n`);
  const r = (/** @type {string} */ m) => emit(`reason=${m}\n`);
  if (st === 'FAILED' || st === 'BLOCKED') { o(`report the evidence, then: agent.sh cleanup ${id}`); r(`run is terminal (${st})`); return; }
  if (sectionValue(ctx, d, 'execution', 'awaiting_input') === 'true') {
    o(`agent.sh questions ${id}`); o(`relay verbatim; then: agent.sh answer ${id} <N> --captured`); r("a question is pending (a specialist's NEEDS_INPUT or the lead's ask)"); return;
  }
  const stale = staleMarkers(ctx, d);
  const fly = inflightDispatch(ctx, d);
  if (fly) {
    const fp = inflightParts(fly);
    o(`wait: dispatch.sh ${id} ${fp.role} in flight (pid ${fp.pid}; others may be too, see dispatch/*.running); do not start other work on this step and do not read its log or result until the command returns`);
    r('a dispatch is running (A124)');
    emit(budgetNote(ctx, d));
    removeMarkers(d, stale);
    return;
  }
  // the markers are removed only when the command finishes here (a hand-over to the shell finds them still there)
  if (stale.length) emit(`note=stale dispatch marker removed: ${stale.join(' ')}\n`);
  states(ctx, id, d, st, hs, emit, o, r);
  removeMarkers(d, stale);
}

/**
 * The part of `next_step` after the dispatch check.
 * @param {Context} ctx @param {string} id @param {string} d @param {string} st @param {string} hs
 * @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r
 */
function states(ctx, id, d, st, hs, emit, o, r) {
  const cls = pipelineClass(ctx, d);
  if (!pipelineClassValid(cls)) {
    o(`agent.sh classify ${id} <TRIVIAL|STANDARD|COMPLEX|CRITICAL> [review]`);
    r('run is not classified (TRIVIAL is text and configuration only; a plan that changes code or adds tests is STANDARD or higher)');
    return;
  }
  if (sectionKeyPresent(ctx, d, 'repository', 'task_branch')) {
    const b = sectionValue(ctx, d, 'repository', 'task_branch');
    if (b === '' || b === 'PENDING') { o(`agent.sh branch ${id}`); r('task branch not established'); return; }
  }
  if (sectionValue(ctx, d, 'baseline', 'status') !== 'captured') { o(`agent.sh baseline ${id}`); r('baseline not captured'); return; }
  if (!freezeHashPresent(ctx, d)) { preFreeze(ctx, id, d, cls, emit, o, r); return; }
  switch (hs) {
    case 'PLANNED': planned(ctx, id, d, o, r); break;
    case 'IMPLEMENTING': implementing(ctx, id, d, o, r, emit); break;
    case 'IMPLEMENTED': implemented(ctx, id, d, emit, o, r); break;
    case 'CODE_DONE': codeDone(ctx, id, d, emit, o, r); break;
    case 'DONE': done(ctx, id, d, emit, o, r); break;
    default: break;
  }
}

/** `freeze_hash_present` @param {Context} ctx @param {string} d */
function freezeHashPresent(ctx, d) {
  let inside = false;
  const re = new RegExp(`^${WS}*(task|evidence|plan|policy)_sha256: "[0-9a-f][0-9a-f]`);
  for (const l of fileLines(ctx, `${d}/RUN.yaml`)) {
    if (l === 'freeze:') { inside = true; continue; }
    if (inside && new RegExp(`^[^ \\t\\n\\v\\f\\r]`).test(l)) return false;
    if (inside && re.test(l)) return true;
  }
  return false;
}

/** The plan step: everything before the freeze. @param {Context} ctx @param {string} id @param {string} d @param {string} cls @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r */
function preFreeze(ctx, id, d, cls, emit, o, r) {
  const cfg = ctx.config();
  if (pipelineNeeds(ctx, d, 'evidence') === 'yes' && !isFile(`${d}/EVIDENCE.md`)) {
    o(`dispatch.sh ${id} explorer (one per bounded assignment, at most ${pipelineValue(ctx, cls, 'max_explorers')}); then consolidate EVIDENCE.md`); r('EVIDENCE.md missing'); return;
  }
  // A200: the plan step is the time to fix empty verification commands
  if (configEmptyCmds(ctx)) emit('note=commands.build and commands.test are empty: run proofline doctor --commands (it finds them, proves each by one run and asks the user once; the PLAN Verification commands and the build record need them; this run does not wait for it)\n');
  if (!isFile(`${d}/PLAN.md`)) { o('write PLAN.md (plan-contract)'); r('PLAN.md missing'); return; }
  const plan = fileText(ctx, `${d}/PLAN.md`);
  if (pipelineNeeds(ctx, d, 'architect') === 'yes' && !planSectionPresent(plan, 'Architecture')) { o(`dispatch.sh ${id} architect (PLAN.md ## Architecture)`); r(`the ${cls} pipeline needs an Architecture section`); return; }
  // A78: a risk signal of the planned scope (or the diff so far) without its PLAN.md flag: the design role declares it
  const mf = riskMissingFlags(ctx, d)[0];
  if (mf) {
    const [n, , p, fl] = mf;
    o(`dispatch.sh ${id} ${cfg.get(`risk.${n}.design_role`, 'architect')} (declare ${fl} in PLAN.md for risk signal ${n}: ${p}; see agent.sh pipeline ${id})`);
    r(`risk signal ${n} without its plan flag ${fl} (A78): after IMPLEMENT it is a blocking finding`); return;
  }
  if (pipelineNeeds(ctx, d, 'qa') === 'yes' && !isFile(`${d}/QA_PLAN.md`)) { o(`dispatch.sh ${id} qa (QA_PLAN.md)`); r('QA_PLAN.md missing'); return; }
  const ph = hashFile(`${d}/PLAN.md`);
  if (planMigrationShape(ctx, d) === 'missing') { o("fix PLAN.md ## Data: expand/contract steps (data-design), or single_step: yes with the user's approval"); r('destructive plan without expand/contract steps'); return; }
  const ae = assumptionShapeErrors(ctx, d).map((e) => `${e};`).join('');
  if (ae !== '') { o(`fix the '## Assumptions' section of PLAN.md / EVIDENCE.md (none, or the register table): ${ae}`); r('assumption register invalid'); return; }
  if (assumptionBlocked(ctx, d).length) {
    o(`agent.sh verify-assumptions ${id}; verify each unverified high-risk assumption (update the register), or: agent.sh freeze ${id} (records one NEEDS_INPUT question per assumption; relay it, the user answers 'accept <id>' or gives the corrected fact)`);
    r('unverified high-risk assumption blocks the freeze'); return;
  }
  const te = gatesEnforced(ctx, d) ? taskDefectError(ctx, d) : '';
  if (te !== '') { o("fix TASK.md ## Pre-existing defects (task-author): list each defect the request does not ask for as '- <path:symbol>: <what> -- decision: report'; 'decision: fix' only on the user's own words, then a scope approval"); r(`A105: ${te}`); return; }
  for (const k of ['plan', 'scope']) {
    if (k === 'plan' && runAutonomy(ctx, d) !== 'supervised') continue;
    if (k === 'scope' && taskDefectFixes(fileText(ctx, `${d}/TASK.md`)).length === 0) continue;
    if (findApproval(ctx, id, k, ph) === '') {
      requestApproval(ctx, id, k, ph, o);
      r(`${k} approval required before freeze`); return;
    }
  }
  o(`agent.sh freeze ${id}`); r('artifacts ready');
}

/** The line for a missing approval: ask for it, or (a request already stands) leave the wait line to the shell. @param {Context} ctx @param {string} id @param {string} kind @param {string} ph @param {(m: string) => void} o */
function requestApproval(ctx, id, kind, ph, o) {
  const rq = latestRequest(ctx, id, kind);
  if (rq !== '' && gateField(ctx, rq, 'bound') === ph) throw new BridgeToShell('pending approval request');
  o(`agent.sh request-approval ${id} ${kind} (relay verbatim)`);
}

/** @param {Context} ctx @param {string} id @param {string} d @param {(m: string) => void} o @param {(m: string) => void} r */
function planned(ctx, id, d, o, r) {
  const ph = hashFile(`${d}/PLAN.md`);
  let ask = false;
  if (planDestructive(fileText(ctx, `${d}/PLAN.md`)) === 'yes') {
    const kinds = planMigrationShape(ctx, d) === 'single_step' ? ['destructive', 'single_step'] : ['destructive'];
    for (const k of kinds) {
      if (findApproval(ctx, id, k, ph) !== '') continue;
      requestApproval(ctx, id, k, ph, o);
      r(`${k} approval required before IMPLEMENT`); ask = true; break;
    }
  }
  if (!ask) { o(`agent.sh handoff ${id} IMPLEMENTING`); r('plan frozen'); }
}

/** @param {Context} ctx @param {string} id @param {string} d @param {(m: string) => void} o @param {(m: string) => void} r @param {(t: string) => void} emit */
function implementing(ctx, id, d, o, r, emit) {
  // A200: an implementer DONE recorded after the last IMPLEMENTING handoff means the work is delivered
  let done = false;
  for (const l of fileLines(ctx, `${d}/LEDGER.log`)) {
    if (l.includes('event=handoff:IMPLEMENTING')) done = false;
    if (l.includes('event=record:implementer:DONE')) done = true;
  }
  if (done) { o(`agent.sh handoff ${id} IMPLEMENTED`); r("the implementer's DONE result is recorded: record IMPLEMENTED now, do not wait and do not dispatch it again"); return; }
  o(`dispatch.sh ${id} implementer`); o(`agent.sh handoff ${id} IMPLEMENTED`); emit(fixPathsLines(ctx, id, d)); r('implementation in progress');
}

/** @param {Context} ctx @param {string} id @param {string} d @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r */
function implemented(ctx, id, d, emit, o, r) {
  const fp = gateFingerprint(ctx);
  let fail = ''; let todo = '';
  for (const g of requiredGates(ctx, d)) {
    const s = gateStatus(ctx, d, id, g, 'reuse', fp);
    if (s === 'pass' || s === 'waived') continue;
    if (s === 'fail') fail += ` ${g}`; else todo += ` ${g}:${s}`;
  }
  if (fail !== '') { failing(ctx, id, d, fail, emit, o, r); return; }
  if (todo !== '') { gatesTodo(ctx, id, d, todo, fp, emit, o, r); return; }
  emit(unsupportedNext(ctx, id, d)); emit(notRerunNext(ctx, id, d)); emit(frictionReminder(ctx, id, d));
  o(`agent.sh handoff ${id} CODE_DONE`); r('every required gate passes');
}

/** @param {Context} ctx @param {string} id @param {string} d @param {string} fail @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r */
function failing(ctx, id, d, fail, emit, o, r) {
  const failed = fail.trim().split(' ');
  const used = fixRoundsUsed(ctx, d);
  // A78: script findings are not fixed by the implementer: a missing flag is a plan amendment, UNSUPPORTED the user's call
  let scr = 0; let oth = 0; let pl = 0; let ac = 0; let cov = 0; let vp = 0;
  for (const g of failed) {
    for (const fc of ['-', ...riskGateFocuses(ctx, d, g)]) {
      const lf = gateLatestFile(ctx, d, g, fc);
      if (lf === '') continue;
      const a = countRows(ctx, lf, /^finding: [^|]*\|blocking\|/);
      const b = countRows(ctx, lf, /^finding: [^|]*\|blocking\|[^|]*\|(UNSUPPORTED |risk signal )/);
      scr += b; oth += a - b;
      pl += findingPlanRows(ctx, id, lf);
      cov += countRows(ctx, lf, /^finding: [^|]*\|blocking\|.*(maps to no scope path|requires tdd_exemption)/);
      vp += findingVisualRows(ctx, lf);
      ac += countRows(ctx, lf, /^finding: [^|]*\|blocking\|[^|]*\|(AC proof cites|re-running `|the recorded output line)/);
      if (asciiLower(gateField(ctx, lf, 'result')) === 'fail' && !(a > 0)) oth++;
      for (const l of fileLines(ctx, lf)) {
        const m = /^finding: ([^|]*)\|blocking\|[^|]*\|UNSUPPORTED /.exec(l);
        if (m && !findingWaived(ctx, d, lf, m[1])) o(`agent.sh request-approval ${id} waive:${m[1]} (blocking UNSUPPORTED ${fc}: an INCONCLUSIVE measurement or risk.unsupported: block, never a PASS; the user decides whether to accept the gap, listed in the completion report)`);
      }
      for (const l of fileLines(ctx, lf)) {
        const m = /^finding: ([^|]*)\|blocking\|[^|]*\|risk signal /.exec(l);
        if (m && !findingWaived(ctx, d, lf, m[1])) o(`amend PLAN.md to declare the flag of ${m[1]} (dispatch the design role), then agent.sh refreeze ${id} <amendment>; or the user waives ${m[1]}`);
      }
    }
  }
  if (scr > 0 && oth === 0) {
    o('the implementer cannot clear these: only UNSUPPORTED or missing-flag findings fail (waive them, or amend PLAN.md and refreeze)');
    o(`agent.sh terminate ${id} BLOCKED (reason and evidence on stdin), if the user declines the waiver and the plan cannot be amended`);
  } else if (vp > 0 && oth <= vp) {
    // A200: the visual evidence report is missing or does not cover a criterion. The plan is fine; no PLAN.md amendment, no implementer fix round.
    o(`dispatch.sh ${id} qa --focus visual   (measures and writes reviews/visual-proof/report.json; the verifier cites it only after it exists)`);
    o(`then re-dispatch the verifier: dispatch.sh ${id} verifier. Do not amend PLAN.md ## Verification commands for this: the finding is about the visual evidence report, not about a command`);
  } else if (pl > 0 && oth <= pl) {
    // A127: the plan or its verification commands answer these rows, not the implementer
    o(`amend PLAN.md ## Verification commands (lead owns it; write amendments/<NNN>.md and edit PLAN.md), then agent.sh refreeze ${id} <AMENDMENT>; a scope approval is needed only if the amendment adds scope paths`);
    if (cov !== 0) o('a row that says an AC maps to no scope path, or that command proof requires tdd_exemption, is fixed in PLAN.md front matter: add the AC to `criteria:` of the scope entries that implement it, and plan a command that proves it (not only a ## Verification commands line)');
    o(`the new plan hash voids the worker evidence and every gate: dispatch.sh ${id} implementer re-records RED and GREEN against it (a real failing test and a real change; a path with a tdd_exemption needs none), then agent.sh handoff ${id} IMPLEMENTED, then every gate again, VERIFY included`);
    o(`a commands-only amendment on a non-exempt path has no honest RED: complete Verification commands before freeze; if the verifier only failed to cite a planned or configured command, re-dispatch it instead (dispatch.sh ${id} verifier)`);
  } else if (used <= maxFixRounds(ctx)) {
    o(`agent.sh handoff ${id} IMPLEMENTING (fix round ${used}; findings of:${fail})`); o(`dispatch.sh ${id} implementer (with the findings)`); emit(fixPathsLines(ctx, id, d));
  } else o(`agent.sh terminate ${id} FAILED (reason and evidence on stdin)`);
  if (ac !== 0) o('re-dispatch the verifier citing only a configured or planned command with a recorded exit status and one stable output line (A107 rows); a command missing from Verification commands needs the amendment route');
  for (const g of failed) {
    for (const fc of ['-', ...riskGateFocuses(ctx, d, g)]) {
      const lf = gateLatestFile(ctx, d, g, fc);
      if (lf === '' || gateField(ctx, lf, 'result') !== 'fail') continue;
      for (const row of gateBlockingRows(ctx, lf, 3)) emit(`finding=${g} ${row}\n`); // A200: the real finding, whatever the remedy above
    }
  }
  r(`failing gates:${fail}`);
}

/** @param {Context} ctx @param {string} id @param {string} d @param {string} todo @param {string} fp @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r */
function gatesTodo(ctx, id, d, todo, fp, emit, o, r) {
  // A171: the build record the reviewers and the verifier read comes first; it is a missing step, not a reviewer's lowered confidence
  if (/REVIEW_|VERIFY/.test(todo)) {
    const bu = buildRecordUnmakeable(ctx);
    if (bu !== '') emit(`missing_step=lead, before the review gates: ${bu}. Do: ${BUILD_STEP(id)}\n`);
    if (buildRecordMissing(ctx)) o(`agent.sh build-record ${id} run   (the build record is missing for this tree: make it before the review gates; reviewers and the verifier read it)`);
  }
  for (const x of todo.trim().split(' ')) {
    const g = x.replace(/:[^]*$/, '');
    const um = [];
    for (const dep of gateDeps(ctx, d, g)) {
      const cut = dep.indexOf(':');
      if (!gateSatisfied(gateFocusStatus(ctx, d, id, dep.slice(0, cut), dep.slice(cut + 1), 'reuse', fp))) um.push(dep);
    }
    if (um.length) { emit(`note=${g} waits for ${um.join(' ')} (gate dependency, A171): not offered before it passes\n`); continue; }
    if (g === 'SECRETS') { o(`agent.sh secret-scan ${id}`); continue; }
    for (const fc of ['-', ...riskGateFocuses(ctx, d, g)]) {
      if (gateSatisfied(gateFocusStatus(ctx, d, id, g, fc, 'reuse', fp))) continue;
      if (fc === '-') o(g.startsWith('REVIEW_') ? `dispatch.sh ${id} reviewer --focus ${gateFocus(g)}` : `dispatch.sh ${id} ${gateOwner(g)}`);
      else o(`dispatch.sh ${id} ${gateOwner(g)} --focus ${fc}`);
    }
  }
  r(`gates not passing:${todo}`);
}

/** @param {Context} ctx @param {string} id @param {string} d @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r */
function codeDone(ctx, id, d, emit, o, r) {
  emit(batchContinueNote(ctx, id));
  // A184 (round 2): a gate of the effective tier that is not satisfied for the task-owned patch cannot be recorded any more
  let miss = '';
  const tp = taskPatchFingerprint(ctx, d);
  const tier = tierEffective(ctx, d);
  for (const g of requiredGates(ctx, d, tier)) if (!gateSatisfied(gateStatus(ctx, d, id, g, 'patch', tp))) miss += ` ${g}`;
  if (miss !== '') {
    o(`agent.sh amend ${id} (reopens the run only when every required gate passes) or a new task for the extra work; do NOT dispatch reviewers: a gate result cannot be recorded in CODE_DONE`);
    r(`the effective tier is ${tierEffective(ctx, d)} at CODE_DONE and these gates do not pass for the task-owned patch:${miss} (what raised it: agent.sh report-facts ${id})`);
    return;
  }
  const ks = sectionValue(ctx, d, 'execution', 'knowledge_state');
  if (ks === 'KNOWLEDGE_DONE' || ks === 'not_applicable') {
    const published = sectionValue(ctx, d, 'completion_report', 'published') === 'true';
    if (!published) emit(frictionReminder(ctx, id, d));
    if (!published) {
      emit(unsupportedNext(ctx, id, d)); emit(notRerunNext(ctx, id, d));
      o(`write COMPLETION_REPORT.md (top: the summary block of the template in the user's language, no Look-at lines, publish copies QA_REPORT.md Human checks; no counts of tests, gates, fix rounds or refreezes in your text unless they equal 'agent.sh report-facts ${id}'; publish appends that Facts block); agent.sh publish-completion-report ${id}`);
      r('completion report not published');
    } else { o(`agent.sh handoff ${id} DONE`); r('report published'); }
  } else {
    knowledgeDriftNote(ctx, d);
    o(`agent.sh knowledge-done ${id} [not_applicable "<reason>"]`); r('knowledge transaction not recorded');
  }
}

/** @param {Context} ctx @param {string} id @param {string} d @param {(t: string) => void} emit @param {(m: string) => void} o @param {(m: string) => void} r */
function done(ctx, id, d, emit, o, r) {
  emit(batchContinueNote(ctx, id));
  // A169: once the merge step ran (a pull request is open) CI decides: the shell prints those lines
  if (isFile(`${ctx.root}/.agents/local/deliver/${id}/PR`)) throw new BridgeToShell('pull request open');
  o(`agent.sh request-approval ${id} commit (delivery needs the user's approval)`);
  o(`agent.sh cleanup ${id} (after delivery)`);
  o('optional: agent.sh friction show; send it as a GitHub issue only if the user wants it: agent.sh request-approval - report, then agent.sh friction send');
  r('run DONE');
}

/** `next_without_run` @param {Context} ctx @param {(t: string) => void} emit */
export function nextWithoutRun(ctx, emit) {
  const id = activeRun(ctx);
  if (id !== '') { nextStep(ctx, id, emit); return; }
  emit('task=none\nnext=agent.sh start <ID> [--title "<title>"] [--task-file <path>]\nreason=obtain a canonical task from task-author or an adapter import, then start it\n');
}
