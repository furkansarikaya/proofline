// @ts-check
// `agent.sh friction report|show|issue-cmd|send` and `agent.sh calibrate` (A229, the former scripts/friction.sh and friction-test.sh; tests/legacy-port-map.tsv names
// the rows): the anonymous report from a run's records with absolute counts, the scrub, one file per run, the approval before a send (gh is a shim on PATH and is
// never started without it), and the read-only calibration suggestions.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git, newProject } from './helper-lib.mjs';
import { A, accepted, refused, say } from './legacy-lib.mjs';
import { repo } from './helpers.mjs';

const FIX = path.join(repo, 'tests/fixtures/friction');
/** A project with the recorded run RUN-001 (a failed one: 6 questions, 1 approval request, 4 QA failures, 3 fix rounds). */
function withRun() {
  const d = newProject();
  mkdirSync(`${d}/.agents/runs/RUN-001`, { recursive: true });
  mkdirSync(`${d}/.agents/local/metrics`, { recursive: true });
  cpSync(`${FIX}/LEDGER.log`, `${d}/.agents/runs/RUN-001/LEDGER.log`);
  cpSync(`${FIX}/records.jsonl`, `${d}/.agents/local/metrics/records.jsonl`);
  return d;
}
const latest = (/** @type {string} */ d) => readFileSync(`${d}/.agents/local/friction/latest.md`, 'utf8');

const EXPECTED = `# proofline friction report

schema: proofline.friction.v1

outcome: failed
classification: COMPLEX

## User interruptions

- questions asked: 6 (answered by the user: 2, by an assumption: 4)
- approval requests: 1
- total times the user was asked: 7
- times the user was asked to run a command (a proofline bug): 0
- proofline failures the lead worked around (proofline_bug): 0

## Blocked and failed gates

- gate failures: 7
  - gate QA failed 4 times
  - gate REVIEW_RULES failed 1 times
  - gate VERIFY failed 2 times
- steps that returned blocked: 12
  - role implementer blocked 3 times
  - role qa blocked 3 times
  - role reviewer blocked 5 times
  - role security_reviewer blocked 1 times

## Timeouts

- runtime failovers: 1 (of them by timeout: 0)
- hook timeouts: 0 (of 0 recorded hook runs; total hook time 0 ms, slowest 0 ms)
- dispatch timeouts: 0 (of 3 dispatches)

## Repeated rounds

- fix rounds used: 3
- delegated steps: 39

## Cost

- run duration seconds: 15177
- tokens in: 2 (1 of 47 records)
- tokens out: 452 (1 of 47 records)
- tokens total: 52623 (1 of 47 records)
`;

test('report: the whole report of the recorded failed run, counts only, no run id and no path (the entries of a group are listed in name order)', () => {
  const d = withRun();
  const r = accepted(A(d, ['friction', 'report', 'RUN-001']), 'report');
  assert.equal(r.out, 'friction report: .agents/local/friction/latest.md and .agents/local/friction/RUN-001.md (review it; sending needs your approval)\n');
  assert.equal(latest(d), EXPECTED);
  assert.ok(!latest(d).includes('RUN-001'));
  assert.ok(!/[/@~\\]/.test(latest(d)));
  assert.equal(readFileSync(`${d}/.agents/local/friction/RUN-001.md`, 'utf8'), EXPECTED);
});

test('report: a run without a ledger and a bad id fail; a run cannot be called latest; only the lead reports', () => {
  const d = withRun();
  let r = A(d, ['friction', 'report', 'NOPE']);
  assert.equal(r.status, 1); assert.equal(r.err, 'friction: no ledger for the run\n');
  r = A(d, ['friction', 'report', 'a/b']);
  assert.equal(r.status, 2); assert.match(r.err, /usage: agent\.sh friction report <ID>/);
  assert.equal(A(d, ['friction', 'report']).status, 2);
  mkdirSync(`${d}/.agents/runs/latest`); cpSync(`${FIX}/LEDGER.log`, `${d}/.agents/runs/latest/LEDGER.log`);
  refused(A(d, ['friction', 'report', 'latest']), 'a run called latest', 'friction: a run cannot be called latest');
  assert.ok(!existsSync(`${d}/.agents/local/friction/latest.md`));
  refused(A(d, ['friction', 'report', 'RUN-001'], { role: 'reviewer' }), 'a reviewer reported', 'command denied for reviewer');
});

