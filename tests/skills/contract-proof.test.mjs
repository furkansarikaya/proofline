import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, "../../skills/contract-proof");
const fixture = join(here, "../../fixtures/contract-proof");
const DIFF = join(skill, "scripts/diff-contract.mjs");
const VALIDATE = join(skill, "scripts/validate-contract.mjs");
const { RULES, parseYaml, parseJson, diffFile, coverage, planBullets, consumersFrom } = await import(DIFF);
const { validate, gate } = await import(VALIDATE);
const EXPECTED = JSON.parse(readFileSync(join(fixture, "EXPECTED.json"), "utf8"));
const SCHEMA = JSON.parse(readFileSync(join(skill, "schema/contract.schema.json"), "utf8"));
const RULES_MD = readFileSync(join(skill, "references/RULES.md"), "utf8");

let base;
before(() => { base = mkdtempSync(join(tmpdir(), "cpfx-")); });
after(() => rmSync(base, { recursive: true, force: true }));

const changes = (path, a, b) => diffFile(path, a, b, { explicit: true });
const rules = (r) => r.changes.map((c) => `${c.rule} ${c.side} ${c.element}`).sort();
const oas = (schemaYaml, where = "response") => {
  const body = schemaYaml.split("\n").map((l) => " ".repeat(where === "response" ? 16 : 14) + l).join("\n");
  return where === "response"
    ? `openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema:\n${body}\n`
    : `openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    post:\n      requestBody:\n        content:\n          application/json:\n            schema:\n${body}\n      responses:\n        "204":\n          description: ok\n`;
};

// ---- rules table --------------------------------------------------------------------------------
test("every rule id is documented in RULES.md and has a valid classification", () => {
  for (const [id, [cls]] of Object.entries(RULES)) {
    assert.match(RULES_MD, new RegExp("`" + id + "`"), `${id} missing from RULES.md`);
    assert.ok(["breaking", "non-breaking", "needs-review"].includes(cls));
  }
  for (const m of RULES_MD.matchAll(/`(CP-[BNU]\d\d)`/g)) assert.ok(RULES[m[1]], `${m[1]} in RULES.md but not in the script`);
});

// ---- YAML subset ----------------------------------------------------------------------------------
test("YAML subset parses mappings, sequences, flow, quotes, block scalars and comments", () => {
  const d = parseYaml(`# c\na: 1\nb: "x: y" # trailing\nc: 'it''s'\nd: [1, two, {k: v}]\ne:\n  - name: n\n    in: path\n  - plain\nf: |\n  line1\n  line2\ng: ~\nh: true\n"200":\n  ok: 3.5\n`);
  assert.deepEqual(d, { a: 1, b: "x: y", c: "it's", d: [1, "two", { k: "v" }], e: [{ name: "n", in: "path" }, "plain"], f: "line1\nline2", g: null, h: true, 200: { ok: 3.5 } });
});
test("YAML outside the subset is refused, never guessed", () => {
  for (const bad of ["a: &x 1\nb: *x\n", "a: !!str 1\n", "a: 1\n---\nb: 2\n", "? a\n: b\n", "<<: {a: 1}\n", "a: b\n  c\n", "a: 1\na: 2\n", "a: [1,\n  2]\n", "a:\n\tb: 1\n"]) {
    assert.throws(() => parseYaml(bad), undefined, JSON.stringify(bad));
  }
});
test("JSON parser keeps values identical to JSON.parse", () => {
  const t = '{"a": [1, 2.5, -3e2, true, null, "s\\"q"], "b": {"c": {}}}';
  assert.deepEqual(parseJson(t), JSON.parse(t));
  assert.throws(() => parseJson('{"a": 1,}'));
});

