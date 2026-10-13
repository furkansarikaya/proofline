#!/bin/sh
# Compares `agent.sh pipeline RS-1` of the fixture built in $1 with the known answer in EXPECTED.md (A78).
set -eu
HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
cd "$1"
LC_ALL=C; export LC_ALL
want=$(awk '/^## Known answer/ { k = 1; next } k && /^```/ { if (f) exit; f = 1; next } f { print }' "$HERE/EXPECTED.md" | sort)
got=$(sh ./.agents/scripts/agent.sh pipeline RS-1 | grep -E '^(gates|focus\.|signals|signal\.|missing_flag\.|design_role\.)' | sort)
[ -n "$want" ] || { echo "selfcheck: EXPECTED.md has no known answer" >&2; exit 1; }
if [ "$want" != "$got" ]; then
  echo "selfcheck: pipeline output differs from the known answer (- expected, + actual):" >&2
  printf '%s\n' "$want" > known.txt; printf '%s\n' "$got" > actual.txt
  diff known.txt actual.txt | sed -n 's/^</-/p; s/^>/+/p' >&2
  exit 1
fi
echo "selfcheck: risk-signals ok"
