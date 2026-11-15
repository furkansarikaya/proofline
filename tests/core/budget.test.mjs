// @ts-check
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import { readFileSync } from 'node:fs';
import { closed, lines, listenOnce } from './event-lib.mjs';
import { BUDGET_STATUS, SETTLE_GRACE_MS, approvalStopLogLine, approvalTimeoutMessage, hkCfgNum, hookTimeLine, nextTimeoutNote, runWithBudget, withBudget } from '../../control-plane/agents/scripts/core/budget.mjs';

const node = process.execPath;
/** The promise callbacks that follow an event have run (no timer, no wait: the chain of withBudget after its budget is a few promise hops long). */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('withBudget', () => {
  test('a step that finishes inside the budget returns its value', async () => {
    const r = await withBudget(5, async () => 42);
    assert.deepEqual(r, { timedOut: false, value: 42 });
  });
  test('a step that outlives the budget is aborted and reported as status 124', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });   // the budget is a timer the test fires, not a duration it waits for
    let aborted = false;
    /** @type {() => void} */ let up = () => {};
    const started = new Promise((r) => { up = () => r(undefined); });
    const run = withBudget(0.05, (signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve('late'); }); up(); }));
    await started;
    assert.equal(aborted, false, 'nothing aborts the step before the budget is over');
    t.mock.timers.tick(50);
    assert.deepEqual(await run, { timedOut: true, status: 124 });
    assert.equal(BUDGET_STATUS, 124);
    assert.ok(aborted);
  });
  test('a step that ignores the abort is not waited for beyond the grace', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    /** @type {() => void} */ let up = () => {};
    const started = new Promise((r) => { up = () => r(undefined); });
    let reported = false;
    const run = withBudget(0.02, () => { up(); return new Promise(() => {}); }).then((r) => { reported = true; return r; });   // never settles, whatever the signal says
    await started;
    t.mock.timers.tick(20);   // the budget ends: the step is told to stop and ignores it
    await settle();
    assert.equal(reported, false, 'the result waits for the grace period');
    t.mock.timers.tick(SETTLE_GRACE_MS);   // the grace period ends: the result is reported although the step never settled
    const r = await run;
    assert.equal(r.timedOut, true);
  });
  test('a budget of zero ends at once; a step that throws in time throws', async () => {
    assert.equal((await withBudget(0, (s) => new Promise((res) => s.addEventListener('abort', () => res(1))))).timedOut, true);
    await assert.rejects(withBudget(5, async () => { throw new Error('boom'); }), /boom/);
  });
  test('no timer is left behind (the process can exit)', async () => {
    const r = spawnSync(node, ['--input-type=module', '-e', `import { withBudget } from ${JSON.stringify(new URL('../../control-plane/agents/scripts/core/budget.mjs', import.meta.url).href)}; await withBudget(600, async () => 1);`], { timeout: 20000 });
    assert.equal(r.status, 0);
  });
});

