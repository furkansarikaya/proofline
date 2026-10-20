#!/bin/sh
# shellcheck disable=SC2016 # literal command text
# Kill guard tests (A156): the PreToolUse hook denies pkill, killall and kill by pattern or mass kill, and allows
# kill of a PID the agent holds. The hook receives only the agent's own tool calls: a command the user types with `!`
# in the terminal never reaches PreToolUse, so none of this affects the user's own commands.
# One selftest unit per scenario (LC_EXACT names one; see tests/selftest.sh).
set -u
repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
hook=$repo/adapters/claude/hooks/proofline-hook.sh
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-kill.XXXXXX") || { echo "kill-guard: TMPDIR must be an existing directory" >&2; exit 2; }
trap 'rm -rf "$base" "${HOME:-/nonexistent}/.proofline-kg-test-$$.sh"' EXIT
die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok $*"; }
command -v jq >/dev/null 2>&1 || { echo "kill-guard: jq is required"; exit 2; }
proj=$base/proj; mkdir -p "$proj"
git -C "$proj" init -q -b main 2>/dev/null || { git -C "$proj" init -q; git -C "$proj" checkout -q -b main; }
jstr() { printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); if (NR > 1) print "\\n"; print }'; }
pre() { printf '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$proj" "$(jstr "$1")" | sh "$hook" pretool claude; }
denies() { out=$(pre "$1"); printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "not denied: $1 -> $out"; printf '%s' "$out" | grep -Fq 'A156' || die "denial is not the kill guard: $1 -> $out"; }
allows() { out=$(pre "$1"); ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "denied: $1 -> $out"; }

scenarios='denied allowed signal_zero quoted_text quoted_substitution installed heredoc_indirect zero_spellings pid_derivation find_xargs interpreters script_files script_files_allowed eval_variable indirect_allowed taint_deny script_runners script_runners_allowed allowed_misc deny_message budget'
for sc in $scenarios; do
  [ -z "${LC_EXACT:-}" ] || [ "$LC_EXACT" = "$sc" ] || continue
  case "$sc" in
  denied)
    denies 'pkill node'; denies 'killall node'; denies 'kill -1'; denies 'kill 0'; denies 'kill -9 -- -1'
    denies 'kill $(pgrep node)'; denies 'pgrep node | xargs kill'; denies 'sudo killall node'; denies 'bash -c "pkill node"'
    ok "pkill, killall, kill -1, kill 0, kill -9 -- -1, kill \$(pgrep), pgrep | xargs kill, sudo killall and bash -c pkill are denied" ;;
  allowed)
    allows 'kill 1234'; allows 'kill -TERM $PID'; allows 'kill -9 $!'; allows 'echo pkill'; allows 'grep pkill file'; allows 'npm run skill'
    ok "kill <pid>, kill -TERM \$PID, kill -9 \$!, echo pkill, grep pkill file and npm run skill are allowed" ;;
  signal_zero)   # kill -0 PID only tests that a process exists; kill 0 / -1 / -- 0 signal everything
    allows 'kill -0 1234'; allows 'kill -0 $!'; allows 'while kill -0 $PID 2>/dev/null; do sleep 1; done'
    allows 'kill -s 0 $PID'; allows 'kill -n 0 $PID'; allows 'sh -c "kill -0 $PID"'
    denies 'kill 0'; denies 'kill -1'; denies 'kill -TERM 0'; denies 'kill -- 0'; denies 'kill -9 -- -1'
    denies 'kill $(pgrep node)'; denies 'pgrep x | xargs -r kill'; denies 'pkill node'
    ok "kill -0 / -s 0 / -n 0 with a PID is allowed; kill 0, -1, -TERM 0, -- 0 and the pattern forms are denied" ;;
  quoted_text)   # kill text inside a commit message, a heredoc, a PR body or a help/lookup call is not a kill
    allows 'git commit -m "docs: kill $(pgrep node) is denied"'
    allows "$(printf 'git commit -F - <<EOF\ndocs: kill $(pgrep node) is denied\nEOF')"
    allows 'gh pr create --title t --body "text: kill $(pgrep x) and pkill x are denied"'
    allows 'command -v killall'; allows 'pkill --help'
    ok "kill text in a commit message, a heredoc and a PR body, command -v killall and pkill --help are allowed" ;;
  quoted_substitution)   # a double-quoted process-search substitution is still a kill by pattern
    denies 'kill -9 "$(lsof -ti :3000)"'; denies 'kill "$(pgrep x)"'; denies 'kill -TERM "$(pgrep x)"'
    denies 'kill -9 -- "$(pgrep x)"'; denies 'kill -s TERM "$(pgrep x)"'; allows 'kill "$(cat app.pid)"'
    ok "kill with a quoted \$(pgrep) or \$(lsof) substitution is denied, kill \"\$(cat app.pid)\" is allowed" ;;
  installed)   # the guard runs in an installed project too
    mkdir -p "$proj/.agents/scripts"; : > "$proj/.agents/config.yaml"; printf 'echo main\n' > "$proj/.agents/scripts/agent.sh"
    denies 'pkill node'; allows 'kill 1234'; ok "the guard also runs in an installed project" ;;
  heredoc_indirect)   # an unquoted heredoc body is expanded by the shell; a quoted or escaped delimiter is plain text
    denies "$(printf 'cat <<EOF\n$(pkill node)\nEOF')"; denies "$(printf 'cat <<EOF\nx `killall node` y\nEOF')"
    denies "$(printf 'cat <<-EOF\n\tx\n\tEOF\nkillall node')"; denies "$(printf 'bash <<EOF\nkill 0\nEOF')"
    allows "$(printf "cat <<'EOF'\n\$(pkill node)\nEOF")"; allows "$(printf 'cat <<\\EOF\n$(pkill node)\nEOF')"
    allows "$(printf 'cat <<EOF\n\tEOF\nkillall node\nEOF')"
    ok "unquoted heredoc substitution, <<- with a tab terminator then killall and bash <<EOF kill 0 are denied; quoted, escaped and non-<<- heredocs are allowed" ;;
  zero_spellings)
    denies 'kill 00'; denies 'kill +0'; denies 'kill $((0))'; denies 'kill -9 $((1-1))'; denies 'kill -- -0'; denies 'kill 000'
    allows 'kill $((2+3))'; allows 'kill -0 12'; allows 'kill -- -1234'
    ok "kill 00, +0, \$((0)), -- -0 and arithmetic zero are denied; kill \$((2+3)), kill -0 12 and kill -- -1234 are allowed" ;;
  pid_derivation)   # the pid comes from a process search in the same command
    denies 'pgrep x | while read p; do kill $p; done'; denies 'for p in $(pgrep x); do kill $p; done'
    denies 'for p in `pgrep x`; do kill -9 $p; done'; denies 'PID=$(pgrep x) && kill $PID'; denies 'PIDS=`pidof node`; kill -9 $PIDS'
    denies 'P="$(ps aux | grep x | awk "{print \$2}")"; kill $P'; denies 'set -- $(pgrep x); kill "$@"'
    allows 'PID=$(cat app.pid); kill $PID'; allows 'node server.js & PID=$!; kill $PID'; allows 'kill $(cat pidfile)'
    allows 'PID=1234; kill $PID'; allows 'ps -p $PID -o comm= ; kill $PID'
    ok "kill of a pid derived from pgrep/pidof/ps in the same command is denied; pidfile, \$! and literal pids are allowed" ;;
  find_xargs)
    denies 'find /proc -maxdepth 1 -name "1*" -exec kill {} \;'; denies 'find . -name x -exec pkill {} \;'
    denies 'find . -name "*.pid" | xargs kill'; denies 'ps aux | grep node | awk "{print \$2}" | xargs kill -9'
    denies 'pgrep x | xargs -r kill -9'; denies 'pidof node | xargs kill'
    allows 'find . -name "*.log" -exec rm {} \;'; allows 'find . -name "*.log" -exec grep kill {} \;'; allows 'cat app.pid | xargs kill'
    ok "find -exec kill/pkill and xargs kill fed by pgrep/pidof/ps/find are denied; unrelated find -exec and a pidfile xargs are allowed" ;;
  interpreters)   # code text of an interpreter one-liner or script read from stdin
    denies "python3 -c 'import os; os.system(\"pkill node\")'"; denies "python -c 'import os; os.kill(0, 9)'"
    denies "python -c 'import os; os.kill(-1, 9)'"; denies "perl -e 'system(\"pkill node\")'"; denies "perl -e 'kill 9, -1'"
    denies "node -e 'process.kill(0)'"; denies "node -e 'process.kill(-1, \"SIGKILL\")'"
    denies "node -e 'require(\"child_process\").execSync(\"killall node\")'"; denies "ruby -e 'Process.kill(\"TERM\", 0)'"
    denies "python3 - <<'PY'
