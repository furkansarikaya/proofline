#!/usr/bin/env node
// Classifies migration files statement by statement, from the text only (no database access).
// SQL files (*.sql) are lexed (comments, strings, dollar quotes and quoted identifiers aware) and split
// into statements; every other file (ORM / document-store migrations) gets a token scan plus a SQL scan
// of its string literals. Output: JSON matching ../schema/classification.schema.json.
// Usage: node classify-migration.mjs [--context <file>...] [--] <file>...
//   --context files are read only to learn prior column types (for type-widening checks); never classified.
// Exit codes: 0 classified (read "destructive" in the output), 2 usage or read error.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------- lexer ----------

// Returns `masked`: same length as `src`, comments blanked, string-literal contents replaced by "x",
// newlines kept, so offsets and line numbers stay valid and keyword regexes never match inside data.
export function maskSql(src) {
  const out = src.split("");
  const blank = (from, to, keepQuotes) => {
    for (let k = from; k < to; k++) {
      if (out[k] === "\n") continue;
      if (keepQuotes && (k === from || k === to - 1)) continue;
      out[k] = keepQuotes ? "x" : " ";
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "-" && d === "-") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? n : e;
      blank(i, end, false);
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end, false);
      i = end;
    } else if (c === "'") {
      const backslash = i > 0 && /[eE]/.test(src[i - 1]) && !/\w/.test(src[i - 2] || "");
      let j = i + 1;
      while (j < n) {
        if (backslash && src[j] === "\\") { j += 2; continue; }
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      const end = Math.min(j + 1, n);
      blank(i, end, true);
      i = end;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (m && !/[\w]/.test(src[i - 1] || "")) {
        const tag = m[0];
        const e = src.indexOf(tag, i + tag.length);
        const end = e === -1 ? n : e + tag.length;
        blank(i, end, true);
        i = end;
      } else i++;
    } else if (c === '"' || c === "`") {
      const e = src.indexOf(c, i + 1);
      i = e === -1 ? n : e + 1; // quoted identifiers stay readable; names are needed
    } else i++;
  }
  return out.join("");
}

// Splits on ";" (outside comments/strings) and on SQL Server "GO" batch lines.
// ponytail: MySQL client "DELIMITER" blocks are not supported; such files classify as unknown.
export function splitStatements(src) {
  const masked = maskSql(src).replace(/^[ \t]*GO[ \t]*$/gim, (m) => ";".padEnd(m.length, " "));
  const stmts = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || masked[i] === ";") {
      const raw = src.slice(start, i);
      const mk = masked.slice(start, i);
      const lead = mk.search(/\S/);
      if (lead !== -1) {
        const line = src.slice(0, start + lead).split("\n").length;
        stmts.push({ line, text: raw.slice(lead).trim(), masked: mk.replace(/\s+/g, " ").trim() });
      }
      start = i + 1;
    }
  }
  return stmts;
}

// ---------- helpers ----------

const ID = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$#@]*)`;
const QNAME = String.raw`${ID}(?:\s*\.\s*${ID})*`;
const unq = (s) => s.replace(/^["`[]|["`\]]$/g, "");
// Last identifier of a possibly schema-qualified name, unquoted, lower case.
export const baseName = (q) => unq(q.trim().split(/\s*\.\s*(?=(?:"|`|\[|[A-Za-z_]))/).pop()).toLowerCase();

// Splits at commas outside parentheses.
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const DESTRUCTIVE = new Set(["drop_table", "drop_schema", "drop_column", "drop_partition", "truncate", "delete", "alter_column_type", "set_not_null", "replace", "merge"]);
export const KINDS = [
  "create_table", "drop_table", "drop_schema", "truncate", "rename_table",
  "add_column", "drop_column", "rename_column", "alter_column_type", "set_not_null", "drop_not_null",
  "set_default", "drop_default", "add_constraint", "drop_constraint", "drop_partition",
  "create_index", "drop_index", "create_other", "drop_other",
  "insert", "update", "delete", "replace", "merge", "alter_other", "other", "unknown",
];

// ---------- type widening ----------

