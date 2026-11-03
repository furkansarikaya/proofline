// @ts-check
// Stage 4, package 4C: the gate record writer and the preconditions every recorded gate meets (agent.sh 0.0.47 `write_gate`, `gate_preconditions`,
// `valid_gate_name`, `gate_default_artifact`). `gate`, `secret-scan` and `record` all end here, so the bytes of a gate record, its manifest and the
// ledger row (the hash chain) are written in ONE place.
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { now } from './clock.mjs';
import { fail } from './errors.mjs';
import { requireOpenRun } from './approve.mjs';
import { hashFile } from './fingerprint.mjs';
import { patchManifest, requiredGates, gatesDir, taskPatchFingerprint, verifyMutationOwnership } from './gates.mjs';
import { verifySeal } from './ledger.mjs';
import { enforceTaskBranch } from './lifecycle.mjs';
import { led, must, quietly } from './lifeutil.mjs';
import { ledgerToken } from './questions.mjs';
import { gatesEnforced, sectionValue } from './records.mjs';
import { runDir } from './runs.mjs';
import { tierEffective } from './signals.mjs';
import { freshness, verifyScope } from './commands/verify.mjs';
import { nextGateSeq } from './reopen.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The version of the rule that decides blocking or info (GATES.md); a gate record carries it. `blocking_rule_version` of agent.sh. */
export const BLOCKING_RULE_VERSION = '1';

