// @ts-check
// Scenario cases of the commands that move to Node in stage 3 (issue #168): the approval commands (request-approval, approve, approve-pending,
// approval-consume, answer) and the small ones. A case is a fixture state plus calls; the rig runs it once per engine and compares everything.
// The prompt captures the cases write are the bytes of control-plane/agents/scripts/core/capture.mjs (golden-tested against the old shell hook),
// so a case is also the cross-version proof: the old `approve` reads what the new writer wrote, the new one reads what the old one would have.
import { captureBytes } from '../../../control-plane/agents/scripts/core/capture.mjs';
import { createHash } from 'node:crypto';
import { stateFixture } from './stage2-fixtures.mjs';

/** @typedef {import('../rig.mjs').Case} Case */
/** @typedef {import('../rig.mjs').Step} Step */

export const STAGE3 = Object.freeze(['next-user', 'worktree-root', 'in-knowledge-scope', 'request-approval', 'approve', 'approve-pending', 'approval-consume', 'answer', 'hook-time', 'language-check', 'friction-note', 'window-open', 'window-close']);

const ID = 'LC';
const FUTURE = 4102444800;
const A = (/** @type {string[]} */ args, /** @type {Partial<Step>} */ o = {}) => /** @type {Step} */ ({ args, ...o });

/** A prompt capture as the hook writes it (session s1, a time after any request). @param {string} text @param {number} [time] @returns {Step} */
export const capture = (text, time = FUTURE) => ({ write: { path: '.agents/local/prompts/s1.json', content: captureBytes('s1', time, text).toString('utf8') } });

/** A capture whose hash does not match its text. @param {string} text @returns {Step} */
const forged = (text) => ({ write: { path: '.agents/local/prompts/s1.json', content: captureBytes('s1', FUTURE, text).toString('utf8').replace(createHash('sha256').update(text).digest('hex'), '0'.repeat(64)) } });

/** The replies of the grammar: accepted, hedged, questions, other kinds, Turkish, several approvals. */
export const REPLIES = [
  'approve the plan', 'approve plan', 'Approve Plan!', 'plan approved', 'ok, go ahead with the plan', 'I approve the plan', 'i approved the plan for LC', 'LC için planı onaylıyorum',
  'planı onaylıyorum', 'approve the plan please', 'yes', 'approve', 'approve the plan, but wait', 'approve plan if the tests pass', 'do not approve the plan', 'approve the plan?',
  'approve the commit', 'approve scope', 'no', '', ' ', 'APPROVE THE PLAN', "approve the plan’s scope", 'approve  plan\t', 'approve\nplan', 'approve plan\r\n', '> approve the plan',
  '```\napprove plan\n```', 'approve plan, approve commit', 'approve plan\napprove commit', 'approve plan, then something else entirely and long enough to not be a plain approval phrase',
  'approve commit, approve plan, approve scope', 'approve plan; approve commit', 'tamam planı onayla', 'onayladım plan', 'Onaylıyorum: plan', 'ok plan', 'lgtm plan',
];

