// @ts-check
// U8 deferred part (A370.1, A378): `proofline retro` also reads `.agents/local/approve.log` and `.agents/local/status-block.log` (counts only), the approval sources of the ledger, and the minutes per
// gate from the agent records that name the gate (`gate`, `focus` of records.jsonl). Every number below is worked out from the planted rows; a hostile log line never reaches the report.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const T0 = 1760349600;
const H = '0'.repeat(64);
const iso = (/** @type {number} */ t) => new Date((T0 + t) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
/** @param {string} dir @param {string} file @param {string} text */
function put(dir, file, text) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); }
/** @param {Array<[number, string, string]>} rows */
const ledger = (rows) => rows.map(([t, ev, detail], i) => `seq=${i + 1} prev=${H} event=${ev} role=lead from=- to=- digest=${H} ts=${iso(t)} epoch=${T0 + t} detail=${detail}\n`).join('');
/** @param {string} kind @param {string} task @param {string} role @param {object} extra */
const rec = (kind, task, role, extra = {}) => JSON.stringify({ schema: 'proofline.metrics/1', kind, time: '2026-10-13T10:00:00Z', task, role, focus: null, gate: null, runtime: 'claude', model: null, duration_s: null, tokens_total: null, result: null, ...extra });
const TOK = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** @param {string} name */
function project(name) {
  const d = sb.mkrepo(name);
  put(d, '.agents/config.yaml', 'proofline_version: 0.0.192\n');
  put(d, '.agents/scripts/agent.sh', '#!/bin/sh\nexit 0\n');
  put(d, '.agents/runs/TASK-A/LEDGER.log', ledger([
    [0, 'start', 'x'], [60, 'approval-request', 'plan bound=x'], [120, 'approval', `approvals/001-plan.yaml@${H} plan source=prompt_capture answered_by=user bound=x`],
    [130, 'approval-request', 'commit bound=y'], [140, 'approval', `approvals/002-commit.yaml@${H} commit source=tty answered_by=user bound=y`],
    [600, 'handoff:IMPLEMENTED', 'x'], [700, 'gate:REVIEW_RULES:pass', 'x'], [710, 'gate:SECURITY:pass', 'x'], [720, 'gate:QA:pass', 'x'], [900, 'handoff:DONE', 'x'],
  ]));
  put(d, '.agents/local/metrics/records.jsonl', `${[
    rec('step', 'TASK-A', 'reviewer', { focus: 'rules', gate: 'REVIEW_RULES', duration_s: 120 }),
    rec('dispatch', 'TASK-A', 'reviewer', { focus: 'rules', gate: 'REVIEW_RULES', duration_s: 999, result: 'submitted' }),
    rec('step', 'TASK-A', 'reviewer', { focus: 'contract', gate: 'REVIEW_RULES', duration_s: 60 }),
    rec('dispatch', 'TASK-A', 'security_reviewer', { gate: 'SECURITY', duration_s: 300, result: 'submitted' }),
    rec('dispatch', 'TASK-A', 'security_reviewer', { gate: 'SECURITY', duration_s: 30, result: 'resumed' }),
    rec('step', 'TASK-A', 'implementer', { duration_s: 500 }),
    rec('step', 'TASK-A', 'qa', { gate: 'QA' }),
  ].join('\n')}\n`);
  return d;
}

const APPROVE_LOG = [
  `${iso(120)} target=TASK-A kinds=plan rc=0 output: approval recorded: TASK-A plan (prompt_capture)`,
  `${iso(300)} target=TASK-A kinds=commit push rc=1 output: approval refused: the user's words contain no approval phrase`,
  `${iso(400)} approval step of worktree run TASK-A stopped after 20s (prompt hook budget)`,
  `${iso(410)} approval step stopped after 20s (prompt hook budget)`,
  `${iso(420)} multi: 1 of 2 segments read as approvals, 1 approval record(s) written`,
  `${iso(500)} target=TASK-OTHER kinds=plan rc=0 output: approval recorded: TASK-OTHER plan (tty)`,
].join('\n');

