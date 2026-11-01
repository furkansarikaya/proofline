// @ts-check
// The process-count budgets (issue #167, C4): the table is well formed and covers the HOT and STEP commands, the check fails on an excess, and a live
// run of the Node engine (agent-procs.mjs --engine default, a PATH shim counting processes: no clock) on the cheap fixtures stays inside it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkProcessBudgets, loadProcessBudgets, PROCESS_BUDGET_FILE } from './process-budgets.mjs';

const here = import.meta.dirname;
const budgets = loadProcessBudgets();
const measuredFile = JSON.parse(readFileSync(join(here, 'agent-procs-stage2.json'), 'utf8'));
// stage 3 adds the 13 commands it moved (measured with --engine default on the small fixture)
const stage3 = JSON.parse(readFileSync(join(here, 'agent-procs-stage3.json'), 'utf8'));
for (const [fx, cmds] of Object.entries(stage3.fixtures)) measuredFile.fixtures[fx] = { ...measuredFile.fixtures[fx], ...cmds };

test('the table covers the hot and step commands, the CLI status and every fixture, and equals the recorded stage 2 measurement', () => {
  for (const c of ['next', 'summary', 'summary --status', 'digest', 'pipeline', 'report-facts', 'report-tokens', 'verify-seal', 'verify-scope', 'patch-fingerprint', 'proofline status'])
    assert.ok(budgets.some((b) => b.command === c), `no process budget for ${c}`);
  for (const fx of ['small', 'scale-0', 'scale-20', 'scale-60', 'perf']) assert.ok(budgets.some((b) => b.fixture === fx), fx);
  for (const b of budgets) {
    assert.equal(measuredFile.fixtures[b.fixture]?.[b.command]?.execs, b.measured, `${b.command} on ${b.fixture}: the table differs from agent-procs-stage2.json or agent-procs-stage3.json`);
    assert.ok(b.max >= b.measured + 2 || b.max >= Math.ceil(b.measured * 1.25), `${b.command} on ${b.fixture}: no margin`);
  }
  const rf = budgets.find((b) => b.command === 'report-facts' && b.fixture === 'perf');
  assert.equal(rf?.measured, 9, 'report-facts is recorded at the measured 9 processes (the issue targets 8)');
});

test('checkProcessBudgets fails on an excess, passes at the budget, and does not judge a command that was not measured', () => {
  const rows = [{ command: 'next', fixture: 'small', max: 3, measured: 1 }];
  assert.deepEqual(checkProcessBudgets({ small: { next: { execs: 3 } } }, rows), []);
  const over = checkProcessBudgets({ small: { next: { execs: 60 } } }, rows);
  assert.equal(over.length, 1); assert.match(over[0], /next on small: 60 processes, budget 3/);
  assert.deepEqual(checkProcessBudgets({ perf: { next: { execs: 99 } } }, rows), []);
  assert.deepEqual(checkProcessBudgets({}, rows), []);
});

test('loadProcessBudgets rejects a malformed table', () => {
  const d = mkdtempSync(join(tmpdir(), 'pbudgets-'));
  try {
    for (const [text, re] of /** @type {[string, RegExp][]} */ ([['next\tsmall\t3\n', /4 tab-separated/], ['next\tsmall\tmany\t1\n', /must be numbers/], ['next\tsmall\t1\t5\n', /below the measured/], ['next\tsmall\t3\t1\nnext\tsmall\t4\t1\n', /twice/]])) {
      writeFileSync(join(d, 'b.tsv'), text);
      assert.throws(() => loadProcessBudgets(join(d, 'b.tsv')), re);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('agent-procs.mjs --engine default --compare keeps the Node engine inside the process budgets on the cheap fixtures, and fails on a tight table', () => {
  const d = mkdtempSync(join(tmpdir(), 'pbudgets-'));
  try {
    const run = (/** @type {string} */ table) => {
      writeFileSync(join(d, 'p.tsv'), table);
      return spawnSync(process.execPath, [join(here, 'agent-procs.mjs'), '--engine', 'default', '--only', 'next,pipeline,digest,summary,summary --status,verify-seal,fingerprint,report-tokens', '--fixture', 'small,scale-0', '--repeat', '1',
        '--out', join(d, 'o.json'), '--compare', join(here, 'agent-procs-baseline-0.0.40.json'), '--process-budgets', join(d, 'p.tsv')], { encoding: 'utf8' });
    };
    const tight = run('pipeline\tsmall\t1\t1\n'); assert.equal(tight.status, 1, tight.stderr); assert.match(tight.stderr, /OVER PROCESS BUDGET pipeline on small/);
    const ok = run(readFileSync(PROCESS_BUDGET_FILE, 'utf8')); assert.doesNotMatch(ok.stderr, /OVER PROCESS BUDGET/, ok.stderr);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
