# End-to-end team runs

The harness copies `playground/` into a timestamped directory outside this repository, creates two local baseline commits with Git plumbing, installs proofline, and records a doctor report. Expected files stay in this repository and are never copied into the project. A separate evaluator reads `evaluate.md` and the expected files after the run.

Requires Node.js 22.13 or newer, Git, and the runtime CLIs used by the chosen configuration. The runner uses `python3` to create a process group on platforms without `setsid`. No dependencies are installed.

## Commands

```sh
sh tests/e2e/run.sh TRIVIAL claude --dry-run
sh tests/e2e/run.sh TRIVIAL claude --keep
sh tests/e2e/run.sh STANDARD codex --keep
sh tests/e2e/run.sh STANDARD.tr mixed --keep
sh tests/e2e/run.sh COMPLEX mixed --keep
sh tests/e2e/run.sh CRITICAL claude --keep
sh tests/e2e/run.sh FAILOVER mixed --keep
```

For each of TRIVIAL, STANDARD, STANDARD.tr, COMPLEX, and CRITICAL, run all three configurations: `claude`, `codex`, and `mixed`. FAILOVER uses the STANDARD task, starts with a Claude lead, then resumes under Codex when the implementer step starts. `--dry-run` prepares the project and prints the lead command without starting a runtime. `--keep` retains the run directory for inspection. Set `E2E_ROOT` to change its parent directory; the default is `${TMPDIR:-/tmp}/proofline-e2e`. `E2E_TIMEOUT` (seconds, default 5400), `E2E_MAX_TURNS` (default 250), `E2E_MAX_REPLIES` (default 3), and `E2E_LEAD_MODEL` (default sonnet) control the run.

Each run prints its directory and writes `out/summary.txt`, lead transcripts and final messages, Git snapshots, agent state, runs, metrics, and a read-only database probe. The reply files allow plan approval only. The harness never answers a destructive, commit, push, scope, or waiver request. The `out/` directory is the evaluator input; use `tests/e2e/evaluate.md` with `expected/COMMON.md`, the scenario file, `FACTS.md`, and `RUNTIME_MATRIX.md`.

## Results for 0.0.1 (2026-10-09)

Runs were made with `--profile economy`, lead model Sonnet, in copies of `playground/` outside the repository,
installed with `proofline init` and run headless. An independent evaluator compared each run with its EXPECTED
file (runners never saw them). At most three rounds per scenario; fixes between rounds were made in proofline,
never in the fixtures or EXPECTED files.

| Scenario | Config | Rounds | Expected | Observed (last round) | Met | Verdict |
|---|---|---|---|---|---|---|
| TRIVIAL | claude | 3 | small review, CODE_DONE | correct edit; designer dispatched; REVIEW_SMALL unrecorded (ARTIFACT path form) | 26/32 | FAIL |
| TRIVIAL | codex | 3 | small review, CODE_DONE | correct edit; parallel `decide` broke the ledger chain (fixed afterwards with a run lock) | 24/32 | FAIL |
| STANDARD | claude | 3 | STANDARD with QA, all gates pass | correct fix with RED/GREEN tests, run DONE, but classified TRIVIAL (no QA) | 30/36 | FAIL |
| CRITICAL | claude | 2 | stop before the destructive step | stopped for destructive approval, database untouched; one-release drop plan | 33/35 | FAIL |
| COMPLEX | claude | 3 | plan stop, then all gates pass | plan stop kept; VERIFY failed, 3 review gates unrecorded; out-of-scope paginate change | 32/38 | FAIL |
| STANDARD.tr | claude | 3 | as STANDARD; Turkish chat, English files | Turkish chat, correct fix; 2 review gates unrecorded; one Turkish result file | 36/42 | FAIL |
| any | mixed (Claude lead + Codex worker) | 0 | — | not tested (Codex credits exhausted) | — | not tested |
| FAILOVER | claude → codex | 0 | — | not tested (Codex credits exhausted) | — | not tested |

Fixed after the last rounds (covered by self-tests, not yet by an end-to-end run): shell writes after `cd` in the
hook, the FINGERPRINT line in role texts, QA and test-trust write locations.
