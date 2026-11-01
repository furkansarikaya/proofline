#!/bin/sh
# Self-test wiring for tests/shared/check-static.sh (A162): the repository itself passes the static rules, and each rule
# breaks on a scratch repository that violates it.
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
chk="$here/check-static.sh"
out=$(sh "$chk" 2>&1) || { printf '%s\n' "$out"; echo "FAIL static rules"; exit 1; }
printf '%s\n' "$out"
die() { echo "FAIL: $*" >&2; exit 1; }
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-static.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT HUP INT TERM
# scratch: a git repository with a README and one code file; $1 names the directory
scratch() {
  mkdir -p "$T/$1/src" && printf '# x\n' > "$T/$1/README.md" && printf 'x=1\n' > "$T/$1/src/a.sh"
  # rule 5 needs the ecosystem table (it fails without it): every scratch repository carries the repository's own
  mkdir -p "$T/$1/control-plane/agents" && cp "$here/../../control-plane/agents/ecosystems.tsv" "$T/$1/control-plane/agents/"
  git -C "$T/$1" init -q && git -C "$T/$1" add -A
}
# foreign shortcut label in a code comment
scratch clean
sh "$chk" --root "$T/clean" > "$T/o" 2>&1 || die "a clean scratch repository failed: $(cat "$T/o")"
grep -q '^PASS shortcut labels' "$T/o" || die "no PASS line for the labels rule"
echo "ok clean repository passes"
scratch bad; printf '// ponytail: x, y\nint a;\n' > "$T/bad/src/b.c"; git -C "$T/bad" add -A
if sh "$chk" --root "$T/bad" > "$T/o" 2>&1; then die "a ponytail comment passed"; fi
{ grep -q '^FAIL shortcut labels' "$T/o" && grep -q 'src/b.c' "$T/o"; } || die "the failure does not name the rule and file: $(cat "$T/o")"
for c in '# ponytail: x' '-- PONYTAIL: x' '/* ponytail: x */'; do
  printf '%s\n' "$c" > "$T/bad/src/b.c"; git -C "$T/bad" add -A
  if sh "$chk" --root "$T/bad" > "$T/o" 2>&1; then die "comment style not caught: $c"; fi
done
echo "ok a foreign label in # // -- /* comments fails (exit 1)"
scratch md; printf 'a ponytail: label is quoted here\n# ponytail: quoted\n' > "$T/md/NOTES.md"; mkdir -p "$T/md/tests"; printf '# ponytail: fixture\n' > "$T/md/tests/t.sh"
git -C "$T/md" add -A
sh "$chk" --root "$T/md" > "$T/o" 2>&1 || die "Markdown or tests/ quoting the label failed: $(cat "$T/o")"
echo "ok markdown and tests/ may quote the label"
# A162: the tag anywhere after a comment prefix, a bare continuation line, and the prefixes % (* ' *
n=0
for c in '# TODO ponytail: x' '// note: see ponytail: x' '/*
 ponytail: x
 */' '  ponytail: continued' '% ponytail: x' '(* ponytail: x *)' "' ponytail: x" ' * ponytail: x' 'int a; // fix later ponytail: x'; do
  n=$((n + 1)); scratch "ev$n"; printf '%s\n' "$c" > "$T/ev$n/src/b.txt"; git -C "$T/ev$n" add -A
  if sh "$chk" --root "$T/ev$n" > "$T/o" 2>&1; then die "evasion case $n passed: $c"; fi
  grep -q '^FAIL shortcut labels' "$T/o" || die "evasion case $n: no FAIL line"