test('report: hook runs and hook timeouts of the ledger, and of HOOKS.log (A203), are counted; friction notes are counted by kind', () => {
  const d = withRun();
  const led = `${d}/.agents/runs/RUN-001/LEDGER.log`;
  const keep = readFileSync(led, 'utf8');
  writeFileSync(led, `${keep}seq=900 prev=x event=hook role=lead from=- to=- digest=d ts=t epoch=1 detail=name=prompt runs=4 total_ms=2400 max_ms=900\nseq=901 prev=x event=hook role=lead from=- to=- digest=d ts=t epoch=1 detail=name=pretool runs=10 total_ms=300 max_ms=60\nseq=902 prev=x event=hook-timeout role=lead from=- to=- digest=d ts=t epoch=1 detail=name=stop ms=900 note=slow\n`);
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'ledger hooks');
  assert.match(latest(d), /^- hook timeouts: 1 \(of 14 recorded hook runs; total hook time 2700 ms, slowest 900 ms\)$/m);
  writeFileSync(led, keep);
  writeFileSync(`${d}/.agents/runs/RUN-001/HOOKS.log`, 'ts=t epoch=1 event=hook role=lead detail=name=prompt runs=4 total_ms=2400 max_ms=900\nts=t epoch=1 event=hook-timeout role=lead detail=name=stop ms=900 note=slow\n');
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'HOOKS.log');
  assert.match(latest(d), /^- hook timeouts: 1 \(of 4 recorded hook runs; total hook time 2400 ms, slowest 900 ms\)$/m);
  rmSync(`${d}/.agents/runs/RUN-001/HOOKS.log`);
  writeFileSync(led, `${keep}seq=9999 prev=x event=friction-note role=lead from=IMPLEMENTING to=IMPLEMENTING digest=x ts=2026-01-01T00:00:00Z epoch=1 detail=user-command\n`);
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'a user-command note');
  assert.match(latest(d), /asked to run a command \(a proofline bug\): 1$/m);
  assert.match(latest(d), /^ {2}- user-command: 1 times$/m);
  writeFileSync(led, `${keep}seq=9998 prev=x event=friction-note role=lead from=IMPLEMENTING to=IMPLEMENTING digest=x ts=2026-01-01T00:00:00Z epoch=1 detail=proofline_bug\n`);
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'a proofline_bug note');
  assert.match(latest(d), /worked around \(proofline_bug\): 1$/m);
  assert.match(latest(d), /asked to run a command \(a proofline bug\): 0$/m);
});

test('report: one file per run (A203); show prints the latest or the run asked for; an unknown report is a failure', () => {
  const d = withRun();
  mkdirSync(`${d}/.agents/runs/RUN-002`); cpSync(`${FIX}/LEDGER.log`, `${d}/.agents/runs/RUN-002/LEDGER.log`);
  assert.equal(refused(A(d, ['friction', 'show']), 'no report yet', 'friction: no report yet'), undefined);
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'one'); accepted(A(d, ['friction', 'report', 'RUN-002']), 'two');
  assert.deepEqual(readdirSync(`${d}/.agents/local/friction`).sort(), ['RUN-001.md', 'RUN-002.md', 'latest.md']);
  // latest.md is the newest report (RUN-002 has no metrics records)
  assert.equal(A(d, ['friction', 'show']).out, readFileSync(`${d}/.agents/local/friction/RUN-002.md`, 'utf8'));
  assert.equal(A(d, ['friction', 'show', 'latest']).out, readFileSync(`${d}/.agents/local/friction/RUN-002.md`, 'utf8'));
  assert.match(A(d, ['friction', 'show']).out, /^- tokens total: unknown$/m);
  assert.equal(A(d, ['friction', 'show', 'RUN-001']).out, EXPECTED);
  assert.equal(A(d, ['friction', 'show', 'RUN-009']).status, 1);
  assert.equal(A(d, ['friction', 'show', 'a/b']).status, 2);
});

