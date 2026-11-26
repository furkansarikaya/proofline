// @ts-check
// A369 (issue 338 U3): the completion report does not grow the task. A markdown task file keeps a pointer of a few lines and the report is a sibling file
// under the task's own folder; a GitHub issue gets the report as one bounded, neutralised comment (never the issue body). `gh` is a fake function
// (argv recorded); nothing here touches a network.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AdapterExit } from '../../control-plane/agents/scripts/core/adapters/lib.mjs';
import { runGithub } from '../../control-plane/agents/scripts/core/adapters/github.mjs';
import { runMarkdown } from '../../control-plane/agents/scripts/core/adapters/markdown.mjs';
import { reportComment, COMMENT_LIMIT } from '../../control-plane/agents/scripts/core/adapters/comment.mjs';
import { restoreSibling } from '../../control-plane/agents/scripts/core/complreport.mjs';
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
  const st = { argv: /** @type {string[]} */ ([]), comments: /** @type {Array<{ body: string, url: string, author?: { login: string } }>} */ ([]), body: 'original body', commentFails: false, repoName: 'o/r', patched: 0 };
  /** @param {string[]} args */
  const gh = (args) => {
    st.argv.push(args.join(' '));
    const ok = (/** @type {string} */ out = '') => ({ status: 0, out, err: '' });
    if (args[0] === '--version') return ok('gh 2');
    if (args[0] === 'auth') return ok();
    if (args[0] === 'api' && args[1] === 'user') return ok(JSON.stringify({ login: 'me' }));
    if (args[0] === 'api') {
      const f = args.find((x) => x.startsWith('body=@'));
      const cid = /comments\/([0-9]+)/.exec(args.join(' '))?.[1];
      const c = st.comments.find((x) => x.url.endsWith(`#issuecomment-${cid}`));
      if (!f || !c) return { status: 1, out: '', err: '' };
      c.body = readFileSync(f.slice(6), 'utf8'); st.patched++;
      return ok();
    }
    if (args[0] === 'repo' && args[1] === 'view') return ok(JSON.stringify({ nameWithOwner: st.repoName }));
    if (args[0] === 'issue' && args[1] === 'view') return ok(JSON.stringify({ comments: st.comments, labels: [], body: st.body }));
    if (args[0] === 'issue' && args[1] === 'comment') {
      if (st.commentFails) return { status: 1, out: '', err: 'HTTP 502' };
      st.comments.push({ body: readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'), url: 'https://github.com/o/r/issues/42#issuecomment-9', author: { login: 'me' } });
      return ok();
    }
    if (args[0] === 'issue' && args[1] === 'edit') return ok();
    return { status: 1, out: '', err: '' };
  };
  return { st, gh };
}

test('github publish: one comment, the issue body is never edited, the size is bounded, remote content and reference definitions are text', async () => {
  const { root, run } = setup('github adapter');
  const { st, gh } = fakeGh();
  const gha = (/** @type {string[]} */ argv) => run((a, v) => runGithub({ ...a, gh }, v), argv);
  const rep = ['# Completion Report: GH-42', '', '![x](https://evil.example/p.png) ![a][b] [ok](https://example.com/page)', '[b]: http://evil.example/beacon.png', '<picture><source srcset="http://e/x"><img src="http://e/y"></picture>', '<video src="http://e/v"></video><audio src="a"></audio><iframe src="i"></iframe><embed src="e"><object data="o"></object><link rel="stylesheet" href="h"><svg><use href="http://e/s"/></svg>', 'tail', ''].join('\n');
  write(`${root}/rep.md`, rep);
  const r = await gha(['publish', 'GH-42', `${root}/rep.md`]);
  assert.equal(r.code, 0, r.err);
  assert.equal(st.comments.length, 1);
  const b = st.comments[0].body;
  assert.ok(b.startsWith('<!-- proofline:completion-report:GH-42 sha256:'));
  assert.ok(!b.includes('![') && !/^\[b\]:/m.test(b), b);
  assert.ok(!/<(picture|source|video|audio|iframe|embed|object|link|svg|use|img)\b/i.test(b), b);
  assert.ok(b.includes('[ok](https://example.com/page)'), 'an ordinary link was changed');
  assert.ok(!st.argv.some((x) => /issue edit .*--body|issue edit .*-b /.test(x)), 'the issue body was edited');
  write(`${root}/big.md`, `# R\n${'x'.repeat(100).concat('\n').repeat(2000)}`);
  st.comments = [];
  assert.equal((await gha(['publish', 'GH-42', `${root}/big.md`])).code, 0);
  assert.ok(Buffer.byteLength(st.comments[0].body) <= COMMENT_LIMIT, String(Buffer.byteLength(st.comments[0].body)));
  assert.ok(st.comments[0].body.includes('truncated'), 'no truncation note');
});

test('github publish: a report with a secret anywhere is refused whole (PEM block, a token split over two lines, a fence, a table); nothing is posted', async () => {
  const { root, run } = setup('github adapter');
  const { st, gh } = fakeGh();
  const gha = (/** @type {string[]} */ argv) => run((a, v) => runGithub({ ...a, gh }, v), argv);
  const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const cases = {
    pem: `# R\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdefghijklmnop\nqrstuvwxyz==\n-----END RSA PRIVATE KEY-----\n`,
    pemSplitHeader: '# R\n-----BEGIN RSA\nPRIVATE KEY-----\nAAAA\n',
    split: `# R\nthe token is ${tok.slice(0, 20)}\n${tok.slice(20)} end\n`,
    fence: `# R\n\`\`\`\nx = "${tok}"\n\`\`\`\n`,
    table: `# R\n| name | value |\n|---|---|\n| t | ${tok} |\n`,
    tableSplit: `# R\n| t | ${tok.slice(0, 12)} |\n| u | ${tok.slice(12)} |\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    write(`${root}/s.md`, text);
    st.comments = []; st.argv = [];
    const r = await gha(['publish', 'GH-42', `${root}/s.md`]);
    assert.equal(r.code, 1, `${name}: published`);
    assert.ok(r.err.includes('nothing was posted') && r.err.includes('COMPLETION_REPORT.md'), `${name}: ${r.err}`);
    assert.equal(st.comments.length, 0, name);
    assert.ok(!st.argv.some((x) => x.startsWith('issue comment') || x.includes('PATCH')), name);
  }
  write(`${root}/ok.md`, '# R\nno secret here, a sha256 abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 and words\n');
  assert.equal((await gha(['publish', 'GH-42', `${root}/ok.md`])).code, 0, 'a report without a secret was refused');
});

test('mentions: every `@name` that GitHub could take is broken, wherever it stands; an address with a word character before the @ is left', () => {
  const Z = '​';
  const body = (/** @type {string} */ t) => Buffer.from(reportComment('GH-1', 'h', Buffer.from(t, 'utf8').toString('latin1')).body, 'latin1').toString('utf8');
  /** a name still matches GitHub's filter when `@` is preceded by a non-word character (or the start) and followed by a name character */
  const mentions = (/** @type {string} */ t) => [...t.split('\n').slice(1).join('\n').matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_-])/g)].length;
  for (const input of ['a.@v1', 'x-@v2', 'path/@v3', '\\@v4', '@@v6', '`@v5', '<div>\n```\n@v9', '@org/team', 'plain @octocat here', '[@link text](https://x)', '<a title="@attr">x</a>', '(@x)', '"@y"', '@-@v7', '@a@b', 'line\n@start', '> @quoted', '- @item', '| @cell |', '```\n@infence\n```', '`@span`', 'é@v8']) {
    assert.equal(mentions(body(input)), 0, `${JSON.stringify(input)} -> ${JSON.stringify(body(input))}`);
  }
  // a character reference that decodes to `@` reaches GitHub's filter as a real `@`: none of the spellings may parse as a reference any more
  for (const ent of ['&#64;', '&#x40;', '&#X40;', '&#0064;', '&#x0040;', '&#64', '&#x40', '&commat;', '&COMMAT;', '&amp;#64;']) {
    const out = body(`hi ${ent}victim and (${ent}v2)`);
    assert.ok(!/&(#|commat)/i.test(out.replace(/&amp;#64;/g, '')) || ent === '&amp;#64;', `${ent} -> ${JSON.stringify(out)}`);
  }
  assert.ok(body('&lt;b&gt; &amp; &quot;x&quot;').includes('&lt;b&gt; &amp; &quot;x&quot;'), 'an ordinary entity was changed');
  assert.ok(body('a@b.c').includes('a@b.c'), 'an address was changed');
  assert.ok(body('@octocat').includes(`＠${Z}octocat`));
  // A377: a U+FF20 already in the report folds to `@` under NFKC, so it gets the zero-width space too
  assert.ok(body('＠name').includes(`＠${Z}name`));
  assert.ok(body('﹫name').includes(`﹫${Z}name`));
});

// A377 (A369.1): what GitHub does with U+200B cannot be observed without posting to GitHub, and no test calls GitHub. So this pins that the sanitiser does not
// rest on U+200B alone: each of the two layers on its own leaves no mention. Layer 1, GitHub strips every U+200B (and every other zero-width or format
// character): no ASCII `@` is left after a non-word character. Layer 2, a normalisation folds U+FF20 and the other compatibility forms back (NFKC): the
// zero-width space still stands between `@` and the name. A character reference is decoded once (as HTML is) in both cases.
test('mentions: neither U+200B nor U+FF20 alone carries the neutralisation; every mention form stays broken when either is undone', () => {
  const body = (/** @type {string} */ t) => Buffer.from(reportComment('GH-1', 'h', Buffer.from(t, 'utf8').toString('latin1')).body, 'latin1').toString('utf8').split('\n').slice(1).join('\n');
  /** one HTML decode (what reaches the filter after rendering): every numeric reference, and the named ones that give `@`, `&` or a zero-width character @param {string} t */
  const NAMED = { commat: '@', amp: '&', zerowidthspace: '\u200b', shy: '\u00ad', nobreak: '\u2060', zwnj: '\u200c', zwj: '\u200d' };
  const decode = (t) => t.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));?/g, (m, x, d, n) => {
    if (x !== undefined || d !== undefined) { const cp = x !== undefined ? parseInt(x, 16) : Number(d); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    return NAMED[/** @type {keyof typeof NAMED} */ (n.toLowerCase())] ?? m;
  });
  const stripZw = (/** @type {string} */ t) => t.replace(/[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]/g, '');
  const fold = (/** @type {string} */ t) => t.normalize('NFKC');
  // `_` is not excluded before the `@`: emphasis (`_@name_`) renders the `@` at the start of a text node, where GitHub's filter takes it.
  // The model: decode once, then undo one layer (strip every zero-width character, or fold by NFKC), then GitHub's filter.
  const count = (/** @type {string} */ t, /** @type {(s: string) => string} */ undo = (x) => x) => [...undo(decode(t)).matchAll(/(^|[^A-Za-z0-9])@([A-Za-z0-9_-])/g)].length;
  const mentions = (/** @type {string} */ t) => count(t);
  const forms = ['_@octocat_', '__@octocat__', 'see _@org/team_ now', '*@octocat*', '~@octocat~', '**@org/team**', '_＠octocat_', '＠octocat', '﹫octocat', 'x ＠org/team', '__﹫org/team__',
    '@octocat', 'plain @octocat here', '@org/team', '@a@b', '@@v6', '@-@v7', 'é@v8', '(@x)', '"@y"', '> @quoted', '- @item', '| @cell |', '[@link text](https://x)',
    '<a title="@attr">x</a>', '<div>@inhtml</div>', '`@span`', '```\n@infence\n```', '\\@v4', 'x-@v2', 'path/@v3',
    '&#64;victim', '&#x40;victim', '&#X40;v', '&#0064;v', '&#x0040;v', '&#64v', '&#x40v', '&commat;v', '&COMMAT;v', 'a &#64;b and (&commat;c)',
    // A377 re-review: an `@` before a zero-width, soft-hyphen, fullwidth or enclosed character, or before a reference to one
    '@\u200bx', '@\u2060x', '@\u00adx', '@\ufeffx', '@&ZeroWidthSpace;x', '@&shy;x', '@&#x200b;x', '@&NoBreak;x', '@ｘ', '@①', '_@\u200bocto_', '＠&ZeroWidthSpace;x', '＠\u200bx'];
  for (const input of forms) {
    const out = body(input);
    assert.equal(mentions(out), 0, `as sent: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    const preFolded = /[＠﹫]/.test(input); // a U+FF20 or U+FE6B the report already held rests on U+200B alone (limits A369.1)
    if (!preFolded) assert.equal(count(out, stripZw), 0, `zero-width stripped: ${JSON.stringify(input)} -> ${JSON.stringify(stripZw(decode(out)))}`);
    assert.equal(count(out, fold), 0, `NFKC folded: ${JSON.stringify(input)} -> ${JSON.stringify(fold(decode(out)))}`);
    assert.ok(count(input, (x) => fold(stripZw(x))) > 0, `not a mention form: ${input}`); // the input itself would notify with both layers undone
  }
  // the two layers are what the text holds: U+FF20 then U+200B for an `@`, `&amp;` then U+200B for a reference
  assert.ok(body('@octocat').startsWith('＠\u200boctocat'));
  assert.ok(body('&#64;v').startsWith('&amp;\u200b#64;v'));
  assert.equal(body('a@b.c'), 'a@b.c\n', 'an address was changed');
  assert.ok(body('_@octocat_').startsWith('_＠\u200boctocat_'), 'an underscore before the @ left it unbroken');
  assert.ok(body('@&ZeroWidthSpace;x').startsWith('＠\u200b&amp;ZeroWidthSpace;x'), 'a reference after the @ still decodes');
  assert.equal(body('@ x and @'), '@ x and @\n', 'an @ before a space or at the end is not a mention');
});

// A377 review: the claim "U+FF20 and U+FE6B are the only characters besides `@` that NFKC folds to `@`" is checked over every code point, so a fold form the
// sanitiser does not break cannot exist
test('mentions: only @, U+FE6B and U+FF20 normalise (NFKC) to a text that holds @', () => {
  const found = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (String.fromCodePoint(cp).normalize('NFKC').includes('@')) found.push(cp.toString(16));
  }
  assert.deepEqual(found, ['40', 'fe6b', 'ff20']);
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
  const mine0 = st.comments[0];
  st.comments = [{ body: `look: ${mine0.body}`, url: 'u#issuecomment-1', author: { login: 'me' } }];
  assert.equal((await gha(['verify', 'GH-42', rc])).code, 1, 'a comment that only quotes the marker satisfied verify');
  st.comments = [{ ...mine0, author: { login: 'mallory' } }];
  assert.equal((await gha(['verify', 'GH-42', rc])).code, 1, 'a comment of another author satisfied verify');
  write(`${root}/.agents/runs/GH-42/COMPLETION_REPORT.md`, read(`${root}/rep.md`));
  st.comments = [{ ...mine0, body: `${mine0.body}\nappended by someone` }];
  assert.equal((await gha(['verify', 'GH-42', rc])).code, 1, 'an edited body satisfied verify');
  st.comments = [{ ...mine0 }];
  assert.equal((await gha(['verify', 'GH-42', rc])).code, 0, 'the exact comment of our own account was refused');
  st.comments = [{ body: '<!-- proofline:completion-report:GH-42 sha256:x -->\nspoof', url: 'https://github.com/o/r/issues/42#issuecomment-7', author: { login: 'mallory' } }];
  st.patched = 0;
  assert.equal((await gha(['publish', 'GH-42', `${root}/rep.md`])).code, 0);
  assert.equal(st.patched, 0, 'a comment of another author was patched');
  assert.equal(st.comments.length, 2);
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

test('reportComment: a truncation closes an open fence', () => {
  const big = reportComment('GH-1', 'h', `\`\`\`\n${'y'.repeat(70000)}`);
  assert.ok(Buffer.byteLength(big.body) <= COMMENT_LIMIT && big.truncated);
  assert.equal((big.body.match(/^```$/gm) ?? []).length % 2, 0, 'a fence was left open');
});

test('markdown publish: a symbolic link on the way is refused; an inline report whose first line starts with "Report: " is not a pointer', async () => {
  const { root, run } = setup();
  const md = (/** @type {string[]} */ argv) => run(runMarkdown, argv);
  const f = '.agents/tasks/in-progress/T-3-x.md';
  write(`${root}/${f}`, '# Task: T-3 — X\n\n## Goal\n\ng\n');
  write(`${root}/.agents/runs/T-3/RUN.yaml`, `task_source:\n  type: local_markdown\n  path: ${f}\n  revision: x\n`);
  write(`${root}/rep.md`, '# R\nbody\n');
  const outside = tempDir('u3-out-');
  symlinkSync(outside, `${root}/.agents/tasks/T-3`);
  const r = await md(['publish', 'T-3', `${root}/rep.md`]);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('symbolic link'), r.err);
  assert.ok(!existsSync(`${outside}/COMPLETION_REPORT.md`), 'the report was written through the link');
  rmSync(`${root}/.agents/tasks/T-3`);
  mkdirSync(`${root}/.agents/tasks/T-3`);
  symlinkSync(`${root}/rep.md`, `${root}/.agents/tasks/T-3/COMPLETION_REPORT.md`);
  assert.equal((await md(['publish', 'T-3', `${root}/rep.md`])).code, 1, 'a linked report file was written');
  const rep = 'Report: not a pointer\nmore text\n';
  write(`${root}/.agents/tasks/done/T-4-old.md`, `# Task: T-4 — Old\n\n<!-- COMPLETION-REPORT:BEGIN:T-4 -->\n${rep}<!-- COMPLETION-REPORT:END:T-4 -->\n`);
  write(`${root}/.agents/runs/T-4/RUN.yaml`, 'task_source:\n  type: local_markdown\n  path: .agents/tasks/done/T-4-old.md\n  revision: x\n');
  const h = createHash('sha256').update(rep).digest('hex');
  assert.equal((await md(['verify', 'T-4', `.agents/tasks/done/T-4-old.md#${h}`])).code, 0);
});

test('github: the comment author must be the very login `gh api user` reports (a [bot] suffix included); an unknown viewer publishes nothing', async () => {
  const { root, run } = setup('github adapter');
  const { st, gh } = fakeGh();
  write(`${root}/rep.md`, '# R\nbody\n');
  const asLogin = (/** @type {string | null} */ login) => (/** @type {string[]} */ args) => (args[0] === 'api' && args[1] === 'user' ? (login === null ? { status: 1, out: '', err: 'HTTP 403' } : { status: 0, out: JSON.stringify({ login }), err: '' }) : gh(args));
  const gha = (/** @type {(a: string[]) => any} */ g, /** @type {string[]} */ argv) => run((a, v) => runGithub({ ...a, gh: g }, v), argv);
  const none = await gha(asLogin(null), ['publish', 'GH-42', `${root}/rep.md`]);
  assert.equal(none.code, 1);
  assert.ok(none.err.includes('nothing was posted'), none.err);
  assert.equal(st.comments.length, 0);
  const bot = asLogin('app[bot]');
  const rc = (await gha(bot, ['publish', 'GH-42', `${root}/rep.md`])).out.trim();
  st.comments[0].author = { login: 'app[bot]' };
  assert.equal((await gha(bot, ['verify', 'GH-42', rc])).code, 0);
  st.comments[0].author = { login: 'app' };
  assert.equal((await gha(bot, ['verify', 'GH-42', rc])).code, 1, 'a login without the [bot] suffix matched');
  assert.equal((await gha(asLogin(null), ['verify', 'GH-42', rc])).code, 1, 'an unknown viewer accepted a comment');
});

test('restoreSibling: the old bytes come back, a new file goes, the folder the publish made goes when empty and stays when not', () => {
  const root = tempDir('u3-rs-');
  const dir = `${root}/.agents/tasks/T-9`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/COMPLETION_REPORT.md`, 'new');
  restoreSibling(`${dir}/COMPLETION_REPORT.md`, null, false);
  assert.ok(!existsSync(dir), 'the folder the publish made stayed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/COMPLETION_REPORT.md`, 'new'); writeFileSync(`${dir}/other.md`, 'x');
  restoreSibling(`${dir}/COMPLETION_REPORT.md`, null, false);
  assert.ok(existsSync(`${dir}/other.md`) && !existsSync(`${dir}/COMPLETION_REPORT.md`), 'a folder with another file was removed');
  writeFileSync(`${dir}/COMPLETION_REPORT.md`, 'new');
  restoreSibling(`${dir}/COMPLETION_REPORT.md`, Buffer.from('old'), true);
  assert.equal(read(`${dir}/COMPLETION_REPORT.md`), 'old');
});

test('secret scan of the joined text: a token split by a hyphen, a trailing backslash, <br> or &nbsp; is refused; an upper-case heading is not', async () => {
  const { root, run } = setup('github adapter');
  const { gh } = fakeGh();
  const gha = (/** @type {string[]} */ argv) => run((a, v) => runGithub({ ...a, gh }, v), argv);
  const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const cases = {
    hyphen: `# R\n${tok.slice(0, 15)}-\n${tok.slice(15)}\n`,
    backslash: `# R\n${tok.slice(0, 15)}\\\n${tok.slice(15)}\n`,
    br: `# R\n${tok.slice(0, 15)}<br>${tok.slice(15)}\n`,
    nbsp: `# R\n${tok.slice(0, 15)}&nbsp;${tok.slice(15)}\n`,
    awsSplit: '# R\nAKIAABCDEFGH\n12345678\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    write(`${root}/s.md`, text);
    assert.equal((await gha(['publish', 'GH-42', `${root}/s.md`])).code, 1, `${name}: published`);
  }
  write(`${root}/ok.md`, '# R\nASIA PACIFIC TRADE ZONES AND ACCA ORGANISATION REPORT\n\nplain words - and more words\\\nnext\n');
  assert.equal((await gha(['publish', 'GH-42', `${root}/ok.md`])).code, 0, 'an upper-case heading was refused');
});
