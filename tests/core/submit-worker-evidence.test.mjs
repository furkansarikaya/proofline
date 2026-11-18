// @ts-check
// A332: an implementer's DONE is accepted only with the worker evidence the IMPLEMENTED handoff will ask for; the handoff refusal and `next` name the recording command. The
// real control plane, orchestrated topology; nothing is mocked. The cause class: a lead's free-prose prompt sent RED/GREEN output to scratch/ and a tdd.json, the implementer's
// DONE was accepted, and only the lead's handoff refused it, without naming the command.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, accepted, expectMsg, scaffold } from '../lib/harness.mjs';
import { worker2 } from './gates-s4-lib.mjs';

const GL = 'test: lookup returns the stored value';
const IL = 'impl: lookup returns the stored value';
/** @param {string} d @param {string} [res] */
const sub = (d, res = 'DONE') => { mkdirSync(path.join(d, '.agents/runs/LC/reports'), { recursive: true }); writeFileSync(path.join(d, '.agents/runs/LC/reports/001-impl.md'), '# implementation\n\nthe change is in impl.txt\n'); return AS(d, 'implementer', ['submit', 'LC', '--result', res, '--confidence', 'high', '--artifact', 'reports/001-impl.md', ...(res === 'BLOCKED' ? ['--reason', 'the plan names a file that does not exist'] : [])]); };
const redGreen = (/** @type {string} */ d) => { worker2(d, 'RED', 'fail', 'impl_test.txt', GL); worker2(d, 'GREEN', 'pass', 'impl.txt', IL); };

test('an implementer DONE without worker evidence is rejected in its own turn, naming the recording command and what is not evidence', () => {
  const d = scaffold({});
  const r = sub(d);
  assert.notEqual(r.status, 0, 'DONE was accepted without worker evidence');
  const text = `${r.out}${r.err}`;
  assert.match(text, /submit rejected: DONE needs worker evidence first: no valid RED\+GREEN record for: impl\.txt impl_test\.txt/);
  assert.match(text, /agent\.sh worker-evidence LC RED fail/);
  assert.match(text, /target: impl\.txt,impl_test\.txt/);
  assert.match(text, /at least 20 characters/);
  assert.match(text, /GREEN pass/);
  assert.match(text, /worker-evidence\/RED-\*\.yaml and GREEN-\*\.yaml/);
  assert.match(text, /scratch\/ or a tdd\.json is not worker evidence, and validate-tdd\.mjs is not this check/);
});

test('other results are unchanged: BLOCKED needs no evidence', () => {
  const d = scaffold({});
  accepted(sub(d, 'BLOCKED'), 'BLOCKED without evidence');
});

test('with RED and GREEN recorded the DONE is accepted, next says record IMPLEMENTED, and the handoff goes through', () => {
  const d = scaffold({});
  redGreen(d);
  accepted(sub(d), 'DONE with evidence');
  assert.match(A(d, ['next', 'LC']).out, /^next=agent\.sh handoff LC IMPLEMENTED$/m);
  accepted(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED');
});

test('a TDD-exempt run is accepted without evidence (the exemption is honoured as the handoff honours it)', () => {
  const d = scaffold({ exempt: true });
  accepted(sub(d), 'DONE of an exempt run');
});

test('the handoff refusal names the command and the folder; next re-dispatches when the DONE row has no evidence behind it', () => {
  const d = scaffold({});
  redGreen(d);
  accepted(sub(d), 'DONE with evidence');
  const ev = path.join(d, '.agents/runs/LC/worker-evidence');
  for (const n of readdirSync(ev)) if (/^(RED|GREEN)-/.test(n)) rmSync(path.join(ev, n));
  const n = A(d, ['next', 'LC']);
  assert.match(n.out, /^next=dispatch\.sh LC implementer$/m, n.out);
  assert.match(n.out, /reason=DONE recorded without worker-evidence RED\/GREEN for impl\.txt impl_test\.txt: re-dispatch and tell it to record them with agent\.sh worker-evidence/, n.out);
  assert.doesNotMatch(n.out, /record IMPLEMENTED now/);
  expectMsg('the handoff without evidence', 'To fix: record it with: printf', A(d, ['handoff', 'LC', 'IMPLEMENTED']));
  expectMsg('the handoff without evidence (folder)', 'worker-evidence/RED-*.yaml and GREEN-*.yaml', A(d, ['handoff', 'LC', 'IMPLEMENTED']));
  expectMsg('the handoff without evidence (validate-tdd)', 'validate-tdd.mjs is not this check', A(d, ['handoff', 'LC', 'IMPLEMENTED']));
});

test('a literal follower of the printed command shape is not rejected: the RED and the GREEN it describes are recorded, and the DONE is then accepted', () => {
  const d = scaffold({});
  const text = `${sub(d).err}${sub(d).out}`;
  const fmt = /printf '([^']*)'/.exec(text)?.[1] ?? '';
  assert.ok(fmt.includes('\\n'), text);
  // fill the placeholders exactly as the hint tells (the target line is already the missing paths, comma-separated)
  const form = (/** @type {boolean} */ red) => fmt.split('\\n').filter((l) => l !== '' && (red || !l.startsWith('expected_failure:')))
    .map((l) => l.replace('<the test command>', 'node --test tests/lookup.test.mjs').replace(/<what fails[^>]*>/, 'lookup returns undefined instead of the stored value')).join('\n') + '\n';
  assert.doesNotMatch(form(true), /[<>]/);
  accepted(A(d, ['worker-evidence', 'LC', 'RED', 'fail'], { role: 'implementer', input: form(true) }), 'RED in the printed shape');
  appendFileSync(path.join(d, 'impl.txt'), `${IL}\n`);
  accepted(A(d, ['worker-evidence', 'LC', 'GREEN', 'pass'], { role: 'implementer', input: form(false) }), 'GREEN in the printed shape');
  accepted(sub(d), 'DONE after the printed commands');
});
