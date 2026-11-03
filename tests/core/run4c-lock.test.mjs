// @ts-check
// Stage 4, package 4C review round 1 (B1): `submit` records gates under the command locks, so parallel submits never share a gate sequence number or break the
// ledger chain. Also: every moved command that writes takes the locks (the lock table is the shell's).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { takesLocks } from '../../control-plane/agents/scripts/core/lock.mjs';
import { cleanEnv } from '../hook/harness.mjs';
import { A, IMPLEMENTED, project } from './legacy-lib.mjs';

/** @param {string} d @param {string} role @param {string[]} args */
function sub(d, role, args) {
  return new Promise((res) => {
    const p = spawn('sh', ['.agents/scripts/agent.sh', ...args], { cwd: d, env: cleanEnv({ AGENT_ROLE: role }), stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (b) => { o += b; }); p.stderr.on('data', (b) => { o += b; });
    p.stdin.end(`# report\n\nVerdict: PASS\n\nJudged the tree ${role}.\n`);
    p.on('close', (c) => res({ role, code: c, o: o.trim().split('\n').slice(-2).join(' | ') }));
  });
}

test('submit: three parallel gate submits get distinct gate numbers and a sound ledger chain', async () => {
  for (let i = 0; i < 3; i++) {
    const d = project(`scaffold orchestrated no COMPLEX; ${IMPLEMENTED}`);
    const rs = await Promise.all([
      sub(d, 'reviewer', ['submit', 'LC', '--focus', 'rules+tests', '--confidence', 'high', '--findings', 'none', '--report', '-', '--artifact', 'reviews/proof-review/small/REPORT.md']),
      sub(d, 'security_reviewer', ['submit', 'LC', '--confidence', 'high', '--findings', 'none', '--report', '-', '--artifact', 'security/REPORT.md']),
      sub(d, 'qa', ['submit', 'LC', '--confidence', 'high', '--findings', 'none', '--report', '-', '--artifact', 'QA_REPORT.md']),
    ]);
    const gates = readdirSync(`${d}/.agents/runs/LC/gates`).filter((n) => n.endsWith('.yaml'));
    const seqs = readFileSync(`${d}/.agents/runs/LC/LEDGER.log`, 'utf8').split('\n').filter(Boolean).map((l) => /seq=(\d+)/.exec(l)?.[1]);
    assert.equal(new Set(seqs).size, seqs.length, 'duplicate ledger seq');
    assert.equal(new Set(gates.map((n) => n.slice(0, 3))).size, gates.length, `duplicate gate number: ${gates.join(',')}`);
    const seal = A(d, ['verify-seal', 'LC']);
    assert.equal(seal.status, 0, seal.text);
    // a submit that is refused for a legitimate reason (a gate the tier does not need) is fine; a collision is not
    for (const r of rs) if (r.code !== 0) assert.doesNotMatch(r.o, /collid|chain|lock/i, JSON.stringify(r));
  }
});

test('the lock table: every moved command that writes takes the locks (only the shell\'s unlocked list does not)', () => {
  for (const c of ['record', 'gate', 'secret-scan', 'worker-evidence', 'raise-budget', 'waive', 'knowledge-done', 'publish-completion-report', 'verify-completion-report']) {
    assert.equal(takesLocks(c, ['LC'], 'lead', false), true, c);
  }
  assert.equal(takesLocks('submit', ['LC'], 'reviewer', false), false, 'submit takes its locks itself, around record only (the long re-run phase stays unlocked)');
});
