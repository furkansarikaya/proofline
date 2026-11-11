// @ts-check
// Stage 6 (A215): deliver-plan, the summary, the platforms, task-source-done, and the real commit and push through the git hooks (deliver-test.sh scenarios
// content_change_stops, failed_refused, reopened_run_delivers, task_moves_to_done, task_move_skipped, summary_warns_without_ci, platforms, task_done_noop,
// one_approval_real_chain, partial_reply_recovers, cleanup_crash_keeps_merged).
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { A, DONE, TASKS_IN_TASKS, accepted, approveDelivery, commitDelivery, existsSync, fakeGh, fakeTool, g, gOk, hooks, pathWithoutPlatformTools, pushed, readFileSync, refused, run, say, verbs } from './run6-lib.mjs';
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
  const approved = read(d, '.agents/local/deliver/LC/COMMIT_MSG');
  assert.equal(approved, 'feat: lookup (LC)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n', 'the default trailer is part of the approved message');
  wf(`${d}/.agents/local/deliver/LC/COMMIT_MSG`, 'chore: other\n');
  refused(S(d, gh.env, 'commit'), 'a changed commit message', 'commit message or the pull request body changed');
  wf(`${d}/.agents/local/deliver/LC/COMMIT_MSG`, approved);
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

test('deliver-plan: the knowledge secret scan runs in the core when the project has no scanner script (the installer ships none)', () => {
  const d = project(`SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; mkdir -p docs/wiki .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/; `
    + "printf -- '---\\ntitle: lookup\\nstatus: current\\nsource: .agents/config.yaml\\n---\\n\\n# Lookup\\n\\nThe lookup returns the stored value.\\n' > docs/wiki/lookup.md; "
    + 'A knowledge-done LC >/dev/null; write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null; rm -f .agents/scripts/secret-scan.sh');
  hooks(d);
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan without a scanner script').out;
  assert.match(plan, /^steps: commit push pr merge cleanup$/m);
  assert.ok(!plan.includes('scanner missing'), 'the scan asked for a script');
});

test('deliver-plan is ready after four wiki pages written at CODE_DONE (the knowledge step leaves the tier small and every gate satisfied)', () => {
  const d = project(`SC_BRANCH=1 SC_SCOPE_NAMED=app.go scaffold standalone no STANDARD; ${TASKS_IN_TASKS}; solo RED fail impl_test.txt 'test: lookup returns the stored value'; `
    + "solo GREEN pass app.go 'package x' impl.txt,impl_test.txt,app.go; A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; "
    + 'mkdir -p docs/wiki .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/; '
    + "for i in 1 2 3 4; do printf -- '---\\ntitle: page %s\\nstatus: current\\nsource: .agents/config.yaml\\n---\\n\\n# Page %s\\n\\nThe lookup returns the stored value.\\n' \"$i\" \"$i\" > \"docs/wiki/page$i.md\"; done; "
    + 'A knowledge-done LC >/dev/null; write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null');
  hooks(d);
  assert.equal(A(d, ['tier', 'LC'], { role: 'reviewer' }).out.trim(), 'small', 'four knowledge files at CODE_DONE moved the tier');
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan after the knowledge files').out;
  assert.match(plan, /approve delivery/);
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
  accepted(A(d, ['deliver-plan', 'LC'], { env: { PATH: pathWithoutPlatformTools() } }), 'gitlab');
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

// A224 (#172, user decision of 2026-11-07): the CONTROL PLANE appends the configured attribution trailer to the delivery commit. A harness or user attribution
// instruction ("end commit messages with Co-Authored-By: ...") needs no action and never parks a delivery; nobody else adds a trailer.
/** Replace the git.commit_trailer line of the project's config. @param {string} d @param {string} text the lines that replace it (already indented) */
function setTrailer(d, text) {
  const f = `${d}/.agents/config.yaml`;
  const cur = read(d, '.agents/config.yaml');
  const block = /^ {2}commit_trailer:[^\n]*\n(?: {4}- [^\n]*\n)*/m;
  assert.match(cur, block, 'the shipped config has the key');
  wf(f, cur.replace(block, `${text}\n`));
}
const MSG = '.agents/local/deliver/LC/COMMIT_MSG';
const DEFAULT_MSG = 'fix: the approved line (LC)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';

test('A224: the default trailer is added by deliver-plan, shown in the summary whole, covered by message_sha256 and the approval, ledgered, and committed as written', () => {
  const home = tempDir('attr-home-');
  mkdirSync(`${home}/.claude`, { recursive: true });
  wf(`${home}/.claude/settings.json`, JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: '' } }));
  wf(`${home}/.claude/CLAUDE.md`, 'Never add a Co-Authored-By trailer to a commit.\n');
  const env = { HOME: home };
  const gh = fakeGh();
  const d = project(DONE);
  hooks(d);
  const plan = accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)'], { env }), 'deliver-plan').out;
  assert.equal(read(d, MSG), DEFAULT_MSG, 'a harness setting in the home folder changes nothing: the config decides');
  assert.match(plan, /^message: fix: the approved line \(LC\)$/m);
  assert.match(plan, /^trailers: default \(1 line, added by the control plane/m);
  assert.match(plan, /^commit message, exactly as committed:\n {2}\| fix: the approved line \(LC\)\n {2}\|\n {2}\| Co-Authored-By: Claude <noreply@anthropic\.com>\n/m);
  const sum = read(d, '.agents/local/deliver/LC/SUMMARY.md');
  assert.match(sum, new RegExp(`^message_sha256: ${createHash('sha256').update(DEFAULT_MSG).digest('hex')}$`, 'm'), 'the hash covers the whole message, trailer included');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /commit-trailer[^\n]*source=default lines=1 message_sha256=[0-9a-f]{64} trailer=Co-Authored-By: Claude <noreply@anthropic\.com>/);
  approveDelivery(d);
  accepted(S(d, { ...gh.env, ...env }, 'commit'), 'commit');
  commitDelivery(d);
  assert.equal(g(d, 'log', '-1', '--format=%B').replace(/\n+$/, ''), DEFAULT_MSG.replace(/\n+$/, ''), 'git recorded the whole message');
  assert.equal(g(d, 'log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)'), 'Claude <noreply@anthropic.com>', 'git reads it as a trailer');
  accepted(S(d, { ...gh.env, ...env }, 'push'), 'push with the trailer in the commit');
  rmSync(home, { recursive: true, force: true });
});

