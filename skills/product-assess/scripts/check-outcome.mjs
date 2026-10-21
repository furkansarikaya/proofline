#!/usr/bin/env node
// OUTCOME.md check: what happened after the build, tied to a measured number. An outcome is an item with fields:
//   - OC-1 <what was measured>, follows DEC-1 and FR-1.     (names a DEC-n, a PB-n or a requirement id)
//     metric: M-1                                           an id of the slug's PRD.md
//     baseline: 12 per week
//     target: >= 40                                         >=, <=, >, < or = and a number
//     script: scripts/adoption.mjs sha256:<hex>             path from the project root, hash of the script
//     output: outcome/OC-1.out sha256:<hex>                 path from the slug folder, hash of the saved output
//     value: 47                                             must equal the `value:` line (else the last line) of the output
//     result: reached|not-reached|inconclusive              reached/not-reached must follow from value and target
//     follow-up: continue|change|drop
// --rerun runs each script (timeout, default 60 s) and compares the sha256 of its output with the recorded one.
//   node check-outcome.mjs <OUTCOME.md|slug> [--rerun] [--timeout SEC] [--json] [--root DIR]   exit 0 clean, 1 findings, 2 usage
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, resolve, sep } from "node:path";
import { cli, field, isMain, items, read, report, resolveDoc, sha256 } from "./lib.mjs";

export const RESULTS = ["reached", "not-reached", "inconclusive"];
export const FOLLOW_UPS = ["continue", "change", "drop"];
const KEYS = ["metric", "baseline", "target", "script", "output", "value", "result", "follow-up"];
const PATH_HASH = /^(\S+)\s+sha256:([0-9a-f]{64})$/i;
const num = (s) => (s !== null && s !== undefined && /^-?\d+(?:\.\d+)?$/.test(String(s).trim()) ? Number(s) : null);

// The number or text the output file records: its `value:` line, else its last non-empty line.
export function outputValue(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const v = lines.map((l) => /^value:\s*(.+)$/i.exec(l)?.[1]).filter(Boolean);
  return (v.length ? v[v.length - 1] : lines[lines.length - 1] ?? "").trim();
}
const same = (a, b) => (num(a) !== null && num(b) !== null ? num(a) === num(b) : String(a).trim() === String(b).trim());

export function meets(value, target) {
  const t = /^(>=|<=|>|<|=)\s*(-?\d+(?:\.\d+)?)\b/.exec(target || ""), v = num(value);
  if (!t || v === null) return null;
  const n = Number(t[2]);
  return { ">=": v >= n, "<=": v <= n, ">": v > n, "<": v < n, "=": v === n }[t[1]];
}

function runScript(root, rel, timeoutSec) {
  const file = resolve(root, rel), ext = extname(file);
  const cmd = ext === ".mjs" || ext === ".js" ? [process.execPath, [file]] : ext === ".sh" ? ["sh", [file]] : ext === ".py" ? ["python3", [file]] : [file, []];
  const r = spawnSync(cmd[0], cmd[1], { cwd: root, encoding: "utf8", timeout: timeoutSec * 1000 });
  if (r.error) return { error: r.error.code === "ETIMEDOUT" ? `timed out after ${timeoutSec} s` : r.error.message };
  if (r.status !== 0) return { error: `exited with status ${r.status}` };
  return { stdout: r.stdout };
}

