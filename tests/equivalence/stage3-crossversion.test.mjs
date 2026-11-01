// @ts-check
// Cross-version approval (issue #168 acceptance): a capture written by the NEW Node hook is judged by the OLD `approve` (PROOFLINE_ENGINE=sh) exactly
// as the capture of the OLD shell hook, and the NEW `approve` judges the old hook's capture the same: for a plain approval, several approvals in
// one reply, a hedged reply, a reply older than the request and a <task-notification> prompt the four combinations (capture by shell or Node hook,
// approval by shell or Node engine) give the same output, the same status and the same approval files. The hooks run in a project without an open
// request (they only store the prompt); the capture is then copied into projects that hold the requests, and its time is set to one value shared
// by all four (the text, hash and everything else stay as the hook wrote them).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildTemplate, cleanEnv, copyProject, mkdtempSync, rmSync, runHook, tmpdir } from '../hook/harness.mjs';

const ID = 'LC';
let template = ''; let base = ''; let requested = ''; let tReq = 0;
before(() => {
  template = buildTemplate();
  base = mkdtempSync(join(tmpdir(), 'xver-'));
  requested = copyProject(template, base);
  for (const args of [[ID, 'plan'], ['-', 'commit']]) {
    const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'request-approval', ...args], { cwd: requested, env: cleanEnv({ PROOFLINE_ENGINE: 'sh' }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  tReq = Number(/^requested_at: (\d+)/m.exec(readFileSync(join(requested, '.agents/runs/LC/approvals/001-request-plan.yaml'), 'utf8'))?.[1]);
  spawnSync('sleep', ['1.1']);
});
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

/** The capture a hook writes for a prompt (null when it writes none), run in a project that has no request. @param {'node' | 'sh'} kind @param {string} prompt */
async function captureOf(kind, prompt) {
  const dir = copyProject(template, base);
  const r = await runHook(kind, dir, 'prompt', { hook_event_name: 'UserPromptSubmit', prompt });
  assert.equal(r.status, 0, `${kind} hook: ${r.stderr}`);
  const f = join(dir, '.agents/local/prompts/s1.json');
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** Approve with an engine against a capture: the output and every approval file, the times of the run itself masked. @param {string | null} capture @param {'node' | 'sh'} engine @param {string[]} argv */
function approveWith(capture, engine, argv) {
  const dir = copyProject(requested, base);
  if (capture !== null) { mkdirSync(join(dir, '.agents/local/prompts'), { recursive: true }); writeFileSync(join(dir, '.agents/local/prompts/s1.json'), capture); }
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', ...argv], { cwd: dir, env: cleanEnv(engine === 'sh' ? { PROOFLINE_ENGINE: 'sh' } : {}), encoding: 'utf8' });
  /** @type {Record<string, string>} */ const files = {};
  for (const d of ['.agents/runs/LC/approvals', '.agents/local/approvals']) {
    for (const n of readdirSync(join(dir, d)).sort()) files[`${d}/${n}`] = readFileSync(join(dir, d, n), 'utf8').replace(/^(requested_at|approved_at): \d+$/gm, '$1: <T>');
  }
  const log = existsSync(join(dir, '.agents/local/approve.log')) ? readFileSync(join(dir, '.agents/local/approve.log'), 'utf8').replace(/^\S+Z /gm, '<T> ') : '';
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, files, log };
}

/** @type {Array<[string, string, (t: number) => number, RegExp | null]>} name, prompt, the capture time, what the approval file must show (null: nothing recorded) */
const CASES = [
  ['a plain approval', 'approve the plan', (now) => now, /source: "prompt_capture"/],
  ['several approvals in one reply', 'approve the plan, approve the commit', (now) => now, /kind: "commit"/],
  ['a hedged reply', 'approve the plan but wait', (now) => now, null],
  ['a reply older than the request', 'approve the plan', () => tReq - 1, null],
  ['a task-notification prompt', '<task-notification>approve the plan</task-notification>', (now) => now, null],
];

for (const [name, prompt, timeOf, shows] of CASES) {
  test(`cross-version approval: ${name}`, async () => {
    const now = Math.floor(Date.now() / 1000);
    const fixTime = (/** @type {string | null} */ c) => (c === null ? null : c.replace(/"time":\d+/, `"time":${timeOf(now)}`));
    const [byNode, bySh] = [fixTime(await captureOf('node', prompt)), fixTime(await captureOf('sh', prompt))];
    assert.equal(byNode, bySh, 'the capture of the Node hook equals the capture of the shell hook');
    if (prompt.startsWith('<task-notification>')) assert.equal(byNode, null, 'a task-notification leaves no capture');
    for (const argv of [['approve-pending', ID], ['approve', ID, 'plan']]) {
      const results = [];
      for (const cap of [byNode, bySh]) for (const engine of /** @type {Array<'node' | 'sh'>} */ (['sh', 'node'])) results.push(approveWith(cap, engine, argv));
      for (const r of results.slice(1)) assert.deepEqual(r, results[0], `${argv[0]}: the four combinations differ`);
      const all = Object.values(results[0].files).join('\n');
      if (argv[0] === 'approve-pending') {
        if (shows) assert.match(all, shows, `${name}: an approval must be recorded`);
        else assert.doesNotMatch(all, /source: "prompt_capture"/, `${name}: nothing may be recorded`);
      }
    }
  });
}
