#!/bin/sh
# Lesson candidates from run evidence. A lesson comes only from evidence and becomes a rule only with the
# user's approval; this script is the whole mechanism (no store of its own: the candidates are rows of one wiki
# page, the promoted rule is a line in AGENTS.md). Run through `agent.sh lessons <op> ...`.
#   derive ID                  candidates from the run's gate records: one line per non-info finding,
#                              "<source> | kind=<GATE>:<focus> | <finding text>"
#   write ID SOURCE TEXT       lead only: append a candidate row to docs/wiki/lessons/observations.md; refused
#                              when SOURCE does not resolve to a gate record (or a finding in it) of the run
#   validate                   every row of the page has a well-formed source (resolved while the run exists)
#   count [KIND]               "<kind> | runs=N | repeats=N-1 | propose=yes|no": distinct runs per finding kind,
#                              from the page rows and the gate records of the runs now on disk
#   bound ID CAND              hash of the candidate row (what an approval of kind rule:CAND binds to)
#   text CAND                  the candidate's text
#   promote ID CAND            lead only: append the candidate to the "## Project rules" section of AGENTS.md
#                              and mark the row promoted; refused without an unconsumed `rule:CAND` approval
# SOURCE = gate:<RUN>/<NNN-GATE>[#<FINDING-ID>]. Kind of a finding = the gate and risk focus of its record.
# shortcut: the gate record is read as written (agent.sh verify-gates owns its integrity); a row of a run that is
# already cleaned up keeps its source text unchecked. Promotion targets AGENTS.md only; a config change is made
# by the normal route. Upgrade when a record needs a ledger check or a lesson needs a config target.
# shellcheck disable=SC2016,SC2086 # literal backticks in the page text; $1 is split on | on purpose
set -u
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
page=$root/docs/wiki/lessons/observations.md
op=${1:-}; [ $# -eq 0 ] || shift
die() { echo "lessons: $*" >&2; exit 1; }
need_lead() { case "${AGENT_ROLE:-lead}" in lead) ;; *) die "only the lead runs '$op'" ;; esac; }
trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
h8() { printf '%s' "$1" | git hash-object --stdin | cut -c1-8; }
rdir() { printf '%s/.agents/runs/%s\n' "$root" "$1"; }

