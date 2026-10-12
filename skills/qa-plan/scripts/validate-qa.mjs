#!/usr/bin/env node
// Validates QA_PLAN.md and QA_REPORT.md. No dependencies.
//   node validate-qa.mjs plan   QA_PLAN.md   [--task TASK.md] [--plan PLAN.md]
//   node validate-qa.mjs report QA_REPORT.md [--plan QA_PLAN.md]
//   node validate-qa.mjs hash   QA_PLAN.md   (prints the sha256 the report must cite)
// Exit codes: 0 valid, 1 invalid, 2 usage or read error. --json prints the parsed result.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["boundaries", "invalid-input", "concurrency", "idempotency", "permissions", "persistence", "ui-states", "error-paths"];
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
const PLACEHOLDER = /(<[A-Za-z][A-Za-z -]*>|\bTBD\b|\bTODO\b|\?\?\?)/;
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function sections(text) {
  const out = new Map();
  let cur = null;
  for (const line of strip(text).split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

export function taskAcs(taskText) {
  return [...strip(taskText).matchAll(/^(?:[-*]\s+)?(AC-\d+):/gm)].map((m) => m[1]);
}

function scenarios(lines, errors, secName) {
  const list = [];
  for (const line of lines) {
    const head = /^- (QA-\d+) \((AC-\d+(?:,\s*AC-\d+)*)\)(?: \[([a-z-]+)\])?: (.+)$/.exec(line);
    if (head) { list.push({ id: head[1], acs: head[2].split(/,\s*/), category: head[3], title: head[4], kv: {} }); continue; }
    const kv = /^\s+(input|expected|run|execution|reason|human-check): (.+)$/.exec(line);
    if (kv && list.length) { list[list.length - 1].kv[kv[1]] = kv[2].trim(); continue; }
    if (/^- /.test(line)) errors.push(`${secName}: malformed scenario line "${line.slice(0, 60)}" (expected "- QA-n (AC-k)[ [category]]: title")`);
  }
  return list;
}

// The PLAN.md the QA plan is derived from (A42): acceptance criteria are those of the scope and `## Behavior`.
export function planAcs(planText) {
  const t = strip(planText);
  const out = new Set();
  for (const m of t.matchAll(/^\s*criteria:\s*\[([^\]]*)\]/gm)) for (const a of m[1].match(/AC-\d+/g) || []) out.add(a);
  const beh = sections(t).get("Behavior") || [];
  for (const l of beh) { const m = /^(?:[-*]\s+)?(AC-\d+):/.exec(l); if (m) out.add(m[1]); }
  return [...out];
}
// Terms the plan's `## Contracts` section removes, renames or drops: a scenario must not expect them back.
const REMOVAL = /\b(remov|renam|drop|delet|no longer|deprecat)/i;
const NEGATION = /\b(absent|removed|no longer|not|never|without|omitted|missing|undefined|gone|must not|rejected|404|ignored)\b/i;
export function removedTerms(planText) {
  const out = new Set();
  for (const l of sections(planText).get("Contracts") || []) if (REMOVAL.test(l)) for (const m of l.matchAll(/`([A-Za-z_][\w.\-]*)`/g)) out.add(m[1]);
  return [...out];
}

export function validatePlan(text, taskText, planText) {
  const errors = [];
  const secs = sections(text);
  const id = /^# QA plan: (\S+)/m.exec(strip(text))?.[1];
  if (!id) errors.push("H1 must be `# QA plan: <TASK-ID>`");
  for (const n of ["Acceptance scenarios", "Adversarial scenarios", "Regression surface"]) {
    if (!secs.has(n)) errors.push(`missing section "## ${n}"`);
    else if (!secs.get(n).some((l) => l.trim())) errors.push(`section "## ${n}" is empty`);
  }
  const acc = scenarios(secs.get("Acceptance scenarios") || [], errors, "Acceptance scenarios");
  const advLines = secs.get("Adversarial scenarios") || [];
  const noneApplicable = advLines.some((l) => /^None applicable:\s*\S+/.test(l));
  const adv = scenarios(advLines, errors, "Adversarial scenarios");
  if (secs.has("Adversarial scenarios") && advLines.some((l) => l.trim()) && !adv.length && !noneApplicable) errors.push('Adversarial scenarios: list scenarios or write "None applicable: <reason>"');
  if (!acc.length && secs.has("Acceptance scenarios")) errors.push("no acceptance scenarios");
  const seen = new Set();
  for (const s of [...acc, ...adv]) {
    if (seen.has(s.id)) errors.push(`duplicate scenario id ${s.id}`);
    seen.add(s.id);
    for (const k of ["input", "expected", "run"]) if (!s.kv[k]) errors.push(`${s.id}: missing "${k}:" line`);
    if (!s.kv.execution) errors.push(`${s.id}: missing "execution: auto|manual" line`);
    else if (!["auto", "manual"].includes(s.kv.execution)) errors.push(`${s.id}: execution must be auto or manual, got "${s.kv.execution}"`);
    else if (s.kv.execution === "manual") for (const k of ["reason", "human-check"]) if (!s.kv[k]) errors.push(`${s.id}: manual scenario needs a "${k}:" line`);
  }
  for (const s of adv) if (!CATEGORIES.includes(s.category)) errors.push(`${s.id}: adversarial scenario needs a category from ${CATEGORIES.join("|")}`);
  for (const s of acc) if (s.category) errors.push(`${s.id}: acceptance scenarios carry no category`);
  if (PLACEHOLDER.test(strip(text).replace(/^# QA plan:.*$/m, ""))) errors.push("unfilled placeholder remains");
  if (taskText) {
    const acs = taskAcs(taskText);
    const covered = new Set(acc.flatMap((s) => s.acs));
    for (const a of acs) if (!covered.has(a)) errors.push(`${a} has no acceptance scenario`);
    for (const s of [...acc, ...adv]) for (const a of s.acs) if (!acs.includes(a)) errors.push(`${s.id} references unknown ${a}`);
  }
  if (planText !== undefined) {
    const cited = /^Plan sha256: ([0-9a-f]{64})\s*$/m.exec(strip(text))?.[1];
    if (!cited) errors.push("missing `Plan sha256: <64 hex>` line (hash of the PLAN.md this QA plan is derived from; `validate-qa.mjs hash PLAN.md`)");
    else if (cited !== sha256(planText)) errors.push("Plan sha256 does not match PLAN.md: the QA plan was derived from a different plan; re-derive it from the current PLAN.md");
    const pacs = planAcs(planText);
    const qacs = new Set([...acc, ...adv].flatMap((s) => s.acs));
    for (const a of pacs) if (!acc.some((s) => s.acs.includes(a))) errors.push(`${a} is in PLAN.md but has no acceptance scenario`);
    for (const a of qacs) if (pacs.length && !pacs.includes(a)) errors.push(`${a} is not a criterion of PLAN.md`);
    const gone = removedTerms(planText);
    for (const s of [...acc, ...adv]) {
      const exp = s.kv.expected || "";
      for (const g of gone) if (exp.includes(g) && !NEGATION.test(exp)) errors.push(`${s.id}: expects \`${g}\`, which PLAN.md ## Contracts removes or renames (state that it is absent, or follow the new contract)`);
    }
  }
  return { valid: errors.length === 0, errors, id, acceptance: acc.map((s) => s.id), adversarial: adv.map((s) => s.id), manual: [...acc, ...adv].filter((s) => s.kv.execution === "manual").map((s) => s.id) };
}

// Gate rule (mechanical): any FAIL -> FAIL; else any BLOCKED -> BLOCKED; else PASS.
// "not-run (manual)" results (execution: manual scenarios) never affect the verdict.
export function computeVerdict(results) {
  if (results.some((r) => r === "FAIL")) return "FAIL";
  if (results.some((r) => r === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function validateReport(text, planText) {
  const errors = [];
  const body = strip(text);
  const secs = sections(text);
  if (!/^# QA report: \S+/m.test(body)) errors.push("H1 must be `# QA report: <TASK-ID>`");
  const verdicts = [...body.matchAll(/^Verdict: (\S+)\s*$/gm)].map((m) => m[1]);
  if (verdicts.length !== 1) errors.push("exactly one `Verdict: PASS|FAIL|BLOCKED` line is required");
  else if (!["PASS", "FAIL", "BLOCKED"].includes(verdicts[0])) errors.push(`invalid verdict "${verdicts[0]}"`);
  const cited = /^Plan sha256: ([0-9a-f]{64})\s*$/m.exec(body)?.[1];
  if (!cited) errors.push("missing `Plan sha256: <64 hex>` line (hash of the frozen QA_PLAN.md)");
  if (!secs.has("Scenarios")) errors.push('missing section "## Scenarios"');
  if (!secs.has("Failures")) errors.push('missing section "## Failures"');
  const res = new Map();
  for (const line of secs.get("Scenarios") || []) {
    const m = /^- (QA-\d+): (PASS|FAIL|BLOCKED|not-run \(manual\))(?:\s+(?:—|--|-)\s*(.*))?$/.exec(line);
    if (!m) { if (/^- /.test(line)) errors.push(`malformed result line "${line.slice(0, 60)}"`); continue; }
    if (res.has(m[1])) errors.push(`duplicate result for ${m[1]}`);
    if (!m[3] || !m[3].trim()) errors.push(`${m[1]}: evidence (observed behaviour and command) is required after the dash`);
    res.set(m[1], m[2]);
  }
  if (res.size === 0) errors.push("no scenario results: \"## Scenarios\" must list at least one `- QA-n: PASS|FAIL|BLOCKED|not-run (manual) — evidence` line");
  const failures = (secs.get("Failures") || []).join("\n");
  for (const [id, r] of res) if ((r === "FAIL" || r === "BLOCKED") && !failures.includes(id)) errors.push(`${id} is ${r} but is not described in "## Failures"`);
  const computed = computeVerdict([...res.values()]);
  if (verdicts.length === 1 && res.size && verdicts[0] !== computed) errors.push(`verdict ${verdicts[0]} contradicts the gate rule (computed ${computed})`);
  if (planText !== undefined) {
    const plan = validatePlan(planText);
    const ids = [...plan.acceptance, ...plan.adversarial];
    if (cited && cited !== sha256(planText)) errors.push("Plan sha256 does not match the QA_PLAN.md on disk (plan changed after freeze or report cites another plan)");
    for (const id of ids) if (!res.has(id)) errors.push(`no result for plan scenario ${id}`);
    for (const id of ids) {
      const manual = plan.manual.includes(id), r = res.get(id);
      if (manual && r && r !== "not-run (manual)") errors.push(`${id} is execution: manual and must be reported as "not-run (manual)", not ${r}`);
      if (!manual && r === "not-run (manual)") errors.push(`${id} is execution: auto; "not-run (manual)" is only for manual scenarios (use BLOCKED if it could not run)`);
    }
    for (const id of res.keys()) if (!ids.includes(id)) errors.push(`result for ${id}, which is not in the plan`);
  }
  if (PLACEHOLDER.test(body.replace(/^# QA report:.*$/m, ""))) errors.push("unfilled placeholder remains");
  return { valid: errors.length === 0, errors, verdict: verdicts[0], computed };
}

function main(argv) {
  const [mode, file] = argv;
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  if (!["plan", "report", "hash"].includes(mode) || !file) { console.error("usage: validate-qa.mjs plan|report|hash FILE [--task F] [--plan F] [--json]"); return 2; }
  if (mode === "hash") { console.log(sha256(read(file))); return 0; }
  const r = mode === "plan" ? validatePlan(read(file), opt("--task") ? read(opt("--task")) : undefined, opt("--plan") ? read(opt("--plan")) : undefined) : validateReport(read(file), opt("--plan") ? read(opt("--plan")) : undefined);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2)); else r.errors.forEach((e) => console.error(`error: ${e}`));
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
