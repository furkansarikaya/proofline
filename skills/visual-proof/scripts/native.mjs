#!/usr/bin/env node
// visual-proof for native apps (0.0.24). Read-only, Node only, installs nothing, imposes nothing: it detects the
// target type from files, finds the UI/screenshot test tools the project already has, discovers (and with --run,
// proves once) the project's own command, parses structured tool output into a normalized measurement format and
// builds a report.json that validate-visual.mjs checks.
//
//   node native.mjs --detect --repo DIR [--run] [--timeout MS] [--json]
//   node native.mjs --normalize FILE [--density N] [--os android|ios] [--device NAME]   uiautomator XML or generic JSON -> normalized JSON
//   node native.mjs --check FILE [--density N] [--os android|ios]                       measure one normalized/uiautomator file
//   node native.mjs --build native.json --out DIR                                       write DIR/report.json (references/NATIVE.md)
//
// Exit codes: 0 ok, 1 UNSUPPORTED or a failed command (detect), a failing check (check), 2 usage or I/O error.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA, requiredCells, validateReport } from "./validate-visual.mjs";

export const NATIVE_SCHEMA = "visual-proof.native/1";
export const TARGET_SCHEMA = "visual-proof.target/1";
const SKIP_DIRS = new Set(["node_modules", ".git", "build", "Pods", ".dart_tool", "dist", ".gradle", "DerivedData", ".agents", "vendor", ".idea"]);

// --- file helpers ----------------------------------------------------------------------------------------
function walk(repo, maxDepth = 4, limit = 6000) {
  const out = [];
  const rec = (dir, depth) => {
    if (out.length >= limit) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      const rel = relative(repo, p).split("\\").join("/");
      if (e.isDirectory()) {
        out.push({ rel, dir: true });
        if (depth < maxDepth && !SKIP_DIRS.has(e.name)) rec(p, depth + 1);
      } else out.push({ rel, dir: false });
    }
  };
  rec(repo, 1);
  return out;
}
const readCap = (p, cap = 400_000) => { try { return readFileSync(p, "utf8").slice(0, cap); } catch { return ""; } };
const inSkipped = (rel) => rel.split("/").some((s) => SKIP_DIRS.has(s));

