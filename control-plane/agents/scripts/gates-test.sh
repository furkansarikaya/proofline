#!/bin/sh
# shellcheck disable=SC2010,SC2012,SC2015,SC2119,SC2120,SC2016,SC2329 # test code: ls over our own fixture names, assertion chains
# Self-tests for the proofline extensions of agent.sh: tier, the D12 result protocol (`record`), the gate
# set, per-gate staleness and the fix loop, waivers, approvals, questions, `next`, `decide`, metrics,
# config-check, scope `new: true`, secret-scan and ledger-note.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

gates_of() { pipe_val gates; }
gate_st() { A pipeline "$RID" | sed -n "s/^gate.$1=//p"; }
n_gates() { ls .agents/runs/LC/gates/*.yaml 2>/dev/null | wc -l | tr -d ' '; }
# implemented ORCH|SOLO: scaffolded run with RED/GREEN done and handoff IMPLEMENTED.
implemented() {
  if [ "$1" = orchestrated ]; then worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  else solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'; fi
  A handoff LC IMPLEMENTED >/dev/null
}
# scaffold without freeze: class, then the PLAN can be edited before `freeze`.
unfrozen() { scaffold standalone no "${1:-STANDARD}" manual; }

sc_tier() {
  unfrozen STANDARD; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  [ "$(A tier LC)" = docs ] || die "no change is not tier docs"
  printf 'notes\n' > notes.md; mkdir -p docs; printf 'guide\n' > docs/guide.txt
  [ "$(A tier LC)" = docs ] || die "plain documentation is not tier docs"
  rm -f notes.md; rm -rf docs
  mkdir -p skills/x; printf 'a skill\n' > skills/x/SKILL.md
  [ "$(AS reviewer tier LC)" = small ] || die "code-like markdown is not tier small"
  expect_state pipeline tier docs                                               # a non-lead role never records
  [ "$(A tier LC)" = small ]; expect_state pipeline tier small
  rm -rf skills
  [ "$(A tier LC)" = small ] || die "the tier decreased"
  printf '{}\n' > package.json
  [ "$(A tier LC)" = full ] || die "a risky path is not tier full"
  rm package.json; [ "$(A tier LC)" = full ] || die "the tier decreased from full"
  # size limits on a fresh run: > small_max_lines is full
  unfrozen STANDARD; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  printf 'one\n' >> impl.txt; [ "$(A tier LC)" = docs ] || die "a .txt change is not tier docs"
  printf 'package x\n' > app.go; [ "$(A tier LC)" = small ] || die "one small code file is not tier small"
  i=0; while [ $i -lt 31 ]; do printf 'line %s\n' $i >> app.go; i=$((i + 1)); done
  [ "$(A tier LC)" = full ] || die "more than small_max_lines is not tier full"
  # CRITICAL is always full; a plan with ## Data adds REVIEW_DATA
  unfrozen CRITICAL; printf '\n## Data\n\ndestructive: no\n\nno schema change in practice\n' >> .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve the plan'
  A freeze LC >/dev/null
  [ "$(gates_of)" = 'SECRETS REVIEW_PLAN REVIEW_RULES REVIEW_TESTS REVIEW_DATA SECURITY QA VERIFY' ] || die "CRITICAL gate set: $(gates_of)"
  ok "tier: docs, code-like markdown, risky path, size, never decreasing, CRITICAL full, REVIEW_DATA"
}

# B5/I7: risky paths and code-like markdown before docs; docs only by plain-documentation extension; the small
# limits measured on real code files. A non-lead `tier` computes without recording, so one run serves all.
sc_tier_paths() {
  unfrozen STANDARD; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  t() { mkdir -p "$(dirname "$1")"; printf 'x = 1\n' > "$1"; got=$(AS reviewer tier LC); rm -f "$1"; [ "$got" = "$2" ] || die "tier of $1 is $got, want $2"; }
  t docs/guide.adoc docs; t notes.mdx docs; t docs/api.rst docs; t guide.txt docs
  t docs/conf.py small; t docs/build.sh small; t docs/index.html small
  t requirements.txt full; t requirements-dev.txt full; t CMakeLists.txt full; t docs/requirements.txt full
  t skills/x/SKILL.md small; t AGENTS.md small
  i=0; while [ $i -lt 10 ]; do printf 'line %s\n' $i >> app.go; printf 'line %s\n' $i >> util.go; i=$((i + 1)); done
  [ "$(AS reviewer tier LC)" = small ] || die "two code files, 20 lines are not tier small"
  printf 'package x\n' > extra.go
  [ "$(AS reviewer tier LC)" = full ] || die "three code files are not tier full (small_max_files)"
  rm extra.go; i=0; while [ $i -lt 11 ]; do printf 'more %s\n' $i >> util.go; i=$((i + 1)); done
  [ "$(AS reviewer tier LC)" = full ] || die "31 changed lines of code are not tier full (small_max_lines)"
  ok "tier paths: docs only by extension, docs/ code is not docs, dependency manifests full, small limits on code files"
}

sc_record() {
  scaffold orchestrated; implemented orchestrated
  before=$(n_gates)
  f=$(result_for REVIEW_SMALL PASS)
  expect_msg "a wrong role recorded" 'does not match AGENT_ROLE' AS qa record LC --file "$f"
  sed "s/^FINGERPRINT: .*/FINGERPRINT: 0123456789abcdef0123456789abcdef01234567/" "$f" > "$base/r.md"
  expect_msg "a stale fingerprint was accepted" 'stale' AS reviewer record LC --file "$base/r.md"
  sed "s/^\(ARTIFACT: [^ ]*\) .*/\1 0000000000000000000000000000000000000000000000000000000000000000/" "$f" > "$base/r.md"
  expect_msg "a bad artifact hash was accepted" 'sha256 mismatch' AS reviewer record LC --file "$base/r.md"
  sed "s/^ARTIFACT: .*/ARTIFACT: ..\/..\/..\/impl.txt $(tsha impl.txt)/" "$f" > "$base/r.md"
  expect_msg "an artifact outside the run was accepted" 'run-relative' AS reviewer record LC --file "$base/r.md"
  mkdir -p .agents/runs/LC/reviews/proof-review/plan .agents/runs/LC/reviews/proof-review/other
  printf 'Verdict: PASS\n' > .agents/runs/LC/reviews/proof-review/plan/REPORT.md; printf 'Verdict: PASS\n' > .agents/runs/LC/reviews/proof-review/other/REPORT.md
  sed "s#^ARTIFACT: .*#ARTIFACT: reviews/proof-review/plan/REPORT.md $(tsha .agents/runs/LC/reviews/proof-review/plan/REPORT.md)#" "$f" > "$base/r.md"
  expect_msg "a rules+tests result used the plan focus's artifact" 'outside the paths' AS reviewer record LC --file "$base/r.md"
  sed "s#^ARTIFACT: .*#ARTIFACT: reviews/proof-review/other/REPORT.md $(tsha .agents/runs/LC/reviews/proof-review/other/REPORT.md)#" "$f" > "$base/r.md"
  expect_msg "an unregistered review directory was accepted" 'not a registered run artifact' AS reviewer record LC --file "$base/r.md"
  rm -rf .agents/runs/LC/reviews/proof-review/plan .agents/runs/LC/reviews/proof-review/other
  grep -v '^CONFIDENCE:' "$f" > "$base/r.md"
  expect_msg "a header without CONFIDENCE was accepted" 'malformed header' AS reviewer record LC --file "$base/r.md"
  { echo 'Here is my review.'; cat "$f"; } > "$base/r.md"
  expect_msg "a result not starting with the header was accepted" 'malformed header' AS reviewer record LC --file "$base/r.md"
  sed 's/^FOCUS: .*/FOCUS: bugs/' "$f" > "$base/r.md"
  expect_msg "an unknown FOCUS was accepted" 'FOCUS' AS reviewer record LC --file "$base/r.md"
  sed 's/^RESULT: .*/RESULT: NEEDS_INPUT/' "$f" > "$base/r.md"
  expect_msg "a gate role returned NEEDS_INPUT" 'not valid for role reviewer' AS reviewer record LC --file "$base/r.md"
  f=$(result_for REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|info|impl.txt:1|suspicion|none')
  expect_msg "a FAIL with only info rows was accepted" 'at least one blocking' AS reviewer record LC --file "$f"
  f=$(result_for REVIEW_SMALL PASS high 'REVIEW_SMALL-1|blocking|impl.txt:1|real bug|traced')
  expect_msg "a PASS with a blocking row was accepted" 'PASS cannot carry' AS reviewer record LC --file "$f"
  f=$(result_for REVIEW_SMALL FAIL high 'QA-1|blocking|impl.txt:1|real bug|traced')
  expect_msg "a finding id of another gate was accepted" 'want REVIEW_SMALL-<n>' AS reviewer record LC --file "$f"
  f=$(result_for REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|HIGH|impl.txt:1|real bug|traced')
  expect_msg "a severity outside blocking|info was accepted" 'severity' AS reviewer record LC --file "$f"
  for placeholder in '(none)' none - 'n/a'; do
    f=$(result_for REVIEW_SMALL PASS high "$placeholder|info|-|no findings|none")
    expect_msg "a placeholder finding was accepted: $placeholder" 'no findings: omit rows, keep only the table header' AS reviewer record LC --file "$f"
  done
  [ "$(n_gates)" = "$before" ] || die "a rejected result left a gate record"
  [ ! -d .agents/runs/LC/results ] || [ -z "$(ls .agents/runs/LC/results)" ] || die "a rejected result left a results file"
  # low confidence: recorded as pass_low and does not satisfy the gate
  rec REVIEW_SMALL PASS low
  [ "$(gate_st REVIEW_SMALL)" = pass_low ] || die "low-confidence PASS is $(gate_st REVIEW_SMALL)"
  A secret-scan LC >/dev/null; gpass QA; gpass VERIFY
  expect_msg "CODE_DONE counted a pass_low" 'REVIEW_SMALL of LC is pass_low' A handoff LC CODE_DONE
  # a skill-owned results file is never overwritten; record writes NNN-<role>.result.md
  mkdir -p .agents/runs/LC/results; printf '# explorer evidence\n' > .agents/runs/LC/results/005-explorer.md
  gpass REVIEW_SMALL
  ls .agents/runs/LC/results/006-reviewer.result.md >/dev/null || die "record did not write NNN-<role>.result.md"
  [ "$(cat .agents/runs/LC/results/005-explorer.md)" = '# explorer evidence' ]
  grep -q "^result_sha256: \"$(tsha .agents/runs/LC/results/006-reviewer.result.md)\"" .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "the gate does not bind the raw result sha256"
  grep -q 'event=record:reviewer:PASS .*sha256=' .agents/runs/LC/LEDGER.log || die "record is not ledgered with the raw sha256"
  f=$(result_for REVIEW_SMALL PASS)
  sed "s#^ARTIFACT: #ARTIFACT: $(pwd)/.agents/runs/LC/#" "$f" > "$base/r.md"
  AS reviewer record LC --file "$base/r.md" >/dev/null
  grep -q '^artifact: "reviews/proof-review/small/' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "absolute in-run artifact was not normalized"
  sed 's#^ARTIFACT: #ARTIFACT: .agents/runs/LC/#' "$f" > "$base/r.md"
  AS reviewer record LC --file "$base/r.md" >/dev/null
  grep -q '^artifact: "reviews/proof-review/small/' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "project-relative in-run artifact was not normalized"
  sed "s#^ARTIFACT: .*#ARTIFACT: .agents/runs/LC/../../../impl.txt $(tsha impl.txt)#" "$f" > "$base/r.md"
  expect_msg 'project-relative artifact outside run was accepted' 'inside the run' AS reviewer record LC --file "$base/r.md"
  mkdir -p "$base/outside"; printf 'Verdict: PASS\n' > "$base/outside/REPORT.md"
  ln -s "$base/outside" .agents/runs/LC/reviews/proof-review/small/link
  sed "s#^ARTIFACT: .*#ARTIFACT: reviews/proof-review/small/link/REPORT.md $(tsha "$base/outside/REPORT.md")#" "$f" > "$base/r.md"
  expect_msg 'run-relative artifact resolving outside run was accepted' 'inside the run' AS reviewer record LC --file "$base/r.md"
  rm .agents/runs/LC/reviews/proof-review/small/link
  sed "s#^ARTIFACT: .*#ARTIFACT: $(pwd)/impl.txt $(tsha impl.txt)#" "$f" > "$base/r.md"
  expect_msg "absolute artifact outside run was accepted" 'inside the run' AS reviewer record LC --file "$base/r.md"
  # qa task result (QA plan step) is a non-gate result
  printf 'ROLE: qa\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: %s\nARTIFACT: QA_PLAN.md %s\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n' "$(A fingerprint LC)" "$(tsha .agents/runs/LC/QA_PLAN.md)" > "$base/qa.md"
  n=$(n_gates); AS qa record LC --file "$base/qa.md" >/dev/null; [ "$(n_gates)" = "$n" ] || die "a qa task result created a gate record"
  A handoff LC CODE_DONE >/dev/null
  ok "record: role, fingerprint, artifact, header, focus, findings, pass_low, result naming, qa task result"
}

sc_submit() {
  scaffold orchestrated; implemented orchestrated
  small=.agents/runs/LC/reviews/proof-review/small
  expect_msg "the lead submitted" 'lead never submits' A submit LC --confidence high
  expect_msg "a missing confidence was accepted" '--confidence' AS reviewer submit LC --focus rules+tests
  expect_msg "a reviewer without focus was accepted" 'need --focus' AS reviewer submit LC --confidence high
  expect_msg "a missing report was accepted" 'not found in the run' AS reviewer submit LC --focus rules+tests --confidence high --agent ag0
  grep -q '^status=rejected' .agents/local/submissions/ag0.status || die "a rejection was not written to the submission status"
  mkdir -p "$small"; printf 'review of the whole current tree\n' > "$small/REPORT.md"
  # no header, fingerprint or hash is typed: the script supplies them; any path spelling of the report works
  out=$(AS reviewer submit LC --focus rules+tests --confidence high --agent ag1) || die "submit failed: $out"
  [ "$(gate_st REVIEW_SMALL)" = pass ] || die "submit did not record a pass: $(gate_st REVIEW_SMALL)"
  grep -q '^status=ok' .agents/local/submissions/ag1.status && grep -q '^gate=REVIEW_SMALL' .agents/local/submissions/ag1.status || die "submission status is not ok"
  for art in "$(pwd)/$small/REPORT.md" ".agents/runs/LC/reviews/proof-review/small/REPORT.md" "./.agents/runs/LC/reviews/proof-review/small/REPORT.md" "reviews/proof-review/small/REPORT.md" "./reviews/proof-review/small/REPORT.md"; do
    AS reviewer submit LC --artifact "$art" --confidence high >/dev/null || die "artifact spelling not accepted: $art"
  done
  grep -q '^artifact: "reports/snapshots/[0-9a-f]\{12\}-reviewer-reviews_proof-review_small_REPORT.md"' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "artifact was not normalized to its immutable snapshot"
  expect_msg "an artifact outside the run was accepted" 'inside the run' AS reviewer submit LC --focus rules+tests --artifact ../../../impl.txt --confidence high
  expect_msg "an artifact of another focus was accepted" 'outside the paths' AS reviewer submit LC --focus plan --artifact reviews/proof-review/small/REPORT.md --confidence high
  # the result follows from the findings
  printf 'blocking|impl.txt:1|lookup returns the wrong value for an empty key|traced: empty key -> nil\n' > "$base/f.rows"
  expect_msg "PASS with a blocking finding was accepted" 'contradicts' AS reviewer submit LC --focus rules+tests --result PASS --findings "$base/f.rows" --confidence high
  AS reviewer submit LC --focus rules+tests --findings "$base/f.rows" --confidence high >/dev/null
  [ "$(gate_st REVIEW_SMALL)" = fail ] || die "blocking findings did not fail the gate"
  grep -q '^finding: REVIEW_SMALL-1|blocking|impl.txt:1|' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "finding ids are not assigned by the script"
  printf '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n| X-9 | info | impl.txt:2 | a note | seen |\n' > "$base/f.md"
  AS reviewer submit LC --focus rules+tests --findings "$base/f.md" --confidence high >/dev/null
  [ "$(gate_st REVIEW_SMALL)" = pass ] || die "a markdown table with info rows did not pass"
  printf 'high|impl.txt:1|x|y\n' > "$base/bad.rows"
  expect_msg "a bad severity was accepted" 'severity' AS reviewer submit LC --focus rules+tests --findings "$base/bad.rows" --confidence high
  # BLOCKED carries its reason into a report the script creates when none exists
  AS reviewer submit LC --focus plan --result BLOCKED --reason 'no test runner in the sandbox' --confidence high --agent ag2 >/dev/null || die "BLOCKED submit failed"
  grep -q 'no test runner' .agents/runs/LC/reviews/proof-review/plan/REPORT.md || die "BLOCKED reason not written to the report"
  [ "$(gate_st REVIEW_PLAN)" != pass ] || die "BLOCKED recorded a pass"
  ok "submit: script-built header, normalized artifact, derived result, assigned ids, rejection status, BLOCKED report"
}

sc_language() {
  scaffold orchestrated; implemented orchestrated
  small=.agents/runs/LC/reviews/proof-review/small; mkdir -p "$small"
  printf 'Bu rapor T\303\274rk\303\247e yaz\304\261ld\304\261: \303\247ok \305\237\303\266yle \304\237\303\274zel.\n' > "$small/REPORT.md"
  expect_msg "a Turkish report was accepted" 'run artifacts are English' AS reviewer submit LC --focus rules+tests --confidence high
  printf 'The review is complete.\n\n> Kullan\304\261c\304\261 iste\304\237i: s\303\274r\303\274m\303\274 d\303\274zelt\n\n```\n\305\237\303\266yle\n```\nJos\303\251 reviewed it.\n' > "$small/REPORT.md"
  AS reviewer submit LC --focus rules+tests --confidence high >/dev/null || die "a quoted request / one accented name was refused"
  printf 'blocking|impl.txt:1|de\304\237er \303\274retilmiyor \305\237\303\266yle|traced\n' > "$base/tr.rows"
  expect_msg "Turkish findings were accepted" 'run artifacts are English' AS reviewer submit LC --focus rules+tests --findings "$base/tr.rows" --confidence high
  ok "language: non-English report and findings are rejected at submit; blockquotes, fences and one accented name pass"
}

sc_report_stdin() {
  scaffold orchestrated; implemented orchestrated
  printf 'review of the whole current tree\n' | AS reviewer submit LC --focus rules+tests --confidence high --report - >/dev/null || die "submit --report - failed"
  [ "$(cat .agents/runs/LC/reviews/proof-review/small/REPORT.md)" = 'review of the whole current tree' ] || die "the report was not written from stdin"
  [ "$(gate_st REVIEW_SMALL)" = pass ] || die "report on stdin did not record a pass"
  printf 'x\n' | expect_msg "a report outside the role's paths" 'outside the paths' AS reviewer submit LC --focus rules+tests --confidence high --artifact reviews/proof-review/plan/REPORT.md --report -
  # the task-source file is bookkeeping: the control plane edits it after the gates
  fp=$(A fingerprint LC); mkdir -p .agents/tasks; printf 'changed bookkeeping\n' > .agents/tasks/LC-task.md
  [ "$(A fingerprint LC)" = "$fp" ] || die "the tasks directory changed the content fingerprint"
  ok "submit --report -: written by the script, role paths enforced; the tasks directory is outside the fingerprint"
  # a read-only object database (a Codex workspace-write sandbox) still yields the same fingerprint
  fp=$(A fingerprint LC); printf 'new content\n' >> impl.txt; fp2=$(A fingerprint LC)
  chmod -R a-w .git/objects
  fp_ro=$(A fingerprint LC) || { chmod -R u+w .git/objects; die "fingerprint failed with a read-only object database"; }
  chmod -R u+w .git/objects
  [ "$fp_ro" = "$fp2" ] || die "read-only object database changed the fingerprint ($fp_ro vs $fp2)"
  [ "$fp2" != "$fp" ] || die "a content change did not change the fingerprint"
  ok "fingerprint: same value with a read-only object database"

}

sc_parallel_lock() {
  scaffold orchestrated; implemented orchestrated
  printf '# Completion Report: LC\n' > .agents/runs/LC/COMPLETION_REPORT.md
  f=$(result_for REVIEW_SMALL PASS)
  i=1 pids=''
  while [ "$i" -le 8 ]; do
    if [ $((i % 2)) -eq 0 ]; then A decide LC reviewer --focus rules+tests > "$base/parallel-$i.out" 2>&1 &
    else A ledger-note LC "parallel-$i" > "$base/parallel-$i.out" 2>&1 & fi
    pids="$pids $!"; i=$((i + 1))
  done
  i=9
  while [ "$i" -le 10 ]; do
    AS reviewer record LC --file "$f" > "$base/parallel-$i.out" 2>&1 &
    pids="$pids $!"; i=$((i + 1))
  done
  for pid in $pids; do wait "$pid" || die "parallel command failed: $(cat "$base"/parallel-*.out)"; done
  [ ! -e .agents/runs/LC/.lock ] && [ ! -e .agents/local/.lock ] || die 'record left a lock after exit'
  A verify-seal LC >/dev/null; A validate LC >/dev/null
  awk '{ s=$1; sub(/^seq=/, "", s); if (s != NR) exit 1 } END { if (NR < 10) exit 1 }' .agents/runs/LC/LEDGER.log || die 'parallel ledger sequence is broken'
  [ "$(find .agents/runs/LC/decisions -type f -name '???-*' | wc -l | tr -d ' ')" -eq 4 ] || die 'parallel decisions collided'
  [ "$(find .agents/runs/LC/results -type f -name '???-reviewer.result.md' | wc -l | tr -d ' ')" -eq 2 ] || die 'parallel results collided'
  [ "$(find .agents/runs/LC/gates -type f -name '???-REVIEW_SMALL.yaml' | wc -l | tr -d ' ')" -eq 2 ] || die 'parallel gates collided'
  mkdir .agents/runs/LC/.lock; printf '99999999\n' > .agents/runs/LC/.lock/pid
  A ledger-note LC stale >/dev/null || die 'stale lock was not broken'
  grep -q 'event=lock-break .*stale lock holder pid=99999999' .agents/runs/LC/LEDGER.log || die 'stale lock break was not ledgered'
  mkdir .agents/runs/LC/.lock; printf '%s\n' "$$" > .agents/runs/LC/.lock/pid
  expect_msg 'live lock did not time out' 'lock timeout after 1s' env PROOFLINE_LOCK_TIMEOUT=1 sh ./.agents/scripts/agent.sh ledger-note LC blocked
  rm -f .agents/runs/LC/.lock/pid; rmdir .agents/runs/LC/.lock
  A verify-seal LC >/dev/null; A validate LC >/dev/null
  ok 'parallel decide, ledger-note and record; stale and live locks'
}

sc_fix_loop() {
  scaffold orchestrated; implemented orchestrated
  A secret-scan LC >/dev/null; gfail REVIEW_SMALL impl.txt; gpass QA; gpass VERIFY
  [ "$(gate_st REVIEW_SMALL)" = fail ] && [ "$(gate_st QA)" = pass ] && [ "$(gate_st SECRETS)" = pass ]
  A next LC | grep -q '^next=agent.sh handoff LC IMPLEMENTING (fix round 1' || die "next does not start fix round 1"
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: empty key default'; A handoff LC IMPLEMENTED >/dev/null
  [ "$(gate_st QA)" = stale ] && [ "$(gate_st REVIEW_SMALL)" = stale ] || die "passes on older content are not stale"
  A secret-scan LC >/dev/null; gpass REVIEW_SMALL; gpass QA
  [ "$(A next LC | grep -c '^next=')" = 1 ] && A next LC | grep -q '^next=dispatch.sh LC verifier' || die "next does not list only the stale gate: $(A next LC)"
  gfail VERIFY impl.txt
  A handoff LC IMPLEMENTING >/dev/null
  [ "$(pipe_val fix_round)" = 2 ] && [ "$(pipe_val escalation)" = yes ] || die "round 2 does not set the escalation flag"
  A decide LC implementer >/dev/null; grep -q 'signals=fix_round_2' .agents/runs/LC/decisions/*-implementer.decision || die "decide misses fix_round_2"
  worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null
  gfail REVIEW_SMALL impl.txt
  expect_msg "a third round was allowed" 'fix rounds exhausted' A handoff LC IMPLEMENTING
  A next LC | grep -q '^next=agent.sh terminate LC FAILED' || die "next does not point to terminate FAILED"
  printf 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: REVIEW_SMALL and VERIFY failed on all three contents\n' | A terminate LC FAILED >/dev/null
  expect_state execution state FAILED
  ok "fix loop: per-gate status, only stale gates listed, round-2 escalation, terminate FAILED"
}

sc_waiver() {
  scaffold orchestrated; implemented orchestrated
  A secret-scan LC >/dev/null; gfail REVIEW_SMALL impl.txt; gpass QA; gpass VERIFY
  expect_msg "a waiver without approval" 'needs the user' A waive LC REVIEW_SMALL-1 --reason 'accepted risk: the default is documented upstream'
  expect_msg "a waiver without a reason" 'reason' A waive LC REVIEW_SMALL-1
  A request-approval LC waive:REVIEW_SMALL-1 >/dev/null
  capture 'approved, go ahead'
  expect_msg "an approval text not naming the finding" 'no approval phrase' A approve LC waive:REVIEW_SMALL-1
  capture 'I approve waiving REVIEW_SMALL-1, the default is documented'
  A approve LC waive:REVIEW_SMALL-1 >/dev/null
  expect_fail "a reviewer waived" AS reviewer waive LC REVIEW_SMALL-1 --reason 'accepted risk: the default is documented upstream'
  A waive LC REVIEW_SMALL-1 --reason 'accepted risk: the default is documented upstream' >/dev/null
  [ "$(gate_st REVIEW_SMALL)" = waived ] || die "a fully waived FAIL is $(gate_st REVIEW_SMALL)"
  grep -q 'event=waive ' .agents/runs/LC/LEDGER.log
  A handoff LC CODE_DONE >/dev/null
  # SECRETS findings are never waivable
  scaffold orchestrated; worker RED fail impl_test.txt 'test: lookup'; worker GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null; [ "$(gate_st SECRETS)" = fail ]
  expect_msg "a SECRETS waiver approval was requested" 'never waivable' A request-approval LC waive:SECRETS-1
  expect_msg "a SECRETS finding was waived" 'never waivable' A waive LC SECRETS-1 --reason 'it is only a test fixture value anyway'
  # SECURITY findings are never waivable
  unfrozen CRITICAL; approve_as_user plan 'approve the plan'; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'impl: lookup'; A handoff LC IMPLEMENTED >/dev/null
  rec SECURITY FAIL high 'SECURITY-1|blocking|impl.txt:1|injection reachable from input|traced: input -> eval'
  expect_msg "a SECURITY waiver approval was requested" 'never waivable' A request-approval LC waive:SECURITY-1
  expect_msg "a SECURITY finding was waived" 'never waivable' A waive LC SECURITY-1 --reason 'the input is trusted in this deployment'
  ok "waivers: approval naming the finding, lead only, SECRETS and SECURITY never"
}

sc_approvals() {
  unfrozen COMPLEX
  expect_msg "approve without a request" 'no approval request' A approve LC plan
  A request-approval LC plan | grep -q '^QUESTIONS:' || die "request-approval does not print the D13 question"
  expect_msg "approve without TTY or capture" 'no user prompt capture' A approve LC plan
  capture 'approve the plan' "$(( $(date +%s) - 100 ))"
  expect_msg "a stale capture was accepted" 'stale capture' A approve LC plan
  capture 'looks fine to me'
  expect_msg "a capture without an approval phrase" 'no approval phrase' A approve LC plan
  capture 'approve the plan'; sed 's/"sha256":"[0-9a-f]*"/"sha256":"00"/' .agents/local/prompts/s1.json > "$base/c.json"; cp "$base/c.json" .agents/local/prompts/s1.json
  expect_msg "a capture with a wrong sha256" 'sha256 does not match' A approve LC plan
  capture 'Approve the PLAN, onaylıyorum'
  A approve LC plan >/dev/null
  expect_msg "one request approved twice" 'already approved' A approve LC plan
  A request-approval LC plan >/dev/null
  expect_msg "a prompt reused for a second approval" 'single-use' A approve LC plan
  grep -q '^answered_by: "user"' .agents/runs/LC/approvals/*-plan.yaml
  # commit approvals bind the content fingerprint and are consumed once
  A freeze LC >/dev/null
  grep -q '^consumed: "true"' .agents/runs/LC/approvals/*-plan.yaml || die "freeze did not consume the plan approval"
  A request-approval LC commit >/dev/null; capture 'commit it'; A approve LC commit >/dev/null
  expect_fail "approval-consume with another fingerprint" A approval-consume LC commit 0123456789abcdef0123456789abcdef01234567
  A approval-consume LC commit "$(A fingerprint LC)" >/dev/null
  expect_fail "a commit approval consumed twice" A approval-consume LC commit "$(A fingerprint LC)"
  # outside a run: push approvals in .agents/local
  A request-approval - push >/dev/null; capture 'push it'; A approve - push >/dev/null
  A approval-consume - push >/dev/null
  expect_fail "a no-run plan approval" A request-approval - plan
  ok "approvals: request, capture freshness/phrase/sha, single-use, commit binding, no-run push"
}

# Prompt captures and approval files must be regular single-link files on a symlink-free path under the project.
sc_capture_integrity() {
  unfrozen COMPLEX
  A request-approval LC plan >/dev/null
  capture 'approve the plan'; mv .agents/local/prompts/s1.json "$base/real.json"; ln -s "$base/real.json" .agents/local/prompts/s1.json
  expect_msg "a symlinked capture was accepted" 'single-link' A approve LC plan
  rm .agents/local/prompts/s1.json; mv "$base/real.json" .agents/local/prompts/s1.json; ln .agents/local/prompts/s1.json "$base/hard.json"
  expect_msg "a hard-linked capture was accepted" 'single-link' A approve LC plan
  rm -f "$base/hard.json"; mv .agents/local/prompts "$base/prompts"; ln -s "$base/prompts" .agents/local/prompts
  expect_msg "a capture under a symlinked prompts directory was accepted" 'single-link' A approve LC plan
  rm .agents/local/prompts; mv "$base/prompts" .agents/local/prompts
  A approve LC plan >/dev/null
  A freeze LC >/dev/null
  # approval files: a symlinked approval is never consumed
  A request-approval LC commit >/dev/null; capture 'commit it'; A approve LC commit >/dev/null
  cf=$(ls .agents/runs/LC/approvals/*-commit.yaml | grep -v request); mv "$cf" "$base/appr.yaml"; ln -s "$base/appr.yaml" "$cf"
  expect_fail "a symlinked approval file was consumed" A approval-consume LC commit "$(A fingerprint LC)"
  rm "$cf"; cp "$base/appr.yaml" "$cf"; ln "$cf" "$base/appr-hard.yaml"
  expect_fail "a hard-linked approval file was consumed" A approval-consume LC commit "$(A fingerprint LC)"
  rm -f "$base/appr-hard.yaml"
  A approval-consume LC commit "$(A fingerprint LC)" >/dev/null
  ok "captures and approvals: regular, single-link, symlink-free path"
}

# The lead's own question (D13) and dispatch's failover question: `ask` stores a pending question.
sc_ask() {
  scaffold orchestrated
  printf 'QUESTIONS:\n1. Split the cache into its own module?\n   options: yes | no\n   recommended: no\n   why: AC-1 is met either way\n' > "$base/ask.md"
  expect_fail "a specialist asked as the lead" AS reviewer ask LC --file "$base/ask.md"
  expect_fail "ask without a numbered question" sh -c "printf 'no question here\n' | sh ./.agents/scripts/agent.sh ask LC"
  A ask LC --file "$base/ask.md" >/dev/null
  expect_state execution awaiting_input true
  grep -q '^asked_at: [0-9]' .agents/runs/LC/questions/001.md || die "ask stored no asked_at"
  A questions LC | grep -Fq '1. Split the cache into its own module?' || die "questions does not show the asked question"
  A questions LC | grep -q '^QUESTIONS:' && die "the QUESTIONS: line was stored"
  A next LC | grep -q '^next=agent.sh questions LC' || die "next does not stop for the asked question"
  grep -q 'event=ask .*questions/001.md@' .agents/runs/LC/LEDGER.log || die "ask was not ledgered"
  capture 'no, keep it in one module'; printf 'no, keep it in one module\n' | A answer LC 1 >/dev/null
  grep -q '^answered_by: user' .agents/runs/LC/questions/001.answer.md || die "the user's answer is not answered_by user"
  expect_state execution awaiting_input false
  A verify-seal LC >/dev/null
  ok "ask: the lead's question is pending, verbatim, ledgered, answered like a specialist's"
}

sc_supervised_destructive() {
  unfrozen COMPLEX
  expect_msg "supervised freeze without plan approval" 'plan approval' A freeze LC
  A next LC | grep -q '^next=agent.sh request-approval LC plan' || die "next does not ask for the plan approval"
  approve_as_user plan 'approve the plan'
  printf 'edited after approval\n' >> .agents/runs/LC/PLAN.md
  expect_msg "an approval for an older PLAN.md" 'plan approval' A freeze LC
  approve_as_user plan 'approve the plan again'
  A freeze LC >/dev/null
  ok "supervised freeze needs a plan approval bound to PLAN.md"
  # destructive data change: forced CRITICAL, needs plan + destructive approvals
  unfrozen STANDARD
  printf '\n## Data\n\ndestructive: maybe\n' >> .agents/runs/LC/PLAN.md
  expect_msg "an invalid ## Data first line" 'destructive: yes' A freeze LC
  sed 's/^destructive: maybe$/destructive: yes/' .agents/runs/LC/PLAN.md > "$base/p.md"; cp "$base/p.md" .agents/runs/LC/PLAN.md
  expect_fail "a destructive plan froze without approvals" A freeze LC
  expect_state pipeline classification CRITICAL
  expect_msg "a destructive plan reclassified below CRITICAL" 'CRITICAL' A classify LC STANDARD
  approve_as_user plan 'approve the plan'
  expect_msg "destructive freeze without destructive approval" 'destructive approval' A freeze LC
  approve_as_user destructive 'approve the destructive migration'
  expect_msg "a destructive plan with no expand/contract steps froze" 'without expand/contract steps' A freeze LC
  A next LC | grep -q 'destructive plan without expand/contract steps' || die "next does not name the missing expand/contract steps"
  # a one-release plan: the destructive step shares the expand phase
  printf '\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | drop_column | books.legacy_notes | yes | no | restore from backup | table rewrite |\n' >> .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve the plan, third time'; approve_as_user destructive 'approve the destructive migration, second time'
  expect_msg "a one-release destructive plan froze" 'without expand/contract steps' A freeze LC
  # expand then contract: accepted
  sed '/^| S1 | expand | drop_column/d' .agents/runs/LC/PLAN.md > "$base/p.md"; cp "$base/p.md" .agents/runs/LC/PLAN.md
  printf '| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n' >> .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve the plan, fourth time'; approve_as_user destructive 'approve the destructive migration, third time'
  A freeze LC >/dev/null
  [ "$(pipe_val tier)" = full ]
  ok "destructive plan: forced CRITICAL, plan + destructive approvals, expand/contract steps required"
  # an explicit single-step approval is the only way to a one-step destructive change
  unfrozen STANDARD
  printf '\n## Data\n\ndestructive: yes\nsingle_step: yes\n\ndrop books.legacy_notes in one migration\n' >> .agents/runs/LC/PLAN.md
  printf '\nThe user wants this migration as a single step.\n' >> .agents/runs/LC/TASK.md
  approve_as_user plan 'approve the plan, fifth time'; approve_as_user destructive 'approve the destructive migration, fourth time'
  expect_msg "a single_step plan froze without the single-step approval" "single-step approval" A freeze LC
  A next LC | grep -q '^next=agent.sh request-approval LC single_step' || die "next does not ask for the single_step approval"
  approve_as_user single_step 'approve the migration as a single step'
  A freeze LC >/dev/null || die "an approved single-step plan was refused"
  ok "single_step: yes needs the user's single-step approval"
}

sc_questions() {
  scaffold orchestrated
  mkdir -p .agents/runs/LC/reports; printf '# explorer notes\n' > .agents/runs/LC/reports/001-explorer.md
  q() { printf 'ROLE: explorer\nTASK: LC\nRESULT: NEEDS_INPUT\nCONFIDENCE: medium\nFINGERPRINT: %s\nARTIFACT: reports/001-explorer.md %s\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n\n%s' "$(A fingerprint LC)" "$(tsha .agents/runs/LC/reports/001-explorer.md)" "$1" > "$base/q.md"; AS explorer record LC --file "$base/q.md"; }
  expect_msg "NEEDS_INPUT without questions" 'QUESTIONS' q ''
  q 'QUESTIONS:
1. Which default should an empty key return?
   options: nil | empty string
   recommended: nil
   why: AC-1 depends on it
' >/dev/null
  q 'QUESTIONS:
1. Keep the old lookup name?
   options: yes | no
   recommended: yes
   why: callers depend on it
' >/dev/null
  expect_state execution awaiting_input true
  A questions LC | grep -Fq '1. Which default should an empty key return?' || die "questions are not relayed verbatim"
  A next LC | grep -q '^next=agent.sh questions LC' || die "next does not point to the questions"
  capture 'the answer is: empty string'
  printf 'empty string\n' | A answer LC 1 >/dev/null
  grep -q '^answered_by: user' .agents/runs/LC/questions/001.answer.md || die "an answer contained in the user prompt is not answered_by user"
  expect_state execution awaiting_input true
  printf 'yes, keep it\n' | A answer LC 2 >/dev/null
  grep -q '^answered_by: lead' .agents/runs/LC/questions/002.answer.md || die "an answer the user never gave is not answered_by lead"
  expect_state execution awaiting_input false
  # I4: a capture older than the question, or an answer under 3 characters, is never the user's
  q 'QUESTIONS:
1. Which default for a missing file?
' >/dev/null
  capture 'the default is an empty list' "$(( $(date +%s) - 100 ))"
  printf 'the default is an empty list\n' | A answer LC 3 >/dev/null
  grep -q '^answered_by: lead' .agents/runs/LC/questions/003.answer.md || die "an answer from a capture older than the question is answered_by user"
  q 'QUESTIONS:
1. Proceed?
' >/dev/null
  capture 'ok'
  printf 'ok\n' | A answer LC 4 >/dev/null
  grep -q '^answered_by: lead' .agents/runs/LC/questions/004.answer.md || die "a two-character answer is answered_by user"
  A verify-seal LC >/dev/null
  ok "questions: verbatim store, answered_by user vs lead (capture newer, answer >= 3 chars), awaiting_input"
}

sc_next() {
  unfrozen COMPLEX
  A next LC | grep -q '^next=agent.sh request-approval LC plan'
  A request-approval LC plan >/dev/null
  A next LC | grep -q '^next=wait for the user' || die "next after a request: $(A next LC)"
  capture 'approve the plan'; A approve LC plan >/dev/null
  A next LC | grep -q '^next=agent.sh freeze LC'
  A freeze LC >/dev/null
  A next LC | grep -q '^next=agent.sh handoff LC IMPLEMENTING'
  A handoff LC IMPLEMENTING >/dev/null
  A next LC | grep -q '^next=dispatch.sh LC implementer'
  implemented standalone
  out=$(A next LC)
  for want in 'next=agent.sh secret-scan LC' 'next=dispatch.sh LC reviewer --focus rules+tests' 'next=dispatch.sh LC qa' 'next=dispatch.sh LC verifier'; do
    printf '%s\n' "$out" | grep -Fxq "$want" || die "next at IMPLEMENTED lacks '$want': $out"
  done
  pass_all
  A next LC | grep -q '^next=agent.sh handoff LC CODE_DONE'
  A handoff LC CODE_DONE >/dev/null
  A next LC | grep -q '^next=agent.sh knowledge-done LC'
  A knowledge-done LC not_applicable >/dev/null
  A next LC | grep -q '^next=write COMPLETION_REPORT.md'
  ok "next: deterministic steps from approval to completion"
}

sc_decide() {
  scaffold orchestrated; implemented orchestrated
  STUB_ARGS=$base/args; export STUB_ARGS; : > "$STUB_ARGS"
  A decide LC reviewer --focus rules+tests >/dev/null
  ls .agents/runs/LC/decisions/001-reviewer-rules-tests.decision >/dev/null
  grep -q -- '--role reviewer --class COMPLEX --tier small --escalations-used 0' "$STUB_ARGS" || die "decide args: $(cat "$STUB_ARGS")"
  ! grep -q -- '--runtime\|--profile' "$STUB_ARGS" || die "decide passed runtime/profile without an override"
  grep -q 'event=decide .*model=sonnet' .agents/runs/LC/LEDGER.log
  A decide LC implementer --runtime codex >/dev/null
  tail -1 "$STUB_ARGS" | grep -q -- '--runtime codex' || die "--runtime override not passed"
  grep -q '^runtime=codex' .agents/runs/LC/decisions/002-implementer.decision
  expect_fail "an invalid override was accepted" A decide LC reviewer --model bogus
  [ ! -e .agents/runs/LC/decisions/003-reviewer.decision ] || die "a refused decision was persisted"
  expect_fail "an unknown decide flag was accepted" A decide LC reviewer --turbo yes
  expect_fail "a reviewer called decide" AS reviewer decide LC reviewer
  rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced'
  printf 'escalated=yes\n' >> .agents/runs/LC/decisions/001-reviewer-rules-tests.decision
  A decide LC reviewer --focus rules+tests >/dev/null
  tail -1 "$STUB_ARGS" | grep -q -- '--signal recent_fail_same_focus --escalations-used 1' || die "signals/escalations: $(tail -1 "$STUB_ARGS")"
  # metrics: one line per recorded specialist step with runtime and model from the decision
  grep -q "$(printf '\tLC\treviewer\tclaude\tsonnet\t')" .agents/local/metrics/history.tsv || die "metrics line missing: $(cat .agents/local/metrics/history.tsv)"
  sed 's/^metrics: on/metrics: off/' .agents/config.yaml > "$base/c.yaml"; cp "$base/c.yaml" .agents/config.yaml; rm -rf .agents/local/metrics
  mkdir -p .agents/runs/LC/reports; printf '# e\n' > .agents/runs/LC/reports/090-explorer.md
  printf 'ROLE: explorer\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: %s\nARTIFACT: reports/090-explorer.md %s\n' "$(A fingerprint LC)" "$(tsha .agents/runs/LC/reports/090-explorer.md)" > "$base/e.md"
  AS explorer record LC --file "$base/e.md" >/dev/null
  [ ! -e .agents/local/metrics/history.tsv ] || die "metrics: off still wrote metrics"
  ok "decide: signals, overrides, escalations-used, persisted and ledgered; metrics on/off"
}

sc_config_scope_misc() {
  new_repo
  A config-check >/dev/null
  [ "$(A config-get review.max_fix_rounds)" = 2 ] && [ "$(A config-get git.branch_prefix)" = proofline/ ]
  expect_fail "config-get of a missing key" A config-get no.such.key
  for edit in 's/^profile: balanced/profile: .*/' 's/^failover: auto/failover: a.*/' 's/^profile: balanced/profile: turbo/' 's/^failover: auto/failover: sometimes/' 's/^  max_fix_rounds: 2/  max_fix_rounds: two/' 's/^metrics: on/metrics: maybe/' 's/^  COMPLEX: supervised/  COMPLEX: lazy/' 's/^    opus: 3/    opus: 4/'; do
    sed "$edit" .agents/config.yaml > "$base/bad.yaml"
    expect_msg "config-check accepted: $edit" 'config invalid' A config-check "$base/bad.yaml"
  done
  { cat .agents/config.yaml; printf 'surprise: 1\n'; } > "$base/bad.yaml"
  expect_msg "config-check accepted an unknown top-level key" 'unknown top-level key: surprise' A config-check "$base/bad.yaml"
  # scope `new: true`
  unfrozen STANDARD
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl.txt.new' '    criteria: [AC-1]' '---' '# Plan' > .agents/runs/LC/PLAN.md
  expect_msg "a missing path without new: true" 'does not exist' A freeze LC
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '    new: true' '---' '# Plan' > .agents/runs/LC/PLAN.md
  expect_msg "an existing path marked new: true" 'already exists' A freeze LC
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: src/new.txt' '    criteria: [AC-1]' '    new: true' '---' '# Plan' > .agents/runs/LC/PLAN.md
  A freeze LC >/dev/null
  A handoff LC IMPLEMENTING >/dev/null; A verify-scope LC >/dev/null
  A ledger-note LC 'failover from=claude to=codex reason=limit' >/dev/null
  grep -q 'event=note .*failover from=claude' .agents/runs/LC/LEDGER.log
  expect_fail "a reviewer wrote a ledger note" AS reviewer ledger-note LC 'x'
  A verify-seal LC >/dev/null
  ok "config-check, config-get, scope new: true, ledger-note"
}

sc_secret_scan() {
  scaffold orchestrated; implemented orchestrated
  n=$(n_gates)
  expect_msg "a scanner error was recorded" 'secret scan error' env STUB_SCAN_ERROR=1 sh ./.agents/scripts/agent.sh secret-scan LC
  [ "$(n_gates)" = "$n" ] || die "a scanner error left a gate record"
  expect_fail "a reviewer ran secret-scan" AS reviewer secret-scan LC
  A secret-scan LC >/dev/null; [ "$(gate_st SECRETS)" = pass ]
  ok "secret-scan: error records nothing, lead only"
}

# B2: only records written by record/gate/secret-scan/waive/approve (bound in the ledger chain) count.
sc_provenance() {
  scaffold orchestrated no CRITICAL; implemented orchestrated
  for g in $(required); do case $g in SECRETS) A secret-scan LC >/dev/null ;; SECURITY|REVIEW_RULES) gfail "$g" impl.txt ;; *) gpass "$g" ;; esac; done
  gd=.agents/runs/LC/gates; wd=.agents/runs/LC/waivers; mkdir -p "$wd"
  sr=$(ls "$gd" | grep 'SECURITY.yaml$' | tail -1); rr=$(ls "$gd" | grep 'REVIEW_RULES.yaml$' | tail -1)
  printf 'finding: "SECURITY-1"\ngate_record: "%s"\ngate_record_sha256: "%s"\n' "$sr" "$(tsha "$gd/$sr")" > "$wd/001-SECURITY-1.yaml"
  printf 'finding: "REVIEW_RULES-1"\ngate_record: "%s"\ngate_record_sha256: "%s"\n' "$rr" "$(tsha "$gd/$rr")" > "$wd/002-REVIEW_RULES-1.yaml"
  [ "$(gate_st SECURITY)" = fail ] || die "a hand-written SECURITY waiver counted: $(gate_st SECURITY)"
  [ "$(gate_st REVIEW_RULES)" = fail ] || die "a hand-written waiver counted: $(gate_st REVIEW_RULES)"
  v=$(ls "$gd" | grep 'VERIFY.yaml$' | tail -1)
  sed 's/^gate: .*/gate: "SECURITY"/; s/^role: .*/role: "security_reviewer"/; s/^seq: .*/seq: 90/' "$gd/$v" > "$gd/090-SECURITY.yaml"; cp "$gd/${v%.yaml}.manifest" "$gd/090-SECURITY.manifest"
  [ "$(gate_st SECURITY)" = fail ] || die "a hand-written PASS record counted: $(gate_st SECURITY)"
  expect_msg "CODE_DONE over hand-written records" 'is fail for the current content' A handoff LC CODE_DONE
  expect_msg "validate missed the hand-written records" 'gates/090-SECURITY.yaml' A validate LC
  mkdir -p .agents/runs/LC/approvals
  printf 'kind: "commit"\nbound: "%s"\nconsumed: "false"\n' "$(A fingerprint LC)" > .agents/runs/LC/approvals/050-commit.yaml
  expect_fail "a hand-written commit approval was consumed" A approval-consume LC commit "$(A fingerprint LC)"
  ok "provenance: hand-written gate records, waivers (SECURITY included) and approvals are ignored; validate names them"
}

