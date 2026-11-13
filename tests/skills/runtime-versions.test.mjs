import { tempDir } from '../lib/tempdir.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, cpSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// runtime-versions.mjs (0.0.26; Node since A234, the shell twin passed these same expectations): the version CI specifies against the one installed here, from fake tools on PATH.
const SCRIPT = fileURLToPath(new URL("../../skills/verify-proof/scripts/runtime-versions.mjs", import.meta.url));

const fakeBin = (versions) => {
  const bin = tempDir("rv-bin-");
  for (const [tool, out] of Object.entries(versions)) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho '${out}'\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return bin;
};
const project = (files) => {
  const dir = tempDir("rv-proj-");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
const run = (dir, tools) => {
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin(tools)}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const WF = (v) => `jobs:\n  t:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: ${v}\n`;

test("a Node major that differs from the workflow's node-version is a mismatch", () => {
  const dir = project({ ".github/workflows/ci.yml": WF("20"), "package.json": "{}" });
  assert.equal(run(dir, { node: "v22.1.0" }), "runtime: node local=22.1.0 ci=20 source=.github/workflows/ci.yml status=mismatch");
});

test("the same major (any minor or patch) matches", () => {
  const dir = project({ ".github/workflows/ci.yml": WF("'22.x'") });
  assert.match(run(dir, { node: "v22.13.0" }), /^runtime: node local=22\.13\.0 ci=22\.x .*status=match$/);
});

test("a matrix lists several majors; the local one must be among them", () => {
  const dir = project({ ".github/workflows/ci.yml": WF("[18, 20]") });
  assert.match(run(dir, { node: "v20.9.0" }), /ci=18,20 .*status=match/);
  assert.match(run(dir, { node: "v22.0.0" }), /ci=18,20 .*status=mismatch/);
});

test("without a workflow value, .nvmrc then package.json engines name the version; a >= range is a minimum", () => {
  assert.match(run(project({ ".nvmrc": "v18\n" }), { node: "v20.0.0" }), /ci=v18 source=\.nvmrc status=mismatch/);
  const eng = project({ "package.json": '{"name":"x","engines":{"node":">=20"}}' });
  assert.match(run(eng, { node: "v22.0.0" }), /ci=>=20 source=package\.json status=match/);
  assert.match(run(eng, { node: "v18.0.0" }), /ci=>=20 source=package\.json status=mismatch/);
});

test("go compares major.minor, and go.mod is a minimum", () => {
  const dir = project({ "go.mod": "module x\n\ngo 1.22\n" });
  assert.match(run(dir, { go: "go version go1.24.1 darwin/arm64" }), /^runtime: go local=1\.24\.1 ci=>=1\.22 source=go\.mod status=match$/);
  const wf = project({ ".github/workflows/ci.yml": "- uses: actions/setup-go@v5\n  with:\n    go-version: 1.21\n" });
  assert.match(run(wf, { go: "go version go1.24.1 darwin/arm64" }), /ci=1\.21 .*status=mismatch/);
});

test("a spec that cannot be compared, or no spec at all, is unknown; no runtime is said so", () => {
  assert.match(run(project({ ".nvmrc": "lts/*\n" }), { node: "v22.0.0" }), /ci=lts\/\* .*status=unknown/);
  assert.match(run(project({ "package.json": "{}" }), { node: "v22.0.0" }), /^runtime: node local=22\.0\.0 ci=none source=- status=unknown$/);
  assert.equal(run(project({ "README.md": "x" }), {}), "runtime: none (no language runtime detected)");
});

// A173: the project is not assumed to sit at the root; the line of one runtime is picked out of the output.
const line = (dir, tools, name) => run(dir, tools).split("\n").filter((l) => l.startsWith(`runtime: ${name} `)).join("\n");
const DOTNET = { dotnet: "10.0.100" };

test(".NET is present with only an App.slnx, only a nested src/Api/Api.csproj, or a root fsproj", () => {
  const want = "runtime: dotnet local=10.0.100 ci=none source=- status=unknown";
  assert.equal(line(project({ "App.slnx": "<Solution/>" }), DOTNET, "dotnet"), want);
  assert.equal(line(project({ "src/Api/Api.csproj": "<Project/>" }), DOTNET, "dotnet"), want);
  assert.equal(line(project({ "Lib.fsproj": "<Project/>" }), DOTNET, "dotnet"), want);
});

test("a project only under obj or bin is not a .NET project", () => {
  assert.equal(run(project({ "obj/Api.csproj": "<Project/>", "src/Api/bin/Debug/X.csproj": "<Project/>" }), DOTNET), "runtime: none (no language runtime detected)");
});

test("a setup-dotnet version that differs from the local SDK is a mismatch, also with no global.json", () => {
  const wf = "steps:\n  - uses: actions/setup-dotnet@v4\n    with:\n      dotnet-version: 8.0.x\n";
  const dir = project({ ".github/workflows/ci.yml": wf, "src/Api/Api.csproj": "<Project/>" });
  assert.equal(line(dir, DOTNET, "dotnet"), "runtime: dotnet local=10.0.100 ci=8.0.x source=.github/workflows/ci.yml status=mismatch");
});

test("a nested global.json names the SDK; the root one wins over a nested one", () => {
  const nested = project({ "src/Api/global.json": '{"sdk":{"version":"8.0.400"}}', "src/Api/Api.csproj": "<Project/>" });
  assert.equal(line(nested, DOTNET, "dotnet"), "runtime: dotnet local=10.0.100 ci=8.0.400 source=src/Api/global.json status=mismatch");
  const both = project({ "global.json": '{"sdk":{"version":"10.0.100"}}', "src/Api/global.json": '{"sdk":{"version":"8.0.400"}}' });
  assert.equal(line(both, DOTNET, "dotnet"), "runtime: dotnet local=10.0.100 ci=10.0.100 source=global.json status=match");
});

test("version files of the other ecosystems are read in nested folders", () => {
  const tools = { node: "v22.1.0", python3: "Python 3.12.1", go: "go version go1.24.1 darwin/arm64", rustc: "rustc 1.75.0 (abc 2023-12-21)", java: 'openjdk version "17.0.2" 2022-01-18' };
  const dir = project({
    "web/.nvmrc": "v20\n", "web/package.json": "{}",
    "svc/.python-version": "3.11\n",
    "api/go.mod": "module x\n\ngo 1.25\n",
    "crates/core/rust-toolchain": "1.70\n", "crates/core/Cargo.toml": "[package]\n",
    "srv/.java-version": "21\n",
  });
  assert.equal(line(dir, tools, "node"), "runtime: node local=22.1.0 ci=v20 source=web/.nvmrc status=mismatch");
  assert.equal(line(dir, tools, "python"), "runtime: python local=3.12.1 ci=3.11 source=svc/.python-version status=mismatch");
  assert.equal(line(dir, tools, "go"), "runtime: go local=1.24.1 ci=>=1.25 source=api/go.mod status=mismatch");
  assert.equal(line(dir, tools, "rust"), "runtime: rust local=1.75.0 ci=1.70 source=crates/core/rust-toolchain status=mismatch");
  assert.equal(line(dir, tools, "java"), "runtime: java local=17.0.2 ci=21 source=srv/.java-version status=mismatch");
});

test("a nested .tool-versions names the versions, and a pruned folder is not read", () => {
  const dir = project({ "app/.tool-versions": "nodejs 20.1.0\njava 17.0.1\n", "app/package.json": "{}", "node_modules/x/.nvmrc": "v10\n", "node_modules/x/package.json": "{}" });
  const tools = { node: "v20.9.0", java: 'openjdk version "17.0.2"' };
  assert.equal(line(dir, tools, "node"), "runtime: node local=20.9.0 ci=20.1.0 source=app/.tool-versions status=match");
  assert.equal(line(dir, tools, "java"), "runtime: java local=17.0.2 ci=17.0.1 source=app/.tool-versions status=match");
  assert.equal(run(project({ "node_modules/x/.nvmrc": "v10\n", "node_modules/x/package.json": "{}" }), tools), "runtime: none (no language runtime detected)");
});

// A234: what the shell twin did not pin
test("a directory that cannot be entered is a usage error (exit 2), and no argument means the current directory", () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), "rv-does-not-exist")], { encoding: "utf8" });
  assert.equal(r.status, 2); assert.match(r.stderr, /^runtime-versions: cannot enter /);
  const dir = project({ ".nvmrc": "v20\n", "package.json": "{}" });
  const c = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${fakeBin({ node: "v20.1.0" })}:${process.env.PATH}` } });
  assert.equal(c.status, 0); assert.equal(c.stdout.trim(), "runtime: node local=20.1.0 ci=v20 source=.nvmrc status=match");
});

test("a runtime that is not installed is local=missing and unknown", () => {
  const dir = project({ ".nvmrc": "v20\n", "package.json": "{}" });
  const env = { ...process.env, PATH: fakeBin({}) };
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", env });
  assert.equal(r.status, 0); assert.match(r.stdout, /^runtime: node local=missing ci=v20 source=\.nvmrc status=unknown$/m);
});

test("a workflow value with an expression is skipped, the next source answers; a matrix block list is read", () => {
  const expr = project({ ".github/workflows/ci.yml": WF("${{ matrix.node }}"), ".nvmrc": "18\n" });
  assert.match(run(expr, { node: "v18.2.0" }), /ci=18 source=\.nvmrc status=match/);
  const blk = project({ ".github/workflows/ci.yml": "jobs:\n  t:\n    strategy:\n      matrix:\n        node-version:\n          - 18   # old\n          - 20\n    steps: []\n" });
  assert.match(run(blk, { node: "v20.1.0" }), /ci=18,20 source=\.github\/workflows\/ci\.yml status=match/);
});

test("a .gitlab-ci.yml image names the version; the root file wins over a nested one", () => {
  assert.match(run(project({ ".gitlab-ci.yml": "build:\n  image: node:20-alpine\n" , "package.json": "{}"}), { node: "v22.0.0" }), /ci=20 source=\.gitlab-ci\.yml status=mismatch/);
  const both = project({ ".nvmrc": "v22\n", "web/.nvmrc": "v18\n", "package.json": "{}" });
  assert.match(run(both, { node: "v22.0.0" }), /ci=v22 source=\.nvmrc status=match/);
});

test("SECURITY: the skill reads only its own copy of the ecosystem definition, never the project's .agents/ecosystems.json", () => {
  const marker = join(tempDir("rv-sec-"), "ran");
  const hostile = JSON.parse(readFileSync(fileURLToPath(new URL("../../skills/verify-proof/references/ecosystems.json", import.meta.url)), "utf8"));
  hostile.ecosystems[0].runtime.local.commands = [`touch ${marker}`];
  const dir = project({ "package.json": "{}", ".agents/ecosystems.json": JSON.stringify(hostile) });
  // the installed layout: the script sits in .agents/skills/<name>/scripts of the project
  const inst = join(dir, ".agents/skills/verify-proof");
  cpSync(fileURLToPath(new URL("../../skills/verify-proof", import.meta.url)), inst, { recursive: true });
  spawnSync(process.execPath, [join(inst, "scripts/runtime-versions.mjs"), dir], { encoding: "utf8", env: process.env });
  assert.equal(existsSync(marker), false, "the project's definition was used to run a command");
});

test("the script imports nothing outside its skill (it is installable alone)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../skills/verify-proof/scripts/runtime-versions.mjs", import.meta.url)), "utf8");
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) assert.ok(m[1].startsWith("node:") || ["./ecosystems.mjs", "./winprog.mjs"].includes(m[1]), m[1]);
});

// fix round 1 (F4, F5, F6)
test("SECURITY: a version file that is a symbolic link to a file outside the project is not read into the report", () => {
  const outside = project({ "secret.txt": "TOP-SECRET-LINE\n" });
  const dir = project({ "package.json": "{}" });
  symlinkSync(join(outside, "secret.txt"), join(dir, ".nvmrc"));
  const out = run(dir, { node: "v20.0.0" });
  assert.doesNotMatch(out, /TOP-SECRET/); assert.match(out, /ci=none source=-/);
  const inner = project({ "package.json": "{}", "real.txt": "v18\n" });
  symlinkSync(join(inner, "real.txt"), join(inner, ".nvmrc"));
  assert.match(run(inner, { node: "v20.0.0" }), /ci=none source=-/, "even a link that stays inside is skipped");
});

test("SECURITY: a program planted in the project is not run, whatever PATH holds ('.' and empty entries)", () => {
  const marker = join(tempDir("rv-plant-"), "ran");
  const dir = project({ "package.json": "{}" });
  writeFileSync(join(dir, "node"), `#!/bin/sh\n: > ${marker}\necho v99.0.0\n`); chmodSync(join(dir, "node"), 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, dir], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `.::relative:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(marker), false, "the planted node ran");
  assert.doesNotMatch(r.stdout, /99\.0\.0/);
});

test("a run through a symbolic link to the script folder still runs (the main guard compares real paths)", () => {
  const link = join(tempDir("rv-link-"), "scripts");
  symlinkSync(realpathSync(fileURLToPath(new URL("../../skills/verify-proof/scripts", import.meta.url))), link);
  const dir = project({ ".nvmrc": "v20\n", "package.json": "{}" });
  const r = spawnSync(process.execPath, [join(link, "runtime-versions.mjs"), dir], { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin({ node: "v20.1.0" })}:${process.env.PATH}` } });
  assert.match(r.stdout, /^runtime: node local=20\.1\.0 ci=v20 /);
});
