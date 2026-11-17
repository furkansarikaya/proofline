// @ts-check
// A329: the designer's allowed planning-stage write of a design document is attested by path and content hash, so handoff IMPLEMENTING opens the
// implementer window without a tree request; a modified file, another path, another role and a forged row still stop (tree-accept stays the way out).
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { A, AS, expectFail, must, refused, scaffold, worker, wopen, wclose, wev } from '../lib/harness.mjs';

const DOC = 'docs/design/DESIGN.md';
const EV = '.agents/runs/LC/worker-evidence';

/** A run frozen at handoff PLANNED (the scaffold stops before IMPLEMENTING), DESIGN.md in the plan scope. */
function planned() {
  const d = scaffold({ topology: 'orchestrated', fresh: true, scopeNamed: DOC });
  copyFileSync(path.join(import.meta.dirname, '../../control-plane/agents/owns.conf'), path.join(d, '.agents/owns.conf'));   // the harness installs no owns.conf; production does
  must(d, ['classify', 'LC', 'COMPLEX']); must(d, ['baseline', 'LC']);
  appendFileSync(path.join(d, '.agents/runs/LC/EVIDENCE.md'), 'discovered\n'); appendFileSync(path.join(d, '.agents/runs/LC/PLAN.md'), 'planned\n');
  must(d, ['freeze', 'LC'], { bind: true });
  return d;
}
const fresh = () => planned();
const write = (/** @type {string} */ d, /** @type {string} */ f, /** @type {string} */ t) => { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); };
const attest = (/** @type {string} */ d) => A(d, ['planning-attest', 'LC', 'designer']);

test('positive: a planning write by the designer is attested; IMPLEMENTING opens the window and the run reaches IMPLEMENTED', () => {
  const d = fresh();
  write(d, DOC, '# Design\nthe lookup table\n');
  must(d, ['planning-attest', 'LC', 'designer']);
  assert.ok(existsSync(path.join(d, EV, 'PLANNING-ATTEST.tsv')));
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  const w = wopen(d);
  assert.ok(existsSync(path.join(d, EV, 'WINDOW-1.yaml')), 'the planning attestation is the first window');
  assert.match(readFileSync(path.join(d, EV, 'WINDOW-1.yaml'), 'utf8'), /role: "designer"/);
  appendFileSync(path.join(d, 'impl_test.txt'), 'test: lookup returns the stored value\n'); wev(d, 'RED', 'fail'); wclose(d, w);
  worker(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']);
  assert.match(A(d, ['tree-inspect', 'LC']).out, /nothing to accept/);
});

test('modified after the attestation: the file counts as an unrecorded change again', () => {
  const d = fresh();
  write(d, DOC, '# Design\n'); must(d, ['planning-attest', 'LC', 'designer']);
  appendFileSync(path.join(d, DOC), 'sneaked in later\n');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'window opened over a design file changed after its attestation', 'not the last implementer-attested tree');
  assert.ok(!existsSync(path.join(d, EV, 'WINDOW-1.yaml')), 'a changed file attests nothing');
});

test('another path next to the attested design file still stops', () => {
  const d = fresh();
  write(d, DOC, '# Design\n'); must(d, ['planning-attest', 'LC', 'designer']);
  appendFileSync(path.join(d, 'impl.txt'), 'a product change made during planning\n');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a product change rode along with the design file', 'not the last implementer-attested tree');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED over the foreign change', '');
});

test('a product file cannot be attested, and nothing is attested for a file the designer does not own', () => {
  const d = fresh();
  appendFileSync(path.join(d, 'impl.txt'), 'product\n');
  must(d, ['planning-attest', 'LC', 'designer']);   // nothing designer-owned changed: no attestation is written
  assert.ok(!existsSync(path.join(d, EV, 'PLANNING-ATTEST.tsv')));
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a product change was attested', 'not the last implementer-attested tree');
});

test('other roles, other arguments and other states cannot attest', () => {
  const d = fresh();
  write(d, DOC, '# Design\n');
  for (const role of ['implementer', 'designer', 'reviewer']) expectFail(AS(d, role, ['planning-attest', 'LC', 'designer']), `${role} attested`);
  expectFail(A(d, ['planning-attest', 'LC', 'implementer']), 'attested for the implementer');
  assert.ok(!existsSync(path.join(d, EV, 'PLANNING-ATTEST.tsv')));
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(attest(d), 'attested after IMPLEMENTING began', 'only while handoff state is PLANNED');
});

test('a forged attestation file (wrong hash, or a product path) attests nothing', () => {
  const d = fresh();
  write(d, DOC, '# Design\n'); appendFileSync(path.join(d, 'impl.txt'), 'product\n');
  mkdirSync(path.join(d, EV), { recursive: true });
  const h = A(d, ['patch-fingerprint', 'LC']).out.trim();
  writeFileSync(path.join(d, EV, 'PLANNING-ATTEST.tsv'), `${DOC}\t${'0'.repeat(64)}\n`);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a forged hash attested', 'not the last implementer-attested tree');
  assert.ok(!existsSync(path.join(d, EV, 'WINDOW-1.yaml')) && h !== '');
});

test('tree-accept stays the way out for a foreign change', () => {
  const d = fresh();
  appendFileSync(path.join(d, 'impl.txt'), 'foreign\n');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a foreign change opened a window', 'tree-accept');
});
