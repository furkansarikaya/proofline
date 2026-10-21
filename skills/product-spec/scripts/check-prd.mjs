#!/usr/bin/env node
// Deterministic PRD check and readiness gate (references/PRD-FORMAT.md). No dependencies, no network, no model.
//   node check-prd.mjs <PRD.md|slug> [--json] [--root DIR]          findings; exit 0 clean, 1 findings, 2 usage
//   node check-prd.mjs --ready <PRD.md|slug> [--json] [--root DIR]  split readiness; exit 0 ready, 1 not, 2 usage
// A slug resolves to <product.dir>/<slug>/PRD.md under DIR (default: the current directory).
// Extra unmeasurable words: config product.vague_words (comma-separated) in DIR/.agents/config.yaml.
// --ready also refuses a split when <slug>/DECISION.md has the effective line `decision: stop`.
// `[fact: ref <slug>#C-n]` facts are resolved under DIR (references/EVIDENCE.md).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateClaims } from "./validate-product-claims.mjs";

export const SECTIONS = ["Problem", "Goals", "Non-goals", "User stories", "Functional requirements", "Non-functional requirements", "Success metrics", "Assumptions", "Open questions"];
export const VERDICTS = ["ship", "ship-with-conditions", "do-not-ship"];
// Words an acceptance criterion cannot be measured by. English and Turkish; extended by product.vague_words.
export const VAGUE_WORDS = [
  "robust", "seamless", "seamlessly", "etc.", "etc", "and so on", "user-friendly", "user friendly", "fast", "faster", "quick", "quickly",
  "intuitive", "easy", "easily", "simple", "simply", "scalable", "flexible", "efficient", "efficiently", "modern", "powerful", "smooth",
  "smoothly", "properly", "appropriate", "appropriately", "as needed", "optimal", "reasonable",
  "kullanıcı dostu", "hızlı", "hızlıca", "çabuk", "sağlam", "kolay", "kolayca", "sezgisel", "basit", "esnek", "ölçeklenebilir",
  "verimli", "sorunsuz", "kusursuz", "güçlü", "uygun", "makul", "vb.", "vs.", "gibi şeyler",
];
// TBD and TODO in capitals, or ???, anywhere; "unknown" words only as the whole value of a list item or a `key: value` field.
const TBD = /\b(TBD|TODO)\b|\?\?\?/;
const UNKNOWN_VALUE = /^(unknown|bilinmiyor|belli değil)[.!]?$/i;
export function unknownIn(line) {
  const t = TBD.exec(line);
  if (t) return t[0];
  const item = line.replace(/^\s*[-*]\s+/, "").replace(/^[A-Z]+-\d+(?:\.\d+)?:\s*/, "");
  const values = [item, ...item.split(";").map((part) => /^\s*[\p{L}][\p{L} _-]*:\s*(.*)$/u.exec(part)?.[1] ?? part)];
  for (const v of values) {
    const bare = v.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)\s*$/, "").trim();
    if (UNKNOWN_VALUE.test(bare)) return bare;
  }
  return null;
}
// A template placeholder `<...>`; a real HTML tag (`<table>`, `</td>`, `<br/>`) and an autolink are none.
const HTML_TAGS = new Set("a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp section small source span strong sub summary sup table tbody td tfoot th thead tr u ul var video audio".split(" "));
export function placeholders(text) {
  const src = text.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
  const out = [];
  for (const m of src.matchAll(/<([A-Za-z/][^<>\n]{0,120})>/g)) {
    const inner = m[1];
    const tag = /^\/?([a-z][a-z0-9]*)(\s+[a-z-]+(=("[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?$/i.exec(inner);
    if (tag && HTML_TAGS.has(tag[1].toLowerCase())) continue;
    if (/^[a-z][a-z0-9+.-]*:\S+$/i.test(inner) || /^[^\s@]+@[^\s@]+$/.test(inner)) continue;
    out.push(m[0]);
  }
  return out;
}
const REF = /\b(Q|A)-\d+\b/;
const NONE = /^(none|yok)\.?$/i;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const vagueRegex = (words) => new RegExp(`(?<![\\p{L}\\p{N}])(${[...new Set(words)].sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}\\p{N}])`, "iu");

// Value of `<block>.<key>` from an indented config.yaml (top-level block, one level of keys), or null.
export function configValue(root, block, key) {
  const p = join(root, ".agents", "config.yaml");
  if (!existsSync(p)) return null;
  let inBlock = false;
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (/^\S/.test(l)) { inBlock = new RegExp(`^${block}:\\s*(#.*)?$`).test(l); continue; }
    const m = inBlock && new RegExp(`^  ${key}:\\s*(.*?)\\s*$`).exec(l);
    if (m) { const v = m[1].replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1"); return v === "" ? null : v; }
  }
  return null;
}
export const productDir = (root) => configValue(root, "product", "dir") || "docs/product";
// product.stale_days: age in days after which an observed competitor cell is stale; a positive integer, default 90.
export const DEFAULT_STALE_DAYS = 90;
export function staleDays(root) {
  const v = configValue(root, "product", "stale_days");
  return v !== null && /^[1-9][0-9]*$/.test(v) ? Number(v) : DEFAULT_STALE_DAYS;
}
export const tasksDir = (root) => configValue(root, "tasks", "dir") || ".agents/tasks";

export function resolvePrd(arg, root) {
  if (existsSync(arg)) return resolve(arg);
  if (!/[\\/]/.test(arg)) return join(root, productDir(root), arg, "PRD.md");
  return resolve(arg);
}

// Parses a PRD into sections (H2) with their lines; H3 subsections are kept per H2.
export function parsePrd(text) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, "")).split(/\r?\n/);
  const secs = new Map();
  let cur = null, sub = null, fence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const h2 = /^## (.+?)\s*$/.exec(raw), h3 = /^### (.+?)\s*$/.exec(raw);
    if (h2) { cur = { name: h2[1], lines: [], subs: new Map(), line: i + 1 }; secs.set(h2[1], cur); sub = null; return; }
    if (h3 && cur) { sub = { name: h3[1], lines: [], line: i + 1 }; cur.subs.set(h3[1], sub); return; }
    if (!cur) return;
    const row = { n: i + 1, text: raw };
    cur.lines.push(row);
    if (sub) sub.lines.push(row);
  });
  const items = (rows) => rows.filter((r) => /^\s*[-*]\s+\S/.test(r.text)).map((r) => ({ n: r.n, text: r.text.replace(/^\s*[-*]\s+/, "").trim() }));
  const reqs = [];
  for (const [name, prefix] of [["Functional requirements", "FR"], ["Non-functional requirements", "NFR"]]) {
    for (const it of items(secs.get(name)?.lines || [])) {
      const m = /^(N?FR)-(\d+):\s*(.*)$/.exec(it.text);
      reqs.push({ section: name, prefix, line: it.n, id: m ? `${m[1]}-${m[2]}` : null, text: m ? m[3] : it.text });
    }
  }
  const stories = [];
  for (const [name, s] of secs.get("User stories")?.subs || []) {
    const m = /^(US-\d+):\s*(.*)$/.exec(name);
    const acs = items(s.lines).map((it) => { const a = /^(AC-\d+(?:\.\d+)?):\s*(.*)$/.exec(it.text); return { line: it.n, id: a?.[1] || null, text: a ? a[2] : it.text }; });
    stories.push({ id: m?.[1] || null, title: m ? m[2] : name, line: s.line, acs });
  }
  const oq = secs.get("Open questions");
  const qs = (n) => items(oq?.subs.get(n)?.lines || []).filter((it) => !NONE.test(it.text));
  const deferred = items(secs.get("Deferred")?.lines || []).filter((it) => !NONE.test(it.text)).map((it) => {
    const m = /^(N?FR-\d+):\s*(.*)$/.exec(it.text);
    return { line: it.n, id: m?.[1] || null, reason: (m?.[2] || "").trim() };
  });
  const title = /^# PRD: (.+?)\s*$/m.exec(text)?.[1] || null;
  return { title, secs, items, reqs, stories, blocking: qs("Blocking"), nonBlocking: qs("Non-blocking"), deferred };
}

