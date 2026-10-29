#!/bin/sh
# Run document size (A202, item 20). Not run by CI. No model: it builds a fixture run for each class with the control-plane self-test
# fixtures (control-plane/agents/scripts/test-lib.sh) and prints the bytes of the documents the run holds, plus the bytes of the templates
# a model starts from. Usage: sh tests/bench/run-doc-size.sh [REPO-ROOT]   (default: the repository this script is in; pass another
# checkout, for example a detached worktree of an earlier version, to compare).
#
# Honest limit: a fixture run holds the documents the fixture helpers write (short stand-ins for what a model writes) plus what the
# scripts themselves add (the Facts block and, since A202, the summary block's Look-at lines). The model-written text is not measured;
# the template bytes show what each document asks the model to start from.
set -eu
root=${1:-$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)}
[ -f "$root/control-plane/agents/scripts/test-lib.sh" ] || { echo "run-doc-size: $root is not a proofline checkout" >&2; exit 2; }
TMPDIR=${TMPDIR:-/tmp}; export TMPDIR
# $0 of the inner shell is a path inside the scripts directory, so test-lib.sh finds the control plane it installs into each fixture
sh -c '
. "$(dirname "$0")/test-lib.sh"
docs="TASK PLAN EVIDENCE QA_PLAN QA_REPORT REVIEW VERIFY COMPLETION_REPORT"
printf "%-9s %s\n" class "document bytes (fixture run: documents the run holds)"
for cls in TRIVIAL STANDARD COMPLEX; do
  scaffold standalone no "$cls" >/dev/null 2>&1
  to_code_done standalone >/dev/null 2>&1 || { echo "$cls: the fixture could not reach CODE_DONE" >&2; continue; }
  A knowledge-done LC not_applicable "nothing durable changed in this synthetic test run" >/dev/null 2>&1
  write_report
  A publish-completion-report LC markdown >/dev/null 2>&1 || { echo "$cls: the fixture report was not published" >&2; continue; }
  total=0; line=""
  for d in $docs; do
    f=.agents/runs/LC/$d.md
    [ -f "$f" ] || continue
    n=$(wc -c < "$f" | tr -d " "); total=$((total + n)); line="$line $d=$n"
  done
  printf "%-9s total=%s  (%s )\n" "$cls" "$total" "$line"
done
' "$root/control-plane/agents/scripts/run-doc-size"
printf '\ntemplates a model starts from (control-plane/agents/templates):\n'
total=0
for d in PLAN EVIDENCE QA_PLAN QA_REPORT REVIEW COMPLETION_REPORT; do
  f=$root/control-plane/agents/templates/$d.md
  [ -f "$f" ] || continue
  n=$(wc -c < "$f" | tr -d ' '); total=$((total + n)); printf '  %s=%s' "$d" "$n"
done
printf '\n  total=%s\n' "$total"
