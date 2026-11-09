// @ts-check
// Merge guard tests (A136, port of tests/enforcement/merge-guard-test.sh, 176-C): `proofline merge <PR>` (bin/proofline) against a stubbed gh on PATH, and the
// real runtime hook's denial of every other merge path (a table of 200+ commands in merge-guard-commands.json, taken from the shell suite one for one).
// Everything runs in a throwaway directory; the fake gh lives in the checkout (a gh under a temporary folder is refused, A180).
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repo } from '../lib/harness.mjs';
import { git, initRepo, merge, pooled, preBashAsync, scratch, slurp, stubDir, toolsOnly, writeTool } from './platform-lib.mjs';

const base = scratch('proofline-merge-');
const stubd = stubDir('merge-guard');
const proj = path.join(base, 'proj');
const GHS = path.join(base, 'ghs');
mkdirSync(GHS, { recursive: true });
initRepo(proj);
const ghText = `#!/bin/sh
[ ! -f "${GHS}/fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }
case "$*" in
  *"pr merge"*) echo "$*" >> "${GHS}/merge.log"; exit 0 ;;
  *"pr checks"*) cat "${GHS}/required.json" 2>/dev/null || { echo "no required checks reported on the 'feat/x' branch" >&2; exit 1; } ;;
  *statusCheckRollup*) cat "${GHS}/view.json" ;;
  *headRefOid*) cat "${GHS}/head.json" ;;
esac
`;
writeTool(path.join(stubd, 'gh'), ghText);
const sha = '1'.repeat(40); const sha2 = '2'.repeat(40);
const PATHS = `${stubd}:${process.env.PATH}`;
/** @param {number | string} n @param {string} state @param {boolean} draft @param {string} head @param {string} rollup raw JSON text @param {string} [now] */
const view = (n, state, draft, head, rollup, now = head) => {
  writeFileSync(path.join(GHS, 'view.json'), `{"number":${n},"state":"${state}","isDraft":${draft},"headRefOid":"${head}","statusCheckRollup":${rollup}}\n`);
  writeFileSync(path.join(GHS, 'head.json'), `{"headRefOid":"${now}"}\n`);
};
const runOk = '{"__typename":"CheckRun","name":"static","status":"COMPLETED","conclusion":"SUCCESS"}';
const ctxOk = '{"__typename":"StatusContext","context":"ci/legacy","state":"SUCCESS"}';
const green = `[${runOk},${ctxOk}]`;
const reset = () => { for (const f of ['view.json', 'head.json', 'required.json', 'merge.log', 'fail']) rmSync(path.join(GHS, f), { force: true }); };
const mergeLog = () => slurp(path.join(GHS, 'merge.log'));
/** @param {string[]} args @param {string} [p] */
const doMerge = (args, p = PATHS) => merge(proj, args, p);
/** @param {string} name @param {string} frag @param {string[]} args */
function refused(name, frag, ...args) {
  const r = doMerge(args);
  assert.notEqual(r.status, 0, `${name}: merged`);
  assert.equal(mergeLog(), '', `${name}: the merge command ran`);
  assert.ok(r.text.includes(frag), `${name}: refused for another reason: ${r.text}`);
}
const cr = (/** @type {string} */ n, /** @type {string} */ st, /** @type {string} */ concl) => `{"__typename":"CheckRun","name":"${n}","status":"${st}","conclusion":${concl}}`;

test('the wrapper: all green merges, pinned to the checked head', () => {
  reset(); view(7, 'OPEN', false, sha, green);
  const r = doMerge(['7', '--squash', '--delete-branch']);
  assert.equal(r.status, 0, `green PR not merged: ${r.text}`);
  assert.ok(mergeLog().includes(`pr merge 7 --squash --match-head-commit ${sha} --delete-branch`), `merge command: ${mergeLog()}`);
});

