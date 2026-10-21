#!/bin/sh
# shellcheck disable=SC2015,SC2016,SC2329 # test code: assertion chains, literal text
# Self-tests for `agent.sh next-user` (A159): the one table behind the "Next step:" line that ends every
# /proofline command. The suggestion is always a user command or a user action, never an internal one.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# the allowed shapes of a suggestion: a /proofline or proofline command, or an explicit user action
shape='^Next step: (/proofline |driver started, |wait for the driver |proofline |run proofline |reply |commit |commit or stash |fix what )'
NU() { sh ./.agents/scripts/agent.sh next-user "$@"; }
# every_command STATE: every command of the table gives exactly one user-facing line in this run state
every_command() {
  for c in $(NU --commands); do
    out=$(NU "$c" 2>&1) || die "$1: next-user $c failed: $out"
    [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] || die "$1: next-user $c printed more than one line: $out"
    printf '%s\n' "$out" | grep -Eq "$shape" || die "$1: next-user $c is not a user command: $out"
    ! printf '%s' "$out" | grep -Fq 'agent.sh' || die "$1: next-user $c names an internal command: $out"
    ! printf '%s' "$out" | grep -Eq '<TASK-ID>|\{[A-Z]+\}|<ID>' || [ "$1" = none ] || die "$1: next-user $c left a placeholder: $out"
  done
}
# state_run STATE: a fixture run in the named state (cwd inside it)
state_run() {
  scaffold orchestrated
  case "$1" in
    active) ;;
    question) sed 's/^  awaiting_input: false/  awaiting_input: true/' .agents/runs/LC/RUN.yaml > .agents/runs/LC/RUN.tmp && mv .agents/runs/LC/RUN.tmp .agents/runs/LC/RUN.yaml ;;
    codedone) to_code_done orchestrated ;;
    finished) to_code_done orchestrated; A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null; write_report; A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null ;;
    failed) printf 'reason: the environment lacks the database the lookup needs to be proven\nevidence: the staging database is unreachable from this environment\n' | A terminate LC BLOCKED >/dev/null ;;
  esac
}

# Every run state is its own unit (one unit held the whole suite's slowest work): the same checks, split by state.
sc_every_state_none() {
  new_repo
  [ -n "$(NU --commands)" ] || die "next-user --commands is empty"
  every_command none
  ok "every command with no run ends in a user command and never names agent.sh"
}
sc_every_state_run() { # STATE
  state_run "$1"; every_command "$1"
  ok "every command in the $1 run state ends in a user command and never names agent.sh"
}
sc_every_state_active() { sc_every_state_run active; }
sc_every_state_question() { sc_every_state_run question; }
sc_every_state_codedone() { sc_every_state_run codedone; }
sc_every_state_finished() { sc_every_state_run finished; }
sc_every_state_failed() { sc_every_state_run failed; }

sc_expected_steps() {
  new_repo
  [ "$(NU status)" = 'Next step: /proofline task --grill' ] || die "no run, nothing queued: $(NU status)"
  state_run active
  [ "$(NU status)" = 'Next step: /proofline resume' ] || die "active run: $(NU status)"
  [ "$(NU deliver)" = 'Next step: /proofline resume' ] || die "deliver on an active run: $(NU deliver)"
  state_run question
  NU status | grep -Fq 'reply in this session to the open question' || die "question: $(NU status)"
  state_run codedone
  [ "$(NU status)" = 'Next step: /proofline deliver LC' ] || die "CODE_DONE: $(NU status)"
  [ "$(NU knowledge LC)" = 'Next step: /proofline deliver LC' ] || die "knowledge on CODE_DONE: $(NU knowledge LC)"
  NU deliver LC | grep -Fq 'approve delivery' || die "deliver on CODE_DONE: $(NU deliver LC)"
  state_run failed
  [ "$(NU status)" = 'Next step: /proofline reopen LC' ] || die "BLOCKED run: $(NU status)"
  [ "$(NU knowledge LC)" = 'Next step: /proofline reopen LC' ] || die "knowledge on a BLOCKED run: $(NU knowledge LC)"
  [ "$(NU init)" = 'Next step: /proofline doctor' ] || die "init: $(NU init)"
  [ "$(NU product prd pay)" = 'Next step: /proofline product review pay' ] || die "product prd: $(NU product prd pay)"
  [ "$(NU product review pay)" = 'Next step: /proofline product split pay' ] || die "product review: $(NU product review pay)"
  mkdir -p docs/product/pay; printf 'verdict: do-not-ship\n' > docs/product/pay/REVIEW.md
  NU product review pay | grep -Fq 'revise the PRD' || die "product review do-not-ship: $(NU product review pay)"
  NU product split pay | grep -Fq '/proofline' || die "product split: $(NU product split pay)"
  [ "$(NU trace FR-1)" = 'Next step: /proofline status' ] || die "trace: $(NU trace FR-1)"
  ok "the table gives the expected next command for none, active, question, CODE_DONE and FAILED"
}

