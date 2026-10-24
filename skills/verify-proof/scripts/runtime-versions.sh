#!/bin/sh
# Runtime versions (0.0.26, A173): the language runtime versions the project's CI specifies against the ones installed
# here. Read-only, installs nothing, never fails the caller: a difference is information, never a block.
#
# Usage: sh runtime-versions.sh [DIR]      (DIR defaults to the current directory)
# Prints one line per runtime found, or `runtime: none (...)`:
#   runtime: <name> local=<version|missing> ci=<spec|none> source=<file|-> status=<match|mismatch|unknown>
# Which runtimes exist, which files show that a project uses one (`runtime.present`), where its version is written
# (`version_files`) and how the local version is read come from the ecosystem definition (references/ecosystems.tsv,
# generated from control-plane/agents/ecosystems.json): node, java, python, go, rust, dotnet, php, ruby, swift, dart.
# The project is not assumed to be laid out in any way: the root is read first, then the same files in nested
# directories (build output, dependency and tool folders are not entered; `global.limits.version_scan_depth` deep, at
# most `version_scan_max_files` files). A project only under obj/ or bin/ is therefore ignored.
# The CI-specified version is the first found of: a workflow (`node-version`, `go-version`, `dotnet-version`,
# `python-version`, ... under .github/workflows), then each source of the ecosystem in order (version files such as
# .nvmrc, global.json, .python-version, .tool-versions; manifests such as package.json engines, go.mod `go`,
# pyproject.toml requires-python), a .gitlab-ci.yml image. go.mod and `>=` specs are minimums.
# status compares the first `runtime.compare` components of the version (the major for node, dotnet and java; major.minor for the
# others): `mismatch` means the local version is not one the spec allows; a spec that cannot be compared (lts/*,
# stable, a `<` range) or a missing side is `unknown`. Exit: 0 always, 2 on a usage error.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
dir=${1:-.}
cd "$dir" 2>/dev/null || { echo "runtime-versions: cannot enter $dir" >&2; exit 2; }
# shellcheck source=/dev/null # ecosystems.sh next to this script
. "$here/ecosystems.sh"
eco_init "$here/../references/ecosystems.tsv" || { echo 'runtime: none (the ecosystem definition references/ecosystems.tsv is missing)'; exit 0; }

# clean: one spec token, no quotes, brackets, spaces or trailing comment
clean() { sed -e 's/[[:space:]]#.*$//' | tr -d "\"'[] \r" | head -1; }

