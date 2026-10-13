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
import { join, basename, dirname, extname, delimiter } from "node:path";
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
// parsed mappings have no prototype, so `__proto__` or `constructor` is an ordinary key and `in` is exact
const newMap = () => Object.create(null);
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
      i++; const o = newMap(); ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') unsup(`expected a key at line ${line}`);
        const kl = line, k = str(); ws(); if (text[i] !== ":") unsup(`expected ':' at line ${line}`); i++;
        if (k in o) unsup(`duplicate key ${k} at line ${kl}`);
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
    i += m[0].length;
    const n = JSON.parse(m[0]);
    if (typeof n === "number" && /^-?\d+$/.test(m[0]) && !Number.isSafeInteger(n)) unsup(`integer beyond 2^53 at line ${line}`);
    return n;
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
  // YAML 1.1 readers turn these into booleans, YAML 1.2 readers into strings: refuse instead of guessing
  if (/^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/.test(s)) unsup(`ambiguous YAML 1.1 boolean ${s} at line ${ln}`);
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9]\d*)$/.test(s)) { const n = Number(s); if (!Number.isSafeInteger(n)) unsup(`integer beyond 2^53 at line ${ln}`); return n; }
  if (/^[-+]?0\d+$/.test(s)) unsup(`octal-looking number ${s} at line ${ln}`);
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
      i++; const o = newMap(); skip(); if (s[i] === "}") { i++; return o; }
      for (;;) {
        const k = String(item(":,}")); skip();
        // `{x:1}` is one plain scalar in YAML, not a pair: refuse instead of guessing
        if (s[i] !== ":" || !(i + 1 >= s.length || " ,}]".includes(s[i + 1]))) unsup(`bad flow mapping at line ${ln}`); i++;
        if (k in o) unsup(`duplicate key ${k} in flow mapping at line ${ln}`);
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
    if (!/^[|>]-?$/.test(head)) unsup(`unsupported block scalar header (keep chomping, indentation indicator) at line ${ln}`);
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
    // folded paragraphs and more-indented folded lines have their own rules; refused, not approximated
    if (head[0] === ">" && out.some((x) => x === "" || /^\s/.test(x))) unsup(`folded block scalar with paragraphs or indented lines at line ${ln}`);
    // clip chomping (`|`, `>`) keeps one final newline, strip (`|-`, `>-`) none
    const body = head[0] === "|" ? out.join("\n") : out.join(" ");
    return body === "" || head.endsWith("-") ? body : body + "\n";
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
    const o = newMap();
    for (;;) {
      const l = next(); if (!l || l.ind < ind) break;
      if (l.ind > ind) unsup(`bad indentation at line ${l.line}`);
      if (isSeq(l.text)) break;
      const kv = splitKey(l); if (!kv) unsup(`expected a mapping entry at line ${l.line}`);
      if (kv.key in o) unsup(`duplicate key ${kv.key} at line ${l.line}`);
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
const CONTRACT_TEXT = /^(openapi|asyncapi|swagger)\s*:|"(openapi|asyncapi|swagger|\$schema)"\s*:|^\s*\$schema\s*:|^syntax\s*=\s*"proto/m;
// config-free default: a changed .json/.yaml/.yml here is a contract or a contract fragment until proven
// otherwise; when it is neither diffed nor reached from a recognized contract it is UNSUPPORTED, never dropped
export const CONTRACT_PATH = /((^|\/)(openapi|swagger|asyncapi)[^/]*|schema[^/]*)\.(ya?ml|json)$|(^|\/)(apis?|contracts?|specs?|schemas?|openapi|asyncapi|swagger|events|graphql|proto)\/(.+\/)?[^/]+\.(ya?ml|json)$/i;
const SDL_EXT = [".graphql", ".graphqls", ".gql"];
const OTHER_CONTRACT_EXT = { ".avsc": "avro", ".avdl": "avro", ".thrift": "thrift", ".raml": "raml", ".wsdl": "wsdl", ".xsd": "xsd" };
// A JSON/YAML document is a JSON Schema when its `$schema` names a json-schema.org draft, when one strong
// root keyword has a schema-shaped value (an enum-only or oneOf-only schema counts), or when two weak ones
// do. A lone `type` (i18n `"type": "Type"`, package.json `"type": "module"`) or `additionalProperties` (a
// generator config) is not enough.
const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const objOfObjs = (v) => isObj(v) && Object.keys(v).length > 0 && Object.values(v).every(isObj);
const STRONG = {
  enum: Array.isArray, const: () => true,
  oneOf: (v) => Array.isArray(v) && v.length > 0 && v.every(isObj), anyOf: (v) => Array.isArray(v) && v.length > 0 && v.every(isObj), allOf: (v) => Array.isArray(v) && v.length > 0 && v.every(isObj),
  $defs: objOfObjs, definitions: objOfObjs, patternProperties: objOfObjs, properties: objOfObjs,
  required: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"),
};
const WEAK = {
  type: (v) => (Array.isArray(v) ? v.length > 0 && v.every((x) => JSON_TYPES.has(x)) : JSON_TYPES.has(v)),
  items: (v) => isObj(v) || (Array.isArray(v) && v.every(isObj)),
  additionalProperties: (v) => typeof v === "boolean" || isObj(v),
  $id: (v) => typeof v === "string", $ref: (v) => typeof v === "string",
};
export function kindOf(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (has(doc, "openapi") || has(doc, "swagger")) return "openapi";
  if (has(doc, "asyncapi")) return "asyncapi";
  if (typeof doc.$schema === "string" && /json-schema\.org/.test(doc.$schema)) return "jsonschema";
  if (Object.entries(STRONG).some(([k, ok]) => has(doc, k) && ok(doc[k]))) return "jsonschema";
  if (Object.entries(WEAK).filter(([k, ok]) => has(doc, k) && ok(doc[k])).length >= 2) return "jsonschema";
  return null;
}
const parseData = (path, text) => {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return parseJson(text);
  if (ext === ".yaml" || ext === ".yml") return parseYaml(text);
  return unsup(`no built-in parser for ${ext || path}`);
};
// Returns { format, model } or { format, unsupported: reason } or null when the file is not a contract.
export function load(path, text, { explicit = false } = {}) {
  const ext = extname(path).toLowerCase();
  if (text === null) return { format: null, model: null };
  try {
    if (SDL_EXT.includes(ext)) return { format: "graphql", model: parseGraphql(text) };
    if (ext === ".proto") return { format: "proto", model: parseProto(text) };
    if (OTHER_CONTRACT_EXT[ext]) return { format: OTHER_CONTRACT_EXT[ext], unsupported: `no built-in rules for ${OTHER_CONTRACT_EXT[ext]}` };
    if (ext === ".json" || ext === ".yaml" || ext === ".yml") {
      const doc = parseData(path, text);
      const k = kindOf(doc);
      if (!k) return explicit ? { format: ext === ".json" ? "json" : "yaml", unsupported: "not an OpenAPI, AsyncAPI or JSON Schema document" } : null;
      return { format: k, model: doc };
    }
    return explicit || CONTRACT_TEXT.test(text) ? { format: "unknown", unsupported: `no built-in parser for ${ext || "this file"}` } : null;
  } catch (e) {
    if (!(e instanceof Unsupported) && !(e instanceof SyntaxError)) throw e;
    if (!explicit && !CONTRACT_TEXT.test(text) && !CONTRACT_PATH.test(path) && !SDL_EXT.includes(ext) && ext !== ".proto") return null;
    const fmt = SDL_EXT.includes(ext) ? "graphql" : ext === ".proto" ? "proto" : ext === ".json" ? "json" : "yaml";
    return { format: fmt, unsupported: `cannot parse: ${e.message}` };
  }
}

// ---- external $ref bundling -------------------------------------------------------------------------
// Relative external references (`paths/orders.yaml#/get`) are loaded through `loadDoc(path)` and inlined
// under EXT_KEY, their own references rewritten, so a change inside a fragment file is classified where the
// root contract uses it. URLs, absolute paths and paths leaving the repository stay text (compared as text).
export const EXT_KEY = "x-contract-proof-external";
const FILE_OF = new WeakMap();
const posixJoin = (dir, rel) => {
  const out = [];
  for (const part of (dir ? dir.split("/") : []).concat(rel.split("/"))) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (!out.length || out[out.length - 1] === "..") out.push(".."); else out.pop(); } else out.push(part);
  }
  return out.join("/");
};
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export function bundle(root, rootPath, loadDoc) {
  const files = new Set(), unresolved = new Map();
  if (!root || typeof root !== "object") return { files, unresolved };
  const store = new Map();
  const seen = new WeakSet();
  const visit = (v, file) => {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x) => visit(x, file)); return; }
    FILE_OF.set(v, file);
    if (typeof v.$ref === "string") {
      const r = v.$ref, h = r.indexOf("#");
      const fpart = h < 0 ? r : r.slice(0, h), frag = h < 0 ? "" : r.slice(h + 1);
      if (frag !== "" && !frag.startsWith("/")) { /* anchor fragment: compared as text */ }
      else if (fpart === "") { if (file !== rootPath) v.$ref = `#/${EXT_KEY}/${esc(file)}${frag}`; }
      else if (!/^[a-z][a-z0-9+.-]*:/i.test(fpart) && !fpart.startsWith("//")) {
        // `/parts/x.yaml` is relative to the repository root, `x.yaml` to the referring file
        const target = fpart.startsWith("/") ? posixJoin("", fpart) : posixJoin(dirOf(file), fpart);
        if (!target.startsWith("..")) {
          if (!store.has(target)) {
            let d = null, why = null;
            try { d = loadDoc(target); if (d === null || d === undefined) { d = null; why = "file not found"; } } catch (e) {
              if (!(e instanceof Unsupported) && !(e instanceof SyntaxError)) throw e;
              why = `cannot parse: ${e.message}`;
            }
            store.set(target, d);
            if (d !== null) { files.add(target); if (target !== rootPath) visit(d, target); } else unresolved.set(target, why);
          }
          if (store.get(target) !== null) v.$ref = target === rootPath ? `#${frag}` : `#/${EXT_KEY}/${esc(target)}${frag}`;
        }
      }
    }
    for (const k of Object.keys(v)) if (k !== "$ref") visit(v[k], file);
  };
  visit(root, rootPath);
  const loaded = [...store].filter(([p, d]) => d !== null && p !== rootPath);
  if (loaded.length && !Array.isArray(root)) root[EXT_KEY] = Object.fromEntries(loaded);
  return { files, unresolved };
}

