// @ts-check
// Stage 4, package 4B: `start`, `terminate`, `cleanup`, `amend`, `reopen` and the lock hand-over to a child as absolute Node tests (A213). They replace the
// behaviour of lifecycle-test.sh scenario_terminal, scenario_cleanup_after_hook_lines, scenario_failed_run_cleanup, scenario_amend_plan_change and
// scenario_reopen_failed (tests/legacy-port-map.tsv); the shell scenarios themselves keep running against the Node commands through the fixture prologue.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, approveAsUser, project, read, refused } from './legacy-lib.mjs';

/** The fixture installs a two-operation stub of the markdown adapter (a project script wins); `start` runs the built-in one, so the stub is removed. @param {string} d */
const withAdapter = (d) => { rmSync(`${d}/.agents/task-integrations/markdown.sh`, { force: true }); return d; };
const BODY = '## Goal\n\nLook the stored value up.\n\n## Context\n\nThe store has no lookup yet.\n\n## Acceptance criteria\n\n- AC-1: lookup returns the stored value\n\n## Out of scope\n\n- the store format\n\n## Constraints\n\nnone\n\n## Risks\n\nnone\n\n## Suggested class\n\nSTANDARD\n';
const runValue = (/** @type {string} */ d, /** @type {string} */ s, /** @type {string} */ k, id = 'LC') => {
  const m = new RegExp(`^${s}:\\n(?:  .*\\n)*?  ${k}: "?([^"\\n]*)"?$`, 'm').exec(read(d, `.agents/runs/${id}/RUN.yaml`));
  return m ? m[1] : '';
};
const REASON = 'reason: the verification toolchain is unavailable in this environment\nevidence: go test exited 127 because the go binary is missing\n';

test('start: a task from stdin becomes a run (RUN.yaml, TASK.md, ACTIVE_RUN, ledger line), a second open run is refused', () => {
  const d = withAdapter(project('new_repo'));
  const r = accepted(A(d, ['start', 'ST-1', '--title', 'Lookup'], { input: BODY }), 'start');
  assert.match(r.out, /^run started: ST-1 task=\S+$/m);
  assert.equal(runValue(d, 'task', 'id', 'ST-1'), 'ST-1');
  assert.equal(runValue(d, 'task_source', 'type', 'ST-1'), 'local_markdown');
  assert.match(runValue(d, 'task_source', 'path', 'ST-1'), /^\.agents\/tasks\/in-progress\/ST-1-lookup\.md$/);
  assert.equal(read(d, '.agents/local/ACTIVE_RUN'), 'ST-1\n');
  assert.ok(read(d, '.agents/runs/ST-1/TASK.md').includes('AC-1: lookup returns the stored value'));
  assert.match(read(d, '.agents/runs/ST-1/LEDGER.log').split('\n')[0], /^seq=1 prev=genesis event=start role=lead from=- to=PLANNED .* detail=task=\S+ adapter=markdown measure=1$/);
  refused(A(d, ['start', 'ST-2', '--title', 'Other'], { input: BODY }), 'a second open run', 'another open run exists in this worktree');
  assert.ok(!existsSync(`${d}/.agents/runs/ST-2`), 'the refused start left a run folder');
});

test('start: a bad id, an unknown option, a non-lead, a missing title and a task file outside tasks.dir are refused before anything is written', () => {
  const d = withAdapter(project('new_repo'));
  for (const id of ['-x', 'a..b', 'a/b', 'a b']) refused(A(d, ['start', id, '--title', 'T'], { input: BODY }), `id ${id}`, 'invalid task id');
  refused(A(d, ['start', 'ST-1', '--bogus', 'x'], { input: BODY }), 'an unknown option', 'unknown start option: --bogus');
  refused(A(d, ['start', 'ST-1', '--title'], { input: BODY }), 'an option without a value', 'start option needs a value');
  refused(A(d, ['start', 'ST-1', '--title', 'T'], { input: BODY, role: 'reviewer' }), 'a non-lead', 'command denied for reviewer: start');
  const m = A(d, ['start', 'ST-1'], { input: BODY });
  assert.equal(m.status, 3, 'a task without a title exits 3');
  assert.equal(m.out, 'MISSING title\n');
  refused(A(d, ['start', 'ST-1', '--task-file', '/etc/passwd']), 'a task file outside tasks.dir', 'task file must be under tasks.dir');
  refused(A(d, ['start', 'ST-1', '--task-file', '.agents/tasks/../x.md']), 'a task file with ..', 'invalid task path');
  refused(A(d, ['start', 'ST-1', '--task-file', '.agents/tasks/ST-1.md']), 'a missing task file', 'task file missing');
  assert.ok(!existsSync(`${d}/.agents/runs/ST-1`) && !existsSync(`${d}/.agents/local/ACTIVE_RUN`), 'a refused start wrote state');
});

