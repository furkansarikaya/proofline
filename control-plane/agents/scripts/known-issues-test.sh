#!/bin/sh
# Tests for the known-issues list (A202, item 27): a finding that was already there and that the task does not touch is not blocking,
# but only on the USER's approval of exactly that record; every forbidden shortcut is attempted here.
# shellcheck disable=SC2010,SC2012,SC2015,SC2016,SC2154,SC2329 # test code: assertion chains; tl_agents, base come from test-lib.sh
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"

gate_st() { A pipeline "$RID" | sed -n "s/^gate.$1=//p"; }
TXT='the legacy ignore list drops a documented entry'
PLACE='.gitignore:1'
KI_DIR=.agents/local/known-issues
# mk_run [PLACE] [TEXT] [GATE]: a frozen STANDARD run at IMPLEMENTED whose GATE (default QA) failed on the finding; the rest passed
mk_run() {
  mr_place=${1:-$PLACE} mr_text=${2:-$TXT} mr_gate=${3:-QA}
  scaffold standalone no STANDARD autonomous
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null
  for mr_g in $(required); do case "$mr_g" in SECRETS|VERIFY|"$mr_gate") ;; *) gpass "$mr_g" ;; esac; done
  rec "$mr_gate" FAIL high "$mr_gate-1|blocking|$mr_place|$mr_text|traced: the entry is missing from the list; scan: grep -n entry .gitignore; instances: single"
  gpass VERIFY
}
mk_followup() { mkdir -p .agents/tasks/todo; printf '# Task: %s — Fix the legacy ignore list\n\n**Status:** todo\n\n## Goal\n\nFix it.\n' "$1" > ".agents/tasks/todo/$1.md"; }
# user_says TEXT KIND: the user's message arrives after the request
user_says() { capture "$1" "$(( $(date +%s) + 7200 ))"; A approve - "${2:-known-issue}" >/dev/null; }
# list_it: propose, approve, apply (the legitimate route, the user's own words)
list_it() { mk_followup "${1:-FU-9}"; A known-issue-propose LC QA-1 --followup "${1:-FU-9}" >/dev/null; user_says 'approve known issue'; A known-issue-apply >/dev/null; }

# traps k (a record exists only by the user's approval; an agent cannot add, edit or approve), l (a fabricated record never matches)
sc_agent_cannot() {
  mk_run
  [ "$(gate_st QA)" = fail ] || die "the finding does not block before any record: $(gate_st QA)"
  mk_followup FU-9
  expect_msg "a reviewer proposed a record" 'denied for reviewer' AS reviewer known-issue-propose LC QA-1 --followup FU-9
  expect_msg "a reviewer applied a record" 'denied for implementer' AS implementer known-issue-apply
  expect_msg "a record without a follow-up task" 'follow-up task' A known-issue-propose LC QA-1
  expect_msg "a follow-up task that does not exist" 'not an open markdown task' A known-issue-propose LC QA-1 --followup NOPE-1
  A known-issue-propose LC QA-1 --followup FU-9 | grep -q 'approve' || die "the request was not made"
  expect_msg "applied without the user's approval" "needs the user's approval" A known-issue-apply
  # a message that is not an approval of this kind, then one that is ambiguous: nothing is recorded
  for t in 'ok' 'approve the plan' 'I think the known issue is fine, maybe?' 'approve known issue but not the other one'; do
    capture "$t" "$(( $(date +%s) + 7200 ))"; expect_fail "'$t' approved a known issue" A approve - known-issue
  done
  expect_msg "applied after refused replies" "needs the user's approval" A known-issue-apply
  [ ! -s "$KI_DIR/LIST.tsv" ] || die "a list exists without an approval"
  [ "$(gate_st QA)" = fail ] || die "an unapproved proposal made the finding non-blocking"
  # hand-written list rows and hand-written approvals are not the user's
  mkdir -p "$KI_DIR"
  printf 'KI-1\tQA\t%s\t%s\tFU-9\t001-known-issue.yaml\t2026-01-01\n' "$PLACE" "$TXT" > "$KI_DIR/LIST.tsv"
  [ "$(gate_st QA)" = fail ] || die "a hand-written record (no approval file) made the finding non-blocking"
  mkdir -p .agents/local/approvals
  printf 'kind: "known-issue"\nbound: "%s"\nanswered_by: "user"\nsource: "prompt_capture"\nconsumed: "true"\n' "$(printf 'QA\t%s\t%s\tFU-9\n' "$PLACE" "$TXT" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -d' ' -f1)" > .agents/local/approvals/001-known-issue.yaml
  [ "$(gate_st QA)" = fail ] || die "a hand-written approval without a capture and a request made the finding non-blocking"
  ok "known issue: only the user's approval creates a record; an agent role, a missing or ambiguous reply, a hand-written row and a hand-written approval do not"
}

