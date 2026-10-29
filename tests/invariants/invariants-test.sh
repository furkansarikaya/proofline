#!/bin/sh
# shellcheck disable=SC2010,SC2012,SC2015,SC2016,SC2154,SC2329 # assertion chains; literal command text; fixture vars come from test-lib.sh
# Core-invariant tests (CONTRIBUTING.md, "Core invariants"): one section per rule, each really attempts the forbidden
# action against the real agent.sh in a throwaway project. A patch that changes this file must say why in its pull
# request description (`Invariant-test-change:`, checked by tests/invariants/check-changed.sh) and review approves it separately.
#   LC_ONLY=<substring>   runs only matching scenarios.
#
# Not yet mechanical (said here instead of faked):
#   rule 3: a prompt capture is written by the runtime hook, so a fully malicious process that can write .agents/local/prompts/
#           itself is stopped by the hook layer and the sandbox (tests/enforcement), not by agent.sh; here every agent.sh path is
#           shown to refuse an agent role, an agent's text and hand-written files.
#   rule 4: what a REVIEWER or QA "reproduced" is judgment; only the verifier's commands and the worker's RED/GREEN evidence are
#           re-derived by script, and those are what is tested.
#   rule 5: separation of an implementer from a reviewer SESSION (two agents with the same role name) is the lead's dispatch
#           discipline plus role-bound commands; the script enforces the role boundary, which is what is tested.
set -u
if [ -z "${INV_INNER:-}" ]; then
  repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
  # test-lib.sh locates the control plane from $0, so it is sourced with $0 = its own path.
  INV_INNER=1 exec sh -c '. "$0"; . "$1"' "$repo/control-plane/agents/scripts/test-lib.sh" "$repo/tests/invariants/invariants-test.sh"
fi

gate_st() { A pipeline "$RID" | sed -n "s/^gate.$1=//p"; }
implemented() { worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null; }

# Rule 1: no CODE_DONE while a required gate has not passed for the current content, unless the user waived it.
sc_inv1_code_done_needs_gates() {
  scaffold orchestrated no CRITICAL; implemented
  expect_msg "inv1 CODE_DONE with no gate run" 'of LC is' A handoff LC CODE_DONE
  gates=$(required)
  for g in $gates; do
    [ "$g" != VERIFY ] || continue
    if [ "$g" = SECRETS ]; then A secret-scan LC >/dev/null; else gpass "$g"; fi
  done
  for g in $(A pipeline LC | sed -n 's/^focus\.\([A-Z_]*\)\.\([a-z]*\)=.*/\1 \2/p' | tr ' ' ':'); do RF_FOCUS=${g#*:} gpass "${g%%:*}"; done
  expect_msg "inv1 CODE_DONE while VERIFY has not run" 'VERIFY' A handoff LC CODE_DONE
  gpass VERIFY
  # a blocking FAIL on one gate stops it again
  gfail REVIEW_RULES impl.txt
  expect_msg "inv1 CODE_DONE over a blocking finding" 'REVIEW_RULES' A handoff LC CODE_DONE
  gpass REVIEW_RULES
  # a pass belongs to the content it judged: a later change makes it stale
  printf 'late edit\n' >> impl.txt
  expect_fail "inv1 CODE_DONE after the tree changed since the passes" A handoff LC CODE_DONE
  ok "inv1: CODE_DONE needs every required gate passed for the current content"
}

# Rule 2a: SECRETS and SECURITY findings cannot be waived, not even with the user's approval sentence.
sc_inv2_never_waivable() {
  scaffold orchestrated no CRITICAL
  worker RED fail impl_test.txt 'test: lookup'; worker GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null; [ "$(gate_st SECRETS)" = fail ] || die "inv2 the planted secret was not a FAIL"
  rec SECURITY FAIL high 'SECURITY-1|blocking|impl.txt:1|injection reachable from input|traced: input -> eval'
  for f in SECRETS-1 SECURITY-1; do
    expect_msg "inv2 a $f waiver approval was requested" 'never waivable' A request-approval LC "waive:$f"
    capture "I approve the waiver of $f."
    expect_msg "inv2 $f waived with the user's own sentence" 'never waivable' A waive LC "$f" --reason 'the user accepts this risk for the release'
  done
  expect_fail "inv2 CODE_DONE over unwaivable findings" A handoff LC CODE_DONE
  ok "inv2: a SECRETS or SECURITY finding is never waived, whoever asks"
}

# Rule 2b: SECRETS and SECURITY run again after any product-code change; a dependency or configuration change makes the
# run full tier, whose required set carries both. (A test-only fix may keep SECURITY: A200 narrows it by input; SECRETS always reruns.)
sc_inv2_run_on_change() {
  scaffold orchestrated no CRITICAL; implemented; pass_all
  rec REVIEW_TESTS FAIL high "REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil"
  A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl.txt 'impl: lookup of a missing key is nil'; A handoff LC IMPLEMENTED >/dev/null
  for g in SECRETS SECURITY; do [ "$(gate_st "$g")" != pass ] || die "inv2 $g carried over a product-code change"; done
  # a test-only fix: SECRETS still runs
  scaffold orchestrated no CRITICAL; implemented; pass_all
  rec REVIEW_TESTS FAIL high "REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil"
  A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: lookup of a missing key is nil'; A handoff LC IMPLEMENTED >/dev/null
  [ "$(gate_st SECRETS)" != pass ] || die "inv2 SECRETS carried over a test-only change"
  # dependency and configuration paths are never a small, SECURITY-free run
  for f in package.json main.tf; do
    scaffold standalone no STANDARD manual; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
    printf '{}\n' > "$f"
    [ "$(A tier LC)" = full ] || die "inv2 a change to $f is not tier full"
    case " $(required) " in *" SECURITY "*" SECRETS "*|*" SECRETS "*" SECURITY "*) ;; *) die "inv2 tier full for $f lacks SECURITY or SECRETS: $(required)" ;; esac
  done
  ok "inv2: product code reruns SECRETS and SECURITY; dependency and config changes require both"
}

