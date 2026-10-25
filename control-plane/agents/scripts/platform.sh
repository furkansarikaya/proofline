#!/bin/sh
# Hosting platform of the project's remote (A180): which pull request system a delivery talks to, which command line
# tool is installed for it, and so who merges. Read-only; nothing here opens, reads or merges a pull request.
#   platform.sh detect [-C DIR] [--url URL]   key: value lines: platform, cli, merge, owner, repo_path, web
#   platform.sh field KEY [-C DIR] [--url URL] one value
#   platform.sh link BRANCH BASE [-C DIR] [--url URL]   the address that opens a pull request for BRANCH into BASE
# platform: github | gitlab | azure | bitbucket | other      (from the remote URL; a host is judged by its name)
# cli:      gh | glab | az | none                              (the tool of that platform, only when it is on PATH)
# merge:    cli    proofline opens the pull request / merge request, reads the checks and merges through the tool
#           manual proofline pushes the branch and prints the link or the manual steps; the USER merges
#                  (Bitbucket, any unrecognized host, and a recognized platform whose tool is not installed)
# The remote is `origin` of the repository in DIR (default: the current directory) unless --url names it.
set -u
op=${1:-}; [ $# -eq 0 ] || shift
dir=. url=''
key=''
case "$op" in field) key=${1:-}; [ $# -eq 0 ] || shift ;; esac
case "$op" in link) pf_br=${1:-}; pf_base=${2:-}; [ $# -lt 2 ] || shift 2 ;; esac
while [ $# -gt 0 ]; do
  case "$1" in
    -C) dir=${2:-.}; shift 2 || shift ;;
    --url) url=${2:-}; shift 2 || shift ;;
    *) echo "platform: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$op" in detect|field|link) ;; *) echo "usage: platform.sh detect|field KEY|link BRANCH BASE [-C DIR] [--url URL]" >&2; exit 2 ;; esac
[ -n "$url" ] || url=$(git -C "$dir" remote get-url origin 2>/dev/null || true)

# hp: "HOST/PATH" of the URL, lower-case host, no scheme, user, port, .git or trailing slash
hp=$(printf '%s' "$url" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#^[^@/]*@##' \
  -e 's#^\([^/:]*\):[0-9][0-9]*/#\1/#' -e 's#^\([^/:]*\):#\1/#' -e 's#/*$##' -e 's#\.git$##')
case "$url" in /*|.*|file://*) hp='' ;; esac   # a local path has no hosting service
host=${hp%%/*}; path=${hp#*/}; [ "$hp" != "$host" ] || path=''
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
platform=other owner='' org='' proj='' repo='' web=''
case "$host" in   # exact hosts only: a lookalike (github.com.evil.example) or a self-hosted name is `other` unless PROOFLINE_PLATFORM names it
  github.com|www.github.com) platform=github ;;
  dev.azure.com|ssh.dev.azure.com|*.visualstudio.com) platform=azure ;;
  bitbucket.org) platform=bitbucket ;;
  gitlab.com) platform=gitlab ;;
esac
[ -n "$host" ] && [ -n "$path" ] || platform=other
case "$platform" in
  azure)
    case "$host" in
      *.visualstudio.com)
        org=${host%%.*}
        p=$path; case "$p" in v3/*) p=${p#v3/}; org=${p%%/*}; p=${p#*/}; proj=${p%%/*}; repo=${p#*/} ;;
          *) p=$(printf '%s' "$p" | sed 's#^DefaultCollection/##'); proj=${p%%/*}; repo=${p##*/_git/} ;; esac ;;
      ssh.dev.azure.com) p=${path#v3/}; org=${p%%/*}; p=${p#*/}; proj=${p%%/*}; repo=${p#*/} ;;
      *) org=${path%%/*}; p=${path#*/}; proj=${p%%/*}; repo=${p##*/_git/} ;;
    esac
    owner=$org; web="https://dev.azure.com/$org/$proj/_git/$repo" ;;
  *)
    owner=${path%%/*}; repo=${path##*/}
    web=''; [ -z "$host" ] || [ -z "$path" ] || web="https://$host/$path" ;;
esac
# an Azure URL that did not parse is not trusted: the manual path with the remote as it is
if [ "$platform" = azure ] && { [ -z "$org" ] || [ -z "$proj" ] || [ -z "$repo" ]; }; then platform=other; owner=''; web=''; fi
[ "$platform" != github ] || [ -n "$owner" ] || platform=other

case "${PROOFLINE_PLATFORM:-}" in github|gitlab|azure|bitbucket|other) platform=$PROOFLINE_PLATFORM ;; esac   # a self-hosted host with an unrecognizable name
cli=none
case "$platform" in
  github) command -v gh >/dev/null 2>&1 && cli=gh ;;
  gitlab) command -v glab >/dev/null 2>&1 && cli=glab ;;
  azure) command -v az >/dev/null 2>&1 && cli=az ;;
esac
merge=manual; [ "$cli" = none ] || merge=cli
case "$platform" in bitbucket|other) merge=manual ;; esac

case "$op" in
  detect) printf 'platform: %s\ncli: %s\nmerge: %s\nowner: %s\nrepo_path: %s\nweb: %s\n' "$platform" "$cli" "$merge" "$owner" "$path" "$web" ;;
  field)
    case "$key" in
      platform) printf '%s\n' "$platform" ;; cli) printf '%s\n' "$cli" ;; merge) printf '%s\n' "$merge" ;;
      owner) printf '%s\n' "$owner" ;; repo_path) printf '%s\n' "$path" ;; web) printf '%s\n' "$web" ;;
      *) echo "platform: unknown field $key" >&2; exit 2 ;;
    esac ;;
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
