#!/usr/bin/env node
// visual-proof measurement. No dependencies: drives an already installed Chromium-family browser over the
// DevTools protocol (child process + Node's global WebSocket, Node >= 22). Installs nothing.
//
//   node measure.mjs --detect [--repo DIR]                 print the detected tooling as JSON (kind none => UNSUPPORTED)
//   node measure.mjs --config visual.json --out DIR [--repo DIR] [--browser PATH] [--timeout MS] [--no-sandbox]
//                                                          measure; writes DIR/report.json and DIR/screenshots/
//   node measure.mjs --print-probe                         print the page probe (for a project tool or runtime adapter)
//   node measure.mjs --print-design-probe                  print the design-audit probe (facts of design-audit.mjs evaluateStatic)
//   node measure.mjs --assemble raw.json --out DIR         build DIR/report.json from cells measured by another tool
//
// Exit codes: 0 report written (any result, UNSUPPORTED included), 2 usage, config or I/O error.
// The report is validated with validate-visual.mjs; judged items and the regression record are added by QA.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE, CLASSES, MIN_VIEWPORTS, INTERACTION_CHECKS, SCHEMA, SEO_NOT_APPLICABLE_NOTE, SEO_SITE, requiredCells, validateReport } from "./validate-visual.mjs";
import { DESIGN_MODES, DESIGN_PROBE, DESIGN_VIEWPORTS, assembleDesign, designPages } from "./design-audit.mjs";
import { motionAudit } from "./motion-audit.mjs";
import { IMAGES_PROBE, ledgerItems } from "./ledger.mjs";

const BROWSER_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge", "microsoft-edge-stable", "msedge", "brave-browser"];
const APP_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const PROJECT_TOOLS = ["@playwright/test", "playwright", "playwright-core", "puppeteer", "puppeteer-core", "cypress", "webdriverio", "@wdio/cli", "selenium-webdriver"];

const executable = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

// Detection only: a project browser-test dependency, else a browser binary on PATH or in the standard macOS
// application folders. Nothing is downloaded or installed.
export function detect({ repo = process.cwd(), env = process.env, exists = executable, browser } = {}) {
  let project = null;
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const name = PROJECT_TOOLS.find((t) => deps[t]);
    if (name) project = { name, installed: existsSync(join(repo, "node_modules", name)) };
  } catch { /* no package.json: no project tool */ }
  const candidates = browser ? [browser] : [
    ...(env.PATH || "").split(delimiter).filter(Boolean).flatMap((d) => BROWSER_NAMES.map((n) => join(d, n))),
    ...APP_PATHS,
  ];
  const path = candidates.find((p) => exists(p));
  const axe = join(repo, "node_modules", "axe-core", "axe.min.js");
  const result = { project_tool: project, a11y_scanner: existsSync(axe) ? { name: "axe-core", path: axe } : null };
  if (path) return { kind: "headless-browser", name: path.split(/[\\/]/).pop(), path, detected_by: browser ? "--browser" : "PATH or standard application folder", ...result };
  if (project?.installed) return { kind: "project-tool", name: project.name, detected_by: "package.json + node_modules", note: "no browser binary found; drive the probe with the project's tool (--print-probe, --assemble)", ...result };
  return { kind: "none", name: null, reason: `no Chromium-family browser on PATH or in the standard application folders${project ? `; project tool ${project.name} is declared but not installed` : "; no browser-test dependency in package.json"}`, ...result };
}

// --- page probe (runs inside the page; must stay self-contained) -------------------------------------------
function probeSource() {
  /* eslint-disable no-undef */
  if (window.__vp) return true;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=""],[contenteditable=true]';
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "none";
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  // Visually hidden: not rendered, invisible, clipped to nothing (the sr-only pattern) or parked left of the page.
  const hidden = (el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (cs.display === "none" || cs.visibility !== "visible" || area(r) <= 1) return true;
    if (/rect\(0px,? 0px,? 0px,? 0px\)/.test(cs.clip) || /inset\(50%/.test(cs.clipPath)) return true;
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return true;
    for (let e = el; e; e = e.parentElement) if (getComputedStyle(e).opacity === "0") return true;
    return false;
  };
  // Inside a scroll or clip container other than html/body (an intentional carousel, a truncating box).
  const clipped = (el) => {
    for (let e = el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (getComputedStyle(e).overflowX !== "visible") return true;
    }
    return false;
  };
  // Content the user cannot reach: a closed <details>, [hidden], [inert]. Its overflow counts only when the page itself scrolls sideways.
  const closed = (el) => !!el.closest("[hidden],[inert],details:not([open]) > :not(summary)");
  // Content the state's setup script injected (an iframe, a probe note) is registered with mark(el) and is never measured.
  // mark lives only in this closure; the first call returns it and open() hands it to the setup script as its argument,
  // so it is not a page-readable global. shortcut: the setup runs in the page's own JS world, so page code that
  // intercepts the setup could still obtain it; the gate guards against convenience and accident, not a hostile page.
  const marks = [], marked = new WeakSet();
  const mark = (el) => { marks.push(el); marked.add(el); return el; };
  const isProbe = (e) => { for (let x = e; x; x = x.parentElement) if (marked.has(x)) return true; return false; };
  const tabbables = () => [...document.querySelectorAll(INTERACTIVE)].filter((e) => e.tabIndex >= 0 && !e.disabled && !e.closest("[inert]") && !e.closest("details:not([open]) > :not(summary)") && !isProbe(e)
    && e.getClientRects().length > 0 && getComputedStyle(e).visibility === "visible");
  const parse = (c) => {
    const m = /^rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+%?))?\)$/.exec(c);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  };
  const blend = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const background = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return { error: "background image under the text" };
      const c = parse(cs.backgroundColor);
      if (!c) return { error: `unparsed background colour ${cs.backgroundColor}` };
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    return { color: layers.reverse().reduce((base, l) => blend(l, base), [255, 255, 255, 1]) };
  };

  window.__vp = {
    sel,
    T: [],
    tabbables() { this.T = tabbables(); this.seen = new Set(); return this.T.length; },
    // One Tab stop: "end" when focus is back on the document or on an element already visited; otherwise the
    // stop's index in T, or -1 for a stop T does not list (a keyboard-focusable scroller, an iframe).
    step() {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement || this.seen.has(a)) return "end";
      this.seen.add(a);
      return this.T.indexOf(a);
    },
    positive() { return [...document.querySelectorAll("[tabindex]")].filter((e) => e.tabIndex > 0).map(sel); },
    selectorOf(i) { return sel(this.T[i]); },
    clipOf(i) {
      const el = this.T[i];
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.left + scrollX - 4), y: Math.max(0, r.top + scrollY - 4), width: Math.max(1, r.width + 8), height: Math.max(1, r.height + 8), scale: 1 };
    },
    // Blur, and move the sequential-focus starting point back to the top: blur() and scrollTo(0, 0) leave it on
    // the last element focused or scrolled into view, so the next Tab would start mid-page and skip everything before it.
    blur() {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const b = document.body, t = b.getAttribute("tabindex");
      b.tabIndex = -1; b.focus({ preventScroll: true }); b.blur();
      if (t === null) b.removeAttribute("tabindex"); else b.setAttribute("tabindex", t);
    },
    // Technical SEO facts of the loaded page (A158); the checks themselves run in seoEvaluate. names = analytics globals to look for.
    seo(names) {
      const q = (x) => [...document.querySelectorAll(x)];
      const content = (e) => (e.getAttribute("content") || "").trim();
      return {
        url: location.href,
        titles: q("title").filter((e) => !e.closest("svg")).map((e) => e.textContent.trim()),
        descriptions: q('meta[name="description" i]').map(content),
        canonicals: q('link[rel~="canonical" i]').map((e) => ({ raw: (e.getAttribute("href") || "").trim(), href: e.href })),
        h1: q("h1").length,
        og_title: q('meta[property="og:title"]').map(content),
        og_image: q('meta[property="og:image"]').map((e) => ({ raw: content(e), href: content(e) ? new URL(content(e), document.baseURI).href : "" })),
        jsonld: q('script[type="application/ld+json"]').map((e) => e.textContent),
        alternates: q('link[rel~="alternate" i][hreflang]').map((e) => ({ hreflang: (e.getAttribute("hreflang") || "").trim(), href: e.href })),
        robots_meta: q('meta[name="robots" i],meta[name="googlebot" i]').map(content),
        // only a script element that can execute: no type, "module" or a JavaScript MIME type; a placeholder such as
        // <script type="text/plain" data-consent src=...> never runs and is not listed
        scripts: q("script[src]").filter((e) => { const t = (e.getAttribute("type") || "").trim().toLowerCase().split(";")[0].trim(); return t === "" || t === "module" || /^(application|text)\/(x-)?(java|ecma)script$/.test(t); }).map((e) => e.src),
        globals: names.filter((n) => n in window),
      };
    },
    visible(s) { const el = document.querySelector(s); return !!el && !hidden(el); },
    hscroll() { return document.documentElement.scrollWidth > document.documentElement.clientWidth; },
    measure(opts) {
      const probes = marks.filter((e) => e.isConnected).map((e) => [e, e.style.getPropertyValue("display"), e.style.getPropertyPriority("display")]);
      for (const [e] of probes) e.style.setProperty("display", "none", "important");
      try { return this.run(opts); } finally { for (const [e, v, pr] of probes) e.style.setProperty("display", v, pr); }
    },
    run(opts) {
      const items = [], nm = [];
      const de = document.documentElement, cw = de.clientWidth;
      const add = (check, el, value, threshold, ok, extra = {}) => items.push({ check, selector: typeof el === "string" ? el : sel(el), value, threshold, status: ok ? "pass" : "fail", ...extra });
      const x0 = scrollX, y0 = scrollY;

      add("horizontal_scroll", "html", de.scrollWidth, `<= ${cw}`, de.scrollWidth <= cw, { client_width: cw });

      const offenders = [];
      for (const el of [...document.body.querySelectorAll("*")].slice(0, 5000)) {
        if (offenders.some((o) => o.contains(el)) || hidden(el) || clipped(el) || (de.scrollWidth <= cw && closed(el))) continue;
        const r = el.getBoundingClientRect();
        const over = Math.ceil(Math.max(r.right + scrollX - cw, -(r.left + scrollX)));
        if (over > 0) { offenders.push(el); add("viewport_overflow", el, over, "<= 0", false, { note: `extends ${over}px beyond the ${cw}px viewport` }); }
      }
      if (!offenders.length) add("viewport_overflow", "body", 0, "<= 0", true);

      const T = tabbables();
      let minArea = Infinity, hiddenBad = 0;
      for (const el of T) {
        let a = area(el.getBoundingClientRect());
        if (hidden(el)) {
          el.focus();
          const shown = !hidden(el);
          a = shown ? area(el.getBoundingClientRect()) : 0;
          el.blur();
          if (!shown) { hiddenBad++; add("hidden_interactive", el, Math.floor(a), "> 1", false, { note: "focusable but invisible even when focused" }); continue; }
        }
        minArea = Math.min(minArea, Math.floor(a));
      }
      if (!hiddenBad) items.push(T.length ? { check: "hidden_interactive", selector: "body", value: minArea, threshold: "> 1", status: "pass" }
        : { check: "hidden_interactive", selector: "body", value: "no focusable element", threshold: "> 1", status: "not_applicable" });

      const shown = T.filter((e) => !hidden(e));
      let overlapBad = 0;
      for (const el of shown) {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) { nm.push({ scope: "element", check: "overlapping_interactive", selector: sel(el), reason: "centre outside the viewport after scrolling (clipped)" }); continue; }
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) { overlapBad++; add("overlapping_interactive", el, 1, "== 0", false, { note: `covered by ${sel(hit)}` }); }
      }
      if (!overlapBad) items.push(shown.length ? { check: "overlapping_interactive", selector: "body", value: 0, threshold: "== 0", status: "pass" }
        : { check: "overlapping_interactive", selector: "body", value: "no visible interactive element", threshold: "== 0", status: "not_applicable" });
      scrollTo(x0, y0);

      const groups = {};
      let contrastBad = 0;
      for (const el of document.body.querySelectorAll("*")) {
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || hidden(el) || el.closest(":disabled")) continue;
        const cs = getComputedStyle(el), fg = parse(cs.color), bg = background(el);
        if (!fg || bg.error) { nm.push({ scope: "element", check: "contrast", selector: sel(el), reason: bg.error || `unparsed text colour ${cs.color}` }); continue; }
        const f = fg[3] < 1 ? blend(fg, bg.color) : fg;
        const l1 = lum(f), l2 = lum(bg.color);
        const ratio = Math.floor(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
        const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
        const t = large ? 3 : 4.5;
        const font = { font_size_px: size, font_weight: Number(cs.fontWeight) || 400 };
        if (ratio < t) { contrastBad++; add("contrast", el, ratio, `>= ${t}`, false, { note: `${cs.color} on rgb(${bg.color.slice(0, 3).map(Math.round).join(", ")}), ${size}px${large ? ", large text" : ""}`, ...font }); }
        else if (!groups[t] || ratio < groups[t].value) groups[t] = { value: ratio, selector: sel(el), font };
      }
      if (!contrastBad) {
        const g = Object.entries(groups);
        if (!g.length) items.push({ check: "contrast", selector: "body", value: "no visible text", threshold: ">= 4.5", status: "not_applicable" });
        for (const [t, v] of g) add("contrast", v.selector, v.value, `>= ${t}`, true, { ...(t === "3" ? { note: "large text" } : {}), ...v.font });
      }

      const min = opts.touchTargetMin || 24;
      const inline = (el) => el.tagName === "A" && getComputedStyle(el).display === "inline" && el.parentElement && el.parentElement.textContent.trim().length > el.textContent.trim().length;
      const targets = shown.filter((e) => !inline(e)).map((e) => ({ el: e, r: e.getBoundingClientRect() }));
      const small = (t) => Math.min(t.r.width, t.r.height) < min;
      const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
      const distRect = ([x, y], r) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      // WCAG 2.5.8 spacing exception (24px minimum only): a 24px circle on the target meets no other target.
      const spaced = (t) => min === 24 && targets.every((o) => o === t || (small(o) ? Math.hypot(centre(t.r)[0] - centre(o.r)[0], centre(t.r)[1] - centre(o.r)[1]) >= 24 : distRect(centre(t.r), o.r) >= 12));
      let targetBad = 0, minDim = Infinity;
      const exempt = [];
      for (const t of targets) {
        const d = Math.floor(Math.min(t.r.width, t.r.height) * 10) / 10;
        if (small(t) && spaced(t)) { exempt.push(sel(t.el)); continue; }
        if (small(t)) { targetBad++; add("touch_target", t.el, d, `>= ${min}`, false, { note: `${Math.round(t.r.width)}x${Math.round(t.r.height)}px` }); }
        else minDim = Math.min(minDim, d);
      }
      if (!targetBad) items.push(minDim < Infinity ? { check: "touch_target", selector: "body", value: minDim, threshold: `>= ${min}`, status: "pass", ...(exempt.length ? { exempt_spacing: exempt } : {}) }
        : { check: "touch_target", selector: "body", value: "no non-exempt target", threshold: `>= ${min}`, status: "not_applicable", ...(exempt.length ? { exempt_spacing: exempt } : {}) });
      return { items, not_measured: nm };
    },
  };
  return mark;
}
export const PROBE = `(${probeSource.toString()})()`;


