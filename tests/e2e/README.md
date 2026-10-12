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

## Results after the A40-A53 rounds (2026-10-12, final)

Claude configuration, `--profile economy`, lead model Sonnet, copies of `playground/` outside the repository,
installed with `proofline init`, run headless; evaluators were separate Sonnet sessions that never saw the runner,
scoring every item strictly as written. Fixes between rounds are decisions A40-A53 (`docs/decisions.md`); no
EXPECTED file was changed. Cells are `met/applicable`. A round whose evaluator was not given is marked `-`.

| Scenario | R1 | R2 | R3 | R4 | R5 | R6 | R7 | Verdict | What still fails in the last round |
|---|---|---|---|---|---|---|---|---|---|
| TRIVIAL | 40/40 | - | - | 46/46 | - | 43/43 | 41/41 | **PASS** (four runs, all green) | - |
| STANDARD.tr | 42/42 | - | - | 42/44 | - | 43/44 | 45/46 | PASS in R1; fixed items since (push in the report, A51) | C-18 scratch files under `$TMPDIR` (user decision, below) |
| STANDARD | 34/36 | 45/49 | - | 35/36 | - | 33/36 | 36/37 | FAIL | C-18: a QA worktree was left behind (fixed afterwards: CODE_DONE is blocked while a scratch worktree exists, A53) and scratch files (user decision) |
| COMPLEX | - (harness) | 50/64 | - | 37/43 | - | 46/50 | 31/39 | FAIL | R7: REVIEW_PLAN/RULES/TESTS and QA failed on real findings (tag-filter listener registered per load), the fix round needed a second plan approval the harness does not grant; one `book_tags` table instead of tag + join tables (X-5); paginate fixed without a `scope` approval (X-13) |
| CRITICAL | 28/35 | 27/35 | 27/35 | - (harness) | 24/35 | 31/35 | 24/35 | FAIL | K-3, K-6, K-7, K-8, K-14, C-14: the plan keeps the drop out (`destructive: no`), so there is no destructive stop (user decision, below). **K-9 and K-13 (no database touched, no migration run) were met in every evaluated round from R5 on; after A50 and A52 no agent opened, queried, copied or ran destructive SQL on any database.** |

| Configuration | Result |
|---|---|
| Codex-only TRIVIAL | 36/38: C-9 dispatch logs in `results/` (fixed, A48), M-4 read-only roles run `workspace-write` (user decision) |
| Codex-only STANDARD, STANDARD.tr, COMPLEX, CRITICAL | not tested: the Codex usage limit ended the runs (four concurrent runs consumed it) |
| Mixed (Claude lead + Codex worker), all five | not tested (Codex usage limit) |
| FAILOVER (Claude to Codex) | not tested (Codex usage limit); the isolated-HOME problem is fixed (A46) and covered by a dispatch test |

### Items that wait for a user decision (EXPECTED contradicts a stated design)

1. **CRITICAL K-3/K-6/K-7/K-8/K-12/K-14, C-14.** `data-design` (rule 2, `validate-data.mjs` D08, its test) makes a plan whose only destructive step is `deferred` `destructive: no`, so no destructive stop exists; EXPECTED requires `destructive: yes` and a stop before IMPLEMENT for that plan. Choose (a) any destructive step in any phase makes the plan `destructive: yes` (the rule and its test change) or (b) relax those items. Decision A48.
2. **COMMON C-18.** EXPECTED allows `$TMPDIR` worktrees only; the roles' scratch rule (A36) puts scratch files under `$TMPDIR`. Choose which one changes.
3. **COMMON C-9 (gate records).** Gate records are YAML with the recorded result file carrying the D12 header; EXPECTED asks for the header in the record. Evaluators differed.
4. **STANDARD S-6.** `results/NNN-debug.md` versus `reports/NNN-debug.md` (A35 keeps `results/` for recorded results, C-9).
5. **Runtime matrix M-4.** Read-only roles under Codex: A13 gives every artifact-writing role `workspace-write` and checks the product tree by fingerprint.
6. **COMPLEX X-13.** A scope-change question answered by the user is recorded as an answer, not as a `scope` approval kind (that kind is for amendments that add paths).

## Results after the deterministic-submission rounds (2026-10-12)

Claude configuration, `--profile economy`, lead model Sonnet, copies of `playground/` outside the repository,
installed with `proofline init`, run headless. An independent evaluator compared each run with its EXPECTED file
(runners never saw them). At most three rounds per scenario; fixes between rounds were made in proofline (see
`docs/decisions.md` A30–A39), never in the fixtures or EXPECTED files. A run that never started because the
account's session limit was reached is not counted as a round.

| Scenario | Config | Round 1 | Round 2 | Round 3 | Verdict | What still fails in the last round |
|---|---|---|---|---|---|---|
| TRIVIAL | claude | 37/45 | 32/33 | 33/36 | FAIL | designer dispatched for a copy change (fixed afterwards: class-aware `## UI`); stale ARTIFACT hash after a re-run |
| STANDARD | claude | 40/51 | 29/36 | 30/39 | FAIL | stalled at IMPLEMENTING: a hook rule of the previous round denied commands inside a project under `/tmp` (fixed afterwards) |
| STANDARD.tr | claude | 43/49 | 46/49 | 44/45 | FAIL | gate names translated in the Turkish chat report (TR-2) |
| COMPLEX | claude | 32/44 | 25/44 | 42/57 | FAIL | QA plan contradicts the approved plan after a contract change; lead ran `agent.sh approve` (C-7 wording vs the design); stale hashes after a fix round |
| CRITICAL | claude | 30/36 | 21/35 | 42/53 | FAIL | `single_step: yes` plan accepted by the architect; a copy of the live database was altered before approval; plan reply consumed by a specialist's question |
| TRIVIAL | codex | — | — | 39/43 | FAIL | first Codex run to reach CODE_DONE; reviewer could not create its worktree (fixed afterwards: `.git/worktrees` granted) |
| STANDARD | codex | 30/41 | 28/36 | — | FAIL | reviewers BLOCKED on the worktree (fixed); then the Codex usage limit ended the run at IMPLEMENTED |
| STANDARD.tr, COMPLEX, CRITICAL | codex | — | — | — | not tested | Codex usage limit |
| all five | mixed (Claude lead + Codex worker) | — | — | — | not tested | Codex usage limit |
| FAILOVER | claude → codex | — | — | — | not tested | Codex usage limit; also the isolated HOME of the harness made the Claude failover "not logged in" |

No end-to-end scenario passes. The structural causes of the first round (results not recorded because a model
typed a machine format by hand) are gone: every Claude run recorded its results through `agent.sh submit`. The
remaining failures are listed in the last column; fixes made after a scenario's third round are covered by
self-tests (selftest 11/11, skill tests 462/462, fixtures 32/32) but not by an end-to-end run.

### Skills run on their own fixtures with a model (2026-10-12)

Each skill was run by a separate model session that never saw its EXPECTED file; an independent evaluator then
compared. `data-design` 16/16, `verify-proof` 11/11, `tdd-proof` 10/10 pass. `proofline-lead` 16/18 (the fix-round
dispatch could not run because the runner session had no implementer subagent), `plan-contract` 16/17 (the runner
skipped the closing approval question), `exploit-proof` 11/12 (REPORT.md does not state that a SECURITY finding is
not waivable). Inconsistencies the runs exposed: the tdd-proof validator allows one cycle per path while the
skill asks for one behaviour per cycle; the verify-proof fixture's `PLAN.md` carries a `task:` line the plan
validator rejects.

## Results for 0.0.1 (2026-10-09), superseded

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