test('A224: a commit whose whole message differs from the approved one (a trailer changed, added or dropped by hand) stops the chain at the next step', () => {
  for (const [what, msg] of /** @type {Array<[string, string]>} */ ([
    ['a changed trailer', 'fix: the approved line (LC)\n\nCo-Authored-By: Evil <e@x.y>\n'],
    ['an added trailer', `${DEFAULT_MSG}Signed-off-by: Someone <s@x.y>\n`],
    ['a dropped trailer', 'fix: the approved line (LC)\n'],
  ])) {
    const gh = fakeGh();
    const d = project(DONE);
    hooks(d);
    accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan');
    approveDelivery(d);
    accepted(S(d, gh.env, 'commit'), 'commit');
    commitDelivery(d);
    gOk(d, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--amend', '-m', msg.replace(/\n+$/, ''));
    refused(S(d, gh.env, 'push'), what, 'not the approved COMMIT_MSG');
  }
});

test('A224 KNOWN LIMIT: a commit-msg hook that rewrites the message (a Change-Id, a sign-off) stops the chain at the next step, also with the trailer off; the refusal says why', () => {
  for (const trailer of ['default', 'off']) {
    const gh = fakeGh();
    const d = project(DONE);
    hooks(d);
    if (trailer === 'off') setTrailer(d, '  commit_trailer: off');
    accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan');
    approveDelivery(d);
    accepted(S(d, gh.env, 'commit'), 'commit');
    // the project's own commit-msg hook appends a line to every message (as a Gerrit Change-Id or a DCO hook does)
    const hd = tempDir('msg-hooks-');
    wf(`${hd}/commit-msg`, '#!/bin/sh\nprintf "\\nChange-Id: I0123456789abcdef\\n" >> "$1"\n', { mode: 0o755 });
    A(d, ['task-source-done', 'LC']);
    gOk(d, 'add', '-A');
    gOk(d, '-c', `core.hooksPath=${hd}`, 'commit', '-qF', MSG);
    assert.match(g(d, 'log', '-1', '--format=%B'), /Change-Id: I0123456789abcdef/, 'the hook rewrote the message');
    const r = S(d, gh.env, 'push');
    refused(r, `a rewriting commit-msg hook (trailer ${trailer})`, 'the message of the delivery commit is not the approved COMMIT_MSG (the whole message counts, trailers included; commit with git commit -F, never by hand)');
    rmSync(hd, { recursive: true, force: true });
  }
});

test('A224 upgrade: a half-finished delivery whose COMMIT_MSG was written before the upgrade (no trailer) resumes: the step is not refused and that exact message is committed', () => {
  const gh = fakeGh();
  const d = project(DONE);
  hooks(d);
  setTrailer(d, '  commit_trailer: off'); // what the config effectively said before the upgrade: no trailer
  accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan');
  assert.equal(read(d, MSG), 'fix: the approved line (LC)\n');
  approveDelivery(d);
  setTrailer(d, '  commit_trailer: "Co-Authored-By: Claude <noreply@anthropic.com>"'); // the upgraded default; no re-plan happens
  accepted(S(d, gh.env, 'commit'), 'commit step after the upgrade');
  commitDelivery(d);
  assert.equal(g(d, 'log', '-1', '--format=%B'), 'fix: the approved line (LC)', 'exactly the old message, no trailer added');
  accepted(S(d, gh.env, 'push'), 'push step after the upgrade');
  assert.equal(read(d, MSG), 'fix: the approved line (LC)\n');
});

test('A224: a COMMIT_MSG edited by hand after the approval (a trailer added, changed or removed) stops the chain at the commit step', () => {
  const gh = fakeGh();
  const d = project(DONE);
  hooks(d);
  accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan');
  approveDelivery(d);
  for (const msg of [`${DEFAULT_MSG}Co-Authored-By: Another <a@x.y>\n`, 'fix: the approved line (LC)\n\nCo-Authored-By: Claude <noreply@anthropic.com> \n', 'fix: the approved line (LC)\n']) {
    wf(`${d}/${MSG}`, msg);
    const r = S(d, gh.env, 'commit');
    refused(r, 'a hand-edited COMMIT_MSG', 'commit message or the pull request body changed');
    assert.ok(!/with the trailer lines/.test(r.text), 'the refusal points at a trailer path that does not exist');
    assert.match(r.text, /never edited by hand/);
  }
  wf(`${d}/${MSG}`, DEFAULT_MSG);
  accepted(S(d, gh.env, 'commit'), 'the approved message again');
});

test('A224: off adds nothing; a configured line or list replaces the default, in order', () => {
  const d = project(DONE);
  hooks(d);
  setTrailer(d, '  commit_trailer: off');
  const plan = accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan').out;
  assert.equal(read(d, MSG), 'fix: the approved line (LC)\n');
  assert.match(plan, /^trailers: off \(none\)$/m);
  assert.match(plan, /^commit message, exactly as committed:\n {2}\| fix: the approved line \(LC\)\n/m);
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), /commit-trailer[^\n]*source=off lines=0 message_sha256=[0-9a-f]{64}\n/);
  setTrailer(d, '  commit_trailer: "Co-Authored-By: Dev Team <dev@example.com>"');
  accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan');
  assert.equal(read(d, MSG), 'fix: the approved line (LC)\n\nCo-Authored-By: Dev Team <dev@example.com>\n');
  setTrailer(d, '  commit_trailer:\n    - Co-Authored-By: Dev Team <dev@example.com>\n    - Ticket: ABC-123');
  const p3 = accepted(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), 'deliver-plan').out;
  assert.equal(read(d, MSG), 'fix: the approved line (LC)\n\nCo-Authored-By: Dev Team <dev@example.com>\nTicket: ABC-123\n');
  assert.match(p3, /^trailers: config \(2 lines/m);
  assert.match(p3, /^ {2}\| Ticket: ABC-123$/m);
});

