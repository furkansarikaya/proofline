// @ts-check
// `agent.sh build-record <ID> run|show` (A229, the former scripts/build-record.sh and build-record-test.sh; tests/legacy-port-map.tsv names the rows): one build and
// test run per source state, a record keyed by commit or tree and the command strings, the FULL output kept, the lead runs and everyone reads, locks, dependency
// copies, command lists, env files, the time limit. Absolute expectations; the real control plane in a throwaway project.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../../control-plane/agents/scripts/core/buildrecord.mjs';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { commitAll, git, newProject, setCmd, setEnvFiles, setLists } from './helper-lib.mjs';
import { A } from './legacy-lib.mjs';
import { tmp } from '../lib/harness.mjs';

const keyOf = (/** @type {string} */ out) => (/^key: (.*)$/m.exec(out) ?? [])[1] ?? '';
const builds = (/** @type {string} */ d) => `${d}/.agents/local/builds`;
/** A project whose build and test append to a counter file and print one line each. */
function counted() {
  const d = newProject();
  const cnt = `${d}/../count-${path.basename(d)}`;
  writeFileSync(cnt, '');
  const build = `echo build-ok >> ${cnt}; echo built-line`;
  const tst = `echo test-ok >> ${cnt}; echo tested-line`;
  setCmd(d, 'build', build);
  setCmd(d, 'test', tst);
  commitAll(d, 'one');
  const n = (/** @type {string} */ w) => readFileSync(cnt, 'utf8').split('\n').filter((l) => l === w).length;
  return { d, cnt, n, build, tst };
}

test('show of a tree without a record exits 3 and names the lead command', () => {
  const { d } = counted();
  const r = A(d, ['build-record', 'LC', 'show']);
  assert.equal(r.status, 3);
  assert.match(r.err, /^build-record: no finished record for [0-9a-f]{40}-[0-9a-f]{8} \(the lead runs: agent\.sh build-record <ID> run\)$/m);
});

test('four callers, one run: the build and the test ran once; the record is keyed by the commit hash and the command strings, and shows exit status and output', async () => {
  const { d, n, build, tst } = counted();
  const first = A(d, ['build-record', 'LC', 'run']);
  assert.equal(first.status, 0, first.text);
  // two more reviewers at once
  const spawnRun = () => new Promise((resolve) => {
    const c = spawn('sh', ['.agents/scripts/agent.sh', 'build-record', 'LC', 'run'], { cwd: d, env: cleanEnv({}) });
    let out = ''; c.stdout.on('data', (b) => { out += b; }); c.on('close', () => resolve(out));
  });
  const [r2, r3] = await Promise.all([spawnRun(), spawnRun()]);
  const r4 = A(d, ['build-record', 'LC', 'run']);
  assert.equal(n('build-ok'), 1);
  assert.equal(n('test-ok'), 1);
  assert.equal(r2, first.out);
  assert.equal(r3, first.out);
  assert.equal(r4.out, first.out);
  const head = git(d, ['rev-parse', 'HEAD']);
  // scalar config keeps the original key form: the first 8 characters of the git object id of "<install>\n<build>\n<test>\n"
  const ck = spawnSync('git', ['hash-object', '--stdin'], { input: `\n${build}\n${tst}\n`, encoding: 'utf8' }).stdout.slice(0, 8);
  assert.equal(keyOf(first.out), `${head}-${ck}`);
  assert.ok(first.out.includes(`\nbuild: ${build}\n`) || first.out.includes(`build: ${build}\n`));
  assert.match(first.out, /^exit: 0$/m);
  assert.match(first.out, /^output-file: \.agents\/local\/builds\/[0-9a-f]{40}-[0-9a-f]{8}\/test\.out$/m);
  assert.match(first.out, /^output-tail:\n {2}tested-line$/m);
});

