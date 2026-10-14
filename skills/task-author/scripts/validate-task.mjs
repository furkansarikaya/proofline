#!/usr/bin/env node
// Validates a canonical proofline TASK.md and handles per-target templates (D17, D25).
// No dependencies. Exit codes: 0 valid, 1 invalid, 2 usage or read error.
//   node validate-task.mjs TASK.md [--json]
//   node validate-task.mjs --resolve-template <target> [--root DIR]
//   node validate-task.mjs --import ISSUE.md --template T.md       (JSON: fields, custom, missing)
//   node validate-task.mjs --check-export ISSUE.md --template T.md (every template section filled)

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLASSES = ["TRIVIAL", "STANDARD", "COMPLEX", "CRITICAL"];
export const REQUIRED = ["Goal", "Context", "Acceptance criteria", "Out of scope", "Constraints", "Risks", "Suggested class", "Verification commands"];

const BASES = "return display show reject respond redirect create delete update persist emit log send render print exit fail block allow deny store contain list output save remove raise throw appear hide disable enable equal produce report retain preserve increment decrement expire retry complete start stop become accept open close load validate match include exclude change remain stay keep receive charge refund notify call hold get set reset reload refresh rename move copy sort filter lock unlock grant revoke mask hash skip ignore exceed reach cap limit trigger run execute pass publish import export resume pause cancel expose hide".split(" ");
export const OBSERVABLE = new RegExp(`\\b(${BASES.join("|")})(s|es|ed|d|ing)?\\b`, "i");
export const VAGUE = /\b(properly|correctly|appropriately|appropriate|nice(ly)?|good|great|better|sensible|reasonable|smooth(ly)?|as expected|user[- ]friendly|intuitive|robust|seamless(ly)?|fast|quickly|efficient(ly)?|etc\.?|and so on|works? well|should work)\b/i;
const IMPL = /\b(implemented (with|via|using)|refactor|add(s|ed)? an? (class|function|method|column|index|table|interface)|use(s|d)? (the )?\w+ (library|framework|pattern))\b/i;
const PLACEHOLDER = /(<[A-Za-z][A-Za-z -]*>|\bTBD\b|\bTODO\b|\?\?\?|\bQUESTION-\d+\b)/;

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, "");

