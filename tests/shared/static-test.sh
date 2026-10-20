#!/bin/sh
# Self-test wiring for tests/shared/check-static.sh (A162): the repository itself passes the static rules.
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
out=$(sh "$here/check-static.sh" 2>&1) || { printf '%s\n' "$out"; echo "FAIL static rules"; exit 1; }
printf '%s\n' "$out"
echo "static-test: all passed"
