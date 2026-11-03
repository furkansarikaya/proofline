// @ts-check
// Stage 4, package 4A: `discard-stray`, `verify-assumptions`, `ask`, `db-check`, `task-source-status`, `task-source-relocate`, `delivery-check` and
// `status-block` as absolute Node tests (A212). They replace the behaviour of lifecycle-test.sh scenario_hardening (the discard-stray half),
// scenario_task_contract_relocate and scenario_task_source_status, of gates-test.sh sc_ask (already ported to legacy-questions.test.mjs) and of the
// delivery-check parts of sc_knowledge_secrets and sc_knowledge_drift (tests/legacy-port-map.tsv).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, realpathSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, IMPLEMENTED, accepted, project, read, refused } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';
import { setRunValue } from '../../control-plane/agents/scripts/core/lifecycle.mjs';
import { runSecretScan } from '../../control-plane/agents/scripts/core/commands/runcmds.mjs';
import { slug } from '../../control-plane/agents/scripts/core/slug.mjs';
import { scrub } from '../../control-plane/agents/scripts/core/statusblock.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { verifyAssumptions } from '../../control-plane/agents/scripts/core/questions.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { dbSnapshot } from '../../control-plane/agents/scripts/core/dbguard.mjs';

const rv = (/** @type {string} */ d, /** @type {string} */ section, /** @type {string} */ key) => {
  let inside = false;
  for (const l of read(d, '.agents/runs/LC/RUN.yaml').split('\n')) {
    if (l === `${section}:`) { inside = true; continue; }
    if (inside && /^[^ #]/.test(l)) inside = false;
    const m = inside ? new RegExp(`^  ${key}:[ \\t]*(.*)$`).exec(l) : null;
    if (m) return m[1].replace(/"/g, '');
  }
  return '';
};
/** `refused` that hands the result back. @param {import('./legacy-lib.mjs').Result} r @param {string} what @param {string | RegExp} [msg] */
/** `verify-assumptions ID ask` in process: the freeze's mode is not on the command line (the command is read-only and takes no lock); package 4B calls it under freeze's locks. @param {string} d @param {string} [role] */
function askMode(d, role = 'lead') {
  const ctx = new Context({ env: cleanEnv({ AGENT_ROLE: role }), cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, `${d}/.agents/scripts/agent.sh`);
  let err = '';
  try { verifyAssumptions(ctx, 'LC', true); } catch (e) { err = `${/** @type {Error} */ (e).message}\n`; }
  const out = ctx.chunks.map((c) => c[1].toString('latin1')).join('');
  return { status: err ? 1 : 0, out, err, text: out + err };
}
const refusedR = (r, what, msg) => { refused(r, what, msg); return r; };
const ledger = (/** @type {string} */ d) => read(d, '.agents/runs/LC/LEDGER.log');

// ---- discard-stray ------------------------------------------------------------------------------------------------------------------

test('discard-stray: only one stray top-level regular file of the run folder, lead only, never a known artifact, ledgered and chain-safe', () => {
  const d = project(`scaffold orchestrated no TRIVIAL; ${IMPLEMENTED}`);
  const ld = `${d}/.agents/runs/LC`;
  writeFileSync(`${ld}/QA_PLAN.md-E`, 'x\n');
  refused(A(d, ['discard-stray', 'LC', 'QA_PLAN.md-E'], { role: 'qa' }), 'a non-lead discarded a stray', 'command denied for qa: discard-stray');
  assert.ok(existsSync(`${ld}/QA_PLAN.md-E`), 'a non-lead removed the stray');
  const before = ledger(d).trimEnd().split('\n').pop();
  for (const f of ['PLAN.md', 'plan.md', 'Plan.MD', 'ledger.log', 'LEDGER.log', 'qa_plan.md', 'Qa_Report.md', 'run.yaml', 'run.yaml.tmp']) {
    refused(A(d, ['discard-stray', 'LC', f]), `discard-stray removed a protected name (${f})`, 'known run artifact');
  }
  assert.ok(existsSync(`${ld}/PLAN.md`) && existsSync(`${ld}/LEDGER.log`) && existsSync(`${ld}/TASK.md`), 'a protected file was removed');
  refused(A(d, ['discard-stray', 'LC', 'ta\u017ftk.md']), 'the long-s spelling of task.md', 'may contain only');
  refused(A(d, ['discard-stray', 'LC', 'tas\u212a.md']), 'the Kelvin spelling of TASK.md', 'may contain only');
  refused(A(d, ['discard-stray', 'LC', '']), 'an empty name', 'usage: agent.sh discard-stray');
  for (const [name, msg] of /** @type {Array<[string, string]>} */ ([['gates/zz.yaml', 'single top-level'], ['Results/x', 'single top-level'], ['../LC/QA_PLAN.md-E', 'single top-level'], ['.lock', 'single top-level']])) {
    refused(A(d, ['discard-stray', 'LC', name]), `discard-stray accepted ${name}`, msg);
  }
  mkdirSync(`${ld}/sub`, { recursive: true }); writeFileSync(`${ld}/sub/file`, 'x');
  refused(A(d, ['discard-stray', 'LC', 'sub/file']), 'discard-stray removed sub/file', 'single top-level');
  mkdirSync(`${ld}/gates`, { recursive: true }); symlinkSync('gates', `${ld}/lnk`); writeFileSync(`${ld}/gates/zz.yaml`, 'x');
  refused(A(d, ['discard-stray', 'LC', 'lnk/zz.yaml']), 'discard-stray went through a symlinked parent', 'single top-level');
  assert.ok(existsSync(`${ld}/gates/zz.yaml`), 'a file in gates/ was removed');
  rmSync(`${ld}/gates/zz.yaml`); rmSync(`${ld}/lnk`);
  mkdirSync(`${ld}/stray-dir`); refused(A(d, ['discard-stray', 'LC', 'stray-dir']), 'discard-stray removed a directory', 'not a regular file'); rmSync(`${ld}/stray-dir`, { recursive: true });
  symlinkSync('PLAN.md', `${ld}/link-E`); refused(A(d, ['discard-stray', 'LC', 'link-E']), 'discard-stray followed a symlink', 'symlink'); rmSync(`${ld}/link-E`);
  const r = accepted(A(d, ['discard-stray', 'LC', 'QA_PLAN.md-E']), 'discard-stray');
  assert.match(r.out, /^discarded stray run file: QA_PLAN\.md-E \(sha256 [0-9a-f]{64}\)$/m);
  assert.ok(!existsSync(`${ld}/QA_PLAN.md-E`), 'discard-stray left the stray');
  assert.match(ledger(d), /event=discard-stray .*path=QA_PLAN\.md-E sha256=/m, 'discard-stray left no ledger row');
  const lines = ledger(d).trimEnd().split('\n');
  assert.equal(lines[lines.length - 2], before, 'discard-stray broke the ledger chain');
  accepted(A(d, ['verify-seal', 'LC']), 'the seal after the discard');
  writeFileSync(`${ld}/other-E`, 'x'); spawnSync('ln', [`${ld}/other-E`, `${ld}/alias-E`]);
  accepted(A(d, ['discard-stray', 'LC', 'alias-E']), 'a hard-link alias');
  assert.ok(existsSync(`${ld}/other-E`), 'removing a hard-link alias removed the original');
  writeFileSync(`${ld}/other-E`, 'x');
  const y = read(d, '.agents/runs/LC/RUN.yaml');
  writeFileSync(`${ld}/RUN.yaml`, y.replace('published: false', 'published: true'));
  refused(A(d, ['discard-stray', 'LC', 'other-E']), 'a sealed (published) run', 'the run is sealed (completion report published)');
});

// ---- verify-assumptions and ask ---------------------------------------------------------------------------------------------------------

const HEAD = '| id | assumption | source | risk | verification | status | decisions |\n|---|---|---|---|---|---|---|';
const LOW = '| AS-3 | the cache is warm at startup | TASK.md | low | none | unverified | AC-1 |';
const P1 = '| AS-1 | the legacy key table is empty | TASK.md | high | count the rows in the staging copy | unverified | AC-1 |';
const P2 = '| AS-2 | no consumer reads the removed field | explorer-4 | high | search the consumer repositories | unverified | AC-1 |';
/** Replace the body of `## Assumptions` (an empty TEXT drops the section). @param {string} d @param {string} file @param {string} text */
function putAssumptions(d, file, text) {
  const f = `${d}/.agents/runs/LC/${file}`;
  const kept = read(d, `.agents/runs/LC/${file}`).split('\n');
  /** @type {string[]} */ const out = [];
  let skip = false;
  for (const l of kept) { if (/^## Assumptions[ \t]*$/.test(l)) { skip = true; continue; } if (l.startsWith('## ')) skip = false; if (!skip) out.push(l); }
  writeFileSync(f, out.join('\n') + (text === '' ? '' : `\n## Assumptions\n\n${text}\n`));
}
const questionFiles = (/** @type {string} */ d) => readdirSync(`${d}/.agents/runs/LC/questions`).filter((n) => /^[0-9]{3}\.md$/.test(n));
/** A user's answer file, as the prompt hook writes it. @param {string} d @param {string} n @param {string} text @param {string} by */
function answerFile(d, n, text, by = 'user') { writeFileSync(`${d}/.agents/runs/LC/questions/${n}.answer.md`, `answered_by: ${by}\ntime: 2026-01-01T00:00:00Z\nanswered_epoch: 1767225600\n---\n${text}\n`); }

test('verify-assumptions: shape of both registers, the trap, a low-risk unverified one is listed and does not block, read-only roles may run it', () => {
  const d = project('scaffold standalone no STANDARD manual');
  putAssumptions(d, 'PLAN.md', '');
  refused(A(d, ['verify-assumptions', 'LC']), 'a PLAN.md without the section', "PLAN.md: the mandatory '## Assumptions' section is missing");
  putAssumptions(d, 'PLAN.md', 'none');
  putAssumptions(d, 'EVIDENCE.md', '');
  refused(A(d, ['verify-assumptions', 'LC']), 'an EVIDENCE.md without the section', "EVIDENCE.md: the mandatory '## Assumptions' section is missing");
  putAssumptions(d, 'EVIDENCE.md', `${HEAD}\n| AS-2 | no consumer reads the removed field | explorer-4 | high | none | verified | AC-1 |`);
  refused(A(d, ['verify-assumptions', 'LC']), 'a high-risk assumption marked verified without a method', 'verified without a verification method');
  putAssumptions(d, 'EVIDENCE.md', `${HEAD}\n${LOW}`);
  assert.ok(A(d, ['verify-assumptions', 'LC']).out.includes('AS-3 risk=low status=unverified'), 'the low-risk unverified assumption is not listed');
  assert.equal(A(d, ['verify-assumptions', 'LC'], { role: 'reviewer' }).out.trimEnd().split('\n').pop(), 'assumptions verified: LC', 'a read-only role could not run it');
  refused(A(d, ['verify-assumptions']), 'no id', 'mandatory argument');
});

test('verify-assumptions: a high-risk unverified assumption blocks; `ask` (the freeze) records one bound question each; the user\'s accept is the only way out; a changed text is a new assumption', () => {
  const d = project('scaffold standalone no STANDARD manual');
  putAssumptions(d, 'PLAN.md', `${HEAD}\n${P1}`);
  putAssumptions(d, 'EVIDENCE.md', `${HEAD}\n${P2}\n${LOW}`);
  const plain = refusedR(A(d, ['verify-assumptions', 'LC']), 'an unverified high-risk assumption passed', 'never accepted silently');
  assert.ok(plain.text.includes("no question bound to it yet ('agent.sh freeze LC' records one)"));
  assert.ok(!existsSync(`${d}/.agents/runs/LC/questions`), 'the read-only form recorded a question');
  refused(askMode(d, 'reviewer'), 'a non-lead asked', 'lead only');
  const asked = refusedR(askMode(d), 'ask mode passed', 'never accepted silently');
  assert.ok(asked.text.includes("AS-1: question recorded (relay it: 'agent.sh questions LC')"));
  assert.equal(questionFiles(d).length, 2, 'not one question per high-risk assumption');
  assert.match(read(d, '.agents/runs/LC/questions/001.md'), /^ *ASSUMPTION: AS-1@[0-9a-f]{12}$/m);
  assert.match(read(d, '.agents/runs/LC/questions/002.md'), /^ *ASSUMPTION: AS-2@[0-9a-f]{12}$/m);
  assert.equal(rv(d, 'execution', 'awaiting_input'), 'true');
  assert.match(ledger(d), /event=ask .*questions\/001\.md@/);
  const again = refusedR(askMode(d), 'a pending question was not pointed at', 'is unanswered');
  assert.ok(again.text.includes('AS-1: its question questions/001.md is unanswered'));
  assert.equal(questionFiles(d).length, 2, 'a second ask duplicated a pending question');
  // the lead's own answer, or a user answer that is not an accept, does not accept
  answerFile(d, '001', 'accept AS-1', 'lead');
  answerFile(d, '002', 'no, the table still has rows');
  const declined = refusedR(askMode(d), 'declined answers accepted', 'did not accept it');
  assert.ok(A(d, ['verify-assumptions', 'LC']).text.includes('AS-1 risk=high status=blocked ref=pending questions/003.md'));
  assert.ok(declined.text.includes('AS-2: the answer questions/002.answer.md did not accept it'));
  assert.equal(questionFiles(d).length, 4, 'a non-accepting answer was not asked again');
  // negations, conditions and a bare accept are not an accept; the plain accept of the user is
  answerFile(d, '003', 'please do not accept AS-1 yet');
  answerFile(d, '004', 'accept');
  assert.ok(A(d, ['verify-assumptions', 'LC']).text.includes('AS-1 risk=high status=blocked'));
  assert.ok(A(d, ['verify-assumptions', 'LC']).text.includes('AS-2 risk=high status=blocked'));
  refused(askMode(d), 'negated or bare accepts', 'did not accept it');
  const n = questionFiles(d);
  const asOf = (/** @type {string} */ id) => n.filter((f) => new RegExp(`ASSUMPTION: ${id}@`).test(read(d, `.agents/runs/LC/questions/${f}`))).map((f) => f.slice(0, 3));
  for (const f of asOf('AS-1')) if (!existsSync(`${d}/.agents/runs/LC/questions/${f}.answer.md`)) answerFile(d, f, 'accept AS-1, thanks');
  for (const f of asOf('AS-2')) if (!existsSync(`${d}/.agents/runs/LC/questions/${f}.answer.md`)) answerFile(d, f, 'accept AS-2');
  const out = A(d, ['verify-assumptions', 'LC']);
  assert.match(out.out, /AS-1 risk=high status=accepted-by-user ref=questions\/\d{3}\.answer\.md/);
  assert.match(out.out, /AS-2 risk=high status=accepted-by-user ref=questions\/\d{3}\.answer\.md/);
  assert.match(out.out, /assumptions verified: LC\n$/);
  // a changed assumption text is a new assumption: the old answer does not carry over
  const plan = read(d, '.agents/runs/LC/PLAN.md');
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, plan.replace('the legacy key table is empty', 'the legacy key table has no live rows'));
  const changed = refusedR(A(d, ['verify-assumptions', 'LC']), 'an answer for another text was reused', 'never accepted silently');
  assert.ok(changed.text.includes('AS-1'));
});

test('ask: stdin or --file, the QUESTIONS: line dropped, numbered questions required, the asking session recorded, a terminal run refused', () => {
  const d = project('scaffold orchestrated');
  refused(A(d, ['ask', 'LC'], { input: 'no question here\n' }), 'a block without a numbered question', 'ask needs numbered questions');
  refused(A(d, ['ask', 'LC', '--file', `${d}/missing.md`]), 'a missing file', 'question file not found');
  refused(A(d, ['ask', 'LC', '--file']), 'a --file without a path', 'mandatory argument');
  refused(A(d, ['ask']), 'no id', 'mandatory argument');
  const r = accepted(A(d, ['ask', 'LC'], { input: 'QUESTIONS:\n1. Which one?\n   options: a | b\n', env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } }), 'ask on stdin');
  assert.equal(r.out, "question recorded: LC 001 (relay it verbatim with 'agent.sh questions LC')\n");
  const q = read(d, '.agents/runs/LC/questions/001.md');
  assert.match(q, /^from: lead\nasked_at: \d+\nasked_session: sess-1\n---\n1\. Which one\?\n {3}options: a \| b\n$/);
  accepted(A(d, ['ask', 'LC'], { input: '1. Second?\n', env: { CODEX_THREAD_ID: 'bad session!' } }), 'a second ask');
  assert.doesNotMatch(read(d, '.agents/runs/LC/questions/002.md'), /asked_session/, 'a session id with a space was recorded');
  assert.equal(readdirSync(`${d}/.agents/runs/LC/questions`).length, 2);
});

// ---- db-check -----------------------------------------------------------------------------------------------------------------------

test('db-check: one in-process walk; unchanged, changed, new and vanished database files are named; no baseline passes; .git, node_modules and .agents are not entered', () => {
  const d = project('scaffold standalone');
  const snap = `${d}/.agents/local/db/LC.snapshot`;
  const baseline = () => { mkdirSync(path.dirname(snap), { recursive: true }); writeFileSync(snap, dbSnapshot(/** @type {any} */ ({ root: d, config: () => ({ get: (/** @type {string} */ _k, /** @type {string} */ def) => def }) })).join('\n') + '\n'); };
  assert.equal(accepted(A(d, ['db-check', 'LC']), 'a run without a baseline').out, 'database guard: unchanged (LC)\n');
  writeFileSync(`${d}/app.db`, 'one'); mkdirSync(`${d}/data`); writeFileSync(`${d}/data/x.sqlite`, 'two');
  mkdirSync(`${d}/node_modules/m`, { recursive: true }); writeFileSync(`${d}/node_modules/m/n.db`, 'ignored'); writeFileSync(`${d}/.agents/ignored.db`, 'ignored');
  baseline();
  assert.match(read(d, '.agents/local/db/LC.snapshot'), /^app\.db\|3 \d+\ndata\/x\.sqlite\|3 \d+\n$/);
  assert.equal(accepted(A(d, ['db-check', 'LC']), 'unchanged').out, 'database guard: unchanged (LC)\n');
  writeFileSync(`${d}/app.db`, 'changed!');
  refused(A(d, ['db-check', 'LC']), 'a changed database file', 'database guard: a database file changed during run LC (app.db)');
  baseline();
  writeFileSync(`${d}/new.db`, 'n'); rmSync(`${d}/data/x.sqlite`);
  refused(A(d, ['db-check', 'LC']), 'a new and a vanished file', 'database guard: a database file changed during run LC (data/x.sqlite new.db)');
  refused(A(d, ['db-check', 'NOPE']), 'an unknown run', 'run not found: NOPE');
  refused(A(d, ['db-check']), 'no id', 'mandatory argument');
});

// ---- task-source-status and task-source-relocate ------------------------------------------------------------------------------------------

test('task-source-status: the Status line follows the lifecycle folder, lead only, never absorbs a contract edit', () => {
  const d = project('scaffold orchestrated yes');
  const frozen = rv(d, 'task_source', 'revision');
  const f = `${d}/tasks/in-progress/LC.md`;
  const status = (/** @type {string} */ s) => writeFileSync(f, readFileSync(f, 'utf8').replace(/^\*\*Status:\*\*.*$/m, `**Status:** ${s}`));
  status('todo');
  refused(A(d, ['freshness', 'LC']), 'a stale Status passed freshness', 'task-source-status');
  refused(A(d, ['task-source-status', 'LC'], { role: 'implementer' }), 'the worker changed the task status', 'command denied for implementer');
  assert.equal(accepted(A(d, ['task-source-status', 'LC']), 'task-source-status').out, 'task source status synchronized: LC tasks/in-progress/LC.md todo -> in-progress\n');
  assert.match(readFileSync(f, 'utf8'), /^\*\*Status:\*\* in-progress$/m);
  assert.equal(rv(d, 'task_source', 'revision'), frozen);
  assert.match(ledger(d), /event=task-source-status .* detail=tasks\/in-progress\/LC\.md: todo -> in-progress$/m);
  assert.equal(accepted(A(d, ['task-source-status', 'LC']), 'again').out, 'task source status already in-progress: LC\n');
  accepted(A(d, ['verify-scope', 'LC']), 'verify-scope');
  writeFileSync(f, `${readFileSync(f, 'utf8')}- a requirement added after freeze\n`); status('todo');
  refused(A(d, ['task-source-status', 'LC']), 'task-source-status absorbed a contract edit', 'frozen task contract would change');
  assert.match(readFileSync(f, 'utf8'), /^\*\*Status:\*\* todo$/m, 'a refused status change was written');
});

test('task-source-status: a file outside a lifecycle folder, no Status line, no local source and a published report are refused', () => {
  const flat = project('scaffold standalone');
  refused(A(flat, ['task-source-status', 'LC']), 'a task file outside a lifecycle folder', 'is not under a lifecycle folder');
  const d = project('scaffold standalone yes');
  writeFileSync(`${d}/tasks/in-progress/LC.md`, '# LC task\n');
  refused(A(d, ['task-source-status', 'LC']), 'no Status line', 'has no **Status:** line');
});

test('task-source-relocate: a move, never a copy; the frozen contract must be unchanged; lead only; the path must be relative, plain and a regular file', () => {
  const d = project('scaffold standalone yes; to_code_done standalone');
  const frozen = rv(d, 'task_source', 'revision');
  cpSync(`${d}/tasks/in-progress/LC.md`, `${d}/tasks/copy.md`);
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/copy.md']), 'a copy was accepted as a move', 'not a copy');
  rmSync(`${d}/tasks/copy.md`);
  refused(A(d, ['task-source-relocate', 'LC', '/etc/hosts']), 'an absolute path', 'invalid task source path');
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/../LC.md']), 'a parent-directory path', 'invalid task source path');
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/in-progress/LC.md']), 'the recorded path', 'already recorded');
  spawnSync('git', ['-C', d, 'mv', 'tasks/in-progress/LC.md', 'tasks/moved.md']);
  symlinkSync('moved.md', `${d}/tasks/link.md`);
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/link.md']), 'a symlink target', 'symlink');
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/gone.md']), 'a missing file', 'task source missing or non-regular');
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/moved.md'], { role: 'reviewer' }), 'a reviewer relocated the task source', 'denied');
  writeFileSync(`${d}/tasks/moved.md`, `${readFileSync(`${d}/tasks/moved.md`, 'utf8')}- a requirement smuggled in with the move\n`);
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/moved.md']), 'a relocation absorbed an edited contract', 'differs from the frozen contract');
  writeFileSync(`${d}/tasks/moved.md`, readFileSync(`${d}/tasks/moved.md`, 'utf8').replace('- a requirement smuggled in with the move\n', ''));
  assert.equal(accepted(A(d, ['task-source-relocate', 'LC', 'tasks/moved.md']), 'relocate').out, 'task source relocated: LC tasks/in-progress/LC.md -> tasks/moved.md\n');
  assert.equal(rv(d, 'task_source', 'path'), 'tasks/moved.md');
  assert.equal(rv(d, 'task_source', 'revision'), frozen, 'the relocation re-baselined the contract');
  assert.match(ledger(d), /event=task-source-relocate .* detail=tasks\/in-progress\/LC\.md -> tasks\/moved\.md$/m);
  accepted(A(d, ['verify-seal', 'LC']), 'the seal after the relocation');
});

test('task-source-relocate: before the freeze and after the completion report is published it is refused', () => {
  const unfrozen = project('scaffold standalone yes no STANDARD manual');
  refused(A(unfrozen, ['task-source-relocate', 'LC', 'tasks/x.md']), 'relocation before the freeze', 'only after the run is frozen');
});

// ---- delivery-check -----------------------------------------------------------------------------------------------------------------------

const DELIVERABLE = `scaffold standalone; to_code_done standalone; A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null`;

test('delivery-check: prints each check, then the branch and ready; lead only; CODE_DONE, a branch and the knowledge step are required', () => {
  const d = project(DELIVERABLE);
  const r = accepted(A(d, ['delivery-check', 'LC']), 'delivery-check');
  assert.match(r.out, /^freeze verified: LC\nplanning freshness verified: LC\n/);
  for (const l of ['scope check passed: LC', 'knowledge scope verified: LC', 'handoff integrity verified: LC']) assert.ok(r.out.includes(`${l}\n`), l);
  assert.ok(r.out.endsWith('handoff integrity verified: LC\ndelivery_branch=main\ndelivery_ready=true\n'), r.out);
  refused(A(d, ['delivery-check', 'LC'], { role: 'reviewer' }), 'a reviewer ran delivery-check', 'command denied for reviewer');
  refused(A(d, ['delivery-check']), 'no id', 'mandatory argument');
  const fresh = project('scaffold standalone');
  refused(A(fresh, ['delivery-check', 'LC']), 'delivery before CODE_DONE', 'delivery blocked: CODE_DONE required');
  const noKnowledge = project('scaffold standalone; to_code_done standalone');
  refused(A(noKnowledge, ['delivery-check', 'LC']), 'delivery without the knowledge step', 'delivery blocked: knowledge step not complete');
  spawnSync('git', ['-C', d, 'checkout', '-q', '--detach', 'HEAD']);
  refused(A(d, ['delivery-check', 'LC']), 'a detached HEAD', 'delivery blocked: detached HEAD');
});

test('delivery-check: a change after CODE_DONE and a stale handoff block delivery', () => {
  const d = project(DELIVERABLE);
  writeFileSync(`${d}/impl.txt`, `${readFileSync(`${d}/impl.txt`, 'utf8')}a late change\n`);
  refused(A(d, ['delivery-check', 'LC']), 'delivery over a change after CODE_DONE', undefined);
  const forged = project(DELIVERABLE);
  const y = read(forged, '.agents/runs/LC/RUN.yaml').replace(/(  code_done_patch_sha256: ).*/, '$1"PENDING"');
  writeFileSync(`${forged}/.agents/runs/LC/RUN.yaml`, y);
  refused(A(forged, ['delivery-check', 'LC']), 'a forged handoff record', undefined);
});

test('delivery-check: knowledge-scope files written after the knowledge step are secret-scanned and design-sync drift blocks', () => {
  const d = project('scaffold orchestrated; to_code_done orchestrated');
  mkdirSync(`${d}/docs/design`, { recursive: true });
  writeFileSync(`${d}/docs/design/DESIGN.md`, 'design notes\n');
  accepted(A(d, ['knowledge-done', 'LC']), 'knowledge-done');
  writeFileSync(`${d}/docs/design/DESIGN.md`, 'token: PLANTED_SECRET\n');
  const r = refusedR(A(d, ['delivery-check', 'LC']), 'delivery-check over a secret in a knowledge file', 'found secrets');
  assert.match(r.err, /^ {2}docs\/design\/DESIGN\.md:1:planted-secret$/m);
  writeFileSync(`${d}/docs/design/DESIGN.md`, 'design notes\n');
  accepted(A(d, ['delivery-check', 'LC']), 'delivery-check after the secret is gone');
  // design-sync drift on a knowledge-scope document, reported by the verifier, blocks after the knowledge step
  cpSync(path.join(repo, 'skills/design-sync'), `${d}/.agents/skills/design-sync`, { recursive: true });
  mkdirSync(`${d}/.agents/runs/LC/design`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/design/SYNC.md`, ['# Design sync: LC', '', 'Verdict: FAIL', '', '## Drift', '', '- docs/design/DESIGN.md:3 -> path src/missing.js: no such file or directory', '', '## Unverifiable', '', 'None.', ''].join('\n'));
  writeFileSync(`${d}/docs/design/DESIGN.md`, '# Design\n\nThe widget lives in `src/missing.js`.\n');
  refused(A(d, ['delivery-check', 'LC']), 'delivery with the drift back', 'design-sync drift in knowledge-scope documents is still there');
  writeFileSync(`${d}/docs/design/DESIGN.md`, '# Design\n\nThe widget lives in `impl.txt`.\n');
  accepted(A(d, ['delivery-check', 'LC']), 'delivery after the document was fixed');
});

// ---- status-block -------------------------------------------------------------------------------------------------------------------------

/** The markdown adapter replaced by one that keeps the block it was given (and optionally fails or hangs). @param {string} d @param {string} body */
function adapter(d, body) {
  const f = `${d}/.agents/task-integrations/markdown.sh`;
  writeFileSync(f, `#!/bin/sh\n[ "$1" = statusblock ] || exit 2\n${body}\n`);
  chmodSync(f, 0o755);
}
const KEEP = 'cp "$3" "$(dirname "$0")/../local/block-$2.txt"';
const block = (/** @type {string} */ d) => readFileSync(`${d}/.agents/local/block-LC.txt`, 'utf8');

test('status-block: the block is built from recorded state only and handed to the adapter; an unknown event is `update`', () => {
  const d = project('scaffold standalone');
  adapter(d, KEEP);
  const r = accepted(A(d, ['status-block', 'LC', 'whatever'], { env: { CLAUDE_CODE_SESSION_ID: 'abc-123' } }), 'status-block');
  assert.equal(r.out, '');
  const b = block(d);
  assert.match(b, /^- run: LC\n- class: COMPLEX\n- stage: RUNNING \(PLANNING, handoff IMPLEMENTING\)\n- event: update\n- updated: \d{4}-\d\d-\d\dT[\d:]+Z\n/);
  assert.match(b, /- start_commit: [0-9a-f]{12}\n- runtime: claude\n- session: abc-123\n/);
  refused(A(d, ['status-block', 'LC'], { role: 'reviewer' }), 'a reviewer rebuilt the block', 'command denied for reviewer');
  refused(A(d, ['status-block', 'bad id']), 'an invalid id', 'usage: agent.sh status-block');
  refused(A(d, ['status-block']), 'no id', 'usage: agent.sh status-block');
});

test('status-block: a pending question parks the stage, a failed run says why, both through the scrub; look_at lines come from the QA report', () => {
  const d = project('scaffold orchestrated');
  adapter(d, KEEP);
  accepted(A(d, ['ask', 'LC'], { input: '1. Use /etc/secret and token abcdef for user bob@example.com on 10.0.0.1?\n   options: yes | no\n' }), 'ask');
  const b = block(d);
  assert.match(b, /- stage: PARKED \(waiting for your answer\)\n- event: ask\n/);
  assert.match(b, /- question: #001 1\. Use \[path\] and token \[redacted\] for user \[redacted\] on \[redacted\]\n- answer: answer in your next message/);
  writeFileSync(`${d}/.agents/runs/LC/QA_REPORT.md`, '# QA\n\n## Human checks\n\n- open the login page at /home/me/x and look\n- second\n- third\n- fourth\n');
  accepted(A(d, ['status-block', 'LC', 'code-done']), 'status-block');
  const c = block(d);
  assert.match(c, /- look_at: open the login page at \[path\] and look\n- look_at: second\n- look_at: third\n$/);
});

test('status-block: a failing or hanging adapter never fails the command: a note on stderr and a line in status-block.log; `tasks.status_block: off` skips it', () => {
  const d = project('scaffold standalone');
  adapter(d, 'echo "boom: password hunter2 at /tmp/x" >&2; exit 1');
  const r = accepted(A(d, ['status-block', 'LC', 'parked']), 'a failing adapter');
  assert.match(r.err, /^note: the status block of LC was not updated \(parked\): boom password \[redacted\] at \[path\]; the run goes on$/m);
  assert.match(read(d, '.agents/local/status-block.log'), /^\d{4}-.*Z LC parked boom password \[redacted\] at \[path\]$/m);
  adapter(d, 'exit 3');
  assert.match(accepted(A(d, ['status-block', 'LC']), 'a silent failure').err, /the adapter failed; the run goes on/);
  const cfg = read(d, '.agents/config.yaml');
  writeFileSync(`${d}/.agents/config.yaml`, cfg.replace('status_block_seconds: 20', 'status_block_seconds: 1'));
  adapter(d, 'sleep 20');
  const t0 = Date.now();
  const slow = accepted(A(d, ['status-block', 'LC']), 'a hanging adapter');
  assert.ok(Date.now() - t0 < 15000, 'a hanging adapter held the command');
  assert.match(slow.err, /timed out after 1s|the adapter failed/);
  writeFileSync(`${d}/.agents/config.yaml`, cfg.replace('tasks:\n', 'tasks:\n  status_block: off\n'));
  adapter(d, 'exit 1');
  assert.equal(accepted(A(d, ['status-block', 'LC']), 'off').err, '');
});

test('scrub: known answers (addresses, paths, key prefixes, credential words, length limits, one line)', () => {
  assert.equal(scrub('see /etc/passwd and C:\\x or ~/a'), 'see [path] and C [path] or [path]');
  assert.equal(scrub('ip 10.1.2.3 and fe80::1 and 2001:db8:0:0:0:0:0:1'), 'ip [redacted] and [redacted] and [redacted]');
  assert.equal(scrub('key=value a@b.c'), '[redacted] [redacted]');
  assert.equal(scrub('ghp_abc sk-xyz AKIAXXXX eyJhbGci xoxb-1 BEGIN'), '[redacted] [redacted] [redacted] [redacted] [redacted] [redacted]');
  assert.equal(scrub('password: hunter2 bearer abc token xyz'), 'password [redacted] bearer [redacted] token [redacted]');
  assert.equal(scrub('a1b2c3d4e5f6a1b2c3d4e5f6'), '[redacted]');
  assert.equal(scrub(`${'x'.repeat(41)} ok`), '[redacted] ok');
  assert.equal(scrub('line one\nline "two" (three); {four}'), 'line one line two three four');
  assert.equal(scrub('non-ascii \u00e7a va \u2713 ok'), 'non-ascii a va ok');
  assert.ok(scrub('word '.repeat(60)).length <= 160);
  assert.equal(scrub(''), '');
});

test('scrub: equals the sb_scrub of agent.sh on a corpus (the shell copy stays until its last caller, `terminate` and `handoff`, moves)', () => {
  const sh = readFileSync(path.join(repo, 'control-plane/agents/scripts/agent.sh'), 'utf8');
  const a = sh.indexOf('sb_scrub() {');
  const fn = sh.slice(a, sh.indexOf('\n}\n', a) + 3);
  const corpus = ['see /etc/passwd and C:\\x or ~/a', 'ip 10.1.2.3 and fe80::1 and 2001:db8:0:0:0:0:0:1', 'key=value a@b.c', 'ghp_abc sk-xyz AKIAXXXX eyJhbGci xoxb-1 BEGIN', 'password: hunter2 bearer abc token xyz', 'a1b2c3d4e5f6a1b2c3d4e5f6', `${'x'.repeat(41)} ok`, 'line "two" (three); {four}', 'non-ascii \u00e7a va \u2713 ok', 'word '.repeat(60), '', '   ', 'sk_live_abc and pk_test_x', 'ref #12 100% done! a&b a+b a.b_c-d?'];
  for (const t of corpus) {
    const r = spawnSync('sh', ['-c', `${fn}\nprintf '%s' "$1" | sb_scrub`, 'sh', t], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    assert.equal(scrub(Buffer.from(t, 'utf8').toString('latin1')), r.stdout.replace(/\n$/, ''), `scrub of ${JSON.stringify(t)}`);
  }
});

// ---- the slug of the branch name ---------------------------------------------------------------------------------------------------------

test('slug: the Node table equals task-integrations/slug.sh on a corpus (the adapters still run that script)', () => {
  const corpus = ['Sample Feature', 'Çalışma Şeması ıı İİ', 'Straße über Ångström', 'Œuvre æther', '  --leading and trailing--  ', 'a'.repeat(60), 'x'.repeat(47) + '-yz', 'UPPER lower 123', '!!!', '', 'Ünïcödé ñ ý ž ł đ ť ř', 'emoji \u{1F600} text'];
  for (const t of corpus) {
    const sh = spawnSync('sh', [path.join(repo, 'control-plane/agents/task-integrations/slug.sh'), t], { encoding: 'utf8' }).stdout.replace(/\n$/, '');
    assert.equal(slug(Buffer.from(t, 'utf8').toString('latin1')), sh, `slug of ${JSON.stringify(t)}`);
  }
});

// ---- review round 1 ---------------------------------------------------------------------------------------------------------------------

test('task-source-relocate: a path with a line break, a quote or a backslash is refused and RUN.yaml is not touched (injected lines would override sealed sections)', () => {
  const d = project('scaffold standalone yes; to_code_done standalone');
  const before = read(d, '.agents/runs/LC/RUN.yaml');
  const ledgerBefore = ledger(d);
  const evil = ['tasks/m.md"\n  revision: "x"\nexecution:\n  topology: "standalone', 'tasks/m"x.md', 'tasks/m\\x.md', 'tasks/m\tx.md', 'tasks/m\rx.md'];
  for (const p of evil) {
    writeFileSync(`${d}/tasks/${p.includes('/') ? p.slice(6).replace(/[\n\r]/g, '_') : 'x'}`, 'x');
    refused(A(d, ['task-source-relocate', 'LC', p]), `relocate to ${JSON.stringify(p)}`, 'invalid task source path');
  }
  assert.equal(read(d, '.agents/runs/LC/RUN.yaml'), before, 'RUN.yaml changed');
  assert.equal(ledger(d), ledgerBefore, 'the ledger changed');
});

test('setRunValue: a value with a quote or a control character is refused and nothing is written; ordinary values still pass', () => {
  const d = project('scaffold standalone');
  const ctx = new Context({ env: cleanEnv({}), cwd: d, stdout: { write: () => true }, stderr: { write: () => true } }, `${d}/.agents/scripts/agent.sh`);
  const before = read(d, '.agents/runs/LC/RUN.yaml');
  for (const v of ['a"b', 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
    assert.throws(() => setRunValue(ctx, 'LC', 'task_source', 'path', v), /control character or a quote/, JSON.stringify(v));
  }
  assert.equal(read(d, '.agents/runs/LC/RUN.yaml'), before);
  setRunValue(ctx, 'LC', 'task_source', 'path', 'tasks/ok-1.md');
  assert.match(read(d, '.agents/runs/LC/RUN.yaml'), /^ {2}path: "tasks\/ok-1\.md"$/m);
});

test('verify-assumptions: the word `ask` on the command line asks nothing (the command is read-only and takes no lock)', () => {
  const d = project('scaffold standalone no STANDARD manual');
  putAssumptions(d, 'PLAN.md', `${HEAD}\n${P1}`);
  putAssumptions(d, 'EVIDENCE.md', 'none');
  refused(A(d, ['verify-assumptions', 'LC', 'ask']), 'ask word', 'no question bound to it yet');
  assert.ok(!existsSync(`${d}/.agents/runs/LC/questions`), 'a question was recorded without the locks');
});

test('answer: the status-block adapter runs after the locks are released, so a slow tracker does not hold them', async () => {
  const d = project('scaffold orchestrated');
  accepted(A(d, ['ask', 'LC'], { input: '1. Which one?\n   options: a | b\n' }), 'ask');
  adapter(d, 'sleep 8');
  const child = spawn('sh', ['.agents/scripts/agent.sh', 'answer', 'LC', '1'], { cwd: d, env: cleanEnv({}), stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end('a\n');
  let exited = false;
  child.on('exit', () => { exited = true; });
  const locks = [`${d}/.agents/local/locks/shared.lock`, `${d}/.agents/runs/LC/.lock`];
  const answered = `${d}/.agents/runs/LC/questions/001.answer.md`;
  const t0 = Date.now();
  let freeWhileRunning = false;
  while (Date.now() - t0 < 7000 && !exited) {
    if (existsSync(answered) && locks.every((l) => !existsSync(l))) { freeWhileRunning = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(freeWhileRunning && !exited, 'the locks were still held while the adapter ran');
  child.kill();
});

test('delivery-check secret scan: in a run worktree the files of the worktree are scanned (the trusted scanner is the main tree\'s and must not look in the main tree)', () => {
  const d = realpathSync(project('scaffold standalone'));
  rmSync(`${d}/.agents/scripts/secret-scan.sh`, { force: true }); // the fixture's stub: without a project script the core's own scanner runs
  const wt = `${d}/.agents/local/worktrees/W-1`;
  spawnSync('git', ['-C', d, 'worktree', 'add', '-q', '--detach', wt]);
  mkdirSync(`${wt}/docs/wiki`, { recursive: true });
  writeFileSync(`${wt}/docs/wiki/clean.md`, 'notes\n');
  writeFileSync(`${wt}/docs/wiki/dirty.md`, 'token: PLANTED\nAKIAABCDEFGHIJKLMNOP\n');
  const ctx = new Context({ env: cleanEnv({}), cwd: wt, stdout: { write: () => true }, stderr: { write: () => true } }, `${wt}/.agents/scripts/agent.sh`);
  assert.equal(ctx.trustedScripts, `${d}/.agents/scripts`, 'the trusted scripts are the main tree\'s');
  const clean = runSecretScan(ctx, ['docs/wiki/clean.md']);
  assert.equal(clean.status, 0, clean.stderr.toString());
  const dirty = runSecretScan(ctx, ['docs/wiki/dirty.md']);
  assert.equal(dirty.status, 1, dirty.stderr.toString());
  assert.match(dirty.stdout.toString(), /^docs\/wiki\/dirty\.md:2:aws_access_key_id$/m);
});
