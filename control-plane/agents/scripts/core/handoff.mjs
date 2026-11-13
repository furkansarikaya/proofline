// @ts-check
// Stage 4, package 4B: `handoff` (the ladder PLANNED -> IMPLEMENTING -> IMPLEMENTED -> CODE_DONE -> DONE) with everything only it uses: the approvals of
// the first step, the classification and defect-report checks, the fix bound, the scratch-worktree check, the language check of the run folder and the
// effective tier record. Messages, ordering of the checks and the writes are those of agent.sh 0.0.47 (the freeze consumes approvals, so does this).
import { buildRecord } from './buildrecord.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fail } from './errors.mjs';
import { findApproval } from './approvals.mjs';
import { consumeApproval, requireOpenRun } from './approve.mjs';
import { dbGuardCheck } from './dbguard.mjs';
import { hashFile } from './fingerprint.mjs';
import { fixRoundsUsed, gateStatus, maxFixRounds, patchManifest, requiredGates, taskPatchFingerprint, verifyLifecycleGates, verifyMutationOwnership, verifyRequiredGates } from './gates.mjs';
import { git } from './git.mjs';
import { languageFailText, languageScanFiles } from './language.mjs';
import { verifySeal } from './ledger.mjs';
import { enforceTaskBranch, setRunValue } from './lifecycle.mjs';
import { led, must } from './lifeutil.mjs';
import { BUILD_STEP, buildRecordMissing, buildRecordUnmakeable, fixAllowedPaths, fixScopeSiblings, fixScopeUnion, latestFindingFile, scopeEntryPaths } from './next.mjs';
import { planMigrationShape, taskDefectError, taskDefectFixes } from './plancheck.mjs';
import * as proc from './proc.mjs';
import { fileText, gateField, gatesEnforced, sectionKeyPresent, sectionValue, textLines } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { pathMatches } from './scope.mjs';
import { pipelineClass, pipelineClassValid, taskChangedPaths, tierEffective } from './signals.mjs';
import { statusBlockUpdate } from './statusblock.mjs';
import { scanKnowledgeSecrets } from './commands/runcmds.mjs';
import { freshness, verifyKnowledgeScope, verifyScope, verifyWorkerEvidence } from './commands/verify.mjs';
import { EXECUTABLE_CODE_DEFAULT } from './pathkind.mjs';
import { planDestructive } from './records.mjs';
import { asciiLower } from './shellglob.mjs';
import { isScratchWorktreeWin } from './pathin.mjs';
import { taskType } from './taskfile.mjs';
import { metricsRun } from './runend.mjs';
import { verifyCompletionReport } from './complreport.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** `paths_executable`: the paths of a list that match review.executable_code. @param {Context} ctx @param {string[]} paths */
export function pathsExecutable(ctx, paths) {
  const globs = ctx.config().get('review.executable_code', EXECUTABLE_CODE_DEFAULT);
  return paths.filter((p) => p !== '' && pathMatches(p, globs));
}

/** `verify_classification ID` (A31) @param {Context} ctx @param {string} id */
export function verifyClassification(ctx, id) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir) || !pipelineClassValid(pipelineClass(ctx, dir))) return;
  if (pipelineClass(ctx, dir) !== 'TRIVIAL') return;
  const hits = pathsExecutable(ctx, taskChangedPaths(ctx, dir));
  if (hits.length === 0) return;
  fail(`classification blocked: run ${id} is TRIVIAL but its diff changes executable code:${hits.map((h) => ` ${h}`).join('')}. TRIVIAL covers text and configuration only. Reclassify: write the evidence and QA plan the new class requires, 'agent.sh classify ${id} STANDARD' (or higher), then amend and 'agent.sh refreeze ${id} <AMENDMENT>'.`);
}

