#!/usr/bin/env node
// Validates a ui-design ui.json (see ../schema/ui.schema.json) and/or a DESIGN.md.
// Usage: node validate-ui.mjs [<ui.json>] [--design-md <DESIGN.md>] [--root <repo>]
//          [--task <TASK.md>] [--class TRIVIAL|STANDARD|COMPLEX|CRITICAL] [--list-visual-proof]
// --task: acceptance criteria ids (criteria[].id must be one of them), the class ("## Suggested class") and the
// text a redesign quote must come from. --class overrides the task's class. COMPLEX/CRITICAL in mode task makes
// creative_direction, ux_patterns, self_critique and criteria mandatory (A81).
// --list-visual-proof: after a valid ui.json, prints {"schema":"ui-design.visual-proof/1","required":[AC ids]}.
// Exit: 0 valid, 1 invalid, 2 usage/read error. No dependencies.
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const PLACEHOLDER = /\b(lorem ipsum|tbd|todo|placeholder|xxx)\b/i;
const STATES = ["empty", "loading", "error", "success", "partial", "permission-denied"];
const KEYS = ["schema_version", "mode", "ui_languages", "design_system", "reused", "new", "screens", "flows"];
// A81: optional, validated when present; mandatory in mode task for these classes.
const OPTIONAL_KEYS = ["creative_direction", "ux_patterns", "self_critique", "criteria"];
export const CLASSES = ["TRIVIAL", "STANDARD", "COMPLEX", "CRITICAL"];
export const STRONG_CLASSES = ["COMPLEX", "CRITICAL"];
// The designer never gives final quality approval of its own design. Verdict and first-person phrasing only, so
// domain words ("approval button", "not approved items") are not claims. Heuristic: a word list, not understanding.
const SELF_APPROVAL = /\b((this|the|my|our) (design|spec|ui|layout|screen)s?( \w+)? (is|are|has been|have been) (approved|signed[- ]off|final|done and good)|signed[- ]off|sign[- ]off given|lgtm|ready to (ship|merge|release)|production[- ]ready|no (issues|problems|defects|flaws) remain|meets all (the )?(acceptance )?criteria|approved by (the )?designer|final (quality )?(verdict|approval)|quality (is )?(confirmed|guaranteed))\b|\bI (approve|sign off|certify)\b/i;
// A redesign approval must come from the user: never the designer, an assumption or an implication.
const NOT_USER = /\b(the designer|by designer|myself|self[- ]approved|assum\w*|implied|implicit)\b|\bI (approve|approved|decided|assume)\b/i;
// A recorded answer: a run answer file, a question number of the NEEDS_INPUT round, or an intent-grill decision anchor.
// A Q token is a question number only when it is not a quarter or sprint label of a meeting ("Q3 planning review").
const STRONG_REF = /(\bquestions\/\d{3}\.answer\.md\b|\bINTENT\.md#[\w-]+)/;
const Q_REF = /\bQ-?\d+\b(?!\s+(planning|review|meeting|sync|stand-?up|roadmap|kick-?off|retro\w*|offsite|okrs?|budget|sprint|workshop|demo|call)\b)/i;
// An approval that names a meeting or a review without a recorded answer is a rumour, not an answer.
const MEETING = /\b(meetings?|reviews?|planning|sync|stand-?up|workshop|retro\w*|kick-?off|calls?|discussions?|sessions?|committee|board|roadmap|offsite|demo)\b/i;
// A bare `Q<n>` is also a quarter label ("Q4 launch"): it counts only with round wording that makes it the
// NEEDS_INPUT question number ("Q2 of the NEEDS_INPUT round", "Q-2 answered by the user").
const ROUND_WORDING = /\b(needs_input|round|answer(?:s|ed)?)(?![A-Za-z])/i;
const ANSWER_REF = { test: (t) => STRONG_REF.test(t) || (Q_REF.test(t) && ROUND_WORDING.test(t) && !MEETING.test(t)) };
// The task's quote must ask for a visual change, not just mention the page. Heuristic.
const REDESIGN_INTENT = /\b(re-?design\w*|re-?styl\w*|re-?them\w*|new (look|visual\w*|style|theme|design)|visual (overhaul|refresh|redesign)|(rework|refresh|revamp|overhaul|change) (the |its )?(look|visuals?|visual (style|design)|style|theme|design))\b/i;
const norm = (t) => String(t).replace(/\s+/g, " ").trim().toLowerCase();

// TASK.md: "## Acceptance criteria" lines "AC-<n>: ...", "## Suggested class". Copied from plan-contract's
// parseTask (skills are standalone).
export function parseTask(md) {
  const secs = new Map();
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = /^## (.+?)\s*$/.exec(line);
    if (h) { cur = h[1]; secs.set(cur, []); continue; }
    if (cur) secs.get(cur).push(line);
  }
  const criteria = [];
  for (const l of secs.get("Acceptance criteria") || []) {
    const m = /^\s*(?:[-*]|\d+\.)?\s*(AC-\d+):\s*\S/.exec(l);
    if (m) criteria.push(m[1]);
  }
  const cls = ((secs.get("Suggested class") || []).join(" ").match(/\b(TRIVIAL|STANDARD|COMPLEX|CRITICAL)\b/) || [])[1] || null;
  return { criteria, cls, text: md };
}

