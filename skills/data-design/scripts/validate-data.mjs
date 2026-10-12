#!/usr/bin/env node
// Validates a data-design document and, optionally, the implemented migrations against it.
//   node validate-data.mjs <DATA.md | PLAN.md> [--migrations <file>...] [--context <file>...]
// DATA.md (has "## Plan section"): full document rules. PLAN.md (has "## Data"): the plan-section rules only.
// With --migrations: the REVIEW_DATA gate check (classify-migration.mjs output vs the steps table).
// Prints one "FAIL <code>: <message>" line per problem, or "OK". Exit: 0 valid, 1 invalid, 2 usage/read error.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyFiles, KINDS } from "./classify-migration.mjs";

export const COLUMNS = ["step", "phase", "operation", "object", "destructive", "reversible", "rollback", "lock"];
const PHASES = ["expand", "backfill", "switch", "contract", "deferred"];
export const PROCESS_OPS = ["backup", "backfill", "dual_write", "switch_reads", "deploy", "verify"];
const SQL_OPS = KINDS.filter((k) => k !== "other");
// Operations that always delete or overwrite data, whatever the engine.
const ALWAYS_DESTRUCTIVE = new Set(["drop_table", "drop_schema", "drop_column", "drop_partition", "truncate", "delete", "replace"]);
const DATA_SECTIONS = ["Plan section", "Engine", "Model", "Invariants", "Draft statements", "Backfill", "Rollback", "Data loss", "Proposed DATA_MODEL.md changes"];
const ENGINES = ["postgres", "mysql", "sqlite", "sqlserver", "mongo", "other"];
const EMPTY = /^(|-|none|n\/a|tbd|todo)$/i;

// "## Heading" -> body text (up to the next "## ").
export function sections(md) {
  const out = new Map();
  let cur = null;
  for (const line of md.split("\n")) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; out.set(cur, []); } else if (cur) out.get(cur).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join("\n")]));
}

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

