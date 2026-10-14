#!/bin/sh
# shellcheck disable=SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code: ls over our own fixture names, assertion chains
# Lifecycle regression for agent.sh, ported from the source workflow: classification selecting the
# pipeline, gates bound to the exact content and to the role's artifact, mutation ownership under
# orchestrated topology, role boundaries, the fix loop, terminal outcomes, cleanup, the hash-chained
# ledger, the scripted `amend` reopen and the task-source contract. Each scenario builds a throwaway git
# repository (test-lib.sh) and drives the real agent.sh; gate verdicts enter only through `record`.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

# Standalone: the lead implements; gates still come only from the gate roles.
scenario_standalone() {
  scaffold standalone
  solo RED fail impl_test.txt 'test: lookup returns the stored value'
  solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  expect_fail "CODE_DONE without any gate" A handoff LC CODE_DONE
  A secret-scan LC >/dev/null; gpass REVIEW_SMALL
  expect_fail "CODE_DONE without QA and VERIFY" A handoff LC CODE_DONE
  gpass QA
  expect_fail "CODE_DONE without the VERIFY gate" A handoff LC CODE_DONE
  gpass VERIFY
  # a change after the gates voids all of them; nothing carries over
  printf 'late tweak\n' >> impl.txt
  expect_fail "stale gates accepted by verify-handoff" A verify-handoff LC
  expect_fail "a gate recorded on content changed since IMPLEMENTED" gpass QA
  expect_fail "CODE_DONE on content changed since IMPLEMENTED" A handoff LC CODE_DONE
  A handoff LC IMPLEMENTED >/dev/null
  expect_fail "CODE_DONE using the passes for the older content" A handoff LC CODE_DONE
  [ "$(A pipeline LC | sed -n 's/^gate.QA=//p')" = stale ] || die "an old QA pass is not reported stale"
  pass_all; A handoff LC CODE_DONE >/dev/null
  # an artifact edited after its gate voids that gate, even though the content is unchanged
  printf 'edited after the gate\n' >> .agents/runs/LC/QA_REPORT.md
  expect_fail "an edited QA report still counted" A verify-handoff LC
  expect_fail "a gate recorded after CODE_DONE" gpass QA            # rewrites the report with its gated content
  A verify-handoff LC >/dev/null
  ok "standalone lifecycle: gates bind content and artifact"
}

# A97 (S-6): GREEN and REFACTOR follow a RED record of the same path, and GREEN follows a change of the
# implementation since that RED.
scenario_evidence_order() {
  scaffold standalone
  tgt='impl.txt,impl_test.txt'
  ev() { # PHASE [TARGET]: record without touching the tree
    e_ef=''; [ "$1" = RED ] && e_ef='expected_failure: TestImpl fails: lookup is not implemented in impl.txt yet'
    printf 'command: go test ./...\ntarget: %s\n%s\n' "${2:-$tgt}" "$e_ef" | sh ./.agents/scripts/agent.sh worker-evidence "$RID" "$1" "${3:-pass}" 2>&1
  }
  out=$(ev GREEN) && die "GREEN accepted before any RED"
  printf '%s' "$out" | grep -q 'no RED evidence' || die "GREEN before RED: wrong reason: $out"
  out=$(ev REFACTOR) && die "REFACTOR accepted before any RED"
  printf '%s' "$out" | grep -q 'no RED evidence' || die "REFACTOR before RED: wrong reason: $out"
  printf 'test: lookup returns the stored value\n' >> impl_test.txt
  ev RED "$tgt" fail >/dev/null || die "RED refused"
  out=$(ev GREEN) && die "GREEN accepted with no implementation change since RED"
  printf '%s' "$out" | grep -q 'no implementation file changed' || die "GREEN without change: wrong reason: $out"
  printf 'test edited again\n' >> impl_test.txt
  out=$(ev GREEN) && die "GREEN accepted after only a test file changed"
  printf '%s' "$out" | grep -q 'no implementation file changed' || die "GREEN after a test-only edit: wrong reason: $out"
  out=$(ev REFACTOR) && die "REFACTOR accepted before GREEN"
  printf '%s' "$out" | grep -q 'no GREEN evidence' || die "REFACTOR before GREEN: wrong reason: $out"
  printf 'impl: lookup returns the stored value\n' >> impl.txt
  ev GREEN >/dev/null || die "GREEN refused after the fix"
  ev REFACTOR >/dev/null || die "REFACTOR refused after GREEN"
  ok "evidence order: GREEN needs an earlier RED and a changed implementation; REFACTOR needs GREEN"
}

