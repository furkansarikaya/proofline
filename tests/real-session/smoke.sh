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
#   SMOKE_ONLY=a200           only the A200 scenarios (not in the default run): a question of the batch pre-flight answered with the approval, empty commands.* proposed and
#                             filled, a test-only fix round without SECURITY, the lead continuing after CODE_DONE; every assertion reads agent.sh state and the gate records
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

mk_fixture() { # NAME_PREFIX: the fixture repository, a local bare origin and proofline installed; sets P and ORIGIN; returns 1 when setup failed
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
  else row "$pr_pre setup: init, local bare origin" FAIL "$(secs "$t0")" "see $work/$pr_pre-init.txt"; return 1; fi
  return 0
}

pass() { # one full pass (setup, run, deliver, batch); NAME_PREFIX
  pr_pre=$1
  mk_fixture "$pr_pre" || return 0
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

# --- A200 scenarios (SMOKE_ONLY=a200 only): what a night batch and a fix round must do, read from the control plane, never from the model's text ---

# a200_task FILE ID CLASS TITLE GOAL AC1 AC2: a task file in the shape the other fixture tasks have; the paths are named in backticks (plan-lint reads them)
a200_task() {
  cat > "$1" <<EOF
# Task: $2 — $4

## Goal

$5

## Context

Fixture task of the proofline real-session smoke test (A200 scenarios).

## Acceptance criteria

- AC-1: $6
- AC-2: $7

## Out of scope

- Any change to src/greet.js.

## Constraints

- No dependencies.

## Risks

- None.

## Pre-existing defects

none

## Suggested class

$3

## Verification commands

- \`npm test\`
EOF
}
cfg_get() { (cd "$P" && sh .agents/scripts/agent.sh config-get "$1" 2>/dev/null) || :; }
gcount() { # ID GATE: the gate records of a run
  gc_n=0; for gc_f in "$P/.agents/runs/$1/gates"/*-"$2".yaml; do [ -f "$gc_f" ] && gc_n=$((gc_n + 1)); done; echo "$gc_n"
}
batch_row() { A batch-next --tsv 2>/dev/null | awk -F'\t' -v t="$1" '$1 == t { print $2 "\t" $3 }'; }   # ID: state<TAB>detail, from the batch records
ab_say() { claude_call "$P" "$ab_out" "$1" "$ab_sess" >/dev/null; ab_msgs=$((ab_msgs + 1)); }
ab_done() { git --git-dir="$ORIGIN" show main:src/join.js >/dev/null 2>&1 && git --git-dir="$ORIGIN" show main:src/pad.js >/dev/null 2>&1; }

# scenarios (a), (b), (d): one batch of two tasks. B-1 names four code paths under a TRIVIAL class (plan-lint asks the split question before the approval);
# commands.build|test|lint are empty and the project has scripts for all three (the summary proposes them)
# shellcheck disable=SC2016 # the backticks in the task texts are literal
a200_batch() {
  ab_n='a200 batch'; ab_out="$work/a200-batch.jsonl"; : > "$ab_out"; ab_msgs=0
  mk_fixture a200b || return 0
  printf '{ "name": "smoke-app", "version": "1.0.0", "private": true, "type": "module", "scripts": { "test": "node --test", "build": "node --check src/greet.js", "lint": "node --check tests/greet.test.js" } }\n' > "$P/package.json"
  sed 's/^  test:[[:space:]]*[^[:space:]#].*$/  test:/' "$P/.agents/config.yaml" > "$P/cfg.tmp" && mv "$P/cfg.tmp" "$P/.agents/config.yaml"
  a200_task "$P/.agents/tasks/B-1.md" B-1 'TRIVIAL — one function in three small modules.' 'join two words' \
    'Add `src/join.js`, `src/join-parts.js` and `src/join-sep.js` and a test `tests/join.test.js`: joinWords(a, b) (exported from src/join.js) uses the helpers.' \
    'joinWords(a, b) returns a and b separated by one space.' 'tests/join.test.js tests it with node:test and `npm test` passes.'
  a200_task "$P/.agents/tasks/B-2.md" B-2 'TRIVIAL — one new file and its test.' 'pad a word' \
    'Add `src/pad.js` exporting padWord(text) with a test in `tests/pad.test.js`.' \
    'padWord(text) returns the text with one space on each side.' 'tests/pad.test.js tests it with node:test and `npm test` passes.'
  git -C "$P" add -A; git -C "$P" commit -q -m 'chore: a200 tasks'; git -C "$P" push -q origin main
  t0=$(date +%s)
  ab_sess=$(claude_call "$P" "$ab_out" "/proofline batch B-1 B-2")
  if [ -z "$ab_sess" ]; then
    for ab_r in "(a) pre-flight answer: the batch does not park at freeze" "(b) empty commands proposed in the summary, filled after approval" "(d) the lead continues after CODE_DONE and to the next task"; do
      row "$ab_n $ab_r" FAIL "$(secs "$t0")" "no session id in $ab_out"; done
    return 0
  fi
  ab_sum="$P/.agents/local/batch/SUMMARY.md"
  [ -f "$ab_sum" ] || ab_say "Plan the batch of B-1 and B-2 now and show me the summary with its questions."
  cp "$ab_sum" "$work/a200-SUMMARY.md" 2>/dev/null || : > "$work/a200-SUMMARY.md"
  ab_q=$(awk -F'\t' '$2 == "B-1" && $3 == "split" { print $1; exit }' "$P/.agents/local/batch/lint.tsv" 2>/dev/null)
  ab_sec=$(grep -c '^## Verification commands' "$work/a200-SUMMARY.md" || :)
  ab_prop=$(sed -n 's/^commands proposal: //p' "$work/a200-SUMMARY.md" | head -n 1)
  # the user answers the question in their own words, then approves the batch (two messages: an answer is never an approval)
  [ -z "$ab_q" ] || ab_say "$ab_q: do not split it, proceed without splitting"
  ab_ans=$(A batch-answers B-1 2>/dev/null)
  ab_i=0
  while [ "$ab_i" -lt 3 ] && [ "$(A batch-next --tsv 2>/dev/null | sed -n 1p)" != "state$(printf '\t')approved" ]; do ab_i=$((ab_i + 1)); ab_say "approve batch"; done
  ab_at=$ab_msgs
  # checkpoint: after the approval message alone, nothing else said
  ab_row=$(batch_row B-1)
  ab_pushed=$(git --git-dir="$ORIGIN" for-each-ref --format='%(refname:short)' refs/heads/ | grep -c '^proofline/' || :)
  ab_i=0
  while ! ab_done && [ "$ab_i" -lt "$max_replies" ]; do
    user_merges
    ab_done && break
    ab_i=$((ab_i + 1)); ab_say "I merged it on the origin."
  done
  user_merges
  ab_note=$(grep -o 'note=BATCH (A200)' "$ab_out" | wc -l | tr -d ' ')
  ab_secs=$(secs "$t0")

  # (a) the question asked by the pre-flight and answered with the approval: recorded as the user's, and B-1 was not parked at freeze
  ab_state=$(printf '%s' "$ab_row" | cut -f1); ab_det=$(printf '%s' "$ab_row" | cut -f2)
  if [ -z "$ab_q" ]; then row "$ab_n (a) pre-flight answer: the batch does not park at freeze" FAIL "$ab_secs" "the summary asked no split question for B-1 (lint.tsv)"
  elif ! printf '%s\n' "$ab_ans" | grep -q 'split: option b'; then row "$ab_n (a) pre-flight answer: the batch does not park at freeze" FAIL "$ab_secs" "agent.sh batch-answers B-1 recorded no 'split: option b': $ab_ans"
  elif [ "$ab_state" = parked ] && [ "$ab_det" != 'awaiting merge' ]; then row "$ab_n (a) pre-flight answer: the batch does not park at freeze" FAIL "$ab_secs" "B-1 is parked after the approval: $ab_det"
  elif ! git --git-dir="$ORIGIN" show main:src/join.js >/dev/null 2>&1; then row "$ab_n (a) pre-flight answer: the batch does not park at freeze" FAIL "$ab_secs" "B-1 never reached origin main (batch-next: $ab_state $ab_det)"
  else row "$ab_n (a) pre-flight answer: the batch does not park at freeze" PASS "$ab_secs" "answer recorded ($ab_q: $(printf '%s' "$ab_ans" | tr '\n' ' ')); B-1 state after the approval: $ab_state/$ab_det"; fi

  # (b) the summary proposes the empty commands; after the approval exactly the proven ones are in the configuration
  ab_bad=''
  for ab_k in build test lint; do
    ab_v=$(cfg_get "commands.$ab_k")
    [ -n "$ab_v" ] || { ab_bad="$ab_bad commands.$ab_k is still empty;"; continue; }
    grep -qF "commands.$ab_k: $ab_v" "$work/a200-SUMMARY.md" || ab_bad="$ab_bad commands.$ab_k=$ab_v was not in the summary's proposal;"
  done
  if [ "$ab_sec" -le 0 ] || [ -z "$ab_prop" ]; then row "$ab_n (b) empty commands proposed in the summary, filled after approval" FAIL "$ab_secs" "the summary has no 'Verification commands' proposal (a proven proposal needs proofline doctor --commands before batch-plan)"
  elif [ -n "$ab_bad" ]; then row "$ab_n (b) empty commands proposed in the summary, filled after approval" FAIL "$ab_secs" "$ab_bad"
  else row "$ab_n (b) empty commands proposed in the summary, filled after approval" PASS "$ab_secs" "proposal $ab_prop; build=$(cfg_get commands.build) test=$(cfg_get commands.test) lint=$(cfg_get commands.lint)"; fi

  # (d) after the approval message alone the lead carried B-1 past CODE_DONE to a pushed branch, and went on to B-2 without being told
  if [ "$ab_pushed" -le 0 ]; then row "$ab_n (d) the lead continues after CODE_DONE and to the next task" FAIL "$ab_secs" "no proofline/* branch on the origin after the approval message ($ab_at user messages): the lead stopped before delivery (B-1 $ab_state/$ab_det)"
  elif ! ab_done; then row "$ab_n (d) the lead continues after CODE_DONE and to the next task" FAIL "$ab_secs" "B-1 was delivered by the lead, but B-2 never reached origin main"
  elif [ "$ab_note" -le 0 ]; then row "$ab_n (d) the lead continues after CODE_DONE and to the next task" FAIL "$ab_secs" "no note=BATCH (A200) line in any agent.sh next output of the transcript"
  else row "$ab_n (d) the lead continues after CODE_DONE and to the next task" PASS "$ab_secs" "delivered with $ab_at user messages (none after the approval); note=BATCH seen $ab_note time(s); $((ab_msgs - ab_at)) 'I merged it' message(s) later, none naming B-2"; fi
}

# scenario (c): a fix round that changes only a test file does not run SECURITY again. F-1 touches three files (tier full: SECURITY is required);
# after CODE_DONE the user asks for one more test case. The evidence is the gate records of the run and the hashes of the files.
fx_hash() { for fx_p in src/total.js src/total-format.js tests/total.test.js; do printf '%s ' "$(git hash-object "$P/$fx_p" 2>/dev/null || echo missing)"; done; }
fx_codedone() { A digest F-1 2>/dev/null | grep -q 'CODE_DONE'; }
fx_fixed() { [ "$(gcount F-1 VERIFY)" -ge 2 ] && fx_codedone; }
# shellcheck disable=SC2016
a200_fix() {
  fx_n='a200 fix round'
  mk_fixture a200f || return 0
  a200_task "$P/.agents/tasks/F-1.md" F-1 'STANDARD — three files, so the full review tier.' 'format a total' \
    'Add `src/total.js` exporting sumList(list), `src/total-format.js` exporting formatTotal(list) (it uses sumList and returns the sum with two decimals) and a test `tests/total.test.js`.' \
    'formatTotal([1, 2]) returns "3.00".' 'tests/total.test.js tests it with node:test and `npm test` passes.'
  git -C "$P" add -A; git -C "$P" commit -q -m 'chore: a200 task'; git -C "$P" push -q origin main
  t0=$(date +%s)
  if ! drive a200-fix-run "/proofline run F-1" 'fx_codedone' "approve plan"; then row "$fx_n (c) test-only fix: SECURITY not re-run" FAIL "$(secs "$t0")" "F-1 did not reach CODE_DONE: $(A next F-1 2>/dev/null | head -n 1)"; return 0; fi
  fx_tier=$(A pipeline F-1 2>/dev/null | sed -n 's/^tier=//p')
  fx_sec1=$(gcount F-1 SECURITY); fx_ver1=$(gcount F-1 VERIFY); fx_h1=$(fx_hash)
  if [ "$fx_tier" != full ] || [ "$fx_sec1" -lt 1 ]; then row "$fx_n (c) test-only fix: SECURITY not re-run" FAIL "$(secs "$t0")" "scenario invalid: tier=$fx_tier, $fx_sec1 SECURITY record(s) before the fix round"; return 0; fi
  drive a200-fix-round "Fix round for F-1: tests/total.test.js needs one more case (formatTotal([]) returns \"0.00\"). Change ONLY that test file, no product code, reopen F-1 if you must, and run the gates again." 'fx_fixed' "I approve the reopen of F-1" >/dev/null 2>&1 || :
  fx_sec2=$(gcount F-1 SECURITY); fx_ver2=$(gcount F-1 VERIFY); fx_h2=$(fx_hash)
  fx_gate=$(A pipeline F-1 2>/dev/null | sed -n 's/^gate\.SECURITY=//p' | head -n 1)
  if [ "$fx_ver2" -le "$fx_ver1" ]; then row "$fx_n (c) test-only fix: SECURITY not re-run" FAIL "$(secs "$t0")" "the fix round never ran the gates again (VERIFY records $fx_ver1 -> $fx_ver2)"
  elif [ "$(echo "$fx_h1" | cut -d' ' -f1-2)" != "$(echo "$fx_h2" | cut -d' ' -f1-2)" ] || [ "$(echo "$fx_h1" | cut -d' ' -f3)" = "$(echo "$fx_h2" | cut -d' ' -f3)" ]; then row "$fx_n (c) test-only fix: SECURITY not re-run" FAIL "$(secs "$t0")" "scenario invalid: the fix did not change exactly the test file (hashes $fx_h1 -> $fx_h2)"
  elif [ "$fx_sec2" -ne "$fx_sec1" ]; then row "$fx_n (c) test-only fix: SECURITY not re-run" FAIL "$(secs "$t0")" "SECURITY ran again after a test-only fix ($fx_sec1 -> $fx_sec2 records)"
  elif [ "$fx_gate" != pass ]; then row "$fx_n (c) test-only fix: SECURITY not re-run" FAIL "$(secs "$t0")" "gate.SECURITY is '$fx_gate' after the fix round, not the carried pass"
  else row "$fx_n (c) test-only fix: SECURITY not re-run" PASS "$(secs "$t0")" "SECURITY records $fx_sec1 -> $fx_sec2 (gate.SECURITY=$fx_gate), VERIFY $fx_ver1 -> $fx_ver2, only the test file changed"; fi
}

a200_pass() { a200_batch; a200_fix; }

smoke_user_settings=no
if [ "${SMOKE_ONLY:-}" = a200 ]; then a200_pass   # not in the default run: three more real-model flows (a batch of two tasks and a run with a fix round) double its time
else
pass hermetic
if [ "${SMOKE_RTK:-auto}" != no ] && command -v rtk >/dev/null 2>&1; then
  smoke_user_settings=yes
  pass rtk
else row "rtk pass" SKIP 0 "rtk is not installed here; the pass with the user's settings is skipped"; fi
fi
skill_detour_row

printf '\nproofline real-session smoke (model %s, proofline %s)\n' "$model" "$(cat "$repo/.claude-plugin/plugin.json" | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -n 1)"
printf '| step | result | seconds | note |\n|---|---|---|---|\n'
awk -F'\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }' "$rows"
[ "${SMOKE_KEEP:-}" != 1 ] || printf 'kept: %s\n' "$work"
if [ "$fails" -gt 0 ]; then echo "smoke: $fails step(s) FAILED"; exit 1; fi
echo 'smoke: all steps PASS'
