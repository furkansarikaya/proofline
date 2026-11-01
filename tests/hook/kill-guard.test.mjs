// @ts-check
// The Node kill guard (adapters/claude/hooks/guards/kill.mjs) against the table of tests/enforcement/kill-guard-test.sh, and against the real kill
// guard of the shell hook (a project without proofline: only the merge and kill guards run) on the same commands: same verdict, same text.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanCommand } from '../../adapters/claude/hooks/command-scan.mjs';
import { killGuard } from '../../adapters/claude/hooks/guards/kill.mjs';
import { Deny } from '../../adapters/claude/hooks/guards/kit.mjs';
import { jesc } from '../../adapters/claude/hooks/lib/text.mjs';

const repo = resolve(import.meta.dirname, '../..');
const shellHook = join(repo, 'adapters/claude/hooks/proofline-hook.sh');
let base = ''; let proj = ''; let td = '';

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'kg-node-')));
  proj = join(base, 'proj');
  for (const d of ['scripts', 'node_modules/x', 'bench', 'd', '.git']) mkdirSync(join(proj, d), { recursive: true });
  const w = (/** @type {string} */ f, /** @type {string} */ t) => writeFileSync(join(proj, f), t);
  w('scripts/stop.sh', '#!/bin/sh\npkill node\n'); w('scripts/stop2.sh', '#!/bin/sh\nkill $(pgrep node)\n');
  w('scripts/x.py', 'import os\nos.system("killall node")\n'); w('scripts/x.js', 'require("child_process").execSync("pkill -f vite")\n');
  w('scripts/x.pl', 'system("pkill node");\n'); w('scripts/runme', '#!/bin/bash\nkill 0\n'); chmodSync(join(proj, 'scripts/runme'), 0o755);
  td = mkdtempSync(join(base, 't.')); writeFileSync(join(td, 't.sh'), 'killall node\n');
  w('scripts/ok.sh', '#!/bin/sh\nnpm test\nkill $!\n'); w('scripts/ok.py', 'print("hi")\n'); w('node_modules/x/s.sh', 'pkill node\n');
  w('scripts/big.sh', `${'a'.repeat(400000)}\npkill node\n`);
  w('k.sh', 'pkill node\n'); w('d/k.sh', 'pkill node\n');
  w('bench/kill.js', 'const cp=require("child_process");\nfor (const l of cp.execSync("pgrep x").toString().split("\\n")) process.kill(Number(l));\n');
  w('ok.sh', 'echo hello\nnpm test\n');
  w('bench/run.js', 'const cp=require("child_process");\nconst child=cp.spawn("sleep",["5"]);\ncp.execSync("ps -o rss= -p "+child.pid);\nprocess.kill(child.pid);\n');
  w('bench/own.py', 'import os,subprocess,signal\nopen("/proc/self/status").read()\nc=subprocess.Popen(["sleep","5"])\nos.kill(c.pid, signal.SIGTERM)\n');
  w('bk.sh', `${Array.from({ length: 30 }, (_, i) => `echo ${i}`).join('\n')}\nkill 12\n`);
  w('bn.sh', `${Array.from({ length: 30 }, (_, i) => `echo ${i}`).join('\n')}\necho hi\n`);
});
after(() => { rmSync(base, { recursive: true, force: true }); });

