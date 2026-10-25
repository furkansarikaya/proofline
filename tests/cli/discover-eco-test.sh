#!/bin/sh
# shellcheck disable=SC2016,SC2034 # fixture text is literal; PL_HOME is read by discover.sh
# shellcheck source-path=SCRIPTDIR
# Discovery by ecosystem (A173): bin/lib/discover.sh finds the one target of every ecosystem in control-plane/agents/ecosystems.json
# for at least two layouts each (project at the root; nested or monorepo), and proposes NO command when the target is ambiguous
# or the project sits in a pruned folder. Fixtures are built from a compact table; nothing here runs a project command.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-deco.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT HUP INT TERM
n=0; bad=0
say() { :; }
PL_HOME=$repo
# shellcheck source=../../bin/lib/discover.sh
. "$repo/bin/lib/discover.sh"
D_AMBIG=${D_AMBIG:-}   # the pre-0.0.30 discover.sh has no D_AMBIG
[ -n "${D_ECO:-}" ] || { echo "FAIL: the ecosystem definition did not load" >&2; exit 1; }

# fx ITEM...: a fresh project; ITEM is `path` (empty file) or `path=content` (printf %b escapes)
fx() {
  rm -rf "$T/f"; mkdir -p "$T/f"
  for a in "$@"; do
    p=${a%%=*}; c=''; case "$a" in *=*) c=${a#*=} ;; esac
    mkdir -p "$T/f/$(dirname "$p")"; printf '%b' "$c" > "$T/f/$p"
  done
}
flat() { r=$(printf '%s' "$1" | paste -sd';' -); printf '%s' "${r:--}"; }
# dc DESC BUILD TEST LINT ITEM...: discovery gives exactly these commands (`;` between list items, `-` for none)
dc() {
  d=$1 eb=$2 et=$3 el=$4; shift 4; fx "$@"; discover_commands "$T/f"; n=$((n + 1))
  gb=$(flat "$D_BUILD"); gt=$(flat "$D_TEST"); gl=$(flat "$D_LINT")
  if [ "$gb|$gt|$gl" != "$eb|$et|$el" ]; then bad=1; printf 'FAIL: %s\n  want: %s|%s|%s\n  got:  %s|%s|%s\n' "$d" "$eb" "$et" "$el" "$gb" "$gt" "$gl" >&2; fi
}
# dn DESC AMBIG-ID ITEM...: no command at all; AMBIG-ID (or -) must be named in D_AMBIG
dn() {
  d=$1 id=$2; shift 2; dc "$d" - - - "$@"
  case "$id" in -) ;; *) case "
$D_AMBIG" in *"
$id|"*) ;; *) bad=1; printf 'FAIL: %s (D_AMBIG lacks %s: %s)\n' "$d" "$id" "$D_AMBIG" >&2 ;; esac ;; esac
}

