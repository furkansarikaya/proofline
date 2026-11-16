// @ts-check
// batch-cover cross-check (A303): the cover is honoured only for a task that the summary the USER approved lists (the approval is bound to that file's hash) and whose order.tsv row is
// the same row. order.tsv is not part of the approved bytes, so an id added, a class or dependency swapped, or the file of another batch must be refused with a clear message and write
// nothing. Criteria: invariant 3 (approvals come from the user's message; the system may only get stricter).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { A, AB, batchApprove, coverProject, fakes, mktask, read, readIf, writeFileSync } from './batch-lib.mjs';

/** @param {{ status: number|null, text: string }} r @param {string} what @param {string} msg */
function refused(r, what, msg) {
  assert.notEqual(r.status, 0, `${what}: the cover was honoured\n${r.text}`);
  assert.ok(r.text.includes(msg), `${what}: refused for another reason: ${r.text.trim().split('\n').pop()}`);
}
const approvals = (/** @type {string} */ dir) => { try { return readdirSync(`${dir}/.agents/runs/LC/approvals`).length; } catch { return 0; } };
/** One hash over every file below the folders (path and bytes): equal before and after a refused call means it wrote nothing. @param {string[]} dirs */
function treeHash(dirs) {
  const h = createHash('sha256');
  /** @param {string} d */ const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = `${d}/${n}`;
      if (statSync(f).isDirectory()) walk(f); else h.update(`${f}\0`).update(readFileSync(f)).update('\0');
    }
  };
  for (const d of dirs) walk(d);
  return h.digest('hex');
}
const WRITES = (/** @type {string} */ dir) => treeHash([`${dir}/.agents/local/batch`, `${dir}/.agents/runs/LC`]);
const ORDER = (/** @type {string} */ dir) => `${dir}/.agents/local/batch/order.tsv`;
const SUMMARY = (/** @type {string} */ dir) => `${dir}/.agents/local/batch/SUMMARY.md`;

/** Run LC has a pending plan request; the batch is planned with `ids` (an approved summary), LC is in it or not. @param {string[]} ids @param {(dir: string) => void} [before] */
function setup(ids, before = () => {}) {
  const F = fakes();
  const dir = coverProject();
  mktask(dir, 'X2', 'STANDARD');
  before(dir);
  const p = AB(F, dir, ['batch-plan', ...ids]);
  assert.equal(p.status, 0, `batch-plan failed: ${p.text}`);
  batchApprove(dir);
  A(dir, ['request-approval', 'LC', 'plan']);
  return { F, dir, n0: approvals(dir) };
}

test('forged order.tsv entry: a task the approved summary does not list is refused, nothing is written', () => {
  const { F, dir } = setup(['X2']);
  assert.ok(!/\| LC \|/.test(read(SUMMARY(dir))), 'fixture: LC is in the summary');
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'LC outside the batch', 'is not in the batch');
  writeFileSync(ORDER(dir), `${read(ORDER(dir))}LC\tCOMPLEX\t-\n`);
  const n = approvals(dir);
  const h0 = WRITES(dir);
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'LC forged into order.tsv', 'does not match the approved summary');
  refused(AB(F, dir, ['batch-cover', 'LC', 'delivery']), 'LC forged into order.tsv (delivery)', 'does not match the approved summary');
  assert.equal(approvals(dir), n, 'a refused cover wrote an approval');
  assert.equal(WRITES(dir), h0, 'a refused cover changed the batch folder or the run folder');
});

test('a task the user excluded (CRITICAL, listed under "Not in this batch") forged into order.tsv is refused', () => {
  const { F, dir } = setup(['all'], (d) => { mktask(d, 'LC', 'CRITICAL'); });
  assert.ok(/Not in this batch[^]*- LC: class CRITICAL/.test(read(SUMMARY(dir))), 'fixture: LC is not excluded as CRITICAL');
  writeFileSync(ORDER(dir), `${read(ORDER(dir))}LC\tCRITICAL\t-\nLC\tCOMPLEX\t-\n`);
  const n = approvals(dir);
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'excluded CRITICAL task', 'does not match the approved summary');
  assert.equal(approvals(dir), n);
});

