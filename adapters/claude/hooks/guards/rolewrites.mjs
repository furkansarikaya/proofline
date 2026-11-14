// @ts-check
// A274 (issue #264): the text-level write rules of the implementer and the designer. The scanner (command-scan.mjs) is built for the lead's shell
// hook: it splits a word at an unquoted `$(` or a backtick, drops a `>&` file target, hides the rest of a command behind a `$'...\'...'` string and
// knows only the options it names. For the two roles that is not enough, so this module reads the command text with its own tokenizer and returns
// the write targets the scanner does not record, plus the refusals that follow from a word the hook cannot resolve. It is pure: no file system, no
// context. bash.mjs judges every returned target with the same writeRule as a redirect. The lead's verdicts never depend on this module.
//
// The tokenizer reads code wherever the shell runs code: the content of `$(...)`, backticks, `<(...)` and `>(...)`, of a double-quoted string and
// of an unquoted here-document body (their expansions), of a `${...}` default value, the string of `sh|bash|zsh|dash|ksh -c` and of `eval`, the text
// a shell reads from a here-document, a here-string or a pipe. Each is tokenized again as commands (recursively; MAX_DEPTH levels and a work budget of
// STEPS_PER_CHAR times the command length, beyond which the roles are refused: a bound that fails closed). Text that is not code (a commit message, an echo
// argument, a single-quoted string that is not a shell argument, a here-document body no shell reads) is never read as commands. Reserved words
// (`{ } ! if then else elif fi while until do done for in case esac function`) at a command position and the wrappers in front of a command
// (`env sudo doas nohup command builtin exec time nice timeout stdbuf ionice chrt taskset`) are skipped with their options.
//
// Limits (a text scanner cannot know a program's arguments; the same for the lead): programs not in WRITE_PROGRAMS and not named below, a
// writers the scanner also cannot see (`mktemp`, `git init`, `sort -o`, sed `w`), `xargs` and `find -exec` writers, the wrappers busybox, flock, `arch`,
// `caffeinate`, `xcrun` and other wrappers not in the table, `script -c`, `hash -p`, scripts, /dev/fd/N, csh, the text of an interpreter program.
import { WRITE_PROGRAMS } from '../command-scan.mjs';

/**
 * @typedef {{ v: string, q: boolean, sub: boolean, usub: boolean, bt: boolean, vr: boolean, glob: boolean, qAt: number }} Word
 * v: the text with quotes and backslashes removed (a substitution keeps its source text);
 * q: some part was quoted;
 * sub: holds `$(`, a backtick or a process substitution;
 * usub: an unquoted `$(` or process substitution;
 * bt: holds a backtick;
 * vr: holds a parameter expansion or a `$'...'` string with an escape the hook cannot decode;
 * glob: an unquoted `*`, `?` or `[`;
 */
/**
 * @typedef {{ words: Word[], redirs: Array<{ op: string, word: Word }>, assigns: Word[], here: string[], pipeFrom: Simple | null, strict: boolean, arr: boolean, depth: number, at: { off: number, paren: number } }} Simple
 * here: the here-document bodies read by this command;
 * pipeFrom: the command on the left of the `|`;
 * depth: how many levels of substitution or shell string this command sits in;
 * at: where the top-level command that holds this one starts: its offset in the original text and how many subshell parentheses are open there;
 */
/** @typedef {{ kind: 'deny', why: string }
 *   | { kind: 'target', word: Word, cwd: string, bad: boolean }
 *   | { kind: 'redir', word: Word, cwd: string, bad: boolean }
 *   | { kind: 'scan', text: string, cwd: string, bad: boolean }} Action
 * target: a word judged as unresolvable when it holds a variable, substitution or glob; redir: the file of a top-level output redirect, judged by the write rule itself;
 * scan: the rebuilt command of a write program the scanner of the lead knows, whose W and L records the guard judges */
/**
 * @typedef {{ overflow: boolean, budget: number, unsure: string, texts: string[] }} Guard
 * budget: steps of work left (one per character or token read, across every nested scan), never time;
 * unsure: the first region the hook is not certain how bash parses;
 * texts: the text of every nested region read (the guard also runs the scanner of the lead over each, so a writer the scanner knows is judged wherever it sits);
 */

export const ROLE_PROGRAMS = new Set([...WRITE_PROGRAMS, 'mkdir', 'mkfifo', 'mknod']);
/** How many levels of substitution and shell string the role scan follows; a deeper command is refused. */
export const MAX_DEPTH = 8;
const SCAN_DEPTH = 200;
const MAX_TEXTS = 4000;
/** The work budget of one scan: STEPS_PER_CHAR steps per character of the command plus STEPS_BASE. */
export const STEPS_PER_CHAR = 64;
export const STEPS_BASE = 4096;
/** How many wrappers in a row (`nice env time ...`) unwrap strips before it stops. */
export const MAX_WRAPPERS = 64;
/** The most scanner passes over rebuilt writer commands (one per write program in the command). */
const MAX_SCANS = 4000;
const RESERVED_LEAD = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'done', 'fi', 'esac', 'in']);
/** The long options of tar that take a value. */
const TAR_LONG_ARG = ['--file',
  '--directory',
  '--files-from',
  '--exclude-from',
  '--use-compress-program',
  '--transform',
  '--xform',
  '--strip-components',
  '--to-command',
  '--index-file',
  '--blocking-factor',
  '--label',
  '--newer',
  '--mode',
  '--owner',
  '--group'];
