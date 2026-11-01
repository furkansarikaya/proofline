// @ts-check
// PreToolUse: the router. The decisions live in guards/; this file only routes by tool name and renders the answer exactly as proofline-hook.sh did.
//
//   Bash (shell, local_shell, exec_command, unified_exec)  -> guards/bash.mjs   export async function bashGuard(input, ctx)
//   Read, Glob, Grep                                        -> guards/read.mjs   export async function readGuard(input, ctx)
//   Write, Edit, MultiEdit, NotebookEdit, *patch* (Codex)   -> guards/write.mjs  export async function writeGuard(input, ctx)
//
// A guard returns null (allow) or { decision: 'deny' | 'ask', reason }. The reason has no "proofline: " prefix: the router adds the prefix, the
// one-line alternative (alt_hint of the shell hook) and the note of a failed moved command (guards/kit.mjs mcFlag), then prints
// {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}} and exits 0, like the shell hook.
// A guard that throws fails closed: the Bash guard always (the merge and kill guards are not run-scoped), the file guards while a run exists.
//
// Shared by the guards (owned by the Bash package, imported by the file-tool guards): guards/kit.mjs (Deny, mcFlag, hook-config, git, stashPath),
// guards/paths.mjs (relpath, path_ok, target_ok, erasable, nr_path_ok, baseline), guards/db.mjs (the database guard's path and token checks).
// Until guards/read.mjs and guards/write.mjs exist, the file-tool events are handed to proofline-hook.sh (a bridge that disappears with them).
import { existsSync } from 'node:fs';
import { isDir, isFile } from '../lib/fsx.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jesc } from '../lib/text.mjs';
import { stateOf, mcText, Deny } from '../guards/kit.mjs';
import { baseline } from '../guards/paths.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));

/** @typedef {{ decision: 'deny' | 'ask', reason: string }} Verdict */

/** `alt_hint MESSAGE` (A200): the one-line permitted alternative for a denial that names none; it only SHOWS the allowed way. @param {string} m @returns {string} */
export function altHint(m) {
  if (/nstead|Allowed|run: |Write the file|wait for the user|proofline merge|Scratch files go under/.test(m)) return '';
  const has = (/** @type {string} */ s) => m.includes(s);
  if (has('is not literal') || has('is not allowed while run')) return 'Instead of $A next write: sh .agents/scripts/agent.sh next (the command word, AGENT_ROLE and the subcommand are literal)';
  if (has('PROOFLINE_DISPATCH')) return 'Instead list by a literal path: ls .agents/local/windows (no glob or find over .agents/local)';
  if (has('outside the project') || has('under $TMPDIR')) return 'Instead: mkdir -p .agents/local/scratch && write there (in a run: .agents/runs/<ID>/scratch/); /tmp is only for git worktrees';
  if (has('git hook bypass') || has('wires the git hooks')) return 'Instead commit without --no-verify or a hooksPath change; fix what the hook names, or ask the user';
  if (has('does not match the caller')) return 'Instead: prefix your own role, AGENT_ROLE=<your role> sh .agents/scripts/agent.sh ...';
  if (has('never as a nested runtime')) return 'Instead: sh .agents/scripts/dispatch.sh <ID> <role>';
  if (has('links into or out of .agents')) return 'Instead: cp the file to the project path you need, or read it where it is';
  if (has('never submits a specialist result') || has('verdicts enter a run only') || has('opened and closed only by')) return 'Instead: dispatch the specialist (sh .agents/scripts/dispatch.sh <ID> <role>); it submits, you read the result with agent.sh next';
  if (has('a subagent never approves')) return 'Instead: put the question to the lead; the user answers and the runtime records it from the reply';
  if (has('read-only agent.sh') || has('runs only agent.sh worker-evidence')) return 'Instead: submit your result with AGENT_ROLE=<role> sh .agents/scripts/agent.sh submit <ID> --agent <token> ...';
  if (has('cannot be resolved') || has('cannot be read from the command text')) return 'Instead: write the path literally, or use the Write tool on an allowed path (.agents/local/scratch/ for scratch files)';
  if (has('destructive SQL') || has('database client') || has('migration, seed or schema') || has('names the database file')) return 'Instead: run the project test command (it builds its own throwaway database) and record what you could not check as an open point';
  if (has('lead writes only') || has('lead never edits') || has('no run is active')) return 'Instead: /proofline run <text>, or dispatch the implementer (sh .agents/scripts/dispatch.sh <ID> implementer) for a product change';
  if (has('is outside the paths role')) return 'Instead: write only inside the paths your role owns (.agents/owns.conf and the PLAN.md scope)';
  if (has('parsed')) return 'Instead: install jq or node, then retry';
  if (has('ACTIVE_RUN is malformed')) return 'Instead: sh .agents/scripts/agent.sh status shows the active run';
  if (has('read-only in the project') || has('changes the project working tree')) return 'Instead: git worktree add --detach "$TMPDIR/<name>" HEAD in its own call, then git -C "$TMPDIR/<name>" ...';
  return '';
}

