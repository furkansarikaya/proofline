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
//   dependencyPaths()             every glob a dependency review must look at: manifests, locks and settings of all ecosystems
//   allPruneDirs()                the global prune dirs plus those of every ecosystem (for a scan that is not ecosystem-specific)
//   manifestGlobs()               every manifest glob of all ecosystems
//   classifyPath(path)            [{ecosystem, role}] roles: manifest, lock, settings, project, solution, workspace, risky
//   toRegExp(spec)                "/source/flags" -> RegExp; a bare string is a source
//   flatten(data)                 the rows [id, path, value] of ecosystems.tsv
// Workspace members (A187): workspace_roots[].members says how a workspace file's member list is read, commands.*[].workspace and
// at_workspace are command templates with {members}; discover.sh (d_members, d_rule) builds the command from them.
// CLI: node ecosystems.mjs write|sync|check|validate|get <id|*> <path>|ids|risky|dependency
//   write     regenerates ecosystems.tsv next to ecosystems.json
//   sync      write, then refreshes the byte-identical copies in every skills/*/ that carries one (the control plane only)
//   check     validate + the tsv equals what write would produce (exit 1 otherwise)
//   validate  the schema (every key every consumer relies on exists)
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// A skill installed in a project (.agents/skills/<name>/scripts) prefers the project's own .agents/ecosystems.json, so a language
// added there reaches every node reader without touching the skill's copy; the skill's own copy is the fallback.
const IN_PROJECT = /[\\/]\.agents[\\/]skills[\\/][^\\/]+[\\/]scripts$/.test(HERE);
const CANDIDATES = (name) => [...(IN_PROJECT ? [join(HERE, "..", "..", "..", name)] : []), join(HERE, name), join(HERE, "..", "references", name), join(HERE, "..", name)];
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
const GLOBS = new Map();
export function globToRegExp(glob) {
  const hit = GLOBS.get(glob);
  if (hit) return hit;
  const re = buildGlob(glob);
  GLOBS.set(glob, re);
  return re;
}
function buildGlob(glob) {
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

export function allPruneDirs(data = loadEcosystems()) {
  return [...new Set([...data.global.prune, ...data.ecosystems.flatMap((e) => e.prune ?? [])])];
}
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

// What a dependency review must look at: manifests, locks and package-source settings. Build-only risky files are not in it.
export function dependencyPaths(data = loadEcosystems()) {
  return [...new Set(data.ecosystems.flatMap((e) => [...e.manifests, ...e.locks, ...e.settings]))];
}
export const manifestGlobs = (data = loadEcosystems()) => [...new Set(data.ecosystems.flatMap((e) => e.manifests))];

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
  for (const k of ["discover_max_markers", "version_scan_depth", "version_scan_max_files", "scan_max_files"]) need(/^[0-9]+$/.test(g.limits?.[k] ?? ""), `global.limits.${k} must be a digit string`);
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
    for (const x of e.workspace_roots ?? []) {
      need(typeof x.file === "string" && /^[^/*]+$/.test(x.file), `${w}: workspace_roots.file must be one plain file name`);
      if (x.members === undefined) continue;
      // members (A187): how the member list of the workspace file is read and written into a command
      const m = x.members, mw = `${w}: workspace_roots ${x.file} members`;
      need(m && typeof m === "object" && !Array.isArray(m), `${mw} must be an object`);
      const known = ["single_prefix", "block_open", "block_close", "block_item_prefix", "comment", "format"];
      for (const k of Object.keys(m ?? {})) need(known.includes(k) && typeof m[k] === "string" && m[k] !== "", `${mw}: ${k} must be one of ${known.join(", ")} and a non-empty string`);
      need(typeof m?.format === "string" && m.format.includes("{member}"), `${mw}: format must hold {member}`);
      need(Boolean(m?.single_prefix) || Boolean(m?.block_open && m?.block_close), `${mw}: needs single_prefix or block_open with block_close`);
      for (const k of ["single_prefix", "block_open", "block_close", "block_item_prefix"]) if (m?.[k]) { try { new RegExp(m[k]); } catch { err.push(`${mw}: ${k} is not a regular expression`); } }
    }
    const canList = (e.workspace_roots ?? []).some((x) => x.members);
    for (const kind of ["build", "test", "lint"]) for (const r of e.commands?.[kind] ?? []) {
      if (r.workspace === undefined && r.at_workspace === undefined) continue;
      need(canList, `${w}: commands.${kind} has a workspace template but no workspace_roots entry has members`);
      need(typeof r.workspace === "string" && r.workspace.includes("{members}"), `${w}: commands.${kind} workspace must hold {members}`);
      need(typeof r.at_workspace === "string" && r.at_workspace.includes("{members}"), `${w}: commands.${kind} at_workspace must hold {members}`);
    }
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
    // A185: git-ignored dependency folders a run worktree gets its own copy of (never a link into the main tree)
    need(Array.isArray(e.worktree_deps?.folders), `${w}: worktree_deps.folders must be an array`);
    for (const x of e.worktree_deps?.folders ?? []) need(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(x) && !x.split("/").some((q) => q === "." || q === ".." || q === ".git" || q === ".agents"), `${w}: worktree_deps.folders entry ${x} must be a plain relative folder name`);
    for (const x of e.native_ui ?? []) need(typeof x.file === "string" && ["mobile", "shell", "desktop"].includes(x.kind) && typeof x.platform === "string" && typeof x.why === "string", `${w}: native_ui entries need file, platform, kind (mobile, shell or desktop) and why`);
    for (const x of e.benchmark?.dependencies ?? []) need(Array.isArray(x.in) && x.in.length > 0 && typeof x.contains === "string" && typeof x.why === "string", `${w}: benchmark.dependencies entries need in, contains and why`);
    for (const x of e.benchmark?.files ?? []) need(typeof x.glob === "string" && typeof x.contains === "string" && typeof x.why === "string", `${w}: benchmark.files entries need glob, contains and why`);
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
  if (cmd === "sync") {
    const e = validate(data); if (e.length) { console.error(e.join("\n")); process.exit(1); }
    writeFileSync(tsv, toTsv(data));
    // only in the repository layout (control-plane/agents next to skills/); an installed .agents/ has no skills/ to refresh
    const here = dirname(json), skills = basename(here) === "agents" && basename(dirname(here)) === "control-plane" ? join(here, "..", "..", "skills") : null;
    const pairs = [["scripts/ecosystems.sh", "scripts/ecosystems.sh"], ["scripts/ecosystems.mjs", "ecosystems.mjs"], ["references/ecosystems.json", "ecosystems.json"], ["references/ecosystems.tsv", "ecosystems.tsv"]];
    if (skills && existsSync(skills)) for (const d of readdirSync(skills)) for (const [rel, src] of pairs) {
      const to = join(skills, d, rel), from = join(dirname(json), src);
      if (existsSync(to)) { if (readFileSync(to, "utf8") !== readFileSync(from, "utf8")) { copyFileSync(from, to); console.log(`synced skills/${d}/${rel}`); } }
    }
    return;
  }
  if (cmd === "dependency") { console.log(dependencyPaths(data).join("\n")); return; }
  if (cmd === "ids") { console.log(ecosystemIds(data).join("\n")); return; }
  if (cmd === "risky") { console.log(riskyPaths(data).join("\n")); return; }
  if (cmd === "get" && a && b) { for (const [id, p, v] of flatten(data)) if (id === a && p === b) console.log(v); return; }
  console.error("usage: ecosystems.mjs write|sync|check|validate|ids|risky|dependency|get <id|*> <path>");
  process.exit(2);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
