// @ts-check
// lifecycle-test.sh scenarios scenario_terminal .. scenario_reopen_blocked_and_state (lines 420-1070) as Node tests (176-D2). Every assertion, attack input
// and message of the shell scenario is kept. The control plane under test is the real one; the fixture is the harness's.
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { accepted, expectFail, expectState, git, project, refused, repo, rv, tcStatus } from '../lib/harness.mjs';
import { A, AS, approve, failedRun, finishDone, gfail, gitRun, gpass, lines, lsDir, must, passAll, pipe, rd, recTry, sayNow, solo, startSleeper, stopSleeper, subst, toCodeDone, worker, wr, writeReport } from './lifecycle-s2-lib.mjs';

const RUN = '.agents/runs/LC';
const KD = 'nothing durable changed in this synthetic test run';
const BLOCKED_INPUT = 'reason: the verification toolchain is unavailable in this environment\nevidence: go test exited 127 because the go binary is missing\n';
const FAILED_INPUT = 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gate QA failed the empty-key scenario on every round\n';
/** freeze or refreeze, with the QA plan bound to the current PLAN as the shell `A` always did. @param {string} d @param {string[]} args */
const fz = (d, ...args) => A(d, args, { bind: true });
/** The lines of a text through a mapping (awk-style: each line may become several or stay). @param {string} text @param {(l: string) => string[]} f */
const mapLines = (text, f) => text.split('\n').flatMap(f).join('\n');
/** @param {string} d @param {string} gate @param {string} what The gate cannot be recorded (the record is refused or the result cannot even be built). */
function gateRefused(d, gate, what) { refused(recTry(d, gate, 'PASS'), what); }
/** @param {string} d */
const knowledgeDone = (d) => must(d, ['knowledge-done', 'LC', 'not_applicable', KD]);

