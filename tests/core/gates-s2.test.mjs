// @ts-check
// Slice S2 of the port of control-plane/agents/scripts/gates-test.sh (issue #176, package D1; tests/legacy-port-map.tsv names the scenarios): approvals,
// captures, the split override, assumptions, destructive plans, questions and `next`, as absolute Node tests against the Node core (every command, the
// core laid out beside agent.sh as in an installed project). One test per shell scenario, the scenario's name leads the test name.
// Deviation (#187, A210, H2): the user's own words are recorded as the user's only by the prompt hook, in process (hookAnswer); typed text is the lead's
// and `next` records no approval from a file. Where the shell scenario had `capture X; printf X | answer` expecting the user, the hook hand-over stands.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, linkSync, readdirSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmp, approveAsUser, expectFail, expectState, gfail, passAll, toCodeDone, writeReport } from '../lib/harness.mjs';
import { A, AS, proj, accepted, capture, hookAnswer, implemented, ls, narrow, now, pipe, read, refused, rf, say, text, tsha, unfrozen, wf, a, wopen, wclose } from './gates-s2-lib.mjs';

const RUN = '.agents/runs/LC';
const fp = (/** @type {string} */ d) => A(d, ['fingerprint', 'LC']).out.trim();
const approvalsOf = (/** @type {string} */ d, /** @type {RegExp} */ re) => ls(d, 'approvals').filter((n) => re.test(n));
const anyHas = (/** @type {string} */ d, /** @type {RegExp} */ re, /** @type {RegExp} */ body) => ls(d, 'approvals').some((n) => re.test(n) && body.test(rf(d, `approvals/${n}`)));

test('sc_approvals: request, capture freshness/phrase/sha, single-use, commit binding, no-run push', () => {
  const d = unfrozen('COMPLEX');
  refused(a(d, ['approve', 'LC', 'plan']), 'approve without a request', 'no approval request');
  assert.match(accepted(a(d, ['request-approval', 'LC', 'plan']), 'request').out, /^QUESTIONS:/m, 'request-approval does not print the D13 question');
  refused(a(d, ['approve', 'LC', 'plan']), 'approve without TTY or capture', 'no user prompt capture');
  say(d, 'approve the plan', { time: now() - 100 });
  refused(a(d, ['approve', 'LC', 'plan']), 'a stale capture was accepted', 'stale capture');
  say(d, 'looks fine to me');
  refused(a(d, ['approve', 'LC', 'plan']), 'a capture without an approval phrase', 'no approval phrase');
  say(d, 'approve the plan');
  const cf = path.join(d, '.agents/local/prompts/s1.json');
  writeFileSync(cf, readFileSync(cf, 'utf8').replace(/"sha256":"[0-9a-f]*"/, '"sha256":"00"'));
  refused(a(d, ['approve', 'LC', 'plan']), 'a capture with a wrong sha256', 'sha256 does not match');
  say(d, 'Approve the PLAN, onaylıyorum', { time: now() + 3 });   // dated ahead (within the 5 s the core allows) so the next request cannot make it stale
  accepted(a(d, ['approve', 'LC', 'plan']), 'approve');
  refused(a(d, ['approve', 'LC', 'plan']), 'one request approved twice', 'already approved');
  accepted(a(d, ['request-approval', 'LC', 'plan']), 'second request');
  refused(a(d, ['approve', 'LC', 'plan']), 'a prompt reused for a second approval', 'single-use');
  assert.ok(anyHas(d, /-plan\.yaml$/, /^answered_by: "user"/m), 'no plan approval answered_by user');
  // commit approvals bind the content fingerprint and are consumed once
  accepted(a(d, ['freeze', 'LC']), 'freeze');
  assert.ok(anyHas(d, /-plan\.yaml$/, /^consumed: "true"/m), 'freeze did not consume the plan approval');
  accepted(a(d, ['request-approval', 'LC', 'commit']), 'request commit'); say(d, 'commit it'); accepted(a(d, ['approve', 'LC', 'commit']), 'approve commit');
  expectFail(a(d, ['approval-consume', 'LC', 'commit', '0123456789abcdef0123456789abcdef01234567']), 'approval-consume with another fingerprint');
  accepted(a(d, ['approval-consume', 'LC', 'commit', fp(d)]), 'approval-consume');
  expectFail(a(d, ['approval-consume', 'LC', 'commit', fp(d)]), 'a commit approval consumed twice');
  // outside a run: push approvals in .agents/local
  accepted(a(d, ['request-approval', '-', 'push']), 'request push'); say(d, 'push it'); accepted(a(d, ['approve', '-', 'push']), 'approve push');
  accepted(a(d, ['approval-consume', '-', 'push']), 'consume push');
  expectFail(a(d, ['request-approval', '-', 'plan']), 'a no-run plan approval');
});