# Rule 3: approvals, waivers and rationales come from the user's prompt only; an agent's text, role or hand-written file cannot make one.
sc_inv3_user_message_only() {
  scaffold orchestrated no CRITICAL; implemented
  rec REVIEW_RULES FAIL high "REVIEW_RULES-1|blocking|impl.txt:1|lookup returns the wrong value for an empty key|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single"
  A request-approval LC waive:REVIEW_RULES-1 >/dev/null
  # no user prompt capture and no terminal: nothing to approve with
  rm -rf .agents/local/prompts
  expect_msg "inv3 approve without a user message" 'no user prompt capture' A approve LC waive:REVIEW_RULES-1
  # an agent's own words are not a user message (no role but the lead approves, waives or requests an approval)
  for r in implementer reviewer security_reviewer qa verifier explorer; do
    capture 'I approve the waiver of REVIEW_RULES-1.'
    expect_fail "inv3 $r approved" AS "$r" approve LC waive:REVIEW_RULES-1
    expect_fail "inv3 $r waived" AS "$r" waive LC REVIEW_RULES-1 --reason 'accepted risk: the default is documented upstream'
    expect_fail "inv3 $r requested an approval" AS "$r" request-approval LC plan
  done
  # an approval or waiver file written by hand is not in the ledger chain and counts for nothing
  mkdir -p .agents/runs/LC/waivers
  gr=$(ls .agents/runs/LC/gates | grep 'REVIEW_RULES.yaml$' | tail -1)
  printf 'finding: "REVIEW_RULES-1"\ngate_record: "%s"\ngate_record_sha256: "%s"\n' "$gr" "$(tsha ".agents/runs/LC/gates/$gr")" > .agents/runs/LC/waivers/001-REVIEW_RULES-1.yaml
  [ "$(gate_st REVIEW_RULES)" = fail ] || die "inv3 a hand-written waiver counted: $(gate_st REVIEW_RULES)"
  # a user sentence that is ambiguous about what it approves is not an approval
  for t in 'I approve the waiver' 'I approve the waiver of REVIEW_RULES-2' 'I approve the plan'; do
    capture "$t"; expect_fail "inv3 approved by: $t" A approve LC waive:REVIEW_RULES-1
  done
  # a design rationale needs the user's approval too: the request alone, or an agent's attempt, leaves it unapproved
  mkdir -p docs/design; printf '# D\n\n## Pattern justifications\n- mono-labels: file names are the product here\n' > docs/design/DESIGN.md
  A request-approval LC rationale:mono-labels >/dev/null
  capture 'I approve the rationale mono-labels'; expect_fail "inv3 a reviewer approved a rationale" AS reviewer approve LC rationale:mono-labels
  [ "$(A design-rationales LC --json)" = '{"approved": {}}' ] || die "inv3 an unapproved rationale is approved: $(A design-rationales LC --json)"
  # control: the user's sentence naming the finding does record the approval
  capture 'I approve the waiver of REVIEW_RULES-1.'; A approve LC waive:REVIEW_RULES-1 >/dev/null || die "inv3 the user's sentence was refused"
  ok "inv3: approvals, waivers and rationales are recorded only from the user's message"
}

