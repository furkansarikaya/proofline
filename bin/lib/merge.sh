# shellcheck shell=sh
# proofline merge <PR> (A136): the only allowed way to merge a pull request. The runtime hook denies every
# other merge path (gh pr merge, gh api .../merge, git merge into / git push to the protected branch).
# Fail closed: whatever cannot be seen or parsed is a refusal that says what was seen.
#
#   proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]
#
# A fresh `gh pr view` must show the PR open, not a draft, with a non-empty check rollup where every check run
# is COMPLETED/SUCCESS and every status context SUCCESS. A SKIPPED check run passes only when `gh pr checks
# --required` does not list it as required; every required check must be a pass AND present in the rollup (a
# late-registering one refuses). gh and jq are resolved here and refused when shadowed. Anything else (pending,
# failed, cancelled, neutral, stale, no checks at all) refuses. The head commit is read twice (rollup read and
# right before the merge) and must be equal; the merge itself passes --match-head-commit, so GitHub refuses it
# if the head moved after the check. --admin and --auto are refused: --admin overrides the checks, --auto
# merges later without a fresh check.

mg_refuse() { printf 'proofline merge: REFUSED: %s\n' "$*" >&2; exit 1; }

cmd_merge() {
  mg_pr='' mg_method=--merge mg_del='' mg_repo=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --merge|--squash|--rebase) mg_method=$1 ;;
      --delete-branch|-d) mg_del=--delete-branch ;;
      -R|--repo) [ $# -ge 2 ] || die "usage: proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]"; mg_repo=$2; shift ;;
      --admin|--auto|--disable-auto) mg_refuse "$1 is never allowed: --admin overrides the checks and --auto merges later without a fresh check" ;;
      -*) die "unknown option for merge: $1" ;;
      *) [ -z "$mg_pr" ] || die "merge takes one pull request number"; mg_pr=$1 ;;
    esac
    shift
  done
  case "$mg_pr" in ''|*[!0-9]*) die "usage: proofline merge <PR-NUMBER> ... (a plain number: a URL or branch name cannot be verified)" ;; esac
  case "$mg_repo" in *[!A-Za-z0-9_./-]*) die "invalid repository: $mg_repo" ;; esac
  # PATH shadowing: an empty or relative PATH entry, or a gh / jq found in the project, a temp dir or the working
  # directory, is refused (PROOFLINE_SELFTEST=1 lifts the directory rule for the tests; the hook denies naming it).
  mg_ifs=$IFS; IFS=:; set -f
  for mg_d in $PATH; do case "$mg_d" in /*) ;; ''|.|..) IFS=$mg_ifs; set +f; mg_refuse "PATH holds an empty or relative entry ('$mg_d'); a gh found there could be a fake" ;; *) [ -d "$mg_d" ] || continue; IFS=$mg_ifs; set +f; mg_refuse "PATH holds an empty or relative entry ('$mg_d'); a gh found there could be a fake" ;; esac; done
  IFS=$mg_ifs; set +f
  mg_top=$(git rev-parse --show-toplevel 2>/dev/null) || mg_top=$PWD
  mg_find() { # NAME -> absolute path of the first match on PATH, safe location only
    mg_p=$(command -v "$1" 2>/dev/null) || return 1
    case "$mg_p" in /*) ;; *) return 1 ;; esac
    if [ "${PROOFLINE_SELFTEST:-}" != 1 ]; then
      case "$mg_p" in "$PWD"/*|"$mg_top"/*|/tmp/*|/private/tmp/*|/var/folders/*|/dev/shm/*|"${TMPDIR:-/nonexistent}"/*) printf 'proofline merge: REFUSED: %s resolves to %s, a project, working or temp directory; refusing a possibly shadowed %s\n' "$1" "$mg_p" "$1" >&2; return 2 ;; esac
    fi
    printf '%s\n' "$mg_p"
  }
  mg_ghp=$(mg_find gh) || { [ $? -ne 2 ] || exit 1; mg_refuse "gh is not installed or not on PATH; cannot check the pull request"; }
  mg_jqp=$(mg_find jq) || { [ $? -ne 2 ] || exit 1; mg_refuse "jq is not installed; cannot read the check results"; }
  say "proofline merge: using gh at $mg_ghp, jq at $mg_jqp"
  mg_gh() { "$mg_ghp" "$@" ${mg_repo:+-R "$mg_repo"}; }

  mg_json=$(mg_gh pr view "$mg_pr" --json number,state,isDraft,headRefOid,statusCheckRollup 2>&1) \
    || mg_refuse "gh pr view $mg_pr failed (offline, not logged in or no such pull request): $mg_json"
  mg_rows=$(printf '%s' "$mg_json" | "$mg_jqp" -r '([.number, .state, .isDraft, .headRefOid] | map(tostring) | join(" ")),
      (.statusCheckRollup // [] | .[] | [(.__typename // "?"), (.name // .context // "?"), (.status // "-"), (.conclusion // "-"), (.state // "-")] | join("\t"))' 2>&1) \
    || mg_refuse "gh pr view output is not parseable JSON of the expected shape: $(printf '%s' "$mg_json" | head -c 200)"
  mg_head=$(printf '%s\n' "$mg_rows" | sed -n 1p)
  read -r mg_num mg_state0 mg_draft mg_sha mg_extra <<EOF
$mg_head
EOF
  [ -z "$mg_extra" ] || mg_refuse "gh pr view did not return pull request $mg_pr (saw: $mg_head)"
  [ "$mg_num" = "$mg_pr" ] || mg_refuse "gh pr view did not return pull request $mg_pr (saw: $mg_head)"
  [ "$mg_state0" = OPEN ] || mg_refuse "pull request $mg_pr is $mg_state0, not OPEN"
  [ "$mg_draft" = false ] || mg_refuse "pull request $mg_pr is a draft"
  case "$mg_sha" in *[!0-9a-f]*|'') mg_refuse "head commit of pull request $mg_pr is not a SHA (saw: $mg_sha)" ;; esac
  [ "${#mg_sha}" -eq 40 ] || mg_refuse "head commit of pull request $mg_pr is not a 40-digit SHA (saw: $mg_sha)"

  mg_n=0 mg_bad='' mg_skip='' mg_seen='
'
  mg_tab=$(printf '\t')
  while IFS="$mg_tab" read -r mg_type mg_name mg_st mg_con mg_state; do
    [ -n "$mg_type" ] || continue
    mg_n=$((mg_n + 1)); mg_seen="$mg_seen$mg_name
"
    case "$mg_type:$mg_st:$mg_con:$mg_state" in
      CheckRun:COMPLETED:SUCCESS:*|StatusContext:*:*:SUCCESS) ;;
      CheckRun:COMPLETED:SKIPPED:*) mg_skip="$mg_skip $mg_name" ;;
      CheckRun:*) mg_bad="$mg_bad
  $mg_name: status $mg_st, conclusion $mg_con" ;;
      StatusContext:*) mg_bad="$mg_bad
  $mg_name: state $mg_state" ;;
      *) mg_bad="$mg_bad
  $mg_name: unknown check type $mg_type" ;;
    esac
  done <<EOF
$(printf '%s\n' "$mg_rows" | sed 1d)
EOF
  [ "$mg_n" -gt 0 ] || mg_refuse "pull request $mg_pr shows no checks at all; green cannot be proven"
  [ -z "$mg_bad" ] || mg_refuse "pull request $mg_pr is not green ($mg_n checks seen); not SUCCESS:$mg_bad"
  # Required checks (branch protection): each must be in the rollup AND a pass. A required check missing from the
  # rollup is one that has not registered yet (a workflow_run right after a push); skipped checks are judged here too.
  mg_req=$(mg_gh pr checks "$mg_pr" --required --json name,bucket 2>&1) || case "$mg_req" in
    *'no required checks'*) mg_req='[]' ;;
    *) mg_refuse "gh pr checks --required failed, so the required checks cannot be judged: $mg_req" ;;
  esac
  mg_reqbad=$(printf '%s' "$mg_req" | "$mg_jqp" -r '.[] | select(.bucket != "pass") | .name + " (" + .bucket + ")"' 2>&1) \
    || mg_refuse "gh pr checks --required output is not parseable: $(printf '%s' "$mg_req" | head -c 200)"
  [ -z "$mg_reqbad" ] || mg_refuse "pull request $mg_pr has required checks that did not pass: $(printf '%s' "$mg_reqbad" | tr '\n' ' ')"
  mg_reqnames=$(printf '%s' "$mg_req" | "$mg_jqp" -r '.[].name' 2>&1) || mg_refuse "gh pr checks --required names are not parseable"
  mg_miss=''
  while IFS= read -r mg_rn; do
    [ -n "$mg_rn" ] || continue
    case "$mg_seen" in *"
$mg_rn
"*) ;; *) mg_miss="$mg_miss $mg_rn" ;; esac
  done <<EOF
$mg_reqnames
EOF
  [ -z "$mg_miss" ] || mg_refuse "required checks missing from the rollup (not registered yet?):$mg_miss"

  mg_now=$(mg_gh pr view "$mg_pr" --json headRefOid 2>&1 | "$mg_jqp" -r '.headRefOid // empty' 2>/dev/null) || mg_now=''
  [ "$mg_now" = "$mg_sha" ] || mg_refuse "the head of pull request $mg_pr moved after the check (checked $mg_sha, now ${mg_now:-unreadable}); run the merge again"

  say "proofline merge: pull request $mg_pr is green at $mg_sha ($mg_n checks); merging ($mg_method)"
  mg_gh pr merge "$mg_pr" "$mg_method" --match-head-commit "$mg_sha" ${mg_del:+--delete-branch}
}
