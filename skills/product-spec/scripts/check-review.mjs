#!/usr/bin/env node
// Checks REVIEW.md, the spec review of a PRD (references/SPEC-REVIEW.md). Read-only, no model.
//   node check-review.mjs <REVIEW.md|slug> [--json] [--root DIR]      exit 0 clean, 1 findings, 2 usage
// Rules: verdict (one `verdict: ship|ship-with-conditions|do-not-ship` line), min-never-mentioned (the reviewer lists at
// least MIN_NEVER_MENTIONED = 3 topics the PRD never mentions, `## Never mentioned`: `- <topic>: <why a reader needs it>`),
// completeness-review (`## Completeness` answers each topic of the PRD completeness list as `covered`, `missing` or
// `not applicable`), pending-proposal.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_NEVER_MENTIONED = 3;
// The PRD completeness list (check-prd.mjs checks the PRD against it, the reviewer checks the review against it).
export const COMPLETENESS = ["error and empty states", "permissions and roles", "personal data and retention", "security", "performance", "accessibility", "multilingual", "analytics events", "rollout and migration", "dependencies"];
const VERDICTS = ["ship", "ship-with-conditions", "do-not-ship"];
const STATUS = /^(covered|missing|not applicable)\b/i;

function sectionLines(text, name) {
  const out = [];
  let on = false, fence = false, found = false;
  text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, "")).split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    const h = !fence && /^##\s+(.+?)\s*$/.exec(raw);
    if (h) { on = h[1].toLowerCase() === name.toLowerCase(); if (on) found = true; return; }
    if (on && !fence) out.push({ n: i + 1, text: raw });
  });
  return found ? out : null;
}
const itemsOf = (lines) => (lines || []).filter((l) => /^\s*[-*]\s+\S/.test(l.text) && !/^\s*[-*]\s+(none|yok)\.?\s*$/i.test(l.text)).map((l) => ({ n: l.n, text: l.text.replace(/^\s*[-*]\s+/, "").trim() }));

export function checkReview(text) {
  const findings = [];
  const add = (rule, line, message) => findings.push({ rule, line, message });
  const v = [...text.matchAll(/^verdict:[ \t]*(\S*)[ \t]*$/gim)];
  if (v.length !== 1 || !VERDICTS.includes(v[0][1].toLowerCase())) add("verdict", 1, `one \`verdict: ${VERDICTS.join("|")}\` line`);
  const nm = sectionLines(text, "Never mentioned");
  const topics = itemsOf(nm);
  const good = topics.filter((t) => /^[^:]+:\s*\S+(\s+\S+){2,}/.test(t.text));
  if (good.length < MIN_NEVER_MENTIONED) add("min-never-mentioned", nm?.[0]?.n ?? 1, `\`## Never mentioned\` lists at least ${MIN_NEVER_MENTIONED} topics the PRD never mentions (\`- <topic>: <why a reader needs it>\`); found ${good.length}. Check the PRD against the completeness list first`);
  const comp = sectionLines(text, "Completeness");
  const seen = new Map();
  for (const it of itemsOf(comp)) {
    const m = /^([^:]+):\s*(.*)$/.exec(it.text);
    if (m) seen.set(m[1].trim().toLowerCase(), { n: it.n, status: m[2].trim() });
  }
  const missing = COMPLETENESS.filter((t) => !seen.has(t));
  if (missing.length) add("completeness-review", comp?.[0]?.n ?? 1, `\`## Completeness\` answers every topic of the PRD completeness list; lacks: ${missing.join(", ")} (\`- <topic>: covered | missing -- <what> | not applicable\`)`);
  for (const [t, l] of seen) if (COMPLETENESS.includes(t) && !STATUS.test(l.status)) add("completeness-review", l.n, `${t}: say covered, missing or not applicable`);
  if (/\[proposal\b/i.test(text)) add("pending-proposal", 1, "a proposal the user has not answered stays out of the document");
  return { findings };
}

// product.dir of ROOT/.agents/config.yaml (project-relative), else docs/product.
function productDir(root) {
  try {
    let inBlock = false;
    for (const l of readFileSync(join(root, ".agents", "config.yaml"), "utf8").split(/\r?\n/)) {
      if (/^\S/.test(l)) { inBlock = /^product:\s*(#.*)?$/.test(l); continue; }
      const m = inBlock && /^  dir:\s*(.*?)\s*$/.exec(l);
      if (m) { const v = m[1].replace(/\s+#.*$/, "").replace(/^"(.*)"$/, "$1"); if (v) return v; }
    }
  } catch { /* no config */ }
  return "docs/product";
}

function main(argv) {
  const json = argv.includes("--json");
  const ri = argv.indexOf("--root");
  const root = resolve(ri >= 0 ? argv[ri + 1] || "." : ".");
  const arg = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root");
  if (!arg) { console.error("usage: check-review.mjs <REVIEW.md|slug> [--json] [--root DIR]"); return 2; }
  const file = existsSync(arg) ? resolve(arg) : /[\\/]/.test(arg) ? resolve(arg) : join(root, productDir(root), arg, "REVIEW.md");
  if (!existsSync(file)) { console.error(`cannot read ${file}`); return 2; }
  const r = checkReview(readFileSync(file, "utf8"));
  if (json) console.log(JSON.stringify({ clean: r.findings.length === 0, ...r }, null, 2));
  else {
    for (const f of r.findings) console.error(`finding: ${file}:${f.line}: [${f.rule}] ${f.message}`);
    if (!r.findings.length) console.log(`clean: ${file}`);
  }
  return r.findings.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
