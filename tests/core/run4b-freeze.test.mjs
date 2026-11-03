// @ts-check
// Stage 4, package 4B: `freeze`, `refreeze` and `handoff` as absolute Node tests (A213). They replace the behaviour of lifecycle-test.sh
// scenario_standalone, scenario_task_boundaries, scenario_freeze_scope_mapping, scenario_amendment_fresh_budget, scenario_classification_diff and the
// ladder checks of scenario_hardening (tests/legacy-port-map.tsv); the shell scenarios keep running against the Node commands through the fixture prologue.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, approveAsUser, project, read, refused, verbs } from './legacy-lib.mjs';

const runValue = (/** @type {string} */ d, /** @type {string} */ s, /** @type {string} */ k) => {
  const m = new RegExp(`^${s}:\\n(?:  .*\\n)*?  ${k}: "?([^"\\n]*)"?$`, 'm').exec(read(d, '.agents/runs/LC/RUN.yaml'));
  return m ? m[1] : '';
};
const sha = (/** @type {string} */ d, /** @type {string} */ f) => createHash('sha256').update(readFileSync(`${d}/.agents/runs/LC/${f}`)).digest('hex');
/** `qa_bind` of the self-test library: the QA plan cites the sha256 of the current PLAN.md, as the qa role does (A42). @param {string} d */
function bind(d) {
  const q = `${d}/.agents/runs/LC/QA_PLAN.md`;
  let plan;
  let qa;
  try { plan = readFileSync(`${d}/.agents/runs/LC/PLAN.md`); qa = readFileSync(q, 'utf8'); } catch { return; }
  const lines = qa.split('\n');
  const rest = lines.slice(1).filter((l) => !l.startsWith('Plan sha256: ')).join('\n');
  writeFileSync(q, `${lines[0]}\n\nPlan sha256: ${createHash('sha256').update(plan).digest('hex')}\n${rest}`);
}
/** One call of the control plane; a freeze or refreeze binds the QA plan first, as the self-test library's A does. @param {string} d @param {string[]} args @param {{ role?: string, input?: string }} [o] */
const AF = (d, args, o = {}) => { if (args[0] === 'freeze' || args[0] === 'refreeze') bind(d); return A(d, args, o); };
const SUP = (/** @type {string} */ env = '') => `${env} scaffold standalone no COMPLEX supervised`;
const addPlan = (/** @type {string} */ d, /** @type {string} */ text) => writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md') + text);

test('freeze: records the hashes of the task, plan, policy and risk block, the pipeline and the scope; the ledger names it; verify-freeze agrees', () => {
  const d = project('scaffold standalone');
  assert.equal(runValue(d, 'freeze', 'task_sha256'), sha(d, 'TASK.md'));
  assert.equal(runValue(d, 'freeze', 'plan_sha256'), sha(d, 'PLAN.md'));
  assert.equal(runValue(d, 'freeze', 'evidence_sha256'), sha(d, 'EVIDENCE.md'));
  assert.equal(runValue(d, 'freeze', 'qa_plan_sha256'), sha(d, 'QA_PLAN.md'));
  assert.match(runValue(d, 'freeze', 'risk_sha256'), /^[0-9a-f]{64}$/);
  assert.equal(runValue(d, 'freeze', 'pipeline'), 'COMPLEX:review=yes');
  assert.equal(runValue(d, 'freeze', 'scope_paths'), 'impl.txt,impl_test.txt');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=freeze role=lead from=PLANNED to=PLANNED .* detail=COMPLEX:review=yes$/m);
  accepted(A(d, ['verify-freeze', 'LC']), 'verify-freeze');
});

test('freeze: a non-lead, a missing baseline and a second plain freeze are refused; a refreeze needs a new amendment file and a change', () => {
  const d = project(SUP());
  refused(AF(d, ['freeze', 'LC'], { role: 'reviewer' }), 'a non-lead', 'command denied for reviewer: freeze');
  const e = project('scaffold standalone');
  refused(A(e, ['freeze', 'LC']), 'a second plain freeze', 'existing freeze requires an explicit amendment. Expected: agent.sh refreeze LC <AMENDMENT-FILE-NAME>');
  refused(A(e, ['refreeze', 'LC', '../x.md']), 'a path as the amendment', 'invalid amendment name: ../x.md');
  refused(A(e, ['refreeze', 'LC', '009.md']), 'a missing amendment', 'amendment 009.md not found');
  mkdirSync(`${e}/.agents/runs/LC/amendments`, { recursive: true });
  writeFileSync(`${e}/.agents/runs/LC/amendments/001.md`, '# amendment 001: nothing changes\n');
  refused(A(e, ['refreeze', 'LC', '001.md']), 'a refreeze that changes nothing', 'refreeze changes nothing');
  addPlan(e, '\nsecond thoughts\n');
  accepted(AF(e, ['refreeze', 'LC', '001.md']), 'refreeze');
  assert.equal(runValue(e, 'freeze', 'plan_sha256'), sha(e, 'PLAN.md'));
  assert.match(read(e, '.agents/runs/LC/LEDGER.log'), / event=refreeze role=lead from=IMPLEMENTING to=IMPLEMENTING .* detail=amendment 001\.md$/m);
  addPlan(e, '\nthird thoughts\n');
  refused(A(e, ['refreeze', 'LC', '001.md']), 'an amendment used twice', 'amendment 001.md was already used for a refreeze');
});

