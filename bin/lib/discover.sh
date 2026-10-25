#!/bin/sh
# Command discovery for `proofline init` (D8, A173): fills D_BUILD, D_TEST and D_LINT from the project's own
# files. proofline never assumes a folder layout: root, nested, multi-project and monorepo layouts are equal.
# Order: the project's declared scripts (package.json, composer.json) at the root, the Makefile / justfile /
# Taskfile, the ecosystem's build files at the root, the same for a single nested project, then CI
# configuration, then the README. The ecosystem steps (scripts, build files, nested project) add one command per
# ecosystem, so a .NET solution at the root and a nested npm frontend give a LIST of two (A173); a Makefile,
# justfile or Taskfile command, or a CI or README line, covers the whole repository and is the only candidate. What each ecosystem looks like (marker files, workspace roots, command
# templates, prune dirs) is read from control-plane/agents/ecosystems.json through ecosystems.tsv.
# A command is only a candidate until `--verify-commands` proves it with a trial run. With zero or several
# candidate targets of ONE ecosystem no command is proposed for it (the run asks the user once, 0.0.5), never a
# command that fails; the other ecosystems still get theirs.
# Sourced by bin/proofline, which provides say/warn/die, sha256, PL_HOME, ROOT, PROOFLINE_VERSION.

# D_BUILD, D_TEST and D_LINT hold one command per line (several lines: a command list, written as a block list under the key).
D_BUILD=''; D_TEST=''; D_LINT=''; D_CLOSED=''; D_AMBIG=''

# The ecosystem definition (shipped with the control plane); without it only the project's own text is read.
D_ECO=''
if [ -f "${PL_HOME:-/nonexistent}/control-plane/agents/scripts/ecosystems.sh" ]; then
  # shellcheck source=/dev/null # control-plane/agents/scripts/ecosystems.sh, found through PL_HOME
  . "$PL_HOME/control-plane/agents/scripts/ecosystems.sh"
  ! eco_init "$PL_HOME/control-plane/agents/ecosystems.tsv" || D_ECO=1
fi

d_cur() { case "$1" in build) printf '%s' "$D_BUILD" ;; test) printf '%s' "$D_TEST" ;; lint) printf '%s' "$D_LINT" ;; esac; }
d_put() { case "$1" in build) D_BUILD=$2 ;; test) D_TEST=$2 ;; lint) D_LINT=$2 ;; esac; }
# d_set KIND CMD: a command that covers the whole repository (Makefile, justfile, Taskfile, CI, README): first writer wins,
# and a kind it writes takes no further ecosystem command.
d_set() {
  [ -z "$(d_cur "$1")" ] || return 0
  d_put "$1" "$2"; D_CLOSED="$D_CLOSED $1"
}
# d_add KIND CMD: the command of one ecosystem's project; added to the list of KIND (once) unless a covering command wrote it.
d_add() {
  case " $D_CLOSED " in *" $1 "*) return 0 ;; esac
  da_cur=$(d_cur "$1")
  case "
$da_cur
" in *"
$2
"*) return 0 ;; esac
  d_put "$1" "${da_cur:+$da_cur
}$2"
}
# d_join LINES: the commands of a list on one line, "a; b" (for messages)
d_join() { printf '%s\n' "$1" | awk 'NF { printf "%s%s", (n++ ? "; " : ""), $0 }'; }

# d_pkg_script ROOT NAME [FILE]: the script body in package.json (or another JSON file with `scripts`), empty when absent.
d_pkg_script() {
  dps_f=$1/${3:-package.json}
  if command -v jq >/dev/null 2>&1; then jq -r --arg n "$2" '.scripts[$n] // empty' "$dps_f" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then node -e 'try { const s = (JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).scripts || {})[process.argv[2]]; if (s) console.log(s) } catch (e) {}' "$dps_f" "$2"
  else grep -Eq "\"$2\"[[:space:]]*:" "$dps_f" 2>/dev/null && echo present; fi
}

