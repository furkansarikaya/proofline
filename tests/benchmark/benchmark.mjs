#!/usr/bin/env node
// Benchmark report (A90). Scores RECORDED outputs against the known answers of the existing fixtures
// (fixtures/*/EXPECTED.md) and, when given, tests/e2e run directories. It makes no model call, writes
// nothing into the repository, and invents no scenario: a fixture whose EXPECTED has no parseable items
// is reported as "not measurable".
//
//   node tests/benchmark/benchmark.mjs [--fixtures DIR] [--verdicts FILE] [--e2e-dir DIR]...
//                                      [--run-validators] [--out DIR]
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

// --- known answers -------------------------------------------------------------------------------------------
// A section heading decides whether its items are expected findings or traps (decoys, MUST NOT). Items are
// numbered lines, table rows whose first cell is an id (E1, L1, X1), or bullets starting with a bold id (**P1**).
// Anything else (prose, a table keyed by `#` only) is not an item; nothing is guessed.
const TRAP = /must not|decoy|never asked|forbidden/i;
const EXPECT = /\bmust\b|process expectations|required scope/i;
// A94 fallback: a file with no id-keyed items but with a planted-facts, traps, must-hold or known-answers
// heading (contract-proof, impact-map, insights, migration-validation) is read structurally: table rows
// and bullets of its sections, plus bullets after a "Traps ...:" lead-in, become items with positional ids
// (F1.. expected, T1.. traps). Prose is never an item; the scenario/setup sections are skipped.
const FALLBACK_SIGNAL = /^#{1,4}\s+.*\b(traps?|planted facts?|must hold|known answers)\b/im;
const META_SECTION = /^(scenario|setup|overview|background|build|how to run|running)\b/i;
function parseStructured(md) {
  const items = [];
  let section = "", inFence = false, trapLead = false, expectTable = false, headerSeen = false;
  const push = (kind, text) => {
    const n = items.filter((i) => i.kind === kind).length + 1;
    items.push({ id: `${kind === "trap" ? "T" : "F"}${n}`, kind, text: text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 120) });
  };
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) { section = h[2]; trapLead = false; headerSeen = false; expectTable = false; continue; }
    if (!section || META_SECTION.test(section)) continue;
    const sectionTrap = TRAP.test(section) || /\btraps?\b/i.test(section);
    if (/^\s*$/.test(line)) { headerSeen = false; expectTable = false; continue; }
    if (/^\|/.test(line)) {
      if (/^\|[-:| ]+\|?\s*$/.test(line)) { expectTable = true; continue; }
      if (!expectTable) { headerSeen = true; continue; }
      const cell = (line.split("|")[1] ?? "").trim();
      if (cell) push(sectionTrap || trapLead ? "trap" : "expect", line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" | "));
      continue;
    }
    if (/^(?:\*\*)?traps?\b[^:]*:\s*$/i.test(line)) { trapLead = true; continue; }
    const t = /^\s*(?:\*\*)?traps?\b[^:]*:\s*(\S.*)$/i.exec(line);
    if (t && !/^\s*[-*]\s/.test(line)) { push("trap", t[1]); continue; }
    const b = /^(?:[-*])\s+(.*)/.exec(line);
    if (b) {
      const trapBullet = /^(?:\*\*)?traps?\b[^:]*:/i.test(b[1]);
      push(sectionTrap || trapLead || trapBullet ? "trap" : "expect", b[1].replace(/^(?:\*\*)?traps?\b[^:]*:\s*/i, ""));
    }
  }
  return items;
}
export function parseExpected(md) {
  const items = parseIdKeyed(md);
  return items.length === 0 && FALLBACK_SIGNAL.test(md) ? parseStructured(md) : items;
}
function parseIdKeyed(md) {
  const items = [];
  const seen = new Set();
  let kind = null;
  for (const line of md.split("\n")) {
    const h = /^#{2,4}\s+(.*)/.exec(line);
    if (h) { kind = TRAP.test(h[1]) ? "trap" : EXPECT.test(h[1]) ? "expect" : null; continue; }
    if (!kind) continue;
    const m = /^\|\s*([A-Za-z]{1,3}-?\d+)\s*\|\s*(.+?)\s*\|/.exec(line) || /^(\d+)\.\s+(.*)/.exec(line)
      || /^-\s+\*\*([A-Za-z]{1,3}-?\d+)\*\*\s*(.*)/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    items.push({ id: m[1], kind, text: m[2].replace(/\s+/g, " ").slice(0, 120) });
  }
  return items;
}

