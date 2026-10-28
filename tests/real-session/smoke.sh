#!/bin/sh
# Real-session smoke test (A195): a real Claude Code session with a cheap model drives proofline in a throwaway fixture repository:
#   /proofline run (a TRIVIAL task, the implementer writes a file), /proofline deliver (local bare origin) and /proofline batch (two tasks).
# It prints a step-by-step PASS/FAIL table and exits non-zero on any FAIL. It calls a model, so it is never part of CI; the rule in
# CONTRIBUTING.md is: a pull request that changes hooks, skills, roles or the control plane runs this script and pastes its table.
#
#   sh tests/real-session/smoke.sh
#   SMOKE_MODEL=haiku         the model of the lead (default haiku; the economy profile makes the workers cheap too)
#   SMOKE_STEP_TIMEOUT=900    seconds one claude call may take (default 900)
#   SMOKE_MAX_REPLIES=6       replies per step after the first prompt (default 6)
#   SMOKE_RTK=auto|no         auto (default): when rtk is installed, run a second pass with the user's settings (so the rtk hook) loaded
#   SMOKE_ONLY=codex          only the Codex step (A199): setup, the sandbox probe and a two-task batch with a Codex implementer in worktrees
#   SMOKE_KEEP=1              keep the fixture and transcripts (their path is printed)
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
model=${SMOKE_MODEL:-haiku}
step_timeout=${SMOKE_STEP_TIMEOUT:-900}
max_replies=${SMOKE_MAX_REPLIES:-6}
command -v claude >/dev/null 2>&1 || { echo 'smoke: claude is not installed' >&2; exit 127; }
command -v node >/dev/null 2>&1 || { echo 'smoke: node is not installed' >&2; exit 127; }
# the script plays the human user (commit, push, merge): the markers of a surrounding agent session would make the git hooks treat it as an agent
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_BRIDGE_SESSION_ID \
  CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_PLUGIN_DATA CLAUDE_PLUGIN_ROOT CODEX_CI CODEX_SANDBOX CODEX_THREAD_ID CODEX_SESSION_ID AGENT_ROLE
unset PROOFLINE_NO_TTY
work=$(mktemp -d "${TMPDIR:-/tmp}/proofline-smoke.XXXXXX") || exit 1
pids=''
cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || :; done
  [ "${SMOKE_KEEP:-}" = 1 ] || rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
rows="$work/rows.tsv"; : > "$rows"
fails=0

row() { # NAME RESULT SECONDS NOTE
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$rows"
  case $2 in PASS|SKIP) ;; *) fails=$((fails + 1)) ;; esac
}
secs() { echo $(( $(date +%s) - $1 )); }

# claude_call PROJECT OUT PROMPT [SESSION]: one headless Claude Code call, stopped after step_timeout; prints the session id
claude_call() {
  cc_proj=$1; cc_out=$2; cc_prompt=$3; cc_sess=${4:-}
  cc_src=project,local; [ "${smoke_user_settings:-no}" = no ] || cc_src=user,project,local
  if [ -n "$cc_sess" ]; then
    (cd "$cc_proj" && exec env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p "$cc_prompt" --resume "$cc_sess" --setting-sources "$cc_src" --permission-mode bypassPermissions --model "$model" --output-format stream-json --verbose --max-turns 150) >> "$cc_out" 2>&1 < /dev/null &
  else
    (cd "$cc_proj" && exec env CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p "$cc_prompt" --setting-sources "$cc_src" --permission-mode bypassPermissions --model "$model" --output-format stream-json --verbose --max-turns 150) >> "$cc_out" 2>&1 < /dev/null &
  fi
  cc_pid=$!; pids="$pids $cc_pid"; cc_t=0
  while kill -0 "$cc_pid" 2>/dev/null && [ "$cc_t" -lt "$step_timeout" ]; do sleep 1; cc_t=$((cc_t + 1)); done
  if kill -0 "$cc_pid" 2>/dev/null; then kill "$cc_pid" 2>/dev/null || :; echo "timeout after ${step_timeout}s" >> "$cc_out.note"; fi
  wait "$cc_pid" 2>/dev/null || :
  if [ -n "$cc_sess" ]; then printf '%s\n' "$cc_sess"; else sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' "$cc_out" | head -n 1; fi
}

A() { (cd "$P" && sh .agents/scripts/agent.sh "$@"); }
active_id() { A status 2>/dev/null | sed -n 's/^active_task=//p' | head -n 1; }

