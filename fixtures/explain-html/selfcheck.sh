#!/bin/sh
# Proves the explain-html fixture page passes the skill's own validator, and that an external reference does not.
set -eu
cd "$1"
skill=$(cd "$(dirname "$0")/../../skills/explain-html" && pwd)
node "$skill/scripts/check-html.mjs" page.html | grep -qx '0 finding(s)' || { echo "selfcheck: good page must pass" >&2; exit 1; }
sed 's|</head>|<link rel="stylesheet" href="https://cdn.example/x.css"></head>|' page.html > bad.html
node "$skill/scripts/check-html.mjs" bad.html >/dev/null && { echo "selfcheck: external reference must fail" >&2; exit 1; }
echo "explain-html fixture ok"
