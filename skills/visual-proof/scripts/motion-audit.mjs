// visual-proof motion audit (0.0.27, A170): design_motion_count, design_reduced_motion, design_no_script_visible and design_scene.
// No dependencies. `motionAudit` drives the page object `p` of measure.mjs (p.open / p.ev / p.s / p.shot); the decision functions are
// pure (plain data in, plain data out) so they can be tested without a browser.
//
//   const { items, scenes, not_measured } = await motionAudit({ p, url, config, outDir, shotName });
//
//   p        the page object of measure.mjs (open, ev, s, shot)
//   url      (path) => absolute URL, as in measure.mjs; a string is taken as a base for relative paths
//   config   the visual.json config; config.design holds visitor_mode, screens, scenes, motion_min; config.screens gives ready/setup
//   outDir   report folder; every screenshot is written here and returned as a relative path STRING (the caller hashes them)
//   shotName optional (...parts) => "screenshots/<name>.png"
// Items carry no id (the caller numbers them D-n). Measured at the viewports `wide` (1440x900) and `phone390` (390x844); motion count at
// `wide` only. A page is opened normally, with prefers-reduced-motion: reduce emulated, and with script execution disabled; the emulation is
// always cleared and scripts re-enabled before the function returns.

import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export const DESIGN_VIEWPORTS = {
  wide: { name: "wide", width: 1440, height: 900 },
  tablet: { name: "tablet", width: 768, height: 1024 },
  phone390: { name: "phone390", width: 390, height: 844 },
};
export const SCENE_VIEWPORT_ALIASES = { desktop: "wide", wide: "wide", tablet: "tablet", phone: "phone390", phone390: "phone390" };
export const MOTION_MODES = ["persuade", "experience"];
export const MOTION_NOT_APPLICABLE_NOTE = "design_motion_count applies to persuade and experience surfaces only";
export const MOTION_MIN_DEFAULT = { load: 3, scroll: 3 };
export const SCENE_STOPS = [0, 50, 100];
const AUDIT_VIEWPORTS = ["wide", "phone390"];

// --- pure decisions ------------------------------------------------------------------------------------------
// Screens of the design group: config.design.screens (paths; default every screen path) -> [{ screen: id, path }].
export function designScreens(config) {
  const all = config?.screens || [];
  const wanted = config?.design?.screens?.length ? config.design.screens : all.map((s) => s.path);
  const paths = wanted.map((x) => all.find((s) => s.id === x)?.path ?? x); // an entry may be a screen id or a path
  return [...new Set(paths)].map((path) => ({ screen: all.find((s) => s.path === path)?.id || path, path }));
}
export const motionApplicable = (mode) => MOTION_MODES.includes(mode);

// counts { load, scroll } (elements animating) and min -> [{ phase, value, threshold, status }]
export function decideMotionCount(counts, min = {}) {
  const m = { ...MOTION_MIN_DEFAULT, ...min };
  return ["load", "scroll"].map((phase) => ({ phase, value: counts[phase], threshold: `>= ${m[phase]}`, status: counts[phase] >= m[phase] ? "pass" : "fail" }));
}

// Animated properties that move things (a vestibular risk) and that a reduced-motion rule must remove.
const VESTIBULAR_RE = /^(transform|translate|rotate|scale|top|left|right|bottom|inset|margin|width|height|backgroundposition|clippath|offset|perspective|viewtransition|zoom|fontsize)/;
export const isVestibular = (prop) => VESTIBULAR_RE.test(String(prop).toLowerCase().replace(/-/g, ""));
// entries [{ sel, props: [...], infinite, essential }] (what ran while scrolling with reduced motion emulated) -> the non-essential ones
export const nonEssentialAnimations = (entries) => (entries || []).filter((e) => !e.essential && (e.infinite || (e.props || []).some(isVestibular)));

// shown: [{ k, s }] visible content elements without emulation; shownAfter: the same list under the emulation / without script.
// An element visible before and not visible after is hidden.
export function decideStillVisible(shown, shownAfter) {
  const after = new Set((shownAfter || []).map((x) => x.k));
  const hidden = (shown || []).filter((x) => !after.has(x.k));
  return { hidden, value: hidden.length, status: hidden.length === 0 ? "pass" : "fail" };
}
export const decideReducedMotion = ({ shown, shownReduced, running }) => ({ ...decideStillVisible(shown, shownReduced), running: nonEssentialAnimations(running) });
export const decideNoScript = ({ shown, shownNoScript }) => decideStillVisible(shown, shownNoScript);

