// @ts-check
// The user's answers are recorded as the user's (issue #187, A171): `answer --captured` records the user's captured message, the `next` retry records
// an approval the hook missed, the batch pre-flight answers are applied at freeze. What stays refused: typed text (always the lead's), a capture older
// than the question, dated more than 5 s ahead, filed under another session, forged, a task-notification, or already used by another answer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { storePrompt } from '../../control-plane/agents/scripts/core/capture.mjs';
import { run as runCore } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { repo } from './helpers.mjs';

const scripts = path.join(repo, 'control-plane/agents/scripts');
const NARROW = `awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "3"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml`;
/** @type {Record<string, string>} */ const templates = {};
let base = '';
let counter = 0;

/** A scaffolded project (the self-test library builds it, the Node core is put beside agent.sh). @param {string} script */
function build(script) {
  const out = mkdtempSync(path.join(tmpdir(), 'ans-fx-'));
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; PROOFLINE_ENGINE=sh; export PROOFLINE_ENGINE; ${script}; cp -R "$PWD/." "$EQ_OUT/"`, path.join(scripts, 'x.sh')],
    { env: cleanEnv({ EQ_LIB: path.join(scripts, 'test-lib.sh'), EQ_OUT: out }), encoding: 'utf8', timeout: 100000 });
  assert.equal(r.status, 0, `fixture: ${r.stderr}${r.stdout}`);
  cpSync(path.join(scripts, 'proofline-core.mjs'), path.join(out, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scripts, 'core'), path.join(out, '.agents/scripts/core'), { recursive: true });
  cpSync(path.join(scripts, 'batch.sh'), path.join(out, '.agents/scripts/batch.sh'));
  appendFileSync(path.join(out, '.git/info/exclude'), '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n.agents/local/\n');
  return out;
}
before(() => {
  base = mkdtempSync(path.join(tmpdir(), 'ans-'));
  templates.plain = build('scaffold standalone no COMPLEX manual');
  templates.split = build(`SC_SCOPE_EXTRA=AC-1 SC_SCOPE_OTHER=AC-1 scaffold standalone no STANDARD manual; ${NARROW}`);
});
after(() => { for (const t of Object.values(templates)) rmSync(t, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {string} kind */
function project(kind) { const d = path.join(base, `p${++counter}`); cpSync(templates[kind], d, { recursive: true }); return d; }
/** The default (Node) engine. @param {string} dir @param {string[]} args @param {string} [input] */
function agent(dir, args, input = '') {
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: dir, env: cleanEnv({}), input, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: r.stdout, err: r.stderr, text: r.stdout + r.stderr };
}
/** `freeze` as the self-tests run it: the QA plan cites the sha256 of the current PLAN.md first (test-lib qa_bind). @param {string} dir */
function freeze(dir) {
  const plan = readFileSync(`${dir}/.agents/runs/LC/PLAN.md`);
  const qa = `${dir}/.agents/runs/LC/QA_PLAN.md`;
  if (existsSync(qa)) {
    const lines = readFileSync(qa, 'utf8').split('\n');
    writeFileSync(qa, [lines[0], '', `Plan sha256: ${createHash('sha256').update(plan).digest('hex')}`, ...lines.slice(1).filter((l) => !l.startsWith('Plan sha256: '))].join('\n'));
  }
  return agent(dir, ['freeze', 'LC']);
}
const now = () => Math.floor(Date.now() / 1000);
/** A prompt the hook stored: capture file and history copy. @param {string} dir @param {string} text @param {number} [time] @param {string} [session] */
function say(dir, text, time = now(), session = 's1') {
  const r = storePrompt(`${dir}/.agents/local`, session, time, text);
  assert.ok(r);
  return r;
}
const read = (/** @type {string} */ dir, /** @type {string} */ f) => readFileSync(path.join(dir, '.agents/runs/LC', f), 'utf8');
const Q = '1. Which option do you want?\n   options: a | b\n   recommended: a\n   why: because\n';
const ask = (/** @type {string} */ dir, text = Q) => { const r = agent(dir, ['ask', 'LC'], text); assert.equal(r.status, 0, r.text); };

test('typed text is the lead\'s answer, even when the user said the same words', () => {
  const d = project('plain'); ask(d);
  say(d, 'use a please');
  const r = agent(d, ['answer', 'LC', '1'], 'use a please\n');
  assert.equal(r.status, 0, r.text);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: lead$/m);
});

test('answer --captured: the user\'s newest message since the question is recorded as the user\'s, verbatim, once', () => {
  const d = project('plain'); ask(d); ask(d);
  say(d, 'option b, please\nand more');
  const r = agent(d, ['answer', 'LC', '1', '--captured']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /answered_by=user/);
  const a = read(d, 'questions/001.answer.md');
  assert.match(a, /^answered_by: user$/m); assert.match(a, /^source_message: \d+-[0-9a-f]{8}\.txt$/m); assert.match(a, /^> option b, please\n> and more$/m);
  const again = agent(d, ['answer', 'LC', '2', '--captured']);
  assert.notEqual(again.status, 0); assert.match(again.err, /already answered another question/);
  say(d, 'and for the second one: a', now() + 1);
  assert.equal(agent(d, ['answer', 'LC', '2', '--captured']).status, 0);
  assert.match(read(d, 'questions/002.answer.md'), /^answered_by: user$/m);
});

test('answer --captured: the assumption acceptance is exactly "accept <id>" and nothing hedged', () => {
  const d = project('plain');
  ask(d, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  say(d, 'accept AS-1 unless the reviewer objects');
  const hedged = agent(d, ['answer', 'LC', '1', '--captured']);
  assert.equal(hedged.status, 0, hedged.text);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: lead$/m);
  assert.match(hedged.out, /not an acceptance the user's own prompt carries/);
  const e = project('plain');
  ask(e, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  say(e, 'Accept AS-1');
  const ok = agent(e, ['answer', 'LC', '1', '--captured']);
  assert.equal(ok.status, 0, ok.text);
  assert.match(read(e, 'questions/001.answer.md'), /^answered_by: user\n[^]*---\naccept AS-1\n$/);
});

test('answer --captured: stale, future, forged, notification and blank messages are no answer', () => {
  const d = project('plain'); ask(d);
  const t = now();
  say(d, 'old words', t - 100);
  say(d, 'words from the future', t + 100);
  writeFileSync(`${d}/.agents/local/prompts/history/${t}-deadbeef.txt`, 'forged name, hash does not match');
  writeFileSync(`${d}/.agents/local/prompts/history/${t}-${'0'.repeat(8)}.txt`, '');
  say(d, '<task-notification>background agent finished</task-notification>', t);
  const r = agent(d, ['answer', 'LC', '1', '--captured']);
  assert.notEqual(r.status, 0, r.text);
  assert.match(r.err, /no captured user prompt since question 1 was asked/);
  assert.ok(!existsSync(`${d}/.agents/runs/LC/questions/001.answer.md`));
});

test('answer: a message handed over by the hook counts only with its own capture on disk (same session, not ahead of the clock, same hash)', () => {
  const d = project('plain'); ask(d, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  const t = now();
  const stored = say(d, 'accept AS-1', t);
  /** @param {object} cap @param {string} [session] */
  const through = (cap, session = 's1') => {
    /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
    const io = { env: cleanEnv({}), cwd: d, scriptPath: `${d}/.agents/scripts/proofline-core.mjs`, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, promptCapture: { session, time: t, sha256: stored.sha256, text: 'accept AS-1', ...cap } };
    const status = runCore(['answer', 'LC', '1', '--captured'], /** @type {any} */ (io));
    return { status, text: Buffer.concat([...out, ...err]).toString() };
  };
  const wrongHash = through({ sha256: '1'.repeat(64) });
  assert.notEqual(wrongHash.status, 0); assert.match(wrongHash.text, /not on disk as the hook wrote it/);
  const foreign = through({}, 'other');
  assert.notEqual(foreign.status, 0);
  writeFileSync(`${d}/.agents/local/prompts/s1.json`, readFileSync(`${d}/.agents/local/prompts/s1.json`, 'utf8').replace('"session":"s1"', '"session":"evil"'));
  const wrongSession = through({});
  assert.notEqual(wrongSession.status, 0); assert.match(wrongSession.text, /not on disk as the hook wrote it/);
  storePrompt(`${d}/.agents/local`, 's1', t, 'accept AS-1');
  const chatter = through({ text: 'what is the status?', sha256: say(d, 'what is the status?', t).sha256 });
  assert.notEqual(chatter.status, 0); assert.match(chatter.text, /not an acceptance of the assumption/);
  storePrompt(`${d}/.agents/local`, 's1', t, 'accept AS-1');
  const good = through({});
  assert.equal(good.status, 0, good.text);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: user$/m);
});

test('the A171 override: "proceed without splitting" captured from the user lets the freeze through; the lead\'s own words do not', () => {
  const d = project('split');
  const stuck = freeze(d);
  assert.notEqual(stuck.status, 0); assert.match(stuck.err, /at least 2 tasks of at most 3 paths each/);
  assert.equal(agent(d, ['answer', 'LC', '1'], 'proceed without splitting\n').status, 0);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: lead$/m);
  assert.match(freeze(d).err, /pipeline allows at most 3/);
  const q = readdirSync(`${d}/.agents/runs/LC/questions`).filter((n) => /^\d{3}\.md$/.test(n)).sort().pop() ?? '';
  const n = String(Number(q.slice(0, 3)));
  say(d, 'Proceed without splitting');
  const r = agent(d, ['answer', 'LC', n, '--captured']);
  assert.equal(r.status, 0, r.text);
  const f = freeze(d);
  assert.equal(f.status, 0, f.text);
  assert.match(read(d, 'LEDGER.log'), /event=split_override .*scope_paths=4 max=3 class=STANDARD answer=questions\//);
});

/** Wait until the clock has reached second T. @param {number} t */
function waitUntil(t) { const c = new Int32Array(new SharedArrayBuffer(4)); while (now() < t) Atomics.wait(c, 0, 0, 25); }

test('next records an approval the hook missed from the newest capture; a future, foreign or non-approving capture records nothing', () => {
  const d = project('plain');
  assert.equal(agent(d, ['request-approval', 'LC', 'plan']).status, 0);
  const t0 = Number(/^requested_at: (\d+)/m.exec(read(d, 'approvals/001-request-plan.yaml'))?.[1]);
  const approvals = () => readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => /^\d{3}-plan\.yaml$/.test(n));
  waitUntil(t0 + 1);
  say(d, 'approve the plan', t0 + 100);
  assert.match(agent(d, ['next', 'LC']).text, /wait for the user's answer/);
  assert.deepEqual(approvals(), []);
  say(d, 'approve the plan', t0 + 1, 'evil');
  writeFileSync(`${d}/.agents/local/prompts/s1.json`, readFileSync(`${d}/.agents/local/prompts/evil.json`, 'utf8'));
  rmSync(`${d}/.agents/local/prompts/evil.json`);
  assert.match(agent(d, ['next', 'LC']).text, /wait for the user's answer/);
  assert.deepEqual(approvals(), []);
  say(d, 'approve the plan but wait', t0 + 1);
  assert.match(agent(d, ['next', 'LC']).text, /not an explicit approval/);
  assert.deepEqual(approvals(), []);
  say(d, 'approve the plan', t0 + 1);
  const r = agent(d, ['next', 'LC']);
  assert.match(r.text, /approval of plan was recorded just now/);
  assert.deepEqual(approvals(), ['002-plan.yaml']);
  assert.match(read(d, 'approvals/002-plan.yaml'), /^source: "prompt_capture"$/m);
  assert.match(readFileSync(`${d}/.agents/local/approve.log`, 'utf8'), /retry output: approval recorded: LC plan/);
});

test('batch pre-flight: the user\'s answers are recorded by batch-answer and applied at freeze to the task the batch starts', () => {
  const stuck = project('split');
  assert.notEqual(freeze(stuck).status, 0);
  const d = project('split');
  mkdirSync(`${d}/.agents/local/batch`, { recursive: true });
  writeFileSync(`${d}/.agents/local/batch/SUMMARY.md`, '# Night batch\n\nQ1 [LC, split] 4 code paths against a limit of 3: a) split b) proceed without splitting\n');
  writeFileSync(`${d}/.agents/local/batch/lint.tsv`, 'Q1\tLC\tsplit\tsplit it?\ta) b)\ta\t27\n');
  assert.equal(agent(d, ['request-approval', '-', 'batch']).status, 0);
  const t0 = Number(/^requested_at: (\d+)/m.exec(readFileSync(`${d}/.agents/local/approvals/001-request-batch.yaml`, 'utf8'))?.[1]);
  waitUntil(t0 + 1);
  say(d, 'approve batch', t0 + 1);
  const ap = agent(d, ['approve-pending', 'LC']);
  assert.match(ap.out, /approved: {2}batch/);
  say(d, 'Q1 b', now());
  const bo = agent(d, ['batch-answer']);
  assert.equal(bo.status, 0, bo.text);
  assert.match(agent(d, ['batch-answers', 'LC']).out, /Q1 LC split: option b \(up to 27\)/);
  const f = freeze(d);
  assert.equal(f.status, 0, f.text);
  assert.match(f.err, /freezing without splitting on the user's batch answer Q1 \(up to 27\)/);
  assert.match(read(d, 'LEDGER.log'), /event=split_override .*answer=batch:Q1/);
});
