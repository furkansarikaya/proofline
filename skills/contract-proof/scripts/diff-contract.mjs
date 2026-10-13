#!/usr/bin/env node
// contract-proof built-in structural differ. Dependency-free, read-only (file reads and
// `git diff`, `git show`, `git ls-files`); never runs project code, installs nothing.
// Compares the base and head state of API, event and data contract files and classifies every change
// with a rule id of ../references/RULES.md. Formats: OpenAPI / Swagger, AsyncAPI and JSON Schema in
// JSON or a safe YAML subset; GraphQL SDL and protobuf with a conservative line-level parser. Anything
// it cannot parse is `status: unsupported` (never a pass).
//
// Usage:
//   node diff-contract.mjs --repo DIR --base REF [--path P]... [--plan PLAN.md] [--impact impact.json] [--out FILE]
//   node diff-contract.mjs --base-file OLD --head-file NEW [--name P] [--plan PLAN.md]
// Prints (or writes) the draft contract report (schema ../schema/contract.schema.json, version 1).
// Exit 0 on success, 2 on a usage error or an unreadable input.
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, extname, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

// ---- rules (RULES.md is the prose; this table is what the scripts enforce) ------------------------
export const RULES = {
  "CP-B01": ["breaking", "operation, path, channel, type, message, service or rpc removed"],
  "CP-B02": ["breaking", "field or property removed"],
  "CP-B03": ["breaking", "type changed or narrowed (request), widened (response), or a media type removed"],
  "CP-B04": ["breaking", "optional became required on the request side, or required became optional on the response side"],
  "CP-B05": ["breaking", "new required request field or parameter without a usable default"],
  "CP-B06": ["breaking", "enum value or union member removed"],
  "CP-B07": ["breaking", "parameter, header or argument removed"],
  "CP-B08": ["breaking", "response status code removed"],
  "CP-B09": ["breaking", "constraint narrowed on the request side or relaxed on the response side"],
  "CP-B10": ["breaking", "protobuf field or enum number changed"],
  "CP-N01": ["non-breaking", "optional field, property or parameter added, or a field added on the response side"],
  "CP-N02": ["non-breaking", "operation, path, channel, type, message, service or rpc added"],
  "CP-N03": ["non-breaking", "enum value or union member added on the request side"],
  "CP-N04": ["non-breaking", "enum value or union member added where consumers read it: only for consumers that tolerate unknown values"],
  "CP-N05": ["non-breaking", "documentation or metadata only"],
  "CP-N06": ["non-breaking", "requirement, type or constraint loosened on the request side, or tightened on the response side"],
  "CP-N07": ["non-breaking", "response status code added: only for consumers that handle unknown codes"],
  "CP-N08": ["non-breaking", "deprecation marker added or removed; the element still exists"],
  "CP-N09": ["non-breaking", "protobuf reserved entry added"],
  "CP-N10": ["non-breaking", "non-null GraphQL argument or input field added with a default value"],
  "CP-U01": ["needs-review", "a change no rule classifies; treated as breaking until classified"],
};
export const BLOCKING_CLASSES = ["breaking", "needs-review"];
export const COVER_KEYWORD = /\b(version(ed|ing)?|migrat(e|ed|es|ing|ion)|deprecat(e|ed|es|ing|ion))\b/i;
export const TOOLS = [
  { name: "oasdiff", formats: ["openapi"] },
  { name: "openapi-diff", formats: ["openapi"] },
  { name: "buf", formats: ["proto"] },
  { name: "graphql-inspector", formats: ["graphql"] },
  { name: "asyncapi", formats: ["asyncapi"] },
];

class Unsupported extends Error {}
const unsup = (msg) => { throw new Unsupported(msg); };

// ---- line bookkeeping: lineOf(container, key) ---------------------------------------------------
const LINES = new WeakMap();
const setLine = (obj, key, line) => { let m = LINES.get(obj); if (!m) LINES.set(obj, (m = new Map())); m.set(String(key), line); };
const lineOf = (obj, key) => (obj && typeof obj === "object" ? LINES.get(obj)?.get(String(key)) : undefined);

// ---- JSON with line numbers ---------------------------------------------------------------------
export function parseJson(text) {
  let i = 0, line = 1;
  const ws = () => { for (; i < text.length; i++) { const c = text[i]; if (c === "\n") line++; else if (c !== " " && c !== "\t" && c !== "\r") break; } };
  const str = () => {
    const s = i; i++;
    for (; i < text.length && text[i] !== '"'; i++) { if (text[i] === "\\") i++; if (text[i] === "\n") unsup(`newline in string at line ${line}`); }
    if (i >= text.length) unsup("unterminated string"); i++;
    return JSON.parse(text.slice(s, i));
  };
  const val = () => {
    ws(); const c = text[i];
    if (c === "{") {
      i++; const o = {}; ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') unsup(`expected a key at line ${line}`);
        const kl = line, k = str(); ws(); if (text[i] !== ":") unsup(`expected ':' at line ${line}`); i++;
        o[k] = val(); setLine(o, k, kl); ws();
        if (text[i] === ",") { i++; continue; } if (text[i] === "}") { i++; return o; }
        unsup(`expected ',' or '}' at line ${line}`);
      }
    }
    if (c === "[") {
      i++; const a = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) {
        ws(); const l = line; a.push(val()); setLine(a, a.length - 1, l); ws();
        if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; }
        unsup(`expected ',' or ']' at line ${line}`);
      }
    }
    if (c === '"') return str();
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) unsup(`unexpected token at line ${line}`);
    i += m[0].length; return JSON.parse(m[0]);
  };
  const v = val(); ws();
  if (i < text.length) unsup(`trailing content at line ${line}`);
  return v;
}

