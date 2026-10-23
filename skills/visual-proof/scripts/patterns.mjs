// visual-proof pattern registry (0.0.27, A170). The ids and the date are shared with the ui-design pattern registry (a test checks that
// both id sets agree). A pattern is a default, not a ban: a finding is blocking unless DESIGN.md carries a written justification.
//
// Each registry entry: { detectable, detectors: [{ name, run(file) }], summary }. A detector is an honest heuristic over source text
// (regular expressions and CSS-declaration scanning; no parser, no dependency). `file` is { path, ext, text }; `run` returns
// [{ line, excerpt }] (1-based line, trimmed excerpt). Ids with `detectable: false` are judged from the screenshots only.

export const REGISTRY_DATE = "2026-10-23";

export const PATTERN_IDS = [
  "cream-serif-terracotta", "dark-single-neon-glow", "hairline-newspaper", "uniform-saas-cards", "eyebrow-label", "mono-labels",
  "numbered-steps", "middot-meta", "gradient-text", "decorative-glass", "side-stripe-card", "hard-offset-shadow", "emoji-icons",
  "sketch-svg", "grid-background",
];

export const SOURCE_EXTENSIONS = [".html", ".htm", ".css", ".scss", ".sass", ".less", ".jsx", ".tsx", ".vue", ".svelte", ".astro"];

// --- scanning helpers ------------------------------------------------------------------------------------------
// Comments become spaces (newlines kept), so line numbers stay true.
const blank = (m) => m.replace(/[^\n]/g, " ");
export const stripComments = (t) => String(t).replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank).replace(/^[ \t]*\/\/.*$/gm, blank);

const lineStarts = (text) => { const s = [0]; for (let i = 0; i < text.length; i++) if (text[i] === "\n") s.push(i + 1); return s; };
const lineAt = (starts, idx) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
const kebab = (k) => k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
const clipText = (s, n = 160) => { const t = String(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 3) + "..." : t; };

function decls(body, base, starts) {
  const out = [];
  const re = /([-\w]+)\s*:\s*([^;]+?)\s*(?:;|$)/g;
  for (let m; (m = re.exec(body));) out.push({ prop: m[1].toLowerCase(), value: m[2], line: lineAt(starts, base + m.index) });
  return out;
}

// Every `selector { declarations }` block (innermost braces), every inline style="..." and every JSX style={{...}} of a file.
export function cssBlocks(file) {
  if (file._blocks) return file._blocks;
  const text = stripComments(file.text), starts = lineStarts(text), blocks = [];
  const re = /([^{};]*)\{([^{}]*)\}/g;
  for (let m; (m = re.exec(text));) {
    const sel = m[1].trim();
    const body = m[2], base = m.index + m[0].indexOf("{") + 1;
    const d = decls(body, base, starts);
    if (d.length) blocks.push({ selector: sel.replace(/\s+/g, " "), decls: d, line: lineAt(starts, m.index + m[1].length - m[1].trimStart().length), text: body });
  }
  for (let m, r = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g; (m = r.exec(text));) {
    const body = m[1] ?? m[2];
    blocks.push({ selector: "[style]", decls: decls(body, m.index, starts), line: lineAt(starts, m.index), text: body });
  }
  for (let m, r = /\bstyle\s*=\s*\{\{([^}]*)\}\}/g; (m = r.exec(text));) {
    const css = m[1].split(/,\s*(?=[A-Za-z]+\s*:)/).map((kv) => kv.replace(/^\s*([A-Za-z]+)\s*:\s*["'`]?(.*?)["'`]?\s*$/s, (_, k, v) => `${kebab(k)}: ${v}`)).join(";");
    blocks.push({ selector: "[style]", decls: decls(css, m.index, starts), line: lineAt(starts, m.index), text: css });
  }
  return (file._blocks = blocks);
}

export function lines(file) { return file._lines || (file._lines = String(file.text).split(/\r?\n/)); }

// Every class="..." / className="..." attribute value with its line and the tag that carries it.
export function classAttrs(file) {
  if (file._classes) return file._classes;
  const out = [], text = stripComments(file.text), starts = lineStarts(text);
  const re = /<([A-Za-z][\w-]*)\b[^<>]*?\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g;
  for (let m; (m = re.exec(text));) out.push({ tag: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? "", line: lineAt(starts, m.index) });
  return (file._classes = out);
}

const srcLine = (file, n) => clipText(lines(file)[n - 1] || "");
const declExcerpt = (d) => clipText(`${d.prop}: ${d.value}`);
const hit = (file, line, excerpt) => ({ line, excerpt: excerpt ?? srcLine(file, line) });

// --- values ---------------------------------------------------------------------------------------------------
export function toPx(tok) {
  const m = /^(-?\d*\.?\d+)(px|rem|em|pt)?$/i.exec(String(tok).trim());
  if (!m) return null;
  const n = parseFloat(m[1]), u = (m[2] || "px").toLowerCase();
  return u === "px" ? n : u === "pt" ? n * 1.333 : n * 16;
}
export function parseColor(v) {
  const t = String(v).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[ ,]+([\d.]+)%[ ,]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (m) {
    const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100, a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h * 12) % 12; return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); };
    return [f(0), f(8), f(4), m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
  }
  return null;
}
const lightness = (c) => (Math.max(c[0], c[1], c[2]) + Math.min(c[0], c[1], c[2])) / 510;
const isCream = (c) => c && c[3] === 1 && lightness(c) >= 0.9 && c[0] >= c[1] && c[1] >= c[2] && c[0] - c[2] >= 8 && c[0] - c[2] <= 45 && c[0] >= 235;
const isTerracotta = (c) => c && c[3] === 1 && c[0] >= 160 && c[0] <= 235 && c[1] >= 40 && c[1] <= 130 && c[2] >= 0 && c[2] <= 110 && c[0] - c[1] >= 70 && c[1] > c[2];
const isDark = (c) => c && c[3] >= 0.9 && lightness(c) <= 0.12;
const isNeon = (c) => c && Math.max(c[0], c[1], c[2]) >= 150 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) >= 140;

