# Adopting proofline in an existing project

## 1. Install

```sh
cd your-project          # a git repository
proofline init --dry-run # see what would change
proofline init
proofline doctor
```

`init` discovers your language, build and test commands and fills `.agents/config.yaml`. It never overwrites
existing files: `AGENTS.md` and `CLAUDE.md` are merged, and it shows what changed. Set protected branches and
forbidden commit identities (`--protected-branches "a b"`, `--forbidden-identity PATTERN`) if your team has them.
Check the discovered commands: the verify gate runs them (`--verify-commands`).

## 2. Reverse-engineer the design documents first

A task works best when the durable design documents exist, so the first runs have real context instead of
guesses. Run these once, in this order:

```sh
proofline design system   # docs/design/ARCHITECTURE.md from the code (system-design skill)
proofline design data     # docs/design/DATA_MODEL.md from schema or migrations (data-design skill)
proofline design api      # edits your existing contract (OpenAPI, GraphQL, protobuf...) or writes docs/design/API.md
proofline design ui       # docs/design/DESIGN.md (tokens, typography, spacing, components) from the existing UI
```

Every component maps to a verified repository path. Read the drafts and correct them; they are yours.
Later, `proofline design <kind> --check` reports drift as `doc:line -> missing code fact`, and the verify gate
runs the same check (design-sync) on tasks that touch these contracts. Locations are configurable in `design_docs:`.

## 3. Pick a task adapter

`markdown` (default) and `github` (via `gh`) are tested; `jira` and `linear` follow the adapter contract and
are labelled "not tested". Set it at `init` (`--task-adapter`) or in `tasks.adapter`. See [task templates](task-templates.md).

## 4. Start small

Pick one STANDARD task, run `proofline run <TASK>`, and read the completion report. If the tier or gates feel
wrong for your repository, tune `review.risky_paths`, `review.small_max_files` and `review.small_max_lines` in config.

## 5. Existing test suite

`proofline audit` runs test-trust (flaky, hollow and slow tests with runnable evidence) before you rely on
the suite as proof. `proofline review` reviews an existing branch or diff on its own.

Related: [daily use](daily-use.md), [gates](../concepts/gates.md).
