// @ts-check
// The mkdir lock protocol, against the shell functions of agent.sh themselves: an old-engine and a new-engine process exclude each other,
// and a stale lock is broken with the same `lock-break` ledger event.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { LockSet, ledgerAppend, runSections } from '../../control-plane/agents/scripts/core/lock.mjs';
import { extractFunctions, makeProject, memoryIo, scriptsDir } from './helpers.mjs';

const lockModule = pathToFileURL(path.join(scriptsDir, 'core', 'lock.mjs')).href;
const contextModule = pathToFileURL(path.join(scriptsDir, 'core', 'context.mjs')).href;

const SH_FUNCTIONS = extractFunctions([
  'release_locks', 'take_old_lock', 'acquire_lock', 'gates_enforced', 'ledger_file', 'one_line', 'run_dir', 'now_epoch', 'now_iso', 'lifecycle_digest', '_lv', 'sv_reset', 'sv_load',
  'section_value', 'section_key_present', 'local_task_source_run', 'ledger_append',
]);

/** A script that runs shell code against a project root with the real functions of agent.sh. @param {string} root @param {string} body */
function shScript(root, body) {
  return `set -eu; LC_ALL=C; export LC_ALL
root='${root}'; agents=$root/.agents; execution_role=lead; held_locks=''; record_tmp=''; sv_dir='' sv_cache=''
fail() { echo "$*" >&2; return 1; }
tm_scaled() { echo 120; }
sha256() { sh_o=$(shasum -a 256) || :; [ -z "$sh_o" ] || printf '%s\\n' "\${sh_o%% *}"; }
${SH_FUNCTIONS}
${body}`;
}

/** @param {string} root */
function ctxOf(root) {
  const { io } = memoryIo(root);
  return new Context(io, io.scriptPath);
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

const RUN_YAML = 'execution:\n  state: PLANNED\n  autonomy: "supervised"\nhandoff:\n  state: PLANNED\npipeline:\n  classification: PENDING\nlifecycle_gates:\n  required: true\ntask_source:\n  type: local_markdown\n  path: .agents/tasks/T-1.md\n';
const LEDGER_1 = 'seq=1 prev=genesis event=start role=lead from=- to=PLANNED digest=abc ts=2026-01-01T00:00:00Z epoch=1767225600 detail=task=x\n';

/** @param {string} root @param {{ gates?: boolean }} [opt] */
function seedRun(root, opt = {}) {
  const run = path.join(root, '.agents', 'runs', 'T-1');
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, 'RUN.yaml'), opt.gates === false ? RUN_YAML.replace('lifecycle_gates:\n  required: true\n', '') : RUN_YAML);
  writeFileSync(path.join(run, 'LEDGER.log'), LEDGER_1);
  return run;
}

/** @param {string} lockDir @param {number|string} pid */
function seedStale(lockDir, pid) {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'pid'), `${pid}\n`);
}

/** @param {string} line */
const maskTime = (line) => line.replace(/ ts=\S+ epoch=\d+ /, ' ts=T epoch=E ');

