# Ecosystems and project layout

proofline never assumes or imposes a folder layout (A173). A solution at the root, a project three folders down, several projects side by side and a monorepo with workspaces are all equal. What it knows about each language lives in one file, `control-plane/agents/ecosystems.json` (installed as `.agents/ecosystems.json`), and every script reads that file.

## What proofline does with it

- **Command discovery** (`proofline init`, `proofline doctor`): fills `commands.build`, `commands.test` and `commands.lint` in `.agents/config.yaml` from the project's own files.
- **Runtime versions** (`proofline doctor`, the verify-proof `## Runtime` lines): the local runtime next to the version the project's CI specifies.
- Later checks (review risk paths, the dependency manifests, design drift, native UI, benchmark detection, test-output classes) read the same file; its sections for them exist now.

## Command discovery

The commands are read from the project's own truth, in this order, and the first writer of a kind wins:

1. the declared scripts at the root (`package.json`, `composer.json`);
2. a `Makefile`, `justfile` or `Taskfile`;
3. the build files of each ecosystem at the root;
4. the same for a single nested project;
5. CI configuration, then the README (a lint line such as `dotnet format ... --verify-no-changes` counts).

A guessed command never enters the config unproven (`proofline init --verify-commands` trial-runs it). When the target is ambiguous no command is proposed at all: zero or several candidates give no candidate, never a command that would fail (for example `dotnet build` with two solutions in the folder, `MSB1011`, or with only nested projects, `MSB1003`). Empty commands are handled by the existing 0.0.5 flow: the run that proves a command asks you once, after cleanup, to write it into the config.

How a target is chosen:

- The search has no depth limit. Build output, dependency and tool folders (`bin`, `obj`, `build`, `dist`, `target`, `node_modules`, `vendor`, `.venv`, `artifacts`, `.git`, ... and each ecosystem's own) are not entered. More than 1000 marker files count as "unknown": nothing nested is proposed.
- A workspace root (`pnpm-workspace.yaml`, `package.json` with `workspaces`, `turbo.json`, `nx.json`, `go.work`, a Cargo `[workspace]`, a Maven `<modules>`, a Gradle `settings.gradle` with `include`, a uv workspace, a Dart workspace) stands for its members: they are not candidates of their own.
- The root wins: a project or workspace at the root is the target and is run bare (`cargo test`). Otherwise exactly one outermost nested project is the target and the command is fully targeted (`cargo test --manifest-path core/Cargo.toml`, `npm --prefix web test`, `go -C svc test ./...`). Two or more: no candidate.
- A root project of one ecosystem beats a nested project of another one.
- A path with a space or an unusual character is never a candidate (commands are stored unquoted).

.NET is the one ecosystem whose target is a file. The order is root solutions, root projects, nested solutions, nested projects; the first group with candidates decides, exactly one candidate is used and several are ambiguous. `.slnx` and `.sln` are solutions; a `.sln` beside a same-name `.slnx` is a legacy copy and ignored; `*.csproj`, `*.fsproj` and `*.vbproj` are projects.

| Layout | build | test | lint |
|---|---|---|---|
| `App.slnx` and `src/Api/Api.csproj` | `dotnet build App.slnx` | `dotnet test App.slnx` | |
| `App.slnx` and `App.sln` | `dotnet build App.slnx` | `dotnet test App.slnx` | |
| `App.sln` and `Other.sln` | none | none | |
| only `src/Api/Api.csproj` | `dotnet build src/Api/Api.csproj` | `dotnet test src/Api/Api.csproj` | |
| `src/A/A.csproj` and `tests/B/B.csproj` | none | none | |
| `Lib.fsproj` at the root | `dotnet build` | `dotnet test` | |
| any of the above and a root `.editorconfig` | | | `dotnet format <target> --verify-no-changes` |
| only `web/package.json` (with scripts) | `npm --prefix web run build` | `npm --prefix web test` | |
| only `core/Cargo.toml` | `cargo build --manifest-path core/Cargo.toml` | `cargo test --manifest-path core/Cargo.toml` | |
| only `svc/go.mod` | `go -C svc build ./...` | `go -C svc test ./...` | `go -C svc vet ./...` |
| `go.work` without a root `go.mod` | none | none | none |

Known limits: a `.NET 10` project that runs tests with Microsoft.Testing.Platform may need `--solution` or `--project` in front of the target; the trial run of `--verify-commands` drops a command that fails. Ruby has no targeted form (Bundler needs the project folder as the working directory), so a nested Ruby project gets no candidate. Dart and Flutter test commands have no targeted form either.

## Runtime versions

`runtime-versions.sh` reads the root first, then the same files in nested folders (pruned like above, at most `version_scan_depth` = 6 levels, at most 400 files). A .NET project is present when `global.json`, `*.slnx`, `*.sln`, `*.csproj`, `*.fsproj` or `*.vbproj` exists at the root or nested; a project only under `obj/` or `bin/` is ignored. A `dotnet-version` in a workflow that differs from the local SDK is still reported as `mismatch`. The runtimes are node, dotnet, go, python, java, rust, php, ruby, swift and dart.

## The definition file

`ecosystems.json` has `global` (prune dirs, scan limits, ecosystem-independent risky paths, the CI line patterns) and `ecosystems`, one object each. Adding an ecosystem is adding one object; regenerate the flat copy with `node control-plane/agents/ecosystems.mjs write`. Per ecosystem:

| Key | Meaning |
|---|---|
| `id`, `name` | the id other checks use (`npm`, `python`, `go`, `jvm`, `cargo`, `dotnet`, `php`, `ruby`, `swift`, `dart`) and a title |
| `prune` | folders this ecosystem never enters, on top of `global.prune` |
| `project_files`, `manifests`, `locks`, `settings` | globs: files that make a folder a project; every file that declares dependencies or build inputs; lock files; package-source settings (`.npmrc`, `NuGet.config`, `pip.conf`, `.cargo/config.toml`, `settings.xml`) |
| `workspace_roots` | `{file, contains}`: a file (and an optional line pattern) that makes a folder a workspace root |
| `solution_files`, `units` | solution globs; how the target is chosen (`target` dir or file, `bare`, `stages`, `legacy` twins) |
| `runtime`, `version_files` | the runtime name, how many version components are compared, presence globs, how the local version is read; the ordered sources of the CI-specified version |
| `risky_paths` | extra paths that must never be reviewed as small: build-changing files (`Directory.Build.props`, `build.rs`, `global.json`, `.config/dotnet-tools.json`). The full risky set is these plus `manifests`, `locks` and `settings` plus `global.risky_paths` |
| `commands` | `truth` (`scripts` or `tools`), `tools` (executables a CI or README line may start with), `ci_lint`, `runners`, and `build`, `test`, `lint` rules: `when` conditions, `run` (bare) and `at` (targeted, with `{dir}` or `{target}`) |
| `benchmark`, `native_ui` | markers of a benchmark setup and of a native UI project |
| `test_output` | patterns and exit codes for the classes `no_tests`, `compile` and `assertion` (`status: seed`: to be completed from real runner output) |

Glob and pattern dialects, the `when` keys and the flat format are written in the header of `ecosystems.json`, `scripts/ecosystems.sh` and `ecosystems.mjs`.

### Reading it

- **sh:** `scripts/ecosystems.sh` reads `ecosystems.tsv`, the flat copy (`<id><TAB><path><TAB><value>`), so no sh script needs node or a JSON parser. `eco_init FILE`, then `eco_ids`, `eco_get ID PATH`, `eco_first`, `eco_children`, `eco_pack`, `eco_rows`, `eco_union`, `eco_risky`, `eco_glob_match`, `eco_pruned`.
- **node:** `ecosystems.mjs` (`loadEcosystems`, `globToRegExp`, `matchesAny`, `isPruned`, `riskyPaths`, `classifyPath`, `toRegExp`, `validate`) and the command line `node ecosystems.mjs write|check|validate|ids|risky|get`.
- **Skills** are installable alone, so a skill that uses the definition carries byte-identical copies (`scripts/ecosystems.sh`, `scripts/ecosystems.mjs`, `references/ecosystems.json`, `references/ecosystems.tsv`). `tests/shared/check-shared.sh` compares them with `control-plane/agents/` and checks that the flat file is what `write` produces.
