// @ts-check
// perf-test.sh (A203, 176-D3) as Node tests: `agent.sh next` and `agent.sh digest` on a run of realistic size stay cheap in PROCESSES. In 0.0.39 one `next`
// started about 840 awk processes (next 9 s, digest 46 s) because each gate, risk signal and run value was computed again in a subshell of its own. The
// assertion is the number of external processes (a PATH shim counts every common tool, never the clock). The shell test also asserted a 90 s wall-clock
// budget; that assertion is DROPPED (the maintainer's rule of 2026-11-08: a time-dependent test must be deterministic and stable under load): the counts
// are the point of the test and a regression that costs time costs processes first (A243).
// The fixture: a frozen COMPLEX run at IMPLEMENTED with passing gate records, 120 more ledger lines, 30 result files and the hook timings of 12 hook
// flushes. A hook timing is never a ledger line (A203). The control plane runs on the live Node path (A242), so the shim counts what the product starts.
//   PERF_REPORT=1 prints the numbers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, accepted, gpass, must, pipe, repo, scaffold, tmp, useLiveCore, worker } from '../lib/harness.mjs';
useLiveCore();

// The budgets: tests/bench/next-digest-budgets.tsv (the shell test allowed 260 and 340 on the same fixture; the Node core is measured at 9, A243).
/** @type {Record<string, number>} */ const BUDGET = {};
for (const l of readFileSync(path.join(repo, 'tests/bench/next-digest-budgets.tsv'), 'utf8').split('\n')) {
  if (!l || l.startsWith('#')) continue;
  const f = l.split('\t'); assert.ok(f.length === 4 && f.slice(1).every((x) => /^\d+$/.test(x)), `next-digest-budgets.tsv: expected path<TAB>max_procs<TAB>measured<TAB>before: ${l}`);
  BUDGET[f[0]] = Number(f[1]);
}
const NEXT_SPAWN_MAX = BUDGET.next; const DIGEST_SPAWN_MAX = BUDGET.digest;
assert.ok(NEXT_SPAWN_MAX > 0 && DIGEST_SPAWN_MAX > 0, 'the budget table lacks next or digest');
const SHIMMED = ['git', 'sha256sum', 'shasum', 'find', 'cat', 'sed', 'awk', 'grep', 'sort', 'wc', 'node', 'jq', 'du', 'ls', 'cp', 'tr', 'cut', 'head', 'tail', 'xargs', 'date', 'mktemp', 'mv', 'rm', 'mkdir', 'expr', 'basename', 'dirname', 'uniq', 'od', 'ps', 'tee', 'comm', 'diff'];
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const required = (/** @type {string} */ d) => pipe(d, 'gates').split(/\s+/).filter(Boolean);

/** The process-counting wrapper: one script per common tool that logs a line and execs the real one (builtins only: it starts no process of its own). */
function makeShim() {
  const dir = tmp('shim');
  for (const c of SHIMMED) {
    const found = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', ...(process.env.PATH ?? '').split(':')].map((p) => path.join(p, c)).find((f) => { try { readFileSync(f); return true; } catch { return false; } });
    if (!found) continue;
    writeFileSync(path.join(dir, c), `#!/bin/sh\nprintf "SPAWN %s %.30s %.24s %.24s\\n" "${c}" "$1" "$2" "$3" >> "$PERF_LOG"\nexec ${found} "$@"\n`);
    chmodSync(path.join(dir, c), 0o755);
  }
  return dir;
}

/** The fixture: a frozen COMPLEX run at IMPLEMENTED with gates passed, hook timings, 120 ledger lines and 30 result files. @returns {string} */
function perfFixture() {
  const d = scaffold({ topology: 'orchestrated', cls: 'COMPLEX' });
  worker(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); must(d, ['secret-scan', 'LC']);
  let n = 0;
  for (const g of required(d)) {
    if (g === 'SECRETS' || g === 'VERIFY') continue;
    if (++n > 3) break;
    gpass(d, g);
  }
  // the hook timings of 12 flushes, as the runtime hooks spool them
  for (let i = 0; i < 12; i++) {
    appendFileSync(path.join(d, '.agents/local/hook-times'), ['pretool', 'posttool', 'prompt', 'stop', 'session'].map((e) => `1|${e}|12|ok|\n`).join(''));
    must(d, ['hook-time', 'LC']);
  }
  // 120 more ledger lines (notes), chained exactly like the control plane chains them
  const ledger = path.join(d, '.agents/runs/LC/LEDGER.log');
  let last = readFileSync(ledger, 'utf8').trimEnd().split('\n').at(-1) ?? '';
  let seq = Number(/^seq=(\d+)/.exec(last)?.[1]); const dg = /digest=(\S+)/.exec(last)?.[1];
  for (let i = 0; i < 120; i++) {
    const prev = sha(last); seq += 1;
    last = `seq=${seq} prev=${prev} event=note role=lead from=IMPLEMENTED to=IMPLEMENTED digest=${dg} ts=2026-01-01T00:00:00Z epoch=1 detail=perf fixture note ${i}`;
    appendFileSync(ledger, `${last}\n`);
  }
  // 30 result files of earlier dispatches
  mkdirSync(path.join(d, '.agents/runs/LC/results'), { recursive: true });
  for (let i = 0; i < 30; i++) writeFileSync(path.join(d, `.agents/runs/LC/results/9${String(i).padStart(2, '0')}-explorer.result.md`), 'ROLE: explorer\nTASK: LC\nRESULT: DONE\n');
  accepted(A(d, ['verify-seal', 'LC']), 'fixture: the synthetic ledger does not verify');
  return d;
}

