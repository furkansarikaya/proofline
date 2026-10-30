#!/bin/sh
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents and base come from test-lib.sh
# A169: a red CI after the pull request is open is a finding. `deliver-step <ID> ci-fix <PR>` reads the error, opens a fix round
# through amend, and the fix is pushed to the SAME pull request branch (ci-commit, ci-push, ci-merge) under the user's delivery
# approval, at most twice; then one question. Also: the run's own delivery commit does not make the plan stale.
# Nothing is pushed to GitHub: a local bare repository named `bare` takes the real pushes (so the real pre-commit and pre-push
# hooks run), origin is a fake GitHub URL whose tracking ref the test sets by hand, and gh is a PATH shim answering from files
# (accepted only under the self-test switch, as for proofline merge).
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
mkdir -p "$base/bin"
printf '#!/bin/sh\ncase "$1 $2" in\n  "run list") cat "%s/gh.runs" ;;\n  "run view") cat "%s/gh.log" ;;\n  "pr checks") cat "%s/gh.checks" ;;\n  *) cat "%s/ghstate" ;;\nesac\n' "$base" "$base" "$base" "$base" > "$base/bin/gh"; chmod +x "$base/bin/gh"
: > "$base/gh.runs"; : > "$base/gh.log"; : > "$base/gh.checks"
PATH=$base/bin:$PATH PROOFLINE_SELFTEST=1 PROOFLINE_NO_TTY=1; export PATH PROOFLINE_SELFTEST PROOFLINE_NO_TTY
gh_says() { printf '%s %s\n' "$1" "${2:-$(git rev-parse HEAD) proofline/LC-lookup main acme}" > "$base/ghstate"; }   # STATE ISDRAFT [HEAD BRANCH BASE OWNER]
S() { A deliver-step LC "$@"; }
has() { hs_p=$1; shift; "$@" > "$base/has.out" 2>&1 || die "$* failed: $(cat "$base/has.out")"; grep -q -- "$hs_p" "$base/has.out" || die "$* printed no '$hs_p': $(cat "$base/has.out")"; }
tasks_in_tasks() { sed 's#^  dir: .agents/tasks#  dir: tasks#' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml; }
q_has() { A questions LC > "$base/q.out" 2>&1; grep -q -- "$1" "$base/q.out" || die "$2: $(cat "$base/q.out")"; }
next_has() { A next LC > "$base/nx.out" 2>&1 || die "next failed: $(cat "$base/nx.out")"; grep -q -- "$1" "$base/nx.out" || die "$2: $(cat "$base/nx.out")"; }
ledger_n() { grep -c " event=$1 " .agents/runs/LC/LEDGER.log || true; }
hooks() {
  git remote add origin https://github.com/acme/app.git; git init -q --bare "$base/bare.git"; git remote add bare "$base/bare.git"
  mkdir -p "$base/hooks"; cp "$tl_agents/githooks/pre-commit" "$tl_agents/githooks/pre-push" "$tl_agents/githooks/human.sh" "$base/hooks/"; chmod +x "$base/hooks/pre-commit" "$base/hooks/pre-push"
  git config core.hooksPath "$base/hooks"
}
ci_red() { printf '%s completed failure build\n' "${1:-123}" > "$base/gh.runs"; printf 'build\tRun tests\t2026-01-01T00:00:00Z %s\n' "${2:-AssertionError: lookup returned the wrong value for an empty key}" > "$base/gh.log"; }
ci_green() { printf '123 completed success build\n' > "$base/gh.runs"; : > "$base/gh.log"; }
push_real() { # what the lead does after ci-push / push: a real git push through the pre-push hook, then origin's tracking ref
  git push -q bare proofline/LC-lookup 2> "$base/push.err" || die "the approved push was blocked: $(cat "$base/push.err")"
  git update-ref refs/remotes/origin/proofline/LC-lookup HEAD
}
# to_pr_open: a delivery that reached the merge step (the pull request is open, number 7, the delivery approval used)
to_pr_open() {
  SC_BRANCH=1 scaffold orchestrated yes; tasks_in_tasks; to_code_done orchestrated; hooks; finish_done
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused: $(tail -2 "$base/plan.out")"
  capture 'approve delivery'; A approve-pending LC >/dev/null
  deliver_approved
}
deliver_approved() { # the user's one reply (or the batch cover) is in place: the whole chain up to the merge step
  S commit >/dev/null; A task-source-done LC >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/COMMIT_MSG 2> "$base/commit.err" || die "the delivery commit was blocked: $(cat "$base/commit.err")"
  S push >/dev/null; push_real
  S pr >/dev/null; gh_says "OPEN false"; S merge 7 >/dev/null
}
# ci_round N: one whole CI-fix round, from the red check to the recorded push
ci_round() {
  ci_red "$((120 + $1))"; gh_says "OPEN false"
  S ci-fix 7 > "$base/cf$1.out" 2>&1 || die "ci-fix $1 refused: $(tail -3 "$base/cf$1.out")"
  worker FIX pass impl.txt "impl: CI fix $1"
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null
  finish_done '' '## Reopen History' "Reopened for CI fix $1 after a red check of the pull request."
  S ci-commit 7 > "$base/cc$1.out" 2>&1 || die "ci-commit $1 refused: $(tail -3 "$base/cc$1.out")"
  git add -A; git commit -qF ".agents/local/deliver/LC/ci-fix-00$1.msg" 2> "$base/commit.err" || die "the CI-fix commit $1 was blocked: $(cat "$base/commit.err")"
  S ci-push 7 > "$base/cp$1.out" 2>&1 || die "ci-push $1 refused: $(tail -3 "$base/cp$1.out")"
  push_real
  gh_says "OPEN false"; S ci-merge 7 > "$base/cm$1.out" 2>&1 || die "ci-merge $1 refused: $(tail -3 "$base/cm$1.out")"
}
rec_field() { sed -n "s/^$2: \"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" ".agents/runs/LC/ci-fix/$1.yaml" | head -1; }

