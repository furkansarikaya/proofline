#!/usr/bin/env node
// Checks the competitor table of COMPETITORS.md.
//   node check-competitors.mjs <slug|dir|file> [--today YYYY-MM-DD] [--root DIR] [--json]
// One table row is one cell of the comparison:
//   | Competitor | Attribute | Value | Source | Observed | Quote |
// A cell holds `value | source URL | observed YYYY-MM-DD | "quote"`, here as the columns Value to Quote. A cell that
// cannot be verified (no http(s) source, no valid date, no quote) must have an empty Value (`unverifiable-value`);
// a Value whose numbers are missing from the quote is `value-not-in-quote`. A verified cell observed more than
// product.stale_days (default 90) days before today is marked stale in the output and in `stale[]` of --json; stale
// cells do not change the exit code. --today overrides the date (tests).
// Beyond the table, each competitor of the table has a profile (`## Profiles`, one `### <Competitor>` per competitor) with
// the keys sells to, positioning, pricing model, praised, complained and switching cost. A value is `unknown`, or
// `<summary> | <URL> | <YYYY-MM-DD> | "<quote>"`, or (sells to, pricing model, switching cost only) a summary with an
// `[assumption: <risk>]` marker. Positioning is the competitor's own words, praised and complained are user reviews:
// those three are sourced or unknown. `## Implications for us` ends the file: at least one item, each naming a competitor
// of the table. Rules: no-profile, profile-field, unverifiable-profile, profile-unknown-competitor, no-implications,
// implication-without-competitor, pending-proposal, rejected-proposal.
// Exit 0 clean, 1 findings, 2 usage.
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { read, resolveTarget, isDir, parseArgs, report, staleDays, stripComments, section, parseMarkers } from "./lib.mjs";
import { rejectedProposals } from "./validate-product-claims.mjs";

export const PROFILE_KEYS = ["sells to", "positioning", "pricing model", "praised", "complained", "switching cost"];
const SOURCED_ONLY = ["positioning", "praised", "complained"];
const HEADER = ["competitor", "attribute", "value", "source", "observed", "quote"];
const NUM = /\d[\d.,]*\d|\d/g;
const norm = (n) => n.replace(/,/g, "").replace(/\.$/, "");
const DAY = 86400000;
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

function checkProfiles(text, name, cells, { today, stale }, findings, staleCells) {
  const add = (line, rule, message) => findings.push({ file: name, line, id: null, rule, message });
  for (const mk of parseMarkers(text)) if (mk.kind === "proposal") add(mk.line, "pending-proposal", "a proposal the user has not answered stays out of the document: accepted becomes `source agent accepted by user`, rejected goes under `## Rejected proposals`");
  for (const e of rejectedProposals(text).errors) add(e.line, "rejected-proposal", e.message);
  const names = new Map(cells.map((c) => [c.competitor.toLowerCase(), c.competitor]));
  const prof = section(text, "Profiles") || [];
  const profiles = new Map();
  let cur = null;
  for (const l of prof) {
    const h = /^###\s+(.+?)\s*$/.exec(l.text);
    if (h) { cur = { name: h[1], line: l.line, keys: new Map() }; profiles.set(h[1].toLowerCase(), cur); continue; }
    const kv = cur && /^-\s+([A-Za-z ]+?):\s*(.*)$/.exec(l.text);
    if (kv) cur.keys.set(kv[1].toLowerCase(), { line: l.line, value: kv[2].trim() });
  }
  for (const [key, c] of names) {
    const p = profiles.get(key);
    if (!p) { add(prof[0]?.line ?? 1, "no-profile", `${c} has no profile: add \`### ${c}\` under \`## Profiles\` (${PROFILE_KEYS.join(", ")})`); continue; }
    for (const k of PROFILE_KEYS) {
      const v = p.keys.get(k);
      if (!v || !v.value) { add(v?.line ?? p.line, "profile-field", `${c}: "${k}" is missing (write \`unknown\` when nobody has checked)`); continue; }
      if (/^unknown\.?$/i.test(v.value)) continue;
      const parts = v.value.split(/\s+\|\s+/).map((x) => x.trim());
      const q = parts.length === 4 ? /^"([^"]+)"$/.exec(parts[3])?.[1] : null;
      if (parts.length === 4 && /^https?:\/\/\S+$/.test(parts[1]) && validDate(parts[2]) && q) {
        const qn = new Set((q.match(NUM) || []).map(norm));
        const miss = (parts[0].match(NUM) || []).map(norm).filter((n) => !qn.has(n));
        if (miss.length) add(v.line, "value-not-in-quote", `${c} / ${k}: number ${miss.join(", ")} does not occur in the quote`);
        const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${parts[2]}T00:00:00Z`)) / DAY);
        if (age < 0) add(v.line, "future-date", `${c} / ${k}: observed ${parts[2]} is after today (${today})`);
        else if (age > stale) staleCells.push({ file: name, line: v.line, competitor: c, attribute: k, observed: parts[2], ageDays: age });
        continue;
      }
      const a = parseMarkers(v.value).find((m) => m.kind === "assumption" && !m.errors.length);
      if (a && !SOURCED_ONLY.includes(k)) continue;
      add(v.line, "unverifiable-profile", `${c} / ${k}: ${SOURCED_ONLY.includes(k) ? "their own words or user reviews are sourced" : "a value is sourced or an assumption"}: \`<summary> | <URL> | <YYYY-MM-DD> | "<quote>"\`${SOURCED_ONLY.includes(k) ? "" : " or `[assumption: <risk>]`"}, otherwise \`unknown\``);
    }
  }
  for (const [key, p] of profiles) if (!names.has(key)) add(p.line, "profile-unknown-competitor", `profile "${p.name}" is not a competitor of the table`);
  const imp = section(text, "Implications for us");
  const items = (imp || []).filter((l) => /^-\s+\S/.test(l.text) && !/^-\s+(none|yok)\.?\s*$/i.test(l.text));
  if (!items.length) add(imp?.[0]?.line ?? 1, "no-implications", "the file ends with `## Implications for us`: what the competitors mean for our decision, one item each");
  for (const it of items) if (![...names.keys()].some((n) => it.text.toLowerCase().includes(n))) add(it.line, "implication-without-competitor", "an implication names the competitor of the table it follows from");
}

