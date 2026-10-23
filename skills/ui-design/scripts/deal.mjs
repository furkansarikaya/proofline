#!/usr/bin/env node
// ui-design deal: picks `count` (default 3) direction candidates at random, reproducibly from a seed.
// Usage: node deal.mjs --candidates <ui.json|json file> [--seed N] [--count 3]
// Input: a ui.json (creative_direction.candidates), an array of names, an array of {name}, or {candidates: [...]}.
// Output: {"seed": N, "dealt": [names]}. Same seed + same candidate names => same dealt names (names are sorted
// first, so the order in the file does not matter). Without --seed a seed is generated and printed.
// Exit: 0 ok, 2 usage/read error. No dependencies.
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Small seeded generator (mulberry32): 32-bit state, deterministic across platforms.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The algorithm the validator re-runs: sort the names, then a partial Fisher-Yates driven by the seeded generator.
export function deal(names, seed, count = 3) {
  const pool = [...names].sort();
  const rnd = prng(seed);
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export function candidateNames(json) {
  const list = Array.isArray(json) ? json
    : Array.isArray(json?.creative_direction?.candidates) ? json.creative_direction.candidates
    : Array.isArray(json?.candidates) ? json.candidates : null;
  if (!list) return null;
  const names = list.map((c) => (typeof c === "string" ? c : c?.name));
  return names.every((n) => typeof n === "string" && n.trim() !== "") ? names : null;
}

const main = () => {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const file = opt("--candidates"), seedArg = opt("--seed"), countArg = opt("--count");
  const fail = (m) => { console.error(m); console.error("usage: deal.mjs --candidates <ui.json|json file> [--seed N] [--count 3]"); process.exit(2); };
  if (!file || args.length) fail("--candidates <file> is required, no other arguments");
  const count = countArg === null ? 3 : Number(countArg);
  if (!Number.isInteger(count) || count < 1) fail("--count must be a positive integer");
  const seed = seedArg === null ? randomInt(0, 4294967296) : Number(seedArg);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) fail("--seed must be an integer from 0 to 4294967295");
  let names;
  try { names = candidateNames(JSON.parse(readFileSync(file, "utf8"))); } catch (e) { fail(`cannot read input: ${e.message}`); }
  if (!names) fail("no candidate names found: expected creative_direction.candidates, a candidates array, or an array of names");
  if (new Set(names).size !== names.length) fail("candidate names must be unique");
  if (names.length < count) fail(`need at least ${count} candidates, found ${names.length}`);
  console.log(JSON.stringify({ seed, dealt: deal(names, seed, count) }));
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
