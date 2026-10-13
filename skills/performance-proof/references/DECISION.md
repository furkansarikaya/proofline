# Statistics and decision rule

`scripts/compare-bench.mjs` (dependency-free) computes, per side:

- `median`, `min`, `max`, quartiles `q1`, `q3` and `iqr` (linear interpolation between order statistics);
- `mad`: the median absolute deviation from the median (unscaled), and `rel_mad_pct` = MAD / median x 100.

and for the change against the base:

- `regression_pct`: the relative change of the median in percent, positive when worse. Lower is better by
  default (`(change - base) / base`); with `--direction higher` (throughput) it is `(base - change) / base`.
- `ci_low_pct`..`ci_high_pct`: the 95 % percentile bootstrap interval of `regression_pct`, and
  `ci99_high_pct`, the upper end of the 99 % interval. Each of 2000 resamples draws both sides with
  replacement and takes the medians; the random numbers come from a seeded generator (mulberry32, seed 1), so
  the same samples always give the same intervals and the validator recomputes them.
- `noise_pct`: the larger relative MAD of the two sides.

## Decision (first match wins)

`T` is the regression threshold.

| # | Condition | Status |
|---|---|---|
| 1 | fewer than `min_runs` samples on either side | INCONCLUSIVE |
| 2 | `regression_pct` > T **and** `ci_low_pct` > T / 2 | FAIL |
| 3 | `noise_pct` > noise threshold | INCONCLUSIVE |
| 4 | `ci99_high_pct` <= T (within the threshold, or an improvement) | PASS |
| 5 | otherwise: the interval neither clears the threshold nor stays within it | INCONCLUSIVE |

The report's status is the worst over its measurements (FAIL over INCONCLUSIVE over PASS), and FAIL when a
judged item violates a quoted written criterion.

## Calibration

`node scripts/calibrate.mjs --trials 500` (seed 12345) draws normal samples around 100 with the given
standard deviation, multiplies the change side by the true effect, and counts the statuses with the default
thresholds (T = 10 %, noise 5 %, 10 runs minimum). A false FAIL is a FAIL when the true effect is within T;
a false PASS is a PASS when it is beyond T.

| noise (sd) | true effect | runs | FAIL | PASS | INCONCLUSIVE |
|---|---|---|---|---|---|
| 3 % | +0 % | 10 | 0 % | 100 % | 0 % |
| 3 % | +0 % | 20 | 0 % | 100 % | 0 % |
| 3 % | +5 % | 10 | 0 % | 60.4 % | 39.6 % |
| 3 % | +5 % | 20 | 0 % | 89.2 % | 10.8 % |
| 3 % | +12 % | 10 | 86 % | 0 % | 14 % |
| 3 % | +12 % | 20 | 93.2 % | 0 % | 6.8 % |
| 3 % | +15 % | 10 | 100 % | 0 % | 0 % |
| 3 % | +15 % | 20 | 99.8 % | 0 % | 0.2 % |
| 8 % | +0 % | 10 | 0.2 % | 14 % | 85.8 % |
| 8 % | +0 % | 20 | 0 % | 18.4 % | 81.6 % |
| 8 % | +5 % | 10 | 2.4 % | 4.4 % | 93.2 % |
| 8 % | +5 % | 20 | 0.6 % | 6 % | 93.4 % |
| 8 % | +12 % | 10 | 28.4 % | 0.2 % | 71.4 % |
| 8 % | +12 % | 20 | 52.6 % | 0 % | 47.4 % |
| 8 % | +15 % | 10 | 54.4 % | 0 % | 45.6 % |
| 8 % | +15 % | 20 | 81.8 % | 0 % | 18.2 % |

Compared with the same 500 trials:

| Rule | false FAIL, 8 % noise, +5 % (N=10 / 20) | false PASS, 8 % noise, +12 % (N=10) | FAIL at 8 % noise, +15 % (N=10 / 20) |
|---|---|---|---|
| FAIL when `ci_low_pct` > 0, PASS when `ci_high_pct` (95 %) <= T (first version) | 9.6 % / 5.8 % | 0.4 % | 81.2 % / 92.8 % |
| FAIL when `ci_low_pct` > T (strict) | 0 % / 0 % | 0.4 % | 18 % / 22 % |
| **FAIL when `ci_low_pct` > T / 2, PASS when `ci99_high_pct` <= T (this rule)** | **2.4 % / 0.6 %** | **0.2 %** | **54.4 % / 81.8 %** |

The first version failed correct work one time in ten on a noisy machine; the strict rule almost never saw a
real regression. This rule keeps both errors small and moves the borderline cases to INCONCLUSIVE, where more
runs or a quieter machine decide. The remaining false PASS (0.2 %, one trial in 500, at 8 % noise) is a draw
whose spread happened to fall under the noise threshold; more runs shrink it. At 3 % noise no trial gave a
false verdict.

## Why this rule

- **Median, not mean**: one slow run (a GC pause, a cache miss, another process) moves a mean; the median
  ignores it. MAD and IQR are the matching spread measures.
- **An interval, not one number**: two medians always differ. The interval says whether the difference is
  larger than the run-to-run variation.
- **PASS needs the 99 % upper end inside the threshold**: "the median moved less than 10 %" on noisy data does
  not rule out a 25 % regression.
- **Noise is INCONCLUSIVE, not FAIL**: a noisy machine is not evidence against the change. It is also not a
  PASS. A clear regression (rule 2) still FAILs on a noisy machine, because the interval already clears half
  the threshold.
- **Minimum runs**: with 3 runs a bootstrap interval is meaningless; the default is 10, the floor 5 (a config
  value below 5 is ignored with a note, and the validator rejects a report with `min_runs` below 5).

## Thresholds and their source

| Source | How | Wins over |
|---|---|---|
| `plan` | `budget_pct=<n>` (0 < n <= 100) on the `performance_critical: yes` line of PLAN.md `## Risk`, read with `--plan PLAN.md` (frozen with the plan; raising it after freeze fails `verify-freeze`) | config, default |
| `config` | `.agents/config.yaml` `performance: regression_pct: <int>` (also `noise_pct`, `min_runs`); frozen with the plan through `freeze.risk_sha256` | default |
| `default` | 10 % regression, 5 % noise, 10 runs | - |
| `cli (unverified)` | `compare-bench.mjs --budget-pct <n>`: a local what-if only; `validate-performance.mjs` refuses this source and has no such option | config, default |

`validate-performance.mjs --config .agents/config.yaml --plan PLAN.md` recomputes the thresholds and their
source; a report whose thresholds differ is invalid. The budget is trusted only from the plan's flag line: an
unparseable or out-of-range `budget_pct` there is a note in the compare-bench report (the budget is not used)
and the validator refuses that plan until it is amended and refrozen. Without those options the thresholds are only what the
report declares: the validator prints `thresholds unverified` and the reviewer's CONFIDENCE is at most medium.

An absolute bound in the plan ("p95 under 200 ms") is not a relative threshold; it is an acceptance criterion
the verifier checks. Report the change side's median and interval for it, citing the measurement.
