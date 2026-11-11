// @ts-check
// A258 (#181 item 3): `agent.sh advance <ID>`, the lead's combined step command. It must save calls WITHOUT saving any check: it runs exactly the commands `next` names, through
// the same entry point, and stops where the separate steps stop. These tests (1) replay one fixed scenario through the real scripts, once with the separate calls the lead's skill
// lists and once with `advance`, and count the calls the lead issues; (2) pin that every step that is a decision, an approval, a gate or a delivery is NOT run by it; (3) pin that where
// a separate command refuses, `advance` refuses with the same status and message and leaves the same state; (4) pin the role gate.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { A, AS, copyOf, must, passAll, qaBind, scaffold, tmp, tsha, worker } from '../lib/harness.mjs';

const RUN = '.agents/runs/LC';
/** @param {string} dir @param {string} f */
const text = (dir, f) => readFileSync(path.join(dir, f), 'utf8');
/** The event names of the run's ledger, in order (what the control plane recorded; times and hashes are left out). @param {string} dir */
const events = (dir) => text(dir, `${RUN}/LEDGER.log`).split('\n').map((l) => /event=(\S+)/.exec(l)?.[1]).filter(Boolean);
/** A value of RUN.yaml: the first key of that name inside the section. @param {string} dir @param {string} section @param {string} k */
function runValue(dir, section, k) {
  const m = new RegExp(`^${section}:\\n((?: .*\\n)*)`, 'm').exec(text(dir, `${RUN}/RUN.yaml`));
  const v = m ? new RegExp(`^ +${k}: (.*)$`, 'm').exec(m[1])?.[1] ?? '' : '';
  return v.replace(/^"(.*)"$/, '$1');
}
/** The `next=` lines of an output. @param {string} out */
const nexts = (out) => out.split('\n').filter((l) => l.startsWith('next=')).map((l) => l.slice(5));

