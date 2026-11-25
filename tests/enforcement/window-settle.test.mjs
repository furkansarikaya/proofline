// @ts-check
// B2 and B11 of issue #338: a write window whose close timed out is closed by `handoff`, a running specialist is named, a stale window file is cleaned at
// CODE_DONE, the hook retries a close on a lock timeout, and a resumed specialist without a new submit gets a metrics row and a ledger event.
// Real hooks and the real control plane; nothing waits (the retry is tested with a fake runner).
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { closeWithRetry } from '../../adapters/claude/hooks/lib/windowclose.mjs';
import { passAll, worker, must } from '../lib/harness.mjs';
import { A, V, fixture, subStart, subStop } from './enforcement-a-lib.mjs';

const IMPL = 'proofline:proofline-implementer';
/** Open the implementer's window with the hook, write RED and GREEN as the implementer. @param {string} d @param {string} aid */
function implement(d, aid) {
  subStart(d, IMPL, aid);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n'); V(d, 'wev RED fail');
  appendFileSync(path.join(d, 'impl.txt'), 'impl: lookup returns the stored value\n'); V(d, 'wev GREEN pass');
}
const win = (/** @type {string} */ d, /** @type {string} */ aid) => path.join(d, '.agents/local/windows', aid);
const sub = (/** @type {string} */ d, /** @type {string} */ n) => path.join(d, '.agents/local/submissions', n);

test('B2: handoff closes the window of a stopped specialist whose close timed out, instead of refusing as unattested', () => {
  const d = fixture();
  implement(d, 'a7');
  rmSync(sub(d, 'a7.started'));   // the SubagentStop hook got this far, then its window-close timed out on the lock
  assert.ok(existsSync(win(d, 'a7')));
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.equal(r.status, 0, r.text);
  assert.ok(existsSync(path.join(d, '.agents/runs/LC/worker-evidence/WINDOW-1.yaml')), 'the window was not recorded');
  assert.ok(!existsSync(win(d, 'a7')) && !existsSync(sub(d, 'a7.run')), 'the window file or the registration is left behind');
});

test('B11: handoff IMPLEMENTED names a specialist that is still running and records nothing', () => {
  const d = fixture();
  implement(d, 'a7');
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /specialist still running: implementer \(a7\)/);
  assert.ok(!/not the last implementer-attested tree|unclosed/.test(r.text), r.text);
  assert.ok(existsSync(win(d, 'a7')), 'the open window of a running specialist was touched');
  assert.ok(!existsSync(path.join(d, '.agents/runs/LC/worker-evidence/WINDOW-1.yaml')));
});

test('B2: a window file left behind by a stopped specialist is cleaned at CODE_DONE', () => {
  const d = fixture();
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d);
  mkdirSync(path.dirname(win(d, 'zz')), { recursive: true }); mkdirSync(path.dirname(sub(d, 'zz.run')), { recursive: true });
  writeFileSync(win(d, 'zz'), 'deadbeef\n'); writeFileSync(sub(d, 'zz.run'), 'LC implementer\n');
  must(d, ['handoff', 'LC', 'CODE_DONE']);
  assert.ok(!existsSync(win(d, 'zz')) && !existsSync(sub(d, 'zz.run')), 'the stale window file survived CODE_DONE');
});

test('B2: the hook retries a close that timed out on the lock, and not a real refusal', async () => {
  const timeout = { status: 1, stdout: '', stderr: 'lock timeout after 8s: x' };
  const ok = { status: 0, stdout: 'worker window recorded', stderr: '' };
  let n = 0;
  const a = await closeWithRetry(async () => (++n < 3 ? timeout : ok), () => true);
  assert.deepEqual([a.closed, a.tries], [true, 3]);
  n = 0;
  const b = await closeWithRetry(async () => { n++; return timeout; }, () => true, 4);
  assert.deepEqual([b.closed, b.tries, n], [false, 4, 4]);
  n = 0;
  const c = await closeWithRetry(async () => { n++; return { status: 1, stdout: '', stderr: 'unattributed mutation' }; }, () => true);
  assert.deepEqual([c.closed, n], [false, 1]);
  n = 0;
  const e = await closeWithRetry(async () => { n++; return timeout; }, () => false);   // the lead's handoff closed it and removed the file
  assert.deepEqual([e.closed, n], [true, 1]);
});

test('B11: a resumed specialist that stops without a new submit gets a metrics row and a ledger event', () => {
  const d = fixture();
  subStart(d, 'proofline:proofline-explorer', 'e5');
  // the status file of its earlier submit, older than this (re)start
  const st = sub(d, 'e5.status');
  writeFileSync(st, 'status=ok\nrole=explorer\nresult=PASS\nraw=x\n');
  const old = new Date(1_000_000_000_000); utimesSync(st, old, old);
  const out = subStop(d, 'proofline:proofline-explorer', 'e5', true);
  assert.ok(!out.includes('"decision":"block"'), 'a resume was sent back for a submit it does not owe');
  const rows = readFileSync(path.join(d, '.agents/local/metrics/records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.some((r) => r.kind === 'dispatch' && r.role === 'explorer' && r.result === 'resumed'), 'no metrics row for the resume');
  assert.match(readFileSync(path.join(d, '.agents/runs/LC/LEDGER.log'), 'utf8'), /event=note .*specialist-resumed role:explorer agent=e5/);
  assert.match(readFileSync(path.join(d, '.agents/local/records/e5.txt'), 'utf8'), /resumed and stopped without a new submit/);
  assert.ok(!existsSync(sub(d, 'e5.run')) && !existsSync(sub(d, 'e5.started')));
});
