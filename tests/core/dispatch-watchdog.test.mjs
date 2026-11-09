// @ts-check
// The watchdog of the dispatcher (A226, issue #172): the runtime is a child in its own process group; TERM at the timeout, KILL after the grace; a signal to the
// dispatcher is forwarded to the group; the implementer's window bracket; nothing a stopped step started is left running. A dispatch killed from outside closes the
// implementer's write window (user decision of 2026-11-07): by itself after TERM, HUP and INT, and through the guardian's closer after a SIGKILL of its group. Fake runtimes: one that ignores TERM,
// one that hangs, one that exits early, one that spawns grandchildren (one of them ignoring TERM), one that records the signal it gets. No test depends on elapsed time
// (decision 4 of 2026-11-08): the limit and the grace are timers held and fired by the test when the event they are about is true (see heldClock), and every other wait is
// for a pid, a marker file or a process that has gone.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fixture } from './dispatch-lib.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Nothing here asserts how long anything took (decision 4 of 2026-11-08): a wait is for an event (a pid, a marker file, a process gone), and ONLY its failsafe is a time.
const FAILSAFE = 120000;
/** @param {() => boolean} cond @param {number} [ms] the failsafe: a wait that never ends fails instead of hanging */
async function until(cond, ms = FAILSAFE) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(20); } }
/** @param {import('./dispatch-lib.mjs').Fixture} fx @param {string} f */
const readLoc = (fx, f) => { try { return readFileSync(path.join(fx.loc, f), 'utf8'); } catch { return ''; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const windows = (fx) => { try { return readdirSync(path.join(fx.dir, '.agents/runs/LC/worker-evidence')).filter((n) => /^WINDOW-\d+\.yaml$/.test(n)); } catch { return []; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const pidOf = (fx) => Number(readLoc(fx, 'codex.pid').trim());
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const grandPids = (fx) => readLoc(fx, 'grandchildren.pids').split('\n').filter(Boolean).map(Number);
/** The fake worker has set its traps (recordsig). @param {import('./dispatch-lib.mjs').Fixture} fx */
const ready = (fx) => readLoc(fx, 'codex.ready').trim() === 'ready';
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
function safeLedger(fx) { try { return fx.ledger(); } catch { return ''; } }
/** The command lines of every process. */
const commands = () => spawnSync('ps', ['-A', '-ww', '-o', 'command='], { encoding: 'utf8' }).stdout.split('\n');
/** The closers (the process that closes a killed implementer's window) still running for the process group PGID. @param {number} pgid */
const closersOf = (pgid) => commands().filter((c) => c.includes(`guardian.mjs --closer ${pgid} `)).length;
/** The guardians of this very dispatcher still running. */
const guardiansHere = () => commands().filter((c) => c.includes(`guardian.mjs ${process.pid} `)).length;

// The clock of the watchdog. The step limit and the grace between TERM and KILL are timers of the dispatcher; a test must not depend on how long a loaded machine takes to
// start a worker or to deliver a signal, so it gives them values that no other timer has (a limit of LIMIT_S seconds, a grace of GRACE_MS) and holds exactly those two kinds of
// timer: they are fired by the test, when the event they are about is true (the worker is up and has its traps set; the TERM has reached it), in that order. The code that
// runs when they fire is the dispatcher's own; only the passing of time is replaced. Every other timer is the real one.
const LIMIT_S = 777;
const LIMIT_MS = LIMIT_S * 1000;
const GRACE_MS = 4242;
/** @typedef {{ ms: number, fn: (...a: unknown[]) => void, args: unknown[], fired: boolean }} Held */
function heldClock() {
  const real = globalThis.setTimeout;
  /** @type {Held[]} */ const held = [];
  /** @type {any} */ (globalThis).setTimeout = (/** @type {(...a: unknown[]) => void} */ fn, /** @type {number} */ ms, /** @type {unknown[]} */ ...args) => {
    if (ms === LIMIT_MS || (typeof ms === 'number' && ms > 3000 && ms <= GRACE_MS)) {
      held.push({ ms, fn, args, fired: false });
      const handle = { ref() { return handle; }, unref() { return handle; }, hasRef() { return false; }, refresh() { return handle; }, close() { return handle; }, [Symbol.toPrimitive]() { return -1; } };
      return handle;
    }
    return real(fn, ms, ...args);
  };
  return {
    /** the step limit's timer, once the dispatcher has set it */
    limit: () => held.find((t) => t.ms === LIMIT_MS),
    /** the timers of the grace between TERM and KILL */
    graces: () => held.filter((t) => t.ms !== LIMIT_MS),
    /** @param {Held | undefined} t */
    fire(t) { if (t && !t.fired) { t.fired = true; t.fn(...t.args); } },
    restore() { globalThis.setTimeout = real; },
  };
}
/** The grace has run out (fired as soon as the dispatcher has set it, in as many rounds as it takes) and the dispatch ends. @param {ReturnType<typeof heldClock>} clk @param {{ done: Promise<number> }} h */
async function finish(clk, h) {
  let over = false;
  const code = h.done.then((c) => { over = true; return c; });
  const t0 = Date.now();
  while (!over) { if (Date.now() - t0 > FAILSAFE) throw new Error('the dispatch did not end'); for (const t of clk.graces()) clk.fire(t); await Promise.race([code, sleep(20)]); }
  return code;
}

describe('TERM at the timeout, KILL after the grace', () => {
  test('a runtime that ignores TERM is killed after the grace: 124, and the process is gone', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: LIMIT_S });
    const clk = heldClock();
    try {
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'ignoreterm' }, { graceMs: GRACE_MS });
      await until(() => pidOf(fx) > 0 && clk.limit() !== undefined);   // the worker is up with its trap set, and the dispatcher has started the clock of the limit
      assert.equal(clk.limit()?.ms, LIMIT_MS, 'the limit is the configured number of seconds');
      const pid = pidOf(fx);
      assert.equal(alive(pid), true);
      clk.fire(clk.limit());                                  // the limit is reached
      await until(() => readLoc(fx, 'term.log').trim() !== '');   // 1. the TERM reached the worker ...
      assert.equal(alive(pid), true, 'it ignored the TERM: it is still running, nothing killed it before the grace is over');
      assert.ok(clk.graces().some((t) => t.ms === GRACE_MS && !t.fired), 'the KILL waits for the grace');
      const code = await finish(clk, h);                       // 2. ... and only the end of the grace kills it
      assert.equal(code, 124, h.err());
      assert.equal(alive(pid), false, 'the runtime that ignored TERM was killed');
      assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /exit_status: "124"/);
    } finally { clk.restore(); }
  });
  test('a hanging runtime is stopped at the timeout: 124, no record', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: LIMIT_S });
    const clk = heldClock();
    try {
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'hang' }, {});
      await until(() => pidOf(fx) > 0 && clk.limit() !== undefined);
      assert.equal(alive(pidOf(fx)), true, 'it hangs: nothing stops it before the limit');
      clk.fire(clk.limit());
      assert.equal(await finish(clk, h), 124);
      assert.equal(alive(pidOf(fx)), false);
      assert.equal(existsSync(path.join(fx.dir, '.agents/local/submissions/d001-implementer-codex.status')), false);
      assert.match(h.err(), new RegExp(`implementer on codex timed out after ${LIMIT_S}s`));
    } finally { clk.restore(); }
  });
  test('a runtime that exits early is a failure of the step (exit 1, its status in the window), never a timeout; nothing is left to stop', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'early' });
    assert.equal(r.code, 1, 'the status of a failure, not 124 (a timeout)');
    assert.doesNotMatch(r.err, /timed out/);
    assert.match(r.err, /failed \(exit 3\)/);
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /exit_status: "3"/);
    assert.equal(existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/RESUME-implementer.md')), false, 'no resume note without a timeout');
    assert.equal(guardiansHere(), 0, 'nothing is left to stop');
  });
  test('grandchildren are stopped with it: the whole group gets TERM, and the one that ignores TERM is killed after the grace', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: LIMIT_S });
    const clk = heldClock();
    try {
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'grandchildren' }, { graceMs: GRACE_MS });
      await until(() => pidOf(fx) > 0 && grandPids(fx).length === 2 && clk.limit() !== undefined);
      const pids = grandPids(fx);
      assert.equal(pids.length, 2, 'both grandchildren started');
      clk.fire(clk.limit());
      await until(() => readLoc(fx, 'term.log').trim() !== '');   // the grandchild that ignores TERM has been sent one ...
      const stubborn = Number(readLoc(fx, 'term.log').split('\n')[0]);
      assert.ok(pids.includes(stubborn), 'it is one of the grandchildren');
      assert.equal(alive(stubborn), true, '... and is still running: only the end of the grace kills it');
      const code = await finish(clk, h);
      assert.equal(code, 124, h.err());
      assert.deepEqual(pids.filter(alive), [], 'none of the grandchildren survived');
      assert.equal(alive(pidOf(fx)), false);
    } finally { clk.restore(); }
  });
  test('the runtime runs in a process group of its own, led by its guardian (a signal to the dispatcher\'s group does not reach it by itself)', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
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
    fx.setConfig({ timeout: LIMIT_S });
    const clk = heldClock();
    try {
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'setsidchild' }, {});
      await until(() => pidOf(fx) > 0 && grandPids(fx).length === 1 && clk.limit() !== undefined);
      const pids = grandPids(fx);
      assert.equal(alive(pids[0]), true);
      clk.fire(clk.limit());
      assert.equal(await finish(clk, h), 124, h.err());
      assert.equal(pids.length, 1);
      assert.deepEqual(pids.filter(alive), [], 'the grandchild of its own session is gone');
    } finally { clk.restore(); }
  });
});

