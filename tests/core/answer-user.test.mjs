// @ts-check
// The user's answers (issue #187, A171, A210): only the prompt hook records them as the user's, in process, from the message it is handling (an assumption
// acceptance, a split override or another user-only question with an accepted answer form); the batch pre-flight answers are applied at freeze. What stays
// refused: a file as the source (planted history or capture), typed text (always the lead's), another session's capture, a message that matches no accepted
// form, and `next` recording an approval.
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
  const r = spawnSync('sh', ['-c', `. "$EQ_LIB"; ${script}; cp -R "$PWD/." "$EQ_OUT/"`, path.join(scripts, 'x.sh')],
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

/**
 * `answer` the way the prompt hook runs it: in process, with the message it is handling handed over (the only way the user's words are recorded).
 * @param {string} d @param {string[]} args @param {{ text?: string, time?: number, session?: string, sha256?: string, store?: boolean, storedAs?: string }} [m]
 */
function hookAnswer(d, args, m = {}) {
  const text = m.text ?? 'x'; const time = m.time ?? now(); const session = m.session ?? 's1';
  const stored = m.store === false ? { sha256: createHash('sha256').update(text).digest('hex') } : say(d, text, time, m.storedAs ?? session);
  /** @type {Buffer[]} */ const out = []; /** @type {Buffer[]} */ const err = [];
  const io = { env: cleanEnv({}), cwd: d, scriptPath: `${d}/.agents/scripts/proofline-core.mjs`, stdout: { write: (/** @type {Buffer} */ b) => out.push(b) }, stderr: { write: (/** @type {Buffer} */ b) => err.push(b) }, promptCapture: { session, time, sha256: m.sha256 ?? stored.sha256, text } };
  const status = runCore(args, /** @type {any} */ (io));
  return { status, text: Buffer.concat([...out, ...err]).toString() };
}
const SPLITQ = '1. Split the task?\n   SPLIT: 4\n   options: "split" (task-author splits) | "proceed without splitting" (recorded as the user\'s override)\n   recommended: split\n';

test('answer --captured without the hook\'s hand-over is refused: a planted history file or capture is never the user\'s answer (H1)', () => {
  const d = project('plain'); ask(d, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  const t = now() + 1;
  // a history copy planted the way tar -C / unzip -d / curl -o would write it, with a name that carries its own hash
  const text = 'accept AS-1\n';
  const planted = `${d}/.agents/local/prompts/history/${t}-${createHash('sha256').update(text).digest('hex').slice(0, 8)}.txt`;
  mkdirSync(path.dirname(planted), { recursive: true }); writeFileSync(planted, text);
  const r = agent(d, ['answer', 'LC', '1', '--captured']);
  assert.notEqual(r.status, 0, r.text); assert.match(r.err, /cannot be recorded as the user's from a file/);
  // a capture planted by the model (a real capture file of the same session)
  say(d, 'accept AS-1', t);
  const r2 = agent(d, ['answer', 'LC', '1', '--captured']);
  assert.notEqual(r2.status, 0, r2.text);
  const r3 = agent(d, ['answer', 'LC', '1', '--amend']);
  assert.notEqual(r3.status, 0, r3.text);
  assert.ok(!existsSync(`${d}/.agents/runs/LC/questions/001.answer.md`));
  // the lead's typed text is still recorded, as the lead's
  assert.equal(agent(d, ['answer', 'LC', '1'], 'accept AS-1\n').status, 0);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: lead$/m);
});

test('the hook records the acceptance of an assumption exactly as "accept <id>", nothing hedged', () => {
  const d = project('plain');
  ask(d, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  const hedged = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'accept AS-1 unless the reviewer objects', time: now() + 1 });
  assert.notEqual(hedged.status, 0); assert.match(hedged.text, /not an acceptance of the assumption/);
  assert.ok(!existsSync(`${d}/.agents/runs/LC/questions/001.answer.md`));
  const e = project('plain');
  ask(e, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  const ok = hookAnswer(e, ['answer', 'LC', '1', '--captured'], { text: 'Accept AS-1', time: now() + 1 });
  assert.equal(ok.status, 0, ok.text);
  assert.match(read(e, 'questions/001.answer.md'), /^answered_by: user\n[^]*---\naccept AS-1\n$/);
});

test('answer: a message handed over by the hook counts only with its own capture on disk (same session, same hash), strictly newer than the question', () => {
  const d = project('plain'); ask(d, `${Q}   ASSUMPTION: AS-1@abc123def456\n`);
  const t = now() + 1;
  const wrongHash = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'accept AS-1', time: t, sha256: '1'.repeat(64) });
  assert.notEqual(wrongHash.status, 0); assert.match(wrongHash.text, /not on disk as the hook wrote it/);
  // another session's capture on disk, handed over as this session's
  const foreign = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'accept AS-1', time: t, session: 'other', storedAs: 's1' });
  assert.notEqual(foreign.status, 0);
  writeFileSync(`${d}/.agents/local/prompts/s1.json`, readFileSync(`${d}/.agents/local/prompts/s1.json`, 'utf8').replace('"session":"s1"', '"session":"evil"'));
  const swapped = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'accept AS-1', time: t, store: false });
  assert.notEqual(swapped.status, 0); assert.match(swapped.text, /not on disk as the hook wrote it/);
  // a message of the second the question was asked in is not its answer
  const asked = Number(/^asked_at: (\d+)/m.exec(read(d, 'questions/001.md'))?.[1] ?? '0');
  const same = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'accept AS-1', time: asked });
  assert.notEqual(same.status, 0); assert.match(same.text, /not newer than question 1/);
  const chatter = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'what is the status?', time: t });
  assert.notEqual(chatter.status, 0); assert.match(chatter.text, /not an acceptance of the assumption/);
  const good = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'accept AS-1', time: t });
  assert.equal(good.status, 0, good.text);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: user$/m);
});

