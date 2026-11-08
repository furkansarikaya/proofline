// @ts-check
// A202 item 28, the Node form of tests/enforcement/approval-load-test.sh (176-C): the approval record does not depend on the size of the run folder or on
// how loaded the machine is.
//  - the user's message is on disk first (one small file), before any git call, lock or scan, and survives a forced hook timeout;
//  - a timed-out approval step says "your approval could not be recorded, send it again" only when it truly was not recorded;
//  - the content fingerprint no longer reads the run folder; the big-file hash cache never reaches an integrity check;
//  - the hook time knobs are config values, validated, and kept by an upgrade;
//  - next and digest stay close to their small-run time with a large run folder (performance, relative).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, cleanEnv, newRepo, sha256, tmp } from '../lib/harness.mjs';
import { repo, scripts } from '../lib/harness.mjs';
import { editConfig, kv, shim, sleepSync, strip } from './cfg-util.mjs';
import { fixture } from './lib.mjs';

const hookPath = (/** @type {string} */ d) => path.join(d, '.agents/hooks/proofline-hook.mjs');
const msg = 'plan approved, go ahead';
const promptJson = (/** @type {string} */ d, /** @type {string} */ text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: d, prompt: text });
/** The `prompt` of the shell suite: the INSTALLED hook, no budget overrides in the environment unless given. @param {string} d @param {string} text @param {Record<string, string>} [env] */
function prompt(d, text, env = {}) {
  const r = spawnSync(process.execPath, [hookPath(d), 'prompt', 'claude'], { cwd: d, input: promptJson(d, text), encoding: 'utf8', env: cleanEnv(env), timeout: 120000 });
  return r.stdout ?? '';
}
const ms = () => Number(process.hrtime.bigint() / 1000000n);
const timed = (/** @type {() => unknown} */ f) => { const t0 = ms(); f(); return ms() - t0; };
const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const slowAdd = (/** @type {number} */ secs) => `#!/bin/sh\ncase "$*" in *" add "*) sleep ${secs} ;; esac\nexec ${gitPath} "$@"\n`;
const lsGlob = (/** @type {string} */ d, /** @type {string} */ sub, /** @type {RegExp} */ re) => { const p = path.join(d, sub); return existsSync(p) ? readdirSync(p).filter((n) => re.test(n)).map((n) => path.join(p, n)) : []; };

/** Deterministic filler files (not images, but big and distinct): DIR COUNT BYTES. @param {string} dir @param {number} count @param {number} bytes */
function bigfiles(dir, count, bytes) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    let x = BigInt(i * 7919 + 13); const parts = [];
    for (let k = 0; k < bytes / 16; k++) { x = (x * 1103515245n + 12345n) % 2147483648n; parts.push(String(x % 10000000000000000n).padStart(16, '0')); }
    writeFileSync(path.join(dir, `shot-${i}.png`), parts.join(''));
  }
}

test('fp_run_folder: the content fingerprint does not read the run folder, and still sees product changes', () => {
  const d = fixture(); writeFileSync(path.join(d, '.gitignore'), '.agents/local/\n');
  const before = strip(A(d, ['fingerprint', 'LC']).out);
  bigfiles(path.join(d, '.agents/runs/LC/reviews/visual-proof/screens'), 30, 20000);
  const after = strip(A(d, ['fingerprint', 'LC']).out);
  assert.equal(before, after, `a non-ignored run folder changed the content fingerprint (${before} then ${after})`);
  appendFileSync(path.join(d, 'impl.txt'), 'changed\n');
  assert.notEqual(strip(A(d, ['fingerprint', 'LC']).out), after, 'a product change did not change the content fingerprint');
});

