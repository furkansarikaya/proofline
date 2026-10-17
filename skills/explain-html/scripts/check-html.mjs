#!/usr/bin/env node
// Validator for explain-html pages (A142). usage: node check-html.mjs PAGE.html
// Rejects: an external reference, a missing or empty <title>, a page over 500 KB.
// Exit 0: pass. 1: findings (`file:line: message`). 2: usage error. Dependency-free.
// shortcut: textual scan, not an HTML parser; an external URL in plain text also counts, so write links as words.
import { readFileSync, statSync } from "node:fs";

export const MAX_BYTES = 500 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";

export function check(html, bytes = Buffer.byteLength(html)) {
  const out = [];
  if (bytes > MAX_BYTES) out.push({ line: 1, msg: `page is ${bytes} bytes, limit is ${MAX_BYTES}` });
  const t = html.replace(/<svg[\s\S]*?<\/svg>/gi, "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!t || !t[1].trim()) out.push({ line: 1, msg: "missing or empty <title>" });
  // a URL scheme, or a scheme-relative //host after a quote, paren, equals sign or whitespace
  const re = /(?:https?:|ftp:|wss?:)\/\/[^\s"'<>)]*|["'(=\s]\/\/[a-z0-9][^\s"'<>)]*/gi;
  html.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(re)) {
      const hit = m[0].replace(/^["'(=\s]/, "");
      if (hit === SVG_NS && /xmlns(:\w+)?\s*=\s*["']$/.test(l.slice(0, m.index + m[0].length - hit.length))) continue;
      out.push({ line: i + 1, msg: `external reference: ${hit}` });
    }
    if (/\bfetch\s*\(|\bimport\s*\(|@import\b|<link\b[^>]*\bhref\s*=|<script\b[^>]*\bsrc\s*=|<img\b[^>]*\bsrc\s*=\s*["'](?!data:)/i.test(l))
      out.push({ line: i + 1, msg: "forbidden fetch, import, link href, script src or non-data image src" });
  });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 1) { console.error("usage: node check-html.mjs PAGE.html"); process.exit(2); }
  let html, size;
  try { html = readFileSync(args[0], "utf8"); size = statSync(args[0]).size; } catch (e) { console.error(`check-html: ${e.message}`); process.exit(2); }
  const f = check(html, size);
  for (const x of f) console.log(`${args[0]}:${x.line}: ${x.msg}`);
  console.log(`${f.length} finding(s)`);
  process.exit(f.length ? 1 : 0);
}
