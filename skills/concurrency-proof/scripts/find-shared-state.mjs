#!/usr/bin/env node
// Lists candidate concurrency sites (shared state, locks, transactions, retries, timeouts, queues,
// concurrent actors, check-then-act, idempotency) in changed files with conservative, language-independent
// text patterns. The output is a CANDIDATE LIST to examine, never a verdict: a hit is not a problem and a
// file without hits is not free of problems.
// Usage: node find-shared-state.mjs [--repo DIR] [--base REF] [--changed-only] [FILE...]
//   --base REF      the files changed between REF and the working tree (untracked included) and their
//                   changed lines; each candidate says whether its line is changed (`changed_line`)
//   --changed-only  print only candidates on changed lines
//   FILE...         explicit repository-relative files (every line counts as changed)
// Output: one JSON document on stdout (version 1). Exit 0; 2 on usage or git errors.
// Read-only (file reads, git diff, git ls-files); never runs project code. No dependencies.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, join, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// One pattern per category. Kept conservative: whole words, typical spellings across languages.
export const PATTERNS = {
  lock: /\b(?:mutex|rwmutex|rlock|runlock|trylock|lock|unlock|locked|synchronized|semaphore|flock|advisory_lock|pg_advisory_\w+|for update|for share|nowait|skip locked)\b|\b(?:acquire|release)\s*\(/i,
  transaction: /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b|\b(?:transaction|transactional|begintx|begin_transaction|withtransaction|isolation|serializable|repeatable read|read committed)\b/i,
  atomic: /\b(?:atomic\w*|compareandset|compareandswap|compare_and_swap|cas|incrby|incr|setnx|getandincrement|fetch_add|optimistic\w*)\b|\bversion\s*=\s*\w*\.?version\s*\+\s*1\b/i,
  retry: /\b(?:retry|retries|retrying|retried|retryable|backoff|max_?attempts?|attempts?|redrive)\b/i,
  timeout: /time_?out|timed out|deadline|promise\.race/i,
  queue: /\b(?:queue|enqueue|dequeue|publish|subscribe|consumer|consume|ack|nack|redeliver\w*|dead[ _-]?letter|visibility_?timeout|offset|partition|topic|outbox|inbox)\b/i,
  concurrency: /\bgo\s+(?:func\b|\w+\s*\()|\b(?:goroutine|threads?|spawn|promise\.all\w*|asyncio\.gather|executor\w*|parallel\w*|concurrent\w*|workers?|setinterval|cron|scheduler?|waitgroup|channel)\b/i,
  suspension: /\b(?:await|yield)\b/,
  shared_state: /^(?:let|var)\s+\w+|\b(?:static(?!\s+final)|global|globalThis|singleton|shared|cache)\b|\+\+|--(?=\w)|\w--|[-+*/]=(?!=)|\b([A-Za-z_][\w.]*)\s*=\s*\1\s*[-+*/]/,
  check_then_act: /\bif\b.*\b(?:exists?|has|contains|includes|find\w*|count|status|state|processed|already|seen|isnull|is_none|undefined)\b/i,
  idempotency: /\b(?:idempoten\w*|dedup\w*|unique|on conflict|upsert|insert or ignore|insert ignore|request_?id|requestid|message_?id|messageid|processed)\b/i,
};
const SKIP = /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(?:md|txt|png|jpe?g|gif|svg|ico|pdf|zip|gz|lock)$/i;
// A whole-line comment is not code; a trailing comment is kept (the line has code).
export const COMMENT = /^\s*(?:\/\/|#(?!include|define|if|pragma)|\/\*|\*|--\s|;;)/;
export const LIMITS = [
  "text patterns only: no parsing, no call graph, no type information",
  "shared state reached through aliases, dependency injection, framework configuration or another file is not seen",
  "every hit is a candidate to examine, never a finding; a file without hits is not free of concurrency problems",
];

export function scanText(file, text, changed) {
  const out = [];
  if (text.includes("\0")) return out;
  text.split("\n").forEach((line, i) => {
    if (COMMENT.test(line) || line.length > 2000) return;
    for (const [category, re] of Object.entries(PATTERNS)) {
      const m = re.exec(line);
      if (m) out.push({ file, line: i + 1, category, match: m[0], text: line.trim().slice(0, 200), changed_line: changed ? changed.has(i + 1) : true });
    }
  });
  return out;
}

const gitLines = (root, base) => {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  const map = new Map();
  let file = null;
  for (const l of git("diff", "-U0", "--no-color", "--no-ext-diff", base, "--").split("\n")) {
    if (l.startsWith("+++ ")) { file = l === "+++ /dev/null" ? null : l.slice(6); if (file) map.set(file, map.get(file) || new Set()); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file) { const s = +m[1], n = m[2] === undefined ? 1 : +m[2]; for (let k = 0; k < n; k++) map.get(file).add(s + k); }
  }
  for (const f of git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)) map.set(f, null); // null: every line
  return map;
};

export function scan({ repo = ".", base = null, files = [], changedOnly = false }) {
  const root = realpathSync(repo);
  const targets = new Map();
  if (base) for (const [f, set] of gitLines(root, base)) targets.set(f, set);
  for (const f of files) targets.set(f, null);
  const candidates = [];
  const skipped = [];
  for (const [f, set] of [...targets].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (SKIP.test(f)) { skipped.push({ path: f, reason: "lockfile, documentation or binary by name" }); continue; }
    let text;
    try {
      const real = realpathSync(join(root, f));
      if (!(real.startsWith(root + sep)) || !statSync(real).isFile()) throw new Error("outside");
      if (statSync(real).size > 2 << 20) { skipped.push({ path: f, reason: "larger than 2 MiB" }); continue; }
      text = readFileSync(real, "utf8");
    } catch { skipped.push({ path: f, reason: "deleted or unreadable" }); continue; }
    for (const c of scanText(f, text, set)) if (!changedOnly || c.changed_line) candidates.push(c);
  }
  return { version: 1, kind: "concurrency-candidates", base, files: [...targets.keys()].sort(), skipped, candidates, limits: LIMITS };
}

const main = () => {
  const args = process.argv.slice(2);
  const o = { repo: ".", base: null, files: [], changedOnly: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--repo" || a === "--base") { if (i + 1 >= args.length) { console.error(`${a} needs a value`); process.exit(2); } o[a.slice(2)] = args[++i]; }
    else if (a === "--changed-only") o.changedOnly = true;
    else if (a.startsWith("--")) { console.error(`unknown option ${a}`); process.exit(2); }
    else o.files.push(a);
  }
  if (!o.base && !o.files.length) { console.error("usage: find-shared-state.mjs [--repo DIR] [--base REF] [--changed-only] [FILE...]"); process.exit(2); }
  try { process.stdout.write(JSON.stringify(scan(o), null, 2) + "\n"); }
  catch (e) { console.error(`${basename(process.argv[1])}: ${e.message.split("\n")[0]}`); process.exit(2); }
};
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
