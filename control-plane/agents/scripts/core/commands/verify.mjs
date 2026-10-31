// @ts-check
// Stage 2, package C2: verify-freeze, verify-scope, verify-knowledge-scope, freshness, verify-handoff, verify-qa-plan,
// verify-worker-evidence and validate. Each keeps arguments, stdout, stderr and exit status of agent.sh 0.0.41. An argument shape whose shell
// text is shell-specific (`${2:?usage}`, a word that the shell would split or expand in a way the core does not copy, an unreadable file
// whose error text is awk's) throws BridgeToShell before anything is written; the entry then runs the shell code.
import { statSync } from 'node:fs';
import * as proc from '../proc.mjs';
import { bytes } from '../config.mjs';
import { BridgeToShell, fail } from '../errors.mjs';
import { baselineFingerprint, hashFile, pathFingerprint } from '../fingerprint.mjs';
import { git, isAncestor, sortUnique, trackedPaths, untrackedPaths } from '../git.mjs';
import { verifyLifecycleGates, taskPatchFingerprint } from '../gates.mjs';
import { boundNames, listNames } from '../ledger.mjs';
import {
  baseMovedControlOnly, baseMovedLines, baseMovedOffenders, enforceTaskBranch, headOrBridge, ledgerIf, localTaskSource, setRunValue,
  taskSourceBookkeepingOnly, taskSourceContractHash, validateControlArtifacts, verifyTaskSourceStatus,
} from '../lifecycle.mjs';
import { isFile } from '../paths.mjs';
import { WS, authorizedPath, fieldOf, fileLines, fileText, gateField, gatesEnforced, planScope, scopePaths, sectionKeyPresent, sectionValue, textLines } from '../records.mjs';
import { knownControlArtifact, requireRun, runDir } from '../runs.mjs';
import { controlPlaneOnly, pipelineClass, pipelineDeclared, pipelineNeeds, pipelineReview, pipelineClassValid, planEntries, riskFreezeOk } from '../signals.mjs';
import { inKnowledgeScope } from '../scope.mjs';
import { asciiLower, expandWords, pathMatches } from '../shellglob.mjs';
import { taskType } from '../taskfile.mjs';

/** @typedef {import('../context.mjs').Context} Context */

/** The id argument of a command that needs one (`${2:?usage}`): a missing or empty one is the shell's error text. @param {string[]} args */
function needId(args) {
  const id = args[0];
  if (id === undefined || id === '') throw new BridgeToShell('usage');
  return bytes(id);
}

/** A file that must hash (`hash_file` of a missing file is a shell redirect error). @param {string} file */
function hashRequired(file) {
  if (!isFile(file)) throw new BridgeToShell('file to hash is not readable');
  return hashFile(file);
}

// ---- verify-freeze -------------------------------------------------------------------------------------------------------------

/** `pipeline_signature ID` @param {Context} ctx @param {string} dir */
function pipelineSignature(ctx, dir) {
  return pipelineDeclared(ctx, dir) && pipelineClassValid(pipelineClass(ctx, dir)) ? `${pipelineClass(ctx, dir)}:review=${pipelineReview(ctx, dir)}` : '';
}

/** `verify_freeze` without its final line: the checks. @param {Context} ctx @param {string} id */
function checkFreeze(ctx, id) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!isFile(`${dir}/RUN.yaml`)) fail('RUN.yaml missing');
  let mode = sectionValue(ctx, dir, 'execution', 'mode');
  if (mode === '' || mode === 'PENDING') mode = ctx.config().get('default_mode', 'deterministic');
  const policy = `${ctx.agents}/modes/${mode}.yaml`;
  if (!isFile(policy)) fail('mode policy missing');
  for (const [k, file, req] of /** @type {Array<[string, string, string]>} */ ([
    ['task', 'TASK.md', 'yes'], ['evidence', 'EVIDENCE.md', pipelineNeeds(ctx, dir, 'evidence')], ['plan', 'PLAN.md', 'yes'], ['qa_plan', 'QA_PLAN.md', pipelineNeeds(ctx, dir, 'qa')],
  ])) {
    const stored = sectionValue(ctx, dir, 'freeze', `${k}_sha256`);
    let actual;
    if (req === 'yes') actual = hashRequired(`${dir}/${file}`);
    else {
      actual = 'not_required';
      if (stored === '') continue;
      if (existsAny(`${dir}/${file}`)) fail(`${file} is not part of this run's pipeline; remove it`);
    }
    if (stored === '' || stored !== actual) fail(`freeze mismatch: ${k}`);
  }
  if (gatesEnforced(ctx, dir)) {
    if (sectionValue(ctx, dir, 'freeze', 'pipeline') !== pipelineSignature(ctx, dir)) fail('freeze mismatch: pipeline (the classification changed or was removed after freeze; an amendment and refreeze are required)');
  }
  if (!sectionKeyPresent(ctx, dir, 'freeze', 'risk_sha256')) fail('freeze mismatch: risk (RUN.yaml has no freeze.risk_sha256, so the risk mapping is unbound; record an amendment and refreeze to bind it)');
  if (!riskFreezeOk(ctx, sectionValue(ctx, dir, 'freeze', 'risk_sha256'))) fail('freeze mismatch: risk (the risk:, performance:, security: or contract: block of .agents/config.yaml changed after freeze; restore it, or record an amendment and refreeze)');
  const stored = sectionValue(ctx, dir, 'freeze', 'policy_sha256');
  const actual = hashRequired(policy);
  if (stored === '' || stored !== actual) fail('freeze mismatch: policy');
}

