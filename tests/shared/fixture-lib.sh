#!/bin/sh
# Shared installed-template fixture for the self-tests. Sourced, never run.
# Installing the control plane into a throwaway repository is the same work in every scenario, so it is done
# once per content hash and every scenario COPIES the result into its own fresh directory (copies share no
# state). The cache lives in $SELFTEST_TEMPLATE_DIR (tests/selftest.sh sets it for one run and removes it after),
# else in a per-user directory under $TMPDIR. Concurrent processes build a template once: the winner of an
# atomic `mkdir` lock builds into a private directory and renames it into place; the others wait for it.
#   fx_key ROOT PATH...           content hash of the files under ROOT/PATH... (a changed file => a new key)
#   fx_template KEY BUILDER       prints the template directory for KEY; BUILDER DIR fills an empty DIR (once)
#   fx_copy TEMPLATE DEST         DEST (an existing empty directory) becomes an independent copy of TEMPLATE
# FX_BUILDS=FILE: every build appends one line to FILE (the fixture test counts them).

if command -v shasum >/dev/null 2>&1; then fx_sha() { shasum -a 256 | awk '{print $1}'; }; else fx_sha() { sha256sum | awk '{print $1}'; }; fi

fx_key() { # ROOT PATH... : sorted "cksum size relpath" lines of every file, hashed
  fk_root=$1; shift
  ( cd "$fk_root" || exit 1
    for fk_p in "$@"; do [ -e "$fk_p" ] && find "$fk_p" -type f ! -path '*/.git/*' ! -name '.DS_Store'; done | LC_ALL=C sort |
      while IFS= read -r fk_f; do cksum < "$fk_f" | awk -v f="$fk_f" '{print $1, $2, f}'; done | fx_sha )
}

fx_dir() { printf '%s\n' "${SELFTEST_TEMPLATE_DIR:-${TMPDIR:-/tmp}/proofline-fixture-$(id -u)}"; }

fx_template() { # KEY BUILDER -> template directory on stdout
  ft_key=$1 ft_build=$2; ft_dir=$(fx_dir); mkdir -p "$ft_dir" || return 1
  ft_final=$ft_dir/$ft_key; ft_lock=$ft_dir/$ft_key.lock; ft_wait=0
  while [ ! -d "$ft_final" ]; do
    if mkdir "$ft_lock" 2>/dev/null; then
      echo "$$" > "$ft_lock/pid"
      if [ ! -d "$ft_final" ]; then   # another process may have finished between the test and the lock
        ft_tmp=$ft_dir/$ft_key.tmp.$$; rm -rf "$ft_tmp"; mkdir "$ft_tmp"
        if ( "$ft_build" "$ft_tmp" ); then   # a subshell: a builder that dies must not leave the lock behind
          [ -z "${FX_BUILDS:-}" ] || echo "$ft_key" >> "$FX_BUILDS"
          mv "$ft_tmp" "$ft_final" || { rm -rf "$ft_tmp"; rm -rf "$ft_lock"; return 1; }
        else rm -rf "$ft_tmp"; rm -rf "$ft_lock"; return 1; fi
      fi
      rm -rf "$ft_lock"; break
    fi
    # a lock whose holder is gone (killed) is stale: take it over
    ft_holder=$(cat "$ft_lock/pid" 2>/dev/null || true)
    if [ -n "$ft_holder" ] && ! kill -0 "$ft_holder" 2>/dev/null; then rm -rf "$ft_lock"; continue; fi
    sleep 1; ft_wait=$((ft_wait + 1))
    if [ "$ft_wait" -ge 300 ]; then   # the lock holder died: build a private copy, shared with nobody
      ft_final=$ft_dir/$ft_key.private.$$; mkdir "$ft_final" && "$ft_build" "$ft_final" || return 1
      break
    fi
  done
  printf '%s\n' "$ft_final"
}

fx_copy() { cp -R "$1/." "$2/"; }
