// @ts-check
// Measurement (A188, in Node since A244), run by tests/hook/budgets.test.mjs and by the nightly Windows job: how many external processes one run of the runtime hook starts per event,
// and how long it takes. A PATH shim logs every external command the hook (and the agent.sh it calls) executes; shell builtins and command-substitution forks are not counted, so on
// Windows (Git Bash, where every fork is slow) the real cost is higher than the count suggests.
//   node tests/bench/hook-procs.mjs [HOOK-SCRIPT]    prints `event  execs  ms  top commands`; set REPEAT=<n> (default 3, the median is shown)
//   HP_TRACE=1 prints the log of every measured run to stderr; HP_LIMIT_MS=<ms> fails when the slowest event is slower (a gate for a quiet machine, not for CI).
// The fixture is a COMPLEX orchestrated run frozen at IMPLEMENTING (the harness scaffold, the Node core beside agent.sh); the shipped git hook launchers and the hook folder are installed in it.
import { tempDir } from '../lib/tempdir.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { A, agentsSrc, cleanEnv, git, project, repo, waitUntil } from '../lib/harness.mjs';

const SHIMMED = ['jq', 'awk', 'sed', 'tr', 'cat', 'dirname', 'basename', 'date', 'mkdir', 'find', 'git', 'grep', 'cut', 'shasum', 'sha256sum', 'head', 'tail', 'wc', 'mv', 'rm', 'cp', 'sort', 'mktemp', 'node', 'perl', 'sleep', 'kill', 'ps', 'ls', 'readlink', 'uname', 'id', 'touch', 'chmod', 'ln', 'xargs', 'expr', 'rmdir', 'stat', 'sh', 'tee', 'env', 'od', 'uniq'];
export const EVENTS = ['pretool-write-impl', 'pretool-read', 'pretool-bash', 'posttool', 'prompt-plain', 'prompt-approval', 'stop', 'session', 'subagent-start', 'subagent-stop'];

/** @typedef {{ event: string, execs: number, ms: number, top: string }} Row */

/** A folder of shims that log their name to LOG (with the first 70 characters of the arguments when TRACE) and run the real program. @param {string} dir @param {string} log @param {boolean} trace */
function makeShims(dir, log, trace) {
  mkdirSync(dir, { recursive: true });
  for (const c of SHIMMED) {
    const real = spawnSync('sh', ['-c', 'command -v "$1"', 'x', c], { encoding: 'utf8' }).stdout.trim();
    if (!real.startsWith('/')) continue;
    const pl = trace ? `printf '%s %.70s\\n' '${c}' "$*" >> '${log}'` : `printf '%s\\n' '${c}' >> '${log}'`;
    writeFileSync(path.join(dir, c), `#!/bin/sh\n${pl}\nexec '${real}' "$@"\n`);
    chmodSync(path.join(dir, c), 0o755);
  }
}

/**
 * Measure every event once per repeat; the median count and time is the row.
 * @param {{ hook?: string, repeat?: number, trace?: boolean }} [o] @returns {Row[]}
 */