// ---- JSON / YAML structural diff ----------------------------------------------------------------
const DOC_KEYS = new Set(["description", "summary", "title", "example", "examples", "externalDocs", "$comment", "info", "tags", "contact", "license", "termsOfService", "x-examples"]);
const METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);
// keyword -> +1 when a larger value narrows (minimum), -1 when a smaller value narrows (maximum)
const NUMERIC = { maxLength: -1, maxItems: -1, maxProperties: -1, maximum: -1, exclusiveMaximum: -1, minLength: 1, minItems: 1, minProperties: 1, minimum: 1, exclusiveMinimum: 1 };
// added -> narrows, removed -> relaxes, changed -> neither is known: breaking on every side
const VALUE_CONSTRAINTS = new Set(["pattern", "format", "multipleOf", "const"]);
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
// side-dependent rule pick: [request, response]; side both takes the stricter (breaking first)
function pick(side, req, resp) {
  if (side === "request") return req;
  if (side === "response") return resp;
  return RULES[req][0] !== "non-breaking" ? req : resp;
}
const has = (t, k) => Object.prototype.hasOwnProperty.call(t, k);
const own = (t, k) => (t && typeof t === "object" && Object.prototype.hasOwnProperty.call(t, k) ? t[k] : undefined);
const unptr = (r) => r.slice(2).split("/").map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
// the name of a schema a reference points to (`#/components/schemas/Order` -> Order), else null
function schemaName(ref) {
  const s = unptr(ref);
  if (s[0] === EXT_KEY) s.splice(0, 2);
  if ((s[0] === "components" && s.length === 3 && s[1] !== "parameters" && s[1] !== "responses") || ((s[0] === "definitions" || s[0] === "$defs") && s.length === 2)) return s[s.length - 1];
  return null;
}
function derefFactory(root) {
  return (node, stack) => {
    let n = node; const seen = [...stack];
    while (isObj(n) && typeof n.$ref === "string" && Object.keys(n).length === 1) {
      const r = n.$ref;
      if (!r.startsWith("#/") || seen.includes(r)) return { node: n, ref: r, opaque: true, stack: seen };
      seen.push(r);
      let t = root; for (const s of unptr(r)) t = own(t, s);
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
      let t = root; for (const s of unptr(v.$ref)) t = own(t, s);
      walk(t, depth + 1);
    }
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  if (isObj(root)) for (const k of Object.keys(root)) if (!["components", "definitions", "$defs", EXT_KEY].includes(k)) walk(root[k], 0);
  return out;
}

// `q` is the qualified name of the place being compared: the named schema (Order), the operation
// (GET /orders/{id}) or the channel, then property names. A change's `element` is q joined by "." plus
// what changed; plan coverage needs that whole name, so `Order.id` never covers `User.id`.
export function diffDocs(base, head, kind, rootPath = null) {
  const changes = [];
  const dB = derefFactory(base || {}), dH = derefFactory(head || {});
  const reached = new Set([...reachedRefs(base || {}), ...reachedRefs(head || {})]);
  const el = (q, last) => [...q, ...(last === undefined ? [] : [String(last)])].join(".") || String(last ?? "/");
  const add = (rule, segs, side, before, after, line, element) => {
    const c = { location: ptr(segs), element, side, rule, classification: RULES[rule][0], before: brief(before), after: brief(after), line: line?.n ?? 1, line_in: line?.in ?? "head" };
    if (line?.file && line.file !== rootPath) c.line_file = line.file;
    changes.push(c);
  };
  const L = (pa, pb, k) => {
    const h = lineOf(pb, k); if (h) return { n: h, in: "head", file: FILE_OF.get(pb) };
    const b = lineOf(pa, k); return b ? { n: b, in: "base", file: FILE_OF.get(pa) } : undefined;
  };
  // a named schema reached through the references just followed renames the place
  const requal = (q, sa0, ra, sb0, rb) => {
    for (const [st, s0] of [[rb.stack, sb0], [ra.stack, sa0]]) for (let i = st.length - 1; i >= s0.length; i--) { const n = schemaName(st[i]); if (n) return [n]; }
    return q;
  };

  const walk = (a, b, segs, side, sa, sb, pa, pb, key, q) => {
    const ra = dB(a, sa), rb = dH(b, sb);
    a = ra.node; b = rb.node;
    q = requal(q, sa, ra, sb, rb);
    if (ra.opaque || rb.opaque) { if (!deq(a, b)) add("CP-U01", segs, side, a, b, L(pa, pb, key), el(q)); return; }
    if (deq(a, b) && !hasRef(a) && !hasRef(b)) return;
    if (!isObj(a) || !isObj(b)) {
      if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) { a.forEach((x, i) => walk(x, b[i], [...segs, i], side, ra.stack, rb.stack, a, b, i, q)); return; }
      add("CP-U01", segs, side, a, b, L(pa, pb, key), el(q)); return;
    }
    const top = segs.length === 0;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const va = own(a, k), vb = own(b, k), s = [...segs, k], ln = L(a, b, k);
      if (top && k === EXT_KEY) continue; // fragments are compared where the contract references them
      if (k === "properties") { diffProps(a, b, s, side, ra.stack, rb.stack, q); continue; } // before the equality skip: `required` may differ
      if (deq(va, vb) && !hasRef(va) && !hasRef(vb)) continue;
      if (top && (k === "components" || k === "definitions" || k === "$defs") && isObj(va ?? {}) && isObj(vb ?? {})) {
        // only the definitions no path, channel or root schema reaches; reached ones are diffed where used
        const sects = k === "components" ? [...new Set([...Object.keys(va || {}), ...Object.keys(vb || {})])] : [null];
        for (const sec of sects) {
          const ca = (sec ? va?.[sec] : va) || {}, cb = (sec ? vb?.[sec] : vb) || {};
          if (!isObj(ca) || !isObj(cb)) { if (!deq(ca, cb)) add("CP-U01", sec ? [k, sec] : [k], "both", ca, cb, ln, el([k], sec ?? undefined)); continue; }
          for (const n of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
            const ref = "#/" + [k, ...(sec ? [sec] : []), n].map(esc).join("/");
            if (reached.has(ref)) continue;
            const ss = [k, ...(sec ? [sec] : []), n], l2 = L(ca, cb, n);
            if (!has(cb, n)) add("CP-B01", ss, "both", "present", undefined, l2, n);
            else if (!has(ca, n)) add("CP-N02", ss, "both", undefined, "present", l2, n);
            else walk(ca[n], cb[n], ss, "both", ra.stack, rb.stack, ca, cb, n, [n]);
          }
        }
        continue;
      }
      if (DOC_KEYS.has(k) && !(k === "title" && isObj(va ?? vb))) { if (!deq(va, vb)) add("CP-N05", s, side, va, vb, ln, top ? k : el(q)); continue; }
      if (k === "deprecated") { add("CP-N08", s, side, va, vb, ln, el(q)); continue; }
      if (k === "paths" || k === "channels") { diffNamed(va || {}, vb || {}, s, side, "CP-B01", "CP-N02", ra.stack, rb.stack, (n) => [n]); continue; }
      if (segs[segs.length - 2] === "paths" && METHODS.has(k)) {
        const op = [`${k.toUpperCase()} ${segs[segs.length - 1]}`];
        if (va === undefined) add("CP-N02", s, side, undefined, "present", ln, op[0]);
        else if (vb === undefined) add("CP-B01", s, side, "present", undefined, ln, op[0]);
        else walk(va, vb, s, side, ra.stack, rb.stack, a, b, k, op);
        continue;
      }
      if (k === "parameters" && (Array.isArray(va) || Array.isArray(vb))) { diffParams(va || [], vb || [], s, ra.stack, rb.stack, q); continue; }
      if (k === "requestBody") {
        if (va === undefined || vb === undefined) {
          const rq = (vb && dH(vb, rb.stack).node?.required) === true;
          add(va === undefined ? (rq ? "CP-B05" : "CP-N01") : "CP-B07", s, "request", va === undefined ? undefined : "present", vb === undefined ? undefined : "present", ln, el(q, "requestBody"));
        } else walk(va, vb, s, "request", ra.stack, rb.stack, a, b, k, q);
        continue;
      }
      if (k === "responses" && segs.length && METHODS.has(segs[segs.length - 1])) { diffNamed(va || {}, vb || {}, s, "response", "CP-B08", "CP-N07", ra.stack, rb.stack, null, q); continue; }
      if (k === "content" || k === "headers") {
        diffNamed(va || {}, vb || {}, s, side, k === "content" ? "CP-B03" : "CP-B07", "CP-N01", ra.stack, rb.stack, null, q); continue;
      }
      if (k === "required" && Array.isArray(va ?? vb)) {
        // names without a property schema change requiredness here; the others are diffed with properties
        const pa = isObj(a.properties) ? dB(a.properties, ra.stack).node : {}, pb = isObj(b.properties) ? dH(b.properties, rb.stack).node : {};
        const sa = new Set(Array.isArray(va) ? va : []), sb = new Set(Array.isArray(vb) ? vb : []);
        for (const n of new Set([...sa, ...sb])) {
          if (sa.has(n) === sb.has(n) || (isObj(pa) && has(pa, n)) || (isObj(pb) && has(pb, n))) continue;
          add(sb.has(n) ? pick(side, "CP-B05", "CP-N06") : pick(side, "CP-N06", "CP-B04"), [...s, n], side, sa.has(n) ? "required" : null, sb.has(n) ? "required" : null, ln, el(q, n));
        }
        continue;
      }
      if (k === "required" && (typeof va === "boolean" || typeof vb === "boolean")) {
        const was = va === true, now = vb === true;
        if (was !== now) add(now ? pick(side, "CP-B04", "CP-N06") : pick(side, "CP-N06", "CP-B04"), s, side, va, vb, ln, el(q));
        continue;
      }
      if (k === "enum") { diffEnum(va || [], vb || [], s, side, a, b, q); continue; }
      if (k === "type") { diffType(va, vb, s, side, ln, q); continue; }
      if (k === "nullable") { const now = vb === true, was = va === true; if (now !== was) add(now ? pick(side, "CP-N06", "CP-B09") : pick(side, "CP-B09", "CP-N06"), s, side, va, vb, ln, el(q)); continue; }
      if (k in NUMERIC && (typeof (va ?? 0) === "number") && (typeof (vb ?? 0) === "number")) {
        const dir = NUMERIC[k];
        const narrows = va === undefined ? true : vb === undefined ? false : (vb - va) * dir > 0;
        add(narrows ? pick(side, "CP-B09", "CP-N06") : pick(side, "CP-N06", "CP-B09"), s, side, va, vb, ln, el(q)); continue;
      }
      if (VALUE_CONSTRAINTS.has(k)) {
        // a changed pattern/format/const accepts different values: no side can tolerate it
        const rule = va === undefined ? pick(side, "CP-B09", "CP-N06") : vb === undefined ? pick(side, "CP-N06", "CP-B09") : "CP-B09";
        add(rule, s, side, va, vb, ln, el(q)); continue;
      }
      if (k === "additionalProperties" && typeof (va ?? true) === "boolean" && typeof (vb ?? true) === "boolean") {
        const narrows = vb === false; add(narrows ? pick(side, "CP-B09", "CP-N06") : pick(side, "CP-N06", "CP-B09"), s, side, va, vb, ln, el(q)); continue;
      }
      if (k === "uniqueItems") { add(vb === true ? pick(side, "CP-B09", "CP-N06") : pick(side, "CP-N06", "CP-B09"), s, side, va, vb, ln, el(q)); continue; }
      if ((k === "oneOf" || k === "anyOf") && Array.isArray(va) && Array.isArray(vb) && va.length !== vb.length) {
        // union membership (A94): a removed member is CP-B06 on any side, an added one CP-N03 (request) or CP-N04
        const nm = (m, i) => `${k}[${isObj(m) && typeof m.$ref === "string" ? m.$ref.split("/").pop() : i}]`;
        const used = new Set();
        va.forEach((m, i) => {
          const j = vb.findIndex((x, jj) => !used.has(jj) && deq(m, x));
          if (j >= 0) used.add(j);
          else add("CP-B06", [...s, i], side, m, undefined, { n: lineOf(va, i) ?? ln?.n ?? 1, in: "base", file: FILE_OF.get(a) }, el(q, nm(m, i)));
        });
        vb.forEach((m, j) => { if (!used.has(j) && !va.some((x) => deq(x, m))) add(side === "request" ? "CP-N03" : "CP-N04", [...s, j], side, undefined, m, { n: lineOf(vb, j) ?? ln?.n ?? 1, in: "head", file: FILE_OF.get(b) }, el(q, nm(m, j))); });
        continue;
      }
      if (va === undefined || vb === undefined) {
        if (isObj(va ?? vb)) { walk(va ?? {}, vb ?? {}, s, side, ra.stack, rb.stack, a, b, k, q); continue; }
        add("CP-U01", s, side, va, vb, ln, el(q, k)); continue;
      }
      walk(va, vb, s, side, ra.stack, rb.stack, a, b, k, q);
    }
  };
  // named children (paths, channels, status codes, media types, headers); `rename(n)` gives the child's q
  const diffNamed = (A, B, segs, side, removed, added, sa, sb, rename, q = []) => {
    A = dB(A, sa).node; B = dH(B, sb).node;
    if (!isObj(A) || !isObj(B)) { add("CP-U01", segs, side, A, B, undefined, el(q)); return; }
    for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const s = [...segs, n], ln = L(A, B, n), name = rename ? el(rename(n)) : el(q, n);
      if (!has(B, n)) add(removed, s, side, "present", undefined, ln, name);
      else if (!has(A, n)) add(added, s, side, undefined, "present", ln, name);
      else walk(A[n], B[n], s, side, sa, sb, A, B, n, rename ? rename(n) : q);
    }
  };
  const diffParams = (A, B, segs, sa, sb, q) => {
    const keyed = (arr, d, st) => { const m = new Map(); arr.forEach((p, i) => { const r = d(p, st).node; m.set(isObj(r) ? `${r.in}:${r.name}` : `#${i}`, { p, r, i, arr }); }); return m; };
    const mA = keyed(A, dB, sa), mB = keyed(B, dH, sb);
    for (const k of new Set([...mA.keys(), ...mB.keys()])) {
      const x = mA.get(k), y = mB.get(k); const name = (y || x).r?.name ?? k;
      const s = [...segs, name];
      const ln = y ? { n: lineOf(y.arr, y.i) ?? 1, in: "head", file: FILE_OF.get(y.arr) } : { n: lineOf(x.arr, x.i) ?? 1, in: "base", file: FILE_OF.get(x.arr) };
      if (!y) add("CP-B07", s, "request", "present", undefined, ln, el(q, name));
      else if (!x) add(y.r?.required === true ? "CP-B05" : "CP-N01", s, "request", undefined, "present", ln, el(q, name));
      else walk(x.p, y.p, s, "request", sa, sb, x.arr, y.arr, x.i, [...q, name]);
    }
  };
  const diffProps = (a, b, segs, side, sa, sb, q) => {
    const A = dB(a.properties || {}, sa).node, B = dH(b.properties || {}, sb).node;
    const rA = new Set(Array.isArray(a.required) ? a.required : []), rB = new Set(Array.isArray(b.required) ? b.required : []);
    for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
      const s = [...segs, n], ln = L(A, B, n), name = el(q, n);
      if (!has(B, n)) { add("CP-B02", s, side, "present", undefined, ln, name); continue; }
      if (!has(A, n)) { add(rB.has(n) ? pick(side, "CP-B05", "CP-N01") : "CP-N01", s, side, undefined, rB.has(n) ? "required" : "optional", ln, name); continue; }
      if (rA.has(n) !== rB.has(n)) add(rB.has(n) ? pick(side, "CP-B04", "CP-N06") : pick(side, "CP-N06", "CP-B04"), s, side, rA.has(n) ? "required" : "optional", rB.has(n) ? "required" : "optional", ln, name);
      walk(A[n], B[n], s, side, sa, sb, A, B, n, [...q, n]);
    }
  };
  const diffEnum = (A, B, segs, side, pa, pb, q) => {
    const key = (v) => JSON.stringify(v);
    const kA = new Map(A.map((v, i) => [key(v), i])), kB = new Map(B.map((v, i) => [key(v), i]));
    for (const [k, i] of kA) if (!kB.has(k)) add("CP-B06", [...segs, A[i]], side, A[i], undefined, { n: lineOf(A, i) ?? lineOf(pa, "enum") ?? 1, in: "base", file: FILE_OF.get(pa) }, el(q, A[i]));
    for (const [k, i] of kB) if (!kA.has(k)) add(side === "request" ? "CP-N03" : "CP-N04", [...segs, B[i]], side, undefined, B[i], { n: lineOf(B, i) ?? lineOf(pb, "enum") ?? 1, in: "head", file: FILE_OF.get(pb) }, el(q, B[i]));
  };
  const diffType = (va, vb, segs, side, ln, q) => {
    const A = new Set([].concat(va ?? [])), B = new Set([].concat(vb ?? []));
    if (va === undefined || vb === undefined) { add(va === undefined ? pick(side, "CP-B03", "CP-N06") : pick(side, "CP-N06", "CP-B03"), segs, side, va, vb, ln, el(q)); return; }
    const lost = [...A].some((t) => !B.has(t) && !(t === "integer" && B.has("number")));
    const gained = [...B].some((t) => !A.has(t) && !(t === "integer" && A.has("number")));
    const rule = lost && gained ? "CP-B03" : lost ? pick(side, "CP-B03", "CP-N06") : pick(side, "CP-N06", "CP-B03");
    add(rule, segs, side, va, vb, ln, el(q));
  };
  void kind; // every root starts on side both; requestBody/parameters/responses set the side below
  if (rootPath) { FILE_OF.set(base || {}, rootPath); FILE_OF.set(head || {}, rootPath); }
  walk(base || {}, head || {}, [], "both", [], [], null, null, null, []);
  return changes;
}