// The machine-readable list consumed by visual-proof and verify-proof (with the PLAN "## UI" visual_proof line).
export function visualProofList(doc) {
  return (isObj(doc) && Array.isArray(doc.criteria) ? doc.criteria : [])
    .filter((c) => isObj(c) && c.visual_proof === "required" && isStr(c.id)).map((c) => c.id);
}

export function validate(doc, { root = null, cls = null, task = null } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  for (const k of KEYS) if (!(k in doc)) err("$", `missing required "${k}"`);
  for (const k of Object.keys(doc)) {
    if (/approv|sign.?off|verdict/i.test(k)) err(`$.${k}`, "the designer never gives final quality approval of its own design; quality is judged by QA's visual focus and the reviewers");
    else if (!KEYS.includes(k) && !OPTIONAL_KEYS.includes(k)) err("$", `unexpected "${k}"`);
  }
  const klass = cls || task?.cls || null;
  if (klass !== null && !CLASSES.includes(klass)) err("class", `"${klass}" is not one of ${CLASSES.join("|")}`);
  // A class implies a task: without TASK.md the criteria and the redesign quote cannot be checked.
  if (cls && !task && doc.mode === "task") err("class", "a class needs the task: pass --task <TASK.md> with --class");
  if (doc.mode === "task" && STRONG_CLASSES.includes(klass)) {
    for (const k of OPTIONAL_KEYS) if (!(k in doc)) err("$", `missing "${k}": required for a ${klass} task with UI`);
  }
  // Reverse mode only describes the existing system (DESIGN.md); task design content there skips the task checks.
  if (doc.mode === "reverse") {
    for (const k of OPTIONAL_KEYS) if (k in doc) err(`$.${k}`, "mode reverse describes the existing system; task design belongs in mode task");
    if (Array.isArray(doc.screens) && doc.screens.length > 0) err("$.screens", "mode reverse has no screens; task design belongs in mode task");
  }
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["task", "reverse"].includes(doc.mode)) err("$.mode", "must be task or reverse");
  if (!Array.isArray(doc.ui_languages) || doc.ui_languages.length === 0 || !doc.ui_languages.every(isStr)) err("$.ui_languages", "expected non-empty array (languages found in the repo's locale files)");
  const ds = doc.design_system;
  if (!isObj(ds) || !safeRel(ds.file) || typeof ds.exists !== "boolean") err("$.design_system", "expected {file: relative path, exists: boolean}");
  else if (root && ds.exists && !existsSync(resolve(root, ds.file))) err("$.design_system.file", `${ds.file} does not exist`);
  else if (root && !ds.exists && existsSync(resolve(root, ds.file))) err("$.design_system.exists", `${ds.file} exists: set exists true and conform to it`);

  const names = new Set();
  const chk = (p, path) => {
    if (!safeRel(path)) return err(p, "expected repo-relative path without ..");
    if (root && !existsSync(resolve(root, path))) err(p, `${path} does not exist`);
  };
  (Array.isArray(doc.reused) ? doc.reused : (err("$.reused", "expected array"), [])).forEach((r, i) => {
    const p = `$.reused[${i}]`;
    if (!isObj(r)) return err(p, "expected object");
    if (!["token", "component"].includes(r.kind)) err(`${p}.kind`, "must be token or component");
    if (!isStr(r.name)) err(`${p}.name`, "expected non-empty string"); else names.add(r.name);
    chk(`${p}.path`, r.path);
  });
  (Array.isArray(doc.new) ? doc.new : (err("$.new", "expected array"), [])).forEach((n, i) => {
    const p = `$.new[${i}]`;
    if (!isObj(n)) return err(p, "expected object");
    if (!["token", "component", "variant"].includes(n.kind)) err(`${p}.kind`, "must be token, component or variant");
    if (!isStr(n.name)) err(`${p}.name`, "expected non-empty string");
    else if (names.has(n.name)) err(`${p}.name`, `${n.name} duplicates a reused item`);
    if (!isStr(n.reason)) err(`${p}.reason`, "a new item needs a reason");
    if (!isStr(n.reuse_rejected)) err(`${p}.reuse_rejected`, "name the existing item considered and why it fails");
    if (n.kind === "variant") chk(`${p}.base`, n.base);
  });

  const screens = Array.isArray(doc.screens) ? doc.screens : (err("$.screens", "expected array"), []);
  if (doc.mode === "task" && screens.length === 0) err("$.screens", "mode task needs at least one screen");
  const sid = new Set();
  screens.forEach((s, i) => {
    const p = `$.screens[${i}]`;
    if (!isObj(s)) return err(p, "expected object");
    if (!/^S\d+$/.test(s.id ?? "")) err(`${p}.id`, "must match ^S\\d+$");
    else if (sid.has(s.id)) err(`${p}.id`, `duplicate id ${s.id}`);
    else sid.add(s.id);
    if (!isStr(s.name)) err(`${p}.name`, "expected non-empty string");
    if (!isObj(s.states)) err(`${p}.states`, "expected object");
    else {
      for (const st of STATES) {
        const v = s.states[st], q = `${p}.states.${st}`;
        if (!isObj(v)) { err(q, "state missing: specify it or mark not_applicable with a reason"); continue; }
        if ("not_applicable" in v) { if (!isStr(v.not_applicable)) err(q, "not_applicable needs a reason"); continue; }
        if (!isStr(v.copy)) err(`${q}.copy`, "state needs its copy");
        if (!isStr(v.behavior)) err(`${q}.behavior`, "state needs its behavior");
        if (PLACEHOLDER.test(`${v.copy} ${v.behavior}`)) err(q, "placeholder text in copy/behavior");
      }
      for (const k of Object.keys(s.states)) if (!STATES.includes(k)) err(`${p}.states`, `unknown state ${k}`);
    }
    for (const k of ["keyboard", "screen_reader", "responsive"]) {
      if (!Array.isArray(s[k]) || s[k].length === 0 || !s[k].every(isStr)) err(`${p}.${k}`, "expected non-empty array of non-empty strings");
    }
  });
  (Array.isArray(doc.flows) ? doc.flows : (err("$.flows", "expected array"), [])).forEach((f, i) => {
    const p = `$.flows[${i}]`;
    if (!isObj(f)) return err(p, "expected object");
    if (!Array.isArray(f.steps) || f.steps.length === 0) err(`${p}.steps`, "expected non-empty array");
    if (!Array.isArray(f.screens) || f.screens.length === 0) err(`${p}.screens`, "expected non-empty array");
    else for (const s of f.screens) if (!sid.has(s)) err(`${p}.screens`, `unknown screen ${s}`);
  });
  const designExists = isObj(ds) && ds.exists === true;
  if ("creative_direction" in doc) creativeDirection(doc.creative_direction, designExists, task, err);
  if ("ux_patterns" in doc) uxPatterns(doc.ux_patterns, err);
  if ("self_critique" in doc) selfCritique(doc.self_critique, err);
  if ("criteria" in doc) criteriaList(doc.criteria, sid, task, err);
  approvalClaims(doc, err);
  return errors;
}

