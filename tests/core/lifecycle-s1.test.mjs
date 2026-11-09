// @ts-check
// lifecycle-test.sh scenarios standalone .. amendment_fresh_budget (lines 1-419) as Node tests (176-D2). Every assertion, attack input and message of the
// shell scenario is kept. The control plane under test is the real one; the fixture is the harness's. One test per scenario.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, accepted, approveAsUser, expectFail, expectState, git, gpass, gfail, must, pipe, project, refused, rec, resultFor, solo, worker, wopen, wev, wclose, writeReport, finishDone } from '../lib/harness.mjs';
import { RUN, amendAs, evidence, fixPaths, gateText, lsDir, nextOut, rd, recTry, sedLines, sedSection, wr } from './lifecycle-s1-lib.mjs';

const ok = (/** @type {import('../lib/harness.mjs').Result} */ r, /** @type {string} */ what) => accepted(r, what);
/** Worker evidence by the lead path of the scaffold: 'AC-2' on the test path so impl.txt and impl_test.txt share no criterion (A123). */
const split = () => project({ topology: 'orchestrated', testCrit: 'AC-2', taskExtra: '- AC-2: second behavior' });
/** RED then GREEN by the worker, then handoff IMPLEMENTED. @param {string} d */
function orchImplemented(d) {
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
}

test('standalone: gates bind content and artifact, a change after the gates voids all of them', () => {
  const d = project({ topology: 'standalone' });
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE without any gate');
  must(d, ['secret-scan', 'LC']); gpass(d, 'REVIEW_SMALL');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE without QA and VERIFY');
  gpass(d, 'QA');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE without the VERIFY gate');
  gpass(d, 'VERIFY');
  // a change after the gates voids all of them; nothing carries over
  appendFileSync(path.join(d, 'impl.txt'), 'late tweak\n');
  expectFail(A(d, ['verify-handoff', 'LC']), 'stale gates accepted by verify-handoff');
  expectFail(recTry(d, 'QA', 'PASS'), 'a gate recorded on content changed since IMPLEMENTED');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE on content changed since IMPLEMENTED');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE using the passes for the older content');
  assert.equal(pipe(d, 'gate.QA'), 'stale', 'an old QA pass is not reported stale');
  { for (const g of ['REVIEW_SMALL', 'QA']) gpass(d, g); must(d, ['secret-scan', 'LC']); gpass(d, 'VERIFY'); }
  must(d, ['handoff', 'LC', 'CODE_DONE']);
  // an artifact edited after its gate voids that gate, even though the content is unchanged
  appendFileSync(path.join(d, `${RUN}/QA_REPORT.md`), 'edited after the gate\n');
  expectFail(A(d, ['verify-handoff', 'LC']), 'an edited QA report still counted');
  expectFail(recTry(d, 'QA', 'PASS'), 'a gate recorded after CODE_DONE');   // rewrites the report with its gated content
  must(d, ['verify-handoff', 'LC']);
});

// A97 (S-6): GREEN and REFACTOR follow a RED record of the same path, and GREEN follows a change of the implementation since that RED.
test('evidence_order: GREEN needs an earlier RED and a changed implementation; REFACTOR needs GREEN', () => {
  const d = project({ topology: 'standalone' });
  const tgt = 'impl.txt,impl_test.txt';
  let r = evidence(d, 'GREEN', tgt);
  refused(r, 'GREEN accepted before any RED'); assert.ok(r.text.includes('no RED evidence'), `GREEN before RED: wrong reason: ${r.text}`);
  r = evidence(d, 'REFACTOR', tgt);
  refused(r, 'REFACTOR accepted before any RED'); assert.ok(r.text.includes('no RED evidence'), `REFACTOR before RED: wrong reason: ${r.text}`);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n');
  accepted(evidence(d, 'RED', tgt, 'fail'), 'RED refused');
  r = evidence(d, 'GREEN', tgt);
  refused(r, 'GREEN accepted with no implementation change since RED'); assert.ok(r.text.includes('no implementation file changed'), `GREEN without change: wrong reason: ${r.text}`);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test edited again\n');
  r = evidence(d, 'GREEN', tgt);
  refused(r, 'GREEN accepted after only a test file changed'); assert.ok(r.text.includes('no implementation file changed'), `GREEN after a test-only edit: wrong reason: ${r.text}`);
  r = evidence(d, 'REFACTOR', tgt);
  refused(r, 'REFACTOR accepted before GREEN'); assert.ok(r.text.includes('no GREEN evidence'), `REFACTOR before GREEN: wrong reason: ${r.text}`);
  appendFileSync(path.join(d, 'impl.txt'), 'impl: lookup returns the stored value\n');
  accepted(evidence(d, 'GREEN', tgt), 'GREEN refused after the fix');
  accepted(evidence(d, 'REFACTOR', tgt), 'REFACTOR refused after GREEN');
});

