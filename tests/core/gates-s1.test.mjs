// @ts-check
// gates-test.sh scenarios sc_record .. sc_question_language (lines 24-542) as Node tests (176-D1). Every assertion, attack input and message of the shell
// scenario is kept. The control plane under test is the real one; the fixture is the harness's.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { A, AS, accepted, approveAsUser, capture, expectFail, gateStatus, must, pipe, project, refused, rv, tmp, tsha, worker, wopen, wev, wclose, solo, gpass, gfail, rec, resultFor } from '../lib/harness.mjs';
import { Aasync, chmodTree, gateText, implemented, linesWith, lsDir, nGates, recTry } from './gates-s1-lib.mjs';

const RUN = '.agents/runs/LC';
const rd = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(path.join(d, f), 'utf8');
const wr = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };
/** A scratch file outside the project. @param {string} name @param {string} text */
const scratch = (name, text) => { const f = path.join(tmp('s'), name); writeFileSync(f, text); return f; };
/** The result file with one line replaced (sed on a header line). @param {string} f @param {RegExp} re @param {string} to */
const edit = (f, re, to) => scratch('r.md', readFileSync(f, 'utf8').replace(re, to));
const orch = () => project({ topology: 'orchestrated' });
const lines = (/** @type {string} */ t) => t.split('\n');
/** @param {string} d @param {string} gate */
const gst = (d, gate) => gateStatus(d, gate);
/** @param {string} d @param {string} sub */
const explorerReports = (d, sub = 'reports') => lsDir(d, `${RUN}/${sub}`).filter((n) => /^\d{3}-explorer\.md$/.test(n));
/** A live process that is not the parent of the control plane (a lock held by our direct parent counts as inherited): its pid is the lock holder. */
function holder() { const c = spawn('sleep', ['600'], { stdio: 'ignore' }); c.unref(); return /** @type {import('node:child_process').ChildProcess & { pid: number }} */ (c); }
const ZERO = '0'.repeat(64);