test('the A171 override: "proceed without splitting" handed over by the hook lets the freeze through; the lead\'s own words and a message that matches no accepted form do not', () => {
  const d = project('split');
  const stuck = freeze(d);
  assert.notEqual(stuck.status, 0); assert.match(stuck.err, /at least 2 tasks of at most 3 paths each/);
  assert.equal(agent(d, ['answer', 'LC', '1'], 'proceed without splitting\n').status, 0);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: lead$/m);
  assert.match(freeze(d).err, /pipeline allows at most 3/);
  const q = readdirSync(`${d}/.agents/runs/LC/questions`).filter((n) => /^\d{3}\.md$/.test(n)).sort().pop() ?? '';
  const n = String(Number(q.slice(0, 3)));
  const t = now() + 1;
  for (const bad of ['yes, go ahead', 'proceed without splitting unless the reviewer objects', 'split or proceed without splitting', 'please do not proceed without splitting']) {
    const r = hookAnswer(d, ['answer', 'LC', n, '--captured'], { text: bad, time: t });
    assert.notEqual(r.status, 0, bad); assert.match(r.text, /not one of the accepted answers/);
  }
  assert.ok(!existsSync(`${d}/.agents/runs/LC/questions/${q.slice(0, 3)}.answer.md`));
  const r = hookAnswer(d, ['answer', 'LC', n, '--captured'], { text: 'Proceed without splitting', time: t });
  assert.equal(r.status, 0, r.text);
  const f = freeze(d);
  assert.equal(f.status, 0, f.text);
  assert.match(read(d, 'LEDGER.log'), /event=split_override .*scope_paths=4 max=3 class=STANDARD answer=questions\//);
});

test('a user-only question is recorded by the hook only when it is the single open one, and a plain question never is', () => {
  const d = project('plain'); ask(d, SPLITQ); ask(d, SPLITQ.replace('SPLIT: 4', 'USER_ONLY: scope'));
  const two = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'proceed without splitting', time: now() + 1 });
  assert.notEqual(two.status, 0); assert.match(two.text, /not the only open user-only question/);
  const e = project('plain'); ask(e);
  const plain = hookAnswer(e, ['answer', 'LC', '1', '--captured'], { text: 'a', time: now() + 1 });
  assert.notEqual(plain.status, 0); assert.match(plain.text, /not a question the user answers through the prompt hook/);
});

