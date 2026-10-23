// ui-design craft rules (A170): visitor mode, argument, the library deal and its replay in the validator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skill = join(dirname(fileURLToPath(import.meta.url)), "../../skills/ui-design");
const { validate } = await import(join(skill, "scripts/validate-ui.mjs"));
const { deal, dealIds, loadLibrary } = await import(join(skill, "scripts/deal.mjs"));
const DEAL = join(skill, "scripts/deal.mjs");
const lib = loadLibrary();

const repo = mkdtempSync(join(tmpdir(), "ui-craft-"));
for (const d of ["docs/product", "docs/design", "src"]) mkdirSync(join(repo, d), { recursive: true });
writeFileSync(join(repo, "docs/product/PRODUCT.md"), "# Product\n## Menu\nThe menu changes every day.\n");
writeFileSync(join(repo, "src/menu.js"), "");
writeFileSync(join(repo, "docs/design/IMAGES.md"), "# Images\n");
writeFileSync(join(repo, "src/title.woff2"), "");
writeFileSync(join(repo, "src/LICENSE.txt"), "licence text");

const BRIEF = { mode: "persuade", sector: "restaurant", imagery: ["none"], sections: ["hook", "proof", "cta"] };
const record = (seed = 7, brief = BRIEF) => { const r = deal(brief, seed, [], lib); return { inputs: brief, seed, ...dealIds(r) }; };
const st = (c) => ({ copy: c, behavior: `shows ${c}` });
const persuade = () => {
  const d = record();
  const names = [...d.dealt.map((x) => x.direction), `standard-${d.standard.direction}`];
  return {
    schema_version: 1, mode: "task", ui_languages: ["en"],
    design_system: { file: "docs/DESIGN.md", exists: false },
    visitor_mode: { mode: "persuade", reason: "a restaurant landing page: the visitor must be persuaded to book" },
    reused: [], new: [],
    screens: [{
      id: "S1", name: "Landing", route: "/",
      states: { empty: st("No dishes today"), loading: st("Loading the menu"), error: st("The menu could not load. Retry"), success: st("Table booked"), partial: st("Showing 5 dishes"), "permission-denied": { not_applicable: "public page" } },
      keyboard: ["Tab reaches the book button first"], screen_reader: ["Sections are landmarks with headings"], responsive: ["single column below 640px"],
      first_screen: { headline: "Dinner that changes every day", subline: "A small kitchen cooking what the market sold this morning.", primary_actions: ["Book a table"] },
    }],
    flows: [{ id: "F1", name: "Book", steps: ["open", "book"], screens: ["S1"] }],
    argument: [{ screen: "S1", section: "hook", claim: "The menu changes daily", proof: { kind: "product-fact", file: "docs/product/PRODUCT.md", ref: "Menu" } },
      { screen: "S1", section: "proof", claim: "Dishes come from the live menu", proof: { kind: "code", path: "src/menu.js" } }],
    creative_direction: {
      basis: "new", visual_character: "warm printed menu", typography: "serif text", layout: "one artefact panel", hierarchy: "name, menu, book", rationale: "a menu is the object guests already know",
      avoided: ["cream serif with terracotta: a default, not this kitchen"],
      topic_inventory: ["menu card", "daily dish", "market receipt", "chalkboard", "table number", "wine list", "kitchen pass", "reservation book"],
      idea: { sentence: "On this page, the market receipt becomes the menu.", rival: "Nearby Bistro", rival_swap: "no_longer_true", note: "their menu is not built from a receipt" },
      deal: d, alternatives: names.map((n, i) => ({ name: n, summary: `direction ${n}`, trade_off: "needs real copy", ...(i === names.length - 1 ? { standard: true } : {}) })), chosen: names[0],
    },
    craft: {
      live_thing: { description: "type a party size and see tonight's free slots", phone_ok: true, no_script_fallback: "the slots are listed as text", does_not_block_reading: true },
      visual_plan: { real: ["none"], images: [], ledger: "docs/design/IMAGES.md" },
      motion: { thesis: "the receipt prints line by line", signature: "line print on load", stagger_ms: 70, feedback_all_controls: true, moving_visual: "the printing receipt", reduced_motion: "static receipt" },
      fonts: [{ family: "EB Garamond", file: "src/title.woff2", license: "OFL", license_ref: "library:EB Garamond" }],
    },
  };
};
const errs = (d) => validate(d, { root: repo });
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("a complete persuade spec is valid", () => assert.deepEqual(errs(persuade()), []));