test('sc_record: role, fingerprint, artifact, header, focus, findings, pass_low, result naming, qa task result', () => {
  const d = orch(); implemented(d, 'orchestrated');
  const before = nGates(d);
  let f = resultFor(d, 'REVIEW_SMALL', 'PASS');
  const rev = (/** @type {string} */ file) => AS(d, 'reviewer', ['record', 'LC', '--file', file]);
  refused(AS(d, 'qa', ['record', 'LC', '--file', f]), 'a wrong role recorded', 'does not match AGENT_ROLE');
  refused(rev(edit(f, /^FINGERPRINT: .*/m, 'FINGERPRINT: 0123456789abcdef0123456789abcdef01234567')), 'a stale fingerprint was accepted', 'stale');
  refused(rev(edit(f, /^(ARTIFACT: [^ ]*) .*/m, `$1 ${ZERO}`)), 'a bad artifact hash was accepted', 'sha256 mismatch');
  refused(rev(edit(f, /^ARTIFACT: .*/m, `ARTIFACT: ../../../impl.txt ${tsha(path.join(d, 'impl.txt'))}`)), 'an artifact outside the run was accepted', 'run-relative');
  const plan = `${RUN}/reviews/proof-review/plan`; const other = `${RUN}/reviews/proof-review/other`;
  wr(d, `${plan}/REPORT.md`, 'Verdict: PASS\n'); wr(d, `${other}/REPORT.md`, 'Verdict: PASS\n');
  refused(rev(edit(f, /^ARTIFACT: .*/m, `ARTIFACT: reviews/proof-review/plan/REPORT.md ${tsha(path.join(d, plan, 'REPORT.md'))}`)), "a rules+tests result used the plan focus's artifact", 'outside the paths');
  refused(rev(edit(f, /^ARTIFACT: .*/m, `ARTIFACT: reviews/proof-review/other/REPORT.md ${tsha(path.join(d, other, 'REPORT.md'))}`)), 'an unregistered review directory was accepted', 'not a registered run artifact');
  rmSync(path.join(d, plan), { recursive: true }); rmSync(path.join(d, other), { recursive: true });
  refused(rev(scratch('r.md', readFileSync(f, 'utf8').split('\n').filter((l) => !l.startsWith('CONFIDENCE:')).join('\n'))), 'a header without CONFIDENCE was accepted', 'malformed header');
  refused(rev(scratch('r.md', `Here is my review.\n${readFileSync(f, 'utf8')}`)), 'a result not starting with the header was accepted', 'malformed header');
  refused(rev(edit(f, /^FOCUS: .*/m, 'FOCUS: bugs')), 'an unknown FOCUS was accepted', 'FOCUS');
  refused(rev(edit(f, /^RESULT: .*/m, 'RESULT: NEEDS_INPUT')), 'a gate role returned NEEDS_INPUT', 'not valid for role reviewer');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-1|info|impl.txt:1|suspicion|none']), 'a FAIL with only info rows was accepted', 'at least one blocking');
  refused(recTry(d, 'REVIEW_SMALL', 'PASS', ['REVIEW_SMALL-1|blocking|impl.txt:1|real bug|traced']), 'a PASS with a blocking row was accepted', 'PASS cannot carry');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', ['QA-1|blocking|impl.txt:1|real bug|traced']), 'a finding id of another gate was accepted', 'want REVIEW_SMALL-<n>');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-1|HIGH|impl.txt:1|real bug|traced']), 'a severity outside blocking|info was accepted', 'severity');
  for (const placeholder of ['(none)', 'none', '-', 'n/a']) {
    refused(recTry(d, 'REVIEW_SMALL', 'PASS', [`${placeholder}|info|-|no findings|none`]), `a placeholder finding was accepted: ${placeholder}`, 'no findings: omit rows, keep only the table header');
  }
  assert.equal(nGates(d), before, 'a rejected result left a gate record');
  assert.ok(lsDir(d, `${RUN}/results`).length === 0, 'a rejected result left a results file');
  // low confidence: recorded as pass_low and does not satisfy the gate
  rec(d, 'REVIEW_SMALL', 'PASS', [], { confidence: 'low' });
  assert.equal(gst(d, 'REVIEW_SMALL'), 'pass_low', 'low-confidence PASS is not pass_low');
  must(d, ['secret-scan', 'LC']); gpass(d, 'QA'); gpass(d, 'VERIFY');
  refused(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE counted a pass_low', 'REVIEW_SMALL of LC is pass_low');
  // a skill-owned results file is never overwritten; record writes NNN-<role>.result.md
  wr(d, `${RUN}/results/005-explorer.md`, '# explorer evidence\n');
  gpass(d, 'REVIEW_SMALL');
  assert.ok(existsSync(path.join(d, `${RUN}/results/006-reviewer.result.md`)), 'record did not write NNN-<role>.result.md');
  assert.equal(rd(d, `${RUN}/results/005-explorer.md`).replace(/\n$/, ''), '# explorer evidence');
  assert.ok(gateText(d, 'REVIEW_SMALL').includes(`result_sha256: "${tsha(path.join(d, `${RUN}/results/006-reviewer.result.md`))}"`), 'the gate does not bind the raw result sha256');
  assert.match(rd(d, `${RUN}/LEDGER.log`), /event=record:reviewer:PASS .*sha256=/, 'record is not ledgered with the raw sha256');
  f = resultFor(d, 'REVIEW_SMALL', 'PASS');
  const real = realpathSync(d);
  accepted(rev(scratch('r.md', readFileSync(f, 'utf8').replace(/^ARTIFACT: /m, `ARTIFACT: ${real}/${RUN}/`))), 'absolute in-run artifact');
  assert.match(gateText(d, 'REVIEW_SMALL'), /^artifact: "reviews\/proof-review\/small\//m, 'absolute in-run artifact was not normalized');
  accepted(rev(scratch('r.md', readFileSync(f, 'utf8').replace(/^ARTIFACT: /m, `ARTIFACT: ${RUN}/`))), 'project-relative in-run artifact');
  assert.match(gateText(d, 'REVIEW_SMALL'), /^artifact: "reviews\/proof-review\/small\//m, 'project-relative in-run artifact was not normalized');
  refused(rev(edit(f, /^ARTIFACT: .*/m, `ARTIFACT: ${RUN}/../../../impl.txt ${tsha(path.join(d, 'impl.txt'))}`)), 'project-relative artifact outside run was accepted', 'inside the run');
  const outside = tmp('outside'); writeFileSync(path.join(outside, 'REPORT.md'), 'Verdict: PASS\n');
  const small = `${RUN}/reviews/proof-review/small`;
  symlinkSync(outside, path.join(d, small, 'link'));
  refused(rev(edit(f, /^ARTIFACT: .*/m, `ARTIFACT: reviews/proof-review/small/link/REPORT.md ${tsha(path.join(outside, 'REPORT.md'))}`)), 'run-relative artifact resolving outside run was accepted', 'inside the run');
  rmSync(path.join(d, small, 'link'));
  refused(rev(edit(f, /^ARTIFACT: .*/m, `ARTIFACT: ${real}/impl.txt ${tsha(path.join(d, 'impl.txt'))}`)), 'absolute artifact outside run was accepted', 'inside the run');
  // qa task result (QA plan step) is a non-gate result
  const fp = must(d, ['fingerprint', 'LC']).out.replace(/\n+$/, '');
  const qa = scratch('qa.md', `ROLE: qa\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: ${fp}\nARTIFACT: QA_PLAN.md ${tsha(path.join(d, RUN, 'QA_PLAN.md'))}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n`);
  const n = nGates(d); accepted(AS(d, 'qa', ['record', 'LC', '--file', qa]), 'qa task result');
  assert.equal(nGates(d), n, 'a qa task result created a gate record');
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE');
});

test('sc_submit: script-built header, normalized artifact, derived result, assigned ids, rejection status, BLOCKED report', () => {
  const d = orch(); implemented(d, 'orchestrated');
  const small = `${RUN}/reviews/proof-review/small`; const real = realpathSync(d);
  const sub = (/** @type {string[]} */ a, /** @type {Parameters<typeof A>[2]} */ o = {}) => AS(d, 'reviewer', ['submit', 'LC', ...a], o);
  const submitted = `.agents/local/submissions`;
  refused(A(d, ['submit', 'LC', '--confidence', 'high']), 'the lead submitted', 'lead never submits');
  refused(sub(['--focus', 'rules+tests']), 'a missing confidence was accepted', '--confidence');
  refused(sub(['--confidence', 'high']), 'a reviewer without focus was accepted', 'need --focus');
  refused(sub(['--focus', 'rules+tests', '--confidence', 'high', '--agent', 'ag0']), 'a missing report was accepted', 'not found in the run');
  assert.match(rd(d, `${submitted}/ag0.status`), /^status=rejected/m, 'a rejection was not written to the submission status');
  wr(d, `${small}/REPORT.md`, 'review of the whole current tree\n');
  // no header, fingerprint or hash is typed: the script supplies them; any path spelling of the report works
  accepted(sub(['--focus', 'rules+tests', '--confidence', 'high', '--agent', 'ag1']), 'submit');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'pass', 'submit did not record a pass');
  const s1 = rd(d, `${submitted}/ag1.status`);
  assert.ok(/^status=ok/m.test(s1) && /^gate=REVIEW_SMALL/m.test(s1), 'submission status is not ok');
  // A127: the token dispatch.sh exports wins over a typed --agent
  accepted(sub(['--focus', 'rules+tests', '--confidence', 'high', '--agent', 'typedtok'], { env: { PROOFLINE_AGENT: 'envtok' } }), 'submit with PROOFLINE_AGENT and --agent');
  assert.ok(/^status=ok/m.test(rd(d, `${submitted}/envtok.status`)) && !existsSync(path.join(d, `${submitted}/typedtok.status`)), 'a typed --agent displaced the dispatch token');
  // a subagent the hook registered (SubagentStart writes <id>.started) inside a dispatch worker keeps its own token
  writeFileSync(path.join(d, `${submitted}/subtok.started`), '');
  accepted(sub(['--focus', 'rules+tests', '--confidence', 'high', '--agent', 'subtok'], { env: { PROOFLINE_AGENT: 'envtok' } }), 'submit by a registered subagent');
  assert.match(rd(d, `${submitted}/subtok.status`), /^status=ok/m, "a registered subagent's token was displaced by the dispatch token");
  for (const art of [`${real}/${small}/REPORT.md`, '.agents/runs/LC/reviews/proof-review/small/REPORT.md', './.agents/runs/LC/reviews/proof-review/small/REPORT.md', 'reviews/proof-review/small/REPORT.md', './reviews/proof-review/small/REPORT.md']) {
    accepted(sub(['--artifact', art, '--confidence', 'high']), `artifact spelling not accepted: ${art}`);
  }
  assert.match(gateText(d, 'REVIEW_SMALL'), /^artifact: "reports\/snapshots\/[0-9a-f]{12}-reviewer-reviews_proof-review_small_REPORT.md"/m, 'artifact was not normalized to its immutable snapshot');
  refused(sub(['--focus', 'rules+tests', '--artifact', '../../../impl.txt', '--confidence', 'high']), 'an artifact outside the run was accepted', 'inside the run');
  refused(sub(['--focus', 'plan', '--artifact', 'reviews/proof-review/small/REPORT.md', '--confidence', 'high']), 'an artifact of another focus was accepted', 'outside the paths');
  // the result follows from the findings
  const rows = scratch('f.rows', 'blocking|impl.txt:1|lookup returns the wrong value for an empty key|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single\n');
  refused(sub(['--focus', 'rules+tests', '--result', 'PASS', '--findings', rows, '--confidence', 'high']), 'PASS with a blocking finding was accepted', 'contradicts');
  accepted(sub(['--focus', 'rules+tests', '--findings', rows, '--confidence', 'high']), 'submit with a blocking finding');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'fail', 'blocking findings did not fail the gate');
  assert.match(gateText(d, 'REVIEW_SMALL'), /^finding: REVIEW_SMALL-1\|blocking\|impl\.txt:1\|/m, 'finding ids are not assigned by the script');
  const md = scratch('f.md', '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| X-9 | info | impl.txt:2 | a note | seen |\n');
  accepted(sub(['--focus', 'rules+tests', '--findings', md, '--confidence', 'high']), 'submit a markdown table');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'pass', 'a markdown table with info rows did not pass');
  const bad = scratch('bad.rows', 'high|impl.txt:1|x|y\n');
  refused(sub(['--focus', 'rules+tests', '--findings', bad, '--confidence', 'high']), 'a bad severity was accepted', 'severity');
  // BLOCKED carries its reason into a report the script creates when none exists
  accepted(sub(['--focus', 'plan', '--result', 'BLOCKED', '--reason', 'no test runner in the sandbox', '--confidence', 'high', '--agent', 'ag2']), 'BLOCKED submit');
  assert.ok(rd(d, `${RUN}/reviews/proof-review/plan/REPORT.md`).includes('no test runner'), 'BLOCKED reason not written to the report');
  assert.notEqual(gst(d, 'REVIEW_PLAN'), 'pass', 'BLOCKED recorded a pass');
});

