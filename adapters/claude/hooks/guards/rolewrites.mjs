// @ts-check
// A273 (issue #264): the text-level write rules of the implementer and the designer. The scanner (command-scan.mjs) is built for the lead's shell
// hook: it splits a word at an unquoted `$(` or a backtick, drops a `>&` file target, and knows only the options it names. For the two roles that
// is not enough, so this module reads the command text once with its own small tokenizer (linear, one pass) and returns the write targets the
// scanner does not record, plus the refusals that follow from a word the hook cannot resolve. It is pure: no file system, no context. bash.mjs
// judges every returned target with the same writeRule as a redirect. The lead's verdicts never depend on this module.
//
// Limits (a text scanner cannot know a program's arguments; the same for the lead): programs not in WRITE_PROGRAMS and not named below, a
// non-literal command word, a function, `xargs`-fed writers, the text of an interpreter program.
import { WRITE_PROGRAMS } from '../command-scan.mjs';

/** @typedef {{ v: string, q: boolean, sub: boolean, usub: boolean, bt: boolean, vr: boolean, glob: boolean }} Word v: the text with quotes and backslashes removed (a substitution keeps its source text); q: some part was quoted; sub: holds `$(`, a backtick or a process substitution; usub: an unquoted `$(` or process substitution; bt: holds a backtick; vr: holds a parameter expansion; glob: an unquoted `*`, `?` or `[` */
/** @typedef {{ words: Word[], redirs: Array<{ op: string, word: Word }>, assigns: Word[] }} Simple */
/** @typedef {{ kind: 'deny', why: string } | { kind: 'target', word: Word, cwd: string, bad: boolean }} Action */

export const ROLE_PROGRAMS = new Set([...WRITE_PROGRAMS, 'mkdir', 'mkfifo', 'mknod']);

/** @param {string} v @returns {Word} */
const mkWord = (v) => ({ v, q: false, sub: false, usub: false, bt: false, vr: false, glob: false });

/** The index just after the `)` that closes a `$(` whose `(` is at i-1; quotes, backticks and nested parentheses are skipped. @param {string} s @param {number} i */
function endParen(s, i) {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"') { i = endDouble(s, i + 1); continue; }
    if (c === '`') { const e = s.indexOf('`', i + 1); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return s.length;
}

/** The index just after the closing `"` of a double-quoted part that starts at i (after the opening quote). @param {string} s @param {number} i */
function endDouble(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === '$' && s[i + 1] === '(') { i = endParen(s, i + 2); continue; }
    if (c === '`') { const e = s.indexOf('`', i + 1); i = e < 0 ? s.length : e + 1; continue; }
    i++;
  }
  return s.length;
}