// The lead and the non-gate roles never record a verdict; each gate role records only its own gate.
test('independence: only gate roles record verdicts; role command boundaries hold', () => {
  const d = project({ topology: 'standalone' });
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  const f = resultFor(d, 'VERIFY', 'PASS');
  const text = readFileSync(f, 'utf8');
  const tmpf = (/** @type {string} */ name, /** @type {string} */ t) => { const p = path.join(path.dirname(f), name); writeFileSync(p, t); return p; };
  refused(A(d, ['record', 'LC', '--file', f]), 'the lead recorded a gate verdict', 'does not match AGENT_ROLE');
  refused(A(d, ['record', 'LC', '--file', tmpf('lead.md', sedLines(text, /^ROLE: verifier/, 'ROLE: lead'))]), 'a lead PASS was accepted', 'lead can never record');
  for (const r of ['implementer', 'explorer', 'architect', 'task_author', 'designer']) {
    expectFail(AS(d, r, ['record', 'LC', '--file', tmpf('x.md', sedLines(text, /^ROLE: verifier/, `ROLE: ${r}`))]), `${r} recorded a VERIFY verdict`);
  }
  const summary = 'summary: ran the full verification command set on the whole tree\n';
  expectFail(A(d, ['gate', 'LC', 'VERIFY', 'pass'], { input: summary }), 'the lead used the compatibility gate command');
  expectFail(AS(d, 'qa', ['gate', 'LC', 'VERIFY', 'pass'], { input: summary }), 'qa recorded a VERIFY gate through the compatibility command');
  for (const g of ['REVIEW_SMALL', 'QA']) gpass(d, g);
  must(d, ['secret-scan', 'LC']); gpass(d, 'VERIFY');
  for (const g of ['REVIEW_SMALL', 'QA', 'VERIFY']) {
    const gf = `${RUN}/gates/${lsDir(d, `${RUN}/gates`).filter((n) => n.endsWith(`-${g}.yaml`)).at(-1)}`;
    const bak = rd(d, gf);
    wr(d, gf, sedLines(bak, /^role: .*/, 'role: "lead"'));
    expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), `hand-relabelled ${g} gate counted`);
    wr(d, gf, bak);
  }
  must(d, ['handoff', 'LC', 'CODE_DONE']);
  for (const r of ['reviewer', 'qa', 'verifier', 'security_reviewer', 'explorer', 'architect', 'data_architect', 'designer', 'task_author', 'implementation_worker', 'independent_reviewer']) {
    expectFail(AS(d, r, ['handoff', 'LC', 'DONE']), `${r} moved the lifecycle`);
    expectFail(AS(d, r, ['freeze', 'LC']), `${r} froze`);
    expectFail(AS(d, r, ['classify', 'LC', 'TRIVIAL']), `${r} classified`);
    expectFail(AS(d, r, ['amend', 'LC']), `${r} reopened a run`);
    expectFail(AS(d, r, ['approve', 'LC', 'commit']), `${r} approved`);
    expectFail(AS(d, r, ['waive', 'LC', 'X-1', '--reason', 'a long enough reason for the waiver']), `${r} waived`);
    expectFail(AS(d, r, ['terminate', 'LC', 'BLOCKED'], { input: 'reason: x\nevidence: y\n' }), `${r} terminated a run`);
    expectFail(AS(d, r, ['cleanup', 'LC']), `${r} cleaned up a run`);
    for (const c of ['verify-handoff', 'pipeline', 'next']) accepted(AS(d, r, [c, 'LC']), `${r} ${c}`);
  }
  for (const r of ['reviewer', 'qa', 'explorer', 'architect']) {
    expectFail(AS(d, r, ['worker-evidence', 'LC', 'GREEN', 'pass'], { input: 'command: x\ntarget: impl.txt\n' }), `${r} recorded implementation evidence`);
  }
  finishDone(d); must(d, ['delivery-check', 'LC']);
  for (const r of ['reviewer', 'qa', 'verifier', 'explorer', 'architect']) accepted(AS(d, r, ['validate', 'LC']), `${r} validate`);
});