/** The PreToolUse answer for a verdict (the shell hook's `deny`). @param {import('../lib/context.mjs').HookContext} ctx @param {Verdict} v @param {boolean} [noMc] */
export function render(ctx, v, noMc = false) {
  let msg = v.reason;
  const st = stateOf(ctx);
  if (!noMc && st.mcfail) msg = `${mcText(st.mcfail)} | ${msg}`;
  const alt = noMc ? '' : altHint(msg);
  if (alt !== '') msg = `${msg} | ${alt}`;
  return `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${v.decision}","permissionDecisionReason":"${jesc(`proofline: ${msg}`)}"}}\n`;
}

/** @param {import('../lib/context.mjs').HookContext} ctx @param {string} text */
function denyOut(ctx, text) { return render(ctx, { decision: 'deny', reason: text }); }

/** The shell hook for an event this router cannot judge yet (a bridge). @param {import('../lib/context.mjs').HookContext} ctx */
async function viaShell(ctx) {
  const proc = await ctx.agents?.proc();
  if (!proc) return denyOut(ctx, 'the shell hook cannot be started (core/proc.mjs is missing); failing closed');
  const r = proc.run('sh', [`${here}proofline-hook.sh`, 'pretool', ctx.rt], { input: ctx.raw, stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
  return r.stdout.toString('utf8');
}

/** A193: every proofline skill is disable-model-invocation, so the Skill tool cannot start one; a call that targets a proofline skill is redirected to reading the file. @param {import('../lib/context.mjs').HookContext} ctx @returns {Verdict | null} */
function skillGuard(ctx) {
  let name = ctx.get('tool_input.skill', 'tool_input.name');
  let prefixed = false;
  if (name.startsWith('proofline:')) { prefixed = true; name = name.slice(10); }
  if (name === '' || /[^A-Za-z0-9_-]/.test(name)) return null;
  const plugin = ctx.env.CLAUDE_PLUGIN_ROOT ?? '';
  let file = '';
  if (plugin !== '' && isFile(`${plugin}/skills/${name}/SKILL.md`)) file = `${plugin}/skills/${name}/SKILL.md`;
  else if (isFile(`${ctx.root}/.agents/skills/${name}/SKILL.md`)) file = `${ctx.root}/.agents/skills/${name}/SKILL.md`;
  // without the proofline: prefix the name counts only when no skill of the user's own bears it
  if (!prefixed && (isDir(`${ctx.root}/.claude/skills/${name}`) || isDir(`${ctx.env.HOME || '/nonexistent'}/.claude/skills/${name}`))) file = '';
  return file === '' ? null : { decision: 'deny', reason: `do not use the Skill tool; read ${file} and continue with the same step` };
}

const SHELL_TOOLS = ['Bash', 'shell', 'local_shell', 'exec_command', 'unified_exec'];

/** @param {import('../lib/context.mjs').HookContext} ctx @returns {Promise<string | undefined>} */
export async function handle(ctx) {
  if (!ctx.parsed) {
    if (ctx.act !== '') return denyOut(ctx, `hook input could not be parsed (jq or node is required) while run ${ctx.act} is active; failing closed`);
    return undefined;
  }
  if (ctx.act === 'INVALID') return denyOut(ctx, '.agents/local/ACTIVE_RUN is malformed; fix it with agent.sh before editing');
  await baseline(ctx);
  const input = ctx.input;
  const tool = ctx.get('tool_name');
  // A193: the Skill tool cannot start a proofline skill (they are disable-model-invocation): one line redirects to reading the file
  if (tool === 'Skill' && ctx.installed) {
    const v = skillGuard(ctx);
    return v ? render(ctx, v) : undefined;
  }
  const cmd = SHELL_TOOLS.includes(tool) ? ctx.get('tool_input.command', 'tool_input.cmd') : '';
  /** @type {Verdict | null} */ let verdict = null;
  try {
    if (cmd !== '') {
      if (!existsSync(`${here}guards/bash.mjs`)) return await viaShell(ctx);
      verdict = await (await import(pathToFileURL(`${here}guards/bash.mjs`).href)).bashGuard(input, ctx);
    } else if (!ctx.installed) return undefined;
    else if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
      if (!existsSync(`${here}guards/read.mjs`)) return await viaShell(ctx);
      verdict = await (await import(pathToFileURL(`${here}guards/read.mjs`).href)).readGuard(input, ctx);
    } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) || /[Pp]atch/.test(tool)) {
      if (!existsSync(`${here}guards/write.mjs`)) return await viaShell(ctx);
      verdict = await (await import(pathToFileURL(`${here}guards/write.mjs`).href)).writeGuard(input, ctx);
    }
  } catch (e) {
    if (e instanceof Deny) verdict = { decision: 'deny', reason: e.reason };
    else if (cmd !== '' || ctx.act !== '') return denyOut(ctx, `the PreToolUse guard failed with an internal error (${e instanceof Error ? e.message : String(e)}); failing closed`);
    else throw e;
  }
  if (verdict) return render(ctx, verdict);
  // hk_mcexit: a moved command failed under a guard and nothing denied: the failure itself is the answer
  const f = stateOf(ctx).mcfail;
  if (f) return render(ctx, { decision: 'deny', reason: mcText(f) }, true);
  return undefined;
}
