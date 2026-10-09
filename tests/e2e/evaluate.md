# Independent end-to-end evaluation

Evaluate one completed run without participating in it. Inputs are the run's `out/` directory and `tests/e2e/expected/COMMON.md`, `tests/e2e/expected/<SCENARIO>.md`, `tests/e2e/expected/FACTS.md`, and `tests/e2e/expected/RUNTIME_MATRIX.md`. For FAILOVER, use `FAILOVER.md` and the STANDARD task facts. For a runtime comparison, inspect the other configurations' `out/` directories too.

Read every numbered expectation and each applicable runtime matrix row. Check the collected run artifacts, source diff, database probe, ledger, gates, and transcripts directly. Evidence must be an artifact path and line number or a command with its output. A lead's claim, plan, or stated intent alone earns no credit. A missing artifact is unmet. Mark an item not-applicable only when the expectation explicitly allows that result. A timeout or unavailable runtime is not a pass. A difference in a matrix “must not differ” row makes its named item unmet in the deviating run.

Produce one table for each expected file and include every applicable item. Use this exact table format:

| item | met/unmet/not-applicable | evidence (file:line or command output) |
|---|---|---|
| C-1 | met | out/agent-status.txt:1 ... |

Finish with exactly one verdict line, counting only applicable items:

`E2E: PASS|FAIL (<met>/<applicable>)`

PASS requires every applicable item to be met. Do not infer a pass from an exit code or a summary alone.