// Orchestrated end to end: worker implementation -> REVIEW FAIL -> worker fix -> QA FAIL -> worker fix -> all gates -> CODE_DONE -> DONE -> manual rewind
// detection -> reopen -> fix -> DONE -> cleanup.
test('orchestrated_loop: worker loop, reopen, ledger and cleanup', () => {
  const d = project({ topology: 'orchestrated' });
  const p = (/** @type {string} */ f) => path.join(d, f);
  appendFileSync(p('impl_test.txt'), 'lead wrote this\n');
  expectFail(A(d, ['window-open', 'LC']), 'worker window opened over a lead edit');
  const evIn = 'command: x\ntarget: impl_test.txt\nexpected_failure: TestImpl fails: lookup is not implemented in impl.txt yet\n';
  expectFail(A(d, ['worker-evidence', 'LC', 'RED', 'fail'], { input: evIn }), 'lead-authored RED evidence accepted under orchestrated');
  git(d, ['checkout', '-q', '--', 'impl_test.txt']);
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); expectState(d, 'handoff', 'state', 'IMPLEMENTED');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with no gates');
  must(d, ['secret-scan', 'LC']);
  gfail(d, 'REVIEW_SMALL', 'impl.txt');
  gpass(d, 'QA');                                                           // parallel gates on the same content still record
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with an open finding');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  const implSaved = readFileSync(p('impl.txt')); appendFileSync(p('impl.txt'), 'lead quick fix\n');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), "the lead's own fix reached IMPLEMENTED");
  expectFail(A(d, ['window-open', 'LC']), "worker window absorbed the lead's fix");
  writeFileSync(p('impl.txt'), implSaved);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: lookup returns the documented default for an empty key');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gpass(d, 'REVIEW_SMALL');
  gfail(d, 'QA', 'impl_test.txt');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with a failing QA');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl_test.txt', 'test: an empty key returns the documented default');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE on the review pass for older content');
  passAllGates(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  must(d, ['verify-gates', 'LC']);
  expectFail(A(d, ['handoff', 'LC', 'DONE']), 'DONE before knowledge/report');
  finishDone(d); must(d, ['delivery-check', 'LC']); must(d, ['validate', 'LC']); must(d, ['verify-seal', 'LC']);
  expectState(d, 'handoff', 'state', 'DONE');
  const runYaml = `${RUN}/RUN.yaml`; const runBak = rd(d, runYaml);
  wr(d, runYaml, sedSection(runBak, 'handoff', /state: ".*"/, 'state: "IMPLEMENTING"'));
  expectFail(A(d, ['verify-seal', 'LC']), 'hand-rewound handoff.state passed verify-seal');
  expectFail(A(d, ['validate', 'LC']), 'hand-rewound handoff.state passed validate');
  expectFail(A(d, ['delivery-check', 'LC']), 'hand-rewound handoff.state passed delivery-check');
  wr(d, runYaml, runBak);
  wr(d, runYaml, sedLines(runBak, /published: "true"/, 'published: "false"'));
  expectFail(A(d, ['verify-seal', 'LC']), 'hand-edited completion_report.published passed verify-seal');
  wr(d, runYaml, sedSection(runBak, 'pipeline', /tier: ".*"/, 'tier: "docs"'));
  expectFail(A(d, ['verify-seal', 'LC']), 'hand-lowered tier passed verify-seal');
  wr(d, runYaml, sedSection(runBak, 'pipeline', /classification: ".*"/, 'classification: "TRIVIAL"'));
  expectFail(A(d, ['verify-seal', 'LC']), 'hand-edited classification passed verify-seal');
  wr(d, runYaml, runBak); must(d, ['verify-seal', 'LC']);
  // the reopen: explicit, authorized, audited, fail-closed
  const implFinal = readFileSync(p('impl.txt'));
  const reason = 'post-DONE review found the key handling is still wrong for whitespace'; const instr = 'trim the key before lookup and add a regression test for it';
  expectFail(amendAs(d, 'implementer', reason, 'impl.txt', instr, 'the user'), 'amend by a non-lead role');
  expectFail(amendAs(d, 'lead', reason, 'impl.txt', instr, ''), 'amend without an authorizer');
  expectFail(amendAs(d, 'lead', 'not needed', 'impl.txt', instr, 'the user'), 'amend with a generic reason');
  expectFail(amendAs(d, 'lead', reason, 'outside.txt', instr, 'the user'), 'amend with fix_scope outside the frozen plan');
  refused(amendAs(d, 'lead', reason, ':lookupKey', instr, 'the user'), 'amend with a symbol-only fix_scope', 'fix_scope has no path');
  refused(amendAs(d, 'lead', reason, 'outside.txt:lookupKey', instr, 'the user'), 'amend with a path:symbol fix_scope outside the frozen plan', 'outside the frozen scope');
  accepted(amendAs(d, 'lead', reason, 'impl.txt:lookupKey', instr, 'the user (explicit reopen request)'), 'amend');
  expectState(d, 'execution', 'state', 'AMENDING'); expectState(d, 'handoff', 'state', 'IMPLEMENTING'); expectState(d, 'completion_report', 'published', 'false');
  const reopen = () => lsDir(d, `${RUN}/gates`).filter((n) => n.endsWith('-REOPEN.yaml')).map((n) => rd(d, `${RUN}/gates/${n}`)).join('\n');
  assert.match(reopen(), /^previous_handoff_state: "DONE"/m);
  assert.match(reopen(), /^fix_scope: impl\.txt$/m, 'REOPEN record kept the symbol of a path:symbol fix_scope');
  assert.ok(lsDir(d, `${RUN}/gates`).some((n) => n.endsWith('-REOPEN.completion-report.md')), 'no REOPEN completion-report copy');
  expectFail(A(d, ['handoff', 'LC', 'DONE']), 'DONE straight after reopen');
  appendFileSync(p('impl.txt'), 'lead hot-fix\n');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'lead hot-fix reached IMPLEMENTED after reopen');
  writeFileSync(p('impl.txt'), implFinal);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: trim the key before lookup');
  // A200: the pages the first run's knowledge step wrote are not task changes outside the fix scope; a stray product file still is
  mkdirSync(p('docs/wiki'), { recursive: true }); writeFileSync(p('docs/wiki/kpage.md'), '# page\n'); writeFileSync(p('stray-product.txt'), 'stray\n');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), "a stray product file passed the fix round's IMPLEMENTED");
  rmSync(p('stray-product.txt'), { force: true });
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  rmSync(p('docs'), { recursive: true, force: true });
  passAllGates(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']); writeReport(d);
  expectFail(A(d, ['publish-completion-report', 'LC', 'markdown']), 'report without Reopen History accepted for a reopened run');
  writeReport(d, '', '## Reopen History', 'Reopened once after DONE: whitespace keys; fixed by the worker; re-reviewed and re-verified.');
  must(d, ['publish-completion-report', 'LC', 'markdown']); must(d, ['handoff', 'LC', 'DONE']);
  must(d, ['delivery-check', 'LC']); must(d, ['validate', 'LC']);
  const ledger = `${RUN}/LEDGER.log`; const ledgerBak = rd(d, ledger);
  assert.equal(ledgerBak.split('\n').filter((l) => l.includes('event=REOPEN')).length, 1);
  wr(d, ledger, ledgerBak.split('\n').map((l, i) => (i === 1 ? l.replace(/role=[a-z_]*/, 'role=implementer') : l)).join('\n'));
  expectFail(A(d, ['verify-seal', 'LC']), 'edited ledger entry passed verify-seal');
  wr(d, ledger, ledgerBak.split('\n').filter((_, i) => i !== 1).join('\n'));
  expectFail(A(d, ['verify-seal', 'LC']), 'deleted ledger entry passed verify-seal');
  wr(d, ledger, ledgerBak); must(d, ['verify-seal', 'LC']);
  expectFail(AS(d, 'verifier', ['cleanup', 'LC']), 'cleanup by a non-lead');
  const implDone = readFileSync(p('impl.txt')); appendFileSync(p('impl.txt'), 'edited after DONE\n');
  expectFail(A(d, ['cleanup', 'LC']), 'cleanup accepted a run whose content changed after DONE');
  writeFileSync(p('impl.txt'), implDone);
  mkdirSync(p('.agents/local/assignments/LC'), { recursive: true }); mkdirSync(p('.agents/local/assignments/OTHER'), { recursive: true });
  writeFileSync(p('.agents/local/assignments/LC/a.md'), ''); writeFileSync(p('.agents/local/assignments/OTHER/b.md'), '');
  must(d, ['cleanup', 'LC']);
  assert.ok(!existsSync(p('.agents/local/assignments/LC')) && existsSync(p('.agents/local/assignments/OTHER/b.md')), "cleanup did not remove only the run's assignments directory (A116)");
  rmSync(p('.agents/local/assignments/OTHER'), { recursive: true, force: true });
  // A200: the records went to a compressed archive (readable, holds the ledger) before the run folder was deleted; the newest archive.keep runs stay
  const archives = lsDir(d, '.agents/local/archive/LC').filter((n) => /^LC-.*\.tar\.gz$/.test(n));
  assert.ok(archives.length > 0, 'cleanup left no evidence archive under .agents/local/archive/LC (A200)');
  const tar = spawnSync('tar', ['-tzf', p(`.agents/local/archive/LC/${archives[0]}`)], { encoding: 'utf8' });
  assert.equal(tar.status, 0, 'the evidence archive is not readable');
  assert.ok(tar.stdout.includes('LC/LEDGER.log'), "the evidence archive does not hold the run's ledger (A200)");
  assert.ok(!existsSync(p(RUN)) && rd(d, '.agents/local/ACTIVE_RUN').trim() === '');
  assert.ok(A(d, ['status']).out.split('\n').includes('active_task=none'));
});

