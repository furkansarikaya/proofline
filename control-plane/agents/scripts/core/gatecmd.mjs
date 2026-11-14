// @ts-check
// Stage 4, package 4C: `secret-scan`, `worker-evidence`, `raise-budget` and `waive` (agent.sh 0.0.47 `secret_scan`, `record_worker_evidence`,
// `raise_budget`, `waive`). Messages, the order of the checks and the bytes of the records are those of the shell.
import { lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { now } from './clock.mjs';
import { fail } from './errors.mjs';
import { findApproval } from './approvals.mjs';
import { consumeApproval, mutationBudget, nextNum, planTestAcs, requireLead, waiveCanon, waiveGroupIds, waiveTarget, requireOpenRun } from './approve.mjs';
import { gateFingerprint, hashFile } from './fingerprint.mjs';
import { findingWaiverKey, gateFocus, gateOwner, resolveTopology } from './gates.mjs';
import { taskChangedPaths } from './signals.mjs';
import { gateDefaultArtifact, gatePreconditions, validGateName, writeGate } from './gatewrite.mjs';
import { artifactAllowed, artifactPaths } from './resultutil.mjs';
import { scopeEntryPaths } from './reopen.mjs';
import { verifySeal } from './ledger.mjs';
import { enforceTaskBranch, ledgerIf } from './lifecycle.mjs';
import { fieldFromText, justificationOk, led, need, oneLine, readStdin } from './lifeutil.mjs';
import { isFile } from './paths.mjs';
import { adapterExists, runTaskAdapter } from './adapters/index.mjs';
import * as proc from './proc.mjs';
import { ledgerToken } from './questions.mjs';
import { fieldOf, fileLines, fileText, gateField, gatesEnforced, planScope, scopePaths, authorizedPath, sectionValue } from './records.mjs';
import { requireRun, runDir } from './runs.mjs';
import { expandWords } from './shellglob.mjs';
import { runSecretScan } from './secretscan.mjs';
import { exemptedPath, verifyFreeze } from './commands/verify.mjs';
import { headSha } from './git.mjs';
import { measureRequired } from './testmeasure.mjs';
import { notRunRelative } from './pathin.mjs';

/** @typedef {import('./context.mjs').Context} Context */

// ---- secret-scan ---------------------------------------------------------------------------------------------------------------------

/** `secret-scan ID`: SECRETS is a script gate, never a role and never waivable. @param {Context} ctx @param {string[]} args */
export function secretScanCommand(ctx, args) {
  const id = need(args, 0);
  requireRun(ctx, id);
  requireLead(ctx);
  gatePreconditions(ctx, id, 'SECRETS');
  const dir = runDir(ctx, id);
  const paths = taskChangedPaths(ctx, dir).filter((p) => isFile(`${ctx.root}/${p}`));
  let rc = 0;
  let out = '';
  let err = '';
  if (paths.length > 0) {
    const r = runSecretScan(ctx, paths);
    rc = r.status; out = r.stdout.toString('latin1'); err = r.stderr.toString('latin1');
  }
  /** @type {string[]} */ let rows = [];
  let result = 'pass';
  if (rc === 0) { rows = []; }
  else if (rc === 1) {
    let n = 0;
    for (const line of out.split('\n')) {
      const f = line.split(':');
      if (f.length < 3 || line === '') continue;
      n++;
      rows.push(`SECRETS-${n}|blocking|${f[0]}:${f[1]}|secret pattern ${f[2]}|secret-scan.sh`);
    }
    result = 'fail';
    if (rows.length === 0) rows = ['SECRETS-1|blocking|-|secret scanner reported findings without locations|secret-scan.sh'];
  } else {
    fail(`secret scan error (exit ${rc}): ${err.split('\n').slice(0, 3).join(' ')} — nothing recorded (BLOCKED)`);
  }
  writeGate(ctx, { id, gate: 'SECRETS', result, role: 'secret-scan', confidence: 'high', focus: '', artifact: '', findings: rows, resultFile: '', fingerprint: gateFingerprint(ctx) });
  if (result !== 'pass') for (const r of rows) ctx.out(`  ${r}\n`);
  return 0;
}

// ---- worker-evidence -----------------------------------------------------------------------------------------------------------------

/** `test_like_path P` @param {string} p */
function testLikePath(p) {
  return /^(.*_test\..*|.*\.test\..*|.*\.spec\..*|.*Test\..*|.*Tests\..*|test_.*|.*\/test_.*|test\/.*|tests\/.*|.*\/test\/.*|.*\/tests\/.*|__tests__\/.*|.*\/__tests__\/.*|spec\/.*|.*\/spec\/.*)$/s.test(p);
}

/** `green_after_change OLD NEW` @param {string} old @param {string} snapshot */
function greenAfterChange(old, snapshot) {
  const oldLines = new Set(old.split(';'));
  let impl = false;
  let changedImpl = false;
  let changed = false;
  for (const e of snapshot.split(';')) {
    if (e === '') continue;
    const p = e.slice(0, e.lastIndexOf('='));
    const t = testLikePath(p);
    if (!t) impl = true;
    if (!oldLines.has(e)) { changed = true; if (!t) changedImpl = true; }
  }
  return impl ? changedImpl : changed;
}

/** `latest_evidence EVDIR PHASE PATH`: the highest numbered PHASE record covering PATH. @param {Context} ctx @param {string} evdir @param {string} phase @param {string} p */
function latestEvidence(ctx, evdir, phase, p) {
  let best = '';
  let bestN = 0;
  let names = [];
  try { names = readdirSync(evdir).sort(); } catch { names = []; }
  for (const n of names) {
    if (!n.startsWith(`${phase}-`) || !n.endsWith('.yaml')) continue;
    const f = `${evdir}/${n}`;
    const target = fileLines(ctx, f).find((l) => l.startsWith('target:'));
    if (target === undefined || !target.slice('target:'.length).replace(/^ */, '').split(',').includes(p)) continue;
    const s = n.slice(phase.length + 1, -'.yaml'.length);
    if (!/^[0-9]+$/.test(s)) continue;
    if (Number(s) > bestN) { bestN = Number(s); best = f; }
  }
  return best;
}

/** `next_evidence_seq DIR PHASE` @param {string} evdir @param {string} phase */
function nextEvidenceSeq(evdir, phase) {
  let n = 0;
  let names = [];
  try { names = readdirSync(evdir); } catch { names = []; }
  for (const f of names) {
    if (!f.startsWith(`${phase}-`) || !f.endsWith('.yaml')) continue;
    const s = f.slice(phase.length + 1, -'.yaml'.length);
    if (!/^[0-9]+$/.test(s)) continue;
    if (Number(s) > n) n = Number(s);
  }
  return n + 1;
}

/** `scope_snapshot MAPPINGS` @param {Context} ctx @param {string[]} paths */
function scopeSnapshot(ctx, paths) {
  let out = '';
  for (const p of expandWords(paths.join('\n'), ctx.cwd)) {
    let h = 'missing';
    try { if (lstatSync(`${ctx.root}/${p}`).isFile()) h = hashFile(`${ctx.root}/${p}`); } catch { /* missing */ }
    out += `${p}=${h};`;
  }
  return out;
}

/** `worker-evidence ID PHASE RESULT` with the evidence fields on stdin. @param {Context} ctx @param {string[]} args */
export function workerEvidenceCommand(ctx, args) {
  const id = need(args, 0); const phase = need(args, 1); const result = need(args, 2);
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  requireOpenRun(ctx, id);
  const topology = resolveTopology(ctx, dir);
  const expected = topology === 'standalone' ? 'lead' : 'implementer';
  if (ctx.role !== expected) fail(`command requires AGENT_ROLE=${expected} for this run's execution topology (${topology})`);
  if (!['RED', 'GREEN', 'REFACTOR', 'FIX'].includes(phase)) fail(`invalid worker-evidence phase: ${phase}`);
  if (result !== 'pass' && result !== 'fail') fail(`invalid worker-evidence result: ${result} (want pass|fail)`);
  if (sectionValue(ctx, dir, 'handoff', 'state') !== 'IMPLEMENTING') fail('worker evidence may only be recorded while handoff state is IMPLEMENTING');
  verifyFreeze(ctx, id); // prints `freeze verified: ID`, as the shell did
  enforceTaskBranch(ctx, id);
  verifySeal(ctx, id, dir);
  const stdin = readStdin();
  const commandText = fieldFromText(stdin, 'command');
  const targetText = fieldFromText(stdin, 'target');
  const expectedFailure = fieldFromText(stdin, 'expected_failure');
  if (commandText === '') fail('worker evidence requires a non-empty command');
  // #265 AC-2 (A273): GREEN may carry the duration of each new test, read from the run's own output: `test_durations: name=ms[; name=ms]`
  const durationsGiven = stdin.split('\n').some((l) => l.startsWith('test_durations:'));
  const durations = fieldFromText(stdin, 'test_durations').trim();
  if (durationsGiven) {
    if (phase !== 'GREEN') fail(`${phase} evidence cannot carry test_durations: only a passing GREEN run has a test duration to report`);
    const okEntry = (/** @type {string} */ e) => { const i = e.lastIndexOf('='); return i > 0 && e.slice(0, i).trim() !== '' && !e.slice(0, i).includes('=') && /^\d+(\.\d+)?$/.test(e.slice(i + 1)); };
    if (durations.length > 4096) fail('test_durations is longer than 4096 characters');
    if (!durations.split(';').every((e) => okEntry(e.trim()))) fail('test_durations must be `<test name>=<milliseconds>` entries separated by `;` (a number of 0 or more read from the GREEN run output, never an estimate)');
  }
  if (targetText === '') fail('worker evidence requires a non-empty target (comma-separated scope paths)');
  const sc = planScope(ctx, dir);
  if (!sc.ok) fail('invalid scope mapping');
  const targets = expandWords(targetText.replace(/,/g, ' '), ctx.cwd);
  for (const p of targets) if (!authorizedPath(sc.rows, p)) fail(`worker evidence rejected: target outside frozen scope: ${p}`);
  if (phase === 'RED') {
    if (result !== 'fail') fail('RED evidence must record result: fail');
    if (!justificationOk(expectedFailure)) fail('RED evidence requires a specific, non-generic expected_failure (>=20 chars, not a stock phrase)');
  } else if (result !== 'pass') fail(`${phase} evidence must record result: pass`);
  const evdir = `${dir}/worker-evidence`;
  const snapshot = scopeSnapshot(ctx, scopePaths(sc.rows));
  const plan = fileLines(ctx, `${dir}/PLAN.md`);
  if (phase === 'GREEN' || phase === 'REFACTOR') {
    for (const p of targets) {
      if (exemptedPath(plan, p) !== '') continue;
      const red = latestEvidence(ctx, evdir, 'RED', p);
      if (red === '') fail(`${phase} evidence rejected: no RED evidence for ${p} yet; record RED (the failing test, before the fix) first`);
      if (phase === 'GREEN') {
        const old = fieldOf(fileLines(ctx, red), 'scope_snapshot');
        if (old !== '' && !greenAfterChange(old, snapshot)) {
          fail(`GREEN evidence rejected: no implementation file changed since the RED record for ${p}; make the fix, then record GREEN. Your own work: record RED before the fix next time. A change that someone else left in the tree before you started: save the file to scratch, put it back to the base content (git show <base>:<path>, or a failing stub for a new file; never delete a file), record RED, restore it, record GREEN, all in one turn (A198)`);
        }
      } else if (latestEvidence(ctx, evdir, 'GREEN', p) === '' && latestEvidence(ctx, evdir, 'FIX', p) === '') fail(`REFACTOR evidence rejected: no GREEN evidence for ${p} yet`);
    }
  }
  // #265 package B (A275): a run started with the measure=1 stamp (sealed in its ledger) must report the duration of the new tests with every GREEN that
  // covers a non-exempt path. A run started before the stamp existed keeps the optional field.
  if (phase === 'GREEN' && !durationsGiven && measureRequired(ctx, id) && targets.some((p) => exemptedPath(plan, p) === '')) {
    fail('GREEN evidence requires `test_durations: <test name>=<milliseconds>[; ...]` (the duration of each new test, read from the GREEN run output, never an estimate): this run was started with the test measurement (#265); a run started before it does not need the line');
  }
  if (phase === 'GREEN' && durationsGiven && durations === '') fail('test_durations is empty: name each new test with its measured milliseconds');
  try { mkdirSync(evdir, { recursive: true }); } catch { fail(`worker evidence directory could not be created (sandbox denied write?): ${evdir}`); }
  const seq = nextEvidenceSeq(evdir, phase);
  const out = `${evdir}/${phase}-${seq}.yaml`;
  const sv = (/** @type {string} */ k) => sectionValue(ctx, dir, 'freeze', k);
  let t = `task_id: "${id}"\nphase: "${phase}"\nresult: "${result}"\nrole: "${ctx.role}"\ntopology: "${topology}"\n`;
  t += `command: ${commandText}\ntarget: ${targetText}\n`;
  if (durationsGiven) t += `test_durations: ${durations.split(';').map((e) => e.trim()).join('; ')}\n`;
  if (phase === 'RED') t += `expected_failure: ${expectedFailure}\n`;
  t += `scope_snapshot: ${snapshot}\n`;
  const base = headSha(ctx);
  if (base === '') { rmSync(out, { force: true }); fail(`failed to write worker evidence file (sandbox denied write?): ${out}`); }
  t += `base_sha: "${base}"\n`;
  t += `task_sha256: "${sv('task_sha256')}"\nevidence_sha256: "${sv('evidence_sha256')}"\nplan_sha256: "${sv('plan_sha256')}"\n`;
  const codex = ctx.env.CODEX_SESSION_ID;
  if (codex !== undefined && codex !== '') t += `codex_session_id: "${codex}"\n`;
  t += `timestamp: "${now().iso}"\n`;
  try { writeFileSync(out, Buffer.from(t, 'latin1')); } catch { rmSync(out, { force: true }); fail(`failed to write worker evidence file (sandbox denied write?): ${out}`); }
  let size = 0;
  try { size = statSync(out).size; } catch { /* none */ }
  if (size === 0) { rmSync(out, { force: true }); fail(`worker evidence file was not actually written (empty or missing after redirect): ${out}`); }
  ctx.forget('file:');
  ctx.out(`worker evidence recorded: ${id} ${phase}-${seq} (${result})\n`);
  return 0;
}

// ---- raise-budget --------------------------------------------------------------------------------------------------------------------

/** `raise-budget ID N` @param {Context} ctx @param {string[]} args */
export function raiseBudgetCommand(ctx, args) {
  const id = need(args, 0); const nArg = need(args, 1);
  requireRun(ctx, id); requireLead(ctx); requireOpenRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!/^[0-9]+$/.test(nArg)) fail('usage: agent.sh raise-budget <ID> <N>');
  const n = BigInt(nArg);
  const current = mutationBudget(ctx, id);
  if (!(n > BigInt(current))) fail(`the mutation budget is already ${current}; nothing to raise`);
  const acs = planTestAcs(fileText(ctx, `${dir}/PLAN.md`) ?? '');
  if (!(n >= BigInt(acs))) fail(`N must cover the ${acs} criteria of PLAN ## Tests`);
  const app = findApproval(ctx, id, 'mutation_budget', hashFile(`${dir}/PLAN.md`));
  if (app === null) fail(`raising the mutation budget needs the user's approval: 'agent.sh request-approval ${id} mutation_budget', relay it, then run this again`);
  const via = gateField(ctx, app, 'via_batch');
  if (via !== '' && !(n <= BigInt(gateField(ctx, app, 'cap') || '0'))) fail(`the batch approval covers a mutation budget up to ${gateField(ctx, app, 'cap')}; ${n} is above it. Park the task with 'agent.sh ask ${id}'`);
  writeFileSync(`${dir}/mutation_budget`, `${n}\n`);
  ctx.forget('file:');
  consumeApproval(ctx, id, app);
  ledgerIf(ctx, id, 'raise-budget', '-', '-', `test_trust.mutation_budget ${n} for this run, approval ${path.basename(app)}`);
  ctx.out(`mutation budget raised to ${n} for ${id} (dispatch the reviewer again if REVIEW_TESTS was BLOCKED)\n`);
  return 0;
}