/** `[ -e PATH ]` @param {string} p */
function existsAny(p) { try { statSync(p); return true; } catch { return false; } }

/** @param {Context} ctx @param {string} id @param {boolean} [quiet] */
function verifyFreeze(ctx, id, quiet = false) {
  ctx.fpMode = 'refresh';
  checkFreeze(ctx, id);
  if (!quiet) ctx.out(`freeze verified: ${id}\n`);
  return 0;
}

// ---- the scope scans -------------------------------------------------------------------------------------------------------------

/** `fingerprint_path` whose failure is printed and ends the listing (a pipeline subshell). @param {Context} ctx @param {string} p @returns {string | null} */
function fpOrStop(ctx, p) {
  try { return pathFingerprint(ctx, p); } catch (e) {
    if (e instanceof Error && e.name === 'ProoflineError') { ctx.err(`${e.message}\n`); return null; }
    throw e;
  }
}

/** The scope mappings of the run, or the failure `invalid scope mapping`. @param {Context} ctx @param {string} dir */
function mappingsOrFail(ctx, dir) {
  const sc = planScope(ctx, dir);
  if (!sc.ok) fail('invalid scope mapping');
  return sc.rows;
}

/**
 * `verify_scope ID [ALLOW-KNOWLEDGE]`. Returns the exit status.
 * @param {Context} ctx @param {string} id @param {boolean} allowArg
 */
function verifyScope(ctx, id, allowArg) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  enforceTaskBranch(ctx, id);
  if (fileText(ctx, `${dir}/PLAN.md`) === null) throw new BridgeToShell('PLAN.md is not readable');
  const sc = planScope(ctx, dir);
  if (!sc.ok || sc.rows.length === 0) fail('invalid scope mapping: fix PLAN.md ## Scope entries: each entry needs `path` and `criteria:` (a non-empty flow list such as [AC-1]); run the plan-contract validator (skills/plan-contract/scripts/validate-plan.mjs)');
  const maps = sc.rows;
  let allow = allowArg;
  if (!allow) allow = listNames(`${dir}/gates`, /-REOPEN\.yaml$/).some((n) => isFile(`${dir}/gates/${n}`));
  if (sectionValue(ctx, dir, 'baseline', 'status') !== 'captured') fail(`baseline required before scope verification: ${id}`);
  if (!validateControlArtifacts(ctx, id)) return 1;
  const cp = [];
  const installed = [];
  const unexpected = [];
  for (const type of ['tracked', 'untracked']) {
    for (const changed of type === 'tracked' ? trackedPaths(ctx) : untrackedPaths(ctx)) {
      if (changed === '') continue;
      if (knownControlArtifact(ctx, id, changed)) continue;
      if (taskSourceBookkeepingOnly(ctx, id, changed)) continue;
      if (allow && inKnowledgeScope(ctx, changed) && !authorizedPath(maps, changed)) continue;
      const prior = baselineFingerprint(ctx, type, changed, dir);
      const current = fpOrStop(ctx, changed);
      if (current === null) break;
      if (prior !== '' && prior === current) continue;
      if (authorizedPath(maps, changed)) continue;
      if (changed.startsWith('.agents/')) { cp.push(changed); continue; }
      if (controlPlaneOnly(ctx, changed)) { installed.push(changed); continue; }
      unexpected.push(changed);
    }
  }
  if (cp.length) ctx.out(`control-plane files changed under .agents/ (not task changes, outside the plan scope):\n${cp.map((x) => `  ${x}\n`).join('')}`);
  if (installed.length) ctx.out(`installed proofline files changed (not task changes, outside the plan scope):\n${installed.map((x) => `  ${x}\n`).join('')}`);
  if (unexpected.length) {
    ctx.err(`unexpected or unmapped task-introduced paths:\n${unexpected.map((x) => `${x}\n`).join('')}`);
    if (unexpected.some((x) => x === 'AGENTS.md' || x === 'CLAUDE.md')) ctx.err('AGENTS.md/CLAUDE.md here holds text besides the proofline block (or is a symlink, or has no markers): that is project rules every agent reads, so it is a product change. Name the file in the plan scope (amendment and refreeze), or move that text out and keep only the proofline block.\n');
    return 1;
  }
  ctx.out(`scope check passed: ${id}\n`);
  return 0;
}

