#!/usr/bin/env node
// visual-proof source lint (0.0.27, A170). Scans project source for the registry patterns it can detect honestly and writes lint.json.
// No dependencies, no browser. The gate decision belongs to validate-visual.mjs: this script exits 0 whatever it finds (2 = usage error).
//
//   node lint-source.mjs --root <repo> [--design-md <path>] [--paths a,b] --out <dir>
//
// A finding is `blocking` unless DESIGN.md has a line `- <pattern-id>: <reason>` under `## Pattern justifications` AND the user approved
// that exact line (A200): `--approved-rationales <file>`, the output of `agent.sh design-rationales <ID> --json` ({"approved":
// {"<pattern-id>": "<sha256 of '<pattern-id>: <reason>'>"}}). A line nobody approved, or one edited after the approval, leaves the
// finding blocking and is listed in `unapproved_justifications`. Without the option no justification applies. Then it is `info`
// (justified: true, the reason copied). Ids without a detector are listed in `judged_only` (decided from the screenshots).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGED_ONLY_IDS, PATTERN_IDS, REGISTRY, REGISTRY_DATE, SOURCE_EXTENSIONS } from "./patterns.mjs";

export const LINT_SCHEMA = "visual-proof.lint/1";
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".agents", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".astro", "coverage", "vendor", "target", ".cache", ".turbo", "__pycache__"]);
const MAX_FILE = 1_500_000;
const DESIGN_MD_CANDIDATES = ["DESIGN.md", "docs/design/DESIGN.md", "docs/DESIGN.md", "design/DESIGN.md"];