test('the wrapper refuses red, pending, neutral, cancelled, missing checks, a moved head, a draft, a merged or other PR, a malformed head, unparsable output and a failing gh', () => {
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${cr('selftest', 'COMPLETED', '"FAILURE"')}]`);
  refused('red CI is refused', 'selftest: status COMPLETED, conclusion FAILURE', '7');
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${cr('selftest', 'IN_PROGRESS', 'null')}]`);
  refused('pending CI is refused', 'selftest: status IN_PROGRESS', '7');
  reset(); view(7, 'OPEN', false, sha, `[${runOk},{"__typename":"StatusContext","context":"ci/x","state":"PENDING"}]`);
  refused('a pending status context is refused', 'ci/x: state PENDING', '7');
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${cr('n', 'COMPLETED', '"NEUTRAL"')}]`);
  refused('neutral is refused', 'conclusion NEUTRAL', '7');
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${cr('n', 'COMPLETED', '"CANCELLED"')}]`);
  refused('cancelled is refused', 'conclusion CANCELLED', '7');
  reset(); view(7, 'OPEN', false, sha, '[]');
  refused('no checks at all is refused when the commit cannot be verified locally', 'has no checks and its head commit', '7');
  reset(); view(7, 'OPEN', false, sha, 'null');
  refused('a null rollup is refused when the commit cannot be verified locally', 'has no checks and its head commit', '7');
  reset(); view(7, 'OPEN', false, sha, green, sha2);
  refused('head moved after the check is refused', 'moved after the check', '7');
  reset(); view(7, 'OPEN', true, sha, green); refused('a draft is refused', 'is a draft', '7');
  reset(); view(7, 'MERGED', false, sha, green); refused('a merged PR is refused', 'is MERGED, not OPEN', '7');
  reset(); view(8, 'OPEN', false, sha, green); refused('another PR number in the answer is refused', 'did not return pull request 7', '7');
  reset(); view(7, 'OPEN', false, 'abc', green); refused('a malformed head is refused', 'not a 40-digit SHA', '7');
  reset(); writeFileSync(path.join(GHS, 'view.json'), 'not json'); refused('unparsable output is refused', 'not parseable', '7');
  reset(); writeFileSync(path.join(GHS, 'fail'), ''); refused('gh failing (offline) is refused with what it said', 'HTTP 502', '7');
  reset(); view(7, 'OPEN', false, sha, green);
  refused('--admin is refused', '--admin', '7', '--admin');
  refused('--auto is refused', '--auto', '7', '--auto');
  refused('a URL instead of a number is refused', 'plain number', 'https://github.com/o/r/pull/7');
});

test('skipped checks pass unless required; a required check missing from the rollup refuses; the wrapper prints the gh it uses', () => {
  const skip = cr('visual', 'COMPLETED', '"SKIPPED"');
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${skip}]`);
  let r = doMerge(['7']); assert.equal(r.status, 0, `skipped, nothing required: ${r.text}`);
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${skip}]`); writeFileSync(path.join(GHS, 'required.json'), '[{"name":"static","bucket":"pass"}]\n');
  r = doMerge(['7']); assert.equal(r.status, 0, `skipped, not in the required list: ${r.text}`);
  reset(); view(7, 'OPEN', false, sha, `[${runOk},${skip}]`); writeFileSync(path.join(GHS, 'required.json'), '[{"name":"static","bucket":"pass"},{"name":"visual","bucket":"skipping"}]\n');
  refused('a skipped required check is refused', 'visual (skipping)', '7');
  reset(); view(7, 'OPEN', false, sha, green); writeFileSync(path.join(GHS, 'required.json'), '[{"name":"static","bucket":"pass"},{"name":"selftest","bucket":"pass"}]\n');
  r = doMerge(['7']);
  assert.notEqual(r.status, 0); assert.equal(mergeLog(), ''); assert.ok(r.text.includes('missing from the rollup'), r.text);
  assert.ok(r.text.includes(`using gh at ${stubd}/gh`), `the wrapper does not print the gh it uses: ${r.text}`);
});

