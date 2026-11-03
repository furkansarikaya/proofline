// @ts-check
// Stage 6 (A215): deliver-plan, the summary, the platforms, task-source-done, and the real commit and push through the git hooks (deliver-test.sh scenarios
// content_change_stops, failed_refused, reopened_run_delivers, task_moves_to_done, task_move_skipped, summary_warns_without_ci, platforms, task_done_noop,
// one_approval_real_chain, partial_reply_recovers, cleanup_crash_keeps_merged).
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync as wf } from 'node:fs';
import { test } from 'node:test';
import { A, DONE, TASKS_IN_TASKS, accepted, approveDelivery, commitDelivery, existsSync, fakeGh, fakeTool, g, gOk, hooks, pushed, readFileSync, refused, run, say, verbs } from './run6-lib.mjs';
import { approveAsUser, project } from './legacy-lib.mjs';

const S = (/** @type {string} */ d, /** @type {Record<string, string>} */ env, /** @type {string[]} */ ...a) => A(d, ['deliver-step', 'LC', ...a], { env });
const read = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(`${d}/${f}`, 'utf8');
const WORKERS = "worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'";
const WORKFLOW = `SC_BRANCH=1 SC_SCOPE_NAMED=.github/workflows/ci.yml scaffold orchestrated yes; ${TASKS_IN_TASKS}; ${WORKERS}; worker GREEN pass .github/workflows/ci.yml 'on: pull_request'; A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; finish_done`;
const FAILED = "export SC_BRANCH=1 SC_TEST_CRIT=AC-2 SC_TASK_EXTRA='- AC-2: second behavior'; scaffold orchestrated; unset SC_BRANCH SC_TEST_CRIT SC_TASK_EXTRA; "
  + `${WORKERS}; A handoff LC IMPLEMENTED >/dev/null; gfail REVIEW_SMALL impl_test.txt; A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl_test.txt 'test: default for an empty key'; `
  + "A handoff LC IMPLEMENTED >/dev/null; gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null; gfail VERIFY impl.txt; "
  + "printf 'reason: the empty-key contract cannot be met within the frozen plan scope\\nevidence: gates/*-VERIFY.yaml fail on the third content\\n' | A terminate LC FAILED >/dev/null";

test('a changed file, message or an extra commit after the approval stops the chain', () => {
  const gh = fakeGh();
  const d = project(DONE);
  hooks(d);
  accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan');
  approveDelivery(d);
  wf(`${d}/late.txt`, 'late\n');
  refused(S(d, gh.env, 'commit'), 'a changed file after the approval', 'the content changed since the approved summary');
  rmSync(`${d}/late.txt`);
  wf(`${d}/.agents/local/deliver/LC/COMMIT_MSG`, 'chore: other\n');
  refused(S(d, gh.env, 'commit'), 'a changed commit message', 'commit message or the pull request body changed');
  wf(`${d}/.agents/local/deliver/LC/COMMIT_MSG`, 'feat: lookup (LC)\n');
  accepted(S(d, gh.env, 'commit'), 'commit');
  commitDelivery(d);
  gOk(d, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'chore: extra');
  refused(S(d, gh.env, 'push'), 'a new commit after the approval', 'HEAD is not the one delivery commit');
});

test('a FAILED run is refused with the reopen command; no summary is written', () => {
  const d = project(FAILED);
  hooks(d);
  refused(A(d, ['deliver-plan', 'LC']), 'deliver-plan of the FAILED run', 'to reopen: /proofline reopen LC');
  accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done');
  refused(A(d, ['deliver-plan', 'LC']), 'after the knowledge step too', 'to reopen: /proofline reopen LC');
  assert.ok(!existsSync(`${d}/.agents/local/deliver`), 'a refused delivery wrote a summary');
});

