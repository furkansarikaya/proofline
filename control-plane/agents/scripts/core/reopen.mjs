// @ts-check
// Stage 4, package 4B: `amend` (reopen a CODE_DONE or DONE run) and `reopen` (a FAILED or BLOCKED run, with the user's approval). Messages, record
// formats and the order of the checks and writes are those of agent.sh 0.0.47.
import { mkdirSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { fail, ProoflineError } from './errors.mjs';
import { findApproval, kindSlug, pendingRequest, approvalExample, approvalsDirOf } from './approvals.mjs';
import { approvalTarget, mutationBudget, planTestAcs, requestApproval, runLanguage, nextNum, consumeApproval, requireLead, requireOpenRun } from './approve.mjs';
import { gateFingerprint, hashFile } from './fingerprint.mjs';
import { gatesDir, patchManifest, taskPatchFingerprint } from './gates.mjs';
import { verifySeal } from './ledger.mjs';
import { enforceTaskBranch, setRunValue } from './lifecycle.mjs';
import { fieldFromText, justificationOk, led, must, oneLine, quietly, readStdin, shellChild } from './lifeutil.mjs';
import { isFile } from './paths.mjs';
import { authorizedPath, ledgerLines, fileText, gateField, gatesEnforced, planScope, sectionKeyPresent, sectionValue } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { ledgerToken } from './questions.mjs';
import { freshness, verifyHandoff, verifyScope } from './commands/verify.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const GATE_FILE = /^[0-9]{3}-(SECRETS|REVIEW_SMALL|REVIEW_PLAN|REVIEW_RULES|REVIEW_TESTS|REVIEW_DATA|SECURITY|QA|VERIFY|REOPEN)\.yaml$/;

/** `next_gate_seq ID`: one above the largest number of any gate record file. @param {string} dir */
export function nextGateSeq(dir) {
  let n = 0;
  let names = [];
  try { names = readdirSync(gatesDir(dir)).filter((x) => GATE_FILE.test(x)); } catch { /* none */ }
  for (const f of names) { const s = Number(f.slice(0, 3)); if (s > n) n = s; }
  return n + 1;
}

/** `scope_entry_paths LIST` @param {string} list @returns {string[]} */
export function scopeEntryPaths(list) {
  return list.split(',').map((x) => x.replace(/^[ \t\n\v\f\r]*/, '').replace(/[ \t\n\v\f\r]*$/, '').replace(/:[^]*$/, '')).filter((x) => x !== '');
}

const amendHint = (/** @type {string} */ id) => `Expected: agent.sh amend ${id} with a form on stdin, one key per line: reason: <what is wrong, 20+ characters> / fix_scope: <comma-separated paths the fix may touch> / fix_instruction: <what to change, 20+ characters> / authorized_by: <who allowed reopening> / plan_change: yes|no (optional). Example: printf "reason: footer link points to the old URL\\nfix_scope: src/footer.html, src/footer.test.js\\nfix_instruction: point the footer link to /docs and update its test\\nauthorized_by: user said so in the chat\\n" | agent.sh amend ${id}`;

/** The record both reopen forms write: the gate record file, its manifest. @param {Context} ctx @param {string} id @param {string} dir */
function manifestFor(ctx, id, dir) {
  const seq = nextGateSeq(dir);
  const name = `${String(seq).padStart(3, '0')}-REOPEN`;
  const gd = gatesDir(dir);
  mkdirSync(gd, { recursive: true });
  const rows = patchManifest(ctx, dir);
  try { writeFileSync(`${gd}/${name}.manifest`, rows.map((r) => `${r}\n`).join(''), 'latin1'); } catch { fail('could not write reopen manifest'); }
  return { seq, name, gd };
}

/** `amend_run ID` @param {Context} ctx @param {string} id */
export function amendRun(ctx, id) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  if (!gatesEnforced(ctx, dir)) fail(`amend requires the lifecycle_gates policy: run ${id} has none, so it cannot be reopened; open a new task`);
  requireOpenRun(ctx, id);
  const state = sectionValue(ctx, dir, 'execution', 'state');
  if (state !== 'CODE_DONE') fail(`amend reopens a CODE_DONE/DONE run only (execution.state is '${state}'); before CODE_DONE, findings go through the gates and the fix loop`);
  enforceTaskBranch(ctx, id); verifySeal(ctx, id, dir);
  quietly(ctx, () => { must(freshness(ctx, id)); must(verifyHandoff(ctx, id, true)); });
  const text = readStdin();
  const reason = fieldFromText(text, 'reason'); const fscope0 = fieldFromText(text, 'fix_scope'); const finstr = fieldFromText(text, 'fix_instruction');
  const auth = fieldFromText(text, 'authorized_by'); const pchange = fieldFromText(text, 'plan_change');
  if (!justificationOk(reason)) fail(`amend requires a specific reason (>=20 chars). ${amendHint(id)}`);
  if (!justificationOk(finstr)) fail(`amend requires a specific fix_instruction (>=20 chars). ${amendHint(id)}`);
  if (auth.length < 3) fail(`amend requires authorized_by (who authorized reopening a completed run). ${amendHint(id)}`);
  if (fscope0 === '') fail(`amend requires fix_scope (comma-separated paths the fix may touch). ${amendHint(id)}`);
  if (pchange !== 'yes') {
    const maps = planScope(ctx, dir);
    if (!maps.ok) fail('invalid scope mapping');
    for (const p of scopeEntryPaths(fscope0)) if (!authorizedPath(maps.rows, p)) fail(`fix_scope names a path outside the frozen scope: ${p} (add 'plan_change: yes' and follow with an amendment + refreeze if the plan itself must change)`);
  }
  const fscope = scopeEntryPaths(fscope0).join(',');
  if (fscope === '') fail('fix_scope has no path (an entry must start with a repo path: path, path:line or path:symbol)');
  const patch = taskPatchFingerprint(ctx, dir);
  const { seq, name, gd } = manifestFor(ctx, id, dir);
  if (isFile(`${dir}/COMPLETION_REPORT.md`)) copyFileSync(`${dir}/COMPLETION_REPORT.md`, `${gd}/${name}.completion-report.md`);
  const prevHs = sectionValue(ctx, dir, 'handoff', 'state');
  const fz = (/** @type {string} */ k) => sectionValue(ctx, dir, 'freeze', k);
  const rec = `task_id: "${id}"\nseq: ${seq}\ngate: "REOPEN"\nresult: "reopen"\nrole: "${ctx.role}"\n`
    + `fingerprint: "${gateFingerprint(ctx)}"\npatch_sha256: "${patch}"\nmanifest_sha256: "${hashFile(`${gd}/${name}.manifest`)}"\n`
    + `task_sha256: "${fz('task_sha256')}"\nevidence_sha256: "${fz('evidence_sha256')}"\nplan_sha256: "${fz('plan_sha256')}"\nqa_plan_sha256: "${fz('qa_plan_sha256')}"\n`
    + `reason: ${oneLine(reason)}\nauthorized_by: ${oneLine(auth)}\nfix_scope: ${fscope}\nfix_instruction: ${oneLine(finstr)}\nplan_change: ${pchange === '' ? 'no' : pchange}\n`
    + `previous_execution_state: "${state}"\nprevious_handoff_state: "${prevHs}"\nprevious_knowledge_state: "${sectionValue(ctx, dir, 'execution', 'knowledge_state')}"\n`
    + `previous_implemented_patch_sha256: "${sectionValue(ctx, dir, 'handoff', 'implemented_patch_sha256')}"\nprevious_code_done_patch_sha256: "${sectionValue(ctx, dir, 'handoff', 'code_done_patch_sha256')}"\n`
    + `previous_completion_published: "${sectionValue(ctx, dir, 'completion_report', 'published')}"\nprevious_completion_receipt: "${sectionValue(ctx, dir, 'completion_report', 'receipt')}"\n`
    + `timestamp: "${now().iso}"\n`;
  try { writeFileSync(`${gd}/${name}.yaml`, rec, 'latin1'); } catch { fail('could not write reopen record'); }
  setRunValue(ctx, id, 'execution', 'state', 'AMENDING');
  if (sectionKeyPresent(ctx, dir, 'execution', 'knowledge_state')) setRunValue(ctx, id, 'execution', 'knowledge_state', 'not_started');
  if (sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) setRunValue(ctx, id, 'execution', 'knowledge_reason', '');
  setRunValue(ctx, id, 'handoff', 'state', 'IMPLEMENTING');
  setRunValue(ctx, id, 'handoff', 'implemented_patch_sha256', 'PENDING');
  setRunValue(ctx, id, 'handoff', 'code_done_patch_sha256', 'PENDING');
  if (sectionKeyPresent(ctx, dir, 'completion_report', 'published')) { setRunValue(ctx, id, 'completion_report', 'published', 'false'); setRunValue(ctx, id, 'completion_report', 'receipt', 'PENDING'); }
  led(ctx, id, 'REOPEN', prevHs, 'IMPLEMENTING', `${ledgerToken(dir, `gates/${name}.yaml`)} authorized_by=${auth}: ${reason}`);
  ctx.out(`run reopened: ${id} (${name}); handoff IMPLEMENTING, execution AMENDING — implement the bounded fix, then every required gate runs again\n`);
  return 0;
}

