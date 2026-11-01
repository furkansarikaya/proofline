#!/bin/sh
# shellcheck disable=SC2154,SC2016,SC2015 # fixture vars come from test-lib.sh; literal command text
# A202 item 28: the approval record does not depend on the size of the run folder or on how loaded the machine is.
#  - the user's message is on disk first (one small file), before any git call, lock or scan, and survives a forced hook timeout;
#  - a timed-out approval step says "your approval could not be recorded, send it again" only when it truly was not recorded;
#  - the content fingerprint no longer reads the run folder; the big-file hash cache never reaches an integrity check;
#  - the hook time knobs are config values, validated, and kept by an upgrade;
#  - next and digest stay close to their small-run time with a large run folder (performance, relative).
#   LC_ONLY=<substring> runs only matching scenarios.
set -u
if [ -z "${AL_INNER:-}" ]; then
  repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
  AL_INNER=1 AL_REPO=$repo exec sh -c '. "$0"; . "$1"' "$repo/control-plane/agents/scripts/test-lib.sh" "$repo/tests/enforcement/approval-load-test.sh"
fi
# The hook under test: HOOK_UNDER_TEST=<path of proofline-hook.mjs> runs this suite against the Node hook (a harness choice, read by this file only);
# the default is the shell hook. The hook never reads it.
hook=${HOOK_UNDER_TEST:-$AL_REPO/adapters/claude/hooks/proofline-hook.sh}
case $hook in *.mjs) hrun=node; hbase=proofline-hook.mjs ;; *) hrun=sh; hbase=proofline-hook.sh ;; esac
# install_hook: the hook (a Node hook also needs its folder and the project's core) into .agents/hooks of the fixture
install_hook() {
  case $hook in
    *.mjs) cp -R "$(dirname "$hook")/." .agents/hooks/; cp "$tl_agents/scripts/proofline-core.mjs" .agents/scripts/; cp -R "$tl_agents/scripts/core" .agents/scripts/core
      printf '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n' >> .git/info/exclude ;;
    *) cp "$hook" .agents/hooks/ ;;
  esac
}
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT PROOFLINE_JSON PROOFLINE_HOOK_APPROVE_BUDGET PROOFLINE_HOOK_LOCK_WAIT PROOFLINE_HOOK_NEXT_BUDGET 2>/dev/null || true
PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY
fixture() {
  scaffold orchestrated no COMPLEX ""
  cp -R "$tl_agents/githooks" .agents/githooks; mkdir -p .agents/hooks; install_hook
  printf '.agents/githooks/\n.agents/hooks/\n' >> .git/info/exclude
  git config core.hooksPath .agents/githooks; git config commit.gpgsign false
}
prompt() { printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"%s","prompt":"%s"}' "$PWD" "$1" | $hrun .agents/hooks/$hbase prompt claude; }
ms() { v=$(date +%s%N 2>/dev/null); case "$v" in ''|*[!0-9]*) perl -MTime::HiRes=time -e 'printf "%d", time()*1000' ;; *) echo $((v / 1000000)) ;; esac; }
bigfiles() { # DIR COUNT BYTES: deterministic filler files (not images, but big and distinct)
  bf_i=0; mkdir -p "$1"
  while [ "$bf_i" -lt "$2" ]; do awk -v n="$3" -v s="$bf_i" 'BEGIN { x = s * 7919 + 13; for (k = 0; k < n / 16; k++) { x = (x * 1103515245 + 12345) % 2147483648; printf "%016d", x % 10000000000000000 } }' > "$1/shot-$bf_i.png"; bf_i=$((bf_i + 1)); done
}

# the fingerprint ignores .agents/ entirely: a run folder that is NOT git-ignored changes nothing, and it is not read
fp_run_folder() {
  fixture; printf '.agents/local/\n' > .gitignore
  before=$(A fingerprint LC)
  bigfiles .agents/runs/LC/reviews/visual-proof/screens 30 20000
  after=$(A fingerprint LC)
  [ "$before" = "$after" ] || die "a non-ignored run folder changed the content fingerprint ($before then $after)"
  echo changed >> impl.txt
  [ "$(A fingerprint LC)" != "$after" ] || die "a product change did not change the content fingerprint"
  ok "A202-28 the content fingerprint does not read the run folder, and still sees product changes"
}

