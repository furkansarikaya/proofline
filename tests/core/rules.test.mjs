// @ts-check
// `agent.sh rules list|report|tally` (A229, the former scripts/rules.sh and rules-test.sh; tests/legacy-port-map.tsv names the rows): the project rules budget
// proposes, the user decides. Duplicates are found, a contradiction is raised as a question, unused rules are counted from review records, and nothing ever
// changes AGENTS.md. Absolute expectations; the real control plane in a throwaway project.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { newProject } from './helper-lib.mjs';
import { A, accepted, refused } from './legacy-lib.mjs';

const AGENTS = `# Project

<!-- proofline:begin -->
## Project rules

- this block is proofline's and is never counted
<!-- proofline:end -->

## Project rules

- Always validate the request body before calling the repository layer.
- Validate the request body before calling the repository layer, always.
- Never use raw SQL strings in handlers.
- Always use raw SQL strings in handlers for reports.
- Name test files after the unit they cover. (lesson lc-0a1b2c3d)
  A second line of the same rule.

## Other

- not a rule of the section
`;
const R = (/** @type {string} */ d, /** @type {string[]} */ args, /** @type {{ role?: string, env?: Record<string, string> }} */ o = {}) => A(d, ['rules', ...args], o);
const md5 = (/** @type {string} */ f) => createHash('sha256').update(readFileSync(f)).digest('hex');
function withRules() { const d = newProject(); writeFileSync(`${d}/AGENTS.md`, AGENTS); return d; }
/** A run with a review gate record whose result cites TEXT. */
function reviewed(/** @type {string} */ d, /** @type {string} */ run, /** @type {string} */ text) {
  mkdirSync(`${d}/.agents/runs/${run}/gates`, { recursive: true }); mkdirSync(`${d}/.agents/runs/${run}/results`, { recursive: true });
  writeFileSync(`${d}/.agents/runs/${run}/gates/001-REVIEW_SMALL.yaml`, `task_id: "${run}"\ngate: "REVIEW_SMALL"\nresult: "pass"\nfocus: "rules+tests"\n`);
  writeFileSync(`${d}/.agents/runs/${run}/results/001-review.result.md`, `${text}\n`);
}

test('list reads the Project rules section only, keeps lesson ids, joins continuation lines and gives the others r-<cksum of the lower-cased text> ids', () => {
  const d = withRules();
  assert.equal(R(d, ['list']).out, [
    'r-d4ee26a3\t69\tAlways validate the request body before calling the repository layer.',
    'r-e8f1f9cd\t70\tValidate the request body before calling the repository layer, always.',
    'r-2e342d64\t38\tNever use raw SQL strings in handlers.',
    'r-2abdb73c\t51\tAlways use raw SQL strings in handlers for reports.',
    'lc-0a1b2c3d\t95\tName test files after the unit they cover. (lesson lc-0a1b2c3d) A second line of the same rule.',
    '',
  ].join('\n'));
});

test('report proposes merging duplicate rules and raises a contradiction as a question; no removal before enough reviews; the budget is shown', () => {
  const d = withRules();
  const r = accepted(R(d, ['report']), 'report');
  assert.equal(r.out, [
    'project rules: 5 rule(s), 323 bytes, budget 4000 bytes (within)',
    '  merge: r-d4ee26a3 and r-e8f1f9cd repeat each other (100% of their words are shared): "Always validate the request body before calling the repository layer." / "Validate the request body before calling the repository layer, always."',
    '  ask the user: r-2e342d64 says "Never use raw SQL strings in handlers." but r-2abdb73c says "Always use raw SQL strings in handlers for reports."; which one holds?',
    '  usage: 0 reviewed run(s) counted, a rule is proposed for removal only after 10',
    '  nothing is changed: a rule is merged, answered or removed only after your own message approves that exact change',
    '',
  ].join('\n'));
  const over = R(d, ['report'], { env: { RULES_BUDGET_BYTES: '50' } }).out;
  assert.match(over, /^project rules: 5 rule\(s\), 323 bytes, budget 50 bytes \(OVER\)\n {2}the rules are over their budget: merge the repeats, settle the contradictions, drop what no review used\n/);
  // the budget comes from the config when no environment value is given
  writeFileSync(`${d}/.agents/config.yaml`, readFileSync(`${d}/.agents/config.yaml`, 'utf8').replace(/^ {2}budget_bytes: .*$/m, '  budget_bytes: 100'));
  assert.match(R(d, ['report']).out, /budget 100 bytes \(OVER\)/);
});