done
scratch prose; printf 'ponytail: this prose line starts with the tag\n' > "$T/prose/src/b.txt"; git -C "$T/prose" add -A
if sh "$chk" --root "$T/prose" > /dev/null 2>&1; then die "a prose line starting with the tag passed"; fi
echo "ok evasion forms of a foreign label fail"
# an extra tag from the variable
scratch tag; printf '# kludge: x\n' > "$T/tag/src/b.sh"; git -C "$T/tag" add -A
sh "$chk" --root "$T/tag" > /dev/null 2>&1 || die "an unlisted tag failed"
sed "s/^FOREIGN_TAGS=.*/FOREIGN_TAGS='ponytail kludge'/" "$chk" > "$T/check-ext.sh"
if sh "$T/check-ext.sh" --root "$T/tag" > /dev/null 2>&1; then die "an added FOREIGN_TAGS entry was not enforced"; fi
echo "ok FOREIGN_TAGS is extendable"
# README bounds
lim=$(sed -n 's/^README_MAX_LINES=//p' "$chk"); bytes=$(sed -n 's/^README_MAX_BYTES=//p' "$chk")
cp "$here/../../README.md" "$T/clean/README.md"
sh "$chk" --root "$T/clean" > /dev/null 2>&1 || die "the real README fails in a scratch copy"
cp "$T/clean/README.md" "$T/clean/README.keep"
l=$(wc -l < "$T/clean/README.md" | tr -d ' ')
i=$l; while [ "$i" -le "$lim" ]; do echo "extra line" >> "$T/clean/README.md"; i=$((i + 1)); done
if sh "$chk" --root "$T/clean" > "$T/o" 2>&1; then die "a README past the line bound passed"; fi
grep -q '^FAIL README size' "$T/o" || die "no README FAIL line: $(cat "$T/o")"
cp "$T/clean/README.keep" "$T/clean/README.md"
b=$(wc -c < "$T/clean/README.md" | tr -d ' ')
awk -v n=$((bytes - b + 10)) 'BEGIN { s = sprintf("%" n "s", ""); gsub(/ /, "x", s); print s }' | tr -d '\n' >> "$T/clean/README.md"
[ "$(wc -l < "$T/clean/README.md" | tr -d ' ')" -le "$lim" ] || die "the byte case also exceeds the line bound"
if sh "$chk" --root "$T/clean" > "$T/o" 2>&1; then die "a README past the byte bound passed"; fi
grep -q '^FAIL README size' "$T/o" || die "no README FAIL line for bytes"
rm "$T/clean/README.md"; if sh "$chk" --root "$T/clean" > /dev/null 2>&1; then die "a missing README passed"; fi
echo "ok README beyond the line bound, the byte bound, or missing fails (exit 1)"
# A170: a source name listed in the notices file may appear in the notices file only
scratch names; mkdir -p "$T/names/skills/ui-design/library"
printf '## Sources\n\n- source-1 | acme-widgets | https://example.invalid/acme-widgets\n' > "$T/names/skills/ui-design/library/THIRD_PARTY_NOTICES.md"
git -C "$T/names" add -A
sh "$chk" --root "$T/names" > "$T/o" 2>&1 || die "a name only in the notices file failed: $(cat "$T/o")"
printf 'Inspired by acme-widgets.\n' >> "$T/names/README.md"; git -C "$T/names" add -A
if sh "$chk" --root "$T/names" > "$T/o" 2>&1; then die "a source name in the README passed"; fi
grep -q '^FAIL third-party names' "$T/o" || die "no FAIL line for the name rule: $(cat "$T/o")"
echo "ok a source name outside the notices file fails (exit 1)"
# A174: captured tool output holds no personal path
scratch pp; mkdir -p "$T/pp/tests/skills/fixtures/tdd-proof-output"
printf 'tool: x\n=== OUTPUT ===\n at /work/a.ts and /home/user\n' > "$T/pp/tests/skills/fixtures/tdd-proof-output/ok.txt"
printf 'a bare /home/user and /work/x/y are fine\n' >> "$T/pp/tests/skills/fixtures/tdd-proof-output/ok.txt"
sh "$chk" --root "$T/pp" 2>&1 | grep -q '^PASS no personal paths' || die "a clean fixture failed the personal-path rule"
for pp_bad in '/Users/jane/x' '/home/jane/x' '/home/user/x' '/private/var/folders/ab/T/x' '/var/folders/ab/T/x' '/opt/homebrew/Cellar/go/1.2/libexec' '/opt/homebrew/bin/node' 'C:\Users\jane\x'; do
  printf 'tool: x\n=== OUTPUT ===\n at %s\n' "$pp_bad" > "$T/pp/tests/skills/fixtures/tdd-proof-output/bad.txt"
  sh "$chk" --root "$T/pp" > "$T/o" 2>&1 && die "a fixture with $pp_bad passed"
  grep -q '^FAIL personal paths' "$T/o" || die "no FAIL line for $pp_bad: $(cat "$T/o")"
