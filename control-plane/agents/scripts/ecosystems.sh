#!/bin/sh
# Ecosystem definition reader for sh (A173). Sourced, never run. It reads ecosystems.tsv, the flat form of
# ecosystems.json that `node ecosystems.mjs write` generates, so no sh script needs node or a JSON parser.
# Each line is `<id><TAB><path><TAB><value>`; the id `*` is the global section. A scalar array repeats its path,
# an array of objects adds an index segment (`commands.build.0.run`).
# A skill that uses this carries a byte-identical copy of this file and of ecosystems.tsv (tests/shared/check-shared.sh).
#
#   eco_init FLAT         use FLAT (an ecosystems.tsv); returns 1 when it cannot be read
#   eco_ids               the ecosystem ids, one per line, in file order
#   eco_get ID PATH       every value at PATH (ID * for the global section)
#   eco_first ID PATH     the first value, empty when absent
#   eco_children ID PATH  the distinct keys or indexes directly under PATH
#   eco_all PATH          `id<TAB>value` for every ecosystem
#   eco_union PATH        the distinct values of PATH over all ecosystems
#   eco_risky             every risky glob (global, plus risky_paths, manifests, locks and settings of each ecosystem)
#   eco_glob_match PATH GLOB...   0 when PATH matches a glob (the agent.sh dialect: no / means any depth, ** spans directories)
#   eco_pruned ID PATH    0 when a directory segment of PATH is a global or the ecosystem's prune dir
ECO_FLAT=${ECO_FLAT:-}

eco_init() { ECO_FLAT=$1; [ -r "$ECO_FLAT" ] && [ -s "$ECO_FLAT" ]; }
eco_ids() { awk -F'\t' '$1 != "*" && !s[$1]++ { print $1 }' "$ECO_FLAT" 2>/dev/null; }
eco_get() { awk -F'\t' -v id="$1" -v p="$2" '$1 == id && $2 == p { print $3 }' "$ECO_FLAT" 2>/dev/null; }
eco_first() { eco_get "$1" "$2" | head -1; }
eco_children() {
  awk -F'\t' -v id="$1" -v p="$2" 'BEGIN { q = p "." }
    $1 == id && index($2, q) == 1 { r = substr($2, length(q) + 1); i = index(r, "."); if (i) r = substr(r, 1, i - 1); if (!(r in s)) { s[r] = 1; print r } }' "$ECO_FLAT" 2>/dev/null
}
eco_all() { awk -F'\t' -v p="$1" '$1 != "*" && $2 == p { print $1 "\t" $3 }' "$ECO_FLAT" 2>/dev/null; }
eco_union() { awk -F'\t' -v p="$1" '$1 != "*" && $2 == p && !s[$3]++ { print $3 }' "$ECO_FLAT" 2>/dev/null; }
eco_risky() {
  awk -F'\t' '($1 == "*" && $2 == "risky_paths") || ($1 != "*" && ($2 == "risky_paths" || $2 == "manifests" || $2 == "locks" || $2 == "settings")) { if (!s[$3]++) print $3 }' "$ECO_FLAT" 2>/dev/null
}

# The same translation as g2re in agent.sh and globToRegExp in ecosystems.mjs.
ECO_G2RE='
    function g2re(p,   r, i, c, n) {
      if (index(p, "/") == 0) p = "**/" p
      r = ""; n = length(p)
      for (i = 1; i <= n; i++) {
        c = substr(p, i, 1)
        if (c == "*") {
          if (substr(p, i + 1, 1) == "*") { if (substr(p, i + 2, 1) == "/") { r = r "(.*/)?"; i += 2 } else { r = r ".*"; i++ } }
          else r = r "[^/]*"
        } else if (c == "?") r = r "[^/]"
        else if (index(".+()|^$[]{}\\", c)) r = r "\\" c
        else r = r c
      }
      return "^" r "$"
    }'
eco_glob_match() { # PATH GLOB...
  ecm_p=$1; shift
  printf '%s\n' "$ecm_p" | awk -v pats="$*" "$ECO_G2RE"'
    { n = split(pats, a, " "); for (j = 1; j <= n; j++) if (a[j] != "" && $0 ~ g2re(a[j])) { f = 1; exit } }
    END { exit !f }'
}
eco_pruned() { # ID PATH
  ecp_d="$(eco_get '*' prune; [ "$1" = '*' ] || eco_get "$1" prune)"
  printf '%s\n' "$2" | awk -v dirs="$(printf '%s' "$ecp_d" | tr '\n' ' ')" '
    BEGIN { n = split(dirs, a, " "); for (i = 1; i <= n; i++) d[a[i]] = 1 }
    { m = split($0, s, "/"); for (i = 1; i < m; i++) if (s[i] in d) { f = 1; exit } }
    END { exit !f }'
}
eco_match() { # PATH-ERE: `id<TAB>path<TAB>value` of every row whose path matches (an awk regular expression)
  awk -F'\t' -v re="$1" '$2 ~ re' "$ECO_FLAT" 2>/dev/null
}
# eco_pack ID PATH...: one line with the value of each PATH, fields separated by the control character \037, several
# values of one PATH joined by \036 (one awk run instead of one per query)
eco_pack() {
  ep_id=$1; shift
  awk -F'\t' -v id="$ep_id" -v paths="$*" 'BEGIN { n = split(paths, p, " "); for (i = 1; i <= n; i++) w[p[i]] = i; s1 = sprintf("%c", 31); s2 = sprintf("%c", 30) }
    $1 == id && ($2 in w) { k = w[$2]; v[k] = (k in v) ? v[k] s2 $3 : $3 }
    END { for (i = 1; i <= n; i++) printf "%s%s", v[i], (i < n ? s1 : "\n") }' "$ECO_FLAT" 2>/dev/null
}
# eco_rows ID PATH KEY...: one line per element of the object array at PATH, with the value of each KEY (same field rules as eco_pack)
eco_rows() {
  er_id=$1; er_p=$2; shift 2
  awk -F'\t' -v id="$er_id" -v pre="$er_p." -v keys="$*" 'BEGIN { n = split(keys, k, " "); for (i = 1; i <= n; i++) w[k[i]] = i; s1 = sprintf("%c", 31); s2 = sprintf("%c", 30) }
    $1 == id && index($2, pre) == 1 { r = substr($2, length(pre) + 1); i = index(r, "."); if (!i) next; idx = substr(r, 1, i - 1); key = substr(r, i + 1)
      if (!(idx in seen)) { seen[idx] = 1; order[++m] = idx }
      if (key in w) { kk = idx SUBSEP w[key]; v[kk] = (kk in v) ? v[kk] s2 $3 : $3 } }
    END { for (j = 1; j <= m; j++) for (i = 1; i <= n; i++) printf "%s%s", v[order[j], i], (i < n ? s1 : "\n") }' "$ECO_FLAT" 2>/dev/null
}
