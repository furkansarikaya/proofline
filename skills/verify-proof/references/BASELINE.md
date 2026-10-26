# Pre-existing failures

A command that fails on the current tree may have failed before the change. Only the base revision can tell.

## Procedure (per failing command)

1. Base revision: the run's `base_sha` (in a run), else `git merge-base HEAD <default branch>`; if none can be determined the command cannot be classified and stays a failure.
2. Create an isolated worktree at the base (`git worktree add --detach <path> <base>`), record its path in the ledger first. Git-ignored dependency folders (for example `node_modules`) are symlinked from the project while no step installs or changes packages (then copy the folder, so nothing writes through the link into the project); build output folders are not linked or copied; verify every link target with `realpath` stays inside the project.
3. Run the **same command**, same timeout, in the worktree. If it needs a narrower selector to be meaningful (a test file that does not exist at base), run the broader command the project uses.
4. Record `| base_exit=<n>` on the head command line. Compare the failing items: for test runners, the same failing test names must appear at base; if only some of the head failures also fail at base, split: list the shared ones as pre-existing in `## Pre-existing failures` and keep the command failed (the new failures are a regression).
5. Remove the worktree (its own `git worktree remove` command on the recorded literal path).

## Recording

Line: ``- `npm test` | exit=1 | base_exit=1``, then under `## Pre-existing failures`: ``- `npm test`: <failing names> also fail at <base short sha>``. Both are required; the validator rejects a `base_exit` command that is not listed.

## Never

- Never treat a failure as pre-existing without running it at base.
- Never "fix" or skip a pre-existing failure in the project to get a pass.
- A command that passes at head is never given a `base_exit`.