/** `knowledge_owned_paths ID`. @param {Context} ctx @param {string} id @returns {string[]} */
function knowledgeOwnedPaths(ctx, id) {
  const dir = runDir(ctx, id);
  const maps = mappingsOrFail(ctx, dir);
  /** @type {string[]} */ const out = [];
  for (const type of ['tracked', 'untracked']) {
    for (const changed of type === 'tracked' ? trackedPaths(ctx) : untrackedPaths(ctx)) {
      if (changed === '') continue;
      if (knownControlArtifact(ctx, id, changed)) continue;
      if (!inKnowledgeScope(ctx, changed)) continue;
      if (authorizedPath(maps, changed)) continue;
      const prior = baselineFingerprint(ctx, type, changed, dir);
      const current = fpOrStop(ctx, changed);
      if (current === null) break;
      if (prior !== '' && prior === current) continue;
      out.push(changed);
    }
  }
  return out;
}

/** @param {Context} ctx @param {string} id */
function verifyKnowledgeScope(ctx, id) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (sectionValue(ctx, dir, 'baseline', 'status') !== 'captured') fail(`baseline required before knowledge-scope verification: ${id}`);
  const owned = knowledgeOwnedPaths(ctx, id);
  const ks = sectionValue(ctx, dir, 'execution', 'knowledge_state');
  if (owned.length) {
    if (ks !== 'KNOWLEDGE_DONE') {
      ctx.err(`knowledge-scope changes present but knowledge transaction not recorded complete (knowledge_state=${ks}); run 'agent.sh knowledge-done' first, or these paths are unauthorized:\n${owned.map((x) => `${x}\n`).join('')}`);
      return 1;
    }
  } else if (ks === 'KNOWLEDGE_DONE') {
    fail(bytes("knowledge_state is KNOWLEDGE_DONE but no knowledge-scope changes were found — record 'not_applicable' with a one-sentence reason instead if no writes were needed (the script checks it)"));
  }
  ctx.out(`knowledge scope verified: ${id}\n`);
  return 0;
}

// ---- freshness -------------------------------------------------------------------------------------------------------------------

/** @param {Context} ctx @param {string} id */
function freshness(ctx, id) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  verifyFreeze(ctx, id);
  const base = sectionValue(ctx, dir, 'repository', 'base_sha');
  const head = headOrBridge(ctx);
  if (base !== head && !(ctx.ctpBase === base && isAncestor(ctx, base, 'HEAD'))) {
    if (baseMovedControlOnly(ctx, dir, base, false)) {
      const line = `base_sha moved (${base} -> ${head}): the commits between touch control-plane files only; the plan stays fresh`;
      ctx.out(`${line}\n`);
      if (!baseMovedLines(ctx, dir).some((l) => l.includes(`detail=${line}`))) ledgerIf(ctx, id, 'base-moved', '-', '-', line);
      setRunValue(ctx, id, 'repository', 'base_sha', head);
    } else if (baseMovedControlOnly(ctx, dir, base, true)) {
      const line = `base_sha is at ${base}, HEAD is ${head}: the commits between touch control-plane files, this run's task file and knowledge documents only; the plan stays fresh`;
      ctx.out(`${line}\n`);
      if (!fileLines(ctx, `${dir}/LEDGER.log`).some((l) => l.includes(`detail=${line}`))) ledgerIf(ctx, id, 'base-moved', '-', '-', line);
    } else {
      fail(`stale plan: repository.base_sha changed (${base} -> ${head}); amendment and refreeze required. Changed outside the control plane: ${baseMovedOffenders(ctx, dir, base)}. Amend and refreeze the plan to include them, or revert them; text in AGENTS.md or CLAUDE.md besides the proofline block is project rules every agent reads, so it counts as a product change (A161)`);
    }
  }
  const type = sectionValue(ctx, dir, 'task_source', 'type');
  const revision = sectionValue(ctx, dir, 'task_source', 'revision');
  if (type === 'local_markdown') {
    const source = localTaskSource(ctx, dir);
    verifyTaskSourceStatus(ctx, id);
    if (revision !== taskSourceContractHash(ctx, id, source)) fail('stale plan: the frozen task contract changed (the Status value and the published completion-report block are bookkeeping and excluded; nothing else may change); amendment and refreeze required');
  } else if (!(type === 'none' && revision === 'not_applicable')) {
    fail('task source revision unavailable or unsupported; amendment or adapter required');
  }
  ctx.out(`planning freshness verified: ${id}\n`);
  return 0;
}

