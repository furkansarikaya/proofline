#!/usr/bin/env node
// Checks the claims of the discovery documents (FRAME.md, RESEARCH.md, COMPETITORS.md, INTERVIEWS.md) of one slug.
//   node check-research.mjs <slug|dir|file> [--root DIR] [--json]
// A claim is a line `- C-n <text> <marker>`. Rules: invalid-marker, unmarked, duplicate-id, unsourced-number (the
// text holds a number, percent, amount of money or market size and the marker is not a valid sourced fact),
// number-not-in-quote (web and interview facts: every number of the text occurs in the quote),
// persona-without-source (a persona line needs a valid fact marker).
// Exit 0 clean, 1 findings, 2 usage.
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, idLines, resolveTarget, isDir, parseArgs, report, stripComments } from "./lib.mjs";
import { MARKER } from "./validate-product-claims.mjs";

const FILES = ["FRAME.md", "RESEARCH.md", "COMPETITORS.md", "INTERVIEWS.md"];
const UNIT = /\b(million|billion|trillion|thousand|percent|per ?cent|dollars?|euros?)\b/i;
const NUM = /\d[\d.,]*\d|\d/g;
const norm = (n) => n.replace(/,/g, "").replace(/\.$/, "");

// Numbers of a claim text, without the marker, ids (C-3, INT-2) and dates (2026-10-21).
export function numbersOf(text) {
  const t = text.replace(MARKER, " ").replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\b[A-Za-z]{1,4}-\d+\b/g, " ").replace(/^-\s*/, "");
  return { nums: (t.match(NUM) || []).map(norm), unit: UNIT.test(t) || /[%$€£]/.test(t) };
}

// files: [{ name, text }]. Returns the findings.
export function checkResearch(files) {
  const findings = [], seen = new Map();
  for (const { name, text } of files) {
    const add = (l, rule, message) => findings.push({ file: name, line: l.line, id: l.id, rule, message });
    for (const l of idLines(text, "C-\\d+")) {
      if (seen.has(l.id)) add(l, "duplicate-id", `${l.id} is already defined in ${seen.get(l.id)}`);
      seen.set(l.id, name);
      const m = l.markers[0];
      if (l.markers.length !== 1) add(l, l.markers.length ? "invalid-marker" : "unmarked", l.markers.length ? `a claim carries exactly one marker (found ${l.markers.length})` : "claim carries no marker (fact, assumption or decision)");
      if (m?.errors.length) add(l, "invalid-marker", m.errors[0]);
      const { nums, unit } = numbersOf(l.text);
      const validFact = l.markers.length === 1 && m.kind === "fact" && !m.errors.length;
      if ((nums.length || unit) && !validFact) add(l, "unsourced-number", "the claim holds a number and is not a valid sourced fact; make it a fact with its source, or take the number out");
      if (validFact && (m.source === "web" || m.source === "interview")) {
        const q = new Set((m.quote.replace(/\d{4}-\d{2}-\d{2}/g, " ").match(NUM) || []).map(norm));
        const missing = nums.filter((n) => !q.has(n));
        if (missing.length) add(l, "number-not-in-quote", `number ${missing.join(", ")} of the claim does not occur in its quote`);
      }
      if (/\bpersona\b/i.test(l.text.replace(MARKER, "")) && !validFact) add(l, "persona-without-source", "a persona needs a valid fact marker (web, interview, data or ref)");
    }
    // persona lines that are no claims (`- Persona: ...`)
    let fence = false;
    stripComments(text).split(/\r?\n/).forEach((raw, i) => {
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
      if (fence || !/^\s*[-*]\s+persona\b/i.test(raw) || /^- C-\d+\s/.test(raw)) return;
      const ms = [...raw.matchAll(MARKER)];
      if (ms.length !== 1 || ms[0][1].toLowerCase() !== "fact") findings.push({ file: name, line: i + 1, id: null, rule: "persona-without-source", message: "a persona needs a valid fact marker (web, interview, data or ref)" });
    });
  }
  return findings;
}

function main(argv) {
  const a = parseArgs(argv, ["--root"], ["--json"]);
  if (a.bad || a._.length !== 1) { console.error("usage: check-research.mjs <slug|dir|file> [--root DIR] [--json]"); return 2; }
  const root = resolve(a.root || ".");
  const target = resolveTarget(a._[0], root);
  if (!existsSync(target)) { console.error(`not found: ${target}`); return 2; }
  const names = isDir(target) ? FILES.filter((n) => existsSync(join(target, n))) : [basename(target)];
  const files = names.map((n) => ({ name: n, text: read(isDir(target) ? join(target, n) : target) }));
  if (!files.length) { console.error(`no discovery documents in ${target}`); return 2; }
  return report(checkResearch(files), {}, a.json, "check-research");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
