#!/bin/sh
# Selects, and by default runs, the self-test units affected by a change (A164).
# Usage: tests/affected.sh [--list] [--all] [FILE...]   (no FILE: git changes vs the base branch; "-": paths on stdin)
# Units are suites (control-plane/agents/scripts/*-test.sh, tests/*/*-test.sh) and node files (tests/skills/*.test.mjs).
# The mapping (tests/affected-map.txt) only decides what can be safely skipped: a changed file that is not
# mapped, or is shared, selects every unit. Documentation-only changes (tests/ci/classify.sh) select only
# the front matter and link test. --list prints the units, one per line; otherwise they run quietly.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/.." && pwd)
map=${AFFECTED_MAP:-$here/affected-map.txt}
mode=run all=no files=''
for a in "$@"; do
  case "$a" in
    --list) mode=list ;;
    --all) all=yes ;;
    -) files=$(cat) ;;
    -*) echo "affected: unknown option $a" >&2; exit 2 ;;
    *) files="$files
$a" ;;
  esac
done

cd "$root" || exit 2
if [ -z "$files" ] && [ "$all" = no ]; then
  base=''
  for r in origin/main main; do
    base=$(git merge-base HEAD "$r" 2>/dev/null) && [ -n "$base" ] && break
    base=''
  done
  if [ -n "$base" ]; then
    files=$({ git diff --name-only --no-renames "$base"; git ls-files -o --exclude-standard; } 2>/dev/null)
  elif git rev-parse -q --verify HEAD >/dev/null 2>&1; then
    files=$({ git diff --name-only --no-renames HEAD; git ls-files -o --exclude-standard; } 2>/dev/null)
  else
    all=yes # no history to compare against: uncertain, so everything
  fi
fi

# every unit, as repository-relative paths
units=$(ls control-plane/agents/scripts/*-test.sh tests/*/*-test.sh tests/skills/*.test.mjs 2>/dev/null)
# unit_of NAME: the path of the suite called NAME
unit_of() { printf '%s\n' "$units" | while IFS= read -r u; do [ "$(basename "$u" .sh)" = "$1" ] && echo "$u"; done; }

selected=''
files=$(printf '%s\n' "$files" | sed '/^$/d')
if [ "$all" = yes ]; then
  selected=$units
elif [ -n "$files" ] && [ "$(printf '%s\n' "$files" | sh "$here/ci/classify.sh")" = code=false ]; then
  selected=tests/skills/frontmatter.test.mjs
else
  oldifs=$IFS
  IFS='
'
  for f in $files; do
    IFS=$oldifs
    case "$f" in
      *-test.sh|tests/skills/*.test.mjs)
        if printf '%s\n' "$units" | grep -qxF "$f"; then selected="$selected
$f"; elif [ -e "$f" ]; then selected=$units; break; fi
        continue ;;
    esac
    hit=''
    while IFS= read -r line; do
      case "$line" in ''|'#'*) continue ;; esac
      # shellcheck disable=SC2086
      set -- $line
      g=$1; shift
      # shellcheck disable=SC2254
      case "$f" in $g) hit=yes; for n in "$@"; do selected="$selected
$(unit_of "$n")"; done ;; esac
    done < "$map"
    if [ -z "$hit" ]; then selected=$units; break; fi
    IFS='
'
  done
  IFS=$oldifs
fi
selected=$(printf '%s\n' "$selected" | sed '/^$/d' | sort -u)

if [ "$mode" = list ]; then
  [ -z "$selected" ] || printf '%s\n' "$selected"
  exit 0
fi
[ -n "$selected" ] || { echo "affected: nothing to run"; exit 0; }

out=$(mktemp -d "${TMPDIR:-/tmp}/proofline-affected.XXXXXX") || exit 2
trap 'rm -rf "$out"' EXIT
n=0 failed=0
for u in $selected; do
  n=$((n + 1))
  case "$u" in
    *.mjs) node --test "$u" >"$out/log" 2>&1 ;;
    *) SELFTEST_ONLY=$(basename "$u" .sh) sh tests/selftest.sh >"$out/log" 2>&1 ;;
  esac
  if [ $? -ne 0 ]; then failed=$((failed + 1)); echo "FAIL $u"; tail -n 30 "$out/log"; fi
done
if [ "$failed" -eq 0 ]; then echo "affected: $n units passed"; else echo "affected: $failed of $n units failed"; exit 1; fi
