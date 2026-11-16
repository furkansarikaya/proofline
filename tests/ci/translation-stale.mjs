// @ts-check
// The translation staleness check (user decisions A1/A2 of the Turkish guides): every file under docs/guides/tr/ carries, after its title, one machine-readable header line
//   <!-- translated-from: <English file>; blob: <git blob id of that English file>; commit: <short sha> -->
// and this check compares the recorded blob id with the blob id of the English file as it is now.
//   fresh      -> silent, exit 0.
//   stale      -> a GitHub Actions warning annotation (`::warning file=<translation>::...`) plus a plain line, exit 0. A stale translation WARNS and never fails: failing would force
//                 a translation into every pull request that touches a guide, and the English page is authoritative.
//   an error   -> exit 1: a missing or malformed header, a header naming an English file that does not exist (or leaves docs/), or an unreadable file.
// The blob id is the git object id of the file content (sha1 of "blob <size>\0<bytes>"), computed in process after CRLF is read as LF, so it equals `git hash-object` on a
// checkout with either line ending and needs no git, no shell and no network. The check only reads the files; nothing in them is ever executed or evaluated, and the header is
// matched by a regular expression anchored to a whole line.
//   node tests/ci/translation-stale.mjs [--root DIR]
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRANSLATION_DIR = 'docs/guides/tr';
/** One whole line; the English path is a relative path of safe characters under docs/ (no `..`, checked again below). */
export const HEADER_RE = /^<!-- translated-from: (docs\/[A-Za-z0-9._\/-]+\.md); blob: ([0-9a-f]{40}); commit: ([0-9a-f]{7,40}) -->$/;

/** The git blob id of a content: sha1("blob <bytes>\0" + bytes), with CRLF read as LF. @param {Buffer | string} content */
export function blobId(content) {
  const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const bytes = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * The header of a translation: exactly one line matching HEADER_RE.
 * @param {string} text
 * @returns {{ ok: true, english: string, blob: string, commit: string } | { ok: false, reason: string }}
 */
export function parseHeader(text) {
  const hits = text.split(/\r?\n/).map((l) => HEADER_RE.exec(l)).filter((m) => m !== null);
  if (hits.length === 0) return { ok: false, reason: 'no header line "<!-- translated-from: docs/...md; blob: <40 hex>; commit: <sha> -->" (the whole line, nothing else on it)' };
  if (hits.length > 1) return { ok: false, reason: 'more than one translated-from header line' };
  const [, english, blob, commit] = /** @type {RegExpExecArray} */ (hits[0]);
  if (english.split('/').includes('..')) return { ok: false, reason: `the English path "${english}" leaves docs/` };
  return { ok: true, english, blob, commit };
}

/** @param {string} s a message for a workflow command: no newline, no % */
const flat = (s) => s.replace(/%/g, '%25').replace(/\r?\n/g, ' ');

/**
 * @param {{ list: () => string[], read: (rel: string) => Buffer | null }} fs `list`: the translation files (repo-relative); `read`: a file's bytes or null when it does not exist
 * @returns {{ code: 0 | 1, lines: string[] }}
 */
export function check(fs) {
  /** @type {string[]} */ const lines = [];
  let code = /** @type {0 | 1} */ (0);
  for (const tr of fs.list()) {
    const text = fs.read(tr);
    if (text === null) { lines.push(`::error file=${tr}::translation file is not readable`, `ERROR ${tr}: not readable`); code = 1; continue; }
    const h = parseHeader(text.toString('utf8'));
    if ('reason' in h) { lines.push(`::error file=${tr}::${flat(h.reason)}`, `ERROR ${tr}: ${h.reason}`); code = 1; continue; }
    const en = fs.read(h.english);
    if (en === null) { lines.push(`::error file=${tr}::the header names ${h.english}, which does not exist`, `ERROR ${tr}: ${h.english} does not exist`); code = 1; continue; }
    const now = blobId(en);
    if (now !== h.blob) {
      const msg = `${h.english} changed since this translation was made (recorded blob ${h.blob.slice(0, 12)}, now ${now.slice(0, 12)}, translated at commit ${h.commit}); update the translation and its header, or leave it: a stale translation only warns`;
      lines.push(`::warning file=${tr}::${flat(msg)}`, `WARNING ${tr}: ${msg}`);
    }
  }
  return { code, lines };
}

/** @param {string} root */
export function rootFs(root) {
  return {
    list: () => { try { return readdirSync(path.join(root, TRANSLATION_DIR)).filter((f) => f.endsWith('.md')).sort().map((f) => `${TRANSLATION_DIR}/${f}`); } catch { return []; } },
    read: (/** @type {string} */ rel) => { try { return readFileSync(path.join(root, rel)); } catch { return null; } },
  };
}

function main() {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1] ?? '.') : path.resolve(import.meta.dirname, '../..');
  const r = check(rootFs(root));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
