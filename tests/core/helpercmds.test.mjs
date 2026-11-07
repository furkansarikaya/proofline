// @ts-check
// `agent.sh wait-line`, `task-rename-plan|apply` and `test` (A229, the shell functions wait_line, task_rename_* and run_suites of agent.sh), and the build record made
// at handoff IMPLEMENTED (gates-test sc_build_record_auto). Absolute expectations; the real control plane in a throwaway project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll, git, newProject } from './helper-lib.mjs';
import { A, accepted, project, refused, say } from './legacy-lib.mjs';

// ---- wait-line ----------------------------------------------------------------------------------------------------------------------

test('wait-line: the first call for a WHAT starts its clock, the line is `waiting: <what>, <M>m<SS>s so far`, --done stops it, WHAT is cleaned to letters, digits and . _ -', () => {
  const d = newProject();
  const r = accepted(A(d, ['wait-line', 'LC', 'CI of the pull request']), 'wait');
  assert.match(r.out, /^waiting: CI of the pull request, 0m0[0-2]s so far\n$/);
  const clock = `${d}/.agents/local/wait/LC-CI-of-the-pull-request`;
  assert.ok(existsSync(clock), 'the clock file of the wait');
  writeFileSync(clock, `${Math.floor(Date.now() / 1000) - 125}\n`);
  assert.match(A(d, ['wait-line', 'LC', 'CI of the pull request']).out, /^waiting: CI of the pull request, 2m0[5-7]s so far\n$/);
  assert.match(A(d, ['wait-line', 'LC', 'a/b;c', '--done']).out, /^wait over: a b c\n$/);
  assert.equal(A(d, ['wait-line', 'LC', 'CI of the pull request', '--done']).out, 'wait over: CI of the pull request\n');
  assert.ok(!existsSync(clock), '--done removed the clock');
  assert.equal(A(d, ['wait-line', 'LC', '--done']).status, 1, '--done alone needs a dispatch in flight');
  assert.equal(readdirSync(`${d}/.agents/local/wait`).length, 0);
});

test('wait-line: without a WHAT it names the dispatch in flight, and fails when nothing is in flight; a reviewer cannot use it; no run is a failure', async () => {
  const d = newProject();
  const nothing = A(d, ['wait-line', 'LC']);
  assert.equal(nothing.status, 1);
  assert.equal(nothing.err, 'nothing is in flight: name what you wait for, for example agent.sh wait-line LC "CI of the pull request"\n');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    mkdirSync(`${d}/.agents/runs/LC/dispatch`, { recursive: true });
    writeFileSync(`${d}/.agents/runs/LC/dispatch/001-reviewer-claude.running`, `pid=${child.pid}\nrole=reviewer\ntimeout=10000\nstarted_epoch=${Math.floor(Date.now() / 1000)}\n`);
    assert.match(A(d, ['wait-line', 'LC']).out, /^waiting: dispatch reviewer, 0m0[0-2]s so far\n$/);
  } finally { child.kill('SIGKILL'); }
  refused(A(d, ['wait-line', 'LC', 'x'], { role: 'reviewer' }), 'a reviewer', 'command denied for reviewer');
  refused(A(d, ['wait-line', 'NOPE', 'x']), 'no run', 'run not found: NOPE');
  assert.equal(A(d, ['wait-line']).status, 2);
});

// ---- task-rename-plan / task-rename-apply -----------------------------------------------------------------------------------------

/** A project with queued task files in several states. */
function withTasks() {
  const d = newProject();
  const t = `${d}/.agents/tasks`;
  for (const sub of ['todo', 'backlog', 'in-progress']) mkdirSync(`${t}/${sub}`, { recursive: true });
  const mk = (/** @type {string} */ sub, /** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ name, /** @type {string} */ extra = '') => writeFileSync(`${t}/${sub}/${name}.md`, `# Task: ${id} — ${title}\n\n## Goal\n\nIt works.\n${extra}`);
  mk('todo', 'T-1', 'Türkçe başlık ışığı', 'T-1');
  mk('backlog', 'T-2', 'Slug only', 'slug-only');
  mk('todo', 'T-3', 'Already named', 'T-3-already-named');
  mk('todo', 'T-4', 'Started task', 'T-4'); mkdirSync(`${d}/.agents/runs/T-4`, { recursive: true });
  mk('in-progress', 'T-5', 'In progress', 'T-5');
  mk('todo', 'T-6', 'Reported task', 'T-6', '<!-- COMPLETION-REPORT:BEGIN:T-6 -->\n');
  mk('todo', 'T-7', 'Echo', 'T-7-t-7');
  mk('todo', 'T-8', 'Follow up', 'T-8-FU1');
  commitAll(d, 'tasks');
  return d;
}

test('task-rename-plan proposes <ID>-<slug>.md for queued files named by ID or slug only; started, reported, in-progress, already named and follow-up files are never proposed; the user is asked', () => {
  const d = withTasks();
  const r = accepted(A(d, ['task-rename-plan']), 'plan');
  const rows = readFileSync(`${d}/.agents/local/rename/PROPOSAL.tsv`, 'utf8');
  assert.equal(rows, [
    '.agents/tasks/backlog/slug-only.md\t.agents/tasks/backlog/T-2-slug-only.md',
    '.agents/tasks/todo/T-1.md\t.agents/tasks/todo/T-1-turkce-baslik-isigi.md',
    '.agents/tasks/todo/T-7-t-7.md\t.agents/tasks/todo/T-7-echo.md',
    '',
  ].join('\n'));
  assert.ok(r.out.startsWith(rows), r.out);
  assert.match(r.out, /rename/);
  refused(A(d, ['task-rename-plan'], { role: 'reviewer' }), 'a reviewer', 'command denied for reviewer');
});