test('sc_language: non-English report and findings are rejected at submit; blockquotes, fences and one accented name pass', () => {
  const d = orch(); implemented(d, 'orchestrated');
  const small = `${RUN}/reviews/proof-review/small`;
  const sub = (/** @type {string[]} */ a) => AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', ...a]);
  const EN = 'run artifacts are English';
  wr(d, `${small}/REPORT.md`, 'Bu rapor Türkçe yazıldı: çok şöyle güzel.\n');
  refused(sub([]), 'a Turkish report was accepted', EN);
  // A171 (review): a quote line or a fence is exempt only when it repeats a captured user prompt, whatever the file
  wr(d, `${small}/REPORT.md`, 'The review is complete.\n\n> Kullanıcı isteği: sürümü düzelt\n');
  refused(sub([]), 'an invented quote block hid non-English text', EN);
  wr(d, `${small}/REPORT.md`, 'The review is complete.\n\n```\nşöyle üç ğ\n```\n');
  refused(sub([]), 'an invented fence hid non-English text', EN);
  wr(d, '.agents/local/prompts/history/1-aaaaaaaa.txt', 'Kullanıcı isteği: sürümü düzelt\nşöyle\n');
  wr(d, `${small}/REPORT.md`, 'The review is complete.\n\n> Kullanıcı isteği: sürümü düzelt\n\n```\nşöyle\n```\nJosé reviewed it.\n');
  accepted(sub([]), 'a quoted request / one accented name was refused');
  refused(sub(['--findings', scratch('tr.rows', 'blocking|impl.txt:1|değer üretilmiyor şöyle|traced; scan: grep -n lookup impl.txt; instances: single\n')]), 'Turkish findings were accepted', EN);
  refused(sub(['--findings', scratch('ag.rows', 'blocking|impl.txt:1|wrong value|agent.sh pipeline LC\n')]), 'a reviewer opted out of the scan rule with an agent.sh evidence prefix', 'reserved for rows the script adds');
});

test('sc_report_stdin: submit --report - is written by the script, role paths enforced; the tasks directory is outside the fingerprint; read-only object database', () => {
  const d = orch(); implemented(d, 'orchestrated');
  accepted(AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--report', '-'], { input: 'review of the whole current tree\n' }), 'submit --report -');
  assert.equal(rd(d, `${RUN}/reviews/proof-review/small/REPORT.md`).replace(/\n+$/, ''), 'review of the whole current tree', 'the report was not written from stdin');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'pass', 'report on stdin did not record a pass');
  refused(AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--artifact', 'reviews/proof-review/plan/REPORT.md', '--report', '-'], { input: 'x\n' }), "a report outside the role's paths", 'outside the paths');
  // the task-source file is bookkeeping: the control plane edits it after the gates
  const fpr = () => must(d, ['fingerprint', 'LC']).out.replace(/\n+$/, '');
  let fp = fpr(); wr(d, '.agents/tasks/LC-task.md', 'changed bookkeeping\n');
  assert.equal(fpr(), fp, 'the tasks directory changed the content fingerprint');
  // a read-only object database (a Codex workspace-write sandbox) still yields the same fingerprint
  fp = fpr(); appendFileSync(path.join(d, 'impl.txt'), 'new content\n'); const fp2 = fpr();
  const objects = path.join(d, '.git/objects');
  chmodTree(objects, false);
  let fpRo = ''; let r;
  try { r = A(d, ['fingerprint', 'LC']); fpRo = r.out.replace(/\n+$/, ''); } finally { chmodTree(objects, true); }
  assert.equal(r.status, 0, 'fingerprint failed with a read-only object database');
  assert.equal(fpRo, fp2, `read-only object database changed the fingerprint (${fpRo} vs ${fp2})`);
  assert.notEqual(fp2, fp, 'a content change did not change the fingerprint');
});

test('sc_stdin_contract: both-stdin refused, separator split, --findings none, info row (A104)', () => {
  const d = orch(); implemented(d, 'orchestrated');
  const rp = `${RUN}/reviews/proof-review/small/REPORT.md`;
  const sub = (/** @type {string[]} */ a, /** @type {string} */ input = '') => AS(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', ...a], { input });
  // two stdin sources are refused before stdin is read, with the corrected command in the message
  const both = sub(['--report', '-', '--findings', '-'], 'report text\n');
  assert.notEqual(both.status, 0, 'both-stdin was accepted');
  assert.match(both.text, /only one of --report\/--findings may read stdin[\s\S]*=== FINDINGS ===/, `both-stdin message wrong: ${both.text}`);
  // the documented separator splits one document
  accepted(sub(['--report', '-', '--findings', '-'], 'review of the tree\n\n=== FINDINGS ===\nblocking|impl.txt:1|wrong value|traced; scan: grep -n lookup impl.txt; instances: single\ninfo|impl.txt:2|a note|seen\n'), 'separator submit');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'fail', 'separator findings did not fail the gate');
  const rep = rd(d, rp);
  assert.ok(rep.includes('review of the tree') && !/FINDINGS|wrong value/.test(rep), 'report not split from the findings');
  // --findings none and an answer-only info row
  accepted(sub(['--report', '-', '--findings', 'none'], 'answer text\n'), '--findings none');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'pass', '--findings none did not pass');
  accepted(sub(['--findings', scratch('ans.rows', 'info|-|answer|the answer in one line\n')]), 'info row with path -');
  refused(sub(['--findings', scratch('prose.rows', 'prose, not a row\n')]), 'a prose row names the corrected form', '--findings none');
});

