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
#
# Platforms (A180): the remote of origin decides. GitHub uses gh (above). GitLab uses glab (merge request, head pipeline) and
# Azure DevOps uses az repos (pull request, build/status policies), each only when the tool is installed, with the same
# strictness: open, not a draft, every check passed on the head that is merged. Bitbucket, an unrecognized host and a missing
# tool are not merged by proofline: the branch is pushed, the link is printed, and the USER merges (exit 1, said explicitly).
# A pull request with NO checks (or no pipeline / no build policy) is merged only after the verification commands of the
# project (commands.build and commands.test, the build-record mechanism) pass in a CLEAN export of the commit to be merged;
# the pull request then gets a comment "verified locally, no CI". Checks that exist but are not green still refuse.

mg_refuse() { printf 'proofline merge: REFUSED: %s\n' "$*" >&2; exit 1; }

# mg_manual PLATFORM WHY DETECT-OUTPUT: the user merges; nothing is merged here.
mg_manual() {
  mm_br=$(git branch --show-current 2>/dev/null || true); mm_base=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^[^/]*/||'); [ -n "$mm_base" ] || mm_base=main
  printf 'proofline merge: NOT MERGED: platform %s: %s. proofline does not merge a pull request here; YOU merge it.\n' "$1" "$2" >&2
  printf 'manual steps: 1. push the branch (git push -u origin %s)  2. open the pull request / merge request: %s  3. wait for its checks, or run the project'"'"'s build and test yourself when there are none  4. merge it in the web page of your hosting service.\n' \
    "${mm_br:-<branch>}" "$(sh "$PL_HOME/control-plane/agents/scripts/platform.sh" link "${mm_br:-BRANCH}" "$mm_base" 2>/dev/null || echo '(open it in your hosting service)')" >&2
  exit 1
}
# mg_local_verify SHA PR: no checks exist for this pull request. The verification commands of the project (build record: commands.build
# and commands.test) must pass in a CLEAN export of exactly the commit to be merged. Fail closed: not installed, not configured,
# not fetched or failing is a refusal. Prints the record key.
mg_local_verify() {
  git cat-file -e "$1^{commit}" 2>/dev/null || mg_refuse "pull request $2 has no checks and its head commit $1 is not in this clone, so it cannot be verified locally (git fetch it first)"
  mv_br=$mg_top/.agents/scripts/build-record.sh
  [ -f "$mv_br" ] || mg_refuse "pull request $2 has no checks and proofline is not installed here (no .agents/scripts/build-record.sh), so there is nothing to verify the commit with locally"
  mv_out=$(cd "$mg_top" && sh "$mv_br" run "$1" 2>&1); mv_rc=$?
  case "$mv_rc" in
    0) ;;
    2) mg_refuse "pull request $2 has no checks and the verification commands are not configured (commands.build / commands.test in .agents/config.yaml): $(printf '%s' "$mv_out" | head -c 200)" ;;
    *) mg_refuse "pull request $2 has no checks and the verification commands FAILED in a clean copy of $1: $(printf '%s\n' "$mv_out" | grep -E '^(build|test|install)|^failed:' | head -n 4 | tr '\n' ' ')(see the record: sh .agents/scripts/agent.sh build-record <ID> show)" ;;
  esac
  mg_key=$(printf '%s\n' "$mv_out" | sed -n 's/^key: //p' | head -n 1)
  say "proofline merge: no CI for pull request $2: verified locally at $1 (build record $mg_key)"
}

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
  mg_pf="$PL_HOME/control-plane/agents/scripts/platform.sh"
  mg_plat=github mg_cli=gh
  if [ -f "$mg_pf" ]; then
    mg_pd=$(sh "$mg_pf" detect 2>/dev/null) || mg_pd=''
    mg_url=$(git remote get-url origin 2>/dev/null || true)
    if [ -n "$mg_url" ] || [ -n "${PROOFLINE_PLATFORM:-}" ]; then   # no origin at all keeps the old gh behaviour (gh resolves the repository, or -R names it)
      mg_plat=$(printf '%s\n' "$mg_pd" | sed -n 's/^platform: //p'); mg_cli=$(printf '%s\n' "$mg_pd" | sed -n 's/^cli: //p')
    fi
  fi
  case "$mg_plat:$mg_cli" in
    github:gh|gitlab:glab|azure:az) ;;
    github:*|gitlab:*|azure:*) mg_manual "$mg_plat" "the command line tool for it ($(case $mg_plat in gitlab) echo glab ;; azure) echo az ;; *) echo gh ;; esac) is not installed or not on PATH" ;;
    *) mg_manual "$mg_plat" "proofline has no merge adapter for this host" ;;
  esac
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
  mg_ghp=$(mg_find "$mg_cli") || { [ $? -ne 2 ] || exit 1; mg_refuse "$mg_cli is not installed or not on PATH; cannot check the pull request"; }
  mg_jqp=$(mg_find jq) || { [ $? -ne 2 ] || exit 1; mg_refuse "jq is not installed; cannot read the check results"; }
  say "proofline merge: using $mg_cli at $mg_ghp, jq at $mg_jqp"
  mg_gh() { "$mg_ghp" "$@" ${mg_repo:+-R "$mg_repo"}; }
  case "$mg_cli" in glab) mg_merge_glab; return ;; az) [ -z "$mg_repo" ] || mg_refuse "-R is not supported with az; run proofline merge inside the clone"; mg_merge_az; return ;; esac

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
  mg_nochk=no; [ "$mg_n" -gt 0 ] || mg_nochk=yes   # no checks at all: the local verification below decides (A180)
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
  mg_vnote=''
  if [ "$mg_nochk" = yes ]; then
    [ -z "$mg_reqnames" ] || mg_refuse "pull request $mg_pr shows no checks although checks are required; green cannot be proven"
    mg_local_verify "$mg_sha" "$mg_pr"; mg_vnote="verified locally, no CI (proofline merge: commands.build and commands.test passed in a clean copy of $mg_sha, build record $mg_key)"
  fi

  mg_now=$(mg_gh pr view "$mg_pr" --json headRefOid 2>&1 | "$mg_jqp" -r '.headRefOid // empty' 2>/dev/null) || mg_now=''
  [ "$mg_now" = "$mg_sha" ] || mg_refuse "the head of pull request $mg_pr moved after the check (checked $mg_sha, now ${mg_now:-unreadable}); run the merge again"

  if [ -n "$mg_vnote" ]; then
    mg_gh pr comment "$mg_pr" --body "$mg_vnote" >/dev/null 2>&1 || mg_refuse "could not record \"verified locally, no CI\" on pull request $mg_pr (gh pr comment failed); nothing was merged"
    say "proofline merge: pull request $mg_pr has no checks; $mg_vnote; merging ($mg_method)"
  else say "proofline merge: pull request $mg_pr is green at $mg_sha ($mg_n checks); merging ($mg_method)"; fi
  mg_gh pr merge "$mg_pr" "$mg_method" --match-head-commit "$mg_sha" ${mg_del:+--delete-branch}
}

