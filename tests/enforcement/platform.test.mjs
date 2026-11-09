// @ts-check
// Platform-independent delivery (A180, port of tests/enforcement/platform-test.sh, 176-C): the remote decides the platform (GitHub, GitLab, Azure DevOps,
// Bitbucket, other); `proofline merge` (bin/proofline) merges through gh, glab or az (fake binaries) with the same strictness, and on Bitbucket, an
// unrecognized host or a missing tool it merges nothing and says the user merges. A pull request without checks is merged only after the project's build and
// test pass in a clean copy of the commit ("verified locally, no CI"). The real hook keeps the single merge path for glab and az.
// The fake tools live in the checkout (a tool that resolves under a temporary folder is refused, A180); their state folder is baked into the script (A215).
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { repo } from '../lib/harness.mjs';
import { git, merge, pfc, pooled, preBashAsync, scratch, slurp, stubDir, toolsOnly, writeTool } from './platform-lib.mjs';

const base = scratch('proofline-platform-');
const stubd = stubDir('platform');
const PATHS = `${stubd}:${process.env.PATH}`;

// --- detection ---------------------------------------------------------------------------------------
const empty = path.join(base, 'empty'); mkdirSync(empty);
for (const t of ['glab', 'az']) writeTool(path.join(stubd, t), '#!/bin/sh\nexit 0\n');
/** @param {string} field @param {string} url */
const det = (field, url) => pfc(['field', field, '--url', url], { PATH: PATHS });

test('GitHub, GitLab, Azure DevOps, Bitbucket and other remotes are recognized; a missing tool or Bitbucket means the manual rule', () => {
  /** @type {Array<[string, string, string]>} */
  const want = [
    ['platform', 'git@github.com:acme/app.git', 'github'], ['platform', 'https://github.com/acme/app', 'github'], ['platform', 'https://gitlab.com/acme/sub/app.git', 'gitlab'],
    ['platform', 'git@gitlab.example.org:acme/app.git', 'other'], ['platform', 'https://acme@dev.azure.com/acme/Proj/_git/app', 'azure'],
    ['platform', 'git@ssh.dev.azure.com:v3/acme/Proj/app', 'azure'], ['platform', 'https://acme.visualstudio.com/DefaultCollection/Proj/_git/app', 'azure'],
    ['platform', 'git@bitbucket.org:acme/app.git', 'bitbucket'], ['platform', 'ssh://git@git.example.com:2222/acme/app.git', 'other'], ['platform', '/srv/git/app.git', 'other'],
    ['cli', 'https://gitlab.com/acme/app.git', 'glab'], ['cli', 'https://dev.azure.com/acme/Proj/_git/app', 'az'], ['cli', 'https://bitbucket.org/acme/app', 'none'],
    ['merge', 'https://bitbucket.org/acme/app', 'manual'], ['merge', 'https://gitlab.com/acme/app', 'cli'], ['owner', 'https://dev.azure.com/acme/Proj/_git/app', 'acme'],
  ];
  for (const [f, u, w] of want) assert.equal(det(f, u), w, `${f} of ${u}`);
  assert.equal(pfc(['field', 'cli', '--url', 'https://gitlab.com/acme/app'], { PATH: empty }), 'none', 'glab missing must give cli none');
  assert.equal(pfc(['field', 'merge', '--url', 'https://gitlab.com/acme/app'], { PATH: empty }), 'manual', 'a missing tool must give the manual rule');
  assert.ok(pfc(['link', 'feat/x', 'main', '--url', 'https://dev.azure.com/acme/Proj/_git/app'], { PATH: PATHS }).includes('pullrequestcreate?sourceRef=feat/x&targetRef=main'), 'azure link');
  for (const u of ['https://github.com.evil.example/a/b', 'https://gitlab.example.evil.com/a/b', 'https://evilgitlab.com/a/b', 'https://bitbucket.org.evil.example/a/b', 'https://notdev.azure.com/a/b/_git/c', 'https://gitlab.company.com/a/b']) {
    assert.equal(det('platform', u), 'other', u);
  }
  assert.equal(det('platform', 'https://www.github.com/a/b'), 'github');
  assert.equal(pfc(['field', 'platform', '--url', 'https://gitlab.company.com/a/b'], { PATH: PATHS, PROOFLINE_PLATFORM: 'gitlab' }), 'gitlab', 'PROOFLINE_PLATFORM must name a self-hosted host');
});