test('a changed tree gets its own record keyed tree-<hash>; a changed command string another one', () => {
  const { d, n } = counted();
  A(d, ['build-record', 'LC', 'run']);
  writeFileSync(`${d}/f.txt`, 'two\n');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.match(keyOf(r.out), /^tree-[0-9a-f]{40}-[0-9a-f]{8}$/);
  assert.equal(n('build-ok'), 2);
  commitAll(d, 'two');
  const before = readdirSync(builds(d)).length;
  setCmd(d, 'build', `echo build-ok >> ${d}/../count-${path.basename(d)}; echo built-line-2`);
  const r2 = A(d, ['build-record', 'LC', 'run']);
  assert.match(r2.out, /built-line-2/);
  assert.equal(readdirSync(builds(d)).length, before + 1, 'a record per key');
});

test('a failing command is recorded with its exit status, a note about git-ignored files, and exit 1 for run and show', () => {
  const { d } = counted();
  setCmd(d, 'test', 'echo bad-line; exit 3');
  writeFileSync(`${d}/f.txt`, 'three\n');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 1);
  assert.match(r.out, /^test: echo bad-line; exit 3$/m);
  assert.match(r.out, /^exit: 3$/m);
  assert.match(r.out, /^ {2}bad-line$/m);
  assert.match(r.out, /^note: the build export holds no git-ignored files/m);
  assert.equal(A(d, ['build-record', 'LC', 'show']).status, 1);
});

test('the lead runs once; a reviewer and the verifier read the same record and cannot run it', () => {
  const { d, n } = counted();
  const lead = A(d, ['build-record', 'LC', 'run']);
  const rev = A(d, ['build-record', 'LC', 'show'], { role: 'reviewer' });
  const ver = A(d, ['build-record', 'LC', 'show'], { role: 'verifier' });
  assert.equal(rev.out, lead.out);
  assert.equal(ver.out, lead.out);
  const denied = A(d, ['build-record', 'LC', 'run'], { role: 'reviewer' });
  assert.equal(denied.status, 2);
  assert.match(denied.err, /^build-record: only the lead runs the build \(agent\.sh build-record <ID> run\); use show$/m);
  assert.equal(n('build-ok'), 1);
});

test('usage: no run id exits 2; a run that does not exist fails; an unknown operation exits 2', () => {
  const { d } = counted();
  assert.equal(A(d, ['build-record']).status, 2);
  const nr = A(d, ['build-record', 'NOPE', 'show']);
  assert.equal(nr.status, 1);
  assert.match(nr.err, /run not found: NOPE/);
  const bad = A(d, ['build-record', 'LC', 'rebuild']);
  assert.equal(bad.status, 2);
  assert.match(bad.err, /usage: agent\.sh build-record <ID> \[run\|show\]/);
});

test('the key tells command lists apart and keeps the original form for scalar config', () => {
  const { d } = counted();
  setLists(d, 'echo a|echo b', 'echo c');
  const k1 = keyOf(A(d, ['build-record', 'LC', 'run']).out);
  setLists(d, 'echo a', 'echo b|echo c');
  const k2 = keyOf(A(d, ['build-record', 'LC', 'run']).out);
  assert.notEqual(k1, k2);
  assert.match(k1, /-[0-9a-f]{8}$/);
});

test('a command list: each command has its own record labelled build[i/n]; a failing one does not hide the others; nothing runs after a failed key', () => {
  const { d } = counted();
  setLists(d, 'echo one|exit 4|echo three', 'echo zzskipped');
  writeFileSync(`${d}/g.txt`, 'x\n');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 1);
  assert.match(r.out, /^build\[1\/3\]: echo one$/m);
  assert.match(r.out, /^build\[2\/3\]: exit 4$/m);
  assert.match(r.out, /^build\[3\/3\]: echo three$/m);
  assert.match(r.out, /^failed: build\[2\/3\] \(exit 4\)$/m);
  assert.ok(!r.out.includes('zzskipped'), 'the test did not run after the failed build');
  const dir = `${builds(d)}/${keyOf(r.out)}`;
  assert.equal(readFileSync(`${dir}/steps`, 'utf8'), 'build.1\tbuild[1/3]\nbuild.2\tbuild[2/3]\nbuild.3\tbuild[3/3]\n');
  assert.equal(readFileSync(`${dir}/build.3.out`, 'utf8'), 'three\n');
});