// ---- safe YAML subset with line numbers ---------------------------------------------------------
// Supported: block mappings and sequences, plain/single/double-quoted scalars, flow [..] and {..} on one
// line, block scalars | and >, comments, one leading `---`. Anything else (anchors, aliases, tags, merge
// keys, complex keys, multi-documents, multi-line plain or flow scalars) is Unsupported.
// shortcut: no anchors/aliases/tags; a project that uses them gets UNSUPPORTED, upgrade by resolving aliases here.
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; } else if (q === '"' && c === "\\") i++; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1]))) q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}
function yamlScalar(raw, ln) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s[0] === '"') { if (!s.endsWith('"') || s.length < 2) unsup(`unterminated string at line ${ln}`); try { return JSON.parse(s); } catch { unsup(`unsupported escape at line ${ln}`); } }
  if (s[0] === "'") { if (!s.endsWith("'") || s.length < 2) unsup(`unterminated string at line ${ln}`); return s.slice(1, -1).replace(/''/g, "'"); }
  if (/^[&*!|>%@`]/.test(s)) unsup(`anchor, alias, tag or reserved indicator at line ${ln}`);
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(s)) return Number(s);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/\s#/.test(s) || /:\s/.test(s)) unsup(`ambiguous plain scalar at line ${ln}`);
  return s;
}
function yamlFlow(s, ln) {
  let i = 0;
  const skip = () => { while (s[i] === " ") i++; };
  const item = (closers) => {
    skip();
    if (s[i] === "[") { i++; const a = []; skip(); if (s[i] === "]") { i++; return a; } for (;;) { a.push(item(",]")); setLine(a, a.length - 1, ln); skip(); if (s[i] === ",") { i++; continue; } if (s[i] === "]") { i++; return a; } unsup(`bad flow sequence at line ${ln}`); } }
    if (s[i] === "{") {
      i++; const o = {}; skip(); if (s[i] === "}") { i++; return o; }
      for (;;) {
        const k = String(item(":,}")); skip(); if (s[i] !== ":") unsup(`bad flow mapping at line ${ln}`); i++;
        o[k] = item(",}"); setLine(o, k, ln); skip();
        if (s[i] === ",") { i++; continue; } if (s[i] === "}") { i++; return o; } unsup(`bad flow mapping at line ${ln}`);
      }
    }
    let j = i, q = null;
    for (; j < s.length; j++) { const c = s[j]; if (q) { if (c === q) q = null; else if (c === "\\" && q === '"') j++; continue; } if ((c === '"' || c === "'") && j === i) { q = c; continue; } if (closers.includes(c)) break; }
    const tok = s.slice(i, j); i = j;
    if (/^\s*$/.test(tok)) unsup(`empty flow item at line ${ln}`);
    return yamlScalar(tok, ln);
  };
  const v = item(""); skip();
  if (i < s.length) unsup(`trailing content after flow collection at line ${ln}`);
  return v;
}
export function parseYaml(text) {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const L = raw.map((r, n) => {
    if (/^\s*\t/.test(r)) unsup(`tab indentation at line ${n + 1}`);
    const t = stripComment(r).replace(/\s+$/, "");
    return { ind: t.length - t.trimStart().length, text: t.trim(), line: n + 1, raw: r };
  });
  let p = 0;
  const firstSig = L.findIndex((l) => l.text !== "");
  if (firstSig >= 0 && L[firstSig].text === "---") { L[firstSig].text = ""; }
  for (const l of L) {
    if (l.text === "---" || l.text === "..." || /^%/.test(l.text)) unsup(`multi-document or directive at line ${l.line}`);
    if (/^\? /.test(l.text) || /^<<\s*:/.test(l.text)) unsup(`complex or merge key at line ${l.line}`);
  }
  const next = () => { while (p < L.length && L[p].text === "") p++; return p < L.length ? L[p] : null; };
  const isSeq = (t) => t === "-" || t.startsWith("- ");
  const splitKey = (l) => {
    const t = l.text; let k, rest;
    if (t[0] === '"' || t[0] === "'") {
      const q = t[0]; let j = 1; for (; j < t.length; j++) { if (t[j] === "\\" && q === '"') { j++; continue; } if (t[j] === q) { if (q === "'" && t[j + 1] === "'") { j++; continue; } break; } }
      k = yamlScalar(t.slice(0, j + 1), l.line); rest = t.slice(j + 1);
      if (!/^\s*:(\s|$)/.test(rest)) return null; rest = rest.replace(/^\s*:/, "");
    } else {
      const m = /^([^\s[\]{},#&*!|>'"%@`][^#]*?)\s*:(\s+|$)(.*)$/.exec(t);
      if (!m) return null; k = m[1]; rest = m[3];
    }
    return { key: String(k), rest: rest.trim() };
  };
  const blockScalar = (ind, head, ln) => {
    if (!/^[|>][-+]?$/.test(head)) unsup(`unsupported block scalar header at line ${ln}`);
    const out = []; let bi = null;
    while (p < L.length) {
      const l = L[p]; const rawT = l.raw.replace(/\s+$/, "");
      if (rawT.trim() === "") { out.push(""); p++; continue; }
      const ri = rawT.length - rawT.trimStart().length;
      if (ri <= ind) break;
      if (bi === null) bi = ri;
      if (ri < bi) unsup(`bad block scalar indentation at line ${l.line}`);
      out.push(rawT.slice(bi)); p++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    return head[0] === "|" ? out.join("\n") : out.join(" ");
  };
  const node = (minInd) => {
    const l = next(); if (!l || l.ind < minInd) return null;
    if (isSeq(l.text)) return seq(l.ind);
    if (splitKey(l)) return map(l.ind);
    p++;
    if (l.text[0] === "[" || l.text[0] === "{") return yamlFlow(l.text, l.line);
    return yamlScalar(l.text, l.line);
  };
  const value = (rest, ind, l, container, key) => {
    if (rest === "") {
      const n = next();
      if (n && n.ind === ind && isSeq(n.text) && !Array.isArray(container)) return seq(ind);
      return node(ind + 1);
    }
    if (/^[|>]/.test(rest)) return blockScalar(ind, rest, l.line);
    if (/^[&*!]/.test(rest)) unsup(`anchor, alias or tag at line ${l.line}`);
    if (rest[0] === "[" || rest[0] === "{") return yamlFlow(rest, l.line);
    const v = yamlScalar(rest, l.line);
    const n = next(); if (n && n.ind > ind) unsup(`multi-line plain scalar or bad indentation at line ${n.line}`);
    return v;
  };
  const map = (ind) => {
    const o = {};
    for (;;) {
      const l = next(); if (!l || l.ind < ind) break;
      if (l.ind > ind) unsup(`bad indentation at line ${l.line}`);
      if (isSeq(l.text)) break;
      const kv = splitKey(l); if (!kv) unsup(`expected a mapping entry at line ${l.line}`);
      if (Object.prototype.hasOwnProperty.call(o, kv.key)) unsup(`duplicate key ${kv.key} at line ${l.line}`);
      p++; o[kv.key] = value(kv.rest, ind, l, o, kv.key); setLine(o, kv.key, l.line);
    }
    return o;
  };
  const seq = (ind) => {
    const a = [];
    for (;;) {
      const l = next(); if (!l || l.ind !== ind || !isSeq(l.text)) { if (l && l.ind > ind) unsup(`bad indentation at line ${l.line}`); break; }
      const content = l.text === "-" ? "" : l.text.slice(2);
      const lead = l.text === "-" ? 0 : 2 + (content.length - content.trimStart().length);
      setLine(a, a.length, l.line);
      if (content.trim() === "") { p++; a.push(node(ind + 1)); continue; }
      // rewrite "- key: v" as a mapping (or nested sequence) starting at the item column
      l.ind = ind + lead; l.text = content.trim();
      if (isSeq(l.text)) { a.push(seq(l.ind)); continue; }
      if (splitKey(l)) { a.push(map(l.ind)); continue; }
      p++;
      a.push(l.text[0] === "[" || l.text[0] === "{" ? yamlFlow(l.text, l.line) : yamlScalar(l.text, l.line));
      const n = next(); if (n && n.ind > ind && !isSeq(n.text)) unsup(`multi-line plain scalar at line ${n.line}`);
    }
    return a;
  };
  const v = node(0);
  const rest = next(); if (rest) unsup(`unexpected content at line ${rest.line}`);
  return v;
}

