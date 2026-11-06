// @ts-check
// The known-issues list (A202, item 27) in Node (A222; the shell files known-issues.sh and known-issues-test.sh are gone). Every scenario of the former
// known-issues-test.sh as an absolute test against the real control plane (agent.sh, the Node core), plus the data rules as unit tests:
//   a finding that was already there and that the task does not touch is not blocking, but only on the USER's approval of exactly that record, bound to the
//   exact bytes of its TSV row; every forbidden shortcut is attempted here (an agent role, a missing or ambiguous reply, a hand-written row or approval, a near
//   miss, a touched place, SECRETS and SECURITY, a vanished follow-up, an edited row, a place that is not a repository path, the batch accept answer).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Context } from '../../control-plane/agents/scripts/core/context.mjs';
import { approvalOk, canon, followupState, listRecords, listable, lookup, placeOk, rowBound, rowState } from '../../control-plane/agents/scripts/core/kirules.mjs';
import { makeProject, memoryIo } from './helpers.mjs';
import { A, accepted, approveAsUser, gateStatus, project, read, refused, say, verbs } from './legacy-lib.mjs';

const TXT = 'the legacy ignore list drops a documented entry';
const PLACE = '.gitignore:1';
const EVID = 'traced: the entry is missing from the list; scan: grep -n entry .gitignore; instances: single';
const KI_DIR = '.agents/local/known-issues';

/** The shell verbs of a frozen STANDARD run at IMPLEMENTED whose gate (default QA) failed on the finding; the rest passed. */
const PRE = `mk_run() {
  mr_place=\${1:-${PLACE}} mr_text=\${2:-${TXT}} mr_gate=\${3:-QA}
  scaffold standalone no STANDARD autonomous
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null
  for mr_g in $(required); do case "$mr_g" in SECRETS|VERIFY|"$mr_gate") ;; *) gpass "$mr_g" ;; esac; done
  rec "$mr_gate" FAIL high "$mr_gate-1|blocking|$mr_place|$mr_text|${EVID}"
  gpass VERIFY
}
`;
const RUN = `${PRE}mk_run`;