import os
os.system('pkill node')
PY"
    denies "echo 'pkill node' | sh"
    allows "python3 -c 'print(1+1)'"; allows "python3 -c 'import os; os.kill(12345, 0)'"; allows "node -e 'process.kill(child.pid)'"
    allows "node -e 'console.log(1)'"; allows "perl -e 'print 1'"; allows "echo 'pkill node' | cat"
    ok "python/perl/node/ruby one-liners and stdin scripts holding pkill, killall or a mass kill are denied; harmless code and a specific pid are allowed" ;;
  script_files)   # the file the command runs is read at hook time (project or temp dir, size capped)
    mkdir -p "$proj/scripts" "$proj/node_modules/x"
    printf '#!/bin/sh\npkill node\n' > "$proj/scripts/stop.sh"; printf '#!/bin/sh\nkill $(pgrep node)\n' > "$proj/scripts/stop2.sh"
    printf 'import os\nos.system("killall node")\n' > "$proj/scripts/x.py"; printf 'require("child_process").execSync("pkill -f vite")\n' > "$proj/scripts/x.js"
    printf 'system("pkill node");\n' > "$proj/scripts/x.pl"; printf '#!/bin/bash\nkill 0\n' > "$proj/scripts/runme"; chmod +x "$proj/scripts/runme"
    td=$(mktemp -d "$base/t.XXXXXX"); printf 'killall node\n' > "$td/t.sh"
    for c in 'sh scripts/stop.sh' 'bash scripts/stop2.sh' 'source scripts/stop.sh' 'python3 scripts/x.py' 'node scripts/x.js' 'perl scripts/x.pl' './scripts/runme' "sh $td/t.sh"; do denies "$c"; done
    denies "printf '#!/bin/sh\npkill node\n' > w.sh; sh w.sh"
    ok "sh/bash/source/python/node/perl/./ running a project or temp-dir file with kill-by-name content is denied, also a file written and run in the same command" ;;
  script_files_allowed)
    mkdir -p "$proj/scripts" "$proj/node_modules/x"
    printf '#!/bin/sh\nnpm test\nkill $!\n' > "$proj/scripts/ok.sh"; printf 'print("hi")\n' > "$proj/scripts/ok.py"
    printf 'pkill node\n' > "$proj/node_modules/x/s.sh"
    { head -c 400000 /dev/zero | tr '\0' 'a'; printf '\npkill node\n'; } > "$proj/scripts/big.sh"
    outside=$HOME/.proofline-kg-test-$$.sh; printf 'pkill node\n' > "$outside"
    for c in 'sh scripts/ok.sh' 'python3 scripts/ok.py' 'sh node_modules/x/s.sh' 'sh scripts/big.sh' 'sh scripts/missing.sh' "sh $outside" 'cat scripts/ok.sh' 'bash -c "echo hi"'; do
      allows "$c"
    done
    rm -f "$outside"
    mkdir -p "$proj/control-plane/agents/scripts"; cp "$repo/control-plane/agents/scripts/batch.sh" "$proj/control-plane/agents/scripts/batch.sh"
    allows 'sh control-plane/agents/scripts/batch.sh'; allows "sh $repo/control-plane/agents/scripts/batch.sh"
    ok "clean, missing, oversized, node_modules and out-of-allowed-dir script files are allowed, and the batch driver run as sh batch.sh is allowed" ;;
  eval_variable)
    denies 'eval "pkill node"'; denies 'eval "kill 0"'; denies 'CMD="pkill node"; eval "$CMD"'; denies 'K=pkill; $K node'
    denies 'K=killall; "$K" node'; denies 'CMD="kill 0"; $CMD'; denies 'PID=0; kill $PID'
    allows 'eval "$(brew shellenv)"'; allows 'eval "$(ssh-agent -s)"'; allows 'K=echo; $K hi'; allows 'X=1; eval "echo $X"'
    ok "eval and a command word assigned a kill verb in the same command are denied; eval of tool output and harmless variables are allowed" ;;
  indirect_allowed)
    allows 'kill $!'; allows 'kill -0 12'; allows 'kill $(cat pidfile)'; allows 'kill -- -1234'; allows 'echo pkill'
    allows 'echo "pkill node is denied"'; allows 'grep -n "kill 0" notes.txt'; allows 'lsof -i :3000'
    allows "$(printf "git commit -F - <<'EOF'\ndocs: pkill and killall are denied\nEOF")"
    allows "$(printf 'git commit -F - <<EOF\ndocs: pkill node and kill 0 are denied\nEOF')"
    ok "kill \$!, kill -0, a pidfile, kill -- -1234, quoted text, lsof and a commit heredoc mentioning pkill are allowed" ;;
  taint_deny)   # A161: pid lists built by process search reach kill through substitutions, arrays, loops, interpreters
    while IFS= read -r c; do denies "$c"; done <<'EOF'
