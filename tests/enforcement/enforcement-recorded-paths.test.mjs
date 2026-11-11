// @ts-check
// Absolute Node tests for the enforcement scenarios database_guard (hook half), owned_paths, skill_detour (A193), rtk_bypass (A194) and link_writes:
// the recorded corpora (tests/enforcement/recorded/) replayed against the Node hook. The verdicts and the reason texts are literals recorded once from the shell hook.
import { tempDir } from '../lib/tempdir.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../core/legacy-lib.mjs';
import { repo } from '../core/helpers.mjs';
import { corpus, replay } from './recorded.mjs';
import { fixtureRecipe } from './recorded-fixture.mjs';

const base = tempDir('enf-rec-');
after(() => rmSync(base, { recursive: true, force: true }));

/** @param {string} recipe */
const fresh = (recipe = fixtureRecipe()) => project(recipe);

test('database_guard (DB-1 .. DB-35, DB-42 .. DB-45): the database, migration and client commands are refused, in a run and without one', async () => {
  const dir = fresh();
  mkdirSync(join(dir, 'data'), { recursive: true }); writeFileSync(join(dir, 'data/app.db'), '');
  writeFileSync(join(base, 'drop.sql'), 'ALTER TABLE books DROP COLUMN legacy_notes;\n');
  const keep = join(base, 'ACTIVE_RUN.keep');
  await replay({
    steps: corpus('database_guard'), dir, base,
    mutations: {
      37: () => renameSync(join(dir, '.agents/local/ACTIVE_RUN'), keep),
      41: () => {
        renameSync(keep, join(dir, '.agents/local/ACTIVE_RUN'));
        const cfg = join(dir, '.agents/config.yaml');
        writeFileSync(cfg, readFileSync(cfg, 'utf8').split('\n').map((l) => (l.startsWith('  paths:') ? '  paths: "*.store"' : l)).join('\n'));
      },
    },
  });
});

test('owned_paths (L1, P1, P2): a role writes only the paths it owns; the designer window opens at SubagentStart and closes at SubagentStop', async () => {
  const dir = fresh();
  cpSync(join(repo, 'control-plane/agents/owns.conf'), join(dir, '.agents/owns.conf'));
  await replay({
    steps: corpus('owned_paths'), dir, base,
    mutations: { 20: () => { mkdirSync(join(dir, 'docs/design'), { recursive: true }); writeFileSync(join(dir, 'docs/design/DESIGN.md'), '# Design\n'); } },
    after: {
      18: () => assert.ok(existsSync(join(dir, '.agents/local/windows/d1')) && readFileSync(join(dir, '.agents/local/windows/d1'), 'utf8').length > 0, 'SubagentStart did not open the designer window'),
      21: () => {
        assert.ok(!existsSync(join(dir, '.agents/local/windows/d1')), 'the designer window is still open');
        const evid = join(dir, '.agents/runs/LC/worker-evidence');
        const w = readdirSync(evid).filter((n) => n.startsWith('WINDOW-')).map((n) => readFileSync(join(evid, n), 'utf8'));
        assert.ok(w.some((t) => t.includes('role: "designer"')), 'SubagentStop did not close the designer window (WINDOW role designer)');
      },
    },
  });
});

test('skill_detour (A193): a proofline skill is redirected to its file; a message that gives up at the Skill error is sent back once', async () => {
  const dir = fresh();
  for (const s of ['proofline-lead', 'tdd-proof']) { mkdirSync(join(base, 'plug/skills', s), { recursive: true }); writeFileSync(join(base, 'plug/skills', s, 'SKILL.md'), ''); }
  mkdirSync(join(dir, '.agents/skills/qa-plan'), { recursive: true }); writeFileSync(join(dir, '.agents/skills/qa-plan/SKILL.md'), '');
  mkdirSync(join(base, 'home/.claude/skills/tdd-proof'), { recursive: true });
  const steps = corpus('skill_detour');
  Object.assign(steps[7], { label: 'A193 a message that gives up at the Skill error is sent back with the file to read', sub: 'proofline-lead/SKILL.md' });
  Object.assign(steps[8], { label: 'A193 the retry (stop_hook_active) is not blocked again' });
  Object.assign(steps[9], { label: 'A193 an ordinary message is not blocked' });
  assert.deepEqual(steps.slice(7).map((s) => s.verdict), ['block', 'allow', 'allow']);
  await replay({ steps, dir, base });
});

test('rtk_bypass (A194): evidence commands run with the rtk bypass when rtk is there and wired', async () => {
  const dir = fresh();
  mkdirSync(join(base, 'fakebin'), { recursive: true }); mkdirSync(join(base, 'rtkhome/.claude'), { recursive: true });
  writeFileSync(join(base, 'fakebin/rtk'), '#!/bin/sh\nexit 0\n'); chmodSync(join(base, 'fakebin/rtk'), 0o755);
  const settings = join(base, 'rtkhome/.claude/settings.json');
  writeFileSync(settings, '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"rtk hook claude"}]}]}}\n');
  await replay({ steps: corpus('rtk_bypass'), dir, base, mutations: { 9: () => rmSync(settings, { force: true }) } });
});

