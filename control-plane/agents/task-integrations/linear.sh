#!/bin/sh
# Linear task-integration adapter. NOT TESTED against a real Linear workspace: written to the adapter
# contract (README.md) and smoke-tested only for argument validation with a fake curl. Treat it as a starting point.
#
#   linear.sh import   <TEAM-N> <out TASK.md>   exit 3 + "MISSING <field>" when incomplete
#   linear.sh publish  <TEAM-N> <report-file>   commentCreate, then moves the issue to a completed state; prints <TEAM-N>#<sha256>
#   linear.sh verify   <TEAM-N> <receipt>       exit 0 iff the comment carrying that hash is still on the issue
#   linear.sh followup <TEAM-N> <waiver-file>   issueCreate in the same team; prints the new identifier
#   linear.sh status   <TEAM-N> <backlog|todo|in-progress|done>   issueUpdate to the first workflow state of the matching type
#
# shellcheck disable=SC1003,SC2016 # backslash in a case pattern; GraphQL variables ($id) are not shell expansions
# Environment: LINEAR_API_KEY. Requires curl and jq (GraphQL at https://api.linear.app/graphql). The key is
# handed to curl on stdin (curl -K -), so it appears in no argument list, log or error message.
# The run's task ID is the Linear issue identifier.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
pl_name='linear adapter'
# shellcheck source=_lib.sh
. "$here/_lib.sh"

op=${1:-}
case "$op" in import|publish|verify|followup|status) ;; *) pl_usage 'linear.sh <import|publish|verify|followup|status> ...' ;; esac

key_ok() { pl_id "$1"; case "$1" in [A-Za-z]*-[0-9]*) ;; *) pl_die "not a Linear issue identifier (expected TEAM-123): $1" ;; esac; }
lin_ready() {
  [ -n "${LINEAR_API_KEY:-}" ] || pl_die "LINEAR_API_KEY must be set"
  case "$LINEAR_API_KEY" in *'"'*|*'\'*) pl_die "LINEAR_API_KEY contains unsupported characters" ;; esac
  case "${LINEAR_API_URL:-https://api.linear.app/graphql}" in https://*) ;; *) pl_die "LINEAR_API_URL must start with https:// (the API key is sent there)" ;; esac
  command -v curl >/dev/null 2>&1 || pl_die "curl is required"
  command -v jq >/dev/null 2>&1 || pl_die "jq is required"
}
# lin_gql QUERY VARS-JSON -> response JSON on stdout; fails on transport errors and on a GraphQL `errors` member.
lin_gql() {
  lg_f=$(mktemp "${TMPDIR:-/tmp}/linear.XXXXXX")
  jq -n --arg q "$1" --argjson v "$2" '{query:$q,variables:$v}' > "$lg_f"
  if lg_out=$(printf 'header = "Authorization: %s"\n' "$LINEAR_API_KEY" | curl -sS --fail-with-body -K - -X POST -H 'Content-Type: application/json' --data-binary "@$lg_f" "${LINEAR_API_URL:-https://api.linear.app/graphql}") \
     && printf '%s' "$lg_out" | jq -e '.errors == null' >/dev/null; then rm -f "$lg_f"; printf '%s\n' "$lg_out"; else rm -f "$lg_f"; return 1; fi
}
set_state() {   # ID STATE
  case "$2" in backlog) st=backlog ;; todo) st=unstarted ;; in-progress) st=started ;; done) st=completed ;; *) pl_die "unknown status: $2 (backlog|todo|in-progress|done)" ;; esac
  sid=$(lin_gql 'query($id:String!){issue(id:$id){team{states{nodes{id type}}}}}' "$(jq -n --arg id "$1" '{id:$id}')" \
    | jq -r --arg t "$st" '[.data.issue.team.states.nodes[]|select(.type==$t)][0].id // empty') || return 1
  [ -n "$sid" ] || return 1
  lin_gql 'mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}' "$(jq -n --arg id "$1" --arg s "$sid" '{id:$id,s:$s}')" >/dev/null
}

