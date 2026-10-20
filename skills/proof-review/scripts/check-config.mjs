#!/usr/bin/env node
// Config consistency check for the proof-review `config` focus (REVIEW_RULES / REVIEW_SMALL risk focus).
// Deterministic, regex based, language agnostic for the common ecosystems, no dependencies, no network.
// Usage: node check-config.mjs --base <rev> [--repo <dir>] [--plan <PLAN.md>] [--out <file>]
//   Writes the config-check document (see ../references/CONFIG.md) to --out or stdout. Exit 0 / 2 (usage, git).
// Only lines the change adds (or removes, for flags) are judged; pre-existing state is never a finding.
// Secret values are never copied into the document: only rule name, key name and value length.
// Limits are listed in references/CONFIG.md; the document repeats them in `limits`.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_VERSION = "0.0.20";
export const ALLOW_MARKER = "proofline:allow-secret";
const MAX_BYTES = 1024 * 1024, MAX_FILES = 5000;
const AMBIENT = new Set(["PATH", "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM", "HOSTNAME", "TZ", "EDITOR", "CI", "NODE_ENV", "DEBUG", "COLUMNS", "LINES", "NO_COLOR", "FORCE_COLOR"]);
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".adoc"]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".py", ".go", ".rs", ".rb", ".php", ".java", ".kt", ".kts", ".scala", ".cs", ".swift", ".ex", ".exs"]);
const CONFIG_EXT = new Set([".yaml", ".yml", ".json", ".toml", ".ini", ".cfg", ".conf", ".properties", ".xml", ".env", ".hcl", ".tf", ".tfvars"]);
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|target|\.git|coverage|\.venv|__pycache__)\//;
const LOCKISH = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|composer\.lock|packages\.lock\.json|[^/]*\.lock|go\.sum|pnpm-lock\.yaml)$/;

// --- file buckets ----------------------------------------------------------------------------------------
export function bucket(path) {
  const b = basename(path), e = extname(path).toLowerCase();
  if (SKIP_DIR.test(path) || LOCKISH.test(path)) return "skip";
  if (/(^|\.)(example|sample|template|dist)(\.|$)/i.test(b)) return "example";
  if (b === ".env" || /^\.env\./.test(b) || /\.env$/.test(b) || (/\.env\.[A-Za-z0-9_-]+$/.test(b) && !CODE_EXT.has(e))) return "envfile"; // .env, .env.*, *.env, config.env.*, *.env.*
  if (DOC_EXT.has(e)) return "doc";
  if (CODE_EXT.has(e)) return "code";
  if (CONFIG_EXT.has(e) || /^(appsettings.*|docker-compose.*|compose.*)\.(json|ya?ml)$/.test(b)) return "config";
  return "other";
}