export function checkPrd(text, opts = {}) {
  const findings = [], warnings = [];
  const add = (rule, line, message) => findings.push({ rule, line, message });
  const p = parsePrd(text);
  if (!p.title) add("structure", 1, "H1 must be `# PRD: <title>`");
  for (const s of SECTIONS) if (!p.secs.has(s)) add("missing-section", 1, `missing section "## ${s}"`);
  const problem = p.secs.get("Problem");
  if (problem && !problem.lines.some((r) => /^\s*Who:\s*\S/.test(r.text))) add("problem-owner", problem.line, "## Problem names no owner: add a `Who: <whose problem it is>` line");
  const ng = p.secs.get("Non-goals");
  if (ng && !p.items(ng.lines).some((it) => !NONE.test(it.text))) add("empty-non-goals", ng.line, "## Non-goals is empty: list at least one thing a reader might assume is included and is not");
  const vague = vagueRegex([...VAGUE_WORDS, ...(opts.vagueWords || [])]);
  if (p.secs.has("User stories") && !p.stories.length) add("story", p.secs.get("User stories").line, "## User stories has no `### US-<n>: <story>` subsection");
  for (const s of p.stories) {
    if (!s.id) add("story", s.line, `story "${s.title}" has no id: use \`### US-<n>: <story>\``);
    if (!s.acs.length) add("story", s.line, `${s.id || s.title} has no acceptance criteria (\`- AC-<n>: <criterion>\`)`);
    for (const ac of s.acs) {
      if (!ac.id) add("criterion-id", ac.line, `acceptance criterion without an id: ${ac.text.slice(0, 80)}`);
      const v = vague.exec(ac.text);
      if (v) add("vague-word", ac.line, `${ac.id || "criterion"} cannot be measured: "${v[0]}" (name the observable value instead)`);
    }
  }
  const seen = new Map();
  for (const r of p.reqs) {
    if (!r.id) { add("requirement-id", r.line, `requirement without an id in ## ${r.section}: ${r.text.slice(0, 80)} (want \`- ${r.prefix}-<n>: ...\`)`); continue; }
    if (!r.id.startsWith(`${r.prefix}-`)) add("requirement-id", r.line, `${r.id} is in ## ${r.section} (want the ${r.prefix}- prefix)`);
    const v = vague.exec(r.text);
    if (v) add("vague-word", r.line, `${r.id} cannot be measured: "${v[0]}" (name the observable value or limit instead)`);
    if (seen.has(r.id)) add("requirement-id", r.line, `${r.id} is used twice (first at line ${seen.get(r.id)})`);
    else seen.set(r.id, r.line);
  }
  for (const it of p.items(p.secs.get("Success metrics")?.lines || [])) {
    if (!/^M-\d+:/.test(it.text)) add("metric-id", it.n, `metric without an id: ${it.text.slice(0, 80)} (want \`- M-<n>: ...\`)`);
    const field = (k) => new RegExp(`(?:^|;)\\s*${k}:\\s*([^;]*\\S)`, "i").exec(it.text.replace(/^M-\d+:/, ";"))?.[1];
    const missing = ["event", "source", "baseline"].filter((k) => !field(k));
    if (missing.length) add("metric-method", it.n, `metric does not say how it is measured: missing ${missing.join(", ")} (want \`event: <event>; source: <where>; baseline: <value>\`)`);
    const base = field("baseline");
    if (base && unknownIn(`baseline: ${base}`) && !REF.test(base)) add("unknown-as-fact", it.n, "baseline is unknown: link the assumption or open question that covers it (A-<n> or Q-<n>)");
  }
  for (const it of p.items(p.secs.get("Assumptions")?.lines || [])) {
    if (NONE.test(it.text)) continue;
    if (!/\[assumption:/i.test(it.text)) add("assumption-marker", it.n, "assumption without `[assumption: value|usability|viability|feasibility]`");
  }
  const oq = p.secs.get("Open questions");
  if (oq) for (const n of ["Blocking", "Non-blocking"]) if (!oq.subs.has(n)) add("open-questions", oq.line, `## Open questions has no "### ${n}" list (write \`- none\` when empty)`);
  for (const d of p.deferred) {
    if (!d.id) add("deferred", d.line, "deferred item must start with a requirement id: `- FR-<n>: <reason>`");
    else if (!d.reason) add("deferred", d.line, `${d.id} is deferred without a reason`);
    else if (!seen.has(d.id)) add("deferred", d.line, `${d.id} is deferred but is no requirement of this PRD`);
  }
  // An unknown is never written into the body as fact: it lives in Assumptions or Open questions, or links one.
  for (const [name, s] of p.secs) {
    if (["Assumptions", "Open questions", "Success metrics", "Deferred"].includes(name)) continue;
    for (const r of s.lines) if (unknownIn(r.text) && !REF.test(r.text)) add("unknown-as-fact", r.n, `unknown in ## ${name}: move it to ## Assumptions or ## Open questions, or link one (A-<n>, Q-<n>)`);
  }
  const ph = placeholders(text);
  if (ph.length) add("placeholder", 1, `unfilled template placeholder remains: ${ph.slice(0, 3).join(", ")}`);
  const claims = validateClaims(text, { sections: ["Problem", "Assumptions"], root: opts.root });
  for (const e of claims.errors) add("claim", e.line, e.message);
  for (const u of claims.unmarked) warnings.push({ rule: "unmarked-claim", line: u.line, message: `claim carries no fact, assumption or decision marker: ${u.text}` });
  findings.sort((a, b) => a.line - b.line);
  return {
    clean: findings.length === 0, findings, warnings,
    prd: { title: p.title, requirements: p.reqs.filter((r) => r.id).map((r) => r.id), stories: p.stories.length, blocking_questions: p.blocking.length, deferred: p.deferred.filter((d) => d.id).map((d) => d.id) },
  };
}

// verdict line of REVIEW.md: `verdict: ship|ship-with-conditions|do-not-ship`
export function reviewVerdict(text) {
  const m = /^verdict:\s*(\S+)\s*$/im.exec(text || "");
  return m ? m[1].toLowerCase() : null;
}

// The effective `decision: build|clarify|stop` line of a DECISION.md (the last such line wins), or null.
export function effectiveDecision(text) {
  const all = [...(text || "").replace(/<!--[\s\S]*?-->/g, "").matchAll(/^decision:[ \t]*(\S*)[ \t]*$/gim)];
  return all.length ? all[all.length - 1][1].toLowerCase() : null;
}

// A PRD may be split into tasks only when the check is clean, the review is not do-not-ship and no question blocks.
export function readiness(prdFile, opts = {}) {
  const text = readFileSync(prdFile, "utf8");
  const check = checkPrd(text, opts);
  const reasons = [];
  if (!check.clean) reasons.push(`PRD check has ${check.findings.length} finding(s): run check-prd.mjs ${prdFile}`);
  const reviewFile = join(dirname(prdFile), "REVIEW.md");
  const verdict = existsSync(reviewFile) ? reviewVerdict(readFileSync(reviewFile, "utf8")) : null;
  if (!existsSync(reviewFile)) reasons.push(`no review: ${reviewFile} is missing (the spec review writes it)`);
  else if (!verdict) reasons.push(`${reviewFile} has no \`verdict: ${VERDICTS.join("|")}\` line`);
  else if (!VERDICTS.includes(verdict)) reasons.push(`unknown review verdict "${verdict}" (want ${VERDICTS.join("|")})`);
  else if (verdict === "do-not-ship") reasons.push("review verdict is do-not-ship");
  const decisionFile = join(dirname(prdFile), "DECISION.md");
  if (existsSync(decisionFile)) {
    const d = readFileSync(decisionFile, "utf8");
    if (effectiveDecision(d) === "stop") {
      const why = /^## Decision\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(d)?.[1].split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^decision:/i.test(l));
      reasons.push(`${decisionFile} says decision: stop${why ? ` (${why.slice(0, 160)})` : ""}`);
    }
  }
  for (const q of parsePrd(text).blocking) reasons.push(`blocking open question (line ${q.n}): ${q.text.slice(0, 120)}`);
  return { ready: reasons.length === 0, verdict, reasons, findings: check.findings };
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = resolve(opt("--root") || ".");
  const arg = opt("--ready") || argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root");
  if (!arg) { console.error("usage: check-prd.mjs [--ready] <PRD.md|slug> [--json] [--root DIR]"); return 2; }
  const file = resolvePrd(arg, root);
  if (!existsSync(file)) { console.error(`cannot read ${file}`); return 2; }
  const vagueWords = (configValue(root, "product", "vague_words") || "").split(",").map((w) => w.trim()).filter(Boolean);
  const json = argv.includes("--json");
  if (argv.includes("--ready")) {
    const r = readiness(file, { vagueWords, root });
    if (json) console.log(JSON.stringify(r, null, 2));
    else console.log(r.ready ? `READY: ${file} may be split into tasks${r.verdict === "ship-with-conditions" ? " (review: ship-with-conditions; carry the conditions into the tasks)" : ""}` : `NOT READY: ${file}\n${r.reasons.map((x) => `- ${x}`).join("\n")}`);
    return r.ready ? 0 : 1;
  }
  const r = checkPrd(readFileSync(file, "utf8"), { vagueWords, root });
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const f of r.findings) console.error(`finding: ${file}:${f.line}: [${f.rule}] ${f.message}`);
    for (const w of r.warnings) console.error(`warning: ${file}:${w.line}: [${w.rule}] ${w.message}`);
    if (r.clean) console.log(`clean: ${file}`);
  }
  return r.clean ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