test('sc_report_names: submit allocates distinct explorer report names under parallel submits; a direct numbered write is refused; same token updates, new token gets a new name (A113)', async () => {
  const d = orch();
  const sub = (/** @type {string[]} */ a) => AS(d, 'explorer', ['submit', 'LC', '--result', 'DONE', '--confidence', 'high', '--findings', 'none', ...a]);
  const count = () => explorerReports(d).length;
  const reps = [1, 2, 3, 4].map((n) => scratch(`ag${n}-rep`, `report of explorer ${n}\n`));
  const outs = await Promise.all(reps.map((r, i) => Aasync(d, ['submit', 'LC', '--result', 'DONE', '--confidence', 'high', '--findings', 'none', '--report', r, '--artifact', 'reports/001-explorer.md', '--agent', `ag${i + 1}`], { role: 'explorer' })));
  for (const o of outs) assert.equal(o.status, 0, `parallel explorer submit failed: ${o.text}`);
  assert.equal(count(), 4, 'four parallel submits did not give four reports');
  const files = explorerReports(d);
  for (let n = 1; n <= 4; n++) assert.equal(files.filter((f) => lines(rd(d, `${RUN}/reports/${f}`)).includes(`report of explorer ${n}`)).length, 1, `the report of explorer ${n} was lost or duplicated`);
  const results = lsDir(d, `${RUN}/results`).filter((n) => /^\d{3}-explorer\.result\.md$/.test(n));
  assert.equal(results.length, 4, 'parallel results collided');
  assert.equal(lines(rd(d, `${RUN}/LEDGER.log`)).filter((l) => l.includes('event=record:explorer:DONE')).length, 4, 'not one ledger row per parallel submit');
  assert.equal(new Set(results.flatMap((n) => linesWith(rd(d, `${RUN}/results/${n}`), 'ARTIFACT: '))).size, 4, 'results cite a shared artifact');
  // the same dispatch updates its own report; a re-dispatch under a new token gets a new name
  writeFileSync(reps[0], 'report of explorer 1, revised\n');
  accepted(sub(['--report', reps[0], '--agent', 'ag1']), 'the same dispatch could not resubmit');
  assert.equal(count(), 4, 'a resubmit allocated a new report');
  assert.equal(explorerReports(d).filter((f) => lines(rd(d, `${RUN}/reports/${f}`)).includes('report of explorer 1, revised')).length, 1, 'the resubmit did not update its own report');
  const ag9 = scratch('ag9-rep', 'report of explorer 1, revised\n');
  accepted(sub(['--report', ag9, '--agent', 'ag9']), 'a re-dispatch was refused');
  assert.equal(count(), 5, 'a re-dispatch did not get its own name');
  // A132: a scratch file name without the caller's token (two parallel explorers both pick scratch/r.md) is refused
  let nrep = count();
  refused(sub(['--report', scratch('r.md', 'shared name\n'), '--agent', 'ag1']), 'a shared-name scratch report was accepted', 'carries its own agent token');
  assert.equal(count(), nrep, 'a refused shared-name report allocated a name');
  refused(sub(['--report', scratch('xag1-rep', 'embedded token\n'), '--agent', 'ag1']), 'a report name that only contains the token as a substring was accepted', 'carries its own agent token');
  // a direct write into a numbered explorer path is never an explorer artifact, whatever the spelling
  wr(d, `${RUN}/reports/009-explorer.md`, 'planted\n');
  for (const sp of ['reports/009-explorer.md', 'reports/./009-explorer.md', 'reports//009-explorer.md', './reports/./009-explorer.md', '.agents/runs/LC/reports/./009-explorer.md']) {
    refused(sub(['--artifact', sp, '--agent', 'ag1']), `a direct numbered explorer report was accepted: ${sp}`, 'hands its report over with --report');
    refused(sub(['--artifact', sp]), `a tokenless direct numbered explorer report was accepted: ${sp}`, 'hands its report over with --report');
  }
  // an empty report allocates nothing and leaves no owner entry
  nrep = count();
  refused(sub(['--report', scratch('agE-empty', ''), '--agent', 'agE']), 'an empty report was accepted', 'report is empty');
  assert.equal(count(), nrep, 'a refused empty report left a stub');
  assert.ok(!existsSync(path.join(d, `${RUN}/reports/.owners/agE`)), 'a refused empty report left an owner entry');
  // a refused submit after allocation (non-English report) rolls the allocation back
  const tr = sub(['--report', scratch('agT-tr', 'Bu rapor Türkçe yazıldı: çok şöyle güzel.\n'), '--agent', 'agT']);
  assert.notEqual(tr.status, 0, 'a non-English report was accepted');
  assert.equal(count(), nrep, 'a refused submit left an allocated stub');
  // BLOCKED without a report: the reason becomes the allocated report
  accepted(AS(d, 'explorer', ['submit', 'LC', '--result', 'BLOCKED', '--reason', 'no readable entry point in scope', '--confidence', 'high', '--agent', 'agK']), 'an explorer BLOCKED without a report');
  assert.ok(explorerReports(d).some((f) => rd(d, `${RUN}/reports/${f}`).includes('no readable entry point in scope')), 'the BLOCKED reason was not stored as the report');
  // a tokenless submit succeeds and gets a new name every time
  nrep = count();
  const tl = scratch('tl', 'tokenless report\n');
  accepted(sub(['--report', tl]), 'a tokenless explorer submit');
  accepted(sub(['--report', tl]), 'a second tokenless explorer submit');
  assert.equal(count(), nrep + 2, 'tokenless submits did not get a new name each');
  // record cannot cite another dispatch's live report either
  const live = explorerReports(d)[0];
  const fp = must(d, ['fingerprint', 'LC']).out.replace(/\n+$/, '');
  const foreign = scratch('foreign.raw', `ROLE: explorer\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: ${fp}\nARTIFACT: reports/${live} ${tsha(path.join(d, RUN, 'reports', live))}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n`);
  refused(AS(d, 'explorer', ['record', 'LC', '--file', foreign]), 'record cited a live explorer report', 'snapshot made by submit');
});

