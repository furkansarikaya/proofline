#!/usr/bin/env node
// Static helpers for the REVIEW_DATA `migration` focus (references/MIGRATION-VALIDATION.md). Dependency-free,
// text only: it never connects to a database, never reads a connection string, never runs a migration.
//   migration-check.mjs scan [--engine postgres|mysql|sqlite|other] [--context <file>...] [--populated t1,t2]
//                        [--readers <file|dir>...] -- <migration file>...
//   migration-check.mjs diff <before> <after> [--rollback <after-rollback>]
//   migration-check.mjs data <before.json> <after.json> [--key table=column]...
// Output is one JSON document; exit 0 (also when hazards are found; the report validator judges), 2 usage/read error.
// Evidence classes: scan hazards are "traced" (a concrete statement/path proves it) or "judged"; diff and data are
// "measured" provided the dumps come from the test suite's own throwaway database.

import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { splitStatements, classifyStatement, learnTypes, isWidening, baseName } from "./classify-migration.mjs";

// ---------- scan: DDL hazards ----------

const lenOf = (t) => { const m = /\(\s*(\d+)/.exec(t || ""); return m ? Number(m[1]) : null; };
const INT = { smallint: 1, int2: 1, integer: 2, int: 2, int4: 2, mediumint: 2, bigint: 3, int8: 3 };
// True only when both types are known and the new one provably holds fewer values.
export function isNarrowing(oldT, newT) {
  if (!oldT || !newT || isWidening(oldT, newT)) return false;
  const o = oldT.toLowerCase().replace(/\s+/g, " ").trim();
  const n = newT.toLowerCase().replace(/\s+/g, " ").trim();
  const base = (t) => t.replace(/\(.*$/, "").replace("character varying", "varchar").trim();
  if (base(o) === base(n) && lenOf(o) !== null && lenOf(n) !== null) return lenOf(n) < lenOf(o);
  if (o in INT && n in INT) return INT[n] < INT[o];
  if (/^(text|varchar|char)/.test(o) && /^(varchar|char)\(/.test(n) && !/^text/.test(n)) return base(o) === "text" || lenOf(n) < (lenOf(o) ?? Infinity);
  return false;
}

function listFiles(paths) {
  const out = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) if (!["node_modules", ".git"].includes(e)) walk(join(p, e));
    } else if (st.size < 1_000_000) out.push(p);
  };
  for (const p of paths) walk(p);
  return out;
}

