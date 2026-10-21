#!/usr/bin/env node
// Checks the competitor table of COMPETITORS.md.
//   node check-competitors.mjs <slug|dir|file> [--today YYYY-MM-DD] [--root DIR] [--json]
// One table row is one cell of the comparison:
//   | Competitor | Attribute | Value | Source | Observed | Quote |
// A cell holds `value | source URL | observed YYYY-MM-DD | "quote"`, here as the columns Value to Quote. A cell that
// cannot be verified (no http(s) source, no valid date, no quote) must have an empty Value (`unverifiable-value`);
// a Value whose numbers are missing from the quote is `value-not-in-quote`. A verified cell observed more than
// product.stale_days (default 90) days before today is marked stale in the output and in `stale[]` of --json; stale
// cells do not change the exit code. --today overrides the date (tests).
// Exit 0 clean, 1 findings, 2 usage.
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, resolveTarget, isDir, parseArgs, report, staleDays, stripComments } from "./lib.mjs";

const HEADER = ["competitor", "attribute", "value", "source", "observed", "quote"];
const NUM = /\d[\d.,]*\d|\d/g;
const norm = (n) => n.replace(/,/g, "").replace(/\.$/, "");
const DAY = 86400000;
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

export function checkCompetitors(text, { today, stale = 90, name = "COMPETITORS.md" } = {}) {
  const findings = [], staleCells = [], cells = [];
  let header = false, fence = false, sawTable = false;
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence || !/^\s*\|/.test(raw)) { if (!/^\s*\|/.test(raw)) header = false; return; }
    const c = raw.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
    if (c.map((s) => s.toLowerCase()).join("|") === HEADER.join("|")) { header = true; sawTable = true; return; }
    if (!header || c.every((s) => /^:?-+:?$/.test(s))) return;
    const add = (rule, message) => findings.push({ file: name, line, id: null, rule, message });
    if (c.length !== 6) return add("bad-row", `a row has 6 columns (${HEADER.join(" | ")}), found ${c.length}`);
    const [competitor, attribute, value, source, observed, quote] = c;
    if (!competitor || !attribute) return add("bad-row", "a row names its competitor and attribute");
    const q = /^"([^"]+)"$/.exec(quote)?.[1];
    const date = observed.replace(/^observed\s+/i, "");
    const verified = /^https?:\/\/\S+$/.test(source) && validDate(date) && !!q;
    const cell = { file: name, line, competitor, attribute, value, source, observed: date, quote: q || "", verified, stale: false };
    if (value && !verified) add("unverifiable-value", `${competitor} / ${attribute}: a value needs an http(s) source, an observed date (YYYY-MM-DD) and a quoted passage; otherwise leave the value empty`);
    if (!value && (source || observed || quote)) add("orphan-source", `${competitor} / ${attribute}: a source without a value; fill both or empty the cell`);
    if (verified) {
      const qn = new Set((q.match(NUM) || []).map(norm));
      const miss = (value.match(NUM) || []).map(norm).filter((n) => !qn.has(n));
      if (miss.length) add("value-not-in-quote", `${competitor} / ${attribute}: number ${miss.join(", ")} of the value does not occur in the quote`);
      const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY);
      cell.ageDays = age;
      if (age < 0) add("future-date", `${competitor} / ${attribute}: observed ${date} is after today (${today})`);
      else if (age > stale) { cell.stale = true; staleCells.push({ file: name, line, competitor, attribute, observed: date, ageDays: age }); }
    }
    cells.push(cell);
  });
  if (!sawTable) findings.push({ file: name, line: 0, id: null, rule: "no-table", message: `no competitor table found; the header row must be | ${HEADER.join(" | ")} |` });
  return { findings, stale: staleCells, cells };
}

function main(argv) {
  const a = parseArgs(argv, ["--root", "--today"], ["--json"]);
  if (a.bad || a._.length !== 1 || (a.today !== undefined && !validDate(a.today))) { console.error("usage: check-competitors.mjs <slug|dir|file> [--today YYYY-MM-DD] [--root DIR] [--json]"); return 2; }
  const root = resolve(a.root || ".");
  let file = resolveTarget(a._[0], root);
  if (isDir(file)) file = join(file, "COMPETITORS.md");
  if (!existsSync(file)) { console.error(`not found: ${file}`); return 2; }
  const r = checkCompetitors(read(file), { today: a.today || new Date().toISOString().slice(0, 10), stale: staleDays(root), name: basename(file) });
  return report(r.findings, { stale: r.stale, cells: r.cells }, a.json, "check-competitors");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