// ---- verify-handoff --------------------------------------------------------------------------------------------------------------

/** @param {Context} ctx @param {string} id @param {boolean} allow */
function verifyHandoff(ctx, id, allow) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  const rc = verifyScope(ctx, id, allow);
  if (rc !== 0) return rc;
  const patch = taskPatchFingerprint(ctx, dir);
  const state = sectionValue(ctx, dir, 'handoff', 'state');
  for (const gate of ['implemented', 'code_done']) {
    const recorded = sectionValue(ctx, dir, 'handoff', `${gate}_patch_sha256`);
    if (recorded === '' || recorded === 'PENDING') continue;
    if (recorded !== patch) fail(`${gate} stale: task-owned patch changed; rerun affected gate`);
  }
  if (state === '') fail('handoff state missing');
  verifyLifecycleGates(ctx, id);
  ctx.out(`handoff integrity verified: ${id}\n`);
  return 0;
}

// ---- verify-qa-plan --------------------------------------------------------------------------------------------------------------

/** `id_keys`: upper case, leading zeros of the number dropped. @param {string} s */
function idKey(s) { return s.replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/-0+([0-9])/g, '-$1'); }
/** @param {string} s */
function upper(s) { return s.replace(/[a-z]/g, (c) => c.toUpperCase()); }
/** `sort -u` @param {string[]} a */
function sortU(a) { return sortUnique(a); }
const reAcQa = /^- QA-[0-9]+ \(AC-/;

/** The acceptance ids a QA scenario line names. @param {string} line */
function qaIds(line) {
  const l = upper(line).replace(/^- QA-[0-9]+ \(/, '').replace(/\)[^]*$/, '');
  return l.split(new RegExp(`,${WS}*`)).map(idKey);
}

/** `qa_removed_terms PLAN` @param {string[]} plan */
function qaRemovedTerms(plan) {
  /** @type {string[]} */ const out = [];
  let inC = false;
  for (const line of plan) {
    if (line.startsWith('## ')) { inC = new RegExp(`^## Contracts${WS}*$`).test(line); continue; }
    if (inC && /(remov|renam|drop|delet|no longer|deprecat)/.test(asciiLower(line))) {
      for (const m of line.matchAll(/`([A-Za-z_][A-Za-z0-9_.-]*)`/g)) out.push(m[1]);
    }
  }
  return sortU(out);
}

/** `, ` list of names as `tr | sed` makes it. @param {string[]} a */
function commaJoin(a) { return a.map((x) => `${x},`).join('').replace(/,$/, '').replace(/,/g, ', '); }

/** @param {Context} ctx @param {string} id */
function verifyQaPlanBound(ctx, id) {
  const dir = runDir(ctx, id);
  if (pipelineNeeds(ctx, dir, 'qa') !== 'yes') return;
  if (!isFile(`${dir}/QA_PLAN.md`) || !isFile(`${dir}/PLAN.md`)) return;
  const planText = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  const qaLines = fileLines(ctx, `${dir}/QA_PLAN.md`);
  const plan = textLines(planText);
  let cited = '';
  for (const l of qaLines) { const m = new RegExp(`^Plan sha256: ([0-9a-f]{64})${WS}*$`).exec(l); if (m) { cited = m[1]; break; } }
  if (cited === '') fail("QA_PLAN.md must cite the plan it is derived from: a line 'Plan sha256: <64 hex>' (the sha256 of the final PLAN.md; 'node <qa-plan skill>/scripts/validate-qa.mjs hash PLAN.md'). Write the QA plan after PLAN.md is final");
  const planHash = hashRequired(`${dir}/PLAN.md`);
  if (cited !== planHash) fail(`QA_PLAN.md was derived from a different PLAN.md (it cites ${cited.slice(0, 12)}..., PLAN.md is ${planHash.slice(0, 12)}...): re-derive the QA plan from the current plan (dispatch qa) before freeze; a plan or contract change changes the scenarios`);
  /** @type {string[]} */ const pacs0 = [];
  for (const l of plan) {
    if (new RegExp(`^${WS}*criteria:${WS}*\\[`).test(l)) for (const m of upper(l).matchAll(/AC-[0-9]+/g)) pacs0.push(m[0]);
  }
  let inB = false;
  for (const l of plan) {
    if (l.startsWith('## ')) { inB = new RegExp(`^## Behavior${WS}*$`).test(l); continue; }
    if (inB && new RegExp(`^[-*]${WS}+AC-[0-9]+:`).test(upper(l))) pacs0.push(/AC-[0-9]+/.exec(upper(l))?.[0] ?? '');
  }
  const pacs = sortU(pacs0.map(idKey));
  const qacsLines = [];
  const accLines = [];
  let skip = false;
  for (const l of qaLines) {
    if (new RegExp(`^## Adversarial scenarios${WS}*$`).test(l)) { skip = true; continue; }
    if (l.startsWith('## ')) skip = false;
    if (reAcQa.test(upper(l))) { qacsLines.push(...qaIds(l)); if (!skip) accLines.push(...qaIds(l)); }
  }
  const qacs = sortU(qacsLines);
  const acc = sortU(accLines);
  for (const a of pacs) if (!acc.includes(a)) fail(`QA_PLAN.md has no acceptance scenario for ${a}, a criterion of PLAN.md: derive the QA plan from the whole plan`);
  if (pacs.length) {
    // `for a in $qacs` splits on blanks (and expands a glob): a word with a glob character is the shell's
    for (const a of qacs.flatMap((x) => x.split(/[ \t\n]+/)).filter((x) => x !== '')) {
      if (/[*?[]/.test(a)) throw new BridgeToShell('glob character in a QA criterion');
      if (!pacs.includes(a)) fail(`QA_PLAN.md has a scenario for ${a}, which PLAN.md does not contain: the QA plan contradicts the plan`);
    }
  }
  for (const t of qaRemovedTerms(plan)) {
    let bad = '';
    for (let i = 0; i < qaLines.length; i++) {
      const lc = asciiLower(qaLines[i]);
      if (new RegExp(`^${WS}+expected:`).test(lc) && qaLines[i].includes(t) && !/(absent|removed|no longer|not |never|without|omitted|missing|undefined|gone|must not|rejected|404|ignored)/.test(lc)) { bad = `${i + 1}: ${qaLines[i]}`; break; }
    }
    if (bad !== '') fail(`QA_PLAN.md expects \`${t}\` (${bad.replace(/\n+$/, '')}), which PLAN.md ## Contracts removes or renames: state that it is absent, or follow the new contract; the QA plan must not contradict the plan`);
  }
  const missing = planEntries(ctx, planText, 'mandatory').filter((n) => {
    let blk = '';
    let inv = false;
    let ok = false;
    const flush = () => { if (inv && blk.includes(n)) ok = true; };
    for (const l of qaLines) {
      if (/^- QA-[0-9]+ \(/.test(upper(l))) { flush(); blk = l; inv = l.includes('[invalid-input]'); continue; }
      if (l.startsWith('## ') || l.startsWith('- ')) { flush(); blk = ''; inv = false; continue; }
      blk = `${blk}\n${l}`;
    }
    flush();
    return !ok;
  });
  if (missing.length) fail(`QA_PLAN.md has no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: ${commaJoin(missing)}. Add an adversarial scenario '- QA-<n> (AC-<k>) [invalid-input]: ...' that names each entry point in its title, input or expected line, with an input the server must reject (A162)`);
}

/** @param {Context} ctx @param {string[]} args */
function verifyQaPlan(ctx, args) {
  ctx.fpMode = 'refresh';
  const id = needId(args);
  requireRun(ctx, id);
  verifyQaPlanBound(ctx, id);
  ctx.out(`QA plan bound to PLAN.md: ${id}\n`);
  return 0;
}

// ---- verify-worker-evidence ------------------------------------------------------------------------------------------------------

/** `exempted_path PLAN PATH`: the reason after the first `|` of the first exemption line that contains `PATH|`. @param {string[]} plan @param {string} p */
function exemptedPath(plan, p) {
  let inside = false;
  let cur = '';
  for (const l of plan) {
    if (!inside) { if (l === 'scope:') inside = true; continue; }
    if (l === '---') break;
    if (l.startsWith('  - path: ')) { cur = l.slice('  - path: '.length); continue; }
    if (l.startsWith('    tdd_exemption: ')) {
      const row = `${cur}|${l.slice('    tdd_exemption: '.length)}`;
      if (row.includes(`${p}|`)) return row.slice(row.indexOf('|') + 1);
    }
  }
  return '';
}

/** `reject_generic_justification TEXT`: true when the reason is accepted. @param {string} text */
function justificationOk(text) {
  const norm = asciiLower(text).replace(new RegExp(`^${WS}+`), '').replace(new RegExp(`${WS}+$`), '').replace(new RegExp(`${WS}+`, 'g'), ' ');
  if (['', 'tdd not needed', 'test not needed', 'no test needed', 'not needed', 'configuration change', 'n/a', 'na'].includes(norm)) return false;
  return norm.length >= 20;
}

/** `is_doc_path PATH` (A197). @param {Context} ctx @param {string} p @param {string[]} entries */
function isDocPath(ctx, p, entries) {
  if (inKnowledgeScope(ctx, p)) return true;
  for (const e of entries) {
    if (e.endsWith('/')) { if (p.startsWith(e)) return true; } else if (e.startsWith('*.')) { if (p.endsWith(e.slice(1))) return true; } else if (p === e) return true;
  }
  return false;
}

const EXECUTABLE_DEFAULT = '*.go *.py *.pyw *.js *.mjs *.cjs *.jsx *.ts *.mts *.cts *.tsx *.java *.kt *.kts *.scala *.groovy *.rs *.c *.cc *.cpp *.cxx *.h *.hh *.hpp *.cs *.fs *.vb *.rb *.php *.swift *.m *.mm *.dart *.lua *.pl *.pm *.r *.jl *.ex *.exs *.erl *.hs *.ml *.clj *.sh *.bash *.zsh *.fish *.ps1 *.bat *.cmd *.sql *.vue *.svelte *.gradle';

/** The words of `for x in $(...)`: split on blanks, a glob expanded in the working folder. @param {Context} ctx @param {string[]} list */
function shellWords(ctx, list) { return expandWords(list.join('\n'), ctx.cwd); }

/** @param {Context} ctx @param {string} dir */
function validateTddExemptions(ctx, dir) {
  const rows = mappingsOrFail(ctx, dir);
  const plan = fileLines(ctx, `${dir}/PLAN.md`);
  const paths = shellWords(ctx, scopePaths(rows));
  const taskText = fileText(ctx, `${dir}/TASK.md`);
  if (taskText === null) throw new BridgeToShell('TASK.md is not readable');
  const ty = taskType(taskText);
  if (ty === 'content' || ty === 'docs') {
    const globs = ctx.config().get('review.executable_code', EXECUTABLE_DEFAULT);
    const docEntries = expandWords(ctx.config().get('verification.doc_paths', 'docs/ *.md *.mdx *.rst *.adoc'), ctx.cwd);
    for (const p of paths) {
      const r = exemptedPath(plan, p);
      if (pathMatches(p, globs)) {
        if (r !== '') fail(`the ${ty} task type exempts document paths only; ${p} holds code and is never exempt from test-first: remove its tdd_exemption and show RED and GREEN (or ask the user to change the task type)`);
      } else if (isDocPath(ctx, p, docEntries) && r === '') {
        fail(`the ${ty} task type exempts document paths from test-first by default, with the reason written in the plan: add 'tdd_exemption: <specific reason, 20+ characters>' to ${p} in PLAN.md scope`);
      }
    }
  }
  for (const p of paths) {
    const reason = exemptedPath(plan, p);
    if (reason === '') continue;
    if (!justificationOk(reason)) fail(`invalid TDD exemption for ${p}: reason is missing or too generic`);
  }
}

/** `valid_evidence_file ID DIR FILE ROLE`. @param {Context} ctx @param {string} id @param {string} dir @param {string} file @param {string} role */
function validEvidenceFile(ctx, id, dir, file, role) {
  const f = (/** @type {string} */ k) => fieldOf(fileLines(ctx, file), k);
  if (f('task_id') !== id) return false;
  for (const k of ['task_sha256', 'evidence_sha256', 'plan_sha256']) if (f(k) !== sectionValue(ctx, dir, 'freeze', k)) return false;
  const r = f('role');
  const canon = { full_lifecycle: 'lead', implementation_worker: 'implementer', independent_reviewer: 'reviewer', independent_qa: 'qa', independent_verifier: 'verifier' }[/** @type {'lead'} */ (r)] ?? r;
  if (canon !== role) return false;
  const session = f('codex_session_id');
  if (session !== '') {
    const given = ctx.env.CODEX_SESSION_DIR;
    const base = given !== undefined && given !== '' ? given : `${ctx.env.HOME ?? ''}/.codex/sessions`;
    if (isDirectory(base)) {
      if (session.includes('\\') || session.includes('\n')) throw new BridgeToShell('session id with a backslash');
      const r2 = procRun('grep', ['-RFl', `"${session}"`, base], ctx);
      if (r2 !== 0) return false;
    }
  }
  return true;
}

/** @param {string} p */
function isDirectory(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
/** @param {string} prog @param {string[]} args @param {Context} ctx */
function procRun(prog, args, ctx) { return proc.run(prog, args, { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'ignore', 'ignore'] }).status; }

/** `evidence_covers_path FILE PATH`: PATH is one of the comma separated targets of the first `target:` line. @param {Context} ctx @param {string} file @param {string} p */
function evidenceCovers(ctx, file, p) {
  for (const l of fileLines(ctx, file)) {
    if (l.startsWith('target:')) return l.slice('target:'.length).replace(/^ */, '').split(',').includes(p);
  }
  return false;
}

/** @param {Context} ctx @param {string} id */
function verifyWorkerEvidence(ctx, id) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!sectionKeyPresent(ctx, dir, 'worker_evidence', 'required')) { ctx.out(`worker-evidence not policy-enforced for ${id}\n`); return 0; }
  checkFreeze(ctx, id);
  validateTddExemptions(ctx, dir);
  let topology = sectionValue(ctx, dir, 'execution', 'topology');
  if (topology !== 'standalone' && topology !== 'orchestrated') {
    topology = ctx.config().get('default_topology', '');
    if (topology !== 'standalone' && topology !== 'orchestrated') fail('no valid execution topology resolved: set execution.topology in RUN.yaml or default_topology in .agents/config.yaml');
  }
  const expected = topology === 'standalone' ? 'lead' : 'implementer';
  const evdir = `${dir}/worker-evidence`;
  const rows = mappingsOrFail(ctx, dir);
  const plan = fileLines(ctx, `${dir}/PLAN.md`);
  let missing = '';
  const names = (/** @type {RegExp} */ re) => listNames(evdir, re).map((n) => `${evdir}/${n}`);
  const red = names(/^RED-.*\.yaml$/);
  const green = [...names(/^GREEN-.*\.yaml$/), ...names(/^FIX-.*\.yaml$/)];
  for (const p of shellWords(ctx, scopePaths(rows))) {
    if (exemptedPath(plan, p) !== '') continue;
    const redOk = red.some((f) => evidenceCovers(ctx, f, p) && validEvidenceFile(ctx, id, dir, f, expected));
    const greenOk = green.some((f) => evidenceCovers(ctx, f, p) && validEvidenceFile(ctx, id, dir, f, expected));
    if (!(redOk && greenOk)) missing += ` ${p}`;
  }
  if (missing !== '') fail(`worker-evidence verification failed: ${id}: missing valid RED+GREEN implementation evidence (topology=${topology}, expected role=${expected}; or TDD exemption) for:${missing}`);
  ctx.out(`worker-evidence verified: ${id} (topology=${topology})\n`);
  return 0;
}

// ---- validate --------------------------------------------------------------------------------------------------------------------

/** `verify_bindings ID`: every gate record and waiver is bound in the ledger. @param {Context} ctx @param {string} id */
function verifyBindings(ctx, id) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) return;
  let bad = '';
  for (const [sub, ere] of /** @type {Array<[string, string]>} */ ([['gates', '(gate:|REOPEN$)'], ['waivers', 'waive$']])) {
    const all = listNames(`${dir}/${sub}`, /^[0-9]{3}-.*\.yaml$/);
    if (!all.length) continue;
    const ok = boundNames(ctx, dir, sub, ere, all);
    for (const n of all) if (!ok.includes(n)) bad += ` ${sub}/${n}`;
  }
  if (bad !== '') fail(`records not bound in the ledger by the command that writes them (hand-written or edited; every gate evaluation ignores them):${bad}`);
}