/** Split a command text into simple commands. One pass; here-document bodies are skipped line by line. @param {string} s @returns {Simple[]} */
export function tokenize(s) {
  /** @type {Simple[]} */ const out = [];
  /** @type {Simple} */ let cur = { words: [], redirs: [], assigns: [] };
  /** @type {Word | null} */ let w = null;
  /** @type {string | null} */ let pend = null; // the redirect operator waiting for its word
  /** @type {string[]} */ const heres = [];
  const n = s.length;
  const end = () => { if (cur.words.length > 0 || cur.redirs.length > 0 || cur.assigns.length > 0) out.push(cur); cur = { words: [], redirs: [], assigns: [] }; };
  const flush = () => {
    if (w === null) return;
    const x = w; w = null;
    if (pend !== null) {
      if (pend === '<<' || pend === '<<-') heres.push(x.v);
      else cur.redirs.push({ op: pend, word: x });
      pend = null;
    } else if (cur.words.length === 0 && !x.q && /^[A-Za-z_][A-Za-z0-9_]*=/.test(x.v)) cur.assigns.push(x);
    else cur.words.push(x);
  };
  /** @param {string} t */
  const add = (t) => { if (w === null) w = mkWord(''); w.v += t; };
  /** @returns {Word} */
  const cw = () => { if (w === null) w = mkWord(''); return w; };
  let i = 0;
  while (i < n) {
    const c = /** @type {string} */ (s[i]);
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush(); end(); i++;
      while (heres.length > 0) {
        const d = /** @type {string} */ (heres.shift());
        while (i < n) {
          let e = s.indexOf('\n', i); if (e < 0) e = n;
          const line = s.slice(i, e);
          i = e + 1;
          if (line.replace(/^\t+/, '') === d) break;
        }
      }
      continue;
    }
    if (c === ';' || c === '|' || c === '(' || c === ')' || (c === '&' && s[i + 1] !== '>')) { flush(); end(); i++; continue; }
    if (c === '#' && w === null) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '&' || c === '>' || c === '<') {
      if ((c === '>' || c === '<') && s[i + 1] === '(') { const e = endParen(s, i + 2); const x = cw(); x.sub = true; x.usub = true; x.v += s.slice(i, e); i = e; continue; }
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
      const body = s.slice(i + 1, Math.max(i + 1, e - 1));
      const x = cw(); x.q = true;
      if (body.includes('`')) { x.sub = true; x.bt = true; }
      if (body.includes('$(')) x.sub = true;
      if (/\$[{A-Za-z_]/.test(body)) x.vr = true;
      x.v += body.replace(/\\([\\"$`])/g, '$1');
      i = e; continue;
    }
    if (c === '`') { const e = s.indexOf('`', i + 1); const x = cw(); x.sub = true; x.bt = true; x.usub = true; x.v += s.slice(i, e < 0 ? n : e + 1); i = e < 0 ? n : e + 1; continue; }
    if (c === '$') {
      const nx = s[i + 1];
      if (nx === '(') { const e = endParen(s, i + 2); const x = cw(); x.sub = true; x.usub = true; x.v += s.slice(i, e); i = e; continue; }
      if (nx === '{') { const e = s.indexOf('}', i + 2); const x = cw(); x.vr = true; x.v += s.slice(i, e < 0 ? n : e + 1); i = e < 0 ? n : e + 1; continue; }
      const x = cw(); if (nx !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(nx)) x.vr = true; x.v += '$'; i++; continue;
    }
    if (c === '*' || c === '?' || c === '[') cw().glob = true;
    add(c); i++;
  }
  flush(); end();
  return out;
}

const WRAPPERS = new Set(['env', 'sudo', 'nohup', 'command', 'builtin', 'exec', 'time', 'nice']);

/** @param {string} p */
const base = (p) => { const k = p.lastIndexOf('/'); return k < 0 ? p : p.slice(k + 1); };

/**
 * Strip the wrappers in front of a command word. `env -C DIR`, `env --chdir=DIR` and `sudo -D DIR` change the working directory of the command they start.
 * @param {Word[]} words @returns {{ words: Word[], chdir: boolean }}
 */
function unwrap(words) {
  let chdir = false;
  let ws = words;
  while (ws.length > 0 && WRAPPERS.has(base((/** @type {Word} */ (ws[0])).v))) {
    const name = base((/** @type {Word} */ (ws[0])).v);
    let i = 1;
    while (i < ws.length) {
      const v = (/** @type {Word} */ (ws[i])).v;
      if (v === '--') { i++; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { if (v.startsWith('CDPATH=')) chdir = true; i++; continue; }
      if (!v.startsWith('-')) break;
      if (/^--chdir(=|$)/.test(v) || (name === 'env' && /^-[A-Za-z]*C/.test(v)) || (name === 'sudo' && /^-[A-Za-z]*D/.test(v))) chdir = true;
      const takes = (name === 'env' && /^-[A-Za-z]*[Cu]$/.test(v)) || (name === 'env' && (v === '--chdir' || v === '--unset')) || (name === 'sudo' && (/^-[A-Za-z]*[DugphrtCUT]$/.test(v) || v === '--chdir' || v === '--user' || v === '--group')) || (name === 'nice' && v === '-n');
      i += takes ? 2 : 1;
    }
    ws = ws.slice(i);
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
    case 'mkdir': case 'mkfifo': { const p = parseOpts(args, 'mZ', '', ['--mode', '--context']); return p.operands; }
    case 'mknod': { const p = parseOpts(args, 'mZ', '', ['--mode', '--context']); return p.operands.slice(0, 1); }
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
      const inplace = p.opts.some((o) => (o.f === '-i' || o.f === '--include') && o.arg !== null && o.arg.v.startsWith('inplace'));
      if (!inplace) return [];
      const prog = has(p.opts, ['-f', '-e', '--file', '--source']);
      return p.operands.filter((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x.v)).slice(prog ? 0 : 1);
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
 * The write rules of the implementer and the designer over the command text.
 * @param {string} cmd @returns {{ chdir: boolean, actions: Action[] }}
 */
export function roleActions(cmd) {
  /** @type {Action[]} */ const actions = [];
  let chdir = false;
  let cwd = '';
  let bad = false;
  const target = (/** @type {Word} */ word) => actions.push({ kind: 'target', word, cwd, bad });
  for (const sc of tokenize(cmd)) {
    if (sc.assigns.some((a) => a.v.startsWith('CDPATH='))) chdir = true;
    for (const r of sc.redirs) {
      if (r.op === '>&') { if (!/^([0-9]+-?|-)$/.test(r.word.v) || r.word.q) target(r.word); }
      else if (r.word.bt && !r.op.startsWith('<')) target(r.word);
    }
    const un = unwrap(sc.words);
    if (un.chdir) chdir = true;
    const first = un.words[0];
    if (first === undefined) continue;
    const name = base(first.v);
    const args = un.words.slice(1);
    if (name === 'export' && args.some((a) => a.v.startsWith('CDPATH'))) chdir = true;
    if (name === 'cd' || name === 'pushd' || name === 'popd') {
      const operand = args.find((a) => a.v !== '--');
      if (name !== 'cd' || operand === undefined || operand.v === '' || operand.sub || operand.vr || operand.glob || /^[-~]/.test(operand.v) || /[{}]/.test(operand.v)) bad = true;
      else cwd = /^([/]|[A-Za-z]:)/.test(operand.v) || cwd === '' ? operand.v : `${cwd}/${operand.v}`;
      continue;
    }
    if (!ROLE_PROGRAMS.has(name)) continue;
    for (const a of args) {
      if (a.bt || a.usub) { actions.push({ kind: 'deny', why: `the command gives ${name} an operand '${a.v}' that holds a command substitution, which cannot be resolved` }); break; }
    }
    for (const t of extraTargets(name, args)) target(t);
  }
  return { chdir, actions };
}
