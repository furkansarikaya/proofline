// A256 (Part of #181): `--help` and `--schema` of the validators that the reviewer, security reviewer, verifier and QA roles run.
// An agent that learns a format from the script's source or the JSON schema reads 8-19 KB; these outputs are 0.5-2.4 KB. They are generated from the header comment
// of the script and from the schema file, and pinned here against the real validator, so they cannot drift. No clock, no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { compactSchema as compactPR, validate as validatePR } from "../../skills/proof-review/scripts/validate-findings.mjs";
import { compactSchema as compactEP, validate as validateEP } from "../../skills/exploit-proof/scripts/validate-findings.mjs";

const file = (rel) => new URL(`../../${rel}`, import.meta.url);
const text = (rel) => readFileSync(file(rel), "utf8");
const run = (rel, ...args) => spawnSync(process.execPath, [file(rel).pathname, ...args], { encoding: "utf8" });
const clone = (o) => JSON.parse(JSON.stringify(o));

const SCRIPTS = {
  "proof-review": "skills/proof-review/scripts/validate-findings.mjs",
  "exploit-proof": "skills/exploit-proof/scripts/validate-findings.mjs",
  "verify-proof": "skills/verify-proof/scripts/validate-verify.mjs",
  "qa-plan": "skills/qa-plan/scripts/validate-qa.mjs",
};
const SCHEMAS = { "proof-review": "skills/proof-review/schema/findings.schema.json", "exploit-proof": "skills/exploit-proof/schema/findings.schema.json" };

// The header comment of a script, read a second way (a regular expression over the text, not the line loop of the script).
const header = (rel) => /^#![^\n]*\n((?:\/\/[^\n]*\n)+)/.exec(text(rel))[1].replace(/^\/\/ ?/gm, "");

for (const [skill, rel] of Object.entries(SCRIPTS)) {
  test(`${skill}: --help prints the header of the script and exits 0`, () => {
    const r = run(rel, "--help");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, header(rel));
  });

  test(`${skill}: every option the script reads is in --help and every option --help names is read`, () => {
    const src = text(rel);
    const read = new Set([...src.matchAll(/"(--[a-z][a-z-]*)"/g)].map((m) => m[1]));
    const named = new Set([...header(rel).matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]));
    for (const o of read) assert.ok(named.has(o), `${rel} reads ${o} but --help does not name it`);
    for (const o of named) assert.ok(read.has(o), `--help of ${rel} names ${o} but the script never reads it`);
    // A usage error points at --help.
    const bad = run(rel);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--help/);
  });
}

test("qa-plan: --help states every category the validator knows", async () => {
  const { CATEGORIES } = await import("../../skills/qa-plan/scripts/validate-qa.mjs");
  const h = run(SCRIPTS["qa-plan"], "--help").stdout;
  for (const c of CATEGORIES) assert.ok(h.includes(c), `--help lacks the category ${c}`);
});

test("--schema: equals the compact projection of the schema file, small, and one block of code in both skills", () => {
  const legend = /^# .*\n/;
  for (const [skill, fn] of [["proof-review", compactPR], ["exploit-proof", compactEP]]) {
    const r = run(SCRIPTS[skill], "--schema");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, legend);
    assert.equal(r.stdout.replace(legend, ""), fn(JSON.parse(text(SCHEMAS[skill]))));
    const schemaBytes = Buffer.byteLength(text(SCHEMAS[skill]));
    const scriptBytes = Buffer.byteLength(text(SCRIPTS[skill]));
    assert.ok(Buffer.byteLength(r.stdout) * 3 < schemaBytes, `${skill} --schema is not under a third of the schema file`);
    assert.ok(Buffer.byteLength(r.stdout) * 4 < scriptBytes, `${skill} --schema is not under a quarter of the script`);
  }
  const block = (rel) => /\/\/ compact-schema:begin\n[\s\S]*?\/\/ compact-schema:end\n/.exec(text(rel))[0];
  assert.equal(block(SCRIPTS["proof-review"]), block(SCRIPTS["exploit-proof"]));
});

test("--help is a fraction of the script that holds it", () => {
  for (const skill of ["verify-proof", "qa-plan"]) {
    const h = Buffer.byteLength(run(SCRIPTS[skill], "--help").stdout);
    assert.ok(h * 8 < Buffer.byteLength(text(SCRIPTS[skill])), `${skill} --help is not under an eighth of the script`);
  }
});