sc_errors() {
  new_repo
  state_run codedone
  [ "$(NU deliver LC --error)" = 'Next step: /proofline knowledge LC' ] || die "deliver refused on an open knowledge step: $(NU deliver LC --error)"
  [ "$(NU deliver LC --error=knowledge)" = 'Next step: /proofline knowledge LC' ] || die "--error=knowledge: $(NU deliver LC --error=knowledge)"
  [ "$(NU merge LC --error=dirty-tree)" = 'Next step: commit or stash your changes yourself, then run /proofline merge LC again' ] || die "--error=dirty-tree: $(NU merge LC --error=dirty-tree)"
  [ "$(NU run --error=usage)" = 'Next step: proofline help' ] || die "--error=usage: $(NU run --error=usage)"
  NU doctor --error=doctor | grep -Fq 'run /proofline doctor again' || die "--error=doctor: $(NU doctor --error=doctor)"
  state_run failed
  [ "$(NU run LC --error)" = 'Next step: /proofline reopen LC' ] || die "run refused on a BLOCKED run: $(NU run LC --error)"
  for k in not-installed dirty-tree knowledge failed-run doctor usage nonsense; do
    ! NU status LC --error="$k" | grep -Fq 'agent.sh' || die "--error=$k names an internal command"
  done
  # outside an installed project the fix is to install it
  mkdir "$base/bare"; ( cd "$base/bare" && git init -q . && [ "$(PROOFLINE_ROOT=$PWD sh "$tl_agents/scripts/next-user.sh" doctor --error)" = 'Next step: proofline init' ] ) || die "not installed: no 'proofline init' suggestion"
  ok "an error suggestion is the command that fixes the error (knowledge, dirty tree, failed run, usage, doctor, not installed)"
}

sc_unknown_command() {
  new_repo
  ! NU frobnicate >/dev/null 2>&1 || die "an unknown command was accepted"
  ok "an unknown command is refused"
}

# ci_absent_fixture: a GitHub origin and no workflow, so `ci-check` says absent
ci_absent_fixture() { git remote add origin https://github.com/acme/widgets.git; mkdir -p .github/workflows; rm -f .github/workflows/*; }
ci_line() { A ci-task-command; }

sc_ci_rows() {
  state_run codedone   # builds its own repository: the CI fixture comes after it
  ci_absent_fixture
  want="Next step: $(ci_line)"
  case "$want" in 'Next step: /proofline task Add a GitHub Actions workflow that runs on pull_request'*) ;; *) die "ci task command: $want" ;; esac
  [ "$(NU deliver LC)" = "$want" ] || die "deliver on CODE_DONE without CI: $(NU deliver LC)"
  [ "$(NU deliver LC --error=ci)" = "$want" ] || die "--error=ci: $(NU deliver LC --error=ci)"
  [ "$(NU status)" = 'Next step: /proofline deliver LC' ] || die "status is not about CI: $(NU status)"
  state_run finished; ci_absent_fixture
  [ "$(NU deliver LC)" = "$want" ] || die "deliver on a finished run without CI: $(NU deliver LC)"
  [ "$(NU merge LC --error)" = "$want" ] || die "merge refused without CI: $(NU merge LC --error)"
  # a pull_request workflow exists: the delivery approval step is back
  mkdir -p .github/workflows; printf 'name: ci\non: pull_request\njobs: {}\n' > .github/workflows/ci.yml
  NU deliver LC | grep -Fq 'approve delivery' || die "deliver with CI: $(NU deliver LC)"
  ok "deliver and --error=ci give the ready CI task line when no pull_request workflow exists"
}

