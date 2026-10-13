#!/bin/sh
# Classifies a pull request's changed paths (one per line on stdin) for CI (A76).
# Prints `code=false` when every path is plain documentation, else `code=true`; an empty list is `code=true`.
# Plain documentation: the root README, CHANGELOG, CONTRIBUTING, SECURITY and LICENSE, and docs/** files ending
# in .md, .png or .svg, except the generated docs/reference/**; any other file under docs/ is code. Markdown under skills/, roles/, control-plane/ and adapters/ is code (agents read
# it as instructions), and so is every script wherever it lives.
set -u
n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  n=$((n + 1))
  case "$f" in
    *.sh|*.mjs|*.cjs|*.js|*.yml|*.yaml|*.json) echo code=true; exit 0 ;;
    docs/reference/*) echo code=true; exit 0 ;;
    README.md|CHANGELOG.md|CONTRIBUTING.md|SECURITY.md|LICENSE) ;;
    docs/*.md|docs/*.png|docs/*.svg) ;;
    *) echo code=true; exit 0 ;;
  esac
done
if [ "$n" -eq 0 ]; then echo code=true; else echo code=false; fi
