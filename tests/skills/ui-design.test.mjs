import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skill = join(dirname(fileURLToPath(import.meta.url)), "../../skills/ui-design");
const script = join(skill, "scripts/validate-ui.mjs");
const { validate, validateDesignMd } = await import(script);

const repo = mkdtempSync(join(tmpdir(), "ui-"));
mkdirSync(join(repo, "src/ui"), { recursive: true });
writeFileSync(join(repo, "DESIGN.md"), "# d\n");
writeFileSync(join(repo, "src/ui/Button.tsx"), "");
writeFileSync(join(repo, "src/ui/tokens.css"), "");

const st = (c) => ({ copy: c, behavior: `shows ${c}` });
const good = () => ({
  schema_version: 1, mode: "task", ui_languages: ["en", "tr"],
  design_system: { file: "DESIGN.md", exists: true },
  reused: [{ kind: "component", name: "Button", path: "src/ui/Button.tsx" }, { kind: "token", name: "--color-danger", path: "src/ui/tokens.css" }],
  new: [{ kind: "variant", name: "Button.ghost", base: "src/ui/Button.tsx", reason: "secondary inline action", reuse_rejected: "Button.secondary has a border that clashes in table rows" }],
  screens: [{
    id: "S1", name: "Orders", route: "/orders",
    states: { empty: st("No orders yet"), loading: st("Loading orders"), error: st("Could not load orders. Retry"), success: st("Order created"),
      partial: st("Showing 20 of 120"), "permission-denied": { not_applicable: "route is behind the buyer role guard; unauthenticated users never reach it" } },
    keyboard: ["Tab order: filter, list, create button; Enter activates; focus returns to Create after the dialog closes"],
    screen_reader: ["List has role=list; status updates announced in a polite live region"],
    responsive: ["<640px: table becomes cards; targets >= 44px"],
  }],
  flows: [{ id: "F1", name: "Create order", steps: ["open dialog", "submit", "see success"], screens: ["S1"] }],
});
const errs = (d, o = { root: repo }) => validate(d, o);
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("accepts a good UI spec", () => assert.deepEqual(errs(good()), []));
test("a missing state is rejected", () => {
  const d = good(); delete d.screens[0].states.partial; has(errs(d), "state missing");
});
test("not_applicable needs a reason", () => {
  const d = good(); d.screens[0].states["permission-denied"] = { not_applicable: " " }; has(errs(d), "needs a reason");
});
test("a state needs copy and behavior", () => {
  const d = good(); d.screens[0].states.error = { copy: "x", behavior: "" }; has(errs(d), "behavior");
});
test("placeholder copy rejected", () => {
  const d = good(); d.screens[0].states.empty = st("TBD"); has(errs(d), "placeholder");
});
test("unknown state rejected", () => {
  const d = good(); d.screens[0].states.weird = st("x"); has(errs(d), "unknown state");
});
test("reused path must exist", () => {
  const d = good(); d.reused[0].path = "src/ui/Missing.tsx"; has(errs(d), "does not exist");
});
test("new item needs reason and reuse_rejected", () => {
  const d = good(); delete d.new[0].reason; delete d.new[0].reuse_rejected; const e = errs(d);
  has(e, "reason"); has(e, "reuse_rejected");
});
test("new item cannot duplicate a reused name", () => {
  const d = good(); d.new[0].name = "Button"; has(errs(d), "duplicates a reused");
});
test("variant base must exist", () => {
  const d = good(); d.new[0].base = "src/ui/Nope.tsx"; has(errs(d), "does not exist");
});
test("accessibility and responsive arrays are mandatory", () => {
  const d = good(); d.screens[0].keyboard = []; delete d.screens[0].screen_reader; d.screens[0].responsive = [""];
  const e = errs(d); has(e, "keyboard"); has(e, "screen_reader"); has(e, "responsive");
});
test("task mode needs a screen; reverse does not", () => {
  const d = good(); d.screens = []; d.flows = []; has(errs(d), "at least one screen");
  d.mode = "reverse"; assert.deepEqual(errs(d), []);
});
test("flow screens must exist", () => {
  const d = good(); d.flows[0].screens = ["S9"]; has(errs(d), "unknown screen");
});
test("duplicate screen ids and bad ui_languages rejected", () => {
  const d = good(); d.screens.push(structuredClone(d.screens[0])); has(errs(d), "duplicate id");
  const e = good(); e.ui_languages = []; has(errs(e), "ui_languages");
});

const designMd = (extra = "") => `# Design\n## Tokens\n| a | b |\n|---|---|\n| --x | 1 | \`src/ui/tokens.css\` |\n## Typography\nInter 16/24\n## Spacing\n4px scale\n## Colour roles\nprimary #00f\n## Components\nButton \`src/ui/Button.tsx\`\n## Accessibility\nFocus ring 2px, contrast 7.1:1\n${extra}`;
test("DESIGN.md: accepts complete, existing paths", () => assert.deepEqual(validateDesignMd(designMd(), { root: repo }), []));
test("DESIGN.md: missing and empty sections rejected", () => {
  const t = designMd().replace("## Accessibility\nFocus ring 2px, contrast 7.1:1\n", "## Accessibility\n");
  has(validateDesignMd(t), "empty");
  has(validateDesignMd(designMd().replace("## Spacing\n4px scale\n", "")), 'missing section "Spacing"');
});
test("DESIGN.md: nonexistent path and placeholder rejected", () => {
  has(validateDesignMd(designMd("see `src/ui/Gone.tsx`"), { root: repo }), "does not exist");
  has(validateDesignMd(designMd("TBD")), "placeholder");
});
test("CLI exit codes incl. --design-md", () => {
  const f = join(repo, "ui.json"), m = join(repo, "D.md");
  writeFileSync(f, JSON.stringify(good())); writeFileSync(m, designMd());
  assert.equal(spawnSync("node", [script, f, "--design-md", m, "--root", repo]).status, 0);
  assert.equal(spawnSync("node", [script, "--design-md", m]).status, 0);
  writeFileSync(m, "# x\n");
  assert.equal(spawnSync("node", [script, f, "--design-md", m]).status, 1);
  assert.equal(spawnSync("node", [script]).status, 2);
});
test("SKILL.md frontmatter and schema", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(t, /^---\nname: ui-design\n/);
  assert.ok(t.split("\n").length < 500);
  JSON.parse(readFileSync(join(skill, "schema/ui.schema.json"), "utf8"));
});