# The lead and the non-gate roles never record a verdict; each gate role records only its own gate.
scenario_independence() {
  scaffold standalone
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  f=$(result_for VERIFY PASS)
  expect_msg "the lead recorded a gate verdict" 'does not match AGENT_ROLE' A record LC --file "$f"
  sed 's/^ROLE: verifier/ROLE: lead/' "$f" > "$base/lead.md"
  expect_msg "a lead PASS was accepted" 'lead can never record' A record LC --file "$base/lead.md"
  for r in implementer explorer architect task_author designer; do
    sed "s/^ROLE: verifier/ROLE: $r/" "$f" > "$base/x.md"
    expect_fail "$r recorded a VERIFY verdict" AS "$r" record LC --file "$base/x.md"
  done
  expect_fail "the lead used the compatibility gate command" sh -c "printf 'summary: ran the full verification command set on the whole tree\n' | sh ./.agents/scripts/agent.sh gate LC VERIFY pass"
  expect_fail "qa recorded a VERIFY gate through the compatibility command" sh -c "printf 'summary: ran the full verification command set on the whole tree\n' | AGENT_ROLE=qa sh ./.agents/scripts/agent.sh gate LC VERIFY pass"
  pass_all
  for g in REVIEW_SMALL QA VERIFY; do
    gf=$(ls .agents/runs/LC/gates/*-"$g".yaml | tail -1); cp "$gf" "$base/gate.bak"
    sed 's/^role: .*/role: "lead"/' "$base/gate.bak" > "$gf"
    expect_fail "hand-relabelled $g gate counted" A handoff LC CODE_DONE
    cp "$base/gate.bak" "$gf"
  done
  A handoff LC CODE_DONE >/dev/null
  for r in reviewer qa verifier security_reviewer explorer architect data_architect designer task_author implementation_worker independent_reviewer; do
    expect_fail "$r moved the lifecycle" AS "$r" handoff LC DONE
    expect_fail "$r froze" AS "$r" freeze LC
    expect_fail "$r classified" AS "$r" classify LC TRIVIAL
    expect_fail "$r reopened a run" AS "$r" amend LC
    expect_fail "$r approved" AS "$r" approve LC commit
    expect_fail "$r waived" AS "$r" waive LC X-1 --reason 'a long enough reason for the waiver'
    expect_fail "$r terminated a run" sh -c "printf 'reason: x\nevidence: y\n' | AGENT_ROLE=$r sh ./.agents/scripts/agent.sh terminate LC BLOCKED"
    expect_fail "$r cleaned up a run" AS "$r" cleanup LC
    AS "$r" verify-handoff LC >/dev/null; AS "$r" pipeline LC >/dev/null; AS "$r" next LC >/dev/null
  done
  for r in reviewer qa explorer architect; do
    expect_fail "$r recorded implementation evidence" sh -c "printf 'command: x\ntarget: impl.txt\n' | AGENT_ROLE=$r sh ./.agents/scripts/agent.sh worker-evidence LC GREEN pass"
  done
  finish_done; A delivery-check LC >/dev/null
  for r in reviewer qa verifier explorer architect; do AS "$r" validate LC >/dev/null; done
  ok "independence: only gate roles record verdicts; role command boundaries hold"
}

# Orchestrated end to end: worker implementation -> REVIEW FAIL -> worker fix -> QA FAIL -> worker fix ->
# all gates -> CODE_DONE -> DONE -> manual rewind detection -> reopen -> fix -> DONE -> cleanup.
scenario_orchestrated_loop() {
  scaffold orchestrated
  printf 'lead wrote this\n' >> impl_test.txt
  expect_fail "worker window opened over a lead edit" A window-open LC
  printf 'command: x\ntarget: impl_test.txt\nexpected_failure: TestImpl fails: lookup is not implemented in impl.txt yet\n' > "$base/ev.in"
  expect_fail "lead-authored RED evidence accepted under orchestrated" sh -c "sh ./.agents/scripts/agent.sh worker-evidence LC RED fail < '$base/ev.in'"
  git checkout -q -- impl_test.txt
  worker RED fail impl_test.txt 'test: lookup returns the stored value'
  worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null; expect_state handoff state IMPLEMENTED
  expect_fail "CODE_DONE with no gates" A handoff LC CODE_DONE
  A secret-scan LC >/dev/null
  gfail REVIEW_SMALL impl.txt
  gpass QA                                                           # parallel gates on the same content still record
  expect_fail "CODE_DONE with an open finding" A handoff LC CODE_DONE
  A handoff LC IMPLEMENTING >/dev/null; expect_state handoff state IMPLEMENTING
  cp impl.txt "$base/impl.saved"; printf 'lead quick fix\n' >> impl.txt
  expect_fail "the lead's own fix reached IMPLEMENTED" A handoff LC IMPLEMENTED
  expect_fail "worker window absorbed the lead's fix" A window-open LC
  cp "$base/impl.saved" impl.txt
  worker FIX pass impl.txt 'impl: lookup returns the documented default for an empty key'
  A handoff LC IMPLEMENTED >/dev/null
  gpass REVIEW_SMALL
  gfail QA impl_test.txt
  expect_fail "CODE_DONE with a failing QA" A handoff LC CODE_DONE
  A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: an empty key returns the documented default'
  A handoff LC IMPLEMENTED >/dev/null
  expect_fail "CODE_DONE on the review pass for older content" A handoff LC CODE_DONE
  pass_all; A handoff LC CODE_DONE >/dev/null
  A verify-gates LC >/dev/null
  expect_fail "DONE before knowledge/report" A handoff LC DONE
  finish_done; A delivery-check LC >/dev/null; A validate LC >/dev/null; A verify-seal LC >/dev/null
  expect_state handoff state DONE
  cp .agents/runs/LC/RUN.yaml "$base/run.bak"
  sed '/^handoff:$/,/^[^ ]/ s/state: ".*"/state: "IMPLEMENTING"/' "$base/run.bak" > .agents/runs/LC/RUN.yaml
  expect_fail "hand-rewound handoff.state passed verify-seal" A verify-seal LC
  expect_fail "hand-rewound handoff.state passed validate" A validate LC
  expect_fail "hand-rewound handoff.state passed delivery-check" A delivery-check LC
  cp "$base/run.bak" .agents/runs/LC/RUN.yaml
  sed 's/published: "true"/published: "false"/' "$base/run.bak" > .agents/runs/LC/RUN.yaml
  expect_fail "hand-edited completion_report.published passed verify-seal" A verify-seal LC
  sed '/^pipeline:$/,/^[^ ]/ s/tier: ".*"/tier: "docs"/' "$base/run.bak" > .agents/runs/LC/RUN.yaml
  expect_fail "hand-lowered tier passed verify-seal" A verify-seal LC
  sed '/^pipeline:$/,/^[^ ]/ s/classification: ".*"/classification: "TRIVIAL"/' "$base/run.bak" > .agents/runs/LC/RUN.yaml
  expect_fail "hand-edited classification passed verify-seal" A verify-seal LC
  cp "$base/run.bak" .agents/runs/LC/RUN.yaml; A verify-seal LC >/dev/null
  # the reopen: explicit, authorized, audited, fail-closed
  amend_as() { printf 'reason: %s\nfix_scope: %s\nfix_instruction: %s\nauthorized_by: %s\n' "$2" "$3" "$4" "$5" | AGENT_ROLE=$1 sh ./.agents/scripts/agent.sh amend LC; }
  cp impl.txt "$base/impl.final"
  expect_fail "amend by a non-lead role" amend_as implementer 'post-DONE review found the key handling is still wrong for whitespace' impl.txt 'trim the key before lookup and add a regression test for it' 'the user'
  expect_fail "amend without an authorizer" amend_as lead 'post-DONE review found the key handling is still wrong for whitespace' impl.txt 'trim the key before lookup and add a regression test for it' ''
  expect_fail "amend with a generic reason" amend_as lead 'not needed' impl.txt 'trim the key before lookup and add a regression test for it' 'the user'
  expect_fail "amend with fix_scope outside the frozen plan" amend_as lead 'post-DONE review found the key handling is still wrong for whitespace' outside.txt 'trim the key before lookup and add a regression test for it' 'the user'
  expect_msg "amend with a symbol-only fix_scope" "fix_scope has no path" amend_as lead 'post-DONE review found the key handling is still wrong for whitespace' ':lookupKey' 'trim the key before lookup and add a regression test for it' 'the user'
  expect_msg "amend with a path:symbol fix_scope outside the frozen plan" "outside the frozen scope" amend_as lead 'post-DONE review found the key handling is still wrong for whitespace' outside.txt:lookupKey 'trim the key before lookup and add a regression test for it' 'the user'
  amend_as lead 'post-DONE review found the key handling is still wrong for whitespace' impl.txt:lookupKey 'trim the key before lookup and add a regression test for it' 'the user (explicit reopen request)' >/dev/null
  expect_state execution state AMENDING; expect_state handoff state IMPLEMENTING; expect_state completion_report published false
  grep -q '^previous_handoff_state: "DONE"' .agents/runs/LC/gates/*-REOPEN.yaml
  grep -q '^fix_scope: impl.txt$' .agents/runs/LC/gates/*-REOPEN.yaml || die "REOPEN record kept the symbol of a path:symbol fix_scope"
  ls .agents/runs/LC/gates/*-REOPEN.completion-report.md >/dev/null
  expect_fail "DONE straight after reopen" A handoff LC DONE
  printf 'lead hot-fix\n' >> impl.txt
  expect_fail "lead hot-fix reached IMPLEMENTED after reopen" A handoff LC IMPLEMENTED
  cp "$base/impl.final" impl.txt
  worker FIX pass impl.txt 'impl: trim the key before lookup'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all; A handoff LC CODE_DONE >/dev/null
  A knowledge-done LC not_applicable >/dev/null; write_report
  expect_fail "report without Reopen History accepted for a reopened run" A publish-completion-report LC markdown
  write_report '' '## Reopen History' 'Reopened once after DONE: whitespace keys; fixed by the worker; re-reviewed and re-verified.'
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  A delivery-check LC >/dev/null; A validate LC >/dev/null
  [ "$(grep -c 'event=REOPEN' .agents/runs/LC/LEDGER.log)" = 1 ]
  cp .agents/runs/LC/LEDGER.log "$base/ledger.bak"
  sed '2s/role=[a-z_]*/role=implementer/' "$base/ledger.bak" > .agents/runs/LC/LEDGER.log
  expect_fail "edited ledger entry passed verify-seal" A verify-seal LC
  sed '2d' "$base/ledger.bak" > .agents/runs/LC/LEDGER.log
  expect_fail "deleted ledger entry passed verify-seal" A verify-seal LC
  cp "$base/ledger.bak" .agents/runs/LC/LEDGER.log; A verify-seal LC >/dev/null
  expect_fail "cleanup by a non-lead" AS verifier cleanup LC
  cp impl.txt "$base/impl.done"; printf 'edited after DONE\n' >> impl.txt
  expect_fail "cleanup accepted a run whose content changed after DONE" A cleanup LC
  cp "$base/impl.done" impl.txt
  A cleanup LC >/dev/null
  [ ! -e .agents/runs/LC ] && [ -z "$(sed '/^[[:space:]]*$/d' .agents/local/ACTIVE_RUN)" ]
  A status | grep -Fxq 'active_task=none'
  ok "orchestrated loop, reopen, ledger and cleanup"
}

# Orchestrated attribution: a change made outside the implementer is detected before and after the gates.
scenario_attribution() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all
  cp impl.txt "$base/impl.keep"; printf 'late lead edit\n' >> impl.txt
  expect_fail "post-gate lead edit passed verify-handoff" A verify-handoff LC
  expect_fail "a gate recorded over an unattributed edit" gpass VERIFY
  expect_fail "CODE_DONE over an unattributed edit" A handoff LC CODE_DONE
  expect_fail "re-asserting IMPLEMENTED laundered an unattributed edit" A handoff LC IMPLEMENTED
  expect_fail "worker window closed outside IMPLEMENTING" A window-close LC "$(A patch-fingerprint LC)" 0
  cp "$base/impl.keep" impl.txt
  A verify-handoff LC >/dev/null; A handoff LC CODE_DONE >/dev/null
  ok "orchestrated attribution"
}

