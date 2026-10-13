# Reproduce: concurrent or repeated runs in the project's own test runner

A reproduction drives the traced schedule with the project's existing test runner and helpers. It never
installs anything (no race detector, stress tool or load generator that is not already in the project), and
it never touches a database the test setup did not create (A50, A52).

## 1. Can it run? (decide `reproduction.status`)

- The project has a test command (CI config, build scripts, README) and it runs unmodified in a worktree:
  `ran` is possible.
- No test runner, the code needs an external system (real queue, real gateway, real database) with no fake or
  throwaway instance in the test setup, or the runtime offers no way to run two actors (no threads, no
  async, no subprocess) in a test: `unsupported`, with that reason. Traced findings remain valid.
- A race detector that is part of the toolchain already installed (for example a `-race` flag of the
  compiler or test command) may be used; it is the project's runner with a flag, not an install.

## 2. Worktree

- Record the absolute path in the ledger **before** creating it; the last component starts with
  `concurrency-proof-` (`reproduction.worktree`).
- `git worktree add --detach <tmp>/concurrency-proof-<slug> <head>`; for working-tree targets copy the
  uncommitted changes in. Symlink git-ignored dependency folders; never link or copy build output. Never
  install anything.
- Run the project's own test command unmodified first, with a timeout of at least 30 seconds derived from a
  measured run.

## 3. The evidence test

- One test file next to the project's tests, in their style, that **asserts the defect**: it passes while the
  problem exists (two deposits on 100 leave 120, not 130; the shipper is called twice; the gateway ledger has
  two charges).
- Drive the schedule, do not hope for it: start the actors together (`Promise.all`, threads with a barrier,
  goroutines with a WaitGroup), and use a slow fake at the interleaving point (a store or client whose call
  yields or sleeps) when the project's test helpers allow it. A fake built in the test from the project's own
  code is fine; patching product code is not.
- Include a **control**: the same operations run sequentially give the correct result.
- Run it at least twice (`runs`); record how many runs showed the failure (`failures`, at least 1) and the
  observed output (`observed`). A race that shows in 3 of 20 runs is reproduced with `runs: 20, failures: 3`.
- Write down the inverted assertion: the regression test the implementer keeps after the fix.
- Print the sandbox warning once before the first project code runs (shared rule 9).

## 4. Keep a copy, not the test

Copy the test text to `evidence/<finding-id>.test.txt` in the output folder (`saved_copy`) with its output.
Never run it from there; never place it in the user's working tree.

## 5. Clean up

`git worktree remove --force <path>`, `git worktree prune`, confirm the user's `git status` and `HEAD` equal
`evidence/git-status-before.txt`, clear the worktree path in the ledger. On resume, remove a worktree still
recorded there first.