/** pass_all of the shell scenarios (the harness's passAll). @param {string} d */
function passAllGates(d) {
  for (const g of pipe(d, 'gates').split(/\s+/).filter(Boolean)) {
    if (g === 'VERIFY') continue;
    if (g === 'SECRETS') must(d, ['secret-scan', 'LC']); else gpass(d, g);
  }
  for (const m of A(d, ['pipeline', 'LC']).out.matchAll(/^focus\.([A-Z_]*)\.([a-z]*)=.*$/gm)) gpass(d, m[1], { focus: m[2] });
  gpass(d, 'VERIFY');
}

// Orchestrated attribution: a change made outside the implementer is detected before and after the gates.
test('attribution: a change made outside the implementer is detected before and after the gates', () => {
  const d = project({ topology: 'orchestrated' });
  orchImplemented(d);
  passAllGates(d);
  const keep = readFileSync(path.join(d, 'impl.txt')); appendFileSync(path.join(d, 'impl.txt'), 'late lead edit\n');
  expectFail(A(d, ['verify-handoff', 'LC']), 'post-gate lead edit passed verify-handoff');
  expectFail(recTry(d, 'VERIFY', 'PASS'), 'a gate recorded over an unattributed edit');
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE over an unattributed edit');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 're-asserting IMPLEMENTED laundered an unattributed edit');
  expectFail(A(d, ['window-close', 'LC', A(d, ['patch-fingerprint', 'LC']).out.replace(/\n+$/, ''), '0']), 'worker window closed outside IMPLEMENTING');
  writeFileSync(path.join(d, 'impl.txt'), keep);
  must(d, ['verify-handoff', 'LC']); must(d, ['handoff', 'LC', 'CODE_DONE']);
});

