// @ts-check
// The dispatcher in Node (A226; scripts/dispatch-test.sh is gone, tests/legacy-port-map.tsv names where each scenario went). A real project (the scaffold of the
// self-test library: run LC, STANDARD, frozen, IMPLEMENTING), the real core in process, fake runtimes that write the submission status the specialist's `agent.sh submit`
// would write. The watchdog's grace is 300 ms and the shortest step time 1 s here: options of startDispatch(), not environment values.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { skipOnWin32 } from '../lib/winpath.mjs';
/** A test that starts a shell-script fake runtime (or fake worker) from a temp folder: skipped on Windows, where only a real .exe outside temp folders runs, by design (A252, A262). Tests that only read text or run `dispatch.sh codex-profile` stay on. */
const fakeTest = skipOnWin32(test, 'starts a shell-script fake runtime from a temp folder; on Windows only a real .exe outside temp folders runs, by design (A252, A262)');
import { fixture } from './dispatch-lib.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {number} pid */
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** @param {() => boolean} cond @param {number} [ms] */
async function until(cond, ms = 15000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await sleep(20); } }
/** @param {import('./dispatch-lib.mjs').Fixture} fx @param {string} f */
const loc = (fx, f) => path.join(fx.loc, f);
/** @param {import('./dispatch-lib.mjs').Fixture} fx @param {string} f */
const readLoc = (fx, f) => { try { return readFileSync(loc(fx, f), 'utf8'); } catch { return ''; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const ledger = (fx) => fx.ledger();
/** The window records of the run. @param {import('./dispatch-lib.mjs').Fixture} fx */
const windows = (fx) => { try { return readdirSync(path.join(fx.dir, '.agents/runs/LC/worker-evidence')).filter((n) => /^WINDOW-\d+\.yaml$/.test(n)); } catch { return []; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const metrics = (fx) => { try { return readFileSync(path.join(fx.dir, '.agents/local/metrics/records.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"kind":"dispatch"')); } catch { return []; } };
/** @param {import('./dispatch-lib.mjs').Fixture} fx */
const markers = (fx) => { try { return readdirSync(path.join(fx.dir, '.agents/runs/LC/dispatch')).filter((n) => n.endsWith('.running')); } catch { return []; } };

describe('what a dispatch records', () => {
  const fx = fixture();
  fakeTest('a Codex implementer: bracketed by the window, the specialist\'s own status is the record, the log is under dispatch/ and no marker is left', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'implementer']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^submitted: LC implementer DONE \(results\/001-implementer\.result\.md\)\n$/);
    assert.equal(readLoc(fx, 'codex.role').trim(), 'implementer');
    assert.equal(readLoc(fx, 'codex.stdin').split('\n')[0], 'You are the proofline implementer. STABLE-PREFIX-implementer');
    assert.match(readLoc(fx, 'codex.stdin'), /TASK: LC/);
    assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /role: "implementer"[^]*exit_status: "0"/);
    assert.ok(existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-implementer-codex.md')) && existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-implementer-codex.log')));
    assert.deepEqual(markers(fx), []);
    assert.ok(!existsSync(path.join(fx.dir, '.agents/runs/LC/results/dispatch-001')), 'results/ holds recorded results only');
    assert.match(ledger(fx), /event=decide .*detail=001-implementer\.decision runtime=codex model=gpt-6-sol effort=high/);
    const m = metrics(fx);
    assert.equal(m.length, 1);
    assert.match(m[0], /"task":"LC","role":"implementer","focus":null,"gate":null,"runtime":"codex","model":"gpt-6-sol","duration_s":\d+,"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":0,.*"result":"submitted"/);
  });
  fakeTest('a Claude reviewer: no window, the product tree is fingerprinted before and after, the focus reaches the specialist', async () => {
    fx.reset();
    const w = windows(fx).length;
    const r = await fx.dispatch(['LC', 'reviewer', '--focus', 'rules']);
    assert.equal(r.code, 0, r.err);
    assert.equal(windows(fx).length, w);
    assert.match(readLoc(fx, 'claude.stdin'), /FOCUS: rules/);
    assert.match(readLoc(fx, 'claude.stdin'), /agent\.sh submit LC/);
    assert.equal(readLoc(fx, 'claude.role').trim(), 'reviewer');
    assert.match(readFileSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-reviewer-claude.md'), 'utf8'), /^said "hi" \\ ok\n$/, 'the final message is the unescaped result of the JSON');
  });
  fakeTest('the permission mode is explicit and ledgered (A114); an invalid one is a config error and nothing is launched', async () => {
    fx.reset();
    assert.equal((await fx.dispatch(['LC', 'reviewer', '--focus', 'rules'])).code, 0);
    assert.match(readLoc(fx, 'claude.argv'), /^--permission-mode\nbypassPermissions$/m);
    assert.match(ledger(fx), /dispatch claude_permission_mode=bypassPermissions role=reviewer/);
    fx.setConfig({ extra: { claude_permission_mode: 'acceptEdits' } });
    fx.reset();
    assert.equal((await fx.dispatch(['LC', 'reviewer', '--focus', 'rules'])).code, 0);
    assert.match(readLoc(fx, 'claude.argv'), /^acceptEdits$/m);
    assert.doesNotMatch(readLoc(fx, 'claude.argv'), /bypassPermissions/);
    fx.setConfig({ extra: { claude_permission_mode: 'yolo' } });
    fx.reset();
    const bad = await fx.dispatch(['LC', 'reviewer', '--focus', 'rules']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /claude_permission_mode/);
    assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    fx.setConfig();
  });
  fakeTest('bypassPermissions needs the PreToolUse hook wired and parseable: BLOCKED naming proofline doctor, no worker launched', async () => {
    const settings = path.join(fx.dir, '.claude/settings.json');
    const hook = path.join(fx.dir, '.agents/hooks/proofline-hook.mjs');
    const keepSettings = readFileSync(settings); const keepHook = readFileSync(hook);
    const wired = '{"type":"command","command":"node .agents/hooks/proofline-hook.mjs pretool claude"}';
    try {
      for (const [name, json] of /** @type {Array<[string, string | null]>} */ ([
        ['no settings file', null],
        ['hook wired for SessionStart plus an unrelated PreToolUse', `{"hooks":{"SessionStart":[{"hooks":[${wired}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"echo other"}]}]}}`],
        ['hook wired for SessionStart only', `{"hooks":{"SessionStart":[{"hooks":[${wired}]}]}}`],
        ['settings that are not JSON', '{not json'],
      ])) {
        if (json === null) rmSync(settings, { force: true }); else writeFileSync(settings, json);
        fx.reset();
        const r = await fx.dispatch(['LC', 'reviewer', '--focus', 'rules']);
        assert.equal(r.code, 6, name);
        assert.match(r.out, /proofline doctor/, name);
        assert.equal(existsSync(loc(fx, 'claude.argv')), false, name);
      }
      writeFileSync(settings, keepSettings);
      for (const [name, text] of [['a script that does not parse', 'if then\n'], ['an empty script', '']]) {
        writeFileSync(hook, text);
        fx.reset();
        const r = await fx.dispatch(['LC', 'reviewer', '--focus', 'rules']);
        assert.equal(r.code, 6, name);
        assert.equal(existsSync(loc(fx, 'claude.argv')), false, name);
      }
      writeFileSync(hook, keepHook);
      fx.reset();
      assert.equal((await fx.dispatch(['LC', 'reviewer', '--focus', 'rules'])).code, 0, 'the correct wiring starts the worker');
    } finally { writeFileSync(settings, keepSettings); writeFileSync(hook, keepHook); }
  });
  test('a generated .claude agent that grants Task, or lists no tools, is BLOCKED and nothing is launched', async () => {
    const dir = path.join(fx.dir, '.claude/agents');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, 'proofline-security-reviewer.md'), '---\nname: proofline-security-reviewer\ntools: Read, Task, Bash\n---\nbody\n');
      fx.reset();
      const r = await fx.dispatch(['LC', 'security_reviewer']);
      assert.equal(r.code, 6); assert.match(r.out, /grants an agent-spawning tool/);
      assert.equal(existsSync(loc(fx, 'claude.argv')), false);
      writeFileSync(path.join(dir, 'proofline-security-reviewer.md'), '---\nname: proofline-security-reviewer\n---\nbody\n');
      const r2 = await fx.dispatch(['LC', 'security_reviewer']);
      assert.equal(r2.code, 6); assert.match(r2.out, /has no tools: list/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('an override that could reach an argument list unsafely is a usage error (exit 2); so is a missing run, a missing prompt file and an odd argument list', async () => {
    fx.reset();
    for (const args of [['LC', 'reviewer', '--model', 'x y'], ['LC', 'reviewer', '--model', '-x'], ['NOPE', 'reviewer'], ['LC', 'reviewer', '--prompt-file', '/no/such/file'], ['LC', 'reviewer', '--focus'], ['LC', 'reviewer', '--bogus', 'x'], ['LC'], ['bad id', 'reviewer']]) {
      const r = await fx.dispatch(args);
      assert.equal(r.code, 2, args.join(' '));
    }
    assert.equal(existsSync(loc(fx, 'claude.argv')), false);
  });
  test('a role without an instructions file stops with exit 2 after the decision', async () => {
    const f = path.join(fx.dir, '.agents/roles/explorer.md');
    const keep = readFileSync(f);
    rmSync(f);
    try { fx.reset(); const r = await fx.dispatch(['LC', 'explorer', '--runtime', 'claude']); assert.equal(r.code, 2); assert.match(r.err, /no instructions for role explorer/); } finally { writeFileSync(f, keep); }
  });
});