const RESERVED_ASSIGN = new Set(['{', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until']);
/** Words after which the next word is still at a command position. */
const CMD_KEEP = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time']);
const BRACE_RE = /\{[^{}]*(,|\.\.)[^{}]*\}/;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const OUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);

/** @param {string} v @returns {Word} */
const mkWord = (v) => ({ v, q: false, sub: false, usub: false, bt: false, vr: false, glob: false, qAt: -1 });
/** Mark a word as quoted from here on; qAt remembers where in its text the first quoted part began (`X='a'` is an assignment, `'X'=a` is not). @param {Word} x */
const markQ = (x) => { if (!x.q) x.qAt = x.v.length; x.q = true; };
/** Is the word an assignment `NAME=value` (the value may be quoted)? @param {Word} x */
const isAssign = (x) => { const m = ASSIGN_RE.exec(x.v); return m !== null && (!x.q || x.qAt >= m[0].length); };
/** @returns {Simple} */
const mkSimple = (/** @type {number} */ depth, /** @type {{ off: number, paren: number }} */ at, /** @type {Simple | null} */ pipeFrom) => ({ words: [], redirs: [], assigns: [], here: [], pipeFrom, strict: false, arr: false, depth, at });

/** The work counter and the doubts of the scan in progress (set by `tokenize` and `roleActions`; the scan is synchronous, so one module variable is enough). @type {Guard} */
let G = { overflow: false, budget: Infinity, unsure: '', texts: [] };
/** One step of work; false when the budget is spent (the scan then stops and the roles are refused). */
const step = () => { if (G.budget <= 0) { G.overflow = true; return false; } G.budget--; return true; };
/** @param {string} why a region the hook is not certain how bash parses: the roles are refused */
const doubt = (why) => { if (G.unsure === '') G.unsure = why; };

/**
 * The index just after the `)` that closes a `$(` whose `(` is at i-1; quotes, backticks, `${...}`, here-document bodies and nested parentheses are skipped. Constructs bash reads in ways this scan does not
 * (a comment, `case` and `;;`, a here-document marker inside arithmetic, an unterminated region) are recorded as a doubt: the caller refuses the roles. d: how deep the scan is nested in quotes and
 * substitutions (beyond SCAN_DEPTH the rest of the text counts as inside, so the stack stays bounded).
 * hdr: the scan is the probe of a `((` ... `))` header, where `;;` (an empty `for ((;;))` part) is no case terminator.
 * @param {string} s @param {number} i @param {number} [d] @param {boolean} [hdr]
 */
function endParen(s, i, d = 0, hdr = false) {
  if (d > SCAN_DEPTH) { G.overflow = true; return s.length; }
  let depth = 1;
  let arith = false;
  /** @type {string[]} */ const pend = [];
  let cmdPos = true; // the next word is at a command position (a `case` or `esac` there starts or ends a case command; as an argument it is a plain word)
  while (i < s.length) {
    if (!step()) return s.length;
    const c = /** @type {string} */ (s[i]);
    const atCmd = cmdPos;
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === '\n' || (c === '{' && /\s/.test(s[i + 1] ?? ' ')) || (c === '!' && atCmd)) cmdPos = true;
    else if (c !== ' ' && c !== '\t' && c !== '\r') cmdPos = false;
    const edge = i === 0 || /[\s;&|(){}<>]/.test(/** @type {string} */ (s[i - 1]));
    if (atCmd && /[A-Za-z]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_.-]/.test(/** @type {string} */ (s[j]))) j++;
      const word = s.slice(i, j);
      if ((word === 'case' || word === 'esac') && /^[\s;)]?$/.test(s[j] ?? '')) doubt('a case command inside a substitution');
      cmdPos = CMD_KEEP.has(word);
      i = j; continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) doubt('an unterminated quote'); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = endDouble(s, i + 1, d + 1); continue; }
    if (c === '`') { i = endTick(s, i + 1); continue; }
    if (c === '$' && s[i + 1] === "'") { i = ansiC(s, i).end; continue; }
    if (c === '$' && s[i + 1] === '{') { i = endBrace(s, i + 2, d + 1); continue; }
    if (c === '$' && s[i + 1] === '[') arith = true;
    if (c === '#' && edge) doubt('a comment inside a substitution');
    if (c === ';' && s[i + 1] === ';' && !(hdr && depth === 2)) doubt('a case pattern list inside a substitution');
    if (c === '(' && s[i + 1] === '(') arith = true;
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      if (arith) doubt('a << inside arithmetic in a substitution');
      let j = i + 2;
      if (s[j] === '-') j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      let dl = '';
      while (j < s.length && !/[\s;|&<>()]/.test(/** @type {string} */ (s[j]))) {
        const ch = /** @type {string} */ (s[j]);
        if (ch === "'" || ch === '"') { const e = s.indexOf(ch, j + 1); dl += s.slice(j + 1, e < 0 ? s.length : e); j = e < 0 ? s.length : e + 1; } else if (ch === '\\') { dl += s[j + 1] ?? ''; j += 2; } else { dl += ch; j++; }
      }
      if (dl !== '') pend.push(dl);
      i = j; continue;
    }
    if (c === '\n' && pend.length > 0) {
      i++;
      while (pend.length > 0) {
        const dl = /** @type {string} */ (pend.shift());
        while (i < s.length) {
          if (!step()) return s.length;
          let e = s.indexOf('\n', i); if (e < 0) e = s.length;
          const line = s.slice(i, e);
          i = e + 1;
          if (line.replace(/^\t+/, '') === dl) break;
        }
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  doubt('an unterminated substitution');
  return s.length;
}

/** The index just after the closing `"` of a double-quoted part that starts at i (after the opening quote). @param {string} s @param {number} i @param {number} [d] */
function endDouble(s, i, d = 0) {
  if (d > SCAN_DEPTH) { G.overflow = true; return s.length; }
  while (i < s.length) {
    if (!step()) return s.length;
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === '$' && s[i + 1] === '(') { i = endParen(s, i + 2, d + 1); continue; }
    if (c === '$' && s[i + 1] === '{') { i = endBrace(s, i + 2, d + 1); continue; }
    if (c === '`') { i = endTick(s, i + 1); continue; }
    i++;
  }
  doubt('an unterminated double quote');
  return s.length;
}

/** The index just after the backtick that closes the one before i (an escaped backtick does not close). @param {string} s @param {number} i */
function endTick(s, i) {
  while (i < s.length) {
    if (!step()) return s.length;
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    i++;
  }
  doubt('an unterminated backtick');
  return s.length;
}

/** The index just after the `}` that closes a `${` whose `{` is at i-1. @param {string} s @param {number} i @param {number} [d] */
function endBrace(s, i, d = 0) {
  if (d > SCAN_DEPTH) { G.overflow = true; return s.length; }
  let depth = 1;
  while (i < s.length) {
    if (!step()) return s.length;
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) doubt('an unterminated quote'); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = endDouble(s, i + 1, d + 1); continue; }
    if (c === '`') { i = endTick(s, i + 1); continue; }
    if (c === '$' && s[i + 1] === '(') { i = endParen(s, i + 2, d + 1); continue; }
    if (c === '$' && s[i + 1] === '{') { depth++; i += 2; continue; }
    if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  doubt('an unterminated ${...}');
  return s.length;
}

const DECL_BUILTINS = new Set(['declare', 'local', 'export', 'readonly', 'typeset']);

