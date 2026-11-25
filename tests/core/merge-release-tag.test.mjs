// @ts-check
// `proofline merge` tags a merged VERSION pull request (A349): the version in .claude-plugin/plugin.json (the site tests/ci/bump-version.mjs reads) differs between the base tip
// before the merge and after it, so `v<version>` is created on the commit that changed it and pushed to origin. Idempotent; a tag at another commit is refused and never moved; a
// failed push does not undo the merge and prints the commands; no tag when the version did not change or outside proofline's own repository (no tests/ci/bump-version.mjs).
// The remote is a bare repository in a temporary folder; gh is a fake whose `pr merge` really advances that remote (a commit pushed from a "server" clone).
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync as wf } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { run, toolRoot, nodeFake, joinPath } from './run6-lib.mjs';
import { scripts } from './legacy-lib.mjs';

const core = `${scripts}/proofline-core.mjs`;
const sha = '1'.repeat(40);
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const plugin = (/** @type {string} */ v) => `{\n  "name": "x",\n  "version": "${v}",\n  "other": 1\n}\n`;

/** The fake gh: answers the checks from view.json; `pr merge` commits to the server clone and pushes to the bare origin (state files: base, queued, newversion (one version per line = one commit each), pretag-same, pretag-other, localtag-same). @param {string} st */
function ghSource(st) {
  return `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const st = ${JSON.stringify(st)}; const all = process.argv.slice(2).join(' ');
const git = (...a) => { const r = spawnSync('git', ['-C', st + '/server', ...${JSON.stringify(ID)}, ...a], { encoding: 'utf8' }); if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(9); } return r.stdout.trim(); };
if (all.includes('pr merge')) {
  appendFileSync(st + '/merge.log', all + '\\n');
  if (existsSync(st + '/queued')) process.exit(0);
  const base = existsSync(st + '/base') ? readFileSync(st + '/base', 'utf8').trim() : 'main';
  git('pull', '-q', 'origin', base);
  if (existsSync(st + '/pretag-other')) git('push', '-q', 'origin', 'HEAD:refs/tags/v' + readFileSync(st + '/pretag-other', 'utf8').trim());
  const versions = existsSync(st + '/newversion') ? readFileSync(st + '/newversion', 'utf8').trim().split('\\n') : [];
  for (const v of versions.length ? versions : ['']) {
    if (v !== '') writeFileSync(st + '/server/.claude-plugin/plugin.json', readFileSync(st + '/server/.claude-plugin/plugin.json', 'utf8').replace(/"version": "[^"]*"/, '"version": "' + v + '"'));
    else writeFileSync(st + '/server/notes.txt', 'change\\n');
    git('add', '-A'); git('commit', '-q', '-m', 'merge of the pull request ' + v);
  }
  git('push', '-q', 'origin', 'HEAD:' + base);
  if (existsSync(st + '/pretag-same')) git('push', '-q', 'origin', 'HEAD:refs/tags/v' + readFileSync(st + '/pretag-same', 'utf8').trim());
  if (existsSync(st + '/localtag-same')) { const l = (...a) => { const r = spawnSync('git', ['-C', st + '/proj', ...${JSON.stringify(ID)}, ...a], { encoding: 'utf8' }); if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(9); } }; l('fetch', '-q', 'origin', base); l('tag', 'v' + readFileSync(st + '/localtag-same', 'utf8').trim(), 'FETCH_HEAD'); }
  process.exit(0);
}
if (all.includes('pr checks')) { process.stderr.write("no required checks reported on the 'main' branch\\n"); process.exit(1); }
if (all.includes('statusCheckRollup')) process.stdout.write(readFileSync(st + '/view.json'));
else if (all.includes('headRefOid')) process.stdout.write(readFileSync(st + '/head.json'));
`;
}

