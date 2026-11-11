// @ts-check
// Counts the calls a PreToolUse hook refused in Claude Code transcripts (.jsonl) and classifies each by cause (A257, issue #181 item 1). The cause is read from the text of the
// refusal alone, so the same command works on a transcript of any proofline version: an old text lands in the same cause as its new wording. Aggregate numbers only; no command
// text or path is kept. Usage: node tests/bench/refusal-causes.mjs <transcript.jsonl | folder> [...]   (a folder is searched for *.jsonl, subfolders included)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** [cause, family of the issue, pattern of the refusal text]; the first match wins. */
export const CAUSES = /** @type {const} */ ([
  ['unresolved-write', 'shell-write', /which cannot be resolved/],
  ['tmpdir-scratch', 'tmpdir-scratch', /Scratch files go under|scratch files and worktrees go under|mktemp would create|is outside the project\./],
  ['dispatch-nonce', 'dispatch-nonce', /dispatch nonce|PROOFLINE_DISPATCH is set/],
  ['node-control-plane', 'node-control-plane', /starts Node on the control plane|runs node only on a script path|sets NODE_OPTIONS/],
  ['agent-command-by-role', 'agent-command', /runs only the read-only agent\.sh|the implementer runs only agent\.sh|worker-evidence runs only as the implementer|a subagent never approves/],
  ['command-word-not-literal', 'agent-command', /is not allowed while run \S+ is active; write agent\.sh|subcommand '[^']*' is not literal/],
  ['write-outside-role-paths', 'shell-write', /outside the paths role|is written only by agent\.sh|the lead writes only run artifacts|the command writes '[^']*':/],
  ['git-live-tree', 'git', /git (stash|checkout|must not change)/],
  ['database-file', 'database', /database file/],
]);

const DENIED = /^PreToolUse:[A-Za-z0-9_]+ hook error/;

/** @param {string} text the text of a tool result @returns {string | null} the cause, or null when the result is no refusal */
export function classify(text) {
  if (!DENIED.test(text)) return null;
  for (const [cause, , re] of CAUSES) if (re.test(text)) return cause;
  return 'other';
}

/** @param {unknown} content the `content` of a tool_result block */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('');
}

/** @typedef {{ calls: number, refused: number, causes: Record<string, number>, families: Record<string, number> }} Counts */

/** Count the calls (a tool_use counted once by id) and the refused ones (a tool_result counted once by tool_use_id) of transcript texts. @param {Iterable<string>} texts one per file @returns {Counts} */
export function count(texts) {
  /** @type {Counts} */ const out = { calls: 0, refused: 0, causes: {}, families: {} };
  const family = new Map(CAUSES.map(([c, f]) => [c, f]));
  for (const text of texts) {
    const seen = new Set(); const answered = new Set();
    for (const line of text.split('\n')) {
      if (line === '') continue;
      /** @type {any} */ let e;
      try { e = JSON.parse(line); } catch { continue; }
      const c = e?.message?.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === 'tool_use' && typeof b.id === 'string' && !seen.has(b.id)) { seen.add(b.id); out.calls++; }
        if (b?.type === 'tool_result' && !answered.has(b.tool_use_id)) {
          answered.add(b.tool_use_id);
          const cause = classify(textOf(b.content));
          if (cause === null) continue;
          out.refused++;
          out.causes[cause] = (out.causes[cause] ?? 0) + 1;
          const fam = family.get(/** @type {any} */ (cause)) ?? 'other';
          out.families[fam] = (out.families[fam] ?? 0) + 1;
        }
      }
    }
  }
  return out;
}

/** @param {string} p @returns {string[]} */
function files(p) {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p).sort().flatMap((n) => (n.endsWith('.jsonl') || statSync(join(p, n)).isDirectory() ? files(join(p, n)) : []));
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) { process.stderr.write('usage: node tests/bench/refusal-causes.mjs <transcript.jsonl | folder> [...]\n'); process.exit(2); }
  const all = paths.flatMap(files);
  function* texts() { for (const f of all) yield readFileSync(f, 'utf8'); }
  const r = count(texts());
  const sorted = (/** @type {Record<string, number>} */ o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  process.stdout.write(`${JSON.stringify({ files: all.length, calls: r.calls, refused: r.refused, causes: sorted(r.causes), families: sorted(r.families) }, null, 2)}\n`);
}
