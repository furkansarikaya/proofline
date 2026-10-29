#!/bin/sh
# Jira Cloud task-integration adapter. NOT TESTED against a real Jira: written to the adapter contract
# (README.md) and smoke-tested only for argument validation with a fake curl. Treat it as a starting point.
#
#   jira.sh import   <KEY-N> <out TASK.md>   exit 3 + "MISSING <field>" when incomplete
#   jira.sh publish  <KEY-N> <report-file>   adds an ADF comment, tries the Done transition; prints <KEY-N>#<sha256>
#   jira.sh verify   <KEY-N> <receipt>       exit 0 iff the comment carrying that hash is still on the issue
#   jira.sh followup <KEY-N> <waiver-file>   creates a Task in the same project; prints the new key
#   jira.sh status   <KEY-N> <backlog|todo|in-progress|done>   runs the workflow transition with the matching name
#   jira.sh statusblock <KEY-N> <block-file>   creates or edits in place the ONE proofline status comment (found by its marker)
#
# shellcheck disable=SC1003 # the backslash in a case pattern is intended
# Environment: JIRA_BASE_URL (https://<site>.atlassian.net), JIRA_EMAIL, JIRA_API_TOKEN. Requires curl and jq.
# The token is handed to curl on stdin (curl -K -), so it appears in no argument list, log or error message.
# Comments use the minimal ADF document (one paragraph per non-empty line). The run's task ID is the issue key.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
pl_name='jira adapter'
# shellcheck source=_lib.sh
# shellcheck source-path=SCRIPTDIR
. "$here/_lib.sh"

op=${1:-}
case "$op" in import|publish|verify|followup|status|statusblock) ;; *) pl_usage 'jira.sh <import|publish|verify|followup|status|statusblock> ...' ;; esac

key_ok() { pl_id "$1"; case "$1" in [A-Z]*-[0-9]*) ;; *) pl_die "not a Jira issue key (expected PROJ-123): $1" ;; esac; }
jira_ready() {
  [ -n "${JIRA_BASE_URL:-}" ] && [ -n "${JIRA_EMAIL:-}" ] && [ -n "${JIRA_API_TOKEN:-}" ] || pl_die "JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set"
  case "$JIRA_BASE_URL" in https://*) ;; *) pl_die "JIRA_BASE_URL must start with https://" ;; esac
  case "$JIRA_EMAIL$JIRA_API_TOKEN" in *'"'*|*'\'*) pl_die "JIRA_EMAIL / JIRA_API_TOKEN contain unsupported characters" ;; esac
  command -v curl >/dev/null 2>&1 || pl_die "curl is required"
  command -v jq >/dev/null 2>&1 || pl_die "jq is required"
}
# jira_api METHOD PATH [JSON-FILE]
jira_api() {
  ja_m=$1 ja_p=$2 ja_f=${3:-}
  if [ -n "$ja_f" ]; then
    printf 'user = "%s:%s"\n' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | curl -sS --max-time 30 --fail-with-body -K - -X "$ja_m" -H 'Accept: application/json' -H 'Content-Type: application/json' --data-binary "@$ja_f" "${JIRA_BASE_URL%/}$ja_p"
  else
    printf 'user = "%s:%s"\n' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | curl -sS --max-time 30 --fail-with-body -K - -X "$ja_m" -H 'Accept: application/json' "${JIRA_BASE_URL%/}$ja_p"
  fi
}
adf() { jq -Rs '{type:"doc",version:1,content:(split("\n")|map(select(length>0)|{type:"paragraph",content:[{type:"text",text:.}]}))}'; }
transition() {   # KEY STATE
  case "$2" in backlog) tn=backlog ;; todo) tn='to do' ;; in-progress) tn='in progress' ;; "done") tn='done' ;; *) pl_die "unknown status: $2 (backlog|todo|in-progress|done)" ;; esac
  tid=$(jira_api GET "/rest/api/3/issue/$1/transitions" | jq -r --arg n "$tn" '[.transitions[]|select((.name|ascii_downcase)==$n)][0].id // empty') || return 1
  [ -n "$tid" ] || return 1
  tf=$(mktemp "${TMPDIR:-/tmp}/jira.XXXXXX"); printf '{"transition":{"id":"%s"}}' "$tid" > "$tf"
  if jira_api POST "/rest/api/3/issue/$1/transitions" "$tf" >/dev/null; then rm -f "$tf"; else rm -f "$tf"; return 1; fi
}

