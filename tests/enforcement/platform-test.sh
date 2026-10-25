#!/bin/sh
# shellcheck disable=SC2015,SC2016 # assertion chains; literal command text
# Platform-independent delivery (A180): the remote decides the platform (GitHub, GitLab, Azure DevOps, Bitbucket, other); `proofline merge`
# merges through gh, glab or az (fake binaries on PATH) with the same strictness, and on Bitbucket, an unrecognized host or a missing
# tool it merges nothing and says the user merges. A pull request without checks is merged only after the project's build and test pass
# in a clean copy of the commit ("verified locally, no CI"). The hook keeps the single merge path for glab and az.
set -u
repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
hook=$repo/adapters/claude/hooks/proofline-hook.sh
pl=$repo/bin/proofline
pfs=$repo/control-plane/agents/scripts/platform.sh
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-platform.XXXXXX") || { echo "platform: TMPDIR must be an existing directory" >&2; exit 2; }
trap 'rm -rf "$base"' EXIT
die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
command -v jq >/dev/null 2>&1 || { echo "platform: jq is required"; exit 2; }

# --- detection ------------------------------------------------------------------------------------
mkdir -p "$base/stub" "$base/empty"
for t in glab az; do printf '#!/bin/sh\nexit 0\n' > "$base/stub/$t"; chmod +x "$base/stub/$t"; done
det() { PATH="$base/stub:$PATH" sh "$pfs" field "$1" --url "$2"; }
want() { [ "$(det "$1" "$2")" = "$3" ] || die "$1 of $2: want $3, got $(det "$1" "$2")"; }
want platform git@github.com:acme/app.git github
want platform https://github.com/acme/app github
want platform https://gitlab.com/acme/sub/app.git gitlab
want platform git@gitlab.example.org:acme/app.git gitlab
want platform https://acme@dev.azure.com/acme/Proj/_git/app azure
want platform git@ssh.dev.azure.com:v3/acme/Proj/app azure
want platform https://acme.visualstudio.com/DefaultCollection/Proj/_git/app azure
want platform git@bitbucket.org:acme/app.git bitbucket
want platform ssh://git@git.example.com:2222/acme/app.git other
want platform /srv/git/app.git other
want cli https://gitlab.com/acme/app.git glab
want cli https://dev.azure.com/acme/Proj/_git/app az
want cli https://bitbucket.org/acme/app none
want merge https://bitbucket.org/acme/app manual
want merge https://gitlab.com/acme/app cli
want owner https://dev.azure.com/acme/Proj/_git/app acme
[ "$(PATH="$base/empty" /bin/sh "$pfs" field cli --url https://gitlab.com/acme/app 2>/dev/null)" = none ] || die "glab missing must give cli none"
[ "$(PATH="$base/empty" /bin/sh "$pfs" field merge --url https://gitlab.com/acme/app 2>/dev/null)" = manual ] || die "a missing tool must give the manual rule"
sh "$pfs" link feat/x main --url https://dev.azure.com/acme/Proj/_git/app | grep -Fq 'pullrequestcreate?sourceRef=feat/x&targetRef=main' || die "azure link"
ok "GitHub, GitLab, Azure DevOps, Bitbucket and other remotes are recognized; a missing tool or Bitbucket means the manual rule"

# --- a project, an installed-looking verifier and fake glab / az ------------------------------------
proj=$base/proj; mkdir -p "$proj/.agents/scripts"
git -C "$proj" init -q -b main 2>/dev/null || { git -C "$proj" init -q; git -C "$proj" checkout -q -b main; }
printf 'x\n' > "$proj/f.txt"; git -C "$proj" add -A; git -C "$proj" -c user.name=t -c user.email=t@t commit -q -m base
sha=$(git -C "$proj" rev-parse HEAD); sha2=2222222222222222222222222222222222222222
cp "$repo/control-plane/agents/scripts/build-record.sh" "$proj/.agents/scripts/"
# a stand-in agent.sh that answers config-get from files (build-record reads the verification commands through it)
cat > "$proj/.agents/scripts/agent.sh" <<'EOF'
#!/bin/sh
here=$(dirname "$0")
[ "$1" = config-get ] || exit 0
case "$2" in commands.build) cat "$here/../cmd.build" 2>/dev/null ;; commands.test) cat "$here/../cmd.test" 2>/dev/null ;; esac
exit 0
EOF
git -C "$proj" config user.name t; git -C "$proj" config user.email t@t
printf '.agents/local/\n' > "$proj/.gitignore"
FS=$base/fs; mkdir -p "$FS"; export FS
cat > "$base/stub/glab" <<'EOF'
#!/bin/sh
echo "$*" >> "$FS/glab.log"
case "$1 $2" in
  "mr view") cat "$FS/glab.view" ;;
  "mr merge") echo "$*" >> "$FS/merge.log" ;;
  "mr note") echo "$*" >> "$FS/note.log" ;;
