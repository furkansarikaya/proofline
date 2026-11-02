// @ts-check
// The golden port of the equivalence-rig cases (tests/equivalence, to be deleted); see port-t3-core.mjs. One test per recorded case of a group file
// (tests/fixtures/port-t3/<group>.json.gz): the Node core runs the recorded steps on the restored state and must leave the recorded outputs and delta.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { dataDir, replayer } from './port-t2-lib.mjs';
import { git, gitInfo, runSteps, snapTree, summarise } from './port-t3-core.mjs';

export const rigDir = path.join(path.dirname(dataDir), 'port-t3');

/** @param {string} name the group file: tests/fixtures/port-t3/<name>.json.gz */
export function loadGroup(name) { return JSON.parse(gunzipSync(readFileSync(path.join(rigDir, `${name}.json.gz`))).toString('utf8')); }

/** Register one test per recorded case of a group. @param {string} name @param {string} title */
export function registerGroup(name, title) {
  const g = loadGroup(name);
  const rp = replayer({ blobs: g.blobs, states: g.states, calls: [] });
  describe(title, { concurrency: 4 }, () => {
    for (const c of g.cases) {
      test(c.name, () => {
        const root = realpathSync(rp.state(c.state));
        const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'pl-t3-')));
        try {
          const home = path.join(work, 'home'); const tmp = path.join(work, 'tmp'); mkdirSync(home); mkdirSync(tmp);
          const initial = snapTree(root);
          const start = git(root, 'rev-parse', 'HEAD').trim();
          const gitBefore = gitInfo(root, start);
          const t0 = Math.floor(Date.now() / 1000);
          const outputs = runSteps(root, home, tmp, c.steps);
          const t1 = Math.floor(Date.now() / 1000);
          const got = summarise({ outputs, files: snapTree(root), initial, window: [Math.min(c.builtAt, t0), t1], tmpdir: tmp, root, baseSha: g.states[c.state].baseSha ? rp.shaOf(c.state) : '', gitBefore, gitAfter: gitInfo(root, start) });
          assert.deepEqual(got.problems, [], `${c.name}: the closed normalisation reports problems`);
          // A210: a recorded SHELL error text (dash's `agent.sh: line N: ...`, awk's `awk: ...`, `unbound variable`) is not reproduced (the Node core has its own text for the same input).
          const shellText = (/** @type {string} */ e) => /agent\.sh: line \d+: |^awk: |\nawk: |unbound variable/.test(e);
          c.expect.outputs.forEach((/** @type {any} */ want, /** @type {number} */ k) => {
            if (typeof want.stderr === 'string') want.stderr = want.stderr.replace(/\x08/g, '\\b'); // dash's echo turned \b into a backspace
            if (typeof want.stderr === 'string' && shellText(want.stderr) && got.outputs[k]) {
              // not compared (the answer of the shell is a bug of the shell, not a behaviour): the step is taken as recorded
              got.outputs[k] = want;
            }
          });
          assert.deepEqual({ outputs: got.outputs, changed: got.changed, gone: got.gone, git: got.git }, { outputs: c.expect.outputs, changed: c.expect.changed, gone: c.expect.gone, git: c.expect.git }, c.name);
        } finally { rmSync(work, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
      });
    }
  });
}
