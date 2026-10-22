import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// runtime-versions.sh (0.0.26): the version CI specifies against the one installed here, from fake tools on PATH.
const SCRIPT = fileURLToPath(new URL("../../skills/verify-proof/scripts/runtime-versions.sh", import.meta.url));

const fakeBin = (versions) => {
  const bin = mkdtempSync(join(tmpdir(), "rv-bin-"));
  for (const [tool, out] of Object.entries(versions)) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho '${out}'\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return bin;
};
const project = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "rv-proj-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
const run = (dir, tools) => {
  const r = spawnSync("sh", [SCRIPT, dir], { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin(tools)}:${process.env.PATH}` } });
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
