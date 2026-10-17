#!/bin/sh
# `proofline init` and `proofline upgrade` (D8): install the control plane into a project, merge (never
# overwrite) what the project already has, and remember what was installed (.agents/.proofline-manifest:
# sha256 + path of every installed file) so that upgrade can tell unmodified files from user edits.
# Sourced by bin/proofline, which provides say/warn/die, sha256, PL_HOME, ROOT, PROOFLINE_VERSION.

MANIFEST_REL=.agents/.proofline-manifest

plog() { printf '%s\t%s\n' "$1" "$2" >> "$STAGE/plan"; }
rt_has() { case " $RUNTIMES " in *" $1 "*) return 0 ;; esac; return 1; }
g() { git -C "$ROOT" "$@"; }

# ask VAR PROMPT DEFAULT: the default unless the session is interactive.
ask() {
  if [ "$INTERACTIVE" = 1 ]; then
    printf '%s [%s]: ' "$2" "$3" >&2
    IFS= read -r ask_a || ask_a=''
    [ -n "$ask_a" ] || ask_a=$3
  else ask_a=$3; fi
  eval "$1=\$ask_a"
}

detect_branch() { # the canonical integration branch
  db=$(g symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null) && [ -n "$db" ] && { printf '%s\n' "${db#origin/}"; return; }
  for db in main master trunk develop; do
    g show-ref --verify --quiet "refs/heads/$db" 2>/dev/null && { printf '%s\n' "$db"; return; }
  done
  db=$(g symbolic-ref --short -q HEAD 2>/dev/null) && [ -n "$db" ] && { printf '%s\n' "$db"; return; }
  echo main
}

detect_runtimes() { # installed agent CLIs, claude first
  dr=''
  command -v "${PROOFLINE_CLAUDE_BIN:-claude}" >/dev/null 2>&1 && dr=claude
  command -v "${PROOFLINE_CODEX_BIN:-codex}" >/dev/null 2>&1 && dr="$dr codex"
  printf '%s\n' "${dr# }"
}

manifest_get() { [ -f "$MANIFEST_OLD" ] && PL_P=$1 awk '!/^#/ && $2 == ENVIRON["PL_P"] { print $1; exit }' "$MANIFEST_OLD"; }
manifest_meta() { [ -f "$MANIFEST_OLD" ] && sed -n "s/^# $1: *//p" "$MANIFEST_OLD" | head -1; }

