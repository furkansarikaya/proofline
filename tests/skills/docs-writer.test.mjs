import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const writingPath = join(repo, "skills/docs-writer/scripts/check-writing.mjs");
const docsPath = join(repo, "skills/docs-writer/scripts/check-docs.mjs");
const { check, looksImperative, countWords, splitSentences, configStrictness } = await import(writingPath);
const { checkDocs, yamlKeys, slug } = await import(docsPath);

const rules = (src) => check(src).map((f) => f.rule);
const run = (script, args, cwd = repo) => spawnSync("node", [script, ...args], { encoding: "utf8", cwd });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "docs-writer-"));
  const r = spawnSync("sh", [join(repo, "fixtures/docs-writer/setup.sh"), join(dir, "p")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return join(dir, "p");
}

test("shared copies are byte-identical to tests/shared", () => {
  for (const [a, b] of [["tests/shared/check-writing.mjs", "skills/docs-writer/scripts/check-writing.mjs"], ["tests/shared/writing-profile.md", "skills/docs-writer/references/WRITING.md"]])
    assert.equal(readFileSync(join(repo, a), "utf8"), readFileSync(join(repo, b), "utf8"), b);
});

test("word counting: code span is one word, punctuation is not a word", () => {
  assert.equal(countWords("Run `node --test tests/` now - please."), 4);
  assert.equal(countWords("a, b; c"), 3);
});

test("instruction heuristic", () => {
  for (const s of ["Run the tests.", "Back up the file first.", "Use `foo`."]) assert.ok(looksImperative(s), s);
  for (const s of ["The tests run in CI.", "It stops at the first error.", "Runs are slow.", "Using it is fine.", "If the file is missing, stop."]) assert.ok(!looksImperative(s), s);
});

test("sentence limits: instruction 20, explanatory 25", () => {
  const w = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  assert.deepEqual(rules(`Run ${w(19)}.\n`), []);
  assert.deepEqual(rules(`Run ${w(20)}.\n`), ["instruction-length"]);
  assert.deepEqual(rules(`The ${w(24)}.\n`), []);
  assert.deepEqual(rules(`The ${w(25)}.\n`), ["explanatory-length"]);
});

test("a list item is an instruction even without a verb", () => {
  const long = Array.from({ length: 21 }, (_, i) => `x${i}`).join(" ");
  assert.deepEqual(rules(`- The ${long}\n`), ["instruction-length"]);
});

test("paragraph limit: 6 sentences pass, 7 fail, a list is not a paragraph", () => {
  const p = (n) => Array.from({ length: n }, (_, i) => `Sentence ${i + 1} is here.`).join(" ");
  assert.deepEqual(rules(p(6)), []);
  assert.deepEqual(rules(p(7)), ["paragraph-length"]);
  assert.deepEqual(rules(Array.from({ length: 9 }, (_, i) => `- Item ${i}.`).join("\n")), []);
  assert.equal(check(`\n\n${p(7)}\n`)[0].line, 3);
});

test("ignored: front matter, fences, tables, headings, comments, link targets", () => {
  const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const src = `---\ndescription: ${long}.\n---\n# ${long}\n\n| a |\n|---|\n| ${long} |\n\n\`\`\`sh\n${long}.\n\`\`\`\n\n<!-- ${long}. -->\n\nSee [guide](${"http://x.test/" + "a".repeat(200)}) now.\n`;
  assert.deepEqual(check(src), []);
  assert.equal(countWords("See [guide](http://x.test/a) now.".replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")), 3);
});

test("abbreviations and code spans do not split sentences", () => {
  assert.equal(splitSentences("Use e.g. a flag. Read `a.b. c` twice.").length, 2);
});

test("strictness: flag > config > relaxed; exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-cfg-"));
  mkdirSync(join(dir, ".agents"));
  const doc = join(dir, "d.md");
  writeFileSync(doc, `The ${Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")}.\n`);
  assert.equal(configStrictness(dir), null);
  assert.equal(run(writingPath, ["--root", dir, doc]).status, 0);
  writeFileSync(join(dir, ".agents/config.yaml"), "metrics: on\nwriting:\n  profile: auto\n  strictness: strict\nlocal_state: on\n");
  assert.equal(configStrictness(dir), "strict");
  const strict = run(writingPath, ["--root", dir, doc]);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /d\.md:1: error: explanatory-length/);
  const relaxed = run(writingPath, ["--root", dir, "--strictness", "relaxed", doc]);
  assert.equal(relaxed.status, 0);
  assert.match(relaxed.stdout, /warning: explanatory-length/);
  assert.match(relaxed.stdout, /judged, not checked: noun phrase/);
  assert.equal(run(writingPath, ["--strictness", "harsh", doc]).status, 2);
  assert.equal(run(writingPath, []).status, 2);
  assert.equal(run(writingPath, [join(dir, "none.md")]).status, 2);
});

