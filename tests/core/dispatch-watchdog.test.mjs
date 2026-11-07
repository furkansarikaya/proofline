// @ts-check
// The watchdog of the dispatcher (A226, issue #172): the runtime is a child in its own process group; TERM at the timeout, KILL after the grace; a signal to the
// dispatcher is forwarded to the group; the implementer's window bracket; nothing a stopped step started is left running. Fake runtimes: one that ignores TERM,
// one that hangs, one that exits early, one that spawns grandchildren (one of them ignoring TERM), one that records the signal it gets. The grace is 300 ms and
// the shortest step time 1 s: options of startDispatch() (a launcher test below uses the real constants and a real signal).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fixture } from './dispatch-lib.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** @param {() => boolean} cond @param {number} [ms] */
async function until(cond, ms = 15000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(20); } }
/** @param {import('./dispatch-lib.mjs').Fixture} fx @param {string} f */
const readLoc = (fx, f) => { try { return readFileSync(path.join(fx.loc, f), 'utf8'); } catch { return ''; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const windows = (fx) => { try { return readdirSync(path.join(fx.dir, '.agents/runs/LC/worker-evidence')).filter((n) => /^WINDOW-\d+\.yaml$/.test(n)); } catch { return []; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const pidOf = (fx) => Number(readLoc(fx, 'codex.pid').trim());

describe('TERM at the timeout, KILL after the grace', () => {
  test('a runtime that ignores TERM is killed after the grace: 124, and the process is gone', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    const t0 = Date.now();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ignoreterm' });
    const ms = Date.now() - t0;
    assert.equal(r.code, 124, r.err);
    assert.ok(ms >= 1250, `waited for the grace: ${ms} ms`);
    assert.ok(ms < 8000, `and no longer: ${ms} ms`);
    assert.equal(alive(pidOf(fx)), false, 'the runtime that ignored TERM was killed');
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /exit_status: "124"/);
  });
  test('a hanging runtime is stopped at the timeout: 124 within the limit plus a moment, no record', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    const t0 = Date.now();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'hang' });
    assert.equal(r.code, 124);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(alive(pidOf(fx)), false);
    assert.equal(existsSync(path.join(fx.dir, '.agents/local/submissions/d001-implementer-codex.status')), false);
    assert.match(r.err, /implementer on codex timed out after 1s/);
  });
  test('a runtime that exits early is a failure of the step (exit 1, its status in the window), never a timeout; nothing is left to stop', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 30 });
    const t0 = Date.now();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'early' });
    assert.equal(r.code, 1);
    assert.ok(Date.now() - t0 < 5000, 'no waiting for the limit');
    assert.match(r.err, /failed \(exit 3\)/);
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /exit_status: "3"/);
    assert.equal(existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/RESUME-implementer.md')), false, 'no resume note without a timeout');
  });
  test('grandchildren are stopped with it: the whole group gets TERM, and the one that ignores TERM is killed after the grace', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'grandchildren' });
    assert.equal(r.code, 124, r.err);
    const pids = readLoc(fx, 'grandchildren.pids').split('\n').filter(Boolean).map(Number);
    assert.equal(pids.length, 2, 'both grandchildren started');
    assert.deepEqual(pids.filter(alive), [], 'none of the grandchildren survived');
    assert.equal(alive(pidOf(fx)), false);
  });
  test('the runtime runs in a process group of its own, led by its guardian (a signal to the dispatcher\'s group does not reach it by itself)', async () => {
    const fx = fixture();
    const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'hang' }, {});
    await until(() => pidOf(fx) > 0);
    const pgid = Number(pgidOf(pidOf(fx)));
    assert.notEqual(pgid, Number(pgidOf(process.pid)), 'not the dispatcher\'s group');
    assert.equal(pgid, Number(ppidOf(pidOf(fx))), 'the leader of the group is the worker\'s parent, the guardian');
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
  });
  test('a grandchild that started a session of its own is found by the descendant walk and stopped too', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'setsidchild' });
    assert.equal(r.code, 124, r.err);
    const pids = readLoc(fx, 'grandchildren.pids').split('\n').filter(Boolean).map(Number);
    assert.equal(pids.length, 1);
    assert.deepEqual(pids.filter(alive), [], 'the grandchild of its own session is gone');
  });
});

describe('a worker never outlives its dispatcher: the whole process group of the dispatcher is killed with SIGKILL (the caller\'s tool timeout, A224)', () => {
  for (const mode of ['grandchildren', 'ignoreterm', 'implementhang']) {
    test(`${mode}: the worker and its grandchildren are gone within a few seconds`, async () => {
      const fx = fixture();
      fx.setConfig({ timeout: 300 });
      // the launcher as the caller starts it: leader of its own group, so that one kill reaches the shell and the node of the dispatcher and nothing else
      const child = spawn('sh', [path.join(fx.dir, '.agents/scripts/dispatch.sh'), 'LC', 'implementer'], { cwd: fx.dir, env: { ...fx.env, FAKE_CODEX: mode }, detached: true, stdio: 'ignore' });
      await until(() => pidOf(fx) > 0 && (mode !== 'grandchildren' || readLoc(fx, 'grandchildren.pids').split('\n').filter(Boolean).length === 2));
      const all = [pidOf(fx), ...readLoc(fx, 'grandchildren.pids').split('\n').filter(Boolean).map(Number)];
      assert.ok(all.every(alive), 'they run before the kill');
      process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
      await until(() => !all.some(alive), 6000);
      assert.deepEqual(all.filter(alive), []);
      assert.deepEqual(windows(fx), [], 'no post-step check ran: the window stays open and the edits unattested (the A224 recovery applies)');
    });
  }
});