# traps l, o, p: the happy path, exact match, shown not hidden, the follow-up closes the record
sc_flow() {
  mk_run; list_it FU-9
  A known-issue-list | grep -q 'KI-1 \[active\] QA .gitignore:1' || die "the record is not listed: $(A known-issue-list)"
  [ "$(gate_st QA)" = waived ] || die "a listed untouched finding still blocks: $(gate_st QA)"
  grep -q '^finding: QA-1|blocking|' .agents/runs/LC/gates/*QA*.yaml || die "the gate record lost the finding"
  A handoff LC CODE_DONE >/dev/null || die "CODE_DONE refused with only a known issue open"
  facts=$(A report-facts LC)
  printf '%s\n' "$facts" | grep -Fq 'Gate QA: waived (known issue: KI-1:QA-1:FU-9)' || die "the gate label hides the known issue: $facts"
  printf '%s\n' "$facts" | grep -Fq 'Known issue (not blocking, the gate record keeps the finding): QA-1 in gate QA, record KI-1, follow-up task FU-9' || die "the Facts block hides the known issue: $facts"
  # the record drops when its follow-up task is done, computed from the task state
  mkdir -p .agents/tasks/done; mv .agents/tasks/todo/FU-9.md .agents/tasks/done/FU-9.md; tc_status .agents/tasks/done/FU-9.md 'done'
  A known-issue-list | grep -q 'KI-1 \[closed\]' || die "a done follow-up did not close the record: $(A known-issue-list)"
  [ "$(gate_st QA)" = fail ] || die "the finding stays non-blocking after its follow-up task is done: $(gate_st QA)"
  ok "known issue: untouched listed finding is non-blocking, shown with record id and follow-up in the Facts block and the gate label, kept in the gate record; a done follow-up drops the record"
}

# trap l: exact matching, never fuzzy
sc_near_miss() {
  mk_run; list_it FU-9
  [ "$(gate_st QA)" = waived ] || die "the exact finding is not matched"
  n=1
  for variant in "$PLACE|$TXT." "$PLACE|$(printf '%s' "$TXT" | tr '[:lower:]' '[:upper:]')" ".gitignore:2|$TXT" ".gitignore|$TXT" "tasks/LC.md:1|$TXT" "$PLACE|the legacy ignore list drops an entry"; do
    n=$((n + 1))
    rec QA FAIL high "QA-$n|blocking|${variant%%|*}|${variant#*|}|traced: x; scan: grep -n entry .gitignore; instances: single"
    [ "$(gate_st QA)" = fail ] || die "a near miss matched the record: $variant"
  done
  # same place and text under another gate is another finding kind
  og=VERIFY
  rec "$og" FAIL high "$og-1|blocking|$PLACE|$TXT|traced: x; scan: grep -n entry .gitignore; instances: single"
  [ "$(gate_st "$og")" = fail ] || die "the same text under another gate ($og) matched: $(gate_st "$og")"
  ok "known issue: gate, place and text are matched exactly; a changed line, text, case, gate or a missing line stays blocking"
}
sc_new_finding() {
  mk_run; list_it FU-9
  rec QA FAIL high "QA-1|blocking|$PLACE|$TXT|traced: the entry is missing" "QA-2|blocking|.gitignore:3|a second finding nobody listed|traced: x"
  [ "$(gate_st QA)" = fail ] || die "a new finding next to a listed one was let through: $(gate_st QA)"
  ok "known issue: a gate with a new blocking finding next to the listed one still blocks"
}

# trap m: a task that touches the place keeps the finding blocking (frozen scope and the actual diff)
sc_touched() {
  SC_SCOPE_OTHER=AC-1 mk_run far.txt:1 "$TXT"
  list_it FU-9
  [ "$(gate_st QA)" = fail ] || die "a finding in a file of the frozen scope was let through: $(gate_st QA)"
  # the diff: a tracked file outside the plan scope that the task changed (a control-plane file is not a scope violation)
  scaffold standalone no STANDARD autonomous
  tf=$(ls .agents/templates/* | head -1)
  printf '\n# touched by the task\n' >> "$tf"
  solo RED fail impl_test.txt 'test: lookup returns the stored value'; solo GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null
  for g in $(required); do case "$g" in SECRETS|VERIFY|QA) ;; *) gpass "$g" ;; esac; done
  rec QA FAIL high "QA-1|blocking|$tf:1|$TXT|traced: x"
  gpass VERIFY
  mk_followup FU-9; A known-issue-propose LC QA-1 --followup FU-9 >/dev/null; user_says 'approve known issue'; A known-issue-apply >/dev/null
  [ "$(gate_st QA)" = fail ] || die "a finding in a file the task changed was let through: $(gate_st QA)"
  ok "known issue: a place in the frozen scope or in the task's actual diff keeps the finding blocking"
}

# trap n: SECRETS and SECURITY are never listed
sc_never_secrets() {
  scaffold standalone no STANDARD autonomous
  solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null; [ "$(gate_st SECRETS)" = fail ] || die "the planted secret was not found"
  mk_followup FU-9
  expect_msg "a SECRETS finding was proposed" 'never listed' A known-issue-propose LC SECRETS-1 --followup FU-9
  # even a perfectly approved record of a SECRETS or SECURITY finding is ignored when it is found in the file
  for g in SECRETS SECURITY; do
    row=$(printf '%s\t%s\t%s\tFU-9\n' "$g" "$PLACE" "x") ; h=$(printf '%s\n' "$row" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -d' ' -f1)
    mkdir -p .agents/local/approvals "$KI_DIR"
    printf 'kind: "known-issue"\nbound: "%s"\nanswered_by: "user"\nsource: "prompt_capture"\ncapture_id: "s1:1:x"\nrequest: "001-request-known-issue.yaml"\nconsumed: "true"\n' "$h" > .agents/local/approvals/001-known-issue.yaml
    printf 'kind: "known-issue"\nbound: "%s"\nrequested_at: 1\n' "$h" > .agents/local/approvals/001-request-known-issue.yaml
    printf 'KI-1\t%s\t%s\tx\tFU-9\t001-known-issue.yaml\t2026-01-01\n' "$g" "$PLACE" > "$KI_DIR/LIST.tsv"
    A known-issue-list | grep -q 'KI-1 \[invalid\]' || die "a $g record is not invalid: $(A known-issue-list)"
  done
  [ "$(gate_st SECRETS)" = fail ] || die "a SECRETS record in the file made the finding non-blocking"
  # SECURITY, proposed through the command
  unfrozen_sec() { scaffold standalone no CRITICAL manual; approve_as_user plan 'approve the plan'; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null; }
  unfrozen_sec
  solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'impl: lookup'; A handoff LC IMPLEMENTED >/dev/null
  rec SECURITY FAIL high "SECURITY-1|blocking|$PLACE|injection reachable from input|traced: input -> eval"
  mk_followup FU-9
  expect_msg "a SECURITY finding was proposed" 'never listed' A known-issue-propose LC SECURITY-1 --followup FU-9
  ok "known issue: SECRETS and SECURITY findings are refused at proposal and ignored when found in the file"
}

# trap p: a record without a follow-up task is not valid; unusable places are refused
sc_invalid() {
  mk_run
  mk_followup FU-9
  expect_msg "a follow-up that is already done" 'already done' sh -c 'mkdir -p .agents/tasks/done; printf "# Task: FU-8 — x\n\n**Status:** done\n" > .agents/tasks/done/FU-8.md; sh ./.agents/scripts/agent.sh known-issue-propose LC QA-1 --followup FU-8'
  # a record whose follow-up task vanished is not valid (unknown = the safe side)
  list_it FU-7
  [ "$(gate_st QA)" = waived ] || die "setup: $(gate_st QA)"
  rm -f .agents/tasks/todo/FU-7.md
  A known-issue-list | grep -q 'KI-1 \[invalid\]' || die "a record with no follow-up task is valid: $(A known-issue-list)"
  [ "$(gate_st QA)" = fail ] || die "a record whose follow-up task does not exist still unblocks"
  # an edited row (the follow-up changed after the approval) has no approval for its content
  mk_run; list_it FU-6
  sed -i.bak 's/FU-6/FU-9/' "$KI_DIR/LIST.tsv"; rm -f "$KI_DIR/LIST.tsv.bak"
  [ "$(gate_st QA)" = fail ] || die "an edited record still unblocks"
  # places that cannot be computed
  mk_run - "$TXT"
  mk_followup FU-9
  expect_msg "a finding without a place was proposed" 'cannot be listed' A known-issue-propose LC QA-1 --followup FU-9
  mk_run no-such-file.txt:3 "$TXT"
  expect_msg "a finding in an untracked file was proposed" 'cannot be listed' A known-issue-propose LC QA-1 --followup FU-9
  ok "known issue: no follow-up, a vanished follow-up, an edited row, no place or an untracked place are never a valid record"
}

# trap q: the pre-flight source of candidates
sc_candidates() {
  mk_run
  A known-issue-candidates | grep -q "LC	QA-1	QA	$PLACE	$TXT" || die "the recorded finding is not a candidate: $(A known-issue-candidates)"
  list_it FU-9
  [ -z "$(A known-issue-candidates)" ] || die "a listed finding is still a candidate: $(A known-issue-candidates)"
  ok "known issue: candidates are recorded blocking findings of runs on this machine whose scope did not cover the place and that are not on the list"
}

# batch_with LETTER SUMMARY-LINE...: a hand-built batch of LC that the user approved (their message), with their answer to the accept question
batch_with() {
  bw_l=$1; shift; bw_d=.agents/local/batch; rm -rf "$bw_d"; mkdir -p "$bw_d" .agents/local/prompts/history
  { printf '# Night batch\n\nnonce: t-%s\n\n## Expected known issues and rationales (accept for this batch)\n\n' "$$"; for bw_x in "$@"; do printf -- '- %s\n' "$bw_x"; done; } > "$bw_d/SUMMARY.md"
  printf 'LC\tSTANDARD\t-\n' > "$bw_d/order.tsv"
  A request-approval - batch >/dev/null; capture 'approve batch' "$(( $(date +%s) + 7200 ))"; A approve - batch >/dev/null || die "the batch approval was refused"
  bw_b=$( { shasum -a 256 2>/dev/null || sha256sum; } < "$bw_d/SUMMARY.md" | cut -c1-12)
  printf 'x\n' > .agents/local/prompts/history/1-aaaa1111.txt
  printf '%s\tbatch\tQ1\taccept\t%s\t-\t1-aaaa1111.txt\n' "$bw_b" "$bw_l" > "$bw_d/answers.tsv"
}

# The batch approval lets the user accept the expected findings and rationales with ONE answer: a listed finding of a task of the batch
# that does not touch it asks nothing; everything else (another answer, another finding, SECRETS, SECURITY) stays as it was.
sc_batch_accept() {
  mk_run
  batch_with a "accept K QA $PLACE: $TXT"
  [ "$(gate_st QA)" = fail ] || die "an accept answer of a (no) was taken as an acceptance: $(gate_st QA)"
  batch_with b "accept K QA $PLACE: $TXT"
  [ "$(gate_st QA)" = waived ] || die "a finding accepted for the batch still stops the task: $(gate_st QA)"
  rec QA FAIL high "QA-1|blocking|$PLACE|$TXT|traced: x" "QA-2|blocking|.gitignore:3|a second finding nobody listed|traced: x"
  [ "$(gate_st QA)" = fail ] || die "an unlisted finding next to an accepted one was let through: $(gate_st QA)"
  rec QA FAIL high "QA-1|blocking|$PLACE|$TXT|traced: x"
  batch_with b "accept K QA $PLACE: another text"
  [ "$(gate_st QA)" = fail ] || die "a finding that is not on the approved summary was accepted: $(gate_st QA)"
  batch_with b "accept K QA $PLACE: $TXT"; printf 'LC2\tSTANDARD\t-\n' > .agents/local/batch/order.tsv
  [ "$(gate_st QA)" = fail ] || die "a task outside the batch used the batch acceptance: $(gate_st QA)"
  batch_with b "accept K QA $PLACE: $TXT"; echo 'tampered' >> .agents/local/batch/SUMMARY.md
  [ "$(gate_st QA)" = fail ] || die "an edited summary (no approval of its content) accepted a finding: $(gate_st QA)"
  batch_with b "accept K QA $PLACE: $TXT"; rm -f .agents/local/prompts/history/1-aaaa1111.txt
  [ "$(gate_st QA)" = fail ] || die "an answer without a captured user message accepted a finding: $(gate_st QA)"
  ok "batch accept: one answer b accepts the listed findings for the batch; answer a, another finding, a task outside the batch, an edited summary or no captured message do not"
}
sc_batch_accept_never() {
  # SECURITY: even a summary that lists it and an answer b do not accept it
  scaffold standalone no CRITICAL manual; approve_as_user plan 'approve the plan'; A freeze LC >/dev/null; A handoff LC IMPLEMENTING >/dev/null
  solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'impl: lookup'; A handoff LC IMPLEMENTED >/dev/null
  rec SECURITY FAIL high "SECURITY-1|blocking|$PLACE|$TXT|traced: input -> eval"
  batch_with b "accept K SECURITY $PLACE: $TXT"
  [ "$(gate_st SECURITY)" = fail ] || die "a SECURITY finding was accepted by the batch answer: $(gate_st SECURITY)"
  scaffold standalone no STANDARD autonomous
  solo RED fail impl_test.txt 'test: lookup'; solo GREEN pass impl.txt 'PLANTED_SECRET=abc'; A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null; [ "$(gate_st SECRETS)" = fail ] || die "the planted secret was not found"
  sf=$(ls .agents/runs/LC/gates/*-SECRETS.yaml | tail -1)
  sl=$(sed -n 's/^finding: SECRETS-1|blocking|\([^|]*\)|\(.*\)$/\1 \2/p' "$sf" | head -1)
  batch_with b "accept K SECRETS ${sl%% *}: ${sl#* }"
  [ "$(gate_st SECRETS)" = fail ] || die "a SECRETS finding was accepted by the batch answer: $(gate_st SECRETS)"
  ok "batch accept: a SECURITY and a SECRETS finding are never accepted this way, whatever the summary and the answer say"
}
sc_batch_accept_rationale() {
  mk_run
  printf '# Design\n\n## Pattern justifications\n\n- mono-labels: file names are the product here\n' > DESIGN.md
  A request-approval LC rationale:mono-labels >/dev/null
  batch_with a "accept R mono-labels: file names are the product here"
  expect_fail "a rationale covered although the user answered a" A batch-cover LC rationale:mono-labels
  batch_with b "accept R mono-labels: file names are the product here"
  A request-approval LC rationale:mono-labels >/dev/null
  A batch-cover LC rationale:mono-labels > "$base/cover.out" 2>&1 || die "the accepted rationale was refused: $(cat "$base/cover.out")"
  [ "$(A design-rationales LC | cut -f1,2)" = "$(printf 'mono-labels\tapproved')" ] || die "the accepted rationale is not approved: $(A design-rationales LC)"
  printf '# Design\n\n## Pattern justifications\n\n- mono-labels: changed after the user accepted it\n' > DESIGN.md
  A request-approval LC rationale:mono-labels >/dev/null
  expect_fail "an edited DESIGN.md line covered by the old acceptance" A batch-cover LC rationale:mono-labels
  expect_msg "a waiver covered by the batch" "not covered by the batch approval" A batch-cover LC waive:QA-1
  ok "batch accept: a listed rationale is approved for the batch only with answer b and only as the approved summary lists it"
}

# review B4: a place with //, /./ , .. or a trailing dot segment is not a place (one spelling, so the touch check cannot be evaded)
sc_place_spelling() {
  mk_run
  for bp in './.gitignore:1' 'a//b.txt:1' 'src/./a.txt:1' 'src/../.gitignore:1' 'src/.' '.gitignore/:1' '.gitignore//'; do
    expect_msg "place [$bp] was accepted" 'is not a repository path' env KI_DIR="$base/ki" KI_APPROVALS="$base/ki" KI_TASKS="$base/ki" KI_MAIN="$PWD" sh "$tl_agents/scripts/known-issues.sh" listable QA "$bp"
  done
  env KI_DIR="$base/ki" KI_APPROVALS="$base/ki" KI_TASKS="$base/ki" KI_MAIN="$PWD" sh "$tl_agents/scripts/known-issues.sh" listable QA .gitignore:1 >/dev/null 2>&1 || :   # the plain spelling is not refused for its spelling
  ok "known issue: a place spelled with //, /./, .. or a trailing / is refused"
}
run_sc sc_place_spelling
run_sc sc_agent_cannot
run_sc sc_flow
run_sc sc_near_miss
run_sc sc_new_finding
run_sc sc_touched
run_sc sc_never_secrets
run_sc sc_invalid
run_sc sc_candidates
run_sc sc_batch_accept
run_sc sc_batch_accept_never
run_sc sc_batch_accept_rationale
