// @ts-check
// SubagentStop: the result is the specialist's `agent.sh submit` (its status file under .agents/local/submissions/); the final message is never
// parsed. A specialist that stops without a recorded submission is sent back once with the last rejection; the second stop is accepted and
// reported to the lead as "no result". The record is a line for the lead (relayed by the PostToolUse hook).
import { mkdirSync } from 'node:fs';
import { append, isFile, mkdirp, put, readText, rmf } from '../lib/fsx.mjs';
import { jesc, nlToSpace } from '../lib/text.mjs';

/** The value of the first `KEY=` line of a status file. @param {string} text @param {string} key */
function firstValue(text, key) {
  for (const l of text.split('\n')) if (l.startsWith(`${key}=`)) return l.slice(key.length + 1);
  return '';
}

/** @param {import('../lib/context.mjs').HookContext} ctx */
export async function handle(ctx) {
  const { prole, act, localDir, aidf } = ctx;
  if (!ctx.parsed || prole === '') return undefined;
  if (act === '' || act === 'INVALID') return undefined;
  const rec = `${localDir}/records`; const sdir = `${localDir}/submissions`;
  mkdirp(rec); mkdirp(`${localDir}/windows`); mkdirp(sdir);
  const st = `${sdir}/${aidf}.status`; const out = `${rec}/${aidf}.txt`;
  const stText = readText(st);
  const state = firstValue(stText, 'status');
  let err = '';
  if (state !== 'ok') {
    err = firstValue(stText, 'error');
    const mark = `${sdir}/${aidf}.retried`; const now = Math.floor(Date.now() / 1000);
    let prev = readText(mark).replace(/\n+$/, '');
    if (/[^0-9]/.test(prev)) prev = '';
    // stop_hook_active is the runtime's "already sent back once"; a second hook layer firing for the same stop (within two seconds) gives the same answer
    if (ctx.get('stop_hook_active') !== 'true' && (prev === '' || now - Number(prev) <= 2)) {
      if (prev === '') { try { put(mark, `${now}\n`); } catch { /* ignore */ } }
      const rart = prole === 'explorer'
        ? `--report .agents/runs/${act}/scratch/${aidf}-report.md (or - for stdin; the script assigns the numbered report name, pass no --artifact)`
        : '[--artifact <report path>]';
      const reason = `proofline: you stopped without a recorded result. Run AGENT_ROLE=${prole} sh .agents/scripts/agent.sh submit ${act} --agent ${aidf} --confidence <high|medium|low> [--focus F] ${rart} [--findings FILE] [--reason T] [--questions FILE]${err !== '' ? ` (last rejection: ${err})` : ''}, fix what it names, then finish.`;
      return `{"decision":"block","reason":"${jesc(reason)}"}\n`;
    }
    try { put(`${sdir}/${aidf}.final`, ''); } catch { /* ignore */ }
  }
  rmf(`${sdir}/${aidf}.started`); // A127: the final stop; the status check above is done
  try { mkdirSync(`${rec}/${aidf}.lock`); } catch { return undefined; } // one record per subagent even when two hook layers fire
  const winFile = `${localDir}/windows/${aidf}`;
  if ((prole === 'implementer' || prole === 'designer') && isFile(winFile)) {
    const before = readText(winFile).replace(/\n+$/, '');
    const r = await ctx.agent(['window-close', act, before, '0', prole]);
    if (r.status === 0) rmf(winFile);
    else append(out, `proofline: window-close rejected for proofline-${prole}: ${nlToSpace(r.stdout + r.stderr)}\n`);
  }
  if (state === 'ok') {
    const gate = firstValue(stText, 'gate');
    append(out, `proofline: proofline-${prole} submitted: ${firstValue(stText, 'role')} ${firstValue(stText, 'result')}${gate !== '' ? ` gate=${gate}` : ''} (${firstValue(stText, 'raw')})\n`);
  } else {
    append(out, `proofline: proofline-${prole} ended without a recorded result${err !== '' ? ` (last rejection: ${err})` : ''}; nothing recorded (no valid agent.sh submit)\n`);
  }
  return undefined;
}

