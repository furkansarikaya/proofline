import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skill = join(dirname(fileURLToPath(import.meta.url)), "../../skills/api-design");
const script = join(skill, "scripts/validate-api.mjs");
const { validate } = await import(script);

const repo = mkdtempSync(join(tmpdir(), "api-"));
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "openapi.yaml"), "openapi: 3.0.0\n");
writeFileSync(join(repo, "src/orders.js"), "");

const good = () => ({
  schema_version: 1, mode: "task", format: "openapi", existing_contract: "openapi.yaml", contract_file: "openapi.yaml",
  searched: ["openapi.*"],
  operations: [
    { id: "POST /orders", style: "rest", change: "added", breaking: false, versioned: false, purpose: "Create an order (AC-1)", auth: "bearer, role buyer", idempotency: "Idempotency-Key header", errors: ["400 invalid body", "409 duplicate key"], handler: "src/new-orders.js" },
    { id: "GET /orders", style: "rest", change: "modified", breaking: true, breaking_reason: "default page size 100 -> 20 truncates clients that never paginate", versioned: true, purpose: "List orders", auth: "bearer", list: true, pagination: "cursor, max 100", errors: ["401 no token"], handler: "src/orders.js" },
    { id: "DELETE /orders/{id}", style: "rest", change: "removed", breaking: true, breaking_reason: "clients calling DELETE get 404", versioned: true, purpose: "Removed in favour of cancel" },
  ],
  contracts_text: ["GET /orders: default page size 20, clients must follow the cursor (v1 stays 100 until 2027)", "DELETE /orders/{id}: removed, use POST /orders/{id}/cancel"],
});
const errs = (d, o = { root: repo }) => validate(d, o);
const has = (e, s) => assert.ok(e.some((x) => x.includes(s)), `expected "${s}" in ${JSON.stringify(e)}`);

test("accepts a good contract design", () => assert.deepEqual(errs(good()), []));
test("removed operation must be breaking", () => {
  const d = good(); d.operations[2].breaking = false; has(errs(d), "always breaking");
});
test("breaking needs a reason", () => {
  const d = good(); delete d.operations[1].breaking_reason; has(errs(d), "consumer-visible effect");
});
test("breaking must be named in contracts_text", () => {
  const d = good(); d.contracts_text = []; const e = errs(d); has(e, "named in contracts_text");
});
test("versioned change must be named in contracts_text", () => {
  const d = good(); d.operations[1].breaking = false; d.operations[1].breaking_reason = undefined;
  d.contracts_text = ["DELETE /orders/{id}: removed"]; has(errs(d), "versioned-contract change");
});
test("mutating REST operation needs idempotency", () => {
  const d = good(); delete d.operations[0].idempotency; has(errs(d), "idempotency");
});
test("added/modified operations need errors and auth", () => {
  const d = good(); d.operations[0].errors = []; delete d.operations[0].auth; const e = errs(d);
  has(e, "error response"); has(e, "auth");
});
test("list operation needs pagination", () => {
  const d = good(); delete d.operations[1].pagination; has(errs(d), "pagination");
});
test("rest id must be METHOD /path", () => {
  const d = good(); d.operations[0].id = "orders"; has(errs(d), "METHOD /path");
});
test("duplicate operation ids rejected", () => {
  const d = good(); d.operations[1].id = d.operations[0].id; has(errs(d), "duplicate id");
});
test("API.md is refused when an existing contract was found", () => {
  const d = good(); d.format = "api-md"; d.contract_file = "docs/design/API.md"; has(errs(d), "no existing contract");
});
test("API.md accepted when nothing exists and patterns were searched", () => {
  const d = good(); d.format = "api-md"; d.existing_contract = null; d.contract_file = "docs/design/API.md"; assert.deepEqual(errs(d), []);
  d.searched = []; has(errs(d), "patterns searched");
});
test("existing format must edit the existing file", () => {
  const d = good(); d.contract_file = "docs/design/API.md"; has(errs(d), "edit the existing contract");
});
test("existing contract file must exist", () => {
  const d = good(); d.existing_contract = d.contract_file = "missing.yaml"; has(errs(d), "does not exist");
});
test("handler must exist unless the operation is added", () => {
  const d = good(); d.operations[1].handler = "src/nope.js"; has(errs(d), "does not exist");
});
test("unchanged operation cannot be breaking", () => {
  const d = good(); d.operations[1].change = "unchanged"; has(errs(d), "unchanged operation cannot be breaking");
});
test("reverse mode: unchanged only, handler required", () => {
  const d = good(); d.mode = "reverse"; has(errs(d), "unchanged only");
  const r = { ...good(), mode: "reverse", operations: [{ id: "GET /orders", style: "rest", change: "unchanged", breaking: false, versioned: false, purpose: "List" }], contracts_text: [] };
  has(errs(r), "verified handler");
});
test("unknown keys and traversal rejected", () => {
  const d = good(); d.x = 1; has(errs(d), "unexpected");
  const e = good(); e.contract_file = "../x"; has(errs(e), "repo-relative");
});
test("CLI exit codes", () => {
  const f = join(repo, "a.json");
  writeFileSync(f, JSON.stringify(good()));
  assert.equal(spawnSync("node", [script, f, "--root", repo]).status, 0);
  const bad = good(); bad.operations[2].breaking = false; writeFileSync(f, JSON.stringify(bad));
  assert.equal(spawnSync("node", [script, f]).status, 1);
  assert.equal(spawnSync("node", [script]).status, 2);
});
test("SKILL.md frontmatter and schema", () => {
  const t = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(t, /^---\nname: api-design\n/);
  assert.ok(t.split("\n").length < 500);
  JSON.parse(readFileSync(join(skill, "schema/api.schema.json"), "utf8"));
});
