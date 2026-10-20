// visual-proof technical SEO group (A158): browser-less. Hand-made page facts go through assemble/seoEvaluate and the
// validator; no browser, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReport, CORE } from "../../skills/visual-proof/scripts/validate-visual.mjs";
import * as measure from "../../skills/visual-proof/scripts/measure.mjs";

const { assemble } = measure;
const seoEvaluate = (...a) => measure.seoEvaluate(...a); // namespace access: on a build without the group a test fails, not the whole file
const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "vp-seo-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const OK = { viewport_overflow: [0, "<= 0"], horizontal_scroll: [360, "<= 360"], hidden_interactive: [5, "> 1"], overlapping_interactive: [0, "== 0"],
  contrast: [7.1, ">= 4.5"], touch_target: [40, ">= 24"], focus_order: [0, "== 0"], focus_visible: [1, "== 1"] };
const BASE = "file:///app/";
const SITE = "https://example.org";

// One STANDARD screen x 2 viewports, every core check passing; `seo` is the config seo block, `rawSeo` the tool's facts.
function run(seo, rawSeo) {
  const dir = mktmp();
  mkdirSync(join(dir, "screenshots"));
  const vps = [{ name: "phone", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }];
  const config = { class: "STANDARD", base_url: BASE, viewports: vps, seo, screens: [{ id: "home", path: "index.html", states: [{ name: "default", path: "index.html", ready: "main" }] }], criteria: [] };
  const cells = vps.map((v) => {
    const screenshot = `screenshots/${v.name}.png`;
    writeFileSync(join(dir, screenshot), `png ${v.name}`);
    const items = CORE.filter((c) => c !== "state_rendered").map((check) => ({ check, selector: check === "horizontal_scroll" ? "html" : "body", value: OK[check][0], threshold: OK[check][1], status: "pass" }));
    return { screen: "home", state: "default", viewport: v.name, screenshot, rendered: true, items, not_measured: [] };
  });
  const report = assemble({ tool: { kind: "headless-browser", name: "chromium" }, config, cells, network: { interception: "on", blocked: [] }, ...(rawSeo ? { seo: rawSeo } : {}) }, dir);
  return { report, dir, v: validateReport(report, { root: dir }) };
}

// A healthy page fact set; overrides replace fields.
const page = (path, over = {}) => ({
  path, url: BASE + path, titles: ["T"], descriptions: ["D"], canonicals: [{ raw: `${SITE}/${path}`, href: `${SITE}/${path}` }], h1: 1,
  og_title: ["T"], og_image: [{ raw: "og.png", href: BASE + "og.png" }], jsonld: [], alternates: [], robots_meta: [], scripts: [], globals: [],
  requests: [], source: "<html></html>", x_robots: "", ...over });
const alt = (hreflang, p) => ({ hreflang, href: BASE + p });
const SITEFACTS = (sitemapPaths, exists = {}) => ({
  robots_txt: `User-agent: *\nDisallow:\nSitemap: ${SITE}/sitemap.xml\n`,
  sitemap_xml: `<urlset>${sitemapPaths.map((p) => `<url><loc>${SITE}/${p}</loc></url>`).join("")}</urlset>`,
  exists: { "index.html": true, "de/index.html": true, "og.png": true, ...exists }, alternates: {} });
const SEO = { public_html: true, pages: ["index.html", "de/index.html"], site_url: SITE };

test("non-reciprocal hreflang and a page missing from the sitemap are blocking findings and the result is FAIL", () => {
  const en = page("index.html", { alternates: [alt("en", "index.html"), alt("de", "de/index.html"), alt("x-default", "index.html")] });
  const de = page("de/index.html", { alternates: [alt("de", "de/index.html")] }); // does not list en back
  const { report, v } = run(SEO, { pages: [en, de], site: SITEFACTS(["index.html"]) }); // sitemap lacks de/index.html
  assert.equal(report.result, "FAIL");
  const failed = report.seo.items.filter((m) => m.status === "fail");
  assert.ok(failed.some((m) => m.check === "seo_hreflang" && /not reciprocal/.test(m.note)), JSON.stringify(failed));
  assert.ok(failed.some((m) => m.check === "seo_sitemap" && /de\/index\.html is not listed/.test(m.note)), JSON.stringify(failed));
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.equal(v.computed, "FAIL");
  assert.ok(v.rows.some((r) => r.startsWith("blocking|") && /seo_hreflang/.test(r)));
  assert.ok(v.rows.some((r) => r.startsWith("blocking|site:sitemap.xml") && /seo_sitemap/.test(r)));
});

