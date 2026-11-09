// @ts-check
// The Codex sandbox check (codex-sandbox.mjs) needs the Codex CLI and is not CI; what CI covers without it: the script's no-Codex behaviour, and the
// permission profile `dispatch.sh codex-profile` prints (the facts the real sandbox probe relies on: which record paths are writable, which are read-only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { project, scripts } from '../lib/harness.mjs';
import { profileArgs } from './codex-sandbox.mjs';

test('without the Codex CLI the script says so and exits 0', () => {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'codex-sandbox.mjs')], { encoding: 'utf8', env: { PATH: mkdtempSync(path.join(tmpdir(), 'no-codex-')), HOME: '/nonexistent' } });   // node by absolute path; its own folder may hold a codex
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'codex-sandbox: the Codex CLI is not installed; nothing checked\n');
});

test('the worker profile: own record paths writable; windows, approvals, prompts and batch are not granted; .agents is read-only', () => {
  const d = project({ cls: 'STANDARD' });
  copyFileSync(path.join(scripts, 'dispatch.sh'), path.join(d, '.agents/scripts/dispatch.sh'));
  const args = profileArgs(d);
  assert.deepEqual(args.filter((a) => a === '-c').length, args.length / 2, 'argument pairs: -c <setting>');
  const text = args.join('\n');
  assert.match(text, /default_permissions="proofline-worker"/);
  assert.match(text, /permissions\.proofline-worker\.extends=":workspace"/);
  const fs = /filesystem=\{":workspace_roots"=\{(.*)\}\}/.exec(text)?.[1] ?? '';
  /** @type {Record<string, string>} */ const grants = {};
  for (const m of fs.matchAll(/"([^"]+)"="(read|write)"/g)) grants[m[1]] = m[2];
  assert.equal(grants['.agents'], 'read', 'the rest of .agents is read-only');
  for (const w of ['.agents/runs/LC', '.agents/local/locks', '.agents/local/submissions']) assert.equal(grants[w], 'write', `${w} is the worker's own path`);
  for (const r of ['.agents/runs/LC/approvals', '.agents/runs/LC/waivers']) assert.equal(grants[r], 'read', `${r} is read-only`);
  for (const p of Object.keys(grants)) assert.ok(!/windows|\/approvals$/.test(p) || grants[p] === 'read', `${p} must not be writable`);
  for (const denied of ['.agents/local/windows', '.agents/local/approvals', '.agents/local/prompts', '.agents/local/batch']) assert.notEqual(grants[denied], 'write', `${denied} is never granted write`);
});
