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
  # A127: the token dispatch.sh exports wins over a typed --agent (a headless worker has no start context to read one from)
  (export PROOFLINE_AGENT=envtok; AS reviewer submit LC --focus rules+tests --confidence high --agent typedtok >/dev/null) || die "submit with PROOFLINE_AGENT and --agent failed"
  grep -q '^status=ok' .agents/local/submissions/envtok.status && [ ! -e .agents/local/submissions/typedtok.status ] || die "a typed --agent displaced the dispatch token"
  # a subagent the hook registered (SubagentStart writes <id>.started) inside a dispatch worker keeps its own token
  : > .agents/local/submissions/subtok.started
  (export PROOFLINE_AGENT=envtok; AS reviewer submit LC --focus rules+tests --confidence high --agent subtok >/dev/null) || die "submit by a registered subagent failed"
  grep -q '^status=ok' .agents/local/submissions/subtok.status || die "a registered subagent's token was displaced by the dispatch token"
  for art in "$(pwd)/$small/REPORT.md" ".agents/runs/LC/reviews/proof-review/small/REPORT.md" "./.agents/runs/LC/reviews/proof-review/small/REPORT.md" "reviews/proof-review/small/REPORT.md" "./reviews/proof-review/small/REPORT.md"; do
    AS reviewer submit LC --artifact "$art" --confidence high >/dev/null || die "artifact spelling not accepted: $art"
  done
  grep -q '^artifact: "reports/snapshots/[0-9a-f]\{12\}-reviewer-reviews_proof-review_small_REPORT.md"' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "artifact was not normalized to its immutable snapshot"
  expect_msg "an artifact outside the run was accepted" 'inside the run' AS reviewer submit LC --focus rules+tests --artifact ../../../impl.txt --confidence high
  expect_msg "an artifact of another focus was accepted" 'outside the paths' AS reviewer submit LC --focus plan --artifact reviews/proof-review/small/REPORT.md --confidence high
  # the result follows from the findings
  printf 'blocking|impl.txt:1|lookup returns the wrong value for an empty key|traced: empty key -> nil; scan: grep -n lookup impl.txt; instances: single\n' > "$base/f.rows"
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
  # A171 (review): a quote line or a fence is exempt only when it repeats a captured user prompt, whatever the file
  printf 'The review is complete.\n\n> Kullan\304\261c\304\261 iste\304\237i: s\303\274r\303\274m\303\274 d\303\274zelt\n' > "$small/REPORT.md"
  expect_msg "an invented quote block hid non-English text" 'run artifacts are English' AS reviewer submit LC --focus rules+tests --confidence high
  printf 'The review is complete.\n\n```\n\305\237\303\266yle \303\274\303\247 \304\237\n```\n' > "$small/REPORT.md"
  expect_msg "an invented fence hid non-English text" 'run artifacts are English' AS reviewer submit LC --focus rules+tests --confidence high
  mkdir -p .agents/local/prompts/history
  printf 'Kullan\304\261c\304\261 iste\304\237i: s\303\274r\303\274m\303\274 d\303\274zelt\n\305\237\303\266yle\n' > .agents/local/prompts/history/1-aaaaaaaa.txt
  printf 'The review is complete.\n\n> Kullan\304\261c\304\261 iste\304\237i: s\303\274r\303\274m\303\274 d\303\274zelt\n\n```\n\305\237\303\266yle\n```\nJos\303\251 reviewed it.\n' > "$small/REPORT.md"
  AS reviewer submit LC --focus rules+tests --confidence high >/dev/null || die "a quoted request / one accented name was refused"
  printf 'blocking|impl.txt:1|de\304\237er \303\274retilmiyor \305\237\303\266yle|traced; scan: grep -n lookup impl.txt; instances: single\n' > "$base/tr.rows"
  expect_msg "Turkish findings were accepted" 'run artifacts are English' AS reviewer submit LC --focus rules+tests --findings "$base/tr.rows" --confidence high
  printf 'blocking|impl.txt:1|wrong value|agent.sh pipeline LC\n' > "$base/ag.rows"
  expect_msg "a reviewer opted out of the scan rule with an agent.sh evidence prefix" 'reserved for rows the script adds' AS reviewer submit LC --focus rules+tests --findings "$base/ag.rows" --confidence high
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

sc_stdin_contract() { # A104
  scaffold orchestrated; implemented orchestrated
  rp=.agents/runs/LC/reviews/proof-review/small/REPORT.md
  # two stdin sources are refused before stdin is read, with the corrected command in the message
  out=$(printf 'report text\n' | AS reviewer submit LC --focus rules+tests --confidence high --report - --findings - 2>&1) && die "both-stdin was accepted"
  case "$out" in *'only one of --report/--findings may read stdin'*'=== FINDINGS ==='*) ;; *) die "both-stdin message wrong: $out" ;; esac
  # the documented separator splits one document
  printf 'review of the tree\n\n=== FINDINGS ===\nblocking|impl.txt:1|wrong value|traced; scan: grep -n lookup impl.txt; instances: single\ninfo|impl.txt:2|a note|seen\n' \
    | AS reviewer submit LC --focus rules+tests --confidence high --report - --findings - >/dev/null || die "separator submit failed"
  [ "$(gate_st REVIEW_SMALL)" = fail ] || die "separator findings did not fail the gate"
  grep -q 'review of the tree' "$rp" && ! grep -q 'FINDINGS\|wrong value' "$rp" || die "report not split from the findings"
  # --findings none and an answer-only info row
  printf 'answer text\n' | AS reviewer submit LC --focus rules+tests --confidence high --report - --findings none >/dev/null || die "--findings none failed"
  [ "$(gate_st REVIEW_SMALL)" = pass ] || die "--findings none did not pass"
  printf 'info|-|answer|the answer in one line\n' > "$base/ans.rows"
  AS reviewer submit LC --focus rules+tests --confidence high --findings "$base/ans.rows" >/dev/null || die "info row with path - rejected"
  printf 'prose, not a row\n' > "$base/prose.rows"
  expect_msg "a prose row names the corrected form" '--findings none' AS reviewer submit LC --focus rules+tests --confidence high --findings "$base/prose.rows"
  ok "submit stdin contract: both-stdin refused, separator split, --findings none, info row"
}

# A113: submit allocates an explorer's numbered report name; parallel submits never share or overwrite one
sc_report_names() {
  scaffold orchestrated
  n=1 pids=''
  while [ "$n" -le 4 ]; do
    printf 'report of explorer %s\n' "$n" > "$base/ag$n-rep"
    AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag$n-rep" --artifact reports/001-explorer.md --agent "ag$n" > "$base/s$n.out" 2>&1 &
    pids="$pids $!"; n=$((n + 1))
  done
  for pid in $pids; do wait "$pid" || die "parallel explorer submit failed: $(cat "$base"/s?.out)"; done
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" -eq 4 ] || die "four parallel submits did not give four reports"
  for n in 1 2 3 4; do
    [ "$(grep -l "^report of explorer $n$" .agents/runs/LC/reports/???-explorer.md | wc -l | tr -d ' ')" -eq 1 ] || die "the report of explorer $n was lost or duplicated"
  done
  [ "$(find .agents/runs/LC/results -name '???-explorer.result.md' | wc -l | tr -d ' ')" -eq 4 ] || die "parallel results collided"
  [ "$(grep -c 'event=record:explorer:DONE' .agents/runs/LC/LEDGER.log)" -eq 4 ] || die "not one ledger row per parallel submit"
  [ "$(grep -h '^ARTIFACT: ' .agents/runs/LC/results/???-explorer.result.md | sort -u | wc -l | tr -d ' ')" -eq 4 ] || die "results cite a shared artifact"
  # the same dispatch updates its own report; a re-dispatch under a new token gets a new name
  printf 'report of explorer 1, revised\n' > "$base/ag1-rep"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag1-rep" --agent ag1 >/dev/null || die "the same dispatch could not resubmit"
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" -eq 4 ] || die "a resubmit allocated a new report"
  [ "$(grep -l '^report of explorer 1, revised$' .agents/runs/LC/reports/???-explorer.md | wc -l | tr -d ' ')" -eq 1 ] || die "the resubmit did not update its own report"
  cp "$base/ag1-rep" "$base/ag9-rep"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag9-rep" --agent ag9 >/dev/null || die "a re-dispatch was refused"
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" -eq 5 ] || die "a re-dispatch did not get its own name"
  # A132: a scratch file name without the caller's token (two parallel explorers both pick scratch/r.md) is refused
  nrep=$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')
  printf 'shared name\n' > "$base/r.md"
  expect_msg "a shared-name scratch report was accepted" 'carries its own agent token' AS explorer submit LC --result DONE --confidence high --findings none --report "$base/r.md" --agent ag1
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" = "$nrep" ] || die "a refused shared-name report allocated a name"
  printf 'embedded token\n' > "$base/xag1-rep"
  expect_msg "a report name that only contains the token as a substring was accepted" 'carries its own agent token' AS explorer submit LC --result DONE --confidence high --findings none --report "$base/xag1-rep" --agent ag1
  # a direct write into a numbered explorer path is never an explorer artifact, whatever the spelling
  printf 'planted\n' > .agents/runs/LC/reports/009-explorer.md
  nrep=$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')
  for sp in reports/009-explorer.md reports/./009-explorer.md reports//009-explorer.md ./reports/./009-explorer.md ".agents/runs/LC/reports/./009-explorer.md"; do
    expect_msg "a direct numbered explorer report was accepted: $sp" 'hands its report over with --report' AS explorer submit LC --result DONE --confidence high --findings none --artifact "$sp" --agent ag1
    expect_msg "a tokenless direct numbered explorer report was accepted: $sp" 'hands its report over with --report' AS explorer submit LC --result DONE --confidence high --findings none --artifact "$sp"
  done
  # an empty report allocates nothing and leaves no owner entry
  nrep=$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')
  : > "$base/agE-empty"
  expect_msg "an empty report was accepted" 'report is empty' AS explorer submit LC --result DONE --confidence high --findings none --report "$base/agE-empty" --agent agE
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" = "$nrep" ] || die "a refused empty report left a stub"
  [ ! -e .agents/runs/LC/reports/.owners/agE ] || die "a refused empty report left an owner entry"
  # a refused submit after allocation (non-English report) rolls the allocation back
  printf 'Bu rapor T\303\274rk\303\247e yaz\304\261ld\304\261: \303\247ok \305\237\303\266yle \304\237\303\274zel.\n' > "$base/agT-tr"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/agT-tr" --agent agT >/dev/null 2>&1 && die "a non-English report was accepted"
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" = "$nrep" ] || die "a refused submit left an allocated stub"
  # BLOCKED without a report: the reason becomes the allocated report
  AS explorer submit LC --result BLOCKED --reason 'no readable entry point in scope' --confidence high --agent agK >/dev/null || die "an explorer BLOCKED without a report was refused"
  grep -l 'no readable entry point in scope' .agents/runs/LC/reports/???-explorer.md >/dev/null || die "the BLOCKED reason was not stored as the report"
  # a tokenless submit succeeds and gets a new name every time
  nrep=$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')
  printf 'tokenless report\n' > "$base/tl"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/tl" >/dev/null || die "a tokenless explorer submit was refused"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/tl" >/dev/null || die "a second tokenless explorer submit was refused"
  [ "$(find .agents/runs/LC/reports -maxdepth 1 -name '???-explorer.md' | wc -l | tr -d ' ')" -eq $((nrep + 2)) ] || die "tokenless submits did not get a new name each"
  # record cannot cite another dispatch's live report either
  live=$(ls .agents/runs/LC/reports/???-explorer.md | head -1)
  printf 'ROLE: explorer\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: %s\nARTIFACT: %s %s\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n' "$(A fingerprint LC)" "${live#.agents/runs/LC/}" "$(shasum -a 256 "$live" | cut -d' ' -f1)" > "$base/foreign.raw"
  expect_msg "record cited a live explorer report" 'snapshot made by submit' AS explorer record LC --file "$base/foreign.raw"
  ok "A113: submit allocates distinct explorer report names under parallel submits; a direct numbered write is refused; same token updates, new token gets a new name"
}

# A132: max_explorers bounds recorded explorer results; a dispatch whose result never arrived holds no slot
sc_explorer_limit() {
  scaffold orchestrated
  A decide LC explorer --agent-path >/dev/null || die "first explorer decide refused"
  A decide LC explorer --agent-path >/dev/null || die "second (parallel) explorer decide refused"
  printf 'one\n' > "$base/ag1-rep"; printf 'two\n' > "$base/ag2-rep"
  # a BLOCKED result holds no slot: its retry (and a NEEDS_INPUT ANSWERS re-dispatch) is allowed
  AS explorer submit LC --result BLOCKED --reason 'no entry point' --confidence high --agent agB >/dev/null || die "explorer BLOCKED submit failed"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag1-rep" --agent ag1 >/dev/null || die "explorer 1 submit failed"
  # the same explorer resubmitting a revised report is still one slot (two result files, one allocated report)
  printf 'one revised\n' > "$base/ag1-rep"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag1-rep" --agent ag1 >/dev/null || die "explorer 1 resubmit failed"
  [ "$(ls .agents/runs/LC/results/???-explorer.result.md | wc -l | tr -d ' ')" -ge 3 ] || die "the resubmit did not leave a second DONE result file"
  A decide LC explorer --agent-path >/dev/null || die "a decide after a BLOCKED result and one explorer resubmitting was refused"
  # a live marker whose submission is already recorded is the delivered result, not a second slot
  mkdir -p .agents/runs/LC/dispatch .agents/local/submissions; printf 'pid=%s\nrole=explorer\n' "$$" > .agents/runs/LC/dispatch/091-explorer-claude.running
  printf 'status=ok\n' > .agents/local/submissions/d091-explorer-claude.status
  A decide LC explorer --agent-path >/dev/null || die "a DONE result plus its own live marker was counted twice"
  rm -f .agents/runs/LC/dispatch/091-explorer-claude.running
  # a running explorer dispatch occupies a slot: one DONE + one running = 2 of 2
  mkdir -p .agents/runs/LC/dispatch; printf 'pid=%s\nrole=explorer\n' "$$" > .agents/runs/LC/dispatch/090-explorer-claude.running
  expect_msg "a parallel start beyond the limit was granted" '1 delivered result(s)' A decide LC explorer --agent-path
  rm -f .agents/runs/LC/dispatch/090-explorer-claude.running
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag2-rep" --agent ag2 >/dev/null || die "explorer 2 submit failed"
  expect_msg "a third delivered explorer was granted" 'allows 2 explorer slot(s) (pipelines.COMPLEX.max_explorers) and run LC holds 2 delivered result(s)' A decide LC explorer --agent-path
  ok "A132: the explorer after max_explorers delivered reports is refused; BLOCKED and a lost dispatch hold no slot; a running one does"
  # a limit of 0 is not checked, and the count restarts at each freeze
  unfrozen TRIVIAL
  A decide LC explorer --agent-path >/dev/null || die "an explorer decide on a limit of 0 was refused"
  unfrozen STANDARD
  printf 'one\n' > "$base/ag1-rep"
  AS explorer submit LC --result DONE --confidence high --findings none --report "$base/ag1-rep" --agent ag1 >/dev/null || die "pre-freeze explorer failed"
  expect_msg "a second pre-freeze explorer was granted (STANDARD allows 1)" 'holds 1 delivered result(s)' A decide LC explorer --agent-path
  A freeze LC >/dev/null || die "freeze failed"
  A decide LC explorer --agent-path >/dev/null || die "an explorer after the freeze was refused (the count restarts at each freeze)"
  ok "A132: a limit of 0 is not checked; the slot count restarts at each freeze"
}

sc_parallel_lock() {
  scaffold orchestrated; implemented orchestrated
  printf '# Completion Report: LC\n' > .agents/runs/LC/COMPLETION_REPORT.md
  f=$(result_for REVIEW_SMALL PASS)
  i=1 pids=''
  while [ "$i" -le 8 ]; do
    if [ $((i % 2)) -eq 0 ]; then
      case $i in 2) pf=rules+tests ;; 4) pf=plan ;; 6) pf=tests ;; *) pf=rules ;; esac   # one --agent-path per role and focus (A171)
      A decide LC reviewer --agent-path --focus "$pf" > "$base/parallel-$i.out" 2>&1 &
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

