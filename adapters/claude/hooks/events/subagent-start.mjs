// @ts-check
// SubagentStart: register a proofline specialist (its submission token, the implementer's and designer's write window) and tell it its role.
import { cmdSubst, jesc, nlToSpace } from '../lib/text.mjs';
import { append, mkdirp, put } from '../lib/fsx.mjs';

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  const { prole, act, localDir, aidf, aid } = ctx;
  if (!(ctx.parsed && prole !== '' && act !== '' && act !== 'INVALID')) return undefined;
  for (const d of ['windows', 'records', 'submissions']) mkdirp(`${localDir}/${d}`);
  // A127: submit trusts a typed --agent over PROOFLINE_AGENT only for a registered subagent. The file holds the path of the subagent's session
  // log, where agent.sh reads the tokens it used; the path is the runtime's own, never typed. Line 2: when this (re)start began.
  let stp = ctx.get('agent_transcript_path');
  if (stp === '') {
    stp = ctx.get('transcript_path');
    if (stp !== '') stp = `${stp.endsWith('.jsonl') ? stp.slice(0, -6) : stp}/subagents/agent-${aid}.jsonl`;
  }
  try { put(`${localDir}/submissions/${aidf}.started`, `${stp}\n${Math.floor(Date.now() / 1000)}\n`); } catch { /* the shell hook ignored this too */ }
  if (prole === 'implementer' || prole === 'designer') {
    const r = await ctx.agent(['window-open', act, prole]);
    if (r.status === 0) {
      try { put(`${localDir}/windows/${aidf}`, `${cmdSubst(r.stdout)}\n`); } catch { /* no window file: the stop hook then opens nothing to close */ }
    } else {
      try { append(`${localDir}/records/${aidf}.txt`, `proofline: window-open refused for proofline-${prole} (${aidf}): ${nlToSpace(r.stderr)}\n`); } catch { /* ignore */ }
    }
  }
  const rart = prole === 'explorer'
    ? `--report .agents/runs/${act}/scratch/${aidf}-report.md (write the report to EXACTLY this file, never a generic scratch name such as r.md, or pass --report - with the text on stdin; the script assigns the numbered report name, pass no --artifact)`
    : '[--artifact <path of your report>]';
  const text = `proofline: active run ${act} (run dir .agents/runs/${act}). You are role ${prole}; your agent token is ${aidf}. Prefix every state-changing agent.sh command with AGENT_ROLE=${prole}. Report your result with: AGENT_ROLE=${prole} sh .agents/scripts/agent.sh submit ${act} --agent ${aidf} --confidence <high|medium|low> [--focus F] ${rart} [--findings FILE] [--reason T] [--questions FILE]. The script builds the header, fingerprint and hashes and returns any rejection to you: fix what it names and submit again. Your final message is free text; the result is the submission.`;
  return `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"${jesc(text)}"}}\n`;
}
