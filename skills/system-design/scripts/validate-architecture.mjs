#!/usr/bin/env node
// Validates a system-design architecture.json (see ../schema/architecture.schema.json).
// Usage: node validate-architecture.mjs <architecture.json> [--root <repo>] [--adr-root <dir>]
// --root: verify component paths exist. --adr-root: base for ADR paths (default: --root).
// Exit: 0 valid, 1 invalid, 2 usage/read error. No dependencies.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const LEVELS = ["context", "container", "component"];

function safeRel(p) {
  return isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
}

export function validate(doc, { root = null, adrRoot = null } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  const allowed = ["schema_version", "mode", "levels", "components", "boundaries", "compatibility", "migration", "tradeoffs", "adrs"];
  for (const k of allowed) if (!(k in doc)) err("$", `missing required "${k}"`);
  for (const k of Object.keys(doc)) if (!allowed.includes(k)) err("$", `unexpected "${k}"`);
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["task", "reverse"].includes(doc.mode)) err("$.mode", "must be task or reverse");

  if (!Array.isArray(doc.levels) || doc.levels.length === 0) err("$.levels", "expected non-empty array");
  else {
    for (const l of doc.levels) if (!LEVELS.includes(l)) err("$.levels", `invalid level ${l}`);
    if (new Set(doc.levels).size !== doc.levels.length) err("$.levels", "duplicate level");
  }

  const ids = new Set();
  const comps = Array.isArray(doc.components) ? doc.components : (err("$.components", "expected array"), []);
  comps.forEach((c, i) => {
    const p = `$.components[${i}]`;
    if (!isObj(c)) return err(p, "expected object");
    if (!/^C\d+$/.test(c.id ?? "")) err(`${p}.id`, "must match ^C\\d+$");
    else if (ids.has(c.id)) err(`${p}.id`, `duplicate id ${c.id}`);
    else ids.add(c.id);
    if (!isStr(c.name)) err(`${p}.name`, "expected non-empty string");
    if (!LEVELS.includes(c.level)) err(`${p}.level`, "invalid level");
    else if (Array.isArray(doc.levels) && !doc.levels.includes(c.level)) err(`${p}.level`, `level ${c.level} not listed in $.levels`);
    if (!["new", "modify", "unchanged"].includes(c.change)) err(`${p}.change`, "must be new, modify or unchanged");
    if (!isStr(c.responsibility)) err(`${p}.responsibility`, "expected non-empty string");
    if (!safeRel(c.path)) err(`${p}.path`, "expected repo-relative path without ..");
    else if (root) {
      const full = resolve(root, c.path);
      if (c.change === "new") {
        if (existsSync(full)) err(`${p}.path`, `${c.path} already exists but change is new`);
        else if (!existsSync(dirname(full))) err(`${p}.path`, `parent directory of ${c.path} does not exist`);
      } else if (!existsSync(full)) err(`${p}.path`, `${c.path} does not exist`);
    }
    if (c.change === "new" && !isStr(c.reuse_rejected)) err(`${p}.reuse_rejected`, "new component needs reuse_rejected (which existing component was considered and why not)");
  });

  (Array.isArray(doc.boundaries) ? doc.boundaries : (err("$.boundaries", "expected array"), [])).forEach((b, i) => {
    const p = `$.boundaries[${i}]`;
    if (!isObj(b)) return err(p, "expected object");
    for (const k of ["from", "to"]) if (!ids.has(b[k])) err(`${p}.${k}`, `unknown component id ${b[k]}`);
    if (!isStr(b.contract)) err(`${p}.contract`, "expected non-empty string");
    if (!["from->to", "to->from", "both"].includes(b.direction)) err(`${p}.direction`, "invalid direction");
  });

  for (const k of ["compatibility", "migration"]) {
    if (!Array.isArray(doc[k]) || doc[k].length === 0 || !doc[k].every(isStr)) err(`$.${k}`, 'expected non-empty array of non-empty strings (write "none: <reason>" when empty)');
  }

  (Array.isArray(doc.tradeoffs) ? doc.tradeoffs : (err("$.tradeoffs", "expected array"), [])).forEach((t, i) => {
    const p = `$.tradeoffs[${i}]`;
    if (!isObj(t)) return err(p, "expected object");
    if (!isStr(t.choice)) err(`${p}.choice`, "expected non-empty string");
    if (!Array.isArray(t.alternatives) || t.alternatives.length === 0 || !t.alternatives.every(isStr)) err(`${p}.alternatives`, "expected non-empty array (a choice without an alternative is not a trade-off)");
    if (!isStr(t.evidence)) err(`${p}.evidence`, "expected non-empty string");
  });

  const adrIds = new Set();
  const adrs = Array.isArray(doc.adrs) ? doc.adrs : (err("$.adrs", "expected array"), []);
  const base = adrRoot ?? root;
  adrs.forEach((a, i) => {
    const p = `$.adrs[${i}]`;
    if (!isObj(a)) return err(p, "expected object");
    if (!/^\d{4}$/.test(a.id ?? "")) err(`${p}.id`, "must be 4 digits");
    else if (adrIds.has(a.id)) err(`${p}.id`, `duplicate ADR ${a.id}`);
    else adrIds.add(a.id);
    if (!isStr(a.title)) err(`${p}.title`, "expected non-empty string");
    if (!["proposed", "accepted", "superseded", "deprecated"].includes(a.status)) err(`${p}.status`, "invalid status");
    if (!Array.isArray(a.alternatives) || a.alternatives.filter(isStr).length < 2) err(`${p}.alternatives`, "an ADR needs at least 2 real alternatives; otherwise record a trade-off line");
    if (!safeRel(a.path)) err(`${p}.path`, "expected relative path without ..");
    else if (base) {
      const full = resolve(base, a.path);
      if (!existsSync(full)) err(`${p}.path`, `${a.path} does not exist`);
      else {
        const text = readFileSync(full, "utf8");
        for (const h of ["Status", "Context", "Decision", "Consequences"]) {
          if (!new RegExp(`^(#+\\s*)?${h}\\b`, "m").test(text)) err(`${p}.path`, `ADR file lacks ${h}`);
        }
      }
    }
  });

  if (doc.mode === "task" && comps.length && comps.every((c) => c?.change === "unchanged")) err("$.components", "mode task needs at least one new or modify component (or state no structural change in migration and add no components)");
  if (doc.mode === "reverse") {
    if (comps.some((c) => c?.change !== "unchanged")) err("$.components", "mode reverse describes existing code: every component must be unchanged");
    if (adrs.length) err("$.adrs", "mode reverse proposes nothing: no ADRs");
  }
  return errors;
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const root = opt("--root"), adrRoot = opt("--adr-root");
  if (args.length !== 1) { console.error("usage: validate-architecture.mjs <architecture.json> [--root <repo>] [--adr-root <dir>]"); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(args[0], "utf8")); } catch (e) { console.error(`cannot read JSON: ${e.message}`); process.exit(2); }
  const errors = validate(doc, { root, adrRoot });
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("valid");
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
