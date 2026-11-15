// @ts-check
// The prompt hook records the user's acceptance of an assumption from the message it is handling, in process (the primary path); the other readers of
// the captures are tested in tests/core/answer-user.test.mjs. A late worker writes no record.
import { tempDir } from '../lib/tempdir.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, existsSync, writeFileSync as writeFile } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { holdTimeouts } from '../core/fake-time.mjs';
import { listenOnce } from '../core/event-lib.mjs';
import { buildTemplate, copyProject, runHook, cleanEnv, mkdirSync, writeFileSync, rmSync, mkdtempSync, tmpdir, join } from './harness.mjs';

let template = ''; let base = ''; let requested = '';
before(() => {
  template = buildTemplate();
  base = tempDir('hook-hd-');
  requested = copyProject(template, base);
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'request-approval', 'LC', 'plan'], { cwd: requested, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // the user's reply must be newer than the request, by whole seconds: the request is recorded as made five seconds earlier (the same as a wait, without waiting)
  const ap = join(requested, '.agents/runs/LC/approvals');
  for (const n of readdirSync(ap)) {
    const f = join(ap, n); const t = readFileSync(f, 'utf8');
    if (/^requested_at: \d+/m.test(t)) writeFile(f, t.replace(/^requested_at: (\d+)/m, (_, x) => `requested_at: ${Number(x) - 5}`));
  }
});
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const agent = (/** @type {string} */ d, /** @type {string[]} */ args, /** @type {string} */ input = '') => spawnSync('sh', ['.agents/scripts/agent.sh', ...args], { cwd: d, input, env: cleanEnv(), encoding: 'utf8' });
/** A capture file as the hook writes it, planted with the current time by something that can write .agents/local. */
function plant(/** @type {string} */ d, /** @type {string} */ text) {
  mkdirSync(join(d, '.agents/local/prompts/history'), { recursive: true });
  const sha = createHash('sha256').update(text).digest('hex');
  const t = Math.floor(Date.now() / 1000);
  writeFileSync(join(d, '.agents/local/prompts/planted.json'), `{"session":"planted","time":${t},"sha256":"${sha}","text":"${text}"}\n`);
  writeFileSync(join(d, `.agents/local/prompts/history/${t}-${sha.slice(0, 8)}.txt`), text);
}
const approvals = (/** @type {string} */ d) => readdirSync(join(d, '.agents/runs/LC/approvals')).filter((n) => !n.includes('request'));

test('the prompt hook records the user\'s acceptance of an assumption from the message it handles, and nothing else', async () => {
  const q = (/** @type {string} */ d) => { mkdirSync(join(d, '.agents/runs/LC/questions'), { recursive: true }); writeFileSync(join(d, '.agents/runs/LC/questions/001.md'), 'asked_at: 1\nasked_session: s2\n\nASSUMPTION: AS-1\n\nIs the default 3?\n'); };
  const d = copyProject(template, base); q(d);
  await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'accept as-1 but only if it is safe' });
  assert.ok(!existsSync(join(d, '.agents/runs/LC/questions/001.answer.md')), 'a conditional acceptance records nothing');
  await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'what is the status?' });
  assert.ok(!existsSync(join(d, '.agents/runs/LC/questions/001.answer.md')), 'an ordinary message records nothing');
  await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'accept as-1', session_id: 's9' });
  assert.ok(!existsSync(join(d, '.agents/runs/LC/questions/001.answer.md')), 'a prompt of another session than the asking one records nothing');
  await runHook('node', d, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'accept as-1', session_id: 's2' });
  const file = join(d, '.agents/runs/LC/questions/001.answer.md');
  assert.ok(existsSync(file), 'the acceptance is recorded');
  assert.match(readFileSync(file, 'utf8'), /^answered_by: user/m);
});

