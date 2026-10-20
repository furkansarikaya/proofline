#!/usr/bin/env node
// Validates a proofline PLAN.md against its TASK.md and the repository (see ../references/).
// Checks: canonical `scope:` front matter, path <-> criterion mapping in both directions,
// scope paths exist (or are `new: true`), no globs, no duplicates, tdd_exemption quality,
// sections required by class, `## Data` first line, `## Assumptions` register shape, no placeholder sections.
// No dependencies.
// Usage: node <skill-dir>/scripts/validate-plan.mjs <PLAN.md> <TASK.md> [--class C] [--repo <dir>] [--entry-words <regex>]
// Exit codes: 0 valid, 1 invalid (one message per line), 2 usage or read error.

import { readFileSync, realpathSync, statSync, existsSync } from "node:fs";
import { resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Shared rule, duplicated in verify-proof's validate-verify.mjs (skills share no files; tests pin both): an
// optional bullet marker followed by a space, optional backticks, `visual_proof:` and the value.
// A112: the same line visual-proof's validate-visual.mjs accepts as the same-origin-write allowance.
const VISUAL_WRITES_LINE = /^\s*(?:[-*]\s*)?`?visual_writes:[ \t]*\S/m;
const VISUAL_PROOF_LINE = /^\s*(?:[-*]\s+)?`?visual_proof:\s*([^`]*?)\s*`?\s*$/;

export const CLASSES = ["TRIVIAL", "STANDARD", "COMPLEX", "CRITICAL"];
export const BASE_SECTIONS = ["Behavior", "Tests", "Verification commands", "Dependencies", "Contracts", "Assumptions"];
export const ARCHITECTURE_CLASSES = ["COMPLEX", "CRITICAL"];
export const MAX_SCOPE_PATHS = { TRIVIAL: 2 };
// A162 input validation at entry points. Mirrors agent.sh plan_entry_points / plan_validation_missing (skills share no
// files, so the code and the default expression are copied; config validation.entry_words is the project's own list and
// is passed with --entry-words). A `## Contracts` bullet that matches the expression and does not remove the contract
// declares an entry point that takes external input, named by its first backticked token, else by the text before the
// first colon. Each one needs a `## Validation` bullet naming it with `accepts`, `limits` and `rejected at`.
export const ENTRY_WORDS = "(^|[^A-Za-z0-9_])((GET|POST|PUT|PATCH|DELETE) +/[^ ]*|endpoints?|routes?|handlers?|webhooks?|consumers?|subscribers?|forms?|cli +(arguments?|args?|flags?|options?|commands?)|command-line|argv|rpc|grpc|graphql)([^A-Za-z0-9_]|$)";
const CONTRACT_REMOVED = /(^|[^A-Za-z0-9_])(removes?|removed|dropped|drops|deprecated|deprecates?|no longer)([^A-Za-z0-9_]|$)/i;
export function entryPoints(contractLines, words = ENTRY_WORDS) {
  const re = new RegExp(words, "i");
  const out = [];
  for (const l of contractLines || []) {
    const m = /^\s*[-*]\s+(\S.*)$/.exec(l);
    if (!m || !re.test(m[1]) || CONTRACT_REMOVED.test(m[1])) continue;
    const bt = /`([^`]*)`/.exec(m[1]);
    const name = (bt ? bt[1] : m[1].split(":")[0]).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
export function validationMissing(contractLines, validationLines, words = ENTRY_WORDS) {
  const lines = (validationLines || []).filter((l) => /^\s*[-*]\s/.test(l));
  return entryPoints(contractLines, words).filter((n) => !lines.some((l) => l.includes(n) && /accepts/i.test(l) && /limits/i.test(l) && /rejected at/i.test(l)));
}
export const SCOPE_KEYS = ["path", "criteria", "new", "tdd_exemption"];
// Paths that mean persistence or UI changed; the plan then needs `## Data` / `## UI`.
export const DATA_PATH = /(^|\/)(migrations?|schema|db|database|prisma|sql)(\/|\.|$)|\.sql$/i;
export const UI_PATH = /\.(html?|css|scss|less|jsx|tsx|vue|svelte)$|(^|\/)(ui|views|components|pages|templates)\//i;
// Phrases that say "no reason" in many words; stripped before the 20-character minimum is measured.
export const STOCK_PHRASES = [
  "not applicable", "n/a", "no tests needed", "no test needed", "tests not needed", "test not needed",
  "tdd not needed", "not needed", "not testable", "untestable", "trivial change", "trivial", "simple change",
  "configuration change", "config change", "config only", "documentation only", "docs only", "no logic",
  "no behavior change", "for this change", "this change", "this file", "in this case",
];

// A79 assumption register: `## Assumptions` is `none` or a table with exactly these columns. The status written
// in the artifact is verified|unverified; `accepted-by-user` is recorded by the run (the user's answer), never here.
// Mirrors agent.sh assumption_scan and the evidence-map validator (skills are standalone, so the code is copied).
export const ASSUMPTION_COLUMNS = ["id", "assumption", "source", "risk", "verification", "status", "decisions"];
const NO_METHOD = /^(none|n\/a|-|tbd|todo|unknown)?$/i;
export function assumptionProblems(lines) {
  const out = [];
  const content = lines.filter((l) => l.trim() !== "");
  if (content.length === 0) return ['section "## Assumptions" is empty: write "none" or the assumption table'];
  if (content.length === 1 && /^none\s*$/i.test(content[0].trim())) return out;
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const ids = new Set();
  let header = false, rows = 0;
  for (const l of content) {
    if (!/^\s*\|.*\|\s*$/.test(l)) { out.push(`Assumptions: "${l.trim()}" is not a table row (write "none" or the table)`); continue; }
    const c = cells(l);
    if (!header) {
      header = true;
      if (c.join("|").toLowerCase() !== ASSUMPTION_COLUMNS.join("|")) out.push(`Assumptions: header must be | ${ASSUMPTION_COLUMNS.join(" | ")} |`);
      continue;
    }
    if (/^:?-+:?$/.test(c[0])) continue;
    rows++;
    const [id, text, source, risk, method, status, decisions] = c;
    const at = `Assumptions ${id || "(no id)"}`;
    if (c.length !== 7) { out.push(`${at}: expected 7 columns`); continue; }
    if (!/^AS-\d+$/.test(id)) out.push(`${at}: id must match AS-<n>`);
    if (ids.has(id)) out.push(`${at}: duplicate id`);
    ids.add(id);
    if (!text) out.push(`${at}: assumption text is empty`);
    if (!source) out.push(`${at}: source is empty`);
    if (!["low", "medium", "high"].includes(risk)) out.push(`${at}: risk must be low|medium|high`);
    if (!["verified", "unverified"].includes(status)) out.push(`${at}: status must be verified|unverified (accepted-by-user is recorded by the run, not written here)`);
    if (status === "verified" && NO_METHOD.test(method)) out.push(`${at}: verified without a verification method (name what was checked, for example a claim id or a command)`);
    if (risk === "high" && NO_METHOD.test(method)) out.push(`${at}: a high-risk assumption needs a verification method`);
    if (!decisions) out.push(`${at}: decisions is empty (name what the assumption affects)`);
  }
  if (rows === 0) out.push('section "## Assumptions" has no assumption rows: write "none" or the table');
  return out;
}

// A destructive `## Data` section is accepted as expand/contract when its step table has a non-destructive
// step in an early phase (expand, backfill, switch) and every destructive step in a late phase (contract, deferred; A141); `single_step: yes` opts out (the control
// plane then requires the user's single_step approval after the freeze, before IMPLEMENT). Mirrors agent.sh plan_migration_shape.
export function migrationShape(lines) {
  let single = false, pre = false, early = false, late = false;
  for (const l of lines) {
    if (/^\s*(?:[-*]\s*)?single_step:\s*yes\s*$/i.test(l)) { single = true; continue; }
    if (!l.startsWith("|")) continue;
    const cells = l.split("|").map((c) => c.trim().toLowerCase());
    if (cells.length < 8) continue;
    const phase = cells[2], dest = cells[5];
    if (!["expand", "backfill", "switch", "contract", "deferred"].includes(phase)) continue;
    if (dest === "yes") { if (phase === "deferred" || phase === "contract") late = true; else early = true; }
    else if (["expand", "backfill", "switch"].includes(phase)) pre = true;
  }
  return single ? "single_step" : pre && late && !early ? "expand_contract" : "missing";
}

export function exemptionProblem(text) {
  if (typeof text !== "string") return "must be a string";
  let norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm.length < 20) return "must be at least 20 characters";
  for (const p of [...STOCK_PHRASES].sort((a, b) => b.length - a.length)) norm = norm.split(p).join(" ");
  if (norm.replace(/[^a-z0-9]/g, "").length < 15) return "is a stock phrase, not a specific reason";
  return null;
}

const unquote = (v) => {
  const m = /^"(.*)"$/.exec(v) || /^'(.*)'$/.exec(v);
  return m ? m[1] : v;
};

// Parses the canonical front matter (the same subset agent.sh reads with awk):
//   ---\nscope:\n  - path: P\n    criteria: [AC-1, AC-2]\n    new: true\n    tdd_exemption: "..."\n---
export function parseFrontMatter(md) {
  const errors = [];
  const lines = md.split(/\r?\n/);
  if (lines[0] !== "---") return { errors: ["front matter: PLAN.md must start with a '---' line"], scope: [] };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { errors: ["front matter: no closing '---' line"], scope: [] };
  const scope = [];
  let inScope = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const at = `front matter line ${i + 1}`;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (line === "scope:") { inScope = true; continue; }
    let m;
    if ((m = /^ {2}- path: (.+)$/.exec(line)) && inScope) {
      // agent.sh reads the path literally with awk, so quoting would make the two disagree.
      if (/^["']|\s$/.test(m[1])) errors.push(`${at}: path must be unquoted, without trailing spaces`);
      scope.push({ path: m[1].trim(), line: i + 1 });
      continue;
    }
    if ((m = /^ {4}([a-z_]+): (.+)$/.exec(line)) && inScope && scope.length) {
      const [, key, raw] = m;
      const entry = scope[scope.length - 1];
      if (!SCOPE_KEYS.includes(key) || key === "path") { errors.push(`${at}: unknown scope key "${key}"`); continue; }
      if (key in entry) { errors.push(`${at}: "${key}" given twice for ${entry.path}`); continue; }
      if (key === "criteria") {
        const fl = /^\[(.*)\]$/.exec(raw.trim());
        if (!fl) { errors.push(`${at}: criteria must be a flow list like [AC-1, AC-2]`); continue; }
        entry.criteria = fl[1].split(",").map((s) => s.trim()).filter(Boolean);
      } else if (key === "new") {
        if (!["true", "false"].includes(raw.trim())) { errors.push(`${at}: new must be true or false`); continue; }
        entry.new = raw.trim() === "true";
      } else entry.tdd_exemption = unquote(raw.trim());
      continue;
    }
    errors.push(`${at}: not part of the canonical scope format: ${line.trim()}`);
  }
  if (!inScope) errors.push("front matter: no 'scope:' key");
  return { errors, scope, bodyStart: end + 1 };
}

function sections(lines) {
  const out = new Map();
  let cur = null;
  for (const line of lines) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; out.set(cur, out.has(cur) ? null : []); continue; }
    if (cur && out.get(cur)) out.get(cur).push(line);
  }
  return out;
}

export function parseTask(md) {
  const lines = md.split(/\r?\n/);
  const id = (/^# Task: (\S+)/m.exec(md) || [])[1] || null;
  const secs = sections(lines);
  const criteria = [];
  for (const l of secs.get("Acceptance criteria") || []) {
    const m = /^\s*(?:[-*]|\d+\.)?\s*(AC-\d+):\s*\S/.exec(l);
    if (m) criteria.push(m[1]);
  }
  const cls = ((secs.get("Suggested class") || []).join(" ").match(/\b(TRIVIAL|STANDARD|COMPLEX|CRITICAL)\b/) || [])[1] || null;
  return { id, criteria, cls };
}

const isPlaceholder = (body) => body.every((l) => /^\s*(<[^>]*>|tbd|todo|\.\.\.|-)?\s*$/i.test(l));

export function validate(planMd, taskMd, { root, cls, entryWords } = {}) {
  const errors = [];
  const task = parseTask(taskMd);
  const fm = parseFrontMatter(planMd);
  errors.push(...fm.errors);
  const klass = cls || task.cls;
  if (!CLASSES.includes(klass)) errors.push(`class: "${klass}" is not one of ${CLASSES.join("|")} (pass --class or set TASK.md "## Suggested class")`);
  if (task.criteria.length === 0) errors.push("TASK.md: no acceptance criteria (AC-<n>: ...) found");
  if (new Set(task.criteria).size !== task.criteria.length) errors.push("TASK.md: duplicate acceptance criterion ids");
  const planId = (/^# Plan: (\S+)/m.exec(planMd) || [])[1];
  if (!planId) errors.push('title: "# Plan: <TASK-ID>" is missing');
  else if (task.id && planId !== task.id) errors.push(`title: plan is for ${planId}, task is ${task.id}`);

  const rootReal = realpathSync(root);
  const seen = new Set();
  const mapped = new Set();
  if (fm.scope.length === 0 && fm.errors.length === 0) errors.push("scope: empty; a plan without scope changes nothing");
  if (MAX_SCOPE_PATHS[klass] && fm.scope.length > MAX_SCOPE_PATHS[klass]) errors.push(`scope: ${klass} allows at most ${MAX_SCOPE_PATHS[klass]} paths, plan has ${fm.scope.length}; reclassify`);
  for (const e of fm.scope) {
    const at = `scope ${e.path}`;
    if (/[*?[\]{}]/.test(e.path)) { errors.push(`${at}: glob patterns are not allowed; list each file`); continue; }
    if (isAbsolute(e.path) || e.path.split(/[\\/]/).includes("..") || e.path.startsWith("./")) { errors.push(`${at}: must be repo-relative, without "./" or ".."`); continue; }
    if (/(^|\/)\.agents\/(runs|local)\//.test(e.path)) errors.push(`${at}: run artifacts and local state are not scope`);
    if (seen.has(e.path)) errors.push(`${at}: duplicate path`);
    seen.add(e.path);
    if (!e.criteria || e.criteria.length === 0) errors.push(`${at}: maps to no criterion`);
    for (const c of e.criteria || []) {
      if (!task.criteria.includes(c)) errors.push(`${at}: unknown criterion ${c}`);
      else mapped.add(c);
    }
    if ("tdd_exemption" in e) {
      const p = exemptionProblem(e.tdd_exemption);
      if (p) errors.push(`${at}: tdd_exemption ${p}`);
    }
    const abs = resolve(rootReal, e.path);
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) errors.push(`${at}: resolves outside the repository`);
      else if (statSync(real).isDirectory()) errors.push(`${at}: is a directory; list each file`);
      if (e.new) errors.push(`${at}: exists but is marked new: true`);
    } else if (!e.new) errors.push(`${at}: does not exist; mark it new: true if the plan creates it`);
  }

  const body = sections(planMd.split(/\r?\n/).slice(fm.bodyStart || 0));
  for (const [name, content] of body) if (content === null) errors.push(`section "## ${name}" appears more than once`);
  const scopePaths = fm.scope.map((e) => e.path);
  const required = [...BASE_SECTIONS];
  if (ARCHITECTURE_CLASSES.includes(klass)) required.push("Architecture");
  if (scopePaths.some((p) => DATA_PATH.test(p))) required.push("Data");
  // A TRIVIAL change is text or configuration: a copy edit in a UI file needs no `## UI` section (and no designer).
  if (klass !== "TRIVIAL" && scopePaths.some((p) => UI_PATH.test(p))) required.push("UI");
  for (const s of required) if (!body.has(s)) errors.push(`section "## ${s}" is required${s === "Architecture" ? ` for ${klass}` : s === "Data" ? " (scope touches persistence)" : s === "UI" ? " (scope touches UI)" : ""}`);
  for (const [name, content] of body) if (content && name !== "Assumptions" && isPlaceholder(content)) errors.push(`section "## ${name}" is empty or a placeholder`);
  if (body.get("Assumptions")) errors.push(...assumptionProblems(body.get("Assumptions")));

  const tests = body.get("Tests") || [];
  for (const l of tests) {
    const m = /^\s*-\s*(AC-\d+):\s*(.*)$/.exec(l);
    if (!m) continue;
    if (!task.criteria.includes(m[1])) { errors.push(`Tests: unknown criterion ${m[1]}`); continue; }
    const refs = [...m[2].matchAll(/`([^`\s:]+)(?::[^`\s]+)?`/g)].map((x) => x[1]);
    const ok = refs.some((p) => scopePaths.includes(p) || (!isAbsolute(p) && !p.split("/").includes("..") && existsSync(resolve(rootReal, p))));
    if (!ok) errors.push(`Tests: ${m[1]} names no test file in backticks that exists or is in scope`);
    else mapped.add(m[1]);
  }
  for (const c of task.criteria) if (!mapped.has(c)) errors.push(`${c}: maps to no scope path and no explicit test`);

  const data = body.get("Data");
  if (data) {
    const first = data.find((l) => l.trim() !== "");
    const m = /^destructive: (yes|no)\s*$/.exec(first || "");
    if (!m) errors.push('section "## Data": first line must be "destructive: yes" or "destructive: no"');
    else if (m[1] === "yes") {
      if (klass !== "CRITICAL") errors.push(`section "## Data": destructive: yes requires class CRITICAL (got ${klass})`);
      let shape = migrationShape(data);
      // `single_step: yes` is only offered when the task states that the user wants one step (A52).
      if (shape === "single_step" && !/single[- ]step|one[- ]step|one migration|tek ad[ıi]m/i.test(taskMd || "")) shape = "missing";
      if (shape === "missing") errors.push('section "## Data": destructive: yes needs expand/contract steps: a step table (`| step | phase | operation | object | destructive | reversible | rollback | lock |`) with a non-destructive step in phase expand, backfill or switch and every destructive step in phase contract or deferred (a separate, later migration); a single step is possible only when the task itself states that the user wants one step (then add the line "single_step: yes" and request the single_step approval); otherwise plan the drop as a deferred step');
    }
  }
  for (const s of ["Dependencies", "Contracts"]) {
    const c = (body.get(s) || []).filter((l) => l.trim() !== "");
    if (c.length === 0) continue;
    const none = c.length === 1 && /^none\b/i.test(c[0].trim());
    if (!none && !c.every((l) => /^\s*-\s+\S/.test(l))) errors.push(`section "## ${s}": write "none" or one "- " item per line`);
  }
  // A162: an entry point declared in `## Contracts` needs a one-line validation summary in `## Validation`.
  const missingValidation = validationMissing(body.get("Contracts"), body.get("Validation"), entryWords || ENTRY_WORDS);
  if (missingValidation.length) errors.push(`section "## Validation": no complete line for the entry point(s) ${missingValidation.join(", ")} declared in ## Contracts; write one line each: "- <entry point>: accepts <what>; limits <limits>; rejected at <where, server side>"`);
  // A64: the project's design documents (config design_docs: data_model, api) that exist in the repository are
  // in scope when the plan changes what they describe: a Data section with content beyond its first line, a
  // Contracts section that is not "none". Left out of scope they drift (COMPLEX X-10).
  try {
    const cfg = existsSync(resolve(root, ".agents/config.yaml")) ? readFileSync(resolve(root, ".agents/config.yaml"), "utf8") : "";
    const doc = (k) => (new RegExp(`^design_docs:[\\s\\S]*?^\\s+${k}:\\s*(\\S+)`, "m").exec(cfg) || [])[1];
    const needs = [];
    const dataLines = (body.get("Data") || []).filter((l) => l.trim() !== "");
    if (dataLines.length > 1 && doc("data_model")) needs.push(["## Data", doc("data_model")]);
    const contracts = (body.get("Contracts") || []).filter((l) => l.trim() !== "");
    if (contracts.length > 0 && !(contracts.length === 1 && /^none\b/i.test(contracts[0].trim())) && doc("api")) needs.push(["## Contracts", doc("api")]);
    for (const [sec, p] of needs) {
      if (existsSync(resolve(root, p)) && !seen.has(p)) errors.push(`scope: ${p} is the project's design document for ${sec}; the plan changes it, so list it in scope (it is updated in the same change)`);
    }
  } catch { /* the config is optional */ }
  const vc = (body.get("Verification commands") || []).join("\n");
  if (body.has("Verification commands") && !/`[^`]+`|^```/m.test(vc)) errors.push('section "## Verification commands": no command in backticks or a code block');
  // A81: the designer's `visual_proof: <AC ids|none>` line names the criteria that need visual evidence; visual-proof
  // and verify-proof read it from the frozen plan. Validated when present, required for COMPLEX/CRITICAL plans with UI.
  const ui = body.get("UI");
  // A112: QA's visual focus runs for every non-TRIVIAL plan with a UI part; without the allowance it ends INCONCLUSIVE
  // at QA time and forces an amendment. The plan says at plan time how the data the page writes is thrown away.
  if (ui && klass !== "TRIVIAL" && !VISUAL_WRITES_LINE.test(planMd)) errors.push(`section "## UI": the line "visual_writes: <how the data the page writes is thrown away>" is required for ${klass} (QA's visual focus runs; without it same-origin writes make it INCONCLUSIVE and force a plan amendment; write "visual_writes: none, the page sends no same-origin writes" if there are none)`);
  if (ui) {
    const vp = ui.map((l) => VISUAL_PROOF_LINE.exec(l)).filter(Boolean);
    if (vp.length > 1) errors.push('section "## UI": more than one visual_proof line');
    else if (vp.length === 0 && ARCHITECTURE_CLASSES.includes(klass)) errors.push(`section "## UI": the line "visual_proof: <AC ids|none>" is required for ${klass} (the designer marks the criteria that need visual evidence)`);
    else if (vp.length === 1 && !/^none$/i.test(vp[0][1])) {
      const ids = vp[0][1].split(",").map((s) => s.trim());
      if (new Set(ids).size !== ids.length) errors.push('section "## UI": visual_proof lists a criterion twice');
      for (const id of ids) {
        if (!/^AC-\d+$/.test(id)) errors.push(`section "## UI": visual_proof "${id}" is not an AC-<n> id (write the ids comma-separated, or none)`);
        else if (!task.criteria.includes(id)) errors.push(`section "## UI": visual_proof names unknown criterion ${id}`);
      }
    }
  }
  return errors;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? "";
  };
  const cls = opt("--class");
  const entryWords = opt("--entry-words");
  const root = opt("--repo") ?? process.cwd();
  if (args.length !== 2 || cls === "" || root === "" || entryWords === "") { console.error("usage: validate-plan.mjs <PLAN.md> <TASK.md> [--class C] [--repo <dir>] [--entry-words <regex>]"); return 2; }
  let plan, task;
  try { plan = readFileSync(args[0], "utf8"); task = readFileSync(args[1], "utf8"); realpathSync(root); } catch (e) { console.error(`error: ${e.message}`); return 2; }
  const errors = validate(plan, task, { root, cls, entryWords });
  for (const e of errors) console.log(e);
  if (errors.length === 0) console.log("valid");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv);