# Rule 4: evidence is reproduced independently; an agent's claim (a self-consistent report) is not evidence.
sc_inv4_evidence_reproduced() {
  command -v node >/dev/null 2>&1 || { echo "skip inv4 (node missing)"; exit 0; }
  SC_PLAN_EXTRA='
## Verification commands

- `sh .agents/local/check.sh`' scaffold orchestrated; implemented
  mkdir -p .agents/skills; cp -R "$tl_agents/../../skills/verify-proof" .agents/skills/verify-proof; cp -R "$tl_agents/../../skills/plan-contract" .agents/skills/plan-contract
  printf '.agents/skills/\n' >> .git/info/exclude
  printf '%s\n' 'echo ok 3 tests' > .agents/local/check.sh
  d=.agents/runs/LC
  vw() { # a self-consistent VERIFY.md claiming the command printed OUT and exited 0
    printf '%s\n' '# Verification: LC' '' '## Commands' '' '- `sh .agents/local/check.sh` | exit=0' "  output: $1" '' '## AC coverage' '' '| AC | test or command | status | evidence |' '|---|---|---|---|' \
      '| AC-1 | impl_test.txt::lookup | PASS | `sh .agents/local/check.sh` exit=0 |' '' '## Scope' '' 'verify-scope: exit=0' '' '## Design sync' '' 'design-sync: SKIPPED (no design documents)' '' '## Runtime' '' 'runtime: none (no runtime in this test)' '' \
      '## Pre-existing failures' '' 'None' '' '## Failures' '' 'None' '' 'Verdict: PASS' > "$d/VERIFY.md"
  }
  # the claim matches what the command really prints: recorded PASS (the control)
  vw 'ok 3 tests'
  out=$(AS verifier submit LC --confidence high --findings none --agent iv0 2>&1) || die "inv4 an honest report was refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier PASS' || die "inv4 an honest report was not PASS: $out"
  # the claim is internally consistent but false: the control plane re-runs the command and records FAIL
  vw 'ok 412 tests, 0 failed'
  out=$(AS verifier submit LC --confidence high --validator-result PASS --findings none --agent iv1 2>&1) || die "inv4 the fabricated report was refused instead of recorded FAIL: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "inv4 a fabricated but self-consistent report passed: $out"
  # a command the plan never listed is never run on a report's say-so
  printf 'touch .agents/local/ran-unplanned\n' > .agents/local/other.sh
  sed 's#sh .agents/local/check.sh#sh .agents/local/other.sh#g' "$d/VERIFY.md" > "$d/V.tmp" && mv "$d/V.tmp" "$d/VERIFY.md"
  out=$(AS verifier submit LC --confidence high --findings none --agent iv2 2>&1) || :
  [ ! -e .agents/local/ran-unplanned ] || die "inv4 the control plane ran a command nobody planned"
  printf '%s' "$out" | grep -q 'submitted: LC verifier PASS' && die "inv4 a PASS whose command could not be re-run was accepted: $out"
  ok "inv4: a self-consistent but false report is re-derived and rejected; an unplanned command is never run"
}