test('tree_forged: a hand-written window of role user, not bound in the ledger by tree-accept, attests nothing', () => {
  const d = project({ topology: 'orchestrated' });
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');   // not yet IMPLEMENTED: the forged window must be refused by the evidence check itself
  const b = must(d, ['patch-fingerprint', 'LC']).out.replace(/\n+$/, ''); appendFileSync(path.join(d, 'impl.txt'), 'forged\n'); const a = must(d, ['patch-fingerprint', 'LC']).out.replace(/\n+$/, '');
  const w = `${RUN}/worker-evidence`; const n = lsDir(d, w).filter((f) => /^WINDOW-.*\.yaml$/.test(f)).length + 1;
  wr(d, `${w}/WINDOW-${n}.yaml`, `task_id: "LC"\nseq: ${n}\nrole: "user"\ntopology: "orchestrated"\nbefore_sha256: "${b}"\nafter_sha256: "${a}"\nexit_status: "0"\n`);
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a hand-written user window attested a change', 'no tree-accept command bound it');
});

// Fix loop: a fix stays inside its findings' fix_scope, at most review.max_fix_rounds rounds per frozen contract, and an amendment + refreeze returns the
// run to IMPLEMENTING with a fresh budget.
test('bounded_fix: fix loop bound, fix_scope and amendment escalation', () => {
  const d = split(); const p = (/** @type {string} */ f) => path.join(d, f);
  orchImplemented(d);
  gfail(d, 'REVIEW_SMALL', 'impl_test.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  const keep = readFileSync(p('impl.txt'));
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: tweak outside the finding');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), "fix outside the finding's fix_scope reached IMPLEMENTED", "outside the finding's fix_scope");
  { const w = wopen(d); writeFileSync(p('impl.txt'), keep); appendFileSync(p('impl_test.txt'), 'test: default for an empty key\n'); wev(d, 'FIX', 'pass', { target: 'impl_test.txt' }); wclose(d, w); }
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);                                             // round 1
  gfail(d, 'QA', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);                // round 2: any gate's finding counts
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED with no change since the finding');
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt at the empty key default');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'VERIFY', 'impl.txt');                                                         // third failing content: rounds exhausted
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a third fix was allowed', 'fix rounds exhausted');
  assert.ok(A(d, ['report-facts', 'LC']).out.includes('- Fix rounds: 2 of 2'), 'the report counts the unfixed third failing content as a fix round (3 of 2)');
  expectFail(A(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: \n' }), 'FAILED accepted without evidence');
  mkdirSync(p(`${RUN}/amendments`), { recursive: true }); writeFileSync(p(`${RUN}/amendments/001.md`), '# amendment 001: the plan must cover the empty-key contract\n');
  appendFileSync(p(`${RUN}/PLAN.md`), 'amended: empty-key contract\n');
  expectFail(A(d, ['refreeze', 'LC', 'missing.md'], { bind: true }), 'refreeze without an amendment file');
  // D15/B4: the exhausted budget is reset only with the user's budget approval for this PLAN.md
  refused(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'a refreeze reset an exhausted fix budget without the user', 'budget approval');
  approveAsUser(d, 'budget', 'approve budget');
  ok(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'refreeze');
  assert.equal(pipe(d, 'fix_round'), '0', 'refreeze did not start a fresh budget');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING'); expectState(d, 'handoff', 'implemented_patch_sha256', 'PENDING');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED on pre-amendment evidence');
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: empty key returns the documented default');
  worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: empty key returns the documented default');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  passAllGates(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']); writeReport(d, '', '## Amendments', 'Amendment 001 after three failing rounds.');
  must(d, ['publish-completion-report', 'LC', 'markdown']); must(d, ['handoff', 'LC', 'DONE']);
  must(d, ['validate', 'LC']);
});