describe('the designer\'s window', () => {
  fakeTest('before IMPLEMENTING a designer has no window and the product tree is fingerprinted; during IMPLEMENTING it is bracketed like the implementer', async () => {
    const early = fixture({ recipe: 'scaffold orchestrated no STANDARD manual' });
    const r = await early.dispatch(['LC', 'designer', '--runtime', 'claude']);
    assert.equal(r.code, 0, r.err);
    assert.equal(windows(early).length, 0);
    assert.doesNotMatch(r.err, /worker window recorded/);
    const fx = fixture();
    const r2 = await fx.dispatch(['LC', 'designer', '--runtime', 'claude']);
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(windows(fx), ['WINDOW-1.yaml']);
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /role: "designer"/);
  });
});

describe('the confinement checks (a step changes neither .git/config nor HEAD, a role that does not write code leaves the tree)', () => {
  const fx = fixture();
  fakeTest('a step that changes .git/config (hooksPath) is BLOCKED and not recorded', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'hooks' });
    assert.equal(r.code, 6);
    assert.match(r.out, /git\/config/);
    assert.doesNotMatch(r.out, /^submitted/m);
    assert.match(ledger(fx), /policy_violation role=reviewer/);
    spawnGit(fx, ['config', '--unset', 'core.hooksPath']);
  });
  test('a step that moves HEAD is BLOCKED even for the implementer, whose window was closed first', async () => {
    fx.reset();
    const before = windows(fx).length;
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'head' });
    assert.equal(r.code, 6);
    assert.doesNotMatch(r.out, /^submitted/m);
    assert.equal(windows(fx).length, before + 1, 'the window was closed before the check');
    spawnGit(fx, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  });
  fakeTest('a role that does not write code and edits the product tree is BLOCKED (policy_violation), not recorded, not reverted', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'edit' });
    assert.equal(r.code, 6);
    assert.match(r.out, /policy_violation/);
    assert.match(ledger(fx), /policy_violation role=reviewer runtime=codex product tree changed by a role that does not write code: product\.txt/);
    assert.match(readFileSync(path.join(fx.dir, 'product.txt'), 'utf8'), /tampered/);
    writeFileSync(path.join(fx.dir, 'product.txt'), 'original\n');
  });
});