test('sc_explorer_limit: the explorer after max_explorers delivered reports is refused; BLOCKED and a lost dispatch hold no slot; a running one does; a limit of 0 is not checked; the count restarts at each freeze (A132)', () => {
  let d = orch();
  const decide = () => A(d, ['decide', 'LC', 'explorer', '--agent-path']);
  const sub = (/** @type {string[]} */ a) => AS(d, 'explorer', ['submit', 'LC', '--result', 'DONE', '--confidence', 'high', '--findings', 'none', ...a]);
  accepted(decide(), 'first explorer decide'); accepted(decide(), 'second (parallel) explorer decide');
  const r1 = scratch('ag1-rep', 'one\n'); const r2 = scratch('ag2-rep', 'two\n');
  // a BLOCKED result holds no slot: its retry (and a NEEDS_INPUT ANSWERS re-dispatch) is allowed
  accepted(AS(d, 'explorer', ['submit', 'LC', '--result', 'BLOCKED', '--reason', 'no entry point', '--confidence', 'high', '--agent', 'agB']), 'explorer BLOCKED submit');
  accepted(sub(['--report', r1, '--agent', 'ag1']), 'explorer 1 submit');
  // the same explorer resubmitting a revised report is still one slot (two result files, one allocated report)
  writeFileSync(r1, 'one revised\n');
  accepted(sub(['--report', r1, '--agent', 'ag1']), 'explorer 1 resubmit');
  assert.ok(lsDir(d, `${RUN}/results`).filter((n) => /^\d{3}-explorer\.result\.md$/.test(n)).length >= 3, 'the resubmit did not leave a second DONE result file');
  accepted(decide(), 'a decide after a BLOCKED result and one explorer resubmitting');
  // a live marker whose submission is already recorded is the delivered result, not a second slot
  wr(d, `${RUN}/dispatch/091-explorer-claude.running`, `pid=${process.pid}\nrole=explorer\n`);
  wr(d, '.agents/local/submissions/d091-explorer-claude.status', 'status=ok\n');
  accepted(decide(), 'a DONE result plus its own live marker was counted twice');
  rmSync(path.join(d, `${RUN}/dispatch/091-explorer-claude.running`), { force: true });
  // a running explorer dispatch occupies a slot: one DONE + one running = 2 of 2
  wr(d, `${RUN}/dispatch/090-explorer-claude.running`, `pid=${process.pid}\nrole=explorer\n`);
  refused(decide(), 'a parallel start beyond the limit was granted', '1 delivered result(s)');
  rmSync(path.join(d, `${RUN}/dispatch/090-explorer-claude.running`), { force: true });
  accepted(sub(['--report', r2, '--agent', 'ag2']), 'explorer 2 submit');
  refused(decide(), 'a third delivered explorer was granted', 'allows 2 explorer slot(s) (pipelines.COMPLEX.max_explorers) and run LC holds 2 delivered result(s)');
  // a limit of 0 is not checked, and the count restarts at each freeze
  d = project({ topology: 'standalone', cls: 'TRIVIAL', autonomy: 'manual' });
  accepted(decide(), 'an explorer decide on a limit of 0');
  d = project({ topology: 'standalone', cls: 'STANDARD', autonomy: 'manual' });
  writeFileSync(r1, 'one\n');
  accepted(sub(['--report', r1, '--agent', 'ag1']), 'pre-freeze explorer');
  refused(decide(), 'a second pre-freeze explorer was granted (STANDARD allows 1)', 'holds 1 delivered result(s)');
  accepted(A(d, ['freeze', 'LC'], { bind: true }), 'freeze');
  accepted(decide(), 'an explorer after the freeze (the count restarts at each freeze)');
});

