// @ts-check
// A273 (issue #264): the text-level write rules of the implementer and the designer. The scanner (command-scan.mjs) is built for the lead's shell
// hook: it splits a word at an unquoted `$(` or a backtick, drops a `>&` file target, hides the rest of a command behind a `$'...\'...'` string and
// knows only the options it names. For the two roles that is not enough, so this module reads the command text with its own tokenizer and returns
// the write targets the scanner does not record, plus the refusals that follow from a word the hook cannot resolve. It is pure: no file system, no
// context. bash.mjs judges every returned target with the same writeRule as a redirect. The lead's verdicts never depend on this module.
//
// The tokenizer reads code wherever the shell runs code: the content of `$(...)`, backticks, `<(...)` and `>(...)`, of a double-quoted string and
// of an unquoted here-document body (their expansions), of a `${...}` default value, the string of `sh|bash|zsh|dash|ksh -c` and of `eval`, the text
// a shell reads from a here-document, a here-string or a pipe. Each is tokenized again as commands (recursively; MAX_DEPTH levels and a work budget of
// 64 times the command length, beyond which the roles are refused: a bound that fails closed). Text that is not code (a commit message, an echo
// argument, a single-quoted string that is not a shell argument, a here-document body no shell reads) is never read as commands. Reserved words
// (`{ } ! if then else elif fi while until do done for in case esac function`) at a command position and the wrappers in front of a command
// (`env sudo doas nohup command builtin exec time nice timeout stdbuf ionice chrt taskset`) are skipped with their options.
//
// Limits (a text scanner cannot know a program's arguments; the same for the lead): programs not in WRITE_PROGRAMS and not named below, a
// non-literal command word, `xargs` and `find -exec` writers, the wrappers busybox, setsid, coproc, flock and `script -c`, the text of an
// interpreter program.
import { WRITE_PROGRAMS } from '../command-scan.mjs';

/** @typedef {{ v: string, q: boolean, sub: boolean, usub: boolean, bt: boolean, vr: boolean, glob: boolean }} Word v: the text with quotes and backslashes removed (a substitution keeps its source text); q: some part was quoted; sub: holds `$(`, a backtick or a process substitution; usub: an unquoted `$(` or process substitution; bt: holds a backtick; vr: holds a parameter expansion or a `$'...'` string with an escape the hook cannot decode; glob: an unquoted `*`, `?` or `[` */
/** @typedef {{ words: Word[], redirs: Array<{ op: string, word: Word }>, assigns: Word[], here: string[], pipeFrom: Simple | null, depth: number, at: { off: number, paren: number } }} Simple here: the here-document bodies read by this command; pipeFrom: the command on the left of the `|`; depth: how many levels of substitution or shell string this command sits in; at: where the top-level command that holds this one starts: its offset in the original text and how many subshell parentheses are open there */
/** @typedef {{ kind: 'deny', why: string } | { kind: 'target', word: Word, cwd: string, bad: boolean }} Action */
/** @typedef {{ overflow: boolean, budget: number }} Guard */

export const ROLE_PROGRAMS = new Set([...WRITE_PROGRAMS, 'mkdir', 'mkfifo', 'mknod']);
/** How many levels of substitution and shell string the role scan follows; a deeper command is refused. */
export const MAX_DEPTH = 8;
const SCAN_DEPTH = 200;
const RESERVED_LEAD = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'done', 'fi', 'esac', 'in']);
const RESERVED_ASSIGN = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);

/** @param {string} v @returns {Word} */
const mkWord = (v) => ({ v, q: false, sub: false, usub: false, bt: false, vr: false, glob: false });
/** @returns {Simple} */
const mkSimple = (/** @type {number} */ depth, /** @type {{ off: number, paren: number }} */ at, /** @type {Simple | null} */ pipeFrom) => ({ words: [], redirs: [], assigns: [], here: [], pipeFrom, depth, at });

