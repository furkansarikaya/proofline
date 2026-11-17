// @ts-check
// A293: the review roles (qa, reviewer, security_reviewer, verifier, explorer) never push and never create a branch or a tag. A past review agent pushed from the wrong
// directory and created `Main` on origin. This drives the real PreToolUse hook with every spelling of cases (tests/hook/readonly-git-cases.mjs): the push forms, the
// branch and tag creators, the aliases, the platform tools. Each refused row is refused by this rule (the text names A293) for every review role, with a run open, with
// none, and in a project without proofline; each allowed row is a read-only form a review role really uses. Every other role gets the verdict it always had:
// no refusal of any other role names A293. The hook only judges the command text; nothing is executed. No clock is read.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { buildTemplate, copyProject, rmSync, nodeHook, cleanEnv } from './harness.mjs';
import { CASES, ROLES } from './readonly-git-cases.mjs';

const hookDir = dirname(nodeHook);
const { buildContext, finish } = await import(pathToFileURL(join(hookDir, 'lib/context.mjs')).href);
const { handle } = await import(pathToFileURL(join(hookDir, 'events/pretool.mjs')).href);

let template = '';
let base = '';
let dir = '';
let noRun = '';
let bare = '';
before(() => {
  template = buildTemplate();
  base = tempDir('hook-rogit-');
  dir = copyProject(template, base);
  noRun = copyProject(template, base);
  rmSync(join(noRun, '.agents/local/ACTIVE_RUN'), { force: true });
  bare = join(base, 'bare');
  mkdirSync(bare);
});
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** @param {string} where @param {string} command @param {Record<string, string>} who @returns {Promise<string | null>} the refusal text, or null when allowed */
async function pre(where, command, who) {
  const raw = Buffer.from(JSON.stringify({ cwd: where, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who }));
  const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: where, TMPDIR: '/var/proofline-roletgt-tmp' }));
  assert.ok(c, 'no hook context');
  try {
    const out = await handle(c);
    if (typeof out !== 'string' || out === '') return null;
    return /** @type {string} */ (JSON.parse(out).hookSpecificOutput.permissionDecisionReason);
  } finally { finish(c); }
}
/** @param {string} type */
const sub = (type) => ({ agent_type: type, agent_id: 'f1' });

for (const [role, type] of ROLES) {
  test(`${role}: every push, branch and tag spelling is refused by the review-role rule; the read-only forms are not (A293)`, async () => {
    const wrong = [];
    for (const [label, command, verdict] of CASES) {
      const r = await pre(dir, command, sub(type));
      const hit = r !== null && r.includes('A293');
      if (verdict === 'deny' && !hit) wrong.push(`${label}: ${JSON.stringify(command)} -> ${r === null ? 'allowed' : `refused by another rule: ${r.slice(0, 80)}`}`);
      if (verdict === 'allow' && hit) wrong.push(`${label}: ${JSON.stringify(command)} -> refused by the review-role rule: ${r}`);
    }
    assert.deepEqual(wrong, []);
  });
}

test('the rule holds with no run open and in a project without proofline (the merge guard is not run-scoped either)', async () => {
  const wrong = [];
  for (const where of [noRun, bare]) {
    for (const [label, command, verdict] of CASES) {
      if (verdict !== 'deny') continue;
      const r = await pre(where, command, sub('proofline-reviewer'));
      if (r === null || !r.includes('A293')) wrong.push(`${where === noRun ? 'no run' : 'not installed'}: ${label}: ${JSON.stringify(command)} -> ${r === null ? 'allowed' : r.slice(0, 80)}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('a headless review specialist (AGENT_ROLE in the environment, no agent_type) is bound by the same rule', async () => {
  const wrong = [];
  for (const [label, command, verdict] of CASES) {
    const raw = Buffer.from(JSON.stringify({ cwd: dir, session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }));
    const c = await buildContext('pretool', 'claude', raw, cleanEnv({ CLAUDE_PROJECT_DIR: dir, TMPDIR: '/var/proofline-roletgt-tmp', AGENT_ROLE: 'security_reviewer' }));
    let r = null;
    try { const out = await handle(c); r = typeof out === 'string' && out !== '' ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : null; } finally { finish(c); }
    if (verdict === 'deny' && !(r ?? '').includes('A293')) wrong.push(`${label}: ${JSON.stringify(command)}`);
  }
  assert.deepEqual(wrong, []);
});

// One test per role (A304): the six roles x 487 rows ran as one test of ~6 s (7.2 s of a 10 s budget on a slow runner); each role is ~1 s, the same rows and the same assertion.
/** @type {Array<[string, Record<string, string>]>} */
const OTHERS = [['lead', {}], ['implementer', sub('proofline-implementer')], ['designer', sub('proofline-designer')], ['architect', sub('proofline-architect')], ['data_architect', sub('proofline-data-architect')], ['task_author', sub('proofline-task-author')]];
for (const [role, who] of OTHERS) {
  test(`no other role is touched: the ${role} gets no A293 refusal for any row`, async () => {
    for (const [label, command] of CASES) {
      const r = await pre(dir, command, who);
      assert.ok(r === null || !r.includes('A293'), `${role}: ${label}: ${JSON.stringify(command)} -> ${r}`);
    }
  });
}

// A327: the run-owned evidence worktree of the role texts: every role that may make one may also remove it with `git worktree remove --force`; the other way to remove it (rm) stays refused.
for (const [role, type] of ROLES.filter(([r]) => r !== 'explorer')) {
  test(`${role}: adds and removes its run-owned evidence worktree $TMPDIR/verify-<ID> with git; rm of it stays refused (A327)`, async () => {
    assert.equal(await pre(dir, 'git worktree add --detach "$TMPDIR/verify-T-1" HEAD', sub(type)), null);
    assert.equal(await pre(dir, 'git worktree remove --force "$TMPDIR/verify-T-1"', sub(type)), null);
    const rm = await pre(dir, 'rm -rf "$TMPDIR/verify-T-1"', sub(type));
    assert.ok(rm !== null, 'rm of an evidence worktree must stay refused');
  });
}

test('the runtime guard and the git pre-push name the same roles', async () => {
  const guard = await import(pathToFileURL(join(hookDir, 'guards/readonly-git.mjs')).href);
  const core = await import(pathToFileURL(join(nodeHook, '../../../../control-plane/agents/scripts/core/githooks.mjs')).href);
  assert.deepEqual([...guard.NO_PUSH_ROLES].sort(), [...core.NO_PUSH_ROLES].sort());
  assert.deepEqual(ROLES.map(([r]) => r).sort(), [...core.NO_PUSH_ROLES].sort(), 'the cases drive every one of the roles');
});
