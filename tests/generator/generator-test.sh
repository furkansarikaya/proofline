#!/bin/sh
# shellcheck disable=SC2016,SC2013
# Tests for adapters/generate.sh against fixture roles (tests/generator/fixtures/roles).
# Usage: sh tests/generator/generator-test.sh
set -u
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
GEN=$(dirname "$(dirname "$here")")/adapters/generate.sh
FIX=$here/fixtures/roles
T=$(mktemp -d "${TMPDIR:-/tmp}/gen-test.XXXXXX")
trap 'rm -rf "$T"' EXIT HUP INT TERM
PASS=0
FAIL=0
n=0

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() { # description, command...
  d=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
checkfail() { # description, command... (must exit non-zero)
  d=$1; shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}
has() { grep -qF -- "$2" "$1"; }
newroot() { # -> sets R to a fresh root holding the fixture roles
  n=$((n + 1)); R=$T/root$n; mkdir -p "$R/roles"; cp "$FIX"/*.md "$R/roles/"
}
gen() { sh "$GEN" --root "$R" "$@"; }

# ---- 1. render, lead excluded from agents, present in control-plane and docs
newroot
check "generate all" gen
check "claude agent for reviewer" test -f "$R/adapters/claude/agents/proofline-reviewer.md"
check "claude agent for implementer" test -f "$R/adapters/claude/agents/proofline-implementer.md"
check "lead not a claude agent" test ! -e "$R/adapters/claude/agents/proofline-lead.md"
check "lead not a codex agent" test ! -e "$R/adapters/codex/agents/proofline-lead.toml"
check "lead role text exists" test -f "$R/control-plane/agents/roles/lead.md"
check "lead listed in docs" has "$R/docs/reference/roles.md" '## lead'
check "docs header" has "$R/docs/reference/roles.md" 'Generated from roles/ — do not edit'
check "roles.conf lists lead" has "$R/control-plane/agents/roles.conf" 'lead balanced claude opus medium 2'

# ---- 2. Claude frontmatter conforms to CLAUDE_FORMATS
f=$R/adapters/claude/agents/proofline-reviewer.md
fmkeys=$(awk 'NR==1{next} /^---$/{exit} /^[a-z]+:/{sub(/:.*/,""); print}' "$f" | tr '\n' ' ')
check "claude frontmatter keys" test "$fmkeys" = "name description tools model effort "
check "claude name" has "$f" 'name: proofline-reviewer'
check "claude tools comma list" has "$f" 'tools: Read, Grep, Glob, Bash'
check "claude model default is balanced" has "$f" 'model: sonnet'
check "claude effort balanced" has "$f" 'effort: medium'
dl=$(grep '^description:' "$f" | wc -c)
check "claude description length <= 1000" test "$dl" -le 1010
check "claude description escapes quotes/backslashes" has "$f" 'description: "Reviews a change against the plan. Use when: per tier (D14) | \"quoted\" \\ slash"'
check "claude frontmatter closed" test "$(grep -c '^---$' "$f")" = 2
for m in $(grep -h '^model:' "$R"/adapters/claude/agents/*.md | sed 's/model: //'); do
  case $m in sonnet|opus|haiku|inherit) ;; *) bad "claude model value $m" ;; esac
done

# ---- 3. profile switch changes models
gen --target claude-plugin --profile max >/dev/null
check "profile max claude model" has "$R/adapters/claude/agents/proofline-reviewer.md" 'model: opus'
check "profile max claude effort" has "$R/adapters/claude/agents/proofline-reviewer.md" 'effort: high'
gen --target codex --profile max >/dev/null
check "profile max codex model" has "$R/adapters/codex/agents/proofline-reviewer.toml" 'model = "gpt-x-big"'
gen --target claude-plugin --profile economy >/dev/null
check "profile economy claude model" has "$R/adapters/claude/agents/proofline-reviewer.md" 'model: haiku'
checkfail "bad profile rejected" gen --profile turbo

# ---- 4. {{skill:x}} per target
newroot
gen >/dev/null
check "plugin skill path" has "$R/adapters/claude/agents/proofline-reviewer.md" '${CLAUDE_PLUGIN_ROOT}/skills/proof-review/SKILL.md'
check "codex skill path" has "$R/adapters/codex/agents/proofline-reviewer.toml" '.agents/skills/proof-review/SKILL.md'
check "role text skill path" has "$R/control-plane/agents/roles/reviewer.md" '.agents/skills/test-trust/SKILL.md'
check "role text has no plugin var" test "$(grep -c 'CLAUDE_PLUGIN_ROOT' "$R/control-plane/agents/roles/reviewer.md")" = 0
O=$T/proj1
check "init-style render" sh "$GEN" --root "$R" --out "$O" --profile economy
check "project skill path" has "$O/.claude/agents/proofline-reviewer.md" '.agents/skills/proof-review/SKILL.md'
check "project: no .claude/skills path" test "$(grep -c '\.claude/skills' "$O/.claude/agents/proofline-reviewer.md")" = 0
check "project agent has no plugin var" test "$(grep -c 'CLAUDE_PLUGIN_ROOT' "$O/.claude/agents/proofline-reviewer.md")" = 0
check "project profile applied" has "$O/.claude/agents/proofline-reviewer.md" 'model: haiku'
check "project codex agent" test -f "$O/.codex/agents/proofline-reviewer.toml"
check "project roles.conf" test -f "$O/.agents/roles.conf"
check "project role text" test -f "$O/.agents/roles/lead.md"
check "project owns.conf" has "$O/.agents/owns.conf" 'implementer PRODUCT_SCOPE results/'
check "project tools.conf" has "$O/.agents/tools.conf" 'reviewer Read,Grep,Glob,Bash'
check "project: no docs" test ! -e "$O/docs"
check "project: lead not an agent" test ! -e "$O/.claude/agents/proofline-lead.md"
checkfail "no unreplaced placeholders" grep -rF '{{skill:' "$R/adapters" "$R/control-plane" "$O"
checkfail "claude-plugin needs no --out" sh "$GEN" --root "$R" --out "$T/x" --target claude-plugin
checkfail "claude-project needs --out" gen --target claude-project
# an unrelated agent in the project survives a re-render
printf 'mine\n' > "$O/.claude/agents/custom.md"
sh "$GEN" --root "$R" --out "$O" >/dev/null
check "foreign agent files untouched" test -f "$O/.claude/agents/custom.md"

# ---- 5. TOML structure and escaping
toml_check() { # file: structural checks (and tomllib when the interpreter has it)
  awk '
    /^(name|description|model|model_reasoning_effort|sandbox_mode) = "/ { seen[$1]++; next }
    /^developer_instructions = (\047\047\047|""")$/ { delim = substr($0, length($0) - 2); inblk = 1; next }
    inblk && $0 == delim { inblk = 0; closed++; next }
    inblk && delim == "\"\"\"" { l = $0; gsub(/\\\\/, "", l); gsub(/\\"/, "", l); if (l ~ /"""/ || l ~ /\\/) bad = 1 }
    inblk && delim == "\047\047\047" && index($0, delim) { bad = 1 }
    END {
      if (bad || inblk || closed != 1) exit 1
      split("name description model model_reasoning_effort sandbox_mode", k, " ")
      for (i = 1; i <= 5; i++) if (seen[k[i]] != 1) exit 1
    }' "$1" || return 1
  if python3 -c 'import tomllib' 2>/dev/null; then
    python3 -I -c 'import sys, tomllib
d = tomllib.load(open(sys.argv[1], "rb"))
assert set(d) == {"name","description","developer_instructions","model","model_reasoning_effort","sandbox_mode"}
assert d["developer_instructions"].strip()' "$1" || return 1
  fi
}
roundtrip() { # toml role: developer_instructions decodes to the neutral role body with codex skill paths
  id=$1; t=$R/adapters/codex/agents/proofline-$id.toml
  awk '/^developer_instructions = /{d=substr($0,length($0)-2); inb=1; next} inb && $0==d {inb=0; next} inb' "$t" > "$T/rt.raw"
  if grep -q '^developer_instructions = """' "$t"; then
    sed -e 's/\\"/"/g' -e 's/\\\\/\\/g' "$T/rt.raw" > "$T/rt.dec"
  else cp "$T/rt.raw" "$T/rt.dec"; fi
  sed -e '1d' "$R/control-plane/agents/roles/$id.md" > "$T/rt.exp"
  cmp -s "$T/rt.dec" "$T/rt.exp"
}
for id in reviewer implementer; do
  check "toml structure $id" toml_check "$R/adapters/codex/agents/proofline-$id.toml"
  check "toml round trip $id" roundtrip "$id"
done
check "literal string when no triple quote" has "$R/adapters/codex/agents/proofline-reviewer.toml" "developer_instructions = '''"
check "basic string fallback for triple quote" has "$R/adapters/codex/agents/proofline-implementer.toml" 'developer_instructions = """'
check "backslashes survive in literal string" has "$R/adapters/codex/agents/proofline-reviewer.toml" 'back\slash and C:\path\n.'
check "codex description escaped" has "$R/adapters/codex/agents/proofline-reviewer.toml" 'description = "Reviews a change against the plan. Use when: per tier (D14) | \"quoted\" \\ slash"'
check "codex sandbox read-only" has "$R/adapters/codex/agents/proofline-reviewer.toml" 'sandbox_mode = "read-only"'
check "codex sandbox workspace-write" has "$R/adapters/codex/agents/proofline-implementer.toml" 'sandbox_mode = "workspace-write"'
check "codex default profile model" has "$R/adapters/codex/agents/proofline-implementer.toml" 'model = "gpt-x-mid"'

# ---- 6. roles.conf format
conf=$R/control-plane/agents/roles.conf
check "roles.conf has 6 fields per data line" test "$(grep -v '^#' "$conf" | awk 'NF != 6' | wc -l | tr -d ' ')" = 0
check "roles.conf has 3 roles x 3 profiles x 2 runtimes" test "$(grep -vc '^#' "$conf")" = 18
check "roles.conf codex model from source" has "$conf" 'reviewer economy codex gpt-x-small low 2'

# ---- 6b. owns.conf, tools.conf
oc=$R/control-plane/agents/owns.conf; tc=$R/control-plane/agents/tools.conf
check "owns.conf reviewer line" has "$oc" 'reviewer reviews/proof-review/'
check "owns.conf cuts NNN tokens to their prefix" has "$oc" 'implementer PRODUCT_SCOPE results/'
check "owns.conf has one line per role" test "$(grep -vc '^#' "$oc")" = 3
check "tools.conf comma list" has "$tc" 'implementer Read,Grep,Glob,Bash,Edit,Write'
check "tools.conf has one line per role" test "$(grep -vc '^#' "$tc")" = 3
checkfail "missing owns rejected" sh -c "sed '/^owns:/d' '$R/roles/lead.md' > '$T/l.md' && mkdir -p '$T/ow/roles' && cp '$T/l.md' '$T/ow/roles/lead.md' && sh '$GEN' --root '$T/ow'"

# ---- 6c. agent names: role id with _ -> -
sed -e 's/^id: reviewer .*/id: security_reviewer/' "$R/roles/reviewer.md" > "$R/roles/security_reviewer.md"
gen >/dev/null
check "claude agent file hyphenated" test -f "$R/adapters/claude/agents/proofline-security-reviewer.md"
check "claude agent name hyphenated" has "$R/adapters/claude/agents/proofline-security-reviewer.md" 'name: proofline-security-reviewer'
check "codex agent hyphenated" has "$R/adapters/codex/agents/proofline-security-reviewer.toml" 'name = "proofline-security-reviewer"'
check "role id keeps underscore in role text" test -f "$R/control-plane/agents/roles/security_reviewer.md"
check "role id keeps underscore in roles.conf" has "$R/control-plane/agents/roles.conf" 'security_reviewer balanced claude'
check "role id keeps underscore in owns.conf" has "$R/control-plane/agents/owns.conf" 'security_reviewer reviews/proof-review/'
checkfail "no underscore agent file" test -e "$R/adapters/claude/agents/proofline-security_reviewer.md"
rm "$R/roles/security_reviewer.md"; gen >/dev/null

# ---- 7. determinism and --check
cp -R "$R" "$T/again"
sh "$GEN" --root "$T/again" >/dev/null
check "deterministic output" diff -r "$R/adapters" "$T/again/adapters"
check "--check passes when in sync" gen --check
printf 'x\n' >> "$R/adapters/codex/agents/proofline-reviewer.toml"
checkfail "--check detects an edited file" gen --check
gen >/dev/null
printf 'x\n' >> "$R/control-plane/agents/owns.conf"
checkfail "--check detects an edited owns.conf" gen --check
gen >/dev/null
rm "$R/control-plane/agents/tools.conf"
checkfail "--check detects a missing tools.conf" gen --check
gen >/dev/null
rm "$R/control-plane/agents/roles/reviewer.md"
checkfail "--check detects a missing file" gen --check
gen >/dev/null
printf 'x\n' > "$R/adapters/claude/agents/proofline-ghost.md"
checkfail "--check detects a stale file" gen --check
gen >/dev/null
check "regenerate removes stale file" test ! -e "$R/adapters/claude/agents/proofline-ghost.md"
check "--check passes again" gen --check
sed -i.bak 's/^purpose: .*/purpose: Changed purpose./' "$R/roles/reviewer.md"
checkfail "--check detects a source change" gen --check
rm -f "$R/roles/reviewer.md.bak"
checkfail "--check and --out are exclusive" gen --check --out "$T/y"

# ---- 8. source validation
newroot
sed -i.bak '/^stop_condition:/d' "$R/roles/reviewer.md"; rm -f "$R/roles/reviewer.md.bak"
checkfail "missing frontmatter key rejected" gen
newroot
sed -i.bak 's/^id: reviewer/id: other/' "$R/roles/reviewer.md"; rm -f "$R/roles/reviewer.md.bak"
checkfail "id must match file name" gen
newroot
sed -i.bak 's/^  max: claude=opus codex=gpt-x-big/  max: claude=opus/' "$R/roles/reviewer.md"; rm -f "$R/roles/reviewer.md.bak"
checkfail "missing codex model rejected" gen
newroot
sed -i.bak 's/^sandbox: read-only/sandbox: full/' "$R/roles/reviewer.md"; rm -f "$R/roles/reviewer.md.bak"
checkfail "bad sandbox rejected" gen
newroot
printf 'See {{skill:Bad Name}}.\n' >> "$R/roles/reviewer.md"
checkfail "malformed skill reference rejected" gen
newroot
long=$(awk 'BEGIN{for(i=0;i<1000;i++) printf "x"}')
sed -i.bak "s/^purpose: .*/purpose: $long/" "$R/roles/reviewer.md"; rm -f "$R/roles/reviewer.md.bak"
checkfail "overlong description rejected" gen

# ---- 9. role-source conformance (real roles/ plus negative cases on a copy)
RC=$here/role-conformance.sh
REAL=$(dirname "$(dirname "$here")")/roles
if ls "$REAL"/*.md >/dev/null 2>&1; then
  check "real roles conform" sh "$RC" "$REAL"
  neg() { # description, sed expression, file: mutate a copy, run the check with --root
    d=$T/negroot; rm -rf "$d"; mkdir -p "$d/roles"; cp "$REAL"/*.md "$d/roles/"
    sed -i.bak "$2" "$d/roles/$3"; rm -f "$d"/roles/*.bak
    if cmp -s "$REAL/$3" "$d/roles/$3"; then bad "conformance negative did not mutate: $1"; return; fi
    checkfail "conformance rejects: $1" sh "$RC" --root "$d"
  }
  check "conformance passes on an unmodified copy" sh -c "rm -rf '$T/cp' && mkdir -p '$T/cp/roles' && cp '$REAL'/*.md '$T/cp/roles/' && sh '$RC' --root '$T/cp'"
  neg "key order" 's/^name: /nom: /' reviewer.md
  neg "spawn tool" 's/^tools: .*/& Agent/' reviewer.md
  neg "bad effort enum" 's/^  balanced: high$/  balanced: huge/' reviewer.md
  neg "security reviewer below opus" 's/^  economy: claude=opus/  economy: claude=sonnet/' security_reviewer.md
  neg "tier floor above model" 's/^tier_floor: 3/tier_floor: 4/' security_reviewer.md
  neg "sandbox parity" 's/^sandbox: workspace-write/sandbox: read-only/' implementer.md
  neg "unknown skill reference" 's/{{skill:proof-review}}/{{skill:nope}}/' reviewer.md
  neg "inline hash in frontmatter" 's/^name: .*/& # x/' qa.md
  neg "body section order" 's/^## Method$/## Steps/' explorer.md
  neg "old severity value" 's/severity `blocking`/severity `CRITICAL`/' data_architect.md
  neg "uppercase severity word" 's/Severity is `info`/Severity is INFO/' explorer.md
  neg "README severity set" 's/`severity` is exactly `blocking` or `info`/`severity` is CRITICAL to INFO/' README.md
  neg "gate finding id" 's/`SECURITY-<n>`/`SEC-<n>`/' security_reviewer.md
  neg "task finding id" 's/`explorer-<n>`/`EXPLORER-<n>`/' explorer.md
  neg "qa plan-step id" 's/plan step `qa-<n>`/plan step `QA-<n>`/' qa.md
  neg "gate RESULT set" 's/^RESULT: <PASS|FAIL|BLOCKED>$/RESULT: <PASS|FAIL>/' verifier.md
  neg "task role with gate RESULT" 's/^RESULT: <DONE|BLOCKED|NEEDS_INPUT>$/RESULT: <PASS|FAIL|BLOCKED>/' explorer.md
  neg "no-spawn rule missing" 's/, spawn agents |/ |/' qa.md
  neg "lead no-dispatch rule missing" 's/Let a specialist dispatch another/Let anyone dispatch/' lead.md
  neg "owns without Write" 's/^tools: Read Grep Glob Bash Write Edit$/tools: Read Grep Glob Bash/' reviewer.md
  neg "Write without workspace-write" 's/^sandbox: workspace-write/sandbox: read-only/' qa.md
  neg "writes_code on a design role" 's/^writes_code: no/writes_code: yes/' designer.md
  neg "PRODUCT_SCOPE outside implementer" 's/^owns: .*/& PRODUCT_SCOPE/' reviewer.md
  neg "implementer without PRODUCT_SCOPE" 's/^owns: PRODUCT_SCOPE /owns: /' implementer.md
  neg "project code path owned by a non-implementer" 's/^owns: .*/& \/src\//' designer.md
  rm -rf "$T/neg"; mkdir -p "$T/neg/roles"; cp "$REAL"/*.md "$T/neg/roles/"; rm -f "$T/neg/roles/lead.md"
  checkfail "conformance rejects wrong role count" sh "$RC" --root "$T/neg"
else
  printf 'skip real-role conformance: roles/*.md not present\n'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
