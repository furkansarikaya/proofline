# End-to-end team runs

The harness copies `playground/` into a timestamped directory outside this repository, creates two local baseline commits with Git plumbing, installs proofline, and records a doctor report. Expected files stay in this repository and are never copied into the project. A separate evaluator reads `evaluate.md` and the expected files after the run.

Requires Node.js 22.13 or newer, Git, and the runtime CLIs used by the chosen configuration. The runner starts the lead in its own process group (a new session). No dependencies are installed.

## Commands

```sh
node tests/e2e/run.mjs TRIVIAL claude --dry-run
node tests/e2e/run.mjs TRIVIAL claude --keep
node tests/e2e/run.mjs STANDARD codex --keep
node tests/e2e/run.mjs STANDARD.tr mixed --keep
node tests/e2e/run.mjs COMPLEX mixed --keep
node tests/e2e/run.mjs CRITICAL claude --keep
node tests/e2e/run.mjs FAILOVER mixed --keep
```

Codex integration runs use the base model for the lead and may keep cheap workers (A135, amends A100): `E2E_CODEX_MODEL=gpt-6-sol E2E_CODEX_EFFORT=none node tests/e2e/run.mjs STANDARD codex --keep`. Both are empty by default (runtime default); they apply to the first `codex exec` and to `codex exec resume`. The harness refuses a Codex lead (codex config, FAILOVER resume) whose `E2E_CODEX_MODEL` is below `execution_policy.lead_base_model.codex` in `control-plane/agents/config.yaml` (`gpt-6-sol`; `E2E_CODEX_MODEL=gpt-6-luna` exits 2 and names it). Codex workers dispatched by proofline follow the execution policy: `--profile economy` selects `gpt-6-luna` for the cheap worker roles (explorer, task_author, verifier) with effort `low`; the economy lead is `gpt-6-sol`.

