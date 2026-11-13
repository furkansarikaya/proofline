// @ts-check
// Stage 6B (A216): `proofline merge` in Node (core/merge.mjs). A136 stays strict: the merge happens only when the pull request is open, not a draft and EVERY
// check is a success on the head that is merged (read twice, the merge pinned to it); --admin and --auto are never allowed; a tool that resolves into the
// working directory, the project or a temporary folder is refused (no environment value lifts that). gh is a fake outside every temporary folder answering from
// files. The front end (bin/proofline merge, the launcher of it) and the hook's denial of every other merge path stay covered by the shell suites
// tests/enforcement/merge-guard-test.sh and platform-test.sh until the front end moves.
import { tempDir } from '../lib/tempdir.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run, toolRoot, nodeFake, ghMergeSource, glabMergeSource, joinPath } from './run6-lib.mjs';
import { fakeExe } from '../lib/winfake.mjs';
import { commandV } from '../../control-plane/agents/scripts/core/runtimedetect.mjs';
import { scripts } from './legacy-lib.mjs';

const core = `${scripts}/proofline-core.mjs`;
/**
 * A PATH that holds only what the merge needs (the real tools it runs, linked into one folder inside the checkout): no system folder, so a gh, glab or az that the
 * host happens to have (the CI runner has /usr/bin/gh) is never found, and the tests that expect "no tool" or "a refused entry" do not depend on the machine.
 */
const D = path.delimiter;
const minimal = process.platform === 'win32' ? [...new Set(['git', 'sh'].map((t) => path.dirname(commandV(t, process.env) ?? ''))) ].join(D) : (() => {
  // Windows: the folders of the real git and sh (symbolic links of those tools are not possible there; neither folder holds a gh)
  const d = path.join(toolRoot, `minpath-${process.pid}`);
  mkdirSync(d, { recursive: true });
  for (const t of ['git', 'sh', 'cat', 'sed', 'tr', 'head', 'tail', 'env', 'dirname', 'basename', 'mkdir', 'rm', 'grep', 'awk', 'wc', 'sort']) {
    const real = run(d, 'sh', ['-c', `command -v ${t}`]).out.trim();
    if (real !== '') symlinkSync(real, `${d}/${t}`);
  }
  return d;
})();
const sha = '1'.repeat(40);