/** @returns {Case[]} */
export function stage3Cases() {
  /** @type {Case[]} */ const cases = [];
  const pending = stateFixture('gates-pending-plan');
  // the replies that approve: one case each (the approval ends the question); the others are chained (a refusal changes nothing)
  const yes = REPLIES.slice(0, 10);
  const rest = REPLIES.slice(10);
  yes.forEach((text, i) => cases.push({ name: `approve:accept-${i}`, fixture: pending, steps: [capture(text), A(['approve', ID, 'plan']), A(['approve', ID, 'plan'])] }));
  for (let c = 0; c < rest.length; c += 10) {
    const part = rest.slice(c, c + 10);
    cases.push({ name: `approve:refuse-${c / 10}`, fixture: pending, steps: part.flatMap((t) => [capture(t), A(['approve', ID, 'plan'])]) });
    cases.push({ name: `approve-pending:chain-${c / 10}`, fixture: pending, steps: [A(['request-approval', '-', 'commit']), ...part.flatMap((t) => [capture(t), A(['approve-pending', ID])])] });
  }
  yes.forEach((text, i) => { if (i % 3 === 0) cases.push({ name: `approve-pending:accept-${i}`, fixture: pending, steps: [A(['request-approval', '-', 'commit']), capture(text), A(['approve-pending', ID]), A(['approve-pending', ID])] }); });
  cases.push({ name: 'approve:stale-capture', fixture: pending, steps: [capture('approve the plan', 1), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:hash-mismatch', fixture: pending, steps: [forged('approve the plan'), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:no-capture', fixture: pending, steps: [A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:no-request', fixture: pending, steps: [capture('approve the commit'), A(['approve', ID, 'scope']), A(['approve', ID, 'bogus']), A(['approve', '-', 'plan']), A(['approve', ID])] });
  cases.push({ name: 'approve:single-use-two-requests', fixture: pending, steps: [capture('approve the plan'), A(['approve', ID, 'plan']), A(['request-approval', ID, 'plan']), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:role-denied', fixture: pending, steps: [capture('approve the plan'), A(['approve', ID, 'plan'], { role: 'implementer' }), A(['approve', ID, 'plan'], { role: 'reviewer' })] });
  cases.push({ name: 'approve:several-kinds', fixture: pending, steps: [A(['request-approval', '-', 'commit']), A(['request-approval', ID, 'scope']), capture('approve plan, approve commit'), A(['approve', ID, 'plan', 'scope']), A(['approve', '-', 'commit'])] });
  cases.push({ name: 'request-approval:kinds', fixture: pending, steps: [A(['request-approval', ID, 'plan']), A(['request-approval', ID, 'destructive']), A(['request-approval', ID, 'scope']), A(['request-approval', ID, 'budget']), A(['request-approval', ID, 'mutation_budget']), A(['request-approval', '-', 'commit']), A(['request-approval', '-', 'push']), A(['request-approval', ID, 'commit']), A(['request-approval', '-', 'plan']), A(['request-approval', ID, 'bogus']), A(['request-approval', ID, 'reopen:LC']), A(['request-approval', ID, 'waive:X-1']), A(['request-approval', ID, 'rule:R1']), A(['request-approval', ID, 'rationale:p-1']), A(['request-approval', '-', 'report']), A(['request-approval', '-', 'batch']), A(['request-approval', 'NOPE', 'plan']), A(['request-approval', ID, 'plan'], { role: 'reviewer' })] });
  cases.push({ name: 'request-approval:turkish', fixture: pending, steps: [{ write: { path: '.agents/runs/LC/TASK.md', content: '# Task\n\nLanguage: tr\n' } }, A(['request-approval', ID, 'plan']), A(['request-approval', ID, 'destructive'])] });
  cases.push({ name: 'request-approval:turkish-quote', fixture: pending, steps: [{ write: { path: '.agents/runs/LC/TASK.md', content: '# Task\n\n> bunu yap lütfen ve sonra bir şey daha\n' } }, A(['request-approval', ID, 'plan'])] });
  cases.push({ name: 'request-approval:phrases-config', fixture: pending, steps: [{ write: { path: '.agents/config.yaml', content: 'approval:\n  phrases: "ship it, go"\n' } }, A(['request-approval', ID, 'plan']), capture('ship it plan'), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approval-consume', fixture: pending, steps: [capture('approve the plan'), A(['approve', ID, 'plan']), A(['approval-consume', ID, 'plan']), A(['approval-consume', ID, 'plan']), A(['approval-consume', ID]), A(['approval-consume', ID, 'bogus'])] });
  cases.push({ name: 'approval-consume:commit', fixture: pending, steps: [A(['request-approval', '-', 'commit']), capture('approve the commit'), A(['approve-pending', ID]), A(['fingerprint', ID, 'full']), A(['approval-consume', '-', 'commit']), A(['approval-consume', '-', 'commit', 'deadbeef', 'refs/heads/x'])] });
  cases.push({ name: 'worktree-root', fixture: pending, steps: [A(['worktree-root', '/nope']), A(['worktree-root', 'rel']), A(['worktree-root', '/a/../b']), A(['worktree-root']), A(['worktree-root', '/tmp/x/.agents/local/worktrees/a'])] });
  cases.push({ name: 'in-knowledge-scope', fixture: pending, steps: [A(['in-knowledge-scope', 'docs/design/a.md']), A(['in-knowledge-scope', 'src/a.go']), A(['in-knowledge-scope', 'docs/adr/0001.md']), A(['in-knowledge-scope']), A(['in-knowledge-scope', 'docs/wiki'])] });
  cases.push({ name: 'friction-note', fixture: pending, steps: [A(['friction-note', ID, 'user-command']), A(['friction-note', ID, 'proofline_bug']), A(['friction-note', ID, 'bogus']), A(['friction-note', ID]), A(['friction-note', 'NOPE', 'user-shell']), A(['friction-note', ID, 'user-shell'], { role: 'reviewer' })] });
  cases.push({ name: 'hook-time', fixture: pending, steps: [{ write: { path: '.agents/local/hook-times', content: '1|prompt|10|ok|\n2|prompt|30|ok|\n3|stop|5|timeout|why\n4|bad name|3|ok|\n5|session|007|ok|\n6|prompt|abc|ok|\n' } }, A(['hook-time', ID]), A(['hook-time', ID]), A(['hook-time', '-']), A(['hook-time'])] });
  cases.push({ name: 'language-check', fixture: pending, steps: [A(['language-check', '-'], { stdin: 'plain English text\n' }), A(['language-check', '-'], { stdin: 'café çalışma öğretmen\n' }), A(['language-check', '-'], { stdin: '> café çalışma öğretmen\n' }), A(['language-check', 'README.md']), A(['language-check', 'missing.md']), A(['language-check'], { stdin: '中文中文中文' }), A(['language-check', '-', '.agents/runs/LC/COMPLETION_REPORT.md'], { stdin: '<!-- proofline:summary:begin -->\nçağışüö\n<!-- proofline:summary:end -->\nok\n' })] });
  const frozen = stateFixture('gates-frozen');
  cases.push({ name: 'window:orchestrated', fixture: frozen, steps: [A(['window-open', ID]), A(['window-open', ID, 'designer']), A(['window-open', ID, 'qa']), A(['window-close', ID]), A(['window-close', ID, 'deadbeef']), A(['window-open', 'NOPE']), A(['window-open', ID], { role: 'implementer' })] });
  const standalone = stateFixture('gates-standalone');
  cases.push({ name: 'window:standalone', fixture: standalone, steps: [A(['window-open', ID]), A(['window-close', ID, 'x']), A(['window-close', ID])] });
  return cases;
}
