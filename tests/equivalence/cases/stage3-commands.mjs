// @ts-check
// Scenario cases of the commands that move to Node in stage 3 (issue #168): the approval commands (request-approval, approve, approve-pending,
// approval-consume, answer) and the small ones. A case is a fixture state plus calls; the rig runs it once per engine and compares everything.
// The prompt captures the cases write are the bytes of control-plane/agents/scripts/core/capture.mjs (golden-tested against the old shell hook),
// so a case is also the cross-version proof: the old `approve` reads what the new writer wrote, the new one reads what the old one would have.
import { captureBytes } from '../../../control-plane/agents/scripts/core/capture.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseEnv } from '../fixture.mjs';
import { stateFixture } from './stage2-fixtures.mjs';

/** @typedef {import('../rig.mjs').Case} Case */
/** @typedef {import('../rig.mjs').Step} Step */

export const STAGE3 = Object.freeze(['next-user', 'worktree-root', 'in-knowledge-scope', 'request-approval', 'approve', 'approve-pending', 'approval-consume', 'answer', 'hook-time', 'language-check', 'friction-note', 'window-open', 'window-close']);

const ID = 'LC';
/** Run FN once, on the first call (a fixture is built only when a selected case uses it, never at import). @template T @param {() => T} fn @returns {() => T} */
const lazy = (fn) => { let done = false; /** @type {T} */ let v; return () => { if (!done) { v = fn(); done = true; } return v; }; };
/**
 * Wait until the wall clock has reached second T (never a fixed guess: the clock is read). A capture stamped T is then not in the future for the
 * commands that follow, so an approval made from it has approved_at >= capture_time on both engines (the rig's own order check). T is at most one
 * second ahead of the clock, well inside the 5 s the product tolerates for a capture date.
 * @param {number} t epoch seconds
 */
function waitUntil(t) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (Math.floor(Date.now() / 1000) < t) Atomics.wait(cell, 0, 0, 25);
}

/** A fixture that is built on the first read of its folder or its start time. @param {() => import('../fixture.mjs').Fixture} get @returns {import('../fixture.mjs').Fixture} */
const lazyFx = (get) => { const g = lazy(get); return { get dir() { return g().dir; }, get builtAt() { return g().builtAt; } }; };

const A = (/** @type {string[]} */ args, /** @type {Partial<Step>} */ o = {}) => /** @type {Step} */ ({ args, ...o });

/** A prompt capture as the hook writes it (session s1, a time after any request). @param {string} text @param {number | (() => number)} time the capture time, or a function that gives it once the fixture exists @returns {Step} */
export const capture = (text, time) => ({ write: { path: '.agents/local/prompts/s1.json', get content() { return captureBytes('s1', typeof time === 'function' ? time() : time, text).toString('utf8'); } } });

/** A capture whose hash does not match its text. @param {string} text @param {number | (() => number)} time @returns {Step} */
const forged = (text, time) => ({ write: { path: '.agents/local/prompts/s1.json', get content() { return captureBytes('s1', typeof time === 'function' ? time() : time, text).toString('utf8').replace(createHash('sha256').update(text).digest('hex'), '0'.repeat(64)); } } });


/**
 * A copy of a fixture with more requests and questions made in it (by the shell, once), and the second after the last of them: a capture
 * stamped then is newer than every request and not in the future, so both engines judge it by the grammar alone (the hardening of the capture
 * reader refuses a capture dated ahead of the clock or filed under another session; tests/equivalence/stage3-hardening.test.mjs records that).
 * @param {import('../fixture.mjs').Fixture} base @param {Array<[string[], string?]>} steps @returns {{ fx: import('../fixture.mjs').Fixture, t: number }}
 */
function derive(base, steps) {
  const dir = mkdtempSync(join(tmpdir(), 'eq-s3-'));
  cpSync(base.dir, dir, { recursive: true, verbatimSymlinks: true });
  for (const [args, input] of steps) spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: dir, env: baseEnv(dir, { PROOFLINE_ENGINE: 'sh' }), input: input ?? '', encoding: 'utf8' });
  let t = 0;
  for (const [d, re, key] of /** @type {Array<[string, RegExp, string]>} */ ([[`${dir}/.agents/runs/${ID}/approvals`, /-request-/, 'requested_at'], [`${dir}/.agents/local/approvals`, /-request-/, 'requested_at'], [`${dir}/.agents/runs/${ID}/questions`, /^\d{3}\.md$/, 'asked_at']])) {
    let names = [];
    try { names = readdirSync(d).filter((n) => re.test(n)); } catch { /* none */ }
    for (const n of names) { const m = new RegExp(`^${key}: (\\d+)`, 'm').exec(readFileSync(join(d, n), 'utf8')); if (m) t = Math.max(t, Number(m[1])); }
  }
  waitUntil(t + 1);
  return { fx: { dir, builtAt: base.builtAt }, t: t + 1 };
}


