#!/usr/bin/env node
// @ts-check
// proofline runtime hook, Node form (ADR 0001 stage 3): one Node process per event for Claude Code and Codex. It replaces proofline-hook.sh,
// which stays beside it as the specification and as the rollback target (`sh` in .agents/local/engine hands the event to it).
//
//   node proofline-hook.mjs <pretool|posttool|subagent-start|subagent-stop|prompt|stop|session> [claude|codex]
//
// stdin: the runtime's hook JSON. Output and exit codes are those of proofline-hook.sh. The project's core is imported in process
// (<root>/.agents/scripts/proofline-core.mjs, A194), so a plugin and a project of different versions behave as they did with agent.sh.
//
// Layout: this file reads the input, builds the context (lib/context.mjs), hands the event to events/<name>.mjs and prints what it returns.
//   events/<name>.mjs  export async function handle(ctx): Promise<string | undefined>   the stdout line (with its newline) or nothing
//   lib/               text (jesc, jget, safe, sha), fsx (writes that refuse links), agent (the project's commands), context
// An unexpected exception fails closed: PreToolUse denies while a run exists; the other events print the error on stderr and exit 1.
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineFileValue } from './lib/agent.mjs';
import { EVENTS, buildContext, finish } from './lib/context.mjs';
import { rmf } from './lib/fsx.mjs';
import { yieldsToOtherWiring } from './lib/yield.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));

/** @returns {Buffer} */
function readStdin() {
  try { return readFileSync(0); } catch { return Buffer.alloc(0); }
}

/** @param {number} fd @param {string} text */
function writeOut(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try { off += writeSync(fd, buf, off); } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'EAGAIN') continue;
      return;
    }
  }
}

/** The shell hook, for the events this file does not own yet and for the rollback switch. @param {import('./lib/context.mjs').HookContext} c @param {Buffer} raw */
async function handToShell(c, raw) {
  const proc = await c.agents?.proc();
  if (!proc) {
    writeOut(2, 'proofline: the project has no core/proc.mjs, so the shell hook cannot be started\n');
    return c.ev === 'pretool' ? 2 : 0;
  }
  const r = proc.run('sh', [`${here}proofline-hook.sh`, c.ev, c.rt], { input: raw, stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
  return r.status;
}

/** @param {import('./lib/context.mjs').HookContext} c @param {unknown} e */
function failClosed(c, e) {
  const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
  if (c.ev === 'pretool' && (c.act !== '' || !c.installed)) {
    if (c.installed) writeOut(1, `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `proofline: the hook failed with an internal error while run ${c.act} is active; failing closed` } })}\n`);
    writeOut(2, `proofline: internal error in the ${c.ev} hook: ${text}\n`);
    return 0;
  }
  writeOut(2, `proofline: internal error in the ${c.ev} hook: ${text}\n`);
  return c.ev === 'pretool' ? 0 : 1;
}

/** @param {string[]} argv @returns {Promise<number>} the exit status */
export async function main(argv) {
  const ev = argv[0] ?? '';
  const rt = argv[1] ?? 'claude';
  if (yieldsToOtherWiring(here, ev, rt, process.env)) return 0;   // the same event is wired by the old shell string (or by the project, for the plugin): handled once
  const raw = readStdin();
  const c = await buildContext(ev, rt, raw, process.env);
  if (!c) return 0;
  try {
    if (c.ev !== 'pretool' && !c.installed) return 0;
    if (!EVENTS.includes(ev)) { writeOut(2, 'usage: proofline-hook.mjs <pretool|posttool|subagent-start|subagent-stop|prompt|stop|session> [claude|codex]\n'); return 0; }
    // the engine switch: `sh` in <main tree>/.agents/local/engine (or PROOFLINE_ENGINE=sh) hands the event to the old shell hook
    if (engineFileValue(c.mainRoot) === 'sh' || process.env.PROOFLINE_ENGINE === 'sh' || !existsSync(`${here}events/${ev}.mjs`)) {
      rmf(c.mark); c.mark = '';
      return await handToShell(c, raw);
    }
    const mod = await import(pathToFileURL(`${here}events/${ev}.mjs`).href);
    const out = await mod.handle(c);
    if (typeof out === 'string' && out !== '') writeOut(1, out);
    return 0;
  } catch (e) {
    return failClosed(c, e);
  } finally {
    finish(c);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { writeOut(2, `proofline: ${e instanceof Error ? e.stack : e}\n`); process.exitCode = 1; });
}
