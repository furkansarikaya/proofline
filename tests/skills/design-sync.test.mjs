import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, readDocConfig, extractRoutes, extractTables, parseOpenApi, apiClaims, dataModelClaims, pathClaims, designClaims } from "../../skills/design-sync/scripts/design-sync.mjs";

const SCRIPT = fileURLToPath(new URL("../../skills/design-sync/scripts/design-sync.mjs", import.meta.url));

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "ds-"));
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
  return root;
}
const code = (rel, text) => [{ rel, text }];
const status = (out, kind, claim) => out.claims.find((c) => c.kind === kind && c.claim === claim)?.status;

test("config parsing reads design_docs block with defaults", () => {
  const c = readDocConfig("name: x\ndesign_docs:\n  design: UI.md # comment\n  api: ''\n  adr_dir: docs/adr\nlocal_state: on\n  api: ignored\n");
  assert.equal(c.design, "UI.md");
  assert.equal(c.architecture, "docs/design/ARCHITECTURE.md");
  assert.equal(readDocConfig("").data_model, "docs/design/DATA_MODEL.md");
});

test("route extraction across frameworks", () => {
  const r = (rel, t) => extractRoutes(code(rel, t)).map((x) => `${x.method} ${x.path}`);
  assert.deepEqual(r("a.js", "app.get('/users/:id', h)\nrouter.post(`/items`, h)\naxios.get('/ext')\nmap.get('/k')"), ["GET /users/{}", "POST /items"]);
  assert.deepEqual(r("a.js", "router.route('/x').delete(h)"), ["DELETE /x"]);
  assert.deepEqual(r("a.go", 'mux.HandleFunc("POST /orders/{id}", h)\nhttp.HandleFunc("/ping", h)'), ["POST /orders/{}", "* /ping"]);
  assert.deepEqual(r("a.py", "router = APIRouter(prefix='/v1')\n@router.get('/u/{id}')\ndef f(): pass\n@app.route('/p', methods=['POST'])\ndef g(): pass"), ["GET /v1/u/{}", "POST /p"]);
  assert.deepEqual(r("A.java", '@RequestMapping("/api/pets")\npublic class P {\n  @GetMapping("/{id}")\n  x() {}\n  @PostMapping\n  y() {}\n}'), ["GET /api/pets/{}", "POST /api/pets"]);
  assert.deepEqual(r("A.cs", '[Route("api/[controller]")]\npublic class OrdersController {\n [HttpGet("{id}")]\n [HttpPost]\n}'), ["GET /api/orders/{}", "POST /api/orders"]);
  assert.deepEqual(r("P.cs", 'app.MapGet("/health", () => 1);'), ["GET /health"]);
  assert.deepEqual(r("g.go", 'r.GET("/a/:id", h)'), ["GET /a/{}"]);
});

test("table extraction across schema styles", () => {
  const t = (rel, x) => extractTables(code(rel, x)).map((y) => y.norm);
  assert.deepEqual(t("a.sql", 'CREATE TABLE IF NOT EXISTS public."orders" (id int);\ncreate table `users`(x int);'), ["order", "user"]);
  assert.deepEqual(t("s.prisma", 'model Invoice {\n id Int\n @@map("invoices")\n}'), ["invoice", "invoice"]);
  assert.deepEqual(t("m.py", "class Post(models.Model):\n  pass\n__tablename__ = 'comments'"), ["post", "comment"]);
  assert.deepEqual(t("m.js", "knex.schema.createTable('audit_log', t => {})"), ["auditlog"]);
});

test("doc claim extraction", () => {
  assert.deepEqual(apiClaims("| Method | Path |\n|---|---|\n| GET | `/users` |\n\n- `POST /users/{id}/roles`\n### DELETE /sessions\n").map((c) => c.claim), ["GET /users", "POST /users/{id}/roles", "DELETE /sessions"]);
  assert.deepEqual(dataModelClaims("| Table | Purpose |\n|---|---|\n| `users` | x |\n\n### Table: orders\n\n## Overview\n```sql\nCREATE TABLE audit (id int);\n```").map((c) => c.claim), ["users", "orders", "audit"]);
  assert.deepEqual(pathClaims("See `src/api/` and `server.js` plus `1.2.3`, `GET /x`, `src/**/*.ts`.\n```\n`src/in-fence`\n```").map((c) => c.claim), ["src/api/", "server.js", "src/**/*.ts"]);
  const d = designClaims("| Token | Value | Defined in |\n|---|---|---|\n| `color.primary` | #fff | `src/tokens.json` |\n\nUse `--space-md`.\n- `Button` in `src/ui/Button.tsx`\n");
  assert.deepEqual(d.map((c) => `${c.kind}:${c.claim}`), ["token:color.primary", "css-var:--space-md", "component:Button"]);
});

