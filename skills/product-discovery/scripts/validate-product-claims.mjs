#!/usr/bin/env node
// Evidence model of the product documents: every claim is exactly one of fact, assumption, decision, written as a
// line-based marker (references/EVIDENCE.md). No dependencies. Importable: validateClaims, parseMarker, MARKER.
//   node validate-product-claims.mjs DOC.md [--json] [--sections "Problem,Assumptions"] [--strict] [--root DIR]
// Exit 0: no invalid marker (unmarked claims are reported, not counted, unless --strict). 1: invalid marker
// (a fact without its source, an unknown risk type, a decision without who or basis, two markers on one claim).
// 2: usage or read error.
// A fact may cite a claim of the product discovery documents: `[fact: ref <slug>#C-3]`. The marker is checked for shape
// alone; with opts.root (CLI: --root, default the current directory) the cited line `- C-3 ...` must exist in
// <product.dir>/<slug>/*.md and carry a valid fact of its own. A ref to a missing id, or to an assumption, is an error.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KINDS = ["fact", "assumption", "decision"];
export const RISKS = ["value", "usability", "viability", "feasibility"];
export const SOURCES = ["web", "interview", "data", "ref"];
// A marker is `[fact: ...]`, `[assumption: ...]` or `[decision: ...]`; `[fact]` with nothing after it is a marker too.
export const MARKER = /\[(fact|assumption|decision)(?::\s*([^\]]*))?\]/gi;
// Sections whose list items and paragraphs are claims when the caller names none.
export const DEFAULT_SECTIONS = ["Problem", "Context", "Background", "Evidence", "Assumptions", "Users", "Market"];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Returns { kind, errors[] , ...fields } for one marker's kind and body.
export function parseMarker(kind, body = "") {
  kind = kind.toLowerCase();
  const b = (body || "").trim(), errors = [];
  if (kind === "fact") {
    const m = /^(\S+)\s*(.*)$/s.exec(b);
    const src = m?.[1]?.toLowerCase();
    if (!src) return { kind, errors: ["fact without a source (want web, interview, data or ref)"] };
    if (!SOURCES.includes(src)) return { kind, errors: [`fact source "${m[1]}" is not one of ${SOURCES.join("|")}`] };
    const rest = m[2];
    if (src === "web") {
      const w = /^(https?:\/\/\S+)\s+accessed\s+(\S+)\s+"([^"]+)"\s*$/.exec(rest);
      if (!w) return { kind, source: src, errors: ['web fact needs `<URL> accessed <YYYY-MM-DD> "<verbatim quote>"`'] };
      if (!DATE.test(w[2])) errors.push(`web fact access date "${w[2]}" is not YYYY-MM-DD`);
      return { kind, source: src, url: w[1], accessed: w[2], quote: w[3], errors };
    }
    if (src === "ref") {
      const r = /^([a-z0-9][a-z0-9-]*)#(C-\d+)\s*$/i.exec(rest);
      if (!r) return { kind, source: src, errors: ["ref fact needs `ref <slug>#C-<n>`"] };
      return { kind, source: src, slug: r[1], id: r[2], errors };
    }
    if (src === "interview") {
      const v = /^(\S+)\s+"([^"]+)"\s*$/.exec(rest);
      if (!v) return { kind, source: src, errors: ['interview fact needs `<interview-id> "<verbatim quote>"`'] };
      return { kind, source: src, interview: v[1], quote: v[2], errors };
    }
    const d = /^`([^`]+)`\s+sha256:([0-9a-f]{64})\s*$/i.exec(rest);
    if (!d) return { kind, source: src, errors: ["data fact needs `` `<query or script>` sha256:<64 hex of the output>``"] };
    return { kind, source: src, query: d[1], sha256: d[2].toLowerCase(), errors };
  }
  if (kind === "assumption") {
    const r = b.toLowerCase();
    if (!RISKS.includes(r)) return { kind, errors: [`assumption needs a risk type, one of ${RISKS.join("|")} (got "${b}")`] };
    return { kind, risk: r, errors };
  }
  const d = /^by\s+(.+?)\s+because\s+(.+)$/is.exec(b);
  if (!d) return { kind, errors: ["decision needs `by <who> because <basis>`"] };
  return { kind, by: d[1].trim(), basis: d[2].trim(), errors };
}

// product.dir of DIR/.agents/config.yaml (project-relative), else docs/product.
export function productDirOf(root) {
  try {
    let inBlock = false;
    for (const l of readFileSync(join(root, ".agents", "config.yaml"), "utf8").split(/\r?\n/)) {
      if (/^\S/.test(l)) { inBlock = /^product:\s*(#.*)?$/.test(l); continue; }
      const m = inBlock && /^  dir:\s*(.*?)\s*$/.exec(l);
      if (m) { const v = m[1].replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1"); if (v) return v; }
    }
  } catch { /* no config */ }
  return "docs/product";
}

// Finds `- <id> ...` at line start in <root>/<dir>/<slug>/*.md. Returns { ok, file, line, text, error }.
export function resolveRef(root, slug, id, dir = productDirOf(root)) {
  const folder = join(root, dir, slug);
  let names = [];
  try { names = readdirSync(folder).filter((n) => n.endsWith(".md")).sort(); } catch { /* missing folder */ }
  for (const n of names) {
    const lines = stripComments(readFileSync(join(folder, n), "utf8")).split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith(`- ${id} `));
    if (at < 0) continue;
    const text = lines[at], ref = { file: join(dir, slug, n), line: at + 1, text };
    const found = [...text.matchAll(MARKER)];
    if (found.length !== 1) return { ok: false, ...ref, error: `${slug}#${id} carries ${found.length} markers (want exactly one fact)` };
    const p = parseMarker(found[0][1], found[0][2]);
    if (p.kind !== "fact") return { ok: false, ...ref, error: `${slug}#${id} is ${p.kind === "assumption" ? "an assumption" : `a ${p.kind}`}, not a fact` };
    if (p.errors.length) return { ok: false, ...ref, error: `${slug}#${id} is not a valid fact: ${p.errors[0]}` };
    return { ok: true, ...ref };
  }
  return { ok: false, error: `${slug}#${id} not found: no line starting "- ${id} " in ${join(dir, slug)}/*.md` };
}

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));

