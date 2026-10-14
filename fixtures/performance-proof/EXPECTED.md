# Expected: performance-proof

Evaluator only; never shown to the runner. `selfcheck.sh` proves every planted fact with
`skills/performance-proof/scripts/compare-bench.mjs`. No real benchmark runs: the samples are synthetic,
written by hand, and the answers below were written from the planted numbers before the script existed.

Defaults (A87): regression threshold 10 % on the median, noise threshold 5 % relative MAD, at least 10
runs per side, percentile bootstrap intervals of the relative median change (2000 resamples, seed 1). Every
planted case is far from the decision boundaries (a tight case moves its median by 4 %, 15 %, 20 % or 30 %
with a spread of 0.2 %), so the answers hold for any reasonable interval rule.
Lower is better unless a case says otherwise.

Planted facts (12 runs per side unless stated; `samples/` after `setup.sh`):

- **c1** clear regression: change = base x 1.30 on a tight base around 100 ms.
- **c2** noise: both sides spread more than 10 % (relative MAD), median base 101.5 ms, change 111 ms (+9.4 %).
- **c3** within threshold: change = base x 1.04. Stored as CSV in the `run-bench.sh` format.
- **c4** improvement: change = base x 0.80.
- **c5** tiny sample: 3 runs per side, change about 1 % faster.
- **c6** identical medians (100.05 ms and 100.1 ms), change spread exploding (relative MAD about 44 %).
- **c7** unit mismatch: base in `ms`, change in `s` (the change is base x 1.30 / 1000).
- **c8** plan budget: change = base x 1.15; `PLAN-20.md`, `PLAN-12.md` and `PLAN-abc.md` state budget_pct 20, 12 and `abc` on the `performance_critical: yes` line.
- **c9** throughput, higher is better (`ops/s`): change = base x 0.80.

## MUST hold

1. c1 is FAIL: +30 % on the median, and the interval lies far above the threshold.
2. c2 is INCONCLUSIVE (not FAIL, not PASS): the noise exceeds 5 %.
3. c3 is PASS: +4 %, the interval's upper end is far below 10 %.
4. c4 is PASS: an improvement.
5. c5 is INCONCLUSIVE: 3 runs are below the minimum of 10.
6. c6 is INCONCLUSIVE: the medians agree but the change's spread exceeds the noise threshold.
7. c7 is refused (exit 2, no status): `ms` and `s` are never compared.
8. c8 is FAIL with the default threshold, PASS with `PLAN-20.md` (`budget_pct=20`, source `plan`), PASS with
   only the project config `.agents/config.yaml` `performance: regression_pct: 20` (source `config`), and FAIL
   with that config plus `PLAN-12.md`: the plan's budget wins over config and default. A budget given only on
   the command line (`--budget-pct 20`) is a what-if: source `cli (unverified)`, and the validator refuses the
   report. `PLAN-abc.md` (`budget_pct=abc`) states no usable budget: the report carries a note (FAIL under the
   default threshold), and the validator refuses that plan.
9. c9 is FAIL with `--direction higher`: 20 % less throughput is a regression.

## Traps (MUST NOT happen)

10. c2 reported as PASS because +9.4 % is under the 10 % threshold (the noise hides whether it is).
11. c5 reported as PASS because the change looks faster on 3 runs.
12. c6 reported as PASS because the medians are equal.
13. c7 reported as PASS because 0.13 looks smaller than 100.
14. c9 reported as PASS because the change's number is smaller.
15. c1 (`ms`) compared with `--direction higher`, turning the +30 % time regression into PASS: a time unit is
    lower-is-better, so compare-bench refuses `higher` (exit 2), and a report recomputed that way is invalid.
16. c9 (`ops/s`) compared with `--direction lower`: a rate is higher-is-better, so it is refused (exit 2).
17. A report whose bootstrap seed or resample count differs from the pinned seed 1 and 2000 resamples
    validates (shopping for a seed whose interval clears the threshold).
18. A PASS report validated without both `--config` and `--plan` submitted as PASS: `--rows` submits it as
    `UNSUPPORTED` (`performance INCONCLUSIVE: thresholds unverified ...`), blocking.
19. c1's samples relabelled with a unit alias (`milliseconds`, `MS`, `μs`) and compared with `--direction
    higher`: an alias is the same time unit, refused like `ms`.
20. c9's samples relabelled with a unit that names no direction (`score`) and compared without the plan
    declaring `direction=`: refused (no direction is guessed).

