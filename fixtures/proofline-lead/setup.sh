#!/bin/sh
# shellcheck disable=SC2016 # backticks are literal Markdown in the generated artifacts
# Builds installed throwaway projects stopped mid-run in known states, for the proofline-lead fixture.
#
#   sh setup.sh <target-dir> [state]
#
# Without a state every state is built into <target-dir>/<state>/; with one, that state is built into
# <target-dir> itself. States (run LK-7 in every project):
#   review-rules-fail     COMPLEX, tier full, every gate passes except REVIEW_RULES (fix round 1 not opened)
#   needs-input           STANDARD, the explorer returned NEEDS_INPUT; a question is pending
#   destructive-approval  CRITICAL plan with `destructive: yes`; plan approved, destructive approval missing
#   security-pass-low     COMPLEX, tier full, every gate passes, SECURITY passed with CONFIDENCE: low
#   fix-rounds-exhausted  COMPLEX, tier full, both fix rounds used, REVIEW_RULES fails again
# Everything goes through the real control plane (agent.sh, exec-policy.sh, secret-scan.sh); verdicts enter
# only through `agent.sh record` with the gate role's AGENT_ROLE. Deterministic, offline, installs nothing.
set -eu
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: sh setup.sh <target-dir> [state]" >&2; exit 2; }
HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
CP=$HERE/../../control-plane
STATES="review-rules-fail needs-input destructive-approval security-pass-low fix-rounds-exhausted"
LC_ALL=C; export LC_ALL
GIT_CONFIG_GLOBAL=/dev/null; GIT_CONFIG_NOSYSTEM=1; export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM
GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
unset AGENT_ROLE 2>/dev/null || true
ID=LK-7
D=.agents/runs/$ID

if [ $# -eq 1 ]; then
  for s in $STATES; do sh "$0" "$1/$s" "$s"; done
  exit 0
fi
TARGET=$1 STATE=$2
case " $STATES " in *" $STATE "*) ;; *) echo "unknown state: $STATE (one of: $STATES)" >&2; exit 2 ;; esac
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then echo "error: target directory is not empty: $TARGET" >&2; exit 1; fi
mkdir -p "$TARGET"; cd "$TARGET"

if command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 "$1" | awk '{print $1}'; }; else sha() { sha256sum "$1" | awk '{print $1}'; }; fi
A() { sh ./.agents/scripts/agent.sh "$@"; }
q() { "$@" >/dev/null; }

