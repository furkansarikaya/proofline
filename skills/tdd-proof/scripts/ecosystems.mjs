#!/usr/bin/env node
// Loader of the ecosystem definition (A173): ecosystems.json is the single source; this file reads it for node
// scripts and generates ecosystems.tsv, the flat copy that sh scripts read (scripts/ecosystems.sh) without node.
// Skills are installable alone, so a skill that uses this carries byte-identical copies of ecosystems.mjs and
// ecosystems.json (references/ or scripts/); tests/shared/check-shared.sh compares them with the control plane's.
//
// Library: import { loadEcosystems, ... } from "./ecosystems.mjs"
//   loadEcosystems([file])        the parsed definition (cached); looks next to this file, in ../references/ and in ../
//   ecosystemIds(), ecosystem(id), globalDef()
//   globToRegExp(glob), matchesGlob(path, glob), matchesAny(path, globs)    the agent.sh glob dialect
//   pruneDirs([id]), isPruned(path, [id])   global prune dirs plus the ecosystem's own
//   riskyPaths()                  every risky glob: global + per ecosystem (risky_paths, manifests, locks, settings)
//   classifyPath(path)            [{ecosystem, role}] roles: manifest, lock, settings, project, solution, workspace, risky
//   toRegExp(spec)                "/source/flags" -> RegExp; a bare string is a source
//   flatten(data)                 the rows [id, path, value] of ecosystems.tsv
// CLI: node ecosystems.mjs write|check|validate|get <id|*> <path>|ids|risky
//   write     regenerates ecosystems.tsv next to ecosystems.json
//   check     validate + the tsv equals what write would produce (exit 1 otherwise)
//   validate  the schema (every key every consumer relies on exists)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = (name) => [join(HERE, name), join(HERE, "..", "references", name), join(HERE, "..", name)];
let cache = null;

export function findDefinition(name = "ecosystems.json") {
  return CANDIDATES(name).find((p) => existsSync(p)) ?? null;
}

export function loadEcosystems(file) {
  if (!file && cache) return cache;
  const p = file ?? findDefinition();
  if (!p) throw new Error("ecosystems.json not found next to ecosystems.mjs, in ../references or in ..");
  const data = JSON.parse(readFileSync(p, "utf8"));
  if (!file) cache = data;
  return data;
}

export const ecosystemIds = (data = loadEcosystems()) => data.ecosystems.map((e) => e.id);
export const ecosystem = (id, data = loadEcosystems()) => data.ecosystems.find((e) => e.id === id) ?? null;
export const globalDef = (data = loadEcosystems()) => data.global;

// --- globs: the dialect of agent.sh (g2re): no / means any depth, ** spans directories, * and ? stay in a segment
export function globToRegExp(glob) {
  const p = glob.includes("/") ? glob : `**/${glob}`;
  let r = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") { r += "(.*/)?"; i += 2; } else { r += ".*"; i += 1; }
      } else r += "[^/]*";
    } else if (c === "?") r += "[^/]";
    else if (".+()|^$[]{}\\".includes(c)) r += `\\${c}`;
    else r += c;
  }
  return new RegExp(`^${r}$`);
}
export const matchesGlob = (path, glob) => globToRegExp(glob).test(path);
export const matchesAny = (path, globs) => globs.some((g) => matchesGlob(path, g));

export function pruneDirs(id, data = loadEcosystems()) {
  const own = id ? ecosystem(id, data)?.prune ?? [] : [];
  return [...new Set([...data.global.prune, ...own])];
}
// A path is pruned when one of its directory segments (not the file name) is a prune dir.
export function isPruned(path, id, data = loadEcosystems()) {
  const dirs = new Set(pruneDirs(id, data));
  return path.split("/").slice(0, -1).some((s) => dirs.has(s));
}

const riskyOf = (e) => [...(e.risky_paths ?? []), ...(e.manifests ?? []), ...(e.locks ?? []), ...(e.settings ?? [])];
export function riskyPaths(data = loadEcosystems()) {
  return [...new Set([...data.global.risky_paths, ...data.ecosystems.flatMap(riskyOf)])];
}

