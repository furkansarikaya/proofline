#!/usr/bin/env node
// Read-only trace for `/proofline trace <FR-n|NFR-n|TASK-ID>`: requirement -> task -> acceptance criterion -> test
// -> run evidence -> pull request, built only from records on disk (references/PRD-FORMAT.md#trace). Writes nothing.
//   node trace.mjs <FR-n|NFR-n|TASK-ID> [--prd <slug|PRD.md>] [--tasks-dir DIR] [--root DIR] [--json]
// Records read: <product.dir>/*/PRD.md, task files (tasks.dir, lifecycle folders, .agents/runs/<ID>/TASK.md),
// .agents/runs/<ID>/PLAN.md `## Tests`, .agents/runs/<ID>/worker-evidence/*.yaml, .agents/local/deliver/<ID>/PR,
// .agents/local/batch/merged.tsv. Exit 0: every link found. 1: a link is missing (each is named). 2: usage, or the
// id matches no record.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrd, productDir, resolvePrd, tasksDir } from "./check-prd.mjs";
import { parseTaskFile, taskFiles } from "./check-coverage.mjs";

const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
const ls = (d) => { try { return readdirSync(d).sort(); } catch { return []; } };

function prds(root, only) {
  if (only) { const f = resolvePrd(only, root); return existsSync(f) ? [f] : []; }
  const dir = join(root, productDir(root));
  return ls(dir).map((n) => join(dir, n, "PRD.md")).filter(existsSync);
}

function tasks(root, dir) {
  const byId = new Map();
  const runs = join(root, ".agents", "runs");
  for (const f of [...taskFiles(dir), ...ls(runs).map((n) => join(runs, n, "TASK.md")).filter(existsSync)]) {
    const t = parseTaskFile(f);
    if (!byId.has(t.id)) byId.set(t.id, t);
    else if (!byId.get(t.id).prd && t.prd) byId.set(t.id, t);
  }
  return byId;
}

// `## Tests` of the run's PLAN.md: `- AC-<n>: \`<file>\` "<name>" ...`
function testsFor(root, id, ac) {
  const plan = read(join(root, ".agents", "runs", id, "PLAN.md"));
  if (plan === null) return { tests: [], why: `no test linked: no .agents/runs/${id}/PLAN.md` };
  const out = [];
  let on = false;
  for (const l of plan.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(l);
    if (h) { on = h[1] === "Tests"; continue; }
    const m = on && new RegExp(`^\\s*[-*]\\s+${ac}:\\s*\`([^\`]+)\`(?:\\s+"([^"]*)")?`).exec(l);
    if (m) out.push({ file: m[1], name: m[2] || null });
  }
  return { tests: out, why: out.length ? null : `no test linked: PLAN.md ## Tests has no ${ac} line` };
}

function evidenceFor(root, id, testFile) {
  const dir = join(root, ".agents", "runs", id, "worker-evidence");
  const out = [];
  for (const n of ls(dir).filter((x) => x.endsWith(".yaml"))) {
    const t = read(join(dir, n)) || "";
    const f = (k) => new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(t)?.[1] || "";
    if (!`${f("target")} ${f("command")}`.includes(testFile)) continue;
    out.push({ record: `${relative(root, dir)}/${n}`, phase: f("phase"), result: f("result"), timestamp: f("timestamp") });
  }
  return out;
}

function prFor(root, id) {
  const p = read(join(root, ".agents", "local", "deliver", id, "PR"));
  if (p && p.trim()) return { pr: p.trim(), record: `.agents/local/deliver/${id}/PR` };
  for (const l of (read(join(root, ".agents", "local", "batch", "merged.tsv")) || "").split(/\r?\n/)) {
    const [tid, pr] = l.split("\t");
    if (tid === id && pr) return { pr, record: ".agents/local/batch/merged.tsv" };
  }
  return null;
}

function criterion(root, t, a, missing) {
  const { tests, why } = testsFor(root, t.id, a.ac);
  if (why) missing.push(`${t.id} ${a.ac}: ${why}`);
  for (const x of tests) {
    x.evidence = evidenceFor(root, t.id, x.file);
    if (!x.evidence.length) missing.push(`${t.id} ${a.ac}: no run evidence for ${x.file} in .agents/runs/${t.id}/worker-evidence/`);
  }
  return { ac: a.ac, text: a.text, covers: a.covers, tests };
}

function taskNode(root, t, acs, missing) {
  const node = { id: t.id, file: relative(root, t.file), prd: t.prd, criteria: acs.map((a) => criterion(root, t, a, missing)), pr: prFor(root, t.id) };
  if (!node.pr) missing.push(`${t.id}: no PR recorded (.agents/local/deliver/${t.id}/PR, .agents/local/batch/merged.tsv)`);
  return node;
}

