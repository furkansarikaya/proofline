#!/usr/bin/env node
// Validates a migration-validation report (references/MIGRATION-VALIDATION.md): shape, evidence classes, and that
// the status follows from the checks (UNSUPPORTED is never PASS).
//   node validate-migration.mjs <REPORT.md>
// Prints one "FAIL <code>: <message>" line per problem, or "OK". Exit: 0 valid, 1 invalid, 2 usage/read error.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHECKS = ["schema_diff", "rollback", "data_preservation", "lock_risk", "long_running", "patterns", "mixed_version"];
const MEASURED_ONLY = ["schema_diff", "rollback", "data_preservation"]; // need the throwaway database
const CLASSES = ["measured", "reproduced", "traced", "judged"];
const RESULTS = ["pass", "fail", "warn", "na", "unsupported"];
const STATUSES = ["PASS", "FAIL", "UNSUPPORTED", "BLOCKED"];
const CONN = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|sqlserver|jdbc:[a-z]+):\/\/\S+/i;
const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function sections(md) {
  const out = new Map(); let cur = null;
  for (const l of md.split("\n")) { const m = /^## (.+?)\s*$/.exec(l); if (m) { cur = m[1]; out.set(cur, []); } else if (cur) out.get(cur).push(l); }
  return new Map([...out].map(([k, v]) => [k, v.join("\n")]));
}
const table = (text) => {
  const ls = text.split("\n").filter((l) => l.trim().startsWith("|"));
  if (ls.length < 2) return { head: [], rows: [] };
  const head = cells(ls[0]).map((c) => c.toLowerCase());
  return { head, rows: ls.slice(2).map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i], c.replace(/`/g, "")]))) };
};
const kv = (text, k) => { const m = new RegExp(`^${k}:[ \\t]*(.*)$`, "im").exec(text); return m ? m[1].trim() : null; };

export function checkReport(md) {
  const errors = [];
  const fail = (c, m) => errors.push(`${c}: ${m}`);
  const sec = sections(md);
  const status = kv(md.split(/^## /m)[0], "status");
  if (!STATUSES.includes(status)) fail("V01", `"status:" line before the first section must be one of ${STATUSES.join(", ")}`);
  for (const s of ["Capability", "Migrations", "Checks"]) if (!sec.has(s)) fail("V02", `missing section "## ${s}"`);
  if (errors.length) return errors;
  if (CONN.test(md)) fail("V13", "the report contains a database connection string; none may be read from env or config, or recorded");

  const cap = sec.get("Capability");
  const db = kv(cap, "throwaway_db");
  if (!["yes", "no"].includes(db)) fail("V03", "Capability needs throwaway_db: yes|no");
  if (db === "yes" && !kv(cap, "harness")) fail("V03", "throwaway_db: yes needs harness: <path:line or command of the test infrastructure that creates it>");
  if (db === "no" && !kv(cap, "reason")) fail("V03", "throwaway_db: no needs reason: <what the project lacks>");
  const down = kv(cap, "down_migration");
  if (!["yes", "no"].includes(down)) fail("V03", "Capability needs down_migration: yes|no");

  const mig = table(sec.get("Migrations"));
  if (!mig.rows.length) fail("V04", "Migrations table has no rows");
  for (const r of mig.rows) {
    if (!["yes", "no"].includes(r.applied) || !["yes", "no"].includes(r.destructive)) { fail("V04", `${r.file}: applied and destructive must be yes or no`); continue; }
    if (r.destructive === "yes" && r.applied === "yes") fail("V10", `${r.file}: a destructive statement is never executed in any database (A52); applied must be no ("not executed (destructive statement)")`);
    if (db === "no" && r.applied === "yes") fail("V05", `${r.file}: applied: yes without a throwaway database`);
  }

  const chk = table(sec.get("Checks"));
  const byId = new Map();
  for (const r of chk.rows) {
    if (!CHECKS.includes(r.id)) { fail("V06", `unknown check id "${r.id}"`); continue; }
    if (byId.has(r.id)) fail("V06", `duplicate check "${r.id}"`);
    byId.set(r.id, r);
    if (!CLASSES.includes(r.class)) fail("V07", `${r.id}: class must be one of ${CLASSES.join(", ")}`);
    if (!RESULTS.includes(r.result)) fail("V07", `${r.id}: result must be one of ${RESULTS.join(", ")}`);
  }
  for (const id of CHECKS) if (!byId.has(id)) fail("V06", `missing check "${id}"`);
  if (errors.length) return errors;

  for (const [id, r] of byId) {
    const ev = r.evidence || "";
    if (r.result === "fail" && r.class === "judged" && !/criterion:/i.test(ev))
      fail("V08", `${id}: a judged finding fails the gate only when it cites the written spec/plan criterion it violates ("criterion: ..."); otherwise result warn`);
    if (MEASURED_ONLY.includes(id) && ["pass", "fail"].includes(r.result)) {
      if (db !== "yes") fail("V05", `${id}: ${r.result} needs a throwaway database; without one the result is unsupported`);
      if (!["measured", "reproduced"].includes(r.class)) fail("V09", `${id}: a ${r.result} result is measured (snapshot dumps, row counts); class ${r.class} is not allowed`);
    }
    if ((id === "lock_risk" || id === "long_running") && r.class === "measured" && !/\d+(\.\d+)?\s*(ms|s|sec|seconds|min)\b/i.test(ev))
      fail("V09", `${id}: class measured needs a measured duration in evidence; an estimate is judged`);
    if (id === "rollback" && r.result === "na" && down !== "no") fail("V11", "rollback: na only when down_migration: no (a rollback is then a new forward migration, say so)");
    if (id === "rollback" && r.result === "pass" && down !== "yes") fail("V11", "rollback: pass needs down_migration: yes");
    if (r.result === "unsupported" && !ev) fail("V12", `${id}: unsupported needs the missing capability or the "not executed" reason as evidence`);
    if (!ev && r.result !== "na") fail("V12", `${id}: evidence is required`);
  }
  if (db === "no") for (const id of MEASURED_ONLY) {
    const r = byId.get(id);
    if (r.result === "na" && !(id === "rollback" && down === "no")) fail("V05", `${id}: without a throwaway database the result is unsupported, not na`);
  }
  if (errors.length) return errors;

  const results = [...byId.values()].map((r) => r.result);
  const derived = results.includes("fail") ? "FAIL"
    : db === "no" || results.includes("unsupported") || mig.rows.some((r) => r.applied === "no") ? "UNSUPPORTED" : "PASS";
  if (status === "BLOCKED") { if (!kv(md.split(/^## /m)[0], "blocked_reason")) fail("V01", "status BLOCKED needs a blocked_reason: line"); }
  else if (status !== derived) fail("V14", `status ${status} does not follow from the checks and migrations: expected ${derived} (any fail -> FAIL; no throwaway database, an unsupported check or a migration not applied -> UNSUPPORTED; never PASS)`);
  return errors;
}

function main(argv) {
  if (argv.length !== 1) { process.stderr.write("usage: validate-migration.mjs <REPORT.md>\n"); return 2; }
  let md;
  try { md = readFileSync(argv[0], "utf8"); } catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  const errors = checkReport(md);
  for (const e of errors) process.stdout.write(`FAIL ${e}\n`);
  if (!errors.length) process.stdout.write("OK\n");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main(process.argv.slice(2)));
