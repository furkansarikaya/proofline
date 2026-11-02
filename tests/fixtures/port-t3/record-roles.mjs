// @ts-check
// ONE-TIME recorder of tests/fixtures/port-t3/roles.json (temporary; needs tests/equivalence, which is to be deleted): every role against every one of the 132
// commands on the SHELL (PROOFLINE_ENGINE=sh, no arguments): is the call refused by the role gate (the exact message `command denied for <role>: <command>`, exit 1)?
// `lead test` would run every suite of the project, so that pair is not run (the gate lets the lead through by construction).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseEnv, copyTree, installedFixture } from '../../equivalence/fixture.mjs';

const ROLES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];
const COMMANDS = readFileSync(new URL('../../equivalence/commands.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
/** @returns {Promise<{ code: number | null, stderr: string }>} */
const exec = (/** @type {string} */ cwd, /** @type {Record<string, string>} */ env, /** @type {string[]} */ args) => new Promise((resolve) => {
  const p = spawn('sh', ['./.agents/scripts/agent.sh', ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; p.stdout.on('data', () => {}); p.stderr.on('data', (d) => (stderr += d)); p.stdin.end();
  const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
  p.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
});
const fx = installedFixture(); const base = mkdtempSync(join(tmpdir(), 'rec-roles.'));
const n = Math.max(2, Math.min(6, cpus().length)); const dirs = [];
for (let i = 0; i < n; i++) { const d = join(base, `w${i}`); copyTree(fx.dir, d); dirs.push(d); }
/** @type {Record<string, string[]>} */ const denied = Object.fromEntries(ROLES.map((r) => [r, []]));
const jobs = ROLES.flatMap((r) => COMMANDS.map((c) => [r, c]));
let next = 0;
await Promise.all(dirs.map(async (d) => {
  const env = baseEnv(d, { TMPDIR: d + '-tmp', PROOFLINE_ENGINE: 'sh' });
  for (;;) {
    const i = next++; if (i >= jobs.length) return; const [role, cmd] = jobs[i];
    if (role === 'lead' && cmd === 'test') continue;
    const r = await exec(d, { ...env, AGENT_ROLE: role }, [cmd]);
    if (r.code === 1 && r.stderr === `command denied for ${role}: ${cmd}\n`) denied[role].push(cmd);
  }
}));
rmSync(base, { recursive: true, force: true });
for (const r of ROLES) denied[r].sort();
writeFileSync(new URL('./roles.json', import.meta.url), JSON.stringify({ commands: COMMANDS, denied }, null, 1) + '\n');
console.log(ROLES.map((r) => `${r}: ${denied[r].length} denied`).join('\n'));