// The scroll range of a scene. A scene taller than 1.2 viewports is pinned: the range runs from its top reaching the top of the viewport to
// its bottom reaching the bottom. A shorter scene is scroll-linked while crossing: from entering at the bottom to leaving at the top.
export function sceneRange({ top, height, vh, max }) {
  const pinned = height > 1.2 * vh;
  let start = pinned ? top : top - vh, end = pinned ? top + height - vh : top + height;
  const clamp = (v) => Math.max(0, Math.min(Math.max(0, max), Math.round(v)));
  start = clamp(start); end = clamp(end);
  return { start, end: Math.max(start, end), pinned };
}
export const sceneStops = (range) => SCENE_STOPS.map((at) => ({ at, y: Math.round(range.start + ((range.end - range.start) * at) / 100) }));

// states: [{ sig, hash }] at 0 and 100 % (hash: the scene element's own pixels when its clip had the same size at both stops, else null)
export function decideSceneStarted(first, last, range) {
  if (range && range.end <= range.start) return { started: false, reason: "the scene has no scroll range (start and end are the same position)" };
  if (first.sig !== last.sig) return { started: true, reason: "computed transform/opacity/clip of the scene subtree changed between 0 and 100 %" };
  if (first.hash && last.hash && first.hash !== last.hash) return { started: true, reason: "the scene's pixels changed between 0 and 100 %" };
  return { started: false, reason: "nothing observable changed between 0 and 100 % (computed styles and pixels equal)" };
}
// content keys seen at any stop in normal motion vs under reduced motion: everything the normal scene shows must be visible too.
export function decideSceneContent(normalKeys, reducedKeys) {
  const r = new Set(reducedKeys || []);
  const missing = [...new Set(normalKeys || [])].filter((k) => !r.has(k));
  return { ok: r.size > 0 && missing.length === 0, missing };
}

// --- in-page code ------------------------------------------------------------------------------------------------
// Recorder, installed before the page's own scripts: every element that animated (CSS animation, transition, Web Animations, view transition).
function recorderSource() {
  /* eslint-disable no-undef */
  if (window.top !== window || window.__vpm) return;
  const els = new Map();
  const META = new Set(["offset", "computedOffset", "easing", "composite"]);
  const note = (a) => {
    try {
      const ef = a.effect;
      if (!ef || !ef.target) return;
      const t = ef.getComputedTiming();
      if (typeof t.duration === "number" && t.duration <= 0 && t.iterations !== Infinity) return;
      let e = els.get(ef.target);
      if (!e) { e = { props: new Set(), infinite: false }; els.set(ef.target, e); }
      if (a.transitionProperty) e.props.add(a.transitionProperty);
      else if (ef.getKeyframes) for (const k of ef.getKeyframes()) for (const p of Object.keys(k)) if (!META.has(p)) e.props.add(p);
      if (ef.pseudoElement && /view-transition/.test(ef.pseudoElement)) e.props.add("view-transition");
      if (t.iterations === Infinity) e.infinite = true;
    } catch (err) { /* an animation that cannot be read is not recorded */ }
  };
  const sweep = (root) => { try { (root || document).getAnimations().forEach(note); } catch (err) { /* ignore */ } };
  setInterval(sweep, 40);
  for (const type of ["animationstart", "transitionrun"]) document.addEventListener(type, (e) => { if (e.target && e.target.getAnimations) sweep(e.target); }, true);
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) { const a = animate.apply(this, args); note(a); return a; };
  if (document.startViewTransition) {
    const svt = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => { const r = svt(...args); let e = els.get(document.documentElement); if (!e) { e = { props: new Set(), infinite: false }; els.set(document.documentElement, e); } e.props.add("view-transition"); return r; };
  }
  window.__vpm = {
    reset() { els.clear(); },
    summary() {
      sweep();
      const sel = (el) => (window.__vp && el.isConnected ? window.__vp.sel(el) : el.tagName.toLowerCase());
      return [...els].map(([el, e]) => ({ sel: sel(el), props: [...e.props], infinite: e.infinite, essential: !!(el.closest && el.closest("progress,[role=progressbar],[aria-busy=true],video,canvas,[data-motion-essential]")) }));
    },
  };
}
export const RECORDER = `(${recorderSource.toString()})()`;

