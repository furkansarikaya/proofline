# Adopting proofline in an existing project

The first-day path for a repository that already has code and tests: install, write the design documents from the code, choose a task adapter, run one small task and check the test suite. For a maintainer adopting proofline; the daily routine afterwards is in [daily use](daily-use.md).

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
Check the discovered commands: the verify gate runs them (`--verify-commands`). If `commands.build`, `commands.test` or `commands.lint` stayed empty, `proofline doctor --commands` looks for them, proves each by one run and writes the proposal only after your yes (`--apply-commands`); in the scratch project used to check this guide (a `package.json` with a `test` script and no build or lint) `init` left `commands.build` and `commands.lint` empty and said so. `commands.build`, `commands.test` and `commands.lint` take one command or a list, one `- command` line each, so a repository with a .NET backend and a React frontend gets both; an ecosystem with several candidate projects gets none and `init` names it ([ecosystems](../concepts/ecosystems.md)).

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
runs the same check (design-sync) on tasks that touch these contracts. Locations are configurable in `design_docs:`; `design_docs.design` can also hold one document per UI surface ([design surfaces](../concepts/design-surfaces.md)).

## 3. Pick a task adapter

`markdown` (default) is tested; `github` (via `gh`) is tested against a fake `gh`; `jira` and `linear` follow the adapter contract and
are labelled "not tested" (a fake `fetch` only, no real service; [task integrations](../../control-plane/agents/task-integrations/README.md)). Set it at `init` (`--task-adapter`) or in `tasks.adapter`. See [task templates](task-templates.md).

## 4. Start small

Pick one STANDARD task, run `proofline run <TASK>` (in Claude Code `/proofline run <TASK>`; a terminal only prints that instruction), and read the completion report. If the tier or gates feel
wrong for your repository, tune `review.risky_paths`, `review.small_max_files` and `review.small_max_lines` in config.

## 5. Existing test suite

`proofline audit` runs test-trust (flaky, hollow and slow tests with runnable evidence) before you rely on
the suite as proof. `proofline review` reviews an existing branch or diff on its own.

## 6. Upgrading later

`proofline upgrade --dry-run` lists what would change; `proofline upgrade` updates the unmodified control-plane files and reports conflicts with files you edited instead of overwriting them. Run `proofline doctor` afterwards.

Related: [daily use](daily-use.md), [gates](../concepts/gates.md), [ecosystems](../concepts/ecosystems.md).