# A waiter that read a dead holder's pid must not break the lock when a live holder took it right after that read.
# A fake `cat` plays the holder: after the waiter's first read of the lock's pid it writes a live pid into the file.
sc_lock_break_race() {
  scaffold orchestrated
  mkdir "$base/fakebin"
  printf '%s\n' '#!/bin/sh' \
    'case "${1:-}" in */.lock/pid) if [ -f "$FAKE_CAT_FLAG" ]; then rm -f "$FAKE_CAT_FLAG"; /bin/cat "$1"; printf "%s\n" "$FAKE_CAT_LIVE" > "$1"; exit 0; fi ;; esac' \
    'exec /bin/cat "$@"' > "$base/fakebin/cat"
  chmod +x "$base/fakebin/cat"
  mkdir .agents/runs/LC/.lock; printf '99999999\n' > .agents/runs/LC/.lock/pid
  : > "$base/fake-cat.flag"
  expect_msg 'a lock taken by a live holder after the stale read was broken' 'lock timeout after 1s' \
    env PATH="$base/fakebin:$PATH" FAKE_CAT_FLAG="$base/fake-cat.flag" FAKE_CAT_LIVE="$$" PROOFLINE_LOCK_TIMEOUT=1 sh ./.agents/scripts/agent.sh ledger-note LC racer
  [ ! -e "$base/fake-cat.flag" ] || die 'the fake holder never took the lock (the race was not exercised)'
  [ "$(/bin/cat .agents/runs/LC/.lock/pid)" = "$$" ] || die 'the live holder lost its pid'
  rm -f .agents/runs/LC/.lock/pid; rmdir .agents/runs/LC/.lock
  A ledger-note LC after >/dev/null || die 'the lock was not free after the live holder left'
  ok 'lock break: a holder that appears after the stale-pid read keeps the lock'
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
  A decide LC implementer --agent-path >/dev/null; grep -q 'signals=fix_round_2' .agents/runs/LC/decisions/*-implementer.decision || die "decide misses fix_round_2"
  worker FIX pass impl.txt 'impl: second attempt'; A handoff LC IMPLEMENTED >/dev/null
  gfail REVIEW_SMALL impl.txt
  expect_msg "a third round was allowed" 'fix rounds exhausted' A handoff LC IMPLEMENTING
  A next LC | grep -q '^next=agent.sh terminate LC FAILED' || die "next does not point to terminate FAILED"
  printf 'reason: the empty-key contract cannot be met within the frozen plan scope\nevidence: REVIEW_SMALL and VERIFY failed on all three contents\n' | A terminate LC FAILED >/dev/null
  expect_state execution state FAILED
  ok "fix loop: per-gate status, only stale gates listed, round-2 escalation, terminate FAILED"
}

# A171: an example of a finding class that an earlier revision already contained (the reviewer missed it) does not
# use up the implementer's fix round; a line already cited, or one that is new, still counts.
sc_fix_round_missed_example() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'
  wopen; printf '%s\n' 'impl: example one' 'impl: example two' >> impl.txt; wev GREEN pass; wclose
  A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null
  gfail REVIEW_SMALL impl.txt                                   # round 1 cites impl.txt:1
  [ "$(pipe_val fix_round)" = 1 ] || die "the first failing content is not round 1: $(pipe_val fix_round)"
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: fix of example one'; A handoff LC IMPLEMENTED >/dev/null
  # the next revision: the reviewer now cites impl.txt:2, a line of the previous revision that no finding cited
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-2|blocking|impl.txt:2|a second example of the same class|traced: example two; scan: grep -n example impl.txt; instances: single"
  [ "$(pipe_val fix_round)" = 1 ] || die "a missed example used up a fix round: $(pipe_val fix_round)"
  A handoff LC IMPLEMENTING >/dev/null || die "the fix round after a missed example was refused"
  worker FIX pass impl.txt 'impl: fix of example two'; A handoff LC IMPLEMENTED >/dev/null
  # re-citing the line that was already cited (the fix did not address it) is a real round
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-3|blocking|impl.txt:2|example two still not fixed|traced: example two; scan: grep -n example impl.txt; instances: single"
  [ "$(pipe_val fix_round)" = 2 ] || die "a re-cited line did not count as a round: $(pipe_val fix_round)"
  # a line that only exists in the latest revision (new code) is a real round too
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: third change'; A handoff LC IMPLEMENTED >/dev/null
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-4|blocking|impl.txt:5|new code from the last fix|traced: last fix; scan: grep -n fix impl.txt; instances: single"
  [ "$(pipe_val fix_round)" = 3 ] || die "a finding on new code did not count as a round: $(pipe_val fix_round)"
  expect_msg "a round beyond the maximum" 'fix rounds exhausted' A handoff LC IMPLEMENTING
  ok "fix rounds: a missed example of an earlier revision is not a round; a re-cited or new line is"
}

# A171 (review): a NEW copy of a line that exists elsewhere in the earlier revision is new code, not a missed example.
sc_fix_round_copied_line() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'
  wopen; printf '%s\n' 'impl: example one' 'impl: dup' >> impl.txt; wev GREEN pass; wclose
  A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null
  gfail REVIEW_SMALL impl.txt
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: dup'; A handoff LC IMPLEMENTED >/dev/null
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-2|blocking|impl.txt:3|the copy of the dup line is wrong|traced: copy; scan: grep -n dup impl.txt; instances: single"
  [ "$(pipe_val fix_round)" = 2 ] || die "a copied line was treated as a missed example: $(pipe_val fix_round)"
  ok "fix rounds: a new copy of an existing line is a round"
}

# A171 (review): a NEW copy of a line that exists elsewhere in the earlier revision is new code, not a missed example.
sc_fix_round_copied_line() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'
  wopen; printf '%s\n' 'impl: example one' 'impl: dup' >> impl.txt; wev GREEN pass; wclose
  A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null
  gfail REVIEW_SMALL impl.txt
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: dup'; A handoff LC IMPLEMENTED >/dev/null
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-2|blocking|impl.txt:3|the copy of the dup line is wrong|traced: copy; scan: grep -n dup impl.txt; instances: single"
  [ "$(pipe_val fix_round)" = 2 ] || die "a copied line was treated as a missed example: $(pipe_val fix_round)"
  ok "fix rounds: a new copy of an existing line is a round"
}

# A171: a rules review records how it scanned and lists every instance of the class in one pass.
sc_scan_method() {
  scaffold orchestrated; implemented orchestrated; A secret-scan LC >/dev/null
  expect_msg "a rules finding without a scan method" "lacks scan:" rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced'
  expect_msg "a six-character scan passed" "lacks scan:" rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|scan: abcdef; instances: single'
  expect_msg "a rules finding without the instances" "lacks instances: single" rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|scan: grep -rn lookup .'
  expect_msg "instances that omit the row location" 'instances do not include the row location impl.txt:1' rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|scan: grep -rn lookup .; instances: other.txt:9'
  rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|scan: grep -rn lookup .; instances: impl.txt:1, other.txt:9'
  [ "$(gate_st REVIEW_SMALL)" = fail ] || die "a finding with a scan method and the instance list was not recorded"
  ok "scan method: a rules finding names its scan and lists the instances, else it is rejected"
}

# A171: blocking or info is decided by the written rule, not by the round: the same observation keeps its
# classification on later revisions (the rule version is recorded with each gate record).
sc_classification_stable() {
  scaffold orchestrated
  worker RED fail impl_test.txt 'test: lookup returns the stored value'
  wopen; printf '%s\n' 'impl: example one' 'impl: example two' >> impl.txt; wev GREEN pass; wclose
  A handoff LC IMPLEMENTED >/dev/null; A secret-scan LC >/dev/null
  sev="scan: grep -n example impl.txt; instances: single"
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; $sev" "REVIEW_SMALL-2|info|impl.txt:2|observation only|traced"
  grep -q '^blocking_rule: "1"$' .agents/runs/LC/gates/*-REVIEW_SMALL.yaml || die "the gate record does not carry the rule version"
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: a fix'; A handoff LC IMPLEMENTED >/dev/null
  expect_msg "an info observation became blocking" 'classification changed for the same observation: REVIEW_SMALL-2 (impl.txt:2) is blocking, and was info' \
    rec REVIEW_SMALL FAIL high "REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; $sev" "REVIEW_SMALL-2|blocking|impl.txt:2|observation only|traced; $sev"
  expect_msg "a blocking finding was downgraded to info" 'is info, and was blocking' \
    rec REVIEW_SMALL FAIL high "REVIEW_SMALL-1|info|impl.txt:1|wrong default|traced" "REVIEW_SMALL-2|blocking|impl.txt:3|new finding|traced; $sev"
  rec REVIEW_SMALL FAIL high "REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; $sev" "REVIEW_SMALL-2|info|impl.txt:2|observation only|traced"
  [ "$(gate_st REVIEW_SMALL)" = fail ] || die "the same classification was not recorded"
  [ "$(sed -n 's/^blocking_rule_version=//p' "$tl_agents/scripts/agent.sh")" = "$(sed -n 's/^Blocking rule version: //p' "$tl_agents/GATES.md")" ] \
    || die "GATES.md and agent.sh state different blocking rule versions"
  ok "classification: the same observation keeps blocking or info across revisions under one rule version"
}

sc_waiver() {
  scaffold orchestrated; implemented orchestrated
  A secret-scan LC >/dev/null; gfail REVIEW_SMALL impl.txt; gpass QA; gpass VERIFY
  expect_msg "a waiver without approval" 'needs the user' A waive LC REVIEW_SMALL-1 --reason 'accepted risk: the default is documented upstream'
  expect_msg "a waiver without a reason" 'reason' A waive LC REVIEW_SMALL-1
  A request-approval LC waive:REVIEW_SMALL-1 >/dev/null
  capture 'approved, go ahead'
  expect_msg "an approval text not naming the finding" 'no approval phrase' A approve LC waive:REVIEW_SMALL-1
  # A134: the full sentence names the finding; a bare 'the waiver', another id or another kind's object is ambiguous
  for t in 'I approve the waiver' 'I approve the waiver of REVIEW_SMALL-2' 'I approve the plan' 'I approve the waiver of REVIEW_SMALL-1 but not the rest'; do
    capture "$t"; expect_fail "a waiver sentence approved: '$t'" A approve LC waive:REVIEW_SMALL-1
  done
  capture 'REVIEW_SMALL-1 feragatini onaylıyorum'
  A approve LC waive:REVIEW_SMALL-1 >/dev/null || die "the Turkish waiver sentence was refused"
  rm -f .agents/runs/LC/approvals/[0-9][0-9][0-9]-waive-REVIEW_SMALL-1.yaml; A request-approval LC waive:REVIEW_SMALL-1 >/dev/null
  capture 'I approve the waiver of REVIEW_SMALL-1.'
  A approve LC waive:REVIEW_SMALL-1 >/dev/null || die "the English waiver sentence was refused"
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

# A99: the script's approval question follows the run's language; identifiers and the approval words stay verbatim.
sc_question_language() {
  unfrozen COMPLEX
  hist=.agents/local/prompts/history; mkdir -p "$hist"
  for k in plan destructive single_step scope budget commit push; do
    A request-approval LC $k > "$base/q.en" || die "request-approval $k failed"
    grep -q "^1\. Approve $k for LC?" "$base/q.en" && grep -q '   options: approve | reject' "$base/q.en" || die "English run: $k question changed"
  done
  [ "$(A run-language LC)" = en ] || die "no signal must be English"
  printf 'Lütfen bu görevi yap ve sonra bana bir özet ver\n' > "$hist/1000000001-aaaaaaaa.txt"
  [ "$(A run-language LC)" = tr ] || die "a Turkish prompt was not detected"
  for k in plan destructive single_step scope budget commit push; do
    A request-approval LC $k > "$base/q.tr" || die "request-approval $k failed (tr)"
    grep -q '^QUESTIONS:$' "$base/q.tr" && grep -q "^1\. LC için $k onaylansın mı?" "$base/q.tr" || die "Turkish run: $k question is not Turkish"
    grep -q '   seçenekler: approve | reject (onay için "approve ' "$base/q.tr" && grep -q '   önerilen: yok' "$base/q.tr" && grep -q '   neden: ' "$base/q.tr" || die "Turkish run: $k options lost the approval words"
    grep -qE 'Approve|options:|recommended:|why:' "$base/q.tr" && die "Turkish run: $k question still holds English labels"
  done
  # A103: the user's own words decide; English replies and system-looking prompts never flip a Turkish run
  printf 'approve commit\n' > "$hist/1000000002-bbbbbbbb.txt"
  printf 'You are the reviewer subagent. Please read the diff and report findings now\n' > "$hist/1000000003-cccccccc.txt"
  [ "$(A run-language LC)" = tr ] || die "newer English prompts flipped a Turkish run"
  rm "$hist"/*.txt
  printf 'evet onay tamam\n' > "$hist/1000000001-aaaaaaaa.txt"
  [ "$(A run-language LC)" = en ] || die "short Turkish replies were taken as evidence"
  printf 'please go on with the plan now and report back\n' > "$hist/1000000001-aaaaaaaa.txt"
  [ "$(A run-language LC)" = en ] || die "an English run is not English"
  # TASK.md blockquote (the user's report) beats history
  printf '\n> Bu sayfa çalışmıyor, lütfen düzelt ve bir test ekle\n' >> .agents/runs/LC/TASK.md
  [ "$(A run-language LC)" = tr ] || die "TASK.md Turkish blockquote was ignored"
  printf '\nLanguage: en\n' >> .agents/runs/LC/TASK.md
  [ "$(A run-language LC)" = en ] || die "TASK.md Language: en was ignored"
  grep -v '^Language: en$' .agents/runs/LC/TASK.md > "$base/t.md"; cp "$base/t.md" .agents/runs/LC/TASK.md
  printf '\nLanguage: tr\n' >> .agents/runs/LC/TASK.md
  [ "$(A run-language LC)" = tr ] || die "TASK.md Language: tr was ignored"
  ok "approval questions: Turkish run prints Turkish with approve/reject and the kind word; English run unchanged (A99)"
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

# A171: the lead's `next` records an approval the prompt hook could not (cut off, or the lock was busy), so the user never runs
# `approve` in a terminal; a reply that is no approval is not recorded.
sc_approval_retry() {
  unfrozen COMPLEX
  A request-approval LC plan >/dev/null
  capture 'looks fine to me'
  A next LC | grep -q "the user's last reply is not an explicit approval" || die "a non-approval reply was not reported by next"
  ls .agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml >/dev/null 2>&1 && die "a reply without an approval phrase was recorded by next"
  capture 'approve the plan'
  out=$(A next LC); printf '%s' "$out" | grep -q 'was recorded just now' || die "next did not record the approval the hook could not: $out"
  ls .agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml >/dev/null 2>&1 || die "no approval file after the retry"
  grep -q 'retry output: approval recorded' .agents/local/approve.log || die "the retry is not logged: $(cat .agents/local/approve.log 2>/dev/null)"
  ok "next retries the approval of the user's newest message and logs it (A171)"
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

# A171: a plan over the class's max_scope_paths stops at freeze and proposes a split; only the user's own
# `proceed without splitting` lets it continue, and that answer is recorded in the ledger.
sc_split_override() {
  SC_SCOPE_EXTRA=AC-1 SC_SCOPE_OTHER=AC-1 unfrozen STANDARD
  d=.agents/runs/LC
  awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "3"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml
  grep -q 'max_scope_paths: 3' .agents/config.yaml || die "the test config was not narrowed"
  expect_msg "a plan over max_scope_paths froze" 'at least 2 tasks of at most 3 paths each' A freeze LC
  [ "$(ls $d/questions/[0-9][0-9][0-9].md | wc -l | tr -d ' ')" = 1 ] || die "freeze did not keep exactly one split question"
  grep -q '^ *SPLIT: 4@[0-9a-f]\{12\}$' $d/questions/001.md || die "the question is not bound to the scope list"
  expect_fail "freeze passed with the split question unanswered" A freeze LC
  # the lead's own answer, a negated or conditional user answer never lets it through
  printf 'proceed without splitting\n' | A answer LC 1 >/dev/null
  grep -q '^answered_by: lead' $d/questions/001.answer.md || die "an answer without a user capture was recorded as the user's"
  expect_msg "the lead's own override froze" 'pipeline allows at most 3' A freeze LC
  q=$(ls $d/questions/[0-9][0-9][0-9].md | tail -1); n=$(basename "$q" .md | sed 's/^0*//')
  capture 'proceed without splitting only if the reviewer agrees'; printf 'proceed without splitting only if the reviewer agrees\n' | A answer LC "$n" >/dev/null
  expect_msg "a conditional override froze" 'pipeline allows at most 3' A freeze LC
  q=$(ls $d/questions/[0-9][0-9][0-9].md | tail -1); n=$(basename "$q" .md | sed 's/^0*//')
  capture 'Proceed without splitting'; printf 'Proceed without splitting\n' | A answer LC "$n" >/dev/null
  A freeze LC >/dev/null 2>&1 || die "the user's override did not let the freeze through: $(A freeze LC 2>&1)"
  grep -q 'event=split_override .*scope_paths=4 max=3 class=STANDARD answer=questions/' $d/LEDGER.log || die "the override is not in the ledger"
  ok "freeze over max_scope_paths stops with a split proposal and proceeds only on the user's recorded 'proceed without splitting'"
}
# A200: the scope bound counts code paths. A content or document path is no reason to split; a path that holds code is always counted.
sc_scope_content() {
  SC_SCOPE_NAMED=notes.md unfrozen STANDARD; : > notes.md
  awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "2"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml
  [ "$(A path-kind notes.md | cut -f1)" = content ] && [ "$(A path-kind tool.sh | cut -f1)" = code ] && [ "$(A path-kind docs/tool.sh | cut -f1)" = code ] && [ "$(A path-kind impl.txt | cut -f1)" = code ] || die "path-kind: $(A path-kind notes.md tool.sh docs/tool.sh impl.txt | tr '\n' ' ')"
  A freeze LC >/dev/null 2>&1 || die "a content path counted against the scope bound: $(A freeze LC 2>&1)"
  SC_SCOPE_NAMED=tool.sh unfrozen STANDARD; : > tool.sh
  awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "2"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml
  expect_msg "a code path over the bound froze" 'code paths (content and document paths are not counted)' A freeze LC
  ok "A200: a content or document path is not counted against max_scope_paths, a file that holds code always is"
}
# A200: the answer to a batch pre-flight question (the user's own captured message, parsed by batch.sh) replaces the split question at freeze
# up to the ceiling the user was shown, and only while the batch approval of that summary stands.
sc_batch_split_answer() {
  SC_SCOPE_NAMED=tool.sh unfrozen STANDARD; : > tool.sh
  awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "2"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml
  b=.agents/local/batch; mkdir -p "$b" .agents/local/approvals
  printf '# Night batch\n\nnonce: test\n' > "$b/SUMMARY.md"; h=$(tsha "$b/SUMMARY.md"); id=$(printf '%s' "$h" | cut -c1-12)
  printf 'kind: "batch"\nbound: "%s"\nsource: "prompt_capture"\nrequest: "x"\nanswered_by: "user"\napproved_at: 1\nconsumed: "false"\n' "$h" > .agents/local/approvals/001-batch.yaml
  printf '%s\tLC\tQ1\tsplit\tb\t2\tmsg\n' "$id" > "$b/answers.tsv"
  expect_msg "an answer with a ceiling below the plan froze" 'code paths' A freeze LC
  printf '%s\tLC\tQ1\tsplit\tb\t5\tmsg\n' "$id" > "$b/answers.tsv"
  A freeze LC >/dev/null 2>&1 || die "the batch answer did not replace the split question: $(A freeze LC 2>&1)"
  grep -q 'event=split_override .*answer=batch:Q1' .agents/runs/LC/LEDGER.log || die "the batch answer is not in the ledger"
  ok "A200: a recorded batch answer 'proceed without splitting' passes the split check up to its ceiling, and is ledgered"
  SC_SCOPE_NAMED=tool.sh unfrozen STANDARD; : > tool.sh
  awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "2"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml
  b=.agents/local/batch; mkdir -p "$b" .agents/local/approvals
  printf '# Night batch\n\nnonce: test\n' > "$b/SUMMARY.md"; h=$(tsha "$b/SUMMARY.md"); id=$(printf '%s' "$h" | cut -c1-12)
  printf 'kind: "batch"\nbound: "%s"\nsource: "prompt_capture"\nrequest: "x"\nanswered_by: "user"\napproved_at: 1\nconsumed: "false"\n' "$h" > .agents/local/approvals/001-batch.yaml
  printf '%s\tLC\tQ1\tsplit\tb\t5\tmsg\n' "$id" > "$b/answers.tsv"
  printf 'changed\n' >> "$b/SUMMARY.md"
  expect_msg "an answer of a summary that changed froze" 'code paths' A freeze LC
  ok "A200: the answer is void when the summary it belongs to changed (no valid batch approval)"
}
# A79: the assumption register. Freeze checks the shape of both registers, refuses an unverified high-risk
# assumption until the user answered its bound question with `accept`, never accepts one silently, and the
# completion report lists every unverified or accepted-by-user assumption.
sc_assumptions() {
  unfrozen STANDARD
  d=.agents/runs/LC
  put_assumptions() { # FILE TEXT: replace the body of ## Assumptions (TEXT empty: drop the section)
    awk '/^## Assumptions[ \t]*$/ { skip = 1; next } /^## / { skip = 0 } !skip' "$1" > "$base/pa.tmp"
    [ -z "$2" ] || printf '\n## Assumptions\n\n%s\n' "$2" >> "$base/pa.tmp"
    cp "$base/pa.tmp" "$1"
  }
  head='| id | assumption | source | risk | verification | status | decisions |
|---|---|---|---|---|---|---|'
  low='| AS-3 | the cache is warm at startup | TASK.md | low | none | unverified | AC-1 |'
  p1='| AS-1 | the legacy key table is empty | TASK.md | high | count the rows in the staging copy | unverified | AC-1 |'
  p2='| AS-2 | no consumer reads the removed field | explorer-4 | high | search the consumer repositories | unverified | AC-1 |'
  # shape: the section is mandatory in both files; the trap (high risk, verified, no method) is rejected
  put_assumptions $d/PLAN.md ''
  expect_msg "a PLAN.md without the section froze" "PLAN.md: the mandatory '## Assumptions' section is missing" A freeze LC
  A next LC | grep -q '^reason=assumption register invalid' || die "next does not report the invalid register"
  put_assumptions $d/PLAN.md 'none'
  put_assumptions $d/EVIDENCE.md ''
  expect_msg "an EVIDENCE.md without the section froze" "EVIDENCE.md: the mandatory '## Assumptions' section is missing" A freeze LC
  put_assumptions $d/EVIDENCE.md "$head
| AS-2 | no consumer reads the removed field | explorer-4 | high | none | verified | AC-1 |"
  expect_msg "a high-risk assumption marked verified without a method froze" 'verified without a verification method' A freeze LC
  # a low-risk unverified assumption passes and does not block; verify-assumptions (read-only) lists it
  put_assumptions $d/EVIDENCE.md "$head
$low"
  A verify-assumptions LC | grep -Fq 'AS-3 risk=low status=unverified' || die "verify-assumptions does not list the low-risk unverified assumption"
  [ "$(AS reviewer verify-assumptions LC | tail -1)" = 'assumptions verified: LC' ] || die "a read-only role could not run verify-assumptions"
  # high-risk, unverified: freeze refuses and records one NEEDS_INPUT question per assumption, bound to its id
  put_assumptions $d/PLAN.md "$head
$p1"
  put_assumptions $d/EVIDENCE.md "$head
$p2
$low"
  expect_msg "an unverified high-risk assumption froze" 'unverified high-risk assumption' A freeze LC
  [ "$(ls $d/questions/*.md | wc -l | tr -d ' ')" = 2 ] || die "freeze did not record one question per high-risk assumption"
  grep -q '^ *ASSUMPTION: AS-1@[0-9a-f]\{12\}$' $d/questions/001.md || die "question 001 is not bound to AS-1"
  grep -q '^ *ASSUMPTION: AS-2@[0-9a-f]\{12\}$' $d/questions/002.md || die "question 002 is not bound to AS-2"
  expect_state execution awaiting_input true
  A next LC | grep -q '^next=agent.sh questions LC' || die "next does not stop for the assumption questions"
  expect_msg "verify-assumptions listed a blocked register as fine" 'never accepted silently' A verify-assumptions LC
  [ "$(ls $d/questions/*.md | wc -l | tr -d ' ')" = 2 ] || die "the read-only verify-assumptions recorded a question"
  expect_msg "a second freeze did not point at the pending question" 'is unanswered' A freeze LC
  [ "$(ls $d/questions/*.md | wc -l | tr -d ' ')" = 2 ] || die "a second freeze duplicated a pending question"
  # the lead's own answer (no user prompt) does not accept; a user answer that is not `accept` does not either
  printf 'accept AS-1\n' | A answer LC 1 >/dev/null
  grep -q '^answered_by: lead' $d/questions/001.answer.md || die "an answer without a user capture was recorded as the user's"
  capture 'no, the table still has rows'; printf 'no, the table still has rows\n' | A answer LC 2 >/dev/null
  grep -q '^answered_by: user' $d/questions/002.answer.md || die "the user's answer was not recorded as the user's"
  grep -q 'event=answer .*002.md answered_by=user assumption=AS-2@' $d/LEDGER.log || die "the answer row does not name the assumption"
  expect_msg "a declined assumption froze" 'did not accept it' A freeze LC
  [ "$(ls $d/questions/[0-9][0-9][0-9].md | wc -l | tr -d ' ')" = 4 ] || die "freeze did not ask again after a non-accepting answer"
  # the user accepts both (question 3 = AS-1 again, question 4 = AS-2 again)
  # a prompt that merely contains the word (or "acceptance") never accepts: the lead cannot forge the phrase
  capture 'the acceptance criteria look fine, accept the plan'; printf 'accept AS-1\n' | A answer LC 3 >/dev/null
  grep -q '^answered_by: lead' $d/questions/003.answer.md || die "an accept AS-1 absent from the user's prompt was recorded as the user's"
  A verify-assumptions LC | grep -Fq 'AS-1 risk=high status=blocked' || die "a forged accept accepted AS-1"
  capture 'accept'; printf 'accept\n' | A answer LC 4 >/dev/null
  grep -q '^answered_by: lead' $d/questions/004.answer.md || die "a bare accept without the id was recorded as an acceptance"
  A verify-assumptions LC | grep -Fq 'AS-2 risk=high status=blocked' || die "a bare accept (no id) accepted AS-2"
  expect_msg "a forged or bare accept froze" 'did not accept it' A freeze LC
  # freeze asked again for both (questions 5 and 6). The lead's accept is not enough when the user's prompt only
  # contains the phrase: negated, reported speech, conditional (all substrings of the prompt, none an acceptance).
  capture 'please do not accept AS-1 yet, it is wrong'; printf 'accept AS-1\n' | A answer LC 5 >/dev/null
  grep -q '^answered_by: lead' $d/questions/005.answer.md || die "a negated prompt (do not accept AS-1) accepted AS-1"
  A verify-assumptions LC | grep -Fq 'AS-1 risk=high status=blocked' || die "a negated prompt accepted AS-1"
  expect_msg "a negated accept froze" 'did not accept it' A freeze LC       # asks AS-1 again (question 7; AS-2's 6 is pending)
  capture 'I never said accept AS-1 ok'; printf 'accept AS-1\n' | A answer LC 7 >/dev/null
  grep -q '^answered_by: lead' $d/questions/007.answer.md || die "reported speech (never said accept AS-1) accepted AS-1"
  expect_msg "a reported accept froze" 'did not accept it' A freeze LC       # question 8
  capture 'accept AS-1 only if the table is empty'; printf 'accept AS-1\n' | A answer LC 8 >/dev/null
  grep -q '^answered_by: lead' $d/questions/008.answer.md || die "a conditional accept (only if) accepted AS-1"
  expect_msg "a conditional accept froze" 'did not accept it' A freeze LC    # question 9
  # A92: a prompt that also rejects, or offers an alternative, is not a plain acceptance
  capture 'accept AS-1 or reject it, your call'; printf 'accept AS-1\n' | A answer LC 9 >/dev/null
  grep -q '^answered_by: lead' $d/questions/009.answer.md || die "an accept-or-reject prompt accepted AS-1"
  expect_msg "an accept-or-reject froze" 'did not accept it' A freeze LC     # question 10
  capture 'accept AS-1, actually reject'; printf 'accept AS-1\n' | A answer LC 10 >/dev/null
  grep -q '^answered_by: lead' $d/questions/010.answer.md || die "a retracted accept (actually reject) accepted AS-1"
  expect_msg "a retracted accept froze" 'did not accept it' A freeze LC      # question 11
  capture 'accept AS-1, thanks'; printf 'accept AS-1\n' | A answer LC 11 >/dev/null
  grep -q '^answered_by: user' $d/questions/011.answer.md || die "a plain accept with thanks was not the user's"
  grep -qx 'accept AS-1' $d/questions/011.answer.md || die "the user's accept was not normalized"
  capture 'accept AS-2'; printf 'accept AS-2\n' | A answer LC 6 >/dev/null
  A verify-assumptions LC | grep -Fq 'AS-1 risk=high status=accepted-by-user ref=questions/011.answer.md' || die "AS-1 is not accepted-by-user with its answer"
  A verify-assumptions LC | grep -Fq 'AS-2 risk=high status=accepted-by-user ref=questions/006.answer.md' || die "AS-2 is not accepted-by-user with its answer"
  # a changed assumption text is a new assumption: the old answer does not carry over
  cp $d/PLAN.md "$base/plan.keep"
  sed 's/the legacy key table is empty/the legacy key table has no live rows/' "$base/plan.keep" > $d/PLAN.md
  expect_msg "an answer for another text of the assumption was reused" 'unverified high-risk assumption' A freeze LC
  [ "$(ls $d/questions/[0-9][0-9][0-9].md | wc -l | tr -d ' ')" = 12 ] || die "a changed assumption text was not asked again"
  cp "$base/plan.keep" $d/PLAN.md
  printf 'accept AS-1\n' | A answer LC 12 >/dev/null   # the question of the reverted wording is moot; CODE_DONE needs none pending
  A freeze LC >/dev/null || die "freeze refused after the user accepted both assumptions"
  A verify-freeze LC >/dev/null
  ok "assumptions: shape, trap, low-risk pass, bound question, no silent accept, user accept, text change, freeze"

  # the completion report lists every unverified and accepted-by-user assumption (ids; accepted ones with the answer)
  A handoff LC IMPLEMENTING >/dev/null
  to_code_done standalone
  A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null; write_report
  expect_msg "a report that omits the assumptions was published" 'does not list: AS-1 AS-2 AS-3' A publish-completion-report LC markdown
  write_report '' '## Assumptions' '- AS-1 (high): accepted-by-user' '- AS-2 (high): accepted-by-user, questions/006.answer.md' '- AS-3 (low): unverified'
  expect_msg "an accepted assumption without its answer reference was published" 'does not list: AS-1(answer questions/011.answer.md)' A publish-completion-report LC markdown
  write_report '' '## Assumptions' '- AS-1 (high): accepted-by-user, questions/011.answer.md' '- AS-2 (high): accepted-by-user, questions/006.answer.md' '- AS-3 (low): verified'
  expect_msg "an unverified assumption reported as verified was published" 'AS-3(unverified)' A publish-completion-report LC markdown
  write_report '' '## Assumptions' '- AS-1 (high): accepted-by-user, questions/011.answer.md' '- AS-2 (high): accepted-by-user, questions/006.answer.md' '- AS-3 (low): unverified'
  A publish-completion-report LC markdown >/dev/null || die "a report listing every assumption was refused"
  ok "assumptions: completion report lists unverified and accepted-by-user assumptions"
}

