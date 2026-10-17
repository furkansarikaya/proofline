#!/bin/sh
# Proves the llm-wiki fixture built in $1: the valid wiki lints clean (and writes lint-report.md), and each
# planted defect is reported with the right severity.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
command -v node >/dev/null 2>&1 || { echo "selfcheck: node not available, skipped"; exit 0; }
v=$root/skills/llm-wiki/scripts/validate-wiki.mjs
fail() { echo "selfcheck: $*" >&2; exit 1; }
node "$v" "$1/docs/wiki" --root "$1" >/dev/null || fail "the valid wiki was rejected"
grep -Fq 'Errors: 0' "$1/docs/wiki/lint-report.md" || fail "lint-report.md was not written"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
w0=$1
expect() { # <label> <exit code> <message> <edit command>
  rm -rf "$tmp/r"; cp -R "$w0" "$tmp/r"
  (cd "$tmp/r/docs/wiki" && eval "$4")
  rc=0; out=$(node "$v" "$tmp/r/docs/wiki" --root "$tmp/r" 2>&1) || rc=$?
  [ "$rc" -eq "$2" ] || fail "$1: exit $rc, wanted $2: $out"
  printf '%s\n' "$out" | grep -Fq -- "$3" || fail "$1: expected '$3' in: $out"
}
expect "missing source" 1 "missing source metadata: docs/wiki/concepts/retry-policy.md" "grep -v '^source: ' concepts/retry-policy.md > t && mv t concepts/retry-policy.md"
expect "dangling source" 1 "nonexistent provenance source: docs/wiki/entities/job-queue.md" "sed 's|^source: .*|source: docs/design/GONE.md|' entities/job-queue.md > t && mv t entities/job-queue.md"
expect "invalid status" 1 "invalid status done" "sed 's/^status: current/status: done/' concepts/retry-policy.md > t && mv t concepts/retry-policy.md"
expect "contradicted" 1 "contradicted page lacks contradicts" "sed 's/^status: accepted/status: contradicted/' decisions/use-backoff.md > t && mv t decisions/use-backoff.md"
expect "duplicate title" 1 "duplicate title: job-queue" "sed 's/^title: .*/title: job-queue/' lessons/validate-before-enqueue.md > t && mv t lessons/validate-before-enqueue.md"
expect "broken wikilink" 1 "broken wikilink: [[nope]]" "printf 'See [[nope]].\n' >> concepts/retry-policy.md"
expect "orphan" 0 "possible orphan page: docs/wiki/lessons/loose.md" "sed 's/^title: .*/title: loose/' lessons/validate-before-enqueue.md > lessons/loose.md"
