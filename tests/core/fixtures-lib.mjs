// @ts-check
// Fixture states shared by several Node test files, built ONCE per code state in process (stage / buildState, A289) and copied per test: a run driven to CODE_DONE, and a run whose
// REVIEW_SMALL-1 finding has the user's waiver approval recorded (the state in front of `waive`). The assertions of the files stay on the real launcher.
import { accepted, buildState, copyOf, gfail, gpass, implemented, must, say, scaffolded, stage } from './legacy-lib.mjs';
import { toCodeDone } from '../lib/harness.mjs';

/** A STANDARD autonomous orchestrated run driven to CODE_DONE (a copy). */
export function codeDoneRun() {
  const parent = scaffolded({ topology: 'orchestrated', cls: 'STANDARD', autonomy: 'autonomous' });
  return copyOf(stage(parent, 'orchestrated run at CODE_DONE', (d) => toCodeDone(d)));
}

/** An orchestrated run IMPLEMENTED with a failing REVIEW_SMALL finding, QA and VERIFY passed, and the user's approval of the waiver of REVIEW_SMALL-1 (a copy). */
export function waiveReadyRun() {
  const parent = scaffolded({ topology: 'orchestrated' });
  return copyOf(stage(parent, 'orchestrated run, waiver of REVIEW_SMALL-1 approved', (d) => {
    implemented(d);
    must(d, ['secret-scan', 'LC']); gfail(d, 'REVIEW_SMALL', 'impl.txt'); gpass(d, 'QA'); gpass(d, 'VERIFY');
    must(d, ['request-approval', 'LC', 'waive:REVIEW_SMALL-1']);
    say(d, 'I approve the waiver of REVIEW_SMALL-1.');
    accepted(must(d, ['approve', 'LC', 'waive:REVIEW_SMALL-1']), 'approve');
  }));
}
export { buildState };