// --- technical SEO (A158) ----------------------------------------------------------------------------------
// Analytics detection by shape, not by vendor: a host or path word that names the job (analytics, tracker, ...) and
// the neutral global `dataLayer`. A project names its own vendor in visual.json `seo.analytics` ({ hosts, globals }).
// A name is only a candidate (info). "Loaded" is measured by behaviour (A160): a request to a THIRD-PARTY host made while the
// page loads, before any consent interaction, that belongs to a candidate (its URL matches the generic words or the project's
// `seo.analytics` hosts, or its initiator is a candidate script). A page that only defines `dataLayer`, or serves a file named
// pixel-art.js from its own origin, loaded nothing.
export const ANALYTICS_WORDS = ["analytics", "tracker", "tracking", "telemetry", "metrics", "stats", "beacon", "pixel", "tag-manager"];
const WORD_RE = /(?:^|[^a-z0-9])(analytics|tracker|tracking|telemetry|metrics|stats|beacon|pixel|tag-?manager)(?![a-z0-9])/i;
export const ANALYTICS_GLOBALS = ["dataLayer"];
export const analyticsGlobals = (opt) => [...new Set([...ANALYTICS_GLOBALS, ...(opt?.analytics?.globals || [])])];
// The generic label (or the user's own host) a URL matches, else null.
export function analyticsUrlLabel(u, opt) {
  const t = String(u || "");
  for (const h of opt?.analytics?.hosts || []) if (h && t.toLowerCase().includes(String(h).toLowerCase())) return h;
  const m = WORD_RE.exec(t);
  return m ? m[1].toLowerCase().replace("tagmanager", "tag-manager") : null;
}
const srcUrls = (html) => [...String(html || "").matchAll(/\b(?:src|data-src)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]);

const LANG_TAG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
const clip = (v, n = 300) => { const t = typeof v === "string" ? v : JSON.stringify(v); return t.length > n ? t.slice(0, n - 3) + "..." : t; };

