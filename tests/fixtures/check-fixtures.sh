#!/bin/sh
# Builds every fixtures/*/setup.sh into a temporary directory and runs the
# fixture's selfcheck.sh (if any). Prints PASS/FAIL per fixture; exits non-zero
# when any fixture fails. Offline; installs nothing.
# Also builds the ported proof-review and test-trust fixtures (setup.sh, plan-setup.sh,
# diff-setup.sh; go and ts). Building needs only bash; their tests and the PLAN check run
# when the toolchain exists (go, node 22.18+/23.6+, vitest for test-trust ts), else a SKIP line with
# the reason is printed (SKIP is never counted as a pass and never omitted).
# Usage: sh tests/fixtures/check-fixtures.sh [fixture-name ...]
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/proofline-fixtures.XXXXXX") || { echo "TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }
trap 'rm -rf "$work"' EXIT INT TERM

if [ $# -gt 0 ]; then
  names=$*
else
  names=
  for s in "$root"/fixtures/*/setup.sh; do
    [ -f "$s" ] || continue
    names="$names $(basename "$(dirname "$s")")"
  done
fi

pass=0
total=0
for name in $names; do
  dir=$root/fixtures/$name
  [ -f "$dir/setup.sh" ] || continue    # proof-review, test-trust: built by the ported-fixture steps below
  total=$((total + 1))
  log=$work/$name.log
  shell="sh"
  head -n 1 "$dir/setup.sh" | grep -q bash && shell="bash"
  if ! $shell "$dir/setup.sh" "$work/$name" > "$log" 2>&1; then
    echo "FAIL $name (setup.sh)"; sed 's/^/  /' "$log"; continue
  fi
  if [ -f "$dir/selfcheck.sh" ] && ! sh "$dir/selfcheck.sh" "$work/$name" >> "$log" 2>&1; then
    echo "FAIL $name (selfcheck.sh)"; sed 's/^/  /' "$log"; continue
  fi
  echo "PASS $name"
  pass=$((pass + 1))
done

# --- ported proof-review / test-trust fixtures ---------------------------------------------------
has() { command -v "$1" >/dev/null 2>&1; }
node_ts_ok() { has node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=24||(a===23&&b>=6)||(a===22&&b>=18)?0:1)'; }
skips=0
skip() { echo "SKIP $1: $2"; skips=$((skips + 1)); }
# step NAME COMMAND...: one PASS/FAIL line, counted in the totals.
step() {
  sn=$1; shift; total=$((total + 1))
  if "$@" > "$work/step.log" 2>&1; then echo "PASS $sn"; pass=$((pass + 1)); else echo "FAIL $sn"; sed 's/^/  /' "$work/step.log"; fi
}
run_extra=1
if [ $# -gt 0 ]; then run_extra=0; for a in "$@"; do case $a in proof-review|test-trust) run_extra=1 ;; esac; done; fi
if [ "$run_extra" -eq 1 ]; then
  fx=$root/fixtures
  if ! has bash; then skip "proof-review and test-trust fixtures" "bash not available (the setups need it)"; else
    for lang in go ts; do
      step "proof-review/$lang setup.sh" bash "$fx/proof-review/$lang/setup.sh" "$work/pr-$lang"
      step "proof-review/$lang setup.sh --working-tree" bash "$fx/proof-review/$lang/setup.sh" "$work/pr-$lang-wt" --working-tree
      step "proof-review/$lang plan-setup.sh" sh "$fx/proof-review/plan-setup.sh" "$lang" "$work/pr-$lang-run"
      if has node; then
        step "proof-review/$lang plan-setup.sh PLAN passes validate-plan.mjs" node "$root/skills/plan-contract/scripts/validate-plan.mjs" \
          "$work/pr-$lang-run/.agents/runs/FIX-1/PLAN.md" "$work/pr-$lang-run/.agents/runs/FIX-1/TASK.md" --class STANDARD --repo "$work/pr-$lang-run"
      else skip "proof-review/$lang plan-setup.sh PLAN check" "node not available"; fi
      for sc in fail pass; do step "test-trust/$lang diff-setup.sh $sc" sh "$fx/test-trust/diff-setup.sh" "$lang" "$work/tt-$lang-$sc" "$sc"; done
    done
    if has go; then
      step "proof-review/go branch fixture: go test" sh -c "cd '$work/pr-go' && go test ./..."
      step "proof-review/go run fixture: go test" sh -c "cd '$work/pr-go-run' && go test ./..."
      step "test-trust/go diff-setup pass: go test" sh -c "cd '$work/tt-go-pass' && go test ./..."
    else skip "proof-review/go and test-trust/go tests" "go not available"; fi
    if node_ts_ok; then
      step "proof-review/ts branch fixture: node --test" sh -c "cd '$work/pr-ts' && node --test"
      step "proof-review/ts run fixture: node --test" sh -c "cd '$work/pr-ts-run' && node --test"
    else skip "proof-review/ts tests" "node 22.18+/23.6+ with type stripping not available"; fi
    if has vitest; then
      step "test-trust/ts diff-setup pass: vitest" sh -c "cd '$work/tt-ts-pass' && vitest run"
    else skip "test-trust/ts tests" "vitest not installed (fixtures never install anything)"; fi
  fi
fi

echo "fixtures: $pass/$total passed, $skips skipped"
[ "$pass" -eq "$total" ]
