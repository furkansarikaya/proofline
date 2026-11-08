// @ts-check
// The state and session commands of `proofline` (A233, the former bin/proofline and the scenarios sc_basics, sc_state and sc_commands of tests/cli/cli-test.sh): status, resume,
// queue, deliver, clean, run, task, design, batch, debt and the commands that only print the instruction for the agent session, with the text they printed in the shell.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { VERSION, cfgv, sandbox } from './frontend-lib.mjs';

const sb = sandbox();
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');
const edit = (/** @type {string} */ f, /** @type {(t: string) => string} */ fn) => writeFileSync(f, fn(read(f)));
const git = (/** @type {string} */ d, /** @type {string[]} */ a) => spawnSync('git', ['-C', d, ...a], { env: sb.env, encoding: 'utf8' }).stdout.trim();

test('version prints proofline VERSION, the same as plugin.json; help lists the commands; an unknown command fails with the usage text and the next step', () => {
  const v = sb.pl(sb.mkrepo('v1'), ['version']);
  assert.equal(v.out, `proofline ${VERSION}\n`);
  assert.equal(sb.pl(sb.mkrepo('v2'), ['--version']).out, `proofline ${VERSION}\n`);
  assert.equal(sb.pl(sb.mkrepo('v3'), ['-v']).out, `proofline ${VERSION}\n`);
  const h = sb.pl(sb.mkrepo('v4'), ['help']);
  assert.equal(h.status, 0);
  assert.ok(h.out.startsWith('proofline: a deterministic engineering team for coding agents\n\nusage: proofline <command> [args]\n'));
  assert.ok(h.out.includes('doctor'));
  assert.equal(sb.pl(sb.mkrepo('v5'), ['--help']).out, h.out);
  assert.equal(sb.pl(sb.mkrepo('v6'), ['-h']).out, h.out);
  const u = sb.pl(sb.mkrepo('v7'), ['frobnicate']);
  assert.equal(u.status, 1);
  assert.equal(u.out, '');
  assert.ok(u.err.startsWith('proofline: a deterministic engineering team for coding agents\n'));
  assert.ok(u.err.endsWith('proofline: unknown command: frobnicate\nNext step: proofline help\n'), u.err.slice(-120));
});

test('status outside an installed project fails with the message and the instruction to init', () => {
  const r = sb.pl(sb.mkrepo('bare'), ['status']);
  assert.equal(r.status, 1);
  assert.match(r.err, /^proofline: proofline is not installed in .*bare \(\.agents\/config\.yaml missing\); run: proofline init\n/);
  assert.match(r.err, /Next step: proofline init\n$/);
});