test('start: a path from the task adapter with a line break or a quote never reaches RUN.yaml (injection)', () => {
  const d = withAdapter(project('new_repo'));
  writeFileSync(`${d}/.agents/task-integrations/markdown.sh`, '#!/bin/sh\ncase "$1" in create) printf \'tasks/x.md\\nexecution:\\n  state: DONE\\n\' ;; esac\n');
  const r = A(d, ['start', 'ST-9', '--title', 'T'], { input: BODY });
  refused(r, 'a multi-line adapter path', 'control character');
  assert.ok(!existsSync(`${d}/.agents/runs/ST-9`), 'a run folder was made for a poisoned path');
});

test('terminate: BLOCKED needs a specific reason and evidence, FAILED needs exhausted fix rounds, only the lead; a terminal run takes nothing more', () => {
  const d = project('scaffold standalone');
  const t = (/** @type {string} */ outcome, /** @type {string} */ input = REASON, /** @type {string} */ role = 'lead') => A(d, ['terminate', 'LC', outcome], { input, role });
  refused(t('FAILED'), 'FAILED while fix rounds remain', 'FAILED requires the fix rounds to be exhausted');
  refused(t('BLOCKED', 'reason: no\nevidence: go test exited 127 because the go binary is missing\n'), 'a short reason', 'terminate requires a specific reason');
  refused(t('BLOCKED', 'reason: the verification toolchain is unavailable in this environment\nevidence: n/a\n'), 'a generic evidence', 'terminate requires the evidence');
  refused(t('BLOCKED', REASON, 'qa'), 'a non-lead', 'command denied for qa: terminate');
  refused(t('DONE'), 'an unknown outcome', 'invalid outcome: DONE');
  accepted(t('BLOCKED'), 'terminate BLOCKED');
  assert.equal(runValue(d, 'execution', 'state'), 'BLOCKED');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=terminate role=lead from=PLANNING to=BLOCKED .* detail=reason: the verification toolchain/);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a terminal run accepted a handoff', 'terminal');
  refused(t('FAILED'), 'a terminal run terminated again', 'terminal');
  assert.ok(existsSync(`${d}/.agents/local/metrics/records.jsonl`), 'no run record in the metrics');
});

test('cleanup: a BLOCKED run is archived and removed with its assignments, ACTIVE_RUN cleared; an assignments symlink or file keeps the run; archive.keep bounds the archive', () => {
  const d = project('scaffold standalone');
  refused(A(d, ['cleanup', 'LC']), 'cleanup of a run that is neither DONE nor terminal', 'cleanup requires handoff DONE');
  accepted(A(d, ['terminate', 'LC', 'BLOCKED'], { input: REASON }), 'terminate');
  mkdirSync(`${d}/.agents/local/outside-target`, { recursive: true });
  writeFileSync(`${d}/.agents/local/outside-target/keep`, '');
  mkdirSync(`${d}/.agents/local/assignments`, { recursive: true });
  symlinkSync(`${d}/.agents/local/outside-target`, `${d}/.agents/local/assignments/LC`);
  refused(A(d, ['cleanup', 'LC']), 'cleanup followed a symlinked assignments directory', 'not a plain assignments directory');
  assert.ok(existsSync(`${d}/.agents/local/outside-target/keep`) && existsSync(`${d}/.agents/runs/LC`), 'the guard removed something');
  rmSync(`${d}/.agents/local/assignments/LC`);
  mkdirSync(`${d}/.agents/local/assignments/LC`, { recursive: true });
  writeFileSync(`${d}/.agents/local/assignments/LC/a.md`, '');
  mkdirSync(`${d}/.agents/local/archive/OLD-1`, { recursive: true });
  writeFileSync(`${d}/.agents/local/archive/OLD-1/x`, '');
  utimesSync(`${d}/.agents/local/archive/OLD-1`, 946684800, 946684800);
  const cfg = read(d, '.agents/config.yaml');
  assert.match(cfg, /^  keep: 10$/m, 'the config has no archive.keep');
  writeFileSync(`${d}/.agents/config.yaml`, cfg.replace(/^ {2}keep: 10$/m, '  keep: 1'));
  const r = accepted(A(d, ['cleanup', 'LC']), 'cleanup of a BLOCKED run');
  assert.match(r.out, /^evidence archived: \.agents\/local\/archive\/LC\/LC-\d{8}T\d{6}Z\.tar\.gz \(the newest 1 runs are kept\)$/m);
  assert.match(r.out, /^run cleaned up: LC /m);
  assert.ok(!existsSync(`${d}/.agents/runs/LC`) && !existsSync(`${d}/.agents/local/assignments/LC`));
  assert.equal(read(d, '.agents/local/ACTIVE_RUN'), '');
  assert.ok(readdirSync(`${d}/.agents/local/archive/LC`).some((n) => n.endsWith('.tar.gz')), 'no evidence archive');
  assert.ok(!existsSync(`${d}/.agents/local/archive/OLD-1`), 'archive.keep: 1 kept an older run');
  const tar = spawnSync('tar', ['-tzf', `${d}/.agents/local/archive/LC/${readdirSync(`${d}/.agents/local/archive/LC`)[0]}`], { encoding: 'utf8' });
  assert.match(tar.stdout, /^LC\/RUN\.yaml$/m);
});