kill $(ps -o pid= -C node)
for p in $(ps -o pid= -C node); do kill $p; done
x=$(ps -o pid= -C node); kill $x
kill $(ps -eo pid=,args= | grep node | cut -d" " -f1)
kill $(ps -o pid -C node)
awk 'BEGIN{system("pkill node")}'
python3 -c 'print("pkill")'
xargs pkill
pids=($(pgrep x)); kill ${pids[@]}
while read p; do kill $p; done < <(pgrep x)
mapfile -t a < <(pgrep x); kill "${a[@]}"
pgrep x | python3 -c 'import os,sys; [os.kill(int(l),9) for l in sys.stdin]'
EOF
    ok "kill fed by ps -o pid=, arrays, process substitution, mapfile, awk system, a python print of pkill, xargs pkill and a python pipe kill are denied" ;;
  script_runners)   # A161: scripts reached through a pipe, cd, shell options or a node script
    mkdir -p "$proj/d" "$proj/bench"
    printf 'pkill node\n' > "$proj/k.sh"; printf 'pkill node\n' > "$proj/d/k.sh"
    printf 'const cp=require("child_process");\nfor (const l of cp.execSync("pgrep x").toString().split("\\n")) process.kill(Number(l));\n' > "$proj/bench/kill.js"
    for c in 'cat k.sh | sh' 'cd d && sh k.sh' 'bash --norc k.sh' 'node bench/kill.js'; do denies "$c"; done
    ok "a script holding pkill run by cat | sh, cd d && sh, bash --norc, and a node script killing pgrep output are denied" ;;
  script_runners_allowed)
    mkdir -p "$proj/bench"
    printf 'echo hello\nnpm test\n' > "$proj/ok.sh"
    printf 'const cp=require("child_process");\nconst child=cp.spawn("sleep",["5"]);\ncp.execSync("ps -o rss= -p "+child.pid);\nprocess.kill(child.pid);\n' > "$proj/bench/run.js"
    printf 'import os,subprocess,signal\nopen("/proc/self/status").read()\nc=subprocess.Popen(["sleep","5"])\nos.kill(c.pid, signal.SIGTERM)\n' > "$proj/bench/own.py"
    for c in 'bash --norc ok.sh' 'node bench/run.js' 'python3 bench/own.py'; do allows "$c"; done
    ok "a clean script with --norc, a node benchmark killing its own child and a python script killing its own child are allowed" ;;
  allowed_misc)
    while IFS= read -r c; do allows "$c"; done <<'EOF'
