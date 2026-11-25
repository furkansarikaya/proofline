# Hollow detection by targeted mutation

A hollow test stays green when the code it claims to protect is broken. The proof is a mutation of that code that the tests do not notice.

Mutation is **per production unit, not per test**: pick production functions exercised by the tests in scope, break each one in a few targeted ways, and run the tests that cover it. If no covering test turns red for a mutant, that mutant **survived**.

## 1. Choose targets (read-only, before the cost estimate)

No code is changed or run in this step. A sub-agent may do it if available.

1. Map tests in scope to the production functions they exercise (imports, calls, names, fixtures). Leave out tests on the "red at baseline" list; a red test says nothing about a mutant.
2. Rank production units by this priority:
   1. code touched by tests with **no assertions**, or only "did not throw"
   2. code touched by tests that **mock everything** around it
   3. code touched by **snapshot-only** tests
   4. the rest
3. For each chosen unit, write down **3–5 mutations** and the covering tests that should catch them.

Flaky results are not known yet at this point; confirmed flaky tests are removed from the covering sets later, just before the mutants run (step 3).

Record the target list in the ledger (Progress → hollow) so a resumed run continues from the same list. The hollow budget in the cost estimate is one unmutated verification run of all covering tests (including the worktree's first build, estimated from the baseline) plus the number of mutants × the covering tests' baseline duration. Once the verification run has happened, use its measured duration instead.

### Mutation kinds

Pick mutations a correct test should catch; each one is a small, single-point change:

| Kind | Example |
|---|---|
| Invert a condition | `if (x > 0)` → `if (!(x > 0))` |
| Shift a boundary | `>` → `>=`, `< len` → `< len - 1` |
| Change a return value | `return total` → `return 0` / `null` / empty / `!result` |
| Delete a call | remove `save(order)`, `emit(event)`, `validate(input)` |
| Swap an operator | `+` → `-`, `&&` → `||` |

Avoid equivalent mutants (changes that cannot alter behaviour, such as mutating dead code, logging, or a value that is immediately overwritten). If you are unsure whether a mutant is equivalent, prefer another one.

If the project **already has a configured mutation tool** (config file present, used in CI or scripts), use it on the chosen units instead of hand-written mutations. Never install one.

## 2. Prepare the worktree

Mutations never touch the user's working directory.

- With git: create a worktree from `HEAD` in a fresh directory under the system temp dir with a `test-trust-` prefix (for example `mktemp -d "${TMPDIR:-/tmp}/test-trust-XXXXXX"`), then copy in the user's uncommitted changes, including untracked files in scope, so the audit reflects the real code. **Record the worktree path in the ledger before applying any mutation.** Run by a proofline review role, the role text wins: the worktree is `$TMPDIR/verify-<ID>.<focus>`, created in its own call and left registered for the control plane to remove at CODE_DONE (a review role runs no `git worktree remove`).
- Without git: copy the scope (and what it needs to build) to a fresh `test-trust-`-prefixed directory under the system temp dir, and record that path instead.

### Link dependency folders, never build folders

A fresh worktree has no git-ignored folders, so installed dependencies are missing. Link them; do not install them and do not copy build output.

- **Dependency folders** are git-ignored directories in the original repo that hold third-party packages put there by a package manager, not output compiled from the project's own source. Typical names: `node_modules/`, `.venv/`, `venv/`, `vendor/` (only when git-ignored), `.bundle/`, `Pods/`. Find them with `git status --ignored --porcelain` (or `git check-ignore`), including nested ones in monorepos (for example `packages/*/node_modules/`).
- Symlink each one into the worktree at the same relative path. This is not an installation: nothing is downloaded or changed, and mutations only ever touch source files. Tool caches the runner writes inside a linked folder (for example `node_modules/.vite/`) are acceptable; they are not source.
- **Build folders are never linked or copied** (`bin/`, `obj/`, `target/`, `dist/`, `build/`, `out/`, `.next/`, `__pycache__/`, and the like). The test command rebuilds inside the worktree. A linked build folder would let the worktree write mutated build output into the user's real folder.
- Never run an install or restore command (`npm install`, `pip install`, `go mod download`, `dotnet restore`, ...), even if the verification run fails.

### Verify the worktree

Run the covering tests once in the worktree without mutations. This run includes the worktree's first build; record its duration. The results must match the baseline.

- If it fails because of the build or missing generated files (a dependency folder that cannot be linked, code generation, a missing artifact): stop the hollow stage and ask the user. Do not try linking or copying build folders on your own.
- If it fails for another reason (environment, paths), stop the hollow stage and report why.

## 3. Run the mutants

First remove every test with a `confirmed` flaky finding (any `flaky_*` kind) from each unit's covering set. A flaky test can fail for its own reasons and kill a mutant by chance, which would hide a hollow test. A unit with no covering tests left gets a `needs_validation` finding on those flaky tests, kind `hollow`, with `missing`: "covering tests are flaky". Do not run its mutants.

For each remaining mutant, sequentially:

0. Ask whether the mutant already ran, then ask for it as the cap on the mutation budget. First `agent.sh build-record <TASK-ID> mutant-known <source file of the unit> <mutant id>` (the id is stable: unit plus mutation, e.g. `price:ret0`): `KNOWN killed|survived <unit>` means this very product file and these very test files already ran this mutant in an earlier round (the control plane keys every result on the product file AND the task's test files): use that result, apply nothing, spend nothing. A changed product file, or any changed test of the task (a weakened or a new killing test), makes it `NEW` again. Only for a `NEW` mutant ask the counter (a counter, not a promise): `node <skill-dir>/scripts/gate.mjs mutant <review-folder>/mutants.count <repo-root>/.agents/config.yaml <run-dir>` (omit `<run-dir>` outside a run; in a run the count file is INSIDE the run folder, e.g. `<run-dir>/reviews/test-trust/tests/mutants.count`: with `<run-dir>` a relative name is taken relative to the run folder and a path outside it or through a link is refused, so no counter ever lands in the repository root). `OK n/budget` allows this one mutant. `REFUSED n/budget` (exit 1) means the budget is spent: apply no mutation, stop the mutant loop, and list every unit left without a mutant in `scope.diff.not_examined` with reason `mutation budget`. A resumed run keeps the same count file, so a restart cannot reset the budget. Claim mutants and compiler-only kills count too.
1. Apply the single mutation in the worktree and save its diff.
2. Run only the covering tests. Timeout: 3× the summed baseline durations of those tests (3× the test's own duration if it is a single test; the scope's baseline if per-test durations are unsupported), minimum 30 seconds.
3. Classify:
   - **killed**: at least one covering test failed, the build/compile failed, or the run hit the **timeout**.
   - **survived**: every covering test passed.
4. Record the result: `agent.sh build-record <TASK-ID> mutant-record <source file> <mutant id> killed|survived --unit <unit> [--class new]` (a ledger row of the control plane; only the reviewer can write it; nothing you could write into a file counts) (`--class new` for a mutant of a kind you added after round 1, see section 6).
5. Revert the mutation and confirm the worktree is clean before the next mutant.

Save the run output as `evidence/hollow-<unit-slug>-m<N>.*`. Update the ledger after each mutant.

A build or compile failure counts as killed, but it proves nothing about the tests. If most mutants of a unit are killed only by the compiler, note it and choose different mutations. A kill by a runtime error (exception, 5xx, constraint violation) is a kill of the unit but not an assertion: in a run, the claim mutants of [DIFF.md](DIFF.md#5a-claim-mutants-does-the-named-test-observe-its-criterion) require the named test to fail on an assertion.

**The first round reports the whole unit (A359).** On the first survivor of a unit, run every other planned and reachable mutant of THAT unit in the same round (still through the counter), so the round lists all the unit's survivors together; never stop a unit at its first survivor and discover the next one a round later. Mutants of other units are not run for that reason (the budget is spent unit by unit, priority order).

## 4. Verdict

For each production unit:

- **At least one mutant survived:** the tests claiming to cover that unit are `hollow`, `confirmed`, provided the surviving mutant's diff and the passing test output are both saved. One finding per covering test that stayed green, each pointing to the same surviving diff(s).
- **Every mutant killed:** `cleared` for that unit.
- **Only flaky covering tests**: `needs_validation`, `missing`: "covering tests are flaky" (see step 3).
- **Could not run** (worktree mismatch, timeout of the unmutated setup, unsupported selection): `needs_validation`, stating what is missing.

`observed` for a hollow finding contains the surviving mutant diff(s), the covering tests that ran, and that they passed.

## 5. Clean up

Before removing the worktree, make sure every surviving mutant's diff is saved under `evidence/` (`evidence/hollow-<unit-slug>-m<N>.diff`). Then remove it and clear the path in the ledger.

**Safety checks before removing any recorded path.** The ledger is repo content and may have been planted, so a path read from it is removed only if all of these hold. Compare **canonical paths** only: resolve the recorded path, the system temp dir, the repo root, the home directory, and every path from `git worktree list` with `realpath` (or `pwd -P`) first. On macOS, `$TMPDIR` (`/var/folders/...`) resolves to `/private/var/folders/...`, and a literal string comparison would reject the skill's own worktree.

- it is an absolute path directly under the system temp dir, and its last component starts with `test-trust-`;
- with git: it appears in `git worktree list --porcelain` and is not the main worktree. Remove it with `git worktree remove --force <path>`, then `git worktree prune`. Never fall back to `rm -rf` if git refuses;
- without git: it contains no `.git` and is not the repo root, a parent of it, or the home directory.

If any check fails, do not delete anything: show the path to the user, say why it was not removed, and continue with a fresh worktree. When you created the path yourself in this run, the checks still apply.

On resume, a worktree path still recorded in the ledger means the previous run was interrupted: clean it up as above, then create a fresh one and continue from the ledger's resume point.

## 6. The loop is bounded, and it ends with an adequacy line (A359)

- **Caps come from the plan.** `node <skill-dir>/scripts/gate.mjs caps <config> <run-dir>` prints `review_rounds` and `review_minutes` (the PLAN's `## Test review budget`, else the config defaults). Stop starting mutants once `review_minutes` of the loop have passed (list the units left over in `not_examined`, reason `time cap`). The control plane stops the loop at `review_rounds` REVIEW_TESTS rounds: the gate then stays FAIL, the state is the one line `test review cap reached`, and the user decides (a larger cap, a written waiver of the named residual survivors, or stop). You never ask the user to type a cap, and you never turn a FAIL into a PASS because a cap was reached; SECURITY and SECRETS findings are never waived.
- **The mutation budget** is derived from the changed units and lines (the plan's `units:`, `lines:`, `mutants:`), never from the criteria count alone. An approved raise is applied by the control plane at the freeze and at every `handoff IMPLEMENTED`: if `gate.mjs thresholds <config> <run-dir>` shows the budget you need, proceed; do not stop to ask again for an approval already given.
- **Widening is labelled.** A round after the first may add mutant kinds (a new class of mutation). A survivor of such a mutant is reported with `--class new` and the label `new class` in its finding text; it is not counted as a new finding of the code under review without that label.
- **Close the loop with a sufficiency line.** Run `agent.sh build-record <TASK-ID> mutant-summary`; put its `ADEQUACY:` line and your own statement of what is closed into the report: closed tables for character classes and allowlists (every member tried once, listed), and the equivalent-mutant arguments, each audited once and not argued again in a later round.

## Refuting a survivor

Before reporting, try to show the survivor is not a test weakness:

- Is the mutant **equivalent** (no observable behaviour change)? Then it is `cleared`.
- Did the mutated code actually run under these tests? If the covering-test mapping was wrong, the tests do not claim to cover this unit; drop the finding or pick the right tests and re-run.
- Is the behaviour checked by a test outside the scope? Still a valid finding for the tests in scope, but say so in the finding.