const reqStr = (o, keys, p, err) => { for (const k of keys) if (!isStr(o[k])) err(`${p}.${k}`, "expected non-empty string"); };
const onlyKeys = (o, keys, p, err) => { for (const k of Object.keys(o)) if (!keys.includes(k)) err(p, `unexpected "${k}"`); };

const CD_KEYS = ["basis", "visual_character", "typography", "layout", "hierarchy", "rationale", "avoided", "alternatives", "chosen", "redesign"];
function creativeDirection(cd, designExists, task, err) {
  const p = "$.creative_direction";
  if (!isObj(cd)) return err(p, "expected object");
  onlyKeys(cd, CD_KEYS, p, err);
  reqStr(cd, ["visual_character", "typography", "layout", "hierarchy", "rationale"], p, err);
  if ("avoided" in cd && !(Array.isArray(cd.avoided) && cd.avoided.every(isStr))) err(`${p}.avoided`, "expected array of non-empty strings");
  if (!["conform", "redesign", "new"].includes(cd.basis)) return err(`${p}.basis`, "must be conform, redesign or new");
  if (cd.basis === "new" && designExists) err(`${p}.basis`, "DESIGN.md exists: conform to it, or redesign only when the task asks for it and the user approved");
  if (cd.basis === "new" && !(Array.isArray(cd.avoided) && cd.avoided.length > 0)) err(`${p}.avoided`, "a new direction lists the generic defaults it rejected and why");
  if (cd.basis === "conform") { if ("alternatives" in cd || "chosen" in cd) err(`${p}.alternatives`, "conform applies the existing system: no direction alternatives"); }
  else directionAlternatives(cd, p, err);
  if (cd.basis !== "redesign") { if ("redesign" in cd) err(`${p}.redesign`, "only with basis redesign"); return; }
  const r = cd.redesign, q = `${p}.redesign`;
  if (!isObj(r)) return err(q, "a redesign needs {task_quote, user_approval}: the task's request and the user's approval");
  onlyKeys(r, ["task_quote", "user_approval", "inventory"], q, err);
  // Redesign of UI code without DESIGN.md: the user's own request is the approval; the kept inventory and avoided patterns are required.
  const fromCode = !designExists;
  if ("inventory" in r || fromCode) {
    if (!(Array.isArray(r.inventory) && r.inventory.length > 0 && r.inventory.every(isStr))) err(`${q}.inventory`, "list the pages, content, components and flows kept from the existing code (non-empty strings)");
  }
  if (fromCode && !(Array.isArray(cd.avoided) && cd.avoided.length > 0)) err(`${p}.avoided`, "a redesign without DESIGN.md lists the generic patterns found in the existing code and why they go");
  if (!isStr(r.task_quote)) err(`${q}.task_quote`, "quote the task's own words asking for the redesign");
  else {
    if (task && !norm(task.text).includes(norm(r.task_quote))) err(`${q}.task_quote`, "not found in TASK.md: the task does not ask for this redesign");
    if (!REDESIGN_INTENT.test(r.task_quote)) err(`${q}.task_quote`, "does not ask for a visual change (redesign, restyle, re-theme, new look, visual overhaul, ...)");
  }
  if (fromCode && !("user_approval" in r)) return;
  if (!isStr(r.user_approval)) err(`${q}.user_approval`, "a redesign needs the user's approval (the answered question); ask with NEEDS_INPUT and conform meanwhile");
  else if (NOT_USER.test(r.user_approval)) err(`${q}.user_approval`, "the approval must come from the user, not from the designer or an assumption");
  else if (!ANSWER_REF.test(r.user_approval)) err(`${q}.user_approval`, "reference the recorded answer: questions/<NNN>.answer.md, Q<n> of the NEEDS_INPUT round (not a meeting or review), or INTENT.md#<decision>");
}

