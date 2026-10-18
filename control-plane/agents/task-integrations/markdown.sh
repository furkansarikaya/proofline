#!/bin/sh
# Markdown task-integration adapter (default; fully supported and tested). Contract: README.md.
#
#   markdown.sh import   <task-file|TASK-ID> <out TASK.md>   exit 3 + "MISSING <field>" lines when incomplete
#   markdown.sh publish  <TASK-ID> <report-file>             prints receipt <path>#<sha256 of report>
#   markdown.sh verify   <TASK-ID> <receipt>                 exit 0 iff the report block is still there
#   markdown.sh followup <TASK-ID> <waiver-file>             creates tasks/backlog/<ID>-FU<n>.md, prints its path
#   markdown.sh status   <TASK-ID> <backlog|todo|in-progress|done>
#   markdown.sh create   <TASK-ID> <title> <body-file>  prints the new in-progress task path
#
# Task files live in `tasks.dir` (default .agents/tasks), usually in lifecycle folders backlog/ todo/
# in-progress/ done/ with a `**Status:**` line. The completion report is the one block agent.sh's
# task-source contract excludes from the frozen contract hash: the `## Completion Report` heading, a
# blank line, the BEGIN marker, the report, the END marker. Nothing else is written by `publish`.
set -eu
here=$(CDPATH='' cd "$(dirname "$0")" && pwd)
root=$(CDPATH='' cd "$here/../.." && pwd)
pl_name='markdown adapter'
# shellcheck source=_lib.sh
# shellcheck source-path=SCRIPTDIR
. "$here/_lib.sh"

op=${1:-}
tdir=$(pl_cfg tasks dir .agents/tasks)
case "$tdir" in /*|*..*) pl_die "tasks.dir must be a relative path inside the project: $tdir" ;; esac

run_task_path() {
  awk '/^task_source:$/ { inside=1; next } inside && /^[^[:space:]]/ { exit } inside && /^[[:space:]]*path:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/"/, ""); print; exit }' "$root/.agents/runs/$1/RUN.yaml" 2>/dev/null || :
}
find_task() {   # ID -> relative path of the task file (first match across lifecycle folders)
  for ft in "$tdir"/*/"$1".md "$tdir"/*/"$1"-*.md "$tdir/$1.md" "$tdir/$1"-*.md; do
    [ -f "$root/$ft" ] || continue
    case "$(basename "$ft")" in "$1"-FU[0-9]*) [ "$(basename "$ft")" = "$1.md" ] || continue ;; esac   # T-1 never resolves to its follow-up T-1-FU1
    printf '%s\n' "$ft"; return 0
  done
  return 1
}

strip_plan() {   # task file -> stdout without the planning block (and Status lines)
    awk '!f && /^[[:space:]]*$/ { next } !f { f=1; if ($0=="---") { st=1; next } } st==1 { if ($0=="---") st=0; next }
      !d && /^# / { d=1; st=2; next } st==2 && /^[[:space:]]*$/ { next } st==2 && /^\*\*Status:\*\*/ { next } st==2 && $0=="---" { st=3; next }
      st==3 { if ($0=="---") st=0; next } { if (st==2) st=0 } /^\*\*Status:\*\*/ { next } { print }' "$1"
}
get_plan() {   # task file -> stdout: the planning block incl. both --- lines, or nothing
  awk '!f && /^[[:space:]]*$/ { next } !f { f=1; if ($0=="---") { st=1; print; next } } st==1 { print; if ($0=="---") exit; next }
      !d && /^# / { d=1; st=2; next } st==2 && /^[[:space:]]*$/ { next } st==2 && /^\*\*Status:\*\*/ { next } st==2 && $0=="---" { st=3; print; next }
      st==3 { print; if ($0=="---") exit; next } { exit }' "$1"
}

