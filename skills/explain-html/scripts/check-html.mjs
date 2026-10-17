#!/usr/bin/env node
// Validator for explain-html pages (A142). usage: node check-html.mjs PAGE.html
// Rejects: an external reference, a missing or empty <title>, a page over 500 KB.
// Exit 0: pass. 1: findings (`file:line: message`). 2: usage error. Dependency-free.
// shortcut: textual scan of the whole text, not an HTML parser; an external URL in plain text also counts, so write links as words.
import { readFileSync, statSync } from "node:fs";

export const MAX_BYTES = 500 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";

// Decode the entities a browser would decode inside an attribute (numeric ones and the common named ones).
function decode(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", Tab: "\t", NewLine: "\n" };
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([A-Za-z]+);/g, (m, n) => named[n] ?? m);
}

// An attribute or url() value is local when it is "#fragment" or a data:image/ or data:font/ URI.
const okValue = (v) => /^#/.test(v) || /^data:(image|font)\//i.test(v) || v === "";

export function check(html, bytes = Buffer.byteLength(html)) {
  const out = [];
  const text = decode(html);
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  if (bytes > MAX_BYTES) out.push({ line: 1, msg: `page is ${bytes} bytes, limit is ${MAX_BYTES}` });
  const t = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<svg[\s\S]*?<\/svg>/gi, "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!t || !t[1].trim()) out.push({ line: 1, msg: "missing or empty <title>" });

  // a URL scheme, or a scheme-relative //host after a quote, paren, comma, equals sign or whitespace
  const re = /(?:https?:|ftp:|wss?:)\/\/[^\s"'<>)]*|["'(=,\s]\/\/[a-z0-9][^\s"'<>)]*/gi;
  for (const m of text.matchAll(re)) {
    const hit = m[0].replace(/^["'(=,\s]/, "");
    if (hit === SVG_NS && /xmlns(:\w+)?\s*=\s*["']$/.test(text.slice(0, m.index + m[0].length - hit.length))) continue;
    out.push({ line: lineOf(m.index), msg: `external reference: ${hit}` });
  }

  // every reference-bearing attribute and every url() must be a fragment or an inline image or font
  const attr = /\b(src|srcset|data|action|href|poster|xlink:href|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (const m of text.matchAll(attr)) {
    const v = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    const parts = m[1].toLowerCase() === "srcset" ? v.split(",").map((p) => p.trim().split(/\s+/)[0]) : [v];
    for (const p of parts) if (!okValue(p)) out.push({ line: lineOf(m.index), msg: `${m[1]} is not a fragment or inline image or font: ${p.slice(0, 40)}` });
  }
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!okValue(v)) out.push({ line: lineOf(m.index), msg: `url() is not a fragment or inline image or font: ${v.slice(0, 40)}` });
  }
  for (const m of text.matchAll(/\bfetch\s*\(|\bimport\s*\(|@import\b|<(?:iframe|object|embed|video|audio|source|track|base)\b/gi))
    out.push({ line: lineOf(m.index), msg: `forbidden: ${m[0].trim()}` });
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
