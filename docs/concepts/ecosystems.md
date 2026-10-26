# Ecosystems and project layout

proofline never assumes or imposes a folder layout (A173). A solution at the root, a project three folders down, several projects side by side and a monorepo with workspaces are all equal. What it knows about each language lives in one file, `control-plane/agents/ecosystems.json` (installed as `.agents/ecosystems.json`), and every script reads that file.

## What proofline does with it

- **Command discovery** (`proofline init`, `proofline doctor`): fills `commands.build`, `commands.test` and `commands.lint` in `.agents/config.yaml` from the project's own files; a key may hold several commands (A176).
- **Runtime versions** (`proofline doctor`, the verify-proof `## Runtime` lines): the local runtime next to the version the project's CI specifies.
- **Risky paths and dependency manifests** (A174): `review.risky_paths` and the `dependencies` risk signal add the manifests, locks, package-source settings and build-changing files of every ecosystem at read time; the exploit-proof manifest diff classifies and reads them. `config.yaml` keeps only what is specific to the project.
- **Design drift, benchmark detection and native UI** (A174): design-sync lists the manifests and project directories, `probe_performance` and visual-proof's native detection read the `benchmark` and `native_ui` markers.
- **Test-output classes** (A175): tdd-proof's `classify-red.mjs` reads `test_output`, whose every entry names a runner and the real run or document behind it.

