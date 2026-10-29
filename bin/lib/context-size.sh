#!/bin/sh
# Context size (A202): the size of the text proofline puts into the model's context without being asked.
# One script, three users: `proofline doctor`, `proofline insights` and the budget test (tests/context/context-budget-test.sh).
# Items: the proofline block of AGENTS.md and CLAUDE.md, the text the SessionStart hook adds, the entry skill, and per role its
# agent file and the first SKILL.md the role reads (the first name of `skills:` in roles/<role>.md). The lead has no agent file:
# its first skill is proofline-lead. Estimated tokens are bytes / 4.
#
# usage: sh context-size.sh <repo|project> <root> [report|tsv|check <budget-file>]
#   repo     <root> is a proofline checkout (control-plane/, adapters/, roles/, skills/)
#   project  <root> is an installed project; a file missing there falls back to the proofline checkout in $PL_HOME
# tsv: name<TAB>bytes<TAB>tokens<TAB>path. check: exit 1 when an item is above its budget (name<TAB>max-bytes) or has none.
set -u
mode=${1:-}; root=${2:-}; cmd=${3:-report}; budget=${4:-}
case "$mode" in repo|project) ;; *) echo "usage: context-size.sh <repo|project> <root> [report|tsv|check <budget-file>]" >&2; exit 2 ;; esac
[ -d "$root" ] || { echo "context-size: no such directory: $root" >&2; exit 2; }
home=${PL_HOME:-$root}

