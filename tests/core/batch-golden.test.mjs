// @ts-check
// Golden recordings of the night batch (A225, #172): the texts the lead and the user read - the plan summary with its pre-flight questions, the
// digest `batch-next`, the morning table `batch-status`, the recorded answers and the refusals of `batch-plan` - recorded ONCE from the old shell
// code (control-plane/agents/scripts/batch.sh, deleted in the same change) on deterministic fixtures, and held to byte for byte by the Node code.
// Only the volatile parts are masked: the nonce line, the batch id (12 hex digits of the summary hash), the approval time, the project folder and a pid.
// One deliberate difference from the old text (A225): in the morning table a merged task's row put the pull request in the "park reason" column and the raw epoch in the
// "pending question" column (the shell's `read` collapsed the empty tab-separated fields); it now shows the PR, the merge time and dashes.
// Re-record with `BATCH_GOLDEN_RECORD=1 node --test tests/core/batch-golden.test.mjs` only for a reviewed change of the specification.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AB, batchApprove, behave, bnew, binstall, drive, fakes, mkprio, mktask, put, read, readIf, real, wtp, writeFileSync, mkdirSync, path } from './batch-lib.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync as mk, readFileSync, writeFileSync as wf } from 'node:fs';

const GOLDEN = path.join(import.meta.dirname, 'golden', 'batch');
const record = process.env.BATCH_GOLDEN_RECORD === '1';

/** Mask what changes from run to run. @param {string} text @param {string} dir */
function norm(text, dir) {
  const d = real(dir);
  return text.split(d).join('<DIR>').split(dir).join('<DIR>')
    .replace(/^nonce: .*$/gm, 'nonce: <NONCE>')
    .replace(/\b[0-9a-f]{12}\b/g, '<BID>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<TS>')
    .replace(/\b1[67][0-9]{8}\b/g, '<EPOCH>')
    .replace(/pid \d+/g, 'pid <PID>').replace(/-w \d+/g, '-w <PID>').replace(/owned by pid \d+/g, 'owned by pid <PID>')
    .replace(/\/tmp\/[^ )\n]*|\/var\/folders\/[^ )\n]*/g, '<TMP>');
}
/** @param {string} name @param {string} got */
function check(name, got) {
  const f = path.join(GOLDEN, `${name}.txt`);
  if (record) { mk(GOLDEN, { recursive: true }); wf(f, got); return; }
  assert.equal(got, readFileSync(f, 'utf8'), `golden ${name}`);
}
/** stdout, stderr and exit status of a call as one text. @param {{ status: number|null, out: string, err: string }} r */
const show = (r) => `--- exit ${r.status}\n--- stdout\n${r.out}--- stderr\n${r.err}`;

test('golden: the plan of a priority and dependency batch, the digest before and after the approval, the status table', () => {
  const F = fakes();
  const dir = bnew();
  mktask(dir, 'T-1', 'STANDARD'); mkprio(dir, 'T-2', 'low'); mkprio(dir, 'T-3', 'high'); mkprio(dir, 'T-4', 'high', 'T-2'); mkprio(dir, 'T-5', 'medium');
  mktask(dir, 'T-6', 'CRITICAL'); mktask(dir, 'T-7', 'none'); mktask(dir, 'T-8', 'COMPLEX', 'T-6');
  binstall(dir, { remote: false });
  const plan = AB(F, dir, ['batch-plan', 'all']);
  const out = [];
  out.push(['plan all', norm(show(plan), dir)]);
  for (const f of ['SUMMARY.md', 'order.tsv', 'lint.tsv', 'paths.tsv', 'accept.tsv']) out.push([f, norm(readIf(`${dir}/.agents/local/batch/${f}`), dir)]);
  out.push(['next unapproved', norm(show(AB(F, dir, ['batch-next'])), dir)]);
  out.push(['next --tsv unapproved', norm(show(AB(F, dir, ['batch-next', '--tsv'])), dir)]);
  out.push(['status unapproved', norm(show(AB(F, dir, ['batch-status'])), dir)]);
  batchApprove(dir);
  out.push(['next approved', norm(show(AB(F, dir, ['batch-next'])), dir)]);
  out.push(['next --tsv approved', norm(show(AB(F, dir, ['batch-next', '--tsv'])), dir)]);
  out.push(['status approved', norm(show(AB(F, dir, ['batch-status'])), dir)]);
  out.push(['plan again (continue)', norm(show(AB(F, dir, ['batch-plan', 'all'])), dir)]);
  out.push(['plan outside', norm(show(AB(F, dir, ['batch-plan', 'T-1', 'T-9'])), dir)]);
  check('priority-plan', out.map(([k, v]) => `===== ${k}\n${v}`).join('\n'));
});