sc_supervised_destructive() {
  unfrozen COMPLEX
  expect_msg "supervised freeze without plan approval" 'plan approval' A freeze LC
  A next LC | grep -q '^next=agent.sh request-approval LC plan' || die "next does not ask for the plan approval"
  approve_as_user plan 'approve the plan'
  printf 'edited after approval\n' >> .agents/runs/LC/PLAN.md
  expect_msg "an approval for an older PLAN.md" 'plan approval' A freeze LC
  approve_as_user plan 'approve the plan please'
  A freeze LC >/dev/null
  ok "supervised freeze needs a plan approval bound to PLAN.md"
  # destructive data change (K-6): forced CRITICAL at freeze; the freeze needs the plan approval only, the
  # destructive approval stops the run after the freeze, before IMPLEMENT, bound to the frozen PLAN.md hash
  unfrozen STANDARD
  printf '\n## Data\n\ndestructive: maybe\n' >> .agents/runs/LC/PLAN.md
  expect_msg "an invalid ## Data first line" 'destructive: yes' A freeze LC
  sed 's/^destructive: maybe$/destructive: yes/' .agents/runs/LC/PLAN.md > "$base/p.md"; cp "$base/p.md" .agents/runs/LC/PLAN.md
  expect_fail "a destructive plan froze without the plan approval" A freeze LC
  expect_state pipeline classification CRITICAL
  expect_msg "a destructive plan reclassified below CRITICAL" 'CRITICAL' A classify LC STANDARD
  approve_as_user plan 'approve the plan'
  expect_msg "a destructive plan with no expand/contract steps froze" 'without expand/contract steps' A freeze LC
  A next LC | grep -q 'destructive plan without expand/contract steps' || die "next does not name the missing expand/contract steps"
  # a one-release plan: the destructive step shares the expand phase
  printf '\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | drop_column | books.legacy_notes | yes | no | restore from backup | table rewrite |\n' >> .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve this plan'
  expect_msg "a one-release destructive plan froze" 'without expand/contract steps' A freeze LC
  # expand then contract: accepted with the plan approval alone
  sed '/^| S1 | expand | drop_column/d' .agents/runs/LC/PLAN.md > "$base/p.md"; cp "$base/p.md" .agents/runs/LC/PLAN.md
  printf '| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n' >> .agents/runs/LC/PLAN.md
  A next LC | grep -q '^next=agent.sh request-approval LC plan' || die "next does not ask for the plan approval of the final plan"
  A next LC | grep -q 'destructive approval required before' && die "next asks for the destructive approval before the freeze"
  approve_as_user plan 'please approve the plan'
  A next LC | grep -q '^next=agent.sh freeze LC' || die "next does not offer the freeze with only the plan approval"
  A freeze LC >/dev/null || die "a destructive plan with the plan approval was not frozen"
  [ "$(pipe_val tier)" = full ]
  expect_state handoff state PLANNED
  # after the freeze: next asks for the destructive approval, bound to the frozen hash, before IMPLEMENT
  A next LC | grep -q '^next=agent.sh request-approval LC destructive' || die "next does not ask for the destructive approval after the freeze"
  A next LC | grep -q '^reason=destructive approval required before IMPLEMENT' || die "next reason lacks 'destructive approval required before IMPLEMENT'"
  A next LC | grep -q 'agent.sh handoff LC IMPLEMENTING' && die "next offers the handoff before the destructive approval"
  expect_msg "IMPLEMENTING without the destructive approval" 'agent.sh request-approval LC destructive' A handoff LC IMPLEMENTING
  expect_state handoff state PLANNED
  approve_as_user destructive 'approve the destructive migration'
  A next LC | grep -q '^next=agent.sh handoff LC IMPLEMENTING' || die "next does not offer the handoff after the destructive approval"
  A handoff LC IMPLEMENTING >/dev/null || die "IMPLEMENTING refused with a valid destructive approval"
  expect_state handoff state IMPLEMENTING
  ok "destructive plan: forced CRITICAL, freeze on the plan approval, destructive approval before IMPLEMENT"
  # a refreeze (new PLAN.md hash) drops the approval: it must be requested again before IMPLEMENT
  unfrozen STANDARD
  printf '\n## Data\n\ndestructive: yes\n\n| step | phase | operation | object | destructive | reversible | rollback | lock |\n|---|---|---|---|---|---|---|---|\n| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |\n| S2 | contract | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |\n' >> .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve plan'
  A freeze LC >/dev/null || die "freeze for the refreeze scenario failed"
  approve_as_user destructive 'approve destructive migration'
  mkdir -p .agents/runs/LC/amendments; printf '# amendment 001: clarify the migration\n' > .agents/runs/LC/amendments/001.md
  printf 'amended: migration note\n' >> .agents/runs/LC/PLAN.md
  approve_as_user plan 'approve a plan'
  A refreeze LC 001.md | grep -q 'destructive / single_step approval was bound to the old one' || die "refreeze does not say the destructive approval was dropped"
  expect_msg "IMPLEMENTING with an approval bound to the old PLAN.md" 'agent.sh request-approval LC destructive' A handoff LC IMPLEMENTING
  A next LC | grep -q '^next=agent.sh request-approval LC destructive' || die "next does not ask again after the refreeze"
  approve_as_user destructive 'approve the destructive migration please'
  A handoff LC IMPLEMENTING >/dev/null || die "IMPLEMENTING refused after the destructive approval of the new hash"
  ok "a refreeze drops the destructive approval"
  # an explicit single-step approval is the only way to a one-step destructive change
  unfrozen STANDARD
  printf '\n## Data\n\ndestructive: yes\nsingle_step: yes\n\ndrop books.legacy_notes in one migration\n' >> .agents/runs/LC/PLAN.md
  printf '\nThe user wants this migration as a single step.\n' >> .agents/runs/LC/TASK.md
  approve_as_user plan 'yes approve the plan'
  A freeze LC >/dev/null || die "a single_step plan was not frozen on the plan approval"
  approve_as_user destructive 'please approve destructive migration'
  expect_msg "a single_step plan reached IMPLEMENTING without the single-step approval" "single-step approval" A handoff LC IMPLEMENTING
  A next LC | grep -q '^next=agent.sh request-approval LC single_step' || die "next does not ask for the single_step approval"
  approve_as_user single_step 'approve single step'
  A handoff LC IMPLEMENTING >/dev/null || die "an approved single-step plan was refused"
  ok "single_step: yes needs the user's single-step approval before IMPLEMENT"
}

# K-6: a refreeze that changes the PLAN.md of a destructive plan while the run is IMPLEMENTING or IMPLEMENTED
# sends it back to PLANNED: the implementer cannot work and IMPLEMENTED is unreachable until a destructive
# approval for the new hash exists. A fix-round reopen (same hash) does not ask again.
dest_data='
## Data

destructive: yes

| step | phase | operation | object | destructive | reversible | rollback | lock |
|---|---|---|---|---|---|---|---|
| S1 | expand | switch_reads | books.legacy_notes | no | yes | redeploy the previous release | none |
| S2 | deferred | drop_column | books.legacy_notes | yes | no | restore from the backup | table rewrite |
'
amend_plan() { # N TEXT: write amendment N and append TEXT to PLAN.md
  mkdir -p .agents/runs/LC/amendments; printf '# amendment %s: destructive migration added to the plan\n' "$1" > ".agents/runs/LC/amendments/$1.md"
  printf '%s\n' "$2" >> .agents/runs/LC/PLAN.md
}
sc_destructive_refreeze() {
  for dr_from in IMPLEMENTING IMPLEMENTED; do
    scaffold orchestrated
    if [ "$dr_from" = IMPLEMENTED ]; then worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'; A handoff LC IMPLEMENTED >/dev/null; fi
    amend_plan 001 "$dest_data"
    A refreeze LC 001.md | grep -q 'back at PLANNED' || die "$dr_from: the refreeze does not say the run is back at PLANNED"
    expect_state handoff state PLANNED
    expect_state pipeline classification CRITICAL
    expect_msg "$dr_from: window-open without the destructive approval" 'destructive approval' A window-open LC
    expect_msg "$dr_from: IMPLEMENTED without the destructive approval" 'illegal handoff transition' A handoff LC IMPLEMENTED
    expect_msg "$dr_from: IMPLEMENTING without the destructive approval" 'agent.sh request-approval LC destructive' A handoff LC IMPLEMENTING
    A next LC | grep -q '^next=agent.sh request-approval LC destructive' || die "$dr_from: next does not ask for the destructive approval"
    A next LC | grep -q '^reason=destructive approval required before IMPLEMENT' || die "$dr_from: next reason is not 'destructive approval required before IMPLEMENT'"
    approve_as_user destructive 'approve the destructive migration'
    A handoff LC IMPLEMENTING >/dev/null || die "$dr_from: IMPLEMENTING refused with the approval for the new hash"
    wopen
    wclose
    # the approval was consumed and is bound to this hash: a second plan change asks again
    amend_plan 002 'amended again: second plan change'
    A refreeze LC 002.md >/dev/null
    expect_state handoff state PLANNED
    expect_msg "$dr_from: a consumed approval reused for another hash" 'agent.sh request-approval LC destructive' A handoff LC IMPLEMENTING
    expect_msg "$dr_from: window-open on a consumed approval" 'destructive approval' A window-open LC
  done
  ok "a refreeze of a destructive plan from IMPLEMENTING or IMPLEMENTED returns to PLANNED until the new hash is approved"
  # a fix-round reopen keeps the hash: no new approval
  scaffold orchestrated
  amend_plan 001 "$dest_data"
  A refreeze LC 001.md >/dev/null
  approve_as_user destructive 'approve the destructive migration'
  A handoff LC IMPLEMENTING >/dev/null
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null; gfail REVIEW_RULES impl.txt
  A handoff LC IMPLEMENTING >/dev/null || die "the fix-round reopen asked for a new destructive approval"
  expect_state handoff state IMPLEMENTING
  wopen
  wclose
  ok "a fix-round reopen (same PLAN.md hash) does not ask for the destructive approval again"
  # a refreeze that leaves PLAN.md unchanged (TASK.md only) stays at IMPLEMENTING: the approval still binds the hash
  scaffold orchestrated
  amend_plan 001 "$dest_data"
  A refreeze LC 001.md >/dev/null
  approve_as_user destructive 'approve the destructive migration'
  A handoff LC IMPLEMENTING >/dev/null
  mkdir -p .agents/runs/LC/amendments; printf '# amendment 002: clarify the task wording only\n' > .agents/runs/LC/amendments/002.md
  printf '\n- AC-1 clarified: an empty key returns the documented default\n' >> .agents/runs/LC/TASK.md
  A refreeze LC 002.md >/dev/null
  expect_state handoff state IMPLEMENTING
  wopen
  wclose
  ok "a TASK.md-only refreeze of a destructive plan (same PLAN.md hash) stays at IMPLEMENTING"
  # a refreeze from destructive to non-destructive needs no destructive approval
  mkdir -p .agents/runs/LC/amendments; printf '# amendment 003: the migration is dropped from this change\n' > .agents/runs/LC/amendments/003.md
  sed -e 's/^destructive: yes$/destructive: no/' -e '/^| S[0-9] |/d' -e '/^| step |/d' -e '/^|---/d' .agents/runs/LC/PLAN.md > "$base/p.md"; cp "$base/p.md" .agents/runs/LC/PLAN.md
  A refreeze LC 003.md >/dev/null
  expect_state handoff state IMPLEMENTING
  wopen
  wclose
  ok "a refreeze from destructive to non-destructive stays at IMPLEMENTING"
}

sc_questions() {
  scaffold orchestrated
  mkdir -p .agents/runs/LC/reports/snapshots; printf '# explorer notes\n' > .agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md
  # QR is the asking role (default explorer); one NEEDS_INPUT round per role (C-14), so later rounds use other roles.
  q() { qr=${QR:-explorer}; { printf 'ROLE: %s\nTASK: LC\n' "$qr"; [ -z "${QF:-}" ] || printf 'FOCUS: %s\n' "$QF"; printf 'RESULT: NEEDS_INPUT\nCONFIDENCE: medium\nFINGERPRINT: %s\nARTIFACT: reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md %s\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n\n%s' "$(A fingerprint LC)" "$(tsha .agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md)" "$1"; } > "$base/q.md"; AS "$qr" record LC --file "$base/q.md"; }
  expect_msg "NEEDS_INPUT without questions" 'QUESTIONS' q ''
  q 'QUESTIONS:
1. Which default should an empty key return?
   options: nil | empty string
   recommended: nil
   why: AC-1 depends on it
' >/dev/null
  # C-14: the same role asking a second time is rejected; a different role is still accepted
  expect_msg "a second NEEDS_INPUT from the same role" 'already asked its questions in this run' q 'QUESTIONS:
1. Keep the old lookup name?
   options: yes | no
   recommended: yes
   why: callers depend on it
'
  [ ! -f .agents/runs/LC/questions/002.md ] || die "a rejected second NEEDS_INPUT was stored"
  QR=architect q 'QUESTIONS:
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
  QR=designer q 'QUESTIONS:
1. Which default for a missing file?
' >/dev/null
  capture 'the default is an empty list' "$(( $(date +%s) - 100 ))"
  printf 'the default is an empty list\n' | A answer LC 3 >/dev/null
  grep -q '^answered_by: lead' .agents/runs/LC/questions/003.answer.md || die "an answer from a capture older than the question is answered_by user"
  QR=qa q 'QUESTIONS:
1. Proceed?
' >/dev/null
  capture 'ok'
  printf 'ok\n' | A answer LC 4 >/dev/null
  grep -q '^answered_by: lead' .agents/runs/LC/questions/004.answer.md || die "a two-character answer is answered_by user"
  # --captured: the answer is the user's own captured message (multi-line, skipping a task notification), not text the lead
  # relays (site run: lead-rewritten and one-character answers were recorded as the lead's). A171: it is the NEWEST message
  # since the question, by capture time, not the oldest unused one; the command says which message it took.
  QR=data_architect q 'QUESTIONS:
1. Which fix?
' >/dev/null
  h=.agents/local/prompts/history; mkdir -p "$h"; now=$(( $(date +%s) + 1000 ))   # far enough ahead that a slow run still asks every later question before these stamps
  printf '1: fix qa-1 now\n   (CSS in Base.astro)\n2: waive drift\n' > "$h/$((now + 1))-bbbbbbbb.txt"
  printf '1: fix qa-1 later, 2: waive drift\n' > "$h/$((now + 2))-cccccccc.txt"
  printf '<task-notification>\nAgent done\n</task-notification>\n' > "$h/$((now + 3))-aaaaaaaa.txt"
  out=$(A answer LC 5 --captured) || die "--captured failed: $out"
  grep -q '^answered_by: user' .agents/runs/LC/questions/005.answer.md || die "--captured did not record the user's message as the user's"
  sed '1,/^---$/d' .agents/runs/LC/questions/005.answer.md | sed 's/^> //; s/^>$//' | cmp -s - "$h/$((now + 2))-cccccccc.txt" || die "--captured did not take the LATEST user message (a task notification is skipped) verbatim: $(cat .agents/runs/LC/questions/005.answer.md)"
  printf '%s' "$out" | grep -Fq "answer source: the user's message $((now + 2))-cccccccc.txt" || die "--captured did not say which message it took: $out"
  grep -q "^source_message: $((now + 2))-cccccccc.txt" .agents/runs/LC/questions/005.answer.md || die "the answer file does not name its source message"
  ok "answer --captured takes the newest user message after the question and prints which one (A171)"
  # one message answers one question: while the newest message is the used one, the next question has no answer yet
  printf '1. Another?\n' | A ask LC >/dev/null
  expect_msg "a used-up newest message answered a second question" 'already answered another question' A answer LC 6 --captured
  printf 'and for the other one: use the fallback\n' > "$h/$((now + 4))-dddddddd.txt"
  A answer LC 6 --captured >/dev/null
  sed '1,/^---$/d' .agents/runs/LC/questions/006.answer.md | sed 's/^> //' | cmp -s - "$h/$((now + 4))-dddddddd.txt" || die "the second question did not get the newer message"
  sed "s/^answered_epoch: .*/answered_epoch: $((now + 10))/" .agents/runs/LC/questions/006.answer.md > "$base/a6.tmp" && mv "$base/a6.tmp" .agents/runs/LC/questions/006.answer.md   # the answer was given at a fixed time, so older messages are not 'newer'
  # A171: --amend: a newer user message corrects a recorded answer; the old record is kept, marked amended. The lead alone cannot.
  expect_msg "the lead amended an answer without a newer user message" 'no captured user message newer than the recorded answer' A answer LC 6 --amend
  expect_msg "an amend with the lead's own text on stdin was accepted" 'no captured user message newer' sh -c 'echo "forced" | sh ./.agents/scripts/agent.sh answer LC 6 --amend'
  printf 'sorry, I meant: use the strict mode\n' > "$h/$((now + 60))-eeeeeeee.txt"
  out=$(A answer LC 6 --amend) || die "--amend with a newer user message failed: $out"
  [ -f .agents/runs/LC/questions/006.answer.amended-1.md ] && grep -q '^amended: true' .agents/runs/LC/questions/006.answer.amended-1.md || die "the old answer was not kept as amended"
  sed '1,/^---$/d' .agents/runs/LC/questions/006.answer.amended-1.md | sed 's/^> //' | cmp -s - "$h/$((now + 4))-dddddddd.txt" || die "the amended record lost the old answer"
  sed '1,/^---$/d' .agents/runs/LC/questions/006.answer.md | sed 's/^> //' | cmp -s - "$h/$((now + 60))-eeeeeeee.txt" || die "the new answer is not the newer message"
  grep -q '^amends: 006.answer.amended-1.md' .agents/runs/LC/questions/006.answer.md && printf '%s' "$out" | grep -q 'old record is kept' || die "the new answer does not reference the amended record: $out"
  grep -q 'event=answer-amend' .agents/runs/LC/LEDGER.log || die "the amend is not in the ledger"
  sed "s/^answered_epoch: .*/answered_epoch: $((now + 61))/" .agents/runs/LC/questions/006.answer.md > "$base/a6.tmp" && mv "$base/a6.tmp" .agents/runs/LC/questions/006.answer.md
  expect_msg "a second amend with the same message" 'no captured user message newer' A answer LC 6 --amend
  ok "answer --amend keeps the old record (amended), needs a newer captured user message; the lead alone cannot amend (A171)"
  # A171: the user's text is stored in a quote block, so a Turkish answer passes the language check
  printf '1. Which name?\n' | A ask LC >/dev/null
  printf 'Bence şu şekilde olsun: ığüşöç çok güzel\n' > "$h/$((now + 70))-ffffffff.txt"
  A answer LC 7 --captured >/dev/null
  grep -qx '> Bence şu şekilde olsun: ığüşöç çok güzel' .agents/runs/LC/questions/007.answer.md || die "the Turkish answer is not stored as a quote block: $(cat .agents/runs/LC/questions/007.answer.md)"
  A language-check .agents/runs/LC/questions/007.answer.md >/dev/null || die "a quoted Turkish answer failed the language check"
  printf 'Bence şu şekilde olsun: ığüşöç çok güzel\n' | expect_msg "unquoted Turkish passed the language check" 'language: run artifacts are English' A language-check -
  printf '> Bence şu şekilde olsun: ığüşöç çok güzel\n' | A language-check - >/dev/null || die "a quote block is not exempt"
  ok "a quoted Turkish answer passes the language check, the same text unquoted fails"
  # A92: a risk FOCUS on a task result does not open a second round for qa (C-14)
  QF=visual QR=qa expect_msg "a second NEEDS_INPUT from qa with FOCUS: visual" 'already asked its questions in this run' q 'QUESTIONS:
1. And the dark theme?
   options: yes | no
   recommended: yes
   why: AC-1 depends on it
'
  A verify-seal LC >/dev/null
  ok "questions: verbatim store, answered_by user vs lead (capture newer, answer >= 3 chars), awaiting_input"
}

sc_questions_keys() {
  scaffold orchestrated
  mkdir -p .agents/runs/LC/reports/snapshots .agents/runs/LC/questions; printf '# notes\n' > .agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md
  # a legacy question file (no focus: line) still counts for its role; another focus is a different key
  printf 'from: designer\nasked_at: 1\n---\n1. old question\n' > .agents/runs/LC/questions/001.md
  printf 'from: qa\nfocus: tests\nasked_at: 1\n---\n1. other focus\n' > .agents/runs/LC/questions/002.md
  q() { printf 'ROLE: %s\nTASK: LC\nRESULT: NEEDS_INPUT\nCONFIDENCE: medium\nFINGERPRINT: %s\nARTIFACT: reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md %s\n\n| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n\nQUESTIONS:\n1. Proceed?\n' "$1" "$(A fingerprint LC)" "$(tsha .agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_001-explorer.md)" > "$base/q.md"; AS "$1" record LC --file "$base/q.md"; }
  expect_msg "a legacy question file without focus did not count" 'designer role already asked its questions in this run (questions/001.md)' q designer
  q qa >/dev/null || die "a question file with another focus blocked the role"
  ok "questions: legacy file without focus counts for its role; a different focus is a different key; message names the file and later instances"
}

sc_questions_grill() {
  scaffold orchestrated
  mkdir -p .agents/runs/LC/reports .agents/runs/LC/design; printf '# notes\n' > .agents/runs/LC/reports/001-task_author.md; printf '# Intent\n\n## Status\n\nin-progress\n' > .agents/runs/LC/design/INTENT.md
  printf '1. Proceed?\n   options: yes | no\n   recommended: yes\n   why: it unblocks the tree\n' > "$base/gq.txt"
  # sg ROLE ARTIFACT TOKEN: a NEEDS_INPUT through the real `submit` (which snapshots the artifact before `record`)
  sg() { AS "$1" submit LC --result NEEDS_INPUT --confidence medium --artifact "$2" --questions "$base/gq.txt" --agent "$3"; }
  # A75: intent-grill's interview (the task author, artifact design/INTENT.md) is multi-round and never limited
  sg task_author design/INTENT.md g1 >/dev/null || die "intent-grill's first round was refused"
  sg task_author design/INTENT.md g2 >/dev/null || die "intent-grill's second round was refused"
  sg task_author design/INTENT.md g3 >/dev/null || die "intent-grill's third round was refused"
  # its rounds do not use up the role's own round; a non-grill second round is refused (C-14)
  sg task_author reports/001-task_author.md t1 >/dev/null || die "the task author's own first round was refused after intent-grill rounds"
  expect_msg "a second non-grill NEEDS_INPUT from the same role" 'already asked its questions in this run' sg task_author reports/001-task_author.md t2
  # the exemption needs an interview in progress: a design/INTENT.md that is not in-progress is an ordinary round
  printf '# Intent\n\n## Status\n\ncomplete\n' > .agents/runs/LC/design/INTENT.md
  expect_msg "a task author NEEDS_INPUT with a finished INTENT.md was exempt" 'already asked its questions in this run' sg task_author design/INTENT.md c1
  printf '# intent\n' > .agents/runs/LC/design/INTENT.md
  expect_msg "a task author NEEDS_INPUT with a stub INTENT.md was exempt" 'already asked its questions in this run' sg task_author design/INTENT.md c2
  printf '# Intent\n\n## Status\n\nin-progress\n' > .agents/runs/LC/design/INTENT.md
  sg task_author design/INTENT.md g4 >/dev/null || die "an in-progress interview round was refused after the role's own round"
  # the exemption is the task author's: another role under design/ with the same artifact is bound by C-14
  sg architect design/INTENT.md a1 >/dev/null || die "the architect's first round was refused"
  expect_msg "an architect NEEDS_INPUT with design/INTENT.md was exempt" 'already asked its questions in this run' sg architect design/INTENT.md a2
  ok "questions: through submit, the task author's intent-grill rounds are exempt (A75); a non-grill second round and an architect with design/INTENT.md are refused (C-14)"
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
  A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  A next LC | grep -q '^next=write COMPLETION_REPORT.md'
  ok "next: deterministic steps from approval to completion"
}