/** The index just after the `)` that closes a `$(` whose `(` is at i-1; quotes, backticks, here-document bodies and nested parentheses are skipped. d: how deep the scan is nested in quotes and substitutions (beyond SCAN_DEPTH the rest of the text counts as inside, so the stack stays bounded and the caller reads it again one level down). @param {string} s @param {number} i @param {number} [d] */
function endParen(s, i, d = 0) {
  if (d > SCAN_DEPTH) return s.length;
  let depth = 1;
  /** @type {string[]} */ const pend = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = endDouble(s, i + 1, d + 1); continue; }
    if (c === '`') { i = endTick(s, i + 1); continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      let j = i + 2;
      if (s[j] === '-') j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let d = '';
      while (j < s.length && !/[\s;|&<>()]/.test(/** @type {string} */ (s[j]))) {
        const ch = /** @type {string} */ (s[j]);
        if (ch === "'" || ch === '"') { const e = s.indexOf(ch, j + 1); d += s.slice(j + 1, e < 0 ? s.length : e); j = e < 0 ? s.length : e + 1; } else if (ch === '\\') { d += s[j + 1] ?? ''; j += 2; } else { d += ch; j++; }
      }
      if (d !== '') pend.push(d);
      i = j; continue;
    }
    if (c === '\n' && pend.length > 0) {
      i++;
      while (pend.length > 0) {
        const d = /** @type {string} */ (pend.shift());
        while (i < s.length) {
          let e = s.indexOf('\n', i); if (e < 0) e = s.length;
          const line = s.slice(i, e);
          i = e + 1;
          if (line.replace(/^\t+/, '') === d) break;
        }
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

/** The index just after the closing `"` of a double-quoted part that starts at i (after the opening quote). @param {string} s @param {number} i @param {number} [d] */
function endDouble(s, i, d = 0) {
  if (d > SCAN_DEPTH) return s.length;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === '$' && s[i + 1] === '(') { i = endParen(s, i + 2, d + 1); continue; }
    if (c === '`') { i = endTick(s, i + 1); continue; }
    i++;
  }
  return s.length;
}

/** The index just after the backtick that closes the one before i (an escaped backtick does not close). @param {string} s @param {number} i */
function endTick(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    i++;
  }
  return s.length;
}

/** The index just after the `}` that closes a `${` whose `{` is at i-1. @param {string} s @param {number} i @param {number} [d] */
function endBrace(s, i, d = 0) {
  if (d > SCAN_DEPTH) return s.length;
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = endDouble(s, i + 1, d + 1); continue; }
    if (c === '`') { i = endTick(s, i + 1); continue; }
    if (c === '$' && s[i + 1] === '(') { i = endParen(s, i + 2, d + 1); continue; }
    if (c === '$' && s[i + 1] === '{') { depth++; i += 2; continue; }
    if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

