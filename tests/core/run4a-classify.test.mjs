// @ts-check
// Stage 4, package 4A: `classify`, `tier`, `branch` and `baseline` as absolute Node tests (A212). They replace the behaviour of gates-test.sh
// sc_tier, sc_tier_paths, sc_class_floor and of the task-branch and baseline parts of controls-test.sh sc_branch (tests/legacy-port-map.tsv).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { A, accepted, project, read, refused } from './legacy-lib.mjs';
import { cleanEnv } from '../hook/harness.mjs';

const MANUAL = 'scaffold standalone no STANDARD manual; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null';
const tierOf = (/** @type {string} */ d, /** @type {string} */ role = 'lead') => A(d, ['tier', 'LC'], { role }).out.trim();
const runValue = (/** @type {string} */ d, /** @type {string} */ s, /** @type {string} */ k, /** @type {string} */ id = 'LC') => {
  const m = new RegExp(`^${s}:\\n(?:  .*\\n)*?  ${k}: "?([^"\\n]*)"?$`, 'm').exec(read(d, `.agents/runs/${id}/RUN.yaml`));
  return m ? m[1] : '';
};
const git = (/** @type {string} */ d, /** @type {string[]} */ ...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' }).stdout.trim();

test('tier: docs, code-like markdown, risky path; a non-lead never records; the tier never decreases; the ledger names every raise', () => {
  const d = project(MANUAL);
  assert.equal(tierOf(d), 'docs', 'no change is not tier docs');
  writeFileSync(`${d}/notes.md`, 'notes\n'); mkdirSync(`${d}/docs`, { recursive: true }); writeFileSync(`${d}/docs/guide.txt`, 'guide\n');
  assert.equal(tierOf(d), 'docs', 'plain documentation is not tier docs');
  rmSync(`${d}/notes.md`); rmSync(`${d}/docs`, { recursive: true });
  mkdirSync(`${d}/skills/x`, { recursive: true }); writeFileSync(`${d}/skills/x/SKILL.md`, 'a skill\n');
  assert.equal(tierOf(d, 'reviewer'), 'small', 'code-like markdown is not tier small');
  assert.equal(runValue(d, 'pipeline', 'tier'), 'docs', 'a non-lead role recorded the tier');
  assert.equal(tierOf(d), 'small');
  assert.equal(runValue(d, 'pipeline', 'tier'), 'small');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=tier role=lead from=docs to=small .* detail=effective tier$/m);
  rmSync(`${d}/skills`, { recursive: true });
  assert.equal(tierOf(d), 'small', 'the tier decreased');
  writeFileSync(`${d}/package.json`, '{}\n');
  assert.equal(tierOf(d), 'full', 'a risky path is not tier full');
  rmSync(`${d}/package.json`);
  assert.equal(tierOf(d), 'full', 'the tier decreased from full');
});

test('tier: size limits of code files, docs only by extension, dependency manifests are full', () => {
  const d = project(MANUAL);
  const t = (/** @type {string} */ p, /** @type {string} */ want) => {
    mkdirSync(`${d}/${p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'}`, { recursive: true });
    writeFileSync(`${d}/${p}`, 'x = 1\n');
    const got = tierOf(d, 'reviewer');
    rmSync(`${d}/${p}`);
    assert.equal(got, want, `tier of ${p}`);
  };
  for (const p of ['docs/guide.adoc', 'notes.mdx', 'docs/api.rst', 'guide.txt']) t(p, 'docs');
  for (const p of ['docs/conf.py', 'docs/build.sh', 'docs/index.html', 'skills/x/SKILL.md', 'AGENTS.md']) t(p, 'small');
  for (const p of ['requirements.txt', 'requirements-dev.txt', 'CMakeLists.txt', 'docs/requirements.txt']) t(p, 'full');
  const lines = (/** @type {string} */ f, /** @type {number} */ n) => writeFileSync(`${d}/${f}`, Array.from({ length: n }, (_, i) => `line ${i}\n`).join(''));
  lines('app.go', 10); lines('util.go', 10);
  assert.equal(tierOf(d, 'reviewer'), 'small', 'two code files, 20 lines are not tier small');
  writeFileSync(`${d}/extra.go`, 'package x\n');
  assert.equal(tierOf(d, 'reviewer'), 'full', 'three code files are not tier full');
  rmSync(`${d}/extra.go`); lines('util.go', 21);
  assert.equal(tierOf(d, 'reviewer'), 'full', '31 changed lines of code are not tier full');
});