/**
 * A fixture for the single-use rule: an approval record of the plan made from a capture (written here as the engines write it, a second after the
 * request it answers), then a SECOND plan request dated before that capture. The capture is then neither stale nor in the future for the second
 * request, and only the single-use rule can refuse it. Both records are written by the build in the form the engines write them.
 * @param {import('../fixture.mjs').Fixture} base @returns {{ fx: import('../fixture.mjs').Fixture, t: number }}
 */
function deriveSingleUse(base) {
  const text = 'approve the plan';
  const sha = createHash('sha256').update(text).digest('hex');
  for (let attempt = 0; attempt < 1; attempt++) {
    const dir = mkdtempSync(join(tmpdir(), 'eq-s3-su-'));
    cpSync(base.dir, dir, { recursive: true, verbatimSymlinks: true });
    const sh = (/** @type {string[]} */ args) => spawnSync('sh', ['./.agents/scripts/agent.sh', ...args], { cwd: dir, env: baseEnv(dir, { PROOFLINE_ENGINE: 'sh' }), encoding: 'utf8' });
    const ad = `${dir}/.agents/runs/${ID}/approvals`;
    const stamp = (/** @type {string} */ n) => Number(/^requested_at: (\d+)/m.exec(readFileSync(`${ad}/${n}`, 'utf8'))?.[1]);
    const reqs = () => readdirSync(ad).filter((n) => /-request-plan\.yaml$/.test(n)).sort();
    sh(['request-approval', ID, 'plan']);
    const first = reqs().pop() ?? '';
    const t = stamp(first) + 1;
    const bound = /^bound: "(.*)"$/m.exec(readFileSync(`${ad}/${first}`, 'utf8'))?.[1] ?? '';
    const seq = String(Number(first.slice(0, 3)) + 1).padStart(3, '0');
    writeFileSync(`${ad}/${seq}-plan.yaml`, `kind: "plan"\nbound: "${bound}"\nsource: "prompt_capture"\nsession: "s1"\ncapture_sha256: "${sha}"\ncapture_id: "s1:${t}:${sha}"\ncapture_time: ${t}\nrequest: "${first}"\nanswered_by: "user"\napproved_at: ${t}\nconsumed: "false"\nreply: |\n  > ${text}`);
    // the second request, as request-approval writes it, dated like the first (no second of waiting for the shell to run twice)
    writeFileSync(`${ad}/${String(Number(seq) + 1).padStart(3, '0')}-request-plan.yaml`, `kind: "plan"\nbound: "${bound}"\nrequested_at: ${t - 1}\n`);
    mkdirSync(`${dir}/.agents/local/prompts`, { recursive: true });
    writeFileSync(`${dir}/.agents/local/prompts/s1.json`, captureBytes('s1', t, text));
    waitUntil(t);
    return { fx: { dir, builtAt: base.builtAt }, t };
  }
  throw new Error('could not build the single-use fixture');
}

/** The replies of the grammar: accepted, hedged, questions, other kinds, Turkish, several approvals. */
export const REPLIES = [
  'approve the plan', 'approve plan', 'Approve Plan!', 'plan approved', 'ok, go ahead with the plan', 'I approve the plan', 'i approved the plan for LC', 'LC için planı onaylıyorum',
  'planı onaylıyorum', 'approve the plan please', 'yes', 'approve', 'approve the plan, but wait', 'approve plan if the tests pass', 'do not approve the plan', 'approve the plan?',
  'approve the commit', 'approve scope', 'no', '', ' ', 'APPROVE THE PLAN', "approve the plan’s scope", 'approve  plan\t', 'approve\nplan', 'approve plan\r\n', '> approve the plan',
  '```\napprove plan\n```', 'approve plan, approve commit', 'approve plan\napprove commit', 'approve plan, then something else entirely and long enough to not be a plain approval phrase',
  'approve commit, approve plan, approve scope', 'approve plan; approve commit', 'tamam planı onayla', 'onayladım plan', 'Onaylıyorum: plan', 'ok plan', 'lgtm plan',
];

