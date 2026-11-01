// @ts-check
// Measurement (not run by CI): the prompt that records an approval, end to end through the hook (UserPromptSubmit, a plan request standing),
// for the shell hook and the Node hook. A PATH shim logs every external program the hook starts (the hook process itself is counted once more).
//   node tests/bench/hook-approval-path.mjs [repeat]
import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildTemplate, cleanEnv, copyProject, join, mkdirSync, mkdtempSync, nodeHook, readFileSync, rmSync, shellHook, tmpdir, writeFileSync } from '../hook/harness.mjs';

const repeat = Number(process.argv[2] ?? '3');
const template = buildTemplate();
const base = mkdtempSync(join(tmpdir(), 'hook-bench-'));
/** @param {'node' | 'sh'} kind */
function once(kind) {
  const dir = copyProject(template, base);
  spawnSync('sh', ['.agents/scripts/agent.sh', 'request-approval', 'LC', 'plan'], { cwd: dir, env: cleanEnv({ PROOFLINE_ENGINE: 'sh' }) });
  spawnSync('sleep', ['1.1']);
  const shim = join(base, `shim-${kind}`); mkdirSync(shim, { recursive: true });
  const log = join(base, `procs-${kind}.log`); writeFileSync(log, '');
  for (const c of ['awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'sleep', 'ls', 'shasum', 'sha256sum', 'sh', 'jq', 'kill', 'ps', 'paste', 'uniq']) {
    const real = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
    if (!real.startsWith('/')) continue;
    writeFileSync(join(shim, c), `#!/bin/sh\nprintf '%s\\n' ${c} >> '${log}'\nexec ${real} "$@"\n`); chmodSync(join(shim, c), 0o755);
  }
  const env = cleanEnv({ CLAUDE_PROJECT_DIR: dir }); env.PATH = `${shim}:${env.PATH}`;
  const input = JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'plan approved, go ahead' });
  const t0 = Date.now();
  const r = spawnSync(kind === 'node' ? process.execPath : 'sh', [kind === 'node' ? nodeHook : shellHook, 'prompt', 'claude'], { cwd: dir, env, input, encoding: 'utf8' });
  const ms = Date.now() - t0;
  const procs = readFileSync(log, 'utf8').split('\n').filter(Boolean).length + (kind === 'node' ? 1 : 0);
  if (!/approval recorded/.test(r.stdout)) throw new Error(`${kind}: no approval recorded: ${r.stdout}${r.stderr}`);
  return { ms, procs };
}
try {
  for (const kind of /** @type {Array<'sh' | 'node'>} */ (['sh', 'node'])) {
    const runs = Array.from({ length: repeat }, () => once(kind)).sort((a, b) => a.ms - b.ms);
    const m = runs[Math.floor(runs.length / 2)];
    console.log(`prompt-approval ${kind === 'sh' ? 'shell hook' : 'node hook '}  processes=${m.procs}  ms=${m.ms}`);
  }
} finally { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); }
