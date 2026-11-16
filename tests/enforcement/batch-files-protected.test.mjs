// The batch files the cover trusts are not writable by a model (A303, A143): .agents/local/batch/order.tsv and SUMMARY.md (the file the user's approval is bound to) are refused
// by the runtime hook to the lead and to the worker roles, through the file tools and through Bash. batch-cover rests on this and on the hash binding of SUMMARY.md.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const hook = join(repo, 'adapters/claude/hooks/proofline-hook.mjs');
const root = tempDir('proofline-batchfiles-');
let template = '';
let project = '';

const env = () => {
  const e = { ...process.env, PROOFLINE_NO_TTY: '1' };
  for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'PROOFLINE_JSON', 'AGENT_ROLE', 'PROOFLINE_ENGINE', 'PROOFLINE_ENGINE_SH']) delete e[k];
  return e;
};
/** @param {string} tool @param {Record<string, string>} input @param {string} [agent] */
function decide(tool, input, agent) {
  /** @type {Record<string, any>} */ const payload = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: project, tool_name: tool, tool_input: input };
  if (agent) { payload.agent_type = agent; payload.agent_id = 'a1'; }
  const r = spawnSync(process.execPath, [hook, 'pretool', 'claude'], { cwd: project, input: JSON.stringify(payload), env: env(), encoding: 'utf8', timeout: 120000 });
  let d = 'allow';
  try { if (JSON.parse(r.stdout || '{}').hookSpecificOutput?.permissionDecision === 'deny') d = 'deny'; } catch { /* no output: allowed */ }
  return { d, out: `${r.stdout}${r.stderr}` };
}

before(() => {
  template = join(root, 'template');
  mkdirSync(template);
  const g = (/** @type {string[]} */ ...a) => spawnSync('git', a, { cwd: template, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  const r = spawnSync(join(repo, 'bin/proofline'), ['init'], { cwd: template, env: env(), encoding: 'utf8', timeout: 300000 });
  assert.equal(r.status, 0, `proofline init failed: ${r.stdout}${r.stderr}`);
  project = join(root, 'p');
  cpSync(template, project, { recursive: true });
  mkdirSync(join(project, '.agents/runs/LC'), { recursive: true });
  mkdirSync(join(project, '.agents/local/batch'), { recursive: true });
  writeFileSync(join(project, '.agents/local/ACTIVE_RUN'), 'LC\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

const ROLES = [undefined, 'proofline-implementer', 'proofline-reviewer'];
/** The two verdicts of the path guard for runtime state under .agents/local/ (role-bound writers, and the lead). */
const STATE_VERDICT = ['is written only by agent.sh and the runtime hooks', 'is runtime state (approvals, prompts, windows, records)'];
const FILES = ['order.tsv', 'SUMMARY.md'];

for (const f of FILES) {
  for (const agent of ROLES) {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      test(`${tool} on .agents/local/batch/${f} is denied (${agent ?? 'lead'})`, () => {
        for (const p of [`.agents/local/batch/${f}`, join(project, `.agents/local/batch/${f}`)]) {
          const r = decide(tool, { file_path: p }, agent);
          assert.equal(r.d, 'deny', `${tool} ${p}`);
          // the verdict of the .agents/local/ entry of the path guard itself (paths.mjs), not of another guard that would also refuse
          assert.ok(STATE_VERDICT.some((m) => r.out.includes(m)), `${tool} ${p}: denied by another guard: ${r.out}`);
        }
      });
    }
    test(`Bash writes to .agents/local/batch/${f} are denied (${agent ?? 'lead'})`, () => {
      for (const c of [`echo "LC\tSTANDARD\t-" >> .agents/local/batch/${f}`, `printf x > .agents/local/batch/${f}`, `cp /dev/null .agents/local/batch/${f}`, `rm .agents/local/batch/${f}`]) {
        assert.equal(decide('Bash', { command: c }, agent).d, 'deny', c);
      }
    });
  }
}

test('the denial names the state-file guard (written only by agent.sh and the runtime hooks), and a path outside .agents/local is not refused by it', () => {
  const r = decide('Write', { file_path: '.agents/local/batch/order.tsv' });
  assert.equal(r.d, 'deny');
  assert.ok(r.out.includes('is written only by agent.sh and the runtime hooks'), r.out);
  assert.ok(!decide('Write', { file_path: 'src/app.txt' }, 'proofline-implementer').out.includes('is written only by agent.sh and the runtime hooks'));
});
