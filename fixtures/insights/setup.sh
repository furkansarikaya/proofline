#!/bin/sh
# Builds the insights fixture in $1: an installed-looking project (config + stub agent.sh, not a working
# control plane) holding planted metrics records and three runs whose ledgers and gate records contain known
# patterns and traps. `proofline insights` only reads these files. Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then echo "error: target directory is not empty: $1" >&2; exit 1; fi
mkdir -p "$1"; cd "$1"
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
git init -q; git symbolic-ref HEAD refs/heads/main; git config commit.gpgsign false
printf '# app\n' > README.md; git add README.md; git commit -q -m init
mkdir -p .agents/scripts .agents/local/metrics
printf 'proofline_version: 0.0.36\nmetrics: on\n' > .agents/config.yaml
printf '#!/bin/sh\nexit 0\n' > .agents/scripts/agent.sh

H=0000000000000000000000000000000000000000000000000000000000000000
# row RUN SEQ EVENT DETAIL -> one ledger row (the chain fields are placeholders: insights does not verify the chain)
row() { printf 'seq=%s prev=%s event=%s role=lead from=- to=- digest=%s ts=2026-10-13T10:00:00Z epoch=1760349600 detail=%s\n' "$2" "$H" "$3" "$H" "$4" >> ".agents/runs/$1/LEDGER.log"; }
gate() { # RUN NAME GATE RESULT FINDINGS... : gate record file plus the ledger row that binds it
  g_r=$1 g_n=$2 g_g=$3 g_res=$4; shift 4
  { printf 'task_id: "%s"\ngate: "%s"\nresult: "%s"\n' "$g_r" "$g_g" "$g_res"; for f in "$@"; do printf 'finding: %s\n' "$f"; done; } > ".agents/runs/$g_r/gates/$g_n-$g_g.yaml"
  row "$g_r" "$SEQ" "gate:$g_g:$g_res" "gates/$g_n-$g_g.yaml@$H by reviewer"; SEQ=$((SEQ + 1))
}
mk() { mkdir -p ".agents/runs/$1/gates" ".agents/runs/$1/results"; : > ".agents/runs/$1/LEDGER.log"; SEQ=1; }

mk RUN-A
row RUN-A 1 start "task=TASK.md adapter=markdown"; SEQ=2
row RUN-A "$SEQ" approval-request "plan bound=x"; SEQ=$((SEQ + 1))
row RUN-A "$SEQ" approval-request "plan bound=x"; SEQ=$((SEQ + 1))
row RUN-A "$SEQ" approval-request "plan bound=y"; SEQ=$((SEQ + 1))
row RUN-A "$SEQ" approval "approvals/001-plan.yaml@$H plan source=prompt_capture answered_by=user bound=y"; SEQ=$((SEQ + 1))
gate RUN-A 001 REVIEW_RULES fail \
  'REVIEW_RULES-1|blocking|src/a.go:10|Error from Close is ignored|rules-1' \
  'REVIEW_RULES-2|blocking|src/a.go:20|Error from Open is ignored|rules-1' \
  'REVIEW_RULES-3|blocking|src/z.go:1|src/z.go changed outside the frozen scope|diff' \
  'REVIEW_RULES-4|info|src/a.go:1|Consider a doc comment|style'
gate RUN-A 002 REVIEW_RULES fail \
  'REVIEW_RULES-1|blocking|src/a.go:14|Error from Close is ignored|rules-1' \
  'REVIEW_RULES-2|info|src/a.go:1|Consider a doc comment|style'
gate RUN-A 003 REVIEW_RULES pass
printf '%s\n' '| REVIEW-1 | blocking | - | UNSUPPORTED: no benchmark tool in the project | none |' 'prose line without the keyword' > .agents/runs/RUN-A/results/001-reviewer.result.md
row RUN-A "$SEQ" "record:reviewer:FAIL" "results/001-reviewer.result.md sha256=$H gate=REVIEW_RULES"; SEQ=$((SEQ + 1))

