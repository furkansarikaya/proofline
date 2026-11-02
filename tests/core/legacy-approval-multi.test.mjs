// @ts-check
// Behaviour of lifecycle-test.sh scenario_approval_multi (A202 item 31) as an absolute Node test (tests/legacy-port-map.tsv): several approvals in one
// message are parsed one by one; hedged, negated, conditional, question, quoted and fenced segments are rejected alone and named; a lone approval with
// a hedge stays refused as a whole; a negated sibling that names no other open kind vetoes the message; the cap is 8; a waiver of a SECURITY finding
// is no approval kind that can be open. The lines the hook shows (`multi: ...`) are the shell's, recorded once.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';
import { A, accepted, project, refused, waitUntil } from './legacy-lib.mjs';

test('several approvals in one message are parsed one by one (A202)', () => {
  const d = project('scaffold standalone no TRIVIAL supervised');
  const ad = `${d}/.agents/runs/LC/approvals`;
  for (const k of ['plan', 'scope', 'budget', 'destructive']) accepted(A(d, ['request-approval', 'LC', k]), `request ${k}`);
  const qo = A(d, ['request-approval', 'LC', 'plan']).out;
  assert.ok(qo.includes('approve budget, approve destructive, approve plan, approve scope'), `the question does not show the phrases for several open requests: ${qo}`);
  const t0 = Math.max(...readdirSync(ad).filter((n) => n.includes('request')).map((n) => Number(/^requested_at: (\d+)/m.exec(readFileSync(`${ad}/${n}`, 'utf8'))?.[1])));
  waitUntil(t0 + 1);
  let msg = '';
  /** The message the hook stores (several lines allowed), newer than every request. */
  const say = (/** @type {string} */ text) => { msg = text; storePrompt(`${d}/.agents/local`, 's1', Math.max(Math.floor(Date.now() / 1000), t0 + 1), text); };
  const has = (/** @type {string} */ k) => readdirSync(ad).some((n) => new RegExp(`^\\d{3}-${k}\\.yaml$`).test(n));
  const clear = (/** @type {string[]} */ ...ks) => { for (const n of readdirSync(ad)) if (ks.some((k) => new RegExp(`^\\d{3}-${k}\\.yaml$`).test(n))) rmSync(`${ad}/${n}`); };
  const only = (/** @type {string[]} */ ...kinds) => { for (const k of ['plan', 'scope', 'budget', 'destructive']) assert.equal(has(k), kinds.includes(k), `multi: ${k} ${kinds.includes(k) ? 'was not recorded' : 'was recorded but must not be'} (${msg})`); };
  const pending = () => A(d, ['approve-pending', 'LC']).out;
  const all4 = ['plan', 'scope', 'budget', 'destructive'];
  // 1. four approvals in one message: four records, every record bound to the same user prompt
  say('approve plan, approve scope, approve budget, approve destructive');
  let out = pending(); only(...all4);
  assert.ok(out.includes('multi: 4 of 4 segments read as approvals, 4 approval record(s) written'), `no confirmation line: ${out}`);
  const ids = new Set(readdirSync(ad).filter((n) => /^\d{3}-(plan|scope|budget|destructive)\.yaml$/.test(n)).map((n) => /^capture_id: (.*)$/m.exec(readFileSync(`${ad}/${n}`, 'utf8'))?.[1]));
  assert.equal(ids.size, 1, 'the records are not bound to one user prompt');
  // 2. lines instead of commas
  clear(...all4); say('approve plan\napprove scope'); pending(); only('plan', 'scope');
  // 3. negated, conditional, question and unclear segments are rejected alone, each named on one line; the exact ones are recorded
  clear(...all4); say('approve plan, do not approve scope, approve budget if CI is green, approve destructive?, approve the thing');
  out = pending(); only('plan');
  for (const line of ['multi: not recorded: do not approve scope: negated, conditional or hedged', 'multi: not recorded: approve budget if CI is green: negated, conditional or hedged', 'multi: not recorded: approve destructive?: a question is not an approval', 'multi: not recorded: approve the thing: not one exact approval', '1 of 5 segments read as approvals, 1 approval record(s) written']) assert.ok(out.includes(line), `missing line '${line}': ${out}`);
  // 4. one ambiguous segment is rejected alone, the others are recorded
  clear(...all4); say('approve plan, approve budget, approve scope maybe'); pending(); only('plan', 'budget');
  // 5. a lone approval with a hedge stays refused as a whole (no guessing)
  clear(...all4);
  for (const m of ['approve the plan, but wait', 'approve plan, hmm', 'approve plan, thanks!']) { say(m); out = pending(); only(); assert.ok(!out.includes('multi:'), `multi mode on for a lone approval with a hedge: ${m}`); }
  // 6. quoted and pasted text is never an approval: a blockquote line, a fenced block, a quote that is the whole message
  say('approve plan\n> approve scope, approve budget'); out = pending(); only('plan');
  assert.ok(out.includes('multi: not recorded: > approve scope, approve budget: quoted or pasted text'), `quote not named: ${out}`);
  clear('plan'); say('approve plan\n```\napprove scope\napprove budget\n```'); out = pending(); only('plan'); assert.ok(out.includes('quoted or pasted text'), `fence not named: ${out}`);
  clear('plan'); say('> approve plan, approve scope'); pending(); only();
  // 7. a question: the question segment is not an approval, the other one is
  say('should I approve plan?, approve scope'); pending(); only('scope');
  // 8. more than the cap: the extras are rejected with one line, the ninth segment records nothing
  clear('scope'); say(`${'approve plan, '.repeat(8)}approve scope`); out = pending(); only('plan');
  assert.ok(out.includes('more than 8 approvals in one message (limit 8)'), `cap not reported: ${out}`);
  // 9. a waiver of a SECURITY finding is no approval kind that can be open: refused, the others are recorded
  clear('plan'); refused(A(d, ['request-approval', 'LC', 'waive:SECURITY-1']), 'a SECURITY waiver request was created');
  say('approve plan, approve waive SECURITY-1, approve scope'); out = pending(); only('plan', 'scope');
  assert.ok(out.includes('multi: not recorded: approve waive SECURITY-1'), `waiver segment not named: ${out}`);
  assert.deepEqual(readdirSync(ad).filter((n) => n.includes('waive') && !n.includes('request')), [], 'a waiver record exists');
  // 11. a negated, hedged or questioning sibling that names no other open kind vetoes the whole message
  clear(...all4);
  for (const m of ['approve plan, not ok', "approve the plan, on second thought I don't approve", "approve plan\nI don't approve it", "approve the plan, unless the tests fail then I don't approve", "approve plan, yes I'm not sure", "approve plan, approve scope, I don't approve any of it", 'approve plan, approve scope, did I approve?']) { say(m); A(d, ['approve-pending', 'LC']); only(); }
  for (const m of ['approve plan, ok cancel', 'approve plan, ok undo', 'approve plan, ok stop', 'approve plan, ok ignore the above', 'approve plan, ok nope', 'approve plan, ok nah', 'approve plan, ok cannot', "approve plan, ok isn't", 'approve plan, approve scope, cancel', 'approve plan, approve scope, revoke', 'approve plan, approve scope, reject', 'approve plan, approve scope, nope', 'approve plan, approve scope, hmm']) { say(m); A(d, ['approve-pending', 'LC']); only(); }
  say('approve plan, approve scope'); A(d, ['approve-pending', 'LC']); only('plan', 'scope');
  clear('plan', 'scope');
  // a negated segment that names an accepted kind vetoes
  say("approve plan, I don't approve plan"); A(d, ['approve-pending', 'LC']); only();
  // 10. a single approval behaves as before: no multi line, one record
  clear('plan', 'scope'); say('approve the plan'); out = pending(); only('plan');
  assert.ok(!out.includes('multi:'), 'multi line for a single approval');
});
