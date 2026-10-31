// @ts-check
// POSIX extended regular expressions (grep -E, awk) for the patterns the control plane takes from config.yaml. The translation covers
// the constructs those patterns use (groups, alternation, intervals, bracket expressions with [:class:], escaped literals). Anything it
// does not cover (back-references, GNU word escapes, collating elements, a malformed pattern) returns null, and the caller asks the
// platform's own grep or awk (proc.mjs), exactly as the shell did: this module never guesses.

const CLASSES = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\v\\f\\r', blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
};

/** @param {string} c */
function inBracket(c) { return c === '\\' || c === '[' || c === ']' || c === '^' ? `\\${c}` : c; }

/**
 * Translate an ERE to a JavaScript RegExp that tests one line; null when a construct is not covered.
 * @param {string} ere @param {boolean} [ignoreCase]
 * @returns {RegExp | null}
 */
export function ereToRegExp(ere, ignoreCase = false) {
  let out = '';
  let i = 0;
  const n = ere.length;
  while (i < n) {
    const c = ere[i];
    if (c === '\\') {
      const d = ere[i + 1];
      if (d === undefined) return null;
      if (/[A-Za-z0-9<>]/.test(d)) return null;
      out += `\\${d}`; i += 2; continue;
    }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (ere[j] === '^') { neg = true; j++; }
      let body = '';
      let first = true;
      let closed = false;
      while (j < n) {
        const e = ere[j];
        if (e === ']' && !first) { closed = true; j++; break; }
        first = false;
        if (e === '[' && (ere[j + 1] === ':' || ere[j + 1] === '.' || ere[j + 1] === '=')) {
          if (ere[j + 1] !== ':') return null;
          const end = ere.indexOf(':]', j + 2);
          if (end < 0) return null;
          const name = ere.slice(j + 2, end);
          if (!Object.hasOwn(CLASSES, name)) return null;
          body += CLASSES[/** @type {keyof typeof CLASSES} */ (name)];
          j = end + 2; continue;
        }
        if (e === '-' && body !== '' && ere[j + 1] !== ']' && ere[j + 1] !== undefined) { body += '-'; j++; continue; }
        body += e === '-' ? '\\-' : inBracket(e);
        j++;
      }
      if (!closed || body === '') return null;
      out += `[${neg ? '^' : ''}${body}]`;
      i = j; continue;
    }
    if (c === '{') {
      const m = /^\{[0-9]+(,[0-9]*)?\}/.exec(ere.slice(i));
      if (!m) return null;
      out += m[0]; i += m[0].length; continue;
    }
    if (c === '}') return null;
    out += c; i++;
  }
  try { return new RegExp(out, ignoreCase ? 'i' : ''); } catch { return null; }
}
