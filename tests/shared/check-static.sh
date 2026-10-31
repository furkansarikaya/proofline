#!/bin/sh
# Static repository rules that need no test run (A162). CI's static job runs it, also for documentation-only pull requests.
#
# usage: check-static.sh [--root DIR]
#
# 1. Shortcut comments use proofline's own label. A code comment marks a deliberate shortcut as
#    `shortcut: <limit>, <when to improve>` (read by `proofline debt`); a comment that carries another tool's label
#    (FOREIGN_TAGS) anywhere in its comment part is a failure. Markdown (docs, decisions, CHANGELOG), tests/ and .claude/ are not scanned: they
#    may quote a tag. To forbid one more label, add it to FOREIGN_TAGS.
# 2. README.md says what proofline is and how to use it; detail belongs in docs/concepts. It may not grow past
#    README_MAX_LINES lines or README_MAX_BYTES bytes (the slimmed size plus about 10 percent). Raise a bound only
#    together with a decision that says why the README needs the room.
# 3. No third-party project name outside the notices file (A170). The names are read from the header list of
#    skills/ui-design/library/THIRD_PARTY_NOTICES.md (lines `- <id> | <name> | <url>`), never hardcoded here. Every tracked
#    or untracked file except that notices file and .claude/ is scanned, case-insensitively. Without a notices file the rule passes.
#
# 4. Captured tool output in tests/skills/fixtures/tdd-proof-output holds no personal path: /Users/, /home/<name>/... (a
#    bare /home/user is allowed), /private/var, /var/folders, /opt/homebrew or C:\Users. Redact such a path to /work/... when a fixture is added.
#
# 5. No ecosystem branching in shared shell scripts (A187). proofline writes no ecosystem-specific code: what an ecosystem
#    is and how it builds, tests, lints and lists workspace members is data in control-plane/agents/ecosystems.json. A line of
#    bin/, control-plane/agents/ (scripts, githooks, task-integrations), adapters/ or skills/*/scripts shell scripts that
#    branches on an ecosystem id (a case label such as `go)` or `npm|pnpm)`, or a comparison such as `[ "$x" = dotnet ]`) fails.
#    The ids are read from ecosystems.tsv, never hardcoded here. Excluded: platform.sh (platform adapter), ecosystems.sh (the
#    reader of the data), the self-tests (*-test.sh, test-lib.sh, tests/) and comment lines. A line that names an interpreter or
#    a tool and not an ecosystem (a process-group method, an interpreter whose inline code a safety hook reads) may be marked
#    by a comment line directly above it: `# eco-ok: <why this is not ecosystem knowledge>`. A line that names a plain manifest, project
#    or lock file of an ecosystem (`package.json`, `go.mod`, `Cargo.lock`, ... read from ecosystems.tsv) is the same kind of knowledge and fails too.
#
# Prints PASS or FAIL per rule. Exit 0 when every rule passes, 1 on a failure, 2 on a usage error.
FOREIGN_TAGS='ponytail'
README_MAX_LINES=158
README_MAX_BYTES=12340

