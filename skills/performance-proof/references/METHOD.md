# Method

## 1. Find the benchmark command

The command must be defined by the project itself. Look, in this order, and record the file that proves it:

| Where | What counts |
|---|---|
| PLAN.md | a benchmark command named in `## Verification commands`, `## Risk` or a criterion |
| package scripts | `bench`, `benchmark`, `perf` scripts (`package.json`, `composer.json`, `pyproject.toml` tasks) |
| build files | a `bench` target in `Makefile`, `justfile`, `Taskfile.yml`, Gradle or Maven benchmark tasks |
| language conventions already in the repo | `func Benchmark...` in `*_test.go` (`go test -run '^$' -bench ...`), a `benches/` directory with a `[[bench]]` entry (`cargo bench`), a benchmark project already referenced by the solution, pytest benchmark fixtures already in the dev dependencies |
| CI config | a job or step that runs a benchmark |

Not a benchmark command: a tool that is installed on the machine but not referenced by the project, a command
from the README that the project's scripts or CI do not run, a test suite run used as a stopwatch (unless the
plan names it as the measurement). Nothing is installed to get a command.

Prove the command with one real trial on the change worktree before measuring (exit 0, output parsed). It must
exercise the changed code: a benchmark of an unrelated module measures nothing about this change. Use the
impact report or the call path to show it; if no benchmark reaches the changed code, the result is
UNSUPPORTED ("no benchmark exercises <symbol>").

Absent, unprovable, or needing a database other than the project's own throwaway test database: UNSUPPORTED,
with the reason in `unsupported_reason` and the next step (the user adds a benchmark, or waives the check).

## 2. Worktrees

```
base=$(git merge-base <base_sha or the target branch> HEAD)     # team: the assignment's base_sha
wt=$(mktemp -d "${TMPDIR:-/tmp}/perf-proof.XXXXXX")              # record "$wt" in the ledger first
git worktree add --detach "$wt/base" "$base"
git worktree add --detach "$wt/change" HEAD                      # then copy the task's uncommitted changes in
```

- Copy uncommitted and untracked task files into `$wt/change` (`git diff --binary HEAD | git -C "$wt/change" apply`, plus the untracked files the task owns).
- Symlink git-ignored dependency folders (`node_modules`, `vendor`, a virtualenv) when the project would otherwise need an install; if the change modifies the dependency manifest, the sides need different dependencies: UNSUPPORTED unless both can be prepared without installing anything.
- Never link or copy build output. Build both sides with the project's build command, untimed, before any timed run.
- Remove both worktrees at the end (`git worktree remove --force <recorded path>` after a `realpath` check that it is inside the recorded temp directory).

## 3. Measure

- **Runs.** At least `min_runs` (default 10) per side; more when the command is short or the machine is shared. Warmup: at least 1 untimed run per side.
- **Timeout.** 3x the slowest warmup run, never less than 30 seconds (`--timeout`).
- **Wall time** with `run-bench.sh` for any command: it alternates base and change (ABBA), writes `base.csv`, `change.csv` (milliseconds) and `environment.txt`, and exits 1 when a run failed (the failed row stays in the CSV with its exit code; `compare-bench.mjs` refuses such a file, so fix nothing by hand: report it).
- **Tool-reported metrics** (`ns/op`, operations per second, p95 latency printed by the project's benchmark): run the tool the same interleaved way (one invocation per run and side) and write one sample per run to `{"unit": "<unit as printed>", "samples": [...]}` per side. Higher-is-better metrics use `--direction higher`. Never mix the tool's units across sides.
- **Quiet machine.** Do not run other heavy work at the same time; note in the ledger anything that ran concurrently. The load average before and after is in the environment block, so a reader can see a busy machine.
- **Same conditions.** Same environment variables, flags, input files and build mode on both sides. If the change itself alters the benchmark (new input, new flags), the comparison is not like for like: measure with the base's benchmark on both sides, or report UNSUPPORTED with the reason.

## 4. When the result is INCONCLUSIVE

Do not shop for a better result. One re-measurement with more runs (for example double `--runs`) on a quieter
machine is fine; record both attempts in the ledger and report the last complete one. If it stays
INCONCLUSIVE, report it: the user decides (re-run elsewhere, or waive the check).
