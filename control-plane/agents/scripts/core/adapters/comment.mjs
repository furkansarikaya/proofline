// @ts-check
// A369 (issue 338 U3): the text of the completion-report comment on a GitHub issue. The report is written by agents and read by people who are notified, so
// the body is made safe before it leaves the machine: every `@name` is broken so nobody is notified, nothing that loads a remote resource is embedded, and
// the size is bounded below GitHub's 65536 characters on a line boundary with a note that the full report is in the run. A report that holds a secret is
// not made safe, it is refused by the caller (textHoldsSecret of secretscan.mjs) before this runs. Strings here are byte strings (latin1), like every
// adapter text. Pure: no file, no network.

/** The most bytes of one comment (a byte count is never below the character count GitHub limits at 65536). */
export const COMMENT_LIMIT = 60000;
const RESERVE = 700;

/** The marker that makes the comment findable and verifiable: the first line of the body. @param {string} id @param {string} hash */
export const commentMarker = (id, hash) => `<!-- proofline:completion-report:${id} sha256:${hash} -->`;
/** The start of the marker of a task, whatever the hash. @param {string} id */
export const commentMarkerStart = (id) => `<!-- proofline:completion-report:${id} sha256:`;

// GitHub's mention filter needs only a non-word character (or the start) before `@` and a name character after it, wherever the text is (a link text, an HTML
// attribute, a code span, a fence). Every such `@` is broken in two independent ways (A375, A369.1): it is replaced by U+FF20 FULLWIDTH COMMERCIAL AT (no ASCII
// `@` is left, so a GitHub that strips or ignores U+200B still finds no mention) AND a zero-width space follows it (so a normalisation that folds U+FF20 back
// to `@` still finds none). An entity or a backslash would still decode to a real `@` first, so every `&#` and `&commat` becomes `&amp;` followed by the
// same space: `&amp;` decodes once to a literal `&` whether or not U+200B survives, so no reference to `@` parses. A byte of 0x80 or more before it counts
// as a word character of another script that the filter may take, so it is broken too. An address `a@b.c` (a word character before the `@`) is left.
const MENTION = /(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9_-])/g;
const ZWSP = '\xe2\x80\x8b'; // U+200B as the UTF-8 bytes of a byte string
const FWAT = '\xef\xbc\xa0'; // U+FF20 as the UTF-8 bytes of a byte string
const REMOTE_TAG = /<(\/?)(img|image|picture|source|video|audio|iframe|embed|object|link|svg|use|script|style|base|meta|track|input|form)\b/gi;

/** One line made safe. @param {string} line */
function neutralise(line) {
  return line
    .replace(MENTION, `$1${FWAT}${ZWSP}`)
    .replace(/&(?=#|commat)/gi, `&amp;${ZWSP}`) // a character reference that decodes to `@` (&#64; &#x40; &#0064; &#X40; &#64 &commat;) would reach the mention filter as a real `@`
    .replace(/!\[/g, '!\\[')
    .replace(REMOTE_TAG, '&lt;$1$2')
    .replace(/^( {0,3})\[([^\]\n]+)\]:/, '$1\\[$2]:'); // a reference definition (`[b]: http://...`) is text, an ordinary inline link stays
}

/**
 * The comment for a report.
 * @param {string} id the task id (GH-<n>) @param {string} hash sha256 of the report as published @param {string} report the report text (a byte string)
 * @returns {{ body: string, truncated: boolean }}
 */
export function reportComment(id, hash, report) {
  const head = `${commentMarker(id, hash)}\n`;
  const budget = COMMENT_LIMIT - head.length - RESERVE;
  const src = report.replace(/\r\n/g, '\n').split('\n');
  if (src.length > 0 && src[src.length - 1] === '') src.pop();
  /** @type {string[]} */ const out = [];
  let used = 0;
  /** @type {{ ch: string, len: number } | null} */ let fence = null;
  let truncated = false;
  for (const raw of src) {
    const text = neutralise(raw);
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence === null) { if (f && !(f[1][0] === '`' && f[2].includes('`'))) fence = { ch: f[1][0], len: f[1].length }; }
    else if (f && f[1][0] === fence.ch && f[1].length >= fence.len && /^[ \t]*$/.test(f[2])) fence = null;
    if (used + text.length + 1 > budget) { truncated = true; break; }
    out.push(text);
    used += text.length + 1;
  }
  if (truncated) {
    if (fence !== null) out.push(fence.ch.repeat(Math.max(3, fence.len)));
    out.push('', `**The report was truncated here (${COMMENT_LIMIT} bytes is the most one comment carries); the full report, sha256 ${hash}, is in the run folder: .agents/runs/${id}/COMPLETION_REPORT.md**`);
  }
  return { body: `${head}${out.join('\n')}\n`, truncated };
}