export function classifyPath(path, data = loadEcosystems()) {
  const out = [];
  const add = (ecosystem, role) => { if (!out.some((o) => o.ecosystem === ecosystem && o.role === role)) out.push({ ecosystem, role }); };
  for (const e of data.ecosystems) {
    if (matchesAny(path, e.manifests)) add(e.id, "manifest");
    if (matchesAny(path, e.locks)) add(e.id, "lock");
    if (matchesAny(path, e.settings)) add(e.id, "settings");
    if (matchesAny(path, e.project_files)) add(e.id, "project");
    if (matchesAny(path, e.solution_files)) add(e.id, "solution");
    if (e.workspace_roots.some((w) => matchesGlob(path, w.file))) add(e.id, "workspace");
    if (matchesAny(path, riskyOf(e))) add(e.id, "risky");
  }
  if (matchesAny(path, data.global.risky_paths)) add("*", "risky");
  return out;
}

// "/source/flags" -> RegExp; anything else is taken as a source
export function toRegExp(spec) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(spec);
  return m ? new RegExp(m[1], m[2]) : new RegExp(spec);
}

// --- flat form: id TAB path TAB value. A scalar array repeats its path; an array of objects adds an index segment.
const scalar = (v) => v === null || typeof v !== "object";
export function flatten(data) {
  const rows = [];
  const walk = (id, path, v) => {
    if (Array.isArray(v)) {
      if (v.every(scalar)) for (const x of v) rows.push([id, path, String(x)]);
      else v.forEach((o, i) => { if (scalar(o)) throw new Error(`${id} ${path}: mixed array`); walk(id, `${path}.${i}`, o); });
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(id, path ? `${path}.${k}` : k, x);
    } else rows.push([id, path, String(v)]);
  };
  walk("*", "", Object.fromEntries(Object.entries(data.global)));
  for (const e of data.ecosystems) {
    const { id, ...rest } = e;
    rows.push([id, "id", id]);
    walk(id, "", rest);
  }
  return rows;
}
export const toTsv = (data) => flatten(data).map((r) => r.join("\t")).join("\n") + "\n";

