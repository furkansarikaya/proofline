#!/bin/sh
# Self-test (A95): a dry run records the global git config and creates the collected files, with no runtime call.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(mktemp -d "${TMPDIR:-/tmp}/e2e-cap.XXXXXX") || exit 1
trap 'rm -rf "$root"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
E2E_ROOT=$root sh "$here/run.sh" TRIVIAL claude --dry-run > "$root/stdout.txt" 2>&1 || fail "dry run failed: $(cat "$root/stdout.txt")"
out=$(find "$root" -type d -name out | head -1)
[ -n "$out" ] || fail 'no out directory'
for f in git-global-before.txt git-global-after.txt agent-pipeline.txt insights.txt visual-artifacts.txt replies-log.txt metrics; do
  [ -e "$out/$f" ] || fail "missing out/$f"
done
cmp -s "$out/git-global-before.txt" "$out/git-global-after.txt" || fail 'global git config record differs between before and after'
grep -Eq 'sha256=|absent' "$out/git-global-before.txt" || fail 'global config not recorded as a hash or absent'
grep -q 'not collected' "$out/insights.txt" || fail 'dry run called insights'
# With no global config at all the record says absent and the harness writes none.
empty=$(mktemp -d "$root/home.XXXXXX")
HOME=$empty XDG_CONFIG_HOME=$empty/x GIT_CONFIG_NOSYSTEM=1 E2E_ROOT=$root/b sh "$here/run.sh" TRIVIAL claude --dry-run > /dev/null 2>&1 || fail 'dry run without global config failed'
b=$(find "$root/b" -name git-global-before.txt | head -1)
[ "$(grep -c absent "$b")" -ge 3 ] || fail "absent not recorded: $(cat "$b")"
[ ! -e "$empty/.gitconfig" ] || fail 'harness wrote a global config'
# A100: the Codex lead command carries the cheapest model and effort only when asked.
E2E_ROOT=$root/c sh "$here/run.sh" TRIVIAL codex --dry-run 2>&1 | grep -E '^lead( resume)?:' > "$root/plain.txt"
[ "$(wc -l < "$root/plain.txt")" -eq 2 ] || fail "no codex lead lines: $(cat "$root/plain.txt")"
! grep -Eq -- "-m |model_reasoning_effort" "$root/plain.txt" || fail 'model/effort flags present with the env unset'
E2E_CODEX_MODEL=gpt-6-luna E2E_CODEX_EFFORT=none E2E_ROOT=$root/d sh "$here/run.sh" TRIVIAL codex --dry-run 2>&1 | grep -E '^lead( resume)?:' > "$root/cheap.txt"
[ "$(grep -c -- "-m 'gpt-6-luna'" "$root/cheap.txt")" -eq 2 ] || fail "model flag missing: $(cat "$root/cheap.txt")"
[ "$(grep -c 'model_reasoning_effort="none"' "$root/cheap.txt")" -eq 2 ] || fail "effort flag missing: $(cat "$root/cheap.txt")"
echo "capabilities harness tests passed"
