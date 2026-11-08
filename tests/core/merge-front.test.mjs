// @ts-check
// `proofline merge <PR>` through the CLI front end (A232; bin/lib/merge.sh was a launcher of `cli merge` and is gone): the same command, run as `sh bin/proofline merge`
// against a fake gh outside every temporary folder. The merge rules themselves (red, pending, draft, moved head, refused tools) are tested in run6b-merge.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PL } from './frontend-lib.mjs';
import { toolRoot } from './run6-lib.mjs';

const sha = 'a'.repeat(40);

/** A GitHub project and a fake gh that answers from the files of a state folder. */
function setup() {
  const proj = mkdtempSync(path.join(tmpdir(), 'mf-proj-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (/** @type {string[]} */ ...a) => spawnSync('git', ['-C', proj, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'base'); git('remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const st = mkdtempSync(path.join(tmpdir(), 'mf-state-'));
  const bin = path.join(toolRoot, `mf-${path.basename(st)}`, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/gh`, `#!/bin/sh\ncase "$*" in\n  *"pr merge"*) echo "$*" >> "${st}/merge.log"; exit 0 ;;\n  *"pr checks"*) echo "no required checks reported on the 'feat/x' branch" >&2; exit 1 ;;\n  *statusCheckRollup*) cat "${st}/view.json" ;;\n  *headRefOid*) cat "${st}/head.json" ;;\nesac\n`);
  chmodSync(`${bin}/gh`, 0o755);
  const view = (/** @type {string} */ conclusion) => {
    writeFileSync(`${st}/view.json`, JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, headRefOid: sha, statusCheckRollup: [{ __typename: 'CheckRun', name: 'static', status: 'COMPLETED', conclusion }] }));
    writeFileSync(`${st}/head.json`, JSON.stringify({ headRefOid: sha }));
  };
  const merge = (/** @type {string[]} */ args) => {
    const r = spawnSync(PL, ['merge', ...args], { cwd: proj, env: { ...env, PATH: `${bin}:${process.env.PATH}`, PROOFLINE_NO_TTY: '1' }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const merged = () => { try { return readFileSync(`${st}/merge.log`, 'utf8'); } catch { return ''; } };
  return { merge, view, merged, done: () => { rmSync(proj, { recursive: true, force: true }); rmSync(st, { recursive: true, force: true }); rmSync(path.dirname(bin), { recursive: true, force: true }); } };
}

test('proofline merge: a green pull request is merged pinned to the checked head and says "green at <sha>"', () => {
  const t = setup();
  try {
    t.view('SUCCESS');
    const r = t.merge(['7', '--squash']);
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.out.includes(`proofline merge: pull request 7 is green at ${sha} (1 checks); merging (--squash)`), r.out);
    assert.match(t.merged(), new RegExp(`pr merge 7 --squash --match-head-commit ${sha}`));
  } finally { t.done(); }
});

test('proofline merge: a red check merges nothing and exits 1; --admin and --auto are refused; no argument is a usage error', () => {
  const t = setup();
  try {
    t.view('FAILURE');
    const red = t.merge(['7']);
    assert.equal(red.status, 1);
    assert.ok((red.out + red.err).includes('static: status COMPLETED, conclusion FAILURE'), red.out + red.err);
    t.view('SUCCESS');
    for (const flag of ['--admin', '--auto']) {
      const r = t.merge(['7', flag]);
      assert.notEqual(r.status, 0, flag);
    }
    assert.notEqual(t.merge([]).status, 0);
    assert.equal(t.merged(), '', 'gh pr merge never ran');
  } finally { t.done(); }
});
