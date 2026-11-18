// @ts-check
// A329: the designer's allowed planning-stage write of a design document is attested by path and content hash, so handoff IMPLEMENTING opens the
// implementer window without a tree request; a modified file, another path, another role and a forged row still stop (tree-accept stays the way out).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
const hex = (/** @type {string} */ d, /** @type {string} */ f) => createHash('sha256').update(readFileSync(path.join(d, f))).digest('hex');
const forge = (/** @type {string} */ d, /** @type {string} */ rows) => { mkdirSync(path.join(d, EV), { recursive: true }); writeFileSync(path.join(d, EV, 'PLANNING-ATTEST.tsv'), rows); };
const attest = (/** @type {string} */ d) => A(d, ['window-close', 'LC', 'planning', '0', 'designer']);

test('positive: a planning write by the designer is attested; IMPLEMENTING opens the window and the run reaches IMPLEMENTED', () => {
  const d = fresh();
  write(d, DOC, '# Design\nthe lookup table\n');
  must(d, ['window-close', 'LC', 'planning', '0', 'designer']);
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
  write(d, DOC, '# Design\n'); must(d, ['window-close', 'LC', 'planning', '0', 'designer']);
  appendFileSync(path.join(d, DOC), 'sneaked in later\n');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'window opened over a design file changed after its attestation', 'not the last implementer-attested tree');
  assert.ok(!existsSync(path.join(d, EV, 'WINDOW-1.yaml')), 'a changed file attests nothing');
});

test('another path next to the attested design file still stops', () => {
  const d = fresh();
  write(d, DOC, '# Design\n'); must(d, ['window-close', 'LC', 'planning', '0', 'designer']);
  appendFileSync(path.join(d, 'impl.txt'), 'a product change made during planning\n');
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a product change rode along with the design file', 'not the last implementer-attested tree');
  refused(A(d, ['handoff', 'LC', 'IMPLEMENTED']), 'IMPLEMENTED over the foreign change', '');
});

test('a product file cannot be attested, and nothing is attested for a file the designer does not own', () => {
  const d = fresh();
  appendFileSync(path.join(d, 'impl.txt'), 'product\n');
  must(d, ['window-close', 'LC', 'planning', '0', 'designer']);   // nothing designer-owned changed: no attestation is written
  assert.ok(!existsSync(path.join(d, EV, 'PLANNING-ATTEST.tsv')));
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a product change was attested', 'not the last implementer-attested tree');
});

test('other roles, other arguments and other states cannot attest', () => {
  const d = fresh();
  write(d, DOC, '# Design\n');
  for (const role of ['implementer', 'designer', 'reviewer']) expectFail(AS(d, role, ['window-close', 'LC', 'planning', '0', 'designer']), `${role} attested`);
  expectFail(A(d, ['window-close', 'LC', 'planning', '0', 'implementer']), 'attested for the implementer');
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

test('forged rows with the CORRECT hash attest nothing: a product path, a designer-owned path outside the knowledge scope, and a designer path with no ledger row', () => {
  const d = fresh();
  appendFileSync(path.join(d, 'impl.txt'), 'product\n');
  forge(d, `impl.txt\t${hex(d, 'impl.txt')}\n`);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a product row with its right hash attested', 'not the last implementer-attested tree');
  assert.ok(!existsSync(path.join(d, EV, 'WINDOW-1.yaml')));
  // a designer-owned file outside the knowledge scope (DESIGN.md at the root; design_docs.design is docs/design/DESIGN.md): the real command attests nothing, a forged row nothing either
  const e = fresh();
  write(e, 'DESIGN.md', '# root design\n');
  must(e, ['window-close', 'LC', 'planning', '0', 'designer']);
  assert.ok(!existsSync(path.join(e, EV, 'PLANNING-ATTEST.tsv')), 'a file outside the knowledge scope was attested');
  forge(e, `DESIGN.md\t${hex(e, 'DESIGN.md')}\n`);
  refused(A(e, ['handoff', 'LC', 'IMPLEMENTING']), 'a path outside plan scope and knowledge scope passed', 'unexpected or unmapped task-introduced paths');   // the scope check already stops it
  assert.ok(!existsSync(path.join(e, EV, 'WINDOW-1.yaml')));
  // the designer path inside the scope, the right hash, but no `planning-attest` ledger row
  const f = fresh();
  write(f, DOC, '# Design\n');
  forge(f, `${DOC}\t${hex(f, DOC)}\n`);
  must(f, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(f, ['window-open', 'LC']), 'a hand-written file without a ledger row attested', 'not the last implementer-attested tree');
  assert.ok(!existsSync(path.join(f, EV, 'WINDOW-1.yaml')));
});

test('a real attestation edited afterwards (a row added) no longer matches its ledger row', () => {
  const d = fresh();
  write(d, DOC, '# Design\n'); must(d, ['window-close', 'LC', 'planning', '0', 'designer']);
  appendFileSync(path.join(d, EV, 'PLANNING-ATTEST.tsv'), `impl.txt\t${hex(d, 'impl.txt')}\n`);
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'an edited attestation file was accepted', 'not the last implementer-attested tree');
});

test('the attested file deleted afterwards stops; attesting twice overwrites the row and widens nothing', () => {
  const d = fresh();
  write(d, DOC, '# Design\n'); must(d, ['window-close', 'LC', 'planning', '0', 'designer']);
  rmSync(path.join(d, DOC));
  must(d, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(d, ['window-open', 'LC']), 'a deleted design file was accepted', 'not the last implementer-attested tree');
  const e = fresh();
  write(e, DOC, '# one\n'); must(e, ['window-close', 'LC', 'planning', '0', 'designer']);
  write(e, DOC, '# two\n'); must(e, ['window-close', 'LC', 'planning', '0', 'designer']);
  assert.equal(readFileSync(path.join(e, EV, 'PLANNING-ATTEST.tsv'), 'utf8'), `${DOC}\t${hex(e, DOC)}\n`, 'one row, the later content');
  appendFileSync(path.join(e, 'impl.txt'), 'product after the second attestation\n');
  must(e, ['window-close', 'LC', 'planning', '0', 'designer']);   // a product file widens nothing
  assert.equal(readFileSync(path.join(e, EV, 'PLANNING-ATTEST.tsv'), 'utf8').split('\n').filter(Boolean).length, 1);
  must(e, ['handoff', 'LC', 'IMPLEMENTING']);
  refused(A(e, ['window-open', 'LC']), 'the product file rode along', 'not the last implementer-attested tree');
});

test('pin (accepted limit, A329 / limits.md): a headless dispatch.sh designer is bracketed only while IMPLEMENTING, so a PLANNING dispatch has no attestation', () => {
  const src = readFileSync(path.join(import.meta.dirname, '../../control-plane/agents/scripts/core/dispatcher.mjs'), 'utf8');
  assert.match(src, /this\.writesCode = role === 'implementer' \|\| \(role === 'designer' && this\.handoffState\(\) === 'IMPLEMENTING'\)/);
  assert.doesNotMatch(src, /planning-attest/, 'if the dispatcher gains a PLANNING designer step, update the A329 accepted limit and this pin');
});