// fix_scope is the union of the findings' paths on the failing content; whitespace in a list is ignored.
test('fix_scope_format: the union of blocking finding paths, info rows excluded', () => {
  const d = split();
  orchImplemented(d);
  rec(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-1|blocking|impl.txt:3|wrong default|traced; scan: grep -n lookup impl.txt; instances: single', 'REVIEW_SMALL-2|blocking|impl_test.txt:9|hollow assertion|traced; scan: grep -n lookup impl.txt; instances: single', 'REVIEW_SMALL-3|info|other.txt:1|suspicion only|none']);
  assert.match(gateText(d, 'REVIEW_SMALL'), /^fix_scope: impl\.txt,impl_test\.txt$/m, 'fix_scope is not the union of blocking finding paths');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl_test.txt', 'test: empty key returns the documented default');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'QA', 'impl_test.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: a path that the finding did not list');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a fix outside the listed fix_scope reached IMPLEMENTED', "outside the finding's fix_scope");
});

// A77: a fix_scope entry `path:symbol` (gate row or amendment) scopes to its path; a path outside still fails.
test('fix_scope_symbol: path:symbol scopes to its path', () => {
  const d = split(); const p = (/** @type {string} */ f) => path.join(d, f);
  orchImplemented(d);
  rec(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-1|blocking|impl_test.txt:TestLookup|hollow assertion|traced; scan: grep -n lookup impl.txt; instances: single']);
  assert.match(gateText(d, 'REVIEW_SMALL'), /^fix_scope: impl_test\.txt$/m, 'fix_scope kept the symbol of a path:symbol finding');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  const keep = readFileSync(p('impl.txt'));
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: a path that the finding did not list');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a fix outside a path:symbol fix_scope reached IMPLEMENTED', "outside the finding's fix_scope");
  { const w = wopen(d); writeFileSync(p('impl.txt'), keep); appendFileSync(p('impl_test.txt'), 'test: the symbol named in the finding asserts the value\n'); wev(d, 'FIX', 'pass', { target: 'impl_test.txt' }); wclose(d, w); }
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
});

