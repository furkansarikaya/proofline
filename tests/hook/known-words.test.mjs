// @ts-check
// A278 (round 2, R4): KNOWN_WORDS (guards/kit.mjs) is the list of program names that are read in any case on a volume that folds case. It is kept by hand, so this test is its drift guard: every program name that
// a guard or the scanner tables know must be in it, or in the exempt list below with a reason. A new program name in a table fails here until it is listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repo } from './harness.mjs';
import { KNOWN_WORDS } from '../../adapters/claude/hooks/guards/kit.mjs';
import { WRITE_PROGRAMS } from '../../adapters/claude/hooks/command-scan.mjs';
import { ROLE_PROGRAMS } from '../../adapters/claude/hooks/guards/rolewrites.mjs';

const hooks = join(repo, 'adapters/claude/hooks');
const src = (/** @type {string} */ f) => readFileSync(join(hooks, f), 'utf8');

/** Names a table holds that are not programs a model starts by name, or that need no fold; every entry has its reason. @type {Record<string, string>} */
const KEYWORDS = ['.', 'do', 'elif', 'else', 'if', 'then', 'for', 'while', 'until', 'declare', 'export', 'local', 'mapfile', 'readarray', 'read', 'readonly', 'typeset'];
const EXEMPT = {
  ...Object.fromEntries(KEYWORDS.map((k) => [k, 'a shell keyword or builtin: the shell resolves it by its exact spelling, never as a file'])),
  netstat: 'a process-search word the process guard matches inside a pipeline; the search is what is refused',
  ss: 'the same', pstree: 'the same', jps: 'the same', fdfind: 'an alias of fd, in the same positions as fd',
  pull: 'a git subcommand in a list of verbs, not a program', reset: 'a git subcommand', clean: 'a git subcommand', restore: 'a git subcommand', switch: 'a git subcommand',
};

/** Every quoted lower-case word of the array literals of six or more words in a source text. @param {string} text */
function wordLists(text) {
  /** @type {string[]} */ const out = [];
  for (const m of text.matchAll(/\[('[a-z0-9.+_-]+'(?:, '[a-z0-9.+_-]+'){5,})\]/g)) out.push(...(m[1] ?? '').split(', ').map((w) => w.slice(1, -1)));
  return out;
}

test('A278 R4: every program name the guards and the scanner know is read in any case (KNOWN_WORDS) or exempt with a reason', () => {
  const names = new Set([...WRITE_PROGRAMS, ...ROLE_PROGRAMS, ...wordLists(src('guards/kill.mjs')), ...wordLists(src('guards/rolewrites.mjs')), ...wordLists(src('guards/merge.mjs')), ...wordLists(src('command-scan.mjs'))]);
  for (const w of (/const NET_TOOLS = new Set\(\[([^\]]*)\]/.exec(src('guards/merge.mjs'))?.[1] ?? '').matchAll(/'([^']+)'/g)) names.add(/** @type {string} */ (w[1]));
  for (const w of (/const RO_W = '([^']*)'/.exec(src('guards/stash.mjs'))?.[1] ?? '').split('|')) names.add(w);
  const missing = [...names].filter((n) => n !== '' && !n.startsWith('-') && !KNOWN_WORDS.has(n) && !(n in EXEMPT)).sort();
  assert.deepEqual(missing, [], 'program names the guards know that a folding volume does not read in any case: add them to KNOWN_WORDS in guards/kit.mjs (or to the exempt list of this test with a reason)');
  assert.ok(names.size > 60, `the tables were read (${names.size} names)`);
});
