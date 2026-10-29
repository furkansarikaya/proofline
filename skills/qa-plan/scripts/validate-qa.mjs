#!/usr/bin/env node
// Validates QA_PLAN.md and QA_REPORT.md. No dependencies.
//   node validate-qa.mjs plan   QA_PLAN.md   [--task TASK.md] [--plan PLAN.md] [--entry-words REGEX]
//   node validate-qa.mjs report QA_REPORT.md [--plan QA_PLAN.md]
//   node validate-qa.mjs hash   QA_PLAN.md   (prints the sha256 the report must cite)
// Exit codes: 0 valid, 1 invalid, 2 usage or read error. --json prints the parsed result.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const CATEGORIES = ["boundaries", "invalid-input", "concurrency", "idempotency", "permissions", "persistence", "ui-states", "error-paths"];
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, "");
// A172: ids (QA-n, AC-n) compare by key: case-insensitive, leading zeros ignored. A plan or report keeps the spelling its author wrote.
export const idKey = (s) => String(s).toUpperCase().replace(/-0+(?=\d)/g, "-");
const PLACEHOLDER = /(<[A-Za-z][A-Za-z -]*>|\bTBD\b|\bTODO\b|\?\?\?)/;
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function sections(text) {
  const out = new Map();
  let cur = null;
  for (const line of strip(text).split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}

export function taskAcs(taskText) {
  return [...strip(taskText).matchAll(/^(?:[-*]\s+)?(AC-\d+):/gim)].map((m) => m[1]);
}

function scenarios(lines, errors, secName) {
  const list = [];
  for (const line of lines) {
    const head = /^- ([Qq][Aa]-\d+) \(([Aa][Cc]-\d+(?:,\s*[Aa][Cc]-\d+)*)\)(?: \[([a-z-]+)\])?: (.+)$/.exec(line);
    if (head) { list.push({ id: head[1], acs: head[2].split(/,\s*/), category: head[3], title: head[4], kv: {} }); continue; }
    const kv = /^\s+(input|expected|run|execution|reason|human-check): (.+)$/.exec(line);
    if (kv && list.length) { list[list.length - 1].kv[kv[1]] = kv[2].trim(); continue; }
    if (/^- /.test(line)) errors.push(`${secName}: malformed scenario line "${line.slice(0, 60)}" (expected "- QA-n (AC-k)[ [category]]: title")`);
  }
  return list;
}

// The PLAN.md the QA plan is derived from (A42): acceptance criteria are those of the scope and `## Behavior`.
export function planAcs(planText) {
  const t = strip(planText);
  const out = new Set();
  for (const m of t.matchAll(/^\s*criteria:\s*\[([^\]]*)\]/gm)) for (const a of m[1].match(/AC-\d+/gi) || []) out.add(idKey(a));
  const beh = sections(t).get("Behavior") || [];
  for (const l of beh) { const m = /^(?:[-*]\s+)?(AC-\d+):/i.exec(l); if (m) out.add(idKey(m[1])); }
  return [...out];
}
// Terms the plan's `## Contracts` section removes, renames or drops: a scenario must not expect them back.
const REMOVAL = /\b(remov|renam|drop|delet|no longer|deprecat)/i;
const NEGATION = /\b(absent|removed|no longer|not|never|without|omitted|missing|undefined|gone|must not|rejected|404|ignored)\b/i;
export function removedTerms(planText) {
  const out = new Set();
  for (const l of sections(planText).get("Contracts") || []) if (REMOVAL.test(l)) for (const m of l.matchAll(/`([A-Za-z_][\w.\-]*)`/g)) out.add(m[1]);
  return [...out];
}

