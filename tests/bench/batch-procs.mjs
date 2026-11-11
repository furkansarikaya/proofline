// @ts-check
// Measurement (A225), not run by CI on its own (tests/bench/batch-budgets.test.mjs runs it): how many external processes the read-oriented night-mode commands
// start (batch-next, batch-status, batch-answers) and how many bytes they print. A PATH shim logs every external command (the agent.sh it calls included); shell
// builtins and command-substitution forks are not counted. The count is the number of shim lines: every external command started through the PATH, the measured
// command itself included (`sh agent.sh ...` is one).
//   node tests/bench/batch-procs.mjs        prints `path  procs=N  ms=N  bytes=N  top commands`; REPEAT=<n> (default 3, the median is shown)
// The fixture is an approved batch of four tasks after a partial run: T-1 merged, T-2 parked on a question, T-3 merged, T-4 skipped (it depends on T-2),
// with the pre-flight answers of a plan that asked three questions. Built with the helpers of tests/core/batch-lib.mjs (the project of the self-test library with
// the control-plane scripts beside it).
import { tempDir } from '../lib/tempdir.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanEnv } from '../hook/harness.mjs';
import { AB, batchApprove, behave, bnew, binstall, drive, fakes, mktask, put } from '../core/batch-lib.mjs';

const SHIMMED = ['sh', 'jq', 'awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'shasum', 'sha256sum', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'perl', 'sleep', 'kill', 'ps', 'ls', 'readlink', 'uname', 'id', 'touch', 'chmod', 'ln', 'xargs', 'expr', 'rmdir', 'od', 'stat', 'gh'];

/** A folder of shims that log their name to LOG and run the real program. @param {string} dir @param {string} log */
function makeShims(dir, log) {
  mkdirSync(dir, { recursive: true });
  for (const c of SHIMMED) {
    const r = spawnSync('sh', ['-c', 'command -v "$1"', 'x', c], { encoding: 'utf8' });
    const real = r.stdout.trim();
    if (!real.startsWith('/')) continue;
    writeFileSync(path.join(dir, c), `#!/bin/sh\nprintf '%s\\n' '${c}' >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(path.join(dir, c), 0o755);
  }
}

/** @typedef {{ path: string, procs: number, ms: number, bytes: number, top: string, byProgram: Record<string, number> }} Row */

/** @param {{ repeat?: number }} [o] @returns {Row[]} */
export function measureAll(o = {}) {
  const repeat = o.repeat ?? 3;
  const work = tempDir('batch-procs-');
  try {
    const F = fakes();
    const d = bnew();
    mktask(d, 'T-1', 'COMPLEX'); mktask(d, 'T-2', 'COMPLEX'); mktask(d, 'T-3', 'COMPLEX'); mktask(d, 'T-4', 'COMPLEX', 'T-2');
    put(`${d}/.agents/tasks/P-1.md`, '# Task: P-1 — wide\n\n## Goal\n\nIt works.\n\n## Context\n\nFixture.\n\n## Acceptance criteria\n\n- AC-1: the output is better\n\n## Out of scope\n\n- Other changes.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\nCOMPLEX because it is wide\n');
    binstall(d);
    const plan = AB(F, d, ['batch-plan', 'T-1', 'T-2', 'T-3', 'T-4', 'P-1']);
    if (plan.status !== 0) throw new Error(`batch-plan: ${plan.text}`);
    batchApprove(d);
    behave(F, 'T-2', 'question');
    drive(F, d);
    put(`${d}/.agents/local/prompts/history/${Math.floor(Date.now() / 1000) + 10}-aaaa1111.txt`, 'Q1 a, Q2 a\n');
    AB(F, d, ['batch-answer']);
    const log = path.join(work, 'procs.log');
    const shims = path.join(work, 'shim');
    makeShims(shims, log);
    /** @type {Array<[string, string[]]>} */
    const paths = [
      ['batch-next', ['.agents/scripts/agent.sh', 'batch-next']],
      ['batch-next-tsv', ['.agents/scripts/agent.sh', 'batch-next', '--tsv']],
      ['batch-status', ['.agents/scripts/agent.sh', 'batch-status']],
      ['batch-answers', ['.agents/scripts/agent.sh', 'batch-answers']],
    ];
    /** @type {Row[]} */ const rows = [];
    for (const [name, argv] of paths) {
      /** @type {number[]} */ const counts = []; /** @type {number[]} */ const times = []; let bytes = 0; let top = ''; /** @type {Record<string, number>} */ let byProgram = {};
      for (let i = 0; i <= repeat; i++) {   // the first run is the warm-up and is not measured
        writeFileSync(log, '');
        const env = { ...cleanEnv({}), ...F.env, PATH: `${shims}:${F.env.PATH}` };
        const t0 = Date.now();
        const r = spawnSync('sh', argv, { cwd: d, env, input: '', encoding: 'utf8', timeout: 300000 });
        const ms = Date.now() - t0;
        if (i === 0) continue;
        if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
        const used = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        counts.push(used.length); times.push(ms); bytes = Buffer.byteLength(r.stdout);
        /** @type {Map<string, number>} */ const tally = new Map();
        for (const u of used) tally.set(u, (tally.get(u) ?? 0) + 1);
        byProgram = Object.fromEntries(tally);
        top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(' ');
      }
      const median = (/** @type {number[]} */ a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
      rows.push({ path: name, procs: median(counts), ms: median(times), bytes, top, byProgram });
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** @param {Row[]} rows */
export function table(rows) {
  return rows.map((r) => `${r.path.padEnd(18)} procs=${String(r.procs).padEnd(4)} ms=${String(r.ms).padEnd(6)} bytes=${String(r.bytes).padEnd(6)} ${r.top}`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(table(measureAll({ repeat: Number(process.env.REPEAT ?? 3) })));
}