awk '/killall/ {print}' README.md
echo 123 | xargs kill
python3 -c 'import psutil; psutil.Process(1234).kill()'
ssh host pkill x
docker exec c pkill x
n=$(FOO=1 pgrep x | wc -l); echo $n
EOF
    ok "awk matching killall, echo pid | xargs kill, psutil.Process(pid).kill(), ssh/docker exec pkill and a pgrep substitution that never reaches kill are allowed" ;;
  deny_message)   # the denial for text that only prints a kill word tells the user how to run it themselves
    out=$(pre "python3 -c 'print(\"pkill\")'")
    printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "not denied: $out"
    printf '%s' "$out" | grep -Fq 'the ! prefix' || die "denial text lacks the ! prefix hint: $out"
    ok "the denial for python print(\"pkill\") names the ! prefix" ;;
  budget)   # the guard's own time budget: with 0 seconds a script naming a kill word is denied, others pass
    # the budget is read every 20 records, so the scripts are 30 commands long
    { i=0; while [ $i -lt 30 ]; do echo "echo $i"; i=$((i + 1)); done; echo 'kill 12'; } > "$proj/bk.sh"
    { i=0; while [ $i -lt 30 ]; do echo "echo $i"; i=$((i + 1)); done; echo 'echo hi'; } > "$proj/bn.sh"
    pre_b() { printf '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$proj" "$(jstr "$1")" | PROOFLINE_KG_BUDGET=0 sh "$hook" pretool claude; }
    out=$(pre_b 'sh bk.sh'); printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "budget 0 did not deny a script holding kill: $out"
    printf '%s' "$out" | grep -Fq 'ran out of time' || die "budget denial text missing: $out"
    out=$(pre_b 'sh bn.sh'); ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "budget 0 denied a script without a kill word: $out"
    ok "with PROOFLINE_KG_BUDGET=0 a script holding kill 12 is denied and one without a kill word is allowed" ;;
  esac
done
echo "kill guard tests passed"
