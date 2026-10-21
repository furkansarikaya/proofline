#!/usr/bin/env node
// PROBES.md check and threshold lock. A probe is an item with indented fields:
//   - PB-1 <what is done, who>, tests AS-1.
//     success: <what counts as confirmed>
//     failure: <what counts as refuted>
//     locked: <ISO timestamp> sha256:<hash>        written by --lock, before the probe runs
//     result: confirmed|refuted|inconclusive       only after the lock
// The hash covers the normalised success and failure text (whitespace collapsed, lower case), so a threshold moved
// after the result is rejected. When the file is tracked in git and an earlier committed version carries the lock of a
// probe, the current threshold hash must equal the committed lock hash.
//   node check-probes.mjs <PROBES.md|slug> [--json] [--root DIR]           exit 0 clean, 1 findings, 2 usage
//   node check-probes.mjs <PROBES.md|slug> --lock PB-n [--root DIR]        writes the lock line; exit 0, 1 refused, 2 usage
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { cli, field, git, isMain, items, read, report, resolveDoc, sha256 } from "./lib.mjs";

export const RESULTS = ["confirmed", "refuted", "inconclusive"];
const KEYS = ["success", "failure", "locked", "result"];
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
export const thresholdHash = (success, failure) => sha256(`success: ${norm(success)}\nfailure: ${norm(failure)}`);
const LOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+sha256:([0-9a-f]{64})$/i;

function parse(text) {
  return items(text, "PB").map((it) => {
    const success = field(it, "success", KEYS), failure = field(it, "failure", KEYS);
    return { it, success, failure, locked: field(it, "locked", KEYS), result: field(it, "result", KEYS)?.toLowerCase() ?? null,
      hash: success && failure ? thresholdHash(success, failure) : null };
  });
}

// The lock hash of each probe in the earliest committed version that has one: Map id -> hash.
function committedLocks(file) {
  const dir = dirname(file), name = basename(file), out = new Map();
  if (git(dir, ["ls-files", "--error-unmatch", name]) === null) return out;
  const revs = (git(dir, ["log", "--reverse", "--format=%H", "--", name]) || "").split("\n").filter(Boolean);
  for (const rev of revs) {
    const old = git(dir, ["show", `${rev}:./${name}`]);
    if (old === null) continue;
    for (const p of parse(old)) {
      const m = p.locked && LOCK.exec(p.locked);
      if (m && !out.has(p.it.id)) out.set(p.it.id, m[2].toLowerCase());
    }
  }
  return out;
}

export function checkProbes(text, opts = {}) {
  const findings = [], seen = new Set(), probes = parse(text);
  const committed = opts.file ? committedLocks(opts.file) : new Map();
  if (!probes.length) findings.push({ rule: "no-probe", line: 0, message: "no `- PB-n` line" });
  for (const p of probes) {
    const { it } = p, add = (rule, message) => findings.push({ rule, line: it.line, id: it.id, message });
    if (seen.has(it.id)) add("duplicate-id", `${it.id} is defined twice`);
    seen.add(it.id);
    if (!/(?<![A-Za-z0-9-])AS-\d+/.test(it.lines.join(" "))) add("no-assumption", "the probe names no AS-n it tests");
    if (!p.success) add("threshold", "success: threshold is missing");
    if (!p.failure) add("threshold", "failure: threshold is missing");
    if (p.result !== null && !RESULTS.includes(p.result)) add("result-enum", `result "${p.result}" is not one of ${RESULTS.join("|")}`);
    const m = p.locked ? LOCK.exec(p.locked) : null;
    if (p.locked && !m) add("lock-format", "locked: needs `<ISO timestamp> sha256:<64 hex>` (write it with --lock)");
    if (p.result !== null && !p.locked) add("no-lock", `${it.id} has a result but no lock; run --lock ${it.id} before the probe runs`);
    if (m && p.hash && m[2].toLowerCase() !== p.hash) add("threshold-changed", `the success or failure text no longer matches the lock (locked ${m[2].slice(0, 12)}, now ${p.hash.slice(0, 12)})`);
    const was = committed.get(it.id);
    if (was && p.hash && was !== p.hash) add("threshold-changed-since-commit", `the thresholds differ from the committed lock (${was.slice(0, 12)}, now ${p.hash.slice(0, 12)})`);
    if (was && m && was !== m[2].toLowerCase()) add("lock-changed-since-commit", "the lock line differs from the committed lock");
  }
  return { findings, count: probes.length };
}

// Writes `locked:` after the probe's last line. Refuses a probe that is locked, has a result or lacks a threshold.
export function lockProbe(file, id) {
  const text = readFileSync(file, "utf8"), p = parse(text).find((x) => x.it.id === id);
  if (!p) return { ok: false, error: `${id} is not in ${file}` };
  if (p.locked) return { ok: false, error: `${id} is already locked` };
  if (p.result) return { ok: false, error: `${id} already has a result; a lock after the result proves nothing` };
  if (!p.success || !p.failure) return { ok: false, error: `${id} needs both success: and failure: before it can be locked` };
  const lines = text.split("\n"), at = p.it.line - 1 + p.it.lines.length;
  const line = `  locked: ${new Date().toISOString()} sha256:${p.hash}`;
  lines.splice(at, 0, line);
  writeFileSync(file, lines.join("\n"));
  return { ok: true, line: line.trim() };
}

function main(argv) {
  const c = cli(argv, "check-probes.mjs <PROBES.md|slug> [--lock PB-n] [--json] [--root DIR]", ["--root", "--lock"]);
  if (!c) return 2;
  const file = resolveDoc(c.args[0], "PROBES.md", c.root), text = read(file);
  if (text === null) { console.error(`cannot read ${file}`); return 2; }
  if (c.flags["--lock"]) {
    const r = lockProbe(file, c.flags["--lock"]);
    if (!r.ok) { console.error(`refused: ${r.error}`); return 1; }
    console.log(r.line);
    return 0;
  }
  const r = checkProbes(text, { file });
  return report(file, r.findings, { count: r.count }, c.flags["--json"]);
}
if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