/** @param {{ release?: boolean, base?: string }} [o] base: the base branch (default main); release: false leaves out tests/ci/bump-version.mjs (an installed project, not proofline's own repository) */
function setup(o = {}) {
  const st = tempDir('rt-state-');
  const origin = path.join(st, 'origin.git');
  const proj = path.join(st, 'proj');
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => { const r = run(cwd, 'git', [...ID, ...a]); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.text}`); return r.out.trim(); };
  git(st, 'init', '-q', '--bare', '-b', 'main', origin);
  git(st, 'clone', '-q', origin, proj);
  git(proj, 'checkout', '-q', '-b', 'main');
  mkdirSync(`${proj}/.claude-plugin`, { recursive: true }); wf(`${proj}/.claude-plugin/plugin.json`, plugin('0.0.1'));
  if (o.release !== false) { mkdirSync(`${proj}/tests/ci`, { recursive: true }); wf(`${proj}/tests/ci/bump-version.mjs`, '// stands for the bump script\n'); }
  git(proj, 'add', '-A'); git(proj, 'commit', '-q', '-m', 'base'); git(proj, 'push', '-q', 'origin', 'main');
  const baseName = o.base ?? 'main';
  if (baseName !== 'main') { git(proj, 'push', '-q', 'origin', `main:${baseName}`); wf(`${st}/base`, `${baseName}\n`); }
  git(st, 'clone', '-q', origin, `${st}/server`);
  const base = git(proj, 'rev-parse', 'HEAD');
  const bin = path.join(toolRoot, `rt-${path.basename(st)}`, 'bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') nodeFake(bin, 'gh', ghSource(st));
  else {
    const script = path.join(toolRoot, `rt-${path.basename(st)}`, 'gh.mjs');
    wf(script, ghSource(st));
    wf(`${bin}/gh`, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`); chmodSync(`${bin}/gh`, 0o755);
  }
  wf(`${st}/view.json`, JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, headRefOid: sha, baseRefName: o.base ?? 'main', statusCheckRollup: [{ __typename: 'CheckRun', name: 'static', status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
  wf(`${st}/head.json`, JSON.stringify({ headRefOid: sha }));
  const merge = () => run(proj, process.execPath, [core, 'cli', 'merge', '7'], { PATH: joinPath(bin, process.env.PATH), PROOFLINE_PLATFORM: 'github' });
  const originGit = (/** @type {string[]} */ ...a) => run(st, 'git', ['--git-dir', origin, ...a]).out.trim();
  const originTag = (/** @type {string} */ tag) => originGit('rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`);
  return {
    st, proj, git, base, merge, originTag, originGit,
    originMain: () => originGit('rev-parse', baseName),
    set: (/** @type {string} */ f, /** @type {string} */ v) => wf(`${st}/${f}`, `${v}\n`),
    merged: () => { try { return readFileSync(`${st}/merge.log`, 'utf8'); } catch { return ''; } },
    done: () => { rmSync(st, { recursive: true, force: true }); rmSync(path.dirname(bin), { recursive: true, force: true }); },
  };
}

test('merge: a merged version pull request is tagged v<version> on the version commit, locally and on origin', () => {
  const t = setup();
  try {
    t.set('newversion', '0.0.2');
    const r = t.merge();
    assert.equal(r.status, 0, r.text);
    const tip = t.originMain();
    assert.notEqual(tip, t.base);
    assert.equal(t.originTag('v0.0.2'), tip, 'the tag is on the merge commit');
    assert.equal(t.git(t.proj, 'rev-parse', 'refs/tags/v0.0.2^{commit}'), tip, 'and in the local clone');
    assert.match(r.out, /release tag v0\.0\.2 created at [0-9a-f]{40} and pushed to origin/);
  } finally { t.done(); }
});

test('merge: a pull request that does not change the version creates no tag, and neither does a repository without tests/ci/bump-version.mjs', () => {
  const t = setup();
  try {
    const r = t.merge();
    assert.equal(r.status, 0, r.text);
    assert.equal(t.originGit('tag'), '');
    assert.doesNotMatch(r.text, /release tag v|no release tag/);
  } finally { t.done(); }
  const u = setup({ release: false });
  try {
    u.set('newversion', '0.0.2');
    const r = u.merge();
    assert.equal(r.status, 0, r.text);
    assert.equal(u.originTag('v0.0.2'), '', "not proofline's own release flow: no tag");
    assert.match(r.out, /no release tag was made: this is not proofline's own repository/);
  } finally { u.done(); }
});

test('merge: a tag that already exists on origin at the version commit is fine; at another commit it is refused, never moved, and the merge stands', () => {
  const same = setup();
  try {
    same.set('newversion', '0.0.2'); same.set('pretag-same', '0.0.2');
    const r = same.merge();
    assert.equal(r.status, 0, r.text);
    assert.match(r.out, /release tag v0\.0\.2 is already on origin at [0-9a-f]{40}/);
  } finally { same.done(); }
  const other = setup();
  try {
    other.set('newversion', '0.0.2'); other.set('pretag-other', '0.0.2');
    const r = other.merge();
    assert.equal(r.status, 1, r.text);
    assert.match(r.err, /pull request 7 IS MERGED, but the release tag v0\.0\.2 was NOT created: origin already has v0\.0\.2 at [0-9a-f]{40}.*never moves a tag/);
    assert.notEqual(other.originMain(), other.base, 'the merge stands');
    assert.equal(other.originTag('v0.0.2'), other.base, 'the tag stayed on the commit it had (the tip before the merge)');
  } finally { other.done(); }
});

test('merge: a local tag at another commit is refused and nothing is pushed', () => {
  const t = setup();
  try {
    t.git(t.proj, 'tag', 'v0.0.2', t.base);
    t.set('newversion', '0.0.2');
    const r = t.merge();
    assert.equal(r.status, 1, r.text);
    assert.match(r.err, /the tag exists locally at [0-9a-f]{40}, not at the version commit/);
    assert.equal(t.originTag('v0.0.2'), '');
  } finally { t.done(); }
});

/** The printed finish command, run step by step (split at ` && `) in the project. @param {ReturnType<typeof setup>} t @param {string} err */
function runHint(t, err) {
  const hint = /To finish: (.*)$/m.exec(err)?.[1] ?? '';
  for (const step of hint.split(' && ')) { const [prog, ...args] = step.split(' '); assert.equal(prog, 'git'); const r = run(t.proj, 'git', args); assert.equal(r.status, 0, `${step}: ${r.text}`); }
  return hint;
}

test('merge: a failed tag push does not undo the merge, exits 1 and the hint is the push only (the tag exists); the hint then really finishes the job', () => {
  const t = setup();
  try {
    t.git(t.proj, 'config', 'remote.origin.pushurl', path.join(t.st, 'no-such-remote.git'));
    t.set('newversion', '0.0.2');
    const r = t.merge();
    assert.equal(r.status, 1, r.text);
    assert.match(t.merged(), /pr merge 7/);
    const tip = t.originMain();
    assert.notEqual(tip, t.base, 'the merge stands');
    assert.match(r.err, /pull request 7 IS MERGED, but the release tag v0\.0\.2 was NOT pushed \(it exists locally\): git push origin refs\/tags\/v0\.0\.2 failed/);
    assert.match(r.err, /To finish: git push origin refs\/tags\/v0\.0\.2$/m);
    assert.equal(t.git(t.proj, 'rev-parse', 'refs/tags/v0.0.2^{commit}'), tip, 'the local tag is on the version commit');
    assert.equal(t.originTag('v0.0.2'), '');
    t.git(t.proj, 'config', '--unset', 'remote.origin.pushurl');
    assert.equal(runHint(t, r.err), 'git push origin refs/tags/v0.0.2');
    assert.equal(t.originTag('v0.0.2'), tip, 'the printed command finished the job');
  } finally { t.done(); }
});

test('merge: when the local tag could not be created the hint holds git tag and git push, and it really finishes the job', () => {
  const t = setup();
  try {
    mkdirSync(`${t.proj}/.git/refs/tags`, { recursive: true });
    wf(`${t.proj}/.git/refs/tags/v0.0.2.lock`, '');   // a stale lock: git tag fails on it
    t.set('newversion', '0.0.2');
    const r = t.merge();
    assert.equal(r.status, 1, r.text);
    const tip = t.originMain();
    assert.match(r.err, /release tag v0\.0\.2 was NOT created: git tag v0\.0\.2 [0-9a-f]{40} failed\. To finish: git tag v0\.0\.2 [0-9a-f]{40} && git push origin refs\/tags\/v0\.0\.2$/m);
    assert.equal(t.originTag('v0.0.2'), '');
    rmSync(`${t.proj}/.git/refs/tags/v0.0.2.lock`);
    runHint(t, r.err);
    assert.equal(t.originTag('v0.0.2'), tip, 'the printed command finished the job');
  } finally { t.done(); }
});

test('merge: a base branch other than main is read and tagged; a local tag that already equals the version commit is only pushed; two version bumps in one range get two tags', () => {
  const rel = setup({ base: 'release' });
  try {
    rel.set('newversion', '0.0.2');
    const r = rel.merge();
    assert.equal(r.status, 0, r.text);
    assert.equal(rel.originTag('v0.0.2'), rel.originMain(), 'tagged on the release branch tip');
    assert.equal(rel.originGit('rev-parse', 'main'), rel.base, 'main untouched');
  } finally { rel.done(); }
  const same = setup();
  try {
    same.set('newversion', '0.0.2'); same.set('localtag-same', '0.0.2');
    const r = same.merge();
    assert.equal(r.status, 0, r.text);
    assert.equal(same.originTag('v0.0.2'), same.originMain());
    assert.match(r.out, /release tag v0\.0\.2 created at [0-9a-f]{40} and pushed to origin/);
  } finally { same.done(); }
  const two = setup();
  try {
    two.set('newversion', '0.0.2\n0.0.3');
    const r = two.merge();
    assert.equal(r.status, 0, r.text);
    assert.equal(two.originTag('v0.0.3'), two.originMain(), 'the last bump is on the tip');
    assert.equal(two.originTag('v0.0.2'), two.originGit('rev-parse', `${two.originMain()}^`), 'the first bump is on its own commit');
  } finally { two.done(); }
});

test('merge: a merge that left the base branch where it was (queued) prints that no tag was made', () => {
  const t = setup();
  try {
    t.set('queued', 'yes');
    const r = t.merge();
    assert.equal(r.status, 0, r.text);
    assert.match(r.out, /no release tag was made: origin\/main did not move/);
  } finally { t.done(); }
});

test('merge (A357): the local base branch is fast-forwarded to the merged tip, in the working tree that has it; diverged, it is left alone with the commands, and the merge still counts', () => {
  const t = setup();
  try {
    const r = t.merge();
    assert.equal(r.status, 0, r.text);
    const tip = t.originMain();
    assert.notEqual(tip, t.base);
    assert.equal(t.git(t.proj, 'rev-parse', 'main'), tip, 'the local main stayed behind the merged pull request');
    assert.equal(readFileSync(`${t.proj}/notes.txt`, 'utf8'), 'change\n', 'the working tree did not follow its branch');
    assert.match(r.out, /local main fast-forwarded to origin\/main/);
  } finally { t.done(); }
  const d = setup();
  try {
    wf(`${d.proj}/local.txt`, 'unpushed\n'); d.git(d.proj, 'add', '-A'); d.git(d.proj, 'commit', '-q', '-m', 'unpushed');
    const local = d.git(d.proj, 'rev-parse', 'HEAD');
    const r = d.merge();
    assert.equal(r.status, 0, r.text);
    assert.notEqual(d.originMain(), d.base, 'the merge did not happen');
    assert.equal(d.git(d.proj, 'rev-parse', 'main'), local, 'a diverged local branch was moved');
    assert.match(r.text, /IS MERGED, but the local main was NOT updated: .*diverged/);
  } finally { d.done(); }
});