test('golden: a batch that ran - parked, skipped, waiting, merged; the digest, the status table and the lead parks', () => {
  const F = fakes();
  const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX'); mktask(dir, 'T-2', 'COMPLEX', 'T-1'); mktask(dir, 'T-3', 'COMPLEX'); mktask(dir, 'T-4', 'COMPLEX'); mktask(dir, 'T-5', 'COMPLEX');
  binstall(dir);
  AB(F, dir, ['batch-plan', 'all']);
  batchApprove(dir);
  behave(F, 'T-1', 'question'); behave(F, 'T-4', 'await');
  assert.equal(AB(F, dir, ['batch-park', 'T-5', 'tab\there and\nnewline']).status, 0);
  drive(F, dir);
  const out = [];
  out.push(['next', norm(show(AB(F, dir, ['batch-next'])), dir)]);
  out.push(['next --tsv', norm(show(AB(F, dir, ['batch-next', '--tsv'])), dir)]);
  out.push(['status', norm(show(AB(F, dir, ['batch-status'])), dir)]);
  out.push(['park', norm(show(AB(F, dir, ['batch-park', 'T-5', '--clear'])), dir)]);
  out.push(['park unknown', norm(show(AB(F, dir, ['batch-park', 'T-9', 'x'])), dir)]);
  out.push(['next after', norm(show(AB(F, dir, ['batch-next'])), dir)]);
  put(`${wtp(dir, 'T-1')}/.agents/runs/T-1/questions/001.answer.md`, 'a\n'); behave(F, 'T-1', 'merge');
  out.push(['next answered', norm(show(AB(F, dir, ['batch-next'])), dir)]);
  check('ran-batch', out.map(([k, v]) => `===== ${k}\n${v}`).join('\n'));
});

