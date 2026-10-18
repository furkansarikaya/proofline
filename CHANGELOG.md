# Changelog

## Unreleased

## 0.0.5 — 2026-10-18

- visual-proof no longer reports false alarms: non-HTML responses are not measured, content the setup script registers with its `mark(el)` argument is skipped, and overflow inside closed content causes no failure while the page does not scroll sideways.
- During a run proofline's method skills replace overlapping skills from elsewhere; ecosystem skills stay free and no skill is blocked.
- `proofline doctor` warns about foreign context hooks, overlapping skills and empty `commands.build|test|lint`.
- The implementer instruction spells out the `tdd.json` block and the retry path on existing code (RED in a separate worktree at the base revision).
- The lead proposes writing proven commands to the config in one question at run end.
- Fix: no `PLAN.md: No such file` grep error when a worker window opens before the plan exists.
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