test('report: metrics off gives unknown tokens and no dispatch counts; the scrub refuses a report that mentions the git user or the project directory', () => {
  const d = withRun();
  writeFileSync(`${d}/.agents/config.yaml`, readFileSync(`${d}/.agents/config.yaml`, 'utf8').replace(/^metrics: on$/m, 'metrics: off'));
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'metrics off');
  assert.match(latest(d), /^- tokens total: unknown$/m);
  assert.match(latest(d), /^- dispatch timeouts: 0 \(of 0 dispatches\)$/m);
  rmSync(`${d}/.agents/local/friction`, { recursive: true });
  git(d, ['config', 'user.name', 'blocked']);   // a word the report text contains
  const r = A(d, ['friction', 'report', 'RUN-001']);
  assert.equal(r.status, 1);
  assert.equal(r.err, 'friction: the report mentions the project directory, the git identity or the user name; not written\n');
  assert.ok(!existsSync(`${d}/.agents/local/friction/latest.md`));
  git(d, ['config', '--unset', 'user.name']);
});

test('report: a character outside the allowed set (a path, an address) refuses the report and names the line', () => {
  const d = withRun();
  const led = `${d}/.agents/runs/RUN-001/LEDGER.log`;
  writeFileSync(led, `${readFileSync(led, 'utf8')}seq=9997 prev=x event=classify role=lead from=- to=- digest=x ts=t epoch=1 detail=a/b\n`);
  const r = A(d, ['friction', 'report', 'RUN-001']);
  assert.equal(r.status, 0, 'the classification word is cleaned to letters, digits and _.+:-, so nothing unsafe reaches the report');
  assert.match(latest(d), /^classification: ab$/m);
});

/** A `gh` on PATH that records its arguments and the working directory. */
function ghShim() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fr-gh-'));
  writeFileSync(`${dir}/gh`, `#!/bin/sh\nprintf '%s|' "$@" > "${dir}/args"; pwd > "${dir}/cwd"; echo created\n`);
  chmodSync(`${dir}/gh`, 0o755);
  return { dir, env: { PATH: `${dir}:${process.env.PATH}` } };
}

test('issue-cmd prints the one command a send would run and starts nothing', () => {
  const d = withRun();
  refused(A(d, ['friction', 'issue-cmd']), 'no report yet', 'friction: no report yet');
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'report');
  assert.equal(A(d, ['friction', 'issue-cmd']).out, 'gh issue create --repo furkansarikaya/proofline --title "proofline friction report" --body-file .agents/local/friction/latest.md\n');
});

test('send: nothing without the user\'s approval (gh is never started); the approval is bound to the report hash and single use; only the lead sends', () => {
  const d = withRun();
  const gh = ghShim();
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'report');
  let r = A(d, ['friction', 'send'], { env: gh.env });
  assert.equal(r.status, 1);
  assert.match(r.err, /friction: nothing sent\. Ask the user: agent\.sh request-approval - report \(relay it verbatim\)/);
  assert.ok(!existsSync(`${gh.dir}/args`), 'gh was started without an approval');
  refused(A(d, ['friction', 'send'], { role: 'reviewer', env: gh.env }), 'a reviewer sent', 'command denied for reviewer');
  accepted(A(d, ['request-approval', '-', 'report']), 'request');
  say(d, 'approve the friction report');
  accepted(A(d, ['approve', '-', 'report']), 'approve');
  r = A(d, ['friction', 'send'], { env: gh.env });
  assert.equal(r.status, 0, r.text);
  assert.equal(r.out, 'created\n');
  assert.equal(readFileSync(`${gh.dir}/args`, 'utf8'), 'issue|create|--repo|furkansarikaya/proofline|--title|proofline friction report|--body-file|.agents/local/friction/latest.md|');
  assert.equal(readFileSync(`${gh.dir}/cwd`, 'utf8').trim(), readFileSync(`${gh.dir}/cwd`, 'utf8').trim());
  rmSync(`${gh.dir}/args`);
  r = A(d, ['friction', 'send'], { env: gh.env });
  assert.equal(r.status, 1, 'the approval is single use');
  assert.ok(!existsSync(`${gh.dir}/args`));
  // an edited report is not covered by the approval
  accepted(A(d, ['request-approval', '-', 'report']), 'request 2');
  say(d, 'approve the friction report');
  accepted(A(d, ['approve', '-', 'report']), 'approve 2');
  writeFileSync(`${d}/.agents/local/friction/latest.md`, `${latest(d)}changed\n`);
  r = A(d, ['friction', 'send'], { env: gh.env });
  assert.equal(r.status, 1);
  assert.ok(!existsSync(`${gh.dir}/args`));
});

