// @ts-check
// The one place of the dispatcher tests that polls (issue 266, A277 P2c). The state it waits for is written by a separate process, the shell-script fake runtime of
// tests/core/dispatch-lib.mjs (a pid file, a marker file, a ledger line, a process that has ended), and the fake has no way to tell the test. Listed in
// tests/ci/test-scan-allowlist.tsv with that reason. To remove it, the fake runtimes report over a socket (tests/core/event-lib.mjs) and the conditions that are about
// a process being gone become the close of its connection; every other wait of the dispatcher tests is already an event (the held timers of the watchdog test, the end of the dispatch).
const pause = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond()` holds, looking again every 20 ms; `failsafeMs` only bounds the number of looks (failsafeMs / 20), so that a wait that never ends fails instead of hanging. No clock is read. @param {() => boolean} cond @param {number} [failsafeMs] */
export async function until(cond, failsafeMs = 120000) {
  for (let looks = 0; !cond(); looks++) {
    if (looks > failsafeMs / 20) throw new Error('timed out waiting');
    await pause(20);
  }
}
