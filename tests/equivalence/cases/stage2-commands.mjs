// @ts-check
// Scenario cases of the 41 commands that move to Node in stage 2 (issue #167, Command map). The table below attaches every case to ONE command;
// a case is a fixture state (stage2-fixtures.mjs) plus the calls of that command, and the rig (tests/equivalence/rig.mjs) runs it on both engines.
// Cases of a command that has not moved yet run the shell against the shell and pass trivially; they become the equivalence proof when the command
// is added to the Node HANDLERS. scope.mjs picks a case up through its command (steps[].args[0]): a pull request replays the cases of the touched
// commands, the nightly EQUIVALENCE_FULL run replays all of them.
import { BLOCK_STATES, EXTRA_STATES, RUN_STATES, SCALE_STATES, stateFixture } from './stage2-fixtures.mjs';

/** @typedef {import('../rig.mjs').Case} Case */
/** @typedef {import('../rig.mjs').Step} Step */

export const STAGE2 = Object.freeze(['status', 'open-runs', 'effective', 'fingerprint', 'pipeline', 'next', 'summary', 'plan-section', 'digest', 'debt', 'design-surface',
  'report-facts', 'report-execution', 'repro-normalize', 'design-rationales', 'report-tokens', 'verify-freeze', 'verify-scope', 'verify-knowledge-scope', 'freshness',
  'verify-handoff', 'entry-tier', 'verify-qa-plan', 'verify-worker-evidence', 'questions', 'batch-check', 'commands-check', 'scale-check', 'test-path',
  'task-scope-entries', 'scope-covers', 'task-type', 'human-checks', 'scope-kinds', 'path-kind', 'patch-fingerprint', 'verify-gates', 'verify-seal', 'ci-check',
  'ci-task-command', 'validate']);

const ID = 'LC';
/** Every gate state of gates-test and risk-test, then the gate states that most commands also read, then the performance commands' scaling fixture. */
const ALL = RUN_STATES.filter((s) => !s.startsWith('scale-'));
const CORE = ['gates-frozen', 'gates-implemented', 'gates-failed', 'gates-allpass', 'gates-stale', 'gates-done', 'risk-open', 'risk-passed'];
const A = (/** @type {string[]} */ args, /** @type {Partial<Step>} */ o = {}) => /** @type {Step} */ ({ args, ...o });

/**
 * @typedef {{ cmd: string, states: string[], calls: Step[] }} Row
 * One row: the command, the fixture states it is checked on, the calls made on each (every call starts with the command, so a case is attached to it).
 */
