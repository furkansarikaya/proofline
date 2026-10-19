#!/bin/sh
# Tests for build-record.sh (A148): the build and test run once per source state; later callers read the record.
# shellcheck disable=SC2015,SC2154 # assertion chains; tl_agents and base come from test-lib.sh
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
new_repo
cp "$tl_agents/scripts/build-record.sh" .agents/scripts/
cnt=$base/count; : > "$cnt"
setcmd() { sed -i.bak "s|^  $1:.*|  $1: $2|" .agents/config.yaml && rm -f .agents/config.yaml.bak; }
setcmd build "echo build-ok >> $cnt; echo built-line"
setcmd test "echo test-ok >> $cnt; echo tested-line"
echo one > f.txt; git add -A; git commit -q -m one
B() { sh .agents/scripts/build-record.sh "$@"; }

expect_msg "no record yet" "no finished record" B show
r1=$(B run) || die "first run failed: $r1"
B run > "$base/r2.out" &
B run > "$base/r3.out" &
wait   # two more reviewers at once
r4=$(B run) || die "later run failed"
[ "$(grep -c build-ok "$cnt")" = 1 ] && [ "$(grep -c test-ok "$cnt")" = 1 ] || die "the build or test ran more than once: $(tr '\n' ' ' < "$cnt")"
ok "four callers, the build and the test ran once"
key=$(git rev-parse HEAD)
printf '%s' "$r1" | grep -q "key: $key" && printf '%s' "$r1" | grep -q 'exit: 0' && printf '%s' "$r1" | grep -q tested-line || die "record lacks key, exit or output: $r1"
[ "$r1" = "$r4" ] && cmp -s "$base/r2.out" "$base/r3.out" || die "callers saw different records"
ok "the record is keyed by the commit hash and shows the exit status and output"

echo two >> f.txt   # uncommitted change: a new key, a new run
B run > /dev/null; B show | grep -q 'key: tree-' || die "dirty tree not keyed by tree hash"
[ "$(grep -c build-ok "$cnt")" = 2 ] || die "a changed tree did not run again"
ok "a changed tree gets its own record"

setcmd test "echo bad-line; exit 3"
echo three >> f.txt
rc=0; B run > "$base/bad.out" || rc=$?
[ "$rc" = 1 ] && grep -q 'exit: 3' "$base/bad.out" && grep -q bad-line "$base/bad.out" || die "a failing test is not recorded (rc=$rc)"
rc=0; B show > /dev/null || rc=$?
[ "$rc" = 1 ] || die "show of a failed record must exit 1"
ok "a failing command is recorded with its exit status"
