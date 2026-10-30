# ADR 0001 inventory: the shell and awk code of proofline 0.0.40

Companion to [0001-node-control-plane.md](0001-node-control-plane.md) and [0001-stages.md](0001-stages.md).
This is a condensed form of four inventories made on `main` at 0.0.40 (commit 7acdba5) before the decision. Every
number below comes from those inventories ("inventory"); a number marked "measured" was counted with a PATH shim that
logs every external program a command starts (macOS, BSD userland, `/bin/sh` = bash 3.2 in POSIX mode). A number
marked "sum" was added up here from inventory figures. Nothing was measured on Windows.

Status column, used in every table:

- **ported**: the logic moves to Node and the shell file is deleted in the stage named.
- **listed, not ported**: already Node (`.mjs`); listed so the sweep is complete; it stays as it is.
- **launcher**: stays as a file of a few lines that only starts Node (see [Launchers](#launchers)).
- **none**: no shell or awk in the directory.

## 1. Totals per top-level directory

| directory | shell files / lines | awk inside | Node files / lines | status | stage |
|---|---|---|---|---|---|
| `control-plane/` | 45 `.sh` / 23,613 + 2 extensionless git hooks / 107 | 31 files | 1 / 256 (`ecosystems.mjs`) | ported; `agent.sh`, `dispatch.sh`, `pre-commit`, `pre-push` become launchers | 1-10, 12, 15 |
| `adapters/` | 3 / 2,972 | 2 files | 0 | ported; the 3 hook wiring JSON files keep a pinned command string | 3, 9 |
| `bin/` | 9 `.sh` / 2,391 + `bin/proofline` / 369 | 9 files | 0 | ported; `bin/proofline` becomes a Node launcher, `bin/proofline.cmd` is added | 9 |
| `skills/` | 4 / 540 | 4 files | 79 / 19,779 | sh ported; `.mjs` listed, not ported | 9 |
| `tests/` | 51 / 7,683 | 29 files | 51 / 11,491 | ported | 11, 13, 15 |
| `fixtures/` | 59 / 7,168 | 5 files | 6 / 297 | ported | 14 |
| `docs/` | 1 / 38 | 1 file | 0 | ported | 9 |
| `.github/` | `ci.yml` (246 lines): 20 run steps, 11 with inline shell (5 real logic, 5 file-exists guards, 1 trivial) | - | - | ported | 11 |
| `playground/` | 0 | 0 | 12 / 541 | listed, not ported (a demo app) | - |
| `roles/`, `.out-of-scope/`, `.claude-plugin/`, `src/` | 0 | 0 | 0 | none (`src/` has no tracked file) | - |

Sum: 172 `.sh` files and 3 extensionless shell files (`bin/proofline`, `githooks/pre-commit`, `githooks/pre-push`), about
44,900 lines of shell (sum); 78 `.sh` files contain awk, 15 of them hold 32 multi-line awk programs. Node: 149 files,
32,364 lines, no npm package at runtime (the one `package.json` with a dependency is a fixture project that is analysed,
not run). No `.cmd`, `.bat` or `.ps1` file is tracked.

## 2. The control plane

### 2a. `agent.sh` (9,170 lines: 7,746 code, 1,341 comment, 83 blank)

132 dispatch arms, no alias arms. Frequency classes: **HOT 21** (on a runtime-hook or git-hook path), **STEP 77** (once per
pipeline step or user command), **ONCE 34** (once per run or project). 611 functions, 366 of them reachable from three or more
commands. Every invocation pays a startup floor (one awk parse of the config; the ecosystem loader for all but 5 lazy commands):
1 process for `hook-config`, 3 for `config-get` (measured).

| area (the file's own section banners) | lines | commands | moves in stage |
|---|---|---|---|
| bootstrap, roles, id helpers, lock manager | 122 | all | 1 |
| config parser, timeouts, ecosystem loader, `config-check` | 299 | `config-get` `config-check` `timeouts` `hook-timeouts` `verify-timeout` `tm-scaled` `hook-config` `db-config` | 1 |
| active run, `start`, `effective`, RUN.yaml access | 165 | `status` `open-runs` `effective` `start` | 2, 4 |
| baseline, path fingerprint, fingerprint cache, content fingerprint, globs | 319 | `fingerprint` `baseline` `patch-fingerprint` | 2, 4 |
| pipeline, assumptions, tier, risk signals, gate table, classify | 838 | `pipeline` `tier` `classify` `verify-assumptions` | 2, 4 |
| freeze, task-source contract, design surfaces | 665 | `freeze` `refreeze` `verify-freeze` `design-surface` `task-source-*` | 2, 4, 6 |
| scope, class check, database guard, QA plan, task type | 504 | `verify-scope` `db-check` `verify-qa-plan` `task-type` ... | 2, 4 |
| handoff ladder, delivery check, validate, worker evidence | 331 | `handoff` `delivery-check` `validate` `worker-evidence` | 4, 5 |
| ledger, gate-record evaluation, fix rounds, windows, tree recovery | 787 | `verify-seal` `verify-gates` `window-open` `window-close` `tree-inspect` `tree-accept` | 2, 3, 4 |
| result protocol (record, probes, reproduce, language check) | 844 | `record` `language-check` `repro-normalize` | 2, 3, 5 |
| submission and gate/secret-scan recording | 362 | `submit` `gate` `secret-scan` | 5 |
| mutation budget, approvals | 803 | `request-approval` `approve` `approve-pending` `approval-consume` `raise-budget` | 3, 5 |
| night mode, task rename, known issues, waivers | 320 | `batch-*` `task-rename-*` `known-issue-*` `waive` | 5, 7 |
| questions, answer, decide, notes, metrics | 430 | `ask` `answer` `decide` `ledger-note` `metrics-dispatch` | 3, 4, 7 |
| `next` state machine, amend, reopen | 367 | `next` `amend` `reopen` | 2, 4 |
| completion report, facts, status block, knowledge, terminate, archive, cleanup | 789 | `publish-completion-report` `report-facts` `knowledge-done` `terminate` `cleanup` ... | 2, 4, 5 |
| CI visibility, delivery plan and step, CI fix, deliver-merged | 754 | `deliver-plan` `deliver-step` `deliver-merged` `pr-state` `ci-check` | 6 |
| worktrees, branch, summary, digest, run_suites | 214 | `worktree-*` `branch` `summary` `digest` `test` | 2, 4, 7, 8 |
| CLI: role gate, locking, usage, dispatch case | 257 | all | 1 (table), 10 (removal) |

The complete command-to-stage table is in [0001-stages.md](0001-stages.md#command-map).

### 2b. The ten costliest commands (measured, small fixture, 2 scoped files)

| command | processes | wall | what grows |
|---|---|---|---|
| `publish-completion-report` | 1,754 | 34.0 s | gates x findings x report lines |
| `summary` (full form) | 346-665 | 8.5-14.2 s | gates |
| `handoff` DONE | 568 | 11.5 s | changed files, ledger lines |
| `record` (one gate result) | 449-459 | 8.0-8.3 s | changed files; 6-9 gates per COMPLEX run |
| `handoff` CODE_DONE | 391 | 7.1 s | gates |
| `pipeline` | 208-364 | 3.8-5.4 s | recorded gate records |
| `secret-scan` | 280 | 5.6 s | changed files |
| `digest` | 129-225 | 3.0-5.0 s | as `next` + `summary` |
| `handoff` IMPLEMENTED | 216 | 3.8 s | project tree (database guard walks it) |
| `freeze` | 202 | 2.9 s | plan size |

Scaling with N changed files (measured): `next` 68 / 690 / 1,930 processes and 2.5 / 8.0 / 18.3 s at N = 0 / 20 / 60;
`patch-fingerprint` 10 / 170 / 490; `verify-scope` 17 / 158 / 438. `verify-seal` starts one `shasum` per ledger line:
7 processes at 5 lines, 67 at 63 lines. A 101-invocation run scenario cost 9,384 processes and 189 s. The repository's own
budget (`perf-test.sh`, A203): `next` at most 260 and `digest` at most 340 processes on its fixture.

### 2c. Sibling scripts and task adapters

| file | lines | class | spawn pattern / known issue | status | stage |
|---|---|---|---|---|---|
| `scripts/dispatch.sh` | 610 | STEP, long running | background child, `sleep`/`kill` watchdog (TERM, KILL after 5 s), EXIT/HUP/INT/TERM traps, nonce checked by `decide` against a live ancestor pid (`ps -o ppid` walk, 12 hops) | launcher | 7 |
| `scripts/batch.sh` | 728 | STEP | 52 awk; `gh run list`; sleep inhibitor via `nohup` | ported | 6 (CI), 7 |
| `scripts/exec-policy.sh` | 302 | STEP | own YAML reader in awk | ported | 7 |
| `scripts/next-user.sh` | 274 | STEP (Stop-hook chain) | calls `agent.sh` back up to 4 times | ported | 3 |
| `scripts/platform.sh` | 230 | STEP | `gh`/`glab`/`az`, exact-host matching | ported | 6 |
| `scripts/known-issues.sh` | 194 | STEP | approval bound to exact bytes of a TSV row | ported | 7 |
| `scripts/build-record.sh` | 178 | STEP | throwaway export, `timeout`, symlinks dependency folders | ported | 8 |
| `scripts/lessons.sh` | 178 | ONCE | approval-bound promotion | ported | 8 |
| `scripts/friction.sh` | 134 | ONCE | `gh` after approval only | ported | 8 |
| `scripts/rules.sh` | 121 | ONCE | `cksum`, word overlap | ported | 8 |
| `scripts/worktree-prep.sh` | 114 | ONCE | copies dependency folders, re-points links | ported | 7 |
| `scripts/ecosystems.sh` | 94 | sourced on most commands | awk reader of `ecosystems.tsv`; 3 byte-identical copies | ported (deleted) | 10 |
| `scripts/debt.sh` | 77 | ONCE | `git grep` | ported | 2 |
| `scripts/secret-scan.sh` | 64 | STEP | `grep`, test stub replaces it | ported | 5 |
| `scripts/runtime-detect.sh` | 37 | STEP | `command -v`; `.exe` not considered | ported | 7 |
| `task-integrations/_lib.sh` `markdown.sh` `github.sh` `jira.sh` `linear.sh` `slug.sh` | 157 / 207 / 134 / 114 / 114 / 36 | STEP | `jira` and `linear` not tested against a real service; `slug.sh` needs its letter table (NFD alone does not map dotless i, sharp s, o-slash) | ported (`.mjs`); a user-written `<name>.sh` adapter is still run | 6 |
| `githooks/pre-commit`, `pre-push`, `human.sh` | 63 / 44 / 14 | STEP (every commit and push) | measured 15 and 9 processes without a run, git calls not visible to the shim (about 6-8 more) | launcher (`pre-commit`, `pre-push`); `human.sh` ported | 3 |

The ecosystem definition exists in three forms that must agree: `ecosystems.json` (source), `ecosystems.tsv` (generated for the
awk readers) and `ecosystems.mjs` (5 byte-identical copies), plus 3 byte-identical copies of `ecosystems.sh`. Its glob dialect is
written twice (awk `g2re` and `globToRegExp`).

## 3. The runtime hook and its wiring

| file | lines | class | measured per event (processes / ms) | status | stage |
|---|---|---|---|---|---|
| `adapters/claude/hooks/proofline-hook.sh` | 2,609 | HOT (7 events, Claude and Codex) | PreToolUse Bash 39 (45 in one traced run) / 688; Read 15 / 505; Write 17 / 530; PostToolUse 13 / 172; prompt 17 / 220; **prompt that records an approval 544 / 3,370**; Stop 40 / 416; SessionStart 130 / 3,254; SubagentStart 67 / 852; SubagentStop 20 / 202 | ported (`proofline-hook.mjs`) | 3 |
| `adapters/claude/hooks/hooks.json` (plugin) | 83 | HOT wiring | one extra `grep` per event (duplicate check against the project settings) | launcher (pinned command string) | 3 |
| `adapters/claude/settings.fragment.json` (project) | 83 | HOT wiring | `sh -c` and `exec sh`; PreToolUse fails closed (exit 2) when the hook file is missing but `.agents/config.yaml` exists | launcher (pinned command string) | 3 |
| `adapters/codex/hooks.json` | 83 | HOT wiring | one `git rev-parse` and one `sh` per event | launcher (pinned command string) | 3 |

Known issues: the hook's largest item is a 290-line awk shell-command scanner; six `tr` calls run on every event; the hook
duplicates logic that also lives in `agent.sh` (three hand-written JSON string codecs, three SHA-256 helpers, four YAML readers,
two role tables, path policy). **The approval capture is a byte-level contract** between the hook (writes
`.agents/local/prompts/<session>.json` and the history copy), `agent.sh` (checks the SHA-256 of the exact text, the capture time,
the capture id `<session>:<time>:<sha>`) and the Stop hook (reads the same file by text position). Windows: no path handling
(a `C:\...` path in the runtime's JSON is not treated as absolute, so every Edit or Write during a run would be denied:
inferred, not run); `ps -A -o pid= -o ppid=` for the budget kill path.

## 4. The CLI and the generators

| file | lines | class | known issue | status | stage |
|---|---|---|---|---|---|
| `bin/proofline` | 369 | ONCE (user-run) | measured `proofline status` 126 processes; resolves its own symlink in sh | launcher (Node) + `bin/proofline.cmd` | 9 |
| `bin/lib/install.sh` | 495 | ONCE | merges hook wiring by command-string equality: a new string duplicates hooks unless the merge knows the old one | ported | 3 (merge rule), 9 |
| `bin/lib/discover.sh` | 546 | ONCE | process-group kill via `set -m`, `setsid`, perl or python3 fallbacks | ported | 8 |
| `bin/lib/doctor.sh` | 412 | ONCE | verifies 6 of the 7 hook events (Stop is never checked) | ported | 1 (Node check), 9 |
| `bin/lib/insights.sh` | 298 | ONCE | - | ported | 2 |
| `bin/lib/merge.sh` | 256 | STEP | the only allowed merge path | ported | 6 |
| `bin/lib/config.sh` | 134 | sourced by every CLI command | a second copy of the config parser, compared to `agent.sh` by `check-shared.sh` | ported | 9 |
| `bin/lib/context-size.sh` | 98 | ONCE | reads the hook source with `sed` on one exact line | ported | 8 |
| `bin/lib/timeouts.sh`, `commands.sh` | 78 / 74 | ONCE | - | ported | 8 |
| `adapters/generate.sh` | 304 | ONCE, CI `--check` | - | ported | 9 |
| `adapters/codex/install.sh` | 59 | ONCE | `ln -sf` makes a copy on Windows without symlink rights | ported | 9 |
| `docs/reference/generate-skills.sh` | 38 | CI `--check` | - | ported | 9 |

## 5. Skills

28 skill folders. **No `scripts/` folder: `proofline`** (only `SKILL.md` and references). Only `.mjs` in `scripts/`: 25 skills.
Shell in `scripts/`: 2 skills, 4 files, 540 lines.

| skill | `.mjs` files / lines | shell files / lines | status |
|---|---|---|---|
| `performance-proof` | 3 / 487 | `run-bench.sh` 154 (ABBA runs in two worktrees, per-run watchdog), `ecosystems.sh` 94 | sh ported to `run-bench.mjs`; gets its own `ecosystems.mjs` copy (stage 9) |
| `verify-proof` | 1 / 166 | `runtime-versions.sh` 198 (about ten awk programs, CI-version comparison), `ecosystems.sh` 94 | sh ported to `runtime-versions.mjs`; gets its own `ecosystems.mjs` copy (stage 9) |
| `proofline` | none (no `scripts/`) | - | none |
| `api-design` 1/92, `concurrency-proof` 2/593, `contract-proof` 2/1,349, `data-design` 4/1,156, `debug-proof` 1/154, `design-sync` 3/780, `docs-writer` 2/269, `evidence-map` 3/939, `explain-html` 1/64, `exploit-proof` 4/1,781, `intent-grill` 1/195, `llm-wiki` 1/124, `plan-contract` 1/481, `product-assess` 7/666, `product-discovery` 7/829, `product-spec` 6/1,063, `proof-review` 4/772, `proofline-lead` 1/202, `qa-plan` 1/263, `system-design` 1/122, `task-author` 2/464, `tdd-proof` 3/509, `test-trust` 2/309, `ui-design` 3/1,357, `visual-proof` 10/4,468 | as listed | none | listed, not ported |

Skills are installable alone (no file sharing between skills), so a skill script cannot import the control-plane core; skill
scripts keep their own `child_process` use and are outside the spawn-wrapper rule. Generated text that names a skill shell
script (`roles/verifier.md` and its two generated agent files) changes with stage 9.

## 6. Tests, fixtures and CI

| area | files / lines | notes | status | stage |
|---|---|---|---|---|
| `control-plane/agents/scripts/*-test.sh` | 21 suites / 10,041 | biggest: `gates-test` 3,016, `lifecycle-test` 1,545, `batch-test` 1,071, `risk-test` 976, `deliver-test` 673 | ported | 12 |
| `control-plane/agents/scripts/test-lib.sh` | 291 | sourced by 27 files; writes sh stubs of `secret-scan.sh`, `exec-policy.sh` and `markdown.sh` into fixtures | ported; kept frozen for the sh invariant suite until stage 15 | 11, 15 |
| `tests/enforcement` | 6 / 2,465 | drive the real hook and git hooks with hook JSON | ported | 13 |
| `tests/cli` | 3 / 1,041 | source `bin/lib/*.sh` | ported | 13 |
| `tests/real-session` | 2 / 625 | `smoke.sh` (501) drives a real session; never CI | ported | 13 |
| `tests/tasks` | 2 / 618 | `status-block-test` evals `sb_scrub`, `sb_strip` and reads `SB_KEYS=` from `agent.sh` | ported | 10 (extraction), 13 |
| `tests/ci` | 11 / 595 | classify, bump-version, sync-design-library and their tests | ported | 11 |
| `tests/e2e` | 7 / 519 | `reply-loop-test` extracts `approval_phrases()` from `agent.sh` | ported | 10 (extraction), 13 |
| `tests/shared` | 4 / 445 | `check-shared.sh` compares the awk config readers of `bin/lib/config.sh` and `agent.sh` | ported | 11 |
| `tests/generator` | 2 / 359 | | ported | 11 |
| `tests/invariants` | 3 / 283 | one section per Core invariant against the real `agent.sh` | Node copy added in 13; sh copy runs unchanged until 15 | 13, 15 |
| `tests/` top level | 3 / 327 | `selftest.sh` 159, `affected.sh` 106, `selftest-weights.sh` 62 (sum) | ported | 11 |
| `tests/bench` | 3 / 159 | `hook-procs.sh` also runs nightly on `windows-latest` | ported | 11 |
| `tests/context` | 3 / 131 | | ported | 11 |
| `tests/fixtures` | 2 / 116 | `check-fixtures.sh` | ported | 14 |
| `fixtures/*` | 59 / 7,168 | 31 `setup.sh` (about 5,740 lines of heredoc builders), 2 `*-setup.sh` (304), 26 `selfcheck.sh` and `browser-check.sh` (1,124); 2 use `bash` | ported | 14 |
| `.github/workflows/ci.yml` | 246 | inline logic: changes/classify, shellcheck, Windows hook timing, two "changed only with a reason" checks; 5 guards; 1 trivial | ported to one-line `node` steps | 11 |

Test coupling (inventory): about 2,587 `A`/`AS`/`rec`/`gpass`/`gfail` calls to `sh ./.agents/scripts/agent.sh`; 574 `expect_msg`
and 774 `grep -q` assertions on message text; 228 `expect_fail`; 18 test files write `RUN.yaml`, `LEDGER.log` or `ACTIVE_RUN` by
hand. Places that depend on `agent.sh` source text: `status-block-test.sh` (3: `sb_scrub`, `sb_strip`, `SB_KEYS=`), `risk-test.sh`
(2: `risk_words_match`), `gates-test.sh` (1: `blocking_rule_version=`), `reply-loop-test.sh` (1: `approval_phrases`),
`check-shared.sh` (the awk config readers); and three `.test.mjs` files read its text (`frontmatter.test.mjs`,
`plan-contract.test.mjs`, `proofline-lead.test.mjs`), a fourth (`docs-writer.test.mjs`) runs it.

Suite size and time: 49 suites split into **459 units**, run in **16 CI shards**; the weights file sums to 21,006 s of
single-core work (about 1,313 s per shard before parallelism; heaviest units 608 s, 591 s, 515 s). Node tests: 976 tests in
294.8 s on Node 24.14.1. Timing-sensitive suites: `kill-guard-test` (87 sleep/kill mentions), `gates-test` (47), `batch-test`
(46), `dispatch-test` (20).

## 7. Node baseline

Documented and CI floor today: Node 22.13 (CONTRIBUTING, for the skill tests; CI pins `node-version: 22`; no `.nvmrc`). By API
evidence the shipped validators need about Node 18; only `visual-proof/scripts/measure.mjs` needs 22 (global WebSocket);
`node:sqlite` without a flag (22.13) is used only by the playground and an e2e probe. Built-ins used: `fs`, `path`, `url`,
`child_process`, `node:test`, `assert/strict`, `os`, `crypto`, `http`, `sqlite`. Not used: `fs.glob`, `util.parseArgs`, import
attributes, type stripping (a fixture only).

## Launchers

The files that remain after stage 15. Each starts Node and holds no logic; the CI rule in stage 15 pins their exact text.

| file | form | why it must exist |
|---|---|---|
| `control-plane/agents/scripts/agent.sh` | `#!/bin/sh` + one `exec node .../proofline-core.mjs "$@"` line | 278 lines in skills and roles name it; models, git hooks and about 2,587 test calls run `sh .agents/scripts/agent.sh`; the hook's deny rules match it |
| `control-plane/agents/scripts/dispatch.sh` | same form, core subcommand `dispatch` | 26 skill, role, doc and hook files tell the lead to run `sh .agents/scripts/dispatch.sh <ID> <role>` |
| `control-plane/agents/githooks/pre-commit`, `pre-push` | same form | git runs an executable file with a shebang at a fixed path (`core.hooksPath`); git for Windows runs it with its bundled `sh` |
| `bin/proofline` | `#!/usr/bin/env node` + one dynamic `import` | users type `proofline`; Node resolves the symlink that `install` creates |
| `bin/proofline.cmd` (new) | one line, `@node "%~dp0proofline" %*` | Windows `cmd` and PowerShell do not read a shebang |
| hook commands in `adapters/claude/hooks/hooks.json`, `adapters/claude/settings.fragment.json`, `adapters/codex/hooks.json` (7 events each) | one pinned command string per event that runs `node` | the runtimes take a shell command string; the project and Codex forms keep a pinned fail-closed guard (see the ADR) |

Shell that stays because it is the user's data, not proofline code: command strings in `config.yaml` (`commands.*`,
`dispatch.command_template`, `commands.secret_scan`) and a task adapter that a user writes as `<name>.sh`.
