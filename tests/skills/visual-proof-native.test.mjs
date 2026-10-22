// visual-proof for native apps (0.0.24): target detection, project tool discovery, UNSUPPORTED, the uiautomator parser and
// the touch-target/label checks, and the report validator. Inline temporary fixtures; no model, no emulator, no device.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectTarget, detectAll, parseUiautomator, measureNative, buildReport } from "../../skills/visual-proof/scripts/native.mjs";
import { validateReport } from "../../skills/visual-proof/scripts/validate-visual.mjs";

const NATIVE = fileURLToPath(new URL("../../skills/visual-proof/scripts/native.mjs", import.meta.url));
const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "vp-native-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const put = (root, files) => { for (const [f, t] of Object.entries(files)) { const p = join(root, f); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); } return root; };

const flutter = (extra = {}) => put(mktmp(), { "pubspec.yaml": "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n", "lib/main.dart": "void main() {}\n", ...extra });
const android = (extra = {}) => put(mktmp(), { "build.gradle.kts": 'plugins { id("com.android.application") version "8.0.0" }\n', "app/src/main/AndroidManifest.xml": "<manifest/>", ...extra });

test("target type comes from files: flutter, android, react-native, web, web-tech desktop", () => {
  const f = detectTarget(flutter());
  assert.equal(f.type, "native-mobile"); assert.equal(f.platform, "flutter");
  assert.ok(f.evidence.some((e) => e.path === "pubspec.yaml"));
  const a = detectTarget(android());
  assert.equal(a.type, "native-mobile"); assert.equal(a.platform, "android");
  assert.ok(a.evidence.some((e) => e.path.endsWith("AndroidManifest.xml")));
  const rn = detectTarget(put(mktmp(), { "package.json": JSON.stringify({ dependencies: { "react-native": "1.0.0" }, scripts: { start: "x" } }) }));
  assert.equal(rn.platform, "react-native");
  const web = detectTarget(put(mktmp(), { "index.html": "<html></html>" }));
  assert.equal(web.type, "web");
  const el = detectTarget(put(mktmp(), { "package.json": JSON.stringify({ devDependencies: { electron: "1" }, scripts: { start: "electron ." } }), "index.html": "<html></html>" }));
  assert.equal(el.type, "web"); assert.equal(el.via, "browser"); assert.equal(el.shell, "electron");
  const tauri = detectTarget(put(mktmp(), { "src-tauri/tauri.conf.json": "{}" }));
  assert.equal(tauri.type, "desktop");
});

test("no test tool: UNSUPPORTED with a one-line suggestion, never a pass; a tool alone is only DISCOVERED", () => {
  const none = detectAll({ repo: flutter() });
  assert.equal(none.result, "UNSUPPORTED");
  assert.match(none.suggestion, /^adding .+nothing was added$/);
  const dflt = detectAll({ repo: flutter({ "pubspec.yaml": "name: d\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  golden_toolkit: ^0.15.0\n" }) });
  assert.equal(dflt.result, "DISCOVERED");
  assert.equal(dflt.tools[0].name, "flutter-golden");
  const gradle = detectAll({ repo: android({ "app/build.gradle.kts": 'dependencies { androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1") }', gradlew: "#!/bin/sh", "README.md": "Run `./gradlew connectedDebugAndroidTest` on an emulator.\nNever `./gradlew recordPaparazziDebug` here.\n" }) });
  assert.equal(gradle.tools[0].name, "espresso");
  assert.equal(gradle.tools[0].command, "./gradlew connectedDebugAndroidTest");
  assert.equal(gradle.tools[0].source, "README.md");
  // --run: no booted device -> UNSUPPORTED and the command is not executed
  let ran = false;
  const noDev = detectAll({ repo: android({ "app/build.gradle.kts": "androidx.test.espresso", gradlew: "x" }), run: true, devices: () => ({ android: 0, ios: 0 }), exec: () => { ran = true; return { status: 0 }; } });
  assert.equal(noDev.result, "UNSUPPORTED"); assert.equal(ran, false);
  // a device-free tool is run once with a timeout of at least 30 s
  let opts;
  const ok = detectAll({ repo: flutter({ "pubspec.yaml": "name: d\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  alchemist: 1\n" }), run: true, timeout: 5, exec: (c, o) => { opts = o; return { status: 0, stdout: "ok" }; } });
  assert.equal(ok.result, "PROVEN"); assert.ok(opts.timeout >= 30000);
});

const DUMP = (w, h) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">
 <node index="0" text="Pay" resource-id="app:id/pay" class="android.widget.Button" content-desc="" clickable="true" bounds="[0,0][${w},${h}]" />
 <node index="1" text="" resource-id="app:id/close" class="android.widget.ImageButton" content-desc="Close" clickable="true" bounds="[200,0][296,96]" />