/** A project (a git repository with a GitHub origin) and a fake gh that answers from the files of its state folder. */
function setup() {
  const proj = tempDir('mg-proj-');
  run(proj, 'git', ['init', '-q', '-b', 'main']);
  run(proj, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  run(proj, 'git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  const st = tempDir('mg-state-');
  const bin = path.join(toolRoot, `mg-${path.basename(st)}`, 'bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') nodeFake(bin, 'gh', ghMergeSource(st));
  else { wf(`${bin}/gh`, `#!/bin/sh\n[ ! -f "${st}/fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }\ncase "$*" in\n  *"pr merge"*) echo "$*" >> "${st}/merge.log"; exit 0 ;;\n  *"pr checks"*) [ ! -f "${st}/proxyerr" ] || { cat "${st}/proxyerr" >&2; exit 1; }; cat "${st}/required.json" 2>/dev/null || { echo "no required checks reported on the 'feat/x' branch" >&2; exit 1; } ;;\n  *"pr comment"*) echo "$*" >> "${st}/comment.log"; exit 0 ;;\n  *statusCheckRollup*) cat "${st}/view.json" ;;\n  *headRefOid*) cat "${st}/head.json" ;;\nesac\n`);
  chmodSync(`${bin}/gh`, 0o755); }
  const view = (/** @type {string} */ state, /** @type {boolean} */ draft, /** @type {string} */ head, /** @type {unknown} */ rollup, now = head) => {
    wf(`${st}/view.json`, JSON.stringify({ number: 7, state, isDraft: draft, headRefOid: head, statusCheckRollup: rollup }));
    wf(`${st}/head.json`, JSON.stringify({ headRefOid: now }));
  };
  const merge = (/** @type {string[]} */ args, /** @type {string} */ pathEnv = joinPath(bin, minimal)) => {
    const r = run(proj, process.execPath, [core, 'cli', 'merge', ...args], { PATH: pathEnv });
    return { ...r, code: r.status };
  };
  const merged = () => { try { return readFileSync(`${st}/merge.log`, 'utf8'); } catch { return ''; } };
  return { proj, st, bin, view, merge, merged, done: () => { rmSync(proj, { recursive: true, force: true }); rmSync(st, { recursive: true, force: true }); rmSync(path.dirname(bin), { recursive: true, force: true }); } };
}
test('merge (GitLab): a draft is refused whether `draft` or the older `work_in_progress` says so (fail closed, jq `//` semantics); a clean merge request goes on', () => {
  const proj = tempDir('mg-gl-');
  run(proj, 'git', ['init', '-q', '-b', 'main']);
  run(proj, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  run(proj, 'git', ['remote', 'add', 'origin', 'https://gitlab.com/acme/app.git']);
  const st = tempDir('mg-gl-state-');
  const bin = path.join(toolRoot, `mgl-${path.basename(st)}`, 'bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') nodeFake(bin, 'glab', glabMergeSource(st));
  else { wf(`${bin}/glab`, `#!/bin/sh\ncase "$*" in\n  *"mr merge"*) echo "$*" >> "${st}/merge.log"; exit 0 ;;\n  *"mr view"*) cat "${st}/view.json" ;;\nesac\n`);
  chmodSync(`${bin}/glab`, 0o755); }
  const mr = (/** @type {Record<string, unknown>} */ extra) => wf(`${st}/view.json`, JSON.stringify({ iid: 7, state: 'opened', sha, head_pipeline: { status: 'success', sha }, ...extra }));
  const merge = () => run(proj, process.execPath, [core, 'cli', 'merge', '7'], { PATH: joinPath(bin, minimal) });
  for (const extra of [{ draft: false, work_in_progress: true }, { work_in_progress: true }, { draft: true }, { draft: true, work_in_progress: false }]) {
    mr(extra);
    const r = merge();
    assert.notEqual(r.status, 0, `${JSON.stringify(extra)}: ${r.text}`);
    assert.match(r.text, /is a draft/, JSON.stringify(extra));
  }
  mr({ draft: false, work_in_progress: false });
  const ok = merge();
  assert.equal(ok.status, 0, ok.text);
  assert.match(readFileSync(`${st}/merge.log`, 'utf8'), /mr merge 7 --sha 1{40}/);
  rmSync(proj, { recursive: true, force: true }); rmSync(st, { recursive: true, force: true }); rmSync(path.dirname(bin), { recursive: true, force: true });
});

const okRun = { __typename: 'CheckRun', name: 'static', status: 'COMPLETED', conclusion: 'SUCCESS' };
const okCtx = { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' };

test('merge: all green merges, pinned to the checked head; the wrapper names the tool it uses', () => {
  const t = setup();
  t.view('OPEN', false, sha, [okRun, okCtx]);
  const r = t.merge(['7', '--squash', '--delete-branch']);
  assert.equal(r.code, 0, r.text);
  assert.match(t.merged(), new RegExp(`pr merge 7 --squash --match-head-commit ${sha} --delete-branch`));
  assert.ok(r.out.includes(`proofline merge: using gh at ${t.bin.replace(/^\/private/, '')}`) || r.out.includes('proofline merge: using gh at '), r.out);
  t.done();
});

test('merge: a red, pending, cancelled or unknown check, a draft, a closed pull request, a moved head and an unreadable answer are refused and nothing is merged', () => {
  const t = setup();
  const refused = (/** @type {string} */ what, /** @type {string} */ frag, /** @type {string[]} */ args = ['7']) => {
    const r = t.merge(args);
    assert.notEqual(r.code, 0, `${what}: merged`);
    assert.equal(t.merged(), '', `${what}: gh pr merge ran`);
    assert.ok(r.text.includes(frag), `${what}: ${r.text}`);
  };
  t.view('OPEN', false, sha, [okRun, { __typename: 'CheckRun', name: 'selftest', status: 'COMPLETED', conclusion: 'FAILURE' }]);
  refused('red CI', 'selftest: status COMPLETED, conclusion FAILURE');
  t.view('OPEN', false, sha, [okRun, { __typename: 'CheckRun', name: 'selftest', status: 'IN_PROGRESS', conclusion: null }]);
  refused('pending CI', 'selftest: status IN_PROGRESS');
  t.view('OPEN', false, sha, [okRun, { __typename: 'CheckRun', name: 'selftest', status: 'COMPLETED', conclusion: 'CANCELLED' }]);
  refused('cancelled CI', 'conclusion CANCELLED');
  t.view('OPEN', false, sha, [okRun, { __typename: 'StatusContext', context: 'ci/x', state: 'PENDING' }]);
  refused('a pending status context', 'ci/x: state PENDING');
  t.view('OPEN', false, sha, [okRun, { __typename: 'Mystery', name: 'm' }]);
  refused('an unknown check type', 'unknown check type Mystery');
  t.view('OPEN', true, sha, [okRun]);
  refused('a draft', 'is a draft');
  t.view('MERGED', false, sha, [okRun]);
  refused('a merged pull request', 'is MERGED, not OPEN');
  t.view('OPEN', false, 'abc', [okRun]);
  refused('a head that is not a SHA', 'is not a 40-digit SHA');
  t.view('OPEN', false, sha, [okRun], '2'.repeat(40));
  refused('a head that moved after the check', 'moved after the check');
  wf(`${t.st}/view.json`, 'not json');
  refused('an unparseable answer', 'not parseable JSON');
  wf(`${t.st}/fail`, '');
  refused('gh failing', 'gh pr view 7 failed');
  rmSync(`${t.st}/fail`);
  t.view('OPEN', false, sha, [okRun]);
  refused('--admin', '--admin is never allowed', ['7', '--admin']);
  refused('--auto', '--auto is never allowed', ['7', '--auto']);
  refused('a URL instead of a number', 'a plain number', ['https://github.com/o/r/pull/7']);
  t.done();
});

test('merge: a skipped check passes only when it is not required; a required check missing from the rollup or not passing refuses; no checks at all asks for the local verification', () => {
  const t = setup();
  const skipped = { __typename: 'CheckRun', name: 'visual', status: 'COMPLETED', conclusion: 'SKIPPED' };
  t.view('OPEN', false, sha, [okRun, skipped]);
  assert.equal(t.merge(['7']).code, 0, 'a skipped check that is not required');
  rmSync(`${t.st}/merge.log`);
  wf(`${t.st}/required.json`, JSON.stringify([{ name: 'static', bucket: 'pass' }, { name: 'visual', bucket: 'skipping' }]));
  let r = t.merge(['7']);
  assert.notEqual(r.code, 0);
  assert.ok(r.text.includes('visual (skipping)'), r.text);
  wf(`${t.st}/required.json`, JSON.stringify([{ name: 'static', bucket: 'pass' }, { name: 'selftest', bucket: 'pass' }]));
  r = t.merge(['7']);
  assert.ok(r.text.includes('missing from the rollup'), r.text);
  assert.equal(t.merged(), '');
  // no checks at all: the local verification decides, and without a build record script there is nothing to verify with
  rmSync(`${t.st}/required.json`);
  t.view('OPEN', false, sha, []);
  r = t.merge(['7']);
  assert.notEqual(r.code, 0);
  assert.ok(r.text.includes('has no checks') && r.text.includes('not in this clone'), r.text);
  assert.equal(t.merged(), '');
  t.done();
});

test('merge: a gh in a temporary folder, in the working directory or behind an empty or relative PATH entry is refused; a missing gh and a platform without a tool say that the user merges', () => {
  const t = setup();
  t.view('OPEN', false, sha, [okRun]);
  const shadow = tempDir('mg-shadow-');
  // a planted gh: a shell script off Windows; there only a real gh.exe is a program the resolver considers, so the refusal is not vacuous
  const plant = (/** @type {string} */ dir) => {
    if (process.platform === 'win32') nodeFake(dir, 'gh', `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(`${t.st}/merge.log`)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    else { wf(`${dir}/gh`, `#!/bin/sh\necho "$*" >> "${t.st}/merge.log"\n`); chmodSync(`${dir}/gh`, 0o755); }
  };
  const sys = minimal;
  plant(shadow);
  let r = t.merge(['7'], joinPath(shadow, sys));
  assert.notEqual(r.code, 0);
  // Windows: a gh.exe in a temporary folder is not found at all (the resolver skips such a folder), which refuses just the same; POSIX names the shadow
  const SHADOW = process.platform === 'win32' ? /possibly shadowed gh|gh is not installed or not on PATH/ : /possibly shadowed gh/;
  assert.match(r.text, SHADOW);
  assert.equal(t.merged(), '', 'the shadow gh ran');
  plant(t.proj);
  r = t.merge(['7'], joinPath(t.proj, sys));
  assert.match(r.text, SHADOW);
  assert.notEqual(r.code, 0);
  // an EMPTY entry is refused by the POSIX rule; the Windows resolver never searches one (fail closed there: the entry is skipped, shadowingEntry)
  if (process.platform !== 'win32') {
    r = t.merge(['7'], `${t.bin}${D}${D}${sys}`);
    assert.ok(r.text.includes('empty or relative entry'), r.text);
  }
  r = t.merge(['7'], `${t.bin}${D}.${D}${sys}`);
  assert.ok(r.text.includes('empty or relative entry'), r.text);
  assert.equal(t.merged(), '');
  r = t.merge(['7'], sys);
  assert.ok(r.text.includes('NOT MERGED') && r.text.includes('(gh) is not installed or not on PATH'), r.text); // a GitHub origin and no gh: the user merges
  run(t.proj, 'git', ['remote', 'set-url', 'origin', 'https://bitbucket.org/acme/app.git']);
  r = t.merge(['7']);
  assert.notEqual(r.code, 0);
  assert.ok(r.text.includes('NOT MERGED') && r.text.includes('YOU merge it') && r.text.includes('manual steps'), r.text);
  assert.equal(t.merged(), '');
  t.done();
  rmSync(shadow, { recursive: true, force: true });
});

test('SECURITY (A220): "no required checks" counts only as gh\'s own whole sentence; the same words inside a transport error (a proxy reason phrase) refuse the merge', () => {
  const t = setup();
  t.view('OPEN', false, sha, [okRun, okCtx]);
  // what gh prints behind a proxy that answers CONNECT with the reason phrase "no required checks"
  for (const msg of ['Post "https://api.github.com/graphql": no required checks', 'no required checks', 'no required checks reported', "no required checks reported on the 'main' branch and more", 'x: no required checks reported on the \'main\' branch']) {
    wf(`${t.st}/proxyerr`, `${msg}\n`);
    const r = t.merge(['7']);
    assert.notEqual(r.code, 0, `${msg}: merged`);
    assert.equal(t.merged(), '', `${msg}: gh pr merge ran`);
    assert.match(r.text, /gh pr checks --required failed, so the required checks cannot be judged/, msg);
  }
  // gh's genuine sentence still means "nothing is required"
  wf(`${t.st}/proxyerr`, "no required checks reported on the 'feat/x' branch\n");
  const ok = t.merge(['7']);
  assert.equal(ok.code, 0, ok.text);
  assert.match(t.merged(), /pr merge 7/);
  t.done();
});
