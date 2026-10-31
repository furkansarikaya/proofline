# ADR 0001 stages: the Node migration, one section per stage

Companion to [0001-node-control-plane.md](0001-node-control-plane.md) (the decision) and [0001-inventory.md](0001-inventory.md)
(what exists). GitHub issues are generated from this file: the epic from [Epic](#epic), one issue per `## Stage N` section with the
fields `Title`, `Version`, `Scope`, `Depends on`, `Acceptance criteria`, `Risks`, `Rollback`, `Estimate`.

Baseline numbers come from the inventory of 0.0.40 ("measured" = counted with a PATH shim; macOS). Every estimate is labelled
"estimate". An "agent-day" is one implementer, test and review cycle of the size this repository's recent patches show (0.0.33:
4,047 inserted lines; 0.0.39: 5,655; 0.0.40: 1,068; about one patch per working day in late October 2026).

## Epic

**Goal.** At the end no shell or awk code with logic remains anywhere in the repository: control plane, adapters, `bin/` (CLI and
`bin/lib`), every skill's `scripts/`, `tests/` (including `tests/ci`), fixtures, and the inline shell of the CI workflow. What remains
are the launchers listed in the ADR, which only start Node. The 132 `agent.sh` commands run as subcommands of one Node entry point,
`proofline-core`, with unchanged arguments, output, exit codes and files; every file format, the run folder, `config.yaml`, task files
and the hash chain stay byte for byte as they are, so a run continues across any upgrade or rollback. Runtime dependencies: Node 22.13
or newer and Node's own libraries; no npm package. Faster: one process per command or hook event instead of 15 to 1,930.

**Stages.** Each stage is its own branch, pull request and patch version, and ends with the real-session smoke.