/** @type {Array<[string, boolean]>} */
const T = [];
const D = (/** @type {string[]} */ ...c) => c.forEach((x) => T.push([x, true]));
const A = (/** @type {string[]} */ ...c) => c.forEach((x) => T.push([x, false]));
D('pkill node', 'killall node', 'kill -1', 'kill 0', 'kill -9 -- -1', 'kill $(pgrep node)', 'pgrep node | xargs kill', 'sudo killall node', 'bash -c "pkill node"');
A('kill 1234', 'kill -TERM $PID', 'kill -9 $!', 'echo pkill', 'grep pkill file', 'npm run skill');
A('kill -0 1234', 'kill -0 $!', 'while kill -0 $PID 2>/dev/null; do sleep 1; done', 'kill -s 0 $PID', 'kill -n 0 $PID', 'sh -c "kill -0 $PID"');
D('kill -TERM 0', 'kill -- 0', 'pgrep x | xargs -r kill');
A('git commit -m "docs: kill $(pgrep node) is denied"', 'git commit -F - <<EOF\ndocs: kill $(pgrep node) is denied\nEOF', 'gh pr create --title t --body "text: kill $(pgrep x) and pkill x are denied"', 'command -v killall', 'pkill --help');
D('kill -9 "$(lsof -ti :3000)"', 'kill "$(pgrep x)"', 'kill -TERM "$(pgrep x)"', 'kill -9 -- "$(pgrep x)"', 'kill -s TERM "$(pgrep x)"'); A('kill "$(cat app.pid)"');
D('cat <<EOF\n$(pkill node)\nEOF', 'cat <<EOF\nx `killall node` y\nEOF', 'cat <<-EOF\n\tx\n\tEOF\nkillall node', 'bash <<EOF\nkill 0\nEOF');
A("cat <<'EOF'\n$(pkill node)\nEOF", 'cat <<\\EOF\n$(pkill node)\nEOF', 'cat <<EOF\n\tEOF\nkillall node\nEOF');
D('kill 00', 'kill +0', 'kill $((0))', 'kill -9 $((1-1))', 'kill -- -0', 'kill 000'); A('kill $((2+3))', 'kill -0 12', 'kill -- -1234');
D('pgrep x | while read p; do kill $p; done', 'for p in $(pgrep x); do kill $p; done', 'for p in `pgrep x`; do kill -9 $p; done', 'PID=$(pgrep x) && kill $PID', 'PIDS=`pidof node`; kill -9 $PIDS', 'P="$(ps aux | grep x | awk "{print \\$2}")"; kill $P', 'set -- $(pgrep x); kill "$@"');
A('PID=$(cat app.pid); kill $PID', 'node server.js & PID=$!; kill $PID', 'kill $(cat pidfile)', 'PID=1234; kill $PID', 'ps -p $PID -o comm= ; kill $PID');
D('find /proc -maxdepth 1 -name "1*" -exec kill {} \\;', 'find . -name x -exec pkill {} \\;', 'find . -name "*.pid" | xargs kill', 'ps aux | grep node | awk "{print \\$2}" | xargs kill -9', 'pgrep x | xargs -r kill -9', 'pidof node | xargs kill');
A('find . -name "*.log" -exec rm {} \\;', 'find . -name "*.log" -exec grep kill {} \\;', 'cat app.pid | xargs kill');
D("python3 -c 'import os; os.system(\"pkill node\")'", "python -c 'import os; os.kill(0, 9)'", "python -c 'import os; os.kill(-1, 9)'", "perl -e 'system(\"pkill node\")'", "perl -e 'kill 9, -1'", "node -e 'process.kill(0)'",
  "node -e 'process.kill(-1, \"SIGKILL\")'", "node -e 'require(\"child_process\").execSync(\"killall node\")'", "ruby -e 'Process.kill(\"TERM\", 0)'", "python3 - <<'PY'\nimport os\nos.system('pkill node')\nPY", "echo 'pkill node' | sh");
A("python3 -c 'print(1+1)'", "python3 -c 'import os; os.kill(12345, 0)'", "node -e 'process.kill(child.pid)'", "node -e 'console.log(1)'", "perl -e 'print 1'", "echo 'pkill node' | cat");
D('sh scripts/stop.sh', 'bash scripts/stop2.sh', 'source scripts/stop.sh', 'python3 scripts/x.py', 'node scripts/x.js', 'perl scripts/x.pl', './scripts/runme', "printf '#!/bin/sh\\npkill node\\n' > w.sh; sh w.sh");
A('sh scripts/ok.sh', 'python3 scripts/ok.py', 'sh node_modules/x/s.sh', 'sh scripts/big.sh', 'sh scripts/missing.sh', 'cat scripts/ok.sh', 'bash -c "echo hi"');
D('eval "pkill node"', 'eval "kill 0"', 'CMD="pkill node"; eval "$CMD"', 'K=pkill; $K node', 'K=killall; "$K" node', 'CMD="kill 0"; $CMD', 'PID=0; kill $PID');
A('eval "$(brew shellenv)"', 'eval "$(ssh-agent -s)"', 'K=echo; $K hi', 'X=1; eval "echo $X"');
A('kill $!', 'kill $(cat pidfile)', 'echo "pkill node is denied"', 'grep -n "kill 0" notes.txt', 'lsof -i :3000', "git commit -F - <<'EOF'\ndocs: pkill and killall are denied\nEOF", 'git commit -F - <<EOF\ndocs: pkill node and kill 0 are denied\nEOF');
D('kill $(ps -o pid= -C node)', 'for p in $(ps -o pid= -C node); do kill $p; done', 'x=$(ps -o pid= -C node); kill $x', 'kill $(ps -eo pid=,args= | grep node | cut -d" " -f1)', 'kill $(ps -o pid -C node)',
  "awk 'BEGIN{system(\"pkill node\")}'", "python3 -c 'print(\"pkill\")'", 'xargs pkill', 'pids=($(pgrep x)); kill ${pids[@]}', 'while read p; do kill $p; done < <(pgrep x)', 'mapfile -t a < <(pgrep x); kill "${a[@]}"',
  "pgrep x | python3 -c 'import os,sys; [os.kill(int(l),9) for l in sys.stdin]'");