test('status, resume, queue, run, task, design, review, audit and debug on a project with an active run print the state and the exact instruction', () => {
  const st = sb.copy('st');
  let r = sb.pl(st, ['status']);
  assert.ok(r.out.includes('no active run'), r.out);
  mkdirSync(`${st}/.agents/runs/T-1`, { recursive: true }); mkdirSync(`${st}/.agents/local`, { recursive: true }); mkdirSync(`${st}/.agents/tasks/todo`, { recursive: true });
  writeFileSync(`${st}/.agents/runs/T-1/RUN.yaml`, read(`${st}/.agents/templates/RUN.yaml`).replaceAll('<TASK-ID>', 'T-1'));
  writeFileSync(`${st}/.agents/local/ACTIVE_RUN`, 'T-1\n');
  writeFileSync(`${st}/.agents/tasks/todo/T-9.md`, '# Task: T-9 - queued\n');
  r = sb.pl(st, []);
  assert.ok(r.out.includes('active_task=T-1'), 'no command means status');
  assert.ok(r.out.includes('state=PLANNING'), 'status prints the run state, not the lead\'s internal next command (A159)');
  assert.ok(!r.out.includes('next='));
  r = sb.pl(st, ['resume']);
  assert.ok(r.out.includes('Next step: /proofline resume'), r.out);
  assert.ok(r.out.includes('run T-1\n') && r.out.includes('state=PLANNING') && r.out.includes('freshness:'), r.out);
  assert.ok(r.out.includes('An interrupted step restarts from its beginning; persisted work is trusted only after both checks pass.'));
  r = sb.pl(st, ['queue']);
  assert.ok(r.out.includes('todo/T-9.md') && r.out.includes('* T-1'), r.out);
  // A202: a finished task shows title and status only; the completion report in the file is never printed
  mkdirSync(`${st}/.agents/tasks/done`, { recursive: true });
  writeFileSync(`${st}/.agents/tasks/done/T-4-finished.md`, '# Task: T-4 - finished one\n\n**Status:** done\n\n## Goal\nx\n\n## Completion Report\n\nREPORT-SENTINEL-203\n');
  r = sb.pl(st, ['queue']);
  assert.ok(r.out.includes('done/T-4-finished.md: Task: T-4 - finished one [done]'), r.out);
  assert.ok(!r.text.includes('REPORT-SENTINEL-203'));
  rmDone(st);
  r = sb.pl(st, ['run', 'T-2']);
  assert.ok(r.out.includes('/proofline run T-2'), r.out);
  assert.match(r.err, /^proofline: run T-1 is active; one active run per worktree: finish or clean it first$/m);
  assert.ok(r.out.includes('This step needs an agent session (lead runtime: claude). In your Claude Code session say:\n  /proofline run T-2\nAny other agent that reads AGENTS.md: ask it to follow .agents/skills/proofline-lead/SKILL.md for: run T-2\n'), r.out);
  r = sb.pl(st, ['run', 'T-1']);
  assert.ok(r.out.includes('run T-1 is already active; resuming it is: proofline resume'), r.out);
  r = sb.pl(st, ['task', '--grill', 'add a lookup']);
  assert.ok(r.out.includes('task file goes to .agents/tasks/ through the markdown adapter; no run starts.'), r.out);
  assert.ok(r.out.includes('/proofline task --grill add a lookup'), r.out);
  r = sb.pl(st, ['design', 'api', '--check']);
  assert.ok(r.out.includes('/proofline design api --check'), r.out);
  assert.notEqual(sb.pl(st, ['design', 'nonsense']).status, 0);
  r = sb.pl(st, ['design', 'system']);
  assert.ok(r.out.includes('durable design documents: docs/design/DESIGN.md'), r.out);
  for (const c of ['review', 'audit', 'debug']) assert.ok(sb.pl(st, [c]).out.includes(`/proofline ${c}`), c);
  // the design documents in surfaces mode
  const single = read(`${st}/.agents/config.yaml`);
  writeFileSync(`${st}/.agents/config.yaml`, single.replace(/^ {2}design: .*$/m, '  design:\n    surfaces:\n      site:\n        doc: docs/design/SITE.md\n        paths: apps/web/**\n        mode: persuade\n      app:\n        doc: docs/design/APP.md\n        paths: apps/dashboard/**'));
  r = sb.pl(st, ['design', 'system']);
  assert.ok(r.out.includes('surfaces: site=docs/design/SITE.md app=docs/design/APP.md'), r.out);
  assert.ok(r.out.includes('shared: none'), r.out);
  edit(`${st}/.agents/config.yaml`, (t) => t.replace('    surfaces:', '    shared: docs/design/BASE.md\n    surfaces:'));
  assert.ok(sb.pl(st, ['design', 'system']).out.includes('shared: docs/design/BASE.md'));
  writeFileSync(`${st}/.agents/config.yaml`, single);
  // a Codex lead gets the Codex spelling
  edit(`${st}/.agents/config.yaml`, (t) => t.replace(/^ {2}lead:.*$/m, '  lead: codex'));
  r = sb.pl(st, ['run', 'T-2']);
  assert.ok(r.out.includes('$proofline run T-2'), r.out);
  assert.ok(r.out.includes('In your Codex session say:\n  $proofline run T-2\nor start one:\n  codex \'$proofline run T-2\'\n'), r.out);
  assert.ok(sb.pl(st, ['resume']).out.includes("codex '$proofline resume'"));
  // deliver
  const head = git(st, ['rev-parse', 'HEAD']);
  r = sb.pl(st, ['deliver', 'T-1']);
  assert.notEqual(r.status, 0);
  assert.ok(r.text.includes('delivery blocked'), r.text);
  assert.ok(r.out.includes('not deliverable yet; nothing was committed.'), r.out);
  assert.equal(git(st, ['rev-parse', 'HEAD']), head, 'deliver never commits');
  edit(`${st}/.agents/runs/T-1/RUN.yaml`, (t) => t.replace(/^ {2}state: PLANNING$/m, '  state: FAILED'));
  r = sb.pl(st, ['deliver', 'T-1']);
  assert.equal(r.status, 1);
  assert.ok(r.err.includes('delivery refused: T-1 is FAILED; to reopen: /proofline reopen T-1'), r.err);
  assert.equal(git(st, ['rev-parse', 'HEAD']), head);
  // clean
  mkdirSync(`${st}/.agents/local/prompts`, { recursive: true }); mkdirSync(`${st}/.agents/local/worktrees/T-9`, { recursive: true });
  writeFileSync(`${st}/.agents/local/prompts/s.json`, 'x'); writeFileSync(`${st}/.agents/local/worktrees/T-9/keep`, 'x');
  r = sb.pl(st, ['clean']);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /refusing to remove anything without --yes \(or a yes at the prompt\)/);
  assert.ok(r.out.includes('clean would remove:\n  .agents/local state: 1 file(s) (the ACTIVE_RUN selector is kept unless its run is cleaned)\n  finished runs: T-1\n'), r.out);
  assert.ok(existsSync(`${st}/.agents/local/prompts/s.json`), 'clean without --yes removes nothing');
  r = sb.pl(st, ['clean', '--yes']);
  assert.equal(r.status, 0, r.text);
  assert.ok(!existsSync(`${st}/.agents/local/prompts/s.json`));
  assert.ok(existsSync(`${st}/.agents/local/worktrees/T-9/keep`), 'clean --yes keeps the run worktrees (A169)');
});
/** @param {string} st */
function rmDone(st) { spawnSync('rm', ['-rf', `${st}/.agents/tasks/done`]); }

