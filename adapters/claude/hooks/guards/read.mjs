// @ts-check
// PreToolUse guard of the read tools (Read, Glob, Grep). The shell hook has one rule for them: the database guard (no agent reads a database
// file while a run is open), judged on the path and pattern fields of the input. A refusal is thrown as kit.Deny; null allows.
import { fileTool } from './write.mjs';
import { jget } from '../lib/text.mjs';

/** @param {unknown} input @param {import('../lib/context.mjs').HookContext} ctx */
export async function readGuard(input, ctx) {
  return fileTool(ctx, jget(input ?? ctx.input, 'tool_name'));
}