/** One command through the shim: its answer and the number of processes it started. @param {string} d @param {string} shim @param {string} cmd */
function measure(d, shim, cmd) {
  const log = path.join(tmp('log'), `spawn.${cmd}`); writeFileSync(log, '');
  const r = A(d, [cmd, 'LC'], { env: { PATH: `${shim}:${process.env.PATH}`, PERF_LOG: log } });
  assert.equal(r.status, 0, `agent.sh ${cmd} failed: ${r.text}`);
  const spawns = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('SPAWN'));
  const by = new Map(); for (const l of spawns) by.set(l.split(' ')[1], (by.get(l.split(' ')[1]) ?? 0) + 1);
  const kinds = [...by].map(([k, v]) => `${k}=${v}`).join(' ');
  if (process.env.PERF_REPORT) process.stdout.write(`perf: ${cmd}: ${spawns.length} processes (${kinds})\n`);
  return { out: r.out + r.err, spawns: spawns.length, kinds };
}

test('sc_next_digest_budget: next and digest stay under the process budget on a realistic run', () => {
  const d = perfFixture(); const shim = makeShim();
  let m = measure(d, shim, 'next');
  assert.ok(m.spawns <= NEXT_SPAWN_MAX, `next started ${m.spawns} processes on a realistic run (budget ${NEXT_SPAWN_MAX}): ${m.kinds}`);
  assert.ok(/^next=/m.test(m.out), `next printed no next= line: ${m.out}`);
  m = measure(d, shim, 'digest');
  assert.ok(m.spawns <= DIGEST_SPAWN_MAX, `digest started ${m.spawns} processes on a realistic run (budget ${DIGEST_SPAWN_MAX}): ${m.kinds}`);
  assert.ok(/^NEXT: /m.test(m.out), `digest printed no NEXT: line: ${m.out}`);
});

// the speed-up changed no output: the same digest, with the gate list and the risk signals read once, as without
test('sc_digest_same_output: digest agrees with next, and a recorded gate is seen by the next process', () => {
  const d = perfFixture();
  const a = accepted(A(d, ['digest', 'LC']), 'digest failed').text; const n = accepted(A(d, ['next', 'LC']), 'next failed').text;
  assert.ok(/^STATUS: /m.test(a) && /^OPEN QUESTIONS: 0$/m.test(a), `digest lost its header: ${a}`);
  // the NEXT:/WHY: lines of digest are the next=/reason= lines of next
  const nx = n.split('\n').filter((l) => /^(next|reason)=/.test(l)).map((l) => l.replace(/^next=/, 'NEXT: ').replace(/^reason=/, 'WHY: ')).join('\n');
  const dx = a.split('\n').filter((l) => /^(NEXT|WHY): /.test(l)).join('\n');
  assert.equal(dx, nx, `digest and next disagree: [${dx}] vs [${nx}]`);
  // a gate recorded after a first digest is seen by the next digest (the memo lives for one process only)
  const g = required(d).filter((x) => x !== 'SECRETS' && x !== 'VERIFY')[3];
  if (g) {
    gpass(d, g);
    const b = accepted(A(d, ['digest', 'LC']), 'digest failed after a gate').text;
    assert.notEqual(a, b, 'a gate recorded after a digest is not seen by the next digest');
  }
});

// A hook timing is never a ledger line: the chained ledger holds lifecycle transitions only
test('sc_hook_events_not_in_ledger: hook events go to HOOKS.log, never to the hash-chained ledger', () => {
  const d = scaffold({ topology: 'orchestrated' });
  const ledger = path.join(d, '.agents/runs/LC/LEDGER.log'); const lines = () => readFileSync(ledger, 'utf8').split('\n').filter((l) => l !== '').length;
  const before = lines();
  appendFileSync(path.join(d, '.agents/local/hook-times'), '1|posttool|12|ok|\n2|pretool|7|ok|\n3|stop|900|timeout|slow\n');
  must(d, ['hook-time', 'LC']);
  assert.ok(!/ event=hook(-timeout)? /.test(readFileSync(ledger, 'utf8')), 'a hook event entered the ledger');
  assert.equal(lines(), before, 'hook-time added ledger lines');
  const hooks = readFileSync(path.join(d, '.agents/runs/LC/HOOKS.log'), 'utf8');
  assert.ok(hooks.includes(' event=hook ') && hooks.includes(' event=hook-timeout '), `the hook events are not in HOOKS.log: ${hooks}`);
  accepted(A(d, ['verify-seal', 'LC']), 'hook events broke the ledger seal');
});
