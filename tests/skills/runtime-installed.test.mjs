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

// Hermetic: the fake is a node script run by the absolute path of this node (no PATH lookup, no sh/grep/sed), PATH holds ONLY the unique tmp dir,
// and every DOTNET_* variable is dropped, so no real dotnet of the machine can answer.
const FAKE = (sdks) => `#!${process.execPath}
const fs = require("node:fs");
const [a] = process.argv.slice(2);
if (a === "--version") {
  let want = null;
  try { want = JSON.parse(fs.readFileSync("global.json", "utf8")).sdk.version; } catch {}
  if (want !== null && want !== ${JSON.stringify(sdks[0])}) {
    process.stderr.write("The command could not be loaded, possibly because:\\n  * Requested SDK version: " + want + "\\n");
    process.exit(145);
  }
  console.log(${JSON.stringify(sdks[0])});
} else if (a === "--list-sdks") {
  for (const v of ${JSON.stringify(sdks)}) console.log(v + " [/usr/share/dotnet/sdk]");
}
`;
const run = (files, sdks) => {
  const bin = tempDir("ri-bin-");
  if (sdks) { writeFileSync(join(bin, "dotnet"), FAKE(sdks)); chmodSync(join(bin, "dotnet"), 0o755); }
  const dir = tempDir("ri-proj-");
  for (const [n, t] of Object.entries(files)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), t); }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DOTNET|MSBUILD|NUGET)/i.test(k) && k !== "PATH"));
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", env: { ...env, PATH: bin } });
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
