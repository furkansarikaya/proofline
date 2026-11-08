// The `node-tests` job is a matrix of parallel legs (user order 2026-11-02: cut the long tests), and so is `invariants`. These tests read .github/workflows/ci.yml:
// every test file the old globs matched is in exactly one leg (no file lost), the
// job names `checks` waits for stay stable, and nothing reads the fast-mode output. They live here, not in fast-mode.test.mjs (a change there forces the
// full legacy suite on the pull request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
/** @param {string} name */
const jobText = (name) => (new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:\\n|^  #|(?![\\s\\S]))`, 'm').exec(ci) ?? [])[1] ?? '';
const nt = jobText('node-tests');
/** @type {{ name: string, mode: string, pattern: string, files: string[] }[]} */
const legs = [...nt.matchAll(/^ {10}- name: (\S+)\n {12}mode: (\S+)\n {12}pattern: '(.*)'\n {12}files: (.+)$/gm)]
  .map((m) => ({ name: m[1], mode: m[2], pattern: m[3], files: m[4].trim().split(/\s+/) }));

test('node-tests is a matrix of legs on both Node versions, with unique names', () => {
  assert.ok(legs.length >= 10, `${legs.length} legs`);
  assert.equal(new Set(legs.map((l) => l.name)).size, legs.length);
  assert.match(nt, /node: \['22\.13\.0', 'lts\/\*'\]/);
  assert.match(nt, /name: node-tests \(\$\{\{ matrix\.node \}\}, \$\{\{ matrix\.leg\.name \}\}\)/);
  assert.ok(!/outputs\.fast|needs\.changes/.test(nt), 'never skipped by fast mode');
  assert.match(ci.slice(ci.indexOf('\n  checks:')), /needs: \[[^\]]*\bnode-tests\b[^\]]*\binvariants\b|needs: \[[^\]]*\binvariants\b[^\]]*\bnode-tests\b/, 'checks needs both matrix jobs by their stable names');
});

test('every test file the old globs matched (tests/ci, tests/enforcement, tests/core, tests/invariants-node, tests/lib) is in a leg, none is lost', () => {
  /** @type {string[]} */ const all = [];
  for (const d of ['ci', 'enforcement', 'core', 'invariants-node', 'lib']) for (const f of readdirSync(join(repo, 'tests', d))) if (f.endsWith('.test.mjs')) all.push(`tests/${d}/${f}`);
  assert.ok(all.length > 30);
  const where = new Map(all.map((f) => [f, /** @type {typeof legs} */ ([])]));
  /** A leg names files or globs of one directory (tests/<dir>/*.test.mjs); a glob picks up a new test file without a CI edit. @param {string} f */
  const expand = (f) => (f.includes('*') ? readdirSync(join(repo, dirname(f))).filter((x) => x.endsWith('.test.mjs')).map((x) => `${dirname(f)}/${x}`) : [f]);
  for (const l of legs) if (l.mode !== 'full') for (const g of l.files) for (const f of expand(g)) { assert.ok(where.has(f), `${l.name}: ${f} is not a test file the old globs matched`); where.get(f)?.push(l); }
  for (const [f, ls] of where) {
    assert.ok(ls.length >= 1, `${f} is in no leg`);
    if (ls.length > 1) assert.ok(ls.every((l) => l.mode === 'name' || l.mode === 'skip'), `${f} is in ${ls.length} legs that are not split by test name`);
  }
});

test('the split legs use the node test-name flags and the other legs name files only', () => {
  assert.match(nt, /run: node --test "--test-name-pattern=\$PATTERN" \$\{\{ matrix\.leg\.files \}\}/);
  assert.match(nt, /run: node --test "--test-skip-pattern=\$PATTERN" \$\{\{ matrix\.leg\.files \}\}/);
  assert.match(nt, /run: node --test \$\{\{ matrix\.leg\.files \}\}/);
  assert.ok(!/node --test tests\/[a-z]+\/(\s|$)/m.test(nt), 'no bare directory');
  assert.match(nt, /name: every test file in one process[^\n]*\n\s+if: matrix\.leg\.mode == 'full' && \(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\)/);
});

test('invariants is a matrix of its scenarios; the non-scenario checks run in the first leg; the stable job name feeds checks', () => {
  const inv = jobText('invariants');
  const scen = [...readFileSync(join(repo, 'tests/invariants/invariants-test.sh'), 'utf8').matchAll(/^run_sc (sc_\S+)$/gm)].map((m) => m[1]);
  const inJob = [...inv.matchAll(/^ {10}- (sc_\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(inJob, scen, 'one leg per scenario of the suite, in order');
  assert.match(inv, /env:\n\s+LC_EXACT: \$\{\{ matrix\.scenario \}\}\n\s+run: sh tests\/invariants\/invariants-test\.sh/);
  assert.ok(!/check-changed|check-budget-changed|sh tests\/context/.test(inv), 'the change-reason checks are Node (tests/ci/change-reason.mjs), tested in tests/ci/change-reason.test.mjs');
  assert.match(inv, /name: invariant tests changed only with a reason\n\s+if: github\.event_name == 'pull_request' && matrix\.scenario == 'sc_inv1_code_done_needs_gates'\n[\s\S]*?run: node tests\/ci\/change-reason\.mjs invariants --base/);
  assert.match(inv, /name: context budget changed only with a reason \(A202\)\n\s+if: github\.event_name == 'pull_request' && matrix\.scenario == 'sc_inv1_code_done_needs_gates'\n[\s\S]*?run: node tests\/ci\/change-reason\.mjs context-budget --base/);
  assert.ok(!/outputs\.fast|needs\.changes/.test(inv));
});
