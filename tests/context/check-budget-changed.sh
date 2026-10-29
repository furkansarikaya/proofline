#!/bin/sh
# Context budget (A202): a pull request that changes tests/context/budget.tsv must say why.
# Input: the changed paths, one per line, on stdin (CI: git diff --name-only --no-renames BASE HEAD).
# The description comes from $PR_BODY, else the file $PR_BODY_FILE, else the pull_request.body field of $GITHUB_EVENT_PATH.
# A run that is not a pull request has no description to check and passes.
# Needed: a line that starts with `Context-budget-change:` followed by a reason of at least 12 characters.
# Exit 0: the budget did not change, or the line is there. Exit 1: changed without the line. Exit 2: usage.
set -u
changed=$(grep -E '^tests/context/budget\.tsv$' || true)
[ -n "$changed" ] || { echo "context budget: tests/context/budget.tsv did not change"; exit 0; }
case "${GITHUB_EVENT_NAME:-pull_request}" in pull_request|pull_request_target) ;; *) echo "context budget: ${GITHUB_EVENT_NAME} is not a pull request; nothing to check"; exit 0 ;; esac

body=''
if [ "${PR_BODY+set}" = set ]; then body=$PR_BODY
elif [ -n "${PR_BODY_FILE:-}" ]; then [ -f "$PR_BODY_FILE" ] || { echo "context budget: PR_BODY_FILE does not exist: $PR_BODY_FILE" >&2; exit 2; }; body=$(cat "$PR_BODY_FILE")
elif [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
  if command -v jq >/dev/null 2>&1; then body=$(jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH") || body=''
  elif command -v node >/dev/null 2>&1; then
    body=$(node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((e.pull_request&&e.pull_request.body)||"")' "$GITHUB_EVENT_PATH") || body=''
  fi
fi

if printf '%s\n' "$body" | tr -d '\r' | grep -Eq '^Context-budget-change:[[:space:]]*[^[:space:]].{11,}$'; then
  echo "context budget: the pull request explains the change of the budget"
  exit 0
fi
echo "context budget: this pull request changes tests/context/budget.tsv, so its description must contain a line" >&2
echo "  Context-budget-change: <why the context budget changed, at least 12 characters>" >&2
exit 1