S='{"scripts":{"build":"b","test":"t","lint":"l"}}'
# --- npm family
dc "npm: pnpm at the root" "pnpm run build" "pnpm test" "pnpm run lint" package.json="$S" pnpm-lock.yaml
dc "npm: yarn at the root" "yarn build" "yarn test" "yarn lint" package.json="$S" yarn.lock
dc "npm: bun at the root" "bun run build" "bun test" "bun run lint" package.json="$S" bun.lock
dc "npm: workspaces root stands for its members" "npm run build" "npm test" "npm run lint" package.json="${S%\}}"',"workspaces":["packages/*"]}' packages/a/package.json="$S" packages/b/package.json="$S"
dc "npm: pnpm-workspace.yaml root stands for its members" "pnpm run build" "pnpm test" "-" package.json='{"scripts":{"build":"b","test":"t"}}' pnpm-lock.yaml pnpm-workspace.yaml apps/a/package.json="$S" apps/b/package.json="$S"
dc "npm: one nested app, its own lock picks the runner" "pnpm --dir web run build" "pnpm --dir web test" "pnpm --dir web run lint" web/package.json="$S" web/pnpm-lock.yaml
dc "npm: one nested app, no lock" "npm --prefix web run build" "npm --prefix web test" "npm --prefix web run lint" web/package.json="$S"
dn "npm: two apps and no workspace root" npm a/package.json="$S" b/package.json="$S"
# --- python
dc "python: uv at the root" "-" "uv run pytest" "uv run ruff check ." pyproject.toml='[tool.pytest.ini_options]\n[tool.ruff]\n' uv.lock
dc "python: poetry at the root" "-" "poetry run pytest" "poetry run ruff check ." pyproject.toml='[tool.ruff]\n' poetry.lock tests/test_x.py
dc "python: pdm at the root" "-" "pdm run pytest" "-" pyproject.toml='[project]\n' pdm.lock tests/test_x.py
dc "python: hatch project with a tests folder" "-" "pytest" "-" pyproject.toml='[tool.hatch.build]\n' tests/test_x.py
dc "python: pip project (pytest.ini)" "-" "pytest" "-" pytest.ini='[pytest]\n'
dc "python: one nested service" "-" "pytest svc" "-" svc/pyproject.toml='[tool.pytest.ini_options]\n'
dc "python: uv workspace root stands for its members" "-" "-" "-" pyproject.toml='[tool.uv.workspace]\nmembers=["a"]\n' uv.lock a/pyproject.toml='[tool.pytest]\n'
dn "python: two nested projects" python a/pyproject.toml b/setup.py
# --- go
dc "go: module at the root" "go build ./..." "go test ./..." "go vet ./..." go.mod
dc "go: one nested module" "go -C svc build ./..." "go -C svc test ./..." "go -C svc vet ./..." svc/go.mod
dn "go: two nested modules" go a/go.mod b/go.mod
dn "go: go.work without a root module gives nothing, and init names it" go go.work a/go.mod b/go.mod
dn "npm: a pnpm workspace root without scripts gives nothing, and init names it" npm package.json='{"name":"w"}' pnpm-workspace.yaml='packages:\n  - "a/*"\n' a/x/package.json='{"name":"x"}'
# --- jvm
dc "jvm: maven at the root" "mvn -B package" "mvn -B test" "-" pom.xml
dc "jvm: maven multi-module root stands for its modules" "mvn -B package" "mvn -B test" "-" pom.xml='<modules><module>a</module></modules>' a/pom.xml b/pom.xml
dc "jvm: one nested maven module" "mvn -B -f svc/pom.xml package" "mvn -B -f svc/pom.xml test" "-" svc/pom.xml
dc "jvm: gradle with wrapper at the root" "./gradlew build" "./gradlew test" "-" settings.gradle.kts='include("a")' build.gradle.kts gradlew
dc "jvm: gradle without wrapper" "gradle build" "gradle test" "-" build.gradle
dc "jvm: nested gradle with wrapper" "svc/gradlew -p svc build" "svc/gradlew -p svc test" "-" svc/build.gradle svc/gradlew
dn "jvm: two nested maven projects" jvm a/pom.xml b/pom.xml
# --- cargo
dc "cargo: crate at the root" "cargo build" "cargo test" "cargo clippy" Cargo.toml
dc "cargo: workspace root stands for its crates" "cargo build" "cargo test" "cargo clippy" Cargo.toml='[workspace]\nmembers=["crates/*"]\n' crates/a/Cargo.toml crates/b/Cargo.toml
dc "cargo: one nested crate" "cargo build --manifest-path svc/Cargo.toml" "cargo test --manifest-path svc/Cargo.toml" "cargo clippy --manifest-path svc/Cargo.toml" svc/Cargo.toml
dn "cargo: two nested crates" cargo a/Cargo.toml b/Cargo.toml
# --- php, ruby, swift, dart
dc "php: composer scripts at the root" "composer build" "composer test" "composer lint" composer.json='{"scripts":{"build":"x","test":"phpunit","lint":"l"}}'
dc "php: phpunit.xml.dist without a script" "-" "vendor/bin/phpunit" "-" composer.json='{}' phpunit.xml.dist
dc "php: one nested composer project" "-" "composer --working-dir=api test" "-" api/composer.json='{"scripts":{"test":"phpunit"}}'
dc "ruby: rspec at the root" "-" "bundle exec rspec" "-" Gemfile spec/x_spec.rb
dc "ruby: rake test and rubocop at the root" "-" "bundle exec rake test" "bundle exec rubocop" Gemfile Rakefile test/x_test.rb .rubocop.yml
dc "ruby: a nested project has no targeted form" "-" "-" "-" app/Gemfile app/spec/x_spec.rb
dc "swift: package at the root" "swift build" "swift test" "swiftlint lint" Package.swift .swiftlint.yml
dc "swift: one nested package" "swift build --package-path pkg" "swift test --package-path pkg" "-" pkg/Package.swift
dc "dart: dart package at the root" "-" "dart test" "dart analyze" pubspec.yaml test/x_test.dart
dc "dart: flutter package at the root" "-" "flutter test" "flutter analyze" pubspec.yaml='dependencies:\n  flutter:\n    sdk: flutter\n' test/x_test.dart
dc "dart: a nested package has a targeted analyze only" "-" "-" "dart analyze app" app/pubspec.yaml app/test/x_test.dart
# --- .NET (A173 table)
dc ".NET: .slnx and a nested project" "dotnet build App.slnx" "dotnet test App.slnx" "-" App.slnx src/Api/Api.csproj
dc ".NET: .slnx beside a same-name .sln (legacy copy)" "dotnet build App.slnx" "dotnet test App.slnx" "-" App.slnx App.sln
dn ".NET: two root solutions" dotnet App.sln Other.sln
dc ".NET: only a nested project" "dotnet build src/Api/Api.csproj" "dotnet test src/Api/Api.csproj" "-" src/Api/Api.csproj
dn ".NET: two nested projects" dotnet src/A/A.csproj tests/B/B.csproj
dc ".NET: a root fsproj is run bare" "dotnet build" "dotnet test" "-" Lib.fsproj
dc ".NET: root .editorconfig adds dotnet format on a bare project" "dotnet build" "dotnet test" "dotnet format --verify-no-changes" Lib.fsproj .editorconfig
dc ".NET: root .editorconfig adds dotnet format on the target" "dotnet build src/Api/Api.csproj" "dotnet test src/Api/Api.csproj" "dotnet format src/Api/Api.csproj --verify-no-changes" src/Api/Api.csproj .editorconfig
dn ".NET: a project only under obj is ignored" - obj/X.csproj
dn ".NET: a path with a space is never a candidate" dotnet "src/My App/My.csproj"
dc ".NET: a CI dotnet format line is the lint command" "-" "-" "dotnet format App.sln --verify-no-changes" .github/workflows/ci.yml='jobs:\n  a:\n    steps:\n      - run: dotnet format App.sln --verify-no-changes\n'
# --- pruned folders are never searched, whatever they hold
for pr in node_modules/x/package.json .venv/pyproject.toml vendor/go.mod target/Cargo.toml build/pom.xml dist/package.json bin/X.csproj obj/X.csproj .git/x/go.mod; do
  dn "pruned folder: $pr is not searched" - "$pr"