# Fix loop: a fix stays inside its findings' fix_scope, at most review.max_fix_rounds rounds per frozen
# contract, and an amendment + refreeze returns the run to IMPLEMENTING with a fresh budget.
scenario_bounded_fix() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  gfail REVIEW_SMALL impl_test.txt; A handoff LC IMPLEMENTING >/dev/null
  cp impl.txt "$base/impl.keep"
  worker FIX pass impl.txt 'impl: tweak outside the finding'
  expect_msg "fix outside the finding's fix_scope reached IMPLEMENTED" "outside the finding's fix_scope" A handoff LC IMPLEMENTED
  wopen; cp "$base/impl.keep" impl.txt; printf 'test: default for an empty key\n' >> impl_test.txt; wev FIX pass impl_test.txt; wclose
  A handoff LC IMPLEMENTED >/dev/null                                             # round 1
  gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null                         # round 2: any gate's finding counts
  expect_fail "IMPLEMENTED with no change since the finding" A handoff LC IMPLEMENTED
  worker FIX pass impl.txt 'impl: second attempt at the empty key default'
  A handoff LC IMPLEMENTED >/dev/null
  gfail VERIFY impl.txt                                                           # third failing content: rounds exhausted
  expect_msg "a third fix was allowed" 'fix rounds exhausted' A handoff LC IMPLEMENTING
  expect_fail "FAILED accepted without evidence" sh -c "printf 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: \n' | sh ./.agents/scripts/agent.sh terminate LC FAILED"
  mkdir -p .agents/runs/LC/amendments; printf '# amendment 001: the plan must cover the empty-key contract\n' > .agents/runs/LC/amendments/001.md
  printf 'amended: empty-key contract\n' >> .agents/runs/LC/PLAN.md
  expect_fail "refreeze without an amendment file" A refreeze LC missing.md
  # D15/B4: the exhausted budget is reset only with the user's budget approval for this PLAN.md
  expect_msg "a refreeze reset an exhausted fix budget without the user" 'budget approval' A refreeze LC 001.md
  approve_as_user budget 'approve budget'
  A refreeze LC 001.md >/dev/null
  [ "$(pipe_val fix_round)" = 0 ] || die "refreeze did not start a fresh budget"
  expect_state handoff state IMPLEMENTING; expect_state handoff implemented_patch_sha256 PENDING
  expect_fail "IMPLEMENTED on pre-amendment evidence" A handoff LC IMPLEMENTED
  worker RED fail impl_test.txt 'test: empty key returns the documented default'
  worker GREEN pass impl.txt 'impl: empty key returns the documented default'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all; A handoff LC CODE_DONE >/dev/null
  A knowledge-done LC not_applicable >/dev/null; write_report '' '## Amendments' 'Amendment 001 after three failing rounds.'
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  A validate LC >/dev/null
  ok "fix loop bound, fix_scope and amendment escalation"
}

