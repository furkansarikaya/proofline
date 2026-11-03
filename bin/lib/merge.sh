# shellcheck shell=sh
# proofline merge <PR> (A136): the only allowed way to merge a pull request. The runtime hook denies every other merge path (gh pr merge,
# gh api .../merge, git merge into / git push to the protected branch). The logic is Node code since A216 (core/merge.mjs, `proofline-core.mjs cli merge`):
#
#   proofline merge <PR-NUMBER> [--merge|--squash|--rebase] [--delete-branch] [-R OWNER/REPO]
#
# It merges only when the pull request is open, not a draft, and every check is a success on the head that is merged (read twice, the merge is pinned to it);
# --admin and --auto are refused; the platform tool (gh, glab, az) is refused when it resolves into the project, the working directory or a temporary
# folder; a pull request with no checks is merged only after the project's build and test pass in a clean copy of the commit; Bitbucket, an unrecognized host
# and a missing tool are not merged by proofline (exit 1: the user merges). This launcher stays until the front end moves (stage 9).
cmd_merge() {
  node "$PL_HOME/control-plane/agents/scripts/proofline-core.mjs" cli merge "$@"
}