test('tier: a run that is not classified is refused; a missing id is the usage error', () => {
  const d = project('new_repo; mkdir -p .agents/runs/LC; printf "# Task: LC\\n" > .agents/runs/LC/TASK.md; printf "task:\\n  id: LC\\npipeline:\\n  classification: PENDING\\n" > .agents/runs/LC/RUN.yaml');
  refused(A(d, ['tier', 'LC']), 'tier of an unclassified run', 'run LC is not classified yet');
  refused(A(d, ['tier']), 'tier without an id', 'mandatory argument');
});

const NEW_RUN = (/** @type {string} */ taskExtra = '', /** @type {string} */ plan = '') => `new_repo; RID=LC; d=.agents/runs/LC; mkdir -p $d tasks; printf 'LC\\n' > .agents/local/ACTIVE_RUN
printf '# Task: LC — lookup\\n\\n## Acceptance criteria\\n\\n- AC-1: x\\n${taskExtra}' > $d/TASK.md
printf '# Plan\\n\\n## Assumptions\\n\\nnone\\n${plan}' > $d/PLAN.md
sed 's/<TASK-ID>/LC/; s#<REPOSITORY-RELATIVE-TASK-FILE.md>#tasks/LC.md#' .agents/templates/RUN.yaml > $d/RUN.yaml
printf '# LC task\\n' > tasks/LC.md; git add -A; git commit -qm base`;

test('classify: unknown class, the review option, the floor of the task\'s Suggested class, the ledger row, the autonomy in the answer', () => {
  const d = project(NEW_RUN('\\n## Suggested class\\n\\nSTANDARD — one module\\n'));
  refused(A(d, ['classify', 'LC', 'EPIC']), 'an unknown class', 'invalid classification: EPIC');
  refused(A(d, ['classify', 'LC', 'TRIVIAL']), 'a class below the suggested class', 'suggests STANDARD and TRIVIAL is lower');
  refused(A(d, ['classify', 'LC', 'COMPLEX', 'review']), 'the review option on a class that fixes review', 'fixes review=');
  refused(A(d, ['classify', 'LC', 'STANDARD', 'strict']), 'an unknown option', 'unknown option: strict');
  refused(A(d, ['classify', 'LC', 'STANDARD'], { role: 'reviewer' }), 'a non-lead classified', 'command denied for reviewer: classify');
  const r = accepted(A(d, ['classify', 'LC', 'STANDARD', 'review']), 'the suggested class with the review option');
  assert.match(r.out, /^classified: LC STANDARD \(autonomy: (supervised|autonomous)\)$/m);
  assert.equal(runValue(d, 'pipeline', 'classification'), 'STANDARD');
  assert.equal(runValue(d, 'pipeline', 'review'), 'yes');
  assert.match(read(d, '.agents/runs/LC/LEDGER.log'), / event=classify role=lead from=PLANNED to=PLANNED .* detail=STANDARD review=yes$/m);
  accepted(A(d, ['classify', 'LC', 'COMPLEX']), 'a higher class');
  assert.equal(runValue(d, 'pipeline', 'review'), 'yes', 'COMPLEX fixes review');
});

test('classify: a bug or a refactor is never TRIVIAL, an unreadable type is refused, a destructive plan is CRITICAL, a completed run is not reclassified', () => {
  const bug = project(NEW_RUN('', ''));
  writeFileSync(`${bug}/.agents/runs/LC/TASK.md`, '# Task: LC — lookup\n\n---\ntype: bug\n---\n\n## Acceptance criteria\n\n- AC-1: x\n');
  refused(A(bug, ['classify', 'LC', 'TRIVIAL']), 'TRIVIAL for a bug', 'typed bug and TRIVIAL covers text and configuration only');
  accepted(A(bug, ['classify', 'LC', 'STANDARD']), 'STANDARD for a bug');
  writeFileSync(`${bug}/.agents/runs/LC/TASK.md`, '# Task: LC — lookup\n\n---\ntype: epic\n---\n\n## Acceptance criteria\n\n- AC-1: x\n');
  refused(A(bug, ['classify', 'LC', 'STANDARD']), 'an unreadable type', 'task type in');
  const destructive = project(NEW_RUN('', '\\n## Data\\n\\ndestructive: yes\\n'));
  refused(A(destructive, ['classify', 'LC', 'COMPLEX']), 'a destructive plan below CRITICAL', 'the class is CRITICAL');
  accepted(A(destructive, ['classify', 'LC', 'CRITICAL']), 'CRITICAL for a destructive plan');
  const done = project('scaffold standalone; to_code_done standalone');
  refused(A(done, ['classify', 'LC', 'TRIVIAL']), 'a completed run was reclassified', 'cannot reclassify a completed run');
});

