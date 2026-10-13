#!/usr/bin/env node
// evidence-map `impact` mode: given changed symbols and/or files (or a git base ref), writes a
// machine-readable impact report: references per symbol (exact | textual | heuristic), affected files
// and modules, contracts and tests, plus the stated limits of static analysis. Dependency-free, read-only:
// it reads files and runs `git ls-files` / `git diff` / `git show` only, never project code.
// Usage: node impact.mjs [--repo DIR] [--symbol NAME[@path]]... [--file PATH]... [--base REF]
//                        [--out FILE] [--select symbols|files|modules|tests|contracts|references]
//        (--symbols a,b and --files a,b are comma-list forms). Report format: ../references/IMPACT.md.
// Exit codes: 0 report written, 2 usage or read error. The report is deterministic: same repository
// state and inputs give a byte-identical report (no timestamps).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, posix, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = 1;
export const KINDS = ["exact", "textual", "heuristic"];
export const ROLES = ["definition", "import", "reexport", "call", "reference", "comment", "string", "doc"];
export const TEXTUAL_ROLES = ["comment", "string", "doc"];
export const CHANGES = ["modified", "added", "removed", "deleted", "requested"];
export const TEST_RELATIONS = ["references-symbol", "imports-defining-module", "covers-affected-file"];
export const FORMATS = ["openapi", "asyncapi", "json-schema", "protobuf", "graphql", "avro", "thrift"];
export const FILE_REASONS = ["defines", "references-symbol", "imports-defining-module"];
export const LIMITS = [
  ["dynamic-dispatch", "Calls through interfaces, callbacks, function tables, event buses, dependency injection or route tables are invisible to text search; a reference reached only that way is missing."],
  ["reflection", "Reflection, eval, dynamic import and attribute lookup by name are not followed; sites that look like them are listed under unknown as dynamic-sites."],
  ["string-built-names", "A name assembled at runtime (concatenation, templates, config values) never matches the symbol text; such a reference is missing."],
  ["generated-code", "Generated files are searched like any other and marked generated: true; code that is generated from a contract or schema at build time and does not exist in the repository is not seen."],
  ["cross-repo-consumers", "Consumers outside this repository (other services, published packages, clients of a contract) cannot be found; their absence is unknown, never none."],
  ["unresolved-imports", "Only relative imports are resolved (python also by repository path suffix, go by package directory); bare specifiers, path aliases, workspace packages and build-time resolution are not, so a same-named identifier behind them is heuristic."],
  ["language-coverage", "Import resolution exists for JavaScript/TypeScript, Python and Go; elsewhere a code occurrence is heuristic. Default-export aliases, overloads and same-named members of different types are not told apart."],
  ["lexing", "Comments and strings are told from code by a small line-based scanner; regex literals, heredocs and unusual quoting can misclassify an occurrence."],
];
export const LIMIT_IDS = LIMITS.map((l) => l[0]);

const JS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"]);
const C_STYLE = new Set([...JS, "go", "java", "kt", "kts", "swift", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "scala", "dart", "php"]);
const HASH_STYLE = new Set(["py", "rb", "sh", "bash", "zsh", "pl", "r", "ex", "exs"]);
const MAX_BYTES = 1 << 20;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const rank = { exact: 0, heuristic: 1, textual: 2 };
const extOf = (p) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");
const isTest = (p) => /(^|\/)(tests?|__tests__|specs?|e2e)\//i.test(p) || /\.(test|spec)\.[^/]+$/.test(p) || /_test\.(go|py|rb|exs?)$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /Tests?\.(java|kt|cs|swift)$/.test(p);
const isGeneratedPath = (p) => /\.generated\.|\.pb\.go$|_pb2?\.py$|(^|\/)generated\//.test(p);
const norm = (s) => s.toLowerCase().replace(/[_-]/g, "");

function git(repo, args) {
  try { return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}

// Mask: 0 code, 1 comment, 2 string. Line-based scanner; single and double quotes end at the newline.
function lex(src, ext) {
  const hash = HASH_STYLE.has(ext);
  const m = new Uint8Array(src.length);
  const tpl = [];
  let depth = 0, i = 0;
  const n = src.length;
  const fill = (a, b, v) => m.fill(v, a, Math.min(b, n));
  while (i < n) {
    const c = src[i];
    if (!hash && c === "/" && src[i + 1] === "/") { let e = src.indexOf("\n", i); if (e < 0) e = n; fill(i, e, 1); i = e; continue; }
    if (!hash && c === "/" && src[i + 1] === "*") { let e = src.indexOf("*/", i + 2); e = e < 0 ? n : e + 2; fill(i, e, 1); i = e; continue; }
    if (hash && c === "#") { let e = src.indexOf("\n", i); if (e < 0) e = n; fill(i, e, 1); i = e; continue; }
    if (hash && (src.startsWith('"""', i) || src.startsWith("'''", i))) { let e = src.indexOf(src.slice(i, i + 3), i + 3); e = e < 0 ? n : e + 3; fill(i, e, 2); i = e; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      fill(i, j + 1, 2); i = j + 1; continue;
    }
    if (c === "`" && !hash) {
      let j = i + 1;
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "{") break;
        j++;
      }
      fill(i, j, 2);
      if (src[j] === "$") { tpl.push(depth); depth = 0; i = j + 2; } else i = j + 1;
      continue;
    }
    if (c === "{" && tpl.length) depth++;
    if (c === "}" && tpl.length) {
      if (depth === 0) { depth = tpl.pop(); let j = i + 1; while (j < n && src[j] !== "`") { if (src[j] === "\\") j++; else if (src[j] === "$" && src[j + 1] === "{") break; j++; } fill(i + 1, j, 2); if (src[j] === "$") { tpl.push(depth); depth = 0; i = j + 2; } else i = j + 1; continue; }
      depth--;
    }
    i++;
  }
  return m;
}

