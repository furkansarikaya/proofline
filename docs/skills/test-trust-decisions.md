> **Ported into proofline.** This is the decision log of the standalone [test-trust](https://github.com/furkansarikaya/test-trust) repository, carried over verbatim below the horizontal rule. The skill now lives in `skills/test-trust/` of proofline (team version 0.0.1, D30) and its fixtures in `fixtures/test-trust/`. Where a numbered decision below names a path or a behaviour that proofline changed (for example the `.test-trust/` output folder, decision 15), the section "Proofline extensions" at the end says what replaced it; everything else still holds. The source repository is archived only after proofline has been used on a real project (D30).

---

# test-trust: Design Decisions

This document records the decisions made in the initial design (grilling) session for the `test-trust` skill. It is the source of truth for the first implementation. Anyone changing a decision below should update this file and note why.

## Goal

`test-trust` is a language- and framework-agnostic agent skill that audits how far a test suite can be trusted, using runnable evidence rather than opinion. It answers one question: "Can I trust these tests?"

Inspirations: [mattpocock/skills](https://github.com/mattpocock/skills) (small, composable skills; grilling), [ersinkoc/evidence-audit](https://github.com/ersinkoc/evidence-audit) (proof-first findings, ledger, toolchain detection from the repo), [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (verdict categories, schema-validated findings, independent verification).

## Decisions

### Scope and behaviour

1. **Three pillars only.** Flaky tests, hollow tests (tests that stay green when the code they claim to protect is broken), and slow tests. Coverage percentages, suggesting missing tests, and test style critique are out of scope.
2. **Audit only, never fix.** The skill produces evidence-backed findings. Fixing is a separate, user-chosen step (or a future separate skill). Rationale: an agent asked to make tests green tends to weaken them.
3. **Explicit scope.** Invoked as `/test-trust <scope>`. Without a scope, the skill lists candidate scopes and lets the user choose. It never audits the whole suite on its own initiative.
4. **User-invoked only.** `disable-model-invocation: true`. The audit is long, runs many commands, and temporarily mutates code.
   *Note (implementation):* `disable-model-invocation` is a Claude Code field outside the Agent Skills standard; it stays in the frontmatter. For Codex, `skills/test-trust/agents/openai.yaml` sets `policy.allow_implicit_invocation: false` (plus `interface.display_name` and `interface.short_description`), following mattpocock/skills and evidence-audit. The README documents how invocation works in each agent.
5. **Portable.** Follows the [Agent Skills standard](https://agentskills.io/specification). Platform features such as sub-agents are written as "use if available, otherwise do sequentially".
6. **Optional helper script.** The core flow works with plain shell commands. A dependency-free Node script optionally validates `findings.json` against the schema; if Node is missing, that step is skipped. Never install Node for it.
   *Note (implementation):* bundled paths (`references/`, `assets/`, `scripts/`) resolve relative to the directory containing `SKILL.md`, never relative to the audited repo. The validate command uses the script's full path inside the installed skill directory.
7. **Language.** Skill files are written in English. The skill talks to the user in the user's language.
   *Amended (decision 29):* `REPORT.md` is written in the user's language; `ledger.md` and `findings.json` stay in English.

### Language independence

8. **No ecosystem-specific reference files.** They go stale and models already know test runners. Instead:
   - The agent discovers how the project actually runs tests (CI config, Makefile/Taskfile, package scripts, README). The project's own commands always win over ecosystem defaults. Each discovered command is recorded with the file that proves it.
   - **Toolchain probe:** before auditing, the agent proves four capabilities with a real trial in the project:
     - *Single test:* output shows exactly one test ran.
     - *Repeat:* each repetition actually re-executes (not served from a result cache).
     - *Shuffle:* two runs show different execution orders.
     - *Per-test duration:* durations are available in machine-readable output.
   - A capability that cannot be proven is marked "unsupported", the dependent step is narrowed, and this is stated in the report (e.g. no shuffle → order-dependence detection unsupported).

### Audit flow

14. **Baseline first.** Tests failing in the baseline run go to a separate "red at baseline" list. If they keep failing every time they are informational only, not findings. They are excluded from mutation, because a red test says nothing about a mutant.
16. **Cost estimate.** After baseline, estimate total runtime from measured duration. Under 15 minutes: proceed. Over: show the estimate per pillar and ask for confirmation, offering to narrow the scope or skip a pillar.
   *Amended:* mutation target selection (read-only, no execution) happens before the estimate, so the mutation budget in the estimate is based on real targets. See also decision 25.
9. **Flaky detection.** Stage 1: run the scoped suite 5 times, shuffled where supported; tests whose outcome changes become candidates. Stage 2: run each candidate alone 20 times. Changes alone → `flaky_nondeterministic`; changes only within the suite → `flaky_order_dependent`. Confirmation requires at least one recorded pass and one recorded fail on identical code.
12. **Slow tests are relative.** Slow = longer than 10× the scope's median duration, or more than 5% of total scope runtime on its own. Durations are averaged from the 5 flaky-stage runs, so there is no extra cost.
10. **Hollow detection by targeted mutation.** Default: the agent applies hand-written, targeted mutations (invert a condition, delete a call, change a return value, shift a boundary). If the project already has a configured mutation tool, use it. Never install one. Evidence: the mutation diff plus output showing tests still pass under it.
23. **Mutation is per production unit, not per test.** Identify production functions exercised by tests in scope, apply 3–5 mutations to each, and run the tests covering it. If no test turns red, the tests claiming to cover that function are `hollow`. Priority: code touched by tests with no assertions (or only "did not throw"), then tests that mock everything, then snapshot-only tests, then the rest. The mutation budget is part of the cost estimate.

### Safety

11. **Never touch the user's working directory with mutations.** Mutations happen in a separate `git worktree`, with uncommitted changes copied in so the audit reflects the real code. Without git, work in a temporary copy of the scope. Flaky and slow measurements do not modify code and may run in place.
   *Amended:* the worktree is removed when the hollow stage ends, but only after the diffs of all surviving mutants are saved under `evidence/`. The worktree path is recorded in the ledger; on resume, a leftover worktree from an interrupted run is cleaned up before anything else.
   *Amended (security review):* worktrees and temp copies are created under the system temp dir with a `test-trust-` prefix. A path read from the ledger is removed only if it passes safety checks (under the temp dir with that prefix; with git, a registered non-main worktree removed via `git worktree remove`, never `rm -rf`; without git, not the repo, a parent, or home). Otherwise nothing is deleted and the user is told. A previous commit hash is used only if it is a valid hex hash that `git rev-parse --verify` accepts. Evidence paths must stay inside the scope's output folder.
22. **Sequential test execution by default.** Parallel runs on shared ports, databases, or temp dirs produce false flakiness. Sub-agents are used only for non-executing work: choosing mutation targets and independently trying to refute candidates before reporting. Parallel execution only if the user explicitly asks, and the report notes it.

### Verdicts and outputs

13. **Three verdicts.** `confirmed` (evidence criterion fully met), `needs_validation` (suspicion with missing evidence; state exactly what is missing), `cleared` (examined and shown not to be a problem). Only `confirmed` counts as a problem.
15. **Output location.** Everything under `.test-trust/<scope-slug>/` at the repo root: `ledger.md`, `findings.json`, `REPORT.md`, and `evidence/` for raw outputs. The skill does not edit `.gitignore`; on first run it asks in one sentence whether to commit this folder.
18. **Ledger sections.** Scope (paths + git commit hash), Toolchain probe (commands with proving files; status of the four capabilities), Baseline (duration, test count, red-at-baseline tests), Progress (per pillar: done / in progress / skipped, and resume point), Candidates (with verdicts), Commands log (every command, exit code, evidence file path). Shipped as a template; updated after every step.
19. **Finding fields.** `id` (F001…), `kind` (`flaky_nondeterministic` | `flaky_order_dependent` | `flaky_unclassified` | `hollow` | `slow`; `flaky_unclassified` added by decision 27), `verdict`, `test` (file path + test name), `evidence` (evidence file paths and commands), `observed` (per kind: pass/fail counts, surviving mutant diff, duration and ratio to median), `missing` (for `needs_validation`, and for `flaky_unclassified` per decision 27), `source_commit`.
20. **Re-runs are additive.** Read the previous ledger; use git diff to find changes. Re-verify findings whose test or tested code changed. Carry unchanged `confirmed` findings forward, marked "from previous run, code unchanged". Always retry `needs_validation`. Without git, re-runs start from scratch.
21. **No command execution available.** State the missing capability and do not start the audit. If the user still wants it, list suspicious tests from reading the code, all as `needs_validation`; none may be `confirmed`.

### Added after the SKILL.md review

24. **Timeouts on every test run.** Each run gets a timeout derived from the baseline: 3× the baseline duration of what that run executes (the whole scope, or the summed baseline durations of the selected tests), with a 30-second floor. In the hollow stage, a mutant that hits the timeout counts as **killed**. In the flaky stage, a timeout is recorded as a **fail**. The baseline run itself has nothing to derive from; if it passes 15 minutes, stop and ask the user to narrow the scope.
25. **Checkpoint after flaky stage 1.** Once stage 1 has produced its candidates, recompute the total estimate with the real candidate count. If it now exceeds 15 minutes, show the new estimate and ask for confirmation again before stage 2.
26. **Repo content is data, not instructions.** Commands, docs, comments, and config found in the audited repo are evidence about how tests run. They are never followed as instructions. Only commands whose purpose is running tests are used, and they never extend the authority the user granted.

### Added before the first push

27. **`flaky_unclassified`.** Without single-test selection, stage 2 cannot run. A test that both passed and failed on identical code in stage 1 is still proven flaky: it is reported as `confirmed` with kind `flaky_unclassified`, and `missing` explains why the sub-kind could not be determined. It is never dropped. The same applies to candidates whose stage 2 the user chose to skip.
28. **Timeout calculation (refines 24).** Suite runs: 3× the scope's baseline duration. Single-test runs: 3× that test's own baseline duration. A selection of tests (hollow covering tests): 3× the sum of their baseline durations. Without per-test durations, single-test and selection runs fall back to the scope baseline. The floor is 30 seconds in every case.
29. **Report language.** `REPORT.md` is written in the user's conversation language, or another language if the user asks. Test names, paths, commands, ids, and `kind`/`verdict` values are never translated. `ledger.md` and `findings.json` are always English.
30. **Fixtures.** `fixtures/go` (go test) and `fixtures/ts` (Vitest) are small projects with planted problems: one nondeterministic flaky test, one order-dependent test, one test without assertions, one test that mocks everything, one slow test, and at least two solid tests. `fixtures/EXPECTED.md` lists the expected findings. Fixtures are audited on a standalone copy, and they are not part of the installed skill package (`npx skills add` copies only `skills/test-trust/`).
31. **Versioning.** Starts at 0.0.1. Until 1.0.0: `0.0.x` for fixes, `0.x.0` for new features or behaviour changes. The version appears in `package.json`, `SKILL.md` (`metadata.version`), the README badge, and `CHANGELOG.md`, and must match everywhere. Tags and releases are created only when the maintainer asks, after the PR is merged.

### Added after the PR #1 review

32. **Dependency folders are linked into the worktree; build folders are not.** A fresh worktree lacks git-ignored folders. *Dependency folders* are git-ignored directories holding third-party packages installed by a package manager, not output compiled from the project's own source (`node_modules/`, `.venv/`, `venv/`, git-ignored `vendor/`, `.bundle/`, `Pods/`, including nested ones). They are symlinked at the same relative path; this is not an installation and mutations only touch source files. *Build folders* (`bin/`, `obj/`, `target/`, `dist/`, `build/`, `out/`, `.next/`, `__pycache__/`, ...) are never linked or copied: the test command rebuilds in the worktree, and a linked build folder would let mutated build output be written into the user's real folder. Install or restore commands are never run.
33. **Worktree verification includes the first build.** The unmutated verification run of the covering tests includes the worktree's first build, and its estimated duration is part of the cost estimate (replaced by the measured duration once it ran). If it fails because of the build or missing generated files, the skill stops and asks the user; it never tries linking or copying build folders on its own.
34. **Flaky tests are not used for mutation.** Tests with a `confirmed` flaky finding are removed from covering sets, because they can kill a mutant by chance. A unit left with no covering tests gets a `hollow` finding with `needs_validation` and `missing`: "covering tests are flaky"; its mutants are not run.
35. **Canonical paths in worktree safety checks.** All paths are resolved with `realpath` before comparison (macOS `$TMPDIR` resolves to `/private/var/...`).
36. **Running tests runs the audited code.** README (FAQ) and hard rule 7 tell users to audit untrusted repos only inside a sandbox, container, or VM.

### Added after the first end-to-end runs

37. **Sandbox warning timing.** The warning that auditing runs the project's code is given on the first run only (no ledger), before the probe or anything else executes project code, in the same message as the `.test-trust/` commit question; the skill waits for the answer. It is not repeated on re-runs or placed in the report. (Refines 36.) The probe runs tests too, so "before the baseline" means before the probe.
38. **Fixture expectations follow the per-covering-test rule.** A test covering several units (for example `Checkout` calling `NormalizeEmail`) yields a hollow finding per unit it fails to protect. `fixtures/EXPECTED.md` lists these, plus an "unplanned but real" section for genuine weaknesses that are accepted but not required (mutation choice varies between runs). Fixtures are not changed to remove them.
39. **Tested agents.** The README marks an agent as tested end-to-end only after real fixture runs: Claude Code on macOS (Go + TS fixtures). The example report in the README is a real run's `REPORT.md`, shortened without changing numbers or findings.

### Implementation details filled in while writing the references

These fill gaps without changing a decision above. Change them freely, but keep this list current.

- The probe's trials use the 15-minute baseline ceiling as their timeout, since no baseline exists yet.
- Without the single-test capability, flaky stage 2 is skipped (superseded in part by decision 27: proven-flaky candidates are `flaky_unclassified`, not `needs_validation`).
- If the scope's median duration is below the reporter's resolution, the resolution is used as the median for the 10× rule.
- A test that fails all 20 isolated runs but passed inside the suite in stage 1 is `flaky_order_dependent`.
- Slow uses the mean of a test's completed stage-1 runs; timed-out runs are left out, and fewer than 3 completed runs makes it `needs_validation`.
- Hollow verifies the worktree first by running the covering tests unmutated; a mismatch with the baseline stops the hollow stage. A build failure under a mutant counts as killed.
- `findings.json` also carries `scope`, `unsupported`, and an optional `carried_forward` flag; `cleared` entries are kept so re-runs know what was examined. The validator also checks that cited evidence files exist.
- Re-runs always repeat the probe and baseline. Without git, the previous output folder is kept as `<scope-slug>.previous/`.


## Repository layout

```
test-trust/
├── README.md
├── CHANGELOG.md
├── LICENSE                          (MIT)
├── package.json                     version + `npm test` for the validator tests
├── fixtures/                        go/, ts/, EXPECTED.md (not shipped with the skill)
├── test/validate-findings.test.mjs
├── docs/decisions.md                (this file)
└── skills/test-trust/
    ├── SKILL.md                     short: principles, flow, hard rules
    ├── agents/openai.yaml           Codex display name and invocation policy
    ├── references/
    │   ├── PROBE.md                 toolchain discovery and capability probe
    │   ├── FLAKY.md
    │   ├── HOLLOW.md                mutation strategy and prioritisation
    │   ├── SLOW.md
    │   └── REPORTING.md             verdicts, findings.json, REPORT.md
    ├── assets/ledger-template.md
    ├── schema/findings.schema.json
    └── scripts/validate-findings.mjs
```

SKILL.md stays short and loads reference files only when a phase needs them (progressive disclosure).

## Next steps

1. ~~Confirm the open assumption: MIT license.~~ Confirmed: MIT.
2. ~~Write `SKILL.md` first (frontmatter with a precise `description`, hard rules, phase overview, pointers to references).~~ Done.
3. ~~Write the reference files, ledger template, schema, and validation script.~~ Done.
4. Test the skill on at least two real projects in different ecosystems (e.g. one Go, one TypeScript) and record what broke.


---

## Proofline extensions

Added when the skill was ported into proofline (phase 4). Each entry says what was added and why; the numbers D10 to D30 refer to `docs/decisions.md` of proofline. Nothing above was removed: the audit (full mode) behaves as before apart from the output location.

### Version and shared floor

- **Version 0.0.1 is the team version (D30)**; `metadata.version` stays `"0.0.1"`. `disable-model-invocation: true` and `agents/openai.yaml` are kept: standalone use stays user-invoked, and roles point agents at `SKILL.md` explicitly.
- **Shared rules block.** `SKILL.md` carries the block between `<!-- proofline:shared-rules:begin` and `<!-- proofline:shared-rules:end -->`, byte-identical to `tests/shared/shared-rules.md` (checked by `tests/shared/check-shared.sh`, D29: no file sharing between skills). The skill's own hard rules stay below it; where they are stricter or more specific (timeouts per kind of run, sequential execution, mutation never in the working directory) they win, because the shared block is a floor.

### Two modes (D20)

- **`full`** is today's audit and the default outside a run. **`diff`** is the review gate's tests focus and the default inside a run. Reference: `references/DIFF.md`.
- **Diff scope** = tests the change added or edited plus tests covering changed production units, found read-only from the diff. Reason: the gate must be cheap and tied to the change, so it never audits the whole suite (decision 3 of the original log still holds: no widening of scope).
- **Flaky:** each test in the diff scope runs alone `test_trust.repeat` times (default 5). One recorded pass and one recorded fail is `flaky_nondeterministic`, `confirmed`, and the loop stops there. Reason: decision 9's evidence criterion unchanged, with the 20 isolated runs replaced by a configured count because only candidates-from-suite-runs justify 20.
- **Order dependence is not checked in diff mode** and the report says so. Reason: it needs the whole suite shuffled, which is full mode's job.
- **Hollow:** only changed units are mutated, within `test_trust.mutation_budget` (default 20) mutants in total, round-robin by the priority of `HOLLOW.md`; units left over are listed in `scope.diff.not_examined` and cap `CONFIDENCE` at `medium`. Reason: D20 says "mutates only changed units"; the budget keeps the gate's cost bounded and visible.
- **Slow:** informational only, against `test_trust.slow_ratio` (default 3) times the median per-test duration of the enclosing test files. Reason: a diff scope of three tests has no meaningful own median, so the peers in the same files are the reference; the full-mode 10x/5% rule is unchanged.
- **Gate rule, computed not judged:** a `confirmed` flaky finding (any `flaky_*` kind) or a `confirmed` hollow finding fails; everything else passes. `scripts/gate.mjs` computes it and `validate-findings.mjs` rejects a `findings.json` whose `gate` disagrees.
- **Thresholds** come from the `test_trust:` block of `.agents/config.yaml` when it exists, defaults otherwise; invalid values fall back to the default and are reported (`gate.mjs thresholds`). Reason: D20 puts thresholds in config; a typo must not silently change the gate.
- **A flaky covering test fails the gate even when the change did not introduce the flakiness.** D20 says "changed/covering tests". D14's pre-existing-failure rule is applied to tests that are red at baseline only: they are re-run in a clean worktree at the base, and if they fail there too they are informational. Reason: flaky tests cannot validate a change (decision 34 already excludes them from mutation), whereas a red test is the verify gate's business. Alternative considered: re-running flaky candidates at the base to separate old from new flakiness; rejected as a doubling of the cost for a result the gate would not use.

### Output, lifetime, state (D10)

- **Outside a run** the output folder is `.agents/local/test-trust/<scope-slug>/` (replaces decision 15's `.test-trust/<scope-slug>/`), git-ignored (a one-line `.agents/local/.gitignore` containing `*` is created when the project does not already ignore it, so the project's `.gitignore` is never touched). The first-run question "commit `.test-trust/`?" is gone with it. **Inside a run** it is `.agents/runs/<TASK-ID>/reviews/test-trust/`.
- **Raw evidence is deleted once the report is written.** Only `ledger.md` and `findings.json` stay outside a run (the report was shown in chat); inside a run `REPORT.md` stays and is the `ARTIFACT`. `findings.json` gets `"evidence_pruned": true` after validation, and the validator then skips the existence check but still rejects paths that escape the folder. Reason: D10 keeps only the ledger and findings; re-runs (decision 20) never needed old evidence, only the ledger's commit and the findings.
- **A folder whose findings are all closed deletes itself** (no `confirmed`, no `needs_validation`), also after a first run that found nothing. Reason: D10 says "when a re-run shows all findings closed"; a first run with nothing to track is the same case. `local_state: off` keeps nothing (a temporary folder, deleted at the end).

### Run protocol (D12, D13)

- **Result header** with `ROLE: reviewer`, `FOCUS: tests` for diff mode, `FINGERPRINT`, `ARTIFACT: reviews/test-trust/REPORT.md <sha256>`, a table of the `confirmed` findings with `severity` `blocking` (fails the gate) or `info` (slow), then `BLOCKED_REASON` or `QUESTIONS`. Reason: the BRIEF's table has a severity column and this skill has no severity scale; the two values state only the effect on the gate.
- **Fingerprint** from `.agents/scripts/agent.sh fingerprint` when present, otherwise the `git write-tree` over a temporary index, excluding `.agents/runs/` and `.agents/local/`; taken at the start and again at the end, and a difference is `BLOCKED` ("content changed during the audit"). Reason: a verdict must be bound to the content it measured.
- **Questions** (cost estimate over 15 minutes, first build of the worktree fails) become `NEEDS_INPUT` with numbered questions, never an assumption (D13). The sandbox warning is not repeated inside a run (the ledger records `Sandbox warning: run mode`); it is the run's boot protocol that warns once. *Open point for the lead:* that boot message must exist, otherwise shared rule 9 is not met inside a run.
- **No spawning:** inside a run refutation is a separate pass of the skill itself, never a sub-agent (the lead alone dispatches).

### Schema and validator

- New optional fields: `mode`, `fingerprint`, `evidence_pruned`, `gate`, `scope.diff` (`base`, `thresholds`, `changed_units`, `tests`, `mutants_run`, `not_examined`). In diff mode `gate`, `fingerprint` and `scope.diff` are required; in full mode `gate` and `scope.diff` are forbidden.
- Validator rules beyond the schema (diff mode): the gate equals the computed one, hollow findings name a changed unit, `mutants_run` is within the budget, confirmed slow findings exceed `slow_ratio`, no `carried_forward`. Finding ids are unique in every mode.
- The validator's command-line entry now compares real paths, so it runs when the skill folder is reached through a symlink (the way global installs expose skills). Before, it silently did nothing through a link.

### Fixtures

- `fixtures/test-trust/` holds the original `go/` and `ts/` projects and `EXPECTED.md` unchanged in substance (paths adjusted), plus `diff-setup.sh` (POSIX sh) which builds a base commit and a working-tree "task" in two scenarios (`fail`, `pass`) for each language. `EXPECTED.md` has a "Diff mode" section: which planted test must fail the gate and why, which decoys must not be flagged, what counts as a failure. The mutants and flaky rates were checked by hand against the built repositories; no LLM run (phase 9).
