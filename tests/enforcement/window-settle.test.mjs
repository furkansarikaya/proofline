// @ts-check
// B2 and B11 of issue #338: a write window whose close timed out is closed by `handoff`, a running specialist is named, a stale window file is cleaned at
// CODE_DONE, the hook retries a close on a lock timeout, and a resumed specialist without a new submit gets a metrics row and a ledger event.
// Real hooks and the real control plane; nothing waits (the retry is tested with a fake runner).
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { closeWithRetry } from '../../adapters/claude/hooks/lib/windowclose.mjs';
import { spawn } from 'node:child_process';
import { approveAsUser, passAll, refused, worker, must } from '../lib/harness.mjs';
import { Hr } from './lib.mjs';
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

test('B2: at CODE_DONE the stale window files of this run go; another run, a running specialist and a malformed registration stay', () => {
  const d = fixture();
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAll(d);
  mkdirSync(path.dirname(win(d, 'zz')), { recursive: true }); mkdirSync(path.dirname(sub(d, 'zz.run')), { recursive: true });
  /** @param {string} token @param {string | null} run @param {boolean} started */
  const plant = (token, run, started) => { writeFileSync(win(d, token), 'deadbeef\n'); if (run !== null) writeFileSync(sub(d, `${token}.run`), run); if (started) writeFileSync(sub(d, `${token}.started`), '/x.jsonl\n1\n'); };
  plant('zz', 'LC implementer\n', false);        // stale: this run, stopped
  plant('other', 'OTHER implementer\n', false);  // another run
  plant('live', 'LC implementer\n', true);       // still running
  plant('bad', 'garbage without a run\n', false); // malformed registration
  assert.ok(existsSync(win(d, 'zz')) && existsSync(sub(d, 'zz.run')));
  must(d, ['handoff', 'LC', 'CODE_DONE']);
  assert.ok(!existsSync(win(d, 'zz')) && !existsSync(sub(d, 'zz.run')), 'the stale window file survived CODE_DONE');
  assert.ok(existsSync(win(d, 'other')) && existsSync(sub(d, 'other.run')), 'the window of another run was removed');
  assert.ok(existsSync(win(d, 'live')) && existsSync(sub(d, 'live.run')), 'the window of a running specialist was removed');
  assert.ok(existsSync(win(d, 'bad')) && existsSync(sub(d, 'bad.run')), 'a malformed registration was acted on');
});

test('B11: a specialist whose stop hook never ran: the refusal names the way out, and only the user\'s tree-accept ends it', () => {
  const d = fixture();
  implement(d, 'a7');   // never stopped: the marker stays
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /specialist still running: implementer \(a7\)/);
  assert.match(r.text, /ask the USER: agent\.sh tree-inspect LC .*agent\.sh tree-accept LC/);
  refused(A(d, ['tree-accept', 'LC']), 'tree-accept without the user\'s approval', 'needs your approval');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'handoff still refused before the approval', 'specialist still running');
  approveAsUser(d, 'tree', 'approve the tree');
  must(d, ['tree-accept', 'LC']);
  const h = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.equal(h.status, 0, h.text);
  assert.ok(!existsSync(win(d, 'a7')) && !existsSync(sub(d, 'a7.run')), 'the stale registration was kept');
});

test('B2: a no-change window record of an earlier specialist is not mistaken for the close of a later one', () => {
  const d = fixture();
  subStart(d, IMPL, 'a6'); subStop(d, IMPL, 'a6', true);   // opens and closes without a change: WINDOW-1 begins and ends at the same tree
  assert.ok(existsSync(path.join(d, '.agents/runs/LC/worker-evidence/WINDOW-1.yaml')));
  implement(d, 'a8');
  rmSync(sub(d, 'a8.started'));
  const r = A(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.equal(r.status, 0, r.text);
  assert.ok(existsSync(path.join(d, '.agents/runs/LC/worker-evidence/WINDOW-2.yaml')), 'the later specialist\'s window was not recorded');
  assert.match(r.text, /closed the write window of the stopped implementer \(a8\)/);
});

test('B2: the hook calls window-close again after a lock timeout (end to end through the hook)', async () => {
  const d = fixture();
  subStart(d, IMPL, 'a9');
  const holder = spawn('sleep', ['40'], { stdio: 'ignore' });
  mkdirSync(path.join(d, '.agents/local/locks/shared.lock'), { recursive: true });
  writeFileSync(path.join(d, '.agents/local/locks/shared.lock/pid'), `${holder.pid}\n`);
  try {
    Hr(d, 'subagent-stop', JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's1', cwd: d, stop_hook_active: true, agent_type: IMPL, agent_id: 'a9', last_assistant_message: 'done' }), { env: { PROOFLINE_HOOK_LOCK_WAIT: '0' } });
  } finally { holder.kill(); rmSync(path.join(d, '.agents/local/locks/shared.lock'), { recursive: true, force: true }); }
  assert.match(readFileSync(path.join(d, '.agents/local/records/a9.txt'), 'utf8'), /window-close rejected for proofline-implementer \(after 4 tries\): .*lock timeout/, 'the hook did not try the close four times');
  assert.ok(existsSync(win(d, 'a9')), 'the window file of a failed close must stay for handoff');
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
