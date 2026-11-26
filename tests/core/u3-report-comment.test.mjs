// @ts-check
// A369 (issue 338 U3): the completion report does not grow the task. A markdown task file keeps a pointer of a few lines and the report is a sibling file
// under the task's own folder; a GitHub issue gets the report as one bounded, neutralised comment (never the issue body). `gh` is a fake function
// (argv recorded); nothing here touches a network.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AdapterExit } from '../../control-plane/agents/scripts/core/adapters/lib.mjs';
import { runGithub } from '../../control-plane/agents/scripts/core/adapters/github.mjs';
import { runMarkdown } from '../../control-plane/agents/scripts/core/adapters/markdown.mjs';
import { reportComment, COMMENT_LIMIT } from '../../control-plane/agents/scripts/core/adapters/comment.mjs';
import { repo } from './helpers.mjs';

const CP = path.join(repo, 'control-plane/agents');
const write = (/** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, t); };
const read = (/** @type {string} */ f) => readFileSync(f, 'utf8');

/** @param {string} [name] */
function setup(name = 'markdown adapter') {
  const root = tempDir('u3-');
  mkdirSync(`${root}/.agents`, { recursive: true });
  cpSync(`${CP}/templates`, `${root}/.agents/templates`, { recursive: true });
  const o = { out: '', err: '' };
  /** @type {any} */
  const a = { root, cwd: root, env: {}, name, tasksDir: '.agents/tasks', out: (/** @type {string} */ s) => { o.out += s; }, err: (/** @type {string} */ s) => { o.err += s; } };
  /** @param {(a: any, argv: string[]) => any} fn @param {string[]} argv */
  const run = async (fn, argv) => { o.out = ''; o.err = ''; try { await fn(a, argv); return { code: 0, ...o }; } catch (e) { if (e instanceof AdapterExit) return { code: e.code, ...o }; throw e; } };
  return { root, run };
}

const REPORT = ['# Completion Report: T-1', '', '## Implementation Summary', 'done', '', 'Changed: the lookup returns the default', ...Array.from({ length: 300 }, (_, i) => `line ${i} of a long evidence table`), ''].join('\n');

test('markdown publish: the task file gets a pointer of at most 10 lines, the report is a sibling file under the task folder, verify reads the sibling', async () => {
  const { root, run } = setup();
  const md = (/** @type {string[]} */ argv) => run(runMarkdown, argv);
  const f = '.agents/tasks/in-progress/T-1-lookup.md';
  write(`${root}/${f}`, '# Task: T-1 — Lookup\n\n**Status:** in-progress\n\n## Goal\n\ng\n');
  write(`${root}/.agents/runs/T-1/RUN.yaml`, `task_source:\n  type: local_markdown\n  path: ${f}\n  revision: x\n`);
  write(`${root}/rep.md`, REPORT);
  const before = read(`${root}/${f}`);
  const p = await md(['publish', 'T-1', `${root}/rep.md`]);
  assert.equal(p.code, 0, p.err);
  const rcpt = p.out.trim();
  assert.match(rcpt, new RegExp(`^${f}#[0-9a-f]{64}$`));
  const t = read(`${root}/${f}`);
  const block = t.slice(t.indexOf('<!-- COMPLETION-REPORT:BEGIN:T-1 -->'), t.indexOf('<!-- COMPLETION-REPORT:END:T-1 -->'));
  assert.ok(block.split('\n').length <= 10, block);
  assert.ok(block.includes('Report: .agents/tasks/T-1/COMPLETION_REPORT.md'), block);
  assert.ok(!t.includes('line 100 of a long evidence table'), 'the report text is in the task file');
  assert.ok(t.length - before.length < 600, `the task grew by ${t.length - before.length} bytes`);
  assert.equal(read(`${root}/.agents/tasks/T-1/COMPLETION_REPORT.md`), REPORT);
  assert.equal((await md(['verify', 'T-1', rcpt])).code, 0);
  assert.equal((await md(['verify', 'T-1', `${root}/rep.md`])).code, 0, 'a report file in place of the receipt');
  // idempotent
  assert.equal((await md(['publish', 'T-1', `${root}/rep.md`])).out.trim(), rcpt);
  assert.equal(read(`${root}/${f}`), t);
  // the sibling is the evidence: a changed sibling or a pointer to another file no longer verifies
  writeFileSync(`${root}/.agents/tasks/T-1/COMPLETION_REPORT.md`, `${REPORT}tampered\n`);
  assert.equal((await md(['verify', 'T-1', rcpt])).code, 1, 'verify passed with a changed sibling report');
  writeFileSync(`${root}/.agents/tasks/T-1/COMPLETION_REPORT.md`, REPORT);
  writeFileSync(`${root}/${f}`, t.replace('Report: .agents/tasks/T-1/COMPLETION_REPORT.md', 'Report: ../../etc/passwd'));
  assert.equal((await md(['verify', 'T-1', rcpt])).code, 1, 'verify followed a pointer outside the task folder');
  // the sibling is never found as a task file
  writeFileSync(`${root}/${f}`, t);
  assert.ok(existsSync(`${root}/.agents/tasks/T-1/COMPLETION_REPORT.md`));
  writeFileSync(`${root}/.agents/runs/T-1/RUN.yaml`, 'x: y\n');
  const st = await md(['status', 'T-1', 'done']);
  assert.equal(st.code, 0, st.err);
  assert.ok(st.out.trim().endsWith('done/T-1-lookup.md'), st.out);
});