/** `task_defect_label TASK.md`: the first type or label word that makes the task a defect task. @param {Context} ctx @param {string} text */
function taskDefectLabel(ctx, text) {
  const words = ctx.config().get('review.defect_words', 'bug defect regression').split(/[ \t\n]+/).filter((w) => w !== '');
  const hit = (/** @type {string} */ s) => {
    const t = ` ${asciiLower(s)} `.replace(/[^a-z]+/g, ' ');
    for (const w of words) if (w !== '' && t.includes(` ${w} `)) return w;
    return '';
  };
  const ws = '[ \\t\\n\\v\\f\\r]';
  const reFmKey = new RegExp(`^${ws}*(type|kind|labels?)${ws}*:`);
  const reKey = new RegExp(`^${ws}*[*_]*(type|kind|labels?)[*_]*${ws}*:`);
  let c = false; let fm = false; let seen = false; let sec = '';
  for (const line of textLines(text)) {
    if (line.includes('<!--')) c = true;
    if (c) { if (line.includes('-->')) c = false; continue; }
    if (!fm && !seen && line === '---') { fm = true; continue; }
    if (fm && line === '---') { fm = false; continue; }
    if (line.startsWith('##')) seen = true;
    if (fm) { if (reFmKey.test(asciiLower(line))) { const x = hit(line); if (x !== '') return x; } continue; }
    if (reKey.test(asciiLower(line))) { const x = hit(line); if (x !== '') return x; }
    if (new RegExp(`^###?${ws}`).test(line)) {
      const h = asciiLower(line).replace(new RegExp(`^#+${ws}+`), '').replace(new RegExp(`${ws}+$`), '');
      sec = h === 'labels' || h === 'type' || h === 'suggested class' ? h : '';
      continue;
    }
    if (sec === 'labels' || sec === 'type' || sec === 'suggested class') { const x = hit(line); if (x !== '') return x; }
  }
  return '';
}

/** `verify_debug_result ID` (A35, A200, A202) @param {Context} ctx @param {string} id */
export function verifyDebugResult(ctx, id) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir) || !pipelineClassValid(pipelineClass(ctx, dir))) return;
  const task = fileText(ctx, `${dir}/TASK.md`);
  if (task === null) return;
  let hit = taskType(task) === 'bug' ? 'type: bug' : '';
  if (pipelineClass(ctx, dir) === 'TRIVIAL' && hit === '') return;
  if (hit === '') hit = taskDefectLabel(ctx, task);
  if (hit === '' && taskDefectFixes(task).length > 0) hit = 'decision: fix';
  if (hit === '') return;
  let has = false;
  try { has = readdirSync(`${dir}/reports`).some((n) => /^[0-9]{3}-debug\.md$/.test(n)); } catch { /* none */ }
  if (has) return;
  fail(`IMPLEMENTED blocked: the task is typed or labelled as a defect ('${hit}' in its type, labels, suggested class or a decision: fix entry) but there is no debug-proof result: write reports/NNN-debug.md with the debug-proof skill (reproduction, root cause, regression test) (this always works, also after freeze); an UNRELATED pre-existing defect must instead be declared under '## Pre-existing defects' as '- <path:symbol>: <what> -- decision: report' BEFORE freeze: after freeze that needs an amendment and a refreeze (maybe another plan approval), so prefer the debug report`);
}

/** `verify_no_scratch_worktrees` @param {Context} ctx */
export function verifyNoScratchWorktrees(ctx) {
  let t = (ctx.env.TMPDIR || '/tmp').replace(/\/$/, '');
  t = t.replace(/^\/private/, '');
  const list = git(ctx, ['worktree', 'list', '--porcelain']).out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  const main = (list[0] ?? '').replace(/^\/private/, '');
  const rootN = ctx.root.replace(/^\/private/, '');
  let extra = '';
  for (const p of list) {
    const n = p.replace(/^\/private/, '');
    if (n === rootN) continue;
    if (n === main) continue;
    if (n.startsWith(`${main}/.agents/local/worktrees/`)) continue;
    if (n.startsWith(`${t}/`) || n.startsWith('/tmp/') || n.startsWith('/var/folders/') || isScratchWorktreeWin(p, list[0] ?? '', ctx.root, [ctx.env.TEMP, ctx.env.TMP, ctx.env.TMPDIR])) extra += ` ${p}`;
  }
  if (extra !== '') fail(`CODE_DONE blocked: scratch git worktrees created during the run are still registered:${extra}. Remove each ('git worktree remove --force <path>'; the lead may run it) and run it again`);
}

