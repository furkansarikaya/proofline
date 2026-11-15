// @ts-check
// Event sources for tests that must not wait for a duration (issue 266, A277 P2c): a process tells the test over a local socket (Unix socket; a named pipe on Windows)
// that it is up, and the kernel closes that socket when the process ends, also when it is a zombie. The test then waits for the event, never for a time.
import { createServer } from 'node:net';
import { join } from 'node:path';

let count = 0;

/**
 * A server that hands the first connection to the test. @param {string} dir a folder of this test (the socket file lives there)
 * @returns {Promise<{ path: string, first: Promise<import('node:net').Socket>, close: () => Promise<void> }>}
 */
export async function listenOnce(dir) {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\proofline-${process.pid}-${++count}` : join(dir, `s${++count}`);
  /** @type {(s: import('node:net').Socket) => void} */ let hand = () => {};
  const first = new Promise((ok) => { hand = ok; });
  const server = createServer((c) => hand(c));
  await new Promise((ok) => server.listen(path, () => ok(undefined)));
  return { path, first, close: () => new Promise((ok) => { server.close(() => ok(undefined)); }) };
}

/** The promise of the end of a connection: the process on the other side has gone. @param {import('node:net').Socket} sock @returns {Promise<void>} */
export const closed = (sock) => new Promise((ok) => { sock.on('close', () => ok()); });

/** The newline-terminated messages of a connection, one promise at a time. @param {import('node:net').Socket} sock @returns {() => Promise<string>} */
export function lines(sock) {
  let buf = ''; /** @type {((l: string) => void) | null} */ let waiting = null; /** @type {string[]} */ const got = [];
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (waiting) { const w = waiting; waiting = null; w(l); } else got.push(l);
    }
  });
  return () => (got.length > 0 ? Promise.resolve(/** @type {string} */ (got.shift())) : new Promise((ok) => { waiting = ok; }));
}

/** The command line of a process that stays alive until it is killed and waits for nothing: it reads its standard input, which the test keeps open (spawn it with stdio ['pipe', 'ignore', 'ignore']). */
export const PARKED = ['-e', 'process.stdin.resume()'];
