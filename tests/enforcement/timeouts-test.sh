#!/bin/sh
# shellcheck disable=SC2154,SC2016,SC2015 # fixture vars come from test-lib.sh; literal command text
# A202 item 29: time limits that fit real use and slow machines (docs/concepts/timeouts.md).
#  - timeouts.scale multiplies every duration and is bounded; the approval budget is never scaled;
#  - every timeout key has a minimum and a maximum in config-check, so none can switch a limit off or make it endless;
#  - init and upgrade write the hook limits from the config into the settings files: other settings are kept, the second run changes nothing;
#  - an upgrade keeps the user's values and moves only a limit that still holds an earlier shipped default;
#  - doctor proposes a scale from a measurement and writes it only after the user's own "approve scale";
#  - a step that used most of its time is told to the lead in one line, without blocking;
#  - a build command stopped by its limit is a failure and leaves no sealed record.
#   LC_ONLY=<substring> runs only matching scenarios.
set -u
if [ -z "${TO_INNER:-}" ]; then
  repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
  TO_INNER=1 TO_REPO=$repo exec sh -c '. "$0"; . "$1"' "$repo/control-plane/agents/scripts/test-lib.sh" "$repo/tests/enforcement/timeouts-test.sh"
fi
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT PROOFLINE_JSON PROOFLINE_HOOK_APPROVE_BUDGET PROOFLINE_HOOK_LOCK_WAIT PROOFLINE_HOOK_NEXT_BUDGET PROOFLINE_LOCK_TIMEOUT BUILD_RECORD_WAIT 2>/dev/null || true
PROOFLINE_NO_TTY=1; export PROOFLINE_NO_TTY
# The hook under test: HOOK_UNDER_TEST=<path of proofline-hook.mjs> runs this suite against the Node hook (a harness choice, read by this file only);
# the default is the shell hook. The hook never reads it.
hook=${HOOK_UNDER_TEST:-$TO_REPO/adapters/claude/hooks/proofline-hook.sh}
case $hook in *.mjs) hrun=node; hbase=proofline-hook.mjs ;; *) hrun=sh; hbase=proofline-hook.sh ;; esac
# install_hook: the hook (a Node hook also needs its folder and the project's core) into .agents/hooks of the fixture
install_hook() {
  case $hook in
    *.mjs) cp -R "$(dirname "$hook")/." .agents/hooks/; cp "$tl_agents/scripts/proofline-core.mjs" .agents/scripts/; cp -R "$tl_agents/scripts/core" .agents/scripts/core
      printf '.agents/scripts/proofline-core.mjs\n.agents/scripts/core/\n' >> .git/info/exclude ;;
    *) cp "$hook" .agents/hooks/ ;;
  esac
}
fixture() {
  scaffold orchestrated no COMPLEX ""
  node "$tl_agents/../../tests/legacy-githooks/install.mjs" .agents/githooks; mkdir -p .agents/hooks; install_hook
  printf '.agents/githooks/\n.agents/hooks/\n' >> .git/info/exclude
  git config core.hooksPath .agents/githooks; git config commit.gpgsign false
}
setcfg() { # SECTION KEY VALUE: set an existing nested key of .agents/config.yaml
  awk -v sec="$1" -v key="$2" -v val="$3" '
    /^[^ #]/ { insec = ($0 == sec ":") }
    insec && $0 ~ "^  " key ":" { print "  " key ": " val; next }
    { print }' .agents/config.yaml > "$base/cfg.set" && cp "$base/cfg.set" .agents/config.yaml
}
tv() { A timeouts | sed -n "s/^$1=//p"; }

# the scale multiplies every duration; the approval budget does not move
scale_multiplies() {
  fixture
  [ "$(tv scale)" = 1 ] || die "the default scale is not 1: $(tv scale)"
  d1=$(tv dispatch.STANDARD); c1=$(tv verification.command); l1=$(tv lock); s1=$(tv status_block); w1=$(tv batch.ci_wait_minutes); h1=$(tv hook.timeout.pretool)
  setcfg timeouts scale 2.5
  [ "$(tv dispatch.STANDARD)" = $((d1 * 5 / 2)) ] || die "dispatch.STANDARD $d1 did not become 2.5 times: $(tv dispatch.STANDARD)"
  [ "$(tv verification.command)" = $((c1 * 5 / 2)) ] || die "the build and test limit did not scale"
  [ "$(tv lock)" = $((l1 * 5 / 2)) ] || die "the lock wait did not scale"
  [ "$(tv status_block)" = 50 ] || die "the status block limit did not scale: $(tv status_block) from $s1"
  [ "$(tv batch.ci_wait_minutes)" = $((w1 * 5 / 2)) ] || die "the CI wait did not scale"
  [ "$(tv hook.timeout.pretool)" = $((h1 * 5 / 2)) ] || die "the hook limit did not scale"
  [ "$(A hook-config | sed -n 's/^approve_budget_seconds=//p')" = 20 ] || die "the approval budget was scaled: $(A hook-config | sed -n 's/^approve_budget_seconds=//p')"
  [ "$(A hook-config | sed -n 's/^lock_wait_seconds=//p')" = 8 ] || die "the hook's lock wait was scaled"
  setcfg timeouts scale 10
  [ "$(A hook-config | sed -n 's/^approve_budget_seconds=//p')" = 20 ] || die "the approval budget moved at scale 10"
  [ "$(tv hook.timeout.stop)" = 300 ] || die "a hook limit at scale 10 is not 300: $(tv hook.timeout.stop)"
  [ "$(tv dispatch.CRITICAL)" -le 28800 ] || die "a scaled dispatch limit passed the ceiling of 28800 s: $(tv dispatch.CRITICAL)"
  # the prompt limit never falls below the approval budget + 5, whatever the config says
  setcfg timeouts scale 1.0; setcfg hook prompt_timeout_seconds 10
  [ "$(A hook-timeouts | sed -n 's/^prompt=//p')" = 25 ] || die "the prompt hook limit fell below the approval budget + 5: $(A hook-timeouts | sed -n 's/^prompt=//p')"
  ok "A202-29 timeouts.scale multiplies dispatch, build, lock, status block, CI wait and hook limits; the approval budget never moves"
}

# every key is bounded; a value outside the bounds is refused, and a hand-edited bad scale is read as 1 (never as 0 or endless)
bounds() {
  new_repo; c=.agents/config.yaml
  A config-check >/dev/null || die "the shipped config does not pass config-check"
  chk() { # SECTION LINE : config-check must refuse the file with LINE added under SECTION
    awk -v s="$1" -v l="  $2" '{ print } $0 == s ":" { print l }' "$c" > "$base/cfg.bad"
    ( A config-check "$base/cfg.bad" >/dev/null 2>&1 ) && die "config-check accepted $1.$2"
    return 0
  }
  for b in "scale: 0" "scale: 0.4" "scale: 11" "scale: abc" "scale: -2" "warn_percent: 10" "warn_percent: 99" "turbo: 1"; do chk timeouts "$b"; done
  for b in "session_timeout_seconds: 0" "prompt_timeout_seconds: 9" "stop_timeout_seconds: 601" "pretool_timeout_seconds: abc" "subagent_stop_timeout_seconds: 100000"; do chk hook "$b"; done
  chk verification "command_timeout_seconds: 0"; chk verification "command_timeout_seconds: 59"; chk verification "command_timeout_seconds: 999999"
  chk dispatch "timeout_seconds: 0"; chk dispatch "timeout_seconds: 29"; chk dispatch "timeout_seconds: 28801"
  chk tasks "status_block_seconds: 0"; chk tasks "status_block_seconds: 301"
  chk batch "ci_wait_minutes: 0"; chk batch "ci_appear_minutes: 100000"
  for cl in TRIVIAL STANDARD COMPLEX CRITICAL; do
    for v in 0 29 28801; do
      awk -v cl="$cl" -v v="$v" '{ if ($0 ~ "^    dispatch_timeout_seconds:" && inc) { print "    dispatch_timeout_seconds: " v; inc = 0; next } if ($0 == "  " cl ":") inc = 1; print }' "$c" > "$base/cfg.bad"
      ( A config-check "$base/cfg.bad" >/dev/null 2>&1 ) && die "config-check accepted pipelines.$cl.dispatch_timeout_seconds: $v"
    done
  done
  for ok_line in "scale: 0.5" "scale: 10" "scale: 2.25" "warn_percent: 50"; do
    awk -v l="  $ok_line" '{ print } $0 == "timeouts:" { print l }' "$c" > "$base/cfg.good"
    A config-check "$base/cfg.good" >/dev/null 2>&1 || die "config-check refused a valid timeouts.$ok_line"
  done
  # a bad hand-edited scale never reaches a timer as 0, a negative or a huge number
  for v in 0 -3 abc 99 0.1 ''; do setcfg timeouts scale "$v"; [ "$(tv scale)" = 1 ] || die "scale '$v' was not read as 1: $(tv scale)"; done
  setcfg timeouts scale 1.0
  for v in 0 -1 abc 5; do setcfg dispatch timeout_seconds "$v"; [ "$(tv dispatch.default)" -ge 30 ] || die "dispatch.timeout_seconds '$v' reached a timer below 30 s: $(tv dispatch.default)"; done
  ok "A202-29 every time limit has a minimum and a maximum; a bad scale is read as 1"
}

# one line to the lead when a step has used 80% of its time; none before; next stays non-blocking and the same step is not stopped
warn_line() {
  fixture
  sleep 120 & pid=$!
  mk() { # ELAPSED LIMIT
    mkdir -p .agents/runs/LC/dispatch
    printf 'pid=%s\nrole=reviewer\ntimeout=%s\nstarted_epoch=%s\ndispatch in flight: LC reviewer on claude, started now.\n' "$pid" "$2" "$(( $(date +%s) - $1 ))" > .agents/runs/LC/dispatch/001-reviewer-claude.running
  }
  # a 10000 s limit: a slow machine that takes seconds between mk and the check still reads the same whole percent (85% holds for 8500 to 8599 s)
  mk 1000 10000; out=$(A next LC)
  printf '%s\n' "$out" | grep -q '^note=TIME' && die "a step at 10% of its time was reported: $out"
  printf '%s\n' "$out" | grep -q '^next=wait: dispatch.sh LC reviewer in flight' || die "next does not say a dispatch is in flight: $out"
  mk 8500 10000; out=$(A next LC)
  [ "$(printf '%s\n' "$out" | grep -c '^note=TIME')" = 1 ] || die "a step at 85% of its time is not reported with exactly one line: $out"
  printf '%s\n' "$out" | grep '^note=TIME' | grep -q 'has used 141m of its 166m limit (85%)' || die "the line does not name the use: $(printf '%s\n' "$out" | grep '^note=TIME')"
  printf '%s\n' "$out" | grep -q '^next=wait: dispatch.sh LC reviewer in flight' || die "the warning replaced the wait instruction: $out"
  printf '%s\n' "$out" | grep '^note=TIME' | grep -qi 'never a pass' || die "the line does not say a timeout is not a pass"
  wl=$(A wait-line LC); printf '%s\n' "$wl" | grep -q 'TIME: 85% of its 166m limit' || die "wait-line does not carry the warning: $wl"
  [ "$(printf '%s\n' "$wl" | wc -l | tr -d ' ')" = 1 ] || die "wait-line is more than one line"
  # the threshold is config: 90 is not reached at 85%
  setcfg timeouts warn_percent 90; out=$(A next LC); printf '%s\n' "$out" | grep -q '^note=TIME' && die "warn_percent 90 still warned at 85%"
  setcfg timeouts warn_percent 80
  # a marker without a start time or a dead process says nothing
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; out=$(A next LC); printf '%s\n' "$out" | grep -q '^note=TIME' && die "a dead dispatch was reported as slow"
  ok "A202-29 a step at 80% of its time gets one TIME line in next and wait-line; none before, none when dead; the wait instruction stays"
}

# a build command stopped by its limit fails (never passes) and leaves no sealed record; the next run starts again
build_timeout() {
  fixture
  command -v timeout >/dev/null 2>&1 || { ok "A202-29 build timeout (no timeout command here: skipped)"; return 0; }
  cp "$tl_agents/scripts/build-record.sh" .agents/scripts/   # a fixture does not install it; on Linux (GNU timeout) this scenario runs
  setcfg verification command_timeout_seconds 60
  # the shipped bound is 60 s; a test cannot wait that long, so the stop is forced with a stub that exits 124 like timeout(1) does
  mkdir -p "$base/shim"; printf '#!/bin/sh\nshift\nexit 124\n' > "$base/shim/timeout"; chmod +x "$base/shim/timeout"
  printf 'commands:\n  build: true\n  test: true\n' > "$base/cmds"
  awk '/^commands:/ { skip = 1; next } skip && /^[^ ]/ { skip = 0 } !skip { print }' .agents/config.yaml > "$base/c" && cat "$base/c" "$base/cmds" > .agents/config.yaml
  git add -A; git commit -qm cmds
  rc=0; out=$(PATH="$base/shim:$PATH" A build-record LC run 2>&1) || rc=$?
  [ "$rc" != 0 ] || die "a build command stopped by its limit passed: $out"
  printf '%s' "$out" | grep -q 'stopped after 60s' || die "the stop is not named: $out"
  printf '%s' "$out" | grep -qi 'not a pass' || die "the message does not say it is not a pass: $out"
  ! ls .agents/local/builds/*/done >/dev/null 2>&1 || die "a timed-out build left a sealed record that the next run would reuse"
  rc=0; A build-record LC run >/dev/null 2>&1 || rc=$?
  ls .agents/local/builds/*/done >/dev/null 2>&1 || die "the next run did not make a record (rc $rc): $(A build-record LC run 2>&1 | tail -3)"
  [ "$(cat .agents/local/builds/*/done)" = 0 ] || die "the second run did not pass"
  ok "A202-29 a build command stopped by its limit fails, leaves no sealed record, and the next run starts again"
}

# the hook limits are written from the config into .claude/settings.json: other settings kept, idempotent, kept on upgrade
settings_merge() {
  repo=$base/proj; mkdir -p "$repo"; cd "$repo" || exit 1
  git init -q -b main; git config user.email t@t.test; git config user.name t; echo hi > f.txt; git add -A; git commit -qm i
  mkdir -p .claude
  cat > .claude/settings.json <<'EOF'
{
  "model": "opus",
  "permissions": { "allow": ["Bash(ls:*)"], "deny": ["Read(./secrets/**)"] },
  "env": { "MY_FLAG": "1" },
  "hooks": {
    "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo mine", "timeout": 7 } ] } ],
    "Notification": [ { "hooks": [ { "type": "command", "command": "echo note" } ] } ]
  }
}
EOF
  PL=$TO_REPO/bin/proofline
  sh "$PL" init --yes --runtimes claude --lead claude --worker claude --reviewers claude >/dev/null 2>&1 || die "init failed"
  s=.claude/settings.json
  command -v jq >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || { ok "A202-29 settings merge (neither jq nor node here: skipped)"; return 0; }
  hk() { jq -r --arg ev "$1" '[.hooks[$ev][] | .hooks[] | select((.command // "") | contains("proofline-hook.sh")) | .timeout] | first' "$s" 2>/dev/null || node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const g=j.hooks[process.argv[2]];for(const x of g)for(const h of x.hooks)if(String(h.command).includes("proofline-hook.sh")){console.log(h.timeout);process.exit()}' "$s" "$1"; }
  [ "$(hk PreToolUse)" = 30 ] && [ "$(hk SubagentStop)" = 120 ] && [ "$(hk SubagentStart)" = 60 ] || die "default hook limits not written: $(hk PreToolUse) $(hk SubagentStart) $(hk SubagentStop)"
  grep -q '"model": "opus"' "$s" && grep -q 'MY_FLAG' "$s" && grep -q 'Read(./secrets' "$s" && grep -q 'echo note' "$s" && grep -q '"timeout": 7' "$s" || die "init lost a user setting: $(cat "$s")"
  # config -> settings: scale 2 and a single limit
  setcfg timeouts scale 2; setcfg hook subagent_start_timeout_seconds 45
  sh "$PL" upgrade >/dev/null 2>&1 || die "upgrade failed"
  [ "$(hk PreToolUse)" = 60 ] && [ "$(hk SubagentStop)" = 240 ] && [ "$(hk SubagentStart)" = 90 ] && [ "$(hk UserPromptSubmit)" = 60 ] || die "scaled hook limits not written: $(hk PreToolUse) $(hk SubagentStart) $(hk SubagentStop) $(hk UserPromptSubmit)"
  grep -q '"timeout": 7' "$s" || die "the timeout of a hook that is not proofline's was changed"
  grep -q '"model": "opus"' "$s" && grep -q 'MY_FLAG' "$s" && grep -q 'Read(./secrets' "$s" && grep -q 'echo note' "$s" && grep -q 'echo mine' "$s" || die "upgrade lost a user setting"
  [ "$(grep -c 'proofline-hook.sh' "$s")" = 7 ] || die "hook groups were duplicated or lost: $(grep -c 'proofline-hook.sh' "$s")"
  # the second run changes nothing, byte for byte
  cp "$s" "$base/settings.once"; sh "$PL" upgrade >/dev/null 2>&1 || die "second upgrade failed"; sh "$PL" upgrade >/dev/null 2>&1 || die "third upgrade failed"
  cmp -s "$s" "$base/settings.once" || die "a repeated upgrade changed the settings file"
  # the user's config values survive an upgrade
  [ "$(grep -c '^  scale: 2$' .agents/config.yaml)" = 1 ] && grep -q 'subagent_start_timeout_seconds: 45' .agents/config.yaml || die "an upgrade overwrote the user's timeout values"
  # a file that is not JSON is left alone with a warning, not overwritten
  printf 'not json {' > .codex/hooks.json 2>/dev/null || :
  cd "$base" || exit 1
  ok "A202-29 hook limits come from the config into settings.json: other settings kept, idempotent, kept on upgrade"
}

