// Shared helpers of the product-assess scripts: document lookup, item blocks, fields, hashing, git, output. Node only.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
export const LEVELS = ["high", "medium", "low"];

// Value of `<block>.<key>` from an indented .agents/config.yaml (top-level block, one level of keys), or null.
export function configValue(root, block, key) {
  const text = read(join(root, ".agents", "config.yaml"));
  if (text === null) return null;
  let inBlock = false;
  for (const l of text.split(/\r?\n/)) {
    if (/^\S/.test(l)) { inBlock = new RegExp(`^${block}:\\s*(#.*)?$`).test(l); continue; }
    const m = inBlock && new RegExp(`^  ${key}:\\s*(.*?)\\s*$`).exec(l);
    if (m) { const v = m[1].replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1"); return v === "" ? null : v; }
  }
  return null;
}
export const productDir = (root) => configValue(root, "product", "dir") || "docs/product";

// `<slug>` -> <root>/<product.dir>/<slug>/<file>; an existing path or one with a slash is taken as the file itself.
export function resolveDoc(arg, file, root) {
  if (existsSync(arg)) return resolve(arg);
  if (!/[\\/]/.test(arg)) return join(root, productDir(root), arg, file);
  return resolve(arg);
}

// Items `- <PREFIX>-n text` with their indented continuation lines. Comments and code fences are ignored.
export function items(text, prefix) {
  const out = [], start = new RegExp(`^- (${prefix}-\\d+)(?=\\s|$)\\s*(.*)$`);
  let cur = null, fence = false;
  text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, "")).split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const m = start.exec(raw);
    if (m) { cur = { id: m[1], line: i + 1, head: m[2], lines: [m[2]] }; out.push(cur); return; }
    if (cur && /^\s+\S/.test(raw)) cur.lines.push(raw.trim()); else cur = null;
  });
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Field `key: value` of an item: a continuation line `key: value`, or `; key: value` inside the head. Last one wins.
// `known` lists the other keys that end an inline value.
export function field(item, key, known = []) {
  const stop = known.filter((k) => k !== key).map(esc).join("|");
  const re = new RegExp(`(?:^|;\\s*|\\s)${esc(key)}:[ \\t]*(.*?)[ \\t]*(?=;\\s*(?:${stop || "(?!)"}):|$)`, "i");
  let found = null;
  for (const l of item.lines) { const m = re.exec(l); if (m) found = m[1].replace(/[;]$/, "").trim(); }
  return found;
}

export function git(root, args) {
  try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}

// Common CLI shell: { args, flags, root }, or null after printing usage.
export function cli(argv, usage, valued = []) {
  const flags = {}, args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { if (valued.includes(a)) flags[a] = argv[++i]; else flags[a] = true; } else args.push(a);
  }
  if (!args.length || valued.some((v) => v in flags && flags[v] === undefined)) { console.error(`usage: ${usage}`); return null; }
  return { args, flags, root: resolve(flags["--root"] || ".") };
}

// Prints findings; returns the exit code (0 clean, 1 findings).
export function report(file, findings, extra, json) {
  if (json) console.log(JSON.stringify({ file, clean: findings.length === 0, findings, ...extra }, null, 2));
  else for (const f of findings) console.error(`${f.rule}: ${file}:${f.line ?? 0}: ${f.message}`);
  return findings.length ? 1 : 0;
}
export const isMain = (url) => !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