# --- GitLab (glab) and Azure DevOps (az repos) adapters (A180): the same checks as the gh path, on their own fields ----------
# mg_tail_pre PR SHA NOCHECKS(yes|no): no checks -> the local verification; sets mg_vnote for the record on the pull request.
mg_tail_pre() {
  mg_vnote=''
  if [ "$3" = yes ]; then
    mg_local_verify "$2" "$1"; mg_vnote="verified locally, no CI (proofline merge: commands.build and commands.test passed in a clean copy of $2, build record $mg_key)"
  fi
}
mg_merge_glab() {
  mg_json=$(mg_gh mr view "$mg_pr" -F json 2>&1) || mg_refuse "glab mr view $mg_pr failed (offline, not logged in or no such merge request): $mg_json"
  mg_rows=$(printf '%s' "$mg_json" | "$mg_jqp" -r '[(.iid // "?"), (.state // "?"), ((.draft // .work_in_progress // false) | tostring), (.sha // "?"), ((.head_pipeline // .pipeline // null) | if . == null then "none" else (.status // "?") end), ((.head_pipeline // .pipeline // null) | if . == null then "-" else (.sha // "-") end)] | join(" ")' 2>&1) \
    || mg_refuse "glab mr view output is not parseable JSON of the expected shape: $(printf '%s' "$mg_json" | head -c 200)"
  read -r mg_num mg_state0 mg_draft mg_sha mg_pst mg_psha mg_extra <<EOF
$mg_rows
EOF
  { [ -z "$mg_extra" ] && [ "$mg_num" = "$mg_pr" ]; } || mg_refuse "glab mr view did not return merge request $mg_pr (saw: $mg_rows)"
  [ "$mg_state0" = opened ] || mg_refuse "merge request $mg_pr is $mg_state0, not opened"
  [ "$mg_draft" = false ] || mg_refuse "merge request $mg_pr is a draft"
  case "$mg_sha" in *[!0-9a-f]*|'') mg_refuse "head commit of merge request $mg_pr is not a SHA (saw: $mg_sha)" ;; esac
  [ "${#mg_sha}" -eq 40 ] || mg_refuse "head commit of merge request $mg_pr is not a 40-digit SHA (saw: $mg_sha)"
  mg_nochk=no
  case "$mg_pst" in
    none) mg_nochk=yes ;;
    success) [ "$mg_psha" = "$mg_sha" ] || mg_refuse "the pipeline of merge request $mg_pr ran on $mg_psha, not on the head $mg_sha; wait for the pipeline of the current head" ;;
    *) mg_refuse "merge request $mg_pr is not green: the pipeline of its head is $mg_pst" ;;
  esac
  mg_tail_pre "$mg_pr" "$mg_sha" "$mg_nochk"
  mg_now=$(mg_gh mr view "$mg_pr" -F json 2>&1 | "$mg_jqp" -r '.sha // empty' 2>/dev/null) || mg_now=''
  [ "$mg_now" = "$mg_sha" ] || mg_refuse "the head of merge request $mg_pr moved after the check (checked $mg_sha, now ${mg_now:-unreadable}); run the merge again"
  if [ -n "$mg_vnote" ]; then mg_gh mr note "$mg_pr" -m "$mg_vnote" >/dev/null 2>&1 || mg_refuse "could not record \"verified locally, no CI\" on merge request $mg_pr (glab mr note failed); nothing was merged"; fi
  say "proofline merge: merge request $mg_pr at $mg_sha: ${mg_vnote:-green pipeline}; merging ($mg_method)"
  mg_gm=''; case "$mg_method" in --squash) mg_gm=--squash ;; --rebase) mg_gm=--rebase ;; esac
  mg_gh mr merge "$mg_pr" --sha "$mg_sha" --yes ${mg_gm:+"$mg_gm"} ${mg_del:+--remove-source-branch}
}
mg_merge_az() {
  mg_json=$("$mg_ghp" repos pr show --id "$mg_pr" -o json 2>&1) || mg_refuse "az repos pr show $mg_pr failed (offline, not logged in or no such pull request): $mg_json"
  mg_rows=$(printf '%s' "$mg_json" | "$mg_jqp" -r '[(.pullRequestId // "?"), (.status // "?"), ((.isDraft // false) | tostring), (.lastMergeSourceCommit.commitId // "?")] | join(" ")' 2>&1) \
    || mg_refuse "az repos pr show output is not parseable JSON of the expected shape: $(printf '%s' "$mg_json" | head -c 200)"
  read -r mg_num mg_state0 mg_draft mg_sha mg_extra <<EOF
$mg_rows
EOF
  { [ -z "$mg_extra" ] && [ "$mg_num" = "$mg_pr" ]; } || mg_refuse "az repos pr show did not return pull request $mg_pr (saw: $mg_rows)"
  [ "$mg_state0" = active ] || mg_refuse "pull request $mg_pr is $mg_state0, not active"
  [ "$mg_draft" = false ] || mg_refuse "pull request $mg_pr is a draft"
  case "$mg_sha" in *[!0-9a-f]*|'') mg_refuse "head commit of pull request $mg_pr is not a SHA (saw: $mg_sha)" ;; esac
  [ "${#mg_sha}" -eq 40 ] || mg_refuse "head commit of pull request $mg_pr is not a 40-digit SHA (saw: $mg_sha)"
  mg_pol=$("$mg_ghp" repos pr policy list --id "$mg_pr" -o json 2>&1) || mg_refuse "az repos pr policy list $mg_pr failed, so the checks cannot be judged: $mg_pol"
  # build and status policies are the checks; every one must be approved (a queued, running, rejected or broken one refuses)
  mg_prow=$(printf '%s' "$mg_pol" | "$mg_jqp" -r '.[] | select((.configuration.type.displayName // "") | test("build|status"; "i")) | [(.status // "?"), ((.configuration.type.displayName // "?") | gsub(" "; "_"))] | join(" ")' 2>&1) \
    || mg_refuse "az repos pr policy list output is not parseable: $(printf '%s' "$mg_pol" | head -c 200)"
  mg_n=0 mg_bad=''
  while read -r mg_st mg_nm; do
    [ -n "$mg_st" ] || continue
    mg_n=$((mg_n + 1)); [ "$mg_st" = approved ] || mg_bad="$mg_bad $mg_nm=$mg_st"
  done <<EOF
