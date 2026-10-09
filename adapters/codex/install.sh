#!/bin/sh
# Terminal / Codex installer (D8): clone the repository, run this script, then run `proofline init` in each
# project. No `curl | bash`: it only links bin/proofline from this checkout onto your PATH.
#
#   adapters/codex/install.sh [--dir DIR] [--yes]
#
#   --dir DIR  directory for the `proofline` symlink (default ~/.local/bin)
#   --yes      no questions; also appends `export PATH=...` to your shell's rc file when DIR is not on PATH.
#              Without --yes no shell rc file is ever edited.
#
# Codex discovers the skills from each project's .agents/skills/ (installed by `proofline init`); there is
# nothing to install into ~/.codex.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd) || exit 1
repo=$(dirname "$(dirname "$here")")
target=$repo/bin/proofline
dir=${HOME:-}/.local/bin; yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || { echo "install.sh: --dir needs a directory" >&2; exit 2; }; dir=$2; shift ;;
    --yes|-y) yes=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -x "$target" ] || { echo "install.sh: $target is missing or not executable (is this a proofline checkout?)" >&2; exit 1; }
[ -n "$dir" ] || { echo "install.sh: no install directory (HOME is unset; pass --dir)" >&2; exit 2; }

if [ "$yes" != 1 ]; then
  if [ ! -t 0 ]; then echo "install.sh: not a terminal; pass --yes to link without asking (or --dir DIR)" >&2; exit 1; fi
  printf 'Directory for the proofline symlink [%s]: ' "$dir"; IFS= read -r a; [ -z "$a" ] || dir=$a
  printf 'Link %s/proofline -> %s ? [y/N]: ' "$dir" "$target"; IFS= read -r a
  case "$a" in y|Y|yes) ;; *) echo "nothing installed"; exit 1 ;; esac
fi

mkdir -p "$dir" || exit 1
link=$dir/proofline
if [ -e "$link" ] && [ ! -L "$link" ]; then echo "install.sh: $link exists and is not a symlink; remove it first" >&2; exit 1; fi
ln -sf "$target" "$link" || exit 1
echo "linked $link -> $target"

case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *)
    line="export PATH=\"$dir:\$PATH\""
    if [ "$yes" = 1 ]; then
      case "${SHELL:-}" in *zsh) rc=${HOME:-}/.zshrc ;; *bash) rc=${HOME:-}/.bashrc ;; *) rc=${HOME:-}/.profile ;; esac
      if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then echo "$dir is already on PATH in $rc"
      else printf '\n# proofline\n%s\n' "$line" >> "$rc" && echo "added to $rc: $line (open a new shell)"; fi
    else
      echo "$dir is not on your PATH. Add this to your shell rc file (not edited without --yes):"; echo "  $line"
    fi ;;
esac

echo ""
echo "next, in each project you want proofline in:"
echo "  cd <project> && proofline init"
echo "then: proofline doctor"
