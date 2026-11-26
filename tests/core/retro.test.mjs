// @ts-check
// U8 (issue 338 R1-18, R2-19, R3-14, R4-12): `proofline retro [<batch-id|run-id>] [--since DATE] [--json] [--full]` (core/retro.mjs, A370): a read-only report of finished runs from their records:
// ledgers (live and inside the run archives, read as streams), `metrics/records.jsonl`, `metrics/tools.jsonl` and `batch/*.tsv`. The project is planted by hand: two runs with a ledger (one live, one
// archived), a run with records only, a damaged archive and a hostile archive. Every number below is worked out from the planted rows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox } from './frontend-lib.mjs';
import { tgzBuffer } from '../lib/tarmake.mjs';

const sb = sandbox();
const T0 = 1760349600;
const H = '0'.repeat(64);

/** @param {string} dir @param {string} file @param {string | Buffer} text */
function put(dir, file, text) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); }
/** Ledger text from [offset seconds, event, detail, role, to]. @param {Array<[number, string, string, string?, string?]>} rows */
function ledger(rows) {
  return rows.map(([t, ev, detail, role = 'lead', to = '-'], i) => `seq=${i + 1} prev=${H} event=${ev} role=${role} from=- to=${to} digest=${H} ts=${new Date((T0 + t) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')} epoch=${T0 + t} detail=${detail}\n`).join('');
}
const jl = (/** @type {object[]} */ rows) => rows.map((r) => JSON.stringify(r)).join('\n');
/** @param {string} kind @param {string} task @param {string} role @param {object} extra */
const rec = (kind, task, role, extra = {}) => ({ schema: 'proofline.metrics/1', kind, time: '2026-10-13T10:00:00Z', task, role, focus: null, gate: null, runtime: 'claude', model: null, duration_s: null, tokens_in: null, tokens_out: null, tokens_total: null, turns: null, retries: null, delegations: null, fix_rounds: null, result: null, ...extra });

const LEDGER_A = ledger([
  [0, 'start', 'task=TASK.md'], [60, 'classify', 'STANDARD'], [120, 'approval-request', 'plan bound=x'],
  [300, 'approval', `approvals/001-plan.yaml@${H} plan source=prompt_capture answered_by=user bound=x`],
  [600, 'handoff:IMPLEMENTED', 'x'], [660, 'gate:REVIEW_RULES:fail', `gates/001-REVIEW_RULES.yaml@${H} by reviewer`], [700, 'gate:SECURITY:pass', `gates/002-SECURITY.yaml@${H} by security_reviewer`],
  [720, 'ask', 'questions/1.md'], [900, 'answer', 'questions/1.md answered_by=user'], [960, 'handoff:IMPLEMENTING', 'fix_round=1'], [1200, 'handoff:IMPLEMENTED', 'y'],
  [1260, 'gate:REVIEW_RULES:pass', `gates/003-REVIEW_RULES.yaml@${H} by reviewer`], [1320, 'friction-note', 'user-shell'], [1500, 'handoff:DONE', 'AKIAABCDEFGHIJKLMNOP is a secret-like text in free detail'],
]);
const LEDGER_B = ledger([
  [0, 'start', 'task=TASK.md'], [100, 'handoff:IMPLEMENTED', 'x'], [200, 'gate:QA:fail', `gates/001-QA.yaml@${H} by qa`], [250, 'REOPEN', 'reopened'], [400, 'record:implementer:BLOCKED', 'results/001.result.md'], [500, 'terminate', 'x', 'lead', 'BLOCKED'],
]);
const LEDGER_E = ledger([[0, 'start', 'task=TASK.md'], [60, 'handoff:DONE', 'x']]);

