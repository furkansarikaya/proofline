// @ts-check
// Self-test: the harness reply loop of run.mjs against a stub lead that plays the REAL stops of the 2026-11-16 campaign (tests/e2e/fixtures/real-stops.json: the CRITICAL
// intent interview and the COMPLEX refreeze with a plan and a scope request). No runtime, network or model is called. The stub keeps a call counter and, per call, writes the
// approvals/ files and prints the message the scenario script gives.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, describe, test } from 'node:test';
import { here, repo, runE2e } from './runner.mjs';
import { validApprovalKind } from '../../control-plane/agents/scripts/core/approvals.mjs';
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';
import { A, accepted, project } from '../core/legacy-lib.mjs';
import { HARD_REPLY_CAP, LISTABLE_KINDS, PRODUCT_KINDS, candidateKinds, listedProblem, loadListedApprovals, openApprovals, openAssumptions, pendingKind, pickListed, productRequests, refreezeCount, replyBudget, stopDecision, questionScript } from './lib.mjs';

const root = tempDir('e2e-stops-');
after(() => rmSync(root, { recursive: true, force: true }));
const bin = path.join(root, 'bin');
mkdirSync(bin);
const PATHENV = `${bin}${path.delimiter}${process.env.PATH}`;
/** @type {{ critical: string[], complexRefreeze: string, complexPlan: string }} */
const real = JSON.parse(readFileSync(path.join(here, 'fixtures/real-stops.json'), 'utf8'));
const replies = (/** @type {string} */ f) => readFileSync(path.join(here, 'replies', f), 'utf8').split('\n');

