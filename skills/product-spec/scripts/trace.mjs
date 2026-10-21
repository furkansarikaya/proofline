#!/usr/bin/env node
// Read-only trace for `/proofline trace <FR-n|NFR-n|TASK-ID>`: requirement -> task -> acceptance criterion -> test
// -> run evidence -> pull request, built only from records on disk (references/PRD-FORMAT.md#trace). Writes nothing.
//   node trace.mjs <FR-n|NFR-n|TASK-ID> [--prd <slug|PRD.md>] [--tasks-dir DIR] [--root DIR] [--json]
// Records read, live run (.agents/runs/<ID>/ exists): the run's PLAN.md `## Tests` and worker-evidence/*.yaml.
// No run folder (delivered; cleanup deleted the run): the task file's `## Completion Report` block (TDD Evidence and
// Verification lines that name a test file), the delivery commit (`git log --grep "(<ID>)"`, the test files its diff
// names) and the merge commit `Merge pull request #N` that brought it in (or a squash subject ending `(#N)`).
// PR fallback: .agents/local/deliver/<ID>/PR, .agents/local/batch/merged.tsv. Git is only read (log, show).
// Exit 0: every link found. 1: a link is missing (each is named). 2: usage, or the id matches no record.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

const git = (root, args) => { try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?)\/|[._-](test|spec)s?\.[A-Za-z0-9]+$|_test\.go$/;
const isLive = (root, id) => existsSync(join(root, ".agents", "runs", id));