// ---- waive ---------------------------------------------------------------------------------------------------------------------------

/** `waive ID FINDING-ID --reason TEXT [--group]` @param {Context} ctx @param {string[]} args */
export function waiveCommand(ctx, args) {
  const id = need(args, 0); let fid = need(args, 1);
  let reason = '';
  let group = false;
  for (let i = 2; i < args.length;) {
    if (args[i] === '--reason') { reason = args[i + 1] ?? ''; i += 2; } else if (args[i] === '--group') { group = true; i++; } else fail(`unknown waive argument: ${args[i]}`);
  }
  requireRun(ctx, id); requireLead(ctx); requireOpenRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!justificationOk(reason)) fail('waive requires a specific --reason (>=20 chars)');
  fid = waiveCanon(ctx, id, fid);
  const nowFp = gateFingerprint(ctx);
  const rec = waiveTarget(ctx, id, fid, nowFp);
  const gate = gateField(ctx, rec, 'gate');
  const rsha = hashFile(rec);
  const app = findApproval(ctx, id, `waive:${fid}`, `${path.basename(rec)}@${rsha}#${fid}`);
  if (app === null) fail(`waiving ${fid} needs the user's approval naming it: 'agent.sh request-approval ${id} waive:${fid}', relay, then 'agent.sh approve ${id} waive:${fid}'`);
  const rep = fid;
  const list = group ? waiveGroupIds(ctx, rec, fid) : [fid];
  for (const f of list) {
    mkdirSync(`${dir}/waivers`, { recursive: true });
    const n = nextNum(`${dir}/waivers`);
    const out = `${dir}/waivers/${n}-${f}.yaml`;
    let follow = 'none';
    if (ctx.config().get('review.waiver_followup', 'none') === 'task') {
      const fu = `${dir}/waivers/${n}-${f}.followup.md`;
      const rows = fileLines(ctx, rec).filter((l) => l.startsWith(`finding: ${f}|`)).map((l) => `${l.slice('finding: '.length)}\n`).join('');
      writeFileSync(fu, Buffer.from(`# Follow-up: waived finding ${f} of ${id}\n\n## Goal\n\nResolve the waived finding.\n\n## Context\n\nOrigin: ${id} (waived finding ${f})\n\n${rows}\nWaiver reason: ${reason}\n`, 'latin1'));
      const adapter = ctx.config().get('tasks.adapter', 'markdown');
      if (adapterExists(ctx.root, adapter)) {
        const r = runTaskAdapter(ctx, adapter, ['followup', id, fu]);
        if (r !== null && r.stderr.length > 0) ctx.err(r.stderr.toString('latin1'));
        if (r === null || r.status !== 0) fail(`follow-up task creation failed via ${ctx.agents}/task-integrations/${adapter}.sh`);
        follow = r.stdout.toString('latin1').replace(/\n+$/, '');
      } else follow = 'pending';
    }
    const t = `finding: "${f}"\ngate: "${gate}"\ngate_record: "${path.basename(rec)}"\ngate_record_sha256: "${rsha}"\nfinding_key: "${findingWaiverKey(ctx, rec, f)}"\nfingerprint: "${nowFp}"\nreason: ${oneLine(reason)}\napproval: "${path.basename(app)}"\nanswered_by: "user"\nfollowup: "${follow}"\ntimestamp: "${now().iso}"\n`;
    writeFileSync(out, Buffer.from(t, 'latin1'));
    ctx.forget('file:');
    if (gatesEnforced(ctx, dir)) led(ctx, id, 'waive', '-', '-', `${ledgerToken(dir, `waivers/${n}-${f}.yaml`)} ${f} gate=${gate} reason=${reason}`);
    if (!group) ctx.out(`waiver recorded: ${id} ${f} (${gate})\n`);
  }
  consumeApproval(ctx, id, app);
  if (group) ctx.out(`group waiver recorded: ${id} ${rep} and ${list.length} finding(s) of the same rule (${gate}): ${list.join(' ')}\n`);
  return 0;
}