test('scenario_terminal: FAILED only after the fix rounds, BLOCKED, dispatch markers, terminal run takes nothing, cleanup guards (A116, A124, A200)', () => {
  const d = project({ topology: 'orchestrated' });
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'QA', 'impl.txt');
  // A124: a live dispatch marker makes `next` say wait (not the dispatch line) and `pipeline` report it; a dead pid is stale.
  const mk = `${RUN}/dispatch/001-verifier-claude.running`;
  const nextOf = () => A(d, ['next', 'LC']);
  let pid = startSleeper();
  try {
    wr(d, mk, `pid=${pid}\nrole=verifier\ndispatch in flight\n`);
    const nx = nextOf().out;
    assert.ok(lines(nx).some((l) => l.startsWith(`next=wait: dispatch.sh LC verifier in flight (pid ${pid};`)), `next did not tell the lead to wait for a live dispatch (A124): ${nx}`);
    // A227: the live line also tells the lead to keep its turn alive (the sentence the shell next_step printed)
    assert.ok(lines(nx).some((l) => l.startsWith('next=wait: dispatch.sh LC verifier in flight (pid') && l.endsWith('; never end your turn while it runs: wait for the pid in a bounded wait loop and repeat it (DISPATCH.md, A227)')), `the wait line lacks the A227 sentence: ${nx}`);
    assert.ok(!lines(nextOf().out).some((l) => l.startsWith('next=dispatch.sh')), 'next printed a dispatch instruction while one is in flight (A124)');
    assert.ok(lines(A(d, ['pipeline', 'LC']).out).some((l) => l.startsWith(`in_flight=dispatch.sh LC verifier (pid ${pid})`)), 'pipeline did not report the dispatch in flight (A124)');
  } finally { stopSleeper(pid); }
  let n2 = nextOf().out;
  assert.ok(!lines(n2).some((l) => l.startsWith('next=wait')), 'next ignored a dead-pid marker as live (A124)');
  assert.ok(lines(n2).some((l) => l.startsWith('note=stale dispatch marker removed: 001-verifier-claude.running')), 'stale marker not reported (A124)');
  assert.ok(!existsSync(path.join(d, mk)), 'stale marker not removed (A124)');
  pid = startSleeper();
  try {
    wr(d, mk, `pid=${pid}\nrole=verifier\n`); utimesSync(path.join(d, mk), new Date(2000, 0, 1), new Date(2000, 0, 1));
    n2 = nextOf().out;
  } finally { stopSleeper(pid); }
  assert.ok(!lines(n2).some((l) => l.startsWith('next=wait')), 'next treated an over-age marker with a live (reused) pid as in flight (A124)');
  assert.ok(lines(n2).some((l) => l.startsWith('note=stale dispatch marker removed')) && !existsSync(path.join(d, mk)), 'over-age marker not reported and removed (A124)');
  const term = (/** @type {string} */ outcome, role = 'lead') => A(d, ['terminate', 'LC', outcome], { input: FAILED_INPUT, role });
  refused(term('FAILED'), 'FAILED accepted while fix rounds remain');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: first attempt'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'QA', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'QA', 'impl.txt');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a third fix was allowed');
  refused(A(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: no\nevidence: gate QA failed the empty-key scenario a third time\n' }), 'terminate without a reason');
  refused(term('FAILED', 'qa'), 'terminate by a non-lead');
  refused(term('DONE'), 'an unknown outcome was accepted');
  accepted(term('FAILED'), 'terminate FAILED');
  expectState(d, 'execution', 'state', 'FAILED');
  mkdirSync(path.join(d, '.agents/local/outside-target'), { recursive: true }); writeFileSync(path.join(d, '.agents/local/outside-target/keep'), '');
  mkdirSync(path.join(d, '.agents/local/assignments'), { recursive: true });
  symlinkSync(path.join(d, '.agents/local/outside-target'), path.join(d, '.agents/local/assignments/LC'));
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a terminal run accepted a handoff');
  refused(recTry(d, 'QA', 'PASS'), 'a terminal run accepted a gate');
  refused(A(d, ['classify', 'LC', 'STANDARD']), 'a terminal run was reclassified');
  refused(term('BLOCKED'), 'a terminal run was terminated again');
  must(d, ['verify-seal', 'LC']);
  assert.ok(lines(A(d, ['next', 'LC']).out).some((l) => l.startsWith('next=report the evidence')), 'next did not point a terminal run at cleanup');
  // A116 guards: each case checks, restores the scaffolding, then asserts, so a failed assertion leaves nothing behind.
  const Ad = path.join(d, '.agents/local/assignments'); const Od = path.join(d, '.agents/local/outside-target'); const run = path.join(d, RUN);
  refused(A(d, ['cleanup', 'LC']), 'cleanup followed a symlinked assignments directory');
  let kept = existsSync(path.join(Od, 'keep')) && lstatSync(path.join(Ad, 'LC')).isSymbolicLink() && existsSync(run); rmSync(path.join(Ad, 'LC'), { force: true });
  assert.ok(kept, 'symlinked assignments guard failed (A116)');
  writeFileSync(path.join(Ad, 'LC'), '');
  refused(A(d, ['cleanup', 'LC']), 'cleanup removed a regular file at the assignments path');
  kept = lstatSync(path.join(Ad, 'LC')).isFile() && existsSync(run); rmSync(path.join(Ad, 'LC'), { force: true });
  assert.ok(kept, 'a file at the assignments path was not kept with the run (A116)');
  mkdirSync(path.join(Od, 'LC'), { recursive: true }); writeFileSync(path.join(Od, 'LC/keep'), ''); rmdirSync(Ad); symlinkSync(Od, Ad);
  refused(A(d, ['cleanup', 'LC']), 'cleanup went through a symlinked assignments parent');
  kept = existsSync(path.join(Od, 'LC/keep')) && existsSync(run); rmSync(Ad, { force: true }); mkdirSync(Ad, { recursive: true });
  assert.ok(kept, 'symlinked assignments parent guard failed (A116)');
  mkdirSync(path.join(Ad, 'LC'), { recursive: true }); writeFileSync(path.join(Ad, 'LC/a.md'), '');
  must(d, ['cleanup', 'LC']);
  assert.ok(!existsSync(run) && !existsSync(path.join(Ad, 'LC')), 'a FAILED cleanup left the run or its assignments directory (A116)');
  // a run that is neither DONE nor terminal; a BLOCKED run with an archive keep of 1
  const s = project({ topology: 'standalone' });
  refused(A(s, ['cleanup', 'LC']), 'cleanup of a run that is neither DONE nor terminal', 'cleanup requires handoff DONE');
  wr(s, '.agents/local/assignments/LC/a.md', '');
  refused(A(s, ['cleanup', 'LC']), 'a refused cleanup');
  assert.ok(existsSync(path.join(s, '.agents/local/assignments/LC/a.md')) && existsSync(path.join(s, RUN)), 'a refused cleanup removed the assignments or run directory (A116)');
  rmSync(path.join(s, '.agents/local/assignments/LC'), { recursive: true, force: true });
  must(s, ['terminate', 'LC', 'BLOCKED'], { input: BLOCKED_INPUT });
  expectState(s, 'execution', 'state', 'BLOCKED');
  wr(s, '.agents/local/assignments/LC/a.md', '');
  const cfg = rd(s, '.agents/config.yaml');
  assert.match(cfg, /^  keep: 10/m, 'the config has no archive.keep (A200)');
  wr(s, '.agents/config.yaml', cfg.replace(/^  keep: 10/m, '  keep: 1'));
  wr(s, '.agents/local/archive/OLD-1/x', ''); utimesSync(path.join(s, '.agents/local/archive/OLD-1'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  must(s, ['cleanup', 'LC']);
  assert.ok(!existsSync(path.join(s, RUN)) && !existsSync(path.join(s, '.agents/local/assignments/LC')), 'a BLOCKED cleanup left the run or its assignments directory (A116)');
  assert.ok(lsDir(s, '.agents/local/archive/LC').some((n) => /^LC-.*\.tar\.gz$/.test(n)), 'a BLOCKED run left no evidence archive (A200)');
  assert.ok(!existsSync(path.join(s, '.agents/local/archive/OLD-1')), "archive.keep: 1 kept an older run's archive (A200)");
});

test('scenario_cleanup_after_hook_lines: cleanup of a BLOCKED run ignores hook lines after the terminate; a run without terminate still refuses (A203)', () => {
  let d = project({ topology: 'standalone' });
  wr(d, '.agents/local/hook-times', '1|posttool|12|ok|\n2|pretool|7|ok|\n3|stop|900|timeout|slow\n');
  must(d, ['hook-time', 'LC']);
  assert.match(rd(d, `${RUN}/HOOKS.log`), / event=hook /, 'setup: hook-time wrote no hook line before the terminate');
  assert.doesNotMatch(rd(d, `${RUN}/LEDGER.log`), / event=hook/, 'A203: a hook line is in the ledger');
  refused(A(d, ['cleanup', 'LC']), 'cleanup of a run with no terminate');
  must(d, ['terminate', 'LC', 'BLOCKED'], { input: BLOCKED_INPUT });
  wr(d, '.agents/local/hook-times', '4|posttool|15|ok|\n5|prompt|9|ok|\n6|stop|950|timeout|slow\n');
  must(d, ['hook-time', 'LC']);
  const last = lines(subst(rd(d, `${RUN}/LEDGER.log`))).at(-1) ?? '';
  assert.doesNotMatch(last, / event=hook(-timeout)? /, 'A203: the last ledger line is a hook line');
  accepted(A(d, ['cleanup', 'LC']), 'cleanup of a BLOCKED run was refused because hook lines follow its terminate');
  assert.ok(!existsSync(path.join(d, RUN)), 'the BLOCKED run survived the cleanup');
  d = project({ topology: 'standalone' });
  wr(d, '.agents/local/hook-times', '1|posttool|12|ok|\n'); must(d, ['hook-time', 'LC']);
  refused(A(d, ['cleanup', 'LC']), 'hook lines alone are not a terminate');
});

test('scenario_pipeline_trivial: TRIVIAL has no evidence, QA plan or QA gate; a stray QA_PLAN.md or EVIDENCE.md is refused', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL' });
  assert.equal(pipe(d, 'gates'), 'SECRETS VERIFY', `TRIVIAL before any change: ${pipe(d, 'gates')}`);
  assert.equal(pipe(d, 'evidence'), 'no'); assert.equal(pipe(d, 'qa_plan'), 'no');
  expectState(d, 'freeze', 'evidence_sha256', 'not_required'); expectState(d, 'freeze', 'qa_plan_sha256', 'not_required');
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.equal(pipe(d, 'gates'), 'SECRETS VERIFY', `TRIVIAL .txt change (tier docs): ${pipe(d, 'gates')}`);
  refused(recTry(d, 'QA', 'PASS'), 'a QA gate on a TRIVIAL run');
  rmSync(path.join(d, RUN, 'QA_REPORT.md'), { force: true });
  passAll(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  wr(d, `${RUN}/QA_PLAN.md`, '# stray\n');
  refused(A(d, ['verify-scope', 'LC']), 'a QA_PLAN.md on a TRIVIAL run passed verify-scope', 'unexpected run artifact');
  rmSync(path.join(d, RUN, 'QA_PLAN.md'));
  knowledgeDone(d);
  wr(d, `${RUN}/COMPLETION_REPORT.md`, `${['# Completion Report: LC', '', '## Implementation Summary', 'impl.txt and impl_test.txt changed under the TRIVIAL pipeline.', '', '## TDD Evidence', 'RED then GREEN recorded by the lead.', '', '## Verification',
    'The VERIFY gate passed on the final tree.', '', '## Assumptions', 'none', '', '## Review Result', 'REVIEW_SMALL passed.', '', '## Known Limitations / Follow-up', 'None.'].join('\n')}\n`);
  must(d, ['publish-completion-report', 'LC', 'markdown']); must(d, ['handoff', 'LC', 'DONE']);
  must(d, ['validate', 'LC']); must(d, ['delivery-check', 'LC']);
  wr(d, `${RUN}/EVIDENCE.md`, '# stray\n');
  refused(A(d, ['validate', 'LC']), 'an EVIDENCE.md on a TRIVIAL run passed validate', 'unexpected run artifact');
  rmSync(path.join(d, RUN, 'EVIDENCE.md')); must(d, ['validate', 'LC']);
});

test('scenario_classification_diff: a TRIVIAL run whose diff holds executable code cannot reach IMPLEMENTED, the way out is named (A31)', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'manual' });
  wr(d, `${RUN}/PLAN.md`, mapLines(rd(d, `${RUN}/PLAN.md`), (l) => (l === '  - path: impl.txt' ? ['  - path: app.go', '    new: true'] : [l])));
  const saved = rd(d, '.agents/config.yaml');
  appendFileSync(path.join(d, '.agents/config.yaml'), 'review:\n  executable_code: "*.zzz"\n');
  must(d, ['freeze', 'LC'], { bind: true });
  wr(d, '.agents/config.yaml', saved);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value', 'app.go,impl_test.txt');
  solo(d, 'GREEN', 'pass', 'app.go', 'package x', 'app.go,impl_test.txt');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a TRIVIAL run with an executable code change reached IMPLEMENTED', 'is TRIVIAL but its diff changes executable code: app.go');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'the message names the way out', 'agent.sh classify LC STANDARD');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING');
});

test('scenario_trivial_freeze_code: TRIVIAL freeze and refreeze refuse executable code in scope; STANDARD, html and md scope freeze (A115)', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'manual' });
  const planText = rd(d, `${RUN}/PLAN.md`);
  const planCode = mapLines(planText, (l) => (l === '  - path: impl.txt' ? ['  - path: src/x.js', '    new: true'] : l === '  - path: impl_test.txt' ? ['  - path: src/x.test.js', '    new: true'] : [l]));
  wr(d, `${RUN}/PLAN.md`, planCode);
  refused(fz(d, 'freeze', 'LC'), 'a TRIVIAL freeze accepted executable code in scope', 'scope has executable code: src/x.js src/x.test.js');
  wr(d, `${RUN}/PLAN.md`, mapLines(planText, (l) => (l === '  - path: impl.txt' ? ['  - path: public/index.html', '    new: true'] : l === '  - path: impl_test.txt' ? ['  - path: README.md', '    new: true'] : [l])));
  must(d, ['freeze', 'LC'], { bind: true });
  const s = project({ topology: 'standalone', layout: 'no', cls: 'STANDARD', autonomy: 'manual' });
  wr(s, `${RUN}/PLAN.md`, planCode);
  must(s, ['freeze', 'LC'], { bind: true });
  wr(s, `${RUN}/amendments/001.md`, '# amendment\n');
  must(s, ['classify', 'LC', 'TRIVIAL']); rmSync(path.join(s, RUN, 'EVIDENCE.md')); rmSync(path.join(s, RUN, 'QA_PLAN.md'));
  refused(fz(s, 'refreeze', 'LC', '001.md'), 'a TRIVIAL refreeze accepted executable code in scope', 'executable code');
});