test("openapi parsing (yaml and json)", () => {
  const y = parseOpenApi("openapi: 3.0.0\npaths:\n  /users:\n    get:\n      x: 1\n    post:\n      x: 1\n  /users/{id}:\n    delete:\n      x: 1\ncomponents:\n  schemas: {}\n");
  assert.deepEqual(y.map((o) => `${o.method} ${o.path}`), ["GET /users", "POST /users", "DELETE /users/{id}"]);
  assert.deepEqual(parseOpenApi('{"paths":{"/a":{"get":{},"parameters":[]}}}').map((o) => `${o.method} ${o.path}`), ["GET /a"]);
});

const PROJECT = {
  ".agents/config.yaml": "design_docs:\n  design: DESIGN.md\n  architecture: docs/design/ARCHITECTURE.md\n  data_model: docs/design/DATA_MODEL.md\n  api: docs/design/API.md\n",
  "db/schema.sql": "CREATE TABLE users (id int);\nCREATE TABLE orders (id int);\n",
  "src/server/routes.js": "const router = require('express').Router();\nrouter.get('/users', h);\nrouter.post('/orders/:id/cancel', h);\n",
  "src/server/index.js": "x",
  "src/ui/Button.tsx": "export function Button() {}\n",
  "src/ui/theme.css": ":root { --space-md: 8px; }\n",
  "docs/design/DATA_MODEL.md": "| Table | Purpose |\n|---|---|\n| `users` | accounts |\n| `orders` | orders |\n| `invoices` | billing |\n",
  "docs/design/ARCHITECTURE.md": "Server in `src/server/`; entry `src/server/index.js`; worker `src/worker/main.js`; glob `src/**/*.js`; link `/health`.\n",
  "docs/design/API.md": "GET /users\nPOST /api/orders/{orderId}/cancel\nDELETE /users/{id}\n",
  "DESIGN.md": "Tokens: `--space-md`, `--color-missing`.\n\n| Component | Location |\n|---|---|\n| `Button` | `src/ui/Button.tsx` |\n| `Modal` | `src/ui/Modal.tsx` |\n| `Tooltip` | - |\n",
};

test("end to end: matched, unmatched (drift) and unverifiable are told apart", () => {
  const out = run({ root: project(PROJECT) });
  assert.equal(out.verdict, "FAIL");
  assert.equal(status(out, "table", "users"), "matched");
  assert.equal(status(out, "table", "invoices"), "unmatched");
  assert.equal(status(out, "path", "src/server/"), "matched");
  assert.equal(status(out, "path", "src/server/index.js"), "matched");
  assert.equal(status(out, "path", "src/worker/main.js"), "unmatched");
  assert.equal(status(out, "path", "src/**/*.js"), "unverifiable");
  assert.equal(status(out, "endpoint", "GET /users"), "matched");
  assert.equal(status(out, "endpoint", "POST /api/orders/{orderId}/cancel"), "matched");
  assert.equal(status(out, "endpoint", "DELETE /users/{id}"), "unmatched");
  assert.equal(status(out, "css-var", "--space-md"), "matched");
  assert.equal(status(out, "css-var", "--color-missing"), "unmatched");
  assert.equal(status(out, "component", "Button"), "matched");
  assert.equal(status(out, "component", "Modal"), "unmatched");
  assert.ok(out.drift.includes("docs/design/DATA_MODEL.md:5 -> table invoices: 2 table definitions scanned, none named invoices"));
  assert.ok(out.drift.some((d) => /^docs\/design\/API\.md:3 -> endpoint DELETE \/users\/\{id\}/.test(d)));
  assert.ok(out.drift.some((d) => /^DESIGN\.md:\d+ -> component Modal/.test(d)));
  assert.equal(out.summary.unmatched, out.drift.length);
});

test("heuristic miss is unverifiable, never drift", () => {
  const out = run({ root: project({ "docs/design/API.md": "GET /anything\n", "docs/design/DATA_MODEL.md": "| Table |\n|---|\n| `ghost` |\n", "src/app.rb": "get '/anything' do\nend\n" }) });
  assert.equal(status(out, "endpoint", "GET /anything"), "unverifiable");
  assert.equal(status(out, "table", "ghost"), "unverifiable");
  assert.equal(out.verdict, "PASS");
  assert.equal(out.drift.length, 0);
  assert.equal(out.unverifiable.length, 2);
});

test("no design docs: SKIPPED; absent docs are not drift", () => {
  const out = run({ root: project({ "src/a.js": "x" }) });
  assert.equal(out.verdict, "SKIPPED");
  assert.deepEqual(out.docs.map((d) => d.present), [false, false, false, false]);
});

test("doc paths come from config and flags override", () => {
  const root = project({ ".agents/config.yaml": "design_docs:\n  api: spec/api.md\n", "spec/api.md": "GET /nope\n", "other.md": "GET /ok\n", "src/r.js": "app.get('/ok', h)\napp.get('/x', h)\n" });
  assert.equal(run({ root }).verdict, "FAIL");
  const o = run({ root, api: "other.md" });
  assert.equal(o.verdict, "PASS");
});

