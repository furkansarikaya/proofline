// @ts-check
// A365 (issue 338 C5): the lead's context grows with every byte a routine command prints and with every poll that prints it again. Two shapes of the
// answer of the commands the lead calls all day, applied once for all of them at the entry (never inside a handler, so no handler changes):
//   cap    `output_cap_bytes` (config, default 6000, 0 = off): more than that on stdout is cut at a line end, then ONE line says how much is left and
//          which command prints it all: `...N more bytes: agent.sh <command> <args> --full`. `--full` is the one explicit flag that lifts it. A line that
//          the lead must act on is never cut: the handler registers it itself (`ctx.keep`, `ctx.protectedLines`: `NEXT:`, `waiting for the user:`, the `next=` steps, the
//          waiting list of a batch table), from its own state, never by looking at text it read; such a line that fell in the cut part is printed after the hint.
//          `questions` (a user question is relayed whole) is never capped, and neither is a machine-readable answer (`--tsv`, `--json`).
//          `batch-next` and `batch-status` list the rows that need something first and drop only finished rows (see batch.mjs, `limitRows`).
//   since  `--since <token>` on `next` and `batch-next`: the answer ends with a line `since=<token>` (a hash of the whole answer, opaque); when the
//          answer is the same as the one the token names, only the word `unchanged` is printed (one line). The lead passes the token back; nothing
//          is stored, nothing is read from the clock, and a command without `--since` prints what it printed before.
// Only a command started as a process of its own (the lead's Bash call) is shaped, and the commands this core starts as children for their text pass
// `--full` (`withFull`). A command another command runs in process, a hook and the tests that call the entry directly see the whole answer. stderr and
// the exit status are never touched, and the output of a failed command is left alone.
import { createHash } from 'node:crypto';
import { ProoflineError } from './errors.mjs';

/** @typedef {import('./context.mjs').Context} Context */

/** The commands whose stdout is capped (`questions` is not: a user question is never cut). */
export const CAPPED = Object.freeze(['next', 'batch-next', 'batch-status', 'status', 'digest', 'pipeline', 'friction']);
/** The commands that take `--since`. */
export const SINCE_COMMANDS = Object.freeze(['next', 'batch-next']);
/** The commands whose first argument is an id or a subcommand: a flag is only a flag from the second argument on, so a task named `--full` is still a task. */
const FIRST_IS_NAME = Object.freeze(['next', 'digest', 'pipeline', 'friction']);
/** The default of `output_cap_bytes`. */
export const DEFAULT_CAP = 6000;

/**
 * @typedef {object} Shape
 * @property {string[]} args the arguments without the shaping flags
 * @property {boolean} full `--full` was given
 * @property {string | null} since the token after `--since`, or null
 * @property {boolean} active the command is shaped at all
 */

/**
 * Split the shaping flags off the arguments of a command. A command that is not shaped keeps its arguments as they are.
 * @param {string} command @param {string[]} args @returns {Shape}
 */
export function splitShape(command, args) {
  if (!CAPPED.includes(command)) return { args, full: false, since: null, active: false };
  if (args.includes('--tsv') || args.includes('--json')) return { args, full: false, since: null, active: false };
  const from = FIRST_IS_NAME.includes(command) ? 1 : 0;
  /** @type {string[]} */ const rest = [];
  let full = false;
  /** @type {string | null} */ let since = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (i >= from && a === '--full') { full = true; continue; }
    if (i >= from && a === '--since' && SINCE_COMMANDS.includes(command)) {
      if (i + 1 >= args.length) throw new ProoflineError(`usage: agent.sh ${command}${command === 'next' ? ' <ID>' : ''} --since <token> (the since= line of the previous answer; 0 the first time)`, 2, 'USAGE');
      since = args[i + 1]; i++; continue;
    }
    rest.push(a);
  }
  return { args: rest, full, since, active: true };
}

/** The arguments of a command this core starts as a child to read its text: `--full` is added to a capped one. @param {string[]} argv */
export function withFull(argv) { return CAPPED.includes(argv[0] ?? '') && !argv.includes('--tsv') && !argv.includes('--json') ? [...argv, '--full'] : argv; }

/** The cap in bytes; 0 means none. @param {Context} ctx */
export function capBytes(ctx) {
  const v = ctx.config().get('output_cap_bytes', '');
  return /^[0-9]+$/.test(v) ? Number(v) : DEFAULT_CAP;
}

/** The opaque state token of an answer: 12 hex digits of its hash. @param {Buffer} out */
export function tokenOf(out) { return createHash('sha256').update(out).digest('hex').slice(0, 12); }