// ---- format detection ---------------------------------------------------------------------------
const CONTRACT_TEXT = /^(openapi|asyncapi|swagger)\s*:|"(openapi|asyncapi|swagger|\$schema)"\s*:|^syntax\s*=\s*"proto/m;
const SDL_EXT = [".graphql", ".graphqls", ".gql"];
const OTHER_CONTRACT_EXT = { ".avsc": "avro", ".avdl": "avro", ".thrift": "thrift", ".raml": "raml", ".wsdl": "wsdl", ".xsd": "xsd" };
function kindOf(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if ("openapi" in doc || "swagger" in doc) return "openapi";
  if ("asyncapi" in doc) return "asyncapi";
  if ("$schema" in doc || ("type" in doc && ("properties" in doc || "items" in doc)) || "$defs" in doc || "definitions" in doc) return "jsonschema";
  return null;
}
// Returns { format, model } or { format, unsupported: reason } or null when the file is not a contract.
export function load(path, text, { explicit = false } = {}) {
  const ext = extname(path).toLowerCase();
  if (text === null) return { format: null, model: null };
  try {
    if (SDL_EXT.includes(ext)) return { format: "graphql", model: parseGraphql(text) };
    if (ext === ".proto") return { format: "proto", model: parseProto(text) };
    if (OTHER_CONTRACT_EXT[ext]) return { format: OTHER_CONTRACT_EXT[ext], unsupported: `no built-in rules for ${OTHER_CONTRACT_EXT[ext]}` };
    if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
      const doc = ext === ".json" ? parseJson(text) : parseYaml(text);
      const k = kindOf(doc);
      if (!k) return explicit ? { format: ext === ".json" ? "json" : "yaml", unsupported: "not an OpenAPI, AsyncAPI or JSON Schema document" } : null;
      return { format: k, model: doc };
    }
    return explicit || CONTRACT_TEXT.test(text) ? { format: "unknown", unsupported: `no built-in parser for ${ext || "this file"}` } : null;
  } catch (e) {
    if (!(e instanceof Unsupported) && !(e instanceof SyntaxError)) throw e;
    if (!explicit && !CONTRACT_TEXT.test(text) && !SDL_EXT.includes(ext) && ext !== ".proto") return null;
    const fmt = SDL_EXT.includes(ext) ? "graphql" : ext === ".proto" ? "proto" : ext === ".json" ? "json" : "yaml";
    return { format: fmt, unsupported: `cannot parse: ${e.message}` };
  }
}

// ---- JSON / YAML structural diff ----------------------------------------------------------------
const DOC_KEYS = new Set(["description", "summary", "title", "example", "examples", "externalDocs", "$comment", "info", "tags", "contact", "license", "termsOfService", "x-examples"]);
const METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);
// keyword -> +1 when a larger value narrows (minimum), -1 when a smaller value narrows (maximum)
const NUMERIC = { maxLength: -1, maxItems: -1, maxProperties: -1, maximum: -1, exclusiveMaximum: -1, minLength: 1, minItems: 1, minProperties: 1, minimum: 1, exclusiveMinimum: 1 };
const CHANGED_NARROWS = new Set(["pattern", "format", "multipleOf", "const"]);
const esc = (s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const ptr = (segs) => "/" + segs.map(esc).join("/");
const brief = (v) => { if (v === undefined) return null; const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + "..." : s; };
const deq = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
function canon(v) { if (Array.isArray(v)) return v.map(canon); if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])); return v; }
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const REFS = new WeakMap();
// a subtree holding a $ref can differ after resolution even when its text is equal
const hasRef = (v) => {
  if (!v || typeof v !== "object") return false;
  if (REFS.has(v)) return REFS.get(v);
  const r = (isObj(v) && typeof v.$ref === "string") || Object.values(v).some(hasRef);
  REFS.set(v, r); return r;
};

function elementOf(segs) {
  for (let i = segs.length - 1; i >= 0; i--) {
    const prev = segs[i - 1];
    if (prev === "properties" || prev === "channels" || prev === "responses" || prev === "enum" || prev === "parameters" || prev === "headers") return String(segs[i]);
    if (prev === "paths") return String(segs[i]);
    if (i >= 2 && segs[i - 2] === "paths" && METHODS.has(segs[i])) return `${String(segs[i]).toUpperCase()} ${segs[i - 1]}`;
  }
  return String(segs[segs.length - 1] ?? "/");
}
// side-dependent rule pick: [request, response]; side both takes the stricter (breaking first)
function pick(side, req, resp) {
  if (side === "request") return req;
  if (side === "response") return resp;
  return RULES[req][0] !== "non-breaking" ? req : resp;
}

