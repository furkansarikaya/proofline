// @ts-check
// The SessionStart text (A230): the hook fills the template file lib/session-head.txt. A missing or empty file (an old install, a partial upgrade) must not blank the
// message: the same text is embedded in the hook, so the output is byte-identical with and without the file.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildTemplate, cleanEnv, repo } from './harness.mjs';

const base = tempDir('hook-head-');
const tpl = buildTemplate({ run: false });
after(() => { rmSync(base, { recursive: true, force: true }); rmSync(tpl, { recursive: true, force: true }); });

/** The SessionStart output of a copy of the hook tree; EDIT changes the copy first. @param {(hooks: string) => void} edit */
let n = 0;
function head(edit) {
  const hooks = mkdtempSync(join(base, 'h-'));
  cpSync(join(repo, 'adapters/claude/hooks'), hooks, { recursive: true });
  edit(hooks);
  const r = spawnSync(process.execPath, [join(hooks, 'proofline-hook.mjs'), 'session', 'claude'], {
    cwd: tpl, env: cleanEnv({ CLAUDE_PROJECT_DIR: tpl }), input: JSON.stringify({ cwd: tpl, session_id: `s${++n}` }), encoding: 'utf8', timeout: 60000,
  });
  return r.stdout;
}

test('a missing or empty session-head.txt gives the same SessionStart message as the file', () => {
  const normal = head(() => {});
  assert.match(normal, /proofline installed; you are the lead; use the proofline-lead skill \(.*\) \(never through the Skill tool: proofline skills are not model-invocable\); active run: none; next step: no active run: start one with the proofline-lead skill/);
  assert.equal(head((h) => rmSync(join(h, 'lib/session-head.txt'))), normal);
  assert.equal(head((h) => writeFileSync(join(h, 'lib/session-head.txt'), '')), normal);
});

test('the embedded text equals the file', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(repo, 'adapters/claude/hooks/events/session.mjs'), 'utf8');
  const m = /const HEAD_TEMPLATE = "(.*)";\n/.exec(src);
  assert.equal(m?.[1], readFileSync(join(repo, 'adapters/claude/hooks/lib/session-head.txt'), 'utf8'));
});