# the big-file cache: read-only commands may use it, every sealing command rehashes; a same-size, same-mtime edit is found
fp_cache_integrity() {
  fixture
  head -c 400000 /dev/zero | tr '\0' 'a' > impl.txt
  p0=$(A patch-fingerprint LC) || die "patch-fingerprint failed"
  [ -s .agents/local/fp-cache ] || die "the big file was not remembered by the sealing command (cache empty)"
  # a forged cache line for the file's key must not reach a sealing command
  key=$(cut -f1 .agents/local/fp-cache | tail -1); printf 'forged' > "$base/forged"; printf '%s\t%s\n' "$key" "$(tsha "$base/forged")" >> .agents/local/fp-cache
  [ "$(A patch-fingerprint LC)" = "$p0" ] || die "a forged cache line changed a sealing fingerprint"
  # same size, same mtime, one byte different: the sealing check must see it
  touch -r impl.txt "$base/mt"; head -c 399999 /dev/zero | tr '\0' 'a' > "$base/new"; printf 'b' >> "$base/new"
  cat "$base/new" > impl.txt; touch -r "$base/mt" impl.txt
  p1=$(A patch-fingerprint LC)
  [ "$p1" != "$p0" ] || die "an edit that kept size and mtime was not detected by the sealing fingerprint"
  # the read-only path rehashes too (ctime and the key differ), so a display never shows the old hash
  A digest LC >/dev/null 2>&1 || :
  [ "$(A patch-fingerprint LC)" = "$p1" ] || die "the fingerprint changed without a file change"
  ok "A202-28 a forged or stale cache never reaches a sealing fingerprint; a same-size same-mtime edit is detected"
}

# the config knobs: validated, bounded, kept by an upgrade; the hook reads them
hook_config_knobs() {
  new_repo; c=.agents/config.yaml
  A config-check >/dev/null || die "the default config does not pass config-check"
  for bad in "approve_budget_seconds: 0" "approve_budget_seconds: 99" "approve_budget_seconds: abc" "next_budget_seconds: 1" "lock_wait_seconds: 0" "lock_wait_seconds: 21" "turbo: 1"; do
    cp "$c" "$base/cfg.bak"; awk -v l="  $bad" '{ print } /^hook:$/ { print l }' "$base/cfg.bak" > "$base/cfg.bad"
    ( A config-check "$base/cfg.bad" >/dev/null 2>&1 ) && die "config-check accepted hook.$bad"
  done
  cp "$c" "$base/cfg.bak"; sed 's/approve_budget_seconds: 20/approve_budget_seconds: 12/' "$base/cfg.bak" > "$base/cfg.ok"; A config-check "$base/cfg.ok" >/dev/null || die "a valid knob value was refused"
  # an out-of-range value in a hand-edited file is moved into its bounds, never to zero
  sed 's/approve_budget_seconds: 20/approve_budget_seconds: 0/' "$base/cfg.bak" > "$c"
  [ "$(A hook-config | sed -n 's/^approve_budget_seconds=//p')" = 5 ] || die "a zero budget was not raised to the minimum"
  sed 's/lock_wait_seconds: 8/lock_wait_seconds: 500/' "$base/cfg.bak" > "$c"
  [ "$(A hook-config | sed -n 's/^lock_wait_seconds=//p')" = 20 ] || die "a huge lock wait was not cut to the maximum"
  # review A3: a leading zero is a number, never an octal arithmetic error in the hook or agent.sh
  sed 's/approve_budget_seconds: 20/approve_budget_seconds: 08/; s/lock_wait_seconds: 8/lock_wait_seconds: 09/' "$base/cfg.bak" > "$c"
  [ "$(A hook-config | sed -n 's/^approve_budget_seconds=//p')" = 8 ] || die "approve_budget_seconds 08 is not read as 8: $(A hook-config 2>&1)"
  [ "$(A hook-config | sed -n 's/^lock_wait_seconds=//p')" = 9 ] || die "lock_wait_seconds 09 is not read as 9"
  A hook-timeouts 2>&1 | grep -q '^prompt=' || die "hook-timeouts failed with a leading zero"
  # upgrade: the user's value is kept, an old config without the block gets the defaults
  # shellcheck disable=SC1091
  . "$AL_REPO/bin/lib/config.sh"
  sed 's/approve_budget_seconds: 20/approve_budget_seconds: 12/' "$base/cfg.bak" > "$base/user.yaml"
  cfg_merge_new "$base/user.yaml" "$tl_agents/config.yaml" > "$base/merged.yaml"
  [ "$(cfg_get "$base/merged.yaml" hook.approve_budget_seconds)" = 12 ] || die "upgrade did not keep the user's hook.approve_budget_seconds"
  grep -v '^hook:\|^  approve_budget_seconds\|^  next_budget_seconds\|^  lock_wait_seconds' "$base/cfg.bak" > "$base/old.yaml"
  cfg_merge_new "$base/old.yaml" "$tl_agents/config.yaml" > "$base/merged2.yaml"
  [ "$(cfg_get "$base/merged2.yaml" hook.approve_budget_seconds)" = 20 ] || die "upgrade did not add the default hook block to an old config"
  ok "A202-28 hook time knobs are validated, bounded below and above, and kept by an upgrade"
}

