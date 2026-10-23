// visual-proof design group (A170): pure evaluators, ledger, source lint and the report validator need no browser;
// one browser test measures the fixture sites and SKIPS when measure.mjs --detect finds no browser.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReport, CORE, loadUxRules } from "../../skills/visual-proof/scripts/validate-visual.mjs";
import { assemble, detect } from "../../skills/visual-proof/scripts/measure.mjs";
import { evaluateStatic, untranslatedBlocks, vacuumOf, designHolds, designThresholdError, CRITIQUE_IDS } from "../../skills/visual-proof/scripts/design-audit.mjs";
import { decideMotionCount, decideReducedMotion, decideNoScript, decideSceneStarted, sceneRange } from "../../skills/visual-proof/scripts/motion-audit.mjs";
import { parseLedger, ledgerItems } from "../../skills/visual-proof/scripts/ledger.mjs";
import { lintText, applyJustifications, parseJustifications, lintProject, validateLint } from "../../skills/visual-proof/scripts/lint-source.mjs";

const FIX = fileURLToPath(new URL("../../fixtures/visual-proof-design/", import.meta.url));
const MEASURE = fileURLToPath(new URL("../../skills/visual-proof/scripts/measure.mjs", import.meta.url));
const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "vp-design-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const status = (items, check) => items.filter((i) => i.check === check).map((i) => i.status);

// ---- facts a probe would report ------------------------------------------------------------------------------
const good = (over = {}) => ({
  headings: [{ selector: "h1", lines: 1 }, { selector: "h2", lines: 2 }], headingSizes: [64, 40], largestHeading: "h1", bodySize: 16,
  paragraphs: [{ selector: "p", lines: 3, chars: 180 }], vh: 900, vw: 1440, lang: "en",
  fonts: { families: [{ family: "Display", kind: "web", count: 4 }], heading: { kind: "web", family: "Display" }, body: { kind: "web", family: "Display" } },
  edge: { left: 48, right: 48 }, edgeText: { selector: "h1", distance: 48, side: "left" },
  blocks: [{ top: 0, bottom: 500, selector: "header" }, { top: 560, bottom: 1100, selector: "section" }],
  sections: [{ selector: "section", height: 540, titled: true }], hero: { h1: true, action: true, visual: true, visualKind: "svg" },
  surfaces: [{ selector: "::selection", surface: "selection", problems: 0, note: "themed" }], textBlocks: [],
  ux: { images: { total: 1, bad: [] }, fields: { total: 0, bad: [] }, controls: { total: 1, bad: [] }, viewportMeta: "width=device-width, initial-scale=1" }, ...over });
const bad = () => good({
  hero: { h1: true, action: false, visual: false }, sections: [{ selector: "section:nth-of-type(1)", height: 420, titled: false }],
  fonts: { families: [{ family: "system-ui", kind: "system", count: 3 }], heading: { kind: "system", family: "system-ui" }, body: { kind: "system", family: "system-ui" } },
  lang: "tr", textBlocks: [{ selector: "p", text: "Bu sayfa Türkçe olmalı ama burada the quick brown fox jumps over the lazy dog and this is what you will find." }],
});
const ctx = (over = {}) => ({ mode: "persuade", viewport: "wide", language: { lang: "tr", allow_text: [] }, ...over });

test("auditor: an empty hero, an untitled section, a system font and untranslated text fail; a good page passes", () => {
  const b = evaluateStatic(bad(), ctx());
  assert.deepEqual(status(b, "design_empty_hero"), ["fail"]);
  assert.deepEqual(status(b, "design_untitled_section"), ["fail"]);
  assert.deepEqual(status(b, "design_fonts_loaded"), ["fail"]);
  assert.deepEqual(status(b, "design_untranslated"), ["fail"]);
  const g = evaluateStatic(good(), ctx({ language: null }));
  assert.deepEqual(g.filter((i) => i.status === "fail"), []);
  assert.deepEqual(status(evaluateStatic(good(), ctx({ mode: "operate", language: null })), "design_empty_hero"), ["not_applicable"]);
});