test('classify: the pipeline of every class, STANDARD review opt-in sets the small floor, CRITICAL is tier full, a reclassification after the freeze breaks verify-freeze', () => {
  const d = project('scaffold standalone no STANDARD');
  refused(A(d, ['classify', 'LC', 'COMPLEX', 'review']), 'the review option on a class that fixes review');
  accepted(A(d, ['classify', 'LC', 'STANDARD', 'review']), 'STANDARD review');
  refused(A(d, ['verify-freeze', 'LC']), 'a reclassification after freeze passed verify-freeze', 'freeze mismatch: pipeline');
  assert.equal(tierOf(d), 'small', 'STANDARD review opt-in did not set the small tier floor');
  accepted(A(d, ['classify', 'LC', 'CRITICAL']), 'CRITICAL');
  assert.equal(tierOf(d), 'full', 'CRITICAL is not tier full');
  assert.match(A(d, ['pipeline', 'LC']).out, /^max_explorers=3$/m);
});

const BRANCH_RUN = `new_repo; mkdir -p tasks .agents/runs/BR; d=.agents/runs/BR; printf 'BR\\n' > .agents/local/ACTIVE_RUN
printf '# Task: BR\\n\\n## Acceptance criteria\\n\\n- AC-1: behaviour\\n' > $d/TASK.md
printf -- '---\\nscope:\\n  - path: authorized.txt\\n    criteria: [AC-1]\\n---\\n# Plan\\n## Assumptions\\nnone\\n## Behavior\\nunchanged\\n' > $d/PLAN.md
printf '%s\\n' 'task:' '  id: BR' 'repository:' '  base_sha: PENDING' '  canonical_branch: PENDING' '  task_branch: PENDING' 'task_source:' '  type: local_markdown' '  path: tasks/BR-sample-feature.md' '  revision: PENDING' 'execution:' '  mode: deterministic' '  state: PLANNING' '  knowledge_state: not_started' '  knowledge_reason: ""' '  topology: standalone' 'baseline:' '  status: pending' 'handoff:' '  state: PLANNED' '  implemented_patch_sha256: PENDING' '  code_done_patch_sha256: PENDING' 'lifecycle_gates:' '  required: true' 'pipeline:' '  classification: STANDARD' '  review: no' '  tier: PENDING' > $d/RUN.yaml
: > authorized.txt; printf '# sample feature\\n' > tasks/BR-sample-feature.md; git add -A; git commit -qm baseline`;

test('branch: from the canonical tip, named from the task file, resumed not duplicated; baseline only after it; no branch for a non-lead', () => {
  const d = project(BRANCH_RUN);
  const tip = git(d, 'rev-parse', 'HEAD');
  refused(A(d, ['baseline', 'BR']), 'baseline before branch', 'task branch not established for BR');
  refused(A(d, ['branch', 'BR'], { role: 'implementer' }), 'an implementer created the branch', 'command denied for implementer: branch');
  assert.match(accepted(A(d, ['branch', 'BR']), 'branch').out, /^task branch established: BR proofline\/BR-sample-feature$/m);
  assert.equal(git(d, 'branch', '--show-current'), 'proofline/BR-sample-feature');
  assert.equal(git(d, 'rev-parse', 'proofline/BR-sample-feature'), tip);
  assert.equal(runValue(d, 'repository', 'canonical_branch', 'BR'), 'main');
  assert.match(accepted(A(d, ['branch', 'BR']), 'branch again').out, /^task branch resumed: BR proofline\/BR-sample-feature$/m);
  assert.equal(git(d, 'branch', '--list', 'proofline/BR-*').split('\n').length, 1);
  git(d, 'checkout', '-q', 'main');
  assert.match(accepted(A(d, ['branch', 'BR']), 'resume from the canonical branch').out, /task branch resumed/);
  assert.equal(git(d, 'branch', '--show-current'), 'proofline/BR-sample-feature');
  git(d, 'checkout', '-q', '-b', 'random-feature');
  refused(A(d, ['branch', 'BR']), 'resumed from an unexpected branch', 'cannot resume BR: on unexpected branch random-feature');
  git(d, 'checkout', '-q', 'proofline/BR-sample-feature'); git(d, 'branch', '-D', 'random-feature');
});

test('branch: an existing same-named branch at another tip is never reused; a detached HEAD, a missing recorded branch and a wrong start are refused', () => {
  const d = project(BRANCH_RUN);
  const b = git(d, 'rev-parse', 'HEAD');
  git(d, 'branch', 'proofline/BR-sample-feature', b);
  writeFileSync(`${d}/authorized.txt`, 'v2\n'); git(d, 'add', 'authorized.txt'); git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'advance');
  refused(A(d, ['branch', 'BR']), 'a conflicting branch was reused', 'will not reuse or overwrite');
  assert.equal(git(d, 'rev-parse', 'proofline/BR-sample-feature'), b);
  assert.equal(git(d, 'branch', '--show-current'), 'main');
  git(d, 'checkout', '-q', '--detach', 'HEAD');
  refused(A(d, ['branch', 'BR']), 'a detached HEAD', 'not detached HEAD');
  git(d, 'checkout', '-q', 'main'); git(d, 'checkout', '-q', '-b', 'other');
  refused(A(d, ['branch', 'BR']), 'branch from another branch', 'must start from canonical branch (main); currently on: other');
});