// --- a project, an installed-looking verifier and fake glab / az ----------------------------------------
const proj = path.join(base, 'proj');
mkdirSync(path.join(proj, '.agents/scripts'), { recursive: true });
git(proj, ['init', '-q', '-b', 'main']);
writeFileSync(path.join(proj, 'f.txt'), 'x\n');
git(proj, ['add', '-A']); git(proj, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
const sha = git(proj, ['rev-parse', 'HEAD']); const sha2 = '2'.repeat(40);
// a stand-in agent.sh (the merge only needs the project to look installed; the verification commands come from its config.yaml, see merge() below)
writeFileSync(path.join(proj, '.agents/scripts/agent.sh'), '#!/bin/sh\nexit 0\n');
{ const s = path.join(repo, 'control-plane/agents/scripts'); cpSync(path.join(s, 'proofline-core.mjs'), path.join(proj, '.agents/scripts/proofline-core.mjs')); cpSync(path.join(s, 'core'), path.join(proj, '.agents/scripts/core'), { recursive: true }); }
git(proj, ['config', 'user.name', 't']); git(proj, ['config', 'user.email', 't@t']);
writeFileSync(path.join(proj, '.gitignore'), '.agents/local/\n');
const FS = path.join(base, 'fs'); mkdirSync(FS);
writeTool(path.join(stubd, 'glab'), `#!/bin/sh
echo "$*" >> "${FS}/glab.log"
case "$1 $2" in
  "mr view") cat "${FS}/glab.view" ;;
  "mr merge") echo "$*" >> "${FS}/merge.log" ;;
  "mr note") echo "$*" >> "${FS}/note.log" ;;
esac
exit 0
`);
writeTool(path.join(stubd, 'az'), `#!/bin/sh
echo "$*" >> "${FS}/az.log"
case "$*" in
  *"pr policy list"*) cat "${FS}/az.policy" ;;
  *"pr show"*) cat "${FS}/az.view" ;;
  *"pr update"*"completed"*) echo "$*" >> "${FS}/merge.log" ;;
  *"pr update"*) echo "$*" >> "${FS}/note.log" ;;
esac
exit 0
`);
const cmdBuild = path.join(proj, '.agents/cmd.build'); const cmdTest = path.join(proj, '.agents/cmd.test');
const reset = () => {
  for (const f of readdirSync(FS)) rmSync(path.join(FS, f), { force: true });
  writeFileSync(cmdBuild, 'echo built\n'); writeFileSync(cmdTest, 'echo tested\n'); rmSync(path.join(proj, '.agents/local'), { recursive: true, force: true });
};
/** @param {string} state @param {boolean} draft @param {string} s @param {string} pipeline */
const glabview = (state, draft, s, pipeline) => writeFileSync(path.join(FS, 'glab.view'), `{"iid":7,"state":"${state}","draft":${draft},"sha":"${s}","head_pipeline":${pipeline}}\n`);
/** @param {string} state @param {boolean} draft @param {string} s */
const azview = (state, draft, s) => writeFileSync(path.join(FS, 'az.view'), `{"pullRequestId":7,"status":"${state}","isDraft":${draft},"lastMergeSourceCommit":{"commitId":"${s}"},"description":"old text"}\n`);
/** The project's verification commands come from config.yaml (written from the cmd files, as the shell merge() did). @param {string[]} args @param {string} [p] */
const doMerge = (args, p = PATHS) => {
  const t = (/** @type {string} */ f) => slurp(f).replace(/\n+$/, '');
  writeFileSync(path.join(proj, '.agents/config.yaml'), `commands:\n  build: ${t(cmdBuild)}\n  test: ${t(cmdTest)}\n`);
  return merge(proj, args, p);
};
let out = '';
/** @param {string[]} args @param {string} [p] */
const mg = (args, p) => { const r = doMerge(args, p); out = r.text; return r; };
/** @param {string} label @param {string} text @param {string[]} args */
function refused(label, text, ...args) {
  const r = mg(args);
  assert.notEqual(r.status, 0, `${label}: merged: ${out}`);
  assert.ok(out.includes(text), `${label}: wrong refusal: ${out}`);
  assert.ok(!existsSync(path.join(FS, 'merge.log')), `${label}: the tool merged`);
}
const greenPipe = `{"status":"success","sha":"${sha}"}`;

// --- GitLab ---------------------------------------------------------------------------------------------
test('gitlab: a merge request with a green pipeline on its head merges through glab (--sha pinned)', () => {
  git(proj, ['remote', 'add', 'origin', 'https://gitlab.com/acme/app.git']);
  reset(); glabview('opened', false, sha, greenPipe);
  const r = mg(['7', '--squash']);
  assert.equal(r.status, 0, `green gitlab merge request: ${out}`);
  assert.ok(slurp(path.join(FS, 'merge.log')).includes(`mr merge 7 --sha ${sha} --yes --squash`), `glab merge line: ${slurp(path.join(FS, 'merge.log'))}`);
  assert.ok(out.includes('using glab at'), 'no tool path printed');
  assert.ok(!existsSync(path.join(FS, 'note.log')), 'a green pipeline needs no local verification note');
});
test('gitlab: a failed, running or foreign pipeline, a draft and a merged request are refused', () => {
  reset(); glabview('opened', false, sha, `{"status":"failed","sha":"${sha}"}`); refused('gitlab: a failed pipeline is refused', 'pipeline of its head is failed', '7');
  reset(); glabview('opened', false, sha, `{"status":"running","sha":"${sha}"}`); refused('gitlab: a running pipeline is refused', 'is running', '7');
  reset(); glabview('opened', false, sha, `{"status":"success","sha":"${sha2}"}`); refused('gitlab: a pipeline of another commit is refused', 'not on the head', '7');
  reset(); glabview('opened', true, sha, greenPipe); refused('gitlab: a draft is refused', 'is a draft', '7');
  reset(); glabview('merged', false, sha, greenPipe); refused('gitlab: a merged request is refused', 'merged, not opened', '7');
});
test('gitlab: no pipeline -> build and test pass in a clean copy of the commit, the note "verified locally, no CI" is posted, then it merges; a failing test, nothing configured, or a head not in this clone refuse', () => {
  reset(); glabview('opened', false, sha, 'null');
  const r = mg(['7']);
  assert.equal(r.status, 0, `gitlab without a pipeline, verification passing: ${out}`);
  assert.ok(slurp(path.join(FS, 'note.log')).includes('verified locally, no CI'), "the merge request got no 'verified locally, no CI' note");
  assert.ok(existsSync(path.join(FS, 'merge.log')), 'not merged after a passing local verification');
  assert.ok(readdirSync(path.join(proj, '.agents/local/builds')).some((n) => n.startsWith(sha)), 'no build record for the merged commit');
  reset(); glabview('opened', false, sha, 'null'); writeFileSync(cmdTest, 'echo broken; exit 3\n');
  refused('gitlab: no pipeline and a failing local test is refused', 'verification commands FAILED', '7');
  reset(); glabview('opened', false, sha, 'null'); writeFileSync(cmdBuild, ''); writeFileSync(cmdTest, '');
  refused('gitlab: no pipeline and nothing configured to verify with is refused', 'not configured', '7');
  reset(); glabview('opened', false, sha2, 'null'); refused('gitlab: no pipeline and a head that is not in this clone is refused', 'not in this clone', '7');
});

// --- Azure DevOps ---------------------------------------------------------------------------------------
test('azure: every build policy approved merges through az repos; a rejected or queued policy, an abandoned request refuse; no build policy -> verified locally first', () => {
  git(proj, ['remote', 'set-url', 'origin', 'https://acme@dev.azure.com/acme/Proj/_git/app']);
  const polOk = '[{"status":"approved","configuration":{"type":{"displayName":"Build"}}},{"status":"approved","configuration":{"type":{"displayName":"Minimum number of reviewers"}}}]';
  reset(); azview('active', false, sha); writeFileSync(path.join(FS, 'az.policy'), `${polOk}\n`);
  let r = mg(['7', '--squash', '--delete-branch']);
  assert.equal(r.status, 0, `azure with approved build policy: ${out}`);
  assert.ok(slurp(path.join(FS, 'merge.log')).includes('--id 7 --status completed --squash true --delete-source-branch true'), `az merge line: ${slurp(path.join(FS, 'merge.log'))}`);
  reset(); azview('active', false, sha); writeFileSync(path.join(FS, 'az.policy'), '[{"status":"rejected","configuration":{"type":{"displayName":"Build"}}}]\n');
  refused('azure: a rejected build policy is refused', 'not approved', '7');
  reset(); azview('active', false, sha); writeFileSync(path.join(FS, 'az.policy'), '[{"status":"queued","configuration":{"type":{"displayName":"Build"}}}]\n');
  refused('azure: a queued build policy is refused', 'Build=queued', '7');
  reset(); azview('abandoned', false, sha); writeFileSync(path.join(FS, 'az.policy'), '[]\n'); refused('azure: an abandoned pull request is refused', 'abandoned, not active', '7');
  reset(); azview('active', false, sha); writeFileSync(path.join(FS, 'az.policy'), '[{"status":"approved","configuration":{"type":{"displayName":"Minimum number of reviewers"}}}]\n');
  r = mg(['7']);
  assert.equal(r.status, 0, `azure without build policy, verification passing: ${out}`);
  const note = slurp(path.join(FS, 'note.log'));
  assert.ok(note.includes('old text') && note.includes('verified locally, no CI'), `the description keeps its text and gains the note: ${note}`);
});

test('glab merge call line is pinned to the verified sha, only after a final (success) pipeline', () => {
  git(proj, ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git']);
  reset(); glabview('opened', false, sha, greenPipe);
  const r = mg(['7']);
  assert.equal(r.status, 0, `glab merge: ${out}`);
  assert.equal(slurp(path.join(FS, 'merge.log')).replace(/\n+$/, ''), `mr merge 7 --sha ${sha} --yes`, 'the glab merge line is exactly sha-pinned and final');
});

// --- A186: git.platform / git.platform_host from config, precedence config > env > auto, look-alike hosts ---------------
const cfgFile = path.join(proj, '.agents/config.yaml');
/** @param {string} platform @param {string} [host] */
const cfgp = (platform, host) => writeFileSync(cfgFile, `git:\n  protected_branches: main\n  platform: ${platform}\n${host ? `  platform_host: ${host}\n` : ''}`);
/** @param {string} url @param {string} field @param {Record<string, string>} [env] */
const pv = (url, field, env = {}) => pfc(['field', field, '-C', proj, '--url', url], env);
const pd = (/** @type {string} */ url) => pfc(['detect', '-C', proj, '--url', url]).split('\n').join(' ');

test('A186: git.platform_host recognises an on-prem address by whole-host equality; look-alikes stay other; config beats env beats auto; the tool gets the host', () => {
  cfgp('gitlab', 'gitlab.company.com');
  assert.ok(pv('https://gitlab.company.com/a/b', 'platform') === 'gitlab' && pv('https://gitlab.company.com/a/b', 'source') === 'config', `an on-prem host from config: ${pd('https://gitlab.company.com/a/b')}`);
  assert.equal(pv('git@GitLab.Company.com:a/b.git', 'platform'), 'gitlab', 'the host match is case-insensitive');
  for (const u of ['https://gitlab.company.com.evil.example/a/b', 'https://evil-gitlab.company.com/a/b', 'https://gitlab.company.com.attacker.example/a/b', 'https://notgitlab.company.com/a/b']) {
    assert.ok(pv(u, 'platform') === 'other' && pv(u, 'source') === 'auto', `look-alike host ${u} took the configured platform: ${pd(u)}`);
  }
  cfgp('github', 'github.company.com');
  assert.equal(pv('https://github.company.com/a/b', 'platform'), 'github', 'GitHub Enterprise host from config');
  assert.equal(pv('https://github.com.evil.example/a/b', 'platform'), 'other', 'github.com.evil.example recognised');
  // precedence: config beats env beats auto
  cfgp('gitlab', 'gitlab.company.com');
  const az = { PROOFLINE_PLATFORM: 'azure' };
  assert.ok(pv('https://gitlab.company.com/a/b', 'platform', az) === 'gitlab' && pv('https://gitlab.company.com/a/b', 'source', az) === 'config', 'config must beat env');
  assert.ok(pv('https://elsewhere.example/a/b', 'platform', az) === 'azure' && pv('https://elsewhere.example/a/b', 'source', az) === 'env', 'env applies when the configured host differs');
  rmSync(cfgFile, { force: true });
  assert.ok(pv('https://github.com/a/b', 'platform', az) === 'azure' && pv('https://github.com/a/b', 'source', az) === 'env', 'env must beat auto');
  assert.ok(pv('https://github.com/a/b', 'platform') === 'github' && pv('https://github.com/a/b', 'source') === 'auto', 'auto detection changed');
  cfgp('gitlab'); assert.equal(pv('https://git.example.com/a/b', 'platform'), 'gitlab', 'git.platform without a host applies to any origin');
  // the tool follows the private host
  cfgp('gitlab', 'gitlab.company.com');
  assert.equal(pfc(['env', '-C', proj, '--url', 'https://gitlab.company.com/a/b']), 'GITLAB_HOST=gitlab.company.com', 'GITLAB_HOST for a self-hosted GitLab');
  rmSync(cfgFile, { force: true });
});

test('A186: git.platform without platform_host on a look-alike origin warns and exports no GH_HOST/GITLAB_HOST; exact hosts are unaffected', () => {
  cfgp('gitlab');
  const la = 'https://gitlab.com.evil.example/a/b';
  const w = pfc(['warn', '-C', proj, '--url', la]);
  assert.ok(w.startsWith('warning: git.platform is gitlab without git.platform_host'), `no warning for a look-alike origin: ${w}`);
  assert.equal(pfc(['env', '-C', proj, '--url', la]), '', 'a look-alike origin got a host variable');
  assert.equal(pfc(['warn', '-C', proj, '--url', 'https://gitlab.com/a/b']), '', 'gitlab.com warned although it is a known gitlab host');
  cfgp('github');
  assert.equal(pfc(['env', '-C', proj, '--url', 'https://github.com.evil.example/a/b']), '', 'GH_HOST exported for github.com.evil.example');
  assert.notEqual(pfc(['warn', '-C', proj, '--url', 'https://github.com.evil.example/a/b']), '', 'no warning for github.com.evil.example');
  cfgp('gitlab', 'gitlab.company.com');
  assert.ok(pfc(['warn', '-C', proj, '--url', 'https://gitlab.company.com.evil.example/a/b']) === '' && pfc(['env', '-C', proj, '--url', 'https://gitlab.company.com/a/b']) === 'GITLAB_HOST=gitlab.company.com', 'an exact platform_host must not warn and must export its host');
  rmSync(cfgFile, { force: true });
});

test('round 6: local origins: ./x ../x /abs file:///abs are local; .evil.example:org/repo and file://host/path are not', () => {
  for (const u of ['./x', '../x', '/abs', 'file:///abs']) assert.equal(pfc(['field', 'local', '--url', u]), 'yes', `${u} must be a local origin`);
  for (const u of ['.evil.example:org/repo', 'file://host/path', 'file://evil.example/a/b']) assert.equal(pfc(['field', 'local', '--url', u]), 'no', `${u} must NOT be a local origin`);
});

// --- the user merges: Bitbucket, unrecognized, missing tool -----------------------------------------------
test('bitbucket and an unrecognized host: nothing is merged, the message says the USER merges and prints the steps; a missing tool falls back to the manual path', () => {
  for (const u of ['https://bitbucket.org/acme/app.git', 'ssh://git@git.example.com/acme/app.git']) {
    git(proj, ['remote', 'set-url', 'origin', u]); reset(); glabview('opened', false, sha, greenPipe);
    const r = mg(['7']);
    assert.notEqual(r.status, 0, `merged on ${u}`);
    assert.ok(out.includes('NOT MERGED') && out.includes('YOU merge it') && out.includes('manual steps'), `no explicit manual message for ${u}: ${out}`);
    assert.ok(!existsSync(path.join(FS, 'merge.log')), `a tool merged on ${u}`);
  }
  git(proj, ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git']);
  const nogl = path.join(base, 'nogl');
  toolsOnly(nogl, ['git', 'sed', 'awk', 'head', 'tr', 'dirname', 'cat', 'readlink', 'sh', 'node']);
  const r = mg(['7'], nogl);
  assert.notEqual(r.status, 0, 'merged without glab');
  assert.ok(out.includes('NOT MERGED') && out.includes('glab') && out.includes('YOU merge it'), `missing-tool message: ${out}`);
});

// --- gh with no checks: local verification (the gh path keeps its strictness) ---------------------------
test('github: a pull request with no checks is merged after the local verification and says "verified locally, no CI"; a failing local build and a red check are refused', () => {
  git(proj, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git']);
  writeTool(path.join(stubd, 'gh'), `#!/bin/sh
case "$*" in
  *"pr merge"*) echo "$*" >> "${FS}/merge.log"; exit 0 ;;
  *"pr comment"*) echo "$*" >> "${FS}/note.log"; exit 0 ;;
  *"pr checks"*) echo "no required checks reported on the 'main' branch" >&2; exit 1 ;;
  *statusCheckRollup*) cat "${FS}/gh.view" ;;
  *headRefOid*) printf '{"headRefOid":"%s"}\\n' "$(sed -n 's/.*"headRefOid":"\\([0-9a-f]*\\)".*/\\1/p' "${FS}/gh.view")" ;;
esac
`);
  const ghview = (/** @type {string} */ s, /** @type {string} */ rollup) => writeFileSync(path.join(FS, 'gh.view'), `{"number":7,"state":"OPEN","isDraft":false,"headRefOid":"${s}","statusCheckRollup":${rollup}}\n`);
  reset(); ghview(sha, '[]');
  const r = mg(['7']);
  assert.equal(r.status, 0, `gh no checks, verification passing: ${out}`);
  assert.ok(slurp(path.join(FS, 'note.log')).includes('verified locally, no CI') && existsSync(path.join(FS, 'merge.log')), 'gh: no note or no merge');
  reset(); ghview(sha, 'null'); writeFileSync(cmdBuild, 'echo broken; exit 2\n');
  refused('github: no checks and a failing local build is refused', 'verification commands FAILED', '7');
  reset(); ghview(sha, '[{"__typename":"CheckRun","name":"static","status":"COMPLETED","conclusion":"FAILURE"}]');
  refused('github: a red check is still refused (no local verification replaces it)', 'not green', '7');
});

// --- the hook keeps the single merge path on glab and az ---------------------------------------------------
const denyCmds = [
  'glab mr merge 7', 'glab mr merge 7 --squash --yes', 'glab -R acme/app mr merge 7', 'glab alias set m "mr merge"', 'glab api -X PUT projects/1/merge_requests/7/merge',
  'glab api projects/1/merge_requests/7/merge -X PUT -f merge_when_pipeline_succeeds=true', 'sh -c "glab mr merge 7"', 'm=merge; glab mr $m 7',
  'az repos pr update --id 7 --status completed', 'az repos pr update --id 7 --auto-complete true', 'az repos pr update --id 7 --status=completed --squash true',
  'az rest --method patch --uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/7', 'az devops invoke --area git --resource pullRequests --http-method PATCH',
  'curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/7/merge', 'glab mr accept 7', 'az repos pr create --title t --auto-complete true', 'az repos pr create --bypass-policy true',
  'az repos pr update --id 7 --status Completed', 'az repos pr update --id 7 --status COMPLETED', 'az repos pr update --id 7 --status=Completed', 'GLAB mr MERGE 7', 'az repos pr create --Auto-Complete true',
  'az repos pr update --id 7 --bypass-policy true', 'az repos pr set-vote --id 7 --status completed',
  'curl -X PUT https://git.corp.example/api/v4/projects/1/merge_requests/7/merge', 'curl -X PUT https://code.corp.example/api/v3/repos/o/r/pulls/7/merge',
  'wget --method=PATCH https://tfs.corp.example/o/p/_apis/git/repositories/r/pullrequests/7', 'curl -X PUT -d state_event=merge https://x.example/api/v4/projects/1/merge_requests/7',
];
const allowCmds = [
  'proofline merge 7', 'glab mr view 7', 'glab mr create --target-branch main', 'glab ci status', 'az repos pr show --id 7', 'az repos pr create --source-branch x --target-branch main',
  'az repos pr policy list --id 7', 'az repos pr list --status completed', 'az pipelines runs list --status completed', 'az repos pr update --id 7 --title t', 'glab api projects/1/merge_requests/7',
];
test('the hook: glab merge, glab api merge, az repos pr update that completes, az rest on pull requests and HTTP clients are denied (naming proofline merge); reading, creating and retitling stay allowed', async () => {
  git(proj, ['checkout', '-q', '-b', 'feat/x']);
  /** @type {string[]} */ const bad = [];
  await pooled(denyCmds, 8, async (c) => {
    const o = await preBashAsync(proj, c);
    if (!o.includes('"permissionDecision":"deny"')) bad.push(`not denied: ${c} -> ${o}`);
    else if (!o.includes('proofline merge')) bad.push(`the denial does not name proofline merge: ${c}`);
  });
  await pooled(allowCmds, 8, async (c) => {
    const o = await preBashAsync(proj, c);
    if (o.includes('"permissionDecision":"deny"')) bad.push(`denied: ${c} -> ${o}`);
  });
  assert.deepEqual(bad, []);
});