test('a rule no review record cites is proposed for removal after enough reviews; cited rules and lesson ids cited by id are not', () => {
  const d = withRules();
  for (let i = 1; i <= 10; i++) reviewed(d, `RV${i}`, 'Checked: Never use raw SQL strings in handlers. Also: Always validate the request body before calling the repository layer. (lc-0a1b2c3d)');
  const out = R(d, ['report']).out;
  assert.ok(out.includes('  remove: r-2abdb73c was cited by none of the 10 reviewed runs counted: "Always use raw SQL strings in handlers for reports."'), out);
  assert.ok(out.includes('  remove: r-e8f1f9cd was cited by none of the 10 reviewed runs counted'), out);
  assert.ok(!out.includes('remove: r-2e342d64'), 'a cited rule was proposed for removal');
  assert.ok(!out.includes('remove: r-d4ee26a3'), 'a cited rule was proposed for removal');
  assert.ok(!out.includes('remove: lc-0a1b2c3d'), 'a lesson cited by its id was proposed for removal');
  assert.ok(!out.includes('  usage:'));
});

test('the tally keeps the counts after the run documents are gone and counts a run once; only the lead tallies', () => {
  const d = withRules();
  for (let i = 1; i <= 10; i++) reviewed(d, `RV${i}`, 'Checked: Never use raw SQL strings in handlers.');
  refused(R(d, ['tally'], { role: 'reviewer' }), 'a reviewer tallied', 'command denied for reviewer');
  assert.equal(R(d, ['tally']).out, 'rule-use counter: 10 reviewed run(s) counted\n');
  const tsv = readFileSync(`${d}/.agents/local/rule-use.tsv`, 'utf8');
  assert.equal(tsv.split('\n').filter((l) => l.endsWith('\t-')).length, 10);
  assert.ok(tsv.includes('RV1\tr-2e342d64\n'));
  for (let i = 1; i <= 10; i++) rmSync(`${d}/.agents/runs/RV${i}`, { recursive: true });
  assert.match(R(d, ['report']).out, /remove: r-d4ee26a3 was cited by none of the 10 reviewed runs counted/);
  assert.equal(R(d, ['tally']).out, 'rule-use counter: 10 reviewed run(s) counted\n');
  assert.equal(readFileSync(`${d}/.agents/local/rule-use.tsv`, 'utf8'), tsv, 'a run is counted once');
});

test('nothing changes AGENTS.md: list, report and tally never write it, and there is no operation that edits or deletes a rule', () => {
  const d = withRules();
  const sum = md5(`${d}/AGENTS.md`);
  R(d, ['list']); R(d, ['report']); R(d, ['tally']);
  const apply = R(d, ['apply']);
  assert.equal(apply.status, 2);
  assert.equal(apply.err, 'usage: agent.sh rules <list|report|tally>   (there is no operation that changes a rule)\n');
  assert.equal(R(d, ['remove', 'lc-0a1b2c3d']).status, 2);
  assert.equal(R(d, ['edit']).status, 2);
  assert.equal(md5(`${d}/AGENTS.md`), sum);
});

test('a project without rules, or without AGENTS.md, reports none', () => {
  const d = withRules();
  writeFileSync(`${d}/AGENTS.md`, '# Project\n');
  assert.equal(R(d, ['report']).out, 'project rules: none\n');
  rmSync(`${d}/AGENTS.md`);
  assert.equal(R(d, ['report']).out, 'project rules: none\n');
  assert.equal(R(d, ['list']).out, '');
});

test('output budget: a proposal quotes a rule at most 90 characters, so a long rule never makes a long line', () => {
  const d = newProject();
  const long = `Always validate ${'the request body before calling the repository layer '.repeat(6)}`.trim();
  writeFileSync(`${d}/AGENTS.md`, `# P\n\n## Project rules\n\n- ${long}.\n- ${long}, always.\n`);
  const out = R(d, ['report']).out;
  const merge = out.split('\n').find((l) => l.startsWith('  merge:')) ?? '';
  assert.ok(merge.includes('..." / "') && merge.length < 300, merge);
  assert.equal(out.split("\n").length, 5);
});
