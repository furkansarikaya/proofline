// @ts-check
// C9 of issue 338 (A363): the PreToolUse hook reads here-document bodies as data, judges a write target by what it resolves to (`..` and links), and lets the lead bring a local
// protected branch up to the remote with `git merge --ff-only <remote>/<branch>` (and nothing else of `git merge` on it).
// Rows are deny and allow in pairs: every relaxation has the neighbour that must stay denied.
import { tempDir } from '../lib/tempdir.mjs';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanCommand } from '../../adapters/claude/hooks/command-scan.mjs';
import { mergeGuard } from '../../adapters/claude/hooks/guards/merge.mjs';
import { Deny } from '../../adapters/claude/hooks/guards/kit.mjs';
import { withoutDataBodies } from '../../adapters/claude/hooks/guards/readonly-git.mjs';
import { buildTemplate, copyProject, runHook } from './harness.mjs';

let template = '';
let base = '';
before(() => { template = buildTemplate(); base = tempDir('hook-erg-'); });
after(() => { rmSync(template, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true }); });

const IMPL = { agent_type: 'proofline-implementer', agent_id: 'a1' };
const REVIEWER = { agent_type: 'proofline-reviewer', agent_id: 'a2' };
const LEAD = {};

/** @param {string} dir @param {object} who @param {string} command */
async function bash(dir, who, command) {
  const r = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...who });
  return /"permissionDecisionReason":"(.*?)"\}/.exec(r.stdout)?.[1] ?? null;
}
/** @param {string} dir @param {object} who @param {string} file_path */
async function write(dir, who, file_path) {
  const r = await runHook('node', dir, 'pretool', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' }, ...who });
  return /"permissionDecisionReason":"(.*?)"\}/.exec(r.stdout)?.[1] ?? null;
}

test('C9a: a here-document body that only holds words is data for a specialist: git, rm and stash in a cat, tee or git commit -F - body are not commands', async () => {
  const d = copyProject(template, base);
  const bodies = ['git push origin main', 'git reset --hard HEAD~1', 'git stash && git merge x && git checkout -- .', 'rm -rf build && git clean -fd'];
  for (const who of [IMPL, REVIEWER]) {
    for (const body of bodies) {
      for (const open of ["cat <<'EOF'", 'cat > .agents/runs/LC/scratch/n.md <<EOF', "git commit -F - <<'EOF'", "tee .agents/runs/LC/scratch/t.md <<'EOF'"]) {
        const why = await bash(d, who, `${open}\n${body}\nEOF`);
        assert.equal(why, null, `${who.agent_type}: ${open} / ${body}: ${why}`);
      }
    }
  }
});

test('C9a: a here-document that feeds a shell, runs a substitution or sits beside a real command is still read as a script', async () => {
  const d = copyProject(template, base);
  const denied = [
    'sh <<EOF\ngit reset --hard\nEOF', 'cat <<EOF | sh\ngit reset --hard\nEOF', 'cat <<EOF\n$(git reset --hard)\nEOF', 'cat <<EOF\n`git stash`\nEOF',
    "cat <<'EOF' > n.md\nnote\nEOF\ngit reset --hard", "cat <<'EOF'\nnote\nEOF\ngit stash", 'bash <<EOF\ngit stash\nEOF', "cat <<'EOF' | bash\ngit merge x\nEOF",
  ];
  for (const c of denied) assert.notEqual(await bash(d, IMPL, c), null, `allowed for the implementer: ${JSON.stringify(c)}`);
  assert.notEqual(await bash(d, REVIEWER, 'sh <<EOF\ngit push origin main\nEOF'), null);
  assert.notEqual(await bash(d, REVIEWER, "cat <<'EOF' | sh\ngit push origin main\nEOF"), null);
  // A363 attack review: the consumer of a body that runs text makes it a script for every caller (the implementer was allowed to pipe a push through xargs sh -c on 27ab7d34)
  const scripts = [
    "cat <<'EOF' | xargs -I{} sh -c {}", "cat <<'EOF' | xargs sh -c", "cat <<'EOF' | xargs -n1 bash -c", "cat <<'EOF' | env xargs sh -c", "cat <<'EOF' | source /dev/stdin", "cat <<'EOF' | . /dev/stdin",
    "cat <<'EOF' | env sh", "cat <<'EOF' | command bash", "cat <<'EOF' | exec sh", "cat <<'EOF' | python3 -c 'x'", "cat <<'EOF' | python3", "cat <<'EOF' | node -e 'x'", "cat <<'EOF' | perl -e 'x'",
    "cat <<'EOF' | ruby -e 'x'", "cat <<'EOF' | eval",
  ];
  for (const open of scripts) {
    for (const who of [IMPL, LEAD]) assert.notEqual(await bash(d, who, `${open}\ngit push origin main\nEOF`), null, `${who.agent_type ?? 'lead'}: ${open}`);
  }
  // the same words as a plain command are denied for the specialist, as before
  assert.notEqual(await bash(d, IMPL, 'git reset --hard'), null);
  assert.notEqual(await bash(d, REVIEWER, 'git stash'), null);
});

