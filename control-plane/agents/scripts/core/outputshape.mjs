// @ts-check
// A365 (issue 338 C5): the lead's context grows with every byte a routine command prints and with every poll that prints it again. Two shapes of the
// answer of the commands the lead calls all day, applied once for all of them at the entry (never inside a handler, so no handler changes):
//   cap    `output_cap_bytes` (config, default 6000, 0 = off): more than that on stdout is cut at a line end, then ONE line says how much is left and
//          which command prints it all: `...N more bytes: agent.sh <command> <args> --full`. `--full` is the one explicit flag that lifts it.
//   since  `--since <token>` on `next` and `batch-next`: the answer ends with a line `since=<token>` (a hash of the whole answer, opaque); when the
//          answer is the same as the one the token names, only the word `unchanged` is printed (one line). The lead passes the token back; nothing
//          is stored, nothing is read from the clock, and a command without `--since` prints what it printed before.
// Only a command started as a process of its own (the lead's Bash call) is shaped: a command another command runs in process, a hook and the tests that
// call the entry directly see the whole answer. stderr and the exit status are never touched, and the output of a failed command is left alone.
import { createHash } from 'node:crypto';

/** @typedef {import('./context.mjs').Context} Context */

/** The commands whose stdout is capped. */
export const CAPPED = Object.freeze(['next', 'batch-next', 'batch-status', 'status', 'digest', 'questions', 'pipeline', 'friction']);
/** The commands that take `--since`. */
export const SINCE_COMMANDS = Object.freeze(['next', 'batch-next']);
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
  /** @type {string[]} */ const rest = [];
  let full = false;
  /** @type {string | null} */ let since = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--full') { full = true; continue; }
    if (a === '--since' && SINCE_COMMANDS.includes(command) && i + 1 < args.length) { since = args[i + 1]; i++; continue; }
    rest.push(a);
  }
  return { args: rest, full, since, active: true };
}

/** The cap in bytes; 0 means none. @param {Context} ctx */
export function capBytes(ctx) {
  const v = ctx.config().get('output_cap_bytes', '');
  return /^[0-9]+$/.test(v) ? Number(v) : DEFAULT_CAP;
}

/** The opaque state token of an answer: 12 hex digits of its hash. @param {Buffer} out */
export function tokenOf(out) { return createHash('sha256').update(out).digest('hex').slice(0, 12); }

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
    const flags = [command, ...shape.args, ...(shape.since !== null ? ['--since', shape.since] : [])];
    body = Buffer.concat([body.subarray(0, cut), Buffer.from(`...${body.length - cut} more bytes: agent.sh ${flags.join(' ')} --full\n`, 'latin1')]);
  }
  if (shape.since !== null) body = Buffer.concat([body, Buffer.from(`since=${token}\n`, 'latin1')]);
  ctx.chunks = [['out', body], ...errs];
}