# the user's message is on disk first: the hook is slowed by a git shim and stopped; the intake file exists before git ran
intake_first() {
  fixture
  mkdir -p "$base/shim"; printf '#!/bin/sh\nsleep 4\nexec %s "$@"\n' "$(command -v git)" > "$base/shim/git"; chmod +x "$base/shim/git"
  t0=$(ms)
  ( printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"%s","prompt":"plan approved, go ahead"}' "$PWD" | CLAUDE_PROJECT_DIR=$PWD PATH="$base/shim:$PATH" $hrun .agents/hooks/$hbase prompt claude >/dev/null 2>&1 ) &
  hp=$!
  i=0; while [ "$i" -lt 30 ]; do ls .agents/local/prompts/intake/*.json >/dev/null 2>&1 && break; sleep 0.1; i=$((i + 1)); done
  t1=$(ms)
  ls .agents/local/prompts/intake/*.json >/dev/null 2>&1 || die "the prompt was not on disk while the hook was still waiting for git"
  kill "$hp" 2>/dev/null; wait "$hp" 2>/dev/null || :
  grep -q 'plan approved, go ahead' .agents/local/prompts/intake/*.json || die "the intake file does not hold the user's message"
  [ $((t1 - t0)) -lt 3500 ] || die "the intake write waited for git ($((t1 - t0)) ms)"
  ok "A202-28 the user's message is written first, before any git call or scan, and survives a stopped hook"
}

# forced timeout: the approval step is stopped by its budget; the message says it was not recorded; the message itself is kept
timeout_message() {
  fixture
  A request-approval LC plan >/dev/null; sleep 1
  sleep 60 & holder=$!
  mkdir .agents/local/.lock && printf '%s\n' "$holder" > .agents/local/.lock/pid
  out=$(PROOFLINE_HOOK_LOCK_WAIT=30 PROOFLINE_HOOK_APPROVE_BUDGET=1 prompt 'plan approved, go ahead')
  kill "$holder" 2>/dev/null; rm -rf .agents/local/.lock
  printf '%s' "$out" | grep -q 'your approval could not be recorded, send it again' || die "no one-line 'could not be recorded, send it again' on a forced timeout: $out"
  [ "$(printf '%s' "$out" | wc -l | tr -d ' ')" -le 1 ] || die "the timeout message is more than one line"
  ! ls .agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml >/dev/null 2>&1 || die "an approval exists although the step was stopped"
  grep -q 'plan approved, go ahead' .agents/local/prompts/history/* || die "the user's message is not in the prompt history"
  grep -q 'plan approved, go ahead' .agents/local/prompts/intake/*.json || die "the user's message is not in the intake"
  # an approval that DID get written before the stop is reported as recorded, not as lost
  sleep 1; A request-approval LC plan >/dev/null 2>&1 || :; sleep 1
  out=$(prompt 'plan approved, go ahead')
  printf '%s' "$out" | grep -q 'approval recorded' || die "a normal approval was not recorded: $out"
  # review A2: the approval is written, then the process runs past the budget: the message says it IS recorded
  rm -f .agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml; sleep 1; A request-approval LC plan >/dev/null 2>&1 || :; sleep 1
  mkdir -p "$base/shim2"; rm -f "$base/slept"
  # the slow step is simulated by a `date` shim, which only the shell code of approve runs (the Node core runs in-process, no date process): this part pins the shell code
  printf 'sh:approve-pending,approve\n' > .agents/local/engine
  printf '#!/bin/sh\nif ls "%s"/.agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml >/dev/null 2>&1 && [ ! -e "%s/slept" ]; then : > "%s/slept"; sleep 8; fi\nexec %s "$@"\n' "$PWD" "$base" "$base" "$(command -v date)" > "$base/shim2/date"; chmod +x "$base/shim2/date"
  out=$(PATH="$base/shim2:$PATH" PROOFLINE_HOOK_APPROVE_BUDGET=2 prompt 'plan approved, go ahead')
  printf '%s' "$out" | grep -q 'your approval was recorded' || { printf '%s' "$out" | grep -q 'approval recorded' && ls "$base/slept" >/dev/null 2>&1 && die "approval written then slow: no timeout path was taken: $out"; die "the recorded-then-timed-out case did not say recorded: $out"; }
  printf '%s' "$out" | grep -q 'could not be recorded' && die "a written approval was reported as lost: $out"
  rm -f .agents/local/engine
  # review A3 at the hook: a budget written with a leading zero does not break the hook's arithmetic, the approval is still recorded
  rm -f .agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml; sleep 1; A request-approval LC plan >/dev/null 2>&1 || :; sleep 1
  sed 's/approve_budget_seconds: 20/approve_budget_seconds: 08/' .agents/config.yaml > "$base/cfg0" && cp "$base/cfg0" .agents/config.yaml
  grep -q 'approve_budget_seconds: 08' .agents/config.yaml || die "test setup: the zero-padded budget was not written"
  out=$(prompt 'plan approved, go ahead')
  ls .agents/runs/LC/approvals/[0-9][0-9][0-9]-plan.yaml >/dev/null 2>&1 || die "a budget of 08 broke the approval step: $out"
  ok "A202-28 a forced hook timeout keeps the message and says in one line that the approval was not recorded"
}

# performance: next and digest with a large, non-ignored run folder stay close to the time of a small run (relative; absolute times depend on the machine)
big_run_perf() {
  fixture; printf '.agents/local/\n' > .gitignore
  A next LC >/dev/null 2>&1 || :   # warm-up
  t0=$(ms); A next LC >/dev/null 2>&1; t1=$(ms); n_small=$((t1 - t0))
  t0=$(ms); A digest LC >/dev/null 2>&1; t1=$(ms); d_small=$((t1 - t0))
  bigfiles .agents/runs/LC/reviews/visual-proof/screens "${AL_FILES:-300}" "${AL_BYTES:-50000}"
  du -sk .agents/runs/LC | awk '{ printf "run folder %.1f MB\n", $1 / 1024 }'
  t0=$(ms); A next LC >/dev/null 2>&1; t1=$(ms); n_big=$((t1 - t0))
  t0=$(ms); A digest LC >/dev/null 2>&1; t1=$(ms); d_big=$((t1 - t0))
  echo "next $n_small -> $n_big ms, digest $d_small -> $d_big ms"
  # threshold: twice the small-run time plus 5 s of slack (the run folder adds nothing the commands read), and 90 s as a ceiling for a starved runner
  [ "$n_big" -le $((n_small * 2 + 5000)) ] && [ "$n_big" -le 90000 ] || die "next with a large run folder took $n_big ms (small run: $n_small ms)"
  [ "$d_big" -le $((d_small * 2 + 5000)) ] && [ "$d_big" -le 90000 ] || die "digest with a large run folder took $d_big ms (small run: $d_small ms)"
  ok "A202-28 next and digest do not grow with the run folder (300 files, about 14 MB)"
}

# doctor measures the approval path and warns near the budget
doctor_budget() {
  fixture
  cp -R "$AL_REPO/bin" "$base/proofline-bin" 2>/dev/null || :
  sed 's/approve_budget_seconds: 20/approve_budget_seconds: 5/' .agents/config.yaml > "$base/cfg" && cp "$base/cfg" .agents/config.yaml
  mkdir -p "$base/shim"; printf '#!/bin/sh\ncase "$*" in *" add "*) sleep 3 ;; esac\nexec %s "$@"\n' "$(command -v git)" > "$base/shim/git"; chmod +x "$base/shim/git"
  out=$(PATH="$base/shim:$PATH" sh "$AL_REPO/bin/proofline" doctor 2>&1) || :
  printf '%s' "$out" | grep -q '^WARN approval path: ' || die "doctor did not warn about a slow approval path: $(printf '%s' "$out" | grep -i 'approval path\|FAIL' | head -3)"
  out=$(sh "$AL_REPO/bin/proofline" doctor 2>&1) || :
  printf '%s' "$out" | grep -q 'approval path: ' || die "doctor did not report the approval path time"
  ok "A202-28 doctor measures the approval path and warns when it nears the hook budget"
}

fails=0
scenarios='fp_run_folder fp_cache_integrity hook_config_knobs intake_first timeout_message big_run_perf doctor_budget'
for sc in $scenarios; do
  run_sc "$sc" || { fails=$((fails + 1)); echo "FAIL scenario $sc"; }
done
[ "$fails" = 0 ] || { echo "approval-load tests: $fails scenario(s) failed"; exit 1; }
echo "approval-load tests passed"
