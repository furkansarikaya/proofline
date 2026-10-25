#!/usr/bin/env node
// design-sync: mechanical extraction of claims from durable design documents and of facts from code (D26).
// No dependencies. Prints JSON (schema/sync.schema.json).
//
//   node design-sync.mjs [--root DIR] [--config FILE] [--check] [--only data_model|architecture|api|design]
//        [--data-model F] [--architecture F] [--api F] [--design F]       (paths relative to root; override config)
//        [--file PATH]   (design_docs.design surfaces: check only the design documents that apply to PATH: its surface and the shared one)
//   node design-sync.mjs --reverse data|api|system|ui [--root DIR]        (code facts for drafting a document)
//
// Exit: 0 ok; with --check 1 when any claim is unmatched (verdict FAIL); 2 usage/read error.
// Statuses: matched | unmatched (searched in a supported way, nothing found) | unverifiable (heuristic cannot decide).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, basename, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { allPruneDirs, loadEcosystems, manifestGlobs, matchesAny } from "./ecosystems.mjs";

// Build output, dependency and tool folders come from the ecosystem definition (ecosystems.json, A173), never from a layout assumption.
const SKIP_DIRS = new Set(allPruneDirs());
const CODE_EXT = new Set(".js .mjs .cjs .ts .tsx .jsx .vue .svelte .py .rb .go .java .kt .cs .cshtml .razor .php .rs .swift .sql .prisma .graphql .css .scss .sass .less .html .json .yaml .yml .toml .xml .gradle .sh .fs .fsx .vb .dart .kts .scala".split(" "));
const MAX_BYTES = 1_000_000;
const METHODS = "GET POST PUT PATCH DELETE HEAD OPTIONS";
const DEFAULT_DOCS = { design: "docs/design/DESIGN.md", architecture: "docs/design/ARCHITECTURE.md", data_model: "docs/design/DATA_MODEL.md", api: "docs/design/API.md" };
const ROLES = ["data_model", "architecture", "api", "design"];

