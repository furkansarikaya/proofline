// @ts-check
// Measurement (A229), not run by CI on its own (tests/bench/helper-budgets.test.mjs runs it): how many external processes the helper commands start
// (build-record, friction report, lessons, rules, calibrate) on one fixture project. A PATH shim logs every external command (the launcher `sh`, node, git ...);
// shell builtins and command-substitution forks are not counted. The count is the number of shim lines: every external command started through the PATH,
// the measured command itself included.
//   node tests/bench/helper-procs.mjs        prints `path  procs=N  ms=N  top commands`; REPEAT=<n> (default 3, the median is shown)
// The same file measures the shell form of 0.0.62 (copy it into a checkout of that commit's tests/bench/): it installs the helper scripts when they exist.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanEnv } from '../hook/harness.mjs';
import { project } from '../core/legacy-lib.mjs';
import { repo } from '../core/helpers.mjs';

const SHIMMED = ['sh', 'jq', 'awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'shasum', 'sha256sum', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'perl', 'sleep', 'kill', 'ps', 'ls', 'readlink', 'uname', 'id', 'touch', 'chmod', 'ln', 'xargs', 'expr', 'rmdir', 'od', 'cksum', 'pwd', 'tee', 'uniq', 'comm', 'env', 'printf', 'test', 'timeout', 'tail', 'mkfifo'];

/** @param {string} dir @param {string} log */
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

/** @typedef {{ path: string, procs: number, ms: number, top: string }} Row */

const GATE = 'task_id: "LC"\ngate: "REVIEW_SMALL"\nresult: "fail"\nfocus: "rules+tests"\nfinding: REVIEW_SMALL-1|blocking|impl.txt:1|empty key returns nil|traced\nfinding: REVIEW_SMALL-2|blocking|impl.txt:3|second finding|traced\n';
const RULES = '# Project\n\n## Project rules\n\n- Always validate the request body before calling the repository layer.\n- Validate the request body before calling the repository layer, always.\n- Never use raw SQL strings in handlers.\n- Always use raw SQL strings in handlers for reports.\n- Name test files after the unit they cover.\n';

/** @param {{ repeat?: number }} [o] @returns {Row[]} */
export function measureAll(o = {}) {
  const repeat = o.repeat ?? 3;
  const work = mkdtempSync(path.join(tmpdir(), 'helper-procs-'));
  try {
    const d = project('scaffold standalone no STANDARD manual');
    const a = path.join(d, '.agents');
    for (const f of ['build-record.sh', 'friction.sh', 'lessons.sh', 'rules.sh']) {
      const src = path.join(repo, 'control-plane/agents/scripts', f);
      if (existsSync(src)) copyFileSync(src, path.join(a, 'scripts', f));
    }
    const cfg = path.join(a, 'config.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^ {2}build:.*$/m, '  build: echo built').replace(/^ {2}test:.*$/m, '  test: echo tested'));
    mkdirSync(path.join(a, 'runs/LC/gates'), { recursive: true });
    writeFileSync(path.join(a, 'runs/LC/gates/001-REVIEW_SMALL.yaml'), GATE);
    mkdirSync(path.join(a, 'local/metrics'), { recursive: true });
    copyFileSync(path.join(repo, 'tests/fixtures/friction/LEDGER.log'), path.join(a, 'runs/LC/LEDGER.log'));
    copyFileSync(path.join(repo, 'tests/fixtures/friction/records.jsonl'), path.join(a, 'local/metrics/records.jsonl'));
    writeFileSync(path.join(d, 'AGENTS.md'), RULES);
    spawnSync('git', ['add', '-A'], { cwd: d, env: cleanEnv({}) });
    spawnSync('git', ['-c', 'user.name=fx', '-c', 'user.email=fx@example.invalid', 'commit', '-q', '-m', 'fx'], { cwd: d, env: cleanEnv({}) });
    const log = path.join(work, 'procs.log');
    const shims = path.join(work, 'shim');
    makeShims(shims, log);
    const reset = () => { for (const f of ['.agents/local/builds', '.agents/local/friction']) rmSync(path.join(d, f), { recursive: true, force: true }); };
    /** @type {Array<[string, string[]]>} */
    const paths = [
      ['build-record-run', ['.agents/scripts/agent.sh', 'build-record', 'LC', 'run']],
      ['build-record-show', ['.agents/scripts/agent.sh', 'build-record', 'LC', 'show']],
      ['friction-report', ['.agents/scripts/agent.sh', 'friction', 'report', 'LC']],
      ['calibrate', ['.agents/scripts/agent.sh', 'calibrate']],
      ['lessons-derive', ['.agents/scripts/agent.sh', 'lessons', 'derive', 'LC']],
      ['lessons-count', ['.agents/scripts/agent.sh', 'lessons', 'count']],
      ['rules-report', ['.agents/scripts/agent.sh', 'rules', 'report']],
    ];
    /** @type {Row[]} */ const rows = [];
    for (const [name, argv] of paths) {
      /** @type {number[]} */ const counts = []; /** @type {number[]} */ const times = []; let top = '';
      for (let i = 0; i <= repeat; i++) {   // the first run is the warm-up and is not measured
        if (name === 'build-record-run') reset();
        if (name === 'build-record-show' && i === 0) spawnSync('sh', ['.agents/scripts/agent.sh', 'build-record', 'LC', 'run'], { cwd: d, env: cleanEnv({}), input: '', encoding: 'utf8' });
        writeFileSync(log, '');
        const env = { ...cleanEnv({}), PATH: `${shims}:${process.env.PATH ?? ''}` };
        const t0 = Date.now();
        const r = spawnSync('sh', argv, { cwd: d, env, input: '', encoding: 'utf8', timeout: 300000 });
        const ms = Date.now() - t0;
        if (r.status !== 0) throw new Error(`${name} exited ${r.status}: ${r.stderr}${r.stdout}`);
        if (i === 0) continue;
        const used = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        counts.push(used.length); times.push(ms);
        /** @type {Map<string, number>} */ const tally = new Map();
        for (const u of used) tally.set(u, (tally.get(u) ?? 0) + 1);
        top = [...tally].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ');
      }
      const median = (/** @type {number[]} */ a2) => [...a2].sort((x, y) => x - y)[Math.floor((a2.length - 1) / 2)];
      rows.push({ path: name, procs: median(counts), ms: median(times), top });
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** @param {Row[]} rows */
export function table(rows) {
  return rows.map((r) => `${r.path.padEnd(20)} procs=${String(r.procs).padEnd(4)} ms=${String(r.ms).padEnd(6)} ${r.top}`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(table(measureAll({ repeat: Number(process.env.REPEAT ?? 3) })));
}
