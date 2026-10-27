#!/bin/sh
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents and base come from test-lib.sh
# One-command delivery: deliver-plan shows one summary, the user's one reply "approve delivery" records one approval
# per step, deliver-step checks the shown content and the step's approval before each step. Nothing is pushed and
# gh never runs: a push is simulated by setting the remote-tracking ref, gh is a PATH shim in the test's temp dir
# (accepted only under PROOFLINE_SELFTEST=1, as for proofline merge; there is no env seam naming the gh binary).
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
# the gh shim answers `run list`, `run view` and `pr checks` from files (A169), anything else (pr view) from ghstate
mkdir -p "$base/bin"
printf '#!/bin/sh\ncase "$1 $2" in\n  "run list") cat "%s/gh.runs" ;;\n  "run view") cat "%s/gh.log" ;;\n  "pr checks") cat "%s/gh.checks" ;;\n  *) cat "%s/ghstate" ;;\nesac\n' "$base" "$base" "$base" "$base" > "$base/bin/gh"; chmod +x "$base/bin/gh"
PATH=$base/bin:$PATH PROOFLINE_SELFTEST=1 PROOFLINE_NO_TTY=1; export PATH PROOFLINE_SELFTEST PROOFLINE_NO_TTY
gh_says() { printf '%s %s\n' "$1" "${2:-$(git rev-parse HEAD) proofline/LC-lc main acme}" > "$base/ghstate"; }   # STATE ISDRAFT [HEAD BRANCH BASE OWNER]
S() { A deliver-step LC "$@"; }
# has PATTERN CMD...: CMD succeeds and prints a line matching PATTERN (no pipe into grep -q: SIGPIPE would leave a stale lock)
has() { hs_p=$1; shift; "$@" > "$base/has.out" || die "$* failed: $(cat "$base/has.out")"; grep -q -- "$hs_p" "$base/has.out" || die "$* printed no '$hs_p': $(cat "$base/has.out")"; }
origin() { git remote add origin https://github.com/acme/app.git; }   # never fetched or pushed
hooks() {
  origin; mkdir -p "$base/hooks"; cp "$tl_agents/githooks/pre-commit" "$tl_agents/githooks/pre-push" "$tl_agents/githooks/human.sh" "$base/hooks/"; chmod +x "$base/hooks/pre-commit" "$base/hooks/pre-push"
  git config core.hooksPath "$base/hooks"
}
tasks_in_tasks() { sed 's#^  dir: .agents/tasks#  dir: tasks#' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml; }   # the fixtures keep task files in tasks/
pushed() { git update-ref "refs/remotes/origin/$(git branch --show-current)" HEAD; A approval-consume "$1" push '' "refs/heads/$(git branch --show-current)" >/dev/null; }   # what git push and pre-push do

scenario_normal_chain() {
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; hooks
  has 'not ready to summarize' A deliver-plan LC   # A152: no refusal, no summary, no question
  [ ! -e .agents/local/deliver/LC ] || die "deliver-plan wrote a summary before the knowledge step"
  finish_done
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused a DONE run: $(A deliver-plan LC 2>&1 | tail -1)"
  grep -q '^steps: commit push pr merge cleanup$' "$base/plan.out" && grep -q 'approve delivery' "$base/plan.out" || die "summary: $(cat "$base/plan.out")"
  expect_msg "a step before the user's reply" 'no unconsumed commit approval' S commit
  capture 'approve the commit'; A approve-pending LC >/dev/null
  expect_msg "a reply that is not the delivery approval" 'no unconsumed commit approval' S commit
  capture 'approve delivery'; A approve-pending LC >/dev/null
  for k in commit push pr merge cleanup; do ls .agents/runs/LC/approvals/*-"$k".yaml >/dev/null 2>&1 || die "no $k approval from the one reply"; done
  expect_msg "push before the commit" 'commit first' S push
  has '^run: git commit -F .agents/local/deliver/LC/COMMIT_MSG$' S commit
  A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the approved commit was blocked"
  has '^run: git push -u origin proofline/LC-lc$' S push
  expect_msg "pr before the push" 'push first' S pr
  pushed LC
  S pr > "$base/pr.out"; grep -q '^run: gh pr create --base main --head proofline/LC-lc --title "feat: lookup (LC)"' "$base/pr.out" && ! grep -q -- '--draft' "$base/pr.out" || die "pr step: $(cat "$base/pr.out")"
  gh_says "MERGED false"
  expect_msg "cleanup before the merge step" 'merge step of this delivery did not run' S cleanup 7
  gh_says "OPEN false" "$(git rev-parse HEAD) proofline/LC-lc release acme"
  expect_msg "merge of a pull request into another base" "not this delivery's open" S merge 7
  gh_says "OPEN false" "$(git rev-parse HEAD^) proofline/LC-lc main acme"
  expect_msg "merge of a pull request at another head" "not this delivery's open" S merge 7
  gh_says "OPEN false" "$(git rev-parse HEAD) proofline/LC-lc main forker"
  expect_msg "merge of a fork's pull request with the same head, branch and base" "not this delivery's open" S merge 7
  expect_msg "gh outside PATH rules" 'may be shadowed' env -u PROOFLINE_SELFTEST sh ./.agents/scripts/agent.sh deliver-step LC merge 7
  gh_says "OPEN false"
  has '^run: proofline merge 7$' S merge 7
  # CI red: proofline merge refused, the pull request stays open
  expect_msg "cleanup after a failed merge" "not this delivery's merged" S cleanup 7
  [ -d .agents/runs/LC ] || die "the run went after a failed merge"
  gh_says "MERGED false" "$(git rev-parse HEAD^) proofline/LC-lc main acme"
  expect_msg "cleanup on another merged pull request" "not this delivery's merged" S cleanup 7
  gh_says "MERGED false"
  expect_msg "cleanup naming another pull request number" 'did not run for pull request 8' S cleanup 8
  S cleanup 7 >/dev/null || die "cleanup after the merge refused: $(S cleanup 7 2>&1 | tail -1)"
  [ ! -e .agents/runs/LC ] && [ ! -e .agents/local/deliver/LC ] || die "the run survived the delivery"
  ok "deliver: knowledge first, one reply approves every step, merge only on a ready PR, cleanup only after the merge"
}

scenario_content_change_stops() {
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; finish_done; hooks
  A deliver-plan LC >/dev/null; capture 'approve delivery'; A approve-pending LC >/dev/null
  printf 'late\n' > late.txt
  expect_msg "a changed file after the approval" 'the content changed since the approved summary' S commit
  rm late.txt; printf 'chore: other\n' > .agents/local/deliver/LC/COMMIT_MSG
  expect_msg "a changed commit message after the approval" 'commit message or the pull request body changed' S commit
  printf 'feat: lookup (LC)\n' > .agents/local/deliver/LC/COMMIT_MSG
  S commit >/dev/null; A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG
  git -c core.hooksPath=/dev/null commit -q --allow-empty -m 'chore: extra'   # someone else's commit
  expect_msg "a new commit after the approval" 'HEAD is not the one delivery commit' S push
  ok "deliver: a changed file, message or a new commit after the approval stops the chain"
}

scenario_failed_refused() {
  export SC_BRANCH=1 SC_TEST_CRIT=AC-2 SC_TASK_EXTRA='- AC-2: second behavior'; scaffold orchestrated; unset SC_BRANCH SC_TEST_CRIT SC_TASK_EXTRA; origin
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null; gfail REVIEW_SMALL impl_test.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: default for an empty key'; A handoff LC IMPLEMENTED >/dev/null; gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null; gfail VERIFY impl.txt
  printf 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gates/*-VERIFY.yaml fail on the third content\n' | A terminate LC FAILED >/dev/null
  expect_msg "a FAILED run is refused with the next step" 'to reopen: /proofline reopen LC' A deliver-plan LC
  A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  expect_msg "a FAILED run is refused after the knowledge step too" 'to reopen: /proofline reopen LC' A deliver-plan LC
  [ ! -e .agents/local/deliver/LC ] || die "a refused delivery wrote a summary"
  ok "deliver: a FAILED run is refused (no draft pull request) and names the reopen command"
}

# A152: a FAILED run reopened with the user's approval reaches CODE_DONE and is delivered like any run.
scenario_reopened_run_delivers() {
  export SC_BRANCH=1 SC_TEST_CRIT=AC-2 SC_TASK_EXTRA='- AC-2: second behavior'; scaffold orchestrated; unset SC_BRANCH SC_TEST_CRIT SC_TASK_EXTRA; hooks
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null; gfail REVIEW_SMALL impl_test.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: default for an empty key'; A handoff LC IMPLEMENTED >/dev/null; gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null; gfail VERIFY impl.txt
  printf 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gates/*-VERIFY.yaml fail on the third content\n' | A terminate LC FAILED >/dev/null
  expect_msg "deliver-plan of the FAILED run" 'to reopen: /proofline reopen LC' A deliver-plan LC
  A request-approval LC reopen:LC >/dev/null; capture 'I approve the reopen of LC'; A approve LC reopen:LC >/dev/null
  printf 'reason: the verifier false alarm is fixed and the budget decided\n' | A reopen LC >/dev/null || die "approved reopen refused"
  pass_all; A handoff LC CODE_DONE >/dev/null
  # knowledge missing: exit 0, the not-ready notice, nothing written, no question
  has 'not ready to summarize' A deliver-plan LC
  [ ! -e .agents/local/deliver/LC ] || die "deliver-plan wrote a summary before the knowledge step"
  finish_done '' '## Reopen History' 'Reopened once with the user approval after a FAILED verify gate.'
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused the reopened, finished run"
  grep -q '^steps: commit push pr merge cleanup$' "$base/plan.out" && grep -q 'approve delivery' "$base/plan.out" || die "summary: $(cat "$base/plan.out")"
  capture 'approve delivery'; A approve-pending LC >/dev/null
  S commit >/dev/null || die "the one approval did not carry the commit step: $(S commit 2>&1 | tail -1)"
  ok "deliver: a reopened run is delivered with the one approval; an unfinished knowledge step only prints what is left"
}

# A163: the markdown task file moves to done/ inside the delivery commit; exactly one copy of the task exists afterwards,
# the summary shows the move, no later step refuses, and the merge step says the move is only in the unmerged branch.
scenario_task_moves_to_done() {
  SC_BRANCH=1 SC_SCOPE_NAMED=.github/workflows/ci.yml scaffold orchestrated yes; tasks_in_tasks
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  worker GREEN pass .github/workflows/ci.yml 'on: pull_request'   # in the plan scope: the delivery has a workflow
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; hooks; finish_done
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused: $(A deliver-plan LC 2>&1 | tail -1)"
  grep -q '^task_done: tasks/in-progress/LC.md -> tasks/done/LC.md$' "$base/plan.out" && grep -q 'moves it to done/' "$base/plan.out" || die "summary does not show the move: $(cat "$base/plan.out")"
  ! grep -q 'no CI check runs' "$base/plan.out" || die "summary warns about CI although a workflow exists"
  capture 'approve delivery'; A approve-pending LC >/dev/null
  has '^run: sh .agents/scripts/agent.sh task-source-done LC$' S commit
  A task-source-done LC > "$base/td.out" || die "task-source-done failed"
  [ ! -e tasks/in-progress/LC.md ] && [ -f tasks/done/LC.md ] || die "the task file is not only under done/"
  [ "$(find tasks -name 'LC*.md' | wc -l | tr -d ' ')" = 1 ] || die "not exactly one copy of the task: $(find tasks -name 'LC*.md')"
  grep -q '^\*\*Status:\*\* done$' tasks/done/LC.md || die "the Status line is not done"
  [ "$(A task-source-done LC)" = "" ] || die "a second move printed something (not idempotent)"
  git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the commit with the moved task file was blocked"
  git show --stat --format= HEAD | grep -q 'LC.md' || die "the move is not inside the delivery commit"
  [ -z "$(git status --porcelain --untracked-files=all | grep -v '^.. \.agents/')" ] || die "dirty after the commit"
  has '^run: git push -u origin proofline/LC-lc$' S push
  pushed LC; S pr >/dev/null
  gh_says "OPEN false"
  has 'moved to done/ only in the unmerged pull request branch' S merge 7
  gh_says "MERGED false"
  S cleanup 7 >/dev/null || die "cleanup after the moved task file refused: $(S cleanup 7 2>&1 | tail -1)"
  ok "deliver: the task file moves to done/ in the delivery commit (one copy), the chain accepts it, the merge step says where it is done"
}

# A163: a lead that skips the printed task-source-done line stops the chain at push.
scenario_task_move_skipped() {
  SC_BRANCH=1 SC_SCOPE_NAMED=.github/workflows/ci.yml scaffold orchestrated yes; tasks_in_tasks
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  worker GREEN pass .github/workflows/ci.yml 'on: pull_request'
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; hooks; finish_done
  A deliver-plan LC >/dev/null; capture 'approve delivery'; A approve-pending LC >/dev/null
  has 'task-source-done LC' S commit
  git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the commit was blocked"
  expect_msg "push with the task file left in in-progress/" 'the task file is not in tasks/done/LC.md' S push
  pushed LC
  expect_msg "pr with the task file left in in-progress/" 'the task file is not in tasks/done/LC.md' S pr
  ok "deliver: skipping the task-source-done line stops the chain at push and pr"
}

# A163: a project without a pull_request workflow gets the warning in the delivery summary.
scenario_summary_warns_without_ci() {
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; hooks; finish_done
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused"
  grep -q 'WARNING: no CI check runs on pull requests here. proofline merge verifies the commit locally instead' "$base/plan.out" || die "no CI warning: $(cat "$base/plan.out")"
  grep -q '^  fix: /proofline task Add a GitHub Actions workflow' "$base/plan.out" || die "no fix line"
  printf '7\n' > .agents/local/deliver/LC/PR; A deliver-plan LC >/dev/null
  [ ! -e .agents/local/deliver/LC/PR ] || die "a re-plan kept the old pull request number"
  ok "deliver: the summary warns under the merge step when no workflow runs on pull requests"
}

# A180: the platform decides who merges. Without CI the description and the delivery record say "verified locally, no CI"; a
# platform without a supported tool (Bitbucket, unrecognized, tool missing) has no merge or cleanup step: the user merges.
scenario_platforms() {
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; hooks; finish_done
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused"
  grep -q '^platform: github$' .agents/local/deliver/LC/SUMMARY.md && grep -q '^ci: verified locally, no CI$' .agents/local/deliver/LC/SUMMARY.md || die "the record lacks platform or the no-CI statement: $(cat .agents/local/deliver/LC/SUMMARY.md)"
  grep -q 'verified locally, no CI' .agents/local/deliver/LC/PR_BODY.md || die "the pull request description lacks 'verified locally, no CI'"
  grep -q '^steps: commit push pr merge cleanup$' .agents/local/deliver/LC/SUMMARY.md || die "github steps"
  git remote set-url origin https://bitbucket.org/acme/app.git
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan on bitbucket refused: $(cat "$base/plan.out")"
  grep -q '^steps: commit push pr$' .agents/local/deliver/LC/SUMMARY.md && grep -q '^merge_by: user$' .agents/local/deliver/LC/SUMMARY.md || die "bitbucket must have no merge step: $(cat .agents/local/deliver/LC/SUMMARY.md)"
  grep -q 'YOU open it and YOU merge it' "$base/plan.out" && grep -q 'bitbucket.org/acme/app/pull-requests/new' "$base/plan.out" || die "no explicit manual statement or link: $(cat "$base/plan.out")"
  git remote set-url origin https://gitlab.com/acme/app.git
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan on gitlab refused"
  grep -q '^merge_by: user$' .agents/local/deliver/LC/SUMMARY.md || die "gitlab without glab on PATH must be manual"
  printf '#!/bin/sh\nexit 0\n' > "$base/bin/glab"; chmod +x "$base/bin/glab"
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan on gitlab with glab refused"
  grep -q '^tool: glab$' .agents/local/deliver/LC/SUMMARY.md && grep -q '^steps: commit push pr merge cleanup$' .agents/local/deliver/LC/SUMMARY.md || die "gitlab with glab: $(cat .agents/local/deliver/LC/SUMMARY.md)"
  rm -f "$base/bin/glab"
  [ "$(A platform | sed -n 1p)" = 'platform: gitlab' ] || die "agent.sh platform: $(A platform)"
  ok "deliver: the platform picks the steps; no CI is stated in the description and the record; manual platforms have no merge step"
}

# A163: another adapter or a file already in done/ is left alone.
scenario_task_done_noop() {
  SC_BRANCH=1 scaffold orchestrated yes; tasks_in_tasks; to_code_done orchestrated; finish_done
  sed 's/^  adapter: markdown/  adapter: github/' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml
  [ "$(A task-source-done LC)" = "" ] && [ -f tasks/in-progress/LC.md ] || die "a non-markdown adapter moved the task file"
  ok "deliver: task-source-done leaves other adapters alone"
}


# A163: ci-check reads only the repository files; ci-task-command prints one pasteable /proofline task line.
scenario_ci_check() {
  SC_BRANCH=1 scaffold orchestrated; origin; wf=.github/workflows; mkdir -p $wf
  rc=0; A ci-check > "$base/ci.out" || rc=$?
  [ "$rc" = 1 ] && [ "$(sed -n 1p "$base/ci.out")" = 'ci: absent' ] && [ "$(sed -n 2p "$base/ci.out" | cut -c1-68)" = 'no CI check runs on pull requests here. proofline merge verifies the' ] || die "no workflow: rc=$rc $(cat "$base/ci.out")"
  printf 'on: push\njobs: {}\n' > $wf/a.yml; rc=0; A ci-check > "$base/ci.out" || rc=$?; [ "$rc" = 1 ] || die "a push-only workflow counts as CI"
  printf 'on:\n  push:\n  # pull_request:\njobs: {}\n# on: pull_request\n' > $wf/a.yml; rc=0; A ci-check > "$base/ci.out" || rc=$?; [ "$rc" = 1 ] || die "a commented-out trigger counts as CI"
  printf 'name: ci\non: pull_request\njobs: {}\n' > $wf/a.yml; has '^ci: present (.github/workflows/a.yml)$' A ci-check
  printf 'on: [push, pull_request]\njobs: {}\n' > $wf/a.yml; has '^ci: present' A ci-check
  printf 'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs: {}\n' > $wf/a.yml; has '^ci: present' A ci-check
  printf 'on:\n  workflow_dispatch:\n    inputs:\n      pull_request:\n        description: x\njobs: {}\n' > $wf/a.yml; rc=0; A ci-check > "$base/ci.out" || rc=$?; [ "$rc" = 1 ] || die "a workflow_dispatch input named pull_request counts as CI"
  printf 'on:\n  - pull_request_target\njobs: {}\n' > $wf/a.yml; has '^ci: present' A ci-check
  printf 'on: pull_request\r\njobs: {}\r\n' > $wf/a.yml; has '^ci: present' A ci-check
  printf 'on:\r\n  pull_request:\r\njobs: {}\r\n' > $wf/a.yml; has '^ci: present' A ci-check
  printf 'on: [\n  push,\n  pull_request\n]\njobs: {}\n' > $wf/a.yml; has '^ci: present' A ci-check
  printf 'on:\n  - push\n  - pull_request\njobs: {}\n' > $wf/a.yml; has '^ci: present' A ci-check
  rm $wf/a.yml; printf 'on: pull_request\n' > $wf/b.yaml; has '^ci: present (.github/workflows/b.yaml)$' A ci-check
  AS reviewer ci-check >/dev/null || die "ci-check is not open to every role"
  git remote set-url origin https://bitbucket.org/acme/app.git; rm $wf/b.yaml
  has '^ci: unknown (platform bitbucket' A ci-check
  git remote set-url origin https://gitlab.com/acme/app.git
  rc=0; A ci-check > "$base/ci.out" || rc=$?; [ "$rc" = 1 ] && [ "$(sed -n 1p "$base/ci.out")" = 'ci: absent' ] || die "gitlab without .gitlab-ci.yml: rc=$rc"
  printf 'test:\n  script: [true]\n' > .gitlab-ci.yml; has '^ci: present (.gitlab-ci.yml)$' A ci-check; rm .gitlab-ci.yml
  git remote set-url origin https://dev.azure.com/acme/proj/_git/app
  has '^ci: unknown (Azure DevOps' A ci-check
  # the task line: commands from the config, a valid line when none exist
  has '^/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: (none found; add yours); test: (none found; add yours)' A ci-task-command
  sed 's#^  build:$#  build: npm run build#; s#^  test:$#  test: npm test#' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml
  has '^/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: npm run build; test: npm test' A ci-task-command
  [ "$(A ci-task-command | wc -l | tr -d ' ')" = 1 ] || die "ci-task-command is not one line"
  ok "ci-check: present for pull_request in every form, absent for push-only and comments, unknown off GitHub; ci-task-command uses the config"
}

# A169: one "approve delivery" carries commit, push, pr, merge and cleanup without a new question. The reply is recorded by ONE
# process (the runtime hook that calls approve-pending has a time limit: five processes, each walking the tree, were cut off
# after the fourth step in a real project and the push had no approval), in the order of the steps. The commit and the push
# then really run through the git hooks (a push to a bare repository stands in for GitHub); the commit the summary foresaw does
# not invalidate the approvals of the later steps.
scenario_one_approval_real_chain() {
  SC_BRANCH=1 SC_SCOPE_NAMED=.github/workflows/ci.yml scaffold orchestrated yes; tasks_in_tasks
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  worker GREEN pass .github/workflows/ci.yml 'on: pull_request'
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null; hooks; finish_done
  rm -rf "$base/remote.git"; git init -q --bare "$base/remote.git"; git config remote.origin.pushurl "$base/remote.git"
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused: $(A deliver-plan LC 2>&1 | tail -1)"
  # a git that counts the content fingerprints computed (each one is one `git write-tree`)
  mkdir -p "$base/gs"; printf '#!/bin/sh\ncase " $* " in *" write-tree "*) echo w >> "%s/wt.log" ;; esac\nexec "%s" "$@"\n' "$base" "$(command -v git)" > "$base/gs/git"; chmod +x "$base/gs/git"
  capture 'approve delivery'; : > "$base/wt.log"; PATH=$base/gs:$PATH A approve-pending LC >/dev/null
  [ "$(wc -l < "$base/wt.log" | tr -d ' ')" = 1 ] || die "the reply computed the content fingerprint $(wc -l < "$base/wt.log" | tr -d ' ') times (once for all five steps)"
  prev=0
  for k in commit push pr merge cleanup; do
    f=$(ls .agents/runs/LC/approvals/[0-9][0-9][0-9]-"$k".yaml 2>/dev/null | head -1); [ -n "$f" ] || die "no $k approval from the one reply"
    n=$(basename "$f" | cut -c1-3 | sed 's/^0*//'); [ "$n" -gt "$prev" ] || die "the $k approval is not recorded after the step before it"; prev=$n
  done
  S commit >/dev/null || die "commit step: $(S commit 2>&1 | tail -1)"
  A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the approved commit was blocked"
  S push > "$base/step.out" 2>&1 || die "push step after the foreseen commit: $(tail -1 "$base/step.out")"
  git push -u origin proofline/LC-lc > "$base/push.out" 2>&1 || die "git push after the foreseen commit: $(tail -3 "$base/push.out")"
  S pr > "$base/step.out" 2>&1 || die "pr step: $(tail -1 "$base/step.out")"
  gh_says "OPEN false"
  S merge 7 > "$base/step.out" 2>&1 || die "merge step: $(tail -1 "$base/step.out")"
  gh_says "MERGED false"
  S cleanup 7 > "$base/step.out" 2>&1 || die "cleanup step: $(tail -1 "$base/step.out")"
  ok "deliver: one reply is recorded in one process in step order; the real commit, push, pull request, merge and cleanup run on it"
}

# A169: a reply recorded only in part (the hook was cut off after the commit step) is no reason for a new summary: the push step names
# the cause, and the user's reply once more records the steps that are missing, after the commit already exists.
scenario_partial_reply_recovers() {
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; finish_done; hooks
  rm -rf "$base/remote.git"; git init -q --bare "$base/remote.git"; git config remote.origin.pushurl "$base/remote.git"
  A deliver-plan LC >/dev/null; capture 'approve delivery'
  A approve LC commit >/dev/null   # what a cut-off hook leaves: the first step only
  S commit >/dev/null; A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the approved commit was blocked"
  expect_msg "a push whose approval the cut-off hook never recorded" 'recorded only in part' S push
  expect_msg "that refusal does not send the lead to a new summary" 'do not prepare it again' S push
  capture 'approve delivery'; A approve-pending LC >/dev/null   # the user sends the reply once more
  S push >/dev/null || die "push step after the repeated reply: $(S push 2>&1 | tail -1)"
  git push -u origin proofline/LC-lc > "$base/push.out" 2>&1 || die "git push after the repeated reply: $(tail -3 "$base/push.out")"
  expect_msg "a second push on the used approval" 'was already used' S push
  S pr >/dev/null || die "pr step after the repeated reply: $(S pr 2>&1 | tail -1)"
  ok "deliver: a reply recorded in part is completed by the same reply once more, not by a new summary"
}

scenario_cleanup_crash_keeps_merged() {
  [ "$(id -u)" != 0 ] || { ok "cleanup crash case skipped (running as root): not tested"; return 0; }
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; hooks
  finish_done; mkdir -p .agents/local/batch
  A deliver-plan LC >/dev/null; capture 'approve delivery'; A approve-pending LC >/dev/null
  S commit >/dev/null; A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG
  S push >/dev/null; pushed LC; S pr >/dev/null; gh_says "OPEN false"; S merge 7 >/dev/null; gh_says "MERGED false"
  # the cleanup dies half way (the runs folder cannot be changed): the merge must already be on record, so a batch never runs the task again
  chmod a-w .agents/runs
  S cleanup 7 > "$base/crash.out" 2>&1 && { chmod u+w .agents/runs; die "cleanup succeeded although the run folder could not be removed"; }
  chmod u+w .agents/runs
  [ -d .agents/runs/LC ] || die "the test did not interrupt the cleanup"
  [ "$(awk -F'\t' '$1 == "LC" { print $2 }' .agents/local/batch/merged.tsv)" = 7 ] || die "merged.tsv after a cleanup that died: $(cat .agents/local/batch/merged.tsv 2>&1)"
  ok "deliver: the merge is recorded in merged.tsv before the cleanup, so a crash in between leaves the task merged"
}

# A184 (round 2): the knowledge step's files (docs/wiki, not named by the plan) written from CODE_DONE on never move the tier, a gate or the delivery
scenario_knowledge_tier() {
  SC_BRANCH=1 SC_SCOPE_NAMED=app.go scaffold standalone no STANDARD; tasks_in_tasks; hooks
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass app.go 'package x' impl.txt,impl_test.txt,app.go
  A handoff LC IMPLEMENTED >/dev/null; [ "$(A tier LC)" = small ] || die "the fixture is not tier small: $(A tier LC)"
  pass_all; n_gates=$(ls .agents/runs/LC/gates/*.yaml | wc -l | tr -d ' ')
  A handoff LC CODE_DONE >/dev/null
  mkdir -p docs/wiki; for i in 1 2 3 4; do printf '# Page %s\n\nThe lookup returns the stored value.\n' "$i" > "docs/wiki/page$i.md"; done
  [ "$(A tier LC)" = small ] || die "four knowledge files at CODE_DONE moved the tier to $(A tier LC)"
  A knowledge-done LC >/dev/null || die "knowledge-done refused four wiki pages: $(A knowledge-done LC 2>&1 | tail -1)"
  [ "$(A tier LC)" = small ] && [ "$(ls .agents/runs/LC/gates/*.yaml | wc -l | tr -d ' ')" = "$n_gates" ] || die "the tier or the gate files changed after the knowledge step"
  for g in $(pipe_val gates); do case "$(A pipeline LC | sed -n "s/^gate.$g=//p")" in *missing*|*stale*) die "gate $g became $(A pipeline LC | sed -n "s/^gate.$g=//p") after the knowledge files" ;; esac; done
  write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  A deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan refused after the knowledge files: $(tail -2 "$base/plan.out")"
  grep -q 'approve delivery' "$base/plan.out" || die "deliver-plan is not ready: $(cat "$base/plan.out")"
  ok "knowledge: four wiki pages the plan does not name, written at CODE_DONE, leave the tier small, every gate satisfied and deliver-plan ready (A184)"
}

# the same four files BEFORE CODE_DONE still count (the plan names none of them), and a gate the effective tier needs but that cannot be recorded at CODE_DONE
# sends `next` to amend or a new task, never to reviewers
scenario_knowledge_tier_before_and_next() {
  SC_BRANCH=1 SC_SCOPE_NAMED=app.go scaffold standalone no STANDARD; tasks_in_tasks; hooks
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass app.go 'package x' impl.txt,impl_test.txt,app.go
  A handoff LC IMPLEMENTED >/dev/null; [ "$(A tier LC)" = small ] || die "the fixture is not tier small: $(A tier LC)"
  mkdir -p docs/wiki; for i in 1 2 3 4; do printf '# Page %s\n\nThe lookup returns the stored value.\n' "$i" > "docs/wiki/page$i.md"; done
  [ "$(AS reviewer tier LC)" = full ] || die "four unnamed wiki files before CODE_DONE did not count: $(AS reviewer tier LC)"
  rm -rf docs; [ "$(AS reviewer tier LC)" = small ] || die "the fixture is not tier small again: $(AS reviewer tier LC)"
  pass_all; A handoff LC CODE_DONE >/dev/null
  printf '{}\n' > package.json   # a risky path at CODE_DONE: a task change, so the effective tier is full and its gates are missing
  out=$(A next LC)
  printf '%s\n' "$out" | grep -q 'agent.sh amend LC' && printf '%s\n' "$out" | grep -q 'do NOT dispatch reviewers' || die "next at CODE_DONE with an unsatisfied gate: $out"
  printf '%s\n' "$out" | grep -q 'dispatch.sh LC reviewer' && die "next still sends the lead to reviewers: $out"
  ok "knowledge: the same files before CODE_DONE count; next at CODE_DONE with an unsatisfied tier gate says amend or new task, no reviewers (A184)"
}

# --- A180/A181 round 3: a local origin, the manual merge proven from git, the worktree that goes away with the merged run ---------------------------------
# lo_chain: a finished run, a local bare origin that holds main, the delivery up to the pr step (the hand-off to the user); the bare repository is $lo
lo_chain() {
  SC_BRANCH=1 scaffold orchestrated; tasks_in_tasks; to_code_done orchestrated; hooks; finish_done
  lo=$base/lo.git; rm -rf "$lo"; git init -q --bare "$lo"; git remote set-url origin "$lo"
  git -c core.hooksPath=/dev/null push -q origin main
  A deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan on a local origin refused: $(tail -2 "$base/plan.out")"
  capture 'approve delivery'; A approve-pending LC >/dev/null
  S commit >/dev/null; A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the approved commit was blocked"
  S push >/dev/null || die "push step: $(S push 2>&1 | tail -1)"
  git push -q origin proofline/LC-lc 2> "$base/push.err" || die "git push: $(cat "$base/push.err")"
  S pr > "$base/pr.out" 2>&1 || die "pr step: $(cat "$base/pr.out")"
}
scenario_local_origin() {
  SC_BRANCH=1 scaffold orchestrated; tasks_in_tasks; to_code_done orchestrated; hooks; finish_done
  rm -rf "$base/lo.git" "$base/rel.git"; git init -q --bare "$base/lo.git"; git init -q --bare "$base/rel.git"
  for u in "$base/lo.git" "../rel.git" "file://$base/lo.git"; do
    git remote set-url origin "$u"
    [ "$(sh "$tl_agents/scripts/platform.sh" field local -C "$PWD")" = yes ] && [ "$(sh "$tl_agents/scripts/platform.sh" field platform -C "$PWD")" = other ] || die "$u is not a local origin of platform other"
    A deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan refused the local origin $u: $(tail -2 "$base/plan.out")"
    grep -q '^steps: commit push pr$' .agents/local/deliver/LC/SUMMARY.md && grep -q '^merge_by: user$' .agents/local/deliver/LC/SUMMARY.md || die "$u: steps/merge_by: $(cat .agents/local/deliver/LC/SUMMARY.md)"
    # a relative origin is shown as its absolute url (a direct push from any worktree), the others as origin
    case "$u" in ../*) lo_w="$(cd "$base" && pwd -P)/${u#../}" ;; *) lo_w=origin ;; esac
    grep -q "git push $lo_w proofline/LC-lc:main" "$base/plan.out" || die "$u: no 'git push $lo_w proofline/LC-lc:main' hand-off: $(cat "$base/plan.out")"
  done
  # a host-shaped address without a path is not a local repository, and no hosting-service tool is applied to a local origin
  for u in github.com.evil.example https://github.com.evil.example host.example; do
    git remote set-url origin "$u"
    expect_msg "deliver-plan on the look-alike origin $u" 'delivery blocked' A deliver-plan LC
  done
  git remote set-url origin "$base/lo.git"
  printf '#!/bin/sh\nexit 0\n' > "$base/bin/glab"; chmod +x "$base/bin/glab"
  expect_msg "a configured CLI platform on a local origin" 'delivery blocked' env PROOFLINE_PLATFORM=gitlab sh ./.agents/scripts/agent.sh deliver-plan LC
  rm -f "$base/bin/glab"
  ok "deliver: a local path, relative path or file:// origin is platform other (commit push pr, hand-off git push origin <branch>:main); look-alike addresses are refused; no CLI platform applies to a local origin (A180)"
}
scenario_manual_merge_proof() {
  lo_chain
  [ -s .agents/local/deliver/LC/MERGE_HEAD ] && grep -q 'deliver-merged LC' "$base/pr.out" || die "the pr step left no hand-off: $(cat "$base/pr.out")"
  mkdir -p .agents/local/batch
  # not merged yet: fail closed, nothing recorded, the run stays
  expect_msg "deliver-merged before the merge" 'not merged' A deliver-merged LC
  expect_fail "deliver-merged --check before the merge" A deliver-merged LC --check
  [ ! -s .agents/local/batch/merged.tsv ] && [ -d .agents/runs/LC ] && [ -s .agents/local/deliver/LC/MERGE_HEAD ] || die "a refused deliver-merged recorded or removed something"
  # a merge of other content does not prove it
  git clone -q "$lo" "$base/c0" && ( cd "$base/c0" && git checkout -q main && echo other > other.txt && git add other.txt && git commit -qm other && git push -q origin main ) || die "other commit on origin"
  expect_msg "deliver-merged when origin/main moved on without the delivery" 'not merged' A deliver-merged LC
  # a squash merge: another commit, identical content on every delivered path
  ( cd "$base/c0" && git fetch -q origin && git merge --squash -q origin/proofline/LC-lc >/dev/null 2>&1 && git commit -qm 'squash of LC' && git push -q origin main ) || die "squash merge on origin"
  git merge-base --is-ancestor proofline/LC-lc "$(git ls-remote "$lo" refs/heads/main | cut -f1)" 2>/dev/null && die "the fixture is a fast-forward, not a squash"
  A deliver-merged LC --check | grep -q '^merged: every delivered path has the same content' || die "check does not prove the squash: $(A deliver-merged LC --check 2>&1)"
  A deliver-merged LC > "$base/dm.out" 2>&1 || die "deliver-merged refused a squash merge: $(cat "$base/dm.out")"
  grep -q '^merge recorded for LC: every delivered path has the same content' "$base/dm.out" || die "squash output: $(cat "$base/dm.out")"
  grep -q "^LC	-	" .agents/local/batch/merged.tsv && [ ! -e .agents/runs/LC ] && [ ! -e .agents/local/deliver/LC ] || die "squash: no record or the run survived"
  ok "deliver-merged: a squash merge is proven by identical content on every delivered path; not merged (or other content) records nothing and keeps the run"
}
scenario_manual_merge_ff() {
  lo_chain; mkdir -p .agents/local/batch
  git --git-dir="$lo" update-ref refs/heads/main "$(git rev-parse proofline/LC-lc)"
  A deliver-merged LC > "$base/dm.out" 2>&1 || die "deliver-merged refused a fast-forward merge: $(cat "$base/dm.out")"
  grep -q '^merge recorded for LC: the delivered commit is on origin/main' "$base/dm.out" && grep -q 'not on a clean main' "$base/dm.out" || die "ff output: $(cat "$base/dm.out")"
  grep -q "^LC	-	" .agents/local/batch/merged.tsv && [ ! -e .agents/runs/LC ] || die "ff: no record or the run survived"
  ok "deliver-merged: a fast-forward merge is proven (ancestor of origin/main), recorded, the run is cleaned up"
}
# into_worktree: the finished run LC (and its uncommitted work) moves from the main working tree into its own worktree, as a night-mode run lives there.
# Afterwards $wt is the worktree, W runs agent.sh in it and the main working tree is on main again.
into_worktree() {
  git diff HEAD > "$base/mv.patch"; rm -rf "$base/mv"; mkdir -p "$base/mv"
  for f in $(git ls-files --others --exclude-standard | grep -v '^\.agents/'); do mkdir -p "$base/mv/$(dirname "$f")"; cp "$f" "$base/mv/$f"; done
  rm -rf "$base/mv-run"; cp -R .agents/runs/LC "$base/mv-run"
  git checkout -q -- .; git clean -fdq -e .agents; git checkout -q main; git branch -qD proofline/LC-lc
  rm -rf .agents/runs/LC; : > .agents/local/ACTIVE_RUN
  wt=$(A worktree-add LC) || die "worktree-add: $wt"
  git -C "$wt" checkout -q -b proofline/LC-lc; [ ! -s "$base/mv.patch" ] || git -C "$wt" apply "$base/mv.patch" || die "the work does not apply in the worktree"
  cp -R "$base/mv/." "$wt/"; mkdir -p "$wt/.agents/runs"; cp -R "$base/mv-run" "$wt/.agents/runs/LC"; echo LC > "$wt/.agents/local/ACTIVE_RUN"
  mkdir -p .agents/local/batch
}
W() { ( cd "$wt" && sh .agents/scripts/agent.sh "$@" ); }
wt_gone() { [ ! -e "$wt" ] && [ "$(git worktree list | wc -l | tr -d ' ')" = 1 ]; }
wt_done_run() { SC_BRANCH=1 scaffold orchestrated; tasks_in_tasks; to_code_done orchestrated; hooks; finish_done; into_worktree; }
# the delivery inside the worktree up to the hand-off to the user (local origin) or to the open pull request (gh)
wt_deliver() { # local|gh
  if [ "$1" = local ]; then lo=$base/lo.git; rm -rf "$lo"; git init -q --bare "$lo"; git remote set-url origin "$lo"; git -c core.hooksPath=/dev/null push -q origin main; fi
  W deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan in the worktree: $(tail -2 "$base/plan.out")"
  capture 'approve delivery'; W approve-pending LC >/dev/null
  W deliver-step LC commit >/dev/null || die "commit step in the worktree"
  W task-source-done LC >/dev/null; git -C "$wt" add -A; git -C "$wt" commit -qF .agents/local/deliver/LC/COMMIT_MSG 2> "$base/commit.err" || die "the commit in the worktree was blocked: $(cat "$base/commit.err")"
  W deliver-step LC push >/dev/null || die "push step in the worktree"
  if [ "$1" = local ]; then git -C "$wt" push -q origin proofline/LC-lc 2> "$base/push.err" || die "git push: $(cat "$base/push.err")"
  else git -C "$wt" push -q bare proofline/LC-lc 2> "$base/push.err" || die "git push: $(cat "$base/push.err")"; git -C "$wt" update-ref refs/remotes/origin/proofline/LC-lc HEAD; fi
  W deliver-step LC pr > "$base/pr.out" 2>&1 || die "pr step in the worktree: $(cat "$base/pr.out")"
}
scenario_wt_cleanup_manual() {
  wt_done_run; wt_deliver local
  expect_msg "deliver-merged before the merge" 'not merged' W deliver-merged LC
  [ -d "$wt" ] || die "an unmerged run lost its worktree"
  git --git-dir="$lo" update-ref refs/heads/main "$(git -C "$wt" rev-parse HEAD)"
  W deliver-merged LC > "$base/dm.out" 2>&1 || die "deliver-merged in the worktree: $(cat "$base/dm.out")"
  grep -q '^worktree removed: LC' "$base/dm.out" && wt_gone || die "the worktree survived deliver-merged: $(cat "$base/dm.out")"
  grep -q "^LC	-	" .agents/local/batch/merged.tsv || die "no merge record"
  [ "$(git rev-parse main)" = "$(git --git-dir="$lo" rev-parse main)" ] || die "the local main was not brought to the merge (the next task starts from it)"
  ok "deliver-merged inside the run's worktree: merge proven from git, recorded, local main fast-forwarded, the worktree removed (A169, A181)"
}
scenario_wt_cleanup_pr() {
  wt_done_run; git remote set-url origin https://github.com/acme/app.git; git init -q --bare "$base/bare.git"; git remote add bare "$base/bare.git"
  wt_deliver gh
  gh_says "OPEN false" "$(git -C "$wt" rev-parse HEAD) proofline/LC-lc main acme"
  W deliver-step LC merge 7 > "$base/mg.out" 2>&1 || die "merge step in the worktree: $(cat "$base/mg.out")"
  gh_says "MERGED false" "$(git -C "$wt" rev-parse HEAD) proofline/LC-lc main acme"
  W deliver-step LC cleanup 7 > "$base/cl.out" 2>&1 || die "cleanup step in the worktree: $(cat "$base/cl.out")"
  grep -q '^worktree removed: LC' "$base/cl.out" && wt_gone || die "the worktree survived deliver-step cleanup: $(cat "$base/cl.out")"
  ok "deliver-step cleanup after a merged pull request removes the run's worktree (A169)"
}
scenario_wt_cleanup_kept() {
  wt_done_run
  # the merge is on record: cleanup inside the worktree removes the run and the worktree
  printf 'LC\t-\t%s\n' "$(date +%s)" >> .agents/local/batch/merged.tsv
  W cleanup LC > "$base/cl.out" 2>&1 || die "cleanup in the worktree: $(cat "$base/cl.out")"
  grep -q '^worktree removed: LC' "$base/cl.out" && wt_gone || die "the worktree survived cleanup after the merged record: $(cat "$base/cl.out")"
  # a leftover worktree of a merged, cleaned-up run: cleanup in the main tree removes it
  wt=$(A worktree-add LC) || die "worktree-add"; [ -d "$wt" ] || die "no leftover worktree"
  A cleanup LC > "$base/cl2.out" 2>&1 || die "cleanup of a leftover worktree from the main tree: $(cat "$base/cl2.out")"
  wt_gone || die "the leftover worktree survived: $(git worktree list)"
  ok "cleanup: removes the worktree once the merge is on record, also a leftover one from the main tree (A169)"
}
scenario_wt_failed_kept() {
  SC_BRANCH=1 scaffold orchestrated; tasks_in_tasks; hooks; into_worktree
  printf 'LC\t-\t%s\n' "$(date +%s)" >> .agents/local/batch/merged.tsv   # even with a merge on record a terminated run keeps its evidence
  printf 'reason: the registry the build needs is unreachable from this environment\nevidence: the install command fails with a network error on every retry\n' | W terminate LC BLOCKED > "$base/tm.out" 2>&1 || die "terminate in the worktree: $(cat "$base/tm.out")"
  W cleanup LC > "$base/cl.out" 2>&1 || die "cleanup of a BLOCKED run: $(cat "$base/cl.out")"
  [ -d "$wt" ] && ! grep -q 'worktree removed' "$base/cl.out" || die "a BLOCKED run lost its worktree: $(cat "$base/cl.out")"
  ok "cleanup of a BLOCKED run keeps its worktree even with a merge on record (A169)"
}

# A180 round 4: origin is a RELATIVE local path in the shared git config: a run worktree sees the same remote as the main tree, the shown commands name it
# absolute for one command, and the config itself is never rewritten
scenario_wt_relative_origin() {
  wt_done_run
  lo=$base/lo.git; rm -rf "$lo"; git init -q --bare "$lo"; lo_abs=$(cd "$lo" && pwd -P)
  git remote set-url origin ../lo.git; git -c core.hooksPath=/dev/null push -q origin main
  [ ! -d "$wt/../lo.git" ] && [ ! -d "$wt/lo.git" ] || die "the fixture path is also valid from the worktree"
  W deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan in the worktree: $(tail -2 "$base/plan.out")"
  grep -q "git push $lo_abs proofline/LC-lc" "$base/plan.out" && grep -q "git push $lo_abs proofline/LC-lc:main" "$base/plan.out" || die "the plan shows a relative origin: $(grep -n 'push' "$base/plan.out")"
  capture 'approve delivery'; W approve-pending LC >/dev/null
  W deliver-step LC commit >/dev/null || die "commit step"
  W task-source-done LC >/dev/null; git -C "$wt" add -A; git -C "$wt" commit -qF .agents/local/deliver/LC/COMMIT_MSG 2> "$base/commit.err" || die "commit: $(cat "$base/commit.err")"
  W deliver-step LC push > "$base/push.out" 2>&1 || die "push step: $(cat "$base/push.out")"
  # round 5: the push step pushes itself (the runtime guard refuses a push to an absolute path outside the project)
  grep -q "^pushed: proofline/LC-lc -> $lo_abs\$" "$base/push.out" || die "the push step did not push to the absolute origin: $(cat "$base/push.out")"
  ls "$wt"/.agents/runs/LC/approvals/*-push.yaml >/dev/null 2>&1 && grep -q "^consumed: \"true\"" "$wt"/.agents/runs/LC/approvals/*-push.yaml || die "the push approval was not consumed by the step"
  [ "$(git --git-dir="$lo" rev-parse -q --verify refs/heads/proofline/LC-lc)" = "$(git -C "$wt" rev-parse HEAD)" ] || die "the branch is not in the local origin"
  W deliver-step LC pr > "$base/pr.out" 2>&1 || die "pr step: $(cat "$base/pr.out")"
  grep -q "git push $lo_abs proofline/LC-lc:main" "$base/pr.out" || die "the hand-off shows a relative origin: $(cat "$base/pr.out")"
  expect_msg "deliver-merged --check from the worktree before the merge" 'not merged' W deliver-merged LC --check
  git --git-dir="$lo" update-ref refs/heads/main "$(git -C "$wt" rev-parse HEAD)"
  W deliver-merged LC --check > "$base/chk.out" 2>&1 || die "deliver-merged --check from the worktree does not reach the relative origin: $(cat "$base/chk.out")"
  grep -q '^merged: the delivered commit is on origin/main' "$base/chk.out" || die "the fast-forward merge is not proven: $(cat "$base/chk.out")"
  [ "$(git config remote.origin.url)" = ../lo.git ] || die "the shared remote.origin.url was rewritten: $(git config remote.origin.url)"
  ok "relative local origin: a worktree proves the merge, the shown commands name the origin absolute, remote.origin.url stays as configured (A180)"
}

# A180 round 5: a delivery the user pushed by hand (the pr step never ran, no MERGE_HEAD) is recovered by deliver-merged from the delivered branch's
# CURRENT head. The summary's head is HEAD before the commit step and is already on origin's main: it must never count as the delivery.
scenario_hand_pushed() {
  wt_done_run
  lo=$base/lo.git; rm -rf "$lo"; git init -q --bare "$lo"; git remote set-url origin "$lo"; git -c core.hooksPath=/dev/null push -q origin main
  W deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan: $(tail -2 "$base/plan.out")"
  # the trap: no delivery commit yet, the branch is at the summary's head, which origin/main already holds
  expect_msg "no delivery commit beyond the base" 'no delivery commit' W deliver-merged LC
  [ ! -e "$wt/.agents/local/deliver/LC/MERGE_HEAD" ] || die "a hand-off was written without a delivery commit"
  [ ! -s "$wt/.agents/local/batch/merged.tsv" ] && [ ! -s .agents/local/batch/merged.tsv ] || die "a merge was recorded without a delivery commit"
  capture 'approve delivery'; W approve-pending LC >/dev/null
  W deliver-step LC commit >/dev/null || die "commit step"
  W task-source-done LC >/dev/null; git -C "$wt" add -A; git -C "$wt" commit -qF .agents/local/deliver/LC/COMMIT_MSG 2> "$base/commit.err" || die "commit: $(cat "$base/commit.err")"
  git -C "$wt" -c core.hooksPath=/dev/null push -q origin proofline/LC-lc 2> "$base/push.err" || die "hand push: $(cat "$base/push.err")"
  expect_msg "pushed by hand, not merged" 'not merged' W deliver-merged LC
  [ ! -e .agents/local/batch/merged.tsv ] || ! grep -q '^LC	' .agents/local/batch/merged.tsv || die "an unmerged hand push was recorded"
  [ -d "$wt/.agents/runs/LC" ] || die "the run went before the merge"
  git --git-dir="$lo" update-ref refs/heads/main "$(git -C "$wt" rev-parse HEAD)"
  W deliver-merged LC > "$base/dm.out" 2>&1 || die "merged by hand, deliver-merged refused: $(cat "$base/dm.out")"
  grep -q '^merge recorded for LC' "$base/dm.out" || die "no merge record: $(cat "$base/dm.out")"
  ok "hand-pushed delivery: the base is never the delivery, an unmerged push is not recorded, a merged one is (A180)"
}

# --- review round 6 guards -------------------------------------------------------------------------------------------------------------------------------------
# (2) after CODE_DONE only plain documentation files the plan does not name stay out of the tier; a script, an executable doc, a link and a data file count
scenario_knowledge_nondoc() {
  SC_BRANCH=1 SC_SCOPE_NAMED=app.go scaffold standalone no STANDARD; tasks_in_tasks; hooks
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass app.go 'package x' impl.txt,impl_test.txt,app.go
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null
  mkdir -p docs/wiki; t() { AS reviewer tier LC; }
  [ "$(t)" = small ] || die "the fixture is not small"
  printf '# a\n' > docs/wiki/a.md; printf '# b\n' > docs/wiki/b.md; printf '# c\n' > docs/wiki/c.md
  [ "$(t)" = small ] || die "plain .md pages counted toward the tier"
  rm -f docs/wiki/*
  printf 'echo 1\n' > docs/wiki/gen.sh; printf 'echo 2\n' > docs/wiki/gen2.sh
  [ "$(t)" = full ] || die "unnamed scripts under docs/wiki did not count: $(t)"; rm -f docs/wiki/*
  printf '# a\n' > docs/wiki/x1.md; printf '# b\n' > docs/wiki/x2.md; chmod +x docs/wiki/x1.md docs/wiki/x2.md
  [ "$(t)" = full ] || die "executable docs did not count: $(t)"; rm -f docs/wiki/*
  ln -s ../../impl.txt docs/wiki/l1.md; ln -s ../../impl_test.txt docs/wiki/l2.md
  [ "$(t)" = full ] || die "symlinked docs did not count: $(t)"; rm -f docs/wiki/*
  printf '{}\n' > docs/wiki/d1.json; printf '{}\n' > docs/wiki/d2.json
  [ "$(t)" = full ] || die "non-doc extensions did not count: $(t)"; rm -f docs/wiki/*
  ok "knowledge: after CODE_DONE .md pages stay out of the tier; a script, an executable doc, a symlink and a data file under docs/wiki count (round 6)"
}
# (3)(4) the worktree of a merged run goes only on this run's own merge record, with nothing untracked left in it
scenario_wt_cleanup_guards() {
  wt_done_run
  CLEANUP_MERGED=yes W cleanup LC > "$base/c1.out" 2>&1 || die "cleanup: $(cat "$base/c1.out")"
  [ -d "$wt" ] && ! grep -q 'worktree removed' "$base/c1.out" || die "CLEANUP_MERGED=yes in the environment removed the worktree: $(cat "$base/c1.out")"
  wt_done_run
  printf 'OTHER\t-\t%s\n' "$(date +%s)" >> .agents/local/batch/merged.tsv
  W cleanup LC > "$base/c2.out" 2>&1 || die "cleanup: $(cat "$base/c2.out")"
  [ -d "$wt" ] && ! grep -q 'worktree removed' "$base/c2.out" || die "another run's merged row removed the worktree: $(cat "$base/c2.out")"
  wt_done_run
  printf 'LC\t-\t%s\n' "$(date +%s)" >> .agents/local/batch/merged.tsv; echo evidence > "$wt/notes-by-hand.log"; [ -e "$wt/.agents/local/worktree-copied" ] || : > "$wt/.agents/local/worktree-copied";   # (without that manifest file the product's grep -f fails and the check passes: reported)
  printf '*.log\n' >> "$(git rev-parse --git-common-dir)/info/exclude"
  W cleanup LC > "$base/c3.out" 2>&1 || die "cleanup: $(cat "$base/c3.out")"
  [ -f "$wt/notes-by-hand.log" ] && grep -q 'holds files git does not track' "$base/c3.out" || die "a worktree with an ignored file of its own was removed: $(cat "$base/c3.out")"
  ok "cleanup: an environment claim and another run's merge row do not remove the worktree; an ignored file of the run keeps it (round 6)"
}
# (5)(6) relative local origin: the approved head is pushed, the origin is pinned, an option-like origin is refused; an empty delivery proves no merge
scenario_wt_relative_guards() {
  wt_done_run
  lo=$base/lo.git; rm -rf "$lo" "$base/lo2.git"; git init -q --bare "$lo"; git init -q --bare "$base/lo2.git"
  git remote set-url origin ../lo.git; git -c core.hooksPath=/dev/null push -q origin main
  W deliver-plan LC > "$base/plan.out" 2>&1 || die "deliver-plan: $(tail -2 "$base/plan.out")"
  capture 'approve delivery'; W approve-pending LC >/dev/null
  W deliver-step LC commit >/dev/null || die "commit step"
  W task-source-done LC >/dev/null; git -C "$wt" add -A; git -C "$wt" commit -qF .agents/local/deliver/LC/COMMIT_MSG 2> "$base/commit.err" || die "commit: $(cat "$base/commit.err")"
  # the origin changes after the summary was approved: refused, nothing pushed
  git remote set-url origin ../lo2.git
  expect_msg "push step after the origin changed" 'origin changed since the summary was approved' W deliver-step LC push
  [ -z "$(git --git-dir="$base/lo2.git" for-each-ref refs/heads/proofline)" ] || die "a branch reached the changed origin"
  git config remote.origin.url -oProxyCommand=touch
  W deliver-step LC push > "$base/opt.out" 2>&1 || :
  ! grep -q '^pushed:' "$base/opt.out" || die "the push step pushed to an option-like origin: $(cat "$base/opt.out")"
  [ ! -e "$wt/touch" ] && [ ! -e touch ] || die "an option-like origin was executed"
  git remote set-url origin ../lo.git
  W deliver-step LC push > "$base/push.out" 2>&1 || die "push step: $(cat "$base/push.out")"
  [ "$(git --git-dir="$lo" rev-parse refs/heads/proofline/LC-lc)" = "$(git -C "$wt" rev-parse HEAD)" ] || die "the approved head was not pushed"
  W deliver-step LC pr >/dev/null 2>&1 || die "pr step"
  # an empty delivery (the delivered commit is the run's base) proves nothing
  printf '%s\tmain\tproofline/LC-lc\n' "$(sed -n 's/^  base_sha: *//p' "$wt/.agents/runs/LC/RUN.yaml" | tr -d '"' | head -n 1)" > "$wt/.agents/local/deliver/LC/MERGE_HEAD"
  expect_msg "deliver-merged of an empty delivery" 'empty delivery' W deliver-merged LC
  [ ! -s .agents/local/batch/merged.tsv ] || die "an empty delivery was recorded as merged"
  ok "relative origin: the approved head is pushed, a changed or option-like origin is refused, an empty delivery records no merge (round 6)"
}

run_sc scenario_normal_chain
run_sc scenario_cleanup_crash_keeps_merged
run_sc scenario_content_change_stops
run_sc scenario_failed_refused
run_sc scenario_reopened_run_delivers
run_sc scenario_task_moves_to_done
run_sc scenario_task_move_skipped
run_sc scenario_summary_warns_without_ci
run_sc scenario_platforms
run_sc scenario_task_done_noop
run_sc scenario_ci_check
run_sc scenario_one_approval_real_chain
run_sc scenario_partial_reply_recovers
run_sc scenario_knowledge_tier
run_sc scenario_knowledge_tier_before_and_next
run_sc scenario_local_origin
run_sc scenario_manual_merge_proof
run_sc scenario_manual_merge_ff
run_sc scenario_wt_cleanup_manual
run_sc scenario_wt_cleanup_pr
run_sc scenario_wt_cleanup_kept
run_sc scenario_wt_failed_kept
run_sc scenario_wt_relative_origin
run_sc scenario_hand_pushed
run_sc scenario_knowledge_nondoc
run_sc scenario_wt_cleanup_guards
run_sc scenario_wt_relative_guards
echo 'deliver tests passed'
