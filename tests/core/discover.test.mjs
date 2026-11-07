// @ts-check
// Discovery of the build, test and lint commands (A230; the former bin/lib/discover.sh with tests/cli/discover-eco-test.sh, discover-pgroup-test.sh and the discovery
// part of tests/cli/cli-test.sh; tests/legacy-port-map.tsv names the rows). Absolute expectations, no shell engine: every ecosystem of ecosystems.json for at least two
// layouts each (project at the root; nested or monorepo), no command when the target is ambiguous or the project sits in a pruned folder, the trial runs, the process-group
// timeout, and the Core invariant for secrets (a candidate line that carries a secret is never listed). Nothing here runs a project command except the trial-run tests, which
// run `true`, `false` and `sleep`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ambigNotes, discoverCommands, isSafeCommand, joinCommands, runWithTimeout, safePath, verifyCommands } from '../../control-plane/agents/scripts/core/discover.mjs';
import { repo } from './helpers.mjs';

const base = mkdtempSync(path.join(tmpdir(), 'pl-disc-'));
after(() => { rmSync(base, { recursive: true, force: true }); });
let n = 0;
/** A fresh project folder with the given files: [path, content] pairs. @param {Array<[string, string]>} items */
function fx(items) {
  const d = path.join(base, `f${++n}`);
  mkdirSync(d, { recursive: true });
  for (const [p, c] of items) { mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); writeFileSync(path.join(d, p), c); }
  return d;
}
const flat = (/** @type {string[]} */ l) => l.join(';') || '-';
const S = '{"scripts":{"build":"b","test":"t","lint":"l"}}';
/** @param {string} id @param {ReturnType<typeof discoverCommands>} got */
const ambigIds = (id, got) => got.ambig.some((a) => a.id === id);

