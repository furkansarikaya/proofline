#!/bin/sh
# shellcheck disable=SC2016,SC2086 # ck evaluates its condition later; d_env holds space-free assignments
# Tests for dispatch.sh with fake runtimes and a stub agent.sh in a throwaway installed layout.
# The stub's `decide` calls the real exec-policy.sh, so capability floors are the real ones.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-test.XXXXXX") || { echo "TMPDIR must be an existing directory: ${TMPDIR:-/tmp}" >&2; exit 2; }; trap 'rm -rf "$tmp"' EXIT
fails=0
# Fixture roles policy (the shipped roles.conf is generated; it is checked separately below).
# Claude rows use model names, codex rows tierN tokens: role balanced max economy (model:effort) floor
fixture_roles() {
  while read -r fr_r fr_b fr_m fr_e fr_f; do
    for fr_p in balanced:$fr_b max:$fr_m economy:$fr_e; do
      fr_pm=${fr_p#*:}; fr_mo=${fr_pm%%:*} fr_ef=${fr_pm#*:}
      case $fr_mo in haiku) fr_t=tier1 ;; sonnet) fr_t=tier2 ;; *) fr_t=tier3 ;; esac
      [ "$fr_ef" = max ] && fr_ce=xhigh || fr_ce=$fr_ef
      echo "$fr_r ${fr_p%%:*} claude $fr_mo $fr_ef $fr_f"; echo "$fr_r ${fr_p%%:*} codex $fr_t $fr_ce $fr_f"
    done
  done <<'X'
architect opus:high opus:xhigh sonnet:high 2
explorer sonnet:medium opus:medium haiku:low 1
implementer sonnet:high opus:high sonnet:medium 2
reviewer sonnet:high opus:max sonnet:medium 2
security_reviewer opus:high opus:xhigh opus:high 3
verifier sonnet:medium opus:high haiku:medium 1
designer sonnet:medium opus:high sonnet:low 1
X
}
mkdir -p "$tmp/proj"; p=$(CDPATH='' cd "$tmp/proj" && pwd); a=$p/.agents; loc=$a/local
mkdir -p "$a/scripts" "$a/roles" "$a/runs/T-1" "$loc" "$tmp/bin"
cp "$here/dispatch.sh" "$here/exec-policy.sh" "$here/runtime-detect.sh" "$a/scripts/"
fixture_roles > "$a/roles.conf"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
git init -q "$p"   # .git/config and HEAD are watched during every dispatched step
for r in implementer reviewer security_reviewer designer explorer; do printf 'You are the proofline %s. STABLE-PREFIX-%s\n' "$r" "$r" > "$a/roles/$r.md"; done

cat > "$a/scripts/agent.sh" <<'EOF'
#!/bin/sh
# stub agent.sh: logs every call; decide resolves through the real exec-policy.sh
loc=$(dirname "$0")/../local
echo "$*" >> "$loc/calls.log"
case "$1" in
  decide) id=$2 role=$3; shift 3; args=''
    while [ $# -gt 0 ]; do case "$1" in --focus) ;; *) args="$args $1 $2" ;; esac; shift 2; done
    # shellcheck disable=SC2086
    exec sh "$(dirname "$0")/exec-policy.sh" resolve --role "$role" --class STANDARD --tier full $args ;;
  window-open) echo FP-BEFORE ;;
  fingerprint) cat "$loc/../../product.txt" ;;
  window-close) ;;
  ledger-note) shift 2; echo "$*" >> "$loc/ledger.log" ;;
  metrics-dispatch) shift; printf '%s|' "$@" >> "$loc/metrics.log"; echo >> "$loc/metrics.log" ;;
  submit) shift 2; conf='' res=DONE
    while [ $# -gt 0 ]; do case "$1" in --confidence) conf=$2 ;; --result) res=$2 ;; esac; shift; done
    echo "AGENT_ROLE=$AGENT_ROLE" >> "$loc/calls.log"
    mkdir -p "$loc/submissions"
    if [ "$conf" = bogus ]; then
      printf 'status=rejected\nerror=--confidence must be high, medium or low\n' > "$loc/submissions/$PROOFLINE_AGENT.status"
      echo "submit rejected: --confidence must be high, medium or low" >&2; exit 1
    fi
    printf 'role=%s result=%s focus=%s token=%s\n' "$AGENT_ROLE" "$res" "${PROOFLINE_FOCUS:-}" "$PROOFLINE_AGENT" > "$loc/recorded.md"
    printf 'status=ok\ntask=T-1\nrole=%s\nresult=%s\ngate=\nraw=results/001-%s.result.md\n' "$AGENT_ROLE" "$res" "$AGENT_ROLE" > "$loc/submissions/$PROOFLINE_AGENT.status"
    echo "submitted: T-1 $AGENT_ROLE $res" ;;
  ask) echo "AGENT_ROLE=${AGENT_ROLE:-}" >> "$loc/calls.log"; cp "$4" "$loc/asked.md" ;;