# the user's merge of a delivered branch on the local origin (platform other: proofline pushes, the user merges)
user_merges() {
  for b in $(git --git-dir="$ORIGIN" for-each-ref --format='%(refname:short)' refs/heads/ | grep '^proofline/'); do
    git --git-dir="$ORIGIN" merge-base --is-ancestor "$b" main 2>/dev/null && continue
    um_t=$(mktemp -d "$work/merge.XXXXXX")
    ( git clone -q "$ORIGIN" "$um_t/c" && cd "$um_t/c" && git config user.email smoke@example.invalid && git config user.name Smoke \
      && git merge -q --no-edit "origin/$b" >/dev/null 2>&1 && git push -q origin HEAD:main ) >/dev/null 2>&1 || :
  done
  (cd "$P" && git fetch -q origin 2>/dev/null; true)
}

# codex_config_commit: with Codex installed, the implementer runs on Codex from now on (the batch then runs Codex implementers in run worktrees, A196);
# succeeds once the commit on main is possible (the run of T-1 is closed) or when there is nothing to change
codex_config_commit() {
  command -v codex >/dev/null 2>&1 || return 0
  grep -q '^    implementer: codex' "$P/.agents/config.yaml" && git -C "$P" diff --quiet HEAD -- .agents/config.yaml && return 0
  grep -q '^    implementer: codex' "$P/.agents/config.yaml" || { sed 's/^  roles:[[:space:]]*$/  roles:\n    implementer: codex/' "$P/.agents/config.yaml" > "$P/cfg.tmp" && mv "$P/cfg.tmp" "$P/.agents/config.yaml"; }
  git -C "$P" add -A && git -C "$P" commit -q -m 'chore: implementer runs on codex' 2>/dev/null && git -C "$P" push -q origin main
}

# codex_sandbox_row: the profile dispatch.sh gives a Codex worker, applied with `codex sandbox` (no model) to the installed scripts of this project:
# the worker's own record paths are writable, .agents/local/windows, approvals and prompts are not (A199)
codex_sandbox_row() {
  command -v codex >/dev/null 2>&1 || { row "codex sandbox: windows/approvals/prompts denied" SKIP 0 "codex is not installed"; return 0; }
  cs_t=$(date +%s); cs_h=$work/chome; mkdir -p "$cs_h" "$P/.agents/runs/SMOKE-P" "$P/.agents/local/windows" "$P/.agents/local/approvals" "$P/.agents/local/prompts" "$P/.agents/local/locks" "$P/.agents/local/submissions"
  cat > "$work/cs-probe.sh" <<'EOF_CS'
try() { ( : > "$1" ) 2>/dev/null && echo "WROTE $1" || echo "DENIED $1"; }
try .agents/runs/SMOKE-P/own.txt
try .agents/local/locks/own.probe
try .agents/local/windows/forged
try .agents/local/approvals/forged
try .agents/local/prompts/forged
EOF_CS
  set --
  while IFS= read -r cs_a; do set -- "$@" "$cs_a"; done <<EOF_CSA
$(cd "$P" && sh .agents/scripts/dispatch.sh codex-profile SMOKE-P 2>/dev/null)
EOF_CSA
  CODEX_HOME=$cs_h codex sandbox -C "$P" -P proofline-worker "$@" -- sh "$work/cs-probe.sh" > "$work/cs-probe.out" 2>&1
  rm -rf "$P/.agents/runs/SMOKE-P"
  if grep -qx 'WROTE .agents/runs/SMOKE-P/own.txt' "$work/cs-probe.out" && grep -qx 'WROTE .agents/local/locks/own.probe' "$work/cs-probe.out" \
     && grep -qx 'DENIED .agents/local/windows/forged' "$work/cs-probe.out" && grep -qx 'DENIED .agents/local/approvals/forged' "$work/cs-probe.out" \
     && grep -qx 'DENIED .agents/local/prompts/forged' "$work/cs-probe.out"; then
    row "codex sandbox: windows/approvals/prompts denied, own paths writable" PASS "$(secs "$cs_t")" "the installed dispatch.sh profile, applied by codex sandbox"
  else row "codex sandbox: windows/approvals/prompts denied, own paths writable" FAIL "$(secs "$cs_t")" "$(tr '\n' ' ' < "$work/cs-probe.out" | cut -c1-200)"; fi
}

# drive STEP PROMPT DONE_CMD...: the first prompt, then up to max_replies replies of the user until DONE_CMD (run with eval) succeeds
drive() {
  dr_step=$1; dr_prompt=$2; dr_done=$3; dr_reply=$4
  dr_out="$work/$dr_step.jsonl"; : > "$dr_out"; dr_n=0
  dr_sess=$(claude_call "$P" "$dr_out" "$dr_prompt")
  [ -n "$dr_sess" ] || { echo "no session id in $dr_out" >&2; return 1; }
  while ! eval "$dr_done" && [ "$dr_n" -lt "$max_replies" ]; do
    user_merges
    eval "$dr_done" && break
    dr_n=$((dr_n + 1))
    claude_call "$P" "$dr_out" "$dr_reply" "$dr_sess" >/dev/null
  done
  eval "$dr_done"
}

