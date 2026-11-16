// @ts-check
// Self-test: the harness reply loop of run.mjs against a stub lead that plays the REAL stops of the 2026-11-16 campaign (tests/e2e/fixtures/real-stops.json: the CRITICAL
// intent interview and the COMPLEX refreeze with a plan and a scope request). No runtime, network or model is called. The stub keeps a call counter and, per call, writes the
// approvals/ files and prints the message the scenario script gives.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { here, repo, runE2e } from './runner.mjs';
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';
import { A, accepted, project } from '../core/legacy-lib.mjs';
import { HARD_REPLY_CAP, openApprovals, refreezeCount, replyBudget, stopDecision, questionScript } from './lib.mjs';

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
if (script.forever) {
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
 * @param {string} scenario @param {object} script @param {string} sub @param {Record<string, string>} [env]
 * @returns {{ summary: string, log: string }}
 */
function play(scenario, script, sub, env = {}) {
  const r = path.join(root, sub);
  rmSync(r, { recursive: true, force: true });
  const sf = path.join(root, `${sub}.json`);
  writeFileSync(sf, JSON.stringify(script));
  const res = runE2e([scenario, 'claude'], { STUB_SCRIPT: sf, E2E_ROOT: r, PATH: PATHENV, ...env });
  assert.equal(res.status, 0, `run failed: ${res.out}`);
  const out = findOut(r);
  return { summary: readFileSync(path.join(out, 'summary.txt'), 'utf8'), log: readFileSync(path.join(out, 'replies-log.txt'), 'utf8') };
}
const replyTexts = (/** @type {string} */ log) => log.split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(' | ') + 3));

test('CRITICAL: the real intent interview (three questions, then three again) completes within 3 replies with distinct scripted lines', () => {
  const [q1, q2] = real.critical;
  const done = 'Understood. I have recorded your answers.\n\nNext step: nothing is pending.';
  const { summary, log } = play('CRITICAL', { steps: [{ text: q1 }, { text: q2 }, { text: done }] }, 'critical');
  const want = replies('question.CRITICAL.txt').filter(Boolean);
  assert.deepEqual(replyTexts(log), want, `the lines sent: ${log}`);
  assert.match(summary, /^replies=2$/m, summary);
  assert.match(summary, /^question_replies=2$/m, summary);
  assert.doesNotMatch(summary, /^stopped=max-replies$/m, summary);
  assert.notEqual(want[0], want[1], 'the second question reply repeats the first');
});

test('CRITICAL: a lead that repeats the same message gets one reply, then stopped=repeated-stop', () => {
  const [, , q3] = real.critical;
  const { summary } = play('CRITICAL', { steps: [{ text: q3 }] }, 'critical-repeat');
  assert.match(summary, /^replies=1$/m, summary);
  assert.match(summary, /^stopped=repeated-stop$/m, summary);
});

test('CRITICAL: five different open questions stop at the C-14 allowance of 3 replies, not 6', () => {
  const { summary } = play('CRITICAL', { steps: [...real.critical.slice(0, 5).map((text) => ({ text })), { text: `${real.critical[4]} again?` }] }, 'critical-cap');
  assert.match(summary, /^replies=3$/m, summary);
  assert.match(summary, /^stopped=max-replies$/m, summary);
  assert.match(summary, /^reply_budget=3$/m, summary);
});

const plan = (/** @type {string} */ n, /** @type {string} */ bound) => ({ name: `${n}-request-plan.yaml`, kind: 'plan', bound });
const scope = (/** @type {string} */ n, /** @type {string} */ bound) => ({ name: `${n}-request-scope.yaml`, kind: 'scope', bound });

test('COMPLEX: the refreeze after failed gates raises a plan and a scope request; one reply answers both, within 3 + 1', () => {
  const steps = [
    { text: real.complexPlan, create: [plan('001', 'A')] },
    { text: 'Gates failed.\n\nQUESTIONS:\n1. A tag that is exactly "." can be added but never removed. How should the fix round handle it?', answer: [{ kind: 'plan', request: '001-request-plan.yaml' }] },
    { text: real.complexRefreeze, create: [plan('003', 'B'), scope('004', 'B')] },
    { text: 'Approvals recorded. Starting the fix round.', answer: [{ kind: 'plan', request: '003-request-plan.yaml' }, { kind: 'scope', request: '004-request-scope.yaml' }] },
  ];
  const { summary, log } = play('COMPLEX', { steps }, 'complex-refreeze');
  const texts = replyTexts(log);
  assert.equal(texts[2], replies('COMPLEX.txt')[2], `the refreeze reply: ${log}`);
  assert.match(summary, /^replies=3$/m, summary);
  assert.match(summary, /^plan_approval_replies=1$/m, summary);
  assert.match(summary, /^refreeze_approval_replies=1$/m, summary);
  assert.match(summary, /^question_replies=1$/m, summary);
  assert.match(summary, /^reply_budget=4$/m, summary);
  assert.doesNotMatch(summary, /^stopped=(max-replies|repeated-stop)$/m, summary);   // the run ends with a message that asks nothing
});