case "$op" in
  import)
    [ $# -eq 3 ] || pl_usage 'jira.sh import <KEY-N> <out TASK.md>'
    key_ok "$2"; jira_ready
    raw=$(jira_api GET "/rest/api/2/issue/$2?fields=summary,description,labels,components") || pl_die "cannot read issue $2"
    title=$(printf '%s' "$raw" | jq -r '.fields.summary // ""')
    work=$(mktemp "${TMPDIR:-/tmp}/jira-import.XXXXXX")
    { printf '## Description\n\n'; printf '%s' "$raw" | jq -r '.fields.description // ""'
      printf '\n\n## Labels\n\n'; printf '%s' "$raw" | jq -r '.fields.labels[]? | "- " + .'
      printf '\n\n## Components\n\n'; printf '%s' "$raw" | jq -r '.fields.components[]?.name | "- " + .'; } > "$work"
    rc=0; pl_import jira "$work" "$3" "$2" "$title" "jira ${JIRA_BASE_URL%/}/browse/$2" || rc=$?
    rm -f "$work"; exit "$rc"
    ;;
  publish)
    [ $# -eq 3 ] || pl_usage 'jira.sh publish <KEY-N> <report-file>'
    key_ok "$2"; [ -f "$3" ] || pl_die "report file missing: $3"; jira_ready
    hash=$(pl_sha < "$3"); tf=$(mktemp "${TMPDIR:-/tmp}/jira.XXXXXX")
    { printf 'proofline-completion-report %s sha256:%s\n' "$2" "$hash"; cat "$3"; } | adf | jq '{body:.}' > "$tf"
    jira_api POST "/rest/api/3/issue/$2/comment" "$tf" >/dev/null || { rm -f "$tf"; pl_die "could not comment on $2"; }
    rm -f "$tf"
    transition "$2" "done" || printf '%s: report published, but the Done transition could not be applied to %s\n' "$pl_name" "$2" >&2
    printf '%s#%s\n' "$2" "$hash"
    ;;
  verify)
    [ $# -eq 3 ] || pl_usage 'jira.sh verify <KEY-N> <receipt>'
    key_ok "$2"; receipt=$3
    if [ -f "$receipt" ]; then receipt="$2#$(pl_sha < "$receipt")"; fi
    want=${receipt#*#}
    [ "${receipt%%#*}" = "$2" ] && [ -n "$want" ] && [ "$want" != "$receipt" ] || pl_die "malformed receipt: $receipt"
    jira_ready
    jira_api GET "/rest/api/3/issue/$2/comment?maxResults=1000" | grep -Fq "proofline-completion-report $2 sha256:$want" \
      || pl_die "no completion-report comment with that hash on $2"
    ;;
  followup)
    [ $# -eq 3 ] || pl_usage 'jira.sh followup <KEY-N> <waiver-file>'
    key_ok "$2"; [ -f "$3" ] || pl_die "waiver file missing: $3"; jira_ready
    title=$(sed -n 's/^# //p' "$3" | head -1); [ -n "$title" ] || title="Follow-up of $2"
    tf=$(mktemp "${TMPDIR:-/tmp}/jira.XXXXXX")
    adf < "$3" | jq --arg p "${2%%-*}" --arg s "$title" '{fields:{project:{key:$p},summary:$s,issuetype:{name:"Task"},description:.}}' > "$tf"
    new=$(jira_api POST /rest/api/3/issue "$tf" | jq -r '.key // empty') || { rm -f "$tf"; pl_die "could not create the follow-up issue"; }
    rm -f "$tf"; [ -n "$new" ] || pl_die "Jira returned no issue key"
    printf '%s\n' "$new"
    ;;
  statusblock)
    [ $# -eq 3 ] || pl_usage 'jira.sh statusblock <KEY-N> <block-file>'
    key_ok "$2"; pl_status_check "$2" "$3"; jira_ready
    tf=$(mktemp "${TMPDIR:-/tmp}/jira.XXXXXX")
    pl_status_comment "$2" "$3" | adf | jq '{body:.}' > "$tf"
    # the marker text opens our comment: the newest comment whose body starts with it is edited in place (PUT); a new one only when there is none
    cid=$(jira_api GET "/rest/api/3/issue/$2/comment?maxResults=1000" | jq -r --arg m "<!-- proofline:status:$2 -->" '[.comments[]? | select((.body.content[0].content[0].text // "") | startswith($m))] | last | .id // empty') || cid=''
    case "$cid" in *[!0-9]*) cid='' ;; esac
    if [ -n "$cid" ]; then jira_api PUT "/rest/api/3/issue/$2/comment/$cid" "$tf" >/dev/null || { rm -f "$tf"; pl_die "could not update the status comment on $2"; }
    else jira_api POST "/rest/api/3/issue/$2/comment" "$tf" >/dev/null || { rm -f "$tf"; pl_die "could not comment on $2"; }; fi
    rm -f "$tf"
    ;;
  status)
    [ $# -eq 3 ] || pl_usage 'jira.sh status <KEY-N> <backlog|todo|in-progress|done>'
    key_ok "$2"; jira_ready
    transition "$2" "$3" || pl_die "no matching workflow transition for $3 on $2"
    printf '%s\n' "$3"
    ;;
esac