mk RUN-B
row RUN-B 1 start "task=TASK.md adapter=markdown"; SEQ=2
row RUN-B "$SEQ" approval-request "destructive bound=x"; SEQ=$((SEQ + 1))
row RUN-B "$SEQ" approval "approvals/001-destructive.yaml@$H destructive source=tty answered_by=user bound=x"; SEQ=$((SEQ + 1))
gate RUN-B 001 REVIEW_RULES fail 'REVIEW_RULES-1|blocking|src/a.go:33|Error from Close is ignored|rules-1'
gate RUN-B 002 SECURITY fail 'SECURITY-1|blocking|src/b.go:5|Edit of src/b.go is out of scope for this plan|diff'
# trap: a gate record no ledger row binds (hand-written); it must not be counted
printf 'task_id: "RUN-B"\ngate: "QA"\nresult: "fail"\nfinding: QA-1|blocking|src/a.go:40|Error from Close is ignored|x\n' > .agents/runs/RUN-B/gates/009-QA.yaml
printf '%s\n' '| REVIEW-1 | blocking | - | UNSUPPORTED: no benchmark tool in the project | none |' > .agents/runs/RUN-B/results/001-reviewer.result.md
row RUN-B "$SEQ" "record:reviewer:FAIL" "results/001-reviewer.result.md sha256=$H gate=REVIEW_RULES"; SEQ=$((SEQ + 1))

mk RUN-C
row RUN-C 1 start "task=TASK.md adapter=markdown"
printf '%s\n' '| QA-1 | blocking | - | UNSUPPORTED: no headless browser installed | none |' > .agents/runs/RUN-C/results/001-qa.result.md
row RUN-C 2 "record:qa:BLOCKED" "results/001-qa.result.md sha256=$H gate=QA"

R=.agents/local/metrics/records.jsonl
rec() { # KIND TASK ROLE FOCUS GATE MODEL DUR TIN TOUT TOTAL RETRIES DELEG FIX RESULT  (null is the word null; strings are bare words)
  s() { case "$1" in null) printf null ;; *) printf '"%s"' "$1" ;; esac; }
  printf '{"schema":"proofline.metrics/1","kind":"%s","time":"2026-10-13T10:00:00Z","task":"%s","role":%s,"focus":%s,"gate":%s,"runtime":"claude","model":%s,"duration_s":%s,"tokens_in":%s,"tokens_out":%s,"tokens_total":%s,"turns":null,"retries":%s,"delegations":%s,"fix_rounds":%s,"result":%s}\n' \
    "$1" "$2" "$(s "$3")" "$(s "$4")" "$(s "$5")" "$(s "$6")" "$7" "$8" "$9" "${10}" "${11}" "${12}" "${13}" "$(s "${14}")" >> "$R"
}
# Claude-style records carry in, out and total = in + out; a Codex-style record carries only tokens_total
rec dispatch RUN-A reviewer rules REVIEW_RULES sonnet 100 1000 200 1200 0 null null submitted
rec dispatch RUN-A reviewer rules REVIEW_RULES sonnet 120 null null null 1 null null submitted
rec dispatch RUN-A implementer null null gpt-5 300 5000 800 5800 0 null null submitted
rec step     RUN-A reviewer rules REVIEW_RULES sonnet 110 null null null null null null fail
rec run      RUN-A lead null null null 900 null null null null 4 1 "done"
rec dispatch RUN-B reviewer rules REVIEW_RULES sonnet 80 2000 300 2300 0 null null submitted
rec dispatch RUN-B security_reviewer null SECURITY opus 60 null null null 0 null null submitted
rec dispatch RUN-B implementer null null gpt-5 50 null null 4000 0 null null submitted
rec run      RUN-B lead null null null 500 null null null null 2 0 failed
# trap: a second run record for the same run (a retried write); only the first counts
rec run      RUN-B lead null null null 777777 null null null null 9 9 "done"
rec dispatch RUN-C explorer null null null 40 null null null 0 null null blocked
# a record of another schema version is skipped, not guessed at
printf '{"schema":"proofline.metrics/9","kind":"dispatch","task":"RUN-A","role":"reviewer","duration_s":999999}\n' >> "$R"
# a blank line and a non-JSON line are ignored and not called an unknown schema
printf '\nnot json at all\n' >> "$R"