export function measureAll(o = {}) {
  const hook = o.hook ?? path.join(repo, 'adapters/claude/hooks/proofline-hook.mjs');
  const repeat = o.repeat ?? 3;
  const work = tempDir('hook-procs-');
  try {
    const d = project({ topology: 'orchestrated' });
    mkdirSync(path.join(d, '.agents/githooks'), { recursive: true }); mkdirSync(path.join(d, '.agents/hooks'), { recursive: true }); mkdirSync(path.join(d, 'src'), { recursive: true });
    for (const f of ['pre-commit', 'pre-push']) cpSync(path.join(agentsSrc, 'githooks', f), path.join(d, '.agents/githooks', f));   // the shipped launchers: a commit or push costs one node plus the git calls
    cpSync(path.dirname(hook), path.join(d, '.agents/hooks'), { recursive: true });
    appendFileSync(path.join(d, '.git/info/exclude'), '.agents/githooks/\n.agents/hooks/\n');
    git(d, ['config', 'core.hooksPath', '.agents/githooks']); git(d, ['config', 'commit.gpgsign', 'false']);
    const log = path.join(work, 'procs.log'); const shims = path.join(work, 'shim');
    makeShims(shims, log, Boolean(o.trace));
    const env = (/** @type {string} */ PATH) => {
      const e = cleanEnv({ CLAUDE_PROJECT_DIR: d, PROOFLINE_NO_TTY: '1' });   // the runtime always sets CLAUDE_PROJECT_DIR
      delete e.CLAUDE_PLUGIN_ROOT; delete e.PROOFLINE_JSON;
      return { ...e, PATH };
    };
    const hookRun = (/** @type {string} */ event, /** @type {string} */ json, /** @type {string} */ PATH) =>
      spawnSync('node', [hook, event, 'claude'], { cwd: d, env: env(PATH), input: json, encoding: 'utf8', timeout: 300000 });
    const j = (/** @type {string} */ name, /** @type {string} */ extra) => `{"hook_event_name":"${name}","session_id":"s1","cwd":"${d}"${extra}}`;
    const sub = ',"agent_type":"proofline-implementer","agent_id":"a1"';
    const realPath = process.env.PATH ?? '';
    hookRun('subagent-start', j('SubagentStart', sub), realPath);   // opens the implementer's window, so the write below is allowed
    const noLock = () => rmSync(path.join(d, '.agents/local/hooklock'), { recursive: true, force: true });   // the duplicate guard (once) would turn a fast hook's repeated run into a no-op
    const approval = () => { noLock(); A(d, ['request-approval', 'LC', 'plan']); waitUntil(Math.floor(Date.now() / 1000) + 1); };   // the hook's message is stamped after the request (the next second), as with a user
    /** @type {Array<[string, string, string, () => void]>} */
    const cases = [
      ['pretool-write-impl', 'pretool', j('PreToolUse', `,"tool_name":"Write","tool_input":{"file_path":"impl.txt"}${sub}`), noLock],
      ['pretool-read', 'pretool', j('PreToolUse', ',"tool_name":"Read","tool_input":{"file_path":"src/a.txt"}'), noLock],
      ['pretool-bash', 'pretool', j('PreToolUse', ',"tool_name":"Bash","tool_input":{"command":"git status --short"}'), noLock],
      ['posttool', 'posttool', j('PostToolUse', ',"tool_name":"Agent","tool_input":{},"tool_response":{}'), noLock],
      ['prompt-plain', 'prompt', j('UserPromptSubmit', ',"prompt":"looks fine, thanks"'), noLock],
      ['prompt-approval', 'prompt', j('UserPromptSubmit', ',"prompt":"plan approved, go ahead"'), approval],
      ['stop', 'stop', j('Stop', ',"stop_hook_active":false,"last_assistant_message":"done"'), noLock],
      ['session', 'session', j('SessionStart', ''), noLock],
      ['subagent-start', 'subagent-start', j('SubagentStart', sub), noLock],
      ['subagent-stop', 'subagent-stop', j('SubagentStop', `,"stop_hook_active":false${sub},"last_assistant_message":"done"`), noLock],
    ];
    const median = (/** @type {number[]} */ a) => [...a].sort((x, y) => x - y)[Math.floor((a.length + 1) / 2) - 1];
    /** @type {Row[]} */ const rows = [];
    for (const [name, event, json, pre] of cases) {
      pre(); hookRun(event, json, realPath);   // warm-up: first-run state (baseline, folders) is not measured
      /** @type {number[]} */ const counts = []; /** @type {number[]} */ const times = []; let top = '';
      for (let i = 0; i < repeat; i++) {
        pre();
        writeFileSync(log, '');
        const t0 = performance.now();
        hookRun(event, json, `${shims}${path.delimiter}${realPath}`);
        times.push(Math.round(performance.now() - t0));
        const used = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        counts.push(used.length);
        if (o.trace) process.stderr.write(`--- ${name}\n${used.join('\n')}\n`);
        /** @type {Map<string, number>} */ const tally = new Map();
        for (const u of used) tally.set(u, (tally.get(u) ?? 0) + 1);
        top = [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1)).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(' ');
      }
      rows.push({ event: name, execs: median(counts), ms: median(times), top });
    }
    return rows;
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The table as the shell script printed it (the budget test and the Windows job summary read it). @param {Row[]} rows */
export function table(rows) {
  const slowest = [...rows].sort((a, b) => b.ms - a.ms)[0];
  return `${rows.map((r) => `${r.event.padEnd(22)} execs=${String(r.execs).padEnd(4)} ms=${String(r.ms).padEnd(6)} ${r.top}`).join('\n')}\nslowest: ${slowest.event} ${slowest.ms} ms (runtime limit 30000)\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = measureAll({ ...(process.argv[2] ? { hook: path.resolve(process.argv[2]) } : {}), repeat: Number(process.env.REPEAT ?? 3), trace: Boolean(process.env.HP_TRACE) });
  process.stdout.write(table(rows));
  const limit = Number(process.env.HP_LIMIT_MS ?? 0);
  const slowest = Math.max(...rows.map((r) => r.ms));
  if (limit && slowest > limit) { process.stderr.write(`slower than HP_LIMIT_MS=${process.env.HP_LIMIT_MS}\n`); process.exitCode = 1; }
}
