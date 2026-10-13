#!/usr/bin/env node
// Parses one specialist result (D12 header + findings table + BLOCKED_REASON / QUESTIONS) and prints a
// compact JSON summary, so the lead never reads a raw result. Mirrors the syntactic rules of
// `agent.sh record` (.agents/PROTOCOL.md); it does NOT check the fingerprint against the tree, the
// artifact hash or gate preconditions, and it records nothing: `agent.sh pipeline` stays the truth.
// Usage: node <skill-dir>/scripts/check-result.mjs <result-file|-> [--role ROLE] [--task ID]
// Exit codes: 0 valid (JSON on stdout), 1 malformed (one message per line on stdout), 2 usage or read error.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HEADER_KEYS = ["ROLE", "TASK", "FOCUS", "RESULT", "CONFIDENCE", "FINGERPRINT", "ARTIFACT"];
export const ROLES = ["lead", "task_author", "explorer", "architect", "data_architect", "designer", "qa", "implementer", "reviewer", "security_reviewer", "verifier"];
export const ALIASES = { full_lifecycle: "lead", implementation_worker: "implementer", independent_reviewer: "reviewer", independent_qa: "qa", independent_verifier: "verifier" };
const GATE_ROLES = ["reviewer", "security_reviewer", "qa", "verifier"];
const FOCUS_GATE = { plan: "REVIEW_PLAN", rules: "REVIEW_RULES", tests: "REVIEW_TESTS", data: "REVIEW_DATA", "rules+tests": "REVIEW_SMALL" };

export const canonRole = (r) => ALIASES[r] ?? r;

export function gateOf(role, focus) {
  if (role === "reviewer") return FOCUS_GATE[focus] ?? null;
  return { security_reviewer: "SECURITY", qa: "QA", verifier: "VERIFY" }[role] ?? null;
}

// Leading blank lines skipped; header = consecutive `KEY:` lines; the first other line ends it.
export function parseHeader(lines) {
  const header = {};
  let i = 0;
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  for (; i < lines.length; i++) {
    const m = /^([A-Z_]+):\s*(.*?)\s*$/.exec(lines[i]);
    if (!m) break;
    if (!HEADER_KEYS.includes(m[1])) return { error: `malformed header: unknown key ${m[1]}` };
    if (m[1] in header) return { error: `malformed header: duplicate key ${m[1]}` };
    header[m[1]] = m[2];
  }
  return { header };
}

// Table rows except the header and separator rows, as [id, severity, path, finding, evidence] or "MALFORMED".
export function parseFindings(lines) {
  const rows = [];
  for (const l of lines) {
    if (!l.startsWith("|")) continue;
    if (/^\|[-:| ]+\|?\s*$/.test(l)) continue;
    const cells = l.split("|");
    const id = (cells[1] ?? "").trim();
    if (id === "id" || id === "") continue;
    if (cells.length < 7) { rows.push("MALFORMED"); continue; }
    rows.push(cells.slice(1, 6).map((c) => c.trim()));
  }
  return rows;
}

const pathOf = (p) => {
  const s = p.replace(/:.*$/, "").trim();
  return s === "" || s === "-" ? "*" : s;
};

