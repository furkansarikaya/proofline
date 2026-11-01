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
  // A group that holds a quantifier or an alternation and is itself quantified (`(a+)+`, `(a|a)*`) can take exponential time in a
  // backtracking engine; grep and awk run such patterns in linear time. They go to the platform tools (null).
  /** @type {Array<{ quant: boolean, alt: boolean, cur: number, max: number }>} */ const groups = [{ quant: false, alt: false, cur: 0, max: 0 }];
  while (i < n) {
    const c = ere[i];
    if (c === '(') { groups.push({ quant: false, alt: false, cur: 0, max: 0 }); out += c; i++; continue; }
    if (c === '|') { const t = groups[groups.length - 1]; t.alt = true; t.max = Math.max(t.max, t.cur); t.cur = 0; out += c; i++; continue; }
    if (c === ')') {
      if (groups.length < 2) return null;
      const g = /** @type {{ quant: boolean, alt: boolean, cur: number, max: number }} */ (groups.pop());
      const next = ere[i + 1];
      const top = groups[groups.length - 1];
      if (next === '*' || next === '+' || next === '{' || next === '?') {
        if ((g.quant || g.alt) && next !== '?') return null;
        top.quant = true;
      }
      top.cur += Math.max(g.max, g.cur); // the unbounded quantifiers of one branch of the group join its enclosing branch
      if (g.quant) top.quant = true;
      if (g.alt) top.alt = true;
      out += c; i++; continue;
    }
    if (c === '*' || c === '+') { groups[groups.length - 1].quant = true; groups[groups.length - 1].cur++; }
    if (c === '.') { out += '[^\\n]'; i++; continue; }
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
      groups[groups.length - 1].quant = true;
      if (/,\}$/.test(m[0])) groups[groups.length - 1].cur++;
      out += m[0]; i += m[0].length; continue;
    }
    if (c === '}') return null;
    out += c; i++;
  }
  if (groups.length !== 1) return null;
  // more than two unbounded quantifiers in one branch can backtrack polynomially (`.*.*.*.*x`): grep and awk answer those
  if (Math.max(groups[0].max, groups[0].cur) > 2) return null;
  try { return new RegExp(out, ignoreCase ? 'i' : ''); } catch { return null; }
}
