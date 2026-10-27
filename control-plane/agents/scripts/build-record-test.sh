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

# --- agent.sh build-record: the lead runs, reviewers only read (one run for both) ---
setcmd test "echo test-ok >> $cnt; echo tested-line"
git add -A; git commit -q -m two; : > "$cnt"
mkdir -p .agents/runs/LC
A build-record LC run > "$base/w1.out" || die "lead run through agent.sh failed"
AS reviewer build-record LC show > "$base/w2.out" || die "reviewer show failed"
AS verifier build-record LC show > "$base/w3.out" || die "verifier show failed"
cmp -s "$base/w1.out" "$base/w2.out" && cmp -s "$base/w1.out" "$base/w3.out" || die "reviewer and verifier saw another record than the lead's"
expect_msg "a reviewer must not run the build" "only the lead" env AGENT_ROLE=reviewer sh ./.agents/scripts/agent.sh build-record LC run
[ "$(grep -c build-ok "$cnt")" = 1 ] || die "the build ran $(grep -c build-ok "$cnt") times for the lead and two readers"
ok "the lead runs once through agent.sh; a reviewer and the verifier read the same record and cannot run it"

# --- the key includes the command strings ---
setcmd build "echo build-ok >> $cnt; echo built-line-2"
A build-record LC run > "$base/k.out" && grep -q built-line-2 "$base/k.out" || die "a changed build command reused the old record"
[ "$(grep -c build-ok "$cnt")" = 2 ] || die "a changed build command did not run again"
ok "a changed command string gets its own record"

# --- a stale lock (dead process) and an abandoned live one are reclaimed ---
key=$(A build-record LC show | sed -n 's/^key: //p' | head -n 1)
rm -rf ".agents/local/builds/$key"; mkdir ".agents/local/builds/$key.lock"
sh -c 'exit 0' & dead=$!; wait "$dead"; echo "$dead" > ".agents/local/builds/$key.lock/pid"
A build-record LC run > /dev/null || die "a lock of a dead process blocked the run"
[ "$(grep -c build-ok "$cnt")" = 3 ] || die "the run after a dead lock did not happen"
rm -rf ".agents/local/builds/$key"; mkdir ".agents/local/builds/$key.lock"; echo $$ > ".agents/local/builds/$key.lock/pid"
BUILD_RECORD_WAIT=2 A build-record LC run > /dev/null || die "a lock past the timeout blocked the run"
[ "$(grep -c build-ok "$cnt")" = 4 ] || die "the run after a timed-out lock did not happen"
ok "a dead or timed-out lock is reclaimed"

# --- an ignored dependency directory is linked into the export ---
echo node_modules >> .gitignore; mkdir node_modules; echo dep > node_modules/m
setcmd build "test -f node_modules/m"
A build-record LC run > "$base/dep.out" || die "the build did not see the ignored node_modules: $(cat "$base/dep.out")"
ok "an ignored dependency directory is available to the build"
# A185: the export holds a COPY (worktree_deps data), never a link into the project: a write by the build stays in the export
printf 'test -f node_modules/m && test ! -L node_modules && echo x > node_modules/written && echo y >> node_modules/m\n' > "$base/dep-build.sh"
setcmd build "sh $base/dep-build.sh"
A build-record LC run > "$base/dep2.out" || die "the build saw a link or no copy of node_modules: $(cat "$base/dep2.out")"
[ ! -e node_modules/written ] && [ "$(cat node_modules/m)" = dep ] || die "a build wrote through into the project's node_modules"
setcmd build "test -f node_modules/m"
ok "the dependency folder of the export is a copy: a build write does not reach the project (A185)"

# --- A174: the key tells command lists apart, and keeps the original form for scalar config ---
setlist() { # build-items test-items (items separated by |): rewrite the build and test keys as block lists
  awk -v b="$1" -v t="$2" '
    function emit(k, items,   n, a, i) { print "  " k ":"; n = split(items, a, "|"); for (i = 1; i <= n; i++) print "    - " a[i] }
    /^  (build|test):/ { skip = 1; emit(substr($1, 1, length($1) - 1), ($1 == "build:" ? b : t)); next }
    skip && /^    - / { next }
    { skip = 0; print }' .agents/config.yaml > .agents/config.new && mv .agents/config.new .agents/config.yaml
}
git add -A; git commit -q -m three
setlist 'echo a|echo b' 'echo c'
k1=$(B run | sed -n 's/^key: //p' | head -n 1)
setlist 'echo a' 'echo b|echo c'
k2=$(B run | sed -n 's/^key: //p' | head -n 1)
[ -n "$k1" ] && [ -n "$k2" ] && [ "$k1" != "$k2" ] || die "build:[a,b] test:[c] and build:[a] test:[b,c] share a key: $k1 $k2"
ok "command lists that differ only in where the list boundary falls get different keys"
setcmd build "echo build-ok >> $cnt; echo built-line-2"
setcmd test "echo tested-line"
git add -A; git commit -q -m four
ks=$(B run | sed -n 's/^key: //p' | head -n 1)
old=$(printf '%s\n%s\n%s\n' "$(sh .agents/scripts/agent.sh config-get commands.install)" "$(sh .agents/scripts/agent.sh config-get commands.build)" "$(sh .agents/scripts/agent.sh config-get commands.test)" | git hash-object --stdin | cut -c1-8)
[ "$ks" = "$(git rev-parse HEAD)-$old" ] || die "scalar config no longer uses the original key form: $ks, expected $(git rev-parse HEAD)-$old"
ok "scalar config keeps the original key, so a record made before command lists existed is still found"

