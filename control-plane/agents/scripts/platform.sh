#!/bin/sh
# Hosting platform of the project's remote (A180, A186): which pull request system a delivery talks to, which command line
# tool is installed for it, and so who merges. Nothing here opens, merges or changes a pull request; `ci-failed` only reads.
#   platform.sh detect [-C DIR] [--url URL]   key: value lines: platform, source, host, cli, merge, owner, repo_path, web
#   platform.sh field KEY [-C DIR] [--url URL] one value (the keys of detect, and org_url, project)
#   platform.sh link BRANCH BASE [-C DIR] [--url URL]   the address that opens a pull request for BRANCH into BASE
#   platform.sh env [-C DIR] [--url URL]      NAME=value lines the platform tool needs for a private host (GH_HOST, GITLAB_HOST)
#   platform.sh warn [-C DIR] [--url URL]     one warning line when git.platform is set without git.platform_host for an origin that is not a known host of it
#   platform.sh ci-failed PR SHA --cli PATH [--jq PATH] [-C DIR] [--url URL]   the failed check of a pull request's head (A186)
# platform: github | gitlab | azure | bitbucket | other
# source:   config | env | auto   where the platform came from: git.platform (with git.platform_host, when set) of
#           .agents/config.yaml, else PROOFLINE_PLATFORM, else the origin URL (exact hosts only; a host is judged by its name)
# cli:      gh | glab | az | none                              (the tool of that platform, only when it is on PATH)
# merge:    cli    proofline opens the pull request / merge request, reads the checks and merges through the tool
#           manual proofline pushes the branch and prints the link or the manual steps; the USER merges
#                  (Bitbucket, any unrecognized host, and a recognized platform whose tool is not installed)
# git.platform_host applies git.platform only when it EQUALS the host of the origin URL (case-insensitive, whole host: never a
# prefix, suffix or substring), so a look-alike host (github.com.evil.example) never takes a configured platform.
# ci-failed prints nothing when no failed check is readable, else
#   RED<TAB>run or job id, or -<TAB>check name<TAB>status<TAB>log (read|none)   then a LOG line, then the log text
# `log none` means the platform tool could not give the log (Bitbucket, other, an error): the text then says so and the
# round starts from the check's name and status only.
# The remote is `origin` of the repository in DIR (default: the current directory) unless --url names it.
set -u
op=${1:-}; [ $# -eq 0 ] || shift
dir=. url='' pf_cli='' pf_jq=''
key=''
case "$op" in field) key=${1:-}; [ $# -eq 0 ] || shift ;; esac
case "$op" in link) pf_br=${1:-}; pf_base=${2:-}; [ $# -lt 2 ] || shift 2 ;; esac
case "$op" in ci-failed) pf_pr=${1:-}; pf_sha=${2:-}; [ $# -lt 2 ] || shift 2 ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    -C) dir=${2:-.}; shift 2 || shift ;;
    --url) url=${2:-}; shift 2 || shift ;;
    --cli) pf_cli=${2:-}; shift 2 || shift ;;
    --jq) pf_jq=${2:-}; shift 2 || shift ;;
    *) echo "platform: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$op" in detect|field|link|env|warn|ci-failed) ;; *) echo "usage: platform.sh detect|field KEY|link BRANCH BASE|env|warn|ci-failed PR SHA --cli PATH [-C DIR] [--url URL]" >&2; exit 2 ;; esac
[ -n "$url" ] || url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)

# hp: "HOST/PATH" of the URL, lower-case host, no scheme, user, port, .git or trailing slash
hp=$(printf '%s' "$url" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#^[^@/]*@##' \
  -e 's#^\([^/:]*\):[0-9][0-9]*/#\1/#' -e 's#^\([^/:]*\):#\1/#' -e 's#/*$##' -e 's#\.git$##')
