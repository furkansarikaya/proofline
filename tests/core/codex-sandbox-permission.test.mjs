// @ts-check
// The Codex worker's network and local-server permission (A372, issue 338 U2): default off; the profile it writes (only the network table, never the filesystem one); the line
// doctor, the batch summary and the status block show; the preflight warning before a Codex implementer starts; the handover of a sandbox-stopped Codex implementer to Claude
// only when the user granted it; the config check; and that no agent can write the config that holds the switch. A fake Codex runtime, a throwaway project, no real wait.
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { repo } from './helpers.mjs';
import { cfgMergeNew } from '../../control-plane/agents/scripts/core/cfgcli.mjs';
import { checkConfigLines } from '../../control-plane/agents/scripts/core/commands/config-check.mjs';
import { anyOn, codexRoles, permissionLine, preflightWarning, profileNetworkArgs, sandboxBlockLines, sandboxNeeds, sandboxPermission } from '../../control-plane/agents/scripts/core/codexsandbox.mjs';
import { cfgSet } from '../../control-plane/agents/scripts/core/configset.mjs';
import { skipOnWin32 } from '../lib/winpath.mjs';
import { AB, bnew, binstall, fakes, mktask, summaryOf } from './batch-lib.mjs';
import { fixture } from './dispatch-lib.mjs';
import { sandbox } from './frontend-lib.mjs';
import { A, project } from './legacy-lib.mjs';

const fakeTest = skipOnWin32(test, 'starts a shell-script fake runtime from a temp folder; on Windows only a real .exe outside temp folders runs, by design (A252, A262)');
/** A config reader over a map. @param {Record<string, string>} m */
const cfg = (m) => ({ get: (/** @type {string} */ k, /** @type {string} */ d = '') => (m[k] === undefined || m[k] === '' ? d : m[k]) });
const loc = (/** @type {import('./dispatch-lib.mjs').Fixture} */ fx, /** @type {string} */ f) => path.join(fx.loc, f);
const argvOf = (/** @type {import('./dispatch-lib.mjs').Fixture} */ fx) => readFileSync(loc(fx, 'codex.argv'), 'utf8');