// ---------- config ----------
// design_docs.design is a path (one document) or a mapping with `surfaces:` (one document per surface) and an optional `shared`:
//   design:
//     shared: docs/design/BASE.md
//     surfaces:
//       site: { doc: ..., paths: ..., mode: ... }   (written as nested keys, one per line)
// The result holds the flat roles plus `surfaces` ([{ name, doc, paths: [glob], mode }]) and `shared` when the mapping form is used.
export function readDocConfig(configText) {
  const out = { ...DEFAULT_DOCS };
  if (!configText) return out;
  let inBlock = false, base = -1;
  const stack = []; // [{ indent, key }] below design_docs
  const surfaces = new Map();
  let shared = "", mapping = false;
  for (const raw of configText.split(/\r?\n/)) {
    if (/^design_docs:\s*(#.*)?$/.test(raw)) { inBlock = true; base = -1; stack.length = 0; continue; }
    if (inBlock && /^\S/.test(raw)) inBlock = false;
    if (!inBlock) continue;
    const m = /^(\s+)(\w[\w-]*):\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length, key = m[2];
    const val = m[3].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
    if (base < 0) base = indent;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = [...stack.map((e) => e.key), key];
    stack.push({ indent, key });
    if (path.length === 1) { if (key in out) out[key] = val; continue; }
    if (path[0] !== "design") continue;
    mapping = true;
    if (path.length === 2 && key === "shared") shared = val;
    else if (path.length === 4 && path[1] === "surfaces") {
      const sf = surfaces.get(path[2]) || { name: path[2], doc: "", paths: [], mode: "" };
      if (key === "doc") sf.doc = val; else if (key === "paths") sf.paths = val.split(/\s+/).filter(Boolean); else if (key === "mode") sf.mode = val;
      surfaces.set(path[2], sf);
    } else if (path.length === 3 && path[1] === "surfaces") { if (!surfaces.has(key)) surfaces.set(key, { name: key, doc: "", paths: [], mode: "" }); }
  }
  if (mapping) { out.design = ""; out.shared = shared; out.surfaces = [...surfaces.values()]; }
  return out;
}

// ---------- design surfaces ----------
// The same rules as `agent.sh design-surface`: `*` (and `**`) matches any characters including `/`, `**/` also zero directories (apps/**/x.ts matches apps/x.ts), `?` one character, `[..]` a class;
// an entry ending in `/` is a directory prefix. One surface matches: its document (plus `shared`). Two: an error. None: `shared` only.
export function globMatch(glob, path) {
  let g = glob.replace(/^\.\//, "");
  if (g.endsWith("/")) g += "*";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (g.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; } // `**/` also matches zero directories
    else if (c === "*") { while (g[i + 1] === "*") i++; re += ".*"; }
    else if (c === "?") re += ".";
    else if (c === "[" && g.indexOf("]", i + 2) > 0) { const j = g.indexOf("]", i + 2); re += "[" + g.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]"; i = j; }
    else re += c.replace(/[.+^${}()|\\\]\[]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

// root (optional): when given, a matched surface whose document is missing is "new-direction" (as in agent.sh design-surface)
export function resolveSurface(docsCfg, file, root) {
  const f = file.replace(/^\.\//, "");
  if (!docsCfg.surfaces) return { mode: "single", status: "ok", surface: "", docs: docsCfg.design ? [docsCfg.design] : [], warnings: [] };
  const hits = docsCfg.surfaces.filter((s) => s.paths.some((g) => globMatch(g, f)));
  const shared = docsCfg.shared ? [docsCfg.shared] : [];
  if (hits.length > 1) return { mode: "surfaces", status: "overlap", surface: "", docs: [], warnings: [], error: `${f} matches more than one surface: ${hits.map((h) => h.name).join(", ")}` };
  if (!hits.length) return { mode: "surfaces", status: "no-surface", surface: "", docs: shared, warnings: shared.length ? [] : [`no surface matches ${f} and design_docs.design.shared is not set: no design document applies`] };
  const h = hits[0];
  const missing = root !== undefined && !(h.doc && existsSync(join(root, h.doc)));
  return { mode: "surfaces", status: missing ? "new-direction" : "ok", surface: h.name, visitorMode: h.mode, docs: [...shared, h.doc], warnings: [] };
}

// the same rules as `agent.sh config-check` for the surfaces mapping; returns the error lines
export function checkSurfaces(docsCfg) {
  if (!docsCfg.surfaces) return [];
  const errs = [];
  const rel = (v) => v.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(v);
  if (docsCfg.shared && rel(docsCfg.shared)) errs.push(`design_docs.design.shared must be project-relative: ${docsCfg.shared}`);
  if (!docsCfg.surfaces.length) errs.push("design_docs.design.surfaces names no surface");
  if (docsCfg.shared && !docsCfg.surfaces.length) errs.push("design_docs.design.shared needs design_docs.design.surfaces");
  for (const s of docsCfg.surfaces) {
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) errs.push(`invalid surface name: ${s.name}`);
    if (!s.doc) errs.push(`design surface ${s.name} has no doc`); else if (rel(s.doc)) errs.push(`surface ${s.name} doc must be project-relative: ${s.doc}`);
    if (!s.paths.length) errs.push(`design surface ${s.name} has no paths`);
    for (const g of s.paths) { if (g.split("**/").length > 2) errs.push(`surface ${s.name} paths allow one **/ per glob: ${g}`); if (/[\\|]/.test(g)) errs.push(`surface ${s.name} paths may not contain \\ or |: ${g}`); if (rel(g)) errs.push(`surface ${s.name} paths must be project-relative globs: ${g}`); }
    if (s.mode && !/^[a-z][a-z-]*$/.test(s.mode)) errs.push(`surface ${s.name} mode is a visitor mode in lower case: ${s.mode}`);
  }
  return errs;
}

// every design document the configuration names (the single document, or the shared one and each surface document)
export function designDocList(docsCfg) {
  if (!docsCfg.surfaces) return docsCfg.design ? [docsCfg.design] : [];
  return [docsCfg.shared, ...docsCfg.surfaces.map((s) => s.doc)].filter(Boolean);
}

// ---------- code scan ----------
export function walk(root) {
  const files = [], dirs = [];
  (function rec(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; dirs.push(relative(root, p).split(sep).join("/")); rec(p); }
      else if (e.isFile()) files.push(relative(root, p).split(sep).join("/"));
    }
  })(root);
  return { files, dirs };
}

const normPath = (p) => {
  let s = p.split("?")[0].replace(/\{[^}]*\}|<[^>]*>|\[[^\]]+\](?!\))|:\w+/g, "{}");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/$/, "");
  return s.toLowerCase();
};
const normTable = (n) => n.toLowerCase().replace(/[`"'\[\]_\s-]/g, "").replace(/s$/, "");
const unq = (s) => s.replace(/[`"\[\]]/g, "");

export function loadCode(root, files, excludeAbs) {
  const out = [];
  for (const rel of files) {
    if (!CODE_EXT.has(extname(rel).toLowerCase()) || /(^|\/)(package-lock|yarn\.lock|pnpm-lock)/.test(rel)) continue;
    if (excludeAbs.has(rel)) continue;
    const abs = join(root, rel);
    try { if (statSync(abs).size > MAX_BYTES) continue; out.push({ rel, text: readFileSync(abs, "utf8") }); } catch { /* unreadable */ }
  }
  return out;
}

export function extractTables(code) {
  const t = [];
  const add = (name, rel, line, source) => { if (name) t.push({ name: unq(name), norm: normTable(unq(name).split(".").pop()), file: rel, line, source }); };
  for (const { rel, text } of code) {
    const lines = text.split("\n");
    lines.forEach((l, i) => {
      const n = i + 1;
      let m;
      if ((m = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[\w$]+[`"\]]?(?:\.[`"\[]?[\w$]+[`"\]]?)*)/i.exec(l))) add(m[1], rel, n, "sql");
      if (rel.endsWith(".prisma") && (m = /^\s*model\s+(\w+)\s*\{/.exec(l))) add(m[1], rel, n, "prisma");
      if ((m = /@@map\(\s*"(\w+)"/.exec(l))) add(m[1], rel, n, "prisma");
      if (rel.endsWith(".py")) {
        if ((m = /^class\s+(\w+)\(.*models\.Model/.exec(l))) add(m[1], rel, n, "django");
        if ((m = /db_table\s*=\s*['"](\w+)['"]/.exec(l)) || (m = /__tablename__\s*=\s*['"](\w+)['"]/.exec(l))) add(m[1], rel, n, "python-orm");
      }
      if (rel.endsWith(".cs") && ((m = /DbSet<(\w+)>\s+(\w+)/.exec(l)))) { add(m[1], rel, n, "ef"); add(m[2], rel, n, "ef"); }
      if ((m = /\.ToTable\(\s*"(\w+)"/.exec(l)) || (m = /\[Table\(\s*"(\w+)"/.exec(l))) add(m[1], rel, n, "ef");
      if ((m = /@Entity\(\s*['"](\w+)['"]/.exec(l)) || (m = /@Table\(\s*name\s*=\s*"(\w+)"/.exec(l))) add(m[1], rel, n, "orm");
      if ((m = /\bcreate_table\s+[:"'](\w+)/.exec(l)) || (m = /\bcreateTable(?:IfNotExists)?\(\s*['"`](\w+)/.exec(l)) || (m = /\.define\(\s*['"](\w+)['"]/.exec(l))) add(m[1], rel, n, "migration");
    });
  }
  return t;
}

const JS_RECEIVER = /^(app|router|routes?|server|fastify|api|r|e|g|mux|group|v\d+|\w*(?:router|app|routes|server|group|api))$/i;

export function extractRoutes(code) {
  const routes = [];
  const add = (method, path, rel, line, source) => routes.push({ method: method.toUpperCase(), path: normPath(path), raw: path, file: rel, line, source });
  for (const { rel, text } of code) {
    if (/(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(rel)) continue;
    const lines = text.split("\n");
    let prefix = "";
    const filePrefix = /APIRouter\([^)]*prefix\s*=\s*['"]([^'"]*)['"]/.exec(text)?.[1] || "";
    lines.forEach((l, i) => {
      const n = i + 1;
      let m;
      const generic = !/\.(py|java|kt|cs)$/.test(rel);
      if (generic && (m = /\b(\w+)\.(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])(\/[^'"`]*)\3/i.exec(l)) && JS_RECEIVER.test(m[1])) add(m[2] === "all" ? "*" : m[2], m[4], rel, n, "router-call");
      if ((m = /\.route\(\s*['"`](\/[^'"`]*)['"`]\s*\)\s*\.(get|post|put|patch|delete)\(/i.exec(l))) add(m[2], m[1], rel, n, "express-route");
      if ((m = /\b(?:HandleFunc|Handle)\(\s*"(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/[^"]*)"/.exec(l))) add(m[1] || "*", m[2], rel, n, "go-http");
      if ((m = /\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"/.exec(l))) add(m[1], m[2], rel, n, "aspnet-minimal");
      if (/\.(py)$/.test(rel)) {
        if ((m = /^\s*@(\w+)\.(get|post|put|patch|delete|head|options)\(\s*['"]([^'"]*)['"]/.exec(l))) add(m[2], filePrefix + m[3], rel, n, "fastapi");
        else if ((m = /^\s*@(\w+)\.route\(\s*['"]([^'"]*)['"](?:.*methods\s*=\s*\[([^\]]*)\])?/.exec(l))) {
          const ms = (m[3] || "GET").match(/[A-Za-z]+/g) || ["GET"];
          ms.forEach((x) => add(x, m[2], rel, n, "flask"));
        }
        if (/(^|\/)urls\.py$/.test(rel) && (m = /\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]\s*,/.exec(l))) add("*", "/" + m[1].replace(/^\^|\$$/g, ""), rel, n, "django-url");
      }
      if (/\.(java|kt)$/.test(rel)) {
        if ((m = /@RequestMapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/.exec(l))) {
          if (lines.slice(i, i + 5).some((x) => /\b(class|interface)\b/.test(x))) prefix = m[1];
          else add("*", prefix + "/" + m[1], rel, n, "spring");
        } else if ((m = /@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*(?:"([^"]*)")?)?/.exec(l))) add(m[1], prefix + "/" + (m[2] || ""), rel, n, "spring");
      }
      if (rel.endsWith(".cs")) {
        if ((m = /\[Route\(\s*"([^"]*)"\s*\)\]/.exec(l))) {
          const cls = lines.slice(i, i + 6).map((x) => /\bclass\s+(\w+?)(?:Controller)?\b/.exec(x)).find(Boolean);
          if (cls) prefix = m[1].replace(/\[controller\]/gi, cls[1].toLowerCase());
          else add("*", prefix + "/" + m[1], rel, n, "aspnet");
        } else if ((m = /\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\(\s*"([^"]*)"\s*\))?\]/.exec(l))) add(m[1], prefix + "/" + (m[2] || ""), rel, n, "aspnet");
      }
    });
  }
  return routes;
}

// ---------- OpenAPI (doc side) ----------
export function parseOpenApi(text) {
  const out = [];
  const lines = text.split("\n");
  if (/^\s*[{[]/.test(text)) {
    try { for (const [p, ops] of Object.entries(JSON.parse(text).paths || {})) for (const m of Object.keys(ops)) if (METHODS.includes(m.toUpperCase())) out.push({ method: m.toUpperCase(), path: p, line: lines.findIndex((l) => l.includes(`"${p}"`)) + 1 || 1 }); } catch { /* not json */ }
    return out;
  }
  let inPaths = false, cur = null;
  lines.forEach((l, i) => {
    if (/^paths:\s*$/.test(l)) { inPaths = true; return; }
    if (inPaths && /^\S/.test(l) && l.trim() && !l.startsWith("#")) inPaths = false;
    if (!inPaths) return;
    let m;
    if ((m = /^ {1,4}['"]?(\/[^'":\s]*)['"]?:\s*$/.exec(l))) cur = m[1];
    else if (cur && (m = /^ {3,8}(get|post|put|patch|delete|head|options):/i.exec(l))) out.push({ method: m[1].toUpperCase(), path: cur, line: i + 1 });
  });
  return out;
}

// ---------- doc claims ----------
const isPathSpan = (s) => !/[\s*<>{}|]/.test(s) && !/^[a-z]+:\/\//i.test(s) && !/^\d+(\.\d+)+$/.test(s) && (s.includes("/") || /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(s)) && /^[\w@.\-/\[\]()]+$/.test(s) && !/^[A-Z]+\s/.test(s);
const cells = (l) => l.split("|").slice(1, l.trim().endsWith("|") ? -1 : undefined).map((c) => c.trim());
const unbt = (s) => s.replace(/^`+|`+$/g, "");

function eachDocLine(text, fn) {
  let fence = false, header = null;
  text.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; fn({ l, n: i + 1, fence: true, header: null, row: null }); return; }
    let row = null;
    if (!fence && /^\s*\|/.test(l)) {
      const c = cells(l);
      if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === "")) row = "sep";
      else if (!header) { header = c.map((x) => x.toLowerCase()); row = "header"; }
      else row = c;
    } else header = null;
    fn({ l, n: i + 1, fence, header, row });
  });
}

export function dataModelClaims(text) {
  const claims = [];
  eachDocLine(text, ({ l, n, fence, header, row }) => {
    let m;
    if (fence) { if ((m = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[\w$.]+[`"\]]?)/i.exec(l))) claims.push({ kind: "table", claim: unq(m[1]).split(".").pop(), line: n }); return; }
    if (Array.isArray(row) && header && /^(table|table name|name|entity)$/.test(header[0])) { const v = unbt(row[0]); if (/^[A-Za-z_][\w.]*$/.test(v)) claims.push({ kind: "table", claim: v.split(".").pop(), line: n }); return; }
    if ((m = /^#{2,6}\s+(?:Table:?\s*`?([A-Za-z_][\w.]*)`?|`([A-Za-z_][\w.]*)`)\s*(?:\(table\))?\s*$/i.exec(l)) || (m = /^#{2,6}\s+`?([A-Za-z_][\w.]*)`?\s*\(table\)\s*$/i.exec(l))) claims.push({ kind: "table", claim: (m[1] || m[2]).split(".").pop(), line: n });
  });
  return claims;
}

export function pathClaims(text) {
  const claims = [];
  eachDocLine(text, ({ l, n, fence }) => {
    if (fence) return;
    for (const m of l.matchAll(/`([^`\n]+)`/g)) {
      let s = m[1].trim().replace(/^\.\//, "").replace(/#.*$/, "").replace(/:\d+(-\d+)?$/, "");
      if (/[*]/.test(s) && /\//.test(s) && !/\s/.test(s)) { claims.push({ kind: "path", claim: s, line: n, glob: true }); continue; }
      if (isPathSpan(s)) claims.push({ kind: "path", claim: s, line: n });
    }
  });
  return claims;
}

export function apiClaims(text) {
  const claims = [], seen = new Set();
  const push = (method, path, n) => { const k = `${n}:${method}:${path}`; if (!seen.has(k)) { seen.add(k); claims.push({ kind: "endpoint", claim: `${method} ${path}`, method, path, line: n }); } };
  const re = new RegExp(`\\b(${METHODS.replace(/ /g, "|")})\\s+\`?(\\/[^\\s\`|)>"',;]*)`, "g");
  eachDocLine(text, ({ l, n, row }) => {
    for (const m of l.matchAll(re)) push(m[1], m[2].replace(/[.:]+$/, ""), n);
    if (Array.isArray(row)) {
      const cs = row.map(unbt);
      const meth = cs.find((c) => METHODS.split(" ").includes(c.toUpperCase()));
      const path = cs.find((c) => /^\/[^\s]*$/.test(c));
      if (meth && path) push(meth.toUpperCase(), path, n);
    }
  });
  return claims;
}

export function designClaims(text) {
  const claims = [];
  eachDocLine(text, ({ l, n, fence, header, row }) => {
    if (fence) return;
    const spans = [...l.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
    const loc = spans.find((s) => isPathSpan(s) && !/^--/.test(s));
    for (const s of spans) if (/^--[\w-]+$/.test(s)) claims.push({ kind: "css-var", claim: s, line: n });
    let name = null, kind = null;
    if (Array.isArray(row) && header && /token|component/.test(header.join(" "))) { name = unbt(row[0]); kind = /token/.test(header[0] || "") && !/component/.test(header[0]) ? "token" : /component/.test(header[0] || "") ? "component" : (/^[A-Z]/.test(name) ? "component" : "token"); }
    else { const m = /^\s*[-*]\s+`([A-Za-z][\w.-]*)`/.exec(l); if (m) { name = m[1]; kind = /^[A-Z][A-Za-z0-9]+$/.test(name) ? "component" : /\./.test(name) ? "token" : null; } }
    if (name && kind && !/^--/.test(name) && /^[A-Za-z][\w.-]*$/.test(name) && !(kind === "component" && !/^[A-Z]/.test(name))) claims.push({ kind, claim: name, line: n, location: loc });
  });
  return claims;
}

// ---------- evaluation ----------
const variants = (name) => {
  const parts = name.split(/[.\-_]/).filter(Boolean);
  const camel = parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return [...new Set([name, `--${parts.join("-")}`, parts.join("-"), parts.join("_"), parts.join("."), camel])];
};
const wordRe = (w) => new RegExp(`(^|[^\\w$-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`);

export function evaluate(role, claims, ctx) {
  const { facts, code, files, dirs, root, docFiles } = ctx;
  const res = [];
  const seen = new Set();
  for (const c of claims) {
    const key = `${c.kind}:${c.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = { ...c, status: "unverifiable", evidence: [], note: "" };
    delete r.glob; delete r.method; delete r.path; delete r.location;
    if (c.kind === "table") {
      const hit = facts.tables.filter((t) => t.norm === normTable(c.claim));
      if (!facts.tables.length) r.note = "no table definitions recognized in code (unsupported schema format?)";
      else if (hit.length) { r.status = "matched"; r.evidence = hit.slice(0, 3).map((t) => `${t.file}:${t.line}`); }
      else { r.status = "unmatched"; r.note = `${facts.tables.length} table definitions scanned, none named ${c.claim}`; }
    } else if (c.kind === "endpoint") {
      const p = normPath(c.path), hit = facts.routes.filter((x) => (x.method === "*" || c.method === "*" || x.method === c.method) && (x.path === p || (x.path.length > 1 && p.endsWith(x.path))));
      if (!facts.routes.length) r.note = "no route declarations recognized in code (unsupported framework?)";
      else if (hit.length) { r.status = "matched"; r.evidence = hit.slice(0, 3).map((x) => `${x.file}:${x.line}`); }
      else { r.status = "unmatched"; r.note = `${facts.routes.length} route declarations scanned, none for ${c.method} ${c.path}`; }
    } else if (c.kind === "path") {
      const s = c.claim.replace(/\/$/, "");
      if (c.glob) r.note = "glob pattern";
      else if (s.startsWith("/") && !files.includes(s.slice(1)) && !dirs.includes(s.slice(1))) r.note = "absolute path, probably a URL route";
      else if (SKIP_DIRS.has(s.split("/")[0])) r.note = "inside an ignored or generated directory";
      else {
        const rel = s.replace(/^\//, "");
        if (files.includes(rel) || dirs.includes(rel)) { r.status = "matched"; r.evidence = [rel]; }
        else if (!rel.includes("/") && files.some((f) => basename(f) === rel)) { r.status = "matched"; r.note = "found by file name"; r.evidence = [files.find((f) => basename(f) === rel)]; }
        else {
          r.status = "unmatched";
          const hint = [...files, ...dirs].find((f) => f.endsWith("/" + rel));
          r.note = hint ? `not at this path; similar: ${hint}` : "no such file or directory";
        }
      }
    } else if (c.kind === "css-var") {
      const hit = code.find((f) => f.text.includes(c.claim));
      if (hit) { r.status = "matched"; r.evidence = [hit.rel]; } else { r.status = "unmatched"; r.note = "custom property not found in any code file"; }
    } else if (c.kind === "component" || c.kind === "token") {
      const vs = variants(c.claim);
      const def = (f) => c.kind === "component"
        ? new RegExp(`\\b(function|class|const|let|var|struct|interface|type|def|func)\\s+${c.claim}\\b`).test(f.text) || new RegExp(`(^|/)${c.claim}\\.\\w+$`).test(f.rel)
        : vs.some((v) => f.text.includes(v));
      let pool = code, scope = "";
      if (c.location) {
        const loc = c.location.replace(/^\.\//, "").replace(/\/$/, "");
        if (!files.includes(loc) && !dirs.includes(loc)) { r.status = "unmatched"; r.note = `documented location ${loc} does not exist`; res.push(r); continue; }
        pool = code.filter((f) => f.rel === loc || f.rel.startsWith(loc + "/") || (c.kind === "component" && new RegExp(`(^|/)${c.claim}\\.\\w+$`).test(f.rel) && loc === f.rel));
        scope = ` in ${loc}`;
      }
      const hit = pool.find(def) || (c.location && files.includes(c.location.replace(/^\.\//, "")) && new RegExp(`(^|/)${c.claim}\\.\\w+$`).test(c.location) ? { rel: c.location } : null);
      if (hit) { r.status = "matched"; r.evidence = [hit.rel]; }
      else if (c.kind === "component" || c.location) { r.status = "unmatched"; r.note = `${c.kind} ${c.claim} not defined${scope}`; }
      else r.note = "token naming may differ from the document (no documented location)";
    }
    res.push(r);
  }
  return res;
}

// ---------- reverse ----------
export function reverse(mode, root, files, dirs, code) {
  if (mode === "data") return extractTables(code).map(({ name, file, line, source }) => ({ name, file, line, source }));
  if (mode === "api") return extractRoutes(code).map(({ method, raw, file, line, source }) => ({ method, path: raw, file, line, source }));
  if (mode === "system") {
    // every manifest kind of every ecosystem in the definition (project files, dependency lists, build inputs), at any depth
    const globs = manifestGlobs();
    const manifests = files.filter((f) => matchesAny(f, globs));
    // directories to depth 2, plus every directory that holds a project file of an ecosystem, whatever its depth
    const projectGlobs = loadEcosystems().ecosystems.flatMap((e) => e.project_files);
    const projectDirs = new Set(files.filter((f) => f.includes("/") && matchesAny(f, projectGlobs)).map((f) => f.slice(0, f.lastIndexOf("/"))));
    const modules = dirs.filter((d) => d.split("/").length <= 2 || projectDirs.has(d)).map((d) => ({ dir: d, source_files: files.filter((f) => f.startsWith(d + "/") && CODE_EXT.has(extname(f))).length })).filter((m) => m.source_files > 0);
    return { manifests, modules };
  }
  if (mode === "ui") {
    const vars = [];
    for (const { rel, text } of code) text.split("\n").forEach((l, i) => { for (const m of l.matchAll(/(?:^|[\s{;])(--[\w-]+)\s*:/g)) vars.push({ name: m[1], file: rel, line: i + 1 }); });
    const components = files.filter((f) => /(^|\/)[A-Z][A-Za-z0-9]+\.(tsx|jsx|vue|svelte|razor|cshtml)$/.test(f)).map((f) => ({ name: basename(f).replace(/\.\w+$/, ""), file: f }));
    return { css_vars: vars, components };
  }
  return null;
}

// ---------- main ----------
export function run(opts) {
  const root = resolve(opts.root || ".");
  const { files, dirs } = walk(root);
  const configText = (() => { const p = opts.config ? resolve(opts.config) : join(root, ".agents/config.yaml"); try { return readFileSync(p, "utf8"); } catch { return ""; } })();
  const docsCfg = readDocConfig(configText);
  const flagMap = { data_model: opts.dataModel, architecture: opts.architecture, api: opts.api, design: opts.design };
  for (const r of ROLES) if (flagMap[r]) docsCfg[r] = flagMap[r];
  if (opts.design) { delete docsCfg.surfaces; delete docsCfg.shared; } // an explicit --design is one document, whatever the config says
  if (!opts.design) { const bad = checkSurfaces(docsCfg); if (bad.length) throw new Error(`design_docs.design: ${bad.join("; ")}`); }
  const designDocs = designDocList(docsCfg);
  let designSel = designDocs, surface = null;
  if (opts.file) {
    surface = resolveSurface(docsCfg, opts.file, root);
    if (surface.status === "overlap") throw new Error(surface.error);
    designSel = surface.docs;
  }
  const docRel = new Set([...ROLES.filter((r) => r !== "design").map((r) => docsCfg[r]), ...designDocs].filter(Boolean).map((p) => p.replace(/^\.\//, "")));
  const code = loadCode(root, files, docRel);
  if (opts.reverse) return { mode: "reverse", reverse: opts.reverse, facts: reverse(opts.reverse, root, files, dirs, code) };
  const facts = { tables: extractTables(code), routes: extractRoutes(code) };
  const docs = [], claims = [];
  const targets = [];
  for (const role of ROLES) {
    if (opts.only && opts.only !== role) continue;
    if (role === "design") for (const d of designSel) targets.push([role, d]);
    else if (docsCfg[role]) targets.push([role, docsCfg[role]]);
  }
  for (const [role, rel] of targets) {
    const abs = join(root, rel);
    const present = existsSync(abs) && statSync(abs).isFile();
    docs.push({ role, path: rel, present });
    if (!present) continue;
    const text = readFileSync(abs, "utf8");
    let raw = [];
    if (role === "data_model") raw = [...dataModelClaims(text), ...pathClaims(text)];
    else if (role === "architecture") raw = pathClaims(text);
    else if (role === "design") raw = [...designClaims(text), ...pathClaims(text)];
    else if (role === "api") raw = /\.(json|ya?ml)$/.test(rel) ? parseOpenApi(text).map((o) => ({ kind: "endpoint", claim: `${o.method} ${o.path}`, method: o.method, path: o.path, line: o.line })) : apiClaims(text);
    if (role === "design") { const named = new Set(raw.filter((c) => c.kind !== "path").map((c) => c.line)); raw = raw.filter((c) => c.kind !== "path" || !named.has(c.line)); }
    for (const c of evaluate(role, raw, { facts, code, files, dirs, root })) claims.push({ doc: rel, role, ...c });
  }
  const count = (s) => claims.filter((c) => c.status === s).length;
  const present = docs.filter((d) => d.present).length;
  const unmatched = claims.filter((c) => c.status === "unmatched");
  return {
    schema_version: 1,
    root,
    docs,
    code_facts: { tables: facts.tables.length, routes: facts.routes.length, files: files.length },
    claims,
    drift: unmatched.map((c) => `${c.doc}:${c.line} -> ${c.kind} ${c.claim}: ${c.note || "not found"}`),
    unverifiable: claims.filter((c) => c.status === "unverifiable").map((c) => `${c.doc}:${c.line} -> ${c.kind} ${c.claim}: ${c.note}`),
    summary: { matched: count("matched"), unmatched: count("unmatched"), unverifiable: count("unverifiable") },
    ...(surface ? { surface: { status: surface.status, name: surface.surface, mode: surface.visitorMode || "", warnings: surface.warnings } } : {}),
    verdict: !present ? "SKIPPED" : unmatched.length ? "FAIL" : "PASS",
  };
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const reverseMode = opt("--reverse");
  if (reverseMode && !["data", "api", "system", "ui"].includes(reverseMode)) { console.error("--reverse takes data|api|system|ui"); return 2; }
  if (opt("--only") && !ROLES.includes(opt("--only"))) { console.error(`--only takes ${ROLES.join("|")}`); return 2; }
  const root = resolve(opt("--root") || ".");
  if (!existsSync(root)) { console.error(`no such directory: ${root}`); return 2; }
  let out;
  try { out = run({ root, config: opt("--config"), reverse: reverseMode, only: opt("--only"), dataModel: opt("--data-model"), architecture: opt("--architecture"), api: opt("--api"), design: opt("--design"), file: opt("--file") }); } catch (e) { console.error(e.message); return 2; }
  console.log(JSON.stringify(out, null, 2));
  return argv.includes("--check") && out.verdict === "FAIL" ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
