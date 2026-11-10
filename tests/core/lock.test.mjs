// @ts-check
// The mkdir lock protocol of the core: processes exclude each other, and a stale lock is broken with the `lock-break` ledger event (its line, and the line `ledger_append` writes, are the ones the
// shell functions of agent.sh wrote: recorded from them in tests/golden/shell-equivalence.json, A244; until then the tests also ran those functions and compared).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { LockSet, ledgerAppend, runSections } from '../../control-plane/agents/scripts/core/lock.mjs';
import { makeProject, memoryIo, scriptsDir } from './helpers.mjs';

const lockModule = pathToFileURL(path.join(scriptsDir, 'core', 'lock.mjs')).href;
const contextModule = pathToFileURL(path.join(scriptsDir, 'core', 'context.mjs')).href;

const GOLD = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'shell-equivalence.json'), 'utf8'));

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

describe('lock protocol', () => {
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
      writeFileSync(path.join(l, 'pid'), `${process.pid}\n`); // alive, and not the parent (a lock of the parent is its own transaction, 4B)
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

describe('stale lock: the core breaks it and records the lock-break event (the line is the one the shell wrote, recorded in tests/golden/shell-equivalence.json)', () => {
  test('a run lock of a run with lifecycle gates: lock-break in the ledger', () => {
    const root = makeProject();
    try {
      const run = seedRun(root);
      const pid = deadPid();
      seedStale(path.join(run, '.lock'), pid);
      const locks = new LockSet(ctxOf(root));
      locks.acquire(path.join(run, '.lock'));
      locks.releaseAll();
      assert.equal(existsSync(path.join(run, '.lock')), false, 'lock released');
      const lines = readFileSync(path.join(run, 'LEDGER.log'), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2, 'one event appended');
      assert.equal(maskTime(lines[1]).replace(String(pid), 'PID'), GOLD.lockBreakLine, 'the line the shell wrote (prev and digest included)');
      assert.match(lines[1], new RegExp(`^seq=2 prev=[0-9a-f]{64} event=lock-break role=lead from=- to=- digest=[0-9a-f]{64} ts=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ epoch=\\d+ detail=stale lock holder pid=${pid}$`));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('without lifecycle gates, and for a lock that is not a run lock, nothing is written', () => {
    const root = makeProject();
    try {
      const run = seedRun(root, { gates: false });
      seedStale(path.join(run, '.lock'), deadPid());
      const shared = path.join(root, '.agents', 'local', 'locks', 'shared.lock');
      seedStale(shared, deadPid());
      const locks = new LockSet(ctxOf(root));
      locks.acquire(path.join(run, '.lock'));
      locks.acquire(shared);
      locks.releaseAll();
      assert.equal(readFileSync(path.join(run, 'LEDGER.log'), 'utf8'), LEDGER_1);
      assert.equal(existsSync(shared), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('ledgerAppend appends the line the shell ledger_append wrote on a ledger of several lines, with a tab and a newline in the detail', () => {
    const root = makeProject();
    try {
      const run = seedRun(root);
      appendFileSync(path.join(run, 'LEDGER.log'), 'seq=2 prev=0000 event=x role=lead from=- to=- digest=d ts=t epoch=1 detail=last line\n');
      ledgerAppend(run, 'lead', 'note', 'A', '', 'a\tb\nc');
      const text = readFileSync(path.join(run, 'LEDGER.log'), 'utf8');
      const line = maskTime(text.split('\n').slice(-2)[0]);
      assert.equal(line, GOLD.ledgerAppend);
      assert.match(line, /^seq=3 prev=[0-9a-f]{64} event=note role=lead from=A to=- /);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('mutual exclusion between processes of the core', () => {
  test('a holder in another process keeps a waiter out, and the waiter gets in after the release', async () => {
    const root = makeProject();
    try {
      const l = path.join(root, '.agents', 'local', 'locks', 'shared.lock');
      mkdirSync(path.dirname(l), { recursive: true });
      // the holder releases when it reads a line on stdin: no clock decides how long it holds
      const holder = spawn(process.execPath, ['--input-type=module', '-e', `
        import { LockSet } from ${JSON.stringify(lockModule)}; import { Context } from ${JSON.stringify(contextModule)};
        const io = { env: process.env, cwd: ${JSON.stringify(root)}, stdout: { write() {} }, stderr: { write() {} } };
        const locks = new LockSet(new Context(io, ${JSON.stringify(path.join(root, '.agents', 'scripts', 'agent.sh'))}));
        locks.acquire(${JSON.stringify(l)}); process.stdout.write('held\\n');
        process.stdin.once('data', () => { locks.releaseAll(); process.exit(0); });`]);
      await new Promise((resolve) => holder.stdout.once('data', resolve));
      const short = new Context(memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: '1' }).io, path.join(root, '.agents', 'scripts', 'agent.sh'));
      assert.throws(() => new LockSet(short).acquire(l), /lock timeout after 1s/);
      assert.equal(existsSync(l), true, 'the holder still has the lock');
      const closed = new Promise((resolve) => holder.on('close', resolve));
      holder.stdin.write('release\n');
      await closed;
      const long = new Context(memoryIo(root, { PROOFLINE_LOCK_TIMEOUT: '15' }).io, path.join(root, '.agents', 'scripts', 'agent.sh'));
      const locks = new LockSet(long);
      locks.acquire(l);
      assert.equal(readFileSync(path.join(l, 'pid'), 'latin1'), `${process.pid}\n`);
      locks.releaseAll();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runSections (sv_load)', () => {
  test('section.key=value, the first of a repeated key, quotes and comments removed', () => {
    assert.deepEqual(runSections('a:\n  k: "v" # c\n  k: other\n  n: 1\nb:\n  z: q\nversion: 1\nc:\n  y: 2\n'), ['a.k=v', 'a.n=1', 'b.z=q', 'c.y=2']);
  });
});