/** The text inside `$(` ... `)` or backticks: from i to e, without the closing character when the construct was closed. @param {string} s @param {number} i @param {number} e @param {string} close */
const innerOf = (s, i, e, close) => s.slice(i, e > i && s[e - 1] === close ? e - 1 : e);
/** The text of a backtick command as the shell reads it: `\\`, `\$` and an escaped backtick lose their backslash. @param {string} t */
const unTick = (t) => t.replace(/\\([\\`$])/g, '$1');

/**
 * The `$'...'` string that starts at i (`$` at i, `'` after it): where it ends, its text, and whether every escape in it is one the hook decodes (`\'`, `\\`, `\"`).
 * @param {string} s @param {number} i @returns {{ end: number, text: string, plain: boolean }}
 */
function ansiC(s, i) {
  let j = i + 2;
  let text = '';
  let plain = true;
  while (j < s.length) {
    const c = /** @type {string} */ (s[j]);
    if (c === "'") return { end: j + 1, text, plain };
    if (c === '\\') {
      const d = s[j + 1] ?? '';
      if (d === "'" || d === '\\' || d === '"') text += d; else { plain = false; text += c + d; }
      j += 2; continue;
    }
    text += c; j++;
  }
  return { end: s.length, text, plain };
}

/**
 * The command text with every `$'...'` string replaced by a plain one (`'...'`, or `"$ANSIC"` when it holds an escape the hook cannot decode, so a write target made of it is unresolvable). The scanner of the lead
 * ends a `$'...'` string at the first `'` and so reads `echo $'a\'b'; touch X` as one quoted word; the implementer and the designer scan this form as well. One pass, linear.
 * @param {string} s
 */
export function rewriteAnsiC(s) {
  if (!s.includes("$'")) return s;
  /** @type {Array<{ t: string, d: number }>} */ const stack = [{ t: 'top', d: 0 }];
  let out = '';
  let last = 0;
  let i = 0;
  while (i < s.length) {
    const f = /** @type {{ t: string, d: number }} */ (stack[stack.length - 1]);
    const c = /** @type {string} */ (s[i]);
    if (c === '\\') { i += 2; continue; }
    if (f.t === 'dq') {
      if (c === '"') { stack.pop(); i++; continue; }
      if (c === '$' && s[i + 1] === '(') { stack.push({ t: 'paren', d: 0 }); i += 2; continue; }
      if (c === '`') { stack.push({ t: 'bt', d: 0 }); i++; continue; }
      i++; continue;
    }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { stack.push({ t: 'dq', d: 0 }); i++; continue; }
    if (c === '$' && s[i + 1] === "'") {
      const a = ansiC(s, i);
      out += s.slice(last, i) + (a.plain ? `'${a.text.replace(/'/g, "'\\''")}'` : '"$ANSIC"');
      last = i = a.end; continue;
    }
    if (c === '$' && s[i + 1] === '(') { stack.push({ t: 'paren', d: 0 }); i += 2; continue; }
    if (c === '`') { if (f.t === 'bt') stack.pop(); else stack.push({ t: 'bt', d: 0 }); i++; continue; }
    if (f.t === 'paren') {
      if (c === '(') f.d++;
      else if (c === ')') { if (f.d === 0) stack.pop(); else f.d--; }
    }
    i++;
  }
  return out + s.slice(last);
}

/**
 * Split a command text into simple commands, nested ones included. One pass per level; here-document bodies are read line by line.
 * @param {string} s @param {number} [depth] @param {Guard} [st] @param {{ off: number, paren: number }} [top] where the top-level command that holds this text starts @returns {Simple[]}
 */
export function tokenize(s, depth = 0, st = { overflow: false, budget: 64 * s.length + 4096 }, top = { off: 0, paren: 0 }) {
  st.budget -= s.length;
  if (depth > MAX_DEPTH || st.budget < 0) { st.overflow = true; return []; }
  /** @type {Simple[]} */ const out = [];
  let segStart = 0;
  let open = 0; // subshell parentheses open at this level
  const offNow = () => (depth === 0 ? { off: segStart, paren: open } : top);
  /** @type {Simple} */ let cur = mkSimple(depth, offNow(), null);
  /** @type {Word | null} */ let w = null;
  /** @type {string | null} */ let pend = null; // the redirect operator waiting for its word
  /** @type {Array<{ d: string, quoted: boolean, dash: boolean, owner: Simple }>} */ const heres = [];
  const n = s.length;
  /** @param {boolean} isPipe */
  const end = (isPipe) => {
    const done = cur;
    if (cur.words.length > 0 || cur.redirs.length > 0 || cur.assigns.length > 0) out.push(cur);
    cur = mkSimple(depth, offNow(), isPipe ? done : null);
    lead = true;
  };
  let lead = true; // every word of the current command so far is a reserved word (an assignment may still follow)
  const flush = () => {
    if (w === null) return;
    const x = w; w = null;
    if (pend !== null) {
      if (pend === '<<' || pend === '<<-') heres.push({ d: x.v, quoted: x.q, dash: pend === '<<-', owner: cur });
      else cur.redirs.push({ op: pend, word: x });
      pend = null;
    } else if (lead && !x.q && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x.v)) cur.assigns.push(x);
    else { cur.words.push(x); lead = lead && !x.q && RESERVED_ASSIGN.has(x.v); }
  };
  /** @param {string} t */
  const add = (t) => { if (w === null) w = mkWord(''); w.v += t; };
  /** @returns {Word} */
  const cw = () => { if (w === null) w = mkWord(''); return w; };
  /** @param {string} inner */
  const nest = (inner) => { for (const sc of tokenize(inner, depth + 1, st, offNow())) out.push(sc); };
  /** The commands inside the expansions of a text read inside double quotes, a here-document or a `${...}`. @param {string} t */
  const subsIn = (t) => {
    let j = 0;
    while (j < t.length) {
      const c = t[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '$' && t[j + 1] === '(') { const e = endParen(t, j + 2); nest(innerOf(t, j + 2, e, ')')); j = e; continue; }
      if (c === '`') { const e = endTick(t, j + 1); nest(unTick(innerOf(t, j + 1, e, '`'))); j = e; continue; }
      j++;
    }
  };
  let i = 0;
  while (i < n) {
    const c = /** @type {string} */ (s[i]);
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush(); end(false); i++;
      while (heres.length > 0) {
        const h = /** @type {{ d: string, quoted: boolean, dash: boolean, owner: Simple }} */ (heres.shift());
        const body = [];
        while (i < n) {
          let e = s.indexOf('\n', i); if (e < 0) e = n;
          const line = s.slice(i, e);
          i = e + 1;
          if ((h.dash ? line.replace(/^\t+/, '') : line) === h.d) break;
          body.push(line);
        }
        const text = body.join('\n');
        h.owner.here.push(text);
        if (!h.quoted) subsIn(text);
      }
      segStart = i;
      cur.at = offNow();
      continue;
    }
    if (c === ';' || c === '(' || c === ')' || (c === '&' && s[i + 1] !== '>') || c === '|') {
      if (c === '(' && s[i + 1] === '(' && w === null && cur.words.length === 0) {
        // `(( ... ))` is arithmetic (its `<<` and `>` are operators, not redirects); `((cmd); cmd)` is two subshells and ends in `)` alone
        const e = endParen(s, i + 1);
        if (e - 2 > i + 1 && s[e - 1] === ')' && s[e - 2] === ')') { subsIn(s.slice(i + 2, e - 2)); i = e; continue; }
      }
      flush();
      let isPipe = false;
      if (c === '|') {
        if (s[i + 1] === '|') i++; else { isPipe = true; if (s[i + 1] === '&') i++; }
      }
      if (c === '(') open++; else if (c === ')' && open > 0) open--;
      end(isPipe); i++; segStart = i; cur.at = offNow(); continue;
    }
    if (c === '#' && w === null) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '&' || c === '>' || c === '<') {
      if ((c === '>' || c === '<') && s[i + 1] === '(') { const e = endParen(s, i + 2); nest(innerOf(s, i + 2, e, ')')); const x = cw(); x.sub = true; x.usub = true; x.v += s.slice(i, e); i = e; continue; }
      // an all-digit unquoted word before the operator is a file descriptor
      if (w !== null && !(/** @type {Word} */ (w)).q && /^[0-9]+$/.test((/** @type {Word} */ (w)).v)) w = null; else flush();
      let op = c;
      if (c === '&') { op = '&>'; i += 2; if (s[i] === '>') { op = '&>>'; i++; } }
      else if (c === '>') { i++; if (s[i] === '>' || s[i] === '&' || s[i] === '|') { op += /** @type {string} */ (s[i]); i++; } }
      else {
        i++;
        if (s[i] === '<') { op = '<<'; i++; if (s[i] === '<') { op = '<<<'; i++; } else if (s[i] === '-') { op = '<<-'; i++; } }
        else if (s[i] === '&' || s[i] === '>') { op += /** @type {string} */ (s[i]); i++; }
      }
      pend = op;
      continue;
    }
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue; }
      const x = cw(); x.q = true; x.v += s[i + 1] ?? ''; i += 2; continue;
    }
    if (c === "'") { const e = s.indexOf("'", i + 1); const x = cw(); x.q = true; x.v += s.slice(i + 1, e < 0 ? n : e); i = e < 0 ? n : e + 1; continue; }
    if (c === '"') {
      const e = endDouble(s, i + 1);
      const body = s.slice(i + 1, Math.max(i + 1, s[e - 1] === '"' && e > i + 1 ? e - 1 : e));
      const x = cw(); x.q = true;
      if (body.includes('`')) { x.sub = true; x.bt = true; }
      if (body.includes('$(')) x.sub = true;
      if (/\$[{A-Za-z_]/.test(body)) x.vr = true;
      subsIn(body);
      x.v += body.replace(/\\([\\"$`])/g, '$1');
      i = e; continue;
    }
    if (c === '`') { const e = endTick(s, i + 1); const x = cw(); x.sub = true; x.bt = true; x.usub = true; x.v += s.slice(i, e); nest(unTick(innerOf(s, i + 1, e, '`'))); i = e; continue; }
    if (c === '$') {
      const nx = s[i + 1];
      if (nx === '(') {
        const e = endParen(s, i + 2);
        const inner = innerOf(s, i + 2, e, ')');
        if (inner.startsWith('(') && inner.endsWith(')')) subsIn(inner); else nest(inner); // `$((...))` is arithmetic: only the substitutions inside it are commands
        const x = cw(); x.sub = true; x.usub = true; x.v += s.slice(i, e); i = e; continue;
      }
      if (nx === '[') { // `$[ ... ]`, the old arithmetic: its `<<` and `>` are operators; only the substitutions inside are commands
        let e = i + 2; let d = 1;
        while (e < n && d > 0) { const ch = s[e]; if (ch === '\\') e++; else if (ch === '[') d++; else if (ch === ']') d--; e++; }
        subsIn(s.slice(i + 2, Math.max(i + 2, e - 1))); const x = cw(); x.vr = true; x.v += s.slice(i, e); i = e; continue;
      }
      if (nx === '{') { const e = endBrace(s, i + 2); const x = cw(); x.vr = true; x.v += s.slice(i, e); subsIn(s.slice(i + 2, e)); i = e; continue; }
      if (nx === "'") { const a = ansiC(s, i); const x = cw(); x.q = true; if (!a.plain) x.vr = true; x.v += a.text; i = a.end; continue; }
      const x = cw(); if (nx !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(nx)) x.vr = true; x.v += '$'; i++; continue;
    }
    if (c === '*' || c === '?' || c === '[') cw().glob = true;
    add(c); i++;
  }
  flush(); end(false);
  return out;
}

/**
 * Wrappers in front of a command word: short letters whose option takes an argument (glued or the next word), long options that take one, positional operands before the command, and the options that change the working directory.
 * @type {Record<string, { short: string, long: string[], pos: number, cd: RegExp | null }>}
 */
const WRAPPERS = {
  env: { short: 'Cu', long: ['--chdir', '--unset'], pos: 0, cd: /^(-[A-Za-z]*C|--chdir)/ },
  sudo: { short: 'DugphrtCUT', long: ['--chdir', '--user', '--group'], pos: 0, cd: /^(-[A-Za-z]*D|--chdir)/ },
  doas: { short: 'uC', long: [], pos: 0, cd: null },
  nohup: { short: '', long: [], pos: 0, cd: null },
  command: { short: '', long: [], pos: 0, cd: null },
  builtin: { short: '', long: [], pos: 0, cd: null },
  exec: { short: 'a', long: [], pos: 0, cd: null },
  time: { short: 'fo', long: ['--format', '--output'], pos: 0, cd: null },
  nice: { short: 'n', long: ['--adjustment'], pos: 0, cd: null },
  timeout: { short: 'ks', long: ['--kill-after', '--signal'], pos: 1, cd: null },
  stdbuf: { short: 'ioe', long: ['--input', '--output', '--error'], pos: 0, cd: null },
  ionice: { short: 'cnpPtu', long: ['--class', '--classdata', '--pid', '--pgid', '--uid'], pos: 0, cd: null },
  chrt: { short: '', long: [], pos: 1, cd: null },
  taskset: { short: 'c', long: [], pos: 1, cd: null },
};

/** @param {string} p */
const base = (p) => { const k = p.lastIndexOf('/'); return k < 0 ? p : p.slice(k + 1); };

/**
 * The words of a simple command without its leading reserved words (`if`, `then`, `{`, `!`, ...); a `for`, `select` or `case` header is not a command at all.
 * @param {Word[]} words @returns {Word[]}
 */
function skipReserved(words) {
  let i = 0;
  while (i < words.length) {
    const x = /** @type {Word} */ (words[i]);
    if (x.q) break;
    if (RESERVED_LEAD.has(x.v)) { i++; continue; }
    if (x.v === 'function') { i += 2; continue; }
    if (x.v === 'for' || x.v === 'select' || x.v === 'case') return [];
    break;
  }
  return words.slice(i);
}

/**
 * Strip the reserved words and the wrappers in front of a command word. `env -C DIR`, `env --chdir=DIR` and `sudo -D DIR` change the working directory of the command they start.
 * @param {Word[]} words @returns {{ words: Word[], chdir: boolean }}
 */
function unwrap(words) {
  let chdir = false;
  let ws = skipReserved(words);
  for (let guard = 0; ws.length > 0 && guard < 64; guard++) {
    const name = base((/** @type {Word} */ (ws[0])).v);
    const spec = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (spec === undefined) break;
    let i = 1;
    let pos = spec.pos;
    while (i < ws.length) {
      const v = (/** @type {Word} */ (ws[i])).v;
      if (v === '--') { i++; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { if (v.startsWith('CDPATH=')) chdir = true; i++; continue; }
      if (!v.startsWith('-') || v === '-') { if (pos > 0) { pos--; i++; continue; } break; }
      if (spec.cd !== null && spec.cd.test(v)) chdir = true;
      let takes = false;
      if (v.startsWith('--')) takes = !v.includes('=') && spec.long.includes(v);
      else {
        for (let k = 1; k < v.length; k++) {
          if (spec.short.includes(/** @type {string} */ (v[k]))) { takes = k === v.length - 1; break; }
        }
      }
      i += takes ? 2 : 1;
    }
    ws = skipReserved(ws.slice(i));
  }
  return { words: ws, chdir };
}

/**
 * Walk the options of one command. `shortArg`: short letters that take an argument (glued or the next word); `gluedArg`: letters whose glued rest is their argument and that never take the next word (`-i.bak`, `-0777`);
 * `longArg`: long options that take an argument (`--opt=VALUE` or the next word).
 * @param {Word[]} args @param {string} shortArg @param {string} gluedArg @param {string[]} longArg
 * @returns {{ opts: Array<{ f: string, arg: Word | null }>, operands: Word[] }}
 */
function parseOpts(args, shortArg, gluedArg, longArg) {
  /** @type {Array<{ f: string, arg: Word | null }>} */ const opts = [];
  /** @type {Word[]} */ const operands = [];
  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = /** @type {Word} */ (args[i]);
    const v = a.v;
    if (endOpts || !v.startsWith('-') || v === '-' || a.q && v === '') { operands.push(a); continue; }
    if (v === '--') { endOpts = true; continue; }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      let name = eq < 0 ? v : v.slice(0, eq);
      const full = longArg.filter((l) => l.startsWith(name));
      if (!longArg.includes(name) && full.length === 1) name = /** @type {string} */ (full[0]); // a unique prefix of a long option names it
      if (eq >= 0) opts.push({ f: name, arg: { ...a, v: v.slice(eq + 1) } });
      else if (longArg.includes(name) && i + 1 < args.length) opts.push({ f: name, arg: /** @type {Word} */ (args[++i]) });
      else opts.push({ f: name, arg: null });
      continue;
    }
    for (let k = 1; k < v.length; k++) {
      const ch = /** @type {string} */ (v[k]);
      if (gluedArg.includes(ch)) { opts.push({ f: `-${ch}`, arg: null }); break; }
      if (shortArg.includes(ch)) {
        const rest = v.slice(k + 1);
        opts.push({ f: `-${ch}`, arg: rest !== '' ? { ...a, v: rest } : i + 1 < args.length ? /** @type {Word} */ (args[++i]) : null });
        break;
      }
      opts.push({ f: `-${ch}`, arg: null });
    }
  }
  return { opts, operands };
}

/** @param {Array<{ f: string, arg: Word | null }>} opts @param {string[]} names @returns {Word[]} */
const argsOf = (opts, names) => opts.filter((o) => names.includes(o.f) && o.arg !== null).map((o) => /** @type {Word} */ (o.arg));
/** @param {Array<{ f: string, arg: Word | null }>} opts @param {string[]} names */
const has = (opts, names) => opts.some((o) => names.includes(o.f));

/**
 * The words a write program writes that the scanner does not record as writes.
 * @param {string} name @param {Word[]} args @returns {Word[]}
 */
export function extraTargets(name, args) {
  switch (name) {
    // GNU `-Z` and `--context` take no argument of their own (`--context=CTX` only glued), so `mkdir -Z DIR` creates DIR
    case 'mkdir': case 'mkfifo': { const p = parseOpts(args, 'm', '', ['--mode']); return p.operands; }
    case 'mknod': { const p = parseOpts(args, 'm', '', ['--mode']); return p.operands.slice(0, 1); }
    case 'install': {
      const p = parseOpts(args, 'mogSt', '', ['--mode', '--owner', '--group', '--suffix', '--target-directory', '--strip-program']);
      return [...(has(p.opts, ['-d', '--directory']) ? p.operands : []), ...argsOf(p.opts, ['-t', '--target-directory'])];
    }
    case 'cp': case 'mv': case 'ln': case 'rsync': {
      const p = parseOpts(args, 'tS', '', ['--target-directory', '--suffix']);
      return argsOf(p.opts, ['-t', '--target-directory']);
    }
    case 'curl': return argsOf(parseOpts(args, 'AbcCdDeEFHKmoPrtTuUwxXyYzQ', '', ['--output', '--output-dir', '--dump-header', '--cookie-jar']).opts, ['-o', '-D', '-c', '--output', '--output-dir', '--dump-header', '--cookie-jar']);
    case 'wget': return argsOf(parseOpts(args, 'OPoaeiTtwUBlQ', '', ['--output-document', '--directory-prefix', '--output-file', '--append-output']).opts, ['-O', '-P', '-o', '-a', '--output-document', '--directory-prefix', '--output-file', '--append-output']);
    case 'sed': case 'gsed': case 'perl': case 'ruby': {
      const p = parseOpts(args, name === 'perl' ? 'eEI' : name === 'ruby' ? 'eIrC' : 'efl', 'i', name === 'perl' || name === 'ruby' ? [] : ['--expression', '--file', '--line-length']);
      if (!has(p.opts, ['-i', '--in-place'])) return [];
      const prog = has(p.opts, ['-e', '-E', '-f', '--expression', '--file']);
      return p.operands.filter((x) => x.v !== '').slice(prog ? 0 : 1);
    }
    case 'awk': case 'gawk': case 'mawk': {
      const p = parseOpts(args, 'fvFeil', '', ['--file', '--assign', '--field-separator', '--include', '--source', '--load']);
      // gawk finds the extension on AWKPATH or takes a path: `-i inplace`, `-i ./inplace.awk`, `--include=/x/inplace`
      const inplace = p.opts.some((o) => (o.f === '-i' || o.f === '--include') && o.arg !== null && base(o.arg.v).replace(/::.*$/, '').replace(/[.]awk$/, '') === 'inplace');
      if (!inplace) return [];
      const prog = has(p.opts, ['-f', '-e', '--file', '--source']);
      return p.operands.filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.v)).slice(prog ? 0 : 1);
    }
    case 'tar': case 'gtar': case 'bsdtar': {
      const first = args[0];
      /** @type {Array<{ f: string, arg: Word | null }>} */ let opts;
      if (first !== undefined && /^[A-Za-z]+$/.test(first.v)) {
        // the old style `tar cfC out.tar dir`: the letters that take an argument read the following words in order
        const rest = args.slice(1);
        opts = [...first.v].map((ch) => ({ f: `-${ch}`, arg: 'fCbILNTXKVFgH'.includes(ch) ? rest.shift() ?? null : null }));
      } else opts = parseOpts(args, 'fCbILNTXKVFgH', '', ['--file', '--directory', '--files-from', '--exclude-from', '--use-compress-program', '--transform', '--xform', '--strip-components', '--to-command', '--index-file', '--blocking-factor', '--label', '--newer', '--mode', '--owner', '--group']).opts;
      /** @param {Word[]} ws */
      const real = (ws) => ws.filter((x) => x.v !== '-');
      return [
        ...(has(opts, ['-c', '-r', '-u', '-A', '--create', '--append', '--update', '--concatenate']) ? real(argsOf(opts, ['-f', '--file'])) : []),
        ...argsOf(opts, ['--index-file']),
        ...(has(opts, ['-x', '--extract', '--get']) ? argsOf(opts, ['-C', '--directory']) : []),
      ];
    }
    case 'patch': case 'gpatch': {
      const p = parseOpts(args, 'pdiorBVzDFYZ', '', ['--strip', '--directory', '--input', '--output', '--reject-file', '--prefix', '--suffix']);
      return [...p.operands, ...argsOf(p.opts, ['-o', '-r', '--output', '--reject-file'])];
    }
    case 'ed': case 'ex': case 'vi': case 'vim': case 'view': case 'nvim': {
      const p = parseOpts(args, 'cSuUiwW', '', ['--cmd']);
      return p.operands.filter((x) => !x.v.startsWith('+') && x.v !== '');
    }
    default: return [];
  }
}