// Helpers evaluated into the loaded page (also with scripts disabled): visible content, scrolling, scene geometry and state.
function helpersSource() {
  /* eslint-disable no-undef */
  if (window.__vph) return true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = (el) => (window.__vp && window.__vp.sel ? window.__vp.sel(el) : el.tagName.toLowerCase());
  const vis = (el) => {
    let op = 1;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none") return false;
      if (e === el && cs.visibility !== "visible") return false;
      op *= parseFloat(cs.opacity);
      if (op < 0.05) return false;
      if (/rect\(0px,? 0px,? 0px,? 0px\)/.test(cs.clip) || /inset\((50|100)%/.test(cs.clipPath)) return false;
      if (e !== el && cs.overflow !== "visible") { const r = e.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return false; }
    }
    const r = el.getBoundingClientRect();
    if (r.width * r.height <= 1) return false;
    const de = document.documentElement;
    if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || r.left + scrollX >= Math.max(de.scrollWidth, innerWidth) + 1) return false;
    return true;
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|HEAD|META|LINK|TITLE|DATALIST)$/;
  const MEDIA = /^(IMG|VIDEO|CANVAS|IFRAME|SVG|PICTURE)$/;
  window.__vph = {
    // visible text-bearing or media elements under rootSel (default body), keyed by their child-index path
    content(rootSel) {
      const root = rootSel ? document.querySelector(rootSel) : document.body;
      if (!root) return null;
      const out = []; let n = 0;
      const walk = (el, key) => {
        if (n++ > 6000 || SKIP.test(el.tagName)) return;
        const tag = el.tagName.toUpperCase();
        if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden") || el.hasAttribute("inert")) return;
        const text = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
        if ((text || MEDIA.test(tag)) && vis(el)) out.push({ k: key, s: sel(el) });
        if (tag === "SVG") return;
        [...el.children].forEach((c, i) => walk(c, key + "." + i));
      };
      walk(root, "r");
      return out;
    },
    async scrollThrough() {
      const step = Math.max(100, Math.round(innerHeight * 0.6));
      const max = () => Math.max(0, document.documentElement.scrollHeight - innerHeight);
      for (let y = 0, i = 0; i < 80; i++) {
        scrollTo({ top: y, behavior: "instant" });
        await sleep(160);
        if (y >= max()) break;
        y = Math.min(max(), y + step);
      }
      await sleep(900);
      // A transition or animation is only as far along as the browser has drawn frames; a runner that draws few (a macOS VM, headless,
      // no GPU) leaves a revealing block at opacity 0 and the normal-motion baseline misses it. Jump every finite clock-driven
      // animation to its end state so the sample is the settled page, not a frame count.
      try { for (const a of document.getAnimations()) { if (a.timeline instanceof DocumentTimeline && isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); } } catch (err) { /* an animation that cannot finish is sampled as it is */ }
      return true;
    },
    // the scene's scroll geometry: a sticky scene is measured by its container
    range(selector) {
      scrollTo({ top: 0, behavior: "instant" });
      const el = document.querySelector(selector);
      if (!el) return null;
      const box = getComputedStyle(el).position === "sticky" && el.parentElement ? el.parentElement : el;
      const r = box.getBoundingClientRect();
      return { top: r.top + scrollY, height: r.height, vh: innerHeight, max: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
    },
    sceneState(selector) {
      const el = document.querySelector(selector);
      if (!el) return null;
      const nodes = [el, ...el.querySelectorAll("*")].slice(0, 500);
      const sig = nodes.map((n) => { const cs = getComputedStyle(n); return [cs.transform, cs.translate, cs.scale, cs.rotate, cs.opacity, cs.clipPath, cs.filter, cs.visibility, n.children.length ? "" : (n.textContent || "").trim().slice(0, 30)].join("|"); }).join("\n");
      const r = el.getBoundingClientRect();
      return { sig, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, vw: innerWidth, vh: innerHeight, content: this.content(selector) || [] };
    },
  };
  return true;
}
export const HELPERS = `(${helpersSource.toString()})()`;