case "$op" in
  create)
    [ $# -eq 4 ] || pl_usage 'markdown.sh create <TASK-ID> <title> <body-file>'
    id=$2 title=$3 body=$4; pl_id "$id"
    [ -f "$body" ] || pl_die "task body missing: $body"
    [ -n "$title" ] || pl_die 'task title is required'
    slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-48 | sed 's/-$//')
    [ -n "$slug" ] || pl_die 'task title needs a usable slug'
    if find_task "$id" >/dev/null 2>&1; then pl_die "task file already exists for $id"; fi
    rel=$tdir/in-progress/$id-$slug.md
    [ ! -e "$root/$rel" ] || pl_die "task file already exists: $rel"
    tmp=$(mktemp "${TMPDIR:-/tmp}/md-create.XXXXXX")
    work=$(mktemp "${TMPDIR:-/tmp}/md-create.XXXXXX"); strip_plan "$body" > "$work"
    rc=0; pl_import markdown "$work" "$tmp" "$id" "$title" "markdown $rel" || rc=$?
    rm -f "$work"
    if [ "$rc" -ne 0 ]; then rm -f "$tmp"; exit "$rc"; fi
    mkdir -p "$root/$tdir/in-progress"
    # the planning block stays right after the H1, behind the Status line (import reads both)
    fm=$(get_plan "$body"); [ "$(printf '%s\n' "$fm" | tail -1)" = "---" ] || fm=''
    { sed -n '1p' "$tmp"; printf '\n**Status:** in-progress\n'; [ -z "$fm" ] || printf '\n%s\n' "$fm"; sed '1d' "$tmp"; } > "$root/$rel"
    rm -f "$tmp"
    printf '%s\n' "$rel"
    ;;
  import)
    [ $# -eq 3 ] || pl_usage 'markdown.sh import <task-file|TASK-ID> <out TASK.md>'
    ref=$2 out=$3
    if [ -f "$ref" ]; then src=$ref
    elif [ -f "$root/$ref" ]; then src=$root/$ref
    else pl_id "$ref"; rel=$(find_task "$ref") || pl_die "no task file for $ref in $tdir"; src=$root/$rel; fi
    h1=$(sed -n 's/^# //p' "$src" | head -1); h1=${h1#Task: }
    id='' title=$h1
    case "$h1" in *' — '*) id=${h1%% — *}; title=${h1#* — } ;; esac
    case "$id" in ''|*[!A-Za-z0-9._-]*) b=$(basename "$src" .md); id=$(printf '%s' "$b" | sed -n 's/^\([A-Za-z][A-Za-z0-9]*-[0-9][0-9]*\).*/\1/p'); [ -n "$id" ] || id=$b ;; esac
    pl_id "$id"
    work=$(mktemp "${TMPDIR:-/tmp}/md-import.XXXXXX")
    # planning block (`---` ... `---`) directly after the H1, or leading in a hand-written file: not copied into the body
    strip_plan "$src" > "$work"
    rc=0; pl_import markdown "$work" "$out" "$id" "$title" "markdown $src" || rc=$?
    rm -f "$work"
    # keep the optional planning front matter (size, sprint, assignee, depends_on) parseable at the top of the run's TASK.md
    fm=$(get_plan "$src")
    if [ "$rc" -eq 0 ] && [ -f "$out" ] && [ -n "$fm" ] && [ "$(printf '%s\n' "$fm" | tail -1)" = "---" ]; then
      fmt=$(mktemp "${TMPDIR:-/tmp}/md-fm.XXXXXX")
      { sed -n '1p' "$out"; printf '\n%s\n' "$fm"; sed '1d' "$out"; } > "$fmt" && cat "$fmt" > "$out"; rm -f "$fmt"
    fi
    exit "$rc"
    ;;
  publish)
    [ $# -eq 3 ] || pl_usage 'markdown.sh publish <TASK-ID> <report-file>'
    id=$2 report=$3; pl_id "$id"
    path=$(run_task_path "$id"); [ -n "$path" ] || pl_die "no task_source.path for $id"
    target="$root/$path"
    [ -f "$target" ] || pl_die "task source file missing: $path"
    [ -f "$report" ] || pl_die "report file missing: $report"
    begin="<!-- COMPLETION-REPORT:BEGIN:$id -->"
    end="<!-- COMPLETION-REPORT:END:$id -->"
    tmp=$(mktemp "${TMPDIR:-/tmp}/markdown-adapter.XXXXXX")
    if grep -Fxq "$begin" "$target" && ! grep -Fxq "$end" "$target"; then rm -f "$tmp"; pl_die "$path has $begin but no $end; refusing to publish (it would truncate the file); restore the end marker"; fi
    if grep -Fxq "$begin" "$target"; then
      awk -v b="$begin" -v e="$end" -v rf="$report" '
        $0 == b { print; while ((getline line < rf) > 0) print line; skip=1; next }
        $0 == e { print; skip=0; next }
        skip { next }
        { print }
      ' "$target" > "$tmp"
    else
      cp "$target" "$tmp"
      { printf '\n## Completion Report\n\n%s\n' "$begin"; cat "$report"; printf '%s\n' "$end"; } >> "$tmp"
    fi
    cat "$tmp" > "$target"; rm -f "$tmp"
    printf '%s#%s\n' "$path" "$(pl_sha < "$report")"
    ;;
  verify)
    [ $# -eq 3 ] || pl_usage 'markdown.sh verify <TASK-ID> <receipt>'
    id=$2 receipt=$3; pl_id "$id"
    if [ -f "$receipt" ]; then receipt="$(run_task_path "$id")#$(pl_sha < "$receipt")"; fi   # a report file instead of a receipt
    path=${receipt%%#*} want=${receipt#*#}
    [ -n "$path" ] && [ -n "$want" ] && [ "$path" != "$receipt" ] || pl_die "malformed receipt: $receipt"
    target="$root/$path"
    [ -f "$target" ] || pl_die "task source file missing: $path"
    begin="<!-- COMPLETION-REPORT:BEGIN:$id -->"
    end="<!-- COMPLETION-REPORT:END:$id -->"
    if ! grep -Fxq "$begin" "$target" || ! grep -Fxq "$end" "$target"; then pl_die "no completion-report block found for $id in $path"; fi
    got=$(awk -v b="$begin" -v e="$end" '$0 == b { inside=1; next } $0 == e { inside=0; next } inside { print }' "$target" | pl_sha)
    [ "$got" = "$want" ] || pl_die "completion-report content in $path no longer matches the published receipt"
    ;;
  followup)
    [ $# -eq 3 ] || pl_usage 'markdown.sh followup <TASK-ID> <waiver-file>'
    id=$2 wf=$3; pl_id "$id"
    [ -f "$wf" ] || pl_die "waiver file missing: $wf"
    n=1
    while find_task "$id-FU$n" >/dev/null 2>&1; do n=$((n + 1)); done
    nid=$id-FU$n
    title=$(sed -n 's/^# //p' "$wf" | head -1); [ -n "$title" ] || title="Follow-up of $id"
    rel=$tdir/backlog/$nid.md
    mkdir -p "$root/$tdir/backlog"
    {
      printf '# Task: %s — %s\n\n**Status:** backlog\n\n' "$nid" "$title"
      awk '!d && /^# / { d=1; next } { print }' "$wf"
      for h in 'Acceptance criteria' 'Out of scope' 'Constraints' 'Risks' 'Suggested class' 'Verification commands'; do
        grep -Fxq "## $h" "$wf" || printf '\n## %s\n\nTBD (task-author completes this follow-up)\n' "$h"
      done
    } > "$root/$rel"
    printf '%s\n' "$rel"
    ;;
  status)
    { [ $# -eq 3 ] || [ $# -eq 4 ]; } || pl_usage 'markdown.sh status <TASK-ID> <backlog|todo|in-progress|done> [task-path]'
    id=$2 state=$3; pl_id "$id"
    case "$state" in backlog|todo|in-progress|done) ;; *) pl_die "unknown status: $state (backlog|todo|in-progress|done)" ;; esac
    if [ $# -eq 4 ]; then
      rel=${4#./}
      case "$rel" in "$tdir"/*) ;; *) pl_die "task path must be under $tdir: $rel" ;; esac
      case "$rel" in *..*) pl_die "invalid task path: $rel" ;; esac
      [ -f "$root/$rel" ] || pl_die "task file missing: $rel"
      case "$(basename "$rel")" in "$id".md|"$id"-*.md) ;; *) pl_die "task path does not match $id: $rel" ;; esac
    else rel=$(find_task "$id") || pl_die "no task file for $id in $tdir"; fi
    [ "$(run_task_path "$id")" != "$rel" ] || pl_die "$id has an active run bound to $rel; move the file, then use 'agent.sh task-source-relocate' and 'agent.sh task-source-status'"
    mkdir -p "$root/$tdir/$state"
    dest=$tdir/$state/$(basename "$rel")
    tmp=$(mktemp "${TMPDIR:-/tmp}/markdown-adapter.XXXXXX")
    if grep -q '^\*\*Status:\*\*' "$root/$rel"; then
      awk -v s="$state" '/^\*\*Status:\*\*/ { print "**Status:** " s; next } { print }' "$root/$rel" > "$tmp"
    else
      awk -v s="$state" 'NR == 1 { print; print ""; print "**Status:** " s; next } { print }' "$root/$rel" > "$tmp"
    fi
    cat "$tmp" > "$root/$rel"; rm -f "$tmp"
    [ "$rel" = "$dest" ] || mv "$root/$rel" "$root/$dest"
    printf '%s\n' "$dest"
    ;;
  *) pl_usage 'markdown.sh <import|publish|verify|followup|status> ...' ;;
esac
