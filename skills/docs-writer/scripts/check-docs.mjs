#!/usr/bin/env node
// Evidence check for documentation (A138): what a doc quotes must exist in the project.
// usage: node check-docs.mjs [--root DIR] [--json] DOC.md...
// Checked: repo-internal links (file and #anchor), file paths in code spans, commands (their path words, --flags and
// the subcommand of a project binary), config keys of a config.yaml. Each miss is `doc:line: kind not found: claim`.
// Exit 0: no finding. 1: findings. 2: usage error. Dependency-free; reads files, runs nothing.
// shortcut: a flag or subcommand counts as present when its text occurs in any non-Markdown source file; a path
// without extension or trailing slash is claimed only when its first segment is a top-level project entry.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, extname, relative } from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".claude", "dist", "build"]);
const EXT = new Set("md json yaml yml sh mjs cjs js ts tsx jsx py go rs toml txt css html sql".split(" "));

export function walk(root) {
  const out = [];
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p); else if (e.isFile()) out.push(p);
    }
  };
  rec(root);
  return out;
}

export function slug(h) {
  return h.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}_\- ]/gu, "").replace(/ /g, "-");
}

function anchors(file) {
  const set = new Set(); let fence = false;
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    const m = !fence && l.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (m) set.add(slug(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")));
  }
  return set;
}

// Dotted key paths of an indented YAML config (2-space levels, scalars; comments ignored).
export function yamlKeys(text) {
  const keys = new Set(); const stack = [];
  for (const l of text.split("\n")) {
    if (/^\s*(#|$)/.test(l)) continue;
    const m = l.match(/^( *)([A-Za-z_][\w-]*):/);
    if (!m) continue;
    stack.length = m[1].length / 2; stack.push(m[2]);
    keys.add(stack.join("."));
  }
  return keys;
}

export function checkDocs(root, docs) {
  root = resolve(root);
  let files = null, source = null, cfg = null;
  const all = () => (files ??= walk(root));
  const src = () => (source ??= all().filter((f) => extname(f) !== ".md" && statSync(f).size < 1_000_000).map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n"));
  const configKeys = () => (cfg ??= all().filter((f) => /(^|\/)config\.ya?ml$/.test(f)).map((f) => yamlKeys(readFileSync(f, "utf8"))));
  const tops = () => new Set(configKeys().flatMap((s) => [...s].filter((k) => !k.includes("."))));
  const topEntries = () => new Set(readdirSync(root));
  const binText = (name) => all().filter((f) => relative(root, f).startsWith("bin/") || relative(root, f) === `skills/${name}/SKILL.md`).map((f) => readFileSync(f, "utf8")).join("\n");
  const inRoot = (p, base) => { const t = resolve(base, p); return t === root || t.startsWith(root + "/"); };
  const findings = []; let claims = 0;

  const miss = (doc, line, kind, claim) => findings.push({ doc, line, kind, claim });
  const pathExists = (docDir, p) => { const q = p.replace(/^\.\//, ""); return [root, docDir].some((b) => inRoot(q, b) && existsSync(resolve(b, q))); };

  function pathClaim(doc, line, tok, docDir, strictForm) {
    let p = tok.replace(/[:#].*$/, "").replace(/[,;.)]+$/, "");
    if (!p || /^(https?:|\/|~|-)/.test(p) || /[*<>{}$=|\s]/.test(p) || /^\d+(\.\d+)+$/.test(p)) return;
    const hasExt = EXT.has(extname(p).slice(1).toLowerCase());
    const slashy = p.includes("/");
    if (!hasExt && !slashy) return;
    if (!hasExt && strictForm && !(p.endsWith("/") || p.startsWith("./") || p.startsWith("../") || topEntries().has(p.split("/")[0]))) return;
    claims++;
    if (!pathExists(docDir, p)) miss(doc, line, "path", p);
  }

  function command(doc, line, text, docDir) {
    const w = text.replace(/^\$\s+/, "").split(/\s+/);
    if (!/^(\/?proofline|sh|bash|node|npm|\.\/\S+)$/.test(w[0]) || w.length < 2) return false;
    const bin = w[0].replace(/^\//, "");
    let i = 1;
    if (/^[a-z][a-z-]*$/.test(w[1]) && !["sh", "bash", "node"].includes(bin) && bin !== "npm") {
      claims++;
      if (!new RegExp(`\\b${w[1]}\\b`).test(binText(bin))) miss(doc, line, "command", `${bin} ${w[1]}`);
      i = 2;
    }
    for (; i < w.length; i++) {
      if (/^--[A-Za-z][\w-]+$/.test(w[i])) { claims++; if (!src().includes(w[i])) miss(doc, line, "flag", w[i]); }
      else pathClaim(doc, line, w[i], docDir, false);
    }
    return true;
  }

  function span(doc, line, s, docDir) {
    s = s.trim();
    if (!s || command(doc, line, s, docDir)) return;
    if (/^--[A-Za-z][\w-]+$/.test(s)) { claims++; if (!src().includes(s)) miss(doc, line, "flag", s); return; }
    if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(s) && tops().has(s.split(".")[0])) {
      claims++; if (!configKeys().some((k) => k.has(s))) miss(doc, line, "config key", s); return;
    }
    pathClaim(doc, line, s, docDir, true);
  }

  function link(doc, line, target, docFile) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
    const [pathPart, anchor] = target.replace(/\?[^#]*/, "").split("#");
    claims++;
    const abs = pathPart === "" ? docFile : resolve(pathPart.startsWith("/") ? root : dirname(docFile), pathPart.replace(/^\//, ""));
    if (!inRoot(abs, root) || !existsSync(abs)) return miss(doc, line, "link", target);
    if (anchor && extname(abs) === ".md" && statSync(abs).isFile() && !anchors(abs).has(anchor.toLowerCase())) miss(doc, line, "anchor", target);
  }

  for (const d of docs) {
    const docFile = resolve(root, d); const docDir = dirname(docFile);
    const rel = relative(root, docFile);
    let fence = null;
    readFileSync(docFile, "utf8").split("\n").forEach((raw, idx) => {
      const n = idx + 1;
      const f = raw.match(/^\s*(```+|~~~+)\s*([\w-]*)/);
      if (f) { fence = fence ? null : { lang: f[2] }; return; }
      if (fence) { if (["", "sh", "bash", "shell", "console", "zsh"].includes(fence.lang)) command(rel, n, raw.trim(), docDir); return; }
      for (const m of raw.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) span(rel, n, m[1], docDir);
      for (const m of raw.replace(/`[^`]*`/g, "").matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) link(rel, n, m[1], docFile);
    });
  }
  return { claims, findings };
}

function main(argv) {
  let root = process.cwd(), json = false; const docs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--json") json = true;
    else if (argv[i].startsWith("--")) { console.error(`check-docs: unknown option ${argv[i]}`); return 2; }
    else docs.push(argv[i]);
  }
  if (!docs.length || !root || !existsSync(root)) { console.error("usage: check-docs.mjs [--root DIR] [--json] DOC.md..."); return 2; }
  for (const d of docs) if (!existsSync(resolve(root, d))) { console.error(`check-docs: no such file: ${d}`); return 2; }
  const r = checkDocs(root, docs);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    for (const x of r.findings) console.log(`${x.doc}:${x.line}: ${x.kind} not found: ${x.claim}`);
    console.log(`evidence: ${r.claims} claim(s) checked, ${r.findings.length} finding(s)`);
  }
  return r.findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