test('C9a: withoutDataBodies drops the body of a data consumer only', () => {
  assert.equal(withoutDataBodies("cat <<'EOF'\ngit reset\nEOF"), "cat <<'EOF'\nEOF");
  assert.equal(withoutDataBodies("git commit -F - <<'EOF'\nmsg git stash\nEOF"), "git commit -F - <<'EOF'\nEOF");
  assert.equal(withoutDataBodies("gh pr create --title t --body-file - <<'EOF'\ngit stash\nEOF"), "gh pr create --title t --body-file - <<'EOF'\nEOF");
  assert.equal(withoutDataBodies("python - <<'EOF'\ngit stash\nEOF"), "python - <<'EOF'\ngit stash\nEOF");
  assert.equal(withoutDataBodies("cat <<'EOF' | sh\ngit stash\nEOF"), "cat <<'EOF' | sh\ngit stash\nEOF");
  assert.equal(withoutDataBodies("git commit -m x <<'EOF'\ngit stash\nEOF"), "git commit -m x <<'EOF'\ngit stash\nEOF");
});

test('C9c: a write target is judged by what it resolves to: `..` below a folder that does not exist and links, both directions', async () => {
  const d = copyProject(template, base);
  mkdirSync(join(d, 'docs'), { recursive: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  symlinkSync(join(d, '.agents'), join(d, 'src/lnk'));
  symlinkSync(join(d, '.agents/runs/LC'), join(d, 'docs/runlink'));
  // resolves to an allowed run artifact: allowed (the lead writes PLAN.md of its run)
  for (const p of ['.agents/runs/LC/PLAN.md', 'docs/../.agents/runs/LC/PLAN.md', 'nodir/../.agents/runs/LC/PLAN.md', 'nodir/sub/../../.agents/runs/LC/PLAN.md', 'docs/runlink/PLAN.md', join(d, 'nodir/./../.agents/runs/LC/PLAN.md')]) {
    assert.equal(await write(d, LEAD, p), null, `denied: ${p}`);
  }
  // resolves into a forbidden path: denied
  for (const p of ['.agents/x', 'docs/../.agents/x', 'nodir/../.agents/x', 'nodir/../.agents/runs/LC/gates/x', 'nodir/../.agents/runs/LC/LEDGER.log', 'src/lnk/x', 'docs/runlink/gates/x', 'docs/runlink/LEDGER.log', 'nodir/../src/a.js', 'nodir/../../outside.txt']) {
    assert.notEqual(await write(d, LEAD, p), null, `allowed: ${p}`);
  }
  // a `..` that climbs out of the folder the hook can place stays unplaceable and is denied for the roles that write inside the project only
  assert.notEqual(await write(d, IMPL, 'nodir/../.agents/x'), null);
  assert.notEqual(await write(d, IMPL, 'a/../../x'), null);
});

/** A repository whose HEAD names BRANCH, with the given refs written the way git keeps them. @param {string} name @param {string} branch @param {{ remote?: string[], heads?: string[], tags?: string[], packed?: string }} refs */
function repo(name, branch, refs = {}) {
  const dir = join(base, name);
  mkdirSync(dir);
  assert.equal(spawnSync('git', ['-c', 'gc.auto=0', 'init', '-q', dir], { encoding: 'utf8' }).status, 0);
  writeFileSync(join(dir, '.git/HEAD'), `ref: refs/heads/${branch}\n`);
  const put = (/** @type {string} */ f) => { mkdirSync(join(dir, '.git', f, '..'), { recursive: true }); writeFileSync(join(dir, '.git', f), `${'a'.repeat(40)}\n`); };
  for (const r of refs.remote ?? []) put(`refs/remotes/${r}`);
  for (const r of refs.heads ?? []) put(`refs/heads/${r}`);
  for (const r of refs.tags ?? []) put(`refs/tags/${r}`);
  if (refs.packed) writeFileSync(join(dir, '.git/packed-refs'), refs.packed);
  return dir;
}
/** @param {string} dir @param {string} cmd */
async function mine(dir, cmd) {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const ctx = /** @type {any} */ ({ ev: 'pretool', cwd: dir, root: dir, env, act: '', installed: false, agent: async () => ({ status: 0, stdout: '', stderr: '' }), agents: { proc: async () => null } });
  try { await mergeGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

test('C9b: on a protected branch only `git merge --ff-only <remote>/<protected>` of an existing remote-tracking ref passes; every other merge stays denied (A136)', async () => {
  const onMain = repo('ff-main', 'main', { remote: ['origin/main', 'origin/master', 'upstream/main'] });
  const allowed = [
    'git merge --ff-only origin/main', 'git merge origin/main --ff-only', 'git merge --ff-only refs/remotes/origin/main', 'git merge --ff-only upstream/main', 'git merge --ff-only origin/master',
    `git -C ${onMain} merge --ff-only origin/main`,
  ];
  for (const c of allowed) assert.equal(await mine(onMain, c), null, c);
  const denied = [
    'git merge origin/main', 'git merge --no-ff origin/main', 'git merge --ff-only origin/feat', 'git merge --ff-only feat/x', 'git merge --ff-only origin/main feat/x', 'git merge --ff-only -m x origin/main',
    'git merge --ff-only --squash origin/main', 'git merge --ff-only origin/main -s ours', 'git merge --ff-only main', 'git merge --ff-only origin/../main', 'git merge --ff-only $B', 'git merge --ff-only "$(echo origin/main)"',
    'git merge --ff-only origin/nothere', 'git merge --ff-only heads/main', 'git merge --ff-only refs/heads/main', 'git merge --ff-only tags/main', 'git merge --ff-only -X theirs origin/main',
    'git checkout main && git merge --ff-only origin/main', 'git switch main; git merge --ff-only origin/main', 'git merge --ff-only origin/main && git push origin main', 'git merge --ff-only FETCH_HEAD',
    'GIT_DIR=/x git merge --ff-only origin/main', 'env -C /tmp git merge --ff-only origin/main', 'git merge --ff-only origin/main --no-verify-signatures --strategy=ours',
  ];
  for (const c of denied) {
    const why = await mine(onMain, c);
    assert.ok(why !== null && why.includes('proofline merge'), `not denied: ${c}`);
  }
  // a tag or a local branch of the same name wins over the remote-tracking ref in git's lookup: the operand may then be something else
  const withTag = repo('ff-tag', 'main', { remote: ['origin/main'], tags: ['origin/main'] });
  const withHead = repo('ff-head', 'main', { remote: ['origin/main'], heads: ['origin/main'] });
  const withPacked = repo('ff-packed', 'main', { remote: ['origin/main'], packed: `# pack-refs\n${'b'.repeat(40)} refs/heads/origin/main\n` });
  for (const dir of [withTag, withHead, withPacked]) assert.notEqual(await mine(dir, 'git merge --ff-only origin/main'), null, dir);
  // the remote-tracking ref in packed-refs counts
  const packedOk = repo('ff-packed-ok', 'main', { packed: `# pack-refs\n${'b'.repeat(40)} refs/remotes/origin/main\n` });
  assert.equal(await mine(packedOk, 'git merge --ff-only origin/main'), null);
  // no remote-tracking ref: nothing to fast-forward to, denied
  assert.notEqual(await mine(repo('ff-none', 'main', {}), 'git merge --ff-only origin/main'), null);
  // off the protected branch merges were never denied
  const onFeat = repo('ff-feat', 'feat/x', { remote: ['origin/main'] });
  for (const c of ['git merge --ff-only origin/main', 'git merge feat/y', 'git merge --no-ff origin/main']) assert.equal(await mine(onFeat, c), null, c);
});