done
echo "ok a personal path in captured tool output fails (exit 1)"
echo "static-test: all passed"

# A187: a branch on an ecosystem name appended to a COPY of a shared script breaks rule 5; an eco-ok marker above it is accepted
repo=$(CDPATH='' cd "$here/../.." && pwd)
if [ -f "$repo/control-plane/agents/ecosystems.tsv" ]; then
  rm -rf "$T/eco"; mkdir -p "$T/eco/control-plane/agents" "$T/eco/bin/lib"
  cp "$repo/control-plane/agents/ecosystems.tsv" "$T/eco/control-plane/agents/"; cp "$repo/bin/lib/doctor.sh" "$T/eco/bin/lib/doctor.sh"
  printf '# x\n' > "$T/eco/README.md"
  sh "$chk" --root "$T/eco" > "$T/o" 2>&1 || die "a copy of the shared script fails: $(cat "$T/o")"
  grep -q '^PASS no ecosystem branching' "$T/o" || die "no PASS for rule 5 on a clean copy: $(cat "$T/o")"
  for l in 'case "$x" in go) y=1 ;; esac' '[ "$eco" = dotnet ] && y=1' 'case $e in npm|pnpm) y=1 ;; esac'; do
    cp "$repo/bin/lib/doctor.sh" "$T/eco/bin/lib/doctor.sh"; printf '%s\n' "$l" >> "$T/eco/bin/lib/doctor.sh"
    if sh "$chk" --root "$T/eco" > "$T/o" 2>&1; then die "an ecosystem branch passed rule 5: $l"; fi
    grep -q '^FAIL ecosystem branching' "$T/o" && grep -q 'doctor.sh' "$T/o" || die "rule 5 does not name the file: $(cat "$T/o")"
  done
  cp "$repo/bin/lib/doctor.sh" "$T/eco/bin/lib/doctor.sh"; printf '# eco-ok: an interpreter name, not an ecosystem\ncase "$x" in python) y=1 ;; esac\n' >> "$T/eco/bin/lib/doctor.sh"
  sh "$chk" --root "$T/eco" > "$T/o" 2>&1 || die "an eco-ok marked line failed: $(cat "$T/o")"
  grep -q '^PASS no ecosystem branching' "$T/o" || die "eco-ok line not accepted: $(cat "$T/o")"
  echo "ok an ecosystem branch added to a shared script fails the static rule; eco-ok exempts a marked line"
fi
# rule 5 without its ecosystem table fails (it used to pass): a missing table, and a table that lists no ids
rm -rf "$T/noeco"; mkdir -p "$T/noeco/control-plane/agents"; printf '# x\n' > "$T/noeco/README.md"
if sh "$chk" --root "$T/noeco" > "$T/o" 2>&1; then die "rule 5 passed without ecosystems.tsv: $(cat "$T/o")"; fi
grep -q '^FAIL ecosystem branching: no ecosystem ids' "$T/o" || die "rule 5 does not say why it failed without ecosystems.tsv: $(cat "$T/o")"
printf '# no id rows\n' > "$T/noeco/control-plane/agents/ecosystems.tsv"
if sh "$chk" --root "$T/noeco" > "$T/o" 2>&1; then die "rule 5 passed with an ecosystems.tsv that lists no ids: $(cat "$T/o")"; fi
grep -q '^FAIL ecosystem branching: no ecosystem ids' "$T/o" || die "rule 5 failure text: $(cat "$T/o")"
echo "ok rule 5 fails when ecosystems.tsv is missing or lists no ids"