# B3: a waiver approval binds the failing gate record (name + sha256) and the finding id.
sc_waiver_rebind() {
  scaffold orchestrated no STANDARD; implemented orchestrated
  rec VERIFY FAIL high 'VERIFY-1|blocking|impl.txt:1|first problem: cache never invalidated|traced'
  approve_as_user waive:VERIFY-1 'approve waiving VERIFY-1'
  grep -q '^bound: "[0-9]*-VERIFY.yaml@[0-9a-f]*#VERIFY-1"' .agents/runs/LC/approvals/*-waive-VERIFY-1.yaml || die "the waiver approval is not bound to the gate record"
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: fix attempt'; A handoff LC IMPLEMENTED >/dev/null
  rec VERIFY FAIL high 'VERIFY-1|blocking|impl.txt:2|different problem: data loss on concurrent write|traced'
  expect_msg "a round-1 approval waived round 2's VERIFY-1" "needs the user's approval" A waive LC VERIFY-1 --reason 'the user approved waiving VERIFY-1 earlier on'
  ok "waiver approvals bind the failing gate record and finding; a later round never reuses them"
}

# B1: the git hooks see every open run, not ACTIVE_RUN.
sc_open_runs() {
  scaffold orchestrated no STANDARD
  mkdir -p .agents/githooks; cp "$tl_agents/githooks/"* .agents/githooks/; git config core.hooksPath .agents/githooks
  : > .agents/local/ACTIVE_RUN
  [ "$(A open-runs)" = 'LC -' ] || die "open-runs: $(A open-runs)"
  printf 'notes\n' > notes.md; git add notes.md
  expect_msg "emptying ACTIVE_RUN opened commits outside the run" "commits only on a run's task branch" env PROOFLINE_NO_TTY=1 git commit -qm 'docs: notes'
  printf 'reason: the lookup backend is unreachable from this sandbox\nevidence: three connection attempts to the backend timed out\n' | A terminate LC BLOCKED >/dev/null
  [ -z "$(A open-runs)" ] || die "a terminated run is still open"
  PROOFLINE_NO_TTY=1 git commit -qm 'docs: notes' || die "a terminated run still blocks commits"
  ok "git hooks: every open run counts (ACTIVE_RUN emptied), terminated runs do not"
}

# I5: knowledge-scope files are written after the SECRETS gate; DONE and delivery-check scan them.
sc_knowledge_secrets() {
  scaffold orchestrated; to_code_done orchestrated
  printf 'token: PLANTED_SECRET\n' > DESIGN.md
  A knowledge-done LC >/dev/null; write_report; A publish-completion-report LC markdown >/dev/null
  expect_msg "delivery-check over a secret in a knowledge file" 'found secrets' A delivery-check LC
  expect_msg "DONE over a secret in a knowledge file" 'found secrets' A handoff LC DONE
  printf 'design notes\n' > DESIGN.md
  A handoff LC DONE >/dev/null
  ok "knowledge-scope files are secret-scanned at DONE and delivery-check"
}

# CLASSIFY precedes BRANCH: `next` prints the order the commands accept.
sc_next_order() {
  new_repo; nd=.agents/runs/NB; mkdir -p "$nd" tasks
  sed 's/<TASK-ID>/NB/; s#<REPOSITORY-RELATIVE-TASK-FILE.md>#tasks/NB-sample.md#' .agents/templates/RUN.yaml > "$nd/RUN.yaml"
  printf '# Task: NB - sample\n' > "$nd/TASK.md"; printf '# NB sample\n' > tasks/NB-sample.md; git add -A; git commit -qm base
  A next NB | grep -q '^next=agent.sh classify NB' || die "next on a new run: $(A next NB)"
  A classify NB STANDARD >/dev/null
  A next NB | grep -q '^next=agent.sh branch NB' || die "next after classify: $(A next NB)"
  A branch NB >/dev/null
  A next NB | grep -q '^next=agent.sh baseline NB' || die "next after branch: $(A next NB)"
  ok "next: classify, branch, baseline in the order the commands accept"
}
sc_qa_plan_bound() {
  scaffold orchestrated no COMPLEX
  d=.agents/runs/LC
  A verify-qa-plan LC >/dev/null || die "a QA plan bound to its PLAN.md was refused"
  ok "QA-bound: a QA plan citing the sha256 of the final PLAN.md passes"
  cp "$d/PLAN.md" "$base/plan.keep"; cp "$d/QA_PLAN.md" "$base/qa.keep"
  printf 'contract changed after the QA plan\n' >> "$d/PLAN.md"
  expect_msg "QA plan derived from another plan" 'derived from a different PLAN.md' A verify-qa-plan LC
  cp "$base/plan.keep" "$d/PLAN.md"
  grep -v '^Plan sha256: ' "$base/qa.keep" > "$d/QA_PLAN.md"
  expect_msg "QA plan without the plan hash" "must cite the plan" A verify-qa-plan LC
  { cat "$base/qa.keep"; printf -- '- QA-9 (AC-7): a criterion the plan does not have\n  input: x\n'; } > "$d/QA_PLAN.md"
  expect_msg "scenario for a criterion the plan lacks" 'which PLAN.md does not contain' A verify-qa-plan LC
  cp "$base/qa.keep" "$d/QA_PLAN.md"
  { sed 's/\[AC-1\]/[AC-1, AC-3]/' "$base/plan.keep" > "$d/PLAN.md"; }
  qa_bind LC
  expect_msg "plan criterion without an acceptance scenario" 'no acceptance scenario for AC-3' A verify-qa-plan LC
  cp "$base/plan.keep" "$d/PLAN.md"
  printf '\n## Contracts\n\n- the response no longer returns `legacyNotes` (removed)\n' >> "$d/PLAN.md"
  { cat "$base/qa.keep"; printf -- '  expected: the response has `legacyNotes` with the stored value\n'; } > "$d/QA_PLAN.md"; qa_bind LC
  expect_msg "scenario expects a term the plan's contracts remove" 'removes or renames' A verify-qa-plan LC
  { cat "$base/qa.keep"; printf -- '  expected: the response has no `legacyNotes` key (absent)\n'; } > "$d/QA_PLAN.md"; qa_bind LC
  A verify-qa-plan LC >/dev/null || die "an absence expectation of a removed term was refused"
  ok "QA-bound: stale hash, missing hash, unknown or uncovered criterion and a removed term are refused; an absence expectation passes"
}
sc_artifact_snapshots() {
  scaffold orchestrated; implemented orchestrated
  small=.agents/runs/LC/reviews/proof-review/small
  mkdir -p "$small"; printf 'round one report\n' > "$small/REPORT.md"
  AS reviewer submit LC --focus rules+tests --confidence high --agent s1 >/dev/null || die "first submit failed"
  printf 'round two report, same path\n' > "$small/REPORT.md"
  AS reviewer submit LC --focus rules+tests --confidence high --agent s2 >/dev/null || die "second submit failed"
  n=0
  for r in .agents/runs/LC/results/*-reviewer.result.md; do
    art=$(sed -n 's/^ARTIFACT: \([^ ]*\) \([0-9a-f]*\)$/\1 \2/p' "$r"); p=${art% *}; h=${art#* }
    [ -f ".agents/runs/LC/$p" ] && [ "$(tsha ".agents/runs/LC/$p")" = "$h" ] || die "C-9: $r cites $p with a stale or missing sha256"
    n=$((n + 1))
  done
  [ "$n" = 2 ] || die "expected two recorded reviewer results, saw $n"
  [ "$(ls .agents/runs/LC/reports/snapshots | wc -l | tr -d ' ')" = 2 ] || die "two different reports did not make two snapshots"
  A verify-scope LC >/dev/null 2>&1 || die "verify-scope refuses the snapshots: $(A verify-scope LC 2>&1)"
  ok "C-9: results of two rounds that wrote the same report path both cite an existing artifact with the stated sha256"
}
sc_debug_result() {
  SC_TASK_EXTRA='
## Suggested class

STANDARD — behavioural bug fix in one module with tests.' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  expect_msg "a defect named only in Suggested class needs a debug-proof result" 'no debug-proof result' A handoff LC IMPLEMENTED
  mkdir -p .agents/runs/LC/reports; printf '# debug\n\nreproduction, root cause, regression test\n' > .agents/runs/LC/reports/001-debug.md
  A handoff LC IMPLEMENTED >/dev/null || die "a debug-proof result did not unblock IMPLEMENTED"
  ok "a bug named in Suggested class needs reports/NNN-debug.md, which unblocks IMPLEMENTED"
  # a defect word in the Suggested class prose is not a defect task ("its own step drops nothing")
  SC_TASK_EXTRA='
## Suggested class

CRITICAL — the first step is additive and its own step drops nothing.' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "a defect word in Suggested class prose blocked a task that is not a defect fix: $(A handoff LC IMPLEMENTED 2>&1)"
  ok "a defect word inside Suggested class prose does not make a task a defect fix"
  # "dropping the column is a follow-up" in the Goal is data removal wording, not a defect report (A53)
  SC_TASK_EXTRA='
## Goal

Stop using the column; dropping the column is a separate follow-up.' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "dropping in a Goal sentence blocked a task that is not a defect fix: $(A handoff LC IMPLEMENTED 2>&1)"
  ok "drop/dropping are no defect words (data removal wording)"
}
sc_scratch_worktrees() {
  scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all
  wt=$(mktemp -d "${TMPDIR:-/tmp}/scratch-wt.XXXXXX"); rmdir "$wt"
  git worktree add -q --detach "$wt" HEAD
  expect_msg "a scratch worktree still registered blocks CODE_DONE" 'scratch git worktrees' A handoff LC CODE_DONE
  git worktree remove --force "$wt"
  A handoff LC CODE_DONE >/dev/null || die "CODE_DONE refused after the worktree was removed: $(A handoff LC CODE_DONE 2>&1)"
  ok "scratch worktrees must be removed before CODE_DONE"
}
sc_tests_findings() {
  command -v node >/dev/null 2>&1 || { echo "skip tests_findings (node missing)"; return 0; }
  SC_PLAN_EXTRA='
## Tests

- AC-1: `impl_test.txt` "lookup returns the stored value"' scaffold orchestrated; implemented orchestrated
  mkdir -p .agents/skills; cp -R "$tl_agents/../../skills/test-trust" .agents/skills/test-trust
  printf '.agents/skills/\n' >> .git/info/exclude
  d=.agents/runs/LC; t=$d/reviews/test-trust/tests
  mkdir -p "$t"; printf 'tests review of the whole current tree\n' > "$t/REPORT.md"
  expect_msg "a tests review without findings.json" 'needs reviews/test-trust/tests/findings.json' AS reviewer submit LC --focus tests --confidence high --agent tf1
  printf '%s\n' '{"mode":"diff","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidence_pruned":true,"gate":{"result":"PASS","failing":[]},' \
    '"scope":{"slug":"diff","paths":["."],"commit":"abc1234","diff":{"base":"abc1234","thresholds":{"repeat":5,"mutation_budget":20,"slow_ratio":3},"changed_units":["impl.txt:lookup"],"tests":["lookup returns the stored value"],"mutants_run":1,"not_examined":[]}},' \
    '"findings":[]}' > "$t/findings.json"
  expect_msg "a tests review without a claim for the criterion" 'no claim mutant for it' AS reviewer submit LC --focus tests --confidence high --agent tf2
  printf '%s\n' '{"mode":"diff","fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evidence_pruned":true,"gate":{"result":"PASS","failing":[]},' \
    '"scope":{"slug":"diff","paths":["."],"commit":"abc1234","diff":{"base":"abc1234","thresholds":{"repeat":5,"mutation_budget":20,"slow_ratio":3},"changed_units":["impl.txt:lookup"],"tests":["lookup returns the stored value"],"mutants_run":1,"not_examined":[],' \
    '"claims":[{"ac":"AC-1","test":"lookup returns the stored value","mutant":"lookup returns undefined for a stored key without throwing","outcome":"killed","failure":"assertion","killed_by":["lookup returns the stored value"]}]}},' \
    '"findings":[]}' > "$t/findings.json"
  # a proven claim passes the findings check; the small tier of this fixture does not require the gate itself
  expect_msg "a proven claim passes the findings check" 'not a required gate' AS reviewer submit LC --focus tests --confidence high --agent tf3
  ok "REVIEW_TESTS needs findings.json with a killed-by-assertion claim for every criterion of PLAN ## Tests"
}
sc_defect_scope() {
  unfrozen STANDARD
  d=.agents/runs/LC
  printf '\n## Pre-existing defects\n\n- src/service.js:paginate: totalPages rounds down -- decision: fix\n' >> "$d/TASK.md"
  expect_msg "a pre-existing defect fix without the user's scope approval" 'scope approval for this PLAN.md' A freeze LC
  A next LC | grep -q '^next=agent.sh request-approval LC scope' || die "next does not ask for the scope approval: $(A next LC)"
  approve_as_user scope 'approve the scope change: fix the paging defect'
  A freeze LC >/dev/null || die "freeze refused with the scope approval: $(A freeze LC 2>&1)"
  ok "a pre-existing defect marked decision: fix needs the user's scope approval at the first freeze"
  # a decision: report entry never needs one
  unfrozen STANDARD
  printf '\n## Pre-existing defects\n\n- src/service.js:paginate: totalPages rounds down -- decision: report\n' >> "$d/TASK.md"
  A freeze LC >/dev/null || die "a reported defect needed a scope approval: $(A freeze LC 2>&1)"
  ok "a defect marked decision: report is only a finding"
}
sc_intent_provenance() {
  unfrozen STANDARD
  d=.agents/runs/LC; mkdir -p "$d/design" .agents/local/prompts/history
  printf 'Use your recommended option for every open question.\n' > .agents/local/prompts/history/1-aaaaaaaa.txt
  printf '%s\n' '# Intent: LC' '' '## Decision tree' '' '| id | branch | question | depends_on | status | decision | decided_by | source |' '|---|---|---|---|---|---|---|---|' \
    '| D-12 | scope | Fix the paging defect in this change? | - | resolved | Fixed in this change | user | a) |' '' '## Rounds' '' '| round | asked | answer | answered_by |' '|---|---|---|---|' \
    '| 1 | D-12 | a) fix the page count in this change (round up); AC-6 is in scope. | user |' > "$d/design/INTENT.md"
  expect_msg "an answer recorded as the user's that the user never said" 'in no captured user prompt' A freeze LC
  sed 's#^| 1 | D-12 | .*#| 1 | D-12 | Use your recommended option for every open question. | user |#' "$d/design/INTENT.md" > "$base/intent.md" && cp "$base/intent.md" "$d/design/INTENT.md"
  A freeze LC >/dev/null || die "a verbatim blanket answer was refused: $(A freeze LC 2>&1)"
  ok "an answer to a scope decision recorded as the user's must be in a captured user prompt"
}
sc_start() {
  new_repo; RID=ST-1
  cp "$tl_agents/task-integrations/markdown.sh" "$tl_agents/task-integrations/_lib.sh" .agents/task-integrations/
  git add -A; git commit -qm base
  A next | grep -Fq 'next=agent.sh start <ID>' || die 'next did not guide intake'
  expect_msg 'invalid task ID accepted' 'invalid task id' A start '../bad' --title bad
  cat > "$base/start-body.md" <<'TASK'
## Goal

Record one task.

## Context

Fixture.

## Acceptance criteria

- AC-1: The task starts.

## Out of scope

- Other changes.

## Constraints

- POSIX sh.

## Risks

- Incorrect task state.

## Suggested class

TRIVIAL — documentation only.

## Verification commands

- `sh -n script.sh`
TASK
  A start ST-1 --title 'Record task' < "$base/start-body.md" >/dev/null
  [ "$(rv task_source type)" = local_markdown ] && [ "$(rv completion_report adapter)" = markdown ] || die 'start did not set task source and adapter'
  grep -Fq '**Status:** in-progress' .agents/tasks/in-progress/ST-1-record-task.md || die 'start task status missing'
  grep -Fq 'event=start ' .agents/runs/ST-1/LEDGER.log || die 'start ledger missing'
  expect_msg 'duplicate start accepted' 'run already exists' A start ST-1 --task-file .agents/tasks/in-progress/ST-1-record-task.md
  expect_msg 'second open run accepted' 'another open run' A start ST-2 --title second
  A classify ST-1 TRIVIAL >/dev/null; A branch ST-1 >/dev/null; A baseline ST-1 >/dev/null
  cat > .agents/runs/ST-1/PLAN.md <<'PLAN'
---
scope:
  - path: example.txt
    new: true
    criteria: [AC-1]
---
# Plan

## Behavior

Record task.

## Tests

Check the task.

## Verification commands

- `sh -n script.sh`
PLAN
  A freeze ST-1 >/dev/null || die 'start to freeze failed'
  [ "$(rv task_source revision)" != PENDING ] || die 'freeze left task source revision pending'
  new_repo; cp "$tl_agents/task-integrations/markdown.sh" "$tl_agents/task-integrations/_lib.sh" .agents/task-integrations/
  git add -A; git commit -qm base
  sed '/## Risks/,$d' "$base/start-body.md" > "$base/incomplete.md"
  rc=0; A start ST-3 --title incomplete < "$base/incomplete.md" > "$base/out" 2>&1 || rc=$?
  [ "$rc" -eq 3 ] && grep -Fq 'MISSING risks' "$base/out" || die 'missing canonical field did not exit 3 and print field'
  [ ! -e .agents/runs/ST-3 ] || die 'incomplete start created a run'
  rc=0; A start ST-3 < "$base/start-body.md" > "$base/out" 2>&1 || rc=$?
  [ "$rc" -eq 3 ] && grep -Fq 'MISSING title' "$base/out" || die 'missing task title did not exit 3 and print field'
  mkdir -p .agents/tasks/backlog
  { printf '# Task: ST-3 — Incomplete\n\n**Status:** backlog\n\n'; cat "$base/incomplete.md"; } > .agents/tasks/backlog/ST-3-incomplete.md
  rc=0; A start ST-3 --task-file .agents/tasks/backlog/ST-3-incomplete.md > "$base/out" 2>&1 || rc=$?
  [ "$rc" -eq 3 ] && grep -Fq 'MISSING risks' "$base/out" && [ ! -e .agents/runs/ST-3 ] || die 'incomplete task file did not exit 3 without a run'
  mkdir -p .agents/tasks/backlog
  { printf '# Task: ST-4 — Imported task\n\n**Status:** backlog\n\n'; cat "$base/start-body.md"; } > .agents/tasks/backlog/ST-4-imported-task.md
  A start ST-4 --task-file .agents/tasks/backlog/ST-4-imported-task.md >/dev/null
  [ -f .agents/tasks/in-progress/ST-4-imported-task.md ] && [ "$(cat .agents/local/ACTIVE_RUN)" = ST-4 ] || die 'existing task file was not moved and activated'
  RID=ST-4
  [ "$(rv task_source path)" = .agents/tasks/in-progress/ST-4-imported-task.md ] || die 'existing task path was not recorded'
  expect_msg 'non-lead started a run' 'command denied for reviewer' AS reviewer start ST-5 --title denied
  ok 'start: stdin, adapter task, ledger, classify/branch/baseline/freeze, duplicate/open/missing refusals'
}

run_sc sc_tier
run_sc sc_tier_paths
run_sc sc_record
run_sc sc_submit
run_sc sc_language
run_sc sc_report_stdin
run_sc sc_parallel_lock
run_sc sc_fix_loop
run_sc sc_waiver
run_sc sc_approvals
run_sc sc_supervised_destructive
run_sc sc_capture_integrity
run_sc sc_ask
run_sc sc_questions
run_sc sc_next
run_sc sc_decide
run_sc sc_config_scope_misc
run_sc sc_secret_scan
run_sc sc_provenance
run_sc sc_waiver_rebind
run_sc sc_open_runs
run_sc sc_knowledge_secrets
run_sc sc_next_order
run_sc sc_start
run_sc sc_qa_plan_bound
run_sc sc_artifact_snapshots
run_sc sc_debug_result
run_sc sc_scratch_worktrees
run_sc sc_tests_findings
run_sc sc_defect_scope
run_sc sc_intent_provenance
echo 'gates tests passed'
