import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { destructuredEnv, envUsages, envDefaultOn, scanLine, flagFromLine, planMentions, bucket, buildDocument } from "../../skills/proof-review/scripts/check-config.mjs";
import { validate, gate, tableRows } from "../../skills/proof-review/scripts/validate-config.mjs";
import { FORBIDDEN_BY_FOCUS, FOCUSES, RUN_DIR } from "../../skills/proof-review/scripts/gate.mjs";

const dirs = [];
const mktmp = () => { const d = mkdtempSync(join(tmpdir(), "cfg-test-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("env var reads are matched per ecosystem; ambient names are not", () => {
  const cases = [
    ['const a = process.env.API_URL;', "API_URL"], ['process.env["B_KEY"]', "B_KEY"], ['import.meta.env.VITE_X', "VITE_X"],
    ['os.environ["PY_VAR"]', "PY_VAR"], ['os.environ.get("PY_GET")', "PY_GET"], ['os.getenv("PY_ENV", "d")', "PY_ENV"],
    ['os.Getenv("GO_VAR")', "GO_VAR"], ['std::env::var("RS_VAR")', "RS_VAR"], ['ENV.fetch("RB_VAR")', "RB_VAR"],
    ['getenv("PHP_VAR")', "PHP_VAR"], ['System.getenv("JAVA_VAR")', "JAVA_VAR"], ['Environment.GetEnvironmentVariable("CS_VAR")', "CS_VAR"],
  ];
  for (const [line, name] of cases) assert.deepEqual(envUsages(line, "code"), [name], line);
  assert.deepEqual(envUsages("password: ${DB_PASSWORD}", "config"), ["DB_PASSWORD"]);
  assert.deepEqual(envUsages("url: ${BASE:-http://x}", "config"), ["BASE"]);
  assert.deepEqual(envUsages("process.env.NODE_ENV + process.env.HOME", "code"), []);
  assert.deepEqual(envUsages("echo ${HOME_X}", "other"), []);
  assert.ok(envDefaultOn('process.env.FEATURE_X || "true"', "FEATURE_X"));
  assert.ok(envDefaultOn('os.getenv("FEATURE_X", "1")', "FEATURE_X"));
  assert.ok(!envDefaultOn('process.env.FEATURE_X || "false"', "FEATURE_X"));
});

test("secrets: rules, entropy, placeholders, masking by construction", () => {
  const fake = (n) => "k3J9xQ2mV7bN4pL8wR5tY1zA".slice(0, n);
  assert.equal(scanLine(`api_key: "${fake(24)}"`, "config")[0].rule, "generic_secret");
  assert.equal(scanLine(`api_key: ${fake(24)}`, "config")[0].length, 24); // unquoted in a config file
  assert.deepEqual(scanLine('api_key: "changeme"', "config"), []);
  assert.deepEqual(scanLine('password: "${DB_PASSWORD}"', "config"), []);
  assert.deepEqual(scanLine('token: "aaaaaaaaaaaaaaaaaaaaaaaa"', "config"), []); // no digit, low entropy
  assert.equal(scanLine("x = AKIA" + "ABCDEFGHIJKLMNOP", "config")[0].rule, "aws_access_key_id");
  assert.equal(scanLine("-----BEGIN RSA PRIVATE KEY-----", "config")[0].rule, "private_key");
  const env = scanLine("SOME_VALUE=abc", "envfile");
  assert.deepEqual(env.map((h) => [h.rule, h.key]), [["env_file", "SOME_VALUE"]]);
  assert.deepEqual(scanLine("SOME_VALUE=", "envfile"), []);
  for (const h of scanLine(`secret: "${fake(24)}"`, "config")) assert.ok(!JSON.stringify(h).includes(fake(12)));
});

test("flags: name or parent block, on/off, plan mention variants", () => {
  const y = ["features:", "  new_checkout: true", "  beta: off", "other:", "  enabled: true", "FEATURE_X=1", "debug_flag: false"];
  assert.deepEqual(flagFromLine(y, 1), { name: "new_checkout", on: true });
  assert.deepEqual(flagFromLine(y, 2), { name: "beta", on: false });
  assert.equal(flagFromLine(y, 4), null);
  assert.deepEqual(flagFromLine(y, 5), { name: "FEATURE_X", on: true });
  assert.deepEqual(flagFromLine(y, 6), { name: "debug_flag", on: false });
  assert.ok(planMentions("enable the new-checkout flag", "new_checkout"));
  assert.ok(!planMentions("the checkout page", "new_checkout"));
  assert.ok(!planMentions("renew_checkout_x", "new_checkout"));
});

test("file buckets", () => {
  assert.equal(bucket(".env.example"), "example");
  assert.equal(bucket("config/app.sample.yaml"), "example");
  assert.equal(bucket(".env.production"), "envfile");
  assert.equal(bucket("README.md"), "doc");
  assert.equal(bucket("src/a.py"), "code");
  assert.equal(bucket("config/app.yaml"), "config");
  assert.equal(bucket("package-lock.json"), "skip");
  assert.equal(bucket("node_modules/x/index.js"), "skip");
});

test("focus discipline: config reports only its own series, has a run dir", () => {
  assert.ok(FOCUSES.includes("config"));
  assert.equal(RUN_DIR.config, "config");
  for (const s of ["claims", "rules", "bugs", "plan_deviations", "unrequested"]) assert.ok(FORBIDDEN_BY_FOCUS.config.includes(s), s);
});

// --- end to end ------------------------------------------------------------------------------------------------
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.invalid" } });
const put = (repo, rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
function repoWith(base, head) {
  const r = mktmp();
  git(r, "init", "-q", "-b", "main");
  for (const [k, v] of Object.entries(base)) put(r, k, v);
  git(r, "add", "-A"); git(r, "commit", "-q", "-m", "base");
  for (const [k, v] of Object.entries(head)) put(r, k, v);
  return r;
}
const sum = (d, cls) => d.items.filter((i) => i.class === cls).map((i) => `${i.check}:${i.subject}`).sort();

test("only added lines are judged; docs and examples define variables; untracked files count", () => {
  const r = repoWith(
    { ".env.example": "KNOWN=1\n", "README.md": "Set DOCUMENTED_IN_README.\n", "src/old.js": "process.env.PRE_EXISTING;\n" },
    { "src/old.js": "process.env.PRE_EXISTING;\nprocess.env.KNOWN;\nprocess.env.DOCUMENTED_IN_README;\nprocess.env.NEW_UNDOC;\n", "src/new.go": 'os.Getenv("GO_UNDOC")\n' },
  );
  const d = buildDocument({ repo: r, base: "HEAD", planText: null });
  assert.deepEqual(sum(d, "blocking"), ["env_undocumented:GO_UNDOC", "env_undocumented:NEW_UNDOC"]);
  assert.deepEqual(validate(d), []);
  assert.equal(gate(d).result, "FAIL");
  assert.equal(gate(d).confidence, "medium"); // no plan
});

test("secret in a config file is blocking and masked; allow marker makes it a note; examples with placeholders pass", () => {
  const secret = "Zp4Kq9Wm2Xc7Vb5Nn8Lr3Tj6";
  const r = repoWith({ "a.txt": "x" }, {
    "config/app.yaml": `service: x\napi_key: "${secret}"\n`,
    "config/test.yaml": `token: "${secret}" # proofline:allow-secret\n`,
    ".env.example": "API_KEY=changeme\nSECRET_TOKEN=<your token>\n",
    ".env": "REAL_THING=abc\n",
  });
  const d = buildDocument({ repo: r, base: "HEAD", planText: null });
  assert.deepEqual(sum(d, "blocking"), ["secret_plaintext:REAL_THING", "secret_plaintext:api_key"]);
  assert.deepEqual(sum(d, "note").filter((n) => n.startsWith("secret")), ["secret_allowlisted:token"]);
  assert.ok(!JSON.stringify(d).includes(secret));
  assert.deepEqual(validate(d), []);
});

test("flags: default on without plan mention, planned, removed but referenced, reordered", () => {
  const r = repoWith(
    { "config/flags.yaml": "features:\n  old_a: true\n  old_b: true\n  kept: true\n", "src/use.js": "if (flags.old_a) run();\nif (flags.old_b) run();\n" },
    { "config/flags.yaml": "features:\n  kept: true\n  old_b: true\n  fresh: true\n  planned_one: true\n  off_one: false\n", "src/use.js": "if (flags.old_a) run();\nif (flags.old_b) run();\n" },
  );
  const d = buildDocument({ repo: r, base: "HEAD", planText: "## Behavior\n\n- turn on planned_one\n" });
  assert.deepEqual(sum(d, "blocking"), ["flag_default_on:fresh", "flag_removed_referenced:old_a"]);
  assert.deepEqual(sum(d, "note"), ["flag_default_off:off_one", "flag_default_on_planned:planned_one"]);
});

test("validator rejects a wrong class, a leaked secret and a non-measured item", () => {
  const r = repoWith({ "a.txt": "x" }, { "src/a.js": "process.env.UNDOC_X;\n" });
  const d = buildDocument({ repo: r, base: "HEAD", planText: "## Behavior\n" });
  const e = (m) => assert.ok(validate(m).length > 0);
  const c1 = JSON.parse(JSON.stringify(d)); c1.items[0].class = "note"; e(c1);
  const c2 = JSON.parse(JSON.stringify(d)); c2.items[0].detail = "ghp_" + "a".repeat(36); e(c2);
  const c3 = JSON.parse(JSON.stringify(d)); c3.items[0].evidence = "judged"; e(c3);
  assert.deepEqual(validate(d), []);
  assert.match(tableRows(d), /\| blocking \| src\/a\.js:1 \|/);
});

test("CLI: validate-config exit codes", () => {
  const r = repoWith({ "a.txt": "x" }, { "src/a.js": "process.env.UNDOC_X;\n" });
  const f = join(mktmp(), "c.json");
  const C = new URL("../../skills/proof-review/scripts/check-config.mjs", import.meta.url).pathname;
  const V = new URL("../../skills/proof-review/scripts/validate-config.mjs", import.meta.url).pathname;
  assert.equal(spawnSync("node", [C, "--base", "HEAD", "--repo", r, "--out", f], { encoding: "utf8" }).status, 0);
  const v = spawnSync("node", [V, f], { encoding: "utf8" });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^RESULT: FAIL\n/);
  assert.equal(spawnSync("node", [C], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("node", [V], { encoding: "utf8" }).status, 2);
});

test("destructuring the environment, bare environ, os.ExpandEnv", () => {
  const d = destructuredEnv('const { A, B = "x", C: renamed, ...rest } = process.env;\nconst {\n  M1,\n  NODE_ENV,\n} = import.meta.env;\n');
  assert.deepEqual(d.map((x) => [x.name, x.line]), [["A", 1], ["B", 1], ["C", 1], ["M1", 3]]);
  assert.deepEqual(destructuredEnv("const { a } = obj;"), []);
  assert.deepEqual(envUsages('from os import environ\nx = environ["PY_BARE"]', "code"), ["PY_BARE"]);
  assert.deepEqual(envUsages('p := os.ExpandEnv("${GO_DIR}/x")', "code"), ["GO_DIR"]);
});

test("destructured reads are found when the change adds them", () => {
  const r = repoWith({ ".env.example": "KNOWN=1\n" }, { "src/c.js": 'const {\n  KNOWN,\n  NEWVAR = "d",\n} = process.env;\n' });
  const d = buildDocument({ repo: r, base: "HEAD", planText: null });
  assert.deepEqual(sum(d, "blocking"), ["env_undocumented:NEWVAR"]);
  assert.equal(d.items[0].location.line, 3);
});

test("validate-config rejects any secret pattern in a hand-written document, generic included", () => {
  const r = repoWith({ "a.txt": "x" }, { "src/a.js": "process.env.UNDOC_X;\n" });
  const d = buildDocument({ repo: r, base: "HEAD", planText: "## Behavior\n" });
  const c = JSON.parse(JSON.stringify(d));
  c.items[0].detail = 'api_key: "Zp4Kq9Wm2Xc7Vb5Nn8Lr3Tj6"';
  assert.ok(validate(c).some((m) => /secret pattern/.test(m)));
});
