#!/usr/bin/env node
// Validates a ui-design ui.json (see ../schema/ui.schema.json) and/or a DESIGN.md.
// Usage: node validate-ui.mjs [<ui.json>] [--design-md <DESIGN.md>] [--root <repo>]
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

export function validate(doc, { root = null } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  for (const k of KEYS) if (!(k in doc)) err("$", `missing required "${k}"`);
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) err("$", `unexpected "${k}"`);
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["task", "reverse"].includes(doc.mode)) err("$.mode", "must be task or reverse");
  if (!Array.isArray(doc.ui_languages) || doc.ui_languages.length === 0 || !doc.ui_languages.every(isStr)) err("$.ui_languages", "expected non-empty array (languages found in the repo's locale files)");
  const ds = doc.design_system;
  if (!isObj(ds) || !safeRel(ds.file) || typeof ds.exists !== "boolean") err("$.design_system", "expected {file: relative path, exists: boolean}");
  else if (root && ds.exists && !existsSync(resolve(root, ds.file))) err("$.design_system.file", `${ds.file} does not exist`);

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
  return errors;
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
  const root = opt("--root"), dm = opt("--design-md");
  if (args.length > 1 || (args.length === 0 && !dm)) { console.error("usage: validate-ui.mjs [<ui.json>] [--design-md <DESIGN.md>] [--root <repo>]"); process.exit(2); }
  const errors = [];
  try {
    if (args[0]) errors.push(...validate(JSON.parse(readFileSync(args[0], "utf8")), { root }));
    if (dm) errors.push(...validateDesignMd(readFileSync(dm, "utf8"), { root }));
  } catch (e) { console.error(`cannot read input: ${e.message}`); process.exit(2); }
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("valid");
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
