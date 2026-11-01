// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { inflightParts } from '../../control-plane/agents/scripts/core/dispatch.mjs';

test('inflightParts cuts "ROLE PID" at the last space for the role and at the first space for the pid, like ${s% *} and ${s#* }', () => {
  for (const role of ['implementer', 'two words', 'tab\there', 'a b c', 'specialist', ' lead']) {
    const s = `${role} 4242`;
    const sh = spawnSync('sh', ['-c', 'printf "%s\\n%s\\n" "${1% *}" "${1#* }"', 'sh', s], { encoding: 'utf8' }).stdout.split('\n');
    const p = inflightParts({ role, pid: '4242' });
    assert.deepEqual([p.role, p.pid], [sh[0], sh[1]], JSON.stringify(role));
  }
  assert.deepEqual(inflightParts({ role: 'two words', pid: '7' }), { role: 'two words', pid: 'words 7' });
});