test('a worker the hook stopped waiting for writes no record (the flag is checked before the write)', async (t) => {
  const root = mkdtempSync(join(base, 'fake-'));
  mkdirSync(join(root, '.agents/scripts/core'), { recursive: true });
  const seen = join(root, 'seen');
  const srv = await listenOnce(root);
  t.after(() => { void srv.close(); });
  // the fake worker holds in a synchronous wait (a child process that connects to the test and ends when the test sends a byte), as a worker stuck in a long command does
  const hold = `require('node:net').connect(process.argv[1], function () { this.once('data', function () { process.exit(0); }); });`;
  writeFileSync(join(root, '.agents/scripts/proofline-core.mjs'),
    `import { writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nexport const commandTable = () => [{ name: 'approve-pending', moved: true }];\nexport const run = (argv, io) => { spawnSync(process.execPath, ['-e', ${JSON.stringify(hold)}, ${JSON.stringify(srv.path)}]); writeFileSync(${JSON.stringify(seen)}, io.cancel && Atomics.load(io.cancel, 0) ? 'cancelled' : 'running'); return 0; };\n`);
  const { Agents } = await import('../../adapters/claude/hooks/lib/agent.mjs');
  const agents = new Agents({ root, mainRoot: root, agentPath: join(root, '.agents/scripts/agent.sh'), env: {}, lockWait: 8, cwd: root });
  /** @type {Worker | undefined} */ let worker;
  const on = Worker.prototype.on;
  t.mock.method(Worker.prototype, 'on', /** @this {Worker} @param {any[]} a */ function (...a) { worker ??= this; return /** @type {any} */ (on).apply(this, a); });
  holdTimeouts(t);   // the hook's budget is a timer the test fires, once the worker is inside its command
  const running = agents.run(['approve-pending', 'LC'], { budgetMs: 300 });
  const sock = await srv.first;   // the worker's command is up
  t.mock.timers.tick(300);   // the budget ends: the hook stops waiting
  const r = await running;
  assert.equal(r.timedOut, true);
  assert.ok(worker, 'the worker was started');
  const ended = once(worker, 'exit');
  sock.write('go\n');   // the command of the late worker ends; now the worker would write its record
  await ended;
  assert.notEqual(existsSync(seen) ? readFileSync(seen, 'utf8') : 'stopped', 'running', 'the worker wrote nothing as if the hook still waited');
});

test('the core of a hook rooted in a run worktree is the main tree\'s', async () => {
  const main = mkdtempSync(join(base, 'main-'));
  const wt = join(main, '.agents/local/worktrees/T-1');
  const { Agents } = await import('../../adapters/claude/hooks/lib/agent.mjs');
  const agents = new Agents({ root: wt, mainRoot: main, agentPath: join(wt, '.agents/scripts/agent.sh'), env: {}, lockWait: 8, cwd: wt });
  assert.equal(agents.coreDir, `${main}/.agents/scripts`);
});

test('a run that lives in a worktree is served by the project\'s own code; the worktree\'s agent.sh and core never run', () => {
  const d = copyProject(template, base);
  const wt = join(d, '.agents/local/worktrees/T-9');
  mkdirSync(join(wt, '.agents/runs/T-9'), { recursive: true });
  cpSync(join(d, '.agents/scripts'), join(wt, '.agents/scripts'), { recursive: true });
  cpSync(join(d, '.agents/config.yaml'), join(wt, '.agents/config.yaml'));
  writeFileSync(join(wt, '.agents/runs/T-9/RUN.yaml'), readFileSync(join(d, '.agents/runs/LC/RUN.yaml'), 'utf8'));
  const marks = ['agent.sh', 'proofline-core.mjs'].map((f) => {
    const file = join(wt, '.agents/scripts', f);
    const mark = join(d, `MARK-${f}`);
    writeFileSync(file, f.endsWith('.sh') ? `#!/bin/sh\n: > ${JSON.stringify(mark)}\n` : `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(mark)}, 'x');\n${readFileSync(file, 'utf8')}`);
    return mark;
  });
  const r = agent(d, ['pipeline', 'T-9']);
  for (const m of marks) assert.ok(!existsSync(m), `${m} ran`);
  assert.doesNotMatch(r.stderr, /run worktree's copy/, 'nothing tried to start a worktree script');
  assert.notEqual(r.status, 126);
});
