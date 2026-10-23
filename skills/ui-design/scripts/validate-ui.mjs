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
import { deal, dealIds, loadLibrary, checkRedrawReason } from "./deal.mjs";

// 0.0.27 (A170): the pattern registry. visual-proof carries the detectors; a test checks both id sets agree.
export const REGISTRY_DATE = "2026-10-23";
export const PATTERN_IDS = ["cream-serif-terracotta", "dark-single-neon-glow", "hairline-newspaper", "uniform-saas-cards", "eyebrow-label", "mono-labels", "numbered-steps", "middot-meta", "gradient-text", "decorative-glass", "side-stripe-card", "hard-offset-shadow", "emoji-icons", "sketch-svg", "grid-background"];
export const VISITOR_MODES = ["persuade", "operate", "read", "experience"];
// Copy hygiene (V5): a UI string must not show a file path, a role id or an internal folder.
const INTERNAL_COPY = /(?:^|[\s("'])\.?agents\/|\broles\/[\w-]+\.md\b|\b(?:designer|implementer|reviewer|explorer|architect|qa|verifier)-\d+\b|\b[\w.-]+(?:\/[\w.-]+)+\.(?:md|json|mjs|cjs|js|jsx|ts|tsx|sh|ya?ml|toml|css|html)\b|\bdocs\/(?:product|design)\b/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const PLACEHOLDER = /\b(lorem ipsum|tbd|todo|placeholder|xxx)\b/i;
const STATES = ["empty", "loading", "error", "success", "partial", "permission-denied"];
const KEYS = ["schema_version", "mode", "ui_languages", "design_system", "reused", "new", "screens", "flows"];
// A81: optional, validated when present; mandatory in mode task for these classes.
const OPTIONAL_KEYS = ["creative_direction", "ux_patterns", "self_critique", "criteria"];
// 0.0.27: craft keys, validated whenever present; required by visitor mode and basis (V1-V5).
const CRAFT_KEYS = ["visitor_mode", "argument", "craft"];
// Optional `target` (default web): native mobile targets make keyboard optional per screen (hover/focus are web rules).
const TARGETS = ["web", "ios", "android", "flutter", "react-native"];
const NATIVE_TARGETS = ["ios", "android", "flutter", "react-native"];
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
    else if (!KEYS.includes(k) && !OPTIONAL_KEYS.includes(k) && !CRAFT_KEYS.includes(k) && k !== "target") err("$", `unexpected "${k}"`);
  }
  if ("target" in doc && !TARGETS.includes(doc.target)) err("$.target", `must be one of ${TARGETS.join("|")} (default web)`);
  const native = NATIVE_TARGETS.includes(doc.target);
  const klass = cls || task?.cls || null;
  if (klass !== null && !CLASSES.includes(klass)) err("class", `"${klass}" is not one of ${CLASSES.join("|")}`);
  // A class implies a task: without TASK.md the criteria and the redesign quote cannot be checked.
  if (cls && !task && doc.mode === "task") err("class", "a class needs the task: pass --task <TASK.md> with --class");
  if (doc.mode === "task" && STRONG_CLASSES.includes(klass)) {
    for (const k of OPTIONAL_KEYS) if (!(k in doc)) err("$", `missing "${k}": required for a ${klass} task with UI`);
  }
  // Reverse mode only describes the existing system (DESIGN.md); task design content there skips the task checks.
  if (doc.mode === "reverse") {
    for (const k of [...OPTIONAL_KEYS, ...CRAFT_KEYS]) if (k in doc) err(`$.${k}`, "mode reverse describes the existing system; task design belongs in mode task");
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
      if (native && k === "keyboard" && !(k in s)) continue; // web-only rule: optional on native mobile
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
  const modes = visitorModes(doc, screens, err);
  const dealMode = modes.has("persuade") || modes.has("experience");
  if ("creative_direction" in doc) {
    creativeDirection(doc.creative_direction, designExists, task, err, { dealMode, modes });
    visitorModeRequired(doc, err);
  }
  craftChecks(doc, screens, modes, root, err);
  if ("ux_patterns" in doc) uxPatterns(doc.ux_patterns, err);
  if ("self_critique" in doc) selfCritique(doc.self_critique, err);
  if ("criteria" in doc) criteriaList(doc.criteria, sid, task, err);
  approvalClaims(doc, err);
  return errors;
}

const reqStr = (o, keys, p, err) => { for (const k of keys) if (!isStr(o[k])) err(`${p}.${k}`, "expected non-empty string"); };
const onlyKeys = (o, keys, p, err) => { for (const k of Object.keys(o)) if (!keys.includes(k)) err(p, `unexpected "${k}"`); };

const CD_KEYS = ["basis", "visual_character", "typography", "layout", "hierarchy", "rationale", "avoided", "alternatives", "chosen", "redesign", "topic_inventory", "idea", "deal", "patterns_used"];
function creativeDirection(cd, designExists, task, err, { dealMode = false, modes = null } = {}) {
  const p = "$.creative_direction";
  if (!isObj(cd)) return err(p, "expected object");
  onlyKeys(cd, CD_KEYS, p, err);
  if ("patterns_used" in cd) patternsUsed(cd.patterns_used, `${p}.patterns_used`, err);
  reqStr(cd, ["visual_character", "typography", "layout", "hierarchy", "rationale"], p, err);
  if ("avoided" in cd && !(Array.isArray(cd.avoided) && cd.avoided.every(isStr))) err(`${p}.avoided`, "expected array of non-empty strings");
  if (!["conform", "redesign", "new"].includes(cd.basis)) return err(`${p}.basis`, "must be conform, redesign or new");
  if (cd.basis === "new" && designExists) err(`${p}.basis`, "DESIGN.md exists: conform to it, or redesign only when the task asks for it and the user approved");
  if (cd.basis === "new" && !(Array.isArray(cd.avoided) && cd.avoided.length > 0)) err(`${p}.avoided`, "a new direction lists the generic defaults it rejected and why");
  if (cd.basis === "conform") { if ("alternatives" in cd || "chosen" in cd) err(`${p}.alternatives`, "conform applies the existing system: no direction alternatives"); }
  else if (dealMode) dealtDirection(cd, p, err, modes);
  else { directionAlternatives(cd, p, err); if ("deal" in cd) dealRecord(cd.deal, `${p}.deal`, err, modes); }
  if (cd.basis !== "redesign") { if ("redesign" in cd) err(`${p}.redesign`, "only with basis redesign"); return; }
  const r = cd.redesign, q = `${p}.redesign`;
  if (!isObj(r)) return err(q, "a redesign needs {task_quote} (the task's request), plus user_approval (the user's approval) when DESIGN.md exists or inventory when it does not");
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

// V6: a pattern from the registry used on purpose carries a written reason. `avoided` stays free text and may name ids.
function patternsUsed(list, p, err) {
  if (!Array.isArray(list)) return err(p, "expected array of {id, reason}");
  const seen = new Set();
  list.forEach((x, i) => {
    const q = `${p}[${i}]`;
    if (!isObj(x)) return err(q, "expected {id, reason}");
    onlyKeys(x, ["id", "reason"], q, err);
    if (!PATTERN_IDS.includes(x.id)) err(`${q}.id`, `unknown pattern id "${x.id}" (registry ${REGISTRY_DATE}: ${PATTERN_IDS.join(", ")})`);
    else if (seen.has(x.id)) err(`${q}.id`, `duplicate ${x.id}`);
    else seen.add(x.id);
    if (!isStr(x.reason)) err(`${q}.reason`, "a pattern used needs a written reason");
  });
}

// The bundled library is loaded once, on first use (a deal replay needs it).
let LIB = null;
const library = () => (LIB ||= loadLibrary());

// V3: persuade/experience with basis new|redesign: topic inventory, idea with rival swap, and a deal drawn from the
// library by scripts/deal.mjs. The validator replays the deal from the recorded inputs, seed and redraws.
function dealtDirection(cd, p, err, modes) {
  const inv = cd.topic_inventory;
  if (!Array.isArray(inv) || inv.length < 8 || inv.length > 12 || !inv.every(isStr)) err(`${p}.topic_inventory`, "8-12 concrete things that belong to this product and not to its rival");
  else if (new Set(inv.map(norm)).size !== inv.length) err(`${p}.topic_inventory`, "duplicate item");
  const idea = cd.idea;
  if (!isObj(idea)) err(`${p}.idea`, "expected {sentence, rival, note, rival_swap}: 'On this page, <item> becomes <tool>.' plus the rival test");
  else {
    onlyKeys(idea, ["sentence", "rival", "rival_swap", "note"], `${p}.idea`, err);
    reqStr(idea, ["sentence", "rival", "note"], `${p}.idea`, err);
    if (isStr(idea.sentence) && !/\bbecomes?\b/i.test(idea.sentence)) err(`${p}.idea.sentence`, "must read 'On this page, <inventory item> becomes <tool>.'");
    if (isStr(idea.sentence) && /\bclean (and|&) modern\b/i.test(idea.sentence)) err(`${p}.idea.sentence`, "'clean and modern' is not an idea");
    if (idea.rival_swap !== "no_longer_true") err(`${p}.idea.rival_swap`, "run the rival test: with the nearest rival's name in the sentence the idea must be no_longer_true; otherwise the idea is rejected");
  }
  const replayed = dealRecord(cd.deal, `${p}.deal`, err, modes);
  const a = cd.alternatives;
  const want = replayed ? replayed.dealt.length + 1 : null;
  if (!Array.isArray(a) || (want !== null && a.length !== want) || a.length < 2 || a.length > 4) return err(`${p}.alternatives`, want ? `the ${want - 1} dealt directions plus the standard option (${want} entries)` : "the dealt directions plus the standard option");
  a.forEach((x, i) => {
    const q = `${p}.alternatives[${i}]`;
    if (!isObj(x)) return err(q, "expected object");
    if ("recommended" in x) err(`${q}.recommended`, "the designer never recommends the standard option (it is the user's door)");
    onlyKeys(x, ["name", "summary", "trade_off", "standard"], q, err);
    reqStr(x, ["name", "summary", "trade_off"], q, err);
    if ("standard" in x && typeof x.standard !== "boolean") err(`${q}.standard`, "expected boolean");
  });
  const aNames = a.map((x) => (isObj(x) ? x.name : undefined));
  if (new Set(aNames).size !== aNames.length) err(`${p}.alternatives`, "duplicate alternative name");
  const std = a.filter((x) => isObj(x) && x.standard === true);
  if (std.length !== 1) err(`${p}.alternatives`, "exactly one alternative is flagged standard: true");
  if (replayed) {
    const idOf = (ids) => ids.direction || ids.style;
    const dealtNames = replayed.dealt.map(idOf), stdName = `standard-${idOf(replayed.standard)}`;
    for (const n of dealtNames) if (!aNames.includes(n)) err(`${p}.alternatives`, `dealt direction "${n}" is missing: name each dealt alternative by its direction id`);
    if (std.length === 1 && std[0].name !== stdName) err(`${p}.alternatives`, `the standard alternative must be named "${stdName}"`);
    for (const x of a) if (isObj(x) && x.standard !== true && !dealtNames.includes(x.name)) err(`${p}.alternatives`, `"${x.name}" was not dealt`);
  }
  if (!isStr(cd.chosen) || !aNames.includes(cd.chosen)) err(`${p}.chosen`, "must be the name of one alternative (the user's choice)");
}

// Replays deal(inputs, seed, redraws) and compares the recorded ids; returns the ids when they match.
function dealRecord(d, p, err, modes) {
  if (!isObj(d)) { err(p, "expected {inputs, seed, dealt, standard, redraws?}: run scripts/deal.mjs --brief <brief.json> and record its inputs, seed, ids and redraws"); return null; }
  onlyKeys(d, ["inputs", "seed", "dealt", "standard", "redraws"], p, err);
  if (!isObj(d.inputs)) { err(`${p}.inputs`, "the brief deal.mjs was given (mode, sector, imagery, sections, ...)"); return null; }
  if (!Number.isInteger(d.seed) || d.seed < 0 || d.seed > 4294967295) { err(`${p}.seed`, "integer 0..4294967295 as printed by deal.mjs"); return null; }
  if (!Array.isArray(d.dealt) || d.dealt.length < 1 || d.dealt.length > 3 || !d.dealt.every(isObj)) { err(`${p}.dealt`, "the dealt ids (up to three objects, the `ids` field of each deal.mjs entry)"); return null; }
  if (!isObj(d.standard)) { err(`${p}.standard`, "the ids of the calm standard option"); return null; }
  const redraws = d.redraws === undefined ? [] : d.redraws;
  if (!Array.isArray(redraws) || !redraws.every((r) => isObj(r) && isStr(r.slot) && isStr(r.reason))) { err(`${p}.redraws`, "expected array of {slot, reason}"); return null; }
  let badReason = false;
  for (const [i, r] of redraws.entries()) { const why = checkRedrawReason(r.reason); if (why) { badReason = true; err(`${p}.redraws[${i}].reason`, why); } }
  if (badReason) return null;
  if (modes && isStr(d.inputs.mode) && !modes.has(d.inputs.mode)) err(`${p}.inputs.mode`, `the deal was run for mode ${d.inputs.mode}, which is not a visitor mode of this spec`);
  let lib;
  try { lib = library(); } catch (e) { err(p, `cannot replay the deal: bundled library not readable (${e.message})`); return null; }
  let again;
  try { again = deal(d.inputs, d.seed, redraws.map((r) => ({ slot: r.slot, reason: r.reason })), lib); } catch (e) { err(p, `deal replay failed: ${e.message}`); return null; }
  if (again.status !== "ok") { err(p, `no direction can satisfy this brief (${again.reason}); change the brief honestly, do not relax the deal`); return null; }
  const exp = dealIds(again);
  if (JSON.stringify(exp) !== JSON.stringify({ dealt: d.dealt, standard: d.standard })) { err(p, `does not match the deal of seed ${d.seed} for these inputs and redraws (expected dealt ${exp.dealt.map((x) => x.direction || x.style).join(", ")}): run scripts/deal.mjs, never choose by hand`); return null; }
  return exp;
}

const MODE_OF = new WeakMap();
// Effective visitor mode per screen: the screen's own, else the spec's. Validates the shapes.
function visitorModes(doc, screens, err) {
  const modes = new Set();
  const shape = (v, p) => {
    if (!isObj(v)) { err(p, "expected {mode, reason}"); return null; }
    onlyKeys(v, ["mode", "reason"], p, err);
    if (!VISITOR_MODES.includes(v.mode)) err(`${p}.mode`, `must be one of ${VISITOR_MODES.join("|")}`);
    if (!isStr(v.reason)) err(`${p}.reason`, "say why this surface has this mode (chosen by the surface, not the product)");
    return VISITOR_MODES.includes(v.mode) ? v.mode : null;
  };
  const top = "visitor_mode" in doc ? shape(doc.visitor_mode, "$.visitor_mode") : null;
  screens.forEach((s, i) => {
    if (!isObj(s)) return;
    const own = "visitor_mode" in s ? shape(s.visitor_mode, `$.screens[${i}].visitor_mode`) : null;
    MODE_OF.set(s, own || top);
    if (MODE_OF.get(s)) modes.add(MODE_OF.get(s));
  });
  if (top && screens.length === 0) modes.add(top);
  return modes;
}

// V1.
function visitorModeRequired(doc, err) {
  const b = doc.creative_direction?.basis;
  if ((b === "new" || b === "redesign") && !("visitor_mode" in doc)) err("$.visitor_mode", `basis ${b} needs a visitor_mode {mode: persuade|operate|read|experience, reason} chosen by the surface`);
}

function craftChecks(doc, screens, modes, root, err) {
  // V2: argument for every persuade screen.
  const persuade = screens.filter((s) => isObj(s) && MODE_OF.get(s) === "persuade");
  if ("argument" in doc || persuade.length) argument(doc.argument, persuade, screens, root, err);
  // V5: copy hygiene everywhere; first screen of persuade/experience screens.
  screens.forEach((s, i) => {
    if (!isObj(s)) return;
    const p = `$.screens[${i}]`;
    if (isObj(s.states)) for (const [k, v] of Object.entries(s.states)) {
      if (isObj(v) && typeof v.copy === "string" && INTERNAL_COPY.test(v.copy)) err(`${p}.states.${k}.copy`, "copy shows a file path or an internal id; a visitor wants a small link or disclosure, not system names");
    }
    const lead = MODE_OF.get(s) === "persuade" || MODE_OF.get(s) === "experience";
    if ("first_screen" in s || lead) firstScreen(s.first_screen, `${p}.first_screen`, lead, err);
  });
  // V4: persuade needs the craft block.
  if ("craft" in doc || modes.has("persuade")) craft(doc.craft, modes.has("persuade"), root, err);
  // Library images never stand in for the project's own: a brief that claims project photos needs project images listed.
  const claimed = doc.creative_direction?.deal?.inputs?.imagery;
  const listed = doc.craft?.visual_plan?.images;
  if (Array.isArray(claimed) && Array.isArray(listed) && claimed.some((x) => x === "project-photos" || x === "product-photo")) {
    const own = listed.filter((im) => typeof im === "string" || (isObj(im) && im.source === "project"));
    if (own.length === 0) err("$.craft.visual_plan.images", "the deal brief claims project photos but no image is listed with source project (library images are never counted as the project's imagery)");
  }
}

function argument(arg, persuade, screens, root, err) {
  const p = "$.argument";
  if (arg === undefined) { err(p, "a persuade spec needs an argument: every persuade screen has at least one {screen, section, claim, proof} row"); return; }
  if (!Array.isArray(arg) || arg.length === 0) return err(p, "expected non-empty array of {screen, section, claim, proof}");
  const ids = new Set(screens.map((s) => s?.id));
  const covered = new Set();
  arg.forEach((r, i) => {
    const q = `${p}[${i}]`;
    if (!isObj(r)) return err(q, "expected object");
    onlyKeys(r, ["screen", "section", "claim", "proof"], q, err);
    reqStr(r, ["screen", "section", "claim"], q, err);
    if (isStr(r.screen)) { if (!ids.has(r.screen)) err(`${q}.screen`, `unknown screen ${r.screen}`); else covered.add(r.screen); }
    proof(r.proof, `${q}.proof`, root, err);
  });
  for (const s of persuade) if (!covered.has(s.id)) err(p, `persuade screen ${s.id} has no argument row: no section without a claim`);
}

// A claim is tied to a product fact (file under docs/product with the cited id or anchor in it) or to code (path exists).
function proof(x, p, root, err) {
  if (!isObj(x)) return err(p, "expected {kind: product-fact|code, ...}: an unlinkable claim cannot enter the page");
  if (x.kind === "product-fact") {
    onlyKeys(x, ["kind", "file", "ref"], p, err);
    if (!safeRel(x.file) || !/^docs\/product\//.test(x.file)) return err(`${p}.file`, "a product fact lives in a file under docs/product/");
    if (!isStr(x.ref)) return err(`${p}.ref`, "cite the id or anchor inside the file");
    if (!root) return;
    const f = resolve(root, x.file);
    if (!existsSync(f)) return err(`${p}.file`, `${x.file} does not exist: the claim cannot be linked`);
    const text = readFileSync(f, "utf8");
    const ref = x.ref.replace(/^#/, "");
    const slug = (h) => h.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
    const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1]));
    if (!text.includes(ref) && !headings.includes(slug(ref))) err(`${p}.ref`, `"${x.ref}" is not present in ${x.file}`);
  } else if (x.kind === "code") {
    onlyKeys(x, ["kind", "path"], p, err);
    if (!safeRel(x.path)) return err(`${p}.path`, "expected repo-relative path without ..");
    if (root && !existsSync(resolve(root, x.path))) err(`${p}.path`, `${x.path} does not exist: the claim is not verifiable in code`);
  } else err(`${p}.kind`, "must be product-fact or code");
}

function firstScreen(f, p, required, err) {
  if (f === undefined) { if (required) err(p, "a persuade/experience screen specifies its first screen {headline, subline, primary_actions}"); return; }
  if (!isObj(f)) return err(p, "expected object");
  onlyKeys(f, ["headline", "subline", "primary_actions"], p, err);
  reqStr(f, ["headline", "subline"], p, err);
  if (isStr(f.headline) && [...f.headline].length > 48) err(`${p}.headline`, `${[...f.headline].length} characters: keep the headline near 32, never above 48`);
  for (const k of ["headline", "subline"]) if (isStr(f[k]) && INTERNAL_COPY.test(f[k])) err(`${p}.${k}`, "copy shows a file path or an internal id");
  if (!Array.isArray(f.primary_actions) || !f.primary_actions.every(isStr)) return err(`${p}.primary_actions`, "expected array of button labels");
  if (f.primary_actions.length !== 1) err(`${p}.primary_actions`, `exactly one primary action on the first screen (found ${f.primary_actions.length})`);
  for (const a of f.primary_actions) if (INTERNAL_COPY.test(a)) err(`${p}.primary_actions`, "copy shows a file path or an internal id");
}

// V4: live thing, visual plan, motion thesis, self-hosted font with a licence.
function craft(c, required, root, err) {
  const p = "$.craft";
  if (c === undefined) { if (required) err(p, "a persuade spec needs craft: live_thing, visual_plan, motion and fonts"); return; }
  if (!isObj(c)) return err(p, "expected object");
  onlyKeys(c, ["live_thing", "visual_plan", "motion", "fonts"], p, err);
  const need = (k) => { if (!(k in c)) { if (required) err(`${p}.${k}`, "required for a persuade surface"); return false; } return true; };
  if (need("live_thing")) {
    const l = c.live_thing, q = `${p}.live_thing`;
    if (!isObj(l)) err(q, "expected object");
    else {
      onlyKeys(l, ["description", "phone_ok", "no_script_fallback", "does_not_block_reading"], q, err);
      reqStr(l, ["description", "no_script_fallback"], q, err);
      if (l.phone_ok !== true) err(`${q}.phone_ok`, "the live thing must work on a phone (true)");
      if (l.does_not_block_reading !== true) err(`${q}.does_not_block_reading`, "the live thing must not block reading (true)");
    }
  }
  if (need("visual_plan")) {
    const v = c.visual_plan, q = `${p}.visual_plan`;
    if (!isObj(v)) err(q, "expected object");
    else {
      onlyKeys(v, ["real", "images", "ledger"], q, err);
      if (!Array.isArray(v.real) || v.real.length === 0 || !v.real.every(isStr)) err(`${q}.real`, "write first what is actually real (own photos, real UI, a generation tool, or the word none)");
      const files = visualImages(v.images, q, err);
      if (!safeRel(v.ledger)) err(`${q}.ledger`, "path of the image ledger (docs/design/IMAGES.md)");
      else if (root && files.length > 0) {
        const f = resolve(root, v.ledger);
        if (!existsSync(f)) err(`${q}.ledger`, `${v.ledger} does not exist but images are listed`);
        else { const t = readFileSync(f, "utf8"); for (const im of files) if (!t.includes(im)) err(`${q}.images`, `${im} has no row in ${v.ledger}`); }
      }
    }
  }
  if (need("motion")) {
    const m = c.motion, q = `${p}.motion`;
    if (!isObj(m)) err(q, "expected object");
    else {
      onlyKeys(m, ["thesis", "signature", "stagger_ms", "feedback_all_controls", "moving_visual", "reduced_motion"], q, err);
      reqStr(m, ["thesis", "signature", "moving_visual", "reduced_motion"], q, err);
      if (!Number.isFinite(m.stagger_ms) || m.stagger_ms < 60 || m.stagger_ms > 90) err(`${q}.stagger_ms`, "in-section stagger of 60-90 ms");
      if (m.feedback_all_controls !== true) err(`${q}.feedback_all_controls`, "every control gives hover/press feedback (true)");
    }
  }
  if (need("fonts")) {
    const f = c.fonts, q = `${p}.fonts`;
    if (!Array.isArray(f) || f.length === 0) err(q, "expected non-empty array of self-hosted fonts {family, file, license, license_ref}");
    else f.forEach((x, i) => {
      const r = `${q}[${i}]`;
      if (!isObj(x)) return err(r, "expected object");
      onlyKeys(x, ["family", "file", "license", "license_ref"], r, err);
      reqStr(x, ["family", "license"], r, err);
      if (!safeRel(x.file)) err(`${r}.file`, "self-hosted font file path in the project (a system font cannot be the voice of a persuade surface; no hot-linked font)");
      else if (root && !existsSync(resolve(root, x.file)) && required) err(`${r}.file`, `${x.file} does not exist`);
      fontLicence(x, r, root, err);
    });
  }
}

// A font in craft.fonts needs a verifiable licence reference: an open family of the bundled licence directory
// (`library:<family>`), or the path of the package's or font's own licence file inside the project.
function fontLicence(x, r, root, err) {
  const ref = x.license_ref;
  if (!isStr(ref)) return err(`${r}.license_ref`, "an unverifiable font is rejected: give library:<family> (open licence in the bundled directory) or the path of the package's licence file");
  if (ref.startsWith("library:")) {
    const fam = ref.slice(8).trim().toLowerCase();
    let lib;
    try { lib = library(); } catch (e) { return err(`${r}.license_ref`, `bundled licence directory not readable (${e.message})`); }
    const hit = lib.licences.families.find((h) => h.name.toLowerCase() === fam);
    if (!hit) return err(`${r}.license_ref`, `"${ref.slice(8)}" is not in the bundled licence directory: use the path of the package's licence file instead`);
    if (!["OFL", "APACHE2", "UFL"].includes(hit.license)) return err(`${r}.license_ref`, `licence ${hit.license} of "${hit.name}" is not an open licence`);
    if (isStr(x.family) && x.family.trim().toLowerCase() !== fam) err(`${r}.license_ref`, `the reference names "${ref.slice(8)}" but the font is "${x.family}"`);
    return;
  }
  if (!safeRel(ref)) return err(`${r}.license_ref`, "expected library:<family> or a repo-relative path of a licence file");
  if (root && !existsSync(resolve(root, ref))) err(`${r}.license_ref`, `${ref} does not exist: the licence cannot be verified`);
}

// visual_plan.images: a string is a project image; an object {file, source: project|library|generated, ...} says where it
// came from. Library images are self-hosted (a project path, never an address), carry a credit, and are never counted as
// the project's own imagery. Generated images name the tool and the prompt. Returns the file paths.
function visualImages(images, q, err) {
  if (!Array.isArray(images)) { err(`${q}.images`, "expected array (empty when none): project image paths or {file, source, ...} objects"); return []; }
  const files = [];
  images.forEach((im, i) => {
    const r = `${q}.images[${i}]`;
    const o = typeof im === "string" ? { file: im, source: "project" } : im;
    if (!isObj(o)) return err(r, "expected a path or {file, source}");
    onlyKeys(o, ["file", "source", "credit", "tool", "prompt"], r, err);
    if (!["project", "library", "generated"].includes(o.source)) err(`${r}.source`, "must be project, library or generated");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(o.file))) return err(`${r}.file`, "hot-linked image: download it and self-host it in the project");
    if (!safeRel(o.file)) return err(`${r}.file`, "expected a repo-relative path of a self-hosted file");
    files.push(o.file);
    if (o.source === "library" && !isStr(o.credit)) err(`${r}.credit`, "a library image keeps its credit (on the page and in the ledger)");
    if (o.source === "generated") { if (!isStr(o.tool)) err(`${r}.tool`, "a generated image names the tool"); if (!isStr(o.prompt)) err(`${r}.prompt`, "a generated image records its prompt"); }
    if (o.source !== "generated" && ("tool" in o || "prompt" in o)) err(r, "tool and prompt belong to generated images only");
  });
  return files;
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
  // `## Pattern justifications`: lines "- <pattern-id>: <reason>" (registry id, non-empty reason). Optional section.
  const pj = [...sections.keys()].find((k) => k.toLowerCase() === "pattern justifications");
  if (pj) for (const l of sections.get(pj)) {
    const b = /^\s*[-*]\s+(.*)$/.exec(l);
    if (!b) continue;
    const m = /^([a-z][a-z-]*):\s*(.*)$/.exec(b[1]);
    if (!m || !PATTERN_IDS.includes(m[1])) errors.push(`DESIGN.md: pattern justification "${b[1].slice(0, 40)}" must read "- <registry pattern id>: <reason>"`);
    else if (!m[2].trim()) errors.push(`DESIGN.md: pattern justification ${m[1]} has no reason`);
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