test('cleanup: a terminal run whose last ledger line is not its terminate (a hand edit) is refused; hook lines after the terminate do not matter', () => {
  const d = project('scaffold standalone');
  writeFileSync(`${d}/.agents/local/hook-times`, '1|posttool|12|ok|\n2|stop|900|timeout|slow\n');
  accepted(A(d, ['hook-time', 'LC']), 'hook-time');
  refused(A(d, ['cleanup', 'LC']), 'hook lines alone are not a terminate', 'cleanup requires handoff DONE');
  accepted(A(d, ['terminate', 'LC', 'BLOCKED'], { input: REASON }), 'terminate');
  writeFileSync(`${d}/.agents/local/hook-times`, '4|posttool|15|ok|\n');
  accepted(A(d, ['hook-time', 'LC']), 'hook-time after the terminate');
  accepted(A(d, ['cleanup', 'LC']), 'cleanup after hook lines');
  assert.ok(!existsSync(`${d}/.agents/runs/LC`));
});

test('a child of a lock-holding command takes the locks over (no wait, no early release); the take-over proves nothing else', () => {
  const d = project('scaffold standalone');
  accepted(A(d, ['terminate', 'LC', 'BLOCKED'], { input: REASON }), 'terminate');
  // a parent that holds the shared lock (as deliver-step does) starts the child: it is not waited for and the parent's pid file stays. The parent is a Node process on every platform
  // (A267): the core compares the pid file with its parent's WINDOWS pid, and an MSYS shell's `$$` is another number there, so the shell parent of the first form read as a dead holder.
  const parent = "const fs = require('node:fs'); const cp = require('node:child_process'); const lock = '.agents/local/locks/shared.lock';"
    + "fs.mkdirSync(lock); fs.writeFileSync(lock + '/pid', process.pid + '\\n');"
    + "const r = cp.spawnSync('sh', ['.agents/scripts/agent.sh', 'cleanup', 'LC'], { env: { ...process.env, PROOFLINE_LOCK_TIMEOUT: '3' }, stdio: 'inherit' });"
    + "const mine = fs.readFileSync(lock + '/pid', 'utf8').trim() === String(process.pid); fs.rmSync(lock, { recursive: true, force: true }); process.exit(mine ? r.status : 90);";
  const r = spawnSync(process.execPath, ['-e', parent], { cwd: d, encoding: 'utf8', timeout: 60000 });
  if (process.platform === 'win32') {
    // ACCEPTED LIMIT (A267), proved by the Windows probe: `sh agent.sh` is a launcher that runs node as ITS child, so the core's parent is the launcher, not the holder, and the hand-over is not
    // recognised. The child therefore waits for a lock whose holder is alive and fails at the timeout: closed, never a take-over, and the holder's pid file stays (exit 90 would be a changed file).
    assert.notEqual(r.status, 90, 'the holder\'s pid file was changed');
    assert.notEqual(r.status, 0, 'a child of the holder took the lock over: the limit is gone, make this branch the POSIX one');
    assert.match(`${r.stdout}${r.stderr}`, /lock timeout after 3s/);
    return;
  }
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^run cleaned up: LC /m);
});