test('clean on a project with nothing to remove says so; resume without an active run says so and prints the instruction', () => {
  const d = sb.copy('cl');
  const r = sb.pl(d, ['clean', '--yes']);
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('nothing to clean'), r.out);
  const rs = sb.pl(d, ['resume']);
  assert.ok(rs.out.startsWith('no active run to resume. Queue: proofline queue\n\nThis step needs an agent session (lead runtime: claude).'), rs.out);
});

test('the commands that only print an instruction check their arguments first: task, run, deliver, design ui, docs, explain, wiki, product, trace, knowledge, reopen, batch', () => {
  const d = sb.copy('usage');
  /** @param {string[]} a @param {RegExp} err */
  const bad = (a, err) => { const r = sb.pl(d, a); assert.equal(r.status, 1, a.join(' ')); assert.match(r.err, err, a.join(' ')); };
  bad(['task'], /^proofline: usage: proofline task \[--grill\] <text>$/m);
  bad(['task', '--grill'], /usage: proofline task \[--grill\] <text>/);
  bad(['run'], /^proofline: usage: proofline run <TASK>$/m);
  bad(['deliver'], /^proofline: usage: proofline deliver <TASK>$/m);
  bad(['design'], /usage: proofline design system\|data\|api\|ui \[--check\] \| design ui <mode> <target>/);
  bad(['design', 'ui', 'sparkle', 'x'], /unknown design ui mode: sparkle \(want bolder\|quieter\|polish\|animate\|typeset\|colorize\|layout\|delight\|harden\|adapt\)/);
  bad(['design', 'ui', 'bolder'], /usage: proofline design ui bolder <target>  \(the page, section or component to change\)/);
  bad(['docs'], /usage: proofline docs create\|update\|audit/);
  bad(['explain'], /usage: proofline explain <topic\|TASK-ID>/);
  bad(['wiki', 'x'], /usage: proofline wiki ingest\|query\|lint/);
  bad(['product', 'prd'], /usage: proofline product prd\|review\|split\|outcome <slug>/);
  bad(['product', 'discover', 'frame'], /usage: proofline product discover frame\|research\|interviews\|competitors\|opportunities <slug>/);
  bad(['product', 'discover', 'nope', 'x'], /usage: proofline product discover frame\|research/);
  bad(['product', 'assess', 'decision'], /usage: proofline product assess assumptions\|probes\|premortem\|redteam\|decision <slug>/);
  bad(['product', 'bogus'], /usage: proofline product prd\|review\|split\|outcome\|discover\|assess \.\.\. <slug>/);
  bad(['trace'], /usage: proofline trace <FR-n\|TASK-ID>/);
  bad(['knowledge'], /usage: proofline knowledge <TASK>/);
  bad(['reopen'], /usage: proofline reopen <TASK>/);
  bad(['batch', 'run'], /proofline batch run is gone \(removed in 0\.0\.32\)/);
  const ok = (/** @type {string[]} */ a, /** @type {string} */ needle) => { const r = sb.pl(d, a); assert.equal(r.status, 0, `${a.join(' ')}: ${r.text}`); assert.ok(r.out.includes(needle), `${a.join(' ')}: ${r.out}`); };
  ok(['design', 'ui', 'bolder', 'the hero'], 'focused UI change: mode bolder, only the target; it is a normal run (TRIVIAL or STANDARD) and the target is checked afterwards.');
  ok(['docs', 'create'], '/proofline docs create');
  ok(['product', 'discover', 'frame', 'my-slug'], '/proofline product discover frame my-slug');
  ok(['knowledge', 'T-3'], '/proofline knowledge T-3');
  ok(['reopen', 'T-3'], '/proofline reopen T-3');
  ok(['batch'], '/proofline batch');
  ok(['batch', 'T-1', 'T-2'], 'night mode runs in the lead\'s session: one summary, one "approve batch"');
  ok(['trace', 'FR-1'], '/proofline trace FR-1');
  // none of them needs the project: the check of the arguments comes first, the install check second
  const bare = sb.mkrepo('usage-bare');
  assert.match(sb.pl(bare, ['docs']).err, /usage: proofline docs/);
  assert.match(sb.pl(bare, ['docs', 'audit']).err, /proofline is not installed in/);
});

