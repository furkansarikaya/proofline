#!/bin/sh
# Renders docs/reference/skills.md from skills/*/SKILL.md frontmatter (name, description, metadata.version).
# Usage: sh docs/reference/generate-skills.sh [--check]
# shellcheck disable=SC2016
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
out=$root/docs/reference/skills.md
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

{
  echo '<!-- Generated from skills/*/SKILL.md - do not edit. Run docs/reference/generate-skills.sh. -->'
  echo
  echo '# Skills reference'
  echo
  echo 'Generated from `skills/*/SKILL.md` frontmatter. Each skill works on its own (`npx skills add furkansarikaya/proofline --skill <name>`).'
  echo
  echo '| Skill | Description | Version |'
  echo '|---|---|---|'
  for f in "$root"/skills/*/SKILL.md; do
    awk '
      NR == 1 && $0 != "---" { exit }
      NR > 1 && $0 == "---" { exit }
      /^name: /        { name = substr($0, 7) }
      /^description: / { desc = substr($0, 14) }
      /^  version: /   { v = substr($0, 12); gsub(/"/, "", v) }
      END { gsub(/\|/, "\\|", desc); printf "| `%s` | %s | %s |\n", name, desc, v }
    ' "$f"
  done
} > "$tmp"

if [ "${1:-}" = "--check" ]; then
  if cmp -s "$tmp" "$out"; then echo "skills.md in sync"; else echo "docs/reference/skills.md is stale: run sh docs/reference/generate-skills.sh" >&2; exit 1; fi
else
  cp "$tmp" "$out"
fi