const topLevelCommas = (v) => { const out = []; let depth = 0, cur = ""; for (const ch of String(v)) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && !depth) { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()).filter(Boolean); };
// One shadow layer -> { inset, x, y, blur, color } in px (null when it cannot be read).
export function parseShadow(layer) {
  const inset = /\binset\b/i.test(layer);
  const colors = [];
  const rest = layer.replace(/\binset\b/gi, " ").replace(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|var)\([^)]*(?:\([^)]*\)[^)]*)*\)|#[0-9a-f]{3,8}\b/gi, (m) => { colors.push(m); return " "; });
  const nums = rest.split(/\s+/).filter((t) => /^-?\d*\.?\d+[a-z]*$/i.test(t)).map(toPx);
  if (nums.length < 2 || nums.some((n) => n === null)) return null;
  return { inset, x: nums[0], y: nums[1], blur: nums[2] ?? 0, spread: nums[3] ?? 0, color: colors.length ? parseColor(colors[0]) : null, raw: colors[0] || "" };
}

const NON_CODE = /(^|[\s,>+~])(code|pre|kbd|samp|tt|var)\b|\.hljs|\.code\b|\.token|highlight|\.terminal|\.cm-|\.prism|:root|^html$|^\*$|@font-face|^\$/i;
const MONO = /\b(mono|monospace|courier|menlo|consolas|jetbrains|fira\s*code|space\s*mono|sf\s*mono|geist\s*mono|dm\s*mono)\b|--(?:font-)?mono|var\(--[\w-]*mono/i;
const GLOW_BLUR = 8;

// --- detectors ------------------------------------------------------------------------------------------------
const eyebrow = {
  name: "uppercase tracked small text, or an eyebrow/kicker/overline class",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) {
      if (/\b(button|btn|th|input|select|textarea)\b/i.test(b.selector)) continue;
      const g = (p) => b.decls.find((d) => d.prop === p);
      const up = g("text-transform"), ls = g("letter-spacing"), fs = g("font-size");
      if (!up || !/uppercase/i.test(up.value) || !ls) continue;
      const m = /^(-?[\d.]+)(em|px|rem)/.exec(ls.value.trim());
      if (!m) continue;
      const spaced = m[2] === "px" ? +m[1] >= 1 : +m[1] >= 0.06;
      const size = fs ? toPx(fs.value.trim()) : null;
      if (spaced && (size === null || size <= 14.5)) out.push(hit(file, ls.line, `${b.selector} { ${declExcerpt(up)}; ${declExcerpt(ls)}${fs ? "; " + declExcerpt(fs) : ""} }`));
    }
    lines(file).forEach((l, i) => { if (/\bclass(?:Name)?\s*=\s*["'{`][^"'`]*\b(eyebrow|kicker|overline|pre-?title|super-?title)\b/i.test(l)) out.push(hit(file, i + 1)); });
    for (const c of classAttrs(file)) {
      const k = c.value.split(/\s+/);
      if (k.includes("uppercase") && k.some((x) => /^tracking-(wide|wider|widest)$/.test(x)) && k.some((x) => /^text-(xs|sm)$/.test(x))) out.push(hit(file, c.line));
    }
    return out;
  },
};

const monoLabels = {
  name: "monospace face on non-code text",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) {
      if (NON_CODE.test(b.selector)) continue;
      const d = b.decls.find((x) => (x.prop === "font-family" || x.prop === "font") && MONO.test(x.value));
      if (d) out.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`));
    }
    for (const c of classAttrs(file)) if (!/^(code|pre|kbd|samp|tt|var)$/.test(c.tag) && c.value.split(/\s+/).includes("font-mono")) out.push(hit(file, c.line));
    return out;
  },
};

const numbered = {
  name: "01/02/03 numbering, zero-padded counters",
  run(file) {
    const out = [], seen = new Set();
    let first = null;
    lines(file).forEach((l, i) => {
      if (/padStart\(\s*2\s*,\s*["']0["']\s*\)/.test(l)) out.push(hit(file, i + 1));
      const re = /(?:>|["'`])\s*(0[1-9])\s*(?:<|["'`])/g;
      for (let m; (m = re.exec(l));) { seen.add(m[1]); first = first ?? i + 1; }
    });
    if (seen.has("01") && seen.has("02")) out.push(hit(file, first));
    for (const b of cssBlocks(file)) for (const d of b.decls) if (/decimal-leading-zero/i.test(d.value)) out.push(hit(file, d.line, declExcerpt(d)));
    return out;
  },
};

