// The raw measurement of the recorded text-only expectations (A380 review): a persuade-mode config with an image ledger and the pages given, one
// screen per page. Used by visual-proof-textonly.test.mjs with the current assemble and, once, with the assemble of main before A380 to record
// tests/skills/fixtures/visual-proof-textonly/*.json (the recorder: node tests/skills/textonly-raw.mjs <skills/visual-proof dir of main> <out dir>).
// The screenshots are small files written into `dir`, so their sha256 are fixed.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const facts = (over = {}) => ({ headings: [{ selector: "h1", lines: 1 }], headingSizes: [64], largestHeading: "h1", bodySize: 16, paragraphs: [{ selector: "p", lines: 3, chars: 60 }], vh: 900, vw: 1440, lang: "en",
  fonts: { families: [{ family: "D", kind: "web", count: 1 }], heading: { kind: "web", family: "D" }, body: { kind: "web", family: "D" } }, edge: { left: 48, right: 48 }, edgeText: { selector: "h1", distance: 48, side: "left" },
  blocks: [{ top: 0, bottom: 500, selector: "header" }, { top: 560, bottom: 1100, selector: "section" }], sections: [{ selector: "section", height: 540, titled: true }], hero: { h1: true, action: false, visual: false, visualKind: "none" },
  media: { count: 0, selectors: [] }, surfaces: [{ selector: "::selection", surface: "selection", problems: 0, note: "themed" }], textBlocks: [], markupBlocks: [],
  ux: { images: { total: 0, bad: [] }, fields: { total: 0, bad: [] }, controls: { total: 1, bad: [] }, viewportMeta: "width=device-width, initial-scale=1" }, ...over });
const OK = { viewport_overflow: [0, "<= 0"], horizontal_scroll: [360, "<= 360"], hidden_interactive: [5, "> 1"], overlapping_interactive: [0, "== 0"], contrast: [7.1, ">= 4.5"], touch_target: [40, ">= 24"], focus_order: [0, "== 0"], focus_visible: [1, "== 1"] };
const VPS = [{ name: "phone", width: 360, height: 740 }, { name: "tablet", width: 768, height: 1024 }, { name: "desktop", width: 1280, height: 800 }];
const CORE = ["viewport_overflow", "horizontal_scroll", "hidden_interactive", "overlapping_interactive", "contrast", "touch_target", "focus_order", "focus_visible"];
const LEDGER = "## Images\n\n| file | source_url | license | credit | used_in |\n|---|---|---|---|---|\n| hero.jpg | x | CC0 | me | home |\n";

/** The raw input of `assemble` for these pages; `kinds` is the config's page_kinds (absent when not given). @param {string} dir @param {string[]} paths @param {any} [kinds] @param {Function} ledgerItems */
export function rawFor(dir, paths, kinds, ledgerItems) {
  mkdirSync(join(dir, "screenshots"), { recursive: true });
  const png = (n) => { const f = `screenshots/${n.replace(/\//g, "_")}.png`; writeFileSync(join(dir, f), `png ${n}`); return f; };
  const id = (i) => `S${i + 1}`;
  const config = { class: "STANDARD", base_url: "file:///app/", viewports: VPS, screens: paths.map((p, i) => ({ id: id(i), path: p, states: [{ name: "default", path: p, ready: "main" }] })), criteria: [],
    ...(kinds ? { page_kinds: kinds } : {}), design: { visitor_mode: "persuade", screens: paths, image_ledger: "docs/design/IMAGES.md" } };
  const cells = paths.flatMap((_, i) => VPS.map((v) => ({ screen: id(i), state: "default", viewport: v.name, screenshot: png(`${id(i)}-${v.name}`), rendered: true, not_measured: [],
    items: CORE.map((check) => ({ check, selector: check === "horizontal_scroll" ? "html" : "body", value: OK[check][0], threshold: OK[check][1], status: "pass" })) })));
  const pages = paths.map((p, i) => ({ path: p, viewports: ["wide", "tablet", "phone390"].map((viewport) => ({ viewport, screenshot: png(`${p}-${viewport}`), facts: { ...facts(), vw: viewport === "phone390" ? 390 : 1440 } })),
    ledger: { ...ledgerItems({ images: [], ledgerText: LEDGER, screen: id(i), viewport: "wide" }), fonts: 0 } }));
  const motion = { items: paths.flatMap((_, i) => [
    ...["load", "scroll"].map((phase) => ({ check: "design_motion_count", phase, screen: id(i), viewport: "wide", selector: "html", value: 0, threshold: ">= 3", status: "fail", note: `${phase}: 0` })),
    ...["design_reduced_motion", "design_no_script_visible"].map((check) => ({ check, screen: id(i), viewport: "wide", selector: "body", value: 0, threshold: "== 0", status: "pass" }))]), scenes: [], not_measured: [] };
  return { tool: { kind: "headless-browser", name: "chromium" }, config, cells, network: { interception: "on", blocked: [] }, design: { pages, motion } };
}

export const RECORDED = { single: ["index.html"], mixed: ["index.html", "legal/privacy.html"] };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [vp, out] = process.argv.slice(2).map((x) => resolve(x));
  const { assemble } = await import(pathToFileURL(join(vp, "scripts/measure.mjs")).href);
  const { ledgerItems } = await import(pathToFileURL(join(vp, "scripts/ledger.mjs")).href);
  mkdirSync(out, { recursive: true });
  for (const [name, paths] of Object.entries(RECORDED)) {
    const dir = join(out, `.work-${name}`);
    const report = assemble(rawFor(dir, paths, [{ kind: "legal", paths: ["legal/*.html"], text_only: true, reason: "privacy and terms" }], ledgerItems), dir);
    writeFileSync(join(out, `main-${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  }
}