test('a task text is printed as typed, UTF-8 included, and a path with a non-ASCII name is printed back as it is', () => {
  const d = sb.copy('utf8-é');
  const r = sb.pl(d, ['task', 'ekle: şifre sıfırlama ✓']);
  assert.ok(r.out.includes('/proofline task ekle: şifre sıfırlama ✓'), r.out);
  const bare = sb.mkrepo('bare-é');
  assert.ok(sb.pl(bare, ['status']).err.includes('bare-é'), 'the path in the message');
});

test('debt and batch status run the project\'s agent.sh and return its status', () => {
  const d = sb.copy('debt');
  const r = sb.pl(d, ['debt']);
  assert.equal(r.status, 0, r.text);
  const b = sb.pl(d, ['batch', 'status']);
  assert.equal(b.status, 0, b.text);
});

// A200: empty commands.* are discovered, proven by one run, proposed with one question; only the user's own yes writes, only proven commands
test('doctor --commands: a failed trial is not proven and writes no proposal; a proven command is proposed with one question; --apply-commands writes it only after the user\'s own "approve commands"', async () => {
  const cm = sb.mkrepo('cmds');
  const init = sb.pl(cm, ['init', '--yes', '--runtimes', 'claude']);
  assert.ok(init.out.includes('proofline doctor --commands'), init.out);
  writeFileSync(`${cm}/package.json`, '{"scripts":{"test":"jest"}}');
  const mk = (/** @type {string} */ name, /** @type {number} */ code) => { const dir = path.join(sb.T, name); mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/npm`, `#!/bin/sh\nexit ${code}\n`); chmodSync(`${dir}/npm`, 0o755); return dir; };
  const bad = mk('stubbad', 1); const good = mk('stubok', 0);
  let r = sb.pl(cm, ['doctor', '--commands'], { PATH: `${bad}:${sb.env.PATH}` });
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('trial failed'), r.out);
  assert.ok(!existsSync(`${cm}/.agents/local/commands/PROPOSAL.tsv`));
  r = sb.pl(cm, ['doctor', '--commands'], { PATH: `${good}:${sb.env.PATH}` });
  assert.equal(r.status, 0, r.text);
  assert.ok(r.out.includes('QUESTION (one): write these into .agents/config.yaml?'), r.out);
  assert.ok(r.out.includes('commands.test: npm test'), r.out);
  assert.equal(cfgv(cm, 'commands.test'), '', 'nothing is written before the user answers');
  assert.notEqual(sb.pl(cm, ['doctor', '--apply-commands']).status, 0);
  assert.equal(cfgv(cm, 'commands.test'), '');
  mkdirSync(`${cm}/.agents/local/prompts`, { recursive: true });
  await new Promise((res) => setTimeout(res, 1100)); // the reply is newer than the request, and stamped with the real time
  writeFileSync(`${cm}/.agents/local/prompts/s1.json`, `${JSON.stringify({ session: 's1', time: Math.floor(Date.now() / 1000), sha256: createHash('sha256').update('approve commands').digest('hex'), text: 'approve commands' })}\n`);
  spawnSync('sh', ['.agents/scripts/agent.sh', 'approve-pending'], { cwd: cm, env: sb.env });
  r = sb.pl(cm, ['doctor', '--apply-commands']);
  assert.equal(r.status, 0, r.text);
  assert.equal(cfgv(cm, 'commands.test'), 'npm test');
  assert.equal(cfgv(cm, 'commands.build'), '');
  assert.notEqual(sb.pl(cm, ['doctor', '--apply-commands']).status, 0, 'the proposal is used up');
});

