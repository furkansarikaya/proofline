# Bisecting with `git bisect run`

Use when a known-good commit exists and the failure can be decided by a script. Always in a worktree; the user's tree and branch are never touched.

1. **Script.** Write a script (outside the repository, for example in `mktemp -d`) that exits 0 when the commit is good, 1 when bad, and 125 when the commit cannot be tested (does not build, test file missing). It runs the reproduction command with a timeout. The script contains no repository-derived text in its source: commit ids and paths are arguments, quoted.
2. **Verify the endpoints.** Run the script at the good commit (must exit 0) and at the bad commit (must exit 1). Anything else: fix the script or the commits first; bisect results from unverified endpoints are not evidence.
3. **Run.** In the worktree: start the bisect with the bad and good commits, run it with the script, and let it finish. The reproduction test must exist at every tested commit: copy it in from outside the repository inside the script, rather than relying on history.
4. **Record** in `debug.json`: `bisect.used`, `good`, `bad`, `script` (path), `first_bad_commit`, `worktree`. Show the commit's subject and the changed files in the ledger.
5. **Treat the first bad commit as a lead, not the proof.** It narrows the cause to a diff; hypotheses still go through the flip experiment on the specific change. A merge commit or a commit that only reveals the bug (new test, config) is explained, not accepted.
6. **Reset.** End the bisect session, remove the worktree, prune, and check that the user's `git status` is unchanged.

Without a known-good commit, bisect the input or configuration instead (halving the differing parts) and note in the ledger why commit bisection was unavailable.