D('cat k.sh | sh', 'cd d && sh k.sh', 'bash --norc k.sh', 'node bench/kill.js'); A('bash --norc ok.sh', 'node bench/run.js', 'python3 bench/own.py');
A("awk '/killall/ {print}' README.md", 'echo 123 | xargs kill', "python3 -c 'import psutil; psutil.Process(1234).kill()'", 'ssh host pkill x', 'docker exec c pkill x', 'n=$(FOO=1 pgrep x | wc -l); echo $n');
// more spellings of the same rules
D('killall5 -9','fuser -k 3000/tcp', 'skill -9 node', 'slay node', 'exec pkill node', 'env pkill node', 'timeout 5 pkill node', 'nohup killall node &', 'find . -exec sh -c "kill {}" \\;', 'setsid pkill node', 'echo kill 0 | sh', 'busybox pkill node');
A('fuser 3000/tcp', 'kill -l', 'pgrep node', 'ps aux | grep node', 'echo hi | xargs echo');

/** @param {string} cmd @param {Record<string, string>} [env] @returns {Promise<string | null>} the reason, or null when allowed */
async function nodeVerdict(cmd, env = {}) {
  const ctx = /** @type {any} */ ({ cwd: proj, root: proj, env: { TMPDIR: base, ...env }, t0: Date.now(), act: '', ev: 'pretool' });
  try { await killGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

/** The shell hook's verdict for a Bash command in a project without proofline (merge and kill guards only). @param {string} cmd @param {Record<string, string>} [env] @returns {Promise<string | null>} */
function shellVerdict(cmd, env = {}) {
  return new Promise((res, rej) => {
    const ch = spawn('sh', [shellHook, 'pretool', 'claude'], { cwd: proj, env: { PATH: process.env.PATH, HOME: base, TMPDIR: base, LC_ALL: 'C', CLAUDE_PROJECT_DIR: proj, PROOFLINE_NO_TTY: '1', ...env } });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('error', rej);
    ch.on('close', () => {
      const m = /"permissionDecisionReason":"((?:[^"\\]|\\.)*)"/.exec(out);
      res(m ? /** @type {string} */ (m[1]) : null);
    });
    ch.stdin.on('error', () => {});
    ch.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: proj, tool_name: 'Bash', tool_input: { command: cmd } }));
  });
}

test('the table: every command has the verdict the shell suite expects', async () => {
  for (const [cmd, denied] of T) {
    const r = await nodeVerdict(cmd);
    assert.equal(r !== null, denied, `${denied ? 'not denied' : 'denied'}: ${JSON.stringify(cmd)} -> ${r}`);
  }
});

test('differential: the shell hook gives the same verdict and the same text', async () => {
  const queue = [...T];
  /** @type {string[]} */ const bad = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const [cmd] = t;
      const [n, s] = await Promise.all([nodeVerdict(cmd), shellVerdict(cmd)]);
      const want = n === null ? null : `proofline: ${jesc(n)}`;
      if (want !== s) bad.push(`${JSON.stringify(cmd)}\n  node : ${want}\n  shell: ${s}`);
    }
  }));
  assert.deepEqual(bad, []);
});

test('the temp-dir script of the shell suite is read', async () => {
  assert.notEqual(await nodeVerdict(`sh ${join(td, 't.sh')}`), null);
});

test('the time budget: with 0 seconds a script naming a kill word is denied, one without passes (same text as the shell)', async () => {
  const env = { PROOFLINE_KG_BUDGET: '0' };
  const k = await nodeVerdict('sh bk.sh', env);
  assert.ok(k?.includes('ran out of time'), String(k));
  assert.equal(await nodeVerdict('sh bn.sh', env), null);
  assert.equal(`proofline: ${jesc(/** @type {string} */ (k))}`, await shellVerdict('sh bk.sh', env));
  assert.equal(await shellVerdict('sh bn.sh', env), null);
});