test('a lock held by a stranger is still waited for (the hand-over is for the parent only)', () => {
  const d = project('scaffold standalone');
  // the holder is a live process that is not our parent; its WINDOWS pid is the one in the pid file (an MSYS shell's `$!` is not one, A267)
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  try {
    const pid = /** @type {number} */ (holder.pid);
    mkdirSync(`${d}/.agents/local/locks/shared.lock`, { recursive: true });
    writeFileSync(`${d}/.agents/local/locks/shared.lock/pid`, `${pid}\n`);
    assert.doesNotThrow(() => process.kill(pid, 0), 'premise: the holder is alive');
    const r = A(d, ['terminate', 'LC', 'BLOCKED'], { input: REASON, env: { PROOFLINE_LOCK_TIMEOUT: '1' } });
    refused(r, 'a stranger\'s lock was taken over', 'lock timeout after 1s');
  } finally { holder.kill(); }
});

test('amend: reopens a CODE_DONE run with a specific form; a path outside the frozen scope needs plan_change; the record, the states and the ledger follow', () => {
  const d = project('scaffold standalone; to_code_done standalone; finish_done');
  const form = (/** @type {string} */ extra = '') => `reason: the review found a missing helper file the plan did not cover\nfix_scope: ${extra || 'impl.txt'}\nfix_instruction: add the helper and cover it with a test of its own\nauthorized_by: the user\n`;
  refused(A(d, ['amend', 'LC'], { input: 'reason: short\n' }), 'a short form', 'amend requires a specific reason');
  refused(A(d, ['amend', 'LC'], { input: form().replace('authorized_by: the user', 'authorized_by: x') }), 'a missing authority', 'amend requires authorized_by');
  refused(A(d, ['amend', 'LC'], { input: form('extra.txt') }), 'a path outside the plan', 'fix_scope names a path outside the frozen scope: extra.txt');
  refused(A(d, ['amend', 'LC'], { input: form(), role: 'reviewer' }), 'a non-lead', 'command denied for reviewer: amend');
  const r = accepted(A(d, ['amend', 'LC'], { input: form() }), 'amend');
  assert.match(r.out, /^run reopened: LC \(\d{3}-REOPEN\); handoff IMPLEMENTING, execution AMENDING/m);
  assert.equal(runValue(d, 'execution', 'state'), 'AMENDING');
  assert.equal(runValue(d, 'handoff', 'state'), 'IMPLEMENTING');
  assert.equal(runValue(d, 'handoff', 'implemented_patch_sha256'), 'PENDING');
  assert.equal(runValue(d, 'completion_report', 'published'), 'false');
  const rec = read(d, `.agents/runs/LC/gates/${readdirSync(`${d}/.agents/runs/LC/gates`).filter((n) => n.endsWith('-REOPEN.yaml'))[0]}`);
  assert.match(rec, /^gate: "REOPEN"$/m);
  assert.match(rec, /^previous_execution_state: "CODE_DONE"$/m);
  assert.match(rec, /^fix_scope: impl\.txt$/m);
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=REOPEN role=lead from=DONE to=IMPLEMENTING .* authorized_by=the user: the review found/);
  refused(A(d, ['amend', 'LC'], { input: form() }), 'amend of an AMENDING run', 'amend reopens a CODE_DONE/DONE run only');
});

test('reopen: a FAILED or BLOCKED run needs the user\'s approval of exactly the frozen plan; then it returns to its earlier state and the approval is consumed', () => {
  const d = project('scaffold standalone');
  accepted(A(d, ['terminate', 'LC', 'BLOCKED'], { input: REASON }), 'terminate');
  const reason = 'reason: the toolchain is installed now, the blocker is gone for good\n';
  refused(A(d, ['reopen', 'LC'], { input: 'reason: no\n' }), 'a short reason', "reopen requires a specific 'reason:'");
  refused(A(d, ['reopen', 'LC'], { input: reason, role: 'qa' }), 'a non-lead', 'command denied for qa: reopen');
  refused(A(d, ['reopen', 'LC'], { input: reason }), 'reopen without the approval', "reopen LC needs the user's approval");
  assert.equal(runValue(d, 'execution', 'state'), 'BLOCKED');
  approveAsUser(d, 'reopen:LC', 'approve reopen LC');
  const r = accepted(A(d, ['reopen', 'LC'], { input: reason }), 'reopen with the approval');
  assert.match(r.out, /^run reopened: LC \(\d{3}-REOPEN\); execution BLOCKED -> PLANNING, /m);
  assert.equal(runValue(d, 'execution', 'state'), 'PLANNING');
  refused(A(d, ['reopen', 'LC'], { input: reason }), 'reopen of a run that is open', 'reopen takes a FAILED or BLOCKED run only');
});