test("auditor helpers: untranslated blocks, vacuum, thresholds", () => {
  assert.equal(untranslatedBlocks([{ selector: "p", text: "Bu sayfa the quick brown fox" }], ["the quick brown fox"]).length, 0);
  assert.equal(untranslatedBlocks([{ selector: "p", text: "Merhaba dünya, bugün hava çok güzel" }]).length, 0);
  assert.equal(vacuumOf([{ top: 0, bottom: 100, selector: "a" }, { top: 1000, bottom: 1100, selector: "b" }], 800).ratio, 1.13);
  assert.equal(designHolds(2.5, ">= 3"), false);
  assert.match(designThresholdError("design_heading_lines", "persuade", "wide", "<= 5"), /weaker/);
  assert.equal(designThresholdError("design_heading_lines", "persuade", "wide", "<= 1"), null);
});

test("motion decisions: counts, reduced motion keeps content, no-script, scene start", () => {
  assert.deepEqual(decideMotionCount({ load: 4, scroll: 1 }).map((d) => d.status), ["pass", "fail"]);
  const shown = [{ k: "a" }, { k: "b" }];
  assert.equal(decideReducedMotion({ shown, shownReduced: shown, running: [{ props: ["opacity"] }] }).status, "pass");
  const hid = decideReducedMotion({ shown, shownReduced: [{ k: "a" }], running: [{ props: ["transform"] }, { props: ["transform"], essential: true }] });
  assert.equal(hid.status, "fail"); assert.equal(hid.running.length, 1);
  assert.equal(decideNoScript({ shown, shownNoScript: [] }).value, 2);
  const range = sceneRange({ top: 1000, height: 2000, vh: 800, max: 5000 });
  assert.equal(decideSceneStarted({ sig: "a" }, { sig: "a" }, range).started, false);
  assert.equal(decideSceneStarted({ sig: "a" }, { sig: "b" }, range).started, true);
});

const LEDGER = "# Images\n\n## Images\n\n| file | source_url | license | credit | used_in |\n|---|---|---|---|---|\n| photo.png | https://example.org/p | CC0 | Example Archive | index.html |\n| half.png | https://example.org/h | CC0 | | index.html |\n\n## Fonts\n\n| file | family | license | source | used_in |\n|---|---|---|---|---|\n";
test("ledger: a listed image passes; an unlisted image and a row without credit are blocking", () => {
  const rows = parseLedger(LEDGER);
  assert.equal(rows.images.length, 2); assert.equal(rows.images[1].valid, false);
  const img = (src) => ({ src, selector: "img", kind: "img" });
  const ok = ledgerItems({ images: [img("http://x/site/photo.png")], ledgerText: LEDGER, screen: "home", viewport: "wide" });
  assert.deepEqual(ok.items.map((i) => i.status), ["pass"]);
  const no = ledgerItems({ images: [img("http://x/site/other.png"), img("http://x/site/half.png")], ledgerText: LEDGER, screen: "home", viewport: "wide" });
  assert.deepEqual(no.items.map((i) => i.status), ["fail", "fail"]);
  assert.deepEqual(no.images.map((i) => i.in_ledger), [false, false]);
  assert.equal(ledgerItems({ images: [img("a.png")], ledgerText: null, screen: "home", viewport: "wide" }).items[0].status, "fail");
});

const MONO = '<style>.eyebrow{font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:.1em}\n.box{border:1px solid #ccc;padding:12px}\n.panel{border:1px solid #ddd;padding:12px}\n.tile{border:1px solid #ddd;padding:12px}</style>';
test("lint: monospace labels and hairline boxes are blocking; a justification drops them to info; validateLint checks shape", () => {
  const raw = lintText({ path: "a.html", text: MONO });
  const ids = new Set(raw.map((f) => f.id));
  assert.ok(ids.has("mono-labels") && ids.has("hairline-newspaper"), [...ids].join());
  assert.ok(applyJustifications(raw, {}).every((f) => f.severity === "blocking"));
  const md = "# D\n\n## Pattern justifications\n- mono-labels: file names are the product here\n- hairline-newspaper: the brand is a printed ledger\n- eyebrow-label: section kickers carry the product's own vocabulary\n";
  const just = applyJustifications(raw, parseJustifications(md));
  assert.ok(just.every((f) => f.severity === "info" && f.justified && f.reason));
  const lint = { schema: "visual-proof.lint/1", registry_date: "2026-10-23", findings: just, judged_only: [], design_md: null };
  assert.equal(validateLint(lint).valid, true);
  const inconsistent = { ...lint, findings: [{ ...just[0], severity: "blocking" }] };
  assert.equal(validateLint(inconsistent).valid, false);
  assert.equal(validateLint({ ...lint, findings: [{ ...just[0], id: "made-up" }] }).valid, false);
});