describe('lock protocol (new engine alone)', () => {
  test('mkdir, a pid file with the holder\'s pid, release removes both', () => {
    const root = makeProject();
    try {
      const locks = new LockSet(ctxOf(root));
      const l = path.join(root, '.agents', 'local', 'locks', 'shared.lock');
      mkdirSync(path.dirname(l), { recursive: true });
      locks.acquire(l);
      assert.equal(readFileSync(path.join(l, 'pid'), 'latin1'), `${process.pid}\n`);
      locks.acquire(l); // already held by this set: no second take
      locks.releaseAll();
      assert.equal(existsSync(l), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('release leaves a lock whose pid file is another process\'s', () => {
    const root = makeProject();
    try {
      const locks = new LockSet(ctxOf(root));
      const l = path.join(root, '.agents', 'local', 'locks', 'x.lock');
      mkdirSync(path.dirname(l), { recursive: true });
      locks.acquire(l);
      writeFileSync(path.join(l, 'pid'), '1\n');
      locks.releaseAll();
      assert.equal(existsSync(l), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('timeout message, invalid timeout, unwritable directory', () => {
    const root = makeProject();
    try {
      const l = path.join(root, '.agents', 'local', 'locks', 'busy.lock');
      mkdirSync(l, { recursive: true });
      writeFileSync(path.join(l, 'pid'), `${process.ppid}\n`); // alive
      const { io } = memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: '1' });
      const ctx = new Context(io, io.scriptPath);
      assert.throws(() => new LockSet(ctx).acquire(l), { message: `lock timeout after 1s: ${l}` });
      const bad = new Context(memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: 'x' }).io, io.scriptPath);
      assert.throws(() => new LockSet(bad).acquire(l), { message: 'invalid PROOFLINE_LOCK_TIMEOUT: x' });
      assert.throws(() => new LockSet(ctx).acquire(path.join(root, 'no-such-dir', 'a.lock')), /cannot take the lock .*its directory is not writable/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a lock folder without a pid file (its holder is between mkdir and the pid write) is waited for, never broken', () => {
    const root = makeProject();
    try {
      const l = path.join(root, '.agents', 'local', 'locks', 'young.lock');
      mkdirSync(l, { recursive: true });
      const ctx = new Context(memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: '1' }).io, path.join(root, '.agents', 'scripts', 'agent.sh'));
      assert.throws(() => new LockSet(ctx).acquire(l), /lock timeout after 1s/);
      assert.equal(existsSync(l), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('stale lock: both engines break it and record the same event', () => {
  test('a run lock of a run with lifecycle gates: lock-break in the ledger', () => {
    const results = [];
    for (const engine of ['sh', 'node']) {
      const root = makeProject();
      try {
        const run = seedRun(root);
        const pid = deadPid();
        seedStale(path.join(run, '.lock'), pid);
        if (engine === 'sh') {
          const r = spawnSync('sh', ['-c', shScript(root, 'acquire_lock "$agents/runs/T-1/.lock"; release_locks')], { encoding: 'utf8' });
          assert.equal(r.status, 0, r.stderr);
        } else {
          const locks = new LockSet(ctxOf(root));
          locks.acquire(path.join(run, '.lock'));
          locks.releaseAll();
        }
        assert.equal(existsSync(path.join(run, '.lock')), false, `${engine}: lock released`);
        const lines = readFileSync(path.join(run, 'LEDGER.log'), 'utf8').trim().split('\n');
        assert.equal(lines.length, 2, `${engine}: one event appended`);
        results.push(maskTime(lines[1]).replace(String(pid), 'PID'));
        assert.match(lines[1], new RegExp(`^seq=2 prev=[0-9a-f]{64} event=lock-break role=lead from=- to=- digest=[0-9a-f]{64} ts=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ epoch=\\d+ detail=stale lock holder pid=${pid}$`));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    assert.equal(results[0], results[1], 'the two engines wrote the same line (prev and digest included)');
  });

  test('without lifecycle gates, and for a lock that is not a run lock, nothing is written', () => {
    for (const engine of ['sh', 'node']) {
      const root = makeProject();
      try {
        const run = seedRun(root, { gates: false });
        seedStale(path.join(run, '.lock'), deadPid());
        const shared = path.join(root, '.agents', 'local', 'locks', 'shared.lock');
        seedStale(shared, deadPid());
        if (engine === 'sh') {
          const r = spawnSync('sh', ['-c', shScript(root, 'acquire_lock "$agents/runs/T-1/.lock"; acquire_lock "$agents/local/locks/shared.lock"; release_locks')], { encoding: 'utf8' });
          assert.equal(r.status, 0, r.stderr);
        } else {
          const locks = new LockSet(ctxOf(root));
          locks.acquire(path.join(run, '.lock'));
          locks.acquire(shared);
          locks.releaseAll();
        }
        assert.equal(readFileSync(path.join(run, 'LEDGER.log'), 'utf8'), LEDGER_1, engine);
        assert.equal(existsSync(shared), false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  test('ledgerAppend equals ledger_append on a ledger of several lines, with a tab and a newline in the detail', () => {
    const out = [];
    for (const engine of ['sh', 'node']) {
      const root = makeProject();
      try {
        const run = seedRun(root);
        appendFileSync(path.join(run, 'LEDGER.log'), 'seq=2 prev=0000 event=x role=lead from=- to=- digest=d ts=t epoch=1 detail=last line\n');
        if (engine === 'sh') {
          const r = spawnSync('sh', ['-c', shScript(root, "ledger_append T-1 note A '' \"a\tb\nc\"")], { encoding: 'utf8' });
          assert.equal(r.status, 0, r.stderr);
        } else {
          ledgerAppend(run, 'lead', 'note', 'A', '', 'a\tb\nc');
        }
        const text = readFileSync(path.join(run, 'LEDGER.log'), 'utf8');
        out.push(maskTime(text.split('\n').slice(-2)[0]));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    assert.equal(out[0], out[1]);
    assert.match(out[0], /^seq=3 prev=[0-9a-f]{64} event=note role=lead from=A to=- /);
  });
});

describe('mutual exclusion between the engines', () => {
  test('a new-engine holder keeps an old-engine waiter out, and the waiter gets in after the release', async () => {
    const root = makeProject();
    try {
      const l = path.join(root, '.agents', 'local', 'locks', 'shared.lock');
      mkdirSync(path.dirname(l), { recursive: true });
      const holder = spawn(process.execPath, ['--input-type=module', '-e', `
        import { LockSet } from ${JSON.stringify(lockModule)}; import { Context } from ${JSON.stringify(contextModule)};
        const io = { env: process.env, cwd: ${JSON.stringify(root)}, stdout: { write() {} }, stderr: { write() {} } };
        const locks = new LockSet(new Context(io, ${JSON.stringify(path.join(root, '.agents', 'scripts', 'agent.sh'))}));
        locks.acquire(${JSON.stringify(l)}); process.stdout.write('held\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); locks.releaseAll();`]);
      await new Promise((resolve) => holder.stdout.once('data', resolve));
      const waiter = spawnSync('sh', ['-c', shScript(root, `PROOFLINE_LOCK_TIMEOUT=1; acquire_lock "${l}"; echo got`)], { encoding: 'utf8' });
      assert.notEqual(waiter.status, 0);
      assert.match(waiter.stderr, /lock timeout after 1s/);
      assert.doesNotMatch(waiter.stdout, /got/);
      const second = spawnSync('sh', ['-c', shScript(root, `PROOFLINE_LOCK_TIMEOUT=10; acquire_lock "${l}"; echo got; release_locks`)], { encoding: 'utf8' });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /got/);
      await new Promise((resolve) => holder.on('close', resolve));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an old-engine holder keeps a new-engine waiter out, and the waiter gets in after the release', async () => {
    const root = makeProject();
    try {
      const l = path.join(root, '.agents', 'local', 'locks', 'shared.lock');
      mkdirSync(path.dirname(l), { recursive: true });
      const holder = spawn('sh', ['-c', shScript(root, `acquire_lock "${l}"; echo held; sleep 3; release_locks`)]);
      await new Promise((resolve) => holder.stdout.once('data', resolve));
      const short = new Context(memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: '1' }).io, path.join(root, '.agents', 'scripts', 'agent.sh'));
      assert.throws(() => new LockSet(short).acquire(l), /lock timeout after 1s/);
      const long = new Context(memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: '15' }).io, path.join(root, '.agents', 'scripts', 'agent.sh'));
      const locks = new LockSet(long);
      locks.acquire(l);
      assert.equal(readFileSync(path.join(l, 'pid'), 'latin1'), `${process.pid}\n`);
      locks.releaseAll();
      await new Promise((resolve) => holder.on('close', resolve));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runSections (sv_load)', () => {
  test('section.key=value, the first of a repeated key, quotes and comments removed', () => {
    assert.deepEqual(runSections('a:\n  k: "v" # c\n  k: other\n  n: 1\nb:\n  z: q\nversion: 1\nc:\n  y: 2\n'), ['a.k=v', 'a.n=1', 'b.z=q', 'c.y=2']);
  });
});