/** The supervised freeze needs the plan approved first: request, the user's reply through the hook-side `approve-pending`. @param {string} d */
function planApproved(d) {
  assert.equal(agent(d, ['request-approval', 'LC', 'plan']).status, 0);
  const t0 = Number(/^requested_at: (\d+)/m.exec(read(d, 'approvals/001-request-plan.yaml'))?.[1]);
  waitUntil(t0 + 1);
  say(d, 'approve the plan', t0 + 1);
  assert.equal(agent(d, ['approve-pending', 'LC']).status, 0);
}

test('an INTENT scope decision: the user\'s answer to its USER_ONLY question is recorded by the hook and is the provenance at freeze; typed or non-matching words are not', () => {
  const d = project('plain');
  mkdirSync(`${d}/.agents/runs/LC/design`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/LC/design/INTENT.md`, '# Intent\n\n## Decision tree\n\n| id | branch | question | depends | status | decision | source |\n|---|---|---|---|---|---|---|\n| D-1 | scope | fix the old defect? | - | resolved | report it, out of scope | round 1 |\n\n## Rounds\n\n| round | decision | answer | by |\n|---|---|---|---|\n| 1 | D-1 | report it, out of scope | user |\n');
  say(d, 'some unrelated earlier message');
  ask(d, '1. Fix the old defect in this change?\n   USER_ONLY: scope D-1\n   options: "report it, out of scope" | "fix it in this change"\n   recommended: report it, out of scope\n');
  planApproved(d);
  const stuck = freeze(d);
  assert.match(stuck.err, /INTENT\.md records the user's answer to scope decision\(s\) D-1/);
  // typed by the lead: the lead's answer is no provenance
  const lead = project('plain');
  planApproved(lead);
  cpSync(`${d}/.agents/runs/LC/design`, `${lead}/.agents/runs/LC/design`, { recursive: true });
  mkdirSync(`${lead}/.agents/local/prompts/history`, { recursive: true }); say(lead, 'some unrelated earlier message', now() + 1);
  ask(lead, '1. Fix the old defect in this change?\n   USER_ONLY: scope D-1\n   options: "report it, out of scope" | "fix it in this change"\n');
  assert.equal(agent(lead, ['answer', 'LC', '1'], 'report it, out of scope\n').status, 0);
  assert.match(freeze(lead).err, /INTENT\.md records the user's answer to scope decision\(s\) D-1/);
  // a message that is no accepted form records nothing
  const t = now() + 1;
  const no = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'hmm, maybe report it out of scope or not', time: t });
  assert.notEqual(no.status, 0); assert.match(no.text, /not one of the accepted answers/);
  const yes = hookAnswer(d, ['answer', 'LC', '1', '--captured'], { text: 'Report it, out of scope', time: t });
  assert.equal(yes.status, 0, yes.text);
  assert.match(read(d, 'questions/001.answer.md'), /^answered_by: user$/m);
  assert.doesNotMatch(freeze(d).err, /INTENT\.md records the user's answer/);
});

/** Wait until the clock has reached second T. @param {number} t */
function waitUntil(t) { const c = new Int32Array(new SharedArrayBuffer(4)); while (now() < t) Atomics.wait(c, 0, 0, 25); }

test('next records no approval from a file: a missed approval is reported and the lead asks the user again (H2)', () => {
  const d = project('plain');
  assert.equal(agent(d, ['request-approval', 'LC', 'plan']).status, 0);
  const t0 = Number(/^requested_at: (\d+)/m.exec(read(d, 'approvals/001-request-plan.yaml'))?.[1]);
  const approvals = () => readdirSync(`${d}/.agents/runs/LC/approvals`).filter((n) => /^\d{3}-plan\.yaml$/.test(n));
  waitUntil(t0 + 1);
  say(d, 'approve the plan', t0 + 100);
  assert.match(agent(d, ['next', 'LC']).text, /wait for the user's answer/);
  say(d, 'approve the plan but wait', t0 + 1);
  assert.match(agent(d, ['next', 'LC']).text, /not an explicit approval/);
  assert.deepEqual(approvals(), []);
  say(d, 'approve the plan', t0 + 1);
  const r = agent(d, ['next', 'LC']);
  assert.match(r.text, /ask the user to send the approval again/);
  assert.deepEqual(approvals(), []);
  assert.ok(!existsSync(`${d}/.agents/local/approve.log`));
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
