// @ts-check
// C8b and C8d of issue 338 (A363): the status block's secret check no longer refuses an honest block, and the `pr-opened` update is sent once.
// Reproduced first: the check matched `sk-` case-insensitively with no left boundary, so the `SK-` inside the branch `task/TASK-010-fix-the-thing`
// refused the block of every task with a slug in its branch (23 of 23 and 114 of 114 refusals in two retros).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { refusedBlock } from '../../control-plane/agents/scripts/core/adapters/lib.mjs';
import { A, project } from '../lib/harness.mjs';

describe('C8b the status block check', () => {
  test('an honest block passes, also with TASK-ids and long slugs in it', () => {
    const honest = [
      '- run: TASK-010', '- branch: task/TASK-010-fix-the-thing', '- branch: proofline/RISK-12345678-rework-the-deck', '- start_commit: 5cd54f0a1b2c', '- updated: 2026-11-26T02:29:03Z',
      '- session: 0a1b2c3d-1111-4222-8333-444455556666', '- pr: #8 https://github.com/o/r/pull/8', '- tokens: 3310000', '- look_at: a [path] and the DISK-USAGE-REPORT-FOR-THIS-RUN',
    ].join('\n');
    assert.equal(refusedBlock(honest), false);
    for (const line of honest.split('\n')) assert.equal(refusedBlock(line), false, line);
  });
  test('a secret, a path, an address or a personal address is still refused', () => {
    const bad = [
      '- k: sk-abcdefghijklmnop', '- k: (sk-abcdefghijklmnop)', '- k: ghp_abcdefghij1234567890', '- k: github_pat_abcdefghij12345', '- k: AKIAABCDEFGHIJKLMNOP', '- k: xoxb-123456-abcdef', '- k: AIzaabcdefghijklmnopqrstuvwx',
      '- k: eyJhbGciOiJIUzI1NiJ9.x', '- k: sk_live_abcdef123456', '- k: key_ghp_abcdefghij1234567890', '- note: password: hunter2', '- note: TOKEN=abc', '- note: Authorization: x', '- p: /Users/me/notes.txt', '- p: C:\\Users\\me',
      '- p: ~/notes', '- ip: 10.1.2.3', '- ip: fe80:1:2:3:4', '- mail: a.b@example.com', '- url: https://u:pw@host/x', '-----BEGIN PRIVATE KEY-----',
    ];
    for (const b of bad) assert.equal(refusedBlock(b), true, b);
  });
});

describe('C8d the pr-opened block is sent once', () => {
  before(() => { project({ topology: 'standalone' }); });
  /** @param {string} d */
  const open = (d) => { rmSync(path.join(d, '.agents/task-integrations/markdown.sh'), { force: true }); return path.join(d, 'tasks/LC.md'); };

  test('a repeat of the same pr-opened update leaves the block alone and a changed state is sent', () => {
    const d = project({ topology: 'standalone' });
    const f = open(d);
    const r = A(d, ['status-block', 'LC', 'pr-opened', '12']);
    assert.equal(r.status, 0, r.text);
    assert.ok(readFileSync(f, 'utf8').includes('- pr: #12'));
    assert.ok(!existsSync(path.join(d, '.agents/local/status-block.log')), 'nothing was refused');
    // the block is changed by hand; the same event with the same state is not sent again
    writeFileSync(f, readFileSync(f, 'utf8').replace('- pr: #12', '- pr: #12 HAND-EDIT'));
    assert.equal(A(d, ['status-block', 'LC', 'pr-opened', '12']).status, 0);
    assert.ok(readFileSync(f, 'utf8').includes('HAND-EDIT'), 'the identical update was sent again');
    // another state (a number the block did not carry) is an update
    assert.equal(A(d, ['status-block', 'LC', 'pr-opened', '13']).status, 0);
    assert.ok(readFileSync(f, 'utf8').includes('- pr: #13') && !readFileSync(f, 'utf8').includes('HAND-EDIT'));
    // other events are never held back
    writeFileSync(f, readFileSync(f, 'utf8').replace('- pr: #13', '- pr: #13 HAND-EDIT'));
    assert.equal(A(d, ['status-block', 'LC', 'merged', '13']).status, 0);
    assert.ok(!readFileSync(f, 'utf8').includes('HAND-EDIT'));
  });

  test('the same refusal of the same event is logged once, not once per attempt', () => {
    const d = project({ topology: 'standalone' });   // the shared fixture carries a markdown stub that fails: every update is a refusal
    for (let i = 0; i < 3; i++) assert.equal(A(d, ['status-block', 'LC', 'pr-opened', '12']).status, 0);
    const log = readFileSync(path.join(d, '.agents/local/status-block.log'), 'utf8').split('\n').filter((l) => l !== '');
    assert.equal(log.length, 1, log.join('\n'));
    assert.equal(A(d, ['status-block', 'LC', 'merged', '12']).status, 0);
    assert.equal(readFileSync(path.join(d, '.agents/local/status-block.log'), 'utf8').split('\n').filter((l) => l !== '').length, 2);
  });
});
