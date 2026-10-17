# Independent end-to-end evaluation

Evaluate one completed run without participating in it. Inputs are the run's `out/` directory and `tests/e2e/expected/COMMON.md`, `tests/e2e/expected/<SCENARIO>.md`, `tests/e2e/expected/FACTS.md`, and `tests/e2e/expected/RUNTIME_MATRIX.md`. For FAILOVER, use `FAILOVER.md` and the STANDARD task facts. For a runtime comparison, inspect the other configurations' `out/` directories too.

Read every numbered expectation and each applicable runtime matrix row. Check the collected run artifacts, source diff, database probe, ledger, gates, and transcripts directly. Evidence must be an artifact path and line number or a command with its output. A lead's claim, plan, or stated intent alone earns no credit. A missing artifact is unmet. Mark an item not-applicable only when the expectation explicitly allows that result. A timeout or unavailable runtime is not a pass. A difference in a matrix “must not differ” row makes its named item unmet in the deviating run.

Produce one table for each expected file and include every applicable item. Use this exact table format:

| item | met/unmet/not-applicable | tag | evidence (file:line or command output) |
|---|---|---|---|
| C-1 | met | invariant | out/agent-status.txt:1 ... |

The tag column copies the item's `[invariant]` or `[quality]` tag from the expected file (A133). Finish with exactly one verdict line, counting only applicable items, each tag counted separately:

`E2E: PASS|FAIL (invariant <met>/<applicable>, quality <met>/<applicable> = <pct>%)`

PASS requires every applicable invariant item to be met AND the quality met-rate (met / applicable quality items, rounded down to a whole percent) to be at least 90%. A scenario with no applicable quality item has a quality rate of 100%. Otherwise FAIL. Do not infer a pass from an exit code or a summary alone.

Also score every applicable item of `tests/e2e/expected/CAPABILITIES.md` (`N-` items) and report them in a separate table with the same format. They never replace or loosen an existing item and are not counted in the `E2E:` verdict line; use the same table format with the tag column, and give them their own line `CAPABILITIES: PASS|FAIL (invariant <met>/<applicable>, quality <met>/<applicable> = <pct>%)` under the same PASS rule. For C-14, `out/replies-log.txt` lists each reply with its kind: `plan-approval` replies are approvals, `question` replies are question replies; judge the limit (3 answers, +1 for every refreeze; replies of both kinds and plan approvals count together) with that record and state both counts and the number of refreezes.

Clean up after yourself (A117): write only your evaluation file, to the path you were given. When you finish, remove every scratch file, copy, extracted tree or temporary worktree you created, and never leave files in the repository checkout. The run's `out/` directory is read-only input: do not change or delete anything in it.
