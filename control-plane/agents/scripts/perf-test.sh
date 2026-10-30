#!/bin/sh
# shellcheck disable=SC2015,SC2016,SC2154,SC2329 # test code: assertion chains, literal text, fixture vars from test-lib.sh
# Control plane speed (A203): `agent.sh next` and `agent.sh digest` on a run of realistic size must stay cheap in PROCESSES. In 0.0.39 one `next`
# started about 840 awk processes (next 9 s, digest 46 s) because each gate, risk signal and run value was computed again in a subshell
# of its own. The main assertion is the number of external processes (counted by a PATH wrapper for every common tool, never by the clock);
# the time budget is generous on purpose so a slow Linux runner does not flake.
# The fixture: a frozen COMPLEX run at IMPLEMENTED with passing gate records, 120 more ledger lines, 30 result files and the hook timings
# of 12 hook flushes. It also checks that a hook timing is never a ledger line (A203).
#   PERF_AGENT=<agent.sh>   measure that script instead (to record a BEFORE number from an older agent.sh); PERF_REPORT=1 prints the numbers.
#   LC_ONLY=<substring> runs only matching scenarios.
set -eu
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY

# Budgets. Measured on the fixture below after the patch: next about 110, digest about 150 processes (before: about 400 and about 1200).
NEXT_SPAWN_MAX=${NEXT_SPAWN_MAX:-260}
DIGEST_SPAWN_MAX=${DIGEST_SPAWN_MAX:-340}
TIME_MAX_S=${TIME_MAX_S:-90}

