# Fast, deterministic tests

The rule statement is Hard rule 10 in `SKILL.md`. This page is the detail behind it. A test that is slow or time-dependent is not finished, even when RED and GREEN are valid.

## 1. The rules, with the reason

1. **Fast, and the same time on every run.** A new test finishes in milliseconds to a few seconds, whatever its kind. A test whose time varies is waiting for something it should be told about.
2. **No real waiting.** `sleep`, a delay, a timeout used as a pause, a loop that polls until a duration has passed. The calls for each ecosystem are the `fast_tests.sleep` list of `ecosystems.json`. A wait for a real signal (a process exit, a socket) waits on that event, never on a time.
3. **Time is injected.** Code that depends on time receives a clock (a parameter, a constructor argument, an interface). The test gives it a fake clock and moves time forward by calling the fake. If the code under test reads the clock itself, change it to take one; that change is in scope when the criterion needs the test.
4. **No direct system-clock read** in the code you write or change, and **no wall-clock assertion** in a test (`elapsed < 100 ms`, a timestamp equal to "now"). The reads for each ecosystem are the `fast_tests.clock_reads` list. A test fixes the time it needs.
5. **Randomness uses a fixed seed**, written in the test. A test never depends on an unseeded generator, on the order of a hash map, or on the machine's locale or time zone unless the test sets it.
6. **External calls are faked**: network, other services, the real clock, the real file system outside a unique temporary folder. The project's own fakes come first; write a small fake inside the test when none exists. Never install a mocking library.
7. **A concurrency test waits on an event** (a latch, a channel, a promise, a barrier, a condition that the code under test signals), not on a duration.
8. **Parallelism is not a fix for a slow test.** Running tests in parallel hides the cost and adds interference. Find why the test is slow (a real wait, a real service, a heavy fixture) and remove that.

## 2. The facility of an ecosystem

`references/ecosystems.json` holds, per ecosystem, `fast_tests`:

- `fake_clock.status`: `supported` when the ecosystem has a standard or common fake-time facility, `unsupported` when it has none.
- `fake_clock.facility`: the facility, or what to do without one.
- `sleep`, `clock_reads`: the names of the real-wait calls and the direct clock reads (a scan reads these).

Use only a facility the project already has or the standard library provides (shared rule 2: nothing is installed). `unsupported`, or a library the project does not have: inject a small clock value (an object with a `now` method, or a function) and write the fake inside the test file. Do not branch on the ecosystem in your own reasoning beyond reading this data; the data is the single place for those facts.

## 3. The duration of each new test (GREEN)

GREEN records the duration of each new test (issue 265, AC-2).

- The number comes from the **GREEN run's own output**: the line the runner prints for that test (`ok 1 - name # duration_ms 0.4`, `PASSED [ 3ms]`, `--- PASS: TestX (0.00s)`, `Passed TestX [2 ms]`). Convert to whole or fractional milliseconds. Never estimate, never take a mean of guesses, never time the whole suite and divide.
- If the runner prints no per-test duration, run the single-test command once more and measure that command with the shell's own timing (`time`), and say so in `duration_source`.
- A duration below the runner's resolution (`0.00s`) is recorded as `0`.

In `tdd.json`, each cycle's `green` carries:

| field | meaning |
|---|---|
| `duration_ms` | the test's duration in milliseconds, a number of 0 or more |
| `duration_source` | `runner_output` (read from the per-test line) or `command_wall_time` (the single-test command was timed) |
| `duration_excerpt` | the runner line (or the timing line) the number was read from |

The validator checks the three fields exist and are well formed. It cannot check that the number matches the output; the control plane re-runs the command (a later package of issue 265 compares the build record's measurement with these values and applies the budgets).

In a run, the same durations go to the recorder: `test_durations: <test name>=<ms>[; <test name>=<ms>]` on stdin of `worker-evidence ... GREEN pass`.
