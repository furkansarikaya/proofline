#!/bin/sh
# shellcheck disable=SC2015,SC2016 # assertion chains; literal command text
# Merge guard tests (A136): `proofline merge <PR>` against a stubbed gh on PATH, and the runtime hook's denial of
# every other merge path. Everything runs in a throwaway directory under $TMPDIR; no shared git config is touched.
set -u
repo=$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)
# The hook under test: HOOK_UNDER_TEST=<path of proofline-hook.mjs> runs this suite against the Node hook (a harness choice, read by this file only);
# the default is the shell hook. The hook never reads it.
hook=${HOOK_UNDER_TEST:-$repo/adapters/claude/hooks/proofline-hook.sh}
case $hook in *.mjs) hrun=node ;; *) hrun=sh ;; esac
pl=$repo/bin/proofline
base=$(mktemp -d "${TMPDIR:-/tmp}/proofline-merge.XXXXXX") || { echo "merge-guard: TMPDIR must be an existing directory" >&2; exit 2; }
trap 'rm -rf "$base"' EXIT
die() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
command -v jq >/dev/null 2>&1 || { echo "merge-guard: jq is required"; exit 2; }

# --- a project (not proofline-installed) and a stub gh -------------------------------------------
proj=$base/proj; mkdir -p "$proj"
git -C "$proj" init -q -b main 2>/dev/null || { git -C "$proj" init -q; git -C "$proj" checkout -q -b main; }
git -C "$proj" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
GHS=$base/ghs; mkdir -p "$GHS" "$base/stub"; export GHS
cat > "$base/stub/gh" <<'EOF'
#!/bin/sh
[ ! -f "$GHS/fail" ] || { echo "gh: HTTP 502" >&2; exit 1; }
case "$*" in
  *"pr merge"*) echo "$*" >> "$GHS/merge.log"; exit 0 ;;
  *"pr checks"*) cat "$GHS/required.json" 2>/dev/null || { echo "no required checks reported" >&2; exit 1; } ;;
  *statusCheckRollup*) cat "$GHS/view.json" ;;
  *headRefOid*) cat "$GHS/head.json" ;;
