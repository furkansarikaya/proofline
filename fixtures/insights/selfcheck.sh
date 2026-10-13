#!/bin/sh
# Proves the known answers (EXPECTED.md) of the insights fixture built in $1, and that the command is read-only.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
PL=$here/../../bin/proofline
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
sig() { find . -path ./.git -prune -o -type f -print | sort | while read -r f; do printf '%s %s\n' "$f" "$(shasum -a 256 "$f" | awk '{print $1}')"; done; }
before=$(sig)
out=$(sh "$PL" insights) || fail "insights failed"
has() { printf '%s\n' "$out" | grep -Eq -- "$1" || { printf '%s\n' "$out" >&2; fail "missing: $1"; }; }
no() { if printf '%s\n' "$out" | grep -Eq -- "$1"; then printf '%s\n' "$out" >&2; fail "unexpected: $1"; fi; }
has '^  RUN-A +done +900s +3 +6000 \(2/3\) +1000 \(2/3\) +1 +4 +1$'
has '^  RUN-B +failed +500s +2 +2000 \(1/2\) +300 \(1/2\) +0 +2 +0$'
has '^  RUN-C +open +n/a +1 +n/a +n/a +0 +n/a +n/a$'
has '^  reviewer +sonnet +3 +300s +3000 \(2/3\) +500 \(2/3\) +1$'
has 'total over 6 dispatch\(es\): duration 700s, tokens in 8000 \(3/6\), tokens out 1300 \(3/6\), retries 1'
has 'total over 2 finished run\(s\): duration 1400s, delegations 6, fix rounds 1'
no '999999'
has 'repeated-finding x3: REVIEW_RULES src/a\.go: Error from Close is ignored'
has 'runs: RUN-A,RUN-B$'
no 'Error from Open is ignored'
no 'Consider a doc comment'
has 'gate-fail x3: REVIEW_RULES'
no 'gate-fail x[0-9]+: SECURITY'
has 'scope x2: '
has 'unsupported x2: .*no benchmark tool in the project'
no 'unsupported x[0-9]+: .*headless browser'
has 'approval x2: plan'
no 'approval x[0-9]+: destructive'
[ "$before" = "$(sig)" ] || fail "insights changed a file"
echo "selfcheck: insights ok"
