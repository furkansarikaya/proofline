#!/usr/bin/env node
// Runtime versions (0.0.26, A173; Node since A234): the language runtime versions the project's CI specifies against the ones
// installed here. Read-only, installs nothing, never fails the caller: a difference is information, never a block.
//
// Usage: node runtime-versions.mjs [DIR]      (DIR defaults to the current directory)
// Prints one line per runtime found, or `runtime: none (...)`:
//   runtime: <name> local=<version|missing> ci=<spec|none> source=<file|-> status=<match|mismatch|unknown>
// Which runtimes exist, which files show that a project uses one (`runtime.present`), where its version is written
// (`version_files`) and how the local version is read come from the ecosystem definition (references/ecosystems.json,
// a byte-identical copy of control-plane/agents/ecosystems.json): node, java, python, go, rust, dotnet, php, ruby, swift, dart.
// The skill reads ONLY its own copy: the commands of `runtime.local.commands` are started here, so a definition inside the
// project under test (.agents/ecosystems.json) must never choose them.
// The project is not assumed to be laid out in any way: the root is read first, then the same files in nested
// directories (build output, dependency and tool folders are not entered; `global.limits.version_scan_depth` deep, at
// most `version_scan_max_files` files). A project only under obj/ or bin/ is therefore ignored.
// The CI-specified version is the first found of: a workflow (`node-version`, `go-version`, `dotnet-version`,
// `python-version`, ... under .github/workflows), then each source of the ecosystem in order (version files such as
// .nvmrc, global.json, .python-version, .tool-versions; manifests such as package.json engines, go.mod `go`,
// pyproject.toml requires-python), a .gitlab-ci.yml image. go.mod and `>=` specs are minimums.
// status compares the first `runtime.compare` components of the version (the major for node, dotnet and java; major.minor for the
// others): `mismatch` means the local version is not one the spec allows; a spec that cannot be compared (lts/*,
// stable, a `<` range) or a missing side is `unknown`. Exit: 0 always, 2 on a usage error.
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadEcosystems, globToRegExp, matchesAny } from "./ecosystems.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** One spec token: no comment, quotes, brackets, spaces or carriage returns; the first line only. */
export const clean = (text) => String(text).replace(/\r?\n[\s\S]*$/, "").replace(/\s#.*$/, "").replace(/["'[\] \r]/g, "");

const readText = (f) => { try { return statSync(f).isFile() ? readFileSync(f, "utf8") : null; } catch { return null; } };
const lines = (t) => t.split("\n");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** wf_find: the first usable value of `key:` in a workflow file (`key: x`, `key: [18, 20]` or a block list); an expression cannot be resolved. */
export function workflowValue(text, key) {
  const keyRe = new RegExp(`^[ \\t-]*${escapeRe(key)}:`);
  const usable = (v) => (v !== "" && !/\$\{\{/.test(v) ? v : null);
  let blk = false, acc = "";
  for (const line of lines(text)) {
    if (blk) {
      if (/^[ \t]*-[ \t]*[^ \t]/.test(line)) {
        const s = line.replace(/^[ \t]*-[ \t]*/, "").replace(/[ \t]+#.*$/, "");
        acc += (acc === "" ? "" : ",") + s;
        continue;
      }
      blk = false;
      const u = usable(acc); if (u !== null) return u;
    }
    if (keyRe.test(line)) {
      const s = line.replace(new RegExp(`^[ \\t-]*${escapeRe(key)}:[ \\t]*`), "");
      if (/^(#.*)?$/.test(s)) { blk = true; acc = ""; continue; }
      const u = usable(s); if (u !== null) return u;
    }
  }
  return blk ? usable(acc) : null;
}

/** status: match | mismatch | unknown (see the header). n is the number of components compared. */
export function status(n, local, spec) {
  if (!/^[0-9]/.test(local) || spec.includes("<")) return "unknown";
  const min = spec.includes(">");
  const lp = local.split(".");
  const fields = spec.replace(/[^0-9.]+/g, " ").split(" ");
  let seen = false;
  const num = (x) => { const v = parseFloat(x); return Number.isNaN(v) ? 0 : v; };
  for (const f of fields) {
    const s = f.replace(/^\.+|\.+$/g, "");
    if (s === "") continue;
    seen = true;
    const sp = s.split(".");
    const k = Math.min(sp.length, Number(n), lp.length);
    let cmp = 0;
    for (let j = 0; j < k && cmp === 0; j++) cmp = num(lp[j]) < num(sp[j]) ? -1 : num(lp[j]) > num(sp[j]) ? 1 : 0;
    if (min ? cmp >= 0 : cmp === 0) return "match";
  }
  return seen ? "mismatch" : "unknown";
}

/** `command -v` for a program name: an executable file on PATH. */
function onPath(name) {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD").split(";")] : [""];
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d === "") continue;
    for (const e of exts) { try { const p = join(d, name + e); if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return true; } } catch { /* next */ } }
  }
  return false;
}

/** stdout and stderr of a program as one stream in the order it wrote them (`2>&1`); null when it cannot be started. */
function combinedOutput(program, args) {
  const dir = mkdtempSync(join(tmpdir(), "proofline-ver-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  try {
    const r = spawnSync(program, args, { stdio: ["ignore", fd, fd], timeout: 30000, windowsHide: true });
    return r.error ? null : readFileSync(file, "utf8");
  } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
}

/** local_for: the installed version of a runtime, empty when it is not installed. */
function localVersion(commands, extract, group) {
  const ere = new RegExp(extract.startsWith("^") ? extract : `.*${extract}`, "s");
  for (const c of commands) {
    const argv = c.split(/\s+/).filter(Boolean);
    if (argv.length === 0 || !onPath(argv[0])) continue;
    const text = combinedOutput(argv[0], argv.slice(1));
    if (text === null) continue;
    const out = lines(text).slice(0, 5);
    for (const l of out) { const m = ere.exec(l); if (m && m[Number(group)] !== undefined && m[Number(group)] !== "") return m[Number(group)]; }
  }
  return "";
}

/** The nested files that can matter: below the root, pruned, at most `depth` levels and `maxf` files, shallow first (byte order inside a level). */
function nestedFiles(names, prune, depth, maxf) {
  // a find -name pattern on a base name: * and ? only
  const baseRes = names.map((n) => new RegExp(`^${[...n].map((c) => (c === "*" ? ".*" : c === "?" ? "." : escapeRe(c))).join("")}$`));
  const found = [];
  const walk = (rel, level) => {
    let ents; try { ents = readdirSync(rel === "" ? "." : rel, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) { if (!prune.has(e.name) && level < depth) walk(path, level + 1); continue; }
      if (e.isFile() && baseRes.some((r) => r.test(e.name)) && path.includes("/") && !/\s/.test(path)) found.push(path);
    }
  };
  walk("", 1);
  const byte = (a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b)));
  found.sort((a, b) => (a.split("/").length - b.split("/").length) || byte(a, b));
  return found.slice(0, maxf);
}

function main(argv) {
  const dir = argv[0] ?? ".";
  try { process.chdir(dir); } catch { process.stderr.write(`runtime-versions: cannot enter ${dir}\n`); return 2; }
  let data;
  try { data = loadEcosystems(join(HERE, "..", "references", "ecosystems.json")); } catch {
    process.stdout.write("runtime: none (the ecosystem definition references/ecosystems.json is missing)\n"); return 0;
  }
  const g = data.global;
  const depth = Number(g.limits?.version_scan_depth ?? 6) || 6, maxf = Number(g.limits?.version_scan_max_files ?? 400) || 400;
  const names = [...new Set([...data.ecosystems.flatMap((e) => e.runtime?.present ?? []), ...data.ecosystems.flatMap((e) => (e.version_files ?? []).map((v) => v.file).filter(Boolean)), ".tool-versions"])];
  const nested = nestedFiles(names, new Set(g.prune), depth, maxf);

  const fileFind = (f) => { const t = readText(f); if (t === null) return null; const first = lines(t).find((l) => !/^[ \t\r\f\v]*$/.test(l)); const v = first === undefined ? "" : clean(first); return v ? [f, v] : null; };
  const toolFind = (f, nm) => {
    const t = readText(f); if (t === null) return null;
    for (const l of lines(t)) { const w = l.trim().split(/\s+/); if (nm.includes(w[0])) { const v = clean(w[1] ?? ""); return v ? [f, v] : null; } }
    return null;
  };
  const gitlabFind = (image) => {
    const t = readText(".gitlab-ci.yml"); if (t === null) return null;
    const re = new RegExp(`^\\s*image:\\s*['"]*${escapeRe(image)}:([0-9][0-9.]*)`);
    for (const l of lines(t)) { const m = re.exec(l); if (m) return [".gitlab-ci.yml", m[1]]; }
    return null;
  };
  const matchFind = (f, row) => {
    let t = readText(f); if (t === null) return null;
    const re = new RegExp(row.pattern.startsWith("^") ? row.pattern : `.*${row.pattern}`, "s");
    const hay = row.flatten === "true" || row.flatten === true ? [t.replace(/\n/g, "")] : lines(t);
    for (const l of hay) {
      const m = re.exec(l);
      if (m) { const v = clean(m[Number(row.group)] ?? ""); return v ? [f, `${row.spec_prefix ?? ""}${v}`] : null; }
    }
    return null;
  };
  const wfFind = (key) => {
    let files = [];
    try { files = readdirSync(".github/workflows").filter((n) => /\.(yml|yaml)$/.test(n)); } catch { return null; }
    files.sort((a, b) => (/\.yml$/.test(a) === /\.yml$/.test(b) ? (a < b ? -1 : a > b ? 1 : 0) : /\.yml$/.test(a) ? -1 : 1));
    for (const n of files) {
      const f = `.github/workflows/${n}`; const t = readText(f); if (t === null) continue;
      const v = workflowValue(t, key); const c = v === null ? "" : clean(v);
      if (c) return [f, c];
    }
    return null;
  };
  const specFor = (rows, nest) => {
    for (const pass of ["root", "nested"]) {
      for (const row of rows) {
        if (row.kind === "workflow") { if (pass !== "root") continue; for (const k of row.keys ?? []) { const r = wfFind(k); if (r) return r; } }
        else if (row.kind === "gitlab_image") { if (pass !== "root") continue; const r = gitlabFind(row.image); if (r) return r; }
        else if (["line", "match", "tool_versions"].includes(row.kind)) {
          const file = row.kind === "tool_versions" ? ".tool-versions" : row.file;
          const paths = pass === "root" ? [file] : nest.filter((p) => p.slice(p.lastIndexOf("/") + 1) === file);
          for (const p of paths) {
            const r = row.kind === "line" ? fileFind(p) : row.kind === "tool_versions" ? toolFind(p, row.names ?? []) : matchFind(p, row);
            if (r) return r;
          }
        }
      }
    }
    return null;
  };
  const presentFor = (globs, nest) => {
    for (const gl of globs) {
      if (!/[*?]/.test(gl)) { if (existsSync(gl)) return true; continue; }
      let ents = []; try { ents = readdirSync("."); } catch { /* none */ }
      if (ents.some((n) => (!n.startsWith(".") || gl.startsWith(".")) && globToRegExp(gl).test(n))) return true;
    }
    return nest.some((p) => matchesAny(p, globs));
  };

  let found = false;
  const out = [];
  for (const e of data.ecosystems) {
    const r = e.runtime ?? {};
    const own = new Set(e.prune ?? []);
    const nest = nested.filter((p) => !p.split("/").slice(0, -1).some((s) => own.has(s)));
    const loc = localVersion(r.local?.commands ?? [], r.local?.extract ?? "", r.local?.group ?? "1") || "missing";
    const spec = specFor(e.version_files ?? [], nest);
    if (!presentFor(r.present ?? [], nest) && !spec) continue;
    const ci = spec ? spec[1] : "none", src = spec ? spec[0] : "-";
    const st = loc === "missing" || ci === "none" ? "unknown" : status(r.compare, loc, ci);
    out.push(`runtime: ${r.name} local=${loc} ci=${ci} source=${src} status=${st}`);
    found = true;
  }
  if (!found) out.push("runtime: none (no language runtime detected)");
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