test('sc_parallel_lock: parallel decide, ledger-note and record; stale and live locks', async () => {
  const d = orch(); implemented(d, 'orchestrated');
  writeFileSync(path.join(d, `${RUN}/COMPLETION_REPORT.md`), '# Completion Report: LC\n');
  const f = resultFor(d, 'REVIEW_SMALL', 'PASS');
  /** @type {Promise<import('./gates-s1-lib.mjs').Result>[]} */ const jobs = [];
  for (let i = 1; i <= 8; i++) {
    if (i % 2 === 0) { const pf = ({ 2: 'rules+tests', 4: 'plan', 6: 'tests' })[/** @type {2 | 4 | 6} */ (i)] ?? 'rules'; jobs.push(Aasync(d, ['decide', 'LC', 'reviewer', '--agent-path', '--focus', pf])); } // one --agent-path per role and focus (A171)
    else jobs.push(Aasync(d, ['ledger-note', 'LC', `parallel-${i}`]));
  }
  for (let i = 9; i <= 10; i++) jobs.push(Aasync(d, ['record', 'LC', '--file', f], { role: 'reviewer' }));
  const outs = await Promise.all(jobs);
  outs.forEach((o, i) => assert.equal(o.status, 0, `parallel command ${i + 1} failed: ${o.text}`));
  assert.ok(!existsSync(path.join(d, `${RUN}/.lock`)) && !existsSync(path.join(d, '.agents/local/.lock')), 'record left a lock after exit');
  accepted(A(d, ['verify-seal', 'LC']), 'verify-seal'); accepted(A(d, ['validate', 'LC']), 'validate');
  const led = rd(d, `${RUN}/LEDGER.log`).split('\n').filter((l) => l !== '');
  assert.ok(led.length >= 10 && led.every((l, i) => l.split(/\s/)[0].replace(/^seq=/, '') === String(i + 1)), 'parallel ledger sequence is broken');
  assert.equal(lsDir(d, `${RUN}/decisions`).filter((n) => /^\d{3}-/.test(n)).length, 4, 'parallel decisions collided');
  assert.equal(lsDir(d, `${RUN}/results`).filter((n) => /^\d{3}-reviewer\.result\.md$/.test(n)).length, 2, 'parallel results collided');
  assert.equal(lsDir(d, `${RUN}/gates`).filter((n) => /^\d{3}-REVIEW_SMALL\.yaml$/.test(n)).length, 2, 'parallel gates collided');
  mkdirSync(path.join(d, `${RUN}/.lock`)); writeFileSync(path.join(d, `${RUN}/.lock/pid`), '99999999\n');
  accepted(A(d, ['ledger-note', 'LC', 'stale']), 'stale lock was not broken');
  assert.match(rd(d, `${RUN}/LEDGER.log`), /event=lock-break .*stale lock holder pid=99999999/, 'stale lock break was not ledgered');
  const h = holder();
  try {
    mkdirSync(path.join(d, `${RUN}/.lock`)); writeFileSync(path.join(d, `${RUN}/.lock/pid`), `${h.pid}\n`);
    refused(A(d, ['ledger-note', 'LC', 'blocked'], { env: { PROOFLINE_LOCK_TIMEOUT: '1' } }), 'live lock did not time out', 'lock timeout after 1s');
  } finally { h.kill(); }
  rmSync(path.join(d, `${RUN}/.lock/pid`), { force: true }); rmdirSync(path.join(d, `${RUN}/.lock`));
  accepted(A(d, ['verify-seal', 'LC']), 'verify-seal'); accepted(A(d, ['validate', 'LC']), 'validate');
});

test('sc_lock_break_race: a holder that appears after the stale-pid read keeps the lock', () => {
  const d = orch();
  // a fake `cat` plays the holder: after the waiter's first read of the lock's pid it writes a live pid into the file
  const bin = tmp('fakebin'); const flag = path.join(tmp('flag'), 'fake-cat.flag');
  writeFileSync(path.join(bin, 'cat'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs'); const { spawnSync } = require('node:child_process');",
    'const a = process.argv.slice(2);',
    "if (a[0] && a[0].endsWith('/.lock/pid') && fs.existsSync(process.env.FAKE_CAT_FLAG)) {",
    "  fs.rmSync(process.env.FAKE_CAT_FLAG); process.stdout.write(fs.readFileSync(a[0])); fs.writeFileSync(a[0], process.env.FAKE_CAT_LIVE + '\\n'); process.exit(0);",
    '}',
    "process.exit(spawnSync('/bin/cat', a, { stdio: 'inherit' }).status ?? 1);", ''].join('\n'));
  chmodSync(path.join(bin, 'cat'), 0o755);
  mkdirSync(path.join(d, `${RUN}/.lock`)); writeFileSync(path.join(d, `${RUN}/.lock/pid`), '99999999\n');
  writeFileSync(flag, '');
  const h = holder();
  try {
    refused(A(d, ['hook-time', 'LC'], { env: { PATH: `${bin}:${process.env.PATH}`, FAKE_CAT_FLAG: flag, FAKE_CAT_LIVE: String(h.pid), PROOFLINE_LOCK_TIMEOUT: '1' } }),
      'a lock taken by a live holder after the stale read was broken', 'lock timeout after 1s');
    assert.ok(!existsSync(flag), 'the fake holder never took the lock (the race was not exercised)');
    assert.equal(rd(d, `${RUN}/.lock/pid`).replace(/\n+$/, ''), String(h.pid), 'the live holder lost its pid');
  } finally { h.kill(); }
  rmSync(path.join(d, `${RUN}/.lock/pid`), { force: true }); rmdirSync(path.join(d, `${RUN}/.lock`));
  accepted(A(d, ['ledger-note', 'LC', 'after']), 'the lock was not free after the live holder left');
});