test("a healthy bilingual site passes the seo group", () => {
  const en = page("index.html", { alternates: [alt("en", "index.html"), alt("de", "de/index.html"), alt("x-default", "index.html")] });
  const de = page("de/index.html", { alternates: [alt("en", "index.html"), alt("de", "de/index.html"), alt("x-default", "index.html")] });
  const { report, v } = run(SEO, { pages: [en, de], site: SITEFACTS(["index.html", "de/index.html"]) });
  assert.deepEqual(report.seo.items.filter((m) => m.status !== "pass"), []);
  assert.equal(report.result, "PASS");
  assert.equal(v.valid, true, v.errors.join("\n"));
});

test("a project without HTML: the seo group does not run, and the validator rejects items next to the note", () => {
  for (const [seo, rawSeo] of [[{ public_html: false }, undefined], [{ public_html: true }, { not_applicable: true }]]) {
    const { report, v } = run(seo, rawSeo);
    assert.deepEqual(report.seo, { status: "not_applicable", note: "seo not applicable: no public HTML pages" });
    assert.equal(v.valid, true, v.errors.join("\n"));
    assert.equal(report.result, "PASS");
    assert.equal(v.rows.filter((r) => /seo/.test(r)).length, 0);
  }
  const { report, dir } = run({ public_html: false });
  const bad = { ...report, seo: { ...report.seo, items: [{ id: "S-1", check: "seo_title", page: "index.html", selector: "title", value: 0, threshold: "== 0", status: "pass", evidence: "[]" }] } };
  assert.equal(validateReport(bad, { root: dir }).valid, false);
  assert.match(validateReport(bad, { root: dir }).errors.join("\n"), /seo not_applicable: the group does not run/);
  const noted = { ...report, seo: { status: "not_applicable", note: "nothing to see" } };
  assert.equal(validateReport(noted, { root: dir }).valid, false);
});

test("an analytics script loaded without consent is caught; a project without analytics gets no analytics item", () => {
  const dirty = page("index.html", { scripts: ["https://analytics.example.org/tag.js?id=G-1"], globals: ["dataLayer"], requests: ["https://analytics.example.org/tag.js?id=G-1"], source: '<script src="https://analytics.example.org/tag.js?id=G-1"></script>' });
  const r = seoEvaluate([dirty], SITEFACTS(["index.html"]), { base_url: BASE, site_url: SITE });
  const a = r.items.find((m) => m.check === "seo_analytics_consent");
  assert.equal(a.status, "fail");
  assert.match(a.note, /before consent: third-party request https:\/\/analytics\.example\.org/);
  assert.deepEqual(r.pages[0].analytics_detected, ["analytics", "dataLayer"]);
  const full = run({ ...SEO, pages: ["index.html"] }, { pages: [dirty], site: SITEFACTS(["index.html"]) });
  assert.equal(full.report.result, "FAIL");
  assert.equal(full.v.valid, true, full.v.errors.join("\n"));
  assert.ok(full.v.rows.some((x) => x.startsWith("blocking|") && /seo_analytics_consent/.test(x)));

  const clean = seoEvaluate([page("index.html")], SITEFACTS(["index.html"]), { base_url: BASE, site_url: SITE });
  assert.equal(clean.items.some((m) => m.check === "seo_analytics_consent"), false);
  assert.equal(clean.pages[0].analytics_detected, undefined);
  assert.equal(JSON.stringify(clean).toLowerCase().includes("analytics"), false);
});

test("a robots-blocked page is skipped; unreadable facts are not_measured, which is info and never blocking", () => {
  const blocked = page("de/index.html", { robots_meta: ["noindex, follow"], titles: [] }); // would fail seo_title if measured
  const r = seoEvaluate([page("index.html"), blocked], SITEFACTS(["index.html"]), { base_url: BASE, site_url: SITE });
  assert.deepEqual(r.pages.find((p) => p.path === "de/index.html"), { path: "de/index.html", status: "not_applicable", reason: "robots", detail: "meta robots noindex" });
  assert.equal(r.items.some((m) => m.page === "de/index.html"), false);

  const { report, v } = run({ ...SEO, pages: ["index.html"] }, { pages: [page("index.html")], site: { robots_txt: null, sitemap_xml: null, exists: { "index.html": true, "og.png": true }, alternates: {} } });
  const nm = report.seo.items.filter((m) => m.status === "not_measured");
  assert.deepEqual(nm.map((m) => m.check).sort(), ["seo_robots", "seo_sitemap"]);
  assert.equal(report.result, "PASS");
  assert.equal(v.valid, true, v.errors.join("\n"));
  assert.ok(v.rows.filter((x) => /seo_(sitemap|robots)/.test(x)).every((x) => x.startsWith("info|")));
});