const INT_RANK = { smallint: 1, int2: 1, integer: 2, int: 2, int4: 2, mediumint: 2, bigint: 3, int8: 3 };
function normType(t) {
  return t.toLowerCase().replace(/\s+/g, " ").replace(/\b(character varying|varchar2|nvarchar)\b/, "varchar").trim();
}
// True only when the new type provably holds every value of the old one.
export function isWidening(oldT, newT) {
  if (!oldT) return false;
  const o = normType(oldT);
  const w = normType(newT);
  if (o === w) return true;
  const len = (t) => { const m = /^varchar\s*\(\s*(\d+)\s*\)$/.exec(t); return m ? Number(m[1]) : null; };
  if (/^(varchar|char)\b/.test(o) && w === "text") return true;
  if (len(o) !== null && len(w) !== null) return len(w) >= len(o);
  if (o in INT_RANK && w in INT_RANK) return INT_RANK[w] >= INT_RANK[o];
  return false;
}
const TYPE_TOKEN = /^([A-Za-z_][\w ]*?(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?)(?=\s|$)/;
function leadingType(rest) {
  const words = rest.trim().split(/\s+/);
  // multi-word types we care about
  if (/^character$/i.test(words[0]) && /^varying/i.test(words[1] || "")) {
    const m = /^character\s+varying\s*(\(\s*\d+\s*\))?/i.exec(rest.trim());
    return m[0];
  }
  const m = TYPE_TOKEN.exec(rest.trim());
  return m ? m[1].split(/\s+(?=NOT|NULL|DEFAULT|PRIMARY|REFERENCES|UNIQUE|CHECK|COLLATE|GENERATED|CONSTRAINT|USING)\b/i)[0].trim() : "";
}

// Learns column types from CREATE TABLE / ADD COLUMN statements (masked, collapsed).
export function learnTypes(stmts, types = new Map()) {
  for (const { masked } of stmts) {
    let m = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})\s*\((.*)\)`, "i").exec(masked);
    if (m) {
      const t = baseName(m[1]);
      for (const col of splitTop(m[2])) {
        const cm = new RegExp(String.raw`^(${ID})\s+(.*)$`).exec(col);
        if (!cm || /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|KEY|INDEX)$/i.test(cm[1])) continue;
        types.set(`${t}.${baseName(cm[1])}`, leadingType(cm[2]));
      }
      continue;
    }
    m = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\s+(.*)$`, "i").exec(masked);
    if (m) {
      const t = baseName(m[1]);
      for (const a of splitTop(m[2])) {
        const am = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${ID})\s+(.*)$`, "i").exec(a);
        if (am && !/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|KEY|INDEX)$/i.test(am[1])) types.set(`${t}.${baseName(am[1])}`, leadingType(am[2]));
        const tm = new RegExp(String.raw`^(?:ALTER|MODIFY)\s+(?:COLUMN\s+)?(${ID})\s+(?:SET\s+DATA\s+)?(?:TYPE\s+)?(.*)$`, "i").exec(a);
        if (tm && !/^(SET|DROP)\b/i.test(tm[2])) types.set(`${t}.${baseName(tm[1])}`, leadingType(tm[2]));
      }
    }
  }
  return types;
}

// ---------- statement classification ----------

// ctx: { created: Set<table>, types: Map<"table.col", type> }
export function classifyStatement(masked, ctx) {
  const s = masked;
  const r = (kind, object, reason, cls) => ({ kind, object, class: cls || (DESTRUCTIVE.has(kind) ? "destructive" : "safe"), reason });
  const names = (list) => splitTop(list).map((x) => baseName(x.replace(/\s+(CASCADE|RESTRICT)$/i, "")));
  let m;

  if ((m = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(.+?)(?:\s+(?:CASCADE|RESTRICT))?$`, "i").exec(s)))
    return names(m[1]).map((t) => r("drop_table", t, "drops the table and every row in it"));
  if ((m = new RegExp(String.raw`^DROP\s+(?:SCHEMA|DATABASE)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, "i").exec(s)))
    return [r("drop_schema", baseName(m[1]), "drops a schema or database with all its data")];
  if ((m = new RegExp(String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(${QNAME})`, "i").exec(s)))
    return [r("drop_index", baseName(m[1]), "no data loss; a unique index removal also drops a uniqueness guarantee", "breaking")];
  if ((m = new RegExp(String.raw`^DROP\s+(?:MATERIALIZED\s+VIEW|VIEW|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|TYPE|DOMAIN|EXTENSION|RULE|POLICY)\s+(?:IF\s+EXISTS\s+)?(${QNAME})`, "i").exec(s)))
    return [r("drop_other", baseName(m[1]), "no table data removed; dependants break", "breaking")];
  if ((m = new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?(.+?)(?:\s+(?:RESTART|CONTINUE)\s+IDENTITY)?(?:\s+(?:CASCADE|RESTRICT))?$`, "i").exec(s)))
    return names(m[1]).map((t) => r("truncate", t, "deletes every row"));
  if ((m = new RegExp(String.raw`^DELETE\s+(?:FROM\s+)?(?:ONLY\s+)?(${QNAME})`, "i").exec(s)))
    return [r("delete", baseName(m[1]), /\sWHERE\s/i.test(s) ? "deletes the rows matching WHERE" : "deletes every row (no WHERE)")];
  if ((m = new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?(${QNAME})(?:\s+(?:AS\s+)?${ID})?\s+SET\s+(.+?)(?:\s+FROM\s+.+?)?(?:\s+WHERE\s+(.+))?$`, "i").exec(s))) {
    const table = baseName(m[1]);
    const cols = splitTop(m[2]).map((a) => baseName(a.split("=")[0]));
    const where = m[3] || "";
    const fillsOnlyNulls = where && !/\bOR\b/i.test(where) &&
      cols.every((c) => new RegExp(String.raw`(?:^|[\s(.])"?${c.replace(/[$]/g, "\\$")}"?\s+IS\s+NULL\b`, "i").test(where));
    return [fillsOnlyNulls
      ? r("update", table, "backfill: only fills rows where every assigned column IS NULL")
      : r("update", table, "overwrites existing values in " + cols.join(", ") + (where ? "" : " for every row"), "destructive")];
  }
  if ((m = new RegExp(String.raw`^REPLACE\s+(?:INTO\s+)?(${QNAME})`, "i").exec(s)))
    return [r("replace", baseName(m[1]), "REPLACE deletes conflicting rows before inserting")];
  if ((m = new RegExp(String.raw`^MERGE\s+(?:INTO\s+)?(${QNAME})`, "i").exec(s)))
    return /THEN\s+(?:DELETE|UPDATE)\b/i.test(s)
      ? [r("merge", baseName(m[1]), "MERGE updates or deletes matched rows")]
      : [r("insert", baseName(m[1]), "MERGE that only inserts")];
  if ((m = new RegExp(String.raw`^INSERT\s+(?:OR\s+(\w+)\s+)?(?:IGNORE\s+)?(?:INTO\s+)?(${QNAME})`, "i").exec(s)))
    return /^REPLACE$/i.test(m[1] || "") || /\bON\s+(?:CONFLICT\s*(?:\([^)]*\)\s*)?DO\s+UPDATE|DUPLICATE\s+KEY\s+UPDATE)\b/i.test(s)
      ? [r("insert", baseName(m[2]), "upsert overwrites existing rows", "destructive")]
      : [r("insert", baseName(m[2]), "adds rows")];
  if ((m = new RegExp(String.raw`^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})`, "i").exec(s))) {
    ctx.created.add(baseName(m[1]));
    return [r("create_table", baseName(m[1]), "new table")];
  }
  if ((m = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})?\s*ON\s+(?:ONLY\s+)?(${QNAME})`, "i").exec(s)))
    return [r("create_index", baseName(m[2]), "new index; check the lock note for the engine")];
  if (/^CREATE\b/i.test(s)) return [r("create_other", "", "new object, no data change")];
  if ((m = new RegExp(String.raw`^RENAME\s+TABLE\s+(${QNAME})`, "i").exec(s)))
    return [r("rename_table", baseName(m[1]), "renames a table; old readers break", "breaking")];
  if (/^(EXEC(?:UTE)?\s+)?sp_rename\b/i.test(s))
    return [r("rename_column", "", "sp_rename renames an object; old readers break", "breaking")];
  if ((m = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})\s+(.*)$`, "i").exec(s)))
    return splitTop(m[2]).map((a) => classifyAlterAction(baseName(m[1]), a, ctx));
  if (/^(GRANT|REVOKE|COMMENT\s+ON|SET|RESET|BEGIN|COMMIT|END|START\s+TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE|USE|SELECT|ANALYZE|VACUUM|REINDEX|PRAGMA|LOCK\s+TABLES?|UNLOCK\s+TABLES?)\b/i.test(s))
    return [r("other", "", "no schema or data change")];
  return [r("unknown", "", "statement not recognised; procedural or engine-specific code cannot be classified from text", "unknown")];
}