test('A224: a refused configuration or an injection through --message stops deliver-plan before any file is written; a trailer in --message is still refused', () => {
  const d = project(DONE);
  hooks(d);
  for (const [text, why] of /** @type {Array<[string, string]>} */ ([
    ['  commit_trailer: Signed-off-by: Someone <s@x.y>', 'certifies what a person did'],
    ['  commit_trailer: not a trailer', 'is not "Key: value"'],
    ['  commit_trailer: Key: a"b', 'is not "Key: value"'],
    [`  commit_trailer: Key: ${'v'.repeat(300)}`, 'longer than 200 bytes'],
    ['  commit_trailer:\n    - A: 1\n    - B: 2\n    - C: 3\n    - D: 4\n    - E: 5\n    - F: 6', 'at most 5 lines'],
    ['  commit_trailer:\n    - off\n    - A: 1', 'off stands alone'],
    ['  commit_trailer: Key: a\u0000b', 'holds a control character'],
    ['  commit_trailer: Key: a\rb', 'holds a control character'],
  ])) {
    setTrailer(d, text);
    refused(A(d, ['deliver-plan', 'LC', '--message', 'fix: the approved line (LC)']), text, why);
    assert.ok(!existsSync(`${d}/${MSG}`), `a refused trailer config left a COMMIT_MSG behind: ${text}`);
    assert.ok(!existsSync(`${d}/.agents/local/deliver/LC/SUMMARY.md`), 'a refused trailer config left a summary');
  }
  setTrailer(d, '  commit_trailer: Co-Authored-By: Claude <noreply@anthropic.com>');
  for (const m of ['feat: lookup (LC)\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'feat: lookup (LC)\nCo-Authored-By: Evil <e@x.y>', 'feat: lookup (LC)\rCo-Authored-By: Evil <e@x.y>', 'feat: lookup\tx (LC)']) {
    refused(A(d, ['deliver-plan', 'LC', '--message', m]), JSON.stringify(m), m.includes('\n') ? 'the commit message is one line' : 'must not hold a control character');
    assert.ok(!existsSync(`${d}/${MSG}`), 'a refused message left a COMMIT_MSG behind');
  }
  // the one line may not carry the characters either; a line that merely mentions a trailer stays one subject line, with the real trailer after it
  refused(A(d, ['deliver-plan', 'LC', '--message', 'feat: a "quoted" line (LC)']), 'a quote', 'must not hold');
  accepted(A(d, ['deliver-plan', 'LC', '--message', 'feat: mentions Co-Authored-By: Evil (LC)']), 'a subject that only names a trailer');
  assert.equal(read(d, MSG), 'feat: mentions Co-Authored-By: Evil (LC)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n');
});

/** @param {string} d */
function requireNames(d) { return existsSync(`${d}/.agents/runs/LC/approvals`) ? readdir(`${d}/.agents/runs/LC/approvals`) : []; }
import { readdirSync as readdir } from 'node:fs';
void [wf, read];
