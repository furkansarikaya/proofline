// @ts-check
// A365 (issue 338 C5), the batch tables under the output cap, on a REAL batch of 60 tasks: T-1 and the last four tasks wait for the user (each parked with a question), the 55
// tasks between them depend on T-1 and are skipped. The waiting rows at the END of the table must be in the capped output, the finished rows are what is dropped, a
// machine-readable answer and the internal readers (`next-user --waiting`) are not cut. One project for the whole file (the scenarios only read it).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { AB, batchApprove, behave, binstall, bnew, drive, fakes, mktask } from './batch-lib.mjs';

const N = 61; // T-61 is parked 'awaiting merge': its question is a pull request number, it does not wait for the user
const ASKING = ['T-1', 'T-57', 'T-58', 'T-59', 'T-60'];
/** @type {{ F: ReturnType<typeof fakes>, dir: string } | null} */ let memo = null;
function batch() {
  if (memo) return memo;
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX');
  for (let i = 2; i < 57; i++) mktask(dir, `T-${i}`, 'COMPLEX', 'T-1');
  for (let i = 57; i <= N; i++) mktask(dir, `T-${i}`, 'COMPLEX');
  binstall(dir);
  AB(F, dir, ['batch-plan', 'all']); batchApprove(dir);
  for (const id of ASKING) behave(F, id, 'question');
  behave(F, `T-${N}`, 'await');
  drive(F, dir);
  memo = { F, dir };
  return memo;
}
/** @param {string} dir @param {string} v */
const setCap = (dir, v) => { const f = `${dir}/.agents/config.yaml`; writeFileSync(f, `${readFileSync(f, 'utf8').replace(/^output_cap_bytes:.*\n/m, '')}\noutput_cap_bytes: ${v}\n`); };
const rowsOf = (/** @type {string} */ out) => out.split('\n').filter((l) => /^T-\d+ \|/.test(l));

test('batch-next over the cap: the waiting rows at the end come first and are listed whole, only finished rows are dropped', () => {
  const { F, dir } = batch();
  setCap(dir, '0');
  const full = AB(F, dir, ['batch-next']).out;
  assert.equal(rowsOf(full).length, N);
  assert.ok(full.length > 3000, `the real table is large: ${full.length}`);
  setCap(dir, '2000');
  const cut = AB(F, dir, ['batch-next']).out;
  assert.ok(cut.length < 2600, String(cut.length));
  const lines = cut.split('\n');
  assert.equal(lines.find((l) => /^rows: /.test(l)), `rows: ${N}, waiting: 0, runnable: 0, parked: 6`);
  const list = lines.slice(lines.findIndex((l) => /^waiting for the user \(5\):/.test(l)));
  for (const id of ASKING) assert.ok(list.some((l) => l.startsWith(`  ${id}: `) && l.includes(`Which cache do we use for ${id}?`)), `${id} is not in the waiting list`);
  const rows = rowsOf(cut);
  assert.ok(rows[5].startsWith(`T-${N} | PARKED | awaiting merge`) && !list.some((l) => l.startsWith(`  T-${N}:`)), 'an awaiting-merge row is parked, not waiting for the user, and comes after the five');
  assert.deepEqual(rows.slice(0, 5).map((l) => l.split(' ')[0]), ASKING, 'the five waiting rows lead the table, in table order');
  for (const id of ASKING) assert.ok(rows.some((l) => l.startsWith(`${id} | PARKED`) && l.includes(`Which cache do we use for ${id}?`)), `${id} row is missing or cut`);
  assert.ok(rows.length < N && /^\.\.\.\d+ more rows \(finished ones first\): agent\.sh batch-next --full$/m.test(cut));
  assert.ok(/^NEXT: /m.test(cut) || /^waiting for the user: /m.test(cut), 'the step is kept');
});

test('batch-status over the cap: the same order, the waiting rows of the end are shown', () => {
  const { F, dir } = batch();
  setCap(dir, '2000');
  const r = AB(F, dir, ['batch-status']).out;
  assert.match(r, new RegExp(`^rows: ${N}, waiting: 0, runnable: 0, parked: 6$`, 'm'));
  assert.deepEqual(rowsOf(r).slice(0, 5).map((l) => l.split(' ')[0]), ASKING);
  assert.match(r, /^\.\.\.\d+ more rows \(finished ones first\): agent\.sh batch-status --full$/m);
  for (const id of ASKING) assert.ok(r.includes(`  ${id}: `), `${id} is not in the waiting list`);
});

test('--tsv is never capped and next-user --waiting gives the same answer under a small cap', () => {
  const { F, dir } = batch();
  setCap(dir, '0');
  const tsv = AB(F, dir, ['batch-next', '--tsv']).out;
  const before = AB(F, dir, ['next-user', '--waiting']);
  setCap(dir, '500');
  assert.equal(AB(F, dir, ['batch-next', '--tsv']).out, tsv);
  assert.ok(!/more bytes|more rows/.test(tsv));
  const after = AB(F, dir, ['next-user', '--waiting']);
  assert.equal(after.out, before.out);
  assert.equal(after.status, before.status);
});
