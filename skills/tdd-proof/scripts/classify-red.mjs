#!/usr/bin/env node
// Classifies test-runner output as RED (a failing assertion) or one of the non-RED classes.
// Usage: <runner output> | node classify-red.mjs [--exit-code N] [--ecosystem ID]
//        node classify-red.mjs --file <output file> [--exit-code N] [--ecosystem ID]
// Prints {"class": ..., "evidence": "<first matching line>", "red_valid": bool} (plus "exit_code" when one was given).
// Exit: 0 when class is "assertion", 1 for any other class, 2 usage/read error.
// Precedence (first match wins): syntax, compile, import, missing_file, no_tests, setup_crash,
// timeout, assertion, crash, unknown. A non-assertion signal anywhere wins: part of the run never executed.
// The patterns of three classes (compile, no_tests, assertion) are not in this file: they come from `test_output` of the
// ecosystem definition (references/ecosystems.json, a byte-identical copy of control-plane/agents/ecosystems.json, A173),
// the single source for every runner of every ecosystem. An entry may carry `unless`, a pattern that cancels it when the
// output also shows that some test ran (a multi-package `go test`, a solution with several test projects).
// The exit code is only a cross-check, never evidence of RED: exit 0 turns an assertion into unknown (a passing run is not
// RED), and when no pattern matched and --ecosystem is given, an exit code that the definition lists for exactly one of
// no_tests or compile (and for no other class) names that class. An unknown --ecosystem is a usage error.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEcosystems, toRegExp } from "./ecosystems.mjs";

// The classes whose patterns are NOT runner-specific (the same text means the same thing in every ecosystem).
const SYNTAX = [/SyntaxError/, /IndentationError/, /\bParse error\b/, /\bsyntax error\b/i];
const IMPORT = [/ModuleNotFoundError/, /\bImportError\b/, /Cannot find module/, /ERR_MODULE_NOT_FOUND/, /Failed to resolve import/, /No module named/,
  /unresolved import/, /cannot find package/, /\bLoadError\b/, /cannot load such file/, /Class "[^"]+" not found/, /NoClassDefFoundError/, /Cannot resolve module/];
const MISSING_FILE = [/\bENOENT\b/, /no such file or directory/i, /FileNotFoundError/, /file or directory not found/i, /\bNo such file\b/];
const SETUP_CRASH = [/ERROR at setup of/, /fixture '[^']+' not found/, /Test suite failed to run/, /"before (each|all)" hook/, /Error in (setUp|beforeEach|beforeAll)/i, /OneTimeSetUp/];
const TIMEOUT = [/\btimed out\b/i, /\bETIMEDOUT\b/, /exceeded timeout/i, /timeout of \d+ms exceeded/i];
const CRASH = [/\b(TypeError|ReferenceError|NameError|AttributeError|NoMethodError|NullPointerException|NullReferenceException|KeyError|IndexError|ZeroDivisionError|StackOverflowError)\b/,
  /panic: runtime error/, /Segmentation fault/, /Traceback \(most recent call last\)/];
const plain = (res) => res.map((re) => ({ re, unless: null }));

// The entries of one class from the definition: [{ re, unless }], for every ecosystem or only for `ecosystem`.
function entries(data, cls, ecosystem) {
  const out = [];
  for (const e of data.ecosystems) {
    if (ecosystem && e.id !== ecosystem) continue;
    for (const x of e.test_output?.[cls] ?? []) out.push({ re: toRegExp(x.pattern), unless: x.unless ? toRegExp(x.unless) : null });
  }
  return out;
}

