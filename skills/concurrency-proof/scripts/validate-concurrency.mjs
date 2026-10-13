#!/usr/bin/env node
// Validates a concurrency-proof concurrency.json (see ../schema/concurrency.schema.json) and computes the
// REVIEW `concurrency` focus result mechanically.
// Usage: node validate-concurrency.mjs <concurrency.json> [--repo DIR] [--base REF] [--report REPORT.md] [--rows]
//   --repo DIR     re-read every cited file:line in DIR (file exists, line exists, `code` is on that line,
//                  an `accepted_by.quote` is on its line)
//   --base REF     with --repo: every non pre_existing finding has a trace step on a line the diff
//                  REF..working tree adds or changes (untracked files count as added)
//   --report FILE  also checks the `## Verdict` and `## Summary` sections of REPORT.md for safety claims
//   --rows         prints only the submit rows (`blocking|path:line|finding|evidence`, `info|...`)
//   valid   -> exit 0; prints "RESULT: PASS|FAIL", "CONFIDENCE: ..." and "REPRODUCTION: ...".
//   invalid -> exit 1; one line per problem on stderr.
//   usage/read error -> exit 2.
// No dependencies.
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute, basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const posInt = (v) => Number.isInteger(v) && v >= 1;

export const CATEGORIES = ["race", "deadlock", "lost_update", "double_processing", "idempotency", "retry_side_effect",
  "ordering", "redelivery", "timeout", "transaction_boundary", "lock_lifecycle"];
const STATUSES = ["open", "accepted", "closed", "pre_existing"];
const TOP = ["schema_version", "skill_version", "target", "scope", "reproduction", "findings", "unproven_risks", "judged", "verdict"];
const FINDING = ["id", "category", "title", "status", "location", "shared_state", "evidence", "trace", "reproduction", "why_not_reproduced", "accepted_by", "recheck"];
const REPRO = ["command", "runs", "failures", "observed", "saved_copy"];

// A safety claim: the words below outside code. Code is removed first: fenced blocks, `inline code` and
// "double-quoted" text (quoted code or quoted identifiers). Identifiers such as safeParse, is_safe or
// thread_safe never match (no word boundary); "unsafe" and "safety" never match. Negated forms ("not safe")
// are rejected too: the report states what was proven, never a safety property (say "no proven problem").
export const SAFETY_CLAIM = /\b(?:thread[- ]safe|race[- ]free|deadlock[- ]free|concurrency[- ]safe|safe(?:ly)?)\b/i;
export const stripCode = (s) => String(s).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/"[^"\n]*"/g, " ");
export const safetyClaim = (s) => { const m = stripCode(s).match(SAFETY_CLAIM); return m ? m[0] : null; };

