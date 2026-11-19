// @ts-check
// Fixtures of tests/core/verifyclaims.test.mjs: two UI runs at CODE_DONE with the knowledge step done, built once and copied per test.
import { A, copyOf, gfail, gpass, must, rec, scaffold, solo, writeReport } from '../lib/harness.mjs';
import { frozen, implement, rrun } from './risk-s2-lib.mjs';
import { passAllExtra } from './gates-s4-lib.mjs';

const UI = '\n## UI\n\none status badge\nvisual_writes: DB_PATH=:memory:';
const OTHER = ['REVIEW_PLAN', 'REVIEW_RULES', 'REVIEW_TESTS', 'SECURITY'];

/** Every gate but the visual focus and VERIFY, recorded on the current tree. @param {string} d */
function passOthers(d) {
  must(d, ['secret-scan', 'LC']);
  for (const g of [...OTHER, 'QA']) gpass(d, g);
}

/** A UI run in which the visual focus passed on the tree that was handed over. @param {boolean} later a fix round after the visual pass, then every other gate again */
function build(later) {
  const d = rrun('COMPLEX', 'web/index.html', UI);
  frozen(d); implement(d, 'web/index.html', '<main></main>');
  passOthers(d);
  rec(d, 'QA', 'PASS', [], { focus: 'visual' });
  if (later) {
    // a fix round: a review fails on this tree, the implementer changes a file the visual focus does not watch, and every other gate runs again
    gfail(d, 'REVIEW_RULES', 'impl.txt');
    must(d, ['handoff', 'LC', 'IMPLEMENTING']);
    solo(d, 'FIX', 'pass', 'impl.txt', 'impl: fix after the review');
    must(d, ['handoff', 'LC', 'IMPLEMENTED']);
    passOthers(d);
  }
  gpass(d, 'VERIFY');
  must(d, ['handoff', 'LC', 'CODE_DONE']);
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  return d;
}

/** A run with no UI part, so no visual gate, at CODE_DONE with the knowledge step done. */
function buildPlain() {
  const d = scaffold({ topology: 'standalone' });
  solo(d, 'RED', 'fail', 'impl_test.txt', 'test: lookup returns the stored value'); solo(d, 'GREEN', 'pass', 'impl.txt', 'impl: lookup returns the stored value');
  must(d, ['handoff', 'LC', 'IMPLEMENTED']); passAllExtra(d, '## Human checks\n\n- Open the settings page in a browser and confirm the badge colour'); must(d, ['handoff', 'LC', 'CODE_DONE']);
  must(d, ['knowledge-done', 'LC', 'not_applicable', 'nothing durable changed in this synthetic test run']);
  return d;
}

/** The earlier-tree run with its report published once (the verify tests only read and edit it). */
function buildPublished(earlier) {
  const d = copyOf(earlier);
  writeReport(d);
  must(d, ['publish-completion-report', 'LC', 'markdown']);
  void A;
  return d;
}

/** @returns {{ visualFinal: () => string, visualEarlier: () => string, plain: () => string, earlierPublished: () => string }} */
export function apparatus() {
  const final = build(false); const earlier = build(true); const plain = buildPlain(); const published = buildPublished(earlier);
  return { visualFinal: () => copyOf(final), visualEarlier: () => copyOf(earlier), plain: () => copyOf(plain), earlierPublished: () => copyOf(published) };
}
