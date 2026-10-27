#!/usr/bin/env node
// Evidence model of the product documents: every claim is exactly one of fact, assumption, decision, written as a
// line-based marker (references/EVIDENCE.md). No dependencies. Importable: validateClaims, parseMarker, MARKER,
// rejectedProposals, parseOrigin.
//   node validate-product-claims.mjs DOC.md [--json] [--sections "Problem,Assumptions"] [--strict] [--allow-pending] [--root DIR]
// --allow-pending accepts `[proposal: ...]` markers, for a draft shown to the user; a finished document never has one.
// Exit 0: no invalid marker (unmarked claims are reported, not counted, unless --strict). 1: invalid marker
// (a fact without its source, an unknown risk type, a decision without who or basis, two markers on one claim,
// an estimate without a basis, an agent-sourced claim the user has not accepted, a pending proposal).
// 2: usage or read error.
// "Never invent" covers facts only. The agent proposes (assumptions, risks, opportunities, competitors, edge cases,
// alternatives, questions); the user accepts, changes or rejects each one. A proposal waiting for the user is
// `[proposal: <type>]` and is an error in a finished document. An accepted one becomes an assumption or decision with
// the suffix ` source agent accepted by user` (or `changed by user`). A rejected one is listed under
// `## Rejected proposals` as `- RP-<n> <text> rejected by user: <reason>`. A number in an assumption is allowed only as
// an estimate with a basis: `[assumption: value estimate "<basis>"]`.
// A fact may cite a claim of the product discovery documents: `[fact: ref <slug>#C-3]`. The marker is checked for shape
// alone; with opts.root (CLI: --root, default the current directory) the cited line `- C-3 ...` must exist in
// <product.dir>/<slug>/*.md and carry a valid fact of its own. A ref to a missing id, or to an assumption, is an error.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KINDS = ["fact", "assumption", "decision", "proposal"];
export const PROPOSALS = ["assumption", "risk", "opportunity", "competitor", "edge-case", "alternative", "question"];
export const RISKS = ["value", "usability", "viability", "feasibility"];
export const SOURCES = ["web", "interview", "data", "ref"];
// A marker is `[fact: ...]`, `[assumption: ...]`, `[decision: ...]` or `[proposal: ...]`; `[fact]` with nothing after it is a marker too.
export const MARKER = /\[(fact|assumption|decision|proposal)(?::\s*([^\]]*))?\]/gi;
// Origin suffix of an assumption or decision body: the user's own claim needs none; an agent's needs the user's answer.
const ORIGIN = /\s+source\s+(user|agent)(?:\s+(accepted|changed)\s+by\s+user)?\s*$/i;
// `user`, `agent`, `agent accepted by user` (also with a comma) as the value of a `source:` field.
export function parseOrigin(value) {
  const m = /^(user|agent)(?:[,\s]+(accepted|changed)\s+by\s+user)?$/i.exec((value || "").trim());
  if (!m) return { origin: null, errors: [`source "${value || ""}" is not user, agent accepted by user or agent changed by user`] };
  const origin = m[1].toLowerCase(), accepted = m[2]?.toLowerCase();
  return { origin, accepted, errors: origin === "agent" && !accepted ? ["an agent-sourced item needs `accepted by user` (or `changed by user`); a proposal the user has not answered stays out of the document"] : [] };
}
function splitOrigin(b) {
  const m = ORIGIN.exec(b);
  if (!m) return { body: b, origin: "user", accepted: undefined, errors: [] };
  const o = parseOrigin(m[0].replace(/^\s+source\s+/i, ""));
  return { body: b.slice(0, m.index).trim(), origin: o.origin, accepted: o.accepted, errors: o.errors };
}
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
  if (kind === "proposal") {
    const t = b.toLowerCase();
    if (!PROPOSALS.includes(t)) return { kind, errors: [`proposal needs a type, one of ${PROPOSALS.join("|")} (got "${b}")`] };
    return { kind, type: t, errors };
  }
  const so = splitOrigin(b);
  errors.push(...so.errors);
  if (kind === "assumption") {
    const m = /^(\S+)(?:\s+(.*))?$/s.exec(so.body);
    const r = (m?.[1] || "").toLowerCase();
    if (!RISKS.includes(r)) return { kind, errors: [`assumption needs a risk type, one of ${RISKS.join("|")} (got "${b}")`, ...errors] };
    let estimate;
    if (m[2]) {
      const e = /^estimate\s+"([^"]+)"$/i.exec(m[2].trim());
      if (!e) return { kind, risk: r, errors: ['after the risk type only `estimate "<basis>"` may follow (a number in an assumption is an estimate with a basis)', ...errors] };
      estimate = e[1].trim();
      if (estimate.split(/\s+/).length < 3 || /^(guess|unknown|none|n\/a|tbd)\b/i.test(estimate)) errors.push("an estimate needs a basis of at least 3 words: where the number comes from, or why this range");
    }
    return { kind, risk: r, estimate, origin: so.origin, accepted: so.accepted, errors };
  }
  const d = /^by\s+(.+?)\s+because\s+(.+)$/is.exec(so.body);
  if (!d) return { kind, errors: ["decision needs `by <who> because <basis>`", ...errors] };
  return { kind, by: d[1].trim(), basis: d[2].trim(), origin: so.origin, accepted: so.accepted, errors };
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
    // A172: the ref regex accepts any case, so the claim line is found by key (case-insensitive, leading zeros ignored)
    const key = (x) => String(x).toUpperCase().replace(/-0+(?=\d)/g, "-");
    const at = lines.findIndex((l) => { const m = /^- ([A-Za-z]+-\d+) /.exec(l); return m !== null && key(m[1]) === key(id); });
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