// `## Pattern justifications` section of DESIGN.md -> { id: reason } for every `- <id>: <reason>` line with a non-empty reason.
export function parseJustifications(md) {
  const out = {};
  let inside = false;
  for (const raw of String(md || "").split(/\r?\n/)) {
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) { inside = /^pattern justifications$/i.test(h[1].trim()); continue; }
    if (!inside) continue;
    const m = /^\s*[-*+]\s+`?([a-z][a-z0-9-]*)`?\s*:\s*(.*?)\s*$/.exec(raw);
    if (m && m[2] && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

// Pure: { id: reason } and { id: sha256 } approvals -> the justifications whose exact line was approved, plus the ids that were not.
export const rationaleHash = (id, reason) => createHash("sha256").update(`${id}: ${reason}`).digest("hex");
export function approvedJustifications(justifications, approved) {
  const ok = {}, unapproved = [];
  for (const [id, reason] of Object.entries(justifications)) {
    if (approved && typeof approved[id] === "string" && approved[id] === rationaleHash(id, reason)) ok[id] = reason;
    else unapproved.push(id);
  }
  return { approved: ok, unapproved };
}

// Pure: one file's text -> raw findings [{ id, file, line, excerpt }] for every detectable registry id.
export function lintText({ path, text }) {
  const file = { path, ext: extname(path).toLowerCase(), text: String(text) };
  const out = [];
  for (const id of PATTERN_IDS) {
    const entry = REGISTRY[id];
    for (const d of entry.detectors) {
      let hits = [];
      try { hits = d.run(file); } catch { /* a heuristic must never stop the lint */ }
      const seen = new Set();
      for (const h of hits) {
        const key = `${h.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id, file: path, line: h.line, excerpt: h.excerpt });
      }
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1) || (a.id < b.id ? -1 : 1));
}

// Pure: findings + justifications -> findings with justified / severity / reason.
export function applyJustifications(findings, justifications) {
  return findings.map((f) => {
    const reason = justifications[f.id];
    return reason ? { ...f, justified: true, severity: "info", reason } : { ...f, justified: false, severity: "blocking" };
  });
}

function walk(dir, root, out) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names.sort()) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(n) && !n.startsWith(".")) walk(p, root, out); }
    else if (st.isFile() && SOURCE_EXTENSIONS.includes(extname(n).toLowerCase()) && !/\.min\.[a-z]+$/i.test(n) && st.size <= MAX_FILE) out.push(p);
  }
}

export function sourceFiles(root, paths) {
  const out = [];
  const starts = paths && paths.length ? paths.map((p) => (isAbsolute(p) ? p : resolve(root, p))) : [root];
  for (const s of starts) {
    if (!existsSync(s)) continue;
    const st = statSync(s);
    if (st.isDirectory()) walk(s, root, out);
    else if (st.isFile() && SOURCE_EXTENSIONS.includes(extname(s).toLowerCase())) out.push(s);
  }
  return [...new Set(out)];
}

// { root, designMd, paths } -> the lint.json object. designMd: a path (absolute or relative to root), null for none, undefined to look
// in the usual places. A named DESIGN.md that does not exist is reported as design_md null (no justification then applies).
export function lintProject({ root, designMd, paths, approved } = {}) {
  const base = resolve(root || ".");
  let mdPath = null;
  if (designMd === undefined) { const c = DESIGN_MD_CANDIDATES.map((x) => join(base, x)).find((x) => existsSync(x)); if (c) mdPath = c; }
  else if (designMd && existsSync(isAbsolute(designMd) ? designMd : resolve(base, designMd))) mdPath = isAbsolute(designMd) ? designMd : resolve(base, designMd);
  const written = mdPath ? parseJustifications(readFileSync(mdPath, "utf8")) : {};
  const { approved: justifications, unapproved } = approvedJustifications(written, approved);
  const raw = [];
  for (const f of sourceFiles(base, paths)) {
    let text;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    raw.push(...lintText({ path: relative(base, f).split("\\").join("/"), text }));
  }
  return {
    schema: LINT_SCHEMA,
    registry_date: REGISTRY_DATE,
    findings: applyJustifications(raw, justifications),
    judged_only: [...JUDGED_ONLY_IDS],
    unapproved_justifications: unapproved,
    design_md: mdPath ? (relative(base, mdPath).startsWith("..") ? mdPath : relative(base, mdPath).split("\\").join("/")) : null,
  };
}

// lint.json -> { valid, errors }. Shape, ids in the registry, severity consistent with justified (never silently weaker).
export function validateLint(json) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!json || typeof json !== "object" || Array.isArray(json)) return { valid: false, errors: ["lint.json must be an object"] };
  if (json.schema !== LINT_SCHEMA) err(`schema must be "${LINT_SCHEMA}"`);
  if (typeof json.registry_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(json.registry_date)) err("registry_date must be a YYYY-MM-DD string");
  if (!Array.isArray(json.findings)) err("findings must be an array");
  else json.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== "object") return err(`${at} must be an object`);
    if (!PATTERN_IDS.includes(f.id)) err(`${at}.id "${f.id}" is not a registry id`);
    if (typeof f.file !== "string" || !f.file) err(`${at}.file must be a non-empty string`);
    if (!Number.isInteger(f.line) || f.line < 1) err(`${at}.line must be a positive integer`);
    if (typeof f.excerpt !== "string") err(`${at}.excerpt must be a string`);
    if (typeof f.justified !== "boolean") err(`${at}.justified must be a boolean`);
    if (f.severity !== "blocking" && f.severity !== "info") err(`${at}.severity must be "blocking" or "info"`);
    if (typeof f.justified === "boolean" && (f.severity === "blocking" || f.severity === "info")) {
      if (f.justified && f.severity !== "info") err(`${at}: a justified finding must have severity "info"`);
      if (!f.justified && f.severity !== "blocking") err(`${at}: an unjustified finding must have severity "blocking"`);
    }
    if (f.justified === true && !(typeof f.reason === "string" && f.reason.trim())) err(`${at}: a justified finding needs a non-empty reason`);
  });
  if (!Array.isArray(json.judged_only)) err("judged_only must be an array");
  else for (const id of json.judged_only) if (!PATTERN_IDS.includes(id)) err(`judged_only id "${id}" is not a registry id`);
  if (json.design_md !== null && typeof json.design_md !== "string") err("design_md must be a path string or null");
  return { valid: errors.length === 0, errors };
}

export const blockingFindings = (json) => (json?.findings || []).filter((f) => f.severity === "blocking");

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function main(argv) {
  const usage = "usage: lint-source.mjs --root <repo> [--design-md <path>] [--approved-rationales <file>] [--paths a,b] --out <dir>";
  const root = arg(argv, "--root"), out = arg(argv, "--out");
  if (!root || !out) { console.error(usage); return 2; }
  if (!existsSync(root) || !statSync(root).isDirectory()) { console.error(`lint-source: --root is not a directory: ${root}`); return 2; }
  const paths = arg(argv, "--paths");
  let approved;
  if (arg(argv, "--approved-rationales")) {
    try { approved = JSON.parse(readFileSync(arg(argv, "--approved-rationales"), "utf8")).approved; }
    catch (e) { console.error(`lint-source: cannot read --approved-rationales: ${e.message}`); return 2; }
  }
  const lint = lintProject({ root, designMd: arg(argv, "--design-md"), approved, paths: paths ? paths.split(",").map((s) => s.trim()).filter(Boolean) : undefined });
  try { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "lint.json"), JSON.stringify(lint, null, 2) + "\n"); }
  catch (e) { console.error(`lint-source: cannot write ${out}/lint.json: ${e.message}`); return 2; }
  const blocking = blockingFindings(lint).length;
  console.log(`LINT: ${lint.findings.length} findings (${blocking} blocking, ${lint.findings.length - blocking} justified, ${lint.unapproved_justifications.length} unapproved rationale(s)), ${lint.judged_only.length} judged-only id(s), registry ${lint.registry_date}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));