test("compactSchema: $ref, allOf of refs, oneOf, enum, const, pattern, conditionals, open objects (known answer)", () => {
  const schema = {
    type: "object", additionalProperties: false, required: ["id", "kind", "loc", "alt"],
    $defs: { loc: { type: "object", additionalProperties: false, required: ["file", "line"], properties: { file: { type: "string", pattern: "\\S" }, line: { type: "integer", minimum: 1 } } } },
    properties: {
      id: { type: "string", pattern: "^X\\d{3}$" }, kind: { enum: ["a", "b"] }, note: { type: "string", minLength: 1 }, loc: { $ref: "#/$defs/loc" },
      alt: { oneOf: [{ type: "object", additionalProperties: false, required: ["s"], properties: { s: { const: "ran" } } }, { type: "string" }] },
      rows: { type: "array", items: { type: "object", additionalProperties: false, required: ["k"], properties: { k: { type: "string" }, extra: true },
        allOf: [{ if: { properties: { k: { const: "x" } } }, then: { required: ["extra"] } }] } },
      free: { type: "object", properties: { z: { type: "number" } } },
    },
  };
  assert.equal(compactPR(schema), [
    "$ id*:string /^X\\d{3}$/ kind*:a|b note?:str+ loc*:{file*:text line*:integer>=1} alt*:({s*:=\"ran\"} | string) rows?:[see $.rows[]] free?:{z?:number}+open",
    "$.rows[] k*:string extra?:any",
    "$.rows[] when {\"k\":{\"const\":\"x\"}} then {\"required\":[\"extra\"]}",
    "",
  ].join("\n"));
});

// ---- the shape --schema prints, against the real validators -------------------------------------------------------------------------------------------------

const loc = (file, line) => ({ file, line });
const PR_DOC = {
  schema_version: 1, skill_version: "0.0.1", generated_at: "2026-10-08T12:00:00Z",
  target: { type: "branch", name: "feature/discount", slug: "feature-discount", base: "aaa111", head: "bbb222" },
  scope: { changed_files: 2, changed_lines: 40, excluded: ["package-lock.json"], not_reviewed: [{ path: "docs/", reason: "docs only" }], rule_files_read: ["CLAUDE.md"], rule_files_not_read: [] },
  claims: [{ id: "C001", text: "codes are case-insensitive", source: "user", status: "partial", locations: [loc("src/shop.ts", 12)], missing_part: "route still registered" }],
  rules: [{ id: "R001", rule: "No business logic in controllers", source: loc("CLAUDE.md", 7), location: loc("src/shop.ts", 12), violation: "The handler computes the discount itself." }],
  unrequested: [{ id: "U001", files: ["src/log.ts"], description: "Adds request logging." }],
  bugs: [{ id: "F001", evidence: "reproduced", location: loc("src/shop.ts", 12), input: "save10", expected: "90", actual: "100", impact: "A customer pays full price.",
    reproduction: { file: "evidence/F001/repro.test.ts", command: "npx vitest run", output: "evidence/F001/output.txt" }, status: "open" }],
  suspicions: [{ id: "S001", location: loc("src/shop.ts", 12), reason: "unbounded retry", why_unproven: "no failing input found" }],
};
const EP_DOC = {
  schema_version: 1, skill_version: "0.1.0", generated_at: "2026-01-02T03:04:05Z",
  target: { type: "working_tree", name: "demo", base: "abc1234", head: null },
  scope: { changed_files: 2, entry_points: [{ id: "E001", kind: "http", location: loc("src/routes.js", 5), description: "GET /search" }], not_reviewed: [] },
  execution: { status: "ran", test_command: "node --test", worktree: "/work/exploit-proof-demo" },
  findings: [{
    id: "SECURITY-1", status: "open", title: "Search term reaches a raw query", sink: "sql", severity: "high", impact: "A caller can read rows of other tenants.", entry_point: "E001",
    input: { source: "query parameter q", value: "x' OR '1'='1" }, location: loc("src/store.js", 42),
    path: [{ ...loc("src/routes.js", 10), step: "q is read" }, { ...loc("src/store.js", 42), step: "q is concatenated" }],
    guards: [{ location: loc("src/routes.js", 8), why_it_fails: "only checks that q is non-empty" }],
    evidence: "traced", why_not_reproduced: "no database in the sandbox", refutation: { verdict: "stands", citations: [loc("src/store.js", 42)] },
  }],
  suspicions: [],
};