/** @param {string} d @param {string} id */
function followup(d, id) {
  mkdirSync(`${d}/.agents/tasks/todo`, { recursive: true });
  writeFileSync(`${d}/.agents/tasks/todo/${id}.md`, `# Task: ${id} — Fix the legacy ignore list\n\n**Status:** todo\n\n## Goal\n\nFix it.\n`);
}
/** The user's message arrives after the request; the approval is recorded from it. @param {string} d @param {string} text */
const userSays = (d, text) => { say(d, text); return A(d, ['approve', '-', 'known-issue']); };
/** The legitimate route: propose, approve, apply (the user's own words). @param {string} d @param {string} [fu] */
function listIt(d, fu = 'FU-9') {
  followup(d, fu);
  accepted(A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', fu]), 'propose');
  accepted(userSays(d, 'approve known issue'), 'approve known issue');
  accepted(A(d, ['known-issue-apply']), 'apply');
}
/** @param {string} d @param {string} gate @param {string} place @param {string} text @param {string} [n] */
const failFinding = (d, gate, place, text, n = '1') => verbs(d, `rec ${gate} FAIL high '${gate}-${n}|blocking|${place}|${text}|traced: x; scan: grep -n entry .gitignore; instances: single'`);
const sha = (/** @type {string} */ s) => createHash('sha256').update(s, 'latin1').digest('hex');

describe('the rules of the data (units)', () => {
  const made = /** @type {string[]} */ ([]);
  after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
  /** A context on a git project that tracks .gitignore. @param {Record<string, string>} [files] */
  function tree(files = {}) {
    const root = makeProject('tasks:\n  dir: .agents/tasks\n'); made.push(root);
    writeFileSync(`${root}/.gitignore`, '.agents/local/\n');
    for (const [f, t] of Object.entries(files)) { mkdirSync(path.dirname(`${root}/${f}`), { recursive: true }); writeFileSync(`${root}/${f}`, t); }
    const g = (/** @type {string[]} */ a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' } });
    g(['init', '-q', '-b', 'main']); g(['add', '.gitignore', ...Object.keys(files)]); g(['commit', '-qm', 'base']);
    const { io } = memoryIo(root);
    return { root, ctx: new Context(io, io.scriptPath) };
  }

  test('a place is a repository path in one spelling: //, /./, .., a trailing / or dot segment and a leading ./ are refused', () => {
    for (const bad of ['./.gitignore:1', 'a//b.txt:1', 'src/./a.txt:1', 'src/../.gitignore:1', 'src/.', '.gitignore/:1', '.gitignore//', 'a b.txt', 'a.txt:x', 'a.txt:1-', '', 'a.txt:1\nb.txt', '/etc/passwd', '~/x'])
      assert.equal(placeOk(bad), false, JSON.stringify(bad));
    for (const good of ['.gitignore:1', '.gitignore', 'src/a.txt:3-5', 'docs/a+b@c_d-e.md', '-', 'a/b/c.d'])
      assert.equal(placeOk(good), true, good);
    const { ctx } = tree();
    assert.match(listable(ctx, 'QA', 'src/../.gitignore:1') ?? '', /is not a repository path/);
    assert.match(listable(ctx, 'QA', 'no-such-file.txt:3') ?? '', /is not a tracked file of the project/);
    assert.equal(listable(ctx, 'QA', '.gitignore:1'), null);
    assert.match(listable(ctx, 'SECRETS', '.gitignore:1') ?? '', /never listed/);
    assert.match(listable(ctx, 'review:Security', '.gitignore:1') ?? '', /never listed/, 'a focus naming SECURITY');
    assert.match(listable(ctx, 'QA:secret-scan', '.gitignore:1') ?? '', /never listed/);
  });

  test('canon reads the last blocking finding of the id, folds case of the id, squeezes the text and refuses what cannot make a record', () => {
    const { root, ctx } = tree();
    const rec = (/** @type {string} */ body) => { writeFileSync(`${root}/gate.yaml`, body); ctx.forget('file:'); return canon(ctx, `${root}/gate.yaml`, 'qa-1'); };
    assert.deepEqual(rec(`gate: "QA"\nfocus: "-"\nfinding: QA-1|blocking|${PLACE}|  the   page\tdrops  a section |traced: x\n`), { gate: 'QA', place: PLACE, text: 'the page drops a section' });
    assert.equal(rec('gate: "REVIEW_RULES"\nfocus: "rules"\nfinding: QA-1|blocking|a.txt:2|t|e\n')?.gate, 'REVIEW_RULES:rules');
    assert.equal(rec('gate: "QA"\nfinding: QA-1|info|a.txt:2|t|e\n'), null, 'only a blocking finding');
    assert.equal(rec('gate: "QA"\nfinding: QA-2|blocking|a.txt:2|t|e\n'), null, 'another id');
    assert.equal(rec('gate: "QA"\nfinding: QA-1|blocking||t|e\n'), null, 'no place');
    assert.equal(rec('gate: "QA"\nfinding: QA-1|blocking|a.txt:2||e\n'), null, 'no text');
    assert.equal(rec('gate: "QA"\nfinding: QA-1|blocking|a.txt:2|first|e\nfinding: QA-1|blocking|a.txt:9|second|e\n')?.text, 'second', 'the last line wins');
    assert.equal(canon(ctx, `${root}/missing.yaml`, 'QA-1'), null);
  });

  test('followup-state: the task file, its folder and its status line decide; a symlink, an -FU file, another adapter and a bad id are unknown', () => {
    const { root, ctx } = tree({
      '.agents/tasks/todo/T-1.md': '# Task: T-1\n\n**Status:** todo\n', '.agents/tasks/backlog/T-2-slug.md': '# T-2\n', '.agents/tasks/in-progress/T-3.md': '# T-3\n',
      '.agents/tasks/done/T-4.md': '# T-4\n', '.agents/tasks/todo/T-5.md': '# T-5\n\n**Status:** Complete\n', '.agents/tasks/T-6.md': '# T-6\n', '.agents/tasks/todo/T-7-FU1.md': '# FU\n',
      '.agents/tasks/todo/T-8.md': '# T-8\n\n**Status:** In Progress\n', '.agents/tasks/todo/T-9.md': '# T-9\n\n**Status:** Closed\n',
    });
    const st = (/** @type {string} */ id) => followupState(ctx, id);
    assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'T-7', 'T-8', 'T-9', 'T-0', ''].map(st), ['todo', 'backlog', 'in-progress', 'done', 'done', 'todo', 'unknown', 'todo', 'done', 'unknown', 'unknown']);
    assert.equal(st('T-1/../x'), 'unknown');
    symlinkSync(`${root}/.agents/tasks/todo/T-1.md`, `${root}/.agents/tasks/todo/T-10.md`);
    assert.equal(st('T-10'), 'unknown', 'a symbolic link is not a task file');
    writeFileSync(`${root}/.agents/config.yaml`, 'tasks:\n  adapter: github\n'); ctx.forget('file:');
    const { io } = memoryIo(root);
    assert.equal(followupState(new Context(io, io.scriptPath), 'T-1'), 'unknown', 'known issues need the markdown task adapter');
  });

  /** A list with one row backed by a user approval, written the way `approve` and `known-issue-apply` write them. */
  function backed(/** @type {{ source?: string, answered?: string, consumed?: string, capture?: string | null, request?: string | null, reqBound?: string, kind?: string, bound?: string }} */ o = {}) {
    const { root, ctx } = tree({ '.agents/tasks/todo/FU-9.md': '# Task: FU-9\n\n**Status:** todo\n' });
    const bound = o.bound ?? rowBound('QA', PLACE, TXT, 'FU-9');
    const ap = `${root}/.agents/local/approvals`;
    mkdirSync(ap, { recursive: true }); mkdirSync(`${root}/${KI_DIR}`, { recursive: true });
    const lines = [`kind: "${o.kind ?? 'known-issue'}"`, `bound: "${bound}"`, `source: "${o.source ?? 'prompt_capture'}"`, `answered_by: "${o.answered ?? 'user'}"`, `consumed: "${o.consumed ?? 'true'}"`];
    if (o.capture !== null) lines.push(`capture_id: "${o.capture ?? 's1:1:x'}"`);
    if (o.request !== null) lines.push(`request: "${o.request ?? '001-request-known-issue.yaml'}"`);
    writeFileSync(`${ap}/001-known-issue.yaml`, `${lines.join('\n')}\n`);
    if (o.request !== null) writeFileSync(`${ap}/${o.request ?? '001-request-known-issue.yaml'}`, `kind: "known-issue"\nbound: "${o.reqBound ?? bound}"\nrequested_at: 1\n`);
    writeFileSync(`${root}/${KI_DIR}/LIST.tsv`, `KI-1\tQA\t${PLACE}\t${TXT}\tFU-9\t001-known-issue.yaml\t2026-01-01\n`);
    return { root, ctx };
  }
  const state = (/** @type {Context} */ ctx) => listRecords(ctx).replace(/^KI-1 \[(\w+)\].*\n$/s, '$1');

  test('the approval is bound to the exact bytes of the row: the digest of "gate TAB place TAB text TAB follow-up LF" (known answers)', () => {
    assert.equal(rowBound('QA', PLACE, TXT, 'FU-9'), '915294ec865b2fee3c6533d6ae2b81a49c2f17ec21b5f4084c94f4b870e7ccc1');
    assert.equal(rowBound('QA', 'docs/a b.md:3-5', 'text \xc3\xa7', 'FU-1'), '8d7062a29a81d0b1159360f8106f83196484bd461d375870559dbe512b9fbe99');
    assert.equal(rowBound('QA', PLACE, TXT, 'FU-9'), sha(`QA\t${PLACE}\t${TXT}\tFU-9\n`));
  });

  test('the exact row with a complete user approval is active; looked up by the exact gate, place and text only', () => {
    const { ctx } = backed();
    assert.equal(state(ctx), 'active');
    assert.deepEqual(lookup(ctx, 'QA', PLACE, TXT), { id: 'KI-1', followup: 'FU-9' });
    for (const [g, p, t] of [['QA', PLACE, `${TXT}.`], ['QA', PLACE, TXT.toUpperCase()], ['QA', '.gitignore:2', TXT], ['QA', '.gitignore', TXT], ['VERIFY', PLACE, TXT], ['QA', PLACE, ` ${TXT}`], ['qa', PLACE, TXT]])
      assert.equal(lookup(ctx, g, p, t), null, `${g} ${p} ${t}`);
  });

  test('one byte changed in any field of the row has no approval: the record is invalid and matches nothing', () => {
    for (const [col, to] of [[1, 'QB'], [2, '.gitignore:2'], [3, `${TXT} `], [4, 'FU-8']]) {
      const { root, ctx } = backed();
      const f = `${root}/${KI_DIR}/LIST.tsv`;
      const cells = readFileSync(f, 'latin1').replace(/\n$/, '').split('\t'); cells[col] = to;
      writeFileSync(f, `${cells.join('\t')}\n`);
      writeFileSync(`${root}/.agents/tasks/todo/FU-8.md`, '# Task: FU-8\n\n**Status:** todo\n');
      assert.equal(state(ctx), 'invalid', `column ${col}`);
      assert.equal(lookup(ctx, cells[1], cells[2], cells[3]), null, `column ${col}`);
    }
  });

  test('an approval that is not the user\'s, not complete, not for this kind or not bound to this row does not back the record', () => {
    const variants = /** @type {Array<[string, Parameters<typeof backed>[0]]>} */ ([
      ['not answered by the user', { answered: 'agent' }], ['not consumed', { consumed: 'false' }], ['source batch', { source: 'batch' }], ['source tty is the user\'s', { source: 'tty' }],
      ['another kind', { kind: 'commit' }], ['no capture id', { capture: null }], ['an empty capture id', { capture: '' }], ['no request', { request: null }],
      ['a request of another name', { request: '001-request-commit.yaml' }], ['a request bound to other bytes', { reqBound: 'f'.repeat(64) }], ['bound to other bytes', { bound: rowBound('QA', PLACE, 'other text', 'FU-9') }],
    ]);
    for (const [what, o] of variants) assert.equal(state(backed(o).ctx), what.includes('tty') ? 'active' : 'invalid', what);
    // a link in place of the approval file or of its request
    const a = backed();
    const f = `${a.root}/.agents/local/approvals/001-known-issue.yaml`;
    renameSync(f, `${f}.real`); symlinkSync(`${f}.real`, f);
    assert.equal(state(a.ctx), 'invalid', 'a symbolic link as the approval');
    const b = backed();
    const r = `${b.root}/.agents/local/approvals/001-request-known-issue.yaml`;
    renameSync(r, `${r}.real`); symlinkSync(`${r}.real`, r);
    assert.equal(state(b.ctx), 'invalid', 'a symbolic link as the request');
    assert.equal(approvalOk(b.ctx, '../001-known-issue.yaml', 'x'), false);
    assert.equal(approvalOk(b.ctx, '1-known-issue.yaml', 'x'), false);
  });

  test('one approval backs one record; a SECRETS or SECURITY gate, a place that is not a path, no follow-up and a closed follow-up are not active', () => {
    const { root, ctx } = backed();
    appendFileSync(`${root}/${KI_DIR}/LIST.tsv`, `KI-2\tQA\t${PLACE}\t${TXT} more\tFU-9\t001-known-issue.yaml\t2026-01-01\n`);
    assert.match(listRecords(ctx), /^KI-1 \[invalid\]/m, 'two rows share one approval: neither is valid');
    assert.match(listRecords(ctx), /^KI-2 \[invalid\]/m);
    for (const [gate, place, fu] of [['SECRETS', PLACE, 'FU-9'], ['QA:security', PLACE, 'FU-9'], ['QA', 'a//b', 'FU-9'], ['QA', PLACE, '']]) {
      const x = backed({ bound: rowBound(gate, place, TXT, fu) });
      writeFileSync(`${x.root}/${KI_DIR}/LIST.tsv`, `KI-1\t${gate}\t${place}\t${TXT}\t${fu}\t001-known-issue.yaml\t2026-01-01\n`);
      assert.equal(state(x.ctx), 'invalid', `${gate} ${place} ${fu}`);
    }
    const closed = backed();
    writeFileSync(`${closed.root}/.agents/tasks/todo/FU-9.md`, '# Task: FU-9\n\n**Status:** done\n');
    assert.equal(state(closed.ctx), 'closed');
    assert.equal(lookup(closed.ctx, 'QA', PLACE, TXT), null, 'a closed record matches nothing');
    const none = backed();
    rmSync(`${none.root}/.agents/tasks/todo/FU-9.md`);
    assert.equal(state(none.ctx), 'invalid', 'a vanished follow-up is the safe side');
    assert.equal(rowState(none.ctx, 'KI-1\tQA\tx', []), 'invalid', 'a row with fewer than seven columns');
  });
});

