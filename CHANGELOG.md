# Changelog

## Unreleased

- A CI-fix round runs on GitLab and Azure DevOps as well as GitHub, and the platform can come from config (A186): the platform adapter reads the failed check and its log (`glab`, `az`; the round starts from the name and status and says so when no log can be read), `git.platform` and `git.platform_host` name a private host (config, then `PROOFLINE_PLATFORM`, then the origin URL; `proofline doctor` shows which), the host must equal the origin's host, and `GH_HOST`, `GITLAB_HOST` and the Azure DevOps Server organization URL follow it.
- Path classification follows the git worktree root (A184): the lead can write `EVIDENCE.md` in a run's worktree (`.agents/local/worktrees/<ID>/.agents/runs/<ID>/`) while run state, gates, approvals and the worktree's `.agents/local/**` stay protected; the root comes from `agent.sh worktree-root`, which answers only for a registered worktree of the project (a crafted folder or link is not one). Explorers return a claims table (with an example in the role and the assignment); a prose report goes back to the same explorer and the lead never writes `EVIDENCE.md` from prose. Rejected: a path-string allowance for `.agents/local/worktrees/**`.

## 0.0.32 — 2026-10-26

- Delivery works on GitHub, GitLab and Azure DevOps (A180): the platform comes from the exact host of `origin` (`PROOFLINE_PLATFORM` names a self-hosted one), `proofline merge` applies the same fail-closed checks through gh, glab or az, and on Bitbucket, other hosts or without the tool the branch is pushed and you merge. A pull request with no checks is merged only after build and test pass in a clean export of the exact commit, and says so; "no CI" is a warning. The hook also denies glab, az and HTTP-client merge paths. Known limit: az has no match-head option.
- Night mode runs in the same session and the headless driver is removed (A181): the lead runs and delivers each task in order, `agent.sh batch-next` prints the state from records, one session owns a batch, a merge is recorded before cleanup and recovered from the platform, and `batch-awake` keeps a Mac awake with `caffeinate`. `batch.task_timeout` and `batch.runtimes` are accepted and ignored.
- `design_docs.design` can hold one document per surface (A182): `agent.sh design-surface <PATH>` and `design-sync.mjs` resolve a file with the same rules; a `paths` glob allows one `**/`.
- Codex support labels follow recorded use (A183): Codex as implementer is supported, other Codex roles are not yet verified in real use, and failover from Codex to Claude works in real use.

## 0.0.31 — 2026-10-25

- The pre-commit hook asks for the commit approval with the full content fingerprint (A179): `approve delivery` binds the approval to the content including the knowledge step's documents (ADRs, wiki, IMAGES.md), but the hook looked it up with the gate fingerprint, which leaves them out, so a delivery whose knowledge step wrote documents was refused with "no user commit approval for this content" for an agent session. `githooks-test.sh` pins the binding.
- `deliver-test.sh` no longer fails on the second push scenario: both scenarios shared one bare remote, so the branch of the first made the push of the second a non-fast-forward; each scenario now starts from a fresh remote, and a failed push shows git's message. A test fix, the product code is unchanged.

## 0.0.30 — 2026-10-25

