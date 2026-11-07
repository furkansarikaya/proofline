// @ts-check
// Measurement (A222), not run by CI on its own (tests/bench/exec-budgets.test.mjs runs it): how many external processes the execution-policy, runtime-detection
// and known-issue paths start (the execution decision and the dispatcher are measured by tests/bench/dispatch-procs.mjs since A226), and how many bytes they print. A PATH shim logs every external command (the agent.sh it calls included); shell builtins and
// command-substitution forks are not counted. The count is the number of shim lines: every external command started through the PATH, the measured command
// itself included (`sh agent.sh ...` is one).
//   node tests/bench/exec-procs.mjs        prints `path  procs=N  ms=N  bytes=N  top commands`; REPEAT=<n> (default 3, the median is shown)
// The fixture is a frozen STANDARD run with a failed QA gate, built by the self-test library (tests/core/legacy-lib.mjs) with the Node core beside agent.sh.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanEnv } from '../hook/harness.mjs';
import { A, project, say } from '../core/legacy-lib.mjs';
import { repo } from '../core/helpers.mjs';

const TXT = 'the legacy ignore list drops a documented entry';
const RECIPE = `scaffold standalone no STANDARD autonomous
solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null
A secret-scan LC >/dev/null
for g in $(required); do case "$g" in SECRETS|VERIFY|QA) ;; *) gpass "$g" ;; esac; done
rec QA FAIL high "QA-1|blocking|.gitignore:1|${TXT}|traced: x; scan: grep -n entry .gitignore; instances: single"
gpass VERIFY`;
const SHIMMED = ['sh', 'jq', 'awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'shasum', 'sha256sum', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'perl', 'sleep', 'kill', 'ps', 'ls', 'readlink', 'uname', 'id', 'touch', 'chmod', 'ln', 'xargs', 'expr', 'rmdir'];

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

/** @typedef {{ path: string, procs: number, ms: number, bytes: number, top: string }} Row */

/**
 * @param {{ repeat?: number }} [o]
 * @returns {Row[]}
 */
export function measureAll(o = {}) {
  const repeat = o.repeat ?? 3;
  const work = mkdtempSync(path.join(tmpdir(), 'exec-procs-'));
  try {
    const d = project(RECIPE);
    copyFileSync(path.join(repo, 'control-plane/agents/roles.conf'), path.join(d, '.agents/roles.conf'));
    rmSync(path.join(d, '.agents/scripts/exec-policy.sh'), { force: true });   // the fixture stub: without it the core resolves the policy itself
    const log = path.join(work, 'procs.log');
    const shims = path.join(work, 'shim');
    makeShims(shims, log);
    const core = '.agents/scripts/proofline-core.mjs';
    const KI = '.agents/local/known-issues';
    mkdirSync(`${d}/.agents/tasks/todo`, { recursive: true });
    writeFileSync(`${d}/.agents/tasks/todo/FU-9.md`, '# Task: FU-9 — Fix the legacy ignore list\n\n**Status:** todo\n\n## Goal\n\nFix it.\n');
    const propose = () => A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-9']);
    const approve = () => { say(d, 'approve known issue'); return A(d, ['approve', '-', 'known-issue']); };
    const reset = () => { for (const f of [KI, '.agents/local/approvals', '.agents/local/prompts']) rmSync(path.join(d, f), { recursive: true, force: true }); };
    /** @type {Array<[string, () => void, string[]]>} */
    const paths = [
      ['exec-policy-resolve', () => {}, [core, 'cli', 'exec-policy', 'resolve', '--role', 'implementer', '--class', 'STANDARD', '--tier', 'full', '--signal', 'large_diff']],
      ['runtime-detect-has', () => {}, [core, 'cli', 'runtime-detect', 'has', 'codex']],
      ['runtime-detect-list', () => {}, [core, 'cli', 'runtime-detect']],
      ['known-issue-propose', reset, ['.agents/scripts/agent.sh', 'known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-9']],
      ['known-issue-approve', () => { reset(); propose(); say(d, 'approve known issue'); }, ['.agents/scripts/agent.sh', 'approve', '-', 'known-issue']],
      ['known-issue-apply', () => { reset(); propose(); approve(); }, ['.agents/scripts/agent.sh', 'known-issue-apply']],
      ['known-issue-list', () => { reset(); propose(); approve(); A(d, ['known-issue-apply']); }, ['.agents/scripts/agent.sh', 'known-issue-list']],
      ['known-issue-candidates', () => {}, ['.agents/scripts/agent.sh', 'known-issue-candidates']],
    ];
    /** @type {Row[]} */ const rows = [];
    for (const [name, pre, argv] of paths) {
      // the list and the candidates are read with one record on the list; the other paths start from a clean state
      if (name === 'known-issue-candidates') { reset(); propose(); approve(); A(d, ['known-issue-apply']); }
      /** @type {number[]} */ const counts = []; /** @type {number[]} */ const times = []; let bytes = 0; let top = '';
      for (let i = 0; i <= repeat; i++) {   // the first run is the warm-up and is not measured
        pre();
        writeFileSync(log, '');
        const env = { ...cleanEnv({}), PATH: `${shims}:${process.env.PATH ?? ''}` };
        const t0 = Date.now();
        const r = spawnSync(argv[0].endsWith('.mjs') ? 'node' : 'sh', argv, { cwd: d, env, input: '', encoding: 'utf8', timeout: 300000 });
        const ms = Date.now() - t0;
        if (i === 0) continue;
        const used = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        counts.push(used.length); times.push(ms); bytes = Buffer.byteLength(r.stdout);
        /** @type {Map<string, number>} */ const tally = new Map();
        for (const u of used) tally.set(u, (tally.get(u) ?? 0) + 1);
        top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}=${v}`).join(' ');
      }
      const median = (/** @type {number[]} */ a) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
      rows.push({ path: name, procs: median(counts), ms: median(times), bytes, top });
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** @param {Row[]} rows */
export function table(rows) {
  return rows.map((r) => `${r.path.padEnd(24)} procs=${String(r.procs).padEnd(4)} ms=${String(r.ms).padEnd(6)} bytes=${String(r.bytes).padEnd(6)} ${r.top}`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(table(measureAll({ repeat: Number(process.env.REPEAT ?? 3) })));
}