test('fp_cache_integrity: a forged or stale cache never reaches a sealing fingerprint; a same-size same-mtime edit is detected', () => {
  const d = fixture();
  const impl = path.join(d, 'impl.txt');
  writeFileSync(impl, 'a'.repeat(400000));
  const r0 = A(d, ['patch-fingerprint', 'LC']); assert.equal(r0.status, 0, `patch-fingerprint failed: ${r0.text}`);
  const p0 = strip(r0.out);
  const cache = path.join(d, '.agents/local/fp-cache');
  assert.ok(existsSync(cache) && readFileSync(cache).length > 0, 'the big file was not remembered by the sealing command (cache empty)');
  // a forged cache line for the file's key must not reach a sealing command
  const key = readFileSync(cache, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split('\t')[0]).at(-1);
  appendFileSync(cache, `${key}\t${sha256('forged')}\n`);
  assert.equal(strip(A(d, ['patch-fingerprint', 'LC']).out), p0, 'a forged cache line changed a sealing fingerprint');
  // same size, same mtime, one byte different: the sealing check must see it
  const mt = path.join(tmp('mt'), 'mt');
  spawnSync('touch', ['-r', impl, mt]);
  writeFileSync(impl, `${'a'.repeat(399999)}b`);
  spawnSync('touch', ['-r', mt, impl]);
  const p1 = strip(A(d, ['patch-fingerprint', 'LC']).out);
  assert.notEqual(p1, p0, 'an edit that kept size and mtime was not detected by the sealing fingerprint');
  // the read-only path rehashes too (ctime and the key differ), so a display never shows the old hash
  A(d, ['digest', 'LC']);
  assert.equal(strip(A(d, ['patch-fingerprint', 'LC']).out), p1, 'the fingerprint changed without a file change');
});

