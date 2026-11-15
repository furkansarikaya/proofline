import { tempDir } from '../lib/tempdir.mjs';
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A279: a tool that is installed but cannot run its version command in this project (a pinned SDK that is not installed) is reported from the
// ecosystem's `runtime.local.installed` list, not as "missing". The fake dotnet behaves like the real one: `dotnet --version` exits 145 under a
// global.json whose SDK is not installed; `dotnet --list-sdks` prints "<version> [<dir>]" per installed SDK.
const SCRIPT = fileURLToPath(new URL("../../skills/verify-proof/scripts/runtime-versions.mjs", import.meta.url));

const FAKE = (sdks) => `#!/bin/sh
case "$1" in
  --version)
    if [ -f global.json ] && ! grep -q '"version": *"${sdks[0].replace(/\./g, "\\.")}"' global.json; then
      echo "The command could not be loaded, possibly because:" >&2
      echo "  * Requested SDK version: $(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' global.json)" >&2
      exit 145
    fi
    echo '${sdks[0]}' ;;
  --list-sdks) ${sdks.map((s) => `echo '${s} [/usr/share/dotnet/sdk]'`).join("; ")} ;;
esac
`;
const run = (files, sdks) => {
  const bin = tempDir("ri-bin-");
  if (sdks) { writeFileSync(join(bin, "dotnet"), FAKE(sdks)); chmodSync(join(bin, "dotnet"), 0o755); }
  const dir = tempDir("ri-proj-");
  for (const [n, t] of Object.entries(files)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), t); }
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter((l) => l.startsWith("runtime: dotnet ")).join("\n");
};
const GJ = (v) => `{ "sdk": { "version": "${v}" } }`;

test("a pinned SDK that is not installed: the tool is present, the installed SDKs are listed, the status is mismatch", () => {
  assert.equal(run({ "global.json": GJ("10.0.100") }, ["8.0.134"]),
    "runtime: dotnet local=8.0.134 ci=10.0.100 source=global.json status=mismatch installed=8.0.134");
});

test("several installed SDKs: local is the highest and every one is listed", () => {
  assert.equal(run({ "global.json": GJ("10.0.100") }, ["8.0.134", "9.0.200"]),
    "runtime: dotnet local=9.0.200 ci=10.0.100 source=global.json status=mismatch installed=8.0.134,9.0.200");
});

test("happy path: the pinned SDK is the installed one, no installed= field", () => {
  assert.equal(run({ "global.json": GJ("8.0.134") }, ["8.0.134"]),
    "runtime: dotnet local=8.0.134 ci=8.0.134 source=global.json status=match");
});

test("the tool is absent: still missing and unknown", () => {
  assert.equal(run({ "global.json": GJ("10.0.100") }, null),
    "runtime: dotnet local=missing ci=10.0.100 source=global.json status=unknown");
});