# fix_scope is the union of the findings' paths on the failing content; whitespace in a list is ignored.
scenario_fix_scope_format() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:3|wrong default|traced' 'REVIEW_SMALL-2|blocking|impl_test.txt:9|hollow assertion|traced' 'REVIEW_SMALL-3|info|other.txt:1|suspicion only|none'
  grep -q '^fix_scope: impl.txt,impl_test.txt$' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "fix_scope is not the union of blocking finding paths"
  A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: empty key returns the documented default'
  A handoff LC IMPLEMENTED >/dev/null
  gfail QA impl_test.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: a path that the finding did not list'
  expect_msg "a fix outside the listed fix_scope reached IMPLEMENTED" "outside the finding's fix_scope" A handoff LC IMPLEMENTED
  ok "fix_scope union and info rows"
}

# A77: a fix_scope entry `path:symbol` (gate row or amendment) scopes to its path; a path outside still fails.
scenario_fix_scope_symbol() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl_test.txt:TestLookup|hollow assertion|traced'
  grep -q '^fix_scope: impl_test.txt$' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "fix_scope kept the symbol of a path:symbol finding"
  A handoff LC IMPLEMENTING >/dev/null
  cp impl.txt "$base/impl.keep"
  worker FIX pass impl.txt 'impl: a path that the finding did not list'
  expect_msg "a fix outside a path:symbol fix_scope reached IMPLEMENTED" "outside the finding's fix_scope" A handoff LC IMPLEMENTED
  wopen; cp "$base/impl.keep" impl.txt; printf 'test: the symbol named in the finding asserts the value\n' >> impl_test.txt; wev FIX pass impl_test.txt; wclose
  A handoff LC IMPLEMENTED >/dev/null
  ok "fix_scope path:symbol scopes to its path"
}

# An amendment that changes any frozen artifact starts a fresh fix budget.
scenario_amendment_fresh_budget() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  gfail REVIEW_SMALL impl.txt; A handoff LC IMPLEMENTING >/dev/null
  mkdir -p .agents/runs/LC/amendments; printf '# amendment 001: the QA plan misstated a scenario\n' > .agents/runs/LC/amendments/001.md
  printf -- '- QA-2 (AC-1): clarified scenario\n' >> .agents/runs/LC/QA_PLAN.md
  A refreeze LC 001.md >/dev/null
  A handoff LC IMPLEMENTED >/dev/null
  [ "$(pipe_val fix_round)" = 0 ] || die "the amendment did not reset the fix rounds"
  gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: first attempt after the amendment'; A handoff LC IMPLEMENTED >/dev/null
  gfail VERIFY impl.txt; A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: second attempt after the amendment'; A handoff LC IMPLEMENTED >/dev/null
  gfail REVIEW_SMALL impl.txt
  expect_fail "a third fix was allowed after the amendment" A handoff LC IMPLEMENTING
  ok "amendment starts a fresh fix budget"
}

# FAILED only after the fix rounds are exhausted; BLOCKED for an outside blocker; both terminal.
scenario_terminal() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  gfail QA impl.txt
  term() { printf 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: gate QA failed the empty-key scenario on every round\n' | AGENT_ROLE=${2:-lead} sh ./.agents/scripts/agent.sh terminate LC "$1"; }
  expect_fail "FAILED accepted while fix rounds remain" term FAILED
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: first attempt'; A handoff LC IMPLEMENTED >/dev/null
  gfail QA impl.txt; A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null
  gfail QA impl.txt
  expect_fail "a third fix was allowed" A handoff LC IMPLEMENTING
  expect_fail "terminate without a reason" sh -c "printf 'reason: no\nevidence: gate QA failed the empty-key scenario a third time\n' | sh ./.agents/scripts/agent.sh terminate LC FAILED"
  expect_fail "terminate by a non-lead" term FAILED qa
  expect_fail "an unknown outcome was accepted" term DONE
  term FAILED >/dev/null
  expect_state execution state FAILED
  expect_fail "a terminal run accepted a handoff" A handoff LC IMPLEMENTING
  expect_fail "a terminal run accepted a gate" gpass QA
  expect_fail "a terminal run was reclassified" A classify LC STANDARD
  expect_fail "a terminal run was terminated again" term BLOCKED
  A verify-seal LC >/dev/null
  A next LC | grep -q '^next=report the evidence' || die "next did not point a terminal run at cleanup"
  A cleanup LC >/dev/null; [ ! -e .agents/runs/LC ]
  scaffold standalone
  expect_fail "cleanup of a run that is neither DONE nor terminal" A cleanup LC
  printf 'reason: the verification toolchain is unavailable in this environment\nevidence: go test exited 127 because the go binary is missing\n' | A terminate LC BLOCKED >/dev/null
  expect_state execution state BLOCKED
  A cleanup LC >/dev/null; [ ! -e .agents/runs/LC ]
  ok "terminal outcomes and cleanup"
}

# TRIVIAL: no evidence, no QA plan, no QA gate; tier from the diff decides the review gate.
scenario_pipeline_trivial() {
  scaffold standalone no TRIVIAL
  [ "$(pipe_val gates)" = 'SECRETS VERIFY' ] || die "TRIVIAL before any change: $(pipe_val gates)"
  [ "$(pipe_val evidence)" = no ] && [ "$(pipe_val qa_plan)" = no ]
  expect_state freeze evidence_sha256 not_required; expect_state freeze qa_plan_sha256 not_required
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  [ "$(pipe_val gates)" = 'SECRETS VERIFY' ] || die "TRIVIAL .txt change (tier docs): $(pipe_val gates)"
  expect_fail "a QA gate on a TRIVIAL run" gpass QA
  rm -f .agents/runs/LC/QA_REPORT.md
  pass_all; A handoff LC CODE_DONE >/dev/null
  printf '# stray\n' > .agents/runs/LC/QA_PLAN.md
  expect_msg "a QA_PLAN.md on a TRIVIAL run passed verify-scope" 'unexpected run artifact' A verify-scope LC
  rm .agents/runs/LC/QA_PLAN.md
  A knowledge-done LC not_applicable >/dev/null
  printf '%s\n' '# Completion Report: LC' '' '## Implementation Summary' 'impl.txt and impl_test.txt changed under the TRIVIAL pipeline.' '' '## TDD Evidence' 'RED then GREEN recorded by the lead.' '' '## Verification' 'The VERIFY gate passed on the final tree.' '' '## Assumptions' 'none' '' '## Review Result' 'REVIEW_SMALL passed.' '' '## Known Limitations / Follow-up' 'None.' > .agents/runs/LC/COMPLETION_REPORT.md
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  A validate LC >/dev/null; A delivery-check LC >/dev/null
  printf '# stray\n' > .agents/runs/LC/EVIDENCE.md
  expect_msg "an EVIDENCE.md on a TRIVIAL run passed validate" 'unexpected run artifact' A validate LC
  rm .agents/runs/LC/EVIDENCE.md; A validate LC >/dev/null
  ok "TRIVIAL pipeline"
}