// ---- direction rules -----------------------------------------------------------------------------
const reqBase = "type: object\nproperties:\n  a:\n    type: string\n    maxLength: 10";
test("request side: a new required field is breaking even with a default; an optional one is not", () => {
  const head = "type: object\nrequired: [b]\nproperties:\n  a:\n    type: string\n    maxLength: 10\n  b:\n    type: string\n    default: x";
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(head, "request"))), ["CP-B05 request b"]);
  const opt = "type: object\nproperties:\n  a:\n    type: string\n    maxLength: 10\n  b:\n    type: string";
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(opt, "request"))), ["CP-N01 request b"]);
});
test("constraints and requiredness flip with the direction", () => {
  const narrow = reqBase.replace("maxLength: 10", "maxLength: 5");
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(narrow, "request"))), ["CP-B09 request a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase), oas(narrow))), ["CP-N06 response a"]);
  const req = reqBase.replace("type: object\n", "type: object\nrequired: [a]\n");
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(req, "request"))), ["CP-B04 request a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase), oas(req))), ["CP-N06 response a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(req), oas(reqBase))), ["CP-B04 response a"]);
});
test("enum: removal breaks; addition is CP-N03 on request and CP-N04 on response", () => {
  const e = (v) => `type: string\nenum: [${v}]`;
  assert.deepEqual(rules(changes("o.yaml", oas(e("a, b")), oas(e("a")))), ["CP-B06 response b"]);
  assert.deepEqual(rules(changes("o.yaml", oas(e("a")), oas(e("a, b")))), ["CP-N04 response b"]);
  assert.deepEqual(rules(changes("o.yaml", oas(e("a"), "request"), oas(e("a, b"), "request"))), ["CP-N03 request b"]);
});
test("type changes and unknown keywords", () => {
  assert.deepEqual(rules(changes("o.yaml", oas("type: string"), oas("type: integer"))), ["CP-B03 response 200"]);
  assert.deepEqual(rules(changes("o.yaml", oas("type: integer", "request"), oas("type: number", "request"))), ["CP-N06 request POST /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas("type: string"), oas("type: string\nreadOnly: true"))), ["CP-U01 response 200"]);
});
test("$ref refactor with the same shape is no change; a recursive schema does not loop", () => {
  const inline = oas("type: object\nproperties:\n  id:\n    type: string");
  const viaRef = inline.replace("              schema:\n                type: object\n                properties:\n                  id:\n                    type: string\n", "              schema:\n                $ref: '#/components/schemas/X'\n") +
    "components:\n  schemas:\n    X:\n      type: object\n      properties:\n        id:\n          type: string\n";
  assert.deepEqual(changes("o.yaml", inline, viaRef).changes, []);
  const rec = (extra) => `openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/N'\ncomponents:\n  schemas:\n    N:\n      type: object\n      properties:\n        next:\n          $ref: '#/components/schemas/N'\n${extra}`;
  const r = changes("o.yaml", rec(""), rec("        v:\n          type: string\n"));
  assert.deepEqual(rules(r), ["CP-N01 response v"]);
});
test("operations, status codes and parameters", () => {
  const base = "openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      parameters:\n        - name: q\n          in: query\n      responses:\n        \"200\":\n          description: ok\n        \"404\":\n          description: no\n  /b:\n    get:\n      responses:\n        \"200\":\n          description: ok\n";
  const head = "openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      parameters:\n        - name: q\n          in: query\n          required: true\n        - name: r\n          in: header\n          required: true\n      responses:\n        \"200\":\n          description: ok\n";
  assert.deepEqual(rules(changes("o.yaml", base, head)), ["CP-B01 both /b", "CP-B04 request q", "CP-B05 request r", "CP-B08 response 404"]);
});

// ---- GraphQL and protobuf ------------------------------------------------------------------------
test("GraphQL: removals, nullability by direction, args with and without defaults", () => {
  const a = "type Q {\n  a: String!\n  b(x: Int): String\n  gone: Int\n}\ninput I {\n  f: String\n}\nenum E {\n  X\n  Y\n}\n";
  const b = "type Q {\n  a: String\n  b(x: Int!, y: Int!, z: Int! = 1): String\n}\ninput I {\n  f: String!\n}\nenum E {\n  X\n}\n";
  assert.deepEqual(rules(changes("s.graphql", a, b)), ["CP-B02 response gone", "CP-B04 request f", "CP-B04 request x", "CP-B05 request y", "CP-B06 both Y", "CP-B09 response a", "CP-N10 request z"]);
  const r = changes("s.graphql", "type Q {\n  a(x: Int,\n    y: Int): String\n}\n", "type Q {\n  a: String\n}\n");
  assert.equal(r.status, "unsupported");
});
test("protobuf: renumbering, type change, removal, rpc change; unparseable is unsupported", () => {
  const a = 'syntax = "proto3";\nmessage M {\n  string a = 1;\n  int32 b = 2;\n  int32 c = 3;\n}\nservice S {\n  rpc Get (M) returns (M);\n}\n';
  const b = 'syntax = "proto3";\nmessage M {\n  string a = 4;\n  int64 b = 2;\n}\nmessage R {\n  string x = 1;\n}\nservice S {\n  rpc Get (M) returns (R);\n}\n';
  assert.deepEqual(rules(changes("m.proto", a, b)), ["CP-B02 both c", "CP-B03 both Get", "CP-B03 both b", "CP-B10 both a", "CP-N02 both R"]);
  assert.equal(changes("m.proto", a, "message M { string a = 1; }\n").status, "unsupported");
});
test("unknown or unsupported formats are UNSUPPORTED, never compared as a pass", () => {
  assert.equal(changes("x.avsc", "{}", "{}").status, "unsupported");
  assert.equal(changes("x.thrift", "a", "b").status, "unsupported");
  assert.equal(changes("x.yaml", "a: 1\n", "a: 2\n").status, "unsupported"); // not a contract document
});

// ---- coverage --------------------------------------------------------------------------------------
test("coverage needs the file, the element and versioning/migration/deprecation", () => {
  const bullets = planBullets("# P\n\n## Contracts\n\n- `api/o.yaml` `email`: removed, refactor only.\n- `o.yaml` `name` removed: deprecation window 30 days.\n- `other.yaml` `zip` removed: migration done.\n\n## Next\n- `o.yaml` `zip` migration\n");
  const ch = (element, classification = "breaking") => ({ element, classification });
  assert.equal(coverage("api/o.yaml", ch("email"), bullets).covered, false);
  assert.deepEqual(coverage("api/o.yaml", ch("name"), bullets), { covered: true, plan_line: 6, text: "- `o.yaml` `name` removed: deprecation window 30 days." });
  assert.equal(coverage("api/o.yaml", ch("zip"), bullets).covered, false, "other file and a bullet outside ## Contracts");
  assert.equal(coverage("api/o.yaml", ch("nam"), bullets).covered, false, "element is a whole word");
  assert.equal(coverage("api/o.yaml", ch("name", "non-breaking"), bullets).covered, false);
});
test("consumers from an impact report skip prose and keep outside consumers unknown", () => {
  const imp = { symbols: [{ name: "x", references: [{ path: "PLAN.md", line: 3, kind: "textual", role: "doc" }, { path: "a.js", line: 2, kind: "heuristic", role: "reference" }] }] };
  assert.deepEqual(consumersFrom(imp, "x"), { source: "impact", in_repo: [{ path: "a.js", line: 2, kind: "heuristic" }], outside_repo: "unknown" });
  assert.equal(consumersFrom(imp, "y").source, "not-searched");
});

// ---- validator --------------------------------------------------------------------------------------
const change = (over = {}) => ({
  id: "C-1", location: "/x", element: "x", side: "response", rule: "CP-B02", classification: "breaking", before: "present", after: null,
  line: 3, line_in: "base", evidence: { class: "measured", source: "diff-contract.mjs" },
  coverage: { covered: false, plan_line: null, text: null }, consumers: { source: "impact", in_repo: [], outside_repo: "unknown" }, ...over,
});
const doc = (files, over = {}) => ({ schema_version: 1, target: { base: "b", head: "h" }, tools: { detected: [], used: [] }, plan: { path: null, contracts_bullets: 0 }, files, judged: [], ...over });
const file = (chs, over = {}) => ({ path: "o.yaml", format: "openapi", change: "modified", status: "compared", changes: chs, ...over });
const bad = (d, re) => { const e = validate(d); assert.ok(e.some((m) => re.test(m)), `no error ${re}: ${e.join(" | ")}`); };

test("validator: gate results", () => {
  assert.equal(gate(doc([file([change()])])).result, "FAIL");
  const cov = change({ coverage: { covered: true, plan_line: 4, text: "- o.yaml `x` removed: migration in place" } });
  assert.deepEqual(validate(doc([file([cov])])), []);
  assert.equal(gate(doc([file([cov])])).result, "PASS");
  const nb = change({ rule: "CP-N01", classification: "non-breaking", consumers: { source: "not-searched", in_repo: [], outside_repo: "unknown" } });
  assert.equal(gate(doc([file([nb])])).result, "PASS");
  const un = file([], { path: "l.yaml", format: "yaml", status: "unsupported", reason: "anchor" });
  assert.equal(gate(doc([file([nb]), un])).result, "UNSUPPORTED");
  const g = gate(doc([file([change()]), un]));
  assert.equal(g.result, "FAIL");
  assert.equal(g.rows.filter((r) => r.startsWith("blocking|")).length, 2);
  assert.equal(gate(doc([file([change({ rule: "CP-U01", classification: "needs-review" })])])).result, "FAIL");
  const judged = { id: "J-1", location: "o.yaml:3", text: "naming drifts", criterion: null };
  assert.equal(gate(doc([file([nb])], { judged: [judged] })).result, "PASS", "judged alone never fails");
  assert.equal(gate(doc([file([nb])], { judged: [{ ...judged, criterion: "PLAN: names are camelCase" }] })).result, "FAIL");
});
test("validator: rejects what the report must not claim", () => {
  bad(doc([file([change({ rule: "CP-X99" })])]), /not a rule id/);
  bad(doc([file([change({ classification: "non-breaking" })])]), /does not match CP-B02/);
  bad(doc([file([change({ consumers: { source: "not-searched", in_repo: [], outside_repo: "unknown" } })])]), /consumers searched/);
  bad(doc([file([change({ consumers: { source: "impact", in_repo: [], outside_repo: "none" } })])]), /must be "unknown"/);
  bad(doc([file([change({ evidence: { class: "judged", source: "me" } })])]), /judged items go to judged/);
  bad(doc([file([change({ evidence: { class: "measured", source: "tool:oasdiff" } })])]), /not in tools.used/);
  bad(doc([file([change({ evidence: { class: "traced", source: "read" } })])]), /traced evidence needs detail/);
  bad(doc([file([change({ coverage: { covered: true, plan_line: 4, text: "- o.yaml `x` removed" } })])]), /no versioning, migration or deprecation/);
  bad(doc([file([change({ coverage: { covered: true, plan_line: 4, text: "- o.yaml `y` migration" } })])]), /does not name x/);
  bad(doc([file([change()], { status: "unsupported" })]), /needs a reason|no classified changes/);
  bad(doc([file([change(), change()])]), /duplicate id/);
});
test("schema documents the validator's enums", () => {
  assert.deepEqual(SCHEMA.$defs.change.properties.side.enum, ["request", "response", "both"]);
  assert.equal(SCHEMA.$defs.change.properties.consumers.properties.outside_repo.const, "unknown");
});

// ---- fixture end to end ------------------------------------------------------------------------------
test("fixture: whole diff FAILs with the planted uncovered breaks only; subsets PASS and UNSUPPORTED", () => {
  const repo = join(base, "fx");
  let r = spawnSync("sh", [join(fixture, "setup.sh"), repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync("sh", [join(fixture, "selfcheck.sh"), repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // the differ alone (no impact report) leaves breaking consumers unsearched: the validator refuses it
  const out = join(base, "noimpact.json");
  r = spawnSync("node", [DIFF, "--repo", repo, "--base", "HEAD~1", "--plan", join(repo, "PLAN.md"), "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(EXPECTED.files).sort(), d.files.map((f) => f.path).sort());
  r = spawnSync("node", [VALIDATE, out], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /consumers searched/);
  writeFileSync(join(base, "garbage.json"), "{");
  assert.equal(spawnSync("node", [VALIDATE, join(base, "garbage.json")]).status, 2);
});
