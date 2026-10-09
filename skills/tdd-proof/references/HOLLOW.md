# Hollow-test check

Goal: prove the new test fails when the behaviour it claims to guard is absent. Run once per cycle after GREEN is observed and before GREEN is recorded.

1. **Worktree.** Create a separate worktree from HEAD at a fresh path (`mktemp -d`); record the path in the ledger before creating it. Copy the cycle's uncommitted changes in (the test file and the production change). Symlink git-ignored dependency folders (for example `node_modules`); never link or copy build output folders. All path checks use `realpath`. Never run this in the user's working directory.
2. **Break the behaviour**, choosing one:
   - `revert`: restore the production file(s) of this cycle to their pre-change content (the stub, or HEAD). Keep the test file.
   - `mutate`: keep the production file and change the behaviour minimally (flip a condition, return the neutral value, drop the added branch) when a revert would also remove code the test needs to compile.
3. **Run the same command** as RED/GREEN with a timeout (3x measured duration, at least 30 seconds).
4. **Judge.** Expected: the test fails and the output classifies as `assertion` (`scripts/classify-red.mjs`). Outcomes:
   - fails with `assertion`: not hollow. Record `hollow_check` (method, worktree, command, exit code, excerpt, `failed_for_expected_reason: true`).
   - passes: hollow. The test does not depend on the change (asserts a constant, mocks the unit itself, asserts nothing reachable, wrong test selected). Strengthen the test, restart the cycle from RED.
   - fails with another class (compile/import/crash): the check is inconclusive; use `mutate` instead of `revert`, or fix the stub, and re-run.
5. **Clean up.** Remove the worktree and prune; verify the user's tree shows no change from this check. A leftover worktree path in the ledger is removed on resume before anything else.

Never skip the check because the test "obviously" fails: the check is the evidence.
