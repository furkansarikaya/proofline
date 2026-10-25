// A173: skills that read the ecosystem definition recognise the .NET project and solution kinds. design-sync (ARCHITECTURE.md
// paths, reverse system) and visual-proof (native UI detection). The benchmark probe of agent.sh is in risk-test.sh.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { run } from "../../skills/design-sync/scripts/design-sync.mjs";
import { detectTarget } from "../../skills/visual-proof/scripts/native.mjs";

const dirs = [];
const project = (files) => {
  const root = mkdtempSync(join(tmpdir(), "eco-det-")); dirs.push(root);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  return root;
};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("design-sync: fsproj, vbproj, slnx and sln named in ARCHITECTURE.md are checked, and reverse system lists the project files", () => {
  const root = project({
    "docs/design/ARCHITECTURE.md": "# Architecture\n\n- `src/Api/Api.fsproj` the api\n- `src/Vb/Vb.vbproj` legacy\n- `App.slnx` solution\n- `Legacy.sln` old\n- `src/Gone/Gone.fsproj` removed\n",
    "src/Api/Api.fsproj": "<Project/>", "src/Api/Program.fs": "let x = 1\n", "src/Vb/Vb.vbproj": "<Project/>", "src/Vb/M.vb": "Module M\nEnd Module\n",
    "App.slnx": "<Solution/>", "Legacy.sln": "Microsoft Visual Studio Solution File\n",
  });
  const status = (out, claim) => out.claims.find((c) => c.claim === claim)?.status;
  const out = run({ root });
  for (const p of ["src/Api/Api.fsproj", "src/Vb/Vb.vbproj", "App.slnx", "Legacy.sln"]) assert.equal(status(out, p), "matched", p);
  assert.equal(status(out, "src/Gone/Gone.fsproj"), "unmatched");
  const sys = run({ root, reverse: "system" }).facts;
  assert.deepEqual(sys.manifests.sort(), ["src/Api/Api.fsproj", "src/Vb/Vb.vbproj"]);
  assert.ok(sys.modules.some((m) => m.dir === "src/Api"), "a nested project directory is a module");
});

test("visual-proof native: <UseMaui>true</UseMaui> is a MAUI app, false is not", () => {
  const maui = (v, ext = "csproj") => project({ [`App/App.${ext}`]: `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net9.0-android;net9.0-ios</TargetFrameworks><UseMaui>${v}</UseMaui></PropertyGroup></Project>` });
  for (const ext of ["csproj", "fsproj", "vbproj"]) {
    const t = detectTarget(maui("true", ext));
    assert.equal(t.type, "native-mobile", ext); assert.equal(t.platform, "maui", ext);
    assert.ok(t.evidence.some((e) => e.path === `App/App.${ext}` && /UseMaui is true/.test(e.why)), ext);
  }
  const off = detectTarget(maui("false"));
  assert.notEqual(off.platform, "maui"); assert.equal(off.type, "web");
});
