// visual-proof image ledger (0.0.27, A170): the raster images and self-hosted fonts of a rendered page against `docs/design/IMAGES.md`.
// No dependencies. IMAGES_PROBE and FONTS_PROBE run in the page (p.ev); parseLedger and ledgerItems are pure.
//
// Ledger format: Markdown tables. `## Images`: | file | source_url | license | credit | used_in |
//                                `## Fonts`:  | file | family | license | source | used_in |
// A row is valid only when file, license and credit (Images) or source (Fonts) are non-empty.

export const LEDGER_CHECK = "design_image_ledger";

// Expression for p.ev: every raster image on the page -> [{ src, kind: "img"|"picture"|"background"|"poster", selector }].
// img.currentSrc (the source the browser really chose, so a <picture> source in use is covered), CSS background-image url()s of every
// element and its ::before/::after, video posters. SVG files and data:image/svg+xml are ignored. A data: raster keeps a short prefix.
export const IMAGES_PROBE = `(() => {
  const sel = (el) => {
    if (window.__vp && window.__vp.sel) return window.__vp.sel(el);
    if (el.id) return "#" + CSS.escape(el.id);
    let s = el.tagName.toLowerCase(); if (el.classList.length) s += "." + CSS.escape(el.classList[0]); return s;
  };
  const isSvg = (u) => /^data:image\\/svg/i.test(u) || /\\.svg(?:[?#].*)?$/i.test(u.split("#")[0]);
  const short = (u) => /^data:/i.test(u) ? u.slice(0, 40) + "...(" + u.length + " chars)" : u;
  const out = [], seen = new Set();
  const add = (src, kind, el) => {
    if (!src || isSvg(src)) return;
    const key = kind + "|" + src; if (seen.has(key)) return; seen.add(key);
    out.push({ src: short(src), kind, selector: sel(el) });
  };
  for (const img of document.querySelectorAll("img")) add(img.currentSrc || img.src, img.parentElement && img.parentElement.tagName === "PICTURE" ? "picture" : "img", img);
  for (const i of document.querySelectorAll('input[type="image"]')) add(i.src, "img", i);
  for (const v of document.querySelectorAll("video[poster]")) add(v.poster, "poster", v);
  const urls = (v) => { const r = []; const re = /url\\((?:"([^"]*)"|'([^']*)'|([^)]*))\\)/g; for (let m; (m = re.exec(v));) r.push((m[1] ?? m[2] ?? m[3] ?? "").trim()); return r; };
  for (const el of document.querySelectorAll("*")) {
    for (const pseudo of [null, "::before", "::after"]) {
      const bg = getComputedStyle(el, pseudo).backgroundImage;
      if (bg && bg !== "none") for (const u of urls(bg)) add(u, "background", el);
    }
  }
  return out;
})()`;

// Expression for p.ev: the @font-face rules of the page's readable style sheets -> [{ file, family, self_hosted }] (first url() of each
// rule; self_hosted: same origin as the page, or a file: page). A sheet the browser will not expose is skipped.
export const FONTS_PROBE = `(() => {
  const out = [], seen = new Set();
  const collect = (rules, base) => { for (const r of rules) {
    if (r.cssRules && !(r instanceof CSSFontFaceRule)) { try { collect(r.cssRules, base); } catch (e) {} continue; }
    if (!(r instanceof CSSFontFaceRule)) continue;
    const m = /url\\((?:"([^"]*)"|'([^']*)'|([^)]*))\\)/.exec(r.style.getPropertyValue("src") || "");
    const family = (r.style.getPropertyValue("font-family") || "").replace(/^["']|["']$/g, "").trim();
    if (!m || !family) continue;
    let file = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (/^data:/i.test(file)) { file = "data:(inline)"; }
    else { try { file = new URL(file, base || location.href).href; } catch (e) {} }
    const key = family + "|" + file; if (seen.has(key)) continue; seen.add(key);
    let self = true; try { const u = new URL(file); self = u.protocol === "file:" || u.origin === location.origin; } catch (e) {}
    out.push({ file, family, self_hosted: self && !/^data:/.test(file) });
  } };
  for (const sh of document.styleSheets) { try { collect(sh.cssRules, sh.href); } catch (e) {} }
  return out;
})()`;