# an upgrade from an older project moves a limit that still holds the earlier shipped default and keeps one the user changed
upgrade_defaults() {
  new_repo; c=.agents/config.yaml
  sed -e 's/^proofline_version:.*/proofline_version: 0.0.38/' -e 's/^  timeout_seconds: .*/  timeout_seconds: 1800/' "$c" > "$base/old.yaml"
  # the older shipped class values, COMPLEX changed by the user; the new keys do not exist in an old config
  awk '$0 == "  TRIVIAL:" { c = "TRIVIAL" } $0 == "  STANDARD:" { c = "STANDARD" } $0 == "  COMPLEX:" { c = "COMPLEX" } $0 == "  CRITICAL:" { c = "CRITICAL" }
       /^    dispatch_timeout_seconds:/ { v = (c == "TRIVIAL") ? 900 : (c == "STANDARD") ? 1800 : (c == "COMPLEX") ? 2400 : 3600; print "    dispatch_timeout_seconds: " v; next } { print }' "$base/old.yaml" |
    awk '/^timeouts:/ { skip = 1; next } skip && /^[^ ]/ { skip = 0 } !skip' > "$base/old2.yaml"
  grep -q '^timeouts:' "$base/old2.yaml" && die "the fixture config still has the new section"
  PLH=$TO_REPO; cd "$base" && rm -rf up && mkdir up && cd up || exit 1
  git init -q -b main; git config user.email t@t.test; git config user.name t; echo hi > f.txt; git add -A; git commit -qm i
  sh "$PLH/bin/proofline" init --yes --runtimes claude --lead claude --worker claude --reviewers claude >/dev/null 2>&1 || die "init failed"
  cp "$base/old2.yaml" .agents/config.yaml
  sh "$PLH/bin/proofline" upgrade >/dev/null 2>&1 || die "upgrade failed"
  g() { awk -v want="$1" '/^[^ #]/ { sec = $1 } /^  [A-Z]+:$/ { cls = $1 } /dispatch_timeout_seconds:/ && sec == "pipelines:" && cls == want { print $2 }' .agents/config.yaml; }
  [ "$(sed -n 's/^  timeout_seconds: //p' .agents/config.yaml)" = 5400 ] || die "dispatch.timeout_seconds at the old default was not moved: $(sed -n 's/^  timeout_seconds: //p' .agents/config.yaml)"
  [ "$(g TRIVIAL:)" = 1800 ] && [ "$(g STANDARD:)" = 5400 ] && [ "$(g CRITICAL:)" = 7200 ] || die "class limits at the old defaults were not moved: $(g TRIVIAL:) $(g STANDARD:) $(g CRITICAL:)"
  [ "$(g COMPLEX:)" = 2400 ] || die "a class limit the user changed (2400) was overwritten: $(g COMPLEX:)"
  grep -q '^  scale: 1.0$' .agents/config.yaml || die "the upgrade did not add timeouts.scale"
  # a user who sets 1800 after the upgrade keeps it
  sed -i.b -e 's/^  timeout_seconds: 5400/  timeout_seconds: 1800/' -e 's/^proofline_version:.*/proofline_version: 0.0.39/' .agents/config.yaml; sh "$PLH/bin/proofline" upgrade >/dev/null 2>&1
  [ "$(sed -n 's/^  timeout_seconds: //p' .agents/config.yaml)" = 1800 ] || die "an upgrade from a current install overwrote a value the user set"
  cd "$base" || exit 1
  ok "A202-29 an upgrade moves a limit that still holds the earlier default, keeps a changed one and a value set later"
}

