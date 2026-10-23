#!/usr/bin/env node
// Builds adapt/fonts.json: for every type system in ../type.json, whether its font licences can be verified from the
// font-licence directory (../google-font-licenses.json). Deterministic, no network, no clock.
//   directory-verified     every face is a directory family with an open licence (OFL, APACHE2, UFL) and is not excluded
//   needs-package-licence  at least one face comes from a source the directory does not cover; the implementer reads the
//                          licence file of the package it self-hosts and writes it to the ledger (## Fonts)
//   unverifiable           a directory-sourced face is missing from the directory, excluded, or has a non-open licence;
//                          the system is not used and deal offers one of the same class instead
// Usage: node build-font-map.mjs            write fonts.json next to this script
//        node build-font-map.mjs --check    exit 1 when fonts.json is not what the inputs produce
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..");
const OPEN = new Set(["OFL", "APACHE2", "UFL"]);
const DIRECTORY_SOURCES = new Set(["google"]);
const ROLES = ["display", "text", "mono", "accent"];

const types = JSON.parse(readFileSync(join(lib, "type.json"), "utf8"));
const dir = JSON.parse(readFileSync(join(lib, "google-font-licenses.json"), "utf8"));
const families = new Map(dir.families.map((f) => [f.name.toLowerCase(), f]));
const excluded = new Set((dir.excludedFamilies || []).map((f) => f.name.toLowerCase()));

function faceVerdict(face) {
  if (!DIRECTORY_SOURCES.has(face.source)) {
    return { verdict: "needs-package-licence", reason: `source "${face.source}" is not in the licence directory` };
  }
  const key = String(face.family).toLowerCase();
  if (excluded.has(key)) return { verdict: "unverifiable", reason: "family is excluded from the directory" };
  const hit = families.get(key);
  if (!hit) return { verdict: "unverifiable", reason: "family not found in the directory" };
  if (!OPEN.has(hit.license)) return { verdict: "unverifiable", reason: `licence ${hit.license} is not an open licence` };
  return { verdict: "directory-verified", license: hit.license };
}

const systems = {};
const counts = { "directory-verified": 0, "needs-package-licence": 0, unverifiable: 0 };
for (const t of types) {
  const faces = [];
  for (const role of ROLES) {
    const f = t[role];
    if (!f) continue;
    faces.push({ role, family: f.family, source: f.source, ...faceVerdict(f) });
  }
  let verdict = "directory-verified";
  if (faces.length === 0 || faces.some((f) => f.verdict === "unverifiable")) verdict = "unverifiable";
  else if (faces.some((f) => f.verdict === "needs-package-licence")) verdict = "needs-package-licence";
  systems[t.id] = { class: t.class, verdict, faces };
  counts[verdict] += 1;
}

const out = {
  schemaVersion: 1,
  basis: "derived from type.json and google-font-licenses.json by build-font-map.mjs; open licences: OFL, APACHE2, UFL",
  directoryRevision: dir.source && dir.source.revision,
  counts,
  systems,
};
const text = `${JSON.stringify(out, null, 2)}\n`;
const target = join(here, "fonts.json");
if (process.argv[2] === "--check") {
  let cur = "";
  try { cur = readFileSync(target, "utf8"); } catch { /* missing counts as stale */ }
  if (cur !== text) { console.error("fonts.json is stale: run node build-font-map.mjs"); process.exit(1); }
} else {
  writeFileSync(target, text);
}
