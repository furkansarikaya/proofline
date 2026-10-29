#!/usr/bin/env node
// Lints an llm-wiki folder (see ../SKILL.md) and writes <wiki>/lint-report.md.
// Usage: node validate-wiki.mjs <wiki-folder> [--root <repository-root>]   (root defaults to the cwd)
// Errors: missing source, source that is not a repository file, invalid status, contradicted page without
// contradicts, duplicate title, broken [[wikilink]]. Warning: possible orphan page.
// Warnings also propose merging pages that are very similar (word-set Jaccard >= SIMILAR, a proposal only) and archiving a log.md
// that holds more than LOG_MAX entries. Other modes (A203):
//   --archive-log [--keep N]   move the oldest log.md entries to log-archive.md (append only; nothing is deleted)
//   --similar "<title words>"  list the existing pages most similar to a new page title (look before opening a page)
// Exit: 0 no errors (warnings allowed), 1 errors, 2 usage/read error. No dependencies.
import { readFileSync, writeFileSync, appendFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPORT = "lint-report.md";
const STATUS = ["current", "accepted", "archived", "contradicted"];
const SIMILAR = 0.6, LOG_MAX = 200;
const NOT_PAGES = ["CLAUDE", "index", "log", "log-archive", "KNOWLEDGE-PIPELINE", "README"];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const field = (text, k) => new RegExp(`^${k}: (.*)$`, "m").exec(text)?.[1].trim();

const tokens = (t) => new Set((t.replace(/^---[\s\S]*?\n---/, (m) => (/^title: (.*)$/m.exec(m)?.[1] ?? "")).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
const isEntry = (l) => /^- /.test(l);

// archiveLog(wiki, keep): keeps the newest `keep` entries in log.md; the older ones are appended to log-archive.md in order.
// Entries are the dash lines; everything else (header, blank lines) stays in log.md. Returns the number of entries moved.
export function archiveLog(wiki, keep = 100) {
  const logf = join(wiki, "log.md");
  if (!existsSync(logf)) return 0;
  const lines = readFileSync(logf, "utf8").split("\n");
  const idx = lines.flatMap((l, i) => (isEntry(l) ? [i] : []));
  if (idx.length <= keep) return 0;
  const move = new Set(idx.slice(0, idx.length - keep));
  const moved = lines.filter((_, i) => move.has(i));
  const arch = join(wiki, "log-archive.md");
  if (!existsSync(arch)) writeFileSync(arch, "# Log archive\n\nOlder entries moved from `log.md`, oldest first. Append only.\n\n");
  appendFileSync(arch, moved.join("\n") + "\n");
  writeFileSync(logf, lines.filter((_, i) => !move.has(i)).join("\n"));
  return moved.length;
}

// similarPages(wiki, title): the existing pages most similar to a new page title, best first.
export function similarPages(wiki, title, limit = 3) {
  const q = tokens(`---\ntitle: ${title}\n---`);
  const all = walk(wiki).filter((f) => f.endsWith(".md") && basename(f) !== REPORT && relative(wiki, f).split(sep)[0] !== "raw" && !(dirname(f) === wiki && NOT_PAGES.includes(basename(f, ".md"))));
  return all.map((f) => {
    const t = readFileSync(f, "utf8"), tt = tokens(`---\ntitle: ${field(t, "title") ?? basename(f, ".md")}\n---`);
    const hit = [...q].filter((x) => tt.has(x) || basename(f).includes(x)).length;
    return { page: relative(wiki, f).split(sep).join("/"), score: q.size ? hit / q.size : 0 };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.page.localeCompare(b.page)).slice(0, limit);
}

export function lint(wiki, root) {
  const errors = [], warnings = [];
  const rel = (f) => relative(root, f).split(sep).join("/");
  const all = walk(wiki).filter((f) => f.endsWith(".md") && basename(f) !== REPORT).sort();
  const text = new Map(all.map((f) => [f, readFileSync(f, "utf8")]));
  const inRaw = (f) => relative(wiki, f).split(sep)[0] === "raw";
  // The special names are exempt only at the wiki root, never in a subfolder.
  const special = (f) => dirname(f) === wiki && NOT_PAGES.includes(basename(f, ".md"));
  const pages = all.filter((f) => !special(f) && !inRaw(f));
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

  for (const f of pages) {
    const t = text.get(f), source = field(t, "source"), status = field(t, "status");
    if (source === undefined) errors.push(`missing source metadata: ${rel(f)}`);
    else if (source && !(resolve(root, source).startsWith(root + sep) && isFile(resolve(root, source)))) errors.push(`nonexistent provenance source: ${rel(f)} -> ${source}`);
    if (status !== undefined && !STATUS.includes(status)) errors.push(`invalid status ${status}: ${rel(f)}`);
    if (status === "contradicted" && field(t, "contradicts") === undefined) errors.push(`contradicted page lacks contradicts metadata: ${rel(f)}`);
  }

  const titles = all.map((f) => field(text.get(f), "title")).filter(Boolean).sort();
  for (const t of new Set(titles.filter((x, i) => titles[i + 1] === x))) errors.push(`duplicate title: ${t}`);

  const names = new Set([...all.map((f) => basename(f, ".md")), "lint-report"]);
  const links = new Set([...text.values()].flatMap((t) => [...t.matchAll(/\[\[([^\]|#]+)\]\]/g)].map((m) => m[1])));
  for (const l of [...links].sort()) if (!names.has(l)) errors.push(`broken wikilink: [[${l}]]`);

  for (const f of pages) {
    const b = basename(f, ".md");
    if (![...text.values()].some((t) => t.includes(`[[${b}]]`))) warnings.push(`possible orphan page: ${rel(f)}`);
  }

  // Proposals only (never errors): very similar pages could be one page, and a long log belongs in the archive.
  const bag = pages.map((f) => [f, tokens(text.get(f))]);
  for (let i = 0; i < bag.length; i++) for (let j = i + 1; j < bag.length; j++) {
    const sim = jaccard(bag[i][1], bag[j][1]);
    if (sim >= SIMILAR) warnings.push(`merge proposal: ${rel(bag[i][0])} and ${rel(bag[j][0])} are ${Math.round(sim * 100)}% similar, consider one page`);
  }
  const logf = join(wiki, "log.md");
  if (existsSync(logf)) {
    const n = readFileSync(logf, "utf8").split("\n").filter(isEntry).length;
    if (n > LOG_MAX) warnings.push(`log.md has ${n} entries (more than ${LOG_MAX}): run validate-wiki.mjs <wiki> --archive-log`);
  }
  return { errors, warnings };
}

const report = ({ errors, warnings }) =>
  ["# Wiki lint report", "", "Generated by `validate-wiki.mjs`.", "", "## Results", "",
    ...(errors.length || warnings.length
      ? [...errors.map((e) => `- ERROR ${e}`), ...warnings.map((w) => `- WARNING ${w}`)]
      : ["- PASS: no broken links, duplicate titles, invalid statuses, missing source metadata, or possible orphan pages found."]),
    "", `Errors: ${errors.length}`, `Warnings: ${warnings.length}`, ""].join("\n");

const main = () => {
  const args = process.argv.slice(2);
  const take = (flag) => { const k = args.indexOf(flag); return k >= 0 ? args.splice(k, 2)[1] ?? "" : undefined; };
  const rootArg = take("--root"), similar = take("--similar"), keepArg = take("--keep");
  const k = args.indexOf("--archive-log"), archive = k >= 0 && args.splice(k, 1).length === 1;
  const root = resolve(rootArg ?? ".");
  if (args.length !== 1 || similar === "" || (keepArg !== undefined && !/^\d+$/.test(keepArg))) { console.error("usage: validate-wiki.mjs <wiki-folder> [--root <repository-root>] [--archive-log [--keep N]] [--similar \"<title>\"]"); process.exit(2); }
  const wiki = resolve(args[0]);
  if (!existsSync(wiki) || !statSync(wiki).isDirectory()) { console.error(`cannot read folder: ${args[0]}`); process.exit(2); }
  if (similar !== undefined) { const r = similarPages(wiki, similar); console.log(r.length ? r.map((x) => `${x.page} (${Math.round(x.score * 100)}%)`).join("\n") : "no similar page: a new page is fine"); process.exit(0); }
  if (archive) { console.log(`archived ${archiveLog(wiki, keepArg === undefined ? 100 : Number(keepArg))} log entries to log-archive.md`); process.exit(0); }
  const r = lint(wiki, root);
  writeFileSync(join(wiki, REPORT), report(r));
  for (const e of r.errors) console.error(`ERROR ${e}`);
  for (const w of r.warnings) console.error(`WARNING ${w}`);
  console.log(`wiki lint: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
  process.exit(r.errors.length ? 1 : 0);
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