/** @param {import('./dispatch-lib.mjs').Fixture} fx @param {string[]} args */
function spawnGit(fx, args) { return spawnSync('git', ['-C', fx.dir, ...args], { env: fx.env, encoding: 'utf8' }); }

describe('failover (D7), network retry (A200) and the answers a dispatch gives', () => {
  const fx = fixture();
  fakeTest('a usage limit on Claude fails over to Codex (auto): recorded, ledgered with the reason, re-decided with its own label (A203)', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer'], { FAKE_CLAUDE: 'limit' });
    assert.equal(r.code, 0, r.err);
    assert.equal(readLoc(fx, 'codex.role').trim(), 'reviewer');
    assert.match(ledger(fx), /failover from=claude to=codex reason=limit role=reviewer/);
    assert.doesNotMatch(readLoc(fx, 'codex.argv'), /worker-evidence/);
    const decisions = readdirSync(path.join(fx.dir, '.agents/runs/LC/decisions')).sort();
    const last = readFileSync(path.join(fx.dir, '.agents/runs/LC/decisions', decisions[decisions.length - 1]), 'utf8');
    assert.match(last, /^runtime=codex$/m);
    assert.match(last, /^runtime_reason=AUTOMATIC_FAILOVER$/m);
    const first = readFileSync(path.join(fx.dir, '.agents/runs/LC/decisions', decisions[decisions.length - 2]), 'utf8');
    assert.doesNotMatch(first, /runtime_reason=AUTOMATIC_FAILOVER/);
  });
  fakeTest('a missing binary fails over too', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer'], { PROOFLINE_CLAUDE_BIN: path.join(fx.bin, 'nope') });
    assert.equal(r.code, 0, r.err);
    assert.match(ledger(fx), /reason=missing_binary/);
  });
  fakeTest('a task failure is exit 1: no failover, nothing recorded', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'fail' });
    assert.equal(r.code, 1);
    assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    assert.match(r.err, /implementer on codex failed \(exit 1\)/);
    assert.match(fx.runFile('worker-evidence/WINDOW-' + windows(fx).length + '.yaml'), /exit_status: "1"/, 'the window is closed with the status of the worker');
  });
  fakeTest('a sandbox that blocks the network is BLOCKED at once with the guidance, not retried, not failed over', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'network' });
    assert.equal(r.code, 6);
    assert.match(r.out, /runtime_unavailable:network/); assert.match(r.out, /enable network access/);
    assert.match(r.out, /could not reach its API \(after 0 automatic retries\); enable network access/, 'the old text, retries or none');
    assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    assert.doesNotMatch(ledger(fx), /network retry/);
  });
  fakeTest('a dropped connection is retried on the same runtime: waits grow, the retry carries the RESUME note, the third attempt submits', async () => {
    fx.setConfig({ backoff: 1 });
    fx.reset();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'flaky' });
    assert.equal(r.code, 0, r.err);
    assert.equal(readLoc(fx, 'attempts').trim(), '3');
    assert.equal(existsSync(loc(fx, 'claude.argv')), false);
    assert.match(ledger(fx), /dispatch network retry 1\/3[^\n]*wait=1s/);
    assert.match(ledger(fx), /dispatch network retry 2\/3[^\n]*wait=2s/);
    assert.match(readLoc(fx, 'codex.stdin'), /RESUME:[^]*network error after attempt/);
    fx.setConfig();
  });
  fakeTest('a connection that never comes back stops after the bounded retries (3): BLOCKED with the guidance; a task failure is never retried', async () => {
    fx.setConfig({ backoff: 0 });
    fx.reset();
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ssl' });
    assert.equal(r.code, 6);
    assert.match(ledger(fx), /dispatch network retry 3\/3/);
    assert.doesNotMatch(ledger(fx), /retry 4\//);
    assert.match(r.out, /after 3 automatic retries/);
    fx.reset();
    const f = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'fail' });
    assert.equal(f.code, 1);
    assert.doesNotMatch(ledger(fx).split('\n').slice(-3).join('\n'), /network retry 1\/3[^\n]*implementer[^\n]*\n[^\n]*\n[^\n]*network retry 1\/3/);
    fx.setConfig();
  });
  fakeTest('failover ask: NEEDS_INPUT (exit 5), the question is stored with the lead\'s command, the other runtime is not run', async () => {
    fx.setConfig({ failover: 'ask' });
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer'], { FAKE_CLAUDE: 'limit' });
    assert.equal(r.code, 5);
    assert.match(r.out, /^RESULT: NEEDS_INPUT$/m); assert.match(r.out, /on codex\?/);
    assert.equal(existsSync(loc(fx, 'codex.argv')), false);
    const q = readdirSync(path.join(fx.dir, '.agents/runs/LC/questions')).filter((n) => /^\d{3}\.md$/.test(n));
    assert.ok(q.length >= 1);
    const text = readFileSync(path.join(fx.dir, '.agents/runs/LC/questions', q[q.length - 1]), 'utf8');
    assert.match(text, /1\. Runtime claude could not run reviewer/); assert.match(text, /options: yes \| no/);
    assert.match(ledger(fx), /dispatch needs_input role=reviewer runtime=claude reason=limit/);
    fx.setConfig();
  });
  fakeTest('failover off: BLOCKED; a floor the other runtime cannot meet (security_reviewer on a two-model ladder): BLOCKED, never downgraded', async () => {
    fx.setConfig({ failover: 'off' });
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer'], { FAKE_CLAUDE: 'limit' });
    assert.equal(r.code, 6); assert.match(r.out, /failover: off/);
    assert.equal(existsSync(loc(fx, 'codex.argv')), false);
    fx.setConfig({ codexModels: 'gpt-6-luna gpt-6-sol' });
    fx.reset();
    const s = await fx.dispatch(['LC', 'security_reviewer'], { FAKE_CLAUDE: 'limit' });
    assert.equal(s.code, 6); assert.match(s.out, /capability floor/);
    assert.equal(existsSync(loc(fx, 'codex.argv')), false);
    fx.setConfig();
  });
  test('a prompt over the resolved context budget is BLOCKED, not truncated', async () => {
    fx.reset();
    const big = path.join(fx.loc, 'big.txt');
    writeFileSync(big, 'x'.repeat(60000));
    const r = await fx.dispatch(['LC', 'reviewer', '--prompt-file', big]);
    assert.equal(r.code, 6); assert.match(r.out, /over the resolved context budget of 49152/);
    assert.equal(existsSync(loc(fx, 'claude.argv')), false);
  });
  fakeTest('a command-template runtime (D8): the template\'s output file is the log of the step', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'mycli']);
    assert.equal(r.code, 0, r.err);
    const md = readFileSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-reviewer-mycli.md'), 'utf8');
    assert.match(md, /^model=m2\n1\n$/);
  });
  fakeTest('a final message with a header is never recorded: one rerun with the rejection in the prompt, then BLOCKED (two decisions)', async () => {
    fx.reset();
    const n = () => readdirSync(path.join(fx.dir, '.agents/runs/LC/decisions')).length;
    const before = n();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'nosubmit' });
    assert.equal(r.code, 6); assert.match(r.out, /no valid submission/);
    assert.equal(n() - before, 2);
    assert.match(ledger(fx), /dispatch resubmit role=reviewer/);
    const rej = await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'rejected' });
    assert.equal(rej.code, 6); assert.match(rej.out, /last rejection: --confidence must be high/);
  });
  fakeTest('A127: a rerun for no submission ledgers the token it looked for; the rerun that submits is token d002 and its prompt carries the retry note', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'late' });
    assert.equal(r.code, 0, r.err);
    assert.match(ledger(fx), /reason=no submission token=d001-reviewer-codex status_files=/);
    assert.match(readLoc(fx, 'codex.stdin'), /Your previous attempt ended without a recorded result/);
    assert.ok(existsSync(path.join(fx.dir, '.agents/local/submissions/d002-reviewer-codex.status')));
  });
  fakeTest('A124: a worker that writes nothing is BLOCKED with a reason, the log says so, no marker is left', async () => {
    fx.reset();
    const r = await fx.dispatch(['LC', 'reviewer', '--runtime', 'claude'], { FAKE_CLAUDE: 'empty' });
    assert.equal(r.code, 6);
    assert.match(r.out, /^BLOCKED_REASON: reviewer on claude produced no output/m);
    assert.match(readFileSync(path.join(fx.dir, '.agents/runs/LC/dispatch/001-reviewer-claude.log'), 'utf8'), /wrote nothing/);
    assert.deepEqual(markers(fx), []);
  });
  fakeTest('the implementer prompt states its window and a missing assignment; a reviewer with an assignment gets neither line', async () => {
    fx.reset();
    await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'nosubmit' });
    assert.match(readLoc(fx, 'codex.stdin'), /WINDOW: dispatch\.sh opened your write window/);
    assert.match(readLoc(fx, 'codex.stdin'), /ASSIGNMENT: none was given/);
    fx.reset();
    await fx.dispatch(['LC', 'reviewer', '--runtime', 'claude', '--prompt-file', path.join(fx.dir, 'product.txt')]);
    assert.doesNotMatch(readLoc(fx, 'claude.stdin'), /WINDOW: dispatch\.sh|ASSIGNMENT: none was given/);
  });
  fakeTest('A132: each explorer dispatch names its own token-derived scratch report', async () => {
    fx.reset();
    await fx.dispatch(['LC', 'explorer', '--runtime', 'claude']);
    assert.match(readLoc(fx, 'claude.stdin'), /scratch\/d001-explorer-claude-report\.md/);
    await fx.dispatch(['LC', 'explorer', '--runtime', 'claude']);
    assert.match(readLoc(fx, 'claude.stdin'), /scratch\/d002-explorer-claude-report\.md/);
    assert.doesNotMatch(readLoc(fx, 'claude.stdin'), /scratch\/d001-explorer-claude-report\.md/);
  });
});

