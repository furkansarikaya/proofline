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
  ];
  for (const t of texts) assert.equal(criteriaCount(t), parseTask(t).acs.length, t);
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
