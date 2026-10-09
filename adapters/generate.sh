#!/bin/sh
# shellcheck disable=SC2016
# Renders roles/<id>.md (single source, D11) into runtime formats (D6).
# Usage: adapters/generate.sh [--check] [--target T] [--profile P] [--out DIR] [--root DIR]
#   T: claude-plugin | claude-project | codex | control-plane | docs | all   (default all)
#   --check    render into a temp dir and fail if any generated file differs (CI)
#   --profile  max | balanced | economy: model/effort written into the agent files (default balanced)
#   --out DIR  render into an installed project: DIR/.claude/agents, DIR/.codex/agents, DIR/.agents/roles,
#              DIR/.agents/roles.conf, owns.conf, tools.conf (used by `proofline init`)
#   --root DIR repository root holding roles/ (default: the parent of this script's directory)
# Output is deterministic: sorted roles, no timestamps.
set -eu
LC_ALL=C
export LC_ALL

die() { printf 'generate.sh: %s\n' "$*" >&2; exit 1; }

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$here")
CHECK=0
TARGET=all
PROFILE=balanced
OUT=

while [ $# -gt 0 ]; do
  case $1 in
    --check) CHECK=1 ;;
    --target) [ $# -ge 2 ] || die "--target needs a value"; TARGET=$2; shift ;;
    --profile) [ $# -ge 2 ] || die "--profile needs a value"; PROFILE=$2; shift ;;
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT=$2; shift ;;
    --root) [ $# -ge 2 ] || die "--root needs a value"; ROOT=$2; shift ;;
    -h|--help) sed -n '3,13p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

case $PROFILE in max|balanced|economy) ;; *) die "bad --profile: $PROFILE" ;; esac
[ -d "$ROOT/roles" ] || die "no roles/ directory under $ROOT"
[ "$CHECK" = 0 ] || [ -z "$OUT" ] || die "--check and --out cannot be combined"

if [ -n "$OUT" ]; then LAYOUT=project; else LAYOUT=repo; fi
if [ "$TARGET" = all ]; then
  if [ $LAYOUT = repo ]; then TARGETS="claude-plugin codex control-plane docs"
  else TARGETS="claude-project codex control-plane"; fi
else
  case $TARGET in
    claude-plugin|docs) [ $LAYOUT = repo ] || die "target $TARGET renders into the repository (no --out)" ;;
    claude-project) [ $LAYOUT = project ] || die "target claude-project needs --out DIR" ;;
    codex|control-plane) ;;
    *) die "unknown --target: $TARGET" ;;
  esac
  TARGETS=$TARGET
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/proofline-gen.XXXXXX")
trap 'rm -rf "$WORK"' EXIT HUP INT TERM
mkdir -p "$WORK/meta" "$WORK/body"

