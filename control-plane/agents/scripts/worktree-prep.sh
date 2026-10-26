#!/bin/sh
# Prepares a run worktree (A185). Run by `agent.sh worktree-add`; it knows no ecosystem: what to prepare is data.
#
#   worktree-prep.sh <MAIN-ROOT> <WORKTREE> [COPY-GLOBS]
#   worktree-prep.sh --deps <MAIN-ROOT> <DIR>      only step 1, into any folder (the throwaway export of build-record.sh)
#
# 1 Dependency folders. `worktree_deps.folders` of every ecosystem in ecosystems.json (flat form: ecosystems.tsv) names
#   git-ignored folders a package manager fills (for example node_modules). Each one that exists in the main tree is COPIED
#   into the worktree (copy-on-write clone where the file system has one, a plain copy otherwise), so a task that changes
#   dependencies changes only its own worktree. A link into the main tree is never made; an old link left by an earlier
#   version is replaced by a copy. A link inside a copy (absolute, or relative and leaving the folder) that resolves into the main
#   tree is re-pointed at the same path of the worktree, so nothing written through it reaches the main tree.
#   A folder that git tracks, or does not ignore, is left alone (a checkout already has the tracked one).
# 2 Local files. COPY-GLOBS (config `worktree.copy_files`, default `.env*`; `none` switches it off; globs of agent.sh: a
#   pattern without / matches at any depth) name untracked files a checkout lacks. A match is copied only when git IGNORES it in
#   the main tree and in the worktree, so it can never be committed by `git add -A`; a match git does not ignore is reported and
#   NOT copied. Every copied path is listed in <worktree>/.agents/local/worktree-copied, which the pre-commit hook reads and
#   refuses to let into a commit (a forced `git add -f` included). The secret scan is untouched: it still scans any such file
#   that appears among the changed paths.
# Exit 0 always for a missing source; 1 when a copy failed.
set -u
LC_ALL=C; export LC_ALL
deps_only=no; [ "${1:-}" != --deps ] || { deps_only=yes; shift; }
main=${1:-}; wt=${2:-}; globs=${3:-}
[ -d "$main" ] && [ -d "$wt" ] || { echo "usage: worktree-prep.sh [--deps] <MAIN-ROOT> <WORKTREE> [COPY-GLOBS]" >&2; exit 2; }
main=$(CDPATH='' cd "$main" && pwd -P); wt=$(CDPATH='' cd "$wt" && pwd -P)
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
tsv=$main/.agents/ecosystems.tsv; [ -s "$tsv" ] || tsv=$here/../ecosystems.tsv
eco=$here/ecosystems.sh
rc=0

eco_ok=no; eco_lib=no
if [ -f "$eco" ]; then
  # shellcheck source=/dev/null # ecosystems.sh next to this script
  . "$eco"; eco_lib=yes
  [ ! -s "$tsv" ] || ! eco_init "$tsv" || eco_ok=yes
fi

