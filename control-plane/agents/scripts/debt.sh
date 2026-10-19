#!/bin/sh
# Shortcut debt (A153). An implementer marks a deliberate shortcut in code with a comment
#   shortcut: <limit>, <when to improve>
# (any comment marker: # // -- /* <!-- ; *). This script finds them with grep, never with a model. Run through
# `agent.sh debt [op]`.
#   list         (default) one line per shortcut, sorted by file and line: "<file>:<line> | <limit> | <improve when>".
#                Read-only; needs no run. The first line is "shortcut debt: N" (or "shortcut debt: none").
#   page         lead only (knowledge step): rewrite the ONE wiki page docs/wiki/concepts/shortcut-debt.md from
#                the list. A shortcut removed from the code drops off the page. Writes nothing when the project
#                keeps no wiki (docs/wiki/ missing) or when there is no shortcut and no page yet.
# Scanned: files git tracks or would track (untracked, not ignored), except Markdown, .agents/, .claude/ and
# docs/wiki/ (the control plane and the wiki are not the project's code).
# shortcut: the text after "shortcut:" is split at the first ", " or "; " (limit, then improve-when); a comment
# without that separator lists the whole text as the limit and "(not stated)" as the condition. Improve when a
# shortcut needs an owner, a date or a task id.
# shellcheck disable=SC2016 # literal backticks in the page text
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
op=${1:-list}
die() { echo "debt: $*" >&2; exit 1; }
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || die "not a git repository: $root"
page=$top/docs/wiki/concepts/shortcut-debt.md

# rows: "<file>\t<line>\t<limit>\t<improve when>", sorted
rows() {
  git -C "$top" grep -n -I -E --untracked --exclude-standard -e '(#|//|--|/\*|<!--|;|\*)[[:space:]]*shortcut:' -- . \
    ':(exclude)*.md' ':(exclude).agents' ':(exclude).claude' ':(exclude)docs/wiki' 2>/dev/null |
  awk '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    {
      p1 = index($0, ":"); f = substr($0, 1, p1 - 1); rest = substr($0, p1 + 1)
      p2 = index(rest, ":"); ln = substr(rest, 1, p2 - 1); txt = substr(rest, p2 + 1)
      if (!match(txt, /(#|\/\/|--|\/\*|<!--|;|\*)[ \t]*shortcut:/)) next
      t = substr(txt, RSTART + RLENGTH)
      sub(/[ \t]*(\*\/|-->)[ \t]*$/, "", t); t = trim(t)
      lim = t; imp = "(not stated)"
      c = match(t, /[,;] /)
      if (c > 0) { lim = trim(substr(t, 1, c - 1)); imp = trim(substr(t, c + 2)) }
      if (lim == "") lim = "(not stated)"
      gsub(/\t/, " ", lim); gsub(/\t/, " ", imp); gsub(/\t/, " ", f)
      printf "%s\t%08d\t%s\t%s\n", f, ln, lim, imp
    }' | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2n | awk -F '\t' '{ printf "%s\t%d\t%s\t%s\n", $1, $2, $3, $4 }'
}

list() {
  r=$(rows); n=0; [ -z "$r" ] || n=$(printf '%s\n' "$r" | wc -l | tr -d ' ')
  if [ "$n" -eq 0 ]; then echo "shortcut debt: none"; return 0; fi
  echo "shortcut debt: $n"
  printf '%s\n' "$r" | awk -F '\t' '{ printf "%s:%s | %s | %s\n", $1, $2, $3, $4 }'
}

write_page() {
  r=$(rows)
  [ -d "$top/docs/wiki" ] || { echo "no wiki (docs/wiki/): page not written; 'agent.sh debt' lists the shortcuts"; return 0; }
  if [ -z "$r" ] && [ ! -f "$page" ]; then echo "no shortcut comments and no page: nothing to write"; return 0; fi
  mkdir -p "$(dirname "$page")" || die "cannot create $(dirname "$page")"
  tmp=$page.$$
  {
    printf -- '---\ntitle: shortcut-debt\nstatus: current\nsource: .agents/KNOWLEDGE.md\n---\n\n# Shortcut debt\n\n'
    printf 'Written by `agent.sh debt page` from the `shortcut: <limit>, <when to improve>` comments in the code; never edit it by hand. A removed shortcut drops off the page.\n\n'
    if [ -z "$r" ]; then
      printf 'No shortcut comments in the code.\n'
    else
      printf '| Where | Limit | Improve when |\n|---|---|---|\n'
      printf '%s\n' "$r" | awk -F '\t' '{ for (i = 3; i <= 4; i++) gsub(/\|/, "\\|", $i); printf "| `%s:%s` | %s | %s |\n", $1, $2, $3, $4 }'
    fi
  } > "$tmp" || { rm -f "$tmp"; die "cannot write $page"; }
  mv "$tmp" "$page" || { rm -f "$tmp"; die "cannot write $page"; }
  echo "wrote ${page#"$top"/} ($(printf '%s' "$r" | grep -c . || :) shortcut(s)); link it from docs/wiki/index.md if it is not linked yet"
}

case "$op" in
  list) list ;;
  page) case "${AGENT_ROLE:-lead}" in lead) ;; *) die "only the lead runs 'page'" ;; esac; write_page ;;
  *) echo "usage: debt.sh [list|page]" >&2; exit 2 ;;
esac