// ---- validator on assembled reports -----------------------------------------------------------------------------
const OK = { viewport_overflow: [0, "<= 0"], horizontal_scroll: [360, "<= 360"], hidden_interactive: [5, "> 1"], overlapping_interactive: [0, "== 0"],
  contrast: [7.1, ">= 4.5"], touch_target: [40, ">= 24"], focus_order: [0, "== 0"], focus_visible: [1, "== 1"] };
const VPS = [{ name: "phone", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1280, height: 800 }];
function build(cls, facts) {
  const dir = mktmp();
  mkdirSync(join(dir, "screenshots"));
  const png = (n) => { writeFileSync(join(dir, `screenshots/${n}.png`), `png ${n}`); return `screenshots/${n}.png`; };
  const config = { class: cls, base_url: "file:///app/", viewports: VPS, screens: [{ id: "home", path: "index.html", states: [{ name: "default", path: "index.html", ready: "main" }] }], criteria: [],
    design: { visitor_mode: "operate", screens: ["index.html"] } };
  const cells = VPS.map((v) => ({ screen: "home", state: "default", viewport: v.name, screenshot: png(v.name), rendered: true, not_measured: [],
    items: CORE.filter((c) => c !== "state_rendered").map((check) => ({ check, selector: check === "horizontal_scroll" ? "html" : "body", value: OK[check][0], threshold: OK[check][1], status: "pass" })) }));
  const design = { pages: [{ path: "index.html", viewports: ["wide", "tablet", "phone390"].map((viewport) => ({ viewport, screenshot: png(`d-${viewport}`), facts: { ...facts, vw: viewport === "phone390" ? 390 : 1440 } })) }] };
  const report = assemble({ tool: { kind: "headless-browser", name: "chromium" }, config, cells, network: { interception: "on", blocked: [] }, design }, dir);
  return { dir, report, png, check: (r = report, opt = {}) => validateReport(r, { root: dir, ...opt }) };
}

test("validator: a design block of a healthy page is valid; a weaker threshold, a failed item and a blocking lint finding are not", () => {
  const { report, check } = build("STANDARD", good());
  assert.equal(report.design.status, "run");
  const v = check();
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.equal(v.computed, "PASS");
  const weak = structuredClone(report);
  weak.design.items.find((i) => i.check === "design_heading_lines" && i.status === "pass").threshold = "<= 5";
  assert.match(check(weak).errors.join("\n"), /weaker/);
  const lint = { schema: "visual-proof.lint/1", registry_date: "2026-10-23", judged_only: [], design_md: null,
    findings: [{ id: "mono-labels", file: "a.html", line: 1, excerpt: "x", justified: false, severity: "blocking" }] };
  const l = check({ ...report, result: "FAIL" }, { lint });
  assert.equal(l.valid, true, l.errors.join("\n"));
  assert.equal(l.computed, "FAIL");
  const f = build("STANDARD", good({ hero: { h1: true, action: false, visual: false } }));
  const fv = f.check();
  assert.equal(fv.valid, true, fv.errors.join("\n")); // operate: the hero check does not apply
  const s = build("STANDARD", good({ sections: [{ selector: "section", height: 420, titled: false }] }));
  assert.equal(s.report.result, "FAIL");
  assert.equal(s.check().computed, "FAIL");
});