/** `validate_captured_baseline DIR` @param {Context} ctx @param {string} dir */
function validateCapturedBaseline(ctx, dir) {
  const sha = sectionValue(ctx, dir, 'repository', 'base_sha');
  if (sha === '' || sha === 'PENDING' || sha.includes('<') || /[^0-9a-f]/.test(sha)) fail('invalid repository.base_sha');
  if (git(ctx, ['rev-parse', '--verify', `${sha}^{commit}`]).status !== 0) fail('repository.base_sha is not a known commit');
  const lines = fileLines(ctx, `${dir}/RUN.yaml`);
  let inside = false;
  let status = false;
  let type = '';
  let bad = false;
  const sections = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!inside) { if (l === 'baseline:') inside = true; continue; }
    if (new RegExp(`^[^ \\t\\n\\v\\f\\r]`).test(l)) break;
    if (l === '  status: captured') { status = true; continue; }
    const t = /^ {2}(tracked|untracked):$/.exec(l);
    if (t) { type = t[1]; sections.add(type); continue; }
    if (l.startsWith('    - path: ')) {
      const p = l.slice('    - path: '.length);
      const next = lines[i + 1];
      i++;
      if (p === '' || type === '' || next === undefined || !next.startsWith('      sha256: ')) bad = true;
      else {
        const value = next.slice('      sha256: '.length).replace(/"/g, '');
        if (!((value.length === 64 && /^[0-9a-f]+$/.test(value)) || (type === 'tracked' && value === 'missing'))) bad = true;
      }
    }
  }
  if (!status || !sections.has('tracked') || !sections.has('untracked') || bad) fail('invalid captured baseline entries');
}