# wf_find KEY: "file<TAB>value" of the first workflow entry with a usable value. `key: x`, `key: [18, 20]` and a
# block list under `key:` are read; a value with an expression (${{ ... }}) cannot be resolved and is skipped.
wf_find() {
  for wf_f in .github/workflows/*.yml .github/workflows/*.yaml; do
    [ -f "$wf_f" ] || continue
    wf_v=$(awk -v key="$1" '
      function emit(v) { if (v != "" && v !~ /\$\{\{/) { print v; exit } }
      blk { if ($0 ~ /^[ \t]*-[ \t]*[^ \t]/) { s = $0; sub(/^[ \t]*-[ \t]*/, "", s); sub(/[ \t]+#.*$/, "", s); acc = acc (acc == "" ? "" : ",") s; next } blk = 0; emit(acc) }
      $0 ~ "^[ \t-]*" key ":" { s = $0; sub("^[ \t-]*" key ":[ \t]*", "", s); if (s ~ /^(#.*)?$/) { blk = 1; acc = ""; next } emit(s) }
      END { if (blk) emit(acc) }' "$wf_f" | clean)
    if [ -n "$wf_v" ]; then printf '%s\t%s\n' "$wf_f" "$wf_v"; return 0; fi
  done
  return 1
}
# tv_find FILE NAME...: the first `NAME version` line of a .tool-versions file
tv_find() {
  rv_f=$1; shift
  [ -f "$rv_f" ] || return 1
  rv_t=$(awk -v names="$*" 'BEGIN { n = split(names, a, " "); for (i = 1; i <= n; i++) w[a[i]] = 1 } $1 in w { print $2; exit }' "$rv_f" | clean)
  [ -n "$rv_t" ] && printf '%s\t%s\n' "$rv_f" "$rv_t"
}
file_find() { [ -f "$1" ] || return 1; rv_t=$(grep -v '^[[:space:]]*$' "$1" | head -1 | clean); [ -n "$rv_t" ] && printf '%s\t%s\n' "$1" "$rv_t"; }
gitlab_find() { # IMAGE: `image: node:20`
  [ -f .gitlab-ci.yml ] || return 1
  rv_t=$(sed -n "s/^[[:space:]]*image:[[:space:]]*['\"]*$1:\\([0-9][0-9.]*\\).*/\\1/p" .gitlab-ci.yml | head -1)
  [ -n "$rv_t" ] && printf '.gitlab-ci.yml\t%s\n' "$rv_t"
}
# sed_pick FILE PATTERN GROUP FLATTEN: the GROUP of the first ERE match (a line of FILE; the whole file as one line when FLATTEN)
sed_pick() {
  sp_d=$(printf '\037'); sp_p=$2
  case "$sp_p" in '^'*) ;; *) sp_p=".*$sp_p" ;; esac
  if [ "$4" = true ]; then tr -d '\n' < "$1"; else cat "$1"; fi | sed -n -E "s${sp_d}${sp_p}.*${sp_d}\\$3${sp_d}p" | head -1
}
# match_find FILE PATTERN GROUP FLATTEN PREFIX
match_find() {
  [ -f "$1" ] || return 1
  rv_t=$(sed_pick "$1" "$2" "$3" "$4" | clean)
  [ -n "$rv_t" ] && printf '%s\t%s%s\n' "$1" "$5" "$rv_t"
}

# --- nested files: version files and presence markers below the root (pruned, bounded) -----------------------
depth=$(eco_first '*' limits.version_scan_depth); depth=${depth:-6}
maxf=$(eco_first '*' limits.version_scan_max_files); maxf=${maxf:-400}
# names to look for: every runtime.present glob, every version file name and .tool-versions
names=$( { eco_union runtime.present; eco_match '^version_files\.[0-9]+\.file$' | cut -f3; echo .tool-versions; } | sort -u )
NESTED=''
nested_scan() {
  ns_pr=''; for ns_d in $(eco_get '*' prune); do ns_pr="$ns_pr -o -name $ns_d"; done
  ns_nm=''; for ns_n in $names; do ns_nm="$ns_nm -o -name $ns_n"; done
  set -f
  # shellcheck disable=SC2086 # built from plain names, split on purpose with globbing off
  NESTED=$(find . -maxdepth "$depth" \( ${ns_pr# -o } \) -type d -prune -o -type f \( ${ns_nm# -o } \) -print 2>/dev/null \
    | sed 's|^\./||' | grep '/' | grep -v '[[:space:]]' | awk '{ n = gsub("/", "/"); print n "\t" $0 }' | LC_ALL=C sort -t "$(printf '\t')" -k1,1n -k2 | cut -f2 | head -n "$maxf")
  set +f
}
# nested_for ID: the nested files minus the prune dirs of that ecosystem
nested_for() {
  [ -n "$NESTED" ] || return 0
  printf '%s\n' "$NESTED" | awk -v pr="$(eco_get "$1" prune | tr '\n' ' ')" 'BEGIN { n = split(pr, a, " "); for (i = 1; i <= n; i++) pd[a[i]] = 1 }
    { m = split($0, s, "/"); for (i = 1; i < m; i++) if (s[i] in pd) next; print }'
}
# nested_named LIST NAME: the paths of LIST whose file name is NAME
nested_named() { printf '%s\n' "$1" | awk -v n="$2" '{ b = $0; sub(/^.*\//, "", b); if (b == n) print }'; }

# spec_for ROWS NESTED-LIST: "file<TAB>value" of the first usable source of the ecosystem (ROWS: its version_files, one
# per line, fields kind file pattern group flatten spec_prefix names keys image): the root first (workflow, every
# source in order, GitLab image), then the same file sources in nested directories.
SEP1=$(printf '\037'); SEP2=$(printf '\036')
spec_for() {
  sf_rows=$1; sf_nest=$2
  for sf_pass in root nested; do
    while IFS=$SEP1 read -r sf_k sf_file sf_pat sf_grp sf_flat sf_pre sf_names sf_keys sf_img; do
      case "$sf_k" in
        workflow) [ "$sf_pass" = root ] || continue
          for sf_key in $(printf '%s' "$sf_keys" | tr "$SEP2" ' '); do wf_find "$sf_key" && return 0; done ;;
        gitlab_image) [ "$sf_pass" = root ] || continue
          gitlab_find "$sf_img" && return 0 ;;
        line|match|tool_versions)
          [ "$sf_k" != tool_versions ] || sf_file=.tool-versions
          sf_nm=$(printf '%s' "$sf_names" | tr "$SEP2" ' ')
          if [ "$sf_pass" = root ]; then sf_paths=$sf_file; else sf_paths=$(nested_named "$sf_nest" "$sf_file"); fi
          for sf_f in $sf_paths; do
            case "$sf_k" in
              line) file_find "$sf_f" && return 0 ;;
              tool_versions) tv_find "$sf_f" "$sf_nm" && return 0 ;;
              match) match_find "$sf_f" "$sf_pat" "$sf_grp" "$sf_flat" "$sf_pre" && return 0 ;;
            esac
          done ;;
      esac
    done <<D_EOF