export function trace(query, opts = {}) {
  const root = resolve(opts.root || ".");
  const all = tasks(root, resolve(root, opts.tasksDir || tasksDir(root)));
  const missing = [];
  if (/^N?FR-\d+$/.test(query)) {
    const chains = [];
    for (const f of prds(root, opts.prd)) {
      const p = parsePrd(readFileSync(f, "utf8"));
      const r = p.reqs.find((x) => x.id === query);
      if (!r) continue;
      const slug = basename(dirname(f));
      const deferred = p.deferred.find((d) => d.id === query)?.reason || null;
      const linked = [...all.values()].filter((t) => t.prd === slug && t.acs.some((a) => a.covers.includes(query)));
      if (!linked.length) missing.push(deferred ? `${query} (${slug}): deferred, no task: ${deferred}` : `${query} (${slug}): no task linked (no task with prd: ${slug} has an acceptance criterion that Covers ${query})`);
      chains.push({ requirement: { id: query, prd: relative(root, f), line: r.line, text: r.text }, deferred,
        tasks: linked.map((t) => taskNode(root, t, t.acs.filter((a) => a.covers.includes(query)), missing)) });
    }
    if (!chains.length) return { query, found: false, error: `${query} is defined in no PRD under ${productDir(root)}${opts.prd ? ` (--prd ${opts.prd})` : ""}` };
    return { query, found: true, kind: "requirement", chains, missing, complete: missing.length === 0 };
  }
  const t = all.get(query);
  if (!t) return { query, found: false, error: `no task file for ${query}` };
  const reqs = new Map();
  if (!t.prd) missing.push(`${t.id}: names no PRD (front matter prd: <slug>)`);
  else {
    const f = prds(root, t.prd)[0];
    if (!f) missing.push(`${t.id}: PRD ${t.prd} not found under ${productDir(root)}`);
    else for (const r of parsePrd(readFileSync(f, "utf8")).reqs) if (r.id) reqs.set(r.id, { id: r.id, prd: relative(root, f), line: r.line, text: r.text });
  }
  for (const a of t.acs) {
    if (!a.covers.length) missing.push(`${t.id} ${a.ac}: covers no requirement (no Covers: line)`);
    for (const c of a.covers) if (t.prd && !reqs.has(c)) missing.push(`${t.id} ${a.ac}: Covers ${c}, which PRD ${t.prd} does not define`);
  }
  const node = taskNode(root, t, t.acs, missing);
  const requirements = [...new Set(t.acs.flatMap((a) => a.covers))].map((c) => reqs.get(c) || { id: c, prd: null });
  return { query, found: true, kind: "task", requirements, task: node, missing, complete: missing.length === 0 };
}

function render(r) {
  const out = [];
  const crit = (c, pad) => {
    out.push(`${pad}${c.ac}: ${c.text}`);
    if (!c.tests.length) out.push(`${pad}  test: none linked`);
    for (const x of c.tests) {
      out.push(`${pad}  test: ${x.file}${x.name ? ` "${x.name}"` : ""}`);
      if (!x.evidence.length) out.push(`${pad}    evidence: none`);
      for (const e of x.evidence) out.push(`${pad}    evidence: ${e.phase} ${e.result} ${e.timestamp} (${e.record})`);
    }
  };
  const task = (t, pad) => {
    out.push(`${pad}task ${t.id} (${t.file})`);
    t.criteria.forEach((c) => crit(c, pad + "  "));
    out.push(`${pad}  PR: ${t.pr ? `${t.pr.pr} (${t.pr.record})` : "none recorded"}`);
  };
  if (r.kind === "requirement") for (const c of r.chains) {
    out.push(`${c.requirement.id} (${c.requirement.prd}:${c.requirement.line}): ${c.requirement.text}`);
    if (c.deferred) out.push(`  deferred: ${c.deferred}`);
    if (!c.tasks.length) out.push("  task: none linked");
    c.tasks.forEach((t) => task(t, "  "));
  } else {
    for (const q of r.requirements) out.push(q.prd ? `${q.id} (${q.prd}:${q.line}): ${q.text}` : `${q.id}: not defined in the task's PRD`);
    task(r.task, "");
  }
  out.push(r.missing.length ? `missing links:\n${r.missing.map((m) => `- ${m}`).join("\n")}` : "chain complete");
  return out.join("\n");
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const query = argv.find((a, i) => !a.startsWith("--") && !["--root", "--prd", "--tasks-dir"].includes(argv[i - 1]));
  if (!query) { console.error("usage: trace.mjs <FR-n|NFR-n|TASK-ID> [--prd <slug>] [--tasks-dir DIR] [--root DIR] [--json]"); return 2; }
  const r = trace(query, { root: opt("--root"), prd: opt("--prd"), tasksDir: opt("--tasks-dir") });
  if (!r.found) { console.error(r.error); return 2; }
  console.log(argv.includes("--json") ? JSON.stringify(r, null, 2) : render(r));
  return r.complete ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
