#!/bin/sh
# shellcheck disable=SC2016,SC2086 # ck evaluates its condition later; d_env holds space-free assignments
# Tests for dispatch.sh with fake runtimes and a stub agent.sh in a throwaway installed layout.
# The stub's `decide` calls the real exec-policy.sh, so capability floors are the real ones.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/dispatch-test.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
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
for r in implementer reviewer security_reviewer designer; do printf 'You are the proofline %s. STABLE-PREFIX-%s\n' "$r" "$r" > "$a/roles/$r.md"; done

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
  limit) printf '{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1760000000"}\n'; exit 1 ;;
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
ck "codex path: .git/worktrees is a writable root (evidence worktrees)" 'grep -qx -- "$p/.git/worktrees" "$loc/codex.argv"'
ck "codex path: the run folder and .agents/local are writable roots (submit records inside the sandbox)" 'grep -qx -- "$a/runs/T-1" "$loc/codex.argv" && grep -qx -- "$a/local" "$loc/codex.argv"'
ck "codex path: AGENT_ROLE and stable prefix before task" '[ "$(cat "$loc/codex.role")" = implementer ] && [ "$(head -1 "$loc/codex.stdin")" = "You are the proofline implementer. STABLE-PREFIX-implementer" ] && has "$loc/codex.stdin" "TASK: T-1"'
ck "implementer bracketed by window-open/window-close" '[ "$(order)" = "decide window-open submit AGENT_ROLE=implementer window-close " ] && has "$loc/calls.log" "window-close T-1 FP-BEFORE 0"'
ck "the specialist's own submit is the record; the final message is only a log under dispatch/" 'has "$loc/recorded.md" "role=implementer result=DONE" && has "$loc/recorded.md" "token=d001-implementer-codex" && printf "%s" "$out" | grep -q "^submitted: T-1 implementer DONE" && ls "$a/runs/T-1/dispatch/" | grep -q "^001-implementer-codex.md$" && ! ls "$a/runs/T-1/results/" | grep -q "^dispatch-"'

reset; d PROOFLINE_CODEX_HOME_DIR="$tmp/isolated-home" T-1 implementer
ck "codex uses isolated HOME and CODEX_HOME" '[ "$rc" -eq 0 ] && [ "$(cat "$loc/codex.home")" = "$tmp/isolated-home" ] && [ "$(cat "$loc/codex.codex_home")" = "$tmp/isolated-home/.codex" ]'

reset; d HOME="$tmp/isolated-home" PROOFLINE_REAL_HOME="$tmp/real-home" T-1 reviewer --focus rules
ck "a Claude specialist started from an isolated-HOME Codex lead gets the operator's HOME back (failover)" '[ "$rc" -eq 0 ] && [ "$(cat "$loc/claude.home")" = "$tmp/real-home" ]'

reset; d T-1 reviewer --focus rules
ck "claude path: exit 0, no window" '[ "$rc" -eq 0 ] && ! has "$loc/calls.log" window-open'
ck "claude path: argv runs the role as an agent (--agents JSON from .agents/roles, default tools)" 'has "$loc/claude.argv" -p && has "$loc/claude.argv" sonnet && has "$loc/claude.argv" json && ! has "$loc/claude.argv" --append-system-prompt && grep -qx -- --agent "$loc/claude.argv" && grep -qx proofline-reviewer "$loc/claude.argv" && has "$loc/claude.argv" "\"proofline-reviewer\":{\"description\"" && has "$loc/claude.argv" STABLE-PREFIX-reviewer && has "$loc/claude.argv" "\"tools\":[\"Read\",\"Grep\",\"Glob\",\"Bash\",\"Write\",\"Edit\"]"'
ck "claude path: the submit carries the focus from the environment" 'has "$loc/recorded.md" "role=reviewer result=PASS focus=rules" && has "$loc/claude.stdin" "FOCUS: rules" && has "$loc/claude.stdin" "agent.sh submit T-1"'

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
rm -rf "$p/.claude"

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
ck "no submission on the first attempt, one on the rerun: recorded with the retry note in the prompt" '[ "$rc" -eq 0 ] && has "$loc/recorded.md" "token=d002-reviewer-codex" && has "$loc/codex.stdin" "Your previous attempt ended without a recorded result"'

TIMEOUT=1 mkcfg auto
reset; d FAKE_CODEX=sleep PROOFLINE_DISPATCH_MIN_TIMEOUT=1 T-1 implementer
ck "timeout: exit 124, window closed, no record" '[ "$rc" -eq 124 ] && has "$loc/calls.log" "window-close T-1 FP-BEFORE 124" && ! has "$loc/calls.log" submit'
mkcfg auto
reset; d FAKE_CLAUDE=limit FAKE_CODEX=edit T-1 reviewer
ck "non-code role editing the product tree: BLOCKED, not recorded, not reverted" '[ "$rc" -eq 6 ] && printf "%s" "$out" | grep -q policy_violation && ! grep -q "^record" "$loc/calls.log" && has "$p/product.txt" tampered && has "$loc/ledger.log" policy_violation'
echo original > "$p/product.txt"
reset; d T-1 reviewer --model 'x y'
ck "unsafe override value is a usage error" '[ "$rc" -eq 2 ]'

[ "$fails" -eq 0 ]
