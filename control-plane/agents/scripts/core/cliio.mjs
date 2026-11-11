// @ts-check
// Descriptor output and input of the CLI front end (A233) and the error that ends a `proofline` command with its message and the user's next step.
import { readSync, writeSync } from 'node:fs';
import { ProoflineError } from './errors.mjs';
import { cleanOut } from './codetrust.mjs';

/**
 * A synchronous writer for a descriptor of this process: output keeps its order with a child that inherits the descriptor. @param {number} fd
 * @returns {{ write(chunk: Buffer): boolean }}
 */
export function fdWriter(fd) {
  return {
    write(chunk) {
      let off = 0;
      while (off < chunk.length) {
        try { off += writeSync(fd, chunk, off); } catch (e) {
          const code = /** @type {NodeJS.ErrnoException} */ (e).code;
          if (code === 'EAGAIN') continue;
          return false; // EPIPE: the reader went away
        }
      }
      return true;
    },
  };
}

/** `die` of the CLI: `proofline: MESSAGE` on stderr, then the user's next step (`--error[=KIND]`), status 1. */
export class CliDie extends ProoflineError {
  /** @param {string} message a byte string @param {string} [kind] the next-step kind (`usage`) */
  constructor(message, kind = '') {
    super(`proofline: ${cleanOut(message)}`, 1, 'CLI_DIE'); // the message may carry configuration or repository text: it reaches a terminal
    this.kind = kind;
  }
}

/** One line of standard input without its newline (`IFS= read -r`), or null at the end of the input. @param {number} [fd] */
export function readLine(fd = 0) {
  const one = Buffer.alloc(1);
  /** @type {number[]} */ const got = [];
  for (;;) {
    let n = 0;
    try { n = readSync(fd, one, 0, 1, null); } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EAGAIN') continue;
      if (code === 'EOF') break;
      return got.length > 0 ? Buffer.from(got).toString('latin1') : null;
    }
    if (n === 0) break;
    if (one[0] === 10) return Buffer.from(got).toString('latin1');
    got.push(one[0]);
  }
  return got.length > 0 ? Buffer.from(got).toString('latin1') : null;
}