d_make() { # ROOT
  for dm_f in Makefile makefile GNUmakefile; do
    [ -f "$1/$dm_f" ] || continue
    for dm_k in build test lint; do
      grep -Eq "^${dm_k}[[:space:]]*:" "$1/$dm_f" && d_set "$dm_k" "make $dm_k"
    done
    return 0
  done
}

d_just() { # ROOT: recipes without parameters
  for dj_f in justfile Justfile .justfile; do
    [ -f "$1/$dj_f" ] || continue
    for dj_k in build test lint; do
      grep -Eq "^${dj_k}[[:space:]]*:([^=]|\$)" "$1/$dj_f" && d_set "$dj_k" "just $dj_k"
    done
    return 0
  done
}

d_taskfile() { # ROOT
  for dt_f in Taskfile.yml Taskfile.yaml taskfile.yml taskfile.yaml; do
    [ -f "$1/$dt_f" ] || continue
    grep -Eq '^tasks:' "$1/$dt_f" || return 0
    for dt_k in build test lint; do
      grep -Eq "^[[:space:]]{2,4}${dt_k}:[[:space:]]*(#.*)?\$" "$1/$dt_f" && d_set "$dt_k" "task $dt_k"
    done
    return 0
  done
}

# --- ecosystem-driven discovery (A173) ---------------------------------------------------------------------
# d_safe_path P: a relative path that is safe to store unquoted in a command (no space, quote, $, backtick or leading dash)
d_safe_path() { case "$1" in ''|-*|*[!A-Za-z0-9._/+@-]*) return 1 ;; esac; return 0; }

# d_subst TEMPLATE NAME VALUE: replaces every {NAME}
d_subst() {
  ds_t=$1; ds_o=''
  while :; do
    case "$ds_t" in
      *"{$2}"*) ds_o=$ds_o${ds_t%%"{$2}"*}$3; ds_t=${ds_t#*"{$2}"} ;;
      *) break ;;
    esac
  done
  printf '%s' "$ds_o$ds_t"
}

# d_when UNIT ROOT ID PATH: every condition under the `when` object at PATH holds (no condition: true).
# Keys: file, any_file, not_file, dir (in UNIT); in + contains (a line of one of the files matches the ERE);
# script (+ script_file, script_not); root_file (in the project root). An unknown key is false.
d_when() {
  dw_u=$1; dw_r=$2; dw_id=$3; dw_p=$4
  for dw_k in $(eco_children "$dw_id" "$dw_p"); do
    case "$dw_k" in
      file) for dw_v in $(eco_get "$dw_id" "$dw_p.file"); do [ -f "$dw_u/$dw_v" ] || return 1; done ;;
      any_file) dw_any=''; for dw_v in $(eco_get "$dw_id" "$dw_p.any_file"); do [ ! -f "$dw_u/$dw_v" ] || dw_any=1; done; [ -n "$dw_any" ] || return 1 ;;
      not_file) for dw_v in $(eco_get "$dw_id" "$dw_p.not_file"); do [ ! -e "$dw_u/$dw_v" ] || return 1; done ;;
      dir) for dw_v in $(eco_get "$dw_id" "$dw_p.dir"); do [ -d "$dw_u/$dw_v" ] || return 1; done ;;
      root_file) for dw_v in $(eco_get "$dw_id" "$dw_p.root_file"); do [ -f "$dw_r/$dw_v" ] || return 1; done ;;
      in)
        dw_any=''; dw_pat=$(eco_first "$dw_id" "$dw_p.contains")
        for dw_v in $(eco_get "$dw_id" "$dw_p.in"); do
          [ -f "$dw_u/$dw_v" ] || continue
          if [ -z "$dw_pat" ] || grep -Eq -- "$dw_pat" "$dw_u/$dw_v" 2>/dev/null; then dw_any=1; fi
        done
        [ -n "$dw_any" ] || return 1 ;;
      contains) [ -n "$(eco_get "$dw_id" "$dw_p.in")" ] || return 1 ;;
      script)
        dw_sf=$(eco_first "$dw_id" "$dw_p.script_file"); dw_sf=${dw_sf:-package.json}
        dw_sb=$(d_pkg_script "$dw_u" "$(eco_first "$dw_id" "$dw_p.script")" "$dw_sf")
        [ -n "$dw_sb" ] || return 1
        dw_no=$(eco_first "$dw_id" "$dw_p.script_not")
        if [ -n "$dw_no" ] && printf '%s' "$dw_sb" | grep -Eq -- "$dw_no"; then return 1; fi ;;
      script_file|script_not) ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# d_runner ID UNIT ROOT: sets D_RVN (variable names) and D_RV_<name> from the first runner whose `when` holds.