describe('A124: a running dispatch leaves a marker; parallel dispatches claim distinct sequences (A113)', () => {
  const fx = fixture();
  fakeTest('the marker says the step is in flight and names the limit and the start; it is removed when the step ends', async () => {
    fx.reset();
    const h = fx.start(['LC', 'reviewer', '--runtime', 'claude'], { FAKE_CLAUDE: 'hold' });
    await until(() => markers(fx).length === 1);
    const m = readFileSync(path.join(fx.dir, '.agents/runs/LC/dispatch', markers(fx)[0]), 'utf8');
    writeFileSync(loc(fx, 'release'), '');
    assert.equal(await h.done, 0);
    assert.match(m, /dispatch in flight: LC reviewer on claude/); assert.match(m, /do not re-dispatch/);
    assert.match(m, /^pid=\d+$/m); assert.match(m, /^timeout=\d+$/m); assert.match(m, /^started_epoch=\d+$/m);
    assert.deepEqual(markers(fx), []);
  });
  fakeTest('four parallel dispatches get four distinct tokens, outputs and logs (d001..d004)', async () => {
    fx.reset();
    const rs = await Promise.all(['rules', 'tests', 'plan', 'config'].map((f) => fx.dispatch(['LC', 'reviewer', '--focus', f], { FAKE_CLAUDE: 'ok' })));
    assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0], rs.map((r) => r.err).join('\n'));
    const dir = path.join(fx.dir, '.agents/runs/LC/dispatch');
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.log')).sort(), ['001-reviewer-claude.log', '002-reviewer-claude.log', '003-reviewer-claude.log', '004-reviewer-claude.log']);
    assert.deepEqual(readdirSync(path.join(fx.dir, '.agents/local/submissions')).filter((n) => n.endsWith('.status')).sort(), ['d001-reviewer-claude.status', 'd002-reviewer-claude.status', 'd003-reviewer-claude.status', 'd004-reviewer-claude.status']);
  });
});

