// @ts-check
// The trace recorder: it records the calls a script makes to agent.sh (argv, cwd, environment seams, stdin, content-addressed snapshot), changes
// nothing about them, is read by no product file, and a recorded call replays as a rig case.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { baseEnv, copyTree, installedFixture, repoRoot, snapshot } from './fixture.mjs';
import { formatDiffs, runCase } from './rig.mjs';
import { installTraceShim, loadTrace, restoreSnapshot, traceCase } from './trace.mjs';

const SCRIPT = 'sh ./.agents/scripts/agent.sh role; printf "stdin-bytes" | sh ./.agents/scripts/agent.sh config-get profile; AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh tm-scaled 9 1 100';

test('records each call the test makes (not nested ones) and passes it on unchanged', () => {
  const traceDir = mkdtempSync(join(tmpdir(), 'eq-trace-out.')); const work = mkdtempSync(join(tmpdir(), 'eq-trace-fx.'));
  copyTree(installedFixture().dir, work);
  const { bin, env } = installTraceShim(traceDir);
  const run = (/** @type {Record<string,string>} */ e) => spawnSync('sh', ['-c', SCRIPT], { cwd: work, env: { ...baseEnv(work), ...e }, encoding: 'utf8' });
  const plain = run({}); const traced = run(env);
  assert.equal(traced.stdout, plain.stdout); assert.equal(traced.stderr, plain.stderr); assert.equal(traced.status, plain.status);
  assert.equal(traced.stdout, 'role=lead\nbalanced\n9\n');
  const calls = loadTrace(traceDir);
  assert.equal(calls.length, 3, 'three calls made by the script; agent.sh own child shells are not recorded');
  assert.deepEqual(calls[1].argv, ['./.agents/scripts/agent.sh', 'config-get', 'profile']);
  assert.equal(Buffer.from(calls[1].stdinBase64, 'base64').toString(), 'stdin-bytes');
  assert.equal(calls[2].seams.AGENT_ROLE, 'reviewer'); assert.equal(calls[0].seams.AGENT_ROLE, undefined);
  assert.ok(!('PROOFLINE_TRACE' in calls[0].seams), 'the recorder\'s own variable is not part of the seams');
  assert.equal(calls[0].cwdRel, '');
  assert.ok(calls[0].manifest.some((e) => e.p === '.agents/config.yaml' && e.sha && readFileSync(join(traceDir, 'objects', e.sha)).length > 0));
  assert.ok(readdirSync(join(traceDir, 'objects')).length > 10);
  // the snapshot rebuilds the project tree byte for byte, modes included (the tree is the one the first call saw)
  const dest = mkdtempSync(join(tmpdir(), 'eq-trace-restore.')); restoreSnapshot(traceDir, calls[0], dest);
  const want = snapshot(installedFixture().dir); const got = snapshot(dest);
  for (const [p, e] of want) { if (p.startsWith('.agents/local/')) continue; const g = got.get(p); assert.ok(g, p); assert.equal(g.mode, e.mode, p); assert.ok(g.data.equals(e.data), p); }
  // a recorded call replays as a rig case
  const d = runCase(traceCase(traceDir, calls[1])); assert.equal(d.length, 0, formatDiffs(d));
  for (const d of [traceDir, work, dest, bin]) rmSync(d, { recursive: true, force: true });
});

test('PROOFLINE_TRACE is not a seam: no product file reads it', () => {
  const r = spawnSync('grep', ['-rIl', '-e', 'PROOFLINE_TRACE', join(repoRoot, 'control-plane'), join(repoRoot, 'adapters'), join(repoRoot, 'bin'), join(repoRoot, 'skills')], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '', 'a product file mentions PROOFLINE_TRACE');
});