describe('the permission value', () => {
  test('every default is off, and only the exact word turns a key on (anything else is off and named)', () => {
    const d = sandboxPermission(cfg({}));
    assert.deepEqual([d.network, d.localServer, d.failover, d.invalid], [false, false, false, []]);
    const on = sandboxPermission(cfg({ 'codex.sandbox.network': 'on', 'codex.sandbox.local_server': 'on', 'codex.sandbox.failover': 'claude' }));
    assert.deepEqual([on.network, on.localServer, on.failover], [true, true, true]);
    for (const v of ['ON', 'true', 'yes', '1', 'on ;', 'claude']) {
      const p = sandboxPermission(cfg({ 'codex.sandbox.network': v === 'on ;' ? 'on ;' : v }));
      assert.equal(p.network, false, `network: ${v} must read as off`);
    }
    const bad = sandboxPermission(cfg({ 'codex.sandbox.network': 'yes', 'codex.sandbox.failover': 'on' }));
    assert.equal(bad.invalid.length, 2);
    assert.match(permissionLine(d), /^codex network: off, local server: off, failover to the Claude implementer on a sandbox block: off$/);
    assert.match(permissionLine(on), /codex network: ON, local server: ON/);
    assert.equal(anyOn(d), false); assert.equal(anyOn(on), true);
  });
  test('the profile gets only network keys, none when everything is off', () => {
    assert.deepEqual(profileNetworkArgs(sandboxPermission(cfg({}))), []);
    assert.deepEqual(profileNetworkArgs(sandboxPermission(cfg({ 'codex.sandbox.failover': 'claude' }))), [], 'a failover grant widens nothing in the profile');
    const a = profileNetworkArgs(sandboxPermission(cfg({ 'codex.sandbox.network': 'on', 'codex.sandbox.local_server': 'on' })));
    assert.deepEqual(a, ['-c', 'permissions.proofline-worker.network.enabled=true', '-c', 'permissions.proofline-worker.network.allow_local_binding=true']);
    assert.ok(a.every((x) => x === '-c' || x.startsWith('permissions.proofline-worker.network.')), 'no filesystem key');
  });
  test('the roles on Codex follow runtime.roles, then the group', () => {
    assert.deepEqual(codexRoles(cfg({})), []);
    assert.deepEqual(codexRoles(cfg({ 'runtime.worker': 'codex' })), ['task_author', 'explorer', 'architect', 'data_architect', 'designer', 'implementer']);
    assert.deepEqual(codexRoles(cfg({ 'runtime.roles.implementer': 'codex' })), ['implementer']);
    assert.deepEqual(codexRoles(cfg({ 'runtime.worker': 'codex', 'runtime.roles.implementer': 'claude' })).includes('implementer'), false);
  });
  test('the plan words: network and local-server hints, a warning only when the permission is off', () => {
    const plan = '## Verification\n\n- `curl -s http://localhost:8080/health`\n- npm install left-pad\n- node --test tests/a.test.mjs\n- server.listen(0)\n# curl in a heading is skipped\n';
    const n = sandboxNeeds(plan);
    assert.equal(n.network.length, 2); assert.equal(n.localServer.length, 2);
    assert.deepEqual(sandboxNeeds('- node --test tests/a.test.mjs\n- prose about nothing\n'), { network: [], localServer: [] });
    const off = sandboxPermission(cfg({}));
    const w = preflightWarning(off, n);
    assert.match(w, /^preflight: .*codex\.sandbox\.network is off \(codex\.sandbox\.local_server needs codex\.sandbox\.network: on/); assert.match(w, /BLOCKED with the guidance/); assert.match(w, /--runtime claude/);
    assert.match(preflightWarning(sandboxPermission(cfg({ 'codex.sandbox.failover': 'claude' })), n), /handed to the Claude implementer/);
    assert.equal(preflightWarning(sandboxPermission(cfg({ 'codex.sandbox.network': 'on', 'codex.sandbox.local_server': 'on' })), n), '');
    assert.match(preflightWarning(sandboxPermission(cfg({ 'codex.sandbox.local_server': 'on' })), { network: [], localServer: ['x'] }), /local_server alone grants nothing/, 'verified with a real Codex 0.172: allow_local_binding alone grants no listener');
    assert.doesNotMatch(preflightWarning(sandboxPermission(cfg({ 'codex.sandbox.network': 'on' })), n), /codex\.sandbox\.network/, 'a granted key is not named again');
  });
  test('a sandbox refusal in a log: a refused listener or lookup, not an ordinary failure', () => {
    assert.equal(sandboxBlockLines(['Error: listen EPERM: operation not permitted 127.0.0.1:0']), true);
    assert.equal(sandboxBlockLines(['curl: (6) Could not resolve host: registry.example']), true);
    assert.equal(sandboxBlockLines(['error: tests failed in src/x']), false);
  });
  test('config-check: the three keys take their words, another codex key is unknown', () => {
    const ok = checkConfigLines(['codex=', 'codex.sandbox=', 'codex.sandbox.network=on', 'codex.sandbox.local_server=off', 'codex.sandbox.failover=claude']);
    assert.deepEqual(ok.messages.filter((m) => !m.startsWith('missing key')), []);
    const bad = checkConfigLines(['codex.sandbox.network=yes', 'codex.sandbox.failover=on', 'codex.sandbox.domains=x']);
    assert.equal(bad.messages.filter((m) => !m.startsWith('missing key')).length, 3);
    assert.match(bad.messages.join('\n'), /invalid value for codex\.sandbox\.network: yes \(want on\|off\)/);
    assert.match(bad.messages.join('\n'), /unknown codex key: codex\.sandbox\.domains/);
  });
});

describe('upgrade', () => {
  const def = readFileSync(path.join(repo, 'control-plane/agents/config.yaml'), 'latin1');
  test('upgrade adds a missing section with every key off and never changes a value the user wrote', () => {
    const added = cfgMergeNew('canonical_branch: main\nfailover: auto\n', def);
    assert.match(added, /^codex:\n {2}sandbox:\n {4}network: off\n {4}local_server: off\n {4}failover: off$/m);
    const kept = cfgMergeNew('canonical_branch: main\ncodex:\n  sandbox:\n    network: on\n    failover: claude\n', def);
    assert.match(kept, /^ {4}network: on$/m); assert.match(kept, /^ {4}failover: claude$/m); assert.doesNotMatch(kept, /network: off/);
  });
});

describe('the profile and the dispatch', () => {
  const fx = fixture();
  fakeTest('default: the profile has no network key; on: only the network table is added and the filesystem grant is byte-equal', async () => {
    fx.reset();
    assert.equal((await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'])).code, 0);
    const off = argvOf(fx);
    assert.doesNotMatch(off, /\.network\./);
    fx.setConfig({ sandbox: { network: 'on', local_server: 'on' } });
    fx.reset();
    assert.equal((await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'])).code, 0);
    const on = argvOf(fx);
    assert.match(on, /^permissions\.proofline-worker\.network\.enabled=true$/m);
    assert.match(on, /^permissions\.proofline-worker\.network\.allow_local_binding=true$/m);
    const fs = (/** @type {string} */ t) => t.split('\n').filter((l) => l.startsWith('permissions.proofline-worker.filesystem='));
    assert.equal(fs(on).length, 1); assert.deepEqual(fs(on), fs(off), 'the filesystem permission is the same on and off');
    assert.deepEqual(on.split('\n').filter((l) => !/\.network\./.test(l) && l !== '-c').length, off.split('\n').filter((l) => l !== '-c').length);
    fx.setConfig();
  });
  fakeTest('a Codex implementer whose sandbox blocks its API: BLOCKED with the guidance by default; handed to Claude when the user granted it (reason sandbox_block)', async () => {
    fx.reset();
    const d = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'sandboxapi' });
    assert.equal(d.code, 6); assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    fx.setConfig({ sandbox: { failover: 'claude' } });
    fx.reset();
    const p = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'network' });
    assert.equal(p.code, 6, 'a plain API outage is not a sandbox block: BLOCKED as before even with the grant'); assert.match(p.out, /enable network access/);
    assert.equal(existsSync(loc(fx, 'claude.argv')), false); assert.doesNotMatch(fx.ledger(), /reason=sandbox_block/);
    fx.reset();
    const g = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'sandboxapi' });
    assert.equal(g.code, 0, g.err + g.out);
    assert.equal(readFileSync(loc(fx, 'claude.role'), 'utf8').trim(), 'implementer');
    assert.match(fx.ledger(), /failover from=codex to=claude reason=sandbox_block worker=implementer/);
    const last = readdirSync(path.join(fx.dir, '.agents/runs/LC/decisions')).sort().pop() ?? '';
    assert.match(readFileSync(path.join(fx.dir, '.agents/runs/LC/decisions', last), 'utf8'), /^runtime_reason=AUTOMATIC_FAILOVER$/m);
    fx.setConfig();
  });
  fakeTest('a refused loopback listener ends without a submission: BLOCKED by default, handed to Claude when granted; never for another role; the global failover off still wins', async () => {
    fx.reset();
    const d = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'listenblock' });
    assert.equal(d.code, 6); assert.match(d.out, /no valid submission/); assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    fx.setConfig({ sandbox: { failover: 'claude' } });
    fx.reset();
    const g = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'listenblock' });
    assert.equal(g.code, 0, g.err + g.out);
    assert.match(fx.ledger(), /failover from=codex to=claude reason=sandbox_block worker=implementer/);
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'listenblock' });
    assert.equal(r.code, 6, 'a reviewer is never handed over by this grant'); assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    fx.setConfig({ sandbox: { failover: 'claude' }, failover: 'off' });
    fx.reset();
    const o = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'listenblock' });
    assert.equal(o.code, 6); assert.match(o.out, /failover: off/); assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    fx.setConfig();
  });
  fakeTest('an ordinary task failure is never handed over, grant or not', async () => {
    fx.setConfig({ sandbox: { failover: 'claude' } });
    fx.reset();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'fail' });
    assert.equal(r.code, 1); assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    fx.setConfig();
  });
  fakeTest('preflight: a plan with a local server or a network command warns before the Codex implementer starts, once, and not when allowed', async () => {
    const plan = path.join(fx.dir, '.agents/runs/LC/PLAN.md');
    const before = readFileSync(plan, 'utf8');
    appendFileSync(plan, '\n- curl -s http://localhost:8080/health\n');
    try {
      fx.reset();
      const w = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ok' });
      assert.equal(w.code, 0, w.err);
      assert.match(w.err, /^dispatch: preflight: .*Codex sandbox refuses by default/m);
      assert.equal(w.err.split('\n').filter((l) => l.includes('preflight:')).length, 1);
      assert.match(fx.ledger(), /dispatch preflight: /);
      fx.setConfig({ sandbox: { network: 'on', local_server: 'on' } });
      fx.reset();
      const q = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ok' });
      assert.doesNotMatch(q.err, /preflight:/);
    } finally { writeFileSync(plan, before); fx.setConfig(); }
  });
});

