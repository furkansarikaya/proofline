#!/bin/sh
# Config helpers for the proofline CLI: read, set and merge `.agents/config.yaml` (flat indented YAML of
# scalars, two spaces per level; commands.build|test|lint may also be a block list of commands, A173). Sourced by
# bin/proofline; nothing here prints except where stated.

# cfg_lines FILE: one `dotted.key=value` line per key (comments and surrounding quotes stripped), the same
# view agent.sh has (config_lines; tests/shared/check-shared.sh compares the two awk programs). The `- ` items under
# a key are `key.0=...`, `key.1=...`; the key itself stays empty.
cfg_lines() {
  awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      ind = match($0, /[^ ]/) - 1; lvl = int(ind / 2)
      body = substr($0, ind + 1)
      if (body ~ /^-([[:space:]]|$)/) {
        if (lastfull == "" || ind < lastind) next
        it = body; sub(/^-[[:space:]]*/, "", it); sub(/[[:space:]]+#.*$/, "", it); it = trim(it)
        if (it ~ /^".*"$/ || it ~ /^\047.*\047$/) it = substr(it, 2, length(it) - 2)
        print lastfull "." (cnt[lastfull]++) "=" it
        next
      }
      if ($0 !~ /:/) next
      k = body; sub(/:.*/, "", k)
      v = body; sub(/^[^:]*:/, "", v); sub(/[[:space:]]+#.*$/, "", v); v = trim(v)
      if (v ~ /^".*"$/) v = substr(v, 2, length(v) - 2)
      path[lvl] = k; full = path[0]; for (i = 1; i <= lvl; i++) full = full "." path[i]
      lastfull = full; lastind = ind
      print full "=" v
    }' "$1"
}
# cfg_get FILE KEY: the value; exit 1 when the key is absent.
cfg_get() { cfg_lines "$1" | awk -v k="$2" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); f = 1; exit } END { exit !f }'; }
# cfg_cmds FILE KEY: the one helper for a configured command (A173): one command per line, the scalar or every item of the
# block list; nothing when the key is empty or absent. Use it for commands.build|test|lint, never cfg_val (a list has no value).
cfg_cmds() {
  [ -f "$1" ] || return 0
  cfg_lines "$1" | awk -v k="$2" '
    index($0, k "=") == 1 && !f { v = substr($0, length(k) + 2); f = 1 }
    index($0, k ".") == 1 { r = substr($0, length(k) + 2); n = index(r, "="); if (n > 1 && substr(r, 1, n - 1) ~ /^[0-9]+$/) it[++c] = substr(r, n + 1) }
    END { if (v != "") print v; else for (i = 1; i <= c; i++) print it[i] }'
}
# cfg_val FILE KEY DEFAULT: the value, or DEFAULT when absent or empty.
cfg_val() { cv=''; [ ! -f "$1" ] || cv=$(cfg_get "$1" "$2" 2>/dev/null) || cv=''; if [ -n "$cv" ]; then printf '%s\n' "$cv"; else printf '%s\n' "${3:-}"; fi; }

# cfg_set FILE KEY VALUE: replaces the value of a 1-, 2- or 3-level key; a missing key is added under its
# section (the section is created when missing; a 3-level key needs its 2-level parent). Comments on the replaced line are dropped.
# A VALUE of several lines writes a block list (`- ` lines under the key, commands.build|test|lint, A173); replacing a key
# also removes the `- ` lines it had.
cfg_set() {
  cs_t=$(mktemp "${TMPDIR:-/tmp}/proofline-cfg.XXXXXX") || return 1
  if PL_KEY=$2 PL_VAL=$3 awk '
    function pth(l,   ind, k, i, f) {
      ind = match(l, /[^ ]/) - 1; L = int(ind / 2)
      k = substr(l, ind + 1); sub(/:.*/, "", k); P[L] = k; K = k; IND = ind
      f = P[0]; for (i = 1; i <= L; i++) f = f "." P[i]
      return f
    }
    function item(l) { return l ~ /^[[:space:]]*-([[:space:]]|$)/ }
    function content(l) { return l !~ /^[[:space:]]*#/ && l !~ /^[[:space:]]*$/ && !item(l) && l ~ /:/ }
    function emit(ind, k, v,   s, m, a, i) {
      s = sprintf("%" ind "s", "")
      if (v == "") print s k ":"
      else if (index(v, "\n")) { print s k ":"; m = split(v, a, "\n"); for (i = 1; i <= m; i++) if (a[i] != "") print s "  - " a[i] }
      else print s k ": " v
    }
    BEGIN { key = ENVIRON["PL_KEY"]; val = ENVIRON["PL_VAL"]; n = split(key, kp, "."); sec = kp[1] }
    FNR == NR { if (content($0) && pth($0) == key) found = 1; next }
    {
      if (skip && item($0)) next
      if (!content($0)) { if (!/^[[:space:]]*(#|$)/) skip = 0; print; next }
      skip = 0
      p = pth($0)
      if (found && p == key) { emit(IND, K, val); skip = 1; next }
      print
      if (!found && n == 2 && L == 0 && p == sec && !done) { emit(2, kp[2], val); done = 1 }
      if (!found && n == 3 && L == 1 && p == kp[1] "." kp[2] && !done) { emit(4, kp[3], val); done = 1 }
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
# 2-level parent.
# shortcut: a new deep key under an existing 2-level key is not added; improve when a default config gets a 3-level key that upgrade must merge into a block the user already has.
cfg_merge_new() {
  awk '
    function item(l) { return l ~ /^[[:space:]]*-([[:space:]]|$)/ }
    function content(l) { return l !~ /^[[:space:]]*#/ && l !~ /^[[:space:]]*$/ && !item(l) && l ~ /:/ }
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
      else if (item($0) && P[0] != "") blockend[P[0]] = FNR   # a list item belongs to its block: new keys go after it
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