function derefFactory(root) {
  return (node, stack) => {
    let n = node; const seen = [...stack];
    while (isObj(n) && typeof n.$ref === "string" && Object.keys(n).length === 1) {
      const r = n.$ref;
      if (!r.startsWith("#/") || seen.includes(r)) return { node: n, ref: r, opaque: true, stack: seen };
      seen.push(r);
      let t = root; for (const s of r.slice(2).split("/").map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))) t = t?.[s];
      if (t === undefined) return { node: n, ref: r, opaque: true, stack: seen };
      n = t;
    }
    return { node: n, opaque: false, stack: seen };
  };
}
// every #/... target reached from outside `components`/`definitions`/`$defs` (transitively)
function reachedRefs(root) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > 200) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (!isObj(v)) return;
    if (typeof v.$ref === "string" && v.$ref.startsWith("#/") && !out.has(v.$ref)) {
      out.add(v.$ref);
      let t = root; for (const s of v.$ref.slice(2).split("/").map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"))) t = t?.[s];
      walk(t, depth + 1);
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  if (isObj(root)) for (const k of Object.keys(root)) if (!["components", "definitions", "$defs"].includes(k)) walk(root[k], 0);
  return out;
}

export function diffDocs(base, head, kind) {
  const changes = [];
  const dB = derefFactory(base || {}), dH = derefFactory(head || {});
  const reached = new Set([...reachedRefs(base || {}), ...reachedRefs(head || {})]);
  const add = (rule, segs, side, before, after, line, extra = {}) => {
    changes.push({ location: ptr(segs), element: extra.element ?? elementOf(segs), side, rule, classification: RULES[rule][0], before: brief(before), after: brief(after), line: line?.n ?? 1, line_in: line?.in ?? "head" });
  };
  const L = (pa, pb, k) => { const h = lineOf(pb, k); if (h) return { n: h, in: "head" }; const b = lineOf(pa, k); return b ? { n: b, in: "base" } : undefined; };

  const walk = (a, b, segs, side, sa, sb, pa, pb, key) => {
    const ra = dB(a, sa), rb = dH(b, sb);
    a = ra.node; b = rb.node;
    if (ra.opaque || rb.opaque) { if (!deq(a, b)) add("CP-U01", segs, side, a, b, L(pa, pb, key)); return; }
    if (deq(a, b) && !hasRef(a) && !hasRef(b)) return;
    if (!isObj(a) || !isObj(b)) {
      if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) { a.forEach((x, i) => walk(x, b[i], [...segs, i], side, ra.stack, rb.stack, a, b, i)); return; }
      add("CP-U01", segs, side, a, b, L(pa, pb, key)); return;
    }
    const top = segs.length === 0;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const va = a[k], vb = b[k], s = [...segs, k], ln = L(a, b, k);
      if (k === "properties") { diffProps(a, b, s, side, ra.stack, rb.stack); continue; } // before the equality skip: `required` may differ
      if (deq(va, vb) && !hasRef(va) && !hasRef(vb)) continue;
      if (top && (k === "components" || k === "definitions" || k === "$defs") && isObj(va ?? {}) && isObj(vb ?? {})) {
        // only the definitions no path, channel or root schema reaches; reached ones are diffed where used
        const sects = k === "components" ? [...new Set([...Object.keys(va || {}), ...Object.keys(vb || {})])] : [null];
        for (const sec of sects) {
          const ca = (sec ? va?.[sec] : va) || {}, cb = (sec ? vb?.[sec] : vb) || {};
          if (!isObj(ca) || !isObj(cb)) { if (!deq(ca, cb)) add("CP-U01", sec ? [k, sec] : [k], "both", ca, cb, ln); continue; }
          for (const n of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
            const ref = "#/" + [k, ...(sec ? [sec] : []), n].map(esc).join("/");
            if (reached.has(ref)) continue;
            const ss = [k, ...(sec ? [sec] : []), n], l2 = L(ca, cb, n);
            if (!(n in cb)) add("CP-B01", ss, "both", "present", undefined, l2, { element: n });
            else if (!(n in ca)) add("CP-N02", ss, "both", undefined, "present", l2, { element: n });
            else walk(ca[n], cb[n], ss, "both", ra.stack, rb.stack, ca, cb, n);
          }
        }
        continue;
      }
      if (DOC_KEYS.has(k) && !(k === "title" && isObj(va ?? vb)) && !(segs[segs.length - 1] === "properties")) { if (!deq(va, vb)) add("CP-N05", s, side, va, vb, ln, { element: segs.length ? elementOf(segs) : k }); continue; }
      if (k === "deprecated") { add("CP-N08", s, side, va, vb, ln, { element: elementOf(segs) }); continue; }
      if (k === "paths" || k === "channels") { diffNamed(va || {}, vb || {}, s, side, "CP-B01", "CP-N02", ra.stack, rb.stack); continue; }
      if (segs[segs.length - 2] === "paths" && METHODS.has(k)) {
        if (va === undefined) add("CP-N02", s, side, undefined, "present", ln);
        else if (vb === undefined) add("CP-B01", s, side, "present", undefined, ln);
        else walk(va, vb, s, side, ra.stack, rb.stack, a, b, k);
        continue;
      }
      if (k === "parameters" && (Array.isArray(va) || Array.isArray(vb))) { diffParams(va || [], vb || [], s, ra.stack, rb.stack); continue; }
      if (k === "requestBody") {
        if (va === undefined || vb === undefined) {
          const rq = (vb && dH(vb, rb.stack).node?.required) === true;
          add(va === undefined ? (rq ? "CP-B05" : "CP-N01") : "CP-B07", s, "request", va === undefined ? undefined : "present", vb === undefined ? undefined : "present", ln);
        } else walk(va, vb, s, "request", ra.stack, rb.stack, a, b, k);
        continue;
      }
      if (k === "responses" && segs.length && METHODS.has(segs[segs.length - 1])) { diffNamed(va || {}, vb || {}, s, "response", "CP-B08", "CP-N07", ra.stack, rb.stack); continue; }
      if (k === "content" || k === "headers") {
        diffNamed(va || {}, vb || {}, s, side, k === "content" ? "CP-B03" : "CP-B07", "CP-N01", ra.stack, rb.stack); continue;
      }
      if (k === "required" && Array.isArray(va ?? vb)) {
        if (!("properties" in a) && !("properties" in b)) add("CP-U01", s, side, va, vb, ln);
        continue; // handled with properties
      }
      if (k === "required" && (typeof va === "boolean" || typeof vb === "boolean")) {
        const was = va === true, now = vb === true;
        if (was !== now) add(now ? pick(side, "CP-B04", "CP-N06") : pick(side, "CP-N06", "CP-B04"), s, side, va, vb, ln, { element: elementOf(segs) });
        continue;
      }
      if (k === "enum") { diffEnum(va || [], vb || [], s, side, a, b); continue; }
      if (k === "type") { diffType(va, vb, s, side, ln); continue; }
      if (k === "nullable") { const now = vb === true, was = va === true; if (now !== was) add(now ? pick(side, "CP-N06", "CP-B09") : pick(side, "CP-B09", "CP-N06"), s, side, va, vb, ln, { element: elementOf(segs) }); continue; }
      if (k in NUMERIC && (typeof (va ?? 0) === "number") && (typeof (vb ?? 0) === "number")) {
        const dir = NUMERIC[k];
        const narrows = va === undefined ? true : vb === undefined ? false : (vb - va) * dir > 0;
        add(narrows ? pick(side, "CP-B09", "CP-N06") : pick(side, "CP-N06", "CP-B09"), s, side, va, vb, ln, { element: elementOf(segs) }); continue;
      }
      if (CHANGED_NARROWS.has(k)) { add(vb === undefined ? pick(side, "CP-N06", "CP-B09") : pick(side, "CP-B09", "CP-N06"), s, side, va, vb, ln, { element: elementOf(segs) }); continue; }
      if (k === "additionalProperties" && typeof (va ?? true) === "boolean" && typeof (vb ?? true) === "boolean") {
        const narrows = vb === false; add(narrows ? pick(side, "CP-B09", "CP-N06") : pick(side, "CP-N06", "CP-B09"), s, side, va, vb, ln, { element: elementOf(segs) }); continue;
      }
      if (k === "uniqueItems") { add(vb === true ? pick(side, "CP-B09", "CP-N06") : pick(side, "CP-N06", "CP-B09"), s, side, va, vb, ln, { element: elementOf(segs) }); continue; }
      if (va === undefined || vb === undefined) {
        if (isObj(va ?? vb)) { walk(va ?? {}, vb ?? {}, s, side, ra.stack, rb.stack, a, b, k); continue; }
        add("CP-U01", s, side, va, vb, ln); continue;
      }
      walk(va, vb, s, side, ra.stack, rb.stack, a, b, k);
    }
  };
  const diffNamed = (A, B, segs, side, removed, added, sa, sb) => {
    A = dB(A, sa).node; B = dH(B, sb).node;
    if (!isObj(A) || !isObj(B)) { add("CP-U01", segs, side, A, B, undefined); return; }
    for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const s = [...segs, n], ln = L(A, B, n);
      if (!(n in B)) add(removed, s, side, "present", undefined, ln);
      else if (!(n in A)) add(added, s, side, undefined, "present", ln);
      else walk(A[n], B[n], s, side, sa, sb, A, B, n);
    }
  };
  const diffParams = (A, B, segs, sa, sb) => {
    const keyed = (arr, d, st) => { const m = new Map(); arr.forEach((p, i) => { const r = d(p, st).node; m.set(isObj(r) ? `${r.in}:${r.name}` : `#${i}`, { p, r, i, arr }); }); return m; };
    const mA = keyed(A, dB, sa), mB = keyed(B, dH, sb);
    for (const k of new Set([...mA.keys(), ...mB.keys()])) {
      const x = mA.get(k), y = mB.get(k); const name = (y || x).r?.name ?? k;
      const s = [...segs, name];
      const ln = y ? { n: lineOf(y.arr, y.i) ?? 1, in: "head" } : { n: lineOf(x.arr, x.i) ?? 1, in: "base" };
      if (!y) add("CP-B07", s, "request", "present", undefined, ln, { element: name });
      else if (!x) add(y.r?.required === true ? "CP-B05" : "CP-N01", s, "request", undefined, "present", ln, { element: name });
      else walk(x.p, y.p, s, "request", sa, sb, x.arr, y.arr, x.i);
    }
  };
  const diffProps = (a, b, segs, side, sa, sb) => {
    const A = dB(a.properties || {}, sa).node, B = dH(b.properties || {}, sb).node;
    const rA = new Set(Array.isArray(a.required) ? a.required : []), rB = new Set(Array.isArray(b.required) ? b.required : []);
    for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const s = [...segs, n], ln = L(A, B, n);
      if (!(n in B)) { add("CP-B02", s, side, "present", undefined, ln); continue; }
      if (!(n in A)) { add(rB.has(n) ? pick(side, "CP-B05", "CP-N01") : "CP-N01", s, side, undefined, rB.has(n) ? "required" : "optional", ln); continue; }
      if (rA.has(n) !== rB.has(n)) add(rB.has(n) ? pick(side, "CP-B04", "CP-N06") : pick(side, "CP-N06", "CP-B04"), s, side, rA.has(n) ? "required" : "optional", rB.has(n) ? "required" : "optional", ln);
      walk(A[n], B[n], s, side, sa, sb, A, B, n);
    }
  };
  const diffEnum = (A, B, segs, side, pa, pb) => {
    const key = (v) => JSON.stringify(v);
    const kA = new Map(A.map((v, i) => [key(v), i])), kB = new Map(B.map((v, i) => [key(v), i]));
    for (const [k, i] of kA) if (!kB.has(k)) add("CP-B06", [...segs, A[i]], side, A[i], undefined, { n: lineOf(A, i) ?? lineOf(pa, "enum") ?? 1, in: "base" }, { element: String(A[i]) });
    for (const [k, i] of kB) if (!kA.has(k)) add(side === "request" ? "CP-N03" : "CP-N04", [...segs, B[i]], side, undefined, B[i], { n: lineOf(B, i) ?? lineOf(pb, "enum") ?? 1, in: "head" }, { element: String(B[i]) });
  };
  const diffType = (va, vb, segs, side, ln) => {
    const A = new Set([].concat(va ?? [])), B = new Set([].concat(vb ?? []));
    if (va === undefined || vb === undefined) { add(va === undefined ? pick(side, "CP-B03", "CP-N06") : pick(side, "CP-N06", "CP-B03"), segs, side, va, vb, ln, { element: elementOf(segs.slice(0, -1)) }); return; }
    const lost = [...A].some((t) => !B.has(t) && !(t === "integer" && B.has("number")));
    const gained = [...B].some((t) => !A.has(t) && !(t === "integer" && A.has("number")));
    const rule = lost && gained ? "CP-B03" : lost ? pick(side, "CP-B03", "CP-N06") : pick(side, "CP-N06", "CP-B03");
    add(rule, segs, side, va, vb, ln, { element: elementOf(segs.slice(0, -1)) });
  };
  void kind; // every root starts on side both; requestBody/parameters/responses set the side below
  walk(base || {}, head || {}, [], "both", [], [], null, null, null);
  return changes;
}

