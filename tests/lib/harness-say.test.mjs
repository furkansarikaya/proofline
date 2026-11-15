// @ts-check
// The stamp `say` of the harness gives a message (issue 266, A277 P2d): after every record, never ahead of the clock by more than AHEAD seconds, the next free second for the same words.
// The clock is a number handed in; nothing reads or waits for the time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AHEAD, captureStamp } from './harness.mjs';

test('a message is stamped at the clock, or one second after the newest record when that is later', () => {
  assert.equal(captureStamp(new Set(), 'p|s1|', 'a', 0, 1000), 1000);
  assert.equal(captureStamp(new Set(), 'p|s1|', 'a', 1000, 1000), 1001);
  assert.equal(captureStamp(new Set(), 'p|s1|', 'a', 990, 1000), 1000);
});

test('the same words go to the next free second; other words, projects and sessions do not collide', () => {
  const seen = new Set();
  assert.deepEqual([1, 2, 3].map(() => captureStamp(seen, 'p|s1|', 'approve plan', 0, 1000)), [1000, 1001, 1002]);
  assert.equal(captureStamp(seen, 'p|s1|', 'other words', 0, 1000), 1000);
  assert.equal(captureStamp(seen, 'q|s1|', 'approve plan', 0, 1000), 1000);
  assert.equal(captureStamp(seen, 'p|s2|', 'approve plan', 0, 1000), 1000);
});

test('more than AHEAD seconds ahead is refused with a message that says what to do, and the refused stamp is not remembered', () => {
  const seen = new Set();
  for (let i = 0; i <= AHEAD; i++) assert.equal(captureStamp(seen, 'p|s1|', 'x', 0, 1000), 1000 + i);
  assert.throws(() => captureStamp(seen, 'p|s1|', 'x', 0, 1000), /ahead of the clock.*other words, or use sayNow/);
  assert.equal(captureStamp(seen, 'p|s1|', 'y', 0, 1000), 1000, 'the refusal left the set alone');
  assert.throws(() => captureStamp(new Set(), 'p|s1|', 'z', 1000 + AHEAD, 1000), /ahead of the clock/, 'a record already at the limit leaves no room');
});