test('hook_config_knobs: hook time knobs are validated, bounded below and above, and kept by an upgrade', () => {
  const d = newRepo(); const c = path.join(d, '.agents/config.yaml');
  const orig = readFileSync(c, 'utf8');
  assert.equal(A(d, ['config-check']).status, 0, 'the default config does not pass config-check');
  const f = path.join(d, 'cfg.tmp');
  for (const bad of ['approve_budget_seconds: 0', 'approve_budget_seconds: 99', 'approve_budget_seconds: abc', 'next_budget_seconds: 1', 'lock_wait_seconds: 0', 'lock_wait_seconds: 21', 'turbo: 1']) {
    writeFileSync(f, orig.split('\n').flatMap((l) => (/^hook:$/.test(l) ? [l, `  ${bad}`] : [l])).join('\n'));
    assert.notEqual(A(d, ['config-check', f]).status, 0, `config-check accepted hook.${bad}`);
  }
  const sub = (/** @type {string} */ t, /** @type {[string, string][]} */ ...rules) => t.split('\n').map((l) => rules.reduce((x, [a, b]) => x.replace(a, b), l)).join('\n');
  writeFileSync(f, sub(orig, ['approve_budget_seconds: 20', 'approve_budget_seconds: 12']));
  assert.equal(A(d, ['config-check', f]).status, 0, 'a valid knob value was refused');
  // an out-of-range value in a hand-edited file is moved into its bounds, never to zero
  writeFileSync(c, sub(orig, ['approve_budget_seconds: 20', 'approve_budget_seconds: 0']));
  assert.equal(kv(d, 'hook-config', 'approve_budget_seconds'), '5', 'a zero budget was not raised to the minimum');
  writeFileSync(c, sub(orig, ['lock_wait_seconds: 8', 'lock_wait_seconds: 500']));
  assert.equal(kv(d, 'hook-config', 'lock_wait_seconds'), '20', 'a huge lock wait was not cut to the maximum');
  // review A3: a leading zero is a number, never an octal arithmetic error in the hook or agent.sh
  writeFileSync(c, sub(orig, ['approve_budget_seconds: 20', 'approve_budget_seconds: 08'], ['lock_wait_seconds: 8', 'lock_wait_seconds: 09']));
  assert.equal(kv(d, 'hook-config', 'approve_budget_seconds'), '8', `approve_budget_seconds 08 is not read as 8: ${A(d, ['hook-config']).text}`);
  assert.equal(kv(d, 'hook-config', 'lock_wait_seconds'), '9', 'lock_wait_seconds 09 is not read as 9');
  assert.match(A(d, ['hook-timeouts']).text, /^prompt=/m, 'hook-timeouts failed with a leading zero');
  // upgrade: the user's value is kept, an old config without the block gets the defaults
  const core = (/** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(scripts, 'proofline-core.mjs'), 'cli', 'config', ...args], { encoding: 'utf8', env: cleanEnv({}) }).stdout;
  const shipped = path.join(repo, 'control-plane/agents/config.yaml');
  const user = path.join(d, 'user.yaml'); writeFileSync(user, sub(orig, ['approve_budget_seconds: 20', 'approve_budget_seconds: 12']));
  const merged = path.join(d, 'merged.yaml'); writeFileSync(merged, core(['merge-new', user, shipped]));
  assert.equal(strip(core(['get', merged, 'hook.approve_budget_seconds'])), '12', "upgrade did not keep the user's hook.approve_budget_seconds");
  const old = path.join(d, 'old.yaml'); writeFileSync(old, orig.split('\n').filter((l) => !/^hook:|^ {2}approve_budget_seconds|^ {2}next_budget_seconds|^ {2}lock_wait_seconds/.test(l)).join('\n'));
  const merged2 = path.join(d, 'merged2.yaml'); writeFileSync(merged2, core(['merge-new', old, shipped]));
  assert.equal(strip(core(['get', merged2, 'hook.approve_budget_seconds'])), '20', 'upgrade did not add the default hook block to an old config');
});

test('intake_first: the user\'s message is written first, before any git call or scan, and survives a stopped hook', async () => {
  const d = fixture();
  const PATH = shim(path.join(tmp('shim'), 'bin'), 'git', `#!/bin/sh\nsleep 4\nexec ${gitPath} "$@"\n`);
  const t0 = ms();
  const child = spawn(process.execPath, [hookPath(d), 'prompt', 'claude'], { cwd: d, env: cleanEnv({ CLAUDE_PROJECT_DIR: d, PATH }), stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  child.stdin.on('error', () => {});
  child.stdin.end(promptJson(d, msg));
  const intake = () => lsGlob(d, '.agents/local/prompts/intake', /\.json$/);
  for (let i = 0; i < 30 && intake().length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  const t1 = ms();
  try {
    assert.ok(intake().length > 0, 'the prompt was not on disk while the hook was still waiting for git');
    if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    assert.ok(intake().some((f) => readFileSync(f, 'utf8').includes(msg)), "the intake file does not hold the user's message");
    assert.ok(t1 - t0 < 3500, `the intake write waited for git (${t1 - t0} ms)`);
  } finally { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('timeout_message: a forced hook timeout keeps the message and says in one line that the approval was not recorded', () => {
  const d = fixture();
  A(d, ['request-approval', 'LC', 'plan']); sleepSync(1000);
  const holder = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    mkdirSync(path.join(d, '.agents/local/.lock'));
    writeFileSync(path.join(d, '.agents/local/.lock/pid'), `${holder.pid}\n`);
    const out = strip(prompt(d, msg, { PROOFLINE_HOOK_LOCK_WAIT: '30', PROOFLINE_HOOK_APPROVE_BUDGET: '1' }));
    holder.kill(); rmSync(path.join(d, '.agents/local/.lock'), { recursive: true, force: true });
    assert.ok(out.includes('your approval could not be recorded, send it again'), `no one-line 'could not be recorded, send it again' on a forced timeout: ${out}`);
    assert.ok((out.match(/\n/g) ?? []).length <= 1, 'the timeout message is more than one line');
    assert.deepEqual(lsGlob(d, '.agents/runs/LC/approvals', /^\d{3}-plan\.yaml$/), [], 'an approval exists although the step was stopped');
    assert.ok(lsGlob(d, '.agents/local/prompts/history', /./).some((f) => readFileSync(f, 'utf8').includes(msg)), "the user's message is not in the prompt history");
    assert.ok(lsGlob(d, '.agents/local/prompts/intake', /\.json$/).some((f) => readFileSync(f, 'utf8').includes(msg)), "the user's message is not in the intake");
  } finally { holder.kill(); }
  // an approval that DID get written before the stop is reported as recorded, not as lost
  sleepSync(1000); A(d, ['request-approval', 'LC', 'plan']); sleepSync(1000);
  const out2 = prompt(d, msg);
  assert.ok(out2.includes('approval recorded'), `a normal approval was not recorded: ${out2}`);
  // review A3 at the hook: a budget written with a leading zero does not break the hook's arithmetic, the approval is still recorded
  for (const f of lsGlob(d, '.agents/runs/LC/approvals', /^\d{3}-plan\.yaml$/)) rmSync(f);
  sleepSync(1000); A(d, ['request-approval', 'LC', 'plan']); sleepSync(1000);
  editConfig(d, (t) => t.replace('approve_budget_seconds: 20', 'approve_budget_seconds: 08'));
  assert.ok(readFileSync(path.join(d, '.agents/config.yaml'), 'utf8').includes('approve_budget_seconds: 08'), 'test setup: the zero-padded budget was not written');
  const out3 = prompt(d, msg);
  assert.ok(lsGlob(d, '.agents/runs/LC/approvals', /^\d{3}-plan\.yaml$/).length > 0, `a budget of 08 broke the approval step: ${out3}`);
});

test('big_run_perf: next and digest do not grow with the run folder (300 files, about 14 MB)', () => {
  const d = fixture(); writeFileSync(path.join(d, '.gitignore'), '.agents/local/\n');
  A(d, ['next', 'LC']);   // warm-up
  const nSmall = timed(() => A(d, ['next', 'LC'])); const dSmall = timed(() => A(d, ['digest', 'LC']));
  bigfiles(path.join(d, '.agents/runs/LC/reviews/visual-proof/screens'), Number(process.env.AL_FILES ?? 300), Number(process.env.AL_BYTES ?? 50000));
  const nBig = timed(() => A(d, ['next', 'LC'])); const dBig = timed(() => A(d, ['digest', 'LC']));
  console.log(`next ${nSmall} -> ${nBig} ms, digest ${dSmall} -> ${dBig} ms`);
  // threshold: twice the small-run time plus 5 s of slack (the run folder adds nothing the commands read), and 90 s as a ceiling for a starved runner
  assert.ok(nBig <= nSmall * 2 + 5000 && nBig <= 90000, `next with a large run folder took ${nBig} ms (small run: ${nSmall} ms)`);
  assert.ok(dBig <= dSmall * 2 + 5000 && dBig <= 90000, `digest with a large run folder took ${dBig} ms (small run: ${dSmall} ms)`);
});

test('doctor_budget: doctor measures the approval path and warns when it nears the hook budget', () => {
  const d = fixture();
  editConfig(d, (t) => t.replace('approve_budget_seconds: 20', 'approve_budget_seconds: 5'));
  const PATH = shim(path.join(tmp('shim'), 'bin'), 'git', slowAdd(3));
  const doctor = (/** @type {Record<string, string>} */ env) => { const r = spawnSync(process.execPath, [path.join(repo, 'bin/proofline'), 'doctor'], { cwd: d, env: cleanEnv(env), encoding: 'utf8', timeout: 300000 }); return (r.stdout ?? '') + (r.stderr ?? ''); };
  let out = doctor({ PATH });
  assert.match(out, /^WARN approval path: /m, `doctor did not warn about a slow approval path: ${out.split('\n').filter((l) => /approval path|FAIL/i.test(l)).slice(0, 3).join(' | ')}`);
  out = doctor({});
  assert.ok(out.includes('approval path: '), 'doctor did not report the approval path time');
});