- proofline no longer assumes a folder layout (A173): `proofline init` finds the build, test and lint commands of a root, nested, multi-project or monorepo project in every ecosystem from one definition (`control-plane/agents/ecosystems.json`); .NET `.slnx`, `*.fsproj` and `*.vbproj` are supported, `dotnet build App.slnx` is proposed only when exactly one target exists, and zero or several targets of an ecosystem propose no command for it instead of a broken one (`MSB1011`, `MSB1003`). `proofline doctor` and verify-proof read runtime versions of nested projects and of java, rust, php, ruby, swift and dart too. See [ecosystems](docs/concepts/ecosystems.md).
- Risky paths, dependency manifests, benchmark and native-UI markers come from the same definition (A174): `review.risky_paths` and the `dependencies` risk signal add the manifests, locks, package-source settings and build-changing files of every ecosystem at read time, so `config.yaml` keeps only project-specific globs (no edit on upgrade; runs frozen before keep their paths and still verify). The exploit-proof manifest diff reads every manifest kind, including `*.fsproj`, `Directory.Build.props`, Gradle version catalogs and package sources (`.npmrc`, `NuGet.config`, `pip.conf`, `.cargo/config.toml`, `settings.xml`) as `index:<host>`; design-sync, the performance probe (no `head -50`, no depth limit) and visual-proof's native detection (MAUI by `UseMaui` true) read the same list.
- tdd-proof classifies test output from real runner output (A175): `test_output` in the definition names the runner and the evidence of every pattern (`captured` fixtures with tool, version, command and exit code, or `docs`); no guessed pattern is kept and `RED.md` lists what is not covered. Nothing-ran output no longer reads as RED: VSTest exits 0 when no test ran (also for a `--filter` that matches nothing), Microsoft.Testing.Platform exits 8, and a .NET 10 MTP project without `global.json` `test.runner` fails to build (`compile`). `--exit-code` and `--ecosystem` are cross-checks only. The [ecosystem matrix](docs/concepts/ecosystems.md#ecosystem-matrix) says what was verified with a real tool, from documentation or by code reading only.
- `commands.build`, `commands.test` and `commands.lint` take a list of commands (A176): a block list under the key, the scalar stays valid. The build record and the verify re-run run every command of a key, report each (`build[2/3]`, exit, output tail, a `failed:` line) and a failed key stops the next one; `config-check` rejects a value plus a list, an empty item, a duplicate and an inline `[a, b]`. Discovery adds one command per ecosystem (a root .NET solution plus a nested npm app give a list), a Makefile, justfile, Taskfile, CI or README command covers the whole repository, and a root project no longer hides a nested project of another ecosystem.
- `proofline doctor` no longer reads `runtime: none` as a runtime named "none" (A173); the fresh-install test has a Node fixture and a no-runtime fixture.
- A suite cannot go red from a dying scenario: `run_sc` in `tests/cli/cli-test.sh` ran scenarios in a subshell that ended with a `printf`, so a scenario that died exited 0 and the cli suite could never fail in `selftest.sh`; it now propagates the failure (A177).
- The question the script stores for you in your own language (`questions/NNN.md`, written by `agent.sh ask` and for a specialist's question) is no longer refused by the run language check, so a Turkish question no longer blocks `handoff DONE` (A178); the same text anywhere else in a run is still refused.

## 0.0.29 — 2026-10-24

- Finding ids have one identity (A172): `submit` and `record` take the prefix from one function, so a QA plan step with findings (`qa-1`, a task result) is no longer rejected after it was written; gate ids (`QA-1`, `REVIEW_TESTS-2`) and task ids (`explorer-3`) are unchanged. Ids (`QA-n`, `AC-n`, `AS-n`, `FR-n`, finding ids) are compared by key, case-insensitive and ignoring leading zeros, in `agent.sh` and the validators of the QA plan, plan-contract, tdd-proof, verify-proof, test-trust, evidence-map, ui-design, visual-proof, product-spec, task-author and product claims; `waive` and its approval accept a finding id in any case.
- The language check lets a project in another language quote its own product text (A172): inline code, a double-quoted span, a `> ` line, a fenced line or a JSON string value is exempt when its exact text (at least 4 characters) is in the run's `TASK.md`, the captured user messages or a product file committed to git (never a staged or untracked one); a sentence an agent wrote itself is still refused. `reviews/visual-proof/` and `reports/qa-evidence/` are machine output and exempt. The refusal tells agents to quote, never to transliterate to ASCII or to ask you; the same rule is in every role, the shared skill rule and the `AGENTS.md` block.
- visual-proof reports Turkish typed without its letters on a Turkish language page as information (`design.language_notes`, never blocking); the words and an allow list are `visual.ascii_turkish_words` and `visual.ascii_turkish_allow` in `.agents/config.yaml`.

## 0.0.28 — 2026-10-23

- Reviews list every instance of a blocking rule finding in one pass (`scan:` and `instances:` evidence, enforced by `record`); a failing record that only carries over lines the previous revision already had costs no fix round; the blocking-or-info rule is written, versioned and stable across rounds; a mutation budget overrun (21/20) is a warning (A171).
- Gate dependencies are written in `GATES.md` and enforced: VERIFY is refused before QA `visual`; the build record is made at `handoff IMPLEMENTED` and `next` lists it when missing (A171).
- Drift in `DESIGN.md` and `design_docs` is information before the knowledge step, which must fix it, and blocks delivery after it; the knowledge step's own files no longer make the gates stale (A171).
- Approvals are transparent (`.agents/local/approve.log`, one-line reason, stale markers cleaned, recorded from the newest message when the hook could not); hook durations and timeouts reach the ledger and the friction report, and the prompt hook records first and has a time budget (A171).
- `answer --captured` takes the newest user message after the question and says which; `answer --amend` corrects a recorded answer with a newer user message and keeps the old record; user text is stored in `> ` quote blocks that the language check exempts, and the check runs at write time (A171).
- Freeze stops above `pipelines.<CLASS>.max_scope_paths` (15 for STANDARD and COMPLEX) and proposes a split; "proceed without splitting" is recorded; the dispatch timeout comes from `dispatch_timeout_seconds` per class and a timed-out dispatch resumes from a note (A171).
- The hook accepts variables assigned a literal in the same command and reads of the runtime's background task output; `decide` is refused before a dispatch and has a read-only `--dry` and a one-line summary first; the lead never asks the user to run an internal command (`friction-note`) and waits in one line (`wait-line`) (A171).

## 0.0.27 — 2026-10-23

- `ui-design` rebalances the 0.0.4 `avoided` rule (A170): each surface has a visitor mode (`persuade`, `operate`, `read`, `experience`); persuade and experience surfaces need a topic inventory, an argument tied to facts, an idea that fails the rival test, three directions dealt by `scripts/deal.mjs` plus a calm standard option, one live thing, real imagery, a motion layer and a characterful self-hosted font.
- Looks that generated UIs converge on are a dated registry of 15 pattern ids, defaults that need a `## Pattern justifications` line in `DESIGN.md`, not bans; new references cover direction, patterns, fullness and visuals, type and colour, motion, copy and controls, and operate surfaces.
- `visual-proof` gets an optional `design` group (1440, 768 and 390 wide): heading lines, type scale, body measure, fonts, edge margins, vacuum, untitled sections, empty hero, theme surfaces, untranslated text, motion, reduced motion, text without script, pinned scenes and the image ledger; a failed item blocks the gate.
- `scripts/lint-source.mjs` reads project source for the registry patterns and writes `lint.json`; blocking findings fail the report unless `DESIGN.md` justifies them. `docs/design/IMAGES.md` is the image and font ledger.
- A 14-point critique (`ok` or `concern` with a reason, no score) is judged for COMPLEX and CRITICAL reports with a design group and never closes the gate.
- The implementer of a UI task looks and fixes before delivery (the auditor, the critique, the three biggest problems, at most three rounds); the designer writes `DESIGN.md` first for persuade and experience, and the knowledge step updates it from the built world.
- Design library (A170): `skills/ui-design/library/` holds byte-identical data files from two MIT-licensed sources recorded in `THIRD_PARTY_NOTICES.md`, with our own adaptation layer in `library/adapt/`; `tests/ci/sync-design-library.sh` re-fetches at the pinned commits and `--check` verifies the copies. This reverses the 0.0.4 decision of no ready-made style catalogue: the library is composition, typography and motion decisions, not a theme.
- `scripts/deal.mjs` replaces designer-derived candidates: it deals three directions (hero, section templates, type, palette, motion; operate: app style, shell, patterns) from the surface mode, sector, tone, real imagery and section roles, never one that needs absent imagery, no model and no network, same seed same result; `--redraw <slot> --reason` changes one slot; the calm standard option stays and is never recommended.
- Library fonts are self-hosted with a verified licence (written to the ledger `## Fonts`; unverifiable means not used); library photos are self-hosted and credited and never count as the project's own imagery.
- UX rules: `visual-proof` carries `ux-rules.json`; measurable ones run as `design_ux_*` checks, the rest are judged (`ux_review`); the chart guide picks chart types.
- New command form `/proofline design ui <mode> <target>` with the modes `bolder quieter polish animate typeset colorize layout delight harden adapt`; each touches only its target and `scripts/scope-check.mjs` verifies that nothing outside changed.
- Persuade surfaces get a comp (draft visual) before coding when the runtime has an image tool, which the implementer targets and QA compares against; UI tasks on a persuade or experience surface run designer and implementer on the strongest model (signal `ui_persuade`).
- Reality check of deal on three briefs: restaurant site and admin, developer tool site and docs fit; a city-tour map app is partial because the library has no map-canvas screen pattern.

## 0.0.26 — 2026-10-23

- Release version bumps use `sh tests/ci/bump-version.sh <new-version>` (and `--check`), which rewrites only the version-holding sites by anchored patterns, so historical mentions such as "(0.0.24)" in visual-proof comments are no longer overwritten (A168). Those three comments are restored.
- A red CI after the pull request is open is a finding, not a question: `agent.sh deliver-step <ID> ci-fix|ci-commit|ci-push|ci-merge <PR>` fixes it in at most 2 gated rounds, pushed to the same branch the delivery approval names (A169); `resume` continues an open round, a batch parks the task on the third red CI.
- A run's own delivery and knowledge commits (task file move, wiki, ADRs) no longer make its plan stale (A169).
- Night mode runs every task in a git worktree of its own, `.agents/local/worktrees/<ID>`; a parked task or one awaiting its merge blocks no independent task, a task starts only when its dependencies are merged, and `agent.sh worktree-add|worktree-path|worktree-remove` give a second run outside night mode the same worktree (A169).
- `proofline doctor` and the verifier (`## Runtime` in VERIFY.md) warn when the local node, dotnet, go or python version differs from what the project's CI specifies; never a FAIL (A169).
- The lead can no longer write product files when no run is active; the hook says to propose `/proofline run <text>` (A169).
- The Stop hook checks identifiers only on a run's final report, not on ordinary answers (A169).
- `approve` takes several kinds in one process and `approve-pending` calls it once per target, so the 30 s prompt-hook time limit cannot leave a delivery approved in part; a partial reply is refused with a text telling the user to send `approve delivery` again (A169).

## 0.0.25 — 2026-10-22

- Batch driver tests no longer fail at random: the EXIT trap of `sc_driver_stop` and `sc_driver_crash` guards its `kill` so a helper that is already gone does not turn a passed scenario into exit 1. The driver itself was not affected.
- The README is shorter (12482 to 10895 bytes) with the same bound; "Real output" moved to `docs/concepts/workflow.md`.
- The native output formats that `visual-proof` measures are documented in `docs/concepts/testing.md`.

## 0.0.24 — 2026-10-22

- visual-proof measures native apps (Flutter, Android, iOS, React Native, desktop) with the UI or screenshot test tool the project already has: `scripts/native.mjs --detect` decides the target from files and finds the tool and its run command (`--run` proves it once); uiautomator and generic JSON output are measured (labels, touch target 44pt/48dp, large text, dark theme, a screenshot per spec state). Unmeasurable checks are `not_measured`; no tool or device is `UNSUPPORTED` with one suggestion line, never a pass. Nothing is installed. Web behaviour is unchanged (A166, amends A82, A147).
- ui-design gets a native mobile rule set (`references/NATIVE.md`) and an optional `target` in UI.md (`web` default, `ios`, `android`, `flutter`, `react-native`); `keyboard` per screen is optional off web.

## 0.0.23 — 2026-10-22

- New skills `product-discovery` and `product-assess` and commands `/proofline product discover frame|research|interviews|competitors|opportunities <slug>`, `/proofline product assess assumptions|probes|premortem|redteam|decision <slug>` and `/proofline product outcome <slug>` (A165, amends A164). Every fact carries a URL, access date and verbatim quote; a number that is not a sourced fact is rejected; competitor cells older than `product.stale_days` (default 90) are flagged stale; interview quotes are checked against raw text that stays outside version control.
- New fact source `[fact: ref <slug>#C-n]` cites a discovery claim by id from a PRD.
- Probe thresholds are locked by hash before the result; a changed threshold is rejected. The red team is the reviewer role with focus `strategy`. `DECISION.md` holds `decision: build|clarify|stop`, and `check-prd.mjs --ready` refuses a split under `stop`.
- Outcomes record baseline, script and output hashes and the measured value; `check-outcome.mjs` rejects a value that differs from the output file.
- `/proofline trace` also shows evidence, assumption, decision and outcome links; every new command ends with the user's next step.

## 0.0.22 — 2026-10-22

- CI is faster: macOS, the headless-browser measurement and the benchmark report run only on the nightly schedule and on manual runs; pushes to main and pull requests run Linux only (A164, replaces the macOS part of A76).
- Self-tests copy one cached template repository (keyed by a hash of the control-plane files) per scenario instead of installing proofline again; `next-user-test` `sc_every_state` and `cli-test` are split into scenario units; CI uploads per-unit timings (`SELFTEST_TIMES_FILE`), `tests/selftest-weights.sh` rebuilds `tests/selftest-weights.txt` from them, and an unlisted unit weighs the median of the listed ones.
- `tests/affected.sh` (with `tests/affected-map.txt`; `--list`, `--all`) names the suites a change can affect; it only decides what is safe to skip, and anything unmapped, shared or uncertain runs the suite.
- CONTRIBUTING has a "Working agreement" (lead, review and agent-hygiene rules) and a test policy; later releases cite them.
- Fixed a race in `batch-test` `sc_driver_stop` and `sc_driver_crash` on loaded macOS runners (empty pid files, process group set late).
- New product evidence model: product claims are `fact` (with a web, interview or data source), `assumption` (with a risk type) or `decision` (who, on what basis); `validate-product-claims.mjs` rejects a sourceless fact and reports unmarked claims.
- New `product-spec` skill: PRD at `docs/product/<slug>/PRD.md` (`product.dir`), a deterministic PRD check (unmeasurable words in English and Turkish, extensible with `product.vague_words`; empty non-goals; metric without a method; requirement without an id), a readiness gate, a coverage check (every FR/NFR is linked to a task or deferred with a reason) and a read-only trace.
- The reviewer role gets the focus `spec` (two-engineer test, scope triple, claim ledger, metric audit; ship / ship-with-conditions / do-not-ship; at most 2 rounds); no new role.
- New commands `/proofline product prd|review|split <slug>` and `/proofline trace <FR-n|TASK-ID>`; `docs/concepts/product.md`; `docs/product/` is in the knowledge scope.
- intent-grill asks up to three independent numbered questions at once, each with lettered options and a recommendation, so one line like `1A, 2C` answers them; it reads back each understood part, marks guesses as "tahmin" and asks what would count as failure even if it works technically.

## 0.0.21 — 2026-10-21

- The task file moves to `done/` in the delivery commit (markdown adapter only), not after the merge: `agent.sh task-source-done <ID>` runs in the commit step. When the merge fails, the move exists only in the unmerged pull request branch and the delivery says so (A163).
- A project with no CI check on pull requests is told early: `proofline doctor` warns, the delivery summary warns, and `batch-plan` writes a BLOCKER into the summary and refuses the batch. The next step is one ready `/proofline task Add a GitHub Actions workflow ...` line (`agent.sh ci-check`, `ci-task-command`). There is no setting that merges without CI; `proofline merge` still does not merge a pull request without checks (A163).
- `approve batch` starts the night driver in the background, detached from the session (`agent.sh batch-start`; no separate terminal command). It writes `driver.pid` and `driver.log` under `.agents/local/batch/`, keeps the computer awake with `caffeinate -i -w` or `systemd-inhibit`, refuses a second start and prints `plug in the computer; do not close the laptop lid.` The batch summary says that line once (A163).
- New `proofline batch stop` (`agent.sh batch-stop`): stops only the driver it recorded, by its verified process group, never by name, and parks the running task with the reason `stopped`. `batch status` starts with a `driver:` line (A163).
- The next step knows the new flows: no CI gives the ready CI task line (also for `deliver` and `--error=ci`), `batch` after approval gives `driver started, log: ... In the morning: /proofline batch status`, `batch status` names the parked task and its open question, `batch stop` gives `/proofline batch status` (A163).

## 0.0.20 — 2026-10-20

- Input validation detection has two tiers. A `## Contracts` bullet that declares an entry point with new or changed input needs a `## Validation` line per entry point, and the QA plan needs an `[invalid-input]` scenario for it; `agent.sh freeze` and `refreeze` refuse either gap. A bullet that only mentions an entry word is information (`validation.possible`) and never refuses (A162).
- New `validation.*` config keys (`entry_words`, `entry_candidates`, `entry_input`, `entry_new`, `entry_output`, `entry_skip`, `code_patterns`; extensible, checked by `config-check`); the plan-contract and qa-plan validators read them from the project config. `agent.sh entry-tier` and a labelled corpus pin the tiers; code that looks like an entry point is shown by `agent.sh pipeline` as information only (A162).
- Added a `logging` security focus. A diff that adds a log call (Console, Debug and Trace calls, `Fprint*`, `print`, `puts`, `var_dump`, `dump`) naming a sensitive word (`risk.log_sensitive`, extensible `words`) opens a review of the new `[log]` exploit-proof sink; `config-check` refuses an invalid expression and empty or missing `words` (A162).
- `proofline upgrade` no longer invalidates the freeze of runs in flight: a freeze made before the `risk.log_sensitive` key stays valid and keeps its focus set without `logging` (A162).
- The implementer logs through the project's own logger and standard and never logs secrets. The AGENTS.md template carries no logging text; your own Logging section outside the proofline block survives `upgrade`, and the `rules` review checks it (A162).
- `proofline debt` now lists five more shortcut comments; the check-static rule rejects any foreign shortcut label anywhere in a comment (A162).
- The command-discovery timeout (`init --verify-commands`, `doctor`) closes the whole process group, so no grandchildren of a hung command remain (A162).
- The README is shorter; night-mode and process-rule detail moved to `docs/concepts`. A static check bounds the README size (A162).

## 0.0.19 — 2026-10-20

- Night mode starts every session as leader of a verified process group (`set -m`, `setsid`, perl, python3) and refuses to run when none works; the whole group is closed at the end of a task (A161, #135, #140).
- Codex night sessions run in the permissions profile `proofline_night`, which can commit and write `.agents` (but not `.git/hooks` or `.git/config`) with network on and package-manager caches redirected into the temp dir (verified for npm, pnpm, yarn, pip and go), replacing legacy `workspace-write`, which kept `.git` and `.agents` read-only. `batch-plan` warns when a Codex lead would start Codex workers (sandboxes do not nest on macOS), also warns when Codex can run as the fallback lead runtime, records `codex --version`, and the driver refuses codex-cli older than 0.163.0; `batch status` lists every session with runtime, times, exit code and log path; `batch-plan` refuses non-markdown adapters and names the next step.
- The kill guard also denies `kill 00` / `+0` / `$((0))`, PIDs from `pgrep` or `ps` through variables and loops, `find -exec kill`, `eval` and variable command words, unquoted here-document substitutions, interpreter one-liners and here-documents that kill by name or pattern, and script files the command runs. The hook scanner skips comments and `case` labels, and `kill -TERM "-$pgid"` is no longer mistaken for `xargs kill`. Documented as a tripwire, not a boundary against a hostile agent, with the unseen forms listed (A161, #127).
- Kill guard: `ps -o pid= -C node` and other `NAME=`-shaped arguments no longer let `kill $(ps ...)` through; the denial for code text says that such text cannot be told from a command and that you can run it with `!`; awk patterns are no longer denied.
- Kill guard: scripts that spawn and kill their own child are allowed; `xargs pkill`, arrays and `< <(pgrep x)` loops are denied; hook time on large scripts dropped from 8-48 s to 2-5 s, with a 20 s budget that fails closed for kill words.
- Validator evidence written before an accepted control-plane-only base move is accepted again; an unrelated base is still refused (#128). A lead's `ledger-note` can no longer forge a `base-moved` link; the match is anchored to the ledger line structure.
- A new AGENTS.md or CLAUDE.md that is only the proofline block no longer blocks `reopen` or `verify-scope` while uncommitted; gates recorded by 0.0.12/0.0.13 with such a file present stay valid after the upgrade (#132, #133).
- The stale-plan message names the changed files that are not control plane and says to amend and refreeze or revert; the scope check explains an AGENTS.md or CLAUDE.md that holds text beside the block (#131, kept by design).
- visual-proof: robots.txt rules and page paths are compared in the RFC 9309 percent-encoded form, and `dir/index.html` is checked under the form it is published under, so `Disallow: /dir/index.html` no longer fails a page published as `/dir/` (#137, #140). Browser tests (skipped without a browser) check the inert-script filter, script initiator capture, third-party-before-consent and `site_url` in real Chrome. A missing sitemap.xml or robots.txt stays information, and an image's initiator is attributed by URL only (design decisions, A161).
- visual-proof no longer aborts on a page named `100%.html` or a base folder containing `%te`, and `/a%2Fb` is not treated as `/a/b` against robots.txt.

## 0.0.18 — 2026-10-20

- Night mode is safer (A160, issue #135). A headless session that outlives `batch.task_timeout` (minutes, default 120, shown in the summary) is closed together with its process group, the task is parked with the reason `timeout`, its dependents are skipped and the batch goes on. Every session runs as the leader of its own process group and the driver closes only that group when the task ends, so no leftover process outlives a task. A Codex night session runs `codex exec -s workspace-write` with network access for package installs; `danger-full-access` only when you plan with `agent.sh batch-plan <IDs> --codex-danger-full-access` (a warning in the summary, bound to the approval hash; config and environment cannot enable it). After a merge the driver waits for the CI run of the merge commit's own SHA (never the latest run) and stops when it is red or when no run appears within the new `batch.ci_appear_minutes` (default 10).
- visual-proof SEO is more accurate (A160, issue #137). Analytics counts as loaded only when a third-party request before consent was measured and it belongs to an analytics candidate (generic words or `seo.analytics` hosts, or its initiator); a candidate found by name only (`pixel-art.js` on the page's own origin, a lone `dataLayer`) is an info row, never blocking. `robots.txt` is read per RFC 9309 for Googlebot and Bingbot (the group of the bot's token, else `*`; longest match, Allow wins a tie, `*` and `$`), and a published or sitemap page blocked for a bot is a blocking `seo_robots` failure naming the bot; a page blocked for every tested bot is skipped as `not_applicable` (reason `robots`). The site's own origin (`seo.site_url`) is first party and a document URL is never an analytics initiator. Night mode reads the Codex sandbox choice once after `batch-check`; without a terminal and without `setsid` only the session pid is signalled.
- A report from before 0.0.18 stays valid: page `requests` may still be plain URL strings, and a report without `analytics_before_consent` keeps the old `analytics_detected` rule.

## 0.0.17 — 2026-10-20

- The knowledge step can write the wiki (A159). After CODE_DONE, and for a FAILED or BLOCKED run, the runtime hook lets the lead write `knowledge_scope_root` (`docs/design/ docs/adr/ docs/wiki/`) and the `design_docs` paths, and nothing else; any other stage keeps the ban. New read-only `agent.sh in-knowledge-scope <path>`.
- `agent.sh knowledge-done <ID> not_applicable "<reason>"` needs one specific sentence, records it in `RUN.yaml` (`execution.knowledge_reason`) and the ledger, and the completion report shows it. The script refuses it, naming the signal, when the task changed a documentation path, a contract, a design-document item or user-visible behaviour.
- One knowledge rule in `KNOWLEDGE.md` (always runs after CODE_DONE; KNOWLEDGE_DONE with pages written, or `not_applicable` with a reason); the lifecycle, workflow, lead role and llm-wiki texts point to it.
- Every `/proofline` command ends with one `Next step:` line, always a user command or an action of yours, never an internal one. New `agent.sh next-user` holds the one table (`next-user.sh`); the lead writes the line, the Stop hook adds it when it is missing, and `proofline` prints it for its own commands and failures. `proofline status` and `resume` no longer print the lead's `next=` lines.
- A run started before 0.0.17 has no `knowledge_reason` field, so `knowledge-done ... not_applicable` is refused there, and the reason may not contain `#`.

## 0.0.16 — 2026-10-20

- visual-proof measures technical SEO of public HTML pages (A158). New optional `seo` block in `visual.json` and `seo` section in `report.json`: one `<title>`, one meta description, one valid canonical, hreflang (reciprocal, self reference, `x-default`, valid tags) on multilingual pages, one `<h1>`, Open Graph `og:title` and `og:image`, valid JSON-LD, and per site `sitemap.xml` against the published pages and `robots.txt` (a `Sitemap:` line, no sitemap page blocked). A page that contains an analytics script (found by generic host and path words and `dataLayer`, plus the project's own `seo.analytics` hosts and globals in `visual.json`; an inert consent placeholder such as `type="text/plain"` does not count as a load) is also checked for scripts, requests and globals present before consent; a page without one gets nothing about analytics. A project without public HTML pages runs no seo item (one fixed note), a page blocked by robots is skipped, and an unmeasurable fact is informational, never blocking. Content SEO is out of scope. Reports without `seo` stay valid.

## 0.0.15 — 2026-10-19

- Night mode: `/proofline batch <ID...|all>` orders tasks by `depends_on`, leaves out CRITICAL and unclassified tasks (and tasks that depend on them) and asks one question ("approve batch") about one summary. `proofline batch run` then runs the tasks one at a time, each in a clean headless lead session; the batch approval stands in for the plan approval, the delivery approval (commit, push, pull request, merge when CI is green, cleanup) and a mutation budget raise up to `batch.mutation_budget_cap` (40), and for nothing else. A waiver, scope expansion, new dependency, reopen, destructive change, rule promotion, friction report and fix-round budget park the task with its question; dependents are skipped and the next independent task still runs. `proofline batch status` is the morning table, from records only. New config block `batch:`; new approval kind `batch` (A157).

## 0.0.14 — 2026-10-19

- An `AGENTS.md` or `CLAUDE.md` that `proofline upgrade` creates for the first time no longer makes the plan stale when the whole file is the proofline block (nothing outside the begin/end markers but whitespace). Any other text in it keeps the plan stale, as before.
- After an accepted `base_sha` move (control-plane commits only) the run records the new commit as `repository.base_sha`; the old value stays in the `base-moved` ledger line. Later diffs start at the new base.
- Agents stop only processes they started themselves, by PID. The role rules say so, and the runtime hook denies `pkill`, `killall`, `fuser -k`, `kill -1`, `kill 0`, `kill $(pgrep ...)` and `pgrep ... | xargs kill` for agent tool calls. Commands you type yourself are not affected.

## 0.0.13 — 2026-10-19

- Committing what `proofline upgrade` installed no longer makes the plan stale: when the commits between the run's `base_sha` and HEAD touch only control-plane files (manifest-listed files, `.claude/agents/proofline-*.md`, `.codex/agents/proofline-*.toml`, the proofline block of `AGENTS.md`/`CLAUDE.md`), the moved `base_sha` is accepted and noted in one line, and `reopen` works. Any other changed file still means a stale plan (amendment and refreeze). A path the plan scope names stays tracked.
- A second `reopen` of the same run asks its own question and takes its own approval; an already used request is never reused (it used to stop with "request ... is already approved; request again").
- Only the first `proofline:begin/end` pair in `AGENTS.md`/`CLAUDE.md` is the control-plane block; anything after it is product text.

## 0.0.12 — 2026-10-19

- Everything `proofline upgrade` installs is control plane: the files listed in `.agents/.proofline-manifest` (agent definitions under `.claude/agents/` and `.codex/agents/`, the entry skill) and the proofline block of `AGENTS.md` and `CLAUDE.md` no longer count as out-of-scope changes, no longer change the content fingerprint and no longer make a gate stale. `/proofline reopen` no longer refuses after an upgrade. A path the plan scope names stays tracked; edits outside the proofline block of `AGENTS.md`/`CLAUDE.md` (for example `## Project rules`) still count as product changes.
- `/proofline reopen` asks one question: when the plan needs a higher mutation budget, the budget raise and the reopen are one summary and one question ("raise the budget to N and reopen the run?"), and your one reply records both approvals. The command no longer needs two runs.
- The Stop hook no longer sends the lead back to rewrite a final report that lacks gate names, class, state or `RED`/`GREEN`: it shows the missing lines, verbatim from `agent.sh summary`, as a system message next to the report.

## 0.0.11 — 2026-10-19

- The plan review fails a hunk inside the plan scope that changes behaviour and ties to no acceptance criterion (blocking `unrequested` record). Hunks that do not change behaviour stay informational, and so does any hunk the reviewer is unsure about.
- Observations: the implementer report may carry an `## Observations` section (issues seen but untouched because out of scope). The knowledge step proposes them to you as new tasks; the task author writes a task only after you approve it.
- Shortcut debt: a deliberate shortcut is marked in code with `shortcut: <limit>, <when to improve>`. New `proofline debt` (`/proofline debt`, `agent.sh debt`) lists them read-only with `file:line`; the knowledge step collects them by script into one wiki page.
- The implementer role checks first: needed, in the codebase, in the standard library, in an installed dependency, then minimum code.
- Documentation: the README lists every command (with `reopen`, `knowledge` and `debt`); CONTRIBUTING requires help, entry skill, lead table, README and concepts to change with every user-visible command, option or rule.

## 0.0.10 — 2026-10-19

- `/proofline reopen TASK-ID` takes a FAILED or BLOCKED run back into the workflow, only with your `reopen:<ID>` approval and a recorded reason. The plan stays frozen and its scope is checked again; only gates that did not pass, never concluded or whose inputs changed run again; the fix-round allowance restarts. A mutation-budget decision is asked first. When the gates pass the run is CODE_DONE and `deliver` works.
- `deliver` refuses a FAILED or BLOCKED run in one line (`to reopen: /proofline reopen <ID>`). The draft pull request for a FAILED run (0.0.5/0.0.9) is removed.
- `deliver` no longer stops with `knowledge step not complete`: the lead runs the knowledge step, report and DONE first, then asks once; the summary lists what the knowledge step changed.
- A change confined to `.agents/` (the control plane, `proofline upgrade` included) no longer makes gates stale: the content fingerprint counts product files only.

## 0.0.9 — 2026-10-19

- One-command delivery: `deliver` prepares the run (knowledge first if not done) and `agent.sh deliver-plan` writes `SUMMARY.md` (changed and knowledge paths, commit message, branch, PR kind and body, when merge and cleanup happen, open `rule:*` requests listed separately). One "approve delivery" is recorded as separate approvals for commit, push, pr, merge and cleanup, each bound to the content fingerprint and the summary sha256.
- `agent.sh deliver-step` re-checks content, branch, message, body, HEAD and the step's approval, then prints the commands the lead runs; `agent.sh` never commits, pushes or merges itself. A FAILED run gets a draft PR and no merge step; a normal PR waits for `gh pr checks --watch`, then `proofline merge`, and cleanup runs only when MERGED. `rule:*` promotions are not covered by the delivery approval.

## 0.0.8 — 2026-10-19

- `/proofline knowledge TASK-ID` is listed in the entry skill and in `proofline help`; the help/entry test also compares the lead skill Commands table.
- Lesson promotion is proposed at the second run (one repeat), not the third.
- visual-proof `focus_order` no longer reports false alarms: links inside closed `<details>` (`details:not([open]) > :not(summary)`) are skipped because a real Tab never reaches them, and the sequential-focus start is reset to `body` after the checked elements are focused, so the first Tab does not start mid-page (matters with more than 40 tab stops).

## 0.0.7 — 2026-10-19

- Learning: lesson candidates come from run evidence only (each with a source gate or finding id), repeats are counted by script across runs, and a promotion into `AGENTS.md` `## Project rules` needs a `rule:<ID>` approval.
- `agent.sh calibrate` prints config suggestions from metrics and plans; it never edits a file.
- Friction report at run end (`agent.sh friction`): anonymous and scrubbed; `friction send` files a GitHub issue only after a `report` approval bound to the report hash.

## 0.0.6 — 2026-10-19

- Efficiency: a gate repeats only when the files it looked at changed (unknown file set = stale; SECRETS and SECURITY always repeat on a product change).
- One build and test run per commit (`build-record.sh`), recorded and shared by reviewers and the verifier; the verifier still re-runs on its own.
- `agent.sh plan-section` prints one PLAN.md section; `agent.sh digest` prints a short run summary. Stage transitions say that a context reset is safe (`/proofline resume ID`).
- task-author and intent-grill run in the main interactive session.

## 0.0.5 — 2026-10-18

- visual-proof no longer reports false alarms: non-HTML responses are not measured, content the setup script registers with its `mark(el)` argument is skipped, and overflow inside closed content causes no failure while the page does not scroll sideways.
- During a run proofline's method skills replace overlapping skills from elsewhere; ecosystem skills stay free and no skill is blocked.
- `proofline doctor` warns about foreign context hooks, overlapping skills and empty `commands.build|test|lint`.
- The implementer instruction spells out the `tdd.json` block and the retry path on existing code (RED in a separate worktree at the base revision).
- The lead proposes writing proven commands to the config in one question at run end.
- Fix: no `PLAN.md: No such file` grep error when a worker window opens before the plan exists.
- `/proofline knowledge TASK-ID` runs the knowledge step for FAILED and BLOCKED runs too; `deliver` (including a FAILED run's draft PR) refuses until it is done.
- README: proofline works alongside ecosystem-specific skills.

## 0.0.4 — 2026-10-18

- ui-design offers 2-3 evidence-derived design directions; the user picks one and the choice is recorded. Never for `conform`.
- ui-design can redesign from code without a DESIGN.md: the component inventory is kept, the current visual language is not a reference.
- visual-proof judges a `character` aspect (COMPLEX and CRITICAL, basis new or redesign; the `--ui` flag supplies the basis).
- Font rationale: self-hosted web fonts, licence and performance are stated.
- DESIGN.md holds only the system.
- Fix: task-author `depends_on` now matches the file name `<ID>-*.md`.

## 0.0.3 — 2026-10-18

Fixes and additions since 0.0.2.

- Standalone skill deliverables are written to their project location after the user approves them; evidence stays in `.agents/local`.
- The default DESIGN.md location moves to `docs/design/DESIGN.md`. Existing installs keep their path; `upgrade` offers the move and never moves the file.
- task-author splits large work into tasks, sizes them S, M or L, and groups them into sprints. Optional team distribution reads `.agents/local/team.yaml` (git-ignored). Tasks gain optional `size`, `sprint`, `assignee` and `depends_on` fields.
- Project-wide grill decisions become ADRs; a new ADR that contradicts an older one supersedes it.

## 0.0.2 — 2026-10-18

Fixes and additions since 0.0.1.

- Git hooks tell a person from an agent by session markers (`AGENT_ROLE`, Claude Code and Codex variables), not by a terminal, so pushes from VS Code and GitHub Desktop work (#113). One shared `githooks/human.sh`; `doctor` probes it; the limit and GitHub branch protection are in `ENFORCEMENT.md`.
- New skills: `explain-html` (self-contained HTML explanations), `docs-writer` with a shared writing profile (`writing:` config block), `llm-wiki` (persistent project wiki under `docs/wiki/`).
- New commands: `proofline merge <PR>` merges only on green CI and the hook denies every other merge path; `proofline init --role ROLE=RUNTIME`; `docs`, `explain` and `wiki` are listed in `proofline help`.
- Read-only roles (QA, reviewers, verifier) change nothing in the project tree; the hook denies in-place editors and tree-changing git commands. Completion-report numbers come from recorded facts (`report-facts`).
- Planning and freeze: a destructive step in phase `contract` is accepted; an acceptance criterion with no scope path or test is refused at freeze; a plan-level VERIFY failure routes to amendment and refreeze; the QA plan is derived from the final plan.
- Approvals: a full approval sentence approves for every kind and stays fail-closed; single-use is per capture; the control plane's questions follow the run's language.
- Codex lead runs on the base model (`lead_base_model`); `doctor` reports it.
- Hook and dispatch hardening: file writes outside the project, `sed -i` with an option-looking suffix, `git stash`, stale-lock handling, scratch report paths per explorer.
- Tests and CI: self-test shards balanced by measured weight (six shards), visual-proof browser measurement in its own job, end-to-end expectations tagged `[invariant]` or `[quality]`.
- Docs: README slimmed to the short story (capability detail in `docs/concepts/testing.md`), dated end-to-end results only in `tests/e2e/README.md`.

## 0.0.1 — 2026-10-09

First release. Full scope, not yet proven on real projects.

- Lead plus eleven role sources (`roles/`), rendered by `adapters/generate.sh` into Claude Code agents, Codex agents and prompt prefixes.
- Seventeen method skills plus the `/proofline` command entry skill (`skills/`), including `proofline-lead`, and the test-trust and proof-review skills now maintained here.
- Deterministic control plane (`control-plane/`, installed as `.agents/`): lifecycle, classification, freeze, tiers, gates, fix loop, waivers, approvals, execution policy, failover and resume, enforced by `agent.sh` and git hooks (pre-commit, pre-push).
- `proofline` CLI: `init`, `upgrade`, `doctor`, `version`, `status`, `resume`, `queue`, `deliver`, `clean`, `task`, `design`, `run`, `review`, `audit`, `debug`.
- Claude Code plugin and marketplace manifest; Codex and terminal installer (`adapters/codex/install.sh`).
- Task adapters: markdown and GitHub (tested), Jira and Linear (contract only, not tested); per-target task templates.
- Documentation: concepts, guides (English and Turkish), generated roles and skills references.
- Tests: script self-tests, enforcement tests, skill fixtures.
