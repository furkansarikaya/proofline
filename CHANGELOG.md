# Changelog

## Unreleased

- Deterministic result submission (`agent.sh submit`), class verified against the diff, expand/contract rule for destructive plans, English run artifacts, and the fixes of five end-to-end rounds (decisions A30–A39).
- Database guard: no agent touches a database file, runs a SQL client or a migration/seed command; the control plane detects changed database files (A40).
- The lead never approves: the runtime records the user's reply as the approval (A41).
- The QA plan is derived from the final plan and verified against it before freeze (A42); results cite immutable artifact snapshots (A43); a Stop hook keeps gate names, classes and states untranslated in the final report (A44).
- tdd-proof validates one cycle per criterion (A45); Claude specialists under an isolated-HOME Codex lead get the operator's HOME (A46).
- Faster CI (A76): self-test suites run as parallel scenario units in four shards, pull requests run Linux only (macOS on `main` and nightly), documentation-only pull requests skip the test jobs, and the `checks` job always reports.
- `SECURITY.md` and `CONTRIBUTING.md`; the Acknowledgments section is removed and D33 states that no third-party project is named.

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