// ---- GraphQL SDL (line level) -------------------------------------------------------------------
// shortcut: one field or argument list per line; multi-line argument lists and single-line type bodies
// are UNSUPPORTED; upgrade with a tokenizer when a project needs them.
export function parseGraphql(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // blank out block strings, strings and comments, keeping line numbers
  let inBlock = false;
  const clean = lines.map((l) => {
    let out = "", i = 0;
    while (i < l.length) {
      if (inBlock) { const e = l.indexOf('"""', i); if (e < 0) { i = l.length; break; } inBlock = false; i = e + 3; continue; }
      if (l.startsWith('"""', i)) { inBlock = true; i += 3; continue; }
      if (l[i] === '"') { let j = i + 1; while (j < l.length && l[j] !== '"') { if (l[j] === "\\") j++; j++; } out += l.slice(i, j + 1); i = j + 1; continue; }
      if (l[i] === "#") break;
      out += l[i++];
    }
    return out.trim();
  });
  const T = {}; let cur = null;
  const dirs = (s) => (s || "").trim();
  clean.forEach((t, n) => {
    const line = n + 1;
    if (t === "" || /^"([^"\\]|\\.)*"$/.test(t)) return;
    if (cur) {
      if (t === "}") { cur = null; return; }
      if (cur.kind === "enum") {
        const m = /^([A-Za-z_]\w*)\s*((@\w+(\([^)]*\))?\s*)*)$/.exec(t);
        if (!m) unsup(`cannot parse enum value at line ${line}`);
        cur.values[m[1]] = { line, directives: dirs(m[2]) }; return;
      }
      const m = /^([A-Za-z_]\w*)\s*(\((.*)\))?\s*:\s*([\w[\]!]+)\s*(=\s*([^@]+?))?\s*((@\w+(\([^)]*\))?\s*)*)$/.exec(t);
      if (!m) unsup(`cannot parse field at line ${line}`);
      const args = {};
      if (m[3] !== undefined && m[3].trim() !== "") {
        for (const part of m[3].split(/,(?![^([]*[)\]])/)) {
          const am = /^\s*([A-Za-z_]\w*)\s*:\s*([\w[\]!]+)\s*(=\s*([^@]+?))?\s*((@\w+(\([^)]*\))?\s*)*)$/.exec(part);
          if (!am) unsup(`cannot parse argument at line ${line}`);
          args[am[1]] = { type: am[2], default: am[4]?.trim() ?? null, directives: dirs(am[5]), line };
        }
      }
      cur.fields[m[1]] = { type: m[4], default: m[6]?.trim() ?? null, args, directives: dirs(m[7]), line };
      return;
    }
    let m = /^(extend\s+)?(type|input|interface|enum)\s+([A-Za-z_]\w*)([^{]*)\{$/.exec(t);
    if (m) {
      if (m[1]) unsup(`extend is not supported (line ${line})`);
      if (T[m[3]]) unsup(`duplicate type ${m[3]} at line ${line}`);
      cur = T[m[3]] = { kind: m[2], head: m[4].replace(/\s+/g, " ").trim(), line, fields: {}, values: {} }; return;
    }
    m = /^union\s+([A-Za-z_]\w*)\s*((@\w+(\([^)]*\))?\s*)*)=\s*\|?\s*([\w\s|]+)$/.exec(t);
    if (m) { T[m[1]] = { kind: "union", head: dirs(m[2]), line, fields: {}, values: Object.fromEntries(m[5].split("|").map((x) => [x.trim(), { line, directives: "" }])) }; return; }
    m = /^scalar\s+([A-Za-z_]\w*)\s*((@\w+(\([^)]*\))?\s*)*)$/.exec(t);
    if (m) { T[m[1]] = { kind: "scalar", head: dirs(m[2]), line, fields: {}, values: {} }; return; }
    m = /^schema\s*\{$/.exec(t);
    if (m) { cur = T["(schema)"] = { kind: "schema", head: "", line, fields: {}, values: {} }; return; }
    if (/^directive\s+@/.test(t)) { T[`@${t}`] = { kind: "directive", head: t, line, fields: {}, values: {} }; return; }
    unsup(`cannot parse line ${line}`);
  });
  if (cur || inBlock) unsup("unterminated block");
  return T;
}
const gqlBase = (t) => t.replace(/[[\]!]/g, "");
const gqlShape = (t) => t.replace(/!/g, "").replace(/\w+/g, "T");
function gqlTypeRule(a, b, side) {
  if (gqlBase(a) !== gqlBase(b) || gqlShape(a) !== gqlShape(b)) return "CP-B03";
  // same shape: compare the non-null markers position by position
  const marks = (t) => { const r = []; for (let i = 0; i < t.length; i++) if (/[\w\]]/.test(t[i]) && (t[i + 1] === "!" || !/\w/.test(t[i + 1] || ""))) r.push(t[i + 1] === "!"); return r; };
  const ma = marks(a), mb = marks(b);
  const tighter = mb.some((x, i) => x && !ma[i]), looser = mb.some((x, i) => !x && ma[i]);
  if (tighter && looser) return "CP-U01";
  return tighter ? pick(side, "CP-B04", "CP-N06") : pick(side, "CP-N06", "CP-B09");
}
const deprecOnly = (a, b) => a.replace(/@deprecated(\([^)]*\))?/g, "").trim() === b.replace(/@deprecated(\([^)]*\))?/g, "").trim();
export function diffGraphql(A, B) {
  const ch = [];
  const add = (rule, location, element, side, before, after, line, lineIn) => ch.push({ location, element, side, rule, classification: RULES[rule][0], before: brief(before), after: brief(after), line, line_in: lineIn });
  const dirChange = (loc, el, side, a, b, line) => { if (a === b) return; add(deprecOnly(a, b) ? "CP-N08" : "CP-U01", loc, el, side, a || null, b || null, line, "head"); };
  for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const x = A[n], y = B[n];
    if (!y) { add("CP-B01", n, n, "both", x.kind, null, x.line, "base"); continue; }
    if (!x) { add("CP-N02", n, n, "both", null, y.kind, y.line, "head"); continue; }
    if (x.kind !== y.kind) { add("CP-B03", n, n, "both", x.kind, y.kind, y.line, "head"); continue; }
    if (x.head !== y.head) dirChange(n, n, "both", x.head, y.head, y.line);
    const fside = x.kind === "input" ? "request" : "response";
    for (const f of new Set([...Object.keys(x.fields), ...Object.keys(y.fields)])) {
      const p = x.fields[f], q = y.fields[f], loc = `${n}.${f}`;
      if (!q) { add("CP-B02", loc, f, fside, p.type, null, p.line, "base"); continue; }
      if (!p) {
        const r = fside === "request" ? (q.type.endsWith("!") ? (q.default !== null ? "CP-N10" : "CP-B05") : "CP-N01") : "CP-N01";
        add(r, loc, f, fside, null, q.type, q.line, "head"); continue;
      }
      if (p.type !== q.type) add(gqlTypeRule(p.type, q.type, fside), loc, f, fside, p.type, q.type, q.line, "head");
      if (p.default !== q.default) add("CP-U01", `${loc} default`, f, fside, p.default, q.default, q.line, "head");
      dirChange(loc, f, fside, p.directives, q.directives, q.line);
      for (const g of new Set([...Object.keys(p.args), ...Object.keys(q.args)])) {
        const u = p.args[g], v = q.args[g], al = `${loc}(${g})`;
        if (!v) { add("CP-B07", al, g, "request", u.type, null, u.line, "base"); continue; }
        if (!u) { add(v.type.endsWith("!") ? (v.default !== null ? "CP-N10" : "CP-B05") : "CP-N01", al, g, "request", null, v.type, v.line, "head"); continue; }
        if (u.type !== v.type) add(gqlTypeRule(u.type, v.type, "request"), al, g, "request", u.type, v.type, v.line, "head");
        if (u.default !== v.default) add("CP-U01", `${al} default`, g, "request", u.default, v.default, v.line, "head");
        dirChange(al, g, "request", u.directives, v.directives, v.line);
      }
    }
    for (const v of new Set([...Object.keys(x.values), ...Object.keys(y.values)])) {
      const p = x.values[v], q = y.values[v], loc = `${n}.${v}`;
      if (!q) add("CP-B06", loc, v, "both", v, null, p.line, "base");
      else if (!p) add("CP-N04", loc, v, "both", null, v, q.line, "head");
      else dirChange(loc, v, "both", p.directives, q.directives, q.line);
    }
  }
  return ch;
}