$mg_prow
EOF
  [ -z "$mg_bad" ] || mg_refuse "pull request $mg_pr is not green ($mg_n checks seen); not approved:$mg_bad"
  mg_nochk=no; [ "$mg_n" -gt 0 ] || mg_nochk=yes
  mg_tail_pre "$mg_pr" "$mg_sha" "$mg_nochk"
  mg_now=$("$mg_ghp" repos pr show --id "$mg_pr" -o json 2>&1 | "$mg_jqp" -r '.lastMergeSourceCommit.commitId // empty' 2>/dev/null) || mg_now=''
  [ "$mg_now" = "$mg_sha" ] || mg_refuse "the head of pull request $mg_pr moved after the check (checked $mg_sha, now ${mg_now:-unreadable}); run the merge again"
  if [ -n "$mg_vnote" ]; then   # the note is appended to the description (update replaces it, so the old text is read first)
    mg_desc=$(printf '%s' "$mg_json" | "$mg_jqp" -r '.description // ""' 2>/dev/null) || mg_desc=''
    "$mg_ghp" repos pr update --id "$mg_pr" --description "${mg_desc:+$mg_desc

}$mg_vnote" >/dev/null 2>&1 || mg_refuse "could not record \"verified locally, no CI\" on pull request $mg_pr (az repos pr update failed); nothing was merged"
  fi
  say "proofline merge: pull request $mg_pr at $mg_sha: ${mg_vnote:-all build and status policies approved}; merging ($mg_method)"
  # shortcut: az has no match-head option; the head is read twice (above) and Azure completes against the head it holds at that moment
  set -- --id "$mg_pr" --status completed
  case "$mg_method" in --squash) set -- "$@" --squash true ;; --rebase) set -- "$@" --merge-strategy rebase ;; esac
  [ -z "$mg_del" ] || set -- "$@" --delete-source-branch true
  "$mg_ghp" repos pr update "$@"
}