/** @type {Row[]} */
export const ROWS = [
  // the commands that read a run: gate-sensitive ones on every state
  { cmd: 'effective', states: [...ALL, ...SCALE_STATES], calls: [A(['effective', ID]), A(['effective', ID], { role: 'reviewer' })] },
  { cmd: 'fingerprint', states: [...ALL, ...SCALE_STATES, ...BLOCK_STATES], calls: [A(['fingerprint', ID]), A(['fingerprint', ID, 'full']), A(['fingerprint'])] },
  { cmd: 'pipeline', states: [...ALL, ...SCALE_STATES, ...BLOCK_STATES], calls: [A(['pipeline', ID]), A(['pipeline', ID], { role: 'qa' }), A(['pipeline'])] },
  { cmd: 'next', states: [...ALL, ...SCALE_STATES], calls: [A(['next', ID]), A(['next']), A(['next', ID], { role: 'implementer' })] },
  { cmd: 'summary', states: [...ALL, ...SCALE_STATES], calls: [A(['summary', ID]), A(['summary', ID, '--status']), A(['summary']), A(['summary', 'NOPE'])] },
  { cmd: 'digest', states: [...ALL, ...SCALE_STATES], calls: [A(['digest', ID]), A(['digest'])] },
  { cmd: 'verify-gates', states: [...ALL, ...SCALE_STATES], calls: [A(['verify-gates', ID]), A(['verify-gates'])] },
  { cmd: 'verify-seal', states: ALL, calls: [A(['verify-seal', ID]), A(['verify-seal'])] },
  { cmd: 'verify-handoff', states: ALL, calls: [A(['verify-handoff', ID]), A(['verify-handoff'])] },
  { cmd: 'validate', states: [...ALL, ...SCALE_STATES], calls: [A(['validate', ID]), A(['validate'])] },
  { cmd: 'verify-scope', states: [...ALL, ...SCALE_STATES], calls: [A(['verify-scope', ID]), A(['verify-scope'])] },
  { cmd: 'freshness', states: ALL, calls: [A(['freshness', ID]), A(['freshness'])] },
  { cmd: 'verify-freeze', states: CORE, calls: [A(['verify-freeze', ID]), A(['verify-freeze'])] },
  { cmd: 'verify-knowledge-scope', states: CORE, calls: [A(['verify-knowledge-scope', ID]), A(['verify-knowledge-scope'])] },
  { cmd: 'verify-qa-plan', states: CORE, calls: [A(['verify-qa-plan', ID]), A(['verify-qa-plan', 'NOPE'])] },
  { cmd: 'verify-worker-evidence', states: CORE, calls: [A(['verify-worker-evidence', ID]), A(['verify-worker-evidence'])] },
  { cmd: 'patch-fingerprint', states: [...CORE, ...BLOCK_STATES], calls: [A(['patch-fingerprint', ID]), A(['patch-fingerprint', 'NOPE'])] },
  { cmd: 'plan-section', states: CORE, calls: [A(['plan-section', ID, 'Architecture']), A(['plan-section', ID, 'Assumptions']), A(['plan-section', ID, 'Data']), A(['plan-section', ID, 'Arch.*']), A(['plan-section', ID, '[Aa]rchitecture']), A(['plan-section', ID, 'Architecture|Data']), A(['plan-section', ID, '^Arch']), A(['plan-section', ID, '[abc']), A(['plan-section', ID, 'a\\b']), A(['plan-section', ID, '*']), A(['plan-section', ID, '']), A(['plan-section', ID]), A(['plan-section'])] },
  { cmd: 'report-facts', states: CORE, calls: [A(['report-facts', ID]), A(['report-facts'])] },
  { cmd: 'report-execution', states: CORE, calls: [A(['report-execution', ID]), A(['report-execution'])] },
  { cmd: 'report-tokens', states: CORE, calls: [A(['report-tokens', ID]), A(['report-tokens'])] },
  { cmd: 'design-rationales', states: CORE, calls: [A(['design-rationales', ID]), A(['design-rationales', ID, '--json']), A(['design-rationales', '-']), A(['design-rationales'])] },
  { cmd: 'questions', states: CORE, calls: [A(['questions', ID]), A(['questions'])] },
  { cmd: 'human-checks', states: CORE, calls: [A(['human-checks', ID]), A(['human-checks'])] },
  { cmd: 'scope-kinds', states: CORE, calls: [A(['scope-kinds', ID]), A(['scope-kinds'])] },
  // the commands that read the project or the active run
  { cmd: 'status', states: ['empty', ...ALL], calls: [A(['status']), A(['status'], { role: 'verifier' })] },
  { cmd: 'open-runs', states: ['empty', ...ALL], calls: [A(['open-runs'])] },
  { cmd: 'debt', states: ['empty', 'gates-frozen', 'gates-done'], calls: [A(['debt']), A(['debt', 'list']), A(['debt', 'page']), A(['debt', 'page'], { role: 'reviewer' }), A(['debt', 'bogus'])] },
  { cmd: 'batch-check', states: ['empty', 'gates-frozen'], calls: [A(['batch-check'])] },
  { cmd: 'commands-check', states: ['empty', 'gates-frozen'], calls: [A(['commands-check'])] },
  { cmd: 'scale-check', states: ['empty', 'gates-frozen'], calls: [A(['scale-check'])] },
  { cmd: 'ci-check', states: ['empty', 'gates-frozen'], calls: [A(['ci-check']), { write: { path: '.gitlab-ci.yml', content: 'stages: [test]\n' } }, A(['ci-check'])] },
  { cmd: 'ci-task-command', states: ['empty', 'gates-frozen'], calls: [A(['ci-task-command'])] },
  // pure functions of their arguments (and of config.yaml)
  { cmd: 'design-surface', states: ['empty'], calls: ['src/a.txt', 'src/ui/Button.tsx', 'docs/guide.md', 'api/openapi.yaml', 'migrations/001.sql', 'README.md', '.agents/config.yaml', '', 'a/../b'].map((p) => A(['design-surface', p])).concat([A(['design-surface'])]) },
  { cmd: 'repro-normalize', states: ['empty'], calls: [
    A(['repro-normalize'], { stdin: '2026-01-02T03:04:05Z built in 12.5s\n12:34:56.789 took 3 ms\n[build] Complete! in 4s\nRan 5 tests (0.3s)\nplain line\n' }),
    A(['repro-normalize'], { stdin: '' }), A(['repro-normalize'], { stdin: 'no trailing newline 2026-01-02 03:04:05' }), A(['repro-normalize', 'x'], { stdin: '10:00:00 Elapsed: 5 sec\n' })] },
  { cmd: 'entry-tier', states: ['empty'], calls: ['`POST /orders` accepts a customer id', 'a contract bullet', 'GET /health returns 200', '`createOrder(items)` takes a list and returns an id', 'the service exposes a new CLI flag --dry', 'a private helper', 'removed the old endpoint /v1/x', '']
    .map((t) => A(['entry-tier', t])).concat([A(['entry-tier'])]) },
  { cmd: 'test-path', states: ['empty'], calls: [A(['test-path', 'src/a_test.go', 'src/a.go', 'tests/x.js', 'a.test.ts', 'src/__tests__/b.js', 'spec/c_spec.rb', 'src/Test/D.cs', 'impl_test.txt', 'testdata/f.json', 'docs/test.md']), A(['test-path', 'src/a.go']), A(['test-path'])] },
  { cmd: 'path-kind', states: ['empty'], calls: [A(['path-kind', 'src/a.txt', 'docs/b.md', 'migrations/1.sql', 'Dockerfile', '.github/workflows/ci.yml', 'package.json', 'src/ui/x.tsx', 'config/app.yaml', 'a_test.go']), A(['path-kind'])] },
  { cmd: 'scope-covers', states: ['empty'], calls: [['src/', 'src/a.txt'], ['src', 'src/a.txt'], ['src/a.txt', 'src/a.txt'], ['src/*.txt', 'src/a.txt'], ['src/**', 'src/x/y/z.txt'], ['docs/', 'src/a.txt'], ['', 'a'], ['a', ''], ['.', 'a/b']].map((p) => A(['scope-covers', ...p])).concat([A(['scope-covers', 'only-one'])]) },
  { cmd: 'task-scope-entries', states: ['gates-frozen'], calls: [
    { write: { path: 'tasks/scoped.md', content: '# Task: S\n\n## Scope\n\n- src/a.txt\n- `src/b.txt`: reason\n- docs/\n\n## Other\n\n- not/this\n' } },
    A(['task-scope-entries', 'tasks/scoped.md', 'Scope']), A(['task-scope-entries', 'tasks/scoped.md', 'Other']), A(['task-scope-entries', 'tasks/scoped.md', 'Missing']), A(['task-scope-entries', 'tasks/LC.md', 'Scope']),
    A(['task-scope-entries', 'tasks/none.md', 'Scope']), A(['task-scope-entries', 'tasks/scoped.md'])] },
  { cmd: 'task-type', states: ['gates-frozen'], calls: [
    A(['task-type', `.agents/runs/${ID}/TASK.md`]), { write: { path: 'tasks/typed.md', content: '# Task: T\n\n---\ntype: bugfix\n---\n\nbody\n' } }, A(['task-type', 'tasks/typed.md']),
    { write: { path: 'tasks/typed2.md', content: '# Task: T\n\n---\ntype: weird\n---\n' } }, A(['task-type', 'tasks/typed2.md']), A(['task-type', 'tasks/none.md']), A(['task-type'])] },
];