describe('what the user sees', () => {
  test('the batch summary: no section without Codex, a line per Codex role with it, the preflight per task, a loud warning when on', () => {
    const F = fakes(); const dir = bnew();
    mktask(dir, 'T-1', 'COMPLEX'); binstall(dir, { remote: false });
    assert.equal(AB(F, dir, ['batch-plan', 'T-1']).status, 0);
    assert.doesNotMatch(summaryOf(dir), /Codex sandbox permission/, 'a batch without Codex keeps the summary it always had');
    const conf = path.join(dir, '.agents/config.yaml');
    writeFileSync(conf, readFileSync(conf, 'utf8').replace(/^ {2}worker: claude$/m, '  worker: codex'));
    appendFileSync(path.join(dir, '.agents/tasks/T-1.md'), '\n## Verification\n\n- curl -s http://localhost:3000/ping\n');
    assert.equal(AB(F, dir, ['batch-plan', '--replace', 'T-1']).status, 0);
    const s = summaryOf(dir);
    assert.match(s, /## Codex sandbox permission \(A372\)/);
    assert.match(s, /- codex network: off, local server: off, failover to the Claude implementer on a sandbox block: off/);
    assert.match(s, /- role implementer runs on Codex: no outbound network, no loopback listener/);
    assert.match(s, /- WARNING: T-1: preflight: /);
    assert.doesNotMatch(s, /a permission is ON/);
    assert.ok(cfgSet(conf, 'codex.sandbox.network', 'on'));
    assert.equal(AB(F, dir, ['batch-plan', '--replace', 'T-1']).status, 0);
    const on = summaryOf(dir);
    assert.match(on, /codex network: ON/); assert.match(on, /WARNING: a permission is ON/);
    assert.match(on, /role implementer runs on Codex: outbound network ON/);
  });
});

describe('doctor and the status block', () => {
  const sb = sandbox({ exeTools: true });
  const edit = (/** @type {string} */ file, /** @type {(t: string) => string} */ fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));
  test('doctor: silent when Codex is not used; the default state as PASS with Codex; ON as a WARN; a bad value named', async () => {
    const env = { PROOFLINE_DOCTOR_PROBES: '0', PROOFLINE_CODEX_BIN: '/nonexistent/codex' };
    const a = sb.copy('cs-a'); const b = sb.copy('cs-b'); const c = sb.copy('cs-c'); const d = sb.copy('cs-d');
    edit(`${a}/.agents/config.yaml`, (t) => t.replace(/^ {2}worker: codex/m, '  worker: claude'));   // the sandbox project uses Codex for its workers; this one does not
    edit(`${c}/.agents/config.yaml`, (t) => t.replace(/^ {4}network: off$/m, '    network: on').replace(/^ {4}failover: off$/m, '    failover: claude'));
    // one project for the two oddities: a bad value (read as off) and local_server on without network
    edit(`${d}/.agents/config.yaml`, (t) => t.replace(/^ {4}network: off$/m, '    network: yes').replace(/^ {4}local_server: off$/m, '    local_server: on'));
    const [ra, rb, rc, rd] = await Promise.all([a, b, c, d].map((x) => sb.plAsync(x, ['doctor'], env)));
    assert.doesNotMatch(ra.out, /codex sandbox:/);
    assert.match(rb.out, /^PASS codex sandbox: codex network: off, local server: off, failover to the Claude implementer on a sandbox block: off \(the default/m);
    assert.match(rc.out, /^WARN codex sandbox: codex network: ON, local server: off, failover to the Claude implementer on a sandbox block: ON\. You turned this on in \.agents\/config\.yaml: .*send repository content out/m);
    assert.match(rd.out, /^WARN codex sandbox: codex\.sandbox\.network: yes \(want on\|off; read as off\)/m);
    assert.match(rd.out, /^WARN codex sandbox: codex\.sandbox\.local_server needs codex\.sandbox\.network: on/m);
  });
  test('the status block shows a widened permission and keeps its bytes when nothing is widened', () => {
    const d = project('scaffold standalone');
    const f = `${d}/.agents/task-integrations/markdown.sh`;
    writeFileSync(f, '#!/bin/sh\n[ "$1" = statusblock ] || exit 2\ncp "$3" "$(dirname "$0")/../local/block-$2.txt"\n'); chmodSync(f, 0o755);
    const block = () => { assert.equal(A(d, ['status-block', 'LC', 'update']).status, 0); return readFileSync(`${d}/.agents/local/block-LC.txt`, 'utf8'); };
    assert.doesNotMatch(block(), /codex_sandbox/);
    edit(`${d}/.agents/config.yaml`, (t) => t.replace(/^ {4}network: off$/m, '    network: on'));
    assert.match(block(), /^- codex_sandbox: network ON, local server off$/m);
  });
});