// A URL as a path under the site root (the base_url folder), or null when it names another site. A file: page and
// the base_url origin map by their position under the folder; the site's public origin (config seo.site_url, or the
// origin the page declares) maps by its path, because a canonical points at the deployed address.
// Never throws: every run of valid escapes is decoded, a malformed one (`%te`, a lone `%`, an invalid UTF-8 run) stays as written.
const safeDecode = (t) => String(t).replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
// A URL path as a site path: percent-escapes are decoded (a malformed one stays as written, it never throws) except `%2F`, `%25`, `%3F`
// and `%23`, which stay encoded (upper-case hex): `/a%2Fb` is one segment, not `/a/b`, and a robots.txt rule `/a/b` must not block it.
const decodePath = (t) => String(t).split(/(%(?:2F|25|3F|23))/i).map((x, i) => (i % 2 ? x.toUpperCase() : safeDecode(x))).join("");
function siteRel(href, ctx) {
  let u, b;
  try { b = new URL(ctx.base); u = new URL(href, b); } catch { return null; }
  let rel;
  const dir = decodePath(b.pathname.replace(/[^/]*$/, ""));
  if (b.protocol === "file:" ? u.protocol === "file:" : u.origin === b.origin) {
    const p = decodePath(u.pathname);
    rel = p.startsWith(dir) ? p.slice(dir.length) : p.replace(/^\//, "");
  } else if (ctx.origins.has(u.origin)) rel = decodePath(u.pathname).replace(/^\//, "");
  else return null;
  return rel;
}
// The same path with a directory address completed to its file (`a/` -> `a/index.html`).
function siteRef(href, ctx) {
  let rel = siteRel(href, ctx);
  if (rel === null) return null;
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  return rel;
}
// Two spellings of one page: `a/`, `a/index.html`, `a.html` and `a`.
const pageKey = (rel) => rel.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "").replace(/\/$/, "");
export const siteCandidates = (rel) => [...new Set([rel, ...(/\.[a-z0-9]+$/i.test(rel) ? [] : [rel + ".html", rel + "/index.html"])])];

// robots.txt per RFC 9309 (A160): is `rel` (site-root relative) disallowed for the crawler `bot` (a product token such as
// "googlebot")? The groups whose user-agent token equals the bot's token (case-insensitive) apply, several groups of one token
// combined; only when none matches the `*` group applies. Longest matching path wins, Allow wins a tie, `*` and `$` are
// wildcards, an empty Disallow allows everything. Consecutive user-agent lines share one group; a blank line does not end it.
export const ROBOTS_BOTS = ["googlebot", "bingbot"];
export function robotsGroups(text) {
  const groups = []; let cur = null, open = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(raw);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === "user-agent") { if (!open) { cur = { agents: [], rules: [] }; groups.push(cur); } open = true; cur.agents.push(m[2].toLowerCase()); }
    else if (k === "disallow" || k === "allow") { open = false; if (cur) cur.rules.push([k, m[2]]); }
  }
  return groups;
}
// Percent-encoding normal form of RFC 9309 (2.2.2), applied to a rule path and to a URL path alike: every non-ASCII character and
// every ASCII character outside the URI character set becomes the percent-encoding of its UTF-8 octets (upper-case hex); a
// percent-encoded octet that is an unreserved character (ALPHA, DIGIT, - . _ ~) is decoded; a reserved character
// (gen-delims, sub-delims, so `/ ? # * $ &` and `%2F`) stays as it was written, encoded or not; a lone `%` becomes `%25`.
const UNRESERVED = /[A-Za-z0-9\-._~]/, RESERVED = ":/?#[]@!$&'()*+,;=";
export function robotsNormalize(path) {
  let out = "";
  const t = String(path);
  for (let i = 0; i < t.length;) {
    const m = /^%([0-9a-fA-F]{2})/.exec(t.slice(i, i + 3));
    if (m) { const ch = String.fromCharCode(parseInt(m[1], 16)); out += UNRESERVED.test(ch) ? ch : "%" + m[1].toUpperCase(); i += 3; continue; }
    const cp = t.codePointAt(i), ch = String.fromCodePoint(cp); i += ch.length;
    if (UNRESERVED.test(ch) || RESERVED.includes(ch)) out += ch;
    else out += [...new TextEncoder().encode(ch)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
  }
  return out;
}
// Is the URL path `path` (starts with "/", exactly as published) disallowed for `bot`? Rule paths and the URL path are both
// compared in the normal form above.
export function robotsPathBlocks(text, path, bot = "*") {
  if (typeof text !== "string") return false;
  const url = robotsNormalize(path), groups = robotsGroups(text), tok = String(bot).toLowerCase();
  let own = groups.filter((g) => g.agents.includes(tok));
  if (!own.length) own = groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const [k, raw] of own.flatMap((g) => g.rules)) {
    const v = robotsNormalize(raw);
    const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (v && re.test(url) && (!best || v.length > best[1].length || (v.length === best[1].length && k === "allow"))) best = [k, v];
  }
  return !!best && best[0] === "disallow";
}
// The URL path forms a page file can be reached under. `dir/index.html` is published as `/dir/` or as `/dir/index.html`: the
// form named by `published` (a site path as it appears in the sitemap <loc>, else the canonical) decides; when none is known both
// forms are possible and the page counts as blocked only when every form is blocked (a crawler can still reach it by the other).
export function robotsForms(rel, published) {
  if (!/(^|\/)index\.html$/.test(rel)) return ["/" + rel];
  const dir = "/" + rel.replace(/index\.html$/, "");
  if (typeof published === "string") return [published.endsWith("index.html") ? dir + "index.html" : dir];
  return [dir, dir + "index.html"];
}
export function robotsBlocks(text, rel, bot = "*", published) {
  return robotsForms(rel, published).every((f) => robotsPathBlocks(text, f, bot));
}
// The tested bots that robots.txt keeps away from `rel` (`published`: see robotsForms).
export const robotsBlockedFor = (text, rel, published) => ROBOTS_BOTS.filter((b) => robotsBlocks(text, rel, b, published));
export const sitemapLocs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));

function seoContext(pages, site, opt) {
  const origins = new Set();
  const add = (v) => { try { origins.add(new URL(v).origin); } catch { /* not absolute */ } };
  if (opt.site_url) add(opt.site_url);
  else {
    for (const p of pages) for (const c of p.canonicals || []) { if (/^[a-z][a-z0-9+.-]*:/i.test(c.raw || "")) { add(c.raw); } }
    if (!origins.size && site?.sitemap_xml) for (const l of sitemapLocs(site.sitemap_xml).slice(0, 1)) add(l);
  }
  origins.delete("null");
  return { base: opt.base_url, origins };
}

// Every site path the checks need to know exists, or whose hreflang list they need (the measure step resolves them).
export function seoLookups(pages, site, opt) {
  const ctx = seoContext(pages, site, opt), out = { exists: new Set(), alternates: new Set() };
  const own = new Set(pages.map((p) => { const r = siteRef(p.url, ctx); return r && pageKey(r); }));
  for (const p of pages) {
    for (const c of p.canonicals || []) { const r = c.href && siteRef(c.href, ctx); if (r) out.exists.add(r); }
    for (const a of p.alternates || []) { const r = a.href && siteRef(a.href, ctx); if (r) { out.exists.add(r); if (!own.has(pageKey(r))) out.alternates.add(r); } }
    for (const i of p.og_image || []) { const r = i.href && siteRef(i.href, ctx); if (r) out.exists.add(r); }
  }
  if (site?.sitemap_xml) for (const l of sitemapLocs(site.sitemap_xml)) { const r = siteRef(l, ctx); if (r) out.exists.add(r); }
  return { exists: [...out.exists], alternates: [...out.alternates] };
}

