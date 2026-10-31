// @ts-check
// Small, exact copies of the shell's string rules that the leaf commands of stage 2 depend on: the `case` pattern match (`case X in $PAT)`),
// the pathname expansion of an unquoted word in the working folder, the awk glob dialect of `path_matches` (g2re), ASCII case folding and the
// `[[:space:]]` class of the C locale. Text is a byte string (one char per byte, latin1), as everywhere in the core. A pattern whose meaning
// differs between the shells in use (a backslash, `[^`, a character class name, a reversed range) throws BridgeToShell: nothing has been
// written yet and the entry then runs the shell code for the same arguments.
import { readdirSync } from 'node:fs';
import { BridgeToShell } from './errors.mjs';

/** POSIX [[:space:]] in the C locale. */
export const SPACE_CLASS = '[ \\t\\n\\v\\f\\r]';
const reTrimBoth = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

/** awk `trim`: the leading and trailing [[:space:]] removed. @param {string} s */
export function trimSpace(s) { return s.replace(reTrimBoth, ''); }

/** awk `tolower` and `tr '[:upper:]' '[:lower:]'` in the C locale: ASCII only. @param {string} s */
export function asciiLower(s) { return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)); }

/**
 * @typedef {{ t: 'lit', c: number } | { t: 'any' } | { t: 'star' } | { t: 'set', neg: boolean, items: Array<[number, number]> }} Tok
 */

/** @type {Map<string, Tok[]>} */
const compiled = new Map();

/** @param {string} pat @returns {Tok[]} */
function compile(pat) {
  const hit = compiled.get(pat);
  if (hit) return hit;
  if (pat.includes('\\')) throw new BridgeToShell('backslash in a case pattern');
  /** @type {Tok[]} */ const toks = [];
  let i = 0;
  while (i < pat.length) {
    const c = pat[i];
    if (c === '*') { if (toks.length === 0 || toks[toks.length - 1].t !== 'star') toks.push({ t: 'star' }); i++; continue; }
    if (c === '?') { toks.push({ t: 'any' }); i++; continue; }
    if (c === '[') {
      let j = i + 1;
      let neg = false;
      if (pat[j] === '^') throw new BridgeToShell('[^ in a case pattern');
      if (pat[j] === '!') { neg = true; j++; }
      const first = j;
      /** @type {Array<[number, number]>} */ const items = [];
      let closed = false;
      while (j < pat.length) {
        const ch = pat[j];
        if (ch === ']' && j > first) { closed = true; break; }
        if (ch === '[' && (pat[j + 1] === ':' || pat[j + 1] === '.' || pat[j + 1] === '=')) throw new BridgeToShell('class name in a case pattern');
        if (pat[j + 1] === '-' && j + 2 < pat.length && pat[j + 2] !== ']') {
          const lo = pat.charCodeAt(j); const hi = pat.charCodeAt(j + 2);
          if (hi < lo) throw new BridgeToShell('reversed range in a case pattern');
          items.push([lo, hi]); j += 3; continue;
        }
        items.push([pat.charCodeAt(j), pat.charCodeAt(j)]); j++;
      }
      if (!closed) throw new BridgeToShell('unclosed [ in a case pattern: the shells differ');
      toks.push({ t: 'set', neg, items });
      i = j + 1;
      continue;
    }
    toks.push({ t: 'lit', c: pat.charCodeAt(i) }); i++;
  }
  compiled.set(pat, toks);
  return toks;
}

/** @param {Tok} t @param {number} ch */
function one(t, ch) {
  switch (t.t) {
    case 'lit': return t.c === ch;
    case 'any': return true;
    case 'set': { const inSet = t.items.some(([lo, hi]) => ch >= lo && ch <= hi); return t.neg ? !inSet : inSet; }
    default: return false;
  }
}

/**
 * `case STRING in PATTERN)` for an unquoted pattern taken from a variable: `*` any string, `?` one byte, `[...]` a class, the rest literal.
 * @param {string} pat @param {string} s
 */
export function caseMatch(pat, s) {
  const toks = compile(pat);
  let ti = 0; let si = 0; let starT = -1; let starS = 0;
  while (si < s.length) {
    if (ti < toks.length && toks[ti].t === 'star') { starT = ti; starS = si; ti++; continue; }
    if (ti < toks.length && one(toks[ti], s.charCodeAt(si))) { ti++; si++; continue; }
    if (starT >= 0) { starS++; si = starS; ti = starT + 1; continue; }
    return false;
  }
  while (ti < toks.length && toks[ti].t === 'star') ti++;
  return ti === toks.length;
}

/** Whether a word has a character the shell expands against file names (`*`, `?`, or a `[` that a later `]` closes). @param {string} w */
function hasGlobChars(w) { return /[*?]/.test(w) || /\[[^]*\]/.test(w); }

/**
 * `for x in $(...)`: field splitting on space, tab and newline, then pathname expansion of each word in the working folder; a word that
 * matches nothing stays as it is. Words with a `/` or a backslash and glob characters are not expanded here (the shell code decides).
 * @param {string} text @param {string} cwd
 * @returns {string[]}
 */
export function expandWords(text, cwd) {
  /** @type {string[]} */ const out = [];
  /** @type {string[] | null} */ let names = null;
  for (const w of text.split(/[ \t\n]+/)) {
    if (w === '') continue;
    if (!hasGlobChars(w)) { out.push(w); continue; }
    if (w.includes('/') || w.includes('\\') || w.startsWith('.')) throw new BridgeToShell('pathname expansion of a word with a slash');
    if (names === null) {
      try { names = readdirSync(cwd, { encoding: 'latin1' }).sort(); } catch { names = []; }
    }
    const m = names.filter((n) => !n.startsWith('.') && caseMatch(w, n));
    if (m.length === 0) out.push(w); else out.push(...m);
  }
  return out;
}

/** @type {Map<string, RegExp>} */
const globRes = new Map();

/**
 * `g2re` of agent.sh: the glob dialect of the path lists (no `/` means any depth, `**` spans directories, `*` and `?` stay in one segment).
 * @param {string} glob
 */
export function awkGlobRegExp(glob) {
  const hit = globRes.get(glob);
  if (hit) return hit;
  const p = glob.includes('/') ? glob : `**/${glob}`;
  let r = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') { r += '(.*/)?'; i += 2; } else { r += '.*'; i += 1; }
      } else r += '[^/]*';
    } else if (c === '?') r += '[^/]';
    else if ('.+()|^$[]{}\\'.includes(c)) r += `\\${c}`;
    else r += c;
  }
  const re = new RegExp(`^${r}$`, 's');
  globRes.set(glob, re);
  return re;
}

/**
 * `path_matches PATH "GLOB GLOB ..."`: does one of the globs (split on blanks and newlines) match the path? A path with a newline is several
 * awk records: the shell code decides.
 * @param {string} p @param {string} globs
 */
export function pathMatches(p, globs) {
  if (p.includes('\n')) throw new BridgeToShell('newline in a path');
  for (const g of globs.split(/[ \t\n]+/)) if (g !== '' && awkGlobRegExp(g).test(p)) return true;
  return false;
}