// ---- gate ----------------------------------------------------------------------------------------------------------------------------

/** `gate ID GATE pass|fail [ARTIFACT]` (the compatibility form): the role's report holds exactly one `Verdict:` line and the form on stdin names the summary. @param {Context} ctx @param {string[]} args */
export function gateCommand(ctx, args) {
  const id = need(args, 0); const gate = need(args, 1); const result = need(args, 2);
  let art = args[3] ?? '';
  requireRun(ctx, id);
  const dir = runDir(ctx, id);
  if (!validGateName(gate) || gate === 'SECRETS') fail(`invalid gate: ${gate} (SECRETS is recorded by 'agent.sh secret-scan')`);
  if (result !== 'pass' && result !== 'fail') fail(`invalid gate result: ${result} (want pass|fail)`);
  if (ctx.role === 'lead') fail('the lead can never record a gate verdict');
  if (ctx.role !== gateOwner(gate)) fail(`role ${ctx.role} may not record a ${gate} gate`);
  gatePreconditions(ctx, id, gate);
  if (art === '') art = gateDefaultArtifact(gate);
  if (notRunRelative(art)) fail(`artifact path must be run-relative: ${art}`);
  if (!artifactAllowed(ctx.role, 'gate', gateFocus(gate), art)) fail(`artifact ${art} is outside the paths of ${gate}: ${artifactPaths(ctx.role, 'gate', gateFocus(gate))}`);
  const report = fileText(ctx, `${dir}/${art}`);
  if (report === null || report.length === 0) fail(`${gate} gate requires the role's report ${art} in the run directory`);
  const lines = report.split('\n');
  if (lines.filter((l) => l.startsWith('Verdict:')).length !== 1) fail(`${art} must contain exactly one 'Verdict:' line`);
  const verdict = (lines.find((l) => l.startsWith('Verdict:')) ?? '').slice('Verdict:'.length).replace(/^ */, '').replace(/ /g, '');
  if (!((result === 'pass' && verdict === 'PASS') || (result === 'fail' && verdict === 'FAIL'))) fail(`${art} says 'Verdict: ${verdict === '' ? '<missing>' : verdict}' but the gate result is '${result}'`);
  const stdin = readStdin();
  const summary = fieldFromText(stdin, 'summary'); const findings = fieldFromText(stdin, 'findings'); const fscope = fieldFromText(stdin, 'fix_scope');
  if (!justificationOk(summary)) fail(`${gate} gate requires a specific summary (>=20 chars, not a stock phrase)`);
  /** @type {string[]} */ const rows = [];
  if (result === 'fail') {
    if (!justificationOk(findings)) fail('a failing gate requires specific findings (>=20 chars)');
    if (scopeEntryPaths(fscope).length === 0) fail('a failing gate requires fix_scope with at least one path (comma-separated paths the fix may touch)');
    let i = 0;
    for (const p of expandWords(fscope.replace(/,/g, ' '), ctx.cwd)) { i++; rows.push(`${gate}-${i}|blocking|${p}|${oneLine(findings)}|${art}`); }
  }
  writeGate(ctx, { id, gate, result, role: ctx.role, confidence: 'high', focus: gateFocus(gate), artifact: art, findings: rows, resultFile: '', fingerprint: gateFingerprint(ctx) });
  return 0;
}
