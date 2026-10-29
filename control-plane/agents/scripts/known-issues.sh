#!/bin/sh
# shellcheck disable=SC1010,SC2012,SC2013 # `done` is a word in a case pattern; our own file names and finding ids are word-safe
# Known issues (A202, item 27): findings that were already there before a task and that the task does not touch must not stop it,
# but only the USER decides which ones. This is the data side; agent.sh decides what a match means (known-issue-* commands, the gate
# status, the Facts block). Nothing here is read into a session's context: the file is read by scripts and by the user.
#
# File: .agents/local/known-issues/LIST.tsv (the main tree's, shared by every worktree; local like the approvals, never auto-loaded).
# One record per line, tab separated:
#   KI-<n> <gate[:focus]> <place> <finding text> <follow-up task id> <approval file> <date>
# gate[:focus] and the text are the finding's own (whitespace squeezed); place is `path` or `path:line` of a tracked file. A record is
# valid only while ALL of these hold; any doubt makes it ignored and the finding stays blocking (the safe side):
#   - gate is not SECRETS or SECURITY, nor a focus naming either (those are never listed, whatever the file says);
#   - the approval file named in the record is the user's: kind known-issue, answered_by user, source prompt_capture or tty, consumed,
#     with a request file next to it, and its `bound` is the sha256 of "<gate>\t<place>\t<text>\t<follow-up>\n" (an edited or invented
#     record has no approval for its content; one approval backs one record);
#   - the follow-up task exists as a markdown task file and is not done (a closed follow-up drops the record: it moves to CLOSED.tsv).
# Matching is exact on gate, place and text. Whether the task touches the place is agent.sh's check (frozen scope and actual diff).
#   known-issues.sh canon RECORD FINDING-ID       gate<TAB>place<TAB>text of a blocking finding of a gate record
#   known-issues.sh listable GATE PLACE            exit 0, or 1 with the reason: SECRETS/SECURITY, place not a tracked file
#   known-issues.sh lookup GATE PLACE TEXT         KI-<n><TAB>follow-up of the exact, valid, active record; exit 1 when none
#   known-issues.sh followup-state TASK-ID         backlog|todo|in-progress|done|unknown
#   known-issues.sh append GATE PLACE TEXT FOLLOWUP APPROVAL-FILE   writes the record after every check (agent.sh known-issue-apply)
#   known-issues.sh list                           the records, their state, and the closed ones
#   known-issues.sh candidates                     blocking findings recorded by runs on this machine, not on the list, whose run did not touch the place
# Environment (set by agent.sh): KI_DIR, KI_APPROVALS, KI_TASKS (absolute tasks dir), KI_ADAPTER, KI_MAIN (main working tree), KI_RUNS
# (run folders, space separated: <dir> holding <ID>/RUN.yaml).
set -u
LC_ALL=C; export LC_ALL
op=${1:-}; [ $# -eq 0 ] || shift
die() { echo "known-issues: $*" >&2; exit 1; }
: "${KI_DIR:?}" "${KI_APPROVALS:?}" "${KI_TASKS:?}" "${KI_MAIN:?}"
list=$KI_DIR/LIST.tsv
tab=$(printf '\t')
if command -v shasum >/dev/null 2>&1; then sha() { shasum -a 256 | cut -d' ' -f1; }; else sha() { sha256sum | cut -d' ' -f1; }; fi
norm() { tr '\t\r\n' '   ' | sed 's/  */ /g; s/^ //; s/ $//'; }
# gate_refused GATE: 0 when the gate or its focus is SECRETS or SECURITY (never listable, ignored when found in the file)
gate_refused() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | grep -Eq 'secret|secur'; }
place_path() { printf '%s' "${1%%:*}"; }
place_ok() { # PLACE: a repository-relative path with an optional :line
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*(:[0-9]+(-[0-9]+)?)?$' || return 1
  case "$(place_path "$1")" in *..*|*/|./*) return 1 ;; esac
  return 0
}
fu_state() { # TASK-ID
  case "${KI_ADAPTER:-markdown}" in markdown) ;; *) echo unknown; return 0 ;; esac
  fs_id=$1
  case "$fs_id" in ''|*[!A-Za-z0-9._-]*) echo unknown; return 0 ;; esac
  for fs_f in "$KI_TASKS"/*/"$fs_id".md "$KI_TASKS"/*/"$fs_id"-*.md "$KI_TASKS/$fs_id.md" "$KI_TASKS/$fs_id"-*.md; do
    [ -f "$fs_f" ] && [ ! -L "$fs_f" ] || continue
    fs_b=$(basename "$fs_f" .md)
    case "$fs_b" in "$fs_id"-FU[0-9]*) continue ;; esac
    fs_d=$(basename "$(dirname "$fs_f")")
    fs_s=$(sed -n 's/^\*\*Status:\*\*[[:space:]]*//p' "$fs_f" | head -1 | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z-')
    case "$fs_s" in done|closed|complete|completed) echo done; return 0 ;; esac
    case "$fs_d" in done) echo done; return 0 ;; backlog|todo|in-progress) echo "$fs_d"; return 0 ;; esac
    case "$fs_s" in backlog|todo|in-progress) echo "$fs_s" ;; *) echo todo ;; esac
    return 0
  done
  echo unknown
}
# approval_ok FILE BOUND: the user's recorded approval of exactly this content
approval_ok() {
  ao_f=$KI_APPROVALS/$1
  case "$1" in [0-9][0-9][0-9]-known-issue.yaml) ;; *) return 1 ;; esac
  [ -f "$ao_f" ] && [ ! -L "$ao_f" ] || return 1
  ao_v() { sed -n "s/^$1: \"\\(.*\\)\"\$/\\1/p" "$ao_f" | head -1; }
  [ "$(ao_v kind)" = known-issue ] && [ "$(ao_v answered_by)" = user ] && [ "$(ao_v consumed)" = true ] || return 1
  case "$(ao_v source)" in prompt_capture|tty) ;; *) return 1 ;; esac
  [ -n "$(ao_v capture_id)" ] && [ "$(ao_v bound)" = "$2" ] || return 1
  ao_r=$(ao_v request); case "$ao_r" in [0-9][0-9][0-9]-request-known-issue.yaml) ;; *) return 1 ;; esac
  [ -f "$KI_APPROVALS/$ao_r" ] && [ ! -L "$KI_APPROVALS/$ao_r" ] || return 1
  [ "$(sed -n 's/^bound: "\(.*\)"$/\1/p' "$KI_APPROVALS/$ao_r" | head -1)" = "$2" ]
}
row_bound() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" | sha; } # GATE PLACE TEXT FOLLOWUP
# row_state ROW: active | closed | invalid
row_state() {
  rs_n=$(printf '%s' "$1" | awk -F'\t' '{ print NF }')
  [ "$rs_n" -ge 7 ] || { echo invalid; return 0; }
  IFS=$tab read -r rs_id rs_g rs_p rs_t rs_f rs_a _rs_d <<EOF
$1
EOF
  printf '%s' "$rs_id" | grep -Eq '^KI-[0-9]+$' || { echo invalid; return 0; }
  gate_refused "$rs_g" && { echo invalid; return 0; }
  place_ok "$rs_p" || { echo invalid; return 0; }
  [ -n "$rs_t" ] && [ -n "$rs_f" ] || { echo invalid; return 0; }   # a record without a follow-up task is not a record
  approval_ok "$rs_a" "$(row_bound "$rs_g" "$rs_p" "$rs_t" "$rs_f")" || { echo invalid; return 0; }
  # one approval backs one record
  [ "$(awk -F'\t' -v a="$rs_a" '$6 == a' "$list" 2>/dev/null | wc -l | tr -d ' ')" = 1 ] || { echo invalid; return 0; }
  case "$(fu_state "$rs_f")" in done) echo closed ;; unknown) echo invalid ;; *) echo active ;; esac
}
case "$op" in
  canon)
    [ $# -eq 2 ] || die "usage: canon RECORD FINDING-ID"
    awk -F'|' -v want="$2" '
      function t(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
      /^gate: / { g = $0; sub(/^gate: *"?/, "", g); sub(/"?[ \t]*$/, "", g) }
      /^focus: / { f = $0; sub(/^focus: *"?/, "", f); sub(/"?[ \t]*$/, "", f) }
      /^finding: / { r = $0; sub(/^finding: /, "", r); n = split(r, p, "|")
        if (toupper(t(p[1])) == toupper(want) && t(p[2]) == "blocking") { id = 1; pl = t(p[3]); tx = t(p[4]) } }
      END { if (!id) exit 1; if (f == "" || f == "-") k = g; else k = g ":" f; printf "%s\t%s\t%s\n", k, pl, tx }' "$1" > "$KI_DIR.canon.$$" || { rm -f "$KI_DIR.canon.$$"; exit 1; }
    IFS=$tab read -r c_g c_p c_t < "$KI_DIR.canon.$$"; rm -f "$KI_DIR.canon.$$"
    printf '%s\t%s\t%s\n' "$c_g" "$c_p" "$(printf '%s' "$c_t" | norm)" ;;
  listable)
    [ $# -eq 2 ] || die "usage: listable GATE PLACE"
    gate_refused "$1" && die "$1 findings are never listed as known issues (SECRETS and SECURITY always stop the task)"
    place_ok "$2" || die "the place '$2' is not a repository path (path or path:line of a tracked file): a finding whose place cannot be computed stays blocking"
    git -C "$KI_MAIN" ls-files --error-unmatch -- "$(place_path "$2")" >/dev/null 2>&1 || die "the place $(place_path "$2") is not a tracked file of the project"
    ;;
  followup-state)
    [ $# -eq 1 ] || die "usage: followup-state TASK-ID"
    fu_state "$1" ;;
  lookup)
    [ $# -eq 3 ] || die "usage: lookup GATE PLACE TEXT"
    [ -s "$list" ] || exit 1
    gate_refused "$1" && exit 1
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      IFS=$tab read -r l_id l_g l_p l_t l_f _rest <<EOF
$row
EOF
      [ "$l_g" = "$1" ] && [ "$l_p" = "$2" ] && [ "$l_t" = "$3" ] || continue
      [ "$(row_state "$row")" = active ] || continue
      printf '%s\t%s\n' "$l_id" "$l_f"; exit 0
    done < "$list"
    exit 1 ;;
  append)
    [ $# -eq 5 ] || die "usage: append GATE PLACE TEXT FOLLOWUP APPROVAL-FILE"
    ap_g=$1 ap_p=$2 ap_t=$3 ap_f=$4 ap_a=$5
    sh "$0" listable "$ap_g" "$ap_p" || exit 1
    [ -n "$ap_t" ] || die "a record needs the finding text"
    [ -n "$ap_f" ] || die "a record without a follow-up task is not valid"
    case "$(fu_state "$ap_f")" in backlog|todo|in-progress) ;; done) die "the follow-up task $ap_f is already done" ;; *) die "the follow-up task $ap_f was not found as an open markdown task file in the tasks folder (a record needs a follow-up task that exists)" ;; esac
    approval_ok "$ap_a" "$(row_bound "$ap_g" "$ap_p" "$ap_t" "$ap_f")" || die "no recorded user approval (kind known-issue) for exactly this record"
    mkdir -p "$KI_DIR"
    if [ -s "$list" ]; then
      awk -F'\t' -v a="$ap_a" '$6 == a { f = 1 } END { exit !f }' "$list" && die "that approval already backs a record"
      awk -F'\t' -v g="$ap_g" -v p="$ap_p" -v t="$ap_t" '$2 == g && $3 == p && $4 == t { f = 1 } END { exit !f }' "$list" && die "this finding is already on the list"
    fi
    # closed records leave the list (they move, never vanish)
    if [ -s "$list" ]; then
      : > "$list.keep"
      while IFS= read -r row; do
        [ -n "$row" ] || continue
        case "$(row_state "$row")" in closed) printf '%s\n' "$row" >> "$KI_DIR/CLOSED.tsv" ;; *) printf '%s\n' "$row" >> "$list.keep" ;; esac
      done < "$list"
      mv "$list.keep" "$list"
    fi
    n=$(awk -F'\t' 'BEGIN { m = 0 } { sub(/^KI-/, "", $1); if ($1 + 0 > m) m = $1 + 0 } END { print m + 1 }' "$list" "$KI_DIR/CLOSED.tsv" 2>/dev/null || echo 1)
    printf 'KI-%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$ap_g" "$ap_p" "$ap_t" "$ap_f" "$ap_a" "$(date +%Y-%m-%d)" >> "$list"
    echo "KI-$n" ;;
  list)
    [ -s "$list" ] || { echo "known issues: none"; exit 0; }
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      IFS=$tab read -r l_id l_g l_p l_t l_f _rest <<EOF
$row
EOF
      printf '%s [%s] %s %s: %s (follow-up %s)\n' "${l_id:-?}" "$(row_state "$row")" "${l_g:-?}" "${l_p:-?}" "${l_t:-?}" "${l_f:-?}"
    done < "$list" ;;
  candidates)
    for runs in ${KI_RUNS:-}; do
      for rd in "$runs"/*/; do
        rd=${rd%/}; [ -f "$rd/RUN.yaml" ] && [ -d "$rd/gates" ] || continue
        scope=$(sed -n 's/^  scope_paths: *"\(.*\)"$/\1/p' "$rd/RUN.yaml" | head -1)
        [ -n "$scope" ] || continue   # no frozen scope: whether the run touched the place cannot be computed, so nothing is offered
        for gf in $(ls -1 "$rd"/gates/[0-9][0-9][0-9]-*.yaml 2>/dev/null | sort); do
          g=$(sed -n 's/^gate: *"\(.*\)"$/\1/p' "$gf" | head -1); fc=$(sed -n 's/^focus: *"\(.*\)"$/\1/p' "$gf" | head -1)
          printf '%s\t%s\n' "$g:${fc:--}" "$gf"
        done | awk -F'\t' '{ last[$1] = $2 } END { for (k in last) print last[k] }' | while IFS= read -r gf; do
          [ "$(sed -n 's/^result: *"\(.*\)"$/\1/p' "$gf" | head -1)" = fail ] || continue
          for fid in $(sed -n 's/^finding: \([^|]*\)|blocking|.*/\1/p' "$gf"); do
            c=$(sh "$0" canon "$gf" "$fid") || continue
            IFS=$tab read -r c_g c_p c_t <<EOF
$c
EOF
            sh "$0" listable "$c_g" "$c_p" >/dev/null 2>&1 || continue
            pp=$(place_path "$c_p"); hit=no
            for se in $(printf '%s' "$scope" | tr ',' ' '); do
              se=${se%/}
              # shellcheck disable=SC2254 # a scope entry may be a glob
              case "$pp" in "$se"|"$se"/*) hit=yes ;; esac
              # shellcheck disable=SC2254
              case "$se" in *'*'*|*'?'*) case "$pp" in $se) hit=yes ;; esac ;; esac
            done
            [ "$hit" = no ] || continue
            sh "$0" lookup "$c_g" "$c_p" "$c_t" >/dev/null 2>&1 && continue
            printf '%s\t%s\t%s\t%s\t%s\n' "$(basename "$rd")" "$fid" "$c_g" "$c_p" "$c_t"
          done
        done
      done
    done | sort -u -t "$tab" -k3,5 ;;
  *) die "usage: known-issues.sh canon|listable|lookup|followup-state|append|list|candidates ..." ;;
esac