// Word-boundary occurrences of an identifier in non-comment lines of the reader files (path:line, trimmed text).
export function findReaders(name, files, read = (f) => readFileSync(f, "utf8"), limit = 10) {
  const re = new RegExp(String.raw`(?<![\w$])${name.replace(/[$]/g, "\\$")}(?![\w$])`);
  const hits = [];
  for (const f of files) {
    let src;
    try { src = read(f); } catch { continue; }
    if (src.includes("\0")) continue;
    src.split("\n").forEach((l, i) => {
      if (/^\s*(\/\/|#|--|\*)/.test(l)) return;
      if (re.test(l) && hits.length < limit) hits.push({ path: f, line: i + 1, text: l.trim().slice(0, 160) });
    });
  }
  return hits;
}

export function scanMigrations(files, opts = {}) {
  const { engine = "other", context = [], populated = [], readerFiles = [], read = (f) => readFileSync(f, "utf8") } = opts;
  const pop = new Set(populated.map((t) => t.toLowerCase()));
  const types = new Map();
  for (const f of context) if (/\.sql$/i.test(f)) learnTypes(splitStatements(read(f)), types);
  const ctx = { created: new Set(), types };
  const hazards = [];
  const statements = [];
  for (const file of files) {
    if (!/\.sql$/i.test(file)) { statements.push({ file, line: 0, sql: false }); continue; }
    for (const st of splitStatements(read(file))) {
      const actions = classifyStatement(st.masked, ctx);
      const createdBefore = new Set(ctx.created);
      learnTypes([st], types);
      for (const a of actions) {
        const at = { file, line: st.line, statement: st.text.slice(0, 200), kind: a.kind, object: a.object };
        statements.push({ ...at, class: a.class, executable: a.class === "safe" || a.class === "breaking" });
        const table = a.object.split(".")[0];
        const col = a.object.split(".")[1];
        const fresh = createdBefore.has(table);
        const push = (code, hazard, cls, message, extra = {}) =>
          hazards.push({ code, hazard, evidence_class: cls, severity: cls === "traced" || cls === "measured" ? "blocking" : "warn", ...at, message, ...extra });

        if (a.kind === "add_column" && /NOT NULL without a default/.test(a.reason))
          push("H01", "not_null_without_default", pop.has(table) ? "traced" : "judged",
            `ADD COLUMN ${a.object} NOT NULL without DEFAULT on an existing table: ${pop.has(table) ? `the table is declared populated, so the statement fails or rejects every old-app insert` : "fails when the table holds rows and rejects inserts from the old app"}`,
            { populated: pop.has(table) ? "declared" : "unknown" });
        else if (a.kind === "set_not_null" && a.class === "destructive")
          push("H01", "not_null_without_default", pop.has(table) ? "traced" : "judged",
            `SET NOT NULL on ${a.object} scans the table under lock and fails when any row holds NULL`, { populated: pop.has(table) ? "declared" : "unknown" });

        if (a.kind === "alter_column_type") {
          const m = /^(.+?) -> (.+?) is not a provable widening$/.exec(a.reason);
          if (m && isNarrowing(m[1], m[2]))
            push("H02", "type_narrowing", "traced", `${a.object} narrows ${m[1]} -> ${m[2]}: existing values that do not fit are rejected or truncated`, { from: m[1], to: m[2] });
          else if (a.class !== "safe")
            push("H02", "type_change_unproven", "judged", `${a.object}: ${a.reason}`);
          push("H03", "table_rewrite", "judged", `ALTER COLUMN TYPE on ${a.object} typically rewrites the whole table under an exclusive lock`, { lock: "exclusive" });
        }

        if (a.kind === "create_index" && !fresh) {
          const concurrent = /\bCONCURRENTLY\b/i.test(st.masked) || /\bALGORITHM\s*=?\s*INPLACE\b/i.test(st.masked) || /\bONLINE\b/i.test(st.masked);
          if (!concurrent)
            push("H04", "index_not_concurrent", "judged",
              engine === "postgres" ? `CREATE INDEX on ${table} without CONCURRENTLY blocks writes for the build duration`
                : `index creation on existing table ${table} without an online/concurrent option may block writes (engine: ${engine})`, { lock: "write-blocking" });
        }

        if (a.kind === "drop_column" || a.kind === "rename_column" || a.kind === "drop_table" || a.kind === "rename_table") {
          const name = a.kind.endsWith("column") ? col : table;
          const hits = name && readerFiles.length ? findReaders(name, readerFiles, read) : [];
          push("H05", a.kind, hits.length ? "traced" : "judged",
            hits.length ? `${a.kind.replace("_", " ")} ${a.object}: the running app still references "${name}" (${hits[0].path}:${hits[0].line})`
              : `${a.kind.replace("_", " ")} ${a.object}: no reader found in the given paths; consumers outside the repository are unknown`,
            { readers: hits });
        }

        if (a.kind === "update" && a.class === "destructive" || a.kind === "update" && !/\bWHERE\b/i.test(st.masked))
          push("H06", "full_table_update", "judged", `UPDATE on ${table} ${/\bWHERE\b/i.test(st.masked) ? "overwrites existing values" : "has no WHERE: touches every row in one statement"} (long transaction, row locks, replication lag)`);
        else if (a.kind === "update" && !/\b(LIMIT|BETWEEN|id\s*[<>]=?|ctid)\b/i.test(st.masked))
          push("H06", "unbatched_backfill", "judged", `backfill UPDATE on ${table} is one statement; on a large table it holds row locks for its whole run`);

        if (a.kind === "add_constraint" && !fresh && engine === "postgres" &&
            /\b(FOREIGN\s+KEY|CHECK|REFERENCES)\b/i.test(st.masked) && !/\bNOT\s+VALID\b/i.test(st.masked))
          push("H07", "constraint_validation", "judged", `adding a constraint to ${table} without NOT VALID validates every row under lock`, { lock: "share-row-exclusive" });
      }
    }
  }
  const dedupe = new Set();
  const uniq = hazards.filter((h) => { const k = `${h.code}|${h.file}|${h.line}|${h.object}`; if (dedupe.has(k)) return false; dedupe.add(k); return true; });
  return {
    schema_version: 1, engine, files, statements, hazards: uniq,
    not_executable: statements.filter((s) => s.executable === false).map(({ file, line, statement }) => ({ file, line, statement, reason: "destructive or unknown statement: never executed in any database (A52)" })),
    limits: ["static text only; row counts, lock durations and real run time are not measured",
      "reader search is a word-boundary text match in the given paths; dynamic names and other repositories are unknown"],
  };
}

// ---------- diff: schema snapshots ----------

const ID = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$#@]*)`;
function splitTop(s) {
  const parts = []; let d = 0; let cur = "";
  for (const ch of s) {
    if (ch === "(") d++; if (ch === ")") d--;
    if (ch === "," && d === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Parses a DDL dump (CREATE TABLE / CREATE INDEX / everything else kept verbatim) or a JSON snapshot
// { tables: { t: { columns: { c: { type, not_null, default } }, constraints: [] } }, indexes: { name: "on t (c)" }, other: [] }.
export function parseSchema(text) {
  const t = text.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    return { tables: j.tables || {}, indexes: j.indexes || {}, other: j.other || [] };
  }
  const out = { tables: {}, indexes: {}, other: [] };
  for (const st of splitStatements(text)) {
    const s = st.masked;
    let m = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:${ID}\s*\.\s*)?${ID})\s*\((.*)\)(.*)$`, "i").exec(s);
    if (m) {
      const cols = {}; const constraints = [];
      for (const part of splitTop(m[2])) {
        const cm = new RegExp(String.raw`^(${ID})\s+(.*)$`).exec(part);
        if (!cm || /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|KEY|INDEX)$/i.test(cm[1])) { constraints.push(norm(part)); continue; }
        const rest = cm[2];
        const type = norm(rest.split(/\s+(?=NOT\b|NULL\b|DEFAULT\b|PRIMARY\b|REFERENCES\b|UNIQUE\b|CHECK\b|COLLATE\b|GENERATED\b|CONSTRAINT\b|AUTOINCREMENT\b)/i)[0]);
        const dm = /\bDEFAULT\s+(.+?)(?=\s+(?:NOT|NULL|PRIMARY|REFERENCES|UNIQUE|CHECK|COLLATE|CONSTRAINT)\b|$)/i.exec(rest);
        cols[baseName(cm[1])] = { type, not_null: /\bNOT\s+NULL\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest), default: dm ? norm(dm[1]) : null };
      }
      out.tables[baseName(m[1])] = { columns: cols, constraints: constraints.sort() };
      continue;
    }
    m = new RegExp(String.raw`^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${ID})\s+ON\s+(.+)$`, "i").exec(s);
    if (m) { out.indexes[baseName(m[2])] = norm(`${m[1] || ""}on ${m[3]}`); continue; }
    if (/^(BEGIN|COMMIT|SET|SELECT|PRAGMA|--)/i.test(s) || !s) continue;
    out.other.push(norm(s));
  }
  out.other.sort();
  return out;
}

export function diffSchemas(a, b) {
  const r = { tables_added: [], tables_removed: [], columns_added: [], columns_removed: [], columns_changed: [],
    indexes_added: [], unique_indexes_added: [], indexes_removed: [], indexes_changed: [], constraints_added: [], constraints_removed: [], other_added: [], other_removed: [] };
  for (const t of Object.keys(b.tables)) if (!a.tables[t]) r.tables_added.push(t);
  for (const t of Object.keys(a.tables)) if (!b.tables[t]) r.tables_removed.push(t);
  for (const t of Object.keys(a.tables)) {
    const x = a.tables[t]; const y = b.tables[t];
    if (!y) continue;
    for (const c of Object.keys(y.columns)) {
      if (!x.columns[c]) r.columns_added.push({ table: t, column: c, ...y.columns[c] });
      else for (const k of ["type", "not_null", "default"])
        if (x.columns[c][k] !== y.columns[c][k]) r.columns_changed.push({ table: t, column: c, field: k, before: x.columns[c][k], after: y.columns[c][k] });
    }
    for (const c of Object.keys(x.columns)) if (!y.columns[c]) r.columns_removed.push({ table: t, column: c, ...x.columns[c] });
    for (const c of y.constraints || []) if (!(x.constraints || []).includes(c)) r.constraints_added.push({ table: t, constraint: c });
    for (const c of x.constraints || []) if (!(y.constraints || []).includes(c)) r.constraints_removed.push({ table: t, constraint: c });
  }
  for (const i of Object.keys(b.indexes)) if (!(i in a.indexes)) { r.indexes_added.push(i); if (/^unique\b/.test(b.indexes[i])) r.unique_indexes_added.push(i); } else if (a.indexes[i] !== b.indexes[i]) r.indexes_changed.push({ index: i, before: a.indexes[i], after: b.indexes[i] });
  for (const i of Object.keys(a.indexes)) if (!(i in b.indexes)) r.indexes_removed.push(i);
  r.other_added = b.other.filter((o) => !a.other.includes(o));
  r.other_removed = a.other.filter((o) => !b.other.includes(o));
  r.identical = Object.entries(r).every(([k, v]) => k === "identical" || v.length === 0);
  return r;
}

// Mixed-version rollout compatibility derived from a before -> after diff. Entries are inferences from the measured
// diff about code that is not visible here, so they are judged unless the scan found a reader.
export function compatibility(d) {
  const oldOnNew = []; const newOnOld = [];
  for (const t of d.tables_removed) oldOnNew.push({ object: t, why: "table removed: the old app's reads and writes fail" });
  for (const c of d.columns_removed) oldOnNew.push({ object: `${c.table}.${c.column}`, why: "column removed: the old app's reads and writes of it fail" });
  for (const c of d.columns_added) if (c.not_null && c.default === null) oldOnNew.push({ object: `${c.table}.${c.column}`, why: "NOT NULL column without default: the old app's inserts omit it and fail" });
  for (const c of d.columns_changed) if (c.field === "type" || c.field === "not_null" && c.after) oldOnNew.push({ object: `${c.table}.${c.column}`, why: `${c.field} ${c.before} -> ${c.after}: old writes may be rejected or truncated` });
  for (const i of d.unique_indexes_added) oldOnNew.push({ object: i, why: "unique index: old writes that violate it fail" });
  for (const t of d.tables_added) newOnOld.push({ object: t, why: "table absent in the old schema (rolled back, or app deployed before the migration)" });
  for (const c of d.columns_added) newOnOld.push({ object: `${c.table}.${c.column}`, why: "column absent in the old schema: the new app's queries fail" });
  for (const c of d.columns_changed) newOnOld.push({ object: `${c.table}.${c.column}`, why: `${c.field} differs in the old schema` });
  return { old_app_on_new_schema: oldOnNew, new_app_on_old_schema: newOnOld, evidence_class: "judged",
    note: "derived from the measured snapshot diff; what the app actually does with these objects is not observed here" };
}

// ---------- data: seed row preservation ----------

export function diffData(before, after, keys = {}) {
  const out = { tables: {}, preserved: true };
  for (const [t, rowsB] of Object.entries(before.tables || before)) {
    const rowsA = (after.tables || after)[t];
    const key = keys[t] || "id";
    const e = { count_before: rowsB.length, count_after: rowsA ? rowsA.length : null, missing: [], changed: [], dropped_columns: [], renamed_columns: [] };
    if (!rowsA) { e.missing = rowsB.map((r) => r[key]); out.preserved = false; out.tables[t] = e; continue; }
    const byKey = new Map(rowsA.map((r) => [String(r[key]), r]));
    const dropped = new Set();
    for (const rb of rowsB) {
      const ra = byKey.get(String(rb[key]));
      if (!ra) { e.missing.push(rb[key]); continue; }
      for (const c of Object.keys(rb)) {
        if (!(c in ra)) { dropped.add(c); continue; }
        if (JSON.stringify(rb[c]) !== JSON.stringify(ra[c])) e.changed.push({ key: rb[key], column: c, before: rb[c], after: ra[c] });
      }
    }
    // A dropped column whose values reappear unchanged under a new name in every surviving row is a rename, not a loss.
    const survivors = rowsB.filter((rb) => byKey.has(String(rb[key])));
    const added = [...new Set(rowsA.flatMap((r) => Object.keys(r)))].filter((c) => !rowsB.some((rb) => c in rb));
    e.renamed_columns = [];
    for (const c of [...dropped]) {
      const to = added.find((n) => survivors.length && survivors.every((rb) => JSON.stringify(byKey.get(String(rb[key]))[n]) === JSON.stringify(rb[c])));
      if (to) { e.renamed_columns.push({ from: c, to }); dropped.delete(c); }
    }
    e.dropped_columns = [...dropped];
    if (e.missing.length || e.changed.length || e.dropped_columns.length || rowsA.length < rowsB.length) out.preserved = false;
    out.tables[t] = e;
  }
  return out;
}

// ---------- CLI ----------

function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => { process.stderr.write("usage: migration-check.mjs scan [--engine e] [--context f...] [--populated t,..] [--readers p...] -- <files> | diff <before> <after> [--rollback f] | data <before.json> <after.json> [--key t=col]\n"); return 2; };
  try {
    if (cmd === "scan") {
      const o = { context: [], readers: [], populated: [], engine: "other" }; const files = [];
      let target = null;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--") target = files;
        else if (a === "--engine") o.engine = rest[++i];
        else if (a === "--populated") o.populated = rest[++i].split(",").filter(Boolean);
        else if (a === "--context") target = o.context;
        else if (a === "--readers") target = o.readers;
        else if (a.startsWith("--")) return usage();
        else (target || files).push(a);
      }
      if (!files.length) return usage();
      process.stdout.write(JSON.stringify(scanMigrations(files, { engine: o.engine, context: o.context, populated: o.populated, readerFiles: listFiles(o.readers.filter((p) => !files.includes(p))).filter((f) => !files.includes(f)) }), null, 2) + "\n");
      return 0;
    }
    if (cmd === "diff") {
      const pos = []; let rollback = null;
      for (let i = 0; i < rest.length; i++) { if (rest[i] === "--rollback") rollback = rest[++i]; else if (rest[i].startsWith("--")) return usage(); else pos.push(rest[i]); }
      if (pos.length !== 2) return usage();
      const before = parseSchema(readFileSync(pos[0], "utf8"));
      const after = parseSchema(readFileSync(pos[1], "utf8"));
      const d = diffSchemas(before, after);
      const res = { schema_version: 1, evidence_class: "measured", diff: d, compatibility: compatibility(d) };
      if (rollback) {
        const rb = diffSchemas(before, parseSchema(readFileSync(rollback, "utf8")));
        res.rollback = { restores_schema: rb.identical, diff_vs_before: rb };
      }
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      return 0;
    }
    if (cmd === "data") {
      const pos = []; const keys = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--key") { const [t, c] = rest[++i].split("="); keys[t] = c; } else if (rest[i].startsWith("--")) return usage(); else pos.push(rest[i]);
      }
      if (pos.length !== 2) return usage();
      const r = diffData(JSON.parse(readFileSync(pos[0], "utf8")), JSON.parse(readFileSync(pos[1], "utf8")), keys);
      process.stdout.write(JSON.stringify({ schema_version: 1, evidence_class: "measured", ...r }, null, 2) + "\n");
      return 0;
    }
    return usage();
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main(process.argv.slice(2)));