// A123: a fix may also touch a frozen plan-scope path that shares an acceptance criterion with a failing finding's path; a plan path with no shared
// criterion, a path outside the plan and a finding path outside the plan stay refused.
test('fix_scope_shared_criteria: fix_scope widens to plan paths sharing a criterion only', () => {
  const d = project({ topology: 'orchestrated', scopeOther: 'AC-2', scopeExtra: 'AC-1', taskExtra: '- AC-2: second behavior' }); const p = (/** @type {string} */ f) => path.join(d, f);
  orchImplemented(d);
  gfail(d, 'REVIEW_SMALL', 'impl.txt');
  assert.match(gateText(d, 'REVIEW_SMALL'), /^fix_scope: impl\.txt$/m, "the gate record's fix_scope was widened");
  const next = nextOut(d);
  assert.equal(`${fixPaths(next).sort().join(' ')} `, 'fix_path=impl.txt fix_path=impl_test.txt fix_path=other.txt ', `next did not list the allowed fix paths (finding path and shared-criterion siblings): ${fixPaths(next).join(' ')}`);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  assert.ok(nextOut(d).split('\n').includes('fix_path=other.txt'), 'next kept no allowed fix paths while the fix round is open');
  const keep = readFileSync(p('far.txt'));
  worker(d, 'FIX', 'pass', 'far.txt', 'far: a plan path with another criterion');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a plan path sharing no criterion reached IMPLEMENTED', "outside the finding's fix_scope");
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'the refusal did not list the allowed fix paths', '  other.txt');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'the refusal did not name the scope approval and refreeze route', 'agent.sh refreeze');
  { const w = wopen(d); writeFileSync(p('far.txt'), keep); writeFileSync(p('z.txt'), 'z\n'); wev(d, 'FIX', 'pass'); wclose(d, w); }
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a path outside the plan reached IMPLEMENTED');
  rmSync(p('z.txt'), { force: true });
  worker(d, 'FIX', 'pass', 'other.txt', 'other: a plan path sharing AC-1 with the finding');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
});