# A31: the class is a claim, the diff the fact: a TRIVIAL run that changes executable code is reclassified.
scenario_classification_diff() {
  scaffold standalone no TRIVIAL manual
  awk '/^  - path: impl.txt$/ { print "  - path: app.go"; print "    new: true"; next } { print }' .agents/runs/LC/PLAN.md > "$base/plan" && cp "$base/plan" .agents/runs/LC/PLAN.md
  A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  solo RED fail impl_test.txt 'test: lookup returns the stored value' app.go,impl_test.txt
  solo GREEN pass app.go 'package x' app.go,impl_test.txt
  expect_msg "a TRIVIAL run with an executable code change reached IMPLEMENTED" 'is TRIVIAL but its diff changes executable code: app.go' A handoff LC IMPLEMENTED
  expect_msg "the message names the way out" "agent.sh classify LC STANDARD" A handoff LC IMPLEMENTED
  expect_state handoff state IMPLEMENTING
  ok "classification check: TRIVIAL + executable code blocks IMPLEMENTED, with the way out named"
}

# STANDARD: evidence + frozen QA plan; QA gate; review only by opt-in or by the diff's tier.
scenario_pipeline_standard() {
  scaffold standalone no STANDARD
  [ "$(pipe_val review)" = no ] && [ "$(pipe_val qa_plan)" = yes ]
  [ "$(pipe_val gates)" = 'SECRETS QA VERIFY' ] || die "STANDARD docs tier: $(pipe_val gates)"
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all; A handoff LC CODE_DONE >/dev/null
  printf -- '- QA-2: weakened criterion added after freeze\n' >> .agents/runs/LC/QA_PLAN.md
  expect_msg "an edited QA plan passed verify-freeze" 'freeze mismatch: qa_plan' A verify-freeze LC
  expect_msg "an edited QA plan allowed knowledge-done" 'freeze mismatch: qa_plan' A knowledge-done LC not_applicable
  sed '$d' .agents/runs/LC/QA_PLAN.md > "$base/qa.restored" && cp "$base/qa.restored" .agents/runs/LC/QA_PLAN.md
  A verify-freeze LC >/dev/null
  ok "STANDARD pipeline"
}

# Classification rules: lead only, review option only where optional, reclassifying voids the freeze.
scenario_classification() {
  scaffold standalone no STANDARD
  expect_fail "an unknown class was accepted" A classify LC EPIC
  expect_fail "the review option on a class that fixes review" A classify LC COMPLEX review
  expect_fail "an unknown option was accepted" A classify LC STANDARD strict
  A classify LC STANDARD review >/dev/null
  expect_fail "a reclassification after freeze passed verify-freeze" A verify-freeze LC
  mkdir -p .agents/runs/LC/amendments; for n in 001 002 003 004; do printf '# amendment %s\n' $n > .agents/runs/LC/amendments/$n.md; done
  A refreeze LC 001.md >/dev/null; A verify-freeze LC >/dev/null
  [ "$(pipe_val tier)" = small ] || die "STANDARD review opt-in did not set the small tier floor"
  A classify LC COMPLEX >/dev/null
  cp .agents/runs/LC/PLAN.md "$base/plan.saved"; sed '/^## Architecture/,$d' "$base/plan.saved" > .agents/runs/LC/PLAN.md
  expect_fail "COMPLEX froze a plan with no Architecture section" A refreeze LC 002.md
  cp "$base/plan.saved" .agents/runs/LC/PLAN.md
  A refreeze LC 002.md >/dev/null
  A classify LC CRITICAL >/dev/null; A refreeze LC 003.md >/dev/null
  [ "$(pipe_val max_explorers)" = 3 ] && [ "$(pipe_val tier)" = full ] || die "CRITICAL is not tier full"
  A classify LC TRIVIAL >/dev/null
  expect_fail "TRIVIAL froze with EVIDENCE.md and QA_PLAN.md present" A refreeze LC 004.md
  rm .agents/runs/LC/EVIDENCE.md .agents/runs/LC/QA_PLAN.md
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl_test.txt' '    criteria: [AC-1]' '  - path: tasks/LC.md' '    criteria: [AC-1]' '---' '# Plan' '' '## Assumptions' 'none' '' '## Behavior' 'unchanged' > .agents/runs/LC/PLAN.md
  expect_fail "TRIVIAL froze a plan with three scope paths" A refreeze LC 004.md
  scaffold standalone
  to_code_done standalone
  expect_fail "a completed run was reclassified" A classify LC TRIVIAL
  ok "classification rules"
}

# A reopen whose fix needs a plan change goes through an amendment, a scope approval and refreeze.
scenario_amend_plan_change() {
  scaffold standalone
  to_code_done standalone; finish_done
  expect_fail "reopen naming a path outside the frozen plan without plan_change" sh -c "printf 'reason: the review found a missing helper file the plan did not cover\nfix_scope: extra.txt\nfix_instruction: add extra.txt with the helper and cover it with a test\nauthorized_by: the user\n' | sh ./.agents/scripts/agent.sh amend LC"
  printf 'reason: the review found a missing helper file the plan did not cover\nfix_scope: extra.txt\nfix_instruction: add extra.txt with the helper and cover it with a test\nauthorized_by: the user\nplan_change: yes\n' | A amend LC >/dev/null
  expect_fail "plain freeze on a reopened run" A freeze LC
  mkdir -p .agents/runs/LC/amendments; printf '# amendment 001: add extra.txt to scope\n' > .agents/runs/LC/amendments/001.md
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl_test.txt' '    criteria: [AC-1]' '  - path: extra.txt' '    criteria: [AC-1]' '    new: true' '---' '# Plan' '' '## Assumptions' 'none' '' '## Architecture' 'amended: one helper file' > .agents/runs/LC/PLAN.md
  expect_msg "a scope-adding refreeze without a scope approval" 'scope approval' A refreeze LC 001.md
  approve_as_user scope 'approve the scope please'
  A refreeze LC 001.md >/dev/null; expect_state handoff state IMPLEMENTING
  solo RED fail impl_test.txt 'test: helper returns the stored value' impl.txt,impl_test.txt,extra.txt; solo GREEN pass extra.txt 'helper: returns the stored value' impl.txt,impl_test.txt,extra.txt
  A handoff LC IMPLEMENTED >/dev/null; pass_all; A handoff LC CODE_DONE >/dev/null
  A knowledge-done LC not_applicable >/dev/null
  write_report '' '## Amendments' 'Amendment 001 added extra.txt.' '' '## Reopen History' 'Reopened once after DONE to add a helper.'
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null; A validate LC >/dev/null
  ok "reopen with an authorized plan amendment"
}