// Walks the schema file along a valid document: every object with `properties` yields its path, its required keys and its property names in order.
function nodes(schema, doc) {
  const defs = schema.$defs ?? {};
  const res = (n) => {
    n = n.$ref ? defs[n.$ref.split("/").pop()] : n;
    const merged = { ...n, properties: { ...n.properties }, required: [...(n.required ?? [])] };
    for (const c of n.allOf ?? []) if (!c.if) { const r = res(c); merged.required.push(...(r.required ?? [])); Object.assign(merged.properties, Object.fromEntries(Object.entries(r.properties ?? {}).filter(([k, v]) => v !== true || !(k in merged.properties)))); }
    return merged;
  };
  const out = [];
  (function walk(n, value, path) {
    n = res(n);
    if (n.type === "array" && n.items) { if (Array.isArray(value) && value.length) walk(n.items, value[0], `${path}[]`); return; }
    if (!n.properties || !value || typeof value !== "object") return;
    out.push({ path, required: n.required, keys: Object.keys(n.properties), value, enums: Object.entries(n.properties).map(([k, v]) => [k, res(v).enum]).filter(([, e]) => e), closed: n.additionalProperties === false || n.unevaluatedProperties === false });
    for (const [k, v] of Object.entries(n.properties)) if (v !== true && k in value) walk(v, value[k], `${path}.${k}`);
  })(schema, doc, "$");
  return out;
}

for (const [skill, validate, valid] of [["proof-review", validatePR, PR_DOC], ["exploit-proof", validateEP, EP_DOC]]) {
  test(`${skill}: the validator accepts the fixture; every key --schema marks required is required, every enum value listed is the validator's, unknown keys are refused`, () => {
    assert.deepEqual(validate(clone(valid)), []);
    const out = run(SCRIPTS[skill], "--schema").stdout;
    const found = nodes(JSON.parse(text(SCHEMAS[skill])), valid);
    assert.ok(found.length >= 10, "the walk must reach the nested objects");
    for (const n of found) {
      // The printed marks: scan the output for each key of the node in schema order, `*` iff required.
      let pos = Math.max(0, out.indexOf(`\n${n.path} `));
      if (n.path !== "$" && !out.includes(`\n${n.path} `)) pos = 0; // an object printed inline inside its parent's line
      for (const k of n.keys) {
        const mark = n.required.includes(k) ? "*" : "?";
        const at = out.indexOf(`${k}${mark}:`, pos);
        assert.ok(at >= 0, `--schema does not print ${n.path}.${k}${mark} in order`);
        pos = at;
      }
      for (const [k, e] of n.enums) assert.ok(out.includes(e.join("|")), `--schema does not print the enum of ${n.path}.${k}`);
      // The validator refuses a value outside each listed enum.
      for (const [k] of n.enums) {
        const d = clone(valid);
        const at = n.path.replace(/^\$\.?/, "").split(/\.|(?=\[\])/).filter(Boolean).reduce((o, p) => (p === "[]" ? o[0] : o[p]), d);
        at[k] = "zz_not_in_enum";
        assert.ok(validate(d).some((m) => m.includes(k)), `the validator accepts a value outside the enum of ${n.path}.${k}`);
      }
      // The validator really requires them.
      for (const k of n.required) {
        const d = clone(valid);
        const at = n.path.replace(/^\$\.?/, "").split(/\.|(?=\[\])/).filter(Boolean).reduce((o, p) => (p === "[]" ? o[0] : o[p]), d);
        delete at[k];
        const errs = validate(d);
        assert.ok(errs.some((m) => m.includes(k)), `the validator does not require ${n.path}.${k}: ${errs.join(" | ")}`);
      }
      // The hand-written exploit-proof validator refuses unknown keys in five places only (its schema file is stricter); the proof-review validator in all of them (A256 lists the difference).
      if (n.closed && (skill === "proof-review" || ["$", "$.findings[]", "$.findings[].input", "$.findings[].reproduction", "$.suspicions[]"].includes(n.path))) {
        const d = clone(valid);
        const at = n.path.replace(/^\$\.?/, "").split(/\.|(?=\[\])/).filter(Boolean).reduce((o, p) => (p === "[]" ? o[0] : o[p]), d);
        at.zz_unknown = 1;
        assert.ok(validate(d).some((m) => m.includes("zz_unknown")), `the validator accepts an unknown key in ${n.path}`);
      }
    }
  });
}

test("the skill texts point to --help and --schema instead of the script and the schema file", () => {
  assert.match(text("skills/proof-review/references/REPORTING.md"), /validate-findings\.mjs --schema/);
  assert.match(text("skills/proof-review/SKILL.md"), /--schema.*--help/);
  assert.match(text("skills/exploit-proof/references/REPORTING.md"), /validate-findings\.mjs --schema/);
  assert.match(text("skills/exploit-proof/SKILL.md"), /validate-findings\.mjs --schema/);
  assert.match(text("skills/verify-proof/SKILL.md"), /validate-verify\.mjs --help/);
  assert.match(text("skills/qa-plan/SKILL.md"), /validate-qa\.mjs --help/);
});
