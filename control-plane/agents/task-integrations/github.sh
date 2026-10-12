#!/bin/sh
# GitHub Issues task-integration adapter (fully supported and tested against a fake `gh`). Contract: README.md.
#
#   github.sh import   <N|#N|GH-N|issue-url|owner/repo#N> <out TASK.md>   exit 3 + "MISSING <field>" when incomplete
#   github.sh publish  <GH-N> <report-file>   comments the report on the issue (edits its own earlier report comment instead of adding another), sets label proofline:done; prints <N>#<sha256>
#   github.sh verify   <GH-N> <receipt>       exit 0 iff the comment carrying that hash is still on the issue
#   github.sh followup <GH-N> <waiver-file>   gh issue create; prints the new issue URL
#   github.sh status   <GH-N> <backlog|todo|in-progress|done>   swaps the proofline:<state> label
#
# Only the `gh` CLI is used (gh issue view --json, comment, edit --add-label/--remove-label, create). No token is
# read, stored or logged here: authentication is gh's own. The task ID of a run is GH-<issue number>; the
# repository is the one gh resolves (current directory remote or GH_REPO).
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
pl_name='github adapter'
# shellcheck source=_lib.sh
# shellcheck source-path=SCRIPTDIR
. "$here/_lib.sh"

op=${1:-}
case "$op" in import|publish|verify|followup|status) ;; *) pl_usage 'github.sh <import|publish|verify|followup|status> ...' ;; esac

