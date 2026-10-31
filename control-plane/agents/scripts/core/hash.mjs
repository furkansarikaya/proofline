// @ts-check
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** SHA-256 hex digest of bytes or of a byte string (one char per byte, the form the core keeps shell text in). @param {Buffer|string} data */
export function sha256(data) {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'latin1') : data).digest('hex');
}

/** SHA-256 of a file's bytes, or '' when it cannot be read (the shell's `hash_file` prints nothing then). @param {string} file */
export function sha256File(file) {
  try { return sha256(readFileSync(file)); } catch { return ''; }
}