// ---- protobuf (line level) ----------------------------------------------------------------------
// shortcut: one statement per line; `extend`, groups, multi-line options and rpc bodies with options are
// UNSUPPORTED; upgrade with a tokenizer when a project needs them.
export function parseProto(text) {
  let s = text.replace(/\r\n?/g, "\n");
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = s.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim());
  const M = { meta: {}, options: [], messages: {}, enums: {}, services: {} };
  const stack = [];
  const scopeName = (n) => [...stack.filter((x) => x.kind !== "oneof").map((x) => x.name), n].join(".");
  lines.forEach((t, i) => {
    const line = i + 1;
    if (t === "") return;
    const top = stack[stack.length - 1];
    if (t === "}" || t === "};") { if (!stack.length) unsup(`unbalanced } at line ${line}`); stack.pop(); return; }
    let m;
    if ((m = /^syntax\s*=\s*"([^"]+)"\s*;$/.exec(t))) { M.meta.syntax = { v: m[1], line }; return; }
    if ((m = /^package\s+([\w.]+)\s*;$/.exec(t))) { M.meta.package = { v: m[1], line }; return; }
    if (/^import\s+(public\s+|weak\s+)?"[^"]+"\s*;$/.test(t)) return;
    if ((m = /^option\s+(.+);$/.exec(t))) { (top ? top.node.options || (top.node.options = []) : M.options).push(m[1].replace(/\s+/g, " ")); return; }
    if ((m = /^message\s+(\w+)\s*\{$/.exec(t))) { const name = scopeName(m[1]); M.messages[name] = { line, fields: {}, reserved: new Set(), options: [] }; stack.push({ kind: "message", name: m[1], node: M.messages[name] }); return; }
    if ((m = /^enum\s+(\w+)\s*\{$/.exec(t))) { const name = scopeName(m[1]); M.enums[name] = { line, values: {}, options: [] }; stack.push({ kind: "enum", name: m[1], node: M.enums[name] }); return; }
    if ((m = /^service\s+(\w+)\s*\{$/.exec(t))) { if (stack.length) unsup(`nested service at line ${line}`); M.services[m[1]] = { line, rpcs: {}, options: [] }; stack.push({ kind: "service", name: m[1], node: M.services[m[1]] }); return; }
    if ((m = /^oneof\s+(\w+)\s*\{$/.exec(t))) { if (top?.kind !== "message") unsup(`oneof outside a message at line ${line}`); stack.push({ kind: "oneof", name: m[1], node: top.node, oneof: m[1] }); return; }
    if ((m = /^reserved\s+(.+);$/.exec(t))) { if (!top || top.kind === "service") unsup(`reserved outside a message at line ${line}`); for (const r of m[1].split(",")) (top.node.reserved || (top.node.reserved = new Set())).add(r.trim()); return; }
    if (top?.kind === "service") {
      m = /^rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*(;|\{\s*\})$/.exec(t);
      if (!m) unsup(`cannot parse rpc at line ${line}`);
      top.node.rpcs[m[1]] = { req: `${m[2] ? "stream " : ""}${m[3]}`, resp: `${m[4] ? "stream " : ""}${m[5]}`, line }; return;
    }
    if (top?.kind === "enum") {
      m = /^(\w+)\s*=\s*(-?\d+)\s*(\[(.*)\])?\s*;$/.exec(t);
      if (!m) unsup(`cannot parse enum value at line ${line}`);
      top.node.values[m[1]] = { number: Number(m[2]), opts: (m[4] || "").replace(/\s+/g, " ").trim(), line }; return;
    }
    if (top?.kind === "message" || top?.kind === "oneof") {
      m = /^(repeated\s+|optional\s+|required\s+)?(map\s*<\s*[\w.]+\s*,\s*[\w.]+\s*>|[\w.]+)\s+(\w+)\s*=\s*(\d+)\s*(\[(.*)\])?\s*;$/.exec(t);
      if (!m) unsup(`cannot parse field at line ${line}`);
      top.node.fields[m[3]] = { label: (m[1] || "").trim(), type: m[2].replace(/\s+/g, ""), number: Number(m[4]), opts: (m[6] || "").replace(/\s+/g, " ").trim(), oneof: top.oneof || null, line }; return;
    }
    unsup(`cannot parse line ${line}`);
  });
  if (stack.length) unsup("unbalanced braces");
  return M;
}
const optDeprecOnly = (a, b) => { const strip = (o) => o.split(",").map((x) => x.trim()).filter((x) => x && !/^deprecated\s*=/.test(x)).join(","); return strip(a) === strip(b); };
export function diffProto(A, B) {
  const ch = [];
  const add = (rule, location, element, before, after, line, lineIn) => ch.push({ location, element, side: "both", rule, classification: RULES[rule][0], before: brief(before), after: brief(after), line, line_in: lineIn });
  for (const k of ["syntax", "package"]) { const a = A.meta[k], b = B.meta[k]; if ((a?.v ?? null) !== (b?.v ?? null)) add("CP-U01", k, k, a?.v ?? null, b?.v ?? null, (b || a)?.line ?? 1, b ? "head" : "base"); }
  if (JSON.stringify([...A.options].sort()) !== JSON.stringify([...B.options].sort())) add("CP-U01", "option", "option", A.options.join("; "), B.options.join("; "), 1, "head");
  const named = (X, Y, kind, inner) => {
    for (const n of new Set([...Object.keys(X), ...Object.keys(Y)])) {
      const x = X[n], y = Y[n];
      if (!y) add("CP-B01", n, n, kind, null, x.line, "base");
      else if (!x) add("CP-N02", n, n, null, kind, y.line, "head");
      else {
        if (JSON.stringify([...(x.options || [])].sort()) !== JSON.stringify([...(y.options || [])].sort())) add("CP-U01", `${n} option`, n, (x.options || []).join("; "), (y.options || []).join("; "), y.line, "head");
        inner(n, x, y);
      }
    }
  };
  named(A.messages, B.messages, "message", (n, x, y) => {
    for (const f of new Set([...Object.keys(x.fields), ...Object.keys(y.fields)])) {
      const p = x.fields[f], q = y.fields[f], loc = `${n}.${f}`;
      if (!q) { add("CP-B02", loc, f, `${p.type} = ${p.number}`, null, p.line, "base"); continue; }
      if (!p) { add(q.label === "required" ? "CP-B05" : "CP-N01", loc, f, null, `${q.type} = ${q.number}`, q.line, "head"); continue; }
      if (p.number !== q.number) add("CP-B10", loc, f, p.number, q.number, q.line, "head");
      if (p.type !== q.type) add("CP-B03", loc, f, p.type, q.type, q.line, "head");
      if (p.label !== q.label) add((p.label === "repeated") !== (q.label === "repeated") ? "CP-B03" : p.label === "required" || q.label === "required" ? "CP-B04" : "CP-U01", loc, f, p.label || "(none)", q.label || "(none)", q.line, "head");
      if (p.oneof !== q.oneof) add("CP-U01", `${loc} oneof`, f, p.oneof, q.oneof, q.line, "head");
      if (p.opts !== q.opts) add(optDeprecOnly(p.opts, q.opts) ? "CP-N08" : "CP-U01", `${loc} options`, f, p.opts || null, q.opts || null, q.line, "head");
    }
    for (const r of new Set([...x.reserved, ...y.reserved])) {
      if (!x.reserved.has(r)) add("CP-N09", `${n}.reserved(${r})`, r, null, r, y.line, "head");
      else if (!y.reserved.has(r)) add("CP-U01", `${n}.reserved(${r})`, r, r, null, x.line, "base");
    }
  });
  named(A.enums, B.enums, "enum", (n, x, y) => {
    for (const v of new Set([...Object.keys(x.values), ...Object.keys(y.values)])) {
      const p = x.values[v], q = y.values[v], loc = `${n}.${v}`;
      if (!q) add("CP-B06", loc, v, p.number, null, p.line, "base");
      else if (!p) add("CP-N04", loc, v, null, q.number, q.line, "head");
      else {
        if (p.number !== q.number) add("CP-B10", loc, v, p.number, q.number, q.line, "head");
        if (p.opts !== q.opts) add(optDeprecOnly(p.opts, q.opts) ? "CP-N08" : "CP-U01", `${loc} options`, v, p.opts || null, q.opts || null, q.line, "head");
      }
    }
  });
  named(A.services, B.services, "service", (n, x, y) => {
    for (const r of new Set([...Object.keys(x.rpcs), ...Object.keys(y.rpcs)])) {
      const p = x.rpcs[r], q = y.rpcs[r], loc = `${n}.${r}`;
      if (!q) add("CP-B01", loc, r, `${p.req} -> ${p.resp}`, null, p.line, "base");
      else if (!p) add("CP-N02", loc, r, null, `${q.req} -> ${q.resp}`, q.line, "head");
      else if (p.req !== q.req || p.resp !== q.resp) add("CP-B03", loc, r, `${p.req} -> ${p.resp}`, `${q.req} -> ${q.resp}`, q.line, "head");
    }
  });
  return ch;
}

// ---- one file -----------------------------------------------------------------------------------
const EMPTY = { graphql: {}, proto: { meta: {}, options: [], messages: {}, enums: {}, services: {} } };
export function diffFile(path, baseText, headText, { explicit = false } = {}) {
  const b = baseText === null ? null : load(path, baseText, { explicit });
  const h = headText === null ? null : load(path, headText, { explicit });
  if (!b && !h) return null;
  const change = baseText === null ? "added" : headText === null ? "deleted" : "modified";
  const bad = [b, h].find((x) => x && x.unsupported);
  const format = (h && h.format) || (b && b.format);
  if (bad) return { path, format: bad.format, change, status: "unsupported", reason: bad.unsupported, changes: [] };
  if (b && h && b.format !== h.format) return { path, format, change, status: "unsupported", reason: `format changed from ${b.format} to ${h.format}`, changes: [] };
  const bm = b ? b.model : (EMPTY[format] ?? {}), hm = h ? h.model : (EMPTY[format] ?? {});
  const changes = format === "graphql" ? diffGraphql(bm, hm) : format === "proto" ? diffProto(bm, hm) : diffDocs(bm, hm, format);
  return { path, format, change, status: "compared", changes };
}

// ---- PLAN.md ## Contracts coverage --------------------------------------------------------------
export function planBullets(text) {
  const out = []; let on = false;
  text.replace(/\r\n?/g, "\n").split("\n").forEach((l, i) => {
    if (/^##\s/.test(l)) { on = /^##\s+Contracts\s*$/.test(l); return; }
    if (on && /^\s*-\s+/.test(l)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}
const hasToken = (text, tok) => {
  const e = String(tok).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${e}([^A-Za-z0-9_]|$)`).test(text);
};
// A bullet covers a change when it names the file (path or basename), the element, and versioning,
// migration or deprecation.
export function coverage(path, change, bullets) {
  if (!BLOCKING_CLASSES.includes(change.classification)) return { covered: false, plan_line: null, text: null };
  const b = bullets.find((x) => (x.text.includes(path) || hasToken(x.text, basename(path))) && hasToken(x.text, change.element) && COVER_KEYWORD.test(x.text));
  return b ? { covered: true, plan_line: b.line, text: b.text } : { covered: false, plan_line: null, text: null };
}

// ---- consumers from an evidence-map impact report -----------------------------------------------
export function consumersFrom(impact, element) {
  const syms = (impact?.symbols || []).filter((s) => s.name === element || String(s.name).endsWith(`.${element}`));
  if (!syms.length) return { source: "not-searched", in_repo: [], outside_repo: "unknown" };
  const seen = new Set(), in_repo = [];
  for (const s of syms) for (const r of s.references || []) {
    if (r.role === "doc" || r.role === "comment") continue;
    const k = `${r.path}:${r.line}`; if (seen.has(k)) continue; seen.add(k);
    in_repo.push({ path: r.path, line: r.line, kind: r.kind });
  }
  return { source: "impact", in_repo, outside_repo: "unknown" };
}

// ---- tools already present (detected, never installed, never run by this script) ----------------
export function detectTools(repo) {
  const dirs = [...(process.env.PATH || "").split(delimiter), ...(repo ? [join(repo, "node_modules", ".bin")] : [])];
  const found = [];
  for (const t of TOOLS) for (const d of dirs) {
    try { const f = join(d, t.name); if (d && existsSync(f) && statSync(f).isFile()) { found.push({ name: t.name, path: f, formats: t.formats }); break; } } catch { /* unreadable PATH entry */ }
  }
  return found;
}

// ---- repository mode ----------------------------------------------------------------------------
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const show = (repo, ref, p) => { try { return git(repo, ["show", `${ref}:${p}`]); } catch { return null; } };
const readHead = (repo, p) => { try { return readFileSync(join(repo, p), "utf8"); } catch { return null; } };
export function changedPaths(repo, base) {
  const out = new Map();
  for (const l of git(repo, ["diff", "--name-status", "-M", base, "--"]).split("\n").filter(Boolean)) {
    const f = l.split("\t");
    if (f[0].startsWith("R")) { out.set(f[1], { base: f[1], head: null }); out.set(f[2], { base: null, head: f[2] }); }
    else out.set(f[f.length - 1], { base: f[0] === "A" ? null : f[1], head: f[0] === "D" ? null : f[1] });
  }
  for (const p of git(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) out.set(p, { base: null, head: p });
  return out;
}
export function run(opts) {
  const files = [];
  const bullets = opts.plan ? planBullets(readFileSync(opts.plan, "utf8")) : [];
  const impact = opts.impact ? JSON.parse(readFileSync(opts.impact, "utf8")) : null;
  if (opts.baseFile || opts.headFile) {
    const p = opts.name || basename(opts.headFile || opts.baseFile);
    const r = diffFile(p, opts.baseFile ? readFileSync(opts.baseFile, "utf8") : null, opts.headFile ? readFileSync(opts.headFile, "utf8") : null, { explicit: true });
    if (r) files.push(r);
  } else {
    const changed = changedPaths(opts.repo, opts.base);
    const want = opts.paths.length ? opts.paths : [...changed.keys()];
    for (const p of [...want].sort()) {
      const c = changed.get(p);
      if (!c) { if (opts.paths.length) files.push({ path: p, format: "unknown", change: "unchanged", status: "compared", changes: [] }); continue; }
      const r = diffFile(p, c.base ? show(opts.repo, opts.base, c.base) : null, c.head ? readHead(opts.repo, c.head) : null, { explicit: opts.paths.length > 0 });
      if (r) files.push(r);
    }
  }
  let n = 0;
  for (const f of files) for (const c of f.changes) {
    c.id = `C-${++n}`;
    c.evidence = { class: "measured", source: "diff-contract.mjs" };
    c.coverage = coverage(f.path, c, bullets);
    c.consumers = impact ? consumersFrom(impact, c.element) : { source: "not-searched", in_repo: [], outside_repo: "unknown" };
  }
  return {
    schema_version: 1,
    target: { base: opts.base || opts.baseFile || null, head: opts.repo ? "working-tree" : opts.headFile || null },
    tools: { detected: detectTools(opts.repo), used: [] },
    plan: { path: opts.plan || null, contracts_bullets: bullets.length },
    files,
    judged: [],
  };
}

function main(argv) {
  const o = { paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const need = () => { if (v === undefined) usage(`${a} needs a value`); i++; return v; };
    if (a === "--repo") o.repo = need();
    else if (a === "--base") o.base = need();
    else if (a === "--path") o.paths.push(need());
    else if (a === "--plan") o.plan = need();
    else if (a === "--impact") o.impact = need();
    else if (a === "--out") o.out = need();
    else if (a === "--base-file") o.baseFile = need();
    else if (a === "--head-file") o.headFile = need();
    else if (a === "--name") o.name = need();
    else usage(`unknown argument ${a}`);
  }
  if (!(o.repo && o.base) && !(o.baseFile || o.headFile)) usage("need --repo DIR --base REF, or --base-file/--head-file");
  let doc;
  try { doc = run(o); } catch (e) { console.error(`diff-contract: ${e.message}`); process.exit(2); }
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (o.out) writeFileSync(o.out, text); else process.stdout.write(text);
}
function usage(msg) {
  console.error(`diff-contract: ${msg}\nusage: diff-contract.mjs --repo DIR --base REF [--path P]... [--plan PLAN.md] [--impact impact.json] [--out FILE]\n       diff-contract.mjs --base-file OLD --head-file NEW [--name P] [--plan PLAN.md]`);
  process.exit(2);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