function directionAlternatives(cd, p, err) {
  const a = cd.alternatives;
  if (!Array.isArray(a) || a.length < 2 || a.length > 3) return err(`${p}.alternatives`, "a new or redesign direction presents 2-3 alternatives derived from the product's evidence");
  a.forEach((x, i) => {
    const q = `${p}.alternatives[${i}]`;
    if (!isObj(x)) return err(q, "expected object");
    onlyKeys(x, ["name", "summary", "trade_off"], q, err);
    reqStr(x, ["name", "summary", "trade_off"], q, err);
  });
  const names = a.map((x) => (isObj(x) ? x.name : undefined));
  if (new Set(names).size !== names.length) err(`${p}.alternatives`, "duplicate alternative name");
  if (!isStr(cd.chosen) || !names.includes(cd.chosen)) err(`${p}.chosen`, "must be the name of one alternative (the user's choice)");
}

function uxPatterns(list, err) {
  const p = "$.ux_patterns";
  if (!Array.isArray(list) || list.length === 0) return err(p, "expected non-empty array of decisions");
  list.forEach((d, i) => {
    const q = `${p}[${i}]`;
    if (!isObj(d)) return err(q, "expected object");
    onlyKeys(d, ["decision", "options", "chosen", "density", "flow", "rationale"], q, err);
    reqStr(d, ["decision", "chosen", "density", "flow", "rationale"], q, err);
    if (!Array.isArray(d.options) || d.options.length < 2 || !d.options.every(isStr)) err(`${q}.options`, "compare at least two real alternatives");
    else if (new Set(d.options).size !== d.options.length) err(`${q}.options`, "duplicate option");
    else if (isStr(d.chosen) && !d.options.includes(d.chosen)) err(`${q}.chosen`, "must be one of options");
  });
}

