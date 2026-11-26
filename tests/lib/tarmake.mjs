// @ts-check
// A minimal ustar writer for tests (U8): builds the bytes of a .tar and .tar.gz in memory, with the entry types a hostile archive can use (a link, a `../` name). Nothing is written to disk here.
import { gzipSync } from 'node:zlib';

/** @typedef {{ name: string, data?: string | Buffer, type?: string, linkname?: string }} TarEntry */

/** @param {number} n @param {number} width */
const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;

/** @param {TarEntry} e @returns {Buffer} the header block and the padded data */
function entry(e) {
  const data = Buffer.from(e.data ?? '', 'latin1');
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, 'latin1');
  h.write(octal(0o644, 8), 100, 'latin1'); h.write(octal(0, 8), 108, 'latin1'); h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(data.length, 12), 124, 'latin1'); h.write(octal(0, 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(e.type ?? '0', 156, 'latin1');
  if (e.linkname !== undefined) h.write(e.linkname, 157, 100, 'latin1');
  h.write('ustar\x0000', 257, 'latin1');
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

/** @param {TarEntry[]} entries @returns {Buffer} */
export function tarBuffer(entries) { return Buffer.concat([...entries.map(entry), Buffer.alloc(1024)]); }
/** @param {TarEntry[]} entries @returns {Buffer} */
export function tgzBuffer(entries) { return gzipSync(tarBuffer(entries)); }