describe('the commands, against the real control plane', () => {
  test('only the user\'s approval creates a record: an agent role, a missing or ambiguous reply, a hand-written row and a hand-written approval do not', () => {
    const d = project(RUN);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'the finding blocks before any record');
    followup(d, 'FU-9');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-9'], { role: 'reviewer' }), 'a reviewer proposed a record', 'denied for reviewer');
    refused(A(d, ['known-issue-apply'], { role: 'implementer' }), 'an implementer applied a record', 'denied for implementer');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-1']), 'a record without a follow-up task', 'follow-up task');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'NOPE-1']), 'a follow-up task that does not exist', 'not an open markdown task');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-1', '--frob', 'x']), 'an unknown argument', 'unknown argument');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'a b']), 'an invalid task id', 'invalid follow-up task id');
    refused(A(d, ['known-issue-propose', 'NOPE', 'QA-1', '--followup', 'FU-9']), 'a run that does not exist', 'no run NOPE on this machine');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-7', '--followup', 'FU-9']), 'a finding that does not exist', 'no blocking finding QA-7');
    assert.match(accepted(A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-9']), 'propose').out, /approve/, 'the request was not made');
    assert.equal(readFileSync(`${d}/${KI_DIR}/PROPOSAL.tsv`, 'utf8'), `QA\t${PLACE}\t${TXT}\tFU-9\n`);
    refused(A(d, ['known-issue-apply']), 'applied without the user\'s approval', "needs the user's approval");
    for (const t of ['ok', 'approve the plan', 'I think the known issue is fine, maybe?', 'approve known issue but not the other one']) {
      say(d, t);
      refused(A(d, ['approve', '-', 'known-issue']), `'${t}' approved a known issue`);
    }
    refused(A(d, ['known-issue-apply']), 'applied after refused replies', "needs the user's approval");
    assert.throws(() => readFileSync(`${d}/${KI_DIR}/LIST.tsv`), /ENOENT/, 'a list exists without an approval');
    assert.equal(gateStatus(d, 'QA'), 'fail', 'an unapproved proposal made the finding non-blocking');
    // hand-written list rows and hand-written approvals are not the user's
    mkdirSync(`${d}/${KI_DIR}`, { recursive: true });
    writeFileSync(`${d}/${KI_DIR}/LIST.tsv`, `KI-1\tQA\t${PLACE}\t${TXT}\tFU-9\t001-known-issue.yaml\t2026-01-01\n`);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'a hand-written record (no approval file) made the finding non-blocking');
    mkdirSync(`${d}/.agents/local/approvals`, { recursive: true });
    writeFileSync(`${d}/.agents/local/approvals/001-known-issue.yaml`, `kind: "known-issue"\nbound: "${rowBound('QA', PLACE, TXT, 'FU-9')}"\nanswered_by: "user"\nsource: "prompt_capture"\nconsumed: "true"\n`);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'a hand-written approval without a capture and a request made the finding non-blocking');
  });

  test('the happy path: an untouched listed finding is not blocking, is shown with its record and follow-up, stays in the gate record, and a done follow-up drops the record', () => {
    const d = project(RUN);
    listIt(d, 'FU-9');
    assert.match(A(d, ['known-issue-list']).out, /KI-1 \[active\] QA \.gitignore:1/);
    assert.equal(gateStatus(d, 'QA'), 'waived', 'a listed untouched finding still blocks');
    assert.match(verbs(d, 'cat .agents/runs/LC/gates/*QA*.yaml').out, /^finding: QA-1\|blocking\|/m, 'the gate record lost the finding');
    accepted(A(d, ['handoff', 'LC', 'CODE_DONE']), 'CODE_DONE with only a known issue open');
    const facts = A(d, ['report-facts', 'LC']).out;
    assert.ok(facts.includes('Gate QA: waived (known issue: KI-1:QA-1:FU-9)'), `the gate label hides the known issue: ${facts}`);
    assert.ok(facts.includes('Known issue (not blocking, the gate record keeps the finding): QA-1 in gate QA, record KI-1, follow-up task FU-9'), `the Facts block hides it: ${facts}`);
    // the record drops when its follow-up task is done, computed from the task state
    mkdirSync(`${d}/.agents/tasks/done`, { recursive: true });
    renameSync(`${d}/.agents/tasks/todo/FU-9.md`, `${d}/.agents/tasks/done/FU-9.md`);
    writeFileSync(`${d}/.agents/tasks/done/FU-9.md`, '# Task: FU-9\n\n**Status:** done\n');
    assert.match(A(d, ['known-issue-list']).out, /KI-1 \[closed\]/, 'a done follow-up did not close the record');
    assert.equal(gateStatus(d, 'QA'), 'fail', 'the finding stays non-blocking after its follow-up task is done');
  });

  test('listing another finding moves a closed record to CLOSED.tsv, and the next record gets the next number', () => {
    const d = project(RUN);
    listIt(d, 'FU-9');
    mkdirSync(`${d}/.agents/tasks/done`, { recursive: true });
    renameSync(`${d}/.agents/tasks/todo/FU-9.md`, `${d}/.agents/tasks/done/FU-9.md`);
    writeFileSync(`${d}/.agents/tasks/done/FU-9.md`, '# Task: FU-9\n\n**Status:** done\n');
    followup(d, 'FU-10');
    failFinding(d, 'QA', '.gitignore:2', 'a second documented entry is dropped', '2');
    accepted(A(d, ['known-issue-propose', 'LC', 'QA-2', '--followup', 'FU-10']), 'propose the second');
    accepted(userSays(d, 'approve known issue'), 'approve the second');
    assert.match(accepted(A(d, ['known-issue-apply']), 'apply the second').out, /^known issue recorded: KI-2 \(QA \.gitignore:2, follow-up FU-10\)$/m);
    assert.match(read(d, `${KI_DIR}/LIST.tsv`), /^KI-2\tQA\t\.gitignore:2\t/);
    assert.match(read(d, `${KI_DIR}/CLOSED.tsv`), /^KI-1\t/);
    assert.equal(read(d, `${KI_DIR}/LIST.tsv`).split('\n').filter(Boolean).length, 1, 'the closed record left the list');
    refused(A(d, ['known-issue-apply']), 'the same proposal applied twice', 'no known-issue proposal');
  });

  test('exact matching, never fuzzy: gate, place and text; a changed line, text, case, gate or a missing line stays blocking', () => {
    const d = project(RUN);
    listIt(d);
    assert.equal(gateStatus(d, 'QA'), 'waived', 'the exact finding is not matched');
    let n = 1;
    for (const [place, text] of [[PLACE, `${TXT}.`], [PLACE, TXT.toUpperCase()], ['.gitignore:2', TXT], ['.gitignore', TXT], ['tasks/LC.md:1', TXT], [PLACE, 'the legacy ignore list drops an entry']]) {
      n += 1;
      failFinding(d, 'QA', place, text, String(n));
      assert.equal(gateStatus(d, 'QA'), 'fail', `a near miss matched the record: ${place} ${text}`);
    }
    // the same place and text under another gate is another finding kind
    failFinding(d, 'VERIFY', PLACE, TXT);
    assert.equal(gateStatus(d, 'VERIFY'), 'fail', 'the same text under another gate matched');
  });

  test('a gate with a new blocking finding next to the listed one still blocks', () => {
    const d = project(RUN);
    listIt(d);
    verbs(d, `rec QA FAIL high 'QA-1|blocking|${PLACE}|${TXT}|traced: the entry is missing' 'QA-2|blocking|.gitignore:3|a second finding nobody listed|traced: x'`);
    assert.equal(gateStatus(d, 'QA'), 'fail');
  });

  test('a task that touches the place keeps the finding blocking: the frozen scope and the actual diff', () => {
    const inScope = project(`${PRE}SC_SCOPE_OTHER=AC-1 mk_run far.txt:1`);
    listIt(inScope);
    assert.equal(gateStatus(inScope, 'QA'), 'fail', 'a finding in a file of the frozen scope was let through');
    // the diff: a tracked file outside the plan scope that the task changed (a control-plane file is not a scope violation)
    const diff = project(`scaffold standalone no STANDARD autonomous
tf=$(ls .agents/templates/* | head -1); printf '\\n# touched by the task\\n' >> "$tf"
solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null
for g in $(required); do case "$g" in SECRETS|VERIFY|QA) ;; *) gpass "$g" ;; esac; done
rec QA FAIL high "QA-1|blocking|$tf:1|${TXT}|traced: x"
gpass VERIFY`);
    listIt(diff);
    assert.equal(gateStatus(diff, 'QA'), 'fail', 'a finding in a file the task changed was let through');
  });

  test('SECRETS and SECURITY findings are refused at proposal and ignored when found in the file', () => {
    const d = project(`scaffold standalone no STANDARD autonomous
solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null
A secret-scan LC >/dev/null`);
    assert.equal(gateStatus(d, 'SECRETS'), 'fail', 'the planted secret was not found');
    followup(d, 'FU-9');
    refused(A(d, ['known-issue-propose', 'LC', 'SECRETS-1', '--followup', 'FU-9']), 'a SECRETS finding was proposed', 'never listed');
    // even a perfectly approved record of a SECRETS or SECURITY finding is ignored when it is found in the file
    for (const g of ['SECRETS', 'SECURITY']) {
      const h = rowBound(g, PLACE, 'x', 'FU-9');
      mkdirSync(`${d}/.agents/local/approvals`, { recursive: true }); mkdirSync(`${d}/${KI_DIR}`, { recursive: true });
      writeFileSync(`${d}/.agents/local/approvals/001-known-issue.yaml`, `kind: "known-issue"\nbound: "${h}"\nanswered_by: "user"\nsource: "prompt_capture"\ncapture_id: "s1:1:x"\nrequest: "001-request-known-issue.yaml"\nconsumed: "true"\n`);
      writeFileSync(`${d}/.agents/local/approvals/001-request-known-issue.yaml`, `kind: "known-issue"\nbound: "${h}"\nrequested_at: 1\n`);
      writeFileSync(`${d}/${KI_DIR}/LIST.tsv`, `KI-1\t${g}\t${PLACE}\tx\tFU-9\t001-known-issue.yaml\t2026-01-01\n`);
      assert.match(A(d, ['known-issue-list']).out, /KI-1 \[invalid\]/, `a ${g} record is not invalid`);
    }
    assert.equal(gateStatus(d, 'SECRETS'), 'fail', 'a SECRETS record in the file made the finding non-blocking');
    // SECURITY, proposed through the command
    const s = project('scaffold standalone no CRITICAL manual');
    approveAsUser(s, 'plan', 'approve the plan');
    verbs(s, "A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null; solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'impl: lookup'; A handoff LC IMPLEMENTED >/dev/null");
    failFinding(s, 'SECURITY', PLACE, 'injection reachable from input', '1');
    followup(s, 'FU-9');
    refused(A(s, ['known-issue-propose', 'LC', 'SECURITY-1', '--followup', 'FU-9']), 'a SECURITY finding was proposed', 'never listed');
  });

  test('no follow-up, a vanished follow-up, an edited row, no place or an untracked place are never a valid record', () => {
    const d = project(RUN);
    followup(d, 'FU-9');
    mkdirSync(`${d}/.agents/tasks/done`, { recursive: true });
    writeFileSync(`${d}/.agents/tasks/done/FU-8.md`, '# Task: FU-8 — x\n\n**Status:** done\n');
    refused(A(d, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-8']), 'a follow-up that is already done', 'already done');
    // a record whose follow-up task vanished is not valid (unknown = the safe side)
    listIt(d, 'FU-7');
    assert.equal(gateStatus(d, 'QA'), 'waived');
    rmSync(`${d}/.agents/tasks/todo/FU-7.md`);
    assert.match(A(d, ['known-issue-list']).out, /KI-1 \[invalid\]/, 'a record with no follow-up task is valid');
    assert.equal(gateStatus(d, 'QA'), 'fail', 'a record whose follow-up task does not exist still unblocks');
    // an edited row (the follow-up changed after the approval) has no approval for its content
    const e = project(RUN);
    listIt(e, 'FU-6'); followup(e, 'FU-9');
    writeFileSync(`${e}/${KI_DIR}/LIST.tsv`, read(e, `${KI_DIR}/LIST.tsv`).replace('FU-6', 'FU-9'));
    assert.equal(gateStatus(e, 'QA'), 'fail', 'an edited record still unblocks');
    // places that cannot be computed
    const noPlace = project(`${PRE}mk_run - "${TXT}"`);
    followup(noPlace, 'FU-9');
    refused(A(noPlace, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-9']), 'a finding without a place was proposed', 'cannot be listed');
    const untracked = project(`${PRE}mk_run no-such-file.txt:3`);
    followup(untracked, 'FU-9');
    refused(A(untracked, ['known-issue-propose', 'LC', 'QA-1', '--followup', 'FU-9']), 'a finding in an untracked file was proposed', 'cannot be listed');
  });

  test('candidates are recorded blocking findings of runs on this machine whose scope did not cover the place and that are not on the list', () => {
    const d = project(RUN);
    assert.ok(A(d, ['known-issue-candidates']).out.includes(`LC\tQA-1\tQA\t${PLACE}\t${TXT}\n`), `the recorded finding is not a candidate: ${A(d, ['known-issue-candidates']).out}`);
    listIt(d);
    assert.equal(A(d, ['known-issue-candidates']).out, '', 'a listed finding is still a candidate');
    // a run whose frozen scope covers the place (its own change) offers nothing
    const covered = project(`${PRE}SC_SCOPE_OTHER=AC-1 mk_run far.txt:1`);
    assert.equal(A(covered, ['known-issue-candidates']).out, '');
    // a record that was written by a run of a task worktree is found there too
    mkdirSync(`${d}/.agents/local/worktrees/T-9/.agents/runs/R-9/gates`, { recursive: true });
    writeFileSync(`${d}/.agents/local/worktrees/T-9/.agents/runs/R-9/RUN.yaml`, 'freeze:\n  scope_paths: "src/a.txt"\n');
    writeFileSync(`${d}/.agents/local/worktrees/T-9/.agents/runs/R-9/gates/001-QA.yaml`, `task_id: "R-9"\ngate: "QA"\nresult: "fail"\nfocus: "-"\nfinding: QA-1|blocking|.gitignore:5|another old problem|traced\n`);
    assert.ok(A(d, ['known-issue-candidates']).out.includes('R-9\tQA-1\tQA\t.gitignore:5\tanother old problem\n'));
  });
});

describe('the batch accept answer', () => {
  /** A hand-built batch of LC that the user approved (their message), with their answer to the accept question. @param {string} d @param {string} letter @param {string[]} lines */
  function batchWith(d, letter, ...lines) {
    const b = `${d}/.agents/local/batch`;
    rmSync(b, { recursive: true, force: true }); mkdirSync(b, { recursive: true }); mkdirSync(`${d}/.agents/local/prompts/history`, { recursive: true });
    writeFileSync(`${b}/SUMMARY.md`, `# Night batch\n\nnonce: t-fixed\n\n## Expected known issues and rationales (accept for this batch)\n\n${lines.map((x) => `- ${x}\n`).join('')}`);
    writeFileSync(`${b}/order.tsv`, 'LC\tSTANDARD\t-\n');
    accepted(A(d, ['request-approval', '-', 'batch']), 'request the batch approval');
    say(d, 'approve batch');
    accepted(A(d, ['approve', '-', 'batch']), 'approve the batch');
    writeFileSync(`${d}/.agents/local/prompts/history/1-aaaa1111.txt`, 'x\n');
    writeFileSync(`${b}/answers.tsv`, `${sha(readFileSync(`${b}/SUMMARY.md`, 'latin1')).slice(0, 12)}\tbatch\tQ1\taccept\t${letter}\t-\t1-aaaa1111.txt\n`);
  }
  const line = `accept K QA ${PLACE}: ${TXT}`;

  test('one answer b accepts the listed findings for the batch; answer a, another finding, a task outside the batch, an edited summary or no captured message do not', () => {
    const d = project(RUN);
    batchWith(d, 'a', line);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'an accept answer of a (no) was taken as an acceptance');
    batchWith(d, 'b', line);
    assert.equal(gateStatus(d, 'QA'), 'waived', 'a finding accepted for the batch still stops the task');
    verbs(d, `rec QA FAIL high 'QA-1|blocking|${PLACE}|${TXT}|traced: x' 'QA-2|blocking|.gitignore:3|a second finding nobody listed|traced: x'`);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'an unlisted finding next to an accepted one was let through');
    verbs(d, `rec QA FAIL high 'QA-1|blocking|${PLACE}|${TXT}|traced: x'`);
    batchWith(d, 'b', `accept K QA ${PLACE}: another text`);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'a finding that is not on the approved summary was accepted');
    batchWith(d, 'b', line); writeFileSync(`${d}/.agents/local/batch/order.tsv`, 'LC2\tSTANDARD\t-\n');
    assert.equal(gateStatus(d, 'QA'), 'fail', 'a task outside the batch used the batch acceptance');
    batchWith(d, 'b', line); appendFileSync(`${d}/.agents/local/batch/SUMMARY.md`, 'tampered\n');
    assert.equal(gateStatus(d, 'QA'), 'fail', 'an edited summary (no approval of its content) accepted a finding');
    batchWith(d, 'b', line); rmSync(`${d}/.agents/local/prompts/history/1-aaaa1111.txt`);
    assert.equal(gateStatus(d, 'QA'), 'fail', 'an answer without a captured user message accepted a finding');
  });

  test('a SECURITY and a SECRETS finding are never accepted this way, whatever the summary and the answer say', () => {
    const s = project('scaffold standalone no CRITICAL manual');
    approveAsUser(s, 'plan', 'approve the plan');
    verbs(s, "A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null; solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'impl: lookup'; A handoff LC IMPLEMENTED >/dev/null");
    failFinding(s, 'SECURITY', PLACE, TXT, '1');
    batchWith(s, 'b', `accept K SECURITY ${PLACE}: ${TXT}`);
    assert.equal(gateStatus(s, 'SECURITY'), 'fail', 'a SECURITY finding was accepted by the batch answer');
    const d = project(`scaffold standalone no STANDARD autonomous
solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null
A secret-scan LC >/dev/null`);
    assert.equal(gateStatus(d, 'SECRETS'), 'fail', 'the planted secret was not found');
    const rec = verbs(d, "sf=$(ls .agents/runs/LC/gates/*-SECRETS.yaml | tail -1); sed -n 's/^finding: SECRETS-1|blocking|\\([^|]*\\)|\\(.*\\)$/\\1 \\2/p' \"$sf\" | head -1").out.trim();
    batchWith(d, 'b', `accept K SECRETS ${rec.slice(0, rec.indexOf(' '))}: ${rec.slice(rec.indexOf(' ') + 1)}`);
    assert.equal(gateStatus(d, 'SECRETS'), 'fail', 'a SECRETS finding was accepted by the batch answer');
  });

  test('a listed rationale is approved for the batch only with answer b and only as the approved summary lists it', () => {
    const d = project(RUN);
    writeFileSync(`${d}/DESIGN.md`, '# Design\n\n## Pattern justifications\n\n- mono-labels: file names are the product here\n');
    accepted(A(d, ['request-approval', 'LC', 'rationale:mono-labels']), 'request the rationale approval');
    batchWith(d, 'a', 'accept R mono-labels: file names are the product here');
    refused(A(d, ['batch-cover', 'LC', 'rationale:mono-labels']), 'a rationale covered although the user answered a');
    batchWith(d, 'b', 'accept R mono-labels: file names are the product here');
    accepted(A(d, ['request-approval', 'LC', 'rationale:mono-labels']), 'request again');
    accepted(A(d, ['batch-cover', 'LC', 'rationale:mono-labels']), 'the accepted rationale was refused');
    assert.equal(A(d, ['design-rationales', 'LC']).out.split('\n')[0].split('\t').slice(0, 2).join('\t'), 'mono-labels\tapproved');
    writeFileSync(`${d}/DESIGN.md`, '# Design\n\n## Pattern justifications\n\n- mono-labels: changed after the user accepted it\n');
    accepted(A(d, ['request-approval', 'LC', 'rationale:mono-labels']), 'request after the edit');
    refused(A(d, ['batch-cover', 'LC', 'rationale:mono-labels']), 'an edited DESIGN.md line covered by the old acceptance');
    refused(A(d, ['batch-cover', 'LC', 'waive:QA-1']), 'a waiver covered by the batch', 'not covered by the batch approval');
  });
});