// Pure: page facts (probe `seo()` plus `path`, `source`, `x_robots`, `requests`: [{ url, third_party, phase, initiator }]) and site facts
// ({ robots_txt, sitemap_xml, exists: {path: true|false|null}, alternates: {path: [{hreflang, href}]|null} })
// -> { pages, items } of report.seo. A fact that cannot be known is a not_measured item, never a pass or a fail.
export function seoEvaluate(pages, site, opt) {
  const ctx = seoContext(pages, site || {}, opt);
  const exists = (href) => { const r = href && siteRef(href, ctx); if (!r) return null; for (const c of siteCandidates(r)) if (site?.exists?.[c] === true) return true; return siteCandidates(r).some((c) => site?.exists?.[c] === false) ? false : null; };
  const out = { pages: [], items: [] };
  const item = (check, page, selector, problems, evidence, uncertain) => {
    const base = { id: `S-${out.items.length + 1}`, check, page, selector, threshold: "== 0" };
    if (!problems.length && uncertain.length) out.items.push({ ...base, status: "not_measured", reason: uncertain.join("; ") });
    else out.items.push({ ...base, value: problems.length, status: problems.length ? "fail" : "pass", evidence: clip(evidence), ...(problems.length ? { note: problems.join("; ") } : {}) });
  };
  const keyOf = (p) => { const r = siteRef(p.url, ctx); return r ? pageKey(r) : p.path; };
  const lists = new Map(); // page key -> its alternates (keys), for reciprocity
  for (const p of pages) lists.set(keyOf(p), (p.alternates || []).map((a) => { const r = siteRef(a.href, ctx); return r && pageKey(r); }));
  const published = [];
  const robotsTxt = site?.robots_txt ?? null;
  // The form a page is published under (A161): the sitemap <loc> of that page, else its canonical, else unknown (undefined).
  const sitemapHrefs = site?.sitemap_xml ? sitemapLocs(site.sitemap_xml) : [];
  const publishedForm = (p) => {
    const me = siteRef(p.url, ctx);
    if (me === null) return undefined;
    const same = (h) => { const r = h && siteRef(h, ctx); return r && pageKey(r) === pageKey(me); };
    const href = sitemapHrefs.find(same) ?? (p.canonicals || []).map((c) => c.href).find(same);
    return href ? siteRel(href, ctx) : undefined;
  };
  for (const p of pages) {
    const rel = siteRef(p.url, ctx);
    const reasons = [];
    if ((p.robots_meta || []).some((c) => /\bnoindex\b|\bnone\b/i.test(c))) reasons.push("meta robots noindex");
    if (/\bnoindex\b|\bnone\b/i.test(p.x_robots || "")) reasons.push("X-Robots-Tag noindex");
    if (p.not_measured) { out.pages.push({ path: p.path, status: "not_measured", reason: p.not_measured }); continue; }
    // blocked for EVERY tested bot (A160): skipped like noindex; blocked for only some bots stays measured and seo_robots names the bot
    const rb = rel && robotsTxt !== null ? robotsBlockedFor(robotsTxt, rel, publishedForm(p)) : [];
    if (rb.length === ROBOTS_BOTS.length) reasons.push(`robots.txt disallows the page for ${rb.join(", ")}`);
    if (reasons.length) { out.pages.push({ path: p.path, status: "not_applicable", reason: "robots", detail: reasons.join("; ") }); continue; }
    // requests: { url, third_party?, phase?, initiator? } (a plain URL string is the old shape: third party = outside the site)
    const reqs = (p.requests || []).map((r) => (typeof r === "string" ? { url: r } : r)).filter((r) => r && r.url);
    // first party = the site itself, including its deployed origin (seo.site_url / canonical origin), before trusting the probe's flag
    const isThird = (r) => !/^(data|blob|about):/i.test(r.url) && siteRef(r.url, ctx) === null && (r.third_party ?? true);
    const thirdParty = reqs.filter((r) => (r.phase ?? "before_consent") === "before_consent" && isThird(r));
    // an initiator counts only when it is not the document itself (a parser-initiated request names the document; the probe keeps only script or non-document initiators)
    const initOk = (r) => r.initiator && r.initiator.split("#")[0] !== String(p.url || "").split("#")[0];
    const mine = thirdParty.filter((r) => analyticsUrlLabel(r.url, opt) || (initOk(r) && analyticsUrlLabel(r.initiator, opt)));
    const hay = [...srcUrls(p.source), ...(p.scripts || []), ...reqs.map((r) => r.url)];
    const gl = analyticsGlobals(opt).filter((g) => (p.globals || []).includes(g));
    const detected = [...new Set([...hay.map((t) => analyticsUrlLabel(t, opt)).filter(Boolean), ...gl])];
    const other = [...new Set(thirdParty.filter((r) => !mine.includes(r)).map((r) => r.url))];
    out.pages.push({ path: p.path, status: "measured", ...(detected.length ? { analytics_detected: detected, analytics_before_consent: [...new Set(mine.map((r) => r.url))] } : {}),
      ...(other.length ? { third_party_requests: other } : {}) });
    published.push(p);
    const P = p.path;

    const titles = p.titles || [], tp = [];
    if (titles.length !== 1) tp.push(`${titles.length} <title> elements, exactly 1 required`);
    if (titles.some((t) => !t)) tp.push("empty <title>");
    item("seo_title", P, "title", tp, titles, []);

    const ds = p.descriptions || [], dp = [];
    if (ds.length !== 1) dp.push(`${ds.length} meta description elements, exactly 1 required`);
    if (ds.some((t) => !t)) dp.push("empty meta description");
    item("seo_description", P, 'meta[name="description"]', dp, ds, []);

    const cs = p.canonicals || [], cp = [], cu = [];
    if (cs.length !== 1) cp.push(`${cs.length} link[rel=canonical] elements, exactly 1 required`);
    for (const c of cs) {
      if (!c.raw) { cp.push("empty canonical href"); continue; }
      const r = siteRef(c.href, ctx);
      if (r && pageKey(r) === keyOf(p)) continue;
      const e = exists(c.href);
      if (e === false) cp.push(`canonical points at a page that does not exist: ${c.raw}`);
      else if (e === null) cu.push(`canonical ${c.raw} could not be resolved inside the site`);
    }
    item("seo_canonical", P, "link[rel=canonical]", cp, cs.map((c) => c.raw), cu);

    const alts = p.alternates || [];
    if (alts.length) {
      const hp = [], hu = [], me = keyOf(p);
      for (const a of alts) if (!LANG_TAG.test(a.hreflang)) hp.push(`invalid hreflang value "${a.hreflang}"`);
      if (!alts.some((a) => { const r = siteRef(a.href, ctx); return r && pageKey(r) === me; })) hp.push("no self-referencing hreflang");
      if (!alts.some((a) => a.hreflang.toLowerCase() === "x-default")) hp.push("no x-default alternate");
      for (const a of alts) {
        const r = siteRef(a.href, ctx);
        if (!r) { hu.push(`${a.hreflang} target ${a.href} is outside the site`); continue; }
        const k = pageKey(r);
        if (k === me) continue;
        if (exists(a.href) === false) { hp.push(`hreflang ${a.hreflang} target does not exist: ${a.href}`); continue; }
        const back = lists.has(k) ? lists.get(k) : (site?.alternates?.[r] ? site.alternates[r].map((x) => { const q = siteRef(x.href, ctx); return q && pageKey(q); }) : null);
        if (back === null) hu.push(`${a.hreflang} target ${a.href} could not be read to check the return link`);
        else if (!back.includes(me)) hp.push(`hreflang ${a.hreflang} target ${a.href} does not list this page back (not reciprocal)`);
      }
      item("seo_hreflang", P, "link[rel=alternate][hreflang]", [...new Set(hp)], alts, hu);
    }

    item("seo_h1", P, "h1", p.h1 === 1 ? [] : [`${p.h1} <h1> elements, exactly 1 required`], { h1: p.h1 }, []);

    const op = [], ou = [], ot = p.og_title || [], oi = p.og_image || [];
    if (!ot.length || ot.every((t) => !t)) op.push("og:title missing or empty");
    if (!oi.length || oi.every((i) => !i.raw)) op.push("og:image missing or empty");
    else for (const i of oi) if (i.raw) { const e = exists(i.href); if (e === false) op.push(`og:image does not resolve inside the site: ${i.raw}`); else if (e === null) ou.push(`og:image ${i.raw} could not be resolved inside the site`); }
    item("seo_open_graph", P, 'meta[property^="og:"]', op, { "og:title": ot, "og:image": oi.map((i) => i.raw) }, ou);

    const jp = [];
    (p.jsonld || []).forEach((t, i) => { try { JSON.parse(t); } catch (e) { jp.push(`ld+json block ${i + 1} is not valid JSON (${e.message.slice(0, 60)})`); } });
    item("seo_structured_data", P, 'script[type="application/ld+json"]', jp, { blocks: (p.jsonld || []).length }, []);

    if (mine.length) {
      const loaded = [...new Set(mine.map((r) => `third-party request ${r.url}${r.initiator ? ` (initiated by ${r.initiator})` : ""}`))];
      item("seo_analytics_consent", P, "network (third-party requests before consent)", loaded.map((l) => `before consent: ${l}`), { detected, before_consent: loaded }, []);
    }
  }
  if (published.length) {
    const keys = published.map((p) => keyOf(p));
    const locs = site?.sitemap_xml ? sitemapLocs(site.sitemap_xml) : null;
    const sp = [], su = [];
    if (locs === null) su.push("sitemap.xml was not found at the site root: information only, not a defect (a sitemap is optional, and the deployed site's files cannot be proven absent from the measured base)");
    else if (/<sitemapindex/i.test(site.sitemap_xml)) su.push("sitemap index: the child sitemaps are not followed");
    else {
      const listed = new Set(locs.map((l) => { const r = siteRef(l, ctx); return r && pageKey(r); }));
      for (const p of published) if (!listed.has(keyOf(p))) sp.push(`${p.path} is not listed`);
      for (const l of locs) { const r = siteRef(l, ctx); if (!r) { su.push(`${l} is outside the site and was not checked`); continue; } const e = exists(l); if (e === false) sp.push(`lists a page that does not exist: ${l}`); else if (e === null) su.push(`${l} could not be checked for existence`); }
    }
    item("seo_sitemap", SEO_SITE, "sitemap.xml", sp, { pages: keys, locs: locs ? locs.slice(0, 20) : null }, su);

    const rp = [], ru = [];
    if (robotsTxt === null) ru.push("robots.txt was not found at the site root: information only, not a defect (RFC 9309: a missing robots.txt means every page may be crawled, and the deployed site's files cannot be proven absent from the measured base)");
    else {
      if (!/^\s*sitemap\s*:\s*\S+/im.test(robotsTxt)) rp.push("robots.txt has no Sitemap: line");
      for (const p of published) { const r = siteRef(p.url, ctx), b = r ? robotsBlockedFor(robotsTxt, r, publishedForm(p)) : []; if (b.length) rp.push(`robots.txt disallows ${p.path} for ${b.join(", ")}`); }
      for (const l of locs || []) { const r = siteRef(l, ctx), b = r ? robotsBlockedFor(robotsTxt, r, siteRel(l, ctx)) : []; if (b.length) rp.push(`robots.txt disallows a sitemap page for ${b.join(", ")}: ${l}`); }
    }
    item("seo_robots", SEO_SITE, "robots.txt", rp, { sitemap_line: robotsTxt === null ? null : /^\s*sitemap\s*:/im.test(robotsTxt), bots: ROBOTS_BOTS }, ru);
  }
  return out;
}