# a red CI opens a fix round without asking, the fix goes to the same pull request, the ledger shows which push belongs to which fix
sc_ci_fix_normal() {
  to_pr_open
  # forbidden: a CI fix when nothing is red, for another pull request, or for a pull request at another head
  ci_green; expect_msg "ci-fix while the CI is green" 'shows no failed check' S ci-fix 7
  [ ! -e .agents/runs/LC/ci-fix ] && [ "$(ledger_n ci-fix-open)" = 0 ] || die "a refused ci-fix left a record"
  ci_red 123
  expect_msg "ci-fix for another pull request number" "pull request 8 is not this delivery's" S ci-fix 8
  gh_says "OPEN false" "$(git rev-parse HEAD^) proofline/LC-lookup main acme"
  expect_msg "ci-fix on a pull request at another head" "not this delivery's open" S ci-fix 7
  gh_says "OPEN false" "$(git rev-parse HEAD) proofline/LC-lookup main forker"
  expect_msg "ci-fix on a fork's pull request" "not this delivery's open" S ci-fix 7
  gh_says "OPEN false"
  # open: no question, the run is reopened inside the frozen scope, the error is in the record
  S ci-fix 7 > "$base/open.out" 2>&1 || die "ci-fix refused: $(tail -3 "$base/open.out")"
  grep -q 'CI-fix attempt 1 of 2 opened for pull request 7' "$base/open.out" || die "no attempt line: $(cat "$base/open.out")"
  expect_state execution state AMENDING; expect_state handoff state IMPLEMENTING
  [ "$(A questions LC)" = "no pending questions: LC" ] || die "a CI fix asked the user"
  grep -q 'AssertionError' .agents/runs/LC/ci-fix/001.log || die "the error of the failed run is not in the log"
  [ "$(rec_field 001 ci_run)" = 123 ] && [ "$(rec_field 001 state)" = open ] || die "record: $(cat .agents/runs/LC/ci-fix/001.yaml)"
  grep -q '^authorized_by: user delivery approval ' .agents/runs/LC/gates/*-REOPEN.yaml || die "the reopen does not name the delivery approval"
  # resume / repeat: the same attempt, not a second one; no new delivery summary during the round; nothing to commit yet
  has 'attempt 1 of 2 is in progress' S ci-fix 7
  [ "$(ledger_n ci-fix-open)" = 1 ] || die "a repeated ci-fix opened another attempt"
  expect_msg "deliver-plan during a CI-fix round" 'CI-fix round' A deliver-plan LC
  expect_msg "ci-commit before the fix is done" 'fix round is not finished' S ci-commit 7
  # the fix: the normal fix round and gates
  worker FIX pass impl.txt 'impl: CI fix 1'
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null
  expect_msg "ci-commit before the report and DONE" 'fix round is not finished' S ci-commit 7
  finish_done '' '## Reopen History' 'Reopened for CI fix 1 after a red check of the pull request.'
  has 'git commit -F .agents/local/deliver/LC/ci-fix-001.msg' S ci-commit 7
  ls .agents/runs/LC/approvals/*-commit.yaml | tail -1 | xargs grep -q '^source: "delivery_ci_fix"' || die "the commit approval is not the delivery's CI-fix approval"
  expect_msg "ci-push before the commit" 'not committed yet' S ci-push 7
  # forbidden: a commit that holds more than the gated content, and a second commit
  printf 'late\n' > late.txt; git add -A
  expect_fail "a CI-fix commit with an extra file" git commit -qF .agents/local/deliver/LC/ci-fix-001.msg
  git rm -q --cached late.txt; rm late.txt
  git add -A; git commit -qF .agents/local/deliver/LC/ci-fix-001.msg 2> "$base/commit.err" || die "the CI-fix commit was blocked: $(cat "$base/commit.err")"
  expect_fail "a second commit under the same approval" git commit -q --allow-empty -m 'chore: more'
  has 'git push origin proofline/LC-lookup' S ci-push 7
  pa=$(ls .agents/runs/LC/approvals/*-push.yaml | tail -1)
  grep -q '^source: "delivery_ci_fix"' "$pa" && grep -q '^ref: "refs/heads/proofline/LC-lookup"' "$pa" && grep -q '^consumed: "false"' "$pa" || die "push approval: $(cat "$pa")"
  # forbidden: the approval does not carry a push to another branch, nor a tag; it stays unused
  rc=0; git push bare proofline/LC-lookup:refs/heads/other > "$base/other.out" 2>&1 || rc=$?
  [ "$rc" != 0 ] && grep -q 'not for a push to refs/heads/other' "$base/other.out" || die "a push to another branch was not refused: $(cat "$base/other.out")"
  [ -z "$(git ls-remote bare refs/heads/other)" ] || die "the other branch exists on the remote"
  grep -q '^consumed: "false"' "$pa" || die "the refused push consumed the approval"
  head_before=$(git rev-parse HEAD); old=$(git rev-parse HEAD^)
  push_real
  [ "$(git ls-remote bare refs/heads/proofline/LC-lookup | cut -f1)" = "$head_before" ] || die "the fix is not on the pull request branch"
  grep -q '^consumed: "true"' "$pa" || die "the push did not consume its approval"
  # forbidden: another push needs another approval
  expect_fail "a second use of the push approval" A approval-consume LC push '' refs/heads/proofline/LC-lookup
  gh_says "OPEN false"; has 'run: proofline merge 7' S ci-merge 7
  [ "$(rec_field 001 state)" = pushed ] && [ "$(rec_field 001 pushed_head)" = "$head_before" ] && [ "$(rec_field 001 failing_head)" = "$old" ] || die "record after the push: $(cat .agents/runs/LC/ci-fix/001.yaml)"
  grep " event=ci-fix-push " .agents/runs/LC/LEDGER.log | grep -q "attempt=1 pr=7 ci_run=123 from=$old to=$head_before" || die "the ledger does not tie the push to the fix"
  [ "$(ledger_n ci-fix-grant)" = 2 ] && [ "$(ledger_n ci-fix-open)" = 1 ] || die "ledger: $(grep -c ci-fix .agents/runs/LC/LEDGER.log) ci-fix lines"
  A verify-seal LC >/dev/null || die "the ledger seal broke"
  # merged: cleanup works over the delivery commit and the CI-fix commit
  gh_says "MERGED false"
  S cleanup 7 >/dev/null || die "cleanup after the CI fix refused: $(S cleanup 7 2>&1 | tail -1)"
  [ ! -e .agents/runs/LC ] && [ ! -e .agents/local/deliver/LC ] || die "the run survived the delivery"
  ok "ci-fix: a red CI opens a fix round without a question, the fix is pushed to the same PR branch, other refs and other pushes are refused, the ledger ties push to fix"
}

# A186: the failed log cannot be read: the round starts from the check name and status alone, and every output says so
sc_ci_fix_unreadable() {
  to_pr_open
  printf '124 completed failure build\n' > "$base/gh.runs"; : > "$base/gh.log"; gh_says "OPEN false"
  S ci-fix 7 > "$base/un.out" 2>&1 || die "ci-fix refused when the log is unreadable: $(tail -3 "$base/un.out")"
  grep -q '^NOTE: the log of the failed check could not be read on this platform; this round starts from the check name (build) and status (failure) only' "$base/un.out" || die "no NOTE: $(cat "$base/un.out")"
  grep -q 'starts from the check name and status only' .agents/runs/LC/ci-fix/001.log || die "the log file does not say so: $(cat .agents/runs/LC/ci-fix/001.log)"
  [ "$(rec_field 001 ci_run)" = 124 ] && [ "$(rec_field 001 state)" = open ] || die "record: $(cat .agents/runs/LC/ci-fix/001.yaml)"
  ok "ci-fix: an unreadable log still opens the round from check name and status and says so (A186)"
}

# two attempts, then the third red CI stops with one question
sc_ci_fix_limit() {
  to_pr_open
  ci_round 1; ci_round 2
  [ "$(rec_field 001 state)" = pushed ] && [ "$(rec_field 002 state)" = pushed ] || die "records after two rounds"
  ci_red 130 'Error: still failing'; gh_says "OPEN false"
  rc=0; S ci-fix 7 > "$base/stop.out" 2>&1 || rc=$?
  [ "$rc" != 0 ] || die "a third red CI opened a third attempt"
  grep -q 'CI fix limit reached for pull request 7' "$base/stop.out" && grep -q 'attempt 1: CI run 121' "$base/stop.out" && grep -q 'attempt 2: CI run 122' "$base/stop.out" && grep -q 'STOP: the CI is red after 2 CI-fix attempts' "$base/stop.out" || die "stop report: $(cat "$base/stop.out")"
  grep -q 'still failing' "$base/stop.out" || die "the stop report lacks the current error"
  [ "$(ledger_n ci-fix-open)" = 2 ] && [ "$(ledger_n ci-fix-stop)" = 1 ] || die "ledger after the stop"
  q_has 'still red after 2 CI-fix attempts' "no question"
  expect_state execution awaiting_input true
  # the stop is final: no third attempt, no second question, no more grants
  expect_fail "a third ci-fix" S ci-fix 7
  A questions LC > "$base/q.out"; [ "$(grep -c '=== QUESTION' "$base/q.out")" = 1 ] || die "a repeated stop asked again"
  [ "$(ledger_n ci-fix-open)" = 2 ] || die "a repeated stop used an attempt"
  expect_msg "ci-commit after the last attempt" 'not open for a commit' S ci-commit 7
  [ -n "$(sed -n '/^=== QUESTION/{n;p;q;}' "$base/q.out")" ] || die "the batch reads no first question line"
  ok "ci-fix: two attempts, then the third red CI stops with one question (a batch parks the task on it)"
}

# batch: the batch approval's delivery cover carries the same rounds, with no new capture; the stop is the question a batch parks on
sc_ci_fix_batch() {
  tl_ensure_template; tpl_p=$(mktemp -d "$base/tpl.XXXXXX"); cp -R "$tl_template/." "$tpl_p/"; tl_template=$tpl_p
  for s in "$tl_agents"/scripts/*.sh; do case "$(basename "$s")" in *-test.sh|test-lib.sh|agent.sh|exec-policy.sh|secret-scan.sh) continue ;; esac; cp "$s" "$tl_template/.agents/scripts/"; done
  mkdir -p "$tl_template/.agents/tasks"; printf '# Task: LC — title of LC\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nCOMPLEX\n' > "$tl_template/.agents/tasks/LC.md"
  SC_BRANCH=1 scaffold orchestrated
  A batch-plan all > "$base/bp.out" 2>&1 || die "batch-plan refused: $(tail -3 "$base/bp.out")"
  capture 'approve batch'; A approve-pending >/dev/null
  to_code_done orchestrated; hooks; finish_done
  A deliver-plan LC > "$base/plan.out" || die "deliver-plan refused: $(tail -2 "$base/plan.out")"
  A batch-cover LC delivery >/dev/null || die "batch-cover delivery refused"
  bp=$(ls .agents/runs/LC/approvals/*-push.yaml | tail -1)
  grep -q '^source: "batch"' "$bp" && grep -q '^ref: "refs/heads/proofline/LC-lookup"' "$bp" || die "the covered push approval lacks the batch source or the ref: $(cat "$bp")"
  rm -f .agents/local/prompts/*.json   # no user reply exists from here on: the rest must run on the covers alone
  deliver_approved
  ci_round 1
  grep -q 'source: "delivery_ci_fix"' .agents/runs/LC/approvals/*-push.yaml || die "no CI-fix push approval under the batch delivery cover"
  expect_fail "a push to another branch under the batch cover" sh -c "git push bare proofline/LC-lookup:refs/heads/other 2>/dev/null"
  ci_round 2
  ci_red 130 'Error: still failing'; gh_says "OPEN false"
  expect_msg "a third attempt in a batch" 'STOP: the CI is red after 2 CI-fix attempts' S ci-fix 7
  [ "$(ls .agents/local/prompts/ 2>/dev/null | wc -l | tr -d ' ')" = 0 ] || die "a prompt capture appeared: the round asked the user"
  q_has 'still red after 2 CI-fix attempts' "the question a batch parks on is missing"; [ -n "$(sed -n '/^=== QUESTION/{n;p;q;}' "$base/q.out")" ] || die "the batch reads no first question line"
  ok "ci-fix (batch): the batch delivery cover carries two rounds to the same PR branch with no user reply; the third red CI leaves the question a batch parks on"
}

# resume: a new process finds the CI step from the records alone
sc_ci_fix_resume() {
  to_pr_open
  next_has '^next=gh pr checks 7 --watch --fail-fast$' "next with an open pull request"; next_has 'agent.sh deliver-step LC ci-fix 7' "next names no ci-fix"; next_has 'cleanup 7' "next names no cleanup"
  ci_red 123; gh_says "OPEN false"
  S ci-fix 7 >/dev/null || die "ci-fix refused"
  next_has '^next=dispatch.sh LC implementer$' "next does not name the fix round"
  worker FIX pass impl.txt 'impl: CI fix 1'
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null
  finish_done '' '## Reopen History' 'Reopened for CI fix 1.'
  next_has '^next=agent.sh deliver-step LC ci-commit 7$' "next after DONE"
  S ci-commit 7 >/dev/null; git add -A; git commit -qF .agents/local/deliver/LC/ci-fix-001.msg 2> "$base/commit.err" || die "commit: $(cat "$base/commit.err")"
  next_has '^next=agent.sh deliver-step LC ci-push 7$' "next after the commit"
  S ci-push 7 >/dev/null; push_real; gh_says "OPEN false"
  next_has '^next=agent.sh deliver-step LC ci-merge 7$' "next after the push"
  S ci-merge 7 >/dev/null
  next_has 'gh pr checks 7 --watch' "next after ci-merge"
  A digest LC > "$base/dg.out" 2>&1 || die "digest of a run over its delivery commit: $(tail -2 "$base/dg.out")"
  ok "ci-fix: resume finds the CI step of an open pull request and every step of an open CI-fix round from the records"
}

# the run's own delivery commit and its task file / knowledge documents do not make the plan stale; other product changes still do
sc_own_commits_fresh() {
  SC_BRANCH=1 scaffold orchestrated yes; tasks_in_tasks; to_code_done orchestrated
  mkdir -p docs/wiki .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/   # knowledge-done (A200) needs the lint installed and a page that passes it
  printf -- '---\ntitle: lookup\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Lookup\n\nThe lookup returns the stored value.\n' > docs/wiki/lookup.md
  A knowledge-done LC >/dev/null
  write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  A task-source-done LC >/dev/null
  git add docs tasks; git -c core.hooksPath=/dev/null commit -qm 'docs: knowledge and task file'
  has "this run's task file and knowledge documents" A freshness LC
  base_now=$(sed -n 's/^  base_sha: //p' .agents/runs/LC/RUN.yaml | head -1)
  [ "$base_now" != "$(git rev-parse HEAD)" ] || die "an own-bookkeeping commit moved base_sha (the knowledge readers start from it)"
  A freshness LC >/dev/null || die "the second freshness check refused"
  [ "$(grep -c "this run's task file and knowledge documents" .agents/runs/LC/LEDGER.log)" = 1 ] || die "the accepted range is not ledgered exactly once"
  # a product file in the range keeps the plan stale, as before
  printf 'x\n' > product.txt; git add product.txt; git -c core.hooksPath=/dev/null commit -qm 'feat: someone else'
  expect_msg "a product change in the range" 'stale plan' A freshness LC
  expect_msg "the stale message does not blame the run's own files" 'product.txt' A freshness LC
  ok "freshness: the run's own task file move and knowledge documents leave the plan fresh, a product file in the range still stales it"
}

# the delivery commit itself: the run is judged from base_sha while HEAD is its own chain; any other commit ends that
sc_delivery_commit_fresh() {
  to_pr_open
  A freshness LC > "$base/fr.out" 2>&1 || die "the plan went stale after the run's own delivery commit: $(tail -2 "$base/fr.out")"
  A verify-handoff LC >/dev/null || die "verify-handoff over the delivery commit"
  git -c core.hooksPath=/dev/null commit -q --allow-empty -m 'chore: someone else'
  expect_msg "a commit that is not the delivery's own" 'stale plan' A freshness LC
  ok "freshness: the run's own delivery commit does not stale the plan; another commit on top does"
}

# someone else's docs commit is not the run's own: the plan is stale as before; so is a changed knowledge file or an unrecorded task file move
sc_own_commits_foreign() {
  SC_BRANCH=1 scaffold orchestrated yes; tasks_in_tasks; to_code_done orchestrated
  mkdir -p docs/wiki .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/   # knowledge-done (A200) needs the lint installed and a page that passes it
  printf -- '---\ntitle: lookup\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Lookup\n\nThe lookup returns the stored value.\n' > docs/wiki/lookup.md
  A knowledge-done LC >/dev/null
  write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  printf '# Other\n\nsomeone else wrote this page\n' > docs/wiki/other.md
  git add docs/wiki/other.md; git -c core.hooksPath=/dev/null commit -qm 'docs: another page'
  expect_msg "a foreign docs commit in the range" 'stale plan' A freshness LC
  expect_msg "the stale message names the foreign page" 'docs/wiki/other.md' A freshness LC
  git reset -q --hard HEAD^   # back to the base: only the run's own page, changed afterwards, remains to be tried
  git add docs/wiki/lookup.md; printf 'edited by someone after the knowledge step\n' >> docs/wiki/lookup.md; git add docs/wiki/lookup.md; git -c core.hooksPath=/dev/null commit -qm 'docs: edit the run page'
  expect_msg "the run's knowledge file with other content" 'stale plan' A freshness LC
  ok "freshness: a docs commit that is not the run's own knowledge file stays a stale plan"
}

# a role that is not the lead still runs the read-only commands (next-user, in-knowledge-scope)
sc_read_only_roles() {
  SC_BRANCH=1 scaffold orchestrated
  for r in reviewer implementer qa verifier; do
    AS "$r" in-knowledge-scope docs/wiki/page.md > "$base/ro.out" 2>&1 || die "$r cannot run in-knowledge-scope: $(cat "$base/ro.out")"
    AS "$r" next-user run LC > "$base/ro.out" 2>&1 || die "$r cannot run next-user: $(cat "$base/ro.out")"
  done
  expect_fail "in-knowledge-scope on a product path" AS reviewer in-knowledge-scope impl.txt
  ok "roles: next-user and in-knowledge-scope are read-only commands every role may run"
}

run_sc sc_ci_fix_normal
run_sc sc_ci_fix_limit
run_sc sc_ci_fix_unreadable
run_sc sc_ci_fix_batch
run_sc sc_ci_fix_resume
run_sc sc_own_commits_fresh
run_sc sc_delivery_commit_fresh
run_sc sc_own_commits_foreign
run_sc sc_read_only_roles
echo 'cifix tests passed'
