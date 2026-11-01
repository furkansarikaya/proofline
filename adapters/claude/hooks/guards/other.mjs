// @ts-check
// PreToolUse guard of every other tool the shell hook inspects: the Skill tool (A193: a proofline skill is read as a file, not started) and
// Codex's patch tools (file headers inside the patch text are the targets, judged like Write). Other tools (Task, Agent, MCP tools) have no
// non-Bash rule in the shell hook and pass. Returns null (allow) or { decision: 'deny', reason }.
import { baseline, guarded, deny } from './policy.mjs';
import { fileTool } from './write.mjs';
import { jget } from '../lib/text.mjs';
import { isDir, isFile } from '../lib/fsx.mjs';

/** @param {unknown} input @param {import('../lib/context.mjs').HookContext} ctx */
export async function otherGuard(input, ctx) {
  const tool = jget(input ?? ctx.input, 'tool_name');
  if (!ctx.installed) return null;
  if (tool === 'Skill') {
    return guarded(ctx, async () => {
      await baseline(ctx);
      let name = ctx.get('tool_input.skill', 'tool_input.name');
      let prefixed = false;
      if (name.startsWith('proofline:')) { prefixed = true; name = name.slice(10); }
      if (name === '' || /[^A-Za-z0-9_-]/.test(name)) return;
      let file = '';
      const plugin = ctx.env.CLAUDE_PLUGIN_ROOT ?? '';
      if (plugin !== '' && isFile(`${plugin}/skills/${name}/SKILL.md`)) file = `${plugin}/skills/${name}/SKILL.md`;
      else if (isFile(`${ctx.root}/.agents/skills/${name}/SKILL.md`)) file = `${ctx.root}/.agents/skills/${name}/SKILL.md`;
      // without the proofline: prefix the name counts only when no skill of the user's own bears it
      if (!prefixed && (isDir(`${ctx.root}/.claude/skills/${name}`) || isDir(`${ctx.env.HOME || '/nonexistent'}/.claude/skills/${name}`))) file = '';
      if (file !== '') deny(ctx, `do not use the Skill tool; read ${file} and continue with the same step`);
    });
  }
  if (/[Pp]atch/.test(tool)) return fileTool(ctx, tool);
  return null;
}
