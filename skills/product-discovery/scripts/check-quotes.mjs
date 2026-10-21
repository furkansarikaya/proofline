#!/usr/bin/env node
// Every interview quote of INTERVIEWS.md occurs verbatim (whitespace-normalised) in the raw text of the interview it cites.
//   node check-quotes.mjs <slug> [--root DIR] [--json]
//   node check-quotes.mjs <slug> --privacy [--root DIR] [--json]
// Raw text: <root>/.agents/local/product-discovery/<slug>/interviews/INT-n.txt (personal data, never in git). A quote
// may be shortened with `...`; the parts must occur in that order. A missing raw text makes the quote unverifiable
// (rule `unverifiable`, exit 1). --privacy instead fails for every raw interview file that git tracks or does not
// ignore (or when the root is no git repository, where that cannot be told).
// Exit 0 clean, 1 findings, 2 usage.
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { read, resolveTarget, parseArgs, report, slugOf, stripComments } from "./lib.mjs";
import { MARKER, parseMarker } from "./validate-product-claims.mjs";

const ws = (s) => s.replace(/\s+/g, " ").trim();
export const rawDir = (root, slug) => join(root, ".agents", "local", "product-discovery", slug, "interviews");

export function occurs(rawText, quote) {
  const hay = ws(rawText);
  let from = 0;
  for (const part of quote.split(/\.\.\.|…/).map(ws).filter(Boolean)) {
    const at = hay.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

export function checkQuotes(text, root, slug) {
  const findings = [];
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    for (const m of raw.matchAll(MARKER)) {
      const p = parseMarker(m[1], m[2]);
      if (p.kind !== "fact" || p.source !== "interview" || p.errors.length) continue;
      const f = { file: "INTERVIEWS.md", line: i + 1, id: p.interview };
      if (!/^INT-\d+$/.test(p.interview)) { findings.push({ ...f, rule: "bad-interview-id", message: `interview id "${p.interview}" is not INT-<n>` }); continue; }
      const body = read(join(rawDir(root, slug), `${p.interview}.txt`));
      if (body === null) findings.push({ ...f, rule: "unverifiable", message: `raw text of ${p.interview} is missing (.agents/local/product-discovery/${slug}/interviews/${p.interview}.txt): the quote cannot be verified` });
      else if (!occurs(body, p.quote)) findings.push({ ...f, rule: "quote-not-in-raw", message: `the quote does not occur in the raw text of ${p.interview}` });
    }
  });
  return findings;
}

export function checkPrivacy(root, slug) {
  const dir = rawDir(root, slug);
  let names = [];
  try { names = readdirSync(dir).sort(); } catch { return []; }
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) return [{ file: relative(root, dir), line: 0, id: null, rule: "privacy", message: "not a git repository: cannot tell whether the raw interview texts are ignored" }];
  const findings = [];
  for (const n of names) {
    const rel = relative(root, join(dir, n));
    const f = { file: rel, line: 0, id: n.replace(/\.txt$/, "") };
    if (git(["ls-files", "--error-unmatch", "--", rel]).status === 0) findings.push({ ...f, rule: "privacy", message: "raw interview text is tracked by git; remove it from the index (git rm --cached)" });
    else if (git(["check-ignore", "-q", "--", rel]).status !== 0) findings.push({ ...f, rule: "privacy", message: "raw interview text is not ignored by git; .agents/local/.gitignore must contain *" });
  }
  return findings;
}

function main(argv) {
  const a = parseArgs(argv, ["--root"], ["--json", "--privacy"]);
  if (a.bad || a._.length !== 1) { console.error("usage: check-quotes.mjs <slug> [--privacy] [--root DIR] [--json]"); return 2; }
  const root = resolve(a.root || ".");
  const slug = slugOf(a._[0]);
  if (a.privacy) return report(checkPrivacy(root, slug), {}, a.json, "check-quotes --privacy");
  const file = join(resolveTarget(a._[0], root), "INTERVIEWS.md");
  const text = read(file);
  if (text === null) { console.error(`not found: ${file}`); return 2; }
  return report(checkQuotes(text, root, slug), {}, a.json, "check-quotes");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