// A162: every mandatory entry point of PLAN.md `## Contracts` (it takes external input) needs an adversarial
// `[invalid-input]` scenario naming it in its title, input, expected or run line (an `[invalid-input]` scenario is
// adversarial by definition: acceptance scenarios carry no category, so this validator reads it in the adversarial
// section; agent.sh accepts the tag in any section and leaves the structure to this validator).
// A162 input validation at entry points. Mirrors agent.sh entry_tier / plan_entries / plan_validation_missing (skills
// share no files, so the code and the default expressions are copied; a test compares them with the config). Each
// `## Contracts` bullet is MANDATORY when it declares an entry point (words), is not that entry point's own removal,
// is not unchanged or documented (skip) and marks new or changed input (an input word, or a new word with no output
// word): declares && !removed && !skip && (input || (new && !output)). Other bullets that mention an entry word are
// information only (entryMentions), never an error. A mandatory entry point is named by its first backticked token,
// else by the text before the first colon, and needs a `## Validation` bullet naming it with `accepts`, `limits`
// and `rejected at`. The expressions are the project's `validation.*` keys of .agents/config.yaml (read here when the
// file exists, flat key lookup; --entry-words overrides `entry_words`), else these defaults.
export const ENTRY_WORDS = "(GET|POST|PUT|PATCH|DELETE|HEAD) +/[^ ]*|endpoints?|webhooks?|(route|request|form|event|message|command) +handlers?|(queue|message|event|topic|job) +(consumers?|listeners?)|subscribes? +to|(grpc|rpc) +(methods?|services?|calls?)|graphql +(mutations?|quer(y|ies)|subscriptions?|resolvers?)|mutations?|cli +commands?|sub-?commands?|(new|adds?|added) +(cli +)?commands?|(cli|command-line|positional) +(arguments?|args?|flags?|options?)|argv|--[a-z][a-z0-9-]*|form +(fields?|submissions?)";
export const ENTRY = {
  words: ENTRY_WORDS,
  candidates: "endpoints?|routes?|handlers?|webhooks?|consumers?|subscribers?|forms?|cli +(arguments?|args?|flags?|options?|commands?)|command-line|argv|rpc|grpc|graphql|mutations?|(GET|POST|PUT|PATCH|DELETE|HEAD) +/[^ ]*|--[a-z][a-z0-9-]*|[A-Za-z0-9_-]*[.](graphqls?|gql|proto)",
  input: "accepts?|accepting|takes?|taking|parameters?|params?|quer(y|ies)|bod(y|ies)|payloads?|arguments?|args?|flags?|options?|headers?|inputs?|required|optional|expects?",
  new: "new|adds?|added|adding|introduc(es?|ed|ing)|creates?|created|registers?|registered|exposes?|exposed|fields?|gains?",
  output: "responses?|returns?|returning|returned|omits?|omitted|output|status +codes?|shape|results?",
  skip: "unchanged|documented|documents|no +change|not +changed|unmodified|as +before",
};
const ENTRY_KEYS = { entry_words: "words", entry_candidates: "candidates", entry_input: "input", entry_new: "new", entry_output: "output", entry_skip: "skip" };
const ENTRY_REMOVED = "^[ `*_]*(remove[sd]?|drop(s|ped)?|deprecate[sd]?|retire[sd]?)([^A-Za-z0-9_]|$)|(is|are|was|will be|has been|gets?) +(now +)?(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)|[(:`] *(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)|no +longer +(exists?|available|supported|served|routed)|/[^ ]*`? +(removed|dropped|deprecated|retired)([^A-Za-z0-9_]|$)";
const ENTRY_BL = "(^|[^A-Za-z0-9_.-])";
const ENTRY_BR = "($|[^A-Za-z0-9_.-]|[.]([^A-Za-z0-9_]|$))";
const entryHas = (words, t) => { if (!words) return false; try { return new RegExp(`${ENTRY_BL}(${words})${ENTRY_BR}`, "i").test(t); } catch { return false; } };
const entryRemoved = (t) => new RegExp(ENTRY_REMOVED, "i").test(t);
export function entryConfig(configDirs, wordsOverride) {
  const cfg = { ...ENTRY };
  for (const d of configDirs || []) {
    const f = join(d, ".agents", "config.yaml");
    if (!existsSync(f)) continue;
    let inV = false;
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (/^validation:\s*$/.test(l)) { inV = true; continue; }
      if (inV && /^\S/.test(l)) break;
      const m = inV ? /^  (\w+):\s*(.*)$/.exec(l) : null;
      if (!m || !ENTRY_KEYS[m[1]]) continue;
      let v = m[2].replace(/\s+#.*$/, "").trim();
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      cfg[ENTRY_KEYS[m[1]]] = v;
    }
    break;
  }
  if (wordsOverride) cfg.words = wordsOverride;
  return cfg;
}
// "mandatory", "information" or "" for one bullet body (the text after the list marker).
export function entryTier(body, c = ENTRY) {
  if (entryHas(c.words, body)) {
    if (entryRemoved(body)) return "";
    if (entryHas(c.skip, body)) return "information";
    return entryHas(c.input, body) || (entryHas(c.new, body) && !entryHas(c.output, body)) ? "mandatory" : "information";
  }
  return entryHas(c.candidates, body) && !entryRemoved(body) ? "information" : "";
}
function entryNames(contractLines, c, tier) {
  const out = [];
  for (const l of contractLines || []) {
    const m = /^\s*[-*]\s+(\S.*)$/.exec(l);
    if (!m || entryTier(m[1], c) !== tier) continue;
    const bt = /`([^`]*)`/.exec(m[1]);
    const name = (bt ? bt[1] : m[1].split(":")[0]).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}
export function entryPoints(planText, c = ENTRY) { return entryNames(sections(planText).get("Contracts"), typeof c === "string" ? { ...ENTRY, words: c } : c, "mandatory"); }

export function validatePlan(text, taskText, planText, entryWords) {
  const errors = [];
  const secs = sections(text);
  const id = /^# QA plan: (\S+)/m.exec(strip(text))?.[1];
  if (!id) errors.push("H1 must be `# QA plan: <TASK-ID>`");
  for (const n of ["Acceptance scenarios", "Adversarial scenarios", "Regression surface"]) {
    if (!secs.has(n)) errors.push(`missing section "## ${n}"`);
    else if (!secs.get(n).some((l) => l.trim())) errors.push(`section "## ${n}" is empty`);
  }
  const acc = scenarios(secs.get("Acceptance scenarios") || [], errors, "Acceptance scenarios");
  const advLines = secs.get("Adversarial scenarios") || [];
  const noneApplicable = advLines.some((l) => /^None applicable:\s*\S+/.test(l));
  const adv = scenarios(advLines, errors, "Adversarial scenarios");
  if (secs.has("Adversarial scenarios") && advLines.some((l) => l.trim()) && !adv.length && !noneApplicable) errors.push('Adversarial scenarios: list scenarios or write "None applicable: <reason>"');
  if (!acc.length && secs.has("Acceptance scenarios")) errors.push("no acceptance scenarios");
  const seen = new Set();
  for (const s of [...acc, ...adv]) {
    if (seen.has(idKey(s.id))) errors.push(`duplicate scenario id ${s.id}`);
    seen.add(idKey(s.id));
    for (const k of ["input", "expected", "run"]) if (!s.kv[k]) errors.push(`${s.id}: missing "${k}:" line`);
    if (!s.kv.execution) errors.push(`${s.id}: missing "execution: auto|manual" line`);
    else if (!["auto", "manual"].includes(s.kv.execution)) errors.push(`${s.id}: execution must be auto or manual, got "${s.kv.execution}"`);
    else if (s.kv.execution === "manual") for (const k of ["reason", "human-check"]) if (!s.kv[k]) errors.push(`${s.id}: manual scenario needs a "${k}:" line`);
  }
  for (const s of adv) if (!CATEGORIES.includes(s.category)) errors.push(`${s.id}: adversarial scenario needs a category from ${CATEGORIES.join("|")}`);
  for (const s of acc) if (s.category) errors.push(`${s.id}: acceptance scenarios carry no category`);
  if (PLACEHOLDER.test(strip(text).replace(/^# QA plan:.*$/m, ""))) errors.push("unfilled placeholder remains");
  if (taskText) {
    const acs = taskAcs(taskText);
    const covered = new Set(acc.flatMap((s) => s.acs.map(idKey)));
    const known = new Set(acs.map(idKey));
    for (const a of acs) if (!covered.has(idKey(a))) errors.push(`${a} has no acceptance scenario`);
    for (const s of [...acc, ...adv]) for (const a of s.acs) if (!known.has(idKey(a))) errors.push(`${s.id} references unknown ${a}`);
  }
  if (planText !== undefined) {
    const cited = /^Plan sha256: ([0-9a-f]{64})\s*$/m.exec(strip(text))?.[1];
    if (!cited) errors.push("missing `Plan sha256: <64 hex>` line (hash of the PLAN.md this QA plan is derived from; `validate-qa.mjs hash PLAN.md`)");
    else if (cited !== sha256(planText)) errors.push("Plan sha256 does not match PLAN.md: the QA plan was derived from a different plan; re-derive it from the current PLAN.md");
    const pacs = planAcs(planText);   // keys
    const qacs = new Set([...acc, ...adv].flatMap((s) => s.acs));
    for (const a of pacs) if (!acc.some((s) => s.acs.some((x) => idKey(x) === a))) errors.push(`${a} is in PLAN.md but has no acceptance scenario`);
    for (const a of qacs) if (pacs.length && !pacs.includes(idKey(a))) errors.push(`${a} is not a criterion of PLAN.md`);
    const text_of = (s) => [s.title, ...Object.values(s.kv)].join("\n");
    for (const n of entryPoints(planText, entryWords || ENTRY)) {
      if (!adv.some((s) => s.category === "invalid-input" && text_of(s).includes(n))) errors.push(`no invalid-input scenario for the entry point ${n} of PLAN.md ## Contracts: add an adversarial scenario "- QA-<n> (AC-<k>) [invalid-input]: ..." that names it, with an input the server must reject`);
    }
    const gone = removedTerms(planText);
    for (const s of [...acc, ...adv]) {
      const exp = s.kv.expected || "";
      for (const g of gone) if (exp.includes(g) && !NEGATION.test(exp)) errors.push(`${s.id}: expects \`${g}\`, which PLAN.md ## Contracts removes or renames (state that it is absent, or follow the new contract)`);
    }
  }
  return { valid: errors.length === 0, errors, id, acceptance: acc.map((s) => s.id), adversarial: adv.map((s) => s.id), manual: [...acc, ...adv].filter((s) => s.kv.execution === "manual").map((s) => s.id) };
}

// Gate rule (mechanical): any FAIL -> FAIL; else any BLOCKED -> BLOCKED; else PASS.
// "not-run (manual)" results (execution: manual scenarios) and PRE-EXISTING results (the scenario fails
// identically on the pre-change revision, so the change did not cause it) never affect the verdict.
export function computeVerdict(results) {
  if (results.some((r) => r === "FAIL")) return "FAIL";
  if (results.some((r) => r === "BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function validateReport(text, planText) {
  const errors = [];
  const body = strip(text);
  const secs = sections(text);
  if (!/^# QA report: \S+/m.test(body)) errors.push("H1 must be `# QA report: <TASK-ID>`");
  const verdicts = [...body.matchAll(/^Verdict: (\S+)\s*$/gm)].map((m) => m[1]);
  if (verdicts.length !== 1) errors.push("exactly one `Verdict: PASS|FAIL|BLOCKED` line is required");
  else if (!["PASS", "FAIL", "BLOCKED"].includes(verdicts[0])) errors.push(`invalid verdict "${verdicts[0]}"`);
  const cited = /^Plan sha256: ([0-9a-f]{64})\s*$/m.exec(body)?.[1];
  if (!cited) errors.push("missing `Plan sha256: <64 hex>` line (hash of the frozen QA_PLAN.md)");
  if (!secs.has("Scenarios")) errors.push('missing section "## Scenarios"');
  if (!secs.has("Failures")) errors.push('missing section "## Failures"');
  // A202: the one place for what a machine measures badly (text naturalness, visual impression): at most three short items or `None.`;
  // the completion report summary and the status block copy this list by script.
  const hc = secs.get("Human checks");
  if (hc) {
    const items = hc.filter((l) => /^[-*]\s+\S/.test(l));
    if (items.length === 0 && !hc.some((l) => /^none\.?\s*$/i.test(l.trim()))) errors.push('"## Human checks" lists "- <what the user should look at>" items (at most 3) or says None.');
    if (items.length > 3) errors.push(`"## Human checks" has ${items.length} items; at most 3`);
    for (const l of items) if (l.length > 160) errors.push(`"## Human checks" item is over 160 characters: "${l.slice(0, 40)}..."`);
  }
  const res = new Map();
  for (const line of secs.get("Scenarios") || []) {
    const m = /^- ([Qq][Aa]-\d+): (PASS|FAIL|BLOCKED|PRE-EXISTING|not-run \(manual\))(?:\s+(?:—|--|-)\s*(.*))?$/.exec(line);
    if (!m) { if (/^- /.test(line)) errors.push(`malformed result line "${line.slice(0, 60)}"`); continue; }
    if (res.has(idKey(m[1]))) errors.push(`duplicate result for ${m[1]}`);
    if (!m[3] || !m[3].trim()) errors.push(`${m[1]}: evidence (observed behaviour and command) is required after the dash`);
    if (m[2] === "PRE-EXISTING" && !/\b(base|baseline|pre-change)\b/i.test(m[3] || "")) errors.push(`${m[1]}: PRE-EXISTING needs the pre-change run as evidence (name the base revision and its observed failure)`);
    res.set(idKey(m[1]), m[2]);
  }
  if (res.size === 0) errors.push("no scenario results: \"## Scenarios\" must list at least one `- QA-n: PASS|FAIL|BLOCKED|PRE-EXISTING|not-run (manual) — evidence` line");
  const failures = (secs.get("Failures") || []).join("\n");
  const described = new Set((failures.match(/QA-\d+/gi) || []).map(idKey));   // exact ids by key: QA-1 is not described by QA-10
  for (const [id, r] of res) if ((r === "FAIL" || r === "BLOCKED") && !described.has(id)) errors.push(`${id} is ${r} but is not described in "## Failures"`);
  const computed = computeVerdict([...res.values()]);
  if (verdicts.length === 1 && res.size && verdicts[0] !== computed) errors.push(`verdict ${verdicts[0]} contradicts the gate rule (computed ${computed})`);
  if (planText !== undefined) {
    const plan = validatePlan(planText);
    const ids = [...plan.acceptance, ...plan.adversarial];
    if (cited && cited !== sha256(planText)) errors.push("Plan sha256 does not match the QA_PLAN.md on disk (plan changed after freeze or report cites another plan)");
    const idKeys = ids.map(idKey);
    for (const id of ids) if (!res.has(idKey(id))) errors.push(`no result for plan scenario ${id}`);
    for (const id of ids) {
      const manual = plan.manual.some((x) => idKey(x) === idKey(id)), r = res.get(idKey(id));
      if (manual && r && r !== "not-run (manual)") errors.push(`${id} is execution: manual and must be reported as "not-run (manual)", not ${r}`);
      if (!manual && r === "not-run (manual)") errors.push(`${id} is execution: auto; "not-run (manual)" is only for manual scenarios (use BLOCKED if it could not run)`);
    }
    for (const id of res.keys()) if (!idKeys.includes(id)) errors.push(`result for ${id}, which is not in the plan`);
  }
  if (PLACEHOLDER.test(body.replace(/^# QA report:.*$/m, ""))) errors.push("unfilled placeholder remains");
  return { valid: errors.length === 0, errors, verdict: verdicts[0], computed };
}

function main(argv) {
  const [mode, file] = argv;
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const read = (p) => { try { return readFileSync(p, "utf8"); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
  if (!["plan", "report", "hash"].includes(mode) || !file) { console.error("usage: validate-qa.mjs plan|report|hash FILE [--task F] [--plan F] [--entry-words REGEX] [--json]"); return 2; }
  if (mode === "hash") { console.log(sha256(read(file))); return 0; }
  const r = mode === "plan" ? validatePlan(read(file), opt("--task") ? read(opt("--task")) : undefined, opt("--plan") ? read(opt("--plan")) : undefined, entryConfig(opt("--plan") ? [resolve(dirname(opt("--plan")), "../../.."), process.cwd()] : [process.cwd()], opt("--entry-words"))) : validateReport(read(file), opt("--plan") ? read(opt("--plan")) : undefined);
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2)); else r.errors.forEach((e) => console.error(`error: ${e}`));
  return r.valid ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