test("fixture: exact writing findings", () => {
  const p = fixture();
  const r = run(writingPath, ["docs/style.md"], p);
  assert.equal(r.status, 0);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.includes(": warning:")).map((l) => l.split(": ")[0] + " " + l.split(": ")[2]),
    ["docs/style.md:3 instruction-length", "docs/style.md:5 explanatory-length", "docs/style.md:7 paragraph-length"]);
  assert.equal(run(writingPath, ["--strictness", "strict", "docs/style.md"], p).status, 1);
});

test("fixture: exact evidence findings, decoys pass", () => {
  const p = fixture();
  const r = run(docsPath, ["docs/guide.md"], p);
  assert.equal(r.status, 1);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.includes(" not found")), [
    "docs/guide.md:9: flag not found: --verbose",
    "docs/guide.md:9: config key not found: server.timeout",
    "docs/guide.md:9: path not found: docs/old-guide.md",
    "docs/guide.md:10: command not found: ./bin/acme deploy",
    "docs/guide.md:10: link not found: setup.md",
  ]);
});

test("evidence: clean doc exits 0; anchors, fences, absolute and external links", () => {
  const p = fixture();
  writeFileSync(join(p, "docs/ok.md"), [
    "# Title", "", "## Setup steps", "",
    "Run `./bin/acme build` and see [setup](#setup-steps), [site](https://example.test/x.md), [mail](mailto:a@b.test), [root](/src/server.js).", "",
    "```sh", "$ ./bin/acme serve --port 80", "```", "",
    "Not a claim: `a/b`, `and/or`, `1.2.3`, `GET /users`, `docs/<name>.md`, `src/*.js`, `x.y`.", "",
  ].join("\n"));
  const r = run(docsPath, ["docs/ok.md"], p);
  assert.equal(r.stdout.includes("not found"), false, r.stdout);
  assert.equal(r.status, 0);
  writeFileSync(join(p, "docs/bad.md"), "See [x](#nope) and [y](guide.md#nope) and `docs/gone/`.\n```sh\nacme build --nope\n./bin/acme serve --nope\n```\n");
  const b = run(docsPath, ["docs/bad.md"], p);
  assert.match(b.stdout, /bad\.md:1: anchor not found: #nope/);
  assert.match(b.stdout, /bad\.md:1: anchor not found: guide\.md#nope/);
  assert.match(b.stdout, /bad\.md:1: path not found: docs\/gone\//);
  assert.match(b.stdout, /bad\.md:4: flag not found: --nope/);
  assert.equal(run(docsPath, ["docs/missing.md"], p).status, 2);
  assert.equal(run(docsPath, [], p).status, 2);
});

test("evidence: proofline subcommands come from bin and the skill text", () => {
  const dir = mkdtempSync(join(tmpdir(), "dw-pl-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "skills/proofline"), { recursive: true });
  writeFileSync(join(dir, "bin/proofline"), "case $1 in doctor) ;; esac\n");
  writeFileSync(join(dir, "skills/proofline/SKILL.md"), "| `docs create` | x |\n");
  writeFileSync(join(dir, "d.md"), "Use `proofline doctor` and `/proofline docs create`, not `proofline fly`.\n");
  const r = checkDocs(dir, ["d.md"]);
  assert.deepEqual(r.findings.map((f) => f.claim), ["proofline fly"]);
});

test("yaml keys and slugs", () => {
  const k = yamlKeys("# c\na:\n  b: 1\n  c:\n    d: x\ne:\n");
  assert.deepEqual([...k], ["a", "a.b", "a.c", "a.c.d", "e"]);
  assert.equal(slug("Setup `steps`: now!"), "setup-steps-now");
});

test("config: writing keys are valid, bad values and unknown keys are refused", () => {
  const agent = join(repo, "control-plane/agents/scripts/agent.sh");
  const cfg = readFileSync(join(repo, "control-plane/agents/config.yaml"), "utf8");
  assert.match(cfg, /^writing:\n  profile: auto\n  strictness: relaxed$/m);
  const dir = mkdtempSync(join(tmpdir(), "dw-conf-"));
  const check = (text) => { const f = join(dir, "c.yaml"); writeFileSync(f, text); return spawnSync("sh", [agent, "config-check", f], { encoding: "utf8", cwd: repo }); };
  assert.equal(check(cfg).status, 0);
  for (const p of ["auto", "ste", "plain"]) assert.equal(check(cfg.replace(/^  profile: auto$/m, `  profile: ${p}`)).status, 0);
  assert.equal(check(cfg.replace(/^  strictness: relaxed$/m, "  strictness: strict")).status, 0);
  const badProfile = check(cfg.replace(/^  profile: auto$/m, "  profile: loud"));
  assert.notEqual(badProfile.status, 0);
  assert.match(badProfile.stderr, /invalid value for writing\.profile/);
  assert.match(check(cfg.replace(/^  strictness: relaxed$/m, "  strictness: harsh")).stderr, /invalid value for writing\.strictness/);
  assert.match(check(cfg.replace(/^  strictness: relaxed$/m, "  strictness: relaxed\n  tone: nice")).stderr, /unknown writing key: writing\.tone/);
});
