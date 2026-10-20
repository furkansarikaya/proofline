#!/bin/sh
# A162: run the entry-point detector over corpus.tsv with agent.sh (entry-tier) and with the node validators
# (entryTier of plan-contract and qa-plan) and print a precision/recall table for the mandatory tier.
# Exit 1 when a label is not met or the three detectors disagree. Usage: sh tests/fixtures/entry-points/run-corpus.sh
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd); repo=$(CDPATH='' cd "$here/../../.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.agents/scripts"; cp "$repo/control-plane/agents/scripts/agent.sh" "$tmp/.agents/scripts/"; cp "$repo/control-plane/agents/config.yaml" "$tmp/.agents/"
ENTRY_CORPUS=$here/corpus.tsv ENTRY_AGENT=$tmp/.agents/scripts/agent.sh REPO=$repo node --input-type=module -e '
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const e = process.env;
const P = await import(e.REPO + "/skills/plan-contract/scripts/validate-plan.mjs");
const Q = await import(e.REPO + "/skills/qa-plan/scripts/validate-qa.mjs");
const name = { mandatory: "M", information: "I", "": "N" };
let tp = 0, fp = 0, fn = 0, tn = 0, bad = 0, n = 0;
for (const line of readFileSync(e.ENTRY_CORPUS, "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [label, body] = line.split("\t"); n++;
  const sh = spawnSync("sh", [e.ENTRY_AGENT, "entry-tier", body], { encoding: "utf8" }).stdout.trim();
  const got = { mandatory: "M", information: "I", none: "N" }[sh];
  const js = name[P.entryTier(body)];
  const jq = name[Q.entryTier(body)];
  if (got !== js || got !== jq) { console.log("DISAGREE sh=" + got + " plan=" + js + " qa=" + jq + ": " + body); bad++; }
  if (got === "M" && label === "M") tp++; else if (got === "M") fp++; else if (label === "M") fn++; else tn++;
  if (got !== label) { console.log("LABEL " + label + " got " + got + ": " + body); bad++; }
}
const pr = tp / (tp + fp || 1), rc = tp / (tp + fn || 1);
console.log("bullets=" + n + " TP=" + tp + " FP=" + fp + " FN=" + fn + " TN=" + tn + " precision=" + pr.toFixed(2) + " recall=" + rc.toFixed(2));
process.exit(bad ? 1 : 0);
'
