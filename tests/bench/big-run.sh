#!/bin/sh
# shellcheck disable=SC2154,SC2016 # fixture vars come from test-lib.sh
# Measurement (A202 item 28), not run by CI: how long `agent.sh next`, `digest`, the run fingerprint and the prompt hook's approval path take
# when the run folder is large (the real case: ~30 MB, 26 MB of it screenshots under reviews/). The fixture is generated here, deterministically
# (a counter-seeded byte stream, never committed). Output: `step ms`.
#   FILES=<n> (default 400) BYTES=<per file> (default 70000)    sh tests/bench/big-run.sh
set -u
if [ -z "${BR_INNER:-}" ]; then
  repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
  BR_INNER=1 BR_REPO=$repo exec sh -c '. "$0"; . "$1"' "$repo/control-plane/agents/scripts/test-lib.sh" "$repo/tests/bench/big-run.sh"
fi
PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY
ms() { v=$(date +%s%N 2>/dev/null); case "$v" in ''|*[!0-9]*) perl -MTime::HiRes=time -e 'printf "%d", time()*1000' ;; *) echo $((v / 1000000)) ;; esac; }
timeit() { # NAME CMD...: wall milliseconds of one run
  t_n=$1; shift; t0=$(ms); "$@" >/dev/null 2>&1; t1=$(ms); printf '%-26s %s ms\n' "$t_n" $((t1 - t0))
}
scaffold orchestrated no COMPLEX ""
case "${BR_STATE:-implemented}" in implemented) worker RED fail impl_test.txt 'test: x'; worker GREEN pass impl.txt 'impl: x'; A handoff "$RID" IMPLEMENTED >/dev/null ;; codedone) to_code_done orchestrated ;; esac
node "$tl_agents/../../tests/legacy-githooks/install.mjs" .agents/githooks
[ -z "${BR_UNIGNORED:-}" ] || printf '.agents/local/\n' > .gitignore   # BR_UNIGNORED=1: the run folder is NOT git-ignored (a project that lost the line)
files=${FILES:-400}; bytes=${BYTES:-70000}
bigdir=.agents/runs/$RID/reviews/visual-proof/screens; mkdir -p "$bigdir"
# deterministic pseudo-images: file i holds the 64-bit-ish stream of awk's integer arithmetic seeded by i (no /dev/urandom, no timestamps)
i=0; while [ "$i" -lt "$files" ]; do
  awk -v n="$bytes" -v s="$i" 'BEGIN { x = s * 7919 + 13; for (k = 0; k < n / 16; k++) { x = (x * 1103515245 + 12345) % 2147483648; printf "%016d", x % 10000000000000000 } }' > "$bigdir/shot-$i.png"
  i=$((i + 1))
done
du -sk ".agents/runs/$RID" | awk '{ printf "run folder: %.1f MB, %s files under reviews/\n", $1 / 1024, "'"$files"'" }'
if [ -n "${BR_XTRACE:-}" ]; then   # BR_XTRACE=<file>: bash -x with a microsecond clock for `digest` (bash 5 needed), then the slowest lines
  BASH_XTRACEFD=9 PS4='+ ${EPOCHREALTIME} ${BASH_SOURCE##*/}:${LINENO} ' bash -x ./.agents/scripts/agent.sh digest "$RID" >/dev/null 9> "$BR_XTRACE" 2>&1
  awk '{ t = $2; if (p != "") { d = t - p; l[pl] += d } p = t; pl = $3 } END { for (k in l) printf "%.3f %s\n", l[k], k }' "$BR_XTRACE" | sort -rn | head -12
  exit 0
fi
if [ -n "${BR_TRACE:-}" ]; then   # BR_TRACE=<file>: a PATH shim logs every external command of `digest` with its milliseconds
  shim=$base/shim; mkdir -p "$shim"; : > "$BR_TRACE"
  for c in git sha256sum shasum find cat sed awk grep sort wc node jq du ls cp tr cut head tail xargs; do
    real=$(command -v "$c" 2>/dev/null); case "$real" in /*) ;; *) continue ;; esac
    printf '#!/bin/sh\nprintf "%%s %%.90s\\n" "%s" "$*" >> "$BR_TRACE"\nexec %s "$@"\n' "$c" "$real" > "$shim/$c"; chmod +x "$shim/$c"
  done
  PATH="$shim:$PATH" sh ./.agents/scripts/agent.sh digest "$RID" >/dev/null 2>&1
  awk '{ c[$1]++ } END { for (k in c) print c[k], k }' "$BR_TRACE" | sort -rn | head -8
  exit 0
fi
if [ -n "${BR_EXTRA:-}" ]; then for c in $BR_EXTRA; do timeit "$c" A "$c" "$RID"; done; fi
if [ -z "${BR_NOHOOK:-}" ]; then   # the prompt hook's approval path: a request is open, the user's reply arrives, the hook records it
  hook=${BR_HOOK:-$BR_REPO/adapters/claude/hooks/proofline-hook.sh}
  mkdir -p .agents/hooks; cp "$hook" .agents/hooks/proofline-hook.sh; printf '.agents/hooks/\n' >> .git/info/exclude
  CLAUDE_PROJECT_DIR=$PWD; export CLAUDE_PROJECT_DIR
  hp() { printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"%s","prompt":"plan approved, go ahead"}' "$PWD" | sh ./.agents/hooks/proofline-hook.sh prompt claude; }
  A request-approval "$RID" plan >/dev/null 2>&1; sleep 1
  timeit hook-prompt-approval hp
  A request-approval "$RID" plan >/dev/null 2>&1; sleep 1
  timeit approve-pending A approve-pending "$RID"
fi
timeit next A next "$RID"
timeit digest A digest "$RID"
timeit summary A summary "$RID"