# --- verification.env_files: a listed, secret-free test env file enters the export; other .env* never do; a visible secret rejects ---
setenvs() { sed -i.bak "s|^  env_files:.*|  env_files: $1|" .agents/config.yaml && rm -f .agents/config.yaml.bak; }
new_repo; cp "$tl_agents/scripts/build-record.sh" "$tl_agents/scripts/secret-scan.sh" .agents/scripts/
setcmd build "echo build-ok >> $cnt"; setcmd test "echo tested-line"; echo one > f.txt
printf '.env\n.env.test\n' >> .gitignore; printf 'MODE=test\n' > .env.test; printf 'MODE=dev\n' > .env
printf 'set -e\ntest -f .env.test\ntest ! -f .env\n' > "$base/chk-in.sh"; setcmd build "sh $base/chk-in.sh"
git add -A; git commit -q -m envs
sh .agents/scripts/agent.sh config-check > /dev/null || die "the shipped config is invalid"
setenvs ".env.test"; sh .agents/scripts/agent.sh config-check > /dev/null || die "verification.env_files .env.test was refused"
rc=0; B run > "$base/env1.out" || rc=$?
[ "$rc" = 0 ] || die "the listed .env.test did not enter the export, or .env did: $(cat "$base/env1.out")"
ok "a listed .env.test enters the build record's export; an unlisted .env does not"
printf 'set -e\ntest ! -f .env.test\ntest ! -f .env\n' > "$base/chk-out.sh"; setenvs ""; setcmd build "sh $base/chk-out.sh"
rc=0; B run > "$base/env2.out" || rc=$?
[ "$rc" = 0 ] || die "an env file that is not listed entered the export: $(cat "$base/env2.out")"
ok "without verification.env_files no .env* enters the export"
# a secret in a listed file rejects the record (the token is built from fragments; its value is never printed)
tok=$(printf '%s%s' 'ghp' '_q8Zr2Lm9Xc4Vb7Nk1Pw6Ty3Hs5Jd0FgEAb12')
printf 'API_TOKEN=%s\n' "$tok" > .env.test
setenvs ".env.test"; setcmd build "echo secret-build-ran >> $cnt"; : > "$cnt"; echo envsecret >> f.txt
rc=0; B run > "$base/env3.out" 2> "$base/env3.err" || rc=$?
[ "$rc" = 2 ] && grep -q 'rejected.*\.env\.test' "$base/env3.err" || die "a secret in a listed env file did not reject the record (rc=$rc): $(cat "$base/env3.err")"
grep -q "$tok" "$base/env3.err" "$base/env3.out" && die "the secret value was printed"
[ ! -s "$cnt" ] || die "the build ran although the env file held a secret"
printf 'DB_PASSWORD=%s\n' 'Xk9q8Zr2Lm9Xc4Vb7Nk1Pw6Ty3Hs5Jd0' > .env.test
rc=0; B run > /dev/null 2> "$base/env4.err" || rc=$?
[ "$rc" = 2 ] || die "an unquoted KEY=secret line was not caught (rc=$rc)"
ok "a secret in a listed env file rejects the record, names the file and prints no value"
setenvs "../x"; expect_msg "a path with .. is invalid" "verification.env_files" sh .agents/scripts/agent.sh config-check
setenvs "/etc/x"; expect_msg "an absolute path is invalid" "verification.env_files" sh .agents/scripts/agent.sh config-check
setenvs "*.env"; expect_msg "a glob is invalid" "verification.env_files" sh .agents/scripts/agent.sh config-check
ok "verification.env_files must be plain project-relative names"

# a listed file whose parent directory is a symbolic link out of the project is rejected; a missing file only gets a note
mkdir -p "$base/outside"; printf 'MODE=test\n' > "$base/outside/.env.test"; ln -s "$base/outside" linkdir; echo linkdir >> .gitignore
setcmd build "echo hi >> $cnt"; : > "$cnt"; echo envlink >> f.txt
setenvs "linkdir/.env.test"
rc=0; B run > "$base/env5.out" 2> "$base/env5.err" || rc=$?
[ "$rc" = 2 ] && grep -q 'rejected.*linkdir/.env.test' "$base/env5.err" && [ ! -s "$cnt" ] || die "a symlinked parent directory was not rejected (rc=$rc): $(cat "$base/env5.err")"
setenvs ".git/config"; rc=0; B run > /dev/null 2> "$base/env6.err" || rc=$?
[ "$rc" = 2 ] && grep -q 'rejected' "$base/env6.err" || die "a file under .git was not rejected (rc=$rc)"
setenvs "missing.env"; rc=0; B run > /dev/null 2> "$base/env7.err" || rc=$?
[ "$rc" = 0 ] && grep -q 'missing.env, which does not exist' "$base/env7.err" || die "a missing env file did not only print a note (rc=$rc): $(cat "$base/env7.err")"
ok "a listed env file outside the project or under .git is rejected; a missing one is a note"