# findings RUN: one line per non-info finding of every gate record: "<gate file>\t<finding id>\t<kind>\t<text>"
findings() {
  for f in "$(rdir "$1")"/gates/[0-9][0-9][0-9]-*.yaml; do
    [ -f "$f" ] || continue
    awk -v gf="$(basename "$f" .yaml)" '
      function t(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
      /^gate: / { g = $2; gsub(/"/, "", g) }
      /^focus: / { fc = $0; sub(/^focus: */, "", fc); gsub(/"/, "", fc) }
      /^finding: / { r = substr($0, 10); n = split(r, p, "|"); if (t(p[2]) != "info") { gsub(/\t/, " ", p[4]); R[++m] = t(p[1]) "\t" t(p[4]) } }
      END { if (fc == "") fc = "-"; for (i = 1; i <= m; i++) { split(R[i], q, "\t"); print gf "\t" q[1] "\t" g ":" fc "\t" q[2] } }' "$f"
  done
}
# kind_of_gate RUN GATEFILE
kind_of_gate() {
  f=$(rdir "$1")/gates/$2.yaml; [ -f "$f" ] || return 1
  g=$(sed -n 's/^gate: *"\(.*\)"/\1/p' "$f" | head -1); fc=$(sed -n 's/^focus: *"\(.*\)"/\1/p' "$f" | head -1)
  printf '%s:%s\n' "$g" "${fc:--}"
}
# check_source SOURCE -> prints "<run> <kind>" (kind "?" for a cleaned run); returns 1 with a message on stderr
check_source() {
  case "$1" in gate:?*/[0-9][0-9][0-9]-*) ;; *) echo "source '$1' is not gate:<RUN>/<NNN-GATE>[#<FINDING-ID>]" >&2; return 1 ;; esac
  cs_r=${1#gate:}; cs_run=${cs_r%%/*}; cs_r=${cs_r#*/}; cs_gate=${cs_r%%#*}; cs_fid=''
  case "$cs_r" in *'#'*) cs_fid=${cs_r#*#} ;; esac
  case "$cs_run$cs_gate$cs_fid" in *[!A-Za-z0-9._#+-]*) echo "source '$1' holds an invalid character" >&2; return 1 ;; esac
  if [ ! -d "$(rdir "$cs_run")" ]; then echo "$cs_run ?"; return 0; fi   # cleaned run: the page row is the record
  cs_k=$(kind_of_gate "$cs_run" "$cs_gate") || { echo "source '$1': run $cs_run has no gate record $cs_gate" >&2; return 1; }
  if [ -n "$cs_fid" ]; then
    findings "$cs_run" | awk -F'\t' -v g="$cs_gate" -v i="$cs_fid" '$1 == g && $2 == i { f = 1 } END { exit !f }' || { echo "source '$1': gate record $cs_gate has no non-info finding $cs_fid" >&2; return 1; }
  fi
  echo "$cs_run $cs_k"
}
cand_id() { printf 'lc-%s\n' "$(h8 "$1")"; }
# rows: the candidate rows of the page
rows() { [ -f "$page" ] || return 0; grep '^- lc-' "$page" || :; }
# row_of CAND -> the row line, or exit 1
row_of() { rows | grep -F -- "- $1 | " | head -1 | grep . ; }
# row_fields ROW -> sets r_id r_kind r_run r_src r_st r_text
row_fields() {
  oldifs=$IFS; IFS='|'
  # shellcheck disable=SC2086
  set -f; set -- $1; set +f; IFS=$oldifs
  r_id=$(trim "${1#- }"); r_kind=$(trim "${2:-}"); r_run=$(trim "${3:-}"); r_src=$(trim "${4:-}"); r_st=$(trim "${5:-}")
  r_kind=${r_kind#kind=}; r_run=${r_run#run=}; r_src=${r_src#source=}; r_st=${r_st#status=}
}
row_text() { printf '%s' "$1" | cut -d'|' -f6- | sed 's/^[[:space:]]*//'; }

case "$op" in
  derive)
    id=${1:?usage: lessons.sh derive <ID>}; [ -d "$(rdir "$id")" ] || die "no run $id"
    findings "$id" | while IFS="$(printf '\t')" read -r gf fid kind text; do
      printf 'gate:%s/%s#%s | kind=%s | %s\n' "$id" "$gf" "$fid" "$kind" "$text"
    done ;;
  write)
    need_lead
    id=${1:?usage: lessons.sh write <ID> <SOURCE> <TEXT>}; src=${2:-}; text=${3:-}
    [ -n "$(trim "$text")" ] || die "a candidate needs text"
    case "$text" in *'
'*) die "a candidate is one line" ;; esac
    [ -d "$(rdir "$id")" ] || die "no run $id"
    res=$(check_source "$src") || die "candidate refused: no valid source"
    run=${res%% *}; kind=${res#* }
    [ "$run" = "$id" ] || die "candidate refused: source is run $run, not $id"
    cid=$(cand_id "$kind|$src")
    row_of "$cid" >/dev/null && die "candidate $cid is already written"
    mkdir -p "$(dirname "$page")" || die "cannot create the wiki folder"
    if [ ! -f "$page" ]; then
      printf -- '---\ntitle: lesson-observations\nstatus: current\nsource: .agents/KNOWLEDGE.md\n---\n\n# Lesson observations\n\nCandidates derived from run evidence. A candidate is a rule only after the user approved it (`agent.sh lessons promote`).\n\n' > "$page"
    fi
    printf -- '- %s | kind=%s | run=%s | source=%s | status=candidate | %s\n' "$cid" "$kind" "$id" "$src" "$text" >> "$page"
    echo "candidate written: $cid ($kind)" ;;
  validate)
    bad=0
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      row_fields "$row"
      r_t=$(row_text "$row")
      case "$r_id" in lc-????????) ;; *) echo "bad row id: $row" >&2; bad=1; continue ;; esac
      if [ -z "$r_src" ]; then echo "$r_id: no source" >&2; bad=1; continue; fi
      res=$(check_source "$r_src") || { echo "$r_id: invalid source" >&2; bad=1; continue; }
      [ "${res%% *}" = "$r_run" ] || { echo "$r_id: run=$r_run does not match its source" >&2; bad=1; continue; }
      [ "${res#* }" = "?" ] || [ "${res#* }" = "$r_kind" ] || { echo "$r_id: kind=$r_kind does not match its gate record (${res#* })" >&2; bad=1; continue; }
      case "$r_st" in candidate|promoted) ;; *) echo "$r_id: status must be candidate|promoted" >&2; bad=1 ;; esac
      [ -n "$r_t" ] || { echo "$r_id: no text" >&2; bad=1; }
    done <<EOF