$sf_rows
D_EOF
  done
  return 1
}

# local_for COMMANDS EXTRACT GROUP: the installed version of a runtime (COMMANDS: \036-separated), empty when it is not installed
local_for() {
  lf_ext=$2
  case "$lf_ext" in '^'*) ;; *) lf_ext=".*$lf_ext" ;; esac
  lf_d=$(printf '\037')
  for lf_c in $(printf '%s' "$1" | tr "$SEP2" '\n' | sed 's/ /~/g'); do
    lf_c=$(printf '%s' "$lf_c" | tr '~' ' ')
    command -v "${lf_c%% *}" >/dev/null 2>&1 || continue
    lf_v=$(sh -c "$lf_c" 2>&1 < /dev/null | head -5 | sed -n -E "s${lf_d}${lf_ext}.*${lf_d}\\$3${lf_d}p" | head -1)
    if [ -n "$lf_v" ]; then printf '%s\n' "$lf_v"; return 0; fi
  done
}

# status UNIT LOCAL SPEC: match | mismatch | unknown (see the header)
status() {
  awk -v n="$1" -v loc="$2" -v spec="$3" 'BEGIN {
    if (loc !~ /^[0-9]/ || spec ~ /</) { print "unknown"; exit }
    min = (spec ~ />/)
    nl = split(loc, lp, ".")
    gsub(/[^0-9.]+/, " ", spec)
    nf = split(spec, f, " ")
    seen = 0
    for (i = 1; i <= nf; i++) {
      s = f[i]; gsub(/^\.+|\.+$/, "", s)
      if (s == "") continue
      seen = 1
      k = split(s, sp, "."); if (k > n) k = n
      if (k > nl) k = nl
      cmp = 0
      for (j = 1; j <= k && cmp == 0; j++) cmp = (lp[j] + 0 < sp[j] + 0) ? -1 : (lp[j] + 0 > sp[j] + 0) ? 1 : 0
      if (min ? cmp >= 0 : cmp == 0) { print "match"; exit }
    }
    print seen ? "mismatch" : "unknown"
  }'
}


found=0
report() { # NAME UNIT LOCAL SPEC-LINE (file<TAB>spec, may be empty) PRESENT
  rv_l=$3; rv_c=none; rv_s=-
  [ -n "$rv_l" ] || rv_l=missing
  if [ -n "$4" ]; then rv_s=$(printf '%s' "$4" | cut -f1); rv_c=$(printf '%s' "$4" | cut -f2); fi
  [ "$5" = yes ] || [ -n "$4" ] || return 0
  if [ "$rv_l" = missing ] || [ "$rv_c" = none ]; then rv_st=unknown; else rv_st=$(status "$2" "$rv_l" "$rv_c"); fi
  printf 'runtime: %s local=%s ci=%s source=%s status=%s\n' "$1" "$rv_l" "$rv_c" "$rv_s" "$rv_st"
  found=1
}

# present_for GLOBS NESTED-LIST: yes when the root or a nested directory has one of the presence files (GLOBS: \036-separated)
present_for() {
  for pf_g in $(printf '%s' "$1" | tr "$SEP2" ' '); do
    for pf_f in ./$pf_g; do [ -e "$pf_f" ] && { echo yes; return; }; done
  done
  [ -n "$2" ] || { echo no; return; }
  printf '%s\n' "$2" | awk -v pats="$(printf '%s' "$1" | tr "$SEP2" ' ')" "$ECO_G2RE"'
    { n = split(pats, a, " "); for (j = 1; j <= n; j++) if ($0 ~ g2re(a[j])) { f = 1; exit } }
    END { print f ? "yes" : "no" }'
}

nested_scan
for id in $(eco_ids); do
  info=$(eco_pack "$id" runtime.name runtime.compare runtime.present runtime.local.commands runtime.local.extract runtime.local.group)
  IFS=$SEP1 read -r r_name r_cmp r_present r_cmds r_ext r_grp <<D_EOF
$info
D_EOF
  nest=$(nested_for "$id")
  rows=$(eco_rows "$id" version_files kind file pattern group flatten spec_prefix names keys image)
  report "$r_name" "$r_cmp" "$(local_for "$r_cmds" "$r_ext" "$r_grp")" "$(spec_for "$rows" "$nest" 2>/dev/null)" "$(present_for "$r_present" "$nest")"
done
[ "$found" = 1 ] || echo 'runtime: none (no language runtime detected)'
exit 0
