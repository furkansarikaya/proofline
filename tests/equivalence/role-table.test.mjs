// @ts-check
// The role table test (issue #166): every role against every one of the 132 commands gives the same allow/deny on both engines.
// A denial is the exact message `command denied for <role>: <command>` with exit 1; anything else means the command was let through to run
// (with no arguments, so nearly all of them stop at their usage line). The lead is never denied by the gate; `lead test` would run every suite
// of the project, so that one pair is not executed (the gate allows it by construction: `lead) ;;`).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { baseEnv, copyTree, installedFixture } from './fixture.mjs';

const ROLES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];
const COMMANDS = readFileSync(join(import.meta.dirname, 'commands.txt'), 'utf8').split('\n').filter(Boolean);

/** @returns {Promise<{ code: number|null, stdout: string, stderr: string }>} */
function exec(/** @type {string} */ cwd, /** @type {Record<string,string>} */ env, /** @type {string[]} */ args) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['./.agents/scripts/agent.sh', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d)); p.stdin.end();
    const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Run jobs on a pool of workers; each worker has its own copy of the fixture so that locks and state never collide. */
async function table(/** @type {'sh'|'default'} */ engine) {
  const fx = installedFixture(); const base = mkdtempSync(join(tmpdir(), 'eq-roles.'));
  const n = Math.max(2, Math.min(8, cpus().length)); const dirs = [];
  for (let i = 0; i < n; i++) { const d = join(base, `w${i}`); copyTree(fx.dir, d); dirs.push(d); }
  /** @type {Map<string, { denied: boolean, code: number|null, stderr: string }>} */ const out = new Map();
  const jobs = ROLES.flatMap((r) => COMMANDS.map((c) => [r, c]));
  let next = 0;
  await Promise.all(dirs.map(async (d) => {
    const env = baseEnv(d, { TMPDIR: d + '-tmp', ...(engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}) });
    for (;;) {
      const i = next++; if (i >= jobs.length) return; const [role, cmd] = jobs[i];
      if (role === 'lead' && cmd === 'test') { out.set(`${role} ${cmd}`, { denied: false, code: null, stderr: '' }); continue; }
      const r = await exec(d, { ...env, AGENT_ROLE: role }, [cmd]);
      out.set(`${role} ${cmd}`, { denied: r.code === 1 && r.stderr === `command denied for ${role}: ${cmd}\n`, code: r.code, stderr: r.stderr });
    }
  }));
  rmSync(base, { recursive: true, force: true });
  return out;
}

test('the command list is the 132 dispatch arms of agent.sh 0.0.40', () => {
  assert.equal(COMMANDS.length, 132); assert.equal(new Set(COMMANDS).size, 132);
  for (const c of ['role', 'config-get', 'config-check', 'timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled', 'db-config', 'hook-config', 'help', 'record', 'submit', 'handoff', 'worker-evidence', 'gate', 'approve']) assert.ok(COMMANDS.includes(c), c);
});

test('every role x all 132 commands: the same allow/deny on both engines', { timeout: 600000 }, async () => {
  const [a, b] = [await table('sh'), await table('default')];
  assert.equal(a.size, ROLES.length * 132);
  const diffs = [...a].filter(([k, v]) => b.get(k)?.denied !== v.denied).map(([k, v]) => `${k}: sh ${v.denied ? 'denies' : 'allows'}, default ${b.get(k)?.denied ? 'denies' : 'allows'}`);
  assert.deepEqual(diffs, []);
  // the gate itself, as 0.0.40 states it: the lead is never denied; the gate roles may record/gate/submit; the implementer may also worker-evidence/handoff
  for (const c of COMMANDS) assert.equal(a.get(`lead ${c}`)?.denied, false, `lead ${c}`);
  const allowed = (/** @type {string} */ r) => COMMANDS.filter((c) => !a.get(`${r} ${c}`)?.denied);
  for (const r of ['reviewer', 'security_reviewer', 'qa', 'verifier']) for (const c of ['record', 'gate', 'submit', 'role', 'help']) assert.ok(allowed(r).includes(c), `${r} ${c}`);
  for (const c of ['start', 'freeze', 'approve', 'terminate']) assert.ok(!allowed('reviewer').includes(c), `reviewer must not run ${c}`);
  assert.ok(allowed('implementer').includes('worker-evidence') && allowed('implementer').includes('handoff'));
  assert.ok(!allowed('explorer').includes('handoff') && allowed('explorer').includes('submit'));
});