// Reads a site file: a file: base from disk, an http(s) localhost base through the same-origin request.
async function siteRead(base, rel, withHeaders) {
  const url = pageUrl(base, rel);
  if (!url) return { text: null };
  try {
    if (url.startsWith("file:")) return { text: readFileSync(new URL(url), "utf8") };
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    const headers = withHeaders ? { x_robots: r.headers.get("x-robots-tag") || "" } : {};
    return r.ok ? { text: await r.text(), ...headers } : { text: null, ...headers };
  } catch { return { text: null }; }
}
// Resolves the lookups seoLookups names; page facts are filled by the caller.
export async function seoSite(base, pages, opt) {
  const site = { robots_txt: (await siteRead(base, "robots.txt")).text, sitemap_xml: (await siteRead(base, "sitemap.xml")).text, exists: {}, alternates: {} };
  const want = seoLookups(pages, site, opt);
  for (const rel of want.exists) site.exists[rel] = (await siteRead(base, rel)).text !== null;
  for (const rel of want.alternates) {
    let text = null;
    for (const c of siteCandidates(rel)) { text = (await siteRead(base, c)).text; if (text !== null) break; }
    site.alternates[rel] = text === null ? null : [...text.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /rel\s*=\s*["']?alternate/i.test(t) && /hreflang/i.test(t))
      .map((t) => ({ hreflang: (/hreflang\s*=\s*["']?([^"'\s>]+)/i.exec(t) || [])[1] || "", href: (/href\s*=\s*["']?([^"'\s>]+)/i.exec(t) || [])[1] || "" }))
      .map((a) => { try { return { ...a, href: new URL(a.href, new URL(pageUrl(base, rel))).href }; } catch { return a; } });
  }
  return site;
}

// --- DevTools protocol over a plain WebSocket ----------------------------------------------------------------
async function launch(path, timeoutMs, noSandbox) {
  const profile = mkdtempSync(join(tmpdir(), "visual-proof-profile-"));
  const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-default-apps",
    "--metrics-recording-only", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "about:blank"];
  // root in a container, or a CI kernel without unprivileged namespaces, cannot use the sandbox
  if (noSandbox || process.getuid?.() === 0) args.push("--no-sandbox");
  // detached: the browser gets its own process group, so close() also ends its helper processes
  const proc = spawn(path, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  const exited = new Promise((ok) => proc.once("exit", ok));
  const kill = (sig) => { try { process.kill(-proc.pid, sig); } catch { /* group already gone */ } };
  let sock, send;
  // Never throws: Browser.close, then SIGTERM/SIGKILL to the group, then the profile is removed.
  const close = async () => {
    if (send) await Promise.race([send("Browser.close").catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    try { sock?.close(); } catch { /* already closed */ }
    if (proc.exitCode === null && proc.signalCode === null) { kill("SIGTERM"); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); }
    kill("SIGKILL");
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { console.error(`measure: could not remove ${profile}: ${e.message}`); }
    process.off("exit", emergency); process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  };
  // Aborted run (signal, or any process.exit before close finished): kill the group and remove the profile
  // synchronously, then exit 130 (SIGINT) or 143 (SIGTERM).
  const emergency = () => { kill("SIGKILL"); try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort at exit */ } };
  const onInt = () => { emergency(); process.exit(130); };
  const onTerm = () => { emergency(); process.exit(143); };
  process.on("exit", emergency); process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    const ws = await new Promise((ok, fail) => {
      let buf = "";
      const t = setTimeout(() => fail(new Error(`browser did not start within ${timeoutMs} ms${buf ? `: ${buf.slice(-300)}` : ""}`)), timeoutMs);
      proc.stderr.on("data", (d) => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); ok(m[1]); } });
      proc.on("exit", (c) => { clearTimeout(t); fail(new Error(`browser exited (${c}): ${buf.slice(-300)}`)); });
      proc.on("error", (e) => { clearTimeout(t); fail(e); });
    });
    sock = new WebSocket(ws);
    await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = () => fail(new Error("cannot connect to the DevTools socket")); });
    return connected();
  } catch (e) { await close(); throw e; }

  async function connected() {
  let next = 0;
  const pending = new Map(), waiters = [], listeners = [];
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.fail(new Error(`${p.method}: ${msg.error.message}`)) : p.ok(msg.result); }
    else if (msg.method) {
      for (const w of [...waiters]) if (w.method === msg.method && w.sessionId === msg.sessionId) { waiters.splice(waiters.indexOf(w), 1); w.ok(msg.params); }
      for (const l of listeners) if (l.method === msg.method && l.sessionId === msg.sessionId) l.fn(msg.params);
    }
  };
  send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = ++next;
    const t = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { method, ok: (r) => { clearTimeout(t); ok(r); }, fail: (e) => { clearTimeout(t); fail(e); } });
    sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const once = (method, sessionId) => new Promise((ok) => waiters.push({ method, sessionId, ok }));
  const on = (method, sessionId, fn) => listeners.push({ method, sessionId, fn });
  const version = (await send("Browser.getVersion")).product;
  return { send, once, on, close, version };
  }
}

