// @ts-check
// Measurement (A226), not run by CI on its own (tests/bench/dispatch-budgets.test.mjs runs it): how many external processes the execution decision and a whole
// dispatch start, with a fake runtime. A PATH shim logs every external command (the dispatch launcher, node, git ... ); shell builtins and command-substitution forks
// are not counted. The count is the number of shim lines: every external command started through the PATH, the measured command itself included. The fake
// runtime restores the real PATH before it starts anything, so what IT starts is not counted: the number is the dispatcher's own overhead.
//   node tests/bench/dispatch-procs.mjs        prints `path  procs=N  ms=N  top commands`; REPEAT=<n> (default 3, the median is shown)
// The same file measures the shell dispatcher of 0.0.57 (copy it into a checkout of that commit's tests/bench/): it uses only what both trees have.
// The fixture is the scaffold of the self-test library (run LC, STANDARD, frozen, IMPLEMENTING, orchestrated) with the Node core beside agent.sh.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanEnv } from '../hook/harness.mjs';
import { project } from '../core/legacy-lib.mjs';
import { repo } from '../core/helpers.mjs';

const SHIMMED = ['sh', 'jq', 'awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'shasum', 'sha256sum', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'perl', 'sleep', 'kill', 'ps', 'ls', 'readlink', 'uname', 'id', 'touch', 'chmod', 'ln', 'xargs', 'expr', 'rmdir', 'od', 'cksum', 'pwd', 'tee', 'uniq', 'comm', 'env', 'printf', 'test'];
const FAKE = `#!/bin/sh
# a fake runtime: restore the real PATH first (what it starts is not the dispatcher's), write the submission status, print what the runtime would
PATH=$REAL_PATH; export PATH
o=''; while [ $# -gt 0 ]; do [ "$1" = -o ] && o=$2; shift; done
[ -z "$o" ] || echo "done" > "$o"
cat > /dev/null
mkdir -p "$FAKE_ROOT/.agents/local/submissions"
printf 'status=ok\\ntask=LC\\nrole=%s\\nresult=DONE\\ngate=\\nraw=results/001-%s.result.md\\n' "$AGENT_ROLE" "$AGENT_ROLE" > "$FAKE_ROOT/.agents/local/submissions/$PROOFLINE_AGENT.status"
echo '{"type":"result","is_error":false,"result":"done"}'
`;

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

/** @typedef {{ path: string, procs: number, ms: number, top: string }} Row */

/** @param {{ repeat?: number }} [o] @returns {Row[]} */
export function measureAll(o = {}) {
  const repeat = o.repeat ?? 3;
  const work = mkdtempSync(path.join(tmpdir(), 'dispatch-procs-'));
  try {
    const d = project('scaffold orchestrated no STANDARD autonomous');
    const a = path.join(d, '.agents');
    copyFileSync(path.join(repo, 'control-plane/agents/roles.conf'), path.join(a, 'roles.conf'));
    rmSync(path.join(a, 'scripts/exec-policy.sh'), { force: true });   // the fixture stub: without it the core resolves the policy itself
    copyFileSync(path.join(repo, 'control-plane/agents/scripts/dispatch.sh'), path.join(a, 'scripts/dispatch.sh'));
    for (const r of ['implementer', 'reviewer']) { mkdirSync(path.join(a, 'roles'), { recursive: true }); writeFileSync(path.join(a, 'roles', `${r}.md`), `You are the proofline ${r}.\n`); }
    const cfg = path.join(a, 'config.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^ {2}worker: claude$/m, '  worker: codex'));
    const bin = path.join(work, 'bin');
    mkdirSync(bin);
    for (const n of ['fake-codex', 'fake-claude']) { writeFileSync(path.join(bin, n), FAKE); chmodSync(path.join(bin, n), 0o755); }
    mkdirSync(path.join(a, 'hooks'), { recursive: true }); mkdirSync(path.join(d, '.claude'), { recursive: true });
    writeFileSync(path.join(a, 'hooks/proofline-hook.mjs'), '0;\n');
    writeFileSync(path.join(d, '.claude/settings.json'), '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node .agents/hooks/proofline-hook.mjs pretool claude"}]}]}}\n');
    const log = path.join(work, 'procs.log');
    const shims = path.join(work, 'shim');
    makeShims(shims, log);
    const reset = () => { for (const f of ['.agents/runs/LC/dispatch', '.agents/runs/LC/results', '.agents/local/submissions', '.agents/local/metrics']) rmSync(path.join(d, f), { recursive: true, force: true }); };
    /** @type {Array<[string, string[]]>} */
    const paths = [
      ['decide-dry', ['.agents/scripts/agent.sh', 'decide', 'LC', 'implementer', '--dry']],
      ['dispatch-implementer-codex', ['.agents/scripts/dispatch.sh', 'LC', 'implementer']],
      ['dispatch-reviewer-claude', ['.agents/scripts/dispatch.sh', 'LC', 'reviewer', '--focus', 'rules']],
    ];
    /** @type {Row[]} */ const rows = [];
    for (const [name, argv] of paths) {
      /** @type {number[]} */ const counts = []; /** @type {number[]} */ const times = []; let top = '';
      for (let i = 0; i <= repeat; i++) {   // the first run is the warm-up and is not measured
        reset();
        writeFileSync(log, '');
        const env = { ...cleanEnv({}), PATH: `${shims}:${process.env.PATH ?? ''}`, REAL_PATH: process.env.PATH ?? '', FAKE_ROOT: d, PROOFLINE_CODEX_BIN: path.join(bin, 'fake-codex'), PROOFLINE_CLAUDE_BIN: path.join(bin, 'fake-claude') };
        const t0 = Date.now();
        const r = spawnSync('sh', argv, { cwd: d, env, input: '', encoding: 'utf8', timeout: 300000 });
        const ms = Date.now() - t0;
        if (name !== 'decide-dry' && r.status !== 0) throw new Error(`${name} exited ${r.status}: ${r.stderr}${r.stdout}`);
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
  return rows.map((r) => `${r.path.padEnd(28)} procs=${String(r.procs).padEnd(4)} ms=${String(r.ms).padEnd(6)} ${r.top}`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(table(measureAll({ repeat: Number(process.env.REPEAT ?? 3) })));
}