# Stray run files are caught although runs are git-ignored; one amendment per refreeze; artifact checks.
scenario_hardening() {
  scaffold orchestrated no TRIVIAL
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  for f in QA_PLAN.md REVIEW.md scratch-notes.md reviews/other/x.md design/x.txt reviews/proof-review/REPORT.md reviews/test-trust/REPORT.md reviews/proof-review/bugs/REPORT.md; do
    mkdir -p ".agents/runs/LC/$(dirname "$f")"; printf '# stray\n' > ".agents/runs/LC/$f"
    expect_msg "stray $f passed verify-scope" 'unexpected run artifact' A verify-scope LC
    expect_fail "stray $f reached a gate" gpass VERIFY
    rm ".agents/runs/LC/$f"
  done
  for f in design/INTENT.md design/API.json design/adr/0001-x.md results/001-explorer.md dispatch/001-reviewer-claude.md dispatch/001-reviewer-claude.log reviews/proof-review/plan/REPORT.md reviews/proof-review/rules/ledger.md reviews/proof-review/small/findings.json reviews/test-trust/tests/REPORT.md reviews/test-trust/qa/REPORT.md reviews/data-design/REVIEW.md security/evidence/poc.txt; do
    mkdir -p ".agents/runs/LC/$(dirname "$f")"; printf 'x\n' > ".agents/runs/LC/$f"
  done
  A verify-scope LC >/dev/null
  printf '# VERIFY\n\nVerdict: PASS\n\nlater\n\nVerdict: FAIL\n' > .agents/runs/LC/VERIFY.md
  expect_msg "a report with two verdicts was recorded" "exactly one 'Verdict:'" sh -c "printf 'summary: ran the full verification command set on the whole tree\n' | AGENT_ROLE=verifier sh ./.agents/scripts/agent.sh gate LC VERIFY pass"
  printf '# VERIFY\n\nVerdict: FAIL\n' > .agents/runs/LC/VERIFY.md
  printf 'summary: ran the full verification command set on the whole tree\nfindings: lookup returns nil for the empty key in the verified tree\nfix_scope: impl.txt\n' | AS verifier gate LC VERIFY fail >/dev/null
  expect_msg "an implementer reopened implementation" 'only the lead' AS implementer handoff LC IMPLEMENTING
  A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: first fix'; A handoff LC IMPLEMENTED >/dev/null
  mkdir -p .agents/runs/LC/amendments; printf '# a1\n' > .agents/runs/LC/amendments/001.md
  expect_msg "a path traversal amendment name was accepted" 'invalid amendment name' A refreeze LC ../TASK.md
  expect_msg "a no-op refreeze was accepted" 'changes nothing' A refreeze LC 001.md
  printf 'amended\n' >> .agents/runs/LC/PLAN.md; A refreeze LC 001.md >/dev/null
  printf 'amended again\n' >> .agents/runs/LC/PLAN.md
  expect_msg "an amendment file was reused" 'already used' A refreeze LC 001.md
  cp .agents/runs/LC/RUN.yaml "$base/run.forge"
  sed 's/^  state: "IMPLEMENTING"/  state: "BLOCKED"/; s/^  state: PLANNING/  state: BLOCKED/' "$base/run.forge" > .agents/runs/LC/RUN.yaml
  expect_fail "cleanup of a hand-forged BLOCKED run" A cleanup LC
  cp "$base/run.forge" .agents/runs/LC/RUN.yaml
  ok "hardening: registry, verdict lines, amendments, forged terminal state"
}

