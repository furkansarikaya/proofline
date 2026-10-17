#!/usr/bin/env node
// Writing-profile length check (A138): sentence length (instruction <= 20 words, explanatory <= 25) and
// paragraph length (<= 6 sentences) of Markdown or text files. Dependency-free.
// usage: node check-writing.mjs [--strictness relaxed|strict] [--root DIR] [--json] FILE...
// Strictness: flag, else writing.strictness of DIR/.agents/config.yaml, else relaxed.
// Exit 0: clean, or findings under relaxed. 1: findings under strict. 2: usage error.
// Rules 4-8 of the profile are judged by the writer and reviewer, never checked here.
// shortcut: instruction detection is an English first-word heuristic; other languages need a smarter check.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MAX = { instruction: 20, explanatory: 25, paragraph: 6 };
export const JUDGED = ["noun phrase <= 3 words", "one instruction per sentence", "active voice, imperative", "same word for same thing", "warning: instruction first, then risk"];

// Words that open an explanatory sentence (determiners, pronouns, prepositions, conjunctions, auxiliaries).
const NOT_VERB = new Set(("a an the this that these those it its he she they we you i there here some any each every all both no " +
  "one two three if when while after before because since although though however but and or so then also in on at by for with from to of as " +
  "is are was were be been has have had does did will would can could should may might must what which who whom whose where why how " +
  "our your their his her my us them not only just once such other another most many more much").split(" "));

export function looksImperative(sentence) {
  const w = sentence.replace(/^[^\p{L}]+/u, "").match(/^\p{L}+/u);
  if (!w) return false;
  const first = w[0].toLowerCase();
  // third person or plural (-s but not -ss), participle, adverb or noun suffix: not a base-form verb
  return !NOT_VERB.has(first) && !/(ing|ed|ly|tion|ment|ness)$/.test(first) && !/[^s]s$/.test(first);
}

export function countWords(s) {
  return s.replace(/`[^`]*`/g, " X ").split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

// Returns [{ n, text, list }] units: a list item is one unit, consecutive prose lines form one paragraph.
export function blocks(src) {
  const out = []; let cur = null; let fence = null; let i = 0;
  const lines = src.split("\n");
  if (lines[0] === "---") { const e = lines.indexOf("---", 1); if (e > 0) i = e + 1; }
  let comment = false;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (; i < lines.length; i++) {
    let l = lines[i];
    const n = i + 1;
    if (fence) { if (l.trimStart().startsWith(fence)) fence = null; continue; }
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) { flush(); fence = f[1]; continue; }
    if (comment) { if (l.includes("-->")) comment = false; continue; }
    if (/^\s*<!--/.test(l)) { flush(); if (!l.includes("-->")) comment = true; continue; }
    if (/^\s*$/.test(l) || /^\s*#{1,6}\s/.test(l) || /^\s*\|/.test(l)) { flush(); continue; }
    l = l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<https?:[^>]*>/g, " ");
    const li = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) { flush(); cur = { n, text: li[1], list: true }; continue; }
    if (cur && !cur.list) { cur.text += " " + l.trim(); continue; }
    if (cur && cur.list && /^\s{2,}\S/.test(l)) { cur.text += " " + l.trim(); continue; }
    flush(); cur = { n, text: l.trim(), list: false };
  }
  flush();
  return out;
}

export function splitSentences(text) {
  const masked = text.replace(/`[^`]*`/g, (m) => m.replace(/[.!?]/g, "\u0000")).replace(/\b(e\.g|i\.e|etc|vs)\./gi, (m) => m.replace(".", "\u0000"));
  return masked.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}`"(\[])/u).map((s) => s.replace(/\u0000/g, ".").trim()).filter(Boolean);
}

export function check(src, file = "-") {
  const findings = [];
  for (const b of blocks(src)) {
    const sents = splitSentences(b.text);
    for (const s of sents) {
      const instr = b.list || looksImperative(s);
      const words = countWords(s);
      const max = instr ? MAX.instruction : MAX.explanatory;
      if (words > max) findings.push({ file, line: b.n, rule: instr ? "instruction-length" : "explanatory-length", message: `${instr ? "instruction" : "explanatory"} sentence has ${words} words (max ${max}): ${s.slice(0, 50)}...` });
    }
    if (!b.list && sents.length > MAX.paragraph) findings.push({ file, line: b.n, rule: "paragraph-length", message: `paragraph has ${sents.length} sentences (max ${MAX.paragraph})` });
  }
  return findings;
}

export function configStrictness(root) {
  const p = join(root, ".agents/config.yaml");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^writing:\s*\n(?:[ \t]+.*\n|\s*\n)*?[ \t]+strictness:[ \t]*(\w+)/m);
  return m ? m[1] : null;
}

function main(argv) {
  let strictness = null, root = process.cwd(), json = false; const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strictness") strictness = argv[++i];
    else if (a === "--root") root = argv[++i];
    else if (a === "--json") json = true;
    else if (a.startsWith("--")) { console.error(`check-writing: unknown option ${a}`); return 2; }
    else files.push(a);
  }
  strictness = strictness || configStrictness(root) || "relaxed";
  if (!files.length || !["relaxed", "strict"].includes(strictness)) { console.error("usage: check-writing.mjs [--strictness relaxed|strict] [--root DIR] [--json] FILE..."); return 2; }
  const findings = [];
  for (const f of files) {
    if (!existsSync(f)) { console.error(`check-writing: no such file: ${f}`); return 2; }
    findings.push(...check(readFileSync(f, "utf8"), f));
  }
  const level = strictness === "strict" ? "error" : "warning";
  if (json) console.log(JSON.stringify({ strictness, findings, judged: JUDGED }, null, 2));
  else {
    for (const x of findings) console.log(`${x.file}:${x.line}: ${level}: ${x.rule}: ${x.message}`);
    console.log(`writing: ${findings.length} finding(s), strictness ${strictness}; judged, not checked: ${JUDGED.join("; ")}`);
  }
  return strictness === "strict" && findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
