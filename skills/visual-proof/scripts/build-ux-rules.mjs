#!/usr/bin/env node
// Maintainer tool (A170): derives skills/visual-proof/ux-rules.json from a UX guidelines table.
//   node build-ux-rules.mjs --library <dir|file.csv> [--out ux-rules.json] [--check]
// <dir> holds ux-guidelines.csv (e.g. skills/ui-design/library). Output is deterministic: one entry per row,
// { id, severity, measure }. The id is the slug of the row's Category and Issue columns; severity is the row's own,
// normalised to high|medium|low (an extra-high grade counts as high); measure is a check id from MEASURES below, else "judged".
// No prose of the table is copied. ux-rules.json works without the table; this script is not used at run time.
// --check: exit 1 when the file on disk differs from what the table yields (or a MEASURES key matches no row).

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Which high-severity (and a few lower) rules a rendered page proves. Everything absent is judged.
// Core checks are in references/MEASURE.md; design_ux_* are the design group's UX checks.
export const MEASURES = {
  "animation-reduced-motion": "design_reduced_motion",
  "accessibility-motion-sensitivity": "design_reduced_motion",
  "touch-touch-target-size": "touch_target",
  "responsive-touch-friendly": "touch_target",
  "accessibility-target-size-minimum": "touch_target",
  "touch-touch-spacing": "touch_target",
  "interaction-focus-states": "focus_visible",
  "accessibility-focus-appearance": "focus_visible",
  "accessibility-keyboard-navigation": "focus_order",
  "accessibility-color-contrast": "contrast",
  "typography-contrast-readability": "contrast",
  "accessibility-alt-text": "design_ux_alt_text",
  "accessibility-aria-labels": "design_ux_control_names",
  "accessibility-form-labels": "design_ux_form_labels",
  "forms-input-labels": "design_ux_form_labels",
  "responsive-readable-font-size": "design_ux_body_font_size",
  "responsive-viewport-meta": "design_ux_viewport_meta",
  "responsive-horizontal-scroll": "horizontal_scroll",
  "layout-long-token-wrapping": "viewport_overflow",
  "typography-line-length": "design_body_measure",
  "typography-font-loading": "design_fonts_loaded",
};

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const sev = (t) => { const s = String(t).trim().toLowerCase(); return s === "high" || s === "critical" ? "high" : s === "low" ? "low" : "medium"; };

// RFC 4180-ish parser: quoted fields, doubled quotes, newlines inside quotes.
export function parseCsv(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

export function buildRules(csvText) {
  const [head, ...body] = parseCsv(csvText);
  const col = (n) => head.indexOf(n);
  const [ic, iu, is] = [col("Category"), col("Issue"), col("Severity")];
  if (ic < 0 || iu < 0 || is < 0) throw new Error("the table needs Category, Issue and Severity columns");
  const rules = [], seen = new Set();
  for (const r of body) {
    const id = slug(`${r[ic]} ${r[iu]}`);
    if (!id) throw new Error("a row has no Category and Issue");
    if (seen.has(id)) throw new Error(`duplicate rule id ${id}`);
    seen.add(id);
    rules.push({ id, severity: sev(r[is]), measure: MEASURES[id] || "judged" });
  }
  const stray = Object.keys(MEASURES).filter((k) => !seen.has(k));
  if (stray.length) throw new Error(`MEASURES names rules the table does not have: ${stray.join(", ")}`);
  return rules;
}

export const render = (rules) => JSON.stringify({ schema: "visual-proof.ux-rules/1", rules }, null, 0).replace(/\{"id"/g, "\n  {\"id\"").replace(/\]\}$/, "\n]}") + "\n";

function main(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const lib = get("--library");
  if (!lib) { console.error("usage: build-ux-rules.mjs --library <dir|file.csv> [--out FILE] [--check]"); return 2; }
  const csv = existsSync(lib) && statSync(lib).isDirectory() ? join(lib, "ux-guidelines.csv") : lib;
  if (!existsSync(csv)) { console.error(`not found: ${csv}`); return 2; }
  const out = get("--out") || join(dirname(fileURLToPath(import.meta.url)), "..", "ux-rules.json");
  let text;
  try { text = render(buildRules(readFileSync(csv, "utf8"))); } catch (e) { console.error(`build-ux-rules: ${e.message}`); return 1; }
  if (argv.includes("--check")) {
    const have = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (have !== text) { console.error(`build-ux-rules: ${out} is out of date; run without --check`); return 1; }
    console.log(`ux-rules ok (${JSON.parse(text).rules.length} rules)`);
    return 0;
  }
  writeFileSync(out, text);
  console.log(`wrote ${out} (${JSON.parse(text).rules.length} rules)`);
  return 0;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