The [ecosystem matrix](#ecosystem-matrix) says, per ecosystem and touch point, what is supported and how it was checked.

## Command discovery

The commands are read from the project's own truth, in this order:

1. the declared scripts at the root (`package.json`, `composer.json`);
2. a `Makefile`, `justfile` or `Taskfile`;
3. the build files of each ecosystem at the root;
4. the same for a single nested project per ecosystem;
5. CI configuration, then the README (a lint line such as `dotnet format ... --verify-no-changes` counts).

Steps 1, 3 and 4 add one command per ecosystem, so a root .NET solution and a nested npm app give a list. A command that covers the whole repository (steps 2 and 5) is first-writer-wins per kind and then the only candidate of that kind: no ecosystem adds to a kind a `Makefile` `test:` target wrote. A guessed command never enters the config unproven (`proofline init --verify-commands` trial-runs it). When the target is ambiguous no command is proposed at all: zero or several candidates give no candidate, never a command that would fail (for example `dotnet build` with two solutions in the folder, `MSB1011`, or with only nested projects, `MSB1003`). Empty commands are handled by the existing 0.0.5 flow: the run that proves a command asks you once, after cleanup, to write it into the config.

How a target is chosen:

- The search has no depth limit. Build output, dependency and tool folders (`bin`, `obj`, `build`, `dist`, `target`, `node_modules`, `vendor`, `.venv`, `artifacts`, `.git`, ... and each ecosystem's own) are not entered. More than 1000 marker files count as "unknown": nothing nested is proposed.
- A workspace root (`pnpm-workspace.yaml`, `package.json` with `workspaces`, `turbo.json`, `nx.json`, `lerna.json`, `rush.json`, `go.work`, a Cargo `[workspace]`, a Maven `<modules>`, a Gradle `settings.gradle` with `include`, a uv workspace, a Dart workspace) stands for its members: they are not candidates of their own.
- The root wins: a project or workspace at the root is the target and is run bare (`cargo test`). Otherwise exactly one outermost nested project is the target and the command is fully targeted (`cargo test --manifest-path core/Cargo.toml`, `npm --prefix web test`, `go -C svc test ./...`). Two or more: no candidate for that ecosystem (`init` says which one and why).
- This is decided per ecosystem: a root project no longer hides a nested project of another ecosystem (a root `Cargo.toml` and a nested `web/package.json` give `cargo build` and `npm --prefix web run build`).
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
| `App.slnx` and `web/package.json` (with `build` and `test` scripts) | `dotnet build App.slnx` and `npm --prefix web run build` (a list) | `dotnet test App.slnx` and `npm --prefix web test` (a list) | |
| a `Makefile` with a `test:` target and only `src/Api/Api.csproj` | `dotnet build src/Api/Api.csproj` | `make test` | |
| `a/go.mod` and `b/go.mod` | none (the run asks once) | none | none |
| only `web/package.json` (with scripts) | `npm --prefix web run build` | `npm --prefix web test` | |
| only `core/Cargo.toml` | `cargo build --manifest-path core/Cargo.toml` | `cargo test --manifest-path core/Cargo.toml` | |
| only `svc/go.mod` | `go -C svc build ./...` | `go -C svc test ./...` | `go -C svc vet ./...` |
| `go.work` without a root `go.mod` | none | none | none |

Known limits: a `.NET 10` project that runs tests with Microsoft.Testing.Platform may need `--solution` or `--project` in front of the target, and fails to build without `"test": {"runner": "Microsoft.Testing.Platform"}` in `global.json`; the trial run of `--verify-commands` drops a command that fails, and only that item of a list. Ruby has no targeted form (Bundler needs the project folder as the working directory), so a nested Ruby project gets no candidate. Dart and Flutter test commands have no targeted form either. A second project of the same ecosystem gets no command. Discovery costs about 0.45 s per project because it is plain sh.

### Several commands per key

A project with more than one stack needs more than one build and test command. `commands.build`, `commands.test` and `commands.lint` take one command (a scalar, as before) or a block list:

```yaml
commands:
  build:
    - dotnet build App.slnx
    - npm --prefix web run build
  test:
    - dotnet test App.slnx
    - npm --prefix web test
```

- One reader serves every consumer: `cfg_cmds` in `agent.sh` and `bin/lib/config.sh`; `agent.sh config-get commands.build` prints the items one per line.
- `agent.sh config-check` rejects a value together with a list, an empty item, a duplicate item, an inline list (`[a, b]`; a command may start with a bracket) and a list under `install` or `secret_scan`.
- The build record and the verify re-run run every command of a key even when an earlier one fails, and report each as `build[2/3]` with its exit code, its output tail and a `failed:` line. A key that failed still stops the next key (a failed build stops the tests).
- `init` writes a list when discovery found several commands; `init --verify-commands` drops the failing item and keeps the others.

## Runtime versions

`runtime-versions.sh` reads the root first, then the same files in nested folders (pruned like above, at most `version_scan_depth` = 6 levels, at most 400 files). A .NET project is present when `global.json`, `*.slnx`, `*.sln`, `*.csproj`, `*.fsproj` or `*.vbproj` exists at the root or nested; a project only under `obj/` or `bin/` is ignored. A `dotnet-version` in a workflow that differs from the local SDK is still reported as `mismatch`. The runtimes are node, dotnet, go, python, java, rust, php, ruby, swift and dart.

## Ecosystem matrix

What is supported for each ecosystem at each touch point, and how that was checked. Nothing below is claimed beyond what its check shows.

**Support** is `supported`, `partial` (the note says what is missing) or `not supported`. **Checked by**:

- `real tool`: a captured run of the real tool on the maintainer's machine (2026-10-25, macOS arm64). For test output the run is a fixture in `tests/skills/fixtures/tdd-proof-output` whose header names tool, version, command and exit code.
- `docs`: the tool's own documentation or source (the tool was not installed); the URL is the `evidence` of the entry in `ecosystems.json`.
- `code reading only`: the logic was read and exercised with hand-written project layouts and file samples in `tests/`; no real tool of that ecosystem was run for it.

Real runners captured: node:test (Node.js 24.14.1), bun test 1.2.8, vitest 5.0.1, tsc 5.9.3, unittest (Python 3.12.3), go test (go 1.27.1), Minitest 6.0.0 and test-unit 3.7.5 (Ruby 4.0.7), swift test (Apple Swift 6.4, XCTest and Swift Testing), and the .NET SDK 10.0.402 with xunit.v3, xunit 2, NUnit and MSTest 3 and 4 in VSTest and Microsoft.Testing.Platform modes. Documentation only: jest, mocha, pytest, Maven, Gradle, JUnit, cargo, PHPUnit, RSpec, dart and flutter test. The facts behind the test-output rows are in `skills/tdd-proof/references/RED.md` ("Evidence behind the patterns" and "Not covered").

Rows common to all ecosystems: **Design-sync manifests** means `design-sync.mjs --reverse system` lists every file matching the ecosystem's `manifests` (the same list as the dependency row) and every directory holding a project file at any depth. **Multiple commands** means discovery adds one command per ecosystem (A176), so two ecosystems give a list and a second project of the same ecosystem gives no command.

### npm (npm, pnpm, yarn, bun, workspaces, turbo, nx)

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | supported | code reading only | root `build`, `test`, `lint` scripts run with the manager the lock file names (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`/`bun.lockb`, else npm); nested `npm --prefix`, `pnpm --dir`, `yarn --cwd`, `bun --cwd`. `pnpm-workspace.yaml`, `workspaces`, `turbo.json`, `nx.json`, `lerna.json` and `rush.json` mark a workspace root that stands for its members; its scripts are used, no `turbo run` or `nx` command is derived. The default `no test specified` script is skipped |
| Runtime versions | supported | local version: real tool (node 24.14.1); CI-side sources: code reading only | `.nvmrc`, `.node-version`, `.tool-versions`, `engines.node`, Volta, workflow `node-version`, `.gitlab-ci.yml` image |
| Risky paths | supported | code reading only | `package.json`, `pnpm-workspace.yaml`, the five lock files, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, `bunfig.toml`, `turbo.json`, `nx.json`, `lerna.json`, `rush.json` |
| Dependency manifests | partial | code reading only | `package.json` (dependencies, overrides, resolutions, bundled, install hooks, catalogs), `pnpm-workspace.yaml`, registries of `.npmrc`, `.yarnrc.yml`, `bunfig.toml` as `index:<host>`; `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml` are read; `bun.lock` and `bun.lockb` are listed unparsed (confidence `low`) |
| Test-output classification | supported (node:test, bun test, vitest, tsc), partial (jest, mocha) | real tool for node:test, bun, vitest, tsc; docs for jest and mocha | mocha has only `No test files found`; its assertion text and exit codes are not covered. `tsc` compile exit 2, vitest no-tests exit 1, node:test and bun no-tests exit 0 |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | a script `bench`, `benchmark` or `perf*` in any tracked `package.json`; `benchmark`, `tinybench` or `mitata` in `package.json` |
| Native UI detection | supported | code reading only | `react-native`, `electron` (`package.json`), `tauri.conf.json(5)`; Electron and Tauri with a web entry are measured as web |
| Multiple commands | supported | code reading only | |

### Python (pip, Poetry, uv, PDM, Hatch)

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | partial | code reading only | `pytest` only when pytest is named in `pyproject.toml`, `pytest.ini` or `setup.cfg`, or a `tests` folder sits beside one of them; `ruff check .` only with `[tool.ruff]` or `ruff.toml`; no build command. `uv.lock`, `poetry.lock`, `pdm.lock` add the `uv run`, `poetry run`, `pdm run` prefix; pip and Hatch run the bare command. A uv workspace root stands for its members. A project that neither names pytest nor has a `tests` folder beside one of those files gets no test command |
| Runtime versions | supported | local version: real tool (Python 3.12.3); CI-side sources: code reading only | `.python-version`, `requires-python`, Pipfile `python_version`, `runtime.txt`, `.tool-versions`, workflow, image |
| Risky paths | supported | code reading only | requirements, constraints, `pyproject.toml`, `hatch.toml`, `setup.py`, `setup.cfg`, `Pipfile`, `environment.yml`; `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`; `pip.conf`, `pip.ini`, `.pypirc`, `.condarc`, `uv.toml`, `pdm.toml`, `poetry.toml`; `tox.ini`, `noxfile.py` |
| Dependency manifests | partial | code reading only | requirements files (also `-r` / `-c` includes), `pyproject.toml` (PEP 621, dependency groups, Poetry, uv, PDM, Hatch environments, Flit, build requirements), `hatch.toml`, `Pipfile`, `setup.cfg`, conda `environment.yml`; `setup.py` list literals only (a computed list is `partial`); package sources as `index:<host>`; the four lock files |
| Test-output classification | supported (unittest), partial (pytest) | real tool for unittest; docs for pytest | pytest `collected 0 items`, `no tests ran`, `E   assert` and exit 5 come from documentation; pytest collection errors are not covered |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | `pytest-benchmark` or `pyperf` in a manifest; `asv.conf.json` |
| Native UI detection | not supported | code reading only | the definition has no markers for a Python UI toolkit |
| Multiple commands | supported | code reading only | |

### Go (including go.work)

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | supported; partial for `go.work` | code reading only | `go build ./...`, `go test ./...`, `go vet ./...`; nested `go -C <dir>`. A `go.work` root stands for its members, so a `go.work` without a root `go.mod` gives no command |
| Runtime versions | supported | local version: real tool (go 1.27.1); CI-side sources: code reading only | `go` line of `go.mod` and `go.work` (a minimum), workflow, `.tool-versions`, image |
| Risky paths | supported | code reading only | `go.mod`, `go.work`, `go.sum`, `go.work.sum` |
| Dependency manifests | supported | code reading only | `go.mod` and `go.work` (require, replace), `go.sum`, `go.work.sum` |
| Test-output classification | supported | real tool (go 1.27.1) | `[no test files]`, `[no tests to run]` (exit 0, cancelled by `unless` when another package ran), `[build failed]`, `[setup failed]`, `--- FAIL` with `_test.go:N:` |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | `func Benchmark` in a `*_test.go` file |
| Native UI detection | not supported | code reading only | no markers |
| Multiple commands | supported | code reading only | |

### JVM (Maven multi-module, Gradle with version catalog, Kotlin)

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | partial | code reading only | `mvn -B package` / `mvn -B test`; Gradle `./gradlew` when the wrapper exists in the project, else `gradle`; nested `mvn -B -f <dir>/pom.xml`, `gradle -p <dir>`. A Maven `<modules>` root and a Gradle `settings.gradle(.kts)` with `include` stand for their modules. Kotlin is built by Gradle, so it has no command of its own. No lint command |
| Runtime versions | supported | local version: code reading only (no recorded run for java); CI-side sources: code reading only | `.java-version`, `.sdkmanrc`, `.tool-versions`, `java.version` / `maven.compiler.*` / `release` in `pom.xml`, `JavaLanguageVersion.of(N)` in `build.gradle(.kts)`, workflow |
| Risky paths | supported | code reading only | `pom.xml`, `*.gradle(.kts)`, `*.versions.toml`, `gradle.properties`, `*.sbt`, `settings.xml`, `.mvn/*`, `gradle-wrapper.properties`, `gradle.lockfile`, `gradlew`, `mvnw`, `buildSrc`, `build-logic` |
| Dependency manifests | partial | code reading only | `pom.xml` (dependencies, plugins, parent, extensions), Gradle configurations, `plugins {}`, version catalogs, `*.sbt`; repositories and the wrapper `distributionUrl` as sources. A Maven property from a parent or BOM, a Gradle variable or `libs.*` reference and `gradle.properties` version properties are `partial` (confidence at most `medium`) |
| Test-output classification | partial | docs | Maven surefire, Gradle test, JUnit 4 and 5 text; Maven and Gradle exit codes and the Kotlin compiler's `e:` lines are not covered |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | `jmh`, `kotlinx-benchmark` in `pom.xml`, Gradle files, version catalogs, `*.sbt` |
| Native UI detection | partial | code reading only | Android only: the Android Gradle plugin or `AndroidManifest.xml` |
| Multiple commands | supported | code reading only | |

### Cargo

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | supported | code reading only | `cargo build`, `cargo test`, `cargo clippy`; nested `--manifest-path <dir>/Cargo.toml`; a `[workspace]` root stands for its members |
| Runtime versions | supported | code reading only | `rustc` was not installed on the machine: `rust-toolchain`, `rust-toolchain.toml` `channel`, `rust-version` (a minimum), `.tool-versions` |
| Risky paths | supported | code reading only | `Cargo.toml`, `Cargo.lock`, `.cargo/config(.toml)`, `build.rs`, `rust-toolchain(.toml)`, `deny.toml` |
| Dependency manifests | supported | code reading only | dependencies, dev, build, target, workspace, `[patch]`, `[replace]`; `.cargo/config.toml` sources and registries |
| Test-output classification | supported | docs | `running 0 tests` (every target, cancelled by `unless`), `could not compile`, `error[E...]`, ``assertion `left == right` failed``; exit 0 and 101 from the cargo manual |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | a `benches` folder beside a crate; `criterion`, `divan`, `iai`, `iai-callgrind` in `Cargo.toml` |
| Native UI detection | partial | code reading only | the `egui`, `eframe`, `iced` and `slint` crates, as desktop |
| Multiple commands | supported | code reading only | |

### .NET (sln, slnx, csproj, fsproj, vbproj, MAUI)

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | supported | code reading only | the target is a file: root solutions, root projects, nested solutions, nested projects; `.slnx` before a same-name `.sln`; exactly one candidate or none. The failure it avoids (`MSB1003` without a project in the folder) was captured with the SDK. `dotnet format <target> --verify-no-changes` needs a root `.editorconfig` |
| Runtime versions | supported | local version: code reading only (no recorded run for dotnet); CI-side sources: code reading only | `global.json` `sdk.version`, workflow `dotnet-version`, `.tool-versions`; a project only under `obj/` or `bin/` is ignored |
| Risky paths | supported | code reading only | project files, `*.props`, `*.targets`, `packages.config`, `paket.*`, `global.json`, `.config/dotnet-tools.json`, `NuGet.config`, `Directory.Build.rsp`, `*.sln`, `*.slnx`, `packages.lock.json` |
| Dependency manifests | supported | code reading only | project files, `Directory.Build.props/targets`, `Directory.Packages.props`, any props/targets, `packages.config`, `paket.dependencies`, tool manifest, `global.json` `msbuild-sdks`; `NuGet.config` sources. An MSBuild property defined elsewhere is `partial` |
| Test-output classification | supported | real tool (.NET SDK 10.0.402: xunit.v3 3.2.2 and 4.0.2, xunit 2.9.3, NUnit 5.0.0, MSTest 3.11.1 and 4.5.1; VSTest and MTP) | VSTest exits 0 when nothing ran, also when `--filter` matches nothing; Microsoft.Testing.Platform exits 8 for zero tests and 2 for a failing test; an MTP project without `global.json` `test.runner` fails to build (`compile`); a test host crash is `unknown` under MTP (`dotnet-nunit-mtp-host-crash.txt`) and `compile` under VSTest (`Test Run Aborted`, `dotnet-nunit-vstest-host-crash.txt`). `Assert.Fail("message")` and an exception inside a test were not captured and are not classed as an assertion |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | `BenchmarkDotNet` in project files, props, targets, `packages.config`, paket files |
| Native UI detection | partial | code reading only | MAUI (`<UseMaui>true</UseMaui>`; `false` is not MAUI) in a project file or `Directory.Build.props`; WPF, WinForms, WinUI, Avalonia and Uno as desktop. visual-proof runs no `dotnet` command: MAUI is measured only through the project's own Maestro flows against a booted emulator or simulator, else UNSUPPORTED |
| Multiple commands | supported | code reading only | |

### PHP

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | partial | code reading only | `composer build`, `composer test`, `composer lint` only when `composer.json` declares that script; `vendor/bin/phpunit` when `phpunit.xml(.dist)` exists; nested `composer --working-dir=<dir>` |
| Runtime versions | supported | code reading only | `php` was not installed on the machine: `.php-version`, `composer.json` `require.php`, workflow, `.tool-versions`, image |
| Risky paths | supported | code reading only | `composer.json`, `composer.lock`, `auth.json` |
| Dependency manifests | supported | code reading only | `require`, `require-dev`, install hooks, `repositories` as sources; `composer.lock` |
| Test-output classification | partial | docs | PHPUnit `No tests executed!`, `Failed asserting that`, `Parse error: syntax error`; Pest and PHP exit 255 for a parse error are not covered |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | `phpbench` in `composer.json`; `phpbench.json` |
| Native UI detection | not supported | code reading only | no markers |
| Multiple commands | supported | code reading only | |

### Ruby

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | partial | code reading only | `bundle exec rspec` (a `spec` folder), `bundle exec rake test` (`Rakefile` and a `test` folder), `bundle exec rubocop` (`.rubocop.yml`); no build command. Root only: Bundler needs the project folder as the working directory, so Ruby below the root gives no candidate |
| Runtime versions | supported | local version: real tool (ruby 4.0.7); CI-side sources: code reading only | `.ruby-version`, `Gemfile` `ruby`, workflow, `.tool-versions`, image |
| Risky paths | supported | code reading only | `Gemfile`, `*.gemspec`, `Gemfile.lock`, `.bundle/config`, `Rakefile` |
| Dependency manifests | supported | code reading only | gems, `plugin`, `source` of the `Gemfile`; `*.gemspec`; `Gemfile.lock` |
| Test-output classification | supported (Minitest, test-unit), partial (RSpec) | real tool for Minitest 6.0.0 and test-unit 3.7.5; docs for RSpec | Minitest `0 runs, 0 assertions` exits 0, `Nothing ran for filter` exits 1; test-unit prints nothing at all when no test exists, so that is `unknown` |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | `benchmark-ips` in `Gemfile` or a gemspec |
| Native UI detection | not supported | code reading only | no markers |
| Multiple commands | supported | code reading only | |

### Swift

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | partial | code reading only | Swift Package Manager only: `swift build`, `swift test`, nested `--package-path <dir>`, `swiftlint lint` with `.swiftlint.yml`. An Xcode project without `Package.swift` gets no command |
| Runtime versions | supported | local version: real tool (Swift 6.4); CI-side sources: code reading only | `.swift-version`, the `swift-tools-version` comment (a minimum), workflow, `.tool-versions` |
| Risky paths | supported | code reading only | `Package.swift`, `Package@swift-*.swift`, `Podfile`, `*.podspec`, `Cartfile`, `Package.resolved`, `Podfile.lock`, `Cartfile.resolved` |
| Dependency manifests | supported | code reading only | `.package(url:|path:)`, Podfile, podspec, Cartfile; a non-default Podfile `source` |
| Test-output classification | supported | real tool (Apple Swift 6.4: XCTest and Swift Testing 2084) | `Executed 0 tests` with `Test run with 0 tests` is "nothing ran" (exit 0); the XCTest line alone is not, because Swift Testing tests may have run |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | a `Benchmarks` folder; `package-benchmark` in `Package.swift` |
| Native UI detection | partial | code reading only | `Package.swift` with `.iOS(` or `.macOS(`, `project.pbxproj` for iOS or macOS |
| Multiple commands | supported | code reading only | |

### Dart and Flutter

| Touch point | Support | Checked by | Notes |
|---|---|---|---|
| Command discovery | partial | code reading only | `flutter test` or `dart test` (a `test` folder; Flutter when `pubspec.yaml` has `sdk: flutter`), `flutter analyze` or `dart analyze`; no build command. A nested project gets no test command (no targeted form), only the analyze command. `workspace:` in `pubspec.yaml` and `melos.yaml` mark a workspace root |
| Runtime versions | partial | code reading only | `dart` was not installed on the machine: `pubspec.yaml` `sdk:` constraint and `.tool-versions`; the Flutter SDK version is not read |
| Risky paths | supported | code reading only | `pubspec.yaml`, `pubspec_overrides.yaml`, `pubspec.lock`, `melos.yaml`, `analysis_options.yaml` |
| Dependency manifests | supported | code reading only | `dependencies`, `dev_dependencies`, `dependency_overrides`; `pubspec.lock`; no package-source settings |
| Test-output classification | partial | docs | `dart test` exit 79 for no tests and 1 for a failure; `No tests were found.`, `Failed to load "<path>"`, `Expected: <5>` / `Actual: <4>`. `flutter test` exit codes and `dart test` compile exit codes are not covered |
| Design-sync manifests | supported | code reading only | |
| Benchmark detection | supported | code reading only | a `benchmark` folder; `benchmark_harness` in `pubspec.yaml` |
| Native UI detection | supported | code reading only | `pubspec.yaml` with the Flutter SDK; measured only through the project's own Flutter integration or golden tests |
| Multiple commands | supported | code reading only | |

### Not supported or unverified

Left out of the definition because neither a run nor a document backs them (a run that shows one is classed `unknown`, never RED): Pest (no pattern of its own); PHP exit code 255 for a parse error; Maven and Gradle exit codes; the Kotlin compiler's `e:` lines; mocha assertion text and exit codes; `flutter test` exit codes; pytest collection errors (`Interrupted: n errors during collection`); `dart test` compile exit codes.

Not supported or limited by design:

- **Ruby below the root and nested Dart or Flutter tests have no targeted command form**, so discovery gives no candidate for them; the run asks you once.
- **A second project of the same ecosystem** gets no command (several targets are ambiguous); a workspace root is the way to name them.
- **Discovery of nested projects costs about 0.45 s per project** because it is plain sh; a repository with more than 1000 marker files counts as unknown and proposes nothing nested.
- **MAUI is measured only through the project's own Maestro flows**; without one the visual check is UNSUPPORTED, never a pass.
- **No doctor warning for a missing `.agents/ecosystems.tsv`**: without it the risky-path lists fall back to `config.yaml` alone and the benchmark probe reports nothing.
- **Runtime versions:** the local version was read from the real tool only for node, Python, go, ruby and swift (`runtime-versions.sh` run on the maintainer's machine, 2026-10-25); for java and dotnet no run is recorded in the repository, and for Rust, PHP and Dart the tool was missing, so their extraction patterns are code reading only. The CI-side sources of every runtime are code reading only.
- **Qt** desktop projects are matched in `native.mjs`, not in the definition (there is no C or C++ ecosystem).

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
| `risky_paths` | extra paths that must never be reviewed as small: build-changing files (`Directory.Build.rsp`, `build.rs`, `rust-toolchain.toml`, `gradlew`, `Rakefile`, ...). The full risky set is these plus `manifests`, `locks` and `settings` plus `global.risky_paths`. Read at read time from `.agents/ecosystems.tsv` (A174); `config.yaml` adds only project-specific globs |
| `commands` | `truth` (`scripts` or `tools`), `tools` (executables a CI or README line may start with), `ci_lint`, `runners`, and `build`, `test`, `lint` rules: `when` conditions, `run` (bare) and `at` (targeted, with `{dir}` or `{target}`) |
| `benchmark`, `native_ui` | markers of a benchmark setup (script names, directories, a file pattern with a content marker, a dependency in a manifest, a config file) and of a native UI project (`file`, `contains`, `platform`, `kind`) |
| `test_output` | per class `no_tests`, `compile` and `assertion`, entries with `pattern`, `runner`, `source` (`captured`: a fixture in `tests/skills/fixtures/tdd-proof-output`; `docs`: the tool's documentation, with its URL as `evidence`) and an optional `unless`; `exit_codes` per class, used only as a cross-check (A175) |

Glob and pattern dialects, the `when` keys and the flat format are written in the header of `ecosystems.json`, `scripts/ecosystems.sh` and `ecosystems.mjs`.

The risk lists are read at read time: `agent.sh` adds the ecosystem globs to `review.risky_paths` and to the signal whose check is `dependencies`, so a new ecosystem or file kind reaches every project on `proofline upgrade` without a config edit and a user's `config.yaml` is never rewritten. One synthetic line, `risk.ecosystems.dependencies`, binds that set into `freeze.risk_sha256`; a run frozen before keeps the paths it was frozen with and still passes `verify-freeze`. The exploit-proof manifest diff reads a project's own `.agents/ecosystems.json` in preference to its skill copy.

### Reading it

- **sh:** `scripts/ecosystems.sh` reads `ecosystems.tsv`, the flat copy (`<id><TAB><path><TAB><value>`), so no sh script needs node or a JSON parser. `eco_init FILE`, then `eco_ids`, `eco_get ID PATH`, `eco_first`, `eco_children`, `eco_pack`, `eco_rows`, `eco_union`, `eco_risky`, `eco_glob_match`, `eco_pruned`.
- **node:** `ecosystems.mjs` (`loadEcosystems`, `globToRegExp`, `matchesAny`, `isPruned`, `riskyPaths`, `classifyPath`, `toRegExp`, `validate`) and the command line `node ecosystems.mjs write|check|validate|ids|risky|get`.
- **Skills** are installable alone, so a skill that uses the definition carries byte-identical copies (`scripts/ecosystems.sh`, `scripts/ecosystems.mjs`, `references/ecosystems.json`, `references/ecosystems.tsv`). `tests/shared/check-shared.sh` compares them with `control-plane/agents/` and checks that the flat file is what `write` produces.

## Worktree dependencies (A185)

`worktree_deps.folders` lists the git-ignored folders a package manager fills (`node_modules`, `vendor`, `vendor/bundle`) that a run worktree gets its own copy of; an ecosystem whose folder is not relocatable (virtual environments, `.dart_tool`, `obj`) or whose cache lives outside the project lists none. `worktree-prep.sh` reads it; nothing else knows the names. See [night mode](night-mode.md).
