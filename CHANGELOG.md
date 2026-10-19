# Changelog

## Unreleased

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
