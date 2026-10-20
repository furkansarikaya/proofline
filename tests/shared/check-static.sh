#!/bin/sh
# Static repository rules that need no test run (A162). CI's static job runs it, also for documentation-only pull requests.
#
# usage: check-static.sh [--root DIR]
#
# 1. Shortcut comments use proofline's own label. A code comment marks a deliberate shortcut as
#    `shortcut: <limit>, <when to improve>` (read by `proofline debt`); a comment that carries another tool's label
#    (FOREIGN_TAGS) is a failure. Markdown (docs, decisions, CHANGELOG), tests/ and .claude/ are not scanned: they
#    may quote a tag. To forbid one more label, add it to FOREIGN_TAGS.
# 2. README.md says what proofline is and how to use it; detail belongs in docs/concepts. It may not grow past
#    README_MAX_LINES lines or README_MAX_BYTES bytes (the slimmed size plus about 10 percent). Raise a bound only
#    together with a decision that says why the README needs the room.
#
# Prints PASS or FAIL per rule. Exit 0 when every rule passes, 1 on a failure, 2 on a usage error.
FOREIGN_TAGS='ponytail'
README_MAX_LINES=178
README_MAX_BYTES=12500

root=$(cd "$(dirname "$0")/../.." && pwd)
while [ $# -gt 0 ]; do
  case $1 in
    --root)
      [ $# -ge 2 ] || { echo "check-static: --root needs a directory" >&2; exit 2; }
      root=$(cd "$2" 2>/dev/null && pwd) || { echo "check-static: no such directory: $2" >&2; exit 2; }
      shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "check-static: unknown argument: $1" >&2; exit 2 ;;
  esac
done
status=0

# 1. foreign shortcut labels in code comments
alt=$(printf '%s' "$FOREIGN_TAGS" | tr -s ' ,' '||')
pat="(#|//|--|/\\*|<!--|;|\\*)[[:space:]]*($alt):"
if git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1; then
  hits=$(git -C "$root" grep -n -I -i -E --untracked --exclude-standard -e "$pat" -- . \
    ':(exclude)*.md' ':(exclude)tests' ':(exclude).claude' ':(exclude).agents' 2>/dev/null)
else
  hits=$(cd "$root" && grep -rn -I -i -E -e "$pat" --exclude='*.md' --exclude-dir=tests --exclude-dir=.claude --exclude-dir=.agents --exclude-dir=.git . 2>/dev/null)
fi
if [ -z "$hits" ]; then echo "PASS shortcut labels (none of: $FOREIGN_TAGS)"
else
  echo "FAIL shortcut labels: write \`shortcut: <limit>, <when to improve>\` instead of a foreign label ($FOREIGN_TAGS)"
  printf '%s\n' "$hits" | cut -c1-200 | sed 's/^/  /'
  status=1
fi

# 2. README size
if [ -f "$root/README.md" ]; then
  lines=$(wc -l < "$root/README.md" | tr -d ' '); bytes=$(wc -c < "$root/README.md" | tr -d ' ')
  if [ "$lines" -le "$README_MAX_LINES" ] && [ "$bytes" -le "$README_MAX_BYTES" ]; then
    echo "PASS README size ($lines lines of $README_MAX_LINES, $bytes bytes of $README_MAX_BYTES)"
  else
    echo "FAIL README size: $lines lines (max $README_MAX_LINES), $bytes bytes (max $README_MAX_BYTES); move detail to docs/concepts and link it"
    status=1
  fi
else
  echo "FAIL README size: README.md is missing"; status=1
fi
exit $status
