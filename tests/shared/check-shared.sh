#!/bin/sh
# Verifies that the shared-rules block of every skill is byte-identical to
# tests/shared/shared-rules.md (D29: no file sharing between skills; a CI check
# keeps the duplicated section from drifting).
#
# usage: check-shared.sh [--root DIR] [skill-name ...]
#   --root DIR   repository root (default: two directories above this script)
#   skill-name   check only these skills; default: every skills/*/SKILL.md that exists
#
# Also: skills/<name>/references/WRITING.md and scripts/check-writing.mjs, when present, equal tests/shared/writing-profile.md and check-writing.mjs.
#
# Block = from the line starting with `<!-- proofline:shared-rules:begin` through the line
# `<!-- proofline:shared-rules:end -->`, both included.
# Prints PASS or FAIL per skill. Exit 0 when every checked skill passes, 1 on drift, a
# missing block or a missing SKILL.md, 2 on a usage error or when there is nothing to check.

root=$(cd "$(dirname "$0")/../.." && pwd)
names=""
while [ $# -gt 0 ]; do
  case $1 in
    --root)
      [ $# -ge 2 ] || { echo "check-shared: --root needs a directory" >&2; exit 2; }
      root=$(cd "$2" 2>/dev/null && pwd) || { echo "check-shared: no such directory: $2" >&2; exit 2; }
      shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) echo "check-shared: unknown option: $1" >&2; exit 2 ;;
    *) names="$names $1"; shift ;;
  esac
done

canon="$root/tests/shared/shared-rules.md"
[ -f "$canon" ] || { echo "check-shared: missing $canon" >&2; exit 2; }

if [ -z "$names" ]; then
  for f in "$root"/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    d=${f%/SKILL.md}
    names="$names ${d##*/}"
  done
fi
[ -n "$names" ] || { echo "check-shared: no skills to check under $root/skills" >&2; exit 2; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/check-shared-XXXXXX") || exit 2
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
status=0
for name in $names; do
  skill="$root/skills/$name/SKILL.md"
  if [ ! -f "$skill" ]; then
    echo "FAIL $name (SKILL.md not found)"; status=1; continue
  fi
  if ! grep -q '^<!-- proofline:shared-rules:begin' "$skill"; then
    echo "FAIL $name (shared-rules block missing)"; status=1; continue
  fi
  sed -n '/^<!-- proofline:shared-rules:begin/,/^<!-- proofline:shared-rules:end -->$/p' "$skill" > "$tmp/block"
  if cmp -s "$tmp/block" "$canon"; then
    echo "PASS $name"
  else
    echo "FAIL $name (shared-rules block differs from tests/shared/shared-rules.md)"; status=1
  fi
done
# Writing-profile copies (A138): a skill that carries the reference or the length check carries the canonical bytes.
for name in $names; do
  for pair in references/WRITING.md:writing-profile.md scripts/check-writing.mjs:check-writing.mjs; do
    f="$root/skills/$name/${pair%%:*}"
    [ -f "$f" ] || continue
    if cmp -s "$f" "$root/tests/shared/${pair##*:}"; then echo "PASS $name ${pair%%:*}"
    else echo "FAIL $name (${pair%%:*} differs from tests/shared/${pair##*:})"; status=1; fi
  done
done
exit $status
