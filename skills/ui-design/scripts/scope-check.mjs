#!/usr/bin/env node
// ui-design scope-check: proves that a focused fix mode (MODES.md) changed only its target.
// Usage: node scope-check.mjs --root <repo> --base <git-ref> --allow <path|glob,...> [--ranges file:from-to,...]
// Compares the working tree (tracked changes, staged or not, plus untracked files) with <git-ref>:
//   - every changed path must match --allow (a file, a directory prefix ending in `/`, or a glob with * ** ?);
//   - for a file named in --ranges, every changed hunk must lie inside one of its line ranges (base-file lines,
//     counted from `git diff --unified=0`); a file in --ranges is allowed without also being in --allow.
// Output: {"ok": bool, "base": ref, "changed": [paths], "outside": ["path" | "path:from-to"]}. Exit 0 ok, 1 something
// outside the target changed, 2 usage or git error. Plain logic, no dependencies.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { process.stderr.write(`scope-check: ${msg}\n`); process.exit(2); };

const root = resolve(opt("--root") ?? ".");
const base = opt("--base");
const allowArg = opt("--allow") ?? "";
const rangesArg = opt("--ranges") ?? "";
if (!base) fail("usage: node scope-check.mjs --root <repo> --base <git-ref> --allow <path|glob,...> [--ranges file:from-to,...]");

const git = (...a) => {
  try { return execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { return fail(`git ${a[0]} failed: ${String(e.stderr || e.message).trim()}`); }
};
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

function globToRegExp(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const allowed = lines(allowArg.replaceAll(",", "\n")).map((p) => p.replace(/^\.\//, ""));
const allows = (file) => allowed.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p || globToRegExp(p).test(file)));

const ranges = new Map(); // file -> [[from, to]]
for (const item of lines(rangesArg.replaceAll(",", "\n"))) {
  const m = /^(.+):(\d+)-(\d+)$/.exec(item);
  if (!m) fail(`bad --ranges entry: ${item} (want file:from-to)`);
  const f = m[1].replace(/^\.\//, "");
  if (!ranges.has(f)) ranges.set(f, []);
  ranges.get(f).push([Number(m[2]), Number(m[3])]);
}

const changed = [...new Set([
  ...lines(git("diff", "--no-renames", "--name-only", base)),
  ...lines(git("ls-files", "--others", "--exclude-standard")),
])].sort();
const untracked = new Set(lines(git("ls-files", "--others", "--exclude-standard")));

const outside = [];
for (const file of changed) {
  if (ranges.has(file) && !untracked.has(file)) {
    // Hunk headers: @@ -a[,b] +c[,d] @@. Old side a..a+b-1 (b = 0 is an insertion after line a).
    const diff = git("diff", "--no-renames", "--unified=0", base, "--", file);
    for (const h of diff.split("\n")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(h);
      if (!m) continue;
      const a = Number(m[1]);
      const b = m[2] === undefined ? 1 : Number(m[2]);
      const from = b === 0 ? a + 1 : a;
      const to = b === 0 ? a + 1 : a + b - 1;
      const inside = ranges.get(file).some(([lo, hi]) => (b === 0 ? a >= lo - 1 && a <= hi : from >= lo && to <= hi));
      if (!inside) outside.push(`${file}:${from}-${to}`);
    }
  } else if (ranges.has(file) || allows(file)) {
    continue;
  } else {
    outside.push(file);
  }
}

const ok = outside.length === 0;
process.stdout.write(`${JSON.stringify({ ok, base, changed, outside })}\n`);
process.exit(ok ? 0 : 1);
