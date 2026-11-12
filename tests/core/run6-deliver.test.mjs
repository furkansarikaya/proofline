// @ts-check
// Stage 6 (A215): deliver-plan, deliver-step and task-source-done in Node, as absolute tests written with the area. They replace the scenarios of
// deliver-test.sh (tests/legacy-port-map.tsv names each). The platform tool is a fake `gh` outside every temporary folder (run6-lib.mjs).
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A, CODE_DONE, DONE, TASKS_IN_TASKS, accepted, approveDelivery, commitDelivery, existsSync, fakeGh, fakeTool, g, gOk, hooks, path, pushed, readFileSync, refused, run, say, verbs, writeFileSync, joinPath, toolRoot } from './run6-lib.mjs';
import { fakeExe } from '../lib/winfake.mjs';
import { project } from './legacy-lib.mjs';

const head = (/** @type {string} */ d, rev = 'HEAD') => g(d, 'rev-parse', rev);
const S = (/** @type {string} */ d, /** @type {Record<string, string>} */ env, /** @type {string[]} */ ...a) => A(d, ['deliver-step', 'LC', ...a], { env });
const read = (/** @type {string} */ d, /** @type {string} */ f) => readFileSync(path.join(d, f), 'utf8');

test('deliver-plan: a CODE_DONE run whose knowledge step or report is open prints what is left (no summary, no question, exit 0)', () => {
  const d = project(CODE_DONE);
  hooks(d);
  const r = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan');
  assert.match(r.out, /not ready to summarize/);
  assert.ok(!existsSync(`${d}/.agents/local/deliver/LC`), 'a summary was written before the knowledge step');
});

test('the chain: one reply approves every step; merge only on a ready pull request; cleanup only after the merge (and the run is gone)', () => {
  const gh = fakeGh();
  const d = project(DONE);
  hooks(d);
  const plan = accepted(A(d, ['deliver-plan', 'LC']), 'deliver-plan').out;
  assert.match(plan, /^steps: commit push pr merge cleanup$/m);
  assert.match(plan, /approve delivery/);
  refused(S(d, gh.env, 'commit'), "a step before the user's reply", 'no unconsumed commit approval');
  approveDelivery(d, 'approve the commit');
  refused(S(d, gh.env, 'commit'), 'a reply that is not the delivery approval', 'no unconsumed commit approval');
  approveDelivery(d);
  for (const k of ['commit', 'push', 'pr', 'merge', 'cleanup']) assert.ok(readdirNames(d).some((n) => n.endsWith(`-${k}.yaml`) && !n.includes('request')), `no ${k} approval from the one reply`);
  refused(S(d, gh.env, 'push'), 'push before the commit', 'commit first');
  assert.match(accepted(S(d, gh.env, 'commit'), 'commit').out, /^run: git commit -F \.agents\/local\/deliver\/LC\/COMMIT_MSG$/m);
  commitDelivery(d);
  assert.match(accepted(S(d, gh.env, 'push'), 'push').out, /^run: git push -u origin proofline\/LC-lookup$/m);
  refused(S(d, gh.env, 'pr'), 'pr before the push', 'push first');
  pushed(d);
  const pr = accepted(S(d, gh.env, 'pr'), 'pr').out;
  assert.match(pr, /^run: gh pr create --base main --head proofline\/LC-lookup --title "feat: lookup \(LC\)"/m);
  assert.ok(!pr.includes('--draft'));
  const h = head(d);
  gh.says('MERGED', h);
  refused(S(d, gh.env, 'cleanup', '7'), 'cleanup before the merge step', 'merge step of this delivery did not run');
  gh.says('OPEN', `${h} proofline/LC-lookup release acme`);
  refused(S(d, gh.env, 'merge', '7'), 'a pull request into another base', "not this delivery's open");
  gh.says('OPEN', `${head(d, 'HEAD^')} proofline/LC-lookup main acme`);
  refused(S(d, gh.env, 'merge', '7'), 'a pull request at another head', "not this delivery's open");
  gh.says('OPEN', `${h} proofline/LC-lookup main forker`);
  refused(S(d, gh.env, 'merge', '7'), "a fork's pull request with the same head, branch and base", "not this delivery's open");
  // the tool must come from PATH outside the project, the working directory and the temporary folders (no environment value lifts that)
  const tmpBin = fakeBinUnderTmp();
  refused(S(d, { PATH: joinPath(tmpBin, process.env.PATH) }, 'merge', '7'), 'a gh in a temporary folder', 'may be shadowed');
  gh.says('OPEN', h);
  assert.match(accepted(S(d, gh.env, 'merge', '7'), 'merge').out, /^run: proofline merge 7$/m);
  refused(S(d, gh.env, 'cleanup', '7'), 'cleanup after a refused merge', "not this delivery's merged");
  assert.ok(existsSync(`${d}/.agents/runs/LC`), 'the run went after a failed merge');
  gh.says('MERGED', `${head(d, 'HEAD^')} proofline/LC-lookup main acme`);
  refused(S(d, gh.env, 'cleanup', '7'), 'cleanup on another merged pull request', "not this delivery's merged");
  gh.says('MERGED', h);
  refused(S(d, gh.env, 'cleanup', '8'), 'cleanup naming another pull request number', 'did not run for pull request 8');
  const done = accepted(S(d, gh.env, 'cleanup', '7'), 'cleanup');
  assert.match(done.out, /delivery of LC complete/);
  assert.ok(!existsSync(`${d}/.agents/runs/LC`) && !existsSync(`${d}/.agents/local/deliver/LC`), 'the run survived the delivery');
});

/** @param {string} d */
function readdirNames(d) { return existsSync(`${d}/.agents/runs/LC/approvals`) ? requireFs().readdirSync(`${d}/.agents/runs/LC/approvals`) : []; }
function requireFs() { return fsModule; }
import * as fsModule from 'node:fs';
import { tmpdir } from 'node:os';

/** A directory under the temporary folder holding a gh that would answer anything. */
function fakeBinUnderTmp() {
  const b = tempDir('shadow-gh-');
  if (process.platform === 'win32') {   // only a real .exe is found there at all (A252); the folder under the temporary folder is what makes it refused
    const script = path.join(b, 'gh.mjs');
    fsModule.writeFileSync(script, "process.stdout.write('OPEN false x x x x\\n');\n");
    fakeExe(toolRoot, b, 'gh', script);
    return b;
  }
  fsModule.writeFileSync(path.join(b, 'gh'), '#!/bin/sh\necho "OPEN false x x x x"\n');
  fsModule.chmodSync(path.join(b, 'gh'), 0o755);
  return b;
}
void [DONE, TASKS_IN_TASKS, commitDelivery, fakeTool, gOk, run, say, verbs, writeFileSync];