test('a hand-edited order.tsv row (class or depends_on swapped) is refused; the untouched file is honoured', () => {
  const { F, dir, n0 } = setup(['all']);
  const good = read(ORDER(dir));
  for (const [what, bad] of [['class', good.replace(/\tCOMPLEX\t/, '\tSTANDARD\t')], ['depends_on', good.replace(/\t-\n/, '\tX2\n')], ['duplicate row', `${good}${good}`]]) {
    assert.notEqual(bad, good, `fixture: ${what} did not change the file`);
    writeFileSync(ORDER(dir), bad);
    refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), `order.tsv ${what}`, 'differs from the task table');
  }
  assert.equal(approvals(dir), n0, 'a refused cover wrote an approval');
  writeFileSync(ORDER(dir), good);
  assert.equal(AB(F, dir, ['batch-cover', 'LC', 'plan']).status, 0, 'the genuine batch is no longer honoured');
});

test('the order.tsv of another batch next to the approved summary of this one is refused', () => {
  const { F, dir, n0 } = setup(['all']);
  const other = read(ORDER(dir));                       // the order of batch 1 (LC and X2)
  const p = AB(F, dir, ['batch-plan', '--replace', 'X2']);
  assert.equal(p.status, 0, p.text);
  batchApprove(dir);
  assert.ok(!/\| LC \|/.test(read(SUMMARY(dir))), 'fixture: LC is in batch 2');
  writeFileSync(ORDER(dir), other);
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'order.tsv of batch 1 under the summary of batch 2', 'does not match the approved summary');
  assert.equal(approvals(dir), n0);
});

test('a stale summary and a second batch reusing the first approval cover nothing', () => {
  const { F, dir, n0 } = setup(['all']);
  const first = read(SUMMARY(dir));
  writeFileSync(SUMMARY(dir), `${first}\n- edited after the approval\n`);        // hash replaced
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'edited summary', 'no valid batch approval');
  writeFileSync(SUMMARY(dir), first);
  const p = AB(F, dir, ['batch-plan', '--replace', 'all']);                       // a second batch: a new summary (new nonce), not yet approved
  assert.equal(p.status, 0, p.text);
  assert.notEqual(read(SUMMARY(dir)), first, 'fixture: the second summary equals the first');
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'second batch before its own approval', 'no valid batch approval');
  assert.equal(approvals(dir), n0);
  assert.equal(readIf(`${dir}/.agents/local/batch/state.tsv`), '');
});

/** The LC task file with the given first line, CRLF line endings. @param {string} first */
const crlf = (first) => (/** @type {string} */ dir) => {
  const f = `${dir}/.agents/tasks/LC.md`;
  writeFileSync(f, read(f).replace(/^# Task: .*$/m, first).replace(/\n/g, '\r\n'));
};

test('a Windows (CRLF) task file or a lone CR in a title does not make a legitimate batch refuse its cover', () => {
  for (const first of ['# Task: LC \u2014 title of LC', '# Task: LC \u2014 ti\rtle of LC']) {
    const { F, dir } = setup(['all'], crlf(first));
    assert.ok(read(SUMMARY(dir)).includes('\r'), 'fixture: the summary row carries no CR');
    const c = AB(F, dir, ['batch-cover', 'LC', 'plan']);
    assert.equal(c.status, 0, `a CRLF title row was refused: ${c.text}`);
  }
});

test('with CRLF task files a forged id is still refused', () => {
  const { F, dir, n0 } = setup(['X2'], crlf('# Task: LC \u2014 title of LC'));
  writeFileSync(ORDER(dir), `${read(ORDER(dir))}LC\tCOMPLEX\t-\n`);
  const h0 = WRITES(dir);
  refused(AB(F, dir, ['batch-cover', 'LC', 'plan']), 'forged id, CRLF files', 'does not match the approved summary');
  assert.equal(approvals(dir), n0);
  assert.equal(WRITES(dir), h0);
});