/** `reopen_question ID PLANHASH N STATE PREV` @param {Context} ctx @param {string} id @param {string} ph @param {string} n @param {string} st @param {string} prev */
function reopenQuestion(ctx, id, ph, n, st, prev) {
  requireLead(ctx);
  const ad = approvalsDirOf(ctx, id);
  mkdirSync(ad, { recursive: true });
  for (const k of ['mutation_budget', `reopen:${id}`]) {
    approvalTarget(ctx, id, k);
    const r = pendingRequest(ctx, id, k);
    if (r !== null && gateField(ctx, r, 'bound') === ph && gateField(ctx, r, 'joint') === `reopen:${id}`) continue;
    writeFileSync(`${ad}/${nextNum(ad)}-request-${kindSlug(k)}.yaml`, `kind: "${k}"\nbound: "${ph}"\nrequested_at: ${now().epoch}\njoint: "reopen:${id}"\n`, 'latin1');
    ctx.forget('file:');
    const dir = runDir(ctx, id);
    if (gatesEnforced(ctx, dir)) { led(ctx, id, 'approval-request', '-', '-', `${k} bound=${ph} joint=reopen:${id}`); }
  }
  const b = mutationBudget(ctx, id);
  if (runLanguage(ctx, id) === 'tr') {
    ctx.out(`YENİDEN AÇMA ÖZETİ (${id})\n  koşu: ${id}, açılışta dönülecek durum: ${prev}\n  plan: dondurulmuş (sha256 ${ph}), kapsam yeniden denetlendi\n  mutasyon bütçesi: ${b} -> ${n} (PLAN ## Tests ${n} ölçüt adlandırıyor; yalnızca bu koşuda artar)\n  kapılar: değişmemiş girdilerle geçenler kalır, geçmeyenler ve girdisi değişenler yeniden çalışır; düzeltme turu hakkı sıfırlanır\n`);
    ctx.out(`\nQUESTIONS:\n1. Bütçeyi ${n} değerine çıkarıp ${id} koşusunu yeniden açalım mı?\n`);
    ctx.out(`   seçenekler: approve | reject\n   kabul edilen yanıtlar: ${approvalExample(`reopen:${id}`)} (tek yanıt iki kararı da kaydeder: bütçe artışı ve yeniden açma; başka sözcük onay sayılmaz)\n   önerilen: yok (karar sizin)\n`);
  } else {
    ctx.out(`REOPEN SUMMARY (${id})\n  run: ${id}, state it returns to: ${prev}\n  plan: frozen (sha256 ${ph}), scope checked again\n  mutation budget: ${b} -> ${n} (PLAN ## Tests names ${n} criteria; raised for this run only)\n  gates: those that passed on unchanged inputs stay, the others run again; the fix-round allowance restarts\n`);
    ctx.out(`\nQUESTIONS:\n1. Raise the budget to ${n} and reopen the run ${id}?\n`);
    ctx.out(`   options: approve | reject\n   accepted answers: ${approvalExample(`reopen:${id}`)} (one reply records both decisions, the budget raise and the reopen; any other word approves nothing)\n   recommended: none (the user decides)\n`);
  }
}

