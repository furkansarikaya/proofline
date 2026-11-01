// @ts-check
// File writes of the hook: never through a symbolic link at the last component (O_NOFOLLOW), never a predictable temporary name that a link could hijack.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Write all of DATA to a descriptor. @param {number} fd @param {string | Buffer} data */
function writeAll(fd, data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off);
}

/**
 * Create or replace FILE with DATA (the shell's `printf > FILE`, mode 0666 under the umask). A link at FILE is refused (the write throws).
 * @param {string} file @param {string | Buffer} data @param {{ exclusive?: boolean }} [opt] exclusive: fail when FILE exists (`set -C`)
 */
export function put(file, data, opt = {}) {
  const flags = constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | (opt.exclusive ? constants.O_EXCL : constants.O_TRUNC);
  const fd = openSync(file, flags, 0o666);
  try { writeAll(fd, data); } finally { closeSync(fd); }
}

/** Append DATA to FILE (`>>`), refusing a link. @param {string} file @param {string | Buffer} data */
export function append(file, data) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW, 0o666);
  try { writeAll(fd, data); } finally { closeSync(fd); }
}

/** Write FILE through a temporary name beside it and rename it into place (`printf > .tmp && mv`). @param {string} file @param {string} tmp @param {string | Buffer} data */
export function putAtomic(file, tmp, data) {
  rmSync(tmp, { force: true });
  put(tmp, data, { exclusive: true });
  renameSync(tmp, file);
}

/** `mkdir -p`, quietly: true when the folder exists afterwards. @param {string} dir */
export function mkdirp(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch { /* checked below */ }
  return isDir(dir);
}

/** @param {string} p */
export function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
/** @param {string} p */
export function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
/** `$(cat FILE)`'s raw text, or '' when it cannot be read. @param {string} p */
export function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
/** The names in a folder, in byte order ('' list when it cannot be read). @param {string} dir */
export function names(dir) { try { return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); } catch { return []; } }
/** @param {string} p */
export function isLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** `rm -f` @param {string} p */
export function rmf(p) { try { rmSync(p, { force: true }); } catch { /* gone or not ours */ } }
export { existsSync };