test('PATH shadowing: a gh in a temp directory and an empty PATH entry are refused; a missing gh is refused', () => {
  reset(); view(7, 'OPEN', false, sha, green);
  const tmpgh = path.join(base, 'tmpgh'); mkdirSync(tmpgh);
  writeTool(path.join(tmpgh, 'gh'), ghText);
  let r = doMerge(['7'], `${tmpgh}:${process.env.PATH}`);
  assert.notEqual(r.status, 0, 'merged with a gh from a temp directory');
  assert.ok(r.text.includes('possibly shadowed gh'), `temp-dir gh message: ${r.text}`); assert.equal(mergeLog(), '', 'gh ran');
  r = doMerge(['7'], `${stubd}::${process.env.PATH}`);
  assert.notEqual(r.status, 0, 'merged with an empty PATH entry');
  assert.ok(r.text.includes('empty or relative entry'), `empty PATH entry message: ${r.text}`);
  const nogh = path.join(base, 'nogh');
  toolsOnly(nogh, ['git', 'sed', 'awk', 'head', 'tr', 'dirname', 'cat', 'readlink', 'shasum', 'sha256sum', 'node']);
  r = doMerge(['7'], nogh);
  assert.notEqual(r.status, 0, 'merged without gh');
  assert.ok(r.text.includes('gh is not installed'), `gh missing message: ${r.text}`);
});

// --- the hook ------------------------------------------------------------------------------------
/** @type {Record<string, string[]>} */
const groups = JSON.parse(readFileSync(path.join(import.meta.dirname, 'merge-guard-commands.json'), 'utf8'));
const other = path.join(base, 'other');
/** @param {string} c */ const sub = (c) => c.split('<OTHER>').join(other);
git(proj, ['checkout', '-q', '-b', 'feat/x']);
initRepo(other);

/** Every command of a group through the real hook, in parallel. @param {string[]} cmds @param {boolean} deny */
async function check(cmds, deny) {
  /** @type {string[]} */ const bad = [];
  await pooled(cmds, 8, async (c0) => {
    const c = sub(c0);
    const out = await preBashAsync(proj, c);
    const isDeny = out.includes('"permissionDecision":"deny"');
    if (deny && !isDeny) bad.push(`not denied: ${c} -> ${out}`);
    else if (deny && !out.includes('proofline merge')) bad.push(`denial does not name the wrapper: ${c} -> ${out}`);
    else if (!deny && isDeny) bad.push(`denied: ${c} -> ${out}`);
  });
  assert.deepEqual(bad, []);
}
// The shell suite checked the branches in sequence on one repository; the hook reads HEAD per call, so the checkout moves between groups.
test('hook: direct merge paths, branch advances, clustered flags, chained checkouts and bypass spellings are denied; the wrapper and read-only commands stay allowed (feat/x checked out)', async () => {
  git(proj, ['checkout', '-q', 'feat/x']);
  const denyN = groups['feat/x:D'] ?? []; const allowN = groups['feat/x:A'] ?? [];
  assert.equal(denyN.length, 128); assert.equal(allowN.length, 59);
  await check(denyN, true);
  await check(allowN, false);
});
test('hook: a bare push, a push of HEAD and a merge are denied while the protected branch is checked out; an unstage and a pull from origin stay (A200)', async () => {
  git(proj, ['checkout', '-q', 'main']);
  try {
    assert.equal((groups['main:D'] ?? []).length, 13); assert.equal((groups['main:A'] ?? []).length, 4);
    await check(groups['main:D'] ?? [], true);
    await check(groups['main:A'] ?? [], false);
  } finally { git(proj, ['checkout', '-q', 'feat/x']); }
});
test('hook: the guard also runs in an installed project', async () => {
  git(proj, ['checkout', '-q', 'feat/x']);
  mkdirSync(path.join(proj, '.agents/scripts'), { recursive: true });
  writeFileSync(path.join(proj, '.agents/config.yaml'), ''); writeFileSync(path.join(proj, '.agents/scripts/agent.sh'), 'echo main\n');
  const scripts = path.join(repo, 'control-plane/agents/scripts');
  copyFileSync(path.join(scripts, 'proofline-core.mjs'), path.join(proj, '.agents/scripts/proofline-core.mjs'));
  cpSync(path.join(scripts, 'core'), path.join(proj, '.agents/scripts/core'), { recursive: true });
  await check(['gh pr merge 7 --admin', 'git push origin main'], true);
  await check(['proofline merge 7'], false);
});
