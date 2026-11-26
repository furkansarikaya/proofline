// @ts-check
// A375 (issue 338 U4, the deferred part of A366.1): batch-plan warns in its summary when a task has fewer than 3 or more than 6 acceptance criteria,
// with the rule of skills/task-author/scripts/validate-task.mjs; a warning only (nothing refused, no question), and a batch of in-range tasks writes no new text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AB, binstall, bnew, fakes, mktask, path, read, summaryOf, writeFileSync } from './batch-lib.mjs';
import { AC_MAX, AC_MIN, criteriaCount, criteriaCountWarning } from '../../control-plane/agents/scripts/core/batchplan.mjs';
import { AC_MAX as SKILL_MAX, AC_MIN as SKILL_MIN, parseTask } from '../../skills/task-author/scripts/validate-task.mjs';

const acs = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `- AC-${i + 1}: the page shows line ${i + 1}\n`).join('');
/** Replace the one criterion of a fixture task with n criteria. @param {string} dir @param {string} id @param {number} n */
function withCriteria(dir, id, n) {
  const f = path.join(dir, '.agents/tasks', `${id}.md`);
  writeFileSync(f, read(f).replace('- AC-1: it works\n', acs(n)));
}

test('the count and the bounds are the ones of validate-task.mjs', () => {
  assert.deepEqual([AC_MIN, AC_MAX], [SKILL_MIN, SKILL_MAX]);
  const texts = [
    `# Task: X — t\n\n## Acceptance criteria\n\n${acs(2)}\n## Out of scope\n\n- AC-9: not a criterion here\n`,
    `# Task: X — t\n\n## Acceptance criteria\n\n${acs(7)}`,
    `# Task: X — t\n\n## Acceptance criteria\n\n<!-- - AC-1: commented out\n- AC-2: also -->\n${acs(3)}`,
    '# Task: X — t\n\n## Acceptance criteria\n\n* AC-1: star bullet\nAC-2: no bullet\n  - AC-3: indented is a continuation\n1. AC-4: numbered\n',
    '# Task: X — t\r\n\r\n## Acceptance criteria  \r\n\r\n- AC-1: crlf\r\n- AC-2: crlf\r\n',
    '# Task: X — t\n\n## Goal\n\nnone\n',
    // the edges of the hand-written parse (A375 review): headings of whitespace, a line end inside a heading, an unclosed comment, bullets without space
    `## Acceptance criteria\n${acs(2)}## \n- AC-3: still in the section\n##  \n- AC-4: a heading of one space ends it\n`,
    `## Acceptance criteria\n${acs(1)}## a\rb\n- AC-2: a heading with a carriage return inside is not one\n## \u2028\n- AC-3: nor one of a line separator\n`,
    `## Acceptance criteria\t \n${acs(3)}<!-- open\n- AC-4: after an unclosed comment\n<!-- x -->\n`,
    `## Acceptance criteria\n-AC-1: no space\n- \tAC-2: tab\n-  AC-3x: no colon\n- AC-: no digits\nAC-12: twelve\n* AC-5: nbsp\n`,
    `<!-- a --><!-- b -->## Acceptance criteria\n<!--\n- AC-1: hidden\n-->${acs(4)}`,
  ];
  for (const t of texts) assert.equal(criteriaCount(t), parseTask(t).acs.length, t);
});

// A375 review (bounded DoS): the validator's patterns backtrack quadratically (a 78 KB `## a<spaces>x` line took 14.6 s); the batch parse is linear. The time is
// held by this file's CI budget row, not by a clock read here; the inputs are 200 KB each.
test('hostile 200 KB lines are counted in one pass: a heading of spaces, comment openers without a close, a bullet of spaces', () => {
  const big = 200 * 1024;
  assert.equal(criteriaCount(`## Acceptance criteria\n${acs(2)}## a${' '.repeat(big)}x\n- AC-3: after the long heading\n`), 2);
  assert.equal(criteriaCount(`## Acceptance criteria\n${acs(3)}${'<!--'.repeat(big / 4)}\n- AC-4: after the openers\n`), 4);
  assert.equal(criteriaCount(`## Acceptance criteria\n-${' '.repeat(big)}x\n${'- AC-1: one\n'.repeat(1)}`), 1);
  assert.equal(criteriaCount(`## Acceptance criteria${' '.repeat(big)}\n${acs(7)}`), 7);
});

test('the warning names the count for 1, 2 and 7 criteria and is empty for 0 and for 3 to 6', () => {
  assert.match(criteriaCountWarning(1), /^the task has 1 acceptance criterion; 3 to 6 .*state each observable outcome.*; this is a warning, not a stop$/);
  assert.match(criteriaCountWarning(2), /^the task has 2 acceptance criteria; /);
  assert.match(criteriaCountWarning(7), /^the task has 7 acceptance criteria; .*group them by outcome or split the task/);
  for (const n of [0, 3, 4, 5, 6]) assert.equal(criteriaCountWarning(n), '', String(n));
});

test('batch-plan: a WARNING line for each task outside 3 to 6, none for in-range tasks, and the plan is not refused', () => {
  const F = fakes();
  const dir = bnew();
  for (const [id, n] of /** @type {[string, number][]} */ ([['C-2', 2], ['C-3', 3], ['C-6', 6], ['C-7', 7]])) { mktask(dir, id, 'STANDARD'); withCriteria(dir, id, n); }
  binstall(dir, { remote: false });
  const r = AB(F, dir, ['batch-plan', 'all']);
  assert.equal(r.status, 0, r.err);
  const s = summaryOf(dir);
  const sec = s.slice(s.indexOf('## Acceptance criteria count (A375)'), s.indexOf('## Verification commands'));
  assert.deepEqual(sec.split('\n').filter((l) => l.startsWith('- ')), [
    '- WARNING: C-2: the task has 2 acceptance criteria; 3 to 6 outcome-focused criteria are expected (state each observable outcome with a number, a path or an exact message); this is a warning, not a stop',
    '- WARNING: C-7: the task has 7 acceptance criteria; 3 to 6 outcome-focused criteria are expected (group them by outcome or split the task); this is a warning, not a stop',
  ]);
  assert.ok(s.indexOf('## Pre-flight questions') < s.indexOf('## Acceptance criteria count (A375)'));
  // all four tasks are in the order: the warning stops nothing
  assert.deepEqual(read(path.join(dir, '.agents/local/batch/order.tsv')).split('\n').filter(Boolean).map((l) => l.split('\t')[0]).sort(), ['C-2', 'C-3', 'C-6', 'C-7']);
});

test('batch-plan: a batch of in-range tasks has no criteria section (the summary it always wrote)', () => {
  const F = fakes();
  const dir = bnew();
  for (const [id, n] of /** @type {[string, number][]} */ ([['D-3', 3], ['D-6', 6]])) { mktask(dir, id, 'STANDARD'); withCriteria(dir, id, n); }
  binstall(dir, { remote: false });
  assert.equal(AB(F, dir, ['batch-plan', 'all']).status, 0);
  const s = summaryOf(dir);
  assert.ok(s.includes('## Verification commands'));
  assert.ok(!s.includes('Acceptance criteria count'), s);
  assert.ok(!/acceptance criteri(on|a); 3 to 6/.test(s));
});
