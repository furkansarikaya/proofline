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
# A135: a Codex lead needs the base model (execution_policy.lead_base_model); the cheapest model is refused for
# the first exec and for every resume (same variable), the base model is accepted with its effort flag.
base=$(awk '/^  lead_base_model:/ { g = 1; next } g && $1 == "codex:" { print $2; exit }' "$here/../../control-plane/agents/config.yaml")
[ -n "$base" ] || fail 'no lead_base_model.codex in the policy table'
E2E_CODEX_MODEL=gpt-6-luna E2E_ROOT=$root/e sh "$here/run.sh" TRIVIAL codex --dry-run > "$root/refused.txt" 2>&1 && fail 'cheapest model accepted for a Codex lead'
grep -q "$base" "$root/refused.txt" || fail "refusal does not name the base model: $(cat "$root/refused.txt")"
E2E_CODEX_MODEL=gpt-6-luna E2E_ROOT=$root/e2 sh "$here/run.sh" FAILOVER mixed --dry-run > /dev/null 2>&1 && fail 'cheapest model accepted for the FAILOVER resume lead'
E2E_CODEX_MODEL=$base E2E_CODEX_EFFORT=none E2E_ROOT=$root/d sh "$here/run.sh" TRIVIAL codex --dry-run 2>&1 | grep -E '^lead( resume)?:' > "$root/cheap.txt"
[ "$(grep -c -- "-m '$base'" "$root/cheap.txt")" -eq 2 ] || fail "model flag missing: $(cat "$root/cheap.txt")"
[ "$(grep -c 'model_reasoning_effort="none"' "$root/cheap.txt")" -eq 2 ] || fail "effort flag missing: $(cat "$root/cheap.txt")"
# A135: the cheapest model stays allowed where Claude leads and Codex only works (mixed).
E2E_CODEX_MODEL=gpt-6-luna E2E_ROOT=$root/m sh "$here/run.sh" TRIVIAL mixed --dry-run > /dev/null 2>&1 || fail 'cheap Codex worker model refused in a mixed run'
# A117: a dry run removes its project copy and isolated Codex home, keeps out/; --keep keeps the whole run directory.
run_dir=$(dirname "$out")
[ ! -e "$run_dir/project" ] && [ ! -e "$run_dir/codexhome" ] || fail 'dry run left the project copy or codexhome behind'
[ -s "$out/git-global-before.txt" ] && [ -s "$out/prepare.txt" ] || fail 'out/ not intact after cleanup'
E2E_ROOT=$root/k sh "$here/run.sh" TRIVIAL claude --dry-run --keep > /dev/null 2>&1 || fail 'dry run --keep failed'
k=$(find "$root/k" -maxdepth 1 -mindepth 1 -type d | head -1)
[ -d "$k/project" ] && [ -d "$k/codexhome" ] && [ -d "$k/out" ] || fail '--keep did not keep the run directory'
# A121: the database is probed before and after; an untouched copy gives db_unchanged=yes and the K-9 evidence lines.
for f in db-probe-before.txt db-probe.txt db-probe-diff.txt summary.txt; do [ -s "$out/$f" ] || fail "missing out/$f"; done
grep -q '^db_unchanged=yes$' "$out/summary.txt" || fail 'db_unchanged is not yes on an untouched copy'
cmp -s "$out/db-probe-before.txt" "$out/db-probe.txt" || fail 'db probe differs on an untouched copy'
for k in '^columns=.*legacy_notes' '^legacy_notes_non_null=3$' '^legacy_notes_sha256=' '^legacy_notes_values=' '^table=books .*rows=[0-9]+$' '^migrations=001_create_books.sql,002_add_notes.sql$' '^db_file_sha256='; do
  grep -Eq "$k" "$out/db-probe-before.txt" || fail "db-probe-before.txt lacks $k"
done
grep -q '^db_wal_sha256=' "$out/db-probe-before.txt" || fail 'db-probe-before.txt lacks db_wal_sha256'
# A probe that cannot run is marked, and the verdict is unknown, never yes.
E2E_PROBE_NODE=/nonexistent/node E2E_ROOT=$root/p sh "$here/run.sh" TRIVIAL claude --dry-run > /dev/null 2>&1 || fail 'dry run with a failing probe failed'
p=$(find "$root/p" -type d -name out | head -1)
grep -q '^probe failed:' "$p/db-probe-before.txt" || fail 'failed probe not marked'
grep -q '^db_unchanged=unknown$' "$p/summary.txt" || fail 'failed probe did not give db_unchanged=unknown'
echo "capabilities harness tests passed"