esac
EOF
chmod +x "$base/stub/gh"
sha=1111111111111111111111111111111111111111; sha2=2222222222222222222222222222222222222222
view() { # NUMBER STATE DRAFT SHA ROLLUP-JSON
  printf '{"number":%s,"state":"%s","isDraft":%s,"headRefOid":"%s","statusCheckRollup":%s}\n' "$1" "$2" "$3" "$4" "$5" > "$GHS/view.json"
  printf '{"headRefOid":"%s"}\n' "${HEAD2:-$4}" > "$GHS/head.json"
}
run_ok='{"__typename":"CheckRun","name":"static","status":"COMPLETED","conclusion":"SUCCESS"}'
ctx_ok='{"__typename":"StatusContext","context":"ci/legacy","state":"SUCCESS"}'
green="[$run_ok,$ctx_ok]"
reset() { rm -f "$GHS"/*.json "$GHS/merge.log" "$GHS/fail"; unset HEAD2; }
merge() { (cd "$proj" && PROOFLINE_SELFTEST=1 PATH="$base/stub:$PATH" sh "$pl" merge "$@") > "$base/out" 2>&1; }
refused() { # NAME MSG-FRAGMENT ARGS...
  n=$1 f=$2; shift 2
  merge "$@" && die "$n: merged"; [ ! -f "$GHS/merge.log" ] || die "$n: gh pr merge ran"
  grep -Fq -- "$f" "$base/out" || die "$n: refused for another reason: $(cat "$base/out")"; ok "$n"
}

reset; view 7 OPEN false $sha "$green"
merge 7 --squash --delete-branch || die "green PR not merged: $(cat "$base/out")"
grep -Fq -- "pr merge 7 --squash --match-head-commit $sha --delete-branch" "$GHS/merge.log" || die "merge command: $(cat "$GHS/merge.log")"; ok "all green merges through the wrapper, pinned to the checked head"
reset; view 7 OPEN false $sha "[$run_ok,{\"__typename\":\"CheckRun\",\"name\":\"selftest\",\"status\":\"COMPLETED\",\"conclusion\":\"FAILURE\"}]"
refused "red CI is refused" "selftest: status COMPLETED, conclusion FAILURE" 7
reset; view 7 OPEN false $sha "[$run_ok,{\"__typename\":\"CheckRun\",\"name\":\"selftest\",\"status\":\"IN_PROGRESS\",\"conclusion\":null}]"
refused "pending CI is refused" "selftest: status IN_PROGRESS" 7
reset; view 7 OPEN false $sha "[$run_ok,{\"__typename\":\"StatusContext\",\"context\":\"ci/x\",\"state\":\"PENDING\"}]"
refused "a pending status context is refused" "ci/x: state PENDING" 7
reset; view 7 OPEN false $sha "[$run_ok,{\"__typename\":\"CheckRun\",\"name\":\"n\",\"status\":\"COMPLETED\",\"conclusion\":\"NEUTRAL\"}]"
refused "neutral is refused" "conclusion NEUTRAL" 7
reset; view 7 OPEN false $sha "[$run_ok,{\"__typename\":\"CheckRun\",\"name\":\"n\",\"status\":\"COMPLETED\",\"conclusion\":\"CANCELLED\"}]"
refused "cancelled is refused" "conclusion CANCELLED" 7
reset; view 7 OPEN false $sha "[]"
refused "no checks at all is refused when the commit cannot be verified locally" "has no checks and its head commit" 7
reset; view 7 OPEN false $sha "null"
refused "a null rollup is refused when the commit cannot be verified locally" "has no checks and its head commit" 7
reset; HEAD2=$sha2 view 7 OPEN false $sha "$green"
refused "head moved after the check is refused" "moved after the check" 7
reset; view 7 OPEN true $sha "$green"; refused "a draft is refused" "is a draft" 7
reset; view 7 MERGED false $sha "$green"; refused "a merged PR is refused" "is MERGED, not OPEN" 7
reset; view 8 OPEN false $sha "$green"; refused "another PR number in the answer is refused" "did not return pull request 7" 7
reset; view 7 OPEN false abc "$green"; refused "a malformed head is refused" "not a 40-digit SHA" 7
reset; printf 'not json' > "$GHS/view.json"; refused "unparsable output is refused" "not parseable" 7
reset; : > "$GHS/fail"; refused "gh failing (offline) is refused with what it said" "HTTP 502" 7
reset; view 7 OPEN false $sha "$green"
refused "--admin is refused" "--admin" 7 --admin
refused "--auto is refused" "--auto" 7 --auto
refused "a URL instead of a number is refused" "plain number" https://github.com/o/r/pull/7
# skipped checks: pass unless required
skip='{"__typename":"CheckRun","name":"visual","status":"COMPLETED","conclusion":"SKIPPED"}'
reset; view 7 OPEN false $sha "[$run_ok,$skip]"
merge 7 || die "skipped, nothing required: $(cat "$base/out")"; ok "a skipped check that is not required passes (no required checks reported)"
reset; view 7 OPEN false $sha "[$run_ok,$skip]"; printf '[{"name":"static","bucket":"pass"}]\n' > "$GHS/required.json"
merge 7 || die "skipped, not in the required list: $(cat "$base/out")"; ok "a skipped check outside the required list passes"
reset; view 7 OPEN false $sha "[$run_ok,$skip]"; printf '[{"name":"static","bucket":"pass"},{"name":"visual","bucket":"skipping"}]\n' > "$GHS/required.json"
refused "a skipped required check is refused" "visual (skipping)" 7
# required checks: one that is not in the rollup yet (registered late) refuses; a missing one that is a pass elsewhere merges
reset; view 7 OPEN false $sha "$green"; printf '[{"name":"static","bucket":"pass"},{"name":"selftest","bucket":"pass"}]\n' > "$GHS/required.json"
refused "a required check missing from the rollup is refused" "missing from the rollup" 7
grep -Fq "using gh at $base/stub/gh" "$base/out" || die "the wrapper does not print the gh it uses: $(cat "$base/out")"; ok "the wrapper prints the gh path it uses"
# PATH shadowing: a gh in a temp dir without the self-test switch, and an empty PATH entry
reset; view 7 OPEN false $sha "$green"
(cd "$proj" && PATH="$base/stub:$PATH" sh "$pl" merge 7) > "$base/out" 2>&1 && die "merged with a gh from a temp directory"
grep -Fq "possibly shadowed gh" "$base/out" || die "temp-dir gh message: $(cat "$base/out")"; [ ! -f "$GHS/merge.log" ] || die "gh ran"; ok "a gh found in a temp directory is refused"
(cd "$proj" && PROOFLINE_SELFTEST=1 PATH="$base/stub::$PATH" sh "$pl" merge 7) > "$base/out" 2>&1 && die "merged with an empty PATH entry"
grep -Fq "empty or relative entry" "$base/out" || die "empty PATH entry message: $(cat "$base/out")"; ok "an empty PATH entry is refused"
# gh / jq missing: a PATH with only the tools the wrapper needs
nogh=$base/nogh; mkdir -p "$nogh"
for t in git sed awk head tr dirname cat readlink shasum sha256sum jq; do p=$(command -v "$t" 2>/dev/null) && ln -s "$p" "$nogh/$t"; done
shbin=$(command -v sh)
(cd "$proj" && PATH=$nogh "$shbin" "$pl" merge 7) > "$base/out" 2>&1 && die "merged without gh"
grep -Fq "gh is not installed" "$base/out" || die "gh missing message: $(cat "$base/out")"; ok "gh missing is refused"
rm -f "$nogh/jq"; (cd "$proj" && PROOFLINE_SELFTEST=1 PATH="$base/stub:$nogh" "$shbin" "$pl" merge 7) > "$base/out" 2>&1 && die "merged without jq"
grep -Fq "jq is not installed" "$base/out" || die "jq missing message: $(cat "$base/out")"; ok "jq missing is refused"

# --- the hook ----------------------------------------------------------------------------------
jstr() { printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); if (NR > 1) print "\\n"; print }'; }
pre() { printf '{"hook_event_name":"PreToolUse","session_id":"s","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"}}' "${CWD:-$proj}" "$(jstr "$1")" | $hrun "$hook" pretool claude; }
denies() { out=$(pre "$1"); printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "not denied: $1 -> $out"; printf '%s' "$out" | grep -Fq 'proofline merge' || die "denial does not name the wrapper: $1 -> $out"; }
allows() { out=$(pre "$1"); ! printf '%s' "$out" | grep -q '"permissionDecision":"deny"' || die "denied: $1 -> $out"; }
git -C "$proj" checkout -q -b feat/x
mkdir -p "$base/other"; git -C "$base/other" init -q -b main 2>/dev/null || { git -C "$base/other" init -q; git -C "$base/other" checkout -q -b main; }
git -C "$base/other" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
for c in 'gh pr merge 7' 'gh pr merge 7 --squash --delete-branch' 'gh pr merge 7 --admin' 'gh pr merge --auto --squash 7' 'gh -R o/r pr merge 7' \
  'gh pr -R o/r merge 7' 'GH_TOKEN=x gh pr merge 7' 'env gh pr merge 7' 'command gh pr merge 7' '/opt/homebrew/bin/gh pr merge 7' 'gh pr merge 7 &' \
  'cd . && gh pr merge 7' 'echo ok; gh pr merge 7' 'sh -c "gh pr merge 7"' "bash -lc 'gh pr merge 7 --admin'" 'sh -c "sh -c \"gh pr merge 7\""' \
  'gh "pr" merge 7' "gh p''r merge 7" 'xargs gh pr merge < prs' 'ssh host gh pr merge 7' 'sudo gh pr merge 7' 'timeout 9 gh pr merge 7' \
  'nohup gh pr merge 7' '$GH pr merge 7' 'gh pr merge 7 | cat' 'echo 7 | xargs -I{} gh pr merge {}' \
  'gh api -X PUT repos/o/r/pulls/7/merge' 'gh api repos/o/r/pulls/7/merge -f merge_method=squash' 'gh api --method PUT /repos/o/r/pulls/7/merge' \
  'gh api repos/o/r/merges -f base=main -f head=x' 'gh api graphql -f query="mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}"' \
  'gh api graphql -f query="mutation{enablePullRequestAutoMerge(input:{})}"' 'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc' 'gh alias set m "pr merge"' \
  'git push origin main' 'git push origin HEAD:main' 'git push origin feat/x:refs/heads/main' 'git push origin +main' 'git push --force origin main' 'git push origin refs/heads/main' \
  'git push --all' 'git push --mirror origin' 'git push origin $BR' 'git push origin "$(git branch --show-current)"' 'git -C . push origin master' \
  'git checkout main && git merge feat/x' 'git switch main; git merge feat/x' 'git update-ref refs/heads/main abc' \
  'git push -o -n origin main' 'git push origin main -o -n' 'git push --push-option -n origin main' 'git push --push-option=x origin main' 'git push --repo=origin main' 'git push --repo origin main' \
  'git push --receive-pack -n origin main' \
  'm=merge; gh pr $m 7' 'gh pr "$M" 7' 'gh pr $(echo merge) 7' 'gh $SUB merge 7' 'gh pr `echo merge` 7' "gh pr '\$M' 7" 'gh -R o/r pr $m 7' 'gh api $EP' \
  'curl -X PUT https://api.github.com/repos/o/r/pulls/7/merge' 'wget --method=PUT https://api.github.com/repos/o/r/pulls/7/merge' 'http PUT api.github.com/repos/o/r/pulls/7/merge' \
  'xh PUT https://api.github.com/repos/o/r/git/refs/heads/main sha=abc' 'curl -d @q https://api.github.com/graphql' 'curl -X PUT https://api.github.com/repos/o/r/contents/f' \
  'gh api graphql -F query=@q.graphql' 'gh api graphql --input q.json' 'gh api graphql -f query="mutation{x}"' 'gh api -X PUT repos/o/r/contents/README.md -f message=m -f content=Zg==' \
  'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc' 'gh api -X PATCH repos/o/r/git/refs/heads/$B -f sha=abc' \
  'echo gh pr merge 7 | sh' 'echo "gh pr merge 7" | bash -s' 'sh <<EOF
gh pr merge 7
EOF' 'bash <<< "gh pr merge 7"' 'python3 -c "import os; os.system(\"gh pr merge 7\")"' 'node -e "require(\"child_process\").execSync(\"gh pr merge 7\")"' \
  'awk "BEGIN{system(\"gh pr merge 7\")}"' 'eval "gh pr merge 7"' "git -c alias.m='!gh pr merge 7' m" 'echo git push origin main | sh' 'perl -e "system q(gh pr merge 7)"' \
  'env GIT_DIR=$PWD/.git git merge x' 'GIT_WORK_TREE=. git merge x' 'env -C . git merge x' 'cd - && git merge x' 'cd $B && git merge x' "cd $base/other && git merge x" "cd $base/other | cat; git merge x" \
  'PATH=/tmp/fake:$PATH gh pr view 7' 'export PATH=/tmp/x:$PATH; proofline merge 7' 'env PATH=/tmp/x proofline merge 7' 'PROOFLINE_SELFTEST=1 proofline merge 7'; do
  denies "$c"; done
ok "direct merge paths are denied, whatever the spelling ($c)"
git -C "$proj" checkout -q main
for c in 'git push' 'git push origin' 'git push -u origin' 'git push origin HEAD' 'git merge feat/x' 'git merge --no-ff feat/x' 'git -C . merge x' 'cd . && git merge x'; do denies "$c"; done
ok "a bare push, a push of HEAD and a merge are denied while the protected branch is checked out"
for c in 'git reset --hard feat/x' 'git cherry-pick abc' 'git rebase feat/x' 'git pull . feat/x' 'git pull ../other feat/x'; do denies "$c"; done
for c in 'git reset HEAD f' 'git reset --hard HEAD~1' 'git pull --ff-only origin main' 'git rebase --abort'; do allows "$c"; done
ok "A200: advancing the protected branch with reset, cherry-pick, rebase or a local pull is denied (an unstage and a pull from origin stay)"
git -C "$proj" checkout -q feat/x
for c in 'git branch -f main feat/x' 'git branch -M feat/x main' 'git fetch . feat/x:main' 'git fetch origin +feat/x:refs/heads/main'; do denies "$c"; done
for c in 'git branch -f feat/y HEAD' 'git branch -d feat/y' 'git fetch origin main' 'git fetch . main:feat/z'; do allows "$c"; done
ok "A200: branch -f and fetch into the protected branch are denied (other branches stay)"
for c in 'git checkout -B main feat/x' 'git switch -C main feat/x' 'git checkout -fB main feat/x' 'git checkout -Bmain feat/x' 'git switch -fC main feat/x' 'git switch --force-create main feat/x' 'git branch -fq main feat/x' 'git branch -Mf feat/x main' 'git branch -qf main feat/x'; do denies "$c"; done
for c in 'git checkout feat/x' 'git checkout -b feat/z' 'git checkout -B feat/z main' 'git switch feat/x' 'git switch -c feat/z' 'git switch -C feat/z main' 'git branch -fq feat/y HEAD' 'git branch -dq feat/y'; do allows "$c"; done
for c in 'git checkout main && git reset --hard feat/x' 'git switch main; git reset --hard feat/x' 'git checkout main && git cherry-pick abc' 'git switch main && git rebase feat/x' 'git checkout main && git am p.patch' 'git switch main; git revert abc' 'git checkout main && git pull . feat/x' 'git switch main && git pull ../other feat/x'; do denies "$c"; done
for c in 'git checkout main' 'git switch main' 'git checkout feat/x && git reset --hard feat/y' 'git checkout feat/x && git cherry-pick abc'; do allows "$c"; done
for c in '(git checkout main) && git reset --hard x' 'git checkout "main" && git reset --hard x' "git checkout 'main' && git reset --hard x" 'git checkout refs/heads/main && git reset --hard x' 'git checkout $B && git reset --hard x' 'B=main; git checkout $B && git reset --hard x' 'git switch `echo main` && git reset --hard x' '{ git checkout main; } && git cherry-pick abc' 'git checkout main && git merge feat/x' '(git checkout main) && git merge feat/x'; do denies "$c"; done
for c in 'git checkout feat/main-menu && git reset --hard x' 'git checkout main2 && git reset --hard x' 'git checkout origin/main && git reset --hard x' 'git checkout main' 'git checkout feat/x && git cherry-pick abc'; do allows "$c"; done
ok "A200 review: a reset, cherry-pick, rebase, am, revert or local pull chained after a checkout/switch to the protected branch is denied (the plain checkout stays)"
ok "A200 review: checkout -B / switch -C of the protected branch and clustered branch flags are denied (plain checkout and switch stay)"
for c in 'proofline merge 7' 'sh bin/proofline merge 7 --squash' 'git push -n origin main' 'git push --dry-run' 'git push -u origin feat/x' 'git push origin feat/x' 'git push' 'git merge main' 'git merge --abort' 'git status' 'git push -n -o -n origin main' 'git push -o ci.skip origin feat/x' 'git push origin feat/x -o x' 'git push --push-option=x origin feat/x' \
  'gh pr create --title t --body "$(cat f)"' 'gh pr view $N --json state' 'gh api repos/o/r/pulls/7/comments' 'curl -s https://example.com' 'curl -s https://api.github.com/repos/o/r/pulls/7' \
  'gh api repos/$O/$R/pulls/7' 'cd . && git push origin feat/x' 'echo hello | sh' 'python3 -c "print(1)"' 'PATH=/usr/bin ls' 'export FOO=1' \
  'gh pr view 7 --json statusCheckRollup' 'gh pr checks 7' 'gh pr create --title t --body b' 'gh pr list' 'gh api repos/o/r/pulls/7' 'gh api repos/o/r/commits/abc/check-runs' \
  'git commit -m "docs: gh pr merge goes through the wrapper"' 'echo gh pr merge 7' 'grep -rn "pr merge" docs' 'git log --oneline' 'git merge-base main HEAD' 'git fetch origin main' 'git pull --ff-only origin main'; do allows "$c"; done
ok "the wrapper, feature-branch pushes and read-only gh / git commands are allowed"
# installed project: the same guard runs before any run logic
mkdir -p "$proj/.agents/scripts"; : > "$proj/.agents/config.yaml"; printf 'echo main\n' > "$proj/.agents/scripts/agent.sh"
denies 'gh pr merge 7 --admin'; denies 'git push origin main'; allows 'proofline merge 7'; ok "the guard also runs in an installed project"
echo "merge guard tests passed"