test('send: no environment value picks the program that runs after an approval (the former PROOFLINE_TEST seam is gone)', () => {
  const d = withRun();
  const gh = ghShim();
  accepted(A(d, ['friction', 'report', 'RUN-001']), 'report');
  accepted(A(d, ['request-approval', '-', 'report']), 'request');
  say(d, 'approve the friction report');
  accepted(A(d, ['approve', '-', 'report']), 'approve');
  const r = A(d, ['friction', 'send'], { env: { ...gh.env, PROOFLINE_TEST: '1', PROOFLINE_GH: 'false' } });
  assert.equal(r.status, 0, r.text);
  assert.ok(existsSync(`${gh.dir}/args`), 'gh from PATH ran, not PROOFLINE_GH');
});

test('an unknown operation prints the usage and exits 2', () => {
  const d = withRun();
  const r = A(d, ['friction', 'bogus']);
  assert.equal(r.status, 2);
  assert.equal(r.err, 'usage: agent.sh friction <report ID|show [ID]|issue-cmd|send>\n');
});

// ---- calibrate ----------------------------------------------------------------------------------------------------------------------

test('calibrate: a budget below the criteria count and a slow dispatch give suggestions; the config is untouched', () => {
  const d = withRun();
  writeFileSync(`${d}/.agents/runs/RUN-001/PLAN.md`, `## Tests\n${Array.from({ length: 25 }, (_, i) => `- AC-${i + 1}: x\n`).join('')}`);
  const cfg = `${d}/.agents/config.yaml`;
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^ {2}timeout_seconds: 5400$/m, '  timeout_seconds: 1800'));
  const before = readFileSync(cfg, 'utf8');
  const r = accepted(A(d, ['calibrate']), 'calibrate');
  assert.equal(r.out, [
    'calibration suggestions (read-only; nothing was changed, edit .agents/config.yaml yourself if you agree)',
    'seen: 2 plans, most criteria in one plan: 25; test_trust.mutation_budget: 20',
    'suggest: test_trust.mutation_budget 25 (a plan names 25 criteria, one mutant each is the minimum; today that costs an approval per run)',
    'suggest: dispatch.timeout_seconds 3600 (slowest dispatch 1558s of 1800s, timeouts 0); or one multiplier for every limit: proofline doctor --scale',
    '',
  ].join('\n'));
  assert.equal(readFileSync(cfg, 'utf8'), before);
});

test('calibrate: no metrics records skips the timeout and fix-round checks; nothing to suggest says so; a budget more than twice the largest plan is lowered', () => {
  const d = newProject();
  let r = accepted(A(d, ['calibrate']), 'no metrics');
  assert.match(r.out, /^no metrics recorded: timeout and fix-round checks skipped$/m);
  assert.match(r.out, /^no change suggested$/m);
  assert.match(r.out, /^seen: 1 plans, most criteria in one plan: 0; test_trust\.mutation_budget: 20$/m);
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, `## Tests\n${Array.from({ length: 4 }, (_, i) => `- AC-${i + 1}: x\n`).join('')}`);
  r = accepted(A(d, ['calibrate']), 'a lower budget');
  assert.match(r.out, /^suggest: test_trust\.mutation_budget 6 \(the budget is more than twice the largest plan; a lower budget shortens the mutation step\)$/m);
  writeFileSync(`${d}/.agents/runs/LC/PLAN.md`, `## Tests\n${Array.from({ length: 12 }, (_, i) => `- AC-${i + 1}: x\n`).join('')}`);
  r = accepted(A(d, ['calibrate']), 'balanced');
  assert.match(r.out, /^no change suggested$/m);
});
