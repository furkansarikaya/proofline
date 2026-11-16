// @ts-check
// A Windows host only (A271): Node 22.13 aborts the WHOLE process (exit code 0xC0000409, a libuv assertion in idna.c, not an exception) when a file system call (lstat, stat, realpath) is
// given a path that holds the code point U+10000 (Linear B syllable) or U+10FFFF (the last code point). The runtime treats any exit code other than 2 from a PreToolUse hook as a NON-blocking error, so a file name chosen by an
// agent could end the hook before any guard ran and let the tool call proceed. A native abort cannot be caught, so the input is screened BEFORE anything touches the file system: a PreToolUse
// event whose path-bearing fields hold such a code point is denied (fail closed) and a PostToolUse event is not handled. The screen reads the decoded fields, so a JSON escape (a surrogate-pair escape) and the
// literal character are one. `content` and the other text a tool writes are not paths and are not screened. The list is what a scan on the windows-latest runner found: every code point (U+0080 to U+FFFF, every 4096-code-point chunk of the sixteen planes, the lone surrogates) was asked in a file name and only U+10000 and U+10FFFF abort (docs/concepts/workflow.md). The safe layer (lib/safefs.mjs) is the control; this screen is the first one.

/** The code points that abort Node on Windows when they reach a path call. */
export const ABORTING = /[\u{10000}\u{10FFFF}]/u;

/** Tool input fields that carry file content or prose, never a path. */
const NOT_A_PATH = new Set(['content', 'new_string', 'old_string', 'new_source', 'new_content', 'description', 'prompt']);

/** The most text the screen reads from one event (a longer path-bearing text is refused as if it held the character: fail closed). */
const LIMIT = 8 * 1024 * 1024;

/** A Codex patch names its files in header lines; the lines of the files' own content are not paths. */
const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): /;

/** @param {string} text */
function headerHolds(text) { return text.split('\n').some((l) => PATCH_HEADER.test(l) && ABORTING.test(l)); }

/** True when a path-bearing string anywhere in V, at any depth, holds an aborting code point (or V is larger than the bound). Iterative and cycle-safe. @param {unknown} v @param {boolean} patchText the string is the text of a patch tool @returns {boolean} */
function holds(v, patchText) {
  /** @type {Array<[unknown, boolean]>} */ const todo = [[v, patchText]];
  const seen = new Set(); let read = 0;
  while (todo.length) {
    const [x, patch] = /** @type {[unknown, boolean]} */ (todo.pop());
    if (typeof x === 'string') {
      read += x.length;
      if (read > LIMIT) return true;
      if (patch || x.startsWith('*** Begin Patch') ? headerHolds(x) : ABORTING.test(x)) return true;
    } else if (x !== null && typeof x === 'object') {
      if (seen.has(x)) continue;
      seen.add(x);
      for (const [k, y] of Array.isArray(x) ? x.entries() : Object.entries(x)) if (!NOT_A_PATH.has(String(k))) todo.push([y, patch]);
    }
  }
  return false;
}

/** True when the event's working directory or any path-bearing field of its tool input holds a code point that aborts Node on Windows. @param {unknown} event the parsed hook event */
export function abortingInput(event) {
  if (event === null || typeof event !== 'object') return false;
  const e = /** @type {Record<string, unknown>} */ (event);
  return holds(e.cwd, false) || holds(e.tool_input, typeof e.tool_input === 'string');
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
