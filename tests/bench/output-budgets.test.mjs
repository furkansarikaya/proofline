// @ts-check
// The output budgets (ADR 0001 section 8.3): the table is well formed and consistent with the 0.0.40 measurement, the check fails on an excess,
// a live run of the real commands stays inside it, and agent-procs.mjs --compare is wired to it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ARGS, VARIANTS, buildFixture } from './agent-procs.mjs';
import { BUDGET_FILE, checkBudgets, loadBudgets } from './output-budgets.mjs';

const here = import.meta.dirname;
const baseline = JSON.parse(readFileSync(join(here, 'agent-procs-baseline-0.0.40.json'), 'utf8'));
const budgets = loadBudgets();
const tmp = () => mkdtempSync(join(tmpdir(), 'budgets-'));

test('the table names the HOT and STEP commands of the ADR, per fixture state', () => {
  for (const c of ['next', 'summary --status', 'report-tokens', 'hook-config']) assert.ok(budgets.some((b) => b.klass === 'HOT' && b.command === c), `no HOT row for ${c}`);
  for (const c of ['pipeline', 'digest', 'questions', 'verify-gates', 'verify-seal', 'verify-freeze', 'verify-scope', 'verify-handoff', 'verify-knowledge-scope', 'verify-qa-plan', 'verify-worker-evidence'])
    assert.ok(budgets.some((b) => b.klass === 'STEP' && b.command === c), `no STEP row for ${c}`);
  for (const c of ['next', 'pipeline', 'digest', 'summary --status']) for (const fx of ['small', 'perf', 'scale-0', 'scale-20', 'scale-60']) assert.ok(budgets.some((b) => b.command === c && b.fixture === fx), `${c} has no budget on ${fx}`);
  for (const b of budgets) assert.ok(b.command.split(' ')[0] in ARGS, `${b.command} is not a benchmark command`);
});

test('every budget is the 0.0.40 size on that fixture (a summary --status row is its measured size, a few dozen bytes)', () => {
  for (const b of budgets) {
    if (b.command in VARIANTS) { assert.ok(b.max > 0 && b.max < 100, `${b.command} on ${b.fixture}: ${b.max}`); continue; }
    const m = baseline.fixtures[b.fixture]?.[b.command];
    assert.ok(m, `${b.command} was not measured on ${b.fixture} in the baseline`);
    assert.equal(b.max, m.stdout_bytes, `${b.command} on ${b.fixture} differs from the 0.0.40 measurement (raise a budget only with a decision)`);
  }
});

test('checkBudgets fails on an excess, passes at the budget and below, and does not judge a command that was not measured', () => {
  const rows = [{ klass: 'HOT', command: 'next', fixture: 'small', max: 147 }, { klass: 'STEP', command: 'pipeline', fixture: 'small', max: 385 }];
  assert.deepEqual(checkBudgets({ small: { next: { stdout_bytes: 147 }, pipeline: { stdout_bytes: 100 } } }, rows), []);
  const over = checkBudgets({ small: { next: { stdout_bytes: 148 }, pipeline: { stdout_bytes: 386 } } }, rows);
  assert.equal(over.length, 2); assert.match(over[0], /HOT next on small: 148 stdout bytes, budget 147/);
  assert.deepEqual(checkBudgets({ perf: { next: { stdout_bytes: 99999 } } }, rows), []);
  assert.deepEqual(checkBudgets({}, rows), []);
});

test('loadBudgets rejects a malformed table', () => {
  const d = tmp();
  try {
    for (const [text, re] of /** @type {[string, RegExp][]} */ ([['HOT\tnext\tsmall\n', /4 tab-separated/], ['WARM\tnext\tsmall\t1\n', /unknown class/], ['HOT\tnext\tsmall\tmany\n', /number of bytes/], ['HOT\tnext\tsmall\t1\nSTEP\tnext\tsmall\t2\n', /twice/]])) {
      writeFileSync(join(d, 'b.tsv'), text);
      assert.throws(() => loadBudgets(join(d, 'b.tsv')), re);
    }
    writeFileSync(join(d, 'b.tsv'), '# comment\n\nHOT\tnext\tsmall\t5\n');
    assert.deepEqual(loadBudgets(join(d, 'b.tsv')), [{ klass: 'HOT', command: 'next', fixture: 'small', max: 5 }]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the real commands stay inside their budgets on the small fixture (default engine: the Node core where the command has moved)', () => {
  const fx = buildFixture('small'); const copy = tmp();
  try {
    const env = { PATH: process.env.PATH ?? '', HOME: copy, LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PROOFLINE_NO_TTY: '1', TMPDIR: process.env.TMPDIR ?? tmpdir() };
    const measured = /** @type {Record<string, Record<string, { stdout_bytes: number }>>} */ ({ small: {} });
    for (const b of budgets.filter((x) => x.fixture === 'small')) {
      const args = (VARIANTS[b.command] ?? ARGS[b.command.split(' ')[0]] ?? '').split(' ').filter(Boolean);
      const work = join(copy, b.command.replace(/ /g, '_')); spawnSync('cp', ['-R', fx, work]);
      const r = spawnSync('sh', ['./.agents/scripts/agent.sh', b.command.split(' ')[0], ...args], { cwd: work, env, input: '', maxBuffer: 1 << 26 });
      measured.small[b.command] = { stdout_bytes: Buffer.byteLength(r.stdout ?? '') };
    }
    assert.deepEqual(checkBudgets(measured, budgets), []);
  } finally { rmSync(fx, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); }
});

test('agent-procs.mjs --compare fails when a command exceeds its budget and passes within it', () => {
  const d = tmp();
  try {
    const run = (/** @type {string} */ tsv) => {
      writeFileSync(join(d, 'b.tsv'), tsv);
      return spawnSync(process.execPath, [join(here, 'agent-procs.mjs'), '--only', 'next', '--fixture', 'small', '--repeat', '1', '--out', join(d, 'o.json'), '--compare', join(here, 'agent-procs-baseline-0.0.40.json'), '--budgets', join(d, 'b.tsv')], { encoding: 'utf8' });
    };
    const tight = run('HOT\tnext\tsmall\t1\n'); assert.equal(tight.status, 1, tight.stderr); assert.match(tight.stderr, /OVER BUDGET HOT next on small/);
    const ok = run(readFileSync(BUDGET_FILE, 'utf8')); assert.equal(ok.status, 0, ok.stderr); assert.doesNotMatch(ok.stderr, /OVER BUDGET/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