# ---- parse: frontmatter -> $WORK/meta/<id> (key<TAB>value), body -> $WORK/body/<id>
parse_role() { # file id
  head -n 1 "$1" | tr -d '\r' | grep -qx -- '---' || die "$1: first line must be ---"
  awk -v meta="$WORK/meta/$2" '
    { sub(/\r$/, "") }
    NR == 1 { fm = 1; next }
    fm == 1 {
      if ($0 == "---") { fm = 2; exit }
      if (match($0, /^[A-Za-z_][A-Za-z0-9_]*:/)) {
        key = substr($0, 1, RLENGTH - 1); val = substr($0, RLENGTH + 1); block = ""
        free = (key == "purpose" || key == "conditional" || key == "stop_condition")
        emit(key, val, free, 1)
      } else if (block != "" && match($0, /^[ \t]+[A-Za-z_][A-Za-z0-9_]*:/)) {
        s = $0; sub(/^[ \t]+/, "", s); sk = s; sub(/:.*/, "", sk); sub(/^[^:]*:/, "", s)
        emit(block "." sk, s, 0, 0)
      }
    }
    function emit(k, v, free, top) {
      sub(/^[ \t]+/, "", v)
      if (free) sub(/[ \t][ \t]+#.*$/, "", v); else sub(/[ \t]+#.*$/, "", v)
      sub(/[ \t]+$/, "", v)
      if (v ~ /^".*"$/ && length(v) >= 2) v = substr(v, 2, length(v) - 2)
      if (v == "" && top) block = k; else print k "\t" v >> meta
    }
    END { if (fm != 2) exit 3 }' "$1" || die "$1: frontmatter not closed with ---"
  awk 'NR == 1 { next } fm == 0 { sub(/\r$/, ""); if ($0 == "---") fm = 1; next } { sub(/\r$/, ""); print }' "$1" > "$WORK/body/$2"
}

get() { awk -F '\t' -v k="$2" '$1 == k { print substr($0, length(k) + 2); exit }' "$WORK/meta/$1"; }
pair() { printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -n 1; }
esc() { sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
need() { [ -n "$(get "$1" "$2")" ] || die "roles/$1.md: missing frontmatter key '$2'"; }

ROLES=
for f in "$ROOT"/roles/*.md; do
  [ -f "$f" ] || die "no roles/*.md under $ROOT"
  [ "$(basename "$f")" != README.md ] || continue
  id=$(basename "$f" .md)
  case $id in [a-z]*) ;; *) die "bad role file name: $f" ;; esac
  case $id in *[!a-z0-9_]*) die "bad role file name: $f" ;; esac
  parse_role "$f" "$id"
  [ "$(get "$id" id)" = "$id" ] || die "roles/$id.md: 'id' must equal the file name"
  for k in name purpose conditional owns tools result sandbox tier_floor stop_condition; do need "$id" $k; done
  for p in max balanced economy; do
    for k in model effort; do need "$id" "$k.$p"; done
    for rt in claude codex; do
      [ -n "$(pair "$(get "$id" "model.$p")" $rt)" ] || die "roles/$id.md: model.$p lacks $rt=..."
    done
  done
  case $(get "$id" sandbox) in read-only|workspace-write) ;; *) die "roles/$id.md: bad sandbox" ;; esac
  case $(get "$id" tier_floor) in 1|2|3) ;; *) die "roles/$id.md: tier_floor must be 1..3" ;; esac
  desc="$(get "$id" purpose) $(get "$id" conditional)"
  [ ${#desc} -le 900 ] || die "roles/$id.md: purpose + conditional too long for a 1000-char description"
  ROLES="$ROLES $id"
done

# ---- output layout
set_paths() { # base
  if [ $LAYOUT = repo ]; then
    P_CLAUDE=$1/adapters/claude/agents; P_CODEX=$1/adapters/codex/agents
    P_ROLES=$1/control-plane/agents/roles; P_AG=$1/control-plane/agents
    P_DOC=$1/docs/reference/roles.md
  else
    P_CLAUDE=$1/.claude/agents; P_CODEX=$1/.codex/agents
    P_ROLES=$1/.agents/roles; P_AG=$1/.agents; P_DOC=
  fi
}

# {{skill:x}} -> <prefix>x<suffix>
subst() { # prefix suffix
  awk -v pre="$1" -v suf="$2" '{
    line = $0; out = ""
    while (match(line, /\{\{skill:[A-Za-z0-9_-]+\}\}/)) {
      out = out substr(line, 1, RSTART - 1) pre substr(line, RSTART + 8, RLENGTH - 10) suf
      line = substr(line, RSTART + RLENGTH)
    }
    print out line }' "$WORK/body/$3"
}
body_for() { # id prefix suffix
  subst "$2" "$3" "$1" > "$WORK/rendered"
  ! grep -q '{{skill:' "$WORK/rendered" || die "roles/$1.md: malformed {{skill:...}} reference"
  cat "$WORK/rendered"
}

description() { printf '%s. Use when: %s' "$(get "$1" purpose | sed 's/\.$//')" "$(get "$1" conditional)"; }
stamp() { printf 'Generated from roles/%s.md by adapters/generate.sh. Do not edit.' "$1"; }
aname() { printf 'proofline-%s' "$1" | tr _ -; } # agent name: role id with _ -> -

render_claude() { # id mode dest-dir
  id=$1
  if [ "$2" = plugin ]; then pre='${CLAUDE_PLUGIN_ROOT}/skills/'; else pre='.agents/skills/'; fi
  {
    printf -- '---\nname: %s\n' "$(aname "$id")"
    printf 'description: "%s"\n' "$(description "$id" | esc)"
    printf 'tools: %s\n' "$(get "$id" tools | tr -s ' ' | sed 's/ /, /g')"
    printf 'model: %s\n' "$(pair "$(get "$id" "model.$PROFILE")" claude)"
    printf 'effort: %s\n' "$(get "$id" "effort.$PROFILE")"
    printf -- '---\n<!-- %s -->\n' "$(stamp "$id")"
    body_for "$id" "$pre" /SKILL.md
  } > "$3/$(aname "$id").md"
}

render_codex() { # id dest-dir
  id=$1
  {
    printf '# %s\n' "$(stamp "$id")"
    printf 'name = "%s"\n' "$(aname "$id")"
    printf 'description = "%s"\n' "$(description "$id" | esc)"
    printf 'model = "%s"\n' "$(pair "$(get "$id" "model.$PROFILE")" codex | esc)"
    printf 'model_reasoning_effort = "%s"\n' "$(get "$id" "effort.$PROFILE" | esc)"
    printf 'sandbox_mode = "%s"\n' "$(get "$id" sandbox)"
    body_for "$id" '.agents/skills/' /SKILL.md > "$WORK/cx"
    if grep -q "'''" "$WORK/cx"; then
      # a literal string cannot hold ''' : fall back to a basic multi-line string
      printf 'developer_instructions = """\n'; esc < "$WORK/cx"; printf '"""\n'
    else
      printf "developer_instructions = '''\n"; cat "$WORK/cx"; printf "'''\n"
    fi
  } > "$2/$(aname "$id").toml"
}

render_role_text() { # id dest-dir; skills installed in a project live in .agents/skills/
  {
    printf '<!-- %s -->\n' "$(stamp "$1")"
    body_for "$1" '.agents/skills/' /SKILL.md
  } > "$2/$1.md"
}

render_owns() { # dest-file; owns tokens verbatim
  {
    printf '# Paths each role may write (PreToolUse hook, dispatch.sh). Generated from roles/<role>.md owns:; do not edit.\n'
    printf '# <role> <token>...  token: run-relative path | /project-relative path | PRODUCT_SCOPE (frozen PLAN scope);\n'
    printf '# a token ending in / covers its subtree, any other token is one exact file; NNN = three digits\n'
    for id in $ROLES; do
      printf '%s %s\n' "$id" "$(get "$id" owns | tr -s ' ')"
    done
  } > "$1"
}

render_tools() { # dest-file
  {
    printf '# Claude tools per role. Generated from roles/<role>.md tools:; do not edit.\n'
    for id in $ROLES; do printf '%s %s\n' "$id" "$(get "$id" tools | tr -s ' ' ',')"; done
  } > "$1"
}

render_conf() { # dest-file
  {
    printf '# Execution policy per role (D5). Generated from roles/<role>.md by adapters/generate.sh; do not edit.\n'
    printf '# One line per role, profile and runtime: role profile runtime model effort tier_floor\n'
    printf '# model: the model name of that runtime. effort: reasoning effort for the profile.\n'
    printf '# tier_floor: minimum capability tier the role may run on (failover and overrides never go below it).\n'
    for id in $ROLES; do
      for p in max balanced economy; do
        for rt in claude codex; do
          printf '%s %s %s %s %s %s\n' "$id" "$p" "$rt" "$(pair "$(get "$id" "model.$p")" $rt)" \
            "$(get "$id" "effort.$p")" "$(get "$id" tier_floor)"
        done
      done
    done
  } > "$1"
}

cell() { sed -e 's/|/\\|/g'; }
render_doc() { # dest-file
  {
    printf '<!-- Generated from roles/ — do not edit. Run adapters/generate.sh. -->\n\n# Roles reference\n\n'
    printf 'Generated from roles/ — do not edit.\n\n'
    printf '| Role | Purpose | Dispatched | Result | Gates | Skills | Writes code | Sandbox | Tier floor |\n'
    printf '|---|---|---|---|---|---|---|---|---|\n'
    for id in $ROLES; do
      printf '| [`%s`](#%s) | %s | %s | %s | %s | %s | %s | %s | %s |\n' "$id" "$id" \
        "$(get "$id" purpose | cell)" "$(get "$id" conditional | cell)" "$(get "$id" result)" \
        "$(get "$id" gate | cell)" "$(get "$id" skills | cell)" "$(get "$id" writes_code)" \
        "$(get "$id" sandbox)" "$(get "$id" tier_floor)"
    done
    for id in $ROLES; do
      printf '\n## %s\n\n%s\n\n' "$id" "$(get "$id" purpose)"
      printf -- '- Name: %s\n- Agent: %s\n- Dispatched: %s\n- Reads: %s\n- Owns: %s\n- Skills: %s\n' \
        "$(get "$id" name)" "$(if [ "$id" = lead ]; then echo 'none (main session)'; else aname "$id"; fi)" "$(get "$id" conditional)" "$(get "$id" reads)" "$(get "$id" owns)" "$(get "$id" skills)"
      printf -- '- Gates: %s\n- Result protocol: %s\n- Tools: %s\n- Sandbox: %s\n- Tier floor: %s\n' \
        "$(get "$id" gate)" "$(get "$id" result)" "$(get "$id" tools)" "$(get "$id" sandbox)" "$(get "$id" tier_floor)"
      printf -- '- Timeout: %s s\n- Stop condition: %s\n\n' "$(get "$id" timeout_seconds)" "$(get "$id" stop_condition)"
      printf '| Profile | Claude model | Codex model | Effort |\n|---|---|---|---|\n'
      for p in max balanced economy; do
        printf '| %s | %s | %s | %s |\n' "$p" "$(pair "$(get "$id" "model.$p")" claude)" \
          "$(pair "$(get "$id" "model.$p")" codex)" "$(get "$id" "effort.$p")"
      done
    done
  } > "$1"
}

render_all() { # base
  set_paths "$1"
  for t in $TARGETS; do
    case $t in
      claude-plugin|claude-project)
        mkdir -p "$P_CLAUDE"; rm -f "$P_CLAUDE"/proofline-*.md
        for id in $ROLES; do
          [ "$id" = lead ] || render_claude "$id" "${t#claude-}" "$P_CLAUDE"
        done ;;
      codex)
        mkdir -p "$P_CODEX"; rm -f "$P_CODEX"/proofline-*.toml
        for id in $ROLES; do [ "$id" = lead ] || render_codex "$id" "$P_CODEX"; done ;;
      control-plane)
        mkdir -p "$P_ROLES"; rm -f "$P_ROLES"/*.md
        for id in $ROLES; do render_role_text "$id" "$P_ROLES"; done
        render_conf "$P_AG/roles.conf"; render_owns "$P_AG/owns.conf"; render_tools "$P_AG/tools.conf" ;;
      docs) mkdir -p "$(dirname "$P_DOC")"; render_doc "$P_DOC" ;;
    esac
  done
}

if [ -n "$OUT" ]; then
  mkdir -p "$OUT"
  render_all "$OUT"
  exit 0
fi

if [ $CHECK = 0 ]; then
  render_all "$ROOT"
  exit 0
fi

# ---- --check: render to a temp tree, compare file by file and look for stale files
render_all "$WORK/tree"
drift=0
for f in $(cd "$WORK/tree" && find . -type f | sort); do
  if [ ! -f "$ROOT/$f" ]; then printf 'missing: %s\n' "${f#./}" >&2; drift=1
  elif ! cmp -s "$WORK/tree/$f" "$ROOT/$f"; then printf 'out of sync: %s\n' "${f#./}" >&2; drift=1; fi
done
for d in adapters/claude/agents:proofline-*.md adapters/codex/agents:proofline-*.toml control-plane/agents/roles:*.md; do
  dir=${d%%:*}; pat=${d#*:}
  case " $TARGETS " in
    *" claude-plugin "*) ;; *) [ "$dir" != adapters/claude/agents ] || continue ;;
  esac
  case " $TARGETS " in *" codex "*) ;; *) [ "$dir" != adapters/codex/agents ] || continue ;; esac
  case " $TARGETS " in *" control-plane "*) ;; *) [ "$dir" != control-plane/agents/roles ] || continue ;; esac
  for f in "$ROOT/$dir"/$pat; do
    [ -f "$f" ] || continue
    [ -f "$WORK/tree/$dir/$(basename "$f")" ] || { printf 'stale: %s/%s\n' "$dir" "$(basename "$f")" >&2; drift=1; }
  done
done
[ $drift = 0 ] || die "generated files are out of sync; run adapters/generate.sh"
printf 'generated files in sync\n'