sc_decide() {
  scaffold orchestrated; implemented orchestrated
  STUB_ARGS=$base/args; export STUB_ARGS; : > "$STUB_ARGS"
  A decide LC reviewer --agent-path --focus rules+tests >/dev/null
  ls .agents/runs/LC/decisions/001-reviewer-rules-tests.decision >/dev/null
  grep -q -- '--role reviewer --class COMPLEX --tier small --escalations-used 0' "$STUB_ARGS" || die "decide args: $(cat "$STUB_ARGS")"
  ! grep -q -- '--runtime\|--profile' "$STUB_ARGS" || die "decide passed runtime/profile without an override"
  grep -q 'event=decide .*model=sonnet' .agents/runs/LC/LEDGER.log
  # A200: the Agent path is Claude Code's; a role on another runtime is refused there and sent to dispatch.sh. --dry still reads the decision.
  expect_msg "A200: --agent-path accepted a role configured for Codex" 'has no Agent path' A decide LC implementer --agent-path --runtime codex
  tail -1 "$STUB_ARGS" | grep -q -- '--runtime codex' || die "--runtime override not passed"
  [ ! -e .agents/runs/LC/decisions/002-implementer.decision ] || die "A200: the refused Agent-path decision was persisted"
  A decide LC implementer --dry --runtime codex | grep -q '^runtime=codex' || die "decide --dry --runtime codex does not read the codex decision"
  expect_fail "an invalid override was accepted" A decide LC reviewer --agent-path --model bogus
  [ ! -e .agents/runs/LC/decisions/002-reviewer.decision ] || die "a refused decision was persisted"
  expect_fail "an unknown decide flag was accepted" A decide LC reviewer --agent-path --turbo yes
  expect_fail "a reviewer called decide" AS reviewer decide LC reviewer
  # A171: decide is not called ahead of a dispatch; --dry reads without writing; the output starts with a one-line summary
  nd=$(($(ls .agents/runs/LC/decisions | wc -l))); nl=$(($(wc -l < .agents/runs/LC/LEDGER.log)))
  expect_msg "a bare decide (ahead of a dispatch) was accepted" 'not called ahead of one' A decide LC reviewer --focus rules+tests
  [ "$(($(ls .agents/runs/LC/decisions | wc -l)))" = "$nd" ] || die "a refused decide persisted a decision"
  dry=$(A decide LC reviewer --focus rules+tests --dry) || die "decide --dry refused: $dry"
  [ "$(($(ls .agents/runs/LC/decisions | wc -l)))" = "$nd" ] || die "decide --dry wrote a decision file"
  [ "$(($(wc -l < .agents/runs/LC/LEDGER.log)))" = "$nl" ] || die "decide --dry wrote the ledger"
  printf '%s\n' "$dry" | head -n 1 | grep -Eq '^decision: role=reviewer runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ reason=[A-Za-z_,]+ \(dry run: nothing recorded\)$' || die "decide --dry: first line is not the summary: $(printf '%s\n' "$dry" | head -n 1)"
  printf '%s\n' "$dry" | grep -q '^model=' || die "decide --dry lost the key=value lines"
  expect_msg "a repeated --agent-path was accepted before any result" 'no result has been recorded since' A decide LC reviewer --focus rules+tests --agent-path
  # a result of another role or another focus does not release the step; one of this role and focus does
  mkdir -p .agents/runs/LC/results; printf 'FOCUS: rules+tests\n' > .agents/runs/LC/results/098-security_reviewer.result.md; printf 'FOCUS: plan\n' > .agents/runs/LC/results/097-reviewer.result.md
  expect_msg "a result of another role or focus released the step" 'no result has been recorded since' A decide LC reviewer --focus rules+tests --agent-path
  rm -f .agents/runs/LC/results/098-security_reviewer.result.md .agents/runs/LC/results/097-reviewer.result.md
  printf 'FOCUS: rules+tests\n' > .agents/runs/LC/results/099-reviewer.result.md   # a result recorded since the first decision
  real=$(A decide LC reviewer --focus rules+tests --agent-path) || die "decide --agent-path refused: $real"
  printf '%s\n' "$real" | head -n 1 | grep -Eq '^decision: role=reviewer runtime=claude model=[a-z0-9.-]+ effort=[a-z]+ reason=[A-Za-z_,]+$' || die "decide: first line is not the summary: $(printf '%s\n' "$real" | head -n 1)"
  [ "$(($(ls .agents/runs/LC/decisions | wc -l)))" = "$((nd + 1))" ] || die "decide --agent-path did not record one decision: before $nd now $(ls .agents/runs/LC/decisions | tr "\n" " ")"
  expect_msg "a second decide --agent-path for the same step was accepted" 'no result has been recorded since' A decide LC reviewer --focus rules+tests --agent-path
  [ "$(($(ls .agents/runs/LC/decisions | wc -l)))" = "$((nd + 1))" ] || die "a refused second --agent-path persisted a decision"
  rm -f ".agents/runs/LC/decisions/$(ls .agents/runs/LC/decisions | tail -n 1)" .agents/runs/LC/results/099-reviewer.result.md
  expect_msg "a hand-set PROOFLINE_DISPATCH=1 was accepted" 'not called ahead of one' env PROOFLINE_DISPATCH=1 sh ./.agents/scripts/agent.sh decide LC reviewer --focus rules+tests
  # --redecide: the lead may decide again for the same step (another runtime or model), the earlier decision stays, a ledger note says so
  ndr=$(($(ls .agents/runs/LC/decisions | wc -l)))
  expect_msg "the refusal does not show --redecide" '--redecide' A decide LC reviewer --focus rules+tests --agent-path
  if AS reviewer decide LC reviewer --focus rules+tests --redecide >/dev/null 2>&1; then die "a reviewer used --redecide"; fi
  A decide LC reviewer --focus rules+tests --redecide >/dev/null || die "--redecide refused"
  [ "$(($(ls .agents/runs/LC/decisions | wc -l)))" = "$((ndr + 1))" ] || die "--redecide did not add a decision beside the earlier one"
  grep -q 'detail=decide --redecide reviewer' .agents/runs/LC/LEDGER.log || die "--redecide is not in the ledger"
  # the dispatch nonce: pid-bound and one use
  mkdir -p .agents/local/dispatch; nn=0123456789abcdef0123456789abcdef
  sleep 30 & npid=$!; printf '%s\n' "$npid" > ".agents/local/dispatch/nonce-$nn"
  expect_msg "a nonce of a live process that is not an ancestor was accepted" 'not called ahead of one' env PROOFLINE_DISPATCH=$nn sh ./.agents/scripts/agent.sh decide LC reviewer --focus rules+tests
  kill "$npid" 2>/dev/null; printf '%s\n' "$$" > ".agents/local/dispatch/nonce-$nn"
  PROOFLINE_DISPATCH=$nn A decide LC reviewer --focus rules+tests >/dev/null || die "a nonce naming an ancestor was refused"
  [ ! -e ".agents/local/dispatch/nonce-$nn" ] || die "the nonce survived its use"
  expect_msg "a replayed nonce was accepted" 'not called ahead of one' env PROOFLINE_DISPATCH=$nn sh ./.agents/scripts/agent.sh decide LC reviewer --focus rules+tests
  printf '1\n' > ".agents/local/dispatch/nonce-$nn"
  expect_msg "a nonce naming pid 1 was accepted" 'not called ahead of one' env PROOFLINE_DISPATCH=$nn sh ./.agents/scripts/agent.sh decide LC reviewer --focus rules+tests
  rm -f .agents/local/dispatch/nonce-*
  rm -f ".agents/runs/LC/decisions/$(ls .agents/runs/LC/decisions | tail -n 1)"
  # A171: friction-note ledgers that the user was asked to run a command; wait-line is one line
  A friction-note LC user-command >/dev/null || die "friction-note refused"
  grep -q 'event=friction-note .*detail=user-command' .agents/runs/LC/LEDGER.log || die "friction-note not in the ledger"
  A friction-note LC proofline_bug >/dev/null || die "A196 friction-note refused proofline_bug"
  grep -q 'event=friction-note .*detail=proofline_bug' .agents/runs/LC/LEDGER.log || die "A196 proofline_bug not in the ledger"
  expect_fail "friction-note took a free-text kind" A friction-note LC "run approve for me"
  expect_fail "a reviewer wrote a friction note" AS reviewer friction-note LC user-command
  wl=$(A wait-line LC "CI of the pull request") || die "wait-line refused"
  [ "$(printf '%s\n' "$wl" | wc -l | tr -d ' ')" = 1 ] && printf '%s\n' "$wl" | grep -Eq '^waiting: CI of the pull request, [0-9]+m[0-9]{2}s so far$' || die "wait-line is not one line of the documented shape: $wl"
  A wait-line LC "CI of the pull request" --done >/dev/null
  expect_fail "wait-line without a wait" A wait-line LC
  rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-1|blocking|impl.txt:1|wrong default|traced; scan: grep -n lookup impl.txt; instances: single'
  printf 'escalated=yes\n' >> .agents/runs/LC/decisions/001-reviewer-rules-tests.decision
  A decide LC reviewer --agent-path --focus rules+tests >/dev/null
  tail -1 "$STUB_ARGS" | grep -q -- '--signal recent_fail_same_focus --escalations-used 1' || die "signals/escalations: $(tail -1 "$STUB_ARGS")"
  # metrics: one line per recorded specialist step with runtime and model from the decision
  grep -q "$(printf '\tLC\treviewer\tclaude\tsonnet\t')" .agents/local/metrics/history.tsv || die "metrics line missing: $(cat .agents/local/metrics/history.tsv)"
  # A80: versioned JSON records; the step record carries the gate and result, tokens/turns stay null
  mj=.agents/local/metrics/records.jsonl
  grep -q '^{"schema":"proofline.metrics/1","kind":"step","time":"[0-9T:Z-]*","task":"LC","role":"reviewer","focus":"rules+tests"' "$mj" 2>/dev/null || die "step record missing/malformed: $(cat "$mj" 2>/dev/null)"
  grep '"kind":"step"' "$mj" | grep -q '"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null' || die "step record invented token/turn data: $(cat "$mj")"
  # a Claude subagent's step tokens come from its session log: one count per message id (the last line of it), cache reads excluded
  tr=$base/agent-t9.jsonl
  { printf '{"message":{"id":"msg_A","role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000,"output_tokens":3}}}\n'
    printf '{"message":{"id":"msg_A","role":"assistant","usage":{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000,"output_tokens":40}}}\n'
    printf '{"message":{"id":"msg_B","role":"assistant","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":6000,"output_tokens":10}}}\n'; } > "$tr"
  mkdir -p .agents/local/submissions; printf '%s\n' "$tr" > .agents/local/submissions/t9.started
  export PROOFLINE_STEP_AGENT=t9; rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-2|blocking|impl.txt:2|wrong default|traced; scan: grep -n lookup impl.txt; instances: single'; unset PROOFLINE_STEP_AGENT
  tail -1 "$mj" | grep -q '"kind":"step".*"tokens_in":103,"tokens_out":50,"tokens_total":153,' || die "step record without the subagent's session-log tokens: $(tail -1 "$mj")"
  # A200: a step is timed from the start of ITS attempt (marker line 2), not from the decision; a resumed subagent is not inflated
  printf '%s\n%s\n' "$tr" "$(( $(date +%s) - 40 ))" > .agents/local/submissions/t9.started
  export PROOFLINE_STEP_AGENT=t9; rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-3|blocking|impl.txt:3|wrong default|traced; scan: grep -n lookup impl.txt; instances: single'; unset PROOFLINE_STEP_AGENT
  ms_d=$(tail -1 "$mj" | sed -n 's/.*"duration_s":\([0-9]*\),.*/\1/p'); [ "${ms_d:-0}" -ge 40 ] && [ "${ms_d:-0}" -le 100 ] || die "step duration is not the time since the marker's start stamp (A200): $(tail -1 "$mj")"
  # the runtime of the record is the one dispatch.sh says really ran the step (after a failover it is not the decision's)
  PROOFLINE_DISPATCH_RUNTIME=codex PROOFLINE_DISPATCH_START=$(( $(date +%s) - 7 )) rec REVIEW_SMALL FAIL high 'REVIEW_SMALL-4|blocking|impl.txt:4|wrong default|traced; scan: grep -n lookup impl.txt; instances: single'
  tail -1 "$mj" | grep -q '"kind":"step".*"runtime":"codex".*"duration_s":\(7\|[12][0-9]\),' || die "step record does not carry the runtime that really ran the step and its attempt's time (A200): $(tail -1 "$mj")"
  grep -q "$(printf '\tLC\treviewer\tcodex\t')" .agents/local/metrics/history.tsv || die "history line does not carry the real runtime (A200)"
  # dispatch record: numbers kept, strings sanitized (no free text, so no secret), non-lead refused
  A metrics-dispatch LC reviewer rules claude 'sonnet"; sk-LIVE secret' 12 100 50 150 3 1 submitted >/dev/null
  tail -1 "$mj" | grep -q '"kind":"dispatch","time":"[0-9T:Z-]*","task":"LC","role":"reviewer","focus":"rules","gate":"REVIEW_RULES","runtime":"claude","model":"sonnetsk-LIVEsecret","duration_s":12,"tokens_in":100,"tokens_out":50,"tokens_total":150,"turns":3,"retries":1,"delegations":null,"fix_rounds":null,"result":"submitted"' || die "dispatch record shape: $(tail -1 "$mj")"
  A metrics-dispatch LC reviewer rules claude sonnet 12 '' '' '' abc 0 submitted >/dev/null
  tail -1 "$mj" | grep -q '"tokens_in":null,"tokens_out":null,"tokens_total":null,"turns":null,"retries":0' || die "absent/non-numeric usage must be null: $(tail -1 "$mj")"
  expect_fail "a reviewer wrote a metrics record" AS reviewer metrics-dispatch LC reviewer rules claude sonnet 1 - - - - 0 submitted
  sed 's/^metrics: on/metrics: off/' .agents/config.yaml > "$base/c.yaml"; cp "$base/c.yaml" .agents/config.yaml; rm -rf .agents/local/metrics
  mkdir -p .agents/runs/LC/reports/snapshots; printf '# e\n' > .agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_090-explorer.md
  printf 'ROLE: explorer\nTASK: LC\nRESULT: DONE\nCONFIDENCE: high\nFINGERPRINT: %s\nARTIFACT: reports/snapshots/aaaaaaaaaaaa-explorer-reports_090-explorer.md %s\n' "$(A fingerprint LC)" "$(tsha .agents/runs/LC/reports/snapshots/aaaaaaaaaaaa-explorer-reports_090-explorer.md)" > "$base/e.md"
  AS explorer record LC --file "$base/e.md" >/dev/null
  [ ! -e .agents/local/metrics/history.tsv ] || die "metrics: off still wrote metrics"
  A metrics-dispatch LC reviewer rules claude sonnet 1 1 1 2 1 0 submitted >/dev/null
  [ ! -e .agents/local/metrics/records.jsonl ] && [ -z "$(ls .agents/local/metrics 2>/dev/null)" ] || die "metrics: off still wrote records: $(ls .agents/local/metrics)"
  ok "decide: signals, overrides, escalations-used, persisted and ledgered; metrics on/off"
}

# Design surfaces: design_docs.design is a path (unchanged) or a mapping of surfaces with an optional shared base.
ds_cfg() { # ds_cfg SHARED(yes|no) EXTRA-SURFACE-LINES: rewrite the design line of the config
  DS_EXTRA="$2" awk -v sh="$1" '
    /^  design: / { print "  design:"; if (sh == "yes") print "    shared: docs/design/BASE.md"; print "    surfaces:";
      print "      site:"; print "        doc: docs/design/SITE.md"; print "        paths: apps/web/** apps/landing/"; print "        mode: persuade";
      print "      app:"; print "        doc: docs/design/APP.md"; print "        paths: apps/dashboard/**"; print "        mode: operate";
      if (ENVIRON["DS_EXTRA"] != "") print ENVIRON["DS_EXTRA"]; next }
    { print }' "$base/cfg.orig" > .agents/config.yaml
}
ds_val() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }
sc_design_surfaces() {
  new_repo
  cp .agents/config.yaml "$base/cfg.orig"
  # single document: unchanged
  out=$(A design-surface apps/web/a.tsx)
  [ "$(ds_val "$out" mode)" = single ] && [ "$(ds_val "$out" doc)" = docs/design/DESIGN.md ] && [ "$(ds_val "$out" doc_exists)" = no ] || die "single-document mode changed: $out"
  A in-knowledge-scope docs/design/DESIGN.md
  # two surfaces and a shared base
  ds_cfg yes ''
  A config-check >/dev/null
  mkdir -p docs/design; printf '# base\n' > docs/design/BASE.md
  out=$(A design-surface apps/web/pages/a.tsx)
  [ "$(ds_val "$out" surface)" = site ] && [ "$(ds_val "$out" doc)" = docs/design/SITE.md ] && [ "$(ds_val "$out" visitor_mode)" = persuade ] \
    && [ "$(ds_val "$out" shared)" = docs/design/BASE.md ] && [ "$(ds_val "$out" status)" = new-direction ] || die "site surface not selected as a new direction: $out"
  printf '# site\n' > docs/design/SITE.md
  [ "$(ds_val "$(A design-surface apps/landing/x.css)" status)" = ok ] || die "a directory-prefix glob did not match"
  out=$(A design-surface ./apps/dashboard/deep/b.tsx)
  [ "$(ds_val "$out" surface)" = app ] && [ "$(ds_val "$out" doc)" = docs/design/APP.md ] && [ "$(ds_val "$out" visitor_mode)" = operate ] || die "app surface not selected: $out"
  A in-knowledge-scope docs/design/SITE.md; A in-knowledge-scope docs/design/APP.md; A in-knowledge-scope docs/design/BASE.md
  expect_fail "a path outside every design document is knowledge scope" A in-knowledge-scope apps/web/a.tsx
  # no match: the shared document only; a warning without one
  out=$(A design-surface lib/util.js 2>&1)
  [ "$(ds_val "$out" status)" = no-surface ] && [ "$(ds_val "$out" shared)" = docs/design/BASE.md ] && [ "$(ds_val "$out" doc)" = - ] || die "no match did not fall to the shared document: $out"
  printf '%s' "$out" | grep -q '^warning' && die "a warning with a shared document: $out"
  ds_cfg no ''
  out=$(A design-surface lib/util.js 2>&1)
  printf '%s' "$out" | grep -Fq 'warning: no design surface matches lib/util.js' || die "no warning without a shared document: $out"
  # overlap is an error
  ds_cfg yes '      wide:
        doc: docs/design/WIDE.md
        paths: apps/web/pages/*'
  expect_msg "two matching surfaces were accepted" 'matches more than one surface (site wide)' A design-surface apps/web/pages/a.tsx
  [ "$(ds_val "$(A design-surface apps/dashboard/b.tsx)" surface)" = app ] || die "a file matching one surface failed beside an overlap elsewhere"
  # `**/` matches zero directories
  ds_cfg yes '      deep:
        doc: docs/design/DEEP.md
        paths: lib/**/x.ts'
  [ "$(ds_val "$(A design-surface lib/x.ts)" surface)" = deep ] && [ "$(ds_val "$(A design-surface lib/a/b/x.ts)" surface)" = deep ] || die "lib/**/x.ts does not match zero or more directories"
  [ "$(ds_val "$(A design-surface lib/xx.ts 2>/dev/null)" status)" = no-surface ] || die "lib/**/x.ts matched lib/xx.ts"
  # config-check
  ds_cfg yes '      broken:
        doc: docs/design/B.md'
  expect_msg "a surface without paths was accepted" 'design surface broken has no paths' A config-check
  ds_cfg yes ''; A config-check >/dev/null; cp .agents/config.yaml "$base/cfg.good"
  ds_bad() { # DESCRIPTION SED-EXPRESSION MESSAGE
    sed -e "$2" "$base/cfg.good" > "$base/bad.yaml"
    expect_msg "config-check accepted: $1" "$3" A config-check "$base/bad.yaml"
  }
  ds_bad "an absolute surface doc" 's#doc: docs/design/SITE.md#doc: /etc/site.md#' 'must be project-relative'
  ds_bad "a surface doc with .." 's#doc: docs/design/SITE.md#doc: ../site.md#' 'must be project-relative'
  ds_bad "an absolute path glob" 's#paths: apps/web/\*\* apps/landing/#paths: /apps/web/**#' 'must be project-relative globs'
  ds_bad "a path glob with .." 's#paths: apps/web/\*\* apps/landing/#paths: apps/../web#' 'must be project-relative globs'
  ds_bad "a backslash in paths" 's#paths: apps/web/\*\* apps/landing/#paths: apps\\web#' 'may not contain'
  ds_bad "two **/ in one glob" 's#paths: apps/web/\*\* apps/landing/#paths: a/**/b/**/c#' 'allows one **/ per glob'
  ds_bad "a pipe in paths" 's#paths: apps/web/\*\* apps/landing/#paths: apps/(a|b)#' 'may not contain'
  ds_bad "an absolute shared document" 's#shared: docs/design/BASE.md#shared: /etc/base.md#' 'design_docs.design.shared must be project-relative'
  ds_bad "a bad surface name" 's#^      site:#      si te:#' 'invalid surface name'
  ds_bad "a bad visitor mode" 's#mode: persuade#mode: Persuade#' 'visitor mode'
  awk '/^  design:/ { print; print "    shared: docs/design/BASE.md"; skip = 1; next } skip && /^    / { next } { skip = 0; print }' "$base/cfg.orig" > "$base/bad.yaml"
  expect_msg "a shared document without surfaces was accepted" 'design_docs.design.shared needs design_docs.design.surfaces' A config-check "$base/bad.yaml"
  ok "design surfaces: single document unchanged, surface selected, overlap errors, no match falls to the shared document"
}

sc_config_scope_misc() {
  new_repo
  A config-check >/dev/null
  [ "$(A config-get review.max_fix_rounds)" = 2 ] && [ "$(A config-get git.branch_prefix)" = proofline/ ]
  expect_fail "config-get of a missing key" A config-get no.such.key
  for edit in 's/^profile: balanced/profile: .*/' 's/^failover: auto/failover: a.*/' 's/^  claude_permission_mode: .*/  claude_permission_mode: yolo/' 's/^profile: balanced/profile: turbo/' 's/^failover: auto/failover: sometimes/' 's/^  max_fix_rounds: 2/  max_fix_rounds: two/' 's/^metrics: on/metrics: maybe/' 's/^  COMPLEX: supervised/  COMPLEX: lazy/' 's/^    opus: 3/    opus: 4/' 's/^  regression_pct: 10/  regression_pct: ten/' 's/^  profile: auto/  profile: loud/' 's/^  strictness: relaxed/  strictness: harsh/'; do
    sed "$edit" .agents/config.yaml > "$base/bad.yaml"
    expect_msg "config-check accepted: $edit" 'config invalid' A config-check "$base/bad.yaml"
  done
  { cat .agents/config.yaml; printf 'surprise: 1\n'; } > "$base/bad.yaml"
  expect_msg "config-check accepted an unknown top-level key" 'unknown top-level key: surprise' A config-check "$base/bad.yaml"
  # scope `new: true`
  unfrozen STANDARD
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: impl.txt.new' '    criteria: [AC-1]' '---' '# Plan' '' '## Assumptions' 'none' '' '## Behavior' 'unchanged' > .agents/runs/LC/PLAN.md
  expect_msg "a missing path without new: true" 'does not exist' A freeze LC
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '    new: true' '---' '# Plan' '' '## Assumptions' 'none' '' '## Behavior' 'unchanged' > .agents/runs/LC/PLAN.md
  expect_msg "an existing path marked new: true" 'already exists' A freeze LC
  printf '%s\n' '---' 'scope:' '  - path: impl.txt' '    criteria: [AC-1]' '  - path: src/new.txt' '    criteria: [AC-1]' '    new: true' '---' '# Plan' '' '## Assumptions' 'none' '' '## Behavior' 'unchanged' > .agents/runs/LC/PLAN.md
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
  approve_as_user waive:VERIFY-1 'approve VERIFY-1'
  grep -q '^bound: "[0-9]*-VERIFY.yaml@[0-9a-f]*#VERIFY-1"' .agents/runs/LC/approvals/*-waive-VERIFY-1.yaml || die "the waiver approval is not bound to the gate record"
  A handoff LC IMPLEMENTING >/dev/null; worker FIX pass impl.txt 'impl: fix attempt'; A handoff LC IMPLEMENTED >/dev/null
  rec VERIFY FAIL high 'VERIFY-1|blocking|impl.txt:2|different problem: data loss on concurrent write|traced'
  expect_msg "a round-1 approval waived round 2's VERIFY-1" "needs the user's approval" A waive LC VERIFY-1 --reason 'the user approved waiving VERIFY-1 earlier on'
  ok "waiver approvals bind the failing gate record and finding; a later round never reuses them"
}

# A130: the report names the finding ids of every required gate (info rows included); 'none' only for a gate with no rows.
sc_report_finding_ids() {
  scaffold orchestrated; implemented orchestrated
  rg=$(required | tr ' ' '\n' | grep '^REVIEW_' | head -1)
  for g in $(required); do
    case "$g" in
      SECRETS) A secret-scan LC >/dev/null ;;
      "$rg") mkdir -p ".agents/runs/LC/$(dirname "$(report_path "$rg")")"; printf '# review\n\nthe change was read.\n' > ".agents/runs/LC/$(report_path "$rg")"
        printf 'info|impl.txt:1|naming is terse but consistent across the module|read\n' > "$base/ir.rows"
        AS reviewer submit LC --focus "$(gate_focus "$rg")" --artifact "$(report_path "$rg")" --findings "$base/ir.rows" --confidence high >/dev/null || die "the info-row review was refused" ;;
      *) gpass "$g" ;;
    esac
  done
  A pipeline LC | sed -n 's/^focus\.\([A-Z_]*\)\.\([a-z]*\)=.*/\1 \2/p' | while read -r g f; do RF_FOCUS=$f gpass "$g"; done
  A handoff LC CODE_DONE >/dev/null; A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  nr="$rg:$(gate_focus "$rg")"
  # every miss at once: the not-reproduced line AND the ids, with the line to add
  write_report '' "$rg: none."
  out=$(A publish-completion-report LC markdown 2>&1) && die "a report with none for a gate with info rows was published"
  printf '%s' "$out" | grep -q "add the line '- $nr: not reproduced (NOT_RERUN)'" || die "no not-reproduced line to add: $out"
  printf '%s' "$out" | grep -q "gate $rg: name the finding id(s) $rg-1 $rg-2" || die "the missing ids are not all named: $out"
  # next lists what the report must carry
  A next LC | grep -q "gate $rg findings to name.*$rg-1 $rg-2" || die "next does not list the finding ids"
  A next LC | grep -q "NOT_RERUN $nr: not reproduced proof" || die "next does not list the not-reproduced line"
  # the id of a gate is not named by a line that only has it inside another list (QA-1 in 'scenarios QA-1 to QA-9')
  write_report '' "scenarios $rg-1 to $rg-9 passed; $rg-2 too." "- $nr: not reproduced (NOT_RERUN)"
  expect_msg "an id inside a list that does not name the gate" "gate $rg: name the finding id(s) $rg-1 $rg-2" A publish-completion-report LC markdown
  write_report '' "$rg: $rg-1 (info): naming is terse but consistent, no change needed; $rg-2 (info): no validator ran."
  expect_msg "a re-run-nothing gate without its own not reproduced line" "add the line '- $nr: not reproduced (NOT_RERUN)'" A publish-completion-report LC markdown
  write_report '' "$rg: $rg-1, $rg-2 (info) noted. $nr was reproduced by the control plane." "- $nr: not reproduced (NOT_RERUN)"
  expect_msg "a re-run-nothing gate described as reproduced" 'calls it reproduced: "' A publish-completion-report LC markdown
  write_report '' "$rg: $rg-1 (info): naming is terse but consistent, no change needed; $rg-2 (info): no validator ran." "- $nr: not reproduced (NOT_RERUN)"
  A publish-completion-report LC markdown >/dev/null || die "a report naming the finding id and the not reproduced line was refused"
  ok "A130: the completion report names every finding id of every gate; none is refused for a gate with an info row"
}

# A143 (C-22): counts and statuses in the completion report come from the records; publish appends the Facts block and
# refuses numbers beside tests, gates, fix rounds and refreezes that are not the recorded ones.
sc_report_facts() {
  scaffold orchestrated; to_code_done orchestrated
  A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  ng=$(required | wc -w | tr -d ' ')
  facts=$(A report-facts LC)
  for want in "- Required gates: $ng" '- Fix rounds: 0 of 2' '- Refreezes: 0' '- Files changed (task-owned paths): 2' '- Worker-evidence run records: total 2, ended pass 1, ended fail 1' '- Gate VERIFY: pass; findings: none'; do
    printf '%s\n' "$facts" | grep -Fq -- "$want" || die "Facts block lacks '$want': $facts"
  done
  write_report '' 'We ran 9 tests and all of them pass.'
  expect_msg "a wrong test count was published" '"9 tests" (recorded: worker-evidence run records: total 2, ended pass 1, ended fail 1;' A publish-completion-report LC markdown
  write_report '' "Tests: 40 passed."
  expect_msg "a wrong 'tests: N' count was published" '"40 tests"' A publish-completion-report LC markdown
  write_report '' "All $((ng + 3)) required gates passed."
  expect_msg "a wrong gate count was published" "\"$((ng + 3)) gates\" (recorded: required gates $ng)" A publish-completion-report LC markdown
  write_report '' 'The change needed 1 fix round.'
  expect_msg "a wrong fix-round count was published" '"1 fix rounds" (recorded: used 0, maximum 2)' A publish-completion-report LC markdown
  write_report '' 'The plan had 1 refreeze.'
  expect_msg "a wrong refreeze count was published" '"1 refreezes"' A publish-completion-report LC markdown
  write_report '' 'Five regression tests cover the lookup.'
  expect_msg "a number word beside tests was published" '"5 tests"' A publish-completion-report LC markdown
  write_report '' 'All Twelve gates passed.'
  expect_msg "a number word beside gates was published" '"12 gates"' A publish-completion-report LC markdown
  # words without numbers, ids with digits, fenced output and the recorded numbers are fine; a hand-written block is replaced
  write_report '' "AC-1 tests: the lookup test passes. $ng gates passed, 0 fix rounds, 0 refreezes, 2 test runs recorded, one test run ended in a failure as planned (RED)." \
    'Step 3 tests the lookup. The 3 test files are small; 0 tests failed.' \
    '```' '# tests 99' '```' '' '<!-- proofline:facts:begin -->' '- Required gates: 99' '<!-- proofline:facts:end -->'
  A publish-completion-report LC markdown >/dev/null || die "a report with the recorded numbers was refused"
  rep=.agents/runs/LC/COMPLETION_REPORT.md
  [ "$(grep -c 'proofline:facts:begin' "$rep")" = 1 ] || die "the report holds $(grep -c 'proofline:facts:begin' "$rep") Facts blocks"
  ! grep -Fq -- '- Required gates: 99' "$rep" || die "a hand-written Facts block survived"
  sed -n '/proofline:facts:begin/,/proofline:facts:end/p' "$rep" > "$base/facts.published"
  [ "$(cat "$base/facts.published")" = "$facts" ] || die "the published Facts block differs from the records read before publishing"
  ok "A143: the completion report's numbers must be the recorded ones; publish appends the Facts block generated from the records"
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
  mkdir -p docs/design; printf 'token: PLANTED_SECRET\n' > docs/design/DESIGN.md
  expect_msg "A200: knowledge-done over a secret in a knowledge file" 'found secrets' A knowledge-done LC
  printf 'design notes\n' > docs/design/DESIGN.md; A knowledge-done LC >/dev/null; write_report; A publish-completion-report LC markdown >/dev/null
  printf 'token: PLANTED_SECRET\n' > docs/design/DESIGN.md   # written after the knowledge step: DONE and delivery still scan
  expect_msg "delivery-check over a secret in a knowledge file" 'found secrets' A delivery-check LC
  expect_msg "DONE over a secret in a knowledge file" 'found secrets' A handoff LC DONE
  printf 'design notes\n' > docs/design/DESIGN.md
  A handoff LC DONE >/dev/null
  ok "knowledge-scope files are secret-scanned at DONE and delivery-check"
}

