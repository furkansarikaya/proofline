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
const { RULES, parseYaml, parseJson, parseProto, parseGraphql, diffFile, load, coverage, planBullets, consumersFrom, run } = await import(DIFF);
const { validate, gate } = await import(VALIDATE);
const EXPECTED = JSON.parse(readFileSync(join(fixture, "EXPECTED.json"), "utf8"));
const SCHEMA = JSON.parse(readFileSync(join(skill, "schema/contract.schema.json"), "utf8"));
const RULES_MD = readFileSync(join(skill, "references/RULES.md"), "utf8");

let base, repo;
before(() => {
  base = mkdtempSync(join(tmpdir(), "cpfx-"));
  repo = join(base, "fx");
  const r = spawnSync("sh", [join(fixture, "setup.sh"), repo], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(base, { recursive: true, force: true }));

const changes = (path, a, b, opts = {}) => diffFile(path, a, b, { explicit: true, ...opts }).row;
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
  const d = parseYaml(`# c\na: 1\nb: "x: y" # trailing\nc: 'it''s'\nd: [1, two, {k: v}]\ne:\n  - name: n\n    in: path\n  - plain\nf: |\n  line1\n  line2\ng: ~\nh: true\n"200":\n  ok: 3.5\ni: >\n  one\n  two\n`);
  assert.deepEqual(d, { a: 1, b: "x: y", c: "it's", d: [1, "two", { k: "v" }], e: [{ name: "n", in: "path" }, "plain"], f: "line1\nline2", g: null, h: true, 200: { ok: 3.5 }, i: "one two" });
});
test("YAML outside the subset is refused, never guessed", () => {
  for (const bad of ["a: &x 1\nb: *x\n", "a: !!str 1\n", "a: 1\n---\nb: 2\n", "? a\n: b\n", "<<: {a: 1}\n", "a: b\n  c\n", "a: 1\na: 2\n", "a: [1,\n  2]\n", "a:\n\tb: 1\n",
    "a: >\n  one\n\n  two\n", "a: >\n  one\n    indented\n", "a: {x:1}\n", "a: [{x:1}]\n"]) {
    assert.throws(() => parseYaml(bad), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parseYaml("a: {x: 1, u: http://h}\n"), { a: { x: 1, u: "http://h" } });
});
test("JSON parser keeps values identical to JSON.parse", () => {
  const t = '{"a": [1, 2.5, -3e2, true, null, "s\\"q"], "b": {"c": {}}}';
  assert.deepEqual(parseJson(t), JSON.parse(t));
  assert.throws(() => parseJson('{"a": 1,}'));
});
test("a YAML JSON Schema with an unquoted $schema and an anchor is UNSUPPORTED, not dropped", () => {
  const r = load("defs/thing.yaml", "$schema: https://json-schema.org/draft/2020-12/schema\ntype: object\nproperties:\n  a: &x\n    type: string\n", { explicit: false });
  assert.equal(r.format, "yaml");
  assert.match(r.unsupported, /anchor/);
  assert.equal(load("config/app.yaml", "a: &x 1\n", { explicit: false }), null, "plain config is not a contract");
  assert.match(load("contracts/app.yaml", "a: &x 1\n", { explicit: false }).unsupported, /cannot parse/, "a contract path is never dropped");
});

// ---- direction rules -----------------------------------------------------------------------------
const reqBase = "type: object\nproperties:\n  a:\n    type: string\n    maxLength: 10";
test("request side: a new required field is breaking even with a default; an optional one is not", () => {
  const head = "type: object\nrequired: [b]\nproperties:\n  a:\n    type: string\n    maxLength: 10\n  b:\n    type: string\n    default: x";
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(head, "request"))), ["CP-B05 request POST /a.b"]);
  const opt = "type: object\nproperties:\n  a:\n    type: string\n    maxLength: 10\n  b:\n    type: string";
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(opt, "request"))), ["CP-N01 request POST /a.b"]);
});
test("constraints and requiredness flip with the direction", () => {
  const narrow = reqBase.replace("maxLength: 10", "maxLength: 5");
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(narrow, "request"))), ["CP-B09 request POST /a.a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase), oas(narrow))), ["CP-N06 response GET /a.a"]);
  const req = reqBase.replace("type: object\n", "type: object\nrequired: [a]\n");
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase, "request"), oas(req, "request"))), ["CP-B04 request POST /a.a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(reqBase), oas(req))), ["CP-N06 response GET /a.a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(req), oas(reqBase))), ["CP-B04 response GET /a.a"]);
});
test("a changed pattern, format or const is breaking on every side; added and removed follow the direction", () => {
  const f = (v) => `type: string${v ? `\nformat: ${v}` : ""}`;
  assert.deepEqual(rules(changes("o.yaml", oas(f("date-time")), oas(f("date")))), ["CP-B09 response GET /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(f("date-time"), "request"), oas(f("date"), "request"))), ["CP-B09 request POST /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(f(null)), oas(f("date")))), ["CP-N06 response GET /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas(f("date")), oas(f(null)))), ["CP-B09 response GET /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas("type: string\npattern: '^a'"), oas("type: string\npattern: '^b'"))), ["CP-B09 response GET /a"]);
});
test("enum: removal breaks; addition is CP-N03 on request and CP-N04 on response", () => {
  const e = (v) => `type: string\nenum: [${v}]`;
  assert.deepEqual(rules(changes("o.yaml", oas(e("a, b")), oas(e("a")))), ["CP-B06 response GET /a.b"]);
  assert.deepEqual(rules(changes("o.yaml", oas(e("a")), oas(e("a, b")))), ["CP-N04 response GET /a.b"]);
  assert.deepEqual(rules(changes("o.yaml", oas(e("a"), "request"), oas(e("a, b"), "request"))), ["CP-N03 request POST /a.b"]);
});
test("type changes and unknown keywords", () => {
  assert.deepEqual(rules(changes("o.yaml", oas("type: string"), oas("type: integer"))), ["CP-B03 response GET /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas("type: integer", "request"), oas("type: number", "request"))), ["CP-N06 request POST /a"]);
  assert.deepEqual(rules(changes("o.yaml", oas("type: string"), oas("type: string\nreadOnly: true"))), ["CP-U01 response GET /a.readOnly"]);
});
test("$ref refactor with the same shape is no change; a recursive schema does not loop; named schemas qualify the element", () => {
  const inline = oas("type: object\nproperties:\n  id:\n    type: string");
  const viaRef = inline.replace("              schema:\n                type: object\n                properties:\n                  id:\n                    type: string\n", "              schema:\n                $ref: '#/components/schemas/X'\n") +
    "components:\n  schemas:\n    X:\n      type: object\n      properties:\n        id:\n          type: string\n";
  assert.deepEqual(changes("o.yaml", inline, viaRef).changes, []);
  const rec = (extra) => `openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/N'\ncomponents:\n  schemas:\n    N:\n      type: object\n      properties:\n        next:\n          $ref: '#/components/schemas/N'\n${extra}`;
  assert.deepEqual(rules(changes("o.yaml", rec(""), rec("        v:\n          type: string\n"))), ["CP-N01 response N.v"]);
});
test("operations, status codes and parameters", () => {
  const b = "openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      parameters:\n        - name: q\n          in: query\n      responses:\n        \"200\":\n          description: ok\n        \"404\":\n          description: no\n  /b:\n    get:\n      responses:\n        \"200\":\n          description: ok\n";
  const h = "openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      parameters:\n        - name: q\n          in: query\n          required: true\n        - name: r\n          in: header\n          required: true\n      responses:\n        \"200\":\n          description: ok\n";
  assert.deepEqual(rules(changes("o.yaml", b, h)), ["CP-B01 both /b", "CP-B04 request GET /a.q", "CP-B05 request GET /a.r", "CP-B08 response GET /a.404"]);
});
test("external $ref fragments are loaded, classified where used, and an unparseable one is reported", () => {
  const root = "openapi: 3.0.3\ninfo:\n  title: T\n  version: 1.0.0\npaths:\n  /a:\n    get:\n      responses:\n        \"200\":\n          content:\n            application/json:\n              schema:\n                $ref: './frag/a.yaml#/A'\n";
  const fragB = "A:\n  type: object\n  properties:\n    x:\n      type: string\n", fragH = "A:\n  type: object\n  properties:\n    x:\n      type: integer\n";
  const r = diffFile("api/root.yaml", root, root, { loadBase: (p) => (p === "api/frag/a.yaml" ? fragB : null), loadHead: (p) => (p === "api/frag/a.yaml" ? fragH : null) });
  assert.deepEqual(rules(r.row), ["CP-B03 response GET /a.x"]);
  assert.equal(r.row.changes[0].line_file, "api/frag/a.yaml");
  assert.deepEqual([...r.fragments], ["api/frag/a.yaml"]);
  const u = diffFile("api/root.yaml", root, root, { loadBase: () => "a: &x 1\n", loadHead: () => "a: &x 1\n" });
  assert.match(u.unresolved.get("api/frag/a.yaml"), /cannot parse/);
});

// ---- GraphQL and protobuf ------------------------------------------------------------------------
test("GraphQL: removals, nullability by direction, args with and without defaults, qualified elements", () => {
  const a = "type Q {\n  a: String!\n  b(x: Int): String\n  gone: Int\n}\ninput I {\n  f: String\n}\nenum E {\n  X\n  Y\n}\n";
  const b = "type Q {\n  a: String\n  b(x: Int!, y: Int!, z: Int! = 1): String\n}\ninput I {\n  f: String!\n}\nenum E {\n  X\n}\n";
  assert.deepEqual(rules(changes("s.graphql", a, b)), ["CP-B02 response Q.gone", "CP-B04 request I.f", "CP-B04 request Q.b(x)", "CP-B05 request Q.b(y)", "CP-B06 both E.Y", "CP-B09 response Q.a", "CP-N10 request Q.b(z)"]);
  assert.equal(changes("s.graphql", "type Q {\n  a(x: Int,\n    y: Int): String\n}\n", "type Q {\n  a: String\n}\n").status, "unsupported");
});
test("GraphQL and protobuf single-line bodies parse when simple, else UNSUPPORTED", () => {
  assert.deepEqual(Object.keys(parseGraphql("type A { a: Int }\nenum E { X Y }\n").A.fields), ["a"]);
  assert.deepEqual(Object.keys(parseGraphql("enum E { X Y }\n").E.values), ["X", "Y"]);
  assert.throws(() => parseGraphql("type A { a: Int, b: Int }\n"));
  assert.deepEqual(Object.keys(parseProto("message A {}\nmessage B { string b = 1; }\n").messages), ["A", "B"]);
  assert.throws(() => parseProto("message M {\n  string a =\n    1;\n}\n"), /continues past line/);
});
test("protobuf: renumbering, type change, removal, rpc change", () => {
  const a = 'syntax = "proto3";\nmessage M {\n  string a = 1;\n  int32 b = 2;\n  int32 c = 3;\n}\nservice S {\n  rpc Get (M) returns (M);\n}\n';
  const b = 'syntax = "proto3";\nmessage M {\n  string a = 4;\n  int64 b = 2;\n}\nmessage R {\n  string x = 1;\n}\nservice S {\n  rpc Get (M) returns (R) {\n    option deprecated = true;\n  }\n}\n';
  assert.deepEqual(rules(changes("m.proto", a, b)), ["CP-B02 both M.c", "CP-B03 both M.b", "CP-B03 both S.Get", "CP-B10 both M.a", "CP-N02 both R", "CP-N08 both S.Get"]);
});
test("unknown or unsupported formats are UNSUPPORTED, never compared as a pass", () => {
  assert.equal(changes("x.avsc", "{}", "{}").status, "unsupported");
  assert.equal(changes("x.thrift", "a", "b").status, "unsupported");
  assert.equal(changes("x.yaml", "a: 1\n", "a: 2\n").status, "unsupported"); // explicit, not a contract document
});

// ---- coverage --------------------------------------------------------------------------------------
const ch = (element, classification = "breaking") => ({ element, classification });
const cov = (path, element, md) => coverage(path, ch(element), planBullets(`# P\n\n## Contracts\n\n${md}\n`)).covered;
test("coverage needs the exact file, the whole element and an un-negated versioning/migration/deprecation", () => {
  const bullets = planBullets("# P\n\n## Contracts\n\n- `api/o.yaml` `Order.email`: removed, refactor only.\n- `api/o.yaml` `Order.name` removed: deprecation window 30 days.\n- `other.yaml` `Order.zip` removed: migration done.\n\n## Next\n- `api/o.yaml` `Order.zip` migration\n");
  assert.equal(coverage("api/o.yaml", ch("Order.email"), bullets).covered, false);
  assert.deepEqual(coverage("api/o.yaml", ch("Order.name"), bullets), { covered: true, plan_line: 6, text: "- `api/o.yaml` `Order.name` removed: deprecation window 30 days." });
  assert.equal(coverage("api/o.yaml", ch("Order.zip"), bullets).covered, false, "other file and a bullet outside ## Contracts");
  assert.equal(coverage("api/o.yaml", ch("Order.nam"), bullets).covered, false, "element is a whole name");
  assert.equal(coverage("api/o.yaml", ch("Order.name", "non-breaking"), bullets).covered, false);
});
test("coverage repros from review: negation, info.version, another type's field, another directory", () => {
  assert.equal(cov("api/openapi.yaml", "Order.email", "- api/openapi.yaml: Order.email removed, no versioning needed"), false);
  assert.equal(cov("api/openapi.yaml", "Order.email", "- api/openapi.yaml: Order.email removed, migration not required"), false);
  assert.equal(cov("api/openapi.yaml", "Order.email", "- api/openapi.yaml: Order.email removed; bump info.version"), false);
  assert.equal(cov("api/openapi.yaml", "User.id", "- `api/openapi.yaml` Order.id deprecated, migrate"), false);
  assert.equal(cov("api/openapi.yaml", "Order.id", "- `api/openapi.yaml` Order.id deprecated, migrate"), true);
  assert.equal(cov("a/openapi.yaml", "Order.id", "- `b/openapi.yaml` Order.id deprecated, migrate"), false);
  assert.equal(cov("openapi.yaml", "Order.id", "- `b/openapi.yaml` Order.id deprecated, migrate"), false);
  assert.equal(cov("api/openapi.yaml", "Order.id", "- api/openapi.yaml: Order.id migrated to Order.key."), true, "a sentence dot after a name is fine");
});
test("consumers from an impact report use the element's leaf, skip prose and keep outside consumers unknown", () => {
  const imp = { symbols: [{ name: "x", references: [{ path: "PLAN.md", line: 3, kind: "textual", role: "doc" }, { path: "a.js", line: 2, kind: "heuristic", role: "reference" }] }] };
  assert.deepEqual(consumersFrom(imp, "Order.x"), { source: "impact", in_repo: [{ path: "a.js", line: 2, kind: "heuristic" }], outside_repo: "unknown" });
  assert.equal(consumersFrom(imp, "Q.f(x)").source, "impact");
  assert.equal(consumersFrom(imp, "y").source, "not-searched");
});

// ---- validator --------------------------------------------------------------------------------------
const change = (over = {}) => ({
  id: "C-1", location: "/x", element: "Order.x", side: "response", rule: "CP-B02", original_rule: "CP-B02", classification: "breaking", before: "present", after: null,
  line: 3, line_in: "base", evidence: { class: "measured", source: "diff-contract.mjs" },
  coverage: { covered: false, plan_line: null, text: null }, consumers: { source: "impact", in_repo: [], outside_repo: "unknown" }, ...over,
});
const doc = (files, over = {}) => ({ schema_version: 1, target: { base: "b", head: "h" }, tools: { detected: [], used: [] }, plan: { path: null, contracts_bullets: 0 }, files, judged: [], ...over });
const file = (chs, over = {}) => ({ path: "o.yaml", format: "openapi", change: "modified", status: "compared", changes: chs, ...over });
const bad = (d, re, opts) => { const e = validate(d, opts); assert.ok(e.some((m) => re.test(m)), `no error ${re}: ${e.join(" | ")}`); };
const PLAN = planBullets("# P\n\n## Contracts\n\n- `o.yaml` `Order.x` removed: migration in place\n");

test("validator: gate results", () => {
  const T = { trustCoverage: true };
  assert.equal(gate(doc([file([change()])]), T).result, "FAIL");
  const covd = change({ coverage: { covered: true, plan_line: 5, text: "- `o.yaml` `Order.x` removed: migration in place" } });
  assert.deepEqual(validate(doc([file([covd])]), { bullets: PLAN }), []);
  assert.equal(gate(doc([file([covd])]), T).result, "PASS");
  assert.equal(gate(doc([file([covd])])).result, "FAIL", "without --plan a covered:true is never trusted");
  const nb = change({ rule: "CP-N01", original_rule: "CP-N01", classification: "non-breaking", consumers: { source: "not-searched", in_repo: [], outside_repo: "unknown" } });
  assert.equal(gate(doc([file([nb])])).result, "PASS");
  const un = file([], { path: "l.yaml", format: "yaml", status: "unsupported", reason: "anchor" });
  assert.equal(gate(doc([file([nb]), un])).result, "UNSUPPORTED");
  const g = gate(doc([file([change()]), un]));
  assert.equal(g.result, "FAIL");
  assert.equal(g.rows.filter((r) => r.startsWith("blocking|")).length, 2);
  assert.equal(gate(doc([file([change({ rule: "CP-U01", original_rule: "CP-U01", classification: "needs-review" })])])).result, "FAIL");
  const judged = { id: "J-1", location: "o.yaml:3", text: "naming drifts", criterion: null };
  assert.equal(gate(doc([file([nb])], { judged: [judged] })).result, "PASS", "judged alone never fails");
  assert.equal(gate(doc([file([nb])], { judged: [{ ...judged, criterion: "PLAN: names are camelCase" }] })).result, "FAIL");
  const empty = gate(doc([]));
  assert.equal(empty.result, "UNSUPPORTED", "nothing recognized proves nothing");
  assert.equal(empty.confidence, "low");
  assert.match(gate(doc([file([change({ line_file: "api/frag.yaml" })])])).rows[0], /^blocking\|api\/frag\.yaml:3\|/);
});
test("validator: rejects what the report must not claim", () => {
  bad(doc([file([change({ rule: "CP-X99" })])]), /not a rule id/);
  bad(doc([file([change({ classification: "non-breaking" })])]), /does not match CP-B02/);
  bad(doc([file([change({ consumers: { source: "not-searched", in_repo: [], outside_repo: "unknown" } })])]), /consumers searched/);
  bad(doc([file([change({ consumers: { source: "impact", in_repo: [], outside_repo: "none" } })])]), /must be "unknown"/);
  bad(doc([file([change({ evidence: { class: "judged", source: "me" } })])]), /judged items go to judged/);
  bad(doc([file([change({ evidence: { class: "measured", source: "tool:oasdiff" } })])]), /not in tools.used/);
  bad(doc([file([change({ evidence: { class: "traced", source: "read" } })])]), /traced evidence needs detail/);
  bad(doc([file([change({ coverage: { covered: true, plan_line: 4, text: "- o.yaml `Order.x` removed" } })])]), /no versioning, migration or deprecation/);
  bad(doc([file([change({ coverage: { covered: true, plan_line: 4, text: "- o.yaml `Order.y` migration" } })])]), /does not name Order.x/);
  bad(doc([file([change({ coverage: { covered: true, plan_line: 4, text: "- b/o.yaml `Order.x` migration" } })])]), /does not name o.yaml/);
  bad(doc([file([change()], { status: "unsupported" })]), /needs a reason|no classified changes/);
  bad(doc([file([change(), change()])]), /duplicate id/);
  bad(doc([file([change({ original_rule: undefined })])]), /keeps original_rule/);
});
test("validator --plan re-derives coverage; a crafted covered:true is refused", () => {
  const crafted = change({ coverage: { covered: true, plan_line: 9, text: "- `o.yaml` `Order.x` removed: migration in place" } });
  assert.deepEqual(validate(doc([file([crafted])])), [], "the shape alone is fine");
  bad(doc([file([crafted])]), /coverage disagrees with PLAN.md/, { bullets: planBullets("# P\n\n## Contracts\n\n- `o.yaml` `Order.x` removed, no migration needed\n") });
  bad(doc([file([change()])]), /coverage disagrees with PLAN.md \(covered there: true at line 5\)/, { bullets: PLAN });
});
test("validator: only a CP-U01 may be reclassified, and only with traced evidence", () => {
  bad(doc([file([change({ rule: "CP-N01", classification: "non-breaking" })])]), /CP-B02 was rewritten to CP-N01/);
  const u = { original_rule: "CP-U01", rule: "CP-N05", classification: "non-breaking" };
  bad(doc([file([change(u)])]), /reclassified CP-U01 needs traced evidence/);
  assert.deepEqual(validate(doc([file([change({ ...u, evidence: { class: "traced", source: "read", detail: "o.yaml:3 -> o.yaml:3: x-note text only" } })])])), []);
});
test("validator --repo/--base: a dropped change, a dropped file or a rewritten rule fails", () => {
  const regenerated = run({ repo, base: "HEAD~1", paths: [], plan: null, impact: null });
  const fill = (d) => { for (const f of d.files) for (const c of f.changes) if (c.classification !== "non-breaking") c.consumers.source = "search"; return d; };
  assert.deepEqual(validate(fill(structuredClone(regenerated)), { regenerated }), []);
  const dropped = fill(structuredClone(regenerated));
  const oa = dropped.files.find((f) => f.path === "api/openapi.yaml");
  oa.changes = oa.changes.filter((c) => c.element !== "Order.customerEmail");
  bad(dropped, /Order.customerEmail|customerEmail: the differ finds CP-B02/, { regenerated });
  const gone = fill(structuredClone(regenerated)); gone.files = gone.files.filter((f) => f.path !== "api/legacy.yaml");
  bad(gone, /api\/legacy.yaml: the differ reports this file/, { regenerated });
  const rewritten = fill(structuredClone(regenerated));
  const c = rewritten.files.find((f) => f.path === "proto/inventory.proto").changes.find((x) => x.rule === "CP-B10");
  Object.assign(c, { rule: "CP-N01", original_rule: "CP-N01", classification: "non-breaking" });
  bad(rewritten, /the differ finds CP-B10/, { regenerated });
});
test("schema documents the validator's enums", () => {
  assert.deepEqual(SCHEMA.$defs.change.properties.side.enum, ["request", "response", "both"]);
  assert.equal(SCHEMA.$defs.change.properties.consumers.properties.outside_repo.const, "unknown");
});

// ---- CLI -----------------------------------------------------------------------------------------------
test("CLI refuses an option-like --base", () => {
  assert.equal(spawnSync("node", [DIFF, "--repo", repo, "--base", "--output=x"]).status, 2);
  assert.equal(spawnSync("node", [VALIDATE, join(base, "x.json"), "--repo", repo, "--base", "-x"]).status, 2);
});

// ---- fixture end to end ------------------------------------------------------------------------------
test("fixture: whole diff FAILs with the planted uncovered breaks only; subsets PASS and UNSUPPORTED", () => {
  let r = spawnSync("sh", [join(fixture, "selfcheck.sh"), repo], { encoding: "utf8" });
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