// the waiver, known-issue, batch, approval, SECRETS/SECURITY, pass_low, pull-request and design-sync states are read by every command that reads a run
for (const r of ROWS) if (r.states.includes('gates-frozen') || r.states.includes('gates-implemented')) r.states = [...r.states, ...EXTRA_STATES.filter((x) => !r.states.includes(x))];
ROWS.find((r) => r.cmd === 'ci-check')?.states.push('gates-pr-open');

/** A marker of a dispatch in flight (the pid is the test process, alive while the case runs; the start is 3000 s before the call, so the elapsed minutes do not move). */
const marker = (/** @type {string} */ role) => /** @type {Step} */ ({ exec: ['sh', '-c', `printf 'pid=%s\\nrole=%s\\ntimeout=3600\\nstarted_epoch=%s\\n' "$PPID" '${role}' "$(( $(date +%s) - 3000 ))" > .agents/runs/LC/dispatch/001-x.running`] });
/** The platform tool gh as a PATH stub beside the project (the rig's own PATH mechanism: no environment variable of the product is set). */
const ghStub = /** @type {Step} */ ({ write: { path: 'stubbin/gh', content: '#!/bin/sh\necho "OPEN false 0000000000000000000000000000000000000000 proofline/LC-lookup main acme"\n', mode: 0o755 } });
const withGh = (/** @type {string[]} */ args) => A(args, { env: { PATH: `stubbin:${process.env.PATH ?? ''}` } });