/**
 * The text a shell command reads as code: the `-c` string, the here-document, here-string or pipe it reads when it has no script operand, the arguments of `eval`.
 * @param {string} name @param {Word[]} args @param {Simple} sc @returns {string[]}
 */
function shellCode(name, args, sc) {
  if (name === 'eval') return [args.map((a) => a.v).join(' ')];
  let c = false;
  let i = 0;
  for (; i < args.length; i++) {
    const v = (/** @type {Word} */ (args[i])).v;
    if (v === '--') { i++; break; }
    if (/^[-+][A-Za-z]+$/.test(v)) {
      if (v.startsWith('-') && v.includes('c')) c = true;
      if (/[oO]$/.test(v)) i++;
      continue;
    }
    if (v === '--rcfile' || v === '--init-file') { i++; continue; }
    if (v.startsWith('--')) continue;
    break;
  }
  if (c) return i < args.length ? [(/** @type {Word} */ (args[i])).v] : [];
  if (i < args.length) return []; // a script file
  /** @type {string[]} */ const codes = [...sc.here];
  for (const r of sc.redirs) if (r.op === '<<<') codes.push(r.word.v);
  // a shell at the end of a pipe runs what the left side prints: its words and here-documents are read as code
  for (let p = sc.pipeFrom; p !== null; p = p.pipeFrom) {
    const ws = p.words.map((x) => x.v);
    codes.push(...ws, ws.slice(1).join(' '), ...p.here);
    for (const r of p.redirs) if (r.op === '<<<') codes.push(r.word.v);
  }
  return codes;
}

