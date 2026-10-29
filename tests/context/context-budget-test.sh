#!/bin/sh
# Context budget (A202): the text loaded into every session stays within tests/context/budget.tsv, and no rule left the
# AGENTS.md block without a new place (tests/context/rule-map.tsv). Measurement: bin/lib/context-size.sh.
# Growth is proven on scripted temp copies of the repository; nothing in the repository is edited.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
repo=$(CDPATH='' cd "$here/../.." && pwd)
SZ=$repo/bin/lib/context-size.sh
BUDGET=$here/budget.tsv
T=$(mktemp -d "${TMPDIR:-/tmp}/proofline-context-test.XXXXXX") || exit 1
trap 'rm -rf "$T"' EXIT
fail=0
ok() { printf 'ok %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fail=1; }

# 1. the repository is within its budget
if out=$(sh "$SZ" repo "$repo" check "$BUDGET" 2>&1); then ok 'the repository is within the context budget'
else bad "the repository is above the context budget: $out"; fi

# 2. every moved rule is still at its new place
nr=0 miss=''
while IFS='	' read -r id file frag; do
  case "$id" in ''|'#'*) continue ;; esac
  nr=$((nr + 1))
  if [ ! -f "$repo/$file" ]; then miss="$miss $id(no file $file)"; continue; fi
  hay=$(tr '\n' ' ' < "$repo/$file" | sed 's/  */ /g')
  if ! printf '%s' "$hay" | grep -qF -- "$(printf '%s' "$frag" | sed 's/  */ /g')"; then miss="$miss $id"; fi
done < "$here/rule-map.tsv"
if [ -z "$miss" ] && [ "$nr" -ge 30 ]; then ok "all $nr mapped rules exist at their new place"
else bad "rules missing at their mapped place:${miss:- (the map has only $nr rows)}"; fi

# 3. a project: only the marked block counts, never the user's own text in the same file
P=$T/proj; mkdir -p "$P"
{ printf 'user text before\n'; awk 'BEGIN{print "<!-- proofline:begin -->"} {print} END{print "<!-- proofline:end -->"}' "$repo/control-plane/AGENTS.md"; head -c 9000 /dev/zero | tr '\0' 'u'; echo; } > "$P/AGENTS.md"
want=$(( $(wc -c < "$repo/control-plane/AGENTS.md") + 48 ))
got=$(PL_HOME=$repo sh "$SZ" project "$P" tsv | awk -F'\t' '$1 == "agents_md" { print $2 }')
if [ "$got" = "$want" ]; then ok 'a project counts the proofline block only, not the user text around it'; else bad "project block bytes: want $want, got $got"; fi
tok=$(PL_HOME=$repo sh "$SZ" project "$P" tsv | awk -F'\t' '$1 == "agents_md" { print $3 }')
if [ "$tok" = "$(( (want + 3) / 4 ))" ]; then ok 'tokens are bytes / 4, rounded up'; else bad "tokens: $tok"; fi

# 4. a temp copy of the repository, grown: the budget test breaks
copy() { # DEST
  mkdir -p "$1/control-plane" "$1/adapters/claude"
  cp "$repo/control-plane/AGENTS.md" "$repo/control-plane/CLAUDE.md" "$1/control-plane/"
  cp -R "$repo/roles" "$1/roles"; cp -R "$repo/skills" "$1/skills"
  cp -R "$repo/adapters/claude/agents" "$1/adapters/claude/agents"; cp -R "$repo/adapters/claude/hooks" "$1/adapters/claude/hooks"
}
big() { head -c "$1" /dev/zero | tr '\0' 'x'; }
expect_break() { # DESC ITEM MUTATOR-FILE
  C=$T/copy-$$-$2; rm -rf "$C"; copy "$C"
  printf '\n%s\n' "$(big 5000)" >> "$C/$3"
  out=$(sh "$SZ" repo "$C" check "$BUDGET" 2>&1); rc=$?
  if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q "FAIL $2:"; then ok "$1: the budget test breaks"; else bad "$1: rc=$rc out=$out"; fi
  rm -rf "$C"
}
expect_break 'a big text in the AGENTS.md proofline block' agents_md control-plane/AGENTS.md
expect_break 'a big text in the CLAUDE.md proofline block' claude_md control-plane/CLAUDE.md
expect_break 'a big text in the entry skill' entry_skill skills/proofline/SKILL.md
expect_break 'a big text in an agent file' role.implementer.agent adapters/claude/agents/proofline-implementer.md
expect_break 'a big text in the first skill of a role' role.explorer.skill skills/evidence-map/SKILL.md
# the SessionStart text: grow the quoted template in the hook
C=$T/copy-hook; copy "$C"
sed 's/^\(  ctx SessionStart "proofline installed; \)/\1'"$(big 4000)"' /' "$C/adapters/claude/hooks/proofline-hook.sh" > "$C/h" && cat "$C/h" > "$C/adapters/claude/hooks/proofline-hook.sh"
out=$(sh "$SZ" repo "$C" check "$BUDGET" 2>&1); rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'FAIL session_start:'; then ok 'a big SessionStart text: the budget test breaks'; else bad "session text: rc=$rc out=$out"; fi

# 5. an unmeasured budget line and an unbudgeted item both fail (a budget cannot be dodged by renaming an item)
C=$T/copy-new; copy "$C"; grep -v '^role.qa.agent' "$BUDGET" > "$T/b.tsv"
out=$(sh "$SZ" repo "$C" check "$T/b.tsv" 2>&1); rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'FAIL role.qa.agent: .*no budget line'; then ok 'an item without a budget line fails'; else bad "unbudgeted item: rc=$rc out=$out"; fi
{ cat "$BUDGET"; printf 'role.ghost.agent\t100\n'; } > "$T/b2.tsv"
out=$(sh "$SZ" repo "$C" check "$T/b2.tsv" 2>&1); rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'role.ghost.agent'; then ok 'a budget line for an unmeasured item fails'; else bad "ghost budget: rc=$rc out=$out"; fi

# 6. the report names the lead and every role
rep=$(sh "$SZ" repo "$repo" report)
if printf '%s\n' "$rep" | grep -q 'lead session' && printf '%s\n' "$rep" | grep -q 'implementer (' && printf '%s\n' "$rep" | grep -q 'tokens'; then ok 'the report shows the lead session and each role'; else bad 'report incomplete'; fi

[ "$fail" = 0 ] && echo 'context-budget-test: all passed'
exit "$fail"
