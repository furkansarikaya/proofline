// @ts-check
// U8 (issue 338 R1-18, R2-19, R3-14, R4-12): the reader of the run archives for `proofline retro` (A370). A `.tar.gz` of a run folder (`cleanup` writes it with `tar -czf`) is read IN PROCESS: zlib inflates it
// into one bounded buffer and a minimal ustar parser walks the headers. Nothing is written, no program is started, and no entry is ever extracted: a name is only compared with the names the caller wants.
//   - limits (each one a named reason, never a guess): the file over `archiveBytes` is not read; an archive that inflates past `inflatedBytes` stops (a zip bomb); more than `entries` headers stop; an entry over
//     `entryBytes` is listed and skipped;
//   - an entry that is not a plain file (a symbolic or hard link, a device, a fifo) and a plain file whose name is absolute, has a `..` segment, a backslash or a NUL is counted in `refused` and never used;
//   - supported headers: ustar (with the prefix field), pax `x` (the `path` record) and `g` (skipped), GNU `L` (long name); a base-256 size, a bad header checksum and a short archive are `bad-header` and `truncated`.
// The archive file itself must be a plain file (lstat: a symbolic link, a folder or a fifo is `not-a-file`; a fifo is never opened).
import { lstatSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export const TAR_LIMITS = Object.freeze({ archiveBytes: 32 * 1024 * 1024, inflatedBytes: 64 * 1024 * 1024, entries: 5000, entryBytes: 8 * 1024 * 1024 });

/**
 * @typedef {object} TarResult
 * @property {boolean} ok the whole archive was read to its end within the limits
 * @property {string} why when not ok: `unreadable`, `not-a-file`, `archive-too-large`, `not-gzip`, `too-large`, `truncated`, `bad-header`, `too-many-entries`
 * @property {Map<string, string>} files the wanted entries, key = the name `want` returned, value = the bytes as a latin1 string
 * @property {number} refused entries that were not a plain file or had an unsafe name, never used
 * @property {string[]} tooLarge wanted entries over `entryBytes`, skipped
 * @property {number} entries headers walked
 */

/** @param {Buffer} h @param {number} from @param {number} len */
function field(h, from, len) {
  const end = h.indexOf(0, from);
  return h.toString('latin1', from, end >= from && end < from + len ? end : from + len);
}

/** @param {string} name */
function unsafe(name) {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return true;
  return name.split('/').some((s) => s === '..');
}

/** The `path` of a pax extended header body (`<len> key=value\n` records). @param {Buffer} body */
function paxPath(body) {
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number(body.toString('latin1', i, sp));
    if (!(len > 0) || i + len > body.length) break;
    const rec = body.toString('latin1', sp + 1, i + len - 1);
    if (rec.startsWith('path=')) return rec.slice(5);
    i += len;
  }
  return null;
}

/**
 * @param {string} file the archive @param {(name: string) => string | null} want the key of a name the caller reads, or null to skip it
 * @param {Partial<typeof TAR_LIMITS>} [limits]
 * @returns {TarResult}
 */
export function readTarGz(file, want, limits = {}) {
  const lim = { ...TAR_LIMITS, ...limits };
  /** @type {TarResult} */ const res = { ok: false, why: '', files: new Map(), refused: 0, tooLarge: [], entries: 0 };
  /** @param {string} why */ const stop = (why) => { res.ok = false; res.why = why; return res; };
  let raw;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return stop('not-a-file');
    if (st.size > lim.archiveBytes) return stop('archive-too-large');
    raw = readFileSync(file);
    if (raw.length > lim.archiveBytes) return stop('archive-too-large');
  } catch { return stop('unreadable'); }
  let tar;
  try { tar = gunzipSync(raw, { maxOutputLength: lim.inflatedBytes }); } catch (e) {
    const code = /** @type {{ code?: string }} */ (e).code ?? '';
    if (code === 'ERR_BUFFER_TOO_LARGE') return stop('too-large');
    return stop(/unexpected end/.test(String(/** @type {Error} */ (e).message)) ? 'truncated' : 'not-gzip');
  }
  let off = 0;
  /** @type {string | null} */ let nextName = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (++res.entries > lim.entries) return stop('too-many-entries');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    const stored = parseInt(field(h, 148, 8).trim(), 8);
    if (!(stored === sum)) return stop('bad-header');
    if ((h[124] & 0x80) !== 0) return stop('bad-header');
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    if (!(size >= 0)) return stop('bad-header');
    const type = String.fromCharCode(h[156] === 0 ? 0x30 : h[156]);
    let name = field(h, 0, 100);
    if (h.toString('latin1', 257, 262) === 'ustar') { const prefix = field(h, 345, 155); if (prefix !== '') name = `${prefix}/${name}`; }
    const start = off + 512;
    const end = start + size;
    if (end > tar.length) return stop('truncated');
    off = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { nextName = paxPath(tar.subarray(start, end)) ?? nextName; continue; }
    if (type === 'g' || type === 'K') continue;
    if (type === 'L') { const body = tar.subarray(start, end); const z = body.indexOf(0); nextName = body.toString('latin1', 0, z < 0 ? body.length : z); continue; }
    if (nextName !== null) { name = nextName; nextName = null; }
    if (type === '5') continue;
    if (type !== '0' && type !== '7') { res.refused++; continue; }
    if (unsafe(name)) { res.refused++; continue; }
    const key = want(name);
    if (key === null) continue;
    if (size > lim.entryBytes) { res.tooLarge.push(key); continue; }
    res.files.set(key, tar.toString('latin1', start, end));
  }
  res.ok = true;
  return res;
}
