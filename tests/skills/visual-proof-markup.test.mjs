// visual-proof U7 (A368, issue 338 item U7): raw markup in visible text is a finding (rendered probe facts and the source lint),
// and language pages list the human checks QA cannot evaluate. Pure functions and an assembled report; no browser.
import { tempDir } from '../lib/tempdir.mjs';
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateReport, CORE } from "../../skills/visual-proof/scripts/validate-visual.mjs";
import { assemble } from "../../skills/visual-proof/scripts/measure.mjs";
import { evaluateStatic, rawMarkupBlocks, DESIGN_STATIC_CHECKS } from "../../skills/visual-proof/scripts/design-audit.mjs";
import { lintMarkupText, lintProject, validateLint } from "../../skills/visual-proof/scripts/lint-source.mjs";

const dirs = [];
const mktmp = () => { const d = tempDir("vp-markup-"); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const blk = (text, selector = "p") => ({ selector, text });
const kinds = (text) => rawMarkupBlocks([blk(text)]).map((x) => x.kind);

test("raw markup: bold, underscore, backtick, heading, list, link and placeholder are found; ordinary text is not", () => {
  assert.deepEqual(kinds("**Cause:** the cache was stale"), ["bold"]);
  assert.deepEqual(kinds("This is __very important__ today"), ["underscore"]);
  assert.deepEqual(kinds("Run `npm test` first"), ["backtick"]);
  assert.deepEqual(kinds("# Welcome home"), ["heading"]);
  assert.deepEqual(kinds("- first item of the list"), ["list"]);
  assert.deepEqual(kinds("See [the docs](https://example.org/docs) now"), ["link"]);
  assert.deepEqual(kinds("Hello {{ user.name }}"), ["placeholder"]);
  for (const ok of ["Plain text, nothing special", "5 ** 2 and 2 ** 3 are powers", "A lone ** star", "snake_case and __init", "Price #1 - best", "-5 degrees", "Use the [brackets] (and parens) freely", "array[i](x)"]) assert.deepEqual(kinds(ok), [], ok);
});

test("raw markup: the finding names the selector and a bounded snippet; TASK.md exempts only a text it holds verbatim", () => {
  const long = `**${"x".repeat(300)}**`;
  const [f] = rawMarkupBlocks([blk(long, "main > p.lead")]);
  assert.equal(f.selector, "main > p.lead");
  assert.ok(f.text.length <= 80, "the snippet is bounded");
  const text = "**Cause:** the cache was stale";
  assert.equal(rawMarkupBlocks([blk(text)], `# Task\n\n- AC-3: the page shows "${text}" literally.\n`).length, 0);
  assert.equal(rawMarkupBlocks([blk(text)], "# Task\n\nnothing quoted here\n").length, 1, "a TASK.md without the text exempts nothing");
  assert.equal(rawMarkupBlocks([blk(text)]).length, 1, "no task, no exemption");
  assert.equal(rawMarkupBlocks([blk(text)], "# Task\n\nuse **Cause:**   the cache\nwas stale somewhere\n").length, 0, "verbatim in the task text, white space squeezed");
  assert.equal(rawMarkupBlocks([blk("`a`")], "`a`").length, 1, "a text under 4 non-space characters exempts nothing");
});

const facts = (over = {}) => ({ headings: [{ selector: "h1", lines: 1 }], headingSizes: [64], largestHeading: "h1", bodySize: 16, paragraphs: [{ selector: "p", lines: 3, chars: 180 }], vh: 900, vw: 1440, lang: "en",
  fonts: { families: [{ family: "D", kind: "web", count: 1 }], heading: { kind: "web", family: "D" }, body: { kind: "web", family: "D" } }, edge: { left: 48, right: 48 }, edgeText: { selector: "h1", distance: 48, side: "left" },
  blocks: [{ top: 0, bottom: 500, selector: "header" }, { top: 560, bottom: 1100, selector: "section" }], sections: [{ selector: "section", height: 540, titled: true }], hero: { h1: true, action: true, visual: true, visualKind: "svg" },
  surfaces: [{ selector: "::selection", surface: "selection", problems: 0, note: "themed" }], textBlocks: [], markupBlocks: [],
  ux: { images: { total: 1, bad: [] }, fields: { total: 0, bad: [] }, controls: { total: 1, bad: [] }, viewportMeta: "width=device-width, initial-scale=1" }, ...over });
const st = (items, c) => items.filter((i) => i.check === c);

test("auditor: design_raw_markup fails with the selector and snippet, passes on clean text, is not measured without probe facts, wide only", () => {
  assert.ok(DESIGN_STATIC_CHECKS.includes("design_raw_markup"));
  const bad = evaluateStatic(facts({ markupBlocks: [blk("**Cause:** stale", "main > p.lead")] }), { mode: "read", viewport: "wide", language: null });
  const [i] = st(bad, "design_raw_markup");
  assert.equal(i.status, "fail"); assert.equal(i.value, 1); assert.equal(i.threshold, "== 0"); assert.equal(i.selector, "main > p.lead");
  assert.match(i.note, /bold/); assert.match(i.note, /Cause/);
  assert.equal(st(evaluateStatic(facts(), { mode: "read", viewport: "wide", language: null }), "design_raw_markup")[0].status, "pass");
  assert.equal(st(evaluateStatic(facts({ markupBlocks: undefined }), { mode: "read", viewport: "wide", language: null }), "design_raw_markup")[0].status, "not_measured");
  assert.deepEqual(st(evaluateStatic(facts(), { mode: "read", viewport: "tablet", language: null }), "design_raw_markup"), []);
  const task = '- AC-1: shows "**Cause:** stale" literally';
  assert.equal(st(evaluateStatic(facts({ markupBlocks: [blk("**Cause:** stale")] }), { mode: "read", viewport: "wide", language: null, task }), "design_raw_markup")[0].status, "pass");
});

test("source lint: a template with raw markup in text is a blocking raw-markup-in-text finding; code, pre, script, style, comments and the task text are not", () => {
  const html = ["<main>", "<p>**Cause:** the cache</p>", "<pre>**kept** `literal`</pre>", "<code>`x`</code>", "<script>var a = '**s**';</script>", "<style>/* `x` */</style>", "<!-- **c** -->", "<p>All `good` here</p>", "<p>Plain</p>", "</main>"].join("\n");
  const f = lintMarkupText({ path: "index.html", text: html });
  assert.deepEqual(f.map((x) => [x.id, x.line]), [["raw-markup-in-text", 2], ["raw-markup-in-text", 8]]);
  assert.match(f[0].excerpt, /\*\*Cause:\*\*/);
  assert.deepEqual(lintMarkupText({ path: "index.html", text: "<p>{{ name }}</p>" }), [], "a template placeholder is the template's own syntax in the source");
  assert.equal(lintMarkupText({ path: "a.html", text: "<p>**Cause:** the cache</p>", task: 'shows "**Cause:** the cache"' }).length, 0);
  assert.deepEqual(lintMarkupText({ path: "a.css", text: "p::after{content:'**x**'}" }), []);
  const root = mktmp();
  writeFileSync(join(root, "index.html"), html);
  writeFileSync(join(root, "DESIGN.md"), "# D\n\n## Pattern justifications\n- raw-markup-in-text: we like it\n");
  const lint = lintProject({ root, approved: { "raw-markup-in-text": "0" } });
  const mine = lint.findings.filter((x) => x.id === "raw-markup-in-text");
  assert.equal(mine.length, 2);
  assert.ok(mine.every((x) => x.severity === "blocking" && x.justified === false), "no DESIGN.md rationale lowers it");
  assert.equal(validateLint(lint).valid, true, validateLint(lint).errors.join("\n"));
  assert.equal(lintProject({ root, task: 'x "**Cause:** the cache" y' }).findings.filter((x) => x.line === 2).length, 0);
});

const OK = { viewport_overflow: [0, "<= 0"], horizontal_scroll: [360, "<= 360"], hidden_interactive: [5, "> 1"], overlapping_interactive: [0, "== 0"], contrast: [7.1, ">= 4.5"], touch_target: [40, ">= 24"], focus_order: [0, "== 0"], focus_visible: [1, "== 1"] };
const VPS = [{ name: "phone", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1280, height: 800 }];
function build(f, languages = [], paths = ["index.html"]) {
  const dir = mktmp();
  mkdirSync(join(dir, "screenshots"));
  const png = (n) => { writeFileSync(join(dir, `screenshots/${n}.png`), `png ${n}`); return `screenshots/${n}.png`; };
  const config = { class: "STANDARD", base_url: "file:///app/", viewports: VPS, screens: [{ id: "home", path: "index.html", states: [{ name: "default", path: "index.html", ready: "main" }] }], criteria: [],
    design: { visitor_mode: "operate", screens: paths, ...(languages.length ? { languages } : {}) } };
  const cells = VPS.map((v) => ({ screen: "home", state: "default", viewport: v.name, screenshot: png(v.name), rendered: true, not_measured: [],
    items: CORE.filter((c) => c !== "state_rendered").map((check) => ({ check, selector: check === "horizontal_scroll" ? "html" : "body", value: OK[check][0], threshold: OK[check][1], status: "pass" })) }));
  const pages = [...new Set([...paths, ...languages.map((l) => l.path)])].map((path) => ({ path, viewports: ["wide", "tablet", "phone390"].map((viewport) => ({ viewport, screenshot: png(`${path}-${viewport}`), facts: { ...f(path), vw: viewport === "phone390" ? 390 : 1440 } })) }));
  const motion = { items: ["design_reduced_motion", "design_no_script_visible"].flatMap((check) => pages.map((p) => ({ check, screen: p.path, viewport: "wide", selector: "body", value: 0, threshold: "== 0", status: "pass" }))), scenes: [], not_measured: [] };
  const report = assemble({ tool: { kind: "headless-browser", name: "chromium" }, config, cells, network: { interception: "on", blocked: [] }, design: { pages, motion } }, dir);
  return { dir, report, check: (r = report) => validateReport(r, { root: dir }) };
}

test("report: raw markup on a page makes the result FAIL and the validator accepts the failed item", () => {
  const { report, check } = build(() => facts({ markupBlocks: [blk("**Cause:** stale")] }));
  assert.equal(report.result, "FAIL");
  const v = check();
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.ok(report.design.items.some((i) => i.check === "design_raw_markup" && i.status === "fail"));
  assert.equal(build(() => facts()).report.result, "PASS");
});

test("report: human checks are made from the page facts (language not English), one per page, and the validator requires them", () => {
  const { report, check } = build((p) => (p === "tr.html" ? facts({ lang: "tr", textVolume: { blocks: 12, chars: 900 } }) : facts()), [{ lang: "tr", path: "tr.html" }]);
  const hc = report.design.human_checks;
  assert.deepEqual(hc.map((h) => [h.path, h.lang, h.kind, h.blocks, h.chars]), [["tr.html", "tr", "language_naturalness", 12, 900]]);
  assert.match(hc[0].text, /naturalness/);
  const v = check();
  assert.equal(v.valid, true, v.errors.join("\n"));
  const gone = structuredClone(report); delete gone.design.human_checks;
  assert.match(check(gone).errors.join("\n"), /human_checks/);
  const odd = structuredClone(report); odd.design.human_checks[0].lang = "en";
  assert.equal(check(odd).valid, false, "an English entry is not a human check");
  const en = build(() => facts());
  assert.equal(en.report.design.human_checks, undefined, "an all-English report lists no human check");
  const detected = build((p) => (p === "de.html" ? facts({ lang: "de" }) : facts()), [], ["index.html", "de.html"]);
  assert.deepEqual(detected.report.design.human_checks.map((h) => [h.path, h.lang]), [["de.html", "de"]], "the html lang of a measured page counts without a languages[] entry");
  assert.equal(detected.check().valid, true, detected.check().errors.join("\n"));
});

test("source lint: a lone leading dash or hash is not a finding; a real multi-line raw list or heading with text is", () => {
  const f = (html) => lintMarkupText({ path: "a.html", text: html }).length;
  assert.equal(f("<p>- John, CEO</p>"), 0, "an attribution dash");
  assert.equal(f("<a href=\"/j\">- Jane</a>"), 0);
  assert.equal(f("<p># 1 pick of the year</p>"), 0);
  assert.equal(f("<p># Welcome home</p>"), 0, "a one line heading shape alone is not read in a source template");
  assert.equal(f("<p>- first item\n- second item\n- third</p>"), 1, "a two-item raw list");
  assert.equal(f("<p>1. one thing\n2. other thing</p>"), 1, "a numbered raw list");
  assert.equal(f("<div># Title here\nA paragraph that follows the heading.</div>"), 1, "a heading followed by a paragraph");
  assert.equal(f("<p>**Cause:** the cache</p>"), 1, "bold is still read in the source");
  assert.deepEqual(kinds("- John, CEO"), ["list"], "the rendered probe keeps the stricter rule");
});

test("raw markup: a dunder name is not underscore emphasis; a spaced or capitalised pair is", () => {
  assert.deepEqual(kinds("__init__ is magic"), []);
  assert.deepEqual(kinds("call __main__ first"), []);
  assert.deepEqual(kinds("This is __very important__ today"), ["underscore"]);
  assert.deepEqual(kinds("This is __Important__ today"), ["underscore"]);
});