// --- ledger parsing ------------------------------------------------------------------------------------------
const PLACEHOLDER = /^(?:-+|–|—|n\/a|na|none|tbd|todo|\?+|\.\.\.|<[^>]*>)$/i;
const cell = (c) => c.trim().replace(/^`+|`+$/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
const filled = (v) => typeof v === "string" && v.trim() !== "" && !PLACEHOLDER.test(v.trim());
const splitRow = (l) => { const t = l.trim().replace(/^\|/, "").replace(/\|$/, ""); return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|")); };
const COLS = { images: ["file", "source_url", "license", "credit", "used_in"], fonts: ["file", "family", "license", "source", "used_in"] };
const REQUIRED = { images: ["file", "license", "credit"], fonts: ["file", "license", "source"] };

// Text of a ledger -> { images: [row], fonts: [row] }; row = { file, ...columns, line, valid, problems: [column names]} (a source_url
// read from the cell text of a Markdown link keeps the link text; the url is kept in `source_url_raw` when present).
export function parseLedger(text) {
  const out = { images: [], fonts: [] };
  let section = null, header = null;
  String(text || "").split(/\r?\n/).forEach((raw, i) => {
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) { const t = h[1].trim().toLowerCase(); section = t === "images" ? "images" : t === "fonts" ? "fonts" : null; header = null; return; }
    if (!section || !/^\s*\|/.test(raw)) return;
    const cells = splitRow(raw);
    if (cells.every((c) => /^\s*:?-{2,}:?\s*$/.test(c))) return; // separator row
    if (!header) {
      header = cells.map((c) => cell(c).toLowerCase().replace(/[\s-]+/g, "_"));
      return;
    }
    const row = { line: i + 1 };
    for (const col of COLS[section]) { const idx = header.indexOf(col); row[col] = idx >= 0 && idx < cells.length ? cell(cells[idx]) : ""; }
    const link = /\]\(([^)]*)\)/.exec(cells[header.indexOf("source_url")] || "");
    if (link) row.source_url_raw = link[1];
    row.problems = REQUIRED[section].filter((c) => !filled(row[c]));
    row.valid = row.problems.length === 0;
    out[section].push(row);
  });
  return out;
}

// --- matching -------------------------------------------------------------------------------------------------
const pathOf = (u) => {
  let t = String(u).trim();
  try { const x = new URL(t); t = x.protocol === "data:" ? t : decodeURIComponent(x.pathname); } catch { t = t.split(/[?#]/)[0]; try { t = decodeURIComponent(t); } catch { /* keep */ } }
  return t.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");
};
const baseName = (p) => p.split("/").pop().toLowerCase();
// Does the ledger `file` name this page url? Full path suffix when the ledger gives folders, else the file name.
export function ledgerMatches(file, src) {
  const f = pathOf(file).toLowerCase(), s = pathOf(src).toLowerCase();
  if (!f || !s) return false;
  if (String(file).trim() === String(src).trim()) return true;
  if (s === f || s.endsWith("/" + f)) return true;
  return !f.includes("/") && baseName(s) === f;
}
const rowMatches = (row, src) => ledgerMatches(row.file, src) || (row.source_url && String(row.source_url).trim() === String(src).trim()) || (row.source_url_raw && row.source_url_raw === src);

// { images, ledgerText, ledgerPath, screen, viewport, fonts } -> { items, images }
//  images: IMAGES_PROBE result; ledgerText: the ledger file's text, or null/undefined when the file does not exist;
//  fonts: [{ file, family }] of self-hosted faces (FONTS_PROBE, self_hosted only).
// items (check design_image_ledger): one fail per missing image / invalid row / missing font row, one pass item otherwise.
// images: report `images` rows [{ src, file, in_ledger }] (file: the ledger row's file, or null).
export function ledgerItems({ images = [], ledgerText, ledgerPath = "docs/design/IMAGES.md", screen, viewport, fonts = [] } = {}) {
  const base = { check: LEDGER_CHECK, screen, viewport };
  const items = [], rows = [];
  if (typeof ledgerText !== "string") {
    items.push({ ...base, selector: ledgerPath, value: 1, threshold: "== 0", status: "fail", note: `image ledger ${ledgerPath} does not exist` });
    for (const i of images) rows.push({ src: i.src, file: null, in_ledger: false });
    return { items, images: rows };
  }
  const ledger = parseLedger(ledgerText);
  for (const img of images) {
    const matched = ledger.images.filter((r) => rowMatches(r, img.src));
    const good = matched.find((r) => r.valid), bad = matched.find((r) => !r.valid);
    if (good) { rows.push({ src: img.src, file: good.file, in_ledger: true }); continue; }
    rows.push({ src: img.src, file: bad ? bad.file : null, in_ledger: false });
    items.push({ ...base, selector: img.selector, value: 1, threshold: "== 0", status: "fail",
      note: bad ? `${img.kind} ${img.src}: ledger row at ${ledgerPath}:${bad.line} lacks ${bad.problems.join(", ")}` : `${img.kind} ${img.src} has no row in ${ledgerPath}` });
  }
  for (const f of fonts) {
    const matched = ledger.fonts.filter((r) => ledgerMatches(r.file, f.file) || (f.family && r.family && r.family.toLowerCase() === String(f.family).toLowerCase()));
    const good = matched.find((r) => r.valid), bad = matched.find((r) => !r.valid);
    if (good) continue;
    items.push({ ...base, selector: "@font-face", value: 1, threshold: "== 0", status: "fail",
      note: bad ? `font ${f.family} (${f.file}): ledger row at ${ledgerPath}:${bad.line} lacks ${bad.problems.join(", ")}` : `self-hosted font ${f.family} (${f.file}) has no row in the ${ledgerPath} Fonts table` });
  }
  if (!items.length) items.push({ ...base, selector: "body", value: 0, threshold: "== 0", status: "pass", note: `${images.length} raster image(s) and ${fonts.length} self-hosted font(s), all in the ledger` });
  return { items, images: rows };
}