test('branch: a task worktree is made detached at the canonical tip and counts as standing on the canonical branch (A169); the main tree stays where it is', () => {
  const d = project(BRANCH_RUN);
  const wt = `${d}/.agents/local/worktrees/BR`;
  git(d, 'worktree', 'add', '-q', '--detach', wt);
  cpSync(`${d}/.agents/runs/BR`, `${wt}/.agents/runs/BR`, { recursive: true });
  mkdirSync(`${wt}/.agents/local/locks`, { recursive: true }); mkdirSync(`${d}/.agents/local/locks`, { recursive: true });
  const r = spawnSync('sh', ['.agents/scripts/agent.sh', 'branch', 'BR'], { cwd: wt, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.stdout, 'task branch established: BR proofline/BR-sample-feature\n');
  assert.equal(git(wt, 'branch', '--show-current'), 'proofline/BR-sample-feature');
  assert.equal(git(d, 'branch', '--show-current'), 'main', 'the main working tree moved');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(d, 'rev-parse', 'main'));
  const again = spawnSync('sh', ['.agents/scripts/agent.sh', 'branch', 'BR'], { cwd: wt, env: cleanEnv(), encoding: 'utf8' });
  assert.equal(again.stdout, 'task branch resumed: BR proofline/BR-sample-feature\n');
});

test('branch: the slug falls back to the task title when the file is named only by its id, and is ASCII', () => {
  const d = project(BRANCH_RUN);
  writeFileSync(`${d}/.agents/runs/BR/TASK.md`, '# Task: BR — Çalışma Şeması ıı\n\n## Acceptance criteria\n\n- AC-1: x\n');
  git(d, 'mv', 'tasks/BR-sample-feature.md', 'tasks/BR.md');
  const y = read(d, '.agents/runs/BR/RUN.yaml').replace('tasks/BR-sample-feature.md', 'tasks/BR.md');
  writeFileSync(`${d}/.agents/runs/BR/RUN.yaml`, y);
  accepted(A(d, ['branch', 'BR']), 'branch');
  assert.equal(git(d, 'branch', '--show-current'), 'proofline/BR-calisma-semasi-ii');
});

test('baseline: records the base sha and every changed or untracked path with its hash, once, lead only, and refuses a symlink', () => {
  const d = project(BRANCH_RUN);
  accepted(A(d, ['branch', 'BR']), 'branch');
  writeFileSync(`${d}/user-untracked.txt`, 'u\n'); writeFileSync(`${d}/authorized.txt`, 'dirty\n');
  refused(A(d, ['baseline', 'BR'], { role: 'reviewer' }), 'a reviewer recorded a baseline', 'command denied for reviewer: baseline');
  assert.equal(accepted(A(d, ['baseline', 'BR']), 'baseline').out, 'baseline recorded: BR\n');
  const y = read(d, '.agents/runs/BR/RUN.yaml');
  assert.match(y, new RegExp(`^  base_sha: "${git(d, 'rev-parse', 'HEAD')}"$`, 'm'));
  assert.match(y, /\nbaseline:\n  status: captured\n  tracked:\n    - path: authorized.txt\n      sha256: "[0-9a-f]{64}"\n  untracked:\n/);
  assert.match(y, /\n    - path: user-untracked.txt\n      sha256: "[0-9a-f]{64}"\n$/);
  refused(A(d, ['baseline', 'BR']), 'a second baseline', 'baseline already exists for BR; refusing to overwrite');
  const l = project(BRANCH_RUN);
  accepted(A(l, ['branch', 'BR']), 'branch');
  spawnSync('ln', ['-s', 'authorized.txt', `${l}/link.txt`]);
  refused(A(l, ['baseline', 'BR']), 'a symlink was baselined', 'cannot baseline symlink: link.txt');
  assert.doesNotMatch(read(l, '.agents/runs/BR/RUN.yaml'), /status: captured/, 'a refused baseline was written');
});

test('baseline: refused on a CODE_DONE run and on the wrong branch', () => {
  const done = project('scaffold standalone; to_code_done standalone');
  refused(A(done, ['baseline', 'LC']), 'a baseline for CODE_DONE', 'cannot record a baseline for CODE_DONE run');
  const d = project(BRANCH_RUN);
  accepted(A(d, ['branch', 'BR']), 'branch');
  git(d, 'checkout', '-q', 'main');
  refused(A(d, ['baseline', 'BR']), 'baseline on the wrong branch', 'wrong git branch for BR');
});