/** Cases that need steps of their own on one state: a dispatch marker with an empty role or blanks (the shell fallback of budget_note), a pull request open on a DONE run. */
export const ONE_OFF = /** @type {{ cmd: string, state: string, label: string, calls: Step[] }[]} */ ([
  ...['next', 'summary', 'digest', 'pipeline'].map((cmd) => ({ cmd, state: 'gates-dispatch', label: 'markers', calls: [
    marker('implementer'), A([cmd, ID]), marker(''), A([cmd, ID]), marker('two words'), A([cmd, ID]), marker('tab\there'), A([cmd, ID]), { exec: ['rm', '-f', '.agents/runs/LC/dispatch/001-x.running'] }, A([cmd, ID])] })),
  ...['next', 'summary', 'report-facts', 'digest', 'status'].map((cmd) => ({ cmd, state: 'gates-pr-open', label: 'gh stub', calls: [ghStub, withGh(cmd === 'status' ? [cmd] : [cmd, ID]), A(cmd === 'status' ? [cmd] : [cmd, ID])] })),
]);

/** The states split over test files (node --test runs the files in parallel; building a state takes seconds, so a state belongs to one file). */
export const BUCKETS = /** @type {string[][]} */ ([
  ['empty', 'gates-frozen', 'gates-implemented', 'gates-partial', 'gates-standalone', 'intake-unclassified', 'intake-classified', 'intake-branched', 'intake-planned', 'gates-secrets-fail', 'gates-security-fail', 'gates-pass-low'],
  ['gates-failed', 'gates-full', 'gates-allpass', 'gates-stale', 'gates-codedone', 'gates-waived', 'gates-pending-waive', 'gates-pending-plan'],
  ['gates-waived-key', 'gates-waive-nomatch', 'gates-known-issue', 'gates-known-issue-unlisted', 'gates-batch-accept', 'gates-batch-decline', 'gates-drift'],
  ['gates-done', 'gates-pr-open', 'gates-dispatch', 'risk-unfrozen', 'risk-open', 'risk-passed', 'scale-0', 'scale-20', 'scale-60'],
]);

/** The cases: one per (command, state), named `<command>: <state>` so that a failure names both. The fixture is built when a case first runs. @returns {Case[]} */
export function stage2Cases(/** @type {string[]|undefined} */ onlyStates = undefined) {
  /** @type {Case[]} */ const out = [];
  for (const r of ROWS) for (const s of r.states) {
    if (onlyStates && !onlyStates.includes(s)) continue;
    out.push({ name: `${r.cmd}: ${s}`, get fixture() { return stateFixture(s); }, steps: r.calls });
  }
  for (const o of ONE_OFF) {
    if (onlyStates && !onlyStates.includes(o.state)) continue;
    out.push({ name: `${o.cmd}: ${o.state} (${o.label})`, get fixture() { return stateFixture(o.state); }, steps: o.calls });
  }
  return out;
}