test('golden: the pre-flight questions, the answers in the user\'s words, and the refusals', () => {
  const F = fakes();
  const dir = bnew();
  const body = (/** @type {string} */ extra) => `## Goal\n\nIt works.\n\n## Context\n\nChanges${extra}.\n\n## Acceptance criteria\n\n- AC-1: the output is better\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\nCOMPLEX because it touches many modules\n`;
  let paths = ''; for (let i = 1; i <= 18; i++) paths += ` \`src/m${i}.js\``;
  put(`${dir}/.agents/tasks/P-1.md`, `# Task: P-1 — wide task\n\n${body(`${paths} and the pages \`docs/g1.md\`, \`docs/g2.md\`. This adds a new dependency on a library`)}`);
  mktask(dir, 'P-2', 'STANDARD'); mktask(dir, 'P-3', 'COMPLEX');
  put(`${dir}/.agents/tasks/S-1.md`, '# Task: S-1 — scoped\n\n## Goal\n\nIt works.\n\n## Context\n\nChanges `src/a.js` and `lib/x.js`.\n\n## Acceptance criteria\n\n- AC-1: the output lists three rows\n\n## Out of scope\n\n- Other.\n\n## Constraints\n\n- POSIX sh.\n\n## Risks\n\n- None.\n\n## Suggested class\n\nSTANDARD because it is small.\n\n## Allowed scope\n\n- `src/`\n\n## Forbidden scope\n\n- `lib/y.js`\n');
  put(`${dir}/.agents/tasks/B-1.md`, '# Task: B-1 — Crash\n\n---\ntype: bug\n---\n\n## Goal\n\nIt works.\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nTRIVIAL\n');
  binstall(dir, { remote: false });
  const out = [];
  const plan = AB(F, dir, ['batch-plan', 'P-1', 'P-2', 'P-3', 'S-1', 'B-1']);
  out.push(['plan', norm(show(plan), dir)]);
  out.push(['lint.tsv', norm(readIf(`${dir}/.agents/local/batch/lint.tsv`), dir)]);
  out.push(['answers before', norm(show(AB(F, dir, ['batch-answers'])), dir)]);
  batchApprove(dir);
  out.push(['answer none', norm(show(AB(F, dir, ['batch-answer'])), dir)]);
  const hist = `${dir}/.agents/local/prompts/history`;
  mkdirSync(hist, { recursive: true });
  const now = Math.floor(Date.now() / 1000) + 10;
  put(`${hist}/${now}-aaaa1111.txt`, 'thanks, looks fine\n');
  out.push(['answer remark', norm(show(AB(F, dir, ['batch-answer'])), dir)]);
  put(`${hist}/${now + 1}-bbbb2222.txt`, 'Q1: do not split, Q2 a, Q3 b\nQ4 a. Q5 recommended\n');
  out.push(['answer 1', norm(show(AB(F, dir, ['batch-answer'])), dir)]);
  out.push(['answers', norm(show(AB(F, dir, ['batch-answers'])), dir)]);
  out.push(['answers P-1', norm(show(AB(F, dir, ['batch-answers', 'P-1'])), dir)]);
  put(`${hist}/${now + 2}-cccc3333.txt`, 'all recommended\n');
  out.push(['answer 2', norm(show(AB(F, dir, ['batch-answer'])), dir)]);
  out.push(['answers 2', norm(show(AB(F, dir, ['batch-answers'])), dir)]);
  put(`${hist}/${now + 3}-dddd4444.txt`, 'Q1 bölmeli\nQ2 hayir\nQ6 b\n');
  out.push(['answer 3', norm(show(AB(F, dir, ['batch-answer'])), dir)]);
  out.push(['next', norm(show(AB(F, dir, ['batch-next'])), dir)]);
  out.push(['status', norm(show(AB(F, dir, ['batch-status'])), dir)]);
  check('preflight', out.map(([k, v]) => `===== ${k}\n${v}`).join('\n'));
});

test('golden: the refusals of batch-plan (cycle, reserved word, invalid id, unknown task, adapter, nothing to batch, removed flag)', () => {
  const F = fakes();
  const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX', 'T-2'); mktask(dir, 'T-2', 'COMPLEX', 'T-3'); mktask(dir, 'T-3', 'COMPLEX', 'T-1'); mktask(dir, 'T-4', 'CRITICAL'); mktask(dir, 'T-5', 'COMPLEX', 'T-4');
  binstall(dir, { remote: false });
  const out = [];
  for (const args of [['T-1', 'T-2', 'T-3'], ['run'], ['all', 'T-1'], ['bad!id'], ['NOPE'], [], ['T-4', 'T-5'], ['--codex-danger-full-access', 'T-4'], ['--replace']]) {
    out.push([`plan ${args.join(' ')}`, norm(show(AB(F, dir, ['batch-plan', ...args])), dir)]);
  }
  const cfg = `${dir}/.agents/config.yaml`;
  writeFileSync(cfg, read(cfg).replace(/^ {2}adapter: markdown/m, '  adapter: github'));
  out.push(['plan adapter', norm(show(AB(F, dir, ['batch-plan', 'all'])), dir)]);
  check('plan-refusals', out.map(([k, v]) => `===== ${k}\n${v}`).join('\n'));
});

test('golden: the sleep inhibitor texts', () => {
  const F = fakes();
  const dir = bnew();
  mktask(dir, 'T-1', 'COMPLEX');
  binstall(dir, { remote: false });
  AB(F, dir, ['batch-plan', 'all']); batchApprove(dir);
  const out = [];
  const sleeper = (/** @type {string} */ kind) => {
    const p = spawn('sleep', ['60'], { stdio: 'ignore' });
    const r = AB(F, dir, ['batch-awake'], { env: { PROOFLINE_SESSION_PID: String(p.pid), PROOFLINE_UNAME: kind } });
    return { r, p };
  };
  for (const kind of ['Darwin', 'Linux']) {
    const { r, p } = sleeper(kind);
    out.push([`awake ${kind}`, norm(show(r), dir)]);
    p.kill();
  }
  const { r, p } = (() => { const q = spawn('sleep', ['60'], { stdio: 'ignore' }); return { r: AB(F, dir, ['batch-awake'], { env: { PROOFLINE_SESSION_PID: String(q.pid), PROOFLINE_UNAME: 'Linux', PROOFLINE_BATCH_INHIBIT: 'none' } }), p: q }; })();
  out.push(['awake none', norm(show(r), dir)]);
  p.kill();
  check('awake', out.map(([k, v]) => `===== ${k}\n${v}`).join('\n'));
});