/** [kind, description, ...expectations, items]: dc = exactly these commands (`;` between list items, `-` for none); dn = no command at all and, unless `-`, the ecosystem named as ambiguous. */
const TABLE = /** @type {Array<any[]>} */ ([
  ["dc", "npm: pnpm at the root", "pnpm run build", "pnpm test", "pnpm run lint", [["package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["pnpm-lock.yaml", ""]]],
  ["dc", "npm: yarn at the root", "yarn build", "yarn test", "yarn lint", [["package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["yarn.lock", ""]]],
  ["dc", "npm: bun at the root", "bun run build", "bun test", "bun run lint", [["package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["bun.lock", ""]]],
  ["dc", "npm: workspaces root stands for its members", "npm run build", "npm test", "npm run lint", [["package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"},\"workspaces\":[\"packages/*\"]}"], ["packages/a/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["packages/b/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
  ["dc", "npm: pnpm-workspace.yaml root stands for its members", "pnpm run build", "pnpm test", "-", [["package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\"}}"], ["pnpm-lock.yaml", ""], ["pnpm-workspace.yaml", ""], ["apps/a/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["apps/b/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
  ["dc", "npm: one nested app, its own lock picks the runner", "pnpm --dir web run build", "pnpm --dir web test", "pnpm --dir web run lint", [["web/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["web/pnpm-lock.yaml", ""]]],
  ["dc", "npm: one nested app, no lock", "npm --prefix web run build", "npm --prefix web test", "npm --prefix web run lint", [["web/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
  ["dn", "npm: two apps and no workspace root", "npm", [["a/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"], ["b/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
  ["dc", "python: uv at the root", "-", "uv run pytest", "uv run ruff check .", [["pyproject.toml", "[tool.pytest.ini_options]\n[tool.ruff]\n"], ["uv.lock", ""]]],
  ["dc", "python: poetry at the root", "-", "poetry run pytest", "poetry run ruff check .", [["pyproject.toml", "[tool.ruff]\n"], ["poetry.lock", ""], ["tests/test_x.py", ""]]],
  ["dc", "python: pdm at the root", "-", "pdm run pytest", "-", [["pyproject.toml", "[project]\n"], ["pdm.lock", ""], ["tests/test_x.py", ""]]],
  ["dc", "python: hatch project with a tests folder", "-", "pytest", "-", [["pyproject.toml", "[tool.hatch.build]\n"], ["tests/test_x.py", ""]]],
  ["dc", "python: pip project (pytest.ini)", "-", "pytest", "-", [["pytest.ini", "[pytest]\n"]]],
  ["dc", "python: one nested service", "-", "pytest svc", "-", [["svc/pyproject.toml", "[tool.pytest.ini_options]\n"]]],
  ["dc", "python: uv workspace root stands for its members", "-", "-", "-", [["pyproject.toml", "[tool.uv.workspace]\nmembers=[\"a\"]\n"], ["uv.lock", ""], ["a/pyproject.toml", "[tool.pytest]\n"]]],
  ["dn", "python: two nested projects", "python", [["a/pyproject.toml", ""], ["b/setup.py", ""]]],
  ["dc", "go: module at the root", "go build ./...", "go test ./...", "go vet ./...", [["go.mod", ""]]],
  ["dc", "go: one nested module", "go -C svc build ./...", "go -C svc test ./...", "go -C svc vet ./...", [["svc/go.mod", ""]]],
  ["dn", "go: two nested modules", "go", [["a/go.mod", ""], ["b/go.mod", ""]]],
  ["dn", "go: go.work without a root module gives nothing, and init names it", "go", [["go.work", ""], ["a/go.mod", ""], ["b/go.mod", ""]]],
  ["dc", "go.work: a use block gives the member commands (no root module)", "go build ./svc/api/... ./svc/worker/...", "go test ./svc/api/... ./svc/worker/...", "go vet ./svc/api/... ./svc/worker/...", [["go.work", "go 1.22\n\nuse (\n\t./svc/api\n\t./svc/worker // comment\n)\n"], ["svc/api/go.mod", ""], ["svc/worker/go.mod", ""]]],
  ["dc", "go.work: with a root go.mod the members still decide, not ./...", "go build ./svc/api/... ./svc/worker/...", "go test ./svc/api/... ./svc/worker/...", "go vet ./svc/api/... ./svc/worker/...", [["go.mod", ""], ["go.work", "go 1.22\n\nuse (\n\t./svc/api\n\t./svc/worker // comment\n)\n"], ["svc/api/go.mod", ""], ["svc/worker/go.mod", ""]]],
  ["dc", "go.work: single-line use", "go build ./svc/api/...", "go test ./svc/api/...", "go vet ./svc/api/...", [["go.mod", ""], ["go.work", "go 1.22\nuse ./svc/api\n"], ["svc/api/go.mod", ""]]],
  ["dc", "go.work: an empty use list behaves as before (root module)", "go build ./...", "go test ./...", "go vet ./...", [["go.mod", ""], ["go.work", "go 1.22\n"]]],
  ["dn", "go.work: an empty use list without a root module still gives nothing", "go", [["go.work", "go 1.22\nuse (\n)\n"], ["a/go.mod", ""], ["b/go.mod", ""]]],
  ["dc", "go.work: an unsafe member path falls back to the plain rule", "go build ./...", "go test ./...", "go vet ./...", [["go.mod", ""], ["go.work", "use ./a;b\n"]]],
  ["dn", "npm: a pnpm workspace root without scripts gives nothing, and init names it", "npm", [["package.json", "{\"name\":\"w\"}"], ["pnpm-workspace.yaml", "packages:\n  - \"a/*\"\n"], ["a/x/package.json", "{\"name\":\"x\"}"]]],
  ["dc", "jvm: maven at the root", "mvn -B package", "mvn -B test", "-", [["pom.xml", ""]]],
  ["dc", "jvm: maven multi-module root stands for its modules", "mvn -B package", "mvn -B test", "-", [["pom.xml", "<modules><module>a</module></modules>"], ["a/pom.xml", ""], ["b/pom.xml", ""]]],
  ["dc", "jvm: one nested maven module", "mvn -B -f svc/pom.xml package", "mvn -B -f svc/pom.xml test", "-", [["svc/pom.xml", ""]]],
  ["dc", "jvm: gradle with wrapper at the root", "./gradlew build", "./gradlew test", "-", [["settings.gradle.kts", "include(\"a\")"], ["build.gradle.kts", ""], ["gradlew", ""]]],
  ["dc", "jvm: gradle without wrapper", "gradle build", "gradle test", "-", [["build.gradle", ""]]],
  ["dc", "jvm: nested gradle with wrapper", "svc/gradlew -p svc build", "svc/gradlew -p svc test", "-", [["svc/build.gradle", ""], ["svc/gradlew", ""]]],
  ["dn", "jvm: two nested maven projects", "jvm", [["a/pom.xml", ""], ["b/pom.xml", ""]]],
  ["dc", "cargo: crate at the root", "cargo build", "cargo test", "cargo clippy", [["Cargo.toml", ""]]],
  ["dc", "cargo: workspace root stands for its crates", "cargo build", "cargo test", "cargo clippy", [["Cargo.toml", "[workspace]\nmembers=[\"crates/*\"]\n"], ["crates/a/Cargo.toml", ""], ["crates/b/Cargo.toml", ""]]],
  ["dc", "cargo: one nested crate", "cargo build --manifest-path svc/Cargo.toml", "cargo test --manifest-path svc/Cargo.toml", "cargo clippy --manifest-path svc/Cargo.toml", [["svc/Cargo.toml", ""]]],
  ["dn", "cargo: two nested crates", "cargo", [["a/Cargo.toml", ""], ["b/Cargo.toml", ""]]],
  ["dc", "php: composer scripts at the root", "composer build", "composer test", "composer lint", [["composer.json", "{\"scripts\":{\"build\":\"x\",\"test\":\"phpunit\",\"lint\":\"l\"}}"]]],
  ["dc", "php: phpunit.xml.dist without a script", "-", "vendor/bin/phpunit", "-", [["composer.json", "{}"], ["phpunit.xml.dist", ""]]],
  ["dc", "php: one nested composer project", "-", "composer --working-dir=api test", "-", [["api/composer.json", "{\"scripts\":{\"test\":\"phpunit\"}}"]]],
  ["dc", "ruby: rspec at the root", "-", "bundle exec rspec", "-", [["Gemfile", ""], ["spec/x_spec.rb", ""]]],
  ["dc", "ruby: rake test and rubocop at the root", "-", "bundle exec rake test", "bundle exec rubocop", [["Gemfile", ""], ["Rakefile", ""], ["test/x_test.rb", ""], [".rubocop.yml", ""]]],
  ["dc", "ruby: a nested project has no targeted form", "-", "-", "-", [["app/Gemfile", ""], ["app/spec/x_spec.rb", ""]]],
  ["dc", "swift: package at the root", "swift build", "swift test", "swiftlint lint", [["Package.swift", ""], [".swiftlint.yml", ""]]],
  ["dc", "swift: one nested package", "swift build --package-path pkg", "swift test --package-path pkg", "-", [["pkg/Package.swift", ""]]],
  ["dc", "dart: dart package at the root", "-", "dart test", "dart analyze", [["pubspec.yaml", ""], ["test/x_test.dart", ""]]],
  ["dc", "dart: flutter package at the root", "-", "flutter test", "flutter analyze", [["pubspec.yaml", "dependencies:\n  flutter:\n    sdk: flutter\n"], ["test/x_test.dart", ""]]],
  ["dc", "dart: a nested package has a targeted analyze only", "-", "-", "dart analyze app", [["app/pubspec.yaml", ""], ["app/test/x_test.dart", ""]]],
  ["dc", ".NET: .slnx and a nested project", "dotnet build App.slnx", "dotnet test App.slnx", "-", [["App.slnx", ""], ["src/Api/Api.csproj", ""]]],
  ["dc", ".NET: .slnx beside a same-name .sln (legacy copy)", "dotnet build App.slnx", "dotnet test App.slnx", "-", [["App.slnx", ""], ["App.sln", ""]]],
  ["dn", ".NET: two root solutions", "dotnet", [["App.sln", ""], ["Other.sln", ""]]],
  ["dc", ".NET: only a nested project", "dotnet build src/Api/Api.csproj", "dotnet test src/Api/Api.csproj", "-", [["src/Api/Api.csproj", ""]]],
  ["dn", ".NET: two nested projects", "dotnet", [["src/A/A.csproj", ""], ["tests/B/B.csproj", ""]]],
  ["dc", ".NET: a root fsproj is run bare", "dotnet build", "dotnet test", "-", [["Lib.fsproj", ""]]],
  ["dc", ".NET: root .editorconfig adds dotnet format on a bare project", "dotnet build", "dotnet test", "dotnet format --verify-no-changes", [["Lib.fsproj", ""], [".editorconfig", ""]]],
  ["dc", ".NET: root .editorconfig adds dotnet format on the target", "dotnet build src/Api/Api.csproj", "dotnet test src/Api/Api.csproj", "dotnet format src/Api/Api.csproj --verify-no-changes", [["src/Api/Api.csproj", ""], [".editorconfig", ""]]],
  ["dn", ".NET: a project only under obj is ignored", "-", [["obj/X.csproj", ""]]],
  ["dn", ".NET: a path with a space is never a candidate", "dotnet", [["src/My App/My.csproj", ""]]],
  ["dc", ".NET: a CI dotnet format line is the lint command", "-", "-", "dotnet format App.sln --verify-no-changes", [[".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - run: dotnet format App.sln --verify-no-changes\n"]]],
  ["dc", "pruned folder: a real root project is found next to a pruned one", "go build ./...", "go test ./...", "go vet ./...", [["go.mod", ""], ["vendor/dep/go.mod", ""]]],
  ["dc", "mixed: a root .slnx and a nested npm app give a list", "dotnet build App.slnx;npm --prefix web run build", "dotnet test App.slnx;npm --prefix web test", "npm --prefix web run lint", [["App.slnx", ""], ["web/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
  ["dc", "mixed: two ambiguous solutions leave only the npm app", "npm --prefix web run build", "npm --prefix web test", "npm --prefix web run lint", [["App.sln", ""], ["Other.sln", ""], ["web/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
  ["dc", "mixed: a Makefile target closes its kind, the other kinds still list every ecosystem", "make build", "dotnet test App.slnx;npm --prefix web test", "npm --prefix web run lint", [["Makefile", "build:\n\tx\n"], ["App.slnx", ""], ["web/package.json", "{\"scripts\":{\"build\":\"b\",\"test\":\"t\",\"lint\":\"l\"}}"]]],
]);

for (const row of TABLE) {
  if (row[0] === 'dc') {
    const [, desc, eb, et, el, items] = row;
    test(`discovery: ${desc}`, () => {
      const got = discoverCommands(fx(items));
      assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], [eb, et, el]);
    });
  } else {
    const [, desc, id, items] = row;
    test(`discovery: ${desc}`, () => {
      const got = discoverCommands(fx(items));
      assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], ['-', '-', '-']);
      if (id !== '-') assert.ok(ambigIds(id, got), `${id} is not named as ambiguous: ${JSON.stringify(got.ambig)}`);
    });
  }
}

for (const pr of ['node_modules/x/package.json', '.venv/pyproject.toml', 'vendor/go.mod', 'target/Cargo.toml', 'build/pom.xml', 'dist/package.json', 'bin/X.csproj', 'obj/X.csproj', '.git/x/go.mod']) {
  test(`discovery: pruned folder: ${pr} is not searched`, () => {
    const got = discoverCommands(fx([[pr, '']]));
    assert.deepEqual([got.build, got.test, got.lint, got.ambig], [[], [], [], []]);
  });
}

test('discovery: a real root project is found next to a pruned one', () => {
  const got = discoverCommands(fx([['go.mod', ''], ['vendor/dep/go.mod', '']]));
  assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], ['go build ./...', 'go test ./...', 'go vet ./...']);
});

test('discovery: two ambiguous solutions leave only the npm app, and .NET is named', () => {
  const got = discoverCommands(fx([['App.sln', ''], ['Other.sln', ''], ['web/package.json', S]]));
  assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], ['npm --prefix web run build', 'npm --prefix web test', 'npm --prefix web run lint']);
  assert.deepEqual(got.ambig, [{ id: 'dotnet', why: 'several targets: App.sln, Other.sln' }]);
  assert.deepEqual(ambigNotes(got.ambig), ['no command proposed for .NET (several targets: App.sln, Other.sln); a run that proves one asks you once to add it']);
});

test('discovery: a Makefile target closes its kind, the other kinds still list every ecosystem', () => {
  const got = discoverCommands(fx([['Makefile', 'build:\n\tx\n'], ['App.slnx', ''], ['web/package.json', S]]));
  assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], ['make build', 'dotnet test App.slnx;npm --prefix web test', 'npm --prefix web run lint']);
});

test('discovery: 300 nested package.json are judged in seconds and named as several projects', () => {
  const items = /** @type {Array<[string, string]>} */ ([]);
  for (let i = 0; i < 300; i++) items.push([`pkgs/p${i}/package.json`, `{"name":"p${i}"}\n`]);
  const d = fx(items);
  const t0 = Date.now();
  const got = discoverCommands(d);
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
  assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], ['-', '-', '-']);
  assert.deepEqual(got.ambig, [{ id: 'npm', why: 'several projects: pkgs/p0, pkgs/p1, pkgs/p10, pkgs/p100, ...' }]);
});

test('discovery: more marker files than the search reads trust nothing nested', () => {
  const items = /** @type {Array<[string, string]>} */ ([]);
  for (let i = 0; i < 1001; i++) items.push([`m/p${String(i).padStart(4, '0')}/package.json`, '{}']);
  const got = discoverCommands(fx(items));
  assert.deepEqual([flat(got.build), flat(got.test), flat(got.lint)], ['-', '-', '-']);
  assert.deepEqual(got.ambig, [{ id: 'npm', why: 'more marker files than the search reads' }]);
});

// ---- the sources of the commands, in their order (the former sc_discovery of cli-test.sh) ----
test('discovery: package.json with pnpm; the npm placeholder test script is ignored', () => {
  const got = discoverCommands(fx([['package.json', '{"scripts":{"build":"b","test":"echo \\"Error: no test specified\\" && exit 1"}}'], ['pnpm-lock.yaml', '']]));
  assert.deepEqual([got.build, got.test, got.lint], [['pnpm run build'], [], []]);
});
test('discovery: Makefile targets', () => {
  const got = discoverCommands(fx([['Makefile', 'build:\n\tgo build\ntest:\n\tgo test\n']]));
  assert.deepEqual([got.build, got.test, got.lint], [['make build'], ['make test'], []]);
});
test('discovery: a justfile and a Taskfile', () => {
  const j = discoverCommands(fx([['justfile', 'build:\n  x\nlint := "y"\ntest arg:\n  z\n']]));
  assert.deepEqual([j.build, j.test, j.lint], [['just build'], [], []]);
  const t = discoverCommands(fx([['Taskfile.yml', 'version: 3\ntasks:\n  build:\n    cmds: [x]\n  test: # all\n    cmds: [y]\n']]));
  assert.deepEqual([t.build, t.test, t.lint], [['task build'], ['task test'], []]);
  const noTasks = discoverCommands(fx([['Taskfile.yml', 'version: 3\n  build:\n']]));
  assert.deepEqual([noTasks.build, noTasks.test, noTasks.lint], [[], [], []]);
});
test('discovery: CI configuration (compound and templated lines are skipped)', () => {
  const d = fx([['.github/workflows/ci.yml', 'jobs:\n  ci:\n    steps:\n      - run: npm run lint\n      - run: make test\n      - run: echo ${{ secrets.X }} && make build\n']]);
  const got = discoverCommands(d);
  assert.deepEqual([got.build, got.test, got.lint], [[], ['make test'], ['npm run lint']]);
});
test('discovery: README code lines', () => {
  const got = discoverCommands(fx([['README.md', '# x\n\nRun the tests:\n\n    $ cargo test\n']]));
  assert.deepEqual([got.build, got.test, got.lint], [[], ['cargo test'], []]);
});
test('discovery: README lines with & ; | < > backticks and $() are rejected', () => {
  const got = discoverCommands(fx([['README.md', '# x\n\n    make build & touch PWNED\n    npm test > out.txt\n    npm run lint; touch PWNED\n    cargo test <in\n    pytest `touch PWNED`\n    go test $(touch PWNED)\n    make lint || true\n']]));
  assert.deepEqual([got.build, got.test, got.lint], [[], [], []]);
});
test('discovery: package.json scripts win over README text', () => {
  const got = discoverCommands(fx([['package.json', '{"scripts":{"test":"jest"}}'], ['README.md', '# x\n\n    cargo test\n']]));
  assert.deepEqual(got.test, ['npm test']);
});

// ---- the Core invariant for secrets: a line that carries a secret is never a candidate, so it is never printed or written ----
test('discovery: a README or CI line that carries a secret is never a candidate', () => {
  const tok = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
  const d = fx([
    ['README.md', `# x\n\n    npm test --token=${tok}\n    make build --password=hunter2\n    go test https://user:pw@example.invalid/x\n    cargo test\n`],
    ['.github/workflows/ci.yml', `jobs:\n  a:\n    steps:\n      - run: npm run lint --api-key=zzz\n      - run: pytest ${tok}\n`],
  ]);
  const got = discoverCommands(d);
  assert.deepEqual([got.build, got.test, got.lint], [[], ['cargo test'], []]);
  const all = JSON.stringify(got);
  assert.ok(!all.includes(tok) && !all.includes('hunter2') && !all.includes('pw@') && !all.includes('zzz'), all);
});

// ---- helpers ----
test('safePath, isSafeCommand and joinCommands', () => {
  assert.equal(safePath('svc/api'), true);
  for (const bad of ['', '-x', 'a b', 'a;b', "a'b", 'a$b', 'a`b']) assert.equal(safePath(bad), false, bad);
  for (const c of ['make build', 'npm run lint']) assert.equal(isSafeCommand(c), true, c);
  for (const c of ['a & b', 'a; b', 'a | b', 'a > b', 'a < b', 'a `b`', 'a $(b)', 'a ${b}', 'a {{b}}']) assert.equal(isSafeCommand(c), false, c);
  assert.equal(joinCommands(['a', 'b']), 'a; b');
});

// ---- the trial runs ----
/** @param {string} f */
function readOrNull(f) { try { return readFileSync(f, 'utf8'); } catch { return null; } }

test('verifyCommands never runs a command with shell operators, keeps a passing one and drops a failing one', () => {
  const d = fx([['x', '']]);
  const lines = /** @type {string[]} */ ([]);
  const kept = verifyCommands(d, { build: ['make build & touch PWNED', 'true'], test: ['npm test > out.txt', 'false'], lint: [] }, (l) => lines.push(l));
  assert.deepEqual(kept, { build: ['true'], test: [], lint: [] });
  assert.deepEqual(lines, [
    '  commands.build has shell operators, not trial-run and left empty: make build & touch PWNED',
    '  verified commands.build: true',
    '  commands.test has shell operators, not trial-run and left empty: npm test > out.txt',
    '  commands.test trial failed, left empty: false',
  ]);
  assert.equal(readOrNull(path.join(d, 'PWNED')), null);
  assert.equal(readOrNull(path.join(d, 'out.txt')), null);
});

test('verifyCommands stops a trial run that hangs after its limit and says it failed', () => {
  const d = fx([['x', '']]);
  const lines = /** @type {string[]} */ ([]);
  const t0 = Date.now();
  const kept = verifyCommands(d, { build: ['sleep 30'], test: [], lint: [] }, (l) => lines.push(l), { seconds: 1 });
  assert.ok(Date.now() - t0 < 10000);
  assert.deepEqual(kept.build, []);
  assert.deepEqual(lines, ['  commands.build trial failed, left empty: sleep 30']);
});

// ---- the process-group timeout (the former discover-pgroup-test.sh): one stop of the whole group, 124 whatever the command reports ----
const tok = `7${process.pid}`;   // the sleeps of the hung tree carry a number only this run uses, so they can be found in the process list
/** Pids of the live (not zombie) processes of the hung tree. */
function left() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,stat=,command='], { encoding: 'utf8' });
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 4 && !f[1].startsWith('Z') && f[2] === 'sleep' && new RegExp(`^${tok}[0-9]$`).test(f[3])).map((f) => Number(f[0]));
}
after(() => { for (const p of left()) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } });

test('runWithTimeout: a hung tree (a nested sh, a plain sleep, a subshell that ignores TERM) is closed whole and the status is 124', () => {
  const tree = `sh -c "sleep ${tok}1" & sleep ${tok}2 & (trap "" TERM; sleep ${tok}3) & wait`;
  const r = runWithTimeout(1, ['sh', '-c', tree]);
  assert.deepEqual(r, { status: 124, timedOut: true });
  assert.deepEqual(left(), []);
});

test('runWithTimeout: a leader that ignores TERM does not hold the run, and a command that traps TERM and exits 0 is no pass', () => {
  const t0 = Date.now();
  assert.equal(runWithTimeout(1, ['sh', '-c', 'trap "" TERM; sleep 30']).status, 124);
  assert.equal(runWithTimeout(1, ['sh', '-c', 'trap "exit 0" TERM; sleep 30 & wait']).status, 124);
  assert.ok(Date.now() - t0 < 20000);
});

test('runWithTimeout: the status of a command that ends in time, its output file, and a program that is not found', () => {
  const out = path.join(base, 'rt.out');
  assert.deepEqual(runWithTimeout(5, ['sh', '-c', 'echo out; echo err >&2; exit 3'], { outFile: out }), { status: 3, timedOut: false });
  assert.equal(readFileSync(out, 'utf8'), 'out\nerr\n');
  assert.equal(runWithTimeout(5, ['proofline-no-such-program']).status, 127);
});

// ---- the CLI form that bin/proofline calls ----
const core = path.join(repo, 'control-plane/agents/scripts/proofline-core.mjs');
/** @param {string[]} args @param {string} [cwd] */
const cli = (args, cwd) => spawnSync('node', [core, 'cli', ...args], { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });

test('cli discover prints what init says and writes the rows; --quiet prints nothing; a usage error is status 2', () => {
  const d = fx([['App.sln', ''], ['Other.sln', ''], ['web/package.json', S]]);
  const out = path.join(base, 'rows.tsv');
  const r = cli(['discover', d, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "discovered commands: build='npm --prefix web run build' test='npm --prefix web test' lint='npm --prefix web run lint'\n  no command proposed for .NET (several targets: App.sln, Other.sln); a run that proves one asks you once to add it\n");
  assert.equal(readFileSync(out, 'utf8'), 'build\tnpm --prefix web run build\ntest\tnpm --prefix web test\nlint\tnpm --prefix web run lint\n');
  const q = cli(['discover', d, '--quiet']);
  assert.deepEqual([q.status, q.stdout], [0, '']);
  assert.equal(cli(['discover']).status, 2);
  assert.equal(cli(['discover', d, '--bogus']).status, 2);
});

test('cli discover --verify: a failing trial leaves the command out of the rows, and the secret in a README is not printed', () => {
  const stub = path.join(base, 'stub'); mkdirSync(stub, { recursive: true });
  writeFileSync(path.join(stub, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const tok = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
  const d = fx([['package.json', '{"scripts":{"test":"x"}}'], ['README.md', `    pytest --token=${tok}\n`]]);
  const out = path.join(base, 'rows2.tsv');
  const r = spawnSync('node', [core, 'cli', 'discover', d, '--verify', '--out', out], { encoding: 'utf8', env: { ...process.env, PATH: `${stub}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "discovered commands: build='' test='npm test' lint=''\nverifying commands (trial runs)...\n  commands.test trial failed, left empty: npm test\n");
  assert.equal(readFileSync(out, 'utf8'), '');
  assert.ok(!r.stdout.includes(tok) && !r.stderr.includes(tok));
});

test('cli run-timeout prints the output of the program and returns its status, 124 on a timeout', () => {
  const ok = cli(['run-timeout', '5', 'sh', '-c', 'echo hello; echo oops >&2; exit 4']);
  assert.deepEqual([ok.status, ok.stdout], [4, 'hello\noops\n']);
  const slow = cli(['run-timeout', '1', 'sleep', '30']);
  assert.equal(slow.status, 124);
  assert.equal(cli(['run-timeout', 'x', 'true']).status, 2);
  assert.equal(cli(['run-timeout', '1']).status, 2);
});