d_runner() {
  D_RVN=''
  for drn_i in $(eco_children "$1" commands.runners); do
    d_when "$2" "$3" "$1" "commands.runners.$drn_i.when" || continue
    for drn_k in $(eco_children "$1" "commands.runners.$drn_i"); do
      [ "$drn_k" != when ] || continue
      D_RVN="$D_RVN $drn_k"
      eval "D_RV_$drn_k=\$(eco_first \"\$1\" \"commands.runners.\$drn_i.\$drn_k\")"
    done
    return 0
  done
}

# d_rule ID KIND MODE UNIT ROOT DIR TARGET: prints the command of the first rule of KIND whose `when` holds and
# that has a template for MODE (bare: `run`, targeted: `at`); returns 1 when there is none.
d_rule() {
  dr_id=$1; dr_kind=$2; dr_mode=$3; dr_unit=$4; dr_root=$5; dr_dir=$6; dr_tgt=$7
  d_runner "$dr_id" "$dr_unit" "$dr_root"
  for dr_i in $(eco_children "$dr_id" "commands.$dr_kind"); do
    d_when "$dr_unit" "$dr_root" "$dr_id" "commands.$dr_kind.$dr_i.when" || continue
    if [ "$dr_mode" = bare ]; then dr_t=$(eco_first "$dr_id" "commands.$dr_kind.$dr_i.run"); else dr_t=$(eco_first "$dr_id" "commands.$dr_kind.$dr_i.at"); fi
    [ -n "$dr_t" ] || continue
    for dr_n in $D_RVN; do dr_v=; eval "dr_v=\$D_RV_$dr_n"; dr_t=$(d_subst "$dr_t" "$dr_n" "$dr_v"); done
    dr_t=$(d_subst "$dr_t" dir "$dr_dir"); dr_t=$(d_subst "$dr_t" target "$dr_tgt")
    case "$dr_t" in *'{'*|*'}'*) continue ;; esac
    printf '%s\n' "$dr_t"; return 0
  done
  return 1
}