test('sc_fix_loop: per-gate status, only stale gates listed, round-2 escalation, terminate FAILED', () => {
  const d = orch(); implemented(d, 'orchestrated');
  must(d, ['secret-scan', 'LC']); gfail(d, 'REVIEW_SMALL', 'impl.txt'); gpass(d, 'QA'); gpass(d, 'VERIFY');
  assert.ok(gst(d, 'REVIEW_SMALL') === 'fail' && gst(d, 'QA') === 'pass' && gst(d, 'SECRETS') === 'pass', 'the gates are not fail/pass/pass');
  assert.ok(linesWith(A(d, ['next', 'LC']).out, 'next=agent.sh handoff LC IMPLEMENTING (fix round 1').length > 0, 'next does not start fix round 1');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: empty key default'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.ok(gst(d, 'QA') === 'stale' && gst(d, 'REVIEW_SMALL') === 'stale', 'passes on older content are not stale');
  must(d, ['secret-scan', 'LC']); gpass(d, 'REVIEW_SMALL'); gpass(d, 'QA');
  const nx = A(d, ['next', 'LC']).out;
  assert.ok(linesWith(nx, 'next=').length === 1 && linesWith(nx, 'next=dispatch.sh LC verifier').length > 0, `next does not list only the stale gate: ${nx}`);
  gfail(d, 'VERIFY', 'impl.txt');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  assert.ok(pipe(d, 'fix_round') === '2' && pipe(d, 'escalation') === 'yes', 'round 2 does not set the escalation flag');
  must(d, ['decide', 'LC', 'implementer', '--agent-path']);
  assert.ok(lsDir(d, `${RUN}/decisions`).filter((n) => n.endsWith('-implementer.decision')).some((n) => rd(d, `${RUN}/decisions/${n}`).includes('signals=fix_round_2')), 'decide misses fix_round_2');
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: second attempt'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  gfail(d, 'REVIEW_SMALL', 'impl.txt');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a third round was allowed', 'fix rounds exhausted');
  assert.ok(linesWith(A(d, ['next', 'LC']).out, 'next=agent.sh terminate LC FAILED').length > 0, 'next does not point to terminate FAILED');
  accepted(A(d, ['terminate', 'LC', 'FAILED'], { input: 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: REVIEW_SMALL and VERIFY failed on all three contents\n' }), 'terminate FAILED');
  assert.equal(rv(d, 'execution', 'state'), 'FAILED');
});

test('sc_fix_round_missed_example: a missed example of an earlier revision is not a round; a re-cited or new line is (A171)', () => {
  const d = orch();
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  let w = wopen(d); appendFileSync(path.join(d, 'impl.txt'), 'impl: example one\nimpl: example two\n'); wev(d, 'GREEN', 'pass'); wclose(d, w);
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); must(d, ['secret-scan', 'LC']);
  gfail(d, 'REVIEW_SMALL', 'impl.txt');   // round 1 cites impl.txt:1
  assert.equal(pipe(d, 'fix_round'), '1', 'the first failing content is not round 1');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: fix of example one'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  // the next revision: the reviewer now cites impl.txt:2, a line of the previous revision that no finding cited
  rec(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-2|blocking|impl.txt:2|a second example of the same class|traced: example two; scan: grep -n example impl.txt; instances: single']);
  assert.equal(pipe(d, 'fix_round'), '1', 'a missed example used up a fix round');
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'the fix round after a missed example');
  worker(d, 'FIX', 'pass', 'impl.txt', 'impl: fix of example two'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  // re-citing the line that was already cited (the fix did not address it) is a real round
  rec(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-3|blocking|impl.txt:2|example two still not fixed|traced: example two; scan: grep -n example impl.txt; instances: single']);
  assert.equal(pipe(d, 'fix_round'), '2', 'a re-cited line did not count as a round');
  // a line that only exists in the latest revision (new code) is a real round too
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: third change'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  rec(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-4|blocking|impl.txt:5|new code from the last fix|traced: last fix; scan: grep -n fix impl.txt; instances: single']);
  assert.equal(pipe(d, 'fix_round'), '3', 'a finding on new code did not count as a round');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a round beyond the maximum', 'fix rounds exhausted');
});

test('sc_fix_round_copied_line: a new copy of an existing line is a round (A171)', () => {
  const d = orch();
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  const w = wopen(d); appendFileSync(path.join(d, 'impl.txt'), 'impl: example one\nimpl: dup\n'); wev(d, 'GREEN', 'pass'); wclose(d, w);
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); must(d, ['secret-scan', 'LC']);
  gfail(d, 'REVIEW_SMALL', 'impl.txt');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: dup'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  rec(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-2|blocking|impl.txt:3|the copy of the dup line is wrong|traced: copy; scan: grep -n dup impl.txt; instances: single']);
  assert.equal(pipe(d, 'fix_round'), '2', 'a copied line was treated as a missed example');
});

test('sc_scan_method: a rules finding names its scan and lists the instances, else it is rejected (A171)', () => {
  const d = orch(); implemented(d, 'orchestrated'); must(d, ['secret-scan', 'LC']);
  const row = (/** @type {string} */ ev) => [`REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|${ev}`];
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', row('traced')), 'a rules finding without a scan method', 'lacks scan:');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', row('scan: abcdef; instances: single')), 'a six-character scan passed', 'lacks scan:');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', row('scan: grep -rn lookup .')), 'a rules finding without the instances', 'lacks instances: single');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', row('scan: grep -rn lookup .; instances: other.txt:9')), 'instances that omit the row location', 'instances do not include the row location impl.txt:1');
  rec(d, 'REVIEW_SMALL', 'FAIL', row('scan: grep -rn lookup .; instances: impl.txt:1, other.txt:9'));
  assert.equal(gst(d, 'REVIEW_SMALL'), 'fail', 'a finding with a scan method and the instance list was not recorded');
});

test('sc_classification_stable: the same observation keeps blocking or info across revisions under one rule version (A171)', () => {
  const d = orch();
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  const w = wopen(d); appendFileSync(path.join(d, 'impl.txt'), 'impl: example one\nimpl: example two\n'); wev(d, 'GREEN', 'pass'); wclose(d, w);
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); must(d, ['secret-scan', 'LC']);
  const sev = 'scan: grep -n example impl.txt; instances: single';
  rec(d, 'REVIEW_SMALL', 'FAIL', [`REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; ${sev}`, 'REVIEW_SMALL-2|info|impl.txt:2|observation only|traced']);
  assert.match(gateText(d, 'REVIEW_SMALL'), /^blocking_rule: "1"$/m, 'the gate record does not carry the rule version');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']); worker(d, 'FIX', 'pass', 'impl.txt', 'impl: a fix'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', [`REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; ${sev}`, `REVIEW_SMALL-2|blocking|impl.txt:2|observation only|traced; ${sev}`]),
    'an info observation became blocking', 'classification changed for the same observation: REVIEW_SMALL-2 (impl.txt:2) is blocking, and was info');
  refused(recTry(d, 'REVIEW_SMALL', 'FAIL', ['REVIEW_SMALL-1|info|impl.txt:1|wrong default|traced', `REVIEW_SMALL-2|blocking|impl.txt:3|new finding|traced; ${sev}`]), 'a blocking finding was downgraded to info', 'is info, and was blocking');
  rec(d, 'REVIEW_SMALL', 'FAIL', [`REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; ${sev}`, 'REVIEW_SMALL-2|info|impl.txt:2|observation only|traced']);
  assert.equal(gst(d, 'REVIEW_SMALL'), 'fail', 'the same classification was not recorded');
});