bytes() { wc -c < "$1" | tr -d ' '; }
# row NAME BYTES PATH
row() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$(( ($2 + 3) / 4 ))" "$3"; }
# pick REL_IN_ROOT REL_IN_HOME: the first existing file
pick() { if [ -f "$root/$1" ]; then printf '%s\n' "$root/$1"; elif [ -f "$home/$2" ]; then printf '%s\n' "$home/$2"; fi; }
# block FILE: the bytes of the marked proofline block (a project file), or of the whole file plus its two markers (a repo template)
block_bytes() {
  if grep -qx '<!-- proofline:begin -->' "$1" 2>/dev/null; then
    awk '/^<!-- proofline:begin -->$/ { i = 1 } i { print } /^<!-- proofline:end -->$/ { i = 0 }' "$1" | wc -c | tr -d ' '
  else echo $(( $(bytes "$1") + 48 )); fi
}
first_skill() { sed -n 's/^skills:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$1" | head -n 1; }

rows() {
  if [ "$mode" = repo ]; then
    f_a=$root/control-plane/AGENTS.md; f_c=$root/control-plane/CLAUDE.md; f_h=$root/adapters/claude/hooks/proofline-hook.sh
    f_e=$root/skills/proofline/SKILL.md; d_roles=$root/roles; d_ag=$root/adapters/claude/agents; d_sk=$root/skills
  else
    f_a=$root/AGENTS.md; f_c=$root/CLAUDE.md
    f_h=$(pick .agents/hooks/proofline-hook.sh adapters/claude/hooks/proofline-hook.sh)
    f_e=$(pick .claude/skills/proofline/SKILL.md skills/proofline/SKILL.md)
    d_roles=$root/.agents/roles; d_ag=$root/.claude/agents; d_sk=$root/.agents/skills
    [ -d "$d_roles" ] || d_roles=$home/roles
    [ -d "$d_ag" ] || d_ag=$home/adapters/claude/agents
    [ -d "$d_sk" ] || d_sk=$home/skills
  fi
  [ ! -f "$f_a" ] || row agents_md "$(block_bytes "$f_a")" "$f_a"
  [ ! -f "$f_c" ] || row claude_md "$(block_bytes "$f_c")" "$f_c"
  if [ -n "$f_h" ] && [ -f "$f_h" ]; then
    # the template of the text, placeholders (${skill}, ${act}, ${nxt}) unexpanded
    ss=$(sed -n 's/^  ctx SessionStart "\(.*\)" ;;$/\1/p' "$f_h" | head -n 1)
    row session_start "$(printf '%s' "$ss" | wc -c | tr -d ' ')" "$f_h"
  fi
  [ -z "$f_e" ] || [ ! -f "$f_e" ] || row entry_skill "$(bytes "$f_e")" "$f_e"
  if [ -f "$d_sk/proofline-lead/SKILL.md" ]; then row role.lead.skill "$(bytes "$d_sk/proofline-lead/SKILL.md")" "$d_sk/proofline-lead/SKILL.md"; fi
  for cs_f in "$d_roles"/*.md; do
    [ -f "$cs_f" ] || continue
    cs_r=$(basename "$cs_f" .md)
    [ "$cs_r" != lead ] && [ "$cs_r" != README ] || continue
    cs_a=$d_ag/proofline-$(printf '%s' "$cs_r" | tr _ -).md
    [ ! -f "$cs_a" ] || row "role.$cs_r.agent" "$(bytes "$cs_a")" "$cs_a"
    cs_s=$(first_skill "$cs_f")
    [ -z "$cs_s" ] || [ ! -f "$d_sk/$cs_s/SKILL.md" ] || row "role.$cs_r.skill" "$(bytes "$d_sk/$cs_s/SKILL.md")" "$d_sk/$cs_s/SKILL.md"
  done
}

tmp=$(mktemp "${TMPDIR:-/tmp}/context-size.XXXXXX") || exit 2
trap 'rm -f "$tmp"' EXIT HUP INT TERM
rows > "$tmp"

case "$cmd" in
  tsv) cat "$tmp" ;;
  report)
    awk -F '\t' '
      { b[$1] = $2; t[$1] = $3; names[++n] = $1 }
      function line(label, bytes, tok) { printf "  %-34s %7d bytes  ~%5d tokens\n", label, bytes, tok }
      END {
        common = b["agents_md"] + b["claude_md"]
        print "context loaded without being asked (estimated tokens = bytes / 4):"
        line("AGENTS.md proofline block", b["agents_md"], t["agents_md"])
        line("CLAUDE.md proofline block", b["claude_md"], t["claude_md"])
        line("SessionStart text (template)", b["session_start"], t["session_start"])
        line("entry skill", b["entry_skill"], t["entry_skill"])
        c = common + b["session_start"] + b["entry_skill"] + b["role.lead.skill"]
        line("lead session (all of the above + lead skill)", c, int((c + 3) / 4))
        for (i = 1; i <= n; i++) if (names[i] ~ /^role\..*\.agent$/) {
          r = names[i]; sub(/^role\./, "", r); sub(/\.agent$/, "", r)
          c = common + b["role." r ".agent"] + b["role." r ".skill"]
          line(r " (blocks + agent file + first skill)", c, int((c + 3) / 4))
        }
      }' "$tmp" ;;
  check)
    [ -f "$budget" ] || { echo "context-size: budget file not found: $budget" >&2; exit 2; }
    awk -F '\t' -v bf="$budget" '
      BEGIN { while ((getline l < bf) > 0) { if (l ~ /^#/ || l ~ /^[[:space:]]*$/) continue; split(l, p, "\t"); max[p[1]] = p[2] + 0; seen[p[1]] = 0 } }
      { if (!($1 in max)) { printf "FAIL %s: %d bytes and no budget line (add one to the budget file, with a reason in the PR)\n", $1, $2; bad = 1; next }
        seen[$1] = 1
        if ($2 > max[$1]) { printf "FAIL %s: %d bytes is above its budget of %d (+%d)\n", $1, $2, max[$1], $2 - max[$1]; bad = 1 } }
      END { for (k in max) if (!seen[k]) { printf "FAIL %s: budget line but the item is not measured any more\n", k; bad = 1 } exit bad ? 1 : 0 }' "$tmp" ;;
  *) echo "context-size: unknown command: $cmd" >&2; exit 2 ;;
esac