describe('a worker never outlives its dispatcher: the whole process group of the dispatcher is killed with SIGKILL (the caller\'s tool timeout, A224)', () => {
  /** The launcher as the caller starts it: leader of its own group, so that one kill reaches the shell and the node of the dispatcher and nothing else. @param {import('./dispatch-lib.mjs').Fixture} fx @param {string[]} args @param {Record<string, string>} env */
  const launcher = (fx, args, env) => spawn('sh', [path.join(fx.dir, '.agents/scripts/dispatch.sh'), ...args], { cwd: fx.dir, env: { ...fx.env, ...env }, detached: true, stdio: 'ignore' });
  /** @param {import('./dispatch-lib.mjs').Fixture} fx */
  const workerPids = (fx) => [pidOf(fx), ...grandPids(fx)];
  for (const mode of ['grandchildren', 'ignoreterm', 'implementhang', 'implementgrand']) {
    test(`${mode}: the worker and its grandchildren are gone within a few seconds, and the implementer's window is then closed by the guardian (status 137, exactly once)`, async () => {
      const fx = fixture();
      fx.setConfig({ timeout: 3600 });
      const child = launcher(fx, ['LC', 'implementer'], { FAKE_CODEX: mode });
      await until(() => pidOf(fx) > 0 && (mode !== 'grandchildren' || grandPids(fx).length === 2) && (mode !== 'implementgrand' || grandPids(fx).length === 1));
      const all = workerPids(fx);
      assert.ok(all.every(alive), 'they run before the kill');
      process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
      // the window record appears only AFTER the whole group is dead: when it exists, nothing of the worker is left that could still write
      await until(() => windows(fx).length > 0);
      assert.deepEqual(all.filter(alive), [], 'a process of the worker was still alive when the window was closed');
      assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
      assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /^role: "implementer"$[^]*^exit_status: "137"$/m);
      if (mode === 'implementgrand') {
        const size = () => readFileSync(path.join(fx.dir, 'impl.txt'), 'utf8').length;
        const before = size();   // every process of the worker is dead (above): nothing can change the tree from here on
        assert.equal(size(), before, 'the tree changed after the window was closed');
        const open = spawnSync('sh', [path.join(fx.dir, '.agents/scripts/agent.sh'), 'window-open', 'LC', 'implementer'], { cwd: fx.dir, env: fx.env, encoding: 'utf8' });
        assert.equal(open.status, 0, open.stderr);
        assert.equal(open.stdout.trim(), /after_sha256: "([0-9a-f]+)"/.exec(fx.runFile('worker-evidence/WINDOW-1.yaml'))?.[1], 'the recorded tree is the tree on disk: the next window opens on it');
      }
      await until(() => /dispatch killed from outside role=implementer/.test(safeLedger(fx)));
      await until(() => closersOf(/** @type {number} */ (child.pid)) === 0);   // the closer has done its work and is gone: a second closing would have happened by now
      assert.deepEqual(windows(fx), ['WINDOW-1.yaml'], 'closed exactly once');
      assert.equal((fx.ledger().match(/dispatch killed from outside/g) ?? []).length, 1);
      assert.match(fx.ledger(), /the dispatcher got SIGKILL \(no handler ran\); the worker group is dead and the write window was closed by the guardian/);
    });
  }
  test('a role without a write window (a reviewer) killed the same way: the worker is gone, no window is opened or closed, nothing is ledgered by a closer', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const child = launcher(fx, ['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'hang' });
    await until(() => pidOf(fx) > 0);
    const pid = pidOf(fx);
    const guardian = Number(ppidOf(pid));
    assert.ok(guardian > 1 && alive(guardian), 'the guardian leads the worker\'s group');
    process.kill(-(/** @type {number} */ (child.pid)), 'SIGKILL');
    await until(() => !alive(pid) && !alive(guardian));   // the whole group is gone; a reviewer has no window, so there is no closer that could still act
    assert.equal(closersOf(guardian), 0);
    assert.deepEqual(windows(fx), []);
    assert.doesNotMatch(safeLedger(fx), /killed from outside/);
  });
  test('a window that was already closed is not closed again: a kill after the step ended finds no guardian (the worker has exited)', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'implement' });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
    await until(() => guardiansHere() === 0);   // the guardian ended with the worker, and no closer was started
    assert.equal(commands().filter((c) => c.includes('guardian.mjs --closer ')).length, 0, 'no closer was started');
    assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
    assert.doesNotMatch(safeLedger(fx), /killed from outside/);
  });
});

