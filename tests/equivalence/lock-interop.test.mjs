// @ts-check
// Lock interop (issue #166): an old-engine and a new-engine process contend for the same lock and exclude each other, and a stale lock is broken
// with the same `lock-break` ledger event. The (sh, sh) pair always runs: it proves the harness against the 0.0.40 shell. The pairs that use the
// Node engine are skipped only while proofline-core.mjs is absent.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseEnv, copyTree, coreAbsent, scaffoldFixture, SKIP_NO_CORE } from './fixture.mjs';
import { compareSides, DEFAULT_SIDE, SH_SIDE, runSide } from './rig.mjs';

/** @typedef {'sh'|'default'} Engine */
const PAIRS = /** @type {[Engine, Engine][]} */ ([['sh', 'sh'], ['sh', 'default'], ['default', 'sh']]);
const needsNode = (/** @type {[Engine, Engine]} */ p) => p.includes('default');
const envFor = (/** @type {string} */ home, /** @type {Engine} */ e, /** @type {Record<string,string>} */ extra = {}) => baseEnv(home, { ...(e === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), ...extra });

/** Start `agent.sh ...args` and resolve with its result when it ends. */
function start(/** @type {string} */ cwd, /** @type {Record<string,string>} */ env, /** @type {string[]} */ args) {
  const t0 = Date.now(); const p = spawn('sh', ['./.agents/scripts/agent.sh', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((r) => p.on('close', (code) => r({ code, stdout, stderr, ms: Date.now() - t0, endedAt: Date.now() })));
  return { p, done: /** @type {Promise<{ code: number|null, stdout: string, stderr: string, ms: number, endedAt: number }>} */ (done) };
}
const waitFor = async (/** @type {() => boolean} */ f, ms = 20000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout waiting for the lock'); await new Promise((r) => setTimeout(r, 50)); } };

for (const pair of PAIRS) {
  const [holder, contender] = pair;
  test(`lock exclusion: a ${holder}-engine holder and a ${contender}-engine contender exclude each other`, { skip: needsNode(pair) && coreAbsent() ? SKIP_NO_CORE : false, timeout: 120000 }, async () => {
    const base = mkdtempSync(join(tmpdir(), 'eq-lock.')); const fx = join(base, 'fx'); copyTree(scaffoldFixture().dir, fx);
    // a suite that takes a few seconds: `agent.sh test` holds the shared lock for its whole duration
    writeFileSync(join(fx, '.agents/scripts/zz-hold-test.sh'), '#!/bin/sh\nsleep 4\n'); chmodSync(join(fx, '.agents/scripts/zz-hold-test.sh'), 0o755);
    const h = start(fx, envFor(base, holder), ['test']);
    await waitFor(() => existsSync(join(fx, '.agents/local/locks/shared.lock/pid')));
    const holderPid = readFileSync(join(fx, '.agents/local/locks/shared.lock/pid'), 'utf8').trim();
    assert.match(holderPid, /^\d+$/);
    // 1. a short wait fails with the lock-timeout message while the holder runs
    const quick = await start(fx, envFor(base, contender, { PROOFLINE_LOCK_TIMEOUT: '1' }), ['ledger-note', 'LC', 'blocked']).done;
    assert.equal(quick.code, 1); assert.match(quick.stderr, /lock timeout after 1s: .*\.lock/);
    // 2. the default wait is released when the holder ends, and the contender then runs: it ended after the holder
    const waiter = start(fx, envFor(base, contender), ['ledger-note', 'LC', 'after the holder']);
    const [hr, wr] = await Promise.all([h.done, waiter.done]);
    assert.equal(hr.code, 0, hr.stderr); assert.equal(wr.code, 0, wr.stderr);
    assert.ok(wr.endedAt >= hr.endedAt - 50, 'the contender finished while the holder still held the lock');
    assert.ok(!existsSync(join(fx, '.agents/local/locks/shared.lock')), 'the lock is released');
    const ledger = readFileSync(join(fx, '.agents/runs/LC/LEDGER.log'), 'utf8');
    assert.match(ledger, /event=note .*detail=after the holder/); assert.doesNotMatch(ledger, /detail=blocked/);
    rmSync(base, { recursive: true, force: true });
  });
}

const deadPid = (() => { const r = spawnSync('sh', ['-c', 'echo $$']); return Number(String(r.stdout).trim()); })();

test('a stale run lock is broken with the same lock-break ledger event on both engines', { skip: coreAbsent() ? `${SKIP_NO_CORE}; the sh engine alone is checked below` : false }, () => {
  const fixture = scaffoldFixture();
  /** @type {import('./rig.mjs').Step[]} */
  const steps = [{ exec: ['mkdir', '-p', '.agents/runs/LC/.lock'] }, { write: { path: '.agents/runs/LC/.lock/pid', content: `${deadPid}\n` } }, { args: ['ledger-note', 'LC', 'after a stale lock'] }];
  const c = { name: 'stale lock', fixture, steps };
  const a = runSide(c, SH_SIDE); const b = runSide(c, DEFAULT_SIDE);
  for (const [name, s] of /** @type {[string, import('./normalise.mjs').Side][]} */ ([['sh', a], ['default', b]])) {
    assert.equal(s.outputs[1].code, 0, `${name}: ${s.outputs[1].stderr}`);
    const ledger = String(s.files.get('.agents/runs/LC/LEDGER.log')?.data);
    assert.match(ledger, new RegExp(`event=lock-break .* detail=stale lock holder pid=${deadPid}\\n`), `${name}: no lock-break event`);
    assert.ok(!s.files.has('.agents/runs/LC/.lock/pid'), `${name}: the lock is released`);
  }
  assert.deepEqual(compareSides(a, b), []);
});

test('the 0.0.40 shell breaks a stale run lock with a lock-break event (harness check for the sh engine)', () => {
  const s = runSide({ name: 'stale', fixture: scaffoldFixture(), steps: [{ exec: ['mkdir', '-p', '.agents/runs/LC/.lock'] }, { write: { path: '.agents/runs/LC/.lock/pid', content: `${deadPid}\n` } }, { args: ['ledger-note', 'LC', 'x'] }] }, SH_SIDE);
  assert.equal(s.outputs[1].code, 0); assert.match(String(s.files.get('.agents/runs/LC/LEDGER.log')?.data), new RegExp(`event=lock-break .* detail=stale lock holder pid=${deadPid}\\n`));
});