test('clean removes a link inside .agents/local as a link and never touches what it points to (find -P: S1 of the fix round)', () => {
  const d = sb.copy('cl-link');
  const victim = path.join(sb.T, 'victim-dir');
  mkdirSync(victim, { recursive: true });
  writeFileSync(`${victim}/precious.txt`, 'keep\n');
  mkdirSync(`${d}/.agents/local/z`, { recursive: true });
  writeFileSync(`${d}/.agents/local/z/a`, 'x');
  mkdirSync(`${d}/.agents/local/y`, { recursive: true });
  symlinkSync(victim, `${d}/.agents/local/y/link`);
  symlinkSync(victim, `${d}/.agents/local/toplink`);
  const r = sb.pl(d, ['clean', '--yes']);
  assert.equal(r.status, 0, r.text);
  assert.equal(read(`${victim}/precious.txt`), 'keep\n');
  assert.ok(!existsSync(`${d}/.agents/local/z`) && !existsSync(`${d}/.agents/local/toplink`) && !existsSync(`${d}/.agents/local/y`));
});

test('clean does not follow .agents/local itself when it is a link', () => {
  const d = sb.copy('cl-toplink');
  const victim = path.join(sb.T, 'victim-local');
  mkdirSync(victim, { recursive: true });
  writeFileSync(`${victim}/precious.txt`, 'keep\n');
  spawnSync('rm', ['-rf', `${d}/.agents/local`]);
  symlinkSync(victim, `${d}/.agents/local`);
  sb.pl(d, ['clean', '--yes']);
  assert.equal(read(`${victim}/precious.txt`), 'keep\n');
});