/** The process group id of a pid, through ps. @param {number} pid */
const pgidOf = (pid) => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
/** @param {number} pid */
const ppidOf = (pid) => spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();

describe('a signal to the dispatcher (HUP, INT, TERM) is forwarded to the worker\'s group', () => {
  for (const sig of /** @type {const} */ (['SIGHUP', 'SIGINT', 'SIGTERM'])) {
    test(`${sig}: the worker receives that signal, the dispatcher waits for it, ledgers the interruption, writes the resume note and exits 143`, async () => {
      const fx = fixture();
      fx.setConfig({ timeout: 3600 });
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'recordsig' }, {});
      await until(() => ready(fx) && existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-implementer-codex.running')));
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
  for (const [sig, status] of /** @type {const} */ ([['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]])) {
    test(`${sig}: a stopped implementer's window is CLOSED after the worker has exited, with status ${status}; its partial edits are the implementer's and the next dispatch continues the step (user decision of 2026-11-07)`, async () => {
      const fx = fixture();
      fx.setConfig({ timeout: 3600 });
      const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'implementhang' });
      await until(() => pidOf(fx) > 0);   // the edit is made before the pid is written
      const pid = pidOf(fx);
      h.interrupt(sig);
      assert.equal(await h.done, 143);
      assert.equal(alive(pid), false, 'the worker is gone');
      assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
      assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), new RegExp(`^role: "implementer"$[^]*^exit_status: "${status}"$`, 'm'));
      assert.match(readFileSync(path.join(fx.dir, 'impl.txt'), 'utf8'), /work in progress/, 'the edit stays in the tree');
      assert.match(fx.ledger(), new RegExp(`dispatch interrupted signal=${sig.slice(3)} role=implementer`));
      assert.match(fx.runFile('dispatch/RESUME-implementer.md'), /^interrupted_at: /m);
      assert.match(h.err(), new RegExp(`write window of the implementer was closed with status ${status}`));
      const again = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ok' });
      assert.doesNotMatch(again.err, /window-open refused/, 'the next dispatch is not refused');
      assert.deepEqual(windows(fx), ['WINDOW-1.yaml', 'WINDOW-2.yaml']);
    });
  }
  test('closing the window attests nothing the gates do not judge: the handoff to IMPLEMENTED is still refused by the scope and evidence checks', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'implementhang' });
    await until(() => pidOf(fx) > 0);
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
    const r = spawnSync('sh', [path.join(fx.dir, '.agents/scripts/agent.sh'), 'handoff', 'LC', 'IMPLEMENTED'], { cwd: fx.dir, env: fx.env, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'the handoff accepted an edit without evidence: ' + r.stdout);
    assert.match(r.stderr + r.stdout, /unexpected or unmapped task-introduced paths|worker evidence|RED|GREEN/i, 'a handoff gate (scope or worker evidence) judged the content');
  });
  test('a reviewer stopped by TERM has no window: nothing is opened or closed and the text does not mention one', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const h = fx.start(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'recordsig' });
    await until(() => ready(fx));
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.deepEqual(windows(fx), []);
    assert.doesNotMatch(h.err(), /write window/);
  });
  test('stopping a dispatch also stops the worker of its failover: Claude hits its limit, the Codex worker runs, the dispatch is stopped, the Codex worker is gone', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const h = fx.start(['LC', 'reviewer'], { FAKE_CLAUDE: 'limit', FAKE_CODEX: 'recordsig' }, {});
    await until(() => ready(fx) && /failover from=claude to=codex/.test(safeLedger(fx)));
    assert.equal(alive(pidOf(fx)), true, 'the failover worker is running before the dispatch is stopped');
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.equal(alive(pidOf(fx)), false);
    assert.equal(readLoc(fx, 'got.sig').trim(), 'TERM');
  });
  test('a signal while the dispatcher waits to retry a dropped connection ends the wait: 143, no further attempt', async () => {
    const fx = fixture();
    fx.setConfig({ backoff: 3600 });   // a wait that no test machine gets to the end of: if the signal did not end it, this test would hang to its failsafe
    const h = fx.start(['LC', 'implementer'], { FAKE_CODEX: 'flaky' }, {});
    await until(() => /dispatch network retry 1\/3/.test(safeLedger(fx)));
    h.interrupt('SIGTERM');
    assert.equal(await h.done, 143);
    assert.equal(readLoc(fx, 'attempts').trim(), '1', 'no further attempt: the wait ended with the signal');
  }, { timeout: FAILSAFE });
});

describe('the launcher (dispatch.sh) as a process: real signals, real constants', () => {
  test('TERM to the process: the worker is stopped, the exit status is 143, the interruption is ledgered', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 3600 });
    const child = spawn('sh', [path.join(fx.dir, '.agents/scripts/dispatch.sh'), 'LC', 'implementer'], { cwd: fx.dir, env: { ...fx.env, FAKE_CODEX: 'recordsig' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((res) => child.on('close', (code, signal) => res({ code, signal })));
    await until(() => ready(fx));
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

