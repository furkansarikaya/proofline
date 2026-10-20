// visual-proof SEO, real-browser checks (A161, issue 137). The inert-script filter, initiator capture, the third-party-before-consent
// rule and the first-party site_url run in a real Chrome here, against fixture pages served by a localhost static server started
// by the test (http on 127.0.0.1, random port; "third party" is the same server under the host name `localhost`, which the
// request guard blocks, so no network is used). The tests SKIP when `measure.mjs --detect` finds no browser (CI without one).
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detect } from "../../skills/visual-proof/scripts/measure.mjs";

const MEASURE = fileURLToPath(new URL("../../skills/visual-proof/scripts/measure.mjs", import.meta.url));
const BROWSER = detect({ repo: tmpdir() }).kind === "headless-browser";
const skip = !BROWSER && "no browser installed (measure.mjs --detect)";

const dirs = [];
let server, PORT, FIRST, THIRD;
const hits = [];
const html = (body, head = "") => `<!doctype html><html lang=en><head><meta charset=utf-8><title>t</title>${head}<meta name=viewport content="width=device-width"></head><body><main id=m><h1>x</h1>${body}</main></body></html>`;
const PAGES = {
  // a consent placeholder: not an executable script, so nothing is requested
  "/inert.html": () => html(`<script type="text/plain" data-consent src="${THIRD}/analytics/consent-gated.js"></script>`),
  // an executable analytics-shaped third-party script: requested on load, before any consent
  "/tag.html": () => html(`<script src="${THIRD}/analytics/tag.js"></script>`),
  // a first-party script that makes third-party requests with neutral URLs (fetch and a dynamically added script element): the
  // browser reports the script as initiator. (Chrome reports an <img> load with no script, so an image pixel has no initiator.)
  "/init.html": () => html(`<script src="/js/analytics-loader.js"></script>`),
  "/js/analytics-loader.js": () => `fetch("${THIRD}/api/send").catch(() => {});
    const s = document.createElement("script"); s.src = "${THIRD}/js/dyn.js"; document.head.append(s);`,
  // a parser-initiated third-party stylesheet on a page whose own path holds an analytics word: the stylesheet is not analytics
  "/stats/sheet.html": () => html(`<p>sheet</p>`, `<link rel=stylesheet href="${THIRD}/css/site.css">`),
  "/css/site.css": () => "body{margin:0}",
  "/analytics/tag.js": () => "window.__t = 1;",
  "/analytics/consent-gated.js": () => "window.__g = 1;",
  "/js/dyn.js": () => "window.__d = 1;",
  "/api/send": () => "ok",
  "/robots.txt": () => "User-agent: *\nDisallow:\n",
};
before(async () => {
  server = http.createServer((q, r) => {
    const path = new URL(q.url, "http://x").pathname;
    hits.push(`${q.headers.host}${path}`);
    const f = PAGES[path];
    if (!f) { r.writeHead(404).end(); return; }
    r.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html" : path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".txt") ? "text/plain" : "text/plain" }).end(f());
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  PORT = server.address().port; FIRST = `http://127.0.0.1:${PORT}`; THIRD = `http://localhost:${PORT}`;
});
after(() => { server?.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function run(seoExtra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vp-seo-br-")); dirs.push(dir);
  const out = join(dir, "out");
  const state = [{ name: "default", ready: "#m" }];
  const pages = ["/inert.html", "/tag.html", "/init.html", "/stats/sheet.html"].map((p) => p.slice(1));
  const cfg = { class: "STANDARD", base_url: FIRST + "/",
    viewports: [{ name: "phone", width: 360, height: 740 }, { name: "desktop", width: 1280, height: 800 }],
    screens: pages.map((p) => ({ id: p.replace(/\W+/g, "_"), path: p, states: state })),
    seo: { pages, ...seoExtra } };
  writeFileSync(join(dir, "visual.json"), JSON.stringify(cfg));
  const args = [MEASURE, "--config", join(dir, "visual.json"), "--out", out, "--repo", dir, ...(process.env.CI ? ["--no-sandbox"] : [])];
  const r = await new Promise((ok) => { const c = spawn(process.execPath, args); let se = ""; c.stderr.on("data", (d) => { se += d; }); c.on("close", (code) => ok({ code, se })); });
  assert.equal(r.code, 0, r.se);
  return JSON.parse(readFileSync(join(out, "report.json"), "utf8")).seo;
}
const pageOf = (seo, p) => seo.pages.find((x) => x.path === p);
const consent = (seo, p) => seo.items.find((m) => m.check === "seo_analytics_consent" && m.page === p);

test("browser: inert script is not a load; an executable analytics-shaped third-party script and a script-initiated request fail before consent", { skip }, async () => {
  hits.length = 0;
  const seo = await run();
  // 1. <script type="text/plain" data-consent src=...>: no request was made for it, no detection, no item
  assert.equal(hits.some((h) => h.endsWith("/analytics/consent-gated.js")), false, "the browser fetched an inert script");
  assert.equal(consent(seo, "inert.html"), undefined, "an inert consent placeholder failed the check");
  assert.equal(pageOf(seo, "inert.html").status, "measured");
  assert.deepEqual(pageOf(seo, "inert.html").analytics_before_consent ?? [], [], "nothing loaded before consent"); // the name in the source is only a candidate (info)
  // 2. third-party-before-consent: an executable analytics-shaped script is requested on load
  const tag = consent(seo, "tag.html");
  assert.equal(tag?.status, "fail", JSON.stringify(seo.pages));
  assert.match(tag.note, /before consent: third-party request http:\/\/localhost:\d+\/analytics\/tag\.js/);
  assert.deepEqual(pageOf(seo, "tag.html").analytics_before_consent, [`${THIRD}/analytics/tag.js`]);
  // 3. initiator capture: neutral third-party requests (fetch, dynamic script) made by a first-party analytics-named script carries that script as initiator
  const init = consent(seo, "init.html");
  assert.equal(init?.status, "fail", "the script initiator was not captured");
  for (const u of ["/api/send", "/js/dyn.js"]) assert.match(init.note, new RegExp(`third-party request ${THIRD}${u.replace(".", "\\.")} \\(initiated by ${FIRST}/js/analytics-loader\\.js\\)`), init.note);
  // 4. a parser-initiated stylesheet does not get the document URL as initiator: the /stats/ page's neutral sheet is no analytics
  assert.equal(consent(seo, "stats/sheet.html"), undefined, "a parser-initiated stylesheet was attributed to the document");
  assert.deepEqual(pageOf(seo, "stats/sheet.html").third_party_requests, [`${THIRD}/css/site.css`]);
});

test("browser: site_url makes the deployed origin first party, so its analytics-shaped script is not a third-party load", { skip }, async () => {
  const seo = await run({ site_url: THIRD });
  assert.equal(consent(seo, "tag.html"), undefined, "the site's own deployed origin was counted third party");
  assert.equal(pageOf(seo, "tag.html").third_party_requests, undefined);
  assert.equal(consent(seo, "init.html"), undefined, "a request to the deployed origin failed");
});
