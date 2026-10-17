#!/bin/sh
# Builds the explain-html fixture in $1: one good self-contained page (inline SVG, CSS and JS, no external reference).
# Deterministic and offline.
set -eu
[ $# -eq 1 ] || { echo "usage: sh setup.sh <target-dir>" >&2; exit 2; }
if [ -e "$1" ] && [ -n "$(ls -A "$1" 2>/dev/null)" ]; then
  echo "error: target directory is not empty: $1" >&2; exit 1
fi
mkdir -p "$1"
cp "$(dirname "$0")/page.html" "$1/page.html"
