// @ts-check
// Run a command the repository does not own the timing of (a fixture builder, a toolchain test run): argument array (no shell string), its own
// process group, and on expiry the whole group is killed and the run FAILS (status 124) -- a hung grandchild never outlives the step.
import { spawn } from 'node:child_process';

/**
 * @param {string} cmd @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, input?: string }} [o]
 * @returns {Promise<{ status: number, stdout: string, stderr: string, text: string, timedOut: boolean }>}
 */
export function runGroup(cmd, args, o = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    const kill = () => { if (!c.pid) return; try { process.kill(-c.pid, 'SIGKILL'); } catch { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs ?? 900000);
    const done = (/** @type {number} */ status) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ status: timedOut ? 124 : status, stdout, stderr: timedOut ? `${stderr}\nthe run exceeded ${(o.timeoutMs ?? 900000) / 1000}s and was killed with its process group\n` : stderr, text: stdout + stderr, timedOut });
    };
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('error', (e) => { stderr += `${e.message}\n`; done(127); });
    c.on('close', (code) => done(code ?? 1));
    c.stdin.on('error', () => { /* the command did not read its input */ });
    c.stdin.end(o.input ?? '');
  });
}