/**
 * The offset of the `)` that closes an array body that starts at i (just after the `(`), or -1 when the body is not only words: a top-level `;` `&` `|` `<` `>` `#` `(` or an unbalanced end is refused.
 * Quotes, `$(...)`, `$((...))`, `${...}`, `$'...'` and backticks are skipped as parts of a word; a backslash-newline is a continuation.
 * @param {string} s @param {number} i
 */
function arrayEnd(s, i) {
  const before = G.unsure;
  while (i < s.length) {
    if (!step()) return -1;
    const c = /** @type {string} */ (s[i]);
    if (c === ')') {
      // a word glued to the `)` (`x=(a)# c`, `x=(a)\ cmd`, `x=(a)b`) continues the assignment word in bash, which the hook reads as a comment or a command
      let k = i + 1;
      while (s[k] === '\\' && s[k + 1] === '\n') k += 2;
      return G.unsure === before && (k >= s.length || /[ \t\r\n;&|)<>]/.test(/** @type {string} */ (s[k]))) ? i : -1;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '\\') { if (i + 1 >= s.length) return -1; i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '"') { const e = endDouble(s, i + 1); if (s[e - 1] !== '"' || e - 1 <= i) return -1; i = e; continue; }
    if (c === '`') { const e = endTick(s, i + 1); if (s[e - 1] !== '`' || e - 1 <= i) return -1; i = e; continue; }
    if (c === '$') {
      const nx = s[i + 1];
      if (nx === '(') { const e = endParen(s, i + 2); if (s[e - 1] !== ')' || e - 1 < i + 2) return -1; i = e; continue; }
      if (nx === '{') { const e = endBrace(s, i + 2); if (s[e - 1] !== '}' || e - 1 < i + 2) return -1; i = e; continue; }
      if (nx === "'") { const a = ansiC(s, i); if (a.end - 1 <= i + 1 || s[a.end - 1] !== "'") return -1; i = a.end; continue; }
      if (nx === '[') return -1;
      i++; continue;
    }
    if (';&|<>#('.includes(c)) return -1;
    i++;
  }
  return -1;
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
export function tokenize(s, depth = 0, st = newGuard(s.length), top = { off: 0, paren: 0 }) {
  const prev = G;
  G = st;
  try { return tokenizeIn(s, depth, st, top); } finally { G = prev; }
}

/** A fresh work counter for a command of n characters: STEPS_PER_CHAR steps per character and STEPS_BASE. @param {number} n @returns {Guard} */
export const newGuard = (n) => ({ overflow: false, budget: STEPS_PER_CHAR * n + STEPS_BASE, unsure: '', texts: [] });

