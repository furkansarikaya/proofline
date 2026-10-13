#!/usr/bin/env node
// Validates a migration-validation report (references/MIGRATION-VALIDATION.md): shape, evidence classes, and that
// the status follows from the checks (UNSUPPORTED is never PASS).
//   node validate-migration.mjs <REPORT.md> [--repo DIR]
//   --repo re-classifies every cited migration file with the scanner (A94): a destructive or unknown action in a
//   migration marked `destructive: no`, an unanalyzable file marked applied, a missing file, or a blocking hazard
//   under a `patterns: pass` is refused. Without it only the report's own consistency is checked.
// Prints one "FAIL <code>: <message>" line per problem, or "OK". Exit: 0 valid, 1 invalid, 2 usage/read error.

import { readFileSync, realpathSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";
import { classifyFiles } from "./classify-migration.mjs";
import { scanMigrations } from "./migration-check.mjs";

export const CHECKS = ["schema_diff", "rollback", "data_preservation", "lock_risk", "long_running", "patterns", "mixed_version"];
const MEASURED_ONLY = ["schema_diff", "rollback", "data_preservation"]; // need the throwaway database
const CLASSES = ["measured", "reproduced", "traced", "judged"];
const RESULTS = ["pass", "fail", "warn", "na", "unsupported"];
const STATUSES = ["PASS", "FAIL", "UNSUPPORTED", "BLOCKED"];
// Connection strings and DSN fragments: URL schemes of any database or broker, and key=value DSN parts.
const CONN = /\b(?:jdbc:[a-z0-9]+:|[a-z][a-z0-9+.-]*:\/\/)\S|\b(?:sqlite3?|mssql|oracle|amqps?|postgres(?:ql)?|mysql|mariadb|mongodb|redis):\S|\b(?:password|passwd|pwd|host|server|user id|uid)\s*=\s*\S|\b(?:user|username|dbname|database|hostaddr|port)=\S/i;
const HARNESS = /^`?[\w@.\/-]+\.[A-Za-z0-9]+(?::\d+)?`?(?:\s|$)/; // path or path:line, first token
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

export function checkReport(md, { repo = null } = {}) {
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
  const harness = kv(cap, "harness");
  if (db === "yes" && !(harness && HARNESS.test(harness))) fail("V03", "throwaway_db: yes needs harness: <path or path:line of the test helper that creates the database> first (a command may follow); the validator cannot prove the trial run");
  if (db === "no" && !kv(cap, "reason")) fail("V03", "throwaway_db: no needs reason: <what the project lacks>");
  const down = kv(cap, "down_migration");
  if (!["yes", "no"].includes(down)) fail("V03", "Capability needs down_migration: yes|no");

  const downDestructive = kv(cap, "down_destructive") === "yes";
  if (downDestructive && down === "no") fail("V03", "down_destructive: yes contradicts down_migration: no");
  const downRun = kv(cap, "down_run_by");
  if (kv(cap, "down_destructive") !== null && !["yes", "no"].includes(kv(cap, "down_destructive"))) fail("V03", "down_destructive must be yes or no");
  if (downRun && !HARNESS.test(downRun)) fail("V03", "down_run_by must be the path[:line] of the project's own test that runs the down migration");

  const mig = table(sec.get("Migrations"));
  if (!mig.rows.length) fail("V04", "Migrations table has no rows");
  for (const r of mig.rows) {
    if (!["yes", "no"].includes(r.applied) || !["yes", "no"].includes(r.destructive)) { fail("V04", `${r.file}: applied and destructive must be yes or no`); continue; }
    if (r.destructive === "yes" && r.applied === "yes") fail("V10", `${r.file}: a destructive statement is never executed in any database (A52); applied must be no ("not executed (destructive statement)")`);
    if (db === "no" && r.applied === "yes") fail("V05", `${r.file}: applied: yes without a throwaway database`);
  }

  let blockingHazards = [];
  if (repo) {
    const root = resolve(repo);
    const cited = [];
    for (const r of mig.rows) {
      const abs = resolve(root, r.file || "");
      if (!r.file || !abs.startsWith(root + sep) || !existsSync(abs)) { fail("V17", `${r.file}: the cited migration was not found under --repo`); continue; }
      cited.push([r, abs]);
    }
    if (cited.length) {
      let cls = null;
      try { cls = classifyFiles(cited.map(([, a]) => a)); } catch (e) { fail("V17", `cannot scan the cited migrations: ${e.message}`); }
      if (cls) for (const [r, abs] of cited) {
        const bad = cls.actions.filter((a) => a.file === abs && (a.class === "destructive" || a.class === "unknown"));
        const un = (cls.unanalyzed || []).find((u) => u.file === abs);
        if (bad.length && r.destructive !== "yes") fail("V16", `${r.file}: the scanner classifies line ${bad[0].line} as ${bad[0].class} (${bad[0].kind} ${bad[0].object}); destructive must be yes`);
        if (un && r.applied === "yes") fail("V17", `${r.file}: the scanner cannot analyze this file (${un.reason}); it is never applied, so applied must be no`);
      }
      try { blockingHazards = scanMigrations(cited.map(([, a]) => a)).hazards.filter((h) => h.severity === "blocking"); } catch { /* unreadable: reported above */ }
    }
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
    if (r.result === "fail" && r.class === "judged" && !/criterion:\s*[A-Za-z0-9][^|]*?[A-Za-z]{3,}/i.test(ev))
      fail("V08", `${id}: a judged finding fails the gate only when it cites the written spec/plan criterion it violates ("criterion: ..."); otherwise result warn`);
    if (MEASURED_ONLY.includes(id) && ["pass", "fail"].includes(r.result)) {
      if (db !== "yes") fail("V05", `${id}: ${r.result} needs a throwaway database; without one the result is unsupported`);
      if (!["measured", "reproduced"].includes(r.class)) fail("V09", `${id}: a ${r.result} result is measured (snapshot dumps, row counts); class ${r.class} is not allowed`);
    }
    if ((id === "lock_risk" || id === "long_running") && r.class === "measured" && !/\d+(\.\d+)?\s*(ms|s|sec|seconds|min)\b/i.test(ev))
      fail("V09", `${id}: class measured needs a measured duration in evidence; an estimate is judged`);
    if (id === "rollback" && r.result === "na" && down !== "no") fail("V11", "rollback: na only when down_migration: no (a rollback is then a new forward migration, say so)");
    if (id === "rollback" && r.result === "pass" && down !== "yes") fail("V11", "rollback: pass needs down_migration: yes");
    if (id === "rollback" && down === "yes" && downDestructive && !downRun && r.result !== "unsupported")
      fail("V15", 'rollback: the down migration has destructive statements, which the agent never executes; result must be unsupported with "not executed (destructive statement)" unless the project\'s own test runs it (down_run_by: path[:line])');
    if (id === "rollback" && r.result === "unsupported" && downDestructive && !downRun && !/not executed \(destructive statement\)/i.test(ev))
      fail("V15", 'rollback: evidence must say "not executed (destructive statement)"');
    if (id === "patterns" && r.result === "pass" && blockingHazards.length) fail("V16", `patterns: pass, but the scanner traced a blocking hazard (${blockingHazards[0].code} ${blockingHazards[0].message})`);
    if (r.result === "unsupported" && !ev) fail("V12", `${id}: unsupported needs the missing capability or the "not executed" reason as evidence`);
    if (!ev || /^(-|none|n\/a|tbd|todo)$/i.test(ev)) fail("V12", `${id}: evidence is required, for na and unsupported the reason`);
  }
  if (db === "no") for (const id of MEASURED_ONLY) {
    const r = byId.get(id);
    if (r.result === "na" && !(id === "rollback" && down === "no")) fail("V05", `${id}: without a throwaway database the result is unsupported, not na`);
  }
  if (errors.length) return errors;

  const results = [...byId.values()].map((r) => r.result);
  const derived = results.includes("fail") ? "FAIL"
    : db === "no" || results.includes("unsupported") || (down === "yes" && byId.get("rollback").result !== "pass") || mig.rows.some((r) => r.applied === "no") ||
      byId.get("schema_diff").result !== "pass" || byId.get("data_preservation").result !== "pass" ? "UNSUPPORTED" : "PASS";
  if (status === "BLOCKED") { if (!kv(md.split(/^## /m)[0], "blocked_reason")) fail("V01", "status BLOCKED needs a blocked_reason: line"); }
  else if (status !== derived) fail("V14", `status ${status} does not follow from the checks and migrations: expected ${derived} (any fail -> FAIL; no throwaway database, an unsupported or na schema_diff/data_preservation, an unsupported check or a migration not applied -> UNSUPPORTED; never PASS)`);
  return errors;
}

function main(argv) {
  const args = [...argv];
  let repo = null;
  const ri = args.indexOf("--repo");
  if (ri !== -1) { repo = args[ri + 1]; args.splice(ri, 2); }
  if (args.length !== 1 || repo === undefined || repo === "") { process.stderr.write("usage: validate-migration.mjs <REPORT.md> [--repo DIR]\n"); return 2; }
  let md;
  try { md = readFileSync(args[0], "utf8"); } catch (e) { process.stderr.write(`error: ${e.message}\n`); return 2; }
  const errors = checkReport(md, { repo });
  for (const e of errors) process.stdout.write(`FAIL ${e}\n`);
  if (!errors.length) process.stdout.write("OK\n");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main(process.argv.slice(2)));