# A139: docs/wiki/ is in the default knowledge_scope_root: a wiki page is knowledge work, any other path is not.
sc_wiki_knowledge_scope() {
  scaffold orchestrated; to_code_done orchestrated
  A config-get knowledge_scope_root | grep -Fq 'docs/wiki/' || die "docs/wiki/ is not in the default knowledge_scope_root"
  A config-get knowledge_scope_root | grep -Fq 'docs/product/' || die "docs/product/ is not in the default knowledge_scope_root"
  mkdir -p notes; printf 'not a wiki page\n' > notes/outside.txt
  expect_msg "a path outside the root counted as knowledge" 'no knowledge page was written' A knowledge-done LC
  rm -r notes
  mkdir -p docs/wiki/concepts; printf -- '---\ntitle: retry-policy\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Retry policy\n' > docs/wiki/concepts/retry-policy.md
  mkdir -p .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/   # the lint must be installed or knowledge-done refuses
  A knowledge-done LC >/dev/null
  A verify-knowledge-scope LC >/dev/null
  ok "a path under docs/wiki/ is knowledge scope; a path outside stays implementation scope"
}

# A200: knowledge-done is not accepted before the page is written and the wiki lint ran and passed
sc_knowledge_done_needs_page_and_lint() {
  scaffold orchestrated; to_code_done orchestrated
  expect_msg "A200: knowledge-done with no page written" 'no knowledge page was written' A knowledge-done LC
  mkdir -p docs/wiki
  printf -- '---\ntitle: good page\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Good\n' > docs/wiki/good.md
  expect_msg "A200: knowledge-done with the llm-wiki lint script missing refuses" 'validate-wiki.mjs is missing' A knowledge-done LC
  rm -f docs/wiki/good.md
  mkdir -p .agents/skills/llm-wiki/scripts
  cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/
  printf -- '---\ntitle: bad page\nstatus: current\n---\n\n# No source\n' > docs/wiki/bad.md
  expect_msg "A200: knowledge-done over a wiki page the lint rejects" 'wiki lint of docs/wiki found errors' A knowledge-done LC
  ! grep -q 'knowledge_state: "\{0,1\}KNOWLEDGE_DONE' .agents/runs/LC/RUN.yaml || die "a refused knowledge-done recorded the state"
  printf -- '---\ntitle: good page\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Good\n' > docs/wiki/bad.md
  A knowledge-done LC >/dev/null || die "knowledge-done refused a wiki page that passes the lint: $(A knowledge-done LC 2>&1 | tail -3)"
  # A200: the proofline_bug friction note is reminded by next (report step) and counted in the report's Facts
  A next LC | grep -q '^note=FRICTION (A200): .*proofline_bug notes so far: 0)' || die "next does not remind of the friction note: $(A next LC)"
  A friction-note LC proofline_bug >/dev/null
  A next LC | grep -q 'proofline_bug notes so far: 1)' || die "next does not count the note: $(A next LC)"
  A report-facts LC | grep -Fq 'Friction notes recorded (A200): proofline_bug 1, user-command 0, user-shell 0' || die "the Facts block does not count the friction notes: $(A report-facts LC)"
  ok "A200: knowledge-done needs a written page and a wiki lint it ran itself without errors"
}

# A171: the files the knowledge step writes (knowledge_scope_root, design_docs) are not part of the content fingerprint
# the gates bind, so recorded gates stay fresh after the step.
sc_knowledge_gates_fresh() {
  scaffold orchestrated; to_code_done orchestrated
  before=$(A pipeline LC | grep '^gate\.')
  printf '%s\n' "$before" | grep -q 'gate\.[A-Z_]*=\(stale\|missing\|fail\)' && die "gates are not fresh before the knowledge step: $before"
  mkdir -p docs/wiki/concepts docs/design docs/adr docs/product; printf -- '---\ntitle: retry-policy\nstatus: current\nsource: docs/design/DESIGN.md\n---\n\n# Retry policy\n' > docs/wiki/concepts/retry-policy.md
  mkdir -p .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/   # the lint must be installed or knowledge-done refuses
  printf '# Design\n' > docs/design/DESIGN.md; printf '# ADR 1\n' > docs/adr/0001-x.md; printf '# PRD\n' > docs/product/PRD.md
  A knowledge-done LC >/dev/null
  after=$(A pipeline LC | grep '^gate\.')
  [ "$before" = "$after" ] || die "the knowledge step's files changed the gate statuses: before [$before] after [$after]"
  A delivery-check LC >/dev/null 2>&1 || :
  A pipeline LC | grep '^gate\.' | grep -q '=stale' && die "a gate went stale after the knowledge step"
  ok "gates do not go stale after the knowledge step writes its files"
}
# A171: design-sync drift in a knowledge-scope document is information for the verifier (no FAIL, no waiver, no scope
# change) and an obligation of the knowledge step; knowledge-done and delivery block while the drift remains.
sc_knowledge_drift() {
  evidence_gap_fixture
  cp -R "$tl_agents/../../skills/design-sync" .agents/skills/design-sync
  mkdir -p docs/design "$d/design"; printf '# Design\n\nThe widget lives in `src/missing.js`.\n' > docs/design/DESIGN.md; printf 'docs/\n' >> .git/info/exclude
  printf '%s\n' '# Design sync: LC' '' 'Verdict: FAIL' '' '## Documents' '' '| Role | Path | Present |' '|---|---|---|' '| design | docs/design/DESIGN.md | yes |' '' '## Counts' '' 'matched: 0, unmatched (after review): 1, unverifiable: 0' '' '## Drift' '' '- docs/design/DESIGN.md:3 -> path src/missing.js: no such file or directory' '' '## Unverifiable' '' 'None.' > "$d/design/SYNC.md"
  vw PASS 0 'ok 3 tests' PASS
  sed -i.bak 's|^design-sync: SKIPPED.*|design-sync: PASS (knowledge-scope drift: 1 line handed to the knowledge step)|' "$d/VERIFY.md"; rm -f "$d/VERIFY.md.bak"
  # a drift row on a code path stays blocking; the same row on a knowledge-scope document is information
  printf 'blocking|src/app.js:4|D-2: design-sync drift: route GET /x not found|design-sync exit=1\n' > "$base/rows"
  expect_msg "a drift row on a code path was not blocking" 'contradicts' AS verifier submit LC --confidence high --result PASS --findings "$base/rows" --agent kd0
  printf 'blocking|docs/design/DESIGN.md:3|D-1: design-sync drift: path src/missing.js not found|design-sync exit=1\n' > "$base/rows"
  out=$(AS verifier submit LC --confidence high --findings "$base/rows" --agent kd1 2>&1) || die "knowledge-scope drift failed the verifier: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier PASS' || die "knowledge-scope drift was not information: $out"
  grep -rq 'info.*KNOWLEDGE_DRIFT: D-1: design-sync drift' "$d/results" "$d/reports" 2>/dev/null || grep -rq 'KNOWLEDGE_DRIFT' "$d" || die "the drift row was not recorded as KNOWLEDGE_DRIFT information"
  pass_all; A handoff LC CODE_DONE >/dev/null || die "CODE_DONE refused: $(A handoff LC CODE_DONE 2>&1)"
  sed -i.bak '/^docs\/$/d' .git/info/exclude; rm -f .git/info/exclude.bak   # the knowledge step's files are visible from here on
  # before the knowledge step the drift is information in next
  A next LC | grep -q 'note=design-sync drift in knowledge-scope documents' || die "next does not show the drift as information: $(A next LC)"
  # after the knowledge step it still drifts: blocked, nothing to waive
  expect_msg "knowledge-done with drift left" 'design-sync drift in knowledge-scope documents is still there' A knowledge-done LC
  expect_state execution knowledge_state not_started
  # the knowledge step fixes the document: both pass
  printf '# Design\n\nThe widget lives in `impl.txt`.\n' > docs/design/DESIGN.md
  A knowledge-done LC >/dev/null || die "knowledge-done refused after the document was fixed: $(A knowledge-done LC 2>&1)"
  expect_state execution knowledge_state KNOWLEDGE_DONE
  printf '# Design\n\nThe widget lives in `src/missing.js`.\n' > docs/design/DESIGN.md
  expect_msg "delivery with the drift back" 'design-sync drift in knowledge-scope documents is still there' A delivery-check LC
  ok "design-sync drift in knowledge-scope documents is information before the knowledge step and blocks knowledge-done and delivery after it"
}
# A159: `knowledge-done not_applicable` is a claim the script checks: a reason is required, it is shown in the report,
# and a task that changes what the user sees, a contract or a design document is refused.
sc_knowledge_na() {
  scaffold orchestrated; to_code_done orchestrated
  expect_msg "not_applicable without a reason was accepted" 'needs a reason' A knowledge-done LC not_applicable
  expect_msg "not_applicable with an empty reason was accepted" 'needs a reason' A knowledge-done LC not_applicable ""
  expect_state execution knowledge_state not_started
  A knowledge-done LC not_applicable "only an internal lookup fixture changed, no wiki page or design document describes it" >/dev/null
  expect_state execution knowledge_state not_applicable
  A report-facts LC | grep -Fq 'Knowledge step: not_applicable; not_applicable reason: only an internal lookup fixture changed' || die "the Facts block does not show the reason: $(A report-facts LC)"
  write_report; A publish-completion-report LC markdown >/dev/null
  grep -Fq 'not_applicable reason: only an internal lookup fixture changed' .agents/runs/LC/COMPLETION_REPORT.md || die "the published report does not show the reason"
  ok "not_applicable needs a reason; the reason is recorded and shown in the published report"
  # user-visible behaviour in the acceptance criteria
  SC_TASK_EXTRA='- AC-2: the lookup command prints the stored value' scaffold orchestrated; to_code_done orchestrated
  expect_msg "not_applicable accepted for a task that changes a command" 'user-visible behaviour' A knowledge-done LC not_applicable "only an internal lookup fixture changed, no wiki page or design document describes it"
  expect_state execution knowledge_state not_started
  # a contract in the frozen plan
  SC_PLAN_EXTRA='## Contracts
- lookup returns nil for an empty key' scaffold orchestrated; to_code_done orchestrated
  expect_msg "not_applicable accepted for a task with a contract change" 'contract' A knowledge-done LC not_applicable "only an internal lookup fixture changed, no wiki page or design document describes it"
  # a design document changed by the task
  SC_SCOPE_NAMED=docs/design/DESIGN.md scaffold standalone; printf 'new section\n' >> docs/design/DESIGN.md; to_code_done standalone
  expect_msg "not_applicable accepted for a task that changed a design document" 'documentation path' A knowledge-done LC not_applicable "only an internal lookup fixture changed, no wiki page or design document describes it"
  # the step must write a page (A200) and the lint must be installed; the design document the task changed is plan scope, not a knowledge page
  mkdir -p docs/wiki .agents/skills/llm-wiki/scripts; cp "$tl_agents/../../skills/llm-wiki/scripts/validate-wiki.mjs" .agents/skills/llm-wiki/scripts/
  printf -- '---\ntitle: lookup\nstatus: current\nsource: .agents/config.yaml\n---\n\n# Lookup\n' > docs/wiki/lookup.md
  A knowledge-done LC >/dev/null; expect_state execution knowledge_state KNOWLEDGE_DONE
  ok "not_applicable is refused for AC words, a contract and a design-document change; the real knowledge step still records"
  # a run from before 0.0.17 has no execution.knowledge_reason key: not_applicable is refused and nothing is recorded
  scaffold orchestrated; to_code_done orchestrated
  grep -q '^ *knowledge_reason:' .agents/runs/LC/RUN.yaml || die "the fixture has no knowledge_reason line to delete"
  sed '/^ *knowledge_reason:/d' .agents/runs/LC/RUN.yaml > "$base/run.nokr"; cp "$base/run.nokr" .agents/runs/LC/RUN.yaml
  ! grep -q 'knowledge_reason' .agents/runs/LC/RUN.yaml || die "the knowledge_reason line was not removed"
  expect_msg "not_applicable accepted on a run without knowledge_reason" 'predates 0.0.17' A knowledge-done LC not_applicable "only an internal lookup fixture changed, no wiki page or design document describes it"
  expect_state execution knowledge_state not_started
  # a # in the reason would end the YAML value as a comment
  scaffold orchestrated; to_code_done orchestrated
  expect_msg "not_applicable accepted with a # in the reason" 'must not contain' A knowledge-done LC not_applicable "only an internal lookup fixture changed, see issue #12 for the details of it"
  expect_state execution knowledge_state not_started
  ok "not_applicable is refused on a run without knowledge_reason and for a # in the reason; nothing is recorded"
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
# A202: the task type is an input of the gates: a bug needs the debug-proof result without any label and is never TRIVIAL; a typeless task is a
# feature; a content or docs task has the test-first exemption by default, with the reason written in the plan, but never for a path that holds code.
sc_task_types() {
  SC_TASK_FM='type: bug' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  [ "$(A task-type .agents/runs/LC/TASK.md)" = bug ] || die "task-type did not read type: bug"
  expect_msg "type: bug needs a debug-proof result" 'no debug-proof result' A handoff LC IMPLEMENTED
  expect_msg "a bug was classified TRIVIAL" 'TRIVIAL covers text and configuration only' A classify LC TRIVIAL
  mkdir -p .agents/runs/LC/reports; printf '# debug\n\nreproduction, root cause, regression test\n' > .agents/runs/LC/reports/001-debug.md
  A handoff LC IMPLEMENTED >/dev/null || die "a debug-proof result did not unblock a bug task"
  SC_TASK_FM='type: feature' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "a feature needed a debug-proof result: $(A handoff LC IMPLEMENTED 2>&1)"
  scaffold orchestrated no STANDARD
  [ "$(A task-type .agents/runs/LC/TASK.md)" = feature ] || die "a typeless task is not a feature"
  ok "A202: type bug asks for the debug-proof result and refuses TRIVIAL; a feature and a typeless task do not"
  # content: a document path with its reason freezes; the same task type never exempts a path that holds code
  SC_TASK_FM='type: content' SC_SCOPE_NAMED=docs/guide.md scaffold orchestrated no STANDARD
  SC_TASK_FM='type: docs' SC_SCOPE_NAMED=src/app.js scaffold orchestrated no STANDARD supervised
  expect_msg "a docs task exempted a path that holds code" 'holds code and is never exempt' A freeze LC
  SC_TASK_FM='type: content' SC_SCOPE_NAMED=docs/guide.md scaffold orchestrated no STANDARD supervised
  sed -i.bak '/tdd_exemption/d' .agents/runs/LC/PLAN.md
  expect_msg "a content task froze a document path without the reason in the plan" 'exempts document paths from test-first by default' A freeze LC
  SC_TASK_FM='type: feature' SC_SCOPE_NAMED=src/app.js scaffold orchestrated no STANDARD
  ok "A202: content and docs exempt document paths with the reason in the plan, never a path that holds code"
}
sc_debug_result() {
  # A200: the trigger is the task type or label, never the words "fix" or "duzelt" in prose.
  SC_TASK_EXTRA='
## Suggested class

STANDARD — behavioural bug fix in one module with tests.' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  expect_msg "a bug named in Suggested class needs a debug-proof result" 'no debug-proof result' A handoff LC IMPLEMENTED
  mkdir -p .agents/runs/LC/reports; printf '# debug\n\nreproduction, root cause, regression test\n' > .agents/runs/LC/reports/001-debug.md
  A handoff LC IMPLEMENTED >/dev/null || die "a debug-proof result did not unblock IMPLEMENTED"
  ok "a bug named in Suggested class needs reports/NNN-debug.md, which unblocks IMPLEMENTED"
  # a defect word in the Suggested class prose is not a defect task ("its own step drops nothing")
  SC_TASK_EXTRA='
## Suggested class

STANDARD — the first step is additive and its own step drops nothing.' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "a defect word in Suggested class prose blocked a task that is not a defect fix: $(A handoff LC IMPLEMENTED 2>&1)"
  ok "a defect word inside Suggested class prose does not make a task a defect fix"
  # a label or type makes it a defect task: a Labels section, a Type line
  SC_TASK_EXTRA='
## Labels

- bug
- backend' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  expect_msg "a bug label needs a debug-proof result" 'no debug-proof result' A handoff LC IMPLEMENTED
  SC_TASK_EXTRA='
**Type:** defect' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  expect_msg "a defect type line needs a debug-proof result" 'no debug-proof result' A handoff LC IMPLEMENTED
  ok "A200: a bug or defect label or type asks for reports/NNN-debug.md"
  # the words fix, fixes, fixed, duzelt, defect or error in the prose, the Goal, a criterion or the user's quote never ask
  SC_TASK_EXTRA='
## Goal

Fix the page count: the last page is cut off, an error in the page count.

## Context

> Sayfa sayisini duzelt. Kitaplarimdan bazilari kayboldu, hata var.

The page count is wrong today and has a defect.

## Acceptance criteria

- AC-1: the page count is fixed.' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "A200: fix words in the prose asked an unlabelled task for a debug report: $(A handoff LC IMPLEMENTED 2>&1)"
  ok "A200: fix, defect and Turkish fix words in the prose do not ask for a debug-proof result"
  # a feature run with an ordinary assertion RED is not asked either (A122 guard)
  SC_TASK_EXTRA='' scaffold orchestrated no STANDARD
  WEV_EF='lookup returns null instead of 5' worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "a feature RED with actual-vs-expected text was blocked: $(A handoff LC IMPLEMENTED 2>&1)"
  # a declared pre-existing defect with decision: report stays a finding
  SC_TASK_EXTRA='
## Context

### Pre-existing defects

- `src/service.js:paginate`: totalPages uses Math.floor -- decision: report' scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null || die "a declared pre-existing defect (report) asked a feature task for a debug report: $(A handoff LC IMPLEMENTED 2>&1)"
  # decision: fix is a requested fix
  SC_TASK_EXTRA='
## Context

### Pre-existing defects

- `src/service.js:paginate`: totalPages rounds down -- decision: fix' scaffold orchestrated no STANDARD manual
  approve_as_user scope 'approve the scope'; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  expect_msg "a declared defect with decision: fix needs a debug-proof result" 'no debug-proof result' A handoff LC IMPLEMENTED
  ok "A200: a declared decision: report is no trigger; decision: fix still is"
}
sc_scratch_worktrees() {
  scaffold orchestrated no STANDARD
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all
  # A169: the worktree of another run (here under $TMPDIR, like the whole fixture) is the project's own, never scratch
  rw=$(A worktree-add RW-1) || die "worktree-add: $rw"
  wt=$(mktemp -d "${TMPDIR:-/tmp}/scratch-wt.XXXXXX"); rmdir "$wt"
  git worktree add -q --detach "$wt" HEAD
  expect_msg "a scratch worktree still registered blocks CODE_DONE" 'scratch git worktrees' A handoff LC CODE_DONE
  A handoff LC CODE_DONE 2>&1 | grep -F "$rw" && die "the run worktree $rw was named as scratch"
  git worktree remove --force "$wt"
  A handoff LC CODE_DONE >/dev/null || die "CODE_DONE refused after the scratch worktree was removed (the run worktree RW-1 must not count): $(A handoff LC CODE_DONE 2>&1)"
  ok "scratch worktrees must be removed before CODE_DONE; the worktree of another run is not scratch (A169)"
}
sc_worktree_lock_folder() {
  # A196, A199: a command in a run worktree takes its locks from .agents/local/locks (its own and the main tree's); those folders alone are writable for a
  # Codex worker, so the command must work with the rest of both .agents/local folders read-only
  scaffold orchestrated no STANDARD
  rw=$(A worktree-add RW-1) || die "worktree-add: $rw"
  rwp=$(printf '%s\n' "$rw" | grep -o '/[^ ]*worktrees/RW-1' | head -n 1); [ -d "$rwp" ] || rwp=$PWD/.agents/local/worktrees/RW-1
  [ -d "$rwp" ] || die "A196 the run worktree was not found in: $rw"
  mkdir -p "$rwp/.agents/runs" && cp -R .agents/runs/LC "$rwp/.agents/runs/LC"
  mkdir -p .agents/local/locks .agents/local/approvals .agents/local/prompts "$rwp/.agents/local/locks"
  chmod a-w .agents/local .agents/local/approvals .agents/local/prompts "$rwp/.agents/local"
  rc=0; out=$(cd "$rwp" && AGENT_ROLE='' sh .agents/scripts/agent.sh ledger-note LC "A196 note" 2>&1) || rc=$?
  chmod u+w .agents/local .agents/local/approvals .agents/local/prompts "$rwp/.agents/local"
  [ "$rc" = 0 ] || die "A196 the worktree command failed with the rest of .agents/local read-only: $out"
  if [ "$(id -u)" != 0 ]; then
    echo "$out" | grep -q 'cannot take the lock' && die "A196 the worktree command could not take the shared lock with the rest of .agents/local read-only: $out"
    ( chmod a-w .agents/local .agents/local/approvals .agents/local/prompts
      if ( : > .agents/local/approvals/forged ) 2>/dev/null || ( : > .agents/local/prompts/forged ) 2>/dev/null || ( mkdir .agents/local/windows-forged ) 2>/dev/null; then chmod u+w .agents/local .agents/local/approvals .agents/local/prompts; exit 1; fi
      chmod u+w .agents/local .agents/local/approvals .agents/local/prompts ) || die "A196 approvals, prompts or .agents/local were writable although only locks/ is granted"
  fi
  ls .agents/local/locks/shared.lock >/dev/null 2>&1 && die "A196 the shared lock was left behind"
  # an older version's lock in the main tree, held by a live process, is waited for (read-only) and never removed
  sleep 30 & holder=$!
  mkdir .agents/local/.lock && printf '%s\n' "$holder" > .agents/local/.lock/pid
  t0=$(date +%s)
  ( sleep 2; kill "$holder" 2>/dev/null ) &
  (cd "$rwp" && AGENT_ROLE='' PROOFLINE_LOCK_TIMEOUT=20 sh .agents/scripts/agent.sh ledger-note LC "A196 after the old lock" >/dev/null 2>&1) || :
  waited=$(( $(date +%s) - t0 ))
  rm -rf .agents/local/.lock
  [ "$waited" -ge 2 ] || die "A196 a worktree command did not wait for the live holder of the old main-tree lock (waited ${waited}s)"
  ok "A196 a worktree command takes the shared lock from locks/ alone, cannot write approvals or prompts there, and waits for an older version's lock"
}
sc_doc_scope_warning() {
  # A197: a document path in scope without tdd_exemption is a one-line warning at freeze, not a stop; with the exemption there is no warning
  unfrozen STANDARD
  awk '{ print } /^scope:$/ { print "  - path: docs/design/DESIGN.md"; print "    new: true"; print "    criteria: [AC-1]" }' .agents/runs/LC/PLAN.md > "$base/plan.tmp" && mv "$base/plan.tmp" .agents/runs/LC/PLAN.md
  out=$(A freeze LC 2>&1) || die "A197 a document path without tdd_exemption stopped the freeze: $out"
  printf '%s' "$out" | grep -q 'warning: PLAN.md scope has document path(s) without tdd_exemption: docs/design/DESIGN.md' || die "A197 no warning for the document path: $out"
  printf '%s' "$out" | grep -q 'design-sync' || die "A197 the warning does not suggest the proof: $out"
  [ "$(printf '%s\n' "$out" | grep -c 'without tdd_exemption')" = 1 ] || die "A197 the warning is not one line: $out"
  unfrozen STANDARD
  awk '{ print } /^scope:$/ { print "  - path: docs/design/DESIGN.md"; print "    new: true"; print "    criteria: [AC-1]"; print "    tdd_exemption: \"design document, checked by design-sync instead of a failing test\"" }' .agents/runs/LC/PLAN.md > "$base/plan.tmp" && mv "$base/plan.tmp" .agents/runs/LC/PLAN.md
  out=$(A freeze LC 2>&1) || die "A197 the freeze failed with the exemption: $out"
  ! printf '%s' "$out" | grep -q 'without tdd_exemption' || die "A197 a warning although the path has an exemption: $out"
  ok "A197 freeze warns once about a document path without tdd_exemption and stays quiet with it"
}
# A200 (item 5): after a fix round only the gates whose inputs changed run again. A test-only fix keeps REVIEW_PLAN, REVIEW_RULES and
# SECURITY; a changed test that covers security behavior, or any product-code change, runs them again; SECRETS and VERIFY always run.
sc_selective_rerun() {
  for variant in tests_only security_test product_code; do
    scaffold orchestrated no CRITICAL
    worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
    A handoff LC IMPLEMENTED >/dev/null
    [ "$(gates_of | tr ' ' '\n' | grep -c .)" -ge 6 ] || die "A200 the run is not full tier: $(gates_of)"
    pass_all
    rec REVIEW_TESTS FAIL high "REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil"
    A handoff LC IMPLEMENTING >/dev/null
    case "$variant" in
      tests_only) worker FIX pass impl_test.txt 'test: lookup of a missing key is nil' ;;
      security_test) worker FIX pass impl_test.txt 'test: an expired token is rejected' ;;
      product_code) worker FIX pass impl.txt 'impl: lookup of a missing key is nil' ;;
    esac
    A handoff LC IMPLEMENTED >/dev/null
    for g in REVIEW_PLAN REVIEW_RULES SECURITY; do
      st=$(gate_st "$g")
      case "$variant:$g" in
        tests_only:*) [ "$st" = pass ] || die "A200 $variant: $g is $st, a test-only fix must keep it" ;;
        security_test:SECURITY|product_code:*) [ "$st" != pass ] || die "A200 $variant: $g still pass although its inputs changed" ;;
        security_test:*) [ "$st" = pass ] || die "A200 $variant: $g is $st" ;;
      esac
    done
    for g in SECRETS REVIEW_TESTS VERIFY; do
      [ "$(gate_st "$g")" != pass ] || die "A200 $variant: $g carried over; it always runs"
    done
  done
  ok "A200 a test-only fix keeps REVIEW_PLAN/RULES/SECURITY; security tests and product code rerun them; SECRETS, REVIEW_TESTS and VERIFY always run"
}

