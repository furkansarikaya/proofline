// Compares an impact report with EXPECTED.json (set equality per list). Used by selfcheck.sh and the skill tests.
import { readFileSync } from "node:fs";

export function compare(report, expected) {
  const diffs = [];
  const eq = (name, got, want) => {
    const g = new Set(got), w = new Set(want);
    for (const x of w) if (!g.has(x)) diffs.push(`${name}: missing ${x}`);
    for (const x of g) if (!w.has(x)) diffs.push(`${name}: unexpected ${x}`);
  };
  eq("changed symbols", report.symbols.map((x) => x.name), expected.symbols);
  const s = report.symbols.find((x) => x.name === expected.symbols[0]);
  if (!s) return diffs;
  eq("references", s.references.map((r) => `${r.kind} ${r.role} ${r.path}:${r.line}`), expected.references);
  eq("generated", s.references.filter((r) => r.generated).map((r) => `${r.path}:${r.line}`), expected.generated);
  eq("excluded_homonyms", s.excluded_homonyms.map((h) => `${h.path}:${h.line}`), expected.excluded_homonyms);
  eq("files", report.files_affected.map((f) => f.path), expected.files);
  eq("modules", report.modules.map((m) => m.path), expected.modules);
  eq("tests", report.tests.map((t) => `${t.path} ${t.relation} ${t.kind}`), expected.tests);
  eq("contracts", report.contracts.map((c) => `${c.path} ${c.symbols[0] ? c.symbols[0].kind : "none"} ${c.changed ? "changed" : "unchanged"}`), expected.contracts);
  const dyn = report.unknown.find((u) => u.id === "dynamic-sites");
  eq("dynamic_sites", dyn ? dyn.sites.map((x) => `${x.path}:${x.line}`) : [], expected.dynamic_sites);
  return diffs;
}

if (process.argv[1] && process.argv[1].endsWith("compare.mjs")) {
  const d = compare(JSON.parse(readFileSync(process.argv[2], "utf8")), JSON.parse(readFileSync(process.argv[3], "utf8")));
  for (const x of d) console.error(x);
  process.exit(d.length ? 1 : 0);
}