function plant() {
  const d = sb.mkrepo('retro');
  put(d, '.agents/config.yaml', 'proofline_version: 0.0.192\nmetrics: on\n');
  put(d, '.agents/scripts/agent.sh', '#!/bin/sh\nexit 0\n');
  put(d, '.agents/runs/TASK-A/LEDGER.log', LEDGER_A);
  put(d, '.agents/local/archive/TASK-B/TASK-B-20261010T100000Z.tar.gz', tgzBuffer([{ name: 'TASK-B/', type: '5' }, { name: 'TASK-B/LEDGER.log', data: LEDGER_B }]));
  put(d, '.agents/local/archive/TASK-D/TASK-D-20261010T100000Z.tar.gz', 'not a gzip file');
  put(d, '.agents/local/archive/TASK-E/TASK-E-20261010T100000Z.tar.gz', tgzBuffer([{ name: '../evil', data: 'x' }, { name: 'TASK-E/LEDGER.log', type: '2', linkname: '/etc/passwd' }, { name: 'TASK-E/LEDGER.log', data: LEDGER_E }]));
  put(d, '.agents/local/metrics/records.jsonl', `${jl([
    rec('step', 'TASK-A', 'implementer', { duration_s: 600, tokens_total: 5000, result: 'done' }),
    rec('step', 'TASK-A', 'implementer', { duration_s: 300, tokens_total: 3000, result: 'done' }),
    rec('step', 'TASK-A', 'reviewer', { duration_s: 120, tokens_in: 100, tokens_out: 50, result: 'pass', gate: 'REVIEW_RULES' }),
    rec('dispatch', 'TASK-A', 'reviewer', { duration_s: 130, tokens_total: 999, result: 'submitted' }),
    rec('dispatch', 'TASK-A', 'implementer', { duration_s: 60, result: 'resumed' }),
    rec('lead', 'TASK-A', 'lead', { tokens_total: 20000 }),
    rec('run', 'TASK-A', 'lead', { duration_s: 1500, result: 'done', class: 'STANDARD', fix_rounds: 1 }),
    rec('dispatch', 'TASK-B', 'implementer', { duration_s: 400, tokens_total: 7000, result: 'submitted' }),
    rec('step', 'TASK-B', 'implementer', { duration_s: 400, result: 'blocked' }),
    rec('run', 'TASK-C', 'lead', { duration_s: 900, result: 'done', class: 'TRIVIAL', fix_rounds: 0 }),
  ])}\nthis line is not json\n${JSON.stringify({ schema: 'other/9', kind: 'step', task: 'TASK-A' })}\n`);
  put(d, '.agents/local/metrics/tools.jsonl', `${jl([
    { schema: 'proofline.tools/1', kind: 'step', task: 'TASK-A', role: 'implementer', log: 'ok', calls: 40, denied: 3, denials: { 'outside project folder': 2, 'no-reason': 1 } },
    { schema: 'proofline.tools/1', kind: 'step', task: 'TASK-B', role: 'implementer', log: 'ok', calls: 5, denied: 0, denials: {} },
  ])}\n`);
  const summary = '# batch summary\n';
  put(d, '.agents/local/batch/SUMMARY.md', summary);
  put(d, '.agents/local/batch/order.tsv', 'TASK-A\tSTANDARD\t-\nTASK-B\tSTANDARD\tTASK-A\n');
  put(d, '.agents/local/batch/merged.tsv', `TASK-A\t12\t${T0 + 1560}\n`);
  put(d, '.agents/local/batch/state.tsv', 'TASK-B\tparked\tblocked on a scope question\tq1\n');
  return { d, bid: createHash('sha256').update(summary).digest('hex').slice(0, 12) };
}