root=$(cd "$(dirname "$0")/../.." && pwd)
while [ $# -gt 0 ]; do
  case $1 in
    --root)
      [ $# -ge 2 ] || { echo "check-static: --root needs a directory" >&2; exit 2; }
      root=$(cd "$2" 2>/dev/null && pwd) || { echo "check-static: no such directory: $2" >&2; exit 2; }
      shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "check-static: unknown argument: $1" >&2; exit 2 ;;
  esac
done
status=0

# 1. foreign shortcut labels in code comments
alt=$(printf '%s' "$FOREIGN_TAGS" | tr -s ' ,' '||')
# A comment prefix (# // -- /* <!-- ; % (* or a line that starts with ' or *) followed by the tag anywhere after other
# comment text (`# TODO ponytail: x`), or a bare line that starts with the tag (a block comment's continuation line).
pat="(#|//|--|/\\*|<!--|;|%|\\(\\*|^[[:space:]]*['*]).*(^|[^A-Za-z0-9_])($alt):|^[[:space:]]*($alt):"
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

# 3. third-party names
nf=skills/ui-design/library/THIRD_PARTY_NOTICES.md
names=''
[ -f "$root/$nf" ] && names=$(sed -n 's/^- source-[0-9][0-9]* | \([^|]*[^ |]\) *|.*/\1/p' "$root/$nf")
if [ -z "$names" ]; then echo "PASS third-party names (no notices file or no names listed)"
else
  # variants: case, hyphens, underscores and spaces are ignored (a hyphenated name also matches its joined spelling)
  re=''
  for n in $names; do
    v=$(printf '%s' "$n" | tr -d ' _-' | sed 's/./&[-_ ]*/g; s/\[-_ \]\*$//')
    re="${re:+$re|}$v"
  done
  # the byte-identical data copies listed in the notices file carry the sources' own strings and are skipped
  # shellcheck disable=SC2016
  copies=$(sed -n 's/^  - `\([^`]*\)` sha256 .*/\1/p' "$root/$nf")
  set --
  for c in $copies; do set -- "$@" ":(exclude)skills/ui-design/library/$c"; done
  if git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1; then
    hits=$(git -C "$root" grep -n -I -i -E --untracked --exclude-standard -e "$re" -- . ":(exclude)$nf" ':(exclude).claude' "$@" 2>/dev/null)
  else
    hits=$(cd "$root" && grep -rn -I -i -E -e "$re" --exclude-dir=.claude --exclude-dir=.git . 2>/dev/null | grep -v "^\./$nf:")
    for c in $copies; do hits=$(printf '%s\n' "$hits" | grep -v "^\./skills/ui-design/library/$c:"); done
    hits=$(printf '%s\n' "$hits" | sed '/^$/d')
  fi
  if [ -z "$hits" ]; then echo "PASS third-party names (none outside the notices file and its listed copies)"
  else
    echo "FAIL third-party names: a source name (any spelling) from the notices file appears outside it; refer to 'source N' instead"
    printf '%s\n' "$hits" | cut -c1-200 | sed 's/^/  /'
    status=1
  fi
fi
# 4. personal paths in captured tool output
fx=tests/skills/fixtures/tdd-proof-output
if [ -d "$root/$fx" ]; then
  hits=$(grep -rnE -e '/Users/|/home/[A-Za-z0-9._-]+/|/private/var|/var/folders|/opt/homebrew|C:\\Users' "$root/$fx" 2>/dev/null | sed "s|^$root/||")
  if [ -z "$hits" ]; then echo "PASS no personal paths in $fx"
  else
    echo "FAIL personal paths in $fx: write /work/... instead of a real home directory, checkout or Homebrew path"
    printf '%s\n' "$hits" | cut -c1-200 | sed 's/^/  /'
    status=1
  fi
fi
# 5. ecosystem branching in shared shell scripts
etsv=$root/control-plane/agents/ecosystems.tsv
ids=''
[ -f "$etsv" ] && ids=$(awk -F'\t' '$1 != "*" && $2 == "id" { print $3 }' "$etsv" | paste -sd'|' -)
if [ -z "$ids" ]; then
  # the rule needs the ecosystem definition to know the ids: a missing or empty table is a failure, never a pass
  echo "FAIL ecosystem branching: no ecosystem ids (control-plane/agents/ecosystems.tsv is missing or lists none), so the rule can not run"
  status=1
else
  # bracket expressions instead of backslashes: the same regex works in every awk and grep
  # a case arm: the line, `;;` or ` in ` starts a pattern list (no spaces inside) in which one pattern is exactly an id
  lbl="(^[[:space:]]*|;;[[:space:]]*|[[:space:]]in[[:space:]]+)[(]?([^][:space:]()|]+[|])*[\"']?($ids)[\"']?([|][^][:space:]()]+)*[)]"
  # a test: `[ "$x" = go ]`, `[ x != go ] && ...`
  cmp="[[:space:]](=|==|!=)[[:space:]]+[\"']?($ids)[\"']?([[:space:]]*([]]|;|&|[|]|[)])|[[:space:]]*\$)"
  # a plain file name (no glob, no /) that ecosystems.json lists as a manifest, project file or lock: a word in code, not part of a longer name
  ftoks=$(awk -F'\t' '$1 != "*" && ($2 == "manifests" || $2 == "project_files" || $2 == "locks") && $3 !~ /[*?\/]/ { print $3 }' "$etsv" | sort -u | sed 's/[.]/[.]/g' | paste -sd'|' -)
  tok="(^|[^A-Za-z0-9_.-])($ftoks)([^A-Za-z0-9_.-]|\$)"
  if git -C "$root" rev-parse --show-toplevel >/dev/null 2>&1; then
    list=$(git -C "$root" ls-files --cached --others --exclude-standard -- bin control-plane adapters skills 2>/dev/null)
  else
    list=$(cd "$root" && find bin control-plane adapters skills -type f 2>/dev/null | sed 's|^\./||')
  fi
  hits=''
  for f in $list; do
    case $f in
      */fixtures/*|*/templates/*|*/library/*|*-test.sh|*/test-lib.sh|*/platform.sh|*/ecosystems.sh|*.md|*.json|*.toml|*.tsv|*.mjs|*.yaml|*.yml|*.conf) continue ;; esac
    case $f in skills/*) case $f in skills/*/scripts/*) ;; *) continue ;; esac ;; esac
    [ -f "$root/$f" ] || continue
    case $f in *.sh) ;; *) head -n 1 "$root/$f" | grep -Eq '^#!.*(sh|bash)' || continue ;; esac
    h=$(LBL=$lbl CMP=$cmp TOK=$tok awk -v f="$f" '
      BEGIN { lbl = ENVIRON["LBL"]; cmp = ENVIRON["CMP"]; tok = ENVIRON["TOK"] }
      { l = $0; sub(/^[ \t]+/, "", l)
        if (l ~ /^#/) { ok = (l ~ /^# eco-ok:/); next }
        if (!ok && ($0 ~ lbl || $0 ~ cmp || $0 ~ tok)) print f ":" NR ": " $0
        ok = 0 }' "$root/$f")
    [ -z "$h" ] || hits="$hits
$h"
  done
  hits=$(printf '%s\n' "$hits" | sed '/^$/d')
  if [ -z "$hits" ]; then echo "PASS no ecosystem branching in shared shell scripts (ids: $ids)"
  else
    echo "FAIL ecosystem branching in shared scripts: move the knowledge into control-plane/agents/ecosystems.json as data (A187)"
    printf '%s\n' "$hits" | cut -c1-200 | sed 's/^/  /'
    status=1
  fi
fi
exit $status