esac
exit 0
EOF
cat > "$base/stub/az" <<'EOF'
#!/bin/sh
echo "$*" >> "$FS/az.log"
case "$*" in
  *"pr policy list"*) cat "$FS/az.policy" ;;
  *"pr show"*) cat "$FS/az.view" ;;
  *"pr update"*"completed"*) echo "$*" >> "$FS/merge.log" ;;
  *"pr update"*) echo "$*" >> "$FS/note.log" ;;
esac
exit 0
EOF
chmod +x "$base/stub/glab" "$base/stub/az"
reset() { rm -f "$FS"/*; printf 'echo built\n' > "$proj/.agents/cmd.build"; printf 'echo tested\n' > "$proj/.agents/cmd.test"; rm -rf "$proj/.agents/local"; }
glabview() { # STATE DRAFT SHA PIPELINE-JSON(null|{...})
  printf '{"iid":7,"state":"%s","draft":%s,"sha":"%s","head_pipeline":%s}\n' "$1" "$2" "$3" "$4" > "$FS/glab.view"; }
azview() { printf '{"pullRequestId":7,"status":"%s","isDraft":%s,"lastMergeSourceCommit":{"commitId":"%s"},"description":"old text"}\n' "$1" "$2" "$3" > "$FS/az.view"; }
merge() { (cd "$proj" && PROOFLINE_SELFTEST=1 PATH="$base/stub:$PATH" sh "$pl" merge "$@") > "$base/out" 2>&1; }
refused() { # LABEL TEXT ARGS...
  l=$1; t=$2; shift 2
  if merge "$@"; then die "$l: merged: $(cat "$base/out")"; fi
  grep -Fq -- "$t" "$base/out" || die "$l: wrong refusal: $(cat "$base/out")"
  [ ! -f "$FS/merge.log" ] || die "$l: the tool merged"
  ok "$l"
}
green_pipe="{\"status\":\"success\",\"sha\":\"$sha\"}"

# --- GitLab -----------------------------------------------------------------------------------------
git -C "$proj" remote add origin https://gitlab.com/acme/app.git
reset; glabview opened false "$sha" "$green_pipe"
merge 7 --squash || die "green gitlab merge request: $(cat "$base/out")"
grep -Fq "mr merge 7 --sha $sha --yes --squash" "$FS/merge.log" || die "glab merge line: $(cat "$FS/merge.log")"
grep -Fq "using glab at" "$base/out" || die "no tool path printed"
[ ! -f "$FS/note.log" ] || die "a green pipeline needs no local verification note"
ok "gitlab: a merge request with a green pipeline on its head merges through glab (--sha pinned)"
reset; glabview opened false "$sha" '{"status":"failed","sha":"'"$sha"'"}'; refused "gitlab: a failed pipeline is refused" "pipeline of its head is failed" 7
reset; glabview opened false "$sha" '{"status":"running","sha":"'"$sha"'"}'; refused "gitlab: a running pipeline is refused" "is running" 7
reset; glabview opened false "$sha" '{"status":"success","sha":"'"$sha2"'"}'; refused "gitlab: a pipeline of another commit is refused" "not on the head" 7
reset; glabview opened true "$sha" "$green_pipe"; refused "gitlab: a draft is refused" "is a draft" 7
reset; glabview merged false "$sha" "$green_pipe"; refused "gitlab: a merged request is refused" "merged, not opened" 7
# no pipeline: the commit is verified locally in a clean copy first
reset; glabview opened false "$sha" null
merge 7 || die "gitlab without a pipeline, verification passing: $(cat "$base/out")"
grep -Fq 'verified locally, no CI' "$FS/note.log" || die "the merge request got no 'verified locally, no CI' note"
[ -f "$FS/merge.log" ] || die "not merged after a passing local verification"
ls -d "$proj/.agents/local/builds/$sha"* >/dev/null 2>&1 || die "no build record for the merged commit"
ok "gitlab: no pipeline -> build and test pass in a clean copy of the commit, the note 'verified locally, no CI' is posted, then it merges"
reset; glabview opened false "$sha" null; printf 'echo broken; exit 3\n' > "$proj/.agents/cmd.test"
refused "gitlab: no pipeline and a failing local test is refused" "verification commands FAILED" 7
reset; glabview opened false "$sha" null; : > "$proj/.agents/cmd.build"; : > "$proj/.agents/cmd.test"
refused "gitlab: no pipeline and nothing configured to verify with is refused" "not configured" 7
reset; glabview opened false "$sha2" null; refused "gitlab: no pipeline and a head that is not in this clone is refused" "not in this clone" 7

# --- Azure DevOps -----------------------------------------------------------------------------------
git -C "$proj" remote set-url origin https://acme@dev.azure.com/acme/Proj/_git/app
pol_ok='[{"status":"approved","configuration":{"type":{"displayName":"Build"}}},{"status":"approved","configuration":{"type":{"displayName":"Minimum number of reviewers"}}}]'
reset; azview active false "$sha"; printf '%s\n' "$pol_ok" > "$FS/az.policy"
merge 7 --squash --delete-branch || die "azure with approved build policy: $(cat "$base/out")"
grep -Fq -- "--id 7 --status completed --squash true --delete-source-branch true" "$FS/merge.log" || die "az merge line: $(cat "$FS/merge.log")"
ok "azure: an active pull request with every build policy approved merges through az repos"
reset; azview active false "$sha"; printf '[{"status":"rejected","configuration":{"type":{"displayName":"Build"}}}]\n' > "$FS/az.policy"
refused "azure: a rejected build policy is refused" "not approved" 7
reset; azview active false "$sha"; printf '[{"status":"queued","configuration":{"type":{"displayName":"Build"}}}]\n' > "$FS/az.policy"
refused "azure: a queued build policy is refused" "Build=queued" 7
reset; azview abandoned false "$sha"; printf '[]\n' > "$FS/az.policy"; refused "azure: an abandoned pull request is refused" "abandoned, not active" 7
reset; azview active false "$sha"; printf '[{"status":"approved","configuration":{"type":{"displayName":"Minimum number of reviewers"}}}]\n' > "$FS/az.policy"
merge 7 || die "azure without build policy, verification passing: $(cat "$base/out")"
grep -Fq 'old text' "$FS/note.log" && grep -Fq 'verified locally, no CI' "$FS/note.log" || die "the description keeps its text and gains the note: $(cat "$FS/note.log" 2>/dev/null)"
ok "azure: no build policy -> verified locally in a clean copy, the description gains 'verified locally, no CI', then it merges"

# --- the user merges: Bitbucket, unrecognized, missing tool ---------------------------------------------
for u in https://bitbucket.org/acme/app.git ssh://git@git.example.com/acme/app.git; do
  git -C "$proj" remote set-url origin "$u"; reset; glabview opened false "$sha" "$green_pipe"
  if merge 7; then die "merged on $u"; fi
  grep -Fq 'NOT MERGED' "$base/out" && grep -Fq 'YOU merge it' "$base/out" && grep -Fq 'manual steps' "$base/out" || die "no explicit manual message for $u: $(cat "$base/out")"
  [ ! -f "$FS/merge.log" ] || die "a tool merged on $u"
done
ok "bitbucket and an unrecognized host: nothing is merged, the message says the USER merges and prints the steps"
git -C "$proj" remote set-url origin https://gitlab.com/acme/app.git
nogl=$base/nogl; mkdir -p "$nogl"; for t in git sed awk head tr dirname cat readlink jq sh; do p=$(command -v "$t" 2>/dev/null) && ln -sf "$p" "$nogl/$t"; done
(cd "$proj" && PROOFLINE_SELFTEST=1 PATH=$nogl "$(command -v sh)" "$pl" merge 7) > "$base/out" 2>&1 && die "merged without glab"
grep -Fq 'NOT MERGED' "$base/out" && grep -Fq 'glab' "$base/out" && grep -Fq 'YOU merge it' "$base/out" || die "missing-tool message: $(cat "$base/out")"
ok "a recognized platform whose tool is not installed falls back to the manual path"

# --- gh with no checks: local verification (the gh path keeps its strictness) ----------------------------
git -C "$proj" remote set-url origin https://github.com/acme/app.git
cat > "$base/stub/gh" <<'EOF'
#!/bin/sh
case "$*" in
  *"pr merge"*) echo "$*" >> "$FS/merge.log"; exit 0 ;;
  *"pr comment"*) echo "$*" >> "$FS/note.log"; exit 0 ;;
  *"pr checks"*) echo "no required checks reported" >&2; exit 1 ;;
  *statusCheckRollup*) cat "$FS/gh.view" ;;
  *headRefOid*) printf '{"headRefOid":"%s"}\n' "$(sed -n 's/.*"headRefOid":"\([0-9a-f]*\)".*/\1/p' "$FS/gh.view")" ;;
esac
EOF
chmod +x "$base/stub/gh"
ghview() { printf '{"number":7,"state":"OPEN","isDraft":false,"headRefOid":"%s","statusCheckRollup":%s}\n' "$1" "$2" > "$FS/gh.view"; }
reset; ghview "$sha" '[]'
merge 7 || die "gh no checks, verification passing: $(cat "$base/out")"
grep -Fq 'verified locally, no CI' "$FS/note.log" && [ -f "$FS/merge.log" ] || die "gh: no note or no merge"
ok "github: a pull request with no checks is merged after the local verification and says 'verified locally, no CI'"
reset; ghview "$sha" 'null'; printf 'echo broken; exit 2\n' > "$proj/.agents/cmd.build"
refused "github: no checks and a failing local build is refused" "verification commands FAILED" 7
reset; ghview "$sha" '[{"__typename":"CheckRun","name":"static","status":"COMPLETED","conclusion":"FAILURE"}]'
refused "github: a red check is still refused (no local verification replaces it)" "not green" 7

# --- the hook keeps the single merge path on glab and az ---------------------------------------------
jstr() { printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) print "\\n"; print }'; }
pre() { printf '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "$proj" "$(jstr "$1")" | sh "$hook" pretool claude; }
git -C "$proj" checkout -q -b feat/x
for c in 'glab mr merge 7' 'glab mr merge 7 --squash --yes' 'glab -R acme/app mr merge 7' 'glab alias set m "mr merge"' 'glab api -X PUT projects/1/merge_requests/7/merge' \
  'glab api projects/1/merge_requests/7/merge -X PUT -f merge_when_pipeline_succeeds=true' 'sh -c "glab mr merge 7"' 'm=merge; glab mr $m 7' \
  'az repos pr update --id 7 --status completed' 'az repos pr update --id 7 --auto-complete true' 'az repos pr update --id 7 --status=completed --squash true' \
  'az rest --method patch --uri https://dev.azure.com/o/p/_apis/git/repositories/r/pullrequests/7' 'az devops invoke --area git --resource pullRequests --http-method PATCH' \
  'curl -X PUT https://gitlab.com/api/v4/projects/1/merge_requests/7/merge'; do
  out=$(pre "$c"); printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "not denied: $c -> $out"
  printf '%s' "$out" | grep -Fq 'proofline merge' || die "the denial does not name proofline merge: $c"
done
ok "glab mr merge, glab api merge, az repos pr update that completes, az rest on pull requests and HTTP clients are denied"
for c in 'proofline merge 7' 'glab mr view 7' 'glab mr create --target-branch main' 'glab ci status' 'az repos pr show --id 7' 'az repos pr create --source-branch x --target-branch main' 'az repos pr policy list --id 7' 'az repos pr update --id 7 --title t' 'glab api projects/1/merge_requests/7'; do
  out=$(pre "$c"); ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "denied: $c -> $out"
done
ok "reading, creating and retitling stay allowed"
echo "platform tests passed"