# a folder name from data: relative, plain segments, never the git or control-plane folders
plain_rel() {
  case "$1" in ''|/*|*..*|*//*|.git|.git/*|.agents|.agents/*|*[!A-Za-z0-9._/-]*) return 1 ;; esac
}
gm() { git -C "$main" "$@"; }
gw() { git -C "$wt" "$@"; }

# clone_tree SRC DST: copy-on-write where possible, else a plain copy; symbolic links stay links
clone_tree() {
  mkdir -p "$(dirname "$2")" || return 1
  cp -cR "$1" "$2" 2>/dev/null && return 0   # APFS clone
  rm -rf "$2"
  cp -R --reflink=auto "$1" "$2" 2>/dev/null && return 0   # GNU, where the file system supports it (a plain copy otherwise)
  rm -rf "$2"
  cp -R "$1" "$2"
}

# --- 1 dependency folders
if [ "$eco_ok" = yes ]; then
  for f in $(eco_union worktree_deps.folders); do
    plain_rel "$f" || { echo "worktree-prep: ignoring worktree_deps folder '$f' (not a plain relative name)" >&2; continue; }
    [ -d "$main/$f" ] && [ ! -L "$main/$f" ] || continue
    gm ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && continue          # tracked: the checkout has it
    gm check-ignore -q -- "$f/" 2>/dev/null || gm check-ignore -q -- "$f" 2>/dev/null || continue
    if [ -L "$wt/$f" ]; then rm -f "$wt/$f"; fi                              # a link of an earlier version: never kept
    [ ! -e "$wt/$f" ] || continue
    if clone_tree "$main/$f" "$wt/$f"; then
      # a link inside the copy that resolves into the main tree (absolute, or relative with ..) would let the worktree write there
      find "$wt/$f" -type l 2>/dev/null | while IFS= read -r l; do
        t=$(readlink "$l" 2>/dev/null) || continue
        case "$t" in /*) a=$t ;; *) a=$(CDPATH='' cd "$(dirname "$l")" 2>/dev/null && pwd -P)/$t ;; esac
        a=$(printf '%s\n' "$a" | awk -F/ '{ n = 0; for (i = 2; i <= NF; i++) { if ($i == "" || $i == ".") continue; if ($i == "..") { if (n > 0) n--; continue } p[++n] = $i } o = ""; for (i = 1; i <= n; i++) o = o "/" p[i]; print o }')
        case "$a" in "$wt"/*) continue ;; "$main"/*) ln -sfn "$wt/${a#"$main"/}" "$l" ;; esac
      done
    else
      rm -rf "${wt:?}/$f"; echo "worktree-prep: could not copy $f into the worktree" >&2; rc=1
    fi
  done
fi

# --- 2 local files
[ "$deps_only" = no ] || exit "$rc"
case "$globs" in ''|none) exit "$rc" ;; esac
[ "$eco_lib" = yes ] || { echo "worktree-prep: ecosystems.sh is missing, so local files are not copied" >&2; exit "$rc"; }
# the prune list is data (global.prune); without the data only the git and control-plane folders are skipped
eco_prune='.git .agents'
[ "$eco_ok" != yes ] || eco_prune=$(eco_get '*' prune | tr '\n' ' ')
cand=$(mktemp "${TMPDIR:-/tmp}/worktree-prep.XXXXXX") || exit 1
trap 'rm -f "$cand" "$cand.m"' EXIT
set -f
pargs=''
for d in $eco_prune; do pargs="$pargs -name $d -o"; done
# shellcheck disable=SC2086 # the prune expression is built from plain folder names
( cd "$main" && find . -maxdepth 8 \( $pargs -false \) -prune -o -type f -print 2>/dev/null ) | sed 's|^\./||' > "$cand"
set +f
manifest=$wt/.agents/local/worktree-copied
# one awk run keeps the candidates that match a glob (the dialect of agent.sh: no / means any depth)
awk -v pats="$globs" "$ECO_G2RE"'
  BEGIN { n = split(pats, a, " ") }
  { for (j = 1; j <= n; j++) if (a[j] != "" && $0 ~ g2re(a[j])) { print; next } }' "$cand" > "$cand.m"
mv "$cand.m" "$cand"
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ ! -e "$wt/$p" ] || continue
  gm ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && continue            # tracked: the checkout has it
  if ! gm check-ignore -q -- "$p" 2>/dev/null; then
    echo "worktree-prep: $p is not copied: git does not ignore it in the main tree (add it to .gitignore first; a copy could be committed)" >&2; continue
  fi
  if ! { mkdir -p "$(dirname "$wt/$p")" && cp -p "$main/$p" "$wt/$p"; }; then echo "worktree-prep: could not copy $p" >&2; rc=1; continue; fi
  if ! gw check-ignore -q -- "$p" 2>/dev/null; then
    rm -f "$wt/$p"; echo "worktree-prep: $p is not copied: git does not ignore it in the worktree" >&2; continue
  fi
  mkdir -p "$(dirname "$manifest")"; printf '%s\n' "$p" >> "$manifest"
done < "$cand"
if [ -f "$manifest" ]; then sort -u "$manifest" > "$manifest.t" && mv "$manifest.t" "$manifest"; fi
exit "$rc"
