// @ts-check
// `proofline insights` (A89, A232; the front end that was bin/lib/insights.sh): checks the arguments, then prints the read-only report of core/insights.mjs and, for the plain
// report, the size of the text loaded into every session (A202) and the project rules budget. It opens nothing for writing: no rule, skill, config, ledger or metrics file is
// ever changed. The root is the project named by PROOFLINE_ROOT.
import { readFileSync } from 'node:fs';
import { agentCall } from './batch.mjs';
import { requireInstalled } from './doctor.mjs';
import { contextRows, reportText } from './contextsize.mjs';
import { ProoflineError } from './errors.mjs';
import { insightsReport, insightsStream } from './insights.mjs';
import { isDir, isFile } from './paths.mjs';

/** @typedef {import('./context.mjs').Context} Context */

const USAGE = 'usage: proofline insights [--run <ID>] [--json]';
/** `proofline: MSG`, status 1 (the front end appends the user's next step). @param {string} msg */
const die = (msg) => new ProoflineError(`proofline: ${msg}`, 1);

/** @param {Context} ctx @param {string[]} args */
export function insightsFront(ctx, args) {
  requireInstalled(ctx);
  let run = ''; let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--run') {
      if (i + 1 >= args.length) { ctx.err(`${USAGE}\n`); throw die('--run needs a run id'); }
      run = args[++i];
    } else if (a.startsWith('--run=')) run = a.slice('--run='.length);
    else if (a === '-h' || a === '--help') { ctx.out(`${USAGE}\n`); return 0; } else { ctx.err(`${USAGE}\n`); throw die(`unknown argument: ${a}`); }
  }
  if (/[^A-Za-z0-9_-]/.test(run)) throw die(`invalid run id: ${run}`);
  if (run !== '' && !isDir(`${ctx.root}/.agents/runs/${run}`)) {
    let metrics = '';
    try { metrics = readFileSync(`${ctx.root}/.agents/local/metrics/records.jsonl`, 'latin1'); } catch { /* none */ }
    if (!metrics.includes(`"task":"${run}"`)) throw die(`no such run: ${run} (see: proofline queue)`);
  }
  const off = ctx.config().get('metrics', 'on') === 'off';
  ctx.out(insightsReport(insightsStream(ctx.root, run), { json, only: run, off }));
  // A202: the size of the text loaded into every session, from the same Node module doctor and the budget test use
  if (!json && run === '') {
    ctx.out('\n');
    try { ctx.out(reportText(contextRows('project', ctx.root, ctx.env.PL_HOME || ctx.root))); } catch { /* the report is optional */ }
    if (isFile(`${ctx.root}/.agents/scripts/agent.sh`)) {
      const r = agentCall(ctx, ['rules', 'report']);
      ctx.out('\n');
      ctx.out(r.out);
      if (r.err !== '') ctx.err(r.err);
    }
  }
  return 0;
}