// Rules over the plan section text (the exact PLAN.md "## Data" content). Returns { errors, rows, destructive }.
export function checkPlanSection(text) {
  const errors = [];
  const fail = (code, msg) => errors.push(`${code}: ${msg}`);
  const lines = text.split("\n");
  const first = lines.find((l) => l.trim() !== "");
  const dm = /^destructive: (yes|no)$/.exec((first || "").trim());
  if (!dm) fail("D02", 'first non-empty line must be "destructive: yes" or "destructive: no"');
  const tableLines = lines.filter((l) => l.trim().startsWith("|"));
  if (tableLines.length < 2) { fail("D03", "no migration steps table"); return { errors, rows: [], destructive: dm && dm[1] }; }
  const head = cells(tableLines[0]).map((c) => c.toLowerCase());
  if (head.join("|") !== COLUMNS.join("|")) fail("D03", `table header must be | ${COLUMNS.join(" | ")} |`);
  const rows = tableLines.slice(2).map(cells).map((c) => Object.fromEntries(COLUMNS.map((k, i) => [k, (c[i] || "").replace(/`/g, "")])));
  if (!rows.length) fail("D03", "migration steps table has no rows");
  const ids = new Set();
  let lastPhase = 0;
  for (const r of rows) {
    const at = `step ${r.step || "?"}`;
    if (!/^S\d+$/.test(r.step)) fail("D04", `${at}: step id must match S<number>`);
    if (ids.has(r.step)) fail("D04", `${at}: duplicate step id`);
    ids.add(r.step);
    if (!PHASES.includes(r.phase)) fail("D04", `${at}: phase must be one of ${PHASES.join(", ")}`);
    if (!SQL_OPS.includes(r.operation) && !PROCESS_OPS.includes(r.operation)) fail("D04", `${at}: unknown operation "${r.operation}"`);
    for (const k of ["destructive", "reversible"]) if (!["yes", "no"].includes(r[k])) fail("D04", `${at}: ${k} must be yes or no`);
    if (SQL_OPS.includes(r.operation) && EMPTY.test(r.object)) fail("D04", `${at}: object is required for ${r.operation}`);
    if (EMPTY.test(r.rollback)) fail("D05", `${at}: rollback is required (for an irreversible step: how data is recovered)`);
    if (EMPTY.test(r.lock)) fail("D05", `${at}: lock is required (lock taken and expected duration, or "no lock")`);
    if (ALWAYS_DESTRUCTIVE.has(r.operation) && r.destructive !== "yes") fail("D06", `${at}: ${r.operation} is always destructive`);
    if (r.destructive === "yes" && r.reversible !== "no") fail("D07", `${at}: a destructive step cannot be reversible (lost data does not come back with a down migration)`);
    const p = PHASES.indexOf(r.phase);
    if (p !== -1) {
      if (p < lastPhase) fail("D09", `${at}: phase ${r.phase} after ${PHASES[lastPhase]} (order is ${PHASES.join(" < ")})`);
      lastPhase = Math.max(lastPhase, p);
    }
  }
  // A destructive step in any phase, a deferred one included, makes the plan destructive: the user approves the
  // destructive plan before IMPLEMENT even when the drop itself is a later, separate migration (A55).
  const anyDestructive = rows.some((r) => r.destructive === "yes");
  if (dm && (dm[1] === "yes") !== anyDestructive)
    fail("D08", `header says destructive: ${dm[1]} but ${anyDestructive ? "a step is" : "no step is"} destructive`);
  return { errors, rows, destructive: dm && dm[1] };
}

export function checkDataDoc(md, contextFiles = []) {
  const sec = sections(md);
  const errors = [];
  const fail = (code, msg) => errors.push(`${code}: ${msg}`);
  for (const s of DATA_SECTIONS) if (!sec.has(s)) fail("D01", `missing section "## ${s}"`);
  const plan = checkPlanSection(sec.get("Plan section") || "");
  errors.push(...plan.errors);
  const engine = sec.get("Engine") || "";
  const em = /^engine: (\S+)/m.exec(engine);
  if (!em || !ENGINES.includes(em[1])) fail("D11", `Engine needs "engine: <${ENGINES.join("|")}>"`);
  if (!/^evidence: \S+/m.test(engine)) fail("D11", 'Engine needs "evidence: <path:line or path:symbol>"');
  if (!/^migrations: \S+/m.test(engine)) fail("D11", 'Engine needs "migrations: <directory or glob the project applies>"');
  if (sec.has("Model") && !/```mermaid\s*\n\s*erDiagram\b/.test(sec.get("Model"))) fail("D12", "Model needs a ```mermaid erDiagram block");
  const inv = (sec.get("Invariants") || "").split("\n").filter((l) => /^- INV-\d+:/.test(l));
  if (sec.has("Invariants") && !inv.length) fail("D13", 'Invariants needs at least one "- INV-<n>: ... (enforced by: ...)" line');
  for (const l of inv) if (!/\(enforced by: [^)]+\)\s*$/.test(l)) fail("D13", `invariant without "(enforced by: ...)": ${l.slice(0, 60)}`);
  if (plan.rows.some((r) => r.phase === "backfill" || r.operation === "backfill")) {
    const b = sec.get("Backfill") || "";
    for (const k of ["batch_size", "idempotency", "resume"]) if (!new RegExp(`^${k}: \\S`, "m").test(b)) fail("D14", `Backfill needs "${k}: ..." when the plan has a backfill step`);
  }
  const loss = sec.get("Data loss") || "";
  for (const r of plan.rows.filter((r) => r.destructive === "yes"))
    if (!new RegExp(`\\b${r.step}\\b`).test(loss)) fail("D10", `destructive step ${r.step} is not described in "## Data loss"`);
  // The planned statements are classified like an implemented diff: the table must match them.
  const drafts = draftBlocks(sec.get("Draft statements") || "");
  if (sec.has("Draft statements") && !drafts.length && plan.rows.some((r) => SQL_OPS.includes(r.operation)))
    fail("D15", "Draft statements needs one fenced block (```sql, or the ORM language) with the planned statements");
  if (drafts.length) {
    const files = drafts.map((d, i) => `draft-${i + 1}.${d.lang === "sql" ? "sql" : "txt"}`);
    const read = (f) => (files.includes(f) ? drafts[files.indexOf(f)].body : readFileSync(f, "utf8"));
    const cls = classifyFiles(files, contextFiles, read);
    for (const e of checkDiff(plan.rows, plan.destructive, cls)) errors.push(`draft ${e}`);
  }
  return { errors, rows: plan.rows, destructive: plan.destructive };
}

export function draftBlocks(text) {
  const out = [];
  const re = /^```(\w*)[^\n]*\n([\s\S]*?)^```\s*$/gm;
  let m;
  while ((m = re.exec(text))) out.push({ lang: (m[1] || "sql").toLowerCase(), body: m[2] });
  return out;
}

export function checkPlanDoc(md) {
  const sec = sections(md);
  if (!sec.has("Data")) return { errors: ['D01: missing section "## Data"'], rows: [], destructive: null };
  return checkPlanSection(sec.get("Data"));
}

// Plan object vs statement object: equal, unnamed ("" / "?"), column-only token match, or table vs table.x.
const objMatch = (p, a) => a === "" || a === "?" || a === p || p.endsWith("." + a) || a.startsWith(p + ".") || p.startsWith(a + ".");

// REVIEW_DATA gate rule: the diff's statements against the frozen steps table.
export function checkDiff(rows, planDestructive, classification) {
  const errors = [];
  const fail = (code, msg) => errors.push(`${code}: ${msg}`);
  const sqlRows = rows.filter((r) => SQL_OPS.includes(r.operation)).map((r) => ({ ...r, object: r.object.toLowerCase(), hits: 0 }));
  for (const a of classification.actions) {
    if (a.kind === "other") continue;
    const at = `${a.file}:${a.line} ${a.kind} ${a.object || ""}`.trim();
    const matches = sqlRows.filter((r) => r.operation === a.kind && objMatch(r.object, a.object));
    for (const r of matches) r.hits++;
    const live = matches.filter((r) => r.phase !== "deferred");
    if (!live.length) { fail("M1", `${at}: statement not declared in the plan (${a.class}: ${a.reason})`); continue; }
    if ((a.class === "destructive" || a.class === "unknown") && !live.some((r) => r.destructive === "yes"))
      fail("M2", `${at}: ${a.class} statement declared as non-destructive (${a.reason})`);
  }
  for (const r of sqlRows) {
    if (r.phase === "deferred" && r.hits) fail("M4", `step ${r.step}: deferred ${r.operation} ${r.object} is already in the diff`);
    if (r.phase !== "deferred" && !r.hits) fail("M3", `step ${r.step}: planned ${r.operation} ${r.object} is missing from the diff`);
  }
  if (classification.destructive === "yes" && planDestructive !== "yes") fail("M5", "the diff is destructive but the plan says destructive: no");
  return errors;
}

function main(argv) {
  let doc = null;
  const lists = { "--migrations": [], "--context": [] };
  let cur = null;
  for (const a of argv) {
    if (a in lists) cur = lists[a];
    else if (a.startsWith("--")) { process.stderr.write(`unknown option ${a}\n`); return 2; }
    else if (cur) cur.push(a);
    else if (!doc) doc = a;
    else { process.stderr.write(`unexpected argument ${a}\n`); return 2; }
  }
  if (!doc) { process.stderr.write("usage: validate-data.mjs <DATA.md|PLAN.md> [--migrations <file>...] [--context <file>...]\n"); return 2; }
  let md;
  try { md = readFileSync(doc, "utf8"); } catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  let res;
  try { res = /^## Plan section\s*$/m.test(md) ? checkDataDoc(md, lists["--context"]) : checkPlanDoc(md); }
  catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  const errors = [...res.errors];
  if (lists["--migrations"].length) {
    try { errors.push(...checkDiff(res.rows, res.destructive, classifyFiles(lists["--migrations"], lists["--context"]))); }
    catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  }
  process.stdout.write(errors.length ? errors.map((e) => `FAIL ${e}`).join("\n") + "\n" : "OK\n");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main(process.argv.slice(2)));