gh_ready() {
  command -v gh >/dev/null 2>&1 || pl_die "the gh CLI is not installed (https://cli.github.com); nothing was changed"
  gh auth status >/dev/null 2>&1 || pl_die "gh is not authenticated; run 'gh auth login' (this adapter never handles tokens); nothing was changed"
}
# gh_ref REF: sets gn (issue number) and gh_repo (owner/repo for the URL and owner/repo#N forms, else empty).
# Runs in the caller's shell (no command substitution) so both survive; every gh call goes through ghr.
gh_ref() {
  gh_repo=''
  case "$1" in
    https://github.com/*/*/issues/[0-9]*) gn_r=${1#https://github.com/}; gh_repo=${gn_r%%/issues/*}; gn=${gn_r##*/issues/}; gn=${gn%%[!0-9]*} ;;
    */*#[0-9]*) gh_repo=${1%%#*}; gn=${1##*#} ;;
    GH-[0-9]*) gn=${1#GH-} ;;
    '#'[0-9]*) gn=${1#'#'} ;;
    *) gn=$1 ;;
  esac
  case "$gn" in ''|*[!0-9]*) pl_die "not a GitHub issue reference (expected N, #N, GH-N, an issue URL or owner/repo#N): $1" ;; esac
}
gh_id() {   # run task ID -> gn (GH-<n> only)
  case "$1" in GH-[0-9]*) gh_ref "$1" ;; *) pl_die "task id must be GH-<issue number>: $1" ;; esac
}
ghr() { if [ -n "$gh_repo" ]; then gh "$@" --repo "$gh_repo"; else gh "$@"; fi; }
set_state() {   # N STATE: exactly one proofline:<state> label
  ss_have=$(ghr issue view "$1" --json labels --jq '.labels[].name') || return 1
  ss_rm=''
  for ss_l in $ss_have; do
    case "$ss_l" in "proofline:$2") ;; proofline:*) ss_rm=${ss_rm:+$ss_rm,}$ss_l ;; esac
  done
  case "
$ss_have
" in *"
proofline:$2
"*) [ -z "$ss_rm" ] && return 0; ghr issue edit "$1" --remove-label "$ss_rm" >/dev/null ;;
    *) if [ -n "$ss_rm" ]; then ghr issue edit "$1" --add-label "proofline:$2" --remove-label "$ss_rm" >/dev/null; else ghr issue edit "$1" --add-label "proofline:$2" >/dev/null; fi ;;
  esac
}

case "$op" in
  import)
    [ $# -eq 3 ] || pl_usage 'github.sh import <N|#N|GH-N|issue-url|owner/repo#N> <out TASK.md>'
    gh_ready
    gh_ref "$2"; n=$gn out=$3
    title=$(ghr issue view "$n" --json title --jq .title) || pl_die "cannot read issue $n"
    url=$(ghr issue view "$n" --json url --jq .url) || pl_die "cannot read issue $n"
    work=$(mktemp "${TMPDIR:-/tmp}/gh-import.XXXXXX")
    ghr issue view "$n" --json body --jq .body > "$work" || { rm -f "$work"; pl_die "cannot read issue $n"; }
    labels=$(ghr issue view "$n" --json labels --jq '.labels[].name') || labels=''
    if [ -n "$labels" ] && ! grep -Eqi '^#+[[:space:]]+labels[[:space:]]*$' "$work"; then
      { printf '\n\n## Labels\n\n'; printf '%s\n' "$labels" | sed 's/^/- /'; } >> "$work"
    fi
    rc=0; pl_import github "$work" "$out" "GH-$n" "$title" "github $url" || rc=$?
    rm -f "$work"; exit "$rc"
    ;;
  publish)
    [ $# -eq 3 ] || pl_usage 'github.sh publish <GH-N> <report-file>'
    gh_id "$2"; n=$gn report=$3; [ -f "$report" ] || pl_die "report file missing: $report"
    gh_ready
    hash=$(pl_sha < "$report")
    body=$(mktemp "${TMPDIR:-/tmp}/gh-report.XXXXXX")
    { printf '<!-- proofline:completion-report:%s sha256:%s -->\n' "$2" "$hash"; cat "$report"; } > "$body"
    # idempotent: edit our earlier report comment (marker prefix) in place; comment anew only when there is none
    prev=$(ghr issue view "$n" --json comments --jq "[.comments[] | select(.body | startswith(\"<!-- proofline:completion-report:$2 \"))] | last | .url // empty" 2>/dev/null || true)
    cid=${prev##*#issuecomment-}
    case "$cid" in ''|*[!0-9]*) cid='' ;; esac
    slug=${gh_repo:-'{owner}/{repo}'}
    if [ -n "$cid" ] && gh api -X PATCH "repos/$slug/issues/comments/$cid" -F "body=@$body" >/dev/null 2>&1; then :
    elif ! ghr issue comment "$n" --body-file "$body" >/dev/null; then rm -f "$body"; pl_die "could not comment on issue $n"; fi
    rm -f "$body"
    set_state "$n" "done" || printf '%s: report published, but the proofline:done label could not be set on issue %s\n' "$pl_name" "$n" >&2
    printf '%s#%s\n' "$n" "$hash"
    ;;
  verify)
    [ $# -eq 3 ] || pl_usage 'github.sh verify <GH-N> <receipt>'
    gh_id "$2"; n=$gn receipt=$3
    if [ -f "$receipt" ]; then receipt="$n#$(pl_sha < "$receipt")"; fi
    want=${receipt#*#}
    [ "${receipt%%#*}" = "$n" ] && [ -n "$want" ] && [ "$want" != "$receipt" ] || pl_die "malformed receipt: $receipt"
    gh_ready
    ghr issue view "$n" --json comments --jq '.comments[].body' | grep -Fq "<!-- proofline:completion-report:$2 sha256:$want -->" \
      || pl_die "no completion-report comment with that hash on issue $n"
    ;;
  followup)
    [ $# -eq 3 ] || pl_usage 'github.sh followup <GH-N> <waiver-file>'
    gh_id "$2"; wf=$3; [ -f "$wf" ] || pl_die "waiver file missing: $wf"
    gh_ready
    title=$(sed -n 's/^# //p' "$wf" | head -1); [ -n "$title" ] || title="Follow-up of $2"
    ghr issue create --title "$title" --body-file "$wf" || pl_die "could not create the follow-up issue"
    ;;
  status)
    [ $# -eq 3 ] || pl_usage 'github.sh status <GH-N> <backlog|todo|in-progress|done>'
    gh_id "$2"; n=$gn
    case "$3" in backlog|todo|in-progress|done) ;; *) pl_die "unknown status: $3 (backlog|todo|in-progress|done)" ;; esac
    gh_ready
    set_state "$n" "$3" || pl_die "could not update labels on issue $n"
    printf '%s\n' "$3"
    ;;
esac