// --- orchestration ----------------------------------------------------------------------------------------------
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const defaultShotName = (...parts) => `screenshots/${parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "_")}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REDUCE = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };
// "Normal motion" is emulated explicitly, never left to the host: an empty feature list falls back to the OS setting, and a runner whose
// OS has reduce-motion on would then take the baseline under reduced motion, so a page that hides content there passed (a false negative).
const NO_PREFERENCE = { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] };
const first = (list, n = 5) => list.slice(0, n).map((x) => x.s || x.sel || x).join(", ");

export async function motionAudit({ p, url, config, outDir, shotName } = {}) {
  const items = [], scenes = [], not_measured = [];
  const design = config?.design || {};
  const mode = design.visitor_mode;
  const min = { ...MOTION_MIN_DEFAULT, ...(design.motion_min || {}) };
  const toUrl = typeof url === "function" ? url : (path) => new URL(path, url).href;
  const name = typeof shotName === "function" ? shotName : defaultShotName;
  const rel = (...parts) => name(...parts);
  const save = (relPath, buf) => { const f = join(outDir, relPath); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, buf); return relPath; };
  const viewportShot = async (...parts) => save(rel(...parts), Buffer.from((await p.s("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const miss = (check, screen, viewport, reason) => not_measured.push({ check, screen, viewport, reason });

  let recorderId = null;
  const diag = { userAgent: null, frames_per_500ms: null, samples: [] }; // written to <outDir>/motion-diagnostics.json for CI logs
  const media = { reduce: null }; // matchMedia("(prefers-reduced-motion: reduce)") of the page opened last
  const reducedOn = () => p.s("Emulation.setEmulatedMedia", REDUCE);
  const reducedOff = () => p.s("Emulation.setEmulatedMedia", NO_PREFERENCE).catch(() => {});
  const scriptsOn = () => p.s("Emulation.setScriptExecutionDisabled", { value: false }).catch(() => {});

  // open under the current emulation; the helpers are evaluated into the loaded page. Returns { rendered } or throws.
  const open = async (path, vp, st) => {
    const rendered = await p.open(toUrl(path), vp, st?.ready, st?.setup);
    const type = await p.ev("document.contentType");
    if (!/^(text\/html|application\/xhtml\+xml)$/.test(type)) throw new Error(`not an HTML response (${type})`);
    await p.ev(HELPERS);
    media.reduce = await p.ev('matchMedia("(prefers-reduced-motion: reduce)").matches');
    if (diag.userAgent === null) {
      diag.userAgent = await p.ev("navigator.userAgent");
      diag.frames_per_500ms = await p.ev("new Promise((r) => { let n = 0; const end = performance.now() + 500; const f = () => { n++; performance.now() < end ? requestAnimationFrame(f) : r(n); }; requestAnimationFrame(f); })", true);
    }
    return { rendered };
  };

  try {
    recorderId = (await p.s("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER })).identifier;

    // ---- per screen: motion count, reduced motion, no script ------------------------------------------------------
    for (const { screen, path } of designScreens(config)) {
      const matched = (config.screens || []).find((s) => s.path === path);
      const st = matched?.states?.[0];
      for (const vpName of AUDIT_VIEWPORTS) {
        const vp = DESIGN_VIEWPORTS[vpName];
        const base = { screen, viewport: vp.name };
        let shown = null, ready = true;

        // normal motion: load phase (2 s), scroll phase, the content visible after a full scroll
        try {
          await reducedOff(); await scriptsOn();
          const { rendered } = await open(path, vp, st);
          ready = rendered;
          if (!rendered) throw new Error(`ready selector not visible in state ${st?.name || "default"}`);
          if (media.reduce) throw new Error("the browser still reports prefers-reduced-motion: reduce in normal-motion mode, so no baseline exists");
          await p.ev("new Promise((r) => setTimeout(r, Math.max(0, 2100 - performance.now())))", true);
          const loadRun = await p.ev("window.__vpm ? window.__vpm.summary() : null");
          if (!loadRun) throw new Error("motion recorder did not start");
          const shot = await viewportShot("design-motion", screen, vp.name);
          await p.ev("window.__vpm.reset()");
          await p.ev("window.__vph.scrollThrough()", true);
          const scrollRun = await p.ev("window.__vpm.summary()");
          shown = await p.ev("window.__vph.content()");
          diag.samples.push({ screen, viewport: vp.name, mode: "normal", matches_reduce: media.reduce, visible: shown.length, scroll_height: await p.ev("document.documentElement.scrollHeight"), running: scrollRun.length });
          if (vp.name === "wide") {
            if (!motionApplicable(mode)) items.push({ check: "design_motion_count", ...base, selector: "html", value: "not applicable", threshold: `>= ${min.load}`, status: "not_applicable", note: MOTION_NOT_APPLICABLE_NOTE, screenshot: shot });
            else for (const d of decideMotionCount({ load: loadRun.length, scroll: scrollRun.length }, min)) {
              const run = d.phase === "load" ? loadRun : scrollRun;
              items.push({ check: "design_motion_count", phase: d.phase, ...base, selector: "html", value: d.value, threshold: d.threshold, status: d.status,
                note: `${d.phase === "load" ? "elements animating in the first 2 s after load" : "elements animating while scrolling top to bottom"}: ${run.length}${run.length ? ` (${first(run)})` : ""}`, screenshot: shot });
            }
          }
        } catch (e) {
          if (vp.name === "wide") miss("design_motion_count", screen, vp.name, e.message);
          miss("design_reduced_motion", screen, vp.name, `baseline (normal motion) not measured: ${e.message}`);
          miss("design_no_script_visible", screen, vp.name, `baseline (normal motion) not measured: ${e.message}`);
          continue;
        }

        // reduced motion
        try {
          await reducedOn();
          await open(path, vp, st);
          await p.ev("window.__vph.scrollThrough()", true);
          const running = await p.ev("window.__vpm.summary()");
          const after = await p.ev("window.__vph.content()");
          if (!media.reduce) throw new Error("the reduced-motion emulation did not take effect (matchMedia reports no reduce)");
          await p.ev("scrollTo({ top: 0, behavior: 'instant' })");
          await sleep(200);
          const shot = await viewportShot("design-reduced", screen, vp.name);
          const d = decideReducedMotion({ shown, shownReduced: after, running });
          diag.samples.push({ screen, viewport: vp.name, mode: "reduced", matches_reduce: media.reduce, visible: after.length, hidden: d.hidden.map((x) => x.s), running: running.length });
          items.push({ check: "design_reduced_motion", ...base, selector: d.hidden[0]?.s || "body", value: d.value, threshold: "== 0", status: d.status,
            note: d.value ? `${d.value} element(s) visible without emulation are not visible with reduced motion: ${first(d.hidden)}` : "every element visible without emulation stays visible", screenshot: shot });
          items.push({ check: "design_reduced_motion", ...base, selector: d.running[0]?.sel || "body", value: d.running.length, threshold: "== 0", status: d.running.length ? "fail" : "pass",
            note: d.running.length ? `${d.running.length} non-essential animation(s) ran with reduced motion: ${first(d.running)}` : "no non-essential animation ran with reduced motion", screenshot: shot });
        } catch (e) { miss("design_reduced_motion", screen, vp.name, e.message); }
        finally { await reducedOff(); }

        // no script
        try {
          await p.s("Emulation.setScriptExecutionDisabled", { value: true });
          await open(path, vp, st);
          await scriptsOn(); // the document stays as it rendered without script; timers work again for the scroll
          await p.ev("window.__vph.scrollThrough()", true);
          const after = await p.ev("window.__vph.content()");
          await p.ev("scrollTo({ top: 0, behavior: 'instant' })");
          await sleep(200);
          const shot = await viewportShot("design-noscript", screen, vp.name);
          const d = decideNoScript({ shown, shownNoScript: after });
          items.push({ check: "design_no_script_visible", ...base, selector: d.hidden[0]?.s || "body", value: d.value, threshold: "== 0", status: d.status,
            note: d.value ? `${d.value} text/media block(s) that show with script are hidden without it: ${first(d.hidden)}` : "all content that shows with script is visible without it", screenshot: shot });
        } catch (e) { miss("design_no_script_visible", screen, vp.name, e.message); }
        finally { await scriptsOn(); }
      }
    }

    // ---- scenes -----------------------------------------------------------------------------------------------------
    for (const sc of design.scenes || []) {
      const screen = (config.screens || []).find((s) => s.path === sc.path)?.id || sc.path;
      const st = (config.screens || []).find((s) => s.path === sc.path)?.states?.[0];
      const vpNames = [...new Set((sc.viewports?.length ? sc.viewports : ["desktop", "phone"]).map((v) => SCENE_VIEWPORT_ALIASES[v]).filter(Boolean))];
      for (const vpName of vpNames) {
        const vp = DESIGN_VIEWPORTS[vpName];
        let normalKeys = null;
        for (const motion of ["normal", "reduced"]) {
          const base = { screen, viewport: vp.name, selector: sc.selector };
          try {
            await scriptsOn();
            if (motion === "reduced") await reducedOn(); else await reducedOff();
            await open(sc.path, vp, st);
            await sleep(300);
            const g = await p.ev(`window.__vph.range(${JSON.stringify(sc.selector)})`);
            if (!g) throw new Error(`scene selector not found: ${sc.selector}`);
            const range = sceneRange(g);
            const stops = [], states = [], keys = new Set();
            for (const stop of sceneStops(range)) {
              await p.ev(`scrollTo({ top: ${stop.y}, behavior: "instant" })`);
              await sleep(450);
              const state = await p.ev(`window.__vph.sceneState(${JSON.stringify(sc.selector)})`);
              const shotPath = await viewportShot("design-scene", sc.id, vp.name, motion, `at${stop.at}`);
              let hash = null;
              const r = state.rect, x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
              const w = Math.min(state.vw, Math.ceil(r.x + r.w)) - x, h = Math.min(state.vh, Math.ceil(r.y + r.h)) - y;
              if (w > 4 && h > 4) {
                const buf = Buffer.from((await p.s("Page.captureScreenshot", { format: "png", clip: { x, y, width: w, height: h, scale: 1 } })).data, "base64");
                hash = { size: `${w}x${h}`, sha: sha(buf) };
              }
              states.push({ sig: state.sig, hash });
              for (const c of state.content) keys.add(c.k);
              stops.push({ at: stop.at, screenshot: shotPath });
            }
            const a = states[0], z = states[states.length - 1];
            const sameClip = a.hash && z.hash && a.hash.size === z.hash.size;
            const dec = decideSceneStarted({ sig: a.sig, hash: sameClip ? a.hash.sha : null }, { sig: z.sig, hash: sameClip ? z.hash.sha : null }, range);
            const row = { id: sc.id, screen, viewport: vp.name, motion, stops, started: dec.started, reason: dec.reason };
            const shot = stops[1].screenshot;
            if (motion === "normal") {
              normalKeys = [...keys];
              scenes.push(row);
              items.push({ check: "design_scene", ...base, scene: sc.id, motion, value: dec.started ? 1 : 0, threshold: ">= 1", status: dec.started ? "pass" : "fail", note: `${sc.id}, normal motion: ${dec.reason}`, screenshot: shot });
            } else {
              const c = decideSceneContent(normalKeys, [...keys]);
              scenes.push({ ...row, content_visible: c.ok });
              items.push({ check: "design_scene", ...base, scene: sc.id, motion, value: c.missing.length, threshold: "== 0", status: c.ok ? "pass" : "fail",
                note: c.ok ? `${sc.id}, reduced motion: all scene content is visible` : normalKeys && normalKeys.length ? `${sc.id}, reduced motion: ${c.missing.length} content element(s) shown in normal motion are not visible` : `${sc.id}, reduced motion: no scene content visible`, screenshot: shot });
            }
          } catch (e) {
            miss("design_scene", screen, vp.name, `${sc.id} (${motion}): ${e.message}`);
            if (motion === "normal") break;
          } finally { await reducedOff(); await scriptsOn(); }
        }
      }
    }
  } finally {
    await reducedOff();
    await scriptsOn();
    try { writeFileSync(join(outDir, "motion-diagnostics.json"), JSON.stringify(diag, null, 1)); } catch (err) { /* diagnostics only */ }
    if (recorderId) await p.s("Page.removeScriptToEvaluateOnNewDocument", { identifier: recorderId }).catch(() => {});
  }
  return { items, scenes, not_measured };
}
