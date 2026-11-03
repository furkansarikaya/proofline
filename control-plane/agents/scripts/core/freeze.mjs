// @ts-check
// Stage 4, package 4B: `freeze` and `refreeze`, with the checks only they use: the task-source copy and boundary rules (A202), the plan-contract coverage
// check (A129), the pipeline artifact contract with the split question (A171), the scope-existence rule, the mutation budget, the approvals the freeze
// consumes and the hashes it records. Messages and the order of the checks and of the writes are those of agent.sh 0.0.47: the freeze consumes
// approvals, so nothing is consumed before the last check has passed.
import { existsSync, lstatSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { fail } from './errors.mjs';
import { findApproval, latestRequest } from './approvals.mjs';
import { batchAnswerRow } from './knownissues.mjs';
import { approvalBound, consumeApproval, mutationBudget, planTestAcs, requestApproval, requireOpenRun, runLanguage } from './approve.mjs';
import { dbGuardCheck } from './dbguard.mjs';
import { hashFile } from './fingerprint.mjs';
import { fixRoundsUsed, maxFixRounds } from './gates.mjs';
import { sha256 } from './hash.mjs';
import { verifySeal } from './ledger.mjs';
import { enforceTaskBranch, localTaskSource, localTaskSourceRun, setRunValue, taskSourceContractHash, verifyTaskSourceStatus } from './lifecycle.mjs';
import { languageFailText, languageScanFiles } from './language.mjs';
import { led, quietly } from './lifeutil.mjs';
import { freezeHashPresent } from './next.mjs';
import { isFile } from './paths.mjs';
import { PathKinds, scopeKindRows } from './pathkind.mjs';
import { planMigrationShape } from './plancheck.mjs';
import * as proc from './proc.mjs';
import { askQuestion, verifyAssumptions } from './questions.mjs';
import { fileLines, fileText, gateField, gatesEnforced, planDestructive, planScope, planSectionPresent, scopePaths, sectionKeyPresent, sectionValue, textLines } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { planEntries, pipelineClass, pipelineClassValid, pipelineDeclared, pipelineNeeds, pipelineValue, riskConfigHash, runAutonomy, validationCandidates, planValidationMissing, RISK_PLAN_FLAGS } from './signals.mjs';
import { asciiLower } from './shellglob.mjs';
import { normRelPath, scopeBad, scopeEntries, scopeEntryCovers, sectionLines, taskType } from './taskfile.mjs';
import { taskDefectFixes } from './plancheck.mjs';
import { exemptedPath, checkTypeExemptions, pipelineSignature, verifyQaPlanBound } from './commands/verify.mjs';
import { pathsExecutable, requireTaskDefects } from './handoff.mjs';
import { sharedDirOf, sortedNames } from './approvals.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const WS = '[ \\t\\n\\v\\f\\r]';
const refreezeHint = (/** @type {string} */ id) => `Expected: agent.sh refreeze ${id} <AMENDMENT-FILE-NAME>, where the file exists at .agents/runs/${id}/amendments/<NNN>.md, is new (one amendment, one refreeze) and says what changed and why. Example: write amendments/001.md ("Adds AC-4 to PLAN scope: the footer link"), edit PLAN.md to match, then: agent.sh refreeze ${id} 001.md`;

/** @param {string[]} a `sort` in byte order */
const sorted = (a) => [...a].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/** `require_scope_mapping ID` (A101) @param {Context} ctx @param {string} id */
export function requireScopeMapping(ctx, id) {
  const sc = planScope(ctx, runDir(ctx, id));
  if (!(sc.ok && sc.rows.length > 0)) fail("invalid scope mapping: fix PLAN.md ## Scope entries: each entry needs `path` and `criteria:` (a non-empty flow list such as [AC-1]); run the plan-contract validator (skills/plan-contract/scripts/validate-plan.mjs)");
}

/** `require_ac_coverage ID` (A129) @param {Context} ctx @param {string} id */
export function requireAcCoverage(ctx, id) {
  const script = `${ctx.root}/.agents/skills/plan-contract/scripts/validate-plan.mjs`;
  const dir = runDir(ctx, id);
  const cls = pipelineClass(ctx, dir);
  if (!isFile(script)) { ctx.out('note: AC coverage not checked (the plan-contract skill is not installed)\n'); return; }
  if (cls === '') { ctx.out('note: AC coverage not checked (the run has no pipeline classification)\n'); return; }
  const r = proc.run(process.execPath, [script, `${dir}/PLAN.md`, `${dir}/TASK.md`, '--class', cls, '--repo', ctx.root], { cwd: ctx.cwd, env: ctx.childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  const hits = textLines(r.stdout.toString('latin1')).filter((l) => /: maps to no scope path and no explicit test$|: maps to no criterion$/.test(l));
  if (hits.length === 0) return;
  const joined = hits.map((h) => `${h};`).join('').replace(/;$/, '');
  fail(`plan defect: ${joined} -- add AC-n to \`criteria:\` of the PLAN.md scope entries (front matter) that implement it, or name an explicit test for it in \`## Tests\`; freeze again (A129)`);
}

// ---- the task's own boundaries (A202) -----------------------------------------------------------------------------------------

/** `scope_path_listed PATH ENTRIES [fold]` @param {string} p @param {string[]} entries @param {boolean} fold */
function scopePathListed(p, entries, fold) {
  const low = (/** @type {string} */ s) => (fold ? asciiLower(s) : s);
  for (const e of entries) {
    if (e === '') continue;
    const ne = low(normRelPath(e)); const np = low(normRelPath(p));
    if (ne === '') continue;
    if (scopeEntryCovers(ne, np)) return true;
  }
  return false;
}

/** The trailing blanks of each line dropped, the lines of a section joined, a trailing newline dropped (`$(... | sed 's/[[:space:]]*$//')`). @param {string[]} lines */
function normSection(lines) { return lines.map((l) => l.replace(/\r/g, '').replace(/[ \t\n\v\f\r]*$/, '')).join('\n').replace(/\n+$/, ''); }

/** `require_task_copy_matches_source ID` @param {Context} ctx @param {string} id */
export function requireTaskCopyMatchesSource(ctx, id) {
  const dir = runDir(ctx, id);
  if (!localTaskSourceRun(ctx, id)) return;
  const p = sectionValue(ctx, dir, 'task_source', 'path');
  const abs = `${ctx.root}/${p}`;
  if (p === '' || !isFile(abs) || isLink(abs)) return;
  const src = fileText(ctx, abs);
  if (src === null) return;
  if (!(`${(textLines(src)[0] ?? '').replace(/\r/g, '')}`).startsWith(`# Task: ${id} `)) return;
  const run = fileText(ctx, `${dir}/TASK.md`) ?? '';
  const a = taskType(src); const b = taskType(run);
  if (a !== b) fail(`the run's TASK.md says type ${b} but the task file ${p} says ${a}: the type is the user's, an agent cannot change it before the freeze. Restore the run copy from the task file (A202)`);
  for (const h of ['Allowed scope', 'Forbidden scope', 'Existing pattern references']) {
    const x = normSection(sectionLines(src, h)); const y = normSection(sectionLines(run, h));
    if (x !== y) {
      const xs = x.split('\n').map((l) => `- ${l}`).slice(0, 3).map((l) => `${l} `).join('');
      const ys = y.split('\n').map((l) => `+ ${l}`).slice(0, 3).map((l) => `${l} `).join('');
      fail(`the run's TASK.md differs from the task file ${p} in '## ${h}' (- task file, + run copy): ${xs}/ ${ys}. A boundary is the user's; restore the run copy from the task file (A202)`);
    }
  }
}

/** @param {string} f */
function isLink(f) { try { return lstatSync(f).isSymbolicLink(); } catch { return false; } }

/** `require_task_boundaries ID` @param {Context} ctx @param {string} id */
export function requireTaskBoundaries(ctx, id) {
  const dir = runDir(ctx, id);
  const t = fileText(ctx, `${dir}/TASK.md`);
  if (t === null) return;
  const sc = planScope(ctx, dir);
  const paths = scopePaths(sc.rows);
  for (const h of ['Forbidden scope', 'Allowed scope', 'Existing pattern references']) {
    const bad = scopeBad(t, h)[0] ?? '';
    if (bad !== '') fail(`the task section '## ${h}' has an entry that is not a path or glob: "${bad}". Write one path, folder or glob per bullet, each in backticks, e.g. - \`src/billing/\` or - \`**/*.sql\`, several per bullet allowed (a sentence is not a boundary and is never guessed at, so the freeze is refused until the user fixes the task) (A202)`);
  }
  const forb = scopeEntries(t, 'Forbidden scope');
  if (forb.length > 0) {
    for (const p of paths) if (scopePathListed(p, forb, true)) fail(`plan scope path ${p} is inside the task's Forbidden scope: the freeze is refused and nothing waives it (an agent cannot lift a boundary the user wrote). Remove the path from the plan, or the user changes the task's Forbidden scope himself (A202)`);
  }
  const allow = scopeEntries(t, 'Allowed scope');
  if (allow.length > 0) {
    let out = '';
    for (const p of paths) if (!scopePathListed(p, allow, false)) out += ` ${p}`;
    if (out !== '') {
      const ba = batchAnswerRow(ctx, id, 'scope');
      if (ba !== null && ba[0] === 'b') ctx.err(`note: plan paths outside the task's Allowed scope:${out}; freezing on the user's batch answer ${ba[2]} (A202)\n`);
      else fail(`plan scope path(s) outside the task's Allowed scope:${out}. Plan inside it, or ask the user: they widen the Allowed scope in the task, or answer the batch pre-flight question about it with the option that allows the paths (A202)`);
    }
  }
  const refs = scopeEntries(t, 'Existing pattern references');
  const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  for (const r of refs) {
    if (r === '' || /[*?[]/.test(r)) continue;
    if (!existsSync(`${ctx.root}/${r.replace(/\/$/, '')}`)) fail(`the task's Existing pattern references name ${r}, which does not exist in the repository: the user corrects the reference (A202)`);
    if (!plan.includes(r)) fail(`PLAN.md does not mention the task's Existing pattern reference ${r}: name it where the plan follows that pattern (or says why it cannot), in the architecture, scope or tests text, and freeze again (A202)`);
  }
}

// ---- the pipeline artifact contract and the split question (A171) --------------------------------------------------------------

/** `plan_risk_invalid PLAN`: the first `## Risk` line that is not a flag line or the rollback note. @param {string} text */
function planRiskInvalid(text) {
  let inside = false; let rb = false;
  for (const line of textLines(text)) {
    if (line.startsWith('## ')) { inside = new RegExp(`^## Risk${WS}*$`).test(line); rb = false; continue; }
    if (!inside || !new RegExp(`[^ \\t\\n\\v\\f\\r]`).test(line)) continue;
    const l = line.replace(/^[-*][ \t\n\v\f\r]*/, '');
    if (new RegExp(`^rollback:${WS}*[^ \\t\\n\\v\\f\\r]`).test(l)) { rb = true; continue; }
    if (rb && new RegExp(`^${WS}+[^ \\t\\n\\v\\f\\r]`).test(line)) continue;
    rb = false;
    if (!new RegExp(`^(contract_change|concurrency|performance_critical):${WS}*(yes|no)(${WS}.*)?$`).test(l)) return line;
  }
  return '';
}

/** `plan_rollback_present PLAN` @param {string} text */
function planRollbackPresent(text) {
  let inside = false;
  for (const line of textLines(text)) {
    if (line.startsWith('## ')) { inside = new RegExp(`^## Risk${WS}*$`).test(line); continue; }
    if (!inside) continue;
    if (new RegExp(`^rollback:${WS}*[^ \\t\\n\\v\\f\\r]`).test(line.replace(/^[-*][ \t\n\v\f\r]*/, ''))) return true;
  }
  return false;
}

/** `split_token ID COUNT` @param {Context} ctx @param {string} dir @param {number} n */
function splitToken(ctx, dir, n) {
  const paths = sorted(scopePaths(planScope(ctx, dir).rows));
  return `${n}@${sha256(paths.length === 0 ? '' : `${paths.join('\n')}\n`).slice(0, 12)}`;
}

/** `split_state ID TOKEN` @param {Context} ctx @param {string} dir @param {string} tok */
function splitState(ctx, dir, tok) {
  let pend = ''; let decl = '';
  const reSplit = new RegExp(`^${WS}*SPLIT: ${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${WS}*$`);
  let names = [];
  try { names = readdirSync(`${dir}/questions`).filter((n) => /^[0-9]{3}\.md$/.test(n)).sort(); } catch { /* none */ }
  for (const n of names) {
    const q = fileText(ctx, `${dir}/questions/${n}`) ?? '';
    if (!textLines(q).some((l) => reSplit.test(l))) continue;
    const af = `${dir}/questions/${n.replace(/\.md$/, '')}.answer.md`;
    if (!existsSync(af)) { pend = `questions/${n}`; continue; }
    const body = fileText(ctx, af) ?? '';
    const rows = textLines(body);
    let i = 1;
    while (i < rows.length && rows[i] !== '---') i++;
    const unq = rows.slice(i + 1).map((l) => l.replace(/^> /, '').replace(/^>$/, '')).join('\n');
    const t = asciiLower(unq.replace(/[ \t\n\v\f\r]+/g, ' ').replace(/^ /, ''));
    const rest = t.slice('proceed without splitting'.length);
    const neg = /(^|[^A-Za-z])(not|never|no|n't|if|unless|but|except|until|yet|wait|maybe|or|actually|instead)([^A-Za-z]|$)/;
    if (gateField(ctx, af, 'answered_by') === 'user' && /^proceed without splitting/.test(t) && !neg.test(` ${rest} `)) return `accepted questions/${n.replace(/\.md$/, '')}.answer.md`;
    decl = `questions/${n.replace(/\.md$/, '')}.answer.md`;
  }
  if (pend !== '') return `pending ${pend}`;
  if (decl !== '') return `declined ${decl}`;
  return 'none';
}

/** `split_check ID CLASS COUNT MAX` @param {Context} ctx @param {string} id @param {string} cls @param {number} n @param {number} max */
function splitCheck(ctx, id, cls, n, max) {
  const dir = runDir(ctx, id);
  const tok = splitToken(ctx, dir, n);
  const st = splitState(ctx, dir, tok);
  const ba = batchAnswerRow(ctx, id, 'split');
  if (ba !== null && ba[0] === 'b' && /^[0-9]+$/.test(ba[1]) && n <= Number(ba[1])) {
    ctx.err(`note: ${n} code paths exceed the ${cls} limit of ${max}; freezing without splitting on the user's batch answer ${ba[2]} (up to ${ba[1]})\n`);
    led(ctx, id, 'split_override', '-', '-', `scope_paths=${n} max=${max} class=${cls} answer=batch:${ba[2]}`);
    return;
  }
  if (st.startsWith('accepted')) {
    ctx.err(`note: ${n} scope paths exceed the ${cls} limit of ${max}; freezing without splitting on the user's answer (${st.slice('accepted '.length)})\n`);
    led(ctx, id, 'split_override', '-', '-', `scope_paths=${n} max=${max} class=${cls} answer=${st.slice('accepted '.length)}`);
    return;
  }
  if (st.startsWith('pending')) fail(`this plan has ${n} code paths (content and document paths are not counted); the ${cls} pipeline allows at most ${max}. The split question ${st.slice('pending '.length)} is unanswered (relay it: 'agent.sh questions ${id}'): the user splits the task or answers 'proceed without splitting'`);
  const parts = Math.floor((n + max - 1) / max);
  const q = runLanguage(ctx, id) === 'tr'
    ? `1. Plan ${n} kapsam yolu içeriyor; ${cls} hattı en fazla ${max} yola izin verir. Görev bölünsün mü? Önerim: her biri en fazla ${max} yol içeren en az ${parts} göreve bölmek (task-author bölme akışı).\n   SPLIT: ${tok}\n   seçenekler: "böl" (task-author görevi böler, bu koşu daralır) | "proceed without splitting" (bölmeden devam; cevabınızla kayda geçer)\n   önerilen: böl\n   neden: büyük kapsam gözden geçirmeyi ve geri almayı zorlaştırır; bölmeden devam yalnızca sizin açık cevabınızla olur\n`
    : `1. The plan has ${n} scope paths; the ${cls} pipeline allows at most ${max}. Split the task? Proposal: split it into at least ${parts} tasks of at most ${max} scope paths each (the task-author split flow).\n   SPLIT: ${tok}\n   options: "split" (task-author splits the task, this run is narrowed) | "proceed without splitting" (the phrase is part of the answer; recorded as the user's override)\n   recommended: split\n   why: a wide scope is hard to review and to roll back; continuing unsplit happens only on your explicit answer\n`;
  if (st === 'none' || st.startsWith('declined')) askQuestion(ctx, id, Buffer.from(q, 'utf8').toString('latin1'));
  fail(`this plan has ${n} code paths (content and document paths are not counted); the ${cls} pipeline allows at most ${max}. Propose the split to the user: at least ${parts} tasks of at most ${max} paths each (task-author split flow). Question recorded (relay it: 'agent.sh questions ${id}'); the user answers 'proceed without splitting' to continue unsplit, which is recorded`);
}

/** `pipeline_check ID`: required artifacts exist, unrequired ones do not, class plan rules hold. @param {Context} ctx @param {string} id */
export function pipelineCheck(ctx, id) {
  const dir = runDir(ctx, id);
  if (gatesEnforced(ctx, dir)) {
    if (!pipelineDeclared(ctx, dir)) fail('RUN.yaml has no pipeline block (create the run from .agents/templates/RUN.yaml)');
    if (!pipelineClassValid(pipelineClass(ctx, dir))) fail(`run ${id} is not classified: run 'agent.sh classify ${id} <TRIVIAL|STANDARD|COMPLEX|CRITICAL>' first`);
  }
  const cls = pipelineClass(ctx, dir);
  for (const [key, file] of [['evidence', 'EVIDENCE.md'], ['qa', 'QA_PLAN.md']]) {
    if (pipelineNeeds(ctx, dir, key) === 'yes') { if (!isFile(`${dir}/${file}`)) fail(`missing ${file} (required by the ${cls === '' ? 'default' : cls} pipeline)`); } else if (existsSync(`${dir}/${file}`)) fail(`${file} is not part of the ${cls === '' ? 'default' : cls} pipeline; remove it (no artifacts without a consumer)`);
  }
  const plan = fileText(ctx, `${dir}/PLAN.md`);
  if (pipelineNeeds(ctx, dir, 'architect') === 'yes' && !planSectionPresent(plan, 'Architecture')) fail(`the ${cls} pipeline requires an '## Architecture' section in PLAN.md (the Architect's contribution)`);
  if (planDestructive(plan) === 'invalid') fail("PLAN.md '## Data' must start with 'destructive: yes' or 'destructive: no'");
  const bad = planRiskInvalid(plan ?? '');
  if (bad !== '') fail(`PLAN.md '## Risk' holds only flag lines '<flag>: yes|no' (flags: ${RISK_PLAN_FLAGS}); not one: ${bad}`);
  let maxText = pipelineValue(ctx, cls, 'max_scope_paths');
  if (maxText === '' && cls !== '') maxText = '15';
  if (maxText !== '') {
    const pk = new PathKinds(ctx);
    const n = scopePaths(planScope(ctx, dir).rows).filter((p) => pk.pathKind(p) === 'code').length;
    const max = Number(maxText);
    if (n > max) {
      if (cls === 'TRIVIAL') fail(`the ${cls} pipeline allows at most ${maxText} code paths (content and document paths are not counted); this plan has ${n} — reclassify`);
      splitCheck(ctx, id, cls, n, max);
    }
  }
  if (cls === 'TRIVIAL') {
    const code = pathsExecutable(ctx, planScope(ctx, dir).ok ? scopePaths(planScope(ctx, dir).rows) : []);
    if (code.length > 0) fail(`the TRIVIAL pipeline covers text and configuration only; scope has executable code:${code.map((c) => ` ${c}`).join('')} — classify STANDARD ('agent.sh classify ${id} STANDARD', write the evidence and QA plan it requires, then amend and 'agent.sh refreeze ${id} <AMENDMENT>' on a frozen run)`);
  }
}

// ---- scope existence, mutation budget, assumptions ----------------------------------------------------------------------------

/** `scope_new_paths PLAN`: the paths marked `new: true`. @param {string} text */
function scopeNewPaths(text) {
  let inside = false; let p = '';
  /** @type {string[]} */ const out = [];
  for (const l of textLines(text)) {
    if (!inside) { if (l === 'scope:') inside = true; continue; }
    if (l === '---') break;
    if (l.startsWith('  - path: ')) { p = l.slice('  - path: '.length); continue; }
    if (new RegExp(`^    new:${WS}*true${WS}*$`).test(l)) out.push(p);
  }
  return out;
}

/** `verify_scope_existence ID MODE` @param {Context} ctx @param {string} id @param {string} mode */
export function verifyScopeExistence(ctx, id, mode) {
  const dir = runDir(ctx, id);
  const old = mode === 'refreeze' ? sectionValue(ctx, dir, 'freeze', 'scope_paths').split(',') : [];
  const fresh = scopeNewPaths(fileText(ctx, `${dir}/PLAN.md`) ?? '');
  for (const p of scopePaths(planScope(ctx, dir).rows)) {
    if (old.length > 0 && old.includes(p)) continue;
    if (fresh.includes(p)) { if (existsSync(`${ctx.root}/${p}`)) fail(`scope path ${p} is marked 'new: true' but already exists`); } else if (!existsSync(`${ctx.root}/${p}`)) fail(`scope path ${p} does not exist; mark it 'new: true' when the task creates it`);
  }
}

/** `require_mutation_budget ID` @param {Context} ctx @param {string} id */
function requireMutationBudget(ctx, id) {
  const dir = runDir(ctx, id);
  const n = planTestAcs(fileText(ctx, `${dir}/PLAN.md`) ?? '');
  const b = mutationBudget(ctx, id);
  if (!(BigInt(n) > BigInt(b))) return;
  const r = latestRequest(ctx, id, 'mutation_budget');
  if (!(r !== null && gateField(ctx, r, 'bound') === approvalBound(ctx, id, 'mutation_budget'))) requestApproval(ctx, id, 'mutation_budget');
  fail(`PLAN ## Tests names ${n} criteria but the mutation budget is ${b} (one claim mutant per criterion is the minimum): relay the approval request above once; after the user's approval run 'agent.sh raise-budget ${id} ${n}' and freeze again (or cut criteria from the plan)`);
}

/** `verify_plan_validation ID` (A162) @param {Context} ctx @param {string} id */
function verifyPlanValidation(ctx, id) {
  const f = `${runDir(ctx, id)}/PLAN.md`;
  if (!isFile(f)) return;
  const m = planValidationMissing(ctx, fileText(ctx, f)).join(', ');
  if (m !== '') fail(`PLAN.md ## Contracts declares an entry point that takes external input, but ## Validation has no complete line for: ${m}. Write one line per entry point: '- <entry point>: accepts <what>; limits <limits>; rejected at <where, server side>' (A162)`);
}

// ---- the approvals a freeze consumes -----------------------------------------------------------------------------------------

/** `intent_scope_answers ID D-n` @param {Context} ctx @param {string} dir @param {string} a */
function intentScopeAnswers(ctx, dir, a) {
  let out = '';
  let names = [];
  try { names = readdirSync(`${dir}/questions`).filter((n) => /^[0-9]{3}\.md$/.test(n)).sort(); } catch { /* none */ }
  const re = new RegExp(`^${WS}*USER_ONLY: scope ${a}${WS}*$`);
  for (const n of names) {
    const q = fileText(ctx, `${dir}/questions/${n}`) ?? '';
    if (!textLines(q).some((l) => re.test(l))) continue;
    const af = `${dir}/questions/${n.replace(/\.md$/, '')}.answer.md`;
    if (!isFile(af)) continue;
    if (gateField(ctx, af, 'answered_by') !== 'user') continue;
    const rows = textLines(fileText(ctx, af) ?? '');
    let i = 1;
    while (i < rows.length && rows[i] !== '---') i++;
    out += `${rows.slice(i + 1).map((l) => l.replace(/^> /, '').replace(/^>$/, '')).join('\n')}\n`;
  }
  return out;
}

/** `verify_intent_provenance ID`: the scope decisions of INTENT.md whose user answer is in no captured prompt. @param {Context} ctx @param {string} id @returns {string[]} */
function verifyIntentProvenance(ctx, id) {
  const dir = runDir(ctx, id);
  let f = `${dir}/design/INTENT.md`;
  if (!isFile(f)) f = `${ctx.root}/${ctx.config().get('tasks.dir', '.agents/tasks')}/${id}/design/INTENT.md`;
  const hist = `${sharedDirOf(ctx, 'prompts')}/history`;
  if (!isFile(f)) return [];
  let all = '';
  for (const n of sortedNames(hist, /^/)) all += fileText(ctx, `${hist}/${n}`) ?? '';
  all = all.replace(/[ \t\n]+/g, ' ');
  const trim = (/** @type {string} */ s) => s.replace(/^[ \t]+|[ \t]+$/g, '');
  /** @type {Array<[string, string]>} */ const scope = [];
  /** @type {Array<[string, string]>} */ const rounds = [];
  let sec = '';
  for (const line of textLines(fileText(ctx, f) ?? '')) {
    if (line.startsWith('## ')) { sec = line.startsWith('## Decision tree') ? 'tree' : line.startsWith('## Rounds') ? 'rounds' : ''; continue; }
    const fl = line.split('|');
    if (sec === 'tree' && fl.length >= 8) { const dc = trim(fl[6]); if (trim(fl[2]) === 'scope') scope.push([trim(fl[1]), dc]); }
    if (sec === 'rounds' && fl.length >= 5) { const a = trim(fl[2]); const t = trim(fl[3]); if (trim(fl[4]) === 'user' && /^D-[0-9]+$/.test(a)) rounds.push([a, t]); }
  }
  /** @type {string[]} */ const bad = [];
  for (const [a, t] of rounds) {
    const row = scope.find(([i]) => i === a);
    if (!row) continue;
    const dc = `d:${row[1]}`;
    if (/recommend/i.test(t) && !/report|out of scope|unchanged/i.test(dc)) { bad.push(a); continue; }
    if (!existsSyncDir(hist)) continue;
    const n = t.replace(/[ \t\n]+/g, ' ');
    const u = asciiLower(intentScopeAnswers(ctx, dir, a).replace(/[ \t\n]+/g, ' '));
    const l = asciiLower(n);
    if (u.includes(l)) continue;
    if (!all.includes(n)) bad.push(a);
  }
  return bad;
}

/** @param {string} d */
function existsSyncDir(d) { try { return readdirSync(d) !== null; } catch { return false; } }

/** `freeze_approvals ID MODE`: the approval files to consume, after every condition has held. @param {Context} ctx @param {string} id @param {string} mode */
function freezeApprovals(ctx, id, mode) {
  const dir = runDir(ctx, id);
  const plan = hashFile(`${dir}/PLAN.md`);
  requireTaskDefects(ctx, id);
  /** @type {string[]} */ const out = [];
  if (runAutonomy(ctx, dir) === 'supervised') {
    const a = findApproval(ctx, id, 'plan', plan);
    if (a === null) fail(`supervised freeze requires a plan approval for this PLAN.md: run 'agent.sh request-approval ${id} plan', relay it, then 'agent.sh approve ${id} plan'`);
    out.push(a);
  }
  if (planDestructive(fileText(ctx, `${dir}/PLAN.md`)) === 'yes') {
    const shape = planMigrationShape(ctx, dir);
    if (shape !== 'expand_contract' && shape !== 'single_step') fail("PLAN.md '## Data' is destructive without expand/contract steps: the step table needs a non-destructive step in phase expand, backfill or switch, and every destructive step in phase contract or deferred (a separate, later migration file after the stop-reading step). Only the user's explicit single-step approval allows one step: add 'single_step: yes' (the approval is requested after the freeze, before IMPLEMENT)");
  }
  if (taskDefectFixes(fileText(ctx, `${dir}/TASK.md`) ?? '').length > 0) {
    const a = findApproval(ctx, id, 'scope', plan);
    if (a === null) fail(`TASK.md lists a pre-existing defect with 'decision: fix': changing behaviour nobody asked for needs the user's scope approval for this PLAN.md ('agent.sh request-approval ${id} scope'), or list it as 'decision: report' and leave it unchanged`);
    out.push(a);
  }
  const bad = verifyIntentProvenance(ctx, id).map((x) => `${x} `).join('');
  if (bad !== '') fail(`INTENT.md records the user's answer to scope decision(s) ${bad}, but those words are in no captured user prompt, or are a blanket 'use your recommended option' for a decision other than report: an answer recorded as the user's must be what the user said, and a blanket answer never decides a fix (A105: record the decision as report, or ask for the user's scope approval)`);
  if (mode === 'refreeze' && fixRoundsUsed(ctx, dir) > maxFixRounds(ctx)) {
    const a = findApproval(ctx, id, 'budget', plan);
    if (a === null) fail(`the fix rounds are exhausted: only 'agent.sh terminate ${id} FAILED', or a refreeze with the user's budget approval for this PLAN.md ('agent.sh request-approval ${id} budget')`);
    out.push(a);
  }
  if (mode === 'refreeze' && sectionKeyPresent(ctx, dir, 'freeze', 'scope_paths')) {
    const old = sectionValue(ctx, dir, 'freeze', 'scope_paths').split(',');
    let added = '';
    for (const p of scopePaths(planScope(ctx, dir).rows)) if (!old.includes(p)) added += ` ${p}`;
    if (added !== '') {
      const a = findApproval(ctx, id, 'scope', plan);
      if (a === null) fail(`the amendment adds scope paths (${added} ): a scope approval for this PLAN.md is required ('agent.sh request-approval ${id} scope')`);
      out.push(a);
    }
  }
  return out;
}

// ---- the hashes ---------------------------------------------------------------------------------------------------------------

/** `replace_hashes DIR TARGET`: the RUN.yaml text with the freeze section's hashes replaced. @param {Context} ctx @param {string} id */
function replaceHashes(ctx, id) {
  const dir = runDir(ctx, id);
  let mode = sectionValue(ctx, dir, 'execution', 'mode');
  if (mode === '' || mode === 'PENDING') mode = ctx.config().get('default_mode', 'deterministic');
  const a = hashFile(`${dir}/TASK.md`); const c = hashFile(`${dir}/PLAN.md`); const d = hashFile(`${ctx.agents}/modes/${mode}.yaml`);
  const b = pipelineNeeds(ctx, dir, 'evidence') === 'yes' ? hashFile(`${dir}/EVIDENCE.md`) : 'not_required';
  const e = pipelineNeeds(ctx, dir, 'qa') === 'yes' ? hashFile(`${dir}/QA_PLAN.md`) : 'not_required';
  const f = pipelineSignature(ctx, dir);
  const s = scopePaths(planScope(ctx, dir).rows).join(',');
  const r = riskConfigHash(ctx);
  const text = fileText(ctx, `${dir}/RUN.yaml`) ?? '';
  let i = false; let rk = false;
  /** @type {string[]} */ const out = [];
  for (const l of textLines(text)) {
    if (l === 'freeze:') { i = true; out.push(l); continue; }
    if (i && /^[^ \t\n\v\f\r#]/.test(l)) { if (!rk) out.push(`  risk_sha256: "${r}"`); rk = true; i = false; }
    if (i && l.startsWith('  task_sha256:')) { out.push(`  task_sha256: "${a}"`); continue; }
    if (i && l.startsWith('  evidence_sha256:')) { out.push(`  evidence_sha256: "${b}"`); continue; }
    if (i && l.startsWith('  plan_sha256:')) { out.push(`  plan_sha256: "${c}"`); continue; }
    if (i && l.startsWith('  qa_plan_sha256:')) { out.push(`  qa_plan_sha256: "${e}"`); continue; }
    if (i && l.startsWith('  policy_sha256:')) { out.push(`  policy_sha256: "${d}"`); continue; }
    if (i && l.startsWith('  pipeline:') && f !== '') { out.push(`  pipeline: "${f}"`); continue; }
    if (i && l.startsWith('  scope_paths:')) { out.push(`  scope_paths: "${s}"`); continue; }
    if (i && l.startsWith('  risk_sha256:')) { out.push(`  risk_sha256: "${r}"`); rk = true; continue; }
    out.push(l);
  }
  if (i && !rk) out.push(`  risk_sha256: "${r}"`);
  return out;
}

/** The freeze block (`sed -n '/^freeze:$/,/^[^ ]/p'`) without the scope_paths line. @param {string[]} lines */
function freezeBlock(lines) {
  const s = lines.indexOf('freeze:');
  if (s < 0) return '';
  /** @type {string[]} */ const out = [lines[s]];
  for (let k = s + 1; k < lines.length; k++) { out.push(lines[k]); if (/^[^ ]/.test(lines[k])) break; }
  return out.filter((l) => !l.includes('scope_paths')).join('\n');
}

/** `set_task_source_revision DIR` @param {Context} ctx @param {string} id */
function setTaskSourceRevision(ctx, id) {
  const dir = runDir(ctx, id);
  const type = sectionValue(ctx, dir, 'task_source', 'type');
  if (type === 'local_markdown') {
    const source = localTaskSource(ctx, dir);
    setRunValue(ctx, id, 'task_source', 'revision', taskSourceContractHash(ctx, id, source));
  } else if (type === 'none') {
    if (sectionValue(ctx, dir, 'task_source', 'revision') !== 'not_applicable') fail('task source none requires revision: not_applicable');
  } else fail(`task source adapter unavailable: ${type === '' ? 'missing' : type}`);
}

/** `refreeze_lifecycle ID AMENDMENT OLDPLAN` (K-6) @param {Context} ctx @param {string} id @param {string} amend @param {string} oldPlan */
function refreezeLifecycle(ctx, id, amend, oldPlan) {
  const dir = runDir(ctx, id);
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  let to = hs;
  if (hs === 'IMPLEMENTED') {
    setRunValue(ctx, id, 'handoff', 'state', 'IMPLEMENTING');
    setRunValue(ctx, id, 'handoff', 'implemented_patch_sha256', 'PENDING');
    setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', 'PENDING');
    to = 'IMPLEMENTING';
  }
  if (to === 'IMPLEMENTING') {
    if (planDestructive(fileText(ctx, `${dir}/PLAN.md`)) === 'yes' && oldPlan !== sectionValue(ctx, dir, 'freeze', 'plan_sha256')) {
      setRunValue(ctx, id, 'handoff', 'state', 'PLANNED');
      setRunValue(ctx, id, 'handoff', 'implemented_patch_sha256', 'PENDING');
      setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', 'PENDING');
      to = 'PLANNED';
    }
  }
  led(ctx, id, 'refreeze', hs, to, `amendment ${amend}`);
}

// ---- the command --------------------------------------------------------------------------------------------------------------

/**
 * `freeze ID [refreeze AMENDMENT]`.
 * @param {Context} ctx @param {string} id @param {string} word `refreeze` for the refreeze command, else '' @param {string} amendment
 */
export function freezeRun(ctx, id, word, amendment) {
  ctx.fpMode = 'refresh';
  requireRun(ctx, id);
  dbGuardCheck(ctx, id);
  const dir = runDir(ctx, id);
  for (const f of ['TASK.md', 'PLAN.md', 'RUN.yaml']) if (!isFile(`${dir}/${f}`)) fail(`missing ${f}`);
  requireOpenRun(ctx, id);
  if (sectionValue(ctx, dir, 'execution', 'state') === 'CODE_DONE') fail(`cannot freeze completed run: ${id}`);
  if (sectionValue(ctx, dir, 'baseline', 'status') !== 'captured') fail(`baseline required before freeze: ${id}`);
  enforceTaskBranch(ctx, id);
  verifySeal(ctx, id, dir);
  verifyTaskSourceStatus(ctx, id);
  requireScopeMapping(ctx, id);
  const taskText = fileText(ctx, `${dir}/TASK.md`) ?? '';
  if (taskType(taskText) === 'invalid') fail(`the task type in ${dir}/TASK.md cannot be read (front matter \`type:\` must be one of feature, bug, refactor, content, docs, chore, optionally followed by a # comment); an unreadable type gets no exemption and no lighter path, so the user corrects it (A202)`);
  if (!freezeHashPresent(ctx, dir)) requireTaskCopyMatchesSource(ctx, id);
  requireTaskBoundaries(ctx, id);
  requireAcCoverage(ctx, id);
  const plan = fileText(ctx, `${dir}/PLAN.md`) ?? '';
  // A112: QA's visual focus runs for every non-TRIVIAL plan with a UI part; its same-origin-write allowance is declared in the plan, now
  if (gatesEnforced(ctx, dir) && planSectionPresent(plan, 'UI') && pipelineClass(ctx, dir) !== 'TRIVIAL'
    && !textLines(plan).some((l) => /^[ \t\n\v\f\r]*([-*][ \t\n\v\f\r]*)?`?visual_writes:[ \t][^ \t\n\v\f\r]/.test(l))) {
    fail("PLAN.md has a ## UI section and QA's visual focus will run, but no 'visual_writes: <how the data the page writes is thrown away>' line: add it under ## UI (write 'visual_writes: none, <why>' if the page sends no same-origin writes) and freeze again; without it QA ends INCONCLUSIVE and needs a plan amendment (A112)");
  }
  // A destructive data change makes the task CRITICAL (D9/D14), whatever was classified.
  if (gatesEnforced(ctx, dir) && planDestructive(plan) === 'yes' && pipelineClass(ctx, dir) !== 'CRITICAL') {
    const prev = pipelineClass(ctx, dir);
    setRunValue(ctx, id, 'pipeline', 'classification', 'CRITICAL'); setRunValue(ctx, id, 'pipeline', 'review', pipelineValue(ctx, 'CRITICAL', 'review'));
    const hs = sectionValue(ctx, dir, 'handoff', 'state');
    led(ctx, id, 'classify', hs, hs, `CRITICAL (forced: destructive data change; was ${prev})`);
    ctx.out('classification forced to CRITICAL: PLAN.md declares a destructive data change\n');
  }
  pipelineCheck(ctx, id);
  let mode = 'freeze';
  if (freezeHashPresent(ctx, dir)) {
    if (!(word === 'refreeze' && amendment !== '')) fail(`existing freeze requires an explicit amendment. ${refreezeHint(id)}`);
    if (amendment.includes('/') || amendment.includes('..')) fail(`invalid amendment name: ${amendment} (a file name inside the run's amendments/ folder, no directory part). ${refreezeHint(id)}`);
    if (!isFile(`${dir}/amendments/${amendment}`) && !existsSync(`${dir}/amendments/${amendment}`)) fail(`amendment ${amendment} not found at ${dir}/amendments/${amendment}. ${refreezeHint(id)}`);
    if (fileLines(ctx, `${dir}/LEDGER.log`).some((l) => l.includes('event=refreeze ') && l.includes(`detail=amendment ${amendment}`))) fail(`amendment ${amendment} was already used for a refreeze; write a new amendment`);
    mode = 'refreeze';
  }
  verifyScopeExistence(ctx, id, mode);
  // A79: the mandatory `## Assumptions` registers are well-formed and no unverified high-risk assumption stands without the user's `accept` answer
  quietly(ctx, () => verifyAssumptions(ctx, id, true));
  if (gatesEnforced(ctx, dir)) requireMutationBudget(ctx, id);
  if (gatesEnforced(ctx, dir)) { verifyPlanValidation(ctx, id); verifyQaPlanBound(ctx, id); }
  checkTypeExemptions(ctx, dir);
  // A197: a document path in scope without a tdd_exemption has no RED/GREEN to show; freeze does not stop: one line, with the fix.
  const pk = new PathKinds(ctx);
  let nd = '';
  const planLines = textLines(plan);
  for (const p of scopePaths(planScope(ctx, dir).rows)) {
    if (!pk.isDocPath(p)) continue;
    if (exemptedPath(planLines, p) !== '') continue;
    nd += ` ${p}`;
  }
  if (nd !== '') {
    ctx.err(`warning: PLAN.md scope has document path(s) without tdd_exemption:${nd}; the implementer cannot show RED/GREEN for a document, so add 'tdd_exemption: <specific reason, 20+ characters>' to each (or a test that proves it, for example design-sync finding the drift first and then passing clean); a plan fixed later costs an amendment and a refreeze (A197)\n`);
    const ba = batchAnswerRow(ctx, id, 'exempt');
    if (ba !== null) ctx.err(`note: the user answered the batch pre-flight question ${ba[2]} for ${id} with option ${ba[0]} (a: document paths take a tdd_exemption with a specific reason; b: each needs a test); the plan follows it (A200)\n`);
  }
  const cls = pipelineClass(ctx, dir);
  if ((cls === 'COMPLEX' || cls === 'CRITICAL') && !planRollbackPresent(plan)) ctx.err(`warning: PLAN.md '## Risk' has no rollback note; a ${cls} plan carries 'rollback: <feature flag, how a migration is reversed, the first step if production breaks>' there, a few lines at most (A202)\n`);
  // A202: a `kind:` the script does not agree with is told, and the path is treated as code
  let kd = '';
  for (const row of scopeKindRows(pk, plan).split('\n').filter((x) => x !== '')) {
    const [p, claimed, derived] = row.split('\t');
    if (claimed !== '-' && claimed !== derived && !(claimed === 'doc' && derived === 'content')) kd += ` ${p} (claimed ${claimed}, derived ${derived})`;
  }
  if (kd !== '') ctx.err(`warning: PLAN.md scope kind differs from the script's own:${kd}; the path is treated as code in the scope bound and in the gate re-run (a plan's kind is a claim; correct it or drop it)\n`);
  const info = planEntries(ctx, plan, 'information').map((x) => `${x.slice(0, 60)};`).join('');
  if (info !== '') ctx.err(`note (information only): PLAN.md ## Contracts mentions an entry point without new input (${info.replace(/;$/, '')}); if one takes new or changed external input, state it in the bullet and add a ## Validation line (A162)\n`);
  if (planEntries(ctx, plan, 'mandatory').length === 0) {
    const cands = sorted([...new Set(validationCandidates(ctx, dir).map((x) => x.slice(x.indexOf('|') + 1).split('|')[0]))]).map((x) => `${x} `).join('');
    if (cands !== '') ctx.err(`note (information only): ${cands.replace(/ $/, '')} look like entry-point code, but PLAN.md ## Contracts declares none; if one takes external input, declare it there with a ## Validation line (A162)\n`);
  }
  const langFiles = ['TASK.md', 'PLAN.md', 'EVIDENCE.md', 'QA_PLAN.md'].filter((f) => isFile(`${dir}/${f}`)).map((f) => `${dir}/${f}`);
  const hits = languageScanFiles(ctx, langFiles);
  if (hits.length > 0) fail(languageFailText(hits.join(' ')));
  let approvals = /** @type {string[]} */ ([]);
  if (gatesEnforced(ctx, dir)) approvals = freezeApprovals(ctx, id, mode);
  const oldPlan = sectionValue(ctx, dir, 'freeze', 'plan_sha256');
  const next = replaceHashes(ctx, id);
  if (mode === 'refreeze' && gatesEnforced(ctx, dir)) {
    if (freezeBlock(textLines(fileText(ctx, `${dir}/RUN.yaml`) ?? '')) === freezeBlock(next)) fail('refreeze changes nothing: an amendment must change the task, evidence, plan, QA plan or classification');
  }
  writeFileSync(`${dir}/RUN.yaml.tmp`, Buffer.from(next.map((l) => `${l}\n`).join(''), 'latin1'));
  renameSync(`${dir}/RUN.yaml.tmp`, `${dir}/RUN.yaml`);
  ctx.forget('file:'); ctx.forget('plan-scope:');
  setTaskSourceRevision(ctx, id);
  if (gatesEnforced(ctx, dir)) {
    if (mode === 'refreeze') refreezeLifecycle(ctx, id, amendment, oldPlan);
    else { const hs = sectionValue(ctx, dir, 'handoff', 'state'); led(ctx, id, 'freeze', hs, hs, sectionValue(ctx, dir, 'freeze', 'pipeline')); }
    for (const a of approvals) consumeApproval(ctx, id, a);
  }
  ctx.out(`freeze recorded: ${id}\n`);
  if (mode === 'refreeze' && gatesEnforced(ctx, dir) && planDestructive(fileText(ctx, `${dir}/PLAN.md`)) === 'yes') {
    if (sectionValue(ctx, dir, 'handoff', 'state') === 'PLANNED' && oldPlan !== sectionValue(ctx, dir, 'freeze', 'plan_sha256')) {
      ctx.out(`refreeze: PLAN.md has a new hash; an earlier destructive / single_step approval was bound to the old one and no longer counts. The run is back at PLANNED: the implementer cannot work, and IMPLEMENTED/CODE_DONE are unreachable, until a destructive approval for this PLAN.md exists ('agent.sh request-approval ${id} destructive', then 'agent.sh handoff ${id} IMPLEMENTING')\n`);
    }
  }
  return 0;
}