const CRITIQUE = ["hierarchy", "density", "consistency", "legibility"];
function selfCritique(sc, err) {
  const p = "$.self_critique";
  if (!isObj(sc)) return err(p, "expected object");
  onlyKeys(sc, [...CRITIQUE, "anti_patterns"], p, err);
  reqStr(sc, CRITIQUE, p, err);
  if (!Array.isArray(sc.anti_patterns) || sc.anti_patterns.length === 0) err(`${p}.anti_patterns`, "expected the anti-pattern checklist (references/SELF-CRITIQUE.md)");
  else sc.anti_patterns.forEach((a, i) => {
    const q = `${p}.anti_patterns[${i}]`;
    if (!isObj(a)) return err(q, "expected object");
    onlyKeys(a, ["check", "result", "note"], q, err);
    if (!isStr(a.check)) err(`${q}.check`, "expected non-empty string");
    if (!["clear", "fixed", "accepted"].includes(a.result)) err(`${q}.result`, "must be clear, fixed or accepted");
    if ("note" in a && typeof a.note !== "string") err(`${q}.note`, "expected string");
    else if (["fixed", "accepted"].includes(a.result) && !isStr(a.note)) err(`${q}.note`, `${a.result} needs a note (what changed, or why it stays and who decided)`);
  });
}

// Free-text fields where a designer could claim its own design is approved.
function approvalClaims(doc, err) {
  const texts = [];
  const add = (p, o, keys) => { if (isObj(o)) for (const k of keys) texts.push([`${p}.${k}`, o[k]]); };
  add("$.creative_direction", doc.creative_direction, ["visual_character", "typography", "layout", "hierarchy", "rationale"]);
  if (Array.isArray(doc.ux_patterns)) doc.ux_patterns.forEach((d, i) => add(`$.ux_patterns[${i}]`, d, ["density", "flow", "rationale"]));
  add("$.self_critique", doc.self_critique, CRITIQUE);
  if (isObj(doc.self_critique) && Array.isArray(doc.self_critique.anti_patterns)) doc.self_critique.anti_patterns.forEach((a, i) => add(`$.self_critique.anti_patterns[${i}]`, a, ["check", "note"]));
  if (Array.isArray(doc.criteria)) doc.criteria.forEach((c, i) => add(`$.criteria[${i}]`, c, ["evidence"]));
  for (const [q, t] of texts) if (typeof t === "string" && SELF_APPROVAL.test(t)) err(q, "self-approval claim: the designer never gives final quality approval of its own design; state what was checked and changed");
}