describe('runWithBudget', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, () => {
  test('exit status and output pass through inside the budget', async () => {
    const r = await runWithBudget(20, node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    assert.equal(r.timedOut, false); assert.equal(r.status, 3);
    assert.equal(r.stdout.toString(), 'out'); assert.equal(r.stderr.toString(), 'err');
  });
  test('the grandchild is gone after a stop (it reports over a socket, which the kernel closes when the process ends)', async (t) => {
    const { rmSync } = await import('node:fs');
    const dir = tempDir('pl-budget-');
    const srv = await listenOnce(dir);
    /** @type {number[]} */ const leaders = [];
    t.after(() => {   // a failed or timed-out test ends the processes it started
      if (/** @type {any} */ (t).passed === false) for (const pid of leaders) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
      void srv.close();
      rmSync(dir, { recursive: true, force: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });   // the budget is a timer the test fires once the helper is up
    // the child starts a helper in its group; the helper holds a connection to the test and tells its parent's pid. Both live as long as that connection.
    const helper = 'const s = require("node:net").connect(process.argv[1], () => s.write(process.ppid + "\\n"));';
    const code = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}, ${JSON.stringify(srv.path)}], { stdio: 'inherit' });`;
    const run = runWithBudget(1.5, node, ['-e', code]);
    const sock = await srv.first; const gone = closed(sock);
    leaders.push(Number(await lines(sock)()));
    t.mock.timers.tick(1500);   // the helper is up inside the group: now the budget ends
    const r = await run;
    assert.equal(r.timedOut, true);
    await gone;   // the helper process survived the stop: its connection would stay open and this test would end at its timeout
  });
  test('a program that is not found is status 127 inside the budget', async () => {
    const r = await runWithBudget(5, '/nonexistent/proofline-nothing', []);
    assert.equal(r.timedOut, false); assert.equal(r.status, 127);
  });
});

describe('the shell hook texts', () => {
  test('timeout messages and lines', () => {
    assert.equal(approvalTimeoutMessage(true), "proofline: your approval was recorded (the approval step ran past the hook's time budget but finished writing it).");
    assert.equal(approvalTimeoutMessage(false), 'proofline: your approval could not be recorded, send it again (the approval step ran out of time).');
    assert.equal(approvalStopLogLine('2026-01-02T03:04:05Z', 20), '2026-01-02T03:04:05Z approval step stopped after 20s (prompt hook budget)');
    assert.equal(approvalStopLogLine('2026-01-02T03:04:05Z', 7, 'LC'), '2026-01-02T03:04:05Z approval step of worktree run LC stopped after 7s (prompt hook budget)');
    assert.equal(nextTimeoutNote('T-9'), "run sh .agents/scripts/agent.sh next T-9 (the session check did not finish within the hook's time budget)");
    assert.equal(hookTimeLine(1700000000, 'prompt.approve', 25000, 'timeout', 'stopped-by-hook-budget'), '1700000000|prompt.approve|25000|timeout|stopped-by-hook-budget');
    assert.equal(hookTimeLine(1, 'stop', 5, 'ok'), '1|stop|5|ok|');
  });
});

describe('hkCfgNum (the shell hook\'s hk_cfgnum)', () => {
  const cfg = (/** @type {string} */ body) => `proofline_version: 1\nhook:\n${body}\nother:\n  approve_budget_seconds: 3\n`;
  const k = (/** @type {string|null} */ t, def = 20) => hkCfgNum(t, 'approve_budget_seconds', def, 5, 25);
  test('defaults, bounds, zeros, junk', () => {
    assert.equal(k(null), 20); assert.equal(k(''), 20); assert.equal(k(cfg('')), 20);
    assert.equal(k(cfg('  approve_budget_seconds: 12')), 12);
    assert.equal(k(cfg('  approve_budget_seconds: 2')), 5); assert.equal(k(cfg('  approve_budget_seconds: 99')), 25);
    assert.equal(k(cfg('  approve_budget_seconds: 08')), 8); assert.equal(k(cfg('  approve_budget_seconds: 000')), 5);
    assert.equal(k(cfg('  approve_budget_seconds: "15"  # note')), 15); assert.equal(k(cfg("  approve_budget_seconds:\t 11 \t")), 11);
    assert.equal(k(cfg('  approve_budget_seconds: abc')), 20); assert.equal(k(cfg('  approve_budget_seconds: -3')), 20); assert.equal(k(cfg('  approve_budget_seconds: 1.5')), 20);
    assert.equal(k(cfg('  approve_budget_seconds: 123456')), 25); assert.equal(k(cfg('  approve_budget_seconds: 99999999999999999999')), 25);
    assert.equal(k(cfg('  approve_budget_seconds: 12\r')), 20, 'a CR is not a digit');
    assert.equal(k(cfg('  approve_budget_seconds:')), 20);
  });
  test('sections, last line wins, a bad later line resets', () => {
    assert.equal(k('other:\n  approve_budget_seconds: 9\n'), 20);
    assert.equal(k('hook:\n  approve_budget_seconds: 9\n  approve_budget_seconds: 11'), 11);
    assert.equal(k('hook:\n  approve_budget_seconds: 9\n  approve_budget_seconds: x'), 20);
    assert.equal(k('hook:\n    approve_budget_seconds: 9'), 20, 'four spaces is not a key of the section');
    assert.equal(k('hook:\n  approve_budget_seconds: 9\n# comment\n  approve_budget_seconds: 13\nnext:\n  approve_budget_seconds: 7'), 13);
    assert.equal(k('hook:\n  approve_budget_seconds: 9'), 9);
    assert.equal(hkCfgNum('hook:\n  lock_wait_seconds: 30\n', 'lock_wait_seconds', 8, 1, 20), 20);
  });
});