/** `reopen_run ID` @param {Context} ctx @param {string} id */
export function reopenRun(ctx, id) {
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireLead(ctx);
  if (!gatesEnforced(ctx, dir)) fail(`reopen requires the lifecycle_gates policy: run ${id} has none; open a new task`);
  const st = sectionValue(ctx, dir, 'execution', 'state');
  if (st !== 'FAILED' && st !== 'BLOCKED') fail(`reopen takes a FAILED or BLOCKED run only (${id} is ${st}); a CODE_DONE run is reopened with 'agent.sh amend'`);
  verifySeal(ctx, id, dir);
  const reason = fieldFromText(readStdin(), 'reason');
  if (!justificationOk(reason)) fail("reopen requires a specific 'reason:' on stdin (>=20 chars: what changed since the run ended)");
  const termLine = ledgerLines(ctx, dir).filter((l) => l.includes(' event=terminate ')).pop();
  const prev = termLine === undefined ? '' : (/ from=([^ ]*) /.exec(termLine)?.[1] ?? '');
  if (prev === '') fail(`reopen: the ledger has no terminate transition for ${id}`);
  enforceTaskBranch(ctx, id);
  // 1. the plan is unchanged and the scope still holds
  const before = ctx.chunks.length;
  must(freshness(ctx, id));
  const printed = ctx.chunks.splice(before).map(([, b]) => b.toString('latin1')).join('');
  for (const l of printed.split('\n')) if (l !== '' && !l.startsWith('planning freshness verified')) ctx.out(`${l}\n`);
  let scopeOk = false;
  try { scopeOk = quietly(ctx, () => verifyScope(ctx, id, true)) === 0; } catch (e) { if (e instanceof ProoflineError) ctx.err(`${e.message}\n`); }
  if (!scopeOk) fail('reopen blocked: files changed outside the frozen scope (listed above); the user resolves them first');
  // 2. the approvals, asked as ONE question (A154)
  const ph = hashFile(`${dir}/PLAN.md`);
  const n = planTestAcs(fileText(ctx, `${dir}/PLAN.md`) ?? '');
  const kind = `reopen:${id}`;
  let budget = null; let needB = false;
  if (BigInt(n) > BigInt(mutationBudget(ctx, id))) { needB = true; budget = findApproval(ctx, id, 'mutation_budget', ph); }
  const app = findApproval(ctx, id, kind, ph);
  if (app === null || (needB && budget === null)) {
    if (app === null && needB && budget === null) {
      reopenQuestion(ctx, id, ph, String(n), st, prev);
      fail(`reopen ${id} needs the user's answer to the question above (raise the budget to ${n} and reopen): relay it, wait for the user's reply, then run reopen again (reason on stdin)`);
    }
    if (budget === null && needB) {
      const r = pendingRequest(ctx, id, 'mutation_budget');
      if (!(r !== null && gateField(ctx, r, 'bound') === ph)) requestApproval(ctx, id, 'mutation_budget');
      fail(`reopen ${id}: PLAN ## Tests names ${n} criteria above the mutation budget ${mutationBudget(ctx, id)}. Relay the budget question above, wait for the user's answer, then run reopen again`);
    }
    const r = pendingRequest(ctx, id, kind);
    if (!(r !== null && gateField(ctx, r, 'bound') === ph)) requestApproval(ctx, id, kind);
    fail(`reopen ${id} needs the user's approval: relay the question above, wait for the user's answer, then run reopen again (reason on stdin)`);
  }
  // 4. apply: the record is written like amend's, marked terminal (it restarts the fix rounds only)
  const { seq, name, gd } = manifestFor(ctx, id, dir);
  const hs = sectionValue(ctx, dir, 'handoff', 'state');
  const fz = (/** @type {string} */ k) => sectionValue(ctx, dir, 'freeze', k);
  const base = app.slice(app.lastIndexOf('/') + 1);
  const rec = `task_id: "${id}"\nseq: ${seq}\ngate: "REOPEN"\nresult: "reopen"\nrole: "${ctx.role}"\n`
    + `fingerprint: "${gateFingerprint(ctx)}"\npatch_sha256: "${taskPatchFingerprint(ctx, dir)}"\nmanifest_sha256: "${hashFile(`${gd}/${name}.manifest`)}"\n`
    + `task_sha256: "${fz('task_sha256')}"\nevidence_sha256: "${fz('evidence_sha256')}"\nplan_sha256: "${fz('plan_sha256')}"\nqa_plan_sha256: "${fz('qa_plan_sha256')}"\n`
    + `reason: ${oneLine(reason)}\nauthorized_by: user approval ${base}\nreopened_from: "${st}"\nrestored_execution_state: "${prev}"\nhandoff_state: "${hs}"\n`
    + `previous_knowledge_state: "${sectionValue(ctx, dir, 'execution', 'knowledge_state')}"\ntimestamp: "${now().iso}"\n`;
  try { writeFileSync(`${gd}/${name}.yaml`, rec, 'latin1'); } catch { fail('could not write reopen record'); }
  consumeApproval(ctx, id, app);
  setRunValue(ctx, id, 'execution', 'state', prev);
  if (sectionKeyPresent(ctx, dir, 'execution', 'knowledge_state')) setRunValue(ctx, id, 'execution', 'knowledge_state', 'not_started');
  if (sectionKeyPresent(ctx, dir, 'execution', 'knowledge_reason')) setRunValue(ctx, id, 'execution', 'knowledge_reason', '');
  led(ctx, id, 'REOPEN', hs, hs, `${ledgerToken(dir, `gates/${name}.yaml`)} reopened from ${st}, authorized_by=user approval ${base}: ${reason}`);
  if (budget !== null) {
    const r = shellChild(ctx, ['raise-budget', id, String(n)]);
    if (r.status !== 0) fail(r.err.replace(/\n+$/, '') || `raise-budget failed: ${id}`);
  }
  ctx.out(`run reopened: ${id} (${name}); execution ${st} -> ${prev}, handoff ${hs}, fix rounds restart at 0; gates that did not pass or whose inputs changed run again (agent.sh next ${id})\n`);
  return 0;
}