test('scenario_pipeline_standard: STANDARD pipeline, an edited QA plan fails verify-freeze and knowledge-done', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'STANDARD' });
  assert.equal(pipe(d, 'review'), 'no'); assert.equal(pipe(d, 'qa_plan'), 'yes');
  assert.equal(pipe(d, 'gates'), 'SECRETS QA VERIFY', `STANDARD docs tier: ${pipe(d, 'gates')}`);
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  passAll(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  const qa = rd(d, `${RUN}/QA_PLAN.md`);
  appendFileSync(path.join(d, RUN, 'QA_PLAN.md'), '- QA-2: weakened criterion added after freeze\n');
  refused(A(d, ['verify-freeze', 'LC']), 'an edited QA plan passed verify-freeze', 'freeze mismatch: qa_plan');
  refused(A(d, ['knowledge-done', 'LC', 'not_applicable', KD]), 'an edited QA plan allowed knowledge-done', 'freeze mismatch: qa_plan');
  wr(d, `${RUN}/QA_PLAN.md`, qa);
  must(d, ['verify-freeze', 'LC']);
});

test('scenario_classification: lead only, review option only where optional, reclassifying voids the freeze, plan shape per class', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'STANDARD' });
  refused(A(d, ['classify', 'LC', 'EPIC']), 'an unknown class was accepted');
  refused(A(d, ['classify', 'LC', 'COMPLEX', 'review']), 'the review option on a class that fixes review');
  refused(A(d, ['classify', 'LC', 'STANDARD', 'strict']), 'an unknown option was accepted');
  must(d, ['classify', 'LC', 'STANDARD', 'review']);
  refused(A(d, ['verify-freeze', 'LC']), 'a reclassification after freeze passed verify-freeze');
  for (const n of ['001', '002', '003', '004']) wr(d, `${RUN}/amendments/${n}.md`, `# amendment ${n}\n`);
  must(d, ['refreeze', 'LC', '001.md'], { bind: true }); must(d, ['verify-freeze', 'LC']);
  assert.equal(pipe(d, 'tier'), 'small', 'STANDARD review opt-in did not set the small tier floor');
  must(d, ['classify', 'LC', 'COMPLEX']);
  const saved = rd(d, `${RUN}/PLAN.md`);
  const ls = saved.split('\n'); const at = ls.findIndex((l) => /^## Architecture/.test(l));
  wr(d, `${RUN}/PLAN.md`, `${ls.slice(0, at).join('\n')}\n`);
  refused(fz(d, 'refreeze', 'LC', '002.md'), 'COMPLEX froze a plan with no Architecture section');
  wr(d, `${RUN}/PLAN.md`, saved);
  must(d, ['refreeze', 'LC', '002.md'], { bind: true });
  must(d, ['classify', 'LC', 'CRITICAL']); must(d, ['refreeze', 'LC', '003.md'], { bind: true });
  assert.ok(pipe(d, 'max_explorers') === '3' && pipe(d, 'tier') === 'full', 'CRITICAL is not tier full');
  must(d, ['classify', 'LC', 'TRIVIAL']);
  refused(fz(d, 'refreeze', 'LC', '004.md'), 'TRIVIAL froze with EVIDENCE.md and QA_PLAN.md present');
  rmSync(path.join(d, RUN, 'EVIDENCE.md')); rmSync(path.join(d, RUN, 'QA_PLAN.md'));
  wr(d, `${RUN}/PLAN.md`, `${['---', 'scope:', '  - path: impl.txt', '    criteria: [AC-1]', '  - path: impl_test.txt', '    criteria: [AC-1]', '  - path: tasks/LC.md', '    criteria: [AC-1]', '---', '# Plan', '', '## Assumptions', 'none', '', '## Behavior', 'unchanged'].join('\n')}\n`);
  refused(fz(d, 'refreeze', 'LC', '004.md'), 'TRIVIAL froze a plan with three scope paths');
  const done = project({ topology: 'standalone' });
  toCodeDone(done, 'standalone');
  refused(A(done, ['classify', 'LC', 'TRIVIAL']), 'a completed run was reclassified');
});

test('scenario_amend_plan_change: reopen with an authorized plan amendment, scope approval, refreeze, DONE again', () => {
  const d = project({ topology: 'standalone' });
  toCodeDone(d, 'standalone'); finishDone(d);
  refused(A(d, ['amend', 'LC'], { input: 'reason: the review found a missing helper file the plan did not cover\nfix_scope: extra.txt\nfix_instruction: add extra.txt with the helper and cover it with a test\nauthorized_by: the user\n' }), 'reopen naming a path outside the frozen plan without plan_change');
  must(d, ['amend', 'LC'], { input: 'reason: the review found a missing helper file the plan did not cover\nfix_scope: extra.txt\nfix_instruction: add extra.txt with the helper and cover it with a test\nauthorized_by: the user\nplan_change: yes\n' });
  refused(A(d, ['freeze', 'LC']), 'plain freeze on a reopened run');
  wr(d, `${RUN}/amendments/001.md`, '# amendment 001: add extra.txt to scope\n');
  wr(d, `${RUN}/PLAN.md`, `${['---', 'scope:', '  - path: impl.txt', '    criteria: [AC-1]', '  - path: impl_test.txt', '    criteria: [AC-1]', '  - path: extra.txt', '    criteria: [AC-1]', '    new: true', '---', '# Plan', '', '## Assumptions', 'none', '', '## Architecture', 'amended: one helper file'].join('\n')}\n`);
  refused(fz(d, 'refreeze', 'LC', '001.md'), 'a scope-adding refreeze without a scope approval', 'scope approval');
  approve(d, 'scope', 'approve the scope please');
  must(d, ['refreeze', 'LC', '001.md'], { bind: true }); expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  const tgt = 'impl.txt,impl_test.txt,extra.txt';
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: helper returns the stored value', tgt); solo(d, 'GREEN', 'pass', 'extra.txt', 'helper: returns the stored value', tgt);
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  knowledgeDone(d);
  writeReport(d, '', '## Amendments', 'Amendment 001 added extra.txt.', '', '## Reopen History', 'Reopened once after DONE to add a helper.');
  must(d, ['publish-completion-report', 'LC', 'markdown']); must(d, ['handoff', 'LC', 'DONE']); must(d, ['validate', 'LC']);
});

