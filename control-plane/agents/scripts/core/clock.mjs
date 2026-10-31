// @ts-check
// The one clock of the core. No environment value and no argument moves it (D14: no clock seam).

/** @returns {{ epoch: number, iso: string }} one reading, so `ts=` and `epoch=` name the same second */
export function now() {
  const ms = Date.now();
  const epoch = Math.floor(ms / 1000);
  return { epoch, iso: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

/** Sleep without spinning (the lock wait; sleeps 0.2 s in agent.sh). @param {number} ms */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
