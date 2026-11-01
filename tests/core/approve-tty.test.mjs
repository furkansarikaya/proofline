// @ts-check
// `approve` at a terminal (Node puts fd 0 in non-blocking mode on a terminal; the read must wait for the typed line, not fail with EAGAIN):
// the same run through a real pseudo-terminal with the shell engine and the Node engine: a phrase accepted, a wrong phrase refused, end of
// input, and a user who has not typed yet (both engines still wait). Skipped when python3 is missing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildTemplate, cleanEnv, copyProject } from '../hook/harness.mjs';

const havePython = spawnSync('python3', ['--version']).status === 0;
const skip = havePython ? false : 'python3 (the pty module) is not installed';

const PTY = `
import os, pty, sys, time, select, signal
dirp, engine, mode = sys.argv[1], sys.argv[2], sys.argv[3]
env = dict(os.environ); env.pop('PROOFLINE_ENGINE', None)
if engine == 'sh': env['PROOFLINE_ENGINE'] = 'sh'
pid, fd = pty.fork()
if pid == 0:
    os.chdir(dirp)
    os.execvpe('sh', ['sh', '.agents/scripts/agent.sh', 'approve', 'LC', 'plan'], env)
out = b''
def drain(t):
    global out
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: d = os.read(fd, 4096)
            except OSError: return
            if not d: return
            out += d
drain(1.5)
state = 'waiting'
def send(b):
    try: os.write(fd, b)
    except OSError: pass
if mode == 'accept': send(b'approve plan\\n')
elif mode == 'wrong': send(b'no thanks\\n')
elif mode == 'eof': send(b'\\x04')
elif mode == 'wait':
    r = os.waitpid(pid, os.WNOHANG)
    print('STILL_RUNNING' if r == (0, 0) else 'EXITED_EARLY')
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); sys.exit(0)
drain(3)
_, st = os.waitpid(pid, 0)
print('EXIT', os.WEXITSTATUS(st))
print(out.decode('latin1').replace('\\r\\n', '\\n'))
`;

let template = ''; let base = ''; let script = '';
before(() => {
  if (!havePython) return;
  template = buildTemplate();
  base = mkdtempSync(path.join(tmpdir(), 'pl-tty-'));
  script = path.join(base, 'drive-tty.py');
  writeFileSync(script, PTY);
});
after(() => { if (template) rmSync(template, { recursive: true, force: true }); if (base) rmSync(base, { recursive: true, force: true }); });

/** @param {'sh' | 'node'} engine @param {string} mode */
function run(engine, mode) {
  const dir = copyProject(template, base);
  const rq = spawnSync('sh', ['.agents/scripts/agent.sh', 'request-approval', 'LC', 'plan'], { cwd: dir, env: cleanEnv({ PROOFLINE_ENGINE: 'sh' }), encoding: 'utf8' });
  assert.equal(rq.status, 0, rq.stderr);
  const r = spawnSync('python3', [script, dir, engine === 'sh' ? 'sh' : 'node', mode], { encoding: 'utf8', env: cleanEnv({}), timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  let approvals = '';
  try { approvals = readFileSync(path.join(dir, '.agents/runs/LC/approvals/002-plan.yaml'), 'utf8').replace(/(approved_at|capture_time): \d+/g, '$1: <T>').replace(/tty:\d+:/g, 'tty:<T>:'); } catch { /* none written */ }
  return { out: r.stdout.replace(dir, '<DIR>'), approvals };
}

for (const mode of ['accept', 'wrong', 'eof']) {
  test(`approve at a terminal: ${mode}, Node engine equals shell engine`, { skip }, () => {
    const sh = run('sh', mode); const node = run('node', mode);
    assert.deepEqual(node, sh);
    if (mode === 'accept') { assert.match(node.out, /approval recorded: LC plan \(tty\)/); assert.match(node.approvals, /source: "tty"/); } else assert.equal(node.approvals, '');
    if (mode !== 'accept') assert.match(node.out, /approval refused: the user's words contain no approval phrase/);
  });
}

test('approve at a terminal: a user who has not typed yet is waited for by both engines', { skip }, () => {
  assert.equal(run('sh', 'wait').out.trim(), 'STILL_RUNNING');
  assert.equal(run('node', 'wait').out.trim(), 'STILL_RUNNING');
});