# --- task-source contract --------------------------------------------------------------------
scenario_task_contract_bookkeeping() {
  topo=$1; scaffold "$topo" yes; to_code_done "$topo"; frozen=$(rv task_source revision)
  mkdir -p tasks/done; git mv tasks/in-progress/LC.md tasks/done/LC.md; tc_status tasks/done/LC.md "done"
  expect_msg "a moved task source was accepted without being relocated" 'task-source-relocate' A freshness LC
  A task-source-relocate LC tasks/done/LC.md >/dev/null
  expect_state task_source path tasks/done/LC.md; expect_state task_source revision "$frozen"
  A freshness LC >/dev/null; A verify-seal LC >/dev/null
  finish_done
  [ "$(rv task_source revision)" = "$frozen" ] || die "publish re-baselined the frozen task contract"
  grep -Fq '<!-- COMPLETION-REPORT:BEGIN:LC -->' tasks/done/LC.md
  A verify-completion-report LC >/dev/null; A delivery-check LC >/dev/null; A validate LC >/dev/null
  expect_msg "relocation accepted after publication" 'receipt binds' A task-source-relocate LC tasks/elsewhere.md
  cp tasks/done/LC.md "$base/published.md"
  printf '%s\n' '- a requirement added after publication' >> tasks/done/LC.md
  expect_msg "a contract edit after the END marker was accepted" 'frozen task contract changed' A freshness LC
  cp "$base/published.md" tasks/done/LC.md; A freshness LC >/dev/null
  ok "task-source contract bookkeeping ($topo)"
}
scenario_task_contract_edit() {
  topo=$1; scaffold "$topo" yes; to_code_done "$topo"; frozen=$(rv task_source revision)
  printf '%s\n' '- a requirement added after freeze' >> tasks/in-progress/LC.md
  expect_msg "an edited task contract passed freshness" 'frozen task contract changed' A freshness LC
  expect_msg "knowledge-done accepted an edited task contract" 'frozen task contract changed' A knowledge-done LC not_applicable
  write_report
  expect_msg "publish accepted an edited task contract" 'frozen task contract changed' A publish-completion-report LC markdown
  expect_state completion_report published false; expect_state task_source revision "$frozen"
  ! grep -Fq 'COMPLETION-REPORT:BEGIN' tasks/in-progress/LC.md || die "the adapter ran against an edited task contract"
  expect_msg "DONE accepted an edited task contract" 'frozen task contract changed' A handoff LC DONE
  ok "task-source contract in-place edit rejected ($topo)"
}
scenario_task_contract_laundering() {
  scaffold standalone yes; to_code_done standalone; frozen=$(rv task_source revision)
  mkdir -p tasks/done; git mv tasks/in-progress/LC.md tasks/done/LC.md; tc_status tasks/done/LC.md "done"
  printf '%s\n' '- a requirement smuggled in with the move' >> tasks/done/LC.md
  expect_msg "a relocation absorbed an edited contract" 'differs from the frozen contract' A task-source-relocate LC tasks/done/LC.md
  cp .agents/runs/LC/RUN.yaml "$base/RUN.saved"
  awk '/^  path: tasks\/in-progress\/LC.md$/ { print "  path: tasks/done/LC.md"; next } { print }' "$base/RUN.saved" > .agents/runs/LC/RUN.yaml
  expect_msg "a hand-edited task source path was accepted" 'edited by hand' A verify-seal LC
  cp "$base/RUN.saved" .agents/runs/LC/RUN.yaml
  awk '/^  revision: / { print "  revision: \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\""; next } { print }' "$base/RUN.saved" > .agents/runs/LC/RUN.yaml
  expect_msg "a hand-edited task revision was accepted" 'edited by hand' A verify-seal LC
  cp "$base/RUN.saved" .agents/runs/LC/RUN.yaml; A verify-seal LC >/dev/null
  ok "task-source contract laundering rejected"
}
scenario_task_contract_relocate() {
  scaffold standalone yes; to_code_done standalone
  cp tasks/in-progress/LC.md tasks/copy.md
  expect_msg "a copy was accepted as a move" 'not a copy' A task-source-relocate LC tasks/copy.md
  rm -f tasks/copy.md
  expect_msg "an absolute path was accepted" 'invalid task source path' A task-source-relocate LC /etc/hosts
  expect_msg "a parent-directory path was accepted" 'invalid task source path' A task-source-relocate LC tasks/../LC.md
  git mv tasks/in-progress/LC.md tasks/moved.md
  ln -s moved.md tasks/link.md
  expect_msg "a symlink target was accepted" 'symlink' A task-source-relocate LC tasks/link.md
  expect_msg "a reviewer relocated the task source" 'denied' AS reviewer task-source-relocate LC tasks/moved.md
  A task-source-relocate LC tasks/moved.md >/dev/null; expect_state task_source path tasks/moved.md
  ok "task-source relocation checks"
}
# A74: a defect task (a debug-proof result exists) must carry a ## Root cause section in its completion report.
scenario_report_root_cause() {
  scaffold standalone yes; to_code_done standalone
  A knowledge-done LC not_applicable >/dev/null; write_report
  mkdir -p .agents/runs/LC/reports; printf '# debug\n\nreproduction, root cause, regression test\n' > .agents/runs/LC/reports/001-debug.md
  expect_msg "a defect run's report without ## Root cause was published" 'missing required section: ## Root cause' A publish-completion-report LC markdown
  expect_state completion_report published false
  write_report '' '## Root cause' '`lookup` compares the untrimmed key where the trimmed key is needed.'
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  ok "a defect run's completion report needs ## Root cause"
  scaffold standalone yes; to_code_done standalone
  A knowledge-done LC not_applicable >/dev/null; write_report
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  ok "a run without a debug-proof result publishes without ## Root cause"
}
scenario_task_contract_adapter() {
  scaffold standalone yes; to_code_done standalone; frozen=$(rv task_source revision)
  cp tasks/in-progress/LC.md "$base/pre-publish.md"
  A knowledge-done LC not_applicable >/dev/null; write_report
  printf '%s\n' '#!/bin/sh' 'set -eu' 'root=$(CDPATH= cd "$(dirname "$0")/../.." && pwd)' \
    'path=$(sed -n "s/^  path: //p" "$root/.agents/runs/$2/RUN.yaml" | head -1)' \
    'case "$1" in publish) printf "%s\n" "- a requirement the adapter added" >> "$root/$path"; printf "%s#feedface\n" "$path" ;; verify) exit 0 ;; esac' \
    > .agents/task-integrations/evil.sh
  expect_msg "an adapter that changed the contract was accepted" 'outside the completion-report block' A publish-completion-report LC evil
  cmp -s tasks/in-progress/LC.md "$base/pre-publish.md" || die "the task source was not restored byte for byte"
  expect_state completion_report published false; expect_state task_source revision "$frozen"
  rm -f .agents/task-integrations/evil.sh
  A publish-completion-report LC markdown >/dev/null; A handoff LC DONE >/dev/null
  ok "task-source contract adapter confinement"
}
scenario_task_contract_projection() {
  scaffold standalone yes; f=tasks/in-progress/LC.md; cp "$f" "$base/orig.md"
  good() { cp "$base/orig.md" "$f"; "$@"; A freshness LC >/dev/null 2>&1 || die "bookkeeping change rejected: $*"; }
  bad() { bd=$1; shift; cp "$base/orig.md" "$f"; "$@"; if A freshness LC >/dev/null 2>&1; then die "contract change accepted: $bd"; fi; }
  block() { printf '\n## Completion Report\n\n<!-- COMPLETION-REPORT:BEGIN:%s -->\nreport\n<!-- COMPLETION-REPORT:END:%s -->\n' "$1" "$1" >> "$f"; }
  good tc_status "$f" in-progress
  cp "$base/orig.md" "$f"; tc_status "$f" 'done'
  expect_msg "a Status value was read as contract" 'task-source-status' A freshness LC
  A task-source-status LC >/dev/null; A freshness LC >/dev/null
  good sh -c "printf '\n\n\n' >> '$f'"
  good block LC
  bad "text after the END marker" sh -c "printf '\n## Completion Report\n\n<!-- COMPLETION-REPORT:BEGIN:LC -->\nr\n<!-- COMPLETION-REPORT:END:LC -->\n- extra requirement\n' >> '$f'"
  bad "a block for another task" block OTHER
  bad "a completion-report heading without markers" sh -c "printf '\n## Completion Report\n\nnotes\n' >> '$f'"
  bad "an edited requirement" sh -c "sed 's/documented default/other default/' '$f' > '$f.new' && mv '$f.new' '$f'"
  cp "$base/orig.md" "$f"; A freshness LC >/dev/null
  ok "task-source contract projection"
}
scenario_task_source_status() {
  scaffold orchestrated yes; frozen=$(rv task_source revision)
  tc_status tasks/in-progress/LC.md todo
  expect_msg "a stale Status passed freshness" 'task-source-status' A freshness LC
  expect_fail "the worker changed the task status" AS implementer task-source-status LC
  A task-source-status LC >/dev/null
  grep -Fxq '**Status:** in-progress' tasks/in-progress/LC.md
  expect_state task_source revision "$frozen"; A verify-scope LC >/dev/null
  printf '%s\n' '- a requirement added after freeze' >> tasks/in-progress/LC.md; tc_status tasks/in-progress/LC.md todo
  expect_msg "task-source-status absorbed a contract edit" 'frozen task contract would change' A task-source-status LC
  ok "task source status synchronization"
}

