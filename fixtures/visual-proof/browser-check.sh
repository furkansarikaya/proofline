#!/bin/sh
# Browser part of the visual-proof fixture: measures the built fixture with skills/visual-proof/scripts/measure.mjs
# and compares the measured failures with the planted facts of EXPECTED.md (exactly those, traps not flagged).
# Main/nightly CI only (.github/workflows/ci.yml); pull requests run the browser-less validator tests.
# No browser on the machine: prints `UNSUPPORTED: <reason>` and exits 0 (the accepted result; never a pass of
# the measurement). Installs nothing.
# Usage: sh fixtures/visual-proof/browser-check.sh [--no-sandbox]
#   --no-sandbox is forwarded to the browser (CI runners whose kernel forbids the browser sandbox; the page is
#   this repository's own static fixture).
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/visual-proof-browser.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

sh "$root/fixtures/visual-proof/setup.sh" "$work/fx"
detect=$(node "$root/skills/visual-proof/scripts/measure.mjs" --detect --repo "$work/fx")
kind=$(printf '%s' "$detect" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).kind))')
if [ "$kind" = none ]; then
  echo "UNSUPPORTED: $(printf '%s' "$detect" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).reason))')"
  exit 0
fi
node "$root/skills/visual-proof/scripts/measure.mjs" --config "$work/fx/visual.json" --out "$work/out" --repo "$work/fx" "$@"
node "$root/fixtures/visual-proof/expect.mjs" "$work/out/report.json" "$work/fx/spec.md"
