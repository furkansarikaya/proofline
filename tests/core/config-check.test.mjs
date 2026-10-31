// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { configLines } from '../../control-plane/agents/scripts/core/config.mjs';
import { checkConfigLines } from '../../control-plane/agents/scripts/core/commands/config-check.mjs';

const base = 'canonical_branch: main\ngit:\n  branch_prefix: t/\n';
/** @param {string} extra */
const check = (extra) => checkConfigLines(configLines(base + extra));

describe('checkConfigLines', () => {
  test('a minimal config is valid', () => { assert.deepEqual(check(''), { messages: [], ambiguous: false }); });
  test('required keys', () => {
    assert.deepEqual(checkConfigLines(configLines('git:\n  branch_prefix: t/\n')).messages, ['missing key: canonical_branch']);
    assert.deepEqual(checkConfigLines(configLines('')).messages, ['missing key: canonical_branch', 'missing key: git.branch_prefix']);
  });
  test('enumerations, numbers and ranges', () => {
    assert.deepEqual(check('profile: wrong\n').messages, ['invalid value for profile: wrong (want max|balanced|economy)']);
    assert.deepEqual(check('review:\n  max_fix_rounds: x\n').messages, ['invalid number for review.max_fix_rounds: x']);
    assert.deepEqual(check('timeouts:\n  scale: 11\n').messages, ['timeouts.scale must be a number from 0.5 to 10: 11']);
    assert.deepEqual(check('hook:\n  stop_timeout_seconds: 5\n').messages, ['hook.stop_timeout_seconds must be 10 to 600']);
    assert.deepEqual(check('batch:\n  ci_wait_minutes: 0\n').messages, ['batch.ci_wait_minutes must be at least 1']);
    assert.deepEqual(check('unknown_top:\n  a: 1\n').messages, ['unknown top-level key: unknown_top', 'unknown top-level key: unknown_top']);
  });
  test('block lists under commands.*: duplicates, empty items, maps, a value next to a list, inline lists', () => {
    assert.deepEqual(check('commands:\n  build:\n    - a\n    - a\n').messages, ['duplicate command in the commands.build list: a']);
    assert.deepEqual(check('commands:\n  build:\n    - ""\n').messages, ['empty command in the commands.build list (item 1)']);
    assert.deepEqual(check('commands:\n  deploy:\n    - y\n').messages, ['commands.deploy takes one command, not a list: commands.deploy.0']);
    assert.deepEqual(check('commands:\n  test: [a, b]\n').messages, ['commands.test is an inline list; write a block list (one `- command` line per command): [a, b]']);
    assert.deepEqual(check('commands:\n  lint: x\n  lint2:\n').messages, []);
  });
  test('the hook prompt limit against the approval budget', () => {
    assert.deepEqual(check('hook:\n  prompt_timeout_seconds: 10\n').messages, ['hook.prompt_timeout_seconds (10) must be at least hook.approve_budget_seconds + 5 (25)']);
  });
  test('design surfaces', () => {
    assert.deepEqual(check('design_docs:\n  design:\n    surfaces:\n      web:\n        doc: d.md\n').messages, ['design surface web has no paths (design_docs.design.surfaces.web.paths)']);
    assert.deepEqual(check('design_docs:\n  design:\n    shared: ok.md\n').messages, ['design_docs.design.shared needs design_docs.design.surfaces']);
  });
  test('risk signals', () => {
    assert.deepEqual(check('risk:\n  sig:\n    paths: a\n').messages, ['risk signal sig has patterns but no check']);
  });
  test('more than one message out of one awk array loop is ambiguous (the order is awk\'s)', () => {
    const r = check('risk:\n  a:\n    paths: x\n  b:\n    paths: y\n');
    assert.equal(r.messages.length, 2);
    assert.equal(r.ambiguous, true);
    assert.equal(check('risk:\n  a:\n    paths: x\n').ambiguous, false);
  });
});