test('scenario_hardening: registry, verdict lines, amendments, forged terminal state', () => {
  const d = project({ topology: 'orchestrated', layout: 'no', cls: 'TRIVIAL' });
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  for (const f of ['QA_PLAN.md', 'REVIEW.md', 'scratch-notes.md', 'reviews/other/x.md', 'design/x.txt', 'reviews/proof-review/REPORT.md', 'reviews/test-trust/REPORT.md', 'reviews/proof-review/bugs/REPORT.md']) {
    wr(d, `${RUN}/${f}`, '# stray\n');
    refused(A(d, ['verify-scope', 'LC']), `stray ${f} passed verify-scope`, 'unexpected run artifact');
    gateRefused(d, 'VERIFY', `stray ${f} reached a gate`);
    rmSync(path.join(d, RUN, f));
  }
  // A119: a BSD `sed -i -E` leaves QA_PLAN.md-E; handoff refuses, the lead discards exactly that stray, handoff proceeds
  wr(d, `${RUN}/QA_PLAN.md-E`, 'x\n');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'a stray QA_PLAN.md-E did not block handoff', 'discard-stray LC');
  rmSync(path.join(d, RUN, 'QA_PLAN.md-E'));   // discard-stray itself is tested in tests/core/run4a-records.test.mjs
  must(d, ['verify-scope', 'LC']);   // the stray check handoff runs now passes (CODE_DONE itself still needs its gates)
  for (const f of ['design/INTENT.md', 'design/API.json', 'design/adr/0001-x.md', 'results/001-explorer.md', 'dispatch/001-reviewer-claude.md', 'dispatch/001-reviewer-claude.log', 'reviews/proof-review/plan/REPORT.md', 'reviews/proof-review/rules/ledger.md',
    'reviews/proof-review/small/findings.json', 'reviews/test-trust/tests/REPORT.md', 'reviews/test-trust/qa/REPORT.md', 'reviews/data-design/REVIEW.md', 'security/evidence/poc.txt']) wr(d, `${RUN}/${f}`, 'x\n');
  must(d, ['verify-scope', 'LC']);
  wr(d, `${RUN}/VERIFY.md`, '# VERIFY\n\nVerdict: PASS\n\nlater\n\nVerdict: FAIL\n');
  refused(AS(d, 'verifier', ['gate', 'LC', 'VERIFY', 'pass'], { input: 'summary: ran the full verification command set on the whole tree\n' }), 'a report with two verdicts was recorded', "exactly one 'Verdict:'");
  wr(d, `${RUN}/VERIFY.md`, '# VERIFY\n\nVerdict: FAIL\n');
  accepted(AS(d, 'verifier', ['gate', 'LC', 'VERIFY', 'fail'], { input: 'summary: ran the full verification command set on the whole tree\nfindings: lookup returns nil for the empty key in the verified tree\nfix_scope: impl.txt\n' }), 'VERIFY fail');
  refused(AS(d, 'implementer', ['handoff', 'LC', 'IMPLEMENTING']), 'an implementer reopened implementation', 'only the lead');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: first fix'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  wr(d, `${RUN}/amendments/001.md`, '# a1\n');
  refused(fz(d, 'refreeze', 'LC', '../TASK.md'), 'a path traversal amendment name was accepted', 'invalid amendment name');
  refused(fz(d, 'refreeze', 'LC', '001.md'), 'a no-op refreeze was accepted', 'changes nothing');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), 'amended\n'); must(d, ['refreeze', 'LC', '001.md'], { bind: true });
  appendFileSync(path.join(d, RUN, 'PLAN.md'), 'amended again\n');
  refused(fz(d, 'refreeze', 'LC', '001.md'), 'an amendment file was reused', 'already used');
  const orig = rd(d, `${RUN}/RUN.yaml`);
  wr(d, `${RUN}/RUN.yaml`, mapLines(orig, (l) => [l.replace(/^ {2}state: "IMPLEMENTING"/, '  state: "BLOCKED"').replace(/^ {2}state: PLANNING/, '  state: BLOCKED')]));
  refused(A(d, ['cleanup', 'LC']), 'cleanup of a hand-forged BLOCKED run');
  wr(d, `${RUN}/RUN.yaml`, orig);
});

// --- task-source contract --------------------------------------------------------------------
for (const topo of /** @type {const} */ (['standalone', 'orchestrated'])) {
  test(`scenario_task_contract_bookkeeping ${topo}: a moved task source is relocated, the frozen contract revision never moves, an edit after the END marker is rejected`, () => {
    const d = project({ topology: topo, layout: 'yes' }); toCodeDone(d, topo); const frozen = rv(d, 'task_source', 'revision');
    mkdirSync(path.join(d, 'tasks/done'), { recursive: true }); git(d, ['mv', 'tasks/in-progress/LC.md', 'tasks/done/LC.md']); tcStatus(path.join(d, 'tasks/done/LC.md'), 'done');
    refused(A(d, ['freshness', 'LC']), 'a moved task source was accepted without being relocated', 'task-source-relocate');
    must(d, ['task-source-relocate', 'LC', 'tasks/done/LC.md']);
    expectState(d, 'task_source', 'path', 'tasks/done/LC.md'); expectState(d, 'task_source', 'revision', frozen);
    must(d, ['freshness', 'LC']); must(d, ['verify-seal', 'LC']);
    finishDone(d);
    assert.equal(rv(d, 'task_source', 'revision'), frozen, 'publish re-baselined the frozen task contract');
    assert.ok(rd(d, 'tasks/done/LC.md').includes('<!-- COMPLETION-REPORT:BEGIN:LC -->'));
    must(d, ['verify-completion-report', 'LC']); must(d, ['delivery-check', 'LC']); must(d, ['validate', 'LC']);
    refused(A(d, ['task-source-relocate', 'LC', 'tasks/elsewhere.md']), 'relocation accepted after publication', 'receipt binds');
    const published = rd(d, 'tasks/done/LC.md');
    appendFileSync(path.join(d, 'tasks/done/LC.md'), '- a requirement added after publication\n');
    refused(A(d, ['freshness', 'LC']), 'a contract edit after the END marker was accepted', 'frozen task contract changed');
    wr(d, 'tasks/done/LC.md', published); must(d, ['freshness', 'LC']);
  });
}
for (const topo of /** @type {const} */ (['standalone', 'orchestrated'])) {
  test(`scenario_task_contract_edit ${topo}: an in-place edit of the frozen task contract is rejected by freshness, knowledge-done, publish and DONE`, () => {
    const d = project({ topology: topo, layout: 'yes' }); toCodeDone(d, topo); const frozen = rv(d, 'task_source', 'revision');
    appendFileSync(path.join(d, 'tasks/in-progress/LC.md'), '- a requirement added after freeze\n');
    refused(A(d, ['freshness', 'LC']), 'an edited task contract passed freshness', 'frozen task contract changed');
    refused(A(d, ['knowledge-done', 'LC', 'not_applicable', KD]), 'knowledge-done accepted an edited task contract', 'frozen task contract changed');
    writeReport(d);
    refused(A(d, ['publish-completion-report', 'LC', 'markdown']), 'publish accepted an edited task contract', 'frozen task contract changed');
    expectState(d, 'completion_report', 'published', 'false'); expectState(d, 'task_source', 'revision', frozen);
    assert.ok(!rd(d, 'tasks/in-progress/LC.md').includes('COMPLETION-REPORT:BEGIN'), 'the adapter ran against an edited task contract');
    refused(A(d, ['handoff', 'LC', 'DONE']), 'DONE accepted an edited task contract', 'frozen task contract changed');
  });
}

test('scenario_task_contract_laundering: a relocation cannot absorb an edited contract, a hand-edited task source path or revision is rejected', () => {
  const d = project({ topology: 'standalone', layout: 'yes' }); toCodeDone(d, 'standalone');
  mkdirSync(path.join(d, 'tasks/done'), { recursive: true }); git(d, ['mv', 'tasks/in-progress/LC.md', 'tasks/done/LC.md']); tcStatus(path.join(d, 'tasks/done/LC.md'), 'done');
  appendFileSync(path.join(d, 'tasks/done/LC.md'), '- a requirement smuggled in with the move\n');
  refused(A(d, ['task-source-relocate', 'LC', 'tasks/done/LC.md']), 'a relocation absorbed an edited contract', 'differs from the frozen contract');
  const saved = rd(d, `${RUN}/RUN.yaml`);
  wr(d, `${RUN}/RUN.yaml`, mapLines(saved, (l) => [l === '  path: tasks/in-progress/LC.md' ? '  path: tasks/done/LC.md' : l]));
  refused(A(d, ['verify-seal', 'LC']), 'a hand-edited task source path was accepted', 'edited by hand');
  wr(d, `${RUN}/RUN.yaml`, saved);
  wr(d, `${RUN}/RUN.yaml`, mapLines(saved, (l) => [l.startsWith('  revision: ') ? '  revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' : l]));
  refused(A(d, ['verify-seal', 'LC']), 'a hand-edited task revision was accepted', 'edited by hand');
  wr(d, `${RUN}/RUN.yaml`, saved); must(d, ['verify-seal', 'LC']);
});

// A74: a defect task (a debug-proof result exists) must carry a ## Root cause section in its completion report.
test("scenario_report_root_cause: a defect run's completion report needs ## Root cause; a run without a debug-proof result does not (A74)", () => {
  const d = project({ topology: 'standalone', layout: 'yes' }); toCodeDone(d, 'standalone');
  knowledgeDone(d); writeReport(d);
  wr(d, `${RUN}/reports/001-debug.md`, '# debug\n\nreproduction, root cause, regression test\n');
  refused(A(d, ['publish-completion-report', 'LC', 'markdown']), "a defect run's report without ## Root cause was published", 'missing required section: ## Root cause');
  expectState(d, 'completion_report', 'published', 'false');
  writeReport(d, '', '## Root cause', '`lookup` compares the untrimmed key where the trimmed key is needed.');
  must(d, ['publish-completion-report', 'LC', 'markdown']); must(d, ['handoff', 'LC', 'DONE']);
  const s = project({ topology: 'standalone', layout: 'yes' }); toCodeDone(s, 'standalone');
  knowledgeDone(s); writeReport(s);
  must(s, ['publish-completion-report', 'LC', 'markdown']); must(s, ['handoff', 'LC', 'DONE']);
});