/** `valid_gate_name` @param {string} g */
export function validGateName(g) { return ['SECRETS', 'REVIEW_SMALL', 'REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'REVIEW_DATA', 'SECURITY', 'QA', 'VERIFY'].includes(g); }

/** `gate_default_artifact` @param {string} g */
export function gateDefaultArtifact(g) {
  switch (g) {
    case 'REVIEW_PLAN': return 'reviews/proof-review/plan/REPORT.md';
    case 'REVIEW_RULES': return 'reviews/proof-review/rules/REPORT.md';
    case 'REVIEW_SMALL': return 'reviews/proof-review/small/REPORT.md';
    case 'REVIEW_TESTS': return 'reviews/test-trust/tests/REPORT.md';
    case 'REVIEW_DATA': return 'reviews/data-design/REVIEW.md';
    case 'SECURITY': return 'security/REPORT.md';
    case 'QA': return 'QA_REPORT.md';
    case 'VERIFY': return 'VERIFY.md';
    default: return '';
  }
}

/**
 * `gate_preconditions ID GATE`: the run is enforced and open, the gate is required, the branch, the freshness, the seal, the state IMPLEMENTED, the
 * scope, the patch fingerprint and the mutation ownership all hold. Every refusal is a `fail` (the order is the shell's).
 * @param {Context} ctx @param {string} id @param {string} gate
 */
export function gatePreconditions(ctx, id, gate) {
  const dir = runDir(ctx, id);
  if (!gatesEnforced(ctx, dir)) fail(`run ${id} has no lifecycle_gates policy: gates are not recorded for it`);
  requireOpenRun(ctx, id);
  const req = requiredGates(ctx, dir);
  if (!req.includes(gate)) fail(`${gate} is not a required gate of ${id} (required: ${req.map((g) => `${g} `).join('')})`);
  enforceTaskBranch(ctx, id);
  quietly(ctx, () => must(freshness(ctx, id)));
  verifySeal(ctx, id, dir);
  if (sectionValue(ctx, dir, 'handoff', 'state') !== 'IMPLEMENTED') fail(`${gate} gate may only be recorded while handoff state is IMPLEMENTED`);
  quietly(ctx, () => must(verifyScope(ctx, id, '0')));
  if (sectionValue(ctx, dir, 'handoff', 'implemented_patch_sha256') !== taskPatchFingerprint(ctx, dir)) fail(`${gate} gate blocked: the application tree changed since IMPLEMENTED`);
  verifyMutationOwnership(ctx, dir, id);
}

/** The trimmed text of one `awk` field. @param {string} s */
const trim = (s) => s.replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '');

/**
 * `write_gate ID GATE RESULT ROLE CONFIDENCE FOCUS ARTIFACT FINDINGS RESULT-FILE FINGERPRINT [UNSUPPORTED-EVIDENCE] [NOT_RERUN]`.
 * @param {Context} ctx
 * @param {{ id: string, gate: string, result: string, role: string, confidence: string, focus: string, artifact: string,
 *   findings: string[], resultFile: string, fingerprint: string, unsupportedEvidence?: string, notRerun?: string }} g
 * `findings` holds the rows "id|severity|path:line|finding|evidence".
 */
export function writeGate(ctx, g) {
  const dir = runDir(ctx, g.id);
  const gd = gatesDir(dir);
  try { mkdirSync(gd, { recursive: true }); } catch { fail(`cannot create ${gd}`); }
  const seq = nextGateSeq(dir);
  if (seq > 999) fail('gate record limit reached');
  const name = `${String(seq).padStart(3, '0')}-${g.gate}`;
  let scope = '';
  if (g.result === 'fail') {
    const set = new Set();
    for (const row of g.findings) {
      const f = row.split('|');
      if ((f[1] ?? '') === 'info') continue;
      let p = trim(f[2] ?? '');
      if (p === '' || p === '-') p = '*';
      else { p = trim(p.replace(/:[^]*$/, '')); if (p === '') continue; }
      set.add(p);
    }
    scope = [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',');
  }
  const manifest = `${gd}/${name}.manifest`;
  try { writeFileSync(manifest, patchManifest(ctx, dir).map((r) => `${r}\n`).join(''), 'latin1'); } catch { fail('could not write gate manifest'); }
  const sv = (/** @type {string} */ s, /** @type {string} */ k) => sectionValue(ctx, dir, s, k);
  const n = now();
  const patch = taskPatchFingerprint(ctx, dir);
  let t = `task_id: "${g.id}"\nseq: ${seq}\ngate: "${g.gate}"\nresult: "${g.result}"\nrole: "${g.role}"\nconfidence: "${g.confidence}"\nfocus: "${g.focus}"\n`;
  let topo = sv('execution', 'topology');
  if (topo !== 'standalone' && topo !== 'orchestrated') {
    topo = ctx.config().get('default_topology', '');
    if (topo !== 'standalone' && topo !== 'orchestrated') fail('no valid execution topology resolved: set execution.topology in RUN.yaml or default_topology in .agents/config.yaml');
  }
  t += `topology: "${topo}"\ntier: "${tierEffective(ctx, dir)}"\n`;
  t += `fingerprint: "${g.fingerprint}"\npatch_sha256: "${patch}"\nmanifest_sha256: "${hashFile(manifest)}"\n`;
  if (g.artifact !== '') t += `artifact: "${g.artifact}"\nartifact_sha256: "${hashFile(`${dir}/${g.artifact}`)}"\n`;
  t += `task_sha256: "${sv('freeze', 'task_sha256')}"\nevidence_sha256: "${sv('freeze', 'evidence_sha256')}"\nplan_sha256: "${sv('freeze', 'plan_sha256')}"\nqa_plan_sha256: "${sv('freeze', 'qa_plan_sha256')}"\n`;
  t += `policy_sha256: "${sv('freeze', 'policy_sha256')}"\npipeline: "${sv('freeze', 'pipeline')}"\n`;
  t += `blocking_rule: "${BLOCKING_RULE_VERSION}"\n`;
  if (g.resultFile !== '') t += `result_file: "${g.resultFile}"\nresult_sha256: "${hashFile(`${dir}/${g.resultFile}`)}"\n`;
  if (g.result === 'fail') t += `fix_scope: ${scope}\n`;
  if (g.result === 'unsupported') t += `unsupported: "${g.focus}"\n`;
  const ue = g.unsupportedEvidence ?? '';
  if (ue !== '') {
    const sp = ue.lastIndexOf(' ');
    const sha = ue.slice(sp + 1);
    t += `unsupported_evidence: "${sp < 0 ? ue : ue.slice(0, sp)}@${sha.slice(0, 12)}"\nunsupported_evidence_sha256: "${sha}"\n`;
  }
  if ((g.notRerun ?? '') !== '') t += `not_rerun: "${g.notRerun}"\n`;
  for (const row of g.findings) t += `finding: ${row}\n`;
  t += `timestamp: "${n.iso}"\nepoch: ${n.epoch}\n`;
  const file = `${gd}/${name}.yaml`;
  try { writeFileSync(file, t, 'latin1'); } catch { fail('could not write gate record'); }
  let size = 0;
  try { size = statSync(file).size; } catch { /* missing */ }
  if (size === 0) { rmSync(file, { force: true }); rmSync(manifest, { force: true }); fail('gate record was not written'); }
  led(ctx, g.id, `gate:${g.gate}:${g.result}`, 'IMPLEMENTED', 'IMPLEMENTED', `${ledgerToken(dir, `gates/${name}.yaml`)} by ${g.role}`);
  ctx.out(`gate recorded: ${g.id} ${name} (${g.result})\n`);
}
