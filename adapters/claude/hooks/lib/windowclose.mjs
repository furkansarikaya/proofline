// @ts-check
// B2 (issue #338): the SubagentStop hook closes a worker's write window with `agent.sh window-close`. When the lead's own command holds the lock longer than
// the hook's lock wait, the close fails with "lock timeout"; the tree would then stay unattested. The close is tried again, a fixed number of times (each try
// already waits for the lock), and a window the lead's `handoff` closed meanwhile (its file is gone) counts as closed. No clock is read here.

/** The tries of one close (each waits PROOFLINE_HOOK_LOCK_WAIT for the lock, 8 s by default; the hook has 120 s). */
export const CLOSE_TRIES = 4;

/**
 * @param {() => Promise<{ status: number, stdout: string, stderr: string }>} run one `window-close`
 * @param {() => boolean} windowStillOpen is the window file still there?
 * @param {number} [tries]
 * @returns {Promise<{ closed: boolean, tries: number, last: { status: number, stdout: string, stderr: string } }>}
 */
export async function closeWithRetry(run, windowStillOpen, tries = CLOSE_TRIES) {
  let r = { status: 1, stdout: '', stderr: '' };
  for (let n = 1; n <= tries; n++) {
    r = await run();
    if (r.status === 0) return { closed: true, tries: n, last: r };
    if (!windowStillOpen()) return { closed: true, tries: n, last: r };   // closed by the lead's handoff
    if (!/lock timeout/.test(r.stdout + r.stderr)) return { closed: false, tries: n, last: r };   // a real refusal is not retried
  }
  return { closed: false, tries, last: r };
}
