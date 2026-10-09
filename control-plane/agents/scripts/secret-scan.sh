#!/bin/sh
# Secret scan for the SECRETS gate (D14). Never prints a secret value.
#
#   secret-scan.sh [--root DIR] <path>...      (paths relative to DIR, default: the project root)
#
# Config `commands.secret_scan` set: that command runs from DIR with the paths appended and decides
# (its exit 0 -> clean, 1 -> found, anything else -> error). Otherwise a built-in pattern scan runs over
# the given files (directories recursively, .git skipped, binary files skipped) and prints one
# `path:line:rule` per finding. A line containing `proofline:allow-secret` is never reported.
# Exit: 0 clean | 1 secrets found | 2 error.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
dir=$(CDPATH='' cd "$here/../.." && pwd)
[ "${1:-}" = --root ] && { dir=${2:?usage: $0 [--root DIR] <path>...}; shift 2; }
[ $# -gt 0 ] || { echo "usage: $0 [--root DIR] <path>..." >&2; exit 2; }
cd "$dir" 2>/dev/null || { echo "secret-scan: no such directory: $dir" >&2; exit 2; }

cmd=''
[ -f .agents/config.yaml ] && cmd=$(awk '/^commands:/ { c = 1; next } /^[^ #]/ { c = 0 }
  c && /^  secret_scan:/ { v = $0; sub(/^  secret_scan:[[:space:]]*/, "", v); sub(/[[:space:]]+#.*$/, "", v); print v; exit }' .agents/config.yaml)
if [ -n "$cmd" ]; then
  rc=0; sh -c "$cmd \"\$@\"" secret-scan "$@" || rc=$?
  case "$rc" in 0|1) exit "$rc" ;; *) echo "secret-scan: commands.secret_scan failed (exit $rc)" >&2; exit 2 ;; esac
fi

for p in "$@"; do [ -e "$p" ] || { echo "secret-scan: no such path: $p" >&2; exit 2; }; done
out=$(mktemp "${TMPDIR:-/tmp}/secret-scan.XXXXXX"); trap 'rm -f "$out"' EXIT

# rule NAME ERE [i] : grep every file, drop allowlisted lines, keep path:line:rule
rule() {
  find "$@" -name .git -prune -o -type f -exec grep "-HnIE${r_i:-}" -e "$r_re" {} + 2>/dev/null |
    grep -v 'proofline:allow-secret' | awk -v r="$r_name" -F: '{ print $1 ":" $2 ":" r }' >> "$out" || true
}
scan() { r_name=$1 r_re=$2 r_i=${3:-}; shift 3; rule "$@"; }
scan aws_access_key_id '(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}' '' "$@"
scan aws_secret_access_key 'aws_?secret_?access_?key[^=:]{0,20}[=:][[:space:]]*["'"'"']?[A-Za-z0-9/+=]{40}' i "$@"
scan github_token '(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})' '' "$@"
scan gitlab_token 'glpat-[A-Za-z0-9_-]{20,}' '' "$@"
scan slack_token '(xox[abposr]-[A-Za-z0-9-]{10,}|hooks\.slack\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+)' '' "$@"
scan private_key '-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----' '' "$@"
scan jwt 'eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}' '' "$@"

# generic assignment: the quoted value must look random (>= 16 chars, letters and digits, entropy >= 3.5 bits)
find "$@" -name .git -prune -o -type f -exec grep -HnIiE \
  -e '(api[_-]?key|secret|passw(or)?d|token|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*["'"'"']?[[:space:]]*(:=|=|:)[[:space:]]*["'"'"'][^"'"'"'[:space:]]{16,}["'"'"']' {} + 2>/dev/null |
  grep -v 'proofline:allow-secret' | awk -F: '
    { f = $1; l = $2; t = $0; sub(/^[^:]*:[^:]*:/, "", t)
      if (!match(t, /(:=|=|:)[ \t]*["\047][^"\047 \t]+["\047]/)) next
      v = substr(t, RSTART, RLENGTH); sub(/^[^"\047]*["\047]/, "", v); sub(/["\047]$/, "", v)
      if (length(v) < 16 || v ~ /^[$<{%]/ || v !~ /[0-9]/ || v !~ /[A-Za-z]/) next
      split("", cnt); n = length(v); for (i = 1; i <= n; i++) cnt[substr(v, i, 1)]++
      h = 0; for (c in cnt) { q = cnt[c] / n; h -= q * log(q) / log(2) }
      if (h >= 3.5) print f ":" l ":generic_secret" }' >> "$out" || true

# .env files with values (templates such as .env.example are not secrets)
find "$@" -name .git -prune -o -type f \( -name .env -o -name '.env.*' \) ! -name '*.example' ! -name '*.sample' ! -name '*.template' -print 2>/dev/null |
  while IFS= read -r f; do
    grep -nE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=[^[:space:]#]' "$f" | grep -v 'proofline:allow-secret' |
      awk -v f="$f" -F: '{ print f ":" $1 ":env_file" }' >> "$out" || true
  done

[ -s "$out" ] || exit 0
sed 's#^\./##' "$out" | sort -u
exit 1