For each of TRIVIAL, STANDARD, STANDARD.tr, COMPLEX, and CRITICAL, run all three configurations: `claude`, `codex`, and `mixed`. FAILOVER uses the STANDARD task, starts with a Claude lead, then resumes under Codex when the implementer step starts. `--dry-run` prepares the project and prints the lead command without starting a runtime; the project copy is removed when the run ends unless `--keep` is given. `--keep` retains the run directory for inspection. FAILOVER copies the state at the kill (`.agents/runs/`, `git status --porcelain`, the working diff and the branch list) to `out/at-kill/` before the Codex lead starts (a copy that fails leaves `copy-error.txt` there), reads the ledger every `E2E_FAILOVER_POLL_S` seconds (default 10; a fraction such as 0.05 is accepted, `E2E_SKIP_DOCTOR=1` skips the `proofline doctor` call and writes a note into `doctor.txt`: both are for the harness self-tests), and removes the `CLAUDE_CODE*` variables from the Codex lead's environment. Its project copy gets `tests/e2e/overlays/failover-helpers.js` as `tests/helpers.js`: a Codex worker runs in a permission profile without network, which refuses the loopback listener the playground's `startTestServer` opens, so the helper answers `fetch(server.baseUrl + path)` in process (same interface; every other scenario keeps the playground helper). It answers `fetch(server.baseUrl + path)` only: a response has no `content-length` header, a test that uses `node:http` or `server.address()` directly fails, and servers must be closed in reverse order of start. COMPLEX: the scenario project sets `test_trust.mutation_budget` to 30 in its own `.agents/config.yaml` (after `proofline init`, before the install baseline) so the plan's 21 criteria do not stop at a mutation-budget approval the harness never gives; the value is the project's own setting, no other scenario gets it, and the harness still never answers a `mutation_budget` request. Set `E2E_ROOT` to change its parent directory; the default is `${TMPDIR:-/tmp}/proofline-e2e`. `E2E_TIMEOUT` (seconds, default 5400), `E2E_MAX_TURNS` (default 250), `E2E_MAX_REPLIES` (default 3, plus one for every refreeze, under a hard cap of 12), `E2E_PROFILE` and `E2E_LEAD_MODEL` control the run; the defaults depend on the scenario (D5): COMPLEX, CRITICAL and FAILOVER run `balanced` with an `opus` lead, TRIVIAL, STANDARD and STANDARD.tr run `economy` with a `sonnet` lead (budget decision of 2026-10-13: at most 10 balanced and 15 economy runs per campaign). The harness answers a plan approval every time it is asked (also the second one a refreeze after an amendment asks for, A128). A refreeze raises a `plan` and a `scope` request together: exactly that pair gets ONE reply that approves the plan only (line 3 of `replies/<SCENARIO>.txt`, `approve plan`); the scope request stays unanswered (X-13: the harness never gives a scope approval, so a run that cannot go on without one ends at that stop), the open requests being read from the whole `approvals/` folder; a `scope` request alone, and every destructive, single-step, budget, commit, push or waiver request, is never answered. The reply allowance is C-14: `E2E_MAX_REPLIES` (default 3) plus one for every refreeze (a new plan hash asked for approval), never above 12; the cap is reported as `stopped=max-replies`, and the same stop twice as `stopped=repeated-stop` (`summary.txt` also has `refreeze_approval_replies` and `reply_budget`). A question gets the next line of the scripted question reply, one line per question stop, the last line repeating: `replies/question.<SCENARIO>.txt` when it exists (A131; CRITICAL has one, line 1 the user's intent, line 2 a blanket for the other questions: no process or design words, no approval phrase; COMPLEX has one too (A334): line 1 a standing answer for every open question and every later one of the interview, so a four-batch interview does not spend the allowance, repeated for every later question stop; the plan and refreeze lines stay lines 2 and 3 of `COMPLEX.txt`), else line 1 of `replies/<SCENARIO>.txt`; it is harness input, not an answer key, and no EXPECTED file changed. A reply goes out only when a question is open: a recorded pending question, or a question mark in the lead's message before any task exists or while `agent.sh next` names no step.

Capabilities (A95): besides the artifacts above, `out/` holds `git-global-before.txt` and `git-global-after.txt` (hash of the user's global git config or `absent`; C-18), `replies-log.txt` (each reply with its kind `plan-approval`, `refreeze-approval`, `question` or `listed-approval`, task id and request; `summary.txt` has `plan_approval_replies`, `question_replies` and `listed_approval_replies`, and `stopped=no-open-question` with `stopped_state` when the lead stopped without asking anything and the harness therefore did not reply, A120), `agent-pipeline.txt`, `insights.txt` (`proofline insights`, with `insights_exit` and the `.agents` hash before and after in `summary.txt`), `metrics/*`, `visual-artifacts.txt` (hashed screenshots), and `db-probe-before.txt` (taken after the project copy is prepared, before any lead starts), `db-probe.txt` (after) and `db-probe-diff.txt`, with `db_unchanged=yes|no|unknown` in `summary.txt` (`unknown` when a probe carries `probe failed: <reason>`) (A121; each probe holds the schema, row counts, applied migrations or `no migrations table`, the `legacy_notes` count, hash and short values, and the sha256 of the database file; it probes a byte copy, never the live file or the project's own tooling; `no database` when there is none). `expected/CAPABILITIES.md` holds the `N-` items the evaluator scores in a separate table. `node --test tests/e2e/capabilities.test.mjs` (with `pending-kind.test.mjs` and `reply-loop.test.mjs`; `E2E_RUNNER` runs them against another runner) dry-runs one scenario and asserts these files without a runtime.

Cleanup (A117): `run.mjs` installs a trap that runs on every exit (success, failure, interrupt, `--dry-run`): it stops a lead process group that is still alive and, unless `--keep` is given, removes the project copy and the isolated Codex home. `out/` (the evaluator input) always stays; with `--keep` the whole run directory stays. The harness creates nothing outside its run directory. An evaluator writes only its evaluation file to the path it was given, removes every scratch file, copy, extracted tree or temporary worktree it created when it finishes, and never leaves files in the repository checkout. `capabilities.test.mjs` asserts the cleanup after a dry run.

Each run prints its directory and writes `out/summary.txt`, lead transcripts and final messages, Git snapshots, agent state, runs, metrics, and a read-only database probe. The reply files allow plan approval only. The harness has no privileged path for any other approval and never answers a commit, push, delivery, waiver, secrets or security request. A scenario may send a scope, destructive, mutation-budget or assumption-acceptance message only as a user message that its `replies/approvals.<SCENARIO>.txt` lists in advance (see "Listed approvals"); with no such file the harness answers none of them. The `out/` directory is the evaluator input; use `tests/e2e/evaluate.md` with `expected/COMMON.md`, the scenario file, `FACTS.md`, and `RUNTIME_MATRIX.md`.

## Current results

How to read this page. "Passed" means the independent evaluator's verdict `E2E: PASS` for a run against the
unchanged EXPECTED files. Evaluators were separate sessions that never saw the runner or the fix. Cells are
`met/applicable` over `COMMON.md` plus the scenario file; the `CAPABILITIES.md` (`N-`) items are scored in a
separate table and are not part of that count. All scored runs below are the Claude-only configuration (the Codex and mixed integration checks have their own section; `--profile
economy`, Sonnet lead for TRIVIAL, STANDARD and STANDARD.tr; `balanced`, Opus lead for COMPLEX and CRITICAL),
in copies of `playground/` outside the repository, installed with `proofline init`, headless. Dates are UTC dates
of the run; "main" is the commit the run was made on. The newest campaign (2026-11-16 and 2026-11-17, section "The
campaign on main 6830eae6 and its re-runs") ran on `6830eae6` (0.0.141) and, for the re-runs, on `87dd66a0`, `773f00d6`,
`8a2cbea5` and `8f84d850`. The section "The final pass on main 900c2852" holds the run of all six scenarios on `900c2852` (0.0.151). The current `main` is `98f49400` (0.0.164): the section "The closing campaign on main (2026-11-18)" below holds the COMPLEX and STANDARD runs of 2026-11-18 on commits from `2cdd6746` to `98f49400`. A339 (0.0.165) came after these runs and touches only the Windows path comparison of the scratch-worktree removal, no POSIX behaviour. On `98f49400` one COMPLEX run reached DONE (FAIL 37/38, C-22 only) and one STANDARD run reached DONE (FAIL 36/37, S-6 only); there is still no E2E PASS for either scenario, and the other four scenarios were not run again after `900c2852`.

### Last passing run per scenario

"Merged after" lists the decisions in `docs/decisions.md` merged after that run's commit
(`git log <commit>..main`). Some of them changed only CI, the e2e harness or tests (A109, A121, A128, A131); A100 is the harness plus a `none` step in the shipped Codex effort ladder, A110 is a CI job plus `skills/visual-proof/scripts/measure.mjs`; A117 changed the harness and the repository's ignore file, A125 is mostly a test (plus front matter edits), and A118 changed `agent.sh` (a lock race); the rest changed the control plane, the hooks or the skills. A scenario may only be called plainly
"passing" if it passed on the current `main` every time it was run there; none did (TRIVIAL passed once and failed once on `900c2852`).

| Scenario | Last passing run | main commit | Evaluator verdict | Decisions merged after that run |
|---|---|---|---|---|
| TRIVIAL | 2026-11-17 (second run) | `900c2852` (0.0.151) | PASS 33/33, CAPABILITIES 5/5; the first run on the same commit scored FAIL 14/30 (a model sample, A324.2); the earlier pass: 2026-10-16, `7eeeeb4`, 33/33 | none (A324 is docs only) |
| STANDARD | 2026-11-16 | `6830eae6` (0.0.141) | PASS 37/37, CAPABILITIES 4/4, scored against the expectations as corrected by A310; the same run scored FAIL 31/36 against the old ones (earlier pass: 2026-10-14, `b515110`, PASS 40/40) | A311 to A323 |
| STANDARD.tr | 2026-10-17 | `f75d1f5` | PASS 41/41, twice in a row (runs A1 and A2) | A126 to A323 |
| COMPLEX | 2026-10-17 | `128e516` | PASS 39/39, CAPABILITIES 6/6 (an earlier pass: 2026-10-14, `b515110`, 39/39) | A129 to A323 |
| CRITICAL | 2026-10-14 | `b515110` | PASS 60/60 (earlier: `00c2e9c` 35/35; 2026-10-13 36/36, commit not recorded in the notes) | A99 to A323 |
| FAILOVER (mixed) | none | none | FAIL 37/47 on `6830eae6`; FAIL 40/48 (41/48 with F-3 as corrected by A321) on `773f00d6`, capabilities 4/5 | not applicable |

On 900c2852 none of STANDARD (run 2 FAIL 36/37), STANDARD.tr (FAIL 43/44), CRITICAL (FAIL 31/34), COMPLEX (FAIL 30/37) and FAILOVER (invariant 48/48, quality 0/1, FAIL) passed fully (see the final-pass section below); TRIVIAL run 2 passed.

### The campaign on main 6830eae6 and its re-runs (2026-11-16 and 2026-11-17)

One run of each scenario on `6830eae6` (0.0.141), then re-runs after fixes, all by the independent evaluator against the expectations in this repository. Claude-only runs (economy, Sonnet lead for TRIVIAL, STANDARD and STANDARD.tr; balanced, Opus lead for COMPLEX and CRITICAL), except FAILOVER (mixed: a Claude lead, stopped mid-IMPLEMENT, resumed by a Codex lead). The verdict lines are the evaluator's own; "class" is the evaluator's classification of the unmet items (PRODUCT, MODEL, HARNESS). Every run directory is under `$TMPDIR/proofline-e2e/` on the maintainer's machine, named `<SCENARIO>-<config>-<UTC timestamp>`; they are not in the repository. Nothing here was run on the current `main`.

| Run | main (version) | Verdict line | Capabilities | Unmet items and class | Fix or accepted limit |
|---|---|---|---|---|---|
| TRIVIAL | `6830eae6` (0.0.141) | `E2E: FAIL (invariant 32/33, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 5/5, quality 0/0 = 100%)` | C-22: MODEL (the final message said the review result was reused, the ledger shows a new reviewer) | accepted, A322.3 |
| STANDARD, expectations before A310 | `6830eae6` | `E2E: FAIL (invariant 31/36, quality 0/0 = 100%)` | `CAPABILITIES: FAIL (invariant 3/4, quality 0/0 = 100%)` | C-6, C-15, S-8, S-10, S-12, N-5: MODEL with a PRODUCT contributor (the lead wrote `docs/design/API.md` in the knowledge step after CODE_DONE; the product allowed it, the expectations forbade every write outside the plan scope) | A310 (expectations account for the knowledge step) |
| STANDARD, the same run, expectations after A310 | `6830eae6` | `E2E: PASS (invariant 37/37, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | none | n/a |
| STANDARD.tr, first | `6830eae6` | `E2E: FAIL (invariant 39/43, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | C-20, TR-3, TR-7: PRODUCT (the shipped completion-report template said the `Changed:` line is in the user's language, the expectations demand English files); S-6: MODEL (a model-level expectation: the guard of A200/A202 fires only for `type: bug`, a defect label or a `decision: fix` entry) | PR #305, A312 (0.0.143); S-6 accepted, A322.1 |
| STANDARD.tr, re-run | `87dd66a0` (0.0.143) | `E2E: FAIL (invariant 42/43, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | S-6: MODEL, a model-level expectation (the guard fires only for `type: bug`, a label or a `decision: fix` entry, A200/A202) (no `reports/NNN-debug.md`); the report check of PR #305 accepted an English report on the first call | accepted, A322.1 |
| CRITICAL, first | `6830eae6` | `E2E: FAIL (invariant 23/34, quality 0/1 = 0%)` | `CAPABILITIES: FAIL (invariant 2/4, quality 0/0 = 100%)` | C-1, C-2, C-4, C-11, C-14, K-1 to K-6, K-10, N-2, N-3: HARNESS (the scripted interview reply was sent six times and answered one question; no task, run or plan existed) | PR #306, A313 (0.0.144) |
| CRITICAL, re-run | `773f00d6` (0.0.148) | `E2E: FAIL (invariant 33/34, quality 1/1 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | K-2: MODEL (`EVIDENCE.md` does not say that the 3 existing rows hold `legacy_notes` data); the run ended at the destructive-approval request, the designed stop | accepted, A322.2 |
| FAILOVER, first | `6830eae6` | `E2E: FAIL (invariant 37/47, quality 0/1 = 0%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | C-5, C-10, C-19, F-6, F-8: HARNESS (the Codex worker profile refused the loopback listener the tests need, the run ended BLOCKED); F-1: HARNESS (no `out/at-kill/`); F-3: classed PRODUCT by this evaluation, SPEC OUTDATED by the next; F-9: MODEL | PR #310, A317 (0.0.148); A321; A322.6 |
| FAILOVER, re-run | `773f00d6` (0.0.148) | `E2E: FAIL (invariant 40/48, quality 0/1 = 0%)`; 41/48 with F-3 as corrected | `CAPABILITIES: FAIL (invariant 4/5, quality 0/0 = 100%)` | reached CODE_DONE and DONE with all 7 gates and 17 of 17 tests. C-6, C-15, C-23, S-8, S-10, S-12, N-5, F-8: PRODUCT (documentation gap) with a MODEL choice (two knowledge pages); F-3: SPEC OUTDATED; F-9: PRODUCT gap (no source for the lead runtime per phase) | A321; accepted, A322.5, A322.6, A322.7 |
| COMPLEX #1 | `6830eae6` | `E2E: FAIL (invariant 31/37, quality 2/2 = 100%)` | `CAPABILITIES: PASS (invariant 6/6, quality 0/0 = 100%)` | C-5, C-10, X-4, X-10, X-11: HARNESS (the plan and scope requests of a refreeze left unanswered; root causes MODEL: the dot-tag defect found by REVIEW_RULES and the clear-control defect found by QA; PRODUCT: the quoted values `book club` and `sci-fi` read as test names); C-18: MODEL (leftover worktree) | PR #306 A313; PR #309 A316; accepted, A322.4 |
| COMPLEX #2 | `773f00d6` | `E2E: FAIL (invariant 25/37, quality 1/2 = 50%)` | `CAPABILITIES: FAIL (invariant 5/6, quality 0/0 = 100%)` | stopped at PLANNED on a `mutation_budget` request (21 criteria, budget 20): C-5, C-10, C-11, C-19, X-4 to X-12, N-4 all HARNESS | PR #311, A318 (0.0.149) |
| COMPLEX #3 | `8a2cbea5` (0.0.149) | `E2E: FAIL (invariant 32/37, quality 2/2 = 100%)` | `CAPABILITIES: FAIL (invariant 5/6, quality 0/0 = 100%)` | reached IMPLEMENTED with 9 gate records (6 gates; REVIEW_RULES and REVIEW_TESTS failed, QA and VERIFY never ran), then an unanswered `scope` request: C-5, C-10, X-4, X-10, X-11, N-4. Root causes: PRODUCT (the UTF-8 em dash of a plan bullet was not found in the bytes the control plane reads, so the data values `book club` and `sci-fi` were test names again; the superseded GREEN command of F007), MODEL (a listener added inside `load()`; three browser tests listed as `## Tests` without a `measure:` exception) and the scenario (a scope approval is never granted) | PR #312, A319 (0.0.150); accepted, A323.3, A322.8 |
| COMPLEX #4 | `8f84d850` (0.0.150) | `E2E: FAIL (invariant 25/35, quality 1/2 = 50%)` | `CAPABILITIES: FAIL (invariant 5/6, quality 0/0 = 100%)` | stopped in the intent interview before the freeze: the pending question asked for `accept AS-1`, three question replies were spent; MODEL (a checkable assumption rated unverified) with HARNESS (a blanket reply cannot satisfy `accept AS-N`); PRODUCT, minor: the question stayed pending after the lead verified AS-1 | accepted, A322.8 |

What the campaign shows and does not show. STANDARD passes on `6830eae6` only under the expectations of A310, and the fix that made it pass was in the expectations, not in the product. STANDARD.tr, CRITICAL and TRIVIAL each ended one item short on their latest run, and each of those items is a model behaviour recorded as an accepted limit (A322). FAILOVER reached DONE once, with two accepted limits and a spec correction (A321). COMPLEX did not reach DONE in any of the four runs, because the harness cannot give the user-only approvals that run needed at the point where it stopped (A322.8); a complete COMPLEX run is not demonstrated by this campaign (one was shown later, see "The closing campaign on main"). Evaluation note: the file of COMPLEX #4 gives `invariant 25/35` in its verdict line and `26/37` in one sentence of its text; the verdict line is quoted. Accepted limits: [docs/limits.md](../../docs/limits.md).

### The final pass on main 900c2852 (2026-11-17)

After the final records pull request (#314) every scenario was run once more on `900c2852` (0.0.151), and TRIVIAL and STANDARD a second time. No product change was made between the runs. Claude-only runs as above, except FAILOVER (mixed). "Lead" is the `lead_N_duration` in each run's `summary.txt` (seconds; several leads are added with `+`). The verdict lines are copied from the evaluation files; the class (PRODUCT, MODEL, HARNESS) is the evaluator's. Run directories are under `$TMPDIR/proofline-e2e/` on the maintainer's machine and are not in the repository.

| Run (directory) | Lead | Verdict line | Capabilities | Unmet items, class, limit |
|---|---|---|---|---|
| TRIVIAL run 1 (`TRIVIAL-claude-20261117T114356Z`) | 11 s | `E2E: FAIL (invariant 14/30, quality 0/0 = 100%)` | `CAPABILITIES: FAIL (invariant 2/4, quality 0/0 = 100%)` | The lead asked the user to reply "yes" (A169) and nothing ran: C-1, C-2, C-4, C-8, C-9, C-11, C-12, C-14, T-1, T-2, T-3, T-5, T-6, T-7, T-8, T-9 (COMMON and TRIVIAL), all MODEL (C-14 and T-2 with a latent conflict between A169 and T-2); capabilities N-2 and N-3 unmet for the same reason; A324.2 |
| TRIVIAL run 2 (`TRIVIAL-claude-20261117T132824Z`) | 152 s | `E2E: PASS (invariant 33/33, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 5/5, quality 0/0 = 100%)` | none; the lead started directly. Note: "Fix rounds: 1 of 2" with no fix in the ledger (a verifier retry), A324.5 |
| STANDARD run 1 (`STANDARD-claude-20261117T114413Z`) | 499 s | `E2E: FAIL (invariant 29/36, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | C-5, C-10, C-14, S-9, S-11: MODEL cause (GREEN record with durations for 3 of the 5 plan-named tests) with a PRODUCT dead end (detection only at REVIEW_TESTS; `advance` refused an evidence-only repair; the lead asked the user), A324.1; C-18: MODEL (three QA scratch worktrees), A322.4 and A323.4; S-6: MODEL, A322.1 |
| STANDARD run 2 (`STANDARD-claude-20261117T133103Z`) | 817 s | `E2E: FAIL (invariant 36/37, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | S-6 only: MODEL, A322.1. CODE_DONE and DONE, 7 gates passed on the first attempt, one knowledge page |
| STANDARD.tr (`STANDARD.tr-claude-20261117T115239Z`) | 557 s | `E2E: FAIL (invariant 43/44, quality 0/0 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | S-6 only: MODEL, A322.1. DONE, one knowledge paragraph, English `Changed:` line, Turkish final message |
| CRITICAL (`CRITICAL-claude-20261117T120203Z`) | 765 + 24 + 13 + 26 s (four leads) | `E2E: FAIL (invariant 31/34, quality 1/1 = 100%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | K-2: MODEL, A322.2 (third occurrence); K-5, K-6: HARNESS/scenario (the freeze was refused over the unverified high-risk assumption AS-2 and `accept AS-2` is a user-only approval), A322.8; the AS-N question text, A324.3. Replies 3 of 3, all questions; no approval of any kind |
| COMPLEX (`COMPLEX-claude-20261117T121600Z`) | 192 + 806 + 2244 + 29 s (four leads) | `E2E: FAIL (invariant 30/37, quality 2/2 = 100%)` | `CAPABILITIES: FAIL (invariant 5/6, quality 0/0 = 100%)` | Stopped at REVIEW_TESTS (fix round 2 pending) on two waiver requests: C-5, C-10, X-4, X-10, X-11 (PRODUCT A323.3 plus the recovery dead end A324.1, MODEL cause; waivers are user-only, A322.8); C-7: MODEL (the lead tried `agent.sh waive`; the product refused, no waiver exists); X-13: HARNESS/scenario text (`paginate` changed after a NEEDS_INPUT answered with "Use your recommended option"); N-4: no completion report. A product finding: the GREEN recorder rejects a `=` in a test name, A324.4 |
| FAILOVER (`FAILOVER-mixed-20261117T131042Z`) | 241 s (Claude, killed) + 784 s (Codex) | `E2E: FAIL (invariant 48/48, quality 0/1 = 0%)` | `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | F-9 (the only quality item): PRODUCT, the completion report's Execution table has no lead runtime per phase, A322.6. CODE_DONE and DONE, 7 gates, one knowledge page; F-1 and F-3 met; the first FAILOVER run with every invariant met |

What the final pass shows and does not show. A later PASS does not erase an earlier FAIL: TRIVIAL run 2 passed 33/33, but run 1 on the same commit failed 14/30 because the lead asked for a confirmation that the scenario cannot give, so TRIVIAL is not plainly passing on `900c2852`; the two runs are two samples of one model and one prompt (A324.2). STANDARD run 2 met everything except S-6 (36 of 37); the same S-6 is the only unmet item of STANDARD.tr, and it is the verdict-deciding one for both because a scenario needs every invariant. STANDARD run 1 failed on a product dead end that run 2 did not meet (A324.1). No scenario passed all of its items in every run on this commit, and no COMPLEX run reached DONE on it; the harness could not grant the user-only approvals that run needs (A322.8). Later the harness was allowed to send listed user messages (A328) and one COMPLEX run reached DONE on `98f49400`: see "The closing campaign on main". The final pass found no new security or approval defect and loosened nothing; the findings are recorded and not changed in A324 ([docs/limits.md](../../docs/limits.md)).

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
| 2026-10-16 | `7eeeeb4` | TRIVIAL PASS 33/33; STANDARD FAIL 35/36 and STANDARD.tr FAIL 40/41 (S-6: no debug report; before A200); COMPLEX FAIL 48/59; CRITICAL FAIL 33/35 (K-9: a harness probe gap, A121; K-2 model) |
| 2026-10-17 | `d2efc01` | COMPLEX FAIL 33/39 (the second plan approval after a refreeze was never answered by the harness: A128) |
| 2026-10-17 | `f75d1f5` | COMPLEX FAIL 45/59; STANDARD.tr PASS 41/41 twice |
| 2026-10-17 | `128e516` | COMPLEX PASS 39/39 |
| 2026-10-17 | `9e70f03` | the regression round above |
| 2026-11-16 | `6830eae6` | TRIVIAL FAIL 32/33 (C-22); STANDARD FAIL 31/36 against the old expectations and PASS 37/37 against those of A310; STANDARD.tr FAIL 39/43 (report language: A312; S-6); CRITICAL FAIL 23/34 (interview replies: A313); COMPLEX FAIL 31/37; FAILOVER (mixed, not Claude-only) FAIL 37/47 (Codex worker profile: A317) |
| 2026-11-16 | `87dd66a0` | STANDARD.tr FAIL 42/43 (S-6 only) |
| 2026-11-17 | `773f00d6` | CRITICAL FAIL 33/34 (K-2); FAILOVER (mixed) FAIL 40/48 (41/48 with F-3 as corrected by A321); COMPLEX FAIL 25/37 (mutation budget request: A318) |
| 2026-11-17 | `8a2cbea5` | COMPLEX FAIL 32/37 (an unanswered scope request; the dash in the bytes: A319) |
| 2026-11-17 | `8f84d850` | COMPLEX FAIL 25/35 (the assumption acceptance of the interview) |

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

The campaign of 2026-11 scored the `N-` items as follows. TRIVIAL 5/5; STANDARD 3/4 against the old expectations (N-5, the knowledge page) and 4/4 against those of A310; STANDARD.tr 4/4 in both runs; CRITICAL 2/4 in the first run (harness: no task, no run, so N-2 and N-3 had nothing to read) and 4/4 in the re-run; FAILOVER 4/4 in the first run and 4/5 in the re-run (N-5 unmet: the two knowledge pages, A322.5); COMPLEX 6/6 in run 1 and 5/6 in runs 2 to 4, each time N-4 (the visual focus) unmet because the run stopped before QA. The visual focus ran in COMPLEX run 1 and failed with a real defect (QA-1, a clear control); no run of the campaign produced a measured visual pass.

### Codex and mixed configurations (results below ran the lead on `gpt-6-luna`, before A135 required the base model; effort none; never full scenarios)

The two scored FAILOVER runs of 2026-11 are the exception to the model note above: see the last row of the table.

Hard call caps: attempt 1 five calls, restart three calls, rerun one call (nine model calls in total, no quota
error in these checks). These are integration checks, not scored scenarios, so none of them is an `E2E: PASS`.

| Check | Result |
|---|---|
| Dispatch of a Codex worker, sandbox, `submit` | PASS |
| Claude lead with a Codex worker, TRIVIAL (mixed) | PASS up to the commit-approval stop (the Claude reviewer and verifier ran as lead-native subagents, so the permission mode of A114 was not exercised by this check) |
| `proofline doctor` and hook probes on Codex | PASS, 0 model calls (thinner evidence than the other rows: there was no separate run for this check, the evaluator took the doctor output from the other two checks) |
| Lead failover Claude to Codex (`resume`) | partially tested: resume and freshness verified, a headless Claude verifier dispatched (A114 mode recorded), the A124 `wait:` line, and the A127 token with a single status file verified on `128e516`; the route printed after the VERIFY failure was only partly right (it named `## Verification commands` while the right edit was `criteria:` on the scope entries), and plan validation was a product gap (nothing enforced AC-to-scope coverage before freeze), both addressed afterwards by A127 and A129 and not re-run; the run did not reach DONE: the cheap Codex lead stopped to ask for authorization in prose, and the plan had an acceptance criterion mapped to no scope path (A129 now refuses that at freeze, not re-run) |
| Codex-only TRIVIAL scored run (2026-10-14, `354f348`) | FAIL 26/43: the model wrote a plan scope without criteria and nothing was implemented; the unparseable scope that the first freeze accepted is fixed (A101) |
| Codex-only STANDARD, STANDARD.tr, COMPLEX, CRITICAL; mixed STANDARD, STANDARD.tr, COMPLEX, CRITICAL | no scored run (see "Real use" below for unscored use) |
| FAILOVER (mixed) as a scored scenario, 2026-11-16 and 2026-11-17 | first run on `6830eae6`: FAIL 37/47, the Codex implementer was BLOCKED because its worker profile refuses a loopback listener (A317 gave the scenario an in-process test helper). Re-run on `773f00d6`: FAIL 40/48 (41/48 with F-3 as corrected by A321), capabilities 4/5: the Claude lead was stopped in IMPLEMENT (SIGTERM, exit 143), the Codex lead resumed from `proofline resume`, the ledger holds `dispatch interrupted signal=TERM` and `dispatch resume note written`, the implementer finished RED and GREEN under `workspace-write` (17 of 17 tests), 7 gates passed, the run reached DONE; the unmet items are the two knowledge pages (A322.5) and the lead runtime per phase in the report (A322.6). The Codex lead and the Codex implementer are the only Codex roles scored |

Real use (2026-10-23 to 2026-10-25, a user's project, records in `.agents/local/metrics`; its config says `proofline_version: 0.0.28`, the `main` commit was not recorded; not scored runs, no evaluator): 26 dispatch records, 17 with Codex as implementer (13 submitted, 2 failed, 2 timed out) and 9 with Claude as implementer (8 submitted, 1 timed out). Codex appears in 13 step records, all in the implementer role (9 done, 4 blocked); the other 140 step records and every lead record are Claude. Four tasks (TASK-007 to TASK-010, PRs #12 to #15) had Codex implementer work that passed the gates and was merged, TASK-008 and TASK-009 entirely by Codex dispatches. Failover from Codex to Claude happened in TASK-006, TASK-007 and TASK-010 (2 runtime failovers in the friction report); the records do not name the cause of the failures. Codex as lead, reviewer, qa, architect, designer, explorer, verifier or security reviewer does not appear in them, and Claude to Codex failover is covered only by the dispatch test.

### The closing campaign on main (2026-11-18)

After the final pass (above), the COMPLEX and STANDARD scenarios were run repeatedly on 2026-11-18 while the findings were answered one by one, each on the then-current `main` (0.0.156 to 0.0.164). Claude-only runs as above (economy profile and a Sonnet lead for STANDARD, balanced and an Opus lead for COMPLEX). The verdict lines are copied from the independent evaluation files (separate sessions that did not run the scenario and wrote no fix); the class (PRODUCT, MODEL, HARNESS, SPEC) is the evaluator's. Run directories (`$TMPDIR/proofline-e2e/<scenario>-claude-<UTC stamp>`) and evaluation files are on the maintainer's machine and are not in the repository. "Counted" means the run is scored; a run that ended on an account usage limit or on a harness defect before the product could be judged is listed and not counted. A later PASS never erases an earlier FAIL, and no row below was re-scored.

| Run (stamp) | Main (version) | Verdict line | What stopped or what passed | Class | Answered by |
|---|---|---|---|---|---|
| COMPLEX, no evaluation file (`T001316Z`) | `2cdd6746` (0.0.156) | not scored | `stopped=repeated-stop`: the harness read a superseded plan request as a second open plan, sent `approve plan` to a scope question and never sent the listed scope approval (`listed_approval_replies=0`) | HARNESS | A331, PR #323 (from the record A331; no evaluator file) |
| STANDARD pass 3 (`T001316Z`) | `2cdd6746` (0.0.156) | `E2E: FAIL (invariant 35/37, quality 0/0 = 100%)` | Reached DONE. S-6: no `reports/NNN-debug.md` (accepted limit A322.1). C-22: the completion report says the first implementer submission was rejected because of a space in the evidence `target:`; the ledger shows the submission was recorded and the handoff was refused | S-6 MODEL; C-22 MODEL with a PRODUCT cause (the spaced `target:` list) | A330, PR #322 (target lists trimmed); S-6 stays accepted |
| COMPLEX pass 3 (`T032832Z`) | `3738e2d1` (0.0.159) | `E2E: FAIL (invariant 30/38, quality 1/2 = 50%)` | Stopped at IMPLEMENTED on the user-only `tree` approval: the lead cut the first line of `next` (`agent.sh next T-1 \| tail -14`), launched the fix implementer with no write window and a `python3` heredoc write got past the Bash hook; REVIEW_TESTS failed on four hollow page tests (REVIEW_TESTS-1 to 4) and REVIEW_RULES on the `.`/`..` tag-removal defect; the extra failing test is C-19, not a REVIEW_RULES finding | MODEL first, with a PRODUCT contributor; C-18 SPEC | A333, PR #324 (launch guard, `NEXT:` line); A327 already made review roles leave worktrees to the control plane |
| COMPLEX pass 4 (`T073520Z`) | `071fd397` (0.0.160) | `E2E: FAIL (invariant 32/38, quality 2/2 = 100%)` | Interrupted by the account weekly usage limit (HTTP 429): the last lead session and its five re-review subagents ended with `rate_limit`. Second IMPLEMENTED after a fix, re-review wave dispatched, SECURITY, QA and VERIFY never ran. **NOT COUNTED**: the product was not judged. The harness labelled the stop `no-open-question` and did not report the exit status or the API error | HARNESS (environment, plus a reporting defect of the harness, not changed) | none (not a product finding) |
| STANDARD pass 4 (`T073521Z`) | `071fd397` (0.0.160) | `E2E: FAIL (invariant 36/37, quality 0/0 = 100%)` | Reached DONE, all 7 gates passed. S-6 only (accepted limit A322.1); the `EVIDENCE.md` claims were `path:line`, not `path:symbol` | MODEL | A322.1 stays accepted |
| COMPLEX, two runs (`T084325Z`, `T084652Z`) | before 0.0.161 | not scored | Both ended `stopped=max-replies` before any task, plan or gate existed: the task author's interview asked 12 questions in 4 batches and the allowance of 3 replies (C-14) was spent. **NOT COUNTED** | HARNESS | A334, PR #325 (one standing question reply); from the record A334, no evaluator file |
| COMPLEX, one run | 0.0.161 or 0.0.162 | not scored | Interrupted by the account 5-hour usage limit. **NOT COUNTED**. No stamp or file is available to this record | HARNESS (environment) | none |
| COMPLEX pass 8 (`T100526Z`) | `334c4d6e` (0.0.162) | `E2E: FAIL (invariant 33/37, quality 2/2 = 100%)` | Reached IMPLEMENTED, two fix rounds, then `terminate FAILED` at REVIEW_TESTS: the A323.3 contradiction (`handoff IMPLEMENTED` called the narrow GREEN-1 command superseded, the review demanded a `command_not_double_run` finding for it and the A325 repair refuses that reason). QA visual passed with 33 screenshots | PRODUCT (A323.3) with MODEL contributors (a non-plan-listed GREEN command; the `- measure:` exception route was not taken) | A336, PR #326 (one supersession rule) |
| COMPLEX pass 9 (`T122721Z`) | `818bcbe3` (0.0.163) | `E2E: FAIL (invariant 30/37, quality 2/2 = 100%)` | Stopped `unanswered-mutation_budget` after two fix rounds: REVIEW_TESTS BLOCKED on the budget (the mutant counter is one budget for all rounds); the listing had no `approve mutation` line; the second listed `approve scope` went to a stale request. QA failed once (QA-1), VERIFY never ran; the lead's final message said every other gate had passed (C-22) | HARNESS first (listing), PRODUCT and MODEL contributors | A337, PR #327 (`approve mutation` listed); the counter and the wording are A337.1, open |
| COMPLEX, one run | 0.0.164 | not scored | Interrupted by the 5-hour usage limit. **NOT COUNTED** | HARNESS (environment) | none |
| COMPLEX pass 11 (`T153828Z`) | `98f49400` (0.0.164) | `E2E: FAIL (invariant 37/38, quality 2/2 = 100%)`; `CAPABILITIES: PASS (invariant 6/6, quality 0/0 = 100%)` | **Reached CODE_DONE and DONE.** One fix round, one refreeze, 34 tests (baseline 14), migration and API verified by the evaluator. C-22: the final message says the page was checked in a real browser after the fix round; the only browser record is the pre-fix QA:visual pass | MODEL with a PRODUCT contributor (the `ui_path` signal watches html-like files, so the visual pass was carried over a fix round that changed `public/app.js`) | recorded as A338.1, not fixed |
| STANDARD pass 5 (`T163213Z`) | `98f49400` (0.0.164) | `E2E: FAIL (invariant 36/37, quality 0/0 = 100%)`; `CAPABILITIES: PASS (invariant 4/4, quality 0/0 = 100%)` | Reached DONE. Tier small, 0 fix rounds. S-6 only (accepted limit A322.1, the evaluator of pass 5 counts it as the fourth STANDARD-family run in a row with S-6 alone). There was no review dead end (tier small, REVIEW_SMALL, REVIEW_TESTS not required): the superseded-GREEN case happened and was caught at `handoff IMPLEMENTED` with a precise route (re-record with `npm test`) | MODEL | A322.1 stays accepted |

Owner decisions that shaped these runs. The harness has no privileged path for any user-only approval (A328); a scenario may send, as a user would, the messages its `replies/approvals.<SCENARIO>.txt` lists in advance (A328, A331, A337), and COMPLEX also has a standing question reply for its whole interview (A334). What COMPLEX lists today: `approve scope` (up to twice), `accept AS-1`, and `approve mutation` (up to twice); never a waiver, commit, push or delivery. See "Listed approvals".

What the closing campaign shows and does not show.

- COMPLEX is proven to reach DONE in ONE run (pass 11 on `98f49400`). That is one sample of one model and one prompt: the passes before it stopped for product dead ends (A333, A336), a harness listing (A337) or the account limits, and this one needed a refreeze, a fix round and five real bugs found by review. It is not a stable result.
- In that run the harness supplied all three user approvals: `Plan approved.` twice and a listed `approve scope`. The listed phrase is not tied to what the request contains; the request named only `docs/design/DESIGN.md`, a file the designer created that the plan scope did not list, and the listing comment describes the phrase as a Test-exceptions change or the paging fix (A338.4).
- There is no E2E PASS for either scenario on the final main. COMPLEX failed C-22 (37/38) and STANDARD failed S-6 (36/37). S-6 was unmet in STANDARD passes 3, 4 and 5 (with C-22 in pass 3); the evaluators count the series differently (pass 4: "third consecutive", pass 5: "fourth consecutive" with S-6 alone), so no count of runs in a row is claimed here.
- Other facts the evaluator states for pass 11: the REVIEW_RULES:contract focus was UNSUPPORTED (prose contract), a new info finding was dropped as a "classification changed" flip (A338.2), the mutant budget was overrun by one, the paging defect was reported and not fixed (a test pins it), and the gates were `NOT_RERUN`.
- Runs interrupted by an account usage limit (pass 4, two further COMPLEX runs) say nothing about the product and are not counted. The evaluator's verdict line of pass 4 is a FAIL; it is quoted above and not used as evidence of a defect.
- Evaluation notes: the owner's summary quoted 36/37 for STANDARD pass 3 and 33/38 for COMPLEX pass 8; the evaluation files say 35/37 and 33/37, and the files are quoted. TRIVIAL, STANDARD.tr, CRITICAL and FAILOVER were not run after `900c2852`.
- The accepted limits and their evidence are A338.1 to A338.11 in [docs/limits.md](../../docs/limits.md) and in decision A338.

### Harness defects found and fixed in this campaign

The second plan approval a refreeze asks for was never answered (A128); a stray fourth reply went to a message
that was not a question (A120, A131); the database probe was too thin (A121); the CRITICAL scripted reply was
generic and steered the interview (A131); runs left files outside their run directory (A117, A120). None of
these changed an EXPECTED file.

In the campaign of 2026-11: the interview reply was sent six times, and in the COMPLEX run the plan and scope requests of a refreeze were left unanswered (A313); the Codex worker profile refused the loopback listener, the scenario kept no snapshot at the kill and the Codex lead inherited `CLAUDE_CODE*` variables (A317); the COMPLEX project stopped at a mutation-budget request the harness never answers (A318). The expectations changed twice: the knowledge step and C-23 (A310) and F-3 of FAILOVER (A321).

### Known limits

- Run-to-run model variance remains: the accuracy of the lead's final report (C-22) and the contents of
  `EVIDENCE.md` in CRITICAL (K-2) differed between runs (the failing runs were on different commits).
- COMPLEX has passed twice (2026-10-14 on `b515110`, 2026-10-17 on `128e516`) and failed in every other
  run of the campaigns of 2026-11 (including the one that reached DONE on `98f49400`, FAIL 37/38); a COMPLEX pass is therefore not yet a stable result, and one DONE is one sample.
- The Codex-lead behaviour of the earlier checks was tested with the cheapest model only (the 2026-11 FAILOVER runs fall under the base-model rule of A135; the evaluations do not record the model); its stop to ask for authorization in prose is
  model behaviour that `agent.sh next` cannot prevent.
- The campaign of 2026-11 ran every scenario on `6830eae6` and re-ran STANDARD.tr, CRITICAL, FAILOVER and COMPLEX (see "The campaign on main 6830eae6 and its re-runs"). The newest run of each scenario is a FAIL except STANDARD, which passes only under the expectations of A310. Of the scenarios of that campaign only COMPLEX and STANDARD ran again on a later `main` (2026-11-18, section "The closing campaign on main"); TRIVIAL, STANDARD.tr, CRITICAL and FAILOVER did not. The accepted limits with their evidence are A322, A323 and A338, indexed in [docs/limits.md](../../docs/limits.md). That campaign did not demonstrate a COMPLEX run to DONE (A322.8); the closing campaign has one.
- Tests that do run on every change: the Node tests (`node tests/affected.mjs`), the skill tests (`node --test tests/skills/`) and the fixtures (`node tests/fixtures/check-fixtures.mjs`); the current count is in [docs/proof.md](../../docs/proof.md).

### Reply limit and item tags (decided, A133)

C-14 in `expected/COMMON.md` allows at most 3 answers, +1 for every refreeze (answers are harness replies, plan
approvals and question replies together; each refreeze after an amendment allows one more). The default
`E2E_MAX_REPLIES` of 6 is the harness cap and is not the C-14 limit: the evaluator counts answers from
`out/replies-log.txt`. Every numbered item is tagged `[invariant]` or `[quality]`; a scenario passes when all
invariant items are met and at least 90% of the applicable quality items are met (see `expected/COMMON.md`
"Tags" and A133). Results above were scored before the tags and the new C-14 wording and are not re-scored.

### Listed approvals (A328, owner decision)

The harness gets no special privilege for an approval only the user gives (scope, destructive, mutation budget, the acceptance of a high-risk assumption). A scenario may, as a real user would,
SEND such a message: the harness resumes the lead with the text as the user's prompt, the same delivery as a plan approval or a question reply, so the hook sees an ordinary user message.
Which messages a scenario may send is written down in `replies/approvals.<SCENARIO>.txt`; today only `approvals.COMPLEX.txt` exists (three messages: `approve scope` up to twice, `accept AS-1`, and `approve mutation` up to twice (one per distinct request, a later round can raise it again) for the user-only `mutation_budget` request, A337: the lead's request text says `Reply "approve mutation"`; the config budget of the scenario project stays 30, A318), and a scenario without the file behaves as before (it answers none of these requests).

- Format: one line per message, `kind | exact message | max-uses`; `max-uses` is optional (default 1); blank lines and `#` comments are ignored. At most 6 lines and 6 uses in all.
- Kinds a file may name: `scope`, `destructive`, `mutation_budget` (an unanswered `NNN-request-<kind>.yaml` in the run's `approvals/` folder) and `assumption` (the message is exactly `accept AS-<n>`, sent only while `agent.sh questions` lists `ASSUMPTION: AS-<n>@...` as open).
- A line is sent only while a request of its kind is open and its uses are not spent (the assumption path is covered by unit tests, not driven through `run.mjs`: `agent.sh questions` needs a real run, which the stub lead cannot create), and never in place of the plan reply: a stop with a plan request (alone or with a scope request in a refreeze) takes the scripted plan line first; the listed scope goes out at the next stop.
- Never listed, never sent: a waiver (`waive:*`, a waiver must never come from the harness), commit, push, pull request, merge, delivery, anything of the secrets or security gates, `plan` and every other kind. The loader judges a message with the PRODUCT's own approval grammar (`textHasApproval` of `control-plane/agents/scripts/core/approvals.mjs`, the function the prompt hook's scan applies to each segment; imported, not copied): it asks it about every kind the product has (read from the source of `validApprovalKind` and `kindWords`, plus the `waive:`, `rule:`, `reopen:` and `rationale:` families with each word of the message as the id, so `approve review-1` is seen as the waiver `waive:REVIEW-1`) and accepts the message only when the set of kinds it satisfies is exactly the listed kind (for `assumption`: exactly `accept AS-<n>`, satisfying no approval kind). It also refuses any character other than ASCII letters, digits, space, hyphen and underscore (no comma, semicolon, ampersand, bar, apostrophe, question mark, newline: one clause), and, as a second check by stem and not by whole word, any message holding `waiv`, `feragat`, `commit`, `push`, `pull`, `request`, `deliver`, `teslim`, `merg`, `secret`, `secur` or `pr`. A bad file makes the harness exit 2 at startup (dry run included) with `approvals listing refused`. `pickListed` judges every entry again before it is sent.
- Send time: a line is sent only if every open request its text would satisfy is of the listed kind. The check reads the whole project (every run's `approvals/` folder and the no-run `.agents/local/approvals` folder) with the PRODUCT's own functions, not a regex of the harness: `approvalPendingPairs` finds the open requests (so `rationale:`, `rule:` and `reopen:` requests count) and `approvalWords` gives the words each is answered with (a `joint:` or `delivery:` field changes them: a `kind: commit` request with `joint: scope` is answered by `approve scope`). A request counts as a plain scope request only when its product-read kind and its words are both `scope`. The trees are the ones the prompt hook walks: the project and every `.agents/local/worktrees/<d>` (their runs and their own no-run folder). A message that holds the id of any run in those places is withheld too, because the hook then approves that run (`pt.includes(run)`). A request file the product cannot read unambiguously (unreadable, several `kind:` lines, a kind it does not accept, a name that is not the slug of its kind) withholds every send. A plain `approve scope` also satisfies `rationale:scope`, `rule:scope` and `reopen:scope` requests (the loader cannot rule this out, it depends on the open requests), so while one of them is open the message is WITHHELD: `out/replies-log.txt` gets a `withheld kind=listed-approval-withheld ... reason=...` line, nothing is sent and the run stops as it did before.
- `max-uses` counts DISTINCT requests: a line answers a given request file (or AS id) once, so a second use is for another request and never repeats the same unchanged one.
- Open set (A331): `openApprovals` follows the product's `pendingRequest`, with two stated differences: only the latest request of a kind can be open, and an approval `NNN-<slug>.yaml` of that kind numbered at or after it closes it (a superseded older plan request, two `request-plan` files with one bound and one reply, is not a second open plan, so a scope request raised after the plan approval is a lone scope request and gets the listed message at the next stop, not a refreeze reply). Differences that remain: (1) the harness also closes a request that an answer file names in its `request:` line (the product does not read that line; where the two disagree the product list below withholds); (2) it reads one run's folder only, and cross-kind lines fail safe (see next). Numbers are exactly three digits, as the product writes them: a file such as `5-plan.yaml`, `0004-request-scope.yaml` or `1-request-scope.yaml` is not read as a request or an answer, and while one exists in any approvals/ folder every listed send is withheld (`unclear`, logged with the file name). At send time the harness's open kinds of the run must equal the kinds the product's `approvalPendingPairs` lists for that run, and a request of the listed kind must not also be open in another run or the no-run folder (one reply would be recorded against both); otherwise the send is withheld and logged. Every stop where a listing exists and nothing is sent logs `skipped kind=listed-approval-skipped task=<id> reason=<...>` in `out/replies-log.txt` (reasons: `plan-reply-first`, `refreeze-reply-first`, `no-open-request-of-a-listed-kind`, `uses-spent-or-refused`).
- Logging: each message is a reply of kind `listed-approval` in `out/replies-log.txt` (`request=<kind> <request file or AS id>`), counted in `summary.txt` as `listed_approval_replies=`.
- Counting (C-14): a listed approval is a user message. It is counted in `replies=` and in `reply_budget=` (the allowance is 3, +1 per refreeze, +1 per listed message sent), is bounded by the max-uses of the file and stays under the hard cap of 12. The evaluator reads the listed messages next to the plan and question replies in `replies-log.txt`.
- `E2E_APPROVALS_FILE` replaces the path of the listing (tests only; the same loader judges it).
- A listed `approve scope` answers whichever scope request is open: the evaluator checks from the lead's relayed question what the scope request covered (COMPLEX X-13, X-16).

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

## Other configurations and adapters (A140)

These rows moved here from the root README. Self-tests and enforcement tests cover every row; no scored end-to-end run exists for any of them.

| Configuration | Tier | Self-tests and enforcement | End-to-end |
|---|---|---|---|
| Any `AGENTS.md` agent (standalone topology) | Protocol | control plane and hooks tested | not tested |
| Any headless CLI as worker (command template) | Worker | tested with a fake command | not tested |
| Task adapters: markdown, GitHub Issues | none | tested (GitHub through a fake `gh`) | markdown used in every run |
| Task adapters: Jira, Linear | none | argument checks only | not tested |
| Windows | none | not tested (use WSL or Git Bash) | not tested |
| Codex-only team | Full | hooks, dispatch and rendered agents tested | implementer role: supported in real use; other roles not yet verified in real use; no scored run |
| Claude lead with Codex worker | Full | tested with fake runtimes | supported in real use (Codex implementer merged work); no scored run |
| Failover | Full | `agent.sh next` and dispatch failover tested with fake runtimes | Codex to Claude: works in real use; Claude to Codex: dispatch test only |

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
  selfchecks (`node tests/fixtures/check-fixtures.mjs`); `node tests/benchmark/benchmark.mjs --e2e-dir DIR` can score a
  run directory against EXPECTED.
- Codex-only, mixed and failover configurations: see "Codex and mixed configurations" above; only integration
  checks were run, no scored scenario passed.
