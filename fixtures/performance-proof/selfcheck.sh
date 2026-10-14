#!/bin/sh
# Proves the planted facts of the performance-proof fixture built in $1 (EXPECTED.md items 1-9; the traps
# 10-14 are the same cases: a status other than the expected one is the trap firing; traps 15-18 are checked
# explicitly at the end).
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
cmp=$(cd "$(dirname "$0")/../../skills/performance-proof/scripts" && pwd)/compare-bench.mjs
val=$(dirname "$cmp")/validate-performance.mjs
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' 'os=Linux 6.8.0 x86_64' cpu_count=8 'load_avg_before=0.4' 'command=synthetic' warmup_runs=1 runs=12 order=interleaved \
  timer=date base_rev=b change_rev=c started_at=2026-10-13T10:00:00Z finished_at=2026-10-13T10:01:00Z > "$tmp/env.txt"

# expect CASE STATUS [compare-bench options...]: the report's status, and the report validates.
expect() {
  c=$1 want=$2; shift 2
  b=samples/$c-base.json; [ -f "$b" ] || b=samples/$c-base.csv
  ch=samples/$c-change.json; [ -f "$ch" ] || ch=samples/$c-change.csv
  node "$cmp" --base "$b" --change "$ch" --command "synthetic" --tool-source "fixture" "$@" > "$tmp/r.json" || fail "$c: compare-bench exited $?"
  got=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).status)' "$tmp/r.json")
  [ "$got" = "$want" ] || fail "$c $*: want $want, got $got"
}

expect c1 FAIL
expect c2 INCONCLUSIVE
expect c3 PASS
expect c4 PASS
expect c5 INCONCLUSIVE
expect c6 INCONCLUSIVE
if node "$cmp" --base samples/c7-base.json --change samples/c7-change.json > "$tmp/c7.out" 2> "$tmp/c7.err"; then fail "c7: unit mismatch was compared"; else rc=$?; fi
[ "$rc" = 2 ] && [ ! -s "$tmp/c7.out" ] && grep -q 'unit mismatch' "$tmp/c7.err" || fail "c7: want exit 2 with 'unit mismatch' and no report"
expect c8 FAIL
expect c8 PASS --plan PLAN-20.md
src=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).thresholds.source)' "$tmp/r.json")
[ "$src" = plan ] || fail "c8 --plan: source $src, want plan"
expect c8 PASS --config .agents/config.yaml
expect c8 FAIL --config .agents/config.yaml --plan PLAN-12.md
# A budget given on the command line is a what-if: PASS, but source `cli (unverified)` and never a valid report.
expect c8 PASS --budget-pct 20 --env "$tmp/env.txt"
grep -q '"source": "cli (unverified)"' "$tmp/r.json" || fail "c8 --budget-pct: source is not cli (unverified)"
if node "$val" "$tmp/r.json" > /dev/null 2>&1; then fail "a cli budget report validated"; fi
# An unparseable plan budget is a note in the report and refused by the validator.
expect c8 FAIL --plan PLAN-abc.md
grep -q 'budget_pct=abc is not a number' "$tmp/r.json" || fail "c8 PLAN-abc: no note about the unparseable budget"
if node "$val" "$tmp/r.json" --plan PLAN-abc.md > /dev/null 2>&1; then fail "a plan with an unparseable budget_pct validated"; fi
expect c9 FAIL --direction higher

# A compare-bench report without an environment block is not a valid report.
expect c1 FAIL
if node "$val" "$tmp/r.json" > /dev/null 2>&1; then fail "a report without environment validated"; fi
# Trap 15/16: the direction contradicts the unit (time is lower-is-better, a rate higher-is-better).
for d in "c1 higher" "c9 lower"; do
  set -- $d
  if node "$cmp" --base "samples/$1-base.json" --change "samples/$1-change.json" --direction "$2" > /dev/null 2> "$tmp/dir.err"; then fail "$1 --direction $2 was compared"; fi
  grep -q 'contradicts unit' "$tmp/dir.err" || fail "$1 --direction $2: no 'contradicts unit' refusal"
done
# Trap 17/18: a valid c3 report (PASS) with a shopped seed is invalid; unverified thresholds never submit PASS.
expect c3 PASS --env "$tmp/env.txt"
: > "$tmp/config.yaml"
printf '## Risk\n\nperformance_critical: yes\n' > "$tmp/PLAN.md"
node "$val" "$tmp/r.json" --config "$tmp/config.yaml" --plan "$tmp/PLAN.md" --rows | grep -qx 'result: PASS' || fail "c3 verified: not PASS"
node "$val" "$tmp/r.json" --rows | grep -qx 'result: UNSUPPORTED' || fail "c3 unverified: submitted as something other than UNSUPPORTED"
node -e 'const f=process.argv[1],fs=require("fs"),d=JSON.parse(fs.readFileSync(f,"utf8"));d.measurements[0].delta.seed=19;fs.writeFileSync(f,JSON.stringify(d))' "$tmp/r.json"
if node "$val" "$tmp/r.json" --config "$tmp/config.yaml" --plan "$tmp/PLAN.md" > /dev/null 2>&1; then fail "a report with seed 19 validated"; fi
# Trap 19/20: unit aliases are times; a unit without a known direction needs the plan's direction=.
for u in milliseconds MS μs; do
  node -e 'const fs=require("fs"),[f,u,o]=process.argv.slice(1),d=JSON.parse(fs.readFileSync(f,"utf8"));d.unit=u;fs.writeFileSync(o,JSON.stringify(d))' samples/c1-base.json "$u" "$tmp/ab.json"
  node -e 'const fs=require("fs"),[f,u,o]=process.argv.slice(1),d=JSON.parse(fs.readFileSync(f,"utf8"));d.unit=u;fs.writeFileSync(o,JSON.stringify(d))' samples/c1-change.json "$u" "$tmp/ac.json"
  if node "$cmp" --base "$tmp/ab.json" --change "$tmp/ac.json" --metric value --direction higher > /dev/null 2>&1; then fail "c1 as $u --direction higher was compared"; fi
done
node -e 'const fs=require("fs"),[f,o]=process.argv.slice(1),d=JSON.parse(fs.readFileSync(f,"utf8"));d.unit="score";fs.writeFileSync(o,JSON.stringify(d))' samples/c9-base.json "$tmp/sb.json"
node -e 'const fs=require("fs"),[f,o]=process.argv.slice(1),d=JSON.parse(fs.readFileSync(f,"utf8"));d.unit="score";fs.writeFileSync(o,JSON.stringify(d))' samples/c9-change.json "$tmp/sc.json"
if node "$cmp" --base "$tmp/sb.json" --change "$tmp/sc.json" --direction higher > /dev/null 2>&1; then fail "c9 as score was compared without the plan's direction"; fi
printf '## Risk\n\nperformance_critical: yes direction=higher\n' > "$tmp/PLAN-dir.md"
expect_dir=$(node "$cmp" --base "$tmp/sb.json" --change "$tmp/sc.json" --plan "$tmp/PLAN-dir.md" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')
[ "$expect_dir" = FAIL ] || fail "c9 as score with the plan's direction=higher: want FAIL, got $expect_dir"
echo "selfcheck: performance-proof ok"