/** `verify_fix_bound ID` (A123) @param {Context} ctx @param {string} id */
export function verifyFixBound(ctx, id) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) return;
  const f = latestFindingFile(ctx, dir);
  if (f === '') return;
  const patch = taskPatchFingerprint(ctx, dir);
  if (patch === gateField(ctx, f, 'patch_sha256')) fail(`no application/test change since the finding in ${f.slice(f.lastIndexOf('/') + 1)}: a fix must change the tree before it can be re-reviewed`);
  const scope = fixScopeUnion(ctx, dir, f);
  if (scopeEntryPaths(scope).join('') === '*') return;
  const sib = fixScopeSiblings(ctx, dir, scope);
  const scoped = scopeEntryPaths(scope);
  /** @type {string[]} */ let before = [];
  try { before = textLines(readFileSync(`${f.replace(/\.yaml$/, '')}.manifest`, 'latin1')); } catch { /* the shell's cat fails and the pipeline goes on */ }
  const all = [...before, ...patchManifest(ctx, dir)].filter((l) => l !== '');
  /** @type {Map<string, number>} */ const count = new Map();
  for (const l of all) count.set(l, (count.get(l) ?? 0) + 1);
  const delta = [...new Set([...count].filter(([, n]) => n === 1).map(([l]) => (l.includes('|') ? l.slice(0, l.indexOf('|')) : l)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const frozen = sectionValue(ctx, dir, 'freeze', 'scope_paths').split(',');
  let bad = '';
  for (const p of delta) {
    if (scoped.includes(p) || sib.includes(p)) continue;
    // A fix needs its regression test (tdd): a test path of the frozen scope is always inside the fix.
    if (frozen.includes(p) && pathMatches(p, '**/test/** **/tests/** **/__tests__/** **/spec/** *_test.* *.test.* *.spec.* test_*.* *Test.* *Tests.*')) continue;
    bad += ` ${p}`;
  }
  if (bad !== '') fail(`fix changed paths outside the finding's fix_scope (${f.slice(f.lastIndexOf('/') + 1)}):${bad}\nallowed fix paths (finding paths plus frozen plan scope paths sharing an acceptance criterion with them):\n${fixAllowedPaths(ctx, id, dir).map((p) => `  ${p}`).join('\n')}\na path the plan never scoped needs the user's scope approval: the lead asks (agent.sh ask, D13 block), then amends PLAN.md and runs agent.sh refreeze`);
}

/** `reopen_for_fix ID` @param {Context} ctx @param {string} id */
function reopenForFix(ctx, id) {
  const dir = runDir(ctx, id);
  let any = false;
  for (const g of requiredGates(ctx, dir)) if (gateStatus(ctx, dir, id, g) === 'fail') any = true;
  if (!any) fail('no open gate finding on the current content: nothing to fix, and a run does not return to IMPLEMENTING without one');
  const used = fixRoundsUsed(ctx, dir); const max = maxFixRounds(ctx);
  if (!(used <= max)) fail(`fix rounds exhausted (${used} failing rounds, max_fix_rounds ${max}): end the run with 'agent.sh terminate ${id} FAILED' (a refreeze with a new budget needs the user's 'budget' approval)`);
  setRunValue(ctx, id, 'handoff', 'implemented_patch_sha256', 'PENDING');
  setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', 'PENDING');
}

/** `build_record_auto ID` (handoff IMPLEMENTED, lead) @param {Context} ctx @param {string} id */
function buildRecordAuto(ctx, id) {
  if (ctx.role !== 'lead') return;
  const why = buildRecordUnmakeable(ctx);
  if (why !== '') { ctx.err(`MISSING STEP (lead): ${why}. Do: ${BUILD_STEP(id)}\n`); return; }
  if (!buildRecordMissing(ctx)) return;
  const r = buildRecord(ctx, 'run');
  if (r.status === 0) ctx.err(`build record made for the implemented tree (agent.sh build-record ${id} show)\n`);
  else ctx.err(`MISSING STEP (lead): the build record of this tree could not be made (see agent.sh build-record ${id} run); the handoff is not blocked, but the reviewers and the verifier have no record to read. Fix what it reports (a missing install, secret or env file), then run agent.sh build-record ${id} run\n`);
}

/** `verify_run_language ID` @param {Context} ctx @param {string} id */
export function verifyRunLanguage(ctx, id) {
  const dir = runDir(ctx, id);
  /** @type {string[]} */ const files = [];
  /** @param {string} d @param {boolean} top */
  const walk = (d, top) => {
    let names;
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) { if (top && (e.name === 'dispatch' || e.name === 'scratch' || e.name === 'gates')) continue; walk(full, false); continue; }
      if (!e.isFile() && !statOk(full)) continue;
      if (!/\.(md|yaml|json)$/.test(e.name) || e.name.startsWith('dispatch-') || e.name === 'LEDGER.log') continue;
      files.push(full);
    }
  };
  walk(dir, true);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hits = languageScanFiles(ctx, files);
  if (hits.length > 0) fail(languageFailText(hits.join(' ')));
}

