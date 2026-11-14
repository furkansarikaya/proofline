// @ts-check
// Text helpers of the Node hook: the exact byte behaviour of the shell hook's small functions (jesc, safe, sha, command substitution, jget).
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * A native path in the forward-slash spelling every guard compares in (`C:\\Users\\x` is `C:/Users/x`). Only where the separator is a backslash: on
 * every other platform a backslash is a file name character and the path is returned as it is.
 * @param {string} p @param {string} [sep]
 */
export function posix(p, sep = path.sep) { return sep === '\\' ? p.replaceAll('\\', '/') : p; }

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

/** The platform seam of the path guards: a test replaces `platform` to run the Windows rules on any host (no path decision reads `process.platform` itself). */
export const host = {
  platform: () => /** @type {string} */ (process.platform),
  /** the drive of the working directory (`C:`), '' when it has none (a UNC working directory): what `\\x` (the root of the current drive) means */
  drive: () => /^[A-Za-z]:/.exec(process.cwd())?.[0] ?? '',
};
/** true on a Windows host (or under a test that says so). */
export function isWin() { return host.platform() === 'win32'; }

const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * A path as the guards read it on a Windows host, in one forward-slash spelling (A271). Elsewhere the text comes back untouched. Backslashes are
 * separators; `\\?\C:\x` loses its prefix; `/c/x` and `/cygdrive/c/x` (Git Bash) are `C:/x`; the drive letter is upper case; `.` and `..` are
 * resolved as Windows does (a `..` above a root stays at the root); the trailing dots and spaces of a name are dropped (`.agents/githooks.` is
 * `.agents/githooks`); a UNC path is `//server/share/x`. `bad` marks what no guard can place: a drive-relative `C:x`, the `\\.\` and `\\?\` device
 * namespaces, a name of only dots and spaces, a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension) and a UNC
 * path without a share. `nul` is the bare name NUL, the Windows /dev/null. A guard denies a `bad` path where it would deny an outside one.
 * @param {string} raw @param {string} [platform]
 * @returns {{ p: string, bad: boolean, nul: boolean }}
 */
export function winSpell(raw, platform = host.platform()) {
  if (platform !== 'win32') return { p: raw, bad: false, nul: false };
  let s = raw.replace(/\\/g, '/');
  const lp = /^\/\/[?.]\/([A-Za-z]:(?:\/.*)?)$/s.exec(s);
  if (lp) s = /** @type {string} */ (lp[1]);
  else if (/^\/\/[?.](\/|$)/.test(s)) return { p: s, bad: true, nul: false };
  const ms = raw.startsWith('/') ? /^(?:\/cygdrive)?\/([A-Za-z])(?:\/(.*))?$/s.exec(s) : null; // Git Bash's /c/x (a backslash \c\x is the root of the current drive)
  if (ms) s = `${ms[1]}:/${ms[2] ?? ''}`;
  let head = ''; let rest = s; let abs = false; let bad = false;
  const dr = /^([A-Za-z]):(.*)$/s.exec(s);
  if (dr) {
    head = `${/** @type {string} */ (dr[1]).toUpperCase()}:`; rest = /** @type {string} */ (dr[2]); abs = true;
    if (!rest.startsWith('/')) { bad = true; rest = `/${rest}`; } // C:x and C: name the working directory of a drive: unresolvable
  } else if (s.startsWith('//')) {
    const um = /^\/\/([^/]+)\/([^/]+)(\/.*)?$/s.exec(s);
    if (um) { head = `//${um[1]}/${um[2]}`; rest = um[3] ?? ''; } else { bad = true; head = '/'; rest = s; }
    abs = true;
  } else if (s.startsWith('/')) {
    abs = true;
    // `\x` is the root of the current drive: say which drive, so that the result is never read again as Git Bash's `/x` (idempotent); no drive known and a
    // one-letter first name (`\w\repo`) is ambiguous: unplaceable
    if (raw.startsWith('\\')) { const dv = host.drive(); if (dv !== '') { head = dv.toUpperCase(); rest = s; } else if (/^\/[A-Za-z](\/|$)/.test(s)) bad = true; }
  }
  /** @type {string[]} */ const out = []; let dev = false; let nul = false; let first = true;
  for (let c of rest.split('/')) {
    if (c === '' || c === '.') continue;
    if (c === '..') { if (out.length > 0 && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); continue; }
    const sc = c.indexOf(':'); if (sc >= 0) { c = c.slice(0, sc); if (first && head === '' && abs && /^[A-Za-z]$/.test(c)) bad = true; } // (a one-letter first name left by a stream would be read as a drive by a second pass)
    first = false; // an NTFS stream (`x::$DATA`, `x:s`, `d:$INDEX_ALLOCATION`) names its file or folder
    let e = c.length; while (e > 0 && (c[e - 1] === '.' || c[e - 1] === ' ')) e--; // loops, not `[. ]+$`: that is quadratic on a long run of spaces
    const t = c.slice(0, e);
    if (t === '') { bad = true; continue; }
    if (DEVICE.test(/** @type {string} */ (t.split('.')[0]).trimEnd())) { dev = true; if (/^nul$/i.test(t)) nul = true; }
    out.push(t);
  }
  const body = out.join('/');
  /** @type {string} */ let p;
  if (head.endsWith(':')) p = `${head}/${body}`;
  else if (head.startsWith('//')) p = body === '' ? head : `${head}/${body}`;
  else if (abs) p = `/${body}`;
  else p = body === '' ? '.' : body;
  return { p, bad: bad || dev, nul: nul && !abs && out.length === 1 };
}

/** The text with backslashes turned into slashes and `/c/x` into `C:/x`, nothing else (a token that is only matched, never resolved). Elsewhere untouched. @param {string} p */
export function winSoft(p) {
  if (!isWin()) return p;
  const s = p.replace(/\\/g, '/');
  const ms = p.startsWith('/') ? /^(?:\/cygdrive)?\/([A-Za-z])(?:\/(.*))?$/s.exec(s) : null;
  return ms ? `${/** @type {string} */ (ms[1]).toUpperCase()}:/${ms[2] ?? ''}` : s;
}

/** An absolute path in the guards' spelling: `/x`, and on a Windows host `C:/x`, `C:\x` and `\x` too (elsewhere `C:/x` is a name under the working directory). @param {string} p */
export function isAbsPath(p) { return p.startsWith('/') || (isWin() && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\'))); }

/** The key two paths are compared by: on a Windows host the normalised spelling with ASCII letters folded (NTFS names are case-insensitive), elsewhere the text itself. @param {string} p */
export function pathKey(p) { return isWin() ? winSpell(p).p.replace(/[A-Z]/g, (c) => c.toLowerCase()) : p; }
