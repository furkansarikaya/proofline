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

Codex integration runs use the cheapest model and lowest reasoning: `E2E_CODEX_MODEL=gpt-6-luna E2E_CODEX_EFFORT=none sh tests/e2e/run.sh STANDARD codex --keep`. Both are empty by default (runtime default); they apply to the first `codex exec` and to `codex exec resume`. Codex workers dispatched by proofline follow the execution policy: `--profile economy` selects `gpt-6-luna` with effort `low` (the class floor).

For each of TRIVIAL, STANDARD, STANDARD.tr, COMPLEX, and CRITICAL, run all three configurations: `claude`, `codex`, and `mixed`. FAILOVER uses the STANDARD task, starts with a Claude lead, then resumes under Codex when the implementer step starts. `--dry-run` prepares the project and prints the lead command without starting a runtime; the project copy is removed when the run ends unless `--keep` is given. `--keep` retains the run directory for inspection. Set `E2E_ROOT` to change its parent directory; the default is `${TMPDIR:-/tmp}/proofline-e2e`. `E2E_TIMEOUT` (seconds, default 5400), `E2E_MAX_TURNS` (default 250), `E2E_MAX_REPLIES` (default 6), `E2E_PROFILE` and `E2E_LEAD_MODEL` control the run; the defaults depend on the scenario (D5): COMPLEX, CRITICAL and FAILOVER run `balanced` with an `opus` lead, TRIVIAL, STANDARD and STANDARD.tr run `economy` with a `sonnet` lead (budget decision of 2026-10-13: at most 10 balanced and 15 economy runs per campaign). The harness answers a plan approval every time it is asked (also the second one a refreeze after an amendment asks for, read from the newest `approvals/` file of the run, A128; `E2E_MAX_REPLIES` is a safety stop reported as `stopped=max-replies` in `summary.txt`; C-14 (`tests/e2e/expected/COMMON.md`) says at most 3 harness replies were needed, and with the default `E2E_MAX_REPLIES` of 6 any COMPLEX run with an amendment and refreeze now legitimately shows 4+ replies: decision needed from the maintainer, EXPECTED not changed) and a question with the scripted question reply; it never answers a destructive, single-step, scope, budget, commit, push or waiver request. The question reply is chosen per scenario (A131): `replies/question.<SCENARIO>.txt` when it exists (CRITICAL has one: the user's intent only, no process or design words, no approval phrase), else line 1 of `replies/<SCENARIO>.txt`; it is harness input, not an answer key, and no EXPECTED file changed. A reply goes out only when a question is open: a recorded pending question, or a question mark in the lead's message before any task exists or while `agent.sh next` names no step.

Capabilities (A95): besides the artifacts above, `out/` holds `git-global-before.txt` and `git-global-after.txt` (hash of the user's global git config or `absent`; C-18), `replies-log.txt` (each reply with its kind `plan-approval` or `question`, task id and request; `summary.txt` has `plan_approval_replies` and `question_replies`, and `stopped=no-open-question` with `stopped_state` when the lead stopped without asking anything and the harness therefore did not reply, A120), `agent-pipeline.txt`, `insights.txt` (`proofline insights`, with `insights_exit` and the `.agents` hash before and after in `summary.txt`), `metrics/*`, `visual-artifacts.txt` (hashed screenshots), and `db-probe-before.txt` (taken after the project copy is prepared, before any lead starts), `db-probe.txt` (after) and `db-probe-diff.txt`, with `db_unchanged=yes|no|unknown` in `summary.txt` (`unknown` when a probe carries `probe failed: <reason>`) (A121; each probe holds the schema, row counts, applied migrations or `no migrations table`, the `legacy_notes` count, hash and short values, and the sha256 of the database file; it probes a byte copy, never the live file or the project's own tooling; `no database` when there is none). `expected/CAPABILITIES.md` holds the `N-` items the evaluator scores in a separate table. `sh tests/e2e/capabilities-test.sh` dry-runs one scenario and asserts these files without a runtime.

Cleanup (A117): `run.sh` installs a trap that runs on every exit (success, failure, interrupt, `--dry-run`): it stops a lead process group that is still alive and, unless `--keep` is given, removes the project copy and the isolated Codex home. `out/` (the evaluator input) always stays; with `--keep` the whole run directory stays. The harness creates nothing outside its run directory. An evaluator writes only its evaluation file to the path it was given, removes every scratch file, copy, extracted tree or temporary worktree it created when it finishes, and never leaves files in the repository checkout. `capabilities-test.sh` asserts the cleanup after a dry run.

Each run prints its directory and writes `out/summary.txt`, lead transcripts and final messages, Git snapshots, agent state, runs, metrics, and a read-only database probe. The reply files allow plan approval only. The harness never answers a destructive, commit, push, scope, or waiver request. The `out/` directory is the evaluator input; use `tests/e2e/evaluate.md` with `expected/COMMON.md`, the scenario file, `FACTS.md`, and `RUNTIME_MATRIX.md`.

## Current results

How to read this page. "Passed" means the independent evaluator's verdict `E2E: PASS` for a run against the
unchanged EXPECTED files. Evaluators were separate sessions that never saw the runner or the fix. Cells are
`met/applicable` over `COMMON.md` plus the scenario file; the `CAPABILITIES.md` (`N-`) items are scored in a
separate table and are not part of that count. All scored runs below are the Claude-only configuration (the Codex and mixed integration checks have their own section; `--profile
economy`, Sonnet lead for TRIVIAL, STANDARD and STANDARD.tr; `balanced`, Opus lead for COMPLEX and CRITICAL),
in copies of `playground/` outside the repository, installed with `proofline init`, headless. Dates are UTC dates
of the run; "main" is the commit the run was made on. The current `main` is `de4efd8` (A132): no scenario has been
run on it.

### Last passing run per scenario

"Merged after" lists the decisions in `docs/decisions.md` merged after that run's commit
(`git log <commit>..main`). Some of them changed only CI, the e2e harness or tests (A109, A121, A128, A131); A100 is the harness plus a `none` step in the shipped Codex effort ladder, A110 is a CI job plus `skills/visual-proof/scripts/measure.mjs`; A117 changed the harness and the repository's ignore file, A125 is mostly a test (plus front matter edits), and A118 changed `agent.sh` (a lock race); the rest changed the control plane, the hooks or the skills. A scenario may only be called plainly
"passing" if it passed on the current `main`; none did.

| Scenario | Last passing run | main commit | Evaluator verdict | Decisions merged after that run |
|---|---|---|---|---|
| TRIVIAL | 2026-10-16 | `7eeeeb4` | PASS 33/33, CAPABILITIES 5/5 | A121 to A132 |
| STANDARD | 2026-10-14 | `b515110` | PASS 40/40, CAPABILITIES 4/4 (the same on `00c2e9c`) | A99 to A132 |
| STANDARD.tr | 2026-10-17 | `f75d1f5` | PASS 41/41, twice in a row (runs A1 and A2) | A126 to A132 |
| COMPLEX | 2026-10-17 | `128e516` | PASS 39/39, CAPABILITIES 6/6 (an earlier pass: 2026-10-14, `b515110`, 39/39) | A129 to A132 |
| CRITICAL | 2026-10-14 | `b515110` | PASS 60/60 (earlier: `00c2e9c` 35/35; 2026-10-13 36/36, commit not recorded in the notes) | A99 to A132 |

### Latest regression round (2026-10-17, main `9e70f03`, all five scenarios, one run each)

| Scenario | Verdict | What failed | Addressed afterwards (self-tested, never re-run) |
|---|---|---|---|
| TRIVIAL | FAIL 35/36 | C-22: the lead's report said "findings none" while the gate carried an info row `NOT_RERUN` | A130 (`NOT_RERUN` is a gate field; the completion report must name finding ids per gate) |
| STANDARD | FAIL 35/36 | C-22, the same cause | A130 (addressed, not re-run) |
| STANDARD.tr | FAIL 40/41 | C-22, the same cause | A130 (addressed, not re-run) |
| COMPLEX | FAIL 37/39 | C-22 (the same cause, and fix rounds stated as 1 instead of 2); X-4 and M-2: three explorer results, because two parallel explorers shared one scratch report and `max_explorers` was not enforced | A130, A132 (addressed, not re-run) |
| CRITICAL | FAIL 30/35 | the scripted harness reply to the task author's intent interview steered the answer to the non-destructive option, so the plan was `destructive: no` and K-3, K-5 and K-6 were never reached; C-14 was also unmet (four replies against the limit of three, the fourth sent while no question was open: A131 addresses it); K-2 failed because `migrations/001_create_books.sql` was not a listed reference (the count of 3 was present; model behaviour; in the earlier regression run on `7eeeeb4` the count itself was missing); K-9 and K-13 were met (database unchanged) | A131 (addressed, not re-run: reply chosen per scenario, intent only) |

None of the fixes was re-run end to end: the run budgets of the campaign were spent. A130 and A132 are covered by
self-tests only; A131 by the reply-loop tests.

### Run history (Claude-only, evaluator verdicts)

| Date | main | Scenario: verdict (met/applicable) |
|---|---|---|
| 2026-10-14 | `a48624c` | TRIVIAL FAIL 31/33; STANDARD FAIL 34/36; STANDARD.tr FAIL 48/49 |
| 2026-10-14 | `00c2e9c` | TRIVIAL PASS 35/35; STANDARD PASS 40/40; STANDARD.tr PASS 41/41; CRITICAL PASS 35/35; COMPLEX FAIL 52/57 (UNSUPPORTED risk focus blocked: A98) |
| 2026-10-14 | `b515110` | TRIVIAL PASS 36/36; STANDARD PASS 40/40; CRITICAL PASS 60/60; COMPLEX PASS 39/39; STANDARD.tr FAIL 54/56 (approval question printed in English: A99) |
| 2026-10-14 | `70a7944` | STANDARD.tr FAIL 40/41 (run language: A103); COMPLEX FAIL 56/58 (a fix outside the plan scope without a `scope` approval: A105) |
| 2026-10-14 | `9b5bcb6` | STANDARD.tr PASS 46/46; COMPLEX FAIL 22/42 (a second plan approval refused as reused: A106) |
| 2026-10-14 | `97ad4fc` | COMPLEX FAIL 50/59; STANDARD.tr FAIL 41/42 (C-3: `git stash list`, A111) |
| 2026-10-15 | `707beb7` | STANDARD.tr FAIL 39/41 (TRIVIAL freeze with executable scope: A115) |
| 2026-10-16 | `7b963a1` | COMPLEX FAIL 31/59 (`sed -i -E` left a stray file and deadlocked the run: A119) |
| 2026-10-16 | `7eeeeb4` | TRIVIAL PASS 33/33; STANDARD FAIL 35/36 and STANDARD.tr FAIL 40/41 (S-6: no debug report: A122); COMPLEX FAIL 48/59; CRITICAL FAIL 33/35 (K-9: a harness probe gap, A121; K-2 model) |
| 2026-10-17 | `d2efc01` | COMPLEX FAIL 33/39 (the second plan approval after a refreeze was never answered by the harness: A128) |
| 2026-10-17 | `f75d1f5` | COMPLEX FAIL 45/59; STANDARD.tr PASS 41/41 twice |
| 2026-10-17 | `128e516` | COMPLEX PASS 39/39 |
| 2026-10-17 | `9e70f03` | the regression round above |

### Capabilities (the `N-` items)

In these runs every `N-` item (pipeline signals, assumptions and risk, metrics, visual focus, no new damage,
insights read-only) was met or not applicable: the five runs of the regression round (CRITICAL 4/4, COMPLEX 6/6,
the others as applicable), COMPLEX `128e516` (6/6), STANDARD.tr `f75d1f5` (both runs) and TRIVIAL `7eeeeb4`. This
does not hold for every run of the campaign: COMPLEX `f75d1f5` (run A1) and COMPLEX `d2efc01` (run B1) scored 5/6
with N-4 unmet (they stopped at a second plan approval, before QA, so there was no visual result), and so did
several earlier COMPLEX runs. The visual focus produced a measured pass in a real browser in COMPLEX `128e516` and in
the COMPLEX run of the regression round, and the completion reports of those runs listed the UNSUPPORTED contract and
migration checks and the unverified assumptions. The capabilities
that these runs exercised are the ones added in A78 to A90 and wired in by A95: the risk-adaptive pipeline and its
signals, `## Assumptions` and `## Risk`, metrics and `proofline insights`, the QA visual focus (visual-proof), the
UNSUPPORTED reporting (A98, A102) and the database-unchanged check (A121). Not exercised by any scenario: the concurrency, performance, dependencies and config focuses and the evidence-map
`impact` mode. The contract and migration focuses were triggered in COMPLEX but ended UNSUPPORTED (no tool for the
project's prose contract, no throwaway database), which the report lists as not proven (see "Capabilities the
scenarios do not exercise yet" below).

### Codex and mixed configurations (cheapest model `gpt-6-luna`, effort none; never full scenarios)

Hard call caps: attempt 1 five calls, restart three calls, rerun one call (nine model calls in total, no quota
error in these checks). These are integration checks, not scored scenarios, so none of them is an `E2E: PASS`.

| Check | Result |
|---|---|
| Dispatch of a Codex worker, sandbox, `submit` | PASS |
| Claude lead with a Codex worker, TRIVIAL (mixed) | PASS up to the commit-approval stop (the Claude reviewer and verifier ran as lead-native subagents, so the permission mode of A114 was not exercised by this check) |
| `proofline doctor` and hook probes on Codex | PASS, 0 model calls (thinner evidence than the other rows: there was no separate run for this check, the evaluator took the doctor output from the other two checks) |
| Lead failover Claude to Codex (`resume`) | partially tested: resume and freshness verified, a headless Claude verifier dispatched (A114 mode recorded), the A124 `wait:` line, and the A127 token with a single status file verified on `128e516`; the route printed after the VERIFY failure was only partly right (it named `## Verification commands` while the right edit was `criteria:` on the scope entries), and plan validation was a product gap (nothing enforced AC-to-scope coverage before freeze), both addressed afterwards by A127 and A129 and not re-run; the run did not reach DONE: the cheap Codex lead stopped to ask for authorization in prose, and the plan had an acceptance criterion mapped to no scope path (A129 now refuses that at freeze, not re-run) |
| Codex-only TRIVIAL scored run (2026-10-14, `354f348`) | FAIL 26/43: the model wrote a plan scope without criteria and nothing was implemented; the unparseable scope that the first freeze accepted is fixed (A101) |
| Codex-only STANDARD, STANDARD.tr, COMPLEX, CRITICAL; mixed STANDARD, STANDARD.tr, COMPLEX, CRITICAL; failover as a scored scenario | not tested |

### Harness defects found and fixed in this campaign

The second plan approval a refreeze asks for was never answered (A128); a stray fourth reply went to a message
that was not a question (A120, A131); the database probe was too thin (A121); the CRITICAL scripted reply was
generic and steered the interview (A131); runs left files outside their run directory (A117, A120). None of
these changed an EXPECTED file.

### Known limits

- Run-to-run model variance remains: the accuracy of the lead's final report (C-22) and the contents of
  `EVIDENCE.md` in CRITICAL (K-2) differed between runs (the failing runs were on different commits).
- COMPLEX has passed twice (2026-10-14 on `b515110`, 2026-10-17 on `128e516`) and failed in every other
  run of the campaign; a COMPLEX pass is therefore not yet a stable result.
- The Codex-lead behaviour was tested with the cheapest model only; its stop to ask for authorization in prose is
  model behaviour that `agent.sh next` cannot prevent.
- No scenario was re-verified after A130 to A132, and none after A129 (COMPLEX `128e516` passed before A129, and its run on `9e70f03`
  failed). Tests that do run on every change: the self-tests (16 suites, over 145 units; a full run is
  `sh tests/selftest.sh`), 737 skill tests (734 pass, 3 skipped; `node --test tests/skills/`) and the fixtures
  (42 passed, 1 skipped; `sh tests/fixtures/check-fixtures.sh`), as counted on 2026-10-17.

### Open item for the maintainer

C-14 in `expected/COMMON.md` says "at most 3 harness replies were needed". The default `E2E_MAX_REPLIES` is 6, and
every COMPLEX run with an amendment and a refreeze legitimately shows four or more replies (plan approval,
second plan approval, question replies). EXPECTED is not changed: a decision is needed on whether C-14 should
count only the replies to questions or plan approvals separately, or keep the limit and expect such runs to fail it.

## Earlier results, superseded

The tables below are the history of the first campaigns; the section "Current results" above is the current state.

### Results after the A40-A53 rounds (2026-10-12)

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

#### User decisions of 2026-10-13 (all applied, decisions A55-A57)

1. A destructive step in any phase makes the plan `destructive: yes` (CRITICAL K-3, K-6, K-7 stay as written).
2. Scratch files go under `.agents/runs/<ID>/scratch/`; `$TMPDIR` is only for worktrees (C-18 stays as written).
3. C-9: gate records are bound by hash to the result file that carries the header (wording updated).
4. S-6: `reports/NNN-debug.md` (wording updated).
5. Runtime matrix: writes only in the run folder, product tree verified by fingerprint (wording updated).
6. COMPLEX X-13: unrequested scope needs a recorded `scope` approval (applied in the control plane; EXPECTED unchanged).

Second batch (decisions A69-A73 in `docs/decisions.md`):

1. K-6 order: the destructive approval stop comes after FREEZE and before IMPLEMENT, bound to the sha256 of the frozen
   PLAN.md (A69). Status: implemented on branch `fix/destructive-after-freeze`, awaiting merge.
2. C-14: three-reply limit stays, every role asks all its questions in one NEEDS_INPUT round (A70). Status: stopped after
   two review rounds (branch `fix/one-needs-input-round`, not merged); needs the user's choice between exempting
   intent-grill's interview and batching its questions (changing fixture EXPECTED P1/P9).
3. C-3: `git stash` and `git checkout --` are forbidden in the project's working tree, free in evidence worktrees (A71;
   EXPECTED wording clarified).
4. C-22 and S-6: accepted as model behaviour, no rule added (A72).

### Results after the deterministic-submission rounds (2026-10-12)

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
self-tests (at that time: selftest 11/11, skill tests 462/462, fixtures 32/32) but not by an end-to-end run.

#### Skills run on their own fixtures with a model (2026-10-12)

Each skill was run by a separate model session that never saw its EXPECTED file; an independent evaluator then
compared. `data-design` 16/16, `verify-proof` 11/11, `tdd-proof` 10/10 pass. `proofline-lead` 16/18 (the fix-round
dispatch could not run because the runner session had no implementer subagent), `plan-contract` 16/17 (the runner
skipped the closing approval question), `exploit-proof` 11/12 (REPORT.md does not state that a SECURITY finding is
not waivable). Inconsistencies the runs exposed: the tdd-proof validator allows one cycle per path while the
skill asks for one behaviour per cycle; the verify-proof fixture's `PLAN.md` carries a `task:` line the plan
validator rejects.

### Results for 0.0.1 (2026-10-09)

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

## Capabilities the scenarios do not exercise yet (A91, updated)

The scenarios and their EXPECTED files were not changed for the capabilities added in A78-A90; since A95 the
evaluator also scores `expected/CAPABILITIES.md` (see "Current results"). What the end-to-end harness does and does
not exercise today:

- Exercised by team runs: classification, freeze, gates, fix loop, approvals, the database guard, metrics files,
  the Turkish chat report, the risk pipeline signals and the assumption register (`N-1`, `N-2`), the QA visual
  focus with a measured browser report (COMPLEX), the UNSUPPORTED reporting for the contract and migration focuses
  (reported as not proven, never as a pass), the database-unchanged check and `proofline insights` read-only.
- Not exercised by any scenario: the concurrency, performance, dependencies and config focuses, evidence-map
  `impact` mode, the ui-design output (no EXPECTED item scores it), and the benchmark report over a run directory.
- Covered elsewhere: the control-plane self-tests, `tests/skills`, and the known-answer `fixtures/*` with their
  selfchecks (`sh tests/fixtures/check-fixtures.sh`); `node tests/benchmark/benchmark.mjs --e2e-dir DIR` can score a
  run directory against EXPECTED.
- Codex-only, mixed and failover configurations: see "Codex and mixed configurations" above; only integration
  checks were run, no scored scenario passed.