// --- target type -----------------------------------------------------------------------------------------
export function detectTarget(repo) {
  const all = walk(repo).filter((f) => !inSkipped(f.rel));
  const files = all.filter((f) => !f.dir).map((f) => f.rel);
  const dirs = all.filter((f) => f.dir).map((f) => f.rel);
  const read = (rel) => readCap(join(repo, rel));
  const platforms = new Set();
  const evidence = [];
  const ev = (p, why) => { if (!evidence.some((e) => e.path === p)) evidence.push({ path: p, why }); };
  const webEntry = [];
  let shell = null;
  const desktop = [];

  for (const f of files) {
    const base = basename(f);
    if (base === "pubspec.yaml") {
      const t = read(f);
      if (/^\s*sdk:\s*flutter\b/m.test(t) || /^flutter:/m.test(t)) { platforms.add("flutter"); ev(f, "pubspec.yaml with the flutter sdk"); }
    } else if (base === "package.json") {
      let pkg = {};
      try { pkg = JSON.parse(read(f)); } catch { continue; }
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["react-native"]) { platforms.add("react-native"); ev(f, "package.json depends on react-native"); }
      else if (deps.electron) { shell = "electron"; ev(f, "package.json depends on electron"); }
      const scripts = pkg.scripts || {};
      if (!deps["react-native"] && (Object.keys(scripts).some((k) => /^(dev|start|serve|preview)$/.test(k)) || Object.keys(deps).some((d) => /^(react|vue|svelte|next|vite|@angular\/core|solid-js|astro)$/.test(d)))) webEntry.push(f);
    } else if (base === "AndroidManifest.xml") {
      platforms.add("android"); ev(f, "AndroidManifest.xml");
    } else if (/^build\.gradle(\.kts)?$/.test(base)) {
      if (/com\.android\.(application|library)|apply plugin:\s*['"]com\.android|id\(\s*["']com\.android/.test(read(f))) { platforms.add("android"); ev(f, "gradle file with the android plugin"); }
    } else if (base === "Package.swift") {
      const t = read(f);
      if (/\.iOS\s*\(/.test(t)) { platforms.add("ios"); ev(f, "Package.swift with an iOS platform"); }
      else if (/\.macOS\s*\(/.test(t)) desktop.push([f, "Package.swift with a macOS platform"]);
    } else if (base === "project.pbxproj") {
      const t = read(f);
      if (/SDKROOT = iphoneos|IPHONEOS_DEPLOYMENT_TARGET/.test(t)) { platforms.add("ios"); ev(dirname(f), "Xcode project for iOS"); }
      else if (/SDKROOT = macosx|MACOSX_DEPLOYMENT_TARGET/.test(t)) desktop.push([dirname(f), "Xcode project for macOS"]);
    } else if (base === "tauri.conf.json" || base === "tauri.conf.json5") {
      shell = "tauri"; ev(f, "tauri configuration");
    } else if (/\.csproj$/.test(base) && /UseWPF|UseWinForms|Avalonia/.test(read(f))) desktop.push([f, "desktop UI project"]);
    else if (/\.pro$/.test(base) || base === "CMakeLists.txt") { if (/find_package\(\s*Qt|QT\s*\+=/.test(read(f))) desktop.push([f, "Qt project"]); }
    else if (base === "Cargo.toml" && /^\s*(egui|eframe|iced|slint)\b/m.test(read(f))) desktop.push([f, "Rust desktop UI crate"]);
    else if (base === "index.html" && !/^(android|ios)\//.test(f)) webEntry.push(f);
  }
  // Xcode project directories carry their own project.pbxproj; a bare *.xcodeproj dir without it still counts.
  for (const d of dirs) if (/\.xcodeproj$/.test(d) && !platforms.has("ios") && !desktop.some(([p]) => p === d) && !files.includes(`${d}/project.pbxproj`)) { platforms.add("ios"); ev(d, "Xcode project"); }
  for (const [p, why] of desktop) ev(p, why);

  const mobile = ["flutter", "react-native", "android", "ios"].filter((p) => platforms.has(p));
  const plat = (list) => (list.includes("flutter") ? "flutter" : list.includes("react-native") ? "react-native" : list.length === 1 ? list[0] : "multi");
  const web = webEntry.filter((f) => !(platforms.has("flutter") && /^(web|android|ios)\//.test(f)));
  let out;
  if (shell) {
    out = web.length ? { type: "web", via: "browser", shell, platform: null } : { type: "desktop", shell, platform: shell };
  } else if (mobile.length) {
    out = { type: "native-mobile", platform: plat(mobile), platforms: mobile };
    if (web.length && !platforms.has("flutter") && !platforms.has("react-native")) out.also = ["web"];
  } else if (desktop.length) out = { type: "desktop", platform: "desktop" };
  else out = { type: "web", platform: null, note: web.length ? "web entry found" : "no native evidence; web is the default" };
  const keep = out.type === "web" && !shell ? web.map((f) => ({ path: f, why: "web entry" })) : out.type === "web" ? [...evidence, ...web.map((f) => ({ path: f, why: "web entry" }))] : evidence;
  return { schema: TARGET_SCHEMA, ...out, evidence: keep.slice(0, 30) };
}

// --- project tools and their command ----------------------------------------------------------------------
const FORBID = /(^|[\s=])(record\w*|update\w*|--update-goldens|--record|-u|install|add|brew|apt(-get)?|pip3?|gem|pod)(\s|$)|record(Paparazzi|Roborazzi)|updateGolden/i;
const TOOLS = [
  { name: "flutter-integration-test", platform: "flutter", device: true, has: (c) => /^\s*integration_test:/m.test(c.pubspec), why: "pubspec.yaml lists integration_test", cmd: /flutter\s+test\s+integration_test[^\n`"]*/, dflt: "flutter test integration_test" },
  { name: "flutter-golden", platform: "flutter", device: false, has: (c) => /golden_toolkit|alchemist/.test(c.pubspec) || c.dart.some((t) => /matchesGoldenFile/.test(t)), why: "golden dependency or matchesGoldenFile in test/", cmd: /flutter\s+test(?!\s+integration_test)[^\n`"]*/, dflt: "flutter test" },
  { name: "maestro", platform: "any", device: true, has: (c) => c.dirs.some((d) => /(^|\/)\.?maestro$/.test(d)), why: "a maestro flow folder", cmd: /maestro\s+test[^\n`"]*/, dflt: "maestro test .maestro" },
  { name: "detox", platform: "react-native", device: true, has: (c) => /"detox"/.test(c.packageJson) || c.files.some((f) => /(^|\/)\.detoxrc(\.\w+)?$/.test(f)), why: "detox dependency or .detoxrc", cmd: /detox\s+test[^\n`"]*/, dflt: "npx --no-install detox test" },
  { name: "xcuitest", platform: "ios", device: true, has: (c) => /com\.apple\.product-type\.bundle\.ui-testing/.test(c.pbxproj), why: "an Xcode UI testing target", cmd: /xcodebuild[^\n`"]*\btest\b[^\n`"]*/, dflt: null },
  { name: "espresso", platform: "android", device: true, has: (c) => /androidx\.test\.espresso/.test(c.gradle), why: "gradle lists androidx.test.espresso", cmd: /(?:\.\/)?gradlew[^\n`"]*connected\w*AndroidTest[^\n`"]*/, dflt: "./gradlew connectedDebugAndroidTest", gradle: true },
  { name: "compose-screenshot", platform: "android", device: false, has: (c) => /com\.android\.compose\.screenshot|screenshotTest/.test(c.gradle), why: "gradle uses the compose screenshot plugin", cmd: /(?:\.\/)?gradlew[^\n`"]*validate\w*ScreenshotTest[^\n`"]*/, dflt: "./gradlew validateDebugScreenshotTest", gradle: true },
  { name: "paparazzi", platform: "android", device: false, has: (c) => /app\.cash\.paparazzi/.test(c.gradle), why: "gradle applies the paparazzi plugin", cmd: /(?:\.\/)?gradlew[^\n`"]*verifyPaparazzi\w*[^\n`"]*/, dflt: "./gradlew verifyPaparazziDebug", gradle: true },
  { name: "roborazzi", platform: "android", device: false, has: (c) => /io\.github\.takahirom\.roborazzi/.test(c.gradle), why: "gradle applies the roborazzi plugin", cmd: /(?:\.\/)?gradlew[^\n`"]*verifyRoborazzi\w*[^\n`"]*/, dflt: "./gradlew verifyRoborazziDebug", gradle: true },
];

function projectContext(repo) {
  const all = walk(repo).filter((f) => !inSkipped(f.rel));
  const files = all.filter((f) => !f.dir).map((f) => f.rel);
  const dirs = all.filter((f) => f.dir).map((f) => f.rel);
  const cat = (re) => files.filter((f) => re.test(basename(f))).map((f) => readCap(join(repo, f))).join("\n");
  const pkgRel = files.find((f) => f === "package.json");
  let scripts = {};
  try { scripts = JSON.parse(readCap(join(repo, "package.json"))).scripts || {}; } catch { /* none */ }
  const docs = files.filter((f) => /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|bitrise\.yml|codemagic\.yaml|fastlane\/Fastfile|Makefile)$/.test(f) || /^README[^/]*$/i.test(f));
  return {
    files, dirs, scripts,
    pubspec: cat(/^pubspec\.yaml$/),
    packageJson: pkgRel ? readCap(join(repo, pkgRel)) : "",
    gradle: cat(/^(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|libs\.versions\.toml)$/),
    pbxproj: cat(/^project\.pbxproj$/),
    dart: files.filter((f) => /^test\/.+\.dart$|^integration_test\/.+\.dart$/.test(f)).slice(0, 80).map((f) => readCap(join(repo, f), 60_000)),
    docs: docs.map((f) => ({ file: f, text: readCap(join(repo, f)) })),
    gradlew: files.includes("gradlew"),
  };
}

function discoverCommand(tool, c) {
  for (const [name, value] of Object.entries(c.scripts)) {
    const m = tool.cmd.exec(String(value));
    if (m && !FORBID.test(m[0])) return { command: `npm run ${name}`, source: `package.json scripts.${name}` };
  }
  for (const d of c.docs) {
    for (const line of d.text.split(/\r?\n/)) {
      const m = tool.cmd.exec(line);
      if (m && !FORBID.test(m[0])) return { command: m[0].replace(/[\\'"\s]+$/, "").trim(), source: d.file };
    }
  }
  if (tool.dflt && (!tool.gradle || c.gradlew)) return { command: tool.dflt, source: "tool default (no project command found)" };
  return { command: null, source: null };
}

export function detectTools(repo) {
  const c = projectContext(repo);
  return TOOLS.filter((t) => t.has(c)).map((t) => ({ name: t.name, platform: t.platform, needs_device: t.device, evidence: t.why, ...discoverCommand(t, c) }));
}

export function suggestion(target) {
  const p = target.platform;
  const what = p === "flutter" ? "integration tests or golden tests (flutter test)"
    : p === "react-native" ? "a Maestro or Detox flow that dumps the view hierarchy"
    : p === "ios" ? "an XCUITest that attaches screenshots and the accessibility hierarchy"
    : p === "android" ? "Espresso, Paparazzi, Roborazzi or Compose screenshot tests, or a uiautomator dump step"
    : "a UI test tool that writes screenshots and an element tree (JSON or XML)";
  return `adding ${what} would let visual-proof measure this app; nothing was added`;
}

function deviceCheck() {
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 }); return r.error || r.status !== 0 ? null : r.stdout; };
  const adb = run("adb", ["devices"]);
  const sim = run("xcrun", ["simctl", "list", "devices", "booted"]);
  return { android: adb ? adb.split("\n").slice(1).filter((l) => /\tdevice\b/.test(l)).length : 0, ios: sim ? (sim.match(/\(Booted\)/g) || []).length : 0 };
}

export function detectAll({ repo, run = false, timeout = 120_000, exec = spawnSync, devices = deviceCheck } = {}) {
  const target = detectTarget(repo);
  const base = { schema: "visual-proof.native-detect/1", target };
  if (target.type === "web") return { ...base, tools: [], result: "NOT_NATIVE", reason: "web target: use measure.mjs --detect" };
  const tools = detectTools(repo);
  const sug = suggestion(target);
  if (!tools.length) return { ...base, tools, run: null, result: "UNSUPPORTED", reason: "no UI or screenshot test tool found in the project's config or dependency files", suggestion: sug };
  const usable = tools.find((t) => t.command) || null;
  if (!usable) return { ...base, tools, run: null, result: "UNSUPPORTED", reason: "a test tool is present but no run command could be discovered in CI config, scripts or README", suggestion: sug };
  if (!run) return { ...base, tools, run: null, result: "DISCOVERED", reason: "command discovered, not run (pass --run to prove it once)", chosen: usable.name };
  const dev = usable.needs_device ? devices() : null;
  if (dev && !dev.android && !dev.ios) return { ...base, tools, run: null, devices: dev, result: "UNSUPPORTED", reason: `${usable.name} needs a simulator, emulator or device and none is booted or connected`, suggestion: sug, chosen: usable.name };
  const ms = Math.max(30_000, Number(timeout) || 0);
  const t0 = Date.now();
  const r = exec(usable.command, { cwd: repo, shell: true, encoding: "utf8", timeout: ms, maxBuffer: 20_000_000 });
  const tail = `${r.stdout || ""}${r.stderr || ""}`.split(/\r?\n/).filter(Boolean).slice(-8).join("\n");
  const runRec = { command: usable.command, exit: r.status ?? (r.error ? -1 : null), timed_out: r.error?.code === "ETIMEDOUT", duration_ms: Date.now() - t0, tail };
  if (runRec.exit !== 0) return { ...base, tools, run: runRec, ...(dev ? { devices: dev } : {}), result: "UNSUPPORTED", reason: `the project's command did not run clean (exit ${runRec.exit}${runRec.timed_out ? ", timeout" : ""}): not proven`, suggestion: sug, chosen: usable.name };
  return { ...base, tools, run: runRec, ...(dev ? { devices: dev } : {}), result: "PROVEN", reason: "the project's own command ran once and exited 0", chosen: usable.name };
}

// --- parsers ---------------------------------------------------------------------------------------------
const unesc = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Android uiautomator XML dump -> normalized document. Bounds are pixels; with `density` (dpi / 160) they become dp.
export function parseUiautomator(xml, { density, device = "android", os = "android", font_scale, theme } = {}) {
  const roots = [];
  const stack = [];
  const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = tag.exec(xml))) {
    if (m[1]) { stack.pop(); continue; }
    const a = {};
    for (const at of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) a[at[1]] = unesc(at[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds || "");
    const node = { a, b: b ? b.slice(1).map(Number) : null, kids: [] };
    (stack.length ? stack[stack.length - 1].kids : roots).push(node);
    if (!m[3]) stack.push(node);
  }
  const labelOf = (n) => {
    const own = n.a["content-desc"] || n.a.text;
    if (own) return { label: own, source: n.a["content-desc"] ? "content-desc" : "text" };
    for (const k of n.kids) { const r = labelOf(k); if (r.label) return { ...r, source: `descendant ${r.source}` }; }
    return { label: "", source: null };
  };
  const px = density > 0 ? (v) => Math.round((v / density) * 100) / 100 : (v) => v;
  const unit = density > 0 ? "dp" : "px";
  const elements = [];
  let maxX = 0, maxY = 0;
  const visit = (n) => {
    if (n.b) {
      const [l, t, r, bt] = n.b;
      maxX = Math.max(maxX, r); maxY = Math.max(maxY, bt);
      const interactive = n.a.clickable === "true" || n.a.checkable === "true" || n.a["long-clickable"] === "true";
      const lab = interactive ? labelOf(n) : { label: n.a["content-desc"] || n.a.text || "", source: null };
      elements.push({ id: n.a["resource-id"] || n.a.class || "node", role: (n.a.class || "").split(".").pop() || "node", label: lab.label, ...(lab.source ? { label_source: lab.source } : {}), interactive,
        bounds: { x: px(l), y: px(t), width: px(r - l), height: px(bt - t) }, unit });
    }
    n.kids.forEach(visit);
  };
  roots.forEach(visit);
  return { schema: NATIVE_SCHEMA, platform: "android", os, device: { name: device, width: px(maxX), height: px(maxY), unit, ...(font_scale ? { font_scale } : {}), ...(theme ? { theme } : {}) }, elements };
}

export function readNative(file, opt = {}) {
  const text = readFileSync(file, "utf8");
  if (extname(file).toLowerCase() === ".xml" || /^\s*<\?xml|^\s*<hierarchy/.test(text)) return parseUiautomator(text, opt);
  const doc = JSON.parse(text);
  const err = validateNative(doc);
  if (err) throw new Error(`${file}: ${err}`);
  return doc;
}

export function validateNative(d) {
  if (!d || typeof d !== "object" || d.schema !== NATIVE_SCHEMA) return `schema must be "${NATIVE_SCHEMA}"`;
  if (!Array.isArray(d.elements)) return "elements must be a list";
  for (const [i, e] of d.elements.entries()) {
    if (!e || typeof e !== "object" || typeof e.interactive !== "boolean") return `elements[${i}]: needs interactive true|false`;
    if (e.bounds !== undefined && !["x", "y", "width", "height"].every((k) => Number.isFinite(e.bounds?.[k]))) return `elements[${i}]: bounds needs numeric x, y, width, height`;
    if (e.bounds !== undefined && !["dp", "pt", "px"].includes(e.unit)) return `elements[${i}]: unit must be dp, pt or px`;
  }
  return null;
}

// --- measurements ----------------------------------------------------------------------------------------
const MIN_TARGET = { ios: { min: 44, unit: "pt" }, android: { min: 48, unit: "dp" } };
const sel = (e) => `${e.id}${e.label ? ` "${String(e.label).slice(0, 30)}"` : ""}`;

// Returns {items, not_measured}; whatever the output cannot give is in not_measured, never an item.
export function measureNative(doc) {
  const items = [], nm = [];
  const os = doc.os || (doc.platform === "ios" || doc.platform === "android" ? doc.platform : null);
  const inter = doc.elements.filter((e) => e.interactive);
  if (!inter.length) {
    nm.push({ check: "native_labels", reason: "no interactive element in the tool output" }, { check: "native_touch_target", reason: "no interactive element in the tool output" });
  } else {
    const bad = inter.filter((e) => !String(e.label ?? "").trim());
    items.push({ check: "native_labels", selector: bad.length ? sel(bad[0]) : "interactive elements", value: bad.length, threshold: "== 0", status: bad.length ? "fail" : "pass", ...(bad.length ? { note: `${bad.length} of ${inter.length} interactive elements have no accessibility label (accessibilityLabel, contentDescription or semantics label)` } : {}) });
    const rule = MIN_TARGET[os];
    const sized = inter.filter((e) => e.bounds);
    if (!rule) nm.push({ check: "native_touch_target", reason: "operating system unknown (ios needs 44pt, android 48dp)" });
    else if (!sized.length || sized.some((e) => e.unit !== rule.unit)) nm.push({ check: "native_touch_target", reason: sized.length ? `sizes are not in ${rule.unit} (pass the screen density / scale so pixels convert)` : "the output carries no bounds" });
    else {
      const small = sized.map((e) => ({ e, v: Math.min(e.bounds.width, e.bounds.height) })).sort((a, b) => a.v - b.v)[0];
      items.push({ check: "native_touch_target", selector: sel(small.e), value: small.v, threshold: `>= ${rule.min}`, status: small.v >= rule.min ? "pass" : "fail", platform: os, unit: rule.unit });
    }
  }
  const scale = doc.device?.font_scale;
  if (scale >= 1.3) {
    const flagged = doc.elements.filter((e) => typeof e.text_clipped === "boolean");
    if (flagged.length) { const clipped = flagged.filter((e) => e.text_clipped); items.push({ check: "native_large_text", selector: clipped.length ? sel(clipped[0]) : "text elements", value: clipped.length, threshold: "== 0", status: clipped.length ? "fail" : "pass", note: `font scale ${scale}` }); }
    else nm.push({ check: "native_large_text", reason: "the output has font scale but no text_clipped flag per element" });
  } else nm.push({ check: "native_large_text", reason: scale ? `font scale ${scale} is below 1.3` : "the output carries no font scale" });
  if (doc.device?.theme === "dark") {
    const withC = doc.elements.filter((e) => Number.isFinite(e.contrast));
    if (withC.length) { const low = withC.filter((e) => e.contrast < 4.5); items.push({ check: "native_dark_theme", selector: low.length ? sel(low[0]) : "text elements", value: low.length, threshold: "== 0", status: low.length ? "fail" : "pass", note: "dark theme text contrast below 4.5" }); }
    else nm.push({ check: "native_dark_theme", reason: "dark theme output carries no contrast per element" });
  } else nm.push({ check: "native_dark_theme", reason: "the output is not a dark theme capture" });
  return { items, not_measured: nm };
}

// --- report ----------------------------------------------------------------------------------------------
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// config: { class, tool:{name,version,detected_by} | {kind:"none",reason}, target:{type,platform,evidence[]}, devices:[{name,width,height,os?}],
//   screens:[{id,path,states:[]}], captures:[{screen,state,device,screenshot?,output?,density?,font_scale?,theme?}], criteria:[{id,required,checks[]}], suggestion }
export function buildReport(config, outDir, base = ".") {
  const target = { type: config.target?.type, ...(config.target?.platform ? { platform: config.target.platform } : {}), evidence: config.target?.evidence || [], not_measured: [] };
  const report = { schema: SCHEMA, class: config.class, result: "PASS", target };
  if (config.tool?.kind === "none") {
    Object.assign(report, { tool: { kind: "none", name: null }, unsupported_reason: config.tool.reason, suggestion: config.suggestion || suggestion(target), viewports: config.devices || [], screens: config.screens || [], interactions: [], cells: [], measured: [], not_measured: [], judged: [], criteria: [], result: "UNSUPPORTED" });
    return report;
  }
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  mkdirSync(join(outDir, "evidence"), { recursive: true });
  const copy = (p, sub, tag) => { const src = resolve(base, p); if (!existsSync(src) || !statSync(src).isFile()) return null; const rel = `${sub}/${tag}${extname(src)}`; copyFileSync(src, join(outDir, rel)); return { path: rel, sha256: sha(join(outDir, rel)) }; };
  Object.assign(report, { tool: { kind: "native-tool", name: config.tool.name, ...(config.tool.version ? { version: config.tool.version } : {}), detected_by: config.tool.detected_by || "native.mjs --detect" },
    viewports: config.devices, screens: config.screens, interactions: [], cells: [], measured: [], not_measured: [], judged: [], a11y_scanner: { status: "not_available" },
    regression: { status: "not_available", reason: "native regression runs are the project's own command; no baseline is created" }, criteria: [] });
  const devs = new Map(config.devices.map((d) => [d.name, d]));
  let n = 0;
  const add = (cell, it, ev) => report.measured.push({ id: `M-${++n}`, check: it.check, ...cell, selector: it.selector, value: it.value, threshold: it.threshold, status: it.status, ...(it.platform ? { platform: it.platform } : {}), ...(it.unit ? { unit: it.unit } : {}), ...(it.note ? { note: it.note } : {}), ...(ev ? { evidence: ev } : {}) });
  const seen = { large: [], dark: [] };
  for (const c of requiredCells(report)) {
    const cap = (config.captures || []).find((x) => x.screen === c.screen && x.state === c.state && x.device === c.viewport);
    const tag = `${c.screen}-${c.state}-${c.viewport}`.replace(/[^\w.-]+/g, "_");
    const shot = cap?.screenshot ? copy(cap.screenshot, "screenshots", tag) : null;
    const cell = { screen: c.screen, state: c.state, viewport: c.viewport };
    report.cells.push({ ...cell, ...(shot ? { screenshot: shot } : {}) });
    add(cell, { check: "native_state_present", selector: `${c.screen}/${c.state}`, value: shot ? 1 : 0, threshold: "== 1", status: shot ? "pass" : "fail", note: shot ? undefined : "no screenshot for this spec state" }, shot || undefined);
    let doc = null, outEv = null, why = "no structured tool output for this state";
    if (cap?.output && existsSync(resolve(base, cap.output))) {
      try {
        doc = readNative(resolve(base, cap.output), { density: cap.density, device: c.viewport, os: cap.os || devs.get(c.viewport)?.os || "android", font_scale: cap.font_scale, theme: cap.theme });
        if (!doc.os && devs.get(c.viewport)?.os) doc.os = devs.get(c.viewport).os;
        if (cap.font_scale) doc.device = { ...doc.device, font_scale: cap.font_scale };
        if (cap.theme) doc.device = { ...doc.device, theme: cap.theme };
        outEv = copy(cap.output, "evidence", tag);
      } catch (e) { why = `tool output not parsed: ${e.message}`; doc = null; }
    }
    if (!doc) { for (const check of ["native_labels", "native_touch_target"]) report.not_measured.push({ scope: "cell", check, ...cell, reason: why }); continue; }
    const r = measureNative(doc);
    for (const it of r.items) { if (it.check === "native_large_text") seen.large.push(it); else if (it.check === "native_dark_theme") seen.dark.push(it); add(cell, it, outEv); }
    for (const x of r.not_measured) {
      if (x.check === "native_large_text" || x.check === "native_dark_theme") continue;
      report.not_measured.push({ scope: "cell", ...x, ...cell });
    }
  }
  if (!report.measured.some((m) => m.check === "native_large_text")) target.not_measured.push({ check: "native_large_text", reason: "no capture carried a font scale >= 1.3 with a clipped-text flag" });
  if (!report.measured.some((m) => m.check === "native_dark_theme")) target.not_measured.push({ check: "native_dark_theme", reason: "no dark theme capture with per-element contrast" });
  for (const c of config.criteria || []) {
    const items = report.measured.filter((m) => (c.checks || []).includes(m.check));
    for (const m of items) (m.criteria ||= []).push(c.id);
    report.criteria.push({ id: c.id, required: !!c.required, status: items.some((m) => m.status === "fail") ? "failed" : items.some((m) => m.status === "pass") ? "proven" : "unproven" });
  }
  const v = validateReport(report, { root: outDir });
  report.result = v.computed;
  return report;
}

// --- CLI -------------------------------------------------------------------------------------------------
const arg = (a, k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };

export function main(argv) {
  const usage = "usage: native.mjs --detect --repo DIR [--run] [--timeout MS] [--json] | --normalize FILE [--density N] [--os android|ios] | --check FILE [--density N] [--os android|ios] | --build native.json --out DIR";
  try {
    if (argv.includes("--detect")) {
      const repo = resolve(arg(argv, "--repo") || ".");
      if (!existsSync(repo)) { console.error(`no such directory: ${repo}`); return 2; }
      const r = detectAll({ repo, run: argv.includes("--run"), timeout: arg(argv, "--timeout") });
      console.log(JSON.stringify(r, null, 2));
      return r.result === "UNSUPPORTED" ? 1 : 0;
    }
    const opt = { density: arg(argv, "--density") ? Number(arg(argv, "--density")) : undefined, os: arg(argv, "--os") || "android", device: arg(argv, "--device") || "device" };
    if (argv.includes("--normalize")) { console.log(JSON.stringify(readNative(arg(argv, "--normalize"), opt), null, 2)); return 0; }
    if (argv.includes("--check")) {
      const doc = readNative(arg(argv, "--check"), opt);
      if (opt.os && !doc.os) doc.os = opt.os;
      const r = measureNative(doc);
      console.log(JSON.stringify(r, null, 2));
      return r.items.some((i) => i.status === "fail") ? 1 : 0;
    }
    if (argv.includes("--build")) {
      const cfgPath = resolve(arg(argv, "--build")), out = arg(argv, "--out");
      if (!out) { console.error(usage); return 2; }
      mkdirSync(resolve(out), { recursive: true });
      const report = buildReport(JSON.parse(readFileSync(cfgPath, "utf8")), resolve(out), dirname(cfgPath));
      writeFileSync(join(resolve(out), "report.json"), JSON.stringify(report, null, 2) + "\n");
      console.log(`report written: ${join(out, "report.json")} (result ${report.result})`);
      return 0;
    }
  } catch (e) { console.error(`error: ${e.message}`); return 2; }
  console.error(usage);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
