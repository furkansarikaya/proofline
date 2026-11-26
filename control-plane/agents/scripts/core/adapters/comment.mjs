// @ts-check
// A369 (issue 338 U3): the text of the completion-report comment on a GitHub issue. The report is written by agents and read by people who are notified, so
// the body is made safe before it leaves the machine: a line that looks like a secret is withheld (the built-in secret rules of the SECRETS gate), a bare
// `@name` is put in code ticks so nobody is notified, an image is not embedded, and the size is bounded below GitHub's 65536 characters on a line boundary
// with a note that the full report is in the run. Strings here are byte strings (latin1), like every adapter text. Pure: no file, no network.
import { lineHoldsSecret } from '../secretscan.mjs';

/** The most bytes of one comment (a byte count is never below the character count GitHub limits at 65536). */
export const COMMENT_LIMIT = 60000;
const RESERVE = 700;

/** The marker that makes the comment findable and verifiable: the first line of the body. @param {string} id @param {string} hash */
export const commentMarker = (id, hash) => `<!-- proofline:completion-report:${id} sha256:${hash} -->`;
/** The start of the marker of a task, whatever the hash. @param {string} id */
export const commentMarkerStart = (id) => `<!-- proofline:completion-report:${id} sha256:`;

const MENTION = /(^|[^A-Za-z0-9_`@/.\\-])@([A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_.-]+)?)/g;

/** One piece of text outside any code span. @param {string} s */
function plain(s) {
  return s.replace(MENTION, '$1`@$2`').replace(/!\[/g, '!\\[').replace(/<img\b/gi, '&lt;img');
}

/** One line outside a fenced block: the pieces between inline code spans are neutralised, the spans are kept. @param {string} line */
function neutraliseLine(line) {
  let out = '';
  let i = 0;
  let from = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    let j = i;
    while (j < line.length && line[j] === '`') j++;
    const run = line.slice(i, j);
    let k = j;
    let close = -1;
    while (k < line.length) {
      if (line[k] !== '`') { k++; continue; }
      let m = k;
      while (m < line.length && line[m] === '`') m++;
      if (m - k === run.length) { close = m; break; }
      k = m;
    }
    if (close < 0) { i = j; continue; } // a run with no partner is literal text
    out += plain(line.slice(from, i)) + line.slice(i, close);
    i = close;
    from = close;
  }
  return out + plain(line.slice(from));
}

/**
 * The comment for a report.
 * @param {string} id the task id (GH-<n>) @param {string} hash sha256 of the report as published @param {string} report the report text (a byte string)
 * @returns {{ body: string, truncated: boolean, withheld: number }}
 */
export function reportComment(id, hash, report) {
  const head = `${commentMarker(id, hash)}\n`;
  const budget = COMMENT_LIMIT - head.length - RESERVE;
  const src = report.replace(/\r\n/g, '\n').split('\n');
  if (src.length > 0 && src[src.length - 1] === '') src.pop();
  /** @type {string[]} */ const out = [];
  let used = 0;
  let withheld = 0;
  /** @type {{ ch: string, len: number } | null} */ let fence = null;
  let truncated = false;
  for (const raw of src) {
    let line = raw;
    if (lineHoldsSecret(line)) { line = '[line withheld: it looks like a secret; the full report is in the run]'; withheld++; }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    /** @type {string} */ let text;
    if (fence === null) {
      if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; text = line; } else text = neutraliseLine(line);
    } else {
      text = line;
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && /^[ \t]*$/.test(f[2])) fence = null;
    }
    if (used + text.length + 1 > budget) { truncated = true; break; }
    out.push(text);
    used += text.length + 1;
  }
  if (truncated) {
    if (fence !== null) out.push(fence.ch.repeat(Math.max(3, fence.len)));
    out.push('', `**The report was truncated here (${COMMENT_LIMIT} bytes is the most one comment carries); the full report, sha256 ${hash}, is in the run folder: .agents/runs/${id}/COMPLETION_REPORT.md**`);
  }
  return { body: `${head}${out.join('\n')}\n`, truncated, withheld };
}
