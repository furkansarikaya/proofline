// @ts-check
// The attribution trailer of the delivery commit (A224, user decision of 2026-11-07). The CONTROL PLANE appends the configured trailer lines to the commit message
// that `deliver-plan` writes; nobody else does (a trailer in `--message` stays refused, and the lead never edits COMMIT_MSG). The lines come from the config key
// `git.commit_trailer` (a scalar or a block list); the built-in default is the standard attribution line; the value `off` switches the trailer off.
//
// The config is read like every other key, and a task branch can carry its own `.agents/config.yaml`, so the lines are untrusted text: each one is checked here
// (shape, length, count, alphabet, keys that certify a person), the summary the user approves shows the whole message, and the approval hash covers it.
import { asciiLower } from './shellglob.mjs';

/** The line added when `git.commit_trailer` is absent or empty: the standard attribution of a change made with Claude Code, without a model name (the control plane does not know which model wrote it). */
export const DEFAULT_TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>';
/** At most this many trailer lines, each at most this many bytes. */
export const MAX_TRAILER_LINES = 5;
export const MAX_TRAILER_BYTES = 200;

/**
 * Keys that certify what a person did or decided: a sign-off (DCO), a review, an acknowledgement, a test, an approval. A model-written config line must not forge them
 * (invariant 3: an approval comes from the user's own message; a sign-off is a person's statement), so they are refused whatever the value.
 */
const CERTIFYING = new Set(['signed-off-by', 'reviewed-by', 'acked-by', 'tested-by', 'approved-by']);

/** `Key: value`, the key letters, digits and `-`, the value without a control character and without the characters proofline keeps out of every commit line (" ` $ \). */
const SHAPE = /^[A-Za-z][A-Za-z0-9-]{0,39}: [^\x00-\x20\x7f"`$\\][^\x00-\x1f\x7f"`$\\]*$/;
/** Format and line-separator code points that could hide or split a line when a viewer renders the text (written as escapes, never as the characters). */
const HIDDEN = new RegExp('[\\u0080-\\u009f\\u00ad\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]');

/**
 * Why a trailer line is refused, or null. The text is a byte string (one char per byte, as the config reader returns it).
 * @param {string} line @returns {string | null}
 */
export function trailerLineProblem(line) {
  if (line.length > MAX_TRAILER_BYTES) return `longer than ${MAX_TRAILER_BYTES} bytes`;
  if (/[\x00-\x1f\x7f]/.test(line)) return 'holds a control character (a trailer is one line)';
  if (!SHAPE.test(line) || line.endsWith(' ')) return 'is not "Key: value" (key: letters, digits and -, up to 40; value: text without " ` $ or \\)';
  const decoded = Buffer.from(line, 'latin1').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('latin1') !== line || decoded.includes(String.fromCharCode(0xfffd))) return 'is not valid UTF-8';
  if (HIDDEN.test(decoded)) return 'holds an invisible or line-separating character';
  const key = asciiLower(line.slice(0, line.indexOf(':')));
  if (CERTIFYING.has(key)) return `uses the key ${line.slice(0, line.indexOf(':'))}, which certifies what a person did or decided; proofline never writes it for a person`;
  return null;
}

/**
 * The trailer lines of a config: `{ lines, source }`, source `default` (key absent or empty), `config` or `off`; or `{ problems }` when a line is refused or the
 * list is too long. `off` stands alone; mixed with other lines it is a problem, never a guess.
 * @param {string[]} items the scalar or the block-list items of `git.commit_trailer`, as bytes
 * @returns {{ lines: string[], source: 'default' | 'config' | 'off', problems: string[] }}
 */
export function resolveTrailer(items) {
  const given = items.map((l) => l.replace(/^[ \t]+|[ \t]+$/g, '')).filter((l) => l !== '');
  if (given.length === 0) return { lines: [DEFAULT_TRAILER], source: 'default', problems: [] };
  if (given.some((l) => asciiLower(l) === 'off')) {
    return given.length === 1 ? { lines: [], source: 'off', problems: [] } : { lines: [], source: 'config', problems: ['git.commit_trailer: off stands alone, without other lines'] };
  }
  /** @type {string[]} */ const problems = [];
  if (given.length > MAX_TRAILER_LINES) problems.push(`git.commit_trailer: at most ${MAX_TRAILER_LINES} lines (${given.length} given)`);
  given.forEach((l, i) => {
    const why = trailerLineProblem(l);
    if (why !== null) problems.push(`git.commit_trailer: line ${i + 1} ${why}`);
  });
  if (new Set(given.map((l) => asciiLower(l))).size !== given.length) problems.push('git.commit_trailer: a line is given twice');
  // the standard line written out in the config (as the shipped config does) is still "the default"
  const standard = problems.length === 0 && given.length === 1 && given[0] === DEFAULT_TRAILER;
  return { lines: problems.length === 0 ? given : [], source: standard ? 'default' : 'config', problems };
}

/**
 * The trailer lines for a delivery from the project config (`ctx.config()`); a refused configuration is an error that names the key, never the whole file.
 * @param {{ cmds: (key: string) => string[] }} config @returns {{ lines: string[], source: 'default' | 'config' | 'off', problems: string[] }}
 */
export function trailerFromConfig(config) {
  return resolveTrailer(config.cmds('git.commit_trailer'));  // the config reader already returns byte strings
}

/**
 * The whole commit message: the approved line, a blank line, the trailer lines. Without trailers it is the line alone. Ends with one newline.
 * @param {string} line @param {string[]} trailers
 */
export function composeCommitMessage(line, trailers) {
  return trailers.length === 0 ? `${line}\n` : `${line}\n\n${trailers.join('\n')}\n`;
}