/**
 * Tell the command how many bytes its text may take (`ctx.rowBudget`; null = no limit), before the handler runs.
 * @param {Context} ctx @param {Shape} shape
 */
export function prepare(ctx, shape) {
  const cap = shape.active && ctx.io.isProcess === true && !shape.full ? capBytes(ctx) : 0;
  ctx.rowBudget = cap > 0 ? cap : null;
}

/**
 * Apply the shape to what the command collected. Called after the handler returned 0.
 * @param {Context} ctx @param {string} command @param {Shape} shape
 */
export function shapeOutput(ctx, command, shape) {
  if (!shape.active || ctx.io.isProcess !== true) return;
  const errs = ctx.chunks.filter(([s]) => s === 'err');
  let body = Buffer.concat(ctx.chunks.filter(([s]) => s === 'out').map(([, b]) => b));
  const token = tokenOf(body);
  if (shape.since !== null && shape.since === token) { ctx.chunks = [['out', Buffer.from('unchanged\n', 'latin1')], ...errs]; return; }
  const cap = capBytes(ctx);
  if (!shape.full && cap > 0 && body.length > cap) {
    let cut = body.lastIndexOf(10, cap - 1) + 1; // the head ends at a line end
    if (cut === 0) cut = cap;
    const head = body.subarray(0, cut);
    const kept = [...new Set(ctx.protectedLines)].filter((l) => !head.includes(Buffer.from(l, 'latin1'))).join('');
    const flags = [command, ...shape.args, ...(shape.since !== null ? ['--since', shape.since] : [])];
    body = Buffer.concat([head, Buffer.from(`...${body.length - cut} more bytes: agent.sh ${flags.join(' ')} --full\n${kept}`, 'latin1')]);
  }
  if (shape.since !== null) body = Buffer.concat([body, Buffer.from(`since=${token}\n`, 'latin1')]);
  ctx.chunks = [['out', body], ...errs];
}

/**
 * The rows of a table of one line per task (`batch-next`, `batch-status`) under the byte budget of the command (A365). When the rows fit half the budget, nothing changes.
 * When they do not: a first line `rows: N, waiting: n, runnable: n, parked: n`; then, when a task waits for the user, the list `waiting for the user (K):` with one line per task
 * (id and the gist of its question; at most a quarter of the budget, the rest counted), which the cap never cuts; then the rows in the order waiting for the user, runnable,
 * parked, waiting for a dependency, finished (stable inside each class) until half the budget is used; the hint after the rows names how many are hidden.
 * @template {{ id: string, state: string, question: string }} R
 * @param {Context} ctx @param {string} command @param {R[]} rows @param {(r: R) => string} line the text of one row, with its newline
 * @returns {{ head: string, shown: R[], tail: string }}
 */
export function limitRows(ctx, command, rows, line) {
  const budget = ctx.rowBudget;
  const size = (/** @type {R[]} */ rs) => rs.reduce((n, r) => n + line(r).length, 0);
  if (budget === null || size(rows) <= Math.floor(budget / 2)) return { head: '', shown: rows, tail: '' };
  const klass = (/** @type {R} */ r) => (r.question !== '' && r.state === 'parked' ? 0 : r.state === 'open' ? 1 : r.state === 'parked' ? 2 : r.state === 'waiting' ? 3 : 4);
  const sorted = rows.map((r, i) => ({ r, i, k: klass(r) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.r);
  const n = (/** @type {string} */ s) => rows.filter((r) => r.state === s).length;
  const asking = sorted.filter((r) => klass(r) === 0);
  let list = '';
  let listed = 0;
  for (const r of asking) {
    const l = `  ${r.id}: ${r.question.replace(/`/g, '').replace(/[\t\n\v\f\r]+/g, ' ').trim().slice(0, 120)}\n`;
    if (list.length + l.length > Math.floor(budget / 4) && listed > 0) break;
    list += l; listed++;
  }
  if (asking.length > 0) {
    const title = `waiting for the user (${asking.length}):\n`;
    const more = asking.length > listed ? `  ...${asking.length - listed} more waiting: agent.sh ${command} --full\n` : '';
    list = title + list + more;
    ctx.protectedLines.push(list);
  }
  const shown = [];
  let used = 0;
  for (const r of sorted) { const l = line(r).length; if (used + l > Math.floor(budget / 2) && shown.length > 0) break; shown.push(r); used += l; }
  const hidden = rows.length - shown.length;
  return {
    head: `rows: ${rows.length}, waiting: ${n('waiting')}, runnable: ${n('open')}, parked: ${n('parked')}\n${list}`,
    shown,
    tail: hidden > 0 ? `...${hidden} more row${hidden === 1 ? '' : 's'} (finished ones first): agent.sh ${command} --full\n` : '',
  };
}
