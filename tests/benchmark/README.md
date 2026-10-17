# Benchmark report

Scores recorded outputs against the known answers the repository already has: the `EXPECTED.md` of every
`fixtures/*` scenario and the `tests/e2e` runs. It invents no scenario and calls no model (decision A90).

```sh
node tests/benchmark/benchmark.mjs                                   # known answers only: counts per skill, all "not scored"
node tests/benchmark/benchmark.mjs --verdicts verdicts.json          # score recorded verdicts
node tests/benchmark/benchmark.mjs --run-validators                  # also run each fixture's selfcheck.sh and skill tests (minutes)
node tests/benchmark/benchmark.mjs --e2e-dir "$TMPDIR/proofline-e2e" # score e2e run directories (one run or a parent)
node tests/benchmark/benchmark.mjs --out report-dir                  # write benchmark.md and benchmark.json
node --test tests/benchmark/benchmark.test.mjs                                  # the benchmark's own known-answer test (seconds)
```

`--e2e-dir` may repeat; `--fixtures DIR` points at another fixtures tree. Exit status 2 on a usage error or a
verdict that names an id EXPECTED does not have.

## What is measured

| Column | Source |
|---|---|
| expected / traps | `EXPECTED.md`: items under MUST, MUST find, Process expectations are expected findings; items under MUST NOT, decoys are traps. An item is a numbered line, a table row keyed by an id (`E1`, `X1`) or a bullet starting with a bold id (`**P1**`). |
| found / missed | verdict `found` ids; every other expected id is missed |
| false positives | tripped traps (`tripped`) plus findings that match nothing (`extra`) |
| scope adherence | verdict `changed_paths` that are not in `planned_scope` (a scope entry ending in `/` covers its folder) |
| duration, tokens | verdict `duration_s`, `tokens_total`; `n/a` when absent (never estimated) |
| selfcheck, skill tests | `--run-validators`: `fixtures/<skill>/setup.sh` + `selfcheck.sh`, and `tests/skills/<skill>.test.mjs` |

A fixture whose `EXPECTED.md` has no parseable items is `not measurable`; a parseable fixture without a verdict
is `not scored`. Nothing is guessed from prose.

A file with no id-keyed items but with a `Traps`, `Planted facts`, `Must hold` or `known answers` heading is read
structurally: table rows and bullets of its sections are items with positional ids (`F1`, `F2`, ... expected;
`T1`, `T2`, ... traps, in file order), bullets after a `Traps ...:` lead-in or starting `Trap:` are traps, and the
`Scenario`/setup sections and every prose paragraph are skipped. A verdict names these ids.

## Verdict file

One JSON object, keyed by fixture name. Written by whoever compared the run with `EXPECTED.md` (the existing
evaluator step), not by the benchmark. A verdict needs a non-empty `evaluator` string, or an `evidence` map with a
non-empty entry (file:line or command) for every found id; a verdict with none of `found`, `tripped`, `extra` is
`not scored`. Trust limit: the benchmark cannot check a verdict against the run; it only rejects ids EXPECTED does
not have and verdicts with no named judge. A forged or careless verdict is scored as written.

```json
{
  "api-design": {
    "evaluator": "sonnet-session-2026-10-13",
    "found": ["1", "2", "3"],
    "tripped": ["8"],
    "extra": ["claims openapi.yaml has no servers entry"],
    "planned_scope": ["openapi.yaml"],
    "changed_paths": ["openapi.yaml", "src/api/projects.js"],
    "duration_s": 312,
    "tokens_total": 41200
  }
}
```

## End-to-end runs

A run directory is what `tests/e2e/run.sh --keep` prints (`out/summary.txt` inside). The benchmark reads
`out/evaluation.md` (or `evaluation.md` next to `out/`): the evaluator's table from `tests/e2e/evaluate.md`
(`| C-1 | met | ... |`, `unmet`, `not-applicable`) (a tag column after the status is ignored) and its `E2E: PASS|FAIL` line. Unmet items count as missed; e2e
expectations are requirements, so false positives are `n/a`. Scope comes from `out/runs/*/PLAN.md` `scope:` against
the paths in the collected diffs and untracked list (`.agents/`, `.claude/`, `.codex/` ignored). Duration is the
`run` metrics record, else the sum of the lead durations; tokens are the sum of runtime-reported `dispatch`
records (`docs/concepts/metrics.md`).

## CI

Pull requests run only `node --test tests/benchmark/benchmark.test.mjs`. The full report with `--run-validators` runs on main and
nightly (the `fixtures` job) and is not a gate: it always exits 0 on a completed report. When a fixture validator is not
passing, `--out` mode prints a one-line warning and `totals.validators_failed` in `benchmark.json` counts them.