test('sc_approval_retry: next records no approval from a file; it reports a non-approval and asks again (H2 replaces A171)', () => {
  // The shell scenario had `next` record the approval of the user's newest message (A171). H2 removed that (the user's words are the hook's alone):
  // the surviving assertions are the report of a non-approval and that nothing is recorded; the "recorded just now" half no longer exists.
  const d = unfrozen('COMPLEX');
  accepted(a(d, ['request-approval', 'LC', 'plan']), 'request');
  const t0 = Number(/^requested_at: (\d+)/m.exec(rf(d, 'approvals/001-request-plan.yaml'))?.[1]);
  say(d, 'looks fine to me', { time: t0 + 1 });
  assert.match(a(d, ['next', 'LC']).text, /the user's last reply is not an explicit approval/, 'a non-approval reply was not reported by next');
  assert.deepEqual(approvalsOf(d, /^\d{3}-plan\.yaml$/), [], 'a reply without an approval phrase was recorded by next');
  say(d, 'approve the plan', { time: t0 + 1 });
  const out = a(d, ['next', 'LC']).text;
  assert.ok(!out.includes('was recorded just now'), `next recorded an approval from a file: ${out}`);
  assert.deepEqual(approvalsOf(d, /^\d{3}-plan\.yaml$/), [], 'next recorded the approval from a file');
  assert.match(out, /ask the user to send the approval again/);
  assert.ok(!existsSync(path.join(d, '.agents/local/approve.log')), 'the retry is logged although it recorded nothing');
});

test('sc_capture_integrity: captures and approvals are regular, single-link, symlink-free', () => {
  const d = unfrozen('COMPLEX');
  const t = tmp('ci');
  accepted(a(d, ['request-approval', 'LC', 'plan']), 'request');
  const cf = path.join(d, '.agents/local/prompts/s1.json');
  say(d, 'approve the plan'); renameSync(cf, `${t}/real.json`); symlinkSync(`${t}/real.json`, cf);
  refused(a(d, ['approve', 'LC', 'plan']), 'a symlinked capture was accepted', 'single-link');
  unlinkSync(cf); renameSync(`${t}/real.json`, cf); linkSync(cf, `${t}/hard.json`);
  refused(a(d, ['approve', 'LC', 'plan']), 'a hard-linked capture was accepted', 'single-link');
  rmSync(`${t}/hard.json`, { force: true });
  const pd = path.join(d, '.agents/local/prompts');
  renameSync(pd, `${t}/prompts`); symlinkSync(`${t}/prompts`, pd);
  refused(a(d, ['approve', 'LC', 'plan']), 'a capture under a symlinked prompts directory was accepted', 'single-link');
  unlinkSync(pd); renameSync(`${t}/prompts`, pd);
  accepted(a(d, ['approve', 'LC', 'plan']), 'approve');
  accepted(a(d, ['freeze', 'LC']), 'freeze');
  // approval files: a symlinked approval is never consumed
  accepted(a(d, ['request-approval', 'LC', 'commit']), 'request commit'); say(d, 'commit it'); accepted(a(d, ['approve', 'LC', 'commit']), 'approve commit');
  const af = path.join(d, RUN, 'approvals', ls(d, 'approvals').filter((n) => /-commit\.yaml$/.test(n) && !n.includes('request'))[0]);
  renameSync(af, `${t}/appr.yaml`); symlinkSync(`${t}/appr.yaml`, af);
  expectFail(a(d, ['approval-consume', 'LC', 'commit', fp(d)]), 'a symlinked approval file was consumed');
  unlinkSync(af); writeFileSync(af, readFileSync(`${t}/appr.yaml`)); linkSync(af, `${t}/appr-hard.yaml`);
  expectFail(a(d, ['approval-consume', 'LC', 'commit', fp(d)]), 'a hard-linked approval file was consumed');
  rmSync(`${t}/appr-hard.yaml`, { force: true });
  accepted(a(d, ['approval-consume', 'LC', 'commit', fp(d)]), 'consume');
});

test("sc_split_override: freeze over max_scope_paths stops with a split proposal and proceeds only on the user's recorded 'proceed without splitting'", () => {
  const d = unfrozen('STANDARD', { scopeExtra: 'AC-1', scopeOther: 'AC-1' });
  narrow(d, 3);
  assert.match(read(d, '.agents/config.yaml'), /max_scope_paths: 3/, 'the test config was not narrowed');
  refused(a(d, ['freeze', 'LC']), 'a plan over max_scope_paths froze', 'at least 2 tasks of at most 3 paths each');
  assert.equal(ls(d, 'questions').filter((n) => /^\d{3}\.md$/.test(n)).length, 1, 'freeze did not keep exactly one split question');
  assert.match(rf(d, 'questions/001.md'), /^ *SPLIT: 4@[0-9a-f]{12}$/m, 'the question is not bound to the scope list');
  expectFail(a(d, ['freeze', 'LC']), 'freeze passed with the split question unanswered');
  // the lead's own answer, a negated or conditional user answer never lets it through
  accepted(a(d, ['answer', 'LC', '1'], { input: 'proceed without splitting\n' }), 'lead answer');
  assert.match(rf(d, 'questions/001.answer.md'), /^answered_by: lead/m, "an answer without a user capture was recorded as the user's");
  refused(a(d, ['freeze', 'LC']), "the lead's own override froze", 'pipeline allows at most 3');
  const latest = () => { const n = ls(d, 'questions').filter((x) => /^\d{3}\.md$/.test(x)).at(-1) ?? ''; return String(Number(n.replace('.md', ''))); };
  let n = latest(); const t0 = now() + 1;
  const cond = 'proceed without splitting only if the reviewer agrees';
  const rc = hookAnswer(d, ['answer', 'LC', n, '--captured'], { text: cond, time: t0 });
  assert.notEqual(rc.status, 0, `a conditional override was recorded as the user's: ${rc.text}`);
  accepted(a(d, ['answer', 'LC', n], { input: `${cond}\n` }), 'typed conditional');
  assert.match(rf(d, `questions/${n.padStart(3, '0')}.answer.md`), /^answered_by: lead/m);
  refused(a(d, ['freeze', 'LC']), 'a conditional override froze', 'pipeline allows at most 3');
  n = latest();
  const ok = hookAnswer(d, ['answer', 'LC', n, '--captured'], { text: 'Proceed without splitting', time: t0 + 2 });
  assert.equal(ok.status, 0, ok.text);
  assert.match(rf(d, `questions/${n.padStart(3, '0')}.answer.md`), /^answered_by: user/m);
  const fr = a(d, ['freeze', 'LC']);
  assert.equal(fr.status, 0, `the user's override did not let the freeze through: ${fr.text}`);
  assert.match(rf(d, 'LEDGER.log'), /event=split_override .*scope_paths=4 max=3 class=STANDARD answer=questions\//, 'the override is not in the ledger');
});

test('sc_scope_content: a content or document path is not counted against max_scope_paths, a file that holds code always is', () => {
  const d = unfrozen('STANDARD', { scopeNamed: 'notes.md' });
  narrow(d, 2);
  const kind = (/** @type {string} */ p) => a(d, ['path-kind', p]).out.split('\t')[0];
  assert.deepEqual([kind('notes.md'), kind('tool.sh'), kind('docs/tool.sh'), kind('impl.txt')], ['content', 'code', 'code', 'code'], 'path-kind');
  const fr = a(d, ['freeze', 'LC']);
  assert.equal(fr.status, 0, `a content path counted against the scope bound: ${fr.text}`);
  const e = unfrozen('STANDARD', { scopeNamed: 'tool.sh' });
  narrow(e, 2);
  refused(a(e, ['freeze', 'LC']), 'a code path over the bound froze', 'code paths (content and document paths are not counted)');
});

/** A batch approval of a summary and a recorded split answer with a ceiling. @param {string} d @param {number} ceiling @param {boolean} [change] */
function batchAnswer(d, ceiling, change = false) {
  const b = path.join(d, '.agents/local/batch');
  mkdirSync(b, { recursive: true }); mkdirSync(path.join(d, '.agents/local/approvals'), { recursive: true });
  writeFileSync(`${b}/SUMMARY.md`, '# Night batch\n\nnonce: test\n');
  const h = tsha(`${b}/SUMMARY.md`); const id = h.slice(0, 12);
  writeFileSync(path.join(d, '.agents/local/approvals/001-batch.yaml'), `kind: "batch"\nbound: "${h}"\nsource: "prompt_capture"\nrequest: "x"\nanswered_by: "user"\napproved_at: 1\nconsumed: "false"\n`);
  writeFileSync(`${b}/answers.tsv`, `${id}\tLC\tQ1\tsplit\tb\t${ceiling}\tmsg\n`);
  if (change) writeFileSync(`${b}/SUMMARY.md`, '# Night batch\n\nnonce: test\nchanged\n');
}
test("sc_batch_split_answer: a recorded batch answer passes the split check up to its ceiling and is ledgered; a changed summary voids it", () => {
  const d = unfrozen('STANDARD', { scopeNamed: 'tool.sh' }); narrow(d, 2);
  batchAnswer(d, 2);
  refused(a(d, ['freeze', 'LC']), 'an answer with a ceiling below the plan froze', 'code paths');
  batchAnswer(d, 5);
  const fr = a(d, ['freeze', 'LC']);
  assert.equal(fr.status, 0, `the batch answer did not replace the split question: ${fr.text}`);
  assert.match(rf(d, 'LEDGER.log'), /event=split_override .*answer=batch:Q1/, 'the batch answer is not in the ledger');
  const e = unfrozen('STANDARD', { scopeNamed: 'tool.sh' }); narrow(e, 2);
  batchAnswer(e, 5, true);
  refused(a(e, ['freeze', 'LC']), 'an answer of a summary that changed froze', 'code paths');
});

/** Replace the body of `## Assumptions` (text empty: drop the section). @param {string} d @param {string} f @param {string} body */
function putAssumptions(d, f, body) {
  const out = []; let skip = false;
  for (const l of rf(d, f).split('\n')) {
    if (/^## Assumptions[ \t]*$/.test(l)) { skip = true; continue; }
    if (/^## /.test(l)) skip = false;
    if (!skip) out.push(l);
  }
  let t = out.join('\n');
  if (body !== '') t += `\n## Assumptions\n\n${body}\n`;
  wf(d, f, t);
}
const qfiles = (/** @type {string} */ d) => ls(d, 'questions').filter((n) => /^\d{3}\.md$/.test(n));
const qmd = (/** @type {string} */ d) => ls(d, 'questions').filter((n) => n.endsWith('.md'));
const lead = (/** @type {string} */ d, /** @type {string} */ n, /** @type {string} */ t) => accepted(a(d, ['answer', 'LC', n], { input: `${t}\n` }), `typed answer ${n}`);
const by = (/** @type {string} */ d, /** @type {string} */ n) => /^answered_by: (\w+)/m.exec(rf(d, `questions/${n.padStart(3, '0')}.answer.md`))?.[1];

test('sc_assumptions: shape, trap, low-risk pass, bound question, no silent accept, user accept, text change, freeze, completion report', () => {
  const d = unfrozen('STANDARD');
  const head = '| id | assumption | source | risk | verification | status | decisions |\n|---|---|---|---|---|---|---|';
  const low = '| AS-3 | the cache is warm at startup | TASK.md | low | none | unverified | AC-1 |';
  const p1 = '| AS-1 | the legacy key table is empty | TASK.md | high | count the rows in the staging copy | unverified | AC-1 |';
  const p2 = '| AS-2 | no consumer reads the removed field | explorer-4 | high | search the consumer repositories | unverified | AC-1 |';
  // shape: the section is mandatory in both files; the trap (high risk, verified, no method) is rejected
  putAssumptions(d, 'PLAN.md', '');
  refused(a(d, ['freeze', 'LC']), 'a PLAN.md without the section froze', "PLAN.md: the mandatory '## Assumptions' section is missing");
  assert.match(a(d, ['next', 'LC']).out, /^reason=assumption register invalid/m, 'next does not report the invalid register');
  putAssumptions(d, 'PLAN.md', 'none');
  putAssumptions(d, 'EVIDENCE.md', '');
  refused(a(d, ['freeze', 'LC']), 'an EVIDENCE.md without the section froze', "EVIDENCE.md: the mandatory '## Assumptions' section is missing");
  putAssumptions(d, 'EVIDENCE.md', `${head}\n| AS-2 | no consumer reads the removed field | explorer-4 | high | none | verified | AC-1 |`);
  refused(a(d, ['freeze', 'LC']), 'a high-risk assumption marked verified without a method froze', 'verified without a verification method');
  // a low-risk unverified assumption passes and does not block; verify-assumptions (read-only) lists it
  putAssumptions(d, 'EVIDENCE.md', `${head}\n${low}`);
  assert.ok(a(d, ['verify-assumptions', 'LC']).out.includes('AS-3 risk=low status=unverified'), 'verify-assumptions does not list the low-risk unverified assumption');
  assert.equal(AS(d, 'reviewer', ['verify-assumptions', 'LC']).out.trim().split('\n').at(-1), 'assumptions verified: LC', 'a read-only role could not run verify-assumptions');
  // high-risk, unverified: freeze refuses and records one NEEDS_INPUT question per assumption, bound to its id
  putAssumptions(d, 'PLAN.md', `${head}\n${p1}`);
  putAssumptions(d, 'EVIDENCE.md', `${head}\n${p2}\n${low}`);
  refused(a(d, ['freeze', 'LC']), 'an unverified high-risk assumption froze', 'unverified high-risk assumption');
  assert.equal(qmd(d).length, 2, 'freeze did not record one question per high-risk assumption');
  assert.match(rf(d, 'questions/001.md'), /^ *ASSUMPTION: AS-1@[0-9a-f]{12}$/m, 'question 001 is not bound to AS-1');
  assert.match(rf(d, 'questions/002.md'), /^ *ASSUMPTION: AS-2@[0-9a-f]{12}$/m, 'question 002 is not bound to AS-2');
  expectState(d, 'execution', 'awaiting_input', 'true');
  assert.match(a(d, ['next', 'LC']).out, /^next=agent\.sh questions LC/m, 'next does not stop for the assumption questions');
  refused(a(d, ['verify-assumptions', 'LC']), 'verify-assumptions listed a blocked register as fine', 'never accepted silently');
  assert.equal(qmd(d).length, 2, 'the read-only verify-assumptions recorded a question');
  refused(a(d, ['freeze', 'LC']), 'a second freeze did not point at the pending question', 'is unanswered');
  assert.equal(qmd(d).length, 2, 'a second freeze duplicated a pending question');
  // the lead's own answer (no user prompt) does not accept; a user answer that is not `accept` does not either
  lead(d, '1', 'accept AS-1');
  assert.equal(by(d, '1'), 'lead', "an answer without a user capture was recorded as the user's");
  // (deviation, #187) the user's reply 'no, the table still has rows' reaches the hook: it is no acceptance, so it is not recorded; the lead types it
  const no = hookAnswer(d, ['answer', 'LC', '2', '--captured'], { text: 'no, the table still has rows', time: now() + 1 });
  assert.notEqual(no.status, 0, `a declining reply was recorded: ${no.text}`);
  lead(d, '2', 'no, the table still has rows');
  assert.match(rf(d, 'LEDGER.log'), /event=answer .*002\.md answered_by=lead assumption=AS-2@/, 'the answer row does not name the assumption');
  refused(a(d, ['freeze', 'LC']), 'a declined assumption froze', 'did not accept it');
  assert.equal(qfiles(d).length, 4, 'freeze did not ask again after a non-accepting answer');
  // the user accepts both (question 3 = AS-1 again, question 4 = AS-2 again); a prompt that merely contains the word (or "acceptance") never accepts
  const forged = hookAnswer(d, ['answer', 'LC', '3', '--captured'], { text: 'the acceptance criteria look fine, accept the plan', time: now() + 1 });
  assert.notEqual(forged.status, 0, forged.text);
  lead(d, '3', 'accept AS-1');
  assert.equal(by(d, '3'), 'lead', "an accept AS-1 absent from the user's prompt was recorded as the user's");
  assert.ok(a(d, ['verify-assumptions', 'LC']).text.includes('AS-1 risk=high status=blocked'), 'a forged accept accepted AS-1');
  const bare = hookAnswer(d, ['answer', 'LC', '4', '--captured'], { text: 'accept', time: now() + 1 });
  assert.notEqual(bare.status, 0, bare.text);
  lead(d, '4', 'accept');
  assert.equal(by(d, '4'), 'lead', 'a bare accept without the id was recorded as an acceptance');
  assert.ok(a(d, ['verify-assumptions', 'LC']).text.includes('AS-2 risk=high status=blocked'), 'a bare accept (no id) accepted AS-2');
  refused(a(d, ['freeze', 'LC']), 'a forged or bare accept froze', 'did not accept it');
  // freeze asked again for both (questions 5 and 6). The lead's accept is not enough when the user's prompt only contains the phrase:
  // negated, reported speech, conditional (all substrings of the prompt, none an acceptance).
  const reject = (/** @type {string} */ n, /** @type {string} */ t, /** @type {string} */ why) => {
    const r = hookAnswer(d, ['answer', 'LC', n, '--captured'], { text: t, time: now() + 1 });
    assert.notEqual(r.status, 0, `${why}: ${r.text}`);
    lead(d, n, 'accept AS-1');
    assert.equal(by(d, n), 'lead', why);
  };
  reject('5', 'please do not accept AS-1 yet, it is wrong', 'a negated prompt (do not accept AS-1) accepted AS-1');
  assert.ok(a(d, ['verify-assumptions', 'LC']).text.includes('AS-1 risk=high status=blocked'), 'a negated prompt accepted AS-1');
  refused(a(d, ['freeze', 'LC']), 'a negated accept froze', 'did not accept it');       // asks AS-1 again (question 7; AS-2's 6 is pending)
  reject('7', 'I never said accept AS-1 ok', 'reported speech (never said accept AS-1) accepted AS-1');
  refused(a(d, ['freeze', 'LC']), 'a reported accept froze', 'did not accept it');       // question 8
  reject('8', 'accept AS-1 only if the table is empty', 'a conditional accept (only if) accepted AS-1');
  refused(a(d, ['freeze', 'LC']), 'a conditional accept froze', 'did not accept it');    // question 9
  // A92: a prompt that also rejects, or offers an alternative, is not a plain acceptance
  reject('9', 'accept AS-1 or reject it, your call', 'an accept-or-reject prompt accepted AS-1');
  refused(a(d, ['freeze', 'LC']), 'an accept-or-reject froze', 'did not accept it');    // question 10
  reject('10', 'accept AS-1, actually reject', 'a retracted accept (actually reject) accepted AS-1');
  refused(a(d, ['freeze', 'LC']), 'a retracted accept froze', 'did not accept it');     // question 11
  // the user's plain accept: AS-2 (question 6) and AS-1 (question 11), each handed over by the hook while it is the one asked
  const u6 = hookAnswer(d, ['answer', 'LC', '6', '--captured'], { text: 'accept AS-2', time: now() + 1 });
  assert.equal(u6.status, 0, u6.text);
  const u11 = hookAnswer(d, ['answer', 'LC', '11', '--captured'], { text: 'accept AS-1, thanks', time: now() + 2 });
  assert.equal(u11.status, 0, `a plain accept with thanks was not the user's: ${u11.text}`);
  assert.equal(by(d, '11'), 'user', "a plain accept with thanks was not the user's");
  assert.match(rf(d, 'questions/011.answer.md'), /^accept AS-1$/m, "the user's accept was not normalized");
  const va = a(d, ['verify-assumptions', 'LC']).out;
  assert.ok(va.includes('AS-1 risk=high status=accepted-by-user ref=questions/011.answer.md'), 'AS-1 is not accepted-by-user with its answer');
  assert.ok(va.includes('AS-2 risk=high status=accepted-by-user ref=questions/006.answer.md'), 'AS-2 is not accepted-by-user with its answer');
  // a changed assumption text is a new assumption: the old answer does not carry over
  const keep = rf(d, 'PLAN.md');
  wf(d, 'PLAN.md', keep.replace('the legacy key table is empty', 'the legacy key table has no live rows'));
  refused(a(d, ['freeze', 'LC']), 'an answer for another text of the assumption was reused', 'unverified high-risk assumption');
  assert.equal(qfiles(d).length, 12, 'a changed assumption text was not asked again');
  wf(d, 'PLAN.md', keep);
  lead(d, '12', 'accept AS-1');   // the question of the reverted wording is moot; CODE_DONE needs none pending
  const fz = a(d, ['freeze', 'LC']);
  assert.equal(fz.status, 0, `freeze refused after the user accepted both assumptions: ${fz.text}`);
  accepted(a(d, ['verify-freeze', 'LC']), 'verify-freeze');
  // the completion report lists every unverified and accepted-by-user assumption (ids; accepted ones with the answer)
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING');
  toCodeDone(d, 'standalone');
  accepted(a(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done'); writeReport(d);
  refused(a(d, ['publish-completion-report', 'LC', 'markdown']), 'a report that omits the assumptions was published', 'does not list: AS-1 AS-2 AS-3');
  writeReport(d, '', '## Assumptions', '- AS-1 (high): accepted-by-user', '- AS-2 (high): accepted-by-user, questions/006.answer.md', '- AS-3 (low): unverified');
  refused(a(d, ['publish-completion-report', 'LC', 'markdown']), 'an accepted assumption without its answer reference was published', 'does not list: AS-1(answer questions/011.answer.md)');
  writeReport(d, '', '## Assumptions', '- AS-1 (high): accepted-by-user, questions/011.answer.md', '- AS-2 (high): accepted-by-user, questions/006.answer.md', '- AS-3 (low): verified');
  refused(a(d, ['publish-completion-report', 'LC', 'markdown']), 'an unverified assumption reported as verified was published', 'AS-3(unverified)');
  writeReport(d, '', '## Assumptions', '- AS-1 (high): accepted-by-user, questions/011.answer.md', '- AS-2 (high): accepted-by-user, questions/006.answer.md', '- AS-3 (low): unverified');
  const pub = a(d, ['publish-completion-report', 'LC', 'markdown']);
  assert.equal(pub.status, 0, `a report listing every assumption was refused: ${pub.text}`);
});

const app = (/** @type {string} */ d, /** @type {string} */ kind, /** @type {string} */ t) => approveAsUser(d, kind, t);
const nextOut = (/** @type {string} */ d) => a(d, ['next', 'LC']).out;
const edit = (/** @type {string} */ d, /** @type {string} */ f, /** @type {(t: string) => string} */ fn) => wf(d, f, fn(rf(d, f)));

test('sc_supervised_destructive: supervised freeze needs a bound plan approval; a destructive plan is CRITICAL, expand/contract, destructive approval before IMPLEMENT, single_step', () => {
  let d = unfrozen('COMPLEX');
  refused(a(d, ['freeze', 'LC']), 'supervised freeze without plan approval', 'plan approval');
  assert.match(nextOut(d), /^next=agent\.sh request-approval LC plan/m, 'next does not ask for the plan approval');
  app(d, 'plan', 'approve the plan');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), 'edited after approval\n');
  refused(a(d, ['freeze', 'LC']), 'an approval for an older PLAN.md', 'plan approval');
  app(d, 'plan', 'approve the plan please');
  accepted(a(d, ['freeze', 'LC']), 'supervised freeze');
  // destructive data change (K-6): forced CRITICAL at freeze; the freeze needs the plan approval only, the destructive approval stops the run after
  // the freeze, before IMPLEMENT, bound to the frozen PLAN.md hash
  d = unfrozen('STANDARD');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), '\n## Data\n\ndestructive: maybe\n');
  refused(a(d, ['freeze', 'LC']), 'an invalid ## Data first line', 'destructive: yes');
  edit(d, 'PLAN.md', (t) => t.replace(/^destructive: maybe$/m, 'destructive: yes'));
  expectFail(a(d, ['freeze', 'LC']), 'a destructive plan froze without the plan approval');
  expectState(d, 'pipeline', 'classification', 'CRITICAL');
  refused(a(d, ['classify', 'LC', 'STANDARD']), 'a destructive plan reclassified below CRITICAL', 'CRITICAL');
  app(d, 'plan', 'approve the plan');
  refused(a(d, ['freeze', 'LC']), 'a destructive plan with no expand/contract steps froze', 'without expand/contract steps');
  assert.ok(nextOut(d).includes('destructive plan without expand/contract steps'), 'next does not name the missing expand/contract steps');
  // a one-release plan: the destructive step shares the expand phase
  appendFileSync(path.join(d, RUN, 'PLAN.md'), '\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | drop_column | books.legacy_notes | yes | no | restore from backup | table rewrite |\n');
  app(d, 'plan', 'approve this plan');
  refused(a(d, ['freeze', 'LC']), 'a one-release destructive plan froze', 'without expand/contract steps');
  // expand then contract: accepted with the plan approval alone
  edit(d, 'PLAN.md', (t) => t.split('\n').filter((l) => !l.startsWith('| S1 | expand | drop_column')).join('\n'));
  appendFileSync(path.join(d, RUN, 'PLAN.md'), '| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n');
  assert.match(nextOut(d), /^next=agent\.sh request-approval LC plan/m, 'next does not ask for the plan approval of the final plan');
  assert.ok(!nextOut(d).includes('destructive approval required before'), 'next asks for the destructive approval before the freeze');
  app(d, 'plan', 'please approve the plan');
  assert.match(nextOut(d), /^next=agent\.sh freeze LC/m, 'next does not offer the freeze with only the plan approval');
  const fr = a(d, ['freeze', 'LC']);
  assert.equal(fr.status, 0, `a destructive plan with the plan approval was not frozen: ${fr.text}`);
  assert.equal(pipe(d, 'tier'), 'full');
  expectState(d, 'handoff', 'state', 'PLANNED');
  // after the freeze: next asks for the destructive approval, bound to the frozen hash, before IMPLEMENT
  assert.match(nextOut(d), /^next=agent\.sh request-approval LC destructive/m, 'next does not ask for the destructive approval after the freeze');
  assert.match(nextOut(d), /^reason=destructive approval required before IMPLEMENT/m, "next reason lacks 'destructive approval required before IMPLEMENT'");
  assert.ok(!nextOut(d).includes('agent.sh handoff LC IMPLEMENTING'), 'next offers the handoff before the destructive approval');
  refused(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING without the destructive approval', 'agent.sh request-approval LC destructive');
  expectState(d, 'handoff', 'state', 'PLANNED');
  app(d, 'destructive', 'approve the destructive migration');
  assert.match(nextOut(d), /^next=agent\.sh handoff LC IMPLEMENTING/m, 'next does not offer the handoff after the destructive approval');
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING refused with a valid destructive approval');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  // a refreeze (new PLAN.md hash) drops the approval: it must be requested again before IMPLEMENT
  d = unfrozen('STANDARD');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), '\n## Data\n\ndestructive: yes\n\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | contract | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n');
  app(d, 'plan', 'approve plan');
  accepted(a(d, ['freeze', 'LC']), 'freeze for the refreeze scenario');
  app(d, 'destructive', 'approve destructive migration');
  mkdirSync(path.join(d, RUN, 'amendments'), { recursive: true }); wf(d, 'amendments/001.md', '# amendment 001: clarify the migration\n');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), 'amended: migration note\n');
  app(d, 'plan', 'approve a plan');
  assert.ok(a(d, ['refreeze', 'LC', '001.md']).text.includes('destructive / single_step approval was bound to the old one'), 'refreeze does not say the destructive approval was dropped');
  refused(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING with an approval bound to the old PLAN.md', 'agent.sh request-approval LC destructive');
  assert.match(nextOut(d), /^next=agent\.sh request-approval LC destructive/m, 'next does not ask again after the refreeze');
  app(d, 'destructive', 'approve the destructive migration please');
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING refused after the destructive approval of the new hash');
  // an explicit single-step approval is the only way to a one-step destructive change
  d = unfrozen('STANDARD');
  appendFileSync(path.join(d, RUN, 'PLAN.md'), '\n## Data\n\ndestructive: yes\nsingle_step: yes\n\ndrop books.legacy_notes in one migration\n');
  appendFileSync(path.join(d, RUN, 'TASK.md'), '\nThe user wants this migration as a single step.\n');
  app(d, 'plan', 'yes approve the plan');
  accepted(a(d, ['freeze', 'LC']), 'a single_step plan was not frozen on the plan approval');
  app(d, 'destructive', 'please approve destructive migration');
  refused(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'a single_step plan reached IMPLEMENTING without the single-step approval', 'single-step approval');
  assert.match(nextOut(d), /^next=agent\.sh request-approval LC single_step/m, 'next does not ask for the single_step approval');
  app(d, 'single_step', 'approve single step');
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'an approved single-step plan was refused');
});