describe('metrics (A80): one record per dispatch, from the runtime\'s own output, never estimated', () => {
  const fx = fixture();
  /** @param {string[]} args @param {Record<string, string>} env */
  const rec = async (args, env) => { fx.reset(); rmSync(path.join(fx.dir, '.agents/local/metrics'), { recursive: true, force: true }); await fx.dispatch(args, env); return metrics(fx).slice(-1)[0] ?? ''; };
  fakeTest('claude: usage and turns come from the result JSON (the last usage object), not from model text', async () => {
    assert.match(await rec(['LC', 'reviewer', '--focus', 'rules'], { FAKE_CLAUDE: 'usage' }), /"role":"reviewer","focus":"rules","gate":"REVIEW_RULES","runtime":"claude","model":"[a-z0-9.-]+","duration_s":\d+,"tokens_in":120,"tokens_out":30,"tokens_total":150,"turns":4,"retries":0/);
  });
  fakeTest('a runtime that reports no usage leaves tokens and turns null', async () => {
    assert.match(await rec(['LC', 'reviewer', '--focus', 'rules'], { FAKE_CLAUDE: 'ok' }), /"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":0.*"result":"submitted"/);
  });
  fakeTest('codex: the total comes from the trailer (last occurrence), in/out stay null; a line injected earlier is not read; the local number format (285.242, 96.739) is read', async () => {
    assert.match(await rec(['LC', 'implementer'], { FAKE_CODEX: 'tokens' }), /"tokens_in":null,"tokens_out":null,"tokens_total":12345,/);
    assert.match(await rec(['LC', 'implementer'], { FAKE_CODEX: 'inject' }), /"tokens_total":null,/);
    assert.match(await rec(['LC', 'implementer'], { FAKE_CODEX: 'trailer' }), /"tokens_total":285242,/);
    assert.match(await rec(['LC', 'implementer'], { FAKE_CODEX: 'trailer3' }), /"tokens_total":96739,/);
  });
  fakeTest('after a Codex to Claude failover the record carries Claude\'s numbers only and one retry', async () => {
    assert.match(await rec(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'limittok', FAKE_CLAUDE: 'usage' }), /"runtime":"claude".*"tokens_in":120,"tokens_out":30,"tokens_total":150,"turns":4,"retries":1,.*"result":"submitted"/);
  });
  fakeTest('a resubmitted dispatch counts one retry; a failed one is recorded with result failed', async () => {
    assert.match(await rec(['LC', 'reviewer', '--runtime', 'codex'], { FAKE_CODEX: 'late' }), /"retries":1,.*"result":"submitted"/);
    assert.match(await rec(['LC', 'implementer'], { FAKE_CODEX: 'fail' }), /"result":"failed"/);
  });
});

