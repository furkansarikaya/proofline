#!/bin/sh
# Config helpers for the proofline CLI: read, set and merge `.agents/config.yaml` (flat indented YAML of
# scalars, two spaces per level). Sourced by bin/proofline; nothing here prints except where stated.

# cfg_lines FILE: one `dotted.key=value` line per key (comments and surrounding quotes stripped), the same
# view agent.sh has.
cfg_lines() {
  awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    $0 !~ /:/ { next }
    {
      ind = match($0, /[^ ]/) - 1; lvl = int(ind / 2)
      body = substr($0, ind + 1); k = body; sub(/:.*/, "", k)
      v = body; sub(/^[^:]*:/, "", v); sub(/[[:space:]]+#.*$/, "", v); v = trim(v)
      if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2)
      path[lvl] = k; full = path[0]; for (i = 1; i <= lvl; i++) full = full "." path[i]
      print full "=" v
    }' "$1"
}
# cfg_get FILE KEY: the value; exit 1 when the key is absent.
cfg_get() { cfg_lines "$1" | awk -v k="$2" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); f = 1; exit } END { exit !f }'; }
# cfg_val FILE KEY DEFAULT: the value, or DEFAULT when absent or empty.
cfg_val() { cv=''; [ ! -f "$1" ] || cv=$(cfg_get "$1" "$2" 2>/dev/null) || cv=''; if [ -n "$cv" ]; then printf '%s\n' "$cv"; else printf '%s\n' "${3:-}"; fi; }

# cfg_set FILE KEY VALUE: replaces the value of a 1- or 2-level key; a missing key is added under its
# section (the section is created when missing). Comments on the replaced line are dropped.
cfg_set() {
  cs_t=$(mktemp "${TMPDIR:-/tmp}/proofline-cfg.XXXXXX") || return 1
  if PL_KEY=$2 PL_VAL=$3 awk '
    function pth(l,   ind, k, i, f) {
      ind = match(l, /[^ ]/) - 1; L = int(ind / 2)
      k = substr(l, ind + 1); sub(/:.*/, "", k); P[L] = k; K = k; IND = ind
      f = P[0]; for (i = 1; i <= L; i++) f = f "." P[i]
      return f
    }
    function content(l) { return l !~ /^[[:space:]]*#/ && l !~ /^[[:space:]]*$/ && l ~ /:/ }
    function emit(ind, k, v,   s) { s = sprintf("%" ind "s", ""); if (v == "") print s k ":"; else print s k ": " v }
    BEGIN { key = ENVIRON["PL_KEY"]; val = ENVIRON["PL_VAL"]; n = split(key, kp, "."); sec = kp[1] }
    FNR == NR { if (content($0) && pth($0) == key) found = 1; next }
    {
      if (!content($0)) { print; next }
      p = pth($0)
      if (found && p == key) { emit(IND, K, val); next }
      print
      if (!found && n == 2 && L == 0 && p == sec && !done) { emit(2, kp[2], val); done = 1 }
    }
    END {
      if (found || done) exit 0
      if (n == 1) { emit(0, key, val); exit 0 }
      if (n == 2) { print sec ":"; emit(2, kp[2], val); exit 0 }
      exit 3
    }' "$1" "$1" > "$cs_t"; then cat "$cs_t" > "$1"; rm -f "$cs_t"; else rm -f "$cs_t"; return 1; fi
}

# cfg_merge_new USER DEFAULT: prints USER with every key missing from it added from DEFAULT. Granularity:
# a missing top-level block is appended whole; a missing 2-level key (with its deeper lines) is inserted at
# the end of its block; user values are never touched. Keys deeper than 2 levels are added only with their
# 2-level parent (ponytail: a new deep key under an existing 2-level key is not added).
cfg_merge_new() {
  awk '
    function content(l) { return l !~ /^[[:space:]]*#/ && l !~ /^[[:space:]]*$/ && l ~ /:/ }
    function pth(l,   ind, k, i, f) {
      ind = match(l, /[^ ]/) - 1; L = int(ind / 2)
      k = substr(l, ind + 1); sub(/:.*/, "", k); P[L] = k; K = k
      f = P[0]; for (i = 1; i <= L; i++) f = f "." P[i]
      return f
    }
    function finish() {
      if (kind == "top") tail = tail buf
      else if (kind == "sub") ins[blockend[subtop]] = ins[blockend[subtop]] buf
      kind = ""; buf = ""
    }
    FNR == NR {
      U[FNR] = $0; n = FNR
      if (content($0)) { p = pth($0); have[p] = 1; blockend[P[0]] = FNR }
      next
    }
    {
      if (!content($0)) { cm = cm $0 "\n"; next }
      p = pth($0)
      if (L == 0) {
        finish()
        if (!(p in have)) { kind = "top"; buf = cm $0 "\n" } else { kind = ""; curtop = p }
        cm = ""
      } else if (L == 1) {
        if (kind == "top") { buf = buf cm $0 "\n" }
        else { finish(); if (!(p in have)) { kind = "sub"; subtop = curtop; buf = cm $0 "\n" } }
        cm = ""
      } else {
        if (kind == "top" || kind == "sub") buf = buf cm $0 "\n"
        cm = ""
      }
    }
    END {
      finish()
      for (i = 1; i <= n; i++) { print U[i]; if (i in ins) printf "%s", ins[i] }
      printf "%s", tail
    }' "$1" "$2"
}
