// visual-proof (A82): browser-less tests of the report validator, the depth and UNSUPPORTED rules, the config
// check, detection and the assemble step. The browser measurement itself is fixtures/visual-proof/browser-check.sh
// (main/nightly CI).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReport, thresholdHolds, planVisualProof, requiredCells, CORE } from "../../skills/visual-proof/scripts/validate-visual.mjs";
import { detect, checkConfig, assemble, pageUrl, PROBE } from "../../skills/visual-proof/scripts/measure.mjs";

const VALIDATE = fileURLToPath(new URL("../../skills/visual-proof/scripts/validate-visual.mjs", import.meta.url));
const MEASURE = fileURLToPath(new URL("../../skills/visual-proof/scripts/measure.mjs", import.meta.url));
const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "vp-test-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const clone = (o) => JSON.parse(JSON.stringify(o));

// A folder with one PNG-like file per cell; returns {dir, shot(name) -> {path, sha256}}.
function shots() {
  const dir = mktmp();
  mkdirSync(join(dir, "screenshots"));
  const shot = (name) => {
    const path = `screenshots/${name}.png`;
    const bytes = Buffer.from(`png ${name}`);
    writeFileSync(join(dir, path), bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  return { dir, shot };
}

const VP3 = [{ name: "phone", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1280, height: 800 }];
const PASS_VALUE = { viewport_overflow: [0, "<= 0"], horizontal_scroll: [360, "<= 360"], hidden_interactive: [576, "> 1"], overlapping_interactive: [0, "== 0"],
  contrast: [7.1, ">= 4.5"], touch_target: [40, ">= 24"], state_rendered: [1, "== 1"], focus_order: [0, "== 0"], focus_visible: [1, "== 1"] };

// A valid PASS report: STANDARD = default state x 2 viewports; COMPLEX = every state x 3 viewports + judged.
function report(cls = "STANDARD") {
  const { dir, shot } = shots();
  const states = ["success", "empty", "error"];
  const r = {
    schema: "visual-proof/1", class: cls, result: "PASS",
    tool: { kind: "headless-browser", name: "chromium", version: "Chrome/130", detected_by: "PATH" },
    viewports: cls === "STANDARD" ? VP3.slice(0, 2) : VP3,
    screens: [{ id: "orders", path: "index.html", states }], interactions: [],
    cells: [], measured: [], not_measured: [], judged: [],
    a11y_scanner: { status: "not_available" }, regression: { status: "not_available", reason: "no snapshot infrastructure" },
    network: { interception: "on", blocked: [] },
    criteria: [{ id: "AC-1", required: true, status: "proven" }],
  };
  let n = 0;
  for (const c of requiredCells(r)) {
    const ev = shot(`${c.state}-${c.viewport}`);
    r.cells.push({ ...c, screenshot: ev });
    for (const check of CORE) {
      const [value, threshold] = PASS_VALUE[check];
      r.measured.push({ id: `M-${++n}`, check, ...c, selector: check === "horizontal_scroll" ? "html" : "body", value, threshold, status: "pass", evidence: ev, ...(check === "horizontal_scroll" ? { criteria: ["AC-1"] } : {}) });
    }
  }
  if (cls !== "STANDARD") {
    const c = r.cells[0];
    ["hierarchy", "density", "consistency", "typography"].forEach((aspect, i) => r.judged.push({
      id: `J-${i + 1}`, aspect, screen: c.screen, state: c.state, viewport: c.viewport, screenshot: c.screenshot,
      spec_ref: "spec.md#layout", observation: `${aspect} follows the spec`, status: "ok" }));
  }
  return { r, dir, shot };
}
const check = (r, dir, opt = {}) => validateReport(r, { root: dir, ...opt });
const errs = (r, dir, opt) => check(r, dir, opt).errors.join("\n");
const failOne = (r) => { const m = r.measured.find((x) => x.check === "contrast"); Object.assign(m, { selector: "p.hint", value: 2.32, status: "fail" }); return m; };

test("a complete STANDARD report is valid and PASS; COMPLEX with judged items too", () => {
  for (const cls of ["STANDARD", "COMPLEX", "CRITICAL"]) {
    const { r, dir } = report(cls);
    const v = check(r, dir);
    assert.equal(v.valid, true, v.errors.join("\n"));
    assert.equal(v.computed, "PASS");
    assert.equal(v.criteria["AC-1"], "proven");
  }
});

test("every measured item needs check, viewport, selector, value, threshold and evidence path + sha256", () => {
  const { r, dir } = report();
  const bad = clone(r);
  delete bad.measured[0].selector; delete bad.measured[1].threshold; bad.measured[2].value = ""; bad.measured[3].check = "vibes";
  bad.measured[4].viewport = "watch"; delete bad.measured[5].evidence;
  const e = errs(bad, dir);
  for (const want of [/selector is required/, /threshold is required/, /value is required/, /unknown check vibes/, /is not a listed cell/, /evidence: needs \{path, sha256\}/]) assert.match(e, want);
});

test("screenshots must exist with their sha256 and stay inside the report folder", () => {
  const { r, dir } = report();
  const a = clone(r); a.measured[0].evidence.sha256 = "0".repeat(64);
  assert.match(errs(a, dir), /sha256 of screenshots\/.* does not match/);
  const b = clone(r); b.cells[0].screenshot.path = "screenshots/missing.png";
  assert.match(errs(b, dir), /screenshot not found/);
  const c = clone(r); c.measured[0].evidence.path = "../outside.png";
  assert.match(errs(c, dir), /relative to the report folder without \.\./);
  const d = clone(r); d.measured[0].evidence.path = "/etc/passwd";
  assert.match(errs(d, dir), /relative to the report folder/);
});

test("status must agree with value and threshold; the result is recomputed", () => {
  assert.equal(thresholdHolds(416, "<= 360"), false);
  assert.equal(thresholdHolds(4.5, ">= 4.5"), true);
  assert.equal(thresholdHolds("n/a", "== 0"), null);
  const { r, dir } = report();
  const a = clone(r); a.measured.find((m) => m.check === "contrast").value = 2.32;
  assert.match(errs(a, dir), /status pass contradicts value 2.32 >= 4.5/);
  const b = clone(r); failOne(b);
  assert.match(errs(b, dir), /result PASS contradicts the evidence \(computed FAIL/);
  b.result = "FAIL";
  const v = check(b, dir);
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.match(v.rows[0], /^blocking\|index\.html:p\.hint\|M-\d+ contrast: 2\.32 fails >= 4\.5 at orders\/success\/phone\|measured; screenshots\/success-phone\.png sha256:[0-9a-f]{12}$/);
});

test("depth: TRIVIAL has no visual focus; STANDARD is 2 viewports and measured only; COMPLEX needs 3 viewports, all states, all judged aspects", () => {
  const s = report();
  assert.match(errs({ ...clone(s.r), class: "TRIVIAL" }, s.dir), /TRIVIAL has no visual focus/);
  const one = clone(s.r); one.viewports = one.viewports.slice(0, 1);
  assert.match(errs(one, s.dir), /STANDARD needs at least 2 viewports/);
  const judged = clone(s.r); judged.judged = [{ id: "J-1", aspect: "density", screen: "orders", state: "success", viewport: "phone", screenshot: s.r.cells[0].screenshot, spec_ref: "spec.md", observation: "dense", status: "concern" }];
  assert.match(errs(judged, s.dir), /STANDARD is measured only: judged must be empty/);
  assert.match(errs(s.r, s.dir, { cls: "COMPLEX" }), /does not match --class COMPLEX/);

  const c = report("COMPLEX");
  const two = clone(c.r); two.viewports = two.viewports.slice(0, 2);
  assert.match(errs(two, c.dir), /COMPLEX needs at least 3 viewports/);
  const noError = clone(c.r);
  noError.cells = noError.cells.filter((x) => x.state !== "error");
  noError.measured = noError.measured.filter((x) => x.state !== "error");
  assert.match(errs(noError, c.dir), /cell orders\|error\|phone required by class COMPLEX has no screenshot entry/);
  const noTypo = clone(c.r); noTypo.judged = noTypo.judged.filter((j) => j.aspect !== "typography");
  assert.match(errs(noTypo, c.dir), /COMPLEX needs a judged item for typography/);
  // judged alone never closes the gate: no measured coverage is invalid
  const onlyJudged = clone(c.r); onlyJudged.measured = [];
  assert.match(errs(onlyJudged, c.dir), /check contrast is neither measured nor listed as not_measured/);
});

test("coverage: a missing core check is invalid; a cell-level not_measured entry makes the result INCONCLUSIVE", () => {
  const { r, dir } = report();
  const a = clone(r); a.measured = a.measured.filter((m) => !(m.check === "focus_visible" && m.viewport === "tablet"));
  assert.match(errs(a, dir), /cell orders\|success\|tablet: check focus_visible is neither measured/);
  a.not_measured.push({ scope: "cell", check: "focus_visible", screen: "orders", state: "success", viewport: "tablet", reason: "browser crashed during the Tab walk" });
  assert.match(errs(a, dir), /result PASS contradicts the evidence \(computed INCONCLUSIVE: not measured: focus_visible/);
  a.result = "INCONCLUSIVE";
  assert.equal(check(a, dir).valid, true);
  // element-level entries are limits, not gaps
  const b = clone(r); b.not_measured.push({ scope: "element", check: "contrast", screen: "orders", state: "success", viewport: "phone", selector: ".hero h1", reason: "background image under the text" });
  assert.equal(check(b, dir).computed, "PASS");
  // a failure wins over a gap
  failOne(a); a.result = "FAIL";
  assert.equal(check(a, dir).computed, "FAIL");
});

test("UNSUPPORTED: no tooling is never a PASS, carries the reason and no measurements", () => {
  const { dir } = shots();
  const u = { schema: "visual-proof/1", class: "STANDARD", result: "UNSUPPORTED", tool: { kind: "none", name: null }, unsupported_reason: "no Chromium-family browser on PATH",
    viewports: [], screens: [], cells: [], measured: [], not_measured: [], judged: [], criteria: [{ id: "AC-1", required: true, status: "unproven" }] };
  const v = check(u, dir);
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.equal(v.computed, "UNSUPPORTED");
  assert.match(v.summary, /unsupported: no Chromium-family browser on PATH/);
  assert.match(errs({ ...u, result: "PASS" }, dir), /result PASS contradicts the evidence \(computed UNSUPPORTED/);
  assert.match(errs({ ...u, unsupported_reason: "" }, dir), /needs unsupported_reason/);
  const { r, dir: d2 } = report();
  assert.match(errs({ ...clone(r), tool: { kind: "none" }, unsupported_reason: "x", result: "UNSUPPORTED" }, d2), /measured, judged and cells must be empty/);
  assert.match(errs({ ...clone(r), unsupported_reason: "x" }, d2), /only allowed with tool.kind none/);
});

test("judged items: separate, cite a screenshot and the spec; a violation needs a quoted written criterion", () => {
  const { r, dir } = report("COMPLEX");
  const spec = "- AC-6: Headings establish a clear hierarchy: the page title is the largest text on the screen.";
  const concern = clone(r); Object.assign(concern.judged[1], { status: "concern", observation: "rows feel cramped at phone width" });
  const v = check(concern, dir);
  assert.equal(v.computed, "PASS");
  assert.ok(v.rows.some((x) => /^info\|index\.html:density\|J-2 judged density: rows feel cramped/.test(x)), v.rows.join("\n"));

  const viol = clone(r); Object.assign(viol.judged[0], { status: "violation", observation: "the banner is larger than the title", violates: { ref: "AC-6", quote: "the page title is the largest text on the screen" } });
  viol.criteria.push({ id: "AC-6", required: false, status: "failed" });
  viol.result = "FAIL";
  assert.match(errs(viol, dir), /can only be checked against the spec or plan/);
  assert.equal(check(viol, dir, { specTexts: [spec] }).valid, true, errs(viol, dir, { specTexts: [spec] }));
  assert.equal(check(viol, dir, { specTexts: [spec] }).computed, "FAIL");
  const taste = clone(viol); taste.judged[0].violates.quote = "headings should feel modern";
  assert.match(errs(taste, dir, { specTexts: [spec] }), /quoted criterion is not written in the spec or plan/);
  const noCite = clone(r); delete noCite.judged[0].screenshot; noCite.judged[1].spec_ref = ""; noCite.judged[2].value = 3;
  const e = errs(noCite, dir);
  assert.match(e, /judged\[0\]\.screenshot: needs/);
  assert.match(e, /spec_ref .* is required/);
  assert.match(e, /a judged item has no value or threshold/);
});

test("criteria: PLAN visual_proof ids must be required; an unproven required criterion is INCONCLUSIVE", () => {
  assert.deepEqual(planVisualProof("## Scope\nx\n## UI\nScreens.\nvisual_proof: AC-1, AC-3\n## Risk\n"), ["AC-1", "AC-3"]);
  assert.deepEqual(planVisualProof("## UI\n- `visual_proof: none`\n"), []);
  assert.equal(planVisualProof("## Notes\nvisual_proof: AC-1\n"), null);
  const { r, dir } = report();
  const plan = "## UI\nvisual_proof: AC-1, AC-2\n";
  assert.match(errs(r, dir, { planText: plan }), /AC-2 is marked visual_proof in PLAN\.md but missing from criteria/);
  const a = clone(r); a.criteria.push({ id: "AC-2", required: false, status: "unproven" });
  assert.match(errs(a, dir, { planText: plan }), /AC-2 is marked visual_proof in PLAN\.md: criteria entry must be required: true/);
  a.criteria[1].required = true;
  assert.match(errs(a, dir, { planText: plan }), /computed INCONCLUSIVE: AC-2 unproven/);
  a.result = "INCONCLUSIVE";
  assert.equal(check(a, dir, { planText: plan }).valid, true);
  const b = clone(r); b.criteria[0].status = "unproven";
  assert.match(errs(b, dir), /criteria\[0\]: status unproven contradicts the evidence \(computed proven\)/);
});

test("visual regression only with existing baselines; never created", () => {
  const { r, dir } = report();
  assert.match(errs({ ...clone(r), regression: { status: "run", command: "npx playwright test", exit: 0 } }, dir), /baselines: existing/);
  assert.match(errs({ ...clone(r), regression: { status: "not_available", reason: "none", baselines_created: true } }, dir), /never creates baselines/);
  const fail = { ...clone(r), regression: { status: "run", command: "npm run test:visual", exit: 1, baselines: "existing" } };
  assert.match(errs(fail, dir), /computed FAIL: visual regression failed/);
});

test("config: only local targets, enough viewports, every state reachable; TRIVIAL refused", () => {
  const base = { class: "STANDARD", base_url: "http://127.0.0.1:5173/", viewports: VP3.slice(0, 2), screens: [{ id: "s", path: "/", states: [{ name: "success", ready: "#list" }] }] };
  assert.deepEqual(checkConfig(base), []);
  assert.match(checkConfig({ ...base, base_url: "https://staging.example.com/" }).join(), /localhost/);
  assert.match(checkConfig({ ...base, class: "TRIVIAL" }).join(), /TRIVIAL has no visual focus/);
  assert.match(checkConfig({ ...base, class: "COMPLEX" }).join(), /needs at least 3 viewports/);
  assert.match(checkConfig({ ...base, screens: [{ id: "s", path: "/", states: [{ name: "error" }] }] }).join(), /ready/);
  assert.deepEqual(checkConfig({ ...base, base_url: "file:///tmp/app/", screens: [{ id: "s", path: "index.html", states: [{ name: "success", ready: "#list" }] }] }), []);
  // every screen and state path stays on the code under review
  const screen = (path, statePath) => ({ ...base, screens: [{ id: "s", path, states: [{ name: "success", ready: "#x", ...(statePath ? { path: statePath } : {}) }] }] });
  assert.match(checkConfig(screen("http://example.com/")).join(), /path http:\/\/example\.com\/ leaves base_url/);
  assert.match(checkConfig(screen("/", "http://127.0.0.1:9999/admin")).join(), /leaves base_url/);
  assert.match(checkConfig({ ...screen("../../etc/hosts"), base_url: "file:///tmp/app/" }).join(), /leaves base_url/);
  assert.deepEqual(checkConfig({ ...screen("index.html", "sub/page.html?state=error"), base_url: "file:///tmp/app/" }), []);
});

test("pageUrl confines file: pages to the base folder and http(s) pages to the localhost origin", () => {
  assert.equal(pageUrl("file:///tmp/app/", "index.html?state=error"), "file:///tmp/app/index.html?state=error");
  assert.equal(pageUrl("file:///tmp/app/index.html", "log.html"), "file:///tmp/app/log.html");
  for (const p of ["../../etc/hosts", "/etc/hosts", "file:///etc/hosts", "%2e%2e/secret.html", "http://example.com/", "file://host/tmp/app/x.html"]) assert.equal(pageUrl("file:///tmp/app/", p), null, p);
  assert.equal(pageUrl("http://127.0.0.1:5173/", "/orders?state=empty"), "http://127.0.0.1:5173/orders?state=empty");
  for (const p of ["http://example.com/", "http://127.0.0.1:9999/", "//evil.test/x", "file:///etc/hosts"]) assert.equal(pageUrl("http://127.0.0.1:5173/", p), null, p);
  assert.equal(pageUrl("https://staging.example.com/", "/"), null);
  for (const root of ["file:///", "file://", "file:///index.html", "file://host/app/"]) {
    assert.equal(pageUrl(root, "etc/hosts"), null, root);
    assert.match(checkConfig({ class: "STANDARD", base_url: root, viewports: VP3.slice(0, 2), screens: [{ id: "s", path: "index.html", states: [{ name: "success", ready: "#x" }] }] }).join(), /not the filesystem root/, root);
  }
});

test("detect: a browser on PATH, a declared project tool, or none (never installed)", () => {
  const repo = mktmp();
  const none = detect({ repo, env: { PATH: "/nowhere" }, exists: () => false });
  assert.equal(none.kind, "none");
  assert.match(none.reason, /no browser-test dependency/);
  const onPath = detect({ repo, env: { PATH: "/opt/bin" }, exists: (p) => p === join("/opt/bin", "chromium") });
  assert.equal(onPath.kind, "headless-browser");
  assert.equal(onPath.name, "chromium");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0" } }));
  const declared = detect({ repo, env: { PATH: "/nowhere" }, exists: () => false });
  assert.equal(declared.kind, "none");
  assert.match(declared.reason, /declared but not installed/);
  mkdirSync(join(repo, "node_modules", "@playwright", "test"), { recursive: true });
  assert.equal(detect({ repo, env: { PATH: "/nowhere" }, exists: () => false }).kind, "project-tool");
});

test("assemble: a state that does not render is a measured failure and nothing else is claimed for it", () => {
  const { dir, shot } = shots();
  const config = { class: "STANDARD", base_url: "file:///app/", viewports: VP3.slice(0, 2),
    screens: [{ id: "orders", path: "index.html", states: [{ name: "error", path: "index.html?state=error", ready: "[data-state=error]" }] }],
    criteria: [{ id: "AC-3", required: true, checks: ["state_rendered"] }] };
  const cells = VP3.slice(0, 2).map((v) => ({ screen: "orders", state: "error", viewport: v.name, screenshot: shot(`e-${v.name}`).path, rendered: false, items: [], not_measured: [] }));
  const rep = assemble({ tool: { kind: "headless-browser", name: "chromium" }, config, cells, network: { interception: "on", blocked: [] } }, dir);
  assert.equal(rep.result, "FAIL");
  assert.equal(rep.measured.filter((m) => m.check === "state_rendered" && m.status === "fail").length, 2);
  assert.equal(rep.not_measured.filter((n) => n.scope === "cell" && n.reason === "state not rendered").length, 2 * (CORE.length - 1));
  assert.deepEqual(rep.criteria, [{ id: "AC-3", required: true, status: "failed" }]);
  const v = check(rep, dir);
  assert.equal(v.valid, true, v.errors.join("\n"));
  const u = assemble({ tool: { kind: "none", reason: "no browser" }, config, cells: [] }, dir);
  assert.equal(u.result, "UNSUPPORTED");
  assert.equal(check(u, dir).valid, true, errs(u, dir));
});

test("CLI: validate-visual prints RESULT, SUMMARY and rows; measure prints a self-contained probe", () => {
  const { r, dir } = report();
  failOne(r); r.result = "FAIL";
  writeFileSync(join(dir, "report.json"), JSON.stringify(r));
  const ok = spawnSync(process.execPath, [VALIDATE, join(dir, "report.json"), "--class", "STANDARD", "--rows"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^RESULT: FAIL\nSUMMARY: visual-proof: FAIL class=STANDARD tool=headless-browser:chromium cells=2 viewports=phone,tablet measured=17\/18 pass, 1 fail/);
  assert.match(ok.stdout, /\nblocking\|index\.html:p\.hint\|/);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...r, result: "PASS" }));
  const bad = spawnSync(process.execPath, [VALIDATE, join(dir, "bad.json")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /RESULT: INVALID/);
  assert.equal(spawnSync(process.execPath, [VALIDATE], { encoding: "utf8" }).status, 2);
  const probe = spawnSync(process.execPath, [MEASURE, "--print-probe"], { encoding: "utf8" });
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout.trim(), PROBE);
  assert.doesNotThrow(() => new Function(PROBE));
  assert.equal(spawnSync(process.execPath, [MEASURE, "--out", dir], { encoding: "utf8" }).status, 2);
});

test("SKILL.md states the boundaries: existing tooling only, UNSUPPORTED never PASS, depth, judged never alone", () => {
  const md = readFileSync(new URL("../../skills/visual-proof/SKILL.md", import.meta.url), "utf8");
  assert.match(md, /never installs a browser/);
  assert.match(md, /it is never a PASS and only the user can waive it/);
  assert.match(md, /STANDARD: the changed screens in their default state x 2\s+viewports, measured only/);
  assert.match(md, /COMPLEX and CRITICAL: every spec state/);
  assert.match(md, /FAIL the gate only when they violate a criterion written in the spec or plan/);
  assert.match(md, /never create or update a baseline/);
});

// --- review round 2 (A93): pinned thresholds, not_applicable, network guard, INCONCLUSIVE submission ----------
const { thresholdError, NOT_APPLICABLE, submitReason } = await import("../../skills/visual-proof/scripts/validate-visual.mjs");
const { allowRequest } = await import("../../skills/visual-proof/scripts/measure.mjs");
// The fixture's planted failures, edited to pass in every way a report can be edited without re-measuring.
const planted = (r) => { const m = failOne(r); r.result = "FAIL"; return m; };

test("H3: a failure edited to pass, to not_applicable or behind a loosened or non-numeric threshold is rejected", () => {
  const { r, dir } = report();
  const ok = clone(r); planted(ok); assert.equal(check(ok, dir).valid, true, errs(ok, dir));
  const edit = (f) => { const x = clone(r); const m = planted(x); f(m, x); x.result = "PASS"; return errs(x, dir); };
  assert.match(edit((m) => { m.status = "pass"; }), /status pass contradicts value 2.32 >= 4.5/);
  assert.match(edit((m) => { m.status = "not_applicable"; }), /not_applicable contrast needs selector body and the reason "no visible text"/);
  assert.match(edit((m) => { Object.assign(m, { status: "not_applicable", value: "n/a", threshold: "n/a" }); }), /threshold "n\/a" is not numeric/);
  assert.match(edit((m) => { Object.assign(m, { status: "pass", threshold: ">= 2" }); }), /threshold >= 2 is weaker than or unlike the documented >= 4.5 for contrast/);
  assert.match(edit((m) => { Object.assign(m, { status: "pass", threshold: ">= 3" }); }), /contrast >= 3 is for large text only/);
  assert.match(edit((m) => { Object.assign(m, { status: "pass", value: "fine" }); }), /a pass item needs a numeric value/);
  // the measure.mjs not_applicable item, forged in next to a real contrast item, or for a check that has none
  const both = clone(r); both.measured.push({ ...clone(r.measured.find((m) => m.check === "contrast")), id: "M-999", selector: "body", value: "no visible text", status: "not_applicable" });
  assert.match(errs(both, dir), /not_applicable contrast next to another contrast item/);
  const sr = clone(r); Object.assign(sr.measured.find((m) => m.check === "state_rendered"), { status: "not_applicable", value: "no state" });
  assert.match(errs(sr, dir), /not_applicable is not allowed for state_rendered/);
  const fo = clone(r); Object.assign(fo.measured.find((m) => m.check === "focus_order"), { status: "not_applicable", value: "no focusable element" });
  assert.match(errs(fo, dir), /"no focusable element" holds for hidden_interactive, focus_order and focus_visible together/);
});
test("H3: thresholds are the documented ones or stricter; touch target, overflow, scroll width", () => {
  const vp = { name: "phone", width: 360, height: 740 };
  assert.equal(thresholdError({ check: "touch_target", threshold: ">= 44" }, vp), null, "stricter is allowed");
  assert.match(thresholdError({ check: "touch_target", threshold: ">= 10" }, vp), /weaker/);
  assert.equal(thresholdError({ check: "horizontal_scroll", threshold: "<= 345" }, vp), null);
  assert.match(thresholdError({ check: "horizontal_scroll", threshold: "<= 500" }, vp), /weaker/);
  assert.match(thresholdError({ check: "viewport_overflow", threshold: "<= 56" }, vp), /weaker/);
  assert.match(thresholdError({ check: "state_rendered", threshold: ">= 0" }, vp), /unlike the documented == 1/);
  assert.equal(thresholdError({ check: "contrast", threshold: ">= 3", font_size_px: 24, font_weight: 400 }, vp), null);
  assert.equal(thresholdError({ check: "contrast", threshold: ">= 3", font_size_px: 18.66, font_weight: 700 }, vp), null);
  assert.match(thresholdError({ check: "contrast", threshold: ">= 3", note: "large text" }, vp), /needs font_size_px and font_weight/);
  assert.match(thresholdError({ check: "contrast", threshold: ">= 3", font_size_px: 18.66, font_weight: 400, note: "large text" }, vp), /18\.66px weight 400 is not large/);
  assert.match(thresholdError({ check: "contrast", threshold: ">= 3", font_size_px: 16, font_weight: 700 }, vp), /is not large/);
  assert.equal(thresholdError({ check: "hidden_interactive", threshold: "> 1" }, vp), null);
  assert.match(checkConfig({ class: "STANDARD", base_url: "file:///tmp/app/", viewports: VP3.slice(0, 2), touch_target_min: 10, screens: [{ id: "s", path: "index.html", states: [{ name: "success", ready: "#x" }] }] }).join(), /touch_target_min must be a number >= 24/);
  assert.deepEqual(Object.keys(NOT_APPLICABLE).sort(), ["contrast", "focus_order", "focus_visible", "hidden_interactive", "overlapping_interactive", "touch_target"]);
});
test("H3: SUMMARY counts not_applicable apart from passes", () => {
  const { r, dir } = report();
  const x = clone(r);
  for (const m of x.measured.filter((m) => ["hidden_interactive", "focus_order", "focus_visible"].includes(m.check) && m.viewport === "phone")) Object.assign(m, { selector: "body", value: "no focusable element", status: "not_applicable" });
  const v = check(x, dir);
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.match(v.summary, /measured=15\/18 pass, 0 fail, 3 not_applicable; blocked_requests=0;/);
});
test("M2: requests outside the page's origin are blocked; the report must carry the network record", () => {
  assert.equal(allowRequest("file:///tmp/app/", "file:///tmp/app/styles.css"), true);
  assert.equal(allowRequest("file:///tmp/app/", "data:image/png;base64,AA"), true);
  for (const u of ["http://127.0.0.1:9/api/orders", "https://cdn.example.com/x.js", "file:///etc/passwd"]) assert.equal(allowRequest("file:///tmp/app/", u), false, u);
  assert.equal(allowRequest("http://127.0.0.1:5173/", "http://127.0.0.1:5173/api/orders"), true);
  for (const u of ["http://127.0.0.1:8080/api", "http://localhost:5173/x", "https://api.example.com/"]) assert.equal(allowRequest("http://127.0.0.1:5173/", u), false, u);
  const { r, dir } = report();
  const a = clone(r); delete a.network; assert.match(errs(a, dir), /network\.interception must be on for a headless-browser report/);
  const b = clone(r); b.network.blocked = ["http://x"]; assert.match(errs(b, dir), /network\.blocked must be a list of \{url, type\}/);
  const c = clone(r); c.network.blocked = [{ url: "http://127.0.0.1:9/api/orders", type: "Fetch" }];
  assert.match(check(c, dir).summary, /blocked_requests=1/);
  const md = readFileSync(new URL("../../skills/visual-proof/SKILL.md", import.meta.url), "utf8");
  assert.match(md, /\*\*Databases \(A50\/A52\)\.\*\* Never exercise a page, a form step or an interaction against a backend that uses\s+a real database/);
  assert.match(md, /Fetch\.requestPaused/);
});
test("L1: INCONCLUSIVE is submitted as UNSUPPORTED with a `visual INCONCLUSIVE:` reason", () => {
  const { r, dir } = report();
  const a = clone(r); a.measured = a.measured.filter((m) => !(m.check === "focus_visible" && m.viewport === "tablet"));
  a.not_measured.push({ scope: "cell", check: "focus_visible", screen: "orders", state: "success", viewport: "tablet", reason: "browser crashed" });
  a.result = "INCONCLUSIVE";
  assert.match(submitReason(check(a, dir)), /^visual INCONCLUSIVE: not measured: focus_visible at orders\/success\/tablet; not a FAIL; /);
  writeFileSync(join(dir, "inc.json"), JSON.stringify(a));
  const out = spawnSync(process.execPath, [VALIDATE, join(dir, "inc.json"), "--rows"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^SUBMIT: --result UNSUPPORTED --reason "visual INCONCLUSIVE: /m);
  const md = readFileSync(new URL("../../skills/visual-proof/SKILL.md", import.meta.url), "utf8");
  assert.doesNotMatch(md, /--result BLOCKED --reason "<what could not be measured>"/);
});

test("re-review M5/M6: same-origin writes, adapters without the guard and unguarded workers cap the result", () => {
  const { r, dir } = report();
  const w = clone(r); w.network.same_origin_writes = [{ method: "POST", url: "http://127.0.0.1:5173/api/orders" }];
  assert.match(errs(w, dir), /computed INCONCLUSIVE: 1 same-origin write\(s\) without a visual_writes allowance/);
  w.result = "INCONCLUSIVE"; assert.equal(check(w, dir).valid, true);
  assert.match(check(w, dir).summary, /same_origin_writes=1;/);
  const plan = "## UI\nvisual_proof: AC-1\nvisual_writes: the project's test server (npm run test:server) uses an in-memory store\n";
  w.result = "PASS";
  const ok = check(w, dir, { planText: plan }); assert.equal(ok.valid, true, ok.errors.join("\n")); assert.match(ok.summary, /same_origin_writes=1 \(allowed\)/);
  const bad = clone(r); bad.network.same_origin_writes = [{ url: "x" }]; assert.match(errs(bad, dir), /same_origin_writes must be a list of \{method, url\}/);
  for (const kind of ["project-tool", "runtime-adapter"]) {
    const a = clone(r); a.tool.kind = kind; a.network = { interception: "none", blocked: [] };
    assert.match(errs(a, dir), /computed INCONCLUSIVE: network interception not applied/, kind);
    delete a.network; assert.match(errs(a, dir), /network interception not applied/, kind);
    a.network = { interception: "on", blocked: [] }; assert.equal(check(a, dir).computed, "PASS", kind);
  }
  const u = clone(r); u.network.unguarded = [{ url: "blob:x", type: "worker", reason: "Fetch.enable failed" }];
  assert.match(errs(u, dir), /1 child target\(s\) ran without the network guard/);
  const f = clone(r); failOne(f); f.result = "FAIL"; f.network.interception = "none"; f.tool.kind = "runtime-adapter";
  assert.equal(check(f, dir).computed, "FAIL", "a measured failure still FAILs");
  const md = readFileSync(new URL("../../skills/visual-proof/SKILL.md", import.meta.url), "utf8");
  assert.match(md, /visual_writes:/); assert.match(md, /\*\*Limits\.\*\*/);
});
test("re-review: horizontal_scroll's bound is the recorded client_width, capped by the viewport (980 on a phone without viewport meta)", () => {
  const phone = { name: "phone", width: 360, height: 740 }, tablet = { name: "tablet", width: 768, height: 1024 };
  assert.equal(thresholdError({ check: "horizontal_scroll", threshold: "<= 980", client_width: 980 }, phone), null);
  assert.match(thresholdError({ check: "horizontal_scroll", threshold: "<= 1200", client_width: 1200 }, phone), /client_width 1200 exceeds 980/);
  assert.match(thresholdError({ check: "horizontal_scroll", threshold: "<= 980", client_width: 980 }, tablet), /exceeds 768/);
  assert.match(thresholdError({ check: "horizontal_scroll", threshold: "<= 980", client_width: 360 }, phone), /weaker/);
  assert.equal(thresholdError({ check: "horizontal_scroll", threshold: "<= 345" }, phone), null);
});