test("validator: critique and ux_review need reasons and have no numeric score (valid and invalid)", () => {
  const { report, check } = build("COMPLEX", good());
  assert.ok(check(report).errors.some((e) => /needs critique/.test(e)), "COMPLEX with a design group needs the critique");
  const sample = { path: report.cells[0].screenshot.path, sha256: report.cells[0].screenshot.sha256 };
  const critique = CRITIQUE_IDS.map((id) => (id === "one_live_thing" ? { id, status: "not_applicable", reason: "operate surface" } : { id, status: "ok", reason: "looked at the screenshot", screenshot: sample }));
  const ux_review = loadUxRules().filter((r) => r.measure === "judged" && r.severity === "high").map((r) => ({ rule: r.id, status: "ok", reason: "reviewed on the screenshot", screenshot: sample }));
  const c0 = report.cells[0];
  const judged = ["hierarchy", "density", "consistency", "typography"].map((aspect, i) => ({ id: `J-${i + 1}`, aspect, screen: c0.screen, state: c0.state, viewport: c0.viewport, screenshot: c0.screenshot, spec_ref: "spec.md#layout", observation: `${aspect} follows the spec`, status: "ok" }));
  const full = { ...structuredClone(report), judged, critique, ux_review };
  const v = check(full);
  assert.equal(v.valid, true, v.errors.join("\n"));
  const scored = structuredClone(full); scored.critique[0].score = 7; scored.ux_review[0].score = 9;
  const e = check(scored).errors.join("\n");
  assert.match(e, /critique\[0\]: a critique item has no numeric score/);
  assert.match(e, /ux_review\[0\]: a ux_review item has no numeric score/);
});

// ---- the one browser test --------------------------------------------------------------------------------------
const BROWSER = detect({ repo: tmpdir() }).kind === "headless-browser";
const skip = !BROWSER && "no browser installed (measure.mjs --detect)";
async function measureSite(kind) {
  const out = mktmp();
  const cfg = readFileSync(join(FIX, kind, "visual.json"), "utf8").replace("@SITE@", `file://${join(FIX, kind, "site")}/`);
  writeFileSync(join(out, "visual.json"), cfg);
  const args = [MEASURE, "--config", join(out, "visual.json"), "--out", out, "--repo", join(FIX, kind), ...(process.env.CI ? ["--no-sandbox"] : [])];
  const r = await new Promise((ok) => { const c = spawn(process.execPath, args); let se = ""; c.stderr.on("data", (d) => { se += d; }); c.on("close", (code) => ok({ code, se })); });
  assert.equal(r.code, 0, r.se);
  return { out, report: JSON.parse(readFileSync(join(out, "report.json"), "utf8")) };
}
const item = (report, check, screen) => report.design.items.filter((i) => i.check === check && (!screen || i.screen === screen));

test("browser: the bad site yields design findings, the good site keeps content under reduced motion; lint drops with a justification", { skip, timeout: 240000 }, async () => {
  const b = await measureSite("bad");
  const d = b.report.design;
  assert.equal(d.status, "run");
  assert.ok(item(b.report, "design_empty_hero").some((i) => i.status === "fail"), "empty hero");
  assert.ok(item(b.report, "design_untitled_section").some((i) => i.status === "fail"), "untitled section");
  assert.ok(item(b.report, "design_untranslated", "tr.html").some((i) => i.status === "fail"), "untranslated English on the tr page");
  assert.ok(item(b.report, "design_image_ledger").some((i) => i.status === "fail"), "image missing from the ledger is blocking");
  assert.ok(item(b.report, "design_reduced_motion").some((i) => i.status === "fail"), "hidden under reduced motion");
  assert.equal(b.report.result, "FAIL");
  const g = await measureSite("good");
  assert.ok(item(g.report, "design_reduced_motion").length > 0 && item(g.report, "design_reduced_motion").every((i) => i.status === "pass"));
  assert.ok(item(g.report, "design_image_ledger").length > 0 && item(g.report, "design_image_ledger").every((i) => i.status === "pass"));
  // lint of the bad site: blocking, then info with a DESIGN.md justification
  const root = join(FIX, "bad/site"), md = join(FIX, "bad/DESIGN.md");
  const blocking = lintProject({ root, designMd: md }).findings;
  for (const id of ["mono-labels", "hairline-newspaper"]) assert.ok(blocking.some((f) => f.id === id && f.severity === "blocking"), id);
  const tmp = mktmp();
  writeFileSync(join(tmp, "DESIGN.md"), `${readFileSync(md, "utf8")}\n- mono-labels: kept on purpose\n- hairline-newspaper: kept on purpose\n- eyebrow-label: kept on purpose\n`);
  const info = lintProject({ root, designMd: join(tmp, "DESIGN.md") }).findings;
  assert.ok(info.length > 0 && info.every((f) => f.severity === "info" && f.justified));
});