# A200 (item 5): an `amend` carries the passes of REVIEW_PLAN, REVIEW_RULES and SECURITY under the same input rules as a fix round; a plan change,
# product code and a security-related test rerun them; SECRETS, REVIEW_TESTS and VERIFY always run.
sc_amend_carry() {
  for variant in tests_only security_test product_code plan_change; do
    scaffold orchestrated no CRITICAL
    worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
    A handoff LC IMPLEMENTED >/dev/null
    [ "$(gates_of | tr ' ' '\n' | grep -c .)" -ge 6 ] || die "A200 amend: the run is not full tier: $(gates_of)"
    pass_all
    A handoff LC CODE_DONE >/dev/null || die "A200 amend $variant: no CODE_DONE"
    fs=impl_test.txt; [ "$variant" != product_code ] || fs=impl.txt
    pc=''; [ "$variant" != plan_change ] || pc='plan_change: yes'
    printf 'reason: %s\nfix_scope: %s\nfix_instruction: %s\nauthorized_by: the user\n%s\n' "the user asked for one more test after CODE_DONE ($variant)" "$fs" "change $fs only as the user asked, nothing else" "$pc" | A amend LC >/dev/null || die "A200 amend $variant: amend refused"
    if [ "$variant" = plan_change ]; then
      mkdir -p .agents/runs/LC/amendments; printf '# amendment 001: the architecture note changes\n' > .agents/runs/LC/amendments/001.md
      printf '\nAmended: the lookup note changed.\n' >> .agents/runs/LC/PLAN.md
      A refreeze LC 001.md >/dev/null || die "A200 amend plan_change: refreeze refused"
      worker RED fail impl_test.txt 'test: lookup again returns the stored value'; worker GREEN pass impl.txt 'impl: lookup again returns the stored value'
    else
      case "$variant" in
        tests_only) worker FIX pass impl_test.txt 'test: lookup of a missing key is nil' ;;
        security_test) worker FIX pass impl_test.txt 'test: an expired token is rejected' ;;
        product_code) worker FIX pass impl.txt 'impl: lookup of a missing key is nil' ;;
      esac
    fi
    A handoff LC IMPLEMENTED >/dev/null || die "A200 amend $variant: no IMPLEMENTED"
    for g in REVIEW_PLAN REVIEW_RULES SECURITY; do
      st=$(gate_st "$g")
      case "$variant:$g" in
        tests_only:*) [ "$st" = pass ] || die "A200 amend $variant: $g is $st, a test-only amendment must keep it" ;;
        security_test:SECURITY|product_code:*|plan_change:*) [ "$st" != pass ] || die "A200 amend $variant: $g still pass although its inputs changed" ;;
        security_test:*) [ "$st" = pass ] || die "A200 amend $variant: $g is $st" ;;
      esac
    done
    for g in SECRETS REVIEW_TESTS VERIFY; do
      [ "$(gate_st "$g")" != pass ] || die "A200 amend $variant: $g carried over; it always runs"
    done
  done
  ok "A200 an amend carries REVIEW_PLAN/RULES/SECURITY only for an unrelated test change; plan, product code and security tests rerun them; SECRETS, REVIEW_TESTS and VERIFY always run"
}

# A200 review: which paths selective repetition may treat as tests. A file under a test directory that is a manifest, lockfile, env, config,
# build or contract file is product input; so is every path when the ecosystem data is not loaded.
sc_test_path_kind() {
  scaffold orchestrated
  tp() { A test-path "$1" | cut -f1; }
  for p in tests/Package.swift tests/setup.py tests/Package.json tests/.env.local tests/Dockerfile tests/go.mod tests/package.json test/.env api/spec/openapi.yaml test/setup/requirements.txt tests/docker-compose.yml; do
    [ "$(tp "$p")" = product ] || die "A200 $p counted as a test"
  done
  for p in tests/foo_test.go test/unit/a.test.ts src/__tests__/b.js tests/test_x.py; do
    [ "$(tp "$p")" = test ] || die "A200 $p is not counted as a test"
  done
  ok "A200 test-path: manifests, lockfiles, env, build and contract files under test directories are product input"
}

# A202 (item 14): the scope table's `kind:` column is a claim. The script derives every kind; a path a plan mislabels (code as content or
# doc, a code file as test) is still counted as code in the scope bound, shown as code in the digest, and a gate re-run does not skip it.
kind_claim() { # PLAN PATH KIND: add `    kind: KIND` under the scope entry of PATH
  awk -v p="$2" -v k="$3" '{ print } $0 == "  - path: " p { print "    kind: " k }' "$1" > "$base/kind.tmp" && cp "$base/kind.tmp" "$1"
}
sc_scope_kind_column() {
  SC_SCOPE_NAMED=notes.md unfrozen STANDARD; : > notes.md
  kind_claim .agents/runs/LC/PLAN.md impl.txt content; kind_claim .agents/runs/LC/PLAN.md notes.md doc; kind_claim .agents/runs/LC/PLAN.md impl_test.txt code
  rows=$(A scope-kinds LC)
  printf '%s\n' "$rows" | grep -q "^impl.txt	content	code	code	no$" || die "A202 a code file labelled content is not code: $rows"
  printf '%s\n' "$rows" | grep -q "^notes.md	doc	content	content	yes$" || die "A202 a true doc label was not accepted: $rows"
  printf '%s\n' "$rows" | grep -q "^impl_test.txt	code	test	code	no$" || die "A202 a stricter claim (code for a test) was not honoured: $rows"
  A digest LC | grep -q '^SCOPE: code=2 test=0 content=1 (kind claimed wrongly, counted as code: impl.txt impl_test.txt)' || die "A202 digest scope line: $(A digest LC | grep SCOPE)"
  awk '/^  STANDARD:/ { s = 1 } s && /max_scope_paths:/ { sub(/[0-9]+/, "1"); s = 0 } { print }' .agents/config.yaml > "$base/cfg.tmp" && cp "$base/cfg.tmp" .agents/config.yaml
  expect_msg "a code file labelled content lowered the scope bound" 'code paths (content and document paths are not counted)' A freeze LC
  # a plan without the column is derived; an unknown word is treated as code
  SC_SCOPE_NAMED=notes.md unfrozen STANDARD; : > notes.md; kind_claim .agents/runs/LC/PLAN.md notes.md banana
  A scope-kinds LC | grep -q "^notes.md	banana	content	code	yes$" || die "A202 an unknown kind was not treated as code: $(A scope-kinds LC)"
  SC_SCOPE_NAMED=notes.md unfrozen STANDARD; : > notes.md
  A scope-kinds LC | grep -q "^notes.md	-	content	content	yes$" || die "A202 a plan without the column is not derived: $(A scope-kinds LC)"
  ok "A202 the scope kind column is a claim: a mislabelled code file stays code in the bound and the digest, an unknown kind is code, no column is derived"
}
sc_scope_kind_gate_rerun() {
  for variant in honest mislabelled; do
    if [ "$variant" = honest ]; then scaffold orchestrated no CRITICAL; else SC_KIND_CLAIM=impl_test.txt=code scaffold orchestrated no CRITICAL; fi
    worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
    A handoff LC IMPLEMENTED >/dev/null
    pass_all
    rec REVIEW_TESTS FAIL high "REVIEW_TESTS-1|blocking|impl_test.txt:1|the test asserts nothing about the empty key|traced: empty key -> nil"
    A handoff LC IMPLEMENTING >/dev/null
    worker FIX pass impl_test.txt 'test: lookup of a missing key is nil'
    A handoff LC IMPLEMENTED >/dev/null
    st=$(gate_st REVIEW_PLAN)
    case "$variant" in
      honest) [ "$st" = pass ] || die "A202 honest test-only fix: REVIEW_PLAN is $st" ;;
      mislabelled) [ "$st" != pass ] || die "A202 the plan's own kind column says the path is code, yet REVIEW_PLAN carried over" ;;
    esac
  done
  ok "A202 a plan whose kind column says a path is code never lets a gate carry over for it"
}
sc_rollback_note() {
  unfrozen COMPLEX
  out=$(A freeze LC 2>&1 || true)
  printf '%s' "$out" | grep -q "no rollback note" || die "A202 no warning for a COMPLEX plan without rollback: $out"
  SC_PLAN_EXTRA='## Risk

rollback: ship behind the lookup flag; if production breaks, switch the flag off first
  then revert the commit
concurrency: no

## Dependencies

none' unfrozen COMPLEX
  out=$(A freeze LC 2>&1 || true)
  printf '%s' "$out" | grep -q "Risk' holds only" && die "A202 the rollback note was refused inside Risk: $out"
  printf '%s' "$out" | grep -q "no rollback note" && die "A202 warned although the rollback note is there: $out"
  unfrozen STANDARD; out=$(A freeze LC 2>&1 || true)
  printf '%s' "$out" | grep -q "rollback" && die "A202 STANDARD was asked for a rollback note: $out"
  unfrozen TRIVIAL; out=$(A freeze LC 2>&1 || true)
  printf '%s' "$out" | grep -q "rollback" && die "A202 TRIVIAL was asked for a rollback note: $out"
  ok "A202 a COMPLEX or CRITICAL plan without a rollback note in ## Risk is warned, never TRIVIAL or STANDARD, and the note is accepted inside Risk"
}
# A202 (items 17, 19): the QA report's Human checks list is copied by script into the completion report summary (once) and the status block.
sc_summary_human_checks() {
  scaffold standalone
  RF_EXTRA='## Human checks

- The error text reads naturally in Turkish
- The empty state looks balanced on a phone' to_code_done standalone
  [ "$(A human-checks LC | wc -l | tr -d ' ')" = 2 ] || die "A202 human-checks: $(A human-checks LC)"
  A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null
  mk() { # the model's summary lines (quoted arguments), then the usual body
    write_report; cat .agents/runs/LC/COMPLETION_REPORT.md > "$base/body.md"
    { printf '%s\n' '# Completion Report: LC' '' '<!-- proofline:summary:begin -->'; printf '%s\n' "$@"; printf '%s\n' '<!-- proofline:summary:end -->'; sed 1d "$base/body.md"; } > .agents/runs/LC/COMPLETION_REPORT.md
  }
  mk 'Changed: arama artik bos anahtar icin varsayilani donduruyor' 'Verify: `sh test.sh`'
  mk 'Changed: ok' 'The empty state looks balanced on a phone' 'Verify: `sh test.sh`'
  expect_msg "a retyped Human checks item was published" 'repeats a QA_REPORT.md' A publish-completion-report LC markdown
  mk 'Changed: one' 'Changed: two' 'Changed: three' 'Verify: `sh test.sh`'
  expect_msg "a six-line summary was published" 'at most five' A publish-completion-report LC markdown
  mk 'Changed: the lookup returns the default for an empty key'
  expect_msg "a summary without a Verify command was published" "needs exactly one line 'Verify:" A publish-completion-report LC markdown
  mk 'Changed: arama artik bos anahtar icin varsayilani donduruyor, çünkü şunu istediniz' 'Verify: `sh test.sh`'
  A publish-completion-report LC markdown >/dev/null || die "A202 a summary in the user's language was refused: $(A publish-completion-report LC markdown 2>&1)"
  r=.agents/runs/LC/COMPLETION_REPORT.md
  [ "$(grep -c '^Look at: ' $r)" = 2 ] || die "A202 the Look at lines are not there exactly once each: $(head -12 $r)"
  [ "$(grep '^Look at: ' $r | sed 's/^Look at: //')" = "$(A human-checks LC)" ] || die "A202 the summary list differs from the QA_REPORT.md list"
  [ "$(grep -c 'balanced on a phone' $r)" = 1 ] || die "A202 the list is written twice in the report"
  [ "$(sed -n 3p $r)" = '<!-- proofline:summary:begin -->' ] && grep -q '^<!-- proofline:facts:begin -->' $r || die "A202 summary not at the top or Facts block missing"
  A publish-completion-report LC markdown >/dev/null || die "A202 republish refused"
  [ "$(grep -c '^Look at: ' $r)" = 2 ] || die "A202 a republish doubled the list"
  A handoff LC DONE >/dev/null || die "A202 DONE refused for a report with a summary in the user's language: $(A handoff LC DONE 2>&1)"
  A status-block LC code-done >/dev/null 2>&1 || :
  [ "$(A human-checks LC | wc -l | tr -d ' ')" = 2 ] && ok "A202 the Human checks list is copied by script into the report summary once, equal to the QA report list; the summary is user-language and not evidence"
}

# A200 review: a blocking row is "about the visual evidence report" only when it names the reviews/visual-proof/ path; any other
# text that merely says report.json is an ordinary row for the implementer.
sc_visual_row_match() {
  scaffold orchestrated no CRITICAL
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  pass_all
  rec VERIFY FAIL high "VERIFY-1|blocking|impl.txt:1|the build's report.json is stale and the visual evidence is not mentioned|traced: build output"
  A next LC | grep -q 'qa --focus visual' && die "A200 a row that only says report.json sent the lead to the QA visual focus: $(A next LC)"
  rec VERIFY FAIL high "VERIFY-2|blocking|impl.txt:1|reviews/visual-proof/report.json is missing|traced: no such file"
  A next LC | grep -q 'qa --focus visual' || die "A200 a row naming reviews/visual-proof/ did not send the lead to the QA visual focus: $(A next LC)"
  ok "A200 a visual-evidence row is recognized by its reviews/visual-proof/ path, not by the word report.json"
}

# A200 (items 6, 8, 9): the normalizer's narrow list, the expected-format errors of refreeze and amend, the rationale approval kind.
sc_a200_misc() {
  scaffold orchestrated
  n() { printf '%s\n' "$1" | A repro-normalize; }
  [ "$(n '12:34:56 [build] Complete!')" = '[build] Complete!' ] || die "A200 the [build] Complete! line is not normalized"
  [ "$(n '[build] Complete! in 1.5s')" = '[build] Complete!' ] || die "A200 the Complete! line with a duration"
  [ "$(n 'done 2026-10-28T10:11:12.5Z ok')" = 'done <TIMESTAMP> ok' ] || die "A200 timestamp: $(n 'done 2026-10-28T10:11:12.5Z ok')"
  [ "$(n 'Done in 3.2s')" = "$(n 'Done in 41ms')" ] || die "A200 durations after 'in' differ"
  [ "$(n '42 passed (12ms)')" = "$(n '42 passed (3 s)')" ] || die "A200 parenthesized duration"
  [ "$(n '42 passed')" != "$(n '43 passed')" ] || die "A200 a real count difference was normalized away"
  [ "$(n 'Done in 3s')" != "$(n 'Built in 3s')" ] || die "A200 different words were normalized together"
  [ "$(n 'pid 4242 on 2026-10-28')" = 'pid 4242 on 2026-10-28' ] || die "A200 a pid or a bare date was normalized"
  [ "$(n '2026-10-28T10:11:12Z 42 passed')" != "$(n '2026-10-28T10:11:12Z 43 passed')" ] || die "A200 a count next to a timestamp was normalized away"
  [ "$(n '10:11:12 [build] Complete! 3 errors')" != "$(n '10:11:12 [build] Complete! 4 errors')" ] || die "A200 a count next to the Complete! line was normalized away"
  [ "$(n '2026-10-28T10:11:12Z failed: a.js')" != "$(n '2026-10-28T10:11:12Z failed: b.js')" ] || die "A200 a name next to a timestamp was normalized away"
  [ "$(n 'Done in 3s: 5 files')" != "$(n 'Done in 3s: 6 files')" ] || die "A200 a count after a duration was normalized away"
  [ "$(n '3 tests failed')" != "$(n '3 tests passed')" ] || die "A200 pass and fail were normalized together"
  expect_msg "A200 refreeze without an amendment shows the format" 'Example: write amendments/001.md' A freeze LC
  expect_msg "A200 refreeze with a missing file shows the format" 'agent.sh refreeze LC 001.md' A refreeze LC nope.md
  # item 6: a rationale approval needs a written line, and the kind is accepted
  expect_msg "A200 rationale approval without a DESIGN.md line" "no non-empty '- mono-labels: <reason>' line" A request-approval LC rationale:mono-labels
  mkdir -p docs/design; printf '# D\n\n## Pattern justifications\n- mono-labels: file names are the product here\n' > docs/design/DESIGN.md
  A request-approval LC rationale:mono-labels | grep -q 'rationale line of DESIGN.md: mono-labels: file names are the product here' || die "A200 the request does not show the line"
  [ "$(A design-rationales LC | cut -f1,2)" = "$(printf 'mono-labels\tunapproved')" ] || die "A200 an unapproved rationale is listed as approved"
  [ "$(A design-rationales LC --json)" = '{"approved": {}}' ] || die "A200 the approved object is not empty: $(A design-rationales LC --json)"
  ok "A200 normalizer list, expected-format errors, rationale approval needs the user"
}

sc_takeover_without_red() {
  # A198: an earlier implementer (another runtime) edited the implementation inside its window and recorded no RED. The next implementer binds it
  # without asking: put the change back to the base content for one run (RED fails for the right reason), restore it, record GREEN.
  scaffold orchestrated no STANDARD
  base_impl=$(cat impl.txt)
  wopen; printf 'lookup returns the stored value\n' >> impl.txt; wclose           # the earlier implementer: an edit, no evidence
  cp impl.txt "$base/impl.changed"
  wopen                                                                          # the implementer that takes over
  printf '%s\n' "$base_impl" > impl.txt                                          # step 1: put the change back for one run
  wev RED fail || die "A198 RED was refused with the change put back"
  cp "$base/impl.changed" impl.txt                                               # step 2: restore the change
  wev GREEN pass || die "A198 GREEN was refused after the change was restored"
  wclose
  ls .agents/runs/LC/worker-evidence/RED-*.yaml >/dev/null && ls .agents/runs/LC/worker-evidence/GREEN-*.yaml >/dev/null || die "A198 RED and GREEN were not both recorded"
  A handoff LC IMPLEMENTED >/dev/null 2>&1 || die "A198 the handoff was refused although RED and GREEN are recorded: $(A handoff LC IMPLEMENTED 2>&1 | tail -3)"
  ok "A198 a change edited without RED is bound by put-back, RED, restore, GREEN; the handoff accepts it"
  # RED recorded with the change in place leaves no change between RED and GREEN: GREEN is refused, and the refusal names the way out
  scaffold orchestrated no STANDARD
  wopen; printf 'lookup returns the stored value\n' >> impl.txt; wclose
  wopen; wev RED fail
  out=$(printf 'command: go test ./...\ntarget: impl.txt,impl_test.txt\n\n' | AGENT_ROLE=implementer sh ./.agents/scripts/agent.sh worker-evidence "$RID" GREEN pass 2>&1) && die "A198 GREEN was accepted with no change since RED"
  printf '%s' "$out" | grep -q 'put it back to the base content' || die "A198 the refusal does not name the put-back path: $out"
  ok "A198 GREEN with no change since RED is refused, and the refusal names the put-back path"
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
  approve_as_user scope 'approve the scope'
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
  # A105: the verbatim blanket answer is the user's, but it never decides to fix a defect
  expect_msg "a blanket answer deciding a scope fix" 'blanket answer never decides a fix' A freeze LC
  sed 's#| resolved | Fixed in this change |#| resolved | Reported, left unchanged |#' "$d/design/INTENT.md" > "$base/intent.md" && cp "$base/intent.md" "$d/design/INTENT.md"
  A freeze LC >/dev/null || die "a blanket answer deciding report was refused: $(A freeze LC 2>&1)"
  ok "an answer to a scope decision recorded as the user's must be in a captured user prompt; a blanket answer only reports"
}
sc_folded_defect() {
  # A105: COMPLEX X-13 replay. The task (tags) folds the paging defect fix into its criteria after a blanket
  # answer; the plan scopes src/service.js for it. The freeze needs the declaration, then the user's scope approval.
  unfrozen COMPLEX
  d=.agents/runs/LC
  printf '%s\n' '# Task: LC — Tag books' '' '## Goal' '' '> I would like to tag the books in my reading list and filter by a tag.' '' \
    '## Context' '' '- Decisions delegated to the recommended options: the paginate defect is fixed with a ceiling.' '' \
    '## Acceptance criteria' '' '- AC-1: x' '' '## Suggested class' '' 'COMPLEX — persistence and contract change' > "$d/TASK.md"
  expect_msg "a COMPLEX task folding a defect fix without declaring it" 'mentions a defect or a fix the request does not ask for' A freeze LC
  A next LC | grep -q '^next=fix TASK.md ## Pre-existing defects' || die "next does not ask for the declaration: $(A next LC)"
  printf '\n### Pre-existing defects\n\n- src/service.js:paginate: totalPages rounds down\n' >> "$d/TASK.md"
  expect_msg "a declared defect without a decision" 'entry without decision' A freeze LC
  sed 's/rounds down$/rounds down -- decision: fix/' "$d/TASK.md" > "$base/task.md" && cp "$base/task.md" "$d/TASK.md"
  approve_as_user plan 'approve the plan'
  expect_msg "a declared defect fix without the user's scope approval" 'scope approval for this PLAN.md' A freeze LC
  # a specialist question answered with the blanket reply does not unlock the freeze
  printf 'QUESTIONS:\n1. Fix the paging defect in this change?\n   options: fix | report\n   recommended: report\n   why: not requested\n' > "$base/q.md"
  A ask LC --file "$base/q.md" >/dev/null
  capture 'Use your recommended option for every open question.'
  printf 'Use your recommended option for every open question.\n' | A answer LC 1 >/dev/null
  grep -q '^answered_by: user' $d/questions/001.answer.md || die "the blanket answer was not recorded as the user's"
  expect_msg "a blanket answer as a scope approval" 'scope approval for this PLAN.md' A freeze LC
  A request-approval LC scope >/dev/null
  capture 'Use your recommended option for every open question.'
  expect_msg "a blanket prompt as a scope approval" 'no approval phrase' A approve LC scope
  approve_as_user scope 'approve the scope'
  A freeze LC >/dev/null || die "freeze refused with the scope approval: $(A freeze LC 2>&1)"
  ok "A105: a COMPLEX task declares a folded defect fix; only the user's own scope approval unlocks the freeze"
  # declared as report: no approval needed; a STANDARD defect task is unaffected
  unfrozen COMPLEX
  printf '%s\n' '# Task: LC — Tag books' '' '## Goal' '' '> I would like to tag books.' '' '## Context' '' '- The paginate defect is reported, not fixed.' '' \
    '## Pre-existing defects' '' '- src/service.js:paginate: totalPages rounds down -- decision: report' '' '## Acceptance criteria' '' '- AC-1: x' > "$d/TASK.md"
  approve_as_user plan 'approve the plan'
  A freeze LC >/dev/null || die "a reported defect was refused: $(A freeze LC 2>&1)"
  unfrozen STANDARD
  printf '%s\n' '# Task: LC — Every book reachable' '' '## Goal' '' 'Every book is reachable through paging.' '' '## Context' '' '- The fix rounds the page count up.' '' '## Acceptance criteria' '' '- AC-1: x' > "$d/TASK.md"
  A freeze LC >/dev/null || die "a STANDARD defect task was refused: $(A freeze LC 2>&1)"
  ok "A105: a reported defect or a STANDARD defect task needs no scope approval"
}
sc_class_floor() {
  new_repo; RID=LC; mkdir -p .agents/runs/LC tasks
  printf '# Task: LC — lookup\n\n## Acceptance criteria\n\n- AC-1: x\n\n## Suggested class\n\nSTANDARD — one module\n' > .agents/runs/LC/TASK.md
  sed 's/<TASK-ID>/LC/; s#<REPOSITORY-RELATIVE-TASK-FILE.md>#tasks/LC.md#' .agents/templates/RUN.yaml > .agents/runs/LC/RUN.yaml
  printf '# LC task\n' > tasks/LC.md; printf 'LC\n' > .agents/local/ACTIVE_RUN; git add -A; git commit -qm base
  expect_msg "a class below the task's suggested class" 'suggests STANDARD and TRIVIAL is lower' A classify LC TRIVIAL
  A classify LC STANDARD >/dev/null || die "the suggested class was refused: $(A classify LC STANDARD 2>&1)"
  A classify LC COMPLEX >/dev/null || die "a higher class was refused"
  ok "classify refuses a class below the task's Suggested class and accepts the class or a higher one"
}
sc_design_sync() {
  SC_PLAN_EXTRA='
## Contracts

- `GET /api/books` gains `tags`

## Validation

- `GET /api/books`: accepts no body and an optional limit query; limits limit 1-100; rejected at the list handler (400)' \
    SC_QA_EXTRA='- QA-9 (AC-1) [invalid-input]: GET /api/books with limit 0
  expected: 400' scaffold orchestrated no STANDARD; implemented orchestrated
  mkdir -p docs/design; printf '# api\n' > docs/design/API.md; printf 'docs/\n' >> .git/info/exclude
  d=.agents/runs/LC; printf '# VERIFY\n\nall criteria proven\n' > "$d/VERIFY.md"
  expect_msg "a verification of a contract change without design/SYNC.md" 'design/SYNC.md' AS verifier submit LC --confidence high --agent vs1
  printf '# VERIFY\n\nall criteria proven\ndesign-sync: SKIPPED (the document was read and needs no change)\n' > "$d/VERIFY.md"
  out=$(AS verifier submit LC --confidence high --agent vs2 2>&1) || :
  printf '%s' "$out" | grep -q 'design/SYNC.md' && die "a recorded SKIPPED line was not accepted: $out"
  ok "design-sync is written or skipped on the record when the plan changes what a design document describes"
}
# --- A162: an entry point that takes external input needs a validation line and an invalid-input scenario ----
ev_val='- `POST /orders`: accepts a JSON body with items; limits 1-50 items; rejected at the order handler (400)'
ev_inv='- QA-9 (AC-1) [invalid-input]: POST /orders with 51 items
  input: a body with 51 items
  expected: 400'