/** A run as `start` leaves it, classified by the caller: STANDARD, with its task branch, evidence, plan and a bound QA plan ready for the freeze. @param {{ autonomy?: string }} [o] */
function fresh(o = {}) {
  const dir = scaffold({ branch: true, fresh: true, cls: 'STANDARD', ...o });
  appendFileSync(path.join(dir, RUN, 'EVIDENCE.md'), 'discovered\n');
  appendFileSync(path.join(dir, RUN, 'PLAN.md'), 'planned\n');
  qaBind(dir, 'LC');
  return dir;
}
/** The implementer's work and its DONE result, as the dispatch leaves them (worker evidence, then the recorded result). @param {string} dir */
function implement(dir) {
  worker(dir, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value');
  worker(dir, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  mkdirSync(path.join(dir, RUN, 'reports'), { recursive: true });
  writeFileSync(path.join(dir, RUN, 'reports/impl.md'), 'implemented\n');
  const f = path.join(tmp('r'), 'result.md');
  const fp = must(dir, ['fingerprint', 'LC']).out.trim();
  writeFileSync(f, `ROLE: implementer\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: ${fp}\nARTIFACT: reports/impl.md ${tsha(path.join(dir, RUN, 'reports/impl.md'))}\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n`);
  must(dir, ['record', 'LC', '--file', f], { role: 'implementer' });
}

/**
 * The lead's part of one run, from "not classified" to "implemented, the gate wave is next", with the calls it issues counted. `combined` false: the separate calls of the
 * skill's Flow table (a `next` before every step, and the facts commands after freeze and IMPLEMENTED). `combined` true: `advance` where the lead used `next`.
 * The decisions (classify) and the specialists' work (implement) are the same in both and are counted apart.
 * @param {string} dir @param {boolean} combined @returns {{ calls: number, commands: string[], last: string, all: string }}
 */
function leadRun(dir, combined) {
  /** @type {string[]} */ const commands = [];
  let all = '';
  const lead = (/** @type {string[]} */ args) => { commands.push(args.join(' ')); const r = A(dir, args); all += r.out; return r; };
  const look = () => lead([combined ? 'advance' : 'next', 'LC']);
  let r = look();
  assert.deepEqual(nexts(r.out), ['agent.sh classify LC <TRIVIAL|STANDARD|COMPLEX|CRITICAL> [review]']);
  assert.equal(lead(['classify', 'LC', 'STANDARD']).status, 0);
  let implemented = false;
  for (let i = 0; i < 20; i++) {
    r = look();
    assert.equal(r.status, 0, r.text);
    const n = nexts(r.out);
    if (n.some((l) => l.startsWith('dispatch.sh LC implementer')) && !implemented) {
      implement(dir); implemented = true;   // the specialist's work: not the lead's calls
      continue;
    }
    if (combined) { if (n.some((l) => l.startsWith('dispatch.sh LC ') || l.startsWith('agent.sh request-approval'))) return { calls: commands.length, commands, last: r.out, all }; continue; }
    const m = /^agent\.sh (branch|baseline|freeze|handoff) (.*)$/.exec(n[0] ?? '');
    if (n.length === 1 && m) {
      assert.equal(lead(m[1] === 'handoff' ? ['handoff', 'LC', m[2].split(' ')[1]] : [m[1], 'LC']).status, 0);
      if (m[1] === 'freeze') assert.equal(lead(['freshness', 'LC']).status, 0);
      if (m[1] === 'handoff' && m[2].endsWith('IMPLEMENTED')) { assert.equal(lead(['tier', 'LC']).status, 0); assert.equal(lead(['pipeline', 'LC']).status, 0); }
      continue;
    }
    if (n.some((l) => l.startsWith('dispatch.sh LC '))) return { calls: commands.length, commands, last: r.out, all };
  }
  throw new Error(`no end: ${commands.join(' | ')}`);
}

describe('the fixed scenario, replayed through the real scripts', () => {
  test('the lead issues 17 calls with separate commands and 4 with advance, and both end in the same state with the same records', () => {
    const a = fresh(); const b = fresh();
    const sep = leadRun(a, false);
    const adv = leadRun(b, true);
    assert.equal(sep.calls, 17, sep.commands.join(' | '));
    assert.equal(adv.calls, 4, adv.commands.join(' | '));
    assert.deepEqual(adv.commands, ['advance LC', 'classify LC STANDARD', 'advance LC', 'advance LC']);
    // the same records: the ledger events in order, the handoff state, the freeze, the baseline
    assert.deepEqual(events(b), events(a));
    for (const [sec, k] of [['handoff', 'state'], ['baseline', 'status'], ['repository', 'task_branch'], ['pipeline', 'classification'], ['pipeline', 'tier'], ['freeze', 'plan_sha256']]) assert.equal(runValue(b, sec, k), runValue(a, sec, k), k);
    assert.equal(runValue(b, 'handoff', 'state'), 'IMPLEMENTED');
    // the gate wave is still the lead's: the same gate lines in the last `next`
    assert.deepEqual(nexts(adv.last), nexts(sep.last));
    // the facts commands the skill asks for after a step ran inside advance too (their output is in it), and the typed ones ran in the separate flow
    for (const c of ['branch LC', 'baseline LC', 'freeze LC', 'freshness LC', 'handoff LC IMPLEMENTING', 'handoff LC IMPLEMENTED', 'tier LC', 'pipeline LC']) {
      assert.ok(adv.all.includes(`agent.sh ${c} (exit 0)`), c);
      assert.ok(sep.commands.includes(c), c);
    }
    assert.ok(nexts(adv.last).length > 0);
  });
});

describe('what advance never runs', () => {
  test('a decision or a specialist step: an unclassified run, a dispatch, the gate wave', () => {
    const dir = fresh();
    const r0 = A(dir, ['advance', 'LC']);
    assert.match(r0.out, /0 step\(s\) run/);
    assert.equal(runValue(dir, 'pipeline', 'classification'), 'PENDING');
    must(dir, ['classify', 'LC', 'STANDARD']);
    must(dir, ['advance', 'LC']);          // branch, baseline, freeze, freshness, IMPLEMENTING
    const r1 = A(dir, ['advance', 'LC']);
    assert.match(r1.out, /0 step\(s\) run/);
    assert.match(r1.out, /next=dispatch\.sh LC implementer/);
    implement(dir);
    must(dir, ['advance', 'LC']);          // IMPLEMENTED
    const r2 = A(dir, ['advance', 'LC']);
    assert.match(r2.out, /0 step\(s\) run/);
    assert.match(r2.out, /next=agent\.sh secret-scan LC/);
    assert.equal(runValue(dir, 'handoff', 'state'), 'IMPLEMENTED');
  });

  test('CODE_DONE: with every gate passing, next says handoff CODE_DONE and advance leaves it to the lead', () => {
    const dir = fresh();
    must(dir, ['classify', 'LC', 'STANDARD']); must(dir, ['advance', 'LC']); implement(dir); must(dir, ['advance', 'LC']);
    passAll(dir);
    const r = A(dir, ['advance', 'LC']);
    assert.deepEqual(nexts(r.out).filter((l) => l.startsWith('agent.sh handoff')), ['agent.sh handoff LC CODE_DONE']);
    assert.match(r.out, /0 step\(s\) run/);
    assert.equal(runValue(dir, 'handoff', 'state'), 'IMPLEMENTED');
    assert.equal(A(dir, ['handoff', 'LC', 'CODE_DONE']).status, 0);      // the typed command is the lead's and still works
  });

  test('an approval: a supervised run stops at the plan approval, nothing is approved and nothing is frozen', () => {
    const dir = fresh({ autonomy: 'supervised' });
    must(dir, ['classify', 'LC', 'STANDARD']);
    const r = A(dir, ['advance', 'LC']);
    assert.equal(r.status, 0, r.text);
    assert.match(r.out, /next=agent\.sh request-approval LC plan/);
    assert.match(r.out, /stopped: the next step is the lead's/);
    assert.deepEqual(readdirSync(path.join(dir, RUN)).filter((n) => n === 'approvals').flatMap((n) => readdirSync(path.join(dir, RUN, n))), []);
    assert.doesNotMatch(text(dir, `${RUN}/RUN.yaml`), /plan_sha256: "[0-9a-f]{8}/);
    assert.ok(!events(dir).includes('freeze'));
  });

  test('a question: a pending question stops it and it is not answered', () => {
    const dir = fresh();
    must(dir, ['classify', 'LC', 'STANDARD']);
    must(dir, ['ask', 'LC'], { input: '1. Which cache?\n   - a\n   - b\n   recommended: a\n   why: because\n' });
    const r = A(dir, ['advance', 'LC']);
    assert.match(r.out, /0 step\(s\) run/);
    assert.match(r.out, /next=agent\.sh questions LC/);
    assert.equal(runValue(dir, 'execution', 'awaiting_input'), 'true');
  });
});

describe('where a separate command refuses, advance refuses the same way', () => {
  /** The same failing situation, once with the typed commands and once with advance. @param {(dir: string) => void} spoil @param {string[][]} typed @param {string[][]} [pre] typed commands run before the situation is spoiled */
  function both(spoil, typed, pre = []) {
    const base = fresh();
    must(base, ['classify', 'LC', 'STANDARD']);
    for (const c of pre) must(base, c);
    spoil(base);
    const a = copyOf(base); const b = copyOf(base);
    /** @type {import('../lib/harness.mjs').Result | undefined} */ let last;
    for (const c of typed) { last = A(a, c); if (last.status !== 0) break; }
    const adv = A(b, ['advance', 'LC']);
    return { typed: /** @type {import('../lib/harness.mjs').Result} */ (last), adv, a, b };
  }

  test('freeze refused (the QA plan is not bound to the plan): same status, same message, the run is not frozen', () => {
    const { typed, adv, a, b } = both((d) => appendFileSync(path.join(d, RUN, 'PLAN.md'), 'changed after the QA plan\n'), [['branch', 'LC'], ['baseline', 'LC'], ['freeze', 'LC']]);
    assert.notEqual(typed.status, 0);
    assert.equal(adv.status, typed.status);
    assert.ok(adv.text.includes(typed.err.trim()), `${adv.text}\n---\n${typed.text}`);
    assert.match(adv.out, /stopped, agent\.sh freeze failed; nothing after it ran/);
    assert.doesNotMatch(text(b, `${RUN}/RUN.yaml`), /plan_sha256: "[0-9a-f]{8}/);
    assert.deepEqual(events(b), events(a));
  });

  test('handoff IMPLEMENTING refused (a file outside the plan scope): same status, same message, the handoff stays PLANNED', () => {
    const { typed, adv, a, b } = both((d) => writeFileSync(path.join(d, 'stray-outside-scope.txt'), 'x\n'), [['freeze', 'LC'], ['freshness', 'LC'], ['handoff', 'LC', 'IMPLEMENTING']], [['branch', 'LC'], ['baseline', 'LC']]);
    assert.notEqual(typed.status, 0, typed.text);
    assert.equal(adv.status, typed.status);
    assert.ok(adv.text.includes(typed.err.trim()), `${adv.text}\n---\n${typed.text}`);
    assert.equal(runValue(b, 'handoff', 'state'), runValue(a, 'handoff', 'state'));
    assert.equal(runValue(b, 'handoff', 'state'), 'PLANNED');
    assert.deepEqual(events(b), events(a));
  });

  test('handoff IMPLEMENTED refused (the worker evidence is missing): same status, same message, the handoff stays IMPLEMENTING', () => {
    const base = fresh();
    must(base, ['classify', 'LC', 'STANDARD']); must(base, ['advance', 'LC']);
    implement(base);
    // the evidence of the work is taken away: the implementer's result stands, the evidence does not
    for (const n of readdirSync(path.join(base, RUN, 'worker-evidence'))) writeFileSync(path.join(base, RUN, 'worker-evidence', n), '');
    const a = copyOf(base); const b = copyOf(base);
    const typed = A(a, ['handoff', 'LC', 'IMPLEMENTED']);
    const adv = A(b, ['advance', 'LC']);
    assert.notEqual(typed.status, 0, typed.text);
    assert.equal(adv.status, typed.status);
    assert.ok(adv.text.includes(typed.err.trim()), `${adv.text}\n---\n${typed.text}`);
    assert.equal(runValue(b, 'handoff', 'state'), 'IMPLEMENTING');
    assert.deepEqual(events(b), events(a));
  });
});

describe('the role gate', () => {
  test('every role but the lead is refused, and nothing runs', () => {
    const dir = fresh();
    must(dir, ['classify', 'LC', 'STANDARD']);
    const before = events(dir);
    for (const role of ['task_author', 'explorer', 'architect', 'data_architect', 'designer', 'qa', 'implementer', 'reviewer', 'security_reviewer', 'verifier']) {
      const r = AS(dir, role, ['advance', 'LC']);
      assert.equal(r.status, 1, role);
      assert.match(r.text, /command denied for/, role);
    }
    assert.deepEqual(events(dir), before);
    assert.equal(runValue(dir, 'repository', 'task_branch'), 'PENDING');
  });

  test('a missing or unknown run id is a usage error or "run not found", not a step', () => {
    const dir = fresh();
    assert.notEqual(A(dir, ['advance']).status, 0);
    assert.match(A(dir, ['advance', 'NOPE']).text, /run not found/);
  });
});
