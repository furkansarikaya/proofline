#!/usr/bin/env node
// ui-design deal: draws three design directions (plus one calm standard option) from the bundled library for a brief.
// Usage: node deal.mjs --brief <brief.json> [--seed N] [--redraw <slot> --reason "<text>"]...
//   brief: {mode: persuade|experience|read|operate, sector, tone?, imagery: [project-photos|product-photo|real-ui|
//           illustration|video|none], sections: [roles in the argument's order], brand?: {palette?, font?},
//           subject_colours?, kind? (operate only)}
//   slot : 1..3 (a whole direction) or <1..3>.<part>, part = hero | type | palette | motion | section:<role>[#n]
//          (operate: shell | pattern:<role>). A redraw changes exactly that slot and needs a reason that starts with
//          brand-constraint: | missing-imagery: | content-misfit: followed by the specifics. Reasons about comfort or
//          taste are rejected. Redraws are recorded in the output.
// Same brief + seed + redraws => same output. No model, no network, no dependencies. Without --seed one is generated.
// Exit: 0 ok, 2 usage/read/brief error, 3 no direction can satisfy the brief (the JSON says why; nothing is relaxed).
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const MODES = ["persuade", "experience", "read", "operate"];
export const IMAGERY = ["project-photos", "product-photo", "real-ui", "illustration", "video", "none"];
export const REDRAW_PREFIXES = ["brand-constraint", "missing-imagery", "content-misfit"];
// Reasons that are about comfort or taste, never about the brief.
const COMFORT = /\b(comfort\w*|familiar|prefer\w*|boring|bored|nicer|safer|safe|dislike\w*|don'?t like|do not like|gut|vibes?|whim\w*|just because|feels? (better|right|off)|more fun|meh)\b/i;
// What a template stands on, read from its own blueprint: sentences that mention photographs (and do not negate them)
// mean it needs photographs; mentions of the product's own interface mean it needs real UI.
const NEG_MEDIA = /\b(no|without|never|not a|instead of|rather than|zero)\s+(\w+\s+){0,2}(photograph|photo|picture|image|video|footage)/i;
const POS_MEDIA = /photograph|\bphotos?\b|\bpictures?\b|footage|\bvideo|\bimages?\b|\bplates?\b|\bportrait/i;
const UI_DEP = /\b(product|app|real|live|working|actual)('s)?\s+(own\s+)?(ui|interface|screen|fragment|control|component|dashboard|demo)|\bfragment of (the |a )?(product|app|interface|real)|\b(interface|ui|app)\s+(fragment|screen|control)/i;
const depCache = new WeakMap();
function deps(t) {
  if (!depCache.has(t)) {
    const text = String(t.blueprint || "");
    const photo = text.split(/(?<=[.;])\s+/).some((x) => POS_MEDIA.test(x) && !NEG_MEDIA.test(x));
    depCache.set(t, { photo, ui: UI_DEP.test(text) || (t.tags || []).includes("ui-led") });
  }
  return depCache.get(t);
}
const READ_ARCHETYPES = new Set(["quiet-column", "bottom-anchored-type", "type-poster", "split", "index"]);
const CALM_ARCHETYPES = new Set(["quiet-column", "split", "type-poster", "bottom-anchored-type"]);
const CALM_CLASSES = new Set(["grotesk-light", "geometric", "serif-text", "grotesk-tight"]);
const CALM_SHAPES = new Set(["stack", "list", "split", "grid", "table", "statement"]);
const READ_TONES = new Set(["quiet", "editorial", "technical"]);
const SECTOR_ALIASES = { "dev-tools": "dev-tool", developer: "dev-tool", devtool: "dev-tool", "qr-menu": "restaurant", cafe: "restaurant", food: "restaurant", hotel: "hospitality", travel: "hospitality", tourism: "culture", museum: "culture", shop: "ecommerce", store: "ecommerce", fintech: "finance", bank: "finance", software: "saas", ai: "ai-product", app: "consumer-app", realestate: "real-estate", charity: "nonprofit", school: "education", medical: "health", portfolio: "personal-portfolio" };
// Operate surfaces: which app kinds a sector's back office or tool usually is (first = closest).
const SECTOR_KINDS = { restaurant: ["commerce", "smb-admin"], hospitality: ["smb-admin", "commerce"], ecommerce: ["commerce"], saas: ["analytics", "smb-admin", "devtools"], "dev-tool": ["devtools"], "ai-product": ["devtools", "analytics"], finance: ["finance", "analytics"], health: ["smb-admin", "workspace"], education: ["workspace", "community"], nonprofit: ["community", "smb-admin"], culture: ["community", "workspace"], event: ["community"], music: ["creator", "community"], "consumer-app": ["wallet", "workspace"], "physical-product": ["commerce"], agency: ["workspace", "builder"], "real-estate": ["smb-admin", "commerce"], fashion: ["commerce"], architecture: ["workspace"], "studio-portfolio": ["creator"], "personal-portfolio": ["creator"], other: ["smb-admin", "workspace"] };

// ---------- seeded randomness ----------
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str) { // FNV-1a, 32 bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
// One independent stream per (seed, key): changing one slot never moves another.
const stream = (seed, ...key) => prng(hash([seed, ...key].join("|")));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function shuffled(list, rnd) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const pick = (list, rnd) => list[Math.floor(rnd() * list.length)];

// ---------- colour helpers ----------
const HEX = /^#?([0-9a-f]{6})$/i;
const normHex = (h) => { const m = HEX.exec(String(h).trim()); return m ? `#${m[1].toLowerCase()}` : null; };
function hsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const inkFor = (hex) => (hsl(hex).l > 0.55 ? "#111111" : "#ffffff");
const chromatic = (hex) => hsl(hex).s > 0.25 && hsl(hex).l > 0.08 && hsl(hex).l < 0.95;
function colourList(v) {
  if (v === undefined || v === null) return [];
  const raw = Array.isArray(v) ? v : isObj(v) ? Object.values(v) : [v];
  return raw.map(normHex).filter(Boolean);
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";

// ---------- library ----------
export function loadLibrary(dir = join(here, "..", "library")) {
  const rd = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  return {
    directions: rd("directions.json").sort(byId), heroes: rd("heroes.json").sort(byId), sections: rd("sections.json").sort(byId),
    type: rd("type.json").sort(byId), palettes: rd("palettes.json").sort(byId), motions: rd("motions.json").sort(byId),
    app: rd("app.json"), photos: rd("photos.json"), licences: rd("google-font-licenses.json"),
    fonts: rd("adapt/fonts.json"), photoMap: rd("adapt/photos.json"),
  };
}

// ---------- brief ----------
export function checkBrief(b) {
  const e = [];
  if (!isObj(b)) return ["brief must be an object"];
  if (!MODES.includes(b.mode)) e.push(`mode must be one of ${MODES.join("|")}`);
  if (!isStr(b.sector)) e.push("sector must be a non-empty string");
  if ("tone" in b && !isStr(b.tone)) e.push("tone must be a non-empty string when present");
  if (!Array.isArray(b.imagery) || b.imagery.length === 0 || !b.imagery.every((x) => IMAGERY.includes(x))) e.push(`imagery must be a non-empty array of ${IMAGERY.join("|")} (use ["none"] when nothing exists)`);
  else if (b.imagery.includes("none") && b.imagery.length > 1) e.push('imagery "none" cannot be combined with other values');
  if (!Array.isArray(b.sections) || !b.sections.every(isStr)) e.push("sections must be an array of section roles (screen kinds for operate)");
  if ("brand" in b) {
    if (!isObj(b.brand)) e.push("brand must be an object {palette?, font?}");
    else {
      for (const k of Object.keys(b.brand)) if (!["palette", "font"].includes(k)) e.push(`brand.${k} is not a brand constant (palette, font)`);
      if ("font" in b.brand && !isStr(b.brand.font)) e.push("brand.font must be a font family name");
      if ("palette" in b.brand && colourList(b.brand.palette).length < 2) e.push("brand.palette needs at least two #rrggbb colours");
    }
  }
  if ("subject_colours" in b && colourList(b.subject_colours).length === 0) e.push("subject_colours needs at least one #rrggbb colour");
  for (const k of Object.keys(b)) if (!["mode", "sector", "tone", "imagery", "sections", "brand", "subject_colours", "kind"].includes(k)) e.push(`unknown brief field "${k}"`);
  return e;
}

export function checkRedrawReason(reason) {
  if (!isStr(reason)) return "a redraw needs a written reason";
  const m = new RegExp(`^(${REDRAW_PREFIXES.join("|")}):\\s*(.+)$`, "s").exec(reason.trim());
  if (!m) return `the reason must start with ${REDRAW_PREFIXES.map((p) => `${p}:`).join(" | ")} followed by the specifics`;
  if (m[2].trim().length < 8) return "state the specifics after the prefix (what exactly conflicts, is missing, or does not fit)";
  if (COMFORT.test(reason)) return "a redraw is never for comfort or taste: name the brief's constraint, the missing imagery or the content that does not fit";
  return null;
}

function parseSlot(slot) {
  const m = /^([1-3])(?:\.(hero|type|palette|motion|shell|section:[\w-]+(?:#\d+)?|pattern:[\w-]+(?:#\d+)?))?$/.exec(String(slot));
  return m ? { slot: Number(m[1]), part: m[2] || null } : null;
}

// ---------- context ----------
function context(brief, seed, lib) {
  const notes = [];
  let sector = brief.sector.trim().toLowerCase();
  sector = SECTOR_ALIASES[sector] || sector;
  const known = new Set(lib.directions.flatMap((d) => d.sectors));
  if (!known.has(sector)) { notes.push(`sector "${brief.sector}" is not in the library's vocabulary; dealt as "other"`); sector = "other"; }
  const im = new Set(brief.imagery);
  return {
    brief, seed, lib, notes, sector, mode: brief.mode,
    ownPhotos: im.has("project-photos") || im.has("product-photo") || im.has("video"),
    provided: new Set([...(im.has("product-photo") ? ["product-photo"] : []), ...(im.has("real-ui") ? ["product-ui"] : [])]),
    realUi: im.has("real-ui"),
    tone: brief.tone ? brief.tone.trim().toLowerCase() : null,
  };
}
const needsOk = (ctx, needs) => (needs || []).every((n) => ctx.provided.has(n));
const photoLed = (d) => d.sectionTags.includes("photo-led");

// ---------- persuade / experience / read ----------
function eligibleDirections(ctx) {
  const { lib } = ctx;
  const withSector = lib.directions.filter((d) => d.sectors.includes(ctx.sector));
  const withNeeds = withSector.filter((d) => needsOk(ctx, d.needs));
  const withHero = withNeeds.filter((d) => heroPool(d, ctx, {}).length > 0);
  return { withSector, withNeeds, withHero };
}
function directionTier(d, ctx) {
  const toneWanted = ctx.tone ? [ctx.tone] : ctx.mode === "read" ? [...READ_TONES] : null;
  const toneMiss = toneWanted && !d.tones.some((t) => toneWanted.includes(t)) ? 1 : 0;
  const photoMiss = !ctx.ownPhotos && photoLed(d) ? 1 : 0;
  return toneMiss * 2 + photoMiss;
}

function standardDirection(pool, ctx) {
  const score = (d) => (d.tones.includes("quiet") ? 0 : d.tones.includes("editorial") ? 2 : 4) + (d.sectionTags.includes("quiet") ? 0 : 1) + (!ctx.ownPhotos && photoLed(d) ? 8 : 0) + (d.typeClasses.some((c) => CALM_CLASSES.has(c)) ? 0 : 2) + (d.paletteTags.includes("light-neutral") ? 0 : 5) + (d.tones.includes("luxury") || d.tones.includes("bold") ? 1 : 0);
  return [...pool].sort((a, b) => score(a) - score(b) || byId(a, b))[0];
}

function heroPool(d, ctx, opt) {
  let list = ctx.lib.heroes.filter((h) => h.directions.includes(d.id) && needsOk(ctx, h.needs));
  // without photographs of their own the brief cannot carry a hero that stands on photographs
  if (!ctx.ownPhotos || opt.ignorePhoto) list = list.filter((h) => !deps(h).photo);
  if (!ctx.realUi) list = list.filter((h) => !deps(h).ui);
  const pref = opt.calm ? CALM_ARCHETYPES : ctx.mode === "read" ? READ_ARCHETYPES : null;
  if (pref) { const p = list.filter((h) => pref.has(h.archetype)); if (p.length) list = p; }
  return list;
}

// Ordered type systems: licence verified in the directory first, systems that need a package licence last (flagged).
// A system with an unverifiable licence is never dealt; the same class stands in, then the nearest verifiable class.
function typePool(d, ctx, opt) {
  const { lib } = ctx;
  let classes = d.typeClasses;
  if (opt.calm || ctx.mode === "read") { const c = classes.filter((x) => CALM_CLASSES.has(x)); if (c.length) classes = c; }
  const v = (t) => lib.fonts.systems[t.id]?.verdict;
  const of = (cls, verdict) => lib.type.filter((t) => cls.includes(t.class) && v(t) === verdict);
  const list = [...of(classes, "directory-verified"), ...of(classes, "needs-package-licence")];
  return list.length ? list : of(d.typeClasses, "directory-verified").concat(of(d.typeClasses, "needs-package-licence"));
}
// The draw is made inside the best licence tier only.
function tierPick(list, rnd, ctx) {
  if (!list.length) return null;
  const v = (t) => ctx.lib.fonts.systems[t.id].verdict;
  return pick(list.filter((t) => v(t) === v(list[0])), rnd);
}
function typeOut(t, ctx) {
  const f = ctx.lib.fonts.systems[t.id];
  const face = (x) => ({ family: x.family, weights: x.weights, italic: x.italic, settings: x.settings });
  const out = { id: t.id, name: t.name, class: t.class, display: face(t.display), text: face(t.text), scale: t.scale, note: t.note, licence: { status: f.verdict, faces: f.faces.map((x) => ({ role: x.role, family: x.family, verdict: x.verdict, ...(x.license ? { license: x.license } : {}) })) }, loading: "self-host the font files in the project; read the licence from the package or the licence directory; write it to the ledger (## Fonts)" };
  if (f.verdict === "needs-package-licence") out.flag = "needs-package-licence: read the licence file of the package you self-host before use; if it is not open, deal again";
  const brand = ctx.brief.brand?.font;
  if (brand) { out.brand_font = brand; out.note = `brand constant: set the display and text faces in "${brand}" (its licence goes to the ledger); the library system supplies scale, weights and settings only. ${t.note || ""}`.trim(); }
  return out;
}

function palettePool(d, ctx, opt) {
  const base = ctx.lib.palettes;
  let list = base.map((p) => ({ p, k: p.tags.filter((t) => d.paletteTags.includes(t)).length })).filter((x) => x.k > 0);
  const bc = colourList(ctx.brief.brand?.palette);
  if (bc.length) { // keep the polarity of the brand's ground
    const dark = Math.min(...bc.map((c) => hsl(c).l)) < 0.2 && hsl(bc[0]).l < 0.5;
    const pol = list.filter((x) => x.p.tags.includes("dark-neutral") === dark);
    if (pol.length) list = pol;
  }
  const mx = Math.max(0, ...list.map((x) => x.k));
  list = list.filter((x) => x.k >= Math.max(1, mx - 1)).map((x) => x.p);
  if (opt.calm) { const c = list.filter((p) => p.tags.includes("light-neutral")); list = c.length ? c : base.filter((p) => p.tags.includes("light-neutral")); }
  else if (ctx.mode === "read") { const c = list.filter((p) => p.tags.includes("light-neutral")); if (c.length) list = c; }
  return list;
}
function paletteOut(p, ctx) {
  const brief = ctx.brief;
  const note = [];
  const out = { id: p.id, name: p.name, tags: p.tags, bg: p.bg, surface: p.surface, ink: p.ink, muted: p.muted, accent: p.accent, accentInk: p.accentInk, fields: p.fields, how: p.note };
  const brandC = colourList(brief.brand?.palette);
  if (brandC.length) {
    const sorted = [...brandC].sort((a, b) => hsl(b).l - hsl(a).l);
    const bg = sorted[0], ink = sorted[sorted.length - 1];
    const accent = [...brandC].filter((c) => c !== bg && c !== ink).sort((a, b) => hsl(b).s - hsl(a).s)[0] || ink;
    Object.assign(out, { bg, ink, accent, accentInk: inkFor(accent), surface: brandC.find((c) => c !== bg && c !== ink && !chromatic(c)) || out.surface, fields: (p.fields || []).map(() => ({ bg: ink, ink: bg })) });
    out.source = "brand";
    note.push(`brand palette kept as given (ground ${bg}, ink ${ink}, accent ${accent}); the ratios of library palette "${p.id}" (how much ground, surface, field and accent) are the only thing taken from the library`);
    if (colourList(brief.subject_colours).length) note.push("subject colours were not applied: brand constants take precedence");
  } else {
    const subj = colourList(brief.subject_colours).filter(chromatic);
    if (subj.length) {
      const acc = hsl(p.accent);
      const conflict = chromatic(p.accent) && !subj.some((c) => hueGap(hsl(c).h, acc.h) <= 40);
      if (conflict) {
        const main = [...subj].sort((a, b) => hsl(b).s - hsl(a).s)[0];
        out.accent = main; out.accentInk = inkFor(main);
        let i = 0;
        out.fields = (p.fields || []).map((f) => (chromatic(f.bg) ? ((c) => ({ bg: c, ink: inkFor(c) }))(subj[i++ % subj.length]) : f));
        out.source = "subject-adapted";
        note.push(`library accent ${p.accent} conflicts with the subject's own colours (${subj.join(", ")}); ratios of "${p.id}" kept, accent and coloured fields taken from the subject (accent ${main})`);
      }
    }
  }
  if (!out.source) out.source = "library";
  if (note.length) out.note = note.join("; ");
  return out;
}

function motionPool(d, ctx, hero) {
  const own = [...new Set([hero?.motion, d.motion, ...ctx.lib.heroes.filter((h) => h.directions.includes(d.id)).map((h) => h.motion)].filter(Boolean))];
  const rest = ctx.lib.motions.map((m) => m.id).filter((id) => !own.includes(id));
  return [...own, ...rest];
}
function motionOut(id, ctx) {
  const m = ctx.lib.motions.find((x) => x.id === id);
  return { id, name: m?.name || id, description: m?.description || "" };
}

function sectionPool(role, d, ctx, opt) {
  const all = ctx.lib.sections.filter((s) => s.role === role && needsOk(ctx, s.needs));
  const tiers = [
    { list: all.filter((s) => s.directions.includes(d.id)), adapted: false },
    { list: all.filter((s) => !s.directions.includes(d.id) && s.tags.some((t) => d.sectionTags.includes(t))), adapted: true },
    { list: all.filter((s) => !s.directions.includes(d.id)), adapted: true },
  ];
  // photograph slots of a section can hold crops of the real interface when the brief has real UI
  const noPhoto = (!ctx.ownPhotos && !ctx.realUi) || opt.ignorePhoto;
  const fits = (s) => !(noPhoto && (s.tags.includes("photo-led") || deps(s).photo)) && !(!ctx.realUi && deps(s).ui);
  // a template that stands on imagery that does not exist is replaced by another template of the same role
  for (const t of tiers) {
    let list = t.list.filter(fits);
    if (!list.length) continue;
    if (opt.calm || ctx.mode === "read") { const c = list.filter((s) => CALM_SHAPES.has(s.shape)); if (c.length) list = c; }
    return { list, adapted: t.adapted };
  }
  const t = tiers.find((x) => x.list.length);
  return t ? { list: t.list, adapted: t.adapted } : { list: [], adapted: false };
}
function sectionOut(role, s, adapted, changed) {
  return { role, id: s.id, name: s.name, shape: s.shape, tags: s.tags, blueprint: s.blueprint, mobile: s.mobile, ...(adapted ? { adapted: "no template of this role is written for the direction; chosen by matching tags" } : {}), ...(changed ? { template_changed: changed } : {}) };
}
function roleKeys(roles) { // role, role#2, ... so repeated roles are addressable
  const n = {};
  return roles.map((r) => { n[r] = (n[r] || 0) + 1; return n[r] === 1 ? r : `${r}#${n[r]}`; });
}

// Builds every part of one direction baseline. `rk` namespaces the streams (the slot key stays stable under redraws).
function buildDirection(d, ctx, opt = {}) {
  const tag = opt.calm ? "standard" : d.id;
  const hp = heroPool(d, ctx, opt);
  const hero = pick(hp, stream(ctx.seed, "hero", tag));
  const t = tierPick(typePool(d, ctx, opt), stream(ctx.seed, "type", tag), ctx);
  const pp = palettePool(d, ctx, opt);
  const pal = pick(pp, stream(ctx.seed, "palette", tag));
  const mp = motionPool(d, ctx, hero);
  const mot = (opt.calm || ctx.mode === "read") && mp.includes("stillness") ? "stillness" : mp[0];
  const keys = roleKeys(ctx.brief.sections);
  const sections = [];
  let prev = null;
  ctx.brief.sections.forEach((role, i) => {
    const { list, adapted } = sectionPool(role, d, ctx, opt);
    if (!list.length) { sections.push({ key: keys[i], role, unavailable: `no library template for role "${role}" fits this imagery` }); return; }
    const varied = list.filter((s) => s.shape !== prev);
    const s = pick(varied.length ? varied : list, stream(ctx.seed, "section", tag, keys[i]));
    prev = s.shape;
    sections.push({ key: keys[i], ...sectionOut(role, s, adapted), ...(!ctx.ownPhotos && ctx.realUi && deps(s).photo ? { media_note: "the template names photographs: its media slots take crops of the real interface" } : {}), ...(!ctx.ownPhotos && !ctx.realUi && deps(s).photo ? { photo_dependent: "every template of this role stands on photographs the brief does not provide: fill its photo slots from the library set named in library_photos, or redraw with missing-imagery" } : {}) });
  });
  return { d, hero, typeSys: t, pal, mot, sections, tag, opt };
}

function directionView(b, ctx) {
  const { d } = b;
  const hero = b.hero;
  const entry = {
    direction: { id: d.id, name: d.name, idea: d.idea, composition: d.composition, imagery: d.imagery, richness: d.richness, pitfalls: d.pitfalls, tones: d.tones },
    hero: { id: hero.id, name: hero.name, archetype: hero.archetype, blueprint: hero.blueprint, mobile: hero.mobile, headline: hero.headline, ...(b.heroNote ? { note: b.heroNote } : {}) },
    sections: b.sections,
    type: b.typeSys ? typeOut(b.typeSys, ctx) : { unavailable: "no type system with a verifiable licence fits this direction's voice" },
    palette: paletteOut(b.pal, ctx),
    motion: motionOut(b.mot, ctx),
  };
  const photoNeeded = !ctx.ownPhotos && (photoLed(d) || deps(hero).photo || b.sections.some((x) => x.photo_dependent));
  if (photoNeeded) {
    const sets = Object.entries(ctx.lib.photos.sets).filter(([id, x]) => x.sectors.includes(ctx.sector) && ctx.lib.photoMap.sets[id]?.usable).sort((x, y) => (y[1].primary?.includes(ctx.sector) ? 1 : 0) - (x[1].primary?.includes(ctx.sector) ? 1 : 0)).slice(0, 4).map(([id, x]) => ({ set: id, title: x.title, note: x.note }));
    const rule = "source library: self-host the files, verify each address, credit on the page and in the ledger; never counted as the project's own imagery; pick the set whose subject matches the product";
    entry.library_photos = sets.length ? { sets, rule } : { sets: [], rule: "this composition leans on photographs the brief does not provide and no library set fits the sector: supply imagery or redraw with missing-imagery" };
  }
  if (b.opt.calm) entry.standard = true;
  entry.ids = idsOf(entry);
  return entry;
}
const idsOf = (e) => {
  if (e.style) return { style: e.style.id, shell: e.shell.id, patterns: Object.fromEntries(e.patterns.map((p) => [p.key, p.id || null])) };
  return { direction: e.direction.id, hero: e.hero.id, type: e.type.id || null, palette: e.palette.id, motion: e.motion.id, sections: Object.fromEntries(e.sections.map((s, i) => [s.key || `${s.role}@${i}`, s.id || null])) };
};

function dealCreative(ctx, redraws) {
  const { lib } = ctx;
  const { withSector, withNeeds, withHero } = eligibleDirections(ctx);
  const notes = ctx.notes;
  if (!withHero.length) {
    const why = !withSector.length ? `no library direction lists the sector "${ctx.sector}"`
      : !withNeeds.length ? `${withSector.length} direction(s) fit sector "${ctx.sector}" but every one needs imagery the brief does not provide (${[...new Set(withSector.flatMap((d) => d.needs))].join(", ") || "none"})`
      : `${withNeeds.length} direction(s) fit sector "${ctx.sector}" and the imagery, but none has a hero that does not depend on photographs the brief does not provide`;
    return { status: "unsatisfiable", reason: why };
  }
  // order: best tier first, seeded shuffle inside a tier
  const rnd = prng(hash(`${ctx.seed}|directions`));
  const order = shuffled(withHero, rnd).sort((a, b) => directionTier(a, ctx) - directionTier(b, ctx));
  const chosen = [];
  const usedMotion = new Set();
  for (const d of order) { if (chosen.length === 3) break; if (!usedMotion.has(d.motion)) { chosen.push(d); usedMotion.add(d.motion); } }
  for (const d of order) { if (chosen.length === 3) break; if (!chosen.includes(d)) chosen.push(d); }
  // the calm standard comes from a direction that is not dealt (the user's door stays a different door)
  const free = withHero.filter((d) => !chosen.includes(d));
  const std = standardDirection(free.length ? free : withHero, ctx);
  if (!free.length) notes.push("every direction that satisfies the brief is dealt; the standard option shares its direction with a dealt one");
  if (chosen.length < 3) notes.push(`only ${chosen.length} direction(s) satisfy sector, imagery and hero constraints; fewer than three dealt, nothing relaxed`);
  const tone = ctx.tone;
  if (tone && chosen.some((d) => !d.tones.includes(tone))) notes.push(`tone "${tone}": fewer than three satisfying directions have it; the rest are the nearest remaining ones`);
  let slots = chosen.map((d) => buildDirection(d, ctx));
  const rejected = new Set();
  const log = [];
  redraws.forEach((r, n) => {
    const sp = parseSlot(r.slot);
    if (!sp) throw new Error(`bad slot "${r.slot}": use 1-3 or <1-3>.<hero|type|palette|motion|section:<role>>`);
    if (sp.slot > slots.length) throw new Error(`slot ${sp.slot} was not dealt`);
    const why = checkRedrawReason(r.reason);
    if (why) throw new Error(`redraw ${r.slot}: ${why}`);
    const cur = slots[sp.slot - 1];
    const rr = stream(ctx.seed, "redraw", n, r.slot);
    const missingImg = r.reason.startsWith("missing-imagery");
    if (!sp.part) {
      rejected.add(cur.d.id);
      const rest = order.filter((d) => !slots.some((s) => s.d.id === d.id) && !rejected.has(d.id) && d.id !== std.id);
      if (!rest.length) throw new Error(`redraw ${r.slot}: no other direction satisfies the brief`);
      const tier = Math.min(...rest.map((d) => directionTier(d, ctx)));
      const nd = pick(shuffled(rest.filter((d) => directionTier(d, ctx) === tier), rr), () => 0);
      slots[sp.slot - 1] = buildDirection(nd, ctx);
      log.push({ slot: r.slot, reason: r.reason, from: cur.d.id, to: nd.id });
      return;
    }
    const d = cur.d;
    if (sp.part === "hero") {
      const alt = heroPool(d, ctx, { ignorePhoto: missingImg }).filter((h) => h.id !== cur.hero.id);
      if (!alt.length) throw new Error(`redraw ${r.slot}: no other hero fits this direction and the imagery`);
      const nh = pick(alt, rr), from = cur.hero.id; cur.hero = nh;
      log.push({ slot: r.slot, reason: r.reason, from, to: nh.id });
    } else if (sp.part === "type") {
      const tp = typePool(d, ctx, {}).filter((t) => t.id !== cur.typeSys?.id);
      if (!tp.length) throw new Error(`redraw ${r.slot}: no other type system with a verifiable licence`);
      const nt = tierPick(tp, rr, ctx), from = cur.typeSys?.id || null; cur.typeSys = nt;
      log.push({ slot: r.slot, reason: r.reason, from, to: nt.id });
    } else if (sp.part === "palette") {
      const pp = palettePool(d, ctx, {}).filter((p) => p.id !== cur.pal.id);
      const pp2 = pp.length ? pp : ctx.lib.palettes.filter((p) => p.id !== cur.pal.id && p.tags.some((t) => d.paletteTags.includes(t)));
      if (!pp2.length) throw new Error(`redraw ${r.slot}: no other palette fits this direction`);
      const np = pick(pp2, rr), from = cur.pal.id; cur.pal = np;
      log.push({ slot: r.slot, reason: r.reason, from, to: np.id });
    } else if (sp.part === "motion") {
      const mp = motionPool(d, ctx, cur.hero).filter((m) => m !== cur.mot);
      if (!mp.length) throw new Error(`redraw ${r.slot}: no other motion`);
      const nm = pick(mp, rr), from = cur.mot; cur.mot = nm;
      log.push({ slot: r.slot, reason: r.reason, from, to: nm });
    } else if (sp.part.startsWith("section:")) {
      const key = sp.part.slice(8);
      const idx = cur.sections.findIndex((s) => s.key === key);
      if (idx < 0) throw new Error(`redraw ${r.slot}: the brief has no section "${key}" (roles: ${cur.sections.map((s) => s.key).join(", ")})`);
      const role = cur.sections[idx].role;
      const { list, adapted } = sectionPool(role, d, ctx, { ignorePhoto: missingImg });
      const neighbours = [cur.sections[idx - 1]?.shape, cur.sections[idx + 1]?.shape];
      const alt = list.filter((s) => s.id !== cur.sections[idx].id);
      const varied = alt.filter((s) => !neighbours.includes(s.shape));
      if (!alt.length) throw new Error(`redraw ${r.slot}: no other template of role "${role}" fits (the template is changed, never bent)`);
      const ns = pick(varied.length ? varied : alt, rr);
      const from = cur.sections[idx].id;
      cur.sections[idx] = { key, ...sectionOut(role, ns, adapted, `replaced ${from}: ${r.reason}`) };
      log.push({ slot: r.slot, reason: r.reason, from, to: ns.id });
    } else throw new Error(`redraw ${r.slot}: "${sp.part}" is not a part of a creative direction`);
  });
  const stdB = buildDirection(std, ctx, { calm: true });
  return { status: "ok", dealt: slots.map((b) => directionView(b, ctx)), standard: directionView(stdB, ctx), redraws: log };
}

// ---------- operate ----------
function fontVerdict(family, lib) {
  const first = String(family).split(",")[0].trim().toLowerCase();
  const hit = lib.licences.families.find((f) => f.name.toLowerCase() === first);
  const excluded = (lib.licences.excludedFamilies || []).some((f) => f.name.toLowerCase() === first);
  if (excluded) return { status: "unverifiable", reason: "family is excluded from the licence directory" };
  if (!hit) return { status: "needs-package-licence", reason: "family is not in the licence directory" };
  return ["OFL", "APACHE2", "UFL"].includes(hit.license) ? { status: "directory-verified", license: hit.license } : { status: "unverifiable", reason: `licence ${hit.license} is not open` };
}

function opKinds(ctx) {
  const { app } = ctx.lib;
  const explicit = ctx.brief.kind && app.kinds[ctx.brief.kind] ? [ctx.brief.kind] : null;
  const fromSector = app.kinds[ctx.sector] ? [ctx.sector] : (SECTOR_KINDS[ctx.sector] || SECTOR_KINDS.other);
  return explicit || fromSector.filter((k) => app.kinds[k]);
}

function dealOperate(ctx, redraws) {
  const { lib } = ctx;
  const kinds = opKinds(ctx);
  const ordered = [];
  for (const k of kinds) for (const sid of lib.app.kinds[k].styles) if (!ordered.find((x) => x.id === sid)) ordered.push({ id: sid, kind: k, rank: kinds.indexOf(k) });
  for (const st of lib.app.styles) if (!ordered.find((x) => x.id === st.id) && (st.suits || []).some((k) => kinds.includes(k))) ordered.push({ id: st.id, kind: "suits", rank: kinds.length });
  const styleOf = (id) => lib.app.styles.find((s) => s.id === id);
  const fontOk = (s) => fontVerdict(s.tokens.font.family, lib).status !== "unverifiable";
  const pool = ordered.map((x) => ({ ...x, s: styleOf(x.id) })).filter((x) => x.s && (ctx.brief.brand?.font || fontOk(x.s)));
  if (!pool.length) return { status: "unsatisfiable", reason: `no library app style is listed for ${kinds.join("/")} with a verifiable font` };
  const calmId = pool.find((x) => x.id === "achromatic-ledger") ? "achromatic-ledger" : [...pool].sort((a, b) => (a.id < b.id ? -1 : 1))[0].id;
  // the calm standard takes a style of its own only when the library has enough fitting styles to spare
  let rest = pool.length >= 4 ? pool.filter((x) => x.id !== calmId) : [...pool];
  if (pool.length < 4 && pool.length >= 1) ctx.notes.push("few app styles fit this sector; the calm standard option shares its style with a dealt one");
  if (rest.length < 3) { // widen to styles of adjacent kinds, and say so
    const extra = [];
    for (const k of ["workspace", "community", "creator", "analytics"]) for (const sid of lib.app.kinds[k]?.styles || []) if (!pool.find((x) => x.id === sid) && !extra.find((x) => x.id === sid)) extra.push({ id: sid, kind: k, rank: kinds.length + 1, s: styleOf(sid), adjacent: true });
    const ok = extra.filter((x) => x.s && (ctx.brief.brand?.font || fontOk(x.s)));
    if (ok.length) { rest = [...rest, ...ok.slice(0, 3 - rest.length + 2)]; ctx.notes.push(`fewer than three app styles are written for ${kinds.join("/")}; the remainder suit adjacent kinds (${[...new Set(ok.map((x) => x.kind))].join(", ")})`); }
  }
  const order = shuffled([...rest].sort((a, b) => (a.id < b.id ? -1 : 1)), prng(hash(`${ctx.seed}|styles`))).sort((a, b) => a.rank - b.rank);
  rest.forEach((x) => { if (!pool.includes(x)) pool.push(x); });
  let chosen = order.slice(0, 3);
  if (chosen.length < 3) ctx.notes.push(`only ${chosen.length} app style(s) suit ${kinds.join("/")}; fewer than three dealt, nothing relaxed`);
  const view = (x, tag, slotKey, calm) => {
    const s = x.s;
    const shellIds = [s.shell, ...(s.shellAlternatives || [])].filter((id) => lib.app.shells.some((sh) => sh.id === id));
    const fitting = shellIds.filter((id) => lib.app.shells.find((sh) => sh.id === id).suits.some((k) => kinds.includes(k)));
    let shellPool = fitting.length ? fitting : shellIds;
    // a screen the library has no pattern for (a map, a canvas) needs room: prefer the shells with the least chrome
    const bare = ctx.brief.sections.some((role) => !lib.app.patterns.some((p) => p.screen === role && (p.kinds || []).some((k) => kinds.includes(k))));
    if (bare) { const light = shellPool.filter((id) => id === "no-sidebar" || id === "icon-rail"); if (light.length) shellPool = light; }
    const shellId = calm ? s.shell : pick(shellPool, stream(ctx.seed, "shell", tag));
    return buildOperateView(x, shellId, ctx, kinds, calm);
  };
  let slots = chosen.map((x) => view(x, x.id));
  const log = [];
  const rejected = new Set();
  redraws.forEach((r, n) => {
    const sp = parseSlot(r.slot);
    if (!sp) throw new Error(`bad slot "${r.slot}": use 1-3, <1-3>.shell or <1-3>.pattern:<screen>`);
    if (sp.slot > slots.length) throw new Error(`slot ${sp.slot} was not dealt`);
    const why = checkRedrawReason(r.reason);
    if (why) throw new Error(`redraw ${r.slot}: ${why}`);
    const cur = slots[sp.slot - 1];
    const rr = stream(ctx.seed, "redraw", n, r.slot);
    if (!sp.part) {
      rejected.add(cur.style.id);
      const cand = order.filter((x) => !slots.some((s) => s.style.id === x.id) && !rejected.has(x.id));
      if (!cand.length) throw new Error(`redraw ${r.slot}: no other app style suits this brief`);
      const nx = pick(cand, rr);
      slots[sp.slot - 1] = view(nx, nx.id);
      log.push({ slot: r.slot, reason: r.reason, from: cur.style.id, to: nx.id });
    } else if (sp.part === "shell") {
      const alt = lib.app.shells.filter((sh) => sh.id !== cur.shell.id && sh.suits.some((k) => kinds.includes(k)));
      if (!alt.length) throw new Error(`redraw ${r.slot}: no other shell suits ${kinds.join("/")}`);
      const ns = pick(alt, rr);
      const x = pool.find((y) => y.id === cur.style.id);
      slots[sp.slot - 1] = { ...buildOperateView(x, ns.id, ctx, kinds, false), patterns: cur.patterns };
      slots[sp.slot - 1].ids = idsOf(slots[sp.slot - 1]);
      log.push({ slot: r.slot, reason: r.reason, from: cur.shell.id, to: ns.id });
    } else if (sp.part.startsWith("pattern:")) {
      const key = sp.part.slice(8);
      const idx = cur.patterns.findIndex((p) => p.key === key);
      if (idx < 0) throw new Error(`redraw ${r.slot}: the brief has no screen "${key}" (screens: ${cur.patterns.map((p) => p.key).join(", ")})`);
      const role = cur.patterns[idx].screen;
      const alt = lib.app.patterns.filter((p) => p.screen === role && p.id !== cur.patterns[idx].id && (p.kinds || []).some((k) => kinds.includes(k)));
      if (!alt.length) throw new Error(`redraw ${r.slot}: no other pattern for screen "${role}" (the template is changed, never bent)`);
      const np = pick(alt, rr);
      const from = cur.patterns[idx].id;
      cur.patterns[idx] = { key, screen: role, id: np.id, name: np.name, blueprint: np.blueprint, phone: np.phone, template_changed: `replaced ${from}: ${r.reason}` };
      cur.ids = idsOf(cur);
      log.push({ slot: r.slot, reason: r.reason, from, to: np.id });
    } else throw new Error(`redraw ${r.slot}: "${sp.part}" is not a part of an operate direction (shell, pattern:<screen>)`);
  });
  const calmX = pool.find((x) => x.id === calmId);
  return { status: "ok", dealt: slots, standard: { ...view(calmX, "standard", null, true), standard: true }, redraws: log };
}

function buildOperateView(x, shellId, ctx, kinds, calm) {
  const { lib } = ctx;
  const s = x.s;
  const shell = lib.app.shells.find((sh) => sh.id === shellId);
  const keys = roleKeys(ctx.brief.sections);
  const tag = calm ? "standard" : s.id;
  const patterns = ctx.brief.sections.map((role, i) => {
    const alt = lib.app.patterns.filter((p) => p.screen === role && (p.kinds || []).some((k) => kinds.includes(k))).sort(byId);
    if (!alt.length) return { key: keys[i], screen: role, id: null, unavailable: `no library pattern for a "${role}" screen of kind ${kinds.join("/")}: design it from the shell and tokens` };
    const p = pick(alt, stream(ctx.seed, "pattern", tag, keys[i]));
    return { key: keys[i], screen: role, id: p.id, name: p.name, blueprint: p.blueprint, phone: p.phone };
  });
  const notes = [];
  const tokens = JSON.parse(JSON.stringify(s.tokens));
  const brandC = colourList(ctx.brief.brand?.palette);
  if (brandC.length) {
    const sorted = [...brandC].sort((a, b) => hsl(b).l - hsl(a).l);
    const ink = sorted[sorted.length - 1];
    const accent = brandC.filter((c) => c !== sorted[0] && c !== ink).sort((a, b) => hsl(b).s - hsl(a).s)[0] || ink;
    Object.assign(tokens, { ground: sorted[0], text: ink, accent });
    notes.push("brand palette applied to ground, text and accent; the style's ratios, radii and density are kept");
  } else {
    const subj = colourList(ctx.brief.subject_colours).filter(chromatic);
    if (subj.length && chromatic(tokens.accent) && !subj.some((c) => hueGap(hsl(c).h, hsl(tokens.accent).h) <= 40)) {
      const main = [...subj].sort((a, b) => hsl(b).s - hsl(a).s)[0];
      notes.push(`style accent ${tokens.accent} conflicts with the subject's colours; ratios kept, accent taken from the subject (${main})`);
      tokens.accent = main;
    }
  }
  const brandFont = ctx.brief.brand?.font;
  const fv = brandFont ? { status: "brand-constant", reason: "licence read from the project's own font files; ledger ## Fonts" } : fontVerdict(tokens.font.family, lib);
  if (brandFont) { notes.push(`brand font "${brandFont}" replaces "${tokens.font.family}"; sizes and weights kept`); tokens.font.family = brandFont; }
  const view = {
    style: { id: s.id, name: s.name, theme: s.theme, idea: s.idea, colourBudget: s.colourBudget, signature: s.signature, avoid: s.avoid },
    shell: { id: shell.id, name: shell.name, numbers: shell.numbers, blueprint: shell.blueprint, phone: shell.phone },
    palette: { source: notes.some((n) => n.startsWith("brand palette")) ? "brand" : notes.some((n) => n.includes("conflicts")) ? "subject-adapted" : "library", tokens, ...(notes.length ? { note: notes.join("; ") } : {}) },
    type: { family: tokens.font.family, second: tokens.font.second, sizes: tokens.font.sizes, weights: tokens.font.weights, licence: fv, loading: "self-host; write the licence to the ledger (## Fonts)", ...(fv.status === "needs-package-licence" ? { flag: "needs-package-licence: read the licence file of the package you self-host before use" } : {}) },
    patterns,
    kinds,
  };
  view.ids = idsOf(view);
  return view;
}

// ---------- entry ----------
export function deal(brief, seed, redraws = [], library = loadLibrary()) {
  const bad = checkBrief(brief);
  if (bad.length) throw new Error(`brief: ${bad.join("; ")}`);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error("seed must be an integer from 0 to 4294967295");
  const ctx = context(brief, seed, library);
  const body = brief.mode === "operate" ? dealOperate(ctx, redraws) : dealCreative(ctx, redraws);
  return { schema: "ui-design.deal/1", seed, inputs: brief, ...body, ...(ctx.notes.length ? { notes: ctx.notes } : {}) };
}
// What ui.json records and the validator compares: ids only.
export function dealIds(result) {
  return { dealt: (result.dealt || []).map((e) => e.ids), standard: result.standard ? result.standard.ids : null };
}

const main = () => {
  const args = process.argv.slice(2);
  const usage = 'usage: deal.mjs --brief <brief.json> [--seed N] [--redraw <slot> --reason "<brand-constraint|missing-imagery|content-misfit>: <text>"]...';
  const fail = (m) => { console.error(m); console.error(usage); process.exit(2); };
  let file = null, seedArg = null;
  const redraws = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1];
    if (a === "--brief") { file = v; i++; }
    else if (a === "--seed") { seedArg = v; i++; }
    else if (a === "--redraw") { if (v === undefined) fail("--redraw needs a slot"); redraws.push({ slot: v, reason: null }); i++; }
    else if (a === "--reason") { const last = redraws[redraws.length - 1]; if (!last || last.reason !== null) fail("--reason must follow its --redraw"); last.reason = v ?? ""; i++; }
    else fail(`unknown argument ${a}`);
  }
  if (!file) fail("--brief <file> is required");
  for (const r of redraws) { const why = r.reason === null ? "a redraw needs --reason" : checkRedrawReason(r.reason); if (why) fail(`--redraw ${r.slot}: ${why}`); }
  const seed = seedArg === null ? randomInt(0, 4294967296) : Number(seedArg);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) fail("--seed must be an integer from 0 to 4294967295");
  let brief, lib;
  try { brief = JSON.parse(readFileSync(file, "utf8")); } catch (e) { fail(`cannot read brief: ${e.message}`); }
  try { lib = loadLibrary(); } catch (e) { fail(`cannot load the library: ${e.message}`); }
  let out;
  try { out = deal(brief, seed, redraws, lib); } catch (e) { fail(e.message); }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exitCode = out.status === "ok" ? 0 : 3; // no process.exit: a piped stdout must flush
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
