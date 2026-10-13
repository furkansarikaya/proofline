// Compares contract-proof outputs on the fixture with EXPECTED.json.
// Usage: node compare.mjs <run: all|covered|legacy> <contract.json> <validator stdout file> <EXPECTED.json>
import { readFileSync } from "node:fs";

const [run, reportPath, outPath, expPath] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const out = readFileSync(outPath, "utf8");
const exp = JSON.parse(readFileSync(expPath, "utf8"));
const errors = [];
const want = exp.runs[run];
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const paths = want.paths || Object.keys(exp.files);
const got = new Map(report.files.map((f) => [f.path, f]));
if (!sameSet(got.keys(), paths)) errors.push(`files: got ${[...got.keys()].join(", ")}, want ${paths.join(", ")}`);
for (const p of paths) {
  const f = got.get(p), e = exp.files[p];
  if (!f) continue;
  if (f.status !== e.status) errors.push(`${p}: status ${f.status}, want ${e.status}`);
  const changes = f.changes.map((c) => `${c.rule} ${c.side} ${c.element}`);
  if (!sameSet(changes, e.changes)) errors.push(`${p}: changes\n  got  ${[...changes].sort().join(" | ")}\n  want ${[...e.changes].sort().join(" | ")}`);
  for (const c of f.changes) {
    const key = `${p} ${c.element}`;
    if (c.coverage.covered !== (key in exp.covered)) errors.push(`${key}: covered ${c.coverage.covered}`);
    if (c.coverage.covered && c.coverage.plan_line !== exp.covered[key]) errors.push(`${key}: plan_line ${c.coverage.plan_line}, want ${exp.covered[key]}`);
    const ec = exp.consumers[c.element];
    if (ec && c.classification !== "non-breaking") {
      const gc = c.consumers.in_repo.map((r) => `${r.path}:${r.line}`);
      if (!sameSet(gc, ec)) errors.push(`${key}: consumers ${gc.join(", ")}, want ${ec.join(", ")}`);
    }
    if (c.consumers.outside_repo !== "unknown") errors.push(`${key}: outside consumers must be unknown`);
  }
}
const result = (/^RESULT: (\S+)/m.exec(out) || [])[1];
if (result !== want.result) errors.push(`RESULT ${result}, want ${want.result}`);
const blocking = out.split("\n").filter((l) => l.startsWith("blocking|")).map((l) => {
  const [, loc, finding] = l.split("|");
  const path = loc.replace(/:\d+$/, "");
  return finding.startsWith("UNSUPPORTED") ? `${path} UNSUPPORTED` : `${path} ${finding.split(" ")[3].replace(/:$/, "")}`;
});
if (!sameSet(blocking, want.blocking)) errors.push(`blocking rows: got ${blocking.sort().join(", ")}, want ${[...want.blocking].sort().join(", ")}`);
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`compare ${run}: ok`);