# d_markers ROOT: D_MARKERS = the marker files (project files, solution files, workspace root files of every
# ecosystem) below ROOT, relative, sorted, with the global prune dirs not entered. D_TRUNC=1 when there are more
# than global.limits.discover_max_markers (then nothing nested is trusted). No depth limit.
d_markers() {
  D_MARKERS=''; D_TRUNC=''
  dm_cap=$(eco_first '*' limits.discover_max_markers); dm_cap=${dm_cap:-1000}
  dm_pr=''; for dm_d in $(eco_get '*' prune); do dm_pr="$dm_pr -o -name $dm_d"; done
  dm_nm=''
  for dm_n in $( { eco_union project_files; eco_union solution_files; eco_match '^workspace_roots\.[0-9]+\.file$' | cut -f3; } | sort -u ); do dm_nm="$dm_nm -o -name $dm_n"; done
  [ -n "$dm_nm" ] || return 0
  set -f
  # shellcheck disable=SC2086 # the expressions are built from plain names and are word-split on purpose, with globbing off
  D_MARKERS=$(cd "$1" && find . \( ${dm_pr# -o } \) -type d -prune -o -type f \( ${dm_nm# -o } \) -print 2>/dev/null | sed 's|^\./||' | LC_ALL=C sort | head -n "$((dm_cap + 1))")
  set +f
  if [ "$(printf '%s\n' "$D_MARKERS" | grep -c .)" -gt "$dm_cap" ]; then D_TRUNC=1; D_MARKERS=$(printf '%s\n' "$D_MARKERS" | head -n "$dm_cap"); fi
}

# d_hits ID: `P path` (project file), `S path` (solution file) and `W path` (a workspace root file name) for one
# ecosystem, skipping the global and the ecosystem's prune dirs.
d_hits() {
  dh_ws=''
  for dh_i in $(eco_children "$1" workspace_roots); do dh_ws="$dh_ws $(eco_first "$1" "workspace_roots.$dh_i.file")"; done
  printf '%s\n' "$D_MARKERS" | awk -v proj="$(eco_get "$1" project_files | tr '\n' ' ')" -v sol="$(eco_get "$1" solution_files | tr '\n' ' ')" \
    -v ws="$dh_ws" -v pr="$({ eco_get '*' prune; eco_get "$1" prune; } | tr '\n' ' ')" "$ECO_G2RE"'
    function hit(list,   k, x, j) { k = split(list, x, " "); for (j = 1; j <= k; j++) if (x[j] != "" && $0 ~ g2re(x[j])) return 1; return 0 }
    BEGIN { n = split(pr, a, " "); for (i = 1; i <= n; i++) if (a[i] != "") pd[a[i]] = 1 }
    $0 == "" { next }
    { m = split($0, s, "/"); for (i = 1; i < m; i++) if (s[i] in pd) next
      if (hit(proj)) print "P\t" $0
      if (hit(sol)) print "S\t" $0
      if (hit(ws)) print "W\t" $0 }'
}

# d_ws_ok ROOT ID FILE: FILE (a W hit) is a workspace root: one rule of workspace_roots names it and its `contains` matches.
d_ws_ok() {
  dwo_b=${3##*/}
  for dwo_i in $(eco_children "$2" workspace_roots); do
    [ "$(eco_first "$2" "workspace_roots.$dwo_i.file")" = "$dwo_b" ] || continue
    dwo_c=$(eco_first "$2" "workspace_roots.$dwo_i.contains")
    [ -z "$dwo_c" ] && return 0
    grep -Eq -- "$dwo_c" "$1/$3" 2>/dev/null && return 0
  done
  return 1
}

# d_unit_dirs ROOT ID HITS: the outermost directories (one per line) that hold a project file or a confirmed workspace root.
d_unit_dirs() {
  printf '%s\n' "$3" | while IFS="	" read -r du_k du_f; do
    if [ "$du_k" = W ]; then d_ws_ok "$1" "$2" "$du_f" || continue; elif [ "$du_k" != P ]; then continue; fi
    case "$du_f" in */*) printf '%s\n' "${du_f%/*}" ;; *) printf '.\n' ;; esac
  done | sort -u | awk '{ d[NR] = $0 } END { for (i = 1; i <= NR; i++) { keep = 1
    for (j = 1; j <= NR; j++) if (i != j && (d[j] == "." || index(d[i], d[j] "/") == 1)) { keep = 0; break }
    if (keep) print d[i] } }'
}

# d_names LINES: up to four names, comma separated, then "..."
d_names() { printf '%s\n' "$1" | awk 'NF { n++; if (n <= 4) printf "%s%s", (n > 1 ? ", " : ""), $0 } END { if (n > 4) printf ", ..." }'; }

# d_select ROOT ID: picks the one target of an ecosystem. Sets D_SEL_MODE (bare | targeted | none), D_SEL_DIR
# (the unit directory, . for the root) and D_SEL_TARGET (the file, for a file-target ecosystem).
#   dir target: the outermost directories that hold a project file or a workspace root (members of a workspace
#     are covered by it); exactly one is the target, the root is run bare.
#   file target (units.stages): the first stage that has candidates decides; exactly one candidate is the target,
#     several are ambiguous (none). A legacy twin (units.legacy: a .sln beside a same-name .slnx) is ignored.
d_select() {
  D_SEL_MODE=none; D_SEL_DIR=.; D_SEL_TARGET=''; D_SEL_WHY=''
  ds_hits=$(d_hits "$2")
  [ -n "$ds_hits" ] || return 0
  if [ "$(eco_first "$2" units.target)" = file ]; then
    for ds_l in $(eco_children "$2" units.legacy); do
      ds_keep=$(eco_first "$2" "units.legacy.$ds_l.keep"); ds_drop=$(eco_first "$2" "units.legacy.$ds_l.drop")
      ds_hits=$(printf '%s\n' "$ds_hits" | awk -F'\t' -v k="$ds_keep" -v d="$ds_drop" '
        { f[NR] = $0; p[$2] = 1 }
        END { for (i = 1; i <= NR; i++) { split(f[i], a, "\t"); x = a[2]
          if (length(x) > length(d) && substr(x, length(x) - length(d) + 1) == d && ((substr(x, 1, length(x) - length(d)) k) in p)) continue
          print f[i] } }')
    done
    for ds_s in $(eco_get "$2" units.stages); do
      case "$ds_s" in solution_files@*) ds_k=S ;; project_files@*) ds_k=P ;; *) continue ;; esac
      ds_w=${ds_s#*@}
      ds_set=$(printf '%s\n' "$ds_hits" | awk -F'\t' -v k="$ds_k" -v w="$ds_w" '$1 == k { r = index($2, "/") == 0; if ((w == "root") == r) print $2 }')
      if [ -z "$ds_set" ]; then
        [ "$ds_w" = root ] || [ -z "$D_TRUNC" ] || return 0   # a truncated search cannot say there is no nested candidate
        continue
      fi
      if [ "$(printf '%s\n' "$ds_set" | grep -c .)" -ne 1 ]; then D_SEL_WHY="several targets: $(d_names "$ds_set")"; return 0; fi
      d_safe_path "$ds_set" || { D_SEL_WHY="a path with a space or an unusual character: $ds_set"; return 0; }
      D_SEL_TARGET=$ds_set
      case "$ds_set" in */*) D_SEL_DIR=${ds_set%/*} ;; *) D_SEL_DIR=. ;; esac
      if [ "$ds_s" = "$(eco_first "$2" units.bare)" ]; then D_SEL_MODE=bare; else D_SEL_MODE=targeted; fi
      return 0
    done
    return 0
  fi
  ds_dirs=$(d_unit_dirs "$1" "$2" "$ds_hits")
  [ -n "$ds_dirs" ] || return 0
  if [ "$ds_dirs" = . ]; then D_SEL_MODE=bare; D_SEL_DIR=.; return 0; fi
  [ -z "$D_TRUNC" ] || { D_SEL_WHY="more marker files than the search reads"; return 0; }
  [ "$(printf '%s\n' "$ds_dirs" | grep -c .)" -eq 1 ] || { D_SEL_WHY="several projects: $(d_names "$ds_dirs")"; return 0; }
  d_safe_path "$ds_dirs" || { D_SEL_WHY="a path with a space or an unusual character: $ds_dirs"; return 0; }
  D_SEL_DIR=$ds_dirs; D_SEL_MODE=targeted
}

# d_plan ROOT: D_PLAN = one line `id|mode|dir|target` per ecosystem that has exactly one target. An ecosystem with several
# targets (or an unsafe path) gets no command; D_AMBIG = one line `id|reason` for each, so the run can say it asks the user.
d_plan() {
  D_PLAN=''; D_AMBIG=''
  [ -n "$D_ECO" ] || return 0
  d_markers "$1"
  [ -n "$D_MARKERS" ] || return 0
  for dp_id in $(eco_ids); do
    d_select "$1" "$dp_id"
    if [ "$D_SEL_MODE" = none ]; then
      [ -z "$D_SEL_WHY" ] || D_AMBIG="$D_AMBIG
$dp_id|$D_SEL_WHY"
      continue
    fi
    D_PLAN="$D_PLAN
$dp_id|$D_SEL_MODE|$D_SEL_DIR|$D_SEL_TARGET"
  done
}

# d_apply ROOT WHERE TRUTH: prints `kind<TAB>command` for the planned targets. WHERE root (unit directory .) or
# nested; TRUTH scripts (commands read from the project's declared scripts), tools, or any.
d_apply() {
  [ -n "$D_PLAN" ] || return 0
  printf '%s\n' "$D_PLAN" | while IFS='|' read -r da_id da_mode da_dir da_tgt; do
    [ -n "$da_id" ] || continue
    if [ "$da_dir" = . ]; then [ "$2" = root ] || continue; else [ "$2" = nested ] || continue; fi
    [ "$3" = any ] || [ "$(eco_first "$da_id" commands.truth)" = "$3" ] || continue
    if [ "$da_dir" = . ]; then da_unit=$1; else da_unit=$1/$da_dir; fi
    for da_k in build test lint; do
      da_c=$(d_rule "$da_id" "$da_k" "$da_mode" "$da_unit" "$1" "$da_dir" "$da_tgt") || continue
      printf '%s\t%s\n' "$da_k" "$da_c"
    done
  done
}

# d_apply_set ROOT WHERE TRUTH: d_apply, recorded with d_add (a pipe would lose the variables).
d_apply_set() {
  das_out=$(d_apply "$1" "$2" "$3")
  [ -n "$das_out" ] || return 0
  while IFS="	" read -r das_k das_c; do d_add "$das_k" "$das_c"; done <<D_EOF
$das_out
D_EOF
}

# d_scan FILE...: candidate command lines (YAML `run:` / `- ` items, README code lines) of known tools.
d_scan() {
  D_TOOLS_RE=${D_TOOLS_RE:-'npm|pnpm|yarn|bun|go|cargo|dotnet|make|pytest|mvn|gradle|\./gradlew|ruff|eslint'} awk '
    BEGIN { tools = "^(" ENVIRON["D_TOOLS_RE"] ")[[:space:]]" }
    { l = $0
      sub(/^[[:space:]]+/, "", l); sub(/^[-][[:space:]]+/, "", l); sub(/^(run|script):[[:space:]]*/, "", l)
      sub(/^[$][[:space:]]+/, "", l); sub(/^`/, "", l); sub(/`$/, "", l); gsub(/^["\047]|["\047]$/, "", l)
      # shell control operators, redirections, substitutions and templating: never a candidate (it would be trial-run)
      if (l ~ tools && l !~ /[&;|<>`]|[$][{(]|\{\{/ && length(l) < 80) print l
    }' "$@" 2>/dev/null
}

d_ci_readme() { # ROOT
  dc_files=''
  for dc_f in "$1"/.github/workflows/*.yml "$1"/.github/workflows/*.yaml "$1/.gitlab-ci.yml" "$1/.circleci/config.yml" "$1/azure-pipelines.yml" "$1/Jenkinsfile" "$1/bitbucket-pipelines.yml" "$1"/README*; do
    [ -f "$dc_f" ] && dc_files="$dc_files $dc_f"
  done
  [ -n "$dc_files" ] || return 0
  # shellcheck disable=SC2086 # the file list has no spaces by construction of the loop above
  dc_c=$(d_scan $dc_files)
  [ -n "$dc_c" ] || return 0
  dc_l=$(printf '%s\n' "$dc_c" | grep -E "$D_CI_BUILD" | head -1); [ -z "$dc_l" ] || d_set build "$dc_l"
  dc_l=$(printf '%s\n' "$dc_c" | grep -E "$D_CI_TEST" | head -1); [ -z "$dc_l" ] || d_set test "$dc_l"
  dc_l=$(printf '%s\n' "$dc_c" | grep -E "$D_CI_LINT" | head -1); [ -z "$dc_l" ] || d_set lint "$dc_l"
}

# d_patterns: D_TOOLS_RE (the executables a CI or README line may start with) and the build / test / lint line
# patterns, from the ecosystem definition (the built-in ones when it is missing).
d_patterns() {
  D_CI_BUILD=' (build|compile|package)( |$)'
  D_CI_TEST=' (test|tests|pytest)( |$)|^pytest'
  D_CI_LINT=' (lint|vet|clippy)( |$)|^(ruff|eslint)'
  D_TOOLS_RE=''
  [ -n "$D_ECO" ] || return 0
  dp_v=$(eco_first '*' ci_scan.build); [ -z "$dp_v" ] || D_CI_BUILD=$dp_v
  dp_v=$(eco_first '*' ci_scan.test); [ -z "$dp_v" ] || D_CI_TEST=$dp_v
  dp_v=$(eco_first '*' ci_scan.lint); [ -z "$dp_v" ] || D_CI_LINT=$dp_v
  dp_x=$(eco_union commands.ci_lint | paste -sd'|' -)
  [ -z "$dp_x" ] || D_CI_LINT="$D_CI_LINT|$dp_x"
  D_TOOLS_RE=$( { eco_get '*' ci_scan.tools; eco_union commands.tools; } | sed 's/\./\\./g' | paste -sd'|' -)
}

# d_ambig_notes: one line per ecosystem that got no command because its target is ambiguous (D_AMBIG). The user is asked
# once, after a run that proved a command (the 0.0.5 flow), never given a guess.
d_ambig_notes() {
  [ -n "$D_AMBIG" ] || return 0
  printf '%s\n' "$D_AMBIG" | while IFS='|' read -r dn_id dn_why; do
    [ -n "$dn_id" ] || continue
    dn_n=$(eco_first "$dn_id" name 2>/dev/null); dn_n=${dn_n%% (*}; printf '%s\n' "no command proposed for ${dn_n:-$dn_id} ($dn_why); a run that proves one asks you once to add it"
  done
}

# discover_commands ROOT: sets D_BUILD D_TEST D_LINT (one command per line; empty when nothing was found) and D_AMBIG.
discover_commands() {
  D_BUILD=''; D_TEST=''; D_LINT=''; D_CLOSED=''
  d_patterns; d_plan "$1"
  d_apply_set "$1" root scripts
  d_make "$1"; d_just "$1"; d_taskfile "$1"
  d_apply_set "$1" root tools
  d_apply_set "$1" nested any
  d_ci_readme "$1"
}

# Process-group helpers. nap, grp_alive and pg_start are the same text as in control-plane/agents/scripts/batch.sh (A161):
# the CLI and the control plane install separately, so each keeps its own copy and a test compares the function bodies.
G_PID=''
nap() { sleep 0.2 2>/dev/null || sleep 1; }
grp_alive() { ps -A -o pgid=,stat= 2>/dev/null | awk -v g="$1" '$1 == g && $2 !~ /^Z/ { f = 1 } END { exit !f }'; }
# pg_start METHOD OUT CMD...: start CMD in the background as a group leader by METHOD (G_PID is its pid); 1 when the method is unavailable
pg_start() {
  pgs_m=$1; pgs_o=$2; shift 2
  case "$pgs_m" in
    setm) case $- in *m*) ;; *) set -m 2>/dev/null || return 1 ;; esac
      case $- in *m*) ;; *) return 1 ;; esac
      "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$!; set +m 2>/dev/null || : ;;
    setsid) command -v setsid >/dev/null 2>&1 || return 1
      setsid "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    perl) command -v perl >/dev/null 2>&1 || return 1
      perl -e 'use POSIX; setpgid(0, 0) or die "setpgid: $!\n"; exec @ARGV or die "exec: $!\n"' "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    python) command -v python3 >/dev/null 2>&1 || return 1
      python3 -c 'import os, sys; os.setpgid(0, 0); os.execvp(sys.argv[1], sys.argv[1:])' "$@" >> "$pgs_o" 2>&1 < /dev/null &
      G_PID=$! ;;
    *) return 1 ;;
  esac
}
# pg_probe METHOD: 0 when a process started by that method is the leader of a group of its own
pg_probe() {
  pp_f=$(mktemp "${TMPDIR:-/tmp}/proofline-pg.XXXXXX") || return 1; G_PID=''
  pg_start "$1" "$pp_f" sh -c 'ps -o pgid= -p $$' || { rm -f "$pp_f"; G_PID=''; return 1; }
  pp_p=$G_PID; G_PID=''; wait "$pp_p" 2>/dev/null || :
  pp_v=$(tr -d ' \n' < "$pp_f" 2>/dev/null || :); rm -f "$pp_f"
  case "$pp_p" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ "$pp_v" = "$pp_p" ]
}
# pg_pick: prints the first method that works on this machine (none when no method works). Under PROOFLINE_TEST=1,
# PROOFLINE_PGMETHOD=<method> tries only that method.
pg_pick() {
  pk_l='setm setsid perl python'
  if [ "${PROOFLINE_TEST:-}" = 1 ] && [ -n "${PROOFLINE_PGMETHOD:-}" ]; then pk_l=$PROOFLINE_PGMETHOD; fi
  for pk_m in $pk_l; do if pg_probe "$pk_m"; then printf '%s\n' "$pk_m"; return 0; fi; done
  return 1
}
# pg_close PID: TERM, a short grace, then KILL, to the process group PID leads. Only a group verified to be led by PID
# is signalled (never 0, 1 or this shell's own group); otherwise only PID itself gets TERM.
pg_close() {
  pc_g=$1
  case "$pc_g" in ''|*[!0-9]*|0|1|"$$") return 0 ;; esac
  pc_own=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')
  if [ "$pc_g" = "$pc_own" ] || [ "$(ps -o pgid= -p "$pc_g" 2>/dev/null | tr -d ' ')" != "$pc_g" ]; then kill "$pc_g" 2>/dev/null || :; return 0; fi
  kill -TERM "-$pc_g" 2>/dev/null || :
  pc_i=0; while [ "$pc_i" -lt 15 ] && grp_alive "$pc_g"; do nap; pc_i=$((pc_i + 1)); done
  ! grp_alive "$pc_g" || kill -KILL "-$pc_g" 2>/dev/null || :
  pc_i=0; while [ "$pc_i" -lt 10 ] && grp_alive "$pc_g"; do nap; pc_i=$((pc_i + 1)); done
}

# run_with_timeout SECONDS CMD...: runs CMD with output to $RW_OUT (default: discarded); 124 on timeout. CMD runs as the
# leader of its own process group, and a timeout closes the whole group, so no grandchild of a hung `sh -c` lingers.
run_with_timeout() {
  rw_s=$1; shift; rw_m=$(pg_pick) || rw_m=''
  : > "${RW_OUT:-/dev/null}"
  if [ -n "$rw_m" ] && pg_start "$rw_m" "${RW_OUT:-/dev/null}" "$@"; then rw_p=$G_PID; G_PID=''
  else
    # shortcut: with no process-group method a timeout kills the direct child only; improve when a platform without set -m, setsid, perl and python3 must be supported.
    rw_m=''; "$@" >"${RW_OUT:-/dev/null}" 2>&1 < /dev/null &
    rw_p=$!
  fi
  rw_t=0
  while kill -0 "$rw_p" 2>/dev/null; do
    if [ "$rw_t" -ge "$rw_s" ]; then
      if [ -n "$rw_m" ]; then pg_close "$rw_p"; else kill "$rw_p" 2>/dev/null; fi
      wait "$rw_p" 2>/dev/null; return 124
    fi
    sleep 1; rw_t=$((rw_t + 1))
  done
  wait "$rw_p"
} 2>/dev/null   # the shell's own "Terminated" job notices

# d_safe CMD: no shell control operator, redirection or substitution (a trial run would execute it).
# shellcheck disable=SC2016 # literal $( and ${ patterns
d_safe() { case "$1" in *['&;|<>`']*|*'$('*|*'${'*|*'{{'*) return 1 ;; esac; return 0; }

# verify_commands ROOT: trial-runs every discovered command (timeout 600 s each, one by one, also inside a list); a failing
# one is dropped and the others of its list stay.
verify_commands() {
  for vc_k in build test lint; do
    vc_all=$(d_cur "$vc_k"); [ -n "$vc_all" ] || continue
    vc_keep=''
    while IFS= read -r vc_c; do
      [ -n "$vc_c" ] || continue
      d_safe "$vc_c" || { say "  commands.$vc_k has shell operators, not trial-run and left empty: $vc_c"; continue; }
      if (cd "$1" && run_with_timeout 600 sh -c "$vc_c" < /dev/null); then say "  verified commands.$vc_k: $vc_c"; vc_keep="${vc_keep:+$vc_keep
}$vc_c"
      else say "  commands.$vc_k trial failed, left empty: $vc_c"; fi
    done <<VC_EOF
$vc_all
VC_EOF
    d_put "$vc_k" "$vc_keep"
  done
}