/** @returns {Case[]} */
/** The cases whose engines differ ON PURPOSE (stage 3 security round 2): nothing a capture or history FILE says is recorded as the user's by `next` or `answer`. See stage3-hardening.test.mjs. */
export const HARDENED = Object.freeze(['answer:typed', 'answer:captured', 'next:approval-wait']);

/** The cases both engines must answer alike. */
export function stage3Cases() { return allCases().filter((c) => !HARDENED.includes(c.name)); }

/** The cases of HARDENED. */
export function hardenedCases() { return allCases().filter((c) => HARDENED.includes(c.name)); }

function allCases() {
  /** @type {Case[]} */ const cases = [];
  const Q = '1. Which option do you want?\n   options: a | b\n   recommended: a\n   why: because\n';
  // Fixtures are built on first use by a case that runs (never at import): the plan request of the state and a request of no run; the second
  // fixture also a scope request and two open questions; the third the single-use state. Each is built once per process.
  const getBase = lazy(() => stateFixture('gates-pending-plan'));
  const getPending = lazy(() => derive(getBase(), [[['request-approval', '-', 'commit']]]));
  const getAsked = lazy(() => derive(getBase(), [[['request-approval', '-', 'commit']], [['request-approval', ID, 'scope']], [['ask', ID], Q], [['ask', ID], Q]]));
  const getSpent = lazy(() => deriveSingleUse(getBase()));
  const pending = lazyFx(() => getPending().fx);
  const asked = lazyFx(() => getAsked().fx);
  const spent = lazyFx(() => getSpent().fx);
  const T = () => getPending().t;
  const TQ = () => getAsked().t;
  const cap = (/** @type {string} */ text, /** @type {number | (() => number)} */ time = T) => capture(text, time);
  const capQ = (/** @type {string} */ text) => capture(text, TQ);
  // the replies that approve: one case each (the approval ends the question); the others are chained (a refusal changes nothing)
  const yes = REPLIES.slice(0, 10);
  const rest = REPLIES.slice(10);
  yes.forEach((text, i) => cases.push({ name: `approve:accept-${i}`, fixture: pending, steps: [cap(text), A(['approve', ID, 'plan']), A(['approve', ID, 'plan'])] }));
  for (let c = 0; c < rest.length; c += 10) {
    const part = rest.slice(c, c + 10);
    cases.push({ name: `approve:refuse-${c / 10}`, fixture: pending, steps: part.flatMap((t) => [cap(t), A(['approve', ID, 'plan'])]) });
    cases.push({ name: `approve-pending:chain-${c / 10}`, fixture: pending, steps: [...part.flatMap((t) => [cap(t), A(['approve-pending', ID])])] });
  }
  yes.forEach((text, i) => { if (i % 3 === 0) cases.push({ name: `approve-pending:accept-${i}`, fixture: pending, steps: [cap(text), A(['approve-pending', ID]), A(['approve-pending', ID])] }); });
  cases.push({ name: 'approve:stale-capture', fixture: pending, steps: [cap('approve the plan', 1), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:hash-mismatch', fixture: pending, steps: [forged('approve the plan', T), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:no-capture', fixture: pending, steps: [A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approve:no-request', fixture: pending, steps: [cap('approve the commit'), A(['approve', ID, 'scope']), A(['approve', ID, 'bogus']), A(['approve', '-', 'plan']), A(['approve', ID])] });
  // single use (Invariant 3): a capture approves ONE request. The first approval is made while the fixture is built; the second plan request is made
  // before the capture's time (the capture is dated two seconds after the first request, which the clock reader accepts as not far ahead), so the
  // same capture is neither stale nor in the future for it and only the single-use rule can refuse it.
  cases.push({ name: 'approve:single-use-two-requests', fixture: spent, steps: [A(['approve', ID, 'plan']), A(['approve-pending', ID]), A(['approve', ID, 'plan'], { role: 'reviewer' })] });
  cases.push({ name: 'approve:role-denied', fixture: pending, steps: [cap('approve the plan'), A(['approve', ID, 'plan'], { role: 'implementer' }), A(['approve', ID, 'plan'], { role: 'reviewer' })] });
  cases.push({ name: 'approve:several-kinds', fixture: asked, steps: [capQ('approve plan, approve commit'), A(['approve', ID, 'plan', 'scope']), A(['approve', '-', 'commit'])] });
  cases.push({ name: 'request-approval:kinds', fixture: pending, steps: [A(['request-approval', ID, 'plan']), A(['request-approval', ID, 'destructive']), A(['request-approval', ID, 'scope']), A(['request-approval', ID, 'budget']), A(['request-approval', ID, 'mutation_budget']), A(['request-approval', '-', 'push']), A(['request-approval', ID, 'commit']), A(['request-approval', '-', 'plan']), A(['request-approval', ID, 'bogus']), A(['request-approval', ID, 'reopen:LC']), A(['request-approval', ID, 'waive:X-1']), A(['request-approval', ID, 'rule:R1']), A(['request-approval', ID, 'rationale:p-1']), A(['request-approval', '-', 'report']), A(['request-approval', '-', 'batch']), A(['request-approval', 'NOPE', 'plan']), A(['request-approval', ID, 'plan'], { role: 'reviewer' })] });
  cases.push({ name: 'request-approval:turkish', fixture: pending, steps: [{ write: { path: '.agents/runs/LC/TASK.md', content: '# Task\n\nLanguage: tr\n' } }, A(['request-approval', ID, 'plan']), A(['request-approval', ID, 'destructive'])] });
  cases.push({ name: 'request-approval:turkish-quote', fixture: pending, steps: [{ write: { path: '.agents/runs/LC/TASK.md', content: '# Task\n\n> bunu yap lütfen ve sonra bir şey daha\n' } }, A(['request-approval', ID, 'plan'])] });
  cases.push({ name: 'request-approval:phrases-config', fixture: pending, steps: [{ write: { path: '.agents/config.yaml', content: 'approval:\n  phrases: "ship it, go"\n' } }, A(['request-approval', ID, 'plan']), cap('ship it plan'), A(['approve', ID, 'plan'])] });
  cases.push({ name: 'approval-consume', fixture: pending, steps: [cap('approve the plan'), A(['approve', ID, 'plan']), A(['approval-consume', ID, 'plan']), A(['approval-consume', ID, 'plan']), A(['approval-consume', ID]), A(['approval-consume', ID, 'bogus'])] });
  cases.push({ name: 'approval-consume:commit', fixture: pending, steps: [cap('approve the commit'), A(['approve-pending', ID]), A(['fingerprint', ID, 'full']), A(['approval-consume', '-', 'commit']), A(['approval-consume', '-', 'commit', 'deadbeef', 'refs/heads/x'])] });
  cases.push({ name: 'worktree-root', fixture: pending, steps: [A(['worktree-root', '/nope']), A(['worktree-root', 'rel']), A(['worktree-root', '/a/../b']), A(['worktree-root']), A(['worktree-root', '/tmp/x/.agents/local/worktrees/a'])] });
  cases.push({ name: 'in-knowledge-scope', fixture: pending, steps: [A(['in-knowledge-scope', 'docs/design/a.md']), A(['in-knowledge-scope', 'src/a.go']), A(['in-knowledge-scope', 'docs/adr/0001.md']), A(['in-knowledge-scope']), A(['in-knowledge-scope', 'docs/wiki'])] });
  cases.push({ name: 'friction-note', fixture: pending, steps: [A(['friction-note', ID, 'user-command']), A(['friction-note', ID, 'proofline_bug']), A(['friction-note', ID, 'bogus']), A(['friction-note', ID]), A(['friction-note', 'NOPE', 'user-shell']), A(['friction-note', ID, 'user-shell'], { role: 'reviewer' })] });
  cases.push({ name: 'hook-time', fixture: pending, steps: [{ write: { path: '.agents/local/hook-times', content: '1|prompt|10|ok|\n2|prompt|30|ok|\n3|stop|5|timeout|why\n4|bad name|3|ok|\n5|session|007|ok|\n6|prompt|abc|ok|\n' } }, A(['hook-time', ID]), A(['hook-time', ID]), A(['hook-time', '-']), A(['hook-time'])] });
  cases.push({ name: 'language-check', fixture: pending, steps: [A(['language-check', '-'], { stdin: 'plain English text\n' }), A(['language-check', '-'], { stdin: 'café çalışma öğretmen\n' }), A(['language-check', '-'], { stdin: '> café çalışma öğretmen\n' }), A(['language-check', 'README.md']), A(['language-check', 'missing.md']), A(['language-check'], { stdin: '中文中文中文' }), A(['language-check', '-', '.agents/runs/LC/COMPLETION_REPORT.md'], { stdin: '<!-- proofline:summary:begin -->\nçağışüö\n<!-- proofline:summary:end -->\nok\n' })] });
  const hist = (/** @type {string} */ name, /** @type {string} */ text) => /** @type {Step} */ ({ write: { get path() { return `.agents/local/prompts/history/${TQ()}-${name}`; }, content: text } });
  cases.push({ name: 'answer:typed', fixture: asked, steps: [capQ('use a please'), A(['answer', ID, '1'], { stdin: 'use a\n' }), A(['answer', ID, '1'], { stdin: 'again\n' }), A(['answer', ID, 'x']), A(['answer', ID, '7'], { stdin: 'z' }), A(['answer', ID, '1', '--amend'])] });
  cases.push({ name: 'answer:lead-text-not-user', fixture: asked, steps: [capQ('something else'), A(['answer', ID, '1'], { stdin: 'use a' }), A(['answer', ID, '1'], { stdin: '  \n' })] });
  cases.push({ name: 'answer:captured', fixture: asked, steps: [A(['answer', ID, '1', '--captured']), hist(`aaaaaaaa.txt`, 'first remark'), hist(`bbbbbbbb.txt`, 'option b, please\nand more'), hist(`cccccccc.txt`, '<task-notification>x'), A(['answer', ID, '1', '--captured']), A(['answer', ID, '2', '--captured']), hist(`dddddddd.txt`, 'no, option a'), A(['answer', ID, '2', '--captured']), A(['answer', ID, '2', '--captured'])] });
  cases.push({ name: 'next:approval-wait', fixture: pending, steps: [A(['next', ID]), cap('hmm, maybe later'), A(['next', ID]), A(['next', ID], { role: 'reviewer' }), cap('approve the plan'), A(['next', ID], { role: 'reviewer' }), A(['next', ID]), A(['next', ID])] });
  const states = ['gates-pending-plan', 'gates-frozen', 'gates-done', 'gates-failed'];
  for (const st of states) {
    cases.push({ name: `next-user:${st}`, fixture: lazyFx(() => stateFixture(st)), steps: ['status', 'resume', 'deliver', 'knowledge', 'run', 'task', 'batch', 'queue', 'reopen', 'product', 'doctor'].map((c) => A(['next-user', c])).concat([A(['next-user', 'deliver', ID]), A(['next-user', 'status', ID]), A(['next-user', 'deliver', '--error']), A(['next-user', 'status', '--error=usage']), A(['next-user', 'bogus']), A(['next-user', '--commands']), A(['next-user']), A(['next-user', 'product', 'discover', 'frame', 'my-slug']), A(['next-user', 'product', 'assess', 'decision', 'my-slug']), A(['next-user', 'batch', 'status']), A(['next-user', 'status', '../x'])]) });
  }
  cases.push({ name: 'next-user:empty', fixture: lazyFx(() => stateFixture('empty')), steps: ['status', 'run', 'task', 'batch', 'deliver', 'init'].map((c) => A(['next-user', c])).concat([A(['next-user', 'status', '--error']), A(['next-user', '--commands'])]) });
  const frozen = lazyFx(() => stateFixture('gates-frozen'));
  cases.push({ name: 'window:orchestrated', fixture: frozen, steps: [A(['window-open', ID]), A(['window-open', ID, 'designer']), A(['window-open', ID, 'qa']), A(['window-close', ID]), A(['window-close', ID, 'deadbeef']), A(['window-open', 'NOPE']), A(['window-open', ID], { role: 'implementer' })] });
  const standalone = lazyFx(() => stateFixture('gates-standalone'));
  cases.push({ name: 'window:standalone', fixture: standalone, steps: [A(['window-open', ID]), A(['window-close', ID, 'x']), A(['window-close', ID])] });
  return cases;
}