done
dc "pruned folder: a real root project is found next to a pruned one" "go build ./..." "go test ./..." "go vet ./..." go.mod vendor/dep/go.mod
# --- several ecosystems: one command each, an ambiguous one gives none and the others still count
dc "mixed: a root .slnx and a nested npm app give a list" "dotnet build App.slnx;npm --prefix web run build" "dotnet test App.slnx;npm --prefix web test" "npm --prefix web run lint" App.slnx web/package.json="$S"
dc "mixed: two ambiguous solutions leave only the npm app" "npm --prefix web run build" "npm --prefix web test" "npm --prefix web run lint" App.sln Other.sln web/package.json="$S"
case "$D_AMBIG" in *"dotnet|"*) ;; *) bad=1; echo "FAIL: mixed: D_AMBIG does not name .NET: $D_AMBIG" >&2 ;; esac
dc "mixed: a Makefile target closes its kind, the other kinds still list every ecosystem" "make build" "dotnet test App.slnx;npm --prefix web test" "npm --prefix web run lint" Makefile='build:\n\tx\n' App.slnx web/package.json="$S"
# --- nested-marker work does not grow with a fork per project: 300 nested package.json are judged in seconds (it took 17 s)
rm -rf "$T/f"; mkdir -p "$T/f"; i=0
while [ "$i" -lt 300 ]; do mkdir -p "$T/f/pkgs/p$i"; printf '{"name":"p%s"}\n' "$i" > "$T/f/pkgs/p$i/package.json"; i=$((i + 1)); done
t0=$(date +%s); discover_commands "$T/f"; t1=$(date +%s); n=$((n + 1))
[ $((t1 - t0)) -le 6 ] || { bad=1; echo "FAIL: 300 nested package.json took $((t1 - t0)) s" >&2; }
case "$D_AMBIG" in *"npm|several projects"*) ;; *) bad=1; echo "FAIL: 300 projects: D_AMBIG does not say several projects: $D_AMBIG" >&2 ;; esac

[ "$bad" = 0 ] || exit 1
printf 'discover-eco-test: %s checks passed\n' "$n"