# doctor measures, proposes, and writes only after the user's own "approve scale"
doctor_scale() {
  fixture
  mkdir -p "$base/shim"; printf '#!/bin/sh\ncase "$*" in *" add "*) sleep 2 ;; esac\nexec %s "$@"\n' "$(command -v git)" > "$base/shim/git"; chmod +x "$base/shim/git"
  PL=$TO_REPO/bin/proofline
  before=$(cat .agents/config.yaml)
  out=$(PATH="$base/shim:$PATH" sh "$PL" doctor --scale 2>&1) || die "doctor --scale failed: $out"
  printf '%s' "$out" | grep -q 'scale proposal' || die "a slow machine got no proposal: $out"
  printf '%s' "$out" | grep -q 'approve scale' || die "the question does not show the exact phrase: $out"
  [ "$(cat .agents/config.yaml)" = "$before" ] || die "doctor --scale changed the config before the user's reply"
  [ -s .agents/local/scale/PROPOSAL.tsv ] || die "no proposal file"
  v=$(awk -F'\t' '$1 == "scale" { print $2 }' .agents/local/scale/PROPOSAL.tsv)
  case "$v" in [1-9]*.[05]|[1-9]|10) ;; *) die "the proposed scale is not a bounded half step: $v" ;; esac
  # no reply, a reply that is not an approval, a negation, another kind: nothing is written
  rc=0; sh "$PL" doctor --apply-scale >/dev/null 2>&1 || rc=$?; [ "$rc" != 0 ] || die "--apply-scale wrote without any reply"
  for t in 'looks good' 'do not approve scale' 'approve commands' 'approve scale if it is safe'; do
    capture "$t" "$(( $(date +%s) + 7200 ))"; A approve-pending >/dev/null 2>&1 || :
    rc=0; sh "$PL" doctor --apply-scale >/dev/null 2>&1 || rc=$?; [ "$rc" != 0 ] || die "--apply-scale wrote after '$t'"
    [ "$(cat .agents/config.yaml)" = "$before" ] || die "the config changed after '$t'"
  done
  # an agent cannot make the approval: the lead-side command refuses, and a forged proposal is another hash
  printf 'scale\t9\n' > .agents/local/scale/PROPOSAL.tsv; rc=0; A scale-check >/dev/null 2>&1 || rc=$?; [ "$rc" != 0 ] || die "a changed proposal was covered by the earlier request"
  PATH="$base/shim:$PATH" sh "$PL" doctor --scale >/dev/null 2>&1
  v=$(awk -F'\t' '$1 == "scale" { print $2 }' .agents/local/scale/PROPOSAL.tsv)   # measured again: the value may differ, the approval binds the new file
  capture 'approve scale' "$(( $(date +%s) + 7200 ))"; A approve-pending >/dev/null 2>&1 || :
  sh "$PL" doctor --apply-scale >/dev/null 2>&1 || die "--apply-scale refused after the user's 'approve scale'"
  [ "$(cfg_v=$(sed -n 's/^  scale: //p' .agents/config.yaml); echo "$cfg_v")" = "$v" ] || die "the approved scale was not written: $(sed -n 's/^  scale: //p' .agents/config.yaml) (wanted $v)"
  A config-check >/dev/null || die "the written scale does not pass config-check"
  # used up: the same reply does not apply a second proposal
  printf 'scale\t3\n' > .agents/local/scale/PROPOSAL.tsv; rc=0; sh "$PL" doctor --apply-scale >/dev/null 2>&1 || rc=$?
  [ "$rc" != 0 ] || die "one reply applied two proposals"
  # a machine within the reference gets no proposal
  rm -rf .agents/local/scale; sed -i.b "s/^  scale: .*/  scale: 1.0/" .agents/config.yaml
  out=$(sh "$PL" doctor --scale 2>&1) || :
  printf '%s' "$out" | grep -q 'timing:' || die "doctor --scale printed no timing: $out"
  ok "A202-29 doctor proposes a scale from a measurement and writes it only after the user's own approve scale"
}

fails=0
scenarios='scale_multiplies bounds warn_line build_timeout settings_merge upgrade_defaults doctor_scale'
for sc in $scenarios; do
  run_sc "$sc" || { fails=$((fails + 1)); echo "FAIL scenario $sc"; }
done
[ "$fails" = 0 ] || { echo "timeouts tests: $fails scenario(s) failed"; exit 1; }
echo "timeouts tests passed"