sc_deliver_records() {
  state_run finished
  rm -rf .agents/tasks; mkdir -p .agents/tasks/todo
  NU deliver LC | grep -Fq 'approve delivery' || die "deliver before any step: $(NU deliver LC)"
  # the merge step started (deliver/<ID>/PR) and the run is still there: the merge stopped, e.g. at a red check
  mkdir -p .agents/local/deliver/LC; printf '7\n' > .agents/local/deliver/LC/PR
  [ "$(NU deliver LC)" = 'Next step: proofline merge 7' ] || die "deliver stopped at the merge: $(NU deliver LC)"
  [ "$(NU deliver)" = 'Next step: proofline merge 7' ] || die "deliver (active run) stopped at the merge: $(NU deliver)"
  printf 'x; rm -rf /\n' > .agents/local/deliver/LC/PR
  NU deliver LC | grep -Fq 'approve delivery' || die "a PR file that is not a number is ignored: $(NU deliver LC)"
  printf '7\n' > .agents/local/deliver/LC/PR
  # cleanup consumed: delivered, whatever else is left
  mkdir -p .agents/runs/LC/approvals
  printf 'kind: "cleanup"\nconsumed: "true"\nconsumed_at: 1\n' > .agents/runs/LC/approvals/009-cleanup.yaml
  [ "$(NU deliver LC)" = 'Next step: /proofline task --grill' ] || die "delivered, nothing queued: $(NU deliver LC)"
  printf '# Task: NEXT-8 — queued\n' > .agents/tasks/todo/NEXT-8.md
  [ "$(NU deliver LC)" = 'Next step: /proofline run NEXT-8' ] || die "delivered, NEXT-8 queued: $(NU deliver LC)"
  ok "deliver: a merge that stopped gives proofline merge <PR>, a delivered run gives the next task, never approve delivery"
}

sc_delivery_finished() {
  new_repo
  rm -rf .agents/tasks; mkdir -p .agents/tasks/todo
  [ "$(NU deliver LC)" = 'Next step: /proofline task --grill' ] || die "deliver, nothing queued: $(NU deliver LC)"
  [ "$(NU clean)" = 'Next step: /proofline task --grill' ] || die "clean, nothing queued: $(NU clean)"
  printf '# Task: NEXT-7 — queued\n' > .agents/tasks/todo/NEXT-7.md
  [ "$(NU deliver LC)" = 'Next step: /proofline run NEXT-7' ] || die "deliver, NEXT-7 queued: $(NU deliver LC)"
  [ "$(NU clean)" = 'Next step: /proofline run NEXT-7' ] || die "clean, NEXT-7 queued: $(NU clean)"
  [ "$(NU merge)" = 'Next step: /proofline run NEXT-7' ] || die "merge, NEXT-7 queued: $(NU merge)"
  ok "after delivery, merge or clean the next step is the next queued task, else a new task"
}

