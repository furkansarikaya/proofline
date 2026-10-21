#!/usr/bin/env node
// Validates an intent-grill INTENT.md (see ../references/INTENT-FORMAT.md): decision tree rows,
// who decided each branch, one decision per round row in dependency order, request quotes, and the
// derived acceptance-criteria and out-of-scope candidates. No dependencies.
// Usage: node <skill-dir>/scripts/validate-intent.mjs <INTENT.md>
// Exit codes: 0 valid, 1 invalid (one message per line), 2 usage or read error.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BRANCHES = ["scope", "behavior", "data", "ui", "failure", "non-goals"];
export const STATUSES = ["open", "resolved", "deferred"];
export const DECIDERS = ["request", "user", "lead"];
export const ANSWERERS = ["user", "lead"];
export const RUN_STATUSES = ["in-progress", "complete"];

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isSep = (c) => c.every((x) => /^:?-+:?$/.test(x));
const norm = (s) => s.replace(/\s+/g, " ").trim();

function sections(md) {
  const out = new Map();
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

function table(lines, header) {
  const rows = [];
  let seenHeader = false;
  const errors = [];
  for (const l of lines) {
    if (!/^\s*\|/.test(l)) continue;
    const c = cells(l);
    if (!seenHeader) {
      seenHeader = true;
      if (c.join("|") !== header.join("|")) errors.push(`table header must be | ${header.join(" | ")} |`);
      continue;
    }
    if (isSep(c)) continue;
    if (c.length !== header.length) { errors.push(`row "${l.trim()}" has ${c.length} cells, expected ${header.length}`); continue; }
    rows.push(Object.fromEntries(header.map((h, i) => [h, c[i]])));
  }
  return { rows, errors };
}

export const TREE_HEADER = ["id", "branch", "question", "depends_on", "status", "decision", "decided_by", "source"];
export const ROUNDS_HEADER = ["round", "asked", "answer", "answered_by"];

export function parse(md) {
  const secs = sections(md);
  const request = norm((secs.get("Request") || []).filter((l) => /^>/.test(l)).map((l) => l.replace(/^>\s?/, "")).join(" "));
  const status = ((secs.get("Status") || []).find((l) => l.trim()) || "").trim();
  const tree = table(secs.get("Decision tree") || [], TREE_HEADER);
  const rounds = table(secs.get("Rounds") || [], ROUNDS_HEADER);
  const candidates = (key) => (secs.get(key) || []).filter((l) => /^\s*-\s/.test(l)).map((l) => l.trim());
  return {
    title: (/^# Intent: (\S.*)$/m.exec(md) || [])[1] || null,
    secs, request, status, tree, rounds,
    acc: candidates("Acceptance criteria candidates"),
    oos: candidates("Out of scope candidates"),
  };
}

export function validate(md) {
  const errors = [];
  const d = parse(md);
  if (!d.title) errors.push('title: "# Intent: <TASK-ID or slug>" is missing');
  for (const s of ["Request", "Status", "Decision tree", "Rounds", "Acceptance criteria candidates", "Out of scope candidates"]) {
    if (!d.secs.has(s)) errors.push(`section "## ${s}" is missing`);
  }
  if (!d.request) errors.push("Request: the verbatim request must be quoted with '> ' lines");
  if (!RUN_STATUSES.includes(d.status)) errors.push(`Status: must be one of ${RUN_STATUSES.join("|")}`);
  errors.push(...d.tree.errors.map((e) => `Decision tree: ${e}`), ...d.rounds.errors.map((e) => `Rounds: ${e}`));

  const byId = new Map();
  for (const r of d.tree.rows) {
    const at = `Decision tree ${r.id}`;
    if (!/^D-\d+$/.test(r.id)) errors.push(`${at}: id must match D-<n>`);
    if (byId.has(r.id)) errors.push(`${at}: duplicate id`);
    byId.set(r.id, r);
    if (!BRANCHES.includes(r.branch)) errors.push(`${at}: branch must be one of ${BRANCHES.join("|")}`);
    if (!r.question) errors.push(`${at}: question is empty`);
    if (!STATUSES.includes(r.status)) errors.push(`${at}: status must be one of ${STATUSES.join("|")}`);
    r.deps = r.depends_on === "-" ? [] : r.depends_on.split(",").map((s) => s.trim()).filter(Boolean);
  }
  for (const r of d.tree.rows) for (const dep of r.deps) if (!byId.has(dep)) errors.push(`Decision tree ${r.id}: depends on unknown ${dep}`);
  // Cycle check: depth-first over depends_on.
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !byId.has(id)) return;
    if (state.get(id) === 1) { errors.push(`Decision tree: dependency cycle ${[...path, id].join(" -> ")}`); return; }
    state.set(id, 1);
    for (const dep of byId.get(id).deps) visit(dep, [...path, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);

  // Rounds: one decision per round row, numbered 1..n, each asked once, dependencies settled first. A message may carry up to 3 independent rows: only trailing rows may be unanswered, at most 3.
  const askedIn = new Map();
  d.rounds.rows.forEach((r, i) => {
    const at = `Rounds ${r.round}`;
    if (r.round !== String(i + 1)) errors.push(`${at}: rounds must be numbered 1..n in order`);
    if (!/^D-\d+$/.test(r.asked)) { errors.push(`${at}: asked must be exactly one decision id (one decision per round row)`); return; }
    if (!byId.has(r.asked)) errors.push(`${at}: asks unknown ${r.asked}`);
    if (askedIn.has(r.asked)) errors.push(`${at}: ${r.asked} was already asked in round ${askedIn.get(r.asked)}`);
    if (r.answer && !ANSWERERS.includes(r.answered_by)) errors.push(`${at}: answered_by must be one of ${ANSWERERS.join("|")}`);
    if (!r.answer && r.answered_by) errors.push(`${at}: answered_by without an answer`);
    if (!r.answer && d.rounds.rows.slice(i + 1).some((x) => x.answer)) errors.push(`${at}: only the last rounds may be unanswered`);
    for (const dep of byId.get(r.asked)?.deps || []) {
      const dr = byId.get(dep);
      const settledBefore = dr && ((dr.decided_by === "request" && dr.status === "resolved") || (askedIn.has(dep) && d.rounds.rows[askedIn.get(dep) - 1].answer));
      if (!settledBefore) errors.push(`${at}: asks ${r.asked} before its dependency ${dep} was settled`);
    }
    askedIn.set(r.asked, i + 1);
  });

  if (d.rounds.rows.filter((r) => !r.answer).length > 3) errors.push("Rounds: at most 3 questions may wait for an answer at once");
  const request = d.request.toLowerCase();
  for (const r of d.tree.rows) {
    const at = `Decision tree ${r.id}`;
    if (r.status === "open") {
      if (r.decision || r.decided_by || r.source) errors.push(`${at}: an open decision has no decision, decided_by or source`);
      continue;
    }
    if (!r.decision) errors.push(`${at}: ${r.status} decision text is empty`);
    if (r.status === "deferred" && !/^deferred: \S/.test(r.decision)) errors.push(`${at}: a deferred decision must read "deferred: <reason>"`);
    if (!DECIDERS.includes(r.decided_by)) { errors.push(`${at}: decided_by must be one of ${DECIDERS.join("|")}`); continue; }
    if (r.decided_by === "request") {
      if (r.status !== "resolved") errors.push(`${at}: only the user can defer; the request cannot`);
      const q = /^"(.+)"$/.exec(r.source);
      if (!q) errors.push(`${at}: decided_by request needs source "<verbatim quote from the request>"`);
      else if (!request.includes(norm(q[1]).toLowerCase())) errors.push(`${at}: source quote does not occur in the request`);
      if (askedIn.has(r.id)) errors.push(`${at}: settled by the request but was asked anyway`);
      continue;
    }
    const m = /^round (\d+)$/.exec(r.source);
    const round = m && d.rounds.rows[Number(m[1]) - 1];
    // A resolved row must be the decision its round asked; a deferred row may come from a
    // "defer the rest" answer to another decision's round.
    if (!round || (r.status === "resolved" && round.asked !== r.id)) { errors.push(`${at}: decided_by ${r.decided_by} needs source "round <n>" of a round that asked ${r.id}`); continue; }
    if (!round.answer) errors.push(`${at}: round ${m[1]} has no answer yet`);
    else if (round.answered_by !== r.decided_by) errors.push(`${at}: decided_by ${r.decided_by} but round ${m[1]} was answered_by ${round.answered_by}`);
  }

  const refsOf = (line) => [...line.matchAll(/\bD-\d+\b/g)].map((x) => x[0]);
  const checkCandidates = (lines, prefix, key) => {
    const used = new Set();
    lines.forEach((l, i) => {
      const m = new RegExp(`^- ${prefix}-(\\d+): \\S.*\\(from (D-\\d+(?:, D-\\d+)*)\\)$`).exec(l);
      if (!m) { errors.push(`${key}: "${l}" must read "- ${prefix}-<n>: <text> (from D-<n>[, D-<n>])"`); return; }
      if (Number(m[1]) !== i + 1) errors.push(`${key}: ${prefix}-${m[1]} out of sequence`);
      for (const id of refsOf(m[2])) {
        const r = byId.get(id);
        if (!r) errors.push(`${key}: ${prefix}-${m[1]} cites unknown ${id}`);
        else if (r.status !== "resolved") errors.push(`${key}: ${prefix}-${m[1]} cites ${id}, which is ${r.status}`);
        used.add(id);
      }
    });
    return used;
  };
  const accUsed = checkCandidates(d.acc, "ACC", "Acceptance criteria candidates");
  const oosUsed = checkCandidates(d.oos, "OOS", "Out of scope candidates");

  if (d.status === "complete") {
    for (const r of d.tree.rows) if (r.status === "open") errors.push(`Status complete but ${r.id} is open`);
    const last = d.rounds.rows[d.rounds.rows.length - 1];
    if (last && !last.answer) errors.push(`Status complete but round ${last.round} is unanswered`);
    for (const b of BRANCHES) if (!d.tree.rows.some((r) => r.branch === b)) errors.push(`Status complete but branch ${b} has no decision row`);
    if (d.acc.length === 0) errors.push("Status complete but no acceptance criteria candidates");
    for (const r of d.tree.rows) {
      if (r.status !== "resolved") continue;
      if (r.branch === "non-goals" && !oosUsed.has(r.id)) errors.push(`${r.id}: resolved non-goal feeds no OOS candidate`);
      if (r.branch !== "non-goals" && !accUsed.has(r.id)) errors.push(`${r.id}: resolved decision feeds no ACC candidate`);
    }
  }
  return errors;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 1) { console.error("usage: validate-intent.mjs <INTENT.md>"); return 2; }
  let md;
  try { md = readFileSync(args[0], "utf8"); } catch (e) { console.error(`error: ${e.message}`); return 2; }
  const errors = validate(md);
  for (const e of errors) console.log(e);
  if (errors.length === 0) console.log("valid");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv);
