#!/usr/bin/env node
// PREMORTEM.md check. Line: `- RK-n <failure story> kind: real|overstated|unspoken; response: <what the plan does>`.
// real = a risk the team named and agrees with; overstated = named but smaller than feared; unspoken = nobody said it
// before the premortem. Every risk has a kind and a non-empty response. Read-only.
// The agent contributes: at least MIN_AGENT (5) risks the user did not state, each with `; source: agent accepted by user`
// (or `agent changed by user`), or listed as rejected under `## Rejected proposals` (rule min-proposals). A risk without
// `source:` is the user's own. A `[proposal: ...]` the user has not answered is pending-proposal.
//   node check-premortem.mjs <PREMORTEM.md|slug> [--json] [--root DIR]    exit 0 clean, 1 findings, 2 usage
import { cli, field, isMain, items, read, report, resolveDoc } from "./lib.mjs";
import { parseOrigin, rejectedProposals } from "./validate-product-claims.mjs";

export const KINDS = ["real", "overstated", "unspoken"];
const KEYS = ["kind", "response", "source"];
export const MIN_AGENT = 5;
export function checkPremortem(text, { minAgent = MIN_AGENT } = {}) {
  const findings = [], seen = new Set(), list = items(text, "RK");
  let agent = 0;
  const add = (it, rule, message) => findings.push({ rule, line: it.line, id: it.id, message });
  if (!list.length) findings.push({ rule: "no-risk", line: 0, message: "no `- RK-n` line" });
  for (const it of list) {
    if (seen.has(it.id)) add(it, "duplicate-id", `${it.id} is defined twice`);
    seen.add(it.id);
    const kind = field(it, "kind", KEYS)?.toLowerCase() ?? null, resp = field(it, "response", KEYS);
    if (!KINDS.includes(kind)) add(it, "kind", `kind "${kind ?? ""}" is not one of ${KINDS.join("|")}`);
    if (!resp || !/\p{L}/u.test(resp)) add(it, "response", "the risk has no response (what the plan does about it)");
    if (/\[proposal\b/i.test(it.lines.join(" "))) add(it, "pending-proposal", "a proposal the user has not answered stays out of the document: accepted becomes `source: agent accepted by user`, rejected goes under `## Rejected proposals`");
    const src = field(it, "source", KEYS);
    if (src !== null) {
      const o = parseOrigin(src);
      for (const e of o.errors) add(it, "source", e);
      if (o.origin === "agent" && !o.errors.length) agent++;
    }
  }
  const rp = rejectedProposals(text);
  for (const e of rp.errors) findings.push({ rule: "rejected-proposal", line: e.line, message: e.message });
  if (list.length && agent + rp.items.length < minAgent) findings.push({ rule: "min-proposals", line: 0, message: `the agent proposes at least ${minAgent} risks the user did not state (accepted: \`source: agent accepted by user\`; rejected: under \`## Rejected proposals\`); found ${agent} accepted and ${rp.items.length} rejected` });
  return { findings, proposals: { accepted: agent, rejected: rp.items.length }, count: list.length };
}

function main(argv) {
  const c = cli(argv, "check-premortem.mjs <PREMORTEM.md|slug> [--json] [--root DIR]", ["--root"]);
  if (!c) return 2;
  const file = resolveDoc(c.args[0], "PREMORTEM.md", c.root), text = read(file);
  if (text === null) { console.error(`cannot read ${file}`); return 2; }
  const r = checkPremortem(text);
  return report(file, r.findings, { count: r.count, proposals: r.proposals }, c.flags["--json"]);
}
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
