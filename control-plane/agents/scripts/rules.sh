#!/bin/sh
# Project rules budget (A202). The user's rules and the promoted lessons live in the "## Project rules" section of AGENTS.md. This
# script MEASURES them and PROPOSES; it has no operation that edits or deletes a rule. A change to a rule is made only after the user's
# own message approves that exact change (the lead then edits AGENTS.md); nothing here records or implies an approval. Run through
# `agent.sh rules <op>`; `proofline doctor` and `proofline insights` print the report.
#   list      every rule: id, bytes, text. A promoted lesson keeps its lc-<hash> id, any other rule is r-<hash of its text>.
#   report    the budget (rules.budget_bytes, default 4000; env RULES_BUDGET_BYTES) and the proposals:
#             merge    two rules that mostly repeat each other (word overlap)
#             ask      two rules on one topic where one forbids what the other asks for: a question for the user, never a decision
#             remove   a rule that none of the last reviewed runs cited (rules.unused_after_reviews, default 10; env RULES_UNUSED_AFTER)
#   tally     lead only: append, for each run with a review gate record not yet counted, the rules its review records cite to
#             .agents/local/rule-use.tsv (a git-ignored counter that outlives the run documents). It never touches AGENTS.md.
# A review cites a rule when a record of the run (gates/, results/, reports/) holds the rule's text or its lesson id.
# shortcut: word overlap and negation words are the whole similarity test (no model); it proposes, the user decides.
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=${PROOFLINE_ROOT:-$(CDPATH='' cd "$here/../.." && pwd)}
agents=$root/AGENTS.md
tally=$root/.agents/local/rule-use.tsv
op=${1:-}; [ $# -eq 0 ] || shift

cfgnum() { # KEY DEFAULT ENV
  cn_v=$(eval "printf '%s' \"\${$3:-}\"")
  if [ -z "$cn_v" ] && [ -f "$root/.agents/config.yaml" ]; then
    cn_v=$(awk -v k="${1#rules.}" '/^rules:/ { s = 1; next } /^[^ #]/ { s = 0 } s && $1 == k ":" { print $2; exit }' "$root/.agents/config.yaml")
  fi
  case "$cn_v" in ''|*[!0-9]*) cn_v=$2 ;; esac
  printf '%s\n' "$cn_v"
}

# rules_raw: "<line>\t<text>" per top-level bullet of the section, continuation lines joined, whitespace squeezed
rules_raw() {
  [ -f "$agents" ] || return 0
  awk '
    function flush() { if (t != "") { gsub(/[ \t]+/, " ", t); sub(/^ /, "", t); sub(/ $/, "", t); print ln "\t" t } t = "" }
    /^<!-- proofline:begin -->$/ { flush(); s = 0; inb = 1; next }
    /^<!-- proofline:end -->$/ { inb = 0; next }
    inb { next }
    /^## Project rules[ \t]*$/ { s = 1; next }
    s && (/^## / || /^<!-- proofline:/) { flush(); s = 0 }
    s && /^- / { flush(); ln = NR; t = substr($0, 3); next }
    s && /^[ \t]+[^ \t]/ && t != "" { t = t " " $0; next }
    s && /^[ \t]*$/ { flush() }
    END { flush() }' "$agents"
}
# rules_list: "<id>\t<bytes>\t<text>"
rules_list() {
  rules_raw | while IFS="$(printf '\t')" read -r _ rl_t; do
    rl_id=$(printf '%s' "$rl_t" | sed -n 's/.*(lesson \(lc-[0-9a-f]\{8\}\)).*/\1/p')
    [ -n "$rl_id" ] || rl_id=r-$(printf '%s' "$rl_t" | tr '[:upper:]' '[:lower:]' | cksum | awk '{ printf "%08x", $1 }')
    printf '%s\t%s\t%s\n' "$rl_id" "$(printf '%s' "$rl_t" | wc -c | tr -d ' ')" "$rl_t"
  done
}

# live_uses: "<run>\t<rule id|->" - reviewed runs (a REVIEW gate record exists) and the rules their records cite
live_uses() {
  rules_list > "${TMPDIR:-/tmp}/rules.$$.list"
  for lu_d in "$root"/.agents/runs/*/; do
    [ -d "$lu_d" ] || continue
    ls "$lu_d"gates/[0-9][0-9][0-9]-REVIEW*.yaml >/dev/null 2>&1 || continue
    lu_r=$(basename "$lu_d")
    printf '%s\t-\n' "$lu_r"
    lu_txt=$(cat "$lu_d"gates/*.yaml "$lu_d"results/*.md "$lu_d"reports/*.md 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr '\n' ' ' | sed 's/[ 	][ 	]*/ /g')
    while IFS="$(printf '\t')" read -r lu_id _ lu_t; do
      lu_core=$(printf '%s' "$lu_t" | sed 's/ *(lesson lc-[0-9a-f]*)//' | tr '[:upper:]' '[:lower:]')
      if printf '%s' "$lu_txt" | grep -qF -- "$lu_core" || { case "$lu_id" in lc-*) printf '%s' "$lu_txt" | grep -qF -- "$lu_id" ;; *) false ;; esac; }; then printf '%s\t%s\n' "$lu_r" "$lu_id"; fi
    done < "${TMPDIR:-/tmp}/rules.$$.list"
  done
  rm -f "${TMPDIR:-/tmp}/rules.$$.list"
}
# uses: the counter file and the live scan, one line per run and rule
uses() { { [ ! -f "$tally" ] || cat "$tally"; live_uses; } | awk -F'\t' 'NF == 2 && !seen[$0]++'; }

