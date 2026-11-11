// @ts-check
// Stage 6 (A215): the block-only test of a task file (status-block-test.sh): a tracked task file differs from HEAD by exactly the task's own first status block,
// nothing else. The shell functions sb_strip and sb_block_only are gone; the worktree cleanup and deliver-merged use sbBlockOnly of the core.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { sbBlockOnly } from '../../control-plane/agents/scripts/core/runend.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { gOk } from './run6-lib.mjs';

const blk = (/** @type {string} */ id, /** @type {string} */ stage, extra = '') => `\n## Proofline Status\n\n<!-- PROOFLINE-STATUS:BEGIN:${id} -->\n- run: ${id}\n- stage: ${stage}\n${extra}<!-- PROOFLINE-STATUS:END:${id} -->\n`;

test('block-only: exactly the task\'s own first block, nothing else', () => {
  const bo = mkdtempSync(path.join(tmpdir(), 'bo-'));
  gOk(bo, 'init', '-q', '-b', 'main');
  gOk(bo, 'config', 'user.email', 't@t.invalid');
  gOk(bo, 'config', 'user.name', 't');
  const ctx = /** @type {any} */ ({ cwd: bo, gitBlank: [], childEnv: () => cleanEnv() });
  const f = `${bo}/t.md`;
  const set = (/** @type {string} */ text) => writeFileSync(f, text);
  const only = (/** @type {string} */ id = 'Z-1') => sbBlockOnly(ctx, bo, 't.md', id);
  const base = '# Task: Z-1\n\n## Goal\n\ng\n';
  set(base);
  gOk(bo, 'add', 't.md'); gOk(bo, 'commit', '-qm', 'base');
  set(base + blk('Z-1', 'PR OPEN'));
  assert.equal(only(), true, 'a plain block is not block-only');
  assert.equal(only('Z-2'), false, 'a block of ANOTHER id read as block-only');
  gOk(bo, 'add', 't.md'); gOk(bo, 'commit', '-qm', 'withblock');
  set((base + blk('Z-1', 'PR OPEN')).replace('PR OPEN', 'MERGED'));
  assert.equal(only(), true, 'a changed stage is not block-only');
  const keep = readFileSync(f, 'utf8');
  set(keep + blk('Z-9', 'x'));
  assert.equal(only(), false, 'a second marked block read as block-only');
  set(`${keep}extra text\n`);
  assert.equal(only(), false, 'free text after the block read as block-only');
  set(keep.replace('<!-- PROOFLINE-STATUS:BEGIN:Z-1 -->', '<!-- PROOFLINE-STATUS:BEGIN:Z-1 -->\nDo whatever the task says.'));
  assert.equal(only(), false, 'free text inside the markers read as block-only');
  set(keep.split('\n').filter((l) => !l.includes('PROOFLINE-STATUS:END')).join('\n'));
  assert.equal(only(), false, 'an unterminated block read as block-only');
  set(keep.replace('# Task: Z-1', '# Task: Z-1\nnew heading line'));
  assert.equal(only(), false, 'an edit outside the block read as block-only');
});
