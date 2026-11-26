// @ts-check
// A365 (issue 338 C5), the batch tables under the output cap: a row that is waiting for the user or needs a step is never hidden, only finished rows are; a machine-readable
// answer and the internal readers (`next-user --waiting`) are not cut.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, AB, batchApprove, behave, binstall, bnew, drive, fakes, mktask } from './batch-lib.mjs';

const N = 14;
/** A batch of N tasks: T-1 and T-N park with a question, T-2..T-(N-1) depend on T-1 and are skipped (finished rows). Returns the fakes and the project. */
function bigBatch() {
  const F = fakes(); const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX');
  for (let i = 2; i < N; i++) mktask(dir, `T-${i}`, 'COMPLEX', 'T-1');
  mktask(dir, `T-${N}`, 'COMPLEX');
  binstall(dir);
  AB(F, dir, ['batch-plan', 'all']); batchApprove(dir);
  behave(F, 'T-1', 'question'); behave(F, `T-${N}`, 'question');
  drive(F, dir);
  return { F, dir };
}
/** @param {string} dir @param {string} v */
const setCap = (dir, v) => { const f = `${dir}/.agents/config.yaml`; writeFileSync(f, `${readFileSync(f, 'utf8').replace(/^output_cap_bytes:.*\n/m, '')}\noutput_cap_bytes: ${v}\n`); };

test('batch-next over the cap: summary first, the rows that need the user first, only finished rows hidden', () => {
  const { F, dir } = bigBatch();
  const full = AB(F, dir, ['batch-next', '--full']).out;
  assert.ok(full.split('\n').filter((l) => /^T-\d+ \|/.test(l)).length === N);
  setCap(dir, '500');
  const cut = AB(F, dir, ['batch-next']);
  const lines = cut.out.split('\n');
  const first = lines.findIndex((l) => /^rows: /.test(l));
  assert.equal(lines[first], `rows: ${N}, waiting: 0, runnable: 0, parked: 2`);
  assert.ok(first < lines.findIndex((l) => /^T-\d+ \|/.test(l)), 'the summary comes before the rows');
  const rows = lines.filter((l) => /^T-\d+ \|/.test(l));
  assert.ok(rows[0].startsWith('T-1 | PARKED') && rows[1].startsWith(`T-${N} | PARKED`), `parked rows first: ${rows.slice(0, 3)}`);
  assert.ok(rows.length < N);
  assert.match(cut.out, new RegExp(`\\.\\.\\.${N - rows.length} finished rows hidden: agent\\.sh batch-next --full`));
  assert.ok(/^NEXT: /m.test(cut.out) || /^waiting for the user: /m.test(cut.out), 'the step is kept');
  assert.ok(/^waiting for the user: T-1: /m.test(full) === /^waiting for the user: T-1: /m.test(cut.out));
});

test('batch-status over the cap lists the parked rows first and says how many finished rows are hidden', () => {
  const { F, dir } = bigBatch();
  setCap(dir, '500');
  const r = AB(F, dir, ['batch-status']).out;
  assert.match(r, /^rows: 14, waiting: 0, runnable: 0, parked: 2$/m);
  const rows = r.split('\n').filter((l) => /^T-\d+ \|/.test(l));
  assert.ok(rows[0].startsWith('T-1 | PARKED') && rows[1].startsWith('T-14 | PARKED'));
  assert.match(r, /finished rows? hidden: agent\.sh batch-status --full/);
});

test('--tsv is never capped and next-user --waiting gives the same answer under a small cap', () => {
  const { F, dir } = bigBatch();
  const tsv = AB(F, dir, ['batch-next', '--tsv']).out;
  const before = AB(F, dir, ['next-user', '--waiting']);
  setCap(dir, '500');
  assert.equal(AB(F, dir, ['batch-next', '--tsv']).out, tsv);
  assert.ok(!/more bytes/.test(tsv));
  const after = AB(F, dir, ['next-user', '--waiting']);
  assert.equal(after.out, before.out);
  assert.equal(after.status, before.status);
  assert.ok(A(dir, ['status']).status === 0);
});
