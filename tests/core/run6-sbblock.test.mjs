// @ts-check
// Stage 6 (A215): the block-only test of a task file (status-block-test.sh): a tracked task file differs from HEAD by exactly the task's own first status block,
// nothing else. The shell functions sb_strip and sb_block_only are gone; the worktree cleanup and deliver-merged use sbBlockOnly of the core.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { archiveRun, leaveFolder, sbBlockOnly, tarSpec } from '../../control-plane/agents/scripts/core/runend.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { gOk } from './run6-lib.mjs';

const blk = (/** @type {string} */ id, /** @type {string} */ stage, extra = '') => `\n## Proofline Status\n\n<!-- PROOFLINE-STATUS:BEGIN:${id} -->\n- run: ${id}\n- stage: ${stage}\n${extra}<!-- PROOFLINE-STATUS:END:${id} -->\n`;

test('block-only: exactly the task\'s own first block, nothing else', () => {
  const bo = tempDir('bo-');
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

test('A263 tarSpec: off Windows the absolute file and the working folder as before; on win32 a relative name in the archive folder (no drive colon for tar)', () => {
  const cases = [['/p/.agents/local/archive/LC/LC-1.tar.gz', '/work'], ['/var/folders/ab/T/x y/.agents/local/archive/LC/LC-2.tar.gz', '/'], ['rel/LC-3.tar.gz', '.']];
  for (const platform of ['linux', 'darwin', 'freebsd']) for (const [file, cwd] of cases) assert.deepEqual(tarSpec(file, cwd, platform), { file, cwd }, `${platform} ${file}`);
  assert.deepEqual(tarSpec('C:\\Users\\r\\Temp\\p1/.agents/local/archive/LC/LC-1.tar.gz', 'D:/w', 'win32'), { file: 'LC-1.tar.gz', cwd: 'C:\\Users\\r\\Temp\\p1/.agents/local/archive/LC' });
  assert.deepEqual(tarSpec('C:/a/b/LC-1.tar.gz', 'D:/w', 'win32'), { file: 'LC-1.tar.gz', cwd: 'C:/a/b' });
});

test('A263 leaveFolder: off Windows never moves; on win32 it moves to the main tree only when the current directory is the worktree or inside it', () => {
  const calls = /** @type {string[]} */ ([]);
  const go = (/** @type {string} */ platform, /** @type {string} */ here) => { calls.length = 0; const r = leaveFolder('C:/T/p/.agents/local/worktrees/LC', 'C:/T/p', platform, () => here, (x) => { calls.push(x); }); return [r, calls.slice()]; };
  for (const pl of ['linux', 'darwin', 'freebsd']) assert.deepEqual(go(pl, 'C:/T/p/.agents/local/worktrees/LC'), [false, []], pl);
  assert.deepEqual(go('win32', 'C:/T/p/.agents/local/worktrees/LC'), [true, ['C:/T/p']]);
  assert.deepEqual(go('win32', 'c:\\t\\P\\.agents\\local\\worktrees\\LC\\sub\\deeper'), [true, ['C:/T/p']]);
  assert.deepEqual(go('win32', 'C:/T/p'), [false, []], 'the main tree itself');
  assert.deepEqual(go('win32', 'C:/T/p/.agents/local/worktrees/LC2'), [false, []], 'a sibling with the same prefix');
  assert.deepEqual(go('win32', 'D:/T/p/.agents/local/worktrees/LC'), [false, []], 'another drive');
  assert.equal(leaveFolder('C:/x', 'C:/y', 'win32', () => 'C:/x', () => { throw new Error('busy'); }), false, 'a failing chdir is not an error');
});

test('A263 archiveRun: a run folder whose name starts with "-" is archived as a member, not read as an option of tar (the name follows `--`)', () => {
  const main = tempDir('ar-');
  const runs = `${main}/runs`;
  mkdirSync(`${runs}/-rf`, { recursive: true });
  writeFileSync(`${runs}/-rf/RUN.yaml`, 'task:\n  id: LC\n');
  const ctx = /** @type {any} */ ({ cwd: main, config: () => ({ get: (/** @type {string} */ _k, /** @type {string} */ d) => d }), sharedMain: () => main, childEnv: () => cleanEnv(), out: () => {} });
  archiveRun(ctx, 'LC', `${runs}/-rf`);
  const dir = `${main}/.agents/local/archive/LC`;
  const names = readdirSync(dir);
  assert.equal(names.length, 1, names.join(','));
  const r = spawnSync('tar', ['-tzf', names[0]], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stdout, /^-rf\/RUN\.yaml$/m, `${r.stdout}${r.stderr}`);
});