perf_fixture() {
  scaffold orchestrated no COMPLEX
  worker RED fail impl_test.txt 'test: lookup returns the stored value'; worker GREEN pass impl.txt 'impl: lookup returns the stored value'
  A handoff LC IMPLEMENTED >/dev/null
  A secret-scan LC >/dev/null
  pf_n=0
  for pf_g in $(required); do
    case "$pf_g" in SECRETS|VERIFY) continue ;; esac
    pf_n=$((pf_n + 1)); [ "$pf_n" -le 3 ] || break
    gpass "$pf_g"
  done
  [ -z "${PERF_AGENT:-}" ] || cp "$PERF_AGENT" .agents/scripts/agent.sh   # an older script measures its own (larger) ledger from here on
  # the hook timings of 12 flushes, as the runtime hooks spool them
  pf_i=0
  while [ "$pf_i" -lt 12 ]; do
    for pf_e in pretool posttool prompt stop session; do printf '1|%s|12|ok|\n' "$pf_e" >> .agents/local/hook-times; done
    A hook-time LC >/dev/null; pf_i=$((pf_i + 1))
  done
  # 120 more ledger lines (notes), chained exactly like the control plane chains them
  pf_l=.agents/runs/LC/LEDGER.log
  pf_last=$(tail -n 1 "$pf_l"); pf_seq=${pf_last#seq=}; pf_seq=${pf_seq%% *}
  pf_dg=${pf_last#* digest=}; pf_dg=${pf_dg%% *}
  pf_i=0
  while [ "$pf_i" -lt 120 ]; do
    pf_prev=$(printf '%s' "$pf_last" | pf_h); pf_seq=$((pf_seq + 1))
    pf_last="seq=$pf_seq prev=$pf_prev event=note role=lead from=IMPLEMENTED to=IMPLEMENTED digest=$pf_dg ts=2026-01-01T00:00:00Z epoch=1 detail=perf fixture note $pf_i"
    printf '%s\n' "$pf_last" >> "$pf_l"; pf_i=$((pf_i + 1))
  done
  # 30 result files of earlier dispatches
  mkdir -p .agents/runs/LC/results
  pf_i=0; while [ "$pf_i" -lt 30 ]; do printf 'ROLE: explorer\nTASK: LC\nRESULT: DONE\n' > ".agents/runs/LC/results/9$(printf '%02d' "$pf_i")-explorer.result.md"; pf_i=$((pf_i + 1)); done
  A verify-seal LC >/dev/null 2>&1 || die "fixture: the synthetic ledger does not verify"
  # the process-counting wrapper: one script per common tool, built from builtins only (it must not start a process of its own)
  pf_shim=$base/shim; mkdir -p "$pf_shim"
  for pf_c in git sha256sum shasum find cat sed awk grep sort wc node jq du ls cp tr cut head tail xargs date mktemp mv rm mkdir expr basename dirname uniq od ps tee comm diff; do
    pf_real=$(command -v "$pf_c" 2>/dev/null) || continue
    case "$pf_real" in /*) ;; *) continue ;; esac
    printf '#!/bin/sh\nprintf "SPAWN %%s %%.30s %%.24s %%.24s\\n" "%s" "$1" "$2" "$3" >> "$PERF_LOG"\nexec %s "$@"\n' "$pf_c" "$pf_real" > "$pf_shim/$pf_c"; chmod +x "$pf_shim/$pf_c"
  done
}
now_s() { date +%s; }
pf_h() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1; else sha256sum | cut -d' ' -f1; fi; }
# perf_measure COMMAND -> sets pm_spawns, pm_secs, pm_out
perf_measure() {
  PERF_LOG=$base/spawn.$1; export PERF_LOG; : > "$PERF_LOG"
  pm_t0=$(now_s)
  pm_out=$(PATH="$pf_shim:$PATH" sh ./.agents/scripts/agent.sh "$1" LC 2>&1) || die "agent.sh $1 failed: $pm_out"
  pm_secs=$(( $(now_s) - pm_t0 ))
  pm_spawns=$(grep -c '^SPAWN' "$PERF_LOG" || true)
  [ -z "${PERF_REPORT:-}" ] || printf 'perf: %s: %s processes, %s s (wrapped)\n' "$1" "$pm_spawns" "$pm_secs"
  [ "${PERF_REPORT:-}" != 2 ] || grep "^SPAWN" "$PERF_LOG" | sort | uniq -c | sort -rn | head -25
}

sc_next_digest_budget() {
  perf_fixture
  perf_measure next
  [ "$pm_spawns" -le "$NEXT_SPAWN_MAX" ] || die "next started $pm_spawns processes on a realistic run (budget $NEXT_SPAWN_MAX): $(awk '/^SPAWN/ { c[$2]++ } END { for (k in c) printf "%s=%s ", k, c[k] }' "$PERF_LOG")"
  [ "$pm_secs" -le "$TIME_MAX_S" ] || die "next took $pm_secs s (budget $TIME_MAX_S s)"
  printf '%s\n' "$pm_out" | grep -q '^next=' || die "next printed no next= line: $pm_out"
  perf_measure digest
  [ "$pm_spawns" -le "$DIGEST_SPAWN_MAX" ] || die "digest started $pm_spawns processes on a realistic run (budget $DIGEST_SPAWN_MAX): $(awk '/^SPAWN/ { c[$2]++ } END { for (k in c) printf "%s=%s ", k, c[k] }' "$PERF_LOG")"
  [ "$pm_secs" -le "$TIME_MAX_S" ] || die "digest took $pm_secs s (budget $TIME_MAX_S s)"
  printf '%s\n' "$pm_out" | grep -q '^NEXT: ' || die "digest printed no NEXT: line: $pm_out"
  ok "A203 next and digest stay under the process budget on a realistic run"
}

# the speed-up changed no output: the same digest, with the gate list and the risk signals read once, as without
sc_digest_same_output() {
  perf_fixture
  pd_a=$(sh ./.agents/scripts/agent.sh digest LC 2>&1) || die "digest failed: $pd_a"
  pd_n=$(sh ./.agents/scripts/agent.sh next LC 2>&1) || die "next failed: $pd_n"
  printf '%s\n' "$pd_a" | grep -q '^STATUS: ' && printf '%s\n' "$pd_a" | grep -q '^OPEN QUESTIONS: 0$' || die "digest lost its header: $pd_a"
  # the NEXT:/WHY: lines of digest are the next=/reason= lines of next
  pd_nx=$(printf '%s\n' "$pd_n" | sed -n 's/^next=/NEXT: /p;s/^reason=/WHY: /p'); pd_dx=$(printf '%s\n' "$pd_a" | sed -n '/^NEXT: /p;/^WHY: /p')
  [ "$pd_nx" = "$pd_dx" ] || die "digest and next disagree: [$pd_dx] vs [$pd_nx]"
  # PERF_CMP=<older agent.sh>: the same run read by that script prints the same digest and the same next step (a one-off check of a speed-up)
  if [ -n "${PERF_CMP:-}" ]; then
    cp "$PERF_CMP" .agents/scripts/agent-cmp.sh
    pd_oa=$(sh ./.agents/scripts/agent-cmp.sh digest LC 2>&1) || die "the older digest failed: $pd_oa"
    pd_on=$(sh ./.agents/scripts/agent-cmp.sh next LC 2>&1) || die "the older next failed: $pd_on"
    [ "$pd_a" = "$pd_oa" ] || die "digest output changed: $(printf '%s\n--- older\n%s\n' "$pd_a" "$pd_oa" | head -40)"
    [ "$pd_n" = "$pd_on" ] || die "next output changed: $(printf '%s\n--- older\n%s\n' "$pd_n" "$pd_on" | head -40)"
    printf 'perf: digest and next print the same as the older script\n'
  fi
  # a gate recorded after a first digest is seen by the next digest (the memo lives for one process only)
  pd_g=$(required | tr ' ' '\n' | grep -vx 'SECRETS\|VERIFY' | sed -n 4p)
  if [ -n "$pd_g" ]; then
    gpass "$pd_g"
    pd_b=$(sh ./.agents/scripts/agent.sh digest LC 2>&1) || die "digest failed after a gate: $pd_b"
    [ "$pd_a" != "$pd_b" ] || die "a gate recorded after a digest is not seen by the next digest"
  fi
  ok "A203 digest agrees with next, and a recorded gate is seen by the next process"
}

# A hook timing is never a ledger line: the chained ledger holds lifecycle transitions only
sc_hook_events_not_in_ledger() {
  scaffold orchestrated
  pf_before=$(grep -c . .agents/runs/LC/LEDGER.log)
  printf '1|posttool|12|ok|\n2|pretool|7|ok|\n3|stop|900|timeout|slow\n' >> .agents/local/hook-times
  A hook-time LC >/dev/null
  ! grep -Eq ' event=hook(-timeout)? ' .agents/runs/LC/LEDGER.log || die "a hook event entered the ledger"
  [ "$(grep -c . .agents/runs/LC/LEDGER.log)" = "$pf_before" ] || die "hook-time added ledger lines"
  grep -q ' event=hook ' .agents/runs/LC/HOOKS.log && grep -q ' event=hook-timeout ' .agents/runs/LC/HOOKS.log || die "the hook events are not in HOOKS.log: $(cat .agents/runs/LC/HOOKS.log 2>/dev/null)"
  A verify-seal LC >/dev/null 2>&1 || die "hook events broke the ledger seal"
  ok "A203 hook events go to HOOKS.log, never to the hash-chained ledger"
}

run_sc sc_next_digest_budget
run_sc sc_digest_same_output
run_sc sc_hook_events_not_in_ledger
echo 'perf tests passed'