const CONSTRAINT_WORD = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|KEY|INDEX|FULLTEXT|SPATIAL)$/i;

function classifyAlterAction(table, a, ctx) {
  const r = (kind, object, reason, cls) => ({ kind, object, class: cls || (DESTRUCTIVE.has(kind) ? "destructive" : "safe"), reason });
  const col = (c) => `${table}.${baseName(c)}`;
  const populated = !ctx.created.has(table);
  let m;
  if ((m = /^(?:DROP|TRUNCATE)\s+PARTITION\s+(.+)$/i.exec(a))) return r("drop_partition", table, "removes a partition and its rows");
  if ((m = new RegExp(String.raw`^DROP\s+(?:CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${ID})|PRIMARY\s+KEY|FOREIGN\s+KEY\s+(${ID})|(?:INDEX|KEY)\s+(${ID})|CHECK\s+(${ID}))`, "i").exec(a)))
    return r("drop_constraint", `${table}${m[1] || m[2] || m[3] || m[4] ? "." + baseName(m[1] || m[2] || m[3] || m[4]) : ""}`, "no data loss; the guarantee it enforced is gone", "breaking");
  if ((m = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${ID})`, "i").exec(a)) && !/^(DEFAULT|NOT)$/i.test(m[1]))
    return r("drop_column", col(m[1]), "drops the column and every value in it");
  if (new RegExp(String.raw`^ADD\s+(?:CONSTRAINT\b|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|INDEX|KEY|FULLTEXT|SPATIAL)`, "i").test(a))
    return r("add_constraint", table, "new constraint; validation scans the table unless deferred (see lock note)");
  if ((m = new RegExp(String.raw`^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${ID})\s*(.*)$`, "i").exec(a)) && !CONSTRAINT_WORD.test(m[1])) {
    const rest = m[2];
    if (populated && /\bNOT\s+NULL\b/i.test(rest) && !/\b(DEFAULT|GENERATED|IDENTITY|AUTO_INCREMENT)\b/i.test(rest))
      return r("add_column", col(m[1]), "NOT NULL without a default on an existing (possibly populated) table", "destructive");
    return r("add_column", col(m[1]), "new column");
  }
  if ((m = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?(${ID})\s+TO\s+(${ID})`, "i").exec(a)) && !/^TO$/i.test(m[1]))
    return r("rename_column", col(m[1]), `renames to ${baseName(m[2])}; old readers break`, "breaking");
  if ((m = new RegExp(String.raw`^RENAME\s+(?:TO|AS)\s+(${QNAME})`, "i").exec(a)))
    return r("rename_table", table, `renames to ${baseName(m[1])}; old readers break`, "breaking");
  if ((m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${ID})\s+SET\s+NOT\s+NULL`, "i").exec(a)))
    return populated
      ? r("set_not_null", col(m[1]), "SET NOT NULL fails or rejects writes when existing rows hold NULL")
      : r("set_not_null", col(m[1]), "table created in the same change", "safe");
  if ((m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${ID})\s+DROP\s+NOT\s+NULL`, "i").exec(a))) return r("drop_not_null", col(m[1]), "relaxes a constraint");
  if ((m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${ID})\s+SET\s+DEFAULT\b`, "i").exec(a))) return r("set_default", col(m[1]), "default for new rows only");
  if ((m = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${ID})\s+DROP\s+DEFAULT\b`, "i").exec(a))) return r("drop_default", col(m[1]), "default removed for new rows");
  // type changes: Postgres "ALTER COLUMN c [SET DATA] TYPE t", SQL Server "ALTER COLUMN c t", MySQL MODIFY / CHANGE
  if ((m = new RegExp(String.raw`^(?:ALTER\s+(?:COLUMN\s+)?(${ID})\s+(?:SET\s+DATA\s+)?(?:TYPE\s+)?|MODIFY\s+(?:COLUMN\s+)?(${ID})\s+|CHANGE\s+(?:COLUMN\s+)?(${ID})\s+${ID}\s+)(.+)$`, "i").exec(a))) {
    const c = col(m[1] || m[2] || m[3]);
    const newT = leadingType(m[4]);
    const notNull = /\bNOT\s+NULL\b/i.test(m[4]) && populated;
    if (/\bUSING\b/i.test(m[4])) return r("alter_column_type", c, "type change with a USING conversion");
    if (m[3]) return r("alter_column_type", c, "CHANGE redefines the column (rename and type)");
    const old = ctx.types.get(c);
    if (isWidening(old, newT) && !notNull) return r("alter_column_type", c, `widening ${old} -> ${newT}`, "safe");
    return r("alter_column_type", c, old ? `${old} -> ${newT} is not a provable widening` : `prior type unknown; narrowing cannot be excluded (pass --context with the defining migration)`);
  }
  if (/^(OWNER\s+TO|SET\s+SCHEMA|ENABLE|DISABLE|SET\s*\(|RESET\s*\(|VALIDATE\s+CONSTRAINT|ALGORITHM|LOCK|CLUSTER\s+ON|SET\s+(?:LOGGED|UNLOGGED|TABLESPACE|WITHOUT))/i.test(a))
    return r("alter_other", table, "table option, no data change");
  return r("unknown", table, "ALTER TABLE action not recognised", "unknown");
}

// ---------- non-SQL migrations (ORM, document stores) ----------

const TOKENS = [
  [/\b(dropTable|drop_table|DropTable|DeleteModel|dropTableIfExists|deleteTable|dropCollection|drop_join_table|dropView|drop_view|dropIfExists|drop_table_if_exists)\b|<dropTable\b|\.drop\(\s*\)/, "drop_table"],
  [/\b(dropDatabase|dropSchema|drop_schema|DropSchema)\b/, "drop_schema"],
  [/\b(dropColumn|dropColumns|drop_column|remove_column|remove_columns|removeColumn|DropColumn|RemoveField|remove_reference|remove_belongs_to|removeColumns|drop_columns)\b|\$unset\b|<dropColumn\b|\bdrop\s+column\b/i, "drop_column"],
  [/\b(renameColumn|rename_column|RenameColumn|RenameField)\b/, "rename_column"],
  [/\b(renameTable|rename_table|RenameTable|RenameModel|renameCollection)\b/, "rename_table"],
  [/\b(changeColumn|change_column|AlterColumn|AlterField|change_column_null)\b|\.alter\(\s*\)/, "alter_column_type"],
  [/\b(deleteMany|deleteOne|delete_all|destroy_all|bulkDelete|findOneAndDelete)\b|\.(?:remove|del|truncate)\(/, "delete"],
];
const BREAKING_TOKENS = new Set(["rename_column", "rename_table"]);

function stripCodeComments(src) {
  // ponytail: strips // and /* */ and leading-# line comments only; strings keep their text (SQL in them is scanned).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length))
    .replace(/^[ \t]*#(?![!{]).*$/gm, (m) => " ".repeat(m.length));
}

// Operations whose presence shows a migration file was understood even when nothing destructive is in it
// (A94): without one of these, or with an SQL string built at run time, a non-SQL file is `unanalyzed`.
const KNOWN_OPS = /\b(createTable|create_table|createTableIfNotExists|addColumn|add_column|addColumns|createIndex|create_index|add_index|addIndex|createCollection|createIndexes|CreateModel|AddField|CreateTable|AddColumn|CreateIndex|add_reference|add_foreign_key|addForeignKey|addConstraint|add_constraint|changeColumn|alter_column|AlterField|renameColumn|rename_column|insert|bulkInsert|seed)\b|<(createTable|addColumn|createIndex)\b/;
const SQL_VERB = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE|SET|BEGIN|COMMIT|WITH|REPLACE|MERGE|CALL|LOCK|VACUUM|ANALYZE|REINDEX|REFRESH)\b/i;
const EXEC_CALL = /\b(execute|exec|raw|query|queryRaw|run_sql|RunSQL|Exec|ExecContext)\b[ \t]*\(?[ \t]*/g;
const HEREDOC = /^<<[~-]?(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n|$)/;
const LITERAL = /^(?:(?:sa\.|sqlalchemy\.)?text\(\s*)?(?:[rRfFbBuU]{1,2})?("""|'''|"|'|`)([\s\S]*?)\1/;
// The SQL an execute-like call hands over: a heredoc, a (triple-)quoted literal, or null for anything computed.
function execArgument(rest) {
  const h = HEREDOC.exec(rest);
  if (h) return h[3];
  const l = LITERAL.exec(rest);
  return l ? l[2] : null;
}
export function unanalyzedReason(src, actions) {
  const code = stripCodeComments(src);
  for (const m of code.matchAll(EXEC_CALL)) {
    const rest = code.slice(m.index + m[0].length);
    if (/^[=.:,)]|^(?:do|if|unless|end)\b/.test(rest) || /^\s*$/.test(rest.split("\n")[0])) continue; // not a call with an argument on this line
    const arg = execArgument(rest);
    if (arg === null) return `SQL or an operation is built at run time (a non-literal argument to ${m[1]}): the statement cannot be read statically`;
    if (!SQL_VERB.test(arg)) return `${m[1]} receives a string that is not a recognised SQL statement: it cannot be classified`;
  }
  if (!actions.length && !KNOWN_OPS.test(code)) return "no recognised migration operation (no schema token and no SQL literal): the file was not understood";
  return null;
}

// Lines (1-based, inclusive) of the down path of a migration: python/ruby `def downgrade|down`, JavaScript and
// Go `down` / `Down` bodies; SQL markers (`-- +goose Down`, `-- +migrate Down`, `-- migrate:down`) start a tail.
export function downRanges(src) {
  const lines = src.split("\n"), out = [];
  const indent = (l) => l.match(/^[ \t]*/)[0].length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*--\s*(\+goose\s+Down|\+migrate\s+Down|migrate:down)\b/i.test(l)) { out.push([i + 1, lines.length]); break; }
    if (/^\s*(?:async\s+)?def\s+(?:downgrade|down)\b/.test(l)) {
      let j = i + 1; const ind = indent(l);
      while (j < lines.length && (!lines[j].trim() || indent(lines[j]) > ind)) j++;
      out.push([i + 1, j]); i = j - 1; continue;
    }
    if (/(?:\bexports\.down\b|\bmodule\.exports\.down\b|^\s*(?:async\s+)?down\s*[:(=]|\bdown\s*:\s*(?:async\s*)?(?:function|\()|\bfunc\s+(?:\([^)]*\)\s*)?Down\w*\s*\(|\bexport\s+(?:async\s+)?function\s+down\b|\bconst\s+down\s*=)/.test(l)) {
      let depth = 0, seen = false, j = i;
      for (; j < lines.length; j++) {
        for (const c of lines[j].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")) { if (c === "{") { depth++; seen = true; } else if (c === "}") depth--; }
        if (seen ? depth <= 0 : /;\s*$/.test(lines[j])) break;
      }
      out.push([i + 1, j + 1]); i = j;
    }
  }
  return out;
}
export const inRanges = (ranges, line) => ranges.some(([a, b]) => line >= a && line <= b);

export function scanNonSql(src) {
  let code = stripCodeComments(src);
  const actions = [];
  const lineAt = (idx) => code.slice(0, idx).split("\n").length;
  // heredoc and triple-quoted bodies are SQL when they open with a statement verb; blank them afterwards so the
  // quote scan below does not pair their apostrophes
  const blocks = [];
  for (const m of code.matchAll(/<<[~-]?(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)|("""|''')([\s\S]*?)\4/g)) {
    const body = m[3] ?? m[5];
    if (SQL_VERB.test(body)) blocks.push({ index: m.index + m[0].indexOf(body), len: body.length, body });
  }
  for (const b of blocks) {
    const baseLine = lineAt(b.index);
    for (const st of splitStatements(b.body)) {
      const ctx = { created: new Set(), types: new Map() };
      for (const a of classifyStatement(st.masked, ctx)) actions.push({ line: baseLine + st.line - 1, statement: st.text.slice(0, 300), ...a });
    }
  }
  for (const b of blocks) code = code.slice(0, b.index) + b.body.replace(/[^\n]/g, " ") + code.slice(b.index + b.len);
  const srcLines = src.split("\n");
  code.split("\n").forEach((ln, idx) => {
    for (const [re, kind] of TOKENS) {
      const g = new RegExp(re.source, "g");
      let m;
      while ((m = g.exec(ln))) {
        const arg = /^\s*\(?\s*['"`:]([\w.]+)['"`]?/.exec(ln.slice(m.index + m[0].length)) ||
          /^\(\s*['"`]([\w.]+)['"`]/.exec(ln.slice(m.index + m[0].length - 1));
        actions.push({ line: idx + 1, statement: (srcLines[idx] ?? "").trim().slice(0, 300), kind,
          object: arg ? arg[1].toLowerCase() : "?",
          class: BREAKING_TOKENS.has(kind) ? "breaking" : "destructive",
          reason: `token "${m[0].replace(/^\./, "")}" (${kind})` });
      }
    }
  });
  // SQL inside string literals, e.g. raw queries in ORM migrations
  const strRe = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/gs;
  let m;
  while ((m = strRe.exec(code))) {
    if (!/^\s*(ALTER|DROP|TRUNCATE|DELETE|UPDATE|INSERT|CREATE|RENAME|REPLACE|MERGE)\s/i.test(m[2])) continue;
    const baseLine = lineAt(m.index);
    for (const st of splitStatements(m[2])) {
      const ctx = { created: new Set(), types: new Map() };
      for (const a of classifyStatement(st.masked, ctx))
        actions.push({ line: baseLine + st.line - 1, statement: st.text.slice(0, 300), ...a });
    }
  }
  const down = downRanges(src);
  for (const a of actions) if (inRanges(down, a.line)) a.path = "down"; // present only on the down path
  return actions.sort((a, b) => a.line - b.line);
}

// ---------- files ----------

export function classifyFiles(files, contextFiles = [], read = (f) => readFileSync(f, "utf8")) {
  const types = new Map();
  for (const f of contextFiles) if (/\.sql$/i.test(f)) learnTypes(splitStatements(read(f)), types);
  const ctx = { created: new Set(), types };
  const out = { schema_version: 1, destructive: "no", files: [], actions: [] };
  for (const file of files) {
    const src = read(file);
    if (/\.sql$/i.test(file)) {
      out.files.push({ file, method: "sql" });
      const stmts = splitStatements(src);
      const down = downRanges(src);
      for (const st of stmts) {
        for (const a of classifyStatement(st.masked, ctx))
          out.actions.push({ file, line: st.line, statement: st.text.slice(0, 300), ...a, ...(inRanges(down, st.line) ? { path: "down" } : {}) });
        learnTypes([st], ctx.types); // later statements see types defined earlier in the change
      }
    } else {
      out.files.push({ file, method: "token-scan" });
      const acts = scanNonSql(src);
      for (const a of acts) out.actions.push({ file, ...a });
      const why = unanalyzedReason(src, acts);
      if (why) { out.unanalyzed = out.unanalyzed || []; out.unanalyzed.push({ file, reason: why }); }
    }
  }
  const bad = (a) => a.class === "destructive" || a.class === "unknown";
  // A94: only the up path decides `destructive`; a destructive down path is recorded as `down_destructive`
  // (never executed by the agent either, A84) so a reversible additive migration is not forced destructive: yes
  if (out.actions.some((a) => bad(a) && a.path !== "down") || out.unanalyzed) out.destructive = "yes";
  if (out.actions.some((a) => bad(a) && a.path === "down")) out.down_destructive = "yes"; // present only when yes
  return out;
}

function main(argv) {
  const files = [];
  const context = [];
  let target = files;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--context") target = context;
    else if (argv[i] === "--") target = files;
    else if (argv[i].startsWith("--")) { process.stderr.write(`unknown option ${argv[i]}\n`); return 2; }
    else target.push(argv[i]);
  }
  if (!files.length) {
    process.stderr.write("usage: classify-migration.mjs [--context <file>... --] <file>...\n");
    return 2;
  }
  try {
    process.stdout.write(JSON.stringify(classifyFiles(files, context), null, 2) + "\n");
    return 0;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) process.exit(main(process.argv.slice(2)));