// --- scope ---------------------------------------------------------------------------------------------------
const inPlan = (p, planned) => planned.some((s) => p === s || (s.endsWith("/") && p.startsWith(s)));
export function scopeOf(planned, changed) {
  if (!Array.isArray(planned) || !Array.isArray(changed)) return null;
  const out = changed.filter((p) => !inPlan(p, planned));
  return { planned: planned.length, changed: changed.length, out_of_scope: out, adherence: changed.length ? 1 - out.length / changed.length : null };
}

// --- fixtures ------------------------------------------------------------------------------------------------
export function scoreFixture(name, items, v) {
  const r = { skill: name, expected: items.filter((i) => i.kind === "expect").length, traps: items.filter((i) => i.kind === "trap").length };
  if (r.expected + r.traps === 0) return { ...r, status: "not measurable", reason: "EXPECTED.md has no parseable expected-findings" };
  if (!v || !["found", "tripped", "extra"].some((k) => k in v)) return { ...r, status: "not scored", reason: "no verdict recorded" };
  // The verdict file is trusted input; it must at least name who judged or give evidence for every found id.
  const ev = v.evidence || {};
  if (!(typeof v.evaluator === "string" && v.evaluator.trim()) && !(v.found || []).every((id) => typeof ev[id] === "string" && ev[id].trim()))
    throw new Error(`${name}: verdict needs an "evaluator" string or a non-empty "evidence" entry for every found id`);
  const kindOf = new Map(items.map((i) => [i.id, i.kind]));
  const found = v.found || [], tripped = v.tripped || [], extra = v.extra || [];
  for (const id of found) if (kindOf.get(id) !== "expect") throw new Error(`${name}: found id ${id} is not an expected finding of EXPECTED.md`);
  for (const id of tripped) if (kindOf.get(id) !== "trap") throw new Error(`${name}: tripped id ${id} is not a trap of EXPECTED.md`);
  const f = new Set(found), t = new Set(tripped);
  const missed = items.filter((i) => i.kind === "expect" && !f.has(i.id)).map((i) => i.id);
  return {
    ...r, status: "measured", found: f.size, missed: missed.length, missed_ids: missed,
    false_positives: t.size + extra.length, tripped_ids: [...t], extra,
    scope: scopeOf(v.planned_scope, v.changed_paths),
    duration_s: Number.isFinite(v.duration_s) ? v.duration_s : null,
    tokens_total: Number.isFinite(v.tokens_total) ? v.tokens_total : null,
  };
}

function runValidators(fixturesDir, name) {
  const dir = join(fixturesDir, name);
  const res = { selfcheck: "none", skill_tests: "none" };
  const setup = join(dir, "setup.sh");
  if (existsSync(setup)) {
    const work = mkdtempSync(join(tmpdir(), "benchmark-"));
    const sh = /bash/.test(readFileSync(setup, "utf8").split("\n")[0]) ? "bash" : "sh";
    const target = join(work, name);
    let r = spawnSync(sh, [setup, target], { encoding: "utf8", timeout: 600000 });
    if (r.status !== 0) res.selfcheck = "setup-failed";
    else if (existsSync(join(dir, "selfcheck.sh"))) {
      r = spawnSync("sh", [join(dir, "selfcheck.sh"), target], { encoding: "utf8", timeout: 600000 });
      res.selfcheck = r.status === 0 ? "pass" : "fail";
    }
    rmSync(work, { recursive: true, force: true });
  }
  const t = join(repo, "tests/skills", `${name}.test.mjs`);
  if (existsSync(t)) res.skill_tests = spawnSync(process.execPath, ["--test", t], { encoding: "utf8", timeout: 300000 }).status === 0 ? "pass" : "fail";
  return res;
}