/** @param {string} f */
function statOk(f) { try { return statSync(f).isFile(); } catch { return false; } }

/** `tier_record ID`: the effective tier, recorded when it rose (lead only). @param {Context} ctx @param {string} id */
export function tierRecord(ctx, id) {
  const dir = runDir(ctx, id);
  const t = tierEffective(ctx, dir);
  if (ctx.role === 'lead' && sectionKeyPresent(ctx, dir, 'pipeline', 'tier') && sectionValue(ctx, dir, 'pipeline', 'tier') !== t) {
    const prev = sectionValue(ctx, dir, 'pipeline', 'tier');
    setRunValue(ctx, id, 'pipeline', 'tier', t);
    led(ctx, id, 'tier', prev, t, 'effective tier');
  }
  return t;
}

/** `implement_approvals ID` (K-6): the approval files the first step consumes. @param {Context} ctx @param {string} id */
function implementApprovals(ctx, id) {
  const dir = runDir(ctx, id);
  requireTaskDefects(ctx, id);
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (planDestructive(plan) !== 'yes') return [];
  const ph = hashFile(`${dir}/PLAN.md`);
  const a = findApproval(ctx, id, 'destructive', ph);
  if (a === null) fail(`PLAN.md declares a destructive data change: a destructive approval bound to the frozen PLAN.md is required before IMPLEMENT ('agent.sh request-approval ${id} destructive'; relay it, the runtime records the user's reply; a refreeze drops an earlier approval)`);
  const out = [a];
  if (planMigrationShape(ctx, dir) === 'single_step') {
    const b = findApproval(ctx, id, 'single_step', ph);
    if (b === null) fail(`PLAN.md '## Data' declares single_step: yes: a destructive migration without expand/contract steps needs the user's explicit single-step approval bound to the frozen PLAN.md before IMPLEMENT ('agent.sh request-approval ${id} single_step')`);
    out.push(b);
  }
  return out;
}

/** `require_task_defects ID` (A105) @param {Context} ctx @param {string} id */
export function requireTaskDefects(ctx, id) {
  const e = taskDefectError(ctx, runDir(ctx, id));
  if (e !== '') fail(`TASK.md ## Pre-existing defects (A105): ${e}. List each defect the request does not ask for as '- <path:symbol>: <what> -- decision: report' (left unchanged, named in the completion report); 'decision: fix' only when the user asked for it in their own words, and then the user's scope approval ('agent.sh request-approval ${id} scope') is needed. A delegated answer such as 'use your recommended option' never makes a defect fix requested`);
}