# A108: approval detection is fail-closed. Only an allowlisted phrase plus the kind word approves; an ambiguous,
# empty, unrelated or hesitant answer approves nothing and leaves the request pending; the question lists the answers.
scenario_approval_fail_closed() {
  scaffold standalone no TRIVIAL supervised
  q=$(A request-approval LC plan)
  for w in approve yes okay lgtm 'go ahead' evet onay olur tamam; do printf '%s' "$q" | grep -Fq "$w" || die "the question does not list the accepted answer '$w'"; done
  ad=.agents/runs/LC/approvals
  for t in 'hmm bir dakika' 'sonra bakarız' '' 'the weather is nice today' 'approve the plan?' 'do not approve the plan' 'approve the plan, but wait' 'plan için emin değilim, onaylıyorum' 'unapproved plan' 'okay then' 'plan tamamen yanlış' "I shouldn't approve the plan" 'I cannot approve the plan' 'yes, delete nothing' 'plan için onay vermiyorum' 'plan onay yok' 'plan olmaz, onay yok' 'plan: onaylamıyorum, evet' 'plan onay bekliyor' 'I will approve the plan after I review the tests' 'what does the plan do before I approve' 'yes the plan is wrong' 'evet, plan yanlış' 'approve the plan — just kidding' 'PLAN ONAYLIYORUM DEĞİL'; do
    capture "$t"; expect_fail "an ambiguous answer approved: '$t'" A approve LC plan
    [ -z "$(ls "$ad" | grep -E '^[0-9]{3}-plan\.yaml$' || true)" ] || die "an approval file exists after '$t'"
    [ -n "$(ls "$ad" | grep -E '^[0-9]{3}-request-plan\.yaml$')" ] || die "the request is no longer pending after '$t'"
  done
  for t in 'approve the plan' 'Plan approved.' 'yes, plan' 'ok plan' 'okay, plan' 'LGTM plan' 'go ahead with the plan' 'plan onaylandı' 'plan onayliyorum' 'Plan: evet' 'plan tamam' 'plan olur'; do
    A request-approval LC plan >/dev/null; capture "$t"; A approve LC plan >/dev/null || die "an allowlisted answer was refused: '$t'"
    rm -f "$ad"/[0-9][0-9][0-9]-plan.yaml
  done
  # The grammar is locale independent (test-lib runs under LC_ALL=C): the same refusals and a positive under UTF-8.
  for t in "I shouldn't approve the plan" 'PLAN ONAYLIYORUM DEĞİL' 'plan onay yok' 'yes the plan is wrong'; do
    capture "$t"; expect_fail "an ambiguous answer approved under UTF-8: '$t'" env LC_ALL=en_US.UTF-8 sh ./.agents/scripts/agent.sh approve LC plan
  done
  A request-approval LC plan >/dev/null; capture 'PLAN ONAYLIYORUM'
  env LC_ALL=en_US.UTF-8 sh ./.agents/scripts/agent.sh approve LC plan >/dev/null || die "an allowlisted answer was refused under UTF-8"
  ok "approval detection is fail-closed (A108)"
}

# Delivery then cleanup: the commit moves HEAD past base_sha; cleanup must still succeed (base_sha an ancestor,
# task-owned patch = the CODE_DONE patch and committed), and afterwards the git hooks see no open run.
scenario_cleanup_after_delivery() {
  SC_BRANCH=1 scaffold orchestrated; to_code_done orchestrated; finish_done
  tb=$(git branch --show-current); [ "$tb" = proofline/LC-lc ] || die "task branch: $tb"
  mkdir -p "$base/hooks"; cp "$tl_agents/githooks/pre-commit" "$base/hooks/"; chmod +x "$base/hooks/pre-commit"
  git config core.hooksPath "$base/hooks"; PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY
  git add -A; expect_msg "a commit without the user's approval" 'commit approval' git commit -qm 'feat: lookup (LC)'
  A request-approval LC commit >/dev/null; capture 'commit it'; A approve LC commit >/dev/null
  git commit -qm 'feat: lookup (LC)' || die "the approved delivery commit was blocked"
  git checkout -q main; printf 'x\n' > other.txt; git add other.txt
  expect_msg "a commit on another branch while the run is open" 'task branch' git commit -qm other
  git reset -q other.txt; rm -f other.txt; git checkout -q "$tb"
  cp impl.txt "$base/impl.done"; printf 'edited after delivery\n' >> impl.txt
  expect_fail "cleanup accepted a delivered run whose content changed afterwards" A cleanup LC
  cp "$base/impl.done" impl.txt
  A cleanup LC >/dev/null || die "cleanup after the delivery commit failed: $(A cleanup LC 2>&1 | tail -1)"
  [ ! -e .agents/runs/LC ] && [ -z "$(A open-runs)" ] && A status | grep -Fxq 'active_task=none'
  git checkout -q main; printf 'x\n' > other.txt; git add other.txt
  git commit -qm 'chore: other' || die "a commit on another branch is still blocked after cleanup"
  ok "cleanup after the delivery commit; the run no longer blocks commits"
}

# A101: freeze refuses a PLAN.md scope entry without `criteria:` before recording anything (RUN.yaml untouched), and
# the repaired plan freezes without a scope approval.
scenario_freeze_scope_mapping() {
  scaffold standalone no TRIVIAL supervised
  before=$(cat .agents/runs/LC/RUN.yaml); good=$(cat .agents/runs/LC/PLAN.md)
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '  - path: impl_test.txt' '    criteria: [AC-1]' '---' '# Plan' > .agents/runs/LC/PLAN.md
  expect_msg "freeze accepted a scope entry without criteria" 'each entry needs `path` and `criteria:`' A freeze LC
  [ "$before" = "$(cat .agents/runs/LC/RUN.yaml)" ] || die "a refused freeze changed RUN.yaml"
  printf '%s\n' "$good" > .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve the plan'; A freeze LC >/dev/null
  grep -q 'scope_paths: "impl.txt,impl_test.txt"' .agents/runs/LC/RUN.yaml || die "scope_paths not recorded"
  ok "freeze validates scope mapping first"
}

run_sc scenario_standalone
run_sc scenario_approval_fail_closed
run_sc scenario_evidence_order
run_sc scenario_independence
run_sc scenario_orchestrated_loop
run_sc scenario_attribution
run_sc scenario_bounded_fix
run_sc scenario_fix_scope_format
run_sc scenario_fix_scope_symbol
run_sc scenario_amendment_fresh_budget
run_sc scenario_terminal
run_sc scenario_pipeline_trivial
run_sc scenario_classification_diff
run_sc scenario_pipeline_standard
run_sc scenario_classification
run_sc scenario_amend_plan_change
run_sc scenario_hardening
run_sc scenario_task_contract_bookkeeping standalone
run_sc scenario_task_contract_bookkeeping orchestrated
run_sc scenario_task_contract_edit standalone
run_sc scenario_task_contract_edit orchestrated
run_sc scenario_task_contract_laundering
run_sc scenario_task_contract_relocate
run_sc scenario_task_contract_adapter
run_sc scenario_report_root_cause
run_sc scenario_task_contract_projection
run_sc scenario_task_source_status
run_sc scenario_cleanup_after_delivery
run_sc scenario_freeze_scope_mapping
echo 'agent lifecycle tests passed'