# --- staging: the exact tree this version wants installed ---------------------------------------------
stage_build() {
  sf=$STAGE/files; mkdir -p "$sf/.agents/skills" "$sf/.agents/hooks"
  cp -R "$PL_HOME/control-plane/agents/." "$sf/.agents/"
  rm -rf "$sf/.agents/roles" "$sf/.agents/roles.conf" "$sf/.agents/config.yaml"
  for sb_d in "$PL_HOME"/skills/*/; do
    [ -f "$sb_d/SKILL.md" ] || continue
    cp -R "${sb_d%/}" "$sf/.agents/skills/"
  done
  cp "$PL_HOME/adapters/claude/hooks/proofline-hook.sh" "$sf/.agents/hooks/proofline-hook.sh"
  sh "$PL_HOME/adapters/generate.sh" --profile "$PROFILE" --out "$STAGE/gen" --root "$PL_HOME" >/dev/null || die "role generation failed"
  cp -R "$STAGE/gen/.agents/." "$sf/.agents/"
  if rt_has claude; then
    mkdir -p "$sf/.claude/skills"; cp -R "$STAGE/gen/.claude/agents" "$sf/.claude/agents"
    cp -R "$PL_HOME/skills/proofline" "$sf/.claude/skills/proofline"
  fi
  if rt_has codex; then mkdir -p "$sf/.codex"; cp -R "$STAGE/gen/.codex/agents" "$sf/.codex/agents"; fi
  find "$sf" -name .DS_Store -delete
}

# place REL: install one staged file. Three-way rule against the manifest: absent -> new; identical ->
# same; installed == manifest (unmodified) -> update; anything else is the user's -> kept (init) or
# conflict with a .proofline-new copy (upgrade).
place() {
  pl_src=$STAGE/files/$1; pl_dst=$ROOT/$1
  pl_n=$(sha256 "$pl_src"); pl_keep=''
  if [ ! -e "$pl_dst" ]; then pl_act=new
  else
    pl_d=$(sha256 "$pl_dst"); pl_m=$(manifest_get "$1" || true)
    if [ "$pl_d" = "$pl_n" ]; then pl_act=same
    elif [ -n "$pl_m" ] && [ "$pl_d" = "$pl_m" ]; then pl_act=update
    elif [ -n "$pl_m" ] && [ "$pl_m" = "$pl_n" ]; then pl_act=mine; pl_keep=$pl_m   # you edited it, upstream did not change
    elif [ "$MODE" = upgrade ]; then pl_act=conflict; pl_keep=$pl_m
    else pl_act=keep; pl_keep=$pl_m; fi
  fi
  case "$pl_act" in
    new|update)
      if [ "$DRY" != 1 ]; then
        mkdir -p "$(dirname "$pl_dst")"; cp "$pl_src" "$pl_dst"
        if [ -x "$pl_src" ]; then chmod +x "$pl_dst"; fi
        case "$1" in .agents/scripts/*.sh|.agents/githooks/*|.agents/hooks/*.sh|.agents/task-integrations/*.sh) chmod +x "$pl_dst" ;; esac
      fi ;;
    conflict) [ "$DRY" = 1 ] || cp "$pl_src" "$pl_dst.proofline-new" ;;
  esac
  case "$pl_act" in
    new|update|same) printf '%s  %s\n' "$pl_n" "$1" >> "$STAGE/manifest.new" ;;
    *) [ -z "$pl_keep" ] || printf '%s  %s\n' "$pl_keep" "$1" >> "$STAGE/manifest.new" ;;
  esac
  plog "$pl_act" "$1"
}

place_all() {
  : > "$STAGE/manifest.new"
  (cd "$STAGE/files" && find . -type f | sed 's|^\./||' | sort) > "$STAGE/list"
  while IFS= read -r pa_f; do place "$pa_f"; done < "$STAGE/list"
  # files an older version installed that this version no longer ships
  if [ "$MODE" = upgrade ] && [ -f "$MANIFEST_OLD" ]; then
    grep -v '^#' "$MANIFEST_OLD" | while read -r pa_s pa_p; do
      grep -qxF "$pa_p" "$STAGE/list" && continue
      [ -e "$ROOT/$pa_p" ] || continue
      if [ "$(sha256 "$ROOT/$pa_p")" = "$pa_s" ]; then
        [ "$DRY" = 1 ] || rm -f "$ROOT/$pa_p"
        plog removed "$pa_p"
      else plog orphan "$pa_p (modified, no longer shipped; kept)"; printf '%s  %s\n' "$pa_s" "$pa_p" >> "$STAGE/manifest.new"; fi
    done
  fi
}

# --- merges ----------------------------------------------------------------------------------------
# hooks_merge CURRENT FRAGMENT OUT: adds the fragment's hook groups missing from CURRENT (a group is present
# when one of its commands is). Exit 0 unchanged, 3 changed (OUT written), 1 error.
hooks_merge() {
  if command -v jq >/dev/null 2>&1; then
    jq -s '
      def cmds: [(.hooks // [])[] | .command];
      .[0] as $cur | .[1] as $frag
      | if ($cur | type) != "object" then error("not an object") else . end
      | $cur | .hooks = (reduce ($frag.hooks | to_entries[]) as $e (.hooks // {};
          ((.[$e.key] // []) as $h | ([$h[] | cmds[]]) as $present
          | .[$e.key] = ($h + [$e.value[] | select(([cmds[] | select(. as $c | $present | index($c) != null)] | length) == 0)]))))' \
      "$1" "$2" > "$3" 2>/dev/null || return 1
    [ "$(jq -S -c . "$1")" != "$(jq -S -c . "$3")" ] || return 0
    return 3
  elif command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs"); const [cur, frag, out] = process.argv.slice(1);
      let c, f; try { c = JSON.parse(fs.readFileSync(cur, "utf8")); f = JSON.parse(fs.readFileSync(frag, "utf8")); } catch (e) { process.exit(1); }
      if (typeof c !== "object" || c === null || Array.isArray(c)) process.exit(1);
      const before = JSON.stringify(c);
      const hooks = c.hooks && typeof c.hooks === "object" ? c.hooks : {};
      for (const [ev, groups] of Object.entries(f.hooks || {})) {
        const have = Array.isArray(hooks[ev]) ? hooks[ev] : [];
        const present = new Set(have.flatMap((g) => (g.hooks || []).map((h) => h.command)));
        for (const g of groups) {
          const cmds = (g.hooks || []).map((h) => h.command);
          if (!cmds.some((x) => present.has(x))) { have.push(g); cmds.forEach((x) => present.add(x)); }
        }
        hooks[ev] = have;
      }
      c.hooks = hooks;
      if (JSON.stringify(c) === before) process.exit(0);
      fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n"); process.exit(3);' "$1" "$2" "$3"
  else return 1; fi
}

json_merge() { # REL SRC
  jm_dst=$ROOT/$1
  if [ ! -e "$jm_dst" ]; then
    plog merged "$1 (created)"
    [ "$DRY" = 1 ] || { mkdir -p "$(dirname "$jm_dst")"; cp "$2" "$jm_dst"; }
    return 0
  fi
  jm_out=$STAGE/merge.json; rm -f "$jm_out"
  hooks_merge "$jm_dst" "$2" "$jm_out"; jm_rc=$?
  case "$jm_rc" in
    0) plog same "$1" ;;
    3) plog merged "$1 (proofline hooks added, existing keys kept)"; [ "$DRY" = 1 ] || cat "$jm_out" > "$jm_dst" ;;
    *) plog warn "$1 not merged (invalid JSON, or neither jq nor node is installed); add the hooks from ${2#"$PL_HOME"/} by hand" ;;
  esac
}

# merge_block REL SRC: a marked block inside a user-owned markdown file. The sha256 of the block as installed is
# kept in the manifest header (`# block-REL:`); a block whose current hash differs from it was edited by the
# user: it is kept, the merged result is written beside it as REL.proofline-new, and a conflict is reported.
merge_block() {
  mb_dst=$ROOT/$1; mb_blk=$STAGE/block; mb_new=$STAGE/block.new; mb_cur=$STAGE/block.cur
  { echo '<!-- proofline:begin -->'; cat "$2"; echo '<!-- proofline:end -->'; } > "$mb_blk"
  mb_hash=$(sha256 "$mb_blk"); mb_rec=$mb_hash; mb_conf=0
  mb_old=$(manifest_meta "block-$1" || true)
  if [ ! -f "$mb_dst" ]; then cat "$mb_blk" > "$mb_new"; mb_act="created"
  elif grep -qx '<!-- proofline:begin -->' "$mb_dst"; then
    grep -qx '<!-- proofline:end -->' "$mb_dst" || { plog warn "$1 has a proofline:begin marker without an end marker; not touched"; [ -z "$mb_old" ] || echo "block-$1 $mb_old" >> "$STAGE/blocks"; return 0; }
    awk '/^<!-- proofline:begin -->$/ { i = 1 } i { print } /^<!-- proofline:end -->$/ { i = 0 }' "$mb_dst" > "$mb_cur"
    awk -v blk="$mb_blk" '/^<!-- proofline:begin -->$/ { while ((getline l < blk) > 0) print l; skip = 1; next }
      /^<!-- proofline:end -->$/ { skip = 0; next } !skip { print }' "$mb_dst" > "$mb_new"; mb_act="block updated"
    mb_have=$(sha256 "$mb_cur")
    if [ "$mb_have" != "$mb_hash" ] && [ "$mb_have" != "$mb_old" ]; then mb_conf=1; mb_rec=$mb_old; fi
  else { cat "$mb_dst"; echo; cat "$mb_blk"; } > "$mb_new"; mb_act="block appended, your content kept"; fi
  [ -z "$mb_rec" ] || echo "block-$1 $mb_rec" >> "$STAGE/blocks"
  if [ "$mb_conf" = 1 ]; then
    plog conflict "$1"
    [ "$DRY" = 1 ] || cat "$mb_new" > "$mb_dst.proofline-new"
    return 0
  fi
  if [ -f "$mb_dst" ] && cmp -s "$mb_new" "$mb_dst"; then plog same "$1"; return 0; fi
  plog merged "$1 ($mb_act)"
  [ "$DRY" = 1 ] || cat "$mb_new" > "$mb_dst"
}

ensure_line() { # REL LINE
  if [ -f "$ROOT/$1" ] && grep -qxF "$2" "$ROOT/$1"; then return 0; fi
  plog merged "$1 (+ $2)"
  [ "$DRY" = 1 ] || { [ ! -s "$ROOT/$1" ] || [ -z "$(tail -c1 "$ROOT/$1")" ] || echo >> "$ROOT/$1"; echo "$2" >> "$ROOT/$1"; }
}

cfg_set_if() { # FILE KEY VALUE: set only when the current value differs
  [ "$(cfg_val "$1" "$2" '')" = "$3" ] || cfg_set "$1" "$2" "$3" || warn "config key not set: $2"
}

do_config() {
  dc_cur=$ROOT/.agents/config.yaml; dc_w=$STAGE/config.yaml
  if [ -f "$dc_cur" ]; then dc_new=no; cp "$dc_cur" "$dc_w"; else dc_new=yes; cp "$PL_HOME/control-plane/agents/config.yaml" "$dc_w"; fi
  if [ "$MODE" = upgrade ]; then
    cfg_merge_new "$dc_cur" "$PL_HOME/control-plane/agents/config.yaml" > "$dc_w"
  fi
  cfg_set_if "$dc_w" proofline_version "$PROOFLINE_VERSION"
  if [ "$MODE" = init ]; then
    # a new config takes every resolved value; an existing one only what was passed explicitly
    dc_all=$dc_new
    [ "$dc_all" = no ] || cfg_set_if "$dc_w" canonical_branch "$CANON"
    { [ "$dc_all" = yes ] || [ -n "$OPT_PROFILE" ]; } && cfg_set_if "$dc_w" profile "$PROFILE"
    { [ "$dc_all" = yes ] || [ -n "$OPT_LEAD" ]; } && cfg_set_if "$dc_w" runtime.lead "$LEAD"
    { [ "$dc_all" = yes ] || [ -n "$OPT_WORKER" ]; } && cfg_set_if "$dc_w" runtime.worker "$WORKER"
    { [ "$dc_all" = yes ] || [ -n "$OPT_REVIEWERS" ]; } && cfg_set_if "$dc_w" runtime.reviewers "$REVIEWERS"
    { [ "$dc_all" = yes ] || [ -n "$OPT_ADAPTER" ]; } && cfg_set_if "$dc_w" tasks.adapter "$ADAPTER"
    { [ "$dc_all" = yes ] || [ "$HAVE_PROTECTED" = 1 ]; } && cfg_set_if "$dc_w" git.protected_branches "$PROTECTED"
    { [ "$dc_all" = yes ] || [ -n "$OPT_PUSH" ]; } && cfg_set_if "$dc_w" git.push_requires_approval "$PUSH"
    { [ "$dc_all" = yes ] || [ -n "$OPT_FORBIDDEN" ]; } && cfg_set_if "$dc_w" git.forbidden_identities "$FORBIDDEN"
    for dc_r in $OPT_ROLES; do # a role override is always explicit; the parent key is added when an older config lacks it
      if dc_p=$(cfg_get "$dc_w" runtime.roles 2>/dev/null); then
        case "$dc_p" in
          '') ;;
          '{}') cfg_set "$dc_w" runtime.roles '' ;; # a hand-edited empty map becomes a parent line
          *) die "runtime.roles in .agents/config.yaml has an inline value ($dc_p); write the roles as indented lines and run init again" ;;
        esac
      else cfg_set "$dc_w" runtime.roles ''; fi
      cfg_set_if "$dc_w" "runtime.roles.${dc_r%%=*}" "${dc_r#*=}"
    done
    for dc_k in build test lint; do
      case "$dc_k" in build) dc_v=$D_BUILD ;; test) dc_v=$D_TEST ;; lint) dc_v=$D_LINT ;; esac
      [ -n "$dc_v" ] && [ -z "$(cfg_val "$dc_w" "commands.$dc_k" '')" ] && cfg_set_if "$dc_w" "commands.$dc_k" "$dc_v"
    done
  fi
  if [ "$dc_new" = yes ]; then plog merged ".agents/config.yaml (created from the discovered project settings)"
  elif cmp -s "$dc_w" "$dc_cur"; then plog same .agents/config.yaml
  else plog merged ".agents/config.yaml (keys updated, your other values kept)"; fi
  [ "$DRY" = 1 ] || { mkdir -p "$ROOT/.agents"; cat "$dc_w" > "$dc_cur"; }
}

# Codex leads spawn Codex workers, so their workspace-write sandbox needs outbound runtime access.
# Keep every project TOML key and track the resulting file in the manifest.
codex_network_config() {
  cn_dst=$ROOT/.codex/config.toml; cn_out=$STAGE/codex-config.toml
  if [ -f "$cn_dst" ]; then
    awk '
      /^\[sandbox_workspace_write\][[:space:]]*$/ { if (inside && !seen) print "network_access = true"; inside=1; found=1; print; next }
      /^\[/ { if (inside && !seen) print "network_access = true"; inside=0 }
      inside && /^[[:space:]]*network_access[[:space:]]*=/ { if (!seen) print "network_access = true"; seen=1; next }
      { print }
      END { if (inside && !seen) print "network_access = true"; if (!found) print "\n[sandbox_workspace_write]\nnetwork_access = true" }
    ' "$cn_dst" > "$cn_out"
  else printf '[sandbox_workspace_write]\nnetwork_access = true\n' > "$cn_out"; fi
  cn_hash=$(sha256 "$cn_out")
  printf 'toml-.codex/config.toml %s\n' "$cn_hash" >> "$STAGE/blocks"
  if [ -f "$cn_dst" ] && cmp -s "$cn_dst" "$cn_out"; then plog same .codex/config.toml
  else
    plog merged '.codex/config.toml (workspace-write network access; other keys kept)'
    [ "$DRY" = 1 ] || { mkdir -p "$ROOT/.codex"; cat "$cn_out" > "$cn_dst"; }
  fi
}

# global_hookspath: a core.hooksPath in the global or system git config (never modified here), else empty.
global_hookspath() { g config --global --get core.hooksPath 2>/dev/null || g config --system --get core.hooksPath 2>/dev/null || true; }
global_hookspath_msg() { # VALUE: the warning shared by init and doctor
  printf "a global/system git core.hooksPath ('%s') exists; the repository-local core.hooksPath wins here and is left set, but the global one is not touched and applies to your other repositories" "$1"
}

do_githooks_path() {
  dg_cur=$(g config --local --get core.hooksPath 2>/dev/null || true)
  if [ "$dg_cur" = .agents/githooks ]; then plog same "git config core.hooksPath"
  elif [ -z "$dg_cur" ]; then
    plog merged "git config --local core.hooksPath .agents/githooks"
    [ "$DRY" = 1 ] || g config --local core.hooksPath .agents/githooks
  else plog warn "core.hooksPath is '$dg_cur'; the proofline git hooks (.agents/githooks) are NOT active. Chain them from that hook directory or run: git config --local core.hooksPath .agents/githooks"; fi
  dg_glob=$(global_hookspath)
  [ -z "$dg_glob" ] || plog warn "$(global_hookspath_msg "$dg_glob")"
}

write_manifest() {
  # shellcheck disable=SC2016
  { echo '# proofline manifest: sha256 and path of every installed file (used by `proofline upgrade`)'
    echo "# version: $PROOFLINE_VERSION"; echo "# profile: $PROFILE"; echo "# runtimes: $RUNTIMES"
    while read -r wm_k wm_h; do echo "# $wm_k: $wm_h"; done < "$STAGE/blocks"
    sort -k2 "$STAGE/manifest.new"; } > "$STAGE/manifest.out"
  if [ -f "$ROOT/$MANIFEST_REL" ] && cmp -s "$STAGE/manifest.out" "$ROOT/$MANIFEST_REL"; then return 0; fi
  plog merged "$MANIFEST_REL"
  [ "$DRY" = 1 ] || cat "$STAGE/manifest.out" > "$ROOT/$MANIFEST_REL"
}

report() { # prints the change summary; sets CHANGES
  CHANGES=$(awk -F'\t' '$1 == "new" || $1 == "update" || $1 == "merged" || $1 == "removed" { n++ } END { print n + 0 }' "$STAGE/plan")
  if [ "$DRY" = 1 ]; then say "proofline $MODE (dry run, nothing written):"; else say "proofline $MODE:"; fi
  awk -F'\t' '
    $1 == "new" { split($2, c, "/"); k = (c[1] == ".agents" || c[1] == ".claude" || c[1] == ".codex") && c[3] != "" ? c[1] "/" c[2] "/" : $2; if (k != $2) grp[k]++; else single[$2] = 1; order[++o] = k; next }
    $1 == "update" { print "  ~ updated   " $2 }
    $1 == "removed" { print "  - removed   " $2 }
    $1 == "merged" { print "  + merged    " $2 }
    $1 == "keep" { print "  = kept      " $2 " (differs from proofline'"'"'s version; yours is untouched)" }
    $1 == "conflict" { print "  ! CONFLICT  " $2 " (modified by you; new version beside it as " $2 ".proofline-new)" }
    $1 == "orphan" { print "  ? " $2 }
    $1 == "warn" { print "  ! WARN      " $2 }
    END {
      for (i = 1; i <= o; i++) { k = order[i]; if (seen[k]++) continue
        if (k in grp) print "  + new       " k " (" grp[k] ")"; else print "  + new       " k }
    }' "$STAGE/plan"
  if [ "$CHANGES" = 0 ]; then say "  no changes"; fi
}

install_run() { # MODE set by the caller
  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/proofline-install.XXXXXX") || die "cannot create a temp directory"
  trap 'rm -rf "$STAGE"' EXIT HUP INT TERM
  : > "$STAGE/plan"; : > "$STAGE/blocks"
  MANIFEST_OLD=$ROOT/$MANIFEST_REL
  stage_build
  place_all
  do_config
  if rt_has claude; then json_merge .claude/settings.json "$PL_HOME/adapters/claude/settings.fragment.json"; fi
  if rt_has codex; then json_merge .codex/hooks.json "$PL_HOME/adapters/codex/hooks.json"; codex_network_config; fi
  merge_block AGENTS.md "$PL_HOME/control-plane/AGENTS.md"
  if rt_has claude; then merge_block CLAUDE.md "$PL_HOME/control-plane/CLAUDE.md"; fi
  ensure_line .gitignore .agents/local/
  ensure_line .gitignore .agents/runs/
  do_githooks_path
  write_manifest
  report
}

cmd_init() {
  OPT_RUNTIMES=${PROOFLINE_RUNTIMES:-}; OPT_LEAD=${PROOFLINE_LEAD:-}; OPT_WORKER=${PROOFLINE_WORKER:-}
  OPT_REVIEWERS=${PROOFLINE_REVIEWERS:-}; OPT_PROFILE=${PROOFLINE_PROFILE:-}; OPT_ADAPTER=${PROOFLINE_TASK_ADAPTER:-}
  OPT_PUSH=${PROOFLINE_PUSH_APPROVAL:-}; OPT_FORBIDDEN=''; OPT_ROLES=''; HAVE_PROTECTED=0; OPT_PROTECTED=''
  if [ -n "${PROOFLINE_PROTECTED_BRANCHES+x}" ]; then HAVE_PROTECTED=1; OPT_PROTECTED=$PROOFLINE_PROTECTED_BRANCHES; fi
  DRY=0; YES=0; VERIFY=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) YES=1 ;;
      --dry-run) DRY=1 ;;
      --verify-commands) VERIFY=1 ;;
      --runtimes) [ $# -ge 2 ] || die "--runtimes needs a value"; OPT_RUNTIMES=$2; shift ;;
      --lead) [ $# -ge 2 ] || die "--lead needs a value"; OPT_LEAD=$2; shift ;;
      --worker) [ $# -ge 2 ] || die "--worker needs a value"; OPT_WORKER=$2; shift ;;
      --reviewers) [ $# -ge 2 ] || die "--reviewers needs a value"; OPT_REVIEWERS=$2; shift ;;
      --profile) [ $# -ge 2 ] || die "--profile needs a value"; OPT_PROFILE=$2; shift ;;
      --task-adapter) [ $# -ge 2 ] || die "--task-adapter needs a value"; OPT_ADAPTER=$2; shift ;;
      --protected-branches) [ $# -ge 2 ] || die "--protected-branches needs a value"; HAVE_PROTECTED=1; OPT_PROTECTED=$2; shift ;;
      --push-approval) [ $# -ge 2 ] || die "--push-approval needs true or false"; OPT_PUSH=$2; shift ;;
      --forbidden-identity) [ $# -ge 2 ] || die "--forbidden-identity needs a pattern"; OPT_FORBIDDEN="${OPT_FORBIDDEN:+$OPT_FORBIDDEN }$2"; shift ;;
      --role) [ -n "${2:-}" ] || die "--role needs ROLE=RUNTIME"; OPT_ROLES="${OPT_ROLES:+$OPT_ROLES }$2"; shift ;;
      *) die "init: unknown argument: $1 (see: proofline help)" ;;
    esac
    shift
  done
  MODE=init
  [ -d "$PL_HOME/control-plane/agents" ] || die "no control-plane/ in $PL_HOME"
  g rev-parse --show-toplevel >/dev/null 2>&1 || die "$ROOT is not a git repository; run git init first"
  ex=$ROOT/.agents/config.yaml
  MANIFEST_OLD=$ROOT/$MANIFEST_REL
  INTERACTIVE=0
  if [ "$YES" != 1 ] && { [ -t 0 ] || [ "${PROOFLINE_PROMPT:-0}" = 1 ]; }; then INTERACTIVE=1; fi

  # resolve: flag/env > existing install > detected default (asked when interactive)
  if [ -z "$OPT_RUNTIMES" ]; then
    d=$(manifest_meta runtimes || true); [ -n "$d" ] || d=$(detect_runtimes); [ -n "$d" ] || d=claude
    ask RUNTIMES "Runtimes to set up (claude, codex)" "$d"
  else RUNTIMES=$OPT_RUNTIMES; fi
  RUNTIMES=$(printf '%s' "$RUNTIMES" | tr ',' ' ' | tr -s ' ' | sed 's/^ //; s/ $//')
  [ -n "$RUNTIMES" ] || die "no runtime selected"
  for r in $RUNTIMES; do case "$r" in claude|codex) ;; *) die "unknown runtime: $r (claude or codex)" ;; esac; done
  first=${RUNTIMES%% *}
  pick() { # VAR OPT PROMPT CONFIGKEY DEFAULT ALLOWED
    if [ -n "$2" ]; then eval "$1=\$2"
    else pk_d=$(cfg_val "$ex" "$4" "$5"); ask "$1" "$3" "$pk_d"; fi
    eval "pk_v=\$$1"
    # shellcheck disable=SC2154 # pk_v is set by the eval above
    case "|$6|" in *"|$pk_v|"*) ;; *) die "invalid value for $3: $pk_v (want $6)" ;; esac
  }
  pick LEAD "$OPT_LEAD" "Lead runtime" runtime.lead "$first" "claude|codex"
  pick WORKER "$OPT_WORKER" "Worker runtime" runtime.worker "$LEAD" "claude|codex"
  pick REVIEWERS "$OPT_REVIEWERS" "Reviewer runtime" runtime.reviewers "$LEAD" "claude|codex"
  for r in $LEAD $WORKER $REVIEWERS; do rt_has "$r" || die "runtime $r is used by the config but not in --runtimes ($RUNTIMES)"; done
  for r in $OPT_ROLES; do # --role ROLE=RUNTIME: the role must have a roles/<ROLE>.md, the runtime must be one of --runtimes
    case "$r" in ?*=?*) ;; *) die "invalid --role value: $r (want ROLE=RUNTIME, for example implementer=codex)" ;; esac
    case "${r%%=*}" in *[!a-z_]*|README) false ;; *) [ -f "$PL_HOME/roles/${r%%=*}.md" ] ;; esac || die "unknown role in --role: ${r%%=*} (want a name from roles/*.md, for example implementer)"
    case "${r#*=}" in claude|codex) ;; *) die "unknown runtime in --role: ${r#*=} (claude or codex)" ;; esac
    rt_has "${r#*=}" || die "runtime ${r#*=} is used by --role $r but not in --runtimes ($RUNTIMES)"
  done
  pick PROFILE "$OPT_PROFILE" "Model profile (max, balanced, economy)" profile balanced "max|balanced|economy"
  pick ADAPTER "$OPT_ADAPTER" "Task adapter (markdown, github, jira, linear)" tasks.adapter markdown "markdown|github|jira|linear"
  pick PUSH "$OPT_PUSH" "Pushes need your approval (true, false)" git.push_requires_approval true "true|false"
  if [ "$HAVE_PROTECTED" = 1 ]; then PROTECTED=$OPT_PROTECTED
  else ask PROTECTED "Protected branches, space separated (empty: none)" "$(cfg_val "$ex" git.protected_branches '')"; fi
  if [ -n "$OPT_FORBIDDEN" ]; then FORBIDDEN=$OPT_FORBIDDEN
  else ask FORBIDDEN "Forbidden commit identities, space separated patterns (empty: none)" "$(cfg_val "$ex" git.forbidden_identities '')"; fi
  CANON=$(detect_branch)
  D_BUILD=''; D_TEST=''; D_LINT=''
  if [ ! -f "$ex" ] || [ -z "$(cfg_val "$ex" commands.test '')$(cfg_val "$ex" commands.build '')" ]; then
    discover_commands "$ROOT"
    say "discovered commands: build='${D_BUILD:-}' test='${D_TEST:-}' lint='${D_LINT:-}'"
    [ "$VERIFY" != 1 ] || { say "verifying commands (trial runs)..."; verify_commands "$ROOT"; }
  fi
  install_run
  if [ "$DRY" != 1 ]; then
    say ""
    say "next: proofline doctor    (verifies hooks, runtimes and every enforced rule)"
    say "      commit the installed files (.agents/, AGENTS.md, CLAUDE.md, runtime adapter files) when you are happy"
  fi
}

cmd_upgrade() {
  DRY=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1 ;;
      --yes|-y) ;;
      *) die "upgrade: unknown argument: $1" ;;
    esac
    shift
  done
  MODE=upgrade
  [ -f "$ROOT/.agents/config.yaml" ] || die "proofline is not installed in $ROOT; run: proofline init"
  MANIFEST_OLD=$ROOT/$MANIFEST_REL
  [ -f "$MANIFEST_OLD" ] || warn "no $MANIFEST_REL: every differing file counts as modified by you"
  cf=$ROOT/.agents/config.yaml
  PROFILE=$(cfg_val "$cf" profile balanced)
  RUNTIMES=$(manifest_meta runtimes || true)
  [ -n "$RUNTIMES" ] || RUNTIMES=$(printf '%s %s %s\n' "$(cfg_val "$cf" runtime.lead claude)" "$(cfg_val "$cf" runtime.worker '')" "$(cfg_val "$cf" runtime.reviewers '')" | tr ' ' '\n' | grep . | sort -u | tr '\n' ' ' | sed 's/ $//')
  old=$(manifest_meta version || true)
  say "proofline upgrade ${old:+from $old }to $PROOFLINE_VERSION (profile $PROFILE, runtimes: $RUNTIMES)"
  D_BUILD=''; D_TEST=''; D_LINT=''
  install_run
  if awk -F'\t' '$1 == "conflict"' "$STAGE/plan" | grep -q .; then
    say ""; say "conflicts: files you modified were kept. Compare each with its .proofline-new copy, merge by hand, then delete the copy."
  fi
  # The default design document moved out of the root (0.0.3); offer the move, never do it, never touch the config.
  if [ -f "$ROOT/DESIGN.md" ] && [ "$(cfg_val "$cf" design_docs.design docs/design/DESIGN.md)" != DESIGN.md ]; then
    say ""; say "offer: DESIGN.md sits at the project root; the default location is now docs/design/DESIGN.md. To move it: git mv DESIGN.md docs/design/DESIGN.md (then update design_docs.design if set). Nothing was moved."
  fi
}