const NUM_RE = /0[xX][0-9a-fA-F]+|[0-9]+(#[0-9A-Za-z@_]+)?/y;
const DOLLAR_RE = /\$([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[#?@*!$-])/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const ARITH_OPS = ['<<=', '>>=', '**', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '++', '--', '+', '-', '*', '/', '%', '<', '>', '&', '|', '^', '!', '?', ':', ',', '=', '(', ')', '[', ']'];

/**
 * Is the text a valid bash arithmetic expression? A small recursive-descent validator: numbers, identifiers (with `[index]`), `$name`, `${...}`, `$(...)` and backticks (whose commands are scanned on their own),
 * unary, binary, ternary, assignment and comma operators, balanced parentheses, white space; nothing else (no quote, backslash, `;`, newline, `~`, a word that follows a word, `:` outside `?:`, a `--` followed by a path).
 * Whether `((` ... `))` is arithmetic is decided by this grammar: text that is not valid arithmetic is read as commands (`((:)&&(mkdir -- X))` is two subshells). An empty text is valid.
 * @param {string} t
 */
export function isArithmetic(t) {
  const keep = G.unsure;
  try { return arithOk(t); } finally { G.unsure = keep; }
}

/** @param {string} t */
function arithOk(t) {
  let i = 0;
  let depth = 0;
  let ternary = 0;
  /** The match of a sticky expression at i (no slice of the text: linear). @param {RegExp} re */
  const at = (re) => { re.lastIndex = i; return re.exec(t); };
  const skipWs = () => { while (i < t.length && (t[i] === ' ' || t[i] === '\t')) i++; };
  /** The next operator at i, or '' @returns {string} */
  const op = () => { skipWs(); for (const o of ARITH_OPS) if (t.startsWith(o, i)) return o; return ''; };
  /** An expansion at i (`$` there): `$(...)`, `${...}`, `$[...]`, `$name`, `$1`, `$#`; its commands are scanned on their own. @returns {boolean} */
  const dollar = () => {
    const nx = t[i + 1];
    if (nx === '(') { const e = endParen(t, i + 2); if (e - 1 < i + 2 || t[e - 1] !== ')') return false; i = e; return true; }
    if (nx === '{') { const e = endBrace(t, i + 2); if (e - 1 < i + 2 || t[e - 1] !== '}') return false; i = e; return true; }
    if (nx === '[') {
      let j = i + 2; let d = 1;
      while (j < t.length && d > 0) { if (!step()) return false; if (t[j] === '[') d++; else if (t[j] === ']') d--; j++; }
      if (d > 0 || !arithOk(t.slice(i + 2, j - 1))) return false;
      i = j; return true;
    }
    const m = at(DOLLAR_RE);
    if (m === null) return false;
    i += m[0].length;
    return true;
  };
  /** The rest of a name or number written together with expansions: letters, digits, `_` and `$name`, `${...}`, `$(...)`, `$1` (`a$i`, `$x$y`, `${x}0`, `count_$name`). @returns {boolean} */
  const juxta = () => {
    for (;;) {
      while (i < t.length && /[0-9A-Za-z_]/.test(/** @type {string} */ (t[i]))) i++;
      if (t[i] !== '$') return true;
      if (!dollar()) return false;
    }
  };
  /** One operand; false when the text there is not one. @returns {boolean} */
  const primary = () => {
    if (!step() || ++depth > SCAN_DEPTH) return false;
    try {
      skipWs();
      const c = t[i];
      if (c === undefined) return false;
      if (c === '(') { i++; if (!expr()) return false; skipWs(); if (t[i] !== ')') return false; i++; return true; }
      if (/[0-9]/.test(c)) {
        const m = at(NUM_RE);
        if (m === null) return false;
        i += m[0].length;
        // a base prefix followed by an expansion: `10#$x`, `0x$h`, `16#ff$x`
        if ((t[i] === '#' || ((t[i] === 'x' || t[i] === 'X') && m[0] === '0')) && t[i + 1] === '$') i++;
        if (t[i] === '$') {
          while (t[i] === '$') { if (!dollar()) return false; while (i < t.length && /[0-9A-Za-z@_]/.test(/** @type {string} */ (t[i]))) i++; }
          return true;
        }
        return /[A-Za-z_]/.test(t[i] ?? ' ') ? false : true;
      }
      if (c === '$') { if (!dollar()) return false; return juxta(); }
      if (c === '~') { i++; return primary(); }
      if (c === '"') { const e = endDouble(t, i + 1); if (e - 1 <= i || t[e - 1] !== '"') return false; if (!arithOk(t.slice(i + 1, e - 1))) return false; i = e; return true; }
      if (c === '`') { const e = endTick(t, i + 1); if (e - 1 <= i || t[e - 1] !== '`') return false; i = e; return true; }
      if (/[A-Za-z_]/.test(c)) {
        const m = at(IDENT_RE);
        i += /** @type {RegExpExecArray} */ (m)[0].length;
        if (!juxta()) return false;
        if (t[i] === '[') { i++; if (!expr()) return false; skipWs(); if (t[i] !== ']') return false; i++; }
        return true;
      }
      return false;
    } finally { depth--; }
  };
  /** unary prefix operators, an operand, an optional postfix ++ or -- @returns {boolean} */
  const unary = () => {
    for (let o = op(); o === '+' || o === '-' || o === '!' || o === '++' || o === '--'; o = op()) i += o.length;
    if (!primary()) return false;
    const o = op();
    if (o === '++' || o === '--') i += 2;
    return true;
  };
  /** operands joined by binary and assignment operators, with an optional ?: @returns {boolean} */
  const assign = () => {
    if (!unary()) return false;
    for (;;) {
      const o = op();
      if (o === '?') { i++; ternary++; if (!expr()) return false; if (op() !== ':') return false; i++; ternary--; if (!assign()) return false; continue; }
      if (o === '' || o === ')' || o === ']' || o === ',' || o === ':' || o === '(' || o === '[' || o === '!') return true;
      i += o.length;
      if (!unary()) return false;
    }
  };
  /** @returns {boolean} */
  const expr = () => {
    if (!assign()) return false;
    while (op() === ',') { i++; if (!assign()) return false; }
    return true;
  };
  skipWs();
  if (i >= t.length) return true;
  if (!expr()) return false;
  skipWs();
  return i >= t.length && ternary === 0;
}

/** The three parts of a `for ((a; b; c))` header, each valid arithmetic (an empty part is valid). @param {string} t */
const forHeaderOk = (t) => { const p = t.split(';'); return p.length === 3 && p.every((x) => isArithmetic(x)); };

/** @param {string} s @param {number} depth @param {Guard} st @param {{ off: number, paren: number }} top @returns {Simple[]} */
function tokenizeIn(s, depth, st, top) {
  if (!step()) return [];
  if (depth > MAX_DEPTH) { st.overflow = true; return []; }
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
  let arrUntil = -1; // offset of the `)` that closes a placed array body: the words up to it are array elements, not command words
  let strictUntil = -1; // offset up to which a command word that is not literal is refused even without an operand (the text after a `((` that is not arithmetic)
  const end = (isPipe) => {
    const done = cur;
    if (i <= strictUntil) done.strict = true;
    if (i <= arrUntil) done.arr = true;
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
    } else if (lead && isAssign(x)) cur.assigns.push(x);
    else { cur.words.push(x); lead = lead && !x.q && RESERVED_ASSIGN.has(x.v); }
  };
  /** @param {string} t */
  const add = (t) => { if (w === null) w = mkWord(''); w.v += t; };
  /** @returns {Word} */
  const cw = () => { if (w === null) w = mkWord(''); return w; };
  /** @param {string} inner */
  const nest = (inner, strict = false) => { if (inner.trim() !== '') st.texts.push(inner); for (const sc of tokenize(inner, depth + 1, st, offNow())) { if (strict) sc.strict = true; out.push(sc); } };
  /** The commands inside the expansions of a text read inside double quotes, a here-document or a `${...}`. @param {string} t */
  const subsIn = (t) => {
    let j = 0;
    while (j < t.length) {
      if (!step()) return;
      const c = t[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '$' && t[j + 1] === '(') { const e = endParen(t, j + 2); substParen(innerOf(t, j + 2, e, ')')); j = e; continue; }
      if (c === '`') { const e = endTick(t, j + 1); nest(unTick(innerOf(t, j + 1, e, '`'))); j = e; continue; }
      j++;
    }
  };
  /** The text inside a `$(` ... `)`: `$((...))` is arithmetic when the text between the inner parentheses is a valid expression (only the substitutions in it are commands), otherwise subshells. @param {string} inner */
  const substParen = (inner) => {
    const wrapped = inner.startsWith('(') && inner.endsWith(')');
    if (wrapped) arithSubs(inner); // quotes and `#` protect nothing inside arithmetic text: every substitution in it runs
    if (wrapped && isArithmetic(inner.slice(1, -1))) return;
    nest(inner, wrapped);
  };
  /** Every `$(...)` and backtick substitution in a raw arithmetic text (`$((`, `((`, `for ((`), whatever quote or `#` is around it, scanned as commands; `${...}` and `$[...]` are read through, so the ones inside are found. @param {string} t */
  const arithSubs = (t) => {
    let j = 0;
    while (j < t.length) {
      if (!step()) return;
      const c = t[j];
      if (c === '$' && t[j + 1] === '(') { const e = endParen(t, j + 2); substParen(innerOf(t, j + 2, e, ')')); j = e; continue; }
      if (c === '`') { const e = endTick(t, j + 1); nest(unTick(innerOf(t, j + 1, e, '`'))); j = e; continue; }
      j++;
    }
  };
  let i = 0;
  while (i < n) {
    if (!step()) break;
    const c = /** @type {string} */ (s[i]);
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush(); end(false); i++;
      while (heres.length > 0) {
        const h = /** @type {{ d: string, quoted: boolean, dash: boolean, owner: Simple }} */ (heres.shift());
        const body = [];
        while (i < n) {
          if (!step()) break;
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
      // an unquoted `((` that is not part of `$((` is always an arithmetic command, a `for ((` header or a pair of nested subshells (a word `((` is a syntax error), whatever precedes it:
      // a keyword (also written together with it: `if((`), `time`, `!`, `{`, `coproc`, a function header
      const lastW = w !== null ? w : /** @type {Word | undefined} */ (cur.words[cur.words.length - 1]);
      const forHdr = lastW !== undefined && !lastW.q && lastW.v === 'for';
      // bash joins a backslash-newline before it reads the operators: `(\<newline>(` is a `((` too; k is the offset of the second parenthesis
      let k = i + 1;
      while (c === '(' && s[k] === '\\' && s[k + 1] === '\n') k += 2;
      if (c === '(' && s[k] === '(') {
        // `(( ... ))` is arithmetic (its `<<` and `>` are operators, not redirects); `((cmd); cmd)` is two subshells and ends in `)` alone
        const keep = G.unsure;
        G.unsure = '';
        const e = endParen(s, k, 0, true);
        const probeDoubt = G.unsure;
        G.unsure = keep; // the probe only decides arithmetic or subshells; the text is read for real below when it is not arithmetic
        const body = s.slice(k + 1, e - 2).replace(/\\\n/g, '');
        const closed = e - 2 > k && s[e - 1] === ')' && s[e - 2] === ')';
        // the `))` is placed with certainty only when the probe has no doubt (a `<<` operator is no doubt while no newline lies in the body: a here-document body is then not skipped) and the text is closed by `))`;
        // anything else (a `#` or here-document marker that may hide the end, unbalanced parentheses, quotes, case patterns) is refused for the roles: the end of the `((` cannot be told
        // a `))` glued to a word, quote or backslash (`export x=((1))\<newline>mkdir F`) is not placed either: bash reports the syntax error at the `(` and runs the next physical line, which the hook would read as arguments
        const glued = /[\w\\'"$`]/.test(s[e] ?? '');
        // `x=((` is always a syntax error in bash (no valid use): the rest of the physical line is discarded and the next one runs, with or without a continuation, so it is not placed either
        const afterEq = w !== null && w.v.endsWith('=');
        const placed = closed && !glued && !afterEq && (probeDoubt === '' || (probeDoubt.startsWith('a << inside') && !body.includes('\n')));
        if (!placed) doubt('a "((" whose end cannot be placed: write a space after the first "(" for a nested subshell, or simplify the arithmetic');
        else {
          arithSubs(body);
          if (forHdr ? forHeaderOk(body) : isArithmetic(body)) {
            flush(); i = e;
            // the words after a `for ((...))` header (`do`, `{`) are commands: the header is a command of its own, so the body is judged like any other body
            if (forHdr) { end(false); segStart = i; cur.at = offNow(); }
            continue;
          }
          // not arithmetic: two subshells, read as commands below; a `#` or `<` in them is read by bash as arithmetic first, so the end is not certain
          if (/[#<]/.test(body)) doubt('a "((" whose end cannot be placed: write a space after the first "(" for a nested subshell, or simplify the arithmetic');
          strictUntil = e; // a command word that is not literal is refused even without an operand
        }
      }
      // an array assignment `NAME=( ... )`: bash reads the body as words only; any operator in it is a syntax error, after which bash discards the rest of the physical line and runs the next one
      // (the hook would read that next line as an element). The body is valid only when it is words, quoted strings, expansions, globs and `[sub]=word` elements, separated by blanks, newlines and continuations
      if (c === '(' && s[i + 1] !== '(' && w !== null && w.v.endsWith('=')) {
        const declared = cur.words.length > 0 && DECL_BUILTINS.has(base(cur.words[0].v)) && !cur.words[0].q && cur.words.every((x, k) => k === 0 || x.v.startsWith('-') || isAssign(x));
        const target = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(w.v) && isAssign(w) && (lead || declared);
        const e = target ? arrayEnd(s, i + 1) : -1;
        if (e < 0) doubt('an array assignment whose end cannot be placed: write the elements as plain words, without ";", "&", "|", "<", ">", "#", a second "(" or a here-document');
        else arrUntil = e;
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
      const x = cw(); markQ(x); x.v += s[i + 1] ?? ''; i += 2; continue;
    }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e < 0) doubt('an unterminated quote'); const x = cw(); markQ(x); x.v += s.slice(i + 1, e < 0 ? n : e); i = e < 0 ? n : e + 1; continue; }
    if (c === '"') {
      const e = endDouble(s, i + 1);
      const body = s.slice(i + 1, Math.max(i + 1, s[e - 1] === '"' && e > i + 1 ? e - 1 : e));
      const x = cw(); markQ(x);
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
        // `$((...))` is arithmetic: only the substitutions inside it are commands; when the text cannot be an arithmetic expression (`$((echo a); (mkdir X))`) bash reads subshells, so it is read as commands as well
        substParen(inner);
        const x = cw(); x.sub = true; x.usub = true; x.v += s.slice(i, e); i = e; continue;
      }
      if (nx === '[') { // `$[ ... ]`, the old arithmetic: its `<<` and `>` are operators; only the substitutions inside are commands
        let e = i + 2; let d = 1;
        while (e < n && d > 0) { if (!step()) break; const ch = s[e]; if (ch === '\\') e++; else if (ch === '[') d++; else if (ch === ']') d--; e++; }
        if (d > 0) doubt('an unterminated $[...]');
        arithSubs(s.slice(i + 2, Math.max(i + 2, e - 1))); const x = cw(); x.vr = true; x.v += s.slice(i, e); i = e; continue;
      }
      if (nx === '{') { const e = endBrace(s, i + 2); const x = cw(); x.vr = true; x.v += s.slice(i, e); subsIn(s.slice(i + 2, e)); i = e; continue; }
      if (nx === "'") { const a = ansiC(s, i); const x = cw(); markQ(x); if (!a.plain) x.vr = true; x.v += a.text; i = a.end; continue; }
      const x = cw(); if (nx !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(nx)) x.vr = true; x.v += '$'; i++; continue;
    }
    if (c === '*' || c === '?' || c === '[') cw().glob = true;
    add(c); i++;
  }
  flush(); end(false);
  return out;
}

/**
 * Wrappers in front of a command word. flags: short letters without an argument; short: short letters whose option takes an argument (glued or the next word); long: long options that take one (`--opt=V` or the next
 * word); lflag: long options without one; pos: positional operands before the command; cd: the options that change the working directory. An option that is in none of these lists is unknown: the roles are refused.
 * @type {Record<string, { flags: string, short: string, long: string[], lflag: string[], pos: number, cd: RegExp | null }>}
 */
const WRAPPERS = {
  env: { flags: 'i0v', short: 'CuP', long: ['--chdir', '--unset'], lflag: ['--ignore-environment', '--null', '--debug', '--help', '--version'], pos: 0, cd: /^(-[A-Za-z]*C|--chdir)/ },
  sudo: { flags: 'AbEHnPSkKvBVl', short: 'DugphrtCUT', long: ['--chdir', '--user', '--group'], lflag: ['--preserve-env', '--non-interactive', '--reset-timestamp', '--stdin', '--background'], pos: 0, cd: /^(-[A-Za-z]*D|--chdir)/ },
  doas: { flags: 'nLs', short: 'uC', long: [], lflag: [], pos: 0, cd: null },
  nohup: { flags: '', short: '', long: [], lflag: ['--help', '--version'], pos: 0, cd: null },
  command: { flags: 'pvV', short: '', long: [], lflag: [], pos: 0, cd: null },
  builtin: { flags: '', short: '', long: [], lflag: [], pos: 0, cd: null },
  exec: { flags: 'cl', short: 'a', long: [], lflag: [], pos: 0, cd: null },
  time: { flags: 'pvaV', short: 'fo', long: ['--format', '--output'], lflag: ['--portability', '--append', '--verbose', '--help', '--version'], pos: 0, cd: null },
  nice: { flags: '', short: 'n', long: ['--adjustment'], lflag: ['--help', '--version'], pos: 0, cd: null },
  timeout: { flags: 'v', short: 'ks', long: ['--kill-after', '--signal'], lflag: ['--foreground', '--preserve-status', '--verbose', '--help', '--version'], pos: 1, cd: null },
  stdbuf: { flags: '', short: 'ioe', long: ['--input', '--output', '--error'], lflag: ['--help', '--version'], pos: 0, cd: null },
  ionice: { flags: 't', short: 'cnpPu', long: ['--class', '--classdata', '--pid', '--pgid', '--uid'], lflag: ['--ignore'], pos: 0, cd: null },
  chrt: { flags: 'bfiordmaRvp', short: '', long: [], lflag: ['--batch', '--fifo', '--idle', '--other', '--rr', '--deadline', '--reset-on-fork', '--max', '--verbose'], pos: 1, cd: null },
  taskset: { flags: 'ap', short: 'c', long: ['--cpu-list'], lflag: ['--all-tasks', '--pid'], pos: 1, cd: null },
  setsid: { flags: 'cfw', short: '', long: [], lflag: ['--ctty', '--fork', '--wait'], pos: 0, cd: null },
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
    if (x.v === 'coproc') { i += words[i + 2]?.v === '{' ? 2 : 1; continue; } // `coproc NAME { cmd; }` and `coproc cmd`
    if (x.v === 'for' || x.v === 'select' || x.v === 'case') return [];
    break;
  }
  return words.slice(i);
}

/**
 * Strip the reserved words and the wrappers in front of a command word. `env -C DIR`, `env --chdir=DIR` and `sudo -D DIR` change the working directory of the command they start. `unknown` names an option of a wrapper
 * that the table does not list: the caller refuses (fail closed).
 * @param {Word[]} words @returns {{ words: Word[], chdir: boolean, unknown: string }}
 */
function unwrap(words) {
  let chdir = false;
  let unknown = '';
  // reserved words, then the assignments that may follow them (`time X=1 mkdir d`, `function f { X=1 mkdir d; }`: the tokenizer reads those as words)
  const strip = (/** @type {Word[]} */ list) => {
    let l = skipReserved(list);
    while (l.length > 0 && isAssign(/** @type {Word} */ (l[0]))) {
      if ((/** @type {Word} */ (l[0])).v.startsWith('CDPATH=')) chdir = true;
      l = skipReserved(l.slice(1));
    }
    return l;
  };
  let ws = strip(words);
  let guard = 0;
  for (; ws.length > 0 && guard < MAX_WRAPPERS; guard++) {
    const name = base((/** @type {Word} */ (ws[0])).v);
    const spec = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (spec === undefined) break;
    let i = 1;
    let pos = spec.pos;
    while (i < ws.length) {
      if (!step()) break;
      const v = (/** @type {Word} */ (ws[i])).v;
      if (v === '--') { i++; if (name === 'env') while (i < ws.length && (/** @type {Word} */ (ws[i])).v.includes('=')) i++; while (pos > 0 && i < ws.length) { i++; pos--; } break; } // `--` ends the options; the positional operands (timeout's DURATION) still come before the command
      if (name === 'env' && v.includes('=') && !v.startsWith('-')) { if (v.startsWith('CDPATH=')) chdir = true; i++; continue; }
      if (!v.startsWith('-') || v === '-') { if (pos > 0) { pos--; i++; continue; } break; }
      if (spec.cd !== null && spec.cd.test(v)) chdir = true;
      let takes = false;
      if (v.startsWith('--')) {
        const nm = v.split('=')[0] ?? v;
        if (spec.long.includes(nm)) { takes = !v.includes('='); if (name === 'taskset' && nm === '--cpu-list') pos = 0; }
        else if (!spec.lflag.includes(nm)) unknown = unknown || `${name} ${nm}`;
      } else if (name === 'nice' && /^-[0-9]+$/.test(v)) takes = false;
      else {
        for (let k = 1; k < v.length; k++) {
          const ch = /** @type {string} */ (v[k]);
          if (spec.short.includes(ch)) { takes = k === v.length - 1; if (name === 'taskset' && ch === 'c') pos = 0; break; }
          if (!spec.flags.includes(ch)) { unknown = unknown || `${name} -${ch}`; break; }
        }
      }
      i += takes ? 2 : 1;
    }
    ws = strip(ws.slice(i));
  }
  if (guard >= MAX_WRAPPERS && ws.length > 0 && Object.hasOwn(WRAPPERS, base((/** @type {Word} */ (ws[0])).v))) unknown = unknown || `more than ${MAX_WRAPPERS} wrappers in a row`;
  return { words: ws, chdir, unknown };
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
        // the old style `tar cfC out.tar dir`: the letters that take an argument read the following words in order; the words after them are options again (`tar xf a -C /etc`)
        const rest = args.slice(1);
        opts = [...first.v].map((ch) => ({ f: `-${ch}`, arg: 'fCbILNTXKVFgH'.includes(ch) ? rest.shift() ?? null : null }));
        opts.push(...parseOpts(rest, 'fCbILNTXKVFgH', '', TAR_LONG_ARG).opts);
      } else opts = parseOpts(args, 'fCbILNTXKVFgH', '', TAR_LONG_ARG).opts;
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


const STDIN_FILE = /^(-|\/dev\/stdin|\/dev\/fd\/0)$/;
/** The commands whose printed text a process substitution can carry into a shell (`bash <(echo 'mkdir X')`). */
const CARRIERS = new Set(['echo', 'printf', 'cat', 'true', ':']);

/**
 * The text a command that is fed to a shell without a script reads as code: its here-documents, its here-strings, the words and here-documents of the commands on the left of its pipe (a pipeline stops at the
 * first shell: what a shell prints is not code the hook can read).
 * @param {Simple} sc @returns {string[]}
 */
function fedCodes(sc) {
  /** @type {string[]} */ const codes = [...sc.here];
  for (const r of sc.redirs) if (r.op === '<<<') codes.push(r.word.v);
  for (let p = sc.pipeFrom; p !== null; p = p.pipeFrom) {
    if (!step()) break;
    G.budget = Math.max(0, G.budget - p.words.length - p.here.length);
    const ws = p.words.map((x) => x.v);
    codes.push(...ws, ws.slice(1).join(' '), ...p.here);
    for (const r of p.redirs) if (r.op === '<<<') codes.push(r.word.v);
    if (SHELLS.has(base(ws[0] ?? ''))) break;
  }
  return codes;
}

/**
 * The code a file operand of a shell or of `source` stands for: stdin (`-`, `/dev/stdin`) is the fed text; a process substitution is the text its echo, printf or cat prints (any other command in it cannot be read: a doubt);
 * a script file is not readable here (null).
 * @param {Word} operand @param {Simple} sc @returns {string[] | null}
 */
function operandCodes(operand, sc) {
  if (STDIN_FILE.test(operand.v)) return fedCodes(sc);
  if (operand.usub && operand.v.startsWith('<(')) {
    const inner = operand.v.slice(2, operand.v.endsWith(')') ? -1 : undefined);
    /** @type {string[]} */ const codes = [];
    for (const x of tokenize(inner, sc.depth + 1, G, sc.at)) {
      const nm = base(x.words[0]?.v ?? '');
      if (x.words.length > 0 && !CARRIERS.has(nm)) doubt(`a process substitution that runs ${nm}, whose output is read as shell code`);
      const ws = x.words.map((w) => w.v);
      codes.push(...ws, ws.slice(1).join(' '), ...x.here);
    }
    return codes;
  }
  return null;
}

/**
 * The text a shell command reads as code: the `-c` string, the text it is fed when it has no script operand (or `-s`, or `-`/`/dev/stdin`), a process substitution operand, the arguments of `eval`.
 * @param {string} name @param {Word[]} args @param {Simple} sc @returns {string[]}
 */
function shellCode(name, args, sc) {
  if (name === 'eval') return [args.map((a) => a.v).join(' ')];
  let c = false;
  let stdin = false;
  let i = 0;
  for (; i < args.length; i++) {
    const v = (/** @type {Word} */ (args[i])).v;
    if (v === '--') { i++; break; }
    if (/^[-+][A-Za-z]+$/.test(v)) {
      if (v.startsWith('-') && v.includes('c')) c = true;
      if (v.startsWith('-') && v.includes('s')) stdin = true;
      if (/[oO]$/.test(v)) i++;
      continue;
    }
    if (v === '--rcfile' || v === '--init-file') { i++; continue; }
    if (v.startsWith('--')) continue;
    break;
  }
  if (c) return i < args.length ? [(/** @type {Word} */ (args[i])).v] : [];
  if (i >= args.length || stdin) return fedCodes(sc);
  return operandCodes(/** @type {Word} */ (args[i]), sc) ?? []; // otherwise a script file
}

/**
 * The code the string of a `trap` is: `trap 'code' EXIT`, `trap -- 'code' ERR`.
 * @param {Word[]} args @returns {string[]}
 */
function trapCode(args) {
  let i = 0;
  while (i < args.length && (/** @type {Word} */ (args[i])).v.startsWith('-') && (/** @type {Word} */ (args[i])).v !== '--') i++;
  if (args[i]?.v === '--') i++;
  return i < args.length - 1 ? [(/** @type {Word} */ (args[i])).v] : [];
}

/**
 * The write rules of the implementer and the designer over the command text. `badAt` is the offset (and `badParen` the number of subshell parentheses open there) of the first command that follows a `cd` the scanner cannot place (-1: none; 0: a wrapper or CDPATH changes the directory):
 * every relative write from there on is unresolvable. It is the one source of that rule: bash.mjs applies it to the scanner's records of the text from `badAt` on, and `bad` to the actions returned here.
 * Principle: where the hook is not certain how bash reads a region, the roles are refused (a deny action), never allowed.
 * @param {string} cmd @returns {{ chdir: boolean, badAt: number, badParen: number, actions: Action[], texts: string[] }}
 */
export function roleActions(cmd) {
  /** @type {Action[]} */ const actions = [];
  const st = newGuard(cmd.length);
  const prev = G;
  G = st;
  try { return scanRole(cmd, st, actions); } finally { G = prev; }
}

/** A word as one single-quoted word for the scanner of the lead; a `$'...'` string with an escape the hook cannot decode stays unresolvable (`"$ANSIC"`). @param {Word} w */
function quoteForScan(w) {
  if (w.vr && !w.v.includes('$')) return '"$ANSIC"';
  return `'${w.v.replace(/'/g, "'\\''")}'`;
}

/** The error text of a refusal. @param {string} why */
const notice = (why) => `${why}, so what the command writes cannot be judged`;

/** @param {string} cmd @param {Guard} st @param {Action[]} actions @returns {{ chdir: boolean, badAt: number, badParen: number, actions: Action[], texts: string[] }} */
function scanRole(cmd, st, actions) {
  /** @type {string[]} */ let texts = [];
  let chdir = false;
  let cwd = '';
  let bad = false;
  let badAt = -1;
  let badParen = 0;
  let scans = 0;
  const target = (/** @type {Word} */ word) => actions.push({ kind: 'target', word, cwd, bad });
  /** @param {string} code @param {Simple} sc */
  const runCode = (code, sc) => {
    if (sc.depth + 1 > MAX_DEPTH) { st.overflow = true; return; }
    const saved = cwd;
    if (code.trim() !== '') st.texts.push(code);
    for (const inner of tokenize(code, sc.depth + 1, st, sc.at)) judge(inner);
    cwd = saved;
  };
  /** @param {Simple} sc */
  const judge = (sc) => {
    if (!step()) return;
    if (sc.assigns.some((a) => a.v.startsWith('CDPATH='))) chdir = true;
    for (const r of sc.redirs) {
      if (r.op === '>&') { if (!/^([0-9]+-?|-)$/.test(r.word.v) || r.word.q) target(r.word); }
      else if (r.word.bt && !r.op.startsWith('<')) target(r.word);
      // a redirect inside a substitution or a shell string: the scanner of the lead may not read it (the same writeRule judges it)
      else if (sc.depth > 0 && OUT_OPS.has(r.op)) target(r.word);
      // a top-level redirect is judged from these tokens as well: the scanner of the lead can swallow a here-document (`<<` in `(( ))`, `$[ ]`, `${x:-<<E}`) and lose the lines after it
      else if (OUT_OPS.has(r.op)) actions.push({ kind: 'redir', word: r.word, cwd, bad });
      else if (r.op === '<>') target(r.word);
    }
    const un = unwrap(sc.words);
    if (un.chdir) chdir = true;
    if (un.unknown !== '') actions.push({ kind: 'deny', why: notice(`the command gives a wrapper an option the hook does not know (${un.unknown})`) });
    const first = un.words[0];
    if (first === undefined) return;
    const name = base(first.v);
    const args = un.words.slice(1);
    // a command word the hook cannot read (a substitution, a backtick, a variable, a brace expansion or a glob) may be any program: with an operand it is refused, wherever the tokenizer reads it
    const lit = !first.sub && !first.vr && !first.bt && (first.q || (!first.glob && !BRACE_RE.test(first.v)));
    if (!lit && !sc.arr && (args.length > 0 || sc.strict) && first.v !== '[' && first.v !== '[[') {
      actions.push({ kind: 'deny', why: notice(`the command word '${first.v}' is not a literal (a substitution, a variable, a brace expansion or a glob)`) });
    }
    if (name === 'export' && args.some((a) => a.v.startsWith('CDPATH'))) chdir = true;
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const operand = args.find((a) => a.v !== '--');
      if (name !== 'cd' || operand === undefined || operand.v === '' || operand.sub || operand.vr || operand.glob || /^[-~]/.test(operand.v) || /[{}]/.test(operand.v)) { if (!bad) { badAt = sc.at.off; badParen = sc.at.paren; } bad = true; }
      else cwd = /^([/]|[A-Za-z]:)/.test(operand.v) || cwd === '' ? operand.v : `${cwd}/${operand.v}`;
      return;
    }
    if (name === 'trap') { for (const code of trapCode(args)) runCode(code, sc); return; }
    if (name === 'source' || name === '.') {
      const operand = args.find((a) => a.v !== '--');
      if (operand !== undefined) for (const code of operandCodes(operand, sc) ?? []) runCode(code, sc);
      return;
    }
    if (SHELLS.has(name) || name === 'eval') {
      for (const code of shellCode(name, args, sc)) runCode(code, sc);
      return;
    }
    if (name === 'alias') {
      for (const a of args) {
        const eq = a.v.indexOf('=');
        if (eq < 0) continue;
        const body = a.v.slice(eq + 1);
        if (a.sub || a.vr || a.glob || body.includes('>') || body.split(/[^A-Za-z0-9_./-]+/).some((x) => ROLE_PROGRAMS.has(base(x)))) {
          actions.push({ kind: 'deny', why: notice(`the alias '${a.v.slice(0, 60)}' stands for a write program, a redirect or a word the hook cannot read`) });
        }
      }
      return;
    }
    if (name === 'shopt' && args.some((a) => /^-[A-Za-z]*s/.test(a.v)) && args.some((a) => a.v === 'expand_aliases')) {
      actions.push({ kind: 'deny', why: notice('the command turns on expand_aliases, so any word may stand for a write program') });
      return;
    }
    if (!ROLE_PROGRAMS.has(name)) return;
    if (WRITE_PROGRAMS.has(name)) {
      // the scanner of the lead knows this writer's operands; it judges the command rebuilt from these tokens
      // (the lead scanner can lose a command word behind `function f {`, `coproc` or a swallowed here-document)
      const text = [name, ...args.map(quoteForScan)].join(' ');
      G.budget = Math.max(0, G.budget - text.length);
      if (++scans > MAX_SCANS) st.overflow = true; else actions.push({ kind: 'scan', text, cwd, bad });
    }
    for (const a of args) {
      if (a.bt || a.usub) { actions.push({ kind: 'deny', why: `the command gives ${name} an operand '${a.v}' that holds a command substitution, which cannot be resolved` }); break; }
    }
    for (const t of extraTargets(name, args)) target(t);
  };
  for (const sc of tokenize(cmd, 0, st, { off: 0, paren: 0 })) { if (st.overflow) break; judge(sc); }
  if (chdir) { badAt = 0; badParen = 0; for (const a of actions) if (a.kind !== 'deny') a.bad = true; }
  if (st.overflow) actions.push({ kind: 'deny', why: `the command nests substitutions or shell strings deeper than ${MAX_DEPTH} levels or is too large to read, so what it writes cannot be judged` });
  if (st.unsure !== '') actions.push({ kind: 'deny', why: notice(`the command holds ${st.unsure}, which the hook cannot read the way bash does`) });
  if (st.texts.length > MAX_TEXTS) actions.push({ kind: 'deny', why: notice(`the command holds more than ${MAX_TEXTS} nested regions`) });
  else texts = st.texts;
  return { chdir, badAt, badParen, actions, texts };
}

/**
 * roleActions that fails closed: an internal error is a refusal, never an allow. `impl` is injectable for the test that forces the throw.
 * @param {string} cmd @param {(c: string) => ReturnType<typeof roleActions>} [impl]
 */
export function safeRoleActions(cmd, impl = roleActions) {
  try { return impl(cmd); } catch (e) {
    return { chdir: false, badAt: -1, badParen: 0, texts: [], actions: /** @type {Action[]} */ ([{ kind: 'deny', why: `the role scan failed (${e instanceof Error ? e.message : String(e)}), so what the command writes cannot be judged` }]) };
  }
}