test('sc_waiver: approval naming the finding, lead only, SECRETS and SECURITY never', () => {
  let d = orch(); implemented(d, 'orchestrated');
  must(d, ['secret-scan', 'LC']); gfail(d, 'REVIEW_SMALL', 'impl.txt'); gpass(d, 'QA'); gpass(d, 'VERIFY');
  const REASON = 'accepted risk: the default is documented upstream';
  refused(A(d, ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', REASON]), 'a waiver without approval', 'needs the user');
  refused(A(d, ['waive', 'LC', 'REVIEW_SMALL-1']), 'a waiver without a reason', 'reason');
  must(d, ['request-approval', 'LC', 'waive:REVIEW_SMALL-1']);
  capture(d, 'approved, go ahead');
  refused(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'an approval text not naming the finding', 'no approval phrase');
  // A134: the full sentence names the finding; a bare 'the waiver', another id or another kind's object is ambiguous
  for (const t of ['I approve the waiver', 'I approve the waiver of REVIEW_SMALL-2', 'I approve the plan', 'I approve the waiver of REVIEW_SMALL-1 but not the rest']) {
    capture(d, t); expectFail(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), `a waiver sentence approved: '${t}'`);
  }
  capture(d, 'REVIEW_SMALL-1 feragatini onaylıyorum');
  accepted(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'the Turkish waiver sentence');
  for (const n of lsDir(d, `${RUN}/approvals`)) if (/^\d{3}-waive-REVIEW_SMALL-1\.yaml$/.test(n)) rmSync(path.join(d, RUN, 'approvals', n), { force: true });
  must(d, ['request-approval', 'LC', 'waive:REVIEW_SMALL-1']);
  capture(d, 'I approve the waiver of REVIEW_SMALL-1.');
  accepted(A(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'the English waiver sentence');
  refused(AS(d, 'reviewer', ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', REASON]), 'a reviewer waived', 'command denied for reviewer');   // the shell asserted only the refusal; the reason is added
  accepted(A(d, ['waive', 'LC', 'REVIEW_SMALL-1', '--reason', REASON]), 'waive');
  assert.equal(gst(d, 'REVIEW_SMALL'), 'waived', 'a fully waived FAIL is not waived');
  assert.match(rd(d, `${RUN}/LEDGER.log`), /event=waive /, 'the waiver is not ledgered');
  accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE');
  // SECRETS findings are never waivable
  d = orch(); worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup'); worker(d, 'GREEN', 'pass', 'impl.txt', 'PLANTED_SECRET=abc'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  accepted(A(d, ['secret-scan', 'LC']), 'secret-scan'); assert.equal(gst(d, 'SECRETS'), 'fail');
  refused(A(d, ['request-approval', 'LC', 'waive:SECRETS-1']), 'a SECRETS waiver approval was requested', 'never waivable');
  refused(A(d, ['waive', 'LC', 'SECRETS-1', '--reason', 'it is only a test fixture value anyway']), 'a SECRETS finding was waived', 'never waivable');
  // SECURITY findings are never waivable
  d = project({ topology: 'standalone', cls: 'CRITICAL', autonomy: 'manual' });
  approveAsUser(d, 'plan', 'approve the plan'); must(d, ['freeze', 'LC'], { bind: true }); must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  rec(d, 'SECURITY', 'FAIL', ['SECURITY-1|blocking|impl.txt:1|injection reachable from input|traced: input -> eval']);
  refused(A(d, ['request-approval', 'LC', 'waive:SECURITY-1']), 'a SECURITY waiver approval was requested', 'never waivable');
  refused(A(d, ['waive', 'LC', 'SECURITY-1', '--reason', 'the input is trusted in this deployment']), 'a SECURITY finding was waived', 'never waivable');
});

test('sc_question_language: approval questions follow the run language; approve/reject and the kind word stay verbatim (A99, A103)', () => {
  const d = project({ topology: 'standalone', cls: 'COMPLEX', autonomy: 'manual' });
  const hist = '.agents/local/prompts/history';
  const KINDS = ['plan', 'destructive', 'single_step', 'scope', 'budget', 'commit', 'push'];
  const lang = () => A(d, ['run-language', 'LC']).out.replace(/\n+$/, '');
  for (const k of KINDS) {
    const q = accepted(A(d, ['request-approval', 'LC', k]), `request-approval ${k}`).out;
    assert.ok(lines(q).some((l) => l.startsWith(`1. Approve ${k} for LC?`)) && q.includes('   options: approve | reject'), `English run: ${k} question changed`);
  }
  assert.equal(lang(), 'en', 'no signal must be English');
  wr(d, `${hist}/1000000001-aaaaaaaa.txt`, 'Lütfen bu görevi yap ve sonra bana bir özet ver\n');
  assert.equal(lang(), 'tr', 'a Turkish prompt was not detected');
  for (const k of KINDS) {
    const q = accepted(A(d, ['request-approval', 'LC', k]), `request-approval ${k} (tr)`).out;
    assert.ok(lines(q).includes('QUESTIONS:') && lines(q).some((l) => l.startsWith(`1. LC için ${k} onaylansın mı?`)), `Turkish run: ${k} question is not Turkish`);
    assert.ok(q.includes('   seçenekler: approve | reject (onay için "approve ') && q.includes('   önerilen: yok') && q.includes('   neden: '), `Turkish run: ${k} options lost the approval words`);
    assert.ok(!/Approve|options:|recommended:|why:/.test(q), `Turkish run: ${k} question still holds English labels`);
  }
  // A103: the user's own words decide; English replies and system-looking prompts never flip a Turkish run
  wr(d, `${hist}/1000000002-bbbbbbbb.txt`, 'approve commit\n');
  wr(d, `${hist}/1000000003-cccccccc.txt`, 'You are the reviewer subagent. Please read the diff and report findings now\n');
  assert.equal(lang(), 'tr', 'newer English prompts flipped a Turkish run');
  for (const n of lsDir(d, hist)) if (n.endsWith('.txt')) rmSync(path.join(d, hist, n));
  wr(d, `${hist}/1000000001-aaaaaaaa.txt`, 'evet onay tamam\n');
  assert.equal(lang(), 'en', 'short Turkish replies were taken as evidence');
  wr(d, `${hist}/1000000001-aaaaaaaa.txt`, 'please go on with the plan now and report back\n');
  assert.equal(lang(), 'en', 'an English run is not English');
  // TASK.md blockquote (the user's report) beats history
  appendFileSync(path.join(d, `${RUN}/TASK.md`), '\n> Bu sayfa çalışmıyor, lütfen düzelt ve bir test ekle\n');
  assert.equal(lang(), 'tr', 'TASK.md Turkish blockquote was ignored');
  appendFileSync(path.join(d, `${RUN}/TASK.md`), '\nLanguage: en\n');
  assert.equal(lang(), 'en', 'TASK.md Language: en was ignored');
  writeFileSync(path.join(d, `${RUN}/TASK.md`), rd(d, `${RUN}/TASK.md`).split('\n').filter((l) => l !== 'Language: en').join('\n'));
  appendFileSync(path.join(d, `${RUN}/TASK.md`), '\nLanguage: tr\n');
  assert.equal(lang(), 'tr', 'TASK.md Language: tr was ignored');
});
