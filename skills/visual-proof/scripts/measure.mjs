#!/usr/bin/env node
// visual-proof measurement. No dependencies: drives an already installed Chromium-family browser over the
// DevTools protocol (child process + Node's global WebSocket, Node >= 22). Installs nothing.
//
//   node measure.mjs --detect [--repo DIR]                 print the detected tooling as JSON (kind none => UNSUPPORTED)
//   node measure.mjs --config visual.json --out DIR [--repo DIR] [--browser PATH] [--timeout MS] [--no-sandbox]
//                                                          measure; writes DIR/report.json and DIR/screenshots/
//   node measure.mjs --print-probe                         print the page probe (for a project tool or runtime adapter)
//   node measure.mjs --assemble raw.json --out DIR         build DIR/report.json from cells measured by another tool
//
// Exit codes: 0 report written (any result, UNSUPPORTED included), 2 usage, config or I/O error.
// The report is validated with validate-visual.mjs; judged items and the regression record are added by QA.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE, CLASSES, MIN_VIEWPORTS, INTERACTION_CHECKS, SCHEMA, requiredCells, validateReport } from "./validate-visual.mjs";

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
  const tabbables = () => [...document.querySelectorAll(INTERACTIVE)].filter((e) => e.tabIndex >= 0 && !e.disabled && !e.closest("[inert]")
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
    blur() { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); },
    visible(s) { const el = document.querySelector(s); return !!el && !hidden(el); },
    hscroll() { return document.documentElement.scrollWidth > document.documentElement.clientWidth; },
    measure(opts) {
      const items = [], nm = [];
      const de = document.documentElement, cw = de.clientWidth;
      const add = (check, el, value, threshold, ok, extra = {}) => items.push({ check, selector: typeof el === "string" ? el : sel(el), value, threshold, status: ok ? "pass" : "fail", ...extra });
      const x0 = scrollX, y0 = scrollY;

      add("horizontal_scroll", "html", de.scrollWidth, `<= ${cw}`, de.scrollWidth <= cw, { client_width: cw });

      const offenders = [];
      for (const el of [...document.body.querySelectorAll("*")].slice(0, 5000)) {
        if (offenders.some((o) => o.contains(el)) || hidden(el) || clipped(el)) continue;
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
  return true;
}
export const PROBE = `(${probeSource.toString()})()`;

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
      const t = setTimeout(() => fail(new Error(`browser did not start within ${timeoutMs} ms`)), timeoutMs);
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
async function page(b, timeoutMs, base, net) {
  const { targetId } = await b.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await b.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => b.send(m, p, sessionId);
  const record = (list, item) => { if (!list.some((x) => x.url === item.url && x.type === item.type && x.method === item.method)) list.push(item); };
  const guard = async (sid, type = "page") => {
    b.on("Fetch.requestPaused", sid, (q) => {
      if (allowRequest(base, q.request.url)) {
        if (!/^(GET|HEAD|OPTIONS)$/i.test(q.request.method)) record(net.same_origin_writes, { method: q.request.method, url: q.request.url });
        return b.send("Fetch.continueRequest", { requestId: q.requestId }, sid).catch(() => {});
      }
      record(net.blocked, { url: q.request.url, type: q.resourceType || "Other" });
      return b.send("Fetch.failRequest", { requestId: q.requestId, errorReason: "BlockedByClient" }, sid).catch(() => {});
    });
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
    s, ev,
    async open(url, vp, ready, setup) {
      await s("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.width <= 480 });
      const loaded = b.once("Page.loadEventFired", sessionId);
      await s("Page.navigate", { url });
      await Promise.race([loaded, new Promise((_, f) => setTimeout(() => f(new Error(`load timed out: ${url}`)), timeoutMs))]);
      await ev(PROBE);
      if (setup) await ev(setup, true);
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
    const dir = decodeURIComponent(b.pathname.replace(/[^/]*$/, ""));
    if (b.host || dir === "/") return null; // the filesystem root (or a remote host) is not an app folder
    return u.protocol === "file:" && !u.host && decodeURIComponent(u.pathname).startsWith(dir) ? u.href : null;
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
  for (const it of c.interactions || []) if (!it?.name || !INTERACTION_CHECKS.includes(it.check) || !it.screen || !it.state) e.push(`interaction ${it?.name}: needs name, check (${INTERACTION_CHECKS.join("|")}), screen, state`);
  for (const k of c.criteria || []) if (!/^AC-\d+$/.test(k?.id || "") || !Array.isArray(k.checks)) e.push("each criterion needs id AC-<n> and checks[]");
  return e;
}

// --- assemble: raw cells (from this script or any other tool) -> report.json -------------------------------
// raw = { tool, config, a11y_scanner?, cells: [{ screen, state, viewport, screenshot, rendered, error?, items, not_measured }],
//         interactions: [{ name, viewport, screenshot, item } | { name, viewport, error }] }
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
  const v = validateReport({ ...report, result: "PASS" }, { root: outDir });
  report.result = v.computed;
  return report;
}

async function measure(config, outDir, tool, timeoutMs, noSandbox) {
  const raw = { tool: { kind: tool.kind, name: tool.name, ...(tool.path ? { path: tool.path } : {}), ...(tool.reason ? { reason: tool.reason } : {}), detected_by: tool.detected_by }, config, cells: [], interactions: [] };
  if (tool.kind !== "headless-browser") return raw;
  mkdirSync(join(outDir, "screenshots"), { recursive: true });
  const b = await launch(tool.path, timeoutMs, noSandbox);
  raw.tool.version = b.version;
  const axe = tool.a11y_scanner ? readFileSync(tool.a11y_scanner.path, "utf8") : null;
  if (axe) raw.a11y_scanner = { status: "run", tool: "axe-core", source: "project node_modules" };
  const url = (path) => { const u = pageUrl(config.base_url, path); if (!u) throw new Error(`path leaves base_url: ${path}`); return u; };
  const file = (...parts) => `screenshots/${parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "_")}.png`;
  try {
    raw.network = { interception: "on", allowed: "base_url origin only (file: folder or localhost origin), data:, blob:; no WebSocket, no service worker", blocked: [], same_origin_writes: [], unguarded: [] };
    const p = await page(b, timeoutMs, config.base_url, raw.network);
    const deep = config.class !== "STANDARD";
    const wanted = new Set(requiredCells({ class: config.class, viewports: config.viewports, screens: config.screens.map((s) => ({ id: s.id, states: s.states.map((x) => x.name) })) }).map((x) => `${x.screen}|${x.state}`));
    for (const k of config.criteria || []) for (const s of config.screens) if (!k.screens || k.screens.includes(s.id)) for (const st of k.states || []) wanted.add(`${s.id}|${st}`);
    for (const s of config.screens) for (const st of s.states) {
      if (!deep && !wanted.has(`${s.id}|${st.name}`)) continue;
      for (const vp of config.viewports) {
        const cell = { screen: s.id, state: st.name, viewport: vp.name, items: [], not_measured: [] };
        try {
          cell.rendered = await p.open(url(st.path || s.path), vp, st.ready, st.setup);
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
  const usage = "usage: measure.mjs --detect [--repo DIR] | --config visual.json --out DIR [--repo DIR] [--browser PATH] [--timeout MS] [--no-sandbox] | --print-probe | --assemble raw.json --out DIR";
  const repo = resolve(arg(argv, "--repo") || process.cwd());
  if (argv.includes("--print-probe")) { console.log(PROBE); return 0; }
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
      raw = await measure(config, out, tool, timeout, argv.includes("--no-sandbox"));
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