// Claim lines: list items and paragraph lines of the named sections (H2 or H3), outside code fences and tables.
// Placeholder items such as `- none` are no claims. Every marker anywhere in the document is validated.
export function validateClaims(text, opts = {}) {
  const sections = (opts.sections || DEFAULT_SECTIONS).map((s) => s.toLowerCase());
  const errors = [], unmarked = [], claims = [];
  let h2 = "", h3 = "", fence = false;
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(raw);
    if (h) { if (h[1] === "##") { h2 = h[2].toLowerCase(); h3 = ""; } else h3 = h[2].toLowerCase(); return; }
    if (/^#\s/.test(raw) || /^\s*\|/.test(raw) || !raw.trim()) return;
    const found = [...raw.matchAll(MARKER)];
    for (const m of found) {
      const p = parseMarker(m[1], m[2]);
      claims.push({ line, ...p, errors: undefined });
      for (const e of p.errors) errors.push({ line, message: e, text: raw.trim().slice(0, 160) });
      if (p.source === "ref" && !p.errors.length && opts.root) {
        const r = resolveRef(opts.root, p.slug, p.id, opts.productDir);
        if (!r.ok) errors.push({ line, message: `ref ${r.error}`, text: raw.trim().slice(0, 160) });
      }
    }
    if (found.length > 1) errors.push({ line, message: `a claim carries exactly one marker (found ${found.length})`, text: raw.trim().slice(0, 160) });
    const inClaims = sections.includes(h2) || (h3 && sections.includes(h3));
    if (!found.length && inClaims && !/^\s*[-*]\s+(none|yok)\b/i.test(raw) && /[\p{L}]/u.test(raw)) unmarked.push({ line, text: raw.trim().slice(0, 160) });
  });
  return { valid: errors.length === 0, errors, unmarked, claims: claims.map(({ errors: _e, ...c }) => c) };
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--sections" && argv[i - 1] !== "--root");
  if (!file) { console.error("usage: validate-product-claims.mjs DOC.md [--json] [--sections \"A,B\"] [--strict] [--root DIR]"); return 2; }
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 2; }
  const sections = opt("--sections")?.split(",").map((s) => s.trim()).filter(Boolean);
  const r = validateClaims(text, { sections, root: resolve(opt("--root") || ".") });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    for (const e of r.errors) console.error(`error: ${file}:${e.line}: ${e.message}`);
    for (const u of r.unmarked) console.error(`unmarked: ${file}:${u.line}: claim carries no marker: ${u.text}`);
  }
  return !r.valid || (argv.includes("--strict") && r.unmarked.length) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
