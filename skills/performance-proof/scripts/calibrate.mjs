#!/usr/bin/env node
// Seeded simulation of the decision rule in compare-bench.mjs: for each noise level (normal, standard deviation
// in percent of the mean), true effect and run count, it draws base and change samples, runs compare() and
// counts FAIL / PASS / INCONCLUSIVE. Prints a markdown table (the one in references/DECISION.md).
// Usage: node calibrate.mjs [--trials 500] [--seed 12345]
// Deterministic for a seed; takes a few minutes. Not part of a review: it documents how the rule behaves.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, thresholds } from "./compare-bench.mjs";

export function calibrate({ trials = 500, seed = 12345, noise = [3, 8], effects = [0, 5, 12, 15], runs = [10, 20], resamples = 1000 } = {}) {
  let t = seed >>> 0;
  const rand = () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const th = thresholds("");
  const rows = [];
  for (const sd of noise) for (const eff of effects) for (const n of runs) {
    const c = { FAIL: 0, PASS: 0, INCONCLUSIVE: 0 };
    for (let i = 0; i < trials; i++) {
      const draw = (f) => Array.from({ length: n }, () => Math.max(1e-6, 100 * f * (1 + (sd / 100) * gauss())));
      c[compare(draw(1), draw(1 + eff / 100), { th, resamples }).status]++;
    }
    rows.push({ sd, eff, n, ...c });
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const get = (k, d) => (a.includes(k) ? Number(a[a.indexOf(k) + 1]) : d);
  const trials = get("--trials", 500);
  const pc = (x) => `${Math.round((x / trials) * 1000) / 10} %`;
  console.log("| noise (sd) | true effect | runs | FAIL | PASS | INCONCLUSIVE |\n|---|---|---|---|---|---|");
  for (const r of calibrate({ trials, seed: get("--seed", 12345) })) console.log(`| ${r.sd} % | +${r.eff} % | ${r.n} | ${pc(r.FAIL)} | ${pc(r.PASS)} | ${pc(r.INCONCLUSIVE)} |`);
}