test('freeze: the task\'s own boundaries - Forbidden scope is never waived, Allowed scope bounds the plan, an entry must be a path, a pattern reference must exist and be named', () => {
  const task = (/** @type {string} */ t) => SUP(`SC_TASK_EXTRA='${t}'`);
  let d = project(task('\n## Forbidden scope\n\n- `impl.txt`\n'));
  refused(AF(d, ['freeze', 'LC']), 'a plan path in Forbidden scope', "plan scope path impl.txt is inside the task's Forbidden scope");
  d = project(task('\n## Forbidden scope\n\n- `IMPL.TXT`\n'));
  refused(AF(d, ['freeze', 'LC']), 'a case-folded Forbidden scope', "inside the task's Forbidden scope");
  d = project(task('\n## Allowed scope\n\n- `docs/`\n'));
  refused(AF(d, ['freeze', 'LC']), 'a plan path outside Allowed scope', "plan scope path(s) outside the task's Allowed scope: impl.txt impl_test.txt");
  d = project(task('\n## Allowed scope\n\n- a sentence that is not a path\n'));
  refused(AF(d, ['freeze', 'LC']), 'a sentence as an entry', "has an entry that is not a path or glob: \"a\"");
  d = project(task('\n## Existing pattern references\n\n- `src/nope.js`\n'));
  refused(AF(d, ['freeze', 'LC']), 'a reference that does not exist', 'name src/nope.js, which does not exist in the repository');
  d = project(`${task('\n## Existing pattern references\n\n- `lib/pattern.js`\n')}`);
  mkdirSync(`${d}/lib`, { recursive: true });
  writeFileSync(`${d}/lib/pattern.js`, 'x\n');
  refused(AF(d, ['freeze', 'LC']), 'a reference the plan does not name', "PLAN.md does not mention the task's Existing pattern reference lib/pattern.js");
  d = project(task('\n## Allowed scope\n\n- `impl*.txt`\n'));
  approveAsUser(d, 'plan', 'approve the plan');
  accepted(AF(d, ['freeze', 'LC']), 'a plan inside Allowed scope');
});

test('freeze: scope existence - a new file must be marked new: true and must not exist, an old file must exist', () => {
  let d = project(SUP());
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md').replace('scope:\n', 'scope:\n  - path: ghost.txt\n    criteria: [AC-1]\n'));
  refused(AF(d, ['freeze', 'LC']), 'a scope path that does not exist', "scope path ghost.txt does not exist; mark it 'new: true' when the task creates it");
  d = project(SUP());
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md').replace('  - path: impl.txt\n    criteria: [AC-1]\n', '  - path: impl.txt\n    criteria: [AC-1]\n    new: true\n'));
  refused(AF(d, ['freeze', 'LC']), "a 'new: true' path that exists", "scope path impl.txt is marked 'new: true' but already exists");
  d = project(SUP());
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md').replace('scope:\n', 'scope:\n  - path: broken.txt\n'));
  refused(AF(d, ['freeze', 'LC']), 'an entry without criteria', 'invalid scope mapping: fix PLAN.md ## Scope entries');
});

test('freeze: a supervised freeze needs the user\'s plan approval for this very PLAN.md and consumes it; a changed plan drops it', () => {
  const d = project(SUP());
  refused(AF(d, ['freeze', 'LC']), 'a supervised freeze without approval', "supervised freeze requires a plan approval for this PLAN.md: run 'agent.sh request-approval LC plan'");
  approveAsUser(d, 'plan', 'approve the plan');
  addPlan(d, '\nchanged after the approval\n');
  refused(AF(d, ['freeze', 'LC']), 'an approval bound to another plan', 'supervised freeze requires a plan approval');
  approveAsUser(d, 'plan', 'approve the plan please');
  accepted(AF(d, ['freeze', 'LC']), 'freeze with the approval');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=approval-consumed .* detail=\d{3}-plan\.yaml plan$/m);
});