test("OpenAPI file as the api doc", () => {
  const root = project({ ".agents/config.yaml": "design_docs:\n  api: openapi.yaml\n", "openapi.yaml": "paths:\n  /pets:\n    get:\n      a: b\n  /gone:\n    get:\n      a: b\n", "src/r.js": "app.get('/pets', h)\n" });
  const out = run({ root });
  assert.equal(status(out, "endpoint", "GET /pets"), "matched");
  assert.equal(status(out, "endpoint", "GET /gone"), "unmatched");
});

test("documents themselves are not code facts", () => {
  const root = project({ "docs/design/API.md": "GET /selfref\n", "docs/design/DATA_MODEL.md": "CREATE TABLE x (a int);\n| Table |\n|---|\n| `x` |\n", "src/r.js": "app.get('/real', h)\n" });
  assert.equal(status(run({ root }), "endpoint", "GET /selfref"), "unmatched");
});

test("reverse modes list code facts with locations", () => {
  const root = project(PROJECT);
  const f = (m) => run({ root, reverse: m }).facts;
  assert.deepEqual(f("data").map((t) => t.name), ["users", "orders"]);
  assert.deepEqual(f("api").map((r) => `${r.method} ${r.path}`), ["GET /users", "POST /orders/:id/cancel"]);
  assert.ok(f("system").modules.some((m) => m.dir === "src/server") && f("system").manifests.length === 0);
  assert.deepEqual(f("ui").css_vars.map((v) => v.name), ["--space-md"]);
  assert.deepEqual(f("ui").components.map((c) => c.name), ["Button"]);
});

test("CLI: --check exit codes, JSON output, usage errors", () => {
  const root = project(PROJECT);
  const ok = spawnSync("node", [SCRIPT, "--root", root], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).verdict, "FAIL");
  assert.equal(spawnSync("node", [SCRIPT, "--root", root, "--check"], { encoding: "utf8" }).status, 1);
  const clean = project({ "src/a.js": "x" });
  assert.equal(spawnSync("node", [SCRIPT, "--root", clean, "--check"], { encoding: "utf8" }).status, 0);
  assert.equal(spawnSync("node", [SCRIPT, "--reverse", "bogus"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [SCRIPT, "--root", join(root, "missing")], { encoding: "utf8" }).status, 2);
  assert.equal(JSON.parse(spawnSync("node", [SCRIPT, "--root", root, "--reverse", "api"], { encoding: "utf8" }).stdout).facts.length, 2);
});

import { validateSync } from "../../skills/design-sync/scripts/validate-sync.mjs";

const SYNC = (v, drift = "None.", unv = "None.") => `# Design sync: T-1\n\nVerdict: ${v}\n\n## Drift\n\n${drift}\n\n## Unverifiable\n\n${unv}\n`;

test("sync report: verdict must follow the drift section", () => {
  assert.equal(validateSync(SYNC("PASS")).valid, true);
  assert.equal(validateSync(SYNC("FAIL", "- docs/design/API.md:3 -> endpoint DELETE /users/{id}: no route")).valid, true);
  assert.match(validateSync(SYNC("PASS", "- docs/design/API.md:3 -> endpoint DELETE /users")).errors.join(), /contradicts/);
  assert.match(validateSync(SYNC("FAIL")).errors.join(), /contradicts/);
  assert.equal(validateSync(SYNC("SKIPPED")).valid, true);
});

test("sync report: malformed drift lines and sections are rejected", () => {
  assert.match(validateSync(SYNC("FAIL", "- something is off")).errors.join(), /drift line must be/);
  assert.match(validateSync(SYNC("PASS").replace("## Drift", "## Other")).errors.join(), /missing section "## Drift"/);
  assert.match(validateSync(SYNC("PASS") + "Verdict: PASS\n").errors.join(), /exactly one/);
});

// ---- fix round 2: design-sync inside a run is part of the verifier's VERIFY result ----

test("SKILL.md team mode: drift rows are VERIFY-<n> of the verifier's result; reverse is never a verifier DONE", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(new URL("../../skills/design-sync/SKILL.md", import.meta.url), "utf8");
  const team = md.slice(md.indexOf("## Team mode"), md.indexOf("<!-- proofline:shared-rules:begin"));
  assert.match(team, /part of its `VERIFY` gate result; design-sync has no result header of its own/);
  assert.match(team, /\| VERIFY-<n> \| blocking \| <doc>:<line> \| D-<m>: design-sync drift:/);
  assert.match(team, /The verifier's `RESULT` is only `PASS \| FAIL \| BLOCKED`/);
  assert.match(team, /never of the verifier/);
  assert.match(team, /rows `<role>-<n>` \(for example `architect-1`\)/);
  assert.doesNotMatch(team, /\| D-<n> \| high/);
  assert.doesNotMatch(team, /Reverse mode returns `RESULT: DONE`/);
  assert.match(md, /standalone only: `\/proofline design system\|data\|api\|ui --check`/);
  assert.match(md, /never the verifier/);
});