// --- e2e run directories ---------------------------------------------------------------------------------------
const num = (s) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
function planScope(outDir) {
  const runs = join(outDir, "runs");
  const paths = [];
  if (!existsSync(runs)) return null;
  for (const id of readdirSync(runs)) {
    const p = join(runs, id, "PLAN.md");
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8").split("\n");
    if (text[0] !== "---") continue;
    let inScope = false;
    for (const l of text.slice(1)) {
      if (l === "---") break;
      if (l === "scope:") { inScope = true; continue; }
      if (inScope && /^\S/.test(l)) inScope = false;
      const m = inScope && /^\s*-\s+path:\s*"?([^"\s]+)"?/.exec(l);
      if (m) paths.push(m[1]);
    }
  }
  return paths;
}
function changedPaths(outDir) {
  const set = new Set();
  for (const f of ["git-diff-main-head.patch", "git-diff-working.patch", "git-diff-staged.patch"]) {
    const p = join(outDir, f);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) set.add(m[2]);
  }
  const u = join(outDir, "git-untracked.txt");
  if (existsSync(u)) for (const l of readFileSync(u, "utf8").split("\n")) if (l) set.add(l);
  return [...set].filter((p) => !/^\.(agents|claude|codex)\//.test(p)).sort();
}
function metricsOf(outDir) {
  const f = join(outDir, "metrics/records.jsonl");
  if (!existsSync(f)) return { duration_s: null, tokens_total: null, records: 0, records_without_tokens: 0 };
  const recs = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const disp = recs.filter((r) => r.kind === "dispatch");
  const run = recs.find((r) => r.kind === "run");
  const withTok = disp.filter((r) => Number.isFinite(r.tokens_total));
  return {
    duration_s: run && Number.isFinite(run.duration_s) ? run.duration_s : null,
    tokens_total: withTok.length ? withTok.reduce((a, r) => a + r.tokens_total, 0) : null,
    records: recs.length, records_without_tokens: disp.length - withTok.length,
  };
}
export function scoreE2e(runDir) {
  const out = existsSync(join(runDir, "out/summary.txt")) ? join(runDir, "out") : runDir;
  const kv = Object.fromEntries(readFileSync(join(out, "summary.txt"), "utf8").split("\n").map((l) => l.split(/=(.*)/s)).filter((p) => p.length > 1));
  const lead = Object.keys(kv).filter((k) => /^lead_\d+_duration$/.test(k)).map((k) => num(kv[k])).filter((n) => n !== null);
  const r = { run: runDir, scenario: kv.scenario || null, config: kv.config || null };
  const ev = [join(out, "evaluation.md"), join(dirname(out), "evaluation.md")].find(existsSync);
  const m = metricsOf(out);
  Object.assign(r, { duration_s: m.duration_s ?? (lead.length ? lead.reduce((a, b) => a + b, 0) : null), tokens_total: m.tokens_total, metrics_records: m.records, records_without_tokens: m.records_without_tokens });
  const planned = planScope(out);
  r.scope = planned ? scopeOf(planned, changedPaths(out)) : null;
  if (!ev) return { ...r, status: "not scored", reason: "no evaluation.md (the evaluator's table) next to out/" };
  const text = readFileSync(ev, "utf8");
  const rows = [...text.matchAll(/^\|\s*([A-Za-z]{1,3}-?\d+)\s*\|\s*(met|unmet|not-applicable)\s*\|/gim)];
  const missed = rows.filter((x) => x[2].toLowerCase() === "unmet").map((x) => x[1]);
  const verdict = /^E2E:\s*(PASS|FAIL)\b/m.exec(text);
  return {
    ...r, status: "measured", verdict: verdict ? verdict[1] : null,
    found: rows.filter((x) => x[2].toLowerCase() === "met").length, missed: missed.length, missed_ids: missed,
    not_applicable: rows.filter((x) => x[2].toLowerCase() === "not-applicable").length,
    false_positives: null, // e2e expectations are requirements: a tripped trap shows as an unmet item above
  };
}
function e2eRuns(dir) {
  const isRun = (d) => existsSync(join(d, "summary.txt")) || existsSync(join(d, "out/summary.txt"));
  if (isRun(dir)) return [dir];
  return readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory() && isRun(p)).sort();
}