describe('the time limit (A171, A202 item 29)', () => {
  fakeTest('a timeout is exit 124: the window is closed with status 124, nothing is recorded, a resume note holds the partial work', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    writeFileSync(path.join(fx.dir, 'partial-work.txt'), 'partial\n');
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'sleep' });
    assert.equal(r.code, 124);
    assert.match(fx.runFile('worker-evidence/WINDOW-1.yaml'), /exit_status: "124"/);
    assert.match(ledger(fx), /dispatch timeout role=implementer runtime=codex after=1s/);
    const note = fx.runFile('dispatch/RESUME-implementer.md');
    assert.match(note, /^timed_out_at: \S+ \(after 1s, attempt 1, runtime codex\)$/m);
    assert.match(note, /partial-work\.txt/);
    assert.match(note, /last_output_of_the_worker:/);
    const again = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ok' }, {});
    assert.equal(again.code, 0, again.err);
    assert.match(readLoc(fx, 'codex.stdin'), /RESUME: an earlier dispatch of this step timed out[^]*partial-work\.txt/);
    assert.equal(existsSync(path.join(fx.dir, '.agents/runs/LC/dispatch/RESUME-implementer.md')), false, 'the note is spent once the step submits');
  });
  fakeTest('the limit of the run\'s class wins over the global one, and a class with a longer limit does not time out a normal step', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 60, classTimeout: 1 });
    const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'sleep' });
    assert.equal(r.code, 124);
    assert.match(ledger(fx), /after=1s/);
    fx.setConfig({ timeout: 1, classTimeout: 60 });
    const ok = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'ok' });
    assert.equal(ok.code, 0, ok.err);
  });
  fakeTest('timeouts.scale multiplies the limit (rounded up); a bad scale is read as 1; the step still fails at it', async () => {
    const fx = fixture();
    for (const [scale, want] of [['2', 2], ['1.5', 2], ['0.5', 1], ['0', 1], ['abc', 1]]) {
      fx.setConfig({ classTimeout: 1, scale });
      const r = await fx.dispatch(['LC', 'implementer'], { FAKE_CODEX: 'sleep' }, { minTimeoutSeconds: 1 });
      assert.equal(r.code, 124, `scale ${scale}`);
      assert.ok(ledger(fx).includes(`after=${want}s`), `scale ${scale}: ${want}s`);
    }
  }, { timeout: 60000 });
  fakeTest('the shortest step time is an option of the dispatcher (30 s by default): a 1 s limit becomes 30 s', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    const h = fx.start(['LC', 'reviewer', '--runtime', 'claude'], { FAKE_CLAUDE: 'hold' }, { minTimeoutSeconds: 30 });
    await until(() => markers(fx).length === 1);
    assert.match(readFileSync(path.join(fx.dir, '.agents/runs/LC/dispatch', markers(fx)[0]), 'utf8'), /^timeout=30$/m);
    writeFileSync(loc(fx, 'release'), '');
    assert.equal(await h.done, 0);
  });
  fakeTest('two explorers that both time out keep two resume notes; the same assignment finds its own and spends only that one', async () => {
    const fx = fixture();
    fx.setConfig({ timeout: 1 });
    writeFileSync(path.join(fx.loc, 'as1.md'), 'assignment one\n'); writeFileSync(path.join(fx.loc, 'as2.md'), 'assignment two\n');
    const a = await fx.dispatch(['LC', 'explorer', '--runtime', 'codex', '--prompt-file', path.join(fx.loc, 'as1.md')], { FAKE_CODEX: 'sleep' });
    const b = await fx.dispatch(['LC', 'explorer', '--runtime', 'codex', '--prompt-file', path.join(fx.loc, 'as2.md')], { FAKE_CODEX: 'sleep' });
    assert.deepEqual([a.code, b.code], [124, 124]);
    const notes = () => readdirSync(path.join(fx.dir, '.agents/runs/LC/dispatch')).filter((n) => /^RESUME-explorer-\d+\.md$/.test(n));
    assert.equal(notes().length, 2);
    const ok = await fx.dispatch(['LC', 'explorer', '--runtime', 'codex', '--prompt-file', path.join(fx.loc, 'as1.md')], { FAKE_CODEX: 'ok' });
    assert.equal(ok.code, 0, ok.err);
    assert.match(readLoc(fx, 'codex.stdin'), /RESUME: an earlier dispatch/);
    assert.equal(notes().length, 1);
  });
});