pf_local=no
# round 6: a local path starts with / ./ or ../ (or is . or ..), a file URL with file:/// (an empty host); `.evil.example:org/repo` and file://host/path are not local
case "$url" in /*|./*|../*|.|..|file:///*) hp=''; pf_local=yes ;; esac   # a local path has no hosting service
# a bare name that is a folder next to the main working tree (git accepts it as a path) is local too; resolved against the same base as origin_url (A180)
if [ -n "$url" ] && [ "$pf_local" = no ]; then
  case "$url" in -*|*:*|*@*) ;; *)
    pf_mb=$(git -C "$dir" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); [ -n "$pf_mb" ] || pf_mb=$dir
    [ ! -d "$pf_mb/$url" ] || { hp=''; pf_local=yes; } ;; esac
fi
host=${hp%%/*}; path=${hp#*/}; [ "$hp" != "$host" ] || path=''
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
platform=other owner='' org='' org_url='' proj='' repo='' web='' src=auto
case "$host" in   # exact hosts only: a lookalike (github.com.evil.example) or a self-hosted name is `other` unless git.platform or PROOFLINE_PLATFORM names it
  github.com|www.github.com) platform=github ;;
  dev.azure.com|ssh.dev.azure.com|*.visualstudio.com) platform=azure ;;
  bitbucket.org) platform=bitbucket ;;
  gitlab.com) platform=gitlab ;;
esac
[ -n "$host" ] && [ -n "$path" ] || platform=other
auto_platform=$platform   # what the origin host alone says (exact known hosts), before any configuration

# Config (A186): git.platform and git.platform_host of the project's .agents/config.yaml, read without the agent.sh parser
pf_top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
cfg_platform='' cfg_host=''
if [ -n "$pf_top" ] && [ -f "$pf_top/.agents/config.yaml" ]; then
  pf_c=$(awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^git:/ { g = 1; next }
    /^[^[:space:]]/ { g = 0 }
    g && /^[[:space:]]+(platform|platform_host):/ {
      k = $0; sub(/^[[:space:]]+/, "", k); sub(/:.*/, "", k)
      v = $0; sub(/^[^:]*:/, "", v); sub(/[[:space:]]+#.*$/, "", v); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
      print k "=" v
    }' "$pf_top/.agents/config.yaml" 2>/dev/null || true)
  cfg_platform=$(printf '%s\n' "$pf_c" | sed -n 's/^platform=//p' | head -1)
  cfg_host=$(printf '%s\n' "$pf_c" | sed -n 's/^platform_host=//p' | head -1 | tr '[:upper:]' '[:lower:]')
fi
# precedence: config (when its host, if any, is exactly the origin host), then PROOFLINE_PLATFORM, then the origin URL
case "${PROOFLINE_PLATFORM:-}" in github|gitlab|azure|bitbucket|other) platform=$PROOFLINE_PLATFORM; src='env' ;; esac
case "$cfg_platform" in
  github|gitlab|azure|bitbucket|other)
    if [ -z "$cfg_host" ] || { [ -n "$host" ] && [ "$host" = "$cfg_host" ]; }; then platform=$cfg_platform; src=config; fi ;;
esac
# A185 review: git.platform without git.platform_host applies to ANY origin. That is untrusted when the origin host is not an exact known host
# of that platform (a look-alike such as github.com.evil.example): `warn` says so and `env` exports no host variable for it.
pf_loose=no
if [ "$src" = config ] && [ -z "$cfg_host" ] && [ "$cfg_platform" != other ] && [ "$auto_platform" != "$cfg_platform" ]; then pf_loose=yes; fi

case "$platform" in
  azure)
    case "$host" in
      *.visualstudio.com)
        org=${host%%.*}
        p=$path; case "$p" in v3/*) p=${p#v3/}; org=${p%%/*}; p=${p#*/}; proj=${p%%/*}; repo=${p#*/} ;;
          *) p=$(printf '%s' "$p" | sed 's#^DefaultCollection/##'); proj=${p%%/*}; repo=${p##*/_git/} ;; esac
        org_url="https://$host" ;;
      ssh.dev.azure.com) p=${path#v3/}; org=${p%%/*}; p=${p#*/}; proj=${p%%/*}; repo=${p#*/}; org_url="https://dev.azure.com/$org" ;;
      dev.azure.com) org=${path%%/*}; p=${path#*/}; proj=${p%%/*}; repo=${p##*/_git/}; org_url="https://dev.azure.com/$org" ;;
      *)   # Azure DevOps Server: host/<collection path>/<project>/_git/<repo>; the organization URL is https://host/<collection path>
        case "$path" in */_git/*)
          before=${path%%/_git/*}; repo=${path##*/_git/}; proj=${before##*/}
          org=''; case "$before" in */*) org=${before%/*} ;; esac
          [ -z "$org" ] || org_url="https://$host/$org" ;; esac ;;
    esac
    owner=$org; web="https://dev.azure.com/$org/$proj/_git/$repo"
    case "$host" in dev.azure.com|ssh.dev.azure.com|*.visualstudio.com) ;; *) web="https://$host/$org/$proj/_git/$repo" ;; esac ;;
  *)
    owner=${path%%/*}; repo=${path##*/}
    web=''; [ -z "$host" ] || [ -z "$path" ] || web="https://$host/$path" ;;