$(rows)
EOF
    # a list item that is not a well-formed row cannot hide a sourceless candidate
    if [ -f "$page" ] && grep -E '^- ' "$page" | grep -vq '^- lc-'; then echo "page holds a list item that is not a candidate row" >&2; bad=1; fi
    [ "$bad" = 0 ] || exit 1
    echo "lessons valid" ;;
  count)
    want=${1:-}
    {
      rows | while IFS= read -r row; do row_fields "$row"; printf '%s\t%s\n' "$r_kind" "$r_run"; done
      for d in "$root"/.agents/runs/*/; do
        [ -d "$d" ] || continue; rid=$(basename "$d")
        findings "$rid" | while IFS="$(printf '\t')" read -r _ _ kind _; do printf '%s\t%s\n' "$kind" "$rid"; done
      done
    } | sort -u | awk -F'\t' -v want="$want" '$1 != "" && (want == "" || $1 == want) { n[$1]++ } END { for (k in n) print k "\t" n[k] }' | sort |
    while IFS="$(printf '\t')" read -r kind n; do
      prom=no; rows | grep -F -- "| kind=$kind |" | grep -q '| status=promoted |' && prom=yes
      pr=no; [ "$((n - 1))" -ge 2 ] && [ "$prom" = no ] && pr=yes
      printf '%s | runs=%s | repeats=%s | propose=%s\n' "$kind" "$n" "$((n - 1))" "$pr"
    done ;;
  bound)
    row=$(row_of "${2:?usage: lessons.sh bound <ID> <CAND>}") || die "no candidate ${2:-}"
    h8 "$row" ;;
  text)
    row=$(row_of "${1:?usage: lessons.sh text <CAND>}") || die "no candidate $1"
    row_text "$row" ;;
  promote)
    need_lead
    id=${1:?usage: lessons.sh promote <ID> <CAND>}; cand=${2:-}
    row=$(row_of "$cand") || die "no candidate $cand"
    row_fields "$row"; [ "$r_st" = candidate ] || die "candidate $cand is already $r_st"
    sh "$here/lessons.sh" validate >/dev/null || die "the observation page is not valid"
    [ -f "$root/AGENTS.md" ] || die "no AGENTS.md at the project root"
    # the approval is the user's: 'request-approval <ID> rule:<CAND>', relayed, answered in the user's own words
    sh "$here/agent.sh" approval-consume "$id" "rule:$cand" >/dev/null || die "promotion refused: no unconsumed user approval 'rule:$cand' bound to this candidate (run: agent.sh request-approval $id rule:$cand, relay it to the user)"
    tmp=$root/AGENTS.md.lessons.$$; bullet="- $(row_text "$row") (lesson $cand)"
    # shortcut: a new "## Project rules" section goes at the end of the file; an existing one gets the newest rule first.
    if grep -q '^## Project rules[[:space:]]*$' "$root/AGENTS.md"; then
      awk -v b="$bullet" 'pend { if ($0 == "") { print; print b; pend = 0; next } print b; pend = 0 } { print } /^## Project rules[[:space:]]*$/ && !d { pend = 1; d = 1 } END { if (pend) print b }' "$root/AGENTS.md" > "$tmp"
    else { cat "$root/AGENTS.md"; printf '\n## Project rules\n\n%s\n' "$bullet"; } > "$tmp"; fi || { rm -f "$tmp"; die "cannot write AGENTS.md"; }
    mv "$tmp" "$root/AGENTS.md" || die "cannot write AGENTS.md"
    tmp=$page.$$; sed "s/^\(- $cand | .* | source=[^|]* | \)status=candidate/\1status=promoted/" "$page" > "$tmp" && mv "$tmp" "$page"
    echo "promoted: $cand -> AGENTS.md" ;;
  *) echo "usage: lessons.sh <derive ID|write ID SOURCE TEXT|validate|count [KIND]|bound ID CAND|text CAND|promote ID CAND>" >&2; exit 2 ;;
esac
