#!/bin/sh
# Slow-machine setting for the time limits (A202 item 29). One multiplier, timeouts.scale, stretches every duration together
# (docs/concepts/timeouts.md). `proofline doctor` measures how long this machine takes for two things it does all the time, proposes a value, and
# writes it only after the user's own reply "approve scale" (an approval kind like `commands`: bound to the sha256 of the proposal file, consumed on apply).
#   proofline doctor --scale          measure, record the proposal (.agents/local/scale/PROPOSAL.tsv) and ask
#   proofline doctor --apply-scale    write the proposal after the user's reply (agent.sh scale-check decides, from the user's own message)
# Sourced by bin/proofline after config.sh (say, die, cfg_val, cfg_set, sha256) and doctor.sh (doctor_ms).

# Reference times of the two measurements, in ms, on a development laptop under a load average of about 15 (a quiet machine is faster, so a
# proposal errs low rather than high): the approval path (content fingerprint + the approval step with nothing to approve) and agent.sh config-check
# (a start of agent.sh). Measured time divided by their sum is how many times slower this machine is.
TS_REF_APPROVAL_MS=500
TS_REF_START_MS=250

ts_dir() { printf '%s\n' "$ROOT/.agents/local/scale"; }

# ts_measure: prints "APPROVAL-MS START-MS" for this machine, best of two runs each (a single cold run measures the disk cache, not the machine).
ts_measure() {
  tm_a=$ROOT/.agents/scripts/agent.sh; tm_best_a=''; tm_best_s=''
  for _ in 1 2; do
    tm_t0=$(doctor_ms); (cd "$ROOT" && sh "$tm_a" fingerprint >/dev/null 2>&1 </dev/null); (cd "$ROOT" && sh "$tm_a" approve-pending - >/dev/null 2>&1 </dev/null); tm_t1=$(doctor_ms)
    tm_ms=$((tm_t1 - tm_t0)); if [ -z "$tm_best_a" ] || [ "$tm_ms" -lt "$tm_best_a" ]; then tm_best_a=$tm_ms; fi
    tm_t0=$(doctor_ms); (cd "$ROOT" && sh "$tm_a" config-check >/dev/null 2>&1 </dev/null); tm_t1=$(doctor_ms)
    tm_ms=$((tm_t1 - tm_t0)); if [ -z "$tm_best_s" ] || [ "$tm_ms" -lt "$tm_best_s" ]; then tm_best_s=$tm_ms; fi
  done
  printf '%s %s\n' "$tm_best_a" "$tm_best_s"
}

# ts_suggest APPROVAL-MS START-MS: the proposed scale, or nothing when this machine is not slow. The ratio of measured to reference time, rounded up
# to a half, at least 1.5 (below that the default 1.0 fits) and at most 10 (the bound of timeouts.scale).
ts_suggest() {
  awk -v a="$1" -v s="$2" -v ra="$TS_REF_APPROVAL_MS" -v rs="$TS_REF_START_MS" 'BEGIN {
    r = (a + s) / (ra + rs); x = int(r * 2); if (x < r * 2) x++; x = x / 2
    if (x < 1.5) exit 0; if (x > 10) x = 10; print x }'
}

# ts_propose: measure, write the proposal and ask the one question.
ts_propose() {
  tp_m=$(ts_measure); tp_a=${tp_m% *}; tp_s=${tp_m#* }; tp_cur=$(cfg_val "$ROOT/.agents/config.yaml" timeouts.scale 1.0)
  tp_v=$(ts_suggest "$tp_a" "$tp_s")
  say "timing: approval path $tp_a ms (reference $TS_REF_APPROVAL_MS), agent.sh start $tp_s ms (reference $TS_REF_START_MS); timeouts.scale is $tp_cur now"
  if [ -z "$tp_v" ]; then
    rm -f "$(ts_dir)/PROPOSAL.tsv"
    say "scale: this machine is not slow (within 1.5 times the reference); timeouts.scale $tp_cur fits, nothing to change"
    return 0
  fi
  if [ "$tp_v" = "$tp_cur" ] || [ "$tp_v" = "${tp_cur%.0}" ]; then say "scale: the measured value $tp_v is the one set already"; return 0; fi
  mkdir -p "$(ts_dir)"
  tp_t=$(mktemp "${TMPDIR:-/tmp}/proofline-scale.XXXXXX")
  printf 'scale\t%s\n' "$tp_v" > "$tp_t"   # no time and no measurement in the file: the user's reply is bound to the value alone
  mv "$tp_t" "$(ts_dir)/PROPOSAL.tsv"
  say ""
  say "scale proposal $(sha256 "$(ts_dir)/PROPOSAL.tsv" | cut -c1-12): timeouts.scale $tp_cur -> $tp_v (every step time, build and test limit, lock wait and hook limit grows by that factor; the approval budget does not)"
  say "QUESTION (one): write timeouts.scale: $tp_v into .agents/config.yaml? Reply \"approve scale\". Nothing is written without your reply."
  sh "$ROOT/.agents/scripts/agent.sh" request-approval - scale || say "(the approval request could not be recorded: run agent.sh request-approval - scale)"
  say "  after your reply: proofline doctor --apply-scale"
}

# ts_apply: write the proposal when agent.sh says the user agreed, then put the new hook limits into the settings files.
ts_apply() {
  ta_f=$(ts_dir)/PROPOSAL.tsv
  [ -s "$ta_f" ] || die "doctor --apply-scale: no scale proposal (run: proofline doctor --scale)"
  sh "$ROOT/.agents/scripts/agent.sh" scale-check >/dev/null || die "doctor --apply-scale: the user has not agreed to this proposal yet; ask the one question and wait for the reply \"approve scale\""
  ta_v=$(awk -F'\t' '$1 == "scale" { print $2 }' "$ta_f")
  case "$ta_v" in ''|*[!0-9.]*) die "doctor --apply-scale: the proposal holds no valid scale" ;; esac
  # the approval is used up before anything is written: the same proposal cannot be applied twice from one reply
  sh "$ROOT/.agents/scripts/agent.sh" approval-consume - scale >/dev/null || die "doctor --apply-scale: the scale approval could not be consumed, so nothing was written"
  cfg_set "$ROOT/.agents/config.yaml" timeouts.scale "$ta_v" || die "config key not set: timeouts.scale"
  say "wrote timeouts.scale: $ta_v"
  mv "$ta_f" "$(ts_dir)/applied-$(date +%s).tsv"
  (cd "$ROOT" && sh .agents/scripts/agent.sh config-check) || die "the written scale does not pass agent.sh config-check; fix .agents/config.yaml"
  for ta_r in .claude/settings.json .codex/hooks.json; do
    [ -f "$ROOT/$ta_r" ] || continue
    # shellcheck disable=SC2034 # DRY is read by hook_timeouts_apply (install.sh)
    DRY=0
    STAGE=$(mktemp -d "${TMPDIR:-/tmp}/proofline-scale.XXXXXX"); hook_timeouts_apply "$ta_r"; rm -rf "$STAGE"
  done
}
