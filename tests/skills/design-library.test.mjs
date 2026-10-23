// Design library and registries (A170): notices carry a licence per source, source names stay inside the notices file,
// the pattern registry agrees across both skills, and visual-proof's ux-rules.json matches the library table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const lib = join(root, "skills/ui-design/library");
const vp = join(root, "skills/visual-proof");
const read = (p) => readFileSync(join(root, p), "utf8");
const notices = read("skills/ui-design/library/THIRD_PARTY_NOTICES.md");

const sources = [...notices.matchAll(/^- (source-\d+) \| ([^|]+?) \| (\S+)\s*$/gm)].map((m) => ({ id: m[1], name: m[2], url: m[3] }));
const section = (id) => notices.split(/^## /m).find((s) => s.startsWith(`${id}\n`)) || "";

test("every included source has a licence text and its files listed in the notices", () => {
  assert.ok(sources.length >= 2, "the notices list their sources in the header");
  for (const s of sources) {
    const sec = section(s.id);
    const licence = /```text\n([\s\S]*?)```/.exec(sec)?.[1] || "";
    assert.match(licence, /Permission is hereby granted/, `${s.id}: licence text`);
    assert.match(licence, /Copyright/, `${s.id}: copyright line`);
    assert.match(sec, /- Commit: [0-9a-f]{40}/, `${s.id}: pinned commit`);
    const files = [...sec.matchAll(/^  - `([^`]+)` sha256 [0-9a-f]{64}$/gm)].map((m) => m[1]);
    assert.ok(files.length > 0, `${s.id}: files listed`);
    for (const f of files) assert.ok(existsSync(join(lib, f)), `${s.id}: ${f} exists in the library`);
  }
});

test("source names appear in the notices file only (README, CHANGELOG, skill texts)", () => {
  const skillTexts = readdirSync(join(root, "skills")).map((d) => `skills/${d}/SKILL.md`).filter((p) => existsSync(join(root, p)));
  for (const f of ["README.md", "CHANGELOG.md", ...skillTexts]) {
    const text = read(f).toLowerCase();
    for (const s of sources) {
      assert.ok(!text.includes(s.name.toLowerCase()), `${f} names ${s.id}: say "source N" or leave it out`);
      assert.ok(!text.includes(s.url.replace(/^https?:\/\//, "").toLowerCase()), `${f} holds the address of ${s.id}`);
    }
  }
});

test("the pattern registry agrees between ui-design and visual-proof", async () => {
  const { PATTERN_IDS: uiIds } = await import(join(root, "skills/ui-design/scripts/validate-ui.mjs"));
  const { PATTERN_IDS: vpIds } = await import(join(vp, "scripts/patterns.mjs"));
  const prose = [...read("skills/ui-design/references/PATTERNS.md").matchAll(/^\| `([a-z][a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...vpIds].sort(), [...prose].sort(), "PATTERNS.md vs patterns.mjs");
  assert.deepEqual([...uiIds].sort(), [...vpIds].sort(), "validate-ui.mjs vs patterns.mjs");
  const date = /Registry date: (\d{4}-\d{2}-\d{2})/.exec(read("skills/ui-design/references/PATTERNS.md"))?.[1];
  const { REGISTRY_DATE } = await import(join(vp, "scripts/patterns.mjs"));
  assert.equal(date, REGISTRY_DATE);
});

test("ux-rules.json: ids are rows of the library table and every measure is judged or a known check", async () => {
  const b = join(vp, "scripts/build-ux-rules.mjs");
  const chk = spawnSync("node", [b, "--library", lib, "--check"], { encoding: "utf8" });
  assert.equal(chk.status, 0, chk.stderr);
  const { buildRules } = await import(b);
  const rows = new Set(buildRules(readFileSync(join(lib, "ux-guidelines.csv"), "utf8")).map((r) => r.id));
  const { DESIGN_CHECKS } = await import(join(vp, "scripts/design-audit.mjs"));
  const { CHECKS } = await import(join(vp, "scripts/validate-visual.mjs"));
  const known = new Set(["judged", ...DESIGN_CHECKS, ...CHECKS]);
  const rules = JSON.parse(readFileSync(join(vp, "ux-rules.json"), "utf8")).rules;
  assert.ok(rules.length > 0);
  for (const r of rules) {
    assert.ok(rows.has(r.id), `${r.id} is not a row of ux-guidelines.csv`);
    assert.ok(known.has(r.measure), `${r.id}: unknown measure ${r.measure}`);
    assert.ok(["high", "medium", "low"].includes(r.severity), `${r.id}: severity`);
  }
});
