// @ts-check
// The user's answers to the pre-flight questions (A200, A225): the forms the parser reads. The shell code stripped a leading "option" or "answer" with a GNU-only
// sed alternation, so on macOS "Q1 option b" was never an answer; the Node code reads it the same on every platform.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AB, batchApprove, bnew, binstall, fakes, put, summaryOf } from './batch-lib.mjs';

const body = (/** @type {string} */ ctx) => `## Goal\n\nIt works.\n\n## Context\n\n${ctx}\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n`;

test('an answer written as "Q1 option b" or "Q2: answer a" is read the same on every platform', () => {
  const F = fakes(); const dir = bnew();
  let paths = ''; for (let i = 1; i <= 18; i++) paths += ` \`src/m${i}.js\``;
  put(`${dir}/.agents/tasks/P-1.md`, `# Task: P-1 — wide task\n\n${body(`Changes${paths}. This adds a new dependency on a library.`)}\n## Suggested class\n\nCOMPLEX because it touches many modules\n`);
  binstall(dir, { remote: false });
  assert.equal(AB(F, dir, ['batch-plan', 'P-1']).status, 0);
  assert.ok(summaryOf(dir).includes('[P-1, split]') && summaryOf(dir).includes('[P-1, dep]'));
  batchApprove(dir);
  put(`${dir}/.agents/local/prompts/history/${Math.floor(Date.now() / 1000) + 10}-eeee5555.txt`, 'Q1 option b\nQ2: answer a\n');
  const r = AB(F, dir, ['batch-answer']);
  assert.equal(r.status, 0, r.text);
  const ans = AB(F, dir, ['batch-answers', 'P-1']).out;
  assert.match(ans, /Q1 P-1 split: option b \(up to 27\)/);
  assert.match(ans, /Q2 P-1 dep: option a/);
});
