#!/bin/sh
# Tests for debt.sh (A153): the shortcut comment list, the one wiki page, and who may run what.
# shellcheck disable=SC2015,SC2016,SC2154 # assertion chains; tl_agents and base come from test-lib.sh
# shellcheck source-path=SCRIPTDIR source=test-lib.sh
. "$(dirname "$0")/test-lib.sh"
new_repo
cp "$tl_agents/scripts/debt.sh" .agents/scripts/
D() { sh ./.agents/scripts/agent.sh debt "$@"; }

# no shortcut yet: the zero case, with and without a wiki
[ "$(D)" = "shortcut debt: none" ] || die "zero case printed: $(D)"
ok "list: no shortcut comments prints none"

mkdir -p src docs/wiki/concepts docs
printf '# shortcut: single process, split when load grows\nx=1\n' > src/a.sh
printf 'int a; // shortcut: linear scan; index it past 1k rows\n/* shortcut: no retry, add one when the API flakes */\n' > src/b.c
printf 'select 1; -- shortcut: full table read, add an index\n' > src/q.sql
printf '<!-- shortcut: inline style, move to the stylesheet -->\n' > src/p.html
printf 'y = 2  # shortcut: no separator here\n' > src/c.py
printf '# shortcut: in markdown, ignored\n' > NOTES.md
mkdir -p .agents/x; printf '# shortcut: in the control plane, ignored\n' > .agents/x/t.sh
printf '# shortcut: in the wiki, ignored\n' > docs/wiki/concepts/other.txt
out=$(D)
printf '%s\n' "$out" | head -1 | grep -qx 'shortcut debt: 6' || die "count wrong: $out"
for want in 'src/a.sh:1 | single process | split when load grows' \
  'src/b.c:1 | linear scan | index it past 1k rows' \
  'src/b.c:2 | no retry | add one when the API flakes' \
  'src/q.sql:1 | full table read | add an index' \
  'src/p.html:1 | inline style | move to the stylesheet' \
  'src/c.py:1 | no separator here | (not stated)'; do
  printf '%s\n' "$out" | grep -Fqx -- "$want" || die "missing line: $want in: $out"
done
printf '%s\n' "$out" | grep -q 'NOTES.md\|\.agents\|wiki' && die "excluded path listed: $out"
ok "list: # // /* */ -- <!-- comments with file:line, limit and condition; md, .agents and wiki excluded; (not stated)"

# page: collected into the one wiki page; a removed shortcut drops off it
p=docs/wiki/concepts/shortcut-debt.md
D page > /dev/null || die "page failed"
grep -Fq '`src/q.sql:1` | full table read | add an index' "$p" && grep -Fq '`src/a.sh:1`' "$p" || die "page lacks rows: $(cat "$p")"
printf 'select 1;\n' > src/q.sql
D page > /dev/null
grep -q 'q.sql' "$p" && die "a removed shortcut stayed on the page"
grep -Fq '`src/a.sh:1`' "$p" || die "the other rows vanished"
ok "page: rows collected, a removed shortcut drops off"

# every shortcut removed: the existing page says so instead of keeping stale rows
rm -f src/a.sh src/b.c src/p.html src/c.py
D page > /dev/null
grep -q 'No shortcut comments' "$p" && ! grep -q '^| `' "$p" || die "stale page: $(cat "$p")"
ok "page: with every shortcut gone the page is rewritten empty"

# no wiki: nothing written
rm -rf docs/wiki; printf '# shortcut: x, y\n' > src/z.sh
D page | grep -q 'no wiki' || die "no-wiki message missing"
[ ! -e docs/wiki ] || die "page created a wiki"
ok "page: no wiki is a no-op"

# roles: page is lead-only, list works for every role and without a run
mkdir -p docs/wiki
for r in implementer reviewer qa verifier explorer; do
  env AGENT_ROLE=$r sh ./.agents/scripts/agent.sh debt > /dev/null || die "list refused for $r"
  env AGENT_ROLE=$r sh ./.agents/scripts/agent.sh debt page > /dev/null 2>&1 && die "page allowed for $r"
done
[ ! -e "$p" ] || die "a refused page wrote the page"
[ -z "$(find .agents/runs -mindepth 1 2>/dev/null)" ] || die "debt created a run"
D page > /dev/null && [ -f "$p" ] || die "lead page failed"
ok "page: lead only; list works for every role with no run"

# A162: the five comments that used to carry a foreign label are listed as shortcut entries of this repository, and none is left
real=$(CDPATH='' cd "$tl_agents/../.." && pwd)
if [ -f "$real/bin/lib/discover.sh" ] && git -C "$real" rev-parse --show-toplevel >/dev/null 2>&1; then
  out=$(sh "$tl_agents/scripts/debt.sh" list) || die "debt list failed in the repository"
  for want in 'bin/lib/config.sh:61 | ' 'bin/lib/discover.sh:156 | ' 'skills/data-design/scripts/classify-migration.mjs:70 | ' \
    'skills/data-design/scripts/classify-migration.mjs:298 | ' 'skills/test-trust/scripts/validate-findings.mjs:16 | '; do
    printf '%s\n' "$out" | grep -F -- "$want" | grep -vq '(not stated)$' || die "debt does not list a converted shortcut with a stated condition: $want"
  done
  tag=pony; tag=${tag}tail   # spelled in two parts so this file is not a hit itself
  git -C "$real" grep -n -I -i -E -e "(#|//|--|/\\*|;|\\*)[[:space:]]*$tag:" -- . ':(exclude)*.md' ':(exclude)tests' ':(exclude).claude' > /dev/null && die "a ponytail comment remains"
  ok "list: the five converted shortcuts of this repository are listed with file:line and a condition; no foreign label remains"
fi
