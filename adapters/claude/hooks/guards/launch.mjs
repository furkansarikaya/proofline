// @ts-check
// PreToolUse guard of the Agent (Task) tool (A333). The lead may launch the implementer subagent only while its write window can be opened:
// SubagentStart opens the window with `window-open`, and a refusal there does not stop the subagent, which then runs with no window (it once
// wrote a test file through an interpreter program, the tree check caught it, and the run stopped on a `tree` approval). Here the same
// `window-open` is asked BEFORE the launch; a refusal denies the launch and names the missing step. Other roles are never touched.
// window-open is idempotent (it prints the tree fingerprint; its one write is the A329 planning window, which SubagentStart would write too).
import { deny } from './kit.mjs';
import { jget } from '../lib/text.mjs';

/** @typedef {import('../lib/context.mjs').HookContext} Ctx */

/** The proofline role a launch asks for ('' for any other subagent). @param {string} t */
export function launchRole(t) {
  const name = t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t;
  return name === 'proofline-implementer' ? 'implementer' : '';
}

/** @param {unknown} input @param {Ctx} ctx */
export async function launchGuard(input, ctx) {
  if (!ctx.installed || ctx.sub || ctx.act === '' || ctx.act === 'INVALID') return null;
  const tool = jget(input ?? ctx.input, 'tool_name');
  if (tool !== 'Agent' && tool !== 'Task') return null;
  if (launchRole(ctx.get('tool_input.subagent_type', 'tool_input.agent_type')) !== 'implementer') return null;
  const id = ctx.act;
  const w = await ctx.agent(['window-open', id, 'implementer']);
  if (w.status === 0) return null;
  const why = `${w.stderr}${w.stdout}`.replace(/\s+/g, ' ').trim();
  let step = '';
  if (/only while handoff state is IMPLEMENTING/.test(why)) {
    step = `Missing step: run sh .agents/scripts/agent.sh handoff ${id} IMPLEMENTING first`;
    const n = await ctx.agent(['next', id], { budgetMs: ctx.nextBudget * 1000 });
    const line = n.stdout.split('\n').find((l) => /^next=agent\.sh handoff \S+ IMPLEMENTING/.test(l));
    if (line) step += `; in a fix round the next line that says it is exactly: ${line.slice(5)} (run agent.sh next ${id} in full, never cut its output with tail or head)`;
    step += '. Then launch the implementer again';
  } else step = `Run sh .agents/scripts/agent.sh next ${id} in full and do what it says; if an earlier dispatch was killed from outside, run agent.sh tree-inspect ${id} and put ONE question to the user (A224)`;
  return deny(`the implementer is not launched: its write window cannot be opened (${why.slice(0, 400)}). A subagent started without a window can still write through an interpreter and stops the run on a tree approval. ${step}`);
}
