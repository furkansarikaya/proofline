// @ts-check
// A365 (issue 338 C5): the lead's context. The routine commands print at most `output_cap_bytes` (default 6000) with one hint line to the full output, `next` and
// `batch-next` take `--since <token>` and answer `unchanged` when nothing changed, and `digest <ID> --brief` is the short resume brief.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
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

/** Set `output_cap_bytes` in the project's config. @param {string} d @param {string} value */
function setCap(d, value) {
  const cfg = path.join(d, '.agents/config.yaml');
  const text = readFileSync(cfg, 'utf8').replace(/^output_cap_bytes:.*\n/m, '');
  writeFileSync(cfg, `${text}\noutput_cap_bytes: ${value}\n`);
}

test('digest over the cap prints the head, one hint line, and --full prints it all', () => {
  const d = bigRun(20000);
  const full = A(d, ['digest', 'LC', '--full']);
  assert.equal(full.status, 0);
  assert.ok(full.out.length > 20000, 'the fixture is large without the cap');
  const cut = A(d, ['digest', 'LC']);
  assert.equal(cut.status, 0);
  assert.ok(cut.out.length < 6400, `capped: ${cut.out.length}`);
  const lines = cut.out.trimEnd().split('\n');
  const hint = lines.at(-1) ?? '';
  assert.match(hint, /^\.\.\.\d+ more bytes: agent\.sh digest LC --full$/);
  const head = lines.slice(0, -1).join('\n');
  assert.ok(full.out.startsWith(head));
  const left = Number(hint.match(/\d+/)?.[0]);
  assert.ok(left > 14000 && left < full.out.length, String(left));
});

test('output_cap_bytes in the config changes the cap and 0 switches it off', () => {
  const d = bigRun(3000);
  setCap(d, '800');
  const small = A(d, ['digest', 'LC']);
  assert.ok(small.out.length < 1000 && /more bytes: agent\.sh digest LC --full/.test(small.out), String(small.out.length));
  setCap(d, '0');
  assert.ok(A(d, ['digest', 'LC']).out.length > 3000);
});

test('config-check refuses a cap between 1 and 499 and a non-number', () => {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  setCap(d, '100');
  assert.match(A(d, ['config-check']).text, /output_cap_bytes is 0 \(no cap\) or at least 500/);
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
  const d = bigRun(5000);
  const b = A(d, ['digest', 'LC', '--brief']);
  assert.equal(b.status, 0);
  const lines = b.out.trimEnd().split('\n');
  assert.ok(lines.length <= 6, b.out);
  assert.match(lines[0], /^STATUS: /);
  assert.ok(lines.some((l) => l.startsWith('NEXT: ')));
  assert.ok(b.out.length < 1500, String(b.out.length));
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