test('all commands of a list passing says so', () => {
  const { d } = counted();
  setLists(d, 'echo a|echo b', 'echo c');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 0);
  assert.match(r.out, /^all commands passed$/m);
});

test('evidence is never compressed: the .out file holds every byte, show prints the last 15 lines', () => {
  const { d } = counted();
  setCmd(d, 'build', 'i=1; while [ $i -le 120 ]; do echo "line-$i"; i=$((i + 1)); done; printf "no-newline"');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 0, r.text);
  const out = readFileSync(`${builds(d)}/${keyOf(r.out)}/build.out`, 'utf8');
  assert.equal(out, `${Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join('\n')}\nno-newline`);
  const tail = r.out.slice(r.out.indexOf('output-tail:\n'), r.out.indexOf('key: ', 5));
  assert.equal(tail, `output-tail:\n${[...Array.from({ length: 14 }, (_, i) => `  line-${107 + i}`), '  no-newline'].join('\n')}\n`);
});

test('stderr goes to the same output file, in order', () => {
  const { d } = counted();
  setCmd(d, 'build', 'echo out1; echo err1 >&2; echo out2');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(readFileSync(`${builds(d)}/${keyOf(r.out)}/build.out`, 'utf8'), 'out1\nerr1\nout2\n');
});

test('a lock of a dead process and a lock past BUILD_RECORD_WAIT are reclaimed; a record is made after each', () => {
  const { d, n } = counted();
  const key = keyOf(A(d, ['build-record', 'LC', 'run']).out);
  const dir = `${builds(d)}/${key}`;
  const dead = spawnDead();
  rmDir(dir); mkdirSync(`${dir}.lock`); writeFileSync(`${dir}.lock/pid`, `${dead}\n`);
  assert.equal(A(d, ['build-record', 'LC', 'run']).status, 0);
  assert.equal(n('build-ok'), 2);
  rmDir(dir); mkdirSync(`${dir}.lock`); writeFileSync(`${dir}.lock/pid`, `${process.pid}\n`);
  assert.equal(A(d, ['build-record', 'LC', 'run'], { env: { BUILD_RECORD_WAIT: '2' } }).status, 0);
  assert.equal(n('build-ok'), 3);
  assert.ok(!existsSync(`${dir}.lock`), 'the lock is released');
});

test('an ignored dependency folder is a COPY in the export: the build sees it, and a write by the build does not reach the project', () => {
  const { d } = counted();
  writeFileSync(`${d}/.gitignore`, 'node_modules\n');
  mkdirSync(`${d}/node_modules`); writeFileSync(`${d}/node_modules/m`, 'dep\n');
  commitAll(d, 'ignore');
  writeFileSync(`${d}/dep-build.sh`, 'test -f node_modules/m && test ! -L node_modules && echo x > node_modules/written && echo y >> node_modules/m\n');
  setCmd(d, 'build', `sh ${d}/dep-build.sh`);
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 0, r.text);
  assert.ok(!existsSync(`${d}/node_modules/written`));
  assert.equal(readFileSync(`${d}/node_modules/m`, 'utf8'), 'dep\n');
});

test('verification.env_files: a listed secret-free file enters the export, an unlisted .env never does', () => {
  const { d } = counted();
  writeFileSync(`${d}/.gitignore`, '.env\n.env.test\n');
  writeFileSync(`${d}/.env.test`, 'MODE=test\n'); writeFileSync(`${d}/.env`, 'MODE=dev\n');
  writeFileSync(`${d}/chk-in.sh`, 'set -e\ntest -f .env.test\ntest ! -f .env\n');
  setCmd(d, 'build', `sh ${d}/chk-in.sh`);
  setEnvFiles(d, '.env.test');
  commitAll(d, 'envs');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 0, r.text);
  // without the list no .env* enters the export
  writeFileSync(`${d}/chk-out.sh`, 'set -e\ntest ! -f .env.test\ntest ! -f .env\n');
  setEnvFiles(d, '');
  setCmd(d, 'build', `sh ${d}/chk-out.sh`);
  const r2 = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r2.status, 0, r2.text);
});