// A127: a gate failure the plan answers (a row on PLAN.md or another control artifact) routes to amendment and refreeze, never to a fix round on control
// artifacts; a code row keeps its fix round, a product path sharing a directory name with a control folder stays a fix path, and the amend route is walked
// to the end (new plan hash: evidence and gates again).
test('plan_level_verify_fail: a plan-level gate failure routes to amendment and refreeze; the route ends at CODE_DONE', () => {
  const d = project({ topology: 'orchestrated' }); const p = (/** @type {string} */ f) => path.join(d, f);
  orchImplemented(d);
  gfail(d, 'VERIFY', 'PLAN.md');
  let next = nextOut(d);
  assert.deepEqual(fixPaths(next), [], `a plan-level VERIFY failure printed fix paths: ${fixPaths(next).join(' ')}`);
  assert.ok(!next.includes('fix round'), 'a plan-level VERIFY failure opened a fix round');
  assert.match(next, /^next=amend PLAN\.md ## Verification commands \(lead owns it.*agent\.sh refreeze LC <AMENDMENT>; a scope approval is needed only if the amendment adds scope paths/m, `next did not print the plan-level route: ${next}`);
  assert.match(next, /voids the worker evidence and every gate: dispatch\.sh LC implementer re-records RED and GREEN.*handoff LC IMPLEMENTED/, 'next did not print the evidence and gate steps after the refreeze');
  assert.ok(next.includes('no honest RED'), 'next did not say a commands-only amendment has no honest RED');
  // a VERIFY row about code whose text only mentions verification commands is a code row
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-2|blocking|impl.txt:1|verification commands fail: expected 3 got 2|traced: npm test']);
  next = nextOut(d);
  assert.ok(next.split('\n').includes('fix_path=impl.txt') && next.includes('fix round') && !next.includes('refreeze LC <AMENDMENT>'), `a code row mentioning verification commands lost its fix round: ${next}`);
  // a product path sharing a directory name with a control folder stays a fix path
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-3|blocking|reports/x.csv:2|the export has a wrong column|traced: csv']);
  assert.ok(nextOut(d).split('\n').includes('fix_path=reports/x.csv'), 'a product path under reports/ was dropped from the fix paths');
  // a code row plus a script row on a control path keeps the code fix round
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-4|blocking|impl.txt:1|lookup is wrong|traced: x', 'VERIFY-5|blocking|PLAN.md:1|UNSUPPORTED measurement missing|traced: y']);
  next = nextOut(d);
  assert.ok(next.includes('fix round') && !next.split('\n').includes('fix_path=PLAN.md'), `a script row on a control path displaced the code fix round: ${next}`);
  // A107 rows get their own hint: re-dispatch the verifier, or amend when the command is missing from the plan
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-6|blocking|impl.txt:1|AC proof cites `ls` which cannot be re-run|traced: z']);
  assert.ok(nextOut(d).includes('re-dispatch the verifier citing only a configured or planned command'), 'an A107 row got no verifier re-dispatch hint');
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-7|blocking|PLAN.md:1|AC-2 has no eligible command proof|traced: PLAN.md commands']);
  assert.ok(!nextOut(d).includes('fixed in PLAN.md front matter'), 'a row without a scope-mapping complaint got the criteria hint');
  // A129: an AC mapped to no scope path names the right edit target, the front matter `criteria:`, not only Verification commands
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-8|blocking|PLAN.md:1|PLAN maps AC-2 to no scope path; command proof requires tdd_exemption on every mapped PLAN scope path|traced: PLAN.md scope']);
  next = nextOut(d);
  assert.ok(next.includes('is fixed in PLAN.md front matter: add the AC to `criteria:` of the scope entries that implement it, and plan a command that proves it'), `next did not name the criteria edit target: ${next}`);
  assert.ok(next.includes('refreeze LC <AMENDMENT>'), 'the criteria hint displaced the amendment route');
  rec(d, 'VERIFY', 'FAIL', ['VERIFY-7|blocking|PLAN.md:1|AC-2 has no eligible command proof|traced: PLAN.md commands']);
  // the recovery needs no scope approval when the amendment adds no scope path
  mkdirSync(p(`${RUN}/amendments`), { recursive: true }); writeFileSync(p(`${RUN}/amendments/001.md`), '# amendment 001: add positive verification commands\n');
  appendFileSync(p(`${RUN}/PLAN.md`), 'amended: positive verification commands\n');
  accepted(A(d, ['refreeze', 'LC', '001.md'], { bind: true }), 'a refreeze that adds no scope path asked for a scope approval');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  // the new plan hash voids the worker evidence and the gates: the implementer records RED and GREEN again
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED on evidence bound to the old plan', 'worker-evidence verification failed');
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the default for the amended plan'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the default for the amended plan');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  expectFail(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE on gates of the old plan');
  passAllGates(d); must(d, ['handoff', 'LC', 'CODE_DONE']);
});

test('fix_scope_no_criteria: a finding path with no plan criterion widens nothing', () => {
  const d = project({ topology: 'orchestrated' });
  orchImplemented(d);
  gfail(d, 'REVIEW_SMALL', 'z.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: the finding path is outside the plan, so it carries no criterion');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'a finding outside the plan widened the fix scope', "outside the finding's fix_scope");
});

// An amendment that changes any frozen artifact starts a fresh fix budget.
test('amendment_fresh_budget: an amendment starts a fresh fix budget', () => {
  const d = project({ topology: 'orchestrated' }); const p = (/** @type {string} */ f) => path.join(d, f);
  orchImplemented(d);
  gfail(d, 'REVIEW_SMALL', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  mkdirSync(p(`${RUN}/amendments`), { recursive: true }); writeFileSync(p(`${RUN}/amendments/001.md`), '# amendment 001: the QA plan misstated a scenario\n');
  appendFileSync(p(`${RUN}/QA_PLAN.md`), '- QA-2 (AC-1): clarified scenario\n');
  must(d, ['refreeze', 'LC', '001.md'], { bind: true });
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.equal(pipe(d, 'fix_round'), '0', 'the amendment did not reset the fix rounds');
  gfail(d, 'QA', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: first attempt after the amendment'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'VERIFY', 'impl.txt'); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt after the amendment'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'REVIEW_SMALL', 'impl.txt');
  expectFail(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a third fix was allowed after the amendment');
});
