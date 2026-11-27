// visual-proof text-only page profile (A380, issue 338 U7, the part A368 deferred): a page whose kind the UI spec declares `text_only` is not
// asked for the hero, the motion layer or the image ledger, but only when its measured facts show no visual, no raster image and no motion.
// A declared page that shows any of them, and every page not declared text-only, is measured exactly as before. Pure functions and an
// assembled report; no browser.
import { tempDir } from '../lib/tempdir.mjs';
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateReport, CORE } from "../../skills/visual-proof/scripts/validate-visual.mjs";
import { assemble, checkConfig } from "../../skills/visual-proof/scripts/measure.mjs";
import { TEXT_ONLY_NOTE, checkPageKinds, pageGlobMatch, pageKindOf } from "../../skills/visual-proof/scripts/design-audit.mjs";
import { RECORDED, rawFor } from "./textonly-raw.mjs";
import { ledgerItems } from "../../skills/visual-proof/scripts/ledger.mjs";

const dirs = [];
const mktmp = () => { const d = tempDir("vp-textonly-"); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const facts = (over = {}) => ({ headings: [{ selector: "h1", lines: 1 }], headingSizes: [64], largestHeading: "h1", bodySize: 16, paragraphs: [{ selector: "p", lines: 3, chars: 60 }], vh: 900, vw: 1440, lang: "en",
  fonts: { families: [{ family: "D", kind: "web", count: 1 }], heading: { kind: "web", family: "D" }, body: { kind: "web", family: "D" } }, edge: { left: 48, right: 48 }, edgeText: { selector: "h1", distance: 48, side: "left" },
  blocks: [{ top: 0, bottom: 500, selector: "header" }, { top: 560, bottom: 1100, selector: "section" }], sections: [{ selector: "section", height: 540, titled: true }], hero: { h1: true, action: false, visual: false, visualKind: "none" },
  media: { count: 0, selectors: [] }, surfaces: [{ selector: "::selection", surface: "selection", problems: 0, note: "themed" }], textBlocks: [], markupBlocks: [],
  ux: { images: { total: 0, bad: [] }, fields: { total: 0, bad: [] }, controls: { total: 1, bad: [] }, viewportMeta: "width=device-width, initial-scale=1" }, ...over });
const OK = { viewport_overflow: [0, "<= 0"], horizontal_scroll: [360, "<= 360"], hidden_interactive: [5, "> 1"], overlapping_interactive: [0, "== 0"], contrast: [7.1, ">= 4.5"], touch_target: [40, ">= 24"], focus_order: [0, "== 0"], focus_visible: [1, "== 1"] };
const VPS = [{ name: "phone", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1280, height: 800 }];
const LEGAL = [{ kind: "legal", paths: ["legal/*.html"], text_only: true, reason: "privacy and terms: prose only" }];
const PAGE = "legal/privacy.html";
const LEGAL_R = [{ kind: "legal", paths: ["legal/*.html"], text_only: true, reason: "privacy and terms" }];   // the kinds the recorder used

// A persuade-mode report (hero and motion apply) of one page with an image ledger. o: page_kinds, facts per viewport, motion counts, ledger images and fonts.
function build(o = {}) {
  const dir = mktmp();
  mkdirSync(join(dir, "screenshots"));
  const png = (n) => { writeFileSync(join(dir, `screenshots/${n.replace(/\//g, "_")}.png`), `png ${n}`); return `screenshots/${n.replace(/\//g, "_")}.png`; };
  const path = o.path ?? PAGE;
  const config = { class: "STANDARD", base_url: "file:///app/", viewports: VPS, screens: [{ id: "S1", path, states: [{ name: "default", path, ready: "main" }] }], criteria: [],
    ...(o.kinds ? { page_kinds: o.kinds } : {}), design: { visitor_mode: "persuade", screens: [path], ...(o.ledger === false ? {} : { image_ledger: "docs/design/IMAGES.md" }) } };
  const cells = VPS.map((v) => ({ screen: "S1", state: "default", viewport: v.name, screenshot: png(v.name), rendered: true, not_measured: [],
    items: CORE.filter((c) => c !== "state_rendered").map((check) => ({ check, selector: check === "horizontal_scroll" ? "html" : "body", value: OK[check][0], threshold: OK[check][1], status: "pass" })) }));
  const images = o.images ?? [];
  const ledger = o.ledger === false ? undefined : { ...ledgerItems({ images, ledgerText: "## Images\n\n| file | source_url | license | credit | used_in |\n|---|---|---|---|---|\n| hero.jpg | x | CC0 | me | home |\n", screen: "S1", viewport: "wide" }), ...(o.fonts === undefined ? { fonts: 0 } : o.fonts === null ? {} : { fonts: o.fonts }) };
  const pages = [{ path, viewports: ["wide", "tablet", "phone390"].map((viewport) => ({ viewport, screenshot: png(`${path}-${viewport}`), facts: { ...facts(o.facts?.[viewport]), vw: viewport === "phone390" ? 390 : 1440 } })), ...(ledger ? { ledger } : {}) }];
  const mv = o.motion ?? { load: 0, scroll: 0 };
  const motion = { items: [
    ...["load", "scroll"].map((phase) => ({ check: "design_motion_count", phase, screen: "S1", viewport: "wide", selector: "html", value: mv[phase], threshold: ">= 3", status: mv[phase] >= 3 ? "pass" : "fail", note: `${phase}: ${mv[phase]}` })),
    ...["design_reduced_motion", "design_no_script_visible"].map((check) => ({ check, screen: "S1", viewport: "wide", selector: "body", value: 0, threshold: "== 0", status: "pass" })) ], scenes: [], not_measured: [] };
  if (o.motionError) delete motion.items;
  const report = assemble({ tool: { kind: "headless-browser", name: "chromium" }, config, cells, network: { interception: "on", blocked: [] }, design: { pages, motion: o.motionError ? { error: "motion recorder did not start" } : motion } }, dir);
  return { dir, report, check: (r = report) => validateReport(r, { root: dir }) };
}
const by = (report, check) => report.design.items.filter((i) => i.check === check);
const PROFILE = ["design_empty_hero", "design_motion_count", "design_image_ledger"];
const strip = (d) => ({ ...d, pages: d.pages.map(({ text_only, ...p }) => p) });

test("a page declared text-only and measured free of visuals, images and motion is not asked for the hero, motion and image-ledger rows", () => {
  const { report, check } = build({ kinds: LEGAL });
  for (const c of PROFILE) {
    const items = by(report, c);
    assert.ok(items.length > 0, c);
    assert.ok(items.every((i) => i.status === "not_applicable" && i.note === TEXT_ONLY_NOTE), `${c}: ${JSON.stringify(items)}`);
  }
  assert.equal(by(report, "design_empty_hero").length, 3, "one per design viewport");
  assert.deepEqual(report.design.pages[0].text_only, { kind: "legal", media: 0, images: 0, fonts: 0, motion: 0, applied: PROFILE });
  const v = check();
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.ok(!v.reasons.some((r) => /design_empty_hero|design_motion_count|design_image_ledger/.test(r)), v.reasons.join("\n"));
  // every other design item is the one an undeclared page gets
  const plain = build({});
  const other = (r) => r.design.items.filter((i) => !PROFILE.includes(i.check)).map(({ id, ...x }) => x);
  assert.deepEqual(other(report), other(plain.report));
});

test("a page that is not declared text-only, or of a kind that is not text_only, is measured exactly as before", () => {
  const plain = build({});
  assert.ok(by(plain.report, "design_empty_hero").every((i) => i.status === "fail"), "the control: a persuade page without a hero fails");
  assert.ok(by(plain.report, "design_motion_count").every((i) => i.status === "fail"));
  assert.ok(by(plain.report, "design_image_ledger").every((i) => i.status === "pass"));
  for (const kinds of [[{ ...LEGAL[0], text_only: false }], [{ kind: "legal", paths: ["legal/*.html"], reason: "x" }], [{ ...LEGAL[0], paths: ["docs/*.html"] }],
    [...LEGAL, { kind: "policy", paths: ["legal/privacy.*"], text_only: true, reason: "two kinds match: none" }]]) {
    const r = build({ kinds }).report;
    assert.deepEqual(r.design, plain.report.design, JSON.stringify(kinds));
  }
});

test("a declared text-only page that shows a visual, a raster image or motion is asked every row as before", () => {
  const plain = build({}).report.design;
  const cases = {
    "a medium of 80 px at one viewport": { facts: { phone390: { media: { count: 1, selectors: ["img.map"] } } } },
    "a hero visual (colour field)": { facts: { tablet: { hero: { h1: true, action: false, visual: true, visualKind: "colour field" } } } },
    "a raster image in the ledger probe": { images: [{ src: "file:///app/hero.jpg", kind: "img", selector: "img" }] },
    "motion while loading": { motion: { load: 2, scroll: 0 } },
    "motion while scrolling": { motion: { load: 0, scroll: 1 } },
    "no media fact (an older probe)": { facts: { wide: { media: undefined } } },
    "no ledger probe result although a ledger is configured": { fonts: null, images: undefined },
  };
  for (const [name, o] of Object.entries(cases)) {
    const { report, check } = build({ kinds: LEGAL, ...o });
    assert.deepEqual(report.design.pages[0].text_only.applied, name.startsWith("no ledger probe") ? PROFILE.slice(0, 2) : [], name);
    if (name.startsWith("no ledger probe")) continue;
    const base = name === "a raster image in the ledger probe" || name.startsWith("motion") || name === "a hero visual (colour field)" ? build(o).report.design : plain;
    assert.deepEqual(strip(report.design), base, name);
    assert.equal(check().valid, true, `${name}: ${check().errors.join("\n")}`);
  }
  const broken = build({ kinds: LEGAL, motionError: true });
  assert.deepEqual(broken.report.design.pages[0].text_only.applied, [], "motion not measured is not no motion");
  assert.ok(by(broken.report, "design_motion_count").every((i) => i.status === "not_measured"));
});

test("a self-hosted font keeps the ledger row; without a ledger the hero and motion rows still follow the profile", () => {
  const f = build({ kinds: LEGAL, fonts: 1 });
  assert.deepEqual(f.report.design.pages[0].text_only.applied, ["design_empty_hero", "design_motion_count"]);
  assert.ok(by(f.report, "design_image_ledger").every((i) => i.status !== "not_applicable"), "a font licence row is still asked");
  assert.equal(f.check().valid, true, f.check().errors.join("\n"));
  const n = build({ kinds: LEGAL, ledger: false });
  assert.deepEqual(n.report.design.pages[0].text_only, { kind: "legal", media: 0, images: null, fonts: null, motion: 0, applied: ["design_empty_hero", "design_motion_count"] });
  assert.equal(n.check().valid, true, n.check().errors.join("\n"));
});

test("the validator refuses a text-only note the report does not back", () => {
  const { report, check } = build({ kinds: LEGAL });
  const err = (mut) => { const r = structuredClone(report); mut(r); return check(r).errors.join("\n"); };
  assert.match(err((r) => { delete r.page_kinds; }), /not of a page kind declared text_only/);
  assert.match(err((r) => { r.page_kinds[0].text_only = false; }), /not of a page kind declared text_only/);
  assert.match(err((r) => { r.page_kinds[0].paths = ["docs/*.html"]; }), /not of a page kind declared text_only/, "a kind that does not match the page");
  assert.match(err((r) => { r.design.pages[0].text_only.media = 2; }), /shows a visual, an image or motion/);
  assert.match(err((r) => { r.design.pages[0].text_only.motion = 1; }), /shows a visual, an image or motion/);
  assert.match(err((r) => { r.design.pages[0].text_only.images = 1; }), /shows a visual, an image or motion/);
  assert.match(err((r) => { r.design.pages[0].text_only.fonts = 1; }), /the image ledger is asked/);
  assert.match(err((r) => { delete r.design.pages[0].text_only; }), /text_only evidence does not apply/);
  assert.match(err((r) => { r.design.pages[0].text_only.applied = ["design_empty_hero"]; }), /does not apply design_motion_count/);
  assert.match(err((r) => { r.design.pages[0].text_only.kind = "article"; }), /text_only evidence does not apply/);
  assert.match(err((r) => { const m = r.design.items.find((i) => i.check === "design_motion_count"); m.value = 4; }), /motion count item with 4 animated element/);
  assert.match(err((r) => { const t = r.design.items.find((i) => i.check === "design_type_scale"); t.status = "not_applicable"; t.note = TEXT_ONLY_NOTE; }), /only for design_empty_hero/, "the note on any other check");
  // the same note on an undeclared page's hero
  const plain = build({});
  const r = structuredClone(plain.report);
  for (const i of r.design.items) if (i.check === "design_empty_hero") { i.status = "not_applicable"; i.note = TEXT_ONLY_NOTE; }
  assert.match(plain.check(r).errors.join("\n"), /not of a page kind declared text_only/);
});

test("page_kinds: kind ids, globs and duplicates are checked in the config and the report; a page has the one kind that matches", () => {
  assert.deepEqual(checkPageKinds(LEGAL), []);
  for (const [bad, re] of [["x", /must be a list/], [[{ kind: "Legal", paths: ["a"] }], /lower-case id/], [[{ kind: "a", paths: ["../x"] }], /relative path globs/], [[{ kind: "a", paths: ["/x.html"] }], /relative path globs/],
    [[{ kind: "a", paths: [] }], /relative path globs/], [[{ kind: "a", paths: ["a b"] }], /relative path globs/], [[{ kind: "a", paths: ["x"] }, { kind: "a", paths: ["y"] }], /listed twice/],
    [[{ kind: "a", paths: ["x"], text_only: "yes" }], /true or false/], [[{ kind: "a", paths: ["x"], extra: 1 }], /unknown key extra/]]) assert.match(checkPageKinds(bad).join("\n"), re, JSON.stringify(bad));
  assert.deepEqual(pageKindOf(LEGAL, "/legal/privacy.html"), { kind: "legal", glob: "legal/*.html", text_only: true });
  assert.equal(pageKindOf(LEGAL, "legal/sub/privacy.html"), null, "* stays inside a segment");
  assert.equal(pageKindOf([{ kind: "a", paths: ["legal/**"] }], "legal/sub/x.html")?.kind, "a", "** crosses segments");
  assert.equal(pageKindOf(LEGAL, "legal/privacy.html?x=1"), null, "a query has no kind");
  assert.equal(pageKindOf(LEGAL, "legal/../index.html"), null);
  assert.equal(pageKindOf([{ kind: "a", paths: ["legal.html"] }], "legalxhtml"), null, "a dot is literal");
  const cfg = { class: "STANDARD", base_url: "file:///app/", viewports: VPS, screens: [{ id: "S1", path: "index.html", states: [{ name: "default", path: "index.html", ready: "main" }] }], criteria: [], page_kinds: [{ kind: "a", paths: ["../x"] }] };
  assert.match(checkConfig(cfg).join("\n"), /page_kinds\[0\]\.paths/);
  const { report, check } = build({ kinds: LEGAL });
  const r = structuredClone(report); r.page_kinds = [{ kind: "BAD", paths: ["x"] }];
  assert.match(check(r).errors.join("\n"), /lower-case id/);
});

// A380 review: expectations recorded with the assemble of main BEFORE this change (tests/skills/textonly-raw.mjs names the recorder), so an undeclared
// page is compared with what main produced, not with the new code. The raw input carries page_kinds; main ignored the key.
const RECORDED_DIR = join(import.meta.dirname, "fixtures/visual-proof-textonly");
const recorded = (name) => JSON.parse(readFileSync(join(RECORDED_DIR, `main-${name}.json`), "utf8"));
const now = (paths, kinds) => { const dir = mktmp(); return assemble(rawFor(dir, paths, kinds, ledgerItems), dir); };

test("recorded from main: an undeclared page's report is what main produced; a mixed report changes only the declared page's profile rows", () => {
  const { page_kinds, ...rest } = now(RECORDED.single, LEGAL_R);
  assert.deepEqual(page_kinds, LEGAL_R, "the report carries the declared kinds");
  assert.deepEqual(rest, recorded("single"), "an undeclared page differs from main");
  assert.deepEqual(now(RECORDED.single, undefined), recorded("single"), "a config without page_kinds differs from main");
  const mixed = now(RECORDED.mixed, LEGAL_R), main = recorded("mixed");
  const priv = mixed.design.pages.find((p) => p.path === "legal/privacy.html");
  assert.deepEqual(priv.text_only.applied, PROFILE);
  assert.equal(mixed.design.pages.find((p) => p.path === "index.html").text_only, undefined);
  const changed = (i) => i.screen === priv.screen && PROFILE.includes(i.check);
  assert.deepEqual(mixed.design.items.filter((i) => !changed(i)), main.design.items.filter((i) => !changed(i)), "an item other than the declared page's profile rows changed");
  assert.ok(main.design.items.filter(changed).length > 0 && main.design.items.filter(changed).every((i) => i.status !== "not_applicable"), "the control: main asked those rows");
  assert.ok(mixed.design.items.filter(changed).every((i) => i.status === "not_applicable" && i.note === TEXT_ONLY_NOTE));
  assert.deepEqual(mixed.design.pages.map(({ text_only, ...p }) => p), main.design.pages);
  for (const k of Object.keys(main)) if (!["design", "result"].includes(k)) assert.deepEqual(mixed[k], main[k], k);
});

test("the glob matcher is linear and keeps its meaning: a hostile glob and hostile paths, more than 16 wildcards refused, the root page is /", () => {
  const hostile = "**a".repeat(16);
  assert.equal(pageGlobMatch(hostile, `${"a".repeat(399)}b`), false);
  assert.equal(pageGlobMatch(hostile, "a".repeat(400)), true);
  assert.equal(pageGlobMatch("*a".repeat(16), `${"a".repeat(15)}/a`), false, "one * never crosses /");
  assert.equal(pageKindOf([{ kind: "x", paths: [hostile] }], `${"a".repeat(390)}b`), null);
  assert.match(checkPageKinds([{ kind: "x", paths: ["*a".repeat(17)] }]).join("\n"), /at most 16 wildcards/);
  for (const [g, p, want] of [["legal/*.html", "legal/a.html", true], ["legal/*.html", "legal/s/a.html", false], ["legal/**", "legal/s/a.html", true], ["**", "/", true], ["*", "/", false],
    ["a?c", "abc", true], ["a?c", "a/c", false], ["***", "x/y", true], ["legal.html", "legalxhtml", false], ["legal/**/x.html", "legal/a/b/x.html", true]]) assert.equal(pageGlobMatch(g, p), want, `${g} ${p}`);
  assert.equal(pageKindOf([{ kind: "home", paths: ["**"] }], "/")?.kind, "home", "the root page has a path, /");
});