test('freeze: the mutation budget is one question now, a destructive plan becomes CRITICAL, non-English plan text is refused, a UI plan needs visual_writes', () => {
  let d = project(SUP());
  approveAsUser(d, 'plan', 'approve the plan');
  addPlan(d, `\n## Tests\n\n${Array.from({ length: 25 }, (_, i) => `- AC-${i + 1}: criterion ${i + 1}`).join('\n')}\n`);
  approveAsUser(d, 'plan', 'approve the plan');
  refused(AF(d, ['freeze', 'LC']), 'criteria above the mutation budget', 'PLAN ## Tests names 25 criteria but the mutation budget is 20');
  assert.ok(read(d, '.agents/runs/LC/approvals/' + readdirApprovals(d)).includes('mutation_budget'), 'no mutation_budget request');
  d = project(SUP());
  addPlan(d, '\n## Data\n\ndestructive: yes\n');
  const r = AF(d, ['freeze', 'LC']);
  assert.match(r.out, /classification forced to CRITICAL: PLAN\.md declares a destructive data change/);
  assert.equal(runValue(d, 'pipeline', 'classification'), 'CRITICAL');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=classify .* detail=CRITICAL \(forced: destructive data change; was COMPLEX\)$/m);
  d = project(SUP());
  addPlan(d, '\nBu plan çok güzel ve şu görev için yazıldı, öğrenci ğüşiöç.\n');
  refused(AF(d, ['freeze', 'LC']), 'non-English plan text', 'language: run artifacts are English');
  d = project(SUP());
  addPlan(d, '\n## UI\n\nA page with a form.\n');
  refused(AF(d, ['freeze', 'LC']), 'a UI plan without visual_writes', "no 'visual_writes: <how the data the page writes is thrown away>' line");
});

/** @param {string} d */
function readdirApprovals(d) {
  return verbs(d, 'ls .agents/runs/LC/approvals | grep mutation_budget | head -1').out.trim();
}

test('a design document in a nested folder of the run is a known run artifact (the shell case pattern design/*.md spans folders); a stray top-level file is not', () => {
  const d = project('scaffold standalone');
  mkdirSync(`${d}/.agents/runs/LC/design/adr`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/design/adr/0001-x.md`, 'x\n');
  accepted(A(d, ['verify-scope', 'LC']), 'a nested design document');
  writeFileSync(`${d}/.agents/runs/LC/notes.txt`, 'x\n');
  refused(A(d, ['verify-scope', 'LC']), 'a stray file', 'unexpected run artifact');
});

test('freeze: TRIVIAL covers text and configuration only - executable code in the scope is refused', () => {
  const d = project('scaffold standalone no TRIVIAL supervised');
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, read(d, '.agents/runs/LC/PLAN.md').replaceAll('impl.txt', 'impl.go'));
  writeFileSync(`${d}/impl.go`, 'package x\n');
  refused(AF(d, ['freeze', 'LC']), 'executable code in a TRIVIAL scope', 'the TRIVIAL pipeline covers text and configuration only; scope has executable code: impl.go');
});

test('handoff: the ladder is strict, an implementer may only start implementing, IMPLEMENTED needs the worker evidence, CODE_DONE needs the gates and an unchanged tree', () => {
  const d = project('scaffold standalone');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE from IMPLEMENTING', 'illegal handoff transition: IMPLEMENTING -> CODE_DONE');
  refused(A(d, ['handoff', 'LC', 'DONE']), 'DONE from IMPLEMENTING', 'illegal handoff transition: IMPLEMENTING -> DONE');
  refused(A(d, ['handoff', 'LC', 'FINISHED']), 'an unknown phase', 'invalid handoff phase');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED'], { role: 'implementer' }), 'an implementer past IMPLEMENTING', 'handoff phase denied for implementer');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED without worker evidence', 'worker-evidence verification failed');
  verbs(d, "solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'");
  const r = accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
  assert.match(r.out, /^handoff recorded: LC IMPLEMENTED$/m);
  assert.equal(runValue(d, 'handoff', 'state'), 'IMPLEMENTED');
  assert.match(runValue(d, 'handoff', 'implemented_patch_sha256'), /^[0-9a-f]{64}$/);
  assert.equal(runValue(d, 'handoff', 'code_done_patch_sha256'), 'PENDING');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=handoff:IMPLEMENTED role=lead from=IMPLEMENTING to=IMPLEMENTED /);
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with gates missing', 'CODE_DONE blocked');
  verbs(d, 'pass_all');
  writeFileSync(`${d}/impl.txt`, `${read(d, 'impl.txt')}edited after IMPLEMENTED\n`);
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE on a changed tree', 'CODE_DONE blocked: the application tree changed since IMPLEMENTED');
});

test('handoff: a defect task needs the debug report, a TRIVIAL run whose diff holds executable code is blocked, the run reaches DONE through CODE_DONE', () => {
  let d = project("SC_TASK_FM='type: bug' scaffold standalone no STANDARD");
  verbs(d, "solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'");
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED for a bug without a debug report', "IMPLEMENTED blocked: the task is typed or labelled as a defect ('type: bug'");
  mkdirSync(`${d}/.agents/runs/LC/reports`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/reports/001-debug.md`, '# debug\n');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED with the debug report');
  d = project('scaffold standalone; to_code_done standalone; finish_done');
  assert.equal(runValue(d, 'handoff', 'state'), 'DONE');
  assert.equal(runValue(d, 'execution', 'state'), 'CODE_DONE');
  const ledger = read(d, '.agents/runs/LC/LEDGER.log');
  for (const p of ['IMPLEMENTING', 'IMPLEMENTED', 'CODE_DONE', 'DONE']) assert.match(ledger, new RegExp(` event=handoff:${p} `));
  accepted(A(d, ['validate', 'LC']), 'validate');
});