function rulesFor(ecosystem) {
  const data = loadEcosystems();
  if (ecosystem && !data.ecosystems.some((e) => e.id === ecosystem)) {
    throw new Error(`unknown ecosystem "${ecosystem}" (known: ${data.ecosystems.map((e) => e.id).join(", ")})`);
  }
  return [
    ["syntax", plain(SYNTAX)],
    ["compile", entries(data, "compile", ecosystem)],
    ["import", plain(IMPORT)],
    ["missing_file", plain(MISSING_FILE)],
    ["no_tests", entries(data, "no_tests", ecosystem)],
    ["setup_crash", plain(SETUP_CRASH)],
    ["timeout", plain(TIMEOUT)],
    ["assertion", entries(data, "assertion", ecosystem)],
    ["crash", plain(CRASH)],
  ];
}

const firstLine = (text, re) => {
  const m = re.exec(text);
  if (!m) return null;
  const start = text.lastIndexOf("\n", m.index) + 1;
  const end = text.indexOf("\n", m.index);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 200);
};

// The class an exit code names alone: listed for exactly one of the classes of the ecosystem, and that class is not an assertion.
function classOfExitCode(ecosystem, code) {
  const e = loadEcosystems().ecosystems.find((x) => x.id === ecosystem);
  const hits = ["no_tests", "compile", "assertion"].filter((c) => (e?.test_output?.exit_codes?.[c] ?? []).some((x) => String(x.code) === String(code)));
  if (hits.length !== 1 || hits[0] === "assertion") return null;
  const x = e.test_output.exit_codes[hits[0]].find((y) => String(y.code) === String(code));
  return { cls: hits[0], evidence: `exit code ${code} (${x.runner}, ${x.source})` };
}

export function classify(output, opts = {}) {
  const text = String(output ?? "");
  const code = opts.exitCode === undefined || opts.exitCode === null || opts.exitCode === "" ? null : Number(opts.exitCode);
  const done = (r) => (code === null ? r : { ...r, exit_code: code });
  if (code !== null && !Number.isInteger(code)) throw new Error(`exit code must be an integer, got "${opts.exitCode}"`);
  const rules = rulesFor(opts.ecosystem);
  if (text.trim() === "") {
    const byCode = code !== null && opts.ecosystem ? classOfExitCode(opts.ecosystem, code) : null;
    return done(byCode ? { class: byCode.cls, evidence: byCode.evidence, red_valid: false } : { class: "unknown", evidence: "empty output", red_valid: false });
  }
  for (const [cls, list] of rules) {
    for (const { re, unless } of list) {
      if (!re.test(text) || (unless && unless.test(text))) continue;
      if (cls === "assertion" && code === 0) return done({ class: "unknown", evidence: `exit code 0 with an assertion message: a passing run is not RED (${firstLine(text, re) ?? ""})`.slice(0, 200), red_valid: false });
      return done({ class: cls, evidence: firstLine(text, re) ?? "", red_valid: cls === "assertion" });
    }
  }
  const byCode = code !== null && opts.ecosystem ? classOfExitCode(opts.ecosystem, code) : null;
  if (byCode) return done({ class: byCode.cls, evidence: byCode.evidence, red_valid: false });
  return done({ class: "unknown", evidence: "no known runner signature", red_valid: false });
}

const USAGE = "usage: classify-red.mjs [--file <output file>] [--exit-code N] [--ecosystem ID]  (runner output on stdin without --file)";
const main = () => {
  const args = process.argv.slice(2);
  let file = null, exitCode, ecosystem;
  for (let i = 0; i < args.length; i++) {
    const v = args[i + 1];
    if (args[i] === "--file" && v) { file = v; i++; }
    else if (args[i] === "--exit-code" && v !== undefined) { exitCode = v; i++; }
    else if (args[i] === "--ecosystem" && v) { ecosystem = v; i++; }
    else { console.error(USAGE); process.exit(2); }
  }
  let text;
  try { text = readFileSync(file ?? 0, "utf8"); } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  let r;
  try { r = classify(text, { exitCode, ecosystem }); } catch (e) { console.error(`classify-red: ${e.message}`); process.exit(2); }
  console.log(JSON.stringify(r));
  process.exit(r.red_valid ? 0 : 1);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
