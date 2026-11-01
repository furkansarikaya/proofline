// @ts-check
// Records tests/golden/approvals/grammar.json from the OLD engine (the shell functions of agent.sh): the approval phrase allowlist (default and
// from a config), the fillers, the kind words, the full approval sentences of every kind, and the normal form of a set of replies.
//   node tests/golden/approvals/record.mjs
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFunctions } from '../../core/helpers.mjs';

export const KINDS = ['plan', 'destructive', 'single_step', 'scope', 'budget', 'mutation_budget', 'tree', 'commit', 'push', 'pr', 'merge', 'cleanup', 'report', 'batch', 'commands', 'rename', 'known-issue', 'scale', 'delivery',
  'waive:REVIEW_SMALL-1', 'rule:R-7', 'reopen:LC', 'rationale:Card-Flip', 'bogus'];
export const RUNS = ['', '-', 'LC'];
export const REPLIES = ["Approve the plan!", "I'm approving it", 'it’s ok', '  A,B;;C  ', 'plan\tapproved\r\n', 'Onaylıyorum: planı', 'ÇALIŞMA ağacını onaylıyorum', 'go-ahead single_step', 'a `b` {c} [d] ~e | f ^g \\h', '', ' ', 'x\ny'];

/** @param {string} body @param {string[]} args */
function sh(body, args = []) {
  const fns = Buffer.from(extractFunctions(['approval_phrases', 'approval_fillers', 'approval_sentences', 'approval_norm', 'approval_norm_lines', 'kind_words']), 'latin1').toString('utf8');
  const r = spawnSync('sh', ['-c', `cfg() { printf '%s\\n' "$2"; }\n${fns}\n${body}`, 'x', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', LC_ALL: 'C' } });
  if (r.status !== 0) throw new Error(`shell failed: ${r.stderr}`);
  return r.stdout;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const g = {
    phrases: sh('approval_phrases'),
    fillers: sh('approval_fillers'),
    kindWords: Object.fromEntries(KINDS.map((k) => [k, sh('kind_words "$1"', [k])])),
    sentences: Object.fromEntries(KINDS.flatMap((k) => RUNS.map((r) => [`${k}|${r}`, sh('approval_sentences "$1" "$2" | approval_norm_lines', [k, r])]))),
    norm: REPLIES.map((t) => sh('printf "%s\\n" "$1" | approval_norm', [t])),
  };
  writeFileSync(path.join(import.meta.dirname, 'grammar.json'), `${JSON.stringify(g, null, 1)}\n`);
}