// --- schema: the keys every consumer may rely on
const ECO_ARRAYS = ["prune", "project_files", "manifests", "locks", "settings", "workspace_roots", "solution_files", "version_files", "risky_paths", "native_ui"];
const COMMAND_KEYS = ["truth", "tools", "ci_lint", "runners", "build", "test", "lint"];
const TEST_KEYS = ["status", "runners", "no_tests", "compile", "assertion", "exit_codes"];
const BENCH_KEYS = ["scripts", "dirs", "files", "dependencies", "config_files"];
export function validate(data = loadEcosystems()) {
  const err = [];
  const need = (cond, msg) => { if (!cond) err.push(msg); };
  need(data.schema_version === 1, "schema_version must be 1");
  const g = data.global ?? {};
  for (const k of ["prune", "risky_paths"]) need(Array.isArray(g[k]) && g[k].length > 0, `global.${k} must be a non-empty array`);
  for (const k of ["discover_max_markers", "version_scan_depth", "version_scan_max_files"]) need(/^[0-9]+$/.test(g.limits?.[k] ?? ""), `global.limits.${k} must be a digit string`);
  for (const k of ["tools", "build", "test", "lint"]) need(g.ci_scan && k in g.ci_scan, `global.ci_scan.${k} missing`);
  const seen = new Set();
  for (const e of data.ecosystems ?? []) {
    const w = `ecosystem ${e.id}`;
    need(/^[a-z][a-z0-9_]*$/.test(e.id ?? ""), `${w}: id must be lower-case letters, digits, _`);
    need(!seen.has(e.id), `${w}: duplicate id`);
    seen.add(e.id);
    need(typeof e.name === "string" && e.name !== "", `${w}: name missing`);
    for (const k of ECO_ARRAYS) need(Array.isArray(e[k]), `${w}: ${k} must be an array`);
    for (const k of ["project_files", "manifests"]) need(e[k]?.length > 0, `${w}: ${k} must not be empty`);
    for (const x of e.workspace_roots ?? []) need(typeof x.file === "string" && /^[^/*]+$/.test(x.file), `${w}: workspace_roots.file must be one plain file name`);
    for (const x of e.version_files ?? []) need(["workflow", "line", "tool_versions", "match", "gitlab_image"].includes(x.kind), `${w}: version_files kind ${x.kind}`);
    const u = e.units ?? {};
    need(["dir", "file"].includes(u.target), `${w}: units.target must be dir or file`);
    need(typeof u.bare === "string", `${w}: units.bare missing`);
    need(Array.isArray(u.stages) && Array.isArray(u.legacy), `${w}: units.stages and units.legacy must be arrays`);
    if (u.target === "file") need(u.stages.length > 0, `${w}: a file-target ecosystem needs units.stages`);
    const r = e.runtime ?? {};
    for (const k of ["name", "compare"]) need(typeof r[k] === "string" && r[k] !== "", `${w}: runtime.${k} missing`);
    need(Array.isArray(r.present) && r.present.length > 0 && Array.isArray(r.local?.commands) && typeof r.local?.extract === "string", `${w}: runtime.present and runtime.local missing`);
    for (const k of COMMAND_KEYS) need(k in (e.commands ?? {}), `${w}: commands.${k} missing`);
    need(["scripts", "tools"].includes(e.commands?.truth), `${w}: commands.truth must be scripts or tools`);
    for (const k of TEST_KEYS) need(k in (e.test_output ?? {}), `${w}: test_output.${k} missing`);
    for (const k of BENCH_KEYS) need(k in (e.benchmark ?? {}), `${w}: benchmark.${k} missing`);
  }
  for (const [id, path, value] of flatten(data)) {
    need(!/[\t\n]/.test(value), `${id} ${path}: a value holds a tab or newline`);
    need(!path.split(".").some((s) => s === ""), `${id} ${path}: an empty key`);
  }
  const keys = (v, a = []) => { if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) { a.push(k); keys(x, a); } else if (Array.isArray(v)) v.forEach((x) => keys(x, a)); return a; };
  need(!keys(data).some((k) => k !== "$comment" && k.includes(".")), "a key holds a dot (the flat form joins keys with dots)");
  return err;
}

const main = () => {
  const [cmd, a, b] = process.argv.slice(2);
  const json = findDefinition();
  if (!json) { console.error("ecosystems: ecosystems.json not found"); process.exit(2); }
  const tsv = join(dirname(json), "ecosystems.tsv");
  const data = loadEcosystems(json);
  if (cmd === "write") { const e = validate(data); if (e.length) { console.error(e.join("\n")); process.exit(1); } writeFileSync(tsv, toTsv(data)); return; }
  if (cmd === "validate" || cmd === "check") {
    const e = validate(data);
    if (cmd === "check") {
      if (!existsSync(tsv)) e.push(`${basename(tsv)} is missing; run: node ecosystems.mjs write`);
      else if (readFileSync(tsv, "utf8") !== toTsv(data)) e.push(`${basename(tsv)} differs from ${basename(json)}; run: node ecosystems.mjs write`);
    }
    if (e.length) { console.error(e.join("\n")); process.exit(1); }
    return;
  }
  if (cmd === "ids") { console.log(ecosystemIds(data).join("\n")); return; }
  if (cmd === "risky") { console.log(riskyPaths(data).join("\n")); return; }
  if (cmd === "get" && a && b) { for (const [id, p, v] of flatten(data)) if (id === a && p === b) console.log(v); return; }
  console.error("usage: ecosystems.mjs write|check|validate|ids|risky|get <id|*> <path>");
  process.exit(2);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
