#!/usr/bin/env node
// Validates an api-design api.json (see ../schema/api.schema.json).
// Usage: node validate-api.mjs <api.json> [--root <repo>]
// Exit: 0 valid, 1 invalid, 2 usage/read error. No dependencies.
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const safeRel = (p) => isStr(p) && !isAbsolute(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const KEYS = ["schema_version", "mode", "format", "existing_contract", "contract_file", "searched", "operations", "contracts_text"];

export function validate(doc, { root = null } = {}) {
  const errors = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  if (!isObj(doc)) return ["$: expected object"];
  for (const k of KEYS) if (!(k in doc)) err("$", `missing required "${k}"`);
  for (const k of Object.keys(doc)) if (!KEYS.includes(k)) err("$", `unexpected "${k}"`);
  if (doc.schema_version !== 1) err("$.schema_version", "must be 1");
  if (!["task", "reverse"].includes(doc.mode)) err("$.mode", "must be task or reverse");
  const formats = ["openapi", "graphql", "protobuf", "jsonschema", "api-md"];
  if (!formats.includes(doc.format)) err("$.format", `must be one of ${formats.join(", ")}`);
  if (!safeRel(doc.contract_file)) err("$.contract_file", "expected repo-relative path without ..");
  if (!Array.isArray(doc.searched) || !doc.searched.every(isStr)) err("$.searched", "expected array of non-empty strings");

  if (doc.format === "api-md") {
    if (doc.existing_contract !== null) err("$.existing_contract", "api-md is only allowed when no existing contract was found (must be null)");
    if (!Array.isArray(doc.searched) || doc.searched.length === 0) err("$.searched", "record the patterns searched to show no contract exists");
  } else if (formats.includes(doc.format)) {
    if (!safeRel(doc.existing_contract)) err("$.existing_contract", "an existing contract file is required for this format");
    else if (doc.contract_file !== doc.existing_contract) err("$.contract_file", "must equal existing_contract: edit the existing contract, do not write another file");
    else if (root && !existsSync(resolve(root, doc.contract_file))) err("$.contract_file", `${doc.contract_file} does not exist`);
  }

  const text = Array.isArray(doc.contracts_text) ? doc.contracts_text : (err("$.contracts_text", "expected array"), []);
  if (!text.every(isStr)) err("$.contracts_text", "expected non-empty strings");
  const ids = new Set();
  const ops = Array.isArray(doc.operations) ? doc.operations : (err("$.operations", "expected array"), []);
  ops.forEach((o, i) => {
    const p = `$.operations[${i}]`;
    if (!isObj(o)) return err(p, "expected object");
    if (!isStr(o.id)) return err(`${p}.id`, "expected non-empty string");
    if (ids.has(o.id)) err(`${p}.id`, `duplicate id ${o.id}`);
    ids.add(o.id);
    if (!["rest", "graphql", "rpc"].includes(o.style)) err(`${p}.style`, "must be rest, graphql or rpc");
    let method = null;
    if (o.style === "rest") {
      const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*)$/.exec(o.id);
      if (!m) err(`${p}.id`, "rest id must be 'METHOD /path'");
      else method = m[1];
    }
    if (!["added", "modified", "removed", "unchanged"].includes(o.change)) err(`${p}.change`, "invalid change");
    if (typeof o.breaking !== "boolean") err(`${p}.breaking`, "expected boolean");
    if (typeof o.versioned !== "boolean") err(`${p}.versioned`, "expected boolean");
    if (!isStr(o.purpose)) err(`${p}.purpose`, "expected non-empty string");
    if (o.change === "removed" && o.breaking !== true) err(`${p}.breaking`, "a removed operation is always breaking");
    if (o.breaking === true) {
      if (!isStr(o.breaking_reason)) err(`${p}.breaking_reason`, "breaking change needs the consumer-visible effect");
      if (!text.some((t) => isStr(t) && t.includes(o.id))) err(`${p}`, "breaking change must be named in contracts_text (PLAN ## Contracts)");
    }
    if (o.versioned === true && !text.some((t) => isStr(t) && t.includes(o.id))) err(`${p}`, "versioned-contract change must be named in contracts_text (PLAN ## Contracts)");
    if (o.breaking === true && o.change === "unchanged") err(`${p}.breaking`, "an unchanged operation cannot be breaking");
    if (o.change === "added" || o.change === "modified") {
      if (!Array.isArray(o.errors) || o.errors.length === 0 || !o.errors.every(isStr)) err(`${p}.errors`, "specify every error response ('<status> <when>')");
      if (!isStr(o.auth)) err(`${p}.auth`, "state the auth requirement");
      if (method && MUTATING.includes(method) && !isStr(o.idempotency)) err(`${p}.idempotency`, "mutating operation needs an idempotency statement");
      if (o.list === true && !isStr(o.pagination)) err(`${p}.pagination`, "list operation needs pagination");
    }
    if (o.handler !== undefined) {
      if (!safeRel(o.handler)) err(`${p}.handler`, "expected repo-relative path without ..");
      else if (root && o.change !== "added" && !existsSync(resolve(root, o.handler))) err(`${p}.handler`, `${o.handler} does not exist`);
    }
    if (doc.mode === "reverse" && o.change !== "unchanged") err(`${p}.change`, "reverse mode describes existing code: unchanged only");
    if (doc.mode === "reverse" && o.change === "unchanged" && !isStr(o.handler)) err(`${p}.handler`, "reverse mode needs the verified handler path");
  });
  return errors;
}

const main = () => {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const root = i >= 0 ? args.splice(i, 2)[1] : null;
  if (args.length !== 1) { console.error("usage: validate-api.mjs <api.json> [--root <repo>]"); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(args[0], "utf8")); } catch (e) { console.error(`cannot read JSON: ${e.message}`); process.exit(2); }
  const errors = validate(doc, { root });
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("valid");
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