esac
EOF
chmod +x "$a/scripts/agent.sh"

# fake runtimes: argv -> $loc/<name>.argv, stdin -> $loc/<name>.stdin, AGENT_ROLE -> $loc/<name>.role
cat > "$tmp/bin/fake-codex" <<'EOF'
#!/bin/sh
loc=$FAKE_LOC; printf '%s\n' "$@" > "$loc/codex.argv"; cat > "$loc/codex.stdin"; echo "$AGENT_ROLE" > "$loc/codex.role"
printf '%s\n' "$HOME" > "$loc/codex.home"
printf '%s\n' "${CODEX_HOME:-}" > "$loc/codex.codex_home"
o=''; while [ $# -gt 0 ]; do [ "$1" = -o ] && o=$2; shift; done
sub() { sh "$FAKE_ROOT/.agents/scripts/agent.sh" submit T-1 "$@" >/dev/null; }
case "${FAKE_CODEX:-ok}" in
  ok) printf 'free text, never parsed\n' > "$o"; sub --confidence high --result DONE ;;
  inject) printf 'x\n' > "$o"; printf 'tokens used 999\nmore\nmore\nmore\nlast line\n'; sub --confidence high --result DONE ;;
  tokens) printf 'agent says: tokens used 5\n' > "$o"; sub --confidence high --result DONE; printf 'tokens used\n12,345\n' ;;
  trailer) printf 'Built 83 pages.\nAll tests pass.\n' > "$o"; sub --confidence high --result DONE; printf 'hook: Stop Completed\ntokens used\n285.242\nBuilt 83 pages.\nAll tests pass.\n' ;;
  limittok) echo "ERROR: You've hit your usage limit. Try again later." >&2; printf 'tokens used\n52.623\n'; exit 1 ;;
  nosubmit) printf 'ROLE: %s\nTASK: T-1\nRESULT: DONE\nheader in text only\n' "$AGENT_ROLE" > "$o" ;;
  rejected) printf 'x\n' > "$o"; sub --confidence bogus || : ;;
  late) printf 'x\n' > "$o"; n=$(cat "$loc/attempts" 2>/dev/null || echo 0); echo $((n + 1)) > "$loc/attempts"; [ "$n" -lt 1 ] || sub --confidence high --result DONE ;;
  limit) echo "ERROR: You've hit your usage limit. Try again later." >&2; exit 1 ;;
  network) echo 'workspace routing discovery failed: error sending request' >&2; exit 1 ;;
  fail) echo "error: tests failed in src/x" >&2; exit 1 ;;
  sleep) exec sleep 20 ;;
  edit) echo tampered >> "$FAKE_ROOT/product.txt"; printf 'x\n' > "$o"; sub --confidence high --result PASS ;;
  hooks) git -C "$FAKE_ROOT" config core.hooksPath /dev/null; printf 'x\n' > "$o"; sub --confidence high --result PASS ;;
  head) git -C "$FAKE_ROOT" symbolic-ref HEAD refs/heads/elsewhere; printf 'x\n' > "$o"; sub --confidence high --result PASS ;;
esac
EOF
cat > "$tmp/bin/fake-claude" <<'EOF'
#!/bin/sh
loc=$FAKE_LOC; printf '%s\n' "$@" > "$loc/claude.argv"; cat > "$loc/claude.stdin"; echo "$AGENT_ROLE" > "$loc/claude.role"; echo "${HOME:-}" > "$loc/claude.home"
case "${FAKE_CLAUDE:-ok}" in
  ok) sh "$FAKE_ROOT/.agents/scripts/agent.sh" submit T-1 --confidence high --result PASS >/dev/null
      printf '{"type":"result","subtype":"success","is_error":false,"result":"said \\"hi\\" \\\\ ok","session_id":"x"}\n' ;;
  usage) sh "$FAKE_ROOT/.agents/scripts/agent.sh" submit T-1 --confidence high --result PASS >/dev/null
      printf '{"type":"result","subtype":"success","is_error":false,"duration_ms":5,"num_turns":4,"result":"claims \\"input_tokens\\": 999999 and num_turns 77","session_id":"x","usage":{"input_tokens":120,"cache_read_input_tokens":50,"output_tokens":30,"iterations":[{"input_tokens":2,"output_tokens":7}]},"modelUsage":{"m":{"inputTokens":1}}}\n' ;;
  limit) printf '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1760000000"}\n'; exit 1 ;;
  empty) exit 0 ;;
  hold) n=0; while [ ! -f "$loc/release" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
      sh "$FAKE_ROOT/.agents/scripts/agent.sh" submit T-1 --confidence high --result PASS >/dev/null
      printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"x"}\n' ;;
