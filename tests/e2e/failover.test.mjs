// @ts-check
// Self-tests of the FAILOVER scenario of the e2e harness, no real runtime: (F-1) the state at the kill is copied to out/at-kill/ before the Codex lead starts;
// (sandbox) the project copy of FAILOVER carries a test helper that answers in process, so `npm test` needs no loopback listener in a Codex worker's profile.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { here, repo, runE2e } from './runner.mjs';

const root = tempDir('e2e-failover-');
after(() => rmSync(root, { recursive: true, force: true }));
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
/** The only run directory under dir/<sub>. @param {string} sub */
const runDir = (sub) => { const d = path.join(root, sub); return path.join(d, /** @type {string} */ (readdirSync(d)[0])); };

/** Run the project's API tests with every socket listen refused (what a Codex worker profile does). @param {string} helper the helper file to install as tests/helpers.js */
function apiTestsWithoutListen(helper) {
  const dir = path.join(root, `pg-${path.basename(path.dirname(helper))}-${path.basename(helper)}`);
  rmSync(dir, { recursive: true, force: true });
  cpSync(path.join(repo, 'playground'), dir, { recursive: true });
  cpSync(helper, path.join(dir, 'tests/helpers.js'));
  const pre = path.join(root, 'no-listen.mjs');
  writeFileSync(pre, "import net from 'node:net';\nnet.Server.prototype.listen = function listen() { const e = new Error('listen EPERM: operation not permitted 127.0.0.1'); e.code = 'EPERM'; throw e; };\n");
  const r = spawnSync(process.execPath, ['--import', pre, '--test', 'tests/api.test.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: `--import ${pre}` } });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('with every listen refused the playground API tests fail on the original helper and pass on the FAILOVER helper', () => {
  const orig = apiTestsWithoutListen(path.join(repo, 'playground/tests/helpers.js'));
  assert.notEqual(orig.status, 0, `the control passed, so the listen refusal is not in effect: ${orig.out}`);
  const over = apiTestsWithoutListen(path.join(here, 'overlays/failover-helpers.js'));
  assert.equal(over.status, 0, over.out);
  assert.match(over.out, /pass 5\b/);
});

test('with a regression test in the same style (fetch of server.baseUrl) the in-process helper answers the pagination routes', () => {
  const dir = path.join(root, 'pg-style');
  cpSync(path.join(repo, 'playground'), dir, { recursive: true });
  cpSync(path.join(here, 'overlays/failover-helpers.js'), path.join(dir, 'tests/helpers.js'));
  writeFileSync(path.join(dir, 'tests/style.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
test('style', async () => {
  const s = await startTestServer();
  for (let i = 0; i < 12; i++) assert.equal((await fetch(s.baseUrl + '/api/books', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'B' + i, author: 'A' }) })).status, 201);
  const r = await fetch(s.baseUrl + '/api/books?page=2&pageSize=10');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).items.length, 2);
  assert.equal((await fetch(s.baseUrl + '/api/books/99999')).status, 404);
  assert.equal((await fetch(s.baseUrl + '/api/books/x', { method: 'DELETE' })).status >= 400, true);
  assert.equal(typeof (await fetch('data:text/plain,hi')).status, 'number');
  await s.close();
});
`);
  const r = spawnSync(process.execPath, ['--test', 'tests/style.test.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout ?? '') + (r.stderr ?? ''));
});

/** One FAILOVER run with stub leads. @param {string} sub @param {Record<string, string>} extra */
function killRun(sub, extra) {
  const bin = path.join(root, 'bin'); mkdirSync(bin, { recursive: true });
  // Stub Claude lead: a run with a freeze and an implementer decision in its ledger, one edited product file, then it waits to be killed.
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
[ "$1" = -p ] || { echo 'claude 2.0.0'; exit 0; }   # doctor and install probe the binary
d=.agents/runs/T-1; mkdir -p "$d"
# everything the harness reads after it sees the ledger line below must exist before it: that line is written LAST
printf 'state: IMPLEMENTING\\n' > "$d/RUN.yaml"
printf '// edited at the kill\\n' >> src/service.js
if [ -n "$STUB_UNREADABLE" ]; then mkdir -p "$d/zz" && echo x > "$d/zz/locked" && chmod 000 "$d/zz/locked"; fi
printf '%s\\n' 'seq=1 event=freeze role=lead' 'seq=2 event=decide role=lead detail=003-implementer.decision' > "$d/LEDGER.log"
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}'
exec sleep 60
`);
  // Stub Codex lead: records that the at-kill folder already existed when it started.
  writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