function names(list, sep) {
  const out = [];
  for (let part of list.split(",")) {
    part = part.replace(/\btype\s+/, "").trim();
    if (!part) continue;
    const mm = sep === ":" ? /^([\w$]+)\s*(?::\s*([\w$]+))?$/.exec(part) : /^([\w$]+|\*)(?:\s+as\s+([\w$]+))?$/.exec(part);
    if (mm) out.push({ imported: mm[1], local: mm[2] || mm[1] });
  }
  return out;
}

export function analyze(repoArg, opts = {}) {
  const repo = repoArg;
  const listed = git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  let paths = [];
  if (listed !== null) paths = listed.split("\0").filter(Boolean);
  else { const walk = (d, rel) => { for (const e of readdirSync(join(d), { withFileTypes: true })) { if ([".git", "node_modules", ".agents"].includes(e.name)) continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(join(d, e.name), r); else paths.push(r); } }; walk(repo, ""); }
  const files = [...new Set(paths)].filter((p) => { try { return statSync(join(repo, p)).isFile(); } catch { return false; } }).sort();
  const fileSet = new Set(files);
  const ghost = new Map();

  const cache = new Map();
  const load = (p) => {
    if (cache.has(p)) return cache.get(p);
    let fi = null;
    try {
      if (statSync(join(repo, p)).size <= MAX_BYTES) {
        const src = readFileSync(join(repo, p), "utf8");
        if (!src.slice(0, 8000).includes("\0")) {
          const ext = extOf(p);
          const code = C_STYLE.has(ext) || HASH_STYLE.has(ext);
          const starts = [0];
          for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
          fi = { path: p, src, ext, code, starts, mask: code ? lex(src, ext) : null, parsed: null, decls: null };
        }
      }
    } catch { /* unreadable: skipped */ }
    cache.set(p, fi);
    return fi;
  };
  const lineOf = (fi, off) => { let lo = 0, hi = fi.starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fi.starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
  const lineText = (fi, line) => { const s = fi.starts[line - 1]; const e = fi.src.indexOf("\n", s); return fi.src.slice(s, e < 0 ? undefined : e).trim().slice(0, 160); };

  function declsOf(fi, src = fi.src, mask = fi.mask) {
    const out = new Map();
    const add = (name, off) => { if (name && !out.has(name) && mask[off] === 0) out.set(name, src.slice(0, off).split("\n").length); };
    out.exported = new Set();
    if (JS.has(fi.ext)) for (const m of src.matchAll(/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?\s*|abstract\s+class\s+|class\s+|interface\s+|type\s+|enum\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/gm)) { add(m[1], m.index); if (m[0].startsWith("export")) out.exported.add(m[1]); }
    else if (fi.ext === "py") for (const m of src.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) add(m[1] || m[2], m.index);
    else if (fi.ext === "go") for (const m of src.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^type\s+([A-Za-z_]\w*)|^(?:var|const)\s+([A-Za-z_]\w*)/gm)) add(m[1] || m[2] || m[3], m.index);
    else {
      for (const m of src.matchAll(/\b(?:function|func|fn|def|class|struct|interface|trait|enum|record|object|module)\s+([A-Za-z_]\w*)/g)) add(m[1], m.index);
      for (const m of src.matchAll(/^[ \t]*(?:(?:public|private|protected|static|final|abstract|async|override|virtual|synchronized)\s+)+[\w<>[\],.? ]+?\s+([A-Za-z_]\w*)\s*\(/gm)) add(m[1], m.index);
    }
    return out;
  }
  const decls = (p) => { const fi = load(p); if (!fi || !fi.code) return new Map(); return (fi.decls ??= declsOf(fi)); };

  const JS_EXT = ["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".json"];
  function resolve(spec, from, lang) {
    if (lang === "go") return null;
    if (lang === "py") {
      const dots = /^\.*/.exec(spec)[0].length;
      const mod = spec.slice(dots).replace(/\./g, "/");
      const cands = (b) => [b ? `${b}.py` : null, b ? `${b}/__init__.py` : null].filter(Boolean);
      if (dots) {
        let d = posix.dirname(from);
        for (let k = 1; k < dots; k++) d = posix.dirname(d);
        const base = mod ? posix.join(d, mod) : posix.join(d, "__init__");
        for (const c of mod ? cands(base) : [`${base}.py`]) { const n = posix.normalize(c); if (fileSet.has(n)) return n; }
        return null;
      }
      for (const c of cands(mod)) { if (fileSet.has(c)) return c; const hit = files.find((f) => f.endsWith(`/${c}`)); if (hit) return hit; }
      return null;
    }
    if (!spec.startsWith(".")) return null;
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    const alt = base.replace(/\.(m|c)?js$/, "");
    for (const b of [base, alt]) for (const e of JS_EXT) for (const c of [b + e, `${b}/index${e}`]) if (e !== "" || c === b) { if (fileSet.has(c) && c !== from) return c; }
    return null;
  }

  function parsed(p) {
    const fi = load(p);
    if (!fi) return { imports: [], reexports: [] };
    if (fi.parsed) return fi.parsed;
    const { src, mask } = fi;
    const imports = [], reexports = [];
    const ok = (m) => !fi.code || mask[m.index] === 0;
    const R = (spec) => resolve(spec, p, fi.ext === "py" ? "py" : fi.ext === "go" ? "go" : "js");
    if (JS.has(fi.ext)) {
      for (const m of src.matchAll(/\bimport\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+([A-Za-z_$][\w$]*))?\s*from\s*['"]([^'"\n]+)['"]/g)) {
        if (!ok(m)) continue;
        const ns = []; if (m[1]) ns.push({ imported: "default", local: m[1] }); if (m[2]) ns.push(...names(m[2]));
        imports.push({ spec: m[4], to: R(m[4]), names: ns, ns: m[3] || null, start: m.index, end: m.index + m[0].length });
      }
      for (const m of src.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]/g)) if (ok(m)) reexports.push({ spec: m[2], to: R(m[2]), names: names(m[1]).map((n) => ({ imported: n.imported, local: n.local })), start: m.index, end: m.index + m[0].length });
      for (const m of src.matchAll(/\bexport\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"\n]+)['"]/g)) if (ok(m)) reexports.push({ spec: m[2], to: R(m[2]), star: !m[1], names: [], start: m.index, end: m.index + m[0].length });
      for (const m of src.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*(?![\s]*from)/g)) if (ok(m)) reexports.push({ spec: null, to: null, names: names(m[1]), start: m.index, end: m.index + m[0].length });
      for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)/g)) if (ok(m)) imports.push({ spec: m[2], to: R(m[2]), names: names(m[1], ":"), ns: null, start: m.index, end: m.index + m[0].length });
      for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)/g)) if (ok(m)) imports.push({ spec: m[2], to: R(m[2]), names: [], ns: m[1], start: m.index, end: m.index + m[0].length });
    } else if (fi.ext === "py") {
      for (const m of src.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
        if (!ok(m)) continue;
        const to = R(m[1]);
        const ns = names(m[2].replace(/[()]/g, " ").replace(/#[^\n]*/g, "").replace(/\n/g, " "));
        const subs = [];
        if (/^\.+$/.test(m[1])) for (const n of ns) { const sub = R(m[1] + n.imported); if (sub) subs.push({ local: n.local, to: sub }); }
        imports.push({ spec: m[1], to, names: ns, ns: null, subs, start: m.index, end: m.index + m[0].length });
      }
      for (const m of src.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) if (ok(m)) imports.push({ spec: m[1], to: R(m[1]), names: [], ns: m[2] || null, start: m.index, end: m.index + m[0].length });
    } else if (fi.ext === "go") {
      const add = (alias, path, off, end) => { if (alias !== "_") imports.push({ spec: path, to: null, names: [], ns: alias && alias !== "." ? alias : path.split("/").pop(), goPath: path, start: off, end }); };
      for (const m of src.matchAll(/^\s*import\s+(?:([\w.]+)\s+)?"([^"]+)"/gm)) add(m[1], m[2], m.index, m.index + m[0].length);
      for (const b of src.matchAll(/^\s*import\s*\(([\s\S]*?)\n\)/gm)) for (const m of b[1].matchAll(/^\s*(?:([\w.]+)\s+)?"([^"]+)"/gm)) add(m[1], m[2], b.index, b.index + b[0].length);
    }
    return (fi.parsed = { imports, reexports });
  }

  // Which file declares `name` when imported from `r` (following re-exports): {file, name, via} or null.
  function exportsSymbol(r, name, seen = new Set(), via = []) {
    if (!r || via.length > 8 || seen.has(`${r}\0${name}`)) return null;
    seen.add(`${r}\0${name}`);
    if (decls(r).has(name) || ghost.get(r)?.has(name)) return { file: r, name, via };
    const pr = parsed(r);
    const next = [...via, r];
    for (const re of pr.reexports) {
      if (re.star) { const s = exportsSymbol(re.to, name, seen, next); if (s) return s; continue; }
      for (const n of re.names) {
        if (n.local !== name) continue;
        let to = re.to, src = n.imported;
        if (re.spec === null) { const im = pr.imports.find((i) => i.names.some((x) => x.local === n.imported)); if (!im) continue; to = im.to; src = im.names.find((x) => x.local === n.imported).imported; }
        const s = exportsSymbol(to, src, seen, next); if (s) return s;
      }
    }
    if (extOf(r) === "py") for (const im of pr.imports) for (const n of im.names) {
      if (n.imported === "*") { const s = exportsSymbol(im.to, name, seen, next); if (s) return s; } else if (n.local === name) { const s = exportsSymbol(im.to, n.imported, seen, next); if (s) return s; }
    }
    return null;
  }

  // ---- contracts
  const contractFormat = (p) => {
    if (isTest(p)) return null;
    const e = extOf(p);
    if (e === "proto") return "protobuf";
    if (["graphql", "graphqls", "gql"].includes(e)) return "graphql";
    if (e === "avsc") return "avro";
    if (e === "thrift") return "thrift";
    if (/\.schema\.json$/i.test(p)) return "json-schema";
    if (!["json", "yaml", "yml"].includes(e)) return null;
    const fi = load(p);
    if (!fi) return null;
    const head = fi.src.slice(0, 4000);
    const key = /^\s*["']?(openapi|swagger|asyncapi)["']?\s*:/im.exec(head);
    if (key) return key[1].toLowerCase() === "asyncapi" ? "asyncapi" : "openapi";
    if (/"\$schema"\s*:\s*"[^"]*json-schema/.test(head) || /^\$schema:\s*\S*json-schema/m.test(head)) return "json-schema";
    return null;
  };
  const contractFiles = files.filter((p) => contractFormat(p));

  // ---- inputs
  const reqSymbols = [], changed = new Map();
  const base = opts.base || null;
  const inFiles = [...(opts.files || [])];
  for (const s of opts.symbols || []) { const [name, at] = s.split("@"); reqSymbols.push({ name, path: at || null, change: "requested" }); }
  const note = [];
  if (base) {
    const dif = git(repo, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", base]);
    if (dif === null) throw new Error(`git diff against ${base} failed (not a git repository, or unknown ref)`);
    let cur = null;
    for (const line of dif.split("\n")) {
      if (line.startsWith("--- ")) { const f = line.slice(4); cur = { old: f === "/dev/null" ? null : f.replace(/^a\//, ""), ranges: [] }; continue; }
      if (line.startsWith("+++ ") && cur) { const f = line.slice(4); cur.path = f === "/dev/null" ? null : f.replace(/^b\//, ""); changed.set(cur.path || cur.old, cur); continue; }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (h && cur) { const a = +h[1], c = h[2] === undefined ? 1 : +h[2]; cur.ranges.push([a, Math.max(a, a + c - 1)]); }
    }
    for (const p of (git(repo, ["ls-files", "-z", "--others", "--exclude-standard"]) || "").split("\0").filter(Boolean)) if (!changed.has(p)) changed.set(p, { old: null, path: p, ranges: [[1, 1e9]] });
  }
  for (const f of inFiles) if (!changed.has(f)) changed.set(f, { old: f, path: f, ranges: [[1, 1e9]], explicit: true });

  // symbols to analyse: { name, member, change, defined_in:[{path,line}] }
  const symMap = new Map();
  const addSym = (name, change, def) => {
    const k = name;
    const s = symMap.get(k) || { name, change, defined_in: [] };
    if (def && !s.defined_in.some((d) => d.path === def.path)) s.defined_in.push(def);
    if (change !== "requested" && s.change === "requested") s.change = change;
    symMap.set(k, s);
  };
  const changedFiles = [];
  for (const [p, c] of [...changed].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = { path: p, change: c.path === null ? "deleted" : c.old === null ? "added" : "modified", symbols: [], file_level_change: false, dependents: [] };
    const fi = c.path ? load(c.path) : null;
    const baseSrc = c.old && base ? git(repo, ["show", `${base}:${c.old}`]) : null;
    const oldFi = baseSrc !== null ? { ext: extOf(c.old), code: C_STYLE.has(extOf(c.old)) || HASH_STYLE.has(extOf(c.old)), src: baseSrc } : null;
    if (fi && fi.code) {
      const dm = [...decls(c.path)].sort((a, b) => a[1] - b[1]);
      const lines = fi.starts.length;
      const touched = new Set();
      dm.forEach(([name, line], i) => {
        const end = i + 1 < dm.length ? dm[i + 1][1] - 1 : lines;
        if (c.ranges.some(([a, b]) => a <= end && b >= line)) touched.add(name);
      });
      const first = dm.length ? dm[0][1] : lines + 1;
      row.file_level_change = c.ranges.some(([a, b]) => a < first && b >= 1) && !c.explicit;
      const dd = decls(c.path);
      const pub = (n) => (JS.has(fi.ext) ? dd.exported.has(n) : fi.ext === "py" ? !n.startsWith("_") : fi.ext === "go" ? /^[A-Z]/.test(n) : true);
      for (const name of [...touched].sort()) {
        if (c.explicit && !pub(name)) continue; row.symbols.push(name); addSym(name, c.old === null ? "added" : "modified", { path: c.path, line: dm.find((d) => d[0] === name)[1] }); }
    }
    if (oldFi && oldFi.code) {
      const om = declsOf({ ext: oldFi.ext }, oldFi.src, lex(oldFi.src, oldFi.ext));
      const cur = fi && fi.code ? decls(c.path) : new Map();
      for (const [name, line] of om) if (!cur.has(name) && !row.symbols.includes(name)) { row.symbols.push(name); addSym(name, c.path === null ? "deleted" : "removed", { path: c.old, line }); }
    }
    row.symbols.sort();
    const cf = contractFormat(p);
    if (cf) row.contract = cf;
    changedFiles.push(row);
  }
  for (const r of reqSymbols) {
    if (r.path) { const d = decls(r.path).get(r.name.split(/[.#]/)[0]); addSym(r.name, "requested", d ? { path: r.path, line: d } : null); if (!d) note.push(`${r.name}: no declaration found in ${r.path}`); }
    else {
      const head = r.name.split(/[.#]/)[0];
      const hits = files.filter((f) => decls(f).has(head));
      addSym(r.name, "requested", null);
      for (const f of hits) addSym(r.name, "requested", { path: f, line: decls(f).get(head) });
      if (!hits.length) note.push(`${r.name}: no declaration found in the repository`);
    }
  }
  for (const s of symMap.values()) s.defined_in.sort((a, b) => a.path.localeCompare(b.path));
  const symbols = [...symMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  // a removed or deleted symbol no longer has a declaration: its old place still binds the callers
  for (const sy of symbols) if (sy.change === "removed" || sy.change === "deleted") for (const d of sy.defined_in) { fileSet.add(d.path); (ghost.get(d.path) || ghost.set(d.path, new Set()).get(d.path)).add(sy.name); }
  const bad = symbols.filter((s) => !IDENT.test(s.name.split(/[.#]/).pop()) || s.name.split(/[.#]/).some((x) => !IDENT.test(x)));
  if (bad.length) throw new Error(`not an identifier: ${bad.map((s) => s.name).join(", ")}`);

  // ---- references per symbol
  const codeFiles = files.filter((p) => load(p));
  const changedContractPaths = new Set(changedFiles.filter((r) => r.contract).map((r) => r.path));
  const out = [];
  for (const sym of symbols) {
    const member = /[.#]/.test(sym.name);
    const word = sym.name.split(/[.#]/).pop();
    const wordRe = new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
    const Dset = new Set(sym.defined_in.map((d) => d.path));
    const declLine = new Map(sym.defined_in.map((d) => [d.path, d.line]));
    const refs = new Map(), homs = new Map();
    const put = (fi, off, kind, role, extra = {}) => {
      const line = lineOf(fi, off);
      const k = `${fi.path}:${line}`;
      const prev = refs.get(k);
      const row = { path: fi.path, line, kind, role, text: lineText(fi, line), ...extra };
      if (isGeneratedPath(fi.path) || /@generated|DO NOT EDIT|auto-?generated|Code generated/i.test(fi.src.slice(0, 400))) row.generated = true;
      if (!prev || rank[kind] < rank[prev.kind]) refs.set(k, row);
    };
    const hom = (fi, off, reason, definedIn) => { const line = lineOf(fi, off); homs.set(`${fi.path}:${line}`, { path: fi.path, line, text: lineText(fi, line), reason, defined_in: definedIn }); };
    const importers = new Set();
    for (const p of codeFiles) {
      if (contractFormat(p)) continue;
      const fi = load(p);
      const occ = [...fi.src.matchAll(wordRe)].map((m) => m.index);
      const pr = parsed(p);
      // bindings of this symbol in this file
      const locals = new Set(), nsLocals = new Set(), stmts = [];
      let unresolved = false, otherImport = null;
      if (fi.code) {
        const handle = (stmt, list, isRe) => {
          for (const n of list) {
            if (n.imported === "*") { const s = exportsSymbol(stmt.to, word); if (s && s.name === word && Dset.has(s.file)) { locals.add(word); stmts.push(stmt); } continue; }
            const s = stmt.to ? exportsSymbol(stmt.to, n.imported) : null;
            if (s && s.name === word && Dset.has(s.file)) { if (!isRe) locals.add(n.local); stmts.push({ ...stmt, via: s.via }); }
            else if (n.imported === word) { if (!stmt.to) { unresolved = true; stmts.push({ ...stmt, unresolved: true }); } else { otherImport = s ? s.file : stmt.to; stmts.push({ ...stmt, homonym: true }); } }
          }
        };
        for (const st of pr.imports) {
          if (st.to && Dset.has(st.to)) importers.add(p);
          handle(st, st.names, false);
          if (st.ns && st.to) { const s = exportsSymbol(st.to, word); if (s && s.name === word && Dset.has(s.file)) nsLocals.add(st.ns); }
          if (st.goPath && fi.ext === "go") for (const d of Dset) { const dir = posix.dirname(d); if (st.goPath === dir || st.goPath.endsWith(`/${dir}`)) { nsLocals.add(st.ns); importers.add(p); } }
          for (const sb of st.subs || []) { const s = exportsSymbol(sb.to, word); if (s && s.name === word && Dset.has(s.file)) nsLocals.add(sb.local); }
        }
        for (const re of pr.reexports) { if (re.to && Dset.has(re.to)) importers.add(p); if (re.spec !== null && !re.star) handle(re, re.names, true); }
      }
      const inStmt = (off) => stmts.find((s) => off >= s.start && off < s.end);
      const declares = fi.code && decls(p).has(word) && !Dset.has(p);
      const goSamePkg = fi.ext === "go" && [...Dset].some((d) => posix.dirname(d) === posix.dirname(p));
      // a file whose code binds the name to another definition: its comments and strings are about that one
      const homFile = fi.code && !Dset.has(p) && !locals.size && !nsLocals.size && !goSamePkg && (declares || otherImport) && !stmts.some((s) => !s.homonym && !s.unresolved);
      for (const off of occ) {
        if (homFile && fi.mask[off]) { hom(fi, off, "text-in-file-bound-to-other-definition", otherImport || p); continue; }
        if (!fi.code) { if (!contractFormat(p)) put(fi, off, "textual", "doc"); continue; }
        const mk = fi.mask[off];
        if (mk) { put(fi, off, "textual", mk === 1 ? "comment" : "string"); continue; }
        const st = inStmt(off);
        const prev = fi.src.slice(Math.max(0, off - 64), off);
        const q = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(prev);
        const nsHit = q && nsLocals.has(q[1]);
        const after = /^\s*\(/.test(fi.src.slice(off + word.length, off + word.length + 20));
        const roleAt = () => (st && !st.homonym ? (pr.reexports.includes(st) || pr.reexports.some((r) => r.start === st.start) ? "reexport" : "import") : declLine.get(p) === lineOf(fi, off) ? "definition" : after ? "call" : "reference");
        if (st && st.homonym) { hom(fi, off, "imports-other-definition", otherImport); continue; }
        if (st && st.unresolved) { put(fi, off, "heuristic", "import", { note: "import not resolved (bare specifier or alias)" }); continue; }
        if (st) { put(fi, off, member ? "heuristic" : "exact", roleAt(), st.via && st.via.length ? { via: st.via } : {}); continue; }
        if (nsHit) { put(fi, off, member ? "heuristic" : "exact", after ? "call" : "reference"); continue; }
        if (q && !Dset.has(p) && !locals.has(word)) { put(fi, off, "heuristic", after ? "call" : "reference", { note: "member access, receiver not resolved" }); continue; }
        if (Dset.has(p) || locals.has(word) || goSamePkg) { put(fi, off, member ? "heuristic" : "exact", roleAt()); continue; }
        if (declares) { hom(fi, off, "declares-own", p); continue; }
        if (otherImport) { hom(fi, off, "imports-other-definition", otherImport); continue; }
        put(fi, off, "heuristic", after ? "call" : "reference", { note: unresolved ? "import not resolved (bare specifier or alias)" : "no import binding resolved" });
      }
      // aliases: `import { sym as hold }` binds a different local name
      for (const L of locals) {
        if (L === word) continue;
        const re = new RegExp(`(?<![\\w$.])${L.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
        for (const m of fi.src.matchAll(re)) {
          const mk = fi.mask[m.index];
          if (mk) continue;
          if (inStmt(m.index)) continue;
          const after = /^\s*\(/.test(fi.src.slice(m.index + L.length, m.index + L.length + 20));
          const st = stmts.find((s) => !s.homonym && !s.unresolved);
          put(fi, m.index, "exact", after ? "call" : "reference", { local: L, ...(st && st.via && st.via.length ? { via: st.via } : {}) });
        }
      }
    }
    // dependents of the defining file(s) that never name the symbol
    const refRows = [...refs.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    const truncated = refRows.length > (opts.maxRefs || 1000);
    const references = truncated ? refRows.slice(0, opts.maxRefs || 1000) : refRows;
    // files
    const fmap = new Map();
    const addFile = (p, reason, kind) => {
      if (isTest(p) || contractFormat(p)) return;
      const e = fmap.get(p) || { path: p, module: posix.dirname(p), reasons: [], kind: "textual" };
      if (!e.reasons.includes(reason)) e.reasons.push(reason);
      if (rank[kind] < rank[e.kind]) e.kind = kind;
      fmap.set(p, e);
    };
    for (const d of Dset) addFile(d, "defines", "exact");
    for (const r of references) if (!TEXTUAL_ROLES.includes(r.role) && r.kind !== "textual") addFile(r.path, "references-symbol", r.kind);
    for (const p of importers) addFile(p, "imports-defining-module", "exact");
    const affected = [...fmap.values()].sort((a, b) => a.path.localeCompare(b.path)).map((e) => ({ ...e, reasons: e.reasons.sort() }));
    // tests
    const tmap = new Map();
    const addTest = (p, relation, kind, line) => {
      const e = tmap.get(p) || { path: p, relation, kind, lines: [] };
      if (TEST_RELATIONS.indexOf(relation) < TEST_RELATIONS.indexOf(e.relation) || (relation === e.relation && rank[kind] < rank[e.kind])) { e.relation = relation; e.kind = kind; }
      if (line && !e.lines.includes(line)) e.lines.push(line);
      tmap.set(p, e);
    };
    for (const r of refRows) if (isTest(r.path)) addTest(r.path, "references-symbol", r.kind, r.line);
    for (const p of importers) if (isTest(p)) addTest(p, "imports-defining-module", "exact", 0);
    const affectedSet = new Set(affected.map((a) => a.path));
    for (const p of codeFiles) {
      if (!isTest(p) || tmap.has(p)) continue;
      const pr = parsed(p);
      for (const st of [...pr.imports, ...pr.reexports]) if (st.to && affectedSet.has(st.to)) { addTest(p, "covers-affected-file", "heuristic", 0); break; }
    }
    const tests = [...tmap.values()].sort((a, b) => a.path.localeCompare(b.path)).map((t) => ({ ...t, lines: t.lines.filter(Boolean).sort((a, b) => a - b) }));
    // contracts that mention the symbol
    const contracts = [];
    for (const p of contractFiles) {
      const fi = load(p);
      if (!fi) continue;
      let best = null;
      for (const m of fi.src.matchAll(/[A-Za-z_][\w-]*/g)) {
        const t = m[0];
        const k = t === word ? "textual" : norm(t) === norm(word) ? "heuristic" : null;
        if (!k) continue;
        if (!best || rank[k] < rank[best.kind]) best = { path: p, format: contractFormat(p), kind: k, line: lineOf(fi, m.index), text: lineText(fi, lineOf(fi, m.index)) };
        if (best.kind === "textual") break;
      }
      if (best) contracts.push(best);
    }
    out.push({
      name: sym.name, change: sym.change, defined_in: sym.defined_in, references, truncated,
      excluded_homonyms: [...homs.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
      files: affected, modules: [...new Set(affected.map((a) => a.module))].sort(), contracts, tests,
    });
  }

  // ---- changed files: dependents, tests
  const importGraph = new Map();
  for (const p of codeFiles) for (const st of [...parsed(p).imports, ...parsed(p).reexports]) if (st.to) { if (!importGraph.has(st.to)) importGraph.set(st.to, new Set()); importGraph.get(st.to).add(p); }
  for (const r of changedFiles) r.dependents = [...(importGraph.get(r.path) || [])].sort();

  // ---- union
  const uFiles = new Map();
  for (const s of out) for (const f of s.files) { const e = uFiles.get(f.path) || { path: f.path, module: f.module, symbols: [], kind: f.kind }; e.symbols.push(s.name); if (rank[f.kind] < rank[e.kind]) e.kind = f.kind; uFiles.set(f.path, e); }
  const uTests = new Map();
  for (const s of out) for (const t of s.tests) { const e = uTests.get(t.path) || { path: t.path, relation: t.relation, kind: t.kind, symbols: [] }; e.symbols.push(s.name); if (TEST_RELATIONS.indexOf(t.relation) < TEST_RELATIONS.indexOf(e.relation)) { e.relation = t.relation; e.kind = t.kind; } uTests.set(t.path, e); }
  const uContracts = new Map();
  for (const s of out) for (const c of s.contracts) { const e = uContracts.get(c.path) || { path: c.path, format: c.format, changed: changedContractPaths.has(c.path), symbols: [] }; e.symbols.push({ name: s.name, kind: c.kind, line: c.line }); uContracts.set(c.path, e); }
  for (const p of changedContractPaths) if (!uContracts.has(p)) uContracts.set(p, { path: p, format: contractFormat(p), changed: true, symbols: [] });
  const files_affected = [...uFiles.values()].sort((a, b) => a.path.localeCompare(b.path));
  const modMap = new Map();
  for (const f of files_affected) (modMap.get(f.module) || modMap.set(f.module, []).get(f.module)).push(f.path);
  const modules = [...modMap].sort((a, b) => a[0].localeCompare(b[0])).map(([path, fs]) => ({ path, files: fs }));

  // ---- unknown
  const unknown = [{ id: "cross-repo-consumers", status: "unknown", text: LIMITS.find((l) => l[0] === "cross-repo-consumers")[1] }];
  if (symbols.length) {
    const sites = [];
    const sig = /\beval\s*\(|\bnew\s+Function\b|\bReflect\.(?:get|apply|construct|has)\b|\bgetattr\s*\(|\b__import__\b|\bimportlib\.import_module\b|\bClass\.forName\b|\.getMethod\(|\breflect\.(?:ValueOf|TypeOf)\b|\bglobals\(\)\s*\[|\[[^\]\n]*["'`]\s*\+[^\]\n]*\]|\[[^\]\n]*\+\s*["'`][^\]\n]*\]|\bimport\(\s*[^'"`\s)]/g;
    for (const p of codeFiles) {
      const fi = load(p);
      if (!fi.code || isTest(p)) continue;
      for (const m of fi.src.matchAll(sig)) if (fi.mask[m.index] === 0) sites.push({ path: p, line: lineOf(fi, m.index), signal: m[0].trim().slice(0, 40) });
    }
    if (sites.length) unknown.push({ id: "dynamic-sites", status: "unknown", text: "Code that selects a callee by a runtime value; it may or may not reach a changed symbol.", sites: sites.slice(0, 50) });
  }

  // ---- tools (detected only)
  const detected = [];
  for (const t of ["tsc", "pyright", "gopls", "rust-analyzer"]) {
    const dirs = [join(repo, "node_modules/.bin"), ...(process.env.PATH || "").split(delimiter)];
    const hit = dirs.find((d) => d && existsSync(join(d, t)));
    if (hit) detected.push({ name: t, location: hit === join(repo, "node_modules/.bin") ? "project" : "machine" });
  }

  const count = { exact: 0, textual: 0, heuristic: 0 };
  for (const s of out) for (const r of s.references) count[r.kind]++;
  const head = git(repo, ["rev-parse", "HEAD"]);
  return {
    version: VERSION, kind: "impact-report", tool: "evidence-map/impact",
    repo: { head: head ? head.trim() : null, base },
    inputs: { symbols: reqSymbols.map((r) => (r.path ? `${r.name}@${r.path}` : r.name)), files: inFiles.sort(), base },
    analysis: {
      method: "text-search+import-graph",
      resolution_languages: ["javascript", "typescript", "python", "go"],
      tools: { detected, used: [], note: detected.length ? "detected on this machine but not invoked: the report resolves by text and the import graph only" : "no language server or analysis tool detected; nothing installed" },
    },
    limits: LIMITS.map(([id, text]) => ({ id, text })),
    changed_files: changedFiles,
    symbols: out,
    files_affected, modules,
    contracts: [...uContracts.values()].sort((a, b) => a.path.localeCompare(b.path)),
    tests: [...uTests.values()].sort((a, b) => a.path.localeCompare(b.path)),
    unknown,
    notes: note,
    summary: { symbols: out.length, references: count, files: files_affected.length, modules: modules.length, contracts: uContracts.size, tests: uTests.size },
  };
}

function main(argv) {
  const o = { repo: process.cwd(), symbols: [], files: [] };
  let outFile = null, select = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === "--repo") o.repo = v();
    else if (a === "--symbol") o.symbols.push(v());
    else if (a === "--symbols") o.symbols.push(...String(v()).split(",").filter(Boolean));
    else if (a === "--file") o.files.push(v());
    else if (a === "--files") o.files.push(...String(v()).split(",").filter(Boolean));
    else if (a === "--base") o.base = v();
    else if (a === "--out") outFile = v();
    else if (a === "--select") select = v();
    else { console.error(`unknown argument: ${a}`); return 2; }
  }
  if (!o.symbols.length && !o.files.length && !o.base) { console.error("usage: impact.mjs [--repo DIR] [--symbol NAME[@path]]... [--file PATH]... [--base REF] [--out FILE] [--select symbols|files|modules|tests|contracts|references]"); return 2; }
  let report;
  try { report = analyze(o.repo, o); } catch (e) { console.error(`impact: ${e.message}`); return 2; }
  if (select) {
    const rows = { symbols: () => report.symbols.map((s) => s.name), files: () => report.files_affected.map((f) => f.path), modules: () => report.modules.map((m) => m.path), tests: () => report.tests.map((t) => t.path), contracts: () => report.contracts.map((c) => c.path), references: () => report.symbols.flatMap((s) => s.references.map((r) => `${r.path}:${r.line}`)) }[select];
    if (!rows) { console.error(`unknown --select ${select}`); return 2; }
    process.stdout.write([...new Set(rows())].map((l) => `${l}\n`).join(""));
    return 0;
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outFile) writeFileSync(outFile, json); else process.stdout.write(json);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