export function checkOutcome(text, opts) {
  const { root, dir, rerun = false, timeout = 60 } = opts, findings = [], seen = new Set(), list = items(text, "OC");
  const prd = read(join(dir, "PRD.md")) || "";
  if (!list.length) findings.push({ rule: "no-outcome", line: 0, message: "no `- OC-n` line" });
  for (const it of list) {
    const add = (rule, message) => findings.push({ rule, line: it.line, id: it.id, message });
    if (seen.has(it.id)) add("duplicate-id", `${it.id} is defined twice`);
    seen.add(it.id);
    const joined = it.lines.join(" ");
    if (!/(?<![A-Za-z0-9-])(DEC|PB|FR|NFR)-\d+/.test(joined)) add("no-link", "the outcome names no DEC-n, PB-n, FR-n or NFR-n it follows");
    const f = Object.fromEntries(KEYS.map((k) => [k, field(it, k, KEYS)]));
    for (const k of ["baseline", "target"]) if (!f[k]) add("missing-field", `${k}: is missing`);
    const metric = f.metric && /^[A-Z]+-\d+$/.test(f.metric) ? f.metric : null;
    if (!metric) add("metric", "metric: needs an id of the PRD (for example M-1)");
    else if (!new RegExp(`^\\s*[-*|]?\\s*${metric}(?![0-9])`, "m").test(prd)) add("metric", `${metric} is not a metric of ${join(dir, "PRD.md")}`);
    const sc = f.script && PATH_HASH.exec(f.script), ou = f.output && PATH_HASH.exec(f.output);
    if (!sc) add("script", "script: needs `<path> sha256:<64 hex>`");
    if (!ou) add("output", "output: needs `outcome/<OC-n>.out sha256:<64 hex>`");
    if (ou && ou[1] !== `outcome/${it.id}.out`) add("output", `the output file must be outcome/${it.id}.out`);
    let scriptBad = false;
    if (sc) {
      const p = resolve(root, sc[1]);
      if (!p.startsWith(root + sep)) { add("script", "the script path leaves the project"); scriptBad = true; }
      else if (!existsSync(p)) add("script", `script ${sc[1]} does not exist`);
      else if (sha256(read(p) ?? "") !== sc[2].toLowerCase()) { add("script-hash", `script ${sc[1]} changed since it was recorded (hash differs)`); scriptBad = true; }
    }
    let out = null;
    if (ou) {
      const p = resolve(dir, ou[1]);
      if (!p.startsWith(resolve(dir) + sep)) add("output", "the output path leaves the slug folder");
      else if (!existsSync(p)) add("output-missing", `output file ${ou[1]} does not exist`);
      else {
        out = read(p) ?? "";
        if (sha256(out) !== ou[2].toLowerCase()) add("output-hash", `output file ${ou[1]} does not match its recorded hash`);
      }
    }
    if (f.value === null) add("missing-field", "value: is missing");
    else if (out !== null && !same(outputValue(out), f.value)) add("value-mismatch", `recorded value "${f.value}" is not the value in the output file ("${outputValue(out)}")`);
    if (!RESULTS.includes(f.result)) add("result-enum", `result "${f.result ?? ""}" is not one of ${RESULTS.join("|")}`);
    if (!FOLLOW_UPS.includes(f["follow-up"])) add("follow-up-enum", `follow-up "${f["follow-up"] ?? ""}" is not one of ${FOLLOW_UPS.join("|")}`);
    if ((f.result === "reached" || f.result === "not-reached") && f.value !== null && f.target) {
      const ok = meets(f.value, f.target);
      if (ok === null) add("target", `target "${f.target}" or value "${f.value}" cannot be compared (target: >=|<=|>|<|= and a number)`);
      else if (ok !== (f.result === "reached")) add("result-follows", `value ${f.value} against target ${f.target} is ${ok ? "reached" : "not-reached"}, not ${f.result}`);
    }
    if (rerun && sc && ou && !scriptBad && existsSync(resolve(root, sc[1]))) {
      const r = runScript(root, sc[1], timeout);
      if (r.error) add("rerun", `rerun of ${sc[1]} failed: ${r.error}`);
      else if (sha256(r.stdout) !== ou[2].toLowerCase()) add("rerun", `rerun of ${sc[1]} gives another output (hash ${sha256(r.stdout).slice(0, 12)}, recorded ${ou[2].slice(0, 12)})`);
    }
  }
  return { findings, count: list.length };
}

function main(argv) {
  const c = cli(argv, "check-outcome.mjs <OUTCOME.md|slug> [--rerun] [--timeout SEC] [--json] [--root DIR]", ["--root", "--timeout"]);
  if (!c) return 2;
  const file = resolveDoc(c.args[0], "OUTCOME.md", c.root), text = read(file);
  if (text === null) { console.error(`cannot read ${file}`); return 2; }
  const timeout = c.flags["--timeout"] ? Number(c.flags["--timeout"]) : 60;
  if (!(timeout > 0)) { console.error("usage: --timeout needs a positive number of seconds"); return 2; }
  const r = checkOutcome(text, { root: c.root, dir: dirname(file), rerun: !!c.flags["--rerun"], timeout });
  return report(file, r.findings, { count: r.count }, c.flags["--json"]);
}
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
