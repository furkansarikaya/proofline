#!/bin/sh
# Core invariants (CONTRIBUTING.md): a pull request that changes a file under tests/invariants/ must say why.
# Input: the changed paths, one per line, on stdin (CI: git diff --name-only --no-renames BASE HEAD).
# The pull request description comes from, in this order: $PR_BODY; the file $PR_BODY_FILE; the pull_request.body field of
# the event payload $GITHUB_EVENT_PATH (read with jq, else node). A run that is not a pull request (a push to main, the
# nightly schedule, GITHUB_EVENT_NAME other than pull_request) has no description to check and passes.
# The description needs a line that starts with `Invariant-test-change:` followed by a reason of at least 12 characters.
# Exit 0: nothing under tests/invariants/ changed, or the line is there. Exit 1: changed without the line. Exit 2: usage.
set -u
changed=$(grep -E '^tests/invariants/' || true)
[ -n "$changed" ] || { echo "invariants: no file under tests/invariants/ changed"; exit 0; }
case "${GITHUB_EVENT_NAME:-pull_request}" in pull_request|pull_request_target) ;; *) echo "invariants: ${GITHUB_EVENT_NAME} is not a pull request; nothing to check"; exit 0 ;; esac

body=''
if [ "${PR_BODY+set}" = set ]; then body=$PR_BODY
elif [ -n "${PR_BODY_FILE:-}" ]; then [ -f "$PR_BODY_FILE" ] || { echo "invariants: PR_BODY_FILE does not exist: $PR_BODY_FILE" >&2; exit 2; }; body=$(cat "$PR_BODY_FILE")
elif [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "$GITHUB_EVENT_PATH" ]; then
  if command -v jq >/dev/null 2>&1; then body=$(jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH") || body=''
  elif command -v node >/dev/null 2>&1; then body=$(node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((e.pull_request&&e.pull_request.body)||"")' "$GITHUB_EVENT_PATH") || body=''
  fi
fi

if printf '%s\n' "$body" | tr -d '\r' | grep -Eq '^Invariant-test-change:[[:space:]]*[^[:space:]].{11,}$'; then
  echo "invariants: the pull request explains the change of tests/invariants/ (a reviewer approves it separately)"
  exit 0
fi
echo "invariants: this pull request changes files under tests/invariants/, so its description must contain a line" >&2
echo "  Invariant-test-change: <why the invariant test changed, at least 12 characters>" >&2
echo "  and the review must approve that change separately (CONTRIBUTING.md, Core invariants). Changed:" >&2
printf '%s\n' "$changed" | sed 's/^/    /' >&2
exit 1