test('a reopened run reaches CODE_DONE and is delivered with the one approval', () => {
  const gh = fakeGh();
  const d = project(`${FAILED}; unset SC_BRANCH`);
  hooks(d);
  refused(A(d, ['deliver-plan', 'LC']), 'a FAILED run', 'to reopen: /proofline reopen LC');
  approveAsUser(d, 'reopen:LC', 'I approve the reopen of LC');
  accepted(A(d, ['reopen', 'LC'], { input: 'reason: the verifier false alarm is fixed and the budget decided\n' }), 'reopen');
  accepted(verbs(d, 'pass_all; A handoff LC CODE_DONE >/dev/null'), 'to CODE_DONE');
  assert.match(accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan').out, /not ready to summarize/);
  assert.ok(!existsSync(`${d}/.agents/local/deliver/LC`));
  accepted(verbs(d, "finish_done '' '## Reopen History' 'Reopened once with the user approval after a FAILED verify gate.'"), 'finish_done');
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan').out;
  assert.match(plan, /^steps: commit push pr merge cleanup$/m);
  approveDelivery(d);
  accepted(S(d, gh.env, 'commit'), 'the one approval carries the commit step');
});

test('the task file moves to done/ inside the delivery commit (one copy), the chain accepts it, the merge step says where it is done; a skipped move stops the chain', () => {
  const gh = fakeGh();
  const d = project(WORKFLOW);
  hooks(d);
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan').out;
  assert.match(plan, /^task_done: tasks\/in-progress\/LC.md -> tasks\/done\/LC.md$/m);
  assert.match(plan, /moves it to done\//);
  assert.ok(!plan.includes('no CI check runs'), 'the summary warns about CI although a workflow exists');
  approveDelivery(d);
  assert.match(accepted(S(d, gh.env, 'commit'), 'commit').out, /^run: sh \.agents\/scripts\/agent\.sh task-source-done LC$/m);
  // skipping the printed line stops the chain at push and pr
  const skipped = project(WORKFLOW);
  hooks(skipped);
  accepted(A(skipped, ['deliver-plan', 'LC']), 'plan');
  approveDelivery(skipped);
  gOk(skipped, 'add', '-A');
  assert.equal(run(skipped, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0);
  refused(S(skipped, gh.env, 'push'), 'push with the task file left in in-progress/', 'the task file is not in tasks/done/LC.md');
  pushed(skipped);
  refused(S(skipped, gh.env, 'pr'), 'pr with the task file left in in-progress/', 'the task file is not in tasks/done/LC.md');
  // the move itself
  const td = accepted(A(d, ['task-source-done', 'LC']), 'task-source-done');
  assert.equal(td.out, 'tasks/done/LC.md\n');
  assert.ok(!existsSync(`${d}/tasks/in-progress/LC.md`) && existsSync(`${d}/tasks/done/LC.md`), 'the task file is not only under done/');
  assert.match(read(d, 'tasks/done/LC.md'), /^\*\*Status:\*\* done$/m);
  assert.equal(accepted(A(d, ['task-source-done', 'LC']), 'second move').out, '', 'a second move printed something (not idempotent)');
  gOk(d, 'add', '-A');
  assert.equal(run(d, 'git', ['commit', '-qF', '.agents/local/deliver/LC/COMMIT_MSG']).status, 0, 'the commit with the moved task file was blocked');
  assert.match(g(d, 'show', '--stat', '--format=', 'HEAD'), /LC\.md/);
  assert.equal(g(d, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l !== '' && !/^.. \.agents\//.test(l)).length, 0, 'dirty after the commit');
  assert.match(accepted(S(d, gh.env, 'push'), 'push').out, /^run: git push -u origin proofline\/LC-lookup$/m);
  pushed(d);
  accepted(S(d, gh.env, 'pr'), 'pr');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  assert.match(accepted(S(d, gh.env, 'merge', '7'), 'merge').out, /moved to done\/ only in the unmerged pull request branch/);
  gh.says('MERGED', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh.env, 'cleanup', '7'), 'cleanup after the moved task file');
});

test('task-source-done leaves other adapters alone', () => {
  const d = project(`${DONE}; sed 's/^  adapter: markdown/  adapter: github/' .agents/config.yaml > .agents/cfg.tmp && cp .agents/cfg.tmp .agents/config.yaml && rm .agents/cfg.tmp`);
  assert.equal(accepted(A(d, ['task-source-done', 'LC']), 'task-source-done').out, '');
  assert.ok(existsSync(`${d}/tasks/LC.md`));
});

test('the summary warns without a pull_request workflow, the pull request body says "verified locally, no CI", and a re-plan drops the old pull request number', () => {
  const d = project(DONE);
  hooks(d);
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan').out;
  assert.match(plan, /WARNING: no CI check runs on pull requests here\. proofline merge verifies the commit locally instead/);
  assert.match(plan, /^ {2}fix: \/proofline task Add a GitHub Actions workflow/m);
  const sum = read(d, '.agents/local/deliver/LC/SUMMARY.md');
  assert.match(sum, /^platform: github$/m);
  assert.match(sum, /^ci: verified locally, no CI$/m);
  assert.match(read(d, '.agents/local/deliver/LC/PR_BODY.md'), /verified locally, no CI/);
  wf(`${d}/.agents/local/deliver/LC/PR`, '7\n');
  accepted(A(d, ['deliver-plan', 'LC']), 'a re-plan');
  assert.ok(!existsSync(`${d}/.agents/local/deliver/LC/PR`), 'a re-plan kept the old pull request number');
});

test('the platform picks the steps: bitbucket and an unrecognized host have no merge step (the user merges); gitlab needs glab', () => {
  const d = project(DONE);
  hooks(d);
  const sumOf = () => read(d, '.agents/local/deliver/LC/SUMMARY.md');
  gOk(d, 'remote', 'set-url', 'origin', 'https://bitbucket.org/acme/app.git');
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan on bitbucket').out;
  assert.match(sumOf(), /^steps: commit push pr$/m);
  assert.match(sumOf(), /^merge_by: user$/m);
  assert.match(plan, /YOU open it and YOU merge it/);
  assert.match(plan, /bitbucket\.org\/acme\/app\/pull-requests\/new/);
  gOk(d, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
  accepted(A(d, ['deliver-plan', 'LC']), 'gitlab');
  assert.match(sumOf(), /^merge_by: user$/m, 'gitlab without glab on PATH must be manual');
  const glab = fakeTool('glab');
  accepted(A(d, ['deliver-plan', 'LC'], { env: { PATH: `${glab}:${process.env.PATH}` } }), 'gitlab with glab');
  assert.match(sumOf(), /^tool: glab$/m);
  assert.match(sumOf(), /^steps: commit push pr merge cleanup$/m);
  assert.equal(A(d, ['platform']).out.split('\n')[0], 'platform: gitlab');
});

test('one reply is recorded in step order; the real commit and push run through the git hooks on it; a reply recorded in part is completed by the same reply once more', () => {
  const gh = fakeGh();
  const d = project(WORKFLOW);
  hooks(d);
  const bare = `${d}-remote.git`;
  gOk(d, 'init', '-q', '--bare', bare);
  gOk(d, 'config', 'remote.origin.pushurl', bare);
  accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan');
  approveDelivery(d);
  let prev = 0;
  for (const k of ['commit', 'push', 'pr', 'merge', 'cleanup']) {
    const f = requireNames(d).find((n) => n.endsWith(`-${k}.yaml`) && !n.includes('request'));
    assert.ok(f, `no ${k} approval from the one reply`);
    const n = Number(f.slice(0, 3));
    assert.ok(n > prev, `the ${k} approval is not recorded after the step before it`);
    prev = n;
  }
  accepted(S(d, gh.env, 'commit'), 'commit');
  commitDelivery(d);
  accepted(S(d, gh.env, 'push'), 'push step after the foreseen commit');
  const push = run(d, 'git', ['push', '-u', 'origin', 'proofline/LC-lookup']);
  assert.equal(push.status, 0, `git push after the foreseen commit: ${push.text}`);
  accepted(S(d, gh.env, 'pr'), 'pr step');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh.env, 'merge', '7'), 'merge step');
  gh.says('MERGED', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh.env, 'cleanup', '7'), 'cleanup step');
  // a reply recorded in part
  const p = project(DONE);
  hooks(p);
  const bare2 = `${p}-remote.git`;
  gOk(p, 'init', '-q', '--bare', bare2);
  gOk(p, 'config', 'remote.origin.pushurl', bare2);
  accepted(A(p, ['deliver-plan', 'LC']), 'plan');
  say(p, 'approve delivery');
  accepted(A(p, ['approve', 'LC', 'commit']), 'approve commit only');
  accepted(S(p, gh.env, 'commit'), 'commit');
  commitDelivery(p);
  refused(S(p, gh.env, 'push'), 'a push whose approval the cut-off hook never recorded', 'recorded only in part');
  refused(S(p, gh.env, 'push'), 'that refusal', 'do not prepare it again');
  approveDelivery(p);
  accepted(S(p, gh.env, 'push'), 'push after the repeated reply');
  assert.equal(run(p, 'git', ['push', '-u', 'origin', 'proofline/LC-lookup']).status, 0);
  refused(S(p, gh.env, 'push'), 'a second push on the used approval', 'was already used');
  accepted(S(p, gh.env, 'pr'), 'pr step after the repeated reply');
});

test('the merge is recorded in merged.tsv before the cleanup, so a crash in between leaves the task merged', { skip: process.getuid?.() === 0 }, () => {
  const gh = fakeGh();
  const d = project(DONE);
  hooks(d);
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  accepted(A(d, ['deliver-plan', 'LC']), 'plan');
  approveDelivery(d);
  accepted(S(d, gh.env, 'commit'), 'commit');
  commitDelivery(d);
  accepted(S(d, gh.env, 'push'), 'push');
  pushed(d);
  accepted(S(d, gh.env, 'pr'), 'pr');
  gh.says('OPEN', g(d, 'rev-parse', 'HEAD'));
  accepted(S(d, gh.env, 'merge', '7'), 'merge');
  gh.says('MERGED', g(d, 'rev-parse', 'HEAD'));
  run(d, 'chmod', ['a-w', `${d}/.agents/runs`]);
  const r = S(d, gh.env, 'cleanup', '7');
  run(d, 'chmod', ['u+w', `${d}/.agents/runs`]);
  assert.notEqual(r.status, 0, 'cleanup succeeded although the run folder could not be removed');
  assert.ok(existsSync(`${d}/.agents/runs/LC`), 'the test did not interrupt the cleanup');
  assert.match(read(d, '.agents/local/batch/merged.tsv'), /^LC\t7\t[0-9]+$/m);
});

test('knowledge: after CODE_DONE .md pages stay out of the tier; a script, an executable doc, a symlink and a data file under docs/wiki count (round 6)', () => {
  const d = project(`SC_BRANCH=1 SC_SCOPE_NAMED=app.go scaffold standalone no STANDARD; ${TASKS_IN_TASKS}; solo RED fail impl_test.txt 'test: lookup returns the stored value'; `
    + "solo GREEN pass app.go 'package x' impl.txt,impl_test.txt,app.go; A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null");
  const tier = () => A(d, ['tier', 'LC'], { role: 'reviewer' }).out.trim();
  const wiki = `${d}/docs/wiki`;
  const clear = () => run(d, 'sh', ['-c', 'rm -f docs/wiki/* docs/wiki/.[!.]*']);
  mkdirSync(wiki, { recursive: true });
  assert.equal(tier(), 'small', 'the fixture is not small');
  for (const n of ['a', 'b', 'c']) wf(`${wiki}/${n}.md`, `# ${n}\n`);
  assert.equal(tier(), 'small', 'plain .md pages counted toward the tier');
  clear();
  wf(`${wiki}/gen.sh`, 'echo 1\n'); wf(`${wiki}/gen2.sh`, 'echo 2\n');
  assert.equal(tier(), 'full', 'unnamed scripts under docs/wiki did not count');
  clear();
  wf(`${wiki}/x1.md`, '# a\n'); wf(`${wiki}/x2.md`, '# b\n'); run(d, 'chmod', ['+x', `${wiki}/x1.md`, `${wiki}/x2.md`]);
  assert.equal(tier(), 'full', 'executable docs did not count');
  clear();
  run(d, 'ln', ['-s', '../../impl.txt', `${wiki}/l1.md`]); run(d, 'ln', ['-s', '../../impl_test.txt', `${wiki}/l2.md`]);
  assert.equal(tier(), 'full', 'symlinked docs did not count');
  clear();
  wf(`${wiki}/d1.json`, '{}\n'); wf(`${wiki}/d2.json`, '{}\n');
  assert.equal(tier(), 'full', 'non-doc extensions did not count');
});

/** @param {string} d */
function requireNames(d) { return existsSync(`${d}/.agents/runs/LC/approvals`) ? readdir(`${d}/.agents/runs/LC/approvals`) : []; }
import { readdirSync as readdir } from 'node:fs';
void [wf, read];
