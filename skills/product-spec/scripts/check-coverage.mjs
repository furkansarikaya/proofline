#!/usr/bin/env node
// Coverage of a PRD by tasks (references/PRD-FORMAT.md#coverage): every FR-n and NFR-n is covered by an acceptance
// criterion of a task (`Covers:` marker, task front matter `prd: <slug>`) or listed under `## Deferred` with a reason.
//   node check-coverage.mjs <PRD.md|slug> [--tasks-dir DIR] [--json] [--root DIR]
// DIR defaults to config tasks.dir (.agents/tasks); its lifecycle folders are read too. Read-only.
// Exit 0: every requirement covered or deferred. 1: a gap or a Covers id the PRD does not have. 2: usage error.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrd, resolvePrd, tasksDir } from "./check-prd.mjs";

export const COVERS = /\bCovers:\s*([A-Z]+-\d+(?:\s*,\s*[A-Z]+-\d+)*)\s*\.?\s*$/;

// Front matter right after the `# Task:` line (or leading), flat `key: value` lines.
function frontMatter(text) {
  const m = /^(?:# Task:[^\n]*\r?\n(?:[ \t]*\r?\n)*(?:\*\*Status:\*\*[^\n]*\r?\n(?:[ \t]*\r?\n)*)?)?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const meta = {};
  for (const l of (m?.[1] || "").split(/\r?\n/)) { const kv = /^([A-Za-z_]+):\s*(.*?)\s*$/.exec(l); if (kv) meta[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, "$2"); }
  return meta;
}

// One task file: id, prd slug, and its acceptance criteria with the requirement ids each covers.
export function parseTaskFile(file) {
  const text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const id = /^# Task: (\S+)/m.exec(text)?.[1] || basename(file, ".md");
  const acs = [];
  let inAc = false;
  for (const line of text.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { inAc = h[1] === "Acceptance criteria"; continue; }
    if (!inAc) continue;
    const m = /^(?:[-*]\s+)?AC-(\d+):\s*(.*)$/.exec(line);
    if (m) acs.push({ ac: `AC-${m[1]}`, text: m[2].trim() });
    else if (acs.length && /^\s+\S/.test(line)) acs[acs.length - 1].text += " " + line.trim();
  }
  for (const a of acs) { const c = COVERS.exec(a.text); a.covers = c ? c[1].split(/\s*,\s*/) : []; }
  return { id, file, prd: frontMatter(text).prd || null, acs };
}

// Task files under DIR: DIR/*.md, DIR/<lifecycle or id>/*.md (TASK.md included).
export function taskFiles(dir) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    const f = join(dir, n);
    let st; try { st = statSync(f); } catch { continue; }
    if (st.isFile() && n.endsWith(".md")) out.push(f);
    else if (st.isDirectory()) for (const c of readdirSync(f).sort()) if (c.endsWith(".md") && statSync(join(f, c)).isFile()) out.push(join(f, c));
  }
  return out;
}

export function coverage(prdFile, dirs) {
  const slug = basename(dirname(prdFile));
  const p = parsePrd(readFileSync(prdFile, "utf8"));
  const ids = p.reqs.filter((r) => r.id).map((r) => r.id);
  const tasks = dirs.flatMap(taskFiles).map(parseTaskFile).filter((t) => t.prd === slug);
  const links = new Map(ids.map((id) => [id, []]));
  const unknown = [];
  for (const t of tasks) for (const a of t.acs) for (const c of a.covers) {
    if (links.has(c)) links.get(c).push({ task: t.id, ac: a.ac, file: t.file });
    else unknown.push({ task: t.id, ac: a.ac, id: c });
  }
  const deferred = new Map(p.deferred.filter((d) => d.id && d.reason).map((d) => [d.id, d.reason]));
  const requirements = ids.map((id) => ({ id, tasks: links.get(id), deferred: deferred.get(id) || null }));
  const gaps = requirements.filter((r) => !r.tasks.length && !r.deferred).map((r) => r.id);
  return { slug, complete: gaps.length === 0 && unknown.length === 0, gaps, unknown, requirements, tasks: tasks.map((t) => t.id) };
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(opt("--root") || ".");
  const arg = argv.find((a, i) => !a.startsWith("--") && !["--root", "--tasks-dir"].includes(argv[i - 1]));
  if (!arg) { console.error("usage: check-coverage.mjs <PRD.md|slug> [--tasks-dir DIR] [--json] [--root DIR]"); return 2; }
  const file = resolvePrd(arg, root);
  if (!existsSync(file)) { console.error(`cannot read ${file}`); return 2; }
  const dir = resolve(root, opt("--tasks-dir") || tasksDir(root));
  const r = coverage(file, [dir]);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    for (const q of r.requirements) {
      const how = q.tasks.length ? q.tasks.map((t) => `${t.task} ${t.ac}`).join(", ") : q.deferred ? `deferred: ${q.deferred}` : "NOT COVERED: no task criterion covers it and it is not deferred";
      console.log(`${q.id}: ${how}`);
    }
    for (const u of r.unknown) console.log(`${u.task} ${u.ac}: Covers ${u.id}, which ${relative(root, file)} does not define`);
    if (!r.tasks.length) console.log(`no task in ${relative(root, dir).startsWith("..") ? dir : relative(root, dir) || "."} has front matter prd: ${r.slug}`);
  }
  return r.complete ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