/** The process group id of a pid, through ps. @param {number} pid */
const pgidOf = (pid) => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
/** @param {number} pid */
const ppidOf = (pid) => spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

describe('a signal to the dispatcher (HUP, INT, TERM) is forwarded to the worker\'s group', () => {
  for (const sig of /** @type {const} */ (['SIGHUP', 'SIGINT', 'SIGTERM'])) {
    test(`${sig}: the worker receives that signal, the dispatcher waits for it, ledgers the interruption, writes the resume note and exits 143`, async () => {
      const fx = fixture();
      fx.setConfig({ timeout: 30 });
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'recordsig' }, {});
      await until(() => pidOf(fx) > 0 && existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-implementer-codex.running')));
      await sleep(150);
      h.interrupt(sig);
      assert.equal(await h.done, 143);
      assert.equal(readLoc(fx, 'got.sig').trim(), sig.slice(3), 'the worker got the same signal');
      assert.equal(alive(pidOf(fx)), false);
      assert.match(fx.ledger(), new RegExp(`dispatch interrupted signal=${sig.slice(3)} role=implementer runtime=codex attempt=1`));
      assert.match(fx.runFile('dispatch/RESUME-implementer.md'), new RegExp(`^interrupted_at: \\S+ \\(${sig.slice(3)} to the dispatch after attempt 1, runtime codex: stopped from outside; no timeout\\)$`, 'm'));
      assert.equal(existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-implementer-codex.running')), false, 'the marker is removed');
      assert.match(h.err(), /stopped by/);
      const metrics = readFileSync(path.join(fx.dir, '.agents/local/metrics/records.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"kind":"dispatch"')).slice(-1)[0];
      assert.match(metrics, /"result":"failed"/);
    });
  }
  test('a stopped implementer\'s window is NOT closed: its edits stay unattested, the next dispatch is refused with the recovery (A224, the user has not decided otherwise)', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 30 });
    const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'implementhang' }, {});
    await until(() => pidOf(fx) > 0);
    await sleep(100);
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.deepEqual(windows(fx), [], 'no window was recorded: the partial edits are not attributed to anyone');
    assert.match(readFileSync(path.join(fx.dir, 'impl.txt'), 'utf8'), /work in progress/);
    assert.match(h.err(), /write window of the implementer was NOT closed[^]*tree-inspect LC/);
    const again = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ok' });
    assert.equal(again.code, 1);
    assert.match(again.err, /window-open refused; implementer not started/);
    assert.match(again.err, /tree-inspect LC/);
  });
  test('with the decision taken the other way the window closes after the worker has exited, with the signal status (an option, off by default)', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 30 });
    const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'implementhang' }, { closeWindowOnSignal: true });
    await until(() => pidOf(fx) > 0);
    await sleep(100);
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.equal(alive(pidOf(fx)), false);
    assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /exit_status: "143"/);
  });
  test('stopping a dispatch also stops the worker of its failover: Claude hits its limit, the Codex worker runs, the dispatch is stopped, the Codex worker is gone', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 30 });
    const h = fx.start(['LC', 'reviewer'], { FAKE_CLAUDE: 'limit', FAKE_CODEX: 'recordsig' }, {});
    await until(() => pidOf(fx) > 0 && /failover from=claude to=codex/.test(safeLedger(fx)));
    await sleep(150);
    assert.equal(alive(pidOf(fx)), true, 'the failover worker is running before the dispatch is stopped');
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.equal(alive(pidOf(fx)), false);
    assert.equal(readLoc(fx, 'got.sig').trim(), 'TERM');
  });
  test('a signal while the dispatcher waits to retry a dropped connection ends the wait: 143, no further attempt', async () => {
    const fx = fixture();
    fx.setConfig({ backoff: 30 });
    const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'flaky' }, {});
    await until(() => /dispatch network retry 1\/3/.test(safeLedger(fx)));
    h.interrupt('SIGTERM');
    const t0 = Date.now();
    assert.equal(await h.done, 143);
    assert.ok(Date.now() - t0 < 3000, 'the wait did not run to its end');
    assert.equal(readLoc(fx, 'attempts').trim(), '1');
  });
});

/** @param {import('./dispatch-lib.mjs').Fixture} fx */
function safeLedger(fx) { try { return fx.ledger(); } catch { return ''; } }

describe('the launcher (dispatch.sh) as a process: real signals, real constants', () => {
  test('TERM to the process: the worker is stopped, the exit status is 143, the interruption is ledgered', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 300 });
    const child = spawn('sh', [path.join(fx.dir, '.agents/scripts/dispatch.sh'), 'LC', 'implementer'], { cwd: fx.dir, env: { ...fx.env, FAKE_CODEX: 'recordsig' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })));
    await until(() => pidOf(fx) > 0);
    await sleep(200);
    child.kill('SIGTERM');
    const r = /** @type {{ code: number | null, signal: string | null }} */ (await exited);
    assert.deepEqual(r, { code: 143, signal: null }, stderr);
    assert.equal(readLoc(fx, 'got.sig').trim(), 'TERM');
    assert.equal(alive(pidOf(fx)), false);
    assert.match(fx.ledger(), /dispatch interrupted signal=TERM/);
  });
  test('a normal dispatch through the launcher: exit 0, the submitted line on stdout', () => {
    const fx = fixture();
    const r = fx.launch(['LC', 'reviewer', '--runtime', 'claude']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /^submitted: LC reviewer PASS/);
  });
  test('the launcher is a launcher: one exec line, no logic of its own', () => {
    const text = readFileSync(path.join(import.meta.dirname, '../../control-plane/agents/scripts/dispatch.sh'), 'utf8');
    const code = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    assert.deepEqual(code, ['exec node "$(dirname "$0")/proofline-core.mjs" dispatch "$@"']);
  });
});

