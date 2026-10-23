#!/bin/sh
# Tests for tests/ci/sync-design-library.sh (A170): --check passes against a local mirror built from the repository's own
# library copies (no network), and fails when one mirrored file or the mirrored licence differs. Source ids, paths and file
# names are read from the notices file, never written here.
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
lib=$root/skills/ui-design/library
notices=$lib/THIRD_PARTY_NOTICES.md
die() { echo "FAIL: $*" >&2; exit 1; }
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-sync-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT HUP INT TERM
[ -f "$notices" ] || die "missing $notices"

ids=$(sed -n 's/^- \(source-[0-9][0-9]*\) | .*/\1/p' "$notices")
[ -n "$ids" ] || die "no sources listed in the notices"
for id in $ids; do
  path=$(awk -v id="$id" '/^## /{on=($2==id)} on && index($0,"- Path: ")==1{print substr($0,9);exit}' "$notices")
  lf=$(awk -v id="$id" '/^## /{on=($2==id)} on && index($0,"- Licence file: ")==1{print substr($0,17);exit}' "$notices")
  mkdir -p "$T/mirror/$id/$path"
  awk -v id="$id" '/^## /{on=($2==id);f=0;next} on&&/^```text$/{f=1;next} on&&f&&/^```$/{exit} on&&f{print}' "$notices" > "$T/mirror/$id/$lf"
  # shellcheck disable=SC2013 # file names have no spaces
  for f in $(awk -v id="$id" '/^## /{on=($2==id)} on && /^  - `[^`]+` sha256 /{s=$0;sub(/^  - `/,"",s);sub(/`.*/,"",s);print s}' "$notices"); do
    cp "$lib/$f" "$T/mirror/$id/$path/$f" || die "$f is missing from the library"
  done
done

out=$(DESIGN_LIBRARY_MIRROR=$T/mirror sh "$here/sync-design-library.sh" --check 2>&1) || die "--check failed on an identical mirror: $out"
case $out in *"byte-identical"*) ;; *) die "no summary line: $out" ;; esac
echo "ok --check passes against an identical mirror"

first=$(find "$T/mirror" -type f -name '*.json' | sort | head -n 1)
printf ' ' >> "$first"
if DESIGN_LIBRARY_MIRROR=$T/mirror sh "$here/sync-design-library.sh" --check > "$T/o" 2>&1; then die "--check passed with a changed mirrored file"; fi
grep -q '^FAIL .*differs from the pinned source' "$T/o" || die "the failure does not say which file differs: $(cat "$T/o")"
echo "ok --check fails when a copy differs from its pin"
echo "sync-design-library: ok"