esac
if [ "$src" = auto ]; then
  # an Azure URL that did not parse is not trusted: the manual path with the remote as it is
  if [ "$platform" = azure ] && { [ -z "$org" ] || [ -z "$proj" ] || [ -z "$repo" ]; }; then platform=other; owner=''; web=''; fi
  [ "$platform" != github ] || [ -n "$owner" ] || platform=other
fi

cli=none
case "$platform" in
  github) command -v gh >/dev/null 2>&1 && cli=gh ;;
  gitlab) command -v glab >/dev/null 2>&1 && cli=glab ;;
  azure) command -v az >/dev/null 2>&1 && cli=az ;;
esac
merge=manual; [ "$cli" = none ] || merge=cli
case "$platform" in bitbucket|other) merge=manual ;; esac

# pf_clean: one line of plain characters (a name or a status from a CI system is data)
pf_clean() { tr -c 'A-Za-z0-9 ._/=()#:-' ' ' | tr -s ' ' | cut -c1-"${1:-80}"; }
# pf_none ID NAME STATUS REASON: a failed check whose log could not be read: name and status only, said in the log text
pf_none() {
  printf 'RED\t%s\t%s\t%s\tnone\nLOG\n' "$1" "$(printf '%s' "$2" | pf_clean 80)" "$(printf '%s' "$3" | pf_clean 30)"
  printf 'check %s: %s. The log could not be read here (%s); this round starts from the check name and status only: open the check in %s for its output.\n' \
    "$(printf '%s' "$2" | pf_clean 80)" "$(printf '%s' "$3" | pf_clean 30)" "$4" "${web:-the hosting service}"
}
# the failed check of the head, per platform. Every tool call has stdin closed; any failure leaves the log unread, never stops.
ci_failed_github() {
  pf_t=$(printf '\t')
  pf_runs=$("$pf_cli" run list --commit "$pf_sha" --limit 30 --json databaseId,status,conclusion,name \
    --jq '.[] | [(.databaseId | tostring), .status, (.conclusion // "-"), .name] | join(" ")' 2>/dev/null </dev/null) || pf_runs=''
  pf_f=$(printf '%s\n' "$pf_runs" | awk '$2 == "completed" && ($3 == "failure" || $3 == "timed_out" || $3 == "startup_failure") { print; exit }')
  if [ -n "$pf_f" ]; then
    pf_id=${pf_f%% *}; pf_nm=${pf_f#* }; pf_nm=${pf_nm#* }; pf_cc=${pf_nm%% *}; pf_nm=${pf_nm#* }
    case "$pf_id" in ''|*[!0-9]*) return 0 ;; esac
    if pf_log=$("$pf_cli" run view "$pf_id" --log-failed 2>&1 </dev/null) && [ -n "$pf_log" ]; then
      printf 'RED%s%s%s%s%s%s%sread\nLOG\n%s\n' "$pf_t" "$pf_id" "$pf_t" "$(printf '%s' "$pf_nm" | pf_clean 80)" "$pf_t" "$pf_cc" "$pf_t" "$pf_log"
    else pf_none "$pf_id" "$pf_nm" "$pf_cc" "gh run view --log-failed gave no log"; fi
  else
    pf_c=$("$pf_cli" pr checks "$pf_pr" 2>/dev/null </dev/null | awk -F'\t' '$2 == "fail" { print $1 ": fail " $4 }' || true)
    [ -n "$pf_c" ] || return 0
    pf_nm=$(printf '%s\n' "$pf_c" | head -1 | cut -d: -f1)
    printf 'RED%s-%s%s%sfail%sread\nLOG\n%s\n' "$pf_t" "$pf_t" "$(printf '%s' "$pf_nm" | pf_clean 80)" "$pf_t" "$pf_t" "$pf_c"
  fi
}
ci_failed_gitlab() {
  [ -n "$pf_jq" ] || return 0
  pf_j=$("$pf_cli" mr view "$pf_pr" -F json 2>/dev/null </dev/null) || return 0
  pf_pl=$(printf '%s' "$pf_j" | "$pf_jq" -r '[(.head_pipeline.id // .pipeline.id // empty | tostring), (.head_pipeline.status // .pipeline.status // "-")] | join(" ")' 2>/dev/null) || return 0
  pf_pid=${pf_pl%% *}; pf_pst=${pf_pl#* }
  case "$pf_pid" in ''|*[!0-9]*) return 0 ;; esac
  case "$pf_pst" in failed) ;; *) return 0 ;; esac
  pf_jobs=$("$pf_cli" api "projects/:id/pipelines/$pf_pid/jobs?scope[]=failed&per_page=20" 2>/dev/null </dev/null \
    | "$pf_jq" -r '[.[] | select(.allow_failure != true)][0] // empty | [(.id | tostring), .name, .status] | join("\t")' 2>/dev/null) || pf_jobs=''
  [ -n "$pf_jobs" ] || { pf_none "$pf_pid" "pipeline $pf_pid" failed "no failed job could be read"; return 0; }
  pf_jid=$(printf '%s' "$pf_jobs" | cut -f1); pf_jnm=$(printf '%s' "$pf_jobs" | cut -f2); pf_jst=$(printf '%s' "$pf_jobs" | cut -f3)
  case "$pf_jid" in ''|*[!0-9]*) pf_none "$pf_pid" "pipeline $pf_pid" failed "no failed job could be read"; return 0 ;; esac
  if pf_log=$("$pf_cli" ci trace "$pf_jid" 2>&1 </dev/null) && [ -n "$pf_log" ]; then
    printf 'RED\t%s\t%s\t%s\tread\nLOG\n%s\n' "$pf_jid" "$(printf '%s' "$pf_jnm" | pf_clean 80)" "$(printf '%s' "$pf_jst" | pf_clean 30)" "$pf_log"
  else pf_none "$pf_jid" "$pf_jnm" "$pf_jst" "glab ci trace gave no log"; fi
}
ci_failed_azure() {
  [ -n "$pf_jq" ] || return 0
  [ -n "$org_url" ] || return 0
  pf_pol=$("$pf_cli" repos pr policy list --id "$pf_pr" --org "$org_url" -o json 2>/dev/null </dev/null) || return 0
  pf_b=$(printf '%s' "$pf_pol" | "$pf_jq" -r '[.[] | select((.status == "rejected" or .status == "broken") and (.context.buildId // empty) != "")][0] // empty
    | [(.context.buildId | tostring), (.configuration.settings.displayName // .configuration.type.displayName // "build policy"), .status] | join("\t")' 2>/dev/null) || pf_b=''
  [ -n "$pf_b" ] || return 0
  pf_bid=$(printf '%s' "$pf_b" | cut -f1); pf_bnm=$(printf '%s' "$pf_b" | cut -f2); pf_bst=$(printf '%s' "$pf_b" | cut -f3)
  case "$pf_bid" in ''|*[!0-9]*) return 0 ;; esac
  # the messages the build recorded for its failed tasks (build timeline); the raw task logs are not read
  # shellcheck disable=SC2016 # a jq variable, not a shell one
  pf_tl=$("$pf_cli" devops invoke --area build --resource timeline --route-parameters "project=$proj" "buildId=$pf_bid" --org "$org_url" --api-version 7.0 -o json 2>/dev/null </dev/null \
    | "$pf_jq" -r '.records[]? | select(.result == "failed" or .result == "canceled") | (.name // "task") as $n | (.issues // [])[]? | select(.type == "error") | $n + ": " + (.message // "")' 2>/dev/null) || pf_tl=''
  if [ -n "$pf_tl" ]; then printf 'RED\t%s\t%s\t%s\tread\nLOG\n%s\n' "$pf_bid" "$(printf '%s' "$pf_bnm" | pf_clean 80)" "$(printf '%s' "$pf_bst" | pf_clean 30)" "$pf_tl"
  else pf_none "$pf_bid" "$pf_bnm" "$pf_bst" "az devops invoke gave no task errors"; fi
}

case "$op" in
  detect) printf 'platform: %s\nsource: %s\nhost: %s\ncli: %s\nmerge: %s\nowner: %s\nrepo_path: %s\nweb: %s\n' "$platform" "$src" "$host" "$cli" "$merge" "$owner" "$path" "$web" ;;
  field)
    case "$key" in
      platform) printf '%s\n' "$platform" ;; cli) printf '%s\n' "$cli" ;; merge) printf '%s\n' "$merge" ;;
      owner) printf '%s\n' "$owner" ;; repo_path) printf '%s\n' "$path" ;; web) printf '%s\n' "$web" ;;
      local) printf '%s\n' "$pf_local" ;; source) printf '%s\n' "$src" ;; host) printf '%s\n' "$host" ;; org_url) printf '%s\n' "$org_url" ;; project) printf '%s\n' "$proj" ;;
      *) echo "platform: unknown field $key" >&2; exit 2 ;;
    esac ;;
  warn)
    [ "$pf_loose" = yes ] || exit 0
    printf 'warning: git.platform is %s without git.platform_host, and the origin host (%s) is not a known %s host, so the setting applies to whatever the origin is; set git.platform_host to the exact host name of the origin in .agents/config.yaml (proofline then also exports no host variable for it until you do)\n' "$cfg_platform" "${host:-none}" "$cfg_platform" ;;
  env)   # a private host: the tool must talk to the origin's host, not to github.com or gitlab.com
    [ "$pf_loose" = no ] || exit 0   # an origin the configuration did not name exactly never gets a host variable
    case "$host" in ''|*[!a-z0-9.-]*) exit 0 ;; esac
    case "$platform:$host" in
      github:github.com|github:www.github.com) ;;
      github:*) printf 'GH_HOST=%s\n' "$host" ;;
      gitlab:gitlab.com) ;;
      gitlab:*) printf 'GITLAB_HOST=%s\n' "$host" ;;
    esac ;;
  ci-failed)
    case "$pf_pr" in ''|*[!0-9]*) echo "usage: platform.sh ci-failed PR SHA --cli PATH" >&2; exit 2 ;; esac
    case "$pf_sha" in ''|*[!0-9a-f]*) exit 0 ;; esac
    [ -n "$pf_cli" ] && [ -x "$pf_cli" ] || exit 0   # no tool: no check can be read here
    case "$platform" in
      github) ci_failed_github ;; gitlab) ci_failed_gitlab ;; azure) ci_failed_azure ;;
    esac
    exit 0 ;;
  link)
    [ -n "$pf_br" ] && [ -n "$pf_base" ] || { echo "usage: platform.sh link BRANCH BASE" >&2; exit 2; }
    case "$platform" in
      github) printf '%s/compare/%s...%s?expand=1\n' "$web" "$pf_base" "$pf_br" ;;
      gitlab) printf '%s/-/merge_requests/new?merge_request%%5Bsource_branch%%5D=%s&merge_request%%5Btarget_branch%%5D=%s\n' "$web" "$pf_br" "$pf_base" ;;
      azure) printf '%s/pullrequestcreate?sourceRef=%s&targetRef=%s\n' "$web" "$pf_br" "$pf_base" ;;
      bitbucket) printf '%s/pull-requests/new?source=%s&dest=%s\n' "$web" "$pf_br" "$pf_base" ;;
      *) if [ -n "$web" ]; then printf '%s\n' "$web"; else printf '(the remote %s is not a web address: open a pull request or merge request for %s into %s in your hosting service)\n' "${url:-origin}" "$pf_br" "$pf_base"; fi ;;
    esac ;;
esac
