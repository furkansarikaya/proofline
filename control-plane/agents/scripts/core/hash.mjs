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

/** The id `git hash-object --stdin` gives a byte string (a blob), without starting git: SHA-1 of "blob <length> NUL <bytes>". @param {string} text a byte string */
export function gitBlobSha(text) {
  const body = Buffer.from(text, 'latin1');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
}

/** POSIX `cksum` of the bytes: the CRC the explorer's resume note and a project rule without a lesson id are named by. @param {Buffer} buf */
export function cksum(buf) {
  let crc = 0;
  /** @param {number} b */
  const step = (b) => {
    crc ^= b << 24;
    for (let k = 0; k < 8; k++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) : (crc << 1);
    crc >>>= 0;
  };
  for (const b of buf) step(b);
  let len = buf.length;
  while (len > 0) { step(len & 0xff); len = Math.floor(len / 256); }
  return String((~crc) >>> 0);
}
