// @ts-check
// Text helpers of the Node hook: the exact byte behaviour of the shell hook's small functions (jesc, safe, sha, command substitution, jget).
import { createHash } from 'node:crypto';

/**
 * `jesc TEXT`: the JSON string body the shell hook builds: only the backslash, the quote, tab, carriage return and newline are escaped (other
 * control bytes stay raw, exactly as before: the capture file is read by the shell `approve`). Text without any of the five is returned as it is.
 * The shell form goes through awk, which reads records: ONE final newline of the text is not a record of its own and is dropped.
 * @param {string} s
 */
export function jesc(s) {
  if (!/[\\"\t\r\n]/.test(s)) return s;
  const parts = s.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => l.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\t/g, '\\t').replace(/\r/g, '\\r')).join('\\n');
}

/** The escaping of the capture file: every character of the text, trailing newlines included (the shell form appends and strips an x). @param {string} s */
export function jescExact(s) { return jesc(`${s}x`).slice(0, -1); }

/** `safe NAME`: every byte outside A-Za-z0-9_.- becomes an underscore (tr works on bytes, so a multi-byte character gives several). @param {string} s */
export function safe(s) {
  if (!/[^A-Za-z0-9_.-]/.test(s)) return s;
  return Buffer.from(s, 'utf8').reduce((acc, b) => acc + (/[A-Za-z0-9_.-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '_'), '');
}

/** The SHA-256 of the UTF-8 bytes of a text, hex. @param {string | Buffer} data */
export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

/** `$( ... )`: no trailing newlines, no NUL bytes (a shell variable cannot hold one). @param {string} s */
export function cmdSubst(s) { return s.replace(/\0/g, '').replace(/\n+$/, ''); }

/** `canon`: the legacy role names. @param {string} r */
export function canon(r) {
  switch (r) {
    case 'full_lifecycle': return 'lead';
    case 'implementation_worker': return 'implementer';
    case 'independent_reviewer': return 'reviewer';
    case 'independent_qa': return 'qa';
    case 'independent_verifier': return 'verifier';
    default: return r;
  }
}

/** @param {string} r */
export function validRole(r) {
  return ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'].includes(r);
}

/**
 * `jget PATH...`: the first non-null value of the dotted PATHs; a string as it is, an array of strings joined by spaces, anything else as JSON.
 * jq's `first // ""` also turns a `false` into the empty string. The result has the shape of a command substitution (see cmdSubst).
 * @param {unknown} input @param {...string} paths @returns {string}
 */
export function jget(input, ...paths) { return cmdSubst(jgetRaw(input, ...paths)); }

/** `jget` without the command-substitution shape: trailing newlines stay (the caller appends and strips a sentinel, like `$(jget prompt; printf x)`). @param {unknown} input @param {...string} paths @returns {string} */
export function jgetRaw(input, ...paths) {
  for (const p of paths) {
    let v = input;
    for (const k of p.split('.')) v = v !== null && typeof v === 'object' ? /** @type {any} */ (v)[k] : undefined;
    if (v === undefined || v === null) continue;
    if (v === false) return '';
    if (typeof v === 'string') return v.replace(/\0/g, '');
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ').replace(/\0/g, '');
    return JSON.stringify(v);
  }
  return '';
}

/** `grep -Fw -- WORD`: does the line contain WORD as a whole word (not touching a letter, digit or underscore)? @param {string} line @param {string} word */
export function hasWord(line, word) {
  if (word === '') return false;
  const isW = (/** @type {string | undefined} */ c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  for (let i = line.indexOf(word); i >= 0; i = line.indexOf(word, i + 1)) {
    const before = i === 0 ? undefined : [...line.slice(Math.max(0, i - 2), i)].pop();
    const after = [...line.slice(i + word.length, i + word.length + 2)][0];
    if (!isW(before) && !isW(after)) return true;
  }
  return false;
}

/** `grep -Fqw -- WORD` over a text: does any line contain the word? @param {string} text @param {string} word */
export function textHasWord(text, word) { return text.split('\n').some((l) => hasWord(l, word)); }

/** `tr '\n' ' '` @param {string} s */
export function nlToSpace(s) { return s.replace(/\n/g, ' '); }
