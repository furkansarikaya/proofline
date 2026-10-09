#!/bin/sh
# Which agent runtimes are usable on this machine (D6, D7). Used by dispatch.sh (failover) and doctor.
#
#   runtime-detect.sh                 one line per runtime: <runtime> installed=yes|no path=<p> version=<v>
#   runtime-detect.sh has <runtime>   exit 0 when the runtime's binary is on PATH
#   runtime-detect.sh bin <runtime>   print the binary used for the runtime
#
# Binaries: PROOFLINE_CLAUDE_BIN (default claude), PROOFLINE_CODEX_BIN (default codex). A runtime with a
# dispatch.command_template counts as installed when the template's first word is on PATH.
set -eu
root=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
config=$root/.agents/config.yaml

bin_of() {
  case "$1" in
    claude) printf '%s\n' "${PROOFLINE_CLAUDE_BIN:-claude}" ;;
    codex) printf '%s\n' "${PROOFLINE_CODEX_BIN:-codex}" ;;
    *) [ -f "$config" ] || return 1
       t=$(awk -v rt="$1" '/^dispatch:/ { d = 1; next } /^[^ #]/ { d = 0 } d && /^  command_template:/ { c = 1; next }
         d && /^  [^ ]/ { c = 0 } d && c && $1 == rt ":" { print $2; exit }' "$config")
       [ -n "$t" ] && printf '%s\n' "$t" ;;
  esac
}
has() { b=$(bin_of "$1") && command -v "$b" >/dev/null 2>&1; }

case "${1:-}" in
  has) has "${2:?usage: $0 has <runtime>}" ;;
  bin) bin_of "${2:?usage: $0 bin <runtime>}" ;;
  '')
    for rt in claude codex; do
      if has "$rt"; then
        b=$(bin_of "$rt"); v=$("$b" --version 2>/dev/null | head -1) || v=unknown
        printf '%s installed=yes path=%s version=%s\n' "$rt" "$(command -v "$b")" "${v:-unknown}"
      else printf '%s installed=no path=- version=-\n' "$rt"; fi
    done ;;
  *) echo "usage: $0 [has|bin <runtime>]" >&2; exit 2 ;;
esac