export function validate(doc) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  const keys = (o, allowed, path) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) err(path, `unexpected "${k}"`); };
  const loc = (l, path) => {
    if (!isObj(l)) return err(path, "expected {file, line}");
    keys(l, ["file", "line"], path);
    if (!safeRel(l.file)) err(`${path}.file`, "expected a repository-relative path");
    if (!posInt(l.line)) err(`${path}.line`, "expected an integer >= 1");
  };
  const cite = (c, path) => {
    if (!isObj(c)) return err(path, "expected {file, line, quote}");
    keys(c, ["file", "line", "quote"], path);
    if (!safeRel(c.file)) err(`${path}.file`, "expected a repository-relative path");
    if (!posInt(c.line)) err(`${path}.line`, "expected an integer >= 1");
    if (!isStr(c.quote)) err(`${path}.quote`, "expected the cited text");
  };
  if (!isObj(doc)) return ["document: expected a JSON object"];
  keys(doc, TOP, "document");
  if (doc.schema_version !== 1) err("schema_version", "expected 1");
  if (!isStr(doc.skill_version)) err("skill_version", "expected non-empty string");

  const t = doc.target;
  if (!isObj(t)) err("target", "expected object");
  else {
    keys(t, ["type", "name", "base", "head"], "target");
    if (!["working_tree", "branch", "pull_request", "run"].includes(t.type)) err("target.type", "expected working_tree|branch|pull_request|run");
    if (!isStr(t.name)) err("target.name", "expected non-empty string");
    if (!isStr(t.base)) err("target.base", "expected the base commit or ref");
    if (t.head !== null && !isStr(t.head)) err("target.head", "expected a commit or null (working tree)");
  }

  const s = doc.scope;
  let changed = [];
  if (!isObj(s)) err("scope", "expected object");
  else {
    keys(s, ["changed_files", "candidates", "not_reviewed"], "scope");
    if (!Array.isArray(s.changed_files) || !s.changed_files.length || !s.changed_files.every(safeRel)) err("scope.changed_files", "expected a non-empty list of repository-relative paths");
    else changed = s.changed_files;
    if (!Number.isInteger(s.candidates) || s.candidates < 0) err("scope.candidates", "expected the candidate count from find-shared-state.mjs (integer >= 0)");
    if (!Array.isArray(s.not_reviewed)) err("scope.not_reviewed", "expected array");
    else s.not_reviewed.forEach((n, i) => {
      if (!isObj(n)) return err(`scope.not_reviewed[${i}]`, "expected {path, reason}");
      keys(n, ["path", "reason"], `scope.not_reviewed[${i}]`);
      if (!safeRel(n.path)) err(`scope.not_reviewed[${i}].path`, "expected a repository-relative path");
      if (!isStr(n.reason)) err(`scope.not_reviewed[${i}].reason`, "expected non-empty string");
    });
  }

  const r = doc.reproduction;
  if (!isObj(r)) err("reproduction", "expected object: the reproduction status is always stated");
  else {
    keys(r, ["status", "runner", "worktree", "reason"], "reproduction");
    if (r.status === "ran") {
      if (!isStr(r.runner)) err("reproduction.runner", "expected the project's own test command");
      if (!isStr(r.worktree) || !isAbsolute(r.worktree) || !/^concurrency-proof-./.test(basename(r.worktree))) err("reproduction.worktree", "expected an absolute path whose last component starts with concurrency-proof-");
    } else if (r.status === "unsupported" || r.status === "none_needed") {
      if (!isStr(r.reason)) err("reproduction.reason", `status ${r.status} needs the reason`);
      if ("runner" in r || "worktree" in r) err("reproduction", `status ${r.status} carries no runner or worktree`);
    } else err("reproduction.status", "expected ran|unsupported|none_needed");
  }

  const ids = new Set();
  const idCheck = (id, re, path) => {
    if (typeof id !== "string" || !re.test(id)) return err(`${path}.id`, `expected ${re.source}`);
    if (ids.has(id)) err(`${path}.id`, `duplicate id ${id}`);
    ids.add(id);
  };
  const findings = Array.isArray(doc.findings) ? doc.findings : (err("findings", "expected array"), []);
  findings.forEach((f, i) => {
    const p = `findings[${i}]`;
    if (!isObj(f)) return err(p, "expected object");
    keys(f, FINDING, p);
    idCheck(f.id, /^C\d{3}$/, p);
    if (!CATEGORIES.includes(f.category)) err(`${p}.category`, `expected one of ${CATEGORIES.join("|")}`);
    if (!isStr(f.title)) err(`${p}.title`, "expected non-empty string");
    if (!STATUSES.includes(f.status)) err(`${p}.status`, `expected ${STATUSES.join("|")}`);
    if (!isStr(f.shared_state)) err(`${p}.shared_state`, "expected the shared state or resource the actors contend for");
    loc(f.location, `${p}.location`);
    if (f.status !== "pre_existing" && isObj(f.location) && changed.length && !changed.includes(f.location.file)) err(`${p}.location.file`, "a finding in changed code must be in scope.changed_files (else status pre_existing)");
    // trace: the concrete interleaving, always required (a reproduction without a schedule explains nothing)
    const tr = f.trace;
    if (!isObj(tr)) err(`${p}.trace`, "expected {actors, steps, outcome}");
    else {
      keys(tr, ["actors", "steps", "outcome"], `${p}.trace`);
      const actors = Array.isArray(tr.actors) ? tr.actors : [];
      if (!actors.every(isStr) || new Set(actors).size !== actors.length || actors.length < 2) err(`${p}.trace.actors`, "expected at least 2 distinct named actors");
      if (!isStr(tr.outcome)) err(`${p}.trace.outcome`, "expected the observable bad outcome of the schedule");
      const steps = Array.isArray(tr.steps) ? tr.steps : [];
      if (steps.length < 2) err(`${p}.trace.steps`, "expected at least 2 ordered steps");
      const seen = new Set();
      steps.forEach((st, j) => {
        const q = `${p}.trace.steps[${j}]`;
        if (!isObj(st)) return err(q, "expected {n, actor, file, line, action}");
        keys(st, ["n", "actor", "file", "line", "code", "action"], q);
        if (st.n !== j + 1) err(`${q}.n`, `expected ${j + 1}: steps are numbered in schedule order`);
        if (!actors.includes(st.actor)) err(`${q}.actor`, "expected one of trace.actors");
        else seen.add(st.actor);
        if (!safeRel(st.file)) err(`${q}.file`, "expected a repository-relative path");
        if (!posInt(st.line)) err(`${q}.line`, "expected an integer >= 1");
        if ("code" in st && !isStr(st.code)) err(`${q}.code`, "expected the code text on that line");
        if (!isStr(st.action)) err(`${q}.action`, "expected what the actor does at this step");
      });
      if (actors.length >= 2 && steps.length >= 2 && seen.size < 2) err(`${p}.trace.steps`, "expected steps of at least 2 different actors");
      if (actors.some((a) => isStr(a) && !seen.has(a)) && seen.size >= 2) err(`${p}.trace.actors`, "every actor takes at least one step");
      if (isObj(f.location) && steps.length && !steps.some((st) => isObj(st) && st.file === f.location.file && st.line === f.location.line)) err(`${p}.location`, "expected the location to be one of the trace steps");
    }
    if (f.evidence === "reproduced") {
      const rp = f.reproduction;
      if ("why_not_reproduced" in f) err(`${p}.why_not_reproduced`, "a reproduced finding carries no why_not_reproduced");
      if (!isObj(r) || r.status !== "ran") err(`${p}.evidence`, "reproduced requires reproduction.status ran");
      if (!isObj(rp)) err(`${p}.reproduction`, "expected object");
      else {
        keys(rp, REPRO, `${p}.reproduction`);
        if (!isStr(rp.command)) err(`${p}.reproduction.command`, "expected the command that was run");
        if (!Number.isInteger(rp.runs) || rp.runs < 2) err(`${p}.reproduction.runs`, "expected an integer >= 2 (concurrent or repeated runs)");
        if (!Number.isInteger(rp.failures) || rp.failures < 1 || rp.failures > rp.runs) err(`${p}.reproduction.failures`, "expected 1..runs runs that showed the failure");
        if (!isStr(rp.observed)) err(`${p}.reproduction.observed`, "expected the observed failure (output excerpt)");
        if (!safeRel(rp.saved_copy) || !/^evidence\//.test(rp.saved_copy)) err(`${p}.reproduction.saved_copy`, "expected a path under evidence/");
      }
    } else if (f.evidence === "traced") {
      if ("reproduction" in f) err(`${p}.reproduction`, "a traced finding carries no reproduction");
      if (!isStr(f.why_not_reproduced)) err(`${p}.why_not_reproduced`, "expected why the schedule was not reproduced (e.g. reproduction UNSUPPORTED)");
    } else err(`${p}.evidence`, "expected traced|reproduced (anything else is an unproven risk)");
    if (f.status === "accepted") cite(f.accepted_by, `${p}.accepted_by`);
    else if ("accepted_by" in f) err(`${p}.accepted_by`, "only an accepted finding cites the plan or spec");
    if (f.status === "closed" && !isStr(f.recheck)) err(`${p}.recheck`, "a closed finding needs the re-check that closed it");
  });

  const unproven = Array.isArray(doc.unproven_risks) ? doc.unproven_risks : (err("unproven_risks", "expected array"), []);
  unproven.forEach((u, i) => {
    const p = `unproven_risks[${i}]`;
    if (!isObj(u)) return err(p, "expected object");
    keys(u, ["id", "category", "location", "reason", "why_unproven"], p);
    idCheck(u.id, /^U\d{3}$/, p);
    if (!CATEGORIES.includes(u.category)) err(`${p}.category`, `expected one of ${CATEGORIES.join("|")}`);
    loc(u.location, `${p}.location`);
    if (!isStr(u.reason)) err(`${p}.reason`, "expected non-empty string");
    if (!isStr(u.why_unproven)) err(`${p}.why_unproven`, "expected what is missing to prove it");
  });

  const judged = Array.isArray(doc.judged) ? doc.judged : (err("judged", "expected array"), []);
  judged.forEach((j, i) => {
    const p = `judged[${i}]`;
    if (!isObj(j)) return err(p, "expected object");
    keys(j, ["id", "location", "note", "violates"], p);
    idCheck(j.id, /^J\d{3}$/, p);
    loc(j.location, `${p}.location`);
    if (!isStr(j.note)) err(`${p}.note`, "expected non-empty string");
    if ("violates" in j) cite(j.violates, `${p}.violates`);
  });

  if (isObj(r) && r.status === "none_needed" && (findings.length || unproven.length)) err("reproduction.status", "none_needed only when there is no finding and no unproven risk");

  const v = doc.verdict;
  if (!isObj(v)) err("verdict", "expected {summary}");
  else {
    keys(v, ["summary"], "verdict");
    if (!isStr(v.summary)) err("verdict.summary", "expected non-empty string");
    else { const w = safetyClaim(v.summary); if (w) err("verdict.summary", `asserts safety ("${w}"): PASS means no proven problem; state what was proven`); }
  }
  return errors;
}

