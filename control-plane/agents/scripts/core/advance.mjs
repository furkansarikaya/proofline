// @ts-check
// A258 (#181 item 3): `advance ID`, the lead's combined step command. It is `next` plus the mechanical commands `next` itself names, run one after the other:
// it reads `next`; when the ONLY `next=` line is one of a closed list of lead-owned, argument-free commands, it runs exactly that command through the same entry point as a
// typed `agent.sh` call (role gate, locks, every check of the command), prints its output, runs the facts commands the lead's skill asks for after it, and reads `next` again.
// It stops at the first `next=` that is anything else (a classification, a dispatch, a question, an approval, a report, CODE_DONE, DONE, a fix round), after 8 steps, when a
// command repeats, or at the first command that fails (its output and exit status are the command's own; nothing after it runs). The last block of the output is the text
// `next` prints, so the lead reads it as it reads `next`.
// It has no authority of its own: it never approves, waives, answers, records a gate or a verdict, dispatches, classifies or hands off CODE_DONE/DONE (the closed list below
// is the whole of what it can start), it runs only for the lead (the role gate refuses it for every other role), and it takes no lock itself (each command takes its own).
import { agentCall } from './batch.mjs';
import { requireLead } from './approve.mjs';
import { need } from './lifeutil.mjs';
import { requireRun } from './runs.mjs';

/** @typedef {import('./context.mjs').Context} Context */

export const MAX_STEPS = 8;

/**
 * The commands `advance` may start, each the whole text of a `next=` line after `next=`, and the read-only/recording facts commands that follow it (the second and third calls
 * the lead's skill asks for after the step). The argument is the run id.
 * @param {string} id @returns {Array<{ line: string, argv: string[], then: string[][] }>}
 */
export function mechanical(id) {
  return [
    { line: `agent.sh branch ${id}`, argv: ['branch', id], then: [] },
    { line: `agent.sh baseline ${id}`, argv: ['baseline', id], then: [] },
    { line: `agent.sh freeze ${id}`, argv: ['freeze', id], then: [['freshness', id]] },
    { line: `agent.sh handoff ${id} IMPLEMENTING`, argv: ['handoff', id, 'IMPLEMENTING'], then: [] },
    { line: `agent.sh handoff ${id} IMPLEMENTED`, argv: ['handoff', id, 'IMPLEMENTED'], then: [['tier', id], ['pipeline', id]] },
  ];
}

/** @param {string} text @returns {string[]} the `next=` lines without the prefix */
const nextLines = (text) => text.split('\n').filter((l) => l.startsWith('next=')).map((l) => l.slice(5));

/** @param {Context} ctx @param {string[]} argv */
const call = (ctx, argv) => agentCall(ctx, argv);

/** @param {Context} ctx @param {string[]} args */
export function advance(ctx, args) {
  requireLead(ctx);
  const id = need(args, 0);
  requireRun(ctx, id);
  const table = mechanical(id);
  /** @type {string[]} */ const done = [];
  let steps = 0;
  for (;;) {
    const n = call(ctx, ['next', id]);
    if (n.status !== 0) { ctx.out(n.out); ctx.err(n.err); return n.status; }
    const lines = nextLines(n.out);
    const hit = lines.length === 1 ? table.find((m) => m.line === lines[0]) : undefined;
    const why = !hit ? 'the next step is the lead\'s' : done.includes(hit.line) ? 'the same command was run already' : steps >= MAX_STEPS ? `${MAX_STEPS} steps run` : '';
    if (why !== '') {
      ctx.out(`advance ${id}: ${steps} step(s) run; stopped: ${why}\n`);
      ctx.out(n.out); ctx.err(n.err);
      return 0;
    }
    steps++; done.push(/** @type {{ line: string }} */ (hit).line);
    // notes of the state just left are shown: the lead would have read them in `next`
    for (const l of n.out.split('\n')) if (l.startsWith('note=') || l.startsWith('missing_step=')) ctx.out(`${l}\n`);
    for (const argv of [/** @type {{ argv: string[] }} */ (hit).argv, .../** @type {{ then: string[][] }} */ (hit).then]) {
      const r = call(ctx, argv);
      ctx.out(`advance ${id} step ${steps}: agent.sh ${argv.join(' ')} (exit ${r.status})\n`);
      ctx.out(r.out); ctx.err(r.err);
      if (r.status !== 0) { ctx.out(`advance ${id}: stopped, agent.sh ${argv[0]} failed; nothing after it ran\n`); return r.status; }
    }
  }
}

export const ADVANCE_HANDLERS = { advance };
