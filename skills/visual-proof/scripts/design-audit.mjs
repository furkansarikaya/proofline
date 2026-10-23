// visual-proof design audit (0.0.27, A170): the static checks of the `design` group, as an in-page probe plus pure
// evaluation functions. No dependencies and no imports, so validate-visual.mjs and the tests can load it without a browser.
//
//   DESIGN_PROBE          expression source; evaluate `${DESIGN_PROBE}()` in a loaded page to get its facts
//   evaluateStatic        pure: facts of one page at one viewport -> the report items of the static checks
//   designPages           pure: the pages a config `design` block measures
//   assembleDesign        pure (plus a sha256 function): raw design cells -> report.design
//
// The motion, scene and image-ledger checks are measured by motion-audit.mjs and ledger.mjs; this module only normalises
// what they return and states which items a report must account for (expectedChecks).

export const DESIGN_VIEWPORTS = [
  { name: "wide", width: 1440, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone390", width: 390, height: 844 },
];
export const DESIGN_MODES = ["persuade", "operate", "read", "experience"];
export const DESIGN_STATIC_CHECKS = ["design_heading_lines", "design_type_scale", "design_body_measure", "design_fonts_loaded", "design_edge_margins",
  "design_edge_text", "design_vacuum", "design_untitled_section", "design_empty_hero", "design_surfaces", "design_untranslated",
  "design_ux_alt_text", "design_ux_form_labels", "design_ux_control_names", "design_ux_viewport_meta", "design_ux_body_font_size"];
export const DESIGN_MOTION_CHECKS = ["design_motion_count", "design_reduced_motion", "design_no_script_visible", "design_scene"];
export const DESIGN_CHECKS = [...DESIGN_STATIC_CHECKS, ...DESIGN_MOTION_CHECKS, "design_image_ledger"];
export const DESIGN_STATUSES = ["pass", "fail", "not_applicable", "not_measured"];
export const DESIGN_NOT_APPLICABLE_NOTE = "design not applicable: no HTML pages";
export const CRITIQUE_IDS = ["glance_1s_5s", "squint", "logo_off", "edge_alignment", "space_and_frames", "type_jumps", "color_ratios",
  "visual_count_and_motion", "section_monotony", "phone_composition", "screen_fullness", "content_completeness", "overlaps", "one_live_thing"];
export const CRITIQUE_STATUSES = ["ok", "concern", "not_applicable"];
export const LIVE_THING_MODES = ["persuade", "experience"];
// Judged UX review (ux-rules.json): items of report.ux_review[]. `chart_type` is the one extra judged id (references/CHARTS.md).
export const UX_REVIEW_STATUSES = ["ok", "concern", "not_applicable"];
export const UX_SEVERITIES = ["high", "medium", "low"];
export const CHART_TYPE_ID = "chart_type";

// Checks that exist only in some modes; in the others the item is `not_applicable` with the fixed note.
export const MODE_APPLIES = {
  design_body_measure: ["persuade", "experience", "read"],
  design_empty_hero: ["persuade", "experience"],
  design_motion_count: ["persuade", "experience"],
};
export const DESIGN_NA_NOTES = {
  design_body_measure: "not applicable: body measure is checked in persuade, experience and read modes",
  design_empty_hero: "not applicable: the first-screen thesis is checked in persuade and experience modes",
  design_motion_count: "not applicable: a motion layer is required in persuade and experience modes",
};
export const ENGLISH_PAGE_NOTE = "not applicable: the page language is English";
export const designApplies = (check, mode) => !MODE_APPLIES[check] || MODE_APPLIES[check].includes(mode);

// Static checks of the facts that do not depend on the viewport are measured once, at `wide`.
const WIDE_ONLY = ["design_fonts_loaded", "design_surfaces", "design_untranslated", "design_ux_viewport_meta"];
const PHONE_ONLY = ["design_ux_body_font_size"]; // a rule about small screens: measured at phone390 only
export const PER_VIEWPORT = DESIGN_STATIC_CHECKS.filter((c) => !WIDE_ONLY.includes(c) && !PHONE_ONLY.includes(c));

// What a measured page must account for at one viewport (an item of any status, or a not_measured entry).
// page = { static: bool, language?: string }; a page that is only a language entry gets design_untranslated at `wide`.
export function expectedChecks(page, mode, viewport) {
  const out = [];
  if (page.static) out.push(...(viewport === "wide" ? DESIGN_STATIC_CHECKS.filter((c) => c !== "design_untranslated" && !PHONE_ONLY.includes(c)) : [...PER_VIEWPORT, ...(viewport === "phone390" ? PHONE_ONLY : [])]));
  if (viewport === "wide" && page.language) out.push("design_untranslated");
  return out;
}

// --- thresholds ----------------------------------------------------------------------------------------------
// The documented threshold of a check (MEASURE.md): a report may be stricter, never weaker.
export function designThreshold(check, mode, viewport) {
  switch (check) {
    case "design_heading_lines": return "<= 2";
    case "design_type_scale": return mode === "persuade" || mode === "experience" ? ">= 3" : ">= 2";
    case "design_body_measure": return viewport === "phone390" ? "30-75" : "45-75"; // a 390 px column cannot hold 45 characters at a readable size
    case "design_edge_margins": return "<= 8";
    case "design_edge_text": return ">= 12";
    case "design_vacuum": return "<= 0.5";
    case "design_ux_body_font_size": return ">= 16";
    default: return "== 0";
  }
}
const OPS = { "<=": (a, b) => a <= b, ">=": (a, b) => a >= b, "==": (a, b) => a === b, "<": (a, b) => a < b, ">": (a, b) => a > b };
const parseThreshold = (t) => {
  const s = String(t ?? "").trim();
  const r = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(s);
  if (r) return { range: [Number(r[1]), Number(r[2])] };
  const m = /^(<=|>=|==|<|>)\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  return m ? { op: m[1], v: Number(m[2]) } : null;
};
// true/false, or null when the value or threshold is not numeric.
export function designHolds(value, threshold) {
  const t = parseThreshold(threshold);
  if (!t || typeof value !== "number" || !Number.isFinite(value)) return null;
  return t.range ? value >= t.range[0] && value <= t.range[1] : OPS[t.op](value, t.v);
}
// null when `threshold` is the documented one or stricter, else the reason it is not (only the checks this module owns).
export function designThresholdError(check, mode, viewport, threshold) {
  if (check === "design_motion_count") return null; // compared with motion_min by the validator
  if (check === "design_scene") { // a normal-motion scene must have started (>= 1), a reduced-motion scene hides nothing (== 0)
    const g = parseThreshold(threshold);
    return g && ((g.op === ">=" && g.v >= 1) || (g.op === "==" && g.v === 0)) ? null : `threshold ${JSON.stringify(threshold)} is not the documented ">= 1" (started) or "== 0" (hidden) for design_scene`;
  }
  const want = parseThreshold(designThreshold(check, mode, viewport)), got = parseThreshold(threshold);
  if (!got) return `threshold ${JSON.stringify(threshold)} is not numeric`;
  let ok;
  if (want.range) ok = !!got.range && got.range[0] >= want.range[0] && got.range[1] <= want.range[1];
  else if (got.range) ok = false;
  else if (want.op === "<=") ok = (got.op === "<=" || got.op === "<" || got.op === "==") && got.v <= want.v;
  else if (want.op === ">=") ok = (got.op === ">=" || got.op === ">" || got.op === "==") && got.v >= want.v;
  else ok = got.op === "==" && got.v === want.v;
  return ok ? null : `threshold ${threshold} is weaker than or unlike the documented ${designThreshold(check, mode, viewport)} for ${check} (references/MEASURE.md)`;
}

// Reasons of a `not_measured` item that only say the page has nothing of that kind to measure; they never lower the verdict.
export const NOTHING_TO_MEASURE = ["no visible h1 or h2", "no visible heading", "no body text size", "no body paragraph of 2 or more lines", "no visible text",
  "no content found to measure", "fewer than two content blocks", "no surface found", "no body paragraph to measure"];

// --- pure helpers --------------------------------------------------------------------------------------------
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
// Largest empty vertical gap between consecutive content blocks ({top, bottom, selector}, page coordinates).
export function vacuumOf(blocks, vh) {
  const bs = [...blocks].filter((b) => Number.isFinite(b.top) && Number.isFinite(b.bottom)).sort((a, b) => a.top - b.top);
  if (bs.length < 2) return null;
  let reach = bs[0], best = { gap: 0, from: bs[0].selector, to: bs[1].selector };
  for (const b of bs.slice(1)) {
    if (b.top - reach.bottom > best.gap) best = { gap: b.top - reach.bottom, from: reach.selector, to: b.selector };
    if (b.bottom > reach.bottom) reach = b;
  }
  return { ...best, ratio: round(best.gap / vh) };
}
// Words that mark English prose; ambiguous short words that other languages share are left out on purpose.
const ENGLISH = new Set(("the and for are with that this you your our from how what why about who have has their they but into when which just more each " +
  "any been would could should there these those than then them here also only not does did out can all get one new now was its " +
  "we will every let use make learn read very after before while because where through between without many such started it's don't you're we're").split(" "));
const words = (t) => String(t).toLowerCase().match(/[\p{L}']+/gu) || [];
// Text blocks ({selector, text}) of >= 4 words whose words are at least a quarter English function words, after removing allow_text.
export function untranslatedBlocks(blocks, allow = []) {
  const out = [];
  for (const b of blocks || []) {
    let t = String(b.text || "");
    for (const a of allow) if (a) t = t.split(new RegExp(String(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).join(" ");
    const w = words(t);
    if (w.length < 4) continue;
    const hits = w.filter((x) => ENGLISH.has(x)).length;
    if (hits >= 2 && hits / w.length >= 0.25) out.push({ selector: b.selector, text: String(b.text).slice(0, 80), words: w.length, hits });
  }
  return out;
}

// --- evaluation ----------------------------------------------------------------------------------------------
// facts: the DESIGN_PROBE result; ctx: { mode, viewport (name), static (default true), language: { lang, allow_text } | null }.
// Returns items { check, viewport, selector, value, threshold, status, note?, reason? } (no id, screen or screenshot).
export function evaluateStatic(f, ctx) {
  const { mode, viewport } = ctx, out = [];
  const runStatic = ctx.static !== false, wide = viewport === "wide";
  const th = (c) => designThreshold(c, mode, viewport);
  const add = (check, selector, value, ok, note) => out.push({ check, viewport, selector: selector || "body", value, threshold: th(check), status: ok ? "pass" : "fail", ...(note ? { note } : {}) });
  const nm = (check, reason) => out.push({ check, viewport, selector: "body", threshold: th(check), status: "not_measured", reason });
  const na = (check, note) => out.push({ check, viewport, selector: "body", threshold: th(check), status: "not_applicable", note });
  const list = (xs, n = 4) => xs.slice(0, n).join("; ") + (xs.length > n ? `; +${xs.length - n} more` : "");

  if (runStatic) {
    const hs = f.headings || [];
    if (!hs.length) nm("design_heading_lines", "no visible h1 or h2");
    else {
      const worst = hs.reduce((a, h) => (h.lines > a.lines ? h : a));
      const bad = hs.filter((h) => h.lines > 2);
      add("design_heading_lines", worst.selector, worst.lines, worst.lines <= 2, bad.length ? list(bad.map((h) => `${h.selector} wraps to ${h.lines} lines`)) : `${hs.length} headings, at most ${worst.lines} line(s)`);
    }

    const sizes = f.headingSizes || [], body = f.bodySize;
    if (!sizes.length || !body) nm("design_type_scale", !sizes.length ? "no visible heading" : "no body text size");
    else {
      const max = Math.max(...sizes), ratio = round(max / body);
      add("design_type_scale", f.largestHeading || "h1", ratio, designHolds(ratio, th("design_type_scale")), `font sizes px: largest heading ${max}, body ${body}, headings ${[...new Set(sizes)].sort((a, b) => b - a).join("/")}`);
    }

    if (!designApplies("design_body_measure", mode)) na("design_body_measure", DESIGN_NA_NOTES.design_body_measure);
    else {
      const ps = (f.paragraphs || []).filter((p) => p.lines >= 2 && p.chars > 0);
      if (!ps.length) nm("design_body_measure", "no body paragraph of 2 or more lines");
      else {
        const v = round(median(ps.map((p) => p.chars / p.lines)), 1);
        add("design_body_measure", ps[0].selector, v, designHolds(v, th("design_body_measure")), `median of ${ps.length} paragraph(s), characters per line`);
      }
    }

    if (wide) {
      const fo = f.fonts;
      if (!fo || !(fo.families || []).length) nm("design_fonts_loaded", "no visible text");
      else {
        const problems = [];
        let at = "body";
        for (const x of fo.families) {
          if (x.kind === "web-unloaded") problems.push(`${x.family} is declared but did not load (${x.count} element(s))`);
          else if (x.kind === "missing") problems.push(`${x.family} is not installed or declared, so the fallback shows (${x.count} element(s))`);
          else continue;
          if (at === "body") at = x.selector;
        }
        if ((mode === "persuade" || mode === "experience") && !(fo.heading?.kind === "web" || fo.body?.kind === "web")) problems.push(`heading face ${fo.heading?.family ?? "none"} and body face ${fo.body?.family ?? "none"} are system fonts; this mode needs a loaded web font`);
        add("design_fonts_loaded", at, problems.length, problems.length === 0, problems.length ? list(problems) : `${fo.families.length} families, all loaded`);
      }
    }

    const e = f.edge;
    if (!e) nm("design_edge_margins", "no content found to measure");
    else { const d = round(Math.abs(e.left - e.right), 1); add("design_edge_margins", "main", d, d <= 8, `left ${round(e.left, 1)}px, right ${round(e.right, 1)}px`); }

    const et = f.edgeText;
    if (!et) nm("design_edge_text", "no visible text");
    else add("design_edge_text", et.selector, round(et.distance, 1), et.distance >= 12, `${et.side} edge of the viewport`);

    const vac = vacuumOf(f.blocks || [], f.vh || 1);
    if (!vac) nm("design_vacuum", "fewer than two content blocks");
    else add("design_vacuum", vac.to, vac.ratio, vac.ratio <= 0.5, `${Math.round(vac.gap)}px empty between ${vac.from} and ${vac.to} (viewport height ${f.vh}px)`);

    const secs = f.sections || [], bare = secs.filter((s) => s.height > 200 && !s.titled);
    add("design_untitled_section", bare[0]?.selector || "body", bare.length, bare.length === 0, bare.length ? list(bare.map((s) => `${s.selector} (${Math.round(s.height)}px)`)) : `${secs.length} section(s) or regions, all with a heading or name`);

    if (!designApplies("design_empty_hero", mode)) na("design_empty_hero", DESIGN_NA_NOTES.design_empty_hero);
    else if (!f.hero) nm("design_empty_hero", "first viewport not measured");
    else {
      const miss = [["h1", f.hero.h1], ["primary action", f.hero.action], ["visual", f.hero.visual]].filter((x) => !x[1]).map((x) => x[0]);
      add("design_empty_hero", "body", miss.length, miss.length === 0, miss.length ? `first viewport lacks: ${miss.join(", ")}` : `h1, primary action and a visual (${f.hero.visualKind}) in the first viewport`);
    }

    if (wide) {
      const ss = f.surfaces || [];
      if (!ss.length) nm("design_surfaces", "no surface found");
      for (const s of ss) add("design_surfaces", s.selector, s.problems, s.problems === 0, `${s.surface}: ${s.note}`);
    }
  }

  if (wide && ctx.language) {
    const lang = String(ctx.language.lang || f.lang || "");
    if (!lang) nm("design_untranslated", "the page language is unknown");
    else if (/^en(-|$)/i.test(lang)) na("design_untranslated", ENGLISH_PAGE_NOTE);
    else {
      const bs = untranslatedBlocks(f.textBlocks, ctx.language.allow_text || []);
      add("design_untranslated", bs[0]?.selector || "body", bs.length, bs.length === 0, bs.length ? list(bs.map((b) => `${b.selector}: "${b.text}"`)) : `no English text block on a ${lang} page`);
    }
  }

  if (runStatic) evaluateUx(f, ctx, { add, nm, list });
  return out;
}

// The measurable high-severity UX rules (ux-rules.json maps rule ids to these). Counts of offenders, `== 0`, unless noted.
function evaluateUx(f, ctx, { add, nm, list }) {
  const u = f.ux;
  if (!u) {
    for (const c of DESIGN_STATIC_CHECKS.filter((x) => x.startsWith("design_ux_") && (!PHONE_ONLY.includes(x) || ctx.viewport === "phone390") && (!WIDE_ONLY.includes(x) || ctx.viewport === "wide"))) nm(c, "the probe supplied no UX facts");
    return;
  }
  const count = (check, set, noun, what) => {
    if (!set) return nm(check, `no ${noun} facts`);
    const bad = set.bad || [];
    add(check, bad[0]?.selector, bad.length, bad.length === 0, bad.length ? list(bad.map((b) => `${b.selector} ${what}`)) : `${set.total} ${noun} checked, none ${what.replace(/^has /, "lacks ")}`);
  };
  count("design_ux_alt_text", u.images, "image(s)", "has no alt attribute");
  count("design_ux_form_labels", u.fields, "form field(s)", "has no label or accessible name");
  count("design_ux_control_names", u.controls, "control(s)", "has no accessible name");
  if (ctx.viewport === "wide") {
    const m = u.viewportMeta, problems = [];
    if (m === null || m === undefined) problems.push("no meta viewport tag");
    else {
      if (!/width\s*=\s*device-width/i.test(m)) problems.push("width is not device-width");
      if (/user-scalable\s*=\s*(no|0)/i.test(m)) problems.push("user-scalable disables zoom");
      const mx = /maximum-scale\s*=\s*([\d.]+)/i.exec(m);
      if (mx && Number(mx[1]) < 2) problems.push(`maximum-scale ${mx[1]} limits zoom`);
    }
    add("design_ux_viewport_meta", "meta[name=viewport]", problems.length, problems.length === 0, problems.length ? problems.join("; ") : `viewport meta "${String(m).slice(0, 60)}"`);
  }
  if (ctx.viewport === "phone390") {
    if (typeof f.bodySize !== "number" || !(f.paragraphs || []).length) nm("design_ux_body_font_size", "no body paragraph to measure");
    else add("design_ux_body_font_size", f.paragraphs[0]?.selector, round(f.bodySize, 1), f.bodySize >= 16, `median body text ${round(f.bodySize, 1)}px at ${f.vw}px wide`);
  }
}

// --- pages of a config ---------------------------------------------------------------------------------------
// The pages the design group measures: design.screens (paths or screen ids; default every screen path), plus every
// design.languages path. screen = the screen id when the path is a configured screen, else the path.
export function designPages(c) {
  const d = c.design || {}, screens = c.screens || [];
  const label = (path) => screens.find((s) => s.path === path)?.id ?? path;
  const pages = new Map();
  for (const x of d.screens ?? screens.map((s) => s.path)) {
    const path = screens.find((s) => s.id === x)?.path ?? x;
    pages.set(path, { screen: label(path), path, static: true });
  }
  for (const l of d.languages || []) {
    const p = pages.get(l.path) || { screen: label(l.path), path: l.path, static: false };
    p.language = { lang: l.lang, allow_text: l.allow_text || [] };
    pages.set(l.path, p);
  }
  return [...pages.values()];
}
export const designMotionMin = (d) => ({ load: Number.isInteger(d?.motion_min?.load) ? d.motion_min.load : 3, scroll: Number.isInteger(d?.motion_min?.scroll) ? d.motion_min.scroll : 3 });

// --- assemble ------------------------------------------------------------------------------------------------
// raw.design = { pages: [{ path, not_measured?, viewports: [{ viewport, screenshot?, facts?, error?, images? }], ledger?: { items, images } }],
//                motion?: { items, scenes, not_measured } | { error } }   (screenshots are relative path strings)
// -> report.design. sha(path) returns the hex sha256 of a screenshot file, or throws when it is missing.
export function assembleDesign(raw, c, sha) {
  const d = c.design, mode = d.visitor_mode, rd = raw?.design || {};
  const pages = designPages(c);
  const out = { status: "run", mode, viewports: DESIGN_VIEWPORTS.map((v) => ({ ...v })), pages: [], items: [], screenshots: [], scenes: [], images: [], not_measured: [],
    image_ledger: d.image_ledger || null, scene_ids: (d.scenes || []).map((s) => s.id), motion_min: designMotionMin(d) };
  const shot = (p) => { if (!p) return undefined; if (typeof p === "object") return p.path && p.sha256 ? p : undefined; try { return { path: p, sha256: sha(p) }; } catch { return undefined; } };
  const push = (it) => out.items.push({ id: `D-${out.items.length + 1}`, ...it });
  const measured = [];
  for (const pg of pages) {
    const rp = (rd.pages || []).find((x) => x.path === pg.path);
    const entry = { screen: pg.screen, path: pg.path, static: pg.static, ...(pg.language ? { language: String(pg.language.lang) } : {}) };
    if (!rp || rp.not_measured) { out.pages.push({ ...entry, status: "not_measured", reason: rp?.not_measured || "the tool supplied no design facts" }); continue; }
    out.pages.push({ ...entry, status: "measured" });
    measured.push(pg);
    for (const vp of pg.static ? DESIGN_VIEWPORTS : DESIGN_VIEWPORTS.slice(0, 1)) {
      const rv = (rp.viewports || []).find((x) => x.viewport === vp.name);
      const ss = shot(rv?.screenshot);
      if (ss) out.screenshots.push({ screen: pg.screen, viewport: vp.name, screenshot: ss });
      if (!rv?.facts) {
        for (const check of expectedChecks(pg, mode, vp.name)) push({ check, screen: pg.screen, viewport: vp.name, selector: "body", threshold: designThreshold(check, mode, vp.name), status: "not_measured", reason: rv?.error || "viewport not measured" });
        continue;
      }
      for (const it of evaluateStatic(rv.facts, { mode, viewport: vp.name, static: pg.static, language: pg.language })) push({ ...it, screen: pg.screen, ...(ss ? { screenshot: ss } : {}) });
    }
    for (const it of rp.ledger?.items || []) push(normExternal(it, pg, shot));
    for (const im of rp.ledger?.images || []) if (!out.images.some((x) => x.src === im.src && x.file === im.file)) out.images.push(im);
  }
  if (!measured.length && pages.length && pages.every((pg) => { const rp = (rd.pages || []).find((x) => x.path === pg.path); return rp?.not_measured && /^not an HTML response/.test(rp.not_measured); })) {
    return { status: "not_applicable", mode, note: DESIGN_NOT_APPLICABLE_NOTE };
  }
  // motion: whatever motion-audit returned, normalised; every static page accounts for each motion check
  const mo = rd.motion;
  if (mo && !mo.error) {
    for (const it of mo.items || []) {
      if (it.check === "design_motion_count" && !designApplies(it.check, mode)) continue; // replaced by the fixed not_applicable item below
      push(normExternal(it, null, shot));
    }
    for (const s of mo.scenes || []) out.scenes.push({ ...s, stops: (s.stops || []).map((x) => ({ ...x, screenshot: shot(x.screenshot) })) });
    for (const n of mo.not_measured || []) out.not_measured.push(n);
  }
  const covered = (pg, check) => out.items.some((x) => x.check === check && (x.screen === pg.screen || x.screen === pg.path)) || out.not_measured.some((x) => x.check === check && (x.screen === pg.screen || x.screen === pg.path));
  for (const pg of measured.filter((x) => x.static)) {
    for (const check of ["design_motion_count", "design_reduced_motion", "design_no_script_visible"]) {
      if (covered(pg, check)) continue;
      const base = { check, screen: pg.screen, viewport: "wide", selector: "body", threshold: check === "design_motion_count" ? "== 0" : "== 0" };
      if (!designApplies(check, mode)) push({ ...base, status: "not_applicable", note: DESIGN_NA_NOTES[check] });
      else push({ ...base, status: "not_measured", reason: mo?.error || "motion audit produced no item for this check" });
    }
    if (d.image_ledger && !covered(pg, "design_image_ledger")) push({ check: "design_image_ledger", screen: pg.screen, viewport: "wide", selector: "body", threshold: "== 0", status: "not_measured", reason: "the tool supplied no image ledger result" });
  }
  for (const sc of d.scenes || []) {
    if (out.scenes.some((x) => x.id === sc.id) || out.not_measured.some((x) => x.check === "design_scene" && x.scene === sc.id)) continue;
    out.not_measured.push({ check: "design_scene", scene: sc.id, screen: pages.find((x) => x.path === sc.path)?.screen || sc.path, viewport: "wide", reason: mo?.error || "the tool supplied no scene result" });
  }
  return out;
}

// An item from motion-audit or ledger: ids are reassigned, screenshots hashed, pass/fail recomputed from value and threshold.
function normExternal(it, pg, shot) {
  const x = { ...it };
  delete x.id;
  if (pg && !x.screen) x.screen = pg.screen;
  if (!x.viewport) x.viewport = "wide";
  if (!x.selector) x.selector = "body";
  if (x.screenshot !== undefined) { const s = shot(x.screenshot); if (s) x.screenshot = s; else delete x.screenshot; }
  if (!DESIGN_STATUSES.includes(x.status)) { x.status = "not_measured"; x.reason = x.reason || "the item carried no valid status"; }
  if (x.status === "pass" || x.status === "fail") {
    const h = designHolds(x.value, x.threshold);
    if (h !== null) x.status = h ? "pass" : "fail";
  }
  return x;
}

// --- the in-page probe ---------------------------------------------------------------------------------------
// Self-contained: serialised with toString() and run inside the page. Returns plain JSON facts for evaluateStatic.
export function designProbeSource() {
  /* eslint-disable no-undef */
  const de = document.documentElement, vw = de.clientWidth, vh = innerHeight;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const MEDIA = new Set(["IMG", "VIDEO", "CANVAS", "PICTURE", "IFRAME", "svg"]);
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "none";
    if (el === de) return "html";
    if (el === document.body) return "body";
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body && e !== de; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (same.length > 1) p += `:nth-of-type(${same.indexOf(e) + 1})`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const css = new Map(), fade = new Map(), rects = new Map();
  const cs = (e) => { if (!css.has(e)) css.set(e, getComputedStyle(e)); return css.get(e); };
  const rect = (e) => { if (!rects.has(e)) rects.set(e, e.getBoundingClientRect()); return rects.get(e); };
  // opacity 0 counts as hidden only inside the first screen; below it a not-yet-revealed block is judged by the motion audit (reduced motion, no script)
  const faded = (e) => { if (!e || e === de) return false; if (!fade.has(e)) fade.set(e, (cs(e).opacity === "0" && e.getBoundingClientRect().top + scrollY < vh) || faded(e.parentElement)); return fade.get(e); };
  const shown = (e, ignoreFade) => {
    const s = cs(e), r = rect(e);
    if (s.display === "none" || s.visibility !== "visible" || r.width * r.height <= 1) return false;
    if (/rect\(0px,? 0px,? 0px,? 0px\)/.test(s.clip) || /inset\(50%/.test(s.clipPath)) return false;
    if (r.right <= 0 || r.bottom + scrollY <= 0) return false;
    return ignoreFade || !faded(e);
  };
  const clipped = (e) => { for (let a = e.parentElement; a && a !== document.body && a !== de; a = a.parentElement) if (cs(a).overflowX !== "visible") return true; return false; };
  const fixed = (e) => { for (let a = e; a && a !== de; a = a.parentElement) if (cs(a).position === "fixed") return true; return false; };
  const own = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
  const all = [...document.body.querySelectorAll("*")].filter((e) => !SKIP.has(e.tagName) && !e.parentElement?.closest("svg")).slice(0, 6000);
  const texts = all.filter((e) => e.tagName !== "svg" && own(e) && shown(e));
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  const lineCount = (e) => {
    const rg = document.createRange(); rg.selectNodeContents(e);
    const rs = [...rg.getClientRects()].filter((r) => r.width > 1 && r.height > 1).sort((a, b) => a.top - b.top);
    let n = 0, last = -1e9;
    for (const r of rs) if (r.top - last > Math.max(4, r.height * 0.5)) { n++; last = r.top; }
    return Math.max(1, n);
  };

  // headings and type scale
  const headings = [...document.querySelectorAll("h1,h2")].filter((e) => shown(e) && e.textContent.trim()).map((e) => ({ selector: sel(e), tag: e.tagName.toLowerCase(), lines: lineCount(e) }));
  const hsized = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((e) => shown(e) && e.textContent.trim()).map((e) => ({ e, size: parseFloat(cs(e).fontSize) }));
  const largest = hsized.reduce((a, h) => (!a || h.size > a.size ? h : a), null);
  const paras = [...document.querySelectorAll("p,li,dd,blockquote")].filter((e) => shown(e) && own(e).length >= 40 && !e.closest("nav,header,footer,button,a"));
  const paragraphs = paras.slice(0, 200).map((e) => ({ selector: sel(e), chars: e.textContent.replace(/\s+/g, " ").trim().length, lines: lineCount(e) }));
  const bodySize = paras.length ? med(paras.map((e) => parseFloat(cs(e).fontSize))) : parseFloat(cs(document.body).fontSize);

  // fonts
  const faces = [...document.fonts].map((x) => ({ family: x.family.replace(/^["']|["']$/g, "").toLowerCase(), status: x.status }));
  const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong", "-apple-system", "blinkmacsystemfont"]);
  const ctx2d = document.createElement("canvas").getContext("2d");
  const width = (font) => { ctx2d.font = `72px ${font}`; return ctx2d.measureText("mmmmmmmmmmlli1WQ@#").width; };
  const installed = (fam) => ["monospace", "serif", "sans-serif"].some((b) => width(`"${fam}", ${b}`) !== width(b));
  const first = (e) => cs(e).fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
  const kindOf = (fam) => {
    const l = fam.toLowerCase();
    if (GENERIC.has(l)) return "system";
    const mine = faces.filter((x) => x.family === l);
    if (mine.length) return mine.some((x) => x.status === "loaded") ? "web" : "web-unloaded";
    return installed(fam) ? "local" : "missing";
  };
  const fams = new Map();
  for (const e of texts) { const fam = first(e); if (!fams.has(fam)) fams.set(fam, { family: fam, kind: kindOf(fam), count: 0, selector: sel(e) }); fams.get(fam).count++; }
  const hf = headings.length ? first(document.querySelector(headings[0].selector) || document.body) : null;
  const bf = first(paras[0] || document.body);
  const fonts = { families: [...fams.values()], heading: hf ? { family: hf, kind: kindOf(hf) } : null, body: { family: bf, kind: kindOf(bf) } };

  // style sheets: font faces, ::selection and scrollbar theming
  let selThemed = false, scrollThemed = false;
  const fontFaces = [];
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r.type === CSSRule.FONT_FACE_RULE) {
        const src = r.style.getPropertyValue("src"), fam = r.style.getPropertyValue("font-family").replace(/^["']|["']$/g, "");
        fontFaces.push({ family: fam, src, urls: [...src.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => { try { return new URL(m[1], base).href; } catch { return m[1]; } }), loaded: faces.some((x) => x.family === fam.toLowerCase() && x.status === "loaded") });
      } else {
        if (r.selectorText && /::(-moz-)?selection/.test(r.selectorText) && (r.style.backgroundColor || r.style.background || r.style.color)) selThemed = true;
        if (r.selectorText && /::-webkit-scrollbar/.test(r.selectorText)) scrollThemed = true;
        if (r.cssRules) walk(r.cssRules, base);
      }
    }
  };
  for (const ss of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) { try { walk(ss.cssRules, ss.href || document.baseURI); } catch { /* cross-origin sheet */ } }

  // edges
  const main = document.querySelector("main") || document.body;
  const content = [...main.querySelectorAll("*")].filter((e) => !SKIP.has(e.tagName) && !e.parentElement?.closest("svg") && (MEDIA.has(e.tagName) || (e.tagName !== "svg" && own(e))) && shown(e) && !clipped(e) && !fixed(e));
  // The outer frame of the content: each leaf is replaced by its outermost block under <main> (the section-level box). A full-bleed block
  // contributes its padding box edge (content area), so a left-aligned hero over a full-width ground is not mistaken for lopsided content.
  const outer = (e) => { let t = e; while (t.parentElement && t.parentElement !== main) t = t.parentElement; return t; };
  const frame = (e) => {
    const t = outer(e), r = rect(t);
    if (r.left <= 1 && r.right >= vw - 1) { const cs = getComputedStyle(t); return { left: r.left + (parseFloat(cs.paddingLeft) || 0), right: r.right - (parseFloat(cs.paddingRight) || 0) }; }
    return { left: r.left, right: r.right };
  };
  const frames = [...new Set(content.map(outer))].map((t) => frame(t));
  const inner = frames.filter((f) => !(f.left <= 1 && f.right >= vw - 1));
  const span = inner.length ? inner : frames;
  const edge = span.length ? { left: Math.min(...span.map((f) => f.left)), right: vw - Math.max(...span.map((f) => f.right)) } : null;
  let edgeText = null;
  for (const e of texts) {
    if (clipped(e)) continue;
    for (const n of e.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {
        if (r.width < 1 || r.right <= 0 || r.left >= vw) continue;
        for (const [d, side] of [[r.left, "left"], [vw - r.right, "right"]]) if (!edgeText || d < edgeText.distance) edgeText = { distance: d, side, selector: sel(e) };
      }
    }
  }

  // vacuum
  const blocks = all.filter((e) => (e.tagName !== "svg" && (own(e) || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.tagName))) || MEDIA.has(e.tagName))
    .filter((e) => shown(e, true) && !fixed(e) && rect(e).height <= vh * 1.5).slice(0, 4000) // a scroll-revealed block still holds its place, so it is not a gap
    .map((e) => ({ top: rect(e).top + scrollY, bottom: rect(e).bottom + scrollY, selector: sel(e) }));

  // sections
  const sections = [...document.querySelectorAll("section,[role=region],aside")].filter((e) => shown(e)).map((e) => {
    const labelled = (e.getAttribute("aria-label") || "").trim() || [...(e.getAttribute("aria-labelledby") || "").split(/\s+/)].some((id) => id && (document.getElementById(id)?.textContent || "").trim());
    const heading = [...e.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].some((h) => h.textContent.trim());
    return { selector: sel(e), height: rect(e).height, titled: !!(labelled || heading) };
  });

  // first screen
  const inView = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const h1 = [...document.querySelectorAll("h1")].some((e) => shown(e) && inView(rect(e)) && e.textContent.trim());
  const action = [...document.querySelectorAll("a[href],button,[role=button],input[type=submit]")].some((e) => {
    if (!shown(e) || !inView(rect(e)) || e.closest("nav,[role=navigation]") || e.matches("[aria-expanded],[aria-haspopup]")) return false;
    const label = (e.textContent || e.value || e.getAttribute("aria-label") || "").trim();
    if (label.length < 3) return false;
    const s = cs(e);
    return e.tagName !== "A" || alpha(s.backgroundColor) > 0 || s.backgroundImage !== "none" || (parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0);
  });
  const ground = (() => { for (const e of [document.body, de]) if (alpha(cs(e).backgroundColor) > 0) return cs(e).backgroundColor; return "rgb(255, 255, 255)"; })();
  let visualKind = null;
  for (const e of document.querySelectorAll("img,svg,canvas,video,picture")) {
    const r = rect(e);
    if (shown(e) && inView(r) && Math.min(r.width, r.height) >= 80 && !e.parentElement?.closest("svg")) { visualKind = e.tagName.toLowerCase(); break; }
  }
  if (!visualKind) {
    for (const e of all) {
      const r = rect(e), s = cs(e);
      if (!inView(r) || !shown(e) || e === document.body) continue;
      const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (area >= 0.25 * vw * vh && (s.backgroundImage !== "none" || (alpha(s.backgroundColor) > 0 && s.backgroundColor !== ground))) { visualKind = "colour field"; break; }
    }
  }
  const hero = { h1, action, visual: !!visualKind, visualKind: visualKind || "none" };

  // browser surfaces
  const surfaces = [];
  surfaces.push({ surface: "selection", selector: "::selection", problems: selThemed ? 0 : 1, note: selThemed ? "::selection sets a colour" : "no ::selection rule sets a colour (browser default)" });
  surfaces.push({ surface: "scrollbar", selector: "html", problems: cs(de).scrollbarColor !== "auto" || scrollThemed ? 0 : 1, note: cs(de).scrollbarColor !== "auto" || scrollThemed ? "scrollbar is themed" : "neither scrollbar-color nor ::-webkit-scrollbar is set" });
  const fields = [...document.querySelectorAll("textarea,input:not([type]),input[type=text],input[type=email],input[type=search],input[type=url],input[type=tel],input[type=password],input[type=number]")].filter(shown);
  if (fields.length) { const bad = fields.filter((e) => cs(e).caretColor === "auto"); surfaces.push({ surface: "caret", selector: bad[0] ? sel(bad[0]) : sel(fields[0]), problems: bad.length, note: `${bad.length} of ${fields.length} text field(s) keep caret-color auto` }); }
  const links = [...document.querySelectorAll("a[href]")].filter((e) => shown(e) && own(e) && /underline/.test(cs(e).textDecorationLine));
  if (links.length) { const bad = links.filter((e) => cs(e).textUnderlineOffset === "auto"); surfaces.push({ surface: "underline-offset", selector: bad[0] ? sel(bad[0]) : sel(links[0]), problems: bad.length, note: `${bad.length} of ${links.length} underlined link(s) keep text-underline-offset auto` }); }
  const cells = [...document.querySelectorAll("td,th")].filter((e) => shown(e) && /^[\s$€£₺¥+\-−~]*\d[\d\s.,:%]*[A-Za-z%]{0,3}$/.test(e.textContent.trim()));
  if (cells.length) { const bad = cells.filter((e) => !/tabular-nums/.test(cs(e).fontVariantNumeric) && !/tnum/.test(cs(e).fontFeatureSettings)); surfaces.push({ surface: "tabular-numerals", selector: bad[0] ? sel(bad[0]) : sel(cells[0]), problems: bad.length, note: `${bad.length} of ${cells.length} numeric table cell(s) lack tabular numerals` }); }

  // text blocks for the untranslated check
  const textBlocks = texts.filter((e) => !e.closest("code,pre,kbd,samp,textarea,[translate=no]")).slice(0, 600).map((e) => ({ selector: sel(e), text: own(e).slice(0, 300) })).filter((b) => b.text.split(" ").length >= 4);

  // ux (the high-severity rules a page can prove): alt text, form labels, control names, viewport meta
  const textOf = (id) => (document.getElementById(id)?.textContent || "").trim();
  const named = (e) => {
    if ((e.getAttribute("aria-label") || "").trim() || (e.getAttribute("title") || "").trim()) return true;
    if ((e.getAttribute("aria-labelledby") || "").split(/\s+/).some((id) => id && textOf(id))) return true;
    if (e.labels && [...e.labels].some((l) => l.textContent.trim())) return true;
    if (e.tagName === "INPUT" && /^(submit|button|reset)$/i.test(e.type) && (e.value || "").trim()) return true;
    if (e.tagName === "INPUT" && e.type === "image" && (e.getAttribute("alt") || "").trim()) return true;
    if ((e.textContent || "").trim()) return true;
    return [...e.querySelectorAll("img[alt],svg title,[aria-label]")].some((x) => (x.getAttribute("alt") || x.getAttribute("aria-label") || x.textContent || "").trim());
  };
  const uxImgs = [...document.querySelectorAll("img")].filter((e) => shown(e, true));
  const uxFields = [...document.querySelectorAll("input,select,textarea")].filter((e) => !/^(hidden|submit|button|reset|image)$/i.test(e.type || "") && shown(e, true));
  const uxCtl = [...document.querySelectorAll("button,[role=button],a[href],summary,input[type=submit],input[type=button],input[type=image]")].filter((e) => shown(e, true));
  const vm = document.querySelector("meta[name=viewport]");
  const ux = {
    viewportMeta: vm ? vm.getAttribute("content") || "" : null,
    images: { total: uxImgs.length, bad: uxImgs.filter((e) => !e.hasAttribute("alt") && !/^(presentation|none)$/.test(e.getAttribute("role") || "") && !(e.getAttribute("aria-label") || e.getAttribute("aria-labelledby"))).slice(0, 20).map((e) => ({ selector: sel(e) })) },
    fields: { total: uxFields.length, bad: uxFields.filter((e) => !named(e)).slice(0, 20).map((e) => ({ selector: sel(e) })) },
    controls: { total: uxCtl.length, bad: uxCtl.filter((e) => !named(e)).slice(0, 20).map((e) => ({ selector: sel(e) })) },
  };

  return { url: location.href, lang: de.lang || "", vw, vh, docHeight: de.scrollHeight, headings, headingSizes: hsized.map((h) => h.size), largestHeading: largest ? sel(largest.e) : null,
    bodySize, paragraphs, fonts, fontFaces, edge, edgeText, blocks, sections, hero, surfaces, textBlocks, ux };
}
export const DESIGN_PROBE = `(${designProbeSource.toString()})`;
