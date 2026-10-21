// Helpers shared by the scripts of this skill (read-only): config, slug resolution, line parsing, output.
// No dependencies. The evidence validator is the byte-identical copy next to it.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MARKER, parseMarker } from "./validate-product-claims.mjs";

export const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
export const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));

// Value of `<block>.<key>` from <root>/.agents/config.yaml (top-level block, one level of keys), or null.
export function configValue(root, block, key) {
  const t = read(join(root, ".agents", "config.yaml"));
  if (t === null) return null;
  let inBlock = false;
  for (const l of t.split(/\r?\n/)) {
    if (/^\S/.test(l)) { inBlock = new RegExp(`^${block}:\\s*(#.*)?$`).test(l); continue; }
    const m = inBlock && new RegExp(`^  ${key}:\\s*(.*?)\\s*$`).exec(l);
    if (m) { const v = m[1].replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1"); return v === "" ? null : v; }
  }
  return null;
}
export const productDir = (root) => configValue(root, "product", "dir") || "docs/product";
// product.stale_days: a positive integer, default 90.
export function staleDays(root) {
  const v = configValue(root, "product", "stale_days");
  return v !== null && /^[1-9][0-9]*$/.test(v) ? Number(v) : 90;
}

// `arg` is a path to a directory or file, or a slug resolved under <root>/<product.dir>/.
export function resolveTarget(arg, root) {
  if (existsSync(arg)) return resolve(arg);
  return join(root, productDir(root), arg);
}
export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const slugOf = (arg) => arg.split(/[\\/]/).filter(Boolean).pop();
export const mdFiles = (dir) => { try { return readdirSync(dir).filter((n) => n.endsWith(".md")).sort(); } catch { return []; } };

// Flags with a value, boolean flags, positionals. `bad` names an unknown flag.
export function parseArgs(argv, valued = [], bools = []) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) o[a.slice(2)] = argv[++i];
    else if (bools.includes(a)) o[a.slice(2)] = true;
    else if (a.startsWith("--")) o.bad = a;
    else o._.push(a);
  }
  return o;
}

// `- <ID> text` lines (ID like C-3, OP-2) outside code fences and comments, with the markers each one carries.
export function idLines(text, idPattern = "[A-Z]{1,3}-\\d+") {
  const re = new RegExp(`^- (${idPattern})\\s`);
  const out = [];
  let fence = false;
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const m = re.exec(raw);
    if (m) out.push({ line: i + 1, id: m[1], text: raw, markers: [...raw.matchAll(MARKER)].map((x) => ({ raw: x[0], ...parseMarker(x[1], x[2]) })) });
  });
  return out;
}

// Prints findings (and stale cells) as text or JSON; returns the exit code.
export function report(findings, extra, json, label) {
  if (json) console.log(JSON.stringify({ ok: findings.length === 0, findings, ...extra }, null, 2));
  else {
    for (const f of findings) console.error(`error: ${f.file}:${f.line}: [${f.rule}] ${f.message}`);
    for (const s of extra.stale || []) console.error(`stale: ${s.file}:${s.line}: ${s.competitor} / ${s.attribute} observed ${s.observed} (${s.ageDays} days old)`);
    console.log(`${label}: ${findings.length} finding(s)${extra.stale ? `, ${extra.stale.length} stale` : ""}`);
  }
  return findings.length ? 1 : 0;
}