// K-6: a refreeze that changes the PLAN.md of a destructive plan while the run is IMPLEMENTING or IMPLEMENTED sends it back to PLANNED
const DEST_DATA = '\n## Data\n\ndestructive: yes\n\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n';
const amendPlan = (/** @type {string} */ d, /** @type {string} */ n, /** @type {string} */ t) => {
  mkdirSync(path.join(d, RUN, 'amendments'), { recursive: true });
  wf(d, `amendments/${n}.md`, `# amendment ${n}: destructive migration added to the plan\n`);
  appendFileSync(path.join(d, RUN, 'PLAN.md'), `${t}\n`);
};
test('sc_destructive_refreeze: a refreeze of a destructive plan returns to PLANNED until the new hash is approved; a fix-round reopen, a TASK-only refreeze and a non-destructive refreeze do not', () => {
  for (const from of ['IMPLEMENTING', 'IMPLEMENTED']) {
    const d = proj();
    if (from === 'IMPLEMENTED') implemented(d, 'orchestrated');
    amendPlan(d, '001', DEST_DATA);
    assert.ok(a(d, ['refreeze', 'LC', '001.md']).text.includes('back at PLANNED'), `${from}: the refreeze does not say the run is back at PLANNED`);
    expectState(d, 'handoff', 'state', 'PLANNED');
    expectState(d, 'pipeline', 'classification', 'CRITICAL');
    refused(a(d, ['window-open', 'LC']), `${from}: window-open without the destructive approval`, 'destructive approval');
    refused(a(d, ['handoff', 'LC', 'IMPLEMENTED']), `${from}: IMPLEMENTED without the destructive approval`, 'illegal handoff transition');
    refused(a(d, ['handoff', 'LC', 'IMPLEMENTING']), `${from}: IMPLEMENTING without the destructive approval`, 'agent.sh request-approval LC destructive');
    assert.match(nextOut(d), /^next=agent\.sh request-approval LC destructive/m, `${from}: next does not ask for the destructive approval`);
    assert.match(nextOut(d), /^reason=destructive approval required before IMPLEMENT/m, `${from}: next reason is not 'destructive approval required before IMPLEMENT'`);
    app(d, 'destructive', 'approve the destructive migration');
    accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), `${from}: IMPLEMENTING refused with the approval for the new hash`);
    wclose(d, wopen(d));
    // the approval was consumed and is bound to this hash: a second plan change asks again
    amendPlan(d, '002', 'amended again: second plan change');
    accepted(a(d, ['refreeze', 'LC', '002.md']), 'second refreeze');
    expectState(d, 'handoff', 'state', 'PLANNED');
    refused(a(d, ['handoff', 'LC', 'IMPLEMENTING']), `${from}: a consumed approval reused for another hash`, 'agent.sh request-approval LC destructive');
    refused(a(d, ['window-open', 'LC']), `${from}: window-open on a consumed approval`, 'destructive approval');
  }
  // a fix-round reopen keeps the hash: no new approval
  let d = proj();
  amendPlan(d, '001', DEST_DATA);
  accepted(a(d, ['refreeze', 'LC', '001.md']), 'refreeze');
  app(d, 'destructive', 'approve the destructive migration');
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING');
  implemented(d, 'orchestrated');
  accepted(a(d, ['secret-scan', 'LC']), 'secret-scan'); gfail(d, 'REVIEW_RULES', 'impl.txt');
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'the fix-round reopen asked for a new destructive approval');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  wclose(d, wopen(d));
  // a refreeze that leaves PLAN.md unchanged (TASK.md only) stays at IMPLEMENTING: the approval still binds the hash
  d = proj();
  amendPlan(d, '001', DEST_DATA);
  accepted(a(d, ['refreeze', 'LC', '001.md']), 'refreeze');
  app(d, 'destructive', 'approve the destructive migration');
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING');
  wf(d, 'amendments/002.md', '# amendment 002: clarify the task wording only\n');
  appendFileSync(path.join(d, RUN, 'TASK.md'), '\n- AC-1 clarified: an empty key returns the documented default\n');
  accepted(a(d, ['refreeze', 'LC', '002.md']), 'TASK-only refreeze');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  wclose(d, wopen(d));
  // a refreeze from destructive to non-destructive needs no destructive approval
  wf(d, 'amendments/003.md', '# amendment 003: the migration is dropped from this change\n');
  edit(d, 'PLAN.md', (t) => t.split('\n').filter((l) => !/^\| S[0-9] \|/.test(l) && !l.startsWith('| step |') && !l.startsWith('|---')).map((l) => (l === 'destructive: yes' ? 'destructive: no' : l)).join('\n'));
  accepted(a(d, ['refreeze', 'LC', '003.md']), 'non-destructive refreeze');
  expectState(d, 'handoff', 'state', 'IMPLEMENTING');
  wclose(d, wopen(d));
});