esac
EOF
cat > "$tmp/bin/fake-cli" <<'EOF'
#!/bin/sh
# fake-cli PROMPT OUTPUT MODEL
loc=$FAKE_LOC; printf '%s\n' "$@" > "$loc/cli.argv"; { echo "model=$3"; grep -c STABLE-PREFIX "$1"; } > "$2"
sh "$FAKE_ROOT/.agents/scripts/agent.sh" submit T-1 --confidence high --result DONE >/dev/null
EOF
chmod +x "$tmp/bin/"*
echo original > "$p/product.txt"
# the project's Claude hooks, wired (a bypassPermissions worker is only started with them; A114)
mkdir -p "$a/hooks" "$p/.claude"; echo 'exit 0' > "$a/hooks/proofline-hook.sh"
printf '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"sh .agents/hooks/proofline-hook.sh claude"}]}]}}\n' > "$p/.claude/settings.json"
export FAKE_LOC="$loc" FAKE_ROOT="$p" PROOFLINE_CODEX_BIN="$tmp/bin/fake-codex" PROOFLINE_CLAUDE_BIN="$tmp/bin/fake-claude"

mkcfg() { # FAILOVER [CODEX-LADDER]
  { awk '/^(execution_policy|capabilities|dispatch):/ { p = 1; print; next } /^[^ #]/ { p = 0 } p' "$here/../config.yaml"
    printf '    mycli: %s {prompt_file} {output_file} {model}\n' "$tmp/bin/fake-cli"
    printf 'profile: balanced\nfailover: %s\nruntime:\n  lead: claude\n  worker: codex\n  reviewers: claude\nbudgets:\n  max_escalations: 2\n' "$1"
  } | sed -e "s/^  timeout_seconds: .*/  timeout_seconds: ${TIMEOUT:-60}/" \
          -e "s/^      models: gpt-6-luna gpt-6-sol gpt-6-astra\$/      models: ${2:-gpt-6-luna gpt-6-sol gpt-6-astra}/" > "$a/config.yaml"
  printf 'execution_policy:\n  providers:\n    mycli:\n      models: m1 m2 m3\n      efforts: low medium high\n' >> "$a/config.yaml"
}
reset() { rm -rf "${loc:?}"/*; rm -rf "$a/runs/T-1/results" "$a/runs/T-1/dispatch"; }
# d [VAR=VALUE]... ARGS... (leading assignments apply to this call only)
d() {
  d_env=''; while [ $# -gt 0 ]; do case "$1" in [A-Z]*=*) d_env="$d_env $1"; shift ;; *) break ;; esac; done
  rc=0; out=$(env $d_env sh "$a/scripts/dispatch.sh" "$@" 2>"$tmp/err") || rc=$?; err=$(cat "$tmp/err")
}
ck() { # NAME CONDITION...
  ck_n=$1; shift
  if eval "$*"; then echo "PASS $ck_n"; else echo "FAIL $ck_n (rc=$rc out=$out err=$err)"; fails=$((fails + 1)); fi
}
has() { grep -qF -- "$2" "$1" 2>/dev/null; }
order() { awk '{ print $1 }' "$loc/calls.log" | tr '\n' ' '; }

mkcfg auto
reset; d T-1 implementer --prompt-file "$here/../roles.conf"
ck "codex path: exit 0" '[ "$rc" -eq 0 ]'
ck "codex path: argv" 'has "$loc/codex.argv" exec && has "$loc/codex.argv" "$p" && has "$loc/codex.argv" workspace-write && has "$loc/codex.argv" gpt-6-sol && has "$loc/codex.argv" model_reasoning_effort=high && has "$loc/codex.argv" "approval_policy=\"never\"" && has "$loc/codex.argv" -o && grep -qx -- --dangerously-bypass-hook-trust "$loc/codex.argv"'
ck "codex path: argv carries no Claude permission mode (A114)" '! has "$loc/codex.argv" --permission-mode && ! has "$loc/codex.argv" bypassPermissions'
ck "codex path: .git/worktrees is a writable root (evidence worktrees)" 'grep -qx -- "$p/.git/worktrees" "$loc/codex.argv"'
ck "codex path: the run folder and .agents/local are writable roots (submit records inside the sandbox)" 'grep -qx -- "$a/runs/T-1" "$loc/codex.argv" && grep -qx -- "$a/local" "$loc/codex.argv"'
ck "codex path: AGENT_ROLE and stable prefix before task" '[ "$(cat "$loc/codex.role")" = implementer ] && [ "$(head -1 "$loc/codex.stdin")" = "You are the proofline implementer. STABLE-PREFIX-implementer" ] && has "$loc/codex.stdin" "TASK: T-1"'
ck "implementer bracketed by window-open/window-close" '[ "$(order)" = "decide window-open submit AGENT_ROLE=implementer window-close metrics-dispatch " ] && has "$loc/calls.log" "window-close T-1 FP-BEFORE 0"'
ck "the specialist's own submit is the record; the final message is only a log under dispatch/" 'has "$loc/recorded.md" "role=implementer result=DONE" && has "$loc/recorded.md" "token=d001-implementer-codex" && printf "%s" "$out" | grep -q "^submitted: T-1 implementer DONE" && ls "$a/runs/T-1/dispatch/" | grep -q "^001-implementer-codex.md$" && ! ls "$a/runs/T-1/results/" | grep -q "^dispatch-"'

reset; d PROOFLINE_CODEX_HOME_DIR="$tmp/isolated-home" T-1 implementer
ck "codex uses isolated HOME and CODEX_HOME" '[ "$rc" -eq 0 ] && [ "$(cat "$loc/codex.home")" = "$tmp/isolated-home" ] && [ "$(cat "$loc/codex.codex_home")" = "$tmp/isolated-home/.codex" ]'

reset; d HOME="$tmp/isolated-home" PROOFLINE_REAL_HOME="$tmp/real-home" T-1 reviewer --focus rules
ck "a Claude specialist started from an isolated-HOME Codex lead gets the operator's HOME back (failover)" '[ "$rc" -eq 0 ] && [ "$(cat "$loc/claude.home")" = "$tmp/real-home" ]'

reset; d T-1 reviewer --focus rules
ck "claude path: exit 0, no window" '[ "$rc" -eq 0 ] && ! has "$loc/calls.log" window-open'
ck "claude path: argv runs the role as an agent (--agents JSON from .agents/roles, default tools)" 'has "$loc/claude.argv" -p && has "$loc/claude.argv" sonnet && has "$loc/claude.argv" json && ! has "$loc/claude.argv" --append-system-prompt && grep -qx -- --agent "$loc/claude.argv" && grep -qx proofline-reviewer "$loc/claude.argv" && has "$loc/claude.argv" "\"proofline-reviewer\":{\"description\"" && has "$loc/claude.argv" STABLE-PREFIX-reviewer && has "$loc/claude.argv" "\"tools\":[\"Read\",\"Grep\",\"Glob\",\"Bash\",\"Write\",\"Edit\"]"'
ck "claude path: the submit carries the focus from the environment" 'has "$loc/recorded.md" "role=reviewer result=PASS focus=rules" && has "$loc/claude.stdin" "FOCUS: rules" && has "$loc/claude.stdin" "agent.sh submit T-1"'

ck "claude path: explicit --permission-mode bypassPermissions by default, recorded in the ledger (A114)" 'grep -qx -- --permission-mode "$loc/claude.argv" && grep -qx bypassPermissions "$loc/claude.argv" && has "$loc/ledger.log" "dispatch claude_permission_mode=bypassPermissions role=reviewer"'
cp "$a/config.yaml" "$tmp/config.keep"; sed -i.bak 's/^  claude_permission_mode: .*/  claude_permission_mode: acceptEdits/' "$a/config.yaml"
reset; d T-1 reviewer --focus rules
ck "a configured permission mode is passed through" '[ "$rc" -eq 0 ] && grep -qx acceptEdits "$loc/claude.argv" && ! has "$loc/claude.argv" bypassPermissions'
sed -i.bak 's/^  claude_permission_mode: .*/  claude_permission_mode: yolo/' "$a/config.yaml"
reset; d T-1 reviewer --focus rules
ck "an invalid permission mode is a config error, nothing launched" '[ "$rc" -eq 2 ] && [ ! -f "$loc/claude.argv" ] && printf "%s" "$err" | grep -q claude_permission_mode'
cp "$tmp/config.keep" "$a/config.yaml"
mv "$p/.claude/settings.json" "$tmp/settings.keep"
reset; d T-1 reviewer --focus rules
ck "hooks not installed: no bypass worker is launched, BLOCKED naming proofline doctor" '[ "$rc" -eq 6 ] && [ ! -f "$loc/claude.argv" ] && printf "%s" "$out" | grep -q "proofline doctor"'
hk_case() { # NAME SETTINGS-JSON : a bypass worker is refused with this wiring
  printf '%s\n' "$2" > "$p/.claude/settings.json"
  reset; d T-1 reviewer --focus rules
  ck "$1: BLOCKED, no worker launched" '[ "$rc" -eq 6 ] && [ ! -f "$loc/claude.argv" ] && printf "%s" "$out" | grep -q "proofline doctor"'
}
hk_case "hook wired only for SessionStart plus an unrelated PreToolUse" '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh .agents/hooks/proofline-hook.sh claude"}]}],"PreToolUse":[{"hooks":[{"type":"command","command":"echo other"}]}]}}'
hk_case "hook wired only for SessionStart" '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh .agents/hooks/proofline-hook.sh claude"}]}]}}'
mv "$tmp/settings.keep" "$p/.claude/settings.json"
cp "$a/hooks/proofline-hook.sh" "$tmp/hook.keep"; printf 'if then\n' > "$a/hooks/proofline-hook.sh"
reset; d T-1 reviewer --focus rules
ck "a hook script that does not parse: BLOCKED, no worker launched" '[ "$rc" -eq 6 ] && [ ! -f "$loc/claude.argv" ]'
: > "$a/hooks/proofline-hook.sh"
reset; d T-1 reviewer --focus rules
ck "an empty hook script: BLOCKED, no worker launched" '[ "$rc" -eq 6 ] && [ ! -f "$loc/claude.argv" ]'
cp "$tmp/hook.keep" "$a/hooks/proofline-hook.sh"
reset; d T-1 reviewer --focus rules
ck "correct wiring and script: the worker is launched" '[ "$rc" -eq 0 ] && grep -qx bypassPermissions "$loc/claude.argv"'
printf 'reviewer Read,Grep,Agent,Task(x),Bash\n' > "$a/tools.conf"
reset; d T-1 reviewer --focus rules
ck "claude path: tools.conf list without Agent/Task" '[ "$rc" -eq 0 ] && has "$loc/claude.argv" "\"tools\":[\"Read\",\"Grep\",\"Bash\"]" && ! has "$loc/claude.argv" "\"Agent\"" && ! has "$loc/claude.argv" Task'
rm -f "$a/tools.conf"
mkdir -p "$p/.claude/agents"; printf -- '---\nname: proofline-security-reviewer\ntools: Read, Grep, Glob, Bash\n---\nbody\n' > "$p/.claude/agents/proofline-security-reviewer.md"
reset; d T-1 security_reviewer
ck "claude path: the generated .claude agent runs (--agent proofline-security-reviewer)" '[ "$rc" -eq 0 ] && grep -qx proofline-security-reviewer "$loc/claude.argv" && ! has "$loc/claude.argv" --agents'
printf -- '---\nname: proofline-security-reviewer\ntools: Read, Task, Bash\n---\nbody\n' > "$p/.claude/agents/proofline-security-reviewer.md"
reset; d T-1 security_reviewer
ck "claude path: a generated agent granting Task is BLOCKED" '[ "$rc" -eq 6 ] && [ ! -f "$loc/claude.argv" ] && ! has "$loc/calls.log" submit'
rm -rf "$p/.claude/agents"

reset; d T-1 designer --runtime claude
ck "designer before IMPLEMENTING: no window, product tree fingerprinted" '[ "$rc" -eq 0 ] && ! has "$loc/calls.log" window-open && has "$loc/calls.log" fingerprint'
printf 'handoff:\n  state: IMPLEMENTING\n' > "$a/runs/T-1/RUN.yaml"
reset; d T-1 designer --runtime claude
ck "designer during IMPLEMENTING is bracketed like the implementer" '[ "$rc" -eq 0 ] && has "$loc/calls.log" "window-open T-1 designer" && has "$loc/calls.log" "window-close T-1 FP-BEFORE 0 designer"'
rm -f "$a/runs/T-1/RUN.yaml"

reset; d FAKE_CODEX=hooks T-1 reviewer --runtime codex
ck "a step changing .git/config (hooksPath) is BLOCKED, not recorded" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "git/config" && ! printf "%s" "$out" | grep -q "^submitted" && has "$loc/ledger.log" policy_violation'
git -C "$p" config --unset core.hooksPath
reset; d FAKE_CODEX=head T-1 implementer
ck "a step moving HEAD is BLOCKED even for the implementer" '[ "$rc" -eq 6 ] && has "$loc/calls.log" window-close && ! printf "%s" "$out" | grep -q "^submitted"'
git -C "$p" symbolic-ref HEAD refs/heads/main

reset; d FAKE_CLAUDE=limit T-1 reviewer
ck "limit error fails over to codex (auto)" '[ "$rc" -eq 0 ] && has "$loc/recorded.md" "role=reviewer result=DONE" && [ "$(cat "$loc/codex.role")" = reviewer ] && has "$loc/codex.argv" "$a/runs/T-1" && ! has "$loc/codex.argv" worker-evidence'
ck "failover ledgered with reason" 'has "$loc/ledger.log" "failover from=claude to=codex reason=limit role=reviewer"'
ck "failover re-decides on the other runtime" 'grep -q "^decide T-1 reviewer --runtime codex" "$loc/calls.log"'

reset; d PROOFLINE_CLAUDE_BIN="$tmp/bin/nope" T-1 reviewer
ck "missing binary fails over" '[ "$rc" -eq 0 ] && has "$loc/ledger.log" "reason=missing_binary"'

reset; d FAKE_CODEX=fail T-1 implementer
ck "task failure: exit 1, no failover, no record" '[ "$rc" -eq 1 ] && ! has "$loc/calls.log" submit && [ ! -f "$loc/claude.argv" ]'

reset; d FAKE_CODEX=network T-1 implementer
ck "network failure: BLOCKED with runtime_unavailable:network guidance" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "runtime_unavailable:network" && printf "%s" "$out" | grep -q "enable network access" && [ ! -f "$loc/claude.argv" ] && ! has "$loc/calls.log" submit'

mkcfg ask
reset; d FAKE_CLAUDE=limit T-1 reviewer
ck "failover ask: NEEDS_INPUT, exit 5, other runtime not run" '[ "$rc" -eq 5 ] && printf "%s" "$out" | grep -q "^RESULT: NEEDS_INPUT" && printf "%s" "$out" | grep -q "on codex?" && [ ! -f "$loc/codex.argv" ]'
ck "failover ask: the question is stored through agent.sh ask as the lead (pending question)" 'grep -q "^ask T-1 --file " "$loc/calls.log" && grep -qx "AGENT_ROLE=" "$loc/calls.log" && has "$loc/asked.md" "1. Runtime claude could not run reviewer" && has "$loc/asked.md" "options: yes | no" && ! has "$loc/calls.log" submit'

mkcfg off
reset; d FAKE_CLAUDE=limit T-1 reviewer
ck "failover off: BLOCKED, exit 6" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "^RESULT: BLOCKED" && [ ! -f "$loc/codex.argv" ] && ! has "$loc/calls.log" submit'

mkcfg auto "gpt-6-luna gpt-6-sol"
reset; d FAKE_CLAUDE=limit T-1 security_reviewer
ck "security_reviewer floor unmet on failover: BLOCKED, never downgraded" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "capability floor" && [ ! -f "$loc/codex.argv" ] && ! has "$loc/calls.log" submit'

mkcfg auto
reset; dd if=/dev/zero bs=1000 count=60 2>/dev/null | tr '\0' x > "$tmp/big"; d T-1 reviewer --prompt-file "$tmp/big"
ck "prompt over the context budget is BLOCKED, not truncated" '[ "$rc" -eq 6 ] && [ ! -f "$loc/claude.argv" ]'

reset; d T-1 reviewer --runtime mycli
ck "command_template runtime (D8)" '[ "$rc" -eq 0 ] && has "$a/runs/T-1/dispatch/001-reviewer-mycli.md" "model=m2" && [ "$(sed -n 2p "$a/runs/T-1/dispatch/001-reviewer-mycli.md")" = 1 ]'

reset; d FAKE_CODEX=nosubmit T-1 reviewer --runtime codex
ck "a final message with a header is never recorded: rerun once, then BLOCKED" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "no valid submission" && [ "$(grep -c "^decide" "$loc/calls.log")" -eq 2 ] && has "$loc/ledger.log" "dispatch resubmit role=reviewer"'
reset; d FAKE_CODEX=rejected T-1 reviewer --runtime codex
ck "a rejected submission: the rejection goes into the one rerun and into BLOCKED" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "last rejection: --confidence must be high" && [ "$(grep -c "^decide" "$loc/calls.log")" -eq 2 ]'
reset; d FAKE_CODEX=late T-1 reviewer --runtime codex
ck "A127: a rerun for no submission ledgers the token it looked for and the status files that exist" 'has "$loc/ledger.log" "reason=no submission token=d001-reviewer-codex status_files="'
ck "no submission on the first attempt, one on the rerun: recorded with the retry note in the prompt" '[ "$rc" -eq 0 ] && has "$loc/recorded.md" "token=d002-reviewer-codex" && has "$loc/codex.stdin" "Your previous attempt ended without a recorded result"'

# A124: a worker that writes nothing leaves a reason (BLOCKED, non-empty log); a running dispatch leaves a marker
reset; d FAKE_CLAUDE=empty T-1 reviewer --runtime claude
ck "0-byte worker result: BLOCKED with a reason, log not empty, no marker left" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q "^BLOCKED_REASON: reviewer on claude produced no output" && has "$a/runs/T-1/dispatch/001-reviewer-claude.log" "wrote nothing" && [ -z "$(ls "$a"/runs/T-1/dispatch/*.running 2>/dev/null)" ]'
reset; d FAKE_CODEX=nosubmit T-1 implementer
ck "the implementer prompt states the window and a missing assignment (no file to look for)" 'has "$loc/codex.stdin" "WINDOW: dispatch.sh opened your write window" && has "$loc/codex.stdin" "ASSIGNMENT: none was given" && has "$loc/codex.stdin" "never report BLOCKED for a missing window"'
reset; d T-1 reviewer --runtime claude --prompt-file "$a/roles.conf"
ck "a reviewer with an assignment gets neither line" '! has "$loc/claude.stdin" "WINDOW: dispatch.sh" && ! has "$loc/claude.stdin" "ASSIGNMENT: none was given"'
# A132: each explorer dispatch names its own token-derived scratch report path
reset; d T-1 explorer --runtime claude
ck "the explorer prompt names its own token-derived scratch report" 'has "$loc/claude.stdin" "scratch/d001-explorer-claude-report.md"'
d T-1 explorer --runtime claude
ck "a second explorer dispatch gets a different scratch report path" 'has "$loc/claude.stdin" "scratch/d002-explorer-claude-report.md" && ! has "$loc/claude.stdin" "scratch/d001-explorer-claude-report.md"'
# A132: a test-lib script with an unusable TMPDIR stops (exit 2) instead of building its fixture in the current
# directory; a throwaway repository sees no commit and no config change
guard=$tmp/guard-repo; mkdir -p "$guard"; ( cd "$guard" && git init -q 2>/dev/null )
# shellcheck disable=SC2034 # read by the ck condition below
grc=0; ( cd "$guard" && TMPDIR=/nonexistent/proofline-guard sh "$here/gates-test.sh" >/dev/null 2>&1 ) || grc=$?; : "$grc"
ck "a test-lib script with a missing TMPDIR exits 2 and leaves the current repository untouched" '[ "$grc" -eq 2 ] && [ -z "$(git -C "$guard" rev-list --all 2>/dev/null)" ] && ! git -C "$guard" config --local core.hooksPath >/dev/null 2>&1'
reset; mkdir -p "$loc"
( rc=0; env FAKE_CLAUDE=hold sh "$a/scripts/dispatch.sh" T-1 reviewer --runtime claude > "$tmp/hold.out" 2>&1 || rc=$?; echo "$rc" > "$tmp/hold.rc" ) &
w=0; while [ -z "$(ls "$a"/runs/T-1/dispatch/*.running 2>/dev/null)" ] && [ "$w" -lt 100 ]; do sleep 0.1; w=$((w + 1)); done
# shellcheck disable=SC2034 # m is read by the ck condition below
m=$(cat "$a"/runs/T-1/dispatch/*.running 2>/dev/null); touch "$loc/release"; wait
ck "a running dispatch leaves a marker (in flight, do not re-dispatch); it is removed when the step ends" 'printf "%s" "$m" | grep -q "dispatch in flight: T-1 reviewer on claude" && printf "%s" "$m" | grep -q "do not re-dispatch" && [ "$(cat "$tmp/hold.rc")" -eq 0 ] && [ -z "$(ls "$a"/runs/T-1/dispatch/*.running 2>/dev/null)" ]'

TIMEOUT=1 mkcfg auto
reset; d FAKE_CODEX=sleep PROOFLINE_DISPATCH_MIN_TIMEOUT=1 T-1 implementer
ck "timeout: exit 124, window closed, no record" '[ "$rc" -eq 124 ] && has "$loc/calls.log" "window-close T-1 FP-BEFORE 124" && ! has "$loc/calls.log" submit'
# A171: the timeout comes from the run's class (pipelines.<CLASS>.dispatch_timeout_seconds) before the global one, and a
# timeout leaves a resume note that the next dispatch of the same role carries in its prompt
printf 'pipeline:\n  classification: COMPLEX\n' > "$a/runs/T-1/RUN.yaml"
TIMEOUT=60 mkcfg auto; printf 'pipelines:\n  COMPLEX:\n    dispatch_timeout_seconds: 1\n  STANDARD:\n    dispatch_timeout_seconds: 60\n' >> "$a/config.yaml"
echo partial > "$p/partial-work.txt"
reset; d FAKE_CODEX=sleep PROOFLINE_DISPATCH_MIN_TIMEOUT=1 T-1 implementer
ck "A171 per-class timeout: COMPLEX times out at its own limit although dispatch.timeout_seconds is 60" '[ "$rc" -eq 124 ] && has "$loc/ledger.log" "after=1s"'
ck "A171 timeout records the partial work in a resume note" 'has "$a/runs/T-1/dispatch/RESUME-implementer.md" "partial-work.txt" && has "$a/runs/T-1/dispatch/RESUME-implementer.md" "timed_out_at:"'
d FAKE_CODEX=ok T-1 implementer
ck "A171 re-dispatch carries the resume note and continues; the note is spent after the submission" '[ "$rc" -eq 0 ] && has "$loc/codex.stdin" "RESUME: an earlier dispatch of this step timed out" && has "$loc/codex.stdin" "partial-work.txt" && [ ! -e "$a/runs/T-1/dispatch/RESUME-implementer.md" ]'
rm -f "$p/partial-work.txt"
printf 'pipeline:\n  classification: STANDARD\n' > "$a/runs/T-1/RUN.yaml"
reset; d FAKE_CODEX=ok PROOFLINE_DISPATCH_MIN_TIMEOUT=1 T-1 implementer
ck "A171 a class with a longer limit does not time out a normal step" '[ "$rc" -eq 0 ] && ! has "$loc/ledger.log" "dispatch timeout"'
rm -f "$a/runs/T-1/RUN.yaml"
mkcfg auto
reset; d FAKE_CLAUDE=limit FAKE_CODEX=edit T-1 reviewer
ck "non-code role editing the product tree: BLOCKED, not recorded, not reverted" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q policy_violation && ! grep -q "^record" "$loc/calls.log" && has "$p/product.txt" tampered && has "$loc/ledger.log" policy_violation'
echo original > "$p/product.txt"
reset; d T-1 reviewer --model 'x y'
ck "unsafe override value is a usage error" '[ "$rc" -eq 2 ]'
# A171 (review): a nonce a killed dispatch left behind is swept at the next attempt; a fresh one (a live dispatch) is not; none remains after a run
reset; mkdir -p "$a/local/dispatch"; echo 1 > "$a/local/dispatch/nonce-0000000000000000old"; touch -t 202001010000 "$a/local/dispatch/nonce-0000000000000000old"
echo 1 > "$a/local/dispatch/nonce-0000000000000000new"
d FAKE_CODEX=ok PROOFLINE_DISPATCH_MIN_TIMEOUT=1 T-1 implementer
ck "A171 stale dispatch nonce is swept, a fresh one kept, and the run's own is removed" '[ ! -e "$a/local/dispatch/nonce-0000000000000000old" ] && [ -e "$a/local/dispatch/nonce-0000000000000000new" ] && [ "$(ls "$a/local/dispatch" | wc -l | tr -d " ")" = 1 ]'
rm -f "$a/local/dispatch"/nonce-*

# Metrics (A80): the dispatch record. Fields: ID|ROLE|FOCUS|RUNTIME|MODEL|DURATION|TIN|TOUT|TTOTAL|TURNS|RETRIES|RESULT|
reset; d FAKE_CLAUDE=usage T-1 reviewer --focus rules
ck "metrics: claude usage and turns come from the runtime JSON (last usage object, not model text)" 'grep -Eq "^T-1\|reviewer\|rules\|claude\|[a-z0-9.-]+\|[0-9]+\|120\|30\|150\|4\|0\|submitted\|$" "$loc/metrics.log"'
reset; d T-1 reviewer --focus rules
ck "metrics: a runtime that reports no usage leaves tokens and turns null (empty), never estimated" 'grep -Eq "^T-1\|reviewer\|rules\|claude\|[a-z0-9.-]+\|[0-9]+\|\|\|\|\|0\|submitted\|$" "$loc/metrics.log"'
reset; d FAKE_CODEX=tokens T-1 implementer
ck "metrics: codex total comes from the runtime trailer (last occurrence), in/out stay null" 'grep -Eq "^T-1\|implementer\|\|codex\|[a-z0-9.-]+\|[0-9]+\|\|\|12345\|\|0\|submitted\|$" "$loc/metrics.log"'
reset; d FAKE_CODEX=inject T-1 implementer
ck "metrics: a tokens-used line injected earlier in the log, no trailer, stays null" 'grep -Eq "^T-1\|implementer\|\|codex\|[a-z0-9.-]+\|[0-9]+\|\|\|\|\|0\|submitted\|$" "$loc/metrics.log"'
reset; d FAKE_CODEX=trailer T-1 implementer
ck "metrics: the codex trailer (local number format) in front of the final message is read, not skipped (site run: 285.242)" 'grep -Eq "^T-1\|implementer\|\|codex\|[a-z0-9.-]+\|[0-9]+\|\|\|285242\|\|0\|submitted\|$" "$loc/metrics.log"'
reset; d FAKE_CODEX=limittok FAKE_CLAUDE=usage T-1 reviewer --runtime codex
ck "metrics: after a codex -> claude failover the claude record holds claude's numbers only, never codex's 52623" 'grep -Eq "^T-1\|reviewer\|\|claude\|[a-z0-9.-]+\|[0-9]+\|120\|30\|150\|4\|1\|submitted\|$" "$loc/metrics.log"'
reset; d FAKE_CODEX=late T-1 reviewer --runtime codex
ck "metrics: a resubmitted dispatch counts one retry" 'grep -Eq "\|1\|submitted\|$" "$loc/metrics.log" && [ "$(wc -l < "$loc/metrics.log" | tr -d " ")" -eq 1 ]'
reset; d FAKE_CODEX=fail T-1 implementer
ck "metrics: a failed dispatch is recorded with result failed" 'grep -Eq "\|failed\|$" "$loc/metrics.log"'

# A113: four parallel dispatches get four distinct claimed sequences: the exact tokens d001..d004, one log each
reset; mkcfg auto
pids=''
for pf in rules tests plan config; do
  env FAKE_CLAUDE=ok sh "$a/scripts/dispatch.sh" T-1 reviewer --focus "$pf" > "$tmp/par-$pf.out" 2>&1 &
  pids="$pids $!"
done
for pid in $pids; do wait "$pid"; done
ck "A113 parallel dispatches: exactly four distinct dispatch logs d001..d004" '[ "$(cd "$a/runs/T-1/dispatch" && ls ???-reviewer-claude.log | tr "\n" " ")" = "001-reviewer-claude.log 002-reviewer-claude.log 003-reviewer-claude.log 004-reviewer-claude.log " ]'
ck "A113 parallel dispatches: exactly four distinct submission tokens d001..d004" '[ "$(cd "$loc/submissions" && ls | sed "s/.status$//" | tr "\n" " ")" = "d001-reviewer-claude d002-reviewer-claude d003-reviewer-claude d004-reviewer-claude " ]'

[ "$fails" -eq 0 ]