// Re-reads cited lines in the repository; with base, checks that each finding in changed code has a trace
// step on a changed line.
export function checkRepo(doc, repo, base) {
  const errors = [];
  const root = realpathSync(repo);
  const cache = new Map();
  const lines = (file) => {
    if (cache.has(file)) return cache.get(file);
    let out = null;
    const abs = join(root, file);
    try {
      const real = realpathSync(abs);
      if ((real === root || real.startsWith(root + sep)) && statSync(real).isFile()) out = readFileSync(real, "utf8").replace(/\n$/, "").split("\n");
    } catch { out = null; }
    cache.set(file, out);
    return out;
  };
  const at = (file, line, path, text) => {
    const ls = lines(file);
    if (!ls) return errors.push(`${path}: ${file} does not exist in the repository`);
    if (line > ls.length) return errors.push(`${path}: ${file} has ${ls.length} lines, not ${line}`);
    if (text !== undefined && !ls[line - 1].includes(String(text).trim())) errors.push(`${path}: ${file}:${line} does not contain ${JSON.stringify(String(text).trim())}`);
  };
  let changedLines = null;
  if (base) changedLines = diffLines(root, base);
  (doc.findings || []).forEach((f, i) => {
    const p = `findings[${i}]`;
    const steps = (f.trace && f.trace.steps) || [];
    steps.forEach((st, j) => at(st.file, st.line, `${p}.trace.steps[${j}]`, st.code));
    if (f.accepted_by) at(f.accepted_by.file, f.accepted_by.line, `${p}.accepted_by`, f.accepted_by.quote);
    if (changedLines && f.status !== "pre_existing" && !steps.some((st) => changedLines.get(st.file)?.has(st.line))) {
      errors.push(`${p}: no trace step is on a line changed since ${base}: a problem outside the change is pre_existing`);
    }
  });
  (doc.unproven_risks || []).forEach((u, i) => u.location && at(u.location.file, u.location.line, `unproven_risks[${i}].location`));
  (doc.judged || []).forEach((j, i) => {
    if (j.location) at(j.location.file, j.location.line, `judged[${i}].location`);
    if (j.violates) at(j.violates.file, j.violates.line, `judged[${i}].violates`, j.violates.quote);
  });
  return errors;
}