const middot = {
  name: "words separated by a middle dot",
  run(file) {
    const out = [], singles = [];
    const re = /\S\s*(?:·|&middot;|&#183;|&#xb7;)\s*\S/gi;
    lines(file).forEach((l, i) => {
      if (/^\s*(?:\/\/|\*|<!--)/.test(l)) return;
      const n = (l.match(re) || []).length;
      if (n >= 2) out.push(hit(file, i + 1));
      else if (n === 1) singles.push(i + 1);
    });
    if (singles.length >= 3) out.push(hit(file, singles[0]));
    return out;
  },
};

const gradientText = {
  name: "background-clip: text with a gradient or transparent fill",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) {
      const clip = b.decls.find((d) => /^(-webkit-)?background-clip$/.test(d.prop) && /^text\b/i.test(d.value));
      if (!clip) continue;
      const transparent = b.decls.some((d) => /^(-webkit-text-fill-color|color)$/.test(d.prop) && /transparent/i.test(d.value));
      if (/gradient\(/i.test(b.text) || transparent) out.push(hit(file, clip.line, `${b.selector} { ${declExcerpt(clip)} }`));
    }
    for (const c of classAttrs(file)) { const k = c.value.split(/\s+/); if (k.includes("bg-clip-text") && k.includes("text-transparent")) out.push(hit(file, c.line)); }
    return out;
  },
};

const translucent = (decl) => decl.some((d) => /^background(-color)?$/.test(d.prop) && /rgba?\([^)]*[,/]\s*0?\.\d+|hsla?\([^)]*[,/]\s*0?\.\d+|color-mix\(|#[0-9a-f]{8}\b|var\(--[\w-]*glass/i.test(d.value));
const glass = {
  name: "backdrop-filter blur on a translucent surface (not page chrome)",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) {
      if (/\b(header|nav|navbar|topbar|toolbar)\b/i.test(b.selector)) continue;
      const bf = b.decls.find((d) => /^(-webkit-)?backdrop-filter$/.test(d.prop) && /blur\(/i.test(d.value));
      if (!bf) continue;
      if (translucent(b.decls) || !b.decls.some((d) => /^background(-color)?$/.test(d.prop))) out.push(hit(file, bf.line, `${b.selector} { ${declExcerpt(bf)} }`));
    }
    for (const c of classAttrs(file)) {
      if (/^(header|nav)$/.test(c.tag)) continue;
      const k = c.value.split(/\s+/);
      if (k.some((x) => /^backdrop-blur/.test(x)) && k.some((x) => /^bg-[\w-]+\/\d+$/.test(x))) out.push(hit(file, c.line));
    }
    return out;
  },
};

const sideStripe = {
  name: "a thick one-sided coloured border or inset stripe",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) {
      const full = b.decls.find((d) => d.prop === "border" && !/^(0|none)\b/.test(d.value.trim()));
      for (const d of b.decls) {
        if (/^border-(left|right|inline-start|inline-end)$/.test(d.prop) && !full) {
          const w = toPx(d.value.trim().split(/\s+/)[0]);
          if (w !== null && w >= 3 && /solid|double/i.test(d.value) && !/transparent/i.test(d.value) && !/^blockquote$/i.test(b.selector)) out.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`));
        }
        if (d.prop === "box-shadow") for (const layer of topLevelCommas(d.value)) {
          const s = parseShadow(layer);
          if (s && s.inset && s.y === 0 && Math.abs(s.x) >= 3 && s.blur === 0) out.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`));
        }
      }
    }
    for (const c of classAttrs(file)) if (c.value.split(/\s+/).some((x) => /^border-[lse]-(4|8)$|^border-[lse]-\[[3-9]px\]$/.test(x))) out.push(hit(file, c.line));
    return out;
  },
};

