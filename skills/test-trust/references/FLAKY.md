# Flaky detection

A flaky test changes outcome on identical code. Three kinds:

- `flaky_nondeterministic`: changes outcome when run **alone** (time, randomness, concurrency, network, unseeded data).
- `flaky_order_dependent`: stable alone, changes outcome only **within the suite** (shared state, leaked globals, test pollution, missing cleanup).
- `flaky_unclassified`: proven flaky in stage 1, but the sub-kind cannot be determined because stage 2 could not run (no single-test selection). Always carries `missing` explaining why.

Flaky measurements do not change code and may run in the user's working directory. Run everything sequentially. Do not touch the code between runs; if the working tree changes during the stage (the user edits a file), the stage's runs are no longer on identical code: note it and restart the stage.

## Stage 1: find candidates

Run the scoped suite **5 times**, shuffled where shuffle is supported, with per-test durations enabled where supported. Save each run's raw output as `evidence/flaky-s1-run<N>.*` and record the seed of each shuffled run.

- Apply the timeout rule for suite runs: 3× the scope's baseline duration, minimum 30 seconds. A run that times out records every test that had not finished as a **fail** for that run.
- Tests red at baseline that fail all 5 runs stay on the "red at baseline" list; they are not candidates.
- A test whose outcome differs across the 5 runs (including a red-at-baseline test that passes at least once) is a **candidate**.

Record candidates in the ledger with their per-run outcomes. Then hand the per-test durations to [SLOW.md](SLOW.md).

**Checkpoint:** recompute the total estimate including stage 2 (20 runs × candidate count × each candidate's baseline duration, plus overhead) and the remaining hollow budget. If it now exceeds 15 minutes, show the new estimate and ask before continuing. Offer to limit stage 2 to some candidates. A skipped candidate that already passed and failed on identical code in stage 1 becomes `flaky_unclassified` (`confirmed`, `missing`: "stage 2 skipped by the user"); any other skipped candidate is `needs_validation`.

## Stage 2: isolate candidates

Run each candidate **alone, 20 times**, with result caching disabled. Save the output as `evidence/flaky-s2-<test-slug>.*`. Timeout for these single-test runs: 3× that test's own baseline duration (the scope's baseline if per-test durations are unsupported), minimum 30 seconds; a timeout is a **fail**.

| Stage 2 result | Verdict |
|---|---|
| Outcome changes alone (at least one pass and one fail among the 20) | `flaky_nondeterministic`, `confirmed` |
| Stable alone, but outcome changed within the suite in stage 1 | `flaky_order_dependent`, `confirmed` (stage 1 provides the pass and fail on identical code) |
| Fails all 20 alone, but passed within the suite in stage 1 | `flaky_order_dependent`, `confirmed` (it depends on an earlier test to pass) |

**Confirmation criterion:** at least one recorded pass and one recorded fail on identical code, both with saved output. Without that, it is not `confirmed`.

For `flaky_order_dependent`, if the runner printed seeds, record the seed of a failing run and the seed of a passing run in `observed` so the order can be replayed. Narrowing down the polluting test is not required; mention it only if the evidence already shows it.

## Unsupported capabilities

- **No single test:** stage 2 is not possible. A candidate with at least one pass and one fail on identical code in stage 1 is still proven flaky: `flaky_unclassified`, `confirmed`, with `missing` set to "single-test selection unsupported, so nondeterministic vs. order-dependent could not be determined". Do not drop it.
- **No shuffle:** stage 1 runs in default order. Report that order-dependence detection is unsupported.
- **No repeat:** loop the command in the shell. If results are served from a cache that cannot be disabled, flaky detection is unsupported.

## Refuting a candidate

Before reporting, look for a reason the outcome change is not the test's fault: an environment change between runs (a service went down, disk full, the network dropped for every test at once), a timeout caused by machine load affecting many tests in the same run, or a red-at-baseline test failing for an unrelated setup reason. If an environment cause explains it, the verdict is `cleared` or `needs_validation`, with the reason recorded.
