// @ts-check
// PostToolUse: (1) the user's selection in the runtime's own option UI (AskUserQuestion, A367) is recorded as the user's answer to the control plane's pending question;
// (2) relay the record and window outcomes that subagent hooks wrote (SubagentStop context reaches only the subagent) to the lead.
import { readFileSync, rmdirSync } from 'node:fs';
import { isFile, names, readText, rmf } from '../lib/fsx.mjs';
import { jesc, cmdSubst } from '../lib/text.mjs';

/**
 * AskUserQuestion finished: offer its input and result to every open question of the run that is a user-only question with options; the core (`answer N --ui`) records
 * the selection only when the tool input is exactly the input it derives from that question, the question was asked by this session, the result holds the user's
 * answer and it is an accepted form. Only the lead's own tool call counts (a subagent's event is ignored by the caller). Returns the line for the lead, or ''.
 * Assumption (A367): `tool_response` is produced by the runtime from the user's selection, not by a model. @param {import('../lib/context.mjs').HookContext} ctx
 */
async function recordSelection(ctx) {
  if (ctx.act === '' || ctx.act === 'INVALID') return '';
  const input = /** @type {any} */ (ctx.input);
  if (input === null || typeof input !== 'object') return '';
  const dir = `${ctx.sroot}/.agents/runs/${ctx.act}/questions`;
  const list = names(dir);
  for (const n of list) {
    const m = /^([0-9]{3})\.md$/.exec(n);
    if (!m || list.includes(`${m[1]}.answer.md`) || !/^[ \t]*(SPLIT|USER_ONLY): /m.test(readText(`${dir}/${n}`))) continue;
    const r = await ctx.agent(['answer', ctx.act, String(Number(m[1])), '--ui'], {
      uiAnswer: { session: ctx.get('session_id'), toolUseId: ctx.get('tool_use_id'), input: input.tool_input, response: input.tool_response },
    });
    if (r.status === 0 && /^answer recorded: /m.test(r.stdout)) return `proofline: your selection in the option UI is recorded as your answer to question ${Number(m[1])} (answered_by user, source ui).`;
  }
  return '';
}

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  if (!ctx.parsed || ctx.sub || ctx.role !== 'lead') return undefined;
  let line = '';
  if (ctx.get('tool_name') === 'AskUserQuestion') line = await recordSelection(ctx);
  const dir = `${ctx.localDir}/records`;
  let all = '';
  for (const n of names(dir)) {
    if (!n.endsWith('.txt') || n.startsWith('.')) continue;
    const f = `${dir}/${n}`;
    if (!isFile(f)) continue;
    all += readFileSync(f, 'utf8');
    rmf(f);
    try { rmdirSync(`${f.slice(0, -4)}.lock`); } catch { /* not there or not empty */ }
  }
  if (all === '' && line === '') return undefined;
  const text = `${line}${line !== '' && all !== '' ? ' ' : ''}${cmdSubst(all)}`;
  return `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"${jesc(text)}"}}\n`;
}
