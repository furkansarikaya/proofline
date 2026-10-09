#!/usr/bin/env node
// Classifies test-runner output as RED (a failing assertion) or one of the non-RED classes.
// Usage: <runner output> | node classify-red.mjs      or      node classify-red.mjs --file <output file>
// Prints {"class": ..., "evidence": "<first matching line>", "red_valid": bool}.
// Exit: 0 when class is "assertion", 1 for any other class, 2 usage/read error. No dependencies.
// Precedence (first match wins): syntax, compile, import, missing_file, no_tests, setup_crash,
// timeout, assertion, crash, unknown. A non-assertion signal anywhere wins: part of the run never executed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RULES = [
  ["syntax", [/SyntaxError/, /IndentationError/, /\bParse error\b/, /\bsyntax error\b/i]],
  ["compile", [/error TS\d+/, /\bTS\d{4}:/, /error CS\d+/, /error\[E\d+\]/, /could not compile/i, /\[build failed\]/i, /COMPILATION ERROR/,
    /cannot find symbol/, /\bBuild FAILED\b/, /\bundefined: \w+/, /cannot use .+ as .+ value/, /Compilation failed/i, /Test Run Aborted/,
    /error: .*(was not declared|undeclared)/]],
  ["import", [/ModuleNotFoundError/, /\bImportError\b/, /Cannot find module/, /ERR_MODULE_NOT_FOUND/, /Failed to resolve import/, /No module named/,
    /unresolved import/, /cannot find package/, /\bLoadError\b/, /cannot load such file/, /Class "[^"]+" not found/, /NoClassDefFoundError/, /Cannot resolve module/]],
  ["missing_file", [/\bENOENT\b/, /no such file or directory/i, /FileNotFoundError/, /file or directory not found/i, /\bNo such file\b/]],
  ["no_tests", [/collected 0 items/, /\bno tests? (were )?(found|ran|to run)\b/i, /no test files/i, /\bRan 0 tests\b/, /No test is available/,
    /^\s*(ℹ|#)\s*tests\s+0\b/m, /\[no tests to run\]/]],
  ["setup_crash", [/ERROR at setup of/, /fixture '[^']+' not found/, /Test suite failed to run/, /"before (each|all)" hook/, /Error in (setUp|beforeEach|beforeAll)/i, /OneTimeSetUp/]],
  ["timeout", [/\btimed out\b/i, /\bETIMEDOUT\b/, /exceeded timeout/i, /timeout of \d+ms exceeded/i]],
  ["assertion", [/AssertionError/, /AssertionFailedError/, /ComparisonFailure/, /\bexpect\(.*\)\.(not\.)?to\w+/, /Expected:[\s\S]{0,400}?(Received|Actual):/,
    /^E\s+assert\b/m, /Assert\.\w+\(\) Failure/, /\bassertion\b.{0,40}\bfailed\b/i, /Failed asserting that/, /expected: .+ got: /i,
    { all: [/^\s*--- FAIL: /m, /_test\.go:\d+:/] }]],
  ["crash", [/\b(TypeError|ReferenceError|NameError|AttributeError|NoMethodError|NullPointerException|NullReferenceException|KeyError|IndexError|ZeroDivisionError|StackOverflowError)\b/,
    /panic: runtime error/, /Segmentation fault/, /Traceback \(most recent call last\)/]],
];

const firstLine = (text, re) => {
  const m = re.exec(text);
  if (!m) return null;
  const start = text.lastIndexOf("\n", m.index) + 1;
  const end = text.indexOf("\n", m.index);
  return text.slice(start, end < 0 ? undefined : end).trim().slice(0, 200);
};

export function classify(output) {
  const text = String(output ?? "");
  if (text.trim() === "") return { class: "unknown", evidence: "empty output", red_valid: false };
  for (const [cls, pats] of RULES) {
    for (const p of pats) {
      const list = p.all ?? [p];
      if (list.every((r) => r.test(text))) {
        return { class: cls, evidence: firstLine(text, list[0]) ?? "", red_valid: cls === "assertion" };
      }
    }
  }
  return { class: "unknown", evidence: "no known runner signature", red_valid: false };
}

const main = () => {
  const args = process.argv.slice(2);
  let text;
  try {
    if (args[0] === "--file" && args[1]) text = readFileSync(args[1], "utf8");
    else if (args.length === 0) text = readFileSync(0, "utf8");
    else { console.error("usage: classify-red.mjs [--file <output file>]  (or runner output on stdin)"); process.exit(2); }
  } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  const r = classify(text);
  console.log(JSON.stringify(r));
  process.exit(r.red_valid ? 0 : 1);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