# --- installed project (the layout `proofline init` writes) ---------------------------------
mkdir -p .agents/scripts .agents/local .agents/tasks src test
cp "$CP/agents/config.yaml" "$CP/agents/roles.conf" "$CP/agents/"*.md .agents/
cp -R "$CP/agents/modes" "$CP/agents/templates" "$CP/agents/roles" "$CP/agents/githooks" .agents/
for f in agent.sh dispatch.sh exec-policy.sh secret-scan.sh runtime-detect.sh; do cp "$CP/agents/scripts/$f" .agents/scripts/; done
chmod +x .agents/scripts/*.sh .agents/githooks/*
cp "$CP/AGENTS.md" "$CP/CLAUDE.md" .
printf '.agents/runs/\n.agents/local/\n' > .gitignore
cat > package.json <<'EOF'
{ "name": "lookup-fixture", "private": true, "type": "module", "scripts": { "test": "node --test" } }
EOF
cat > src/store.js <<'EOF'
export const store = new Map();
EOF
cat > src/lookup.js <<'EOF'
import { store } from "./store.js";

export function lookup(key) {
  return store.get(key);
}
EOF
cat > test/lookup.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { lookup } from "../src/lookup.js";
import { store } from "../src/store.js";

test("lookup returns the stored value", () => {
  store.set("a", 1);
  assert.equal(lookup("a"), 1);
});
EOF
TASKFILE=.agents/tasks/$ID-empty-key-default.md
cat > "$TASKFILE" <<EOF
# $ID empty key default

**Status:** in-progress

lookup("") must return the documented default instead of undefined.
EOF
git init -q
git symbolic-ref HEAD refs/heads/main
git add -A
GIT_AUTHOR_DATE=2026-01-01T10:00:00Z GIT_COMMITTER_DATE=2026-01-01T10:00:00Z git commit -q -m "lookup: initial"
git config core.hooksPath .agents/githooks

# --- run creation (as the lead does it: templates, ACTIVE_RUN, classify, branch, baseline) ----
case "$STATE" in
  needs-input) CLASS=STANDARD AUTONOMY=autonomous ;;
  destructive-approval) CLASS=CRITICAL AUTONOMY=PENDING ;;
  *) CLASS=COMPLEX AUTONOMY=autonomous ;;
esac
mkdir -p "$D"
sed -e "s#<TASK-ID>#$ID#" -e "s#<REPOSITORY-RELATIVE-TASK-FILE.md>#$TASKFILE#" \
    -e "s#^  autonomy: PENDING#  autonomy: $AUTONOMY#" .agents/templates/RUN.yaml > "$D/RUN.yaml"
printf '%s\n' "$ID" > .agents/local/ACTIVE_RUN
cat > "$D/TASK.md" <<EOF
# Task: $ID — empty key default

## Goal

lookup("") returns the documented default value.

## Context

Callers crash on undefined for an empty key.

## Acceptance criteria

- AC-1: lookup("") returns null
- AC-2: lookup of a stored key still returns its value

## Out of scope

- other keys

## Constraints

- none

## Risks

- callers that rely on undefined

## Suggested class

$CLASS — see the run classification

## Verification commands

- \`npm test\`
EOF
q A classify "$ID" "$CLASS"
q A branch "$ID"
q A baseline "$ID"

# --- helpers --------------------------------------------------------------------------------
capture() { # TEXT: a user-prompt capture as the UserPromptSubmit hook writes it
  mkdir -p .agents/local/prompts
  printf '%s' "$1" > .agents/local/cap.txt
  printf '{"session":"fx","time":%s,"sha256":"%s","text":"%s"}\n' "$(( $(date +%s) + 5 ))" "$(sha .agents/local/cap.txt)" "$1" > .agents/local/prompts/fx.json
  rm -f .agents/local/cap.txt
}
grant() { q A request-approval "$ID" "$1"; capture "$2"; q A approve "$ID" "$1"; }
gate_owner() { case "$1" in REVIEW_*) echo reviewer ;; SECURITY) echo security_reviewer ;; QA) echo qa ;; VERIFY) echo verifier ;; esac; }
gate_focus() { case "$1" in REVIEW_SMALL) echo rules+tests ;; REVIEW_PLAN) echo plan ;; REVIEW_RULES) echo rules ;; REVIEW_TESTS) echo tests ;; REVIEW_DATA) echo data ;; esac; }
gate_art() {
  case "$1" in REVIEW_TESTS) echo reviews/test-trust/tests/REPORT.md ;; REVIEW_PLAN) echo reviews/proof-review/plan/REPORT.md ;;
    REVIEW_RULES) echo reviews/proof-review/rules/REPORT.md ;; REVIEW_SMALL) echo reviews/proof-review/small/REPORT.md ;;
    REVIEW_DATA) echo reviews/data-design/REVIEW.md ;;
    SECURITY) echo security/REPORT.md ;; QA) echo QA_REPORT.md ;; VERIFY) echo VERIFY.md ;; esac
}
# result ROLE FOCUS RESULT CONFIDENCE ARTIFACT [ROW...] -> D12 result on stdout (rows "id|severity|path:line|finding|evidence")
result() {
  r_role=$1 r_focus=$2 r_res=$3 r_conf=$4 r_art=$5; shift 5
  printf 'ROLE: %s\nTASK: %s\n' "$r_role" "$ID"
  [ -z "$r_focus" ] || printf 'FOCUS: %s\n' "$r_focus"
  printf 'RESULT: %s\nCONFIDENCE: %s\nFINGERPRINT: %s\nARTIFACT: %s %s\n\n' "$r_res" "$r_conf" "$(A fingerprint "$ID")" "$r_art" "$(sha "$D/$r_art")"
  printf '| id | severity | path:line | finding | evidence |\n|---|---|---|---|---|\n'
  for r_row in "$@"; do printf '| %s |\n' "$(printf '%s' "$r_row" | sed 's/|/ | /g')"; done
}
gate() { # GATE RESULT [CONFIDENCE] [ROW...]
  g_g=$1 g_r=$2 g_c=${3:-high}; shift 2; [ $# -eq 0 ] || shift
  g_a=$(gate_art "$g_g"); mkdir -p "$D/$(dirname "$g_a")"
  printf '# %s report\n\nVerdict: %s\n' "$g_g" "$g_r" > "$D/$g_a"
  result "$(gate_owner "$g_g")" "$(gate_focus "$g_g")" "$g_r" "$g_c" "$g_a" "$@" > .agents/local/result.md
  AGENT_ROLE=$(gate_owner "$g_g") sh ./.agents/scripts/agent.sh record "$ID" --file .agents/local/result.md >/dev/null
  rm -f .agents/local/result.md
}
pass_except() { # GATE...: secret-scan plus a high-confidence PASS for every other required gate
  for p_g in $(A pipeline "$ID" | sed -n 's/^gates=//p'); do
    case " $* " in *" $p_g "*) continue ;; esac
    if [ "$p_g" = SECRETS ]; then q A secret-scan "$ID"; else gate "$p_g" PASS; fi
  done
}
rules_fail() { gate REVIEW_RULES FAIL high "REVIEW_RULES-1|blocking|src/lookup.js:4|empty key returns undefined, AC-1 requires null|traced: lookup('') -> store.get('') -> undefined"; }
worker() { # PHASE RESULT FILE TEXT: one implementer window, as dispatch.sh brackets it
  w_before=$(A window-open "$ID")
  printf '%s\n' "$4" >> "$3"
  w_ef=''; [ "$1" = RED ] && w_ef='expected_failure: lookup("") returns undefined, the new test expects null'
  printf 'command: npm test\ntarget: src/lookup.js,src/store.js,test/lookup.test.js\n%s\n' "$w_ef" | AGENT_ROLE=implementer sh ./.agents/scripts/agent.sh worker-evidence "$ID" "$1" "$2" >/dev/null
  q A window-close "$ID" "$w_before" 0
}
fix_round() { # FILE TEXT: reopen, one FIX window, back to IMPLEMENTED
  q A handoff "$ID" IMPLEMENTING; worker FIX pass "$1" "$2"; q A handoff "$ID" IMPLEMENTED
}

# --- needs-input: discovery stopped on an explorer question -----------------------------------
if [ "$STATE" = needs-input ]; then
  mkdir -p "$D/results"
  printf '# Explorer evidence: %s\n\nState: waiting for the empty-key default.\n' "$ID" > "$D/results/001-explorer.md"
  {
    result explorer '' NEEDS_INPUT medium results/001-explorer.md
    printf '\nQUESTIONS:\n1. Which value must lookup("") return?\n   options: null | empty string | throw\n   recommended: null\n   why: AC-1 and the QA scenarios depend on it\n'
  } > .agents/local/result.md
  AGENT_ROLE=explorer sh ./.agents/scripts/agent.sh record "$ID" --file .agents/local/result.md >/dev/null
  rm -f .agents/local/result.md
  exit 0
fi

# --- planning artifacts (EVIDENCE, PLAN, QA_PLAN) ----------------------------------------------
printf '# Evidence: %s\n\n- E-1 `src/lookup.js:lookup` reads the store directly\n' "$ID" > "$D/EVIDENCE.md"
printf '# QA plan\n\n- QA-1 (AC-1): lookup("") returns null\n- QA-2 (AC-2): a stored key keeps its value\n' > "$D/QA_PLAN.md"
{
  printf '%s\n' '---' 'scope:' '  - path: src/lookup.js' '    criteria: [AC-1, AC-2]' '  - path: src/store.js' '    criteria: [AC-1]' '  - path: test/lookup.test.js' '    criteria: [AC-1, AC-2]'
  [ "$STATE" != destructive-approval ] || printf '%s\n' '  - path: db/migrations/002_drop_legacy_keys.sql' '    new: true' '    criteria: [AC-1]'
  printf '%s\n' '---' "# Plan: $ID" '' '## Architecture' '' '- one storage map; lookup maps a missing empty key to null' ''
  [ "$STATE" != destructive-approval ] || printf '%s\n' '## Data' '' 'destructive: yes' '- drop the legacy_keys table (no backfill, irreversible)' ''
  printf '%s\n' '## Behavior' '' '- AC-1: `src/lookup.js:lookup` returns null for ""' '' '## Tests' '' '- AC-1: `test/lookup.test.js` "empty key"' '' \
    '## Verification commands' '' '- `npm test`' '' '## Dependencies' '' 'none' '' '## Contracts' '' 'none'
} > "$D/PLAN.md"

if [ "$STATE" = destructive-approval ]; then
  grant plan 'I approve the plan'
  exit 0
fi

q A freeze "$ID"
q A handoff "$ID" IMPLEMENTING
worker RED fail test/lookup.test.js 'test("empty key", () => assert.equal(lookup(""), null));'
worker GREEN pass src/lookup.js 'export const EMPTY_DEFAULT = null;'
worker REFACTOR pass src/store.js '// empty key handled in lookup'
q A handoff "$ID" IMPLEMENTED

case "$STATE" in
  review-rules-fail) pass_except REVIEW_RULES; rules_fail ;;
  security-pass-low) pass_except SECURITY; gate SECURITY PASS low ;;
  fix-rounds-exhausted)
    pass_except REVIEW_RULES; rules_fail
    fix_round src/lookup.js '// round 1: map "" to null'
    pass_except VERIFY
    gate VERIFY FAIL high "VERIFY-1|blocking|src/lookup.js:4|AC-1 has no passing test|reproduced: npm test, empty key test fails"
    fix_round src/lookup.js '// round 2: return null before the store read'
    pass_except REVIEW_RULES; rules_fail ;;
esac
