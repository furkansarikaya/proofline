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
// A81: creative direction, UX patterns, self-critique, criteria with visual_proof.
const { parseTask, visualProofList } = await import(script);
const TASK = "# Task: T-1\n## Acceptance criteria\n- AC-1: list shows orders\n- AC-2: errors offer retry\n## Suggested class\nCOMPLEX\n## Goal\nPlease redesign the orders page to the new layout.\n";
const strong = () => ({
  ...good(),
  creative_direction: { basis: "conform", visual_character: "calm, dense operator tool", typography: "existing 14/20 body scale", layout: "12-column grid, fixed filter bar", hierarchy: "count, then table, then create", rationale: "operators scan orders all day (TASK goal); DESIGN.md is dense" },
  ux_patterns: [{ decision: "order list display", options: ["table", "cards"], chosen: "table", density: "20 rows per viewport", flow: "filter, scan, open", rationale: "columns compared across rows; existing lists use tables" }],
  self_critique: { hierarchy: "one primary action (Create)", density: "kept 20 rows", consistency: "same Button and tokens", legibility: "contrast 7.1:1",
    anti_patterns: [{ check: "state by colour alone", result: "fixed", note: "status text added next to the colour dot" }, { check: "placeholder as label", result: "clear" }] },
  criteria: [{ id: "AC-1", screens: ["S1"], visual_proof: "required", evidence: "S1 success and empty at 375 and 1280 px" }, { id: "AC-2", screens: ["S1"], visual_proof: "not_required" }],
});
const task = parseTask(TASK);
const alts = () => ({ alternatives: [{ name: "Ledger", summary: "dense mono numerals, two neutral roles", trade_off: "less inviting for new users" }, { name: "Desk", summary: "roomier rows, one accent role", trade_off: "fewer rows per viewport" }], chosen: "Ledger" });
test("existing spec stays valid without class; COMPLEX/CRITICAL require the new sections", () => {
  assert.deepEqual(errs(good()), []);
  assert.deepEqual(errs(good(), { root: repo, cls: "STANDARD", task }), []);
  const e = errs(good(), { root: repo, cls: "CRITICAL", task });
  for (const k of ["creative_direction", "ux_patterns", "self_critique", "criteria"]) has(e, `missing "${k}"`);
  has(errs(good(), { root: repo, task }), 'missing "creative_direction": required for a COMPLEX');
  const r = good(); r.mode = "reverse"; r.screens = []; r.flows = []; assert.deepEqual(errs(r, { root: repo, cls: "COMPLEX", task }), []);
  assert.deepEqual(errs(strong(), { root: repo, task }), []);
  has(errs(good(), { root: repo, cls: "HUGE", task }), "is not one of");
  has(errs(good(), { root: repo, cls: "COMPLEX" }), "a class needs the task");
});
test("reverse mode rejects task design content", () => {
  const r = strong(); r.mode = "reverse"; const e = errs(r);
  has(e, "$.criteria: mode reverse"); has(e, "$.creative_direction: mode reverse"); has(e, "$.screens: mode reverse has no screens");
});
test("design_system.exists false while the file exists is rejected", () => {
  const d = good(); d.design_system.exists = false; has(errs(d), "DESIGN.md exists: set exists true");
  d.design_system.file = "docs/DESIGN.md"; assert.deepEqual(errs(d), []);
});
test("creative direction: new is invalid when DESIGN.md exists; new needs avoided", () => {
  const d = strong(); Object.assign(d.creative_direction, alts(), { basis: "new" }); has(errs(d), "DESIGN.md exists");
  d.design_system = { file: "docs/DESIGN.md", exists: false }; has(errs(d), "avoided");
  d.creative_direction.avoided = ["gradient hero: an internal tool has no landing page"]; assert.deepEqual(errs(d), []);
});
test("creative direction: an approval naming a meeting or review without a recorded answer is refused (A94)", () => {
  const d = strong(); Object.assign(d.creative_direction, alts(), { basis: "redesign" });
  d.creative_direction.redesign = { task_quote: "redesign the orders page", user_approval: "" };
  for (const t of ["approved in the Q3 planning review", "the user approved it in the Q2 review meeting", "agreed in the design sync (Q4 planning)", "approved at the roadmap review", "Q4 launch, user said yes", "user said yes, Q3"]) {
    d.creative_direction.redesign.user_approval = t; has(errs(d, { root: repo, task }), "reference the recorded answer");
  }
  d.creative_direction.redesign.user_approval = "approved in the Q3 planning review, recorded in questions/004.answer.md";
  assert.deepEqual(errs(d, { root: repo, task }), []);
});
test("creative direction: redesign needs the task's request and the user's approval", () => {
  const d = strong(); Object.assign(d.creative_direction, alts(), { basis: "redesign" }); has(errs(d), "redesign needs");
  d.creative_direction.redesign = { task_quote: "redesign the orders page", user_approval: "" }; has(errs(d), "user's approval");
  d.creative_direction.redesign.user_approval = "assumed from the task"; has(errs(d), "must come from the user");
  d.creative_direction.redesign.user_approval = "Q-2 answered_by user: yes, redesign"; assert.deepEqual(errs(d, { root: repo, task }), []);
  d.creative_direction.redesign.user_approval = "the user said yes in chat"; has(errs(d), "reference the recorded answer");
  for (const ref of ["questions/002.answer.md", "Q3 of the NEEDS_INPUT round", "design/INTENT.md#D-4"]) {
    d.creative_direction.redesign.user_approval = `user approved: ${ref}`; assert.deepEqual(errs(d, { root: repo, task }), [], ref);
  }
  d.creative_direction.redesign.user_approval = "I approve, Q-1"; has(errs(d), "must come from the user");
  d.creative_direction.redesign.task_quote = "make it modern"; const m = errs(d, { root: repo, task });
  has(m, "not found in TASK.md"); has(m, "does not ask for a visual change");
  d.creative_direction.redesign.task_quote = "orders page"; has(errs(d), "does not ask for a visual change");
  const c = strong(); c.creative_direction.redesign = { task_quote: "x", user_approval: "y" }; has(errs(c), "only with basis redesign");
});
test("direction alternatives: required for new, refused for conform", () => {
  const noDs = { file: "docs/DESIGN.md", exists: false };
  const n = strong(); n.design_system = noDs; Object.assign(n.creative_direction, { basis: "new", avoided: ["gradient hero: no landing page"] });
  has(errs(n), "2-3 alternatives");
  Object.assign(n.creative_direction, alts()); assert.deepEqual(errs(n), []);
  n.creative_direction.chosen = "Other"; has(errs(n), "name of one alternative");
  n.creative_direction.chosen = "Ledger"; n.creative_direction.alternatives[1].name = "Ledger"; has(errs(n), "duplicate alternative");
  const c = strong(); Object.assign(c.creative_direction, alts()); has(errs(c), "no direction alternatives");
});
test("redesign of UI code without DESIGN.md: user's sentence, inventory and avoided (no approval needed)", () => {
  const app = mkdtempSync(join(tmpdir(), "ui-code-"));
  mkdirSync(join(app, "src/ui"), { recursive: true });
  writeFileSync(join(app, "src/ui/Button.tsx"), ""); writeFileSync(join(app, "src/ui/tokens.css"), "");
  const o = { root: app };
  const base = () => { const d = strong(); d.design_system = { file: "DESIGN.md", exists: false }; return d; };
  const r = base(); Object.assign(r.creative_direction, alts(), { basis: "redesign", avoided: ["purple gradient hero found in src/pages/Home: decoration, not meaning"],
    redesign: { task_quote: "Please redesign the orders page, it looks generic", inventory: ["Orders page: filter, table, create dialog", "Create order flow"] } });
  assert.deepEqual(errs(r, o), []);
  const m = base(); Object.assign(m.creative_direction, alts(), { basis: "redesign", redesign: { task_quote: "Please redesign the orders page, it looks generic" } });
  const e = errs(m, o); has(e, "redesign.inventory"); has(e, "creative_direction.avoided");
  r.creative_direction.redesign.user_approval = "I approve"; has(errs(r, o), "must come from the user");
  r.creative_direction.redesign.task_quote = "make it prettier"; has(errs(r, o), "does not ask for a visual change");
  assert.deepEqual(errs(base(), o), []);
});
test("ux patterns: two options, chosen among them", () => {
  const d = strong(); d.ux_patterns[0].options = ["table"]; has(errs(d), "at least two");
  const c = strong(); c.ux_patterns[0].chosen = "tree"; has(errs(c), "one of options");
  const e = strong(); e.ux_patterns = []; has(errs(e), "non-empty array");
});
test("self-critique: checklist results and no self-approval", () => {
  const d = strong(); d.self_critique.anti_patterns[0].result = "ok"; has(errs(d), "clear, fixed or accepted");
  const n = strong(); delete n.self_critique.anti_patterns[0].note; has(errs(n), "needs a note");
  const a = strong(); a.self_critique.hierarchy = "Design approved, ready to ship"; has(errs(a), "self-approval");
  const k = strong(); k.quality_approval = "approved by designer"; has(errs(k), "never gives final quality approval");
  const u = strong(); u.self_critique.anti_patterns[0] = { check: "infinite scroll", result: "accepted", note: "the user approved it in Q-3" }; assert.deepEqual(errs(u), []);
});
test("self-approval: domain words pass, verdict phrasing in any free-text field fails", () => {
  const fp = strong();
  fp.creative_direction.rationale = "the approval button stays primary because reviewers approve orders all day";
  fp.ux_patterns[0].rationale = "not approved items are hidden behind a filter, matching the existing list";
  fp.criteria[0].evidence = "S1 success: the Approve button and the approval status column are visible at 375 and 1280 px";
  assert.deepEqual(errs(fp), []);
  for (const [set, where] of [
    [(d) => { d.creative_direction.rationale = "This design is approved."; }, "$.creative_direction.rationale: self-approval"],
    [(d) => { d.ux_patterns[0].rationale = "table chosen; the layout is production ready"; }, "$.ux_patterns[0].rationale: self-approval"],
    [(d) => { d.criteria[0].evidence = "meets all criteria, no issues remain"; }, "$.criteria[0].evidence: self-approval"],
    [(d) => { d.self_critique.anti_patterns[0].note = "fixed; LGTM"; }, "$.self_critique.anti_patterns[0].note: self-approval"],
    [(d) => { d.self_critique.consistency = "I sign off on consistency"; }, "$.self_critique.consistency: self-approval"],
  ]) { const d = strong(); set(d); has(errs(d), where); }
});
test("criteria: visual_proof marker, known criterion and screen, evidence", () => {
  const d = strong(); d.criteria[0].id = "AC-9"; has(errs(d, { root: repo, task }), "AC-9 is not an acceptance criterion");
  const s = strong(); s.criteria[0].screens = ["S7"]; has(errs(s), "unknown screen S7");
  const v = strong(); v.criteria[0].visual_proof = "yes"; has(errs(v), "required or not_required");
  const e = strong(); delete e.criteria[0].evidence; has(errs(e), "visual_proof required");
  const u = strong(); u.criteria.push({ ...u.criteria[1] }); has(errs(u), "duplicate criterion");
  assert.deepEqual(visualProofList(strong()), ["AC-1"]);
  assert.deepEqual(visualProofList(good()), []);
});
test("CLI: --task, --class and --list-visual-proof", () => {
  const f = join(repo, "strong.json"), t = join(repo, "TASK.md"), g = join(repo, "good.json");
  writeFileSync(f, JSON.stringify(strong())); writeFileSync(t, TASK); writeFileSync(g, JSON.stringify(good()));
  const out = spawnSync("node", [script, f, "--root", repo, "--task", t, "--list-visual-proof"], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { schema: "ui-design.visual-proof/1", required: ["AC-1"] });
  assert.equal(spawnSync("node", [script, g, "--task", t]).status, 1);
  assert.equal(spawnSync("node", [script, g, "--class", "STANDARD", "--task", t]).status, 0);
  assert.equal(spawnSync("node", [script, g, "--class", "STANDARD"]).status, 2);
  assert.equal(spawnSync("node", [script, "--list-visual-proof", "--design-md", t]).status, 2);
  assert.equal(spawnSync("node", [script, g, "--bogus"]).status, 2);
});
test("SKILL.md points to the A81 references; the references exist", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  for (const r of ["CREATIVE-DIRECTION.md", "UX-PATTERNS.md", "SELF-CRITIQUE.md"]) {
    assert.ok(t.includes(`references/${r}`), r);
    readFileSync(join(skill, "references", r));
  }
  assert.match(t, /never gives? final quality approval/i);
});
test("SKILL.md frontmatter and schema", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(t, /^---\nname: ui-design\n/);
  assert.ok(t.split("\n").length < 500);
  JSON.parse(readFileSync(join(skill, "schema/ui.schema.json"), "utf8"));
});

test("native mobile spec without keyboard passes; web spec still needs keyboard", () => {
  const n = good(); n.target = "ios"; delete n.screens[0].keyboard;
  assert.deepEqual(errs(n), []);
  const w = good(); delete w.screens[0].keyboard; has(errs(w), "keyboard");
  const w2 = good(); w2.target = "web"; delete w2.screens[0].keyboard; has(errs(w2), "keyboard");
});
test("native mobile still requires screen_reader and rejects an empty keyboard or unknown target", () => {
  const n = good(); n.target = "android"; delete n.screens[0].screen_reader; has(errs(n), "screen_reader");
  const e = good(); e.target = "flutter"; e.screens[0].keyboard = []; has(errs(e), "keyboard");
  const t = good(); t.target = "desktop"; has(errs(t), "$.target");
});