test("a persuade spec without visitor_mode or without argument is rejected", () => {
  const a = persuade(); delete a.visitor_mode; has(errs(a), "visitor_mode");
  const b = persuade(); delete b.argument; has(errs(b), "needs an argument");
  const c = persuade(); c.argument[0].proof = { kind: "code", path: "src/gone.js" }; has(errs(c), "does not exist");
});

test("a font without a verifiable licence is rejected by the validator", () => {
  const d = persuade(); d.craft.fonts[0].license_ref = "library:Made Up Display"; has(errs(d), "not in the bundled licence directory");
  const e = persuade(); delete e.craft.fonts[0].license_ref; has(errs(e), "unverifiable font");
});

test("the validator replays the deal and rejects a tampered dealt", () => {
  const d = persuade(); d.creative_direction.deal.dealt[0].hero = "invented-hero"; has(errs(d), "does not match the deal");
});

test("deal: same brief and seed give the same result; another seed differs somewhere", () => {
  assert.deepEqual(deal(BRIEF, 11, [], lib), deal(BRIEF, 11, [], lib));
  const sets = new Set([1, 2, 3, 4, 5, 6].map((s) => JSON.stringify(dealIds(deal(BRIEF, s, [], lib)).dealt)));
  assert.ok(sets.size > 1);
});

test("deal never picks a direction or hero whose needs the imagery lacks", () => {
  const needing = lib.directions.filter((d) => d.needs.length).map((d) => d.id);
  assert.ok(needing.length > 0, "the library should hold directions that need imagery");
  for (const sector of ["restaurant", "dev-tool", "saas"]) for (let seed = 0; seed < 25; seed++) {
    const r = deal({ ...BRIEF, sector }, seed, [], lib);
    assert.equal(r.status, "ok");
    for (const x of [...r.dealt, r.standard]) {
      assert.ok(!needing.includes(x.direction.id), `${x.direction.id} needs imagery (${sector}, seed ${seed})`);
      assert.deepEqual(lib.heroes.find((h) => h.id === x.hero.id).needs, [], `${x.hero.id} needs imagery`);
    }
  }
});

test("deal never offers a type system whose licence cannot be verified", () => {
  const r = deal(BRIEF, 7, [], lib);
  const fresh = loadLibrary();
  const id = r.dealt[0].type.id;
  fresh.fonts.systems[id].verdict = "unverifiable";
  for (const x of deal(BRIEF, 7, [], fresh).dealt) assert.notEqual(x.type.id, id);
  for (let seed = 0; seed < 20; seed++) for (const x of deal(BRIEF, seed, [], lib).dealt) assert.notEqual(lib.fonts.systems[x.type.id].verdict, "unverifiable");
});

const run = (args) => spawnSync("node", [DEAL, ...args], { encoding: "utf8" });
test("deal --redraw with a valid reason changes exactly one slot; a comfort reason is rejected", () => {
  const brief = join(repo, "brief.json");
  writeFileSync(brief, JSON.stringify(BRIEF));
  const base = JSON.parse(run(["--brief", brief, "--seed", "7"]).stdout);
  const red = run(["--brief", brief, "--seed", "7", "--redraw", "1.palette", "--reason", "brand-constraint: the brand palette is green and cream"]);
  assert.equal(red.status, 0, red.stderr);
  const out = JSON.parse(red.stdout);
  assert.equal(out.redraws.length, 1);
  const changed = [];
  base.dealt.forEach((b, i) => { for (const k of Object.keys(b.ids)) if (JSON.stringify(b.ids[k]) !== JSON.stringify(out.dealt[i].ids[k])) changed.push(`${i}.${k}`); });
  assert.deepEqual(changed, ["0.palette"]);
  assert.deepEqual(out.standard.ids, base.standard.ids);
  const bad = run(["--brief", brief, "--seed", "7", "--redraw", "1.palette", "--reason", "comfort: I prefer another look"]);
  assert.equal(bad.status, 2);
  // a recorded redraw is replayed by the validator
  const d = persuade(); d.creative_direction.deal.redraws = [{ slot: "1.palette", reason: "comfort: I prefer another look" }]; has(errs(d), "redraws[0].reason");
});