test('a secret in a listed env file rejects the record (exit 2), names the file and line, prints no value and builds nothing', () => {
  const { d, n } = counted();
  writeFileSync(`${d}/.gitignore`, '.env.test\n');
  const tok = `ghp${'_'}q8Zr2Lm9Xc4Vb7Nk1Pw6Ty3Hs5Jd0FgEAb12`;
  writeFileSync(`${d}/.env.test`, `API_TOKEN=${tok}\n`);
  setEnvFiles(d, '.env.test');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 2);
  assert.match(r.err, /^build-record: rejected: verification\.env_files \.env\.test:1 holds a secret \(.+\); the value is not shown\./m);
  assert.ok(!r.text.includes(tok), 'the value was printed');
  assert.equal(n('build-ok'), 0);
  writeFileSync(`${d}/.env.test`, 'DB_PASSWORD=Xk9q8Zr2Lm9Xc4Vb7Nk1Pw6Ty3Hs5Jd0\n');
  assert.equal(A(d, ['build-record', 'LC', 'run']).status, 2, 'an unquoted KEY=secret line is caught');
});

test('a listed file under a symbolic link out of the project or under .git is rejected; a missing one is a note', () => {
  const { d, n } = counted();
  const outside = tmp('br-out-');
  writeFileSync(`${outside}/.env.test`, 'MODE=test\n');
  symlinkSync(outside, `${d}/linkdir`);
  writeFileSync(`${d}/.gitignore`, 'linkdir\n');
  setEnvFiles(d, 'linkdir/.env.test');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 2);
  assert.match(r.err, /^build-record: rejected: verification\.env_files linkdir\/\.env\.test is a symbolic link, or its directory resolves outside the project or into \.git; nothing was built$/m);
  assert.equal(n('build-ok'), 0);
  setEnvFiles(d, '.git/config');
  assert.equal(A(d, ['build-record', 'LC', 'run']).status, 2);
  setEnvFiles(d, 'missing.env');
  const m = A(d, ['build-record', 'LC', 'run']);
  assert.equal(m.status, 0, m.text);
  assert.match(m.err, /^build-record: note: verification\.env_files lists missing\.env, which does not exist; skipped$/m);
});

test('verification.env_files must be plain project-relative names: a path with .., an absolute path and a glob are invalid for config-check, a plain name is valid', () => {
  const d = counted().d;
  setEnvFiles(d, '.env.test');
  assert.equal(A(d, ['config-check']).status, 0);
  for (const bad of ['../x', '/etc/x', '*.env']) {
    setEnvFiles(d, bad);
    const r = A(d, ['config-check']);
    assert.notEqual(r.status, 0, bad);
    assert.ok(r.text.includes('verification.env_files must be project-relative file names'), `${bad}: ${r.text}`);
  }
});

test('without a `timeout` command the limit still holds: Node\'s timer stops the command and the status is 124; a command that ends in time keeps its own status', () => {
  const d = newProject();
  const ctx = new Context({ env: { PATH: '/nonexistent' }, cwd: d, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: `${d}/.agents/scripts/agent.sh` }, `${d}/.agents/scripts/agent.sh`);
  const out = `${d}/limit.out`;
  const t0 = Date.now();
  assert.equal(runCommand(ctx, d, 'echo started; exec /bin/sleep 10', out, 1), 124);
  assert.ok(Date.now() - t0 < 8000, 'the command was not stopped at the limit');
  assert.equal(readFileSync(out, 'utf8'), 'started\n', 'what the command wrote before the stop stays');
  assert.equal(runCommand(ctx, d, 'echo quick; exit 3', out, 30), 3);
  assert.equal(readFileSync(out, 'utf8'), 'quick\n');
});