test('scenario_task_contract_adapter: an adapter that changes the contract is rejected and the task source restored byte for byte', () => {
  const d = project({ topology: 'standalone', layout: 'yes' }); toCodeDone(d, 'standalone'); const frozen = rv(d, 'task_source', 'revision');
  const pre = readFileSync(path.join(d, 'tasks/in-progress/LC.md'));
  knowledgeDone(d); writeReport(d);
  wr(d, '.agents/task-integrations/evil.sh', `${['#!/bin/sh', 'set -eu', 'root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)', 'path=$(sed -n "s/^  path: //p" "$root/.agents/runs/$2/RUN.yaml" | head -1)',
    'case "$1" in publish) printf "%s\\n" "- a requirement the adapter added" >> "$root/$path"; printf "%s#feedface\\n" "$path" ;; verify) exit 0 ;; esac'].join('\n')}\n`);
  refused(A(d, ['publish-completion-report', 'LC', 'evil']), 'an adapter that changed the contract was accepted', 'outside the completion-report block');
  assert.ok(readFileSync(path.join(d, 'tasks/in-progress/LC.md')).equals(pre), 'the task source was not restored byte for byte');
  expectState(d, 'completion_report', 'published', 'false'); expectState(d, 'task_source', 'revision', frozen);
  rmSync(path.join(d, '.agents/task-integrations/evil.sh'), { force: true });
  must(d, ['publish-completion-report', 'LC', 'markdown']); must(d, ['handoff', 'LC', 'DONE']);
});

test('scenario_task_contract_projection: bookkeeping changes keep the frozen contract, a requirement change in any form is rejected', () => {
  const d = project({ topology: 'standalone', layout: 'yes' });
  const f = path.join(d, 'tasks/in-progress/LC.md'); const orig = readFileSync(f, 'utf8');
  const good = (/** @type {string} */ what, /** @type {() => void} */ change) => { writeFileSync(f, orig); change(); accepted(A(d, ['freshness', 'LC']), `bookkeeping change rejected: ${what}`); };
  const bad = (/** @type {string} */ what, /** @type {() => void} */ change) => { writeFileSync(f, orig); change(); expectFail(A(d, ['freshness', 'LC']), `contract change accepted: ${what}`); };
  const block = (/** @type {string} */ id) => () => appendFileSync(f, `\n## Completion Report\n\n<!-- COMPLETION-REPORT:BEGIN:${id} -->\nreport\n<!-- COMPLETION-REPORT:END:${id} -->\n`);
  good('status in-progress', () => tcStatus(f, 'in-progress'));
  writeFileSync(f, orig); tcStatus(f, 'done');
  refused(A(d, ['freshness', 'LC']), 'a Status value was read as contract', 'task-source-status');
  must(d, ['task-source-status', 'LC']); must(d, ['freshness', 'LC']);
  good('blank lines', () => appendFileSync(f, '\n\n\n'));
  good('a completion-report block', block('LC'));
  bad('text after the END marker', () => appendFileSync(f, '\n## Completion Report\n\n<!-- COMPLETION-REPORT:BEGIN:LC -->\nr\n<!-- COMPLETION-REPORT:END:LC -->\n- extra requirement\n'));
  bad('a block for another task', block('OTHER'));
  bad('a completion-report heading without markers', () => appendFileSync(f, '\n## Completion Report\n\nnotes\n'));
  bad('an edited requirement', () => writeFileSync(f, readFileSync(f, 'utf8').replace(/documented default/g, 'other default')));
  writeFileSync(f, orig); must(d, ['freshness', 'LC']);
});

// A108: approval detection is fail-closed. Only an allowlisted phrase plus the kind word approves; an ambiguous,
// empty, unrelated or hesitant answer approves nothing and leaves the request pending; the question lists the answers.
test('scenario_approval_fail_closed: only an allowlisted phrase approves, every ambiguous, negated, hedged, quoted or wrong-kind answer leaves the request pending (A108, A134)', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'supervised' });
  const q = A(d, ['request-approval', 'LC', 'plan']).out;
  for (const w of ['approve', 'yes', 'okay', 'lgtm', 'go ahead', 'evet', 'onay', 'olur', 'tamam']) assert.ok(q.includes(w), `the question does not list the accepted answer '${w}'`);
  const ad = `${RUN}/approvals`;
  const files = (/** @type {string} */ re) => lsDir(d, ad).filter((n) => new RegExp(re).test(n));
  const approvalOf = (/** @type {string} */ k) => files(`^\\d{3}-${k}\\.yaml$`);
  for (const t of ['hmm bir dakika', 'sonra bakarız', '', 'the weather is nice today', 'approve the plan?', 'do not approve the plan', 'approve the plan, but wait', 'plan için emin değilim, onaylıyorum', 'unapproved plan', 'okay then', 'plan tamamen yanlış',
    "I shouldn't approve the plan", 'I cannot approve the plan', 'yes, delete nothing', 'plan için onay vermiyorum', 'plan onay yok', 'plan olmaz, onay yok', 'plan: onaylamıyorum, evet', 'plan onay bekliyor', 'I will approve the plan after I review the tests',
    'what does the plan do before I approve', 'yes the plan is wrong', 'evet, plan yanlış', 'approve the plan — just kidding', 'PLAN ONAYLIYORUM DEĞİL']) {
    sayNow(d, t); expectFail(A(d, ['approve', 'LC', 'plan']), `an ambiguous answer approved: '${t}'`);
    assert.deepEqual(approvalOf('plan'), [], `an approval file exists after '${t}'`);
    assert.ok(files('^\\d{3}-request-plan\\.yaml$').length > 0, `the request is no longer pending after '${t}'`);
  }
  for (const t of ['approve the plan', 'Plan approved.', 'yes, plan', 'ok plan', 'okay, plan', 'LGTM plan', 'go ahead with the plan', 'plan onaylandı', 'plan onayliyorum', 'Plan: evet', 'plan tamam', 'plan olur']) {
    must(d, ['request-approval', 'LC', 'plan']); sayNow(d, t); accepted(A(d, ['approve', 'LC', 'plan']), `an allowlisted answer was refused: '${t}'`);
    for (const n of approvalOf('plan')) rmSync(path.join(d, ad, n), { force: true });
  }
  // A134: the full sentences of every kind approve (English and Turkish, ASCII variants), nothing else does.
  // the question shows the sentence capitalised, as the docs do
  assert.ok(A(d, ['request-approval', 'LC', 'plan']).out.includes('"I approve the plan" | "Planı onaylıyorum"'), 'the question does not show the full sentences');
  /** @type {[string, string[]][]} */
  const full = [
    ['plan', ['I approve the plan', '"I approve the plan"', 'Planı onaylıyorum', 'PLANI ONAYLIYORUM', 'planı onayladım', 'I approved the plan.', 'plani onayliyorum']],
    ['destructive', ['I approve the destructive step', 'Yıkıcı adımı onaylıyorum', 'yikici degisikligi onayliyorum', 'i approve the destructive change']],
    ['single_step', ['I approve the single step', 'tek adımı onaylıyorum', 'tek adimi onayladim']],
    ['scope', ['I approve the scope', 'Kapsamı onaylıyorum', 'kapsami onayliyorum']],
    ['budget', ['I approve the budget', 'I approve another round', 'Bütçeyi onaylıyorum', 'Bir round daha onaylıyorum', 'butceyi onayladim']],
    ['commit', ['I approve the commit', "Commit'i onaylıyorum", "commit'i onayladım"]],
    ['push', ['I approve the push', "Push'u onaylıyorum", "push'u onayliyorum"]],
  ];
  for (const [k, texts] of full) {
    for (const t of texts) {
      must(d, ['request-approval', 'LC', k]); sayNow(d, t); accepted(A(d, ['approve', 'LC', k]), `a full sentence was refused for ${k}: '${t}'`);
      for (const n of approvalOf(k)) rmSync(path.join(d, ad, n), { force: true });
    }
  }
  // A134 negatives: hedged, negated, mixed, question, wrong-kind, empty or quoted answers stay unapproved (plan and commit)
  const longq = `${'x'.repeat(20)} he wrote: "I approve the plan" in an earlier mail`;
  /** @type {[string, string[]][]} */
  const neg = [
    ['plan', ['I approve the commit', 'I approve the scope', "Commit'i onaylıyorum", 'Kapsamı onaylıyorum', 'I approve the plan but not the migration', 'I approve the plan and the commit', 'onaylıyorum ama sonra', 'Planı onaylıyorum ama göçü değil', 'maybe I approve the plan',
      'I do not approve the plan', 'I dont approve the plan', 'Planı onaylamıyorum', 'Planı onaylıyorum?', 'approve?', 'I approve the plan, thanks', 'I approve the plans']],
    ['commit', ['I approve the plan', 'I approve the push', 'I approve the commit but wait', "Commit'i onaylamıyorum", "Push'u onaylıyorum"]],
  ];
  for (const [k, texts] of neg) {
    must(d, ['request-approval', 'LC', k]);
    for (const t of texts) {
      sayNow(d, t); expectFail(A(d, ['approve', 'LC', k]), `a wrong-kind or ambiguous sentence approved ${k}: '${t}'`);
      assert.deepEqual(approvalOf(k), [], `an approval file exists for ${k} after '${t}'`);
    }
  }
  must(d, ['request-approval', 'LC', 'plan']);
  for (const t of ['', longq, 'I approve the plan I approve the plan']) { sayNow(d, t); expectFail(A(d, ['approve', 'LC', 'plan']), `an empty or quoted answer approved: '${t}'`); }
  // The grammar is locale independent (the harness runs under LC_ALL=C): the same refusals and a positive under UTF-8.
  for (const t of ["I shouldn't approve the plan", 'PLAN ONAYLIYORUM DEĞİL', 'plan onay yok', 'yes the plan is wrong']) {
    sayNow(d, t); expectFail(A(d, ['approve', 'LC', 'plan'], { env: { LC_ALL: 'en_US.UTF-8' } }), `an ambiguous answer approved under UTF-8: '${t}'`);
  }
  must(d, ['request-approval', 'LC', 'plan']); sayNow(d, 'PLAN ONAYLIYORUM');
  accepted(A(d, ['approve', 'LC', 'plan'], { env: { LC_ALL: 'en_US.UTF-8' } }), 'an allowlisted answer was refused under UTF-8');
});