// --- report --------------------------------------------------------------------------------------------------
const cell = (v) => (v === null || v === undefined ? "n/a" : String(v));
const pct = (s) => (s && s.adherence !== null ? `${Math.round(s.adherence * 100)}% (${s.out_of_scope.length} out)` : "n/a");
export function toMarkdown(rep) {
  const L = ["# Benchmark report", "", `Schema ${rep.schema}. Scores recorded outputs of existing fixtures only; no model call.`, ""];
  L.push("## Fixtures (per skill)", "", "| skill | status | expected | traps | found | missed | false positives | scope adherence | duration s | tokens | selfcheck | skill tests |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const f of rep.fixtures) {
    L.push(`| ${f.skill} | ${f.status} | ${f.expected} | ${f.traps} | ${cell(f.found)} | ${cell(f.missed)} | ${cell(f.false_positives)} | ${pct(f.scope)} | ${cell(f.duration_s)} | ${cell(f.tokens_total)} | ${cell(f.selfcheck)} | ${cell(f.skill_tests)} |`);
  }
  const t = rep.totals;
  L.push(`| **total** | ${t.measured} measured, ${t.not_scored} not scored, ${t.not_measurable} not measurable | ${t.expected} | | ${t.found} | ${t.missed} | ${t.false_positives} | | | | | |`, "");
  const detail = rep.fixtures.filter((f) => f.status === "measured" && (f.missed || f.false_positives || (f.scope && f.scope.out_of_scope.length)));
  if (detail.length) {
    L.push("### Misses, false positives and out-of-scope changes", "");
    for (const f of detail) {
      if (f.missed) L.push(`- ${f.skill}: missed ${f.missed_ids.join(", ")}`);
      if (f.tripped_ids.length) L.push(`- ${f.skill}: trap tripped ${f.tripped_ids.join(", ")}`);
      for (const e of f.extra) L.push(`- ${f.skill}: extra finding "${e}"`);
      if (f.scope && f.scope.out_of_scope.length) L.push(`- ${f.skill}: out of scope ${f.scope.out_of_scope.join(", ")}`);
    }
    L.push("");
  }
  const nm = rep.fixtures.filter((f) => f.status === "not measurable");
  if (nm.length) L.push(`Not measurable (no parseable expected-findings): ${nm.map((f) => f.skill).join(", ")}`, "");
  if (rep.e2e.length) {
    L.push("## End-to-end runs", "", "| scenario | config | status | verdict | met | unmet | scope adherence | duration s | tokens | run |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const e of rep.e2e) {
      L.push(`| ${cell(e.scenario)} | ${cell(e.config)} | ${e.status} | ${cell(e.verdict)} | ${cell(e.found)} | ${cell(e.missed)}${e.missed ? ` (${e.missed_ids.join(", ")})` : ""} | ${pct(e.scope)} | ${cell(e.duration_s)} | ${cell(e.tokens_total)} | ${e.run} |`);
    }
    L.push("", "Tokens are what the runtime reported (n/a when none; never estimated). Unmet e2e items are counted as missed; a tripped trap appears as an unmet item.", "");
  }
  return L.join("\n");
}

export function build({ fixturesDir = join(repo, "fixtures"), verdicts = {}, e2eDirs = [], validators = false } = {}) {
  const fx = [];
  for (const name of readdirSync(fixturesDir).sort()) {
    const exp = join(fixturesDir, name, "EXPECTED.md");
    if (!existsSync(exp)) continue;
    const row = scoreFixture(name, parseExpected(readFileSync(exp, "utf8")), verdicts[name]);
    if (validators) Object.assign(row, runValidators(fixturesDir, name));
    fx.push(row);
  }
  for (const k of Object.keys(verdicts)) if (!fx.some((f) => f.skill === k)) throw new Error(`verdict for unknown fixture ${k}`);
  const m = fx.filter((f) => f.status === "measured");
  const sum = (k) => m.reduce((a, f) => a + f[k], 0);
  return {
    schema: "proofline.benchmark/1", fixtures: fx,
    e2e: e2eDirs.flatMap(e2eRuns).map(scoreE2e),
    totals: {
      measured: m.length, not_scored: fx.filter((f) => f.status === "not scored").length, not_measurable: fx.filter((f) => f.status === "not measurable").length,
      expected: sum("expected"), found: sum("found"), missed: sum("missed"), false_positives: sum("false_positives"),
      validators_failed: fx.filter((f) => ["fail", "setup-failed"].includes(f.selfcheck) || f.skill_tests === "fail").length,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = { e2eDirs: [] };
  let outDir = null;
  try {
    for (let i = 0; i < a.length; i++) {
      const need = () => { if (i + 1 >= a.length) throw new Error(`${a[i]} needs a value`); return a[++i]; };
      if (a[i] === "--fixtures") opt.fixturesDir = resolve(need());
      else if (a[i] === "--verdicts") opt.verdicts = JSON.parse(readFileSync(need(), "utf8"));
      else if (a[i] === "--e2e-dir") opt.e2eDirs.push(resolve(need()));
      else if (a[i] === "--run-validators") opt.validators = true;
      else if (a[i] === "--out") outDir = resolve(need());
      else throw new Error(`unknown argument ${a[i]}`);
    }
    const rep = build(opt), md = toMarkdown(rep);
    if (outDir) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "benchmark.md"), md + "\n");
      writeFileSync(join(outDir, "benchmark.json"), JSON.stringify(rep, null, 2) + "\n");
      if (rep.totals.validators_failed) console.error(`benchmark: WARNING ${rep.totals.validators_failed} fixture validator(s) not passing (non-gating; see the selfcheck and skill tests columns)`);
      console.log(`benchmark: ${rep.totals.measured} measured, ${rep.totals.not_measurable} not measurable; wrote ${join(outDir, "benchmark.md")} and benchmark.json`);
    } else console.log(md);
  } catch (e) {
    console.error(`benchmark: ${e.message}`);
    process.exit(2);
  }
}
