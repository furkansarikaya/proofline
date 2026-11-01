// @ts-check
// Measurement (not run by CI): the cost of the step the prompt hook runs when a prompt records an approval, `agent.sh approve-pending <ID>`, on a
// run with a pending plan request. A PATH shim logs every external program the step starts (the shell engine: 544 processes and 3.4 s for the whole
// hook in 0.0.40; stage 3 target: at most 5 processes and 500 ms for the hook, of which this step is the part that matters).
//   node tests/bench/approval-path.mjs [repeat]
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureBytes } from '../../control-plane/agents/scripts/core/capture.mjs';
import { baseEnv } from '../equivalence/fixture.mjs';
import { stateFixture } from '../equivalence/cases/stage2-fixtures.mjs';

const repeat = Number(process.argv[2] ?? '3');
const fx = stateFixture('gates-pending-plan');
/** @param {'sh' | 'node'} engine */
function once(engine) {
  const base = mkdtempSync(path.join(tmpdir(), 'pl-bench-'));
  try {
    const dir = path.join(base, 'fx');
    cpSync(fx.dir, dir, { recursive: true });
    mkdirSync(path.join(base, 'shim'));
    const log = path.join(base, 'procs.log');
    for (const c of ['awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'sleep', 'ls', 'shasum', 'sha256sum', 'sh', 'paste', 'uniq']) {
      const real = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
      if (!real.startsWith('/')) continue;
      writeFileSync(path.join(base, 'shim', c), `#!/bin/sh\nprintf '%s\\n' ${c} >> '${log}'\nexec ${real} "$@"\n`);
      chmodSync(path.join(base, 'shim', c), 0o755);
    }
    mkdirSync(path.join(dir, '.agents/local/prompts'), { recursive: true });
    writeFileSync(path.join(dir, '.agents/local/prompts/s1.json'), captureBytes('s1', 4102444800, 'approve the plan'));
    const env = baseEnv(dir, { PATH: `${path.join(base, 'shim')}:${process.env.PATH}`, ...(engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}) });
    delete env.PROOFLINE_NO_TTY;
    writeFileSync(log, '');
    const t0 = Date.now();
    const r = spawnSync('sh', [path.join(dir, '.agents/scripts/agent.sh'), 'approve-pending', 'LC'], { cwd: dir, env, encoding: 'utf8' });
    const ms = Date.now() - t0;
    const procs = readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
    if (!/approved/.test(r.stdout)) throw new Error(`no approval recorded: ${r.stdout}${r.stderr}`);
    return { ms, procs };
  } finally { rmSync(base, { recursive: true, force: true }); }
}
for (const engine of /** @type {Array<'sh' | 'node'>} */ (['sh', 'node'])) {
  const runs = Array.from({ length: repeat }, () => once(engine)).sort((a, b) => a.ms - b.ms);
  const m = runs[Math.floor(runs.length / 2)];
  console.log(`approve-pending ${engine === 'sh' ? 'shell' : 'node '}  processes=${m.procs}  ms=${m.ms}`);
}
