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
  git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG || die "the approved commit was blocked"
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
  S commit >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG
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
  A knowledge-done LC not_applicable >/dev/null
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

run_sc scenario_normal_chain
run_sc scenario_content_change_stops
run_sc scenario_failed_refused
run_sc scenario_reopened_run_delivers
echo 'deliver tests passed'
