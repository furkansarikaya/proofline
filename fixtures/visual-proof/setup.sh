#!/bin/sh
# Builds the visual-proof fixture in $1 (must be empty or absent): the static orders app (app/: index.html,
# styles.css, app.js; no framework, no build), its UI spec (spec.md) and the measurement config (visual.json)
# whose base_url points at the built app/ folder. No network, no installs.
set -eu

[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
TARGET=$1
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $TARGET" >&2
  exit 1
fi
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$TARGET/app"
TARGET=$(cd "$TARGET" && pwd -P)
cp "$here/app/index.html" "$here/app/log.html" "$here/app/styles.css" "$here/app/app.js" "$TARGET/app/"
cp "$here/spec.md" "$TARGET/spec.md"
# The config names the app by an absolute file: URL; the placeholder keeps the committed copy machine-independent.
awk -v root="$TARGET" '{ gsub(/\/FIXTURE_ROOT/, root); print }' "$here/visual.json" > "$TARGET/visual.json"