/** Every file with size and mtime. @param {string} root */
function sig(root) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ dir) => { for (const n of readdirSync(dir).sort()) { if (n === '.git') continue; const p = path.join(dir, n); const s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${path.relative(root, p)} ${s.size} ${s.mtimeMs}`); } };
  walk(root);
  return out.join('\n');
}

test('approve.log and status-block.log are counted per run and in total; ledger approvals by source; nothing is written', () => {
  const d = project('logs');
  put(d, '.agents/local/approve.log', `${APPROVE_LOG}\n`);
  put(d, '.agents/local/status-block.log', `${iso(800)} TASK-A merged adapter failed: exit 1\n${iso(860)} TASK-A pr-opened timed out after 20s\n`);
  const before = sig(d);
  const r = sb.pl(d, ['retro', 'TASK-A', '--full']);
  assert.equal(r.status, 0, r.text);
  assert.equal(sig(d), before, 'the project must be unchanged');
  for (const want of [
    'approvals: commit requested 1, granted 1; plan requested 1, granted 1; granted by source: prompt_capture 1, tty 1 (answered by the user 2)',
    '  approve.log: 2 approval steps (1 recorded, 1 not recorded; kinds commit 1, plan 1, push 1; records by source prompt_capture 1), stopped by the hook budget 1, first to last 4.7 min',
    '  status-block.log: 2 failed updates (merged 1, pr-opened 1), first to last 1.0 min; updates sent: not recorded (only a failed update is logged)',
    'approve.log: 2 approval steps for these runs (1 recorded, 1 not recorded), stopped by the hook budget 2; lines that name no run: 1 stopped, 1 multi-segment reports',
    'status-block.log: 2 failed updates for these runs; updates sent: not recorded',
  ]) assert.ok(r.out.includes(want), `missing: ${want}\n${r.out}`);
  const j = JSON.parse(sb.pl(d, ['retro', 'TASK-A', '--json']).out);
  const a = j.tasks[0];
  assert.deepEqual(a.approval_sources, { prompt_capture: 1, tty: 1 });
  assert.deepEqual(a.approve_log, { steps: 2, recorded: 1, not_recorded: 1, kinds: { commit: 1, plan: 1, push: 1 }, records_by_source: { prompt_capture: 1 }, stopped_by_hook_budget: 1, span_s: 280 });
  assert.deepEqual(a.status_block_log, { failed: 2, events: { merged: 1, 'pr-opened': 1 }, span_s: 60, sent: 'not recorded' });
  assert.equal(j.logs.approve_lines, 6);
  assert.equal(j.logs.approve_steps, 2, 'the line of another run is not counted for TASK-A');
});

test('minutes per gate come from the agent records that name the gate (step before dispatch, resumed added, a risk focus apart); a gate without a timed record is not recorded', () => {
  const d = project('gates');
  const r = sb.pl(d, ['retro', 'TASK-A', '--full']);
  assert.ok(r.out.includes('  gate minutes (agent records): QA not recorded, REVIEW_RULES 2.0, REVIEW_RULES:contract 1.0, SECURITY 5.5'), r.out);
  assert.ok(r.out.includes('gate minutes (agent records): QA not recorded, REVIEW_RULES 2.0, REVIEW_RULES:contract 1.0, SECURITY 5.5'), r.out);
  const j = JSON.parse(sb.pl(d, ['retro', '--json']).out);
  assert.deepEqual(j.tasks[0].gate_s, { QA: null, REVIEW_RULES: 120, 'REVIEW_RULES:contract': 60, SECURITY: 330 });
  assert.deepEqual(j.totals.gate_s, j.tasks[0].gate_s);
  // logs that are not there: not recorded, and not a source that could not be read
  assert.ok(r.out.includes('  approve.log: not recorded (not present)') && r.out.includes('  status-block.log: not recorded (not present); updates sent: not recorded'), r.out);
  assert.equal(j.tasks[0].approve_log, null);
  assert.ok(!j.not_read.some((/** @type {string} */ l) => l.includes('approve.log') || l.includes('status-block.log')), j.not_read.join('\n'));
});

test('a hostile log line cannot inject text: only fixed words and counts reach the report; a line in no known form is counted under not read', () => {
  const d = project('hostile');
  put(d, '.agents/local/approve.log', [
    `${iso(10)} target=TASK-A kinds=${TOK} plan:\u001b[31m${TOK} rc=0 output: approval recorded: TASK-A plan (${TOK}) approval recorded: x y (/etc/passwd)`,
    `${iso(20)} target=../../${TOK} kinds=plan rc=0 output: x`,
    `not-a-time target=TASK-A kinds=plan rc=0 output: ${TOK}`,
    `${iso(30)} \u001b[2J${TOK} /Users/someone/secret.txt`,
    `${iso(40)} multi: not recorded: ${TOK}`,
  ].join('\n'));
  put(d, '.agents/local/status-block.log', `${iso(50)} TASK-A ${TOK} password=${TOK} at /home/x\n${iso(60)} ${TOK}/../x merged boom\nplain garbage ${TOK}\n`);
  const o = sb.pl(d, ['retro', '--full']).out + sb.pl(d, ['retro', '--json']).out;
  for (const bad of ['ghp_', 'abcdefghijkl', 'passwd', '/Users/', '/home/', 'secret.txt', '\u001b', 'password', '../'])
    assert.ok(!o.includes(bad), `leaked: ${JSON.stringify(bad)}\n${o}`);
  assert.ok(o.includes('approve.log: 1 approval step (1 recorded, 0 not recorded; kinds other 1, plan 1; records by source other 2)'), o);
  assert.ok(o.includes('status-block.log: 1 failed update (other 1)'), o);
  assert.ok(o.includes('approve.log: 3 lines not in a known form, not counted') && o.includes('status-block.log: 2 lines not in a known form, not counted'), o);
});

test('an approve.log that is not a plain file is listed under not read, never followed', () => {
  const d = project('dirlog');
  mkdirSync(`${d}/.agents/local/approve.log`, { recursive: true });
  const j = JSON.parse(sb.pl(d, ['retro', '--json']).out);
  assert.equal(j.logs.approve_log, 'not read');
  assert.ok(j.not_read.includes('approve.log: not-a-file'), j.not_read.join('\n'));
});