// ---- GraphQL SDL (line level) -------------------------------------------------------------------
// shortcut: one field or argument list per line; a single-line body (`type A { a: Int }`, `enum E { A B }`)
// is split, anything more (multi-line argument lists, several fields on one line) is UNSUPPORTED; upgrade
// with a tokenizer when a project needs it.
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
  const stmts = [];
  clean.forEach((t, n) => {
    const m = /^((?:extend\s+)?(?:type|input|interface|enum)\s+[A-Za-z_]\w*[^{]*|schema\s*)\{(.*)\}$/.exec(t);
    if (!m) { stmts.push([t, n + 1]); return; }
    stmts.push([`${m[1].trim()} {`, n + 1]);
    const inner = m[2].trim();
    if (inner) for (const x of /^enum\s/.test(m[1]) ? inner.split(/[\s,]+/) : [inner]) stmts.push([x, n + 1]);
    stmts.push(["}", n + 1]);
  });
  stmts.forEach(([t, line]) => {
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
  const dirChange = (loc, el, side, a, b, line) => { if (a === b) return; add(deprecOnly(a, b) ? "CP-N08" : "CP-U01", `${loc} directives`, el, side, a || null, b || null, line, "head"); };
  for (const n of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const x = A[n], y = B[n];
    if (!y) { add("CP-B01", n, n, "both", x.kind, null, x.line, "base"); continue; }
    if (!x) { add("CP-N02", n, n, "both", null, y.kind, y.line, "head"); continue; }
    if (x.kind !== y.kind) { add("CP-B03", n, n, "both", x.kind, y.kind, y.line, "head"); continue; }
    if (x.head !== y.head) dirChange(n, n, "both", x.head, y.head, y.line);
    const fside = x.kind === "input" ? "request" : "response";
    for (const f of new Set([...Object.keys(x.fields), ...Object.keys(y.fields)])) {
      const p = x.fields[f], q = y.fields[f], loc = `${n}.${f}`;
      if (!q) { add("CP-B02", loc, loc, fside, p.type, null, p.line, "base"); continue; }
      if (!p) {
        const r = fside === "request" ? (q.type.endsWith("!") ? (q.default !== null ? "CP-N10" : "CP-B05") : "CP-N01") : "CP-N01";
        add(r, loc, loc, fside, null, q.type, q.line, "head"); continue;
      }
      if (p.type !== q.type) add(gqlTypeRule(p.type, q.type, fside), loc, loc, fside, p.type, q.type, q.line, "head");
      if (p.default !== q.default) add("CP-U01", `${loc} default`, loc, fside, p.default, q.default, q.line, "head");
      dirChange(loc, loc, fside, p.directives, q.directives, q.line);
      for (const g of new Set([...Object.keys(p.args), ...Object.keys(q.args)])) {
        const u = p.args[g], v = q.args[g], al = `${loc}(${g})`;
        if (!v) { add("CP-B07", al, al, "request", u.type, null, u.line, "base"); continue; }
        if (!u) { add(v.type.endsWith("!") ? (v.default !== null ? "CP-N10" : "CP-B05") : "CP-N01", al, al, "request", null, v.type, v.line, "head"); continue; }
        if (u.type !== v.type) add(gqlTypeRule(u.type, v.type, "request"), al, al, "request", u.type, v.type, v.line, "head");
        if (u.default !== v.default) add("CP-U01", `${al} default`, al, "request", u.default, v.default, v.line, "head");
        dirChange(al, al, "request", u.directives, v.directives, v.line);
      }
    }
    for (const v of new Set([...Object.keys(x.values), ...Object.keys(y.values)])) {
      const p = x.values[v], q = y.values[v], loc = `${n}.${v}`;
      if (!q) add("CP-B06", loc, loc, "both", v, null, p.line, "base");
      else if (!p) add("CP-N04", loc, loc, "both", null, v, q.line, "head");
      else dirChange(loc, loc, "both", p.directives, q.directives, q.line);
    }
  }
  return ch;
}

// ---- protobuf (line level) ----------------------------------------------------------------------
// Statements are split at `{`, `;` and `}` (outside strings), so `message A { string a = 1; }` parses.
// shortcut: a statement spanning lines, `extend` and groups are UNSUPPORTED; upgrade with a tokenizer
// when a project needs them.
export function parseProto(text) {
  let s = text.replace(/\r\n?/g, "\n");
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const stmts = [];
  s.split("\n").forEach((l, i) => {
    let cur = "", q = null;
    const flush = (x) => { const t = (cur + x).trim(); if (t !== "" && t !== ";") stmts.push([t, i + 1]); cur = ""; };
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      if (q) { cur += c; if (c === "\\") { cur += l[++j] ?? ""; } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === "/" && l[j + 1] === "/") break;
      if (c === "{" || c === ";") flush(c);
      else if (c === "}") { flush(""); stmts.push(["}", i + 1]); }
      else cur += c;
    }
    if (cur.trim() !== "") unsup(`statement continues past line ${i + 1}`);
  });
  const M = { meta: {}, options: [], messages: {}, enums: {}, services: {} };
  const stack = [];
  const scopeName = (n) => [...stack.filter((x) => x.kind !== "oneof").map((x) => x.name), n].join(".");
  stmts.forEach(([t, line]) => {
    const top = stack[stack.length - 1];
    if (t === "}") { if (!stack.length) unsup(`unbalanced } at line ${line}`); stack.pop(); return; }
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
      m = /^rpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*(;|\{)$/.exec(t);
      if (!m) unsup(`cannot parse rpc at line ${line}`);
      const rpc = top.node.rpcs[m[1]] = { req: `${m[2] ? "stream " : ""}${m[3]}`, resp: `${m[4] ? "stream " : ""}${m[5]}`, options: [], line };
      if (m[6] === "{") stack.push({ kind: "rpc", name: m[1], node: rpc });
      return;
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
      if (!q) { add("CP-B02", loc, loc, `${p.type} = ${p.number}`, null, p.line, "base"); continue; }
      if (!p) { add(q.label === "required" ? "CP-B05" : "CP-N01", loc, loc, null, `${q.type} = ${q.number}`, q.line, "head"); continue; }
      if (p.number !== q.number) add("CP-B10", loc, loc, p.number, q.number, q.line, "head");
      if (p.type !== q.type) add("CP-B03", loc, loc, p.type, q.type, q.line, "head");
      if (p.label !== q.label) add((p.label === "repeated") !== (q.label === "repeated") ? "CP-B03" : p.label === "required" || q.label === "required" ? "CP-B04" : "CP-U01", loc, loc, p.label || "(none)", q.label || "(none)", q.line, "head");
      if (p.oneof !== q.oneof) add("CP-U01", `${loc} oneof`, loc, p.oneof, q.oneof, q.line, "head");
      if (p.opts !== q.opts) add(optDeprecOnly(p.opts, q.opts) ? "CP-N08" : "CP-U01", `${loc} options`, loc, p.opts || null, q.opts || null, q.line, "head");
    }
    for (const r of new Set([...x.reserved, ...y.reserved])) {
      if (!x.reserved.has(r)) add("CP-N09", `${n}.reserved(${r})`, `${n}.reserved(${r})`, null, r, y.line, "head");
      else if (!y.reserved.has(r)) add("CP-U01", `${n}.reserved(${r})`, `${n}.reserved(${r})`, r, null, x.line, "base");
    }
  });
  named(A.enums, B.enums, "enum", (n, x, y) => {
    for (const v of new Set([...Object.keys(x.values), ...Object.keys(y.values)])) {
      const p = x.values[v], q = y.values[v], loc = `${n}.${v}`;
      if (!q) add("CP-B06", loc, loc, p.number, null, p.line, "base");
      else if (!p) add("CP-N04", loc, loc, null, q.number, q.line, "head");
      else {
        if (p.number !== q.number) add("CP-B10", loc, loc, p.number, q.number, q.line, "head");
        if (p.opts !== q.opts) add(optDeprecOnly(p.opts, q.opts) ? "CP-N08" : "CP-U01", `${loc} options`, loc, p.opts || null, q.opts || null, q.line, "head");
      }
    }
  });
  named(A.services, B.services, "service", (n, x, y) => {
    for (const r of new Set([...Object.keys(x.rpcs), ...Object.keys(y.rpcs)])) {
      const p = x.rpcs[r], q = y.rpcs[r], loc = `${n}.${r}`;
      if (!q) add("CP-B01", loc, loc, `${p.req} -> ${p.resp}`, null, p.line, "base");
      else if (!p) add("CP-N02", loc, loc, null, `${q.req} -> ${q.resp}`, q.line, "head");
      else {
        if (p.req !== q.req || p.resp !== q.resp) add("CP-B03", loc, loc, `${p.req} -> ${p.resp}`, `${q.req} -> ${q.resp}`, q.line, "head");
        const oa = [...p.options].sort().join("; "), ob = [...q.options].sort().join("; ");
        if (oa !== ob) add(optDeprecOnly(oa.replace(/;/g, ","), ob.replace(/;/g, ",")) ? "CP-N08" : "CP-U01", `${loc} options`, loc, oa || null, ob || null, q.line, "head");
      }
    }
  });
  return ch;
}

// ---- one file -----------------------------------------------------------------------------------
const EMPTY = { graphql: {}, proto: { meta: {}, options: [], messages: {}, enums: {}, services: {} } };
const DATA_EXT = /\.(ya?ml|json)$/i;
// Returns { row, fragments, unresolved } or null when the file is not a contract. `loadBase`/`loadHead`
// load a repository-relative path of that side (text or null) for external $ref fragments.
export function diffFile(path, baseText, headText, { explicit = false, loadBase = null, loadHead = null } = {}) {
  const b = baseText === null ? null : load(path, baseText, { explicit });
  const h = headText === null ? null : load(path, headText, { explicit });
  if (!b && !h) return null;
  const change = baseText === null ? "added" : headText === null ? "deleted" : "modified";
  const bad = [b, h].find((x) => x && x.unsupported);
  const format = (h && h.format) || (b && b.format);
  const none = { fragments: new Set(), unresolved: new Map() };
  if (bad) return { row: { path, format: bad.format, change, status: "unsupported", reason: bad.unsupported, changes: [] }, ...none };
  if (b && h && b.format !== h.format) return { row: { path, format, change, status: "unsupported", reason: `format changed from ${b.format} to ${h.format}`, changes: [] }, ...none };
  const bm = b ? b.model : (EMPTY[format] ?? {}), hm = h ? h.model : (EMPTY[format] ?? {});
  const fragments = new Set(), unresolved = new Map();
  if (format !== "graphql" && format !== "proto") {
    for (const [m, ld] of [[bm, loadBase], [hm, loadHead]]) {
      if (!ld) continue;
      const r = bundle(m, path, (p) => { const t = ld(p); return t === null ? null : parseData(p, t); });
      for (const f of r.files) fragments.add(f);
      for (const [f, why] of r.unresolved) unresolved.set(f, why);
    }
  }
  const changes = format === "graphql" ? diffGraphql(bm, hm) : format === "proto" ? diffProto(bm, hm) : diffDocs(bm, hm, format, path);
  const row = { path, format, change, status: "compared", changes };
  if (fragments.size) row.fragments = [...fragments].filter((f) => f !== path).sort();
  return { row, fragments, unresolved };
}

// ---- PLAN.md ## Contracts coverage --------------------------------------------------------------
// Bullets of the `## Contracts` section: any heading of level 1-2 ends it; an H3+ child counts unless it is
// a non-goals or out-of-scope heading (with its own children); fenced code and HTML comments never count.
export function planBullets(text) {
  const out = []; let inContracts = false, offLevel = null, fence = null, comment = false;
  text.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    let l = raw;
    if (fence) { if (l.trim().startsWith(fence)) fence = null; return; }
    if (comment) { const e = l.indexOf("-->"); if (e < 0) return; comment = false; l = l.slice(e + 3); }
    l = l.replace(/<!--.*?-->/g, "");
    const open = l.indexOf("<!--"); if (open >= 0) { comment = true; l = l.slice(0, open); }
    const f = /^\s*(```|~~~)/.exec(l); if (f) { fence = f[1]; return; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      const level = h[1].length, title = h[2];
      if (level <= 2) { inContracts = level === 2 && /^Contracts$/i.test(title); offLevel = null; }
      else if (inContracts && (offLevel === null || level <= offLevel)) offLevel = /non-goals?|out of scope/i.test(title) ? level : null;
      return;
    }
    if (inContracts && offLevel === null && /^\s*([-*]|\d+[.)])\s+/.test(l)) out.push({ line: i + 1, text: l.trim() });
  });
  return out;
}
// a whole token: not glued to a longer path, name or qualified name (`b/openapi.yaml` is not
// `openapi.yaml`, `User.id` is not `id`); a sentence-ending dot is allowed after it
export const hasToken = (text, tok) => {
  const e = String(tok).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_./{}-])${e}(?=$|[^A-Za-z0-9_./{}-]|\\.(\\s|$))`).test(text);
};
// a negation anywhere in the clause that carries the element and the keyword voids it
const NEGATION = /(?<![\w@/.-])(no|not|never|none|nothing|neither|nor|without|cannot|lacks?|unnecessary|needless|skip(ped|s)?|avoid(s|ed|ing)?|defer(s|red|ring)?|pending|tbd|todo|reject(s|ed|ing)?|forgo(es|ne|ing)?|drop(s|ped|ping)?|revert(s|ed|ing)?|except|impossible|later|unknown|nil)(?![\w@/-]|\.\w)|\bn\/?a\b|\bw\/o\b|\bout[- ]of[- ]scope\b|\bas[- ]is\b|[=:]\s*(0|no|nil|null|off)\b|\binstead of\b|\bout of scope\b|n't\b|\b(non|un)-?(version|migrat|deprecat)|[=:]\s*false\b|\?/i;
// clauses end at `;` or at a sentence dot (`Order.id` and `openapi.yaml` keep theirs)
const clauses = (t) => t.split(/;|\.(?=\s|$)/);
// a bare element (`id`, `name`, an enum value) only counts as a code span, never as any word
const namesElement = (clause, element) => (/[./( ]/.test(element) ? hasToken(clause, element) : clause.includes("`" + element + "`"));
// The coverage rule (RULES.md#coverage-by-the-plan): the bullet names the exact repository path, the whole
// qualified element, and states versioning, migration or deprecation that is not negated and is not just
// `info.version`.
export function coverage(path, change, bullets) {
  const none = { covered: false, plan_line: null, text: null };
  if (!BLOCKING_CLASSES.includes(change.classification)) return none;
  const b = bullets.find((x) => hasToken(x.text, path) && clauses(x.text).some((c) => {
    const words = c.replace(/info\.version/gi, " ");
    // the element's own name (`skip-list`, `no-case`) is not a negation of it
    const bare = words.split("`" + change.element + "`").join(" ").split(change.element).join(" ");
    return namesElement(c, change.element) && COVER_KEYWORD.test(words) && !NEGATION.test(bare);
  }));
  return b ? { covered: true, plan_line: b.line, text: b.text } : none;
}

// ---- consumers from an evidence-map impact report -----------------------------------------------
// the identifier code uses: `Order.customerEmail` -> customerEmail, `Customer.orders(status)` -> status
export const leafOf = (element) => String(element).replace(/\)$/, "").split(/[.(\s]/).filter(Boolean).pop() || String(element);
export function consumersFrom(impact, element) {
  const leaf = leafOf(element);
  const syms = (impact?.symbols || []).filter((s) => s.name === leaf || String(s.name).endsWith(`.${leaf}`));
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
  const dirs = [...(process.env.PATH || "").split(delimiter), ...(repo ? [join(repo, "node_modules", ".bin")] : [])].filter((d) => d !== "");
  const found = [];
  for (const t of TOOLS) for (const d of dirs) {
    try { const f = join(d, t.name); if (existsSync(f) && statSync(f).isFile()) { found.push({ name: t.name, path: f, formats: t.formats }); break; } } catch { /* unreadable PATH entry */ }
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
// Config files that are never contracts; a changed one is listed under `ignored` with the reason, unless a
// `$ref` somewhere names it. Everything else that is changed JSON/YAML and not a contract is UNSUPPORTED.
export const NOT_A_CONTRACT = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|composer\.json|(ts|js)config[^/]*\.json|openapitools\.json|openapi-generator-config\.ya?ml|\.eslintrc[^/]*|\.prettierrc[^/]*|\.babelrc[^/]*|babel\.config\.json|\.stylelintrc[^/]*|\.markdownlint[^/]*|lerna\.json|nx\.json|turbo\.json|renovate\.json|deno\.jsonc?|bower\.json|pnpm-(lock|workspace)\.yaml|\.pre-commit-config\.yaml|\.gitlab-ci\.yml|docker-compose[^/]*\.ya?ml|compose\.ya?ml|mkdocs\.ya?ml|\.readthedocs\.ya?ml|codecov\.ya?ml|dependabot\.ya?ml)$|^\.github\/(workflows|actions|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE|DISCUSSION_TEMPLATE)\/|^\.github\/(dependabot|labeler|release|stale|FUNDING|config)\.ya?ml$|^(\.vscode|\.idea|\.agents|\.devcontainer)\//i;
// gitignore-like globs of `.agents/config.yaml` (`**` spans directories, a pattern without / matches at any depth)
export function globRe(g) {
  let p = g.includes("/") ? g : `**/${g}`, r = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") { if (p[i + 1] === "*") { if (p[i + 2] === "/") { r += "(.*/)?"; i += 2; } else { r += ".*"; i++; } } else r += "[^/]*"; }
    else if (c === "?") r += "[^/]";
    else r += /[.+()|^$[\]{}\\]/.test(c) ? "\\" + c : c;
  }
  return new RegExp(`^${r}$`);
}
export const globMatch = (path, globs) => globs.some((g) => globRe(g).test(path));
// contract.paths / contract.ignore of `.agents/config.yaml` (A83; frozen with the risk mapping)
export function contractSettings(repo) {
  const out = { paths: [], ignore: [] };
  let t; try { t = readFileSync(join(repo, ".agents", "config.yaml"), "utf8"); } catch { return out; }
  let inBlock = false;
  for (const l of t.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\S/.test(l)) { inBlock = /^contract:\s*(#.*)?$/.test(l); continue; }
    const m = inBlock && /^ {2}(paths|ignore):\s*(.*?)\s*(#.*)?$/.exec(l);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1").split(/\s+/).filter(Boolean);
  }
  return out;
}
// JSON/YAML files of the working tree that parse as a contract (any kind, they may reference a changed
// fragment) and the file names any `$ref` in a JSON/YAML file names
function scanRepo(repo) {
  const all = [...git(repo, ["ls-files"]).split("\n"), ...git(repo, ["ls-files", "--others", "--exclude-standard"]).split("\n")];
  const roots = [], refNames = new Set();
  for (const p of [...new Set(all)].filter((x) => DATA_EXT.test(x)).sort()) {
    try { if (statSync(join(repo, p)).size > 4 << 20) continue; } catch { continue; }
    const t = readHead(repo, p); if (t === null) continue;
    for (const m of t.matchAll(/["']?\$ref["']?\s*:\s*["']?([^"'#\s,}]+)/g)) refNames.add(basename(m[1]));
    try { if (kindOf(parseData(p, t))) roots.push(p); } catch (e) { if (!(e instanceof Unsupported) && !(e instanceof SyntaxError)) throw e; }
  }
  return { roots, refNames };
}
export function run(opts) {
  const rows = new Map(), report = { ignored: [] }, settings = { paths: [], ignore: [] };
  const bullets = opts.plan ? planBullets(readFileSync(opts.plan, "utf8")) : [];
  const impact = opts.impact ? JSON.parse(readFileSync(opts.impact, "utf8")) : null;
  if (opts.baseFile || opts.headFile) {
    const p = opts.name || basename(opts.headFile || opts.baseFile);
    const side = (f) => (f ? (rel) => { try { return readFileSync(join(dirname(f), rel), "utf8"); } catch { return null; } } : null);
    const r = diffFile(p, opts.baseFile ? readFileSync(opts.baseFile, "utf8") : null, opts.headFile ? readFileSync(opts.headFile, "utf8") : null,
      { explicit: true, loadBase: side(opts.baseFile), loadHead: side(opts.headFile) });
    if (r) rows.set(p, r.row);
  } else {
    const changed = changedPaths(opts.repo, opts.base);
    // A94: --path is additive to discovery; a named path must be a changed file or it is UNSUPPORTED
    const named = new Set(opts.paths.map((p) => p.replace(/^\.\//, "")));
    const want = [...new Set([...changed.keys(), ...named])];
    const loadBase = (p) => show(opts.repo, opts.base, p), loadHead = (p) => readHead(opts.repo, p);
    const fragOf = new Map(), unresolved = new Map();
    const diffRoot = (p, c, isExplicit) => {
      const r = diffFile(p, c.base ? show(opts.repo, opts.base, c.base) : null, c.head ? readHead(opts.repo, c.head) : null, { explicit: isExplicit, loadBase, loadHead });
      if (!r) return null;
      for (const f of r.fragments) if (f !== p) (fragOf.get(f) || fragOf.set(f, new Set()).get(f)).add(p);
      for (const [f, why] of r.unresolved) if (!unresolved.has(f)) unresolved.set(f, `${why} (referenced from ${p})`);
      return r;
    };
    const unknown = [], ignored = [];
    Object.assign(settings, contractSettings(opts.repo));
    for (const p of [...want].sort()) {
      const c = changed.get(p);
      const explicit = named.has(p);
      if (!c) {
        const exists = show(opts.repo, opts.base, p) !== null || readHead(opts.repo, p) !== null;
        rows.set(p, { path: p, format: "unknown", change: "unchanged", status: "unsupported", reason: exists ? "named by --path but not changed against the base: nothing was compared" : "named by --path but not found at the base or in the working tree (mistyped?)", changes: [] });
        continue;
      }
      // parse first: a file on the not-a-contract list or under contract.ignore is skipped only when it is
      // not a contract; a recognized contract is always compared (`.github/openapi.yaml` too)
      const forced = globMatch(p, settings.paths);
      const r = diffRoot(p, c, explicit || forced);
      const skippable = !explicit && !forced && (NOT_A_CONTRACT.test(p) || globMatch(p, settings.ignore));
      const claims = () => [c.base ? show(opts.repo, opts.base, c.base) : null, c.head ? readHead(opts.repo, c.head) : null].some((t) => t !== null && CONTRACT_TEXT.test(t));
      if (r && (r.row.status === "compared" || !skippable || claims())) rows.set(p, r.row); else if (DATA_EXT.test(p)) unknown.push(p);
    }
    // a changed standalone-looking schema may really be a fragment of a root contract: check those too
    const maybeFragment = [...unknown, ...[...rows.values()].filter((r) => r.format === "jsonschema" && changed.has(r.path)).map((r) => r.path)];
    if (maybeFragment.length) {
      const scan = scanRepo(opts.repo);
      // an unchanged root contract (of any kind) whose external $ref reaches a changed file is compared too
      for (const p of scan.roots) {
        if (rows.has(p) || unknown.includes(p)) continue;
        const r = diffRoot(p, changed.get(p) || { base: p, head: p }, false);
        if (r && maybeFragment.some((u) => r.fragments.has(u))) { if (!changed.has(p)) r.row.change = "unchanged"; rows.set(p, r.row); }
      }
      // a changed schema reached from a compared root is classified there, with that root's sides; a root
      // that already became a fragment row is not used (two schemas referencing each other keep one row)
      const asFragment = new Set();
      for (const u of maybeFragment) {
        if (unknown.includes(u)) continue;
        const roots = [...(fragOf.get(u) || [])].filter((r) => rows.has(r) && r !== u && !asFragment.has(r));
        if (roots.length) { const old = rows.get(u); asFragment.add(u); rows.set(u, { path: u, format: old.format, change: old.change, status: "compared", via: roots.sort(), changes: [] }); }
      }
      for (const u of unknown) {
        const c = changed.get(u), fmt = /\.json$/i.test(u) ? "json" : "yaml", change = c.base === null ? "added" : c.head === null ? "deleted" : "modified";
        const roots = [...(fragOf.get(u) || [])].filter((r) => rows.has(r));
        if (roots.length) rows.set(u, { path: u, format: fmt, change, status: "compared", via: roots.sort(), changes: [] });
        else if (NOT_A_CONTRACT.test(u) && !scan.refNames.has(basename(u))) ignored.push({ path: u, reason: "configuration file on the not-a-contract list" });
        else if (globMatch(u, settings.ignore) && !scan.refNames.has(basename(u))) ignored.push({ path: u, reason: "contract.ignore in .agents/config.yaml" });
        else rows.set(u, { path: u, format: fmt, change, status: "unsupported", reason: scan.refNames.has(basename(u)) ? "named by a $ref that was not resolved to it; classify it by hand" : "not recognized as a contract and no recognized contract references it; pass its root contract with --path or classify it by hand", changes: [] });
      }
    }
    report.ignored = ignored;
    for (const [f, why] of unresolved) if (!rows.has(f)) rows.set(f, { path: f, format: /\.json$/i.test(f) ? "json" : /\.ya?ml$/i.test(f) ? "yaml" : "unknown", change: "unchanged", status: "unsupported", reason: `external $ref fragment not diffed: ${why}`, changes: [] });
  }
  const files = [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
  let n = 0;
  for (const f of files) for (const c of f.changes) {
    c.id = `C-${++n}`;
    c.original_rule = c.rule;
    c.evidence = { class: "measured", source: "diff-contract.mjs" };
    c.coverage = coverage(f.path, c, bullets);
    c.consumers = impact ? consumersFrom(impact, c.element) : { source: "not-searched", in_repo: [], outside_repo: "unknown" };
  }
  return {
    schema_version: 1,
    target: { base: opts.base || opts.baseFile || null, head: opts.repo ? "working-tree" : opts.headFile || null },
    tools: { detected: detectTools(opts.repo), used: [] },
    plan: { path: opts.plan || null, contracts_bullets: bullets.length },
    settings,
    files,
    ignored: report.ignored,
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
  if (o.base !== undefined && (o.base.startsWith("-") || /\s|:/.test(o.base))) usage(`--base must be a revision, not ${JSON.stringify(o.base)}`);
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