/** @param {Context} ctx @param {string} id */
function validate(ctx, id) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  for (const f of ['TASK.md', 'PLAN.md', 'RUN.yaml']) if (!isFile(`${dir}/${f}`)) fail(`missing required artifact: ${f}`);
  verifyBindings(ctx, id);
  if (pipelineNeeds(ctx, dir, 'evidence') === 'yes' && !isFile(`${dir}/EVIDENCE.md`)) fail('missing required artifact: EVIDENCE.md');
  if (pipelineNeeds(ctx, dir, 'qa') === 'yes' && !isFile(`${dir}/QA_PLAN.md`)) fail('missing required artifact: QA_PLAN.md');
  if (sectionKeyPresent(ctx, dir, 'completion_report', 'required') && !isFile(`${dir}/COMPLETION_REPORT.md`)) fail('missing required artifact: COMPLETION_REPORT.md');
  if (!validateControlArtifacts(ctx, id)) return 1;
  if (!planScope(ctx, dir).ok) return 1;
  if (sectionValue(ctx, dir, 'baseline', 'status') !== 'captured') fail(`baseline missing or pending: ${id}`);
  validateCapturedBaseline(ctx, dir);
  freshness(ctx, id);
  let rc = verifyScope(ctx, id, true);
  if (rc !== 0) return rc;
  rc = verifyKnowledgeScope(ctx, id);
  if (rc !== 0) return rc;
  rc = verifyHandoff(ctx, id, true);
  if (rc !== 0) return rc;
  ctx.out(`run validated: ${id}\n`);
  return 0;
}

/** @type {Record<string, (ctx: Context, args: string[]) => number>} */
export const VERIFY_HANDLERS = {
  'verify-freeze': (ctx, args) => verifyFreeze(ctx, needId(args)),
  'verify-scope': (ctx, args) => verifyScope(ctx, needId(args), false),
  'verify-knowledge-scope': (ctx, args) => verifyKnowledgeScope(ctx, needId(args)),
  freshness: (ctx, args) => freshness(ctx, needId(args)),
  'verify-handoff': (ctx, args) => verifyHandoff(ctx, needId(args), false),
  'verify-qa-plan': verifyQaPlan,
  'verify-worker-evidence': (ctx, args) => verifyWorkerEvidence(ctx, needId(args)),
  validate: (ctx, args) => validate(ctx, needId(args)),
};