// Map file -> Set of line numbers that the working tree adds or changes relative to base.
export function diffLines(root, base) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  const map = new Map();
  let file = null;
  for (const l of git("diff", "-U0", "--no-color", "--no-ext-diff", base, "--").split("\n")) {
    if (l.startsWith("+++ ")) { file = l === "+++ /dev/null" ? null : l.slice(6); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file) {
      const start = +m[1], n = m[2] === undefined ? 1 : +m[2];
      if (!map.has(file)) map.set(file, new Set());
      for (let k = 0; k < n; k++) map.get(file).add(start + k);
    }
  }
  for (const f of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) {
    try { map.set(f, new Set(readFileSync(join(root, f), "utf8").split("\n").map((_, k) => k + 1))); } catch { /* unreadable: not cited */ }
  }
  return map;
}

// The `## Verdict` and `## Summary` sections of REPORT.md must not assert safety either.
export function checkReport(text) {
  const errors = [];
  let sec = null;
  const body = { Verdict: "", Summary: "" };
  for (const l of String(text).split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) { sec = h[1] in body ? h[1] : null; continue; }
    if (sec) body[sec] += l + "\n";
  }
  for (const [k, b] of Object.entries(body)) { const w = safetyClaim(b); if (w) errors.push(`REPORT.md ## ${k}: asserts safety ("${w}"): state what was proven`); }
  return errors;
}

