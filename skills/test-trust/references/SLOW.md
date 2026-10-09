# Slow detection

Slow is relative to the scope itself, not an absolute number. A 2-second test is slow in a scope of 5 ms unit tests and normal in a scope of integration tests.

Slow detection costs no extra runs: it uses the per-test durations from the 5 flaky stage-1 runs. It requires the **per-test duration** capability; without it, slow detection is unsupported and no per-test durations are guessed from totals.

## Computing durations

- Each test's duration is the **mean of its completed runs** among the 5. A run that hit the timeout has no real duration: leave it out of the mean, and note the timeout in `observed`.
- If a test completed in fewer than 3 of the 5 runs, it cannot be judged reliably: `needs_validation`, with the missing runs stated.
- **Scope median**: the median of all tests' mean durations.
- **Scope total**: the sum of all tests' mean durations.
- If the median is below the reporter's resolution (it reports 0), use the resolution (for example 10 ms for `0.01` s) as the median, so tests are not flagged just for being measurable.

Save the computed table (test, per-run durations, mean) as `evidence/slow-durations.*`.

## Criterion

A test is slow if either holds:

- its mean duration is **more than 10×** the scope median, or
- its mean duration alone is **more than 5%** of the scope total.

A slow test that meets the criterion with its durations saved as evidence is `confirmed`. Record in `observed`: the mean duration, the per-run durations, the scope median, the ratio to the median, and the share of the scope total.

## Caveats

- In very small scopes (fewer than about 20 tests) the 5% rule flags almost everything above average. Report what the rule says, and mention the scope size in `REPORT.md` so the reader can weigh it.
- A test whose duration is mostly setup shared with others (a fixture attributed to the first test that uses it) may be flagged because of reporter attribution. If the evidence shows that, say so in the finding; do not change the verdict on speculation.
- Slow is a fact about cost, not a judgment that the test is wrong. Do not suggest fixes.