case "$op" in
  import)
    [ $# -eq 3 ] || pl_usage 'linear.sh import <TEAM-N> <out TASK.md>'
    key_ok "$2"; lin_ready
    raw=$(lin_gql 'query($id:String!){issue(id:$id){title description url labels{nodes{name}}}}' "$(jq -n --arg id "$2" '{id:$id}')") || pl_die "cannot read issue $2"
    title=$(printf '%s' "$raw" | jq -r '.data.issue.title // ""')
    work=$(mktemp "${TMPDIR:-/tmp}/linear-import.XXXXXX")
    { printf '%s' "$raw" | jq -r '.data.issue.description // ""'
      printf '\n\n## Labels\n\n'; printf '%s' "$raw" | jq -r '.data.issue.labels.nodes[]?.name | "- " + .'; } > "$work"
    url=$(printf '%s' "$raw" | jq -r '.data.issue.url // ""')
    rc=0; pl_import linear "$work" "$3" "$2" "$title" "linear $url" || rc=$?
    rm -f "$work"; exit "$rc"
    ;;
  publish)
    [ $# -eq 3 ] || pl_usage 'linear.sh publish <TEAM-N> <report-file>'
    key_ok "$2"; [ -f "$3" ] || pl_die "report file missing: $3"; lin_ready
    hash=$(pl_sha < "$3")
    body=$(printf '<!-- proofline:completion-report %s sha256:%s -->\n%s' "$2" "$hash" "$(cat "$3")")
    lin_gql 'mutation($i:String!,$b:String!){commentCreate(input:{issueId:$i,body:$b}){success}}' "$(jq -n --arg i "$2" --arg b "$body" '{i:$i,b:$b}')" >/dev/null \
      || pl_die "could not comment on $2"
    set_state "$2" "done" || printf '%s: report published, but the completed state could not be set on %s\n' "$pl_name" "$2" >&2
    printf '%s#%s\n' "$2" "$hash"
    ;;
  verify)
    [ $# -eq 3 ] || pl_usage 'linear.sh verify <TEAM-N> <receipt>'
    key_ok "$2"; receipt=$3
    if [ -f "$receipt" ]; then receipt="$2#$(pl_sha < "$receipt")"; fi
    want=${receipt#*#}
    [ "${receipt%%#*}" = "$2" ] && [ -n "$want" ] && [ "$want" != "$receipt" ] || pl_die "malformed receipt: $receipt"
    lin_ready
    lin_gql 'query($id:String!){issue(id:$id){comments(first:250){nodes{body}}}}' "$(jq -n --arg id "$2" '{id:$id}')" \
      | jq -r '.data.issue.comments.nodes[].body' | grep -Fq "<!-- proofline:completion-report $2 sha256:$want -->" \
      || pl_die "no completion-report comment with that hash on $2"
    ;;
  followup)
    [ $# -eq 3 ] || pl_usage 'linear.sh followup <TEAM-N> <waiver-file>'
    key_ok "$2"; [ -f "$3" ] || pl_die "waiver file missing: $3"; lin_ready
    title=$(sed -n 's/^# //p' "$3" | head -1); [ -n "$title" ] || title="Follow-up of $2"
    team=$(lin_gql 'query($id:String!){issue(id:$id){team{id}}}' "$(jq -n --arg id "$2" '{id:$id}')" | jq -r '.data.issue.team.id // empty') || pl_die "cannot read issue $2"
    [ -n "$team" ] || pl_die "cannot resolve the team of $2"
    new=$(lin_gql 'mutation($t:String!,$s:String!,$d:String!){issueCreate(input:{teamId:$t,title:$s,description:$d}){issue{identifier}}}' \
      "$(jq -n --arg t "$team" --arg s "$title" --rawfile d "$3" '{t:$t,s:$s,d:$d}')" | jq -r '.data.issueCreate.issue.identifier // empty') || pl_die "could not create the follow-up issue"
    [ -n "$new" ] || pl_die "Linear returned no identifier"
    printf '%s\n' "$new"
    ;;
  status)
    [ $# -eq 3 ] || pl_usage 'linear.sh status <TEAM-N> <backlog|todo|in-progress|done>'
    key_ok "$2"; lin_ready
    set_state "$2" "$3" || pl_die "could not set $3 on $2"
    printf '%s\n' "$3"
    ;;
esac
