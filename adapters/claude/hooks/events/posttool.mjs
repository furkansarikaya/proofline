// @ts-check
// PostToolUse: relay the record and window outcomes that subagent hooks wrote (SubagentStop context reaches only the subagent) to the lead.
import { readFileSync, rmdirSync } from 'node:fs';
import { isFile, names, rmf } from '../lib/fsx.mjs';
import { jesc, cmdSubst } from '../lib/text.mjs';

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  if (!ctx.parsed || ctx.sub || ctx.role !== 'lead') return undefined;
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
  if (all === '') return undefined;
  return `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"${jesc(cmdSubst(all))}"}}\n`;
}
