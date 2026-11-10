// @ts-check
// Self-test (A128): the harness reply loop of run.mjs against a stub `claude` that leaves an unanswered approval request in the run's approvals/
// directory after every call. No real runtime is called. One test per scenario (E2E_RUNNER runs the same assertions against another runner).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { here, repo, runE2e } from './runner.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'e2e-loop-'));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = path.join(root, 'bin');
mkdirSync(bin);
const stub = path.join(bin, 'claude');
const PATHENV = `${bin}${path.delimiter}${process.env.PATH}`;
const SH_HEAD = '#!/bin/sh\n';

/** Stub lead: one more unanswered request of $STUB_SLUG in runs/none/approvals, a result line, no question mark. */
const stubApprovals = () => {
  writeFileSync(stub, `${SH_HEAD}# Stub lead: one more unanswered request of $STUB_SLUG in runs/none/approvals, a result line, no question mark.
d=.agents/runs/none/approvals; mkdir -p "$d"
n=$(ls "$d" | wc -l); n=$(printf '%03d' $((n + 1)))
: > "$d/$n-request-$STUB_SLUG.yaml"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}' '{"type":"result","result":"Reply approve to continue."}'
`);
  chmodSync(stub, 0o755);
};
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
/** @param {string} scenario @param {string} slug @param {number} max @param {string} sub */
function run(scenario, slug, max, sub) {
  const r = path.join(root, sub);
  rmSync(r, { recursive: true, force: true });
  const res = runE2e([scenario, 'claude'], { STUB_SLUG: slug, E2E_MAX_REPLIES: String(max), E2E_ROOT: r, PATH: PATHENV });
  assert.equal(res.status, 0, `run failed: ${res.out}`);
  return readFileSync(path.join(findOut(r), 'summary.txt'), 'utf8');
}

test('plan: a plan request pending until the cap is answered, then stopped=max-replies', () => {
  stubApprovals();
  const s = run('COMPLEX', 'plan', 2, 'plan');
  assert.match(s, /^plan_approval_replies=2$/m, `plan replies: ${s}`);
  assert.match(s, /^stopped=max-replies$/m, `cap not reported: ${s}`);
});

for (const sc of ['destructive', 'single_step', 'scope', 'budget', 'commit', 'push', 'waive-F-1']) {
  test(`${sc}: a ${sc} request is never answered`, () => {
    stubApprovals();
    const s = run('COMPLEX', sc, 6, sc);
    assert.match(s, /^replies=0$/m, `${sc} request was answered: ${s}`);
    assert.doesNotMatch(s, /^stopped=/m, `${sc}: ${s}`);
  });
}

test('question-file: the question reply is chosen per scenario (CRITICAL file, others generic) and holds no approval phrase', () => {
  writeFileSync(stub, `${SH_HEAD}printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}' '{"type":"result","result":"Which option do you prefer?"}'\n`);
  chmodSync(stub, 0o755);
  // A131: the question reply comes from replies/question.<SCENARIO>.txt when it exists, else line 1 of the generic file; no approval phrase of the
  // shared allowlist (the approval allowlist, tests/golden/approvals/grammar.json) may be in it.
  const phrases = JSON.parse(readFileSync(path.join(repo, 'tests/golden/approvals/grammar.json'), 'utf8')).phrases.split('\n').filter(Boolean).join(',');   // the allowlist the shell function approval_phrases printed (A244)
  assert.ok(phrases, 'approval phrases not found in the recorded grammar');
  for (const scn of ['CRITICAL', 'COMPLEX']) {
    const r = path.join(root, `q-${scn}`);
    const res = runE2e([scn, 'claude'], { E2E_MAX_REPLIES: '1', E2E_ROOT: r, PATH: PATHENV });
    assert.equal(res.status, 0, `run failed: ${res.out}`);
    const out = findOut(r);
    let want = path.join(here, 'replies', `${scn}.txt`);
    if (existsSync(path.join(here, 'replies', `question.${scn}.txt`))) want = path.join(here, 'replies', `question.${scn}.txt`);
    const sent = (/^reply=1 .* \| (.*)$/m.exec(readFileSync(path.join(out, 'replies-log.txt'), 'utf8')) ?? [])[1];
    assert.equal(sent, readFileSync(want, 'utf8').split('\n')[0], `${scn} sent '${sent}', want line 1 of ${want}`);
    if (scn === 'CRITICAL') assert.equal(want, path.join(here, 'replies', 'question.CRITICAL.txt'), 'CRITICAL file not used');
    else assert.equal(want, path.join(here, 'replies', `${scn}.txt`), `${scn} did not use the generic file`);
  }
  const reply = readFileSync(path.join(here, 'replies', 'question.CRITICAL.txt'), 'utf8').replace(/\n+$/, '');
  assert.ok(!reply.includes('?'), 'question reply holds a question mark');
  const norm = ` ${reply.toLowerCase().replace(/[^a-z0-9_-]/g, ' ').replace(/ +/g, ' ')} `;
  for (const raw of phrases.split(',')) {
    const ph = raw.toLowerCase().trim();
    if (ph === '') continue;
    assert.ok(!norm.includes(` ${ph} `), `question.CRITICAL.txt holds the approval phrase '${ph}'`);
  }
});
