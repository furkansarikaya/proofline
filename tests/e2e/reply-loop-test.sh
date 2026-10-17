#!/bin/sh
# Self-test (A128): the harness reply loop of run.sh against a stub `claude` that leaves an unanswered approval
# request in the run's approvals/ directory after every call. No real runtime is called.
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
run plan 2
grep -q '^plan_approval_replies=2$' "$out/summary.txt" || fail "plan replies: $(cat "$out/summary.txt")"
grep -q '^stopped=max-replies$' "$out/summary.txt" || fail "cap not reported: $(cat "$out/summary.txt")"
echo "ok a plan request pending until the cap is answered, then stopped=max-replies"
for slug in destructive single_step scope budget commit push waive-F-1; do
  run "$slug" 6
  grep -q '^replies=0$' "$out/summary.txt" || fail "$slug request was answered: $(cat "$out/summary.txt")"
  ! grep -q '^stopped=' "$out/summary.txt" || fail "$slug: $(cat "$out/summary.txt")"
  echo "ok a $slug request is never answered"
done
echo "reply-loop tests passed"
