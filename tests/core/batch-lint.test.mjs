// @ts-check
// U9 (issue 338, R2-18; A366): an empty `commands.lint` is told in the batch summary (with the proposal of `doctor --commands`) and at the freeze of a batch task, as a WARNING;
// an explicit `commands.lint: none` is accepted. Never a refusal: no existing flow stops, and the batch approval stays the user's own (no new approval kind).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { A, AB, batchApprove, bnew, binstall, coverProject, fakes, mktask, put, summaryOf, gOk, verbs } from './batch-lib.mjs';
import { setCmd } from './helper-lib.mjs';

// the two recipe templates are built (cold, once per content hash) outside any test's duration
before(() => { bnew(); coverProject(); });

const plan = (/** @type {string} */ dir, /** @type {ReturnType<typeof fakes>} */ F) => {
  mktask(dir, 'L-1', 'COMPLEX'); gOk(dir, ['add', '-A']); gOk(dir, ['commit', '-qm', 'l1']);
  const p = AB(F, dir, ['batch-plan', 'L-1']);
  assert.equal(p.status, 0, p.text);
  return summaryOf(dir);
};

test('batch-plan: an empty lint with a proposal prints the line and a WARNING row; the proposal is the one doctor --commands proved', () => {
  const F = fakes(); const dir = bnew(); binstall(dir, { remote: false });
  put(`${dir}/.agents/local/commands/PROPOSAL.tsv`, 'test\tnpm test\nlint\tnpm run lint\n');
  const s = plan(dir, F);
  assert.match(s, /^- lint commands: <none set>; proposal: npm run lint$/m);
  assert.match(s, /^- WARNING: commands\.lint is empty and not declared none/m);
});

test('batch-plan: an empty lint without a proposal says so, still a WARNING and not a refusal', () => {
  const F = fakes(); const dir = bnew(); binstall(dir, { remote: false });
  const s = plan(dir, F);
  assert.match(s, /^- lint commands: <none set>; proposal: nothing discovered \(proofline doctor --commands\)$/m);
  assert.match(s, /^- WARNING: commands\.lint is empty/m);
});

test('batch-plan: an explicit none and a configured lint raise no WARNING', () => {
  const F = fakes(); const dir = bnew(); binstall(dir, { remote: false });
  setCmd(dir, 'lint', 'none');
  let s = plan(dir, F);
  assert.match(s, /^- lint commands: none \(declared in \.agents\/config\.yaml\)$/m);
  assert.ok(!/WARNING: commands\.lint/.test(s), s);
  setCmd(dir, 'lint', 'npm run lint');
  s = plan(dir, F);
  assert.ok(!/lint commands:/.test(s) && !/WARNING: commands\.lint/.test(s), 'a configured lint printed the lint line');
});

test('freeze of a batch task: empty lint warns on stderr; none and a configured lint do not; a run outside a batch is not touched', () => {
  const warn = /warning: commands\.lint is empty and not declared none/;
  /** @param {string} [lint] */
  const freezeOf = (lint) => {
    const F = fakes(); const dir = coverProject();
    if (lint !== undefined) setCmd(dir, 'lint', lint);
    assert.equal(AB(F, dir, ['batch-plan', 'all']).status, 0);
    batchApprove(dir);
    A(dir, ['request-approval', 'LC', 'plan']);
    assert.equal(AB(F, dir, ['batch-cover', 'LC', 'plan']).status, 0);
    return verbs(dir, 'A freeze LC');
  };
  const e = freezeOf(); assert.equal(e.status, 0, e.text); assert.match(e.text, warn);
  assert.ok(!warn.test(freezeOf('none').text), 'an explicit none warned');
  assert.ok(!warn.test(freezeOf('npm run lint').text), 'a configured lint warned');
});
