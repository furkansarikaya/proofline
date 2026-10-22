#!/bin/sh
# Runtime versions (0.0.26): the language runtime versions the project's CI specifies against the ones installed
# here. Read-only, installs nothing, never fails the caller: a difference is information, never a block.
#
# Usage: sh runtime-versions.sh [DIR]      (DIR defaults to the current directory)
# Prints one line per runtime found, or `runtime: none (...)`:
#   runtime: <name> local=<version|missing> ci=<spec|none> source=<file|-> status=<match|mismatch|unknown>
# Runtimes: node, dotnet, go, python. The CI-specified version is the first found of: a workflow
# (`node-version`, `go-version`, `dotnet-version`, `python-version` under .github/workflows), a version file
# (.nvmrc, .node-version, .python-version, global.json, .tool-versions), a manifest (package.json engines.node,
# go.mod `go`, pyproject.toml requires-python), a .gitlab-ci.yml image. go.mod and `>=` specs are minimums.
# status compares the major version (node, dotnet) or major.minor (go, python, whose major never changes):
# `mismatch` means the local version is not one the spec allows; a spec that cannot be compared (lts/*,
# stable, a `<` range) or a missing side is `unknown`. Exit: 0 always, 2 on a usage error.
set -u
dir=${1:-.}
cd "$dir" 2>/dev/null || { echo "runtime-versions: cannot enter $dir" >&2; exit 2; }

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
tv_find() { [ -f .tool-versions ] || return 1; rv_t=$(awk -v n="$1" -v m="$2" '$1 == n || $1 == m { print $2; exit }' .tool-versions | clean); [ -n "$rv_t" ] && printf '.tool-versions\t%s\n' "$rv_t"; }
file_find() { [ -f "$1" ] || return 1; rv_t=$(grep -v '^[[:space:]]*$' "$1" | head -1 | clean); [ -n "$rv_t" ] && printf '%s\t%s\n' "$1" "$rv_t"; }
gitlab_find() { # IMAGE: `image: node:20`
  [ -f .gitlab-ci.yml ] || return 1
  rv_t=$(sed -n "s/^[[:space:]]*image:[[:space:]]*['\"]*$1:\\([0-9][0-9.]*\\).*/\\1/p" .gitlab-ci.yml | head -1)
  [ -n "$rv_t" ] && printf '.gitlab-ci.yml\t%s\n' "$rv_t"
}
flat() { tr -d '\n' < "$1"; }

spec_node() {
  wf_find node-version || file_find .nvmrc || file_find .node-version || tv_find nodejs node || {
    [ -f package.json ] && rv_t=$(flat package.json | sed -n 's/.*"engines"[[:space:]]*:[[:space:]]*{[^}]*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | clean) && [ -n "$rv_t" ] && printf 'package.json\t%s\n' "$rv_t"; } || gitlab_find node
}
spec_go() {
  wf_find go-version || {
    [ -f go.mod ] && rv_t=$(awk '$1 == "go" { print $2; exit }' go.mod | clean) && [ -n "$rv_t" ] && printf 'go.mod\t>=%s\n' "$rv_t"; } || tv_find golang go || gitlab_find golang
}
spec_dotnet() {
  wf_find dotnet-version || {
    [ -f global.json ] && rv_t=$(flat global.json | sed -n 's/.*"sdk"[^}]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | clean) && [ -n "$rv_t" ] && printf 'global.json\t%s\n' "$rv_t"; } || tv_find dotnet dotnet-core
}
spec_python() {
  wf_find python-version || file_find .python-version || tv_find python python3 || {
    [ -f pyproject.toml ] && rv_t=$(sed -n 's/^requires-python[[:space:]]*=[[:space:]]*["'\'']\([^"'\'']*\)["'\''].*/\1/p' pyproject.toml | clean) && [ -n "$rv_t" ] && printf 'pyproject.toml\t%s\n' "$rv_t"; } || gitlab_find python
}

local_node() { command -v node >/dev/null 2>&1 && node --version 2>/dev/null | head -1 | sed 's/^v//'; }
local_dotnet() { command -v dotnet >/dev/null 2>&1 && dotnet --version 2>/dev/null | head -1; }
local_go() { command -v go >/dev/null 2>&1 && go version 2>/dev/null | head -1 | sed -n 's/.*go\([0-9][0-9.]*\).*/\1/p'; }
local_python() {
  for rv_p in python3 python; do
    command -v "$rv_p" >/dev/null 2>&1 && { "$rv_p" --version 2>&1 | head -1 | sed -n 's/^Python \([0-9][0-9.]*\).*/\1/p'; return 0; }
  done
  return 0
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

present() { for rv_m in "$@"; do [ -e "$rv_m" ] && { echo yes; return; }; done; echo no; }
report node 1 "$(local_node)" "$(spec_node 2>/dev/null)" "$(present package.json)"
report go 2 "$(local_go)" "$(spec_go 2>/dev/null)" "$(present go.mod)"
report dotnet 1 "$(local_dotnet)" "$(spec_dotnet 2>/dev/null)" "$(present global.json ./*.sln ./*.csproj)"
report python 2 "$(local_python)" "$(spec_python 2>/dev/null)" "$(present pyproject.toml requirements.txt setup.py)"
[ "$found" = 1 ] || echo 'runtime: none (no language runtime detected)'
exit 0