const ART = 'reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md';
/** A NEEDS_INPUT result of ROLE (FOCUS optional) recorded as that role. @param {string} d @param {string} role @param {string} questions @param {string} [focus] */
function needsInput(d, role, questions, focus = '') {
  const f = path.join(tmp('q'), 'q.md');
  writeFileSync(f, `ROLE: ${role}\nTASK: LC\n${focus ? `FOCUS: ${focus}\n` : ''}RESULT: NEEDS_INPUT\nCONFIDENCE: medium\nFINGERPRINT: ${fp(d)}\nARTIFACT: ${ART} ${tsha(path.join(d, RUN, ART))}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n\n${questions}`);
  return AS(d, role, ['record', 'LC', '--file', f]);
}
const planted = (/** @type {string} */ d) => { mkdirSync(path.join(d, RUN, 'reports/snapshots'), { recursive: true }); wf(d, ART, '# explorer notes\n'); };

test('sc_questions: NEEDS_INPUT stored verbatim, one round per role, awaiting_input, typed answers are the lead\'s, user-only answers only through the hook, amend, quote block (A171, #187)', () => {
  const d = proj(); planted(d);
  refused(needsInput(d, 'explorer', ''), 'NEEDS_INPUT without questions', 'QUESTIONS');
  accepted(needsInput(d, 'explorer', 'QUESTIONS:\n1. Which default should an empty key return?\n   options: nil | empty string\n   recommended: nil\n   why: AC-1 depends on it\n'), 'first NEEDS_INPUT');
  // C-14: the same role asking a second time is rejected; a different role is still accepted
  const second = 'QUESTIONS:\n1. Keep the old lookup name?\n   options: yes | no\n   recommended: yes\n   why: callers depend on it\n';
  refused(needsInput(d, 'explorer', second), 'a second NEEDS_INPUT from the same role', 'already asked its questions in this run');
  assert.ok(!existsSync(path.join(d, RUN, 'questions/002.md')), 'a rejected second NEEDS_INPUT was stored');
  accepted(needsInput(d, 'architect', second), 'architect');
  expectState(d, 'execution', 'awaiting_input', 'true');
  assert.ok(a(d, ['questions', 'LC']).out.includes('1. Which default should an empty key return?'), 'questions are not relayed verbatim');
  assert.match(nextOut(d), /^next=agent\.sh questions LC/m, 'next does not point to the questions');
  // the user's words typed by the lead are the lead's, even when they match what the user said (the shell scenario expected the user: #187 / A210)
  say(d, 'the answer is: empty string');
  lead(d, '1', 'empty string');
  assert.equal(by(d, '1'), 'lead', 'an answer typed by the lead is not answered_by lead');
  expectState(d, 'execution', 'awaiting_input', 'true');
  lead(d, '2', 'yes, keep it');
  assert.equal(by(d, '2'), 'lead', 'an answer the user never gave is not answered_by lead');
  expectState(d, 'execution', 'awaiting_input', 'false');
  // I4: a capture older than the question, or an answer under 3 characters, is never the user's
  accepted(needsInput(d, 'designer', 'QUESTIONS:\n1. Which default for a missing file?\n'), 'designer');
  say(d, 'the default is an empty list', { time: now() - 100 });
  lead(d, '3', 'the default is an empty list');
  assert.equal(by(d, '3'), 'lead', 'an answer from a capture older than the question is answered_by user');
  accepted(needsInput(d, 'qa', 'QUESTIONS:\n1. Proceed?\n'), 'qa');
  say(d, 'ok');
  lead(d, '4', 'ok');
  assert.equal(by(d, '4'), 'lead', 'a two-character answer is answered_by user');
  // --captured: the user's own message reaches a plain question only from a file (history) in the shell scenario; now no file is the user's words (#187)
  accepted(needsInput(d, 'data_architect', 'QUESTIONS:\n1. Which fix?\n'), 'data_architect');
  const h = path.join(d, '.agents/local/prompts/history'); mkdirSync(h, { recursive: true });
  const t5 = now() + 1000;
  writeFileSync(`${h}/${t5 + 1}-bbbbbbbb.txt`, '1: fix qa-1 now\n   (CSS in Base.astro)\n2: waive drift\n');
  writeFileSync(`${h}/${t5 + 2}-cccccccc.txt`, '1: fix qa-1 later, 2: waive drift\n');
  writeFileSync(`${h}/${t5 + 3}-aaaaaaaa.txt`, '<task-notification>\nAgent done\n</task-notification>\n');
  refused(a(d, ['answer', 'LC', '5', '--captured']), '--captured from the history files', "cannot be recorded as the user's from a file");
  assert.ok(!existsSync(path.join(d, RUN, 'questions/005.answer.md')), '--captured recorded an answer from a file');
  const hp = hookAnswer(d, ['answer', 'LC', '5', '--captured'], { text: '1: fix qa-1 later, 2: waive drift', time: now() + 1 });
  assert.notEqual(hp.status, 0); assert.match(hp.text, /has no asking session on record/);
  lead(d, '5', '1: fix qa-1 later, 2: waive drift');
  assert.equal(by(d, '5'), 'lead');
  // user-only questions (USER_ONLY): the hook records the user's message once; one message answers one question; the lead alone cannot --amend
  const uq = (/** @type {string} */ t) => `1. ${t}\n   USER_ONLY: scope\n   options: "strict" | "lenient"\n   recommended: strict\n   why: AC-1 depends on it\n`;
  accepted(a(d, ['ask', 'LC'], { input: uq('Which mode?') }), 'ask 6');
  const m1 = hookAnswer(d, ['answer', 'LC', '6', '--captured'], { text: 'strict', time: now() + 1 });
  assert.equal(m1.status, 0, m1.text);
  assert.equal(by(d, '6'), 'user', "the hook did not record the user's message as the user's");
  assert.match(rf(d, 'questions/006.answer.md'), /^source_message: \d+-[0-9a-f]{8}\.txt$/m, 'the answer file does not name its source message');
  assert.match(m1.text, /answer source: the user's message \d+-[0-9a-f]{8}\.txt/, 'the answer did not say which message it took');
  assert.match(rf(d, 'questions/006.answer.md'), /^> strict$/m, "the user's text is not stored as a quote block");
  accepted(a(d, ['ask', 'LC'], { input: uq('Another?') }), 'ask 7');
  const again = hookAnswer(d, ['answer', 'LC', '7', '--captured'], { text: 'strict', time: now() + 1 });   // the same message again
  assert.notEqual(again.status, 0); assert.match(again.text, /already answered another question/, 'a used-up message answered a second question');
  // --amend: a newer user message corrects a recorded answer; the old record is kept, marked amended. The lead alone cannot.
  refused(a(d, ['answer', 'LC', '6', '--amend']), 'the lead amended an answer without a newer user message', "cannot be recorded as the user's from a file");
  refused(a(d, ['answer', 'LC', '6', '--amend'], { input: 'forced\n' }), "an amend with the lead's own text on stdin was accepted", "cannot be recorded as the user's from a file");
  const am = hookAnswer(d, ['answer', 'LC', '6', '--amend'], { text: 'lenient', time: now() + 3 });
  assert.equal(am.status, 0, `--amend with a newer user message failed: ${am.text}`);
  assert.match(rf(d, 'questions/006.answer.amended-1.md'), /^amended: true/m, 'the old answer was not kept as amended');
  assert.match(rf(d, 'questions/006.answer.amended-1.md'), /^> strict$/m, 'the amended record lost the old answer');
  assert.match(rf(d, 'questions/006.answer.md'), /^> lenient$/m, 'the new answer is not the newer message');
  assert.match(rf(d, 'questions/006.answer.md'), /^amends: 006\.answer\.amended-1\.md/m); assert.ok(am.text.includes('old record is kept'));
  assert.match(rf(d, 'LEDGER.log'), /event=answer-amend/, 'the amend is not in the ledger');
  const dup = hookAnswer(d, ['answer', 'LC', '6', '--amend'], { text: 'lenient', time: now() + 3 });
  assert.notEqual(dup.status, 0, 'a second amend with the same message');
  // A171: the user's text is stored in a quote block, so a Turkish answer passes the language check
  const tr = 'Bence şu şekilde olsun: ığüşöç çok güzel';
  const tq = `1. Which name?\n   USER_ONLY: scope\n   options: "Bence şu şekilde olsun" | "baska"\n   recommended: baska\n   why: AC-1 depends on it\n`;
  accepted(a(d, ['answer', 'LC', '7'], { input: 'closing seven\n' }), 'close 7');
  accepted(a(d, ['ask', 'LC'], { input: tq }), 'ask 8');
  const trr = hookAnswer(d, ['answer', 'LC', '8', '--captured'], { text: tr, time: now() + 4 });
  assert.equal(trr.status, 0, trr.text);
  assert.ok(rf(d, 'questions/008.answer.md').split('\n').includes(`> ${tr}`), `the Turkish answer is not stored as a quote block: ${rf(d, 'questions/008.answer.md')}`);
  accepted(a(d, ['language-check', '.agents/runs/LC/questions/008.answer.md']), 'a quoted Turkish answer failed the language check');
  // the shell scenario had the user's message as a history copy with its own line end; the hook's copy has none, so it would join the previous file's last line
  writeFileSync(`${h}/${now() + 5}-ffffffff.txt`, `\n${tr}\n`);
  refused(a(d, ['language-check', '-'], { input: `${tr}\n` }), 'unquoted Turkish passed the language check', 'language: run artifacts are English');
  accepted(a(d, ['language-check', '-'], { input: `> ${tr}\n` }), 'a quote block is not exempt');
  // A92: a risk FOCUS on a task result does not open a second round for qa (C-14)
  refused(needsInput(d, 'qa', 'QUESTIONS:\n1. And the dark theme?\n   options: yes | no\n   recommended: yes\n   why: AC-1 depends on it\n', 'visual'), 'a second NEEDS_INPUT from qa with FOCUS: visual', 'already asked its questions in this run');
  accepted(a(d, ['verify-seal', 'LC']), 'verify-seal');
});

test('sc_questions_keys: a legacy question file without focus counts for its role; a different focus is a different key; the message names the file', () => {
  const d = proj(); planted(d);
  mkdirSync(path.join(d, RUN, 'questions'), { recursive: true });
  wf(d, 'questions/001.md', 'from: designer\nasked_at: 1\n---\n1. old question\n');
  wf(d, 'questions/002.md', 'from: qa\nfocus: tests\nasked_at: 1\n---\n1. other focus\n');
  const q = (/** @type {string} */ role) => needsInput(d, role, 'QUESTIONS:\n1. Proceed?\n');
  refused(q('designer'), 'a legacy question file without focus did not count', 'designer role already asked its questions in this run (questions/001.md)');
  accepted(q('qa'), 'a question file with another focus blocked the role');
});

test("sc_questions_grill: through submit, the task author's intent-grill rounds are exempt (A75); a non-grill second round and an architect with design/INTENT.md are refused (C-14)", () => {
  const d = proj();
  mkdirSync(path.join(d, RUN, 'reports'), { recursive: true }); mkdirSync(path.join(d, RUN, 'design'), { recursive: true });
  wf(d, 'reports/001-task_author.md', '# notes\n'); wf(d, 'design/INTENT.md', '# Intent\n\n## Status\n\nin-progress\n');
  const gq = path.join(tmp('g'), 'gq.txt');
  writeFileSync(gq, '1. Proceed?\n   options: yes | no\n   recommended: yes\n   why: it unblocks the tree\n');
  // sg ROLE ARTIFACT TOKEN: a NEEDS_INPUT through the real `submit` (which snapshots the artifact before `record`)
  const sg = (/** @type {string} */ role, /** @type {string} */ art, /** @type {string} */ tok) => AS(d, role, ['submit', 'LC', '--result', 'NEEDS_INPUT', '--confidence', 'medium', '--artifact', art, '--questions', gq, '--agent', tok]);
  // A75: intent-grill's interview (the task author, artifact design/INTENT.md) is multi-round and never limited
  accepted(sg('task_author', 'design/INTENT.md', 'g1'), "intent-grill's first round was refused");
  accepted(sg('task_author', 'design/INTENT.md', 'g2'), "intent-grill's second round was refused");
  accepted(sg('task_author', 'design/INTENT.md', 'g3'), "intent-grill's third round was refused");
  // its rounds do not use up the role's own round; a non-grill second round is refused (C-14)
  accepted(sg('task_author', 'reports/001-task_author.md', 't1'), "the task author's own first round was refused after intent-grill rounds");
  refused(sg('task_author', 'reports/001-task_author.md', 't2'), 'a second non-grill NEEDS_INPUT from the same role', 'already asked its questions in this run');
  // the exemption needs an interview in progress: a design/INTENT.md that is not in-progress is an ordinary round
  wf(d, 'design/INTENT.md', '# Intent\n\n## Status\n\ncomplete\n');
  refused(sg('task_author', 'design/INTENT.md', 'c1'), 'a task author NEEDS_INPUT with a finished INTENT.md was exempt', 'already asked its questions in this run');
  wf(d, 'design/INTENT.md', '# intent\n');
  refused(sg('task_author', 'design/INTENT.md', 'c2'), 'a task author NEEDS_INPUT with a stub INTENT.md was exempt', 'already asked its questions in this run');
  wf(d, 'design/INTENT.md', '# Intent\n\n## Status\n\nin-progress\n');
  accepted(sg('task_author', 'design/INTENT.md', 'g4'), "an in-progress interview round was refused after the role's own round");
  // the exemption is the task author's: another role under design/ with the same artifact is bound by C-14
  accepted(sg('architect', 'design/INTENT.md', 'a1'), "the architect's first round was refused");
  refused(sg('architect', 'design/INTENT.md', 'a2'), 'an architect NEEDS_INPUT with design/INTENT.md was exempt', 'already asked its questions in this run');
});

test('sc_next: deterministic steps from approval to completion', () => {
  const d = unfrozen('COMPLEX');
  assert.match(nextOut(d), /^next=agent\.sh request-approval LC plan/m);
  accepted(a(d, ['request-approval', 'LC', 'plan']), 'request');
  assert.match(nextOut(d), /^next=wait for the user/m, `next after a request: ${nextOut(d)}`);
  say(d, 'approve the plan'); accepted(a(d, ['approve', 'LC', 'plan']), 'approve');
  assert.match(nextOut(d), /^next=agent\.sh freeze LC/m);
  accepted(a(d, ['freeze', 'LC']), 'freeze');
  assert.match(nextOut(d), /^next=agent\.sh handoff LC IMPLEMENTING/m);
  accepted(a(d, ['handoff', 'LC', 'IMPLEMENTING']), 'IMPLEMENTING');
  assert.match(nextOut(d), /^next=dispatch\.sh LC implementer/m);
  implemented(d, 'standalone');
  const out = nextOut(d).split('\n');
  for (const want of ['next=agent.sh secret-scan LC', 'next=dispatch.sh LC reviewer --focus rules+tests', 'next=dispatch.sh LC qa', 'next=dispatch.sh LC verifier']) assert.ok(out.includes(want), `next at IMPLEMENTED lacks '${want}': ${out.join('\n')}`);
  passAll(d);
  assert.match(nextOut(d), /^next=agent\.sh handoff LC CODE_DONE/m);
  accepted(a(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE');
  assert.match(nextOut(d), /^next=agent\.sh knowledge-done LC/m);
  accepted(a(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']), 'knowledge-done');
  assert.match(nextOut(d), /^next=write COMPLETION_REPORT\.md/m);
});
