// @ts-check
// The command table (132 entries), the role gate and the locking rule against the shell text of agent.sh.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { COMMAND_NAMES, READ_ONLY_COMMANDS } from '../../control-plane/agents/scripts/core/commands/names.mjs';
import { HANDLERS } from '../../control-plane/agents/scripts/core/commands/moved.mjs';
import { DB_CLIENTS_DEFAULT, DB_MIGRATE_DEFAULT, DB_PATHS_DEFAULT, USAGE_LINES } from '../../control-plane/agents/scripts/core/commands/data.mjs';
import { takesLocks } from '../../control-plane/agents/scripts/core/lock.mjs';
import { commandAllowed, commandTable } from '../../control-plane/agents/scripts/proofline-core.mjs';
import { agentSh, extractRange } from './helpers.mjs';

const ROLES = ['lead', 'task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier'];
const STAGE1 = ['role', 'config-get', 'config-check', 'timeouts', 'hook-timeouts', 'verify-timeout', 'tm-scaled', 'db-config', 'hook-config', 'help'];
// stage 2, package TOOLS (appended block)
const STAGE2_TOOLS = ['debt', 'task-type', 'task-scope-entries', 'scope-covers', 'human-checks', 'questions', 'repro-normalize', 'design-surface', 'test-path', 'path-kind', 'scope-kinds'];
const MOVED = [...STAGE1, ...STAGE2_TOOLS];

describe('command table', () => {
  test('132 entries, each the label of a case of agent.sh, in its order', () => {
    const cli = agentSh.slice(agentSh.indexOf('\ncase "$command" in\n  role)'));
    const labels = [...cli.matchAll(/^  ([a-z][a-z0-9|-]*)\)/gm)].flatMap((m) => m[1].split('|'));
    assert.equal(commandTable().length, 132);
    assert.deepEqual(commandTable().map((e) => e.name), labels);
    assert.deepEqual(COMMAND_NAMES, labels);
  });
  test('the read-only list is the shell list', () => {
    const line = agentSh.split('\n').find((l) => l.startsWith("read_only_commands='")) ?? '';
    assert.deepEqual(READ_ONLY_COMMANDS, line.slice("read_only_commands='".length, -1).split(' '));
    for (const c of READ_ONLY_COMMANDS) assert.ok(COMMAND_NAMES.includes(c), c);
  });
  test('the moved commands are the handlers AND the delegation list of the agent.sh preamble (the two lists are identical)', () => {
    const m = /\n  (role\|[a-z0-9|\\\n -]*)\)\n    pl_sh=no/.exec(agentSh);
    assert.ok(m, 'the preamble list');
    const preamble = m[1].replace(/\\\n\s*/g, '').split('|');
    assert.deepEqual([...preamble].sort(), Object.keys(HANDLERS).sort());
    assert.deepEqual(commandTable().filter((e) => e.moved).map((e) => e.name).sort(), [...preamble].sort());
    for (const c of MOVED) assert.ok(preamble.includes(c), `stage 1 command ${c} stays moved`);
  });
  test('the data copied from agent.sh is the data of agent.sh', () => {
    const grab = (/** @type {string} */ n) => (agentSh.split('\n').find((l) => l.startsWith(`${n}='`)) ?? '').slice(n.length + 2, -1);
    assert.equal(DB_PATHS_DEFAULT, grab('db_paths_default'));
    assert.equal(DB_CLIENTS_DEFAULT, grab('db_clients_default'));
    assert.equal(DB_MIGRATE_DEFAULT, grab('db_migrate_default'));
    const a = agentSh.indexOf("usage: agent.sh <command> [args]   (AGENT_ROLE");
    const text = agentSh.slice(a, agentSh.indexOf('\nUSAGE\n', a) + 1);
    assert.equal(`${USAGE_LINES.join('\n')}\n`, text);
  });
});

describe('role gate and locking rule equal the shell text', () => {
  const gate = extractRange('read_only_commands=', 'esac');
  const roList = extractRange('read_only_commands=', 'read_only_commands=');
  const lockRule = extractRange('lock_command=yes', 'if [ "$command" = submit ]');

  test('every role against every one of the 132 commands (and an unknown one)', () => {
    const cmds = [...COMMAND_NAMES, 'no-such-command', ''];
    const script = `fail() { echo deny; exit 0; }\nfor r in ${ROLES.join(' ')}; do for c in ${cmds.map((c) => `'${c}'`).join(' ')}; do\n( execution_role=$r; command=$c; ${gate}\n echo allow ) | sed "s/^/$r $c /"; done; done`;
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const got = r.stdout.trim().split('\n').map((l) => l.split(' '));
    assert.equal(got.length, ROLES.length * cmds.length);
    for (const row of got) {
      const role = row[0]; const verdict = row[row.length - 1];
      const command = row.slice(1, -1).join(' ');
      assert.equal(commandAllowed(role, command), verdict === 'allow', `${role} ${command}`);
    }
  });

  test('which commands take the locks, for every command, role and the --check shape', () => {
    const cmds = [...COMMAND_NAMES, 'no-such-command'];
    const shapes = [['', ''], ['T-1', '--check'], ['T-1', 'x']];
    const out = [];
    for (const role of ['lead', 'reviewer']) for (const c of cmds) for (const [a2, a3] of shapes) out.push(`${role}|${c}|${a2}|${a3}`);
    const script = `${roList}\nfor row in ${out.map((o) => `'${o}'`).join(' ')}; do\n( IFS='|'; set -- $row; execution_role=$1; command=$2; a2=$3; a3=$4; IFS=' '; set -- "$command" "$a2" "$a3"; ${lockRule}\n echo "$row|$lock_command" ); done`;
    const r = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const rows = r.stdout.trim().split('\n');
    assert.equal(rows.length, out.length);
    for (const row of rows) {
      const [role, command, a2, a3, verdict] = row.split('|');
      const readOnly = READ_ONLY_COMMANDS.includes(command);
      assert.equal(takesLocks(command, [a2, a3], role, readOnly), verdict === 'yes', row);
    }
  });
});

describe('commandTable()', () => {
  test('is a function returning name, readOnly, roles and moved for the 132 commands', () => {
    assert.equal(typeof commandTable, 'function');
    const t = commandTable();
    assert.equal(t.length, 132);
    for (const e of t) {
      assert.equal(typeof e.name, 'string'); assert.equal(typeof e.readOnly, 'boolean'); assert.ok(Array.isArray(e.roles)); assert.equal(typeof e.moved, 'boolean');
      assert.ok(e.roles.includes('lead'));
      assert.equal(e.roles.length === ROLES.length, e.readOnly || ['record', 'submit'].includes(e.name), e.name);
    }
  });
});