[ "$1" = exec ] || { echo 'codex-cli 0.169.0'; exit 0; }
r=$(dirname "$(dirname "$0")")
env | grep -E '^CLAUDE_?CODE' > "$r/codex-env-claude.txt"; env | grep -E '^(PATH|HOME|CODEX_HOME)=' > "$r/codex-env-kept.txt"; true
while [ $# -gt 0 ]; do [ "$1" = -o ] && o=$2; [ "$1" = -C ] && c=$2; shift; done
chmod 644 "$c/.agents/runs/T-1/zz/locked" 2>/dev/null   # the end-of-run copy of the runs must be able to read it   # -o <out>/lead-2.last.txt
out=$(dirname "$o")
[ -f "$out/at-kill/runs/T-1/LEDGER.log" ] && echo seen > "$out/codex-saw-at-kill.txt"
printf '%s\\n' '{"type":"thread.started","thread_id":"t1"}'
`);
  chmodSync(path.join(bin, 'claude'), 0o755); chmodSync(path.join(bin, 'codex'), 0o755);
  const r = runE2e(['FAILOVER', 'mixed', '--keep'], { ...extra, E2E_ROOT: path.join(root, sub), E2E_FAILOVER_POLL_S: '0.05', E2E_SKIP_DOCTOR: '1', E2E_MAX_REPLIES: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}`, CLAUDE_CODE_SESSION_ID: 'outer-session', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  assert.equal(r.status, 0, r.out);
  return { out: path.join(runDir(sub), 'out'), project: path.join(runDir(sub), 'project') };
}

test('F-1: the state at the kill is copied to out/at-kill/ before the Codex lead starts; the Codex lead gets no Claude session', () => {
  const { out, project } = killRun('kill', {});
  const kill = path.join(out, 'at-kill');
  assert.equal(read(path.join(root, 'codex-env-claude.txt')), '', 'the Codex lead inherited CLAUDE_CODE variables of the harness shell');
  // the scrub removes only those: the variables the Codex lead needs are still passed
  const kept = read(path.join(root, 'codex-env-kept.txt'));
  for (const k of ['PATH', 'HOME', 'CODEX_HOME']) assert.match(kept, new RegExp(`^${k}=.+`, 'm'), `${k} missing from the Codex lead environment`);
  assert.match(read(path.join(kill, 'runs/T-1/LEDGER.log')), /event=freeze[\s\S]*event=decide/);
  assert.match(read(path.join(kill, 'runs/T-1/RUN.yaml')), /IMPLEMENTING/);
  assert.match(read(path.join(kill, 'git-status.txt')), /^ M src\/service\.js$/m);
  assert.match(read(path.join(kill, 'git-diff.patch')), /edited at the kill/);
  assert.ok(existsSync(path.join(kill, 'git-branches.txt')));
  assert.match(read(path.join(out, 'summary.txt')), /^lead_1_killed=yes$/m);
  assert.ok(existsSync(path.join(out, 'codex-saw-at-kill.txt')), 'the Codex lead started before out/at-kill/ was complete');
  // the project copy of FAILOVER carries the in-process helper (the playground helper listens, which a Codex worker profile refuses)
  const helper = read(path.join(project, 'tests/helpers.js'));
  assert.equal(helper, read(path.join(here, 'overlays/failover-helpers.js')));
  assert.notEqual(helper, read(path.join(repo, 'playground/tests/helpers.js')));
});

test('F-1: a copy of the runs that fails is recorded in at-kill/copy-error.txt and the Codex lead still starts', { skip: process.getuid?.() === 0 }, () => {
  const { out } = killRun('kill-err', { STUB_UNREADABLE: '1' });
  const kill = path.join(out, 'at-kill');
  assert.match(read(path.join(kill, 'copy-error.txt')), /EACCES|permission/i);
  assert.ok(existsSync(path.join(kill, 'git-status.txt')), 'the rest of the snapshot was not taken');
  assert.match(read(path.join(out, 'summary.txt')), /^lead_2_runtime=codex$/m, 'the Codex lead did not start');
});