test('the timer fallback: a command that traps TERM and exits 0 is still 124, and a grandchild is gone after the stop', () => {
  const d = newProject();
  const ctx = new Context({ env: { PATH: '/nonexistent' }, cwd: d, stdout: { write: () => true }, stderr: { write: () => true }, scriptPath: `${d}/.agents/scripts/agent.sh` }, `${d}/.agents/scripts/agent.sh`);
  const out = `${d}/trap.out`;
  const t0 = Date.now();
  assert.equal(runCommand(ctx, d, "trap 'exit 0' TERM; /bin/sleep 10 & wait", out, 2), 124, 'an expired limit is 124 whatever status the command reports');
  assert.ok(Date.now() - t0 < 8000);
  const pidFile = `${d}/gc.pid`;
  assert.equal(runCommand(ctx, d, `/bin/sleep 60 & echo $! > ${pidFile}; /bin/sleep 60`, out, 1), 124);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(pid > 1);
  const until = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < until) { try { process.kill(pid, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch { alive = false; } }
  assert.equal(alive, false, 'the grandchild survived the stop');
  // a command that ends in time leaves nothing behind either
  writeFileSync(pidFile, '');
  assert.equal(runCommand(ctx, d, `/bin/sleep 60 & echo $! > ${pidFile}; exit 0`, out, 30), 0);
  const pid2 = Number(readFileSync(pidFile, 'utf8').trim());
  const until2 = Date.now() + 3000;
  let alive2 = true;
  while (alive2 && Date.now() < until2) { try { process.kill(pid2, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch { alive2 = false; } }
  assert.equal(alive2, false, 'a background process outlived its command');
});

test('commands.build and commands.test not configured exits 2', () => {
  const d = newProject();
  setCmd(d, 'build', ''); setCmd(d, 'test', '');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 2);
  assert.match(r.err, /^build-record: commands\.build and commands\.test are not configured$/m);
});

test('a command stopped by the time limit (exit 124) is a failure and leaves no sealed record; the next run starts again', () => {
  const { d, n } = counted();
  const shim = tmp('br-timeout-');
  writeFileSync(`${shim}/timeout`, '#!/bin/sh\nexit 124\n'); chmodSync(`${shim}/timeout`, 0o755);
  const slow = A(d, ['build-record', 'LC', 'run'], { env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(slow.status, 1);
  assert.match(slow.err, /^build-record: build stopped after 1800s \(verification\.command_timeout_seconds times timeouts\.scale\); this is a failure, not a pass, and no record is kept: run it again, or raise the limit \(proofline doctor --scale\)$/m);
  const key = readdirSync(builds(d)).find((x) => !x.includes('.lock'));
  assert.ok(key !== undefined && existsSync(`${builds(d)}/${key}/timed-out`) && !existsSync(`${builds(d)}/${key}/done`));
  assert.equal(A(d, ['build-record', 'LC', 'show']).status, 3);
  const again = A(d, ['build-record', 'LC', 'run']);
  assert.equal(again.status, 0);
  assert.equal(n('build-ok'), 1, 'the second run built for real');
});

/** The pid of a process that has exited. */
function spawnDead() { return Number(spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()); }
const rmDir = (/** @type {string} */ p) => rmSync(p, { recursive: true, force: true });

test('A248 round 7: the build record keeps the repository\'s own filters but never runs its core.fsmonitor program (key snapshot, read-tree and the export)', () => {
  const { d } = counted();
  const mark = `${d}-FSM`; const prog = `${d}-fsm.sh`;
  writeFileSync(prog, `#!/bin/sh\ntouch ${mark}\nprintf '\\0'\n`);
  chmodSync(prog, 0o755);
  git(d, ['config', 'core.fsmonitor', prog]);
  spawnSync('git', ['-C', d, 'ls-files'], { env: cleanEnv({}) });
  assert.ok(existsSync(mark), 'test premise: plain git ls-files runs the core.fsmonitor program');
  rmSync(mark, { force: true });
  writeFileSync(`${d}/dirty.txt`, 'uncommitted\n'); // an uncommitted file: the key is a snapshot of the tree (add -A), then the export (read-tree, checkout-index)
  setCmd(d, 'build', 'true');
  const r = A(d, ['build-record', 'LC', 'run']);
  assert.equal(r.status, 0, r.text);
  assert.ok(/^key: tree-/m.test(r.text), `the snapshot path ran: ${r.text}`);
  assert.ok(!existsSync(mark), 'build-record ran the core.fsmonitor program of the repository configuration');
});