/** `record_handoff ID PHASE` @param {Context} ctx @param {string} id @param {string} phase */
export function recordHandoff(ctx, id, phase) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  enforceTaskBranch(ctx, id); requireOpenRun(ctx, id);
  if (!['IMPLEMENTING', 'IMPLEMENTED', 'CODE_DONE', 'DONE'].includes(phase)) fail('invalid handoff phase');
  const allowKnowledge = phase === 'DONE';
  must(freshness(ctx, id));
  must(verifyScope(ctx, id, allowKnowledge));
  verifySeal(ctx, id, dir);
  const patch = taskPatchFingerprint(ctx, dir);
  const current = sectionValue(ctx, dir, 'handoff', 'state');
  let detail = '';
  /** @type {string[]} */ let approvals = [];
  const illegal = () => fail(`illegal handoff transition: ${current} -> ${phase}`);
  switch (phase) {
    case 'IMPLEMENTING':
      if (current === 'PLANNED') { if (gatesEnforced(ctx, dir)) approvals = implementApprovals(ctx, id); }
      else if (current === 'IMPLEMENTING') { /* nothing */ } else if (current === 'IMPLEMENTED') {
        if (!gatesEnforced(ctx, dir)) illegal();
        if (ctx.role !== 'lead') fail('only the lead may reopen implementation after a gate finding (diagnosis comes first)');
        reopenForFix(ctx, id); detail = `fix_round=${fixRoundsUsed(ctx, dir)}`;
      } else illegal();
      break;
    case 'IMPLEMENTED':
      if (current !== 'IMPLEMENTING' && current !== 'IMPLEMENTED') illegal();
      verifyClassification(ctx, id);
      dbGuardCheck(ctx, id);
      verifyDebugResult(ctx, id);
      must(verifyWorkerEvidence(ctx, id));
      verifyMutationOwnership(ctx, dir, id, true);
      verifyFixBound(ctx, id);
      buildRecordAuto(ctx, id);
      setRunValue(ctx, id, 'handoff', 'implemented_patch_sha256', patch);
      setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', 'PENDING');
      break;
    case 'CODE_DONE':
      if (current !== 'IMPLEMENTED' && current !== 'CODE_DONE') illegal();
      if (sectionValue(ctx, dir, 'handoff', 'implemented_patch_sha256') !== patch) fail('CODE_DONE blocked: the application tree changed since IMPLEMENTED');
      verifyClassification(ctx, id);
      dbGuardCheck(ctx, id);
      verifyNoScratchWorktrees(ctx);
      if (sectionValue(ctx, dir, 'execution', 'awaiting_input') === 'true') fail(`CODE_DONE blocked: questions are pending ('agent.sh questions ${id}')`);
      if (gatesEnforced(ctx, dir)) {
        verifyMutationOwnership(ctx, dir, id);
        verifyRequiredGates(ctx, dir, id, 'reuse', 'CODE_DONE blocked');
      }
      setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', patch);
      break;
    default: // DONE
      if (current !== 'CODE_DONE' && current !== 'DONE') illegal();
      if (sectionValue(ctx, dir, 'handoff', 'code_done_patch_sha256') !== patch) fail('DONE blocked: CODE_DONE stale or missing');
      dbGuardCheck(ctx, id);
      verifyRunLanguage(ctx, id);
      must(verifyKnowledgeScope(ctx, id));
      scanKnowledgeSecrets(ctx, id);
      verifyLifecycleGates(ctx, id);
      if (sectionKeyPresent(ctx, dir, 'completion_report', 'required')) {
        const ks = sectionValue(ctx, dir, 'execution', 'knowledge_state');
        if (ks !== 'KNOWLEDGE_DONE' && ks !== 'not_applicable') fail("DONE blocked: knowledge transaction not recorded complete (see 'agent.sh knowledge-done')");
        verifyCompletionReport(ctx, id);
      }
  }
  setRunValue(ctx, id, 'handoff', 'state', phase);
  for (const a of approvals) consumeApproval(ctx, id, a);
  if (phase === 'CODE_DONE') setRunValue(ctx, id, 'execution', 'state', 'CODE_DONE');
  if (gatesEnforced(ctx, dir)) {
    led(ctx, id, `handoff:${phase}`, current, phase, detail);
    if (phase === 'IMPLEMENTED' || phase === 'CODE_DONE') tierRecord(ctx, id);
  }
  if (phase === 'DONE' && current !== 'DONE') metricsRun(ctx, id, 'done');
  if (phase === 'CODE_DONE') statusBlockUpdate(ctx, id, 'code-done');
  ctx.out(`handoff recorded: ${id} ${phase}${detail !== '' ? ` (${detail})` : ''}\n`);
  return 0;
}