/** Every file with size and mtime: a read-only command changes none of them. @param {string} root */
function sig(root) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {string} */ dir) => { for (const n of readdirSync(dir).sort()) { if (n === '.git') continue; const p = path.join(dir, n); const s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${path.relative(root, p)} ${s.size} ${s.mtimeMs}`); } };
  walk(root);
  return out.join('\n');
}

const { d, bid } = plant();
const before = sig(d);
const all = sb.pl(d, ['retro', '--full']);

test('retro reads live ledgers, archived ledgers and records, writes nothing, and every number follows from the planted rows', () => {
  assert.equal(all.status, 0, all.text);
  assert.equal(sig(d), before, 'the project must be unchanged');
  assert.ok(!readdirSync(path.dirname(d)).includes('evil'));
  const o = all.out;
  for (const want of [
    'proofline retro (read-only: nothing was changed)',
    'TASK-A', 'done', 'STANDARD',
    'task 25.0 min; first pass 16.0 min (64%), rework 5.0 min (20%), after the last gate 4.0 min (16%)',
    'agent minutes: implementer 16.0, reviewer 2.0',
    'tokens: implementer 8000 (2/3 records), lead 20000 (1/1 records), reviewer 150 (1/1 records); total 28150',
    'fix rounds: 1 (ledger); reopens: 0',
    'gates: REVIEW_RULES 2 runs (1 fail), SECURITY 1 run (0 fail)',
    'gate re-runs: after fix_round=1: REVIEW_RULES; read-set comparison: not recorded',
    'user waits: 2 (total 6.0 min, longest 3.0 min), unanswered 0',
    'questions: 1 (answered by the user 1, by an assumption 0); approvals: plan requested 1, granted 1',
    'hook denials: 3 (no-reason 1, outside project folder 2)',
    'friction: user-shell 1; workarounds seen by the control plane 0',
    'merge: PR 12, 1.0 min after the last ledger event',
    'TASK-B', 'blocked',
    'task 8.3 min; first pass 4.2 min (50%), rework 4.2 min (50%), after the last gate 0.0 min (0%)',
    'tokens: implementer 7000 (1/2 records)',
    'reopens: 1', 'blocked records: 1', 'parked in the batch',
    'TASK-C', 'ledger: not recorded',
  ]) assert.ok(o.includes(want), `missing: ${want}\n${o}`);
});

test('resumed runs are listed, and what could not be read is listed instead of guessed', () => {
  const o = all.out;
  const resumed = o.slice(o.indexOf('resumed runs:'), o.indexOf('not read (listed'));
  assert.match(resumed, /TASK-A: 1 agent resumed without a new submit \(implementer 1\.0 min, no tokens recorded\); reopened 0 times/);
  assert.match(resumed, /TASK-B: reopened 1 time \(ledger REOPEN\)/);
  const nr = o.slice(o.indexOf('not read (listed'));
  for (const want of ['records.jsonl: 1 line not JSON, 1 line of another schema', 'TASK-C: no ledger (no live run, no archive)', 'TASK-D: archive TASK-D-20261010T100000Z.tar.gz unreadable: not-gzip', 'TASK-E: 2 archive entries refused (unsafe name or not a plain file), nothing written'])
    assert.ok(nr.includes(want), `missing: ${want}\n${nr}`);
});

test('no excerpt of a record is printed: a secret-like text in a ledger detail never reaches the report, and the report has no verdict or score', () => {
  assert.ok(!all.out.includes('AKIA') && !all.out.includes('secret-like'));
  assert.ok(!/score|verdict|quality:/i.test(all.out.replace('not a measure of quality', '')));
});

test('a batch id, a run id and --since select; an unknown one fails; --json is one object of the same numbers', () => {
  const b = sb.pl(d, ['retro', bid, '--full']);
  assert.equal(b.status, 0, b.text);
  assert.ok(b.out.includes('scope: batch ') && b.out.includes('TASK-A') && b.out.includes('TASK-B') && !b.out.includes('TASK-C:'), b.out);
  assert.match(b.out, /wall 26\.0 min/);
  const one = sb.pl(d, ['retro', 'TASK-B']);
  assert.ok(one.out.includes('TASK-B') && !one.out.includes('TASK-A '), one.out);
  const none = sb.pl(d, ['retro', 'NOPE-1']);
  assert.equal(none.status, 1);
  assert.match(none.err, /^proofline: no such batch or run: NOPE-1$/m);
  assert.match(sb.pl(d, ['retro', '../x']).err, /^proofline: invalid batch or run id: \.\.\/x$/m);
  assert.match(sb.pl(d, ['retro', '--since', 'yesterday']).err, /--since needs a date as YYYY-MM-DD/);
  assert.match(sb.pl(d, ['retro', '--frobnicate']).err, /unknown argument: --frobnicate/);
  const since = sb.pl(d, ['retro', '--since', '2025-10-14', '--full']);
  assert.ok(!since.out.includes('TASK-A (') && since.out.includes('TASK-C (') && since.out.includes('scope: runs since 2025-10-14'), since.out);
  const j = JSON.parse(sb.pl(d, ['retro', '--json']).out);
  assert.equal(j.schema, 'proofline.retro/1');
  const a = j.tasks.find((/** @type {any} */ t) => t.task === 'TASK-A');
  assert.deepEqual([a.task_s, a.first_pass_s, a.rework_s, a.after_s, a.fix_rounds, a.reopens, a.tokens_total], [1500, 960, 300, 240, 1, 0, 28150]);
  assert.deepEqual(a.user_waits, { count: 2, total_s: 360, longest_s: 180, unanswered: 0 });
  assert.equal(j.tasks.find((/** @type {any} */ t) => t.task === 'TASK-C').ledger, 'not recorded');
  assert.ok(j.not_read.length >= 4);
});

test('the report is cut at the output cap with one line naming --full; --full and --json are not cut', () => {
  const capped = sb.pl(d, ['retro']);
  assert.equal(capped.status, 0);
  const cfg = readFileSync(`${d}/.agents/config.yaml`, 'utf8');
  writeFileSync(`${d}/.agents/config.yaml`, `${cfg}output_cap_bytes: 600\n`);
  const small = sb.pl(d, ['retro']);
  assert.match(small.out, /\n\.\.\.\d+ more bytes: proofline retro --full\n(Next step: .*\n)?$/);
  assert.ok(small.out.length < 900);
  assert.ok(sb.pl(d, ['retro', '--full']).out.length > 1500);
  assert.ok(sb.pl(d, ['retro', '--json']).out.length > 1500);
  writeFileSync(`${d}/.agents/config.yaml`, cfg);
});

test('without records the report says so, and a project that is not installed is refused', () => {
  const e = sb.mkrepo('empty');
  assert.match(sb.pl(e, ['retro']).err, /proofline is not installed/);
  put(e, '.agents/config.yaml', 'proofline_version: 0.0.192\n');
  put(e, '.agents/scripts/agent.sh', '#!/bin/sh\n');
  const r = sb.pl(e, ['retro']);
  assert.equal(r.status, 0, r.text);
  assert.match(r.out, /no runs found/);
});