// A202 item 31: several approvals in one message. The single-approval grammar is unchanged; a message it does not accept whole is split on
// commas and line breaks and each segment is parsed alone. This scenario ATTEMPTS the forbidden: a hedged, negated, conditional or
// question segment, quoted and fenced text, more segments than the cap, a waiver of a SECURITY finding. Only the exact ones are recorded.
test('scenario_approval_multi: several approvals in one message are parsed one by one; hedged, negated, quoted, capped and waiver segments are never recorded (A202)', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'supervised' });
  const ad = `${RUN}/approvals`;
  const KINDS = ['plan', 'scope', 'budget', 'destructive'];
  const recordRe = (/** @type {string} */ k) => new RegExp(`^\\d{3}-${k}\\.yaml$`);
  const has = (/** @type {string} */ k) => lsDir(d, ad).some((n) => recordRe(k).test(n));
  const clear = (/** @type {string[]} */ ...ks) => { for (const n of lsDir(d, ad)) if (ks.some((k) => recordRe(k).test(n))) rmSync(path.join(d, ad, n)); };
  let msg = '';
  const capml = (/** @type {string} */ m) => { msg = m; sayNow(d, m); };
  const only = (/** @type {string[]} */ ...kinds) => { for (const k of KINDS) assert.equal(has(k), kinds.includes(k), `multi: ${k} ${kinds.includes(k) ? 'was not recorded' : 'was recorded but must not be'} (${msg})`); };
  const pending = () => A(d, ['approve-pending', 'LC']);
  for (const k of KINDS) must(d, ['request-approval', 'LC', k]);
  // the question of a run with several open requests shows the one message that answers all of them
  const qo = A(d, ['request-approval', 'LC', 'plan']).out;
  assert.ok(qo.includes('approve budget, approve destructive, approve plan, approve scope'), `the question does not show the phrases for several open requests: ${qo}`);
  // 1. four approvals in one message: four records, every record bound to the same user prompt
  capml('approve plan, approve scope, approve budget, approve destructive');
  let out = pending().out; only(...KINDS);
  assert.ok(out.includes('multi: 4 of 4 segments read as approvals, 4 approval record(s) written'), `no confirmation line: ${out}`);
  const ids = new Set(KINDS.flatMap((k) => lsDir(d, ad).filter((n) => recordRe(k).test(n)).flatMap((n) => [...rd(d, `${ad}/${n}`).matchAll(/^capture_id: (.*)$/gm)].map((m) => m[1]))));
  assert.equal(ids.size, 1, 'the records are not bound to one user prompt');
  // 2. lines instead of commas
  clear(...KINDS); capml('approve plan\napprove scope'); must(d, ['approve-pending', 'LC']); only('plan', 'scope');
  // 3. negated, conditional, question and unclear segments are rejected alone, each named on one line; the exact ones are recorded
  clear(...KINDS); capml('approve plan, do not approve scope, approve budget if CI is green, approve destructive?, approve the thing');
  out = pending().out; only('plan');
  assert.ok(out.includes('multi: not recorded: do not approve scope: negated, conditional or hedged'), `negated segment not named: ${out}`);
  assert.ok(out.includes('multi: not recorded: approve budget if CI is green: negated, conditional or hedged'), `conditional segment not named: ${out}`);
  assert.ok(out.includes('multi: not recorded: approve destructive?: a question is not an approval'), `question segment not named: ${out}`);
  assert.ok(out.includes('multi: not recorded: approve the thing: not one exact approval'), `unclear segment not named: ${out}`);
  assert.ok(out.includes('1 of 5 segments read as approvals, 1 approval record(s) written'), `no count line: ${out}`);
  // 4. one ambiguous segment is rejected alone, the others are recorded
  clear(...KINDS); capml('approve plan, approve budget, approve scope maybe'); must(d, ['approve-pending', 'LC']); only('plan', 'budget');
  // 5. a lone approval with a hedge stays refused as a whole (no guessing); so does a hedge that is no attempt at an approval
  clear(...KINDS);
  for (const m of ['approve the plan, but wait', 'approve plan, hmm', 'approve plan, thanks!']) { capml(m); out = pending().out; only(); assert.ok(!out.includes('multi:'), `multi mode on for a lone approval with a hedge: ${m}`); }
  // 6. quoted and pasted text is never an approval: a blockquote line, a fenced block, a quote that is the whole message
  capml('approve plan\n> approve scope, approve budget'); out = pending().out; only('plan');
  assert.ok(out.includes('multi: not recorded: > approve scope, approve budget: quoted or pasted text'), `quote not named: ${out}`);
  clear('plan'); capml('approve plan\n```\napprove scope\napprove budget\n```'); out = pending().out; only('plan'); assert.ok(out.includes('quoted or pasted text'), `fence not named: ${out}`);
  clear('plan'); capml('> approve plan, approve scope'); must(d, ['approve-pending', 'LC']); only();
  // 7. a question: the question segment is not an approval, the other one is
  capml('should I approve plan?, approve scope'); must(d, ['approve-pending', 'LC']); only('scope');
  // 8. more than the cap: the extras are rejected with one line, the ninth segment records nothing
  clear('scope'); capml('approve plan, approve plan, approve plan, approve plan, approve plan, approve plan, approve plan, approve plan, approve scope');
  out = pending().out; only('plan'); assert.ok(out.includes('more than 8 approvals in one message (limit 8)'), `cap not reported: ${out}`);
  // 9. a waiver of a SECURITY finding is no approval kind that can be open: refused, the others are recorded
  clear('plan'); expectFail(A(d, ['request-approval', 'LC', 'waive:SECURITY-1']), 'a SECURITY waiver request was created');
  capml('approve plan, approve waive SECURITY-1, approve scope'); out = pending().out; only('plan', 'scope');
  assert.ok(out.includes('multi: not recorded: approve waive SECURITY-1'), `waiver segment not named: ${out}`);
  assert.deepEqual(lsDir(d, ad).filter((n) => n.includes('waive')), [], 'a waiver record exists');
  // 11. review A1: a negated, hedged or questioning sibling that names no other open kind vetoes the whole message
  clear(...KINDS);
  for (const m of ['approve plan, not ok', "approve the plan, on second thought I don't approve", "approve plan\nI don't approve it", "approve the plan, unless the tests fail then I don't approve", "approve plan, yes I'm not sure", "approve plan, approve scope, I don't approve any of it", 'approve plan, approve scope, did I approve?']) {
    capml(m); A(d, ['approve-pending', 'LC']); only();
  }
  // round 2: retraction words veto too; the valid multi-approvals keep working
  for (const m of ['approve plan, ok cancel', 'approve plan, ok undo', 'approve plan, ok stop', 'approve plan, ok ignore the above', 'approve plan, ok nope', 'approve plan, ok nah', 'approve plan, ok cannot', "approve plan, ok isn't", 'approve plan, approve scope, cancel',
    'approve plan, approve scope, revoke', 'approve plan, approve scope, reject', 'approve plan, approve scope, nope', 'approve plan, approve scope, hmm']) {
    capml(m); A(d, ['approve-pending', 'LC']); only();
  }
  capml('approve plan, approve scope'); A(d, ['approve-pending', 'LC']); only('plan', 'scope');
  clear('plan', 'scope');
  // a negated segment that names a different open kind is still reported alone (case 3), but one that names an accepted kind vetoes
  capml("approve plan, I don't approve plan"); A(d, ['approve-pending', 'LC']); only();
  // 10. a single approval behaves as before: no multi line, one record
  clear('plan', 'scope'); capml('approve the plan'); out = pending().out; only('plan'); assert.ok(!out.includes('multi:'), 'multi line for a single approval');
});