case "$op" in
  list) rules_list ;;
  tally)
    case "${AGENT_ROLE:-lead}" in lead) ;; *) echo "rules: only the lead runs 'tally'" >&2; exit 1 ;; esac
    mkdir -p "$root/.agents/local" && touch "$tally" || exit 1
    live_uses | awk -F'\t' -v tf="$tally" 'BEGIN { while ((getline l < tf) > 0) { split(l, p, "\t"); if (p[2] == "-") done[p[1]] = 1 } } NF == 2 && !($1 in done)' >> "$tally"
    echo "rule-use counter: $(awk -F'\t' '$2 == "-"' "$tally" | wc -l | tr -d ' ') reviewed run(s) counted" ;;
  report)
    budget=$(cfgnum rules.budget_bytes 4000 RULES_BUDGET_BYTES); after=$(cfgnum rules.unused_after_reviews 10 RULES_UNUSED_AFTER)
    tmp=$(mktemp "${TMPDIR:-/tmp}/rules-report.XXXXXX") || exit 1; trap 'rm -f "$tmp" "$tmp.u"' EXIT HUP INT TERM
    rules_list > "$tmp"; uses > "$tmp.u"
    n=$(wc -l < "$tmp" | tr -d ' '); bytes=$(awk -F'\t' '{ s += $2 } END { print s + 0 }' "$tmp")
    if [ "$n" = 0 ]; then echo "project rules: none"; exit 0; fi
    st=within; [ "$bytes" -le "$budget" ] || st=OVER
    echo "project rules: $n rule(s), $bytes bytes, budget $budget bytes ($st)"
    reviewed=$(awk -F'\t' '$2 == "-"' "$tmp.u" | wc -l | tr -d ' ')
    awk -F'\t' -v after="$after" -v reviewed="$reviewed" -v ufile="$tmp.u" '
      function words(s, idx,   a, n, i, w, c) {
        s = tolower(s); sub(/\(lesson lc-[0-9a-f]+\)/, "", s); gsub(/[^a-z0-9]+/, " ", s); n = split(s, a, " "); c = 0; WL[idx] = ""
        for (i = 1; i <= n; i++) { w = a[i]; if (length(w) >= 3 && !(w in STOP) && !((idx, w) in HAS)) { HAS[idx, w] = 1; WL[idx] = WL[idx] " " w; c++ } }
        return c
      }
      function neg(s) { s = " " tolower(s) " "; return s ~ / (never|not|dont|don.t|avoid|forbidden|forbid|without|no) / }
      function pos(s) { s = " " tolower(s) " "; return s ~ / (always|must|should|use|prefer|require|required) / }
      function q(s) { return (length(s) > 90) ? substr(s, 1, 87) "..." : s }
      BEGIN { split("the and for use are not any all can may this that with from when then than they them have will your into only each also does done must should never always avoid make sure their about which where while those these", sw, " "); for (i in sw) STOP[sw[i]] = 1
        while ((getline l < ufile) > 0) { split(l, p, "\t"); if (p[2] != "-") cited[p[2]]++ } }
      { id[NR] = $1; txt[NR] = $3; cnt[NR] = words($3, NR); n = NR }
      END {
        np = 0
        for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) {
          inter = 0; nw = split(WL[i], wa, " "); for (k = 1; k <= nw; k++) if ((j, wa[k]) in HAS) inter++
          un = cnt[i] + cnt[j] - inter; mn = (cnt[i] < cnt[j]) ? cnt[i] : cnt[j]
          jac = (un > 0) ? inter / un : 0; cont = (mn > 0) ? inter / mn : 0
          opp = (neg(txt[i]) && !neg(txt[j]) && pos(txt[j])) || (neg(txt[j]) && !neg(txt[i]) && pos(txt[i]))
          if (opp && inter >= 3 && jac >= 0.3) {
            printf "  ask the user: %s says \"%s\" but %s says \"%s\"; which one holds?\n", id[i], q(txt[i]), id[j], q(txt[j]); np++ }
          else if ((jac >= 0.6) || (mn >= 4 && cont >= 0.85)) { printf "  merge: %s and %s repeat each other (%d%% of their words are shared): \"%s\" / \"%s\"\n", id[i], id[j], jac * 100, q(txt[i]), q(txt[j]); np++ }
        }
        if (reviewed >= after) for (i = 1; i <= n; i++) if (!(id[i] in cited)) { printf "  remove: %s was cited by none of the %d reviewed runs counted: \"%s\"\n", id[i], reviewed, q(txt[i]); np++ }
        if (reviewed < after) printf "  usage: %d reviewed run(s) counted, a rule is proposed for removal only after %d\n", reviewed, after
        if (np == 0) print "  no proposal"
      }' "$tmp" > "$tmp.out"
    if [ "$st" = OVER ]; then echo "  the rules are over their budget: merge the repeats, settle the contradictions, drop what no review used"; fi
    cat "$tmp.out"; rm -f "$tmp.out"
    echo "  nothing is changed: a rule is merged, answered or removed only after your own message approves that exact change" ;;
  *) echo "usage: rules.sh <list|report|tally>   (there is no operation that changes a rule)" >&2; exit 2 ;;
esac
