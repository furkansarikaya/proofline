// @ts-check
// A Windows host only (A271): Node 22.13 aborts the WHOLE process (exit code 0xC0000409, a libuv assertion in idna.c, not an exception) when a file system call (lstat, stat, realpath) is
// given a path that holds the code point U+10000 (Linear B syllable). The runtime treats any exit code other than 2 from a PreToolUse hook as a NON-blocking error, so a file name chosen by an
// agent could end the hook before any guard ran and let the tool call proceed. A native abort cannot be caught, so the input is screened BEFORE anything touches the file system: a PreToolUse
// event whose path-bearing fields hold such a code point is denied (fail closed) and a PostToolUse event is not handled. The screen reads the decoded fields, so a JSON escape (𐀀) and the
// literal character are one. `content` and the other text a tool writes are not paths and are not screened. The list is what was measured on the runner (tests/hook/winabort.test.mjs, docs/concepts/workflow.md).

/** The code points that abort Node on Windows when they reach a path call. */
export const ABORTING = /\u{10000}/u;

/** Tool input fields that carry file content or prose, never a path. */
const NOT_A_PATH = new Set(['content', 'new_string', 'old_string', 'new_source', 'new_content', 'description', 'prompt']);

/** @param {unknown} v @param {number} depth @returns {boolean} */
function holds(v, depth) {
  if (typeof v === 'string') return ABORTING.test(v);
  if (depth > 6 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some((x) => holds(x, depth + 1));
  return Object.entries(v).some(([k, x]) => !NOT_A_PATH.has(k) && holds(x, depth + 1));
}

/** True when the event's working directory or any path-bearing field of its tool input holds a code point that aborts Node on Windows. @param {unknown} event the parsed hook event */
export function abortingInput(event) {
  if (event === null || typeof event !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (event);
  return holds(e.cwd, 0) || holds(e.tool_input, 0);
}

/** The screen of a raw event: the refusal to print for PreToolUse, '' for an event to be left unhandled, null when the event may go on. @param {string} ev @param {Buffer} raw @param {boolean} win */
export function screenEvent(ev, raw, win) {
  if (!win || (ev !== 'pretool' && ev !== 'posttool')) return null;
  let parsed;
  try { const t = raw.toString('utf8'); parsed = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); } catch { return null; }
  if (!abortingInput(parsed)) return null;
  if (ev === 'posttool') return '';
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'proofline: a path in this tool call holds the character U+10000, which makes Node abort on Windows before any guard can run (a native abort is not a block). The call is refused; name the file without that character.' } })}\n`;
}