function criteriaList(list, sid, task, err) {
  const p = "$.criteria";
  if (!Array.isArray(list) || list.length === 0) return err(p, "expected non-empty array (one entry per UI-facing acceptance criterion)");
  const seen = new Set();
  list.forEach((c, i) => {
    const q = `${p}[${i}]`;
    if (!isObj(c)) return err(q, "expected object");
    onlyKeys(c, ["id", "screens", "visual_proof", "evidence"], q, err);
    if (!/^AC-\d+$/.test(c.id ?? "")) err(`${q}.id`, "must match ^AC-\\d+$");
    else if (seen.has(c.id)) err(`${q}.id`, `duplicate criterion ${c.id}`);
    else {
      seen.add(c.id);
      if (task && !task.criteria.includes(c.id)) err(`${q}.id`, `${c.id} is not an acceptance criterion of the task (known: ${task.criteria.join(", ") || "none"})`);
    }
    if (!Array.isArray(c.screens) || c.screens.length === 0) err(`${q}.screens`, "expected non-empty array of screen ids");
    else for (const s of c.screens) if (!sid.has(s)) err(`${q}.screens`, `unknown screen ${s}`);
    if (!["required", "not_required"].includes(c.visual_proof)) err(`${q}.visual_proof`, "must be required or not_required");
    if ("evidence" in c && typeof c.evidence !== "string") err(`${q}.evidence`, "expected string");
    else if (c.visual_proof === "required" && !isStr(c.evidence)) err(`${q}.evidence`, "visual_proof required: name the states, viewports and what the screenshot or measurement must show");
  });
}

const REQUIRED_HEADINGS = ["Tokens", "Typography", "Spacing", "Colour roles", "Components", "Accessibility"];
export function validateDesignMd(text, { root = null } = {}) {
  const errors = [];
  const sections = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (m) { cur = m[1]; sections.set(cur, []); } else if (cur) sections.get(cur).push(line);
  }
  for (const h of REQUIRED_HEADINGS) {
    const key = [...sections.keys()].find((k) => k.toLowerCase() === h.toLowerCase());
    if (!key) { errors.push(`DESIGN.md: missing section "${h}"`); continue; }
    const body = sections.get(key).filter((l) => l.trim() && !/^\|[-| ]+\|$/.test(l.trim()));
    if (body.length === 0) errors.push(`DESIGN.md: section "${h}" is empty`);
  }
  if (PLACEHOLDER.test(text)) errors.push("DESIGN.md: placeholder text found");
  if (root) {
    const seen = new Set();
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      if (m[1].includes("://")) continue;
      const pm = /^([\w.@-]+(?:\/[\w.@-]+)+\.\w+)(?::[\w.$-]+)?$/.exec(m[1]);
      if (!pm || seen.has(pm[1])) continue;
      seen.add(pm[1]);
      if (!safeRel(pm[1]) || !existsSync(resolve(root, pm[1]))) errors.push(`DESIGN.md: path ${pm[1]} does not exist`);
    }
  }
  return errors;
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
  const root = opt("--root"), dm = opt("--design-md"), taskPath = opt("--task"), cls = opt("--class"), list = flag("--list-visual-proof");
  if (args.length > 1 || (args.length === 0 && !dm) || (list && !args[0]) || (cls && !taskPath) || args.some((a) => a.startsWith("--"))) {
    if (cls && !taskPath) console.error("--class needs --task <TASK.md>: a class implies a task");
    console.error("usage: validate-ui.mjs [<ui.json>] [--design-md <DESIGN.md>] [--root <repo>] [--task <TASK.md>] [--class C] [--list-visual-proof]");
    process.exit(2);
  }
  const errors = [];
  let doc = null;
  try {
    const task = taskPath ? parseTask(readFileSync(taskPath, "utf8")) : null;
    if (args[0]) errors.push(...validate((doc = JSON.parse(readFileSync(args[0], "utf8"))), { root, cls, task }));
    if (dm) errors.push(...validateDesignMd(readFileSync(dm, "utf8"), { root }));
  } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(list ? JSON.stringify({ schema: "ui-design.visual-proof/1", required: visualProofList(doc) }) : "valid");
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
