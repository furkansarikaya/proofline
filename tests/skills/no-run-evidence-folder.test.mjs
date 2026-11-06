import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

// A223 (user decision on A219): `evidence/` is NOT an official run folder. Evidence lives in `reports/` and
// `worker-evidence/`; temporary files live in `scratch/`. No role file, control-plane markdown or template,
// dispatch prompt, skill text or doc may name the run-level folder `.agents/runs/<ID>/evidence/` as a place
// to write. `evidence/` INSIDE a skill's own registered output folder (reviews/test-trust/.../evidence/,
// security/evidence/, reviews/proof-review/<dir>/evidence/ ...) is a different thing and is not matched.
const REPO = new URL("../../", import.meta.url).pathname;

// The legitimate mentions: the cleanup path for strays (A219) and the decision records that tell the history.
const ALLOW = new Set([
  "control-plane/agents/ENFORCEMENT.md",
  "docs/decisions.md",
]);

// Skills whose own registered output folder has an `evidence/` subfolder; "the evidence folder" there means that one.
const NESTED_OK = ["skills/proof-review/", "skills/test-trust/", "skills/exploit-proof/", "skills/concurrency-proof/"];

const SCAN_ROOTS = ["roles", "control-plane", "skills", "docs", "README.md"];
const SKIP_DIRS = new Set(["node_modules", ".git", "scripts", "schema", "library", "fixtures"]);
const TEXT = /\.(md|yaml|yml|tpl|txt)$/;

function* walk(dir) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) yield* walk(p); }
    else if (TEXT.test(n)) yield p;
  }
}
function files() {
  const out = [];
  for (const r of SCAN_ROOTS) {
    const p = join(REPO, r);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  // dispatch prompts are text inside the shell/Node scripts
  out.push(join(REPO, "control-plane/agents/scripts/dispatch.sh"));
  return out;
}

// A line that names the run-level evidence folder. `qa-evidence/` and `worker-evidence/` are other folders.
const PATTERNS = [
  [/(\.agents\/)?runs\/(<[^>\n]+>|\*|\$\{?\w+\}?|[A-Za-z0-9_-]+)\/evidence\//i, "runs/<ID>/evidence/"],
  [/<(run|run-dir|run-folder)>\/evidence\//i, "<run>/evidence/"],
  [/\brun (folder|directory|dir) (has |with |: )?`?evidence\//i, "run folder evidence/"],
  [/\bevidence\/ (folder|directory) (of|in|under|inside) (the |a |your )?run\b/i, "evidence/ folder of the run"],
  [/\b(the|a) evidence (folder|directory) (of|in|under|inside) (the |a |your )?run\b/i, "the evidence folder of the run"],
  [/\brun-level evidence\b/i, "run-level evidence"],
  [/\bmkdir\b[^\n]*(^|[\s/`'"])evidence\b/i, "mkdir evidence"],
  // a bare "the evidence folder" is ambiguous in a run; name the registered folder instead (reports/qa-evidence/)
  [/\bthe evidence (folder|directory)\b(?![^\n]*(qa-evidence|worker-evidence))/i, "the evidence folder"],
];

export function offences(text, rel = "") {
  const bad = [];
  const nested = NESTED_OK.some((p) => rel.startsWith(p));
  text.split("\n").forEach((l, i) => {
    for (const [re, name] of PATTERNS) if (!(nested && name === "the evidence folder") && re.test(l)) bad.push(`${i + 1}: [${name}] ${l.trim().slice(0, 120)}`);
  });
  return bad;
}

test("no role, control-plane text, skill or doc names the run-level evidence/ folder", () => {
  const problems = [];
  let n = 0;
  for (const f of files()) {
    const rel = relative(REPO, f);
    if (ALLOW.has(rel) || !existsSync(f)) continue;
    n++;
    for (const b of offences(readFileSync(f, "utf8"), rel)) problems.push(`${rel}:${b}`);
  }
  assert.ok(n > 100, `scanned only ${n} files`);
  assert.deepEqual(problems, []);
});

test("the explorer is told where to write: scratch report, submit --report, no evidence/ folder", () => {
  const role = readFileSync(join(REPO, "roles/explorer.md"), "utf8");
  const skill = readFileSync(join(REPO, "skills/evidence-map/SKILL.md"), "utf8");
  for (const t of [role, skill]) {
    assert.match(t, /scratch\/<your agent token>-report\.md/);
    assert.match(t, /never create an `evidence\/` folder in the run directory/i);
  }
  assert.match(skill, /submit --report/);
});

test("known-bad lines are caught, registered folders are not", () => {
  for (const bad of [
    "Write your copy to `.agents/runs/T-1/evidence/copy.md`.",
    "save it under .agents/runs/<TASK-ID>/evidence/x.txt",
    "put the file in the evidence folder of the run",
    "the run folder evidence/ holds the copies",
    "mkdir -p .agents/runs/$ID/evidence",
    "scripts live in the evidence folder",
  ]) assert.ok(offences(bad).length > 0, bad);
  for (const ok of [
    "write to `.agents/runs/<TASK-ID>/reviews/test-trust/tests/evidence/x.out`",
    "`reports/qa-evidence/` and `worker-evidence/`",
    "raw output is saved under `evidence/` in the output folder",
    "the evidence folder (in a run: `reports/qa-evidence/`)",
    "cited evidence must live in `reports/`",
  ]) assert.deepEqual(offences(ok), [], ok);
});