// Delivery then cleanup: the commit moves HEAD past base_sha; cleanup must still succeed (base_sha an ancestor,
// task-owned patch = the CODE_DONE patch and committed), and afterwards the git hooks see no open run.
test('scenario_cleanup_after_delivery: cleanup after the delivery commit succeeds, the run no longer blocks commits', () => {
  const d = project({ topology: 'orchestrated', branch: true }); toCodeDone(d, 'orchestrated'); finishDone(d);
  const tb = git(d, ['branch', '--show-current']); assert.equal(tb, 'proofline/LC-lookup', `task branch: ${tb}`);
  // the shipped pre-commit hook is a launcher of the Node core: the same launcher, with the path of this project
  const hooks = path.join(path.dirname(d), `hooks-${path.basename(d)}`); mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\nexec node "${d}/.agents/scripts/proofline-core.mjs" cli pre-commit\n`, { mode: 0o755 });
  git(d, ['config', 'core.hooksPath', hooks]);
  git(d, ['add', '-A']);
  refused(gitRun(d, ['commit', '-qm', 'feat: lookup (LC)']), "a commit without the user's approval", 'commit approval');
  must(d, ['request-approval', 'LC', 'commit']); sayNow(d, 'commit it'); must(d, ['approve', 'LC', 'commit']);
  accepted(gitRun(d, ['commit', '-qm', 'feat: lookup (LC)']), 'the approved delivery commit was blocked');
  git(d, ['checkout', '-q', 'main']); writeFileSync(path.join(d, 'other.txt'), 'x\n'); git(d, ['add', 'other.txt']);
  refused(gitRun(d, ['commit', '-qm', 'other']), 'a commit on another branch while the run is open', 'task branch');
  git(d, ['reset', '-q', 'other.txt']); rmSync(path.join(d, 'other.txt'), { force: true }); git(d, ['checkout', '-q', tb]);
  const done = readFileSync(path.join(d, 'impl.txt'));
  appendFileSync(path.join(d, 'impl.txt'), 'edited after delivery\n');
  refused(A(d, ['cleanup', 'LC']), 'cleanup accepted a delivered run whose content changed afterwards');
  writeFileSync(path.join(d, 'impl.txt'), done);
  accepted(A(d, ['cleanup', 'LC']), 'cleanup after the delivery commit failed');
  assert.ok(!existsSync(path.join(d, RUN)) && A(d, ['open-runs']).out.trim() === '' && lines(A(d, ['status']).out).includes('active_task=none'), 'the run still counts as open after the cleanup');
  git(d, ['checkout', '-q', 'main']); writeFileSync(path.join(d, 'other.txt'), 'x\n'); git(d, ['add', 'other.txt']);
  accepted(gitRun(d, ['commit', '-qm', 'chore: other']), 'a commit on another branch is still blocked after cleanup');
});

// A101: freeze refuses a PLAN.md scope entry without `criteria:` before recording anything (RUN.yaml untouched), and
// the repaired plan freezes without a scope approval.
// A129: freeze and refreeze refuse a TASK.md criterion that maps to no scope path and has no explicit test (the
// plan-contract validator's rule and text), also for TRIVIAL and when every scope entry has a non-empty `criteria:`.
test('scenario_freeze_ac_coverage: freeze and refreeze refuse a criterion mapped to no scope path and no explicit test (A101, A129)', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'supervised', taskExtra: '- AC-2: no other change' });
  // a skipped check is never silent: without the skill installed the freeze says so (the plan is accepted, as before)
  assert.ok(fz(d, 'freeze', 'LC').text.includes('note: AC coverage not checked (the plan-contract skill is not installed)'), 'a skipped AC coverage check was silent');
  cpSync(path.join(repo, 'skills/plan-contract'), path.join(d, '.agents/skills/plan-contract'), { recursive: true }); appendFileSync(path.join(d, '.git/info/exclude'), '.agents/skills/\n');
  const before = rd(d, `${RUN}/RUN.yaml`); const good = rd(d, `${RUN}/PLAN.md`);
  refused(fz(d, 'freeze', 'LC'), 'freeze accepted a TRIVIAL plan with an unmapped criterion', 'AC-2: maps to no scope path and no explicit test');
  refused(fz(d, 'freeze', 'LC'), 'the refusal did not name the fix', 'add AC-n to `criteria:` of the PLAN.md scope entries');
  assert.equal(subst(before), subst(rd(d, `${RUN}/RUN.yaml`)), 'a refused freeze changed RUN.yaml');
  wr(d, `${RUN}/PLAN.md`, rd(d, `${RUN}/PLAN.md`).replace(/^ {4}criteria: \[AC-1\]$/gm, '    criteria: [AC-1, AC-2]'));
  approve(d, 'plan', 'approve the plan'); accepted(fz(d, 'freeze', 'LC'), 'a plan mapping every criterion was refused');
  // refreeze: an amendment that unmaps AC-2 is refused; naming an explicit test for it is accepted
  wr(d, `${RUN}/amendments/001.md`, '# amendment 001: drop the AC-2 mapping\n');
  wr(d, `${RUN}/PLAN.md`, `${subst(good)}\n`);
  refused(fz(d, 'refreeze', 'LC', '001.md'), 'refreeze accepted an unmapped criterion', 'AC-2: maps to no scope path and no explicit test');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), '\n## Tests\n\n- AC-2: `impl_test.txt` asserts nothing else changed\n');
  approve(d, 'plan', 'approve the plan'); accepted(fz(d, 'refreeze', 'LC', '001.md'), 'an explicit test for the criterion was refused');
});

test('scenario_freeze_scope_mapping: freeze validates the scope mapping first and leaves RUN.yaml untouched', () => {
  const d = project({ topology: 'standalone', layout: 'no', cls: 'TRIVIAL', autonomy: 'supervised' });
  const before = rd(d, `${RUN}/RUN.yaml`); const good = rd(d, `${RUN}/PLAN.md`);
  wr(d, `${RUN}/PLAN.md`, `${['---', 'scope:', '  - path: impl.txt', '  - path: impl_test.txt', '    criteria: [AC-1]', '---', '# Plan'].join('\n')}\n`);
  refused(fz(d, 'freeze', 'LC'), 'freeze accepted a scope entry without criteria', 'each entry needs `path` and `criteria:`');
  assert.equal(subst(before), subst(rd(d, `${RUN}/RUN.yaml`)), 'a refused freeze changed RUN.yaml');
  wr(d, `${RUN}/PLAN.md`, `${subst(good)}\n`);
  approve(d, 'plan', 'approve the plan'); accepted(fz(d, 'freeze', 'LC'), 'freeze with the repaired plan');
  assert.ok(rd(d, `${RUN}/RUN.yaml`).includes('scope_paths: "impl.txt,impl_test.txt"'), 'scope_paths not recorded');
});

// A FAILED run is cleaned up after its evidence is reported; deliver never opens a draft pull request (A152).
test('scenario_failed_run_cleanup: a FAILED run reports its knowledge and is cleaned up without any extra approval (A152)', () => {
  const d = project({ topology: 'orchestrated', testCrit: 'AC-2', taskExtra: '- AC-2: second behavior' });
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'REVIEW_SMALL', 'impl_test.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl_test.txt', 'test: default for an empty key'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'QA', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt at the empty key default'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'VERIFY', 'impl.txt');
  must(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gates/*-VERIFY.yaml fail on the third content\n' });
  accepted(A(d, ['knowledge-done', 'LC', 'not_applicable', KD]), 'knowledge-done refused on a FAILED run');
  accepted(A(d, ['cleanup', 'LC']), 'cleanup of a FAILED run refused');
  assert.ok(!existsSync(path.join(d, RUN)), 'the run directory survived the cleanup');
});

// 0.0.5: a designer window opened before any PLAN.md exists is refused for its real reason, with no grep error.
// plan-section prints one section only; digest/next rebuild the right step from the files alone (resume, A150).
test('scenario_digest_resume: digest and plan-section rebuild the step from files only (A150)', () => {
  const d = project({ topology: 'standalone' });
  let out = A(d, ['plan-section', 'LC', 'Architecture']).out;
  assert.ok(out.includes('one storage map'), `plan-section lost its section: ${out}`);
  assert.ok(!out.includes('none'), `plan-section leaked the Assumptions section: ${out}`);
  assert.ok(A(d, ['plan-section', 'LC', 'scope']).out.includes('impl.txt'), 'plan-section scope missing the path');
  expectFail(A(d, ['plan-section', 'LC', 'Nope']), 'unknown plan section accepted');
  rmSync(path.join(d, '.agents/local/ACTIVE_RUN'), { force: true });   // a fresh process, no session state: only the run files remain
  let r = A(d, ['digest', 'LC']); out = r.out;
  assert.equal(r.status, 0, `digest failed: ${r.text}`);
  assert.ok(out.includes('NEXT: dispatch.sh LC implementer'), `digest after freeze does not point at the implementer: ${out}`);
  assert.ok(out.includes('OPEN QUESTIONS: 0'), `digest lost the question count: ${out}`);
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  r = A(d, ['digest', 'LC']); out = r.out;
  assert.ok(out.includes('REVIEW_SMALL'), `digest after IMPLEMENTED omits the gates: ${out}`);
  const sel = (/** @type {string} */ text, /** @type {string} */ p) => lines(text).filter((l) => l.startsWith(p)).map((l) => l.slice(p.length)).join('\n');
  assert.equal(sel(out, 'NEXT: '), sel(A(d, ['next', 'LC']).out, 'next='), 'digest NEXT differs from next');
});

test('scenario_window_open_no_plan: window-open without PLAN.md is refused for its real reason, with no missing-file error', () => {
  const d = project({ topology: 'orchestrated', layout: 'no', cls: 'COMPLEX', autonomy: 'supervised' });
  rmSync(path.join(d, RUN, 'PLAN.md'));
  const r = A(d, ['window-open', 'LC', 'designer']);
  assert.notEqual(r.status, 0, 'window-open succeeded before IMPLEMENTING');
  assert.ok(r.text.includes('only while handoff state is IMPLEMENTING'), `window-open refused for another reason: ${r.text}`);
  assert.ok(!r.text.includes('No such file'), `window-open leaked a missing-file error: ${r.text}`);
});

const REOPEN_REASON = 'reason: the budget decision was made and the verifier false alarm is fixed\n';
/** `ro`: the reopen command with its reason on stdin. @param {string} d @param {string} [role] */
const reopen = (d, role) => A(d, ['reopen', 'LC'], { input: REOPEN_REASON, ...(role ? { role } : {}) });
/** The user's approval of the reopen, with a capture at the real time after the request. @param {string} d */
function reopenApprove(d) { must(d, ['request-approval', 'LC', 'reopen:LC']); sayNow(d, 'I approve the reopen of LC'); must(d, ['approve', 'LC', 'reopen:LC']); }

// reopen of a FAILED run (A152): refused without the user's approval, by non-lead roles and on a non-terminal run; with it,
// passing gates stay, the failed gate and the fix rounds restart, knowledge restarts, the scope is checked, CODE_DONE is reachable.
test('scenario_reopen_failed: approval, roles, scope, kept passes, fix rounds 0 of 2, knowledge restarted, CODE_DONE (A152)', () => {
  const d = failedRun();
  refused(A(d, ['deliver-plan', 'LC']), 'deliver-plan of a FAILED run', 'to reopen: /proofline reopen LC');
  must(d, ['knowledge-done', 'LC', 'not_applicable', KD]);
  refused(A(d, ['reopen', 'LC'], { input: 'reason: no\n' }), 'reopen with a vague reason', "requires a specific 'reason:'");
  refused(reopen(d), 'reopen without the approval', 'needs the user');
  for (const r of ['implementer', 'qa', 'reviewer', 'verifier']) expectFail(reopen(d, r), `${r} reopened a run`);
  reopenApprove(d);
  expectFail(reopen(d, 'implementer'), 'a non-lead used the approved reopen');
  writeFileSync(path.join(d, 'far.txt'), 'x\n');
  refused(reopen(d), 'reopen with a change outside the frozen scope', 'outside the frozen scope');
  rmSync(path.join(d, 'far.txt'));
  accepted(reopen(d), 'approved reopen refused');
  expectState(d, 'execution', 'state', 'PLANNING');
  expectState(d, 'execution', 'knowledge_state', 'not_started');
  assert.equal(pipe(d, 'fix_round'), '0', `the reopen did not restart the fix rounds: ${pipe(d, 'fix_round')}`);
  assert.ok(lines(A(d, ['report-facts', 'LC']).out).includes('- Fix rounds: 0 of 2'), 'the report does not count the fix rounds from 0 of 2');
  expectFail(reopen(d), 'the approval was reusable');
  const pl = A(d, ['pipeline', 'LC']).out;
  assert.ok(/^gate\.REVIEW_SMALL=pass/m.test(pl) && /^gate\.QA=pass/m.test(pl), `passing gates on unchanged inputs did not stay: ${pl}`);
  assert.ok(!/^gate\.VERIFY=pass/m.test(pl), 'the failed gate still counts as passed after the reopen');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with the failed gate not rerun');
  // a gate whose inputs changed after the reopen runs again
  appendFileSync(path.join(d, 'impl.txt'), 'late fix\n');
  assert.ok(!/^gate\.QA=pass/m.test(A(d, ['pipeline', 'LC']).out), 'QA still passes after the task-owned content changed');
  wr(d, 'impl.txt', rd(d, 'impl.txt').replace(/late fix\n$/, ''));
  gpass(d, 'VERIFY');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with a never-concluded gate', 'required gate SECRETS');
  must(d, ['secret-scan', 'LC']); accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE refused after the gates passed');
});

// reopen takes terminal runs only, and a BLOCKED run is refused by deliver-plan like a FAILED one.
test('scenario_reopen_blocked_and_state: BLOCKED is refused by deliver-plan and reopened with the approval; a non-terminal run is refused', () => {
  const d = project({ topology: 'standalone' });
  refused(reopen(d), 'reopen of a non-terminal run', 'FAILED or BLOCKED run only');
  must(d, ['terminate', 'LC', 'BLOCKED'], { input: BLOCKED_INPUT });
  refused(A(d, ['deliver-plan', 'LC']), 'deliver-plan of a BLOCKED run', 'to reopen: /proofline reopen LC');
  refused(reopen(d), 'reopen of a BLOCKED run without the approval', 'needs the user');
  reopenApprove(d); accepted(reopen(d), 'reopen of a BLOCKED run refused');
  expectState(d, 'execution', 'state', 'PLANNING');
});
