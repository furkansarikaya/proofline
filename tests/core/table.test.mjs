// @ts-check
// The command table (134 entries), the role gate and the locking rule against what the shell text of agent.sh said (recorded from it in tests/golden/shell-equivalence.json, A244; the case labels, the
// read-only list, the data copied from it, the verdict of every role on every command and the lock rule on every command and argument shape).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { COMMAND_NAMES, READ_ONLY_COMMANDS } from '../../control-plane/agents/scripts/core/commands/names.mjs';
import { HANDLERS } from '../../control-plane/agents/scripts/core/commands/moved.mjs';
import { DB_CLIENTS_DEFAULT, DB_MIGRATE_DEFAULT, DB_PATHS_DEFAULT, USAGE_LINES } from '../../control-plane/agents/scripts/core/commands/data.mjs';
import { takesLocks } from '../../control-plane/agents/scripts/core/lock.mjs';
import { commandAllowed, commandTable } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { shellListed } from './helpers.mjs';

const GOLD = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'golden', 'shell-equivalence.json'), 'utf8')).table;
const agentSh = readFileSync(path.join(import.meta.dirname, '../../control-plane/agents/scripts/agent.sh'), 'latin1');

const ROLES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];
const STAGE1 = ['role', 'config-get', 'config-check', 'timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled', 'db-config', 'hook-config', 'help'];
// stage 2, package TOOLS (appended block)
const STAGE2_TOOLS = ['debt', 'task-type', 'task-scope-entries', 'scope-covers', 'human-checks', 'questions', 'repro-normalize', 'design-surface', 'test-path', 'path-kind', 'scope-kinds'];
const MOVED = [...STAGE1, ...STAGE2_TOOLS];
// stage 4, package 4A: their agent.sh arms are deleted (A212)
const STAGE4A = ['baseline', 'discard-stray', 'branch', 'tier', 'classify', 'verify-assumptions', 'delivery-check', 'db-check', 'ask', 'status-block', 'tree-inspect', 'tree-accept', 'task-source-status', 'task-source-relocate'];
// stage 4, package 4B: their agent.sh arms and functions are deleted (A213)
const STAGE4B = ['start', 'freeze', 'refreeze', 'handoff', 'terminate', 'cleanup', 'amend', 'reopen'];
// stage 4, package 4C: their agent.sh arms and functions are deleted (A214)
const STAGE4C = ['worker-evidence', 'submit', 'record', 'gate', 'secret-scan', 'run-language', 'raise-budget', 'waive', 'knowledge-done', 'publish-completion-report', 'verify-completion-report'];
// stage 6: their agent.sh arms and functions are deleted (A215); ci-check and ci-task-command (stage 2) lose their dead arms with them
const STAGE6 = ['deliver-plan', 'deliver-step', 'deliver-merged', 'pr-state', 'task-source-done', 'platform', 'platform-warn', 'batch-ci', 'ci-check', 'ci-task-command'];
/** The locking rule of the stage 6 commands, written out (their shell text is gone): `platform`, `platform-warn`, `ci-check` and `ci-task-command` are read-only, `pr-state`, `batch-ci` and `deliver-merged ID --check` take no lock, the other four lock. @param {string} command @param {string} a3 @param {boolean} readOnly */
function STAGE6_LOCKS(command, a3, readOnly) {
  const explicit = /** @type {Record<string, boolean>} */ ({
    'deliver-plan': true, 'deliver-step': true, 'task-source-done': true, 'deliver-merged': a3 !== '--check',
    'pr-state': false, 'batch-ci': false, platform: false, 'platform-warn': false, 'ci-check': false, 'ci-task-command': false,
  });
  assert.ok(command in explicit, command);
  assert.equal(readOnly, ['platform', 'platform-warn', 'ci-check', 'ci-task-command'].includes(command), `${command} read-only`);
  return explicit[command];
}
// stage 7, package 172-B (A222): the known-issue commands; their agent.sh arms and functions are deleted
const STAGE172B = ['known-issue-propose', 'known-issue-apply', 'known-issue-list', 'known-issue-candidates'];
// stage 7, package C (A225): the worktree commands and night mode; their agent.sh arms and functions are deleted, batch.sh and worktree-prep.sh with them
const STAGE7C = ['worktree-add', 'worktree-path', 'worktree-remove', 'worktree-root', 'batch-plan', 'batch-cover', 'batch-status', 'batch-check', 'batch-answer', 'batch-answers', 'batch-next', 'batch-awake', 'batch-park'];
/** The locking rule of the stage 7 commands, written out (their shell text is gone): batch-status, batch-check, batch-next, batch-awake, batch-park take no lock (the shell rule line), worktree-root and batch-answers are read-only, the rest locks. */
function STAGE7C_LOCKS(command, readOnly) {
  const unlocked = ['batch-status', 'batch-check', 'batch-next', 'batch-awake', 'batch-park'];
  assert.equal(readOnly, ['worktree-root', 'batch-answers'].includes(command), `${command} read-only`);
  return !readOnly && !unlocked.includes(command);
}
// stage 7, package 172-D (A226): decide, ledger-note and metrics-dispatch; their agent.sh arms and functions are deleted
const STAGE172D = ['decide', 'ledger-note', 'metrics-dispatch'];
// stage 7, package 173-A (A229): the last commands that ran as shell code; their agent.sh arms and functions are deleted
const STAGE173A = ['friction', 'calibrate', 'build-record', 'lessons', 'rules', 'wait-line', 'task-rename-plan', 'task-rename-apply', 'test'];
// #181 (A235): the combined command of the diff orientation has no shell arm at all (born in the Node core)
const STAGE181 = ['diff-digest', 'advance'];
const NO_SHELL_ARM = ['next-user', ...STAGE181, ...STAGE4A, ...STAGE4B, ...STAGE4C, ...STAGE6, ...STAGE172B, ...STAGE7C, ...STAGE172D, ...STAGE173A];