// Durable records of a task without a run folder (delivered, cleanup deleted the run), read once per task.
function delivered(root, t) {
  if (t.durable) return t.durable;
  const text = read(t.file) || "";
  const b = text.indexOf(`<!-- COMPLETION-REPORT:BEGIN:${t.id} -->`), e = text.indexOf(`<!-- COMPLETION-REPORT:END:${t.id} -->`);
  const report = b >= 0 && e > b ? text.slice(b, e) : (/^## Completion Report\s*$([\s\S]*)/m.exec(text)?.[1] || "");
  const lines = [];
  let sec = "";
  for (const l of report.split(/\r?\n/)) {
    const h = /^#{2,3} (.+?)\s*$/.exec(l);
    if (h) { sec = h[1]; continue; }
    if (["TDD Evidence", "Verification"].includes(sec) && l.trim()) lines.push({ section: sec, text: l.trim() });
  }
  const commits = git(root, ["log", "--format=%H%x09%s", "-F", `--grep=(${t.id})`, "HEAD"]).split("\n").filter(Boolean)
    .map((l) => { const [sha, ...subj] = l.split("\t"); return { sha, subject: subj.join("\t") }; })
    .filter((c) => c.subject.includes(`(${t.id})`));
  const files = [...new Set(commits.flatMap((c) => git(root, ["show", "--name-only", "--format=", c.sha]).split("\n").filter((f) => TEST_FILE.test(f))))];
  let pr = null;
  for (const c of commits) {
    const squash = /\(#(\d+)\)\s*$/.exec(c.subject);
    if (squash) { pr = { pr: squash[1], record: `commit ${c.sha.slice(0, 12)} "${c.subject}"` }; break; }
    // the earliest merge on the ancestry path from the delivery commit to HEAD is the one that brought it in
    const merges = git(root, ["log", "--merges", "--ancestry-path", "--format=%H%x09%s", `${c.sha}..HEAD`]).split("\n").filter(Boolean).reverse();
    for (const m of merges) {
      const [msha, ...rest] = m.split("\t"); const subj = rest.join("\t"); const n = /^Merge pull request #(\d+)\b/.exec(subj);
      if (n) { pr = { pr: n[1], record: `merge commit ${msha.slice(0, 12)} "${subj}"` }; break; }
    }
    if (pr) break;
  }
  t.durable = { lines, commits, files, pr };
  return t.durable;
}

// Live run: `## Tests` of the run's PLAN.md (`- AC-<n>: \`<file>\` "<name>" ...`). No run: completion report lines that
// name the criterion and a test file, else the test files of the delivery commit (task level: the per-criterion map
// lived in the deleted PLAN.md).
function testsFor(root, t, ac) {
  const id = t.id;
  if (!isLive(root, id)) {
    const d = delivered(root, t);
    if (!d.commits.length) return { tests: [], why: `no test linked: no run folder and no delivery commit "(${id})" in git log` };
    if (!d.files.length) return { tests: [], why: `no test linked: delivery commit ${d.commits[0].sha.slice(0, 12)} changes no test file` };
    const named = d.files.filter((f) => d.lines.some((l) => l.text.includes(ac) && l.text.includes(f)));
    const level = named.length ? "criterion" : "task";
    return { tests: (named.length ? named : d.files).map((f) => ({ file: f, name: null, level, record: `commit ${d.commits[0].sha.slice(0, 12)}` })), why: null };
  }
  const plan = read(join(root, ".agents", "runs", id, "PLAN.md"));
  if (plan === null) return { tests: [], why: `no test linked: no .agents/runs/${id}/PLAN.md` };
  const out = [];
  let on = false;
  for (const l of plan.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(l);
    if (h) { on = h[1] === "Tests"; continue; }
    const m = on && new RegExp(`^\\s*[-*]\\s+${ac}:\\s*\`([^\`]+)\`(?:\\s+"([^"]*)")?`).exec(l);
    if (m) out.push({ file: m[1], name: m[2] || null, level: "criterion", record: `.agents/runs/${id}/PLAN.md` });
  }
  return { tests: out, why: out.length ? null : `no test linked: PLAN.md ## Tests has no ${ac} line` };
}

function evidenceFor(root, t, testFile) {
  if (!isLive(root, t.id)) {
    return delivered(root, t).lines.filter((l) => l.text.includes(testFile)).map((l) => ({
      record: `${relative(root, t.file)} ## Completion Report / ${l.section}`,
      phase: /\b(RED|GREEN|REFACTOR|FIX)\b/.exec(l.text)?.[1] || l.section,
      result: /\b(pass|fail)/i.exec(l.text)?.[1]?.toLowerCase() || "", timestamp: "", text: l.text,
    }));
  }
  const dir = join(root, ".agents", "runs", t.id, "worker-evidence");
  const out = [];
  for (const n of ls(dir).filter((x) => x.endsWith(".yaml"))) {
    const y = read(join(dir, n)) || "";
    const f = (k) => new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(y)?.[1] || "";
    if (!`${f("target")} ${f("command")}`.includes(testFile)) continue;
    out.push({ record: `${relative(root, dir)}/${n}`, phase: f("phase"), result: f("result"), timestamp: f("timestamp") });
  }
  return out;
}

function prFor(root, t) {
  const p = read(join(root, ".agents", "local", "deliver", t.id, "PR"));
  if (p && p.trim()) return { pr: p.trim(), record: `.agents/local/deliver/${t.id}/PR` };
  if (!isLive(root, t.id)) { const d = delivered(root, t); if (d.pr) return d.pr; }
  for (const l of (read(join(root, ".agents", "local", "batch", "merged.tsv")) || "").split(/\r?\n/)) {
    const [tid, pr] = l.split("\t");
    if (tid === t.id && pr) return { pr, record: ".agents/local/batch/merged.tsv" };
  }
  return null;
}

function criterion(root, t, a, missing) {
  const { tests, why } = testsFor(root, t, a.ac);
  if (why) missing.push(`${t.id} ${a.ac}: ${why}`);
  for (const x of tests) {
    x.evidence = evidenceFor(root, t, x.file);
    if (!x.evidence.length) missing.push(isLive(root, t.id)
      ? `${t.id} ${a.ac}: no run evidence for ${x.file} in .agents/runs/${t.id}/worker-evidence/`
      : `${t.id} ${a.ac}: no run evidence for ${x.file}: no TDD Evidence or Verification line of the task's completion report names it`);
  }
  return { ac: a.ac, text: a.text, covers: a.covers, tests };
}

function taskNode(root, t, acs, missing) {
  const node = { id: t.id, file: relative(root, t.file), prd: t.prd, run: isLive(root, t.id), criteria: acs.map((a) => criterion(root, t, a, missing)), pr: prFor(root, t) };
  if (!node.pr) missing.push(`${t.id}: no PR recorded (merge commit, .agents/local/deliver/${t.id}/PR, .agents/local/batch/merged.tsv)`);
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
      out.push(`${pad}  test: ${x.file}${x.name ? ` "${x.name}"` : ""}${x.level === "task" ? " (task level)" : ""} (${x.record})`);
      if (!x.evidence.length) out.push(`${pad}    evidence: none`);
      for (const e of x.evidence) out.push(`${pad}    evidence: ${e.text || [e.phase, e.result, e.timestamp].filter(Boolean).join(" ")} (${e.record})`);
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