// --- environment variable usage -------------------------------------------------------------------------
const ID = "([A-Za-z_][A-Za-z0-9_]*)";
const USAGE = [
  new RegExp(`process\\.env\\.${ID}`, "g"), new RegExp(`process\\.env\\[\\s*['"\`]${ID}['"\`]\\s*\\]`, "g"),
  new RegExp(`import\\.meta\\.env\\.${ID}`, "g"), new RegExp(`Deno\\.env\\.get\\(\\s*['"]${ID}['"]`, "g"),
  new RegExp(`os\\.environ\\[\\s*['"]${ID}['"]\\s*\\]`, "g"), new RegExp(`os\\.environ\\.get\\(\\s*['"]${ID}['"]`, "g"),
  new RegExp(`os\\.getenv\\(\\s*['"]${ID}['"]`, "g"),
  new RegExp(`(?<![\\w.])environ(?:\\.get\\(\\s*|\\[\\s*)['"]${ID}['"]`, "g"), // from os import environ
  new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*"${ID}"`, "g"),
  new RegExp(`env::var(?:_os)?\\(\\s*"${ID}"`, "g"), new RegExp(`env!\\(\\s*"${ID}"`, "g"),
  new RegExp(`\\bENV\\[\\s*['"]${ID}['"]\\s*\\]`, "g"), new RegExp(`\\bENV\\.fetch\\(\\s*['"]${ID}['"]`, "g"),
  new RegExp(`\\bgetenv\\(\\s*['"]${ID}['"]`, "g"), new RegExp(`\\$_(?:ENV|SERVER)\\[\\s*['"]${ID}['"]\\s*\\]`, "g"),
  new RegExp(`System\\.getenv\\(\\s*"${ID}"`, "g"), new RegExp(`Environment\\.GetEnvironmentVariable\\(\\s*"${ID}"`, "g"),
];
const CONFIG_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-?+][^}]*)?\}/g; // ${VAR}, ${VAR:-default}
const FALSY = /^(false|off|no|disabled|0)$/i;
// `const { A, B = "x", C: renamed } = process.env` (also import.meta.env), possibly over several lines. Returns
// [{name, line}] for the whole text; the caller keeps the names whose line the change added.
export function destructuredEnv(text) {
  const out = [];
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.env|import\.meta\.env)\b/g)) {
    let off = m.index + 1;
    for (const part of m[1].split(",")) {
      const t = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:=]|$)/.exec(part);
      if (t && !part.trim().startsWith("...")) out.push({ name: t[1], line: text.slice(0, off + part.indexOf(t[1])).split("\n").length });
      off += part.length + 1;
    }
  }
  return out.filter((d) => !AMBIENT.has(d.name));
}
export function envUsages(line, kind) {
  const out = [];
  if (kind === "code") for (const re of USAGE) for (const m of line.matchAll(re)) out.push(m[1]);
  // Go: os.ExpandEnv("${X}/path"), os.Expand
  if (kind === "code" && /\bos\.Expand(?:Env)?\(/.test(line)) for (const m of line.matchAll(CONFIG_REF)) out.push(m[1]);
  if (kind === "config" || kind === "example") for (const m of line.matchAll(CONFIG_REF)) out.push(m[1]);
  return [...new Set(out)].filter((n) => !AMBIENT.has(n));
}
// A default that turns a flag-like variable on: `process.env.X || 'true'`, `?? "1"`, `os.getenv("X", "true")`.
export function envDefaultOn(line, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${n}['"\\]\\)]*\\s*(?:\\|\\||\\?\\?)\\s*['"]?(true|1|on|yes|enabled)['"]?\\b`, "i").test(line) ||
    new RegExp(`getenv\\(\\s*['"]${n}['"]\\s*,\\s*['"]?(true|1|on|yes|enabled)['"]?\\s*\\)`, "i").test(line) ||
    new RegExp(`environ\\.get\\(\\s*['"]${n}['"]\\s*,\\s*['"]?(true|1|on|yes|enabled)['"]?\\s*\\)`, "i").test(line);
}

// --- secrets (same rule names as control-plane/agents/scripts/secret-scan.sh) --------------------------
const SECRET_RULES = [
  ["aws_access_key_id", /(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}/],
  ["aws_secret_access_key", /aws_?secret_?access_?key[^=:]{0,20}[=:]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ["github_token", /(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["gitlab_token", /glpat-[A-Za-z0-9_-]{20,}/],
  ["slack_token", /(xox[abposr]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+)/],
  ["private_key", /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----/],
  ["jwt", /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
];
const GENERIC = /(api[_-]?key|secret|passw(?:or)?d|token|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["']?\s*(?::=|=|:)\s*["']?([^"'\s#,}]{16,})["']?/i;
const entropy = (s) => { const c = {}; for (const ch of s) c[ch] = (c[ch] ?? 0) + 1; return -Object.values(c).reduce((h, n) => h + (n / s.length) * Math.log2(n / s.length), 0); };
// Returns [{rule, key, length}] for one line; never the value itself.
export function scanLine(line, kind) {
  const hits = [];
  for (const [rule, re] of SECRET_RULES) { const m = re.exec(line); if (m) hits.push({ rule, key: "", length: m[0].length }); }
  const g = GENERIC.exec(line);
  if (g) {
    const v = g[2];
    if (v.length >= 16 && !/^[$<{%]/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3.5) hits.push({ rule: "generic_secret", key: g[1], length: v.length });
  }
  if (kind === "envfile") {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s#]\S*)/.exec(line);
    if (m && !hits.length) hits.push({ rule: "env_file", key: m[1], length: m[2].length });
  }
  return hits;
}

// --- feature flags ---------------------------------------------------------------------------------------
const FLAG_NAME = /(feature|flag|toggle|experiment|rollout)/i;
const FLAG_PARENT = /^(features?|feature[_-]?flags?|flags|toggles?|experiments?)$/i;
const FLAG_LINE = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?(true|false|on|off|yes|no|enabled|disabled|1|0)["']?\s*,?\s*(?:#.*)?$/i;
export function parentKeys(lines, idx) {
  const out = []; let ind = lines[idx].match(/^\s*/)[0].length;
  for (let i = idx - 1; i >= 0 && ind > 0; i--) {
    const l = lines[i]; if (!l.trim() || /^\s*(#|\/\/)/.test(l)) continue;
    const li = l.match(/^\s*/)[0].length;
    if (li < ind) { const m = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*[{]?\s*$/.exec(l); if (m) out.push(m[1]); ind = li; }
  }
  return out;
}
export function flagFromLine(lines, idx) {
  const m = FLAG_LINE.exec(lines[idx]); if (!m) return null;
  const name = m[1];
  if (!(FLAG_NAME.test(name) || parentKeys(lines, idx).some((p) => FLAG_PARENT.test(p)))) return null;
  return { name, on: !FALSY.test(m[2]) };
}
// The flag's identity in its file: parent keys plus the leaf, so `a.enabled` and `b.enabled` are two flags.
export const flagQName = (lines, idx, name) => [...parentKeys(lines, idx).reverse(), name].join(".");

// --- plan ---------------------------------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function planMentions(text, name) {
  const variants = new Set([name, name.replace(/[_.-]/g, "_"), name.replace(/[_.-]/g, "-"), name.replace(/[_.-]/g, ".")]);
  return [...variants].some((v) => new RegExp(`(^|[^A-Za-z0-9_])${esc(v)}(?![A-Za-z0-9_])`, "i").test(text));
}

// --- git ----------------------------------------------------------------------------------------------------
const git = (repo, args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const baseText = (repo, base, p) => { try { return git(repo, ["show", `${base}:${p}`]); } catch { return null; } };
const headText = (repo, p) => { const f = join(repo, p); try { const s = statSync(f); if (!s.isFile()) return null; if (s.size > MAX_BYTES) return ""; return readFileSync(f, "utf8"); } catch { return null; } };
const isText = (t) => t != null && !t.includes("\0");

// Added and removed line numbers of one file (head numbering for added, base numbering for removed).
export function diffLines(repo, base, path, tracked) {
  if (!tracked) { const t = headText(repo, path); return { added: t == null ? [] : t.split("\n").map((_, i) => i + 1).slice(0, t.endsWith("\n") ? -1 : undefined), removed: [] }; }
  const added = [], removed = [];
  const d = git(repo, ["diff", "-U0", "--no-color", "--no-renames", base, "--", path]);
  let a = 0, r = 0;
  for (const l of d.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { r = +h[1]; a = +h[2]; continue; }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added.push(a++); else if (l.startsWith("-")) removed.push(r++);
  }
  return { added, removed };
}

export function buildDocument({ repo, base, planText }) {
  const tracked = new Set(git(repo, ["ls-tree", "-r", "--name-only", "-z", base]).split("\0").filter(Boolean));
  const names = new Set(git(repo, ["diff", "--name-only", "--no-renames", "-z", base, "--"]).split("\0").filter(Boolean));
  const untracked = new Set(git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
  for (const p of untracked) names.add(p);
  const changed = [...names].filter((p) => !p.startsWith(".agents/runs/") && !p.startsWith(".agents/local/")).sort();
  const everything = [...new Set([...git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean), ...untracked])]
    .filter((p) => !p.startsWith(".agents/runs/") && !p.startsWith(".agents/local/")).sort();

  const items = [], notReviewed = [];
  const add = (it) => items.push({ id: `G${String(items.length + 1).padStart(3, "0")}`, evidence: "measured", ...it });
  const planKnown = planText != null;

  // Lazily built views of the head state.
  let docTokens = null, codeTokens = null, refs = null;
  const fileTexts = () => {
    if (refs) return refs;
    refs = []; let n = 0;
    for (const p of everything) {
      const k = bucket(p); if (k === "skip" || k === "doc") continue;
      if (++n > MAX_FILES) { notReviewed.push({ path: ".", reason: `more than ${MAX_FILES} files: reference search truncated` }); break; }
      const t = headText(repo, p); if (isText(t) && t !== "") refs.push({ path: p, kind: k, text: t });
    }
    return refs;
  };
  const tokens = (text, into) => { for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) into.add(m[0]); };
  const docSet = () => {
    if (docTokens) return docTokens;
    docTokens = new Set();
    for (const p of everything) { const k = bucket(p); if (k !== "doc" && k !== "example") continue; const t = headText(repo, p); if (isText(t)) tokens(t, docTokens); }
    return docTokens;
  };
  const codeSet = () => {
    if (codeTokens) return codeTokens;
    codeTokens = new Set(); for (const f of fileTexts()) if (f.kind !== "example") tokens(f.text, codeTokens);
    return codeTokens;
  };

  const addedFlagNames = new Set(), seenEnv = new Set();
  const flagCandidates = [], removedFlags = [];
  const exampleDefined = [];

  for (const path of changed) {
    const k = bucket(path); if (k === "skip" || k === "other") continue;
    const head = headText(repo, path), isTracked = tracked.has(path);
    if (head === "") { notReviewed.push({ path, reason: "larger than 1 MiB" }); }
    if (head != null && !isText(head)) continue;
    const { added, removed } = diffLines(repo, base, path, isTracked);
    const lines = (head ?? "").split("\n");
    // A line that the same diff also removed (moved or re-indented) is not a new line. Position matters: the same
    // text elsewhere in the file does not hide a new line (a flag flipped to `enabled: true` next to another one).
    const baseLines = isTracked ? (baseText(repo, base, path) ?? "").split("\n") : [];
    const baseSet = new Set(removed.map((n) => (baseLines[n - 1] ?? "").trim()).filter(Boolean));
    const destructured = k === "code" && head ? destructuredEnv(head) : [];

    for (const ln of added) {
      const line = lines[ln - 1]; if (line == null) continue;
      if (baseSet.has(line.trim())) continue;
      const allowed = line.includes(ALLOW_MARKER);
      // 1. environment variables used but not documented
      if (k === "code" || k === "config" || k === "example") {
        for (const name of envUsages(line, k)) {
          if (k !== "example" && !seenEnv.has(name + "\0" + path)) {
            seenEnv.add(name + "\0" + path);
            if (!docSet().has(name)) add({ check: "env_undocumented", class: "blocking", location: { file: path, line: ln }, subject: name, detail: `${name} is read here but defined in no example env file, config sample or documentation` });
          }
          if (k === "code" && FLAG_NAME.test(name) && envDefaultOn(line, name)) flagCandidates.push({ name, path, ln, source: "env default" });
        }
      }
      for (const d of destructured) {
        if (d.line !== ln || seenEnv.has(d.name + "\0" + path)) continue;
        seenEnv.add(d.name + "\0" + path);
        if (!docSet().has(d.name)) add({ check: "env_undocumented", class: "blocking", location: { file: path, line: ln }, subject: d.name, detail: `${d.name} is read here (destructured from the environment) but defined in no example env file, config sample or documentation` });
      }
      // 2. plain-text secrets in config files
      if (k === "config" || k === "envfile" || k === "example") {
        for (const h of scanLine(line, k)) {
          if (allowed) add({ check: "secret_allowlisted", class: "note", location: { file: path, line: ln }, subject: h.key || h.rule, detail: `${h.rule}: line carries ${ALLOW_MARKER} (project convention), value masked` });
          else add({ check: "secret_plaintext", class: "blocking", location: { file: path, line: ln }, subject: h.key || h.rule, detail: `${h.rule}: plain-text secret in a config file, value masked (length ${h.length}); keep it in the environment or a secret store` });
        }
      }
      // 3. feature flags
      if (k === "config" || k === "envfile" || k === "example") {
        const f = flagFromLine(lines, ln - 1);
        if (f) { const qname = flagQName(lines, ln - 1, f.name); addedFlagNames.add(qname); flagCandidates.push({ ...f, qname, path, ln, source: "config" }); }
      }
      // documented but unused (example env files)
      if (k === "example") { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line); if (m) exampleDefined.push({ name: m[1], path, ln }); }
    }

    if (k === "config" || k === "envfile" || k === "example") {
      const stillDefined = new Set(lines.map((_, i) => { const g = flagFromLine(lines, i); return g ? flagQName(lines, i, g.name) : null; }).filter(Boolean));
      for (const ln of removed) {
        const f = baseLines[ln - 1] != null ? flagFromLine(baseLines, ln - 1) : null;
        const q = f ? flagQName(baseLines, ln - 1, f.name) : null;
        if (f && !stillDefined.has(q)) removedFlags.push({ name: f.name, qname: q, path, ln });
      }
    }
  }

  // flag decisions
  const seenFlag = new Set();
  for (const f of flagCandidates) {
    const key = (f.qname ?? f.name) + "\0" + f.path; if (seenFlag.has(key)) continue; seenFlag.add(key);
    const loc = { file: f.path, line: f.ln };
    if (f.on === false) { add({ check: "flag_default_off", class: "note", location: loc, subject: f.name, detail: `flag ${f.name} is set to off by the change` }); continue; }
    const planned = planKnown && planMentions(planText, f.name);
    if (!planKnown) add({ check: "flag_default_on", class: "note", location: loc, subject: f.name, detail: `flag ${f.name} is set to on (${f.source}) by the change; no plan to compare against` });
    else if (planned) add({ check: "flag_default_on_planned", class: "note", location: loc, subject: f.name, detail: `flag ${f.name} is set to on by the change; the plan names it` });
    else add({ check: "flag_default_on", class: "blocking", location: loc, subject: f.name, detail: `flag ${f.name} is set to on (${f.source}) by the change and the plan does not name it` });
  }
  const seenRm = new Set();
  for (const r of removedFlags) {
    if (seenRm.has(r.qname) || addedFlagNames.has(r.qname)) continue; seenRm.add(r.qname);
    const re = new RegExp(`(^|[^A-Za-z0-9_])${esc(r.name)}(?![A-Za-z0-9_])`);
    const hits = [];
    for (const f of fileTexts()) { if (f.path === r.path && !re.test(f.text)) continue; const ls = f.text.split("\n"); for (let i = 0; i < ls.length && hits.length < 5; i++) if (re.test(ls[i]) && !(f.path === r.path && flagFromLine(ls, i))) hits.push({ file: f.path, line: i + 1 }); }
    if (hits.length) add({ check: "flag_removed_referenced", class: "blocking", location: hits[0], subject: r.name, detail: `flag ${r.name} was removed from ${r.path} but is still referenced at ${hits.map((h) => `${h.file}:${h.line}`).join(", ")}` });
  }
  const seenEx = new Set();
  for (const e of exampleDefined) {
    if (seenEx.has(e.name) || AMBIENT.has(e.name)) continue; seenEx.add(e.name);
    if (!codeSet().has(e.name)) add({ check: "env_documented_unused", class: "note", location: { file: e.path, line: e.ln }, subject: e.name, detail: `${e.name} is documented but read nowhere in the repository` });
  }

  return {
    schema_version: 1, skill_version: SKILL_VERSION, base, head: "working_tree",
    plan: { status: planKnown ? "checked" : "none" },
    items, not_reviewed: notReviewed,
    limits: [
      "only lines added by the change are judged (flags: also removed lines)",
      "environment variable reads are matched by literal name in common idioms; dynamic names and shell scripts are not matched",
      "documented means the name appears in an example/sample/template file or a Markdown, reStructuredText or AsciiDoc file",
      "secrets use the secret-scan rule names; unquoted values are matched only in config files; a project's own secret scanner is not run here",
      "a feature flag is a boolean key whose name contains feature, flag, toggle, experiment or rollout, or that sits under a features/flags/toggles block",
    ],
  };
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) { if (!argv[i].startsWith("--") || argv[i + 1] === undefined) { console.error("usage: check-config.mjs --base <rev> [--repo <dir>] [--plan <PLAN.md>] [--out <file>]"); return 2; } a[argv[i].slice(2)] = argv[i + 1]; }
  if (!a.base) { console.error("--base <rev> is required"); return 2; }
  try {
    const planText = a.plan ? readFileSync(resolve(a.plan), "utf8") : null;
    const doc = buildDocument({ repo: resolve(a.repo ?? "."), base: a.base, planText });
    const out = JSON.stringify(doc, null, 2) + "\n";
    if (a.out) writeFileSync(a.out, out); else process.stdout.write(out);
    return 0;
  } catch (e) { console.error(`check-config: ${e.message}`); return 2; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