export function sections(text) {
  const out = new Map();
  let cur = null;
  for (const line of stripComments(text).split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; if (!out.has(cur)) out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

export function parseTask(text) {
  const secs = sections(text);
  const h1 = /^# Task: (\S+) (?:—|--|-) (.+?)\s*$/m.exec(stripComments(text));
  const acs = [];
  for (const line of (secs.get("Acceptance criteria") || [])) {
    const m = /^(?:[-*]\s+)?AC-(\d+):\s*(.*)$/.exec(line);
    if (m) acs.push({ n: Number(m[1]), text: m[2].trim() });
    else if (acs.length && /^\s+\S/.test(line)) acs[acs.length - 1].text += " " + line.trim();
  }
  const first = (secs.get("Suggested class") || []).map((l) => l.trim()).find(Boolean) || "";
  const cls = /^(TRIVIAL|STANDARD|COMPLEX|CRITICAL)\b\s*(?:[—–:-]+\s*(\S.*))?$/.exec(first);
  return { id: h1?.[1], title: h1?.[2], acs, cls: cls?.[1], indicator: cls?.[2], secs };
}

// A105: in a COMPLEX or CRITICAL task a defect the work runs into is declared, not folded into the task. The
// request (title, Goal, the user's `>` quotes, the Suggested class line) decides whether the task itself is a
// defect fix; the control plane applies the same rule at freeze (agent.sh task_defect_errors).
const REQUEST_DEFECT = /\b(bugs?|defects?|regression|broken|fix|fixes|fixed|wrong|incorrect|crash(es)?|disappears?|disappeared|unreachable)\b|hata|bozuk|kaybol|yanlış|düzelt/i;
const MENTION = /\b(defects?|bugs?|regression|fix|fixes|fixing)\b|kusur|düzelt/i;
const SCANNED = ["Context", "Acceptance criteria", "Constraints", "Risks"];
const isDefectHeading = (l) => /^#{2,3}\s+Pre-existing defects\s*$/i.test(l);

export function defectEntries(text) {
  const out = [];
  let i = false;
  for (const l of stripComments(text).split(/\r?\n/)) {
    if (/^#{1,3}\s/.test(l)) { i = isDefectHeading(l); continue; }
    if (i && /^\s*[-*]\s+\S/.test(l)) out.push(l.trim());
  }
  return out;
}

export function defectErrors(text) {
  const src = stripComments(text);
  const errors = [];
  const entries = defectEntries(src);
  for (const e of entries) if (!/decision:\s*(report|fix)\b/i.test(e)) errors.push(`"## Pre-existing defects" entry without \`decision: report\` or \`decision: fix\`: ${e}`);
  const lines = src.split(/\r?\n/);
  let sec = "", sub = false;
  const request = [], mentions = [];
  for (const l of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(l);
    if (h2) { sec = h2[1]; sub = isDefectHeading(l); continue; }
    if (/^###\s/.test(l)) { sub = isDefectHeading(l); continue; }
    if (/^\s*>/.test(l) || /^# Task:/.test(l) || sec === "Goal" || sec === "Suggested class") { request.push(l); continue; }
    if (!sub && SCANNED.includes(sec) && MENTION.test(l)) mentions.push(l.trim());
  }
  const big = /^(COMPLEX|CRITICAL)\b/.test((sections(src).get("Suggested class") || []).map((l) => l.trim()).find(Boolean) || "");
  if (big && !REQUEST_DEFECT.test(request.join("\n")) && mentions.length && !entries.length) {
    errors.push(`the task mentions a defect or a fix the request does not ask for (${mentions[0].slice(0, 120)}): list it under "## Pre-existing defects" as \`- <path:symbol>: <what> -- decision: report\` (left unchanged, named in the completion report); \`decision: fix\` only when the user asked in their own words, and the freeze then needs the user's \`scope\` approval`);
  }
  return errors;
}

export function validate(text) {
  const errors = [], warnings = [];
  const t = parseTask(text);
  if (!t.id) errors.push("H1 must be `# Task: <ID> — <title>`");
  for (const name of REQUIRED) {
    const body = t.secs.get(name);
    if (!body) errors.push(`missing section "## ${name}"`);
    else if (!body.some((l) => l.trim())) errors.push(`section "## ${name}" is empty`);
  }
  if (t.acs.length === 0 && (t.secs.get("Acceptance criteria") || []).some((l) => l.trim())) errors.push("no acceptance criteria in the form `AC-<n>: <text>`");
  t.acs.forEach((ac, i) => {
    if (ac.n !== i + 1) errors.push(`AC numbering must be sequential from AC-1 (found AC-${ac.n} at position ${i + 1})`);
    if (!ac.text) errors.push(`AC-${ac.n} is empty`);
    else {
      if (!OBSERVABLE.test(ac.text)) errors.push(`AC-${ac.n} names no observable behaviour (no verb such as returns, shows, rejects, persists)`);
      const v = VAGUE.exec(ac.text);
      if (v) errors.push(`AC-${ac.n} is not testable: vague term "${v[0]}"`);
      if (IMPL.test(ac.text)) warnings.push(`AC-${ac.n} may dictate implementation; keep only if the user stated it as a constraint`);
    }
  });
  if (t.secs.has("Suggested class")) {
    if (!t.cls) errors.push("Suggested class must start with one of " + CLASSES.join("|"));
    else if (!t.indicator) errors.push("Suggested class must name the indicator that placed it: `<CLASS> — <indicator>`");
  }
  if (PLACEHOLDER.test(stripComments(text).replace(/^# Task:.*$/m, ""))) errors.push("unfilled placeholder (<...>, TBD, TODO or ???) remains");
  errors.push(...defectErrors(text));
  if (defectEntries(text).some((e) => /decision:\s*fix\b/i.test(e))) warnings.push("a pre-existing defect with `decision: fix` needs the user's own `scope` approval at freeze; an answer such as \"use your recommended option\" is not one");
  return { valid: errors.length === 0, errors, warnings, task: { id: t.id, title: t.title, acs: t.acs.length, class: t.cls } };
}

// ---- templates (D25) ----
const FIELDS = ["title", "goal", "context", "acceptance_criteria", "out_of_scope", "constraints", "risks", "suggested_class", "verification_commands", "labels", "components"];
const ALWAYS_REQUIRED = ["goal", "acceptance_criteria", "out_of_scope", "constraints", "risks"];

export function parseTemplate(text) {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const required = [];
  let body = text;
  if (fm) {
    body = text.slice(fm[0].length);
    for (const l of fm[1].split("\n")) {
      const m = /^required:\s*(.*)$/.exec(l);
      if (m) required.push(...m[1].split(/[\s,]+/).filter(Boolean));
    }
  }
  const out = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = { heading: h[1], field: null }; out.push(cur); continue; }
    const p = /\{\{(\w+)\}\}/.exec(line);
    if (p && cur && !cur.field) cur.field = p[1];
  }
  const unknown = out.filter((s) => s.field && !FIELDS.includes(s.field) && !s.field.startsWith("x_")).map((s) => s.field);
  return { sections: out.filter((s) => s.field), required, unknown };
}

const norm = (s) => s.toLowerCase().replace(/^h[1-6]\.\s*/, "").replace(/[#*_:`]/g, "").replace(/\s+/g, " ").trim();

// Splits external text into heading -> body, tolerating `#`, `h2.` and `*bold*` headings.
function splitExternal(text) {
  const map = new Map();
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^(?:#{1,6}\s+(.+)|h[1-6]\.\s*(.+)|\*\*?([^*]+)\*\*?:?)$/.exec(line.trim());
    if (h) { cur = norm(h[1] || h[2] || h[3]); if (!map.has(cur)) map.set(cur, []); continue; }
    if (cur) map.get(cur).push(line);
  }
  return map;
}

export function importIssue(text, template) {
  const ext = splitExternal(text);
  const fields = {}, custom = {}, missing = [];
  for (const s of template.sections) {
    const body = (ext.get(norm(s.heading)) || []).join("\n").trim();
    const isCustom = s.field.startsWith("x_");
    const req = template.required.includes(s.field) || ALWAYS_REQUIRED.includes(s.field);
    if (body) (isCustom ? custom : fields)[s.field] = body;
    else if (req) missing.push(s.field);
  }
  return { fields, custom, missing };
}

export function checkExport(text, template) {
  const ext = splitExternal(text);
  return template.sections.filter((s) => !(ext.get(norm(s.heading)) || []).join("").trim()).map((s) => `section "${s.heading}" is missing or empty`);
}

export function resolveTemplate(target, root) {
  const user = join(root, ".agents", "templates", "tasks", `${target}.md`);
  if (existsSync(user)) return user;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "templates", `${target}.md`);
}

function main(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  if (argv.includes("--resolve-template")) {
    const p = resolveTemplate(opt("--resolve-template"), resolve(opt("--root") || "."));
    if (!existsSync(p)) { console.error("no template for target"); return 2; }
    console.log(p); return 0;
  }
  if (argv.includes("--import") || argv.includes("--check-export")) {
    if (!opt("--template")) { console.error("--template required"); return 2; }
    const tpl = parseTemplate(read(opt("--template")));
    if (argv.includes("--import")) {
      const r = importIssue(read(opt("--import")), tpl);
      console.log(JSON.stringify(r, null, 2));
      return r.missing.length ? 1 : 0;
    }
    const errs = checkExport(read(opt("--check-export")), tpl);
    errs.forEach((e) => console.error(e));
    return errs.length ? 1 : 0;
  }
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: validate-task.mjs TASK.md [--json]"); return 2; }
  const r = validate(read(file));
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else { r.errors.forEach((e) => console.error(`error: ${e}`)); r.warnings.forEach((w) => console.error(`warning: ${w}`)); }
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
