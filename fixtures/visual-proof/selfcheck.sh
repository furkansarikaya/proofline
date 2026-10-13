#!/bin/sh
# Proves the planted facts of the visual-proof fixture built in $1 without a browser (pull-request CI):
# the planted defects and traps are in the source, the planted contrast ratio is below 4.5:1, and the
# browser-less path (no tooling) produces a valid UNSUPPORTED report, never a pass. The browser measurement
# is fixtures/visual-proof/browser-check.sh (main/nightly CI).
set -eu
cd "$1"
fail() { echo "selfcheck: $*" >&2; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
skill=$root/skills/visual-proof/scripts

# Planted defects.
grep -q '^\.promo-banner { width: 400px;' app/styles.css || fail "fixed-width banner (overflow at 360px) missing"
grep -q '^\.hint { color: #aaaaaa;' app/styles.css || fail "low-contrast hint missing"
grep -q '^#clear-search { width: 16px; height: 16px;' app/styles.css || fail "16px touch target missing"
grep -q '^\.search-row { display: flex; gap: 0;' app/styles.css || fail "the small target must sit against its neighbours (no spacing exception)"
grep -q 'data-state=error' spec.md || fail "spec must define the error state"
grep -q "'error'" app/app.js && fail "app.js must not render the error state"
grep -q '"name": "error"' visual.json || fail "config must measure the error state"
# Traps: intended patterns that must not be reported.
grep -q '^\.carousel { display: flex; gap: 12px; overflow-x: auto;' app/styles.css || fail "scrollable carousel trap missing"
grep -q '^\.skip-link { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0);' app/styles.css || fail "visually hidden skip link trap missing"
grep -q '^\.skip-link:focus { position: static;' app/styles.css || fail "skip link must become visible on focus"
[ "$(grep -o 'class="back"\|<pre class="log"' app/log.html | tr '\n' ' ')" = 'class="back" <pre class="log" class="back" ' ] \
  || fail "log page must be link, scrollable pre, link (focusable-scroller trap)"
grep -q '^\.log { overflow-x: auto;' app/styles.css || fail "log block must scroll horizontally"

# The planted contrast, computed with the WCAG 2.2 formula: #aaaaaa on #ffffff is 2.32:1.
node -e '
const l = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const r = (l("#ffffff") + 0.05) / (l("#aaaaaa") + 0.05);
if (Math.floor(r * 100) / 100 !== 2.32) { console.error("contrast " + r); process.exit(1); }
' || fail "planted contrast is not 2.32:1"

# No tooling: the report is UNSUPPORTED, valid, and every required criterion is unproven.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/visual-proof-selfcheck-XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("visual.json", "utf8"));
fs.writeFileSync(process.argv[1], JSON.stringify({ tool: { kind: "none", name: null, reason: "no Chromium-family browser on PATH; no browser-test dependency in package.json" }, config }));
' "$tmp/raw.json"
node "$skill/measure.mjs" --assemble "$tmp/raw.json" --out "$tmp/out" > "$tmp/assemble.txt" || fail "assemble failed: $(cat "$tmp/assemble.txt")"
node "$skill/validate-visual.mjs" "$tmp/out/report.json" --class COMPLEX > "$tmp/validate.txt" || fail "UNSUPPORTED report invalid: $(cat "$tmp/validate.txt")"
grep -qx 'RESULT: UNSUPPORTED' "$tmp/validate.txt" || fail "no tooling must give RESULT: UNSUPPORTED"
grep -q 'AC-1=unproven AC-2=unproven AC-3=unproven AC-4=unproven' "$tmp/validate.txt" || fail "required criteria must be unproven without tooling"
echo "selfcheck: visual-proof ok (browser measurement: fixtures/visual-proof/browser-check.sh)"
