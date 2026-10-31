// @ts-check
// next, summary, plan-section, digest, report-facts, report-execution and report-tokens against the shell, on fixture runs built with the
// self-test helpers: the same stdout, stderr, exit status and, for `next`, the same files left behind, through the Node core and through the
// shell code (PROOFLINE_ENGINE=sh). The shell is the specification. Each state builds its own tree (tests run in parallel); the cases that
// take long (the plan mutations, the dispatch markers) are in c1-slow.test.mjs.
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { describe, test } from 'node:test';
import { build, exec, GATES_PARTIAL, STATES } from './states.mjs';

// every command of the package that depends on the state, per state; the argument-shape and error cases run on the first state only
const COMMANDS = [['next', 'LC'], ['next'], ['summary', 'LC'], ['summary'], ['summary', 'LC', '--status'], ['digest', 'LC'], ['report-facts', 'LC'], ['report-execution', 'LC'], ['report-tokens', 'LC'], ['plan-section', 'LC', 'scope']];
const SHAPES = [['next', 'NOPE'], ['summary', 'NOPE'], ['summary', '--status'], ['digest', 'NOPE'], ['digest'], ['report-facts'], ['report-facts', 'NOPE'], ['report-execution'], ['report-execution', 'NOPE'], ['report-tokens'], ['report-tokens', 'NOPE'],
  ['plan-section'], ['plan-section', 'LC'], ['plan-section', 'NOPE', 'scope'], ['plan-section', 'LC', 'Assumptions'], ['plan-section', 'LC', 'Architecture'], ['plan-section', 'LC', 'Nothing'], ['plan-section', 'LC', 'Data'],
  ['plan-section', 'LC', 'A.*'], ['next', 'LC', 'extra']];
let shapesDone = false;

/** @param {string} fx @param {string} label @param {string[][]} [extra] */
function allSame(fx, label, extra = []) {
  const list = shapesDone ? [...COMMANDS, ...extra] : [...SHAPES, ...COMMANDS, ...extra];
  shapesDone = true;
  for (const c of list) {
    const a = exec(fx, c, 'node'); const b = exec(fx, c, 'sh');
    assert.deepEqual(a, b, `${label}: agent.sh ${c.join(' ')}`);
  }
}

/** @type {Record<string, string>} */
const MORE = {
  'supervised, before the freeze': 'scaffold orchestrated no COMPLEX supervised',
  'code done, knowledge not recorded': 'scaffold orchestrated no COMPLEX; to_code_done orchestrated',
  'code done, report not published': 'scaffold orchestrated no COMPLEX; to_code_done orchestrated; A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null',
  done: 'scaffold orchestrated no COMPLEX; to_code_done orchestrated; finish_done',
  'standalone code done': 'scaffold standalone no STANDARD; to_code_done standalone',
};

describe('run commands equal the shell', () => {
  for (const [name, snippet] of Object.entries({ ...STATES, ...MORE })) {
    test(name, () => { const fx = build(snippet); allSame(fx, name); });
  }

  test('a failing gate: the findings, the fix paths and the fix round', () => {
    const fx = build(`${GATES_PARTIAL}\ngfail REVIEW_SMALL impl.txt 2>/dev/null || gfail REVIEW_RULES impl.txt 2>/dev/null || true`);
    allSame(fx, 'failing');
    const fx2 = build(`${GATES_PARTIAL}\nprintf 'more\\n' >> impl.txt; gfail REVIEW_SMALL impl.txt 2>/dev/null || gfail REVIEW_RULES impl.txt 2>/dev/null || true; printf 'more\\n' >> impl.txt; gfail REVIEW_SMALL impl.txt 2>/dev/null || gfail REVIEW_RULES impl.txt 2>/dev/null || true`);
    allSame(fx2, 'failing twice');
  });

  test('the same fixture twice: the cache the commands append to does not change the answers', () => {
    const fx = build('scaffold orchestrated no COMPLEX; mkdir -p src; i=0; while [ "$i" -lt 12 ]; do printf "line %s\\n" "$i" > "src/f$i.txt"; i=$((i+1)); done');
    for (let i = 0; i < 2; i++) {
      for (const c of [['next', 'LC'], ['summary', 'LC'], ['digest', 'LC']]) assert.deepEqual(exec(fx, c, 'node'), exec(fx, c, 'sh'), `round ${i}: ${c.join(' ')}`);
    }
  });

  test('roles: a reviewer and an unknown role', () => {
    const fx = build(GATES_PARTIAL);
    for (const env of [{ AGENT_ROLE: 'reviewer' }, { AGENT_ROLE: 'bogus' }, { AGENT_ROLE: 'implementer' }]) {
      for (const c of [['next', 'LC'], ['digest', 'LC'], ['report-facts', 'LC']]) assert.deepEqual(exec(fx, c, 'node', env), exec(fx, c, 'sh', env), `${c.join(' ')} as ${env.AGENT_ROLE}`);
    }
  });

  test('a copy of the tree answers the same (no state kept between runs)', () => {
    const fx = build(GATES_PARTIAL);
    const before = exec(fx, ['next', 'LC'], 'node');
    const dir = `${fx}-copy`;
    cpSync(fx, dir, { recursive: true });
    assert.deepEqual(exec(dir, ['next', 'LC'], 'node').out.replaceAll(dir, fx), before.out);
  });
});