test('markdown verify still accepts a report that an earlier version wrote into the task file', async () => {
  const { root, run } = setup();
  const md = (/** @type {string[]} */ argv) => run(runMarkdown, argv);
  const f = '.agents/tasks/done/T-2-old.md';
  const rep = '# Completion Report: T-2\n\nold style\n';
  const h = createHash('sha256').update(rep).digest('hex');
  write(`${root}/${f}`, `# Task: T-2 — Old\n\n## Completion Report\n\n<!-- COMPLETION-REPORT:BEGIN:T-2 -->\n${rep}<!-- COMPLETION-REPORT:END:T-2 -->\n`);
  write(`${root}/.agents/runs/T-2/RUN.yaml`, `task_source:\n  type: local_markdown\n  path: ${f}\n  revision: x\n`);
  assert.equal((await md(['verify', 'T-2', `${f}#${h}`])).code, 0);
});

/** A fake gh that records argv and serves one issue with comments. */
function fakeGh() {
  const st = { argv: /** @type {string[]} */ ([]), comments: /** @type {Array<{ body: string, url: string }>} */ ([]), body: 'original body', commentFails: false, repoName: 'o/r' };
  /** @param {string[]} args */
  const gh = (args) => {
    st.argv.push(args.join(' '));
    const ok = (/** @type {string} */ out = '') => ({ status: 0, out, err: '' });
    if (args[0] === '--version') return ok('gh 2');
    if (args[0] === 'auth') return ok();
    if (args[0] === 'repo' && args[1] === 'view') return ok(JSON.stringify({ nameWithOwner: st.repoName }));
    if (args[0] === 'issue' && args[1] === 'view') return ok(JSON.stringify({ comments: st.comments, labels: [], body: st.body }));
    if (args[0] === 'issue' && args[1] === 'comment') {
      if (st.commentFails) return { status: 1, out: '', err: 'HTTP 502' };
      st.comments.push({ body: readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'), url: 'https://github.com/o/r/issues/42#issuecomment-9' });
      return ok();
    }
    if (args[0] === 'issue' && args[1] === 'edit') return ok();
    return { status: 1, out: '', err: '' };
  };
  return { st, gh };
}

test('github publish: one comment, the issue body is never edited, mentions are neutralised, a secret line is withheld, the size is bounded', async () => {
  const { root, run } = setup('github adapter');
  const { st, gh } = fakeGh();
  const gha = (/** @type {string[]} */ argv) => run((a, v) => runGithub({ ...a, gh }, v), argv);
  const rep = ['# Completion Report: GH-42', '', 'Thanks @octocat and @org/team, mail a@b.example is fine, `@code` stays.', '```', '@insidefence', '```', 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"', '![x](https://evil.example/p.png)', 'tail', ''].join('\n');
  write(`${root}/rep.md`, rep);
  const r = await gha(['publish', 'GH-42', `${root}/rep.md`]);
  assert.equal(r.code, 0, r.err);
  assert.equal(st.comments.length, 1);
  const b = st.comments[0].body;
  assert.ok(b.startsWith('<!-- proofline:completion-report:GH-42 sha256:'));
  assert.ok(b.includes('`@octocat`') && b.includes('`@org/team`'), b);
  assert.ok(!/(^|[^`\w])@octocat/.test(b), 'a bare mention is left');
  assert.ok(b.includes('@insidefence') && b.includes('`@code`'));
  assert.ok(!b.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'a secret was posted');
  assert.ok(r.err.includes('withheld'), r.err);
  assert.ok(!b.includes('![x]'), 'an image was posted');
  assert.ok(!st.argv.some((x) => /issue edit .*--body|issue edit .*-b /.test(x)), 'the issue body was edited');
  // size
  write(`${root}/big.md`, `# R\n${'x'.repeat(100).concat('\n').repeat(2000)}`);
  st.comments = [];
  assert.equal((await gha(['publish', 'GH-42', `${root}/big.md`])).code, 0);
  assert.ok(Buffer.byteLength(st.comments[0].body) <= COMMENT_LIMIT, String(Buffer.byteLength(st.comments[0].body)));
  assert.ok(st.comments[0].body.includes('truncated'), 'no truncation note');
});

test('github publish: a failed post names the retry and the report in the run; a comment that only quotes the marker cannot satisfy verify; a foreign source repo is refused', async () => {
  const { root, run } = setup('github adapter');
  const { st, gh } = fakeGh();
  const gha = (/** @type {string[]} */ argv) => run((a, v) => runGithub({ ...a, gh }, v), argv);
  write(`${root}/rep.md`, '# R\nbody\n');
  st.commentFails = true;
  const r = await gha(['publish', 'GH-42', `${root}/rep.md`]);
  assert.equal(r.code, 1);
  assert.ok(/retry|again/.test(r.err) && r.err.includes('COMPLETION_REPORT.md'), r.err);
  st.commentFails = false;
  const ok = await gha(['publish', 'GH-42', `${root}/rep.md`]);
  const rc = ok.out.trim();
  st.comments = [{ body: `look: ${st.comments[0].body}`, url: 'u#issuecomment-1' }];
  assert.equal((await gha(['verify', 'GH-42', rc])).code, 1, 'a comment that only quotes the marker satisfied verify');
  // the run came from another repository's issue: nothing is posted to this one
  write(`${root}/.agents/runs/GH-7/TASK.md`, '# Task: GH-7 — x\n\n## Context\n\nSource: github https://github.com/other/proj/issues/7\n');
  st.comments = []; st.argv = [];
  const x = await gha(['publish', 'GH-7', `${root}/rep.md`]);
  assert.equal(x.code, 1);
  assert.ok(x.err.includes('other/proj'), x.err);
  assert.ok(!st.argv.some((a) => a.startsWith('issue comment')));
  write(`${root}/.agents/runs/GH-8/TASK.md`, '# Task: GH-8 — x\n\n## Context\n\nSource: github https://github.com/o/r/issues/8\n');
  assert.equal((await gha(['publish', 'GH-8', `${root}/rep.md`])).code, 0);
});

test('reportComment: unit cases of the neutraliser', () => {
  const c = (/** @type {string} */ t) => reportComment('GH-1', 'h', t).body;
  assert.ok(c('hi @a-b_c and (@x)').includes('`@a-b_c`') && c('(@x)').includes('(`@x`)'));
  assert.ok(c('a@b.c').includes('a@b.c') && !c('a@b.c').includes('`'));
  assert.ok(c('~~~\n@in\n~~~\n@out').includes('~~~\n@in\n~~~\n`@out`'));
  // an unclosed fence keeps what follows inert and a truncation closes it
  const big = reportComment('GH-1', 'h', `\`\`\`\n${'y'.repeat(70000)}`);
  assert.ok(Buffer.byteLength(big.body) <= COMMENT_LIMIT && big.truncated);
  assert.equal((big.body.match(/^```$/gm) ?? []).length % 2, 0, 'a fence was left open');
});
