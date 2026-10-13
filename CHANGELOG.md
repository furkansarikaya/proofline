# Changelog

## Unreleased

- Deterministic result submission (`agent.sh submit`), class verified against the diff, expand/contract rule for destructive plans, English run artifacts, and the fixes of five end-to-end rounds (decisions A30–A39).
- Database guard: no agent touches a database file, runs a SQL client or a migration/seed command; the control plane detects changed database files (A40).
- The lead never approves: the runtime records the user's reply as the approval (A41).
- The QA plan is derived from the final plan and verified against it before freeze (A42); results cite immutable artifact snapshots (A43); a Stop hook keeps gate names, classes and states untranslated in the final report (A44).
- tdd-proof validates one cycle per criterion (A45); Claude specialists under an isolated-HOME Codex lead get the operator's HOME (A46).
- Faster CI (A76): self-test suites run as parallel scenario units in four shards, pull requests run Linux only (macOS on `main` and nightly), documentation-only pull requests skip the test jobs, and the `checks` job always reports.
- A `fix_scope` entry `path:symbol` (or `path:line`) scopes to its path, so a fix round no longer stalls at IMPLEMENTING on a symbol-qualified scope (A77).
- Every role asks all its questions in one NEEDS_INPUT round, enforced by `submit` and `record`; intent-grill's multi-round interview (the task author's `design/INTENT.md` rounds) is exempt (A70, A75).
- Benchmark report (A90): `node tests/benchmark/benchmark.mjs` scores recorded results of the existing fixtures and e2e runs per skill (correct, missed, false positives, scope adherence, duration, tokens); no new scenarios, no model calls.
- `proofline insights [--run ID] [--json]` (A89): a read-only report of cost per run, role and model (tokens only where recorded, `n/a` otherwise) and recurring failures (repeated findings, gate FAILs, scope violations, UNSUPPORTED checks, repeated approvals) with suggestions; it never changes a rule, skill, config, ledger or metrics file.
- Metrics and cost (A80): versioned JSON records in `.agents/local/metrics/records.jsonl` with duration per dispatch, runtime-reported tokens (null when not reported, never estimated), turns, retries, delegations and the result per gate; `metrics: off` still disables everything.
- Assumption register (A79): a mandatory `## Assumptions` section in PLAN.md and EVIDENCE.md, checked by both validators; `agent.sh freeze`/`refreeze` refuse an unverified high-risk assumption until the user answers it (recorded as `accepted-by-user`), `agent.sh verify-assumptions` shows the register, and the completion report lists every unverified or accepted-by-user assumption.
- evidence-map `impact` mode (A85): the Explorer produces a versioned JSON impact report for changed symbols, files or a base ref (references marked exact, textual or heuristic, homonyms excluded, affected modules, contracts, tests) with the limits of static analysis and the unknown cross-repo consumers stated, plus a validator that re-checks every cited line; plan scope, test-trust diff mode, verify-proof and contract-proof read it through the documented interface.
- Risk-adaptive pipeline (A78): deterministic risk signals (contract, migration, UI, dependency and config paths, optional content hints, PLAN.md flags) add focuses inside the existing gates; `agent.sh pipeline` shows each signal, its source and its check; an undeclared signal is a blocking finding; an unavailable check is UNSUPPORTED, never a PASS; the mapping is frozen with the plan. Until the contract, concurrency, performance and visual skills exist, a run that changes a contract or UI path (or sets the matching flag) needs an UNSUPPORTED result for that focus, which only the user can waive; a migration path makes the tier full.
- data-design migration validation (A84): the REVIEW_DATA `migration` focus applies migrations only on the test suite's own throwaway database, compares schema snapshots and seed rows, and reports lock, long-run, DDL-pattern and mixed-version risks; no such database is UNSUPPORTED, never PASS (`migration-check.mjs`, `validate-migration.mjs`, `fixtures/migration-validation`).
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
