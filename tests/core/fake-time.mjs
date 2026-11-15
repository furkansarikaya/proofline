// @ts-check
// Fake time for the tests that fire a timer instead of waiting for it (issue 266, A277 P2c): the timers of the code under test are held by node:test and moved by
// `t.mock.timers.tick(ms)`; nothing waits for a duration. The one place that names the timer function, so that the test scan lists one false positive and not one per test.

/** Hold the timeouts of this test until the test ticks them; they are given back when the test ends. @param {import('node:test').TestContext} t */
export function holdTimeouts(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
}