const hardShadow = {
  name: "offset shadow with no blur",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) for (const d of b.decls) {
      if (d.prop === "box-shadow" || d.prop === "text-shadow") {
        for (const layer of topLevelCommas(d.value)) {
          const s = parseShadow(layer);
          if (s && !s.inset && s.blur === 0 && (s.x !== 0 || s.y !== 0) && Math.max(Math.abs(s.x), Math.abs(s.y)) >= 2) { out.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`)); break; }
        }
      } else if (d.prop === "filter" || d.prop === "-webkit-filter") {
        for (const m of d.value.matchAll(/drop-shadow\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi)) { const s = parseShadow(m[1]); if (s && s.blur === 0 && (s.x !== 0 || s.y !== 0)) out.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`)); }
      }
    }
    lines(file).forEach((l, i) => { if (/shadow-\[\d+px_\d+px_0(?:px)?[_\]]/.test(l)) out.push(hit(file, i + 1)); });
    return out;
  },
};

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
const emoji = {
  name: "emoji used as an icon in markup text",
  run(file) {
    if (/\.(css|scss|sass|less)$/i.test(file.path)) return [];
    const out = [];
    lines(file).forEach((l, i) => {
      if (/^\s*(?:\/\/|\*|<!--)/.test(l) || /<meta\b/i.test(l)) return;
      if (EMOJI.test(l)) out.push(hit(file, i + 1));
    });
    return out;
  },
};

const gridBackground = {
  name: "grid-paper or dot-grid background",
  run(file) {
    const out = [];
    for (const b of cssBlocks(file)) {
      const bg = b.decls.find((d) => /^background(-image)?$/.test(d.prop));
      if (!bg) continue;
      const size = b.decls.find((d) => d.prop === "background-size") || (/\/\s*\d+px/.test(bg.value) ? bg : null);
      const lin = (bg.value.match(/linear-gradient\(/gi) || []).length;
      const dots = /radial-gradient\(/i.test(bg.value) && size && (toPx((size.value.match(/(-?\d*\.?\d+)px/) || [])[0]) ?? 999) <= 48;
      const rep = /repeating-linear-gradient\([^)]*\b1px\b/i.test(bg.value);
      const url = /url\([^)]*(grid|graph-?paper|dots?)[^)]*\)/i.test(bg.value);
      if ((lin >= 2 && size) || dots || rep || url) out.push(hit(file, bg.line, `${b.selector} { ${declExcerpt(bg)} }`));
    }
    for (const c of classAttrs(file)) if (c.value.split(/\s+/).some((x) => /^bg-(grid|dots?|graph)\b|^bg-\[size:\d+px/.test(x))) out.push(hit(file, c.line));
    return out;
  },
};

const HAIR = /^(?:0?\.\d+|1)(px)?\s+(solid|dashed|dotted)\b|^thin\s+solid\b/i;
const hairline = {
  name: "one-pixel boxes on three or more rules, or many one-pixel dividers",
  run(file) {
    const boxes = [], rules = [];
    for (const b of cssBlocks(file)) {
      if (/\b(input|select|textarea|table|td|th|hr|button|btn)\b/i.test(b.selector)) continue;
      for (const d of b.decls) {
        if (d.prop === "border" && HAIR.test(d.value.trim()) && !/transparent/i.test(d.value)) boxes.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`));
        else if (/^border-(top|bottom)$/.test(d.prop) && HAIR.test(d.value.trim()) && !/transparent/i.test(d.value)) rules.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`));
      }
    }
    const tw = classAttrs(file).filter((c) => { const k = c.value.split(/\s+/); return k.includes("border") && k.some((x) => /^border-(gray|neutral|zinc|slate|stone)-(100|200|300)$/.test(x)); });
    if (boxes.length + tw.length >= 3) return [...boxes, ...tw.map((c) => hit(file, c.line))].slice(0, 3);
    if (rules.length >= 6) return rules.slice(0, 3);
    return [];
  },
};

