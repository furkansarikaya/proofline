#!/bin/sh
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents and base come from test-lib.sh
# One-command delivery: deliver-plan shows one summary, the user's one reply "approve delivery" records one approval
# per step, deliver-step checks the shown content and the step's approval before each step. Nothing is pushed and
# gh never runs: a push is simulated by setting the remote-tracking ref, gh is a PATH shim in the test's temp dir
# (accepted only under PROOFLINE_SELFTEST=1, as for proofline merge; there is no env seam naming the gh binary).
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
mkdir -p "$base/bin"; printf '#!/bin/sh\ncat "%s/ghstate"\n' "$base" > "$base/bin/gh"; chmod +x "$base/bin/gh"
PATH=$base/bin:$PATH PROOFLINE_SELFTEST=1 PROOFLINE_NO_TTY=1; export PATH PROOFLINE_SELFTEST PROOFLINE_NO_TTY
gh_says() { printf '%s %s\n' "$1" "${2:-$(git rev-parse HEAD) proofline/LC-lc main acme}" > "$base/ghstate"; }   # STATE ISDRAFT [HEAD BRANCH BASE OWNER]
S() { A deliver-step LC "$@"; }
# has PATTERN CMD...: CMD succeeds and prints a line matching PATTERN (no pipe into grep -q: SIGPIPE would leave a stale lock)
has() { hs_p=$1; shift; "$@" > "$base/has.out" || die "$* failed: $(cat "$base/has.out")"; grep -q -- "$hs_p" "$base/has.out" || die "$* printed no '$hs_p': $(cat "$base/has.out")"; }
origin() { git remote add origin https://github.com/acme/app.git; }   # never fetched or pushed
hooks() {
  origin; mkdir -p "$base/hooks"; cp "$tl_agents/githooks/pre-commit" "$tl_agents/githooks/human.sh" "$base/hooks/"; chmod +x "$base/hooks/pre-commit"
  git config core.hooksPath "$base/hooks"
}
tasks_in_tasks() { sed 's#^  dir: .agents/tasks#  dir: tasks#' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml; }   # the fixtures keep task files in tasks/
pushed() { git update-ref "refs/remotes/origin/$(git branch --show-current)" HEAD; A approval-consume "$1" push >/dev/null; }   # what git push and pre-push do

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
  grep -q 'WARNING: no CI check runs on pull requests here. proofline merge does not merge a PR that has no checks.' "$base/plan.out" || die "no CI warning: $(cat "$base/plan.out")"
  grep -q '^  fix: /proofline task Add a GitHub Actions workflow' "$base/plan.out" || die "no fix line"
  printf '7\n' > .agents/local/deliver/LC/PR; A deliver-plan LC >/dev/null
  [ ! -e .agents/local/deliver/LC/PR ] || die "a re-plan kept the old pull request number"
  ok "deliver: the summary warns under the merge step when no workflow runs on pull requests"
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
  [ "$rc" = 1 ] && [ "$(sed -n 1p "$base/ci.out")" = 'ci: absent' ] && [ "$(sed -n 2p "$base/ci.out")" = 'no CI check runs on pull requests here. proofline merge does not merge a PR that has no checks.' ] || die "no workflow: rc=$rc $(cat "$base/ci.out")"
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
  git remote set-url origin https://gitlab.com/acme/app.git; rm $wf/b.yaml
  has '^ci: unknown (not a GitHub repository)$' A ci-check
  # the task line: commands from the config, a valid line when none exist
  has '^/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: (none found; add yours); test: (none found; add yours)' A ci-task-command
  sed 's#^  build:$#  build: npm run build#; s#^  test:$#  test: npm test#' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml
  has '^/proofline task Add a GitHub Actions workflow that runs on pull_request and runs: build: npm run build; test: npm test' A ci-task-command
  [ "$(A ci-task-command | wc -l | tr -d ' ')" = 1 ] || die "ci-task-command is not one line"
  ok "ci-check: present for pull_request in every form, absent for push-only and comments, unknown off GitHub; ci-task-command uses the config"
}

run_sc scenario_normal_chain
run_sc scenario_content_change_stops
run_sc scenario_failed_refused
run_sc scenario_reopened_run_delivers
run_sc scenario_task_moves_to_done
run_sc scenario_task_move_skipped
run_sc scenario_summary_warns_without_ci
run_sc scenario_task_done_noop
run_sc scenario_ci_check
echo 'deliver tests passed'