test("an inert consent-gated placeholder (type=text/plain) is not a load; the same host as an executable script fails", () => {
  // The probe lists only executable scripts in `scripts` (no type, module, JavaScript MIME); an inert placeholder stays in the source only.
  const placeholder = '<script type="text/plain" data-src="https://analytics.example.org/tag.js"></script>';
  const inert = page("index.html", { scripts: [], source: `<html>${placeholder}</html>` });
  const ri = seoEvaluate([inert], SITEFACTS(["index.html"]), { base_url: BASE, site_url: SITE });
  assert.deepEqual(ri.pages[0].analytics_detected, ["analytics"]); // mentioned in the source: a candidate by name, information only (A160) ...
  assert.equal(ri.items.some((m) => m.check === "seo_analytics_consent"), false); // ... no item: nothing requested before consent
  const full = run({ ...SEO, pages: ["index.html"] }, { pages: [inert], site: SITEFACTS(["index.html"]) });
  assert.equal(full.report.result, "PASS");
  assert.equal(full.v.valid, true, full.v.errors.join("\n"));

  const live = page("index.html", { scripts: ["https://analytics.example.org/tag.js"], requests: ["https://analytics.example.org/tag.js"], source: `<html>${placeholder}</html>` });
  const rl = seoEvaluate([live], SITEFACTS(["index.html"]), { base_url: BASE, site_url: SITE });
  const al = rl.items.find((m) => m.check === "seo_analytics_consent");
  assert.equal(al.status, "fail");
  assert.match(al.note, /before consent: third-party request https:\/\/analytics\.example\.org/);
});

const analyticsCfg = (analytics) => ({ class: "STANDARD", base_url: BASE, viewports: [{ name: "a", width: 360, height: 740 }, { name: "b", width: 768, height: 1024 }],
  screens: [{ id: "home", path: "index.html", states: [{ name: "default", path: "index.html", ready: "main" }] }], seo: { public_html: true, analytics } });

test("seo.analytics {hosts, globals} is validated by the config check", () => {
  const errs = (a) => measure.checkConfig(analyticsCfg(a)).join("\n");
  assert.equal(errs({ hosts: ["stats.example.net"], globals: ["siteStats"] }), "");
  assert.equal(errs(undefined), "");
  for (const bad of ["stats.example.net", [], { hosts: "stats.example.net" }, { hosts: [1] }, { globals: "siteStats" }, { globals: [{}] }, { hosts: [""] }]) {
    assert.match(errs(bad), /seo\.analytics/, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a project-named analytics host and global (seo.analytics) are detected and fail when loaded without consent", () => {
  assert.equal(measure.checkConfig(analyticsCfg({ hosts: ["collect.example.net"], globals: ["siteStats"] })).join("\n"), "");
  // collect.example.net holds no generic analytics word, so only the project list can name it.
  const opt = { base_url: BASE, site_url: SITE, analytics: { hosts: ["collect.example.net"], globals: ["siteStats"] } };
  const dirty = page("index.html", { scripts: ["https://collect.example.net/a.js"], requests: ["https://collect.example.net/a.js"], globals: ["siteStats"], source: "<html></html>" });
  const withList = seoEvaluate([dirty], SITEFACTS(["index.html"]), opt);
  assert.deepEqual(withList.pages[0].analytics_detected, ["collect.example.net", "siteStats"]);
  const a = withList.items.find((m) => m.check === "seo_analytics_consent");
  assert.equal(a.status, "fail");
  assert.match(a.note, /before consent: third-party request https:\/\/collect\.example\.net/);
  const without = seoEvaluate([dirty], SITEFACTS(["index.html"]), { base_url: BASE, site_url: SITE });
  assert.equal(without.items.some((m) => m.check === "seo_analytics_consent"), false);
});

test("a robots not_applicable page without a non-empty detail is rejected by the validator", () => {
  const blocked = page("de/index.html", { robots_meta: ["noindex"] });
  const { report, dir } = run({ ...SEO, pages: ["index.html", "de/index.html"] }, { pages: [page("index.html"), blocked], site: SITEFACTS(["index.html"]) });
  assert.equal(validateReport(report, { root: dir }).valid, true);
  for (const detail of [undefined, "", "   "]) {
    const pages = report.seo.pages.map((p) => (p.path === "de/index.html" ? { path: p.path, status: p.status, reason: p.reason, ...(detail === undefined ? {} : { detail }) } : p));
    const r = validateReport({ ...report, seo: { ...report.seo, pages } }, { root: dir });
    assert.equal(r.valid, false, `accepted detail ${JSON.stringify(detail)}`);
    assert.match(r.errors.join("\n"), /not_applicable needs a non-empty detail/);
  }
});