const creamSerifTerracotta = {
  name: "cream ground, serif face and terracotta accent together in one file",
  run(file) {
    const text = stripComments(file.text), starts = lineStarts(text);
    let cream = null, terra = false;
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) {
      const c = parseColor(m[0]);
      if (!cream && isCream(c)) cream = lineAt(starts, m.index);
      if (isTerracotta(c)) terra = true;
    }
    const serif = /font(?:-family)?\s*:[^;{}]*(?:Georgia|Playfair|Fraunces|Cormorant|Lora|DM\s*Serif|Instrument\s*Serif|Libre\s*Baskerville|Source\s*Serif|Newsreader|Crimson|EB\s*Garamond|Merriweather)/i.test(text)
      || /font(?:-family)?\s*:[^;{}]*[^-]\bserif\b/i.test(text.replace(/sans-serif/gi, ""));
    return cream && terra && serif ? [hit(file, cream)] : [];
  },
};

const darkNeon = {
  name: "dark ground with a saturated glow (shadow with no offset and a wide blur)",
  run(file) {
    const text = stripComments(file.text);
    let dark = false;
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) if (isDark(parseColor(m[0]))) { dark = true; break; }
    if (!dark) return [];
    const out = [];
    for (const b of cssBlocks(file)) for (const d of b.decls) {
      if (d.prop !== "box-shadow" && d.prop !== "text-shadow") continue;
      for (const layer of topLevelCommas(d.value)) {
        const s = parseShadow(layer);
        if (s && !s.inset && s.blur >= GLOW_BLUR && Math.abs(s.x) <= 2 && Math.abs(s.y) <= 2 && isNeon(s.color)) { out.push(hit(file, d.line, `${b.selector} { ${declExcerpt(d)} }`)); break; }
      }
    }
    return out;
  },
};

const sketchSvg = {
  name: "hand-drawn imitation: turbulence displacement filter, rough-drawing libraries, doodle classes",
  run(file) {
    const out = [];
    lines(file).forEach((l, i) => {
      if (/<feDisplacementMap\b/i.test(l) || /\brough-?notation\b|\broughjs\b|\brough\.js\b/i.test(l) || /\bclass(?:Name)?\s*=\s*["'{`][^"'`]*\b(hand-?drawn|doodle|scribble|squiggle|sketchy)\b/i.test(l)) out.push(hit(file, i + 1));
    });
    return out;
  },
};

const entry = (summary, detectors) => ({ detectable: detectors.length > 0, summary, detectors });

export const REGISTRY = {
  "cream-serif-terracotta": entry("cream ground + contrasting serif + terracotta accent", [creamSerifTerracotta]),
  "dark-single-neon-glow": entry("dark ground + a single neon accent + glow", [darkNeon]),
  "hairline-newspaper": entry("hairline boxes and rules, newspaper layout", [hairline]),
  "uniform-saas-cards": entry("a kit of identical cards (judged from the screenshots)", []),
  "eyebrow-label": entry("small uppercase label above every heading", [eyebrow]),
  "mono-labels": entry("monospace used to look technical", [monoLabels]),
  "numbered-steps": entry("01/02/03 numbering", [numbered]),
  "middot-meta": entry("middot-separated meta lines", [middot]),
  "gradient-text": entry("gradient text", [gradientText]),
  "decorative-glass": entry("decorative glass surfaces", [glass]),
  "side-stripe-card": entry("side-stripe cards", [sideStripe]),
  "hard-offset-shadow": entry("hard offset shadows", [hardShadow]),
  "emoji-icons": entry("emoji instead of icons", [emoji]),
  "sketch-svg": entry("imitation-sketch SVG", [sketchSvg]),
  "grid-background": entry("grid-paper background", [gridBackground]),
};

export const DETECTABLE_IDS = PATTERN_IDS.filter((id) => REGISTRY[id].detectable);
export const JUDGED_ONLY_IDS = PATTERN_IDS.filter((id) => !REGISTRY[id].detectable);
