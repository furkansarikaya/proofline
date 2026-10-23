#!/bin/sh
# Design library sync (A170): keeps skills/ui-design/library/ byte-identical to the pinned sources listed in
# skills/ui-design/library/THIRD_PARTY_NOTICES.md. Sources, pins, paths and file names are read from that file.
# Usage: sh tests/ci/sync-design-library.sh                       re-fetch every source at its pin, rewrite copies and notices
#        sh tests/ci/sync-design-library.sh --update <id> <sha>   move one source's pin, then re-fetch it
#        sh tests/ci/sync-design-library.sh --check               fail when a copy, hash or licence text differs from its pin
# DESIGN_LIBRARY_MIRROR=<dir> reads <dir>/<source-id>/<path-in-source> instead of the network (tests).
# Prints failures and one summary line. Exit 0 ok, 1 mismatch or fetch failure, 2 usage error.
# shellcheck disable=SC2016
set -eu
root=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
lib=$root/skills/ui-design/library
notices=$lib/THIRD_PARTY_NOTICES.md
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
die() { printf 'sync-design-library: %s\n' "$*" >&2; exit "${2:-1}"; }

[ -f "$notices" ] || die "missing $notices"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
ids() { sed -n 's/^- \(source-[0-9][0-9]*\) | .*/\1/p' "$notices"; }
# field <id> <Key>: the value of "- Key: value" inside the section "## <id>"
field() {
  awk -v id="$1" -v key="$2" '
    /^## / { on = ($2 == id) }
    on && index($0, "- " key ": ") == 1 { print substr($0, length(key) + 5); exit }' "$notices"
}
files() {
  awk -v id="$1" '
    /^## / { on = ($2 == id) }
    on && /^  - `[^`]+` sha256 / { s = $0; sub(/^  - `/, "", s); sub(/`.*/, "", s); print s }' "$notices"
}
recorded() {
  awk -v id="$1" -v f="$2" '
    /^## / { on = ($2 == id) }
    on && index($0, "  - `" f "` sha256 ") == 1 { print $NF; exit }' "$notices"
}
licence_text() {
  awk -v id="$1" '
    /^## / { on = ($2 == id); fence = 0; next }
    on && /^```text$/ { fence = 1; next }
    on && fence && /^```$/ { exit }
    on && fence { print }' "$notices"
}

# fetch <id> <path-in-source> <dest>
fetch() {
  if [ -n "${DESIGN_LIBRARY_MIRROR:-}" ]; then
    cp "$DESIGN_LIBRARY_MIRROR/$1/$2" "$3" 2>/dev/null
  else
    repo=$(field "$1" Repository); commit=$(field "$1" Commit)
    raw=$(printf '%s' "$repo" | sed 's#^https://github.com/#https://raw.githubusercontent.com/#')
    curl -sfL --max-time 60 "$raw/$commit/$2" -o "$3"
  fi
}

mode=sync
upd_id=''; upd_sha=''
case ${1:-} in
  '') ;;
  --check) mode=check ;;
  --update)
    [ $# -eq 3 ] || die "usage: --update <source-id> <commit>" 2
    upd_id=$2; upd_sha=$3
    printf '%s' "$upd_sha" | grep -Eq '^[0-9a-f]{40}$' || die "commit must be a full 40-character sha" 2
    ids | grep -qx "$upd_id" || die "unknown source id: $upd_id" 2
    mode=update ;;
  -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
  *) die "unknown argument: $1" 2 ;;
esac
[ $# -le 1 ] || [ "$mode" = update ] || die "too many arguments" 2

bad=0
total=0
fail() { printf 'FAIL %s\n' "$*"; bad=$((bad + 1)); }

if [ "$mode" = update ]; then
  # move the pin in place; the hashes are rewritten below
  awk -v id="$upd_id" -v sha="$upd_sha" '
    /^## / { on = ($2 == id) }
    on && index($0, "- Commit: ") == 1 { print "- Commit: " sha; next }
    { print }' "$notices" > "$tmp/n" && cat "$tmp/n" > "$notices"
fi

ids_list=$(ids)
[ -n "$ids_list" ] || die "no sources listed in $notices"

if [ "$mode" = check ]; then
  for id in $ids_list; do
    path=$(field "$id" Path); lf=$(field "$id" 'Licence file')
    mkdir -p "$tmp/$id"
    if fetch "$id" "$lf" "$tmp/$id/LICENSE"; then
      licence_text "$id" > "$tmp/$id/notice-licence"
      cmp -s "$tmp/$id/LICENSE" "$tmp/$id/notice-licence" || fail "$id: licence text in the notices differs from the pinned licence file"
    else fail "$id: cannot fetch $lf"; fi
    for f in $(files "$id"); do
      total=$((total + 1))
      if [ ! -f "$lib/$f" ]; then fail "$id: $f is missing from the library"; continue; fi
      if fetch "$id" "$path/$f" "$tmp/$id/$f"; then
        cmp -s "$tmp/$id/$f" "$lib/$f" || fail "$id: $f differs from the pinned source"
      else fail "$id: cannot fetch $path/$f"; fi
      [ "$(sha "$lib/$f")" = "$(recorded "$id" "$f")" ] || fail "$id: $f hash in the notices is stale"
    done
  done
  if [ "$bad" -eq 0 ]; then echo "design library: $total files byte-identical to their pins"; exit 0; fi
  echo "design library: $bad problem(s)"; exit 1
fi

# sync / update: fetch everything first, only then touch the library
for id in $ids_list; do
  [ "$mode" = sync ] || [ "$id" = "$upd_id" ] || continue
  path=$(field "$id" Path); lf=$(field "$id" 'Licence file')
  mkdir -p "$tmp/$id"
  fetch "$id" "$lf" "$tmp/$id/LICENSE" || die "$id: cannot fetch $lf"
  for f in $(files "$id"); do
    fetch "$id" "$path/$f" "$tmp/$id/$f" || die "$id: cannot fetch $path/$f"
  done
done

out=$tmp/notices.new
: > "$out"
# everything before the first source section is kept as it is
awk '/^## source-/ { exit } { print }' "$notices" >> "$out"
first=1
for id in $ids_list; do
  [ "$first" -eq 1 ] || printf '\n' >> "$out"
  first=0
  fetched=0
  { [ "$mode" = sync ] || [ "$id" = "$upd_id" ]; } && fetched=1
  {
    printf '## %s\n\n' "$id"
    printf -- '- Repository: %s\n' "$(field "$id" Repository)"
    printf -- '- Commit: %s\n' "$(field "$id" Commit)"
    printf -- '- Path: %s\n' "$(field "$id" Path)"
    printf -- '- Licence file: %s\n' "$(field "$id" 'Licence file')"
    printf -- '- Files:\n'
    for f in $(files "$id"); do
      if [ "$fetched" -eq 1 ]; then cp "$tmp/$id/$f" "$lib/$f"; total=$((total + 1)); h=$(sha "$tmp/$id/$f")
      else h=$(recorded "$id" "$f"); fi
      printf '  - `%s` sha256 %s\n' "$f" "$h"
    done
    printf '\n### Licence text\n\n```text\n'
    if [ "$fetched" -eq 1 ]; then cat "$tmp/$id/LICENSE"; else licence_text "$id"; fi
    printf '```\n'
  } >> "$out"
done
cat "$out" > "$notices"
echo "design library: synced $total files"
