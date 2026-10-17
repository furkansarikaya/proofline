#!/bin/sh
# Self-test (A128): the harness reply loop of run.sh against a stub `claude` that leaves an unanswered approval
# request in the run's approvals/ directory after every call. No real runtime is called. One selftest unit per
# scenario (LC_EXACT names one; see tests/selftest.sh).
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/e2e-loop.XXXXXX") || exit 1
trap 'rm -rf "$root"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
mkdir "$root/bin"
cat > "$root/bin/claude" <<'E'
#!/bin/sh
# Stub lead: one more unanswered request of $STUB_SLUG in runs/none/approvals, a result line, no question mark.
d=.agents/runs/none/approvals; mkdir -p "$d"
n=$(ls "$d" | wc -l); n=$(printf '%03d' $((n + 1)))
: > "$d/$n-request-$STUB_SLUG.yaml"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1"}' '{"type":"result","result":"Reply approve to continue."}'
E
chmod +x "$root/bin/claude"
run() { # slug max
  rm -rf "$root/r"
  STUB_SLUG=$1 E2E_MAX_REPLIES=$2 E2E_ROOT=$root/r PATH="$root/bin:$PATH" sh "$here/run.sh" COMPLEX claude > "$root/stdout.txt" 2>&1 || fail "run failed: $(cat "$root/stdout.txt")"
  out=$(find "$root/r" -type d -name out | head -1)
}
scenarios='plan destructive single_step scope budget commit push waive-F-1 question-file'
for sc in $scenarios; do
  [ -z "${LC_EXACT:-}" ] || [ "$LC_EXACT" = "$sc" ] || continue
  if [ "$sc" = question-file ]; then
    # A131: the question reply comes from replies/question.<SCENARIO>.txt when it exists, else line 1 of the generic file;
    # no approval phrase of the shared allowlist (agent.sh approval_phrases) may be in it.
    cat > "$root/bin/claude" <<'S'
#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1"}' '{"type":"result","result":"Which option do you prefer?"}'
S
    phrases=$(sed -n "s/^approval_phrases() {.*'\(.*\)'.*/\1/p" "$here/../../control-plane/agents/scripts/agent.sh")
    [ -n "$phrases" ] || fail 'approval phrases not found in agent.sh'
    for scn in CRITICAL COMPLEX; do
      rm -rf "$root/r"
      E2E_MAX_REPLIES=1 E2E_ROOT=$root/r PATH="$root/bin:$PATH" sh "$here/run.sh" $scn claude > "$root/stdout.txt" 2>&1 || fail "run failed: $(cat "$root/stdout.txt")"
      out=$(find "$root/r" -type d -name out | head -1)
      want=$here/replies/$scn.txt; [ ! -f "$here/replies/question.$scn.txt" ] || want=$here/replies/question.$scn.txt
      sent=$(sed -n 's/^reply=1 .* | //p' "$out/replies-log.txt")
      [ "$sent" = "$(sed -n 1p "$want")" ] || fail "$scn sent '$sent', want line 1 of $want"
      case $scn in CRITICAL) [ "$want" = "$here/replies/question.CRITICAL.txt" ] || fail 'CRITICAL file not used' ;; *) [ "$want" = "$here/replies/$scn.txt" ] || fail "$scn did not use the generic file" ;; esac
    done
    reply=$(cat "$here/replies/question.CRITICAL.txt")
    case $reply in *\?*) fail 'question reply holds a question mark' ;; esac
    norm=" $(printf '%s' "$reply" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr -c 'a-z0-9_-' ' ' | tr -s ' ') "
    old_ifs=$IFS; IFS=,
    for ph in $phrases; do
      ph=$(printf '%s' "$ph" | LC_ALL=C tr 'A-Z' 'a-z' | sed 's/^ *//; s/ *$//'); [ -n "$ph" ] || continue
      case $norm in *" $ph "*) fail "question.CRITICAL.txt holds the approval phrase '$ph'" ;; esac
    done
    IFS=$old_ifs
    echo "ok the question reply is chosen per scenario (CRITICAL file, others generic) and holds no approval phrase"
  elif [ "$sc" = plan ]; then
    run plan 2
    grep -q '^plan_approval_replies=2$' "$out/summary.txt" || fail "plan replies: $(cat "$out/summary.txt")"
    grep -q '^stopped=max-replies$' "$out/summary.txt" || fail "cap not reported: $(cat "$out/summary.txt")"
    echo "ok a plan request pending until the cap is answered, then stopped=max-replies"
  else
    run "$sc" 6
    grep -q '^replies=0$' "$out/summary.txt" || fail "$sc request was answered: $(cat "$out/summary.txt")"
    ! grep -q '^stopped=' "$out/summary.txt" || fail "$sc: $(cat "$out/summary.txt")"
    echo "ok a $sc request is never answered"
  fi
done
echo "reply-loop tests passed"
