// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import { readFileSync } from 'node:fs';
import { BUDGET_STATUS, approvalStopLogLine, approvalTimeoutMessage, hkCfgNum, hookTimeLine, nextTimeoutNote, runWithBudget, withBudget } from '../../control-plane/agents/scripts/core/budget.mjs';

const node = process.execPath;
/** @param {number} ms */ const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** @param {number} pid */ const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('withBudget', () => {
  test('a step that finishes inside the budget returns its value', async () => {
    const r = await withBudget(5, async () => 42);
    assert.deepEqual(r, { timedOut: false, value: 42 });
  });
  test('a step that outlives the budget is aborted and reported as status 124', async () => {
    let aborted = false;
    const r = await withBudget(0.05, (signal) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve('late'); }); }));
    assert.deepEqual(r, { timedOut: true, status: 124 });
    assert.equal(BUDGET_STATUS, 124);
    assert.ok(aborted);
  });
  test('a step that ignores the abort is not waited for beyond the grace', async () => {
    const t0 = Date.now();
    const r = await withBudget(0.02, () => sleep(60000).then(() => 1).catch(() => 0).then(() => 1));
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 10000);
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
  test('the grandchild is gone after a stop (pid read from a file the child wrote)', async () => {
    const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'pl-budget-'));
    const f = path.join(dir, 'pid');
    try {
      const code = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
        const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 600000)'], { stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(f)}, String(g.pid)); setTimeout(()=>{}, 600000);`;
      const r = await runWithBudget(1.5, node, ['-e', code]);
      assert.equal(r.timedOut, true);
      assert.ok(existsSync(f), 'the child started its helper before the budget ended');
      const pid = Number(readFileSync(f, 'utf8'));
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(50);
      assert.equal(alive(pid), false, 'the helper process survived the stop');
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

describe('hkCfgNum against the shell function it replaces', () => {
  const hook = readFileSync(new URL('../../adapters/claude/hooks/proofline-hook.sh', import.meta.url), 'utf8').split('\n');
  const start = hook.findIndex((l) => l.startsWith('hk_cfgnum() {'));
  const end = hook.findIndex((l, i) => i > start && l === '}');
  const fn = hook.slice(start, end + 1).join('\n');
  /** @param {string} text @param {number} def @param {number} min @param {number} max */
  function shell(text, def, min, max) {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = fsSync;
    const dir = mkdtempSync(`${process.env.TMPDIR || '/tmp'}/pl-cfgnum-`);
    try {
      mkdirSync(`${dir}/.agents`); writeFileSync(`${dir}/.agents/config.yaml`, text);
      const r = spawnSync('sh', ['-c', `root=$1\n${fn}\nhk_cfgnum k "$2" "$3" "$4"; printf %s "$hk_cv"`, 'sh', dir, String(def), String(min), String(max)], { encoding: 'utf8' });
      return r.stdout;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  test('the same number for a table of config texts', () => {
    const texts = ['', 'hook:\n  k: 12\n', 'hook:\n  k: 2\n', 'hook:\n  k: 99\n', 'hook:\n  k: 08\n', 'hook:\n  k: 000\n', 'hook:\n  k: "15" # c\n', 'hook:\n  k:\t 11 \n',
      'hook:\n  k: abc\n', 'hook:\n  k: -3\n', 'hook:\n  k: 1.5\n', 'hook:\n  k: 123456\n', 'hook:\n  k: 12\r\n', 'hook:\n  k:\n', 'x:\n  k: 9\n', 'hook:\n  k: 9\n  k: 11\n',
      'hook:\n  k: 9\n  k: x\n', 'hook:\n    k: 9\n', 'hook:\n  k: 9\n# c\n  k: 13\nnext:\n  k: 7\n', 'hook:\n  k: 17', 'hook: {}\n  k: 6\n', 'hook:\n\n  k: 7\n', 'hook:\n  k: 007\n', 'hook:\n  k: 00000012\n'];
    for (const t of texts) assert.equal(String(hkCfgNum(t, 'k', 20, 5, 25)), shell(t, 20, 5, 25), JSON.stringify(t));
  });
});