# ev_scaffold PLAN_EXTRA QA_EXTRA: an orchestrated STANDARD run, not yet frozen
ev_scaffold() { SC_PLAN_EXTRA=$1 SC_QA_EXTRA=${2:-} scaffold orchestrated no STANDARD manual; }
sc_validation_plan() {
  ev_c='
## Contracts

- `POST /orders` creates an order'
  ev_scaffold "$ev_c" "$ev_inv"
  ev_msg='PLAN.md ## Contracts declares an entry point that takes external input, but ## Validation has no complete line for: POST /orders'
  expect_msg "a new endpoint without a validation summary" "$ev_msg" A freeze LC
  A pipeline LC | grep -q '^validation.entry_points=POST /orders' || die "pipeline lists no entry point: $(A pipeline LC)"
  ev_scaffold "$ev_c

## Validation

- \`POST /orders\`: accepts a JSON body; limits 1-50 items" "$ev_inv"
  expect_msg "a validation line without rejected at" "$ev_msg" A freeze LC
  ev_scaffold "$ev_c

## Validation

$ev_val" "$ev_inv"
  A freeze LC >/dev/null || die "a plan with a complete validation line was refused: $(A freeze LC 2>&1)"
  A pipeline LC | grep -q '^validation.missing=' && die "pipeline reports missing validation for a complete plan"
  ev_scaffold '
## Contracts

- `POST /orders` is removed (the endpoint is gone)'
  A freeze LC >/dev/null || die "a bullet that removes the contract was treated as an entry point: $(A freeze LC 2>&1)"
  ev_scaffold ''
  A freeze LC >/dev/null || die "an ordinary plan without entry points was refused: $(A freeze LC 2>&1)"
  A pipeline LC | grep -q '^validation\.' && die "an ordinary plan prints validation rows"
  # code patterns are information only: a scope file that looks like a route never refuses the freeze
  ev_scaffold ''
  printf 'app.post("/orders", handler)\n' > impl.txt
  out=$(A freeze LC 2>&1) || die "a code-pattern candidate refused the freeze: $out"
  printf '%s' "$out" | grep -q 'information only' || die "no information note for the candidate: $out"
  A pipeline LC | grep -q '^validation.candidates=scope:impl.txt' || die "pipeline lists no candidate: $(A pipeline LC)"
  ok "A162: an entry point in ## Contracts needs a complete ## Validation line at freeze; a removal, no entry point and code candidates never refuse"
}
sc_validation_qa() {
  ev_scaffold "
## Contracts

- \`POST /orders\` creates an order

## Validation

$ev_val"
  qa_bind LC
  ev_msg='QA_PLAN.md has no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: POST /orders'
  expect_msg "verify-qa-plan without an invalid-input scenario" "$ev_msg" A verify-qa-plan LC
  expect_msg "freeze without an invalid-input scenario" "$ev_msg" A freeze LC
  d=.agents/runs/LC; cp "$d/QA_PLAN.md" "$base/qa.keep"
  { cat "$base/qa.keep"; printf '%s\n' '- QA-9 (AC-1) [invalid-input]: POST /refunds with 51 items' '  expected: 400'; } > "$d/QA_PLAN.md"; qa_bind LC
  expect_msg "a scenario naming another entry point" "$ev_msg" A verify-qa-plan LC
  { cat "$base/qa.keep"; printf '%s\n' '- QA-9 (AC-1) [concurrency]: POST /orders twice' '  expected: one order'; } > "$d/QA_PLAN.md"; qa_bind LC
  expect_msg "a scenario of another category" "$ev_msg" A verify-qa-plan LC
  { cat "$base/qa.keep"; printf '%s\n' '- QA-9 (AC-1) [invalid-input]: too many items' '  input: POST /orders with 51 items' '  expected: 400'; } > "$d/QA_PLAN.md"; qa_bind LC
  A verify-qa-plan LC >/dev/null || die "an input line naming the entry point was refused: $(A verify-qa-plan LC 2>&1)"
  { cat "$base/qa.keep"; printf '%s\n' "$ev_inv"; } > "$d/QA_PLAN.md"; qa_bind LC
  A verify-qa-plan LC >/dev/null || die "a title naming the entry point was refused: $(A verify-qa-plan LC 2>&1)"
  A freeze LC >/dev/null || die "freeze with plan line and scenario was refused: $(A freeze LC 2>&1)"
  ok "A162: a QA plan needs an [invalid-input] scenario naming each entry point; another entry point or category does not satisfy it"
}
sc_validation_refreeze() {
  ev_msg='PLAN.md ## Contracts declares an entry point that takes external input, but ## Validation has no complete line for: POST /orders'
  ev_scaffold '' "$ev_inv"
  A freeze LC >/dev/null || die "freeze of a plan without entry points failed: $(A freeze LC 2>&1)"
  amend_plan 001 '
## Contracts

- `POST /orders` creates an order'
  expect_msg "a refreeze that adds an entry point without a validation line" "$ev_msg" A refreeze LC 001.md
  printf '\n## Validation\n\n%s\n' "$ev_val" >> .agents/runs/LC/PLAN.md
  A refreeze LC 001.md >/dev/null || die "a refreeze with a validation line and an invalid-input scenario was refused: $(A refreeze LC 001.md 2>&1)"
  # the QA plan of the refreeze needs the invalid-input scenario too
  ev_scaffold '' ''
  A freeze LC >/dev/null || die "freeze of a plan without entry points failed: $(A freeze LC 2>&1)"
  amend_plan 001 "
## Contracts

- \`POST /orders\` creates an order

## Validation

$ev_val"
  expect_msg "a refreeze without an invalid-input scenario" 'QA_PLAN.md has no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: POST /orders' A refreeze LC 001.md
  ok "A162: a refreeze enforces the validation line and the invalid-input scenario for a new entry point"
}
sc_validation_node() {
  command -v node >/dev/null 2>&1 || { echo "skip validation_node (node missing)"; exit 0; }
  sk=$tl_agents/../../skills
  [ -f "$sk/plan-contract/scripts/validate-plan.mjs" ] || { echo "skip validation_node (skills missing)"; exit 0; }
  ev_scaffold '
## Contracts

- `POST /orders` creates an order' "$ev_inv"
  d=.agents/runs/LC; qa_bind LC
  vp=$(node "$sk/plan-contract/scripts/validate-plan.mjs" "$d/PLAN.md" "$d/TASK.md" --class STANDARD --repo . 2>&1 || :)
  printf '%s' "$vp" | grep -q 'no complete line for the entry point(s) POST /orders' || die "validate-plan.mjs disagrees with agent.sh: $vp"
  printf '%s\n' '' '## Validation' '' "$ev_val" >> "$d/PLAN.md"
  vp=$(node "$sk/plan-contract/scripts/validate-plan.mjs" "$d/PLAN.md" "$d/TASK.md" --class STANDARD --repo . 2>&1 || :)
  printf '%s' "$vp" | grep -q 'no complete line' && die "validate-plan.mjs refuses a complete line: $vp"
  A pipeline LC | grep -q '^validation.missing=' && die "agent.sh refuses a complete line"
  cp "$d/QA_PLAN.md" "$base/qa.full"; grep -v 'invalid-input\|^  input: a body\|^  expected: 400' "$base/qa.full" > "$d/QA_PLAN.md"
  qa_bind LC
  node "$sk/qa-plan/scripts/validate-qa.mjs" plan "$d/QA_PLAN.md" --plan "$d/PLAN.md" 2>&1 | grep -q 'invalid-input scenario for the entry point POST /orders' || die "validate-qa.mjs accepts a QA plan without the scenario"
  expect_msg "agent.sh on the same QA plan" 'no invalid-input scenario for the entry point(s)' A verify-qa-plan LC
  # the default word list is one value in the config, validate-plan.mjs and validate-qa.mjs
  cw=$(A config-get validation.entry_words)
  [ -n "$cw" ] || die "config has no validation.entry_words"
  for m in plan-contract/scripts/validate-plan.mjs qa-plan/scripts/validate-qa.mjs; do
    nw=$(NODE_MOD="$(cd "$sk/$(dirname "$m")" && pwd)/$(basename "$m")" node -e 'import(process.env.NODE_MOD).then((m) => process.stdout.write(m.ENTRY_WORDS))')
    [ "$nw" = "$cw" ] || die "ENTRY_WORDS of $m differs from config validation.entry_words"
  done
  ok "A162: the node validators agree with agent.sh and share the default entry word list with the config"
}
# A162: two-tier detection. The reviewed false positives are never mandatory; a declared entry point with new input is;
# the labelled corpus agrees between agent.sh and both validators.
sc_validation_tiers() {
  command -v node >/dev/null 2>&1 || { echo "skip validation_tiers (node missing)"; exit 0; }
  new_repo
  while IFS= read -r vt_b; do
    vt_t=$(A entry-tier "$vt_b")
    [ "$vt_t" != mandatory ] || die "a false positive is mandatory: $vt_b"
  done <<'FP'
`order.schema.json` 3 -> 4 - consumers: billing
`PLAN.md` frontmatter gains `validation` - consumers: validate-plan.mjs
`events.proto` field added - consumers: billing
The consumer of this API is the CLI
The handler returns 404 for unknown ids
Form fields documented in docs/forms.md
The routes table in README updated
`schema.graphql` Query.users gains limit
`GET /api/books` response shape unchanged
Book response (`GET /api/books`) omits legacyNotes
FP
  [ "$(A entry-tier 'POST /orders no longer accepts qty above 100')" = mandatory ] || die "a changed input limit is not mandatory"
  [ "$(A entry-tier 'DELETE /x is added: removes an item')" = mandatory ] || die "a new endpoint is not mandatory"
  vt_o=$(sh "$tl_agents/../../tests/fixtures/entry-points/run-corpus.sh" 2>&1) || die "entry-point corpus: $vt_o"
  ok "A162: reviewed false positives are never mandatory, the two positives are, and the corpus agrees (agent.sh, validate-plan, validate-qa)"
}
# A162: a plan whose bullets are information only is not refused at freeze; a backslash entry name matches a QA scenario.
sc_validation_info_only() {
  ev_scaffold '
## Contracts

- `order.schema.json` 3 -> 4 - consumers: billing
- The handler returns 404 for unknown ids
- `GET /api/books` response shape unchanged' ''
  A freeze LC >/dev/null || die "a plan with information-only bullets was refused: $(A freeze LC 2>&1)"
  A pipeline LC | grep -q '^validation.missing=' && die "information-only bullets are reported missing"
  A pipeline LC | grep -q '^validation.possible=' || die "no validation.possible row for information-only bullets: $(A pipeline LC)"
  ev_scaffold '
## Contracts

- `GET /u/\d+` takes a query parameter

## Validation

- `GET /u/\d+`: accepts a numeric id; limits 1-10 digits; rejected at the user handler (400)' '- QA-9 (AC-1) [invalid-input]: GET /u/\d+ with letters
  input: an id of letters
  expected: 400'
  A pipeline LC | grep -qF 'validation.entry_points=GET /u/\d+' || die "a backslash entry name was mangled: $(A pipeline LC | grep '^validation')"
  qa_bind LC
  A verify-qa-plan LC >/dev/null || die "a QA scenario naming a backslash entry point was refused: $(A verify-qa-plan LC 2>&1)"
  A freeze LC >/dev/null || die "freeze with a backslash entry point was refused: $(A freeze LC 2>&1)"
  ev_scaffold '
## Contracts

- `GET /u/\d+` takes a query parameter

## Validation

- `GET /u/\d+`: accepts a numeric id; limits 1-10 digits; rejected at the user handler (400)' ''
  qa_bind LC
  expect_msg "a QA plan without a scenario for a backslash entry point" 'no invalid-input scenario for the entry point(s) of PLAN.md ## Contracts: GET /u/\d+' A verify-qa-plan LC
  ok "A162: information-only bullets never refuse the freeze; a backslash entry name matches its QA scenario and is missed without one"
}
sc_validation_config() {
  new_repo
  A config-check >/dev/null
  sed 's/^  entry_words: .*/  entry_words: "(["/' .agents/config.yaml > "$base/bad.yaml"
  expect_msg "config-check accepted an invalid entry_words regex" 'invalid regular expression for validation.entry_words' A config-check "$base/bad.yaml"
  sed 's/^  code_patterns: .*/  code_patterns: "*("/' .agents/config.yaml > "$base/bad.yaml"
  expect_msg "config-check accepted an invalid code_patterns regex" 'invalid regular expression for validation.code_patterns' A config-check "$base/bad.yaml"
  grep -q '^validation:' .agents/config.yaml || die "the config has no validation block"
  awk '{ print } /^validation:/ { print "  surprise: 1" }' .agents/config.yaml > "$base/bad.yaml"
  expect_msg "config-check accepted an unknown validation key" 'unknown validation key: validation.surprise' A config-check "$base/bad.yaml"
  ok "A162: config-check rejects an invalid validation regex and an unknown validation key"
}
# --- A107: a report is not evidence; the control plane re-derives what it can -------------------------
# evidence_gap_fixture: an orchestrated run whose PLAN names `sh check.sh` as its verification command, the
# verify-proof skill installed, check.sh printing "ok 3 tests"; VERIFY.md is written by vw.
evidence_gap_fixture() {
  command -v node >/dev/null 2>&1 || { echo "skip evidence_gap (node missing)"; exit 0; }
  SC_PLAN_EXTRA='
## Verification commands

- `sh .agents/local/check.sh`
- `sh .agents/local/quiet.sh`' scaffold orchestrated; implemented orchestrated
  mkdir -p .agents/skills; cp -R "$tl_agents/../../skills/verify-proof" .agents/skills/verify-proof; cp -R "$tl_agents/../../skills/plan-contract" .agents/skills/plan-contract
  printf '.agents/skills/\n' >> .git/info/exclude
  printf '%s\n' 'echo ok 3 tests' > .agents/local/check.sh; printf '%s\n' ':' > .agents/local/quiet.sh
  d=.agents/runs/LC
}
# vw VERDICT EXIT OUTPUT STATUS: a self-consistent VERIFY.md claiming `sh .agents/local/check.sh` ran with that exit and output.
vw() {
  printf '%s\n' '# Verification: LC' '' '## Commands' '' "- \`sh .agents/local/check.sh\` | exit=$2" "  output: $3" '' '## AC coverage' '' '| AC | test or command | status | evidence |' '|---|---|---|---|' \
    "| AC-1 | impl_test.txt::lookup | $4 | \`sh .agents/local/check.sh\` exit=$2 |" '' '## Scope' '' 'verify-scope: exit=0' '' '## Design sync' '' 'design-sync: SKIPPED (no design documents)' '' '## Runtime' '' 'runtime: none (no runtime in this test)' '' \
    '## Pre-existing failures' '' 'None' '' '## Failures' '' 'None' '' "Verdict: $1" > "$d/VERIFY.md"
}
sc_evidence_gap_fabricated() {
  evidence_gap_fixture
  # an honest, self-consistent report is accepted and recorded PASS (the command really prints that line)
  vw PASS 0 'ok 3 tests' PASS
  out=$(AS verifier submit LC --confidence high --findings none --agent eg0 2>&1) || die "an honest report was refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier PASS' || die "an honest report was not recorded PASS: $out"
  # the declared validator result is never trusted: the validator recomputes it and a mismatch names both
  vw PASS 0 'ok 3 tests' PASS
  expect_msg "a declared validator FAIL over a recomputed PASS" 'declared FAIL, recomputed PASS' AS verifier submit LC --confidence high --validator-result FAIL --findings none --agent eg2
  vw FAIL 1 'ok 3 tests' FAIL
  expect_msg "a declared validator PASS over a recomputed FAIL" 'declared PASS, recomputed FAIL' AS verifier submit LC --confidence high --validator-result PASS --findings none --agent eg1
  expect_msg "a PASS with no blocking finding over a recomputed FAIL" 'declared PASS (no blocking finding), recomputed FAIL' AS verifier submit LC --confidence high --findings none --agent eg1b
  # a fabricated report: every row consistent, the validator says valid and PASS, but the command does not print
  # the recorded line. The control plane re-runs it: FAIL with a blocking finding.
  vw PASS 0 'ok 412 tests, 0 failed' PASS
  out=$(AS verifier submit LC --confidence high --validator-result PASS --findings none --agent eg3 2>&1) || die "the fabricated report was refused instead of recorded FAIL: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "a fabricated but self-consistent report passed: $out"
  grep -rq 'does not reproduce' "$d/results" || die "no blocking finding names the reproduction mismatch"
  ok "A107: a fabricated but internally consistent VERIFY.md is re-derived and rejected; a declared validator result is never trusted"
}
sc_evidence_gap_files() {
  evidence_gap_fixture
  vw PASS 0 'ok 3 tests' PASS
  mkdir -p "$d/reports"; printf 'measured: 4 files\n' > "$d/reports/measure.txt"
  want=$(tsha "$d/reports/measure.txt")
  out=$(AS verifier submit LC --confidence high --findings none --evidence "reports/measure.txt@$want" --agent ef0 2>&1) || die "a cited, unchanged evidence file was refused: $out"
  grep -rq "^EVIDENCE: reports/measure.txt $want" "$d/results" || die "the cited evidence is not on the recorded result"
  # modified after it was hashed
  printf 'measured: 40000 files\n' > "$d/reports/measure.txt"
  expect_msg "an evidence file modified after hashing" 'modified after it was hashed' AS verifier submit LC --confidence high --findings none --evidence "reports/measure.txt@$want" --agent ef1
  # cited inside a finding row's evidence column
  printf 'info|-|note|see reports/measure.txt@%s\n' "$want" > "$base/rows.eg"
  expect_msg "a row citing a modified evidence file" 'modified after it was hashed' AS verifier submit LC --confidence high --findings "$base/rows.eg" --agent ef2
  # missing
  rm -f "$d/reports/measure.txt"
  expect_msg "a missing evidence file" 'cited evidence file not found' AS verifier submit LC --confidence high --findings none --evidence "reports/measure.txt@$want" --agent ef3
  expect_msg "a missing evidence file cited without a hash" 'not found' AS verifier submit LC --confidence high --findings none --evidence reports/nope.txt --agent ef4
  # outside the folders the role reports in
  expect_msg "an evidence file outside the role's folders" 'outside the folders' AS verifier submit LC --confidence high --findings none --evidence "TASK.md@$(tsha "$d/TASK.md")" --agent ef5
  ok "A107: a cited evidence file that is missing, altered after hashing or outside the role's folders refuses the submission"
}
sc_evidence_gap_rerun() {
  evidence_gap_fixture
  # the report was true when written; the command now gives a different result than the one recorded
  vw PASS 0 'ok 3 tests' PASS
  printf '%s\n' 'echo ok 2 tests, 1 failed' 'exit 1' > .agents/local/check.sh
  out=$(AS verifier submit LC --confidence high --findings none --agent er1 2>&1) || die "a non-reproducing report was refused instead of recorded FAIL: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "reproduced evidence that no longer reproduces passed: $out"
  grep -rq 're-running `sh .agents/local/check.sh` gave exit=1, the report records exit=0' "$d/results" || die "no blocking finding names the mismatch"
  # a command that is neither configured nor planned is never executed: a report cannot make the control plane run it
  printf 'touch .agents/local/ran-unplanned\n' > .agents/local/other.sh
  printf '%s\n' '# Verification: LC' '' '## Commands' '' '- `sh .agents/local/other.sh` | exit=0' '  output: done' '' '## AC coverage' '' '| AC | test or command | status | evidence |' '|---|---|---|---|' \
    '| AC-1 | impl_test.txt::lookup | PASS | `sh .agents/local/other.sh` exit=0 |' '' '## Scope' '' 'verify-scope: exit=0' '' '## Design sync' '' 'design-sync: SKIPPED (none)' '' '## Runtime' '' 'runtime: none (no runtime in this test)' '' '## Pre-existing failures' '' 'None' '' '## Failures' '' 'None' '' 'Verdict: PASS' > "$d/VERIFY.md"
  out=$(AS verifier submit LC --confidence high --findings none --agent er2 2>&1) || die "unplanned command report refused: $out"
  [ ! -e .agents/local/ran-unplanned ] || die "the control plane executed a command that is neither configured nor in the plan"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "a PASS whose only command could not be re-run was accepted: $out"
  ok "A107: the verifier path re-runs a recorded reproduced command; a differing result is FAIL, an unplanned command is never run"
}
sc_evidence_gap_gates() {
  evidence_gap_fixture
  # R1-1: a PASS gate with nothing re-runnable is never silent: judgment-only gates record NOT_RERUN
  mkdir -p "$d/reviews/proof-review/small"; printf "# small review\n\nthe change was read.\n" > "$d/reviews/proof-review/small/REPORT.md"
  out=$(AS reviewer submit LC --focus rules+tests --confidence high --findings none --agent g1 2>&1) || :
  gf=$(ls "$d"/gates/*REVIEW_SMALL.yaml | tail -1)
  grep -q '^not_rerun: "REVIEW_SMALL:rules+tests no reproduced evidence; this gate is not reproduced proof"' "$gf" || die "a PASS with nothing to re-run left no not_rerun field: $out"
  # A130: the marker is a gate field, never a findings row: a clean gate has no finding at all
  grep -q '^finding:.*NOT_RERUN' "$gf" && die "a gate that re-ran nothing carries a NOT_RERUN findings row: $(grep '^finding:' "$gf")"
  grep -rq '^| .*NOT_RERUN' "$d/results" && die "the result file carries a NOT_RERUN findings row"
  A pipeline LC | grep -q '^not_rerun.REVIEW_SMALL:rules+tests=NOT_RERUN (not reproduced proof): no reproduced evidence' || die "pipeline prints no not_rerun line: $(A pipeline LC | grep not_rerun)"
  # a verifier PASS whose only commands are neither configured nor planned: blocking, nothing executed
  printf 'touch .agents/local/ran-unplanned\n' > .agents/local/other.sh
  vw PASS 0 'ok 3 tests' PASS
  sed -i.bak 's|`sh .agents/local/check.sh`|`sh .agents/local/other.sh`|' "$d/VERIFY.md"; rm -f "$d/VERIFY.md.bak"
  out=$(AS verifier submit LC --confidence high --findings none --agent g2 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "nothing re-runnable passed: $out"
  grep -rq 'could be re-run' "$d/results" || die "no blocking finding says nothing was re-runnable"
  [ ! -e .agents/local/ran-unplanned ] || die "an unplanned command was executed"
  # R1-2: an installed skill whose validator cannot run makes a PASS of that focus a refusal, declared or not
  cp -R "$tl_agents/../../skills/proof-review" .agents/skills/proof-review
  mkdir -p "$d/reviews/proof-review/rules"; printf '# rules review\n\nthe change was read.\n' > "$d/reviews/proof-review/rules/REPORT.md"
  expect_msg "a PASS of a mapped focus without its findings.json" 'no validator run for' AS reviewer submit LC --focus rules --confidence high --findings none --agent g3
  expect_msg "the same PASS with a declared validator result" 'no validator run for' AS reviewer submit LC --focus rules --confidence high --validator-result PASS --findings none --agent g4
  ok "A107 R1: a PASS is never silent: NOT_RERUN row, nothing re-runnable is FAIL, a missing validator run refuses a mapped focus"
}
sc_evidence_gap_legacy() {
  evidence_gap_fixture
  # A130: a gate record made by an older version (the info row NOT_RERUN, no field) is still honoured
  mkdir -p "$d/reviews/proof-review/small"; printf "# small review\n\nthe change was read.\n" > "$d/reviews/proof-review/small/REPORT.md"
  git update-index --assume-unchanged .agents/scripts/agent.sh 2>/dev/null || :   # the edited copy is not a task change (it would raise the tier)
  sed -i.bak 's#^\( *\)sb_nr="\(.*\) no reproduced evidence; this gate is not reproduced proof".*#\1printf "info|%s|NOT_RERUN: \2 no reproduced evidence; this gate is not reproduced proof|x\\n" "$sb_norm" >> "$sb_tmp/rows"#' .agents/scripts/agent.sh; rm -f .agents/scripts/agent.sh.bak
  grep -q 'info|%s|NOT_RERUN' .agents/scripts/agent.sh || die "could not build the legacy submit"
  out=$(AS reviewer submit LC --focus rules+tests --confidence high --findings none --agent l1 2>&1) || die "legacy submit refused: $out"
  grep -q '^finding:.*NOT_RERUN' "$(ls "$d"/gates/*REVIEW_SMALL.yaml | tail -1)" || die "legacy record has no info row"
  A pipeline LC | grep -q '^not_rerun.REVIEW_SMALL:rules+tests=NOT_RERUN (not reproduced proof)' || die "the old NOT_RERUN info row is no longer honoured"
  ok "A130: a gate record with the old NOT_RERUN info row is still honoured"
}
sc_evidence_gap_output() {
  evidence_gap_fixture
  # R1-3: a command row without an output line compares nothing: FAIL, never a pass
  printf '%s\n' '# Verification: LC' '' '## Commands' '' '- `sh .agents/local/check.sh` | exit=0' '' '## AC coverage' '' '| AC | test or command | status | evidence |' '|---|---|---|---|' \
    '| AC-1 | impl_test.txt::lookup | PASS | `sh .agents/local/check.sh` exit=0 |' '' '## Scope' '' 'verify-scope: exit=0' '' '## Design sync' '' 'design-sync: SKIPPED (none)' '' '## Runtime' '' 'runtime: none (no runtime in this test)' '' '## Pre-existing failures' '' 'None' '' '## Failures' '' 'None' '' 'Verdict: PASS' > "$d/VERIFY.md"
  out=$(AS verifier submit LC --confidence high --findings none --agent o1 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "a command without an output line passed: $out"
  grep -rq 'printed output but the report records none' "$d/results" || die "no blocking finding names the missing output line"
  # a bare substring of the real output is not a match: the recorded line must equal a whole output line
  vw PASS 0 'ok' PASS
  out=$(AS verifier submit LC --confidence high --findings none --agent o2 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "a bare substring of the output passed: $out"
  # a changed output line with the same exit status is a mismatch (the re-run is not satisfied by exit alone)
  vw PASS 0 'ok 4 tests' PASS
  out=$(AS verifier submit LC --confidence high --findings none --agent o3 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "an output mismatch with equal exit passed: $out"
  grep -rq 'no output line equal to the recorded "ok 4 tests"' "$d/results" || die "no blocking finding names the output mismatch"
  ok "A107 R1: a command row needs a real output line that equals a whole re-run output line"
}
sc_evidence_gap_ac() {
  command -v node >/dev/null 2>&1 || { echo "skip evidence_gap_ac (node missing)"; return 0; }
  # R1-4: every command an AC row cites is re-run; one honest allowed command beside a fabricated one is FAIL
  SC_EXEMPT=1 evidence_gap_fixture
  printf '%s\n' '# Verification: LC' '' '## Commands' '' '- `sh .agents/local/check.sh` | exit=0' '  output: ok 3 tests' '- `npm run e2e -- --suite all` | exit=0' '  output: e2e: 40 passed' '' '## AC coverage' '' '| AC | test or command | status | evidence |' '|---|---|---|---|' \
    '| AC-1 | command: `npm run e2e -- --suite all` | PASS | `npm run e2e -- --suite all` exit=0 e2e: 40 passed |' '' '## Scope' '' 'verify-scope: exit=0' '' '## Design sync' '' 'design-sync: SKIPPED (none)' '' '## Runtime' '' 'runtime: none (no runtime in this test)' '' '## Pre-existing failures' '' 'None' '' '## Failures' '' 'None' '' 'Verdict: PASS' > "$d/VERIFY.md"
  out=$(AS verifier submit LC --confidence high --findings none --agent a1 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "a fabricated AC command passed beside an honest one: $out"
  grep -rq 'AC proof cites `npm run e2e -- --suite all`' "$d/results" || die "no blocking finding names the AC command"
  ok "A107 R1: a command cited as AC proof that cannot be re-run is a blocking finding"
}
sc_evidence_gap_r2() {
  evidence_gap_fixture
  # vwc VERDICT STATUS LINE...: VERIFY.md with the given `## Commands` lines; the AC row cites check.sh
  vwc() {
    vc_v=$1 vc_s=$2; shift 2
    { printf '%s\n' '# Verification: LC' '' '## Commands' ''; printf '%s\n' "$@"
      printf '%s\n' '' '## AC coverage' '' '| AC | test or command | status | evidence |' '|---|---|---|---|' "| AC-1 | impl_test.txt::lookup | $vc_s | \`sh .agents/local/check.sh\` exit=0 |" '' '## Scope' '' 'verify-scope: exit=0' '' \
        '## Design sync' '' 'design-sync: SKIPPED (none)' '' '## Runtime' '' 'runtime: none (no runtime in this test)' '' '## Pre-existing failures' '' 'None' '' '## Failures' '' 'None' '' "Verdict: $vc_v"; } > "$d/VERIFY.md"
  }
  CK='- `sh .agents/local/check.sh` | exit=0'
  # a silent command is listable: `output: (no output)` matches an empty re-run, the exit status decides
  vwc PASS PASS "$CK" '  output: ok 3 tests' '- `sh .agents/local/quiet.sh` | exit=0' '  output: (no output)'
  out=$(AS verifier submit LC --confidence high --findings none --agent r1 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier PASS' || die "a silent planned command with (no output) was not accepted: $out"
  vwc PASS PASS "$CK" '  output: ok 3 tests' '- `sh .agents/local/quiet.sh` | exit=0' '  output: all good'
  out=$(AS verifier submit LC --confidence high --findings none --agent r1b 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "an invented output line of a silent command passed: $out"
  # a non-empty re-run with `(no output)` recorded is a mismatch
  vwc PASS PASS '- `sh .agents/local/check.sh` | exit=0' '  output: (no output)'
  out=$(AS verifier submit LC --confidence high --findings none --agent r2 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "(no output) over a printing command passed: $out"
  grep -rq 'printed output but the report records none' "$d/results" || die "no finding names the unrecorded output"
  # a time or duration in the recorded line is refused with what to record
  vwc PASS PASS '- `sh .agents/local/check.sh` | exit=0' '  output: Ran 3 tests in 0.002s'
  out=$(AS verifier submit LC --confidence high --findings none --agent r3 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC verifier FAIL' || die "a timing line passed: $out"
  grep -rq 'record one stable summary line' "$d/results" || die "the refusal does not say what to record"
  # a plan hash that is not 64 hex denies every PLAN command: nothing planned can be re-run
  vwc PASS PASS "$CK" '  output: ok 3 tests'
  sed -i.bak 's|^  plan_sha256: .*|  plan_sha256: PENDING|' "$d/RUN.yaml"; rm -f "$d/RUN.yaml.bak"
  out=$(AS verifier submit LC --confidence high --findings none --agent r4 2>&1) || :
  printf '%s' "$out" | grep -q 'freeze mismatch' || die "a run without its frozen plan hash was not refused: $out"
  ok "A107 R2: silent commands are listable, timing lines are refused with what to record, a run without its frozen plan hash is refused by the freeze check"
}
sc_evidence_gap_files_gate() {
  evidence_gap_fixture
  mkdir -p "$d/reviews/proof-review/small" "$d/reports"; printf '# small review\n\nthe change was read.\n' > "$d/reviews/proof-review/small/REPORT.md"
  # a judgment gate citing a command that is not configured or planned: ignored, never blocking, recorded NOT_RERUN
  printf '%s\n' 'command: dotnet run -c Release' 'exit: 0' 'output: ok 3 tests' > "$d/reports/perf.txt"
  out=$(AS reviewer submit LC --focus rules+tests --confidence high --findings none --evidence reports/perf.txt --agent f1 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC reviewer PASS' || die "an unallowed command in a judgment gate blocked it: $out"
  grep -q '^not_rerun: ' "$(ls "$d"/gates/*REVIEW_SMALL.yaml | tail -1)" || die "no not_rerun field for the ignored command"
  # every triple of an evidence file is re-run: a bad first triple is not hidden by a good last one
  printf '%s\n' 'command: sh .agents/local/check.sh' 'exit: 5' 'output: ok 3 tests' 'command: sh .agents/local/check.sh' 'exit: 0' 'output: ok 3 tests' > "$d/reports/two.txt"
  out=$(AS reviewer submit LC --focus rules+tests --confidence high --findings none --evidence reports/two.txt --agent f2 2>&1) || die "refused: $out"
  printf '%s' "$out" | grep -q 'submitted: LC reviewer FAIL' || die "a failing first triple was hidden by the last one: $out"
  ok "A107 R2: an unallowed command in a judgment gate is NOT_RERUN, every triple of an evidence file is re-run"
}
sc_start() {
  new_repo; RID=ST-1
  cp "$tl_agents/task-integrations/markdown.sh" "$tl_agents/task-integrations/_lib.sh" "$tl_agents/task-integrations/slug.sh" .agents/task-integrations/
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

## Assumptions

none

## Behavior

Record task.

## Tests

Check the task.

## Verification commands

- `sh -n script.sh`
PLAN
  A freeze ST-1 >/dev/null || die 'start to freeze failed'
  [ "$(rv task_source revision)" != PENDING ] || die 'freeze left task source revision pending'
  new_repo; cp "$tl_agents/task-integrations/markdown.sh" "$tl_agents/task-integrations/_lib.sh" "$tl_agents/task-integrations/slug.sh" .agents/task-integrations/
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

# Evidence run: 33 criteria in PLAN ## Tests, test_trust.mutation_budget 20, REVIEW_TESTS BLOCKED twice. Now the
# freeze asks the user once, and a user-approved per-run raise (config untouched) resolves it.
sc_mutation_budget() {
  SC_PLAN_EXTRA=$(printf '\n## Tests\n\n'; i=1; while [ "$i" -le 33 ]; do printf -- '- AC-%s: `impl_test.txt` "case %s"\n' "$i" "$i"; i=$((i + 1)); done)
  export SC_PLAN_EXTRA; unfrozen STANDARD; unset SC_PLAN_EXTRA
  cfg_before=$(tsha .agents/config.yaml)
  expect_msg "a freeze with 33 criteria over budget 20" 'raise-budget LC 33' A freeze LC
  A freeze LC >/dev/null 2>&1 || :
  [ "$(ls .agents/runs/LC/approvals/*-request-mutation_budget.yaml | wc -l | tr -d ' ')" = 1 ] || die "the user was not asked exactly once"
  expect_fail "raise-budget without the user's approval" A raise-budget LC 33
  capture 'approve the mutation budget'; A approve LC mutation_budget >/dev/null
  expect_fail "a raise below the criteria count" A raise-budget LC 30
  A raise-budget LC 33 >/dev/null
  [ "$(cat .agents/runs/LC/mutation_budget)" = 33 ] || die "the run override was not recorded"
  [ "$(tsha .agents/config.yaml)" = "$cfg_before" ] || die "raise-budget edited .agents/config.yaml"
  A freeze LC >/dev/null || die "the freeze still fails after the approved raise"
  ok "mutation budget: freeze asks once, per-run raise needs the user's approval, config untouched"
}

# Evidence run: REVIEW_RULES and REVIEW_RULES:config were mixed in one report line. Each sub-focus has its own line.
sc_report_focus_lines() {
  scaffold standalone; printf 'KEY=\n' > .env.example
  A report-facts LC > "$base/rf.out"
  grep -q '^- Gate REVIEW_[A-Z]*: .*findings: none$' "$base/rf.out" && grep -q '^  - Focus REVIEW_[A-Z]*:config: [a-z_]*; findings: ' "$base/rf.out" || die "the config sub-focus has no line of its own: $(cat "$base/rf.out")"
  ok "report facts: a risk sub-focus is shown on its own line"
}

# A user edit of a control-plane file under .agents/ is no task change: verify-scope lists it apart, the tier ignores it.
sc_control_plane_edit() {
  scaffold standalone; solo RED fail impl_test.txt 'test: lookup returns the stored value'
  tier_before=$(A tier LC)
  printf '# user note\n' >> .agents/config.yaml; printf 'x\n' > .agents/extra.yaml
  A verify-scope LC > "$base/vs.out" || die "a user edit under .agents/ failed the scope check"
  grep -q 'control-plane files changed under .agents/' "$base/vs.out" && grep -q '\.agents/config\.yaml' "$base/vs.out" || die "the control-plane edits are not listed apart"
  [ "$(A tier LC)" = "$tier_before" ] || die "a control-plane edit raised the tier from $tier_before"
  printf 'x\n' > stray.go; expect_fail "a task-introduced path outside the scope passed" A verify-scope LC
  ok "control-plane edits under .agents/ are listed apart, not counted as task changes"
}

# A203: the `## Execution` table of the completion report is generated by the script from the decision records; what the lead wrote there is replaced.
sc_report_execution() {
  scaffold orchestrated; to_code_done orchestrated
  mkdir -p .agents/runs/LC/decisions
  printf 'role=implementer\nfocus=\nruntime=claude\nruntime_reason=CONFIG_RUNTIME_GROUP\nmodel=sonnet\neffort=medium\nescalated=no\nsignals=\n' > .agents/runs/LC/decisions/001-implementer.decision
  printf 'role=reviewer\nfocus=rules+tests\nruntime=codex\nruntime_reason=AUTOMATIC_FAILOVER\nmodel=gpt-6-sol\neffort=high\nescalated=yes\nescalation_reason=ESCALATED_MODEL\nsignals=low_confidence_pass\n' > .agents/runs/LC/decisions/002-reviewer-rules-tests.decision
  A report-execution LC > "$base/exec.md" || die "report-execution failed"
  grep -Fq '| implementer | - | claude | sonnet | medium | none | - |' "$base/exec.md" || die "implementer row missing: $(cat "$base/exec.md")"
  grep -Fq '| reviewer | rules+tests | codex | gpt-6-sol | high | low_confidence_pass | failover (automatic) to codex; escalated (ESCALATED_MODEL) |' "$base/exec.md" || die "failover row missing or wrong: $(cat "$base/exec.md")"
  ! grep -Fq OPERATOR_OVERRIDE "$base/exec.md" || die "an automatic failover is shown as an operator override"
  write_report   # the lead's own '## Execution' text says 'Not applicable in fixtures.'
  A publish-completion-report LC markdown >/dev/null || die "publish failed"
  r=.agents/runs/LC/COMPLETION_REPORT.md
  grep -Fq '| reviewer | rules+tests | codex | gpt-6-sol | high |' "$r" || die "the published report has no generated Execution row"
  ! grep -Fq 'Not applicable in fixtures' "$r" || die "the lead's hand-written Execution text survived publish"
  [ "$(grep -c '^## Execution' "$r")" = 1 ] || die "the Execution heading is not unique"
  ok "A203 the Execution table is generated from the decision records and replaces the lead's text"
}

run_sc sc_report_execution
run_sc sc_tier
run_sc sc_control_plane_edit
run_sc sc_report_focus_lines
run_sc sc_mutation_budget
run_sc sc_tier_paths
run_sc sc_record
run_sc sc_submit
run_sc sc_language
run_sc sc_report_stdin
run_sc sc_stdin_contract
run_sc sc_parallel_lock
run_sc sc_lock_break_race
run_sc sc_report_names
run_sc sc_explorer_limit
run_sc sc_fix_loop
run_sc sc_waiver
run_sc sc_approvals
run_sc sc_question_language
run_sc sc_supervised_destructive
run_sc sc_destructive_refreeze
run_sc sc_capture_integrity
run_sc sc_approval_retry
run_sc sc_ask
run_sc sc_knowledge_gates_fresh
run_sc sc_knowledge_done_needs_page_and_lint
run_sc sc_knowledge_drift
run_sc sc_split_override
run_sc sc_scope_content
run_sc sc_batch_split_answer
run_sc sc_assumptions
run_sc sc_questions
run_sc sc_questions_keys
run_sc sc_questions_grill
run_sc sc_next
run_sc sc_decide
run_sc sc_config_scope_misc
# A161 (#133): gates recorded by 0.0.12/0.0.13 (a block-only AGENTS.md/CLAUDE.md still part of the tree) stay valid once, without writing
# anything; they bind every product byte; gates recorded on the current rule never need the legacy path.
legacy_agent() { # on: the fixture script with the pre-A156 fingerprint rule; off: the real one
  if [ "$1" = on ]; then
    git update-index --assume-unchanged .agents/scripts/agent.sh 2>/dev/null || :
    cp .agents/scripts/agent.sh "$base/agent.real"; grep -vF 'block_only_file "$root/$cf_b"; then git' "$base/agent.real" > .agents/scripts/agent.sh
    if cmp -s "$base/agent.real" .agents/scripts/agent.sh; then die "could not build the legacy fingerprint script"; fi
  else cp "$base/agent.real" .agents/scripts/agent.sh; fi
}
sc_legacy_fingerprint() {
  scaffold orchestrated; blk='<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n'
  printf '%b' "$blk" > AGENTS.md; git add AGENTS.md; git commit -qm 'chore: block-only AGENTS.md'
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  fp_new=$(A fingerprint LC); legacy_agent on; fp_old=$(A fingerprint LC)
  [ "$fp_old" != "$fp_new" ] || die "the legacy script computes the current fingerprint: the fixture proves nothing"
  pass_all >/dev/null 2>&1 || die "gates on the legacy rule not recorded"
  legacy_agent off
  [ "$(A fingerprint LC)" = "$fp_new" ] || die "the current script no longer computes the current fingerprint"
  n0=$(n_gates)
  A pipeline LC | grep '^gate\.' | grep -v '=pass' && die "gates recorded on the legacy rule read stale or missing"
  A pipeline LC | grep -q '^gate\.' || die "no gate lines"
  A handoff LC CODE_DONE >/dev/null || die "CODE_DONE refused for gates recorded on the legacy rule: $(A handoff LC CODE_DONE 2>&1 | tail -2)"
  [ "$(n_gates)" = "$n0" ] || die "the compatibility wrote a gate record"
  # the binding is kept: a product edit makes every such gate stale
  printf 'one more line\n' >> impl.txt
  A pipeline LC | grep '^gate\.' | grep -q '=pass' && die "a product edit left a legacy gate passing: $(A pipeline LC | grep '^gate\.')"
  A pipeline LC | grep -q '^gate\..*=stale' || die "a product edit did not stale the legacy gates: $(A pipeline LC | grep '^gate\.')"
  ok "legacy gate fingerprint (0.0.12/0.0.13) with a block-only file is accepted without writing a gate record, and a product edit stales it"

}
sc_legacy_fingerprint_new_rule() {
  scaffold orchestrated; printf '<!-- proofline:begin -->\nblock v1\n<!-- proofline:end -->\n' > AGENTS.md; git add AGENTS.md; git commit -qm 'chore: block-only AGENTS.md'
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null; pass_all >/dev/null 2>&1
  A pipeline LC | grep '^gate\.' | grep -v '=pass' && die "gates on the current rule are not fresh"
  printf 'one more line\n' >> impl.txt
  A pipeline LC | grep -q '^gate\..*=stale' || die "a product edit did not stale the current-rule gates"
  A pipeline LC | grep '^gate\.' | grep -q '=pass' && die "a current-rule gate survived a product edit via the legacy path"
  ok "gates recorded on the current rule are stale after a product edit; the legacy path never revives them"
}

# A171: the build record is made before the review gate wave (at handoff IMPLEMENTED) and, when it is missing,
# `next` names it as a missing step before any review gate.
sc_build_record_auto() {
  scaffold standalone no STANDARD manual
  cp "$tl_agents/scripts/build-record.sh" .agents/scripts/
  sed -i.bak 's|^  build:.*|  build: echo built-line|; s|^  test:.*|  test: echo tested-line|' .agents/config.yaml && rm -f .agents/config.yaml.bak
  A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  implemented SOLO
  rc=0; A build-record LC show >/dev/null 2>&1 || rc=$?; [ "$rc" -eq 0 ] || die "handoff IMPLEMENTED did not make the build record (show exit $rc)"
  A build-record LC show | grep -q tested-line || die "the automatic record lacks the test output"
  ok "build record: made at handoff IMPLEMENTED, before the review gate wave"
  # a tree without a record (here: config added after the handoff) shows the step first in next
  rm -rf .agents/local/builds
  nx=$(A next LC)
  printf '%s\n' "$nx" | grep -Fq 'next=agent.sh build-record LC run' || die "next does not show the missing build record: $nx"
  [ "$(printf '%s\n' "$nx" | grep -n 'next=' | head -1 | grep -c 'build-record')" = 1 ] || die "the build record is not the first step: $nx"
  A build-record LC run >/dev/null
  ! A next LC | grep -Fq 'build-record' || die "next still names the build record after it was made"
  ok "next shows a missing build record as the first missing step and drops it once made"
}

run_sc sc_secret_scan
run_sc sc_provenance
run_sc sc_waiver_rebind
run_sc sc_open_runs
run_sc sc_report_finding_ids
run_sc sc_report_facts
run_sc sc_knowledge_secrets
run_sc sc_wiki_knowledge_scope
run_sc sc_design_surfaces
run_sc sc_knowledge_na
run_sc sc_next_order
run_sc sc_start
run_sc sc_qa_plan_bound
run_sc sc_artifact_snapshots
run_sc sc_debug_result
run_sc sc_task_types
run_sc sc_scratch_worktrees
run_sc sc_worktree_lock_folder
run_sc sc_tests_findings
run_sc sc_defect_scope
run_sc sc_intent_provenance
run_sc sc_folded_defect
run_sc sc_class_floor
run_sc sc_design_sync
run_sc sc_validation_plan
run_sc sc_validation_qa
run_sc sc_validation_refreeze
run_sc sc_validation_node
run_sc sc_validation_config
run_sc sc_validation_tiers
run_sc sc_validation_info_only
run_sc sc_evidence_gap_fabricated
run_sc sc_evidence_gap_files
run_sc sc_evidence_gap_rerun
run_sc sc_evidence_gap_gates
run_sc sc_evidence_gap_legacy
run_sc sc_evidence_gap_output
run_sc sc_evidence_gap_ac
run_sc sc_evidence_gap_r2
run_sc sc_evidence_gap_files_gate
run_sc sc_legacy_fingerprint
run_sc sc_legacy_fingerprint_new_rule
run_sc sc_build_record_auto
run_sc sc_fix_round_missed_example
run_sc sc_fix_round_copied_line
run_sc sc_scan_method
run_sc sc_classification_stable
run_sc sc_doc_scope_warning
run_sc sc_takeover_without_red
run_sc sc_a200_misc
run_sc sc_selective_rerun
run_sc sc_amend_carry
run_sc sc_visual_row_match
run_sc sc_test_path_kind
run_sc sc_scope_kind_column
run_sc sc_scope_kind_gate_rerun
run_sc sc_rollback_note
run_sc sc_summary_human_checks
echo 'gates tests passed'
