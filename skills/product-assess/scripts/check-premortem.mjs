#!/usr/bin/env node
// PREMORTEM.md check. Line: `- RK-n <failure story> kind: real|overstated|unspoken; response: <what the plan does>`.
// real = a risk the team named and agrees with; overstated = named but smaller than feared; unspoken = nobody said it
// before the premortem. Every risk has a kind and a non-empty response. Read-only.
//   node check-premortem.mjs <PREMORTEM.md|slug> [--json] [--root DIR]    exit 0 clean, 1 findings, 2 usage
import { cli, field, isMain, items, read, report, resolveDoc } from "./lib.mjs";

export const KINDS = ["real", "overstated", "unspoken"];
const KEYS = ["kind", "response"];
export function checkPremortem(text) {
  const findings = [], seen = new Set(), list = items(text, "RK");
  const add = (it, rule, message) => findings.push({ rule, line: it.line, id: it.id, message });
  if (!list.length) findings.push({ rule: "no-risk", line: 0, message: "no `- RK-n` line" });
  for (const it of list) {
    if (seen.has(it.id)) add(it, "duplicate-id", `${it.id} is defined twice`);
    seen.add(it.id);
    const kind = field(it, "kind", KEYS)?.toLowerCase() ?? null, resp = field(it, "response", KEYS);
    if (!KINDS.includes(kind)) add(it, "kind", `kind "${kind ?? ""}" is not one of ${KINDS.join("|")}`);
    if (!resp || !/\p{L}/u.test(resp)) add(it, "response", "the risk has no response (what the plan does about it)");
  }
  return { findings, count: list.length };
}

function main(argv) {
  const c = cli(argv, "check-premortem.mjs <PREMORTEM.md|slug> [--json] [--root DIR]", ["--root"]);
  if (!c) return 2;
  const file = resolveDoc(c.args[0], "PREMORTEM.md", c.root), text = read(file);
  if (text === null) { console.error(`cannot read ${file}`); return 2; }
  const r = checkPremortem(text);
  return report(file, r.findings, { count: r.count }, c.flags["--json"]);
}
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
