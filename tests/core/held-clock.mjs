// @ts-check
// The clock of the watchdog test (issue 266, A277 P2c): a replacement of the global timeout function that only STORES the callbacks of two kinds of timer (the step limit and the
// grace between TERM and KILL) and hands them back to the test, which fires them when the event they are about is true. Every other timer is the real one. Moved here from
// dispatch-watchdog.test.mjs so that the test scan lists this one file as a false positive instead of the whole test.
/** @typedef {{ ms: number, fn: (...a: unknown[]) => void, args: unknown[], fired: boolean }} Held */
/** @param {number} LIMIT_MS the step limit in ms @param {number} GRACE_MS the grace between TERM and KILL in ms */
export function heldClock(LIMIT_MS, GRACE_MS) {
  const real = globalThis.setTimeout;
  /** @type {Held[]} */ const held = [];
  /** @type {Array<() => void>} */ let wake = [];
  /** @type {any} */ (globalThis).setTimeout = (/** @type {(...a: unknown[]) => void} */ fn, /** @type {number} */ ms, /** @type {unknown[]} */ ...args) => {
    if (ms === LIMIT_MS || (typeof ms === 'number' && ms > 3000 && ms <= GRACE_MS)) {
      held.push({ ms, fn, args, fired: false });
      const w = wake; wake = []; for (const f of w) f();   // a timer is held: whoever waits for the next one looks again
      const handle = { ref() { return handle; }, unref() { return handle; }, hasRef() { return false; }, refresh() { return handle; }, close() { return handle; }, [Symbol.toPrimitive]() { return -1; } };
      return handle;
    }
    return real(fn, ms, ...args);
  };
  return {
    /** the step limit's timer, once the dispatcher has set it */
    limit: () => held.find((t) => t.ms === LIMIT_MS),
    /** the timers of the grace between TERM and KILL */
    graces: () => held.filter((t) => t.ms !== LIMIT_MS),
    /** @param {Held | undefined} t */
    fire(t) { if (t && !t.fired) { t.fired = true; t.fn(...t.args); } },
    /** the next timer the dispatcher holds (an event, not a duration) @returns {Promise<void>} */
    nextHold: () => new Promise((r) => { wake.push(r); }),
    restore() { globalThis.setTimeout = real; },
  };
}