// Gate rule: an open finding (traced or reproduced, in changed code, not accepted by the plan) or a judged
// item that violates a written criterion -> FAIL; otherwise PASS, which means "no proven problem".
export function gate(doc) {
  const open = doc.findings.filter((f) => f.status === "open");
  const violating = doc.judged.filter((j) => j.violates);
  const confidence = doc.scope.not_reviewed.length ? "low" : doc.reproduction.status === "unsupported" ? "medium" : "high";
  return { result: open.length || violating.length ? "FAIL" : "PASS", confidence, open, violating };
}

const cell = (s) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
export function rows(doc) {
  const g = gate(doc);
  const out = [];
  const sched = (f) => f.trace.steps.map((st) => `${st.n}.${st.actor}@${st.file}:${st.line}`).join(" -> ");
  for (const f of g.open) {
    const ev = f.evidence === "reproduced"
      ? `reproduced: ${f.reproduction.command}; failed ${f.reproduction.failures}/${f.reproduction.runs} runs; ${f.reproduction.observed}; schedule ${sched(f)}`
      : `traced: ${sched(f)}; ${f.trace.outcome}`;
    out.push(`blocking|${f.location.file}:${f.location.line}|${cell(`${f.id} ${f.category}: ${f.title}`)}|${cell(ev)}`);
  }
  for (const j of g.violating) out.push(`blocking|${j.location.file}:${j.location.line}|${cell(`${j.id} judged: ${j.note}`)}|${cell(`violates ${j.violates.file}:${j.violates.line} "${j.violates.quote}"`)}`);
  for (const f of doc.findings.filter((x) => x.status === "pre_existing")) out.push(`info|${f.location.file}:${f.location.line}|${cell(`${f.id} pre-existing ${f.category}: ${f.title}`)}|${cell(`${f.evidence}: ${sched(f)}`)}`);
  for (const u of doc.unproven_risks) out.push(`info|${u.location.file}:${u.location.line}|${cell(`${u.id} unproven ${u.category}: ${u.reason}`)}|${cell(`not proven: ${u.why_unproven}`)}`);
  if (doc.reproduction.status === "unsupported") out.push(`info|-|${cell(`reproduction UNSUPPORTED: ${doc.reproduction.reason}`)}|traced evidence only`);
  return out.join("\n");
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = { rows: false };
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rows") opt.rows = true;
    else if (a === "--repo" || a === "--base" || a === "--report") { if (i + 1 >= args.length) { console.error(`${a} needs a value`); process.exit(2); } opt[a.slice(2)] = args[++i]; }
    else if (a.startsWith("--")) { console.error(`unknown option ${a}`); process.exit(2); }
    else files.push(a);
  }
  if (files.length !== 1 || (opt.base && !opt.repo)) { console.error("usage: validate-concurrency.mjs <concurrency.json> [--repo DIR [--base REF]] [--report REPORT.md] [--rows]"); process.exit(2); }
  let doc, report;
  try { doc = JSON.parse(readFileSync(files[0], "utf8")); } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  if (opt.report) { try { report = readFileSync(opt.report, "utf8"); } catch (e) { console.error(`cannot read report: ${e.message}`); process.exit(2); } }
  if (opt.repo && !existsSync(opt.repo)) { console.error(`no such repository: ${opt.repo}`); process.exit(2); }
  const errors = validate(doc);
  if (!errors.length && opt.repo) {
    try { errors.push(...checkRepo(doc, opt.repo, opt.base)); } catch (e) { console.error(`cannot read the repository diff: ${e.message.split("\n")[0]}`); process.exit(2); }
  }
  if (report !== undefined) errors.push(...checkReport(report));
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  if (opt.rows) { const r = rows(doc); if (r) console.log(r); return; } // rows only, ready for `submit --findings -`
  const g = gate(doc);
  const rp = doc.reproduction;
  console.log(`RESULT: ${g.result}\nCONFIDENCE: ${g.confidence}\nREPRODUCTION: ${rp.status === "ran" ? "ran" : rp.status === "unsupported" ? `UNSUPPORTED (${rp.reason})` : `none_needed (${rp.reason})`}`);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