// `## Rejected proposals`: the ledger of what the agent proposed and the user rejected. Lines
// `- RP-<n> <proposal> rejected by user: <reason>` (`- none` is allowed). Returns { items[{line,id,text,reason}], errors[{line,message}] }.
export function rejectedProposals(text) {
  const items = [], errors = [], seen = new Set();
  let inSection = false, fence = false;
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) { inSection = h[1].toLowerCase() === "rejected proposals"; return; }
    if (!inSection || !/^\s*[-*]\s+\S/.test(raw) || /^\s*[-*]\s+(none|yok)\.?\s*$/i.test(raw)) return;
    const m = /^\s*[-*]\s+(RP-\d+)\s+(.+?)\s+rejected by user:\s*(\S.*?)\s*$/i.exec(raw);
    if (!m) { errors.push({ line, message: "a rejected proposal is `- RP-<n> <proposal> rejected by user: <reason>`" }); return; }
    if (seen.has(m[1].toUpperCase())) errors.push({ line, message: `${m[1]} is listed twice` });
    seen.add(m[1].toUpperCase());
    items.push({ line, id: m[1], text: m[2], reason: m[3] });
  });
  return { items, errors };
}

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
      if (p.kind === "proposal" && !opts.allowPending) errors.push({ line, message: "pending proposal: the user has not answered it. Accepted: write it as an assumption or decision with `source agent accepted by user`. Rejected: list it under `## Rejected proposals`. Otherwise remove it", text: raw.trim().slice(0, 160) });
      if (p.source === "ref" && !p.errors.length && opts.root) {
        const r = resolveRef(opts.root, p.slug, p.id, opts.productDir);
        if (!r.ok) errors.push({ line, message: `ref ${r.error}`, text: raw.trim().slice(0, 160) });
      }
    }
    if (found.length > 1) errors.push({ line, message: `a claim carries exactly one marker (found ${found.length})`, text: raw.trim().slice(0, 160) });
    const inClaims = sections.includes(h2) || (h3 && sections.includes(h3));
    if (!found.length && inClaims && h2 !== "rejected proposals" && !/^\s*[-*]\s+(none|yok)\b/i.test(raw) && /[\p{L}]/u.test(raw)) unmarked.push({ line, text: raw.trim().slice(0, 160) });
  });
  for (const e of rejectedProposals(text).errors) errors.push({ ...e, text: "" });
  return { valid: errors.length === 0, errors, unmarked, claims: claims.map(({ errors: _e, ...c }) => c) };
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const file = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--sections" && argv[i - 1] !== "--root");
  if (!file) { console.error("usage: validate-product-claims.mjs DOC.md [--json] [--sections \"A,B\"] [--strict] [--allow-pending] [--root DIR]"); return 2; }
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 2; }
  const sections = opt("--sections")?.split(",").map((s) => s.trim()).filter(Boolean);
  const r = validateClaims(text, { sections, root: resolve(opt("--root") || "."), allowPending: argv.includes("--allow-pending") });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    for (const e of r.errors) console.error(`error: ${file}:${e.line}: ${e.message}`);
    for (const u of r.unmarked) console.error(`unmarked: ${file}:${u.line}: claim carries no marker: ${u.text}`);
  }
  return !r.valid || (argv.includes("--strict") && r.unmarked.length) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