| order | stage | depends on | estimate (agent-days) |
|---|---|---|---|
| 1 | Equivalence rig, core skeleton, spawn wrapper, ratchet, config commands | - | 6-9 |
| 2 | Read-only commands | 1 | 7-10 |
| 3 | Hooks, approval and answer fast path, git hooks | 2 | 8-12 |
| 4 | Run lifecycle | 2, 3 | 5-8 |
| 5 | Gates, results and reports | 4 | 6-9 |
| 6 | Delivery: deliver, merge, platform and task adapters, CI watching | 5 | 5-7 |
| 7 | Dispatch, batch, worktrees, execution policy | 5, 6 | 6-9 |
| 8 | Discovery, build records and the remaining helpers | 7 | 3-5 |
| 9 | CLI, generators and the shell scripts in skill folders | 8 | 5-7 |
| 10 | Removal of the shell paths | 9 | 3-4 |
| 11 | Test harness, runner, CI scripts and workflow logic | 10 | 4-6 |
| 12 | Control-plane test suites | 11 | 8-12 |
| 13 | Enforcement, invariant, CLI, task, e2e and real-session tests | 11 | 4-6 |
| 14 | Fixtures | 11 | 3-5 |
| 15 | Strict no-shell-logic check and the last shell files | 12, 13, 14 | 1-2 |
| follow-up | Tool-call economy (outside the 15 stages, its own issue; see [Follow-up: tool-call economy](#follow-up-tool-call-economy)): measuring after stage 2, shipping commands and role texts after stage 10 | 2 (measure), 10 (ship) | 3-5 |

Total: 74-111 agent-days (estimate), about 15-23 weeks (estimate) at one patch per working day. Basis: lines to port per stage
(inventory), test volume, recent patch sizes, and a 2-3 agent-day allowance in stage 1 for building the rig and recording traces.
Stages 12, 13 and 14 may run in parallel (they touch different folders).

**Re-plan point after stage 2.** Stages 1 and 2 build the rig and most of the shared library. Before stage 3 starts, their measured
effort, CI time and trace volume are compared with the estimates here, and stages 3-15 are re-estimated (and re-ordered if needed) in a
decision entry.

**Common acceptance criteria.** Every stage's own criteria include these; the stage sections refer to them as C1-C8.

- **C1 Equivalence.** Every command the stage moves has scenario cases and trace cases in `tests/equivalence/`; the `equivalence` CI
  job is green on Linux and the nightly full replay is green on Linux and macOS; the alternating-engine lifecycle case is green; no
  normalisation rule was added without the maintainer's approval (stages 1-10).
- **C2 Invariants and the safe side.** `sh tests/invariants/invariants-test.sh` passes unchanged with the default engine and with the
  engine switch set to `sh` (stages 1-9; default only from stage 10). Nothing under `tests/invariants/` and nothing in `test-lib.sh`
  (which the suite sources) changes before stage 13 (`test-lib.sh`: before 15). The rig's "Node absent" case is green: with `node`
  removed from PATH, every guard that needs a moved command denies during a run, `agent.sh` exits non-zero and a commit is blocked;
  the enforcement suite has the same case for the hook.
- **C3 Tests.** The full self-test (16 shards), the Node tests, the fixtures job and the static job (including the shell-allowlist
  ratchet and the type check) are green.
- **C4 Performance.** The pull request description has a before/after table (processes and wall time) for the paths named in the
  stage, measured with the benchmarks named there; the process count after is not higher than before on any named path; bench budgets
  are set to the measured value after the change plus a margin (as A203 did).
- **C5 Smoke.** `sh tests/real-session/smoke.sh` (later its Node form) is all PASS on the last commit, with the steps named in the
  stage; the table is in the description.
- **C6 Rollback.** The stage's rollback path is shown: with `sh` in `.agents/local/engine` the stage's suites pass through
  `tests/affected.sh`, and a hook process started by the runtime sees the switch (stages 1-9); the downgrade test passes (a project of
  this stage, with a run in flight, upgraded from the previous release's checkout continues the run).
- **C7 Records.** A decision entry `A<n>` (citing A204) for the stage; no environment test seam is added (D14); the version is raised with
  `tests/ci/bump-version.sh`; the CHANGELOG entry names the moved commands.
- **C8 Documentation.** CONTRIBUTING, the README and `docs/concepts` updated where the stage changes what a user needs or types.

**Exit criteria of the epic.**

1. `tests/ci/no-shell-logic.mjs` is strict and green: the only shell files are the launchers, each equal to its template; the hook
   command strings equal their templates; every CI `run:` step is one command line.
2. All 132 commands run in Node; `agent.sh` and `dispatch.sh` are launchers; `ecosystems.tsv` and every `ecosystems.sh` are gone.
3. The Node copy of the Core invariant suite is green on Linux, macOS and Windows; the shell copy is removed.
4. A run started on 0.0.40 continues on the final version (a recorded fixture run is carried across).
5. The final before/after table: the hook events, `next` at 0/20/60 changed files, `publish-completion-report`, `record`, the
   101-call scenario, and the self-test wall time per shard, against the 0.0.40 baseline.
6. CONTRIBUTING and the README state Node 22.13 as a runtime requirement and the Windows status the Windows CI jobs prove.

## Command map

Every `agent.sh` command and the stage that moves it (132 in total). Commands in one stage move together; a command moves as a whole.

| stage | commands |
|---|---|
| 1 (10) | `role` `config-get` `config-check` `timeouts` `hook-timeouts` `verify-timeout` `tm-scaled` `db-config` `hook-config` `help` |
| 2 (41) | `status` `open-runs` `effective` `fingerprint` `pipeline` `next` `summary` `plan-section` `digest` `debt` `design-surface` `report-facts` `report-execution` `repro-normalize` `design-rationales` `report-tokens` `verify-freeze` `verify-scope` `verify-knowledge-scope` `freshness` `verify-handoff` `entry-tier` `verify-qa-plan` `verify-worker-evidence` `questions` `batch-check` `commands-check` `scale-check` `test-path` `task-scope-entries` `scope-covers` `task-type` `human-checks` `scope-kinds` `path-kind` `patch-fingerprint` `verify-gates` `verify-seal` `ci-check` `ci-task-command` `validate` |
| 3 (13) | `next-user` `worktree-root` `in-knowledge-scope` `request-approval` `approve` `approve-pending` `approval-consume` `answer` `hook-time` `language-check` `friction-note` `window-open` `window-close` |
| 4 (22) | `baseline` `discard-stray` `branch` `start` `classify` `tier` `freeze` `refreeze` `verify-assumptions` `handoff` `delivery-check` `db-check` `ask` `terminate` `amend` `reopen` `cleanup` `status-block` `tree-inspect` `tree-accept` `task-source-status` `task-source-relocate` |
| 5 (10) | `worker-evidence` `submit` `record` `gate` `secret-scan` `raise-budget` `waive` `knowledge-done` `publish-completion-report` `verify-completion-report` |
| 6 (8) | `deliver-plan` `deliver-step` `deliver-merged` `pr-state` `task-source-done` `platform` `platform-warn` `batch-ci` |
| 7 (22) | `decide` `run-language` `metrics-dispatch` `wait-line` `ledger-note` `worktree-add` `worktree-path` `worktree-remove` `batch-plan` `batch-cover` `batch-status` `batch-answer` `batch-answers` `batch-next` `batch-awake` `batch-park` `task-rename-plan` `task-rename-apply` `known-issue-propose` `known-issue-apply` `known-issue-list` `known-issue-candidates` |
| 8 (6) | `build-record` `friction` `calibrate` `lessons` `rules` `test` |

## Stage 1

- **Title:** Node migration 1/15: equivalence rig, `proofline-core` skeleton, spawn wrapper, shell ratchet and the config commands
- **Version:** 0.0.x
- **Scope:**
  - `control-plane/agents/scripts/proofline-core.mjs` and `core/`: `proc.mjs` (the spawn wrapper and its counter), `errors.mjs`,
    `paths.mjs`, `clock.mjs`, `hash.mjs`, `lock.mjs` (the `mkdir` protocol), `config.mjs`, `context.mjs`; the command table with the
    role gate (`valid_role`, `cmd_allowed`, the read-only list) and the locking rule of `agent.sh` (bootstrap, locks, config and CLI
    sections: about 680 lines of `agent.sh`, inventory).
  - Commands moved (10): `role`, `config-get`, `config-check`, `timeouts`, `hook-timeouts`, `verify-timeout`, `tm-scaled`, `db-config`,
    `hook-config`, `help` (the usage text keeps omitting the same 16 commands).
  - `agent.sh` delegation preamble (before any parsing); the engine switch read from `.agents/local/engine` (`sh` or
    `sh:<command>,...`; the main tree's file in a worktree) and from `PROOFLINE_ENGINE` / `PROOFLINE_ENGINE_SH` (CI), either forcing
    `sh` wins; `doctor` prints it; the bridge from the core to unmoved commands. No clock or other environment test seam (D14).
  - The shell hook fails closed on a moved command (ADR section 5.3): where it now drops a failure of `hook-config`, `db-config` or
    `config-get` (`proofline-hook.sh` lines 959, 977, 1331), it denies while a run exists when the command exits 127 or non-zero, with a
    message that names the command and Node 22.13; the merge guard denies the same way in an installed project also without a run.
  - `tests/equivalence/`: rig, closed normalisation list (times masked only after their format and order checks; hashes derived from times, such as
    ledger `prev=`, binding tokens, `gate_record_sha256` and summary-bound values, masked only after each side re-verifies them) with its
    planted-difference tests, the trace recorder (`PROOFLINE_TRACE`), scenario cases, the alternating-engine case, the "Node absent"
    case; a CI job `equivalence`.
  - `tests/bench/agent-procs.mjs`: the inventory's PATH-shim command benchmark committed, with the 0.0.40 baseline as a data file; it
    also records the stdout bytes of every command on its fixtures (the basis of the output budgets, ADR section 8.3).
  - `tests/ci/no-shell-logic.mjs` in ratchet mode with `tests/ci/shell-allowlist.txt` (every shell file of 0.0.40) and
    `tests/ci/inline-shell-snapshot.txt` (every `run:` step of `ci.yml` and every hook command string of the three wiring files, by
    location and SHA-256); entries may only disappear, and a new or changed step or string must already meet the strict rule.
  - Type checking: `jsconfig.json` and a CI job that runs a pinned checker and pinned Node type definitions, fetched in that job only.
  - A differential test of the two ecosystem glob implementations (awk `g2re` against `globToRegExp`) over a path and pattern corpus.
  - Hook tripwires (the hook is still shell): deny a model command that starts Node and loads the core in any visible spelling (a path to
    `proofline-core.mjs` or `.agents/scripts/core/`; `node -e`/`--eval`/`-p`/`--print`; `--input-type=module` with stdin code;
    `--import`/`--require`/`-r`/`--loader`; `env node`; `npx node`; a variable holding `process.execPath`; whenever the text names
    `.agents/scripts` or `proofline-core`), and a model command that assigns `PROOFLINE_ENGINE*` or `PROOFLINE_TEST*` (scope: the model's
    own Bash command text in an installed project with an open run; suites and scripts that set the existing seams inside themselves,
    the repository's own test runs, CI and the user's terminal are not affected; ADR section 5.3). These are tripwires
    (`.out-of-scope/small-rejected-ideas.md`); the boundary stays that `approve` records only from a captured user message.
  - `frontmatter.test.mjs` checks documented commands against the core's command table (all 132 entries) instead of `agent.sh` text.
  - A downgrade test: a project installed from this stage's checkout, with a run in flight, is upgraded from the previous release's
    checkout (`proofline upgrade` installs the tree of the checkout it runs from; verified in `bin/lib/install.sh`), and the run continues.
  - `proofline doctor` and `proofline init` check Node 22.13 (in `bin/lib/doctor.sh` and `install.sh`, ported in stage 9); CI tests
    Node 22.13.0 and the current active LTS; CONTRIBUTING and the README say Node 22.13 is a runtime requirement.
  - Installer: copy `proofline-core.mjs` and `core/` into `.agents/scripts/` and the manifest.
- **Depends on:** nothing.
- **Acceptance criteria:**
  - C1-C8.
  - The rig reports every planted difference (one byte of a ledger `detail=`, an exit code, a missing file, a mode bit, a changed hash
    next to a masked value) and passes on identical runs. It also reports: an `approved_at` earlier than its `requested_at`, a
    `consumed_at` before `approved_at`, a decreasing ledger epoch, a `ts=` and `epoch=` that name different seconds, a malformed ISO time,
    events in a different order on the two sides, and a binding token or `gate_record_sha256` that does not match its own side's file.
  - The role table test: every role against every one of the 132 commands gives the same allow/deny on both engines.
  - Lock interop: an old-engine and a new-engine process contend for the same lock and exclude each other; a stale lock is broken with
    the same `lock-break` ledger event.
  - The glob differential test passes on the whole corpus.
  - Node absent (C2): with `node` removed from PATH and a run open, the shell hook denies a Bash call (database guard) and a file write
    (database guard), and denies `git push origin main` (merge guard); without the change, the same cases are allowed (the test fails on
    0.0.40-style fallback).
  - Seam safety: with no fixture stub present, setting every `PROOFLINE_TEST*` and `PROOFLINE_ENGINE*` value leaves SECRETS results,
    execution-policy decisions and approval results unchanged (both engines).
  - Enforcement: one case per tripwire spelling above is denied for a model role and allowed for the user's own terminal; `agent.sh approve`
    keeps its deny.
  - The ratchet fails on a planted new shell file, a planted new multi-line `run:` step and a planted changed hook string.
  - The downgrade test passes.
  - Performance (before -> after, `tests/bench/agent-procs.mjs` and `sh tests/bench/hook-procs.sh`): `config-get` 3 processes / 0.1 s
    (measured); `hook-config` 1 process / 0.3 s, the 0.3 s being the shell's start on the 9,170-line file (measured). Target (estimate):
    `hook-config` at most 2 processes (`sh` exec and `node`) and below 0.1 s; hook events unchanged or lower. `node -e 0` start time
    recorded on Node 22.13 and the active LTS, on Linux, macOS and `windows-latest`, as the reference for later stages (about 28 ms was
    measured once on a macOS machine with Node 24.14.1 while writing the plan).
  - Smoke: the default run (setup, doctor, `/proofline run`, `/proofline deliver`, `/proofline batch T-2 T-3`, skill-tool rows), and
    `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** the trace recorder makes CI slower (mitigation: replay only touched commands per pull request, full replay nightly);
  the config parser has edge cases (block lists under `commands.*`, quotes, octal-looking numbers stripped by `dec0`) that the rig must
  cover; the checker download is a CI-only dependency.
- **Rollback:** `sh` (or `sh:hook-config,...`) in `.agents/local/engine` (`PROOFLINE_ENGINE=sh` in CI); the previous release installed
  with `proofline upgrade` from its checkout; a revert.
- **Estimate:** 6-9 agent-days (estimate). Basis: about 1,500-2,500 new lines (rig, wrapper, libraries, bench, ratchet) and about 680
  ported lines (4-6 days), plus 2-3 days for building the rig and recording and storing the traces; the config family has few tests of
  its own but every suite uses it.

## Stage 2

- **Title:** Node migration 2/15: read-only commands (`status`, `next`, `digest`, `summary`, `pipeline`, the `verify-*` family, insights, debt, queue)
- **Version:** 0.0.x
- **Scope:**
  - Commands moved (41): see [Command map](#command-map), stage 2. Handler lines about 924; with the shared helpers they need (RUN.yaml
    access, baseline and path fingerprints, content fingerprint, pipeline, tier and risk signals, gate-record evaluation, ledger seal,
    `next` state machine) about 3,500 lines of `agent.sh` (estimate from the inventory's area table).
  - `scripts/debt.sh` (77) as `debt`; the logic of `bin/lib/insights.sh` (298) and of `proofline queue` as core subcommands (the CLI
    front ends stay until stage 9).
  - Kept exactly: `next` and `pipeline` remove stale dispatch markers; `summary` and `next` append to the fingerprint cache; output lines
    that other tools parse (`next`: `task=`, `state=`, `handoff=`, `next=`, `reason=`, `note=`; `pipeline`: `focus.<GATE>.<focus>=`;
    `summary` line 1 `STATUS: ...`).
  - One baseline map per invocation (removes the paths-times-entries loop); path fingerprints with `fs` and `node:crypto`; `verify-seal`
    in one pass.
  - Ecosystem-branching check for Node: `tests/shared/check-static.sh` rule 5 (lines 122-125) reads ids from `ecosystems.tsv`, passes when
    the file is missing and scans shell only. This stage adds a Node check over the core, hook and CLI `.mjs` that reads
    `ecosystems.json` and fails when it is missing, and changes rule 5 to fail, not pass, when its data file is missing. Both run in the
    static job from here on, before anything deletes the TSV (stage 10).
  - Golden tests recorded from the old engine, added beside the extraction tests (which keep testing the old code until stage 10):
    `risk_words_match` (`risk-test.sh` 830, 867) and the `next` output order (`proofline-lead.test.mjs` 350, 370).
  - The re-plan point of the epic follows this stage.
- **Depends on:** stage 1.
- **Acceptance criteria:**
  - C1-C8. Trace cases cover every gate state of the `gates-test` and `risk-test` fixtures and the scaling fixture.
  - The Node ecosystem check fails on a planted `case` arm that names an ecosystem id in a core module and on a missing
    `ecosystems.json`; rule 5 fails on a missing `ecosystems.tsv`.
  - Tool-call economy (ADR section 8.3): `tests/bench/output-budgets.tsv` holds the named maximum stdout bytes per command class, set
    from stage 1's measurement (HOT: `next`, `summary --status`, `report-tokens`; STEP read: `pipeline`, `digest`, the `verify-*` family,
    `questions`, per fixture state); every command moved here stays within it on the fixtures (equivalence keeps the bytes; the budget
    keeps later changes from growing them).
  - The `perf-test.sh` budgets (`next` at most 260, `digest` at most 340 processes) hold, then are lowered to the measured value plus
    margin.
  - Performance (before measured, target estimate), with `perf-test.sh` (`PERF_REPORT=1`) and `tests/bench/agent-procs.mjs`:
    `next` 68-193 processes / 2.3-4.6 s at 0 extra changed files (the 2-file fixture) and 1,930 / 18.3 s at 60 -> target at most 10 processes at any file count and
    under 1 s at 60 files; `digest` 129-225 / 3-5 s -> at most 12; `summary` (full) 346-665 / 8.5-14.2 s -> at most 12; `pipeline`
    208-364 / 3.8-5.4 s -> at most 10; `verify-seal` 67 processes at 63 ledger lines -> no child process at any length;
    `patch-fingerprint` 490 and `verify-scope` 438 at 60 files -> at most 6; `report-facts` 200 / 3.4 s -> at most 8; `proofline status`
    126 (measured; the CLI is still shell) -> recorded.
  - Smoke: the default run; `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** `next` reads about 15 kinds of run files and calls more than 60 helpers, so trace coverage matters more than scenario
  coverage; byte-order sorting and byte lengths must match the shell under `LC_ALL=C`; the fingerprint cache key uses nanosecond times
  and inodes (masked by the rig, but the cache must still hit the same entries).
- **Rollback:** the engine switch: `sh` (or `sh:<command>,...`) in `.agents/local/engine`, read by every command and hook event
  (`PROOFLINE_ENGINE=sh` in CI); or the previous release installed with `proofline upgrade` from its checkout (the downgrade test of
  stage 1); or a revert.
- **Estimate:** 7-10 agent-days (estimate). Basis: about 3,500 lines of helpers and handlers plus 375 lines of `debt.sh` and
  `insights.sh`; these helpers are reused by every later stage, so this stage carries most of the shared library.

## Stage 3

- **Title:** Node migration 3/15: hooks as one Node process per event, the approval and answer fast path, git hooks
- **Version:** 0.0.x
- **Scope:**
  - `adapters/claude/hooks/proofline-hook.sh` (2,609 lines) -> `proofline-hook.mjs`, one Node process per event, importing the project's
    core in process; the 290-line awk shell-command scanner becomes a tokenizer module with its own tests; process budgets and timeouts
    with timers and `AbortSignal` instead of `ps` tree walks; Windows input paths (`C:\...`, `/c/...`) handled in `paths.mjs`.
  - Commands moved (13): `next-user` (with `scripts/next-user.sh`, 274), `worktree-root`, `in-knowledge-scope`, `request-approval`,
    `approve`, `approve-pending`, `approval-consume`, `answer`, `hook-time`, `language-check`, `friction-note`, `window-open`,
    `window-close`. About 1,200 lines of `agent.sh` (estimate: approvals, prompt captures, language scan, windows).
  - The capture contract kept byte for byte: the intake copy, `prompts/<session>.json` (`{"session","time","sha256","text"}`), the history
    copy, the capture id `<session>:<time>:<sha>`, the single-use rule, and the Stop hook's reading of the same file.
  - Golden capture fixtures committed (`tests/golden/capture/`): the prompt corpus and, per prompt, the exact capture, intake and history
    bytes written by the old hook (times and pids taken from a recorded event, so the bytes are fixed); the Node hook's tests compare
    against them from now on, after the rig is gone too.
  - Golden test for `approval_phrases` (recorded from the old engine), beside `reply-loop-test.sh`'s extraction, which keeps testing the
    old code until stage 10.
  - The wiring strings in `hooks.json`, `settings.fragment.json` and `codex/hooks.json` change to the pinned Node templates, all three with
    the PreToolUse fail-closed guard (a failed start exits 2; the plugin form gains it); the install merge (`bin/lib/install.sh`) learns the
    old `sh -c` strings and replaces them; the Node hook yields when an old shell wiring for the same event is in the same settings file.
    The ratchet snapshot is updated with the new strings, which meet their templates.
  - The Node hook keeps the stage-1 tripwires (core-loading Node spellings, `PROOFLINE_ENGINE*` and `PROOFLINE_TEST*` assignments) and
    reads the engine switch from `.agents/local/engine`.
  - `githooks/pre-commit` and `pre-push` become launchers (`#!/bin/sh` and one `exec node` line) of core subcommands; `human.sh` (14)
    moves into the core; `delivery-check` is reached through the bridge until stage 4.
  - `doctor` verifies all 7 hook events (it checks 6 today; Stop is never checked).
  - A `windows-latest` CI job runs the hook tests (`node:test`) and the hook benchmark (Node form), replacing the Git Bash timing job's
    role for the hook.
- **Depends on:** stage 2 (the hook calls `next`, `summary`, `report-tokens`, `hook-config`).
- **Acceptance criteria:**
  - C1-C8.
  - Capture corpus: for every prompt in the corpus (Unicode, quotes, backslashes, CR, tabs, control bytes, Turkish letters, a long text,
    a `<task-notification>` prompt that must be ignored) the old and the new hook write byte-identical capture, intake and history files.
  - The golden capture fixtures are committed and the Node hook matches them byte for byte.
  - Cross-version approval: the old `approve` accepts every capture the new hook writes and refuses what it refused before; the new `approve`
    does the same with old captures; replies with several approvals, hedged replies and replies older than the request behave identically.
  - Node absent (C2): with `node` removed from PATH, each of the three hook forms blocks PreToolUse with exit 2 (start failure), during a
    run and, for the project and Codex forms, whenever `.agents/config.yaml` exists; the enforcement suite has these cases.
  - Enforcement keeps the tripwire cases of stage 1 green against the Node hook.
  - Tool-call economy: the context text the hook adds (SessionStart, the Stop hook's `Next step:` line from `next-user`, PostToolUse
    relays) stays within the context budget of `tests/context/budget.tsv` and within its output budget in `tests/bench/output-budgets.tsv`.
  - Deny texts identical: `tests/enforcement` (enforcement, kill-guard, merge-guard, approval-load, timeouts) pass unchanged against the new
    hook; the PreToolUse fail-closed cases (unparsable JSON during a run, malformed ACTIVE_RUN, missing hook file with config present) still
    deny or block.
  - Upgrade and rollback wiring: `init` over a 0.0.40 project leaves exactly one hook per event; a 0.0.40 `upgrade` over the new project
    leads to the Node hook yielding, so each event is handled once.
  - Performance with `sh tests/bench/hook-procs.sh` (REPEAT=3, median; before measured, target estimate): PreToolUse Bash 39-45 processes
    / 688 ms -> at most 3 and 150 ms; Read 15 / 505 ms -> 1; Write 17 / 530 ms -> at most 2; PostToolUse 13 / 172 ms -> 1; prompt 17 /
    220 ms -> 1; **prompt that records an approval 544 / 3,370 ms -> at most 5 and 500 ms**; Stop 40 / 416 ms -> at most 3; SessionStart
    130 / 3,254 ms -> at most 8 and 1 s; SubagentStart 67 / 852 ms -> at most 6; SubagentStop 20 / 202 ms -> at most 3; `git commit`
    15 (+ about 7 git) and `git push` 9 (+ about 3 git) without a run -> one Node process plus the git calls. The Windows job records its
    numbers in the job summary.
  - Smoke: the default run; `SMOKE_ONLY=codex`; `SMOKE_ONLY=a200` (an approval answered in the pre-flight); the rtk pass when rtk is
    installed; `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** the capture bytes (mitigated by the corpus and cross-version tests); how each runtime runs hook strings on Windows is unknown
  (the job decides the string forms, and the README keeps "WSL or Git Bash" until the job passes); Node start-up in the hook (lazy
  imports, compile cache, budget in the benchmark); the scanner's tokenizer is security-relevant: every scanner case of the enforcement
  suite must keep its verdict.
- **Rollback:** `sh` in `.agents/local/engine` (read by the hook process the runtime starts, unlike a shell `export`) makes the Node
  hook hand the event to the kept `proofline-hook.sh` (one extra process, rollback only) and the git hook launchers run the old code;
  `proofline upgrade` from the previous release's checkout restores the old wiring (the old merge adds its string and the Node hook
  yields); a revert.
- **Estimate:** 8-12 agent-days (estimate). Basis: 2,609 hook lines with the largest single port item (the scanner), about 1,200
  `agent.sh` lines, 274 lines of `next-user.sh`, 121 git-hook lines, the capture corpus, and 2,465 lines of enforcement tests to keep green.

## Stage 4

- **Title:** Node migration 4/15: run lifecycle (`start`, `classify`, `freeze`, `handoff`, `terminate`, `cleanup` and the rest)
- **Version:** 0.0.x
- **Scope:**
  - Commands moved (22): see [Command map](#command-map), stage 4. Handler lines about 690; with the freeze, task-source contract, handoff
    ladder, database guard, archive and status-block code about 2,000 lines of `agent.sh` (estimate).
  - The task adapter (`markdown.sh create|import|status|statusblock`) is reached through the bridge until stage 6; `freeze` keeps running
    `validate-plan.mjs` with `node` when installed.
  - The status block keeps its best-effort, time-bounded update (today a background subshell polled with `kill -0`) with a timer.
  - `archive_run` keeps `tar` (member list and bytes compared by the rig).
  - Golden tests recorded from the old engine, beside the extraction tests (which keep testing the old code until stage 10): `sb_scrub`,
    `sb_strip` and the `SB_KEYS` list (`status-block-test.sh`), and the freeze messages that `plan-contract.test.mjs` reads from
    `agent.sh` text.
- **Depends on:** stages 2 and 3.
- **Acceptance criteria:**
  - C1-C8. The alternating-engine case runs a full lifecycle from `start` to `cleanup` with engines alternating per call.
  - A run started on 0.0.40 (a recorded fixture at IMPLEMENTED) continues to DONE on this stage, and a run started on this stage continues
    on 0.0.40 (the engine switch set to `sh`, and the 0.0.40 release installed by the downgrade path).
  - Performance (`tests/bench/agent-procs.mjs`; before measured, target estimate): `handoff` IMPLEMENTED 216 / 3.8 s, CODE_DONE 391 / 7.1 s,
    DONE 568 / 11.5 s -> at most 15 each (git and the node validators); `freeze` 202 / 2.9 s -> at most 8; `classify` 50 / 1.3 s -> at most 4;
    `tier` 58 / 1.0 s -> at most 4; `baseline` 31 / 0.6 s -> at most 4; `delivery-check` 89 / 2.6 s -> at most 6; `db-check` 18 / 0.4 s ->
    1 (one process, no `find`).
  - Smoke: the default run; `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** the five places where the shell works around `set -e` (background subshells, nested `sh agent.sh` re-invocations) must become
  explicit result checks without changing which errors stop a command; freeze escalates classification and consumes approvals, so
  ordering of writes matters (the rig compares the files after each call).
- **Rollback:** the engine switch: `sh` (or `sh:<command>,...`) in `.agents/local/engine`, read by every command and hook event
  (`PROOFLINE_ENGINE=sh` in CI); or the previous release installed with `proofline upgrade` from its checkout (the downgrade test of
  stage 1); or a revert.
- **Estimate:** 5-8 agent-days (estimate). Basis: about 2,000 lines; `lifecycle-test` (1,545 lines, 68 units) is the main proof.

## Stage 5

- **Title:** Node migration 5/15: gates, results and reports (`record`, `submit`, `gate`, `secret-scan`, `waive`, `publish-completion-report`, ...)
- **Version:** 0.0.x
- **Scope:**
  - Commands moved (10): `worker-evidence`, `submit`, `record`, `gate`, `secret-scan`, `raise-budget`, `waive`, `knowledge-done`,
    `publish-completion-report`, `verify-completion-report`. Handler lines about 890; with the result protocol (844), the submission
    section and the completion-report code about 2,300 lines of `agent.sh` (estimate).
  - `scripts/secret-scan.sh` (64) into the core; `submit` calls `record` in process (today a nested `sh agent.sh record`);
    `publish-completion-report` calls `freshness` in process.
  - No environment seam (D14): the stub that `test-lib.sh` writes stays a fixture file. While `.agents/scripts/secret-scan.sh` exists in
    the project the core runs it, exactly as `agent.sh` does today; the installer stops shipping it, so only a fixture that writes one
    gets it. `test-lib.sh` and `tests/invariants/` are not edited.
  - Golden test for `blocking_rule_version` (recorded from the old engine), beside the `gates-test.sh` line 511 text read, which keeps
    testing the old code until stage 10.
  - The task adapter's `publish` and `verify` are reached through the bridge until stage 6.
- **Depends on:** stage 4.
- **Acceptance criteria:**
  - C1-C8. Trace cases include every `record` refusal of `gates-test` (98 units) and every waiver case (SECRETS and SECURITY refused).
  - Seam safety (as in stage 1): without a fixture stub, no `PROOFLINE_TEST*` value changes a SECRETS result.
  - Performance (`tests/bench/agent-procs.mjs`; before measured, target estimate): `record` 449-459 / 8.0-8.3 s -> at most 15 (git, node
    validators); `secret-scan` 280 / 5.6 s -> at most 6; `publish-completion-report` 1,754 / 34 s -> at most 20; `worker-evidence` 67-92 /
    1.1-1.2 s -> at most 6; `knowledge-done` 97 / 2.1 s -> at most 8.
  - Smoke: the default run; `SMOKE_ONLY=a200` (the test-only fix round without SECURITY); `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** `record` validates specialist text with long awk blocks (150-line programs) whose exact acceptance must be kept, including
  the language check of quoted user text; the gate record and manifest bytes feed the hash chain.
- **Rollback:** the engine switch: `sh` (or `sh:<command>,...`) in `.agents/local/engine`, read by every command and hook event
  (`PROOFLINE_ENGINE=sh` in CI); or the previous release installed with `proofline upgrade` from its checkout (the downgrade test of
  stage 1); or a revert.
- **Estimate:** 6-9 agent-days (estimate). Basis: about 2,300 lines; the heaviest validation logic of the control plane.

## Stage 6

- **Title:** Node migration 6/15: delivery (deliver, merge, platform and task adapters, CI watching)
- **Version:** 0.0.x
- **Scope:**
  - Commands moved (8): `deliver-plan`, `deliver-step`, `deliver-merged`, `pr-state`, `task-source-done`, `platform`, `platform-warn`,
    `batch-ci`. With the CI visibility and delivery section (754) about 1,000 lines of `agent.sh`.
  - `scripts/platform.sh` (230); `bin/lib/merge.sh` (256) as a core subcommand (the `proofline merge` front end moves in stage 9);
    the CI part of `scripts/batch.sh`.
  - Task adapters (762 lines): `markdown.sh`, `github.sh`, `jira.sh`, `linear.sh`, `_lib.sh`, `slug.sh` -> `.mjs` with the same operations,
    exit codes and receipts; `slug` keeps its letter table; `jira` and `linear` use `fetch` instead of `curl` and `jq` (still not tested
    against a real service). A user-written `task-integrations/<name>.sh` is still run through `runUserCommand`, which is also how the
    markdown stub that `test-lib.sh` writes into fixtures keeps working (no environment seam, D14).
  - `gh`, `glab`, `az` through `proc.mjs`, with the A180 refusal of a tool that resolves into the project or a temporary folder, and
    Windows `.cmd` shims handled.
- **Depends on:** stage 5.
- **Acceptance criteria:**
  - C1-C8. Trace cases from `deliver-test` (30 units), `cifix-test`, `tasks-test` (fake `gh` and `curl`) and `platform-test`.
  - `proofline merge` still merges only when every check of the pull request is SUCCESS on its current head (A136); the runtime hook's
    merge guard is unchanged.
  - Performance: before measured in this stage with `tests/bench/agent-procs.mjs` and fake platform tools (the inventory did not measure
    `deliver-*`); `platform` 13 processes (measured) -> at most 2 (git, or none with a cached remote); `deliver-plan` and `deliver-step`
    after not higher than before; `batch-ci` polling no more often than today.
  - Smoke: the default run (deliver and batch reach the local origin); `SMOKE_ONLY=a202` with the default engine (status block, branch
    slug) and with `sh` in `.agents/local/engine`.
- **Risks:** platform CLIs differ per host and are mostly tested with fakes; `deliver-merged --check` fetches from the network even in
  read-only use (kept); the receipts' hashes must stay byte-identical.
- **Rollback:** `sh` in `.agents/local/engine` (the shell adapters stay in place for the fallback until stage 10); the previous release
  installed with `proofline upgrade` from its checkout; a revert.
- **Estimate:** 5-7 agent-days (estimate). Basis: about 1,000 lines of `agent.sh` plus 1,250 lines of scripts and adapters.

## Stage 7

- **Title:** Node migration 7/15: dispatch, batch, worktrees and execution policy
- **Version:** 0.0.x
- **Scope:**
  - Commands moved (22): see [Command map](#command-map), stage 7. About 600 lines of `agent.sh` (night mode, task rename, known issues,
    decide, worktrees).
  - `scripts/dispatch.sh` (610) -> core subcommand `dispatch`; `dispatch.sh` becomes a launcher. The watchdog keeps its semantics: the
    runtime as a child in its own process group, TERM at the timeout, KILL 5 s later, signal forwarding on HUP, INT and TERM, the
    window bracket for the implementer, failover, network retry, resume notes. Windows kills the tree with `taskkill /T`.
  - The nonce: the dispatcher calls `decide` in process; the `decide` command with a nonce keeps checking a live ancestor (Linux `/proc`,
    macOS `ps`); on Windows it fails closed unless called in process.
  - `scripts/exec-policy.sh` (302), `runtime-detect.sh` (37), `batch.sh` (728, the rest), `worktree-prep.sh` (114), `known-issues.sh`
    (194). The exec-policy stub that `test-lib.sh` writes stays a fixture file: while `.agents/scripts/exec-policy.sh` exists in the
    project the core runs it, as `agent.sh` does today; no environment seam (D14). Seam safety test: without a stub, no `PROOFLINE_TEST*`
    value changes an execution-policy decision.
- **Depends on:** stages 5 and 6 (dispatch records results and the batch watches delivery).
- **Acceptance criteria:**
  - C1-C8. `dispatch-test` (watchdog and timeouts), `batch-test` (34 units, sleep inhibitor, wrapper agent), `exec-policy-test`,
    `known-issues-test` pass unchanged.
  - Watchdog cases with fake runtimes: one that ignores TERM (killed after 5 s), one that hangs, one that exits early, one that spawns
    grandchildren (all killed), a signal to the dispatcher (forwarded); identical records on both engines.
  - Known-issue approvals bound to the exact TSV row bytes accept and refuse identically.
  - Tool-call economy: the read-oriented batch commands (`batch-status`, `batch-next`, `batch-answers`, `known-issue-list`) stay within
    their output budgets in `tests/bench/output-budgets.tsv`.
  - Performance: before measured in this stage with a fake runtime (`decide` estimated at 100-150 processes by the inventory); target
    (estimate): `decide` at most 3, the dispatcher's own overhead (without the runtime child) at most 10, `batch-next` (3 processes
    measured) at most 1.
  - Smoke: the default run; `SMOKE_ONLY=codex`; `sh tests/real-session/codex-sandbox.sh` (the Codex permission profile is built by the
    dispatcher); `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** process-group behaviour differs between platforms; the nonce check on macOS still needs `ps`; the Codex profile arguments
  must stay byte-identical (A199, A203 item 1).
- **Rollback:** `sh` in `.agents/local/engine` (the `dispatch.sh` launcher runs the kept shell dispatcher); the previous release
  installed with `proofline upgrade` from its checkout; a revert.
- **Estimate:** 6-9 agent-days (estimate). Basis: about 2,600 lines including the repository's heaviest process management.

## Stage 8

- **Title:** Node migration 8/15: discovery, build records, friction, lessons, rules and the remaining helpers
- **Version:** 0.0.x
- **Scope:**
  - Commands moved (6): `build-record`, `friction`, `calibrate`, `lessons`, `rules`, `test` (the last runs the shell suites as child
    processes until stage 12).
  - `scripts/build-record.sh` (178), `friction.sh` (134), `lessons.sh` (178), `rules.sh` (121); `bin/lib/discover.sh` (546, including
    `run_with_timeout` with process-group kill instead of `set -m`, `setsid`, perl and python3 fallbacks), `bin/lib/commands.sh` (74),
    `bin/lib/timeouts.sh` (78), `bin/lib/context-size.sh` (98, which stops reading the hook source with `sed`).
  - After this stage every one of the 132 commands runs in Node.
- **Depends on:** stage 7.
- **Acceptance criteria:**
  - C1-C8. `build-record-test`, `friction-test`, `lessons-test`, `rules-test`, `debt-test`, `tests/cli/discover-*`, `tests/context/*` pass
    unchanged.
  - `build-record` still runs each configured command with its full output kept (evidence is never compressed); its summary to the
    context (`show`) and the read-oriented `friction show`, `rules list` and `calibrate` stay within their output budgets.
  - Performance: before measured in this stage (`build-record`, `doctor --commands`, `context-size`); after not higher; `friction`,
    `calibrate`, `lessons`, `rules` (3 processes each, measured) -> 1.
  - Smoke: the default run; `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** discovery trial-runs user commands with a timeout: the process-group kill must stop the whole tree on every platform.
- **Rollback:** the engine switch: `sh` (or `sh:<command>,...`) in `.agents/local/engine`, read by every command and hook event
  (`PROOFLINE_ENGINE=sh` in CI); or the previous release installed with `proofline upgrade` from its checkout (the downgrade test of
  stage 1); or a revert.
- **Estimate:** 3-5 agent-days (estimate). Basis: about 1,400 lines, mostly self-contained scripts with their own suites.

## Stage 9

- **Title:** Node migration 9/15: the CLI (`bin/`), the generators and the shell scripts in skill folders
- **Version:** 0.0.x
- **Scope:**
  - `bin/proofline` (369) becomes a Node launcher (`#!/usr/bin/env node` and one dynamic import of `bin/lib/proofline.mjs`); new
    `bin/proofline.cmd` for Windows; `bin/lib/install.sh` (495), `doctor.sh` (412), `config.sh` (134, the second config parser goes) and the
    front ends of `insights`, `queue`, `merge`, `debt` and `status` -> `bin/lib/*.mjs`. JSON merging of hook settings without `jq`.
  - `adapters/generate.sh` (304) and `docs/reference/generate-skills.sh` (38) -> `.mjs` with the same output and `--check`;
    `adapters/codex/install.sh` (59) -> `install.mjs` (linking without relying on `ln -s` on Windows).
  - Skills: `performance-proof/scripts/run-bench.sh` (154) -> `run-bench.mjs` (same CSV and environment files, per-run watchdog);
    `verify-proof/scripts/runtime-versions.sh` (198) -> `runtime-versions.mjs` (same `runtime:` lines, exit 0 always). Both skills get
    their own byte-identical `ecosystems.mjs` copy (skills share no files; `check-shared` checks the copies); their `ecosystems.sh` copies
    are deleted. `roles/verifier.md` and the skill texts name the new scripts; generated agent files are regenerated.
  - Listed, not ported: the 25 skills whose `scripts/` hold only `.mjs`; `proofline` has no `scripts/` folder.
- **Depends on:** stage 8.
- **Acceptance criteria:**
  - C1-C8. `tests/cli/cli-test.sh` (24 units) passes unchanged (it compares `proofline help` with the entry skill, the lead table and the
    README); `generate.mjs --check` and `generate-skills.mjs --check` produce byte-identical files to the shell generators on the repository.
  - `proofline init` and `upgrade` on a 0.0.40 project give the same tree and manifest as the shell installer (rig case over a fixture
    project), including the hook wiring rule of stage 3.
  - `tests/skills/performance-proof.test.mjs` and `runtime-versions.test.mjs` pass against the new scripts with the same fake tools.
  - Performance: `proofline status` 126 processes (measured) -> at most 3 (estimate); `doctor` and `init` before measured in this stage,
    after not higher; `runtime-versions` before/after counted with the PATH shim.
  - Smoke: the default run (the setup and doctor rows exercise `init` and `doctor`); `SMOKE_ONLY=a202` with `sh` in `.agents/local/engine`.
- **Risks:** users installed `bin/proofline` through a symlink created by the old installer (Node resolves it, tested); the skill scripts
  are installed alone into user projects and must not import anything outside their skill.
- **Rollback:** `sh` in `.agents/local/engine` for the core; the old `bin/proofline` from the previous release (the CLI is a checkout);
  a revert. The config-parser comparison of `check-shared.sh` goes in this stage with `bin/lib/config.sh` (one Node parser is left; the
  `agent.sh` parser it compared against stays only as the fallback until stage 10).
- **Estimate:** 5-7 agent-days (estimate). Basis: about 2,350 lines; the installer and generators are covered by `cli-test` and
  `generator-test`.

## Stage 10

- **Title:** Node migration 10/15: remove the shell paths (launchers, engine switch, fallbacks)
- **Version:** 0.0.x
- **Scope:**
  - `agent.sh` (9,170 lines) becomes the launcher; `dispatch.sh` stays a launcher; `proofline-hook.sh` becomes a transitional launcher of
    `proofline-hook.mjs` (until stage 15) so that a session started before stage 3 does not lose its hook; the kept shell code is deleted:
    the 13 sibling scripts, the shell task adapters, the old git-hook bodies, `control-plane/agents/scripts/ecosystems.sh`,
    `ecosystems.tsv` and its `write` path in `ecosystems.mjs`.
  - The engine switch (`.agents/local/engine`, `PROOFLINE_ENGINE`, `PROOFLINE_ENGINE_SH`) and the bridge are removed; `doctor` reports a
    leftover `.agents/local/engine` file as unused. The fixture-file stub rule of stages 5-7 stays until stage 15 (it serves `test-lib.sh`).
  - The extraction tests that read deleted `agent.sh` text are deleted with that text: `status-block-test.sh` (`sb_scrub`, `sb_strip`,
    `SB_KEYS=`), `risk-test.sh` (`risk_words_match` at 830 and 867, and its `eco_*` use), `gates-test.sh` line 511, `reply-loop-test.sh`
    (`approval_phrases`), and the `agent.sh` text reads of `plan-contract.test.mjs` and `proofline-lead.test.mjs`. Their golden
    replacements were added in stages 2-5, so no test is rewritten in the stage that deletes its code.
  - `check-static.sh` rule 5 moves its remaining shell scan to the Node ecosystem check of stage 2 in the same pull request that deletes
    `ecosystems.tsv`, so the rule never runs without its data.
  - The equivalence rig is retired. The golden set that outlives it (`node:test`): a curated set of trace cases, the capture, intake and
    history fixtures of stage 3, the golden tests of stages 2-5 (`risk_words_match`, `next` order, `approval_phrases`, `sb_scrub`,
    `sb_strip`, `SB_KEYS`, freeze messages, `blocking_rule_version`), and the recorded 0.0.40 run carried to DONE.
- **Depends on:** stage 9.
- **Acceptance criteria:**
  - C2 (default engine), C3, C4, C5, C7, C8.
  - The shell allowlist holds only launchers (including the transitional `proofline-hook.sh`) and the test files still waiting for
    stages 11-15.
  - A session whose hook strings still run `proofline-hook.sh` (project and plugin forms of a release before stage 3) keeps its guards:
    a PreToolUse deny case passes through the transitional launcher.
  - The static job's ecosystem check still fails on a planted ecosystem `case` arm after the TSV is gone.
  - A run recorded on 0.0.40 at IMPLEMENTED continues to DONE on this version (golden case).
  - The 101-call scenario (9,384 processes / 189 s on 0.0.40, measured) re-measured with the PATH shim: target (estimate) at most 1,000
    processes and under 30 s; every command within its budget in `tests/bench/spawn-budgets.tsv`.
  - Smoke: the default run; `SMOKE_ONLY=codex`; `SMOKE_ONLY=a200`; `SMOKE_ONLY=a202`; the rtk pass when rtk is installed.
- **Risks:** a fallback path that was never exercised hid a dependency (mitigated: stages 1-9 ran CI with the default engine for at least
  one release each); version skew between a main-tree and a worktree copy (A169 re-exec) during upgrades.
- **Rollback:** revert of the pull request, or the previous release (`proofline upgrade` from its checkout); runs continue because no format
  changed.
- **Estimate:** 3-4 agent-days (estimate). Basis: mostly deletion; the golden replacements already exist from stages 2-5.

## Stage 11

- **Title:** Node migration 11/15: test harness, self-test runner, CI scripts and the inline logic of `ci.yml`
- **Version:** 0.0.x
- **Scope:**
  - `tests/lib/harness.mjs`: the Node form of `test-lib.sh` (291) with the same helpers (`A`, `AS`, `expect_msg`, `expect_fail`, `scaffold`,
    `to_code_done`, `rec`, `gpass`, `gfail`, `worker`, `approve_as_user`, ...) and the same environment hardening. `test-lib.sh` stays
    untouched, because the shell invariant suite sources it (until stage 15). The harness calls `run(argv, io)` in process and passes
    stubs (secret scan, execution policy, task adapter) in `io.stubs`, never as files; the CLI and hook entry points never set it.
  - `tests/selftest.sh` (159), `selftest-weights.sh` (62), `affected.sh` (106) -> Node, with the same unit split (459 units), the
    weights file, `SELFTEST_SHARD=i/n` (16 shards in CI), the job count rules and `LC_ONLY`; the runner still runs the not-yet-ported shell
    suites as units.
  - `tests/ci/*` (11 files, 595: classify, bump-version, sync-design-library and their tests), `tests/shared/*` (445: `check-shared`,
    `check-static`, `fixture-lib`, `static-test`), `tests/context/*` (131), `tests/generator/*` (359), `tests/bench/*` (159).
  - `ci.yml`: the 5 logic steps (changes/classify, shellcheck file list, the Windows timing step, the two "changed only with a reason"
    checks) become one-line `node` steps; the 5 guard steps become plain calls; the trivial failure step stays one line. The Windows job
    loses its `shell: bash` default. `shellcheck` stays for the remaining shell files until stage 15.
  - `tests/invariants/check-changed.sh` is not touched here (stage 13).
- **Depends on:** stage 10.
- **Acceptance criteria:**
  - C2, C3, C5, C7, C8.
  - The Node runner's unit list equals `SELFTEST_LIST=1` of the shell runner (459 units); one CI run with both runners gives the same
    per-unit results; `affected` selects the same units for a set of recorded changes.
  - `bump-version` (Node) changes exactly the sites the shell script changes (diff of a dry run on the repository).
  - Performance: self-test wall time per shard (CI timing artifacts) and the weights total (21,006 s) before and after; the Node tests (976
    tests, 294.8 s measured on Node 24) before and after; the after numbers are not higher.
  - Smoke: the default run (the product did not change; this confirms the harness did not alter it).
- **Risks:** the runner's sharding feeds every later stage's CI; a mistake hides units (the unit-list equality guards it).
- **Rollback:** revert (test-only change; the product is unaffected).
- **Estimate:** 4-6 agent-days (estimate). Basis: about 2,300 lines of runner, CI and check scripts.

## Stage 12

- **Title:** Node migration 12/15: the control-plane test suites
- **Version:** 0.0.x
- **Scope:**
  - The 21 suites in `control-plane/agents/scripts/*-test.sh` (10,041 lines) -> `node:test` files on the harness: `gates-test` 3,016,
    `lifecycle-test` 1,545, `batch-test` 1,071, `risk-test` 976, `deliver-test` 673, `dispatch-test` 411, `cifix-test` 275,
    `known-issues-test` 263, `next-user-test` 255, `controls-test` 227, `exec-policy-test` 209, `identity-test` 166, `build-record-test`
    149, `perf-test` 131, `githooks-test` 124, `task-adversarial-test` 108, `lessons-test` 102, `friction-test` 97, `rules-test` 96,
    `debt-test` 84, `secret-scan-test` 63.
  - Each scenario keeps its name, so weights and `LC_ONLY` still select it; assertion messages and expected texts unchanged.
- **Depends on:** stage 11.
- **Acceptance criteria:**
  - C2, C3, C5, C7.
  - Per suite: the Node suite and the shell suite run in the same CI job against the same build and give the same result per scenario;
    a mutant build per suite (one deliberately broken rule each, listed in the pull request) fails both. Then the shell suite is deleted.
  - No assertion weakened: the count of `expect_msg` and `expect_fail` equivalents per suite is reported and not lower.
  - Performance: CI self-test wall time per shard before and after; target (estimate) lower, because each assertion no longer forks `grep`.
  - Smoke: the default run.
- **Risks:** timing-sensitive suites (`gates-test` 47 sleep/kill mentions, `batch-test` 46, `dispatch-test` 20) flake when rewritten;
  volume (the largest stage by lines).
- **Rollback:** revert (test-only change).
- **Estimate:** 8-12 agent-days (estimate). Basis: 10,041 lines; about 2,587 helper calls across all suites, most of them here.

## Stage 13

- **Title:** Node migration 13/15: enforcement, Core invariant (Node copy), CLI, task, e2e and real-session tests
- **Version:** 0.0.x
- **Scope:**
  - `tests/enforcement` (6 files, 2,465: enforcement, kill-guard, approval-load, merge-guard, platform, timeouts), `tests/cli` (1,041),
    `tests/tasks` (618), `tests/e2e` (519, including `run.sh`), `tests/real-session` (625: `smoke.sh`, `codex-sandbox.sh`).
  - `tests/invariants`: a Node copy of `invariants-test.sh` (211) and `check-changed.sh` (31) beside the shell files, under the
    `Invariant-test-change:` rule (the pull request says why on that line; review approves it separately). The shell copy and
    `test-lib.sh` keep running unchanged beside it until the Node copy has been green on `main` through at least one full release after
    this one (recommended default, maintainer to confirm; ADR section 16).
- **Depends on:** stage 11.
- **Acceptance criteria:**
  - C2 (both invariant copies green), C3, C5, C7.
  - Invariant copy: every scenario of the Node copy fails against a mutant build that breaks its rule (CODE_DONE with a missing gate,
    SECRETS waived, SECURITY waived, an approval from agent text, an agent claim accepted as evidence, the author reviewing, an ambiguous
    case passing), and the shell copy fails on the same mutants.
  - Enforcement: every deny and every allow verdict of the shell suites is reproduced (same hook JSON in, same decision and message out).
  - Smoke: the old `smoke.sh` and the new Node smoke both run the default steps on the same commit and both tables are all PASS with the
    same rows; plus `SMOKE_ONLY=codex` with the new smoke.
  - Performance: CI wall time of the affected jobs before and after; the smoke's own duration recorded.
- **Risks:** the invariant suite is the boundary of every patch; porting it is the riskiest test change (mitigated: both copies, mutants,
  separate approval).
- **Rollback:** revert (test-only change); the shell invariant copy and `test-lib.sh` are untouched.
- **Estimate:** 4-6 agent-days (estimate). Basis: about 5,550 lines.

## Stage 14

- **Title:** Node migration 14/15: fixtures
- **Version:** 0.0.x
- **Scope:**
  - `fixtures/*/setup.sh` (31 files, about 5,740 lines of heredoc builders), `fixtures/proof-review/plan-setup.sh` (224),
    `fixtures/test-trust/diff-setup.sh` (80), the 26 `selfcheck.sh` and `browser-check.sh` files (1,124), `tests/fixtures/check-fixtures.sh`
    (116) -> `.mjs` that write byte-identical fixture trees.
  - The two `bash` fixtures (`proof-review/go`, `proof-review/ts`) included. Fixture text (`RUNNER.md`, `EXPECTED.md`) names the new commands;
    no EXPECTED answer changes.
- **Depends on:** stage 11.
- **Acceptance criteria:**
  - C3, C5, C7. `EXPECTED` files unchanged.
  - Every Node builder produces a tree byte-identical to its shell builder (file list, content, mode bits), compared in CI before the shell
    builders are deleted; `check-fixtures` reports the same pass and skip counts (42 passed, 1 skipped without vitest, per CONTRIBUTING).
  - Performance: fixtures job wall time before and after.
  - Smoke: the default run.
- **Risks:** fixtures that build git history depend on fixed dates and authors; heredoc quoting must stay byte-exact.
- **Rollback:** revert (test-only change).
- **Estimate:** 3-5 agent-days (estimate). Basis: about 7,300 lines, mostly mechanical.

## Stage 15

- **Title:** Node migration 15/15: strict no-shell-logic check, the last shell files, documentation
- **Version:** 0.0.x
- **Scope:**
  - `tests/ci/no-shell-logic.mjs` switches from the ratchet to the strict rule of the ADR (launchers equal to their templates, hook strings
    equal to their templates, one-line CI steps, no awk anywhere, no `sh` or `awk` started from Node outside `runUserCommand`).
  - The shell invariant suite (`invariants-test.sh`, `check-changed.sh` and its test) and `test-lib.sh` are deleted, under the
    `Invariant-test-change:` rule, only if the Node copy has been green on `main` through at least one full release after the one that
    added it (stage 13); otherwise this deletion waits for a later release and the rest of the stage ships.
  - The transitional `proofline-hook.sh` launcher is deleted (sessions started before stage 3 are at least eleven releases old); the
    fixture-file stub rule of stages 5-7 goes with `test-lib.sh`, so no override path remains in shipped code (the Node harness injects
    stubs through `io.stubs`).
  - `shellcheck` leaves CI (only launchers remain; the strict check pins their text).
  - The `windows-latest` job runs the core's Node tests and the Node invariant suite. CONTRIBUTING (set-up, test commands, Core invariant
    command) and the README (requirements, Windows status as proven by the job) updated.
- **Depends on:** stages 12, 13 and 14.
- **Acceptance criteria:**
  - C3, C5, C7, C8. The strict check is green and fails on a planted violation of each rule (a new `.sh`, an `if` in a launcher, a changed
    hook string, a two-line CI step, an `awk` call from Node).
  - The final before/after table of the epic's exit criteria, against the 0.0.40 baseline.
  - Smoke: the default run; `SMOKE_ONLY=codex`; `SMOKE_ONLY=a200`; `SMOKE_ONLY=a202`; the rtk pass when rtk is installed.
- **Risks:** a launcher template that is too strict for a platform (adjusted only by a decision, never by loosening the check silently).
- **Rollback:** revert.
- **Estimate:** 1-2 agent-days (estimate). Basis: one script switch, deletions and documentation.

## Follow-up: tool-call economy

A separate issue, outside the 15 stages and listed in the epic table. It applies the principle of ADR section 8.3 to the roles.

- **Title:** Tool-call economy: measure tool calls and context bytes per role, then give the most call-heavy jobs one combined command each
- **Version:** 0.0.x
- **Scope:**
  - **Measure first, from data that exists today** (no data is invented; what is missing is named):
    - `.agents/local/metrics/records.jsonl` (A80): per step and per dispatch the role, gate, duration and tokens; `turns` only for
      dispatched workers (from the runtime's structured output, `num_turns`); no tool-call count and no output size.
    - `.agents/local/metrics/history.tsv`: time, task, role, runtime, model, duration, outcome; no tool data.
    - `runs/<ID>/LEDGER.log`: lifecycle transitions; no tool data.
    - `runs/<ID>/HOOKS.log`: per hook event the number of runs and their time; the PreToolUse count approximates the tool calls of a
      session for the matched tools, but it is not attributed to a role.
    - Runtime session logs: for a Claude subagent the transcript path is line 1 of `.agents/local/submissions/<agent>.started` (it is
      already read for token usage); it holds every tool call and its result, so per-role call counts and result bytes can be derived
      where it exists. The lead's own session log is not recorded by proofline; a dispatched worker's output is in
      `runs/<ID>/dispatch/`; for Codex the source is to be checked.
    - **Needs a new record:** per step, the number of tool calls by kind and the bytes of tool results that entered the context, written
      by the control plane from the runtime log at `submit` into a new file (`.agents/local/metrics/tools.jsonl`), so that the existing
      `records.jsonl` format does not change (ADR D3); and, if wanted, the lead's session log path.
  - From those numbers, per role and per run: the jobs with the most calls. Expected candidates, to be confirmed or rejected by the
    measurement: exploration (explorer), exhaustive finding sweeps (reviewers, security reviewer), evidence gathering (verifier).
  - **Then propose combined commands** for the top jobs (new core subcommands, named in the pull request): a multi-step search done by one
    command, whose output to the context is a short summary (counts, the top items, the path of the raw file, "truncated" when it is).
    The commands are control-plane code (reviewed, shipped, deterministic: declared inputs such as the frozen PLAN scope, fixed tools such
    as `git grep` and the skills' validators, byte-order output), run by the control plane, and write the exact command line, the input
    hashes and the raw output to `runs/<ID>/evidence/<command>-<n>/`, so anyone can re-run them and compare. A script a model writes during
    the run, and its statement, is still not evidence (Core invariant 4).
  - Role and skill instructions name the combined commands for those jobs; `adapters/generate.sh` regenerates the agent files. These
    texts count as code for review (CONTRIBUTING: Markdown under `skills/`, `roles/`, `control-plane/` and `adapters/` is reviewed like code).
- **Depends on:** stage 2 for the measuring half (it adds no command and changes no role text, so it may start after stage 2) and stage 10
  for the rest: the combined commands and the role texts that name them ship only after stage 10, when the shell engine can no longer be
  selected. Earlier, a Node-only subcommand would break the one-to-one 132-command map, and an engine switch back to the old code would
  leave role texts naming commands it lacks.
- **Acceptance criteria:**
  - A measurement report in the pull request: tool calls per role per run and context bytes per role per run, before and after, on a named
    fixture run: the real-session smoke's `/proofline run` task and one COMPLEX scenario of `tests/e2e` (same model, same task).
  - The new record file's format is documented and written only by the control plane from runtime data (no model text), with strings
    reduced as `records.jsonl` does today.
  - Each combined command: a test that its summary's finding count equals the count in its raw file; a planted finding beyond the summary's
    top items still appears in the count and in the raw file; re-running the recorded command line reproduces the raw file byte for byte.
  - Context budgets (`tests/context/budget.tsv`) unchanged or smaller; the context budget tests and `check-budget-changed` pass.
  - `sh tests/invariants/invariants-test.sh` (or its Node copy, depending on when this ships) passes unchanged.
  - Smoke: the default run, and the measurement taken on it.
- **Risks:** a summary hides a finding (mitigation: the raw output stays, the finding count is printed, "truncated" is said, and a role
  deciding about one item reads the raw file; in doubt the safe side wins, Core invariant 6); the measurement depends on runtime log
  formats that can change (the reader fails visibly and records null, as `metrics_step` does); instructions that grow the auto-loaded
  context (the context budget forbids it).
- **Rollback:** the role and skill texts go back to their previous wording (a revert); the combined commands stay available but unused;
  the new record file can be ignored (nothing reads it for a decision).
- **Estimate:** 3-5 agent-days (estimate). Basis: 1-2 days to build the reader and measure; 2-3 days for two or three combined commands
  with their tests and the role-text changes.
