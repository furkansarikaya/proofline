#!/bin/sh
# shellcheck disable=SC2015,SC2016,SC2329 # test code: assertion chains, literal text
# Self-tests for `agent.sh next-user` (A159): the one table behind the "Next step:" line that ends every
# /proofline command. The suggestion is always a user command or a user action, never an internal one.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# the allowed shapes of a suggestion: a /proofline or proofline command, or an explicit user action
shape='^Next step: (/proofline |proofline |run proofline |reply |commit |commit or stash |fix what )'
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

sc_every_state() {
  new_repo
  [ -n "$(NU --commands)" ] || die "next-user --commands is empty"
  every_command none
  for s in active question codedone finished failed; do state_run "$s"; every_command "$s"; done
  ok "every command in every run state ends in a user command and never names agent.sh"
}

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

run_sc sc_every_state
run_sc sc_expected_steps
run_sc sc_errors
run_sc sc_unknown_command
echo 'next-user tests passed'