const KEYS = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, " ": 32 };
// M2 (A50/A52): every request the page makes is paused; only the page's own origin (the base_url folder for file:,
// the base_url localhost origin for http) and inline data:/blob: URLs continue. Anything else (a configured
// backend, a third-party script, an API on another port) fails with BlockedByClient and is recorded.
// Child targets are auto-attached paused and get the same guard before they run (a dedicated worker has no
// Fetch domain: its requests are paused by the page's own interception, measured; it gets the WebSocket block).
// WebSockets (ws:, wss:, same origin included: a live connection is not needed to render a state) are blocked
// in the page and in every worker before it runs (the WebSocket constructor throws; the attempt is recorded).
// Network.setBlockedURLs does not stop a WebSocket handshake, measured; a WebSocket that still opens is reported
// by Network.webSocketCreated as unguarded (the result is capped). Service-worker registration and shared
// workers are refused in the page. Allowed requests
// with a side-effect method (POST, PUT, PATCH, DELETE) are recorded as same_origin_writes.
export const allowRequest = (base, url) => /^(data|blob|about):/.test(String(url)) || pageUrl(base, url) !== null;
// The refusals report through a console marker (Runtime.consoleAPICalled), so a worker that ends early is recorded.
const NO_WS = `try { const g = globalThis; const rec = (u, t) => console.debug("__vp_blocked", String(new URL(u, g.location.href)), t);
  g.WebSocket = function (u) { rec(u, "WebSocket"); throw new DOMException("WebSocket blocked by visual-proof", "SecurityError"); };
} catch (e) {}`;
const NO_SW = `try { const rec = (u, t) => console.debug("__vp_blocked", String(new URL(u, location.href)), t);
  if (navigator.serviceWorker) navigator.serviceWorker.register = function (u) { rec(u, "ServiceWorker"); return Promise.reject(new DOMException("service worker blocked by visual-proof", "SecurityError")); };
  if (window.SharedWorker) window.SharedWorker = function (u) { rec(u, "SharedWorker"); throw new DOMException("shared worker blocked by visual-proof", "SecurityError"); };
} catch (e) {}`;
async function page(b, timeoutMs, base, net, log) {
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const inits = new Map(); // request URL -> the URL of the script or page that started it (Network.requestWillBeSent)
  const record = (list, item) => { if (!list.some((x) => x.url === item.url && x.type === item.type && x.method === item.method)) list.push(item); };
  const guard = async (sid, type = "page") => {
    b.on("Fetch.requestPaused", sid, (q) => {
      log?.push({ url: q.request.url, third_party: !allowRequest(base, q.request.url), phase: "before_consent" });
      if (allowRequest(base, q.request.url)) {
        if (!/^(GET|HEAD|OPTIONS)$/i.test(q.request.method)) record(net.same_origin_writes, { method: q.request.method, url: q.request.url });
        return b.send("Fetch.continueRequest", { requestId: q.requestId }, sid).catch(() => {});
      }
      record(net.blocked, { url: q.request.url, type: q.resourceType || "Other" });
      return b.send("Fetch.failRequest", { requestId: q.requestId, errorReason: "BlockedByClient" }, sid).catch(() => {});
    });
    b.on("Network.requestWillBeSent", sid, (q) => { const i = q.initiator?.url || q.initiator?.stack?.callFrames?.[0]?.url; if (i && (q.initiator?.type === "script" || i !== q.documentURL)) inits.set(q.request.url, i); });
    b.on("Network.webSocketCreated", sid, (q) => record(net.unguarded, { url: q.url, type: "WebSocket", reason: "a WebSocket opened despite the guard" }));
    b.on("Runtime.consoleAPICalled", sid, (q) => { const a = q.args || []; if (a[0]?.value === "__vp_blocked") record(net.blocked, { url: String(a[1]?.value), type: String(a[2]?.value) }); });
    await b.send("Runtime.enable", {}, sid);
    await b.send("Network.enable", {}, sid);
    if (type === "worker") await b.send("Runtime.evaluate", { expression: NO_WS }, sid); // before the worker runs
    try { await b.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sid); }
    catch (e) { if (type !== "worker") throw e; }
  };
  b.on("Target.attachedToTarget", sessionId, async (q) => {
    try { await guard(q.sessionId, q.targetInfo?.type); } catch (e) { record(net.unguarded, { url: q.targetInfo?.url || "", type: q.targetInfo?.type || "target", reason: e.message }); }
    finally { b.send("Runtime.runIfWaitingForDebugger", {}, q.sessionId).catch(() => {}); }
  });
  await guard(sessionId);
  await s("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await s("Page.enable");
  await s("Page.addScriptToEvaluateOnNewDocument", { source: NO_WS + "\n" + NO_SW });
  await s("Runtime.enable");
  await s("Emulation.setFocusEmulationEnabled", { enabled: true });
  const ev = async (expression, awaitPromise = false) => {
    const r = await s("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  return {
    s, ev, inits,
    async open(url, vp, ready, setup) {
      await s("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width <= 480 });
      const loaded = b.once("Page.loadEventFired", sessionId);
      await s("Page.navigate", { url });
      await Promise.race([loaded, new Promise((_, f) => setTimeout(() => f(new Error(`load timed out: ${url}`)), timeoutMs))]);
      // The probe returns its private mark(el) function; the setup script receives it as `mark` and registers what it injects.
      if (setup) await ev(`(async (mark) => eval(${JSON.stringify(setup)}))(${PROBE})`, true);
      else await ev(`void ${PROBE}`);
      const until = Date.now() + Math.min(timeoutMs, 5000);
      let shown;
      for (;;) {
        if (!ready || await ev(`window.__vp.visible(${JSON.stringify(ready)})`)) { shown = true; break; }
        if (Date.now() > until) { shown = false; break; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return shown;
    },
    async key(k) {
      const code = KEYS[k];
      const base = { key: k, code: k === " " ? "Space" : k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await s("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k === "Enter" ? { text: "\r" } : k === " " ? { text: " " } : {}) });
      await s("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },
    async shot(clip) {
      const p = clip ? { format: "png", clip, captureBeyondViewport: true } : { format: "png", captureBeyondViewport: true, clip: await fullClip() };
      return Buffer.from((await s("Page.captureScreenshot", p)).data, "base64");
    },
  };
  async function fullClip() {
    const m = await s("Page.getLayoutMetrics");
    const c = m.cssContentSize || m.contentSize;
    return { x: 0, y: 0, width: Math.ceil(c.width), height: Math.min(Math.ceil(c.height), 6000), scale: 1 };
  }
}

// Focus order and visibility by real Tab presses: every tabbable element must be reached, no positive
// tabindex, and each stop must change pixels around the element when focused (any indicator counts).
async function focusChecks(p, limit = 40) {
  const items = [], nm = [];
  const n = await p.ev("window.__vp.tabbables()");
  const positive = await p.ev("window.__vp.positive()");
  for (const s of positive) items.push({ check: "focus_order", selector: s, value: 1, threshold: "== 0", status: "fail", note: "positive tabindex overrides the document order" });
  if (!n) {
    items.push({ check: "focus_order", selector: "body", value: "no focusable element", threshold: "== 0", status: "not_applicable" });
    items.push({ check: "focus_visible", selector: "body", value: "no focusable element", threshold: "== 1", status: "not_applicable" });
    return { items, not_measured: nm };
  }
  const m = Math.min(n, limit);
  if (n > limit) nm.push({ scope: "element", check: "focus_visible", selector: "body", reason: `focus visibility checked for the first ${limit} of ${n} tab stops` });
  await p.ev("window.__vp.blur()");
  const before = [];
  for (let i = 0; i < m; i++) before.push((await p.shot(await p.ev(`window.__vp.clipOf(${i})`))).toString("base64"));
  await p.ev("window.__vp.blur(); window.scrollTo(0, 0)");
  const reached = new Set(), invisible = [];
  let stops = 0;
  // bounded: every tabbable once plus up to 50 stops T does not list
  for (let k = 0; k < n + 50; k++) {
    await p.key("Tab");
    const i = await p.ev("window.__vp.step()");
    // the first Tab may land on the document (the navigation starting point is not always the top): go on
    if (i === "end") { if (stops) break; continue; }
    stops++;
    if (i < 0) continue;
    reached.add(i);
    if (i < m) {
      const after = (await p.shot(await p.ev(`window.__vp.clipOf(${i})`))).toString("base64");
      if (after === before[i]) invisible.push(i);
    }
  }
  for (let i = 0; i < n; i++) if (!reached.has(i)) items.push({ check: "focus_order", selector: await p.ev(`window.__vp.selectorOf(${i})`), value: 1, threshold: "== 0", status: "fail", note: "not reached by Tab" });
  if (!items.some((x) => x.check === "focus_order")) items.push({ check: "focus_order", selector: "body", value: 0, threshold: "== 0", status: "pass", note: `${reached.size} tab stops in document order` });
  for (const i of invisible) items.push({ check: "focus_visible", selector: await p.ev(`window.__vp.selectorOf(${i})`), value: 0, threshold: "== 1", status: "fail", note: "no visible change when focused" });
  if (!invisible.length) items.push({ check: "focus_visible", selector: "body", value: 1, threshold: "== 1", status: "pass", note: `${[...reached].filter((i) => i < m).length} focused stops changed pixels` });
  await p.ev("window.__vp.blur(); window.scrollTo(0, 0)");
  return { items, not_measured: nm };
}

async function interaction(p, it) {
  const failed = [];
  for (const st of it.steps || []) {
    if (st.click) { if (!(await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(st.click)}); if (!e) return false; e.click(); return true; })()`))) failed.push(`click target missing: ${st.click}`); }
    else if (st.fill) {
      const text = st.text ?? String(st.repeat ?? "x").repeat(st.times ?? 1);
      if (!(await p.ev(`(() => { const e = document.querySelector(${JSON.stringify(st.fill)}); if (!e) return false; e.focus(); e.value = ${JSON.stringify(text)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`))) failed.push(`fill target missing: ${st.fill}`);
    } else if (st.press) await p.key(st.press);
    await new Promise((r) => setTimeout(r, 150));
  }
  for (const ex of it.expect || []) {
    if (ex.visible && !(await p.ev(`window.__vp.visible(${JSON.stringify(ex.visible)})`))) failed.push(`not visible: ${ex.visible}`);
    if (ex.hidden && (await p.ev(`window.__vp.visible(${JSON.stringify(ex.hidden)})`))) failed.push(`still visible: ${ex.hidden}`);
    if (ex.focus_within && !(await p.ev(`!!document.querySelector(${JSON.stringify(ex.focus_within)})?.contains(document.activeElement)`))) failed.push(`focus not inside: ${ex.focus_within}`);
    if (ex.no_horizontal_scroll && (await p.ev("window.__vp.hscroll()"))) failed.push("horizontal scroll appeared");
    if (ex.text_contains && !(await p.ev(`(document.querySelector(${JSON.stringify(ex.text_contains[0])})?.textContent || '').includes(${JSON.stringify(ex.text_contains[1])})`))) failed.push(`text missing in ${ex.text_contains[0]}: ${ex.text_contains[1]}`);
  }
  const first = it.steps?.[0] || {};
  return { check: it.check, interaction: it.name, selector: first.click || first.fill || it.expect?.[0]?.visible || "body", value: failed.length, threshold: "== 0", status: failed.length ? "fail" : "pass", ...(failed.length ? { note: failed.join("; ") } : {}) };
}

// --- config ------------------------------------------------------------------------------------------------
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
// A screen or state path resolved against base_url, or null when it leaves the code under review: a file: page
// stays under the base_url folder, an http(s) page on the base_url origin (itself localhost).
export function pageUrl(base, path) {
  let b, u;
  try { b = new URL(base); u = new URL(path, b); } catch { return null; }
  if (b.protocol === "file:") {
    const dir = safeDecode(b.pathname.replace(/[^/]*$/, ""));
    if (b.host || dir === "/") return null; // the filesystem root (or a remote host) is not an app folder
    return u.protocol === "file:" && !u.host && safeDecode(u.pathname).startsWith(dir) ? u.href : null;
  }
  return /^https?:$/.test(b.protocol) && LOCAL.includes(b.hostname) && u.origin === b.origin ? u.href : null;
}

export function checkConfig(c) {
  const e = [];
  if (!c || typeof c !== "object") return ["config must be a JSON object"];
  if (!CLASSES.includes(c.class)) e.push(`class must be one of ${CLASSES.join("|")} (TRIVIAL has no visual focus)`);
  let u;
  try { u = new URL(c.base_url); } catch { e.push("base_url must be a URL"); }
  // Only the code under review: a local file or a server the QA started on this machine.
  if (u && !(u.protocol === "file:" || (/^https?:$/.test(u.protocol) && LOCAL.includes(u.hostname)))) e.push("base_url must be file: or http(s) on localhost/127.0.0.1/[::1]");
  else if (u?.protocol === "file:" && !pageUrl(c.base_url, "x")) e.push("a file: base_url must name the app folder on this machine, not the filesystem root or another host");
  const vps = Array.isArray(c.viewports) ? c.viewports : [];
  if (vps.length < (MIN_VIEWPORTS[c.class] || 2)) e.push(`class ${c.class} needs at least ${MIN_VIEWPORTS[c.class] || 2} viewports`);
  for (const v of vps) if (!v?.name || !Number.isInteger(v.width) || !Number.isInteger(v.height)) e.push("each viewport needs name, width, height");
  if (c.touch_target_min !== undefined && !(typeof c.touch_target_min === "number" && c.touch_target_min >= 24)) e.push("touch_target_min must be a number >= 24 (WCAG 2.5.8; a stricter value is allowed, a weaker one never)");
  if (!Array.isArray(c.screens) || !c.screens.length) e.push("screens must list at least one screen");
  for (const s of c.screens || []) {
    if (!s?.id || !s.path || !Array.isArray(s.states) || !s.states.length) { e.push("each screen needs id, path and states"); continue; }
    for (const st of s.states) if (!st?.name || !st.ready) e.push(`screen ${s.id}: each state needs name and ready (a selector visible only in that state)`);
    for (const path of [s.path, ...s.states.map((st) => st?.path).filter(Boolean)]) {
      if (u && !pageUrl(c.base_url, path)) e.push(`screen ${s.id}: path ${path} leaves base_url (a file: page stays under its folder, an http(s) page on its localhost origin)`);
    }
  }
  if (c.seo !== undefined) {
    const q = c.seo;
    if (!q || typeof q !== "object" || Array.isArray(q)) e.push("seo must be an object");
    else {
      if (q.public_html !== undefined && typeof q.public_html !== "boolean") e.push("seo.public_html must be true or false (false: the project produces no public HTML pages)");
      if (q.site_url !== undefined) { try { if (!/^https?:$/.test(new URL(q.site_url).protocol)) throw new Error(); } catch { e.push("seo.site_url must be an http(s) URL (the deployed address the canonical links use)"); } }
      if (q.pages !== undefined && !(Array.isArray(q.pages) && q.pages.length && q.pages.every((x) => typeof x === "string"))) e.push("seo.pages must be a non-empty list of paths");
      for (const path of Array.isArray(q.pages) ? q.pages : []) if (typeof path === "string" && u && !pageUrl(c.base_url, path)) e.push(`seo page ${path} leaves base_url`);
      if (q.analytics !== undefined) {
        const an = q.analytics;
        if (!an || typeof an !== "object" || Array.isArray(an)) e.push("seo.analytics must be an object { hosts: [], globals: [] }");
        else for (const k of ["hosts", "globals"]) if (an[k] !== undefined && !(Array.isArray(an[k]) && an[k].every((x) => typeof x === "string" && x.trim()))) e.push(`seo.analytics.${k} must be a list of non-empty strings`);
      }
    }
  }
  if (c.design !== undefined) e.push(...checkDesignConfig(c, u));
  for (const it of c.interactions || []) if (!it?.name || !INTERACTION_CHECKS.includes(it.check) || !it.screen || !it.state) e.push(`interaction ${it?.name}: needs name, check (${INTERACTION_CHECKS.join("|")}), screen, state`);
  for (const k of c.criteria || []) if (!/^AC-\d+$/.test(k?.id || "") || !Array.isArray(k.checks)) e.push("each criterion needs id AC-<n> and checks[]");
  return e;
}

// The design group (0.0.27, A170): visitor mode, pages, language entries, image ledger path, scenes, motion minimums.
export function checkDesignConfig(c, u) {
  const e = [], d = c.design;
  if (!d || typeof d !== "object" || Array.isArray(d)) return ["design must be an object"];
  const nonEmpty = (x) => typeof x === "string" && x.trim() !== "";
  const okPath = (p) => !u || !!pageUrl(c.base_url, p);
  if (!DESIGN_MODES.includes(d.visitor_mode)) e.push(`design.visitor_mode must be one of ${DESIGN_MODES.join("|")}`);
  if (d.screens !== undefined) {
    if (!(Array.isArray(d.screens) && d.screens.length && d.screens.every(nonEmpty))) e.push("design.screens must be a non-empty list of screen paths or ids");
    else for (const x of d.screens) { const path = (c.screens || []).find((s) => s?.id === x)?.path ?? x; if (!okPath(path)) e.push(`design screen ${x} leaves base_url`); }
  }
  if (d.languages !== undefined) {
    if (!Array.isArray(d.languages)) e.push("design.languages must be a list of { path, lang, allow_text? }");
    else for (const l of d.languages) {
      if (!l || !nonEmpty(l.path) || !nonEmpty(l.lang)) { e.push("each design.languages entry needs path and lang"); continue; }
      if (!okPath(l.path)) e.push(`design language page ${l.path} leaves base_url`);
      if (l.allow_text !== undefined && !(Array.isArray(l.allow_text) && l.allow_text.every(nonEmpty))) e.push(`design.languages ${l.path}: allow_text must be a list of non-empty strings`);
    }
  }
  if (d.image_ledger !== undefined && !(nonEmpty(d.image_ledger) && !isAbsolute(d.image_ledger) && !d.image_ledger.split(/[\\/]/).includes(".."))) e.push("design.image_ledger must be a path relative to the repo root, without ..");
  if (d.scenes !== undefined) {
    if (!Array.isArray(d.scenes)) e.push("design.scenes must be a list");
    else {
      const ids = new Set();
      for (const s of d.scenes) {
        if (!s || !nonEmpty(s.id) || !nonEmpty(s.path) || !nonEmpty(s.selector)) { e.push("each design scene needs id, path and selector"); continue; }
        if (ids.has(s.id)) e.push(`design scene ${s.id} is listed twice`);
        ids.add(s.id);
        if (!okPath(s.path)) e.push(`design scene ${s.id}: path ${s.path} leaves base_url`);
        if (s.viewports !== undefined && !(Array.isArray(s.viewports) && s.viewports.length && s.viewports.every((v) => ["desktop", "phone"].includes(v)))) e.push(`design scene ${s.id}: viewports must be a subset of desktop, phone`);
      }
    }
  }
  if (d.motion_min !== undefined) {
    const m = d.motion_min;
    if (!m || typeof m !== "object" || Array.isArray(m) || !["load", "scroll"].every((k) => m[k] === undefined || (Number.isInteger(m[k]) && m[k] >= 0)) || Object.keys(m).some((k) => !["load", "scroll"].includes(k))) e.push("design.motion_min must be { load, scroll } with non-negative integers");
  }
  return e;
}

// The pages the seo group measures: seo.pages, else the path of every screen.
export const seoPagePaths = (c) => [...new Set(c.seo?.pages || (c.screens || []).map((x) => x.path))];

// --- assemble: raw cells (from this script or any other tool) -> report.json -------------------------------
// raw = { tool, config, a11y_scanner?, cells: [{ screen, state, viewport, screenshot, rendered, error?, items, not_measured }],
//         interactions: [{ name, viewport, screenshot, item } | { name, viewport, error }],
//         seo?: { pages: [facts], site: {...} } | { not_applicable: true },   (A158: see seoEvaluate)
//         design?: { pages: [{ path, viewports: [{ viewport, screenshot, facts }], ledger? }], motion? } }   (A170: see design-audit.mjs assembleDesign)
export function assemble(raw, outDir) {
  const c = raw.config;
  const sha = (p) => createHash("sha256").update(readFileSync(join(outDir, p))).digest("hex");
  const report = {
    schema: SCHEMA, class: c.class, result: "PASS", tool: raw.tool,
    target: { base_url: c.base_url },
    viewports: c.viewports.map(({ name, width, height }) => ({ name, width, height })),
    screens: c.screens.map((s) => ({ id: s.id, path: s.path, states: s.states.map((x) => x.name) })),
    interactions: (c.interactions || []).map(({ name, check, screen, state, viewports }) => ({ name, check, screen, state, ...(viewports ? { viewports } : {}) })),
    cells: [], measured: [], not_measured: [], judged: [],
    a11y_scanner: raw.a11y_scanner || { status: "not_available" },
    network: raw.network || { interception: "none", blocked: [], same_origin_writes: [] },
    regression: raw.regression || { status: "not_available", reason: "not checked by measure.mjs; QA records the project's own snapshot command, if any" },
    criteria: [],
  };
  if (raw.tool.kind === "none") {
    Object.assign(report, { result: "UNSUPPORTED", unsupported_reason: raw.tool.reason || "no browser tooling" });
    for (const k of ["cells", "screens", "interactions"]) report[k] = [];
    delete report.regression; delete report.a11y_scanner; delete report.network;
    report.criteria = (c.criteria || []).map((k) => ({ id: k.id, required: !!k.required, status: "unproven" }));
    return report;
  }
  const crit = (m) => (c.criteria || []).filter((k) => k.checks.includes(m.check) && (!k.screens || k.screens.includes(m.screen)) && (!k.states || k.states.includes(m.state))).map((k) => k.id);
  let n = 0;
  const push = (cell, item, ev) => {
    const m = { id: `M-${++n}`, check: item.check, screen: cell.screen, state: cell.state, viewport: cell.viewport, ...item, evidence: ev };
    const ids = crit(m);
    if (ids.length) m.criteria = ids;
    report.measured.push(m);
  };
  for (const cell of raw.cells) {
    const k = { screen: cell.screen, state: cell.state, viewport: cell.viewport };
    if (!cell.screenshot) {
      for (const check of CORE) report.not_measured.push({ scope: "cell", check, ...k, reason: cell.error || "page could not be rendered" });
      continue;
    }
    const ev = { path: cell.screenshot, sha256: sha(cell.screenshot) };
    report.cells.push({ ...k, screenshot: ev });
    const ready = c.screens.find((s) => s.id === cell.screen).states.find((s) => s.name === cell.state).ready;
    push(k, { check: "state_rendered", selector: ready, value: cell.rendered ? 1 : 0, threshold: "== 1", status: cell.rendered ? "pass" : "fail" }, ev);
    if (!cell.rendered) {
      // Measuring whatever rendered instead would prove nothing about this state.
      for (const check of CORE.filter((x) => x !== "state_rendered")) report.not_measured.push({ scope: "cell", check, ...k, reason: "state not rendered" });
      continue;
    }
    for (const item of cell.items) push(k, item, ev);
    for (const x of cell.not_measured) report.not_measured.push({ ...x, ...k });
  }
  for (const r of raw.interactions || []) {
    const it = c.interactions.find((x) => x.name === r.name);
    const k = { screen: it.screen, state: it.state, viewport: r.viewport };
    if (r.error || !r.screenshot) { report.not_measured.push({ scope: "cell", check: it.check, interaction: it.name, ...k, reason: r.error || "no screenshot" }); continue; }
    const ev = { path: r.screenshot, sha256: sha(r.screenshot) };
    if (!report.cells.some((x) => x.screen === k.screen && x.state === k.state && x.viewport === k.viewport)) report.cells.push({ ...k, screenshot: ev });
    push(k, r.item, ev);
  }
  report.criteria = (c.criteria || []).map((k) => {
    const items = report.measured.filter((m) => m.criteria?.includes(k.id));
    return { id: k.id, required: !!k.required, status: items.some((m) => m.status === "fail") ? "failed" : items.some((m) => m.status === "pass") ? "proven" : "unproven" };
  });
  if (c.seo) {
    const opt = { base_url: c.base_url, site_url: c.seo.site_url, analytics: c.seo.analytics };
    if (c.seo.public_html === false || raw.seo?.not_applicable) report.seo = { status: "not_applicable", note: SEO_NOT_APPLICABLE_NOTE };
    else if (Array.isArray(raw.seo?.pages)) report.seo = { status: "run", ...seoEvaluate(raw.seo.pages, raw.seo.site || {}, opt) };
    else report.seo = { status: "run", pages: seoPagePaths(c).map((path) => ({ path, status: "not_measured", reason: "the tool supplied no seo facts" })), items: [] };
  }
  if (c.design) {
    const unreadable = (p) => { throw new Error(`cannot read ${p}`); };
    report.design = assembleDesign(raw, c, (p) => (existsSync(join(outDir, p)) ? sha(p) : unreadable(p)));
  }
  const v = validateReport({ ...report, result: "PASS" }, { root: outDir });
  report.result = v.computed;
  return report;
}

// Technical SEO facts of every seo page, loaded once with no interaction (so before any consent) in the first viewport.
async function measureSeo(p, config, reqLog, url) {
  const opt = { base_url: config.base_url, site_url: config.seo.site_url, analytics: config.seo.analytics };
  const pages = [];
  for (const path of seoPagePaths(config)) {
    reqLog.length = 0;
    try {
      await p.open(url(path), config.viewports[0], null, undefined);
      await new Promise((r) => setTimeout(r, 800)); // late analytics requests
      const type = await p.ev("document.contentType");
      if (!/^(text\/html|application\/xhtml\+xml)$/.test(type)) { pages.push({ path, url: url(path), not_measured: `not an HTML response (${type})` }); continue; }
      const f = await p.ev(`window.__vp.seo(${JSON.stringify(analyticsGlobals(opt))})`);
      const src = await siteRead(config.base_url, path, true);
      pages.push({ ...f, path, requests: reqLog.map((r) => ({ ...r, ...(p.inits.get(r.url) ? { initiator: p.inits.get(r.url) } : {}) })), source: src.text || "", x_robots: src.x_robots || "" });
    } catch (e) { pages.push({ path, url: url(path), not_measured: e.message }); }
  }
  if (pages.length && pages.every((x) => /^not an HTML response/.test(x.not_measured || ""))) return { not_applicable: true };
  return { pages, site: await seoSite(config.base_url, pages.filter((x) => !x.not_measured), opt) };
}

// Design audit facts (A170): every design page is opened at 1440, 768 and 390 wide (a language-only page at 1440), scrolled once top to
// bottom so lazy and scroll-revealed content exists, photographed, and probed; the ledger and the motion audit run on the same page object.
async function measureDesign(p, config, url, outDir, repo, shotName) {
  const d = config.design, out = { pages: [] };
  const ledgerText = d.image_ledger ? (() => { try { return readFileSync(resolve(repo, d.image_ledger), "utf8"); } catch { return null; } })() : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const pg of designPages(config)) {
    const rp = { path: pg.path, viewports: [] };
    out.pages.push(rp);
    for (const vp of pg.static ? DESIGN_VIEWPORTS : DESIGN_VIEWPORTS.slice(0, 1)) {
      const rv = { viewport: vp.name };
      rp.viewports.push(rv);
      try {
        await p.open(url(pg.path), vp, null, undefined);
        const type = await p.ev("document.contentType");
        if (!/^(text\/html|application\/xhtml\+xml)$/.test(type)) { rp.not_measured = `not an HTML response (${type})`; break; }
        await p.ev(`(async () => { const h = document.documentElement.scrollHeight; for (let y = 0; y < h; y += Math.max(200, innerHeight * 0.8)) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } scrollTo(0, 0); await document.fonts.ready; await new Promise((r) => setTimeout(r, 250)); return 1; })()`, true);
        rv.facts = await p.ev(`(${DESIGN_PROBE})()`); // before the full-page capture: it resizes the viewport the facts are measured in
        rv.screenshot = shotName(pg.screen, vp.name);
        writeFileSync(join(outDir, rv.screenshot), await p.shot());
        if (vp.name === "wide" && pg.static && d.image_ledger) {
          const images = await p.ev(IMAGES_PROBE, true);
          rp.ledger = ledgerItems({ images, ledgerText, ledgerPath: d.image_ledger, screen: pg.screen, viewport: vp.name, fonts: rv.facts.fontFaces });
        }
      } catch (e) { rv.error = e.message; delete rv.screenshot; delete rv.facts; }
    }
  }
  try { out.motion = await motionAudit({ p, url, config, outDir, shotName: (...parts) => shotName("motion", ...parts) }); } catch (e) { out.motion = { error: e.message }; }
  return out;
}

async function measure(config, outDir, tool, timeoutMs, noSandbox, repo = process.cwd()) {
  const raw = { tool: { kind: tool.kind, name: tool.name, ...(tool.path ? { path: tool.path } : {}), ...(tool.reason ? { reason: tool.reason } : {}), detected_by: tool.detected_by }, config, cells: [], interactions: [] };
  if (tool.kind !== "headless-browser") return raw;
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  // A110: one cold start on a CI runner has been seen to hang past the start timeout; one retry, never more.
  const b = await launch(tool.path, timeoutMs, noSandbox).catch((e) => {
    if (!/did not start/.test(e.message)) throw e;
    console.error(`measure: ${e.message}; retrying once`);
    return launch(tool.path, timeoutMs, noSandbox);
  });
  raw.tool.version = b.version;
  const axe = tool.a11y_scanner ? readFileSync(tool.a11y_scanner.path, "utf8") : null;
  if (axe) raw.a11y_scanner = { status: "run", tool: "axe-core", source: "project node_modules" };
  const url = (path) => { const u = pageUrl(config.base_url, path); if (!u) throw new Error(`path leaves base_url: ${path}`); return u; };
  const file = (...parts) => `screenshots/${parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "_")}.png`;
  try {
    raw.network = { interception: "on", allowed: "base_url origin only (file: folder or localhost origin), data:, blob:; no WebSocket, no service worker", blocked: [], same_origin_writes: [], unguarded: [] };
    const reqLog = [];
    const p = await page(b, timeoutMs, config.base_url, raw.network, reqLog);
    const deep = config.class !== "STANDARD";
    const wanted = new Set(requiredCells({ class: config.class, viewports: config.viewports, screens: config.screens.map((s) => ({ id: s.id, states: s.states.map((x) => x.name) })) }).map((x) => `${x.screen}|${x.state}`));
    for (const k of config.criteria || []) for (const s of config.screens) if (!k.screens || k.screens.includes(s.id)) for (const st of k.states || []) wanted.add(`${s.id}|${st}`);
    for (const s of config.screens) for (const st of s.states) {
      if (!deep && !wanted.has(`${s.id}|${st.name}`)) continue;
      for (const vp of config.viewports) {
        const cell = { screen: s.id, state: st.name, viewport: vp.name, items: [], not_measured: [] };
        try {
          cell.rendered = await p.open(url(st.path || s.path), vp, st.ready, st.setup);
          const type = await p.ev("document.contentType");
          if (!/^(text\/html|application\/xhtml\+xml)$/.test(type)) throw new Error(`not an HTML response (${type}): not measured`);
          cell.screenshot = file(s.id, st.name, vp.name);
          writeFileSync(join(outDir, cell.screenshot), await p.shot());
          if (cell.rendered) {
            const r = await p.ev(`window.__vp.measure(${JSON.stringify({ touchTargetMin: config.touch_target_min || 24 })})`);
            const f = await focusChecks(p);
            cell.items = [...r.items, ...f.items];
            cell.not_measured = [...r.not_measured, ...f.not_measured];
            if (axe) {
              await p.ev(axe);
              const v = await p.ev("axe.run(document, { resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, target: String((v.nodes[0] && v.nodes[0].target && v.nodes[0].target[0]) || 'html') })))", true);
              for (const x of v) cell.items.push({ check: "a11y_scanner", selector: x.target, value: x.nodes, threshold: "== 0", status: "fail", note: `${x.id} (${x.impact})` });
              if (!v.length) cell.items.push({ check: "a11y_scanner", selector: "html", value: 0, threshold: "== 0", status: "pass" });
            }
          }
        } catch (e) { cell.error = e.message; delete cell.screenshot; }
        raw.cells.push(cell);
      }
    }
    if (config.seo && config.seo.public_html !== false) raw.seo = await measureSeo(p, config, reqLog, url);
    if (config.design) raw.design = await measureDesign(p, config, url, outDir, repo, (...parts) => file("design", ...parts));
    for (const it of config.interactions || []) {
      const s = config.screens.find((x) => x.id === it.screen), st = s?.states.find((x) => x.name === it.state);
      for (const vp of config.viewports.filter((v) => !it.viewports || it.viewports.includes(v.name))) {
        try {
          if (!st) throw new Error(`unknown screen/state ${it.screen}/${it.state}`);
          if (!(await p.open(url(st.path || s.path), vp, st.ready, st.setup))) throw new Error(`state ${it.state} not rendered`);
          const item = await interaction(p, it);
          const shot = file(it.screen, it.state, vp.name, it.name);
          writeFileSync(join(outDir, shot), await p.shot());
          raw.interactions.push({ name: it.name, viewport: vp.name, screenshot: shot, item });
        } catch (e) { raw.interactions.push({ name: it.name, viewport: vp.name, error: e.message }); }
      }
    }
  } finally { await b.close(); }
  return raw;
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

async function main(argv) {
  const usage = "usage: measure.mjs --detect [--repo DIR] | --config visual.json --out DIR [--repo DIR] [--browser PATH] [--timeout MS] [--no-sandbox] | --print-probe | --print-design-probe | --assemble raw.json --out DIR";
  const repo = resolve(arg(argv, "--repo") || process.cwd());
  if (argv.includes("--print-probe")) { console.log(PROBE); return 0; }
  if (argv.includes("--print-design-probe")) { console.log(`${DESIGN_PROBE}()`); return 0; }
  if (argv.includes("--detect")) { console.log(JSON.stringify(detect({ repo, browser: arg(argv, "--browser") }), null, 2)); return 0; }
  const out = arg(argv, "--out");
  if (!out) { console.error(usage); return 2; }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  let raw;
  try {
    if (arg(argv, "--assemble")) raw = read(arg(argv, "--assemble"));
    else {
      const cfgPath = arg(argv, "--config");
      if (!cfgPath) { console.error(usage); return 2; }
      const config = read(cfgPath);
      const errs = checkConfig(config);
      if (errs.length) { errs.forEach((e) => console.error(`config: ${e}`)); return 2; }
      const timeout = Math.max(30000, Number(arg(argv, "--timeout")) || 30000);
      const tool = detect({ repo, browser: arg(argv, "--browser") });
      if (tool.kind === "project-tool") { console.error(`measure: no browser binary; drive the probe with ${tool.name} (--print-probe, then --assemble raw.json)`); return 2; }
      raw = await measure(config, out, tool, timeout, argv.includes("--no-sandbox"), repo);
    }
    const errs = checkConfig(raw.config);
    if (errs.length) { errs.forEach((e) => console.error(`config: ${e}`)); return 2; }
    mkdirSync(out, { recursive: true });
    const report = assemble(raw, out);
    writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const v = validateReport(report, { root: out });
    console.log(`RESULT: ${report.result}`);
    console.log(`SUMMARY: ${v.summary}`);
    if (!v.valid) v.errors.forEach((e) => console.error(`note: ${e}`));
    return 0;
  } catch (e) { console.error(`measure: ${e.message}`); return 2; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
