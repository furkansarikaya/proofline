// @ts-check
// SessionStart: tell the lead its skill, the active run and the next step (bounded, A200), and say when plugin and project install differ (A194).
import { isFile, readText } from '../lib/fsx.mjs';
import { jesc } from '../lib/text.mjs';

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  if (ctx.role !== 'lead' || ctx.sub) return undefined;
  if (!ctx.once()) return undefined;
  ctx.sweep();
  await ctx.flush();
  const plugin = ctx.env.CLAUDE_PLUGIN_ROOT ?? '';
  let skill;
  if (ctx.rt === 'codex') skill = '.agents/skills/proofline-lead/SKILL.md';
  else skill = plugin !== '' ? `${plugin}/skills/proofline-lead/SKILL.md` : '.agents/skills/proofline-lead/SKILL.md';
  const act = ctx.act;
  let nxt;
  if (act !== '' && act !== 'INVALID') {
    // A200: bounded (hook.next_budget_seconds of the runtime's 30): the session starts at once and the lead asks `agent.sh next` itself
    const r = await ctx.agent(['next', act], { keepRole: true, budgetMs: ctx.nextBudget * 1000 });
    nxt = (r.stdout + r.stderr).split('\n').filter((l) => l.startsWith('next=')).map((l) => l.slice(5)).join('; ');
    if (r.timedOut) nxt = `run sh .agents/scripts/agent.sh next ${act} (the session check did not finish within the hook's time budget)`;
    // a moved command that failed (a missing node: 127) is said, not hidden: SessionStart cannot block, the PreToolUse guards deny until it is fixed
    if (r.status !== 0 && !r.timedOut && nxt === '') nxt = `agent.sh next exited ${r.status}: this command runs in Node; the user must check that Node 22.13 or newer is on PATH (every tool call is denied until then)`;
  } else nxt = 'no active run: start one with the proofline-lead skill';
  // A194: the plugin and the project's install are different versions: one line, and the lead says so before it starts a run
  let svMsg = '';
  if (plugin !== '' && isFile(`${plugin}/.claude-plugin/plugin.json`)) {
    const sp = /"version"[ \t\r\n]*:[ \t\r\n]*"([^"]*)"/.exec(readText(`${plugin}/.claude-plugin/plugin.json`).split('\n').find((l) => /"version"[ \t]*:[ \t]*"[^"]*"/.test(l)) ?? '')?.[1] ?? '';
    let si = '';
    for (const l of readText(`${ctx.root}/.agents/config.yaml`).split('\n')) {
      const m = /^proofline_version:[ \t\r\n]*"?([0-9][0-9.]*)/.exec(l);
      if (m) { si = m[1]; break; }
    }
    if (sp !== '' && si !== '' && sp !== si) svMsg = `proofline version mismatch: plugin ${sp}, this project's install ${si}; run /proofline upgrade (or update the plugin if the project is the newer one)`;
  }
  const next = nxt !== '' ? nxt : `agent.sh next ${act} failed`;
  const head = `proofline installed; you are the lead; use the proofline-lead skill (${skill}) (never through the Skill tool: proofline skills are not model-invocable); active run: ${act !== '' ? act : 'none'}; next step: ${next}`;
  if (svMsg !== '') {
    const c = `${head}. ${svMsg}. Tell the user this before you start a run.`;
    return `{"systemMessage":"${jesc(svMsg)}","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${jesc(c)}"}}\n`;
  }
  return `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"${jesc(head)}"}}\n`;
}
