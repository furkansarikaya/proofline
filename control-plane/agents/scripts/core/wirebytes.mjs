// @ts-check
// A284 (round 3): the one conversion of a JavaScript string to the bytes a control-plane file holds. The core keeps text as byte strings (one char per byte);
// text that came from argv (or utf8 decoding) can still hold a char above 0xFF, and `Buffer.from(s, 'latin1')` keeps only its LOW BYTE (U+0165 becomes `e`,
// U+013D `=`, U+010A a newline), so such a char could rebuild a key, a quote or a line break after a check. Here each char above 0xFF becomes its UTF-8
// bytes (all of them >= 0x80, so never a control character, quote, `=` or newline), the same mapping as `bytes()` of config.mjs; chars up to 0xFF are kept.

/** @param {string} s @returns {string} the byte string (every char <= 0xFF) */
export function wire(s) {
  return /[^\x00-\xff]/.test(s) ? s.replace(/[^\x00-\xff]/gu, (c) => Buffer.from(c, 'utf8').toString('latin1')) : s;
}

/** @param {string | Buffer} s a Buffer is returned unchanged @returns {Buffer} the bytes of a file write */
export function latin1Buf(s) { return Buffer.isBuffer(s) ? s : Buffer.from(wire(s), 'latin1'); }