test('COMPLEX: a second refreeze is answered too (allowance 3 + 2)', () => {
  const steps = [
    { text: real.complexPlan, create: [plan('001', 'A')] },
    { text: 'Q?', answer: [{ kind: 'plan', request: '001-request-plan.yaml' }] },
    { text: real.complexRefreeze, create: [plan('003', 'B'), scope('004', 'B')] },
    { text: real.complexRefreeze, answer: [{ kind: 'plan', request: '003-request-plan.yaml' }, { kind: 'scope', request: '004-request-scope.yaml' }], create: [plan('007', 'C'), scope('008', 'C')] },
    { text: 'done', answer: [{ kind: 'plan', request: '007-request-plan.yaml' }, { kind: 'scope', request: '008-request-scope.yaml' }] },
  ];
  const { summary } = play('COMPLEX', { steps }, 'complex-two');
  assert.match(summary, /^replies=4$/m, summary);
  assert.match(summary, /^refreeze_approval_replies=2$/m, summary);
  assert.match(summary, /^reply_budget=5$/m, summary);
  assert.doesNotMatch(summary, /^stopped=(max-replies|repeated-stop)$/m, summary);
});

test('a lead that raises a new plan and scope request after every reply stops at the hard cap', () => {
  const { summary } = play('COMPLEX', { forever: true }, 'forever');
  assert.match(summary, new RegExp(`^replies=${HARD_REPLY_CAP}$`, 'm'), summary);
  assert.match(summary, /^stopped=max-replies$/m, summary);
});

test('a scope request alone is never answered, also next to a commit request', () => {
  const { summary } = play('COMPLEX', { steps: [{ text: 'Approve scope for T-1?', create: [scope('001', 'A')] }] }, 'scope-alone');
  assert.match(summary, /^replies=0$/m, summary);
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

test('lib: the question script is the lines of question.<SCENARIO>.txt, line 1 only for a generic file', () => {
  assert.deepEqual(questionScript(path.join(here, 'replies/question.CRITICAL.txt'), false), replies('question.CRITICAL.txt').filter(Boolean));
  assert.deepEqual(questionScript(path.join(here, 'replies/COMPLEX.txt'), true), [replies('COMPLEX.txt')[0]]);
  assert.deepEqual(questionScript(path.join(root, 'absent.txt'), false), []);
  assert.ok(existsSync(path.join(repo, 'tests/e2e/replies')));
});

test('the refreeze reply line is read by the real approval grammar as a plan AND a scope approval; the question lines hold no approval', () => {
  const d = project('scaffold standalone no TRIVIAL supervised');
  const ad = `${d}/.agents/runs/LC/approvals`;
  for (const k of ['plan', 'scope']) accepted(A(d, ['request-approval', 'LC', k]), `request ${k}`);
  const t0 = Math.max(...readdirSync(ad).filter((n) => n.includes('request')).map((n) => Number(/^requested_at: (\d+)/m.exec(readFileSync(`${ad}/${n}`, 'utf8'))?.[1])));
  for (const f of ['COMPLEX.txt', 'CRITICAL.txt']) {
    for (const n of readdirSync(ad)) if (!n.includes('request')) rmSync(`${ad}/${n}`);
    storePrompt(`${d}/.agents/local`, 's1', t0 + 1, replies(f)[2] ?? '');
    A(d, ['approve-pending', 'LC']);
    const got = readdirSync(ad).filter((n) => /^\d{3}-(plan|scope)\.yaml$/.test(n)).map((n) => n.replace(/^\d+-|\.yaml$/g, '')).sort();
    assert.deepEqual(got, ['plan', 'scope'], `${f} line 3 is not read as two approvals`);
  }
  const phrases = JSON.parse(readFileSync(path.join(repo, 'tests/golden/approvals/grammar.json'), 'utf8')).phrases.split('\n').filter(Boolean).map((x) => x.trim().toLowerCase());
  for (const line of replies('question.CRITICAL.txt').filter(Boolean)) {
    assert.ok(!line.includes('?'), `question line holds a question mark: ${line}`);
    assert.doesNotMatch(line, /migration|expand|contract|destructive|approve|plan|stage|later/i, line);
    const norm = ` ${line.toLowerCase().replace(/[^a-z0-9_-]/g, ' ').replace(/ +/g, ' ')} `;
    for (const ph of phrases) assert.ok(!norm.includes(` ${ph} `), `question line holds the approval phrase '${ph}': ${line}`);
  }
});