describe('command table', () => {
  test('134 entries, each the label of a case of agent.sh as recorded, in its order', () => {
    assert.equal(commandTable().length, 134);
    assert.deepEqual(commandTable().map((e) => e.name), GOLD.commands);
    assert.deepEqual(COMMAND_NAMES, GOLD.commands);
  });
  test('the read-only list is the recorded shell list', () => {
    assert.deepEqual(READ_ONLY_COMMANDS, GOLD.readOnly);
    for (const c of READ_ONLY_COMMANDS) assert.ok(COMMAND_NAMES.includes(c), c);
  });
  test('the moved commands are the handlers AND the delegation list of the agent.sh preamble (the two lists are identical)', () => {
    const shell = shellListed(agentSh);
    const moved = COMMAND_NAMES.filter((c) => !shell.includes(c)).sort();
    assert.deepEqual(moved, Object.keys(HANDLERS).sort());
    assert.deepEqual(commandTable().filter((e) => e.moved).map((e) => e.name).sort(), moved);
    for (const c of MOVED) assert.ok(moved.includes(c), `stage 1 command ${c} stays moved`);
  });
  test('the data copied from agent.sh is the data of agent.sh as recorded', () => {
    assert.equal(DB_PATHS_DEFAULT, GOLD.dbPaths);
    assert.equal(DB_CLIENTS_DEFAULT, GOLD.dbClients);
    assert.equal(DB_MIGRATE_DEFAULT, GOLD.dbMigrate);
    assert.equal(`${USAGE_LINES.join('\n')}\n`, GOLD.usage);
  });
});

describe('role gate and locking rule give what the shell text gave (recorded, A244)', () => {
  test('every role against every one of the 134 commands (and an unknown one)', () => {
    const cmds = [...COMMAND_NAMES, 'no-such-command', ''];
    assert.deepEqual(Object.keys(GOLD.roleGate), ROLES);
    for (const role of ROLES) {
      const verdicts = GOLD.roleGate[role];
      assert.equal(verdicts.length, cmds.length, role);
      cmds.forEach((command, i) => assert.equal(commandAllowed(role, command), verdicts[i] === 'a', `${role} ${command}`));
    }
  });

  test('which commands take the locks, for every command, role and the --check shape', () => {
    const cmds = [...COMMAND_NAMES, 'no-such-command'];
    const shapes = [['', ''], ['T-1', '--check'], ['T-1', 'x']];
    for (const role of ['lead', 'reviewer']) for (const [a2, a3] of shapes) {
      const verdicts = GOLD.locks[`${role}|${a2}|${a3}`];
      assert.equal(verdicts.length, cmds.length, `${role}|${a2}|${a3}`);
      cmds.forEach((command, i) => {
        const readOnly = READ_ONLY_COMMANDS.includes(command);
        // a stage 6 command has no shell text any more: the rule it had was read-only commands and pr-state, batch-ci and deliver-merged --check unlocked, the rest locked
        const expected = command === 'advance' ? false : STAGE6.includes(command) ? STAGE6_LOCKS(command, a3, readOnly) : STAGE7C.includes(command) ? STAGE7C_LOCKS(command, readOnly) : verdicts[i] === 'y';
        assert.equal(takesLocks(command, [a2, a3], role, readOnly), expected, `${role}|${command}|${a2}|${a3}`);
      });
    }
  });
});

describe('commandTable()', () => {
  test('is a function returning name, readOnly, roles and moved for the 134 commands', () => {
    assert.equal(typeof commandTable, 'function');
    const t = commandTable();
    assert.equal(t.length, 134);
    for (const e of t) {
      assert.equal(typeof e.name, 'string'); assert.equal(typeof e.readOnly, 'boolean'); assert.ok(Array.isArray(e.roles)); assert.equal(typeof e.moved, 'boolean');
      assert.ok(e.roles.includes('lead'));
      assert.equal(e.roles.length === ROLES.length, e.readOnly || ['record', 'submit'].includes(e.name), e.name);
    }
  });
});