export function check(text, { role: wantRole, task: wantTask } = {}) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const { header: h, error } = parseHeader(lines);
  if (error) return { errors: [error] };
  for (const k of ["ROLE", "TASK", "RESULT", "CONFIDENCE", "FINGERPRINT", "ARTIFACT"]) {
    if (!h[k]) return { errors: [`malformed header: missing ${k}`] };
  }
  const errors = [];
  const role = canonRole(h.ROLE);
  if (!ROLES.includes(role)) return { errors: [`unknown ROLE: ${h.ROLE}`] };
  if (wantRole && canonRole(wantRole) !== role) errors.push(`ROLE ${role} does not match the expected role ${canonRole(wantRole)}`);
  if (wantTask && h.TASK !== wantTask) errors.push(`TASK ${h.TASK} does not match ${wantTask}`);
  if (!["high", "medium", "low"].includes(h.CONFIDENCE)) errors.push(`invalid CONFIDENCE: ${h.CONFIDENCE}`);

  const res = h.RESULT;
  const gateRole = GATE_ROLES.includes(role);
  let kind = null;
  if (res === "PASS" || res === "FAIL") kind = gateRole ? "gate" : null;
  else if (res === "BLOCKED") kind = gateRole && role !== "qa" ? "gate" : "task";
  else if (res === "DONE" || res === "NEEDS_INPUT") kind = ["reviewer", "security_reviewer", "verifier"].includes(role) ? null : "task";
  if (!kind) return { errors: [...errors, `RESULT ${res} is not valid for role ${role}`] };

  let gate = null;
  if (kind === "gate") {
    if (role === "reviewer" && !FOCUS_GATE[h.FOCUS]) return { errors: [...errors, "reviewer results need FOCUS plan|rules|tests|data|rules+tests"] };
    gate = gateOf(role, h.FOCUS);
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(h.FINGERPRINT)) errors.push(`FINGERPRINT is not a git tree id: ${h.FINGERPRINT}`);
  const sp = h.ARTIFACT.lastIndexOf(" ");
  const artPath = sp > 0 ? h.ARTIFACT.slice(0, sp).trim() : "";
  const artSha = sp > 0 ? h.ARTIFACT.slice(sp + 1) : "";
  if (!artPath) errors.push("ARTIFACT needs '<run-relative path> <sha256>'");
  else if (artPath.startsWith("/") || artPath.includes("..")) errors.push(`ARTIFACT path must be run-relative: ${artPath}`);
  if (artPath && !/^[0-9a-f]{64}$/.test(artSha)) errors.push(`ARTIFACT sha256 is not 64 hex characters: ${artSha}`);

  const rows = parseFindings(lines);
  if (rows.includes("MALFORMED")) return { errors: [...errors, "malformed findings row (want | id | severity | path:line | finding | evidence |)"] };
  const prefix = gate ?? role;
  const idRe = new RegExp(`^${prefix}-[0-9]+$`);
  for (const [id, sev] of rows) {
    if (!idRe.test(id)) { errors.push(`invalid finding id ${id} (want ${prefix}-<n>)`); break; }
    if (sev !== "blocking" && sev !== "info") { errors.push(`invalid finding severity ${sev} (want blocking|info)`); break; }
  }
  const ids = rows.map((r) => r[0]);
  if (new Set(ids).size !== ids.length) errors.push("duplicate finding ids");
  const blocking = rows.filter((r) => r[1] !== "info");
  if (res === "FAIL" && blocking.length === 0) errors.push("FAIL needs at least one blocking finding");
  if (res === "PASS" && blocking.length > 0) errors.push("PASS cannot carry blocking findings");

  const reason = lines.map((l) => /^BLOCKED_REASON:\s*(\S.*)$/.exec(l)).find(Boolean);
  if (res === "BLOCKED" && !reason) errors.push("BLOCKED needs a BLOCKED_REASON line");
  const q = lines.findIndex((l) => /^QUESTIONS:\s*$/.test(l));
  const qLines = [];
  if (q !== -1) for (const l of lines.slice(q + 1)) { if (/^BLOCKED_REASON:/.test(l)) break; qLines.push(l); }
  if (res === "NEEDS_INPUT" && !qLines.some((l) => /\S/.test(l))) errors.push("NEEDS_INPUT needs a QUESTIONS: block");
  if (errors.length) return { errors };

  return {
    errors: [],
    summary: {
      role, task: h.TASK, kind, gate, focus: h.FOCUS ?? null, result: res, confidence: h.CONFIDENCE,
      pass_low: res === "PASS" && h.CONFIDENCE === "low",
      counts: kind === "gate" && res === "PASS" && h.CONFIDENCE !== "low",
      fingerprint: h.FINGERPRINT, artifact: { path: artPath, sha256: artSha },
      blocking: blocking.map((r) => r[0]),
      fix_scope: res === "FAIL" ? [...new Set(blocking.map((r) => pathOf(r[2])))].sort() : [],
      info_count: rows.length - blocking.length,
      blocked_reason: reason ? reason[1].trim() : null,
      questions: qLines.filter((l) => /^\d+\.\s/.test(l)).length,
    },
  };
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? "";
  };
  const role = opt("--role");
  const task = opt("--task");
  if (args.length !== 1 || role === "" || task === "") { console.error("usage: check-result.mjs <result-file|-> [--role ROLE] [--task ID]"); return 2; }
  let text;
  try { text = readFileSync(args[0] === "-" ? 0 : args[0], "utf8"); } catch (e) { console.error(`error: ${e.message}`); return 2; }
  const { errors, summary } = check(text, { role, task });
  if (errors.length) { for (const e of errors) console.log(e); return 1; }
  console.log(JSON.stringify(summary));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv);
