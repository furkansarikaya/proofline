// @ts-check
// The merge guard of the Node hook (guards/merge.mjs) against a table of commands (the lists of tests/enforcement/merge-guard-test.sh) and, for the
// same table, against the shell hook's own merge guard: the verdict and the reason text must be the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanCommand } from '../../adapters/claude/hooks/command-scan.mjs';
import { mergeGuard } from '../../adapters/claude/hooks/guards/merge.mjs';
import { Deny } from '../../adapters/claude/hooks/guards/kit.mjs';
import { runHook } from './harness.mjs';

const base = mkdtempSync(join(tmpdir(), 'merge-guard-'));
process.on('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* gone */ } });

/** A repository whose HEAD names BRANCH (unborn: the guard reads only HEAD). @param {string} name @param {string} branch */
function repo(name, branch) {
  const dir = join(base, name);
  mkdirSync(dir);
  const r = spawnSync('git', ['-c', 'gc.auto=0', 'init', '-q', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(dir, '.git/HEAD'), `ref: refs/heads/${branch}\n`);
  return dir;
}
const onMain = repo('onmain', 'main');
const onFeat = repo('onfeat', 'feat/x');
const other = repo('other', 'main');

/** @type {Array<[string, string[], string[]]>} repository, commands denied, commands allowed */
const groups = [
  [onFeat, [
    'gh pr merge 7', 'gh pr merge 7 --squash --delete-branch', 'gh pr merge 7 --admin', 'gh pr merge --auto --squash 7', 'gh -R o/r pr merge 7',
    'gh pr -R o/r merge 7', 'GH_TOKEN=x gh pr merge 7', 'env gh pr merge 7', 'command gh pr merge 7', '/opt/homebrew/bin/gh pr merge 7', 'gh pr merge 7 &',
    'cd . && gh pr merge 7', 'echo ok; gh pr merge 7', 'sh -c "gh pr merge 7"', "bash -lc 'gh pr merge 7 --admin'", 'sh -c "sh -c \\"gh pr merge 7\\""',
    'gh "pr" merge 7', "gh p''r merge 7", 'xargs gh pr merge < prs', 'ssh host gh pr merge 7', 'sudo gh pr merge 7', 'timeout 9 gh pr merge 7',
    'nohup gh pr merge 7', '$GH pr merge 7', 'gh pr merge 7 | cat', 'echo 7 | xargs -I{} gh pr merge {}',
    'gh api -X PUT repos/o/r/pulls/7/merge', 'gh api repos/o/r/pulls/7/merge -f merge_method=squash', 'gh api --method PUT /repos/o/r/pulls/7/merge',
    'gh api repos/o/r/merges -f base=main -f head=x', 'gh api graphql -f query="mutation{mergePullRequest(input:{pullRequestId:\\"x\\"}){clientMutationId}}"',
    'gh api graphql -f query="mutation{enablePullRequestAutoMerge(input:{})}"', 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', 'gh alias set m "pr merge"',
    'git push origin main', 'git push origin HEAD:main', 'git push origin feat/x:refs/heads/main', 'git push origin +main', 'git push --force origin main', 'git push origin refs/heads/main',
    'git push --all', 'git push --mirror origin', 'git push origin $BR', 'git push origin "$(git branch --show-current)"', 'git -C . push origin master',
    'git checkout main && git merge feat/x', 'git switch main; git merge feat/x', 'git update-ref refs/heads/main abc',
    'git push -o -n origin main', 'git push origin main -o -n', 'git push --push-option -n origin main', 'git push --push-option=x origin main', 'git push --repo=origin main', 'git push --repo origin main',
    'git push --receive-pack -n origin main',
    'm=merge; gh pr $m 7', 'gh pr "$M" 7', 'gh pr $(echo merge) 7', 'gh $SUB merge 7', 'gh pr `echo merge` 7', "gh pr '$M' 7", 'gh -R o/r pr $m 7', 'gh api $EP',
    'curl -X PUT https://api.github.com/repos/o/r/pulls/7/merge', 'wget --method=PUT https://api.github.com/repos/o/r/pulls/7/merge', 'http PUT api.github.com/repos/o/r/pulls/7/merge',
    'xh PUT https://api.github.com/repos/o/r/git/refs/heads/main sha=abc', 'curl -d @q https://api.github.com/graphql', 'curl -X PUT https://api.github.com/repos/o/r/contents/f',
    'gh api graphql -F query=@q.graphql', 'gh api graphql --input q.json', 'gh api graphql -f query="mutation{x}"', 'gh api -X PUT repos/o/r/contents/README.md -f message=m -f content=Zg==',
    'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc', 'gh api -X PATCH repos/o/r/git/refs/heads/$B -f sha=abc',
    'echo gh pr merge 7 | sh', 'echo "gh pr merge 7" | bash -s', 'sh <<EOF\ngh pr merge 7\nEOF', 'bash <<< "gh pr merge 7"', 'python3 -c "import os; os.system(\\"gh pr merge 7\\")"',
    'node -e "require(\\"child_process\\").execSync(\\"gh pr merge 7\\")"', 'awk "BEGIN{system(\\"gh pr merge 7\\")}"', 'eval "gh pr merge 7"', "git -c alias.m='!gh pr merge 7' m",
    'echo git push origin main | sh', 'perl -e "system q(gh pr merge 7)"',
    'env GIT_DIR=$PWD/.git git merge x', 'GIT_WORK_TREE=. git merge x', 'env -C . git merge x', 'cd - && git merge x', 'cd $B && git merge x', `cd ${other} && git merge x`, `cd ${other} | cat; git merge x`,
    'PATH=/tmp/fake:$PATH gh pr view 7', 'export PATH=/tmp/x:$PATH; proofline merge 7', 'env PATH=/tmp/x proofline merge 7', 'PROOFLINE_SELFTEST=1 proofline merge 7',
    'git branch -f main feat/x', 'git branch -M feat/x main', 'git fetch . feat/x:main', 'git fetch origin +feat/x:refs/heads/main',
    'git checkout -B main feat/x', 'git switch -C main feat/x', 'git checkout -fB main feat/x', 'git checkout -Bmain feat/x', 'git switch -fC main feat/x', 'git switch --force-create main feat/x',
    'git branch -fq main feat/x', 'git branch -Mf feat/x main', 'git branch -qf main feat/x',
    'git checkout main && git reset --hard feat/x', 'git switch main; git reset --hard feat/x', 'git checkout main && git cherry-pick abc', 'git switch main && git rebase feat/x',
    'git checkout main && git am p.patch', 'git switch main; git revert abc', 'git checkout main && git pull . feat/x', 'git switch main && git pull ../other feat/x',
    '(git checkout main) && git reset --hard x', 'git checkout "main" && git reset --hard x', "git checkout 'main' && git reset --hard x", 'git checkout refs/heads/main && git reset --hard x',
    'git checkout $B && git reset --hard x', 'B=main; git checkout $B && git reset --hard x', 'git switch `echo main` && git reset --hard x', '{ git checkout main; } && git cherry-pick abc',
    'git checkout main && git merge feat/x', '(git checkout main) && git merge feat/x',
    // az, glab and more spellings of the other platforms (A180)
    'glab mr merge 7', 'az repos pr update --id 7 --status completed', 'az repos pr update --id 7 --auto-complete true', 'az repos pr create --bypass-policy true', 'glab alias set m "mr merge"',
    'az rest --method patch --uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/7', 'curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/7/merge',
    'GH pr MERGE 7', 'glab api projects/1/merge_requests/7/merge -X PUT',
  ], [
    'proofline merge 7', 'sh bin/proofline merge 7 --squash', 'git push -n origin main', 'git push --dry-run', 'git push -u origin feat/x', 'git push origin feat/x', 'git push', 'git merge main',
    'git merge --abort', 'git status', 'git push -n -o -n origin main', 'git push -o ci.skip origin feat/x', 'git push origin feat/x -o x', 'git push --push-option=x origin feat/x',
    'gh pr create --title t --body "$(cat f)"', 'gh pr view $N --json state', 'gh api repos/o/r/pulls/7/comments', 'curl -s https://example.com', 'curl -s https://api.github.com/repos/o/r/pulls/7',
    'gh api repos/$O/$R/pulls/7', 'cd . && git push origin feat/x', 'echo hello | sh', 'python3 -c "print(1)"', 'PATH=/usr/bin ls', 'export FOO=1',
    'gh pr view 7 --json statusCheckRollup', 'gh pr checks 7', 'gh pr create --title t --body b', 'gh pr list', 'gh api repos/o/r/pulls/7', 'gh api repos/o/r/commits/abc/check-runs',
    'git commit -m "docs: gh pr merge goes through the wrapper"', 'echo gh pr merge 7', 'grep -rn "pr merge" docs', 'git log --oneline', 'git merge-base main HEAD', 'git fetch origin main',
    'git pull --ff-only origin main',
    'git branch -f feat/y HEAD', 'git branch -d feat/y', 'git fetch origin main', 'git fetch . main:feat/z',
    'git checkout feat/x', 'git checkout -b feat/z', 'git checkout -B feat/z main', 'git switch feat/x', 'git switch -c feat/z', 'git switch -C feat/z main', 'git branch -fq feat/y HEAD', 'git branch -dq feat/y',
    'git checkout main', 'git switch main', 'git checkout feat/x && git reset --hard feat/y', 'git checkout feat/x && git cherry-pick abc',
    'git checkout feat/main-menu && git reset --hard x', 'git checkout main2 && git reset --hard x', 'git checkout origin/main && git reset --hard x',
    'az repos pr list', 'az repos pr show --id 7', 'glab mr view 7', 'glab mr list',
  ]],
  [onMain, [
    'git push', 'git push origin', 'git push -u origin', 'git push origin HEAD', 'git merge feat/x', 'git merge --no-ff feat/x', 'git -C . merge x', 'cd . && git merge x',
    'git reset --hard feat/x', 'git cherry-pick abc', 'git rebase feat/x', 'git pull . feat/x', 'git pull ../other feat/x',
  ], [
    'git reset HEAD f', 'git reset --hard HEAD~1', 'git pull --ff-only origin main', 'git rebase --abort', 'git status', 'git push -n origin main',
  ]],
];

/** @param {string} dir @param {string} cmd */
async function mine(dir, cmd) {
  const env = { ...process.env };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const ctx = /** @type {any} */ ({
    ev: 'pretool', cwd: dir, root: dir, env, act: '', installed: false,
    agent: async () => ({ status: 0, stdout: '', stderr: '' }), agents: { proc: async () => null },
  });
  try { await mergeGuard(ctx, cmd, scanCommand(cmd)); return null; } catch (e) { if (e instanceof Deny) return e.reason; throw e; }
}

test('the merge guard denies every direct merge path and allows the wrapper and read-only commands', async () => {
  let n = 0;
  for (const [dir, denied, allowed] of groups) {
    for (const c of denied) { const r = await mine(dir, c); assert.ok(r !== null, `not denied: ${c}`); assert.ok(r.includes('proofline merge'), c); n++; }
    for (const c of allowed) { assert.equal(await mine(dir, c), null, `denied: ${c}`); n++; }
  }
  assert.ok(n > 200);
});

test('the same table gives the shell hook\'s verdict and reason (differential)', { timeout: 280000 }, async () => {
  /** @type {Array<[string, string, boolean]>} */
  const all = [];
  for (const [dir, denied, allowed] of groups) { for (const c of denied) all.push([dir, c, true]); for (const c of allowed) all.push([dir, c, false]); }
  const bad = [];
  for (let i = 0; i < all.length; i += 12) {
    await Promise.all(all.slice(i, i + 12).map(async ([dir, cmd, want]) => {
      const r = await runHook('sh', dir, 'pretool', { tool_name: 'Bash', tool_input: { command: cmd } });
      const m = /"permissionDecisionReason":"((?:[^"\\]|\\.)*)"/.exec(r.stdout);
      const mineReason = await mine(dir, cmd);
      if ((m !== null) !== (mineReason !== null) || (m !== null) !== want) { bad.push(`${cmd}: shell=${m ? 'deny' : 'allow'} node=${mineReason ? 'deny' : 'allow'} expected=${want ? 'deny' : 'allow'}`); return; }
      if (m && mineReason !== null) {
        const sh = JSON.parse(`"${m[1]}"`);
        if (!sh.startsWith(`proofline: ${mineReason}`)) bad.push(`${cmd}: reason differs\n  shell: ${sh}\n  node:  ${mineReason}`);
      }
    }));
  }
  assert.deepEqual(bad, []);
});

void resolve;