</node></hierarchy>`;

test("uiautomator dump: a 30dp button is a touch-target violation; 48dp passes; missing labels are counted", () => {
  const bad = measureNative({ ...parseUiautomator(DUMP(60, 60), { density: 2 }), os: "android" });
  const t = bad.items.find((i) => i.check === "native_touch_target");
  assert.equal(t.status, "fail"); assert.equal(t.value, 30); assert.equal(t.threshold, ">= 48");
  const good = measureNative({ ...parseUiautomator(DUMP(96, 96), { density: 2 }), os: "android" });
  assert.equal(good.items.find((i) => i.check === "native_touch_target").status, "pass");
  assert.equal(good.items.find((i) => i.check === "native_labels").status, "pass"); // the button's own text labels it
  // what the dump cannot carry is listed, never measured
  assert.deepEqual(good.not_measured.map((n) => n.check).sort(), ["native_dark_theme", "native_large_text"]);
  // without a density the pixel sizes are not dp: not measured, not guessed
  const px = measureNative({ ...parseUiautomator(DUMP(60, 60)), os: "android" });
  assert.ok(px.not_measured.some((n) => n.check === "native_touch_target"));
  assert.ok(!px.items.some((i) => i.check === "native_touch_target"));
  const unlabeled = parseUiautomator(DUMP(96, 96).replace('text="Pay"', 'text=""'), { density: 2 });
  assert.equal(measureNative({ ...unlabeled, os: "android" }).items.find((i) => i.check === "native_labels").status, "fail");
});

function config(root, w, h, extra = {}) {
  put(root, { "shot.png": "png", "dump.xml": DUMP(w, h) });
  return { class: "STANDARD", tool: { name: "uiautomator-dump" }, target: { type: "native-mobile", platform: "android", evidence: ["build.gradle.kts"] },
    devices: [{ name: "pixel", width: 540, height: 1200, os: "android" }], screens: [{ id: "home", path: "Home", states: ["default"] }],
    captures: [{ screen: "home", state: "default", device: "pixel", screenshot: "shot.png", output: "dump.xml", density: 2 }], criteria: [{ id: "AC-1", required: true, checks: ["native_touch_target"] }], ...extra };
}
const build = (cfg, root) => { const out = mktmp(); const r = buildReport(cfg, out, root); return { r, out, v: validateReport(r, { root: out }) }; };

test("native report: touch-target violation FAILS, a valid dump PASSES, results are validator-consistent", () => {
  const rootBad = mktmp();
  const bad = build(config(rootBad, 60, 60), rootBad);
  assert.equal(bad.v.valid, true, bad.v.errors.join("\n")); assert.equal(bad.r.result, "FAIL");
  assert.match(bad.v.rows.join("\n"), /native_touch_target: 30 fails >= 48/);
  const rootOk = mktmp();
  const ok = build(config(rootOk, 96, 96), rootOk);
  assert.equal(ok.v.valid, true, ok.v.errors.join("\n")); assert.equal(ok.r.result, "PASS");
  assert.equal(ok.r.tool.kind, "native-tool");
  assert.ok(ok.r.target.not_measured.some((n) => n.check === "native_large_text"));
  // the validator recomputes: a forged PASS over the failing report is rejected
  const forged = JSON.parse(JSON.stringify(bad.r)); forged.result = "PASS";
  assert.match(validateReport(forged, { root: bad.out }).errors.join("\n"), /contradicts the evidence/);
  // a platform-weakened threshold is rejected (48dp on android)
  const weak = JSON.parse(JSON.stringify(ok.r)); const m = weak.measured.find((x) => x.check === "native_touch_target"); m.threshold = ">= 40"; m.value = 41;
  assert.match(validateReport(weak, { root: ok.out }).errors.join("\n"), /weaker than/);
});

test("native report with no measured cell cannot PASS; no tool is UNSUPPORTED with its suggestion line", () => {
  const root = mktmp();
  const cfg = config(root, 96, 96); cfg.captures[0].output = "missing.xml";
  const r = build(cfg, root);
  assert.equal(r.v.valid, true, r.v.errors.join("\n"));
  assert.equal(r.r.result, "INCONCLUSIVE");
  const none = build({ class: "STANDARD", tool: { kind: "none", reason: "no UI or screenshot test tool found" }, target: { type: "native-mobile", platform: "flutter", evidence: ["pubspec.yaml"] }, devices: [], screens: [] }, root);
  assert.equal(none.v.valid, true, none.v.errors.join("\n")); assert.equal(none.r.result, "UNSUPPORTED"); assert.notEqual(none.v.computed, "PASS");
  const noSug = JSON.parse(JSON.stringify(none.r)); delete noSug.suggestion;
  assert.match(validateReport(noSug, { root }).errors.join("\n"), /suggestion/);
  // native checks cannot ride on a web report
  const web = JSON.parse(JSON.stringify(r.r)); web.tool = { kind: "headless-browser", name: "chromium" }; delete web.target;
  assert.match(validateReport(web, { root: r.out }).errors.join("\n"), /native checks are only allowed/);
});

test("CLI: --detect exits 1 for UNSUPPORTED and 0 for a web project; usage error is 2", () => {
  const run = (...a) => spawnSync(process.execPath, [NATIVE, ...a], { encoding: "utf8" });
  const u = run("--detect", "--repo", flutter());
  assert.equal(u.status, 1); assert.equal(JSON.parse(u.stdout).result, "UNSUPPORTED");
  const w = run("--detect", "--repo", put(mktmp(), { "index.html": "x" }));
  assert.equal(w.status, 0); assert.equal(JSON.parse(w.stdout).target.type, "web");
  assert.equal(run().status, 2);
});