# Rule 4b: worker evidence is checked against the tree: a GREEN record with no change since RED is refused. An agent's
# claim of progress is not evidence.
sc_inv4_green_needs_change() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'
  wopen
  expect_msg "inv4 GREEN recorded with no implementation change" 'no implementation file changed' sh -c 'printf "command: go test ./...\ntarget: impl.txt\n" | AGENT_ROLE=implementer sh ./.agents/scripts/agent.sh worker-evidence LC GREEN pass'
  ok "inv4: GREEN evidence needs a real change in the tree, not the worker's word"
}

# Rule 5: the agent that wrote the change cannot review it: the implementer cannot record any gate result or review verdict.
sc_inv5_no_self_review() {
  scaffold orchestrated no CRITICAL; implemented
  for g in REVIEW_PLAN REVIEW_RULES REVIEW_TESTS SECURITY QA VERIFY; do
    f=$(result_for "$g" PASS high)
    expect_fail "inv5 the implementer recorded $g" AS implementer record LC --file "$f"
    expect_fail "inv5 the implementer's task-author-shaped role recorded $g" AS explorer record LC --file "$f"
  done
  expect_fail "inv5 the implementer ran a gate command" AS implementer gate LC REVIEW_RULES PASS
  expect_fail "inv5 the implementer ran secret-scan" AS implementer secret-scan LC
  expect_fail "inv5 the implementer submitted a review" AS implementer submit LC --focus rules+tests --confidence high --findings none --agent self1
  [ -z "$(ls .agents/runs/LC/gates 2>/dev/null | grep -v manifest)" ] || die "inv5 a rejected self-review left a gate record: $(ls .agents/runs/LC/gates)"
  # a result that names the reviewer role but arrives from the lead's or another role's session is refused for the gate it claims
  f=$(result_for REVIEW_RULES PASS high)
  expect_fail "inv5 a reviewer result recorded by the verifier" AS verifier record LC --file "$f"
  ok "inv5: the implementer (and any non-owner role) cannot record a review or any gate"
}

# Rule 6: in doubt the safe side wins: the gate runs, the question is asked, the finding stays blocking.
sc_inv6_safe_side() {
  scaffold orchestrated no CRITICAL; implemented
  # a low-confidence PASS is not a pass: the gate has not run to a verdict
  rec REVIEW_RULES PASS low
  [ "$(gate_st REVIEW_RULES)" = pass_low ] || die "inv6 a low-confidence PASS is $(gate_st REVIEW_RULES)"
  # a blocking finding cannot be downgraded to info by re-stating it
  rec REVIEW_RULES FAIL high "REVIEW_RULES-1|blocking|impl.txt:1|wrong default|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single"
  expect_msg "inv6 a blocking finding became info" 'is info, and was blocking' \
    rec REVIEW_RULES FAIL high "REVIEW_RULES-1|info|impl.txt:1|wrong default|traced: empty key -> nil" "REVIEW_RULES-2|blocking|impl.txt:3|new finding|traced: x; scan: grep -n lookup impl.txt; instances: single"
  # a pass after a test-only fix is carried only when the delta is provably tests: an undeterminable delta reruns the gate
  scaffold orchestrated no CRITICAL; implemented; pass_all
  rec REVIEW_TESTS FAIL high "REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil"
  A handoff LC IMPLEMENTING >/dev/null
  worker FIX pass impl_test.txt 'test: lookup of a missing key is nil'
  printf 'unplanned\n' > stray.txt   # a path outside the plan: the delta is no longer only tests
  A handoff LC IMPLEMENTED >/dev/null 2>&1 || :
  for g in REVIEW_RULES SECURITY SECRETS VERIFY; do [ "$(gate_st "$g")" != pass ] || die "inv6 $g was carried over a change it could not prove irrelevant"; done
  ok "inv6: low confidence, restated findings and unclear deltas do not pass a gate"
}

run_sc sc_inv1_code_done_needs_gates
run_sc sc_inv2_never_waivable
run_sc sc_inv2_run_on_change
run_sc sc_inv3_user_message_only
run_sc sc_inv4_evidence_reproduced
run_sc sc_inv4_green_needs_change
run_sc sc_inv5_no_self_review
run_sc sc_inv6_safe_side
echo 'invariants tests passed'
