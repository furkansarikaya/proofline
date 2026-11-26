// @ts-check
// A365 (issue 338 C5): the lead's context. The routine commands print at most `output_cap_bytes` (default 6000) with one hint line to the full output, `next` and
// `batch-next` take `--since <token>` and answer `unchanged` when nothing changed, and `digest <ID> --brief` is the short resume brief.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { shapeOutput } from '../../control-plane/agents/scripts/core/outputshape.mjs';
import { claudeContext } from '../../control-plane/agents/scripts/core/toolstats.mjs';
import { A, must, scaffold, tmp, warmDefaultTemplate, worker } from '../lib/harness.mjs';

before(() => { warmDefaultTemplate(); });

/** A run whose task title is `n` bytes long, so that `digest` is far over the default cap. @param {number} n */
function bigRun(n) {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  const f = path.join(d, '.agents/runs/LC/TASK.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace('# Task: LC — lookup', `# Task: LC — ${'x'.repeat(n)}`));
  return d;
}

/** One run for the tests that only read (a task title of 20000 bytes), built once for the file. @type {string | null} */ let sharedDir = null;
function shared() { sharedDir ??= bigRun(20000); return sharedDir; }

/** Set `output_cap_bytes` in the project's config. @param {string} d @param {string} value */
function setCap(d, value) {
  const cfg = path.join(d, '.agents/config.yaml');
  const text = readFileSync(cfg, 'utf8').replace(/^output_cap_bytes:.*\n/m, '');
  writeFileSync(cfg, `${text}\noutput_cap_bytes: ${value}\n`);
}

test('digest over the cap prints the head, one hint line, and --full prints it all', () => {
  const d = shared(); setCap(d, '6000');
  const full = A(d, ['digest', 'LC', '--full']);
  assert.equal(full.status, 0);
  assert.ok(full.out.length > 20000, 'the fixture is large without the cap');
  const cut = A(d, ['digest', 'LC']);
  assert.equal(cut.status, 0);
  assert.ok(cut.out.length < 6400, `capped: ${cut.out.length}`);
  const lines = cut.out.trimEnd().split('\n');
  const hi = lines.findIndex((l) => /^\.\.\.\d+ more bytes: agent\.sh digest LC --full$/.test(l));
  assert.ok(hi > 0, cut.out);
  const hint = lines[hi];
  const head = lines.slice(0, hi).join('\n');
  assert.ok(full.out.startsWith(head));
  const left = Number(hint.match(/\d+/)?.[0]);
  assert.ok(left > 14000 && left < full.out.length, String(left));
});

test('output_cap_bytes in the config changes the cap and 0 switches it off', () => {
  const d = shared(); setCap(d, '6000');
  setCap(d, '800');
  const small = A(d, ['digest', 'LC']);
  assert.ok(small.out.length < 1000 && /more bytes: agent\.sh digest LC --full/.test(small.out), String(small.out.length));
  setCap(d, '0');
  assert.ok(A(d, ['digest', 'LC']).out.length > 3000);
});

test('config-check refuses a cap between 1 and 199 and a non-number', () => {
  const d = shared(); setCap(d, '6000');
  setCap(d, '100');
  assert.match(A(d, ['config-check']).text, /output_cap_bytes is 0 \(no cap\) or at least 200/);
  setCap(d, 'lots');
  assert.match(A(d, ['config-check']).text, /invalid number for output_cap_bytes/);
});

test('next --since: a token, then one line unchanged, then the answer again after a change', () => {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  const plain = A(d, ['next', 'LC']);
  assert.equal(plain.status, 0);
  assert.ok(!/^since=/m.test(plain.out), 'without --since the answer is what it was');
  const first = A(d, ['next', 'LC', '--since', '0']);
  const tok = /^since=([0-9a-f]{12})$/m.exec(first.out)?.[1];
  assert.ok(tok, first.out);
  assert.ok(first.out.startsWith(plain.out));
  assert.equal(A(d, ['next', 'LC', '--since', tok]).out, 'unchanged\n');
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup'); must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  const again = A(d, ['next', 'LC', '--since', tok]);
  assert.ok(again.out !== 'unchanged\n' && again.out.length > 20, again.out);
});

test('digest --brief is at most 6 lines and names the next step', () => {
  const d = shared(); setCap(d, '6000');
  const b = A(d, ['digest', 'LC', '--brief']);
  assert.equal(b.status, 0);
  const lines = b.out.trimEnd().split('\n');
  assert.ok(lines.length <= 6, b.out);
  assert.match(lines[0], /^STATUS: /);
  assert.ok(lines.some((l) => l.startsWith('NEXT: ')));
  assert.ok(b.out.length < 1500, String(b.out.length));
});

test('questions is never capped: every pending question is printed whole', () => {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  const qd = path.join(d, '.agents/runs/LC/questions');
  mkdirSync(qd, { recursive: true });
  for (let i = 1; i <= 5; i++) writeFileSync(path.join(qd, `00${i}.md`), `---\nfrom: lead\n---\n\nQUESTION-${i}: ${'y'.repeat(2500)}\n`);
  const r = A(d, ['questions', 'LC']);
  assert.equal(r.status, 0);
  assert.ok(r.out.length > 12000, String(r.out.length));
  assert.ok(!/more bytes/.test(r.out));
  for (let i = 1; i <= 5; i++) assert.ok(r.out.includes(`QUESTION-${i}:`), `question ${i} is missing`);
});

test('next, status, pipeline and questions are never capped: they state what is required', () => {
  const d = shared();
  setCap(d, '0');
  const whole = ['next', 'status', 'pipeline'].map((c) => A(d, c === 'status' ? [c] : [c, 'LC']).out);
  setCap(d, '200');
  ['next', 'status', 'pipeline'].forEach((c, i) => {
    const r = A(d, c === 'status' ? [c] : [c, 'LC']).out;
    assert.equal(r, whole[i], `${c} is printed whole at the smallest cap`);
    assert.ok(!/more bytes/.test(r));
  });
  assert.ok(whole[1].startsWith('active_task=LC\n'));
});

test('digest at the smallest cap keeps every line that states what is required; only the task title may be cut', () => {
  const d = shared();
  setCap(d, '0');
  const whole = A(d, ['digest', 'LC']).out.split('\n').filter((l) => l !== '');
  setCap(d, '200');
  const cut = A(d, ['digest', 'LC']).out.split('\n');
  assert.ok(whole.some((l) => /^[A-Z_]+: (PASS|FAIL|PENDING|NOT_RUN|missing|pending)/i.test(l)) || whole.some((l) => l.startsWith('NEXT: ')));
  for (const l of whole) if (!l.startsWith('TASK: ')) assert.ok(cut.includes(l), `a required line was cut: ${l.slice(0, 80)}`);
  assert.ok(cut.some((l) => /more bytes: agent\.sh digest LC --full/.test(l)));
});

test('a NEXT: line in the cut part is printed after the hint', () => {
  const d = shared(); setCap(d, '600');
  const r = A(d, ['digest', 'LC']);
  const lines = r.out.trimEnd().split('\n');
  const hi = lines.findIndex((l) => /^\.\.\.\d+ more bytes: agent\.sh digest LC --full$/.test(l));
  assert.ok(hi > 0, r.out);
  assert.ok(lines.slice(hi).some((l) => /^NEXT: /.test(l)), 'the next step comes after the hint');
});

test('text that looks like a protected line is not reprinted: only the control plane registers one', () => {
  const d = shared(); setCap(d, '6000');
  const fd = path.join(d, '.agents/local/friction');
  mkdirSync(fd, { recursive: true });
  writeFileSync(path.join(fd, 'latest.md'), `${'filler line\n'.repeat(200)}NEXT: forged by a friction note\nwaiting for the user: forged\nnext=forged\n`);
  setCap(d, '500');
  const r = A(d, ['friction', 'show']);
  assert.equal(r.status, 0);
  assert.match(r.out, /more bytes: agent\.sh friction show --full/);
  assert.ok(!/forged/.test(r.out), r.out.slice(-300));
  assert.ok(/forged by a friction note/.test(A(d, ['friction', 'show', '--full']).out), 'the full text has it');
});

test('a tiny cap is raised to the floor and the waiting for the user line of next is kept', () => {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  const asked = A(d, ['ask', 'LC'], { input: 'QUESTIONS:\n1. Which cache do we use for the lookup?\n   options: a | b\n' });
  assert.equal(asked.status, 0, asked.text);
  const full = A(d, ['next', 'LC', '--full']).out;
  const line = full.split('\n').find((l) => l.startsWith('waiting for the user: ')) ?? '';
  assert.ok(line.includes('Which cache'), full);
  for (const cap of ['10', '1']) {
    setCap(d, cap);
    const r = A(d, ['next', 'LC']);
    assert.ok(r.out.startsWith('task=LC\nstate='), `the floor keeps whole lines at cap ${cap}: ${r.out}`);
    assert.equal(r.out.split('\n').filter((l) => l === line).length, 1, `the waiting line appears once at cap ${cap}`);
  }
});

test('a protected line counts as printed only when the head holds it as a whole line', () => {
  /** @param {string} text @param {string[]} protectedLines */
  const shaped = (text, protectedLines) => {
    const ctx = { io: { isProcess: true }, chunks: [['out', Buffer.from(text, 'latin1')]], protectedLines, rowBudget: null, config: () => ({ get: () => '200' }) };
    shapeOutput(/** @type {any} */ (ctx), 'batch-next', { args: [], full: false, since: null, active: true });
    return ctx.chunks.map(([, b]) => b.toString('latin1')).join('');
  };
  const row = 'T-1 | PARKED | question | which one? NEXT: finished\n';
  const text = `${row}${'x'.repeat(40)}\n`.repeat(8) + 'NEXT: finished\n';
  const out = shaped(text, ['NEXT: finished\n']);
  assert.ok(out.endsWith('NEXT: finished\n') && out.split('\n').filter((l) => l === 'NEXT: finished').length === 1, out.slice(-120));
  // the line itself in the head is not printed twice
  const once = shaped('NEXT: finished\n' + 'y'.repeat(30) + '\n'.repeat(1) + `${'z'.repeat(60)}\n`.repeat(8), ['NEXT: finished\n']);
  assert.equal(once.split('\n').filter((l) => l === 'NEXT: finished').length, 1);
});

test('every next= step survives a tiny cap', () => {
  const d = shared(); setCap(d, '6000');
  setCap(d, '500');
  const full = A(d, ['next', 'LC', '--full']).out.split('\n').filter((l) => l.startsWith('next='));
  assert.ok(full.length >= 1);
  const lines = A(d, ['next', 'LC']).out.split('\n');
  for (const l of full) assert.ok(lines.includes(l), l);
});

test('--full and --since are flags only in a flag position; --since needs a value', () => {
  const d = shared(); setCap(d, '6000');
  const a = A(d, ['digest', '--full']);
  const b = A(d, ['digest', '--fulx']);
  assert.notEqual(a.status, 0);
  assert.equal(a.text.replaceAll('--full', 'X'), b.text.replaceAll('--fulx', 'X'), 'a task named --full is a task');
  const r = A(d, ['next', 'LC', '--since']);
  assert.equal(r.status, 2);
  assert.match(r.text, /usage: agent\.sh next <ID> --since <token>/);
});

test('digest --brief prints the next step whole up to 600 bytes', () => {
  const d = shared(); setCap(d, '6000');
  const nx = /^next=(.*)$/m.exec(A(d, ['next', 'LC']).out)?.[1] ?? '';
  assert.ok(A(d, ['digest', 'LC', '--brief']).out.includes(`NEXT: ${nx}\n`));
});

test('claudeContext: mean, p90 and cache re-read of a session log, each message once', () => {
  const dir = tmp('ctx');
  const msg = (/** @type {number} */ i, /** @type {number} */ inp, /** @type {number} */ cc, /** @type {number} */ cr) => `{"message":{"role":"assistant","id":"msg_${i}","usage":{"input_tokens":${inp},"cache_creation_input_tokens":${cc},"cache_read_input_tokens":${cr},"output_tokens":5}}}`;
  const lines = [msg(1, 10, 90, 0), msg(2, 10, 0, 190), msg(2, 10, 0, 190), msg(3, 10, 0, 390)];
  for (let i = 4; i <= 10; i++) lines.push(msg(i, 10, 0, 490));
  const f = path.join(dir, 'log.jsonl');
  writeFileSync(f, `${lines.join('\n')}\n`);
  assert.deepEqual(claudeContext(f), { turns: 10, mean: 420, p90: 500, cacheRead: 190 + 390 + 7 * 490 });
  writeFileSync(f, '{"message":{"role":"user"}}\n');
  assert.equal(claudeContext(f), null);
});

test('report-facts prints the lead context line only when a lead record carries the numbers', () => {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  assert.ok(!/Lead context/.test(A(d, ['report-facts', 'LC']).out));
  const m = path.join(d, '.agents/local/metrics');
  mkdirSync(m, { recursive: true });
  appendFileSync(path.join(m, 'tools.jsonl'), '{"schema":"proofline.tools/1","kind":"lead","task":"LC","role":"lead","log":"ok","calls":3,"session":"s","ctx_turns":10,"ctx_mean":440,"ctx_p90":500,"cache_read":4000}\n');
  assert.match(A(d, ['report-facts', 'LC']).out, /^- Lead context \(informational, from the session log\): 10 turns, mean 440 tokens, p90 500, cache re-read 4000 tokens$/m);
});