// The stub: node program run by a `claude` shell wrapper; STUB_SCRIPT is a JSON file { steps: [{ text, create: { name: content } , answer: [{ name, request }] }], repeat?: 'refreeze-forever' }.
const stubJs = path.join(root, 'stub.mjs');
writeFileSync(stubJs, `import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
const script = JSON.parse(readFileSync(process.env.STUB_SCRIPT, 'utf8'));
// the harness also calls claude once to probe the model: only a lead session (stream-json) is a step
if (!process.argv.includes('stream-json')) { process.stdout.write('ok\\n'); process.exit(0); }
mkdirSync('.agents/local', { recursive: true });
const cf = '.agents/local/stub-calls';
const n = existsSync(cf) ? Number(readFileSync(cf, 'utf8')) : 0;
writeFileSync(cf, String(n + 1));
const dir = '.agents/runs/none/approvals';
const next = () => String(readdirSync(dir).length + 1).padStart(3, '0');
let text;
if (script.forever && n >= 13) {
  // iteration guard: a harness without its cap must fail in seconds, not by timeout
  text = 'Guard: stub finished.';
} else if (script.forever) {
  // a bug: every call freezes a different plan and raises a plan and a scope request
  mkdirSync(dir, { recursive: true });
  for (const k of ['plan', 'scope']) writeFileSync(dir + '/' + next() + '-request-' + k + '.yaml', 'kind: "' + k + '"\\nbound: "H' + n + '"\\nrequested_at: ' + n + '\\n');
  text = 'Approve plan, approve scope.';
} else {
  const step = script.steps[Math.min(n, script.steps.length - 1)];
  text = step.text;
  mkdirSync(dir, { recursive: true });
  for (const a of step.answer ?? []) writeFileSync(dir + '/' + next() + '-' + a.kind + '.yaml', 'kind: "' + a.kind + '"\\nrequest: "' + a.request + '"\\nanswered_by: "user"\\n');
  for (const c of step.create ?? []) writeFileSync(dir + '/' + c.name, 'kind: "' + c.kind + '"\\nbound: "' + c.bound + '"\\nrequested_at: 1\\n');
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\\n' + JSON.stringify({ type: 'result', result: text }) + '\\n');
`);
writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`);
chmodSync(path.join(bin, 'claude'), 0o755);

/** @param {string} dir */
function findOut(dir) {
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (!statSync(p).isDirectory()) continue;
    if (n === 'out') return p;
    const f = findOut(p);
    if (f) return f;
  }
  return '';
}
/**
 * One harness run, asynchronous so the loop tests of this file run side by side (each has its own E2E_ROOT and stub counter). E2E_RUNNER replaces the default runner like in runner.mjs.
 * @param {string} scenario @param {object} script @param {string} sub @param {Record<string, string>} [env]
 * @returns {Promise<{ summary: string, log: string }>}
 */
async function play(scenario, script, sub, env = {}) {
  const r = path.join(root, sub);
  rmSync(r, { recursive: true, force: true });
  const sf = path.join(root, `${sub}.json`);
  writeFileSync(sf, JSON.stringify(script));
  const custom = process.env.E2E_RUNNER ? process.env.E2E_RUNNER.split(' ') : null;
  const [cmd, ...pre] = custom ?? [process.execPath, path.join(here, 'run.mjs')];
  const status = await new Promise((resolve) => {
    const c = spawn(/** @type {string} */ (cmd), [...pre.map((x) => (x.startsWith('tests/') ? path.join(repo, x) : x)), scenario, 'claude'], { cwd: repo, env: { ...process.env, STUB_SCRIPT: sf, E2E_ROOT: r, PATH: PATHENV, ...env }, stdio: 'ignore' });
    c.on('close', resolve);
  });
  assert.equal(status, 0, `run failed (${sub})`);
  const out = findOut(r);
  return { summary: readFileSync(path.join(out, 'summary.txt'), 'utf8'), log: readFileSync(path.join(out, 'replies-log.txt'), 'utf8') };
}
/** A listing path that does not exist: no listed approvals (the behaviour of a scenario without an approvals file). */
const NO_LISTING = { E2E_APPROVALS_FILE: path.join(root, 'no-such-listing.txt') };
/** @param {string} name @param {string} text the listing file, written under the temp root @returns {Record<string, string>} */
const listing = (name, text) => { const f = path.join(root, name); writeFileSync(f, text); return { E2E_APPROVALS_FILE: f }; };
const replyTexts = (/** @type {string} */ log) => log.split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(' | ') + 3));

describe('reply loop against the stub lead', { concurrency: true }, () => {
test('CRITICAL: the real intent interview (three questions, then three again) completes within 3 replies with distinct scripted lines', async () => {
  const [q1, q2] = real.critical;
  const done = 'Understood. I have recorded your answers.\n\nNext step: nothing is pending.';
  const { summary, log } = await play('CRITICAL', { steps: [{ text: q1 }, { text: q2 }, { text: done }] }, 'critical');
  const want = replies('question.CRITICAL.txt').filter(Boolean);
  assert.deepEqual(replyTexts(log), want, `the lines sent: ${log}`);
  assert.match(summary, /^replies=2$/m, summary);
  assert.match(summary, /^question_replies=2$/m, summary);
  assert.doesNotMatch(summary, /^stopped=max-replies$/m, summary);
  assert.notEqual(want[0], want[1], 'the second question reply repeats the first');
});

test('CRITICAL: a lead that repeats the same message gets one reply, then stopped=repeated-stop', async () => {
  const [, , q3] = real.critical;
  const { summary } = await play('CRITICAL', { steps: [{ text: q3 }] }, 'critical-repeat');
  assert.match(summary, /^replies=1$/m, summary);
  assert.match(summary, /^stopped=repeated-stop$/m, summary);
});

test('CRITICAL: five different open questions stop at the C-14 allowance of 3 replies, not 6', async () => {
  const { summary } = await play('CRITICAL', { steps: [...real.critical.slice(0, 5).map((text) => ({ text })), { text: `${real.critical[4]} again?` }] }, 'critical-cap');
  assert.match(summary, /^replies=3$/m, summary);
  assert.match(summary, /^stopped=max-replies$/m, summary);
  assert.match(summary, /^reply_budget=3$/m, summary);
});

const plan = (/** @type {string} */ n, /** @type {string} */ bound) => ({ name: `${n}-request-plan.yaml`, kind: 'plan', bound });
const scope = (/** @type {string} */ n, /** @type {string} */ bound) => ({ name: `${n}-request-scope.yaml`, kind: 'scope', bound });

test('COMPLEX: the refreeze after failed gates raises a plan and a scope request; one reply approves the plan only, within 3 + 1', async () => {
  const steps = [
    { text: real.complexPlan, create: [plan('001', 'A')] },
    { text: 'Gates failed.\n\nQUESTIONS:\n1. A tag that is exactly "." can be added but never removed. How should the fix round handle it?', answer: [{ kind: 'plan', request: '001-request-plan.yaml' }] },
    { text: real.complexRefreeze, create: [plan('003', 'B'), scope('004', 'B')] },
    { text: 'Approvals recorded. Starting the fix round.', answer: [{ kind: 'plan', request: '003-request-plan.yaml' }] },
  ];
  const { summary, log } = await play('COMPLEX', { steps }, 'complex-refreeze', NO_LISTING);
  const texts = replyTexts(log);
  assert.equal(texts[2], replies('COMPLEX.txt')[2], `the refreeze reply: ${log}`);
  assert.doesNotMatch(texts[2] ?? '', /scope/i, 'the refreeze reply must hold no scope approval');
  assert.match(summary, /^replies=3$/m, summary);
  assert.match(summary, /^plan_approval_replies=1$/m, summary);
  assert.match(summary, /^refreeze_approval_replies=1$/m, summary);
  assert.match(summary, /^question_replies=1$/m, summary);
  assert.match(summary, /^reply_budget=4$/m, summary);
  assert.doesNotMatch(summary, /^stopped=(max-replies|repeated-stop)$/m, summary);   // the run ends with a message that asks nothing
});

test('COMPLEX: a second refreeze is answered too (allowance 3 + 2)', async () => {
  const steps = [
    { text: real.complexPlan, create: [plan('001', 'A')] },
    { text: 'Q?', answer: [{ kind: 'plan', request: '001-request-plan.yaml' }] },
    { text: real.complexRefreeze, create: [plan('003', 'B'), scope('004', 'B')] },
    { text: real.complexRefreeze, answer: [{ kind: 'plan', request: '003-request-plan.yaml' }], create: [plan('007', 'C'), scope('008', 'C')] },
    { text: 'done', answer: [{ kind: 'plan', request: '007-request-plan.yaml' }] },
  ];
  const { summary } = await play('COMPLEX', { steps }, 'complex-two', NO_LISTING);
  assert.match(summary, /^replies=4$/m, summary);
  assert.match(summary, /^refreeze_approval_replies=2$/m, summary);
  assert.match(summary, /^reply_budget=5$/m, summary);
  assert.doesNotMatch(summary, /^stopped=(max-replies|repeated-stop)$/m, summary);
});

test('a lead that raises a new plan and scope request after every reply stops at the hard cap', async () => {
  const { summary } = await play('COMPLEX', { forever: true }, 'forever');
  // the stub stops raising requests after 3 calls beyond the cap: a missing cap shows as replies > 12 within seconds, not as a timeout
  assert.match(summary, new RegExp(`^replies=${HARD_REPLY_CAP}$`, 'm'), summary);
  assert.match(summary, /^stopped=max-replies$/m, summary);
});

test('a scope request alone is never answered, also next to a commit request', async () => {
  const { summary } = await play('COMPLEX', { steps: [{ text: 'Approve scope for T-1?', create: [scope('001', 'A')] }] }, 'scope-alone', NO_LISTING);
  assert.match(summary, /^replies=0$/m, summary);
  assert.match(summary, /^stopped=unanswered-scope$/m, summary);
});

test('a scope request left open after the refreeze reply ends the run as stopped=unanswered-scope, also when the lead then asks a question', async () => {
  const steps = [
    { text: real.complexPlan, create: [plan('001', 'A')] },
    { text: 'Gates failed. Which option do you prefer?', answer: [{ kind: 'plan', request: '001-request-plan.yaml' }] },
    { text: real.complexRefreeze, create: [plan('003', 'B'), scope('004', 'B')] },
    { text: 'Plan recorded. Which option do you prefer for the test exceptions?', answer: [{ kind: 'plan', request: '003-request-plan.yaml' }] },
  ];
  const { summary } = await play('COMPLEX', { steps }, 'scope-left', NO_LISTING);
  assert.match(summary, /^replies=3$/m, summary);
  assert.match(summary, /^stopped=unanswered-scope$/m, summary);
});

for (const k of ['destructive', 'scope', 'commit']) {
  test(`a ${k} request that stays open ends the run as stopped=unanswered-${k}`, async () => {
    const { summary } = await play('COMPLEX', { steps: [{ text: 'Waiting.', create: [{ name: `001-request-${k}.yaml`, kind: k, bound: 'A' }] }] }, `unanswered-${k}`, NO_LISTING);
    assert.match(summary, /^replies=0$/m, summary);
    assert.match(summary, new RegExp(`^stopped=unanswered-${k}$`, 'm'), summary);
  });
}


// ---- Listed approvals (A328) ----
const SCOPE_ASK = 'Approve scope for T-1?\n\nQUESTIONS:\n1. Approve scope for T-1?\n   options: approve | reject';

test('listed approval: a scope request that is open gets the listed message once, logged as listed-approval, counted beside the C-14 allowance', async () => {
  const steps = [{ text: SCOPE_ASK, create: [scope('001', 'A')] }, { text: 'Scope recorded.', answer: [{ kind: 'scope', request: '001-request-scope.yaml' }] }];
  const { summary, log } = await play('COMPLEX', { steps }, 'listed-scope', listing('l-scope.txt', 'scope | approve scope\n'));
  assert.deepEqual(replyTexts(log), ['approve scope']);
  assert.match(log, /^reply=1 kind=listed-approval task=none request=scope 001-request-scope\.yaml \| approve scope$/m, log);
  assert.match(summary, /^replies=1$/m, summary);
  assert.match(summary, /^listed_approval_replies=1$/m, summary);
  assert.match(summary, /^question_replies=0$/m, summary);
  assert.match(summary, /^reply_budget=4$/m, summary);   // 3 + 0 refreezes + 1 listed
  assert.doesNotMatch(summary, /^stopped=(unanswered|max-replies|repeated-stop)/m, summary);
});

test('listed approval: nothing is sent while no request of the listed kind is open (a destructive, commit, push or waiver request; a question)', async () => {
  const l = listing('l-other.txt', 'scope | approve scope\n');
  const kinds = ['destructive', 'commit', 'waive-F-1'];
  const [q, ...others] = await Promise.all([
    play('CRITICAL', { steps: [{ text: real.critical[0] ?? 'Which option?' }, { text: 'done' }] }, 'listed-question', l),
    ...kinds.map((k) => play('COMPLEX', { steps: [{ text: 'Waiting.', create: [{ name: `001-request-${k}.yaml`, kind: k, bound: 'A' }] }] }, `listed-other-${k}`, l)),
  ]);
  for (const { summary, log } of others) {
    assert.match(summary, /^replies=0$/m, summary);
    assert.match(summary, /^listed_approval_replies=0$/m, summary);
    assert.doesNotMatch(log, /listed-approval/, log);
    assert.match(summary, /^stopped=unanswered-/m, summary);
  }
  assert.doesNotMatch(q.log, /listed-approval/, q.log);
  assert.match(q.summary, /^listed_approval_replies=0$/m, q.summary);
});

test('listed approval: max-uses is per DISTINCT request (the same unchanged request is answered once even with max-uses 2; a second request gets the second use)', async () => {
  const same = [{ text: SCOPE_ASK, create: [scope('001', 'A')] }, { text: 'Still waiting for the scope.' }];
  const other = [{ text: SCOPE_ASK, create: [scope('001', 'A')] }, { text: 'A second scope request.', create: [scope('002', 'A')] }, { text: 'Still waiting.' }];
  const [one, two, three] = await Promise.all([
    play('COMPLEX', { steps: same }, 'listed-max1', listing('l-max1.txt', 'scope | approve scope\n')),
    play('COMPLEX', { steps: same }, 'listed-max2', listing('l-max2.txt', 'scope | approve scope | 2\n')),
    play('COMPLEX', { steps: other }, 'listed-max2b', listing('l-max2b.txt', 'scope | approve scope | 2\n')),
  ]);
  assert.match(one.summary, /^listed_approval_replies=1$/m, one.summary);
  assert.match(one.summary, /^stopped=unanswered-scope$/m, one.summary);
  assert.match(two.summary, /^listed_approval_replies=1$/m, two.summary);
  assert.match(two.summary, /^stopped=unanswered-scope$/m, two.summary);
  assert.match(three.summary, /^listed_approval_replies=2$/m, three.summary);
  assert.match(three.log, /request=scope 001-request-scope\.yaml/, three.log);
  assert.match(three.log, /request=scope 002-request-scope\.yaml/, three.log);
});

test('listed approval: a plain "approve scope" is withheld (logged listed-approval-withheld, nothing sent) while a rationale:scope request is open, and a no-run scope request next to it is read too', async () => {
  const steps = [{ text: SCOPE_ASK, create: [scope('001', 'A'), { name: '002-request-rationale-scope.yaml', kind: 'rationale:scope', bound: 'A' }] }];
  const { summary, log } = await play('COMPLEX', { steps }, 'listed-withheld', listing('l-withheld.txt', 'scope | approve scope\n'));
  assert.match(summary, /^listed_approval_replies=0$/m, summary);
  assert.match(summary, /^replies=0$/m, summary);
  assert.match(log, /^withheld kind=listed-approval-withheld task=none request=scope reason=the message also satisfies the open request\(s\) rationale:scope \| approve scope$/m, log);
  assert.doesNotMatch(log, /^reply=/m, log);
  assert.match(summary, /^stopped=unanswered-/m, summary);
});

// GAP (documented in A328): the assumption path is not driven through run.mjs. `agent.sh questions <ID>` needs a real run (require_run: RUN.yaml, task, ledger), which the stub lead
// cannot create; the block it parses is covered by the openAssumptions and pickListed tests below, which use the text of the real question (run COMPLEX-claude-20261117T085931Z).

test('listed approval: a refreeze is still answered by the scripted plan lines, a listing never replaces them, and the scope waits until the pair is no longer open', async () => {
  const steps = [
    { text: real.complexPlan, create: [plan('001', 'A')] },
    { text: real.complexRefreeze, answer: [{ kind: 'plan', request: '001-request-plan.yaml' }], create: [plan('003', 'B'), scope('004', 'B')] },
    { text: 'Plan recorded.', answer: [{ kind: 'plan', request: '003-request-plan.yaml' }] },
  ];
  const { summary, log } = await play('COMPLEX', { steps }, 'listed-refreeze', listing('l-refreeze.txt', 'scope | approve scope\n'));
  const texts = replyTexts(log);
  assert.equal(texts[0], replies('COMPLEX.txt')[1]);   // the plan line
  assert.equal(texts[1], replies('COMPLEX.txt')[2]);   // the refreeze line, a plan approval only
  assert.equal(texts[2], 'approve scope');             // only then the listed scope
  assert.match(summary, /^listed_approval_replies=1$/m, summary);
  assert.match(summary, /^reply_budget=5$/m, summary);   // 3 + 1 refreeze + 1 listed
});

test('listed approval: a listing that names a forbidden kind or a waiver, commit or push phrase stops the harness at startup, dry run included', () => {
  const bad = [
    'waive:REVIEW_TESTS-1 | approve waive REVIEW_TESTS-1',
    'waiver | approve the waiver',
    'commit | approve commit',
    'push | approve push',
    'delivery | approve delivery',
    'secrets | approve secrets',
    'security | approve security',
    'plan | approve plan',
    'scope | approve scope and the waiver',
    'scope | approve scope and commit it',
    'scope | approve push of the scope',
    'scope | approve scope for the security gate',
    'scope | approve scope and destructive',
    'scope | approve plan',
    'assumption | accept AS-1 and commit',
    'assumption | yes',
    'scope | approve scope | 0',
    'scope | approve scope | x',
    'scope approve scope',
    'scope | approve scope?',
    'scope |  approve scope',
    "scope | approve scope, approve com'mit",
    'scope | approve review-1',
    'scope | approve scope waiving',
    'scope | approve cleanup',
    'scope | approve tree',
  ];
  for (const [i, line] of bad.entries()) {
    const r = runE2e(['COMPLEX', 'claude', '--dry-run'], { E2E_ROOT: path.join(root, `bad-${i}`), ...listing(`bad-${i}.txt`, `${line}\n`) });
    assert.equal(r.status, 2, `'${line}' was accepted: ${r.out}`);
    assert.match(r.out, /approvals listing refused/, r.out);
    assert.ok(!existsSync(path.join(root, `bad-${i}`)), `'${line}': the harness started before refusing`);
  }
  const many = runE2e(['COMPLEX', 'claude', '--dry-run'], { E2E_ROOT: path.join(root, 'bad-many'), ...listing('bad-many.txt', 'scope | approve scope | 4\nscope | approve the scope | 4\n') });
  assert.equal(many.status, 2, many.out);
});

test('listed approval: a scenario without a listing file behaves as before (dry run says none; a scope request is not answered)', async () => {
  assert.ok(!existsSync(path.join(here, 'replies', 'approvals.STANDARD.txt')) && !existsSync(path.join(here, 'replies', 'approvals.CRITICAL.txt')));
  const dry = runE2e(['STANDARD', 'claude', '--dry-run'], { E2E_ROOT: path.join(root, 'dry-std'), E2E_APPROVALS_FILE: undefined });
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /listed approvals \(A328\): none/, dry.out);
  const { summary, log } = await play('STANDARD', { steps: [{ text: SCOPE_ASK, create: [scope('001', 'A')] }] }, 'std-scope');
  assert.match(summary, /^replies=0$/m, summary);
  assert.match(summary, /^listed_approval_replies=0$/m, summary);
  assert.match(summary, /^stopped=unanswered-scope$/m, summary);
  assert.equal(log, '');
});

test('listed approval: the COMPLEX file lists a scope approval and the AS-1 acceptance only', () => {
  const dry = runE2e(['COMPLEX', 'claude', '--dry-run'], { E2E_ROOT: path.join(root, 'dry-cx'), E2E_APPROVALS_FILE: undefined });
  assert.equal(dry.status, 0, dry.out);
  assert.match(dry.out, /listed approvals \(A328\): scope x2, assumption x1 from /, dry.out);
  assert.deepEqual(loadListedApprovals(path.join(here, 'replies', 'approvals.COMPLEX.txt')), [{ kind: 'scope', message: 'approve scope', max: 2 }, { kind: 'assumption', message: 'accept AS-1', max: 1 }]);
});

});

test('lib: openApprovals reads every unanswered request, refreezeCount the distinct plan hashes, stopDecision the pair', () => {
  const d = path.join(root, 'approvals');
  mkdirSync(d);
  const req = (/** @type {string} */ n, /** @type {string} */ k, /** @type {string} */ bound) => writeFileSync(path.join(d, `${n}-request-${k}.yaml`), `kind: "${k}"\nbound: "${bound}"\nrequested_at: 1\n`);
  req('001', 'plan', 'A');
  assert.deepEqual(openApprovals(d).map((o) => o.kind), ['plan']);
  writeFileSync(path.join(d, '002-plan.yaml'), 'kind: "plan"\nbound: "A"\nrequest: "001-request-plan.yaml"\nanswered_by: "user"\nreply: |\n  > Plan approved.\n');
  assert.deepEqual(openApprovals(d), []);
  assert.equal(refreezeCount(d), 0);
  req('003', 'plan', 'B'); req('004', 'scope', 'B');
  assert.deepEqual(openApprovals(d).map((o) => `${o.name}:${o.kind}:${o.bound}`), ['003-request-plan.yaml:plan:B', '004-request-scope.yaml:scope:B']);
  assert.equal(refreezeCount(d), 1);
  assert.equal(stopDecision('scope', openApprovals(d)), 'refreeze');
  req('005', 'plan', 'B');   // the lead asks the same plan again: no new allowance
  assert.equal(refreezeCount(d), 1);
  req('006', 'destructive', 'B');
  assert.equal(stopDecision('destructive', openApprovals(d)), 'stop');
  assert.equal(replyBudget(3, 1), 4);
  assert.equal(replyBudget(3, 99), HARD_REPLY_CAP);
});

test('lib: an approvals path that is a file (ENOTDIR) or absent reads as no request, no refreeze, no kind, never a crash', () => {
  const f = path.join(root, 'approvals-is-a-file');
  writeFileSync(f, 'x');
  assert.deepEqual(openApprovals(f), []);
  assert.equal(refreezeCount(f), 0);
  assert.equal(pendingKind('next=agent.sh freeze LC', f), '');
  assert.equal(stopDecision('', openApprovals(f), 'Which option?'), 'question');
  assert.deepEqual(openApprovals(path.join(root, 'nope')), []);
});

test('lib: the question script is the lines of question.<SCENARIO>.txt, line 1 only for a generic file', () => {
  assert.deepEqual(questionScript(path.join(here, 'replies/question.CRITICAL.txt'), false), replies('question.CRITICAL.txt').filter(Boolean));
  assert.deepEqual(questionScript(path.join(here, 'replies/COMPLEX.txt'), true), [replies('COMPLEX.txt')[0]]);
  assert.deepEqual(questionScript(path.join(root, 'absent.txt'), false), []);
  assert.ok(existsSync(path.join(repo, 'tests/e2e/replies')));
});

test('the refreeze reply line is read by the real approval grammar as a plan approval ONLY (the scope request stays open); the question lines hold no approval', () => {
  const d = project('scaffold standalone no TRIVIAL supervised');
  const ad = `${d}/.agents/runs/LC/approvals`;
  for (const k of ['plan', 'scope']) accepted(A(d, ['request-approval', 'LC', k]), `request ${k}`);
  const t0 = Math.max(...readdirSync(ad).filter((n) => n.includes('request')).map((n) => Number(/^requested_at: (\d+)/m.exec(readFileSync(`${ad}/${n}`, 'utf8'))?.[1])));
  for (const f of ['COMPLEX.txt', 'CRITICAL.txt']) {
    for (const n of readdirSync(ad)) if (!n.includes('request')) rmSync(`${ad}/${n}`);
    storePrompt(`${d}/.agents/local`, 's1', t0 + 1, replies(f)[2] ?? '');
    A(d, ['approve-pending', 'LC']);
    const got = readdirSync(ad).filter((n) => /^\d{3}-(plan|scope)\.yaml$/.test(n)).map((n) => n.replace(/^\d+-|\.yaml$/g, '')).sort();
    assert.deepEqual(got, ['plan'], `${f} line 3 must be read as the plan approval only`);
    assert.doesNotMatch(replies(f)[2] ?? '', /scope/i);
    assert.ok(readdirSync(ad).some((n) => /request-scope/.test(n)) && !got.includes('scope'), 'the scope request was satisfied');
  }
  const phrases = JSON.parse(readFileSync(path.join(repo, 'tests/golden/approvals/grammar.json'), 'utf8')).phrases.split('\n').filter(Boolean).map((x) => x.trim().toLowerCase());
  for (const line of replies('question.CRITICAL.txt').filter(Boolean)) {
    assert.ok(!line.includes('?'), `question line holds a question mark: ${line}`);
    assert.doesNotMatch(line, /migration|expand|contract|destructive|approve|plan|stage|later/i, line);
    const norm = ` ${line.toLowerCase().replace(/[^a-z0-9_-]/g, ' ').replace(/ +/g, ' ')} `;
    for (const ph of phrases) assert.ok(!norm.includes(` ${ph} `), `question line holds the approval phrase '${ph}': ${line}`);
  }
});

const none = (/** @type {number} */ n) => Array.from({ length: n }, () => new Set());
const pick = (/** @type {any} */ r) => (r && 'pick' in r ? r.pick : null);

test('lib: pickListed matches only an open request of the line\'s kind, spends uses per DISTINCT request, and judges every entry again (a hand-built waiver, commit or push line is never picked)', () => {
  const entries = [{ kind: 'scope', message: 'approve scope', max: 2 }, { kind: 'assumption', message: 'accept AS-1', max: 1 }];
  const open = (/** @type {string[]} */ ...kinds) => kinds.map((kind, i) => ({ name: `00${i + 1}-request-${kind}.yaml`, kind }));
  assert.equal(pickListed(entries, none(2), open('destructive', 'commit', 'waive:F-1'), []), null);
  assert.equal(pickListed(entries, none(2), [], []), null);
  assert.deepEqual(pick(pickListed(entries, none(2), open('plan', 'scope'), [])), { index: 0, kind: 'scope', message: 'approve scope', request: '002-request-scope.yaml' });
  // the same unchanged request is never answered a second time, though max-uses is 2; a different request is
  const used = none(2); used[0]?.add('002-request-scope.yaml');
  assert.equal(pickListed(entries, used, open('plan', 'scope'), []), null, 'the same request twice');
  assert.equal(pick(pickListed(entries, used, [...open('plan', 'scope'), { name: '005-request-scope.yaml', kind: 'scope' }], []))?.request, '005-request-scope.yaml');
  used[0]?.add('005-request-scope.yaml');
  assert.equal(pickListed(entries, used, [{ name: '009-request-scope.yaml', kind: 'scope' }], []), null, 'uses spent');
  assert.equal(pick(pickListed(entries, none(2), [], ['AS-2', 'AS-1']))?.request, 'AS-1');
  assert.equal(pickListed(entries, none(2), [], ['AS-2']), null, 'the line names AS-1 only');
  const spent = none(2); spent[1]?.add('AS-1');
  assert.equal(pickListed(entries, spent, [], ['AS-1']), null);
  const evil = [
    { kind: 'waive:REVIEW_TESTS-1', message: 'approve waive REVIEW_TESTS-1', max: 1 },
    { kind: 'scope', message: 'approve scope and waive F-1', max: 1 },
    { kind: 'commit', message: 'approve commit', max: 1 },
    { kind: 'push', message: 'approve push', max: 1 },
    { kind: 'scope', message: 'approve commit', max: 1 },
    { kind: 'scope', message: "approve scope, approve com'mit", max: 1 },
    { kind: 'delivery', message: 'approve delivery', max: 1 },
  ];
  const all = open('waive:REVIEW_TESTS-1', 'scope', 'commit', 'push', 'delivery');
  assert.equal(pickListed(evil, none(evil.length), all, ['AS-1']), null);
  for (const k of ['waive:F-1', 'waive', 'commit', 'push', 'pr', 'merge', 'delivery', 'secrets', 'security', 'plan', 'single_step', 'budget']) assert.ok(!LISTABLE_KINDS.includes(k), k);
  assert.equal(listedProblem('assumption', 'accept AS-12'), '');
  assert.equal(listedProblem('mutation_budget', 'i approve the mutation budget'), '');
  assert.equal(listedProblem('destructive', 'approve destructive'), '');
  assert.match(listedProblem('assumption', 'accept AS-1 please'), /exact acceptance form/);
});

test('lib: the exact payloads of the security report (apostrophes, commas, stems, ids, plan, tree, cleanup) never pass the loader, which asks the product grammar', () => {
  const payloads = [
    "approve scope, approve com'mit", "approve scope, approve pu'sh", "approve scope, approve mer'ge", "approve scope, approve deli'very",
    'approve review-1', 'approve REVIEW_TESTS-1', 'approve request', 'approve pull', 'approve plan', 'approve tree', 'approve cleanup',
    'approve scope; approve plan', 'approve scope & approve plan', 'approve scope\napprove plan', 'approve scope waiving', 'approve scope committing', 'approve scope pushing',
    'approve scope delivering', 'approve scope merging', 'approve scope securing', 'approve scope teslimat', 'approve scope ’commit', 'kapsamı onaylıyorum',
    'approve scope plan', 'approve scope tree', 'approve scope and cleanup',
  ];
  for (const m of payloads) assert.notEqual(listedProblem('scope', m), '', `'${m}' was accepted for scope`);
  assert.equal(listedProblem('scope', 'approve scope'), '');
  assert.equal(listedProblem('scope', 'i approve the scope'), '');
});

test('lib: the kinds the grammar is asked about are read from the product source, and a kind the product learns later fails this test until the table is read again', () => {
  for (const k of ['plan', 'destructive', 'single_step', 'scope', 'budget', 'mutation_budget', 'tree', 'commit', 'push', 'pr', 'merge', 'cleanup', 'report', 'batch', 'commands', 'rename', 'known-issue', 'scale', 'delivery']) assert.ok(PRODUCT_KINDS.includes(k), `${k} missing from the derived kinds`);
  const kinds = candidateKinds('approve review-1');
  for (const f of ['waive', 'rule', 'reopen', 'rationale']) assert.ok(kinds.includes(`${f}:review-1`), `${f} family missing`);
  // every plain kind the product accepts is in the table: probe the validator itself with the names of the sentences and words it knows
  for (const k of [...PRODUCT_KINDS, 'waive:X-1', 'rule:R-7', 'reopen:LC', 'rationale:Card-Flip']) assert.ok(typeof k === 'string' && k !== '');
  assert.ok(PRODUCT_KINDS.length >= 19, `only ${PRODUCT_KINDS.length} kinds were derived: the product source changed shape`);
  assert.deepEqual(PRODUCT_KINDS.filter((k) => k !== 'delivery' && !validApprovalKind(k)), [], 'a derived kind the product does not accept');
});

test('lib: a plain "approve scope" is sent only if the PRODUCT reads every open request as a plain scope request; rationale:/rule:/reopen:, a joint: request, a forged or malformed file withhold it', () => {
  const entries = [{ kind: 'scope', message: 'approve scope', max: 1 }];
  const proj = path.join(root, 'allopen');
  const w = (/** @type {string} */ rel, /** @type {string} */ text) => { mkdirSync(path.join(proj, path.dirname(rel)), { recursive: true }); writeFileSync(path.join(proj, rel), text); };
  const req = (/** @type {string} */ kind, /** @type {string} */ extra = '') => `kind: "${kind}"\n${extra}bound: "A"\nrequested_at: 1\n`;
  const SCOPE = '.agents/runs/T-1/approvals/003-request-scope.yaml';
  const decide = () => /** @type {any} */ (pickListed(entries, none(1), openApprovals(path.join(proj, '.agents/runs/T-1/approvals')).filter((o) => o.kind === 'scope'), [], productRequests(proj)));
  const fresh = () => { rmSync(proj, { recursive: true, force: true }); w(SCOPE, req('scope')); };
  fresh();
  assert.deepEqual(productRequests(proj).requests.map((o) => `${o.where}:${o.kind}:${o.words}`), ['T-1:scope:scope']);
  assert.equal(pick(decide())?.request, '003-request-scope.yaml');
  for (const [rel, kind] of [['.agents/runs/T-1/approvals/004-request-rationale-scope.yaml', 'rationale:scope'], ['.agents/runs/T-2/approvals/001-request-rule-scope.yaml', 'rule:scope'], ['.agents/local/approvals/001-request-reopen-scope.yaml', 'reopen:scope']]) {
    fresh(); w(/** @type {string} */ (rel), req(/** @type {string} */ (kind)));
    const r = decide();
    assert.ok(r && 'withheld' in r, `${kind}: ${JSON.stringify(r)}`);
    assert.ok(r.withheld.reason.includes(/** @type {string} */ (kind)), r.withheld.reason);
  }
  // forged 1: a commit request with joint: scope is answered by "approve scope" (approvalWords); the harness must not read it by its kind line
  fresh(); w('.agents/runs/T-1/approvals/004-request-commit.yaml', req('commit', 'joint: "scope"\n'));
  assert.deepEqual(productRequests(proj).requests.map((o) => `${o.kind}:${o.words}`).sort(), ['commit:scope', 'scope:scope']);
  let r = decide();
  assert.ok(r && 'withheld' in r && /commit \(answered with scope\)/.test(r.withheld.reason), JSON.stringify(r));
  fresh(); w('.agents/runs/T-1/approvals/004-request-commit.yaml', req('commit', 'delivery: "yes"\n'));   // a delivery commit is answered with the delivery words, which "approve scope" does not satisfy
  assert.ok(pick(decide()), 'a delivery commit request is not satisfied by approve scope');
  // forged 2 and a duplicate kind: the product reads the FIRST kind line, a regex of the harness read the last
  fresh(); w('.agents/runs/T-1/approvals/004-request-budget.yaml', 'kind: "waive:scope"\nkind: "budget"\nbound: "A"\n');
  r = decide();
  assert.ok(r && 'withheld' in r && /cannot be read unambiguously/.test(r.withheld.reason), JSON.stringify(r));
  fresh(); w('.agents/runs/T-1/approvals/004-request-scope.yaml', 'kind: "scope"\nkind: "scope"\n');
  r = decide();
  assert.ok(r && 'withheld' in r && /2 kind lines/.test(r.withheld.reason), JSON.stringify(r));
  // malformed: no kind, a kind the product does not accept, a name that is not the slug of the kind, a directory where a file should be
  for (const [name, text] of [['004-request-plan.yaml', 'bound: "A"\n'], ['004-request-bogus.yaml', 'kind: "bogus"\n'], ['004-request-plan.yaml', 'kind: "commit"\n'], ['004-request-plan.yaml', '']]) {
    fresh(); w(`.agents/runs/T-1/approvals/${name}`, /** @type {string} */ (text));
    r = decide();
    assert.ok(r && 'withheld' in r, `${name}: ${JSON.stringify(r)}`);
  }
  fresh(); mkdirSync(path.join(proj, '.agents/runs/T-1/approvals/004-request-plan.yaml'));
  r = decide();
  assert.ok(r && 'withheld' in r && /unreadable/.test(r.withheld.reason), JSON.stringify(r));
  // a no-run scope request next to the run's scope request is of the same kind and words: not a reason to withhold
  fresh(); w('.agents/local/approvals/001-request-scope.yaml', req('scope'));
  assert.ok(pick(decide()));
});

test('lib: openAssumptions reads the ASSUMPTION ids of the open question block, and a missing listing file is an empty listing', () => {
  const q = '=== QUESTION 001 (from lead)\n1. High-risk assumption AS-1 is unverified: x\n   ASSUMPTION: AS-1@dc559ed4f7bc\n   options: "accept AS-1"\n2. y\n   ASSUMPTION: AS-3@aaaaaaaaaaaa\n';
  assert.deepEqual(openAssumptions(q), ['AS-1', 'AS-3']);
  assert.deepEqual(openAssumptions('Which option do you prefer? AS-1'), []);
  assert.deepEqual(loadListedApprovals(path.join(root, 'absent-listing.txt')), []);
});

test('the listed COMPLEX scope line is read by the real approval grammar as the scope approval ONLY; the assumption line is the exact acceptance form', () => {
  const lines = loadListedApprovals(path.join(here, 'replies', 'approvals.COMPLEX.txt'));
  const scopeLine = lines.find((l) => l.kind === 'scope');
  assert.ok(scopeLine);
  const d = project('scaffold standalone no TRIVIAL supervised');
  const ad = `${d}/.agents/runs/LC/approvals`;
  for (const k of ['plan', 'scope']) accepted(A(d, ['request-approval', 'LC', k]), `request ${k}`);
  const t0 = Math.max(...readdirSync(ad).filter((n) => n.includes('request')).map((n) => Number(/^requested_at: (\d+)/m.exec(readFileSync(`${ad}/${n}`, 'utf8'))?.[1])));
  storePrompt(`${d}/.agents/local`, 's1', t0 + 1, scopeLine.message);
  A(d, ['approve-pending', 'LC']);
  const got = readdirSync(ad).filter((n) => /^\d{3}-(plan|scope)\.yaml$/.test(n)).map((n) => n.replace(/^\d+-|\.yaml$/g, '')).sort();
  assert.deepEqual(got, ['scope'], 'the listed scope line must satisfy the scope request and not the plan request');
  assert.equal(lines.find((l) => l.kind === 'assumption')?.message, 'accept AS-1');   // the hook records exactly "accept <id>" (tests/core/answer-user.test.mjs)
});