export function checkCompetitors(text, { today, stale = 90, name = "COMPETITORS.md" } = {}) {
  const findings = [], staleCells = [], cells = [];
  let header = false, fence = false, sawTable = false;
  stripComments(text).split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence || !/^\s*\|/.test(raw)) { if (!/^\s*\|/.test(raw)) header = false; return; }
    const c = raw.trim().replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
    if (c.map((s) => s.toLowerCase()).join("|") === HEADER.join("|")) { header = true; sawTable = true; return; }
    if (!header || c.every((s) => /^:?-+:?$/.test(s))) return;
    const add = (rule, message) => findings.push({ file: name, line, id: null, rule, message });
    if (c.length !== 6) return add("bad-row", `a row has 6 columns (${HEADER.join(" | ")}), found ${c.length}`);
    const [competitor, attribute, value, source, observed, quote] = c;
    if (!competitor || !attribute) return add("bad-row", "a row names its competitor and attribute");
    const q = /^"([^"]+)"$/.exec(quote)?.[1];
    const date = observed.replace(/^observed\s+/i, "");
    const verified = /^https?:\/\/\S+$/.test(source) && validDate(date) && !!q;
    const cell = { file: name, line, competitor, attribute, value, source, observed: date, quote: q || "", verified, stale: false };
    if (value && !verified) add("unverifiable-value", `${competitor} / ${attribute}: a value needs an http(s) source, an observed date (YYYY-MM-DD) and a quoted passage; otherwise leave the value empty`);
    if (!value && (source || observed || quote)) add("orphan-source", `${competitor} / ${attribute}: a source without a value; fill both or empty the cell`);
    if (verified) {
      const qn = new Set((q.match(NUM) || []).map(norm));
      const miss = (value.match(NUM) || []).map(norm).filter((n) => !qn.has(n));
      if (miss.length) add("value-not-in-quote", `${competitor} / ${attribute}: number ${miss.join(", ")} of the value does not occur in the quote`);
      const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY);
      cell.ageDays = age;
      if (age < 0) add("future-date", `${competitor} / ${attribute}: observed ${date} is after today (${today})`);
      else if (age > stale) { cell.stale = true; staleCells.push({ file: name, line, competitor, attribute, observed: date, ageDays: age }); }
    }
    cells.push(cell);
  });
  if (!sawTable) findings.push({ file: name, line: 0, id: null, rule: "no-table", message: `no competitor table found; the header row must be | ${HEADER.join(" | ")} |` });
  else checkProfiles(text, name, cells, { today, stale }, findings, staleCells);
  return { findings, stale: staleCells, cells };
}

function main(argv) {
  const a = parseArgs(argv, ["--root", "--today"], ["--json"]);
  if (a.bad || a._.length !== 1 || (a.today !== undefined && !validDate(a.today))) { console.error("usage: check-competitors.mjs <slug|dir|file> [--today YYYY-MM-DD] [--root DIR] [--json]"); return 2; }
  const root = resolve(a.root || ".");
  let file = resolveTarget(a._[0], root);
  if (isDir(file)) file = join(file, "COMPETITORS.md");
  if (!existsSync(file)) { console.error(`not found: ${file}`); return 2; }
  const r = checkCompetitors(read(file), { today: a.today || new Date().toISOString().slice(0, 10), stale: staleDays(root), name: basename(file) });
  return report(r.findings, { stale: r.stale, cells: r.cells }, a.json, "check-competitors");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