test('task-rename-apply renames only after the user\'s approval of exactly that proposal, re-checks every row first, uses git mv for tracked files, and the approval is single use', () => {
  const d = withTasks();
  refused(A(d, ['task-rename-apply']), 'no proposal', 'no rename proposal (agent.sh task-rename-plan)');
  accepted(A(d, ['task-rename-plan']), 'plan');
  refused(A(d, ['task-rename-apply']), 'no approval', "renaming task files needs the user's approval");
  say(d, 'approve rename');
  accepted(A(d, ['approve', '-', 'rename']), 'approve');
  // a task that started after the proposal is no longer renamed, and nothing moves
  mkdirSync(`${d}/.agents/runs/T-7`, { recursive: true });
  refused(A(d, ['task-rename-apply']), 'a started task', '.agents/tasks/todo/T-7-t-7.md is no longer a queued task file that needs this rename');
  assert.ok(existsSync(`${d}/.agents/tasks/todo/T-1.md`), 'a refused rename moved a file');
  rmSync(`${d}/.agents/runs/T-7`, { recursive: true });
  const r = accepted(A(d, ['task-rename-apply']), 'apply');
  assert.equal(r.out, [
    'renamed: .agents/tasks/backlog/slug-only.md -> .agents/tasks/backlog/T-2-slug-only.md',
    'renamed: .agents/tasks/todo/T-1.md -> .agents/tasks/todo/T-1-turkce-baslik-isigi.md',
    'renamed: .agents/tasks/todo/T-7-t-7.md -> .agents/tasks/todo/T-7-echo.md',
    '',
  ].join('\n'));
  for (const f of ['backlog/T-2-slug-only', 'todo/T-1-turkce-baslik-isigi', 'todo/T-7-echo']) assert.ok(existsSync(`${d}/.agents/tasks/${f}.md`), f);
  for (const f of ['todo/T-3-already-named', 'todo/T-4', 'in-progress/T-5', 'todo/T-6', 'todo/T-8-FU1']) assert.ok(existsSync(`${d}/.agents/tasks/${f}.md`), `${f} was renamed`);
  assert.match(git(d, ['status', '--porcelain']), /^R {2}\.agents\/tasks\/todo\/T-1\.md -> \.agents\/tasks\/todo\/T-1-turkce-baslik-isigi\.md$/m, 'a tracked file moves with git mv');
  refused(A(d, ['task-rename-apply']), 'single use', 'no rename proposal');
});

test('task-rename-plan with nothing to rename says so and removes an old proposal', () => {
  const d = withTasks();
  accepted(A(d, ['task-rename-plan']), 'plan');
  say(d, 'approve rename'); accepted(A(d, ['approve', '-', 'rename']), 'approve'); accepted(A(d, ['task-rename-apply']), 'apply');
  const r = accepted(A(d, ['task-rename-plan']), 'again');
  assert.equal(r.out, 'task-rename: every queued task file is already named <ID>-<slug>.md\n');
  assert.ok(!existsSync(`${d}/.agents/local/rename/PROPOSAL.tsv`));
});

// ---- test ---------------------------------------------------------------------------------------------------------------------------

test('test runs every sibling *-test.sh of the scripts folder in order, announces each, stops at the first failure with its status, and is the lead\'s', () => {
  const d = newProject();
  const dir = `${d}/.agents/scripts`;
  writeFileSync(`${dir}/a-test.sh`, 'echo ran-a\n');
  writeFileSync(`${dir}/b-test.sh`, 'echo ran-b >&2; exit 7\n');
  writeFileSync(`${dir}/c-test.sh`, 'echo ran-c\n');
  const r = A(d, ['test']);
  assert.equal(r.status, 7);
  assert.equal(r.out, '== a-test.sh\nran-a\n== b-test.sh\n');
  assert.equal(r.err, 'ran-b\n');
  rmSync(`${dir}/b-test.sh`);
  const ok = A(d, ['test']);
  assert.equal(ok.status, 0);
  assert.equal(ok.out, '== a-test.sh\nran-a\n== c-test.sh\nran-c\n');
  refused(A(d, ['test'], { role: 'reviewer' }), 'a reviewer', 'command denied for reviewer');
  rmSync(`${dir}/a-test.sh`); rmSync(`${dir}/c-test.sh`);
  assert.equal(A(d, ['test']).out, '', 'no suite: nothing to run');
});

// ---- the build record at handoff IMPLEMENTED (gates-test sc_build_record_auto) -------------------------------------------------------

test('handoff IMPLEMENTED makes the build record (the lead\'s missing step otherwise); next names a missing record as the first step and drops it once made', () => {
  const d = project(`scaffold standalone no STANDARD manual; sed -i.bak 's|^  build:.*|  build: echo built-line|; s|^  test:.*|  test: echo tested-line|' .agents/config.yaml && rm -f .agents/config.yaml.bak; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null; solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null`);
  const shown = A(d, ['build-record', 'LC', 'show']);
  assert.equal(shown.status, 0, `handoff IMPLEMENTED did not make the build record: ${shown.text}`);
  assert.match(shown.out, /^ {2}tested-line$/m);
  rmSync(`${d}/.agents/local/builds`, { recursive: true });
  const first = (/** @type {string} */ out) => (/^next=(.*)$/m.exec(out) ?? [])[1] ?? '';
  const nx = A(d, ['next', 'LC']).out;
  assert.equal(first(nx), 'agent.sh build-record LC run   (the build record is missing for this tree: make it before the review gates; reviewers and the verifier read it)');
  accepted(A(d, ['build-record', 'LC', 'run']), 'run');
  assert.ok(!A(d, ['next', 'LC']).out.includes('build-record'), 'next still names the build record after it was made');
});