# batch fixtures: the batch scripts, one task file, a planned batch
batch_plan_fixture() {
  for s in "$tl_agents"/scripts/*.sh; do case "$(basename "$s")" in *-test.sh|test-lib.sh|agent.sh|exec-policy.sh|secret-scan.sh) continue ;; esac; cp "$s" .agents/scripts/; done
  mkdir -p .agents/tasks; printf '# Task: T-1 — one\n\n## Acceptance criteria\n\n- AC-1: it works\n\n## Suggested class\n\nCOMPLEX\n' > .agents/tasks/T-1.md
  A batch-plan T-1 >/dev/null || die "batch-plan failed"
  bdir=.agents/local/batch
}
batch_approve_fixture() { capture 'approve batch'; A approve-pending >/dev/null; }

sc_batch_rows() {
  new_repo; rm -rf .agents/tasks
  [ "$(NU batch)" = 'Next step: /proofline task --grill' ] || die "batch, nothing planned: $(NU batch)"
  batch_plan_fixture
  [ "$(NU batch T-1)" = 'Next step: reply "approve batch" in this session to start the batch' ] || die "batch, planned not approved: $(NU batch T-1)"
  batch_approve_fixture
  [ "$(NU batch)" = 'Next step: run proofline batch run in a terminal to start the batch; merged tasks are not run again' ] || die "batch, approved not started: $(NU batch)"
  [ "$(NU batch status)" = 'Next step: run proofline batch run in a terminal to resume the batch; merged tasks are not run again' ] || die "batch status, approved: $(NU batch status)"
  # stopped
  printf 'T-1\tpending\t\t\n# stopped: stopped by the user\n' > "$bdir/state.tsv"
  [ "$(NU batch)" = 'Next step: run proofline batch run in a terminal to start the batch; merged tasks are not run again' ] || die "batch, stopped: $(NU batch)"
  [ "$(NU batch stop)" = 'Next step: /proofline batch status' ] || die "batch stop: $(NU batch stop)"
  [ "$(NU batch-stop)" = 'Next step: /proofline batch status' ] || die "batch-stop: $(NU batch-stop)"
  # the driver runs
  printf 'while :; do sleep 1; done\n' > "$base/batch.sh"; sh "$base/batch.sh" & dpid=$!
  printf '%s %s\n' "$dpid" "$dpid" > "$bdir/driver.pid"; printf '%s\n' "$dpid" > "$bdir/LOCK"
  [ "$(NU batch)" = 'Next step: driver started, log: .agents/local/batch/driver.log. In the morning: /proofline batch status' ] || { kill "$dpid"; die "batch, driver running: $(NU batch)"; }
  [ "$(NU batch status)" = 'Next step: wait for the driver to finish, then run /proofline batch status again' ] || { kill "$dpid"; die "batch status, driver running: $(NU batch status)"; }
  kill "$dpid" 2>/dev/null; wait "$dpid" 2>/dev/null || :
  rm -f "$bdir/driver.pid" "$bdir/LOCK"
  # finished, nothing parked
  printf 'T-1\tmerged\t\t\n' > "$bdir/state.tsv"; rm -f .agents/tasks/T-1.md   # a delivered task file is in done/
  [ "$(NU batch status)" = 'Next step: /proofline task --grill' ] || die "batch status, finished clean: $(NU batch status)"
  [ "$(NU batch)" = 'Next step: /proofline batch status' ] || die "batch, finished: $(NU batch)"
  printf '# Task: NEXT-7 — queued\n' > .agents/tasks/NEXT-7.md
  [ "$(NU batch status)" = 'Next step: /proofline run NEXT-7' ] || die "batch status, finished clean, NEXT-7 queued: $(NU batch status)"
  # a project without CI cannot start a batch
  ci_absent_fixture
  rm -f "$bdir/state.tsv"
  [ "$(NU batch)" = "Next step: $(ci_line)" ] || die "batch without CI: $(NU batch)"
  ok "batch: ci line, unapproved, approved, stopped, driver started, stop, finished clean"
}

sc_batch_parked() {
  new_repo
  state_run question
  batch_plan_fixture; batch_approve_fixture
  q=$(NU resume LC | sed 's/^Next step: reply in this session to the open question: //')
  [ -n "$q" ] || die "no question text"
  printf 'LC\tparked\tquestion\tpending\n' > "$bdir/state.tsv"
  [ "$(NU batch status)" = "Next step: /proofline resume LC, then reply in this session to the open question: $q" ] || die "parked question: $(NU batch status)"
  state_run failed; batch_plan_fixture; batch_approve_fixture
  printf 'LC\tparked\tBLOCKED\t\n' > "$bdir/state.tsv"
  [ "$(NU batch status)" = 'Next step: /proofline reopen LC' ] || die "parked, failed run: $(NU batch status)"
  state_run codedone; batch_plan_fixture; batch_approve_fixture
  printf 'LC\tparked\ttimeout\t\n' > "$bdir/state.tsv"
  [ "$(NU batch status)" = 'Next step: /proofline deliver LC' ] || die "parked, code done: $(NU batch status)"
  state_run active; batch_plan_fixture; batch_approve_fixture
  printf 'LC\tparked\tstopped\t\n' > "$bdir/state.tsv"
  [ "$(NU batch status)" = 'Next step: /proofline resume LC' ] || die "parked, active run: $(NU batch status)"
  printf 'GONE-1\tparked\tstopped\t\n' > "$bdir/state.tsv"
  [ "$(NU batch status)" = 'Next step: /proofline run GONE-1' ] || die "parked, no run: $(NU batch status)"
  ok "batch status with a parked task names its full id and the question, or the fixing command"
}

sc_batch_every_state() {
  new_repo; rm -rf .agents/tasks
  batch_plan_fixture; batch_approve_fixture
  printf 'T-1\tparked\tquestion\tWhich database?\n' > "$bdir/state.tsv"
  for c in batch 'batch status' 'batch stop'; do
    out=$(eval "NU $c" 2>&1) || die "next-user $c failed: $out"
    printf '%s\n' "$out" | grep -Eq "$shape" || die "next-user $c is not a user command: $out"
    ! printf '%s' "$out" | grep -Eq 'agent\.sh|<TASK-ID>|\{[A-Z]+\}|<ID>' || die "next-user $c names an internal command or leaves a placeholder: $out"
  done
  ok "the batch commands end in a user command with a planned batch and a parked task"
}

run_sc sc_every_state_none
run_sc sc_every_state_active
run_sc sc_every_state_question
run_sc sc_every_state_codedone
run_sc sc_every_state_finished
run_sc sc_every_state_failed
run_sc sc_expected_steps
run_sc sc_errors
run_sc sc_unknown_command
run_sc sc_ci_rows
run_sc sc_deliver_records
run_sc sc_delivery_finished
run_sc sc_batch_rows
run_sc sc_batch_parked
run_sc sc_batch_every_state
echo 'next-user tests passed'