/**
 * The write rules of the implementer and the designer over the command text. `badAt` is the offset (and `badParen` the number of subshell parentheses open there) of the first command that follows a `cd` the scanner cannot place (-1: none; 0: a wrapper or CDPATH changes the directory):
 * every relative write from there on is unresolvable. It is the one source of that rule: bash.mjs applies it to the scanner's records of the text from `badAt` on, and `bad` to the actions returned here.
 * @param {string} cmd @returns {{ chdir: boolean, badAt: number, badParen: number, actions: Action[] }}
 */
export function roleActions(cmd) {
  /** @type {Action[]} */ const actions = [];
  /** @type {Guard} */ const st = { overflow: false, budget: 64 * cmd.length + 4096 };
  let chdir = false;
  let cwd = '';
  let bad = false;
  let badAt = -1;
  let badParen = 0;
  const target = (/** @type {Word} */ word) => actions.push({ kind: 'target', word, cwd, bad });
  /** @param {Simple} sc */
  const judge = (sc) => {
    if (sc.assigns.some((a) => a.v.startsWith('CDPATH='))) chdir = true;
    for (const r of sc.redirs) {
      if (r.op === '>&') { if (!/^([0-9]+-?|-)$/.test(r.word.v) || r.word.q) target(r.word); }
      else if (r.word.bt && !r.op.startsWith('<')) target(r.word);
      // a redirect inside a substitution or a shell string: the scanner of the lead may not read it (the same writeRule judges it)
      else if (sc.depth > 0 && (r.op === '>' || r.op === '>>' || r.op === '>|' || r.op === '&>' || r.op === '&>>')) target(r.word);
      else if (r.op === '<>') target(r.word);
    }
    const un = unwrap(sc.words);
    if (un.chdir) chdir = true;
    const first = un.words[0];
    if (first === undefined) return;
    const name = base(first.v);
    const args = un.words.slice(1);
    if (name === 'export' && args.some((a) => a.v.startsWith('CDPATH'))) chdir = true;
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const operand = args.find((a) => a.v !== '--');
      if (name !== 'cd' || operand === undefined || operand.v === '' || operand.sub || operand.vr || operand.glob || /^[-~]/.test(operand.v) || /[{}]/.test(operand.v)) { if (!bad) { badAt = sc.at.off; badParen = sc.at.paren; } bad = true; }
      else cwd = /^([/]|[A-Za-z]:)/.test(operand.v) || cwd === '' ? operand.v : `${cwd}/${operand.v}`;
      return;
    }
    if (SHELLS.has(name) || name === 'eval') {
      const saved = cwd;
      for (const code of shellCode(name, args, sc)) {
        if (sc.depth + 1 > MAX_DEPTH) { st.overflow = true; break; }
        for (const inner of tokenize(code, sc.depth + 1, st, sc.at)) judge(inner);
      }
      cwd = saved;
      return;
    }
    if (!ROLE_PROGRAMS.has(name)) return;
    for (const a of args) {
      if (a.bt || a.usub) { actions.push({ kind: 'deny', why: `the command gives ${name} an operand '${a.v}' that holds a command substitution, which cannot be resolved` }); break; }
    }
    for (const t of extraTargets(name, args)) target(t);
  };
  for (const sc of tokenize(cmd, 0, st, 0)) judge(sc);
  if (chdir) { badAt = 0; badParen = 0; for (const a of actions) if (a.kind === 'target') a.bad = true; }
  if (st.overflow) actions.push({ kind: 'deny', why: `the command nests substitutions or shell strings deeper than ${MAX_DEPTH} levels or is too large to read, so what it writes cannot be judged` });
  return { chdir, badAt, badParen, actions };
}