skill_detour_row() { # Claude Code rejects a Skill call for a proofline skill before any hook runs; what counts is that the lead then read the file and went on
  sd_calls=$(cat "$work"/*.jsonl 2>/dev/null | grep -o '"name":"Skill"' | wc -l | tr -d ' ')
  if [ "$sd_calls" -le 0 ]; then row "skill tool not used" PASS 0 "no Skill-tool call in any transcript"
  elif [ "$sd_calls" -le 3 ] && [ "$fails" -eq 0 ]; then row "skill tool: the lead recovered" PASS 0 "$sd_calls rejected call(s); every step above still passed, so the lead read the file and went on"
  else row "skill tool: the lead recovered" FAIL 0 "$sd_calls Skill-tool call(s) and a failed step above"; fi
}

pass() { # one full pass (setup, run, deliver, batch); NAME_PREFIX
  pr_pre=$1
  P="$work/$pr_pre/project"; ORIGIN="$work/$pr_pre/origin.git"
  mkdir -p "$P/src" "$P/tests" "$P/.agents/tasks"
  t0=$(date +%s)
  git init -q --bare -b main "$ORIGIN"
  cat > "$P/package.json" <<'EOF'
{ "name": "smoke-app", "version": "1.0.0", "private": true, "type": "module", "scripts": { "test": "node --test" } }
EOF
  printf 'export function greet(name) {\n  return `Hello, ${name}`;\n}\n' > "$P/src/greet.js"
  printf 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "../src/greet.js";\ntest("greet", () => assert.equal(greet("a"), "Hello, a"));\n' > "$P/tests/greet.test.js"
  printf '# smoke-app\n\nA tiny fixture for the proofline real-session smoke test.\n' > "$P/README.md"
  git -C "$P" init -q -b main
  git -C "$P" config user.name Smoke; git -C "$P" config user.email smoke@example.invalid; git -C "$P" config commit.gpgsign false
  git -C "$P" add -A; git -C "$P" commit -q -m 'chore: fixture'
  git -C "$P" remote add origin "$ORIGIN"; git -C "$P" push -q origin main
  rts=claude; command -v codex >/dev/null 2>&1 && rts=claude,codex
  if (cd "$P" && "$repo/bin/proofline" init --yes --runtimes "$rts" --lead claude --worker claude --reviewers claude --profile economy --task-adapter markdown) > "$work/$pr_pre-init.txt" 2>&1 \
     && git -C "$P" add -A && git -C "$P" commit -q -m 'chore: install proofline' && git -C "$P" push -q origin main; then
    row "$pr_pre setup: init, local bare origin" PASS "$(secs "$t0")" "installed proofline $(cd "$P" && "$repo/bin/proofline" version)"
  else row "$pr_pre setup: init, local bare origin" FAIL "$(secs "$t0")" "see $work/$pr_pre-init.txt"; return 0; fi
  t0=$(date +%s)
  if (cd "$P" && "$repo/bin/proofline" doctor) > "$work/$pr_pre-doctor.txt" 2>&1; then row "$pr_pre doctor" PASS "$(secs "$t0")" "$(tail -n 1 "$work/$pr_pre-doctor.txt")"
  else row "$pr_pre doctor" FAIL "$(secs "$t0")" "$(grep '^FAIL' "$work/$pr_pre-doctor.txt" | head -n 1)"; fi

  for tk in T-1 T-2 T-3; do
    case $tk in
      T-1) f=shout; fn=shout; ac='the text in upper case followed by "!"' ;;
      T-2) f=whisper; fn=whisper; ac='the text in lower case followed by "..."' ;;
      *) f=repeat; fn=repeatTwice; ac='the text twice, separated by one space' ;;
    esac
    cat > "$P/.agents/tasks/$tk.md" <<EOF
# Task: $tk — add $fn

## Goal

Add src/$f.js exporting a function $fn(text) with a test in tests/$f.test.js.

## Context

Fixture task of the proofline real-session smoke test.

## Acceptance criteria

- AC-1: src/$f.js exports $fn(text), which returns $ac.
- AC-2: tests/$f.test.js tests it with node:test and \`npm test\` passes.

## Out of scope

- Any change to src/greet.js.

## Constraints

- No dependencies.

## Risks

- None.

## Pre-existing defects

none

## Suggested class

TRIVIAL — one new file and its test.

## Verification commands

- \`npm test\`
EOF
  done
  git -C "$P" add -A; git -C "$P" commit -q -m 'chore: tasks'; git -C "$P" push -q origin main

  if [ "${SMOKE_ONLY:-}" != codex ]; then
  # 1. run: the implementer writes the file
  t0=$(date +%s)
  if drive "$pr_pre-run" "/proofline run T-1" 'A digest T-1 2>/dev/null | grep -q "CODE_DONE"' "approve plan"; then
    tb=$(git -C "$P" branch --list 'proofline/*' | head -n 1 | tr -d ' *')
    if [ -n "$tb" ] && git -C "$P" ls-tree -r --name-only "$tb" 2>/dev/null | grep -q '^src/shout.js$' || [ -f "$P/src/shout.js" ]; then
      row "$pr_pre /proofline run (implementer wrote src/shout.js)" PASS "$(secs "$t0")" "state: $(A next T-1 2>/dev/null | head -n 1)"
    else row "$pr_pre /proofline run (implementer wrote src/shout.js)" FAIL "$(secs "$t0")" "no src/shout.js on the task branch"; fi
  else row "$pr_pre /proofline run (implementer wrote src/shout.js)" FAIL "$(secs "$t0")" "run did not reach CODE_DONE: $(A next T-1 2>/dev/null | head -n 1)"; fi

  # 2. deliver: commit, push to the local bare origin
  t0=$(date +%s)
  if drive "$pr_pre-deliver" "/proofline deliver T-1" 'git --git-dir="$ORIGIN" for-each-ref refs/heads/ | grep -q "proofline/"' "approve delivery"; then
    row "$pr_pre /proofline deliver (branch on the local origin)" PASS "$(secs "$t0")" "origin: $(git --git-dir="$ORIGIN" for-each-ref --format='%(refname:short)' refs/heads/ | grep proofline/ | head -n 1)"
  else row "$pr_pre /proofline deliver (branch on the local origin)" FAIL "$(secs "$t0")" "no proofline/* branch on the origin"; fi
  # the user merged the delivered branch on the origin; the lead closes the run (deliver-merged, cleanup) from that
  user_merges
  git -C "$P" checkout -q main 2>/dev/null; git -C "$P" pull -q --ff-only origin main 2>/dev/null || :
  drive "$pr_pre-merged" "I merged the branch of T-1 on the origin. Finish T-1." 'codex_config_commit' "I merged it on the origin; please finish T-1 (deliver-merged and cleanup)." >/dev/null 2>&1 || :
  else codex_config_commit; fi

  codex_sandbox_row

  # 3. batch of two tasks; with Codex installed the implementer is Codex, so every batch task runs a Codex implementer in a run worktree (A196)
  t0=$(date +%s)
  if drive "$pr_pre-batch" "/proofline batch T-2 T-3" 'git --git-dir="$ORIGIN" show main:src/whisper.js >/dev/null 2>&1 && git --git-dir="$ORIGIN" show main:src/repeat.js >/dev/null 2>&1' "approve batch"; then
    row "$pr_pre /proofline batch T-2 T-3 (both reach origin main)" PASS "$(secs "$t0")" "$(A batch-status 2>/dev/null | head -n 1)"
  else row "$pr_pre /proofline batch T-2 T-3 (both reach origin main)" FAIL "$(secs "$t0")" "$(A batch-next 2>/dev/null | tail -n 1)"; fi
  if command -v codex >/dev/null 2>&1; then
    if grep -rqs 'implementer-codex\|implementer.*codex' "$P/.agents/local" "$work/$pr_pre-batch.jsonl" 2>/dev/null && ! grep -qs 'cannot take the lock' "$work/$pr_pre-batch.jsonl" "$P"/.agents/local/worktrees/*/.agents/runs/*/dispatch/*codex*.log 2>/dev/null; then
      row "$pr_pre batch: a Codex implementer in a worktree, submit included" PASS 0 "no lock failure in the transcript or dispatch logs"
    else row "$pr_pre batch: a Codex implementer in a worktree, submit included" FAIL 0 "no Codex dispatch seen, or a lock failure"; fi
  else row "$pr_pre batch: Codex implementer in a worktree" SKIP 0 "codex is not installed"; fi
}

smoke_user_settings=no
pass hermetic
if [ "${SMOKE_RTK:-auto}" != no ] && command -v rtk >/dev/null 2>&1; then
  smoke_user_settings=yes
  pass rtk
else row "rtk pass" SKIP 0 "rtk is not installed here; the pass with the user's settings is skipped"; fi
skill_detour_row

printf '\nproofline real-session smoke (model %s, proofline %s)\n' "$model" "$(cat "$repo/.claude-plugin/plugin.json" | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -n 1)"
printf '| step | result | seconds | note |\n|---|---|---|---|\n'
awk -F'\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }' "$rows"
[ "${SMOKE_KEEP:-}" != 1 ] || printf 'kept: %s\n' "$work"
if [ "$fails" -gt 0 ]; then echo "smoke: $fails step(s) FAILED"; exit 1; fi
echo 'smoke: all steps PASS'
